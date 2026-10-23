/*
 * filo — FTP, FTPS and SFTP client
 * Copyright (C) 2026 Just Edit (Arnaud Augst)
 * Licensed under the GNU General Public License v3.0 or later. See LICENSE.
 */

// The profile: userData/preferences.json (settings, sites, known servers,
// quick-connect history, window) and userData/queue.json (the queue).
//
// No password is ever written here in clear. A site's password is a blob from
// secrets.js — encrypted with a key the operating system keeps (Keychain,
// DPAPI, desktop keyring) — or nothing at all.

const fs = require('fs');
const path = require('path');
const { normalizeSite, publicSite } = require('./core/sites');
const { ACTIONS: EXISTING } = require('./core/existing');

const DEFAULT_SETTINGS = {
  concurrency: 'auto',      // 'auto' or 1…10
  autoMax: 10,              // the ceiling Auto may climb to
  retries: 5,
  limitUp: 0,               // MB/s, 0 = no limit
  limitDown: 0,
  existingUp: 'ask',
  existingDown: 'ask',
  verify: false,            // SAFE COPY: check every file after the transfer (off by default since 0.9.6, Noar: slower)
  serverHash: true,         // ask the server for a checksum when it can
  readBack: true,           // otherwise, read the file back to check it
  tempNames: true,          // write to .filopart, rename once verified
  segments: true,           // SFTP: large files over several connections at once
  keepDates: true,
  showHidden: false,
  confirmDelete: true,
  hookEnabled: false,       // the command after the queue (Settings)
  hookCommand: '',
};

// LIVE SYNC pairs. Excluded by default: system clutter and the temporary
// names of filo and of the usual copy tools (a file still on its way).
// Separated by commas (Noar, 12/10/2026: easier to type than |, still read).
// Short: the system's own litter. filo's own work files are always left out,
// without being listed (SYNC_ALWAYS_EXCLUDE).
const DEFAULT_SYNC_EXCLUDE = '.DS_Store, ._*, Thumbs.db, *.tmp';
const SYNC_ALWAYS_EXCLUDE = '*.filopart, *.filoold, .*.filoparts';
function normalizeSyncPair(p) {
  const o = p && typeof p === 'object' ? p : {};
  const id = /^[0-9a-f]{16}$/.test(o.id) ? o.id : require('crypto').randomBytes(8).toString('hex');
  return {
    id,
    name: String(o.name || 'New session').slice(0, 120),
    siteId: typeof o.siteId === 'string' ? o.siteId : '',
    local: typeof o.local === 'string' ? o.local : '',
    remote: typeof o.remote === 'string' && o.remote ? o.remote : '/',
    direction: ['up', 'down', 'both'].includes(o.direction) ? o.direction : 'up',
    auto: !!o.auto,                                                           // connected
    watch: o.watch !== false,                                                 // AUTO WATCH: the local folder is watched
    // DIRECT + S-FTP FAILSAFE: the failsafe has its own connect switch.
    fsAuto: o.fsAuto !== false,
    // DIRECT: the computer that created the session is the MASTER (its
    // version wins a conflict, its direction and settings are the
    // session's); the one that imported it is the SLAVE.
    role: o.role === 'slave' ? 'slave' : 'master',
    interval: Math.max(1, Math.min(1440, parseInt(o.interval, 10) || 5)),     // minutes between server checks
    exclude: o.exclude == null ? DEFAULT_SYNC_EXCLUDE : String(o.exclude).slice(0, 4000),
    relay: o.relay !== false,                                                 // segments relay (SFTP)
    // DIRECT (direct.js): the other side is another filo, reached peer to
    // peer by the embedded Syncthing, not a server. siteId and remote are
    // then unused; the folder is known to both filo by folderId.
    // 'server' (S-FTP), 'direct' (Syncthing), 'hybrid' (DIRECT with S-FTP
    // failsafe: Syncthing while the other filo is reachable, the server
    // folder otherwise).
    via: ['direct', 'hybrid'].includes(o.via) ? o.via : 'server',
    peer: o.peer && DEVICE_ID.test(o.peer.id) ? { id: o.peer.id, name: String(o.peer.name || '').slice(0, 120) } : null,
    folderId: typeof o.folderId === 'string' && FOLDER_ID.test(o.folderId) ? o.folderId : '',
  };
}
// A Syncthing device ID (eight groups of seven) and filo's own folder IDs.
const DEVICE_ID = /^[A-Z2-7]{7}(-[A-Z2-7]{7}){7}$/;
const FOLDER_ID = /^filo-(up|down|both)-[0-9a-z]{12}$/;
function normalizeDevice(d) {
  return d && DEVICE_ID.test(d.id) ? { id: d.id, name: String(d.name || '').slice(0, 120) } : null;
}

const DEFAULT_NTFY = { enabled: false, server: 'https://ntfy.sh', topic: '', syncAlert: false, syncAlertMin: 10 };

function writeAtomic(file, text) {
  const tmp = file + '.tmp-' + process.pid;
  // On the disk before the rename: a power cut leaves the old file or the new
  // one, never a half one.
  const fd = fs.openSync(tmp, 'w', 0o600);
  try { fs.writeSync(fd, text); try { fs.fsyncSync(fd); } catch (_) {} } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
}

// Preferences and queue (review 0.7.2): the file read well at start is kept
// as "<file>.bak". A file that cannot be read is put aside
// ("<file>.corrupt-<date>") and the .bak taken instead: the sites, the
// trusted servers and the saved passwords are never replaced by an empty
// profile at the next save. recovered: '' | 'bak' (taken back) | 'lost'.
function readWithBackup(file) {
  const d = readJson(file);
  if (d && typeof d === 'object') {
    try { fs.copyFileSync(file, file + '.bak'); } catch (_) {}
    return { data: d, recovered: '' };
  }
  if (!fs.existsSync(file)) return { data: null, recovered: '' };
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  try { fs.renameSync(file, `${file}.corrupt-${stamp}`); } catch (_) {}
  const b = readJson(file + '.bak');
  return { data: b && typeof b === 'object' ? b : null, recovered: b ? 'bak' : 'lost' };
}

function normalizeSettings(s) {
  const o = Object.assign({}, DEFAULT_SETTINGS, s || {});
  if (o.concurrency !== 'auto') {
    const n = parseInt(o.concurrency, 10);
    o.concurrency = Number.isFinite(n) ? Math.max(1, Math.min(10, n)) : 'auto';
  }
  o.autoMax = Math.max(2, Math.min(10, parseInt(o.autoMax, 10) || 10));
  o.retries = Math.max(0, Math.min(20, parseInt(o.retries, 10)));
  if (!Number.isFinite(o.retries)) o.retries = DEFAULT_SETTINGS.retries;
  for (const k of ['limitUp', 'limitDown']) { const v = Number(o[k]); o[k] = Number.isFinite(v) && v > 0 ? Math.min(100000, Math.round(v * 10) / 10) : 0; }
  if (!EXISTING.includes(o.existingUp)) o.existingUp = 'ask';
  if (!EXISTING.includes(o.existingDown)) o.existingDown = 'ask';
  for (const k of ['verify', 'serverHash', 'readBack', 'tempNames', 'segments', 'keepDates', 'showHidden', 'confirmDelete']) o[k] = !!o[k];
  // The settings have one verification switch (server checksum, or read the
  // file back): a server that cannot compute a checksum is always read back.
  // An older "never read back" choice is no longer visible, so it goes.
  o.readBack = true;
  o.hookEnabled = !!o.hookEnabled;
  o.hookCommand = String(o.hookCommand || '').slice(0, 2000);
  return o;
}

class Prefs {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, 'preferences.json');
    this.queueFile = path.join(dir, 'queue.json');
    this.data = {};
  }

  load() {
    try { fs.mkdirSync(this.dir, { recursive: true }); } catch (_) {}
    const r = readWithBackup(this.file);
    this.recovered = r.recovered;
    const d = r.data || {};
    this.data = {
      settings: normalizeSettings(d.settings),
      ntfy: Object.assign({}, DEFAULT_NTFY, d.ntfy || {}),
      sites: Array.isArray(d.sites) ? d.sites.map(normalizeSite) : [],
      // Order of the folders in the site manager (their full paths), as the
      // user arranged them by dragging. The sites' own order is their order
      // in `sites`.
      siteFolderOrder: Array.isArray(d.siteFolderOrder) ? d.siteFolderOrder.filter(x => typeof x === 'string').slice(0, 2000) : [],
      knownHosts: d.knownHosts && typeof d.knownHosts === 'object' ? d.knownHosts : {},
      // Only well-formed entries: a site (by id) or a quick connection.
      quickHistory: Array.isArray(d.quickHistory)
        ? d.quickHistory.filter(x => x && typeof x === 'object' && (typeof x.siteId === 'string' || (typeof x.host === 'string' && x.host))).slice(0, 15)
        : [],
      afterAction: ['none', 'quit', 'sleep', 'shutdown'].includes(d.afterAction) ? d.afterAction : 'none',
      syncPairs: Array.isArray(d.syncPairs) ? d.syncPairs.slice(0, 200).map(normalizeSyncPair) : [],
      // DIRECT: the other filo this machine accepted (their Syncthing IDs).
      directDevices: Array.isArray(d.directDevices) ? d.directDevices.slice(0, 100).map(normalizeDevice).filter(Boolean) : [],
      window: d.window || null,
      ui: d.ui || {},
      lastLocalDir: d.lastLocalDir || '',
      // 0.6.4: folders exist on their own (an empty one stays, NEW FOLDER).
      // Before, a folder only existed through its sites: the order list could
      // hold folders emptied long ago, pruned once here so they do not come
      // back as empty folders.
      siteFoldersOwn: d.siteFoldersOwn === true,
    };
    if (!this.data.siteFoldersOwn) {
      const used = new Set();
      for (const st of this.data.sites) { const parts = String(st.folder || '').split(' / ').filter(Boolean); parts.forEach((_, i) => used.add(parts.slice(0, i + 1).join(' / '))); }
      this.data.siteFolderOrder = this.data.siteFolderOrder.filter(f => used.has(f));
      this.data.siteFoldersOwn = true;
    }
    return this;
  }

  save(patch) {
    if (patch) Object.assign(this.data, patch);
    // A disk full or a read-only profile: said in the journal (once per kind),
    // not silent: sites, trusted identities and passwords would be lost.
    try { writeAtomic(this.file, JSON.stringify(this.data, null, 2)); this.saveErr = null; }
    catch (e) { if (this.saveErr !== e.code) { this.saveErr = e.code; if (this.onError) this.onError(`Settings not saved (${e.message})`); } }
  }

  // ── Settings ────────────────────────────────────────────────────────────
  settings() { return this.data.settings; }
  saveSettings(patch) {
    this.data.settings = normalizeSettings(Object.assign({}, this.data.settings, patch || {}));
    this.save();
    return this.data.settings;
  }

  // ── Sites ───────────────────────────────────────────────────────────────
  listSites() { return this.data.sites.map(publicSite); }
  getSite(id) { return this.data.sites.find(s => s.id === id) || null; }

  // site comes from the window: no blobs. secretsPatch: { passwordEnc?, passphraseEnc? }
  // where undefined keeps what was stored, and null forgets it.
  saveSite(site, secretsPatch) {
    const prev = site.id ? this.getSite(site.id) : null;
    const merged = normalizeSite(Object.assign({}, prev || {}, site, {
      passwordEnc: prev ? prev.passwordEnc : null,
      passphraseEnc: prev ? prev.passphraseEnc : null,
    }));
    // A speed profile belongs to a server and an account: another one, another profile.
    if (prev && prev.speed && !('speed' in site) && (prev.host !== merged.host || prev.port !== merged.port || prev.protocol !== merged.protocol || prev.user !== merged.user)) merged.speed = null;
    const sp = secretsPatch || {};
    if (sp.passwordEnc !== undefined) merged.passwordEnc = sp.passwordEnc;
    if (sp.passphraseEnc !== undefined) merged.passphraseEnc = sp.passphraseEnc;
    // "Ask each time" and "anonymous" keep no password.
    if (merged.logon === 'ask' || merged.logon === 'anonymous') merged.passwordEnc = null;
    if (merged.logon !== 'key') merged.passphraseEnc = null;
    const i = this.data.sites.findIndex(s => s.id === merged.id);
    if (i >= 0) this.data.sites[i] = merged; else this.data.sites.push(merged);
    this.save();
    return publicSite(merged);
  }

  // A new arrangement from the window (drag and drop): every site, in its new
  // order, with its folder. Only ids that exist are taken; a site the list
  // forgot keeps its place at the end, so nothing can be lost here.
  arrangeSites(list, folderOrder) {
    const byId = new Map(this.data.sites.map(s => [s.id, s]));
    const out = [];
    for (const e of Array.isArray(list) ? list : []) {
      const s = e && byId.get(e.id);
      if (!s) continue;
      byId.delete(e.id);
      out.push(Object.assign({}, s, { folder: String(e.folder || '').slice(0, 120) }));
    }
    for (const s of byId.values()) out.push(s);
    this.data.sites = out;
    if (Array.isArray(folderOrder)) this.data.siteFolderOrder = folderOrder.filter(x => typeof x === 'string').map(x => x.slice(0, 120)).slice(0, 2000);
    this.save();
    return this.listSites();
  }

  // ── LIVE SYNC pairs ────────────────────────────────────────────────────
  listSyncPairs() { return this.data.syncPairs.map(p => Object.assign({}, p)); }
  getSyncPair(id) { return this.data.syncPairs.find(p => p.id === id) || null; }
  saveSyncPair(pair) {
    const prev = pair && pair.id ? this.getSyncPair(pair.id) : null;
    const merged = normalizeSyncPair(Object.assign({}, prev || {}, pair || {}));
    const i = this.data.syncPairs.findIndex(p => p.id === merged.id);
    if (i >= 0) this.data.syncPairs[i] = merged; else this.data.syncPairs.push(merged);
    this.save();
    return merged;
  }
  deleteSyncPair(id) {
    this.data.syncPairs = this.data.syncPairs.filter(p => p.id !== id);
    this.save();
  }

  // ── DIRECT: the other filo this machine accepted ─────────────────────────
  listDirectDevices() { return this.data.directDevices.map(d => Object.assign({}, d)); }
  addDirectDevice(dev) {
    const d = normalizeDevice(dev);
    if (!d) return null;
    const i = this.data.directDevices.findIndex(x => x.id === d.id);
    if (i >= 0) { if (d.name) this.data.directDevices[i].name = d.name; } else this.data.directDevices.push(d);
    this.save();
    return d;
  }
  forgetDirectDevice(id) {
    this.data.directDevices = this.data.directDevices.filter(d => d.id !== id);
    this.save();
  }

  // A copy goes right under its source in the list (0.9.0), not at the end.
  // `sourceId` → `newId`: the new site is moved to just after the source.
  placeAfter(newId, sourceId) {
    const from = this.data.sites.findIndex(s => s.id === newId);
    if (from < 0) return;
    const [moved] = this.data.sites.splice(from, 1);
    const at = this.data.sites.findIndex(s => s.id === sourceId);
    this.data.sites.splice(at < 0 ? this.data.sites.length : at + 1, 0, moved);
    this.save();
  }

  deleteSite(id) {
    this.data.sites = this.data.sites.filter(s => s.id !== id);
    // A deleted site leaves the recent connections too (it would take a place
    // in the list while never being shown).
    this.data.quickHistory = this.data.quickHistory.filter(x => x.siteId !== id);
    this.save();
  }

  // ── Known servers (SSH host keys, pinned TLS certificates) ──────────────
  _hostKey(kind, host, port) { return `${kind}:${String(host).toLowerCase()}:${port}`; }
  knownHost(kind, host, port) { return this.data.knownHosts[this._hostKey(kind, host, port)] || null; }
  rememberHost(kind, host, port, fp) { this.data.knownHosts[this._hostKey(kind, host, port)] = fp; this.save(); }
  forgetHost(key) { delete this.data.knownHosts[key]; this.save(); }
  listKnownHosts() { return Object.entries(this.data.knownHosts).map(([key, fp]) => ({ key, fp })); }

  // ── Quick connect history (never a password) ────────────────────────────
  // Recent connections: sites (by id) and quick connections (no password),
  // the last one first.
  pushQuick(q) {
    const e = q.siteId ? { siteId: String(q.siteId) } : { protocol: q.protocol, host: q.host, port: q.port, user: q.user || '' };
    const k = x => (x.siteId ? `site|${x.siteId}` : `${x.protocol}|${x.user}|${String(x.host).toLowerCase()}|${x.port}`);
    this.data.quickHistory = [e, ...this.data.quickHistory.filter(x => k(x) !== k(e))].slice(0, 15);
    this.save();
    return this.data.quickHistory;
  }
  clearQuick() { this.data.quickHistory = []; this.save(); }

  // ── ntfy ────────────────────────────────────────────────────────────────
  ntfy() { return Object.assign({}, this.data.ntfy); }
  saveNtfy(patch) {
    const p = patch || {};
    const n = this.data.ntfy;
    if (p.enabled !== undefined) n.enabled = !!p.enabled;
    if (p.server !== undefined) n.server = String(p.server || '').trim() || DEFAULT_NTFY.server;
    if (p.topic !== undefined) n.topic = String(p.topic || '').trim();
    if (p.syncAlert !== undefined) n.syncAlert = !!p.syncAlert;
    if (p.syncAlertMin !== undefined) n.syncAlertMin = Math.max(1, Math.min(240, parseInt(p.syncAlertMin, 10) || DEFAULT_NTFY.syncAlertMin));
    this.save();
    return this.ntfy();
  }

  // ── Queue store ─────────────────────────────────────────────────────────
  queueStore() {
    return {
      load: () => { const r = readWithBackup(this.queueFile); this.queueRecovered = r.recovered; return r.data; },
      save: list => writeAtomic(this.queueFile, JSON.stringify(list)),
    };
  }
}

module.exports = { DEVICE_ID, FOLDER_ID, normalizeSyncPair, DEFAULT_SYNC_EXCLUDE, SYNC_ALWAYS_EXCLUDE, Prefs, DEFAULT_SETTINGS, normalizeSettings, writeAtomic };
