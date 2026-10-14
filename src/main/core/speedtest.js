/*
 * filo — FTP, FTPS and SFTP client
 * Copyright (C) 2026 Just Edit (Arnaud Augst)
 * Licensed under the GNU General Public License v3.0 or later. See LICENSE.
 */

// The speed test of a bookmark (0.8.0): how fast is THIS server, sending and
// receiving, and with how many connections?
//
// It opens a few connections, then goes through steps: 1, 2, 4, 8 connections
// (as many as the server accepts), and for SFTP one big file cut in segments.
// Each step sends (OUT) then reads back (IN) for a short moment. From the
// speeds it suggests the starting number of connections (one more is kept
// only when it buys 10 %) and whether segments help.
//
// The test writes temporary files in the login folder of the account (named
// .filo-speedtest-…, 512 MB at most each) and removes them at the end, also
// when it is cancelled or fails. Nothing else on the server is touched.
//
// Pure of Electron: the caller gives the way to open a connection.

const { Readable, Writable } = require('stream');
const crypto = require('crypto');
const { better } = require('./autotune');

const MAX_CONN = 8;
const CAP_FILE = 512 * 1024 * 1024;     // per connection and step
const REGION = 64 * 1024 * 1024;        // spacing of the segments of the big file
const SEG_CONN = 4;
const CHUNK = 256 * 1024;
const MB = 1e6;
const SAMPLE_MS = 250;
const PREFIX = '.filo-speedtest-';

class Cancelled extends Error { constructor() { super('Cancelled.'); this.cancelled = true; } }

// The steps for `opened` connections: 1, 2, 4, 8 and the last number itself.
function stepsFor(opened) {
  const s = [1, 2, 4, 8].filter(n => n <= opened);
  if (opened > 0 && !s.includes(opened)) s.push(opened);
  return s;
}

// Fewest connections that is within 10 % gain of the best: one more
// connection must buy 10 %, as in Auto (autotune.js).
function suggest(steps) {
  let pick = steps[0];
  for (const s of steps.slice(1)) {
    if (better({ bps: s.mbps, fps: 0 }, { bps: pick.mbps, fps: 0 })) pick = s;
  }
  return pick ? pick.n : 1;
}

function randomChunk() { return crypto.randomBytes(CHUNK); }

// A source that gives bytes until `stop()` says so (or `limit` is reached).
function source(chunk, stop, limit, count) {
  let sent = 0;
  return new Readable({
    highWaterMark: CHUNK,
    read() {
      if (stop() || sent >= limit) return this.push(null);
      sent += chunk.length;
      count(chunk.length);
      this.push(chunk);
    },
  });
}

// A destination that only counts, and gives up at the deadline.
function sink(stop, count) {
  const w = new Writable({
    highWaterMark: CHUNK,
    write(buf, _e, cb) {
      if (stop()) return cb(Object.assign(new Error('time'), { time: true }));
      count(buf.length); cb();
    },
  });
  return w;
}

// Where the test works. The folder asked for (the bookmark's, or the one the
// user picked) is tried with a tiny file, written and removed.
//  - no folder and the login folder is the server root: PICK_DIR (the user chooses);
//  - the folder refuses the file: READONLY (the user may test reception only).
function stop_(code, message, dir) { return Object.assign(new Error(message), { code, dir }); }
async function canWrite(r, dir) {
  const p = (dir.endsWith('/') ? dir : dir + '/') + PREFIX + 'probe-' + crypto.randomBytes(3).toString('hex');
  try {
    await r.upload(Readable.from([Buffer.from('filo')]), p, 0);
    try { await r.unlink(p); } catch (_) {}
    return true;
  } catch (_) { try { await r.unlink(p); } catch (__) {} return false; }
}
async function resolveDir(r, home, opts) {
  const dir = opts.dir || '';
  const eff = dir || home;
  if (!opts.dir && (eff === '/' || eff === '')) throw stop_('PICK_DIR', 'Choose a folder for the test.', '/');
  if (opts.readOnly) return eff;
  if (!(await canWrite(r, eff))) throw stop_('READONLY', 'This folder is read-only for this account.', eff);
  return eff;
}
// Existing files to read, for a test that cannot write: the biggest ones.
async function readableFiles(r, dir) {
  let l = [];
  try { l = await r.list(dir); } catch (_) {}
  const files = l.filter(e => e.type === 'file' && e.size > 0 && !e.name.startsWith(PREFIX)).sort((x, y) => y.size - x.size).slice(0, 8);
  if (!files.length) throw stop_('NO_FILE', 'A reception-only test needs a file to read, and ' + dir + ' has none.', dir);
  return files.map(e => (dir.endsWith('/') ? dir : dir + '/') + e.name);
}

async function runSpeedTest(opts) {
  const { open, durationMs, onEvent, token, log } = opts;
  const emit = e => { try { if (onEvent) onEvent(e); } catch (_) {} };
  const check = () => { if (token && token.cancelled) throw new Cancelled(); };
  const remotes = [];
  const made = [];                       // every temporary file, to remove
  let home = '/';
  const total = Math.max(6000, Number(durationMs) || 20000);
  const res = { at: Date.now(), out: null, in: null, maxOpen: 0, latencyMs: null, hash: [], protocol: '', error: null };

  // Everything started by the test, to cut at once on cancel.
  const live = new Set();
  const track = s => { live.add(s); const d = () => live.delete(s); s.once('close', d); s.once('error', d); return s; };
  if (token) token.cut = () => { for (const s of live) { try { s.destroy(new Cancelled()); } catch (_) {} } };

  try {
    // ── 1. Connections
    emit({ type: 'phase', phase: 'connect' });
    const want = Math.max(1, Math.min(MAX_CONN, Number(opts.maxConnections) || MAX_CONN));
    for (let i = 0; i < want; i++) {
      check();
      const r = opts.create();
      try { await r.connect(); }
      catch (e) {
        try { r.close(); } catch (_) {}
        if (!remotes.length) throw e;      // not even one: the real reason
        if (log) log('info', `Speed test: the server accepts ${remotes.length} connection${remotes.length > 1 ? 's' : ''} (the next one: ${e.message.split('\n')[0]})`);
        break;
      }
      remotes.push(r);
      if (remotes.length === 1) {
        let h0 = '/'; try { h0 = await r.home(); } catch (_) {}
        home = await resolveDir(r, h0, opts);
        check();
      }
    }
    check();
    const first = remotes[0];
    res.maxOpen = remotes.length;
    res.capped = remotes.length < want;      // the server said no before the limit
    res.protocol = opts.protocol || '';
    try { res.hash = await first.hashAlgos(); } catch (_) { res.hash = []; }
    const t0 = Date.now();
    try { for (let i = 0; i < 3; i++) await first.stat(home); res.latencyMs = Math.max(1, Math.round((Date.now() - t0) / 3)); } catch (_) {}
    emit({ type: 'info', latencyMs: res.latencyMs, maxOpen: res.maxOpen, capped: res.capped, hash: res.hash, protocol: res.protocol });

    const id = crypto.randomBytes(4).toString('hex');
    const name = k => (home.endsWith('/') ? home : home + '/') + `${PREFIX}${id}-${k}`;
    const readOnly = !!opts.readOnly;
    const canSeg = !readOnly && !!first.canSegment && remotes.length >= 2;
    const steps = stepsFor(remotes.length);
    const segN = Math.min(SEG_CONN, remotes.length);
    const per = total / (readOnly ? 1 : 2) / (steps.length + (canSeg ? 1 : 0));
    const chunk = randomChunk();

    // One step: `n` connections work for `per` ms, bytes counted as they
    // pass. Returns MB/s over the real elapsed time (a sending step also
    // waits for the server to take what was sent).
    const doStep = async (dir, idx, label, workers) => {
      check();
      const stepStart = Date.now(), deadline = stepStart + per;
      let bytes = 0, last = 0, lastT = stepStart, ema = 0;
      const stop = () => Date.now() >= deadline || !!(token && token.cancelled);
      const count = n => { bytes += n; };
      const timer = setInterval(() => {
        const now = Date.now(), v = (bytes - last) / ((now - lastT) / 1000) / MB;
        ema = ema ? ema * 0.6 + v * 0.4 : v; last = bytes; lastT = now;
        emit({ type: 'sample', dir, step: idx, label, mbps: ema, frac: Math.min(1, (now - stepStart) / per) });
      }, SAMPLE_MS);
      try {
        await Promise.all(workers.map(w => w(stop, count)));
      } finally { clearInterval(timer); }
      check();
      const secs = Math.max(0.05, (Date.now() - stepStart) / 1000);
      return bytes / secs / MB;
    };

    // An error after the deadline is the end of the step (a read cut on time); before it, a real one.
    const ignoreTime = (e, stop) => { if (token && token.cancelled) throw new Cancelled(); if (!stop()) throw e; };

    // ── 2. OUT
    const outSteps = [];
    const lastFiles = [];
    if (readOnly) lastFiles.push(...await readableFiles(first, home));
    else emit({ type: 'phase', phase: 'out', steps: steps.map(String).concat(canSeg ? ['SEG'] : []) });
    for (let s = 0; s < steps.length && !readOnly; s++) {
      const n = steps[s];
      const files = [];
      const workers = [];
      for (let k = 0; k < n; k++) {
        const p = name(`o${n}-${k}`); made.push(p); files.push(p);
        workers.push(async (stop, count) => {
          const src = track(source(chunk, stop, CAP_FILE, count));
          try { await remotes[k].upload(src, p, 0); } catch (e) { ignoreTime(e, stop); }
        });
      }
      const mbps = await doStep('out', s, String(n), workers);
      outSteps.push({ n, mbps });
      lastFiles.length = 0; lastFiles.push(...files);
    }
    let segOut = null, segFile = null, regionBytes = [];
    if (canSeg) {
      segFile = name('seg'); made.push(segFile);
      await first.createEmpty(segFile);
      regionBytes = new Array(segN).fill(0);
      const workers = [];
      for (let k = 0; k < segN; k++) {
        workers.push(async (stop, count) => {
          const src = track(source(chunk, stop, REGION, n => { regionBytes[k] += n; count(n); }));
          try { await remotes[k].uploadRange(src, segFile, k * REGION); } catch (e) { ignoreTime(e, stop); }
        });
      }
      segOut = await doStep('out', steps.length, 'SEG', workers);
    }
    if (!readOnly) { res.out = summarise(outSteps, segOut, canSeg); emit({ type: 'dir', dir: 'out', result: res.out }); }

    // ── 3. IN: what was just sent is read back, as many times as needed
    emit({ type: 'phase', phase: 'in', steps: steps.map(String).concat(canSeg ? ['SEG'] : []) });
    const inSteps = [];
    for (let s = 0; s < steps.length; s++) {
      const n = steps[s];
      const workers = [];
      for (let k = 0; k < n; k++) {
        const p = lastFiles[k % lastFiles.length];
        workers.push(async (stop, count) => {
          while (!stop()) {
            const dst = track(sink(stop, count));
            try { await remotes[k].download(p, dst, 0); } catch (e) { ignoreTime(e, stop); break; }
          }
        });
      }
      inSteps.push({ n, mbps: await doStep('in', s, String(n), workers) });
    }
    let segIn = null;
    if (canSeg) {
      const workers = [];
      for (let k = 0; k < segN; k++) {
        const len = Math.max(CHUNK, regionBytes[k]);
        workers.push(async (stop, count) => {
          while (!stop()) {
            const dst = track(sink(stop, count));
            try { await remotes[k].downloadRange(segFile, dst, k * REGION, k * REGION + len); } catch (e) { ignoreTime(e, stop); break; }
          }
        });
      }
      segIn = await doStep('in', steps.length, 'SEG', workers);
    }
    res.in = summarise(inSteps, segIn, canSeg);
    emit({ type: 'dir', dir: 'in', result: res.in });
  } finally {
    if (token) token.cut = null;
    for (const s of live) { try { s.destroy(); } catch (_) {} }
    // The temporary files go, whatever happened.
    if (made.length && remotes.length) {
      for (const p of made) { try { await remotes[0].unlink(p); } catch (_) {} }
    }
    for (const r of remotes) { try { await r.close(); } catch (_) {} }
  }
  emit({ type: 'done', result: res });
  return res;
}

function summarise(steps, seg, canSeg) {
  const best = steps.reduce((m, s) => Math.max(m, s.mbps), 0);
  const conn = suggest(steps);
  const one = steps[0] ? steps[0].mbps : 0;
  return {
    steps, seg, conn, mbps: Math.max(best, seg || 0),
    // Segments: one big file in pieces must be 10 % faster than the same file
    // on one connection. null: the server (FTP) does not do segments.
    segOn: canSeg && seg != null ? seg >= one * 1.10 : null,
  };
}

module.exports = { resolveDir, canWrite, runSpeedTest, stepsFor, suggest, Cancelled, PREFIX, MAX_CONN };
