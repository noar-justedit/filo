/*
 * filo — FTP, FTPS and SFTP client
 * Copyright (C) 2026 Just Edit (Arnaud Augst)
 * Licensed under the GNU General Public License v3.0 or later. See LICENSE.
 */

// "Auto" simultaneous transfers: find, by measuring, how many connections make
// THIS server fastest right now.
//
// It climbs one connection at a time. Each step is judged over a short window
// on two measures at once:
//   bytes per second  — what decides for large files
//   files per second  — what decides for many small files, where the round
//                       trips per file, not the bandwidth, are the limit
// A step is kept when either measure gains at least 10 % and neither loses
// more than 10 %. Otherwise filo goes back to the best step seen and holds it,
// then tries one step higher again a minute later: networks change.
//
// A window only counts when every connection had something to do the whole
// time. Four files left on twelve connections measures the end of the queue,
// not the server.
//
// Pure logic, no timers of its own: the queue feeds it, and asks it for the
// level. That is what makes it testable without a network.

const GAIN = 1.10;      // a step must buy 10 %
const LOSS = 0.90;      // and cost no more than 10 % on the other measure
const WINDOW_MS = 8000;
const MIN_WINDOW_MS = 3000;
const ENOUGH_FILES = 20;
const SETTLE_MS = 1500; // after a change: connections opening, TCP ramping up
const HOLD_MS = 60000;

class AutoTuner {
  constructor(opts) {
    const o = opts || {};
    this.max = Math.max(1, o.max || 10);
    this.level = Math.min(this.max, o.start || 2);
    this.cap = Infinity;              // a limit the server enforced
    this.results = new Map();         // level → { bps, fps }
    this.phase = 'climb';             // climb | hold
    this.holdUntil = 0;
    this._reset(o.now || Date.now());
    this.note = 'measuring';
  }

  _reset(now) {
    this.winStart = now + SETTLE_MS;
    this.winBytes = 0;
    this.winFiles = 0;
    this.saturated = true;
  }

  limit() { return Math.max(1, Math.min(this.level, this.max, this.cap)); }

  setMax(n, now) {
    this.max = Math.max(1, n);
    if (this.level > this.max) { this.level = this.max; this._reset(now || Date.now()); }
  }

  // The server said no to one more connection: never ask for that many again.
  serverRefused(openConnections, now) {
    const cap = Math.max(1, openConnections);
    if (cap < this.cap) this.cap = cap;
    if (this.level > this.cap) this.level = this.cap;
    this.phase = 'hold';
    this.holdUntil = (now || Date.now()) + HOLD_MS * 10;  // a server limit does not change by itself
    this.note = `server allows ${this.cap}`;
    this._reset(now || Date.now());
  }

  // A new run (Start): a limit one server enforced says nothing about the
  // next one, and the first file in segments may start higher again. What
  // was measured stays as the starting point.
  newRun(now) {
    this.cap = Infinity;
    this.boosted = false;
    if (this.phase === 'hold' && /^server allows/.test(this.note)) { this.phase = 'climb'; this.note = 'measuring'; }
    this._reset(now || Date.now());
  }

  // A file cut into segments is one big transfer that gains from several
  // connections at once: climbing from 2, one step every 8 s, would spend
  // most of a medium file below its best speed. So the first segmented file
  // starts the climb higher, once. Measuring goes on from there, and a level
  // that buys nothing is still left.
  boost(n, now) {
    if (this.boosted) return false;
    this.boosted = true;
    const target = Math.max(1, Math.min(n, this.max, this.cap));
    if (this.phase !== 'climb' || target <= this.level) return false;
    this.level = target;
    this.note = 'measuring';
    this._reset(now || Date.now());
    return true;
  }

  // Called by the queue as things happen.
  addBytes(n, now) { if ((now || Date.now()) >= this.winStart) this.winBytes += n; }
  addFile(now) { if ((now || Date.now()) >= this.winStart) this.winFiles += 1; }

  // Called on every tick with whether all `limit()` connections are busy.
  // Returns true when the level changed.
  tick(busy, queuedLeft, now) {
    const t = now || Date.now();
    if (t < this.winStart) return false;
    if (busy < this.limit() || queuedLeft <= 0) this.saturated = false;
    const elapsed = t - this.winStart;
    const done = elapsed >= WINDOW_MS || (elapsed >= MIN_WINDOW_MS && this.winFiles >= ENOUGH_FILES);
    if (!done) return false;

    if (!this.saturated) { this._reset(t); return false; }   // not a fair measure

    const sec = elapsed / 1000;
    const cur = { bps: this.winBytes / sec, fps: this.winFiles / sec };
    const prevBest = this.results.get(this.level);
    // Several windows at one level: keep the better reading (noise is mostly
    // downward — a pause, a slow file).
    this.results.set(this.level, prevBest ? { bps: Math.max(prevBest.bps, cur.bps), fps: Math.max(prevBest.fps, cur.fps) } : cur);

    const before = this.level;
    if (this.phase === 'hold') {
      if (t >= this.holdUntil && this.level < Math.min(this.max, this.cap)) {
        this.phase = 'climb';
        this.level += 1;
        this.note = 'measuring';
      }
    } else {
      const below = this.results.get(this.level - 1);
      if (below && !better(cur, below)) {
        // This step bought nothing: back to the best one, and stay.
        this.level = this.bestLevel();
        this.phase = 'hold';
        this.holdUntil = t + HOLD_MS;
        this.note = 'best found';
      } else if (this.level < Math.min(this.max, this.cap)) {
        this.level += 1;
        this.note = 'measuring';
      } else {
        this.phase = 'hold';
        this.holdUntil = t + HOLD_MS;
        this.note = this.level >= this.cap ? `server allows ${this.cap}` : 'at maximum';
      }
    }
    this._reset(t);
    return this.level !== before;
  }

  bestLevel() {
    let best = null, bestLv = this.level;
    for (const [lv, r] of [...this.results.entries()].sort((a, b) => a[0] - b[0])) {
      if (!best || better(r, best)) { best = r; bestLv = lv; }
    }
    return Math.min(bestLv, this.max, this.cap);
  }
}

// a is better than b: one measure gains GAIN, the other does not lose LOSS.
function better(a, b) {
  const up = (x, y) => (y <= 0 ? x > 0 : x >= y * GAIN * (1 - 1e-9));
  const notDown = (x, y) => (y <= 0 ? true : x >= y * LOSS);
  return (up(a.bps, b.bps) && notDown(a.fps, b.fps)) || (up(a.fps, b.fps) && notDown(a.bps, b.bps));
}

const SEGMENT_START = 4;

module.exports = { AutoTuner, SEGMENT_START, better, WINDOW_MS, SETTLE_MS, HOLD_MS };
