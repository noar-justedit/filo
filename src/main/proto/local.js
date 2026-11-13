/*
 * filo — FTP, FTPS and SFTP client
 * Copyright (C) 2026 Just Edit (Arnaud Augst)
 * Licensed under the GNU General Public License v3.0 or later. See LICENSE.
 */

// The local side: this machine's disks, cards and mounted shares.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const { Writable } = require('stream');

function modeString(mode, isDir, isLink) {
  const m = Number(mode) || 0;
  const r = (b, c) => (m & b ? c : '-');
  return (isLink ? 'l' : isDir ? 'd' : '-') + r(0o400, 'r') + r(0o200, 'w') + r(0o100, 'x') + r(0o40, 'r') + r(0o20, 'w') + r(0o10, 'x') + r(0o4, 'r') + r(0o2, 'w') + r(0o1, 'x');
}

// Hidden, for the "show hidden files" switch: a leading dot everywhere, and
// the operating system's own litter (.DS_Store is caught by the dot already).
const OS_LITTER = new Set(['Thumbs.db', 'desktop.ini', '$RECYCLE.BIN', 'System Volume Information']);
function isHiddenName(name) { return name.startsWith('.') || OS_LITTER.has(name); }

async function list(dir, strict) {
  const names = await fsp.readdir(dir);
  const out = [];
  // lstat in batches: a card with 4 000 clips listed one stat at a time over a
  // slow reader takes seconds; 32 at once takes a fraction of that.
  for (let i = 0; i < names.length; i += 32) {
    const batch = names.slice(i, i + 32);
    // strict: an entry that cannot be read (not one that vanished) is an
    // error, not a missing file (the DUAL SYNC mirror deletes what is missing).
    const stats = await Promise.all(batch.map(n => fsp.lstat(path.join(dir, n)).catch(e => { if (strict && e.code !== 'ENOENT') throw e; return null; })));
    for (let j = 0; j < batch.length; j++) {
      const st = stats[j];
      if (!st) continue;
      const isLink = st.isSymbolicLink();
      let type = isLink ? 'symlink' : st.isDirectory() ? 'folder' : st.isFile() ? 'file' : 'other';
      if (type === 'other') continue;
      const e = { name: batch[j], type, size: st.size, mtime: st.mtimeMs, perms: modeString(st.mode, st.isDirectory(), isLink) };
      if (isLink) {
        try { const t = await fsp.stat(path.join(dir, batch[j])); e.linkTo = t.isDirectory() ? 'folder' : 'file'; if (!t.isDirectory()) e.size = t.size; }
        catch (_) { e.linkTo = 'broken'; }
      }
      out.push(e);
    }
  }
  return out;
}

async function stat(p) {
  try {
    const st = await fsp.stat(p);
    return { name: path.basename(p), type: st.isDirectory() ? 'folder' : 'file', size: st.size, mtime: st.mtimeMs };
  } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return null;
    throw e;
  }
}

// Where the left panel can start: home, and on Windows the drive letters.
// Windows drive letters that answer. Checked in parallel with a deadline: a
// mapped network drive whose NAS is asleep can take many seconds to say no.
async function windowsDrives() {
  const letters = [];
  for (let c = 65; c <= 90; c++) letters.push(String.fromCharCode(c) + ':\\');
  const probe = d => Promise.race([
    fs.promises.stat(d).then(st => ({ path: d, ok: true, mtime: st.mtimeMs }), () => null),
    new Promise(r => setTimeout(() => r({ path: d, ok: false, slow: true }), 1500)),
  ]);
  return (await Promise.all(letters.map(probe))).filter(Boolean);
}

async function roots() {
  const out = [{ label: 'Home', path: os.homedir() }];
  if (process.platform === 'win32') {
    for (const d of await windowsDrives()) out.push({ label: d.path.slice(0, 2) + (d.slow ? ' (not answering)' : ''), path: d.path });
  } else if (process.platform === 'darwin') {
    // /Volumes: every mounted disk; the start-up disk is a link to "/".
    try {
      for (const v of fs.readdirSync('/Volumes')) {
        if (v.startsWith('.')) continue;
        const p = path.join('/Volumes', v);
        let real = p; try { real = fs.realpathSync(p); } catch (_) {}
        out.push({ label: v, path: real === '/' ? '/' : p, system: real === '/' });
      }
    } catch (_) {}
  } else {
    // Linux: what the desktop mounts (udisks: /media/<user> or
    // /run/media/<user>), and /mnt.
    const user = (() => { try { return os.userInfo().username; } catch (_) { return ''; } })();
    out.push({ label: 'Computer', path: '/', system: true });
    for (const base of ['/media/' + user, '/run/media/' + user, '/mnt']) {
      try { for (const v of fs.readdirSync(base)) if (!v.startsWith('.')) out.push({ label: v, path: path.join(base, v) }); } catch (_) {}
    }
  }
  return out;
}

// A file written with explicit positions, so that a download can resume in
// the middle of one, and whose 'finish' means "on disk": the descriptor is
// flushed and closed in _final, before Node says the stream is done. With a
// plain fs.WriteStream the transfer was "finished" while the last megabytes
// were still in the cache — and the read-back that followed could race it.
class LocalSink extends Writable {
  // opts.segment: one of several writers filling the same file — never
  // truncate it, neither at the start nor at the end.
  constructor(file, start, opts) {
    // A large buffer: while one write is on its way, slow on a network drive,
    // the network keeps filling the next one instead of waiting.
    super({ highWaterMark: 8 * 1024 * 1024 });
    this.file = file;
    this.pos = Math.max(0, Number(start) || 0);
    this.segment = !!(opts && opts.segment);
    this.fd = null;
    this.io = 0;                 // operations under way on the descriptor
    this.whenIdle = [];          // what waits for them to end
    this.closing = null;         // the one close, shared by whoever asks
  }
  _construct(cb) {
    // 'r+' keeps what is already there (resume); 'w' starts a new file.
    fs.open(this.file, this.pos > 0 || this.segment ? 'r+' : 'w', (err, fd) => { if (err) return cb(err); this.fd = fd; cb(); });
  }
  // Every operation on the descriptor is counted, and the close waits for the
  // ones under way. A descriptor is a number the system gives again to the
  // next file opened by any transfer: closed while a write was still on its
  // way, or closed twice, it would be another file that loses its descriptor
  // or receives these bytes.
  _op(run, cb) {
    this.io++;
    run((...a) => {
      if (--this.io === 0) { const w = this.whenIdle; this.whenIdle = []; for (const f of w) f(); }
      cb(...a);
    });
  }
  _write(chunk, _enc, cb) {
    if (this.fd == null) return cb(Object.assign(new Error('The local file is already closed.'), { code: 'ECLOSED' }));
    const fd = this.fd;
    this._op(done => fs.write(fd, chunk, 0, chunk.length, this.pos, done), (err, n) => {
      if (err) return cb(err);
      this.pos += n;
      if (n < chunk.length) return this._write(chunk.subarray(n), null, cb);
      cb();
    });
  }
  // Everything that piled up while the previous write was running goes out as
  // ONE write: SFTP delivers 32 KB pieces, and a network drive (SMB share, NAS)
  // that answers each of them before the next crawls at a few MB/s.
  _writev(chunks, cb) {
    if (chunks.length === 1) return this._write(chunks[0].chunk, null, cb);
    this._write(Buffer.concat(chunks.map(c => c.chunk)), null, cb);
  }

  // 'finish' means "on the disk": the end is cut (a resumed file that was
  // LONGER than the source must not keep its old tail), the data flushed,
  // the descriptor closed, before Node says the stream is done.
  _final(cb) {
    const end = err => this._close(true, e => cb(err || e));
    if (this.segment || this.fd == null) return end(null);
    const fd = this.fd;
    this._op(done => fs.ftruncate(fd, this.pos, done), err => end(err || null));
  }
  _destroy(err, cb) { this._close(false, () => cb(err)); }

  // Closed once, after the last operation on the descriptor, whoever asks
  // first (the end of the file, or a stop / an error that destroys it).
  // `flush`: the data is pushed to the disk first; a volume that cannot do
  // that (EINVAL, ENOTSUP) is not an error, any other failure is.
  _close(flush, cb) {
    if (!this.closing) {
      this.closing = new Promise(resolve => {
        const go = () => {
          const fd = this.fd;
          this.fd = null;
          if (fd == null) return resolve(null);
          const shut = e0 => fs.close(fd, e => resolve(e0 || e || null));
          if (!flush) return shut(null);
          fs.fsync(fd, e => shut(e && !['EINVAL', 'ENOTSUP', 'EOPNOTSUPP'].includes(e.code) ? e : null));
        };
        if (this.io) this.whenIdle.push(go); else go();
      });
    }
    this.closing.then(e => cb(e));
  }
}

function createReadStream(p, start, end) {
  const o = { start: Math.max(0, Number(start) || 0), highWaterMark: 1024 * 1024 };
  if (end != null) o.end = end - 1;             // end exclusive here, inclusive for Node
  return fs.createReadStream(p, o);
}

// Replace `to` with `from` without a moment where neither exists: rename does
// that on every local filesystem, Windows included (Node uses MoveFileEx with
// REPLACE_EXISTING).
async function replace(from, to) { await fsp.rename(from, to); }

async function setMTime(p, ms) {
  const t = new Date(ms);
  await fsp.utimes(p, t, t);
}

// Walks a folder for the queue: every sub-folder (so empty ones are recreated
// too) and every file, with a hard stop on links that loop. opts.ignore(name,
// isFolder): left out, and nothing under an ignored folder is read.
async function walk(root, onEntry, token, opts) {
  const seen = new Set();
  const strict = !!(opts && opts.strict);
  const ignore = (opts && opts.ignore) || null;
  async function go(dir, rel) {
    if (token && token.cancelled) return;
    let real;
    try { real = await fsp.realpath(dir); } catch (e) { if (strict) throw e; real = dir; }
    // A folder already walked (a link back to it): strict callers are told
    // it was not read here, so nothing under it is taken as deleted.
    if (seen.has(real)) { if (strict && rel) onEntry({ rel, type: 'folder', path: dir, partial: true }); return; }
    seen.add(real);
    const entries = await list(dir, strict);
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      const r = rel ? rel + '/' + e.name : e.name;
      const full = path.join(dir, e.name);
      const isDir = e.type === 'folder' || (e.type === 'symlink' && e.linkTo === 'folder');
      if (ignore && ignore(e.name, isDir)) continue;
      if (isDir) { if (!(strict && seen.has(await fsp.realpath(full).catch(() => full)))) onEntry({ rel: r, type: 'folder', path: full }); await go(full, r); }
      else if (e.type === 'file' || (e.type === 'symlink' && e.linkTo === 'file')) onEntry({ rel: r, type: 'file', path: full, size: e.size, mtime: e.mtime });
    }
  }
  await go(root, '');
}

module.exports = { list, stat, roots, windowsDrives, LocalSink, createReadStream, replace, setMTime, walk, isHiddenName, modeString };
