/*
 * filo — FTP, FTPS and SFTP client
 * Copyright (C) 2026 Just Edit (Arnaud Augst)
 * Licensed under the GNU General Public License v3.0 or later. See LICENSE.
 */

// LIVE SYNC: what to copy, decided from the two listings and from what the
// last runs left (the "state"). Pure logic: no disk, no network, no timer,
// which is what makes every rule testable.
//
// Sides: 'l' (the local folder) and 'r' (the server folder).
// Directions: 'up' (local → server), 'down' (server → local), 'both' (2 WAYS).
//
// Rules, decided with Noar (10/10/2026):
//  - nothing is ever deleted;
//  - a deletion made on one side is respected: the file is NOT sent again
//    from the other side (it is reported);
//  - a file changed on both sides since the last run is a conflict: nothing
//    is overwritten, it is reported;
//  - a file is only sent once it is stable: same size and date on two looks
//    at least `stableMs` apart (an export or a card copy in progress does not
//    leave half-written). The date alone is not enough: the Finder and most
//    copy tools give the copy the ORIGINAL date while it is still growing.
//
// The state, per relative path: { l: {s, m}, r: {s, m}, pend } — the size
// and date each side had after the last run, as ITS OWN listing gives them
// (an FTP listing may round dates to the minute: compared with itself, that
// does not matter). `pend` names the side a copy was sent to and whose new
// values are not known yet: the next listing of that side provides them.

const SLACK_MS = 2000;

function sameDate(a, b) {
  if (Math.abs(a - b) <= SLACK_MS) return true;
  // A listing that only gives minutes (FTP LIST): within the same minute.
  if ((a % 60000 === 0 || b % 60000 === 0) && Math.abs(a - b) < 60000) return true;
  return false;
}
function changed(base, cur) {
  return !base || cur.size !== base.s || !sameDate(cur.mtime || 0, base.m || 0);
}
const snap = e => ({ s: e.size || 0, m: e.mtime || 0 });
const other = side => (side === 'l' ? 'r' : 'l');

// L, R: Map rel → { type: 'file' | 'folder', size, mtime }
// state: { files: { rel: entry } }, mutated copy returned
// seen: Map, kept by the caller between runs (stability)
// prefer: 'l' | 'r' | null. DIRECT + S-FTP FAILSAFE (Noar, 11/10/2026): the
// MASTER's side wins a conflict instead of leaving it ('l' on the MASTER,
// 'r', the server, on the SLAVE). The copy is marked reason 'master': the
// caller first renames the losing file (never lost), then copies.
function plan({ direction, L, R, state, seen, now, stableMs, prefer }) {
  const files = Object.assign({}, (state && state.files) || {});
  const out = { copies: [], folders: [], conflicts: [], respected: [], waiting: 0, files };
  const can = { l: direction === 'up' || direction === 'both', r: direction === 'down' || direction === 'both' };
  const stable = (side, rel, e) => {
    const k = side + ':' + rel;
    const s = seen.get(k);
    if (!s || s.size !== e.size || s.mtime !== e.mtime) { seen.set(k, { size: e.size, mtime: e.mtime, at: now }); return false; }
    return now - s.at >= stableMs;
  };
  const copy = (from, rel, e, reason) => {
    if (!stable(from, rel, e)) { out.waiting++; return; }
    out.copies.push({ from, rel, size: e.size || 0, mtime: e.mtime || 0, reason });
    const b = Object.assign({}, files[rel] || {});
    b[from] = snap(e);
    b.pend = other(from);
    files[rel] = b;
  };

  // firstLook: no state for this file yet. The SLAVE's server copy may lag
  // behind what Syncthing already brought: the server only wins a conflict
  // seen since the last run, never on a first look.
  const conflict = (rel, why, l, r, firstLook) => {
    const e = prefer === 'l' ? l : prefer === 'r' && !firstLook ? r : null;
    if (e && can[prefer]) { copy(prefer, rel, e, 'master'); return; }
    out.conflicts.push({ rel, why });
  };

  // Folders: created on the other side when they are missing there (empty
  // folders arrive too). A folder deleted on one side after a run is left
  // alone, like a file.
  const folders = new Set();
  for (const [rel, e] of L) if (e.type === 'folder') folders.add(rel);
  for (const [rel, e] of R) if (e.type === 'folder') folders.add(rel);
  for (const rel of [...folders].sort()) {
    const l = L.get(rel), r = R.get(rel), b = files['/' + rel];
    if (l && r) {
      if (l.type !== r.type) { out.conflicts.push({ rel, why: 'a folder on one side, a file on the other' }); continue; }
      files['/' + rel] = { dir: true };
      continue;
    }
    const from = l ? 'l' : 'r';
    if (!can[from]) continue;
    if (b && b.dir && !b.pend) { out.respected.push({ rel, deletedOn: other(from) }); continue; }
    if (from === 'l' ? R.has(rel) : L.has(rel)) continue;
    out.folders.push({ to: other(from), rel });
    files['/' + rel] = { dir: true, pend: other(from) };
  }

  const rels = new Set();
  for (const [rel, e] of L) if (e.type === 'file') rels.add(rel);
  for (const [rel, e] of R) if (e.type === 'file') rels.add(rel);
  for (const rel of Object.keys(files)) if (!rel.startsWith('/')) rels.add(rel);

  for (const rel of [...rels].sort()) {
    const l = L.get(rel), r = R.get(rel);
    let b = files[rel];
    if (l && l.type !== 'file' || r && r.type !== 'file') { out.conflicts.push({ rel, why: 'a folder on one side, a file on the other' }); continue; }
    if (!l && !r) { delete files[rel]; continue; }

    // A copy sent last time: its destination now tells its own values.
    if (b && b.pend) {
      const dst = b.pend === 'l' ? l : r;
      const src = b.pend === 'l' ? b.r : b.l;
      if (dst && src && dst.size === src.s) { b = Object.assign({}, b, { [b.pend]: snap(dst) }); delete b.pend; files[rel] = b; }
    }

    if (l && r) {
      if (b && !b.pend) {
        const lc = changed(b.l, l), rc = changed(b.r, r);
        if (!lc && !rc) continue;
        // DUAL SYNC: both changed, but to the same file (SYNCTHING brought it
        // here, the MASTER's backup put it there): nothing to do (review 0.6.2).
        if (lc && rc && prefer && l.size === r.size) { files[rel] = { l: snap(l), r: snap(r) }; continue; }
        if (lc && rc) { conflict(rel, 'changed on both sides since the last run', l, r); continue; }
        const from = lc ? 'l' : 'r';
        if (can[from]) copy(from, rel, from === 'l' ? l : r, 'changed');
        continue;
      }
      if (b && b.pend) {
        // The last copy did not land (yet): send it again if the source is
        // still what was sent.
        const from = other(b.pend), src = from === 'l' ? l : r;
        if (!changed(b[from], src) && can[from]) { copy(from, rel, src, 'again'); continue; }
      }
      // First look at this pair of files (or a copy that went wrong).
      if (l.size === r.size) { files[rel] = { l: snap(l), r: snap(r) }; continue; }
      const lNewer = (l.mtime || 0) > (r.mtime || 0) + SLACK_MS, rNewer = (r.mtime || 0) > (l.mtime || 0) + SLACK_MS;
      if (direction === 'up') {
        if (lNewer) copy('l', rel, l, 'newer');
        else conflict(rel, 'different on the server, and not older', l, r, true);
      } else if (direction === 'down') {
        if (rNewer) copy('r', rel, r, 'newer');
        else conflict(rel, 'different here, and not older', l, r, true);
      } else if (lNewer) copy('l', rel, l, 'newer');
      else if (rNewer) copy('r', rel, r, 'newer');
      else conflict(rel, 'different sizes, same date', l, r, true);
      continue;
    }

    // Only on one side.
    const from = l ? 'l' : 'r', e = l || r;
    if (!can[from]) continue;
    const dstWas = b && b[other(from)] && !(b.pend === other(from));
    if (dstWas && !changed(b[from], e)) {
      // It was on both sides after a run, and the other side deleted it.
      out.respected.push({ rel, deletedOn: other(from) });
      continue;
    }
    copy(from, rel, e, b ? 'again' : 'new');
  }

  // Seen-but-gone entries do not pile up.
  const live = new Set([...L.keys()].map(k => 'l:' + k).concat([...R.keys()].map(k => 'r:' + k)));
  for (const k of seen.keys()) if (!live.has(k)) seen.delete(k);
  return out;
}

// DUAL SYNC (Noar, 12/10/2026): once SYNCTHING has finished, the MASTER
// keeps the server folder (S-FTP BACKUP) in step with its own: a sync between
// three places (Noar: "une synchro 3 ways en quelque sorte").
//  - here, not there (or changed here): sent to the server;
//  - deleted here (filo had seen it on both sides): deleted on the server
//    (each computer keeps its own trash, .filo-trash);
//  - put on the server by hand (never seen here), or changed only there:
//    brought here (`pull`, when the MASTER receives), and SYNCTHING takes it
//    to the other computer;
//  - changed on both sides: the MASTER's version wins, the server's is kept
//    beside it (`keep`), as in plan();
//  - deleted on the server only: sent again (the server is the backup).
// Same state format as plan(), so the S-FTP relay that works while the other
// computer is away carries on from it.
// Guards: a local folder that reads empty while the server holds files known
// to this session deletes and brings nothing of them (a disk not mounted);
// nothing under a folder not read whole here (`partial`) is touched.
//
// Returns { uploads: [{rel, size, mtime, keep}], downloads: [{rel, size,
// mtime, isNew}], folders (to make on the server), localFolders (to make
// here), deletes: [{rel, type}], waiting, emptyGuard, files }.
function mirrorPlan({ L, R, state, seen, now, stableMs, pull }) {
  const before = (state && state.files) || {};
  const files = Object.assign({}, before);
  const out = { uploads: [], downloads: [], folders: [], localFolders: [], deletes: [], waiting: 0, emptyGuard: false, files };
  const stable = (side, rel, e) => {
    const k = side + ':' + rel;
    const s = seen.get(k);
    if (!s || s.size !== e.size || s.mtime !== e.mtime) { seen.set(k, { size: e.size, mtime: e.mtime, at: now }); return false; }
    return now - s.at >= stableMs;
  };
  const localFiles = [...L.values()].some(e => e.type === 'file');
  const knownOnServer = [...R].some(([rel, e]) => e.type === 'file' && before[rel] && before[rel].l);
  const guard = !localFiles && knownOnServer;
  if (guard) out.emptyGuard = true;
  const partial = [...L].filter(([, e]) => e.partial).map(([rel]) => rel);
  const under = (rel, list) => list.some(g => rel === g || rel.startsWith(g + '/'));
  const up = (rel, l, keep) => {
    if (!stable('l', rel, l)) { out.waiting++; return; }
    out.uploads.push(Object.assign({ rel, size: l.size || 0, mtime: l.mtime || 0 }, keep ? { keep: true } : {}));
    files[rel] = { l: snap(l), r: files[rel] && files[rel].r, pend: 'r' };
  };
  const down = (rel, r, isNew) => {
    if (guard) return;
    if (!stable('r', rel, r)) { out.waiting++; return; }
    out.downloads.push({ rel, size: r.size || 0, mtime: r.mtime || 0, isNew });
    files[rel] = { r: snap(r), l: files[rel] && files[rel].l, pend: 'l' };
  };

  // Folders. A folder gone here goes whole from the server: what it holds is
  // not looked at again.
  const gone = [];
  const dirs = new Set();
  for (const [rel, e] of L) if (e.type === 'folder') dirs.add(rel);
  for (const [rel, e] of R) if (e.type === 'folder') dirs.add(rel);
  for (const rel of [...dirs].sort()) {
    if (under(rel, gone) || under(rel, partial)) continue;
    const l = L.get(rel), r = R.get(rel), b = before['/' + rel];
    if (l && r) { if (l.type === r.type) files['/' + rel] = { dir: true }; continue; }
    if (l) { if (l.type === 'folder') { out.folders.push(rel); files['/' + rel] = { dir: true, pend: 'r' }; } continue; }
    if (r.type !== 'folder') continue;
    if (b && b.dir && !b.pend) {                     // it was here: deleted here
      if (guard) continue;
      out.deletes.push({ rel, type: 'folder' }); gone.push(rel);
      delete files['/' + rel];
      continue;
    }
    if (pull && !guard) { out.localFolders.push(rel); files['/' + rel] = { dir: true, pend: 'l' }; }
  }

  const rels = new Set();
  for (const [rel, e] of L) if (e.type === 'file') rels.add(rel);
  for (const [rel, e] of R) if (e.type === 'file') rels.add(rel);
  for (const rel of [...rels].sort()) {
    if (under(rel, gone)) { delete files[rel]; continue; }
    if (under(rel, partial)) continue;
    let l = L.get(rel), r = R.get(rel);
    if (l && l.type !== 'file') l = null;
    if (r && r.type !== 'file') r = null;
    let b = files[rel];
    // A copy sent last time: its destination now tells its own values.
    if (b && b.pend === 'r' && r && b.l && r.size === b.l.s) { b = { l: b.l, r: snap(r) }; files[rel] = b; }
    if (b && b.pend === 'l' && l && b.r && l.size === b.r.s) { b = { l: snap(l), r: b.r }; files[rel] = b; }
    if (l && r) {
      if (!b || b.pend || !b.l || !b.r) {
        // First look (or a copy that went wrong): same size, the same file;
        // otherwise the MASTER's version, the server's kept beside it.
        if (l.size === r.size) files[rel] = { l: snap(l), r: snap(r) };
        else up(rel, l, true);
        continue;
      }
      const lc = changed(b.l, l), rc = changed(b.r, r);
      if (!lc && !rc) continue;
      if (lc && !rc) { up(rel, l); continue; }
      if (!lc && rc) { if (pull) down(rel, r, false); else up(rel, l); continue; }
      if (l.size === r.size) { files[rel] = { l: snap(l), r: snap(r) }; continue; }
      up(rel, l, true);
      continue;
    }
    if (l) { up(rel, l); continue; }                  // new here, or deleted on the server: sent (again)
    // Only on the server.
    if (b && b.l && !(b.pend === 'l')) {
      // It was here: deleted here. Changed on the server since: brought back.
      if (guard) continue;
      if (b.r && !changed(b.r, r)) { out.deletes.push({ rel, type: 'file' }); delete files[rel]; }
      else if (pull) down(rel, r, true);
      continue;
    }
    if (pull) down(rel, r, true);                     // put on the server by hand
  }
  for (const rel of Object.keys(files)) {
    const k = rel.startsWith('/') ? rel.slice(1) : rel;
    if (!L.has(k) && !R.has(k)) delete files[rel];
  }
  return out;
}

module.exports = { plan, mirrorPlan, sameDate, changed };
