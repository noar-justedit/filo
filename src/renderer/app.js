/*
 * filo — FTP, FTPS and SFTP client
 * Copyright (C) 2026 Just Edit (Arnaud Augst)
 * Licensed under the GNU General Public License v3.0 or later. See LICENSE.
 */

// The window. No framework: a global `state`, two Panel objects, the queue
// view, and the small windows. Every list is virtualised (only the visible
// rows exist in the page), so a folder of 50 000 files scrolls like one of 50.

'use strict';
const API = window.filo;
const $ = id => document.getElementById(id);

const state = {
  settings: {}, ntfy: {}, sites: [], quickHistory: [], afterAction: 'none', ui: {},
  conn: null, proto: 'sftp', vault: true, existingLabels: {},
  qtab: 'queue', qcounts: {}, qstate: 'stopped', progress: null, qsel: new Set(),
  logs: [], blocked: null, asks: [], askOpen: false, platform: API.platform,
};

// ── Formatting ─────────────────────────────────────────────────────────────
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function fmtSize(b) {
  const n = Number(b) || 0;
  if (n < 1000) return n + ' B';
  const u = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1000, i = 0;
  while (v >= 1000 && i < u.length - 1) { v /= 1000; i++; }
  return (v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2)) + ' ' + u[i];
}
function fmtSpeed(b) { return b > 0 ? fmtSize(b) + '/s' : '—'; }
function fmtDate(ms) {
  if (!ms) return '';
  const d = new Date(ms), p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
// 04:35, or 1:04:35 past an hour (the ring's EST. TIME, Noar 12/10/2026).
function fmtEta(sec) {
  const s = Math.max(0, Math.round(sec));
  if (!isFinite(s) || s <= 0) return '–';
  const two = n => String(n).padStart(2, '0');
  return s >= 3600 ? `${Math.floor(s / 3600)}:${two(Math.floor((s % 3600) / 60))}:${two(s % 60)}` : `${two(Math.floor(s / 60))}:${two(s % 60)}`;
}
function fmtDur(sec) {
  const s = Math.max(0, Math.round(sec));
  if (!isFinite(s) || s <= 0) return '—';
  if (s >= 3600) return `${Math.floor(s / 3600)} h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}`;
  if (s >= 60) return `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')}`;
  return `${s} s`;
}
// A time of day for the queue: 11:35:36, with the date in front when it is
// not today (31/12 23:59:10).
function fmtClock(ms) {
  if (!ms) return '';
  const d = new Date(ms), now = new Date();
  const p = n => String(n).padStart(2, '0');
  const t = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  return d.toDateString() === now.toDateString() ? t : `${p(d.getDate())}/${p(d.getMonth() + 1)} ${t}`;
}
function plural(n, w) { return `${n} ${w}${n === 1 ? '' : 's'}`; }
const posixJoin = (a, b) => (a.endsWith('/') ? a : a + '/') + b;
const posixBase = p => String(p).split('/').filter(Boolean).pop() || '/';
const posixDir = p => { const s = String(p).replace(/\/+$/, ''); const i = s.lastIndexOf('/'); return i <= 0 ? '/' : s.slice(0, i); };
const localBase = p => String(p).split(/[\\/]/).filter(Boolean).pop() || p;
const localDir = p => { const s = String(p).replace(/[\\/]+$/, ''); const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\')); return i < 0 ? s : s.slice(0, i) || '/'; };
const isMac = () => state.platform === 'darwin';
const isWin = () => state.platform === 'win32';
// The words each system uses (Linux: the Trash, and "the file manager", which
// is Files, Dolphin, Nemo… depending on the desktop).
const TRASH = () => (state.platform === 'win32' ? 'Recycle Bin' : 'Trash');
const FILE_MANAGER = () => (state.platform === 'darwin' ? 'Finder' : state.platform === 'win32' ? 'Explorer' : 'file manager');
// The end of a path is what tells folders apart: cut from the left.
function tail(p, n) { const s = String(p); return s.length > n ? '…' + s.slice(s.length - n + 1) : s; }
const modKey = e => (isMac() ? e.metaKey : e.ctrlKey);

// ── Icons (Lucide, ISC licence — the same set as syncto) ──────────────────
const SVG = (d, w) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${w || 2}" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const I = {
  folder: SVG('<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>'),
  file: SVG('<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/>'),
  video: SVG('<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="m10 11 5 3-5 3v-6Z"/>'),
  image: SVG('<rect width="18" height="18" x="3" y="3" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.09-3.09a2 2 0 0 0-2.82 0L6 21"/>'),
  audio: SVG('<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>'),
  link: SVG('<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>'),
  up: SVG('<path d="m5 12 7-7 7 7"/><path d="M12 19V5"/>'),
  upload: SVG('<path d="M12 3v12"/><path d="m17 8-5-5-5 5"/><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>'),
  download: SVG('<path d="M12 15V3"/><path d="m7 10 5 5 5-5"/><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>'),
  drive: SVG('<line x1="22" x2="2" y1="12" y2="12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/><line x1="6" x2="6.01" y1="16" y2="16"/>'),
  unplug: SVG('<path d="m19 5 3-3"/><path d="m2 22 3-3"/><path d="M6.3 20.3a2.4 2.4 0 0 0 3.4 0L12 18l-6-6-2.3 2.3a2.4 2.4 0 0 0 0 3.4Z"/><path d="M7.5 13.5 10 11"/><path d="M10.5 16.5 13 14"/><path d="m12 6 6 6 2.3-2.3a2.4 2.4 0 0 0 0-3.4l-2.6-2.6a2.4 2.4 0 0 0-3.4 0Z"/>'),
  globe: SVG('<circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>'),
  // The same plug and socket as "unplug", pushed together: connected.
  plugged: SVG('<g transform="translate(1.75 -1.75)"><path d="m2 22 3-3"/><path d="M6.3 20.3a2.4 2.4 0 0 0 3.4 0L12 18l-6-6-2.3 2.3a2.4 2.4 0 0 0 0 3.4Z"/><path d="M7.5 13.5 10 11"/><path d="M10.5 16.5 13 14"/><g transform="translate(-3.5 3.5)"><path d="m19 5 3-3"/><path d="m12 6 6 6 2.3-2.3a2.4 2.4 0 0 0 0-3.4l-2.6-2.6a2.4 2.4 0 0 0-3.4 0Z"/></g></g>'),
  plug: SVG('<path d="M12 22v-5"/><path d="M9 8V2"/><path d="M15 8V2"/><path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z"/>'),
  server: SVG('<rect width="20" height="8" x="2" y="2" rx="2"/><rect width="20" height="8" x="2" y="14" rx="2"/><path d="M6 6h.01"/><path d="M6 18h.01"/>'),
  shield: SVG('<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/>'),
  key: SVG('<path d="m15.5 7.5 2.3 2.3a1 1 0 0 0 1.4 0l2.1-2.1a1 1 0 0 0 0-1.4L19 4"/><path d="m21 2-9.6 9.6"/><circle cx="7.5" cy="15.5" r="5.5"/>'),
  check: SVG('<path d="M20 6 9 17l-5-5"/>', 2.6),
  x: SVG('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'),
  alert: SVG('<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>'),
  stop: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="5.5" y="5.5" width="13" height="13" rx="2"/></svg>',
  retry: SVG('<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>', 2.4),
  chev: SVG('<path d="m9 18 6-6-6-6"/>', 2.4),
  play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5Z"/></svg>',
  pause: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4.5" width="4" height="15" rx="1"/><rect x="14" y="4.5" width="4" height="15" rx="1"/></svg>',
  trash: SVG('<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>'),
  edit: SVG('<path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z"/>'),
  copy: SVG('<rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>'),
  eye: SVG('<path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/>'),
  eyeOff: SVG('<path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49"/><path d="M14.084 14.158a3 3 0 0 1-4.242-4.242"/><path d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143"/><path d="m2 2 20 20"/>'),
  plus: SVG('<path d="M5 12h14"/><path d="M12 5v14"/>'),
  clock: SVG('<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>'),
  refresh: SVG('<path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/>'),
  list: SVG('<path d="M3 12h.01"/><path d="M3 18h.01"/><path d="M3 6h.01"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M8 6h13"/>'),
  power: SVG('<path d="M12 2v10"/><path d="M18.4 6.6a9 9 0 1 1-12.77.04"/>'),
  quit: SVG('<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>'),
  exportFile: SVG('<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M12 18v-6"/><path d="m9 15 3 3 3-3"/>'),
  importIn: SVG('<path d="M12 3v12"/><path d="m8 11 4 4 4-4"/><path d="M8 5H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-4"/>'),
  share: SVG('<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8.59 13.51 6.83 3.98"/><path d="m15.41 6.51-6.82 3.98"/>'),
  swap: SVG('<path d="M8 3 4 7l4 4"/><path d="M4 7h16"/><path d="m16 21 4-4-4-4"/><path d="M20 17H4"/>'),
  moon: SVG('<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>'),
};
const VIDEO_EXT = /\.(mov|mp4|mxf|r3d|braw|ari|avi|mkv|m4v|mts|m2ts|crm|dng|prores|webm)$/i;
const IMAGE_EXT = /\.(jpe?g|png|tiff?|psd|exr|dpx|heic|gif|webp|svg|cr3|cr2|arw|nef)$/i;
const AUDIO_EXT = /\.(wav|aiff?|mp3|m4a|flac|aac|ogg|bwf)$/i;
function iconFor(e) {
  if (e.type === 'folder' || (e.type === 'symlink' && e.linkTo === 'folder')) return I.folder;
  if (e.type === 'symlink' && e.linkTo !== 'file') return I.link;
  if (VIDEO_EXT.test(e.name)) return I.video;
  if (IMAGE_EXT.test(e.name)) return I.image;
  if (AUDIO_EXT.test(e.name)) return I.audio;
  return I.file;
}
// Hidden unless "show hidden files" is on: names starting with a dot (the
// Unix and macOS convention, .DS_Store included), macOS resource forks (._x),
// and the files Windows and macOS put on disks for themselves. A file Windows
// marks hidden only by its attribute is not seen here (Node does not read
// that attribute). A .filopart stays visible: it is filo's own work.
const OS_HIDDEN = new Set(['thumbs.db', 'ehthumbs.db', 'desktop.ini', '$recycle.bin', 'system volume information', 'recycler',
  'pagefile.sys', 'hiberfil.sys', 'swapfile.sys', 'dumpstack.log.tmp', 'icon\r', '$windows.~bt', '$windows.~ws', 'msocache']);
function isHiddenName(n) {
  if (n.endsWith('.filopart')) return false;
  return n.startsWith('.') || OS_HIDDEN.has(n.toLowerCase());
}
const isDirEntry = e => e.type === 'folder' || (e.type === 'symlink' && e.linkTo === 'folder');

// ── Toast, tooltips ────────────────────────────────────────────────────────
let toastTimer = null;
// A long delete on the server: how far it is (main sends each file deleted).
const delProgress = { n: 0, at: 0 };
function toast(msg, err) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.toggle('err', !!err);
  t.classList.add('open');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('open'), err ? 7000 : 3500);
}

function bindTooltips() {
  let tip = null, timer = null, owner = null;
  const hide = () => { clearTimeout(timer); timer = null; if (tip) { tip.remove(); tip = null; } owner = null; };
  document.addEventListener('mouseover', e => {
    const el = e.target.closest('[data-tip]');
    if (el === owner) return;
    hide();
    if (!el || !el.dataset.tip) return;
    owner = el;
    timer = setTimeout(() => {
      if (!document.body.contains(el)) return;
      tip = document.createElement('div');
      tip.className = 'tooltip';
      tip.textContent = el.dataset.tip;
      document.body.appendChild(tip);
      const r = el.getBoundingClientRect(), tr = tip.getBoundingClientRect();
      let x = r.left + r.width / 2 - tr.width / 2, y = r.bottom + 8;
      if (y + tr.height > innerHeight - 6) y = r.top - tr.height - 8;
      x = Math.max(6, Math.min(innerWidth - tr.width - 6, x));
      tip.style.left = x + 'px'; tip.style.top = y + 'px';
    }, 450);
  });
  document.addEventListener('mousedown', hide, true);
  document.addEventListener('wheel', hide, { passive: true, capture: true });
}

// ── Context menu ───────────────────────────────────────────────────────────
// items: [{ label, icon, key, action, danger, disabled, on }] | 'sep' | { head }
function showMenu(x, y, items) {
  const m = $('ctx');
  m.innerHTML = '';
  for (const it of items) {
    if (!it) continue;
    if (it === 'sep') { const d = document.createElement('div'); d.className = 'ctx-sep'; m.appendChild(d); continue; }
    if (it.head) { const d = document.createElement('div'); d.className = 'ctx-head'; d.textContent = it.head; m.appendChild(d); continue; }
    const d = document.createElement('div');
    d.className = 'ctx-it' + (it.danger ? ' danger' : '') + (it.disabled ? ' dis' : '') + (it.on ? ' on' : '');
    d.innerHTML = (it.icon || '') + `<span class="l">${esc(it.label)}</span>` + (it.key ? `<span class="key">${esc(it.key)}</span>` : '') + (it.radio ? '<span class="tick"></span>' : '');
    d.addEventListener('click', () => { if (it.disabled) return; closeMenu(); it.action && it.action(); });
    m.appendChild(d);
  }
  m.classList.add('open');
  const r = m.getBoundingClientRect();
  m.style.left = Math.min(x, innerWidth - r.width - 8) + 'px';
  m.style.top = Math.min(y, innerHeight - r.height - 8) + 'px';
}
function closeMenu() { $('ctx').classList.remove('open'); }
document.addEventListener('mousedown', e => { if (!e.target.closest('#ctx')) closeMenu(); });
window.addEventListener('blur', closeMenu);

// ── Dialogs ────────────────────────────────────────────────────────────────
// One generic window, filled for each use. Resolves with the button's value.
// One at a time: a window that arrives while another is open waits its turn
// (it used to close the open one, which silently answered it: a password
// prompt arriving could skip an "already there" file).
// `title` and `sub` are HTML: callers escape any value that is not theirs.
let dialogResolve = null, dialogTag = null;
const dialogWait = [];
// ── Update notice: the same as Noar's other apps (syncto, ingesto, archivo) ─
// A small window: NEW VERSION AVAILABLE, LATER or GET IT (the releases page).
// Either answer, Escape or a click outside remembers the version: the same
// one never asks twice; the next one asks again.
async function showUpdateNotice({ version, url }) {
  if (!version || version === state.ui.updateDismissedVersion) return;
  const go = await dialog({
    title: `<span style="display:inline-flex;align-items:center;gap:9px"><span style="display:inline-flex;width:20px;height:20px;color:var(--green)">${I.download}</span>New version available</span>`,
    sub: `filo v${esc(version)} is available. You're on v${esc($('ver').textContent.replace(/^v/, ''))}.`,
    buttons: [{ spacer: true }, { label: 'LATER', value: false }, { label: 'GET IT', value: true, cls: 'go' }],
    width: 420, tag: 'update',
  });
  state.ui.updateDismissedVersion = version;
  API.saveUi({ updateDismissedVersion: version });
  if (go) API.openExternal(url);
}
function dialog(o) {
  return new Promise(resolve => {
    if (dialogResolve) dialogWait.push({ o, resolve });
    else openDialog(o, resolve);
  });
}
function openDialog({ title, sub, html, buttons, width, onOpen, focus, tag }, resolve) {
  {
    dialogResolve = resolve;
    dialogTag = tag || null;
    const card = $('dlg-card');
    card.style.width = (width || 480) + 'px';
    card.innerHTML = `<div class="m-h1">${title || ''}</div>${sub ? `<div class="m-sub">${sub}</div>` : ''}<div class="body">${html || ''}</div>
      <div class="m-btns">${(buttons || [{ label: 'OK', value: true, cls: 'go' }]).map((b, i) => (b.spacer ? '<span class="sp"></span>' : `<button class="btn sm ${b.cls || ''}" data-i="${i}">${esc(b.label)}</button>`)).join('')}</div>`;
    const btns = buttons || [{ label: 'OK', value: true, cls: 'go' }];
    card.querySelectorAll('.m-btns button').forEach(b => b.addEventListener('click', () => {
      const def = btns[+b.dataset.i];
      const v = typeof def.value === 'function' ? def.value(card) : def.value;
      if (v === undefined) return;            // validation said no
      closeDialog(v);
    }));
    $('ov-dialog').classList.add('open');
    if (onOpen) onOpen(card);
    const f = focus ? card.querySelector(focus) : card.querySelector('input,select,textarea');
    if (f) setTimeout(() => { f.focus(); if (f.select) f.select(); }, 30);
    card.onkeydown = e => {
      if (e.key === 'Enter' && e.target.tagName === 'INPUT') {
        const primary = card.querySelector('.m-btns .btn.go, .m-btns .btn.stop');
        if (primary) { e.preventDefault(); primary.click(); }
      }
    };
  }
}
function closeDialog(v) {
  $('ov-dialog').classList.remove('open');
  const r = dialogResolve; dialogResolve = null; dialogTag = null;
  if (r) r(v);
  const next = dialogWait.shift();
  if (next) setTimeout(() => openDialog(next.o, next.resolve), 0);
}
function isDialogOpen() { return $('ov-dialog').classList.contains('open'); }

function confirmBox(title, sub, okLabel, danger) {
  return dialog({ title: esc(title), sub, buttons: [{ label: 'CANCEL', value: false }, { label: okLabel || 'OK', value: true, cls: danger ? 'stop' : 'go' }] });
}

function promptBox(title, value, okLabel, sub) {
  return dialog({
    title: esc(title), sub,
    html: `<div class="field"><input id="dlg-in" value="${esc(value || '')}" spellcheck="false"></div>`,
    buttons: [{ label: 'CANCEL', value: null }, { label: okLabel || 'OK', cls: 'go', value: c => { const v = c.querySelector('#dlg-in').value.trim(); return v || undefined; } }],
  });
}

function errorBox(title, msg) {
  return dialog({ title: esc(title), html: `<div class="err-list">${esc(msg).replace(/\n/g, '<br>')}</div>`,
    buttons: [{ label: 'COPY', value: () => { API.copyText(msg); toast('Copied'); return undefined; } }, { spacer: true }, { label: 'OK', value: true, cls: 'go' }] });
}

// The server is not known yet: show what identifies it, let the user decide.
function trustBox(t) {
  const isCert = t.kind === 'ftps';
  const rows = [['Server', `${t.host}:${t.port}`]];
  if (isCert) {
    if (t.subject) rows.push(['Issued to', t.subject]);
    if (t.issuer) rows.push(['Issued by', t.issuer]);
    if (t.validTo) rows.push(['Valid until', t.validTo]);
    if (t.reason) rows.push(['Why', t.reason.replace(/_/g, ' ').toLowerCase()]);
  }
  return dialog({
    title: `${I.shield.replace('<svg', '<svg width="20" height="20"')} ${isCert ? 'Unverified certificate' : 'New server'}`,
    sub: isCert
      ? 'This server\'s certificate is not signed by an authority this computer trusts. That is normal for a NAS or an in-house server — and also what an impostor would show. If you can, compare the fingerprint below with the one shown in the server\'s settings.'
      : 'filo has never connected to this server. Its fingerprint is below; on a first connection to a machine you know, trusting it is what everyone does. If it ever changes, filo will refuse to connect.',
    html: `<div class="kv">${rows.map(r => `<div>${esc(r[0])}</div><div>${esc(r[1])}</div>`).join('')}</div><div class="field"><label>Fingerprint (SHA-256)</label><div class="fp">${esc(t.fingerprint)}</div></div>`,
    buttons: [{ label: 'CANCEL', value: false }, { label: 'TRUST AND CONNECT', value: true, cls: 'go' }],
    width: 560,
  });
}

function passwordBox(label, opts) {
  const o = opts || {};
  return dialog({
    title: esc(o.title || 'Password'),
    sub: `For <b>${esc(label)}</b>`,
    html: `<div class="field"><input type="password" id="dlg-pw" autocomplete="off"></div>` +
      (o.canSave ? `<label class="chk"><input type="checkbox" id="dlg-save"${state.vault ? '' : ' disabled'}> Remember it ${state.vault ? '(in the system keychain)' : '— no keychain available on this machine'}</label>` : ''),
    buttons: [{ label: 'CANCEL', value: null }, { label: 'CONNECT', cls: 'go', value: c => {
      const v = c.querySelector('#dlg-pw').value;
      if (!v) return undefined;
      return { password: v, save: !!(c.querySelector('#dlg-save') && c.querySelector('#dlg-save').checked) };
    } }],
  });
}

// ── Splitters ──────────────────────────────────────────────────────────────
function bindSplitters() {
  const sv = $('split-panels'), sh = $('split-queue');
  const local = $('p-local'), queue = $('queue');
  const ui = state.ui || {};
  if (ui.panelRatio) local.style.flex = `0 0 ${ui.panelRatio * 100}%`;
  if (ui.queueHeight) queue.style.height = ui.queueHeight + 'px';
  // Synchronized browsing sits on this splitter: its button is a button, not a handle.
  for (const t of ['mousedown', 'dblclick']) $('q-sync').addEventListener(t, e => e.stopPropagation());
  sv.addEventListener('mousedown', e => {
    e.preventDefault(); sv.classList.add('drag');
    const box = $('panels').getBoundingClientRect();
    const move = ev => {
      const r = Math.max(0.2, Math.min(0.8, (ev.clientX - box.left) / box.width));
      local.style.flex = `0 0 ${r * 100}%`; state.ui.panelRatio = r;
      panels.local.render(); panels.remote.render();
    };
    const up = () => { sv.classList.remove('drag'); removeEventListener('mousemove', move); removeEventListener('mouseup', up); API.saveUi({ panelRatio: state.ui.panelRatio }); };
    addEventListener('mousemove', move); addEventListener('mouseup', up);
  });
  sv.addEventListener('dblclick', () => { local.style.flex = ''; state.ui.panelRatio = 0; API.saveUi({ panelRatio: 0 }); });
  sh.addEventListener('mousedown', e => {
    e.preventDefault(); sh.classList.add('drag');
    const startY = e.clientY, startH = queue.getBoundingClientRect().height;
    const move = ev => {
      const h = Math.max(150, Math.min(innerHeight - 330, startH - (ev.clientY - startY)));
      queue.style.height = h + 'px'; state.ui.queueHeight = h;
      panels.local.render(); panels.remote.render(); renderQueue();
    };
    const up = () => { sh.classList.remove('drag'); removeEventListener('mousemove', move); removeEventListener('mouseup', up); API.saveUi({ queueHeight: state.ui.queueHeight }); };
    addEventListener('mousemove', move); addEventListener('mouseup', up);
  });
}

// ══ Panels ═════════════════════════════════════════════════════════════════
let dragSrc = null;     // { side, dir, items } while a drag started inside filo is in flight

class Panel {
  constructor(side) {
    this.side = side;
    this.el = $(side === 'local' ? 'p-local' : 'p-remote');
    this.path = this.el.querySelector('.p-path');
    this.filterIn = this.el.querySelector('.p-filter');
    this.scroll = this.el.querySelector('.p-scroll');
    this.spacer = this.el.querySelector('.p-spacer');
    this.empty = this.el.querySelector('.p-empty');
    this.info = this.el.querySelector('.p-foot .info');
    this.xferBtn = this.el.querySelector('[data-act="transfer"]');
    this.busy = this.el.querySelector('.p-busy');
    this.dir = '';
    this.parent = null;
    this.sep = '/';
    this.entries = [];
    this.view = [];
    this.sel = new Set();
    this.cursor = -1;
    this.anchor = -1;
    this.sort = (state.ui.sort && state.ui.sort[side]) || { key: 'name', asc: true };
    this.filter = '';
    this.cache = new Map();          // dir → entries (server only): going back is instant
    this.loading = 0;
    this.error = '';
    this.rowEls = [];
    this.bind();
  }

  get remote() { return this.side === 'remote'; }
  get enabled() { return !this.remote || !!state.conn; }

  join(name) {
    if (this.remote) return posixJoin(this.dir, name);
    if (this.dir === '::drives') return name + '\\';          // "D:" → "D:\"
    return this.dir.endsWith(this.sep) ? this.dir + name : this.dir + this.sep + name;
  }

  async load(dir, opts) {
    const o = opts || {};
    if (this.remote && !state.conn) return;
    const token = ++this.loading;
    const keepSel = o.keepSel && dir === this.dir ? new Set(this.sel) : null;
    // Server: show what we had for that folder at once, then refresh it.
    if (this.remote && this.cache.has(dir) && !o.keepSel) {
      this._apply(dir, this.cache.get(dir), null);
    }
    if (this.busy) this.busy.style.display = '';
    this.inFlight = (this.inFlight || 0) + 1;
    let res;
    try { res = this.remote ? await API.remoteList(dir) : await API.localList(dir); }
    finally { this.inFlight--; }
    if (token !== this.loading) return;
    if (this.busy) this.busy.style.display = 'none';
    if (!res.ok) {
      if (res.needsPassword || res.code === 'NOT_CONNECTED') { setDisconnected(); return; }
      if (o.fallback && o.fallback !== dir) return this.load(o.fallback);
      if (o.quiet) return false;
      this.error = res.error;
      if (!this.dir || o.showError) { this.dir = dir; this.entries = []; this.render(); }
      toast(res.error, true);
      return false;
    }
    this.error = '';
    if (this.remote) { this.cache.set(res.dir, res.entries); if (this.cache.size > 300) this.cache.delete(this.cache.keys().next().value); }
    this.sep = res.sep || '/';
    this.parent = res.parent;
    this._apply(res.dir, res.entries, keepSel, o.select);
    if (!this.remote) API.saveUi({});
    return true;
  }

  _apply(dir, entries, keepSel, select) {
    const changedDir = dir !== this.dir;
    this.dir = dir;
    this.entries = entries;
    if (changedDir) { this.sel.clear(); this.cursor = -1; this.anchor = -1; this.scroll.scrollTop = 0; this.filter = ''; this.filterIn.value = ''; this.filterIn.classList.remove('on'); }
    if (keepSel) this.sel = new Set([...keepSel].filter(n => entries.some(e => e.name === n)));
    if (select) { this.sel = new Set([select]); }
    this.path.value = dir === '::drives' ? 'This PC' : dir;
    // Show the end of a long path, not its beginning.
    requestAnimationFrame(() => { if (document.activeElement !== this.path) this.path.scrollLeft = this.path.scrollWidth; });
    this.compute();
    if (select) { const i = this.view.findIndex(e => e.name === select); if (i >= 0) { this.cursor = i; this.ensureVisible(i); } }
    this.render();
    // Synchronized browsing: the other side's marks depend on this listing.
    if (state.sync) { const other = this.remote ? panels.local : panels.remote; other.compute(); other.render(); }
  }

  compute() {
    const hidden = state.settings.showHidden;
    const f = this.filter.toLowerCase();
    this.diff = diffWith(this);
    let list = this.entries.filter(e => (hidden || !isHiddenName(e.name)) && (!f || e.name.toLowerCase().includes(f)) && (!this.diff || !this.diffOnly || this.diff.has(e.name)));
    const { key, asc } = this.sort;
    const dirFirst = (a, b) => (isDirEntry(b) ? 1 : 0) - (isDirEntry(a) ? 1 : 0);
    const coll = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
    list.sort((a, b) => {
      const d = dirFirst(a, b);
      if (d) return d;
      let r = key === 'size' ? a.size - b.size : key === 'mtime' ? a.mtime - b.mtime : 0;
      if (!r) r = coll.compare(a.name, b.name);
      return asc ? r : -r;
    });
    const up = this.parent != null && this.dir ? [{ name: '..', type: 'up', size: 0, mtime: 0 }] : [];
    this.view = up.concat(list);
    // A filter or a deletion can shorten the list: keep the cursor and the
    // shift-click anchor inside it.
    if (this.cursor >= this.view.length) this.cursor = this.view.length - 1;
    if (this.anchor >= this.view.length) this.anchor = -1;
  }

  render() {
    const enabled = this.enabled;
    const hb = this.el.querySelector('[data-act="hidden"]');
    if (hb) {
      const on = !!state.settings.showHidden;
      if (hb._on !== on) {
        hb._on = on;
        hb.classList.toggle('on', on);
        hb.innerHTML = on ? I.eye : I.eyeOff;
        hb.dataset.tip = (on ? 'Hidden files are shown: click to hide them' : 'Hidden files are hidden: click to show them') + (isMac() ? ' (⇧⌘.)' : ' (Ctrl+Shift+.)');
      }
    }
    this.el.querySelectorAll('.p-tools button, .p-path, .p-filter').forEach(b => { b.disabled = !enabled; });
    if (!this.remote) markPlaces(this);
    const fb = this.el.querySelector('.p-fav');
    if (fb) fb.classList.toggle('on', !!(enabled && favFolders().includes(this.dir)));
    this.el.querySelectorAll('.p-cols div').forEach(d => {
      d.classList.toggle('on', d.dataset.sort === this.sort.key);
      d.classList.toggle('asc', d.dataset.sort === this.sort.key && this.sort.asc);
    });
    if (!enabled) {
      this.empty.style.display = '';
      this.empty.innerHTML = `${I.server}<b>Not connected</b><span>Use the bar above for a quick connection,<br>or open your sites.</span><button class="btn" id="empty-sites">${I.server} SITES</button>`;
      this.empty.querySelector('#empty-sites').onclick = () => openSites();
      this.cancelRename();
      this.spacer.style.height = '0px'; this.spacer.innerHTML = '';
      this.rowEls = [];
      this.info.textContent = '';
      this.xferBtn.disabled = true;
      this.path.value = '';
      return;
    }
    if (this.error && !this.entries.length) {
      this.empty.style.display = '';
      this.empty.innerHTML = `${I.alert}<b>Cannot open this folder</b><span>${esc(this.error)}</span>`;
    } else if (!this.view.filter(e => e.type !== 'up').length) {
      this.empty.style.display = '';
      this.empty.innerHTML = this.filter ? `<span>Nothing matches “${esc(this.filter)}”.</span>` : `${I.folder}<span>${this.remote ? 'This folder is empty.<br>Drop files here to upload them.' : 'This folder is empty.'}</span>`;
    } else this.empty.style.display = 'none';

    const rh = 26;
    const total = this.view.length;
    this.spacer.style.height = total * rh + 'px';
    const top = this.scroll.scrollTop, h = this.scroll.clientHeight || 400;
    const first = Math.max(0, Math.floor(top / rh) - 6);
    const last = Math.min(total, Math.ceil((top + h) / rh) + 6);
    // Reuse the row elements; only their content changes while scrolling.
    const need = last - first;
    while (this.rowEls.length < need) { const r = document.createElement('div'); r.className = 'row'; r.draggable = true; this.spacer.appendChild(r); this.rowEls.push(r); }
    while (this.rowEls.length > need) this.rowEls.pop().remove();
    for (let k = 0; k < need; k++) {
      const i = first + k, e = this.view[i], r = this.rowEls[k];
      r.style.top = i * rh + 'px';
      r.dataset.i = i;
      const cls = ['row'];
      if (e.type === 'up') cls.push('up');
      else if (isDirEntry(e)) cls.push('folder');
      if (this.sel.has(e.name) && e.type !== 'up') cls.push('sel');
      if (i === this.cursor) cls.push('cur');
      if (e.type !== 'up' && isHiddenName(e.name)) cls.push('hidden-f');
      if (e.name.endsWith('.filopart')) cls.push('part');
      const c = cls.join(' ');
      const mark = this.diff && e.type !== 'up' ? this.diff.get(e.name) || '' : '';
      const key = `${c}|${e.name}|${e.size}|${e.mtime}|${mark}`;
      if (r._key === key) continue;
      r._key = key;
      r.className = c;
      if (e.type === 'up') r.innerHTML = `<span class="ic">${I.up}</span><span class="nm">..</span><span class="sz"></span><span class="dt"></span>`;
      else if (e.drive) r.innerHTML = `<span class="ic">${I.drive}</span><span class="nm">${esc(e.name)}${e.slow ? ' <span class="badge o">not answering</span>' : ''}</span><span class="sz"></span><span class="dt"></span>`;
      else r.innerHTML = `<span class="ic">${iconFor(e)}</span><span class="nm">${mark ? `<span class="hl ${mark}" data-tip="${mark === 'o' ? 'Only on this side' : 'Newer on this side'}">${esc(e.name)}</span>` : esc(e.name)}</span><span class="sz">${isDirEntry(e) ? '' : fmtSize(e.size)}</span><span class="dt">${fmtDate(e.mtime)}</span>`;
    }
    if (this._ren) this.placeRename();
    this.updateFoot();
  }

  // Lasso: pressed in the empty space of the list (below the last row) and
  // dragged, a rectangle selects every row it crosses. ⌘ / Ctrl or Shift held:
  // added to what was selected. A press without moving clears the selection,
  // as before. Near the top or bottom edge the list scrolls on its own.
  lasso(ev) {
    ev.preventDefault();
    const rh = 26, sc = this.scroll;
    const add = modKey(ev) || ev.shiftKey;
    const base = add ? new Set(this.sel) : new Set();
    const at = e => { const r = sc.getBoundingClientRect(); return { x: e.clientX - r.left + sc.scrollLeft, y: e.clientY - r.top + sc.scrollTop, cy: e.clientY, top: r.top, bottom: r.bottom }; };
    const p0 = at(ev);
    let box = null, last = ev, moved = false, timer = null;
    const apply = () => {
      const p = at(last);
      const x = Math.min(p0.x, p.x), y = Math.max(0, Math.min(p0.y, p.y));
      const w = Math.abs(p.x - p0.x), h = Math.abs(Math.max(0, p.y) - Math.max(0, p0.y));
      if (!box) { box = document.createElement('div'); box.className = 'lasso'; this.spacer.appendChild(box); }
      Object.assign(box.style, { left: x + 'px', top: y + 'px', width: w + 'px', height: h + 'px' });
      const a = Math.floor(y / rh), b = Math.floor((y + h) / rh);
      const sel = new Set(base);
      for (let k = Math.max(0, a); k <= Math.min(this.view.length - 1, b); k++) {
        const e = this.view[k];
        if (e && e.type !== 'up' && !e.drive) sel.add(e.name);
      }
      this.sel = sel;
      this.render();
    };
    const move = e => {
      last = e;
      if (!moved && Math.hypot(e.clientX - ev.clientX, e.clientY - ev.clientY) < 4) return;
      moved = true;
      apply();
      // Auto-scroll while the pointer is past an edge.
      clearInterval(timer);
      const p = at(e);
      const dir = e.clientY < p.top + 16 ? -1 : e.clientY > p.bottom - 16 ? 1 : 0;
      if (dir) timer = setInterval(() => { sc.scrollTop += dir * rh; apply(); }, 40);
    };
    const up = () => {
      clearInterval(timer);
      removeEventListener('mousemove', move); removeEventListener('mouseup', up);
      if (box) box.remove();
      if (!moved && !add) { this.sel.clear(); this.render(); }
      if (moved) { this.anchor = -1; this.updateFoot(); }
    };
    addEventListener('mousemove', move); addEventListener('mouseup', up);
  }

  // Column widths: SIZE and MODIFIED have a width, NAME takes the rest. The
  // border left of SIZE moves NAME | SIZE; the one left of MODIFIED moves
  // SIZE | MODIFIED. Kept per side.
  applyColumns() {
    const c = (state.ui.cols && state.ui.cols[this.side]) || {};
    this.el.style.setProperty('--c-size', (c.size || 92) + 'px');
    this.el.style.setProperty('--c-date', (c.date || 132) + 'px');
  }
  bindColumns() {
    this.applyColumns();
    const save = c => { state.ui.cols = Object.assign({}, state.ui.cols, { [this.side]: c }); API.saveUi({ cols: state.ui.cols }); };
    this.el.querySelectorAll('.p-cols .rz').forEach(h => {
      h.addEventListener('click', ev => ev.stopPropagation());
      h.addEventListener('dblclick', ev => { ev.stopPropagation(); save({}); this.applyColumns(); });
      h.addEventListener('mousedown', ev => {
        ev.preventDefault(); ev.stopPropagation();
        const start = Object.assign({ size: 92, date: 132 }, (state.ui.cols && state.ui.cols[this.side]) || {});
        const x0 = ev.clientX, which = h.dataset.rz;
        const nameW = this.el.querySelector('.p-cols [data-sort="name"]').getBoundingClientRect().width;
        let cur = start;
        h.classList.add('drag');
        const move = e => {
          const dx = e.clientX - x0;
          if (which === 'size') {
            // NAME keeps at least 120 px; SIZE between 50 and 300.
            const size = Math.max(50, Math.min(300, start.size - Math.max(dx, -(nameW - 120))));
            cur = { size, date: start.date };
          } else {
            // What MODIFIED gains, SIZE gives (and the reverse).
            let date = Math.max(80, Math.min(320, start.date - dx));
            let size = start.size + (start.date - date);
            if (size < 50) { date -= 50 - size; size = 50; }
            cur = { size, date };
          }
          this.el.style.setProperty('--c-size', cur.size + 'px');
          this.el.style.setProperty('--c-date', cur.date + 'px');
        };
        const up = () => { h.classList.remove('drag'); removeEventListener('mousemove', move); removeEventListener('mouseup', up); save(cur); };
        addEventListener('mousemove', move); addEventListener('mouseup', up);
      });
    });
  }

  updateFoot() {
    const items = this.view.filter(e => e.type !== 'up');
    const files = items.filter(e => !isDirEntry(e));
    const selItems = this.selected();
    const selBytes = selItems.filter(e => !isDirEntry(e)).reduce((a, e) => a + e.size, 0);
    if (this.dir === '::drives') { this.info.textContent = plural(items.length, 'drive'); this.xferBtn.disabled = true; return; }
    const parts = [`${plural(items.length - files.length, 'folder')}, ${plural(files.length, 'file')}`];
    if (selItems.length) parts.push(`${selItems.length} selected${selBytes ? ' · ' + fmtSize(selBytes) : ''}`);
    else parts.push(fmtSize(files.reduce((a, e) => a + e.size, 0)));
    this.info.textContent = parts.join(' · ');
    if (this.diff) {
      let o = 0, n = 0;
      for (const v of this.diff.values()) { if (v === 'o') o++; else n++; }
      const d = document.createElement('span');
      d.className = 'dif';
      d.innerHTML = o || n ? [o && `<span class="o"><b>${o}</b> only here</span>`, n && `<span class="n"><b>${n}</b> newer here</span>`].filter(Boolean).join(' · ') : 'same as the other side';
      this.info.appendChild(d);
    }
    this.xferBtn.disabled = !(selItems.length && state.conn);
  }

  selected() { return this.view.filter(e => e.type !== 'up' && !e.drive && this.sel.has(e.name)); }

  ensureVisible(i) {
    const rh = 26, top = i * rh, sc = this.scroll;
    if (top < sc.scrollTop) sc.scrollTop = top;
    else if (top + rh > sc.scrollTop + sc.clientHeight) sc.scrollTop = top + rh - sc.clientHeight;
  }

  rowAt(ev) { const r = ev.target.closest('.row'); return r ? +r.dataset.i : -1; }

  clickRow(i, ev) {
    const e = this.view[i];
    if (!e) return;
    if (e.type === 'up') { this.sel.clear(); this.cursor = i; this.render(); return; }
    if (ev.shiftKey && this.anchor >= 0) {
      const [a, b] = [Math.min(this.anchor, i), Math.max(this.anchor, i)];
      if (!modKey(ev)) this.sel.clear();
      for (let k = a; k <= b; k++) if (this.view[k].type !== 'up') this.sel.add(this.view[k].name);
    } else if (modKey(ev)) {
      if (this.sel.has(e.name)) this.sel.delete(e.name); else this.sel.add(e.name);
      this.anchor = i;
    } else {
      this.sel = new Set([e.name]);
      this.anchor = i;
    }
    this.cursor = i;
    this.render();
  }

  // A folder (or ..) opens. A file never starts a transfer by itself: a
  // double-click shows its menu (ev = the mouse event), Enter renames it.
  // Transfers go through dragging to the other panel, UPLOAD / DOWNLOAD, or
  // the menu.
  open(i, ev) {
    const e = this.view[i];
    if (!e) return;
    if (e.type === 'up') return this.goUp();
    if (isDirEntry(e) || e.drive) { syncFollow(this, { into: e.name }); return this.load(this.join(e.name)); }
    this.sel = new Set([e.name]); this.cursor = i; this.anchor = i; this.render();
    if (ev) this.menu(ev, i);
    else this.rename();
  }

  goUp() {
    if (this.parent == null) return;
    syncFollow(this, { up: true });
    const from = this.remote ? posixBase(this.dir) : localBase(this.dir);
    this.load(this.parent, { select: from });
  }

  // Selected items → the other side.
  transfer(opts) {
    const items = (opts && opts.items) || this.selected();
    if (!items.length || !state.conn) return;
    const other = this.remote ? panels.local : panels.remote;
    const target = (opts && opts.target) || other.dir;
    if (target === '::drives') { toast('Open a drive or a folder on the left first.', true); return; }
    queueAdd(this.remote ? 'down' : 'up', items.map(e => ({ path: this.join(e.name), type: isDirEntry(e) ? 'folder' : 'file', size: e.size })), target, opts && opts.start === false ? false : true);
  }

  async mkdir() {
    const name = await promptBox('New folder', '', 'CREATE');
    if (!name) return;
    const r = this.remote ? await API.remoteMkdir(this.dir, name) : await API.localMkdir(this.dir, name);
    if (!r.ok) return toast(r.error, true);
    this.cache.delete(this.dir);
    this.load(this.dir, { keepSel: true, select: name });
  }

  // Rename in place, as in the Finder and Explorer: the name becomes an
  // editable field on its own row. F2, the menu, or a slow second click on the
  // name of the selected row. Enter or clicking elsewhere renames, Escape
  // cancels. For a file, only the part before the extension is selected.
  rename(value) {
    const s = this.selected();
    if (s.length !== 1 || s[0].drive || s[0].type === 'up') return;
    this.cancelRename();
    const e = s[0];
    const i = this.view.indexOf(e);
    if (i < 0) return;
    this.ensureVisible(i); this.render();
    const inp = document.createElement('input');
    inp.className = 'ren';
    inp.spellcheck = false;
    inp.value = value != null ? value : e.name;
    const r = { el: inp, name: e.name, dir: this.dir, done: false };
    this._ren = r;
    this.spacer.appendChild(inp);
    this.placeRename();
    inp.focus();
    const dot = isDirEntry(e) ? -1 : inp.value.lastIndexOf('.');
    inp.setSelectionRange(0, dot > 0 ? dot : inp.value.length);
    // Keys and clicks stay in the field: they must not move the selection,
    // start a lasso, open a folder or drag the row.
    for (const t of ['mousedown', 'mouseup', 'click', 'dblclick', 'contextmenu', 'dragstart']) inp.addEventListener(t, ev => ev.stopPropagation());
    inp.addEventListener('keydown', ev => {
      ev.stopPropagation();
      if (ev.key === 'Enter') { ev.preventDefault(); this.commitRename(); }
      else if (ev.key === 'Escape') { ev.preventDefault(); this.cancelRename(); this.scroll.focus(); }
      else if (ev.key === 'Tab') { ev.preventDefault(); this.commitRename(); }
    });
    // Clicking elsewhere in filo renames; switching to another application
    // does not (the field is still there on return).
    inp.addEventListener('blur', () => { if (this._ren === r && !r.busy && document.hasFocus()) this.commitRename(); });
  }

  // Keeps the field on its row: the list can scroll, or refresh and move it.
  placeRename() {
    const r = this._ren;
    if (!r) return;
    const i = this.dir === r.dir ? this.view.findIndex(e => e.name === r.name) : -1;
    if (i < 0 || !r.el.isConnected) { if (!r.busy) this.cancelRename(); return; }
    const row = this.rowEls.find(x => +x.dataset.i === i);
    const nm = row && row.querySelector('.nm');
    const left = nm ? nm.offsetLeft - 5 : 26;
    r.el.style.top = (i * 26 + 2) + 'px';
    r.el.style.left = left + 'px';
    r.el.style.width = Math.max(120, (nm ? nm.offsetWidth : 200) + 10) + 'px';
  }

  cancelRename() {
    const r = this._ren;
    if (!r) return;
    this._ren = null;
    r.el.remove();
  }

  async commitRename() {
    const r = this._ren;
    if (!r || r.busy) return;
    const name = r.el.value.trim();
    if (!name || name === r.name) { this.cancelRename(); this.scroll.focus(); return; }
    if (name.includes('/')) {
      toast('A name cannot contain "/".', true);
      r.el.focus(); return;
    }
    r.busy = true;
    r.el.disabled = true;
    const from = this.join(r.name);
    const res = this.remote ? await API.remoteRename(from, name) : await API.localRename(from, name);
    this._ren = null;
    r.el.remove();
    if (!res.ok) {
      toast(res.error, true);
      // Back to editing what was typed, as the Finder does.
      if (this.dir === r.dir && this.sel.size === 1 && this.sel.has(r.name)) this.rename(name);
      return;
    }
    this.cache.delete(this.dir);
    this.scroll.focus();
    this.load(this.dir, { select: name });
  }

  async remove() {
    const s = this.selected();
    if (!s.length) return;
    const what = s.length === 1 ? `“${s[0].name}”` : plural(s.length, 'item');
    if (this.remote) {
      const hasDir = s.some(isDirEntry);
      if (state.settings.confirmDelete !== false || hasDir) {
        const ok = await confirmBox(`Delete ${what} from the server?`, `This is final: a server has no trash.${hasDir ? ' Folders are deleted with everything inside them.' : ''}`, 'DELETE', true);
        if (!ok) return;
      }
      toast('Deleting…');
      delProgress.n = 0;
      const r = await API.remoteDelete(s.map(e => ({ path: this.join(e.name), type: isDirEntry(e) ? 'folder' : 'file' })));
      if (!r.ok) errorBox('Some items were not deleted', r.errors.join('\n'));
      else toast(`Deleted ${plural(r.count, 'item')}`);
    } else {
      if (state.settings.confirmDelete !== false) {
        const ok = await confirmBox(`Move ${what} to the ${TRASH()}?`, 'You can get it back from there.', 'MOVE', true);
        if (!ok) return;
      }
      const r = await API.localDelete(s.map(e => this.join(e.name)));
      if (!r.ok) errorBox('Some items were not moved', r.errors.join('\n'));
    }
    this.cache.delete(this.dir);
    this.load(this.dir);
  }

  menu(ev, i) {
    const e = i >= 0 ? this.view[i] : null;
    if (e && e.type !== 'up' && !this.sel.has(e.name)) { this.sel = new Set([e.name]); this.cursor = i; this.render(); }
    const s = this.selected();
    const n = s.length;
    const conn = !!state.conn;
    const items = [];
    if (this.remote) {
      items.push({ label: n > 1 ? `Download ${n} items` : 'Download', icon: I.download, action: () => this.transfer(), disabled: !n });
      items.push({ label: 'Add to the queue (do not start)', icon: I.list, action: () => this.transfer({ start: false }), disabled: !n });
    } else {
      items.push({ label: n > 1 ? `Upload ${n} items` : 'Upload', icon: I.upload, action: () => this.transfer(), disabled: !n || !conn });
      items.push({ label: 'Add to the queue (do not start)', icon: I.list, action: () => this.transfer({ start: false }), disabled: !n || !conn });
    }
    // Check what is already on both sides, by checksum (Noar, 12/10/2026).
    items.push(state.comparing
      ? { label: 'Stop the check', icon: I.stop || I.trash, danger: true, action: () => API.compareCancel() }
      : { label: 'Check against the other side', icon: I.shield, disabled: !n || !conn || panels.local.dir === '::drives', action: () => checkAgainst(s.map(x => x.name)) });
    items.push('sep');
    if (n === 1 && isDirEntry(s[0])) items.push({ label: 'Open', icon: I.folder, action: () => this.load(this.join(s[0].name)) });
    if (!this.remote && n === 1 && !isDirEntry(s[0])) items.push({ label: 'Open with the default app', icon: I.eye, action: async () => { const r = await API.localOpen(this.join(s[0].name)); if (!r.ok) toast(r.error, true); } });
    if (!this.remote && n >= 1) items.push({ label: `Show in ${FILE_MANAGER()}`, icon: I.folder, action: () => API.localReveal(this.join(s[0].name)) });
    items.push({ label: 'Rename', icon: I.edit, key: 'F2', action: () => this.rename(), disabled: n !== 1 });
    items.push({ label: 'New folder', icon: I.plus, action: () => this.mkdir() });
    items.push('sep');
    if (this.remote) items.push({ label: 'Copy URL', icon: I.copy, action: async () => { const u = await API.remoteUrl(n ? this.join(s[0].name) : this.dir); API.copyText(u); toast('Copied'); } });
    items.push({ label: 'Copy path', icon: I.copy, action: () => { API.copyText(n ? s.map(x => this.join(x.name)).join('\n') : this.dir); toast('Copied'); } });
    items.push({ label: 'Refresh', icon: I.refresh, key: 'F5', action: () => { this.cache.delete(this.dir); this.load(this.dir, { keepSel: true }); } });
    items.push('sep');
    items.push({ label: this.remote ? 'Delete' : `Move to ${TRASH()}`, icon: I.trash, danger: true, action: () => this.remove(), disabled: !n });
    showMenu(ev.clientX, ev.clientY, items);
  }

  bind() {
    this.scroll.addEventListener('scroll', () => this.render(), { passive: true });
    new ResizeObserver(() => this.render()).observe(this.scroll);
    this.scroll.addEventListener('mousedown', ev => {
      clearTimeout(this._slowT);
      // Was the list already active, with this very row the only selection?
      // Then a click on its name (without double-clicking) renames it.
      this._slowCan = document.activeElement === this.scroll && this.sel.size === 1;
      if (ev.button !== 0) return;
      const i = this.rowAt(ev);
      if (i < 0) { if (this.enabled && ev.target.closest('.p-scroll')) this.lasso(ev); return; }
      // A click on an already-selected row keeps the selection, so it can be dragged.
      const e = this.view[i];
      if (e && this.sel.has(e.name) && !modKey(ev) && !ev.shiftKey) { this._pendingClick = i; return; }
      this.clickRow(i, ev);
    });
    this.scroll.addEventListener('mouseup', ev => {
      const i = this._pendingClick;
      if (i != null && this.rowAt(ev) === i) {
        const e = this.view[i];
        const slow = this._slowCan && e && this.sel.size === 1 && this.sel.has(e.name) && ev.target.closest('.nm') && !modKey(ev) && !ev.shiftKey && ev.detail === 1;
        this.clickRow(i, ev);
        // Still the same file, still this list, nothing else open: rename.
        if (slow) this._slowT = setTimeout(() => { if (this.sel.size === 1 && this.sel.has(e.name) && document.activeElement === this.scroll && !isDialogOpen() && !$('ctx').classList.contains('open')) this.rename(); }, 550);
      }
      this._pendingClick = null;
    });
    this.scroll.addEventListener('dblclick', ev => { clearTimeout(this._slowT); const i = this.rowAt(ev); if (i >= 0) this.open(i, ev); });
    this.scroll.addEventListener('contextmenu', ev => { ev.preventDefault(); if (this.enabled) this.menu(ev, this.rowAt(ev)); });
    this.scroll.addEventListener('keydown', ev => this.key(ev));

    this.path.addEventListener('keydown', ev => {
      if (ev.key === 'Enter') { ev.preventDefault(); const v = this.path.value.trim(); if (v && v !== this.dir) { syncOff('you typed a path'); this.load(v, { showError: false, fallback: this.dir }); } this.scroll.focus(); }
      if (ev.key === 'Escape') { this.path.value = this.dir === '::drives' ? 'This PC' : this.dir; this.scroll.focus(); }
    });
    this.filterIn.addEventListener('input', () => {
      this.filter = this.filterIn.value.trim();
      this.filterIn.classList.toggle('on', !!this.filter);
      this.compute(); this.render();
    });
    this.filterIn.addEventListener('keydown', ev => { if (ev.key === 'Escape') { this.filterIn.value = ''; this.filterIn.dispatchEvent(new Event('input')); this.scroll.focus(); } });
    this.bindColumns();
    this.el.querySelectorAll('.p-cols div').forEach(d => d.addEventListener('click', ev => {
      if (ev.target.closest('.rz')) return;
      const k = d.dataset.sort;
      this.sort = { key: k, asc: this.sort.key === k ? !this.sort.asc : k === 'name' };
      state.ui.sort = Object.assign({}, state.ui.sort, { [this.side]: this.sort });
      API.saveUi({ sort: state.ui.sort });
      this.compute(); this.render();
    }));
    this.el.querySelector('.p-tools').addEventListener('click', async ev => {
      const b = ev.target.closest('button');
      if (!b) return;
      const act = b.dataset.act;
      if (act === 'up') this.goUp();
      if (act === 'refresh') { this.cache.delete(this.dir); this.load(this.dir, { keepSel: true }); }
      if (act === 'mkdir') this.mkdir();
      if (act === 'hidden') saveSettings({ showHidden: !state.settings.showHidden });
      if (act === 'diff') { this.diffOnly = !this.diffOnly; b.classList.toggle('on', this.diffOnly); this.compute(); this.render(); }
      if (act === 'home' && state.conn && this.dir !== state.conn.home) { syncOff('you jumped to another folder'); this.load(state.conn.home); }
      if (act === 'fav' && state.conn) favMenu(this, b);
    });
    // Local side: Desktop, Downloads, the disks (Noar, 13/10/2026).
    const places = this.el.querySelector('.p-places');
    if (places) places.addEventListener('click', async ev => {
      const b = ev.target.closest('button[data-act]');
      if (!b) return;
      const act = b.dataset.act;
      if (act === 'drives') return drivesMenu(this, b);
      const pl = placesCache = await API.localPlaces();
      if (!pl[act]) return toast('This folder was not found on this computer.', true);
      if (pl[act] !== this.dir) { syncOff('you jumped to another folder'); this.load(pl[act]); }
    });
    // Local side: the system's folder picker, which also reaches every disk,
    // volume and network share.
    const browse = this.el.querySelector('[data-act="browse"]');
    if (browse) browse.addEventListener('click', async () => {
      const p = await API.pickFolder(this.dir && this.dir !== '::drives' ? this.dir : undefined);
      if (p && p !== this.dir) { syncOff('you jumped to another folder'); this.load(p); }
    });
    this.xferBtn.addEventListener('click', () => this.transfer());

    // ── Drag and drop ──
    this.scroll.addEventListener('dragstart', ev => {
      clearTimeout(this._slowT);
      const i = this.rowAt(ev);
      const e = this.view[i];
      if (!e || e.type === 'up' || e.drive) { ev.preventDefault(); return; }
      if (!this.sel.has(e.name)) { this.sel = new Set([e.name]); this.render(); }
      const items = this.selected();
      dragSrc = { side: this.side, dir: this.dir, items };
      ev.dataTransfer.effectAllowed = 'copyMove';
      ev.dataTransfer.setData('text/plain', items.map(x => this.join(x.name)).join('\n'));
      const g = document.createElement('div');
      g.className = 'drag-ghost';
      g.textContent = items.length === 1 ? items[0].name : `${items.length} items`;
      document.body.appendChild(g);
      ev.dataTransfer.setDragImage(g, -10, -10);
      setTimeout(() => g.remove(), 0);
    });
    this.scroll.addEventListener('dragend', () => { dragSrc = null; });
    // Same panel: a move, onto a folder of the list or onto "..". Another
    // panel: a transfer. Where the pointer is decides.
    const moveTarget = ev => {
      const r = ev.target.closest('.row');
      const e = r ? this.view[+r.dataset.i] : null;
      if (!e || e.drive) return null;
      if (e.type === 'up') return this.parent != null && this.parent !== '::drives' ? { row: r, dir: this.parent } : null;
      if (!isDirEntry(e) || dragSrc.items.some(x => x.name === e.name)) return null;
      return { row: r, dir: this.join(e.name) };
    };
    const accepts = ev => {
      if (!this.enabled) return false;
      if (dragSrc && dragSrc.side === this.side) return dragSrc.dir === this.dir && (!this.remote || !!state.conn);
      if (!state.conn) return false;
      if (dragSrc) return dragSrc.side !== this.side;
      // Files from the Finder / Explorer: only the server side takes them.
      return this.remote && ev.dataTransfer && [...ev.dataTransfer.types].includes('Files');
    };
    let overRow = null;
    const clearOver = () => { if (overRow) { overRow.classList.remove('drop'); overRow = null; } this.el.classList.remove('dragover'); };
    this.el.addEventListener('dragover', ev => {
      if (!accepts(ev)) return;
      if (dragSrc && dragSrc.side === this.side) {
        const m = moveTarget(ev);
        if (overRow !== (m ? m.row : null)) { if (overRow) overRow.classList.remove('drop'); overRow = m ? m.row : null; if (overRow) overRow.classList.add('drop'); }
        if (!m) return;                                   // nowhere to move to: the pointer says no
        ev.preventDefault();
        ev.dataTransfer.dropEffect = 'move';
        return;
      }
      ev.preventDefault();
      ev.dataTransfer.dropEffect = 'copy';
      const r = ev.target.closest('.row');
      const e = r ? this.view[+r.dataset.i] : null;
      const onFolder = e && e.type !== 'up' && isDirEntry(e);
      if (overRow !== (onFolder ? r : null)) { if (overRow) overRow.classList.remove('drop'); overRow = onFolder ? r : null; if (overRow) overRow.classList.add('drop'); }
      this.el.classList.toggle('dragover', !onFolder);
    });
    this.el.addEventListener('dragleave', ev => { if (!this.el.contains(ev.relatedTarget)) clearOver(); });
    this.el.addEventListener('drop', async ev => {
      if (!accepts(ev)) return;
      if (dragSrc && dragSrc.side === this.side) {
        const m = moveTarget(ev);
        clearOver();
        if (!m) return;
        ev.preventDefault();
        const items = dragSrc.items;
        dragSrc = null;
        this.moveItems(items, m.dir);
        return;
      }
      ev.preventDefault();
      const r = ev.target.closest('.row');
      const e = r ? this.view[+r.dataset.i] : null;
      const target = e && e.type !== 'up' && isDirEntry(e) ? this.join(e.name) : this.dir;
      clearOver();
      if (dragSrc) {
        const src = dragSrc.side === 'local' ? panels.local : panels.remote;
        src.transfer({ items: dragSrc.items, target });
        dragSrc = null;
      } else {
        const paths = [...ev.dataTransfer.files].map(f => API.pathForFile(f)).filter(Boolean);
        if (!paths.length) return;
        const st = await API.localStatMany(paths);
        queueAdd('up', st.map(x => ({ path: x.path, type: x.type, size: x.size })), target, true);
      }
    });
  }

  // Dragged onto a folder of the same panel (or ".."): moved there.
  async moveItems(items, dir) {
    const paths = items.map(x => this.join(x.name));
    const r = this.remote ? await API.remoteMove(paths, dir) : await API.localMove(paths, dir);
    if (this.remote) { this.cache.delete(this.dir); this.cache.delete(dir); }
    this.sel.clear();
    this.load(this.dir, { keepSel: false });
    const to = this.remote ? posixBase(dir) || '/' : localBase(dir) || dir;
    const n = (r.moved || []).length;
    if (r.errors && r.errors.length) errorBox(n ? `${plural(n, 'item')} moved, some not` : 'Nothing was moved', r.errors.slice(0, 30).join('\n'));
    else if (n) toast(`${plural(n, 'item')} moved to ${to}`);
  }

  key(ev) {
    clearTimeout(this._slowT);                 // a key pressed: no late rename
    const n = this.view.length;
    const mod = modKey(ev);
    const move = d => {
      const i = Math.max(0, Math.min(n - 1, (this.cursor < 0 ? -1 : this.cursor) + d));
      if (ev.shiftKey && this.anchor >= 0) {
        this.sel.clear();
        for (let k = Math.min(this.anchor, i); k <= Math.max(this.anchor, i); k++) if (this.view[k].type !== 'up') this.sel.add(this.view[k].name);
      } else { const e = this.view[i]; this.sel = e && e.type !== 'up' ? new Set([e.name]) : new Set(); this.anchor = i; }
      this.cursor = i; this.ensureVisible(i); this.render();
    };
    if (ev.key === 'ArrowDown') { ev.preventDefault(); move(1); }
    else if (ev.key === 'ArrowUp') { ev.preventDefault(); move(-1); }
    else if (ev.key === 'PageDown') { ev.preventDefault(); move(Math.floor(this.scroll.clientHeight / 26)); }
    else if (ev.key === 'PageUp') { ev.preventDefault(); move(-Math.floor(this.scroll.clientHeight / 26)); }
    else if (ev.key === 'Home') { ev.preventDefault(); move(-n); }
    else if (ev.key === 'End') { ev.preventDefault(); move(n); }
    else if (ev.key === 'Enter') { ev.preventDefault(); if (this.cursor >= 0) this.open(this.cursor); }
    else if (ev.key === 'Backspace' && !mod) { ev.preventDefault(); this.goUp(); }
    else if ((ev.key === 'Delete') || (ev.key === 'Backspace' && mod)) { ev.preventDefault(); this.remove(); }
    else if (ev.key === 'F2') { ev.preventDefault(); this.rename(); }
    // Space: Quick Look on a local file, as in the Finder (Mac; Noar, 12/10/2026).
    else if (ev.key === ' ' && !mod && !this.remote && isMac() && this.cursor >= 0) {
      const e = this.view[this.cursor];
      if (e && e.type !== 'up' && !isDirEntry(e)) { ev.preventDefault(); API.localPreview(this.join(e.name)); }
    }
    else if (mod && ev.key.toLowerCase() === 'a') { ev.preventDefault(); this.sel = new Set(this.view.filter(e => e.type !== 'up').map(e => e.name)); this.render(); }
    else if (ev.key === 'Tab') { ev.preventDefault(); (this.remote ? panels.local : panels.remote).scroll.focus(); }
    else if (ev.key.length === 1 && !mod && /\S/.test(ev.key)) {
      // Type-ahead: jump to the first name starting with what was typed.
      clearTimeout(this._taTimer);
      this._ta = (this._ta || '') + ev.key.toLowerCase();
      this._taTimer = setTimeout(() => { this._ta = ''; }, 800);
      const i = this.view.findIndex(e => e.type !== 'up' && e.name.toLowerCase().startsWith(this._ta));
      if (i >= 0) { this.cursor = i; this.anchor = i; this.sel = new Set([this.view[i].name]); this.ensureVisible(i); this.render(); }
    }
  }
}

let panels = null;

// ── Queue: adding ──────────────────────────────────────────────────────────
async function queueAdd(dir, sources, target, start) {
  if (!sources.length) return;
  const hasFolder = sources.some(s => s.type === 'folder');
  let scanTimer = null;
  if (hasFolder) scanTimer = setTimeout(() => { $('scan-txt').textContent = 'Listing folders…'; $('scan').classList.add('open'); }, 300);
  const res = await API.queueAdd({ dir, sources, target, start });
  clearTimeout(scanTimer);
  $('scan').classList.remove('open');
  if (!res.ok) { if (!res.cancelled) toast(res.error || 'Could not add to the queue.', true); return; }
  if (res.conflict) errorBox('Not added: same destination', `${plural(res.conflict, 'file')} would land under the same name as another file of the queue (two cards with the same clip names into one folder, say). They were left out, so neither replaces the other. Send them to separate folders.`);
  else if (res.already) toast(`${plural(res.already, 'file')} already in the queue: not added twice`);
  else if (start === false) toast(`${plural(res.count, 'item')} added to the queue`);
  setQTab('queue');
  // Files stopped earlier with a partial copy: resume them, or start again.
  if (res.revived && res.revived.length) {
    const r = await askResume(res.revived);
    if (!r) return;                            // CANCEL: they stay in Failed, untouched
    await API.queueRetry([...res.revived.map(x => x.id), ...r.extra], r.mode);
    if (start !== false) API.queueStart();
  }
}

// ══ Connection ═════════════════════════════════════════════════════════════
const DEFAULT_PORT = { sftp: 22, ftps: 21, 'ftps-implicit': 990, ftp: 21 };
const PROTO_LABEL = { sftp: 'SFTP', ftps: 'FTPS', 'ftps-implicit': 'FTPS implicit', ftp: 'FTP' };

const PROTO_INFO = {
  sftp: ['SFTP', 'over SSH, encrypted', 'SFTP — over SSH, encrypted. Port 22.'],
  ftps: ['FTPS', 'explicit TLS, encrypted', 'FTPS explicit (AUTH TLS) — encrypted. Port 21.'],
  'ftps-implicit': ['FTPS-i', 'implicit TLS, encrypted', 'FTPS implicit — encrypted from the first byte. Port 990.'],
  ftp: ['FTP', 'NOT encrypted', 'Plain FTP — NOT encrypted: password and files travel in clear.'],
};
// Only the protocol in use shows; a click lists the four.
function protoMenu() {
  const r = $('q-proto').getBoundingClientRect();
  showMenu(r.left, r.bottom + 6, [{ head: 'Protocol' }].concat(Object.keys(PROTO_INFO).map(v => ({
    label: `${PROTO_INFO[v][0]} — ${PROTO_INFO[v][1]}, port ${DEFAULT_PORT[v]}`, on: state.proto === v, radio: true,
    action: () => { barEdited(); setProto(v); API.saveUi({ lastProto: v }); },
  }))));
}

function setProto(p) {
  state.proto = p;
  const b = $('q-proto');
  b.innerHTML = `${esc(PROTO_INFO[p][0])}${I.chev.replace('<svg', '<svg class="chev"')}`;
  b.classList.toggle('warn', p === 'ftp');
  b.dataset.tip = PROTO_INFO[p][2] + ' Click to change.';
  $('q-port').placeholder = String(DEFAULT_PORT[p]);
}

async function connectWith(req, label) {
  panels.remote.busy.style.display = '';
  state.connecting = true; renderConnectBtn();
  let res;
  try { res = await API.connect(req); }
  finally { state.connecting = false; panels.remote.busy.style.display = 'none'; renderConnectBtn(); }
  if (res.ok) { if (res.warn) toast(res.warn, true); return onConnected(res); }
  if (res.code === 'TRUST_NEEDED' && res.trust) {
    const ok = await trustBox(res.trust);
    if (ok) return connectWith(Object.assign({}, req, { acceptFingerprint: res.trust.fingerprint }), label);
    return;
  }
  if (res.needsPassword) {
    const site = req.siteId ? state.sites.find(s => s.id === req.siteId) : null;
    const pw = await passwordBox(label || (site ? site.name : req.quick.host), { canSave: !!(site && site.logon === 'normal'), title: site && site.logon === 'key' ? 'Key passphrase' : 'Password' });
    if (!pw) return;
    return connectWith(Object.assign({}, req, { password: pw.password, savePassword: pw.save }), label);
  }
  errorBox('Could not connect', res.error);
}

async function quickConnect() {
  if (state.connecting) return;                 // one connection at a time
  const host = $('q-host').value.trim();
  if (!host) { $('q-host').focus(); return; }
  const port = parseInt($('q-port').value, 10) || 0;
  const req = { quick: { protocol: state.proto, host, port, user: $('q-user').value.trim() }, password: $('q-pass').value };
  await connectWith(req, host);
}

function onConnected(res) {
  state.conn = res;
  fillBarFromConn();
  if (res.quickHistory) state.quickHistory = res.quickHistory;
  $('q-pass').value = '';
  panels.remote.cache.clear();
  panels.remote.dir = '';
  syncOff();
  renderConnPill();
  panels.remote.load(res.startDir, { fallback: res.home });
  if (res.localDir) panels.local.load(res.localDir);
  else panels.local.updateFoot();          // UPLOAD becomes available for what is selected
  toast(`Connected to ${res.label}`);
}

function setDisconnected() {
  state.conn = null;
  syncOff();
  panels.remote.entries = []; panels.remote.view = []; panels.remote.dir = ''; panels.remote.cache.clear();
  renderConnPill();
  panels.remote.render();
  panels.local.updateFoot();
}

async function disconnect() {
  if (!state.conn) return;
  await API.disconnect();
  setDisconnected();
}

// ── Favorite folders, per server (Noar, 12/10/2026) ──────────────────────
// Kept by the server's address (sftp://user@host:port): a site and a quick
// connection to the same server share them.
// The disks mounted now (Mac: /Volumes; Windows: the drive letters; Linux:
// what the desktop mounts and /mnt), asked at each click.
async function drivesMenu(panel, btn) {
  const pl = await API.localPlaces();
  const r = btn.getBoundingClientRect();
  const items = [{ head: 'Disks' }];
  if (isWin()) items.push({ label: 'This PC', icon: I.server, action: () => panel.load('::drives') });
  for (const d of pl.drives) items.push({ label: d.label, icon: I.drive, key: d.system ? (isMac() ? 'start-up' : '') : '', on: panel.dir === d.path, action: () => { if (d.path !== panel.dir) { syncOff('you jumped to another folder'); panel.load(d.path); } } });
  if (pl.drives.length === 0) items.push({ label: 'No disk found', disabled: true });
  showMenu(r.left, r.bottom + 6, items);
}
// The Desktop / Downloads button of the folder shown, lit.
let placesCache = null;
function markPlaces(panel) {
  const NAME = { desktop: 'Desktop', downloads: 'Downloads' };
  const set = pl => panel.el.querySelectorAll('.p-places [data-act]').forEach(b => {
    const p = pl[b.dataset.act];
    if (!NAME[b.dataset.act]) return;
    b.classList.toggle('cur', !!p && p === panel.dir);
    b.dataset.tip = p ? `${NAME[b.dataset.act]}: ${p}` : `${NAME[b.dataset.act]}: not found on this computer`;
  });
  if (placesCache) set(placesCache);
  else API.localPlaces().then(pl => { placesCache = pl; set(pl); });
}
function favKey() { const c = state.conn; return c ? String(c.address || c.endpointId || '') : ''; }
function favFolders() { const k = favKey(); return (k && ((state.ui.favFolders || {})[k])) || []; }
function setFavFolders(list) {
  const k = favKey(); if (!k) return;
  const all = Object.assign({}, state.ui.favFolders || {});
  if (list.length) all[k] = list.slice(0, 30); else delete all[k];
  state.ui.favFolders = all;
  API.saveUi({ favFolders: all });
  panels.remote.render();
}
function favMenu(panel, btn) {
  const list = favFolders(), here = panel.dir, has = list.includes(here);
  const r = btn.getBoundingClientRect();
  const items = [has
    ? { label: 'Remove this folder from the favorites', icon: I.trash, action: () => setFavFolders(list.filter(x => x !== here)) }
    : { label: 'Add this folder to the favorites', icon: I.plus, disabled: !here, action: () => setFavFolders(list.concat(here).sort((a, b) => a.localeCompare(b))) }];
  if (list.length) items.push('sep', { head: 'Go to' });
  for (const p of list) items.push({ label: p, icon: I.folder, on: p === here, action: () => { if (p !== panel.dir) { syncOff('you jumped to another folder'); panel.load(p); } } });
  showMenu(Math.max(10, r.right - 320), r.bottom + 6, items);
}
function renderConnPill() {
  const c = state.conn;
  renderSync();
  const pill = $('conn-pill');
  pill.classList.toggle('on', !!c);
  // A site shows its name, then where it points; a quick connection is its
  // address. Click: the address (URL) is copied.
  const quick = c && String(c.endpointId || '').startsWith('quick:');
  $('conn-name').textContent = !c ? 'Not connected' : quick ? (c.address || c.label) : c.label;
  $('conn-name').classList.toggle('mono', !!quick);
  $('conn-addr').textContent = c && !quick ? (c.address || '') : '';
  renderConnectBtn();
  $('conn-proto').textContent = c ? PROTO_LABEL[c.protocol] : '';
  const b = [];
  if (c && c.protocol === 'ftp') b.push('<span class="badge o">Not encrypted</span>');
  // What will really happen, from the server's abilities AND the settings.
  const can = !!(c && c.serverHash && c.serverHash.length);
  const verifyOn = state.settings.verify !== false, useServer = state.settings.serverHash !== false;
  if (can && verifyOn && useServer) b.push(`<span class="badge g">Server checksums</span>`);
  $('conn-badges').innerHTML = b.join(' ');
  pill.dataset.tip = !c ? 'Not connected' :
    `${c.url || c.label} — click to copy\n${c.label} — ${PROTO_LABEL[c.protocol]}${c.protocol === 'ftp' ? ': password and files travel in clear' : ', encrypted'}.\n` +
    (!verifyOn ? 'CHECKSUM is off: only sizes are checked.'
      : can && useServer ? `The server computes checksums (${c.serverHash.join(', ').toUpperCase()}): files are verified without a second transfer.`
      : can ? 'Settings ask to read files back: each file is transferred a second time to verify it.'
      : 'The server does not compute checksums: verification reads files back.');
}

// The green CONNECT button turns into a red DISCONNECT once connected. Typing
// another server in the bar (or choosing one from the history) turns it back
// into CONNECT: the new connection then replaces the current one.
// The button shows the state: red NOT CONNECTED (plug apart), green
// CONNECTED (plug in). Hovering says what a click does: CONNECT, DISCONNECT.
// Another server typed in the bar while connected: red CONNECT (a click
// connects there, replacing the current connection).
function renderConnectBtn() {
  const b = $('q-connect');
  if (!b) return;
  const on = !!state.conn && !state.barDirty;
  b.disabled = !!state.connecting;
  b.classList.toggle('go', on && !state.connecting);
  b.classList.toggle('stop', !on && !state.connecting);
  // Icon and colour only (Noar, 11/10/2026): green plug in = connected, red
  // plug apart = not connected. The words are in the tooltip and for screen
  // readers.
  b.innerHTML = on ? I.plugged : I.unplug;
  b.classList.toggle('busy', !!state.connecting);
  b.dataset.tip = state.connecting ? 'Connecting…'
    : on ? `Connected to ${state.conn.label}. Click to disconnect (${isMac() ? '⌘D' : 'Ctrl+D'}).`
    : state.conn ? 'Connect to the server typed in the bar instead (replaces the current connection).'
    : 'Not connected. Click to connect to the server typed in the bar.';
  b.setAttribute('aria-label', state.connecting ? 'Connecting' : on ? 'Connected: disconnect' : 'Not connected: connect');
}
// The bar shows the server in use (never its password).
function fillBarFromConn() {
  const c = state.conn;
  if (!c) return;
  setProto(c.protocol);
  $('q-host').value = c.host || '';
  $('q-port').value = c.port && c.port !== DEFAULT_PORT[c.protocol] ? c.port : '';
  $('q-user').value = c.user || '';
  $('q-pass').value = '';
  state.barDirty = false;
  renderConnectBtn();
}
function barEdited() { if (state.conn && !state.barDirty) { state.barDirty = true; renderConnectBtn(); } }

// Recent connections, sites and quick ones, the last first. A site connects
// straight away; a quick connection fills the bar (its password is not kept).
function showQuickHistory() {
  const r = $('q-hist').getBoundingClientRect();
  const addr = q => `${q.user ? q.user + '@' : ''}${q.host}${q.port && q.port !== DEFAULT_PORT[q.protocol] ? ':' + q.port : ''}`;
  const items = state.quickHistory.map(q => {
    if (q.siteId) {
      const s = state.sites.find(x => x.id === q.siteId);
      if (!s) return null;                       // a site deleted since
      return { label: `${s.name} · ${addr(s)}`, key: PROTO_INFO[s.protocol] ? PROTO_INFO[s.protocol][0] : '', icon: I.server, action: () => connectWith({ siteId: s.id }, s.name) };
    }
    if (!PROTO_INFO[q.protocol]) return null;
    return {
      label: addr(q), key: PROTO_INFO[q.protocol][0], icon: I.globe,
      action: () => { barEdited(); setProto(q.protocol); $('q-host').value = q.host; $('q-port').value = q.port && q.port !== DEFAULT_PORT[q.protocol] ? q.port : ''; $('q-user').value = q.user || ''; $('q-pass').focus(); },
    };
  }).filter(Boolean);
  items.unshift({ head: 'Recent connections' });
  if (state.conn) items.push('sep', { label: `Disconnect from ${String(state.conn.endpointId || '').startsWith('quick:') ? state.conn.address : state.conn.label}`, icon: I.unplug, key: isMac() ? '⌘D' : 'Ctrl+D', action: disconnect });
  if (items.length === 1) items.push({ label: 'No recent connection yet', disabled: true });
  else items.push('sep', { label: 'Save the current one as a site…', icon: I.plus, disabled: !state.conn || !state.conn.endpointId.startsWith('quick:'), action: saveQuickAsSite },
    { label: 'Clear the list', icon: I.trash, action: async () => { state.quickHistory = await API.quickClear(); } });
  showMenu(Math.max(10, r.right - 320), r.bottom + 6, items);
}

async function saveQuickAsSite() {
  const c = state.conn;
  if (!c) return;
  const m = /^quick:([^:]+):(.*)@(.+):(\d+)$/.exec(c.endpointId);
  if (!m) return;
  const name = await promptBox('Save as a site', m[3], 'SAVE');
  if (!name) return;
  const r = await API.sitesFromQuick({ protocol: m[1], user: m[2], host: m[3], port: Number(m[4]) }, name);
  state.sites = r.sites;
  toast(`Saved “${name}” in your sites`);
}

// ══ Site manager ═══════════════════════════════════════════════════════════
const sm = { selId: null, draft: null, pwAction: undefined, ppAction: undefined, search: '' };

// Opens as it was left (Noar, 0.6.4): the folders open then, the site
// selected then, the same scroll. Nothing is unfolded on its own, unless a
// given site is asked for.
async function openSites(selectId) {
  const r = await API.sitesList();
  state.sites = r.sites; state.vault = r.vaultAvailable;
  if (r.siteFolderOrder) state.siteFolderOrder = r.siteFolderOrder;
  sm.search = ''; $('sm-search').value = '';
  $('ov-sites').classList.add('open');
  const last = sm.selId || (state.ui && state.ui.sitesSel);
  const pick = selectId || last;
  selectSite(pick && state.sites.find(s => s.id === pick) ? pick : null, { expand: !!selectId });
  const top = state.ui && state.ui.sitesScroll;
  if (!selectId && top) requestAnimationFrame(() => { $('sm-list').scrollTop = top; });
}
function closeSites() { $('ov-sites').classList.remove('open'); }

// Folders form a tree ("Clients / Agency X" is Agency X inside Clients), folded
// by default. What is open is remembered. A search opens everything, and the
// folder of the selected site always shows it.
function smOpen() {
  if (!sm.open) sm.open = new Set((state.ui && state.ui.sitesOpen) || []);
  return sm.open;
}
function smToggle(path) {
  const o = smOpen();
  if (o.has(path)) o.delete(path); else o.add(path);
  API.saveUi({ sitesOpen: [...o] });
  state.ui.sitesOpen = [...o];
  renderSiteList();
}
function renderSiteList() {
  const q = sm.search.toLowerCase();
  const list = state.sites.filter(s => !q || `${s.name} ${s.host} ${s.user} ${s.folder}`.toLowerCase().includes(q));
  const root = { dirs: new Map(), sites: [], count: 0 };
  // The sites keep the order the user gave them (drag and drop), not A to Z.
  for (const s of list) {
    const parts = String(s.folder || '').split(' / ').map(x => x.trim()).filter(Boolean);
    let node = root; node.count++;
    let path = '';
    for (const p of parts) {
      path = path ? path + ' / ' + p : p;
      if (!node.dirs.has(p)) node.dirs.set(p, { name: p, path, dirs: new Map(), sites: [], count: 0 });
      node = node.dirs.get(p); node.count++;
    }
    node.sites.push(s);
  }
  // Folders of their own (an empty one too): they live in the order list.
  if (!q) for (const fp of state.siteFolderOrder || []) {
    let node = root, path = '';
    for (const p of String(fp).split(' / ').map(x => x.trim()).filter(Boolean)) {
      path = path ? path + ' / ' + p : p;
      if (!node.dirs.has(p)) node.dirs.set(p, { name: p, path, dirs: new Map(), sites: [], count: 0 });
      node = node.dirs.get(p);
    }
  }
  const open = smOpen();
  const ren = sm.renaming;
  let html = '';
  const short = { sftp: 'SFTP', ftps: 'FTPS', 'ftps-implicit': 'FTPS-i', ftp: 'FTP' };
  const draw = (node, depth) => {
    const pad = depth * 14;
    for (const d of [...node.dirs.values()].sort(folderCmp)) {
      const isOpen = !!q || open.has(d.path);
      const editing = ren && ren.kind === 'folder' && ren.key === d.path;
      html += `<div class="sm-folder${isOpen ? ' open' : ''}${sm.selFolder === d.path ? ' sel' : ''}" data-path="${esc(d.path)}"${q || editing ? '' : ' draggable="true"'} style="padding-left:${6 + pad}px"><span class="chev">${I.chev}</span>${I.folder}${editing ? `<input class="sm-ren" id="sm-ren" value="${esc(d.name)}" aria-label="Folder name" spellcheck="false">` : `<span class="nm">${esc(d.name)}</span><span class="n">${d.count}</span>`}</div>`;
      if (isOpen) draw(d, depth + 1);
    }
    for (const s of node.sites) {
      const editing = ren && ren.kind === 'site' && ren.key === s.id;
      html += `<div class="sm-item${s.id === sm.selId ? ' sel' : ''}" data-id="${esc(s.id)}"${q || editing ? '' : ' draggable="true"'} style="padding-left:${9 + pad + (depth ? 8 : 0)}px"><span class="ic ${s.protocol}">${short[s.protocol]}</span><div class="t">${editing ? `<input class="sm-ren" id="sm-ren" value="${esc(s.name)}" aria-label="Site name" spellcheck="false">` : `<div class="a">${esc(s.name)}</div>`}<div class="b">${esc(s.user ? s.user + '@' : '')}${esc(s.host)}</div></div></div>`;
    }
  };
  draw(root, 0);
  if (!state.sites.length && !root.dirs.size) html = '<div class="sm-empty" style="padding:30px 10px">No site yet.<br>Create one, or import your FileZilla sites.</div>';
  else if (q && !list.length) html = '<div class="sm-empty" style="padding:30px 10px">No match.</div>';
  // The empty space below the rows: a drop there goes to the top level.
  if (!q) html += '<div class="sm-drop-end"></div>';
  $('sm-list').innerHTML = html;
  const inp = $('sm-ren');
  if (inp) {
    inp.focus(); inp.select();
    inp.addEventListener('keydown', ev => { ev.stopPropagation(); if (ev.key === 'Enter') smCommitRename(); if (ev.key === 'Escape') { sm.renaming = null; renderSiteList(); } });
    inp.addEventListener('blur', () => smCommitRename());
    inp.addEventListener('mousedown', ev => ev.stopPropagation());
  }
}

// ── Folders and sites from the list itself (Noar, 0.6.4) ───────────────────
// Rename in place, new folder, duplicate, delete (asked first). A folder is a
// path ("Clients / Agency X"); renaming or moving it rewrites the paths under it.
const allFolders = () => {
  const set = new Set(state.siteFolderOrder || []);
  for (const s of state.sites) { const parts = String(s.folder || '').split(' / ').filter(Boolean); parts.forEach((_, i) => set.add(parts.slice(0, i + 1).join(' / '))); }
  return set;
};
const freeFolderName = (parent, base) => {
  const all = allFolders();
  let name = base, k = 2;
  while (all.has(parent ? parent + ' / ' + name : name)) name = `${base} ${k++}`;
  return name;
};
async function smSaveArrangement(sites, order) {
  const r = await API.sitesArrange(sites, order);
  state.sites = r.sites; state.siteFolderOrder = r.siteFolderOrder;
}
// Every folder (empty ones included) gets a place in the order list.
function fullOrder() {
  const order = (state.siteFolderOrder || []).slice();
  const known = [...allFolders()].sort((a, b) => folderCmp({ path: a, name: baseOf(a) }, { path: b, name: baseOf(b) }));
  for (const f of known) if (!order.includes(f)) order.push(f);
  return order;
}
async function smRelocateFolder(from, to) {
  const move = f => (inFolder(f, from) ? to + f.slice(from.length) : f);
  const sites = state.sites.map(s => ({ id: s.id, folder: move(s.folder || '') }));
  const order = fullOrder().map(move);
  const o = smOpen(), moved = [...o].map(move);
  o.clear(); moved.forEach(x => o.add(x));
  state.ui.sitesOpen = [...o]; API.saveUi({ sitesOpen: [...o] });
  if (sm.selFolder && inFolder(sm.selFolder, from)) sm.selFolder = move(sm.selFolder);
  await smSaveArrangement(sites, order);
}
async function smCommitRename() {
  const r = sm.renaming, inp = $('sm-ren');
  if (!r || !inp) return;
  const v = inp.value.replace(/\s*\/\s*/g, ' - ').trim();
  sm.renaming = null;
  try {
    if (!v) return;
    if (r.kind === 'site') {
      const s = state.sites.find(x => x.id === r.key);
      if (s && v !== s.name) {
        const res = await API.sitesSave(Object.assign({}, s, { name: v }), undefined, undefined);
        if (!res.ok) { toast(res.error, true); return; }
        state.sites = res.sites;
        if (sm.draft && sm.draft.id === s.id) { sm.draft.name = v; renderSiteForm(); }
      }
    } else if (v !== baseOf(r.key)) {
      const parent = parentOf(r.key), to = parent ? parent + ' / ' + v : v;
      if (allFolders().has(to)) { toast(`There is already a folder “${v}” there.`, true); return; }
      await smRelocateFolder(r.key, to);
    }
  } finally { renderSiteList(); }
}
async function smNewFolder(parent) {
  const name = freeFolderName(parent || '', 'New folder');
  const path = parent ? parent + ' / ' + name : name;
  const order = fullOrder(); order.push(path);
  await smSaveArrangement(state.sites.map(s => ({ id: s.id, folder: s.folder || '' })), order);
  if (parent) { smOpen().add(parent); state.ui.sitesOpen = [...smOpen()]; API.saveUi({ sitesOpen: state.ui.sitesOpen }); }
  sm.selFolder = path;
  sm.renaming = { kind: 'folder', key: path };
  renderSiteList();
}
async function smDuplicateFolder(path) {
  const parent = parentOf(path);
  const name = freeFolderName(parent, baseOf(path) + ' (copy)');
  const to = parent ? parent + ' / ' + name : name;
  state.sites = await API.sitesDuplicateFolder(path, to);
  const order = fullOrder().filter(f => !inFolder(f, to));
  const copies = order.filter(f => inFolder(f, path)).map(f => to + f.slice(path.length));
  const last = order.reduce((at, f, i) => (inFolder(f, path) ? i : at), -1);
  order.splice(last + 1, 0, ...copies);
  await smSaveArrangement(state.sites.map(s => ({ id: s.id, folder: s.folder || '' })), order);
  sm.selFolder = to;
  renderSiteList(); toast('Duplicated');
}
async function smDeleteFolder(path) {
  const n = state.sites.filter(s => inFolder(s.folder || '', path)).length;
  if (!(await confirmBox(`Delete the folder “${baseOf(path)}”?`, n ? `Its ${plural(n, 'site')} ${n === 1 ? 'goes' : 'go'} with it, and their remembered passwords too.` : 'It is empty.', 'DELETE', true))) return;
  state.sites = await API.sitesDeleteFolder(path);
  await smSaveArrangement(state.sites.map(s => ({ id: s.id, folder: s.folder || '' })), fullOrder().filter(f => !inFolder(f, path)));
  if (sm.selId && !state.sites.some(s => s.id === sm.selId)) selectSite(null);
  if (sm.selFolder && inFolder(sm.selFolder, path)) sm.selFolder = null;
  renderSiteList(); toast('Deleted');
}
async function smDeleteSite(id) {
  const s = state.sites.find(x => x.id === id); if (!s) return;
  if (!(await confirmBox(`Delete the site “${s.name}”?`, 'Its remembered password is deleted too.', 'DELETE', true))) return;
  state.sites = await API.sitesDelete(id);
  if (sm.selId === id) selectSite(null); else renderSiteList();
  toast('Deleted');
}
async function smDuplicateSite(id) {
  state.sites = await API.sitesDuplicate(id);
  renderSiteList(); toast('Duplicated');
}

// Folders among their siblings: the order the user dragged them into, then the
// ones never placed, A to Z.
function folderCmp(a, b) {
  const o = state.siteFolderOrder || [];
  const ia = o.indexOf(a.path), ib = o.indexOf(b.path);
  if (ia >= 0 && ib >= 0) return ia - ib;
  if (ia >= 0) return -1;
  if (ib >= 0) return 1;
  return a.name.localeCompare(b.name, undefined, { numeric: true });
}

// ── Arranging the sites by drag and drop ───────────────────────────────────
// A site dropped on the upper or lower half of another site goes before or
// after it, in that site's folder. A site dropped on a folder goes into it
// (at the end). A folder dropped on the upper or lower edge of another folder
// goes before or after it; on its middle, inside it. Anything dropped below
// the last row goes to the top level, at the end.
const parentOf = path => { const i = path.lastIndexOf(' / '); return i < 0 ? '' : path.slice(0, i); };
const baseOf = path => { const i = path.lastIndexOf(' / '); return i < 0 ? path : path.slice(i + 3); };
const inFolder = (folder, path) => folder === path || folder.startsWith(path + ' / ');

function smDropSpot(ev) {
  let el = ev.target.closest('.sm-item, .sm-folder, .sm-drop-end');
  // Anywhere else in the list (between rows, below them): the top level.
  if (!el && ev.target.closest('#sm-list')) el = document.querySelector('#sm-list .sm-drop-end');
  if (!el) return null;
  const r = el.getBoundingClientRect(), y = (ev.clientY - r.top) / r.height;
  if (el.classList.contains('sm-drop-end')) return { el, kind: 'end' };
  if (el.classList.contains('sm-item')) return { el, kind: y < 0.5 ? 'before' : 'after' };
  if (sm.drag && sm.drag.type === 'folder') return { el, kind: y < 0.28 ? 'before' : y > 0.72 ? 'after' : 'into' };
  return { el, kind: 'into' };
}
function smClearMarks() { document.querySelectorAll('#sm-list .drop-before, #sm-list .drop-after, #sm-list .drop-into, #sm-list .drop-root').forEach(e => e.classList.remove('drop-before', 'drop-after', 'drop-into', 'drop-root')); }

async function smApplyDrop(spot) {
  const d = sm.drag;
  if (!d || !spot) return;
  let sites = state.sites.map(s => ({ id: s.id, folder: s.folder || '' }));
  // Every folder (empty ones too) gets a place in the order list, so
  // "before / after" means something.
  const all = allFolders();
  let order = fullOrder();

  if (d.type === 'site') {
    const moving = sites.find(x => x.id === d.id);
    sites = sites.filter(x => x.id !== d.id);
    if (spot.kind === 'end') { moving.folder = ''; sites.push(moving); }
    else if (spot.el.classList.contains('sm-folder')) {
      moving.folder = spot.el.dataset.path;
      let at = -1;
      sites.forEach((x, i) => { if (x.folder === moving.folder) at = i; });
      sites.splice(at < 0 ? sites.length : at + 1, 0, moving);
    } else {
      const target = sites.findIndex(x => x.id === spot.el.dataset.id);
      if (target < 0) return;
      moving.folder = sites[target].folder;
      sites.splice(spot.kind === 'before' ? target : target + 1, 0, moving);
    }
  } else {
    const from = d.path;
    let parent, anchor = null;
    if (spot.kind === 'end') parent = '';
    else if (spot.el.classList.contains('sm-item')) parent = sites.find(x => x.id === spot.el.dataset.id).folder;
    else if (spot.kind === 'into') parent = spot.el.dataset.path;
    else { parent = parentOf(spot.el.dataset.path); anchor = spot.el.dataset.path; }
    if (anchor === from) return;
    if (inFolder(parent, from)) { toast('A folder cannot go inside itself.', true); return; }
    const to = parent ? parent + ' / ' + baseOf(from) : baseOf(from);
    if (to !== from && all.has(to)) { toast(`There is already a folder “${baseOf(from)}” there.`, true); return; }
    const move = f => (inFolder(f, from) ? to + f.slice(from.length) : f);
    sites.forEach(x => { x.folder = move(x.folder); });
    order = order.map(move);
    // Its place among its new siblings.
    order = order.filter(f => f !== to);
    if (anchor) {
      const ai = order.indexOf(move(anchor));
      order.splice(spot.kind === 'before' ? ai : ai + 1, 0, to);
    } else order.push(to);
    // Open folders follow their new path.
    const o = smOpen(), moved = [...o].map(move);
    o.clear(); moved.forEach(x => o.add(x)); if (parent) o.add(parent);
    state.ui.sitesOpen = [...o]; API.saveUi({ sitesOpen: [...o] });
  }
  const r = await API.sitesArrange(sites, order);
  state.sites = r.sites; state.siteFolderOrder = r.siteFolderOrder;
  // The site open in the form follows (its folder may have changed).
  if (sm.draft && sm.draft.id) { const cur = state.sites.find(x => x.id === sm.draft.id); if (cur) { sm.draft.folder = cur.folder; renderSiteForm(); } }
  renderSiteList();
}

function smFoldAll(openAll) {
  const o = smOpen();
  o.clear();
  if (openAll) for (const s of state.sites) {
    const parts = String(s.folder || '').split(' / ').map(x => x.trim()).filter(Boolean);
    parts.forEach((_, i) => o.add(parts.slice(0, i + 1).join(' / ')));
  }
  API.saveUi({ sitesOpen: [...o] });
  state.ui.sitesOpen = [...o];
  renderSiteList();
}

function selectSite(id, opts) {
  sm.selId = id;
  if (id) sm.selFolder = null;
  sm.pwAction = undefined; sm.ppAction = undefined;
  const s = id ? state.sites.find(x => x.id === id) : null;
  sm.draft = s ? Object.assign({}, s) : null;
  if (state.ui) state.ui.sitesSel = id || null;
  API.saveUi({ sitesSel: id || null });
  // Its folders are opened only when this site was asked for from elsewhere
  // (0.6.4: opening the window no longer unfolds anything on its own).
  if (s && s.folder && opts && opts.expand) {
    const parts = String(s.folder).split(' / ').map(x => x.trim()).filter(Boolean);
    const o = smOpen();
    let changed = false;
    parts.forEach((_, i) => { const p = parts.slice(0, i + 1).join(' / '); if (!o.has(p)) { o.add(p); changed = true; } });
    if (changed) { state.ui.sitesOpen = [...o]; API.saveUi({ sitesOpen: [...o] }); }
  }
  renderSiteList();
  renderSiteForm();
}

function newSite() {
  sm.selId = null;
  sm.pwAction = undefined; sm.ppAction = undefined;
  sm.draft = { id: null, name: 'New site', folder: '', protocol: 'sftp', host: '', port: 22, user: '', logon: 'normal', keyPath: '', remoteDir: '', localDir: '', comment: '', transferMode: 'passive', maxConnections: 0, hasPassword: false };
  renderSiteList();
  renderSiteForm();
  setTimeout(() => { const n = $('sf-name'); if (n) { n.focus(); n.select(); } }, 30);
}

function renderSiteForm() {
  const d = sm.draft;
  const f = $('sm-form');
  ['sm-save', 'sm-connect'].forEach(id => { $(id).disabled = !d; });
  if (!d) { f.innerHTML = `<div class="sm-empty">${I.server.replace('<svg', '<svg width="40" height="40"')}<div>Pick a site on the left, or create one.</div><button class="btn sm go" id="sm-new2">${I.plus} NEW SITE</button></div>`; $('sm-new2').onclick = newSite; return; }
  const isFtp = d.protocol !== 'sftp';
  const logons = isFtp ? [['normal', 'Password'], ['ask', 'Ask each time'], ['anonymous', 'Anonymous']] : [['normal', 'Password'], ['ask', 'Ask each time'], ['key', 'Key file']];
  const pwKept = d.hasPassword && sm.pwAction !== '';
  f.innerHTML = `
    <div class="frow"><div class="field" style="flex:2"><label>Name</label><input id="sf-name" value="${esc(d.name)}"></div>
      <div class="field"><label>Folder</label><input id="sf-folder" value="${esc(d.folder)}" placeholder="optional" list="sf-folders"><datalist id="sf-folders">${[...new Set(state.sites.map(s => s.folder).filter(Boolean))].map(x => `<option value="${esc(x)}">`).join('')}</datalist></div></div>
    <div class="field"><label>Protocol</label><div class="seg" id="sf-proto" style="align-self:flex-start">${['sftp', 'ftps', 'ftps-implicit', 'ftp'].map(p => `<button data-v="${p}" class="${d.protocol === p ? 'on' : ''}${p === 'ftp' ? ' warn' : ''}" data-tip="${esc(PROTO_INFO[p][2])}">${PROTO_INFO[p][0]}</button>`).join('')}</div>
      ${d.protocol === 'ftp' ? '<div class="hint" style="color:var(--orange)">Plain FTP: the password and the files travel in clear on the network.</div>' : ''}</div>
    <div class="frow"><div class="field" style="flex:3"><label>Host</label><input id="sf-host" value="${esc(d.host)}" placeholder="server.example.com" spellcheck="false"></div>
      <div class="field" style="flex:0 0 90px"><label>Port</label><input id="sf-port" value="${esc(d.port)}" inputmode="numeric"></div></div>
    <div class="field"><label>Login</label><div class="seg" id="sf-logon" style="align-self:flex-start">${logons.map(([v, l]) => `<button data-v="${v}" class="${d.logon === v ? 'on' : ''}">${l.toUpperCase()}</button>`).join('')}</div></div>
    ${d.logon !== 'anonymous' ? `<div class="frow"><div class="field"><label>User</label><input id="sf-user" value="${esc(d.user)}" spellcheck="false" autocomplete="off"></div>
      ${d.logon === 'normal' ? `<div class="field"><label>Password</label>${pwKept ? `<div class="pw-kept">${I.check.replace('<svg', '<svg width="13" height="13"')} Remembered in the keychain <button id="sf-pw-change">change</button><button id="sf-pw-forget">forget</button></div>` : `<input id="sf-pass" type="password" autocomplete="off" placeholder="${state.vault ? 'kept in the system keychain' : 'no keychain: asked each time'}">`}</div>` : '<div class="field"></div>'}</div>` : ''}
    ${d.logon === 'key' ? `<div class="field"><label>Private key</label><div class="inline"><input id="sf-key" value="${esc(d.keyPath)}" spellcheck="false" placeholder="~/.ssh/id_ed25519"><button class="btn sm" id="sf-key-pick">BROWSE</button></div>
      <div class="hint">Only the file's location is stored. A passphrase, if the key has one, is asked at the first connection.</div></div>` : ''}
    <div class="frow"><div class="field"><label>Server folder at login</label><input id="sf-rdir" value="${esc(d.remoteDir)}" placeholder="the login folder" spellcheck="false"></div>
      <div class="field"><label>Local folder at login</label><div class="inline"><input id="sf-ldir" value="${esc(d.localDir)}" placeholder="unchanged" spellcheck="false"><button class="btn sm" id="sf-ldir-pick">…</button></div></div></div>
    <div class="frow"><div class="field"><label>Maximum connections</label><input id="sf-maxc" type="number" min="0" max="10" value="${d.maxConnections || 0}"><div class="hint">0: the global setting decides (Auto by default).</div></div>
      ${isFtp ? `<div class="field"><label>FTP data connection</label><div class="seg" id="sf-tmode" style="align-self:flex-start"><button data-v="passive" class="${d.transferMode !== 'active' ? 'on' : ''}">PASSIVE</button><button data-v="active" class="${d.transferMode === 'active' ? 'on' : ''}">ACTIVE</button></div><div class="hint">Active only if the server requires it: it rarely works behind a router.</div></div>` : '<div class="field"></div>'}</div>
    <div class="field"><label>Notes</label><textarea id="sf-comment" placeholder="anything useful: who gave the access, until when…">${esc(d.comment)}</textarea></div>`;

  const bindVal = (id, key, fn) => { const el = $(id); if (el) el.addEventListener('input', () => { d[key] = fn ? fn(el.value) : el.value; if (key === 'name' || key === 'host' || key === 'user' || key === 'folder') renderSiteListLive(); }); };
  bindVal('sf-name', 'name'); bindVal('sf-folder', 'folder'); bindVal('sf-host', 'host'); bindVal('sf-port', 'port', v => parseInt(v, 10) || '');
  bindVal('sf-user', 'user'); bindVal('sf-key', 'keyPath'); bindVal('sf-rdir', 'remoteDir'); bindVal('sf-ldir', 'localDir'); bindVal('sf-comment', 'comment');
  bindVal('sf-maxc', 'maxConnections', v => Math.max(0, Math.min(10, parseInt(v, 10) || 0)));
  $('sf-host').addEventListener('paste', ev => {
    // A pasted sftp://user@host:port/path fills every field at once.
    const t = (ev.clipboardData || {}).getData ? ev.clipboardData.getData('text') : '';
    const m = /^(sftp|ftps|ftpes|ftp):\/\/(?:([^@/:]*)(?::[^@/]*)?@)?([^:/]+)(?::(\d+))?(\/.*)?$/i.exec(t.trim());
    if (!m) return;
    ev.preventDefault();
    const p = m[1].toLowerCase() === 'ftpes' ? 'ftps' : m[1].toLowerCase() === 'ftps' ? 'ftps-implicit' : m[1].toLowerCase();
    Object.assign(d, { protocol: p, host: m[3], port: m[4] ? Number(m[4]) : DEFAULT_PORT[p], user: m[2] ? decodeURIComponent(m[2]) : d.user, remoteDir: m[5] ? decodeURIComponent(m[5]) : d.remoteDir });
    renderSiteForm();
  });
  const pass = $('sf-pass');
  // The form is redrawn on every protocol / login change: a password being
  // typed is put back, not silently kept out of sight.
  if (pass && typeof sm.pwAction === 'string' && sm.pwAction) pass.value = sm.pwAction;
  if (pass) pass.addEventListener('input', () => { sm.pwAction = pass.value; });
  if ($('sf-pw-change')) $('sf-pw-change').onclick = () => { sm.pwAction = ''; d.hasPassword = false; renderSiteForm(); setTimeout(() => $('sf-pass') && $('sf-pass').focus(), 20); sm.pwAction = undefined; };
  if ($('sf-pw-forget')) $('sf-pw-forget').onclick = () => { sm.pwAction = ''; d.hasPassword = false; renderSiteForm(); sm.pwAction = ''; };
  $('sf-proto').addEventListener('click', ev => {
    const b = ev.target.closest('button'); if (!b) return;
    const p = b.dataset.v;
    if (Number(d.port) === DEFAULT_PORT[d.protocol] || !d.port) d.port = DEFAULT_PORT[p];
    d.protocol = p;
    if (p !== 'sftp' && d.logon === 'key') d.logon = 'normal';
    if (p === 'sftp' && d.logon === 'anonymous') d.logon = 'normal';
    renderSiteForm(); renderSiteListLive();
  });
  $('sf-logon').addEventListener('click', ev => { const b = ev.target.closest('button'); if (!b) return; d.logon = b.dataset.v; renderSiteForm(); });
  if ($('sf-tmode')) $('sf-tmode').addEventListener('click', ev => { const b = ev.target.closest('button'); if (!b) return; d.transferMode = b.dataset.v; renderSiteForm(); });
  if ($('sf-key-pick')) $('sf-key-pick').onclick = async () => { const p = await API.pickKey(); if (p) { d.keyPath = p; $('sf-key').value = p; } };
  $('sf-ldir-pick').onclick = async () => { const p = await API.pickFolder(d.localDir || panels.local.dir); if (p) { d.localDir = p; $('sf-ldir').value = p; } };
}

function renderSiteListLive() {
  const d = sm.draft;
  if (!d || !d.id) return;
  const i = state.sites.findIndex(s => s.id === d.id);
  if (i >= 0) { state.sites[i] = Object.assign({}, state.sites[i], { name: d.name, host: d.host, user: d.user, protocol: d.protocol }); renderSiteList(); }
}

async function saveSite() {
  const d = sm.draft;
  if (!d) return null;
  if (!String(d.host || '').trim()) { toast('A site needs a host.', true); $('sf-host') && $('sf-host').focus(); return null; }
  const site = { id: d.id, name: d.name, folder: d.folder, protocol: d.protocol, host: d.host, port: d.port, user: d.user, logon: d.logon, keyPath: d.keyPath, remoteDir: d.remoteDir, localDir: d.localDir, comment: d.comment, transferMode: d.transferMode, maxConnections: d.maxConnections };
  const r = await API.sitesSave(site, sm.pwAction === undefined ? undefined : sm.pwAction, undefined);
  if (!r.ok) { toast(r.error, true); return null; }
  if (r.warn) toast(r.warn, true);
  state.sites = r.sites;
  sm.selId = r.site.id;
  sm.draft = Object.assign({}, r.site);
  sm.pwAction = undefined;
  renderSiteList(); renderSiteForm();
  return r.site;
}

function bindSites() {
  $('q-sites').onclick = () => openSites();
  $('sm-close').onclick = closeSites;
  $('sm-new').onclick = newSite;
  $('sm-search').addEventListener('input', () => { sm.search = $('sm-search').value.trim(); renderSiteList(); });
  $('sm-list').addEventListener('click', ev => {
    if (ev.target.closest('.sm-ren')) return;
    const f = ev.target.closest('.sm-folder');
    if (f) { sm.selFolder = f.dataset.path; if (ev.altKey) smFoldAll(!f.classList.contains('open')); else smToggle(f.dataset.path); return; }
    const it = ev.target.closest('.sm-item'); if (!it) return;
    // Double-click = connect. Detected here: the first click redraws the list
    // (selection), so the browser's own dblclick never reaches a site row.
    const id = it.dataset.id, now = Date.now();
    if (sm.lastClick && sm.lastClick.id === id && now - sm.lastClick.t < 450) {
      sm.lastClick = null;
      closeSites();
      const s = state.sites.find(x => x.id === id);
      connectWith({ siteId: id }, s && s.name);
      return;
    }
    sm.lastClick = { id, t: now };
    selectSite(id);
  });
  const smList = $('sm-list');
  smList.addEventListener('dragstart', ev => {
    const el = ev.target.closest('.sm-item, .sm-folder');
    if (!el || sm.search) { ev.preventDefault(); return; }
    sm.drag = el.classList.contains('sm-item') ? { type: 'site', id: el.dataset.id } : { type: 'folder', path: el.dataset.path };
    ev.dataTransfer.effectAllowed = 'move';
    ev.dataTransfer.setData('text/plain', 'filo-site');
    el.classList.add('dragging');
  });
  smList.addEventListener('dragover', ev => {
    if (!sm.drag) return;
    const spot = smDropSpot(ev);
    smClearMarks();
    if (!spot) return;
    ev.preventDefault();
    ev.dataTransfer.dropEffect = 'move';
    spot.el.classList.add(spot.kind === 'into' ? 'drop-into' : spot.kind === 'end' ? 'drop-root' : 'drop-' + spot.kind);
  });
  smList.addEventListener('dragleave', ev => { if (!smList.contains(ev.relatedTarget)) smClearMarks(); });
  smList.addEventListener('drop', ev => {
    if (!sm.drag) return;
    ev.preventDefault();
    const spot = smDropSpot(ev);
    smClearMarks();
    smApplyDrop(spot).catch(e => toast(String(e && e.message || e), true)).finally(() => { sm.drag = null; });
  });
  smList.addEventListener('dragend', () => { smClearMarks(); sm.drag = null; document.querySelectorAll('#sm-list .dragging').forEach(e => e.classList.remove('dragging')); });
  // Right-click (Noar, 0.6.4): the empty space, a folder, a site.
  $('sm-list').addEventListener('contextmenu', ev => {
    ev.preventDefault();
    if (sm.search) return;
    const f = ev.target.closest('.sm-folder'), it = ev.target.closest('.sm-item');
    if (f) {
      const path = f.dataset.path, isOpen = smOpen().has(path);
      sm.selFolder = path; renderSiteList();
      return showMenu(ev.clientX, ev.clientY, [
        { label: 'Rename', icon: I.edit, action: () => { sm.renaming = { kind: 'folder', key: path }; renderSiteList(); } },
        { label: 'Expand', icon: I.folder, disabled: isOpen, action: () => { if (!smOpen().has(path)) smToggle(path); } },
        { label: 'Collapse', icon: I.folder, disabled: !isOpen, action: () => { if (smOpen().has(path)) smToggle(path); } },
        { label: 'Duplicate', icon: I.copy, action: () => smDuplicateFolder(path).catch(e => toast(e.message, true)) },
        'sep',
        { label: 'Delete…', icon: I.trash, danger: true, action: () => smDeleteFolder(path).catch(e => toast(e.message, true)) },
      ]);
    }
    if (it) {
      const id = it.dataset.id;
      if (sm.selId !== id) selectSite(id);
      return showMenu(ev.clientX, ev.clientY, [
        { label: 'Rename', icon: I.edit, action: () => { sm.renaming = { kind: 'site', key: id }; renderSiteList(); } },
        { label: 'Duplicate', icon: I.copy, action: () => smDuplicateSite(id).catch(e => toast(e.message, true)) },
        'sep',
        { label: 'Delete…', icon: I.trash, danger: true, action: () => smDeleteSite(id).catch(e => toast(e.message, true)) },
      ]);
    }
    showMenu(ev.clientX, ev.clientY, [
      { label: 'New site', icon: I.plus, action: newSite },
      { label: 'New folder', icon: I.folder, action: () => smNewFolder('').catch(e => toast(e.message, true)) },
    ]);
  });
  $('sm-new-folder').onclick = () => smNewFolder('').catch(e => toast(e.message, true));
  let scrollT = null;
  $('sm-list').addEventListener('scroll', () => { clearTimeout(scrollT); scrollT = setTimeout(() => { state.ui.sitesScroll = $('sm-list').scrollTop; API.saveUi({ sitesScroll: state.ui.sitesScroll }); }, 300); });
  $('sm-save').onclick = async () => { const s = await saveSite(); if (s) toast('Saved'); };
  $('sm-connect').onclick = async () => { const s = await saveSite(); if (!s) return; closeSites(); connectWith({ siteId: s.id }, s.name); };
  $('sm-import').onclick = importSites;
  $('sm-export').onclick = () => {
    const r = $('sm-export').getBoundingClientRect();
    const ids = null;
    showMenu(r.left, r.top - 120, [
      { head: 'Export without passwords' },
      { label: 'filo sites (.json)', icon: I.file, action: async () => { const x = await API.sitesExport('filo', ids); if (x.ok) toast(`Exported ${plural(x.count, 'site')}`); else if (!x.cancelled) toast(x.error, true); } },
      { label: 'FileZilla sitemanager (.xml)', icon: I.file, action: async () => { const x = await API.sitesExport('filezilla', ids); if (x.ok) toast(`Exported ${plural(x.count, 'site')}`); else if (!x.cancelled) toast(x.error, true); } },
    ]);
  };
}

async function importSites() {
  const choice = await dialog({
    title: 'Import sites',
    sub: 'From a filo export (.json) or FileZilla\'s <b>sitemanager.xml</b>.<br>' +
      (isMac() ? 'FileZilla keeps it in <code>~/.config/filezilla/</code>.' : 'FileZilla keeps it in <code>%APPDATA%\\FileZilla\\</code>.') +
      '<br><br>FileZilla stores passwords in clear (unless you set a master password). filo can put them into the system keychain.',
    buttons: [{ label: 'CANCEL', value: null }, { spacer: true }, { label: 'WITHOUT PASSWORDS', value: 'no' }, { label: 'WITH PASSWORDS', value: 'yes', cls: 'go' }],
    width: 560,
  });
  if (!choice) return;
  const r = await API.sitesImport(choice === 'yes');
  if (!r.ok) { if (!r.cancelled) errorBox('Import failed', r.error); return; }
  state.sites = r.sites;
  renderSiteList();
  let msg = `Imported ${plural(r.count, 'site')}`;
  if (r.withPasswords) msg += `, ${r.withPasswords} with a password`;
  if (r.lockedPasswords) msg += ` — ${r.lockedPasswords} password${r.lockedPasswords > 1 ? 's are' : ' is'} protected by FileZilla's master password and will be asked at the first connection`;
  toast(msg);
}

// ══ Synchronized browsing ═════════════════════════════════════════════════
// When on, opening a folder on one side opens the folder of the same name on
// the other side, and going up goes up on both. It follows what you do, step
// by step: it does not guess a match between two unrelated trees.
// What differs between the two sides, for one of them: name → 'o' (only on
// this side) or 'n' (newer on this side, or another size at the same date).
// Only the folders shown are compared, not their contents (FileZilla does the
// same). Null when synchronized browsing is off.
const DIFF_SLACK = 2000;
function sameStamp(a, b) {
  if (Math.abs(a - b) <= DIFF_SLACK) return true;
  // A listing that only gives minutes (FTP LIST): within the same minute.
  return (a % 60000 === 0 || b % 60000 === 0) && Math.abs(a - b) < 60000;
}
function diffWith(panel) {
  if (!state.sync || !state.conn || !panels.local || !panels.remote) return null;
  const other = panel.remote ? panels.local : panels.remote;
  if (!other.dir || other.dir === '::drives' || panel.dir === '::drives') return null;
  const them = new Map(other.entries.map(e => [e.name, e]));
  const out = new Map();
  for (const e of panel.entries) {
    const t = them.get(e.name);
    if (!t || isDirEntry(t) !== isDirEntry(e)) { out.set(e.name, 'o'); continue; }
    if (isDirEntry(e)) continue;
    const same = sameStamp(e.mtime || 0, t.mtime || 0);
    if (!same && (e.mtime || 0) > (t.mtime || 0)) out.set(e.name, 'n');
    else if (same && e.size !== t.size) out.set(e.name, 'n');
  }
  return out;
}
function refreshDiff() {
  document.body.classList.toggle('syncb', !!state.sync);
  for (const pn of [panels.local, panels.remote]) { if (!pn) continue; if (!state.sync) { pn.diffOnly = false; pn.el.querySelector('.p-dif').classList.remove('on'); } pn.compute(); pn.render(); }
}
function renderSync() {
  const b = $('q-sync');
  b.disabled = !state.conn;
  b.classList.toggle('on', !!state.sync);
  b.dataset.tip = !state.conn ? 'Synchronized browsing: connect first'
    : state.sync ? 'Synchronized browsing ON: opening a folder on one side opens the folder of the same name on the other side. Click to turn off.'
    : 'Synchronized browsing: open the matching folders on both sides, then turn this on. From then on, both sides move together.';
}
function syncToggle() {
  if (!state.conn) return;
  if (state.sync) return syncOff();
  if (panels.local.dir === '::drives' || !panels.local.dir || !panels.remote.dir) { toast('Open a folder on both sides first.', true); return; }
  state.sync = true;
  renderSync();
  refreshDiff();
  toast(`Synchronized browsing on: ${localBase(panels.local.dir) || panels.local.dir} ⇄ ${posixBase(panels.remote.dir) || '/'}`);
}
function syncOff(why) {
  if (!state.sync) return;
  state.sync = false;
  renderSync();
  refreshDiff();
  if (why) toast(`Synchronized browsing turned off: ${why}.`);
}
async function syncFollow(src, move) {
  if (!state.sync || !state.conn) return;
  const other = src.remote ? panels.local : panels.remote;
  if (move.up) {
    if (other.parent == null) { syncOff(`${other.remote ? 'the server' : 'this computer'} has no parent folder here`); return; }
    const ok = await other.load(other.parent, { quiet: true });
    if (!ok) syncOff('the other side could not follow');
    return;
  }
  const target = other.join(move.into);
  const ok = await other.load(target, { quiet: true });
  if (!ok) syncOff(`“${move.into}” does not exist ${other.remote ? 'on the server' : 'on this computer'}`);
}

// ══ Queue view ═════════════════════════════════════════════════════════════
const QROW = 64;
const q = { items: [], offset: 0, total: 0, byId: new Map(), fetchTimer: null, rowEls: [], anchor: -1 };
const BROOM = SVG('<path d="m13 11 9-9"/><path d="M14.6 12.6c.8.8.9 2.1.2 3L10 21l-7-7 5.4-4.8c.9-.7 2.2-.6 3 .2Z"/><path d="m6.8 10.4 6.8 6.8"/><path d="m5 17-1.5 1.5"/>');

function setQTab(tab) {
  state.qtab = tab;
  document.querySelectorAll('#q-tabs button[data-tab]').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
  const log = tab === 'log';
  $('q-log').style.display = log ? '' : 'none';
  $('q-spacer').style.display = log ? 'none' : '';
  // CLEAR is a broom; in the LOG tab the same button copies the log.
  $('q-clear').innerHTML = log ? I.copy : BROOM;
  $('q-clear').dataset.tip = log ? 'Copy the log' : 'Clear this list';
  $('q-clear').setAttribute('aria-label', log ? 'Copy the log' : 'Clear');
  $('q-retry').style.display = tab === 'failed' && ((state.qcounts.failed || 0) + (state.qcounts.stopped || 0)) ? '' : 'none';
  state.qsel.clear();
  q.anchor = -1;
  renderQueueHead();
  $('q-list').scrollTop = log ? $('q-list').scrollHeight : 0;
  if (log) renderLog(true); else fetchQueue(true);
}

function fetchQueue(now) {
  if (state.qtab === 'log') return;
  clearTimeout(q.fetchTimer);
  q.fetchTimer = setTimeout(async () => {
    const list = $('q-list');
    const first = Math.max(0, Math.floor(list.scrollTop / QROW) - 20);
    const tab = state.qtab, req = (q.req = (q.req || 0) + 1);
    const res = await API.queuePage(tab, first, Math.ceil(list.clientHeight / QROW) + 60);
    if (req !== q.req || tab !== state.qtab) return;      // an older answer, or another tab
    q.items = res.items; q.offset = first; q.total = res.total;
    q.byId = new Map(res.items.map(it => [it.id, it]));
    renderQueue();
  }, now ? 0 : 200);
}

const VLABEL = { xxh64: 'xxHash64', sha256: 'SHA-256', sha1: 'SHA-1', md5: 'MD5', crc32: 'CRC32' };
const CHK = () => I.check.replace('<svg', '<svg width="10" height="10"');
function statusOf(it) {
  if (it.status === 'running') {
    if (it.phase === 'verify') return '<span class="badge b">Verifying</span>';
    if (it.phase === 'connect') return '<span class="badge n">Connecting</span>';
    return it.dir === 'up' ? '<span class="badge g">Uploading</span>' : '<span class="badge g">Downloading</span>';
  }
  if (it.status === 'asking') return '<span class="badge o">Your call</span>';
  if (it.status === 'waiting') return `<span class="badge o" data-tip="${esc(it.error)}">Retry in ${Math.max(0, Math.round((it.retryAt - Date.now()) / 1000))} s</span>`;
  if (it.status === 'queued') return it.offset ? '<span class="badge n">To resume</span>' : '<span class="badge n">Queued</span>';
  if (it.status === 'paused') return '<span class="badge o">Paused</span>';
  if (it.status === 'stopped') return '<span class="badge r">Stopped</span>';
  if (it.status === 'failed') return '<span class="badge r">Failed</span>';
  if (it.status === 'skipped') return `<span class="badge n">${esc(it.note || 'Skipped')}</span>`;
  if (it.status === 'done') {
    if (it.type === 'folder') return '<span class="badge g">Created</span>';
    const v = it.verify;
    if (v && v.level === 'server') return `<span class="badge g" data-tip="Checksum computed by the server (${VLABEL[v.algo]}) = checksum of the local file">${VLABEL[v.algo]} ${CHK()}</span>`;
    if (v && v.level === 'readback') return `<span class="badge g" data-tip="The file was read back from the server and compared (xxHash64)">Read back ${CHK()}</span>`;
    if (v && v.level === 'received') return `<span class="badge g" data-tip="The copy on disk was read back and matches what was received, byte for byte (xxHash64)">Verified ${CHK()}</span>`;
    if (v && v.level === 'relay') return `<span class="badge g" data-tip="Relayed: each segment matches the sender's own file (xxHash64)">Verified ${CHK()}</span>`;
    return '<span class="badge n" data-tip="Only the size was checked">Size OK</span>';
  }
  return '';
}

// 0..100, or null when a percentage means nothing (a folder).
function pctOf(it) {
  if (it.type === 'folder') return it.status === 'done' ? 100 : null;
  if (it.status === 'done' || it.status === 'skipped') return 100;
  if (!it.size) return 0;
  // Not rounded: the bar and the rings move with every byte, not by whole
  // percents (a 300 GB file is 3 GB per percent).
  if (it.status === 'running' && it.phase === 'verify') return Math.min(100, (it.vdone / it.size) * 100);
  const d = it.status === 'running' ? it.done : (it.offset || it.done || 0);
  return Math.min(100, (d / it.size) * 100);
}
// Whole percents in the text (the bars and rings carry the precision);
// never "100%" before the end.
function fmtPct(p) { if (p == null) return ''; if (p >= 100) return '100%'; return Math.floor(p) + '%'; }
// Bar / ring color.
function toneOf(it) {
  if (it.status === 'running' && it.phase === 'verify') return 'v';
  if (it.status === 'failed' || it.status === 'stopped') return 'r';
  if (it.status === 'paused' || it.status === 'waiting' || it.status === 'asking') return 'o';
  return '';
}
// Which of the three row buttons apply.
function actsOf(it) {
  const s = it.status;
  return {
    pause: s === 'queued' || s === 'waiting' || s === 'running',
    resume: s === 'paused',
    stop: s === 'queued' || s === 'waiting' || s === 'running' || s === 'paused',
    retry: s === 'failed' || s === 'stopped' || s === 'skipped',
  };
}
// ── Piece bar (a file sent in segments) ─────────────────────────────────────
// filo's own thin bar, drawn the way qBittorrent draws a torrent's pieces:
// every segment at its place in the file, each filled as far as it is in
// place. Green: done and verified · bright green: on its way · pale green:
// kept after a cut · orange: waiting to be tried again · empty: to do. One
// canvas, so a 300 GB file shows all its ~1,200 segments, each a pixel or so.
const SEG_TIP = 'Files of 64 MB and more travel in segments (about 16 per file, 32 to 256 MB each), several at once over separate connections, each drawn at its place in the file. Green: done and verified · bright green: on its way · pale green: kept after a cut · orange: waiting to be tried again · empty: to do.';
function segBarHtml() {
  return `<div class="qbar pieces" data-tip="${esc(SEG_TIP)}"><canvas></canvas></div>`;
}
let segColors = null;
function patchSegBar(r, cells) {
  const cv = r._canvas;
  if (!cv) return;
  const w = Math.max(1, Math.round(cv.clientWidth * devicePixelRatio)), h = Math.max(1, Math.round(cv.clientHeight * devicePixelRatio));
  const sig = cells.st + cells.f + w;
  if (cv._sig === sig) return;
  cv._sig = sig;
  if (cv.width !== w) cv.width = w;
  if (cv.height !== h) cv.height = h;
  if (!segColors) {
    const css = getComputedStyle(document.documentElement);
    const g = css.getPropertyValue('--green').trim() || '#35c98b', o = css.getPropertyValue('--orange').trim() || '#f2a03d';
    segColors = { done: g, run: g, kept: 'rgba(53,201,139,.45)', runTrack: 'rgba(53,201,139,.16)', wait: o };
  }
  const ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, w, h);
  const size = cells.size || 1, seg = cells.segSize || size;
  const X = b => (b / size) * w;
  for (let i = 0; i < cells.n; i++) {
    const s0 = i * seg, s1 = Math.min(size, s0 + seg);
    const x0 = X(s0), x1 = X(s1);
    const k = cells.st[i], frac = (cells.f.charCodeAt(i) - 48) / 100;
    if (k === 'd') { ctx.fillStyle = segColors.done; ctx.fillRect(x0, 0, x1 - x0, h); continue; }
    if (k === 'r') { ctx.fillStyle = segColors.runTrack; ctx.fillRect(x0, 0, x1 - x0, h); }
    if (frac > 0) {
      ctx.fillStyle = k === 'r' ? segColors.run : k === 'w' ? segColors.wait : segColors.kept;
      // at least one pixel, so a segment that has just started can be seen
      ctx.fillRect(x0, 0, Math.max(1, (x1 - x0) * frac), h);
    } else if (k === 'w') { ctx.fillStyle = segColors.wait; ctx.fillRect(x0, 0, Math.max(1, Math.min(2, x1 - x0)), h); }
  }
}

// The line under the bar: where from (left), how it goes (right) — or the error.
// When it happened (Noar, 11/10/2026): queued at, started at, finished at,
// and how long the transfer took. The duration counts from the last start
// of the file (after a pause or a retry: that last pass), to its end.
function timesOf(it) {
  if (it.type !== 'file') return '';
  const st = it.startedAt, fin = it.finishedAt && it.finishedAt >= (st || 0) ? it.finishedAt : 0;
  if (fin && st) {
    const sec = (fin - st) / 1000;
    const avg = it.status === 'done' && sec > 0 && it.size ? ' · ' + fmtSpeed(it.size / sec) : '';
    return `${fmtClock(st)} → ${fmtClock(fin)} · ${fmtDur(sec)}${avg}`;
  }
  if (st) return `started ${fmtClock(st)}`;
  return it.addedAt ? `queued ${fmtClock(it.addedAt)}` : '';
}
function subOf(it, from) {
  const tm = timesOf(it);
  const tmHtml = tm ? `<span class="tm">${esc(tm)}</span>` : '';
  if (it.status === 'failed' || it.status === 'stopped') return `<span class="l err" data-tip="${esc(it.error)}">${esc(it.error || 'Stopped')}</span>${tmHtml}`;
  if (it.status === 'waiting') return `<span class="l err o" data-tip="${esc(it.error)}">${esc(it.error)}</span>${tmHtml}`;
  let right = '';
  if (it.status === 'running' && it.type === 'file') {
    if (it.phase === 'verify') right = it.segs ? 'checking the whole file…' : 'checking…';
    else {
      // Transferred / total, speed, time elapsed, time left (Noar, 11/10/2026).
      const left = it.speed > 0 ? fmtDur((it.size - it.done) / it.speed) : '—';
      const el = it.startedAt ? fmtDur((Date.now() - it.startedAt) / 1000) : '—';
      right = `${fmtSize(it.done)} / ${fmtSize(it.size)} · ${fmtSpeed(it.speed)} · ${el} elapsed · ${left} left`;
    }
  } else if ((it.status === 'queued' || it.status === 'paused') && it.offset) right = `${fmtSize(it.offset)} already there`;
  // Segments on their way at once: the number alone, the details in the tooltip.
  const par = it.status === 'running' && it.segs && it.phase !== 'verify' ? `<span class="par" data-tip="${it.segs.running} transfers at once (${it.segs.done} of ${it.segs.total} segments done)">${it.segs.running}</span>` : '';
  return `<span class="l" data-tip="${esc(from)}">${esc(from)}</span>${right ? `<span class="r">${par}${right}</span>` : ''}${tmHtml}`;
}

function renderQueue() {
  if (state.qtab === 'log') return;
  const list = $('q-list'), spacer = $('q-spacer');
  spacer.style.height = q.total * QROW + 'px';
  const top = list.scrollTop, h = list.clientHeight || 200;
  const first = Math.max(0, Math.floor(top / QROW) - 4);
  const last = Math.min(q.total, Math.ceil((top + h) / QROW) + 4);
  // Out of the fetched window: ask for the right page.
  if (q.total && (first < q.offset || last > q.offset + q.items.length) && q.items.length < q.total) fetchQueue();
  const need = Math.max(0, last - first);
  while (q.rowEls.length < need) { const r = document.createElement('div'); r.className = 'qrow'; spacer.appendChild(r); q.rowEls.push(r); }
  while (q.rowEls.length > need) q.rowEls.pop().remove();
  for (let k = 0; k < need; k++) {
    const i = first + k, r = q.rowEls[k];
    const it = q.items[i - q.offset];
    r.style.top = i * QROW + 'px';
    if (!it) { r.innerHTML = ''; r._skey = ''; r._pc = null; r.style.visibility = 'hidden'; continue; }
    r.style.visibility = '';
    r.dataset.id = it.id;
    const sel = state.qsel.has(it.id);
    const wait = it.status === 'waiting' ? Math.max(0, Math.round((it.retryAt - Date.now()) / 1000)) : '';
    const pct = pctOf(it), tone = toneOf(it), a = actsOf(it);
    // Two levels. The row's structure (status, buttons…) is rebuilt only when
    // it changes; the moving figures (%, bar, speed) are patched in place.
    // Rebuilding the whole row at every progress tick replaced the buttons
    // under the pointer between press and release, so a click on STOP or
    // PAUSE of a running file never happened.
    // The piece bar while segments travel; the plain bar otherwise (and in
    // blue while the whole file is checked at the end).
    const cells = it.segs && it.segs.cells && it.status !== 'done' && it.status !== 'skipped' && it.phase !== 'verify' ? it.segs.cells : null;
    const skey = `${it.id}|${it.status}|${it.phase}|${sel}|${wait}|${it.error}|${tone}|${a.pause}${a.resume}${a.stop}${a.retry}|${it.offset ? 1 : 0}|${cells ? cells.n : 0}`;
    const up = it.dir === 'up';
    const from = up ? localDir(it.local) : (it.endpointLabel ? it.endpointLabel + ' · ' : '') + posixDir(it.remote);
    const pcText = it.status === 'done' || it.status === 'skipped' ? (pct == null ? '' : '100%') : fmtPct(pct);
    const subHtml = subOf(it, from);
    if (r._skey === skey && r._pc) {
      if (r._pc.textContent !== pcText) r._pc.textContent = pcText;
      const w = (pct || 0).toFixed(2) + '%';
      if (r._bar.style.width !== w) r._bar.style.width = w;
      if (r._subHtml !== subHtml) { r._sub.innerHTML = subHtml; r._subHtml = subHtml; }
      if (cells) patchSegBar(r, cells);
      continue;
    }
    r._skey = skey;
    r.className = 'qrow' + (sel ? ' sel' : '') + (it.status === 'skipped' ? ' dim' : '');
    const name = up ? posixBase(it.remote) : localBase(it.local);
    const to = up ? posixDir(it.remote) : localDir(it.local);
    const meta = [it.type === 'folder' ? 'folder' : fmtSize(it.size), '→ ' + tail(to, 60)].join(' · ');
    r.innerHTML = `<div class="qr-top"><span class="pc">${pcText}</span>
        <span class="nm" data-tip="${esc(name)}">${esc(name)}</span>
        <span class="meta" data-tip="${esc((up ? it.endpointLabel + ' · ' : '') + to)}">${esc(meta)}</span>
        <span class="st">${statusOf(it)}</span>
        <span class="qacts">
          ${a.resume ? `<button class="qact" data-a="resume" aria-label="Resume" data-tip="Resume">${I.play}</button>` : `<button class="qact" data-a="pause" aria-label="Pause" data-tip="Pause this file: it stops where it is and resumes from there" ${a.pause ? '' : 'disabled'}>${I.pause}</button>`}
          <button class="qact stp" data-a="stop" aria-label="Stop" data-tip="Stop this file: it goes to Failed, its partial file is kept for a retry" ${a.stop ? '' : 'disabled'}>${I.stop}</button>
          <button class="qact rt" data-a="retry" aria-label="Retry" data-tip="Retry" ${a.retry ? '' : 'disabled'}>${I.retry}</button>
        </span></div>
      ${cells ? segBarHtml() : `<div class="qbar"><i class="${tone}${(it.status === 'queued' || it.status === 'paused') && it.offset ? ' p' : ''}" style="width:${(pct || 0).toFixed(2)}%"></i></div>`}
      <div class="qr-sub">${subHtml}</div>`;
    r._pc = r.querySelector('.pc'); r._bar = r.querySelector('.qbar i') || document.createElement('i'); r._sub = r.querySelector('.qr-sub'); r._subHtml = subHtml;
    r._canvas = cells ? r.querySelector('.qbar.pieces canvas') : null;
    if (cells) patchSegBar(r, cells);
  }
  // "Retry in N s" counts down by itself.
  const waiting = q.items.some(it => it.status === 'waiting');
  if (waiting && !q.waitTimer) q.waitTimer = setInterval(renderQueue, 1000);
  else if (!waiting && q.waitTimer) { clearInterval(q.waitTimer); q.waitTimer = null; }
  const empty = !q.total;
  let em = list.querySelector('.q-empty');
  if (empty && !em) { em = document.createElement('div'); em.className = 'q-empty'; list.appendChild(em); }
  if (em) {
    if (!empty) em.remove();
    else em.textContent = state.qtab === 'failed' ? 'No failed transfer.' : state.qtab === 'done' ? 'Finished transfers will be listed here.' : 'Drag files from one side to the other, or use UPLOAD / DOWNLOAD, to transfer them.';
  }
}

// Retry: a file that had already started is either continued from where it
// stopped, or started again from zero. Asked once for the whole selection.
// ids empty = every failed or stopped file.
async function retryItems(ids) {
  let its;
  if (ids.length) its = ids.map(id => q.byId.get(id)).filter(Boolean);
  else its = (await API.queuePage('failed', 0, 100000)).items;
  const started = its.filter(isStarted).map(resumeEntry);
  let mode = 'resume', extra = [];
  if (started.length) {
    const r = await askResume(started);
    if (!r) return;
    mode = r.mode; extra = r.extra;
  }
  API.queueRetry(ids.length ? [...ids, ...extra] : ids, mode);
}

function isStarted(it) { return it.type === 'file' && ((it.done || 0) > 0 || (it.offset || 0) > 0); }
function resumeEntry(it) { return { id: it.id, bytes: Math.max(it.done || 0, it.offset || 0), name: it.dir === 'up' ? posixBase(it.remote) : localBase(it.local) }; }

// "This file only / the whole queue", as FileZilla offers it. Shared by the
// resume question and the "already there" question.
function scopeHtml(allLabel) {
  return `<div class="scope"><span class="h">Apply to</span>
    <label><input type="radio" name="scope" value="one" checked> This file only</label>
    <label><input type="radio" name="scope" value="all"> ${esc(allLabel)}</label></div>`;
}
function scopeAll(card) { const r = card.querySelector('input[name=scope]:checked'); return !!r && r.value === 'all'; }

// list: [{ id, bytes, name }] → { mode: 'resume' | 'restart', extra: [ids] } | null (cancel)
// extra: the other stopped files of the queue that also had a partial copy,
// when the user chose to apply the answer to the whole queue.
async function askResume(list) {
  const mine = new Set(list.map(x => x.id));
  let others = [];
  try { others = (await API.queuePage('failed', 0, 100000)).items.filter(it => isStarted(it) && !mine.has(it.id)); } catch (_) {}
  const bytes = list.reduce((a, x) => a + (x.bytes || 0), 0);
  const one = list.length === 1 ? list[0] : null;
  const pick = mode => c => ({ mode, extra: others.length && scopeAll(c) ? others.map(it => it.id) : [] });
  return dialog({
    title: 'Resume or start again?',
    sub: one ? `<b>${esc(one.name)}</b> had already transferred ${fmtSize(bytes)}.`
      : `${plural(list.length, 'file')} had already transferred ${fmtSize(bytes)} in all.`,
    html: '<div class="m-sub" style="margin:0">Resume continues from where it stopped. Start again sends the whole file once more and replaces the partial copy.</div>'
      + (others.length ? scopeHtml(`The whole queue (${plural(others.length, 'other stopped file')} too)`).replace('This file only', one ? 'This file only' : 'These files only') : ''),
    buttons: [{ label: 'CANCEL', value: null }, { spacer: true }, { label: 'START AGAIN', value: pick('restart') }, { label: 'RESUME', value: pick('resume'), cls: 'go' }],
  });
}

// Removing a file that is not finished deletes its partial file: said first.
async function removeItems(ids) {
  if (!ids.length) return;
  const unfinished = ids.map(id => q.byId.get(id)).filter(it => !it || (it.type === 'file' && it.status !== 'done' && it.status !== 'skipped')).length;
  if (unfinished && !(await confirmBox(`Remove ${plural(ids.length, 'item')} from the queue?`, 'Unfinished files stop, and their partial files are deleted.', 'REMOVE', true))) return;
  API.queueRemove(ids);
  state.qsel.clear();
}

// Row buttons and the right-click menu share these.
// After a stop or a pause, the destination shows what is really there now
// (the partial file): a download refreshes the local side, an upload the
// server side. A moment later, once the transfers have let go.
function refreshAfterStop(dirs) {
  setTimeout(() => {
    if (dirs.has('down')) panels.local.load(panels.local.dir, { keepSel: true });
    if (dirs.has('up') && state.conn && !panels.remote.inFlight) { panels.remote.cache.delete(panels.remote.dir); panels.remote.load(panels.remote.dir, { keepSel: true }); }
  }, 900);
}

function itemAction(act, ids) {
  if (!ids.length) return;
  if (act === 'stop' || act === 'pause') refreshAfterStop(new Set(ids.map(id => (q.byId.get(id) || {}).dir).filter(Boolean)));
  if (act === 'pause') API.itemPause(ids);
  if (act === 'resume') API.itemResume(ids);
  if (act === 'stop') API.itemStop(ids);
  if (act === 'retry') retryItems(ids);
}

// Live values of the running items, without asking for a page again.
function patchActive(active) {
  let touched = false;
  for (const a of active) {
    const it = q.byId.get(a.id);
    if (it) { Object.assign(it, a); touched = true; }
  }
  if (touched) renderQueue();
}

const QUEUE_COLORS = {
  client: { c: 'var(--green)', fill: 'var(--green)', glow: 'rgba(53,201,139,.28)' },
  server: { c: 'var(--violet)', fill: 'var(--violet)', glow: 'rgba(168,128,255,.28)' },
  hybrid: { c: 'var(--hybrid)', fill: 'linear-gradient(90deg,var(--blue),var(--violet))', glow: 'rgba(143,140,251,.28)' },
  direct: { c: 'var(--blue)', fill: 'var(--blue)', glow: 'rgba(77,144,240,.28)' },
};
// What the queue is moving: the FTP client, or a LIVE SYNC session (its
// copies are labelled "Sync · name").
function queueMode(p) {
  const its = (p && p.active) || [];
  for (const a of its) {
    const m = /^Sync · (.*)$/.exec(a.endpointLabel || '');
    const pair = m && sy.pairs.find(x => x.name === m[1]);
    if (pair) return pair.via;
  }
  return 'client';
}
const FINISHED_MS = 5000;           // how long FINISHED stays before IDLE
function renderQueueHead() {
  const p = state.progress;
  const c = state.qcounts || {};
  const running = state.qstate === 'running';
  const pending = (c.queued || 0) + (c.waiting || 0) + (c.running || 0) + (c.asking || 0);
  const paused = c.paused || 0;
  const box = $('queue');
  const verifying = running && p && p.active.length && p.active.every(a => a.phase === 'verify');
  box.classList.toggle('live', running || (!!pending && !!(p && p.run && p.run.bytes)));
  box.classList.toggle('paused', !running);
  // The queue takes the colour of what it moves (Noar, 12/10/2026): the FTP
  // client green, a LIVE SYNC session the colour of its mode (S-FTP violet,
  // DUAL SYNC blue to violet). Checking a file is no longer blue (LIVE SYNC's).
  const QC = QUEUE_COLORS[queueMode(p)];
  box.style.setProperty('--q-color', QC.c);
  box.style.setProperty('--q-fill', QC.fill);
  box.style.setProperty('--q-glow', QC.glow);
  let title = 'QUEUE';
  if (running) title = verifying ? 'VERIFYING' : (p && p.active.some(a => a.phase === 'connect') && !p.active.some(a => a.phase === 'transfer')) ? 'CONNECTING' : 'TRANSFERRING';
  else if (pending || paused) title = state.qRan ? 'PAUSED' : 'QUEUE';   // added "do not start": never ran
  else if (c.done || c.failed || c.stopped) title = c.failed || c.stopped ? 'FINISHED · WITH ERRORS' : 'FINISHED';
  // FINISHED for a few seconds, then IDLE with an empty bar (Noar, 0.7.0).
  // With errors, it stays said: the FAILED tab has something to look at.
  if (title === 'FINISHED') {
    if (!state.qFinAt) { state.qFinAt = Date.now(); clearTimeout(state.qFinT); state.qFinT = setTimeout(renderQueueHead, FINISHED_MS + 50); }
    if (Date.now() - state.qFinAt >= FINISHED_MS) title = 'IDLE';
  } else state.qFinAt = 0;
  const idle = title === 'IDLE';
  $('q-title').textContent = title;
  const runBytes = p && p.run ? p.run.bytes : 0;
  const left = c.bytesLeft || 0;
  const pct = running || pending || paused ? (runBytes + left > 0 ? (runBytes / (runBytes + left)) * 100 : 0) : (c.done && !idle ? 100 : 0);
  $('q-prog').style.width = (running || pending || paused || (c.done && !idle) ? Math.min(100, pct) : 0).toFixed(2) + '%';
  $('q-prog-box').classList.toggle('idle', !(running || pending || paused || (c.done && !idle)));

  // Time left (big: the figure that matters most) and time elapsed, under
  // the title (Noar, 11/10/2026). Left = what remains ÷ the speed of the last
  // 10 seconds: the instant speed made it jump at every tick.
  const startedAt = p && p.run && p.run.startedAt;
  if ((running || state.qstate === 'paused') && startedAt && (pending || paused)) {
    // The whole queue's percentage, big (Noar, 12/10/2026); the time left
    // is a badge with the others.
    $('q-times').innerHTML = `<span class="left" data-tip="Progress of the whole queue">${esc(fmtPct(pct))}</span>`
      + `<span class="el" data-tip="Time since this run started">${esc(fmtDur((Date.now() - startedAt) / 1000))}<small>ELAPSED</small></span>`;
  } else $('q-times').innerHTML = '';

  // The figures, as badges in the tab bar.
  const st = [];
  const B = (label, v, cls, tip) => st.push(`<span class="q-stat ${cls || ''}"${tip ? ` data-tip="${esc(tip)}"` : ''}>${label} <span class="n">${v}</span></span>`);
  if (running) B('Speed', fmtSpeed(p ? p.speed : 0), 'g', 'Total speed of every transfer together');
  if (running && spark.length) B('Peak', fmtSpeed(Math.max(...spark.map(x => x.v))), '', 'Fastest speed of the last minute');
  if (running && (pending || paused) && startedAt) { const sp2 = avgSpark(20) || (p ? p.speed : 0); if (sp2 > 0) B('Time left', esc(fmtDur(left / sp2)), '', 'Time left for the whole queue, at the speed of the last 10 seconds'); }
  if (pending || paused) B('Left', fmtSize(left), '', 'Data still to transfer');
  if (state.qSched && !running) B('Starts', fmtClock(state.qSched), 'o', 'Scheduled start. Right-click START to change or cancel it; START starts now.');
  $('q-stats').innerHTML = st.join('');

  // Simultaneous transfers: a plain label and a plain value.
  const auto = p && p.auto;
  const isAuto = state.settings.concurrency === 'auto';
  const now = running && p ? (isAuto && auto ? auto.level : p.units) : null;
  $('q-conn-v').textContent = isAuto ? (now ? `AUTO · ${now}` : 'AUTO') : String(state.settings.concurrency);
  $('q-conn').dataset.tip = isAuto
    ? `How many files go at the same time, each on its own connection. AUTO: filo adds connections while the speed goes up, and keeps the fastest number${now ? ` (${now} right now${auto && auto.note ? ', ' + auto.note : ''})` : ''}. Click to choose.`
    : `How many files go at the same time, each on its own connection: ${state.settings.concurrency}. Click to choose, or to let filo find the fastest (AUTO).`;

  // Whole queue: play / pause, and stop.
  const b = $('q-start');
  const canStart = !!pending || !!paused;
  b.className = 'btn sq' + (running ? '' : ' go');
  b.innerHTML = running ? I.pause : I.play;
  // Never truly disabled: a right-click on it schedules the start, also
  // before any file is in the queue.
  b.disabled = false;
  b.classList.toggle('dis', !running && !canStart);
  b.setAttribute('aria-label', running ? 'Pause' : 'Start');
  b.dataset.tip = running ? 'Pause the whole queue: running files stop, and resume from where they were'
    : pending ? (runBytes || c.done ? 'Resume the whole queue' : 'Start the queue') + ' (right-click: start at a time)'
    : paused ? 'Resume the files you paused' : 'Nothing to transfer (right-click: start at a time)';
  $('q-stop').disabled = !running && !pending && !paused;

  $('n-queue').textContent = pending + paused;
  const failed = (c.failed || 0) + (c.stopped || 0);
  $('n-failed').textContent = failed; $('n-done').textContent = (c.done || 0) + (c.skipped || 0);
  $('n-failed').classList.toggle('r', !!failed);
  $('q-retry').style.display = state.qtab === 'failed' && failed ? '' : 'none';
  const inTab = { queue: pending + paused, failed, done: (c.done || 0) + (c.skipped || 0) }[state.qtab];
  $('q-clear').disabled = state.qtab !== 'log' && !inTab;
}

// Play, from the button or the menu: start the queue; when only files paused
// one by one are left, resume them.
// ── Check against the other side ──────────────────────────────────────────
// The selected names, here and in the folder open on the other side: the
// server computes its checksum, filo the local one; nothing is transferred.
async function checkAgainst(names) {
  const req = { localRoot: panels.local.dir, remoteRoot: panels.remote.dir, names };
  state.comparing = true;
  let last = 0;
  const off = API.on('compare-progress', p => { if (Date.now() - last > 600) { last = Date.now(); toast(`Checking ${p.i} / ${p.n}: ${p.rel.split('/').pop()}`); } });
  try {
    toast('Checking: listing both sides…');
    let r = await API.compare(req);
    if (r.ok && r.needsReadBack) {
      const go = await confirmBox('This server cannot compute checksums',
        `To check ${plural(r.files, 'file')} (${fmtSize(r.bytes)}), filo has to read them back from the server: a download of everything, nothing written on your disk.`, 'READ THEM BACK');
      if (!go) return;
      r = await API.compare(Object.assign({ readBack: true }, req));
    }
    if (!r.ok) return errorBox('Not checked', r.error);
    const list = (title, arr, cls) => arr.length ? `<div class="cmp-h ${cls}">${title} <span>${arr.length}</span></div><div class="cmp-l">${arr.slice(0, 60).map(x => `<div>${esc(typeof x === 'string' ? x : x.rel)}${x.why ? `<small>${esc(x.why)}</small>` : ''}</div>`).join('')}${arr.length > 60 ? `<div>… ${arr.length - 60} more (see Log)</div>` : ''}</div>` : '';
    const bad = r.different.length + r.onlyLocal.length + r.onlyRemote.length;
    const how = r.readBack ? 'xxHash64, read back' : (r.algo || '').toUpperCase() + ' computed by the server';
    await dialog({
      title: `<span style="display:inline-flex;align-items:center;gap:9px"><span style="display:inline-flex;width:20px;height:20px;color:var(--${bad ? 'orange' : 'green'})">${I.shield}</span>${r.cancelled ? 'Check stopped' : bad ? 'Differences found' : 'Identical on both sides'}</span>`,
      sub: `${plural(r.same.length, 'file')} identical (${esc(how)})${r.unchecked.length ? ` · ${r.unchecked.length} not checked` : ''}`,
      html: list('Different', r.different, 'o') + list('Only here', r.onlyLocal, '') + list('Only on the server', r.onlyRemote, '') + list('Not checked (name the server cannot hash, or read error)', r.unchecked, ''),
      buttons: [{ spacer: true }, { label: 'OK', value: true, cls: 'go' }], width: 620,
    });
  } finally { state.comparing = false; if (typeof off === 'function') off(); }
}

// ── Start the queue later ─────────────────────────────────────────────────
function fmtClock(t) { const d = new Date(t); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; }
function scheduleMenu(x, y) {
  const at = state.qSched || 0;
  showMenu(x, y, [{ head: 'Start the queue' }, { label: 'At a time…', icon: I.clock, action: askSchedule },
    at ? { label: `Cancel the start at ${fmtClock(at)}`, icon: I.trash, action: async () => { state.qSched = (await API.queueSchedule(0)).at; renderQueueHead(); toast('Scheduled start cancelled'); } } : null]);
}
async function askSchedule() {
  const now = new Date(), def = state.qSched ? fmtClock(state.qSched) : '23:00';
  const v = await dialog({
    title: 'Start the queue at',
    sub: 'Files added until then wait. filo must stay open, and the computer awake (Energy settings). START starts it right away.',
    html: `<div class="field"><label>Time</label><input id="sch-t" type="time" value="${def}" style="width:140px"></div>`,
    buttons: [{ label: 'CANCEL', value: null }, { spacer: true }, { label: 'SCHEDULE', cls: 'go', value: c => c.querySelector('#sch-t').value || undefined }],
    width: 420, focus: '#sch-t',
  });
  if (!v) return;
  const [h, m] = v.split(':').map(Number);
  const t = new Date(now); t.setHours(h, m, 0, 0);
  if (t <= now) t.setDate(t.getDate() + 1);           // already past today: tomorrow
  state.qSched = (await API.queueSchedule(t.getTime())).at;
  renderQueueHead();
  toast(`The queue starts at ${fmtClock(t)}${t.getDate() !== now.getDate() ? ' tomorrow' : ''}`);
}
async function playQueue() {
  const c = state.qcounts || {};
  const pending = (c.queued || 0) + (c.waiting || 0) + (c.running || 0) + (c.asking || 0);
  if (!pending && c.paused) {
    const res = await API.queuePage('queue', 0, 100000);
    return API.itemResume(res.items.filter(it => it.status === 'paused').map(it => it.id));
  }
  return API.queueStart();
}

// ── Speed graph (queue header) ──────────────────────────────────────────────
// Total speed, the last minute. Right-aligned: the newest point is at the
// right edge, as in syncto and ingesto. Smooth (Noar, 12/10/2026): a point
// every half second, but the curve slides continuously (each point placed by
// its age, redrawn at the screen's rate), the newest stretch eases towards
// the latest speed, and the scale grows or shrinks gently instead of jumping.
const SPARK_N = 120, SPARK_MS = 500, SPARK_SPAN = SPARK_N * SPARK_MS;
let spark = [], sparkT = 0, sparkMax = 0, sparkLive = 0, sparkTarget = 0, sparkFrame = 0;
// Average speed over the last n points of the graph (half a second each).
function avgSpark(n) {
  const a = spark.slice(-n).map(x => x.v);
  return a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
}
function resetSpark() { spark = []; sparkMax = 0; sparkLive = sparkTarget = 0; drawSpark(); }
// The graph only shows while there is a run: running, or paused (then it
// stays, frozen, until Resume). Finished or stopped: it goes, and the next run
// starts a new one.
function renderSparkVisibility() {
  const live = state.qstate === 'running' || state.qstate === 'paused';
  const box = document.querySelector('.q-titles');
  if (box) box.classList.toggle('nograph', !live);
  if (!live && spark.length) resetSpark();
}
function pushSpark(p) {
  if (!p || p.state !== 'running') return;
  sparkTarget = Math.max(0, p.speed || 0);
  const now = Date.now();
  if (now - sparkT < SPARK_MS) return;
  sparkT = now;
  spark.push({ t: now, v: sparkTarget });
  while (spark.length > SPARK_N + 2) spark.shift();
  animGraphs();
}
function drawSpark(now) {
  const svg = $('q-spark');
  const area = svg.querySelector('.spark-area'), line = svg.querySelector('.spark-line');
  if (spark.length < 2) { area.setAttribute('d', ''); line.setAttribute('d', ''); return false; }
  now = now || Date.now();
  const paused = state.qstate !== 'running';
  const at = paused ? spark[spark.length - 1].t : now;
  sparkLive += (sparkTarget - sparkLive) * 0.12;
  const target = Math.max(1, ...spark.map(x => x.v), sparkLive);
  sparkMax = sparkMax ? sparkMax + (target - sparkMax) * (target > sparkMax ? 0.15 : 0.03) : target;
  const x = t => Math.max(-2, 100 - ((at - t) / SPARK_SPAN) * 100);
  const y = v => 27 - Math.min(1, v / sparkMax) * 24;
  const pts = spark.map(q => [x(q.t), y(q.v)]);
  if (!paused) pts.push([100, y(sparkLive)]);
  const d = 'M' + pts.map(q => q[0].toFixed(2) + ',' + q[1].toFixed(2)).join(' L');
  line.setAttribute('d', d);
  area.setAttribute('d', d + ` L${pts[pts.length - 1][0].toFixed(2)},28 L${pts[0][0].toFixed(2)},28 Z`);
  return !paused;
}
// One animation loop for both speed graphs (queue header, LIVE SYNC ring),
// running only while one of them moves: no cost when filo is at rest.
function animGraphs() {
  if (sparkFrame) return;
  const step = () => {
    sparkFrame = 0;
    const now = Date.now();
    const a = document.querySelector('.q-titles:not(.nograph)') && spark.length > 1 ? drawSpark(now) : false;
    const b = ringFrame(now);
    if (a || b) sparkFrame = requestAnimationFrame(step);
  };
  sparkFrame = requestAnimationFrame(step);
}

function connMenu() {
  const r = $('q-conn').getBoundingClientRect();
  const cur = state.settings.concurrency;
  const set = v => saveSettings({ concurrency: v }).then(renderQueueHead);
  const items = [{ head: 'Files at the same time' },
    { label: 'AUTO: filo finds the fastest', radio: true, on: cur === 'auto', action: () => set('auto') }, 'sep'];
  for (let n = 1; n <= 10; n++) items.push({ label: n === 1 ? '1 (one after the other)' : String(n), radio: true, on: cur === n, action: () => set(n) });
  showMenu(r.left, r.bottom + 6, items);
}

// The checksum switch, in the queue: on or off at any moment. A file already
// on its way keeps the choice it started with; every file that starts after
// the click follows the new one.
function renderVerifySwitch() {
  const on = state.settings.verify !== false;
  $('q-verify').checked = on;
  $('q-check').classList.toggle('off', !on);
  $('q-check').dataset.tip = on
    ? 'Checksum ON: every file is verified after its transfer (by the server when it can, otherwise by reading it back — see Settings). Files already on their way keep their mode.'
    : 'Checksum OFF: only the size is checked. Faster, but a corrupted copy would go unnoticed. Applies to the files that start from now.';
}

function queueMenu(ev) {
  const r = ev.target.closest('.qrow');
  if (r && r.dataset.id && !state.qsel.has(r.dataset.id)) { state.qsel = new Set([r.dataset.id]); renderQueue(); }
  const ids = [...state.qsel];
  const its = ids.map(id => q.byId.get(id)).filter(Boolean);
  const pick = k => its.filter(it => actsOf(it)[k]).map(it => it.id);
  const pa = pick('pause'), re = pick('resume'), sp = pick('stop'), rt = pick('retry');
  const n = (x, l) => x.length > 1 ? `${l} (${x.length})` : l;
  const one = its.length === 1 ? its[0] : null;
  showMenu(ev.clientX, ev.clientY, [
    { label: n(pa, 'Pause'), icon: I.pause, action: () => itemAction('pause', pa), disabled: !pa.length },
    { label: n(re, 'Resume'), icon: I.play, action: () => itemAction('resume', re), disabled: !re.length },
    { label: n(sp, 'Stop'), icon: I.stop, action: () => itemAction('stop', sp), disabled: !sp.length },
    { label: n(rt, 'Retry'), icon: I.retry, action: () => itemAction('retry', rt), disabled: !rt.length },
    'sep',
    one && one.dir ? { label: `Show the local file in ${FILE_MANAGER()}`, icon: I.folder, action: () => API.queueReveal(one.id) } : null,
    one && one.error ? { label: 'Copy the error', icon: I.copy, action: () => { API.copyText(one.error); toast('Copied'); } } : null,
    one && (one.dir || one.error) ? 'sep' : null,
    { label: ids.length > 1 ? `Remove ${ids.length} items` : 'Remove from the queue', icon: I.trash, danger: true, action: () => removeItems(ids), disabled: !ids.length },
  ]);
}

function bindQueue() {
  const list = $('q-list');
  list.addEventListener('scroll', () => { if (state.qtab !== 'log') renderQueue(); }, { passive: true });
  new ResizeObserver(() => renderQueue()).observe(list);
  $('q-tabs').addEventListener('click', ev => { const b = ev.target.closest('button[data-tab]'); if (b) setQTab(b.dataset.tab); });
  list.addEventListener('click', ev => {
    const b = ev.target.closest('.qact');
    if (!b || b.disabled) return;
    const r = b.closest('.qrow');
    if (r && r.dataset.id) itemAction(b.dataset.a, [r.dataset.id]);
  });
  list.addEventListener('mousedown', ev => {
    if (ev.target.closest('.qact')) return;
    const r = ev.target.closest('.qrow');
    if (!r || !r.dataset.id) { if (ev.button === 0) { state.qsel.clear(); renderQueue(); } return; }
    if (ev.button !== 0) return;
    const id = r.dataset.id;
    const idx = Math.floor((parseFloat(r.style.top) || 0) / QROW);
    if (ev.shiftKey && q.anchor >= 0) {
      for (let i = Math.min(q.anchor, idx); i <= Math.max(q.anchor, idx); i++) { const it = q.items[i - q.offset]; if (it) state.qsel.add(it.id); }
    } else if (modKey(ev)) { if (state.qsel.has(id)) state.qsel.delete(id); else state.qsel.add(id); q.anchor = idx; }
    else { state.qsel = new Set([id]); q.anchor = idx; }
    renderQueue();
  });
  list.addEventListener('contextmenu', ev => { ev.preventDefault(); if (state.qtab !== 'log') queueMenu(ev); });
  list.addEventListener('keydown', ev => {
    if ((ev.key === 'Delete' || ev.key === 'Backspace') && state.qsel.size) { ev.preventDefault(); removeItems([...state.qsel]); }
    if (modKey(ev) && ev.key.toLowerCase() === 'a') {
      // Every row of the tab, not only the ones loaded on screen.
      ev.preventDefault();
      API.queuePage(state.qtab, 0, 100000).then(res => { for (const it of res.items) state.qsel.add(it.id); renderQueue(); });
    }
  });
  $('q-start').onclick = () => {
    if ($('q-start').classList.contains('dis')) return;
    if (state.qstate !== 'running') return playQueue();
    API.queuePause();
    refreshAfterStop(new Set(['up', 'down']));
  };
  // Right-click on START: start at a time (Noar, 12/10/2026).
  $('q-start').oncontextmenu = ev => { ev.preventDefault(); scheduleMenu(ev.clientX, ev.clientY); };
  $('q-stop').onclick = () => { state.blocked = null; renderBlocked(); API.queueStopAll(); refreshAfterStop(new Set(['up', 'down'])); };
  $('q-conn').onclick = connMenu;
  $('q-sync').onclick = syncToggle;
  $('q-verify').addEventListener('change', async () => {
    await saveSettings({ verify: $('q-verify').checked });
    renderVerifySwitch();
    toast($('q-verify').checked ? 'Checksum on — for every file that starts from now' : 'Checksum off — size only, for every file that starts from now', !$('q-verify').checked);
  });
  $('q-retry').onclick = () => retryItems([]);
  if (!$('q-clear').innerHTML) $('q-clear').innerHTML = BROOM;
  $('q-clear').onclick = () => {
    if (state.qtab === 'log') { API.copyText(state.logs.map(l => `${fmtTime(l.t)} ${l.level.toUpperCase()} ${l.msg}`).join('\n')); toast('Log copied'); return; }
    clearTab(state.qtab);
  };
  // Right-click on QUEUE, FAILED or DONE: clear that list without opening it.
  $('q-tabs').addEventListener('contextmenu', ev => {
    const b = ev.target.closest('button[data-tab]');
    if (!b || b.dataset.tab === 'log') return;
    ev.preventDefault();
    const tab = b.dataset.tab, c = state.qcounts || {};
    const n = tab === 'queue' ? (c.queued || 0) + (c.waiting || 0) + (c.running || 0) + (c.asking || 0) + (c.paused || 0)
      : tab === 'failed' ? (c.failed || 0) + (c.stopped || 0) : (c.done || 0) + (c.skipped || 0);
    const label = { queue: 'Clear the queue', failed: 'Clear the Failed list', done: 'Clear the Done list' }[tab];
    showMenu(ev.clientX, ev.clientY, [{ label: n ? `${label} (${n})` : label, icon: I.trash, danger: tab !== 'done', disabled: !n, action: () => clearTab(tab) }]);
  });
}

// Empties one list of the queue; asks first when it loses something.
async function clearTab(tab) {
  {
    if (tab === 'queue') {
      const c = state.qcounts;
      const n = (c.queued || 0) + (c.waiting || 0) + (c.running || 0) + (c.asking || 0) + (c.paused || 0);
      if (!n) return;
      if (!(await confirmBox(`Remove ${plural(n, 'item')} from the queue?`, 'Running transfers stop, and their partial files are deleted.', 'REMOVE', true))) return;
    }
    if (tab === 'failed') {
      const c = state.qcounts;
      const n = (c.failed || 0) + (c.stopped || 0);
      if (!n) return;
      if (!(await confirmBox(`Remove ${plural(n, 'item')} from the Failed list?`, 'Their partial files are deleted: a retry would start again from zero.', 'REMOVE', true))) return;
    }
    API.queueClear(tab);
  }
}

// ── Blocked queue (a password, a server to trust) ───────────────────────────
function renderBlocked() {
  const b = state.blocked, el = $('q-blocked');
  if (!b) { el.classList.remove('open'); el.innerHTML = ''; return; }
  el.classList.add('open');
  if (b.code === 'NEEDS_PASSWORD') {
    el.innerHTML = `${I.key.replace('<svg', '<svg width="16" height="16"')}<span class="msg">The queue is waiting for the password of <b>${esc(b.endpointLabel)}</b>.</span><input type="password" id="blk-pw" placeholder="password"><button class="btn sm go" id="blk-go">RESUME</button>`;
    const go = async () => { const v = $('blk-pw').value; if (!v) return; await API.endpointPassword(b.endpointId, v); state.blocked = null; renderBlocked(); API.queueStart(); };
    $('blk-go').onclick = go;
    $('blk-pw').onkeydown = e => { if (e.key === 'Enter') go(); };
  } else if (b.code === 'TRUST_NEEDED' && b.trust) {
    el.innerHTML = `${I.shield.replace('<svg', '<svg width="16" height="16"')}<span class="msg">${esc(b.message)}<br><code>${esc(b.trust.fingerprint)}</code></span><button class="btn sm go" id="blk-trust">TRUST AND RESUME</button>`;
    $('blk-trust').onclick = async () => { await API.trust(b.trust); state.blocked = null; renderBlocked(); API.queueStart(); };
  } else {
    el.innerHTML = `${I.alert.replace('<svg', '<svg width="16" height="16"')}<span class="msg"><b>${esc(b.endpointLabel)}</b>: ${esc(b.message)}</span><button class="btn sm" id="blk-retry">TRY AGAIN</button>`;
    $('blk-retry').onclick = () => { state.blocked = null; renderBlocked(); API.queueStart(); };
  }
}

// ── "The file is already there" ─────────────────────────────────────────────
async function nextAsk() {
  if (state.askOpen || !state.asks.length) return;
  const a = state.asks.shift();
  state.askOpen = true;
  const newer = (x, y) => x.mtime && y.mtime && x.mtime > y.mtime + 2000;
  let def = 'overwrite';
  if (a.dst.size < a.src.size && a.dst.size > 0) def = 'resume';
  else if (a.dst.size === a.src.size && !newer(a.src, a.dst)) def = 'skip';
  else if (!newer(a.src, a.dst) && newer(a.dst, a.src)) def = 'skip';
  const opts = ['overwrite', 'newer', 'sizeDiffers', 'resume', 'rename', 'skip'];
  const L = state.existingLabels;
  const srcLabel = a.dir === 'up' ? 'Local (new)' : 'Server (new)';
  const dstLabel = a.dir === 'up' ? 'Server (there)' : 'Local (there)';
  const res = await dialog({
    title: 'Already there',
    sub: `<b>${esc(a.name)}</b><br><span class="mono" style="font-size:11px">${esc(a.target)}</span>`,
    html: `<div class="ex-cmp"><div></div><div class="h">${srcLabel}</div><div class="h">${dstLabel}</div>
        <div class="h">Size</div><div class="v">${fmtSize(a.src.size)}</div><div class="v">${fmtSize(a.dst.size)}</div>
        <div class="h">Modified</div><div class="v${newer(a.src, a.dst) ? ' newer' : ''}">${fmtDate(a.src.mtime) || '?'}</div><div class="v${newer(a.dst, a.src) ? ' newer' : ''}">${fmtDate(a.dst.mtime) || '?'}</div></div>
      <div class="ex-opts" id="ex-opts">${opts.map(o => `<label class="${o === def ? 'on' : ''}"><input type="radio" name="ex" value="${o}"${o === def ? ' checked' : ''}> ${esc(L[o] || o)}</label>`).join('')}</div>
      ${scopeHtml(`Every ${a.dir === 'up' ? 'upload' : 'download'} in the queue`)}`,
    buttons: [{ label: 'OK', cls: 'go', value: c => ({ rule: c.querySelector('input[name=ex]:checked').value, all: scopeAll(c) }) }],
    width: 540,
    tag: 'ask:' + a.askId,
    onOpen: c => c.querySelector('#ex-opts').addEventListener('change', () => c.querySelectorAll('#ex-opts label').forEach(l => l.classList.toggle('on', l.querySelector('input').checked))),
  });
  state.askOpen = false;
  // The file stopped asking (paused, stopped, removed): nothing to answer.
  if (res && res.closed) return nextAsk();
  const answer = res || { rule: 'skip', all: false };
  await API.queueAnswer(a.askId, answer.rule, answer.all);
  if (answer.all) state.asks = state.asks.filter(x => x.dir !== a.dir);
  nextAsk();
}

// ── Log ────────────────────────────────────────────────────────────────────
function fmtTime(t) { const d = new Date(t), p = n => String(n).padStart(2, '0'); return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; }
function renderLog(full) {
  const el = $('q-log');
  const list = $('q-list');
  const atBottom = list.scrollTop + list.clientHeight >= list.scrollHeight - 30;
  const lines = state.logs.slice(-1500);
  if (full) el.innerHTML = lines.map(l => `<div class="l ${l.level}"><span class="t">${fmtTime(l.t)}</span>${esc(l.msg)}</div>`).join('');
  if (atBottom || full) list.scrollTop = list.scrollHeight;
}

// ══ Settings ═══════════════════════════════════════════════════════════════
async function openSettings() {
  const s = state.settings;
  $('st-conc').value = String(s.concurrency);
  $('row-automax').style.display = s.concurrency === 'auto' ? '' : 'none';
  $('st-conc-desc').style.display = s.concurrency === 'auto' ? 'none' : '';
  $('st-automax').value = s.autoMax;
  $('st-retries').value = s.retries;
  // 0 means no limit: the field stays empty and says so.
  $('st-limit-up').value = s.limitUp > 0 ? s.limitUp : '';
  $('st-limit-down').value = s.limitDown > 0 ? s.limitDown : '';
  const opts = Object.entries(state.existingLabels).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('');
  $('st-ex-up').innerHTML = opts; $('st-ex-down').innerHTML = opts;
  $('st-ex-up').value = s.existingUp; $('st-ex-down').value = s.existingDown;
  $('st-dates').checked = s.keepDates; $('st-temp').checked = s.tempNames; $('st-segments').checked = s.segments !== false;
  $('st-serverhash').checked = s.serverHash !== false;
  $('st-hidden-desc').textContent = `names starting with a dot (${isMac() ? '⇧⌘.' : 'Ctrl+Shift+.'})`;
  $('st-hidden').checked = s.showHidden; $('st-confirmdel').checked = s.confirmDelete;
  $('st-ntfy-en').checked = state.ntfy.enabled; $('st-ntfy-server').value = state.ntfy.server || ''; $('st-ntfy-topic').value = state.ntfy.topic || '';
  $('st-hook-en').checked = !!s.hookEnabled; $('st-hook-cmd').value = s.hookCommand || ''; $('st-hook-res').textContent = '';
  $('st-ntfy-sync').checked = !!state.ntfy.syncAlert; $('st-ntfy-min').value = String(state.ntfy.syncAlertMin || 10);
  $('st-ntfy-res').textContent = '';
  renderVerifyRows();
  $('st-known-q').value = '';
  await Promise.all([renderKnown(), renderCli()]);
  $('ov-settings').classList.add('open');
}

// ── POST COMMAND: filo driven by a script or another program ───────────────
async function renderCli() {
  const c = state.cli = await API.cliInfo();
  $('st-cli-cmd').textContent = c.command;
  $('st-cli-cmd').title = c.command;
  $('row-cli-install').style.display = c.canInstall ? '' : 'none';
  if (c.canInstall) {
    $('st-cli-install').textContent = c.installed ? 'REINSTALL' : 'INSTALL';
    $('st-cli-state').textContent = c.installed ? 'installed: type “filo” in the Terminal'
      : c.stale ? 'points to another copy of filo: install it again' : 'so that “filo upload …” works in the Terminal (asks for the Mac\'s password)';
  }
}
async function installCli() {
  const r = await API.cliInstall();
  if (r.ok) { toast('“filo” command installed'); state.cli = r.info; if ($('ov-settings').classList.contains('open')) renderCli(); return; }
  if (!r.cancelled) errorBox('The command line was not installed', r.error);
}
// The commands, ready to copy. `cmd` is what starts this filo here.
function cliHelpBox() {
  // The examples say "filo"; where that is not the command yet, the line on
  // top says what stands for it (COPY gives the full, working line).
  const full = (state.cli && state.cli.command) || 'filo';
  const cmd = 'filo';
  const items = [
    ['Send files or folders to a site (names from the site manager)', `${cmd} upload --site "Studio NAS" --to /Rushes/Day2 --wait /Volumes/CARD_A/A001`],
    ['Fetch files or folders from a site', `${cmd} download --site "Client SFTP" --to ~/Projects/Doha /Delivery/Final_v3.mov`],
    ['Run a LIVE SYNC session now (its name in the LIVE SYNC window)', `${cmd} livesync --pair "Exports → client" --wait`],
    ['Start, pause or stop the queue', `${cmd} queue start`],
    ['What filo is doing', `${cmd} status`],
    ['For a program: one JSON line per event, and the result in a file', `${cmd} upload --site "Studio NAS" --to /Rushes --wait --json --out /tmp/filo-result.json ./A001`],
    ['Everything, in the Terminal', `${cmd} help`],
  ];
  const real = c => (full === 'filo' ? c : full + c.slice(3));
  const note = full === 'filo' ? '' : `<div class="cli-it"><div class="d">Here, <b>filo</b> stands for</div><div class="l"><code>${esc(full)}</code></div>${state.cli && state.cli.canInstall ? '<div class="cli-codes">or install the “filo” command (Settings, POST COMMAND).</div>' : ''}</div>`;
  const html = `<div class="cli-list">${note}${items.map(([d, c], i) => `<div class="cli-it"><div class="d">${esc(d)}</div><div class="l"><code>${esc(c)}</code><button class="btn sm" data-c="${i}">COPY</button></div></div>`).join('')}
    <div class="cli-it"><div class="d">Options</div><div class="cli-codes">--wait&nbsp; wait until the files are done (the exit code tells how it went)<br>--json&nbsp; one JSON line per event · --out &lt;file&gt;&nbsp; the result, as JSON, in a file<br>--background&nbsp; if filo is not open, start it minimised</div></div>
    <div class="cli-it"><div class="d">Exit codes</div><div class="cli-codes"><b>0</b>done (with --wait: every file arrived and was verified)<br><b>1</b>some files failed or were stopped<br><b>2</b>the command is not right<br><b>3</b>the site or the LIVE SYNC session does not exist, or the server refused<br><b>4</b>filo could not be started or reached</div></div>
    <div class="cli-it"><div class="d">No password on the command line: the site's saved password or key is used. The files go through the queue of the filo that is open, and show in its window.</div></div></div>`;
  return dialog({
    title: 'Command line', sub: 'Commands to start from a script, an export preset or another program.', html, width: 640,
    buttons: [{ label: 'CLOSE', value: true, cls: 'go' }],
    onOpen: card => card.querySelectorAll('button[data-c]').forEach(b => b.addEventListener('click', () => { API.copyText(real(items[+b.dataset.c][1])); toast('Copied'); })),
  });
}
// One switch, two ways to verify: the label says which one is in force.
// On: the server computes the checksum (no second transfer); a server that
// cannot gets its file read back. Off: every file is read back.
function renderVerifyRows() {
  const on = state.settings.verify !== false;
  const server = $('st-serverhash').checked;
  $('st-verify-label').textContent = server ? 'Ask the server for a checksum' : 'Read the file back';
  $('st-verify-desc').textContent = server
    ? 'no second transfer (a server that cannot: read back)'
    : 'every file transferred a second time, without the server';
  $('st-serverhash').disabled = !on;
  $('st-serverhash').closest('.set-row').style.opacity = on ? '' : '.45';
}
// Known servers: sorted by address, with a search once there are a few, in
// a box of its own that scrolls (the settings window stays readable).
async function renderKnown() {
  const all = (await API.knownList()).map(k => {
    const [kind, ...rest] = k.key.split(':');
    const port = rest.pop();
    return Object.assign({ kind, host: rest.join(':'), port }, k);
  }).sort((a, b) => a.host.localeCompare(b.host) || Number(a.port) - Number(b.port));
  state.known = all;
  $('st-known-q').style.display = all.length > 6 ? '' : 'none';
  $('st-known-n').textContent = all.length ? `(${all.length})` : '';
  filterKnown();
}
function filterKnown() {
  const q = $('st-known-q').value.trim().toLowerCase();
  const all = state.known || [];
  const list = q ? all.filter(k => `${k.host}:${k.port} ${k.fp}`.toLowerCase().includes(q)) : all;
  if (all.length && !list.length) { $('st-known').innerHTML = `<div class="set-desc">Nothing matches “${esc(q)}”.</div>`; return; }
  $('st-known').innerHTML = list.length ? list.map(k => {
    const { kind, host, port } = k;
    return `<div class="k"><span class="badge ${kind === 'sftp' ? 'g' : 'b'}">${kind === 'sftp' ? 'SSH key' : 'Certificate'}</span><div class="a"><div>${esc(host)}:${esc(port)}</div><div>${esc(k.fp)}</div></div><button class="btn sm" data-k="${esc(k.key)}">FORGET</button></div>`;
  }).join('') : '<div class="set-desc">No server yet. Each server you trust is listed here, with its fingerprint.</div>';
}
async function saveSettings(patch) {
  state.settings = await API.settingsSave(patch);
  renderConnPill();
  panels.local.compute(); panels.local.render();
  panels.remote.compute(); panels.remote.render();
  renderQueueHead();
}
function bindSettings() {
  $('btn-settings').onclick = openSettings;
  $('set-close').onclick = () => $('ov-settings').classList.remove('open');
  $('st-conc').onchange = () => { const v = $('st-conc').value; $('row-automax').style.display = v === 'auto' ? '' : 'none'; $('st-conc-desc').style.display = v === 'auto' ? 'none' : ''; saveSettings({ concurrency: v === 'auto' ? 'auto' : Number(v) }); };
  $('st-automax').onchange = () => saveSettings({ autoMax: Number($('st-automax').value) });
  $('st-retries').onchange = () => saveSettings({ retries: Number($('st-retries').value) });
  const limit = id => { const v = Number($(id).value); const n = v > 0 ? v : 0; if (!n) $(id).value = ''; return n; };
  $('st-limit-up').onchange = () => saveSettings({ limitUp: limit('st-limit-up') });
  $('st-limit-down').onchange = () => saveSettings({ limitDown: limit('st-limit-down') });
  $('st-ex-up').onchange = () => saveSettings({ existingUp: $('st-ex-up').value });
  $('st-ex-down').onchange = () => saveSettings({ existingDown: $('st-ex-down').value });
  const sw = (id, key) => { $(id).onchange = () => saveSettings({ [key]: $(id).checked }); };
  sw('st-dates', 'keepDates'); sw('st-temp', 'tempNames'); sw('st-segments', 'segments'); $('st-serverhash').onchange = () => { renderVerifyRows(); saveSettings({ serverHash: $('st-serverhash').checked, readBack: true }); };
  sw('st-hidden', 'showHidden'); sw('st-confirmdel', 'confirmDelete');
  // After the queue: the command.
  $('st-hook-en').addEventListener('change', () => saveSettings({ hookEnabled: $('st-hook-en').checked }));
  $('st-hook-cmd').addEventListener('change', () => saveSettings({ hookCommand: $('st-hook-cmd').value.trim() }));
  $('st-hook-test').onclick = async () => {
    const el = $('st-hook-res'), cmd = $('st-hook-cmd').value.trim();
    if (!cmd) { el.className = 'set-test-res err'; el.textContent = 'Type a command first.'; return; }
    el.className = 'set-test-res'; el.textContent = 'Running (example values)…';
    const r = await API.hookTest(cmd);
    el.className = 'set-test-res ' + (r.ok ? 'ok' : 'err');
    el.textContent = r.ok ? 'It ran and ended without error.' : `Did not work: ${r.error}`;
  };
  const ntfyPatch = () => ({ enabled: $('st-ntfy-en').checked, server: $('st-ntfy-server').value.trim(), topic: $('st-ntfy-topic').value.trim(), syncAlert: $('st-ntfy-sync').checked, syncAlertMin: $('st-ntfy-min').value });
  for (const id of ['st-ntfy-en', 'st-ntfy-server', 'st-ntfy-topic', 'st-ntfy-sync', 'st-ntfy-min']) $(id).addEventListener('change', async () => { state.ntfy = await API.ntfySave(ntfyPatch()); $('st-ntfy-min').value = String(state.ntfy.syncAlertMin || 10); });
  $('st-ntfy-test').onclick = async () => {
    const r = await API.ntfyTest(ntfyPatch());
    const el = $('st-ntfy-res');
    el.className = 'set-test-res ' + (r.ok ? 'ok' : 'err');
    el.textContent = r.ok ? 'Sent' : r.error;
  };
  $('st-cli-copy').onclick = () => { API.copyText($('st-cli-cmd').textContent); toast('Copied'); };
  $('st-cli-help').onclick = cliHelpBox;
  $('st-cli-install').onclick = installCli;
  $('st-known-q').addEventListener('input', filterKnown);
  $('st-known').addEventListener('click', async ev => {
    const b = ev.target.closest('button[data-k]'); if (!b) return;
    if (!(await confirmBox('Forget this server\'s identity?', 'The next connection will show its fingerprint again and ask.', 'FORGET', true))) return;
    await API.knownForget(b.dataset.k);
    renderKnown();
  });
}

// ══ After the queue: summary, notification, machine ═════════════════════════
const AFTER = {
  none: ['Do nothing', I.power], quit: ['Quit filo', I.quit], sleep: ['Sleep', I.moon], shutdown: ['Shut down', I.power],
};
function renderAfterBtn() {
  const v = state.afterAction;
  const b = $('btn-after');
  const hk = !!(state.settings.hookEnabled && (state.settings.hookCommand || '').trim());
  b.classList.toggle('set', v !== 'none' || hk);
  b.innerHTML = AFTER[v][1];
  b.dataset.tip = `When the queue finishes: ${hk ? 'run your command, then ' : ''}${AFTER[v][0].toLowerCase()}`;
}
const afterState = { timer: null, left: 0, action: 'none' };
function stopCountdown() { clearInterval(afterState.timer); afterState.timer = null; $('ov-after').classList.remove('open'); }
async function fireAfter() {
  stopCountdown();
  const r = await API.afterRun(afterState.action, true);
  if (r && !r.ok && r.error) errorBox('The machine did not respond', r.error);
}
function startCountdown(action) {
  const W = { quit: 'filo will quit', sleep: 'This machine will sleep', shutdown: 'This machine will shut down' };
  if (!W[action]) return;
  stopCountdown();                       // never two countdowns at once
  afterState.action = action;
  afterState.left = 30;
  $('after-what').textContent = W[action];
  $('after-sub').textContent = 'Every transfer finished, with no error.';
  $('after-count').textContent = '30';
  $('ov-after').classList.add('open');
  afterState.timer = setInterval(() => {
    afterState.left--;
    $('after-count').textContent = String(Math.max(0, afterState.left));
    if (afterState.left <= 0) fireAfter();
  }, 1000);
}

function onFinished(s) {
  state.qRan = false;
  if (s.hook && !s.hook.ok) toast(`The command after the queue did not work: ${s.hook.error}`, true);
  panels.local.load(panels.local.dir, { keepSel: true });
  if (state.conn) { panels.remote.cache.delete(panels.remote.dir); panels.remote.load(panels.remote.dir, { keepSel: true }); }
  const secs = Math.round(s.durationMs / 1000);
  // LIVE SYNC on its own: never a window in the way, a line is enough.
  if (s.syncOnly) {
    if (s.failed) toast(`LIVE SYNC: ${plural(s.failed, 'file')} failed (see Failed)`, true);
    else if (s.done) toast(`LIVE SYNC: ${plural(s.done, 'file')} · ${fmtSize(s.bytes)}`);
    renderSyncBtn();
    return;
  }
  if (s.failed) {
    dialog({
      title: '',
      html: `<div class="sum-hd"><div class="sum-ico err">${I.alert}</div><div><div style="font-size:19px;font-weight:700">${plural(s.failed, 'transfer')} failed</div><div class="m-sub" style="margin:2px 0 0">${s.done} done · ${fmtSize(s.bytes)} · ${fmtDur(secs)}</div></div></div>
        <div class="err-list">${s.errors.map(e => `<div><b>${esc(e.name)}</b> — ${esc(e.message)}</div>`).join('')}</div>`,
      buttons: [{ label: 'SHOW FAILED', value: 'failed' }, { spacer: true }, { label: 'RETRY ALL', value: 'retry' }, { label: 'OK', value: true, cls: 'go' }],
      width: 560,
    }).then(v => { if (v === 'failed') setQTab('failed'); if (v === 'retry') retryItems([]); });
    if (s.afterAction && s.afterAction !== 'none') toast(`“${AFTER[s.afterAction][0]}” was skipped: some transfers failed.`, true);
    return;
  }
  if (s.done || s.skipped) toast(`Finished: ${plural(s.done, 'file')} · ${fmtSize(s.bytes)} · ${fmtDur(secs)}${s.verified ? ` · ${s.verified} verified` : ''}`);
  if (s.afterAction && s.afterAction !== 'none' && (s.paused || s.stopped)) { toast(`“${AFTER[s.afterAction][0]}” was skipped: some files were paused or stopped.`, true); return; }
  if (s.afterAction && s.afterAction !== 'none' && (s.done || s.skipped)) startCountdown(s.afterAction);
}

// ══ LIVE SYNC ══════════════════════════════════════════════════════════════
// Sessions: a local folder kept in step with another place, of three kinds:
//   SYNCTHING                  another computer running filo, peer to peer
//                           (Syncthing, main process: direct.js);
//   SYNCTHING FAILSAFE the same, and a server folder used while the
//                           other computer cannot be reached;
//   S-FTP                   a folder on a server (syncer.js).
// The settings window (#ov-sync) makes and edits them; once a session is
// CONNECTED, the main window shows the LIVE SYNC view (#live) in place of the
// two panels: this computer on the left, the other side on the right.
const sy = {
  pairs: [], status: {}, selId: null, draft: null,
  direct: { available: false, pending: { devices: [], folders: [] } },
  me: null,                 // this computer: name, OS, IPs (live-info)
  liveHidden: false,        // SHOW FILES: the panels, the sessions still connected
  liveSel: null,            // the session shown in the LIVE SYNC view
  spark: {},                // pairId → speed, one point a second (the graph)
  sparkAt: {},              // pairId → when its last point was taken
  trash: {},                // pairId → this computer's trash (files, bytes)
  trashAt: {},              // pairId → when its trash was last measured
  myId: null,               // this computer's SYNCTHING ID, once SYNCTHING runs
};
const SY_TYPES = {
  direct: ['SYNCTHING', 'Straight to another computer running filo, peer to peer: no server in between. Both filo must be open at the same time.'],
  hybrid: ['DUAL SYNC', 'SYNCTHING straight to the remote computer, and a server folder (S-FTP BACKUP) kept as an exact copy of the MASTER\'s folder. The remote computer away: the files go through the server.'],
  server: ['S-FTP', 'Through a folder on an FTP, FTPS or SFTP server: a bookmark of the site manager.'],
};
// In this order on screen: 2 WAYS first (Noar, 11/10/2026).
const SY_DIR = {
  both: ['2 WAYS', 'Both sides send and receive.'],
  up: ['LOCAL → S-FTP', 'This computer sends.'],
  down: ['S-FTP → LOCAL', 'This computer receives.'],
};
const SY_DIR_DIRECT = {
  both: ['2 WAYS', 'Both computers send and receive.'],
  up: ['LOCAL → REMOTE', 'This computer sends.'],
  down: ['REMOTE → LOCAL', 'This computer receives.'],
};
// MASTER / SLAVE (SYNCTHING): the computer that creates a session is its MASTER.
const isSlave = p => !!p && p.via !== 'server' && p.role === 'slave';
const roleOf = p => (p && p.via !== 'server' ? (p.role === 'slave' ? 'SLAVE' : 'MASTER') : '');
// The role at a glance (Noar, 11/10/2026): MASTER green with a crown,
// SLAVE grey with a link.
const I_CROWN = SVG('<path d="M11.562 3.266a.5.5 0 0 1 .876 0L15.39 8.87a1 1 0 0 0 1.516.294L21.183 5.5a.5.5 0 0 1 .798.519l-2.834 10.246a1 1 0 0 1-.956.734H5.81a1 1 0 0 1-.957-.734L2.02 6.02a.5.5 0 0 1 .798-.519l4.276 3.664a1 1 0 0 0 1.516-.294z"/><path d="M5 21h14"/>');
const I_FOLLOW = SVG('<path d="M9 17H7A5 5 0 0 1 7 7h2"/><path d="M15 7h2a5 5 0 1 1 0 10h-2"/><line x1="8" x2="16" y1="12" y2="12"/>');
// role: 'MASTER' | 'SLAVE'; who: 'this' (this computer) or 'remote'.
function roleBadge(role, who, big) {
  if (!role) return '';
  const m = role === 'MASTER';
  const tip = who === 'remote'
    ? (m ? 'The remote computer is the MASTER: it created the session, its version wins a conflict, it sets the direction and the filter.' : 'The remote computer is the SLAVE: it follows this computer\'s settings.')
    : (m ? 'This computer is the MASTER: it created the session, its version wins a conflict, it sets the direction and the filter.' : 'This computer is the SLAVE: it follows the MASTER\'s settings, and the MASTER\'s version wins a conflict.');
  return `<span class="sy-role ${m ? 'master' : 'slave'}${big ? ' big' : ''}" data-tip="${esc(tip)}">${m ? I_CROWN : I_FOLLOW}${role}</span>`;
}
const otherRole = p => (isSlave(p) ? 'MASTER' : 'SLAVE');
// The look of the three kinds, in syncto's style (its mode buttons: an icon
// on a hollow tinted with the colour of the mode, the chosen one outlined in
// it, a green tick). Colours (Noar, 11/10/2026): SYNCTHING blue, as SYNCTHING
// everywhere; S-FTP violet; FAILSAFE the two blended. Icons: Lucide, as
// everywhere in filo and syncto.
const SY_LOOK = {
  direct: { cls: 'k-direct', icon: SVG('<rect x="2" y="4" width="8" height="7" rx="1.2"/><rect x="14" y="4" width="8" height="7" rx="1.2"/><path d="M6 11v3"/><path d="M18 11v3"/><path d="M4 17h4"/><path d="M16 17h4"/><path d="M10 7.5h4"/>') },
  hybrid: { cls: 'k-hybrid', icon: SVG('<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10"/><path d="m9 12 2 2 4-4"/>') },
  server: { cls: 'k-server', icon: SVG('<rect width="20" height="8" x="2" y="2" rx="2"/><rect width="20" height="8" x="2" y="14" rx="2"/><path d="M6 6h.01"/><path d="M6 18h.01"/>') },
};
// Directions, with syncto's icons and colours: one way = syncto's UPDATE
// (green: adds and updates, never removes, exactly what LIVE SYNC does);
// 2 WAYS = syncto's 2 WAYS (blue).
const SY_DIR_LOOK = {
  up: { cls: 'd-one', icon: SVG('<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>') },
  down: { cls: 'd-one', icon: SVG('<path d="M19 12H5"/><path d="m12 19-7-7 7-7"/>') },
  both: { cls: 'd-two', icon: SVG('<path d="M8 3 4 7l4 4"/><path d="M4 7h16"/><path d="m16 21 4-4-4-4"/><path d="M20 17H4"/>') },
};
const SY_INTERVALS = [1, 2, 5, 10, 15, 30, 60, 120];
const SY_PC = SVG('<rect width="20" height="14" x="2" y="3" rx="2"/><path d="M8 21h8"/><path d="M12 17v4"/>');
const isDirectish = p => !!p && (p.via === 'direct' || p.via === 'hybrid');
const shortDev = id => String(id || '').split('-')[0];
// "Mac-Studio · macOS 15.1" → name and system (filo puts both in the name the
// other computer sees).
function splitDev(n) { const i = String(n || '').indexOf(' · '); return i < 0 ? { name: n || '', os: '' } : { name: n.slice(0, i), os: n.slice(i + 3) }; }
function directLink(peer) {
  if (!peer) return '';
  if (!peer.connected) return 'not connected';
  return peer.via === 'lan' ? 'direct, local network' : peer.via === 'internet' ? 'direct, through the internet' : 'through a relay (slower)';
}
function peerAddress(peer) {
  const a = String((peer && peer.address) || '');
  if (!a || /relay/.test(a)) return '';
  return a.replace(/^[a-z0-9+-]+:\/\//i, '');
}
function connectedNow(p) { const st = sy.status[p.id] || {}; return !!(st.peer && st.peer.connected); }
// A session is on while one of its CONNECT switches is: Syncthing (auto),
// or, for SYNCTHING FAILSAFE, the failsafe (fsAuto).
const isOn = p => !!p && (!!p.auto || (p.via === 'hybrid' && !!p.fsAuto));
// The way files go right now: Syncthing or S-FTP. A hybrid session
// goes by the server when Syncthing is off or the other computer is away,
// and only if its failsafe is on.
function sessionMode(p) {
  if (!p) return '';
  if (p.via === 'server') return 'S-FTP';
  if (p.via === 'direct') return 'SYNCTHING';
  if (p.auto && connectedNow(p)) return 'SYNCTHING';
  return p.fsAuto ? 'S-FTP' : 'SYNCTHING';
}
// DUAL SYNC: the MASTER's mirror copies running (SYNCTHING has finished).
function mirroring(p, st) {
  return !!p && p.via === 'hybrid' && sessionMode(p) === 'SYNCTHING' && (st.server || {}).state === 'mirror' && state.qstate === 'running';
}
function serverSummary(st) {
  if (!st) return '';
  if (st.state === 'checking') return 'Checking…';
  if (st.state === 'error') return 'Error: ' + (st.error || '');
  if (st.state === 'standby') return 'Standby: SYNCTHING is working';
  if (st.state === 'mirror') return 'Copying to the S-FTP BACKUP';
  if (st.state === 'mirrored') return `Backup up to date · ${fmtTime(st.lastRun)}`;
  if (st.state === 'waiting') return 'Files settling';
  const r = st.result;
  if (r && r.copies) return `${plural(r.copies, 'file')} sent to the queue`;
  if (st.lastRun) return `Up to date · checked ${fmtTime(st.lastRun)}`;
  return st.auto ? 'Starting…' : '';
}
function directSummary(st, p) {
  if (!st) return '';
  const left = (st.needBytes || 0) + (st.peerNeedBytes || 0);
  switch (st.state) {
    case 'starting': return 'Starting…';
    case 'waiting': return 'Waiting for the remote computer';
    case 'offline': return `${splitDev(p && p.peer && p.peer.name).name || 'The remote computer'} not reachable`;
    case 'paused': return 'Disconnected';
    case 'held': return left ? `Paused · ${fmtSize(left)} left` : 'Paused';
    case 'scanning': return 'Checking the folder…';
    case 'syncing': return left ? `Syncing · ${fmtSize(left)} left` : 'Syncing…';
    case 'insync': return 'Up to date';
    case 'error': return 'Error: ' + (st.error || '');
    default: return '';
  }
}
function sessionSummary(p) {
  const st = sy.status[p.id] || {};
  if (!isOn(p)) return 'Disconnected';
  if (p.via === 'server') return serverSummary(st);
  if (p.via === 'direct') return directSummary(st, p);
  if (sessionMode(p) === 'S-FTP') return 'S-FTP BACKUP · ' + serverSummary(st.server);
  return directSummary(st, p);
}
function sessionError(p) {
  const st = sy.status[p.id] || {};
  return st.state === 'error' || (st.server && st.server.state === 'error');
}
function pendingCount() { const p = sy.direct.pending || {}; return (p.devices || []).length + (p.folders || []).length; }
const connectedPairs = () => sy.pairs.filter(isOn);

function renderSyncBtn() {
  const b = $('btn-sync');
  if (!b) return;
  const on = connectedPairs();
  const ask = pendingCount();
  const err = ask > 0 || on.some(sessionError);
  b.classList.toggle('on', on.length > 0 && !err);
  b.classList.toggle('err', err);
  b.classList.toggle('off', !on.length && !err);
  $('sy-n').textContent = ask ? String(ask) : on.length > 1 ? String(on.length) : '';
  b.dataset.tip = ask ? 'LIVE SYNC: another computer is waiting for your answer'
    : err ? 'LIVE SYNC: a session has a problem'
    : on.length ? `LIVE SYNC: connected (${on.map(p => p.name + (roleOf(p) ? ` · ${roleOf(p)}` : '')).join(', ')})` : 'LIVE SYNC: keep a folder in step with another computer or a server';
}
async function loadSync() {
  const r = await API.syncList();
  sy.pairs = r.pairs; sy.status = r.status || {};
  if (r.defaultExclude) sy.defaultExclude = r.defaultExclude;
  if (r.direct) sy.direct = r.direct;
  renderSyncBtn(); renderLive();
}
// The LIVE SYNC button: back to the LIVE SYNC view when sessions are
// connected and the panels are shown; the settings window otherwise.
// The LIVE SYNC button: a menu (Noar, 12/10/2026). New session, import one
// as SLAVE, connect or disconnect a session; and the way back to the view and
// to the sessions.
async function onSyncBtn() {
  await loadSync();
  const b = $('btn-sync').getBoundingClientRect();
  const many = sy.pairs.length > 1;
  const ask = pendingCount();
  const items = [
    ask && { label: `${ask === 1 ? 'A computer waits' : ask + ' computers wait'} for your answer…`, icon: I.link, action: () => openSync() },
    ask && 'sep',
    { label: 'New session', icon: I.plus, action: () => { openSync().then(newSync); } },
    { label: 'Import session as SLAVE', icon: I.importIn, action: () => importSync() },
    'sep',
  ];
  if (!sy.pairs.length) items.push({ label: 'Connect', icon: I.plugged, disabled: true }, { label: 'Disconnect', icon: I.unplug, disabled: true });
  if (sy.pairs.length === 1) {
    const p = sy.pairs[0], on = isOn(p);
    items.push({ label: 'Connect', icon: I.plugged, disabled: on, action: () => menuConnect(p, true) },
      { label: 'Disconnect', icon: I.unplug, danger: on, disabled: !on, action: () => menuConnect(p, false) });
  }
  if (many) for (const p of sy.pairs) {
    items.push(isOn(p)
      ? { label: `Disconnect “${p.name}”`, icon: I.unplug, danger: true, action: () => menuConnect(p, false) }
      : { label: `Connect “${p.name}”`, icon: I.plugged, action: () => menuConnect(p, true) });
  }
  items.push('sep');
  // The switch between the FTP client and the LIVE SYNC view is MODE.
  items.push({ label: 'Sessions…', icon: I.list, action: () => openSync(connectedPairs().length ? sy.liveSel : null) });
  showMenu(b.right + 8, b.top, items);
}
async function menuConnect(p, on) {
  if (!on && !(await confirmBox(`Disconnect “${p.name}”?`, 'Nothing more is synced until you connect it again. No file is touched.', 'DISCONNECT', true))) return;
  const r = await API.syncConnect(p.id, on);
  if (!r.ok) return toast(r.error, true);
  sy.pairs = r.pairs; sy.status = r.status || {};
  if (on) { sy.liveSel = p.id; sy.liveHidden = false; API.directFast(true); }
  renderSyncBtn(); renderLive();
}
async function openSync(selId) {
  await loadSync();
  if (selId !== undefined && selId !== null) sy.selId = selId;
  if (!sy.selId && sy.pairs.length) sy.selId = sy.pairs[0].id;
  // Nothing yet: CREATE A SESSION or IMPORT SESSION (renderSyncForm).
  syncSelect(sy.pairs.some(p => p.id === sy.selId) ? sy.selId : null);
  $('ov-sync').classList.add('open');
  API.directFast(true);
}
function closeSync() { $('ov-sync').classList.remove('open'); API.directFast(connectedPairs().length > 0 && !sy.liveHidden); }
function syncSelect(id) {
  sy.selId = id;
  const p = sy.pairs.find(x => x.id === id);
  sy.draft = p ? Object.assign({}, p) : null;
  renderSyncList(); renderSyncForm();
}

// ── The settings window: the list ───────────────────────────────────────────
function renderSyncList() {
  const pd = sy.direct.pending || { devices: [], folders: [] };
  const asks = askHtml(pd);
  const siteName = id => { const s = state.sites.find(x => x.id === id); return s ? s.name : 'no bookmark'; };
  $('sy-list').innerHTML = asks + (sy.pairs.length ? sy.pairs.map(p => {
    const err = sessionError(p);
    const dot = err ? 'err' : isOn(p) ? 'on' : '';
    const kind = p.via === 'server' ? `S-FTP · ${esc(siteName(p.siteId))}` : esc(SY_TYPES[p.via][0]);
    return `<div class="sm-item${p.id === sy.selId ? ' sel' : ''}" data-id="${esc(p.id)}"><span class="sy-kic ${SY_LOOK[p.via].cls}">${SY_LOOK[p.via].icon}<i class="dot ${dot}"></i></span><div class="t"><div class="a">${esc(p.name)}</div><div class="b">${kind} · ${esc(sessionSummary(p))}</div></div><button class="ibtn ins sy-del-it" data-del="${esc(p.id)}" data-tip="Delete this session (no file is touched)" aria-label="Delete">${I.trash}</button></div>`;
  }).join('') : (asks ? '' : '<div class="set-desc" style="padding:14px 10px">No session yet.</div>'));
}
function askHtml(pd) {
  return pd.devices.map((d, i) => { const n = splitDev(d.name); return `<div class="sy-ask"><div class="a">${I.link}<span><b>${esc(n.name || 'A computer')}</b>${n.os ? ` (${esc(n.os)})` : ''} wants to connect (SYNCTHING)</span></div>
      <div class="b mono">ID ${esc(d.id)}${d.address ? ` · ${esc(d.address)}` : ''}</div>
      <div class="c"><button class="btn sm" data-ask="refuse" data-i="${i}">REFUSE</button><button class="btn sm go" data-ask="accept" data-i="${i}">ACCEPT</button></div></div>`; }).join('')
    + pd.folders.map((f, i) => `<div class="sy-ask"><div class="a">${I.link}<span><b>${esc(splitDev(f.deviceName).name)}</b> offers “${esc(f.name)}”</span></div>
      <div class="b">${esc(SY_DIR_DIRECT[f.direction][0])}: ${esc(SY_DIR_DIRECT[f.direction][1])}</div>
      <div class="c"><button class="btn sm" data-ask="dismiss" data-i="${i}">NOT NOW</button><button class="btn sm go" data-ask="offer" data-i="${i}">ACCEPT…</button></div></div>`).join('');
}

// ── The settings window: the form ──────────────────────────────────────────
function renderSyncForm() {
  const d = sy.draft, f = $('sy-form');
  const existing = !!(d && d.id);
  $('sy-delete').style.display = 'none';            // each session has its own delete icon in the list
  // Only the MASTER gives the session's config to the other computer.
  $('sy-share').style.display = existing && !isSlave(d) ? '' : 'none';
  const chooser = !d || !d.via;
  $('sy-save').style.display = chooser ? 'none' : '';
  $('sy-run').style.display = chooser ? 'none' : '';
  const live = !!(d && d.id && isOn(sy.pairs.find(x => x.id === d.id)));
  $('sy-run').textContent = live ? 'SAVE' : 'SAVE & CONNECT';
  $('sy-save').style.display = chooser || live ? 'none' : '';
  if (!d) {
    // Nothing chosen: create a session (this computer is then its MASTER), or
    // import the config another computer saved (this one is its SLAVE).
    f.innerHTML = `<div class="m-h1" style="font-size:17px;margin-bottom:4px">LIVE SYNC</div><div class="m-sub" style="margin-bottom:16px">Keep a folder of this computer in step with another computer running filo, or with a folder on a server.</div>
      <div class="sy-types">
        <button class="mbtn sy-type k-direct" id="sy-start-new"><span class="mico">${I.plus}</span><span class="minfo"><span class="mbadge">CREATE A SESSION</span><span class="d">This computer will be the MASTER: its version wins a conflict, its direction and settings are the session's. You then send the other computer the config file (or, for a SYNCTHING session, this computer's SYNCTHING ID).</span></span></button>
        <button class="mbtn sy-type k-server" id="sy-start-import"><span class="mico">${I.importIn}</span><span class="minfo"><span class="mbadge">IMPORT SESSION</span><span class="d">What the MASTER sent: its config file, or, for a SYNCTHING session, its SYNCTHING ID to paste (a DUAL SYNC session can also be found on its server). This computer will be the SLAVE.</span></span></button>
      </div>`;
    $('sy-start-new').onclick = newSync;
    $('sy-start-import').onclick = importSync;
    return;
  }
  if (!d.via) {
    f.innerHTML = `<div class="m-h1" style="font-size:17px;margin-bottom:4px">New LIVE SYNC session</div><div class="m-sub" style="margin-bottom:16px">How does this computer reach the other side?</div>
      <div class="sy-types">${Object.keys(SY_TYPES).map(k => `<button class="mbtn sy-type ${SY_LOOK[k].cls}" data-v="${k}"><span class="mico">${SY_LOOK[k].icon}</span><span class="minfo"><span class="mbadge">${SY_TYPES[k][0]}</span><span class="d">${esc(SY_TYPES[k][1])}</span></span></button>`).join('')}</div>`;
    f.querySelectorAll('.sy-type').forEach(b => b.onclick = () => { pickType(b.dataset.v); });
    return;
  }
  const st = sy.status[d.id] || {};
  const parts = [];
  parts.push(`<div class="sy-kind"><span class="sy-badge ${SY_LOOK[d.via].cls}">${SY_LOOK[d.via].icon}${esc(SY_TYPES[d.via][0])}</span>${existing ? '' : `<button class="ibtn ins" id="sy-kind-change" data-tip="Choose another kind of session" aria-label="Change the kind">${I.swap}</button>`}${roleOf(d) ? `<span class="sy-role ${isSlave(d) ? 'slave' : 'master'}">${isSlave(d) ? I_FOLLOW : I_CROWN}${roleOf(d)} MODE</span>` : ''}${existing && connectedPairs().some(x => x.id === d.id) ? '<span class="badge g">CONNECTED</span>' : ''}</div>`);
  const ro = isSlave(d) ? ' disabled' : '';
  if (existing && sessionError(d)) parts.push(`<div class="sy-status"><span class="err">${esc((st.state === 'error' ? st.error : st.server && st.server.error) || '')}</span></div>`);
  parts.push(`<div class="field"><label>Session name</label><input id="sy-name" value="${esc(d.name)}"${ro}></div>`);
  if (d.via === 'server') parts.push(bookmarkField(d));
  const labels = d.via === 'server' ? SY_DIR : SY_DIR_DIRECT;
  parts.push(`<div class="field"><label>Direction</label><div class="modes-row${ro ? ' ro' : ''}" id="sy-dir">${Object.keys(labels).map(k => `<button data-v="${k}"${ro} class="mbtn ${SY_DIR_LOOK[k].cls}${d.direction === k ? ' on' : ''}"><span class="mico">${SY_DIR_LOOK[k].icon}</span><span class="mbadge">${labels[k][0]}</span><span class="msel">Selected</span></button>`).join('')}</div>
    <div class="hint">${esc(labels[d.direction][1])}</div></div>`);
  parts.push(`<div class="field"><label>Local folder</label><div class="inline"><input id="sy-local" value="${esc(d.local)}" spellcheck="false" placeholder="${isMac() ? '/Volumes/…' : API.platform === 'win32' ? 'D:\\…' : '/home/…'}"><button class="ibtn ins" id="sy-local-pick" data-tip="Choose the folder" aria-label="Choose the folder">${I.folder}</button></div></div>`);
  if (d.via === 'hybrid') {
    parts.push('<div class="sy-sub">S-FTP BACKUP</div>');
    parts.push(bookmarkField(d));
  }
  if (d.via !== 'direct') {
    // The SLAVE uses the MASTER's S-FTP folder (its own bookmark, though: its password).
    parts.push(`<div class="field"><label>S-FTP folder</label><div class="inline"><input id="sy-remote" value="${esc(d.remote)}" spellcheck="false" placeholder="/"${ro}><button class="ibtn ins" id="sy-remote-pick"${d.siteId && !ro ? '' : ' disabled'} data-tip="Browse the folders of the server" aria-label="Browse the server">${I.folder}</button></div></div>`);
    parts.push(watchField(d));
  }
  if (existing && d.via !== 'server') {
    const n = splitDev(d.peer && d.peer.name);
    parts.push(`<div class="field"><label>Remote computer</label>${d.peer ? `<div class="sy-peer"><b>${esc(n.name || shortDev(d.peer.id))}</b><span class="mono sy-dim">${esc(d.peer.id)}</span><button class="ibtn ins" data-idact="copy" data-id="${esc(d.peer.id)}" data-tip="Copy the ID" aria-label="Copy the ID">${I.copy}</button></div>` : '<div class="v sy-dim">Not linked yet</div>'}</div>`);
  }
  parts.push(`<div class="field"><label>File filter</label>${filterChips(d.exclude, !!ro)}</div>`);
  f.innerHTML = parts.join('');
  const bind = (id, key, ev) => { const el = $(id); if (el) el.addEventListener(ev || 'input', () => { d[key] = el.type === 'checkbox' ? el.checked : el.value; }); };
  bind('sy-name', 'name'); bind('sy-local', 'local'); bind('sy-remote', 'remote');
  bindFilterChips(f, v => { d.exclude = v; });
  if ($('sy-kind-change')) $('sy-kind-change').onclick = () => { d.via = null; renderSyncForm(); };
  $('sy-dir').onclick = ev => { const b = ev.target.closest('button'); if (!b || b.disabled) return; d.direction = b.dataset.v; renderSyncForm(); };
  $('sy-local-pick').onclick = async () => { const p = await API.pickFolder(d.local || undefined); if (p) { d.local = p; $('sy-local').value = p; } };
  if ($('sy-site')) $('sy-site').onchange = () => { d.siteId = $('sy-site').value; renderSyncForm(); };
  if ($('sy-remote-pick')) $('sy-remote-pick').onclick = async () => { const p = await pickRemoteFolder(d.siteId, d.remote); if (p) { d.remote = p; $('sy-remote').value = p; } };
  if ($('sy-watch')) $('sy-watch').onchange = () => { d.watch = $('sy-watch').checked; renderSyncForm(); };
  if ($('sy-every')) $('sy-every').onchange = () => {
    const v = $('sy-every').value;
    if (v === 'custom') { d.customEvery = true; renderSyncForm(); const n = $('sy-every-n'); if (n) { n.focus(); n.select(); } return; }
    d.customEvery = false; d.interval = Number(v);
  };
  if ($('sy-every-n')) $('sy-every-n').addEventListener('input', () => { d.interval = Math.max(1, Math.min(1440, parseInt($('sy-every-n').value, 10) || 1)); });
}
// FILE FILTER as chips (Noar, 12/10/2026, syncto's look): one chip per
// pattern, × to remove it, a field and ADD. A bare word is an extension:
// "tmp" → *.tmp (shown ".tmp"). Kept as one text, separated by commas.
// filo's own work files are always left out (main: SYNC_ALWAYS_EXCLUDE):
// not shown, not kept in the list.
const FILTER_HIDDEN = new Set(['*.filopart', '*.filoold', '.*.filoparts']);
const splitFilter = t => String(t || '').split(/[,;|\n\r]+/).map(x => x.trim()).filter(x => x && !FILTER_HIDDEN.has(x));
const chipLabel = x => (/^\*\.[^*?/\\]+$/.test(x) ? x.slice(1) : x);
function filterChips(text, ro) {
  const list = splitFilter(text);
  return `<div class="chips" data-ro="${ro ? 1 : 0}">${list.map((x, i) => `<span class="chip mono" data-tip="${esc(x)}">${esc(chipLabel(x))}${ro ? '' : `<button data-chip="${i}" aria-label="Remove">×</button>`}</span>`).join('')}
    ${ro ? '' : '<div class="chip-add"><input id="chip-in" class="mono" spellcheck="false" placeholder="e.g. aep"><button class="btn sm" id="chip-go">ADD</button></div>'}</div>`;
}
function bindFilterChips(root, onChange) {
  const box = root.querySelector('.chips');
  if (!box || box.dataset.ro === '1') return;
  const redraw = list => { const v = list.join(', '); onChange(v); box.outerHTML = filterChips(v, false); bindFilterChips(root, onChange); const n = root.querySelector('#chip-in'); if (n) n.focus(); };
  const current = () => [...box.querySelectorAll('.chip')].map(c => c.dataset.tip);
  box.querySelectorAll('[data-chip]').forEach(b => b.onclick = () => { const l = current(); l.splice(+b.dataset.chip, 1); redraw(l); });
  const add = () => {
    const raw = box.querySelector('#chip-in').value.trim().replace(/,/g, '');
    if (!raw) return;
    // An extension, with or without its dot ("aep", ".aep"): *.aep. Anything
    // else (a name, a folder, a pattern) as typed.
    const ext = /^\.?([^.*?/\\\s]+)$/.exec(raw);
    const pat = ext ? '*.' + ext[1] : raw;
    const l = current();
    if (!l.includes(pat)) l.push(pat);
    redraw(l);
  };
  box.querySelector('#chip-go').onclick = add;
  box.querySelector('#chip-in').onkeydown = ev => { if (ev.key === 'Enter') { ev.preventDefault(); add(); } };
}
function bookmarkField(d) {
  const site = state.sites.find(s => s.id === d.siteId);
  const askEach = site && (site.logon === 'ask' || (site.logon === 'normal' && !site.hasPassword));
  return `<div class="field"><label>Bookmark (server)</label><select id="sy-site"><option value="">Choose…</option>${state.sites.map(s => `<option value="${esc(s.id)}"${s.id === d.siteId ? ' selected' : ''}>${esc(s.name)} · ${esc(PROTO_INFO[s.protocol] ? PROTO_INFO[s.protocol][0] : s.protocol)}</option>`).join('')}</select>
    ${askEach ? '<div class="hint" style="color:var(--orange)">This bookmark asks for its password each time: the session cannot run on its own. Save its password in the site manager, or use a key.</div>' : ''}
    ${!state.sites.length ? '<div class="hint">No bookmark yet: add the server in the site manager (SITES) first.</div>' : ''}</div>`;
}
function watchField(d) {
  const custom = d.customEvery || !SY_INTERVALS.includes(Number(d.interval));
  const opts = SY_INTERVALS.map(m => `<option value="${m}"${!custom && Number(d.interval) === m ? ' selected' : ''}>${m < 60 ? m + ' min' : (m / 60) + ' h'}</option>`).join('') + `<option value="custom"${custom ? ' selected' : ''}>Custom…</option>`;
  const every = `<select id="sy-every" class="sm">${opts}</select>${custom ? `<input type="number" id="sy-every-n" min="1" max="1440" value="${esc(d.interval)}"><span>min</span>` : ''}`;
  return `<div class="field"><label>Auto watch</label><div class="sy-auto"><label class="switch" data-tip="Send a change as soon as it happens here"><input type="checkbox" id="sy-watch"${d.watch !== false ? ' checked' : ''}><span class="slider"></span></label>
    <span data-tip="How often both sides are checked">${every}</span></div></div>`;
}
function newSync() {
  sy.selId = null;
  sy.draft = { via: null };
  renderSyncList(); renderSyncForm();
}
function pickType(via) {
  const siteId = state.conn && String(state.conn.endpointId || '').startsWith('site:') ? state.conn.endpointId.slice(5) : (state.sites[0] ? state.sites[0].id : '');
  const prev = sy.draft || {};
  sy.draft = Object.assign({ name: 'New session', siteId, local: '', remote: state.conn && panels.remote.dir ? panels.remote.dir : '/', direction: 'both', auto: false, watch: true, interval: 5, exclude: sy.defaultExclude || '' }, prev.name ? prev : {}, { via });
  renderSyncForm();
  const n = $('sy-name'); if (n) { n.focus(); n.select(); }
}
async function saveSync() {
  const d = sy.draft;
  if (!d || !d.via) return null;
  if (d.via !== 'direct' && !d.siteId) { toast('Choose the bookmark (server).', true); return null; }
  if (!d.local) { toast('Choose the local folder.', true); return null; }
  const r = await API.syncSave(Object.assign({}, d, { interval: Number(d.interval) || 5 }));
  if (r.ok === false) { toast(r.error, true); return null; }
  sy.pairs = r.pairs; sy.status = r.status || {};
  sy.selId = r.pair.id; sy.draft = Object.assign({}, r.pair);
  renderSyncList(); renderSyncForm(); renderSyncBtn(); renderLive();
  return r.pair;
}
// SAVE & CONNECT: the session runs, the window closes, the LIVE SYNC view
// shows it. SYNCTHING not linked yet: first what to send to the remote computer.
async function connectSync() {
  const p = await saveSync();
  if (!p) return;
  if (!p.auto) {
    const r = await API.syncConnect(p.id, true);
    if (!r.ok) return toast(r.error, true);
    sy.pairs = r.pairs; sy.status = r.status || {};
  }
  const pair = sy.pairs.find(x => x.id === p.id) || p;
  // FAILSAFE: the config file at once (it carries the server). SYNCTHING: the
  // LIVE SYNC view offers both ways (the remote computer's ID, or the file).
  if (pair.via === 'hybrid' && !pair.peer) await showShareInfo(pair);
  sy.liveSel = pair.id; sy.liveHidden = false;
  closeSync();
  renderSyncBtn(); renderLive();
}

// BROWSE in the S-FTP folder field: a small folder picker on the bookmark.
// remoteBrowser fills a box (path + list) and reports the folder shown.
function remoteBrowser(c, siteId, start, onDir) {
  const load = async dir => {
    const box = c.querySelector('.rp-list');
    box.innerHTML = '<div class="sy-dim" style="padding:10px">Connecting…</div>';
    const r = await API.syncRemoteList(siteId(), dir);
    if (!r.ok) { box.innerHTML = `<div class="err-list">${esc(r.error)}</div>`; return; }
    const cur = r.dir;
    onDir(cur);
    c.querySelector('.rp-path').textContent = cur;
    const parent = cur === '/' ? null : (cur.replace(/\/+$/, '').replace(/\/[^/]*$/, '') || '/');
    box.innerHTML = (parent ? `<div class="rp-it" data-p="${esc(parent)}">${I.folder}<span>..</span></div>` : '')
      + (r.dirs.length ? r.dirs.map(n => `<div class="rp-it" data-p="${esc((cur.endsWith('/') ? cur : cur + '/') + n)}">${I.folder}<span>${esc(n)}</span></div>`).join('') : '<div class="sy-dim" style="padding:10px">No folder inside.</div>');
  };
  const list = c.querySelector('.rp-list');
  list.addEventListener('dblclick', ev => { const it = ev.target.closest('.rp-it'); if (it) load(it.dataset.p); });
  list.addEventListener('click', ev => { const it = ev.target.closest('.rp-it'); if (!it) return; c.querySelectorAll('.rp-it.sel').forEach(x => x.classList.remove('sel')); it.classList.add('sel'); });
  load(start && start !== '/' ? start : '');
  return load;
}
async function pickRemoteFolder(siteId, start) {
  if (!siteId) { toast('Choose the bookmark first.', true); return null; }
  let cur = null;
  return dialog({
    title: 'Choose the S-FTP folder',
    html: '<div class="rp-path mono">…</div><div class="rp-list"></div><div class="hint">Double-click a folder to open it.</div>',
    buttons: [{ label: 'CANCEL', value: null }, { spacer: true }, { label: 'CHOOSE THIS FOLDER', cls: 'go', value: () => cur || undefined }],
    width: 560,
    onOpen: c => remoteBrowser(c, () => siteId, start, d => { cur = d; }),
  });
}

async function showShareInfo(pair) {
  const r = await API.syncShare(pair.id);
  if (!r.ok) return toast(r.error, true);
  const sh = r.share;
  const me = splitDev(sh.deviceName);
  const fsv = sh.failsafe;
  const res = await dialog({
    title: 'The config for the other computer',
    sub: `Save it, and send the file to the other computer yourself (mail, Signal, a USB key…). There, filo opens right-click LIVE SYNC (side bar) → Import session as SLAVE. It becomes the SLAVE of “${esc(pair.name)}”; this computer is the MASTER. Then accept it here when filo asks.`,
    html: `<div class="sy-kv"><div class="k">Session</div><div class="v">${esc(pair.name)} · ${esc(SY_TYPES[pair.via][0])}</div>
        <div class="k">MASTER</div><div class="v">${esc(me.name)}${me.os ? ` · ${esc(me.os)}` : ''} <span class="mono sy-dim">${esc(shortDev(sh.device))}</span></div>
        <div class="k">For the SLAVE</div><div class="v">${esc(SY_DIR_DIRECT[sh.direction][0])}</div>
        ${fsv ? `<div class="k">S-FTP BACKUP</div><div class="v mono">${esc(fsv.server.protocol.toUpperCase())} · ${esc(fsv.server.user ? fsv.server.user + '@' : '')}${esc(fsv.server.host)}:${esc(fsv.server.port)} · ${esc(fsv.remote)}</div>
        <div class="k">Password</div><div class="v">not in the file: the SLAVE types it when it imports</div>` : ''}
        <div class="k">Secret</div><div class="v">none inside: the other computer is accepted here, by hand</div></div>`,
    buttons: [{ label: 'CLOSE', value: null }, { spacer: true }, { label: 'SAVE CONFIG FILE…', value: 'file', cls: 'go' }],
    width: 620,
  });
  if (res === 'file') {
    const f = await API.syncShareSave(pair.id);
    if (!f.ok) { if (!f.cancelled) toast(f.error, true); return; }
    await configSaved(f.path, 'Send this file to the other computer yourself (mail, Signal, a USB key…).');
  }
}
// After SAVE CONFIG FILE: where it is, and the ways to send it.
async function configSaved(file, what) {
  const v = await dialog({
    title: 'Config saved', sub: `<span class="mono" style="font-size:11.5px">${esc(file)}</span><br>${esc(what)}`,
    buttons: [{ label: 'OK', value: null }, { spacer: true }, { label: 'SHOW IN FOLDER', value: 'show', cls: isMac() ? '' : 'go' }].concat(isMac() ? [{ label: 'SHARE…', value: 'share', cls: 'go' }] : []),
  });
  if (v === 'show') API.syncShareReveal(file);
  if (v === 'share') API.syncShareNative(file);
}
// SHARE: SYNCTHING sessions show what to send; S-FTP sessions give the session
// to another team (they receive what you send).
async function shareSync() {
  const d = sy.draft;
  if (!d || !d.id) return;
  if (isDirectish(d)) return showShareInfo(d);
  const r = await API.syncShare(d.id);
  if (!r.ok) return toast(r.error, true);
  const other = SY_DIR[r.share.direction][0];
  const res = await dialog({
    title: `Share “${esc(d.name)}”`,
    sub: `The other team imports it in filo (right-click LIVE SYNC (side bar) → Import session as SLAVE), types the server password and picks its own folder. For them, this session is <b>${esc(other)}</b>.`,
    html: `<div class="sy-kv"><div class="k">Server</div><div class="v mono">${esc(PROTO_INFO[r.share.server.protocol][0])} · ${esc(r.share.server.user ? r.share.server.user + '@' : '')}${esc(r.share.server.host)}:${esc(r.share.server.port)}</div>
        <div class="k">S-FTP folder</div><div class="v mono">${esc(r.share.remote)}</div>
        <div class="k">Password</div><div class="v">not included: give it to them another way</div></div>
      `,
    buttons: [{ label: 'CLOSE', value: null }, { spacer: true }, { label: 'SAVE CONFIG FILE…', value: 'file', cls: 'go' }],
    width: 600,
  });
  if (res === 'file') {
    const f = await API.syncShareSave(d.id);
    if (!f.ok) { if (!f.cancelled) toast(f.error, true); return; }
    await configSaved(f.path, 'Send this file to the other team yourself (mail, Signal, a shared folder…). The password is not in it.');
  }
}

// ── IMPORT ──────────────────────────────────────────────────────────────────
async function importSync() {
  const how = await dialog({
    title: 'Import session',
    sub: 'What the MASTER sent: its config file (<span class="mono">.filosync</span>), or, for a SYNCTHING session, its SYNCTHING ID. For a DUAL SYNC session, filo can also find the config in the S-FTP folder, where the MASTER leaves it. This computer will be the SLAVE.',
    buttons: [{ label: 'CANCEL', value: null }, { spacer: true }, { label: 'FIND ON A SERVER…', value: 'server' }, { label: 'PASTE A SYNCTHING ID…', value: 'id' }, { label: 'OPEN THE CONFIG FILE…', value: 'file', cls: 'go' }],
    width: 640,
  });
  if (!how) return;
  if (how === 'id') return pasteDirectId();
  let r;
  if (how === 'server') {
    const at = await findOnServer();
    if (!at) return;
    r = await API.syncRemoteSession(at.siteId, at.dir);
  } else r = await API.syncImportRead(null);
  if (!r.ok) { if (!r.cancelled) errorBox('Not imported', r.error); return; }
  if (r.direct) return importDirect(r);
  const sh = r.share, sv = sh.server;
  const needPw = !(r.site && r.site.hasPassword) && sv.user && sv.user !== 'anonymous';
  const res = await dialog({
    title: `Import “${esc(sh.name)}” (S-FTP)`,
    sub: `<b>${esc(SY_DIR[sh.direction][0])}</b>: ${esc(SY_DIR[sh.direction][1])}`,
    html: `${serverKv(sv, sh.remote, r)}
      ${needPw ? `<div class="field"><label>Server password${r.vault ? ' (kept in the keychain of this machine)' : ''}</label><input type="password" id="syi-pw" autocomplete="off"></div>` : ''}
      ${localPickHtml()}
      <label class="chk"><input type="checkbox" id="syi-auto" checked> Connect now</label>`,
    buttons: [{ label: 'CANCEL', value: null }, { spacer: true }, { label: 'IMPORT', cls: 'go', value: c => {
      const local = c.querySelector('#syi-local').value.trim();
      if (!local) { toast('Choose your local folder.', true); return undefined; }
      const pw = c.querySelector('#syi-pw');
      if (pw && !pw.value) { toast('Type the server password.', true); return undefined; }
      return { local, password: pw ? pw.value : undefined, auto: c.querySelector('#syi-auto').checked };
    } }],
    width: 600,
    onOpen: bindLocalPick,
  });
  if (!res) return;
  const done = await API.syncImportApply({ share: sh, local: res.local, password: res.password, auto: res.auto });
  afterImport(done);
}
// SYNCTHING, the quick way: the MASTER's SYNCTHING ID, pasted here. This computer
// asks the MASTER to connect; the MASTER accepts it and shares its session,
// offered here (a folder to choose).
async function pasteDirectId() {
  const text = await dialog({
    title: 'Paste the MASTER\'s SYNCTHING ID',
    sub: 'The MASTER shows it in its LIVE SYNC view (REMOTE COMPUTER), or in right-click LIVE SYNC (side bar) → Sessions… → THIS COMPUTER. SYNCTHING sessions only: a DUAL SYNC session goes by its config file.',
    html: '<div class="field"><label>SYNCTHING ID of the MASTER</label><input id="pid-text" class="mono" spellcheck="false" autocomplete="off" placeholder="XXXXXXX-XXXXXXX-XXXXXXX-XXXXXXX-…"></div>',
    buttons: [{ label: 'CANCEL', value: null }, { spacer: true }, { label: 'CONNECT', cls: 'go', value: c => c.querySelector('#pid-text').value.trim() || undefined }],
    width: 600, focus: '#pid-text',
  });
  if (!text) return;
  const r = await API.directJoin(text);
  if (!r.ok) return errorBox('Not connected', r.error);
  // The MASTER's answer, then its session, arrive in the sessions window.
  if (!$('ov-sync').classList.contains('open')) await openSync();
  sy.pairs = r.pairs; sy.status = r.status || {};
  if (r.myId) sy.myId = r.myId;
  renderSyncList(); renderSyncBtn();
  await dialog({
    title: 'Asked to the MASTER',
    sub: `On the MASTER, filo now shows that this computer wants to connect (its ID starts with <b class="mono">${esc(shortDev(r.myId))}</b>). It accepts it and chooses the session to share. The session is then offered here: accept it, and choose your folder. Both filo must stay open meanwhile.`,
    buttons: [{ spacer: true }, { label: 'OK', value: true, cls: 'go' }],
  });
}
// FAILSAFE: the bookmark and the S-FTP folder where the MASTER left its session.
async function findOnServer() {
  if (!state.sites.length) { errorBox('No bookmark', 'Add the server in the site manager (SITES) first, with its password or key.'); return null; }
  let cur = null;
  return dialog({
    title: 'Find the session on a server',
    sub: 'Choose the bookmark of the DUAL SYNC server, then open the S-FTP folder of the session (double-click).',
    html: `<div class="field"><label>Bookmark</label><select id="fos-site">${state.sites.map(s => `<option value="${esc(s.id)}">${esc(s.name)} · ${esc(PROTO_INFO[s.protocol] ? PROTO_INFO[s.protocol][0] : s.protocol)}</option>`).join('')}</select></div>
      <div class="rp-path mono">…</div><div class="rp-list"></div>`,
    buttons: [{ label: 'CANCEL', value: null }, { spacer: true }, { label: 'LOOK IN THIS FOLDER', cls: 'go', value: c => (cur ? { siteId: c.querySelector('#fos-site').value, dir: cur } : undefined) }],
    width: 560,
    onOpen: c => {
      const sel = c.querySelector('#fos-site');
      const load = remoteBrowser(c, () => sel.value, '', d => { cur = d; });
      sel.onchange = () => load('');
    },
  });
}

function serverKv(sv, remote, r) {
  const idText = { none: 'plain FTP: no identity to check (not encrypted)', known: 'already trusted on this machine', unknown: 'not given: it will be shown at the first connection',
    'from-file': `given by the file, trusted when you import: <span class="mono">${esc(sv.fingerprint)}</span>`, same: 'the same as this machine already trusts', different: '<span style="color:var(--red)">DIFFERENT from the one this machine trusts</span>' }[r.identity] || '';
  return `<div class="sy-kv"><div class="k">Server</div><div class="v mono">${esc(PROTO_INFO[sv.protocol][0])} · ${esc(sv.user ? sv.user + '@' : '')}${esc(sv.host)}:${esc(sv.port)}</div>
    <div class="k">S-FTP folder</div><div class="v mono">${esc(remote)}</div>
    <div class="k">Identity</div><div class="v">${idText}</div>
    ${r.site ? `<div class="k">Bookmark</div><div class="v">${esc(r.site.name)} (already in your sites)</div>` : ''}</div>`;
}
function localPickHtml() {
  return `<div class="field"><label>Your local folder</label><div class="inline"><input id="syi-local" spellcheck="false" placeholder="the folder where this session lives on this computer"><button class="ibtn ins" id="syi-pick" data-tip="Choose the folder" aria-label="Choose the folder">${I.folder}</button></div></div>`;
}
function bindLocalPick(c) {
  c.querySelector('#syi-pick').onclick = async () => { const p = await API.pickFolder(c.querySelector('#syi-local').value || undefined); if (p) c.querySelector('#syi-local').value = p; };
}
async function importDirect(r) {
  const sh = r.direct;
  if (!r.available) return errorBox('SYNCTHING', 'SYNCTHING is not in this build of filo: Syncthing was not found when it was built.');
  if (r.fromSelf) return errorBox('Not imported', 'This was made on this computer: import it in filo on the remote computer.');
  if (r.already) return errorBox('Not imported', 'This session is already here.');
  const from = splitDev(sh.deviceName);
  const fsv = sh.failsafe;
  const needPw = fsv && r.server && !(r.server.site && r.server.site.hasPassword) && fsv.server.user && fsv.server.user !== 'anonymous';
  const res = await dialog({
    title: `Import “${esc(sh.name)}”`,
    sub: `From <b>${esc(from.name)}</b>${from.os ? ` (${esc(from.os)})` : ''} <span class="mono">${esc(shortDev(sh.device))}</span>, ${esc(SY_TYPES[fsv ? 'hybrid' : 'direct'][0])}. This computer will be its <b>SLAVE</b>: for it, <b>${esc(SY_DIR_DIRECT[sh.direction][0])}</b>, ${esc(SY_DIR_DIRECT[sh.direction][1]).toLowerCase()}`,
    html: `<div class="field"><label>Session name</label><input id="dfd-name" value="${esc(sh.name)}"></div>
      ${localPickHtml()}
      ${fsv ? `<div class="sy-sub">S-FTP BACKUP</div>${serverKv(fsv.server, fsv.remote, r.server || {})}
        ${needPw ? `<div class="field"><label>Server password${r.server.vault ? ' (kept in the keychain of this machine)' : ''}</label><input type="password" id="syi-pw" autocomplete="off"></div>` : ''}` : ''}
      <div class="hint">Files already in your folder are kept, and sent to the remote computer when the direction allows it. From then on, a file deleted on one computer is deleted on the other too, into its trash (<span class="mono">.filo-trash</span>): never lost.</div>`,
    buttons: [{ label: 'CANCEL', value: null }, { spacer: true }, { label: 'IMPORT & CONNECT', cls: 'go', value: c => {
      const local = c.querySelector('#syi-local').value.trim();
      if (!local) { toast('Choose your local folder.', true); return undefined; }
      const pw = c.querySelector('#syi-pw');
      if (pw && !pw.value) { toast('Type the server password.', true); return undefined; }
      return { local, name: c.querySelector('#dfd-name').value.trim() || sh.name, password: pw ? pw.value : undefined };
    } }],
    width: 620, focus: '#syi-local',
    onOpen: bindLocalPick,
  });
  if (!res) return;
  const done = await API.syncImportApply({ direct: Object.assign({}, sh, { name: res.name }), local: res.local, password: res.password, auto: true });
  if (!done.ok) return errorBox('Not imported', done.error);
  afterImport(done, `Now, on <b>${esc(from.name)}</b>: filo shows that this computer wants to connect. Accept it there, and the files start. Both filo must be open.`);
}
function afterImport(done, note) {
  if (!done.ok) return errorBox('Not imported', done.error);
  if (done.sites) state.sites = done.sites;
  sy.pairs = done.pairs; sy.status = done.status || {};
  renderSyncBtn();
  if (isOn(done.pair)) { sy.liveSel = done.pair.id; sy.liveHidden = false; closeSync(); renderLive(); }
  else syncSelect(done.pair.id);
  if (done.warn) errorBox('Imported, with a limit', done.warn);
  else if (note) dialog({ title: `“${esc(done.pair.name)}” imported`, sub: note, buttons: [{ label: 'OK', value: true, cls: 'go' }] });
  else toast(`“${done.pair.name}” imported`);
}

// ── SYNCTHING: another computer asks, or offers a session ──────────────────────
async function onAsk(kind, i) {
  const pd = sy.direct.pending;
  if (kind === 'accept' || kind === 'refuse') {
    const d = pd.devices[i];
    if (!d) return;
    const n = splitDev(d.name);
    if (kind === 'refuse') {
      if (!(await confirmBox(`Refuse “${n.name || shortDev(d.id)}”?`, 'This computer will not be able to connect to this filo. Only accept a computer you know (yours, or one you sent a session to).', 'REFUSE', true))) return;
      const r = await API.directRefuse(d); if (!r.ok) return toast(r.error, true);
    } else {
      // The SYNCTHING sessions this MASTER could share with it (it pasted this
      // computer's SYNCTHING ID). One waiting: ticked already.
      const open = sy.pairs.filter(p => p.via === 'direct' && !isSlave(p) && !p.peer);
      const share = await dialog({
        title: `Accept “${esc(n.name || shortDev(d.id))}”?`,
        sub: 'Accept it only if it is your own computer, or the one you sent a config file or this computer\'s SYNCTHING ID to.',
        html: `<div class="sy-kv"><div class="k">Computer</div><div class="v">${esc(n.name)}${n.os ? ` · ${esc(n.os)}` : ''}</div><div class="k">ID</div><div class="v mono">${esc(d.id)}</div>${d.address ? `<div class="k">From</div><div class="v mono">${esc(d.address)}</div>` : ''}</div>
          <div class="hint">To be sure: on the remote computer, right-click LIVE SYNC (side bar) → Sessions… → THIS COMPUTER shows its ID. The first group (<b class="mono">${esc(shortDev(d.id))}</b>) must be the same.</div>
          ${open.length ? `<div class="sy-sub">Share with it <span>it becomes the SLAVE</span></div>${open.map(p => `<label class="chk"><input type="checkbox" data-share="${esc(p.id)}"${open.length === 1 ? ' checked' : ''}> ${esc(p.name)} <span class="sy-dim">· ${esc(SY_DIR_DIRECT[p.direction][0])}</span></label>`).join('')}
          <div class="hint">A session it imported from a config file links by itself: leave it unticked.</div>` : ''}`,
        buttons: [{ label: 'CANCEL', value: null }, { spacer: true }, { label: 'ACCEPT', cls: 'go', value: c => [...c.querySelectorAll('[data-share]:checked')].map(x => x.dataset.share) }], width: 600,
      });
      if (!share) return;
      const r = await API.directAccept({ id: d.id, name: d.name }, share); if (!r.ok) return toast(r.error, true);
      if (r.pairs) { sy.pairs = r.pairs; sy.status = r.status || sy.status; }
      toast(share.length ? `${n.name || shortDev(d.id)} accepted: the session is offered to it` : `${n.name || shortDev(d.id)} accepted`);
    }
    pd.devices = pd.devices.filter(x => x !== d);
  } else {
    const f = pd.folders[i];
    if (!f) return;
    if (kind === 'dismiss') { await API.directOfferDismiss({ folderId: f.folderId, deviceId: f.deviceId }); pd.folders = pd.folders.filter(x => x !== f); }
    else {
      const from = splitDev(f.deviceName);
      const res = await dialog({
        title: `“${esc(f.name)}” from ${esc(from.name)}`,
        sub: `SYNCTHING. This computer will be its <b>SLAVE</b>: for it, <b>${esc(SY_DIR_DIRECT[f.direction][0])}</b>, ${esc(SY_DIR_DIRECT[f.direction][1]).toLowerCase()}`,
        html: `<div class="field"><label>Session name</label><input id="dfd-name" value="${esc(f.name)}"></div>${localPickHtml()}`,
        buttons: [{ label: 'CANCEL', value: null }, { spacer: true }, { label: 'ACCEPT & CONNECT', cls: 'go', value: c => {
          const local = c.querySelector('#syi-local').value.trim();
          if (!local) { toast('Choose your local folder.', true); return undefined; }
          return { local, name: c.querySelector('#dfd-name').value.trim() || f.name };
        } }],
        width: 600, focus: '#syi-local', onOpen: bindLocalPick,
      });
      if (!res) return;
      const r = await API.directOfferAccept({ folderId: f.folderId, deviceId: f.deviceId, local: res.local, name: res.name });
      if (!r.ok) return errorBox('Not accepted', r.error);
      sy.pairs = r.pairs; sy.status = r.status || {};
      pd.folders = pd.folders.filter(x => x !== f);
      sy.liveSel = r.pair.id; sy.liveHidden = false;
      if ($('ov-sync').classList.contains('open')) closeSync();
      toast(`“${r.pair.name}” accepted`);
    }
  }
  renderSyncList(); renderSyncBtn(); renderLive();
}
// THIS COMPUTER: its SYNCTHING ID, and the remote computers it knows.
async function openDirectInfo() {
  const r = await API.directInfo(true);
  if (!r.available) return errorBox('SYNCTHING', 'SYNCTHING is not in this build of filo: Syncthing was not found when it was built. The build log says why (the [direct] lines).');
  if (r.error) return errorBox('SYNCTHING could not start', r.error);
  const me = splitDev(r.name);
  const devs = r.devices.length ? r.devices.map(d => { const n = splitDev(d.name); return `<div class="sy-dev"><div><b>${esc(n.name || shortDev(d.id))}</b>${n.os ? ` · ${esc(n.os)}` : ''} <span class="mono sy-dim">${esc(shortDev(d.id))}</span><div class="sy-dim">${d.link && d.link.connected ? esc(directLink(d.link)) + (peerAddress(d.link) ? ` · <span class="mono">${esc(peerAddress(d.link))}</span>` : '') : 'not connected'} · ${plural(d.used, 'session')}</div></div><button class="ibtn ins" data-forget="${esc(d.id)}" data-tip="Forget this computer: it can no longer connect" aria-label="Forget">${I.trash}</button></div>`; }).join('') : '<div class="sy-dim">None yet. Connect a SYNCTHING session, or import what another computer sent you.</div>';
  await dialog({
    title: 'This computer (SYNCTHING)',
    sub: 'SYNCTHING sessions go from one filo to another, peer to peer: no server, through the two internet boxes when needed (or a relay when no direct path exists). The data is encrypted end to end.',
    html: `<div class="sy-kv"><div class="k">Name</div><div class="v">${esc(me.name)}${me.os ? ` · ${esc(me.os)}` : ''}</div>${r.port ? `<div class="k">Port</div><div class="v mono">${esc(r.port)} (TCP and UDP)</div>` : ''}</div>
      ${idBlock(r.id, me.name)}
      <div class="m-sub" style="margin:14px 0 6px">Remote computers accepted</div><div id="dd-list">${devs}</div>
      <div class="hint" style="margin-top:12px">filo uses Syncthing ${esc(r.version)} (MPL-2.0, syncthing.net), shipped with filo as a separate program.</div>`,
    buttons: [{ spacer: true }, { label: 'CLOSE', value: true, cls: 'go' }],
    width: 640,
    onOpen: c => { c.addEventListener('click', ev => { const b = ev.target.closest('[data-idact]'); if (b) idAction(b.dataset.idact, b.dataset.id, b.dataset.name); }); c.querySelectorAll('[data-forget]').forEach(b => b.onclick = async () => {
      const x = await API.directForget(b.dataset.forget);
      if (!x.ok) return toast(x.error, true);
      b.closest('.sy-dev').remove(); toast('Forgotten');
    }); },
  });
}

// ── The LIVE SYNC view (main window) ────────────────────────────────────────
// Only what changed is written again: a card rebuilt every second loses the
// hover of its tooltip and, sometimes, a click between press and release.
// The SYNCTHING queue (direct.js _pairQueue, every 2 s while the view is
// shown): the files moving now with their progress, the ones waiting, the
// last ones arrived or sent.
const ST_UP = SVG('<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>'), ST_DOWN = SVG('<path d="M19 12H5"/><path d="m12 19-7-7 7-7"/>');
function renderStQueue() {
  const p = sy.pairs.find(x => x.id === sy.liveSel);
  // The mirror's copies run in filo's own queue: shown there while they go.
  const on = document.body.classList.contains('live-on') && p && sessionMode(p) === 'SYNCTHING' && !mirroring(p, sy.status[p.id] || {});
  document.body.classList.toggle('live-st', !!on);
  if (!on) return;
  const q = (sy.q || {})[p.id] || { items: [], done: [] };
  // The SYNCTHING queue in its mode's colour (SYNCTHING blue, DUAL SYNC blue to violet).
  const QC = QUEUE_COLORS[p.via] || QUEUE_COLORS.direct;
  $('st-panel').style.setProperty('--q-fill', QC.fill);
  const peer = p.peer ? splitDev(p.peer.name).name || shortDev(p.peer.id) : 'the remote computer';
  // PAUSE / RESUME (Noar, 12/10/2026), as the FTP queue's buttons.
  const held = (sy.status[p.id] || {}).state === 'held';
  const hb = $('st-hold');
  hb.style.setProperty('--q-color', QC.c);
  hb.classList.toggle('held', held);
  const hk = held ? 'play' : 'pause';
  if (hb.dataset.k !== hk) { hb.dataset.k = hk; hb.innerHTML = I[hk]; }
  hb.setAttribute('aria-label', held ? 'Resume' : 'Pause');
  hb.dataset.tip = held ? 'RESUME: SYNCTHING moves the files again' : 'PAUSE: SYNCTHING stops moving files on this computer, the session stays connected. RESUME carries on where it stopped (filo restarted resumes it).';
  const row = it => {
    const up = it.dir === 'up', done = it.status === 'done', failed = it.status === 'failed';
    const pct = done ? 100 : it.size ? Math.min(100, (it.done || 0) * 100 / it.size) : 0;
    const badge = failed ? '<span class="badge r">Failed</span>' : done ? `<span class="badge g">${up ? 'Sent' : 'Received'}</span>` : it.status === 'running' ? `<span class="badge g">${up ? 'Sending' : 'Receiving'}</span>` : '<span class="badge n">Queued</span>';
    const i = it.rel.lastIndexOf('/'), name = it.rel.slice(i + 1), dir = i > 0 ? it.rel.slice(0, i) : '';
    return `<div class="qrow${done ? ' dim' : ''}"><div class="qr-top"><span class="pc">${it.status === 'queued' ? '' : fmtPct(pct)}</span><span class="dirc">${up ? ST_UP : ST_DOWN}</span>
      <span class="nm" data-tip="${esc(it.rel)}">${esc(name)}</span><span class="meta">${esc([it.size ? fmtSize(it.size) : '', (up ? 'to ' : 'from ') + peer].filter(Boolean).join(' · '))}</span><span class="st">${badge}</span></div>
      <div class="qbar"><i class="${failed ? 'r' : ''}" style="width:${pct.toFixed(2)}%"></i></div>
      <div class="qr-sub"><span class="l">${esc(dir || '/')}</span>${it.at ? `<span class="tm">${fmtTime(it.at)}</span>` : ''}</div></div>`;
  };
  const moving = q.items.filter(x => x.status === 'running'), waiting = q.items.filter(x => x.status !== 'running');
  const left = q.items.reduce((a, x) => a + Math.max(0, (x.size || 0) - (x.done || 0)), 0);
  setHTML($('st-stats'), q.items.length ? esc(`${moving.length} moving · ${waiting.length} waiting · ${fmtSize(left)} left`) : '');
  setHTML($('st-list'), q.items.length || q.done.length ? q.items.concat(q.done).map(row).join('') : `<div class="st-empty">${held ? 'Paused: nothing moves until RESUME.' : 'Nothing to sync: both computers are up to date.'}</div>`);
}
function setHTML(el, html) { if (el && el._h !== html) { el._h = html; el.innerHTML = html; } }
// MODE sits at the same place in both views: the quick bar, or the head of
// the LIVE SYNC view.
function placeMode() {
  const live = document.body.classList.contains('live-on');
  $('mode-client').classList.toggle('cur', !live);
  const bs = $('btn-sync');
  bs.classList.toggle('cur', live);
  const sp = sy.pairs.find(x => x.id === sy.liveSel);
  const via = sp && sp.via === 'server' ? 'server' : sp && sp.via === 'hybrid' ? 'hybrid' : 'direct';
  bs.style.setProperty('--m-c', via === 'server' ? 'var(--violet)' : via === 'hybrid' ? 'var(--hybrid)' : 'var(--blue)');
  bs.style.setProperty('--m-d', via === 'server' ? 'var(--violet-d)' : via === 'hybrid' ? 'rgba(143,140,251,.15)' : 'var(--blue-d)');
  bs.classList.toggle('hy', via === 'hybrid');
  $('btn-sync').dataset.tip = live ? 'LIVE SYNC: new session, import, connect, sessions (right-click: the same menu)' : connectedPairs().length ? 'Show the LIVE SYNC view (right-click: new session, import, connect)' : 'LIVE SYNC: no session connected (new, import, connect)';
}
function renderLive() {
  const on = connectedPairs();
  const show = on.length > 0 && !sy.liveHidden;
  document.body.classList.toggle('live-on', show);
  placeMode();
  if (!show) { document.body.classList.remove('live-st'); return; }
  if (!on.some(p => p.id === sy.liveSel)) sy.liveSel = on[0].id;
  const p = on.find(x => x.id === sy.liveSel);
  const st = sy.status[p.id] || {};
  const mode = sessionMode(p);
  setHTML($('lv-tabs'), on.length > 1 ? on.map(x => `<button data-id="${esc(x.id)}" class="${x.id === p.id ? 'on' : ''}${sessionError(x) ? ' err' : ''}">${esc(x.name)}</button>`).join('') : `<span class="lv-name">${esc(p.name)}</span>`);
  // Another computer waiting for an answer.
  const pd = sy.direct.pending || { devices: [], folders: [] };
  setHTML($('lv-ask'), askHtml(pd));
  // This computer's SYNCTHING ID: asked once, then every 3 s while SYNCTHING is
  // still starting (not at every status).
  if (!sy.myId && p.via !== 'server' && !sy.myIdAsk) {
    sy.myIdAsk = true;
    API.directInfo(false).then(r => { if (r && r.id) { sy.myId = r.id; sy.myIdAsk = false; renderLive(); } else setTimeout(() => { sy.myIdAsk = false; renderLive(); }, 3000); });
  }
  setHTML($('lv-local'), localCard(p, st));
  renderStQueue();
  renderMid(p);
  setHTML($('lv-remote'), remoteCard(p, st));
  if ($('lv-code')) $('lv-code').onclick = () => showShareInfo(p);
  setHTML($('lv-modeb'), modeBadge(p, st));
  // This computer's trash (SYNCTHING): its size, every 10 s per session.
  if (p.via !== 'server' && Date.now() - (sy.trashAt[p.id] || 0) > 10000) {
    sy.trashAt[p.id] = Date.now();
    API.trashInfo(p.id).then(t => { if (t && t.dir) { sy.trash[p.id] = t; if (sy.liveSel === p.id) renderLive(); } });
  }
}
// The session at a glance (Noar, 11/10/2026), on the centre card: its kind,
// in its colour (SYNCTHING blue, SYNCTHING FAILSAFE both, S-FTP violet), and
// one icon for its state: plugged green (connected and working), plugged
// orange (connected but it cannot work: the remote computer away, the server
// in error), unplugged red (disconnected). A click connects or disconnects;
// SYNCTHING FAILSAFE has two ways, each its own switch.
const MODE_NAME = { direct: 'SYNCTHING', hybrid: 'DUAL SYNC', server: 'S-FTP' };
function modeState(p, st) {
  const sv = p.via === 'hybrid' ? st.server || {} : st;
  const stBad = p.auto && p.peer && !connectedNow(p) ? 'the remote computer is not reachable' : st.state === 'error' ? (st.error || 'error') : '';
  if (p.via === 'direct') return { on: !!p.auto, bad: p.auto ? stBad : '' };
  if (p.via === 'server') return { on: !!p.auto, bad: p.auto && st.state === 'error' ? (st.error || 'the server is in error') : '' };
  const on = !!(p.auto || p.fsAuto);
  // FAILSAFE: the other computer away is what the failsafe is for; a
  // problem is the route in use failing.
  const bad = sessionMode(p) === 'S-FTP' ? (p.fsAuto && sv.state === 'error' ? (sv.error || 'the server is in error') : '') : (p.auto ? stBad : '');
  return { on, bad };
}
function modeBadge(p, st) {
  const m = modeState(p, st);
  const cls = { direct: 'm-direct', hybrid: 'm-hybrid', server: 'm-server' }[p.via];
  const parts = p.via === 'hybrid' ? ` (SYNCTHING ${p.auto ? 'on' : 'off'}, S-FTP BACKUP ${p.fsAuto ? 'on' : 'off'})` : '';
  const tip = !m.on ? `Disconnected${parts}: click to connect` : m.bad ? `Connected, but ${m.bad}${parts}: click to ${p.via === 'hybrid' ? 'choose' : 'disconnect (confirmed)'}` : `Connected${parts}: click to ${p.via === 'hybrid' ? 'choose' : 'disconnect (confirmed)'}`;
  return `<button class="badge lv-modeb ${cls}" data-tip="${esc(tip)}"><span class="st ${!m.on ? 'off' : m.bad ? 'warn' : 'on'}">${m.on ? I.plugged : I.unplug}</span>${MODE_NAME[p.via]}</button>`;
}
async function onModeBadge() {
  const p = sy.pairs.find(x => x.id === sy.liveSel);
  if (!p) return;
  if (p.via !== 'hybrid') return onConnSwitch(!!p.auto, p.via === 'server' ? undefined : 'st');
  // SYNCTHING FAILSAFE: its two ways, each on or off.
  const row = (w, l, on) => `<button class="lv-sw ${on ? 'on' : 'off'}" data-w="${w}" data-on="${on ? 1 : 0}">${on ? I.plugged : I.unplug}<span>${l}</span><span class="sw-st">${on ? 'CONNECTED' : 'DISCONNECTED'}</span></button>`;
  const pick = await dialog({
    title: `“${esc(p.name)}”: DUAL SYNC`,
    sub: 'SYNCTHING goes straight to the remote computer; the S-FTP BACKUP keeps an exact copy of the MASTER\'s folder on the server, and carries the files while the remote computer is away. Each can be connected or not.',
    html: `<div class="sw-list">${row('st', 'SYNCTHING', !!p.auto)}${row('fs', 'S-FTP BACKUP', !!p.fsAuto)}</div>`,
    buttons: [{ spacer: true }, { label: 'CLOSE', value: null }],
    width: 520,
    onOpen: c => c.querySelectorAll('.lv-sw').forEach(b => b.onclick = () => closeDialog({ w: b.dataset.w, on: b.dataset.on === '1' })),
  });
  if (pick) onConnSwitch(pick.on, pick.w);
}
async function onConnSwitch(on, w) {
  const p = sy.pairs.find(x => x.id === sy.liveSel);
  if (!p) return;
  const what = w === 'st' ? 'Syncthing' : w === 'fs' ? 'the S-FTP BACKUP' : 'this S-FTP session';
  // Connecting: one click. Disconnecting: confirmed (Noar, 12/10/2026).
  if (on && !(await confirmBox(`Disconnect ${what}?`, 'Nothing more goes this way until you connect it again. No file is touched.', 'DISCONNECT', true))) return;
  const r = await API.syncConnect(p.id, !on, w);
  if (!r.ok) return toast(r.error, true);
  sy.pairs = r.pairs; sy.status = r.status || {};
  renderSyncBtn(); renderLive();
}
// A SYNCTHING ID, whole, with COPY and EXPORT (Noar, 11/10/2026).
function idBlock(id, name) {
  if (!id) return '';
  return `<div class="lv-id"><div class="t"><div class="k">SYNCTHING ID</div><div class="v mono">${esc(id)}</div></div>
    <div class="b">${[['copy', I.copy, 'Copy the ID'], ['export', I.exportFile, 'Export the ID to a text file']].map(([a, ic, tip]) => `<button class="ibtn ins" data-idact="${a}" data-id="${esc(id)}" data-name="${esc(name || '')}" data-tip="${tip}" aria-label="${tip}">${ic}</button>`).join('')}</div></div>`;
}
async function idAction(act, id, name) {
  if (act === 'copy') { API.copyText(id); toast('SYNCTHING ID copied'); return; }
  const r = await API.directIdShare({ id, name, how: act });
  if (!r.ok) { if (!r.cancelled) toast(r.error, true); return; }
  if (r.path) toast('Saved: ' + r.path);
}
function kv(rows) { return `<div class="lv-kv">${rows.filter(Boolean).map(([k, v]) => `<div class="k">${k}</div><div class="v">${v}</div>`).join('')}</div>`; }
// SEND / RECEIVE / 2 WAYS, as seen from one side (Noar, 12/10/2026).
const SYNC_WORD = { up: 'SEND', down: 'RECEIVE', both: '2 WAYS' };
const SYNC_OTHER = { up: 'RECEIVE', down: 'SEND', both: '2 WAYS' };
function localCard(p, st) {
  const me = sy.me || {};
  const res = st.result || (st.server && st.server.result);
  const content = p.via !== 'server' && st.localFiles != null ? `${plural(st.localFiles, 'file')} · ${fmtSize(st.localBytes || 0)}` : res && res.local != null ? `${plural(res.local, 'file')}` : '';
  const t = sy.trash[p.id];
  return `<div class="lv-who">${SY_PC}<span>THIS COMPUTER</span></div>
    <div class="lv-host"><span>${esc(me.name || '')}</span>${roleBadge(roleOf(p), 'this')}</div>
    ${p.via !== 'server' ? idBlock(sy.myId, me.name) : ''}
    ${p.via !== 'server' ? `<div class="lv-trash"><div class="t"><div class="k">TRASH <span class="mono">.filo-trash</span></div><div class="tv">${t ? (t.files ? `${plural(t.files, 'file')} · ${fmtSize(t.bytes)}` : 'empty') : '…'}</div></div><button class="ibtn ins" data-trash="1" data-tip="Open the trash: what the other computer deleted lands here (never synced, never emptied by filo)" aria-label="Open the trash">${I.trash}</button></div>` : ''}
    ${kv([
      ['System', esc(me.os || '')],
      ['IP', me.ips && me.ips.length ? me.ips.map(i => `<span class="mono">${esc(i.address)}</span>`).join('<br>') : '—'],
      ['Folder', `<span class="mono">${esc(p.local)}</span>`],
      content && ['Content', esc(content)],
      ['Sync', SYNC_WORD[p.direction] || ''],
      ['filo', esc(me.version || '')],
    ])}`;
}
function remoteCard(p, st) {
  if (p.via === 'server') return serverCard(p, st, false);
  const peer = st.peer || (p.peer ? { name: p.peer.name, id: p.peer.id, connected: false } : null);
  if (!p.peer) {
    // One way (Noar, 11/10/2026): the MASTER sends, the SLAVE imports. SYNCTHING:
    // this computer's SYNCTHING ID, or the config file. FAILSAFE: the config
    // file only (it carries the server).
    const quick = p.via === 'direct' && !isSlave(p);
    return `<div class="lv-who">${SY_PC}<span>REMOTE COMPUTER</span></div><div class="lv-host"><span class="lv-state bad alone" data-tip="No remote computer yet: send it what is below">NOT LINKED YET</span></div>
      ${quick ? `<div class="lv-link"><div class="k">SEND IT THIS COMPUTER'S SYNCTHING ID</div>
        ${sy.myId ? idBlock(sy.myId, (sy.me || {}).name) : '<div class="sy-dim">…</div>'}
        <div class="hint">There: right-click LIVE SYNC (side bar) → Import session as SLAVE → PASTE A SYNCTHING ID. Then filo asks you here to accept it, and which session to share: this one.</div></div>
        <div class="lv-or">OR</div>` : `<div class="lv-note">${p.via === 'hybrid' ? 'Save the config file and send it to the remote computer (it carries the S-FTP BACKUP). There: right-click LIVE SYNC (side bar) → Import session as SLAVE. Then accept it here.' : 'Send the config file to the remote computer. There: right-click LIVE SYNC (side bar) → Import session as SLAVE. Then accept it here.'}</div>`}
      <button class="ibtn ins lab" id="lv-code" data-tip="Save the config file to send to the remote computer">${I.share}<span>CONFIG FILE</span></button>${p.via === 'hybrid' ? serverCard(p, st.server || {}, true) : ''}`;
  }
  const n = splitDev(p.peer.name);
  const ip = peerAddress(peer);
  // Its role, in the colour of the link (Noar, 12/10/2026): green and plugged
  // when connected, red and unplugged when not.
  const on = !!(peer && peer.connected);
  const why = on ? 'Connected' : !p.auto ? 'Disconnected: Syncthing is switched off' : 'Disconnected: is filo open there, and the computer online?';
  return `<div class="lv-who">${SY_PC}<span>REMOTE COMPUTER</span></div>
    <div class="lv-host"><span>${esc(n.name || shortDev(p.peer.id))}</span><span class="lv-state ${on ? 'ok' : 'red'}" data-tip="${esc(otherRole(p) + ' · ' + why)}">${on ? I.plugged : I.unplug}${otherRole(p)}</span></div>
    ${idBlock(p.peer.id, n.name)}
    ${kv([
      ['System', esc(n.os || '—')],
      ['IP', ip ? `<span class="mono">${esc(ip)}</span>` : peer && peer.connected ? 'through a relay' : '—'],
      ['Link', esc(!on ? 'not connected' : peer.via === 'lan' ? 'local network' : peer.via === 'internet' ? 'internet' : 'relay (slower)')],
      ['Sync', SYNC_OTHER[p.direction] || ''],
    ])}
    ${p.via === 'hybrid' ? serverCard(p, st.server || {}, true) : ''}`;
}
// CONNECTED / DISCONNECTED (Noar, 12/10/2026): the same badge for the
// remote computer and for the server (FAILSAFE or S-FTP).
function linkBadge(ok, tip) {
  return ok ? `<span class="lv-state ok"${tip ? ` data-tip="${esc(tip)}"` : ''}>CONNECTED</span>` : `<span class="lv-state red blink"${tip ? ` data-tip="${esc(tip)}"` : ''}>DISCONNECTED</span>`;
}
function serverCard(p, st, failsafe) {
  const s = state.sites.find(x => x.id === p.siteId);
  const res = st && st.result;
  // Copies the failsafe had already queued finish even once SYNCTHING is back:
  // the server keeps its copy for when the remote computer is away again.
  const finishing = failsafe && p.fsAuto && sessionMode(p) === 'SYNCTHING' && st.state !== 'standby' && st.state !== 'mirror' && state.qstate === 'running';
  const standby = failsafe && !finishing && (st.state === 'standby' || sessionMode(p) === 'SYNCTHING');
  // DUAL SYNC: the MASTER writes the mirror once SYNCTHING has finished.
  const mirrorNow = failsafe && mirroring(p, { server: st });
  const mirrorUse = isSlave(p) ? 'standby (the MASTER writes the backup)'
    : mirrorNow ? 'copying to the backup'
    : st.state === 'mirrored' ? 'backup up to date'
    : 'waits for Syncthing to finish';
  // Connected: switched on, and the last look at the server went well.
  const on = (failsafe ? p.fsAuto : p.auto) && st.state !== 'error';
  const why = !(failsafe ? p.fsAuto : p.auto) ? 'Switched off' : st.state === 'error' ? (st.error || 'The server is in error') : '';
  const use = !p.fsAuto ? '' : mirrorNow ? mirrorUse : finishing ? 'finishing its copies' : standby ? mirrorUse : st.state === 'error' ? '' : 'carries the files';
  const head = failsafe
    ? `<div class="lv-sub">${I.server}<span>S-FTP BACKUP</span><span class="sp"></span>${linkBadge(on, why)}</div>`
    : `<div class="lv-who">${I.server}<span>S-FTP SERVER</span></div>
      <div class="lv-host"><span>${esc(s ? s.name : 'Bookmark deleted')}</span>${linkBadge(on, why)}</div>`;
  return `${head}${kv([
    failsafe && use && ['Now', esc(use)],
    s && ['Server', `<span class="mono">${esc(PROTO_INFO[s.protocol] ? PROTO_INFO[s.protocol][0] : s.protocol)} · ${esc(s.user ? s.user + '@' : '')}${esc(s.host)}:${esc(s.port || '')}</span>`],
    ['Folder', `<span class="mono">${esc(p.remote)}</span>`],
    res && !failsafe && ['Content', plural(res.remote, 'file')],
    st.lastRun && ['Checked', fmtTime(st.lastRun)],
    st.nextAt && ['Next check', fmtTime(st.nextAt)],
    st.state === 'error' && ['Error', `<span style="color:var(--red)">${esc(st.error || '')}</span>`],
  ])}`;
}
// The centre of the LIVE SYNC view: the transfer ring (how much of the
// folder is in step), the speed and its graph, what is left and when it
// will be done, the link, the files received.
const LV_SPARK_N = 90;           // one point a second (the ring shows the last 40)
function liveSpeed(p, st, mode) {
  if (mode === 'SYNCTHING') { const pe = st.peer || {}; return { up: pe.outRate || 0, down: pe.inRate || 0 }; }
  const pr = state.progress;
  const sp = state.qstate === 'running' && pr ? pr.speed || 0 : 0;
  return p.direction === 'down' && mode !== 'MIRROR' ? { up: 0, down: sp } : { up: sp, down: 0 };
}
function livePct(p, st, mode) {
  if (mode === 'SYNCTHING') {
    if (!p.peer || !(st.peer && st.peer.connected)) return null;
    const total = st.globalBytes || 0, left = (st.needBytes || 0) + (st.peerNeedBytes || 0);
    return total ? Math.max(0, Math.min(100, 100 - (left / total) * 100)) : 100;
  }
  const c = state.qcounts || {}, pr = state.progress;
  const run = pr && pr.run ? pr.run.bytes : 0, left = c.bytesLeft || 0;
  if (state.qstate === 'running' && run + left > 0) return (run / (run + left)) * 100;
  const sv = p.via === 'hybrid' ? st.server || {} : st;
  return sv.state === 'error' ? null : sv.lastRun ? 100 : null;
}
function liveLeft(p, st, mode) {
  if (mode === 'SYNCTHING') return { bytes: (st.needBytes || 0) + (st.peerNeedBytes || 0), files: (st.needFiles || 0) + (st.peerNeedFiles || 0) };
  const c = state.qcounts || {};
  return { bytes: c.bytesLeft || 0, files: (c.queued || 0) + (c.running || 0) + (c.waiting || 0) };
}
function sampleLive() {
  const p = sy.pairs.find(x => x.id === sy.liveSel);
  if (!p || !document.body.classList.contains('live-on')) return;
  const st = sy.status[p.id] || {};
  const sp = liveSpeed(p, st, mirroring(p, st) ? 'MIRROR' : sessionMode(p));
  const a = sy.spark[p.id] || (sy.spark[p.id] = []);
  // Eased towards the speed read: SYNCTHING gives a new rate every 2 s, not
  // a staircase of equal bars.
  const v = sp.up + sp.down, prev = a.length ? a[a.length - 1] : 0;
  a.push(v < 1024 && prev < 1024 ? v : prev + (v - prev) * 0.5);
  if (a.length > LV_SPARK_N) a.shift();
  sy.sparkAt[p.id] = Date.now();
  renderMid(p);
  animGraphs();
}
// The ring stays the same element (its tooltip keeps working): only its
// class, its fill, its bars and its texts are written, when they change.
function renderMid(p) {
  const box = $('lv-mid');
  if (!box || !p) return;
  const st0 = sy.status[p.id] || {};
  const m = midParts(p, st0, mirroring(p, st0) ? 'MIRROR' : sessionMode(p));
  let ring = box.querySelector('.lv-ring');
  if (!ring) {
    const chev = '<svg viewBox="0 0 24 24"><path d="m9 6 6 6-6 6"/></svg>';
    const flow = side => `<div class="lv-flow ${side}" aria-hidden="true">${chev.repeat(3)}</div>`;
    box.insertAdjacentHTML('beforeend', `<div class="lv-ring">${flow('l')}${flow('r')}<svg class="ring" viewBox="0 0 200 200"><defs><clipPath id="lv-disc"><circle cx="100" cy="100" r="79"/></clipPath><linearGradient id="lv-hy" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#4d90f0"/><stop offset="1" stop-color="#a880ff"/></linearGradient></defs><g clip-path="url(#lv-disc)" class="bars"></g><circle class="ring-bg" cx="100" cy="100" r="86"/><circle class="ring-fg" cx="100" cy="100" r="86" transform="rotate(-90 100 100)" stroke-dasharray="${m.C}"/></svg><div class="ring-center"></div></div>`);
    ring = box.querySelector('.lv-ring');
  }
  if (ring.getAttribute('class') !== m.cls) ring.setAttribute('class', m.cls);
  if (m.tip) ring.dataset.tip = m.tip; else delete ring.dataset.tip;
  setHTML(ring.querySelector('.bars'), m.bars);
  const fg = ring.querySelector('.ring-fg');
  if (fg.getAttribute('stroke-dashoffset') !== m.off) fg.setAttribute('stroke-dashoffset', m.off);
  setHTML(ring.querySelector('.ring-center'), m.center);
  // The arrows: left, files coming here; right, files going there.
  ring.querySelector('.lv-flow.l').classList.toggle('on', m.fl.in);
  ring.querySelector('.lv-flow.r').classList.toggle('on', m.fl.out);
}
// The centre of the LIVE SYNC view: one ring that fills the frame (Noar,
// 11/10/2026), Presto's ring for its look. Inside, top to bottom: the state,
// the way the files go (SYNCTHING / S-FTP), the percentage, the bytes, the
// speed, then files left and the estimated time. The speed graph is drawn
// inside the ring, clipped to its inner circle: it never crosses the ring.
const LV_BARS = 48;
const RB = { x0: 21, w: 158, bw: 158 / LV_BARS, base: 178, hmax: 62 };
// The ring's graph, between two samples: slides left, its scale eased.
let ringMaxShown = 0;
function ringFrame(now) {
  const p = sy.pairs.find(x => x.id === sy.liveSel);
  if (!p || !document.body.classList.contains('live-on')) return false;
  const g = document.querySelector('#lv-mid .bars-in');
  if (!g) return false;
  const at = sy.sparkAt[p.id] || now;
  const frac = Math.min(1, Math.max(0, (now - at) / 1000));
  const max = +g.dataset.max || 1;
  ringMaxShown = ringMaxShown ? ringMaxShown + (max - ringMaxShown) * (max > ringMaxShown ? 0.12 : 0.04) : max;
  const k = max / ringMaxShown;
  g.setAttribute('transform', `translate(${(-frac * RB.bw).toFixed(2)} ${RB.base}) scale(1 ${k.toFixed(4)}) translate(0 ${-RB.base})`);
  const a = sy.spark[p.id] || [];
  return a.slice(-LV_BARS - 1).some(v => v > 0) || Math.abs(k - 1) > 0.001;
}
function ringState(p, st, mode) {
  const rs = ringState0(p, st, mode);
  // The ring takes the colour of the session's mode (DUAL SYNC blue to violet).
  if (p.via === 'hybrid' && (rs.t === 'st' || rs.t === 'sf')) rs.t = 'hy';
  return rs;
}
function ringState0(p, st, mode) {
  const peer = st.peer || {};
  if (sessionError(p)) return { s: 'ERROR', t: 'bad' };
  if (mode === 'SYNCTHING') {
    if (st.state === 'starting') return { s: 'STARTING', t: 'off' };
    if (st.state === 'waiting') return { s: 'WAITING', t: 'off' };
    if (!p.auto) return { s: 'OFF', t: 'off' };
    if (st.state === 'held') return { s: 'PAUSED', t: 'st', idle: true };
    if (!peer.connected) return { s: 'NOT REACHABLE', t: 'off' };
    if (st.state === 'scanning') return { s: 'SCANNING', t: 'st' };
    if (st.state === 'syncing') return { s: 'SYNCHRONIZING', t: 'st', run: true };
    // Both computers in step (Noar, 12/10/2026: "IDLE" said nothing). DUAL
    // SYNC with its S-FTP BACKUP in step too: the three places are the same.
    if (st.state === 'insync') {
      const sv = st.server || {};
      if (p.via === 'hybrid' && p.fsAuto && !isSlave(p) && sv.state === 'mirrored') return { s: 'ALL UP TO DATE', t: 'st', idle: true };
      return { s: 'UP TO DATE', t: 'st', idle: true };
    }
    return { s: 'IDLE', t: 'st', idle: true };
  }
  if (mode === 'MIRROR') return { s: 'S-FTP BACKUP', t: 'sf', run: true };
  const sv = p.via === 'hybrid' ? st.server || {} : st;
  if (state.qstate === 'running') return { s: 'SYNCHRONIZING', t: 'sf', run: true };
  if (sv.state === 'checking') return { s: 'CHECKING', t: 'sf' };
  if (sv.state === 'waiting') return { s: 'FILES SETTLING', t: 'sf' };
  // S-FTP: the last look found nothing to copy and nothing left as a conflict.
  const r = sv.result;
  if (sv.lastRun && !sv.error && r && !r.copies && !r.waiting && !(r.conflicts && r.conflicts.length)) return { s: 'UP TO DATE', t: 'sf', idle: true };
  return { s: 'IDLE', t: 'sf', idle: true };
}
// Which way files move right now (the arrows beside the ring): out = from
// this computer (right side, towards the remote one), in = to it (left side).
// Syncthing: its rates; a receiver also sends its small requests, so a side
// counts only above 32 KB/s and a quarter of the other one.
// S-FTP: the copies of this session running in the queue.
function liveFlow(p, st, mode) {
  if (mode === 'SYNCTHING') {
    const pe = st.peer || {};
    if (!pe.connected) return { out: false, in: false };
    const o = pe.outRate || 0, i = pe.inRate || 0, m = Math.max(o, i);
    if (m < 32768) return { out: false, in: false };
    return { out: o >= m / 4 && o >= 32768, in: i >= m / 4 && i >= 32768 };
  }
  if (state.qstate !== 'running') return { out: false, in: false };
  const label = `Sync · ${p.name}`;
  let out = false, inn = false;
  for (const it of q.byId.values()) if (it.status === 'running' && it.endpointLabel === label) { if (it.dir === 'up') out = true; else inn = true; }
  if (!out && !inn) { out = p.direction !== 'down'; inn = p.direction !== 'up'; }
  return { out, in: inn };
}
function ringBytes(p, st, mode) {
  if (mode === 'SYNCTHING') {
    const total = st.globalBytes || 0, left = (st.needBytes || 0) + (st.peerNeedBytes || 0);
    return total ? `${fmtSize(Math.max(0, total - left))} / ${fmtSize(total)}` : '';
  }
  const c = state.qcounts || {}, pr = state.progress;
  const run = pr && pr.run ? pr.run.bytes : 0, left = c.bytesLeft || 0;
  if (state.qstate === 'running' && run + left > 0) return `${fmtSize(run)} / ${fmtSize(run + left)}`;
  const sv = p.via === 'hybrid' ? st.server || {} : st;
  return sv.lastRun ? `checked ${fmtTime(sv.lastRun)}` : '';
}
function ringTip(p, st, mode) {
  const out = [];
  const sv = p.via === 'hybrid' ? st.server || {} : st;
  if (sessionError(p)) out.push((st.state === 'error' ? st.error : sv.error) || '');
  const res = mode === 'S-FTP' && sv.result;
  if (res && res.conflicts && res.conflicts.length) out.push(`${plural(res.conflicts.length, 'conflict')} left as they are: ${res.conflicts.slice(0, 5).map(c => c.rel).join(', ')}`);
  if (st.fileErrors && st.fileErrors.length) out.push(`${plural(st.fileErrors.length, 'file')} not synced: ${st.fileErrors.slice(0, 5).map(e => e.path + ' (' + e.error + ')').join(', ')}`);
  if (mode === 'SYNCTHING' && st.peer && st.peer.via === 'relay') out.push('Through a relay: the two internet boxes allow no direct path. It works, but slowly.');
  return out.join('\n');
}
// The file moving now, under the percentage (Noar, 12/10/2026). SYNCTHING:
// the first one in progress in its queue, or, small files going faster than
// the queue is read (every 2 s), the last one arrived or sent in the last
// 4 s. S-FTP: the session's copy running in filo's queue.
function ringFile(p, st, mode) {
  const named = (rel, up) => { const i = rel.lastIndexOf('/'); return { rel, name: rel.slice(i + 1), up }; };
  if (mode === 'SYNCTHING') {
    const qq = (sy.q || {})[p.id];
    if (!qq) return null;
    const run = qq.items.filter(x => x.status === 'running');
    const it = run.find(x => x.done > 0 && x.done < x.size) || run[0] || qq.done.find(x => x.status === 'done' && Date.now() - (x.at || 0) < 4000);
    return it ? named(it.rel, it.dir === 'up') : null;
  }
  const label = `Sync · ${p.name}`;
  for (const it of q.byId.values()) {
    if (it.status !== 'running' || it.endpointLabel !== label) continue;
    const up = it.dir === 'up';
    return { rel: up ? it.remote : it.local, name: up ? posixBase(it.remote) : localBase(it.local), up };
  }
  return null;
}
function midParts(p, st, mode) {
  const rs = ringState(p, st, mode);
  const pct = livePct(p, st, mode);
  const sp = liveSpeed(p, st, mode);
  const a = sy.spark[p.id] || [];
  const avg = a.length ? a.slice(-10).reduce((x, y) => x + y, 0) / Math.min(10, a.length) : 0;
  const left = liveLeft(p, st, mode);
  const held = st.state === 'held' && mode === 'SYNCTHING';   // PAUSED: nothing moves, no time left to tell
  const eta = left.bytes && avg > 0 && !held ? left.bytes / avg : 0;
  const moving = !held && sp.up + sp.down >= 1024;      // a few bytes a second: the two Syncthing talking, not files
  const C = 2 * Math.PI * 86;
  // The graph: bars standing on the lower part of the inner disc, clipped to
  // it (r 79: inside the 11 px stroke at r 86).
  // Smooth (Noar, 12/10/2026): the newest bar is drawn one place beyond the
  // right edge (hidden by the disc) and the bars slide left continuously
  // until the next one (ringFrame); heights are drawn against this max, and
  // ringFrame eases the scale when the max changes.
  const vals = a.slice(-(LV_BARS + 1));
  const max = Math.max(1, ...vals);
  const o = LV_BARS + 1 - vals.length;
  const bars = `<g class="bars-in" data-max="${max}">` + vals.map((v, i) => { const h = Math.max(0.6, (v / max) * RB.hmax); return `<rect${i === vals.length - 1 ? ' class="now"' : ''} x="${(RB.x0 + (o + i) * RB.bw + 0.4).toFixed(2)}" y="${(RB.base - h).toFixed(2)}" width="${(RB.bw - 0.8).toFixed(2)}" height="${h.toFixed(2)}"/>`; }).join('') + '</g>';
  const tip = ringTip(p, st, mode);
  const off = rs.t === 'off' || rs.t === 'bad';
  const cur = off ? null : ringFile(p, st, mode);
  // An error: the ring closed in orange. Nothing can move: the ring empty, in grey.
  const fill = rs.t === 'bad' ? 100 : rs.t === 'off' ? 0 : (pct == null ? 0 : pct);
  const fl = rs.t === 'bad' || rs.t === 'off' || held ? { out: false, in: false } : liveFlow(p, st, mode);
  return {
    fl,
    cls: `lv-ring ${rs.t}${rs.run ? ' run' : ''}${rs.idle ? ' idle' : ''}`, tip, bars, C: C.toFixed(2), off: (C * (1 - fill / 100)).toFixed(2),
    center: `<div class="r-status">${rs.s}</div>
      ${p.via === 'hybrid' && mode === 'S-FTP' ? '<div class="r-mode m-sf">VIA S-FTP</div>' : ''}
      <div class="r-pct">${pct == null || rs.t === 'off' || rs.t === 'bad' ? '–' : `${Math.floor(pct)}<span>%</span>`}</div>
      <div class="r-file"${cur ? ` data-tip="${esc(cur.rel)}"` : ''}>${cur ? `<span class="dirc">${cur.up ? ST_UP : ST_DOWN}</span><span class="nm">${esc(cur.name)}</span>` : '&nbsp;'}</div>
      <div class="r-line mono">${off ? '&nbsp;' : [esc(ringBytes(p, st, mode)), moving ? `<b>${esc(fmtSpeed(sp.up + sp.down))}</b>` : ''].filter(Boolean).join('<i>·</i>') || '&nbsp;'}</div>
      <div class="r-row">
        <div class="r-fig"><div class="n mono">${left.files || 0}</div><div class="l">FILES LEFT</div></div>
        <div class="r-fig"><div class="n mono">${eta ? esc(fmtEta(eta)) : '–'}</div><div class="l">EST. TIME</div></div>
      </div>`,
  };
}

function bindSync() {
  // MODE: CLIENT (the two file panels) or LIVE SYNC (its view); ▾ the menu.
  $('mode-client').onclick = () => { if (document.body.classList.contains('live-on')) { sy.liveHidden = true; renderLive(); API.directFast(false); } };
  $('btn-sync').onclick = () => {
    if (document.body.classList.contains('live-on')) return onSyncBtn();
    if (connectedPairs().length) { sy.liveHidden = false; renderLive(); API.directFast(true); return; }
    onSyncBtn();                                          // nothing connected: new, import, connect
  };
  // The LIVE SYNC menu: a click on LIVE SYNC once its view is shown, or a right-click.
  $('btn-sync').oncontextmenu = ev => { ev.preventDefault(); onSyncBtn(); };
  $('st-hold').onclick = async () => {
    const p = sy.pairs.find(x => x.id === sy.liveSel);
    if (!p) return;
    const held = (sy.status[p.id] || {}).state === 'held';
    const r = await API.directHold(p.id, !held);
    if (r && r.ok === false) toast(r.error, true);
  };
  placeMode();
  $('sy-close').onclick = () => { closeSync(); };
  $('sy-new').onclick = newSync;
  $('sy-share').onclick = shareSync;
  $('sy-import').onclick = importSync;
  $('sy-me').onclick = openDirectInfo;
  $('sy-list').addEventListener('click', ev => { const b = ev.target.closest('[data-ask]'); if (b) { ev.stopPropagation(); onAsk(b.dataset.ask, +b.dataset.i); } }, true);
  $('sy-list').addEventListener('click', ev => { const it = ev.target.closest('.sm-item'); if (it) syncSelect(it.dataset.id); });
  $('sy-save').onclick = async () => { if (await saveSync()) toast('Saved'); };
  $('sy-run').onclick = async () => {
    const d = sy.draft;
    if (d && d.id && d.auto) { if (await saveSync()) { toast('Saved'); closeSync(); renderLive(); } return; }
    connectSync();
  };
  $('sy-delete').onclick = () => { if (sy.draft && sy.draft.id) deleteSession(sy.draft.id); };
  async function deleteSession(id) {
    const d = sy.pairs.find(x => x.id === id);
    if (!d) return;
    if (!(await confirmBox(`Delete the session “${d.name}”?`, 'Only the session goes: no file is touched, here, on the remote computer or on the server.', 'DELETE', true))) return;
    const r = await API.syncDelete(d.id);
    if (!r || !r.ok) return errorBox('Not deleted', (r && r.error) || 'The session could not be deleted.');
    sy.pairs = r.pairs; sy.status = r.status || {};
    sy.selId = sy.pairs[0] ? sy.pairs[0].id : null;
    syncSelect(sy.selId); renderSyncBtn(); renderLive();
  }
  $('sy-list').addEventListener('click', ev => { const b = ev.target.closest('[data-del]'); if (b) { ev.stopPropagation(); deleteSession(b.dataset.del); } }, true);
  $('ov-sync').addEventListener('click', ev => { const b = ev.target.closest('.sy-peer [data-idact]'); if (b) idAction(b.dataset.idact, b.dataset.id); });
  // The LIVE SYNC view.
  $('lv-tabs').addEventListener('click', ev => { const b = ev.target.closest('button[data-id]'); if (b) { sy.liveSel = b.dataset.id; renderLive(); } });
  $('lv-modeb').addEventListener('click', ev => { if (ev.target.closest('.lv-modeb')) onModeBadge(); });
  $('live').addEventListener('click', async ev => { if (ev.target.closest('[data-trash]') && sy.liveSel) { const r = await API.trashOpen(sy.liveSel); if (r && r.ok === false) toast(r.error, true); } });
  $('lv-settings').onclick = () => openSync(sy.liveSel);
  $('lv-ask').addEventListener('click', ev => { const b = ev.target.closest('[data-ask]'); if (b) onAsk(b.dataset.ask, +b.dataset.i); });
  $('live').addEventListener('click', ev => { const b = ev.target.closest('[data-idact]'); if (b) idAction(b.dataset.idact, b.dataset.id, b.dataset.name); });
  setInterval(sampleLive, 1000);
  API.on('sync-status', ({ id, status }) => {
    sy.status[id] = status;
    renderSyncBtn(); renderLive();
    if ($('ov-sync').classList.contains('open')) {
      renderSyncList();
      const p = sy.pairs.find(x => x.id === id);
      if (id === sy.selId && p && JSON.stringify(p) === JSON.stringify(sy.draft) && !document.activeElement.closest('#sy-form')) renderSyncForm();
    }
  });
  API.on('sync-pairs', async () => {
    await loadSync();
    if ($('ov-sync').classList.contains('open')) { const p = sy.pairs.find(x => x.id === sy.selId); if (p && sy.draft && JSON.stringify(p.peer) !== JSON.stringify(sy.draft.peer)) sy.draft = Object.assign({}, p); renderSyncList(); renderSyncForm(); }
  });
  API.on('live-queue', ({ id, q }) => { (sy.q || (sy.q = {}))[id] = q; if (id === sy.liveSel) { renderStQueue(); renderMid(sy.pairs.find(x => x.id === id)); } });
  API.on('direct-pending', p => {
    const before = pendingCount();
    sy.direct.pending = p;
    if (pendingCount() > before) toast(p.devices.length ? `SYNCTHING: ${splitDev(p.devices[p.devices.length - 1].name).name || 'a computer'} wants to connect` : 'SYNCTHING: a session is offered (LIVE SYNC)');
    renderSyncBtn(); renderLive();
    if ($('ov-sync').classList.contains('open')) renderSyncList();
  });
  API.liveInfo().then(m => { sy.me = m; renderLive(); });
  loadSync().then(() => { if (connectedPairs().length) API.directFast(true); });
}

// ══ Start ══════════════════════════════════════════════════════════════════
async function init() {
  document.body.classList.add(API.platform === 'darwin' ? 'mac' : API.platform === 'win32' ? 'win' : 'linux');
  // Shortcuts written the Mac way in the page: Ctrl on Windows and Linux.
  if (API.platform !== 'darwin') {
    const f = t => t.replace(/⇧⌘/g, 'Ctrl+Shift+').replace(/⌘/g, 'Ctrl+').replace(/⌫/g, 'Backspace');
    document.querySelectorAll('[data-tip], .set-desc').forEach(el => {
      if (el.dataset.tip) el.dataset.tip = f(el.dataset.tip);
      if (el.classList.contains('set-desc') && el.textContent.includes('⌘')) el.textContent = f(el.textContent);
    });
  }
  const d = await API.init();
  Object.assign(state, {
    settings: d.settings, ntfy: d.ntfy, sites: d.sites, siteFolderOrder: d.siteFolderOrder || [], quickHistory: d.quickHistory, afterAction: d.afterAction,
    ui: d.ui || {}, vault: d.vaultAvailable, qstate: d.queueState, qcounts: d.queueCounts, logs: d.log || [], existingLabels: d.existingLabels,
  });
  $('ver').textContent = 'v' + d.version;
  panels = { local: new Panel('local'), remote: new Panel('remote') };
  setProto(state.ui.lastProto || 'sftp');
  bindTooltips(); bindSplitters(); bindSites(); bindQueue(); bindSettings(); bindSync();
  renderConnPill(); renderAfterBtn(); renderQueueHead(); renderVerifySwitch(); renderSync(); renderSparkVisibility();
  panels.remote.render();
  panels.local.load(d.lastLocalDir || d.home);
  setQTab('queue');

  // Quick connect
  $('q-proto').addEventListener('click', ev => { ev.stopPropagation(); protoMenu(); });
  $('q-connect').onclick = () => (state.conn && !state.barDirty ? disconnect() : quickConnect());
  for (const id of ['q-host', 'q-port', 'q-user', 'q-pass']) $(id).addEventListener('input', barEdited);
  $('conn-pill').addEventListener('click', () => { if (state.conn && state.conn.url) { API.copyText(state.conn.url); toast('Address copied'); } });
  $('q-hist').onclick = showQuickHistory;
  // Enter connects; when connected to what the bar shows, there is nothing to
  // do (it never disconnects: that is the red button's job). Escape puts the
  // bar back as it was, and the button back to DISCONNECT.
  for (const id of ['q-host', 'q-port', 'q-user', 'q-pass']) $(id).addEventListener('keydown', e => {
    if (e.key === 'Enter') { if (!(state.conn && !state.barDirty)) quickConnect(); }
    else if (e.key === 'Escape' && state.conn && state.barDirty) { e.stopPropagation(); fillBarFromConn(); }
  });
  $('q-host').addEventListener('input', () => {
    // A pasted URL sets the protocol button straight away.
    const m = /^(sftp|ftps|ftpes|ftp):\/\//i.exec($('q-host').value.trim());
    if (m) setProto(m[1].toLowerCase() === 'ftpes' ? 'ftps' : m[1].toLowerCase() === 'ftps' ? 'ftps-implicit' : m[1].toLowerCase());
  });

  // When it finishes
  $('btn-after').onclick = ev => {
    ev.stopPropagation();
    const r = $('btn-after').getBoundingClientRect();
    const st = state.settings, cmd = (st.hookCommand || '').trim();
    showMenu(Math.max(10, r.left), r.bottom + 6, [{ head: 'When the queue finishes' }]
      .concat(cmd ? [{ label: `Run my command first (${cmd.split(/\s+/)[0].split(/[\\/]/).pop()})`, radio: true, on: !!st.hookEnabled, action: async () => { await saveSettings({ hookEnabled: !st.hookEnabled }); renderAfterBtn(); } }]
        : [{ label: 'Run a command first… (Settings)', icon: I.plus, action: () => openSettings().then(() => { const e = $('st-hook-cmd'); if (e) { e.scrollIntoView({ block: 'center' }); e.focus(); } }) }], ['sep'])
      .concat(['none', 'quit', 'sleep', 'shutdown'].map(v => ({
      label: AFTER[v][0], radio: true, on: state.afterAction === v,
      action: async () => { state.afterAction = await API.afterSet(v); renderAfterBtn(); },
    }))));
  };
  $('after-cancel').onclick = () => { stopCountdown(); toast('Cancelled — the machine was left alone.'); };
  $('after-now').onclick = fireAfter;

  $('scan-cancel').onclick = () => API.scanCancel();
  $('lnk-gh').onclick = () => API.openExternal('https://github.com/noar-justedit/filo');
  $('win-min').onclick = () => API.winMinimize();
  $('win-max').onclick = () => API.winMaximize();
  $('win-close').onclick = () => API.winClose();

  // Files dropped where nothing takes them must not make the window navigate.
  document.addEventListener('dragover', e => e.preventDefault());
  document.addEventListener('drop', e => e.preventDefault());

  // Escape closes what informs.
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    if ($('ctx').classList.contains('open')) return closeMenu();
    if (isDialogOpen()) { if (String(dialogTag).startsWith('ask:')) return; return closeDialog(null); }
    if ($('ov-settings').classList.contains('open')) return $('ov-settings').classList.remove('open');
    if ($('ov-sites').classList.contains('open')) return closeSites();
    if ($('ov-sync').classList.contains('open')) return closeSync();
  });

  // ── Events from the main process ──
  API.on('queue-progress', p => {
    state.progress = p; state.qcounts = p.counts; state.qstate = p.state;
    pushSpark(p);
    renderQueueHead();
    if (state.qtab === 'queue') patchActive(p.active);
    // Refresh the destination panel now and then while files land in it.
    const doneNow = p.run ? p.run.done : 0;
    if (doneNow !== state._lastDone) {
      state._lastDone = doneNow;
      clearTimeout(state._refreshT);
      state._refreshT = setTimeout(() => {
        if (state.conn && !panels.remote.inFlight) { panels.remote.cache.delete(panels.remote.dir); panels.remote.load(panels.remote.dir, { keepSel: true }); }
        panels.local.load(panels.local.dir, { keepSel: true });
      }, 1500);
    }
  });
  API.on('queue-changed', c => {
    state.qcounts = c;
    // Nothing left to wait for: the "waiting for a password / a trust" banner goes.
    if (state.blocked && !((c.queued || 0) + (c.waiting || 0) + (c.running || 0) + (c.asking || 0))) { state.blocked = null; renderBlocked(); }
    renderQueueHead(); fetchQueue();
  });
  API.on('queue-state', s => {
    // A new run (not a resume after Pause) starts a new graph.
    if (s === 'running' && !state.qRan) resetSpark();
    state.qstate = s; renderSparkVisibility(); if (s === 'running') state.qRan = true; if (s === 'running' && afterState.timer) stopCountdown(); renderQueueHead(); if (s === 'running') { state.blocked = null; renderBlocked(); } });
  API.on('queue-ask', a => { state.asks.push(a); nextAsk(); });
  API.on('queue-ask-closed', id => {
    state.asks = state.asks.filter(a => a.askId !== id);
    if (dialogTag === 'ask:' + id) closeDialog({ closed: true });
    for (let i = dialogWait.length - 1; i >= 0; i--) if (dialogWait[i].o.tag === 'ask:' + id) dialogWait.splice(i, 1)[0].resolve({ closed: true });
  });
  API.on('queue-blocked', b => { state.blocked = b; renderBlocked(); });
  API.on('queue-finished', s => onFinished(s));
  API.on('hook-start', h => toast(`After the queue: running ${h.program}…`));
  API.on('queue-scheduled', r => { state.qSched = r.at || 0; renderQueueHead(); if (r.fired) toast('Scheduled start: the queue starts'); });
  API.on('delete-progress', d => {
    delProgress.n++;
    const now = Date.now();
    if (now - delProgress.at > 300) { delProgress.at = now; toast(`Deleting… ${delProgress.n} · ${String(d && d.path || '').split('/').pop()}`); }
  });
  API.on('scan-progress', p => { $('scan-txt').textContent = p.done ? 'Done' : `Listing folders… ${p.found} items`; });
  API.on('log', lines => {
    state.logs.push(...lines);
    if (state.logs.length > 3000) state.logs.splice(0, state.logs.length - 3000);
    if (state.qtab === 'log') {
      const el = $('q-log');
      el.insertAdjacentHTML('beforeend', lines.map(l => `<div class="l ${l.level}"><span class="t">${fmtTime(l.t)}</span>${esc(l.msg)}</div>`).join(''));
      while (el.childElementCount > 1500) el.firstChild.remove();
      renderLog(false);
    }
  });
  API.on('update-available', showUpdateNotice);
  API.on('menu', m => {
    switch (m.action) {
      case 'sites': return openSites();
      case 'quick': $('q-host').focus(); return $('q-host').select();
      case 'disconnect': return disconnect();
      case 'sites-import': openSites(); return importSites();
      case 'sites-export': return Promise.resolve(openSites()).then(() => setTimeout(() => $('sm-export').click(), 60));
      case 'queue-start': return playQueue();
      case 'queue-pause': refreshAfterStop(new Set(['up', 'down'])); return API.queuePause();
      case 'queue-retry': return retryItems([]);
      case 'refresh': { const p = document.activeElement && document.activeElement.closest && document.activeElement.closest('#p-remote') ? panels.remote : panels.local; p.cache.delete(p.dir); return p.load(p.dir, { keepSel: true }); }
      case 'toggle-hidden': return saveSettings({ showHidden: !state.settings.showHidden });
      case 'settings': return openSettings();
      case 'cli-install': return installCli();
      default: return null;
    }
  });
  panels.local.scroll.focus();
}

init();
