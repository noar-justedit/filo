/*
 * filo — FTP, FTPS and SFTP client
 * Copyright (C) 2026 Just Edit (Arnaud Augst)
 * Licensed under the GNU General Public License v3.0 or later. See LICENSE.
 */

// Servers shared on the local network. On a job, one computer
// has filo set up with every server; the others have nothing. With "Share my
// servers on this network" on, that computer answers the others: they see its
// list in MY SERVERS › SHARED SERVERS, read-only, and connect from it.
//
// What leaves: the list as an export without passwords (sites.exportFilo with
// no secrets: names, folders, protocol, host, port, user, folders at login,
// notes). Never a passphrase or a key; a key login is shown as such, the key
// stays on its computer.
//
// The passwords, only with the PIN (Noar, 19/11/2026): the sharing computer
// sets a 4-digit PIN, kept until it is changed (main keeps it between runs).
// The computer that looks types it; the sharing computer checks it itself (a
// PIN never travels, only a proof of it), at most 5 wrong in a row then 30 s
// of wait, and 20 wrong in all cancel the PIN. Right, it sends the passwords,
// encrypted. The encryption key comes from a key exchange made for that one
// request (X25519) and from the PIN: someone listening on the network sees
// neither, and cannot try PINs on what they recorded. What this does not
// stop: someone who takes over the network between the two computers (a
// "man in the middle") can find the PIN; that needs a heavier protocol
// (PAKE), not worth a dependency here.
//
// How, with nothing but Node:
//   - finding: the computer looking sends one small UDP message to the
//     network's broadcast addresses, port SHARE_PORT; each sharing filo
//     answers it directly. Only the sharing computer listens: the one
//     looking opens nothing (no firewall question there).
//   - the list: a plain HTTP GET on the sharing computer, port SHARE_PORT
//     (TCP), one path. Not encrypted: it carries no secret, and an HTTPS
//     certificate nobody can check would only pretend to protect it.
//   - both ends only talk to addresses of a local network (private,
//     link-local, loopback): a computer on a public address (a hotel's,
//     an exposed server) never hands its list to the Internet.
//
// Two separate halves: Sharer (the computer that shares) and discover/fetch
// (the computer that looks). The test suite runs both on 127.0.0.1.

const dgram = require('dgram');
const http = require('http');
const os = require('os');
const crypto = require('crypto');

const SHARE_PORT = 47731;
const ASK = 'filo-share-ask/1';
const ANSWER = 'filo-share-answer/1';
const LIST_PATH = '/filo-share/servers';
const HELLO_PATH = '/filo-share/hello';
const UNLOCK_PATH = '/filo-share/unlock';
const PIN_RE = /^\d{4}$/;
const WRONG_IN_A_ROW = 5;                 // then a wait of…
const WAIT_MS = 30000;
const WRONG_IN_ALL = 20;                  // then the PIN is cancelled
const HELLO_TTL = 60000;                  // a key exchange is good for one minute
const MAX_BODY = 4096;
const MAX_LIST = 4 * 1024 * 1024;        // a list bigger than this is not filo's
const ID_RE = /^[0-9a-f]{16}$/;

// A local network address: 10/8, 172.16/12, 192.168/16, 169.254/16 (link-
// local), 127/8, 100.64/10 (carrier NAT, also some VPNs), and their IPv6
// equivalents (fc00::/7, fe80::/10, ::1). IPv4 seen through IPv6 (::ffff:)
// is read as IPv4.
function isLocalAddress(a) {
  let s = String(a || '').toLowerCase();
  if (s.startsWith('::ffff:')) s = s.slice(7);
  const m = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(s);
  if (m) {
    const x = +m[1], y = +m[2];
    return x === 10 || x === 127 || (x === 172 && y >= 16 && y <= 31) || (x === 192 && y === 168) || (x === 169 && y === 254) || (x === 100 && y >= 64 && y <= 127);
  }
  return s === '::1' || /^f[cd][0-9a-f]{2}:/.test(s) || /^fe[89ab][0-9a-f]:/.test(s);
}

// Where to send the question: every IPv4 network this computer is on (its
// broadcast address, from address and mask), and 255.255.255.255.
function broadcastAddresses(ifaces) {
  const out = new Set(['255.255.255.255']);
  for (const list of Object.values(ifaces || os.networkInterfaces())) {
    for (const i of list || []) {
      if (i.family !== 'IPv4' && i.family !== 4) continue;
      if (i.internal || !i.netmask) continue;
      const a = i.address.split('.').map(Number), m = i.netmask.split('.').map(Number);
      if (a.length !== 4 || m.length !== 4) continue;
      out.add(a.map((x, k) => (x | (~m[k] & 255)) & 255).join('.'));
    }
  }
  return [...out];
}

// The name shown to the others: the computer's name, without ".local".
function machineName() { return String(os.hostname() || 'filo').replace(/\.local$/i, '').slice(0, 80); }

// ── The computer that shares ───────────────────────────────────────────────
// getList(): the JSON text to hand out (an export without passwords), or a
// promise of it, read at each request so a server added a second ago is there. info(): { id, name,
// count }. opts.port: SHARE_PORT unless a test gives another; opts.host: the
// address to listen on (all of them by default).
class Sharer {
  constructor(getList, info, opts) {
    this.getList = getList;
    this.info = info;
    this.opts = opts || {};
    this.udp = null;
    this.http = null;
    this.port = 0;           // the TCP port the list is served on
    this.pin = null;         // the passwords' PIN
    this.wrong = 0;          // wrong PINs in a row
    this.wrongAll = 0;       // wrong PINs since this PIN was set
    this.waitUntil = 0;
    this.hellos = new Map(); // key exchange id → { secret, until }
  }

  // A new PIN (the wrong tries start again from zero).
  setPin(pin) {
    if (!PIN_RE.test(String(pin))) throw new Error('The PIN is 4 digits.');
    Object.assign(this, { pin: String(pin), wrong: 0, wrongAll: 0, waitUntil: 0 });
    this.hellos.clear();
  }
  clearPin() { this.pin = null; this.hellos.clear(); }

  async start() {
    const port = this.opts.port != null ? this.opts.port : SHARE_PORT;
    const host = this.opts.host || undefined;
    this.http = http.createServer((req, res) => this._serve(req, res));
    this.http.on('clientError', (_, sock) => { try { sock.destroy(); } catch (_) {} });
    await new Promise((resolve, reject) => {
      this.http.once('error', reject);
      this.http.listen(port, host, () => { this.http.removeListener('error', reject); resolve(); });
    });
    this.port = this.http.address().port;
    this.udp = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.udp.on('message', (msg, from) => this._answer(msg, from));
    this.udp.on('error', () => {});
    await new Promise((resolve, reject) => {
      this.udp.once('error', reject);
      this.udp.bind(this.opts.udpPort != null ? this.opts.udpPort : port, host, () => { this.udp.removeListener('error', reject); resolve(); });
    });
    this.udpPort = this.udp.address().port;
    return this;
  }

  _answer(msg, from) {
    if (!isLocalAddress(from.address) || msg.length > 512) return;
    let q;
    try { q = JSON.parse(msg.toString('utf8')); } catch (_) { return; }
    if (!q || q.t !== ASK || typeof q.n !== 'string' || q.n.length > 64) return;
    const i = this.info();
    const a = Buffer.from(JSON.stringify({ t: ANSWER, n: q.n, id: i.id, name: i.name, count: i.count, port: this.port, pin: !!this.pin }));
    try { this.udp.send(a, from.port, from.address); } catch (_) {}
  }

  async _serve(req, res) {
    const reply = (code, obj) => {
      const b = Buffer.from(typeof obj === 'string' ? obj : JSON.stringify(obj || {}), 'utf8');
      res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': b.length, 'Cache-Control': 'no-store' });
      res.end(b);
    };
    if (!isLocalAddress(req.socket.remoteAddress)) { res.writeHead(404); res.end(); return; }
    try {
      if (req.method === 'GET' && req.url === LIST_PATH) return reply(200, await this.getList());
      if (req.method === 'POST' && req.url === HELLO_PATH) return reply(...this._hello(await readJson(req)));
      if (req.method === 'POST' && req.url === UNLOCK_PATH) return reply(...await this._unlock(await readJson(req), req.socket.remoteAddress));
    } catch (_) { return reply(400, { error: 'bad request' }); }
    res.writeHead(404); res.end();
  }

  // Step 1: a key exchange for this one request. → [status, body]
  _hello(q) {
    if (!this.pin) return [409, { error: 'no-pin' }];
    const theirs = Buffer.from(String(q.pub || ''), 'base64');
    if (theirs.length !== 32) return [400, { error: 'bad request' }];
    const now = Date.now();
    for (const [k, v] of this.hellos) if (v.until < now) this.hellos.delete(k);
    if (this.hellos.size >= 32) return [429, { wait: 5 }];
    const mine = crypto.generateKeyPairSync('x25519');
    const secret = crypto.diffieHellman({ privateKey: mine.privateKey, publicKey: x25519Public(theirs) });
    const sid = crypto.randomBytes(16).toString('hex');
    this.hellos.set(sid, { secret, until: now + HELLO_TTL });
    return [200, { sid, pub: rawPublic(mine.publicKey).toString('base64') }];
  }

  // Step 2: the proof of the PIN, and the passwords if it is right. Each key
  // exchange serves once, right or wrong.
  async _unlock(q, address) {
    const h = this.hellos.get(String(q.sid || ''));
    this.hellos.delete(String(q.sid || ''));
    if (!this.pin) return [409, { error: 'no-pin' }];
    const now = Date.now();
    if (now < this.waitUntil) return [429, { wait: Math.ceil((this.waitUntil - now) / 1000) }];
    if (!h || h.until < now) return [400, { error: 'expired' }];
    const keys = deriveKeys(h.secret, this.pin, q.sid);
    const proof = Buffer.from(String(q.proof || ''), 'base64');
    const expected = crypto.createHmac('sha256', keys.proof).update('filo-share-proof').digest();
    if (proof.length !== expected.length || !crypto.timingSafeEqual(proof, expected)) {
      this.wrong++; this.wrongAll++;
      if (this.wrongAll >= WRONG_IN_ALL) {
        this.clearPin();
        if (this.opts.onPinCancelled) this.opts.onPinCancelled({ address });
        return [403, { error: 'cancelled' }];
      }
      if (this.wrong >= WRONG_IN_A_ROW) { this.wrong = 0; this.waitUntil = now + WAIT_MS; return [403, { error: 'wrong', wait: WAIT_MS / 1000 }]; }
      return [403, { error: 'wrong', left: WRONG_IN_A_ROW - this.wrong }];
    }
    const secrets = JSON.stringify(await this.opts.getSecrets());
    this.wrong = 0;
    const name = String(q.name || '').replace(/[\u0000-\u001f]/g, '').slice(0, 80) || address;
    if (this.opts.onPinUsed) this.opts.onPinUsed({ name, address });
    return [200, seal(keys.data, secrets, q.sid)];
  }

  async stop() {
    const u = this.udp, h = this.http;
    this.udp = null; this.http = null;
    if (u) await new Promise(r => { try { u.close(r); } catch (_) { r(); } });
    if (h) await new Promise(r => { h.close(() => r()); if (h.closeAllConnections) h.closeAllConnections(); });
  }
}

// ── The computer that looks ────────────────────────────────────────────────
// → [{ id, name, count, address, port }], one per computer (the first answer
// wins), without this computer's own id. opts.targets / opts.port: tests.
function discover(opts) {
  const o = opts || {};
  const wait = o.waitMs || 1200;
  const nonce = crypto.randomBytes(8).toString('hex');
  const port = o.port || SHARE_PORT;
  const targets = o.targets || broadcastAddresses();
  return new Promise(resolve => {
    const found = new Map();
    let sock;
    const done = () => { try { sock.close(); } catch (_) {} resolve([...found.values()]); };
    try { sock = dgram.createSocket('udp4'); } catch (_) { return resolve([]); }
    sock.on('error', () => {});
    sock.on('message', (msg, from) => {
      if (!isLocalAddress(from.address) || msg.length > 2048) return;
      let a;
      try { a = JSON.parse(msg.toString('utf8')); } catch (_) { return; }
      if (!a || a.t !== ANSWER || a.n !== nonce || !ID_RE.test(String(a.id)) || a.id === o.selfId) return;
      const p = Number(a.port);
      if (!Number.isInteger(p) || p < 1 || p > 65535 || found.has(a.id)) return;
      found.set(a.id, { id: a.id, name: String(a.name || from.address).slice(0, 80), count: Math.max(0, parseInt(a.count, 10) || 0), address: from.address, port: p, pin: a.pin === true });
    });
    sock.bind(0, () => {
      try { sock.setBroadcast(true); } catch (_) {}
      const ask = Buffer.from(JSON.stringify({ t: ASK, n: nonce }));
      for (const t of targets) { try { sock.send(ask, port, t); } catch (_) {} }
      setTimeout(done, wait);
    });
  });
}

// ── The PIN's cryptography ─────────────────────────────────────────────────
const SPKI_X25519 = Buffer.from('302a300506032b656e032100', 'hex');      // the fixed head of an X25519 public key
const x25519Public = raw => crypto.createPublicKey({ key: Buffer.concat([SPKI_X25519, raw]), format: 'der', type: 'spki' });
const rawPublic = key => key.export({ format: 'der', type: 'spki' }).subarray(SPKI_X25519.length);
// Two keys from the exchange's secret and the PIN: one proves the PIN, one
// encrypts the passwords. HKDF-SHA256, salted with the exchange's id.
function deriveKeys(secret, pin, sid) {
  const k = info => Buffer.from(crypto.hkdfSync('sha256', Buffer.concat([secret, Buffer.from('|' + pin)]), Buffer.from(String(sid)), Buffer.from(info), 32));
  return { proof: k('filo-share/1 proof'), data: k('filo-share/1 data') };
}
function seal(key, text, sid) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(Buffer.from(String(sid)));
  const data = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return { iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64') };
}
function unseal(key, box, sid) {
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(box.iv, 'base64'));
  d.setAAD(Buffer.from(String(sid)));
  d.setAuthTag(Buffer.from(box.tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(box.data, 'base64')), d.final()]).toString('utf8');
}
function readJson(req) {
  return new Promise((resolve, reject) => {
    const parts = []; let n = 0;
    req.on('data', c => { n += c.length; if (n > MAX_BODY) { reject(new Error('too large')); req.destroy(); } else parts.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(parts).toString('utf8') || '{}')); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}
function postJson(address, port, pathName, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    if (!isLocalAddress(address)) return reject(new Error('This computer is not on the local network.'));
    const b = Buffer.from(JSON.stringify(body));
    const req = http.request({ host: address, port, path: pathName, method: 'POST', timeout: timeoutMs || 8000, headers: { 'Content-Type': 'application/json', 'Content-Length': b.length } }, res => {
      const parts = []; let n = 0;
      res.on('data', c => { n += c.length; if (n > MAX_LIST) req.destroy(new Error('This answer is too large.')); else parts.push(c); });
      res.on('end', () => { let j = {}; try { j = JSON.parse(Buffer.concat(parts).toString('utf8') || '{}'); } catch (_) {} resolve({ status: res.statusCode, body: j }); });
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('This computer does not answer.')));
    req.on('error', e => reject(e.code === 'ECONNREFUSED' ? new Error('This computer no longer shares its servers.') : e));
    req.end(b);
  });
}

// The computer that looks: the passwords of a sharing computer, with its PIN.
// → { ok: true, secrets } or { ok: false, error, left?, wait?, cancelled?, noPin? }
async function unlock(address, port, pin, myName) {
  if (!PIN_RE.test(String(pin))) return { ok: false, error: 'The PIN is 4 digits.' };
  const mine = crypto.generateKeyPairSync('x25519');
  const h = await postJson(address, port, HELLO_PATH, { pub: rawPublic(mine.publicKey).toString('base64') });
  if (h.status === 409) return { ok: false, noPin: true, error: 'This computer shares no password now: ask for a new PIN there.' };
  if (h.status === 429) return { ok: false, wait: h.body.wait || 5, error: 'Too many attempts. Wait a moment.' };
  if (h.status !== 200 || !h.body.sid || !h.body.pub) return { ok: false, error: 'This computer did not accept the request.' };
  const sid = String(h.body.sid);
  const secret = crypto.diffieHellman({ privateKey: mine.privateKey, publicKey: x25519Public(Buffer.from(h.body.pub, 'base64')) });
  const keys = deriveKeys(secret, String(pin), sid);
  const proof = crypto.createHmac('sha256', keys.proof).update('filo-share-proof').digest('base64');
  const r = await postJson(address, port, UNLOCK_PATH, { sid, proof, name: String(myName || '').slice(0, 80) });
  if (r.status === 200) {
    try {
      const got = JSON.parse(unseal(keys.data, r.body, sid));
      return { ok: true, secrets: got && typeof got === 'object' && !Array.isArray(got) ? got : {} };
    } catch (_) { return { ok: false, error: 'The passwords could not be read.' }; }
  }
  if (r.status === 409) return { ok: false, noPin: true, error: 'This computer shares no password now: ask for a new PIN there.' };
  if (r.status === 429) return { ok: false, wait: r.body.wait, error: `Too many wrong PINs. Wait ${r.body.wait} s.` };
  if (r.status === 403 && r.body.error === 'cancelled') return { ok: false, cancelled: true, error: 'Too many wrong PINs: this PIN is cancelled. Ask for a new one.' };
  if (r.status === 403) return { ok: false, left: r.body.left, wait: r.body.wait, error: r.body.wait ? `Wrong PIN. Wait ${r.body.wait} s.` : 'Wrong PIN.' };
  return { ok: false, error: 'This computer did not accept the request.' };
}

// The list of one computer found by discover(): the JSON text of its export.
function fetchList(address, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    if (!isLocalAddress(address)) return reject(new Error('This computer is not on the local network.'));
    const req = http.get({ host: address, port, path: LIST_PATH, timeout: timeoutMs || 5000 }, res => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('This computer no longer shares its servers.')); }
      const parts = [];
      let n = 0;
      res.on('data', c => { n += c.length; if (n > MAX_LIST) { req.destroy(); reject(new Error('This list is too large to be a filo list.')); } else parts.push(c); });
      res.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('This computer does not answer.')));
    req.on('error', e => reject(e.code === 'ECONNREFUSED' ? new Error('This computer no longer shares its servers.') : e));
  });
}

// What a sharing computer hands out: its servers as an export without
// passwords, without the key files' locations (a path of that computer, of no
// use elsewhere), and the order of its folders. Each server carries `ref`
// (its id here, to match a password given with the PIN) and `pw` (it has a
// stored password).
async function listText(siteList, folderOrder) {
  const { exportFilo } = require('./core/sites');
  const list = siteList || [];
  const out = JSON.parse(await exportFilo(list.map(s => Object.assign({}, s, { keyPath: '', passwordEnc: null, passphraseEnc: null }))));
  out.sites.forEach((s, i) => { s.ref = String(list[i].id || ''); s.pw = sharesPassword(list[i]); });
  out.siteFolderOrder = Array.isArray(folderOrder) ? folderOrder : [];
  return JSON.stringify(out);
}
// The password of a server goes with the PIN when it logs in with a stored
// password (not "ask each time", not anonymous, not a key).
const sharesPassword = s => !!(s && s.logon === 'normal' && s.passwordEnc);

module.exports = { Sharer, discover, fetchList, listText, unlock, sharesPassword, PIN_RE, isLocalAddress, broadcastAddresses, machineName, SHARE_PORT, ID_RE };
