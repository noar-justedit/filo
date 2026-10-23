/*
 * filo — FTP, FTPS and SFTP client
 * Copyright (C) 2026 Just Edit (Arnaud Augst)
 * Licensed under the GNU General Public License v3.0 or later. See LICENSE.
 */

// Inside a worker thread: one connection, the units the queue sends it.
// See lane.js for the other side.

const { parentPort } = require('worker_threads');
const { createRemote } = require('../proto');
const { setHostKeyPolicy } = require('../proto/sftp');
const { setCertPolicy } = require('../proto/ftp');
const { runUnit, serializeError } = require('./runner');
const { Limiter } = require('./throttle');

let remote = null;
let ep = null;
let token = null;
const limiter = new Limiter();
const asks = new Map();

const log = (level, msg) => parentPort.postMessage({ type: 'log', level, msg });

// The identities this server is known by come with the endpoint (the main
// process owns the profile). A first-time identity is not accepted here: the
// queue reports it and the user decides in the window.
function installPolicy() {
  const policy = {
    known: (kind, host, port) => (ep && ep.known && ep.known[kind] && String(host).toLowerCase() === String(ep.host).toLowerCase() && Number(port) === Number(ep.port) ? ep.known[kind] : null),
    remember: (kind, host, port, fp) => parentPort.postMessage({ type: 'remember', kind, host, port, fp }),
  };
  setHostKeyPolicy(policy);
  setCertPolicy(policy);
}

parentPort.on('message', async m => {
  if (m.type === 'connect') {
    ep = m.ep;
    // A Buffer sent to a thread arrives as a plain Uint8Array, which ssh2 does
    // not take as a key: the login was then tried without it, and refused.
    if (ep && ep.privateKey && !Buffer.isBuffer(ep.privateKey) && typeof ep.privateKey !== 'string') ep.privateKey = Buffer.from(ep.privateKey);
    installPolicy();
    try {
      remote = createRemote(ep, { log });
      await remote.connect();
      parentPort.postMessage({ type: 'ok', id: m.id });
    } catch (e) { parentPort.postMessage({ type: 'err', id: m.id, error: serializeError(e) }); }
    return;
  }
  if (m.type === 'rate') { limiter.setRate(m.bps); return; }
  if (m.type === 'abort') {
    if (token) { token.cancelled = true; try { if (token.onAbort) token.onAbort(); } catch (_) {} }
    for (const [, a] of asks) a.reject(Object.assign(new Error('Stopped.'), { aborted: true }));
    asks.clear();
    if (remote) { try { remote.abort(); } catch (_) {} }
    return;
  }
  if (m.type === 'answer') {
    const a = asks.get(m.id);
    if (!a) return;
    asks.delete(m.id);
    if (m.error) a.reject(Object.assign(new Error(m.error), { aborted: /stopped/i.test(m.error) })); else a.resolve(m.rule);
    return;
  }
  if (m.type === 'close') {
    try { if (remote) await remote.close(); } catch (_) {}
    process.exit(0);
  }
  if (m.type === 'run') {
    const id = m.id;
    token = { cancelled: false, onAbort: null };
    // Byte counts are batched: a message per 32 KB block would cost more than
    // the block.
    let batch = new Map();
    const flush = () => {
      if (!batch.size) return;
      parentPort.postMessage({ type: 'bytes', id, batch: [...batch.entries()] });
      batch = new Map();
    };
    const timer = setInterval(flush, 100);
    const ctx = {
      settings: m.unit.settings,
      token,
      limiter,
      log,
      onBytes: (n, phase) => {
        // Markers (resume, verify-start) keep their order: flush around them.
        if (phase === 'resume' || phase === 'verify-start' || phase === 'segkeep') { flush(); parentPort.postMessage({ type: 'bytes', id, batch: [[phase, n]] }); return; }
        // A position, not a count: the latest one is what matters.
        if (phase === 'segprog') { batch.set(phase, n); return; }
        batch.set(phase, (batch.get(phase) || 0) + n);
      },
      onMeta: meta => { flush(); parentPort.postMessage({ type: 'meta', id, meta }); },
      ask: (_item, src, dst) => new Promise((resolve, reject) => {
        flush();
        asks.set(id, { resolve, reject });
        parentPort.postMessage({ type: 'ask', id, src, dst });
      }),
    };
    try {
      const r = await runUnit(remote, m.unit, ctx);
      flush();
      parentPort.postMessage({ type: 'ok', id, value: r });
    } catch (e) {
      flush();
      parentPort.postMessage({ type: 'err', id, error: serializeError(e) });
    } finally {
      clearInterval(timer);
      token = null;
    }
  }
});
