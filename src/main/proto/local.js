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

async function list(dir) {
  const names = await fsp.readdir(dir);
  const out = [];
  // lstat in batches: a card with 4 000 clips listed one stat at a time over a
  // slow reader takes seconds; 32 at once takes a fraction of that.
  for (let i = 0; i < names.length; i += 32) {
    const batch = names.slice(i, i + 32);
    const stats = await Promise.all(batch.map(n => fsp.lstat(path.join(dir, n)).catch(() => null)));
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
    try { for (const v of fs.readdirSync('/Volumes')) out.push({ label: v, path: path.join('/Volumes', v) }); } catch (_) {}
  } else {
    for (const base of ['/media/' + os.userInfo().username, '/mnt']) {
      try { for (const v of fs.readdirSync(base)) out.push({ label: v, path: path.join(base, v) }); } catch (_) {}
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
    // A large buffer (0.2.0): while one write is on its way, slow on a network
    // drive, the network keeps filling the next one instead of waiting.
    super({ highWaterMark: 8 * 1024 * 1024 });
    this.file = file;
    this.pos = Math.max(0, Number(start) || 0);
    this.segment = !!(opts && opts.segment);
    this.fd = null;
  }
  _construct(cb) {
    // 'r+' keeps what is already there (resume); 'w' starts a new file.
    fs.open(this.file, this.pos > 0 || this.segment ? 'r+' : 'w', (err, fd) => { if (err) return cb(err); this.fd = fd; cb(); });
  }
  _write(chunk, _enc, cb) {
    fs.write(this.fd, chunk, 0, chunk.length, this.pos, (err, n) => {
      if (err) return cb(err);
      this.pos += n;
      if (n < chunk.length) return this._write(chunk.subarray(n), null, cb);
      cb();
    });
  }
  // Everything that piled up while the previous write was running goes out as
  // ONE write (0.2.0, accepted by Noar). SFTP delivers 32 KB pieces: written
  // one by one, a network drive (SMB share, NAS, a virtual machine's shared
  // folder) answers each of them before the next, and the copy crawls at a
  // few MB/s (5.8 MB/s measured with 5 ms per write; 240 MB/s grouped).
  _writev(chunks, cb) {
    if (chunks.length === 1) return this._write(chunks[0].chunk, null, cb);
    this._write(Buffer.concat(chunks.map(c => c.chunk)), null, cb);
  }

  _final(cb) {
    // Cut anything past the end: a resumed file that was LONGER than the
    // source must not keep its old tail.
    const close = () => fs.fsync(this.fd, () => fs.close(this.fd, err => { this.fd = null; cb(err); }));
    if (this.segment) return close();
    fs.ftruncate(this.fd, this.pos, close);
  }
  _destroy(err, cb) {
    if (this.fd == null) return cb(err);
    fs.close(this.fd, () => { this.fd = null; cb(err); });
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
// too) and every file, with a hard stop on links that loop.
async function walk(root, onEntry, token) {
  const seen = new Set();
  async function go(dir, rel) {
    if (token && token.cancelled) return;
    let real;
    try { real = await fsp.realpath(dir); } catch (_) { real = dir; }
    if (seen.has(real)) return;
    seen.add(real);
    const entries = await list(dir);
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      const r = rel ? rel + '/' + e.name : e.name;
      const full = path.join(dir, e.name);
      const isDir = e.type === 'folder' || (e.type === 'symlink' && e.linkTo === 'folder');
      if (isDir) { onEntry({ rel: r, type: 'folder', path: full }); await go(full, r); }
      else if (e.type === 'file' || (e.type === 'symlink' && e.linkTo === 'file')) onEntry({ rel: r, type: 'file', path: full, size: e.size, mtime: e.mtime });
    }
  }
  await go(root, '');
}

module.exports = { list, stat, roots, windowsDrives, LocalSink, createReadStream, replace, setMTime, walk, isHiddenName, modeString };
