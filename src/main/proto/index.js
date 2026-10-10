/*
 * filo — FTP, FTPS and SFTP client
 * Copyright (C) 2026 Just Edit (Arnaud Augst)
 * Licensed under the GNU General Public License v3.0 or later. See LICENSE.
 */

// One door to every protocol. Every backend offers the same calls:
//   connect() close() abort() alive
//   home() list(dir) stat(path) mkdir(path) unlink(path) rmdir(path) rename(a, b)
//   setMTime(path, ms) canSetMTime
//   download(path, writable, start) upload(readable, path, start)
//   hashAlgos() serverHash(path, algo, size)
// Paths on the server are always POSIX ("/a/b"), whatever the local system.

const { SftpRemote } = require('./sftp');
const { FtpRemote } = require('./ftp');

const PROTOCOLS = ['sftp', 'ftps', 'ftps-implicit', 'ftp'];
const DEFAULT_PORT = { sftp: 22, ftps: 21, 'ftps-implicit': 990, ftp: 21 };
const LABEL = { sftp: 'SFTP', ftps: 'FTPS', 'ftps-implicit': 'FTPS implicit', ftp: 'FTP' };

// endpoint: { protocol, host, port, user, password, privateKey, passphrase, acceptFingerprint }
function createRemote(endpoint, opts) {
  const o = Object.assign({}, endpoint, opts || {});
  if (o.protocol === 'sftp') return new SftpRemote(o);
  if (PROTOCOLS.includes(o.protocol)) return new FtpRemote(o);
  throw new Error(`Unknown protocol: ${o.protocol}`);
}

// "sftp://user@host:2222/path" → parts. Accepted in the quick-connect host
// field, because that is how people paste addresses.
function parseUrl(s) {
  const str = String(s || '').trim();
  const m = /^(sftp|ftps|ftpes|ftp):\/\/(?:([^@/]*)@)?(\[[^\]]+\]|[^:/]+)(?::(\d+))?(\/.*)?$/i.exec(str);
  if (!m) return null;
  let protocol = m[1].toLowerCase();
  if (protocol === 'ftpes') protocol = 'ftps';
  // ftps:// conventionally means implicit TLS on 990 (FileZilla reads it so).
  if (protocol === 'ftps') protocol = m[1].toLowerCase() === 'ftpes' ? 'ftps' : 'ftps-implicit';
  let user = '', password = '';
  if (m[2]) {
    const i = m[2].indexOf(':');
    user = decodeURIComponent(i >= 0 ? m[2].slice(0, i) : m[2]);
    password = i >= 0 ? decodeURIComponent(m[2].slice(i + 1)) : '';
  }
  return {
    protocol,
    host: m[3].replace(/^\[|\]$/g, ''),
    port: m[4] ? Number(m[4]) : DEFAULT_PORT[protocol],
    user, password,
    path: m[5] ? decodeURIComponent(m[5]) : '',
  };
}

// Never with a password: this is what the log and the window show.
function describe(ep) {
  if (!ep) return '';
  const port = Number(ep.port) || DEFAULT_PORT[ep.protocol];
  const scheme = ep.protocol === 'ftps-implicit' ? 'ftps' : ep.protocol === 'ftps' ? 'ftpes' : ep.protocol;
  const host = String(ep.host || '').includes(':') ? `[${ep.host}]` : ep.host;
  return `${scheme}://${ep.user ? encodeURIComponent(ep.user) + '@' : ''}${host}${port !== DEFAULT_PORT[ep.protocol] ? ':' + port : ''}`;
}

module.exports = { createRemote, parseUrl, describe, PROTOCOLS, DEFAULT_PORT, LABEL };
