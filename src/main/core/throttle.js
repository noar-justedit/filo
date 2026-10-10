/*
 * filo — FTP, FTPS and SFTP client
 * Copyright (C) 2026 Just Edit (Arnaud Augst)
 * Licensed under the GNU General Public License v3.0 or later. See LICENSE.
 */

// Speed limit, shared by every transfer going the same way (FileZilla has one
// too; useful when an upload must not starve a video call or a live stream on
// the same line). A token bucket: tokens arrive at `rate` bytes per second,
// a transfer takes as many as it sends, and waits when there are none left.
// The bucket holds half a second, so a burst stays short.

class Limiter {
  constructor() { this.rate = 0; this.tokens = 0; this.last = Date.now(); this.waiters = []; this.timer = null; }

  setRate(bytesPerSecond) {
    const r = Math.max(0, Number(bytesPerSecond) || 0);
    if (r === this.rate) return;
    this.rate = r;
    this.tokens = Math.min(this.tokens, r / 2);
    if (!r) this._releaseAll();
  }

  _refill() {
    const now = Date.now();
    this.tokens = Math.min(this.rate / 2 || Infinity, this.tokens + (now - this.last) / 1000 * this.rate);
    this.last = now;
  }

  // Resolves when `n` bytes may go. Immediate when there is no limit.
  take(n) {
    if (!this.rate) return null;
    this._refill();
    if (!this.waiters.length && this.tokens >= n) { this.tokens -= n; return null; }
    return new Promise(resolve => { this.waiters.push({ n, resolve }); this._schedule(); });
  }

  _schedule() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.rate) return this._releaseAll();
      this._refill();
      while (this.waiters.length) {
        const w = this.waiters[0];
        // A chunk larger than the bucket goes as soon as the bucket is full.
        const need = Math.min(w.n, this.rate / 2);
        if (this.tokens < need) break;
        this.tokens -= w.n;
        this.waiters.shift();
        w.resolve();
      }
      if (this.waiters.length) this._schedule();
    }, 20);
  }

  _releaseAll() { const w = this.waiters; this.waiters = []; for (const x of w) x.resolve(); }
}

module.exports = { Limiter };
