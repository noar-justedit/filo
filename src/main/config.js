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
  verify: true,             // check every file after the transfer
  serverHash: true,         // ask the server for a checksum when it can
  readBack: true,           // otherwise, read the file back to check it
  tempNames: true,          // write to .filopart, rename once verified
  segments: true,           // SFTP: large files over several connections at once
  keepDates: true,
  showHidden: false,
  confirmDelete: true,
};

const DEFAULT_NTFY = { enabled: false, server: 'https://ntfy.sh', topic: '' };

function writeAtomic(file, text) {
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
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
    const d = readJson(this.file) || {};
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
      window: d.window || null,
      ui: d.ui || {},
      lastLocalDir: d.lastLocalDir || '',
    };
    return this;
  }

  save(patch) {
    if (patch) Object.assign(this.data, patch);
    try { writeAtomic(this.file, JSON.stringify(this.data, null, 2)); } catch (_) {}
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
    this.save();
    return this.ntfy();
  }

  // ── Queue store ─────────────────────────────────────────────────────────
  queueStore() {
    return {
      load: () => readJson(this.queueFile),
      save: list => writeAtomic(this.queueFile, JSON.stringify(list)),
    };
  }
}

module.exports = { Prefs, DEFAULT_SETTINGS, normalizeSettings, writeAtomic };
