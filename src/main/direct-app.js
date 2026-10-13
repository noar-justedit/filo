/*
 * filo — FTP, FTPS and SFTP client
 * Copyright (C) 2026 Just Edit (Arnaud Augst)
 * Licensed under the GNU General Public License v3.0 or later. See LICENSE.
 */

// SYNCTHING, on filo's side: the SYNCTHING live syncs of the preferences, the
// other filo this machine accepted, and what the window asks (accept a
// computer, import a code, share one). The Syncthing part is in direct.js.
//
// How two filo meet the first time:
//   1. on computer A, a SYNCTHING live sync is saved, then SHARE gives a code
//      ("filo-direct:…": A's ID, the folder, the direction for B; no secret
//      inside, and none is needed: A still has to accept B);
//   2. on B, IMPORT reads the code: B accepts A, and chooses its own folder;
//   3. B connects to A; A's window shows "B wants to connect" with B's ID:
//      ACCEPT. The two filo are then linked for good: the next live syncs
//      between them are offered from one to the other, no code needed.

const fs = require('fs');
const path = require('path');
const { Direct, newFolderId, directionOfOffer, shortId, parseDeviceId, deviceName, hostName, TRASH, OTHER } = require('./direct');
const { DEVICE_ID, FOLDER_ID, DEFAULT_SYNC_EXCLUDE } = require('./config');

const DIRECT_PREFIX = 'filo-direct:';

// opts.onStatus(id): the status of a pair changed (main.js merges it with
// the S-FTP part of a hybrid pair and sends it to the window).
// opts.onFailover(id): a hybrid pair lost the other filo: its S-FTP part
// should run now. opts.serverShare(pair) / opts.serverImport(share, password):
// the server part of a hybrid pair's code (main.js knows sites and secrets).
function createDirect({ prefs, log, send, home, bin, onStatus, onFailover, onMirror, onBusy, serverShare, serverImport, onPairChanged, mirrorDelayMs, missRecheckMs }) {
  const direct = new Direct(Object.assign({ home, log }, bin !== undefined ? { bin } : {}));
  const status = {};
  const startedAt = Date.now();
  let pending = { devices: [], folders: [] };
  const pairs = () => prefs.listSyncPairs().filter(p => p.via === 'direct' || p.via === 'hybrid');

  const miss = {}, missT = {};
  const MISS_RECHECK_MS = missRecheckMs != null ? missRecheckMs : 15000;
  const warned = new Set();
  function emitStatus(id, s) {
    const prev = status[id];
    const was = !!(prev && prev.peer && prev.peer.connected);
    if (s.peer && s.peer.connected) miss[id] = 0;
    else if (was || miss[id]) {
      // One missed look is not a lost link (Syncthing busy, a folder
      // restarting after a change): the link is kept one more time, so the
      // failsafe does not start while the other computer is still there.
      miss[id] = (miss[id] || 0) + 1;
      if (was && miss[id] < 2) {
        // Syncthing only reports a change: a quiet folder may never send the
        // second look. Looked at again a little later (review 0.6.2).
        const real = s;
        clearTimeout(missT[id]);
        missT[id] = setTimeout(() => { if (miss[id] === 1) emitStatus(id, Object.assign({}, real)); }, MISS_RECHECK_MS);
        if (missT[id].unref) missT[id].unref();
        s = Object.assign({}, s, { peer: prev.peer });
      }
    }
    status[id] = s;
    if (onStatus) onStatus(id); else send('sync-status', { id, status: s });
    const p = prefs.getSyncPair(id);
    if (p && p.via === 'hybrid' && prev && prev.peer && prev.peer.connected && !(s.peer && s.peer.connected) && onFailover) onFailover(id);
    if (p && p.via === 'hybrid') mirrorWatch(p, s);
  }

  // DUAL SYNC (Noar, 12/10/2026): SYNCTHING first (faster); once both
  // computers are up to date and nothing moved for a while, the MASTER's
  // S-FTP part makes the server a mirror of its folder. SYNCTHING busy again:
  // the mirror's copies wait for it.
  const MIRROR_DELAY = mirrorDelayMs != null ? mirrorDelayMs : 30000;
  const insyncSince = {}, mirrorT = {}, busy = {};
  function mirrorWatch(p, s) {
    const connected = !!(s.peer && s.peer.connected);
    const done = connected && s.state === 'insync';
    const working = connected && s.state === 'syncing';
    if (done) {
      if (!insyncSince[p.id]) {
        insyncSince[p.id] = Date.now();
        clearTimeout(mirrorT[p.id]);
        mirrorT[p.id] = setTimeout(() => { if (insyncSince[p.id] && onMirror) onMirror(p.id); }, MIRROR_DELAY + 50);
        if (mirrorT[p.id].unref) mirrorT[p.id].unref();
      }
    } else { insyncSince[p.id] = 0; clearTimeout(mirrorT[p.id]); }
    if (working !== !!busy[p.id]) { busy[p.id] = working; if (onBusy) onBusy(p.id, working); }
  }
  // True when the MASTER may write the mirror now.
  function mirrorReady(pair) {
    const t = insyncSince[pair.id];
    return !!(t && Date.now() - t >= MIRROR_DELAY);
  }

  function apply() {
    const list = pairs();
    if (!direct.available) {
      for (const p of list) emitStatus(p.id, { direct: true, state: 'error', error: 'SYNCTHING is not in this build of filo (Syncthing missing).' });
      return Promise.resolve();
    }
    for (const p of list) if (!status[p.id]) emitStatus(p.id, { direct: true, state: 'starting', auto: !!p.auto });
    return direct.reconcile(list, prefs.listDirectDevices()).then(() => {
      // MASTER: its settings to the control folder; SLAVE: takes them.
      for (const p of pairs()) { if (p.peer && p.role !== 'slave') writeCtl(p); else if (p.peer) readCtl(p); }
    }).catch(e => {
      log('error', e.message);
      for (const p of list) emitStatus(p.id, { direct: true, state: 'error', error: e.message });
    });
  }

  direct.on('status', (id, s) => emitStatus(id, s));
  direct.on('queue', (id, q) => send('live-queue', { id, q }));
  direct.on('item', it => {
    const p = it.pairId && prefs.getSyncPair(it.pairId);
    if (p && p.role !== 'slave' && p.peer && !it.error) direct.masterWins(p, it.item);
  });
  // A remote computer added by its ID only: its name, once it connected.
  direct.on('peername', ({ id, name }) => {
    if (!name) return;
    let changed = false;
    for (const p of prefs.listSyncPairs()) {
      if (p.peer && p.peer.id === id && !p.peer.name) { prefs.saveSyncPair(Object.assign({}, p, { peer: { id, name } })); changed = true; }
    }
    const d = prefs.listDirectDevices().find(x => x.id === id);
    if (d && !d.name) { prefs.addDirectDevice({ id, name }); changed = true; }
    if (changed) { log('info', `SYNCTHING: ${shortId(id)} is ${name.split(' · ')[0]}`); send('sync-pairs', { pairs: prefs.listSyncPairs() }); apply(); }
  });
  direct.on('ctl', ({ pairId }) => { const p = prefs.getSyncPair(pairId); if (p && p.role === 'slave') readCtl(p); });

  // ── MASTER / SLAVE (Noar, 11/10/2026) ─────────────────────────────────
  // What the MASTER decides for the session: its direction (the SLAVE takes
  // the other way round), its name and its file filter. masterDirection, not
  // direction: in the .filo-session file on the server, "direction" is the
  // SLAVE's one (the config file part), read at import.
  function sessionOf(p) {
    return { v: 1, master: deviceName(), masterId: direct.myId || '', name: p.name, masterDirection: p.direction, exclude: p.exclude, failsafe: p.via === 'hybrid' };
  }
  function writeCtl(p) {
    try {
      const f = path.join(direct.ctlDir(p), 'session.json');
      const want = sessionOf(p);
      let have = null;
      try { have = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) {}
      const strip = o => JSON.stringify(Object.assign({}, o, { at: 0 }));
      if (have && strip(have) === strip(want)) return;
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, JSON.stringify(Object.assign(want, { at: Date.now() }), null, 2));
    } catch (e) { log('warn', `SYNCTHING · ${p.name}: settings for the SLAVE not written (${e.message})`); }
  }
  function readCtl(p) {
    let o = null;
    try { o = JSON.parse(fs.readFileSync(path.join(direct.ctlDir(p), 'session.json'), 'utf8')); } catch (_) { return; }
    takeSession(p, o, 'SYNCTHING');
  }
  // A SLAVE takes the MASTER's settings (from the control folder, or from the
  // server for a FAILSAFE session: syncer.js).
  function takeSession(p, o, how) {
    if (!o || o.v !== 1 || p.role !== 'slave') return;
    // Only the MASTER's own settings: a file without its ID, or another
    // computer's, is ignored (anyone who can write on the server could drop one).
    if (!o.masterId || !p.peer || o.masterId !== p.peer.id) return;
    // A session the MASTER runs with an S-FTP failsafe, accepted here as a
    // plain SYNCTHING offer: the server part only comes with the config file.
    if (o.failsafe === true && p.via === 'direct' && !warned.has(p.id)) {
      warned.add(p.id);
      log('warn', `LIVE SYNC “${p.name}”: on the MASTER, this session is a DUAL SYNC (with an S-FTP BACKUP); here it is plain SYNCTHING. To get it, import the MASTER's config file (delete this session first).`);
    }
    // From the server (DUAL SYNC), anyone who can write there could have
    // written the file: only the name is taken. The direction and the filter
    // come through SYNCTHING's own link (control folder), which only the
    // MASTER can write (review 0.6.2).
    const trusted = how !== 'from the server';
    const want = {
      name: typeof o.name === 'string' && o.name ? o.name.slice(0, 120) : p.name,
      direction: trusted && ['up', 'down', 'both'].includes(o.masterDirection) ? OTHER[o.masterDirection] : p.direction,
      exclude: trusted && typeof o.exclude === 'string' ? o.exclude.slice(0, 4000) : p.exclude,
    };
    if (want.name === p.name && want.direction === p.direction && want.exclude === p.exclude) return;
    const saved = prefs.saveSyncPair(Object.assign({}, p, want));
    log('info', `LIVE SYNC “${saved.name}”: the MASTER (${String(o.master || '').split(' · ')[0]}) changed the session's settings (${how}): taken here`);
    send('sync-pairs', { pairs: prefs.listSyncPairs() });
    if (onPairChanged) onPairChanged(saved, p);
    apply();
  }
  direct.on('pending', p => {
    const before = new Set(pending.devices.map(d => d.id).concat(pending.folders.map(f => f.folderId + f.deviceId)));
    pending = p;
    for (const d of p.devices) if (!before.has(d.id)) log('info', `SYNCTHING: ${d.name || 'a computer'} (${shortId(d.id)}) wants to connect: accept or refuse it in LIVE SYNC`);
    for (const f of p.folders) if (!before.has(f.folderId + f.deviceId)) log('info', `SYNCTHING: ${f.deviceName} offers “${f.name}”: accept it in LIVE SYNC`);
    send('direct-pending', p);
  });
  // Our own live sync, offered back by the computer that imported its code.
  direct.on('link', ({ pairId, peer }) => {
    const p = prefs.getSyncPair(pairId);
    if (!p || p.peer) return;
    prefs.addDirectDevice(peer);
    prefs.saveSyncPair(Object.assign({}, p, { peer }));
    log('info', `SYNCTHING: “${p.name}” is now linked with ${peer.name} (${shortId(peer.id)})`);
    send('sync-pairs', { pairs: prefs.listSyncPairs() });
    apply();
  });

  function statusOf(id) { return status[id] || { direct: true, state: direct.available ? 'starting' : 'error', error: direct.available ? undefined : 'SYNCTHING is not in this build of filo.' }; }

  // Hybrid pairs: true when Syncthing reaches the other filo (the server is
  // then left alone), 'wait' while SYNCTHING is still starting, false otherwise.
  function directFirst(pair) {
    if (!direct.available || !pair.auto) return false;      // SYNCTHING switched off: the failsafe works
    const s = status[pair.id];
    if (s && s.peer && s.peer.connected) return true;
    if ((!s || s.state === 'starting') && Date.now() - startedAt < 120000) return 'wait';
    return false;
  }

  async function info(start) {
    let error = null;
    // Started for its ID (a future SLAVE): it also starts watching, so the
    // MASTER's request to connect shows up here.
    if (start && direct.available) { try { await direct.start(); if (!direct.want) await apply(); } catch (e) { error = e.message; } }
    const links = direct.links || {};
    return {
      available: direct.available, running: direct.running, error,
      id: direct.myId, name: deviceName(), version: direct.version || '', port: direct.listenPort || null,
      devices: prefs.listDirectDevices().map(d => Object.assign(d, { link: links[d.id] || null, used: pairs().filter(p => p.peer && p.peer.id === d.id).length })),
      pending,
    };
  }

  // share: the MASTER's SYNCTHING sessions to offer it (it pasted this
  // computer's SYNCTHING ID). A session it imported by config file links itself.
  function accept(dev, share) {
    const d = prefs.addDirectDevice(dev);
    if (!d) return { ok: false, error: 'This is not a filo SYNCTHING ID.' };
    log('info', `SYNCTHING: ${d.name || shortId(d.id)} (${shortId(d.id)}) accepted`);
    for (const id of Array.isArray(share) ? share.slice(0, 50) : []) shareTo(String(id), d);
    pending = { devices: pending.devices.filter(x => x.id !== d.id), folders: pending.folders };
    apply();
    return { ok: true };
  }
  async function refuse(dev) {
    try { await direct.ignoreDevice(dev.id, dev.name); log('info', `SYNCTHING: ${dev.name || shortId(dev.id)} (${shortId(dev.id)}) refused`); return { ok: true }; }
    catch (e) { return { ok: false, error: e.message }; }
  }
  function forget(id) {
    const used = pairs().filter(p => p.peer && p.peer.id === id);
    if (used.length) return { ok: false, error: `Delete its live sync${used.length > 1 ? 's' : ''} first (${used.map(p => '“' + p.name + '”').join(', ')}).` };
    prefs.forgetDirectDevice(id);
    apply();
    return { ok: true };
  }

  function checkLocal(local) {
    const dir = path.resolve(String(local || ''));
    if (!local || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error('Choose an existing local folder.');
    if (pairs().some(p => p.local === dir)) throw new Error('This folder is already in a SYNCTHING live sync.');
    return dir;
  }

  // A folder a linked filo offers.
  function offerAccept(req) {
    try {
      const f = pending.folders.find(x => x.folderId === req.folderId && x.deviceId === req.deviceId);
      if (!f) return { ok: false, error: 'This offer is no longer there.' };
      const local = checkLocal(req.local);
      const pair = prefs.saveSyncPair({ via: 'direct', role: 'slave', name: req.name || f.name, local, direction: directionOfOffer(f.folderId), folderId: f.folderId, peer: { id: f.deviceId, name: f.deviceName }, exclude: DEFAULT_SYNC_EXCLUDE, auto: true });
      pending = { devices: pending.devices, folders: pending.folders.filter(x => x !== f) };
      log('info', `SYNCTHING: “${pair.name}” accepted from ${f.deviceName}, in ${local}`);
      apply();
      return { ok: true, pair };
    } catch (e) { return { ok: false, error: e.message }; }
  }
  // One way only (Noar, 11/10/2026): the MASTER creates and sends, the
  // SLAVE imports. The quick way for a SYNCTHING session: the SLAVE pastes the
  // MASTER's SYNCTHING ID (join); its filo then asks the MASTER to connect; the
  // MASTER accepts it and chooses the session to share (accept → shareTo);
  // the SLAVE accepts the session, in a folder of its own. SYNCTHING only: an
  // ID carries no server, a FAILSAFE session goes by its config file.
  function join(text) {
    const id = parseDeviceId(text);
    if (!id) return { ok: false, error: 'This is not a SYNCTHING ID (8 groups of 7 letters and digits). Copy it again, whole, from the MASTER: MODE ▾ → Sessions… → THIS COMPUTER, or its LIVE SYNC view.' };
    if (direct.myId && id === direct.myId) return { ok: false, error: 'This is the SYNCTHING ID of this computer: paste the MASTER\'s.' };
    const known = prefs.listDirectDevices().find(d => d.id === id);
    prefs.addDirectDevice({ id, name: known ? known.name : '' });
    log('info', `SYNCTHING: asking ${known && known.name ? known.name.split(' · ')[0] : 'the MASTER'} (${shortId(id)}) to connect (SYNCTHING ID pasted)`);
    return apply().then(() => ({ ok: true, id, myId: direct.myId || '' }));
  }
  // The MASTER shares one of its SYNCTHING sessions with a computer it accepted.
  function shareTo(pairId, dev) {
    const p = prefs.getSyncPair(pairId);
    if (!p || p.via !== 'direct' || p.role === 'slave' || p.peer) return false;
    prefs.saveSyncPair(Object.assign({}, p, { peer: { id: dev.id, name: dev.name || '' } }));
    log('info', `SYNCTHING: “${p.name}” offered to ${dev.name ? dev.name.split(' · ')[0] : shortId(dev.id)}`);
    return true;
  }
  async function offerDismiss(req) { await direct.dismissFolder(req.folderId, req.deviceId); return { ok: true }; }

  // Before a SYNCTHING pair is saved: its folder ID, given once.
  function prepareSave(pair) {
    if (!pair || (pair.via !== 'direct' && pair.via !== 'hybrid')) return pair;
    const prev = pair.id ? prefs.getSyncPair(pair.id) : null;
    const was = prev && (prev.via === 'direct' || prev.via === 'hybrid');
    const out = Object.assign({}, pair);
    out.folderId = (was && prev.folderId) || pair.folderId || newFolderId(pair.direction || 'both');
    if (was) out.peer = prev.peer;
    out.role = prev ? prev.role : 'master';            // the computer that creates a session is its MASTER
    if (out.role === 'slave') { out.name = prev.name; out.direction = prev.direction; out.exclude = prev.exclude; }   // the MASTER decides those
    if (out.via === 'hybrid' && !out.siteId) throw new Error('Choose the bookmark (server) of the S-FTP BACKUP.');
    if (out.via === 'hybrid' && ['/', '.', ''].includes(path.posix.normalize('/' + String(out.remote || '')).replace(/\/+$/, ''))) throw new Error('Choose a folder on the server for the S-FTP BACKUP (not the root of the server): the backup is an exact copy of this folder.');
    const dir = path.resolve(String(out.local || ''));
    if (!out.local || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error('Choose an existing local folder.');
    if (pairs().some(p => p.id !== out.id && p.local === dir)) throw new Error('This folder is already in another SYNCTHING live sync.');
    out.local = dir;
    return out;
  }

  // ── The code given to the other computer ──────────────────────────────
  async function shareOf(pair) {
    await direct.start();
    const o = { filo: 'direct', v: 1, device: direct.myId, deviceName: deviceName(), folder: pair.folderId, name: pair.name, direction: OTHER[pair.direction], exclude: pair.exclude };
    // SYNCTHING FAILSAFE: the server part too (never a password).
    if (pair.via === 'hybrid' && serverShare) { const sv = serverShare(pair); o.failsafe = { server: sv.server, remote: sv.remote, interval: sv.interval }; }
    return o;
  }
  function shareCode(o) { return DIRECT_PREFIX + Buffer.from(JSON.stringify(o), 'utf8').toString('base64url'); }
  function isCode(text) {
    const t = String(text || '');
    return t.includes(DIRECT_PREFIX) || /"filo"\s*:\s*"direct"/.test(t);
  }
  function parse(text) {
    const t = String(text || '').trim();
    if (t.length > 100000) throw new Error('This is not a filo LIVE SYNC config.');
    let o;
    try {
      const i = t.indexOf(DIRECT_PREFIX);
      if (i >= 0) {
        const m = /^[A-Za-z0-9_-]+/.exec(t.slice(i + DIRECT_PREFIX.length));
        o = JSON.parse(Buffer.from(m ? m[0] : '', 'base64url').toString('utf8'));
      } else o = JSON.parse(t);
    } catch (_) { throw new Error('This is not a filo LIVE SYNC config (or the file is damaged).'); }
    if (!o || o.filo !== 'direct' || !DEVICE_ID.test(o.device || '') || !FOLDER_ID.test(o.folder || '')) throw new Error('This is not a filo LIVE SYNC config.');
    return {
      device: o.device, deviceName: String(o.deviceName || shortId(o.device)).slice(0, 60),
      folder: o.folder, name: String(o.name || 'New session').slice(0, 120),
      direction: ['up', 'down', 'both'].includes(o.direction) ? o.direction : 'both',
      exclude: o.exclude == null ? DEFAULT_SYNC_EXCLUDE : String(o.exclude).slice(0, 4000),
      failsafe: o.failsafe && o.failsafe.server ? o.failsafe : null,
    };
  }
  async function readCode(text) {
    const sh = parse(text);
    let mine = null;
    if (direct.available) { try { mine = await direct.start(); } catch (_) {} }
    return {
      ok: true, direct: sh,
      fromSelf: !!mine && mine === sh.device,
      already: pairs().some(p => p.folderId === sh.folder),
      known: prefs.listDirectDevices().some(d => d.id === sh.device),
      available: direct.available,
    };
  }
  function importApply(req) {
    try {
      if (!direct.available) return { ok: false, error: 'SYNCTHING is not in this build of filo.' };
      const sh = parse(JSON.stringify(Object.assign({ filo: 'direct' }, req.direct)));
      if (direct.myId && sh.device === direct.myId) return { ok: false, error: 'This config was made on this computer: import it on the other one.' };
      if (pairs().some(p => p.folderId === sh.folder)) return { ok: false, error: 'This live sync is already here.' };
      const local = checkLocal(req.local);
      let extra = { via: 'direct' }, warn = null;
      if (sh.failsafe && serverImport) {
        const r = serverImport(Object.assign({ name: sh.name }, sh.failsafe), req.password);
        extra = { via: 'hybrid', siteId: r.site.id, remote: r.remote, interval: r.interval };
        warn = r.warn || null;
      }
      prefs.addDirectDevice({ id: sh.device, name: sh.deviceName });
      const pair = prefs.saveSyncPair(Object.assign({ role: 'slave', name: sh.name, local, direction: sh.direction, folderId: sh.folder, peer: { id: sh.device, name: sh.deviceName }, exclude: sh.exclude, auto: req.auto !== false, fsAuto: true }, extra));
      log('info', `SYNCTHING: “${pair.name}” imported from ${sh.deviceName} (${shortId(sh.device)}), in ${local}${pair.via === 'hybrid' ? ', with its S-FTP BACKUP' : ''}`);
      apply();
      return { ok: true, pair, warn };
    } catch (e) { return { ok: false, error: e.message }; }
  }

  async function rescan(pair) {
    try { await direct.rescan(pair); return { ok: true, copies: 0, conflicts: [], direct: true }; }
    catch (e) { return { ok: false, error: e.message }; }
  }

  return {
    direct, apply, statusOf, info, accept, refuse, forget, offerAccept, offerDismiss,
    prepareSave, shareOf, shareCode, isCode, readCode, importApply, rescan, directFirst, mirrorReady, takeSession, join,
    sessionFile: async p => { const sh = await shareOf(p); return Object.assign(sh, sessionOf(p)); },
    trashInfo: p => trashInfo(p),
    allStatus() { const o = {}; for (const p of pairs()) o[p.id] = statusOf(p.id); return o; },
    pending: () => pending,
    setFast: on => direct.setFast(on),
    hold: async (id, on) => { const p = prefs.getSyncPair(id); if (!p || !p.folderId) return { ok: false, error: 'No SYNCTHING session.' }; await direct.hold(p, on); return { ok: true }; },
    running: () => !!direct.child,
    stop: () => direct.stop(),
  };
}

// This computer's trash of a SYNCTHING session: where, how many files, how big.
function trashInfo(p) {
  const dir = path.join(p.local, TRASH);
  let files = 0, bytes = 0;
  const walk = d => {
    let list = [];
    try { list = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
    for (const e of list) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else { files++; try { bytes += fs.statSync(f).size; } catch (_) {} }
    }
  };
  walk(dir);
  return { dir, files, bytes, exists: fs.existsSync(dir) };
}

module.exports = { createDirect, DIRECT_PREFIX, trashInfo };
