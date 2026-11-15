/*
 * filo — FTP, FTPS and SFTP client
 * Copyright (C) 2026 Just Edit (Arnaud Augst)
 * Licensed under the GNU General Public License v3.0 or later. See LICENSE.
 */

// Every field of a queue item, written down once, with where it goes:
//   saved   kept in the queue's file (survives a restart)
//   lane    handed to the worker that moves the file
//   meta    what a running attempt may decide early (saved before its end)
//   patch   what an attempt hands back when it ends
// A field missing here is lost on the way: add it here, nowhere else.
const FIELDS = {
  id: ['saved', 'lane'],
  dir: ['saved', 'lane'],
  type: ['saved', 'lane'],
  local: ['saved', 'lane', 'meta', 'patch'],
  remote: ['saved', 'lane', 'meta', 'patch'],
  size: ['saved', 'lane', 'patch'],
  endpointId: ['saved'],
  endpointLabel: ['saved'],
  existing: ['saved', 'lane'],
  status: ['saved'],
  attempts: ['saved'],
  error: ['saved'],
  note: ['saved'],
  verify: ['saved'],
  mismatchCount: ['saved'],
  addedAt: ['saved'],
  finishedAt: ['saved'],
  done: ['saved'],
  resume: ['saved', 'lane', 'meta', 'patch'],
  restartFromZero: ['saved', 'lane', 'meta', 'patch'],
  offset: ['saved', 'lane', 'patch'],
  seg: ['saved', 'lane', 'patch'],
  ownTarget: ['saved', 'lane', 'meta', 'patch'],
  sync: ['saved'],                 // the lane gets only syncForLane() of it
  relayOut: ['saved', 'lane'],
  relay: ['saved', 'lane'],
};
const fieldsFor = tag => Object.keys(FIELDS).filter(k => FIELDS[k].includes(tag));

// LIVE SYNC: which session and which relative path an item serves.
//   trash   the session's local .filo-trash, where a replaced file goes
//   mirror  a copy of the S-FTP BACKUP (DUAL SYNC: waits while SYNCTHING works)
//   held    paused by filo for SYNCTHING, not by the user
function cleanSync(s, isAbsolute) {
  if (!s || typeof s !== 'object') return undefined;
  const o = { pairId: String(s.pairId), rel: String(s.rel) };
  if (typeof s.trash === 'string' && isAbsolute(s.trash)) o.trash = s.trash;
  if (s.mirror) o.mirror = true;
  if (s.held) o.held = true;
  return o;
}
// What the worker needs of it: only where a replaced local file goes.
const syncForLane = s => (s && s.trash ? { rel: s.rel, trash: s.trash } : undefined);

module.exports = { FIELDS, fieldsFor, cleanSync, syncForLane };
