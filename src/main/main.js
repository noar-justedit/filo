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

const { app, BrowserWindow, ipcMain, dialog, shell, Menu, powerSaveBlocker, clipboard, Tray, nativeImage } = require('electron');
const path  = require('path');
const posix = path.posix;
const fs    = require('fs');
const https = require('https');

const { Prefs } = require('./config');
const secrets = require('./secrets');
const power   = require('./power');
const notify  = require('./notify');
const hook    = require('./core/hook');
const local   = require('./proto/local');
const { createRemote, parseUrl, describe, DEFAULT_PORT, LABEL } = require('./proto');
const { setHostKeyPolicy } = require('./proto/sftp');
const { setCertPolicy } = require('./proto/ftp');
const { TransferQueue } = require('./core/queue');
const SYNC = require('./syncer');
const { Syncer } = SYNC;
const { DEFAULT_SYNC_EXCLUDE } = require('./config');
const { createDirect } = require('./direct-app');
const { RemoteError } = require('./core/errors');
const { walkRemote, deleteRemoteTree, safeLocalName, localJoin } = require('./core/scan');
const sites = require('./core/sites');
const netid = require('./core/netid');
const { runSpeedTest } = require('./core/speedtest');
const { LABELS: EXISTING_LABELS, ACTIONS: EXISTING_ACTIONS } = require('./core/existing');

const IS_MAC = process.platform === 'darwin';
const DEV    = process.argv.includes('--dev') && !app.isPackaged;   // never in a shipped build
// The Rust transfer engine ships next to the app (electron-builder
// extraResources); the transfer threads find it through this variable.
if (app.isPackaged && !process.env.FILO_ENGINE_PATH) {
  process.env.FILO_ENGINE_PATH = require('path').join(process.resourcesPath, process.platform === 'win32' ? 'filo-engine.exe' : 'filo-engine');
}
// SYNCTHING: Syncthing ships next to the app, in resources/syncthing/.
if (app.isPackaged && !process.env.FILO_SYNCTHING_PATH) {
  process.env.FILO_SYNCTHING_PATH = require('path').join(process.resourcesPath, 'syncthing', process.platform === 'win32' ? 'syncthing.exe' : 'syncthing');
}
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
let syncer = null;
let D = null;            // SYNCTHING (direct-app.js)
let directStopped = false;
let powerBlockId = null;
let quitting = false;

// ── Started as a command (`filo upload …`, see cli.js and docs/CLI.md) ──────
// Then this process opens no window: it hands the command to the running filo
// (starting it if needed), prints what happens, and ends with an exit code.
const CLI = require('./cli');
const cliReq = CLI.parse(process.argv.slice(app.isPackaged ? 1 : 2));
const BACKGROUND = process.argv.includes('--background');
if (cliReq) {
  if (app.dock) app.dock.hide();
  app.disableHardwareAcceleration();
  const write = l => { try { process.stdout.write(String(l).replace(/\n?$/, '\n')); } catch (_) {} };
  CLI.client(cliReq, {
    userData: app.getPath('userData'), version: appVersion(), write,
    spawnApp: bg => {
      const args = app.isPackaged ? [] : [app.getAppPath()];
      if (bg) args.push('--background');
      if (process.argv.includes('--no-sandbox')) args.push('--no-sandbox');   // Linux, started that way
      require('child_process').spawn(process.execPath, args, { detached: true, stdio: 'ignore' }).unref();
    },
  }).then(code => app.exit(code)).catch(e => { write('filo: ' + e.message); app.exit(4); });
  return;   // eslint-disable-line no-unreachable -- the rest is the application
}

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
// cannot pin a fingerprint of its own making. One exception, on purpose: a
// config file the user imports carries its server's identity, shown in the
// import dialog ("given by the file") and trusted when they confirm it
// (serverImport); a different one already trusted here is refused.
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
  // Never below the minimum (a size saved by an older version in the ring alone).
  const w = Math.max(1100, (prefs.data.window && prefs.data.window.width) || 1360);
  const h = Math.max(680, (prefs.data.window && prefs.data.window.height) || 880);
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
    try { isOwn = url.startsWith('file://') && path.normalize(require('url').fileURLToPath(url.split('#')[0])) === path.normalize(OWN_PAGE); } catch (_) {}
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
  win.once('ready-to-show', () => {
    // Started by a command with --background: there, but out of the way.
    if (BACKGROUND) { win.showInactive(); win.minimize(); } else win.show();
    if (DEV) win.webContents.openDevTools({ mode: 'detach' });
  });
  win.webContents.once('did-finish-load', () => setTimeout(checkForUpdate, 1500));

  let resizeTimer = null;
  win.on('resize', () => {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      resizeTimer = null;
      if (!win || win.isDestroyed() || miniPrev) return;   // the ring alone is not the window's size
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
    miniPrev = null;                // a new window starts full size
    if (browser.remote) { try { browser.remote.close(); } catch (_) {} }
    Object.assign(browser, { endpointId: null, remote: null, label: '', ep: null });
  });
}

function buildMenu() {
  const m = action => () => send('menu', { action });
  const template = [
    ...(IS_MAC ? [{ label: app.name, submenu: [
      { role: 'about' }, { type: 'separator' },
      { label: 'Settings…', accelerator: 'Cmd+,', click: m('settings') },
      { label: 'Install the command line tool…', click: m('cli-install') },
      { type: 'separator' }, { role: 'services' }, { type: 'separator' },
      { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' },
    ] }] : []),
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
  // Which network this is, for the speed profiles (read again every minute).
  netid.refresh(); setInterval(() => netid.refresh(), 60000).unref();
  if (prefs.recovered === 'bak') log('warn', 'preferences.json could not be read: the copy saved at the last start was taken back (the damaged file is kept next to it, .corrupt).');
  else if (prefs.recovered === 'lost') log('error', 'preferences.json could not be read and no copy was there: filo starts empty (the damaged file is kept next to it, .corrupt).');
  prefs.onError = m => log('error', m);
  // Nothing connects at launch without the user (Noar, 14/10/2026): every
  // LIVE SYNC session (S-FTP, SYNCTHING and its S-FTP BACKUP) starts
  // DISCONNECTED, CONNECT starts it; Syncthing itself is not started before.
  for (const p of prefs.listSyncPairs()) {
    if (!p.auto && !p.fsAuto) continue;
    prefs.saveSyncPair(Object.assign({}, p, { auto: false, fsAuto: false }));
    log('info', `LIVE SYNC “${p.name}”: not reconnected at launch (CONNECT to start it)`);
  }
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
    // The speed test of a site (0.8.0), on the network it was measured on only.
    speedProfile: (id, dir) => {
      if (!id.startsWith('site:')) return null;
      const st = prefs.getSite(id.slice(5)), sp = st && st.speed;
      if (!sp || !sp.net || sp.net !== netid.current()) return null;
      return sp[dir === 'up' ? 'out' : 'in'] || null;
    },
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
  queue.on('finished', s => onQueueFinished(s).catch(e => log('error', 'After the queue: ' + e.message)));

  syncer = new Syncer({
    prefs, queue, log,
    directFirst: pair => (D ? D.directFirst(pair) : false),
    mirrorReady: pair => (D ? D.mirrorReady(pair) : false),
    // FAILSAFE: the MASTER's settings on the server, and the SLAVE taking them.
    sessionFile: pair => (D ? D.sessionFile(pair) : null),
    onSession: (pair, o) => { if (D) D.takeSession(pair, o, 'from the server'); },
    hostName: () => require('./direct').hostName(),
    resolveEndpoint,
    createRemote: ep => createRemote(ep, { log }),
    dir: path.join(app.getPath('userData'), 'sync'),
  });
  syncer.on('status', id => { const p = prefs.getSyncPair(id); if (!p || p.via !== 'direct') send('sync-status', { id, status: statusFor(id) }); });
  D = createDirect({
    prefs, log, send, home: path.join(app.getPath('userData'), 'direct'),
    onStatus: id => send('sync-status', { id, status: statusFor(id) }),
    // A hybrid pair lost the other filo: its S-FTP failsafe takes over at once.
    onFailover: id => {
      const p = prefs.getSyncPair(id);
      if (!p || p.via !== 'hybrid' || !p.fsAuto) return;      // FAILSAFE switched off: nothing goes by the server
      log('info', `LIVE SYNC “${p.name}”: the other computer is not reachable, the S-FTP BACKUP takes over`);
      syncer.holdMirror(id, false);                          // mirror copies held for SYNCTHING: they go on
      setTimeout(() => syncer.run(id, 'failsafe'), 2000);
    },
    // DUAL SYNC: SYNCTHING has finished, the MASTER mirrors its folder on the
    // server; SYNCTHING busy again, the mirror's copies wait.
    onMirror: id => { const p = prefs.getSyncPair(id); if (p && p.via === 'hybrid' && p.role !== 'slave' && p.fsAuto) syncer.run(id, 'mirror'); },
    onBusy: (id, on) => { syncer.holdMirror(id, on); if (on) syncer.staleMirror(id); },
    serverShare: pair => shareOf(pair),
    serverImport,
    // A SLAVE took new settings from its MASTER: another direction means what
    // the S-FTP part remembered no longer applies.
    onPairChanged: (pair, was) => { if (was && was.direction !== pair.direction) syncer.forgetState(pair.id); syncer.apply(pair, { runNow: false }); },
  });
  // AUTO pairs start a few seconds after the window, not in its way.
  setTimeout(() => { syncer.applyAll(); D.apply(); }, 3000);
  CLI.serve(app.getPath('userData'), handleCli, log);

  buildMenu();
  createWindow();
  createTray();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); else if (win && !win.isVisible()) win.show(); });
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
app.on('will-quit', e => {
  // SYNCTHING: Syncthing closes its database properly before filo goes (a few
  // seconds at most), then the quit goes on.
  if (D && D.running() && !directStopped) {
    e.preventDefault();
    directStopped = true;
    D.stop().catch(() => {}).then(() => app.quit());
    return;
  }
  try { if (syncer) syncer.stopAll(); } catch (_) {}
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
// A real transfer that went faster than the speed test said: the bookmark
// keeps the better figures (never lower ones: a slow disk or a small file
// says nothing against the server). Only a bookmark already tested, on the
// network it was tested on.
function learnSpeed(p) {
  if (!p || !p.endpointId || !p.endpointId.startsWith('site:')) return;
  const st = prefs.getSite(p.endpointId.slice(5));
  if (!st) return;
  const next = sites.learnFromTransfer(st.speed, netid.current(), p.dir, p.conn, p.mbps);
  if (!next) return;
  prefs.saveSite({ id: st.id, speed: next });
  const key = p.dir === 'up' ? 'out' : 'in';
  log('info', `${st.name}: the speed profile (${key === 'out' ? 'send' : 'receive'}) now holds what this transfer reached, ${next[key].mbps} MB/s with ${p.conn} connection${p.conn > 1 ? 's' : ''}`);
}

async function onQueueFinished(summary) {
  try { learnSpeed(summary.profile); } catch (e) { log('warn', 'Speed profile: ' + e.message); }
  if (summary.syncOnly) { send('queue-finished', Object.assign({ afterAction: 'none' }, summary)); return; }
  const cfg = prefs.ntfy();
  if (cfg.enabled && cfg.topic) {
    notify.sendWithRetry(Object.assign({ server: cfg.server, topic: cfg.topic }, notify.forQueue(summary)))
      .then(r => { if (!r.ok) log('warn', `Phone notification not sent: ${r.error}`); else log('info', 'Phone notification sent'); });
  }
  // The command after the queue (Settings), before the end action: a script
  // that copies or encodes must finish before the machine sleeps.
  const st = prefs.data.settings;
  let hookRes = null;
  if (st.hookEnabled && st.hookCommand.trim() && (summary.done || summary.failed)) {
    const since = Date.now() - (summary.durationMs || 0) - 1000;
    const items = queue.page('done', 0, 1e6).items.filter(i => (i.finishedAt || 0) >= since);
    const argv = hook.argvFor(st.hookCommand, hook.varsFor(summary, items));
    log('info', `Command after the queue: ${argv[0]}`);
    send('hook-start', { program: path.basename(argv[0] || '') });
    hookRes = await hook.run(argv);
    log(hookRes.ok ? 'info' : 'warn', hookRes.ok ? 'Command after the queue: done' : `Command after the queue: ${hookRes.error}`);
  }
  lastFinished = { at: Date.now(), clean: !summary.failed && !summary.stopped && !summary.paused };
  send('queue-finished', Object.assign({ afterAction: prefs.data.afterAction, hook: hookRes }, summary));
}
ipcMain.handle('hook-test', async (_, cmd) => {
  const vars = { result: 'ok', done: 3, failed: 0, bytes: 3145728, server: 'sftp://editor@nas.studio.lan:22', local: app.getPath('desktop'), remote: '/homes/editor/TEST', direction: 'up' };
  const argv = hook.argvFor(String(cmd || ''), vars);
  if (!argv.length) return { ok: false, error: 'no command' };
  const r = await hook.run(argv, { timeoutMs: 60000 });
  log(r.ok ? 'info' : 'warn', `Command after the queue (TEST): ${r.ok ? 'done' : r.error}`);
  return Object.assign(r, { argv });
});

// ── LIVE SYNC down: a phone alert (Noar, 12/10/2026) ──────────────────────
// A connected session that cannot work for N minutes (the other computer
// away, the server in error) sends one ntfy alert; once it works again, one
// more saying so. Off unless ticked in Settings › ntfy.
const { SyncAlert } = require('./core/syncalert');
const syncAlert = new SyncAlert();
function checkSyncDown() {
  if (!prefs || !D) return;
  const cfg = prefs.ntfy();
  const on = !!(cfg.enabled && cfg.topic && cfg.syncAlert);
  const list = prefs.listSyncPairs().map(p => ({ pair: p, status: statusFor(p.id) }));
  for (const a of syncAlert.step(list, Date.now(), (cfg.syncAlertMin || 10) * 60000, on)) {
    const down = a.kind === 'down';
    notify.sendWithRetry({
      server: cfg.server, topic: cfg.topic,
      title: `filo LIVE SYNC: ${a.pair.name} ${down ? 'is down' : 'works again'}`,
      message: down ? `${a.reason}, for ${a.minutes} min.` : `Back after ${a.minutes} min (${a.reason}).`,
      tags: down ? 'warning' : 'white_check_mark', priority: down ? 4 : 3,
    }).then(r => log(r.ok ? 'info' : 'warn', r.ok ? `LIVE SYNC “${a.pair.name}”: phone alert sent (${down ? a.reason : 'works again'})` : `Phone alert not sent: ${r.error}`));
  }
}
setInterval(() => { try { checkSyncDown(); } catch (e) { log('warn', 'LIVE SYNC alert: ' + e.message); } }, 30000).unref();

// ── IPC: LIVE SYNC ─────────────────────────────────────────────────────────
// A pair's status for the window. Hybrid (SYNCTHING FAILSAFE): the
// SYNCTHING status, with the S-FTP one under `server`.
function statusFor(id) {
  const p = prefs.getSyncPair(id);
  if (!p) return {};
  if (p.via === 'direct') return D.statusOf(id);
  if (p.via === 'hybrid') return Object.assign({}, D.statusOf(id), { server: syncer.statusOf(id) });
  return syncer.statusOf(id);
}
const allSyncStatus = () => { const o = {}; for (const p of prefs.listSyncPairs()) o[p.id] = statusFor(p.id); return o; };
// An IPC answer is always { ok, error } when something goes wrong, never a
// thrown exception (the window shows the message).
const guard = fn => async (...a) => { try { return await fn(...a); } catch (e) { log('error', e.message); return { ok: false, error: e.message }; } };
ipcMain.handle('sync-list', () => ({ pairs: prefs.listSyncPairs(), status: allSyncStatus(), defaultExclude: DEFAULT_SYNC_EXCLUDE, direct: { available: D.direct.available, pending: D.pending() } }));
ipcMain.handle('sync-save', guard((_, pair) => {
  const prev = pair && pair.id ? prefs.getSyncPair(pair.id) : null;
  const p = D.prepareSave(pair);
  if (p.via === 'server') {
    const dir = absLocal(p.local);
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error('Choose an existing local folder.');
    p.local = dir;
  }
  const saved = prefs.saveSyncPair(p);
  // Other folders or another server: what was remembered no longer applies.
  if (prev && (prev.local !== saved.local || prev.remote !== saved.remote || prev.siteId !== saved.siteId || prev.direction !== saved.direction || prev.via !== saved.via)) syncer.forgetState(saved.id);
  syncer.apply(saved);
  if (saved.via !== 'server' || (prev && prev.via !== 'server')) D.apply();
  return { ok: true, pair: saved, pairs: prefs.listSyncPairs(), status: allSyncStatus() };
}));
ipcMain.handle('sync-delete', guard((_, id) => {
  // Only a session that exists: its id names a file (review 0.7.2).
  const prev = prefs.getSyncPair(String(id || ''));
  if (!prev) return { ok: false, error: 'This session is no longer there.', pairs: prefs.listSyncPairs(), status: allSyncStatus() };
  id = prev.id;
  syncer.unschedule(id);
  syncer.forgetState(id);
  // Its copies held for SYNCTHING would wait forever: stopped (review 0.6.2).
  if (prev && prev.via === 'hybrid') syncer.stopPairItems(id);
  prefs.deleteSyncPair(id);
  if (prev && prev.via !== 'server') {
    // Its control folder (MASTER → SLAVE settings) goes with it, once
    // Syncthing has let go of it.
    D.apply().then(() => { if (prev.folderId) { try { fs.rmSync(D.direct.ctlDir(prev), { recursive: true, force: true }); } catch (_) {} } });
  }
  return { ok: true, pairs: prefs.listSyncPairs(), status: allSyncStatus() };
}));
ipcMain.handle('sync-run', guard((_, id) => {
  const p = prefs.getSyncPair(String(id));
  if (p && p.via === 'direct') return D.rescan(p);
  if (p && p.via === 'hybrid' && D.directFirst(p) === true) return D.rescan(p);
  return syncer.run(String(id), 'now');
}));
// CONNECT / DISCONNECT a live sync (its AUTO, or SYNCTHING's ON).
// which: 'st' (Syncthing), 'fs' (the S-FTP failsafe) or nothing (all of it).
ipcMain.handle('sync-connect', guard((_, id, on, which) => {
  const p = prefs.getSyncPair(String(id));
  if (!p) return { ok: false, error: 'This live sync no longer exists.' };
  const patch = which === 'st' ? { auto: !!on } : which === 'fs' ? { fsAuto: !!on } : { auto: !!on, fsAuto: !!on };
  const saved = prefs.saveSyncPair(Object.assign({}, p, patch));
  log('info', `LIVE SYNC “${saved.name}”: ${which === 'st' ? 'SYNCTHING ' : which === 'fs' ? 'S-FTP BACKUP ' : ''}${on ? 'connected' : 'disconnected'}`);
  syncer.apply(saved);
  if (saved.via !== 'server') D.apply();
  return { ok: true, pair: saved, pairs: prefs.listSyncPairs(), status: allSyncStatus() };
}));
// This computer's trash of a SYNCTHING session (size; open it).
ipcMain.handle('trash-info', guard((_, id) => { const p = prefs.getSyncPair(String(id)); return p && p.via !== 'server' ? require('./direct-app').trashInfo(p) : null; }));
ipcMain.handle('trash-open', guard(async (_, id) => {
  const p = prefs.getSyncPair(String(id));
  if (!p || p.via === 'server') return { ok: false, error: 'This session has no trash.' };
  const dir = require('./direct-app').trashInfo(p).dir;
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
  const err = await shell.openPath(dir);
  return err ? { ok: false, error: err } : { ok: true };
}));
// FAILSAFE: a session the MASTER left on a server (.filo-session), found by
// the SLAVE from a bookmark and a folder.
ipcMain.handle('sync-remote-session', async (_, siteId, dir) => {
  try {
    const list = await pickConnection(siteId);
    if (pickConn.t) { clearTimeout(pickConn.t); pickConn.t = null; }
    const { readSmall } = require('./core/transfer');
    const text = await readSmall(list, posix.join(dir || '/', SYNC.SESSION_FILE), 200000).catch(() => null);
    pickIdle();
    if (!text) return { ok: false, error: 'No filo session in this folder: the MASTER writes it at its first S-FTP check.' };
    return await readImportText(text);
  } catch (e) { return { ok: false, error: e.message }; }
});

// This computer, for the LIVE SYNC view.
ipcMain.handle('live-info', () => {
  const { hostName, osLabel } = require('./direct');
  const ips = [];
  for (const [name, list] of Object.entries(require('os').networkInterfaces())) {
    for (const a of list || []) if (!a.internal && a.family === 'IPv4' && !/^169\.254\./.test(a.address)) ips.push({ name, address: a.address });
  }
  return { name: hostName(), os: osLabel(), ips, version: app.getVersion() };
});
// The folders of a server, for BROWSE in the S-FTP form. Its own connection
// (never the browsing one), closed after a minute of rest.
const pickConn = { siteId: null, conn: null, t: null, busy: Promise.resolve() };
// One request at a time (two quick clicks never open two connections), and
// the idle timer restarts at each request.
// 0.9.1: the minute of rest counts from the end of the listing, not from its
// start (a slow NAS listing a huge folder was closed under it).
function pickIdle() {
  if (pickConn.t) clearTimeout(pickConn.t);
  pickConn.t = setTimeout(() => { pickConn.t = null; try { if (pickConn.conn) pickConn.conn.close(); } catch (_) {} pickConn.conn = null; }, 60000);
}
function pickConnection(siteId) {
  const job = pickConn.busy.then(async () => {
    if (pickConn.t) { clearTimeout(pickConn.t); pickConn.t = null; }
    if (pickConn.siteId !== siteId || !pickConn.conn) {
      if (pickConn.conn) { try { pickConn.conn.close(); } catch (_) {} }
      pickConn.conn = null;
      const c = createRemote(await resolveEndpoint('site:' + siteId), { log });
      await c.connect();
      pickConn.conn = c; pickConn.siteId = siteId;
    }
    pickIdle();
    return pickConn.conn;
  });
  pickConn.busy = job.catch(() => {});
  return job;
}
ipcMain.handle('sync-remote-list', async (_, siteId, dir) => {
  try {
    const c = await pickConnection(siteId);
    if (pickConn.t) { clearTimeout(pickConn.t); pickConn.t = null; }
    let where = dir;
    if (!where) where = (await c.home().catch(() => '/')) || '/';
    const list = await c.list(where);
    pickIdle();
    const dirs = list.filter(e => e.type === 'folder' || (e.type === 'symlink' && e.linkTo === 'folder')).map(e => e.name).sort((a, b) => a.localeCompare(b));
    return { ok: true, dir: where, dirs };
  } catch (e) {
    if (pickConn.conn) { try { pickConn.conn.close(); } catch (_) {} pickConn.conn = null; }
    const err = e && e.code ? e : RemoteError.from(e);
    return { ok: false, error: err.code === 'NEEDS_PASSWORD' ? 'This bookmark has no saved password: connect to it once from the bar, or save its password in the site manager.' : err.code === 'TRUST_NEEDED' ? 'This server is not trusted yet: connect to it once from the bar and accept its identity.' : (err.message || String(err)) };
  }
});

// ── IPC: SYNCTHING (another filo, peer to peer: direct-app.js) ─────────────────
ipcMain.handle('direct-info', (_, start) => D.info(!!start));
ipcMain.handle('direct-accept', guard((_, dev, share) => Object.assign(D.accept(dev, share), { pairs: prefs.listSyncPairs(), status: allSyncStatus() })));
ipcMain.handle('direct-refuse', guard((_, dev) => D.refuse(dev)));
ipcMain.handle('direct-forget', guard((_, id) => D.forget(String(id))));
ipcMain.handle('direct-offer-accept', guard((_, req) => {
  const r = D.offerAccept(Object.assign({}, req, { local: req && req.local ? absLocal(req.local) : '' }));
  return Object.assign(r, { pairs: prefs.listSyncPairs(), status: allSyncStatus() });
}));
ipcMain.handle('direct-join', guard(async (_, text) => {
  const r = await D.join(String(text || '').slice(0, 400));
  return Object.assign(r, { pairs: prefs.listSyncPairs(), status: allSyncStatus() });
}));
ipcMain.handle('direct-session-id', (_, pairId) => D.sessionId(String(pairId || '')));
ipcMain.handle('direct-join-state', (_, id, folder) => D.joinState(String(id || ''), String(folder || '')));
ipcMain.handle('direct-join-session', guard((_, req) => {
  const r = D.joinSession(Object.assign({}, req, { local: req && req.local ? absLocal(req.local) : '' }));
  return Object.assign(r, { pairs: prefs.listSyncPairs(), status: allSyncStatus() });
}));
ipcMain.handle('direct-offer-dismiss', guard((_, req) => D.offerDismiss(req || {})));
ipcMain.handle('direct-fast', (_, on) => { D.setFast(!!on); return true; });
ipcMain.handle('direct-hold', guard((_, id, on) => D.hold(String(id || ''), !!on)));
// A SYNCTHING ID (this computer's, or a remote one), by mail or in a text file.
ipcMain.handle('direct-id-share', async (_, req) => {
  try {
    const { DEVICE_ID } = require('./config');
    const id = String((req && req.id) || '');
    if (!DEVICE_ID.test(id)) return { ok: false, error: 'This is not a SYNCTHING ID.' };
    const name = String((req && req.name) || '').slice(0, 120);
    const text = `filo SYNCTHING ID${name ? ' of ' + name : ''}:\n${id}\n\n(In filo: right-click LIVE SYNC (side bar) → Sessions… → THIS COMPUTER. It is not a secret: a computer still has to be accepted by hand.)\n`;
    if (req.how === 'email') { shell.openExternal(`mailto:?subject=${encodeURIComponent('filo SYNCTHING ID' + (name ? ' · ' + name : ''))}&body=${encodeURIComponent(text)}`); return { ok: true }; }
    const safe = (name || 'filo').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').trim() || 'filo';
    const res = await dialog.showSaveDialog(win, { title: 'Export the SYNCTHING ID', defaultPath: path.join(app.getPath('desktop'), `${safe} SYNCTHING ID.txt`), filters: [{ name: 'Text', extensions: ['txt'] }] });
    if (res.canceled || !res.filePath) return { ok: false, cancelled: true };
    fs.writeFileSync(res.filePath, text);
    return { ok: true, path: res.filePath };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ── A sync shared between two teams ────────────────────────────────────────
// Team A exports a pair: a small ".filosync" file (or the same thing as a line
// of text, "filo-sync:…", to paste in any chat). It holds the server, the
// server folder, the direction FOR THE OTHER TEAM (A sends, B receives), the
// exclusions, and the server's identity (its fingerprint, as A's filo knows
// it), so B's first connection is checked against it. NEVER a password: B
// types it once at import, and it goes to B's own keychain.
const SHARE_PREFIX = 'filo-sync:';
const OTHER_SIDE = { up: 'down', down: 'up', both: 'both' };
function identityKind(protocol) { return protocol === 'sftp' ? 'sftp' : protocol === 'ftp' ? null : 'ftps'; }
function shareOf(pair) {
  const site = prefs.getSite(pair.siteId);
  if (!site) throw new Error('Choose the site of this live sync first.');
  const port = Number(site.port) || DEFAULT_PORT[site.protocol];
  const kind = identityKind(site.protocol);
  return {
    filo: 'sync', v: 1, name: pair.name,
    server: { protocol: site.protocol, host: site.host, port, user: site.user || '', transferMode: site.transferMode || 'passive', fingerprint: (kind && prefs.knownHost(kind, site.host, port)) || '' },
    remote: pair.remote, direction: OTHER_SIDE[pair.direction], exclude: pair.exclude, interval: pair.interval, relay: pair.relay !== false,
  };
}
function shareCode(o) { return SHARE_PREFIX + Buffer.from(JSON.stringify(o), 'utf8').toString('base64url'); }
function parseShare(text) {
  const t = String(text || '').trim();
  if (t.length > 200000) throw new Error('This is not a filo live sync.');
  let o;
  const i = t.indexOf(SHARE_PREFIX);
  try {
    if (i >= 0) {
      const m = /^[A-Za-z0-9_-]+/.exec(t.slice(i + SHARE_PREFIX.length));
      o = JSON.parse(Buffer.from(m ? m[0] : '', 'base64url').toString('utf8'));
    } else o = JSON.parse(t);
  } catch (_) { throw new Error('This is not a filo live sync (or it was cut while being copied).'); }
  const sv = o && o.server;
  if (!o || o.filo !== 'sync' || !sv || !LABEL[sv.protocol]) throw new Error('This is not a filo live sync.');
  const host = String(sv.host || '').trim();
  if (!host || /[\s@/\\]|:\/\//.test(host) || host.length > 255) throw new Error('The server address in this live sync cannot be read.');
  const port = parseInt(sv.port, 10) || DEFAULT_PORT[sv.protocol];
  if (port < 1 || port > 65535) throw new Error('The server port in this live sync cannot be read.');
  return {
    name: String(o.name || 'Shared live sync').slice(0, 120),
    server: { protocol: sv.protocol, host, port, user: String(sv.user || '').slice(0, 200), transferMode: sv.transferMode === 'active' ? 'active' : 'passive', fingerprint: /^SHA256:([A-Za-z0-9+/=]{20,80}|[0-9A-Fa-f:]{64,100})$/.test(sv.fingerprint || '') ? sv.fingerprint : '' },
    remote: remotePath(o.remote || '/'),
    direction: ['up', 'down', 'both'].includes(o.direction) ? o.direction : 'down',
    exclude: o.exclude == null ? DEFAULT_SYNC_EXCLUDE : String(o.exclude).slice(0, 4000),
    interval: Math.max(1, Math.min(1440, parseInt(o.interval, 10) || 5)),
    relay: o.relay !== false,
  };
}
function siteForShare(sh) {
  const sv = sh.server;
  return prefs.data.sites.find(s => s.protocol === sv.protocol && String(s.host).toLowerCase() === sv.host.toLowerCase()
    && (Number(s.port) || DEFAULT_PORT[s.protocol]) === sv.port && (s.user || '') === sv.user) || null;
}
async function shareAny(pair) { return pair.via === 'server' ? shareOf(pair) : D.shareOf(pair); }
function codeAny(sh) { return sh.filo === 'direct' ? D.shareCode(sh) : shareCode(sh); }
ipcMain.handle('sync-share', async (_, id) => {
  try {
    const pair = prefs.getSyncPair(String(id));
    if (!pair) return { ok: false, error: 'This live sync no longer exists.' };
    if (pair.via !== 'server') { const sh = await D.shareOf(pair); return { ok: true, code: D.shareCode(sh), share: sh, direct: true }; }
    const sh = shareOf(pair);
    return { ok: true, code: shareCode(sh), share: sh };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('sync-share-save', async (_, id) => {
  try {
    const pair = prefs.getSyncPair(String(id));
    if (!pair) return { ok: false, error: 'This live sync no longer exists.' };
    const sh = await shareAny(pair);
    const safe = pair.name.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').trim() || 'sync';
    const res = await dialog.showSaveDialog(win, { title: 'Save the sync to share', defaultPath: path.join(app.getPath('desktop'), safe + '.filosync'), filters: [{ name: 'filo sync', extensions: ['filosync'] }] });
    if (res.canceled || !res.filePath) return { ok: false, cancelled: true };
    fs.writeFileSync(res.filePath, JSON.stringify(Object.assign({ _about: sh.filo === 'direct' ? 'A filo SYNCTHING live sync to import in filo on the other computer (right-click LIVE SYNC in the side bar → Import session as SLAVE → IMPORT CONFIG).' : 'A filo LIVE SYNC to import in filo (right-click LIVE SYNC in the side bar → Import session as SLAVE → IMPORT CONFIG). No password inside.' }, sh), null, 2));
    sharedFiles.add(path.resolve(res.filePath));
    return { ok: true, path: res.filePath };
  } catch (e) { return { ok: false, error: e.message }; }
});
// 0.9.1: only a file filo itself just saved can be shown or shared from here.
const sharedFiles = new Set();
const sharedOk = p => typeof p === 'string' && sharedFiles.has(path.resolve(absLocal(p)));
ipcMain.handle('sync-share-reveal', (_, p) => { try { if (!sharedOk(p)) return false; shell.showItemInFolder(absLocal(p)); return true; } catch (_) { return false; } });
// macOS: the system's Share menu (Mail, Messages, AirDrop, WhatsApp…).
ipcMain.handle('sync-share-native', (_, p) => {
  try {
    if (!IS_MAC || !sharedOk(p)) return false;
    const { ShareMenu } = require('electron');
    new ShareMenu({ filePaths: [absLocal(p)] }).popup({ window: win });
    return true;
  } catch (_) { return false; }
});
// Import, step 1: read and explain (from pasted text, or a .filosync file).
ipcMain.handle('sync-import-read', async (_, text) => {
  try {
    let t = text;
    if (t == null) {
      const res = await dialog.showOpenDialog(win, { title: 'Open a filo sync', properties: ['openFile'], filters: [{ name: 'filo sync', extensions: ['filosync', 'json', 'txt'] }] });
      if (res.canceled || !res.filePaths.length) return { ok: false, cancelled: true };
      const st = fs.statSync(res.filePaths[0]);
      if (st.size > 200000) return { ok: false, error: 'This is not a filo live sync.' };
      t = fs.readFileSync(res.filePaths[0], 'utf8');
    }
    return await readImportText(t);
  } catch (e) { return { ok: false, error: e.message }; }
});
async function readImportText(t) {
  {
    if (D.isCode(t)) {
      const r = await D.readCode(t);
      // SYNCTHING FAILSAFE: the server part is read like a shared live sync.
      if (r.ok && r.direct.failsafe) {
        const sh = parseShare(JSON.stringify(Object.assign({ filo: 'sync', name: r.direct.name, direction: r.direct.direction }, r.direct.failsafe)));
        r.direct.failsafe = sh;
        r.server = serverReadInfo(sh);
      }
      return r;
    }
    const sh = parseShare(t);
    return Object.assign({ ok: true, share: sh }, serverReadInfo(sh));
  }
}
function serverReadInfo(sh) {
  const site = siteForShare(sh);
  const kind = identityKind(sh.server.protocol);
  const known = kind ? prefs.knownHost(kind, sh.server.host, sh.server.port) : null;
  return {
    site: site ? { id: site.id, name: site.name, hasPassword: !!site.passwordEnc || site.logon === 'key' || site.logon === 'anonymous' } : null,
    identity: !kind ? 'none' : !sh.server.fingerprint ? (known ? 'known' : 'unknown') : !known ? 'from-file' : known === sh.server.fingerprint ? 'same' : 'different',
    vault: secrets.available(),
  };
}
// The server of a shared live sync: its identity pinned, the site found or
// made, the password (if typed) in this machine's keychain. Throws when the
// identity differs from the one already trusted.
function serverImport(sh, pw) {
  const kind = identityKind(sh.server.protocol);
  if (kind && sh.server.fingerprint) {
    const known = prefs.knownHost(kind, sh.server.host, sh.server.port);
    if (known && known !== sh.server.fingerprint) throw new Error('The server identity in this live sync differs from the one this machine already trusts. Ask the other side: the server may have changed, or the code is not theirs.');
    if (!known) { prefs.rememberHost(kind, sh.server.host, sh.server.port, sh.server.fingerprint); log('info', `Trusted ${sh.server.host}:${sh.server.port} as given by the shared live sync: ${sh.server.fingerprint}`); }
  }
  let site = siteForShare(sh);
  let warn = null;
  pw = typeof pw === 'string' ? pw : '';
  if (!site) {
    const blob = pw ? secrets.encrypt(pw) : null;
    if (pw && !blob) warn = 'This machine has no keychain filo can use: the password is kept until filo quits, then asked again. AUTO cannot start on its own after a restart.';
    site = prefs.saveSite({ name: sh.name, folder: 'LIVE SYNC', protocol: sh.server.protocol, host: sh.server.host, port: sh.server.port, user: sh.server.user, logon: blob ? 'normal' : 'ask', transferMode: sh.server.transferMode, remoteDir: sh.remote }, { passwordEnc: blob });
  } else if (pw) {
    const blob = secrets.encrypt(pw);
    if (blob && site.logon !== 'key') prefs.saveSite(Object.assign({}, site, { logon: 'normal' }), { passwordEnc: blob });
    else if (!blob) warn = 'This machine has no keychain filo can use: the password is kept until filo quits.';
  }
  if (pw) memSecrets.set('site:' + site.id, Object.assign(memSecrets.get('site:' + site.id) || {}, { password: pw }));
  return { site, warn, remote: sh.remote, interval: sh.interval };
}
// Import, step 2: the site (found or made), the server's identity, the pair.
ipcMain.handle('sync-import-apply', guard((_, req) => {
  if (req && req.direct) {
    // The server part is read again here: never trusted as the window sends it.
    if (req.direct.failsafe) req = Object.assign({}, req, { direct: Object.assign({}, req.direct, { failsafe: parseShare(JSON.stringify(Object.assign({ filo: 'sync', name: req.direct.name, direction: req.direct.direction }, req.direct.failsafe))) }) });
    const r = D.importApply(Object.assign({}, req, { local: req.local ? absLocal(req.local) : '' }));
    if (r.ok) syncer.apply(r.pair);
    return Object.assign(r, { pairs: prefs.listSyncPairs(), status: allSyncStatus(), sites: prefs.listSites() });
  }
  try {
    const sh = parseShare(JSON.stringify(Object.assign({ filo: 'sync' }, req.share)));
    const localDir = absLocal(req.local);
    if (!fs.existsSync(localDir) || !fs.statSync(localDir).isDirectory()) return { ok: false, error: 'Choose an existing local folder.' };
    const { site, warn } = serverImport(sh, req.password);
    const pair = prefs.saveSyncPair({ name: sh.name, siteId: site.id, local: localDir, remote: sh.remote, direction: sh.direction, exclude: sh.exclude, interval: sh.interval, relay: sh.relay, auto: req.auto !== false });
    syncer.apply(pair);
    return { ok: true, pair, warn, pairs: prefs.listSyncPairs(), status: allSyncStatus(), sites: prefs.listSites() };
  } catch (e) { return { ok: false, error: e.message }; }
}));

// ── Commands from the command line (cli.js) ────────────────────────────────
function findByName(list, key, what) {
  const k = String(key || '').trim();
  const byId = list.find(x => x.id === k);
  if (byId) return byId;
  const same = list.filter(x => String(x.name).toLowerCase() === k.toLowerCase());
  if (same.length === 1) return same[0];
  if (same.length > 1) throw Object.assign(new Error(`several ${what}s are named "${k}": use its id (${same.map(x => x.id).join(', ')})`), { code: 3 });
  throw Object.assign(new Error(`no ${what} named "${k}"`), { code: 3 });
}
// Waits for these queue items to end; reports progress on the way.
function waitItems(ids, emit, gone) {
  return new Promise(resolve => {
    const want = new Set(ids);
    let lastEmit = 0;
    const check = () => {
      const its = [...want].map(id => queue.get(id));
      const end = it => !it || ['done', 'skipped', 'failed', 'stopped'].includes(it.status);
      const now = Date.now();
      if (now - lastEmit > 2000) {
        lastEmit = now;
        const total = its.reduce((a, it) => a + (it ? it.size || 0 : 0), 0), doneB = its.reduce((a, it) => a + (it ? Math.min(it.size || 0, it.done || 0) : 0), 0);
        emit({ type: 'progress', files: its.length, finished: its.filter(end).length, bytes: doneB, total, message: `${its.filter(end).length}/${its.length} files · ${Math.floor(total ? (doneB / total) * 100 : 0)} %` });
      }
      // The server refused the account (or its identity changed): the queue
      // stopped and waits for someone at the window. A program waiting would
      // wait forever: it is told now. (A Pause from the window, on the other
      // hand, is waited out: Start resumes it.)
      const b = queue.blocked;
      // (A refused site stops the whole queue, these files included.)
      if (b && queue.state !== 'running' && its.some(it => it && !end(it))) {
        queue.removeListener('changed', kick); queue.removeListener('state', kick);
        clearInterval(t); clearTimeout(pend);
        resolve({ code: 3, files: its.length, error: `${b.endpointLabel || 'the server'}: ${b.message} (the queue is stopped)` });
        return;
      }
      if (its.every(end) || gone()) {
        queue.removeListener('changed', kick); queue.removeListener('state', kick);
        clearInterval(t); clearTimeout(pend);
        const count = s => its.filter(it => it && it.status === s).length;
        const failed = count('failed') + count('stopped') + its.filter(it => !it).length;
        const errors = its.filter(it => it && it.status === 'failed').slice(0, 50).map(it => ({ file: it.dir === 'up' ? it.remote : it.local, error: it.error }));
        resolve({ code: failed ? 1 : 0, files: its.length, done: count('done'), skipped: count('skipped'), failed, errors,
          message: failed ? `${failed} of ${its.length} files failed` : `${its.length} file${its.length === 1 ? "" : "s"} done` });
      }
    };
    // A queue of thousands of files changes all the time: looked at, at most,
    // four times a second (not at every change).
    let pend = null;
    const kick = () => { if (!pend) pend = setTimeout(() => { pend = null; check(); }, 250); };
    const t = setInterval(check, 1000);
    queue.on('changed', kick);
    queue.on('state', kick);
    check();
  });
}
async function cliAdd(req, emit) {
  const site = findByName(prefs.data.sites, req.site, 'site');
  const endpointId = 'site:' + site.id;
  const base = { endpointId, endpointLabel: site.name };
  const specs = [];
  if (req.cmd === 'upload') {
    const target = remotePath(req.to);
    for (const p of req.args) {
      const src = absLocal(p);
      const st = await fs.promises.stat(src).catch(() => null);
      if (!st) throw Object.assign(new Error(`not found: ${src}`), { code: 2 });
      const name = path.basename(src);
      if (st.isDirectory()) {
        const root = posix.join(target, name);
        specs.push(Object.assign({ dir: 'up', type: 'folder', local: src, remote: root }, base));
        await local.walk(src, e => specs.push(Object.assign({ dir: 'up', type: e.type, local: e.path, remote: posix.join(root, e.rel), size: e.size || 0 }, base)));
      } else specs.push(Object.assign({ dir: 'up', type: 'file', local: src, remote: posix.join(target, name), size: st.size }, base));
    }
  } else {
    const target = absLocal(req.to);
    await fs.promises.mkdir(target, { recursive: true });
    let ep;
    try { ep = await resolveEndpoint(endpointId); }
    catch (e) { throw Object.assign(new Error(e.code === 'NEEDS_PASSWORD' ? `the site "${site.name}" has no saved password: save it in the site manager, or use a key` : e.message), { code: 3 }); }
    const r = createRemote(ep, { log });
    try {
      await r.connect();
      for (const p of req.args) {
        const src = remotePath(p);
        const st = await r.stat(src);
        if (!st) throw Object.assign(new Error(`not on the server: ${src}`), { code: 2 });
        const name = posix.basename(src);
        if (st.type === 'folder') {
          const root = path.join(target, safeLocalName(name));
          specs.push(Object.assign({ dir: 'down', type: 'folder', local: root, remote: src }, base));
          await walkRemote(r, src, e => specs.push(Object.assign({ dir: 'down', type: e.type, local: localJoin(root, e.rel), remote: e.path, size: e.size || 0 }, base)));
        } else specs.push(Object.assign({ dir: 'down', type: 'file', local: path.join(target, safeLocalName(name)), remote: src, size: st.size }, base));
      }
    } catch (e) {
      if (e.code === 2) throw e;
      throw Object.assign(new Error(RemoteError.from(e).message), { code: e.code === 'TRUST_NEEDED' ? 3 : 4 });
    } finally { try { r.close(); } catch (_) {} }
  }
  const added = queue.add(specs);
  const ids = [...added, ...(added.revived || []).map(x => x.id)];
  if (added.revived && added.revived.length) queue.retry(added.revived.map(x => x.id), 'resume');
  // Files already in the queue for the same thing: waited for too.
  for (const sp of specs) {
    if (sp.type !== 'file') continue;
    const it = [...queue.items.values()].find(x => x.dir === sp.dir && x.local === sp.local && x.remote === sp.remote && x.endpointId === endpointId && x.status !== 'done');
    if (it && !ids.includes(it.id)) ids.push(it.id);
  }
  if (queue.state !== 'running' && queue.state !== 'paused') queue.start();
  const fileIds = ids.filter(id => { const it = queue.get(id); return it && it.type === 'file'; });
  emit({ type: 'queued', files: fileIds.length, conflict: added.conflict || 0, message: `${fileIds.length} file${fileIds.length === 1 ? '' : 's'} in the queue (${site.name})${added.conflict ? `, ${added.conflict} left out (same destination as another file)` : ''}` });
  return fileIds;
}
async function handleCli(req, emit, gone) {
  try {
    switch (req.cmd) {
      case 'status': return { code: 0, queue: { state: queue.state, counts: queue.counts() }, syncs: prefs.listSyncPairs().map(p => ({ id: p.id, name: p.name, auto: p.auto, via: p.via, status: statusFor(p.id) })), message: `queue ${queue.state}` };
      case 'queue': {
        const a = req.args[0];
        if (a === 'start') queue.start(); else if (a === 'pause') queue.pause(); else queue.stopAll();
        return { code: 0, state: queue.state, message: `queue ${queue.state}` };
      }
      case 'upload': case 'download': {
        log('info', `Command line: ${req.cmd} ${req.args.length} item${req.args.length === 1 ? '' : 's'} (${req.site})`);
        const ids = await cliAdd(req, emit);
        if (!req.wait) return { code: 0, files: ids.length, message: 'added to the queue' };
        return await waitItems(ids, emit, gone);
      }
      case 'livesync': {
        const pair = findByName(prefs.data.syncPairs, req.pair, 'live sync');
        log('info', `Command line: live sync "${pair.name}"`);
        if (pair.via === 'direct') {
          const d = await D.rescan(pair);
          if (!d.ok) return { code: 3, error: d.error };
          return { code: 0, copies: 0, conflicts: [], message: 'SYNCTHING: the folder is checked now; the other filo receives the changes while both are open' };
        }
        const say = r => emit({ type: 'livesync', copies: r.copies, conflicts: r.conflicts.length, waiting: r.waiting || 0, message: `${r.copies} file${r.copies === 1 ? '' : 's'} to copy${r.conflicts.length ? `, ${r.conflicts.length} conflict${r.conflicts.length === 1 ? '' : 's'}` : ''}${r.waiting ? `, ${r.waiting} not stable yet (checked again in a few seconds)` : ''}` });
        let r = await syncer.run(pair.id, 'command line');
        if (!r || r.ok === false) return { code: 3, error: (r && r.error) || 'the live sync did not run' };
        say(r);
        const ids = [...(r.ids || [])];
        let copies = r.copies, conflicts = r.conflicts;
        // With --wait, a file not stable yet (still being written, or simply
        // seen for the first time) is looked at again until it can be sent:
        // "wait" means everything that is in the folder now.
        const settle = (SYNC.STABLE_MS || 10000) + 1000;
        while (req.wait && r.waiting && !gone()) {
          await new Promise(res => setTimeout(res, settle));
          if (gone()) break;
          r = await syncer.run(pair.id, 'command line');
          if (!r || r.ok === false) return { code: 3, error: (r && r.error) || 'the live sync did not run' };
          say(r);
          for (const id of r.ids || []) if (!ids.includes(id)) ids.push(id);
          copies += r.copies; conflicts = r.conflicts;
        }
        if (!req.wait || !ids.length) return { code: 0, copies, conflicts, waiting: r.waiting || 0, message: copies ? 'sent to the queue' : 'nothing to copy' };
        const w = await waitItems(ids, emit, gone);
        return Object.assign(w, { conflicts });
      }
      default: return { code: 2, error: `unknown command ${req.cmd}` };
    }
  } catch (e) {
    return { code: e.code && Number.isInteger(e.code) ? e.code : 4, error: e.message };
  }
}

// ── The command line, seen from the Settings (POST COMMAND) ───────────────
// What to type to reach this filo from a terminal or another program, and on
// a Mac the "filo" command itself: a three-line script in /usr/local/bin that
// starts this filo (a script, not a link: a link to the binary inside the
// .app makes macOS look for the app's resources in the wrong place).
const CLI_LINK = '/usr/local/bin/filo';
const cliWrapper = () => `#!/bin/sh\n# Installed by filo (Settings, POST COMMAND). Starts filo's command line.\nexec "${process.execPath}" "$@"\n`;
function cliInfo() {
  const exe = process.env.APPIMAGE || process.execPath;
  const q = x => (/[\s"'$`\\]/.test(x) ? `"${x.replace(/(["$`\\])/g, '\\$1')}"` : x);
  const info = { platform: process.platform, packaged: app.isPackaged, exe, installed: false, stale: false, canInstall: false, command: '' };
  if (!app.isPackaged) { info.command = `${q(process.execPath)} ${q(app.getAppPath())}`; return info; }
  if (IS_MAC) {
    info.canInstall = true;
    let text = null; try { text = fs.readFileSync(CLI_LINK, 'utf8'); } catch (_) {}
    info.installed = !!text && text.includes(process.execPath);
    info.stale = !!text && !info.installed && text.includes('Installed by filo');
    info.command = info.installed ? 'filo' : q(exe);
  } else if (process.platform === 'linux') {
    // The .deb puts a "filo" command in /usr/bin; an AppImage is its own file.
    let onPath = false;
    try { onPath = !process.env.APPIMAGE && fs.realpathSync('/usr/bin/filo') === fs.realpathSync(process.execPath); } catch (_) {}
    info.installed = onPath;
    info.command = onPath ? 'filo' : q(exe);
  } else info.command = `"${exe}"`;
  return info;
}
ipcMain.handle('cli-info', () => cliInfo());
ipcMain.handle('cli-install', async () => {
  if (!IS_MAC || !app.isPackaged) return { ok: false, error: 'Only for an installed filo on a Mac.' };
  // Written to a temporary file first, then copied with administrator rights
  // (macOS asks for the Mac's password itself: filo never sees it).
  const tmp = path.join(app.getPath('temp'), `filo-cli-${process.pid}.sh`);
  fs.writeFileSync(tmp, cliWrapper(), { mode: 0o755 });
  const sh = `mkdir -p /usr/local/bin && cp ${JSON.stringify(tmp)} ${CLI_LINK} && chmod 755 ${CLI_LINK}`;
  const script = `do shell script ${JSON.stringify(sh)} with administrator privileges with prompt "filo wants to install the \\"filo\\" command."`;
  try {
    await new Promise((resolve, reject) => require('child_process').execFile('osascript', ['-e', script], (err, _o, se) => (err ? reject(new Error(String(se || err.message).trim())) : resolve())));
    log('info', `Command line installed: ${CLI_LINK}`);
    return { ok: true, info: cliInfo() };
  } catch (e) {
    return { ok: false, cancelled: /-128|cancel/i.test(e.message), error: e.message };
  } finally { try { fs.unlinkSync(tmp); } catch (_) {} }
});
ipcMain.handle('cli-help', () => CLI.HELP);

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
// The shortcuts of the local panel (Noar, 13/10/2026): Desktop and Downloads
// as the system names them (a Windows folder moved elsewhere, a Linux one in
// another language: XDG), and the disks mounted now.
ipcMain.handle('local-places', async () => {
  const home = require('os').homedir();
  // A Linux without its XDG file answers the home folder: then the usual
  // English name, if that folder exists.
  const at = n => {
    let p = ''; try { p = app.getPath(n); } catch (_) {}
    if (!p || p === home) { const f = path.join(home, n === 'desktop' ? 'Desktop' : 'Downloads'); p = fs.existsSync(f) ? f : ''; }
    return p;
  };
  const drives = (await local.roots()).filter(r => r.label !== 'Home');
  return { home, desktop: at('desktop'), downloads: at('downloads'), drives };
});
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
// Moving inside one panel (drag and drop onto a folder, or onto ".."): a
// rename into another folder. Never over something already there, never a
// folder into itself. Another disk is refused: that is a copy, not a move.
function insideOf(child, parent, sep) {
  // Case only counts on Linux (macOS and Windows disks ignore it).
  const fold = process.platform === 'linux' ? x => x : x => x.toLowerCase();
  const c = fold(child), p = fold(parent);
  return c === p || c.startsWith(p.endsWith(sep) ? p : p + sep);
}
ipcMain.handle('local-move', async (_, paths, target) => {
  const errors = [], moved = [];
  let dest;
  try { dest = absLocal(target); } catch (e) { return { ok: false, errors: ['The destination is not a folder.'], moved }; }
  for (const p of Array.isArray(paths) ? paths : []) {
    let from;
    try { from = absLocal(p); } catch (_) { continue; }
    const name = path.basename(from);
    const to = path.join(dest, name);
    try {
      if (path.dirname(from) === dest) continue;                        // already there
      if (insideOf(dest, from, path.sep)) { errors.push(`${name}: a folder cannot go inside itself.`); continue; }
      if (fs.existsSync(to)) { errors.push(`${name}: something with that name is already in the destination.`); continue; }
      await fs.promises.rename(from, to);
      moved.push(name);
    } catch (e) {
      errors.push(`${name}: ${e.code === 'EXDEV' ? 'another disk: drag it to the other panel or copy it instead.' : e.message}`);
    }
  }
  if (moved.length) log('info', `Moved ${moved.length} item${moved.length > 1 ? 's' : ''} to ${dest}`);
  return { ok: !errors.length, moved, errors };
});
ipcMain.handle('remote-move', async (_, paths, target) => {
  const errors = [], moved = [];
  const dest = remotePath(target);
  const sess = browserSession();
  for (const p of Array.isArray(paths) ? paths : []) {
    const from = remotePath(p);
    const name = posix.basename(from);
    const to = posix.join(dest, name);
    try {
      if (from === '/' || posix.dirname(from) === dest) continue;
      if (dest === from || dest.startsWith(from + '/')) { errors.push(`${name}: a folder cannot go inside itself.`); continue; }
      if (await withBrowser(r => r.stat(to), sess)) { errors.push(`${name}: something with that name is already in the destination.`); continue; }
      await withBrowser(r => r.rename(from, to), sess);
      moved.push(name);
    } catch (e) {
      errors.push(`${name}: ${RemoteError.from(e).message}`);
      if (e && e.code === 'SERVER_CHANGED') break;
    }
  }
  if (moved.length) log('info', `Moved ${moved.length} item${moved.length > 1 ? 's' : ''} to ${dest}`);
  return { ok: !errors.length, moved, errors };
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
// The connection being opened (one at a time): { remote, cancelled }.
let connecting = null;
ipcMain.handle('connect-cancel', async () => {
  const c = connecting;
  if (!c) return false;
  c.cancelled = true;
  try { if (c.remote) await c.remote.close(); } catch (_) {}
  log('info', 'Connection cancelled');
  return true;
});

ipcMain.handle('connect', async (_, req) => {
  let endpointId, site = null, attempt = null;
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
    // The window follows the connection step by step, and can cancel it.
    attempt = { remote: null, cancelled: false };
    connecting = attempt;
    const remote = createRemote(Object.assign({}, ep, { acceptFingerprint: req.acceptFingerprint || null, onStep: s => { if (connecting === attempt) send('connect-step', { step: s }); } }), { log });
    attempt.remote = remote;
    log('info', `Connecting to ${describe(ep)}…`);
    try { await remote.connect(); }
    finally { if (connecting === attempt) connecting = null; }
    if (attempt.cancelled) { try { remote.close(); } catch (_) {} return { ok: false, cancelled: true, error: 'Cancelled.' }; }

    // Connected: the new connection replaces the old one.
    if (browser.remote) { try { browser.remote.close(); } catch (_) {} }
    Object.assign(browser, { endpointId, remote, label: ep.label || describe(ep), ep });

    let warn = null;
    if (site && req.savePassword && req.password && site.logon === 'normal') {
      const blob = secrets.encrypt(req.password);
      if (blob) prefs.saveSite({ id: site.id }, { passwordEnc: blob });
      else warn = 'This machine has no keychain filo can use: the password was not saved.';
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
      warn,
    };
  } catch (e) {
    if (attempt && attempt.cancelled) return { ok: false, cancelled: true, error: 'Cancelled.' };
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

// ── The speed test of a bookmark (0.8.0) ──────────────────────────────────
let speedRun = null;         // { token } while a test runs (one at a time)
let speedLast = null;        // the last finished test: what SAVE keeps
ipcMain.handle('speedtest-run', async (_, req) => {
  if (speedRun) return { ok: false, error: 'A speed test is already running.' };
  const site = req && req.siteId ? prefs.getSite(req.siteId) : null;
  if (!site) return { ok: false, error: 'This bookmark no longer exists.' };
  const endpointId = 'site:' + site.id;
  const token = { cancelled: false, cut: null };
  speedRun = { token };
  try {
    if (req.password !== undefined && req.password !== null && req.password !== '') {
      const mem = memSecrets.get(endpointId) || {};
      if (site.logon === 'key') mem.passphrase = req.password; else mem.password = req.password;
      memSecrets.set(endpointId, mem);
    }
    const ep = await resolveEndpoint(endpointId);
    await netid.refresh();
    const res = await runSpeedTest({
      create: () => createRemote(Object.assign({}, ep, { acceptFingerprint: req.acceptFingerprint || null }), { log }),
      protocol: LABEL[ep.protocol] || '', maxConnections: ep.maxConnections,
      dir: req.dir || (site.remoteDir && site.remoteDir !== '/' ? site.remoteDir : ''), readOnly: !!req.readOnly,
      durationMs: req.seconds === 60 ? 60000 : 20000, token, log,
      onEvent: e => send('speedtest-event', e),
    });
    speedLast = { siteId: site.id, result: res, net: netid.current(), netLabel: netid.label() };
    return { ok: true, result: res };
  } catch (e) {
    if (e && e.cancelled) return { ok: false, cancelled: true };
    if (e && (e.code === 'PICK_DIR' || e.code === 'READONLY' || e.code === 'NO_FILE')) return { ok: false, code: e.code, dir: e.dir, error: e.message };
    const r = errOut(e);
    if (/refused the login|private key cannot be read/i.test(r.error)) { const mm = memSecrets.get(endpointId); if (mm) { delete mm.password; delete mm.passphrase; } }
    log(r.code === 'TRUST_NEEDED' || r.needsPassword ? 'info' : 'warn', 'Speed test: ' + r.error.split('\n')[0]);
    return r;
  } finally { speedRun = null; }
});
// The folder chooser of the test: the folders of `dir` (the login folder by default).
ipcMain.handle('speedtest-list', async (_, req) => {
  const site = req && req.siteId ? prefs.getSite(req.siteId) : null;
  if (!site) return { ok: false, error: 'This bookmark no longer exists.' };
  let r = null;
  try {
    const ep = await resolveEndpoint('site:' + site.id);
    r = createRemote(Object.assign({}, ep, { acceptFingerprint: req.acceptFingerprint || null }), { log });
    await r.connect();
    let dir = req.dir || '/';
    const l = await r.list(dir);
    const folders = l.filter(e => e.type === 'folder' || e.linkTo === 'folder').map(e => e.name).filter(n => !n.startsWith('.')).sort((a, b) => a.localeCompare(b));
    return { ok: true, dir, folders };
  } catch (e) { return errOut(e); }
  finally { try { if (r) r.close(); } catch (_) {} }
});
ipcMain.handle('speedtest-cancel', () => {
  if (!speedRun) return false;
  speedRun.token.cancelled = true;
  try { if (speedRun.token.cut) speedRun.token.cut(); } catch (_) {}
  return true;
});
// SAVE: the bookmark keeps the figures as its starting settings, with the
// date and the network they were measured on.
ipcMain.handle('speedtest-save', (_, siteId) => {
  if (!speedLast || speedLast.siteId !== siteId) return { ok: false, error: 'No speed test to save.' };
  const r = speedLast.result, d = x => (x ? { conn: x.conn, seg: x.segOn, mbps: x.mbps, src: 'test' } : null);
  const prev = (prefs.getSite(siteId) || {}).speed;
  const saved = prefs.saveSite({ id: siteId, speed: { at: r.at, net: speedLast.net, netLabel: speedLast.netLabel, out: d(r.out) || ((prev && prev.net === speedLast.net) ? prev.out : null), in: d(r.in), latencyMs: r.latencyMs, maxOpen: r.maxOpen } });
  const warn = speedLast.net ? null : 'filo could not recognise this network, so these settings will not be applied automatically.';
  return { ok: true, site: saved, warn };
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
    if (/[/]/.test(name) || name === '.' || name === '..' || !String(name || '').trim()) return { ok: false, error: 'This name is not allowed (no "/", not "." or "..").' };
    const p = posix.join(remotePath(dir), String(name));
    await withBrowser(r => r.mkdir(p));
    return { ok: true, path: p };
  } catch (e) { return errOut(e); }
});
ipcMain.handle('remote-rename', async (_, from, toName) => {
  try {
    if (/[/]/.test(toName) || toName === '.' || toName === '..' || !String(toName || '').trim()) return { ok: false, error: 'This name is not allowed (no "/", not "." or "..").' };
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
// Every listing in progress (two can overlap): CANCEL, PAUSE and STOP reach them all.
const scanTokens = new Set();
ipcMain.handle('queue-add', async (_, req) => {
  const endpointId = req.endpointId || browser.endpointId;
  if (!endpointId) return { ok: false, error: 'Connect to a server first.' };
  const label = endpointLabel(endpointId);
  const token = { cancelled: false };
  scanTokens.add(token);
  const specs = [];
  const base = { endpointId, endpointLabel: label, existing: EXISTING_ACTIONS.includes(req.existing) ? req.existing : null };
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
    if (req.start !== false && !token.noStart && queued && !scheduled) queue.start();
    return { ok: true, count: found, revived: revived.slice(0, 5000), already, conflict };
  } catch (e) {
    flush();
    send('scan-progress', { found, done: true });
    return errOut(e);
  } finally { scanTokens.delete(token); }
});
ipcMain.handle('scan-cancel', () => { for (const t of scanTokens) t.cancelled = true; return true; });
ipcMain.handle('queue-start', () => { unschedule(); queue.start(); return queue.state; });
// ── Start the queue later (Noar, 12/10/2026): at a time of the day, while
// filo is open. Adding files meanwhile does not start it; START does.
let scheduled = null;   // { at, timer }
function unschedule() { if (scheduled) { clearTimeout(scheduled.timer); scheduled = null; send('queue-scheduled', { at: 0 }); } }
ipcMain.handle('queue-schedule', (_, at) => {
  if (scheduled) clearTimeout(scheduled.timer);
  scheduled = null;
  const t = Number(at) || 0;
  if (t > Date.now()) {
    const fire = () => {
      if (!scheduled) return;
      // setTimeout cannot wait more than ~24 days, and a machine asleep
      // delays it: check the clock again rather than trust the timer.
      if (Date.now() < scheduled.at - 500) { scheduled.timer = setTimeout(fire, Math.min(scheduled.at - Date.now(), 60000)); return; }
      scheduled = null;
      send('queue-scheduled', { at: 0, fired: true });
      log('info', 'Scheduled start: the queue starts');
      if (queue.state !== 'running') {
        const paused = queue.page('queue', 0, 1e6).items.filter(i => i.status === 'paused').map(i => i.id);
        if (paused.length) queue.resumeItems(paused);
        queue.start();
      }
    };
    scheduled = { at: t, timer: setTimeout(fire, Math.min(t - Date.now(), 60000)) };
    log('info', `Scheduled start: ${new Date(t).toLocaleString()}`);
  }
  return { at: scheduled ? scheduled.at : 0 };
});
ipcMain.handle('queue-scheduled', () => ({ at: scheduled ? scheduled.at : 0 }));
ipcMain.handle('queue-pause', () => { for (const t of scanTokens) t.noStart = true; queue.pause(); return queue.state; });
// Stop everything also stops a folder listing still adding files.
ipcMain.handle('queue-stop-all', () => { for (const t of scanTokens) t.cancelled = true; queue.stopAll(); return queue.state; });
ipcMain.handle('queue-item-pause', (_, ids) => { queue.pauseItems(ids || []); return true; });
ipcMain.handle('queue-item-resume', (_, ids) => { queue.resumeItems(ids || []); return true; });
ipcMain.handle('queue-item-stop', (_, ids) => { queue.stopItems(ids || []); return true; });
ipcMain.handle('queue-remove', (_, ids) => { queue.remove(ids || []); return queue.counts(); });
ipcMain.handle('queue-retry', (_, ids, mode) => { queue.retry(ids || [], mode === 'restart' ? 'restart' : 'resume'); return queue.counts(); });
ipcMain.handle('queue-clear', (_, tab) => { queue.clear(tab); return queue.counts(); });
ipcMain.handle('queue-page', (_, tab, offset, limit) => queue.page(tab, offset, limit));
ipcMain.handle('queue-answer', (_, askId, rule, all) => queue.answer(askId, EXISTING_ACTIONS.includes(rule) && rule !== 'ask' ? rule : 'skip', !!all));
ipcMain.handle('queue-reveal', (_, id) => {
  const it = queue.get(id);
  if (!it) return false;
  try { shell.showItemInFolder(fs.existsSync(it.local) ? it.local : path.dirname(it.local)); } catch (_) {}
  return true;
});

// ── IPC: sites ─────────────────────────────────────────────────────────────
ipcMain.handle('sites-list', () => ({ sites: prefs.listSites(), siteFolderOrder: prefs.data.siteFolderOrder, vaultAvailable: secrets.available() }));
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
      if (passphrase !== '' && !patch.passphraseEnc) warn = 'This machine has no keychain filo can use: the key passphrase was not saved and will be asked at each connection.';
    }
    const saved = prefs.saveSite(site, patch);
    return { ok: true, site: saved, sites: prefs.listSites(), warn };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('sites-arrange', (_, list, folderOrder) => ({ sites: prefs.arrangeSites(list, folderOrder), siteFolderOrder: prefs.data.siteFolderOrder }));
// One site or several (a selection, 0.9.0).
ipcMain.handle('sites-delete', (_, id) => {
  for (const x of (Array.isArray(id) ? id : [id])) { if (typeof x !== 'string') continue; prefs.deleteSite(x); memSecrets.delete('site:' + x); }
  return prefs.listSites();
});
// One site or several. Each copy goes right under its source (0.9.0).
ipcMain.handle('sites-duplicate', (_, id) => {
  for (const x of (Array.isArray(id) ? id : [id])) {
    const s = typeof x === 'string' ? prefs.getSite(x) : null;
    if (!s) continue;
    const copy = Object.assign({}, s, { id: null, name: s.name + ' (copy)' });
    const saved = prefs.saveSite(copy, { passwordEnc: s.passwordEnc, passphraseEnc: s.passphraseEnc });
    prefs.placeAfter(saved.id, s.id);
  }
  return prefs.listSites();
});
// A folder of the site manager (Noar, 0.6.4). Its path and the ones under it.
const underFolder = (f, path) => f === path || String(f || '').startsWith(path + ' / ');
ipcMain.handle('sites-delete-folder', (_, path) => {
  if (typeof path !== 'string' || !path) return prefs.listSites();
  for (const s of prefs.listSites()) if (underFolder(s.folder, path)) { prefs.deleteSite(s.id); memSecrets.delete('site:' + s.id); }
  return prefs.listSites();
});
// A copy of a folder: every site in it (and in its sub-folders), same names,
// remembered passwords included, under `to`.
ipcMain.handle('sites-duplicate-folder', (_, from, to) => {
  if (typeof from !== 'string' || !from || typeof to !== 'string' || !to) return prefs.listSites();
  for (const s of prefs.listSites()) {
    if (!underFolder(s.folder, from)) continue;
    const raw = prefs.getSite(s.id);
    prefs.saveSite(Object.assign({}, s, { id: null, folder: to + String(s.folder).slice(from.length) }), { passwordEnc: raw.passwordEnc, passphraseEnc: raw.passphraseEnc });
  }
  return prefs.listSites();
});
// Turns a quick connection into a site, password included if one was typed.
ipcMain.handle('sites-from-quick', (_, q, name) => {
  const site = prefs.saveSite({ name: name || q.host, protocol: q.protocol, host: q.host, port: q.port, user: q.user, logon: q.user ? 'normal' : 'anonymous' }, {});
  const mem = memSecrets.get(quickId(q));
  if (mem && mem.password) { const blob = secrets.encrypt(mem.password); if (blob) prefs.saveSite({ id: site.id }, { passwordEnc: blob }); }
  return { site, sites: prefs.listSites() };
});

// Import. `withPasswords`: also take the passwords (FileZilla's, or a filo
// export's encrypted ones). A filo export with encrypted passwords asks for its
// passphrase: the first answer says so (needsPassphrase) and the window calls
// again with `opts.passphrase`, on the same file (kept here, never sent back).
let pendingImport = null;
ipcMain.handle('sites-import', async (_, withPasswords, opts) => {
  const o = opts || {};
  let file = null;
  if (o.again && pendingImport) file = pendingImport;
  else {
    const res = await dialog.showOpenDialog(win, {
      title: 'Import sites',
      filters: [{ name: 'filo or FileZilla sites', extensions: ['json', 'xml'] }],
      properties: ['openFile'],
    });
    if (res.canceled || !res.filePaths.length) return { ok: false, cancelled: true };
    file = res.filePaths[0];
  }
  try {
    const text = fs.readFileSync(file, 'utf8');
    const fmt = sites.detectFormat(text);
    if (!fmt) return { ok: false, error: 'This file is neither a filo export nor a FileZilla sitemanager.xml.' };
    const locked = fmt === 'filo' && withPasswords && sites.isEncrypted(text);
    if (locked && !o.passphrase) { pendingImport = file; return { ok: false, needsPassphrase: true, wrong: !!o.again }; }
    let list;
    try { list = fmt === 'filo' ? await sites.importFilo(text, locked ? o.passphrase : '') : sites.importFileZilla(text); }
    catch (e) { if (e.code === 'BAD_PASSPHRASE') { pendingImport = file; return { ok: false, needsPassphrase: true, wrong: true }; } throw e; }
    pendingImport = null;
    let withPw = 0, lockedPw = 0;
    for (const { site, password, passphrase, passwordEncrypted } of list) {
      const patch = {};
      if (withPasswords && password) { const blob = secrets.encrypt(password); if (blob) { patch.passwordEnc = blob; withPw++; } }
      if (withPasswords && passphrase) { const blob = secrets.encrypt(passphrase); if (blob) { patch.passphraseEnc = blob; if (!password) withPw++; } }
      if (passwordEncrypted) lockedPw++;
      prefs.saveSite(Object.assign({}, site, { id: null }), patch);
    }
    log('info', `Imported ${list.length} site(s) from ${path.basename(file)}`);
    return { ok: true, count: list.length, withPasswords: withPw, lockedPasswords: lockedPw, format: fmt, sites: prefs.listSites() };
  } catch (e) { return { ok: false, error: 'This file could not be read: ' + e.message }; }
});

// Export, filo format only (0.9.0: FileZilla's is gone). `opts.passphrase`:
// the passwords stored on this machine go in too, encrypted with it.
ipcMain.handle('sites-export', async (_, opts, ids) => {
  const o = opts || {};
  const withPw = typeof o.passphrase === 'string' && o.passphrase.length > 0;
  if (withPw && o.passphrase.length < sites.PASSPHRASE_MIN) return { ok: false, error: `The passphrase needs at least ${sites.PASSPHRASE_MIN} characters.` };
  const res = await dialog.showSaveDialog(win, {
    title: 'Export sites',
    defaultPath: withPw ? 'filo-sites-with-passwords.json' : 'filo-sites.json',
    filters: [{ name: 'filo sites', extensions: ['json'] }],
  });
  if (res.canceled || !res.filePath) return { ok: false, cancelled: true };
  const list = (ids && ids.length ? prefs.data.sites.filter(s => ids.includes(s.id)) : prefs.data.sites);
  try {
    let secretsList = null, included = 0;
    if (withPw) {
      secretsList = list.map(s => ({ password: secrets.decrypt(s.passwordEnc), passphrase: secrets.decrypt(s.passphraseEnc) }));
      included = secretsList.filter(x => x.password || x.passphrase).length;
    }
    fs.writeFileSync(res.filePath, await sites.exportFilo(list, { secrets: secretsList, passphrase: o.passphrase }));
    return { ok: true, count: list.length, withPasswords: included, path: res.filePath };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ── IPC: check a delivery against the other side (Noar, 12/10/2026) ───────
let compareToken = null;
ipcMain.handle('compare', async (_, req) => {
  const compare = require('./core/compare');
  const r = req || {};
  const names = (Array.isArray(r.names) ? r.names : []).map(String).filter(n => n && !/[\/\\]/.test(n) && n !== '..' && n !== '.');
  if (!names.length) return { ok: false, error: 'Nothing selected.' };
  const opts = { localRoot: absLocal(r.localRoot), remoteRoot: remotePath(r.remoteRoot), names, serverHash: prefs.data.settings.serverHash !== false };
  const sess = browserSession();
  if (compareToken) compareToken.cancelled = true;
  const token = compareToken = { cancelled: false };
  try {
    const p = await withBrowser(rem => compare.plan(rem, opts, token), sess);
    if (!p.algo && !r.readBack && p.both.length) return { ok: true, needsReadBack: true, files: p.both.length, bytes: p.bytes };
    const res = await withBrowser(rem => compare.run(rem, p, Object.assign({}, opts, {
      readBack: !!r.readBack, token, onFile: (i, n, rel) => send('compare-progress', { i, n, rel }),
    })), sess);
    log(res.different.length || res.onlyLocal.length || res.onlyRemote.length ? 'warn' : 'info',
      `Checked against the server: ${res.same.length} identical, ${res.different.length} different, ${res.onlyLocal.length} only here, ${res.onlyRemote.length} only on the server${res.unchecked.length ? `, ${res.unchecked.length} not checked` : ''}`);
    return Object.assign({ ok: true, cancelled: token.cancelled }, res);
  } catch (e) { return { ok: false, error: RemoteError.from(e).message }; }
  finally { if (compareToken === token) compareToken = null; }
});
// Quick Look (Mac only: Electron's previewFile).
ipcMain.handle('local-preview', (_, p) => {
  if (process.platform !== 'darwin' || !win) return false;
  try { const f = absLocal(p); if (!fs.statSync(f).isFile()) return false; win.previewFile(f); return true; } catch (_) { return false; }
});
ipcMain.handle('compare-cancel', () => { if (compareToken) compareToken.cancelled = true; return true; });

// ── IPC: window chrome ─────────────────────────────────────────────────────
ipcMain.on('win-minimize', () => win && win.minimize());
ipcMain.on('win-maximize', () => { if (!win) return; win.isMaximized() ? win.unmaximize() : win.maximize(); });
ipcMain.on('win-close',    () => win && win.close());

// ── The ring alone (Noar, 13/10/2026) ──────────────────────────────────────
// LIVE SYNC reduced to its ring in a small window; back to the full window
// as it was. PIN keeps it above the other windows.
let miniPrev = null;
ipcMain.handle('win-mini', (_, on) => {
  if (!win) return false;
  if (on && !miniPrev) {
    miniPrev = { bounds: win.getBounds(), max: win.isMaximized() };
    if (miniPrev.max) win.unmaximize();
    win.setMinimumSize(220, 250);
    const b = win.getBounds();
    win.setBounds({ x: b.x + b.width - 300, y: b.y, width: 300, height: 330 });
    if (IS_MAC && win.setWindowButtonVisibility) win.setWindowButtonVisibility(false);
  } else if (!on && miniPrev) {
    win.setAlwaysOnTop(false);
    win.setMinimumSize(1100, 680);
    win.setBounds(miniPrev.bounds);
    if (miniPrev.max) win.maximize();
    if (IS_MAC && win.setWindowButtonVisibility) win.setWindowButtonVisibility(true);
    miniPrev = null;
  }
  updateTray();
  return !!miniPrev;
});
ipcMain.handle('win-pin', (_, on) => { if (win) win.setAlwaysOnTop(!!on, 'floating'); return !!on; });
ipcMain.handle('win-to-tray', () => { hideToTray(); return true; });

// ── In the menu bar / notification area, on every system ───────────────────
// The tray icon brings filo back, shows the LIVE SYNC sessions and their
// state, opens the ring alone, or quits. "Hide to the tray": the window goes,
// filo (transfers, LIVE SYNC) keeps running; on Windows and Linux it leaves
// the task bar, on a Mac the Dock icon stays.
let tray = null, trayText = '';
function trayIcon() {
  const dir = path.join(__dirname, 'tray');
  const img = nativeImage.createFromPath(path.join(dir, IS_MAC ? 'trayTemplate.png' : process.platform === 'linux' ? 'tray-64.png' : 'tray.png'));
  if (IS_MAC) img.setTemplateImage(true);
  return img;
}
function showWindow() {
  if (!win) { createWindow(); return; }
  if (win.isMinimized()) win.restore();
  win.show(); win.focus();
}
function hideToTray() {
  if (!win) return;
  if (!tray) createTray();
  win.hide();
}
const TRAY_STATE = { insync: 'up to date', syncing: 'synchronizing', scanning: 'checking', offline: 'not reachable', paused: 'disconnected', held: 'paused', error: 'error', waiting: 'waiting', starting: 'starting', mirror: 'S-FTP BACKUP', mirrored: 'up to date', standby: 'standby', checking: 'checking' };
function updateTray() {
  if (!tray || !prefs) return;
  const pairs = prefs.listSyncPairs().filter(p => p.auto || p.fsAuto);
  const lines = pairs.map(p => { const st = statusFor(p.id) || {}; return `${p.name}: ${TRAY_STATE[st.state] || st.state || '…'}`; });
  const running = queue && queue.state === 'running';
  const text = JSON.stringify([lines, running, !!miniPrev, win && win.isVisible()]);
  if (text === trayText) return;
  trayText = text;
  tray.setToolTip(['filo'].concat(running ? ['transfers running'] : [], lines).join('\n'));
  const items = [
    { label: win && win.isVisible() ? 'Show filo' : 'Open filo', click: () => { if (miniPrev) send('menu', { action: 'mini', value: false }); showWindow(); } },
  ];
  if (pairs.length) {
    items.push({ type: 'separator' }, { label: 'LIVE SYNC', enabled: false });
    for (const l of lines) items.push({ label: '  ' + l, enabled: false });
    items.push({ label: 'The ring alone', click: () => { showWindow(); send('menu', { action: 'mini', value: true }); } });
  }
  if (running) items.push({ type: 'separator' }, { label: 'Transfers running', enabled: false });
  items.push({ type: 'separator' },
    { label: 'Hide to the tray', enabled: !!(win && win.isVisible()), click: hideToTray },
    { label: 'Quit filo', click: () => app.quit() });
  tray.setContextMenu(Menu.buildFromTemplate(items));
}
function createTray() {
  if (tray) return;
  try { tray = new Tray(trayIcon()); } catch (e) { log('warn', 'Tray icon not available: ' + e.message); return; }
  // Windows / Linux: a click shows or hides the window; macOS: the menu.
  if (!IS_MAC) tray.on('click', () => { if (win && win.isVisible() && !win.isMinimized()) hideToTray(); else showWindow(); });
  trayText = '';
  updateTray();
}
setInterval(() => { try { updateTray(); } catch (_) {} }, 3000).unref();
