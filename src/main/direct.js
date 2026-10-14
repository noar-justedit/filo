/*
 * filo — FTP, FTPS and SFTP client
 * Copyright (C) 2026 Just Edit (Arnaud Augst)
 * Licensed under the GNU General Public License v3.0 or later. See LICENSE.
 */

// SYNCTHING: a live sync between two filo, peer to peer, with no server between
// them. The work is done by Syncthing (https://syncthing.net, MPL-2.0), a
// separate program shipped next to filo (resources/syncthing/), started and
// driven by filo through its local REST API. The user never sees Syncthing:
// filo writes its whole configuration.
//
// Why Syncthing: finding the other computer through two home routers (NAT),
// falling back to a relay when no direct path exists, encrypting and
// authenticating each side (TLS with the device ID), resuming, hashing in
// blocks… It is ten years of work, and it is what filo would need to rewrite.
//
// The rules of LIVE SYNC hold here too:
//   - nothing is ever deleted: every folder has ignoreDelete (a file deleted
//     on one side stays on the other);
//   - a file changed on both sides: both versions are kept (Syncthing names
//     the other one "name.sync-conflict-<date>-<device>.ext"), never one
//     lost; maxConflicts is unlimited;
//   - another computer is never trusted on its own: it is accepted by the
//     user (its ID shown), or known because the user imported its code.
//
// Its own place: userData/direct/ (keys, configuration, database). Its
// interface (the web GUI) only listens on 127.0.0.1, on a new port at each
// start, and is locked by a random password nobody knows; filo talks to it
// with the API key of the configuration (a file only this user can read),
// passed in the environment, never on a command line.
//
// It only starts when a SYNCTHING live sync exists or the user asks for this
// computer's ID: a filo without SYNCTHING never runs it (no firewall question).

const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');

const PREFIX = 'filo-';
const CTL_PREFIX = 'filoctl-';   // the small control folder of each pair (MASTER → SLAVE settings)
const TRASH = '.filo-trash';     // per side, inside the synced folder, never synced
// A copy Syncthing kept beside a file changed on both computers.
const CONFLICT = /^(.*)\.sync-conflict-(\d{8}-\d{6})-([A-Z2-7]{7})(\.[^./]*)?$/;
function ctlId(folderId) { return CTL_PREFIX + String(folderId).slice(PREFIX.length); }
const TYPE = { up: 'sendonly', down: 'receiveonly', both: 'sendreceive' };
const OTHER = { up: 'down', down: 'up', both: 'both' };
const LISTEN_PORT = 22000;       // Syncthing's usual port; another free one when taken
const POLL_FAST_MS = 2000;       // the LIVE SYNC window is open
const POLL_SLOW_MS = 10000;
const STOP_WAIT_MS = 5000;

// Where the Syncthing program is: next to the packaged app (main.js sets
// FILO_SYNCTHING_PATH), or vendor/syncthing/dist/<platform>/ in a source
// folder (node scripts/syncthing-fetch.js). FILO_DIRECT=0 turns SYNCTHING off.
function binPath() {
  if (process.env.FILO_DIRECT === '0') return null;
  const exe = process.platform === 'win32' ? 'syncthing.exe' : 'syncthing';
  const plat = { darwin: 'mac', win32: 'win', linux: 'linux' }[process.platform];
  const list = [process.env.FILO_SYNCTHING_PATH, path.join(__dirname, '..', '..', 'vendor', 'syncthing', 'dist', plat || '', exe)];
  return list.find(p => { try { return p && fs.statSync(p).isFile(); } catch (_) { return false; } }) || null;
}

// The folder ID carries the direction as its creator saw it, so the filo that
// receives the offer knows its own (the other way round).
// The local folder of a session must be there before Syncthing is given it:
// Syncthing creates a folder it is given that does not exist (an empty
// ~/Downloads/TEST after the user threw it away, or a fake /Volumes/DISK
// while the disk is unplugged). Missing: the session is paused, nothing is
// created, and it starts again by itself when the folder is back.
function localMissing(p) {
  try { return !fs.statSync(p.local).isDirectory(); } catch (_) { return true; }
}

function newFolderId(direction) {
  const abc = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const b = crypto.randomBytes(12);
  let s = '';
  for (const x of b) s += abc[x % abc.length];
  return `${PREFIX}${direction}-${s}`;
}
function directionOfOffer(folderId) {
  const m = /^filo-(up|down|both)-/.exec(folderId || '');
  return m ? OTHER[m[1]] : 'both';
}

// filo's exclusions (syncto's rules: core/filter.js) as Syncthing's
// .stignore lines. "*.tmp" (any name, any depth) is the same; "/Cache/"
// (that folder at the top) and "*/proxy/" (one level down) are anchored at the
// top, and Syncthing wants no trailing slash.
// filo's patterns are case-insensitive (as for S-FTP): "(?i)" on each line.
// Syncthing's own marks ("!", "(?d)", "#include", "//") are not filo's
// syntax: dropped, so a filter can never turn into an instruction. A
// trailing ":" (files only in filo) has no equivalent: the mark goes.
function toIgnore(exclude) {
  const out = [];
  for (let t of String(exclude || '').split(/[,;|\n\r]+/)) {
    t = t.trim().replace(/\\/g, '/');
    if (!t || t.startsWith('#') || t.startsWith('//')) continue;
    t = t.replace(/^(?:!|\(\?[a-z]+\))+/i, '').trim();
    if (t.endsWith(':')) t = t.slice(0, -1);
    while (t.length > 1 && t.endsWith('/')) t = t.slice(0, -1);
    if (!t || t === '/') continue;
    if (t.includes('/') && !t.startsWith('/')) t = '/' + t;
    out.push('(?i)' + t);
  }
  return out;
}

function shortId(id) { return String(id || '').split('-')[0] || ''; }

// A SYNCTHING ID pasted by hand (spaces, line breaks, lower case, no dashes…):
// the clean ID, or null. Its four check characters are verified as
// Syncthing does (Luhn mod 32), so a typo is caught here, not by Syncthing.
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function luhn32(s) {
  let factor = 1, sum = 0;
  for (const ch of s) {
    let a = factor * B32.indexOf(ch);
    factor = factor === 2 ? 1 : 2;
    a = Math.floor(a / 32) + (a % 32);
    sum += a;
  }
  return B32[(32 - (sum % 32)) % 32];
}
function parseDeviceId(text) {
  const raw = String(text || '').toUpperCase().replace(/[^A-Z2-7]/g, '');
  if (raw.length !== 56) return null;
  for (let g = 0; g < 4; g++) {
    const chunk = raw.slice(g * 14, g * 14 + 13);
    if (luhn32(chunk) !== raw[g * 14 + 13]) return null;
  }
  return raw.match(/.{7}/g).join('-');
}
function hostName() {
  let n = os.hostname() || 'filo';
  n = n.replace(/\.(local|lan|home|localdomain)$/i, '');
  return n.slice(0, 60);
}
// "macOS 15.1", "Windows 11 (10.0.22631)", "Linux 6.8"…
function osLabel() {
  const v = typeof process.getSystemVersion === 'function' ? process.getSystemVersion() : os.release();
  if (process.platform === 'darwin') return `macOS ${v}`;
  if (process.platform === 'win32') { const b = parseInt(String(v).split('.')[2], 10); return `Windows ${b >= 22000 ? '11' : '10'} (${v})`; }
  return `Linux ${os.release().split('-')[0]}`;
}
// The name the other filo sees: the computer's name and its system, so the
// LIVE SYNC view can show both (Syncthing only carries a name).
function deviceName() { return `${hostName()} · ${osLabel()}`; }

function portFree(port, host) {
  return new Promise(res => {
    const s = net.createServer();
    s.once('error', () => res(false));
    s.listen(port, host || '0.0.0.0', () => s.close(() => res(true)));
  });
}
function freePort() {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.once('error', rej);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}
// Syncthing's warnings that are normal life (a discovery server out of
// reach for a moment, the other computer not accepted yet, a pairing being
// set up on both sides): not in filo's journal.
const QUIET = /relays\.syncthing\.net|discovery-announce|discovery-lookup|ff12::8384|unknown device|Unexpected folder ID|nonexistent or paused folder|exchange Hello|privileged or system user|NAT-PMP|UPnP/i;
const sleep = ms => new Promise(r => setTimeout(r, ms));
function alive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }

class Direct extends EventEmitter {
  // opts: { bin, home, log, name, testing: { listen: ['tcp://127.0.0.1:N'] } }
  constructor(opts) {
    super();
    this.o = opts || {};
    this.bin = this.o.bin === undefined ? binPath() : this.o.bin;
    this.home = this.o.home;
    this.child = null;
    this.ready = null;
    this.stopping = false;
    this.restarts = [];
    this.want = null;              // the last reconcile: { pairs, devices }
    this.chain = Promise.resolve();
    this.status = new Map();       // pairId → status (JSON text, to send only changes)
    this.lastPending = '';
    this.pending = { devices: [], folders: [] };
    this.rates = new Map();        // deviceId → { at, in, out, rin, rout }
    this.fast = false;
    this.pollTimer = null;
    this.pollGen = 0;              // a new poll loop makes the older one stop
    this.quit = false;             // stop() was called: never starts again
    this.evChild = null;
    this.act = new Map();          // folderId → what moves now: { dl, rdl, done, upPrev } (the LIVE SYNC queue)
    this.held = new Set();         // folderIds paused from the LIVE SYNC queue (PAUSE button), until resumed or filo quits
    this.myId = null;
  }

  get available() { return !!this.bin; }
  get running() { return !!(this.child && this.myId); }
  log(level, msg) { try { if (this.o.log) this.o.log(level, msg); } catch (_) {} }

  // ── The program ────────────────────────────────────────────────────────
  start() {
    if (!this.bin) return Promise.reject(new Error('SYNCTHING is not in this build of filo.'));
    if (this.quit) return Promise.reject(new Error('SYNCTHING is stopping.'));
    if (!this.ready) {
      this.stopping = false;
      this.ready = this._start().catch(e => { this.ready = null; this._kill(); throw e; });
    }
    return this.ready;
  }

  async _start() {
    fs.mkdirSync(this.home, { recursive: true, mode: 0o700 });
    const cfgFile = path.join(this.home, 'config.xml');
    if (!fs.existsSync(cfgFile)) await this._generate();
    const cfg = fs.readFileSync(cfgFile, 'utf8');
    const m = /<apikey>([^<]+)<\/apikey>/.exec(cfg);
    if (!m) throw new Error('SYNCTHING: its configuration has no API key.');
    this.key = m[1];
    await this._stopStale();
    await this._listenAddresses(cfgFile);

    this.guiPort = await freePort();
    const env = Object.assign({}, process.env, {
      STGUIADDRESS: `127.0.0.1:${this.guiPort}`,
      STGUIAPIKEY: this.key,
      STNOUPGRADE: '1',          // filo ships the version it was tested with
      STNORESTART: '1',          // filo restarts it when needed, nobody else
      STNOBROWSER: '1',
      STVERSIONEXTRA: 'filo',
      STLOGFORMATTIMESTAMP: '',
    });
    const child = spawn(this.bin, ['serve', '--home', this.home], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    this.child = child;
    let tail = '';
    const onOut = buf => {
      tail = (tail + buf.toString('utf8')).slice(-4000);
      for (const line of buf.toString('utf8').split(/\r?\n/)) {
        if (/\b(WRN|ERR)\b/.test(line) && !QUIET.test(line)) this.log('warn', 'SYNCTHING: ' + line.replace(/\s*\(log\.pkg=[^)]*\)\s*$/, '').replace(/^\s*(WRN|ERR)\s+/, '').trim().slice(0, 300));
      }
    };
    child.stdout.on('data', onOut);
    child.stderr.on('data', onOut);
    const exited = new Promise(res => child.once('exit', (code, sig) => res({ code, sig })));
    child.once('exit', (code, sig) => this._exited(child, code, sig, tail));
    child.once('error', e => this.log('error', `SYNCTHING: could not start Syncthing (${e.message})`));
    try { fs.writeFileSync(path.join(this.home, 'filo-run.json'), JSON.stringify({ pid: child.pid, gui: this.guiPort }), { mode: 0o600 }); } catch (_) {}

    // Up within 30 s, or a clear error.
    const t0 = Date.now();
    for (;;) {
      const r = await Promise.race([this.req('GET', '/rest/system/ping', null, 2000).then(() => 'ok', () => 'no'), exited.then(() => 'exit')]);
      if (r === 'ok') break;
      if (r === 'exit') throw new Error('SYNCTHING: Syncthing stopped at once' + (tail ? `: ${tail.trim().split('\n').pop().slice(0, 200)}` : '.'));
      if (Date.now() - t0 > 30000) throw new Error('SYNCTHING: Syncthing did not answer within 30 seconds.');
      await sleep(300);
    }
    const st = await this.req('GET', '/rest/system/status');
    const ver = await this.req('GET', '/rest/system/version').catch(() => ({}));
    this.version = (ver && ver.version) || '';
    this.myId = st.myID;
    const t = this.o.testing;
    await this.req('PATCH', '/rest/config/options', Object.assign({
      urAccepted: -1,                // no usage report
      crashReportingEnabled: false,
      autoUpgradeIntervalH: 0,
      startBrowser: false,
      globalAnnounceEnabled: !t,     // find the other filo across the internet…
      localAnnounceEnabled: true,    // …or on the same network
      relaysEnabled: !t,             // a relay when no direct path exists
      natEnabled: !t,                // ask the router to open the port (UPnP / NAT-PMP)
      progressUpdateIntervalS: 2,    // the LIVE SYNC queue: each file's progress every 2 s
    }, t ? { listenAddresses: t.listen } : {}));
    try { await this.req('PATCH', `/rest/config/devices/${this.myId}`, { name: this.o.name || deviceName() }); } catch (_) {}
    this.log('info', `SYNCTHING: ready (Syncthing ${this.version}, this computer ${shortId(this.myId)})`);
    this._eventLoop();
    this._schedule();
    return this.myId;
  }

  // First start: keys and configuration. The GUI password is random and
  // forgotten: the web interface stays locked, filo uses the API key.
  _generate() {
    return new Promise((res, rej) => {
      const c = spawn(this.bin, ['generate', '--home', this.home, '--gui-user', 'filo', '--gui-password', '-'], { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true });
      let err = '';
      c.stderr.on('data', b => { err = (err + b).slice(-2000); });
      c.once('error', rej);
      c.once('exit', code => code === 0 ? res() : rej(new Error(`SYNCTHING: Syncthing could not create its configuration (${err.trim().split('\n').pop() || code})`)));
      c.stdin.end(crypto.randomBytes(24).toString('base64') + '\n');
    });
  }

  // A Syncthing left by an earlier filo that did not quit properly (a crash,
  // a forced quit): asked to stop, with our key, before a new one starts.
  async _stopStale() {
    let run = null;
    try { run = JSON.parse(fs.readFileSync(path.join(this.home, 'filo-run.json'), 'utf8')); } catch (_) { return; }
    if (!run || !run.gui) return;
    // Syncthing runs as two processes (a monitor and its worker): the worker
    // may live on even when the recorded process is gone, so it is asked
    // through its API, which only answers to our key.
    // First, without the key: is it a Syncthing at all? (After a restart,
    // another program may listen on that port: it never gets the key.)
    if (!(await this._isSyncthing(run.gui))) return;
    const ours = await this.req('POST', '/rest/system/shutdown', null, 2000, run.gui).then(() => true, () => false);
    if (!ours) return;
    this.log('info', 'SYNCTHING: stopping the Syncthing left by the previous filo');
    for (let i = 0; i < 50; i++) {
      const up = await this.req('GET', '/rest/system/ping', null, 1000, run.gui).then(() => true, () => false);
      if (!up && !(run.pid && alive(run.pid))) break;
      await sleep(200);
    }
    await sleep(300);
  }

  // Syncthing's usual port (22000), or the next free one when another
  // program (a Syncthing of the user's own) has it. Kept from one start to
  // the next: the router and the other filo remember it.
  async _listenAddresses(cfgFile) {
    if (this.o.testing) return;
    const keep = path.join(this.home, 'filo-port');
    let port = parseInt((() => { try { return fs.readFileSync(keep, 'utf8'); } catch (_) { return ''; } })(), 10) || LISTEN_PORT;
    if (!(await portFree(port))) {
      for (let p = LISTEN_PORT; p < LISTEN_PORT + 100; p++) if (await portFree(p)) { port = p; break; }
    }
    try { fs.writeFileSync(keep, String(port)); } catch (_) {}
    this.listenPort = port;
    const want = port === LISTEN_PORT ? ['default']
      : [`tcp://0.0.0.0:${port}`, `quic://0.0.0.0:${port}`, 'dynamic+https://relays.syncthing.net/endpoint'];
    let xml = fs.readFileSync(cfgFile, 'utf8');
    const now = [...xml.matchAll(/<listenAddress>([^<]*)<\/listenAddress>/g)].map(x => x[1]);
    if (JSON.stringify(now) === JSON.stringify(want)) return;
    const first = xml.search(/[ \t]*<listenAddress>/);
    if (first < 0) return;
    xml = xml.replace(/[ \t]*<listenAddress>[^<]*<\/listenAddress>\r?\n?/g, '');
    const indent = '        ';
    xml = xml.slice(0, first) + want.map(a => `${indent}<listenAddress>${a}</listenAddress>\n`).join('') + xml.slice(first);
    fs.writeFileSync(cfgFile, xml, { mode: 0o600 });
    if (port !== LISTEN_PORT) this.log('info', `SYNCTHING: port ${LISTEN_PORT} is taken on this computer, ${port} is used instead`);
  }

  _exited(child, code, sig, tail) {
    if (this.child !== child) return;
    this.child = null;
    this.myId = null;
    this.ready = null;
    this._unschedule();
    if (this.stopping) return;
    const last = (tail || '').trim().split('\n').pop() || '';
    this.log('error', `SYNCTHING: Syncthing stopped (${sig || code})${last ? ': ' + last.slice(0, 200) : ''}`);
    // Restarted, three times at most in ten minutes.
    const now = Date.now();
    this.restarts = this.restarts.filter(t => now - t < 600000);
    if (this.restarts.length >= 3) { this._allStatus({ state: 'error', error: 'SYNCTHING stopped several times: quit and reopen filo. The journal has the details.' }); return; }
    this.restarts.push(now);
    // A restart that fails is shown, not left as "connected".
    this._allStatus({ state: 'error', error: 'SYNCTHING stopped: restarting…' });
    setTimeout(() => {
      if (this.stopping || !this.want) return;
      this.reconcile(this.want.pairs, this.want.devices).catch(e => this._allStatus({ state: 'error', error: e.message }));
    }, 5000);
  }

  _kill() { try { if (this.child) this.child.kill(); } catch (_) {} }

  // Quit: Syncthing closes its database properly, then goes.
  async stop() {
    this.stopping = true;
    this.quit = true;
    this._unschedule();
    const c = this.child;
    if (!c) return;
    const gone = new Promise(res => c.once('exit', res));
    await this.req('POST', '/rest/system/shutdown', null, 2000).catch(() => {});
    const r = await Promise.race([gone.then(() => true), sleep(STOP_WAIT_MS).then(() => false)]);
    if (!r) this._kill();
    try { fs.unlinkSync(path.join(this.home, 'filo-run.json')); } catch (_) {}
  }

  // ── REST ───────────────────────────────────────────────────────────────
  _isSyncthing(port) {
    return new Promise(res => {
      const r = http.get({ host: '127.0.0.1', port, path: '/rest/noauth/health', timeout: 2000 }, resp => {
        let t = '';
        resp.on('data', c => { if (t.length < 200) t += c; });
        resp.on('end', () => { try { res(resp.headers['x-syncthing-version'] != null && JSON.parse(t).status === 'OK'); } catch (_) { res(false); } });
      });
      r.on('timeout', () => r.destroy());
      r.on('error', () => res(false));
    });
  }
  req(method, p, body, timeout, port) {
    return new Promise((res, rej) => {
      const data = body == null ? null : Buffer.from(JSON.stringify(body));
      const r = http.request({
        host: '127.0.0.1', port: port || this.guiPort, path: p, method,
        headers: Object.assign({ 'X-API-Key': this.key || '' }, data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}),
        timeout: timeout || 15000,
      }, resp => {
        const chunks = [];
        resp.on('data', c => chunks.push(c));
        resp.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if (resp.statusCode >= 400) return rej(Object.assign(new Error(`${resp.statusCode} ${text.trim().slice(0, 200)}`), { status: resp.statusCode }));
          if (!text) return res(null);
          try { res(JSON.parse(text)); } catch (_) { res(text); }
        });
      });
      r.on('timeout', () => r.destroy(new Error('timeout')));
      r.on('error', rej);
      if (data) r.write(data);
      r.end();
    });
  }

  // ── Configuration: what filo wants, written into Syncthing ─────────────
  // pairs: the SYNCTHING live syncs; devices: the other filo accepted.
  reconcile(pairs, devices) {
    this.want = { pairs: pairs || [], devices: devices || [] };
    const job = this.chain.then(() => this._reconcile());
    this.chain = job.catch(() => {});
    return job;
  }

  async _reconcile() {
    const { pairs, devices } = this.want;
    if (this.quit) return;
    if (!pairs.length && !devices.length && !this.child) return;
    await this.start();
    const cfg = await this.req('GET', '/rest/config');
    // Devices: every accepted one, and the other side of every pair.
    const wantDev = new Map();
    for (const d of devices) wantDev.set(d.id, d.name);
    for (const p of pairs) if (p.peer) wantDev.set(p.peer.id, wantDev.get(p.peer.id) || p.peer.name);
    const haveDev = new Map((cfg.devices || []).map(d => [d.deviceID, d]));
    for (const [id, name] of wantDev) {
      if (id === this.myId) continue;
      if (!haveDev.has(id)) {
        // No name yet (added by its pasted ID): Syncthing takes the one the
        // computer announces when it connects ('peername').
        await this.req('POST', '/rest/config/devices', { deviceID: id, name: name || '', addresses: this._addresses(id), compression: 'metadata', introducer: false, autoAcceptFolders: false, paused: false });
        this.log('info', `SYNCTHING: ${name || shortId(id)} (${shortId(id)}) added`);
      }
    }
    for (const id of haveDev.keys()) {
      if (id !== this.myId && !wantDev.has(id)) { await this.req('DELETE', `/rest/config/devices/${id}`); this.log('info', `SYNCTHING: ${haveDev.get(id).name || shortId(id)} forgotten`); }
    }
    // Folders: one per pair.
    const haveFolder = new Map((cfg.folders || []).map(f => [f.id, f]));
    const missingNow = new Set();
    for (let p of pairs) {
      if (!p.folderId || !p.local) continue;
      if (localMissing(p)) {
        missingNow.add(p.id);
        if (!(this.missingLocal && this.missingLocal.has(p.id))) this.log('warn', `SYNCTHING: “${p.name}”: the local folder is missing (${p.local}): paused, nothing created`);
        const h = haveFolder.get(p.folderId);
        if (h && !h.paused) await this.req('PATCH', `/rest/config/folders/${p.folderId}`, { paused: true });
        continue;
      }
      const want = {
        label: p.name, path: p.local, type: TYPE[p.direction] || 'sendreceive',
        devices: p.peer ? [{ deviceID: p.peer.id }] : [],
        paused: !p.auto || this.held.has(p.folderId),
        // Files go in name order (Noar, 12/10/2026): the LIVE SYNC queue
        // then moves from the top on both computers (random, Syncthing's
        // default, left the first names waiting while others arrived), and a
        // folder of clips arrives in its order. Syncthing's random order only
        // helps when many computers share one folder: filo pairs two.
        order: 'alphabetic',
        fsWatcherEnabled: true, fsWatcherDelayS: 10,
        rescanIntervalS: 3600,
        // A file deleted on one computer is deleted on the other too, but
        // goes into that computer's trash first (Noar, 11/10/2026): never
        // lost, never synced (a hidden folder of the synced folder, on the
        // same disk, so a 50 GB file is moved, not copied). Kept forever.
        ignoreDelete: false,
        versioning: { type: 'trashcan', fsPath: path.join(p.local, TRASH), fsType: 'basic', params: { cleanoutDays: '0' }, cleanupIntervalS: 0 },
        maxConflicts: -1,            // both versions, always
      };
      const have = haveFolder.get(p.folderId);
      if (!have) {
        // Created paused: the exclusions (the trash first) are in place
        // before Syncthing looks at a single file.
        await this.req('POST', '/rest/config/folders', Object.assign({ id: p.folderId }, want, { paused: true }));
        let ign = true;
        try { await this._ignores(p); } catch (e) { ign = false; this.log('error', `SYNCTHING: “${p.name}”: exclusions not applied (${e.message}): kept paused`); }
        if (ign && !want.paused) await this.req('PATCH', `/rest/config/folders/${p.folderId}`, { paused: false });
        this.log('info', `SYNCTHING: “${p.name}” set up (${p.local})`);
        p = Object.assign({}, p, { _ignored: true });
      } else {
        const devs = (have.devices || []).map(d => d.deviceID).filter(id => id !== this.myId).sort().join(',');
        const differs = have.label !== want.label || have.path !== want.path || have.type !== want.type || have.paused !== want.paused
          || have.ignoreDelete !== false || have.maxConflicts !== -1 || have.order !== 'alphabetic' || have.fsWatcherEnabled !== true
          || !have.versioning || have.versioning.type !== 'trashcan' || have.versioning.fsPath !== want.versioning.fsPath
          || devs !== want.devices.map(d => d.deviceID).sort().join(',');
        if (differs) await this.req('PATCH', `/rest/config/folders/${p.folderId}`, want);
      }
      if (!p._ignored) await this._ignores(p).catch(e => this.log('warn', `SYNCTHING: “${p.name}”: exclusions not applied (${e.message})`));
      // The control folder: a few bytes in filo's profile, shared with the
      // other computer, where the MASTER writes the session's settings and
      // the SLAVE reads them (the session folder itself may be send only or
      // receive only, the control folder always goes both ways).
      if (p.peer) {
        const cid = ctlId(p.folderId), cdir = this.ctlDir(p);
        try { fs.mkdirSync(cdir, { recursive: true }); } catch (_) {}
        const cw = { label: `${p.name} (filo settings)`, path: cdir, type: 'sendreceive', devices: [{ deviceID: p.peer.id }], paused: !p.auto, fsWatcherEnabled: true, fsWatcherDelayS: 1, rescanIntervalS: 60, ignoreDelete: true, maxConflicts: 0 };
        const ch = haveFolder.get(cid);
        if (!ch) await this.req('POST', '/rest/config/folders', Object.assign({ id: cid }, cw));
        else if (ch.paused !== cw.paused || ch.path !== cw.path || ch.label !== cw.label) await this.req('PATCH', `/rest/config/folders/${cid}`, cw);
      }
    }
    const ids = new Set(pairs.map(p => p.folderId).concat(pairs.filter(p => p.peer).map(p => ctlId(p.folderId))));
    for (const id of haveFolder.keys()) {
      if ((id.startsWith(PREFIX) || id.startsWith(CTL_PREFIX)) && !ids.has(id)) { await this.req('DELETE', `/rest/config/folders/${id}`); this.log('info', `SYNCTHING: “${haveFolder.get(id).label || id}” removed (no file touched)`); }
    }
    for (const id of (this.missingLocal || [])) if (!missingNow.has(id)) { const p = pairs.find(x => x.id === id); if (p) this.log('info', `SYNCTHING: “${p.name}”: the local folder is back, the session starts again`); }
    this.missingLocal = missingNow;
    this.labels = new Map(pairs.map(p => [p.folderId, p]));
    this._poll().catch(() => {});
  }

  // Found by the discovery servers and the local network. Tests give the
  // other instance's address instead (no discovery there).
  _addresses(id) {
    const t = this.o.testing;
    return t && t.addresses && t.addresses[id] ? [t.addresses[id]] : ['dynamic'];
  }

  // A file changed on both computers: Syncthing keeps the newer one under its
  // name and the other one beside it ("name.sync-conflict-<date>-<ID>.ext").
  // Here the MASTER's version wins (Noar, 11/10/2026). Which version a copy
  // holds is not in its name (Syncthing's label is not reliable for that):
  // it is the computer the copy was created on, which Syncthing's index
  // tells (modifiedBy). A copy made on the MASTER holds the MASTER's own
  // version: the two swap, and the MASTER's gets today's date (Syncthing
  // keeps the newest, so it stays). Every copy beside gets the name of the
  // computer it came from. Only the MASTER renames: the two never fight.
  // Looked at a few seconds after each file event (the copy must be indexed).
  masterWins(p, rel) {
    const again = (ms) => { const t = setTimeout(() => this._masterWins(p, rel).catch(() => {}), ms); if (t.unref) t.unref(); };
    again(3000); again(12000);
  }
  async _masterWins(p, rel) {
    const sub = path.dirname(rel) === '.' ? '' : path.dirname(rel);
    const dir = path.join(p.local, ...sub.split('/').filter(Boolean));
    const b = path.basename(rel);
    const m0 = CONFLICT.exec(b);
    const main = m0 ? m0[1] + (m0[4] || '') : b;
    const peerHost = String(p.peer.name || '').split(' · ')[0] || shortId(p.peer.id);
    const safe = h => String(h).replace(/[^A-Za-z0-9_-]+/g, '-');
    const me = shortId(this.myId || '');
    let list = [];
    try { list = fs.readdirSync(dir); } catch (_) { return; }
    for (const f of list) {
      const c = CONFLICT.exec(f);
      if (!c || c[1] + (c[4] || '') !== main) continue;
      const relF = (sub ? sub + '/' : '') + f;
      const info = await this.req('GET', `/rest/db/file?folder=${encodeURIComponent(p.folderId)}&file=${encodeURIComponent(relF)}`).catch(() => null);
      const by = info && info.local && info.local.modifiedBy;
      if (!by) continue;                                   // not indexed yet: the next look
      const cc = path.join(dir, f), mainPath = path.join(dir, main);
      let loser = path.join(dir, `${c[1]}.sync-conflict-${c[2]}-from-${safe(peerHost)}${c[4] || ''}`);
      for (let n = 2; fs.existsSync(loser) && n < 100; n++) loser = path.join(dir, `${c[1]}.sync-conflict-${c[2]}-from-${safe(peerHost)}-${n}${c[4] || ''}`);
      try {
        if (by === me) {
          if (fs.existsSync(mainPath)) fs.renameSync(mainPath, loser);
          fs.renameSync(cc, mainPath);
          const now = new Date(); fs.utimesSync(mainPath, now, now);
          this.log('info', `SYNCTHING · ${p.name}: ${(sub ? sub + '/' : '') + main} changed on both computers: the MASTER's version is kept, ${peerHost}'s is beside it`);
        } else {
          fs.renameSync(cc, loser);
        }
      } catch (e) { this.log('warn', `SYNCTHING · ${p.name}: ${relF}: ${e.message}`); }
    }
  }

  ctlDir(p) { return path.join(this.home, 'ctl', p.folderId); }

  async _ignores(p) {
    // The trash is never synced (it holds whole deleted files).
    const want = ['/' + TRASH].concat(toIgnore(require('./config').SYNC_ALWAYS_EXCLUDE + ', ' + (p.exclude || '')));
    const have = await this.req('GET', `/rest/db/ignores?folder=${encodeURIComponent(p.folderId)}`);
    const now = (have && have.ignore) || [];
    if (JSON.stringify(now) === JSON.stringify(want)) return;
    await this.req('POST', `/rest/db/ignores?folder=${encodeURIComponent(p.folderId)}`, { ignore: want });
  }

  async rescan(pair) {
    await this.start();
    await this.chain;              // a live sync just saved: set up first
    await this.req('POST', `/rest/db/scan?folder=${encodeURIComponent(pair.folderId)}`);
  }

  // Refuse another computer that asked to connect.
  async ignoreDevice(id, name) {
    await this.start();
    await this.req('POST', '/rest/config/remoteIgnoredDevices', [{ deviceID: id, name: name || '', time: new Date().toISOString() }]).catch(async () => {
      const cfg = await this.req('GET', '/rest/config');
      const list = (cfg.remoteIgnoredDevices || []).concat([{ deviceID: id, name: name || '', time: new Date().toISOString() }]);
      await this.req('PUT', '/rest/config/remoteIgnoredDevices', list);
    });
    this._poll().catch(() => {});
  }
  async dismissFolder(folderId, deviceId) {
    await this.req('DELETE', `/rest/cluster/pending/folders?folder=${encodeURIComponent(folderId)}&device=${encodeURIComponent(deviceId)}`).catch(() => {});
    this._poll().catch(() => {});
  }

  // PAUSE / RESUME from the LIVE SYNC queue (Noar, 12/10/2026): the session
  // stays connected, Syncthing stops moving its files (the folder paused on
  // this computer) until RESUME. Not kept: filo restarted resumes it, a
  // forgotten pause never stops a session for good.
  async hold(p, on) {
    if (!p || !p.folderId) return;
    if (on) this.held.add(p.folderId); else this.held.delete(p.folderId);
    await this.req('PATCH', `/rest/config/folders/${p.folderId}`, { paused: !p.auto || !!on });
    this.log('info', `SYNCTHING · ${p.name}: ${on ? 'paused' : 'resumed'}`);
    this._poll().catch(() => {});
  }
  isHeld(p) { return !!(p && this.held.has(p.folderId)); }

  // ── Watching ───────────────────────────────────────────────────────────
  setFast(on) { this.fast = !!on; if (this.running) this._schedule(); }
  _schedule() {
    this._unschedule();
    const gen = this.pollGen;
    const arm = ms => { this.pollTimer = setTimeout(tick, ms); if (this.pollTimer.unref) this.pollTimer.unref(); };
    // Only the newest loop goes on: one still polling when another started stops there.
    const tick = () => { this._poll().catch(() => {}).then(() => { if (this.running && gen === this.pollGen) arm(this.fast ? POLL_FAST_MS : POLL_SLOW_MS); }); };
    arm(500);
  }
  _unschedule() { this.pollGen++; if (this.pollTimer) clearTimeout(this.pollTimer); this.pollTimer = null; }

  async _poll() {
    if (!this.running || !this.want) return;
    const [conns, pd, pf] = await Promise.all([
      this.req('GET', '/rest/system/connections'),
      this.req('GET', '/rest/cluster/pending/devices').catch(() => ({})),
      this.req('GET', '/rest/cluster/pending/folders').catch(() => ({})),
    ]);
    const now = Date.now();
    const link = {};
    for (const [id, c] of Object.entries((conns && conns.connections) || {})) {
      const prev = this.rates.get(id);
      let rin = 0, rout = 0;
      if (prev && now > prev.at) { rin = Math.max(0, (c.inBytesTotal - prev.in) * 1000 / (now - prev.at)); rout = Math.max(0, (c.outBytesTotal - prev.out) * 1000 / (now - prev.at)); }
      this.rates.set(id, { at: now, in: c.inBytesTotal || 0, out: c.outBytesTotal || 0 });
      const type = String(c.type || '');
      link[id] = {
        connected: !!c.connected,
        via: !c.connected ? null : /relay/.test(type) ? 'relay' : c.isLocal ? 'lan' : 'internet',
        proto: /quic/.test(type) ? 'QUIC' : /relay/.test(type) ? 'relay' : 'TCP',
        address: c.address || '',
        inRate: Math.round(rin), outRate: Math.round(rout),
      };
    }
    this.links = link;

    // Other computers asking, and folders offered.
    const accepted = new Set(this.want.devices.map(d => d.id).concat(this.want.pairs.filter(p => p.peer).map(p => p.peer.id)));
    const devices = Object.entries(pd || {}).filter(([id]) => !accepted.has(id))
      .map(([id, v]) => ({ id, name: v.name || '', address: v.address || '', time: v.time || '' }));
    const folders = [];
    for (const [fid, v] of Object.entries(pf || {})) {
      for (const [dev, o] of Object.entries((v && v.offeredBy) || {})) {
        if (!accepted.has(dev)) continue;
        const pair = this.want.pairs.find(p => p.folderId === fid);
        if (pair) {
          // Our own live sync, offered back by the computer that imported its
          // code: the two are linked, nothing to ask.
          if (!pair.peer) this.emit('link', { pairId: pair.id, peer: { id: dev, name: this._nameOf(dev) } });
          else if (pair.peer.id !== dev && !(this.foreign || (this.foreign = new Set())).has(fid + dev)) { this.foreign.add(fid + dev); this.emit('foreign', { pairId: pair.id, dev }); }
          continue;
        }
        if (!fid.startsWith(PREFIX)) continue;
        folders.push({ folderId: fid, deviceId: dev, deviceName: this._nameOf(dev), name: o.label || fid, direction: directionOfOffer(fid), time: o.time || '' });
      }
    }
    this.pending = { devices, folders };
    // Names of computers added by their ID alone, as they announced them.
    if (this.want.pairs.some(p => p.peer && !p.peer.name) || this.want.devices.some(d => !d.name)) {
      const devs = await this.req('GET', '/rest/config/devices').catch(() => []);
      for (const d of Array.isArray(devs) ? devs : []) if (d.deviceID !== this.myId && d.name) this.emit('peername', { id: d.deviceID, name: d.name });
    }
    const pj = JSON.stringify(this.pending);
    if (pj !== this.lastPending) { this.lastPending = pj; this.emit('pending', this.pending); }

    // Each live sync.
    // A local folder gone or back (a disk unplugged or plugged in): written
    // into Syncthing again (paused while missing, nothing created).
    if (this.want.pairs.some(p => p.folderId && p.local && localMissing(p) !== !!(this.missingLocal && this.missingLocal.has(p.id)))) this.reconcile(this.want.pairs, this.want.devices).catch(() => {});
    for (const p of this.want.pairs) {
      if (!p.folderId) continue;
      let s;
      if (p.local && localMissing(p)) s = { direct: true, auto: !!p.auto, state: 'error', error: `The local folder is missing: ${p.local} (a disk not connected, or the folder moved or deleted?). The session waits; nothing is created or deleted.` };
      else try { s = await this._pairStatus(p, link); } catch (e) { s = { state: 'error', error: 'SYNCTHING: ' + e.message }; }
      const txt = JSON.stringify(s);
      if (this.status.get(p.id) !== txt) { this.status.set(p.id, txt); this.emit('status', p.id, s); }
      // The queue of the LIVE SYNC view, while it is shown.
      if (this.fast) {
        const qq = await this._pairQueue(p, link).catch(() => null);
        const qt = qq && JSON.stringify(qq);
        if (qt && (this.queues || (this.queues = new Map())).get(p.id) !== qt) { this.queues.set(p.id, qt); this.emit('queue', p.id, qq); }
      }
    }
  }

  // ── The LIVE SYNC queue (Noar, 12/10/2026): which files move, which wait ─
  _act(fid) { let a = this.act.get(fid); if (!a) { a = { dl: {}, rdl: {}, done: [], upPrev: new Map() }; this.act.set(fid, a); } return a; }
  _done(fid, it) {
    const a = this._act(fid);
    a.done = [Object.assign({ at: Date.now() }, it)].concat(a.done.filter(x => x.rel !== it.rel || x.dir !== it.dir)).slice(0, 40);
  }
  // What this folder still has to receive (need) and to send (the other
  // computer's need), with the progress of the files moving now.
  async _pairQueue(p, link) {
    const q = encodeURIComponent(p.folderId);
    const a = this._act(p.folderId);
    const items = [];
    const need = await this.req('GET', `/rest/db/need?folder=${q}&page=1&perpage=100`).catch(() => null);
    if (need) {
      const add = (list, running) => {
        for (const f of list || []) {
          if (!f || f.type === 'FILE_INFO_TYPE_DIRECTORY' || f.type === 1 || f.deleted) continue;
          const pr = a.dl[f.name];
          items.push({ rel: f.name, size: f.size || 0, dir: 'down', status: pr || running ? 'running' : 'queued', done: pr ? pr.bytesDone || 0 : 0 });
        }
      };
      add(need.progress, true); add(need.queued, false); add(need.rest, false);
    }
    const peerOn = p.peer && link[p.peer.id] && link[p.peer.id].connected;
    if (peerOn) {
      const rn = await this.req('GET', `/rest/db/remoteneed?folder=${q}&device=${encodeURIComponent(p.peer.id)}&page=1&perpage=100`).catch(() => null);
      const list = rn ? (rn.files || []).concat(rn.progress || [], rn.queued || [], rn.rest || []) : [];
      const now = new Map();
      for (const f of list) {
        if (!f || f.deleted || f.type === 'FILE_INFO_TYPE_DIRECTORY' || f.type === 1) continue;
        const blocks = a.rdl[f.name];
        const size = f.size || 0;
        const done = blocks != null ? Math.min(size, blocks * blockSize(size)) : 0;
        now.set(f.name, size);
        items.push({ rel: f.name, size, dir: 'up', status: blocks != null ? 'running' : 'queued', done });
      }
      // Gone from the other computer's need while it was there: sent.
      for (const [rel, size] of a.upPrev) if (!now.has(rel)) this._done(p.folderId, { rel, dir: 'up', status: 'done', size });
      a.upPrev = now;
    }
    // Just finished, still in Syncthing's lists for a moment: shown done only.
    const fresh = new Set(a.done.filter(d => Date.now() - d.at < 15000).map(d => d.dir + ':' + d.rel));
    for (let i = items.length - 1; i >= 0; i--) if (fresh.has(items[i].dir + ':' + items[i].rel)) items.splice(i, 1);
    items.sort((x, y) => (x.status === 'running' ? 0 : 1) - (y.status === 'running' ? 0 : 1));
    return { items: items.slice(0, 100), done: a.done.slice(0, 30) };
  }

  _nameOf(id) {
    const d = this.want.devices.find(x => x.id === id) || (this.want.pairs.find(p => p.peer && p.peer.id === id) || {}).peer;
    return (d && d.name) || shortId(id);
  }

  async _pairStatus(p, link) {
    const q = encodeURIComponent(p.folderId);
    const db = await this.req('GET', `/rest/db/status?folder=${q}`);
    const s = {
      direct: true,
      auto: !!p.auto,
      folderState: db.state || '',          // idle, scanning, syncing, sync-preparing, error…
      needBytes: db.needBytes || 0,         // what this computer still has to receive
      needFiles: db.needFiles || 0,
      globalBytes: db.globalBytes || 0,
      localBytes: db.localBytes || 0,
      localFiles: db.localFiles || 0,
      globalFiles: db.globalFiles || 0,
      errors: db.errors || db.pullErrors || 0,
    };
    if (db.state === 'error' || db.error) { s.state = 'error'; s.error = folderError(db.error || ''); }
    if (s.errors) {
      const fe = await this.req('GET', `/rest/folder/errors?folder=${q}`).catch(() => null);
      s.fileErrors = ((fe && fe.errors) || []).slice(0, 20).map(e => ({ path: e.path, error: e.error }));
    }
    if (!p.peer) { s.state = s.state || 'waiting'; s.peer = null; return s; }
    const l = link[p.peer.id] || { connected: false };
    s.peer = Object.assign({ id: p.peer.id, name: p.peer.name }, l);
    if (l.connected) {
      const c = await this.req('GET', `/rest/db/completion?folder=${q}&device=${encodeURIComponent(p.peer.id)}`).catch(() => null);
      if (c) { s.peerCompletion = Math.floor(c.completion * 10) / 10; s.peerNeedBytes = c.needBytes || 0; s.peerNeedFiles = c.needItems || 0; }
      // Does the other computer share this folder with us? (valid, notSharing,
      // paused, unknown). An older Syncthing without it: taken as shared.
      s.peerShares = c ? (c.remoteState || 'valid') : 'unknown';
    }
    if (!s.state) {
      s.state = !p.auto ? 'paused'
        : this.held.has(p.folderId) ? 'held'
        : !l.connected ? 'offline'
        : s.peerShares === 'notSharing' ? 'waiting'
        : /scan/.test(db.state) ? 'scanning'
        : (db.state === 'syncing' || db.state === 'sync-preparing' || s.needBytes > 0 || (s.peerNeedBytes || 0) > 0) ? 'syncing'
        : 'insync';
    }
    return s;
  }

  _allStatus(s) {
    for (const p of (this.want && this.want.pairs) || []) { this.status.set(p.id, JSON.stringify(s)); this.emit('status', p.id, s); }
  }

  // Each file that arrives goes to filo's journal; a failure too.
  async _eventLoop() {
    // One loop per Syncthing process: a restarted one gets its own.
    const child = this.child;
    if (!child || this.evChild === child) return;
    this.evChild = child;
    // A filtered event stream numbers its events itself (`id`), from the
    // moment it is first asked for: it starts at 0, never at a global number.
    let since = 0;
    while (this.running && this.child === child) {
      let evs;
      try { evs = await this.req('GET', `/rest/events?events=ItemFinished,FolderErrors,DownloadProgress,RemoteDownloadProgress&since=${since}&timeout=50`, null, 70000); }
      catch (_) { await sleep(2000); continue; }
      if (this.child !== child) break;
      for (const e of Array.isArray(evs) ? evs : []) {
        since = Math.max(since, Number(e.id) || 0);
        const d = e.data || {};
        // The files being received here, with their bytes (every folder at
        // once: one that is absent has none in progress).
        if (e.type === 'DownloadProgress') {
          for (const [fid, a] of this.act) if (!d[fid]) a.dl = {};
          for (const [fid, files] of Object.entries(d)) this._act(fid).dl = files || {};
          continue;
        }
        // The files the other computer is receiving from here, in blocks.
        if (e.type === 'RemoteDownloadProgress') { if (d.folder) this._act(d.folder).rdl = d.state || {}; continue; }
        // The control folder: the MASTER's settings arrived (direct-app.js).
        if (String(d.folder || '').startsWith(CTL_PREFIX)) {
          const owner = this.want && this.want.pairs.find(x => ctlId(x.folderId) === d.folder);
          if (owner && e.type === 'ItemFinished' && !d.error) this.emit('ctl', { pairId: owner.id });
          continue;
        }
        const p = this.labels && this.labels.get(d.folder);
        const name = p ? p.name : d.folder;
        if (e.type === 'ItemFinished' && d.type !== 'dir') {
          if (d.error) this.log('warn', `SYNCTHING · ${name}: ${d.item}: ${d.error}`);
          else if (d.action === 'update') this.log('info', `SYNCTHING · ${name}: received ${d.item}`);
          else if (d.action === 'delete') this.log('info', `SYNCTHING · ${name}: ${d.item} deleted on the other computer, moved to this computer's trash (${TRASH})`);
          this.emit('item', { pairId: p && p.id, item: d.item, error: d.error || null, action: d.action });
          if (d.action === 'update') this._done(d.folder, { rel: d.item, dir: 'down', status: d.error ? 'failed' : 'done', error: d.error || null });
        }
        if (e.type === 'FolderErrors') for (const fe of d.errors || []) this.log('warn', `SYNCTHING · ${name}: ${fe.path}: ${fe.error}`);
      }
    }
    if (this.evChild === child) this.evChild = null;
  }
}

// Syncthing's block size for a file (lib/protocol: the smallest of 128 KiB…
// 16 MiB that gives fewer than 2000 blocks): turns the blocks the other
// computer has received into bytes.
function blockSize(size) {
  for (let b = 128 * 1024; b < 16 * 1024 * 1024; b *= 2) if (size < 2000 * b) return b;
  return 16 * 1024 * 1024;
}

// Syncthing's folder errors, in filo's words when they are the usual ones.
function folderError(e) {
  if (/folder marker missing|\.stfolder/i.test(e)) return 'The local folder is missing or was replaced (is the disk connected?). Nothing was deleted on the other side.';
  if (/no such file|not exist/i.test(e)) return 'The local folder does not exist (is the disk connected?).';
  if (/permission denied|access is denied/i.test(e)) return 'filo is not allowed to write in the local folder.';
  if (/space on disk for database/i.test(e)) return 'Not enough free space on the system disk (SYNCTHING keeps its index in filo\'s profile, and needs at least 1 % free).';
  if (/insufficient space|free space/i.test(e)) return 'Not enough free space in the local folder.';
  return e;
}

module.exports = { TRASH, ctlId, Direct, binPath, newFolderId, directionOfOffer, toIgnore, shortId, parseDeviceId, deviceName, hostName, osLabel, OTHER };
