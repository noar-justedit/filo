/*
 * filo — FTP, FTPS and SFTP client
 * Copyright (C) 2026 Just Edit (Arnaud Augst)
 * Licensed under the GNU General Public License v3.0 or later. See LICENSE.
 */

// FTP and FTPS, over basic-ftp (pure JavaScript: nothing to compile, so the
// Windows build from a Mac keeps working).
//
// Three flavours:
//   ftp           plain FTP. Password and files travel in clear. Offered
//                 because old NAS and hosting still need it; the window says so.
//   ftps          explicit TLS (AUTH TLS on port 21) — what "FTPS" means today.
//   ftps-implicit TLS from the first byte, port 990. Legacy, still around.
//
// Certificates. A NAS or an in-house server almost always presents a
// self-signed certificate, which a browser-style check rejects. Turning the
// check off would accept anyone. So filo does what it does for SSH keys: a
// certificate that a recognised authority vouches for is accepted; any other
// is shown to the user with its fingerprint, and only a yes pins it. A pinned
// certificate that changes is refused. All of this happens BEFORE the login is
// sent, which is the whole point.
//
// Passive mode (EPSV, then PASV) by default, as basic-ftp does it — including
// FileZilla's fix for a server that answers PASV with its private address
// from behind a router. Active mode (PORT / EPRT) per site: ftp-active.js.
// basic-ftp is also strictly one command at a time per connection; every call here
// goes through a queue so two callers can never collide on one connection.

const posix = require('path').posix;
const ftp = require('basic-ftp');
const { RemoteError } = require('../core/errors');
const { enterActiveMode } = require('./ftp-active');
const { makePassive } = require('./ftp-passive');

let certPolicy = null;
function setCertPolicy(p) { certPolicy = p || null; }

const CONTROL_TIMEOUT_MS = 30000;

function normalize(p) {
  let s = String(p == null ? '' : p);
  if (!s.startsWith('/')) s = '/' + s;
  return posix.normalize(s).replace(/(.)\/+$/, '$1') || '/';
}

const isIp = h => /^[\d.]+$/.test(h) || h.includes(':');

// "SHA256:AB:CD:…" — the shape browsers and `openssl x509 -fingerprint` print.
function certFingerprint(cert) {
  return cert && cert.fingerprint256 ? 'SHA256:' + cert.fingerprint256 : null;
}

// Every FTPS data connection must come from the server whose certificate was
// checked on the control connection: either it resumes that TLS session, or it
// shows the very same certificate. Otherwise someone on the way could take the
// data connection and read or change the files. basic-ftp gives no hook for
// this, so the check sits where it hands each data socket over.
function guardDataTls(ctx, controlFp) {
  const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(ctx), 'dataSocket');
  if (!controlFp) return;
  // Same rule for an active-mode data connection (ftp-active.js), which hands
  // basic-ftp a stand-in socket and checks the real TLS socket itself.
  ctx._filoDataTlsOk = sock => (typeof sock.isSessionReused === 'function' && sock.isSessionReused())
    || certFingerprint(sock.getPeerCertificate()) === controlFp;
  if (!desc || !desc.set || !desc.get) return;
  Object.defineProperty(ctx, 'dataSocket', {
    configurable: true,
    get() { return desc.get.call(this); },
    set(sock) {
      desc.set.call(this, sock);
      if (!sock || typeof sock.getPeerCertificate !== 'function') return;
      const check = () => {
        if (typeof sock.isSessionReused === 'function' && sock.isSessionReused()) return;
        if (certFingerprint(sock.getPeerCertificate()) === controlFp) return;
        sock.destroy(Object.assign(new Error('The data connection showed a different certificate from the server. Refused: someone may be in the way.'), { fatal: true }));
      };
      const cert = sock.getPeerCertificate();
      if (cert && Object.keys(cert).length) check(); else sock.once('secureConnect', check);
    },
  });
}

function certSummary(cert) {
  if (!cert) return {};
  const name = o => (o && (o.CN || o.O)) || '';
  return {
    subject: name(cert.subject),
    issuer: name(cert.issuer),
    validFrom: cert.valid_from || '',
    validTo: cert.valid_to || '',
  };
}

// Months as LIST prints them, for the dates MLSD would have given exactly.
const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

// LIST dates come in two shapes: "Oct 08 12:30" (this year, no year given) and
// "Jan 05  2025" (older, no time given). Both are server local time; there is
// no way to know its zone, so the result is approximate and the window shows it.
// Parsed as if the server's clock were UTC ("naive"); the server's real
// offset is measured once per server (see FtpRemote._tzOffset) and applied
// afterwards. hasTime says whether the listing gave a time of day.
function parseListDate(raw, now) {
  const s = String(raw || '').trim();
  let m = /^([A-Za-z]{3})\s+(\d{1,2})\s+(\d{1,2}):(\d{2})$/.exec(s);
  const n = now || new Date();
  if (m && MONTHS[m[1].toLowerCase()] != null) {
    let t = Date.UTC(n.getUTCFullYear(), MONTHS[m[1].toLowerCase()], +m[2], +m[3], +m[4]);
    if (t > n.getTime() + 2 * 86400000) t = Date.UTC(n.getUTCFullYear() - 1, MONTHS[m[1].toLowerCase()], +m[2], +m[3], +m[4]);
    return { t, hasTime: true };
  }
  m = /^([A-Za-z]{3})\s+(\d{1,2})\s+(\d{4})$/.exec(s);
  if (m && MONTHS[m[1].toLowerCase()] != null) return { t: Date.UTC(+m[3], MONTHS[m[1].toLowerCase()], +m[2]), hasTime: false };
  // Windows/IIS style: "10-08-26 12:30PM"
  m = /^(\d{2})-(\d{2})-(\d{2,4})\s+(\d{1,2}):(\d{2})(AM|PM)?$/i.exec(s);
  if (m) {
    let y = +m[3]; if (y < 100) y += 2000;
    let h = +m[4]; if (m[6]) { if (/pm/i.test(m[6]) && h < 12) h += 12; if (/am/i.test(m[6]) && h === 12) h = 0; }
    return { t: Date.UTC(y, +m[1] - 1, +m[2], h, +m[5]), hasTime: true };
  }
  return { t: 0, hasTime: false };
}

// Server → measured offset, kept for the whole session (every connection to
// the same server shares it).
const TZ_OFFSETS = new Map();

// MDTM / MLST timestamps: YYYYMMDDHHMMSS[.sss], always UTC.
function parseFtpTimestamp(s) {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\.(\d+))?/.exec(String(s || '').trim());
  if (!m) return 0;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], m[7] ? Math.round(Number('0.' + m[7]) * 1000) : 0);
}

function formatFtpTimestamp(ms) {
  const d = new Date(ms);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

function permsString(info) {
  const p = info.permissions;
  if (!p) return '';
  const tri = v => ((v & 4) ? 'r' : '-') + ((v & 2) ? 'w' : '-') + ((v & 1) ? 'x' : '-');
  return (info.isDirectory ? 'd' : info.isSymbolicLink ? 'l' : '-') + tri(p.user) + tri(p.group) + tri(p.world);
}

// The checksum commands an FTP server may offer, strongest first. HASH is the
// IETF draft (FileZilla Server, ProFTPD mod_digest, Serv-U); the X… commands
// are older one-algorithm-each extensions.
const HASH_PREF = ['sha256', 'sha1', 'md5', 'crc32'];
const HASH_NAMES = { sha256: 'SHA-256', sha1: 'SHA-1', md5: 'MD5', crc32: 'CRC32' };
const X_COMMANDS = { sha256: 'XSHA256', sha1: 'XSHA1', md5: 'XMD5', crc32: 'XCRC' };
const HEX_LEN = { sha256: 64, sha1: 40, md5: 32, crc32: 8 };

class FtpRemote {
  // opts: { protocol, host, port, user, password, acceptFingerprint, log }
  constructor(opts) {
    this.opts = opts || {};
    this.protocol = this.opts.protocol || 'ftp';
    this.client = null;
    this.features = new Map();
    this._chain = Promise.resolve();
    this.dead = null;
    this.log = this.opts.log || (() => {});
  }

  get port() { return Number(this.opts.port) || (this.protocol === 'ftps-implicit' ? 990 : 21); }
  get secure() { return this.protocol !== 'ftp'; }
  get alive() { return !!(this.client && !this.client.closed && !this.dead); }
  get canResumeUpload() { return true; }   // APPE; a server that refuses it fails the item, and the queue restarts it from zero

  _q(fn) {
    const guarded = () => {
      if (this.dead) return Promise.reject(this.dead);
      if (!this.client || this.client.closed) return Promise.reject(Object.assign(new Error('The FTP connection is not open.'), { network: true }));
      return Promise.resolve().then(fn).catch(e => {
        const err = RemoteError.from(e, this.protocol);
        // basic-ftp closes the client on a socket error or timeout: from then
        // on every call would fail the same way, so say it is gone.
        if (this.client && this.client.closed) { err.network = true; this.dead = err; }
        throw err;
      });
    };
    const run = this._chain.then(guarded, guarded);
    this._chain = run.then(() => {}, () => {});
    return run;
  }

  async connect() {
    if (this.alive) return;
    this.dead = null;
    const host = this.opts.host, port = this.port;
    // The data connection always goes to the address of the control
    // connection, whatever a PASV reply says (ftp-passive.js): a server must
    // not be able to send filo (and an upload's bytes) to another host, and a
    // server behind NAT that announces its private address still works.
    const client = new ftp.Client(CONTROL_TIMEOUT_MS, { allowSeparateTransferHost: false });
    client.ftp.verbose = false;
    // Passive (the default, and the only mode that crosses a NAT router), or
    // active when the site asks for it — see ftp-active.js.
    client.prepareTransfer = this.opts.transferMode === 'active' ? enterActiveMode : makePassive();
    this.client = client;
    const tlsOptions = {
      host,
      servername: isIp(host) ? undefined : host,
      // Checked by hand below, BEFORE the login — see the header.
      rejectUnauthorized: false,
      minVersion: 'TLSv1.2',
    };
    // Where the connection is, for the window (0.8.0).
    const step = s => { try { if (this.opts.onStep) this.opts.onStep(s); } catch (_) {} };
    step('resolve');
    try { require('dns').lookup(host, () => step('open')); } catch (_) {}
    try {
      if (this.protocol === 'ftps-implicit') await client.connectImplicitTLS(host, port, tlsOptions);
      else await client.connect(host, port);
      if (this.protocol === 'ftps') {
        step('secure');
        try { await client.useTLS(tlsOptions); }
        catch (e) {
          throw new RemoteError('This server does not accept FTPS (explicit TLS). Try FTPS implicit, SFTP, or — if you accept that the password travels in clear — plain FTP.', { code: 'NO_TLS', fatal: true });
        }
      }
      if (this.secure) {
        this._checkCertificate(client.ftp.socket);
        guardDataTls(client.ftp, certFingerprint(client.ftp.socket.getPeerCertificate()));
      }
      step('login');
      await client.sendIgnoringError('OPTS UTF8 ON');
      await client.login(this.opts.user || 'anonymous', this.opts.password || (this.opts.user ? '' : 'anonymous@'));
      step('folder');
      await client.useDefaultSettings();
      try { this.features = await client.features(); } catch (_) { this.features = new Map(); }
      this.log('info', `Connected to ${host}:${port} (${this.protocol === 'ftp' ? 'FTP, not encrypted' : this.protocol === 'ftps' ? 'FTPS explicit' : 'FTPS implicit'})`);
    } catch (e) {
      try { client.close(); } catch (_) {}
      this.client = null;
      throw RemoteError.from(e, this.protocol);
    }
  }

  _checkCertificate(socket) {
    const host = this.opts.host, port = this.port;
    const cert = socket && socket.getPeerCertificate ? socket.getPeerCertificate() : null;
    const fp = certFingerprint(cert);
    const known = certPolicy && certPolicy.known ? certPolicy.known('ftps', host, port) : null;
    if (known) {
      if (known === fp) return;
      throw new RemoteError(
        `The certificate of ${host} has changed since the last connection.\nKnown: ${known}\nNow:   ${fp}\n` +
        'Nothing was sent. If the server was given a new certificate, forget the old one in Settings › Security and connect again.',
        { code: 'HOST_KEY_CHANGED', fatal: true });
    }
    // Vouched for by an authority the system trusts, for this very name.
    if (socket.authorized) return;
    if (fp && this.opts.acceptFingerprint === fp) {
      if (certPolicy && certPolicy.remember) certPolicy.remember('ftps', host, port, fp);
      return;
    }
    throw new RemoteError(`The certificate of ${host} is not signed by a recognised authority (${socket.authorizationError || 'unknown reason'}).`, {
      code: 'TRUST_NEEDED',
      trust: Object.assign({ kind: 'ftps', host, port, fingerprint: fp, reason: String(socket.authorizationError || '') }, certSummary(cert)),
    });
  }

  async close() {
    try { if (this.client) this.client.close(); } catch (_) {}
    this.client = null;
  }

  abort() {
    this.dead = Object.assign(new Error('Stopped.'), { aborted: true });
    try { if (this.client) this.client.close(); } catch (_) {}
  }

  _map(info) {
    const type = info.isDirectory ? 'folder' : info.isSymbolicLink ? 'symlink' : 'file';
    const out = {
      name: info.name,
      type,
      size: Number(info.size) || 0,
      mtime: 0,
      perms: permsString(info),
      linkTo: info.isSymbolicLink ? 'unknown' : undefined,
    };
    if (info.modifiedAt) out.mtime = info.modifiedAt.getTime();      // MLSD: exact, UTC
    else { const d = parseListDate(info.rawModifiedAt); out.mtime = d.t; out._naive = true; out._hasTime = d.hasTime; }
    return out;
  }

  // LIST gives the server's local time with no zone. Like FileZilla: ask the
  // exact UTC date of one file with MDTM, and the difference is the server's
  // offset — rounded to a quarter of an hour, which every real zone is.
  async _tzOffset(dir, entries) {
    const key = `${this.opts.host}:${this.port}`;
    if (TZ_OFFSETS.has(key)) return TZ_OFFSETS.get(key);
    if (!this.features.has('MDTM')) { TZ_OFFSETS.set(key, 0); return 0; }
    const probe = entries.find(e => e.type === 'file' && e._naive && e._hasTime);
    if (!probe) return null;                     // nothing to measure with yet
    const res = await this.client.sendIgnoringError('MDTM ' + posix.join(dir, probe.name));
    if (res.code !== 213) { TZ_OFFSETS.set(key, 0); return 0; }
    const exact = parseFtpTimestamp(String(res.message).replace(/^213\s*/, ''));
    if (!exact) return null;
    const q = 15 * 60000;
    const off = Math.round((probe.mtime - exact) / q) * q;
    TZ_OFFSETS.set(key, off);
    if (off) this.log('info', `Server time zone: UTC${off > 0 ? '+' : '−'}${Math.abs(off / 3600000)} (listing dates corrected)`);
    return off;
  }

  home() { return this._q(() => this.client.pwd()); }

  list(dir) {
    const d = normalize(dir);
    return this._q(async () => {
      const raw = await this.client.list(d);
      const out = raw.filter(i => i.name && i.name !== '.' && i.name !== '..' && !/[\/\\\0]/.test(i.name)).map(i => this._map(i));
      if (out.some(e => e._naive)) {
        let off = null;
        try { off = await this._tzOffset(d, out); } catch (_) {}
        for (const e of out) { if (e._naive && off) e.mtime -= off; delete e._naive; delete e._hasTime; }
      }
      return out;
    });
  }

  // A file's size and date — without listing its folder, which on a folder of
  // three thousand clips costs seconds per question. MLST when the server has
  // it; SIZE + MDTM otherwise. A 550 answer means "not a file here".
  stat(p) {
    const full = normalize(p);
    return this._q(async () => {
      if (this.features.has('MLST')) {
        const res = await this.client.sendIgnoringError('MLST ' + full);
        if (res.code >= 200 && res.code < 300) {
          const line = String(res.message).split(/\r?\n/).find(l => /^\s*\S+=.*;/.test(l) && /type=/i.test(l));
          if (line) {
            const facts = {};
            const sp = line.trim().indexOf(' ');
            const factPart = sp >= 0 ? line.trim().slice(0, sp) : line.trim();
            for (const f of factPart.split(';')) { const i = f.indexOf('='); if (i > 0) facts[f.slice(0, i).toLowerCase()] = f.slice(i + 1); }
            const t = String(facts.type || '').toLowerCase();
            return {
              name: posix.basename(full),
              type: t === 'dir' || t === 'cdir' || t === 'pdir' ? 'folder' : /os\.unix=slink|link/.test(t) ? 'symlink' : 'file',
              size: Number(facts.size) || 0,
              mtime: parseFtpTimestamp(facts.modify),
            };
          }
        }
        if (res.code >= 500) return null;
      }
      const sz = await this.client.sendIgnoringError('SIZE ' + full);
      if (sz.code === 213) {
        const size = Number(String(sz.message).replace(/^213\s*/, '').trim()) || 0;
        let mtime = 0;
        const md = await this.client.sendIgnoringError('MDTM ' + full);
        if (md.code === 213) mtime = parseFtpTimestamp(String(md.message).replace(/^213\s*/, ''));
        return { name: posix.basename(full), type: 'file', size, mtime };
      }
      // Could still be a folder: CWD into it and back.
      const cwd = await this.client.sendIgnoringError('CWD ' + full);
      if (cwd.code >= 200 && cwd.code < 300) return { name: posix.basename(full), type: 'folder', size: 0, mtime: 0 };
      return null;
    });
  }

  mkdir(p) {
    return this._q(async () => {
      const res = await this.client.send('MKD ' + normalize(p));
      return res;
    });
  }

  unlink(p) { return this._q(() => this.client.remove(normalize(p))); }
  rmdir(p) { return this._q(() => this.client.send('RMD ' + normalize(p))); }
  rename(from, to) { return this._q(() => this.client.rename(normalize(from), normalize(to))); }

  get canSetMTime() { return this.features.has('MFMT'); }

  setMTime(p, ms) {
    if (!this.canSetMTime) return Promise.resolve();
    return this._q(() => this.client.sendIgnoringError(`MFMT ${formatFtpTimestamp(ms)} ${normalize(p)}`));
  }

  // Streams. basic-ftp drives the data connection itself, so the engine hands
  // it a destination (download) or a source (upload), and waits.
  download(p, destination, start) {
    return this._q(() => this.client.downloadTo(destination, normalize(p), Math.max(0, Number(start) || 0)));
  }

  // The end of a file, from `start` (0.9.7: checking a partial before an
  // upload resumes it). Read to the end: no transfer is cut half-way.
  async readTail(p, start) {
    const { Writable } = require('stream');
    const parts = [];
    let n = 0;
    const sink = new Writable({ write(c, _e, cb) { n += c.length; if (n <= 4 * 1024 * 1024) parts.push(c); cb(); } });
    await this.download(p, sink, start);
    return Buffer.concat(parts);
  }

  upload(source, p, start) {
    // APPE adds to the end of what is already there; STOR replaces it.
    return this._q(() => (start > 0 ? this.client.appendFrom(source, normalize(p)) : this.client.uploadFrom(source, normalize(p))));
  }

  // ── Checksums computed by the server ────────────────────────────────────
  async hashAlgos() {
    const out = [];
    const hashFeat = this.features.get('HASH');
    if (hashFeat != null) {
      const names = String(hashFeat).toUpperCase().replace(/\*/g, '').split(';').map(s => s.trim());
      for (const a of HASH_PREF) if (names.includes(HASH_NAMES[a])) out.push(a);
    }
    for (const a of HASH_PREF) if (!out.includes(a) && this.features.has(X_COMMANDS[a])) out.push(a);
    return out;
  }

  async serverHash(p, algo, size) {
    const full = normalize(p);
    const len = HEX_LEN[algo];
    if (!len) return null;
    return this._q(async () => {
      // Reading a 40 GB file takes the server minutes, during which the control
      // connection is silent: give it time, then put the normal timeout back.
      const ctx = this.client.ftp;
      const saved = ctx.timeout;
      ctx.timeout = 120000 + Math.ceil((Number(size) || 0) / (2 * 1024 ** 3)) * 60000;
      try {
        let res = null;
        const hashFeat = this.features.get('HASH');
        if (hashFeat != null && String(hashFeat).toUpperCase().includes(HASH_NAMES[algo])) {
          await this.client.sendIgnoringError('OPTS HASH ' + HASH_NAMES[algo]);
          res = await this.client.sendIgnoringError('HASH ' + full);
        } else if (this.features.has(X_COMMANDS[algo])) {
          res = await this.client.sendIgnoringError(X_COMMANDS[algo] + ' ' + full);
        }
        if (!res || res.code >= 400) return null;
        const m = new RegExp(`\\b([0-9a-fA-F]{${len}})\\b`).exec(String(res.message).replace(/^\d{3}[ -]/, ''));
        return m ? m[1].toLowerCase() : null;
      } finally {
        ctx.timeout = saved;
      }
    });
  }
}

module.exports = { FtpRemote, setCertPolicy, parseListDate, parseFtpTimestamp, formatFtpTimestamp, certFingerprint, normalize };
