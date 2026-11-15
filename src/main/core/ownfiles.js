/*
 * filo — FTP, FTPS and SFTP client
 * Copyright (C) 2026 Just Edit (Arnaud Augst)
 * Licensed under the GNU General Public License v3.0 or later. See LICENSE.
 */

// The names of filo's own work files, in one place. Never transferred, never
// compared, never shown as a difference, never a reason to synchronize.
//   PART          a file being written, renamed to its real name at the end
//   OLD           the previous version, parked while the new one takes its place
//   RELAY_SUFFIX  ".<name>.filoparts": the segments one filo hands to another
//   TRASH         per LIVE SYNC session folder: what a copy replaced or deleted
const PART = '.filopart';
const OLD = '.filoold';
const RELAY_SUFFIX = '.filoparts';
const TRASH = '.filo-trash';

// The same, as filter patterns (LIVE SYNC's file filter syntax).
const OWN_PATTERNS = ['*' + PART, '*' + OLD, '.*' + RELAY_SUFFIX];
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const OWN_RE = new RegExp(`(${esc(PART)}|${esc(OLD)})$|^\\..+${esc(RELAY_SUFFIX)}$`, 'i');
const isOwnName = name => OWN_RE.test(String(name));

module.exports = { PART, OLD, RELAY_SUFFIX, TRASH, OWN_PATTERNS, isOwnName };
