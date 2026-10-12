/*
 * filo — FTP, FTPS and SFTP client
 * Copyright (C) 2026 Just Edit (Arnaud Augst)
 * Licensed under the GNU General Public License v3.0 or later. See LICENSE.
 */

// Taken from syncto (same author, same licence): the exclude patterns of a
// synchronisation pair work exactly as in syncto and FreeFileSync.
//
// Item filtering, in two independent stages.
//
// HARD FILTER (include / exclude by name) — decides whether an item is even
// looked at. Applied identically on both sides during traversal, so it really
// carves out a smaller folder tree. Syntax follows FreeFileSync so existing
// habits transfer:
//
//   *            zero or more characters, never crosses a folder separator
//   ?            exactly one character, never a folder separator
//   |            separates several patterns (newlines work too)
//   /sub/        trailing separator  -> folders only
//   /sub/*       likewise            -> folders only
//   /file.txt:   trailing colon      -> files only
//   /*:          all files, no folders
//   /*/thumbs.db one folder level deep, any name
//
// Paths are relative to the folder-pair root, case-insensitive, and both / and
// \ are accepted. Matching a folder implicitly matches everything inside it.
//

const SEP = '/';

function normRel(p) {
  return String(p || '')
    .replace(/\\/g, SEP)
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .normalize('NFC')
    .toLowerCase();
}

function maskToRegExp(mask) {
  let out = '';
  for (const ch of mask) {
    if (ch === '*')      out += '[^/]*';
    else if (ch === '?') out += '[^/]';
    else                 out += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + out + '$');
}

// One user pattern -> { re, target: 'file' | 'folder' | 'both', nameOnly }
//
// Anchoring rule, the one thing worth memorizing:
//   no "/" at all      ->  matches the item NAME, at ANY depth   (*.tmp, CACHE)
//   contains a "/"     ->  matches the relative path from the pair's root
//                          ("/" prefix optional: "/a/b" and "a/b" are the same)
function parseItem(item) {
  let s = String(item || '').trim().replace(/\\/g, SEP);
  if (!s) return null;

  let target = 'both';

  if (s.endsWith(':')) {                       // "…:"  -> files only
    target = 'file';
    s = s.slice(0, -1);
  } else if (s.endsWith(SEP)) {                // "…/"  -> folders only
    target = 'folder';
    s = s.slice(0, -1);
  } else if (s.endsWith(SEP + '*')) {          // "…/*" -> folders only
    target = 'folder';
    s = s.slice(0, -2);
  }

  const anchored = s.startsWith(SEP);          // a leading "/" pins it to the root
  s = s.replace(/^\/+/, '').replace(/\/+$/, '');
  if (!s) return null;

  const norm = s.normalize('NFC').toLowerCase();
  const nameOnly = !anchored && !norm.includes(SEP);
  const out = [{ re: maskToRegExp(norm), target, nameOnly }];

  // "*/name" must also match "name" sitting at the root.
  if (norm.startsWith('*/')) {
    const tail = norm.slice(2);
    if (tail) out.push({ re: maskToRegExp(tail), target, nameOnly: false });
  }
  return out;
}

function parseList(str) {
  const items = String(str || '').split(/[,;|\n\r]+/);
  const masks = [];
  for (const it of items) {
    const parsed = parseItem(it);
    if (parsed) masks.push(...parsed);
  }
  return masks;
}

// Every strict ancestor of a relative path, longest first.
function ancestors(rel) {
  const parts = rel.split(SEP);
  const out = [];
  for (let i = parts.length - 1; i >= 1; i--) out.push(parts.slice(0, i).join(SEP));
  return out;
}

class PathFilter {
  constructor(includeStr, excludeStr) {
    this.includeStr = includeStr == null ? '*' : String(includeStr);
    this.excludeStr = excludeStr == null ? ''  : String(excludeStr);
    this.include = parseList(this.includeStr);
    this.exclude = parseList(this.excludeStr);
    if (!this.include.length) this.include = parseList('*');
    this._memo = new Map();
  }

  get trivial() {
    return this.includeStr.trim() === '*' && this.excludeStr.trim() === '';
  }

  _hit(masks, rel, kind) {
    const name = rel.includes(SEP) ? rel.slice(rel.lastIndexOf(SEP) + 1) : rel;
    for (const m of masks) {
      if (m.target !== 'both' && m.target !== kind) continue;
      if (m.re.test(m.nameOnly ? name : rel)) return true;
    }
    return false;
  }

  // A folder mask matching an ancestor covers the whole subtree.
  _ancestorHit(masks, rel) {
    for (const anc of ancestors(rel)) {
      const ancName = anc.includes(SEP) ? anc.slice(anc.lastIndexOf(SEP) + 1) : anc;
      for (const m of masks) {
        if (m.target === 'file') continue;
        if (m.re.test(m.nameOnly ? ancName : anc)) return true;
      }
    }
    return false;
  }

  passFile(relPath) {
    if (this.trivial) return true;
    const rel = normRel(relPath);
    if (!rel) return true;
    const included = this._hit(this.include, rel, 'file') || this._ancestorHit(this.include, rel);
    if (!included) return false;
    return !(this._hit(this.exclude, rel, 'file') || this._ancestorHit(this.exclude, rel));
  }

  passFolder(relPath) {
    if (this.trivial) return true;
    const rel = normRel(relPath);
    if (!rel) return true;
    const key = 'd:' + rel;
    if (this._memo.has(key)) return this._memo.get(key);

    // A folder is kept when it matches an include mask, when an ancestor does,
    // or when it could still contain a match deeper down (e.g. include
    // "/a/b/c.txt" must not prune "/a"). The last case is what makes nested
    // include patterns behave the way people expect.
    const included =
      this._hit(this.include, rel, 'folder') ||
      this._ancestorHit(this.include, rel) ||
      this._couldContain(rel);

    const excluded = this._hit(this.exclude, rel, 'folder') || this._ancestorHit(this.exclude, rel);
    const res = included && !excluded;
    this._memo.set(key, res);
    return res;
  }

  // True when a descendant of this folder might still be included:
  //  - a name-only include mask ("*.jpg", "CACHE") matches at ANY depth, so no
  //    folder may ever be pruned because of it — the match could be anywhere
  //    below. Without this rule, include "*.jpg" would silently sync nothing
  //    outside the root folder.
  //  - an anchored include mask with more path segments than this folder whose
  //    leading segments match (include "/a/b/c.txt" must not prune "/a").
  _couldContain(rel) {
    const depth = rel.split(SEP).length;
    for (const m of this.include) {
      if (m.nameOnly) return true;
      const src = m.re.source.slice(1, -1);          // strip ^ and $
      const segs = src.split('\\/');
      if (segs.length <= depth) continue;
      const head = new RegExp('^' + segs.slice(0, depth).join('\\/') + '$');
      if (head.test(rel)) return true;
    }
    return false;
  }
}

module.exports = { PathFilter, normRel };
