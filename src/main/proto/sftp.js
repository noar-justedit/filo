/*
 * filo — FTP, FTPS and SFTP client
 * Copyright (C) 2026 Just Edit (Arnaud Augst)
 * Licensed under the GNU General Public License v3.0 or later. See LICENSE.
 */

// SFTP, over ssh2. Built on syncto's SFTP backend (0.8.7): same request queue
// with a deadline, same death handling, same pipelined streams. What changes:
//
//  - an unknown server is NOT trusted silently. syncto remembered the first key
//    it saw; filo stops and shows the fingerprint, like FileZilla, and only a
//    yes from the user writes it down. A key that changed is refused outright.
//  - transfers can start in the middle of a file (resume).
//  - the server can be asked for a checksum of a file (sha256sum / md5sum run
//    over SSH), so a verification costs one command instead of a second
//    transfer — when the account is allowed to run commands at all.

const posix = require('path').posix;
const crypto = require('crypto');
const { PipelinedReader, PipelinedWriter, XFER_CONCURRENCY, XFER_CHUNK } = require('./sftp-pipe');
const { RemoteError } = require('../core/errors');

let ssh2 = null;
function getSsh2() { if (!ssh2) ssh2 = require('ssh2'); return ssh2; }

const OP_TIMEOUT_MS = 45000;

let hostKeyPolicy = null;
function setHostKeyPolicy(p) { hostKeyPolicy = p || null; }

function fingerprintOf(key) {
  return 'SHA256:' + crypto.createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
}

function normalize(p) {
  let s = String(p == null ? '' : p);
  if (!s.startsWith('/')) s = '/' + s;
  return posix.normalize(s).replace(/(.)\/+$/, '$1') || '/';
}

// Single quotes for a POSIX shell: everything inside is literal except the
// single quote itself, which is closed, escaped, and reopened.
function shellQuote(s) { return "'" + String(s).replace(/'/g, "'\\''") + "'"; }

// Commands tried, in order, to get a checksum out of the server. The first one
// that answers is kept for the rest of the connection.
const HASH_COMMANDS = [
  { algo: 'sha256', cmd: p => `sha256sum -b -- ${shellQuote(p)}`, len: 64 },
  { algo: 'sha256', cmd: p => `shasum -a 256 -b -- ${shellQuote(p)}`, len: 64 },
  { algo: 'md5',    cmd: p => `md5sum -b -- ${shellQuote(p)}`, len: 32 },
];

class SftpRemote {
  // opts: { host, port, user, password, privateKey, passphrase, acceptFingerprint }
  constructor(opts) {
    this.protocol = 'sftp';
    this.opts = opts || {};
    this.conn = null;
    this.sftp = null;
    this._chain = Promise.resolve();
    this._streams = new Set();
    this.dead = null;
    this.closing = false;
    this._hashCmd = undefined;     // undefined = not probed yet, null = none
    this.log = opts.log || (() => {});
  }

  get port() { return Number(this.opts.port) || 22; }
  get secure() { return true; }
  get canResumeUpload() { return true; }

  _die(err) {
    if (this.dead) return;
    this.dead = err instanceof Error ? err : new Error(String(err || 'The SFTP connection was lost.'));
    this.dead.network = true;
    for (const s of this._streams) { try { s.destroy(this.dead); } catch (_) {} }
    this._streams.clear();
    try { if (this.conn) this.conn.end(); } catch (_) {}
    this.sftp = null;
    this._connectPromise = null;
  }

  get alive() { return !!(this.sftp && !this.dead); }

  _track(stream) {
    this._streams.add(stream);
    const drop = () => this._streams.delete(stream);
    stream.once('close', drop); stream.once('error', drop); stream.once('end', drop);
    return stream;
  }

  _q(label, fn) {
    const guarded = () => {
      if (this.dead) return Promise.reject(this.dead);
      if (!this.sftp) return Promise.reject(Object.assign(new Error('The SFTP connection is not open.'), { network: true }));
      return new Promise((resolve, reject) => {
        let done = false;
        const timer = setTimeout(() => {
          if (done) return;
          done = true;
          const err = new Error(`The server did not answer within ${Math.round(OP_TIMEOUT_MS / 1000)} s.`);
          err.network = true;
          this._die(err);
          reject(err);
        }, OP_TIMEOUT_MS);
        Promise.resolve().then(fn).then(
          v => { if (!done) { done = true; clearTimeout(timer); resolve(v); } },
          e => { if (!done) { done = true; clearTimeout(timer); reject(e); } });
      });
    };
    const run = this._chain.then(guarded, guarded);
    this._chain = run.then(() => {}, () => {});
    return run;
  }

  connect() {
    if (this._connectPromise) return this._connectPromise;
    this._connectPromise = new Promise((resolve, reject) => {
      const { Client } = getSsh2();
      const conn = new Client();
      let settled = false;
      const host = this.opts.host, port = this.port;
      const cfg = {
        host, port,
        username: this.opts.user,
        readyTimeout: 20000,
        keepaliveInterval: 10000,
        keepaliveCountMax: 3,
      };
      if (this.opts.password) cfg.password = this.opts.password;
      if (this.opts.privateKey) cfg.privateKey = this.opts.privateKey;
      if (this.opts.passphrase) cfg.passphrase = this.opts.passphrase;
      // Keyboard-interactive with the same password: many servers (and every
      // Synology) offer only that, and answer "Authentication failed" to a
      // plain password otherwise.
      if (this.opts.password) {
        cfg.tryKeyboard = true;
        conn.on('keyboard-interactive', (_n, _i, _l, prompts, finish) => finish(prompts.map(() => this.opts.password)));
      }

      let seenKey = null, refusal = null;
      cfg.hostVerifier = key => {
        const fp = fingerprintOf(key);
        const known = hostKeyPolicy && hostKeyPolicy.known ? hostKeyPolicy.known('sftp', host, port) : null;
        if (known && known !== fp) { refusal = { changed: true, known, fp }; return false; }
        if (!known && this.opts.acceptFingerprint !== fp) { refusal = { unknown: true, fp }; return false; }
        seenKey = known ? null : fp;
        return true;
      };

      const bail = err => {
        if (settled) return;
        settled = true;
        if (refusal && refusal.changed) {
          err = new RemoteError(
            `The identity of ${host} has changed since the last connection.\n` +
            `Known: ${refusal.known}\nNow:   ${refusal.fp}\n` +
            'Either the server was reinstalled, or something is answering in its place. Nothing was sent. ' +
            'If the change is expected, forget this server\'s key in Settings › Security and connect again.',
            { code: 'HOST_KEY_CHANGED', fatal: true });
        } else if (refusal && refusal.unknown) {
          err = new RemoteError(`filo has never connected to ${host} before.`,
            { code: 'TRUST_NEEDED', trust: { kind: 'sftp', host, port, fingerprint: refusal.fp } });
        } else {
          err = RemoteError.from(err, 'sftp');
        }
        try { conn.end(); } catch (_) {}
        this.conn = null; this.sftp = null; this._connectPromise = null;
        reject(err);
      };

      conn.on('ready', () => {
        conn.sftp((err, sftp) => {
          if (err) return bail(err);
          if (settled) { try { conn.end(); } catch (_) {} return; }
          settled = true;
          this.conn = conn; this.sftp = sftp; this.dead = null;
          this._installWindow(sftp);
          if (seenKey && hostKeyPolicy && hostKeyPolicy.remember) {
            try { hostKeyPolicy.remember('sftp', host, port, seenKey); } catch (_) {}
          }
          const lost = e => { if (!this.closing) this._die(e || new Error('The SFTP connection was closed by the server.')); };
          conn.on('error', lost);
          conn.on('close', () => lost());
          conn.on('end', () => lost());
          sftp.on('error', lost);
          sftp.on('close', () => lost());
          this.log('info', `Connected to ${host}:${port} (SFTP)`);
          resolve();
        });
      });
      conn.on('error', bail);
      conn.on('close', () => bail(new Error('The SFTP connection was closed before it was ready.')));
      try { conn.connect(cfg); } catch (e) { bail(e); }
    });
    return this._connectPromise;
  }

  // ── A receive window that follows the read depth ────────────────────────
  // ssh2 keeps the window it grants the server at 2 MB, fixed: the server may
  // not have more than 2 MB unacknowledged on the way, so a deeper read
  // pipeline would just wait. The window is the RECEIVER's to grant, so filo
  // tops it up itself to what the active reader needs (up to 64 MB); ssh2's
  // own top-up only acts below 1 MB, which then never happens.
  _installWindow(sftp) {
    this._windowTarget = 0;
    const origPush = sftp.push.bind(sftp);
    sftp.push = (data) => {
      const r = origPush(data);
      try { this._topUp(sftp); } catch (_) {}
      return r;
    };
  }

  _wantWindow(bytes) {
    this._windowTarget = Math.min(64 * 1024 * 1024, Math.max(this._windowTarget, bytes));
    if (this.sftp) { try { this._topUp(this.sftp); } catch (_) {} }
  }

  _topUp(sftp) {
    const target = this._windowTarget;
    if (!target || !sftp.incoming || !sftp.outgoing || sftp.outgoing.state === 'closed') return;
    if (sftp.incoming.window > target / 2) return;
    const amt = target - sftp.incoming.window;
    if (amt <= 0) return;
    sftp.incoming.window += amt;
    sftp._protocol.channelWindowAdjust(sftp.outgoing.id, amt);
  }

  async close() {
    this.closing = true;
    for (const s of this._streams) { try { s.destroy(); } catch (_) {} }
    this._streams.clear();
    try { if (this.conn) this.conn.end(); } catch (_) {}
    this.conn = null; this.sftp = null; this._connectPromise = null; this.dead = null;
  }

  // Abort whatever is running on this connection, the fastest way there is.
  abort() { this._die(Object.assign(new Error('Stopped.'), { aborted: true })); }

  _mapStat(st, name) {
    const isLink = typeof st.isSymbolicLink === 'function' ? st.isSymbolicLink() : false;
    const isDir  = typeof st.isDirectory    === 'function' ? st.isDirectory()    : false;
    return {
      name,
      type : isLink ? 'symlink' : isDir ? 'folder' : 'file',
      size : Number(st.size) || 0,
      mtime: (st.mtime || 0) * 1000,
      perms: modeString(st.mode, isDir, isLink),
    };
  }

  async home() {
    return this._q('realpath', () => new Promise((resolve, reject) => {
      this.sftp.realpath('.', (err, t) => err ? reject(err) : resolve(t || '/'));
    }));
  }

  async stat(p) {
    return this._q(`stat ${p}`, () => new Promise((resolve, reject) => {
      this.sftp.stat(normalize(p), (err, st) => {
        if (!err) return resolve(this._mapStat(st, posix.basename(normalize(p))));
        if (err.code === 2 || /no such file/i.test(err.message || '')) return resolve(null);
        reject(RemoteError.from(err, 'sftp'));
      });
    }));
  }

  async list(p) {
    const dir = normalize(p);
    const list = await this._q(`readdir ${dir}`, () => new Promise((resolve, reject) => {
      this.sftp.readdir(dir, (err, l) => err ? reject(RemoteError.from(err, 'sftp')) : resolve(l));
    }));
    const out = [];
    for (const e of list) {
      const n = String(e.filename == null ? '' : e.filename);
      if (!n || n === '.' || n === '..' || n.includes('/') || n.includes('\\')) continue;
      out.push(this._mapStat(e.attrs, n));
    }
    // A link to a folder must be browsable as a folder: ask where it points.
    for (const e of out) {
      if (e.type !== 'symlink') continue;
      try {
        const t = await this.stat(posix.join(dir, e.name));
        if (t) { e.linkTo = t.type; if (t.type === 'file') e.size = t.size; }
      } catch (_) {}
    }
    return out;
  }

  async mkdir(p) {
    const full = normalize(p);
    return this._q(`mkdir ${full}`, () => new Promise((resolve, reject) => {
      this.sftp.mkdir(full, err => err ? reject(RemoteError.from(err, 'sftp')) : resolve());
    }));
  }

  async unlink(p) {
    return this._q(`unlink ${p}`, () => new Promise((resolve, reject) => {
      this.sftp.unlink(normalize(p), err => err ? reject(RemoteError.from(err, 'sftp')) : resolve());
    }));
  }

  async rmdir(p) {
    return this._q(`rmdir ${p}`, () => new Promise((resolve, reject) => {
      this.sftp.rmdir(normalize(p), err => err ? reject(RemoteError.from(err, 'sftp')) : resolve());
    }));
  }

  // Plain rename. Most SFTP servers refuse to rename onto an existing name;
  // replacing a file is the transfer engine's job (see core/transfer.js).
  async rename(from, to) {
    return this._q(`rename ${from}`, () => new Promise((resolve, reject) => {
      this.sftp.rename(normalize(from), normalize(to), err => err ? reject(RemoteError.from(err, 'sftp')) : resolve());
    }));
  }

  async setMTime(p, ms) {
    const t = Math.floor(ms / 1000);
    return this._q(`utimes ${p}`, () => new Promise((resolve, reject) => {
      this.sftp.utimes(normalize(p), t, t, err => err ? reject(err) : resolve());
    }));
  }

  get canSetMTime() { return true; }

  createReadStream(p, start, end) {
    if (this.dead) throw this.dead;
    return this._track(new PipelinedReader(this, normalize(p), { start, end }));
  }

  createWriteStream(p, start, opts) {
    if (this.dead) throw this.dead;
    return this._track(new PipelinedWriter(this, normalize(p), Object.assign({ start }, opts || {})));
  }

  // Segments (core/segments.js): a range of a file, read or written by this
  // connection while others handle the other ranges.
  get canSegment() { return true; }
  // Many writes are in flight at once and a server may complete them in any
  // order: after a cut, the end of a partial file can be written while a piece
  // before it is not. A resumed upload therefore starts this far before the
  // end of what the server holds (64 × 32 KB = 2 MB, sent again).
  get resumeMargin() { return XFER_CONCURRENCY * XFER_CHUNK; }

  downloadRange(p, destination, start, end) {
    const { pipeline } = require('stream');
    return new Promise((resolve, reject) => {
      let rs;
      try { rs = this.createReadStream(p, start, end); } catch (e) { return reject(RemoteError.from(e, 'sftp')); }
      pipeline(rs, destination, err => (err ? reject(RemoteError.from(err, 'sftp')) : resolve()));
    });
  }

  uploadRange(source, p, start) {
    const { pipeline } = require('stream');
    return new Promise((resolve, reject) => {
      let ws;
      try { ws = this.createWriteStream(p, start, { noTruncate: true }); } catch (e) { return reject(RemoteError.from(e, 'sftp')); }
      pipeline(source, ws, err => (err ? reject(RemoteError.from(err, 'sftp')) : resolve()));
    });
  }

  // An empty file, created (or emptied) before the segments fill it.
  createEmpty(p) {
    return this._q(`create ${p}`, () => new Promise((resolve, reject) => {
      this.sftp.open(normalize(p), 'w', (err, h) => {
        if (err) return reject(RemoteError.from(err, 'sftp'));
        this.sftp.close(h, e => (e ? reject(e) : resolve()));
      });
    }));
  }

  // Same shape as the FTP backend: the engine hands over a destination or a
  // source and waits for the end.
  download(p, destination, start) {
    const { pipeline } = require('stream');
    return new Promise((resolve, reject) => {
      let rs;
      try { rs = this.createReadStream(p, start); } catch (e) { return reject(RemoteError.from(e, 'sftp')); }
      pipeline(rs, destination, err => (err ? reject(RemoteError.from(err, 'sftp')) : resolve()));
    });
  }

  upload(source, p, start) {
    const { pipeline } = require('stream');
    return new Promise((resolve, reject) => {
      let ws;
      try { ws = this.createWriteStream(p, start); } catch (e) { return reject(RemoteError.from(e, 'sftp')); }
      pipeline(source, ws, err => (err ? reject(RemoteError.from(err, 'sftp')) : resolve()));
    });
  }

  // ── Checksums computed by the server ────────────────────────────────────
  // Runs a command over the same SSH connection. Accounts restricted to SFTP
  // (chroot, "internal-sftp", most hosting) refuse to run anything; that is
  // remembered and the engine falls back to reading the file back.
  _exec(cmd, timeoutMs) {
    return new Promise((resolve, reject) => {
      if (!this.conn || this.dead) return reject(new Error('not connected'));
      let out = '', errOut = '', done = false;
      let chan = null;
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        try { if (chan) chan.close(); } catch (_) {}     // do not leave the command running on the server
        reject(new Error('timeout'));
      }, timeoutMs);
      this.conn.exec(cmd, (err, stream) => {
        if (err) { done = true; clearTimeout(timer); return reject(err); }
        chan = stream;
        if (done) { try { stream.close(); } catch (_) {} return; }
        stream.on('data', d => { if (out.length < 4096) out += d; });
        stream.stderr.on('data', d => { if (errOut.length < 4096) errOut += d; });
        stream.on('close', code => {
          if (done) return;
          done = true; clearTimeout(timer);
          if (code === 0) resolve(out); else reject(new Error(errOut.trim() || `exit ${code}`));
        });
      });
    });
  }

  async hashAlgos() {
    if (this._hashCmd === undefined) {
      this._hashCmd = null;
      for (const h of HASH_COMMANDS) {
        try {
          // Hash of nothing: proves the command exists without touching a file.
          const bin = h.cmd('/dev/null');
          const out = await this._exec(bin, 8000);
          if (new RegExp(`^[0-9a-f]{${h.len}}\\b`, 'i').test(out.trim())) { this._hashCmd = h; break; }
        } catch (_) { /* next */ }
      }
      this.log('info', this._hashCmd ? `Server checksums: ${this._hashCmd.algo} (${this._hashCmd.cmd('').split(' ')[0]})` : 'Server checksums: not available on this account');
    }
    return this._hashCmd ? [this._hashCmd.algo] : [];
  }

  // A large file takes the server a while to read: one minute per 4 GB of
  // allowance, which a spinning NAS at 70 MB/s still meets.
  async serverHash(p, algo, size) {
    await this.hashAlgos();
    const h = this._hashCmd;
    if (!h || h.algo !== algo) return null;
    // The quoting is right for sh, bash, zsh and dash, not for every shell
    // (fish reads \' inside single quotes). A name with a quote, a backslash
    // or a control character is checked by reading it back instead.
    if (/['\\\x00-\x1f\x7f]/.test(String(p))) return null;
    const timeout = 60000 + Math.ceil((Number(size) || 0) / (4 * 1024 ** 3)) * 60000;
    const out = await this._exec(h.cmd(normalize(p)), timeout);
    const m = new RegExp(`^([0-9a-f]{${h.len}})\\b`, 'i').exec(out.trim());
    return m ? m[1].toLowerCase() : null;
  }
}

// "drwxr-xr-x" from a numeric mode, for the Permissions column.
function modeString(mode, isDir, isLink) {
  if (mode == null) return '';
  const m = Number(mode);
  const t = isLink ? 'l' : isDir ? 'd' : '-';
  const r = (b, c) => (m & b ? c : '-');
  return t + r(0o400, 'r') + r(0o200, 'w') + r(0o100, 'x') + r(0o40, 'r') + r(0o20, 'w') + r(0o10, 'x') + r(0o4, 'r') + r(0o2, 'w') + r(0o1, 'x');
}

module.exports = { SftpRemote, setHostKeyPolicy, fingerprintOf, normalize, shellQuote, modeString };
