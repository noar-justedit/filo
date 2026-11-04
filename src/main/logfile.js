/*
 * filo — FTP, FTPS and SFTP client
 * Copyright (C) 2026 Just Edit (Arnaud Augst)
 * Licensed under the GNU General Public License v3.0 or later. See LICENSE.
 */

// The log kept on disk, so that what happened is still there after filo is
// closed: <profile>/logs/filo.log, the newest lines at the end. When it
// reaches `maxBytes` it becomes filo.1.log (filo.1 becomes filo.2, and so on)
// and a new filo.log starts; past `keep` old files the oldest is deleted. The
// whole stays under (keep + 1) × maxBytes: 25 MB by default.
//
// The lines are the ones of the LOG tab: never a password (nothing that goes
// to the log ever carries one). Written in batches, every half second, each
// time by opening, appending and closing the file: no handle stays open, so a
// rotation can rename the file on Windows too.

const fs = require('fs');
const path = require('path');
const fsp = fs.promises;

class LogFile {
  constructor(dir, o) {
    const opts = o || {};
    this.dir = dir;
    this.file = path.join(dir, 'filo.log');
    this.maxBytes = opts.maxBytes || 5 * 1024 * 1024;
    this.keep = opts.keep == null ? 4 : opts.keep;
    this.delayMs = opts.delayMs == null ? 500 : opts.delayMs;
    this.size = 0;
    this.pending = [];
    this.timer = null;
    this.chain = Promise.resolve();
    this.broken = false;
    try {
      fs.mkdirSync(dir, { recursive: true });
      this.size = fs.existsSync(this.file) ? fs.statSync(this.file).size : 0;
    } catch (_) { this.broken = true; }
  }

  static format(line) {
    const d = new Date(line.t || Date.now());
    const p = (n, w = 2) => String(n).padStart(w, '0');
    const t = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
    const lvl = String(line.level || 'info').toUpperCase().padEnd(5);
    // One line per entry: a message on several lines is kept readable, indented.
    return `${t} ${lvl} ${String(line.msg).replace(/\r?\n/g, '\n                              ')}\n`;
  }

  write(line) {
    if (this.broken) return;
    this.pending.push(LogFile.format(line));
    if (!this.timer) this.timer = setTimeout(() => { this.timer = null; this.flush(); }, this.delayMs);
  }

  // Appends what is waiting; one flush at a time, in order.
  flush() {
    if (!this.pending.length) return this.chain;
    const text = this.pending.join('');
    this.pending = [];
    this.chain = this.chain.then(async () => {
      try {
        if (this.size > 0 && this.size + Buffer.byteLength(text) > this.maxBytes) await this.rotate();
        await fsp.appendFile(this.file, text, { mode: 0o600 });
        this.size += Buffer.byteLength(text);
      } catch (_) { /* a log that cannot be written must never stop filo */ }
    });
    return this.chain;
  }

  // filo.(keep-1).log … filo.1.log move up one; the oldest goes; filo.log
  // becomes filo.1.log.
  async rotate() {
    const name = k => path.join(this.dir, `filo.${k}.log`);
    await fsp.unlink(name(this.keep)).catch(() => {});
    for (let k = this.keep - 1; k >= 1; k--) await fsp.rename(name(k), name(k + 1)).catch(() => {});
    if (this.keep > 0) await fsp.rename(this.file, name(1)).catch(() => {});
    else await fsp.unlink(this.file).catch(() => {});
    this.size = 0;
  }

  // At quit: what is still waiting is written before the process ends.
  flushSync() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.broken || !this.pending.length) return;
    const text = this.pending.join('');
    this.pending = [];
    try { fs.appendFileSync(this.file, text, { mode: 0o600 }); this.size += Buffer.byteLength(text); } catch (_) {}
  }
}

module.exports = { LogFile };
