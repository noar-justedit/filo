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

// The same walk with several listings at once (0.9.9: one folder after the
// other cost a round trip or more each, minutes on a deep tree).
//  - SFTP answers many requests at once on one connection: `slots` listings
//    run together on `remote` (it says so with canListParallel).
//  - FTP and FTPS list one folder per connection: `openExtra()` opens more
//    (`extra` of them, in the background; a server that refuses them just
//    leaves the walk with the ones it has).
// Order: a folder's entries go out together, sorted, the folder before what is
// inside it; the subfolders are taken last in, first out (a subtree is
// finished before the next one starts, as before).
async function walkRemoteParallel(remote, dir, onEntry, token, o) {
  const opt = o || {};
  const stack = [{ dir, rel: '' }];
  let active = 0, failure = null, finished = false, wake = [];
  const notify = () => { const w = wake; wake = []; for (const f of w) f(); };
  const cancelled = () => !!(token && token.cancelled);
  const extras = [];
  const all = new Set();
  const worker = async (rem, isMain) => {
    const par = !!rem.canListParallel;
    while (!failure && !cancelled()) {
      const item = stack.pop();
      if (!item) {
        if (active === 0) break;
        await new Promise(r => wake.push(r));
        continue;
      }
      active++;
      let fell = false;
      try {
        const entries = (par ? await rem.list(item.dir, { parallel: true }) : await rem.list(item.dir)).slice();
        entries.sort((a, b) => a.name.localeCompare(b.name));
        const subs = [];
        for (const e of entries) {
          if (cancelled()) break;
          const r = item.rel ? item.rel + '/' + e.name : e.name;
          const full = posix.join(item.dir, e.name);
          if (e.type === 'folder') { onEntry({ rel: r, type: 'folder', path: full }); subs.push({ dir: full, rel: r }); }
          else if (e.type === 'file' || (e.type === 'symlink' && e.linkTo !== 'folder')) onEntry({ rel: r, type: 'file', path: full, size: e.size, mtime: e.mtime });
        }
        for (let i = subs.length - 1; i >= 0; i--) stack.push(subs[i]);
      } catch (e) {
        if (!isMain && !failure) { stack.push(item); fell = true; try { rem.close(); } catch (_) {} }   // an extra connection that fell: the others carry on
        else failure = failure || e;
      } finally { active--; notify(); }
      if (fell) return;
    }
    notify();
  };
  const spawn = (rem, isMain) => { const p = worker(rem, isMain).catch(e => { failure = failure || e; }).then(() => { all.delete(p); }); all.add(p); };
  const slots = remote.canListParallel ? Math.max(1, opt.slots || 8) : 1;
  for (let i = 0; i < slots; i++) spawn(remote, true);
  if (!remote.canListParallel && opt.openExtra) {
    for (let i = 0; i < (opt.extra || 0); i++) {
      opt.openExtra().then(r => {
        if (finished || failure || cancelled()) { try { r.close(); } catch (_) {} return; }
        extras.push(r); spawn(r, false);
      }, () => {});
    }
  }
  try { while (all.size) await Promise.race([...all]); }
  finally { finished = true; for (const r of extras) { try { r.close(); } catch (_) {} } }
  if (failure) throw failure;
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

module.exports = { walkRemote, walkRemoteParallel, deleteRemoteTree, safeLocalName, localJoin };
