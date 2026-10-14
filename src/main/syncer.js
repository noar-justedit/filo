/*
 * filo — FTP, FTPS and SFTP client
 * Copyright (C) 2026 Just Edit (Arnaud Augst)
 * Licensed under the GNU General Public License v3.0 or later. See LICENSE.
 */

// LIVE SYNC: runs the synchronisation pairs.
//
// A run lists both folders (the server through a connection of its own, never
// the browsing one), asks core/syncplan.js what to do, and hands the copies to
// the transfer queue, which already does everything a copy needs: segments,
// checksums, resume, retries. Nothing is ever deleted.
//
// When a run happens:
//  - AUTO pairs: when filo starts, every `interval` minutes (the server cannot
//    tell filo that something changed), and a few seconds after something
//    changes in the local folder (watched) when the local side sends;
//  - SYNC NOW in the window, or `filo livesync` on the command line.
//
// What a pair remembers (the state, see syncplan.js) lives in filo's own
// profile, userData/sync/<id>.json.gz, never in the user's folders: on a
// client's server, a hidden file of filo's would not be welcome. Consequence:
// it belongs to this machine.

const fs = require('fs');
const path = require('path');
const posix = path.posix;
const zlib = require('zlib');
const { EventEmitter } = require('events');
const { plan, mirrorPlan } = require('./core/syncplan');
const { PathFilter } = require('./core/filter');
const { SYNC_ALWAYS_EXCLUDE } = require('./config');
const local = require('./proto/local');
const { walkRemote, deleteRemoteTree, localJoin } = require('./core/scan');
const { RemoteError } = require('./core/errors');
const { readSmall, writeSmall, RELAY_SUFFIX } = require('./core/transfer');
// SYNCTHING FAILSAFE: the MASTER's settings, on the server, for the
// SLAVE (the only file of filo's own a server receives, and only for these
// sessions: Noar, 11/10/2026). Never synced as a file, like SYNCTHING's own.
const SESSION_FILE = '.filo-session';
const TRASH = '.filo-trash';
const NEVER_SYNCED = new Set(['.stfolder', '.stignore', '.stversions', TRASH, SESSION_FILE]);
function conflictName(rel, host) {
  const d = new Date(), p = n => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  const ext = posix.extname(rel), stem = rel.slice(0, rel.length - ext.length);
  return `${stem}.sync-conflict-${stamp}-from-${String(host || 'other').replace(/[^A-Za-z0-9_-]+/g, '-')}${ext}`;
}

// A name read from the server (relay info.json): a bare name only, never a
// path that leaves the folder (review 0.6.2).
const bareName = n => (typeof n === 'string' && n && !/[\\/\0]/.test(n) && n !== '.' && n !== '..' ? n : '');

// Why a run happened, as the journal says it.
const WHY = { failsafe: 'the other computer is away', mirror: 'SYNCTHING done', timer: 'every few minutes', change: 'a change here', start: 'start', again: 'again', settling: 'files settled', now: 'CHECK NOW', force: 'asked', 'after direct': 'SYNCTHING not started' };

const RELAY_POLL_MS = 15000;      // a relayed file in progress: its sender is looked at this often

const STABLE_MS = 10000;          // same size and date for 10 s before a file is sent
const WATCH_DEBOUNCE_MS = 4000;
const IDLE_CLOSE_MS = 60000;      // the listing connection closes after a minute of rest
const STATE_MAX_BYTES = 64 * 1024 * 1024;

class Syncer extends EventEmitter {
  // opts: { prefs, queue, resolveEndpoint, createRemote, log, dir }
  constructor(opts) {
    super();
    this.o = opts;
    this.runs = new Map();          // pairId → { busy, again, timer, watcher, debounce, conn, seen, status }
    this.stopped = false;
  }

  log(level, msg) { try { this.o.log(level, msg); } catch (_) {} }
  rt(id) {
    let r = this.runs.get(id);
    if (!r) { r = { busy: false, again: false, seen: new Map(), status: { state: 'idle' } }; this.runs.set(id, r); }
    return r;
  }

  // ── State on disk ──────────────────────────────────────────────────────
  stateFile(id) { return path.join(this.o.dir, `${id}.json.gz`); }
  loadState(pair) {
    try {
      const buf = fs.readFileSync(this.stateFile(pair.id));
      if (buf.length > STATE_MAX_BYTES) return { files: {} };
      const s = JSON.parse(zlib.gunzipSync(buf).toString('utf8'));
      // The state only counts for the same two folders and the same server.
      if (s && s.local === pair.local && s.remote === pair.remote && s.siteId === pair.siteId && s.files) return s;
    } catch (_) {}
    return { files: {} };
  }
  saveState(pair, files) {
    try {
      fs.mkdirSync(this.o.dir, { recursive: true });
      const tmp = this.stateFile(pair.id) + '.tmp';
      fs.writeFileSync(tmp, zlib.gzipSync(JSON.stringify({ v: 1, local: pair.local, remote: pair.remote, siteId: pair.siteId, files })), { mode: 0o600 });
      fs.renameSync(tmp, this.stateFile(pair.id));
    } catch (e) { this.log('error', `LIVE SYNC: could not save what was synchronised (${e.message})`); }
  }
  forgetState(id) { try { fs.unlinkSync(this.stateFile(id)); } catch (_) {} }

  // ── Status, for the window ─────────────────────────────────────────────
  setStatus(pair, patch) {
    const r = this.rt(pair.id);
    r.status = Object.assign({}, r.status, patch);
    this.emit('status', pair.id, this.statusOf(pair.id));
  }
  statusOf(id) {
    const r = this.runs.get(id);
    const s = r ? Object.assign({}, r.status) : { state: 'idle' };
    if (r && r.timer && r.nextAt) s.nextAt = r.nextAt;
    s.watching = !!(r && r.watcher);
    return s;
  }
  allStatus() {
    const o = {};
    for (const p of this.o.prefs.listSyncPairs()) o[p.id] = this.statusOf(p.id);
    return o;
  }

  // ── Scheduling ─────────────────────────────────────────────────────────
  // (Re)applies every pair's AUTO setting: timers and watchers on or off.
  applyAll() {
    const pairs = this.o.prefs.listSyncPairs();
    const ids = new Set(pairs.map(p => p.id));
    for (const id of [...this.runs.keys()]) if (!ids.has(id)) { this.unschedule(id); this.runs.delete(id); }
    for (const p of pairs) this.apply(p);
  }
  apply(pair, opts) {
    this.unschedule(pair.id);
    // SYNCTHING pairs (another filo, peer to peer) are run by direct.js.
    if (pair.via === 'direct') return;
    // SYNCTHING FAILSAFE: the failsafe has its own CONNECT switch.
    if ((pair.via === 'hybrid' ? !pair.fsAuto : !pair.auto) || this.stopped) {
      if (pair.via === 'hybrid' && !pair.fsAuto && !this.stopped) this.stopPairItems(pair.id);
      this.setStatus(pair, { auto: false }); return;
    }
    const r = this.rt(pair.id);
    const every = pair.interval * 60000;
    r.nextAt = Date.now() + every;
    r.timer = setInterval(() => { r.nextAt = Date.now() + every; this.run(pair.id, 'timer'); }, every);
    if (r.timer.unref) r.timer.unref();
    if (pair.direction !== 'down' && pair.watch !== false) this.watch(pair);
    this.setStatus(pair, { auto: true });
    if (!opts || opts.runNow !== false) this.run(pair.id, 'start');
  }
  unschedule(id) {
    const r = this.runs.get(id);
    if (!r) return;
    if (r.timer) clearInterval(r.timer);
    if (r.debounce) clearTimeout(r.debounce);
    if (r.retryT) clearTimeout(r.retryT);
    if (r.relayT) clearInterval(r.relayT);
    if (r.waitT) clearTimeout(r.waitT);
    if (r.mirrorT) clearInterval(r.mirrorT);
    if (r.watcher) { try { r.watcher.close(); } catch (_) {} }
    r.timer = r.debounce = r.retryT = r.watcher = r.relayT = r.waitT = r.mirrorT = null;
  }
  watch(pair) {
    const r = this.rt(pair.id);
    try {
      r.watcher = fs.watch(pair.local, { recursive: true }, (_ev, name) => {
        const n = String(name || '');
        if (/\.filopart$|\.filoold$/.test(n)) return;          // filo's own writes
        if (r.debounce) clearTimeout(r.debounce);
        r.debounce = setTimeout(() => { r.debounce = null; this.run(pair.id, 'change'); }, WATCH_DEBOUNCE_MS);
      });
      r.watcher.on('error', () => { try { r.watcher.close(); } catch (_) {} r.watcher = null; });
    } catch (e) {
      r.watcher = null;
      this.log('info', `LIVE SYNC “${pair.name}”: the local folder cannot be watched (${e.code || e.message}); it is checked every ${pair.interval} min`);
    }
  }
  stopAll() {
    this.stopped = true;
    for (const id of this.runs.keys()) this.unschedule(id);
    for (const r of this.runs.values()) if (r.conn) { try { r.conn.close(); } catch (_) {} r.conn = null; }
  }

  // ── One run ────────────────────────────────────────────────────────────
  // Never two runs of one pair at once; a run asked meanwhile happens after.
  async run(id, why) {
    const pair = this.o.prefs.getSyncPair(id);
    if (!pair) return { ok: false, error: 'This live sync no longer exists.' };
    if (pair.via === 'direct') return { ok: false, error: 'This live sync is SYNCTHING: it runs on its own.' };
    // FAILSAFE switched off: only an explicit CHECK NOW uses the server.
    if (pair.via === 'hybrid' && !pair.fsAuto && why !== 'now' && why !== 'force') return { ok: false, error: 'The S-FTP BACKUP of this session is off.' };
    const r = this.rt(id);
    // SYNCTHING FAILSAFE: the server is only used while the other
    // filo cannot be reached. 'wait': SYNCTHING is still starting, look again.
    let mirror = false;
    if (pair.via === 'hybrid' && this.o.directFirst && why !== 'force') {
      const d = this.o.directFirst(pair);
      // DUAL SYNC: SYNCTHING has finished, the MASTER mirrors its folder on
      // the server. The SLAVE never writes it (one writer: no double traffic,
      // no two versions of the truth on the server).
      if (d === true && this.mirrorOn(pair)) mirror = true;
      else if (d) {
        if (d === 'wait') { if (r.waitT) clearTimeout(r.waitT); r.waitT = setTimeout(() => { r.waitT = null; this.run(id, 'after direct'); }, 60000); if (r.waitT.unref) r.waitT.unref(); }
        this.setStatus(pair, { state: 'standby', lastRun: Date.now() });
        return { ok: true, copies: 0, conflicts: [], waiting: 0, standby: true, ids: [] };
      }
    }
    // Busy: this request is served by the run that follows the current one.
    if (r.busy) { r.again = true; return new Promise(res => (r.waiters || (r.waiters = [])).push(res)); }
    r.busy = true;
    let res;
    try { res = mirror ? await this._mirror(pair, r, why) : await this._run(pair, r, why); }
    catch (e) {
      const err = e && e.code ? e : RemoteError.from(e);
      res = { ok: false, error: this.explain(err) };
      this.setStatus(pair, { state: 'error', error: res.error, lastRun: Date.now() });
      this.log('error', `LIVE SYNC “${pair.name}”: ${res.error}`);
      if (r.conn) { try { r.conn.close(); } catch (_) {} r.conn = null; }
    } finally {
      r.busy = false;
    }
    if (r.again) {
      r.again = false;
      const waiters = r.waiters || [];
      r.waiters = [];
      setTimeout(() => { this.run(id, 'again').then(x => waiters.forEach(w => w(x))); }, 300);
    }
    return res;
  }

  // ── Segment relay, receiving side ──────────────────────────────────────
  // rl: { rel, dir (the sender's .filoparts folder), remote, local }
  async followRelay(pair, r, rl) {
    if (!r.relays) r.relays = new Map();
    const conn = r.conn;
    const known = r.relays.get(rl.rel) || Object.assign({ hashes: {}, info: null }, rl);
    const there = await fs.promises.stat(rl.local).catch(() => null);
    let entries = null;
    try { entries = await conn.list(rl.dir); } catch (_) { entries = null; }
    let final = false;
    if (!entries) {
      // The sender is done (its folder is gone) — or gave up.
      const st = await conn.stat(rl.remote).catch(() => null);
      if (!st || !known.info || st.size !== known.info.size) { r.relays.delete(rl.rel); return; }
      final = true;
    } else {
      const raw = known.info ? null : await readSmall(conn, posix.join(rl.dir, 'info.json'));
      if (raw) { try { known.info = JSON.parse(raw); } catch (_) {} }
      if (!known.info) return;
      for (const e of entries) {
        const m = /^(\d+)\.done$/.exec(e.name);
        if (!m || known.hashes[m[1]]) continue;
        const h = await readSmall(conn, posix.join(rl.dir, e.name), 200).catch(() => null);
        if (h && /^[0-9a-f]{8,64}$/.test(h.trim())) known.hashes[m[1]] = h.trim();
      }
    }
    if (there && there.size === known.info.size && !final) { r.relays.delete(rl.rel); return; }
    if (final) r.relays.delete(rl.rel); else r.relays.set(rl.rel, known);
    const i = known.info;
    this.o.queue.relayOffer({
      endpointId: 'site:' + pair.siteId, endpointLabel: `Sync · ${pair.name}`, local: rl.local, remote: rl.remote,
      sync: { pairId: pair.id, rel: rl.rel },
      relay: { id: i.id, size: i.size, mtime: i.mtime, segSize: i.segSize, count: i.count, part: posix.join(posix.dirname(rl.remote), bareName(i.part) || posix.basename(rl.remote) + '.filopart'), hashes: known.hashes, final },
    });
  }
  armRelayPoll(pair, r) {
    if (r.relayT || !r.relays || !r.relays.size) return;
    r.relayT = setInterval(async () => {
      if (r.busy || r.relayBusy) return;
      if (!r.relays || !r.relays.size) { clearInterval(r.relayT); r.relayT = null; return; }
      r.relayBusy = true;
      try {
        const p = this.o.prefs.getSyncPair(pair.id);
        if (!p) { clearInterval(r.relayT); r.relayT = null; return; }
        await this.connection(p, r);
        for (const rl of [...r.relays.values()]) await this.followRelay(p, r, rl).catch(() => {});
        this.idleClose(r);
      } catch (_) {
        if (r.conn) { try { r.conn.close(); } catch (_) {} r.conn = null; }
      } finally { r.relayBusy = false; }
    }, this.o.relayPollMs || RELAY_POLL_MS);
    if (r.relayT.unref) r.relayT.unref();
  }

  explain(err) {
    if (err && err.code === 'NEEDS_PASSWORD') return 'This site asks for its password each time. LIVE SYNC needs a site with a saved password, or a key.';
    if (err && err.code === 'TRUST_NEEDED') return 'This server is not trusted yet: connect to the site once from the bar and accept its identity.';
    return (err && err.message) || String(err);
  }

  // MASTER: writes its settings to the server when they changed. SLAVE: reads
  // them and takes them (onSession, direct-app.js).
  async sessionExchange(pair, r, root, rootStat) {
    const remote = await this.connection(pair, r);
    const p = posix.join(root, SESSION_FILE);
    const cur = rootStat ? await readSmall(remote, p, 200000).catch(() => null) : null;
    let have = null;
    try { have = cur ? JSON.parse(cur) : null; } catch (_) { have = null; }
    if (pair.role !== 'slave') {
      if (!this.o.sessionFile) return;
      const want = await this.o.sessionFile(pair);
      if (!want) return;
      const strip = o => JSON.stringify(Object.assign({}, o, { at: 0 }));
      if (have && strip(have) === strip(want)) return;
      if (!rootStat) await remote.mkdir(root).catch(() => {});
      await writeSmall(remote, p, JSON.stringify(Object.assign({}, want, { at: Date.now() }), null, 2));
      this.log('info', `LIVE SYNC “${pair.name}”: session settings written on the server for the SLAVE`);
    } else if (have && this.o.onSession) {
      this.o.onSession(pair, have);
    }
  }

  async connection(pair, r) {
    const endpointId = 'site:' + pair.siteId;
    if (r.conn && r.conn._filoEndpoint === endpointId && r.conn.alive !== false) return r.conn;
    if (r.conn) { try { r.conn.close(); } catch (_) {} r.conn = null; }
    const ep = await this.o.resolveEndpoint(endpointId);
    const c = this.o.createRemote(ep);
    await c.connect();
    c._filoEndpoint = endpointId;
    r.conn = c;
    return c;
  }
  idleClose(r) {
    if (r.closeT) clearTimeout(r.closeT);
    r.closeT = setTimeout(() => { if (!r.busy && r.conn) { try { r.conn.close(); } catch (_) {} r.conn = null; } }, IDLE_CLOSE_MS);
    if (r.closeT.unref) r.closeT.unref();
  }

  // ── DUAL SYNC: the server, a mirror of the MASTER's folder ─────────────
  mirrorOn(pair) {
    return pair.via === 'hybrid' && pair.role !== 'slave' && pair.fsAuto && !!this.o.mirrorReady && this.o.mirrorReady(pair) === true;
  }
  // This pair's queue items that still have something to do.
  pairItems(id, pred) {
    const q = this.o.queue;
    if (!q || !q.items) return [];
    return [...q.items.values()].filter(it => it.sync && it.sync.pairId === id && !it.removed && !['done', 'skipped', 'failed', 'stopped'].includes(it.status) && (!pred || pred(it)));
  }
  // SYNCTHING has files to move again: the mirror's copies wait (SYNCTHING
  // goes first, it is the faster way), then carry on where they were. The
  // hold is marked on the item (`sync.held`, kept in the queue's store): a
  // copy the user paused by hand is never resumed by filo, and a hold made
  // before filo quit is released after the restart (review 0.6.2).
  holdMirror(id, hold) {
    const q = this.o.queue, pair = this.o.prefs.getSyncPair(id);
    if (!q || !pair || pair.via !== 'hybrid') return;
    if (hold) {
      const ids = this.pairItems(id, it => it.sync.mirror && it.status !== 'paused').map(it => { it.sync.held = true; return it.id; });
      if (ids.length) q.pauseItems(ids);
    } else {
      if (!pair.fsAuto) return;
      this.releaseHeld(id);
    }
  }
  releaseHeld(id) {
    const q = this.o.queue;
    const ids = this.pairItems(id, it => it.sync.held && it.status === 'paused').map(it => { delete it.sync.held; return it.id; });
    if (ids.length) q.resumeItems(ids);
  }
  // The S-FTP BACKUP switched off, or the session deleted: what it still had
  // to copy stops (to Failed, retryable).
  stopPairItems(id) {
    const q = this.o.queue;
    if (!q) return;
    const ids = this.pairItems(id).map(it => it.id);
    if (ids.length) q.stopItems(ids);
  }
  // SYNCTHING moves files again: the backup is no longer known to be in step.
  staleMirror(id) {
    const r = this.runs.get(id), pair = this.o.prefs.getSyncPair(id);
    if (r && pair && r.status && r.status.state === 'mirrored') this.setStatus(pair, { state: 'standby' });
  }
  // The mirror's copies done: the status says so (or how many failed).
  watchMirror(pair, r) {
    if (r.mirrorT) clearInterval(r.mirrorT);
    r.mirrorT = setInterval(() => {
      const q = this.o.queue;
      const its = (r.mirrorIds || []).map(id => q.get(id)).filter(Boolean);
      if (its.some(it => !['done', 'skipped', 'failed', 'stopped'].includes(it.status))) return;
      clearInterval(r.mirrorT); r.mirrorT = null;
      if (!r.status || r.status.state !== 'mirror') return;
      const bad = its.filter(it => it.status === 'failed' || it.status === 'stopped').length;
      this.setStatus(pair, bad ? { state: 'error', error: `${bad} file${bad === 1 ? '' : 's'} not copied to the S-FTP BACKUP (see Failed).` } : { state: 'mirrored' });
    }, this.o.mirrorWatchMs || 3000);
    if (r.mirrorT.unref) r.mirrorT.unref();
  }
  async _mirror(pair, r, why) {
    const root0 = posix.normalize(pair.remote.startsWith('/') ? pair.remote : '/' + pair.remote);
    if (root0 === '/' || root0 === '.') throw new Error('The S-FTP BACKUP folder cannot be the root of the server: choose a folder for this session.');
    const { L, R, rootStat, root } = await this._list(pair, r, { strict: true });
    await this.sessionExchange(pair, r, root, rootStat).catch(e => this.log('warn', `LIVE SYNC “${pair.name}”: session settings on the server: ${e.message}`));
    const stableMs = this.o.stableMs != null ? this.o.stableMs : STABLE_MS;
    // The MASTER receives (2 WAYS, or REMOTE → LOCAL): what was put on the
    // server by hand comes here, and SYNCTHING takes it to the other computer.
    const pull = pair.direction !== 'up';
    const out = mirrorPlan({ L, R, state: this.loadState(pair), seen: r.seen, now: Date.now(), stableMs, pull });
    if (out.emptyGuard) this.log('warn', `LIVE SYNC “${pair.name}”: the local folder is empty and the S-FTP BACKUP is not: nothing deleted or brought back (a disk not connected?)`);
    const rp = rel => posix.join(root, rel);
    const lp = rel => localJoin(pair.local, rel);
    const q = this.o.queue;
    let deleted = 0;
    if (out.deletes.length) {
      const remote = await this.connection(pair, r);
      for (const d of out.deletes) {
        // A copy of an earlier pass still going there: stopped first.
        const dst = rp(d.rel);
        const inside = this.pairItems(pair.id, it => it.remote === dst || it.remote.startsWith(dst + '/')).map(it => it.id);
        if (inside.length) q.remove(inside);
        try {
          if (d.type === 'folder') await deleteRemoteTree(remote, dst, null, null); else await remote.unlink(dst);
          deleted++;
        } catch (e) { this.log('warn', `LIVE SYNC “${pair.name}”: ${d.rel} not deleted on the S-FTP BACKUP (${RemoteError.from(e).message})`); }
      }
      this.log('info', `LIVE SYNC “${pair.name}”: ${deleted} item${deleted === 1 ? '' : 's'} deleted on the S-FTP BACKUP (no longer on this computer)${out.deletes.length <= 5 ? ': ' + out.deletes.map(d => d.rel).join(', ') : ''}`);
    }
    // Changed on both sides: the server's version is kept beside the MASTER's
    // (renamed first, never lost), then the MASTER's goes.
    for (const u of out.uploads.filter(x => x.keep && R.has(x.rel))) {
      try {
        const remote = await this.connection(pair, r);
        await remote.rename(rp(u.rel), rp(conflictName(u.rel, 'server')));
        this.log('info', `LIVE SYNC “${pair.name}”: ${u.rel} differs on the S-FTP BACKUP: this computer's version goes there, the other one is kept beside it`);
      } catch (e) { this.log('warn', `LIVE SYNC “${pair.name}”: ${u.rel}: could not keep the S-FTP BACKUP's version (${e.message}); not copied`); u.skip = true; }
    }
    out.uploads = out.uploads.filter(u => !u.skip);
    const endpointId = 'site:' + pair.siteId, label = `Sync · ${pair.name}`;
    const specs = [];
    if (!rootStat && (out.uploads.length || out.folders.length)) specs.push({ dir: 'up', type: 'folder', local: pair.local, remote: root, endpointId, endpointLabel: label });
    for (const f of out.folders) specs.push({ dir: 'up', type: 'folder', local: lp(f), remote: rp(f), endpointId, endpointLabel: label });
    for (const f of out.localFolders) specs.push({ dir: 'down', type: 'folder', local: lp(f), remote: rp(f), endpointId, endpointLabel: label });
    for (const u of out.uploads) specs.push({ dir: 'up', type: 'file', local: lp(u.rel), remote: rp(u.rel), size: u.size, endpointId, endpointLabel: label, existing: 'overwrite', sync: { pairId: pair.id, rel: u.rel, mirror: true } });
    for (const d of out.downloads) specs.push({ dir: 'down', type: 'file', local: lp(d.rel), remote: rp(d.rel), size: d.size, endpointId, endpointLabel: label, existing: d.isNew ? 'skip' : 'overwrite', sync: { pairId: pair.id, rel: d.rel, mirror: true, trash: path.join(pair.local, TRASH) } });
    const ids = [];
    if (specs.length) {
      const added = q.add(specs);
      ids.push(...added, ...(added.revived || []).map(x => x.id));
      if (added.revived && added.revived.length) q.retry(added.revived.map(x => x.id), 'resume');
      const have = new Map();
      for (const x of q.items.values()) if (x.type === 'file' && !x.removed && x.status !== 'done' && x.endpointId === endpointId) have.set(x.dir + '\0' + x.local + '\0' + x.remote, x);
      for (const sp of specs) {
        if (sp.type !== 'file') continue;
        const it = have.get(sp.dir + '\0' + sp.local + '\0' + sp.remote);
        if (it && !ids.includes(it.id)) ids.push(it.id);
      }
      if (q.state === 'stopped' && added.queued) q.start();
    }
    r.mirrorIds = ids.filter(id => { const it = q.get(id); return it && it.type === 'file'; });
    // SYNCTHING busy again while this pass listed: its copies wait too;
    // otherwise the ones held earlier go on (never one the user paused).
    if (this.mirrorOn(pair)) { this.releaseHeld(pair.id); if (q.state === 'stopped' && r.mirrorIds.length) q.start(); }
    else this.holdMirror(pair.id, true);
    this.saveState(pair, out.files);
    this.idleClose(r);
    if (out.uploads.length) this.log('info', `LIVE SYNC “${pair.name}”: ${out.uploads.length} file${out.uploads.length === 1 ? '' : 's'} to copy to the S-FTP BACKUP`);
    if (out.downloads.length) this.log('info', `LIVE SYNC “${pair.name}”: ${out.downloads.length} file${out.downloads.length === 1 ? '' : 's'} put on the S-FTP BACKUP to bring here`);
    if (out.waiting) {
      if (r.retryT) clearTimeout(r.retryT);
      r.retryT = setTimeout(() => { r.retryT = null; this.run(pair.id, 'settling'); }, stableMs + 1000);
      if (r.retryT.unref) r.retryT.unref();
    }
    const result = { ok: true, mirror: true, copies: out.uploads.length, brought: out.downloads.length, folders: out.folders.length, deleted, waiting: out.waiting, conflicts: [], respected: [], local: L.size, remote: R.size, ids: r.mirrorIds.slice() };
    this.setStatus(pair, { state: r.mirrorIds.length ? 'mirror' : out.waiting ? 'waiting' : 'mirrored', lastRun: Date.now(), error: '', result });
    if (r.mirrorIds.length) this.watchMirror(pair, r);
    return result;
  }

  // Both listings, with the filter applied (a run and a mirror pass).
  async _list(pair, r, opts) {
    if (!pair.siteId || !this.o.prefs.getSite(pair.siteId)) throw new Error('Choose the site (server) of this live sync.');
    if (!pair.local || !path.isAbsolute(pair.local)) throw new Error('Choose the local folder of this live sync.');
    // A local folder that is not there (a disk or a NAS not mounted) is never
    // read as "everything was deleted": the run stops here.
    const lst = await fs.promises.stat(pair.local).catch(() => null);
    if (!lst || !lst.isDirectory()) throw new Error(`The local folder is not there: ${pair.local} (a disk not connected?)`);
    this.setStatus(pair, { state: 'checking', error: '' });

    const filter = new PathFilter('*', SYNC_ALWAYS_EXCLUDE + ', ' + (pair.exclude || ''));
    const L = new Map();
    // strict (the mirror, which deletes): an entry that cannot be read stops
    // the pass, instead of looking deleted (review 0.6.2).
    await local.walk(pair.local, e => {
      const rel = e.rel.replace(/\\/g, '/');
      if (NEVER_SYNCED.has(rel.split('/')[0])) return;
      if (e.type === 'folder' ? !filter.passFolder(rel) : !filter.passFile(rel)) return;
      L.set(rel, Object.assign({ type: e.type, size: e.size || 0, mtime: e.mtime || 0 }, e.partial ? { partial: true } : {}));
    }, null, opts && opts.strict ? { strict: true } : null);

    const root = posix.normalize(pair.remote.startsWith('/') ? pair.remote : '/' + pair.remote);
    // The listing connection may have been closed by the server since the
    // last run (FTP servers hang up idle connections): one fresh try.
    const listServer = async () => {
      const remote = await this.connection(pair, r);
      const R = new Map();
      relays.length = 0;
      const rootStat = await remote.stat(root);
      if (rootStat && rootStat.type === 'folder') {
        await walkRemote(remote, root, e => {
          // Another filo sending a large file here in segments (see transfer.js).
          const m = e.type === 'folder' && /^\.(.+)\.filoparts$/.exec(posix.basename(e.rel));
          if (m) { const d = posix.dirname(e.rel); relays.push({ rel: d === '.' ? m[1] : d + '/' + m[1], dir: e.path }); }
          if (NEVER_SYNCED.has(e.rel.split('/')[0])) return;
          if (e.type === 'folder' ? !filter.passFolder(e.rel) : !filter.passFile(e.rel)) return;
          R.set(e.rel, { type: e.type, size: e.size || 0, mtime: e.mtime || 0 });
        });
      }
      return { R, rootStat };
    };
    const relays = [];
    let listed;
    try { listed = await listServer(); }
    catch (e) {
      const err = RemoteError.from(e);
      if (!err.network) throw err;
      if (r.conn) { try { r.conn.close(); } catch (_) {} r.conn = null; }
      listed = await listServer();
    }
    if (listed.rootStat && listed.rootStat.type !== 'folder') throw new Error(`On the server, ${root} is not a folder.`);
    return { L, R: listed.R, rootStat: listed.rootStat, root, filter, relays };
  }

  async _run(pair, r, why) {
    // The other computer away: copies held for SYNCTHING go on (review 0.6.2).
    if (pair.via === 'hybrid') this.releaseHeld(pair.id);
    const { L, R, rootStat, root, filter, relays } = await this._list(pair, r);
    if (!rootStat && pair.direction === 'down') {
      // Not created yet (the other team has not sent anything): nothing to
      // bring, and not an error. Looked at again at the next check.
      this.idleClose(r);
      const result = { ok: true, copies: 0, folders: 0, queued: 0, waiting: 0, conflicts: [], respected: [], local: L.size, remote: 0, note: `The server folder ${root} does not exist yet.` };
      this.setStatus(pair, { state: 'idle', lastRun: Date.now(), error: '', result });
      return result;
    }
    // The MASTER's settings on the server, for the SLAVE (FAILSAFE only).
    if (pair.via === 'hybrid') await this.sessionExchange(pair, r, root, rootStat).catch(e => this.log('warn', `LIVE SYNC “${pair.name}”: session settings on the server: ${e.message}`));
    pair = this.o.prefs.getSyncPair(pair.id) || pair;     // a SLAVE may just have taken new settings
    this.idleClose(r);

    const state = this.loadState(pair);
    const stableMs = this.o.stableMs != null ? this.o.stableMs : STABLE_MS;
    const prefer = pair.via === 'hybrid' ? (pair.role === 'slave' ? 'r' : 'l') : null;
    const out = plan({ direction: pair.direction, L, R, state, seen: r.seen, now: Date.now(), stableMs, prefer });
    // The MASTER wins a conflict: the losing file is renamed first, with the
    // name of the computer it came from, then the MASTER's version is copied.
    for (const c of out.copies.filter(x => x.reason === 'master')) {
      try {
        if (c.from === 'l') {
          const remote = await this.connection(pair, r);
          const host = pair.peer ? String(pair.peer.name || '').split(' · ')[0] : 'server';
          await remote.rename(posix.join(root, c.rel), posix.join(root, conflictName(c.rel, host)));
        } else {
          const host = this.o.hostName ? this.o.hostName() : 'here';
          await fs.promises.rename(localJoin(pair.local, c.rel), localJoin(pair.local, conflictName(c.rel, host)));
        }
        this.log('info', `LIVE SYNC “${pair.name}”: ${c.rel} changed on both sides: the MASTER's version wins, the other one is kept beside it`);
      } catch (e) { this.log('warn', `LIVE SYNC “${pair.name}”: ${c.rel}: could not keep the other version (${e.message}); not copied`); c.skip = true; }
    }
    out.copies = out.copies.filter(c => !c.skip);
    // SYNCTHING + FAILSAFE: the server never gets deletions. A file missing here
    // but kept in this side's trash was deleted (by this computer or by the
    // other one, through Syncthing): it is not brought back from the server.
    if (pair.via === 'hybrid') {
      out.copies = out.copies.filter(c => {
        if (c.from !== 'r' || L.has(c.rel)) return true;
        if (!fs.existsSync(localJoin(path.join(pair.local, TRASH), c.rel))) return true;
        const was = { s: c.size, m: c.mtime };
        out.files[c.rel] = { l: was, r: was };              // as if on both sides: the deletion is respected from now on
        out.respected.push({ rel: c.rel, deletedOn: 'l' });
        return false;
      });
    }

    // To the queue. A file that is new on the other side goes with "skip" (if
    // something took its name meanwhile, it is not replaced: the next run
    // reports it); an update goes with "overwrite": the plan decided it.
    const endpointId = 'site:' + pair.siteId;
    const label = `Sync · ${pair.name}`;
    const specs = [];
    // Names from the server made safe for this disk (a \\ in an FTP name on
    // Windows would leave the folder: review 0.6.2).
    const lp = rel => localJoin(pair.local, rel);
    const rp = rel => posix.join(root, rel);
    if (!rootStat && (out.copies.length || out.folders.length)) {
      specs.push({ dir: 'up', type: 'folder', local: pair.local, remote: root, endpointId, endpointLabel: label });
    }
    for (const f of out.folders) {
      specs.push({ dir: f.to === 'r' ? 'up' : 'down', type: 'folder', local: lp(f.rel), remote: rp(f.rel), endpointId, endpointLabel: label });
    }
    for (const c of out.copies) {
      specs.push({
        dir: c.from === 'l' ? 'up' : 'down', type: 'file', local: lp(c.rel), remote: rp(c.rel), size: c.size,
        endpointId, endpointLabel: label, existing: c.reason === 'new' ? 'skip' : 'overwrite',
        // A local file replaced goes to .filo-trash first (Noar, 13/10/2026).
        sync: c.from === 'r' ? { pairId: pair.id, rel: c.rel, trash: path.join(pair.local, TRASH) } : { pairId: pair.id, rel: c.rel },
        relayOut: c.from === 'l' && pair.relay ? true : undefined,
      });
    }
    let queued = 0;
    const ids = [];
    if (specs.length) {
      const q = this.o.queue;
      const added = q.add(specs);
      queued = added.queued || 0;
      ids.push(...added, ...(added.revived || []).map(x => x.id));
      // Files stopped earlier with a partial copy: resumed, without asking.
      if (added.revived && added.revived.length) q.retry(added.revived.map(x => x.id), 'resume');
      // Already in the queue (an earlier run sent it, not finished yet): it
      // is one of this run's files too, for whoever waits for them.
      for (const sp of specs) {
        if (sp.type !== 'file') continue;
        const it = [...q.items.values()].find(x => x.type === 'file' && !x.removed && x.status !== 'done' && x.dir === sp.dir && x.local === sp.local && x.remote === sp.remote && x.endpointId === endpointId);
        if (it && !ids.includes(it.id)) ids.push(it.id);
      }
      if (q.state === 'stopped' && queued) q.start();
    }
    this.saveState(pair, out.files);

    // Relayed files: taken segment by segment, while they are still arriving.
    if (pair.relay && pair.direction !== 'up' && r.conn && r.conn.canSegment) {
      for (const rl of relays) {
        if (!filter.passFile(rl.rel)) continue;
        await this.followRelay(pair, r, { rel: rl.rel, dir: rl.dir, remote: rp(rl.rel), local: lp(rl.rel) }).catch(e => this.log('warn', `LIVE SYNC “${pair.name}”: relay of ${rl.rel}: ${e.message}`));
      }
      this.armRelayPoll(pair, r);
    }

    const changedNow = out.copies.length + out.folders.length;
    if (changedNow) this.log('info', `LIVE SYNC “${pair.name}”: ${out.copies.length} file${out.copies.length === 1 ? '' : 's'} to copy${out.folders.length ? `, ${out.folders.length} folder${out.folders.length === 1 ? '' : 's'}` : ''} (${WHY[why] || why})`);
    for (const c of out.conflicts.slice(0, 20)) this.log('warn', `LIVE SYNC “${pair.name}”: ${c.rel}: ${c.why}. Left as it is.`);
    for (const d of out.respected.slice(0, 20)) this.log('info', `LIVE SYNC “${pair.name}”: ${d.rel} was deleted ${d.deletedOn === 'l' ? 'here' : 'on the server'}; not sent again.`);

    // Files still being written: looked at again once they had time to settle.
    if (out.waiting) {
      if (r.retryT) clearTimeout(r.retryT);
      r.retryT = setTimeout(() => { r.retryT = null; this.run(pair.id, 'settling'); }, stableMs + 1000);
      if (r.retryT.unref) r.retryT.unref();
    }
    const result = {
      ok: true, copies: out.copies.length, folders: out.folders.length, queued, waiting: out.waiting,
      conflicts: out.conflicts.slice(0, 200), respected: out.respected.slice(0, 200),
      local: L.size, remote: R.size,
      ids: ids.filter(id => { const it = this.o.queue.get(id); return it && it.type === 'file'; }),
    };
    this.setStatus(pair, { state: out.waiting ? 'waiting' : 'idle', lastRun: Date.now(), error: '', result });
    return result;
  }
}

module.exports = { Syncer, STABLE_MS, SESSION_FILE, conflictName };
