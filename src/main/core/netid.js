/*
 * filo — FTP, FTPS and SFTP client
 * Copyright (C) 2026 Just Edit (Arnaud Augst)
 * Licensed under the GNU General Public License v3.0 or later. See LICENSE.
 */

// Which network is this computer on? A speed profile is true for one network
// (the studio's, the hotel's Wi-Fi) and means nothing on another, so each
// profile remembers the network it was measured on, and applies only there.
//
// The identity is built from what can be read without sending anything to the
// outside: the subnet the computer uses to reach the Internet, the address of
// its gateway and, when the system tells it, the gateway's hardware address (the
// one thing that tells two home routers on 192.168.1.0/24 apart). Whatever
// cannot be read is left out: a weaker identity, never an error.

const os = require('os');
const dgram = require('dgram');
const crypto = require('crypto');
const { execFile } = require('child_process');

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
const MAC = /\b([0-9a-f]{1,2}([:-][0-9a-f]{1,2}){5})\b/i;

function run(cmd, args, timeout) {
  return new Promise(resolve => {
    try { execFile(cmd, args, { timeout: timeout || 1500, windowsHide: true }, (err, out) => resolve(err ? '' : String(out))); }
    catch (_) { resolve(''); }
  });
}

// The local address the system would use to reach the Internet. A UDP socket
// "connected" to an address sends nothing: it only asks the routing table.
function localAddress(probe) {
  return new Promise(resolve => {
    let s;
    try { s = dgram.createSocket('udp4'); } catch (_) { return resolve(null); }
    const done = v => { try { s.close(); } catch (_) {} resolve(v); };
    s.on('error', () => done(null));
    try { s.connect(53, probe || '192.0.2.1', () => { try { done(s.address().address); } catch (_) { done(null); } }); }
    catch (_) { done(null); }
  });
}

function subnetOf(addr) {
  const ifs = os.networkInterfaces();
  for (const list of Object.values(ifs)) for (const i of list || []) {
    if (i.family !== 'IPv4' || i.address !== addr || !IPV4.test(i.netmask || '')) continue;
    const a = addr.split('.').map(Number), m = i.netmask.split('.').map(Number);
    const bits = m.map(x => x.toString(2).replace(/0/g, '').length).reduce((p, c) => p + c, 0);
    return `${a.map((x, k) => x & m[k]).join('.')}/${bits}`;
  }
  return null;
}

async function gatewayOf() {
  let out = '';
  if (process.platform === 'darwin') {
    out = await run('/sbin/route', ['-n', 'get', 'default']);
    const m = /gateway:\s*(\d+\.\d+\.\d+\.\d+)/.exec(out); return m ? m[1] : null;
  }
  if (process.platform === 'win32') {
    out = await run('route', ['print', '-4', '0.0.0.0']);
    const m = /^\s*0\.0\.0\.0\s+0\.0\.0\.0\s+(\d+\.\d+\.\d+\.\d+)/m.exec(out); return m ? m[1] : null;
  }
  out = await run('ip', ['route', 'show', 'default']);
  let m = /default via (\d+\.\d+\.\d+\.\d+)/.exec(out);
  if (m) return m[1];
  try {
    const t = require('fs').readFileSync('/proc/net/route', 'utf8').split('\n').slice(1);
    for (const l of t) { const c = l.split(/\s+/); if (c[1] === '00000000' && c[2]) { const h = c[2].match(/../g).reverse().map(x => parseInt(x, 16)); return h.join('.'); } }
  } catch (_) {}
  return null;
}

async function macOf(gw) {
  if (!gw || !IPV4.test(gw)) return null;
  let out = '';
  if (process.platform === 'win32') out = await run('arp', ['-a', gw]);
  else if (process.platform === 'darwin') out = await run('/usr/sbin/arp', ['-n', gw]);
  else { out = await run('ip', ['neigh', 'show', gw]); if (!MAC.test(out)) out = await run('arp', ['-n', gw]); }
  const m = MAC.exec(out);
  return m ? m[1].toLowerCase().replace(/-/g, ':') : null;
}

let cache = { id: '', label: '', at: 0 };
let pending = null;

// Reads the network again (about a second at most). Never throws.
function refresh() {
  if (pending) return pending;
  pending = (async () => {
    try {
      const addr = await localAddress();
      const net = addr ? subnetOf(addr) : null;
      const gw = addr ? await gatewayOf() : null;
      const mac = gw ? await macOf(gw) : null;
      const raw = [net || '', gw || '', mac || ''].join('|');
      cache = raw === '||' ? { id: '', label: '', at: Date.now() }
        : { id: crypto.createHash('sha1').update(raw).digest('hex').slice(0, 12), label: net ? `${net}${gw ? ' via ' + gw : ''}` : gw || '', at: Date.now() };
    } catch (_) {}
    pending = null;
    return cache;
  })();
  return pending;
}

// The network as last read ('' when it could not be read).
function current() { return cache.id; }
function label() { return cache.label; }

module.exports = { refresh, current, label, subnetOf, gatewayOf };
