/*
 * filo — FTP, FTPS and SFTP client
 * Copyright (C) 2026 Just Edit (Arnaud Augst)
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */

const { app, BrowserWindow, ipcMain, dialog, shell, Menu, powerSaveBlocker, clipboard } = require('electron');
const path  = require('path');
const posix = path.posix;
const fs    = require('fs');
const https = require('https');

const { Prefs } = require('./config');
const secrets = require('./secrets');
const power   = require('./power');
const notify  = require('./notify');
const local   = require('./proto/local');
const { createRemote, parseUrl, describe, DEFAULT_PORT, LABEL } = require('./proto');
const { setHostKeyPolicy } = require('./proto/sftp');
const { setCertPolicy } = require('./proto/ftp');
const { TransferQueue } = require('./core/queue');
const { RemoteError } = require('./core/errors');
const { walkRemote, deleteRemoteTree, safeLocalName, localJoin } = require('./core/scan');
const sites = require('./core/sites');
const { LABELS: EXISTING_LABELS } = require('./core/existing');

const IS_MAC = process.platform === 'darwin';
const DEV    = process.argv.includes('--dev') && !app.isPackaged;   // never in a shipped build
const REPO   = 'https://github.com/noar-justedit/filo';

// ── Update check (same mechanism as syncto: version.json on GitHub) ────────
const UPDATE_URL = 'https://raw.githubusercontent.com/noar-justedit/filo/main/version.json';
const UPDATE_HOST = 'raw.githubusercontent.com';
const RELEASES_URL = REPO + '/releases/latest';
function semverGt(a, b) {
  const pa = String(a).split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x > y) return true;
    if (x < y) return false;
  }
  return false;
}
function fetchFollow(url, hops, cb) {
  let called = false;
  const done = v => { if (!called) { called = true; cb(v); } };
  if (hops > 3) return done(null);
  try {
    if (new URL(url).host !== UPDATE_HOST) return done(null);
    const req = https.get(url, { timeout: 4000 }, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        let next; try { next = new URL(res.headers.location, url).toString(); } catch (e) { return done(null); }
        called = true;
        return fetchFollow(next, hops + 1, cb);
      }
      if (res.statusCode !== 200) { res.resume(); return done(null); }
      let body = '';
      res.on('data', c => { body += c; if (body.length > 65536) { req.destroy(); done(null); } });
      res.on('end', () => done(body));
      res.on('error', () => done(null));
    });
    req.on('timeout', () => { req.destroy(); done(null); });
    req.on('error', () => done(null));
  } catch (e) { done(null); }
}
function checkForUpdate() {
  fetchFollow(UPDATE_URL, 0, body => {
    if (!body) return;
    let data; try { data = JSON.parse(body); } catch (e) { return; }
    if (!data || !/^\d+(\.\d+){0,3}$/.test(String(data.version || ''))) return;
    if (semverGt(data.version, appVersion())) send('update-available', { version: String(data.version), url: RELEASES_URL });
  });
}

function appVersion() {
  try { return require('../../package.json').version; } catch (_) { return '0.0.0'; }
}

function openExternalSafely(u) {
  let parsed;
  try { parsed = new URL(String(u)); } catch (_) { return false; }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
  shell.openExternal(parsed.toString());
  return true;
}

let win = null;
let prefs = null;
let queue = null;
let powerBlockId = null;
let quitting = false;

// ── One filo at a time ─────────────────────────────────────────────────────
// The queue lives in one file. Two copies of filo would each run it and each
// rewrite it — the same file uploaded twice, and a queue that loses items.
// A second launch brings the first window forward instead.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
}

function send(channel, payload) { if (win && !win.isDestroyed()) win.webContents.send(channel, payload); }

// ── Log (the "Log" tab) ────────────────────────────────────────────────────
const LOG_MAX = 3000;
const logLines = [];
let logPending = [];
let logTimer = null;
function log(level, msg) {
  const line = { t: Date.now(), level, msg: String(msg) };
  logLines.push(line);
  if (logLines.length > LOG_MAX) logLines.splice(0, logLines.length - LOG_MAX);
  logPending.push(line);
  if (!logTimer) logTimer = setTimeout(() => { logTimer = null; const b = logPending; logPending = []; send('log', b); }, 250);
}

// ── Endpoints: who to connect to, with what ─────────────────────────────────
// An endpoint id names a server and an account: "site:<id>" for a saved site,
// "quick:<protocol>:<user>@<host>:<port>" for a quick connection. The queue
// stores only the id; the password is looked up at the moment a connection
// opens, here, and never leaves this process.
const memSecrets = new Map();       // endpointId → { password, passphrase } (this session only)
const quickEndpoints = new Map();   // endpointId → { protocol, host, port, user }

function quickId(q) { return `quick:${q.protocol}:${q.user || ''}@${String(q.host).toLowerCase()}:${q.port}`; }

function needsPassword(endpointId, label, what) {
  return new RemoteError(`filo needs the ${what || 'password'} for ${label}.`, { code: 'NEEDS_PASSWORD', fatal: true, endpointId, what: what || 'password' });
}

// The identities this server is known by travel with the endpoint: a transfer
// thread cannot read the profile, and must check the server all the same.
async function resolveEndpoint(endpointId) {
  const ep = await resolveEndpointBase(endpointId);
  ep.known = { sftp: prefs.knownHost('sftp', ep.host, ep.port), ftps: prefs.knownHost('ftps', ep.host, ep.port) };
  return ep;
}

async function resolveEndpointBase(endpointId) {
  const mem = memSecrets.get(endpointId) || {};
  if (endpointId.startsWith('site:')) {
    const site = prefs.getSite(endpointId.slice(5));
    if (!site) throw new RemoteError('This site was deleted from the site manager.', { fatal: true });
    const ep = { protocol: site.protocol, host: site.host, port: site.port, user: site.user, label: site.name,
                 transferMode: site.transferMode, maxConnections: site.maxConnections };
    if (site.logon === 'anonymous') { ep.user = ep.user || 'anonymous'; ep.password = ''; }
    else if (site.logon === 'key') {
      try { ep.privateKey = fs.readFileSync(site.keyPath); }
      catch (_) { throw new RemoteError(`The private key "${site.keyPath}" cannot be read.`, { fatal: true }); }
      ep.passphrase = mem.passphrase || secrets.decrypt(site.passphraseEnc) || undefined;
    } else {
      ep.password = mem.password || (site.logon === 'normal' ? secrets.decrypt(site.passwordEnc) : '');
      if (!ep.password) throw needsPassword(endpointId, site.name);
    }
    return ep;
  }
  const q = quickEndpoints.get(endpointId);
  if (!q) {
    const label = endpointId.replace(/^quick:[^:]+:/, '');
    throw needsPassword(endpointId, label);
  }
  const ep = Object.assign({ label: describe(q) }, q, { password: mem.password || '' });
  if (!ep.password && ep.user && ep.user !== 'anonymous') throw needsPassword(endpointId, ep.label);
  return ep;
}

function endpointLabel(endpointId) {
  if (endpointId.startsWith('site:')) { const s = prefs.getSite(endpointId.slice(5)); return s ? s.name : '?'; }
  const q = quickEndpoints.get(endpointId);
  return q ? describe(q) : endpointId.replace(/^quick:[^:]+:/, '');
}

// ── The browsing connection ────────────────────────────────────────────────
// Separate from the transfer connections: browsing must never wait behind a
// 40 GB upload, and the queue must never lose its connection because someone
// connected the panel to another server.
const browser = { endpointId: null, remote: null, label: '', ep: null };

// An action in several steps (deleting a folder, listing a folder to queue
// it) is bound to the server it started on: if the panel connects to another
// server meanwhile, the next step stops instead of carrying on over there.
function browserSession() { return { endpointId: browser.endpointId }; }
function sameServer(sess) {
  if (sess && sess.endpointId !== browser.endpointId) {
    throw new RemoteError('The panel connected to another server meanwhile: stopped here.', { code: 'SERVER_CHANGED', fatal: true });
  }
}

async function reconnectBrowser() {
  // Several actions failing at once share one reconnection (no connection
  // left open behind them).
  if (browser.reconnecting) return browser.reconnecting;
  const id = browser.endpointId;
  browser.reconnecting = (async () => {
    log('info', `Reconnecting to ${browser.label}…`);
    try { browser.remote.close(); } catch (_) {}
    const ep = await resolveEndpoint(id);
    const r = createRemote(ep, { log });
    await r.connect();
    if (browser.endpointId !== id) { try { r.close(); } catch (_) {} throw new RemoteError('The panel connected to another server meanwhile: stopped here.', { code: 'SERVER_CHANGED', fatal: true }); }
    browser.remote = r;
    return r;
  })();
  try { return await browser.reconnecting; } finally { browser.reconnecting = null; }
}

async function withBrowser(fn, sess) {
  if (!browser.remote) throw new RemoteError('Not connected.', { code: 'NOT_CONNECTED' });
  sameServer(sess);
  try { return await fn(browser.remote); }
  catch (e) {
    const err = RemoteError.from(e, browser.ep && browser.ep.protocol);
    if (!err.network) throw err;
    sameServer(sess);
    // FTP servers hang up on an idle connection after a few minutes, and a
    // laptop that slept has lost all of them: reconnect once, quietly.
    const r = await reconnectBrowser();
    sameServer(sess);
    return fn(r);
  }
}

// Server identities the user has actually been shown (a TRUST_NEEDED that
// went to the window). The 'trust' handler accepts nothing else: the window
// cannot pin a fingerprint of its own making.
const trustOffers = new Map();
const offerKey = t => `${t.kind}|${String(t.host).toLowerCase()}|${Number(t.port)}|${t.fingerprint}`;
function offerTrust(t) {
  if (!t || !t.kind || !t.host || !t.fingerprint) return;
  trustOffers.set(offerKey(t), Date.now());
  if (trustOffers.size > 50) trustOffers.delete(trustOffers.keys().next().value);
}

function errOut(e) {
  const err = RemoteError.from(e);
  if (err.trust) offerTrust(err.trust);
  return { ok: false, error: err.message, code: err.code || null, trust: err.trust || null, needsPassword: err.code === 'NEEDS_PASSWORD', what: err.what || null, endpointId: err.endpointId || null };
}

// ── Window ─────────────────────────────────────────────────────────────────
function createWindow() {
  const w = (prefs.data.window && prefs.data.window.width) || 1360;
  const h = (prefs.data.window && prefs.data.window.height) || 880;
  win = new BrowserWindow({
    width: w, height: h, minWidth: 1100, minHeight: 680,
    backgroundColor: '#0a0b0e',
    show: false,
    titleBarStyle: IS_MAC ? 'hiddenInset' : 'hidden',
    trafficLightPosition: IS_MAC ? { x: 18, y: 18 } : undefined,
    // Linux: an AppImage started straight from a folder has no installed
    // .desktop file to take its icon from; without this the window and the
    // task bar show Electron's default icon.
    icon: process.platform === 'linux' ? path.join(__dirname, '..', '..', 'build-resources', 'icon.png') : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  // The renderer holds the whole bridge — reading any folder, deleting on a
  // server, the passwords' use. It must never become a page filo did not
  // write (same guards as syncto).
  const OWN_PAGE = path.join(__dirname, '..', 'renderer', 'index.html');
  win.webContents.setWindowOpenHandler(({ url }) => { openExternalSafely(url); return { action: 'deny' }; });
  // No camera, microphone, notifications, location… : filo asks for none.
  win.webContents.session.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  win.webContents.session.setPermissionCheckHandler(() => false);
  const blockNavigation = (e, url) => {
    let isOwn = false;
    try { isOwn = url.startsWith('file://') && path.normalize(new URL(url).pathname) === path.normalize(OWN_PAGE); } catch (_) {}
    if (!isOwn) { e.preventDefault(); openExternalSafely(url); }
  };
  win.webContents.on('will-navigate', blockNavigation);
  win.webContents.on('will-redirect', blockNavigation);
  win.webContents.on('will-attach-webview', e => e.preventDefault());
  win.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    callback({ responseHeaders: Object.assign({}, details.responseHeaders, {
      'Content-Security-Policy': ["default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'"],
    }) });
  });
  win.loadFile(OWN_PAGE);
  win.once('ready-to-show', () => { win.show(); if (DEV) win.webContents.openDevTools({ mode: 'detach' }); });
  win.webContents.once('did-finish-load', () => setTimeout(checkForUpdate, 1500));

  let resizeTimer = null;
  win.on('resize', () => {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      resizeTimer = null;
      if (!win || win.isDestroyed()) return;
      const [ww, hh] = win.getSize();
      prefs.save({ window: { width: ww, height: hh } });
    }, 400);
  });
  win.on('maximize',   () => send('menu', { action: 'maximized', value: true }));
  win.on('unmaximize', () => send('menu', { action: 'maximized', value: false }));

  // Closing with transfers running: say what happens, let the user choose.
  // On macOS closing the window does not quit filo (the transfers go on, the
  // Dock icon brings the window back); quitting is handled in before-quit.
  win.on('close', e => {
    if (quitting || IS_MAC || !queue || queue.state !== 'running') return;
    if (!confirmQuit()) { e.preventDefault(); return; }
    quitting = true;
  });
  // A window opened again (macOS, Dock) starts disconnected: drop the browsing
  // connection with the old one. The queue keeps running either way.
  win.on('closed', () => {
    win = null;
    if (browser.remote) { try { browser.remote.close(); } catch (_) {} }
    Object.assign(browser, { endpointId: null, remote: null, label: '', ep: null });
  });
}

function buildMenu() {
  const m = action => () => send('menu', { action });
  const template = [
    ...(IS_MAC ? [{ role: 'appMenu' }] : []),
    { label: 'File', submenu: [
      { label: 'Site Manager…', accelerator: 'CmdOrCtrl+S', click: m('sites') },
      { label: 'Quick Connect', accelerator: 'CmdOrCtrl+K', click: m('quick') },
      { label: 'Disconnect', accelerator: 'CmdOrCtrl+D', click: m('disconnect') },
      { type: 'separator' },
      { label: 'Import sites…', click: m('sites-import') },
      { label: 'Export sites…', click: m('sites-export') },
      { type: 'separator' },
      IS_MAC ? { role: 'close' } : { role: 'quit' },
    ] },
    // Without an Edit menu, macOS gives text fields no copy and paste.
    { role: 'editMenu' },
    { label: 'Transfer', submenu: [
      { label: 'Start the queue', accelerator: 'CmdOrCtrl+P', click: m('queue-start') },
      { label: 'Pause the queue', accelerator: 'CmdOrCtrl+Shift+P', click: m('queue-pause') },
      { type: 'separator' },
      { label: 'Retry failed transfers', click: m('queue-retry') },
    ] },
    { label: 'View', submenu: [
      { label: 'Refresh', accelerator: 'F5', click: m('refresh') },
      { label: 'Show hidden files', accelerator: 'CmdOrCtrl+Shift+.', click: m('toggle-hidden') },
      { type: 'separator' },
      { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
      { type: 'separator' },
      { role: 'togglefullscreen' },
      ...(DEV ? [{ role: 'toggleDevTools' }] : []),
    ] },
    { role: 'windowMenu' },
    { role: 'help', submenu: [{ label: 'filo on GitHub', click: () => shell.openExternal(REPO) }] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ── Lifecycle ──────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  prefs = new Prefs(app.getPath('userData')).load();
  const policy = {
    known: (kind, host, port) => prefs.knownHost(kind, host, port),
    remember: (kind, host, port, fp) => { prefs.rememberHost(kind, host, port, fp); log('info', `Remembered the identity of ${host}:${port}: ${fp}`); },
  };
  setHostKeyPolicy(policy);
  setCertPolicy(policy);

  queue = new TransferQueue({
    getEndpoint: resolveEndpoint,
    settings: () => prefs.settings(),
    laneMode: process.env.FILO_LANES === 'inline' ? 'inline' : 'worker',
    remember: (kind, host, port, fp) => prefs.rememberHost(kind, host, port, fp),
    endpointCap: id => { if (!id.startsWith('site:')) return 0; const st = prefs.getSite(id.slice(5)); return st ? st.maxConnections : 0; },
    log,
    store: prefs.queueStore(),
  });
  queue.on('progress', p => send('queue-progress', p));
  queue.on('changed', c => send('queue-changed', c));
  queue.on('state', s => { holdSleep(s === 'running'); send('queue-state', s); });
  queue.on('ask', a => send('queue-ask', a));
  queue.on('ask-closed', id => send('queue-ask-closed', id));
  queue.on('blocked', b => { if (b && b.trust) offerTrust(b.trust); send('queue-blocked', b); });
  queue.on('finished', s => onQueueFinished(s));

  buildMenu();
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

// ⌘Q / Quit with transfers running.
function confirmQuit() {
  const choice = dialog.showMessageBoxSync(win && !win.isDestroyed() ? win : undefined, {
    type: 'warning',
    buttons: ['Quit', 'Cancel'],
    defaultId: 1, cancelId: 1,
    message: 'Transfers are running.',
    detail: 'If you quit now, they stop. The partial files are kept, and the next Start resumes them where they stopped.',
  });
  return choice === 0;
}
app.on('before-quit', e => {
  if (quitting) return;
  if (queue && queue.state === 'running' && !confirmQuit()) { e.preventDefault(); return; }
  quitting = true;
});
app.on('will-quit', () => {
  try { if (queue) { queue.pause(); queue.closeAll(); } } catch (_) {}
  try { if (browser.remote) browser.remote.close(); } catch (_) {}
});
app.on('window-all-closed', () => { if (!IS_MAC) app.quit(); });

function holdSleep(on) {
  if (on && powerBlockId == null) powerBlockId = powerSaveBlocker.start('prevent-app-suspension');
  if (!on && powerBlockId != null) { try { powerSaveBlocker.stop(powerBlockId); } catch (_) {} powerBlockId = null; }
}

// The queue is empty: phone notification, then — only if nothing failed —
// the action chosen in the title bar (the window runs the 30 s countdown).
let lastFinished = null;   // what the end action is allowed to rely on
function onQueueFinished(summary) {
  lastFinished = { at: Date.now(), clean: !summary.failed && !summary.stopped && !summary.paused };
  const cfg = prefs.ntfy();
  if (cfg.enabled && cfg.topic) {
    notify.sendWithRetry(Object.assign({ server: cfg.server, topic: cfg.topic }, notify.forQueue(summary)))
      .then(r => { if (!r.ok) log('warn', `Phone notification not sent: ${r.error}`); else log('info', 'Phone notification sent'); });
  }
  send('queue-finished', Object.assign({ afterAction: prefs.data.afterAction }, summary));
}

// ── IPC: basics ────────────────────────────────────────────────────────────
ipcMain.handle('get-version', () => appVersion());
ipcMain.handle('init', () => ({
  version: appVersion(),
  platform: process.platform,
  settings: prefs.settings(),
  ntfy: prefs.ntfy(),
  sites: prefs.listSites(),
  siteFolderOrder: prefs.data.siteFolderOrder,
  quickHistory: prefs.data.quickHistory,
  afterAction: prefs.data.afterAction,
  ui: prefs.data.ui,
  home: app.getPath('home'),
  lastLocalDir: prefs.data.lastLocalDir && fs.existsSync(prefs.data.lastLocalDir) ? prefs.data.lastLocalDir : app.getPath('home'),
  vaultAvailable: secrets.available(),
  queueState: queue.state,
  queueCounts: queue.counts(),
  log: logLines.slice(-500),
  existingLabels: EXISTING_LABELS,
}));
ipcMain.handle('save-ui', (_, ui) => { prefs.save({ ui: Object.assign({}, prefs.data.ui, ui || {}) }); return true; });
ipcMain.handle('settings-save', (_, patch) => {
  const s = prefs.saveSettings(patch);
  if (queue) { queue.applyLimits(); if (queue.state === 'running') queue._pump(); }
  return s;
});
ipcMain.handle('after-action-set', (_, v) => { prefs.save({ afterAction: ['none', 'quit', 'sleep', 'shutdown'].includes(v) ? v : 'none' }); return prefs.data.afterAction; });
ipcMain.handle('after-action-run', async (_, action, clean) => {
  // Decided here, not by the window: the last run really ended cleanly, a
  // short while ago, and nothing has started since.
  const ok = clean === true && lastFinished && lastFinished.clean && Date.now() - lastFinished.at < 5 * 60 * 1000 && (!queue || queue.state !== 'running');
  if (!ok) return { ok: false, action, error: 'The queue did not finish cleanly, or a new transfer started.' };
  return power.run(action, { onQuit: () => { quitting = true; setTimeout(() => app.quit(), 200); } });
});
ipcMain.handle('open-external', (_, u) => openExternalSafely(u));
ipcMain.handle('copy-text', (_, t) => { try { clipboard.writeText(String(t == null ? '' : t).slice(0, 2 * 1024 * 1024)); return true; } catch (_) { return false; } });

// ── IPC: ntfy ──────────────────────────────────────────────────────────────
ipcMain.handle('ntfy-save', (_, patch) => prefs.saveNtfy(patch || {}));
ipcMain.handle('ntfy-test', async (_, patch) => {
  const cfg = Object.assign(prefs.ntfy(), patch || {});
  return notify.send({ server: cfg.server, topic: cfg.topic, title: 'filo test', message: 'Test notification from filo.', tags: 'bell' });
});

// ── IPC: known servers ─────────────────────────────────────────────────────
ipcMain.handle('known-list', () => prefs.listKnownHosts());
ipcMain.handle('known-forget', (_, key) => { prefs.forgetHost(String(key)); return prefs.listKnownHosts(); });
ipcMain.handle('trust', (_, t) => {
  if (!t || !t.kind || !t.host || !t.fingerprint) return false;
  if (!trustOffers.has(offerKey(t))) return false;            // never shown to the user
  // A changed identity is never replaced from here: forget the old one first.
  const pinned = prefs.knownHost(t.kind, t.host, t.port);
  if (pinned && pinned !== t.fingerprint) return false;
  trustOffers.delete(offerKey(t));
  prefs.rememberHost(t.kind, t.host, t.port, t.fingerprint);
  log('info', `Trusted ${t.host}:${t.port}: ${t.fingerprint}`);
  return true;
});

// ── IPC: local side ────────────────────────────────────────────────────────
function absLocal(p) {
  const s = String(p || '');
  if (!path.isAbsolute(s)) throw new Error('Not an absolute path.');
  return path.normalize(s);
}
// "This PC" on Windows: the drive letters, as a folder above every drive root,
// so ".." from C:\ leads to D:, S:… like in the Explorer.
const DRIVES = '::drives';
ipcMain.handle('local-list', async (_, dir) => {
  try {
    if ((dir === DRIVES || /^this pc$/i.test(String(dir || '').trim())) && process.platform === 'win32') {
      const drives = await local.windowsDrives();
      return { ok: true, dir: DRIVES, parent: null, sep: '\\', drives: true,
        entries: drives.map(d => ({ name: d.path.slice(0, 2), type: 'folder', size: 0, mtime: d.mtime || 0, drive: d.path, slow: !!d.slow })) };
    }
    let d = String(dir || '');
    // "D:" typed alone means the root of D:, not "the current folder of D:".
    if (process.platform === 'win32' && /^[a-z]:$/i.test(d)) d += '\\';
    d = absLocal(d);
    const entries = await local.list(d);
    prefs.data.lastLocalDir = d;
    const up = path.dirname(d) !== d ? path.dirname(d) : (process.platform === 'win32' ? DRIVES : null);
    return { ok: true, dir: d, parent: up, sep: path.sep, entries };
  } catch (e) { return { ok: false, error: e.code === 'ENOENT' ? 'This folder does not exist.' : e.code === 'EACCES' || e.code === 'EPERM' ? 'filo is not allowed to read this folder.' : e.message }; }
});
ipcMain.handle('local-roots', () => local.roots());
ipcMain.handle('local-mkdir', async (_, dir, name) => {
  try {
    const bad = badLocalName(name);
    if (bad) return { ok: false, error: bad };
    const n = safeLocalName(name);
    const p = path.join(absLocal(dir), n);
    await fs.promises.mkdir(p);
    return { ok: true, path: p };
  } catch (e) { return { ok: false, error: e.code === 'EEXIST' ? 'Something with that name is already there.' : e.message }; }
});
// A name the disk would not take as typed: said plainly, as the Finder and
// Explorer do, instead of quietly changing it.
function badLocalName(name) {
  const n = String(name || '');
  if (!n.trim()) return 'Enter a name.';
  if (n.includes('/') || n === '.' || n === '..') return 'A name cannot contain "/", or be "." or "..".';
  if (safeLocalName(n) !== n) {
    return process.platform === 'win32'
      ? 'Windows does not accept this name: no \\ : * ? " < > |, no dot or space at the end, and not a reserved name (CON, NUL, COM1…).'
      : 'This name cannot be used on this disk.';
  }
  return null;
}
ipcMain.handle('local-rename', async (_, from, toName) => {
  try {
    const f = absLocal(from);
    const bad = badLocalName(toName);
    if (bad) return { ok: false, error: bad };
    const t = path.join(path.dirname(f), String(toName));
    // Only the case changes (clip.mov → CLIP.mov): on macOS and Windows the
    // disk sees the same name, which is not "already there".
    const caseOnly = t.toLowerCase() === f.toLowerCase() && t !== f;
    if (!caseOnly && fs.existsSync(t)) return { ok: false, error: 'Something with that name is already there.' };
    await fs.promises.rename(f, t);
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});
// To the Trash / Recycle Bin, never straight to oblivion.
ipcMain.handle('local-delete', async (_, paths) => {
  const errors = [];
  for (const p of paths || []) {
    try { await shell.trashItem(absLocal(p)); } catch (e) { errors.push(`${path.basename(String(p))}: ${e.message}`); }
  }
  return { ok: !errors.length, errors };
});
ipcMain.handle('local-reveal', (_, p) => { try { shell.showItemInFolder(absLocal(p)); return true; } catch (_) { return false; } });
ipcMain.handle('local-open', async (_, p) => { try { const r = await shell.openPath(absLocal(p)); return r ? { ok: false, error: r } : { ok: true }; } catch (e) { return { ok: false, error: e.message }; } });
ipcMain.handle('local-pick-folder', async (_, start) => {
  const res = await dialog.showOpenDialog(win, { title: 'Choose a folder', defaultPath: start || undefined, properties: ['openDirectory', 'createDirectory'] });
  return res.canceled || !res.filePaths.length ? null : res.filePaths[0];
});
ipcMain.handle('local-pick-key', async () => {
  const res = await dialog.showOpenDialog(win, { title: 'Choose a private key', properties: ['openFile', 'showHiddenFiles'], defaultPath: path.join(app.getPath('home'), '.ssh') });
  return res.canceled || !res.filePaths.length ? null : res.filePaths[0];
});
ipcMain.handle('local-stat-many', async (_, paths) => {
  const out = [];
  for (const p of paths || []) {
    try { const st = await fs.promises.stat(absLocal(p)); out.push({ path: p, type: st.isDirectory() ? 'folder' : 'file', size: st.size, mtime: st.mtimeMs }); }
    catch (_) {}
  }
  return out;
});

// ── IPC: connecting ────────────────────────────────────────────────────────
// req: { siteId } or { quick: { protocol, host, port, user } }
//      + password (typed now), savePassword, acceptFingerprint
ipcMain.handle('connect', async (_, req) => {
  let endpointId, site = null;
  try {
    if (req.siteId) {
      site = prefs.getSite(req.siteId);
      if (!site) return { ok: false, error: 'This site no longer exists.' };
      endpointId = 'site:' + site.id;
    } else if (req.quick) {
      let q = Object.assign({}, req.quick);
      // A pasted address in the host field: sftp://user@host:2222/path
      const u = parseUrl(q.host);
      if (u) { q = Object.assign(q, { protocol: u.protocol, host: u.host, port: q.port || u.port, user: q.user || u.user }); if (u.password && !req.password) req.password = u.password; req.startDir = u.path; }
      q.host = String(q.host || '').trim();
      if (!q.host) return { ok: false, error: 'Enter a server address.' };
      // What is left must be a bare host name or address. Anything else is an
      // address filo could not read (a password with "@" or "/" in it, say):
      // refused before it can reach the log, without repeating it.
      if (/:\/\/|[@/\\\s]/.test(q.host)) return { ok: false, error: 'This address cannot be read. Type the server name in Host, and the user name and password in their own fields.' };
      if (!LABEL[q.protocol]) q.protocol = 'sftp';
      q.port = Number(q.port) || DEFAULT_PORT[q.protocol];
      q.user = String(q.user || '').trim();
      endpointId = quickId(q);
      quickEndpoints.set(endpointId, { protocol: q.protocol, host: q.host, port: q.port, user: q.user });
    } else return { ok: false, error: 'Nothing to connect to.' };

    if (req.password !== undefined && req.password !== null && req.password !== '') {
      const m = memSecrets.get(endpointId) || {};
      if (site && site.logon === 'key') m.passphrase = req.password; else m.password = req.password;
      memSecrets.set(endpointId, m);
    }
    const ep = await resolveEndpoint(endpointId);
    const remote = createRemote(Object.assign({}, ep, { acceptFingerprint: req.acceptFingerprint || null }), { log });
    log('info', `Connecting to ${describe(ep)}…`);
    await remote.connect();

    // Connected: the new connection replaces the old one.
    if (browser.remote) { try { browser.remote.close(); } catch (_) {} }
    Object.assign(browser, { endpointId, remote, label: ep.label || describe(ep), ep });

    if (site && req.savePassword && req.password && site.logon === 'normal') {
      const blob = secrets.encrypt(req.password);
      if (blob) prefs.saveSite({ id: site.id }, { passwordEnc: blob });
    }
    prefs.pushQuick(site ? { siteId: site.id } : quickEndpoints.get(endpointId));
    let home = '/';
    try { home = await remote.home(); } catch (_) {}
    let startDir = (site && site.remoteDir) || req.startDir || home;
    let algos = [];
    try { algos = await remote.hashAlgos(); } catch (_) {}
    return {
      ok: true, endpointId, label: browser.label, protocol: ep.protocol, secure: remote.secure,
      // Shown in the title bar: who and where, never a password.
      address: `${ep.user ? ep.user + '@' : ''}${String(ep.host || '').includes(':') ? `[${ep.host}]` : ep.host}:${Number(ep.port) || DEFAULT_PORT[ep.protocol]}`,
      url: describe(ep),
      host: ep.host, port: Number(ep.port) || DEFAULT_PORT[ep.protocol], user: ep.user || '',
      home, startDir, serverHash: algos, canSetMTime: !!remote.canSetMTime,
      localDir: site && site.localDir && fs.existsSync(site.localDir) ? site.localDir : null,
      quickHistory: prefs.data.quickHistory,
    };
  } catch (e) {
    const r = errOut(e);
    // A refused login: the password (or passphrase) typed for it was wrong.
    // Forget it, so the next attempt asks again, or uses the saved one.
    if (endpointId && /refused the login|private key cannot be read/i.test(r.error)) {
      const m = memSecrets.get(endpointId);
      if (m) { delete m.password; delete m.passphrase; }
    }
    log(r.code === 'TRUST_NEEDED' || r.needsPassword ? 'info' : 'error', r.error.split('\n')[0]);
    return r;
  }
});

ipcMain.handle('disconnect', async () => {
  if (browser.remote) { try { await browser.remote.close(); } catch (_) {} log('info', `Disconnected from ${browser.label}`); }
  Object.assign(browser, { endpointId: null, remote: null, label: '', ep: null });
  return true;
});

ipcMain.handle('quick-clear', () => { prefs.clearQuick(); return []; });

// The queue was blocked on a password (a quick connection after a restart, a
// site set to "ask"): the window collects it and the queue starts again.
ipcMain.handle('endpoint-password', (_, endpointId, password) => {
  const m = memSecrets.get(endpointId) || {};
  const site = endpointId.startsWith('site:') ? prefs.getSite(endpointId.slice(5)) : null;
  if (site && site.logon === 'key') m.passphrase = password; else m.password = password;
  memSecrets.set(endpointId, m);
  // A quick connection forgotten by a restart: rebuild it from the id.
  if (endpointId.startsWith('quick:') && !quickEndpoints.has(endpointId)) {
    const mm = /^quick:([^:]+):(.*)@(.+):(\d+)$/.exec(endpointId);
    if (mm) quickEndpoints.set(endpointId, { protocol: mm[1], user: mm[2], host: mm[3], port: Number(mm[4]) });
  }
  return true;
});

// ── IPC: remote side ───────────────────────────────────────────────────────
function remotePath(p) {
  const s = String(p || '/');
  return posix.normalize(s.startsWith('/') ? s : '/' + s);
}
ipcMain.handle('remote-list', async (_, dir) => {
  try {
    const d = remotePath(dir);
    const entries = await withBrowser(r => r.list(d));
    return { ok: true, dir: d, parent: d === '/' ? null : posix.dirname(d), entries };
  } catch (e) { return errOut(e); }
});
ipcMain.handle('remote-mkdir', async (_, dir, name) => {
  try {
    if (/[/]/.test(name)) return { ok: false, error: 'A name cannot contain "/".' };
    const p = posix.join(remotePath(dir), String(name));
    await withBrowser(r => r.mkdir(p));
    return { ok: true, path: p };
  } catch (e) { return errOut(e); }
});
ipcMain.handle('remote-rename', async (_, from, toName) => {
  try {
    if (/[/]/.test(toName)) return { ok: false, error: 'A name cannot contain "/".' };
    const f = remotePath(from);
    const t = posix.join(posix.dirname(f), String(toName));
    const sess = browserSession();
    if (await withBrowser(r => r.stat(t), sess)) return { ok: false, error: 'Something with that name is already there.' };
    await withBrowser(r => r.rename(f, t), sess);
    return { ok: true };
  } catch (e) { return errOut(e); }
});
// Every delete in progress (several can run): Cancel stops them all.
const deleteTokens = new Set();
ipcMain.handle('remote-delete', async (_, items) => {
  const deleteToken = { cancelled: false };
  deleteTokens.add(deleteToken);
  const sess = browserSession();
  const errors = [];
  let n = 0;
  for (const it of items || []) {
    const p = remotePath(it.path);
    if (p === '/') { errors.push('The root folder cannot be deleted.'); continue; }
    try {
      if (deleteToken.cancelled) break;
      if (it.type === 'folder') n += await withBrowser(r => deleteRemoteTree(r, p, deleteToken, f => { sameServer(sess); send('delete-progress', { path: f }); }), sess);
      else { await withBrowser(r => r.unlink(p), sess); n++; }
      log('info', `Deleted ${p}`);
    } catch (e) {
      errors.push(`${posix.basename(p)}: ${RemoteError.from(e).message}`);
      if (e && e.code === 'SERVER_CHANGED') break;
    }
  }
  deleteTokens.delete(deleteToken);
  return { ok: !errors.length, count: n, errors };
});
ipcMain.handle('remote-delete-cancel', () => { for (const t of deleteTokens) t.cancelled = true; return true; });
ipcMain.handle('remote-url', (_, p) => {
  if (!browser.ep) return '';
  return describe(browser.ep) + remotePath(p).split('/').map(encodeURIComponent).join('/');
});

// ── IPC: the queue ─────────────────────────────────────────────────────────
// req: { dir: 'up'|'down', sources: [{ path, type, size, mtime }], target, start, existing }
// Folders are walked here and become one item per file, plus one per folder
// so that empty folders arrive too.
let scanToken = null;
ipcMain.handle('queue-add', async (_, req) => {
  const endpointId = req.endpointId || browser.endpointId;
  if (!endpointId) return { ok: false, error: 'Connect to a server first.' };
  const label = endpointLabel(endpointId);
  scanToken = { cancelled: false };
  const token = scanToken;
  const specs = [];
  const base = { endpointId, endpointLabel: label, existing: req.existing || null };
  const scanSess = { endpointId };
  let found = 0, lastSent = 0;
  const tick = () => { found++; const now = Date.now(); if (now - lastSent > 200) { lastSent = now; send('scan-progress', { found }); } };
  const revived = [];
  let already = 0, queued = 0, conflict = 0;
  const flush = () => {
    if (!specs.length) return;
    const r = queue.add(specs.splice(0), { front: !!req.front });
    revived.push(...(r.revived || [])); already += r.already || 0; queued += r.queued || 0; conflict += r.conflict || 0;
  };
  try {
    if (req.dir === 'up') {
      const target = remotePath(req.target);
      for (const s of req.sources || []) {
        const src = absLocal(s.path);
        const name = path.basename(src);
        const st = await fs.promises.stat(src);
        if (st.isDirectory()) {
          const root = posix.join(target, name);
          specs.push(Object.assign({ dir: 'up', type: 'folder', local: src, remote: root }, base));
          await local.walk(src, e => {
            specs.push(Object.assign({ dir: 'up', type: e.type, local: e.path, remote: posix.join(root, e.rel), size: e.size || 0 }, base));
            tick();
            if (specs.length >= 500) flush();
          }, token);
        } else {
          specs.push(Object.assign({ dir: 'up', type: 'file', local: src, remote: posix.join(target, name), size: st.size }, base));
          tick();
        }
      }
    } else {
      const target = absLocal(req.target);
      for (const s of req.sources || []) {
        const src = remotePath(s.path);
        const name = posix.basename(src);
        if (s.type === 'folder') {
          const root = path.join(target, safeLocalName(name));
          specs.push(Object.assign({ dir: 'down', type: 'folder', local: root, remote: src }, base));
          await withBrowser(r => walkRemote(r, src, e => {
            sameServer(scanSess);
            specs.push(Object.assign({ dir: 'down', type: e.type, local: localJoin(root, e.rel), remote: e.path, size: e.size || 0 }, base));
            tick();
            if (specs.length >= 500) flush();
          }, token), scanSess);
        } else {
          specs.push(Object.assign({ dir: 'down', type: 'file', local: path.join(target, safeLocalName(name)), remote: src, size: s.size || 0 }, base));
          tick();
        }
      }
    }
    if (token.cancelled) { return { ok: false, cancelled: true }; }
    flush();
    send('scan-progress', { found, done: true });
    // Paused while the folders were being listed: what was found stays queued.
    // Nothing new to do (everything was already queued, or waits for the
    // "resume or start again?" answer): no empty run, no "finished" notice.
    if (req.start !== false && !token.noStart && queued) queue.start();
    return { ok: true, count: found, revived: revived.slice(0, 5000), already, conflict };
  } catch (e) {
    flush();
    send('scan-progress', { found, done: true });
    return errOut(e);
  }
});
ipcMain.handle('scan-cancel', () => { if (scanToken) scanToken.cancelled = true; return true; });
ipcMain.handle('queue-start', () => { queue.start(); return queue.state; });
ipcMain.handle('queue-pause', () => { if (scanToken) scanToken.noStart = true; queue.pause(); return queue.state; });
// Stop everything also stops a folder listing still adding files.
ipcMain.handle('queue-stop-all', () => { if (scanToken) scanToken.cancelled = true; queue.stopAll(); return queue.state; });
ipcMain.handle('queue-item-pause', (_, ids) => { queue.pauseItems(ids || []); return true; });
ipcMain.handle('queue-item-resume', (_, ids) => { queue.resumeItems(ids || []); return true; });
ipcMain.handle('queue-item-stop', (_, ids) => { queue.stopItems(ids || []); return true; });
ipcMain.handle('queue-remove', (_, ids) => { queue.remove(ids || []); return queue.counts(); });
ipcMain.handle('queue-retry', (_, ids, mode) => { queue.retry(ids || [], mode === 'restart' ? 'restart' : 'resume'); return queue.counts(); });
ipcMain.handle('queue-clear', (_, tab) => { queue.clear(tab); return queue.counts(); });
ipcMain.handle('queue-page', (_, tab, offset, limit) => queue.page(tab, offset, limit));
ipcMain.handle('queue-answer', (_, askId, rule, all) => queue.answer(askId, rule, !!all));
ipcMain.handle('queue-reveal', (_, id) => {
  const it = queue.get(id);
  if (!it) return false;
  try { shell.showItemInFolder(fs.existsSync(it.local) ? it.local : path.dirname(it.local)); } catch (_) {}
  return true;
});

// ── IPC: sites ─────────────────────────────────────────────────────────────
ipcMain.handle('sites-list', () => ({ sites: prefs.listSites(), vaultAvailable: secrets.available() }));
// site from the window; password: string to store, '' to forget, undefined to keep.
ipcMain.handle('sites-save', (_, site, password, passphrase) => {
  try {
    const patch = {};
    let warn = null;
    if (password !== undefined && password !== null) {
      if (password === '') patch.passwordEnc = null;
      else {
        const blob = secrets.encrypt(password);
        if (blob) patch.passwordEnc = blob;
        else warn = 'This machine has no keychain filo can use: the password was not saved and will be asked at each connection.';
      }
    }
    if (passphrase !== undefined && passphrase !== null) {
      patch.passphraseEnc = passphrase === '' ? null : secrets.encrypt(passphrase);
    }
    const saved = prefs.saveSite(site, patch);
    return { ok: true, site: saved, sites: prefs.listSites(), warn };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('sites-arrange', (_, list, folderOrder) => ({ sites: prefs.arrangeSites(list, folderOrder), siteFolderOrder: prefs.data.siteFolderOrder }));
ipcMain.handle('sites-delete', (_, id) => { prefs.deleteSite(id); memSecrets.delete('site:' + id); return prefs.listSites(); });
ipcMain.handle('sites-duplicate', (_, id) => {
  const s = prefs.getSite(id);
  if (!s) return prefs.listSites();
  const copy = Object.assign({}, s, { id: null, name: s.name + ' (copy)' });
  prefs.saveSite(copy, { passwordEnc: s.passwordEnc, passphraseEnc: s.passphraseEnc });
  return prefs.listSites();
});
// Turns a quick connection into a site, password included if one was typed.
ipcMain.handle('sites-from-quick', (_, q, name) => {
  const site = prefs.saveSite({ name: name || q.host, protocol: q.protocol, host: q.host, port: q.port, user: q.user, logon: q.user ? 'normal' : 'anonymous' }, {});
  const mem = memSecrets.get(quickId(q));
  if (mem && mem.password) { const blob = secrets.encrypt(mem.password); if (blob) prefs.saveSite({ id: site.id }, { passwordEnc: blob }); }
  return { site, sites: prefs.listSites() };
});

ipcMain.handle('sites-import', async (_, withPasswords) => {
  const res = await dialog.showOpenDialog(win, {
    title: 'Import sites',
    filters: [{ name: 'filo or FileZilla sites', extensions: ['json', 'xml'] }],
    properties: ['openFile'],
  });
  if (res.canceled || !res.filePaths.length) return { ok: false, cancelled: true };
  try {
    const text = fs.readFileSync(res.filePaths[0], 'utf8');
    const fmt = sites.detectFormat(text);
    if (!fmt) return { ok: false, error: 'This file is neither a filo export nor a FileZilla sitemanager.xml.' };
    const list = fmt === 'filo' ? sites.importFilo(text) : sites.importFileZilla(text);
    let withPw = 0, lockedPw = 0;
    for (const { site, password, passwordEncrypted } of list) {
      const patch = {};
      if (withPasswords && password) { const blob = secrets.encrypt(password); if (blob) { patch.passwordEnc = blob; withPw++; } }
      if (passwordEncrypted) lockedPw++;
      prefs.saveSite(Object.assign({}, site, { id: null }), patch);
    }
    log('info', `Imported ${list.length} site(s) from ${path.basename(res.filePaths[0])}`);
    return { ok: true, count: list.length, withPasswords: withPw, lockedPasswords: lockedPw, format: fmt, sites: prefs.listSites() };
  } catch (e) { return { ok: false, error: 'This file could not be read: ' + e.message }; }
});

ipcMain.handle('sites-export', async (_, format, ids) => {
  const fz = format === 'filezilla';
  const res = await dialog.showSaveDialog(win, {
    title: 'Export sites',
    defaultPath: fz ? 'filo-sites-filezilla.xml' : 'filo-sites.json',
    filters: [fz ? { name: 'FileZilla sitemanager', extensions: ['xml'] } : { name: 'filo sites', extensions: ['json'] }],
  });
  if (res.canceled || !res.filePath) return { ok: false, cancelled: true };
  const list = (ids && ids.length ? prefs.data.sites.filter(s => ids.includes(s.id)) : prefs.data.sites);
  try {
    fs.writeFileSync(res.filePath, fz ? sites.exportFileZilla(list) : sites.exportFilo(list));
    return { ok: true, count: list.length, path: res.filePath };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ── IPC: window chrome ─────────────────────────────────────────────────────
ipcMain.on('win-minimize', () => win && win.minimize());
ipcMain.on('win-maximize', () => { if (!win) return; win.isMaximized() ? win.unmaximize() : win.maximize(); });
ipcMain.on('win-close',    () => win && win.close());
