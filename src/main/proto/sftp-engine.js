/*
 * filo — FTP, FTPS and SFTP client
 * Copyright (C) 2026 Just Edit (Arnaud Augst)
 * Licensed under the GNU General Public License v3.0 or later. See LICENSE.
 */

// The Rust engine (engine/, the program "filo-engine"), seen from filo.
//
// filo keeps everything but the bytes: browsing, the queue, the decisions,
// renames, checks. When a file (or a segment of one) has to move over SFTP,
// the connection that runs it hands the job to its own filo-engine process,
// which opens its own SSH connection to the same server, with the same
// account and the server identity filo already checked, and moves the bytes
// straight between the disk and the network. Why: on Noar's DS920+ the
// JavaScript SSH library was the limit (one connection received 45 to
// 170 MB/s where OpenSSH got 185; the engine, on 4 connections, received a
// 20 GB file in 1'41" against 2'30" for filo before and 2'40" for FileZilla).
//
// Talking to it: one JSON object per line, both ways (see engine/src/main.rs).
// The password or the key go through the pipe, never the command line.
//
// When it is not used (the built-in engine moves the bytes, as before):
//   - FILO_ENGINE=0 in the environment, or the program is not there;
//   - it could not log in or did not see the expected server identity: once
//     per connection, written in the log, and that connection keeps the
//     built-in engine.
// A speed limit (core/throttle.js) is applied by the engine itself: it gets
// the rate with each job, and every change while the job runs.

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');
const { RemoteError } = require('../core/errors');

const EXE = process.platform === 'win32' ? 'filo-engine.exe' : 'filo-engine';

// Where the program is: next to the app once packaged (main.js sets
// FILO_ENGINE_PATH), in engine/target/release while developing.
let _path;
function enginePath() {
  if (_path !== undefined) return _path;
  _path = null;
  if (process.env.FILO_ENGINE === '0') return _path;
  const cands = [process.env.FILO_ENGINE_PATH, path.join(__dirname, '..', '..', '..', 'engine', 'target', 'release', EXE)];
  for (const p of cands) {
    try { if (p && fs.statSync(p).isFile()) { _path = p; break; } } catch (_) {}
  }
  return _path;
}

// An engine error, in the words and flags the queue already understands.
function toError(ev) {
  const msg = String(ev.error || 'The transfer engine stopped.');
  let e;
  if (ev.kind === 'aborted') e = Object.assign(new RemoteError('Stopped.'), { aborted: true });
  else if (ev.kind === 'local') {
    // As a Node file error, so RemoteError turns it into plain words, never retried.
    const raw = Object.assign(new Error(msg), { code: ev.code || 'EIO', syscall: 'write', path: ev.path || '' });
    e = RemoteError.from(raw);
  } else if (ev.kind === 'remote') e = RemoteError.from(new Error(msg), 'sftp');
  else e = new RemoteError(msg, { network: true });
  if (ev.kind === 'auth' || ev.kind === 'hostkey') e.engineRefused = true;
  e.kept = Math.max(0, Number(ev.kept) || 0);
  return e;
}

class Engine {
  // creds: { host, port, user, password, key, passphrase, fingerprint }
  constructor(creds, log) {
    this.creds = creds;
    this.log = log || (() => {});
    this.proc = null;
    this.ready = null;       // promise of the "ready" event
    this.job = null;         // { id, resolve, reject, onBytes }
    this.nextId = 1;
  }

  _send(o) { try { this.proc.stdin.write(JSON.stringify(o) + '\n'); } catch (_) {} }

  start() {
    if (this.ready) return this.ready;
    this.ready = new Promise((resolve, reject) => {
      let p;
      try { p = spawn(enginePath(), ['serve'], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true }); }
      catch (e) { this.ready = null; return reject(Object.assign(e, { engineRefused: true })); }
      this.proc = p;
      let settled = false;
      const timer = setTimeout(() => { if (!settled) { settled = true; this.kill(); reject(Object.assign(new Error('The transfer engine did not start.'), { engineRefused: true })); } }, 30000);
      p.on('error', e => { if (!settled) { settled = true; clearTimeout(timer); this.ready = null; reject(Object.assign(e, { engineRefused: true })); } });
      p.stdin.on('error', () => {});
      readline.createInterface({ input: p.stdout }).on('line', line => {
        let ev;
        try { ev = JSON.parse(line); } catch (_) { return; }
        if (!settled && (ev.ev === 'ready' || ev.ev === 'fatal')) {
          settled = true; clearTimeout(timer);
          if (ev.ev === 'ready') { this.cipher = ev.cipher; resolve(); }
          else { this.kill(); reject(Object.assign(toError(ev), { engineRefused: true })); }
          return;
        }
        const j = this.job;
        if (!j || ev.id !== j.id) return;
        if (ev.ev === 'bytes') { const n = Number(ev.n) || 0; j.reported += n; try { j.onBytes(n); } catch (_) {} if (j.onKept && ev.kept != null) { try { j.onKept(Number(ev.kept) || 0); } catch (_) {} } }
        else if (ev.ev === 'done') {
          this.job = null;
          // The last bytes, moved after the last progress event.
          const rest = (Number(ev.bytes) || 0) - j.reported;
          if (rest > 0) { try { j.onBytes(rest); } catch (_) {} }
          j.resolve({ bytes: Number(ev.bytes) || 0, hash: ev.hash || null });
        }
        else if (ev.ev === 'error') { this.job = null; j.reject(toError(ev)); }
      });
      p.on('exit', () => {
        const wasReady = settled;
        this.proc = null; this.ready = null;
        if (!settled) { settled = true; clearTimeout(timer); reject(Object.assign(new Error('The transfer engine stopped at once.'), { engineRefused: true })); }
        const j = this.job;
        this.job = null;
        if (j && wasReady) j.reject(new RemoteError('The transfer engine stopped.', { network: true, kept: 0 }));
      });
      const c = this.creds;
      this._send({
        op: 'hello', host: c.host, port: Number(c.port) || 22, user: c.user,
        password: c.password || '', key: c.key ? String(c.key) : '', passphrase: c.passphrase || '', fingerprint: c.fingerprint || '',
      });
    });
    return this.ready;
  }

  // job: { op: 'get'|'put', remote, local, start, end, segment, hash }
  // onKept(n): what is surely in place from job.start, as the job runs (0.9.7).
  async run(job, onBytes, token, limiter, onKept) {
    await this.start();
    if (this.job) throw new Error('the transfer engine is already busy');
    // Stopped while the engine was starting: the stop must not be lost (the
    // engine has its own connection, which a stop of filo's does not cut).
    if (token && token.cancelled) throw Object.assign(new RemoteError('Stopped.'), { aborted: true });
    const id = this.nextId++;
    let unwatch = null;
    return new Promise((resolve, reject) => {
      this.job = { id, resolve, reject, onBytes, onKept, reported: 0 };
      if (token) token.onAbort = () => this.abort();
      // The speed limit, now and whenever it changes.
      if (limiter) unwatch = limiter.watch(bps => this._send({ op: 'rate', id, bps }));
      this._send(Object.assign({ id, rate: limiter ? limiter.rate : 0 }, job));
    }).finally(() => { if (token) token.onAbort = null; if (unwatch) unwatch(); });
  }

  abort() { if (this.job && this.proc) this._send({ op: 'abort', id: this.job.id }); }

  kill() {
    const p = this.proc;
    this.proc = null; this.ready = null;
    if (p) { try { p.stdin.end(); } catch (_) {} setTimeout(() => { try { p.kill(); } catch (_) {} }, 2000).unref(); }
  }
}

module.exports = { Engine, enginePath, toError };
