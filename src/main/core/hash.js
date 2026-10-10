/*
 * filo — FTP, FTPS and SFTP client
 * Copyright (C) 2026 Just Edit (Arnaud Augst)
 * Licensed under the GNU General Public License v3.0 or later. See LICENSE.
 */

// Fingerprints, via hash-wasm (WebAssembly: nothing to compile).
//
// Two families, for two jobs:
//   xxh64            when filo computes BOTH sides itself (read-back). Not
//                    cryptographic, several GB/s: it catches corruption, which
//                    is the question here.
//   sha256 sha1 md5 crc32
//                    whatever the SERVER can compute, since the two sides have
//                    to use the same algorithm to be compared at all.

const fs = require('fs');
const { Transform } = require('stream');

let _hw = null;
function hw() { if (!_hw) _hw = require('hash-wasm'); return _hw; }

const LABELS = { xxh64: 'xxHash64', sha256: 'SHA-256', sha1: 'SHA-1', md5: 'MD5', crc32: 'CRC32' };

const nodeCrypto = require('crypto');

// SHA-256, SHA-1 and MD5 go through Node's own crypto (OpenSSL), which uses the
// processor's dedicated instructions: on Apple silicon SHA-256 runs at well
// over 1 GB/s, against about 300 MB/s for the WebAssembly version. A 50 GB
// file is then verified in under a minute instead of three.
// Same small interface as hash-wasm's hashers: init / update / digest.
class NativeHasher {
  constructor(algo) { this.algo = algo; this.h = null; }
  init() { this.h = nodeCrypto.createHash(this.algo); return this; }
  update(b) { this.h.update(b); return this; }
  digest() { return this.h.digest('hex'); }
}

async function createHasher(algo) {
  switch (algo) {
    case 'sha256': return new NativeHasher('sha256');
    case 'sha1':   return new NativeHasher('sha1');
    case 'md5':    return new NativeHasher('md5');
    case 'crc32':  return hw().createCRC32();
    case 'xxh64':
    default:       return hw().createXXHash64();
  }
}

// Counts (and optionally hashes) what flows through, without holding it back.
// With a limiter (core/throttle.js), it also holds the bytes back to the
// configured speed.
class Tap extends Transform {
  constructor(hasher, onBytes, limiter) {
    super({ highWaterMark: 1024 * 1024 });
    this.hasher = hasher || null;
    this.onBytes = onBytes || null;
    this.limiter = limiter || null;
    this.bytes = 0;
    if (this.hasher) this.hasher.init();
  }
  _transform(chunk, _e, cb) {
    const go = () => {
      this.bytes += chunk.length;
      try { if (this.hasher) this.hasher.update(chunk); } catch (e) { return cb(e); }
      if (this.onBytes) this.onBytes(chunk.length);
      cb(null, chunk);
    };
    const wait = this.limiter ? this.limiter.take(chunk.length) : null;
    if (wait) wait.then(go); else go();
  }
  digest() { return this.hasher ? this.hasher.digest().toLowerCase() : null; }
}

// Hash of a local file, or of a range of it ([start, end), end exclusive).
// token.cancelled stops it.
async function hashFile(file, algo, onBytes, token, start, end) {
  const hasher = await createHasher(algo);
  hasher.init();
  return new Promise((resolve, reject) => {
    const o = { highWaterMark: 4 * 1024 * 1024 };
    if (start != null) o.start = start;
    if (end != null) { if (end <= (start || 0)) return resolve(hasher.digest().toLowerCase()); o.end = end - 1; }
    const rs = fs.createReadStream(file, o);
    rs.on('data', chunk => {
      if (token && token.cancelled) { rs.destroy(Object.assign(new Error('Stopped.'), { aborted: true })); return; }
      hasher.update(chunk);
      if (onBytes) onBytes(chunk.length);
    });
    rs.on('error', reject);
    rs.on('end', () => resolve(hasher.digest().toLowerCase()));
  });
}

module.exports = { createHasher, Tap, hashFile, LABELS };
