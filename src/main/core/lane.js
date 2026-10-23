/*
 * filo — FTP, FTPS and SFTP client
 * Copyright (C) 2026 Just Edit (Arnaud Augst)
 * Licensed under the GNU General Public License v3.0 or later. See LICENSE.
 */

// A lane: one connection to one server, running one unit of work at a time.
//
// In the app every lane is a WORKER THREAD (WorkerLane): the encryption, the
// SSH packet work and the checksums of each connection run on their own core.
// With every connection in the main thread, ten connections shared one core
// — about 400 MB/s in all on the test machine, whatever the network — and the
// window stuttered during big transfers.
//
// InProcessLane does the same in the calling thread; the tests use it, and it
// is the fallback if a worker cannot start.
//
// Both offer: connect() run(unit, hooks) abort() close() alive setRate(bps)
//   hooks: { onBytes(n, phase), ask(src, dst) → rule, log(level, msg),
//            remember(kind, host, port, fp) }

const path = require('path');
const { createRemote } = require('../proto');
const { runUnit } = require('./runner');
const { RemoteError } = require('./errors');
const { Limiter } = require('./throttle');

function revive(o) {
  const e = new RemoteError(o.message, o);
  return e;
}

class InProcessLane {
  constructor(ep, log) {
    this.ep = ep;
    this.log = log || (() => {});
    this.remote = null;
    this.limiter = new Limiter();
    this.token = null;
  }
  get alive() { return !!(this.remote && this.remote.alive); }
  async connect() {
    this.remote = createRemote(this.ep, { log: this.log });
    await this.remote.connect();
  }
  setRate(bps) { this.limiter.setRate(bps); }
  async run(unit, hooks) {
    const token = { cancelled: false, onAbort: null };
    this.token = token;
    const ctx = {
      settings: unit.settings,
      token,
      limiter: this.limiter,
      log: (lv, m) => hooks.log(lv, m),
      onBytes: (n, ph) => hooks.onBytes(n, ph),
      onMeta: m => { if (hooks.onMeta) hooks.onMeta(m); },
      ask: (_item, src, dst) => hooks.ask(src, dst),
    };
    try { return await runUnit(this.remote, Object.assign({}, unit, { item: JSON.parse(JSON.stringify(unit.item)) }), ctx); }
    finally { this.token = null; }
  }
  abort() {
    if (this.token) { this.token.cancelled = true; try { if (this.token.onAbort) this.token.onAbort(); } catch (_) {} }
    if (this.remote) { try { this.remote.abort(); } catch (_) {} }
  }
  close() { try { if (this.remote) this.remote.close(); } catch (_) {} this.remote = null; }
}

let Worker = null;
try { ({ Worker } = require('worker_threads')); } catch (_) { Worker = null; }

const WORKER_FILE = path.join(__dirname, 'lane-worker.js');

class WorkerLane {
  constructor(ep, log) {
    this.ep = ep;
    this.log = log || (() => {});
    this.worker = null;
    this.ready = false;
    this.dead = false;
    this.pending = new Map();   // request id → { resolve, reject, hooks }
    this.seq = 0;
    this.hooks = null;
  }

  get alive() { return this.ready && !this.dead; }

  _start() {
    this.worker = new Worker(WORKER_FILE, {
      // Kept small: a lane holds a connection and a few MB of buffers.
      resourceLimits: { maxOldGenerationSizeMb: 256 },
    });
    this.worker.on('message', m => this._onMessage(m));
    this.worker.on('error', e => this._fail(e));
    this.worker.on('exit', code => { if (!this.dead) this._fail(new Error(`The transfer thread stopped (${code}).`)); });
  }

  _fail(e) {
    this.dead = true;
    this.ready = false;
    const err = RemoteError.from(e);
    err.network = true;
    for (const [, p] of this.pending) p.reject(err);
    this.pending.clear();
  }

  _call(type, payload, hooks) {
    if (this.dead) return Promise.reject(Object.assign(new RemoteError('This connection is closed.'), { network: true }));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, hooks });
      this.worker.postMessage(Object.assign({ type, id }, payload));
    });
  }

  _onMessage(m) {
    const p = this.pending.get(m.id);
    switch (m.type) {
      case 'log': this.log(m.level, m.msg); return;
      case 'remember': if (this._remember) this._remember(m.kind, m.host, m.port, m.fp); return;
      case 'bytes': if (p && p.hooks) for (const [ph, n] of m.batch) p.hooks.onBytes(n, ph); return;
      case 'meta': if (p && p.hooks && p.hooks.onMeta) p.hooks.onMeta(m.meta); return;
      case 'ask':
        if (!p || !p.hooks) return;
        Promise.resolve(p.hooks.ask(m.src, m.dst)).then(
          rule => this.worker.postMessage({ type: 'answer', id: m.id, rule }),
          err => this.worker.postMessage({ type: 'answer', id: m.id, error: String(err && err.message || err) }));
        return;
      case 'ok':
        if (!p) return;
        this.pending.delete(m.id);
        p.resolve(m.value);
        return;
      case 'err': {
        if (!p) return;
        this.pending.delete(m.id);
        const e = revive(m.error);
        if (m.error.patch) e.patch = m.error.patch;
        p.reject(e);
        return;
      }
      default:
    }
  }

  async connect(remember) {
    this._remember = remember || null;
    this._start();
    await this._call('connect', { ep: this.ep });
    this.ready = true;
  }

  setRate(bps) { if (this.worker && !this.dead) this.worker.postMessage({ type: 'rate', bps }); }

  async run(unit, hooks) {
    const r = await this._call('run', { unit }, hooks);
    return r;
  }

  abort() {
    if (!this.worker || this.dead) return;
    this.worker.postMessage({ type: 'abort' });
  }

  close() {
    this.dead = true;
    this.ready = false;
    if (this.worker) {
      const w = this.worker;
      try { w.postMessage({ type: 'close' }); } catch (_) {}
      // The worker ends its connection and exits; if it does not within a
      // second, it is stopped.
      setTimeout(() => { try { w.terminate(); } catch (_) {} }, 1000).unref();
    }
    for (const [, p] of this.pending) p.reject(Object.assign(new RemoteError('Stopped.'), { aborted: true }));
    this.pending.clear();
  }
}

// mode: 'worker' (default when available) | 'inline'
function createLane(ep, log, mode) {
  if (mode !== 'inline' && Worker) return new WorkerLane(ep, log);
  return new InProcessLane(ep, log);
}

module.exports = { createLane, WorkerLane, InProcessLane };
