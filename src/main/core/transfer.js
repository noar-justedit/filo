/*
 * filo — FTP, FTPS and SFTP client
 * Copyright (C) 2026 Just Edit (Arnaud Augst)
 * Licensed under the GNU General Public License v3.0 or later. See LICENSE.
 */

// One file, from start to finish, on one connection.
//
//   1. look at the target: absent, or present and the rule decides
//   2. write to "<name>.filopart" (unless the setting says otherwise)
//   3. resume the .filopart if it belongs to this same source (same size and
//      date as when the transfer started) — otherwise start over
//   4. check the size, then the checksum (see verify())
//   5. only then give the file its real name, and its date
//
// The real name therefore never designates a half file or an unverified one:
// a watch folder on the other side picks up nothing until it is complete, and
// a file that failed its check stays visibly named .filopart.

const path = require('path');
const posix = path.posix;
const { finished } = require('stream/promises');
const { Writable } = require('stream');
const local = require('../proto/local');
const { Tap, hashFile, createHasher, LABELS: HASH_LABELS } = require('./hash');
const existing = require('./existing');
const { RemoteError } = require('./errors');

const PART = '.filopart';
const OLD = '.filoold';

class MismatchError extends RemoteError {}

// A Writable that keeps nothing: the bytes only have to go through a hasher.
function nullSink() { return new Writable({ write(_c, _e, cb) { cb(); } }); }

// "Is this name already there?" — answered from a listing of the folder,
// fetched once and kept a minute, instead of one or two round trips per file
// (FileZilla does the same with its directory cache). Over FTP with 5 000
// small files that is 5 000 × (SIZE + MDTM) saved. Only "absent" is trusted
// from the listing: when the name IS there, the real stat is asked anyway, so
// a decision such as "overwrite if newer" uses the exact date.
const INDEX_TTL_MS = 60000;
async function presence(remote, full) {
  const dir = posix.dirname(full);
  if (!remote._idx) remote._idx = new Map();
  let idx = remote._idx.get(dir);
  if (!idx || Date.now() - idx.t > INDEX_TTL_MS) {
    try {
      const list = await remote.list(dir);
      idx = { t: Date.now(), names: new Set(list.map(e => e.name)) };
      if (remote._idx.size > 200) remote._idx.clear();
      remote._idx.set(dir, idx);
    } catch (_) { return remote.stat(full); }
  }
  if (!idx.names.has(posix.basename(full))) return null;
  return remote.stat(full);
}
function noteWritten(remote, full) {
  const idx = remote._idx && remote._idx.get(posix.dirname(full));
  if (idx) idx.names.add(posix.basename(full));
}
function noteNewDir(remote, dir) {
  if (!remote._idx) remote._idx = new Map();
  remote._idx.set(dir, { t: Date.now(), names: new Set() });
}

// mkdir -p on the server, remembering what this connection already made.
async function ensureRemoteDir(remote, dir) {
  const full = posix.normalize(dir);
  if (full === '/' || full === '.') return;
  if (!remote._dirs) remote._dirs = new Set();
  if (remote._dirs.has(full)) return;
  const st = await remote.stat(full);
  if (st && st.type === 'folder') { remote._dirs.add(full); return; }
  if (st) throw new RemoteError(`"${full}" exists on the server and is not a folder.`, { fatal: true });
  await ensureRemoteDir(remote, posix.dirname(full));
  let made = false;
  try { await remote.mkdir(full); made = true; }
  catch (e) {
    // Another connection made it in the meantime: fine.
    const again = await remote.stat(full).catch(() => null);
    if (!again || again.type !== 'folder') throw e;
  }
  remote._dirs.add(full);
  if (made) noteNewDir(remote, full);
}

// mkdir -p on this machine. NOT fs.mkdir(dir, { recursive: true }): on
// Windows, Node asks for the drive root itself when the folder is a root or
// sits right under one, and a mapped network drive (S:\ on a NAS) answers
// EPERM — every download into S:\ failed with "mkdir 'S:\'". Instead: walk up
// to the first folder that exists, then create the missing ones one by one.
async function ensureLocalDir(dir) {
  const fsp = require('fs').promises;
  const missing = [];
  let cur = path.resolve(dir);
  for (;;) {
    let st = null;
    try { st = await fsp.stat(cur); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (st) {
      if (!st.isDirectory()) throw new RemoteError(`"${cur}" exists and is not a folder.`, { fatal: true });
      break;
    }
    missing.push(cur);
    const up = path.dirname(cur);
    if (up === cur) break;                 // a drive that is not there at all
    cur = up;
  }
  for (const d of missing.reverse()) {
    try { await fsp.mkdir(d); }
    catch (e) { if (e.code !== 'EEXIST') throw e; }
  }
}

// ctx: { remote, settings, token, onBytes(n, phase), ask(item, src, dst), log }
// Returns { status: 'done'|'skipped', note, verify: { level, algo } }.
async function runFile(item, ctx) {
  return item.dir === 'up' ? upload(item, ctx) : download(item, ctx);
}

async function runFolder(item, ctx) {
  if (item.dir === 'up') await ensureRemoteDir(ctx.remote, item.remote);
  else await ensureLocalDir(item.local);
  return { status: 'done' };
}

function sameSource(item, src) {
  return item.resume && item.resume.srcSize === src.size && Math.abs((item.resume.srcMtime || 0) - (src.mtime || 0)) < 1000;
}

async function decide(item, ctx, src, dst) {
  if (!dst) return { action: 'new' };
  if (dst.type === 'folder') throw new RemoteError(`A folder named "${posix.basename(item.dir === 'up' ? item.remote : item.local.replace(/\\/g, '/'))}" is in the way.`, { fatal: true });
  // What is there was written by filo itself in an earlier attempt of THIS
  // item (no temporary name, or "resume"): it is not the user's file, so the
  // "already there" rule does not apply. Asking about it, or skipping it
  // because it now looks "newer" or "the same size", would leave a broken file
  // under the real name.
  // "Start again" (restartFromZero) only means "do not resume the partial
  // file": the user's rule still applies to a file under the real name that
  // filo did not write (with temporary names, filo never writes there before
  // the end).
  if (item.restartFromZero && item.ownTarget) return { action: 'overwrite' };
  if (item.ownTarget) {
    if (!item.seg && sameSource(item, src) && dst.size <= src.size) return { action: 'resume' };
    return { action: 'overwrite' };
  }
  let rule = item.existing || (item.dir === 'up' ? ctx.settings.existingUp : ctx.settings.existingDown) || ctx.settings.existing || 'ask';
  if (rule === 'ask') rule = await ctx.ask(item, src, dst);
  return { action: existing.resolve(rule, src, dst) };
}

// ── Upload ────────────────────────────────────────────────────────────────
async function upload(item, ctx) {
  const { remote, settings } = ctx;
  const src = await local.stat(item.local);
  if (!src || src.type !== 'file') throw new RemoteError('The source file is no longer there.', { fatal: true });
  item.size = src.size;

  const dir = posix.dirname(item.remote);
  await ensureRemoteDir(remote, dir);
  let finalPath = item.remote;
  const dst = await presence(remote, finalPath);
  const { action } = await decide(item, ctx, src, dst);
  if (action === 'skip') return { status: 'skipped', note: 'Already there' };
  if (action === 'rename') {
    const name = await existing.freeName(posix.basename(finalPath), async n => !!(await remote.stat(posix.join(dir, n))));
    finalPath = posix.join(dir, name);
    item.remote = finalPath;
  }

  // Where the bytes go, and from which offset.
  let writePath, offset = 0, useTemp;
  if (action === 'resume') {
    writePath = finalPath; offset = dst.size; useTemp = false;
  } else {
    useTemp = settings.tempNames !== false;
    writePath = useTemp ? finalPath + PART : finalPath;
    if (useTemp) {
      const part = await presence(remote, writePath);
      if (part && part.type === 'file' && sameSource(item, src) && part.size <= src.size && !item.restartFromZero) offset = part.size;
    }
  }
  if (writePath === finalPath) item.ownTarget = true;
  if (action !== 'resume' && segmentable(remote, settings, src.size)) {
    return prepareSegments(item, ctx, src, { writePath, finalPath, useTemp, replacing: !!dst });
  }
  item.seg = null;
  item.resume = { srcSize: src.size, srcMtime: src.mtime };
  item.restartFromZero = false;
  if (offset > 0 && remote.resumeMargin) offset = Math.max(0, offset - remote.resumeMargin);
  item.offset = offset;
  ctx.onBytes(offset, 'resume');
  if (offset) ctx.log('info', `Resuming ${posix.basename(finalPath)} at ${offset} bytes`);

  // Fingerprint while sending, when the whole file goes through.
  const streamAlgo = offset === 0 && settings.verify ? 'xxh64' : null;
  const tap = new Tap(streamAlgo ? await createHasher(streamAlgo) : null, n => ctx.onBytes(n, 'transfer'), ctx.limiter);
  if (offset < src.size || offset === 0) {
    const rs = local.createReadStream(item.local, offset);
    rs.on('error', e => tap.destroy(e));
    rs.pipe(tap);
    ctx.token.onAbort = () => { rs.destroy(); tap.destroy(Object.assign(new Error('Stopped.'), { aborted: true })); };
    await remote.upload(tap, writePath, offset);
    ctx.token.onAbort = null;
  }
  if (ctx.token.cancelled) throw Object.assign(new RemoteError('Stopped.'), { aborted: true });

  // Size first: cheap, and it catches a cut that the protocol did not report.
  const landed = await remote.stat(writePath);
  if (!landed || landed.size !== src.size) {
    throw new RemoteError(`The server holds ${landed ? landed.size : 0} bytes of ${src.size}.`, { network: true, sizeMismatch: true });
  }

  const verify = await verifyUpload(item, ctx, writePath, src, tap.digest(), streamAlgo, offset);

  if (useTemp) {
    const target = await recheckTarget(item, ctx, src, finalPath, !!dst);
    if (!target) { await dropWritten(item, ctx, writePath); return { status: 'skipped', note: 'Already there' }; }
    if (target !== finalPath) { finalPath = target; await promote(remote, writePath, finalPath, false); }
    else await promote(remote, writePath, finalPath, true);
  }
  noteWritten(remote, finalPath);
  if (settings.keepDates !== false && remote.canSetMTime && src.mtime) {
    try { await remote.setMTime(finalPath, src.mtime); } catch (_) { /* a date is not worth failing a delivery */ }
  }
  return { status: 'done', verify };
}

// Just before the .filopart takes the real name. When the name was free as
// this file started, look again: another connection of filo (whose listing
// this one did not have), or another program, may have put a file there
// since. Then the user's "already there" rule decides, exactly as if it had
// been there from the start, never a stale listing. One stat per file.
// Returns the final path to use, or null for "skip" (the partial goes).
async function recheckTarget(item, ctx, src, finalPath, knownThere) {
  if (knownThere) return finalPath;
  const up = item.dir === 'up';
  const { remote } = ctx;
  const now = up ? await remote.stat(finalPath).catch(() => null) : await local.stat(finalPath);
  if (!now) return finalPath;
  const keep = { restartFromZero: item.restartFromZero, ownTarget: item.ownTarget };
  item.restartFromZero = false; item.ownTarget = false;     // what is there now is not filo's
  let action;
  try { ({ action } = await decide(item, ctx, src, now)); }
  finally { Object.assign(item, keep); }
  if (action === 'skip') return null;
  if (action === 'rename') {
    const dir = up ? posix.dirname(finalPath) : path.dirname(finalPath);
    const join = up ? posix.join : path.join;
    const name = await existing.freeName(up ? posix.basename(finalPath) : path.basename(finalPath),
      async n => !!(up ? await remote.stat(join(dir, n)).catch(() => null) : await local.stat(join(dir, n))));
    const p = join(dir, name);
    if (up) item.remote = p; else item.local = p;
    return p;
  }
  return finalPath;                                          // overwrite (a late "resume" too: the whole file is ready)
}

async function dropWritten(item, ctx, writePath) {
  try {
    if (item.dir === 'up') await ctx.remote.unlink(writePath);
    else await require('fs').promises.unlink(writePath);
  } catch (_) {}
}

// .filopart → real name. Most servers refuse to rename onto an existing
// file, and deleting the old one first leaves a window with NOTHING under the
// real name if the connection drops in between. The old one is moved aside,
// and put back if the rename fails.
async function promote(remote, from, to, knownThere) {
  if (knownThere === false) {
    // The listing said the name was free; if something took it since, the
    // rename fails and the careful path below takes over.
    try { await remote.rename(from, to); return; }
    catch (e) { if (!(await remote.stat(to).catch(() => null))) throw e; }
  }
  const there = await remote.stat(to);
  if (!there) { await remote.rename(from, to); return; }
  const parked = to + OLD;
  try { await remote.unlink(parked); } catch (_) {}
  await remote.rename(to, parked);
  try { await remote.rename(from, to); }
  catch (e) { try { await remote.rename(parked, to); } catch (_) {} throw e; }
  try { await remote.unlink(parked); } catch (_) {}
}

// What the remote side holds, fingerprinted by reading it back.
async function readBackHash(remote, p, ctx) {
  const tap = new Tap(await createHasher('xxh64'), n => ctx.onBytes(n, 'verify'));
  const sink = nullSink();
  tap.pipe(sink);
  ctx.token.onAbort = () => tap.destroy(Object.assign(new Error('Stopped.'), { aborted: true }));
  await remote.download(p, tap, 0);
  await finished(sink);
  ctx.token.onAbort = null;
  return tap.digest();
}

async function pickServerAlgo(remote, settings) {
  if (settings.serverHash === false) return null;
  try { const a = await remote.hashAlgos(); return a[0] || null; } catch (_) { return null; }
}

// Upload check, best first:
//   server   the server computes the checksum of what it holds, filo computes
//            the same on the local file: end to end, no second transfer.
//   readback filo downloads the file again and fingerprints it: end to end,
//            at the price of a second transfer (setting "Read back").
//   size     only the size was checked.
async function verifyUpload(item, ctx, p, src, streamHash, streamAlgo, offset) {
  const { remote, settings } = ctx;
  if (!settings.verify) return { level: 'size' };
  ctx.onBytes(0, 'verify-start');
  const algo = await pickServerAlgo(remote, settings);
  if (algo) {
    const r = await remote.serverHash(p, algo, src.size).catch(() => null);
    if (r) {
      const l = await hashFile(item.local, algo, n => ctx.onBytes(n, 'verify-local'), ctx.token);
      if (l !== r) throw mismatch(offset, `${HASH_LABELS[algo]} differs: local ${l}, server ${r}.`);
      return { level: 'server', algo };
    }
  }
  if (settings.readBack) {
    const r = await readBackHash(remote, p, ctx);
    const l = streamAlgo ? streamHash : await hashFile(item.local, 'xxh64', null, ctx.token);
    if (l !== r) throw mismatch(offset, `xxHash64 differs after reading the file back: local ${l}, server ${r}.`);
    return { level: 'readback', algo: 'xxh64' };
  }
  return { level: 'size' };
}

function mismatch(offset, msg) {
  // A resumed file that does not match is redone from zero once, silently:
  // the part kept from before is the likeliest culprit.
  return new MismatchError((offset ? 'After resuming: ' : '') + msg, { mismatch: true, network: true, resumed: !!offset });
}

// ── Download ──────────────────────────────────────────────────────────────
async function download(item, ctx) {
  const { remote, settings } = ctx;
  const src = await remote.stat(item.remote);
  if (!src) throw new RemoteError('This file is no longer on the server.', { fatal: true });
  if (src.type === 'folder') throw new RemoteError('This is a folder, not a file.', { fatal: true });
  item.size = src.size;

  const dir = path.dirname(item.local);
  await ensureLocalDir(dir);
  let finalPath = item.local;
  const dst = await local.stat(finalPath);
  const { action } = await decide(item, ctx, src, dst);
  if (action === 'skip') return { status: 'skipped', note: 'Already there' };
  if (action === 'rename') {
    const name = await existing.freeName(path.basename(finalPath), async n => !!(await local.stat(path.join(dir, n))));
    finalPath = path.join(dir, name);
    item.local = finalPath;
  }

  let writePath, offset = 0, useTemp;
  if (action === 'resume') { writePath = finalPath; offset = dst.size; useTemp = false; }
  else {
    useTemp = settings.tempNames !== false;
    writePath = useTemp ? finalPath + PART : finalPath;
    if (useTemp) {
      const part = await local.stat(writePath);
      if (part && part.type === 'file' && sameSource(item, src) && part.size <= src.size && !item.restartFromZero) offset = part.size;
    }
  }
  if (writePath === finalPath) item.ownTarget = true;
  if (action !== 'resume' && segmentable(remote, settings, src.size)) {
    return prepareSegments(item, ctx, src, { writePath, finalPath, useTemp, replacing: !!dst });
  }
  item.seg = null;
  item.resume = { srcSize: src.size, srcMtime: src.mtime };
  item.restartFromZero = false;
  item.offset = offset;
  ctx.onBytes(offset, 'resume');
  if (offset) ctx.log('info', `Resuming ${path.basename(finalPath)} at ${offset} bytes`);

  const streamAlgo = offset === 0 && settings.verify ? 'xxh64' : null;
  const tap = new Tap(streamAlgo ? await createHasher(streamAlgo) : null, n => ctx.onBytes(n, 'transfer'), ctx.limiter);
  const sink = new local.LocalSink(writePath, offset);
  tap.pipe(sink);
  const sinkDone = finished(sink);
  sinkDone.catch(() => {});
  ctx.token.onAbort = () => { tap.destroy(Object.assign(new Error('Stopped.'), { aborted: true })); sink.destroy(); };
  if (offset < src.size || offset === 0) await remote.download(item.remote, tap, offset);
  else tap.end();
  await sinkDone;
  ctx.token.onAbort = null;
  if (ctx.token.cancelled) throw Object.assign(new RemoteError('Stopped.'), { aborted: true });

  const landed = await local.stat(writePath);
  if (!landed || landed.size !== src.size) {
    throw new RemoteError(`Received ${landed ? landed.size : 0} bytes of ${src.size}.`, { network: true, sizeMismatch: true });
  }

  const verify = await verifyDownload(item, ctx, writePath, src, tap.digest(), streamAlgo, offset);

  if (useTemp) {
    const target = await recheckTarget(item, ctx, src, finalPath, !!dst);
    if (!target) { await dropWritten(item, ctx, writePath); return { status: 'skipped', note: 'Already there' }; }
    finalPath = target;
    await local.replace(writePath, finalPath);
  }
  if (settings.keepDates !== false && src.mtime) {
    try { await local.setMTime(finalPath, src.mtime); } catch (_) {}
  }
  return { status: 'done', verify };
}

// Download check, best first:
//   server   the server's checksum of its file = filo's checksum of the copy
//   received the copy on disk was read back and matches, byte for byte, what
//            arrived over the wire (proves the disk write; the wire itself is
//            protected by SSH/TLS, and by nothing more than TCP in plain FTP)
//   readback (resumed file, no server checksum) the server's file was read
//            again from the start and compared with the copy
//   size
async function verifyDownload(item, ctx, p, src, streamHash, streamAlgo, offset) {
  const { remote, settings } = ctx;
  if (!settings.verify) return { level: 'size' };
  ctx.onBytes(0, 'verify-start');
  const algo = await pickServerAlgo(remote, settings);
  if (algo) {
    const r = await remote.serverHash(item.remote, algo, src.size).catch(() => null);
    if (r) {
      const l = await hashFile(p, algo, n => ctx.onBytes(n, 'verify-local'), ctx.token);
      if (l !== r) throw mismatch(offset, `${HASH_LABELS[algo]} differs: copy ${l}, server ${r}.`);
      return { level: 'server', algo };
    }
  }
  if (streamAlgo) {
    const l = await hashFile(p, 'xxh64', n => ctx.onBytes(n, 'verify-local'), ctx.token);
    if (l !== streamHash) throw mismatch(0, `The copy on disk differs from what was received (xxHash64 ${l} vs ${streamHash}).`);
    return { level: 'received', algo: 'xxh64' };
  }
  if (settings.readBack) {
    const r = await readBackHash(remote, item.remote, ctx);
    const l = await hashFile(p, 'xxh64', null, ctx.token);
    if (l !== r) throw mismatch(offset, `xxHash64 differs: copy ${l}, server ${r}.`);
    return { level: 'readback', algo: 'xxh64' };
  }
  return { level: 'size' };
}


// ══ Segments ═════════════════════════════════════════════════════════════
// One large file, several connections at once (SFTP only).
//
// Why: one SFTP connection carries at most what the window allows per round
// trip. Sending, the SERVER sets that window — OpenSSH grants 2 MB — so from
// Dubai to Paris (120 ms) one connection tops out near 15 MB/s on any fibre.
// And a server runs each SSH connection on one core. Cutting the file into
// segments that several connections carry side by side multiplies both.
//
// How: the file is described as a list of segments [start, end). Any free
// connection of the queue takes the next pending segment, writes it at its
// place in the .filopart (positional writes, the file is never truncated by a
// segment), and verifies it on the spot when the server cannot compute a
// checksum of the whole file:
//   download  the segment is read back from the local disk and compared with
//             what arrived (xxHash64);
//   upload    with "read back" on, the segment is read back from the server
//             and compared with what was sent (xxHash64).
// When every segment is in, one connection finalises: size, then the
// server's checksum of the whole file if it can compute one, then the real
// name and the date.
//
// Resuming: finished segments are kept (the list is saved with the queue),
// and a segment that was cut keeps what is in place (`got`, see runSegment).
//
// Segment size (0.3.2, chosen for overall speed): about 16 segments per file,
// each between 32 and 256 MB, from 64 MB up. 16 is more than the most
// connections filo opens (10), so every connection has work until the end of
// the file, and the last segments, smaller, do not leave one connection
// alone on a long tail. 32 MB at least keeps the cost of a segment (opening
// the file, warming up the read depth, checking the segment) small next to
// what it carries; 256 MB at most keeps resume fine on huge files.
// Before 0.3.2: 256 MB always, from 512 MB — a 1 GB file was 4 segments and
// could use only 4 connections, however many were open.
const MB = 1024 * 1024;
const SEG_MIN = 32 * MB, SEG_MAX = 256 * MB, SEG_TARGET = 16;
// FILO_TEST_SEGMENT_MB exists for the test suite only (small files, many segments).
const TEST_SEG = (Number(process.env.FILO_TEST_SEGMENT_MB) || 0) * MB;
const SEGMENT_MIN_FILE = TEST_SEG ? 2 * TEST_SEG : 2 * SEG_MIN;
function segmentSizeFor(size) {
  if (TEST_SEG) return TEST_SEG;
  return Math.min(SEG_MAX, Math.max(SEG_MIN, Math.ceil(size / SEG_TARGET / MB) * MB));
}
const SEGMENT_SIZE = TEST_SEG || SEG_MAX;     // the largest; kept for the tests

function segmentable(remote, settings, size) {
  return !!(remote && remote.canSegment) && settings.segments !== false && size >= SEGMENT_MIN_FILE;
}

function makeChunks(size, chunkSize) {
  const out = [];
  for (let s = 0; s < size; s += chunkSize) out.push({ s, e: Math.min(size, s + chunkSize), st: 'p' });
  return out;
}

async function prepareSegments(item, ctx, src, t) {
  const { remote, settings } = ctx;
  const up = item.dir === 'up';
  const prev = item.seg;
  let keep = false;
  if (prev && !item.restartFromZero && prev.writePath === t.writePath && sameSource(item, src) && prev.size === src.size) {
    const part = up ? await remote.stat(t.writePath) : await local.stat(t.writePath);
    keep = !!(part && part.type === 'file');
  }
  let verify = 'size', algo = null;
  if (settings.verify) {
    algo = await pickServerAlgo(remote, settings);
    if (algo) verify = 'server';
    else if (!up) verify = 'chunk';
    else if (settings.readBack) verify = 'chunk';
  }
  if (!keep) {
    if (up) await remote.createEmpty(t.writePath);
    else { const fd = await require('fs').promises.open(t.writePath, 'w'); await fd.close(); }
  }
  const chunks = keep ? prev.chunks.map(c => (c.st === 'd' ? { s: c.s, e: c.e, st: 'd' } : { s: c.s, e: c.e, st: 'p', got: Math.max(0, Math.min(c.e - c.s, Number(c.got) || 0)) })) : makeChunks(src.size, segmentSizeFor(src.size));
  item.seg = { writePath: t.writePath, finalPath: t.finalPath, useTemp: t.useTemp, replacing: t.replacing, size: src.size, verify, algo, chunks };
  item.resume = { srcSize: src.size, srcMtime: src.mtime };
  item.restartFromZero = false;
  const doneBytes = chunks.reduce((a, c) => a + (c.st === 'd' ? c.e - c.s : (c.got || 0)), 0);
  item.offset = doneBytes;
  ctx.onBytes(doneBytes, 'resume');
  const name = up ? posix.basename(t.finalPath) : path.basename(t.finalPath);
  ctx.log('info', `${name}: ${chunks.length} segments of ${Math.round((chunks[0].e - chunks[0].s) / 1048576)} MB${keep && doneBytes ? `, ${chunks.filter(c => c.st === 'd').length} already done` : ''}`);
  return { status: 'segmented' };
}

// A segment resumes inside itself (0.3.1): `c.got` is how much of it, from
// its start, is known to be in place. Before, a segment cut half-way started
// again from its start: with 256 MB segments, a cut early in a big file lost
// everything and the progress fell back to 0 %.
// What is "known in place" is reported to the queue when the segment stops
// ('segkeep'): for a download, exactly what the local file received (the
// writes are in order); for an upload, what was sent minus a margin for the
// writes still on their way, which a server may complete in any order.
const UPLOAD_SEG_MARGIN = 6 * 1024 * 1024;
async function runSegment(item, idx, ctx) {
  const { remote } = ctx;
  const seg = item.seg;
  const c = seg.chunks[idx];
  const got = Math.max(0, Math.min(c.e - c.s, Number(c.got) || 0));
  const start = c.s + got;
  const len = c.e - start;
  const check = seg.verify === 'chunk';
  if (item.dir === 'down') {
    const tap = new Tap(check ? await createHasher('xxh64') : null, n => ctx.onBytes(n, 'transfer'), ctx.limiter);
    const sink = new local.LocalSink(seg.writePath, start, { segment: true });
    tap.pipe(sink);
    const sinkDone = finished(sink);
    sinkDone.catch(() => {});
    ctx.token.onAbort = () => { tap.destroy(Object.assign(new Error('Stopped.'), { aborted: true })); sink.destroy(); };
    try {
      await remote.downloadRange(item.remote, tap, start, c.e);
      await sinkDone;
    } catch (e) {
      ctx.onBytes(got + Math.max(0, sink.pos - start), 'segkeep');
      throw e;
    }
    ctx.token.onAbort = null;
    if (tap.bytes !== len) { ctx.onBytes(got + Math.max(0, sink.pos - start), 'segkeep'); throw new RemoteError(`Segment ${idx + 1}: received ${tap.bytes} bytes of ${len}.`, { network: true, sizeMismatch: true }); }
    if (check) {
      // The part received now, read back from the disk.
      const l = await hashFile(seg.writePath, 'xxh64', null, ctx.token, start, c.e);
      if (l !== tap.digest()) throw new MismatchError(`Segment ${idx + 1}: the copy on disk differs from what was received.`, { mismatch: true, network: true, segment: true });
    }
  } else {
    const tap = new Tap(check ? await createHasher('xxh64') : null, n => ctx.onBytes(n, 'transfer'), ctx.limiter);
    const rs = local.createReadStream(item.local, start, c.e);
    rs.on('error', e => tap.destroy(e));
    rs.pipe(tap);
    ctx.token.onAbort = () => { rs.destroy(); tap.destroy(Object.assign(new Error('Stopped.'), { aborted: true })); };
    try { await remote.uploadRange(tap, seg.writePath, start); }
    catch (e) {
      ctx.onBytes(got + Math.max(0, tap.bytes - UPLOAD_SEG_MARGIN), 'segkeep');
      throw e;
    }
    ctx.token.onAbort = null;
    if (tap.bytes !== len) throw new RemoteError(`Segment ${idx + 1}: sent ${tap.bytes} bytes of ${len}.`, { network: true, sizeMismatch: true });
    if (check) {
      // The whole segment is read back from the server. Resumed, it is
      // compared with the local file itself (the stream saw only the end).
      const back = new Tap(await createHasher('xxh64'), n => ctx.onBytes(n, 'verify'));
      const sink = nullSink();
      back.pipe(sink);
      ctx.token.onAbort = () => back.destroy(Object.assign(new Error('Stopped.'), { aborted: true }));
      await remote.downloadRange(seg.writePath, back, c.s, c.e);
      await finished(sink);
      ctx.token.onAbort = null;
      const want = got ? await hashFile(item.local, 'xxh64', null, ctx.token, c.s, c.e) : tap.digest();
      if (back.digest() !== want) throw new MismatchError(`Segment ${idx + 1}: what the server holds differs from what was sent.`, { mismatch: true, network: true, segment: true });
    }
  }
  if (ctx.token.cancelled) throw Object.assign(new RemoteError('Stopped.'), { aborted: true });
  return { status: 'segment-done' };
}

async function finalizeSegments(item, ctx) {
  const { remote, settings } = ctx;
  const seg = item.seg;
  const up = item.dir === 'up';
  // The source must still be the file the segments came from.
  const src = up ? await local.stat(item.local) : await remote.stat(item.remote);
  if (!src || src.size !== seg.size || !sameSource(item, src)) {
    throw new RemoteError('The source changed during the transfer: it is sent again from the start.', { network: true, mismatch: true, resumed: true });
  }
  const landed = up ? await remote.stat(seg.writePath) : await local.stat(seg.writePath);
  if (!landed || landed.size !== seg.size) {
    throw new RemoteError(`The assembled file holds ${landed ? landed.size : 0} bytes of ${seg.size}.`, { network: true, mismatch: true, resumed: true });
  }
  let verify = { level: 'size' };
  if (seg.verify === 'server') {
    ctx.onBytes(0, 'verify-start');
    const remotePath = up ? seg.writePath : item.remote;
    const localPath = up ? item.local : seg.writePath;
    const r = await remote.serverHash(remotePath, seg.algo, seg.size).catch(() => null);
    if (r) {
      const l = await hashFile(localPath, seg.algo, n => ctx.onBytes(n, 'verify-local'), ctx.token);
      if (l !== r) throw new MismatchError(`${HASH_LABELS[seg.algo]} of the whole file differs: ${l} vs ${r}.`, { mismatch: true, network: true, resumed: true });
      verify = { level: 'server', algo: seg.algo };
    }
  } else if (seg.verify === 'chunk') {
    verify = up ? { level: 'readback', algo: 'xxh64' } : { level: 'received', algo: 'xxh64' };
  }
  if (seg.useTemp) {
    const target = await recheckTarget(item, ctx, src, seg.finalPath, seg.replacing);
    if (!target) { await dropWritten(item, ctx, seg.writePath); item.seg = null; return { status: 'skipped', note: 'Already there' }; }
    if (target !== seg.finalPath) { seg.finalPath = target; seg.replacing = false; }
    else seg.replacing = true;
  }
  if (up) {
    if (seg.useTemp) await promote(remote, seg.writePath, seg.finalPath, seg.replacing);
    noteWritten(remote, seg.finalPath);
    if (settings.keepDates !== false && remote.canSetMTime && src.mtime) { try { await remote.setMTime(seg.finalPath, src.mtime); } catch (_) {} }
  } else {
    if (seg.useTemp) await local.replace(seg.writePath, seg.finalPath);
    if (settings.keepDates !== false && src.mtime) { try { await local.setMTime(seg.finalPath, src.mtime); } catch (_) {} }
  }
  item.seg = null;
  return { status: 'done', verify };
}

// The partial left by an item that is removed from the queue.
async function dropPart(item, remote) {
  try {
    if (item.dir === 'up') { if (remote) await remote.unlink(item.remote + PART); }
    else await require('fs').promises.unlink(item.local + PART);
  } catch (_) {}
}

module.exports = { ensureLocalDirForTest: ensureLocalDir, runFile, runFolder, runSegment, finalizeSegments, ensureRemoteDir, promote, dropPart, PART, OLD, MismatchError, SEGMENT_SIZE, SEGMENT_MIN_FILE, segmentable, segmentSizeFor };
