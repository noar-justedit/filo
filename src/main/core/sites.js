/*
 * filo — FTP, FTPS and SFTP client
 * Copyright (C) 2026 Just Edit (Arnaud Augst)
 * Licensed under the GNU General Public License v3.0 or later. See LICENSE.
 */

// Sites: what a saved server looks like, and the import / export formats.
//
//   filo JSON         filo's own export. Never contains a password.
//   FileZilla XML     sitemanager.xml — read (folders, keys, and passwords if
//                     asked) and written (without passwords). Moving from
//                     FileZilla is the first thing anyone switching will do.

const crypto = require('crypto');
const { PROTOCOLS, DEFAULT_PORT } = require('../proto');

const LOGONS = ['normal', 'ask', 'key', 'anonymous'];

function newSiteId() { return crypto.randomBytes(8).toString('hex'); }

// Whatever comes in (the window, an import, an old file) leaves in one shape.
function normalizeSite(s) {
  const o = s || {};
  const protocol = PROTOCOLS.includes(o.protocol) ? o.protocol : 'sftp';
  let logon = LOGONS.includes(o.logon) ? o.logon : 'normal';
  if (logon === 'key' && protocol !== 'sftp') logon = 'normal';
  const port = Number(o.port);
  return {
    id: typeof o.id === 'string' && /^[0-9a-f]{8,32}$/.test(o.id) ? o.id : newSiteId(),
    name: String(o.name || o.host || 'New site').slice(0, 120),
    folder: String(o.folder || '').slice(0, 120),
    protocol,
    host: String(o.host || '').trim().slice(0, 255),
    port: Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_PORT[protocol],
    user: String(o.user || '').slice(0, 255),
    logon,
    keyPath: logon === 'key' ? String(o.keyPath || '') : '',
    // FTP only: 'passive' (default) or 'active'.
    transferMode: o.transferMode === 'active' && protocol !== 'sftp' ? 'active' : 'passive',
    // 0 = no limit of its own (the global setting applies).
    maxConnections: Math.max(0, Math.min(10, parseInt(o.maxConnections, 10) || 0)),
    remoteDir: String(o.remoteDir || ''),
    localDir: String(o.localDir || ''),
    comment: String(o.comment || '').slice(0, 4000),
    // The speed test's result (0.8.0): { at, net, netLabel, out, in, latencyMs, maxOpen }
    // or null. Measured on one network; never exported.
    speed: normalizeSpeed(o.speed),
    // Opaque blobs from secrets.js. Kept only by the profile, never exported.
    passwordEnc: o.passwordEnc || null,
    passphraseEnc: o.passphraseEnc || null,
  };
}


// What a speed test leaves on a site. Numbers are clamped, anything odd is dropped.
function normalizeSpeed(v) {
  if (!v || typeof v !== 'object') return null;
  const dir = d => {
    if (!d || typeof d !== 'object') return null;
    const conn = Math.max(1, Math.min(10, parseInt(d.conn, 10) || 0));
    const mbps = Number(d.mbps);
    if (!parseInt(d.conn, 10) || !(mbps >= 0)) return null;
    return { conn, seg: d.seg === true ? true : d.seg === false ? false : null, mbps: Math.round(mbps * 10) / 10, src: d.src === 'transfer' ? 'transfer' : 'test' };
  };
  const out = dir(v.out), inn = dir(v.in);
  if (!out && !inn) return null;
  return {
    at: Number(v.at) > 0 ? Number(v.at) : Date.now(),
    net: String(v.net || '').slice(0, 40),
    netLabel: String(v.netLabel || '').slice(0, 120),
    out, in: inn,
    latencyMs: Number(v.latencyMs) > 0 ? Math.round(Number(v.latencyMs)) : null,
    maxOpen: Math.max(0, Math.min(10, parseInt(v.maxOpen, 10) || 0)),
  };
}


// A real transfer that went faster than the speed test said: the figures it
// reached replace the old ones for that direction, never lower ones (a slow
// disk or a small file says nothing against the server). Only a profile that
// exists for this direction, on the network it was measured on. Returns the
// new profile, or null for "leave it".
function learnFromTransfer(speed, netNow, dir, conn, mbps, now) {
  if (!speed || !speed.net || speed.net !== netNow) return null;
  const key = dir === 'up' ? 'out' : 'in';
  const cur = speed[key];
  if (!cur || !(mbps > cur.mbps * 1.05) || !(conn >= 1)) return null;
  const next = Object.assign({}, speed, { at: now || Date.now() });
  next[key] = { conn: Math.min(10, Math.round(conn)), seg: cur.seg, mbps: Math.round(mbps * 10) / 10, src: 'transfer' };
  return next;
}

// For the window and for exports: everything but the secrets, plus whether
// a password is remembered.
function publicSite(s) {
  const { passwordEnc, passphraseEnc, ...rest } = s;
  return Object.assign(rest, { hasPassword: !!passwordEnc, hasPassphrase: !!passphraseEnc });
}

// ── filo JSON ─────────────────────────────────────────────────────────────
function exportFilo(sites) {
  return JSON.stringify({
    format: 'filo-sites',
    version: 1,
    exported: new Date().toISOString(),
    sites: sites.map(s => { const p = publicSite(normalizeSite(s)); delete p.hasPassword; delete p.hasPassphrase; delete p.id; delete p.speed; return p; }),
  }, null, 2) + '\n';
}

function importFilo(text) {
  const data = JSON.parse(text);
  if (!data || data.format !== 'filo-sites' || !Array.isArray(data.sites)) throw new Error('This is not a filo site export.');
  return data.sites.map(s => ({ site: normalizeSite(Object.assign({}, s, { id: null, passwordEnc: null, passphraseEnc: null })), password: '' }));
}

// ── A small XML reader ────────────────────────────────────────────────────
// Enough for FileZilla's files: elements, attributes, text, the five standard
// entities and numeric ones. No DTD, no external anything (nothing to resolve,
// so nothing to abuse).
// A broken number (past U+10FFFF) becomes U+FFFD instead of stopping the import.
function codePoint(n) { return Number.isInteger(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '\ufffd'; }
function decodeEntities(s) {
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => codePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => codePoint(parseInt(d, 10)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

function parseXml(text) {
  const root = { name: '#root', attrs: {}, children: [], text: '' };
  const stack = [root];
  const re = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[([\s\S]*?)\]\]>|<!DOCTYPE[^>]*>|<\/\s*([\w:.-]+)\s*>|<([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  let m;
  while ((m = re.exec(text))) {
    const top = stack[stack.length - 1];
    if (m[1] !== undefined) { top.text += m[1]; continue; }
    if (m[2]) {                                   // closing tag
      if (stack.length > 1 && top.name === m[2]) stack.pop();
      continue;
    }
    if (m[3]) {                                   // opening tag
      const el = { name: m[3], attrs: {}, children: [], text: '' };
      const ar = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
      let a;
      while ((a = ar.exec(m[4] || ''))) el.attrs[a[1]] = decodeEntities(a[2] !== undefined ? a[2] : a[3]);
      top.children.push(el);
      if (!m[5]) stack.push(el);
      continue;
    }
    if (m[6] !== undefined) top.text += decodeEntities(m[6]);
  }
  return root;
}

const child = (el, name) => el.children.find(c => c.name === name);
const childText = (el, name) => { const c = child(el, name); return c ? c.text.trim() : ''; };

// FileZilla's RemoteDir: "1 0 4 home 8 filotest" — server type, prefix length,
// then (length, name) pairs. Names may contain spaces, hence the lengths.
function parseFzRemoteDir(s) {
  const str = String(s || '').trim();
  if (!str) return '';
  let i = 0;
  const readNum = () => {
    while (str[i] === ' ') i++;
    let n = '';
    while (i < str.length && /\d/.test(str[i])) n += str[i++];
    return n === '' ? null : Number(n);
  };
  const type = readNum();
  const prefixLen = readNum();
  if (type == null || prefixLen == null) return '';
  if (prefixLen) { i++; i += prefixLen; }
  const parts = [];
  while (i < str.length) {
    const len = readNum();
    if (len == null) break;
    i++;                                         // the space after the length
    parts.push(str.substr(i, len));
    i += len;
  }
  return '/' + parts.join('/');
}

function fzRemoteDir(p) {
  const parts = String(p || '').split('/').filter(Boolean);
  if (!parts.length) return '';
  return '1 0 ' + parts.map(x => `${x.length} ${x}`).join(' ');
}

// FileZilla protocol numbers.
const FZ_PROTOCOL = { 0: 'ftps', 1: 'sftp', 3: 'ftps-implicit', 4: 'ftps', 6: 'ftp' };
const FZ_TO_NUMBER = { ftp: 6, ftps: 4, 'ftps-implicit': 3, sftp: 1 };
// FileZilla logon types: 0 anonymous, 1 normal, 2 ask, 3 interactive, 4 account, 5 key, 6 profile.
const FZ_LOGON = { 0: 'anonymous', 1: 'normal', 2: 'ask', 3: 'ask', 4: 'normal', 5: 'key', 6: 'normal' };

// Returns [{ site, password, passwordEncrypted }]. FileZilla protocol 0 is
// "use FTPS if available, else plain FTP": filo maps it to FTPS, the safe
// reading, and the user can change it if the server has no TLS.
function importFileZilla(text) {
  const doc = parseXml(text);
  const fz = doc.children.find(c => c.name === 'FileZilla3') || doc;
  const out = [];
  // 32 levels of folders is far more than anyone makes, and keeps a crafted
  // file from exhausting the stack.
  const walk = (el, folderPath, depth) => {
    if (depth > 32) return;
    for (const c of el.children) {
      if (c.name === 'Servers') walk(c, folderPath, depth + 1);
      else if (c.name === 'Folder') {
        const name = c.text.trim();
        walk(c, folderPath ? folderPath + ' / ' + name : name, depth + 1);
      } else if (c.name === 'Server') {
        const protoNum = Number(childText(c, 'Protocol') || 0);
        const protocol = FZ_PROTOCOL[protoNum] || 'ftps';
        const logonNum = Number(childText(c, 'Logontype') || 1);
        let password = '', encrypted = false;
        const passEl = child(c, 'Pass');
        if (passEl) {
          const enc = (passEl.attrs.encoding || '').toLowerCase();
          if (enc === 'base64') { try { password = Buffer.from(passEl.text.trim(), 'base64').toString('utf8'); } catch (_) {} }
          else if (enc === 'crypt') encrypted = true;   // FileZilla master password: unreadable without it
          else password = passEl.text;
        }
        const nameText = childText(c, 'Name') || c.text.trim();
        out.push({
          site: normalizeSite({
            name: nameText || childText(c, 'Host'),
            folder: folderPath || '',
            protocol,
            host: childText(c, 'Host'),
            port: Number(childText(c, 'Port')) || DEFAULT_PORT[protocol],
            user: childText(c, 'User'),
            logon: FZ_LOGON[logonNum] || 'normal',
            keyPath: childText(c, 'Keyfile'),
            remoteDir: parseFzRemoteDir(childText(c, 'RemoteDir')),
            transferMode: childText(c, 'PasvMode') === 'MODE_ACTIVE' ? 'active' : 'passive',
            maxConnections: Number(childText(c, 'MaximumMultipleConnections')) || 0,
            localDir: childText(c, 'LocalDir'),
            comment: childText(c, 'Comments'),
          }),
          password,
          passwordEncrypted: encrypted,
        });
      }
    }
  };
  walk(fz, '', 0);
  return out;
}

function xmlEscape(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function exportFileZilla(sites) {
  const lines = ['<?xml version="1.0" encoding="UTF-8"?>', '<FileZilla3 version="filo" platform="*">', '\t<Servers>'];
  const byFolder = new Map();
  for (const s of sites.map(normalizeSite)) {
    const f = s.folder || '';
    if (!byFolder.has(f)) byFolder.set(f, []);
    byFolder.get(f).push(s);
  }
  const server = (s, ind) => {
    const logon = s.logon === 'anonymous' ? 0 : s.logon === 'ask' ? 2 : s.logon === 'key' ? 5 : 2;
    return [
      `${ind}<Server>`,
      `${ind}\t<Host>${xmlEscape(s.host)}</Host>`,
      `${ind}\t<Port>${s.port}</Port>`,
      `${ind}\t<Protocol>${FZ_TO_NUMBER[s.protocol]}</Protocol>`,
      `${ind}\t<Type>0</Type>`,
      `${ind}\t<User>${xmlEscape(s.user)}</User>`,
      // Passwords are never exported: "ask" makes FileZilla prompt for it.
      `${ind}\t<Logontype>${logon}</Logontype>`,
      s.keyPath ? `${ind}\t<Keyfile>${xmlEscape(s.keyPath)}</Keyfile>` : null,
      `${ind}\t<PasvMode>${s.transferMode === 'active' ? 'MODE_ACTIVE' : 'MODE_DEFAULT'}</PasvMode>`,
      s.maxConnections ? `${ind}\t<MaximumMultipleConnections>${s.maxConnections}</MaximumMultipleConnections>` : null,
      `${ind}\t<EncodingType>Auto</EncodingType>`,
      `${ind}\t<BypassProxy>0</BypassProxy>`,
      `${ind}\t<Name>${xmlEscape(s.name)}</Name>`,
      s.comment ? `${ind}\t<Comments>${xmlEscape(s.comment)}</Comments>` : null,
      s.localDir ? `${ind}\t<LocalDir>${xmlEscape(s.localDir)}</LocalDir>` : null,
      s.remoteDir ? `${ind}\t<RemoteDir>${xmlEscape(fzRemoteDir(s.remoteDir))}</RemoteDir>` : null,
      `${ind}\t<SyncBrowsing>0</SyncBrowsing>`,
      `${ind}\t<DirectoryComparison>0</DirectoryComparison>`,
      `${ind}</Server>`,
    ].filter(Boolean);
  };
  for (const [folder, list] of byFolder) {
    if (folder) {
      lines.push(`\t\t<Folder expanded="1">${xmlEscape(folder)}`);
      for (const s of list) lines.push(...server(s, '\t\t\t'));
      lines.push('\t\t</Folder>');
    } else for (const s of list) lines.push(...server(s, '\t\t'));
  }
  lines.push('\t</Servers>', '</FileZilla3>', '');
  return lines.join('\n');
}

// Which format is this file?
function detectFormat(text) {
  const t = String(text || '').trimStart();
  if (t.startsWith('{')) return 'filo';
  if (/<FileZilla3[\s>]/.test(t)) return 'filezilla';
  return null;
}

module.exports = {
  normalizeSpeed, learnFromTransfer,
  normalizeSite, publicSite, newSiteId, LOGONS,
  exportFilo, importFilo, importFileZilla, exportFileZilla, detectFormat,
  parseXml, parseFzRemoteDir, fzRemoteDir,
};
