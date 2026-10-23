/*
 * filo — FTP, FTPS and SFTP client
 * Copyright (C) 2026 Just Edit (Arnaud Augst)
 * Licensed under the GNU General Public License v3.0 or later. See LICENSE.
 */

// One unit of work on one connection. Used the same way in the main process
// (tests) and inside a worker thread (the app): see lane.js.
//
// A unit is { kind, item, idx }:
//   item   a whole file or folder (which may answer "segmented")
//   seg    one segment of a segmented file
//   final  the last step of a segmented file
//
// The item handed in is a COPY: whatever the transfer changed on it (the
// resume record, a renamed target, the segment list) goes back as `patch`,
// on success and on failure alike — a failure after the resume record was
// written must still leave it to the next attempt.

const { runFile, runFolder, runSegment, finalizeSegments } = require('./transfer');
const { RemoteError } = require('./errors');

const PATCH_KEYS = ['size', 'local', 'remote', 'resume', 'restartFromZero', 'offset', 'seg', 'ownTarget'];

function patchOf(kind, item) {
  const p = {};
  for (const k of PATCH_KEYS) if (item[k] !== undefined) p[k] = item[k];
  // A segment never sends the segment list back: several of them run at once
  // and the queue alone keeps the list.
  // Nor what the item decides as a whole (0.9.5: a segment refused by the
  // server came back with restartFromZero = false after the queue had set it,
  // and the file then "resumed" a partial full of holes).
  if (kind === 'seg') { delete p.seg; delete p.restartFromZero; delete p.resume; delete p.offset; }
  return p;
}

async function runUnit(remote, unit, ctx) {
  const item = unit.item;
  const c = Object.assign({}, ctx, { remote });
  try {
    let res;
    if (unit.kind === 'seg') res = await runSegment(item, unit.idx, c);
    else if (unit.kind === 'final') res = await finalizeSegments(item, c);
    else res = item.type === 'folder' ? await runFolder(item, c) : await runFile(item, c);
    return { res, patch: patchOf(unit.kind, item) };
  } catch (err) {
    err.patch = patchOf(unit.kind, item);
    throw err;
  }
}

// Errors cross a thread boundary as plain objects.
const ERR_KEYS = ['message', 'code', 'local', 'raw', 'network', 'fatal', 'aborted', 'mismatch', 'resumed', 'segment', 'sizeMismatch', 'noSpace', 'trust', 'serverLimit', 'what', 'endpointId'];
function serializeError(err) {
  // Through RemoteError first: plain-words message and retry flags are decided
  // here, in the thread, where the original error (code, syscall) still exists.
  const e = Object.assign(RemoteError.from(err), err && err.patch ? { patch: err.patch } : {});
  const o = {};
  for (const k of ERR_KEYS) if (e && e[k] !== undefined) o[k] = e[k];
  if (!o.message) o.message = String(e && e.message || e);
  if (e && e.patch) o.patch = e.patch;
  return o;
}

module.exports = { runUnit, serializeError, PATCH_KEYS };
