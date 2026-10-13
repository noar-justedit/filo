'use strict';
// ── Check a delivery against the other side (Noar, 12/10/2026) ─────────────
// Files already on both sides, nothing transferred again: the server
// computes the checksum of what it holds (SFTP: a hash command; FTP: HASH),
// filo computes the same on the local file. A server that cannot is read
// back (asked first: it costs a download).
const fs = require('fs');
const path = require('path');
const posix = path.posix;
const { hashFile, createHasher, Tap } = require('./hash');
const { Writable } = require('stream');

const SKIP = /^(\.DS_Store|Thumbs\.db|desktop\.ini|\._.*|.*\.filopart|.*\.filoold)$/i;

// Every file under the selected names, on one side: rel → size.
async function walkLocal(root, names, token) {
  const out = new Map();
  const go = async (abs, rel) => {
    if (token && token.cancelled) return;
    let st; try { st = await fs.promises.lstat(abs); } catch (_) { return; }
    if (st.isDirectory()) {
      let list = []; try { list = await fs.promises.readdir(abs); } catch (_) { return; }
      for (const n of list) if (!SKIP.test(n)) await go(path.join(abs, n), rel + '/' + n);
    } else if (st.isFile()) out.set(rel, st.size);
  };
  for (const n of names) await go(path.join(root, n), n);
  return out;
}
async function walkRemote(remote, root, names, token) {
  const out = new Map();
  const top = new Map((await remote.list(root)).map(e => [e.name, e]));
  const go = async (e, abs, rel) => {
    if (token && token.cancelled) return;
    if (e.type === 'folder') {
      for (const c of await remote.list(abs)) if (!SKIP.test(c.name)) await go(c, posix.join(abs, c.name), rel + '/' + c.name);
    } else if (e.type === 'file') out.set(rel, e.size || 0);
  };
  for (const n of names) { const e = top.get(n); if (e) await go(e, posix.join(root, n), n); }
  return out;
}

async function remoteReadHash(remote, p, token) {
  const tap = new Tap(await createHasher('xxh64'));
  const sink = new Writable({ write(c, e, cb) { cb(); } });
  tap.pipe(sink);
  // Listened to before the download: it can end before download() returns.
  const ended = new Promise((res, rej) => { sink.on('finish', res); sink.on('error', rej); tap.on('error', rej); });
  if (token) token.onAbort = () => tap.destroy(Object.assign(new Error('Stopped.'), { aborted: true }));
  await remote.download(p, tap, 0);
  await ended;
  if (token) token.onAbort = null;
  return tap.digest();
}

// plan: what there is to check, and how. run: the check itself.
async function plan(remote, { localRoot, remoteRoot, names, serverHash = true }, token) {
  const [L, R] = await Promise.all([walkLocal(localRoot, names, token), walkRemote(remote, remoteRoot, names, token)]);
  let algos = [];
  if (serverHash) { try { algos = await remote.hashAlgos(); } catch (_) { algos = []; } }
  const both = [...L.keys()].filter(k => R.has(k) && R.get(k) === L.get(k));
  return { L, R, algo: algos[0] || null, both, bytes: both.reduce((a, k) => a + L.get(k), 0) };
}

async function run(remote, p, { localRoot, remoteRoot, readBack, token, onFile }) {
  const res = { same: [], different: [], onlyLocal: [], onlyRemote: [], unchecked: [], algo: p.algo || (readBack ? 'xxh64' : null), readBack: !p.algo && !!readBack };
  for (const [k, size] of p.L) if (!p.R.has(k)) res.onlyLocal.push(k);
  for (const k of p.R.keys()) if (!p.L.has(k)) res.onlyRemote.push(k);
  for (const [k, size] of p.L) if (p.R.has(k) && p.R.get(k) !== size) res.different.push({ rel: k, why: `size: here ${size}, server ${p.R.get(k)}` });
  let i = 0;
  for (const k of p.both) {
    if (token && token.cancelled) break;
    if (onFile) onFile(++i, p.both.length, k);
    const lp = path.join(localRoot, ...k.split('/')), rp = posix.join(remoteRoot, k);
    try {
      let algo = p.algo, r = null;
      if (algo) r = await remote.serverHash(rp, algo, p.L.get(k)).catch(() => null);
      if (!r && readBack) { algo = 'xxh64'; r = await remoteReadHash(remote, rp, token); }
      if (!r) { res.unchecked.push(k); continue; }
      const l = await hashFile(lp, algo, null, token);
      if (l === r) res.same.push(k); else res.different.push({ rel: k, why: `checksum: here ${l}, server ${r}` });
    } catch (e) {
      if (e && e.aborted) break;
      res.unchecked.push(k);
    }
  }
  for (const a of ['onlyLocal', 'onlyRemote', 'unchecked', 'same']) res[a].sort();
  res.different.sort((a, b) => a.rel.localeCompare(b.rel));
  return res;
}

module.exports = { plan, run, walkLocal, walkRemote };
