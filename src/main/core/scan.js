/*
 * filo — FTP, FTPS and SFTP client
 * Copyright (C) 2026 Just Edit (Arnaud Augst)
 * Licensed under the GNU General Public License v3.0 or later. See LICENSE.
 */

// Walking a folder on the server: to queue it for download, or to delete it.
// Links to folders are NOT followed on the server: a link to "/" inside a
// home folder would otherwise queue the whole machine.

const posix = require('path').posix;
const path = require('path');

async function walkRemote(remote, dir, onEntry, token, rel) {
  if (token && token.cancelled) return;
  const entries = await remote.list(dir);
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const e of entries) {
    if (token && token.cancelled) return;
    const r = rel ? rel + '/' + e.name : e.name;
    const full = posix.join(dir, e.name);
    if (e.type === 'folder') { onEntry({ rel: r, type: 'folder', path: full }); await walkRemote(remote, full, onEntry, token, r); }
    else if (e.type === 'file' || (e.type === 'symlink' && e.linkTo !== 'folder')) onEntry({ rel: r, type: 'file', path: full, size: e.size, mtime: e.mtime });
  }
}

// Deepest first. Returns the number of items removed.
async function deleteRemoteTree(remote, dir, token, onItem) {
  let n = 0;
  const entries = await remote.list(dir);
  for (const e of entries) {
    if (token && token.cancelled) return n;
    const full = posix.join(dir, e.name);
    if (e.type === 'folder') n += await deleteRemoteTree(remote, full, token, onItem);
    else { await remote.unlink(full); n++; if (onItem) onItem(full); }
  }
  await remote.rmdir(dir);
  if (onItem) onItem(dir);
  return n + 1;
}

// A name from a server, made safe for THIS disk. Windows refuses \ / : * ? " < > |
// and names ending in a dot or a space; a server happily stores them.
const WIN_RESERVED = /^(con|prn|aux|nul|conin\$|conout\$|com[\d¹²³]|lpt[\d¹²³])(\..*)?$/i;
function safeLocalName(name, platform) {
  let n = String(name).replace(/\//g, '_');
  if ((platform || process.platform) === 'win32') {
    n = n.replace(/[\\:*?"<>|\x00-\x1f]/g, '_').replace(/[. ]+$/, m => '_'.repeat(m.length));
    if (WIN_RESERVED.test(n)) n = '_' + n;
  }
  return n || '_';
}

function localJoin(base, rel, platform) {
  return path.join(base, ...String(rel).split('/').map(p => safeLocalName(p, platform)));
}

module.exports = { walkRemote, deleteRemoteTree, safeLocalName, localJoin };
