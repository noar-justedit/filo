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
function fmtDur(sec) {
  const s = Math.max(0, Math.round(sec));
  if (!isFinite(s) || s <= 0) return '—';
  if (s >= 3600) return `${Math.floor(s / 3600)} h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}`;
  if (s >= 60) return `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')}`;
  return `${s} s`;
}
function plural(n, w) { return `${n} ${w}${n === 1 ? '' : 's'}`; }
const posixJoin = (a, b) => (a.endsWith('/') ? a : a + '/') + b;
const posixBase = p => String(p).split('/').filter(Boolean).pop() || '/';
const posixDir = p => { const s = String(p).replace(/\/+$/, ''); const i = s.lastIndexOf('/'); return i <= 0 ? '/' : s.slice(0, i); };
const localBase = p => String(p).split(/[\\/]/).filter(Boolean).pop() || p;
const localDir = p => { const s = String(p).replace(/[\\/]+$/, ''); const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\')); return i < 0 ? s : s.slice(0, i) || '/'; };
const isMac = () => state.platform === 'darwin';
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
  refresh: SVG('<path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/>'),
  list: SVG('<path d="M3 12h.01"/><path d="M3 18h.01"/><path d="M3 6h.01"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M8 6h13"/>'),
  power: SVG('<path d="M12 2v10"/><path d="M18.4 6.6a9 9 0 1 1-12.77.04"/>'),
  quit: SVG('<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>'),
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
    d.addEventListener('click', () => { closeMenu(); it.action && it.action(); });
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
  return dialog({ title: esc(title), html: `<div class="err-list" style="background:var(--red-d)">${esc(msg).replace(/\n/g, '<br>')}</div>`,
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
  }

  compute() {
    const hidden = state.settings.showHidden;
    const f = this.filter.toLowerCase();
    let list = this.entries.filter(e => (hidden || !isHiddenName(e.name)) && (!f || e.name.toLowerCase().includes(f)));
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
      const key = `${c}|${e.name}|${e.size}|${e.mtime}`;
      if (r._key === key) continue;
      r._key = key;
      r.className = c;
      if (e.type === 'up') r.innerHTML = `<span class="ic">${I.up}</span><span class="nm">..</span><span class="sz"></span><span class="dt"></span>`;
      else if (e.drive) r.innerHTML = `<span class="ic">${I.drive}</span><span class="nm">${esc(e.name)}${e.slow ? ' <span class="badge o">not answering</span>' : ''}</span><span class="sz"></span><span class="dt"></span>`;
      else r.innerHTML = `<span class="ic">${iconFor(e)}</span><span class="nm">${esc(e.name)}</span><span class="sz">${isDirEntry(e) ? '' : fmtSize(e.size)}</span><span class="dt">${fmtDate(e.mtime)}</span>`;
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

  open(i) {
    const e = this.view[i];
    if (!e) return;
    if (e.type === 'up') return this.goUp();
    if (isDirEntry(e)) { syncFollow(this, { into: e.name }); return this.load(this.join(e.name)); }
    // A file: double-click transfers it, as in every two-panel client.
    this.sel = new Set([e.name]);
    this.transfer();
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
    this.scroll.addEventListener('dblclick', ev => { clearTimeout(this._slowT); const i = this.rowAt(ev); if (i >= 0) this.open(i); });
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
      if (act === 'home' && state.conn && this.dir !== state.conn.home) { syncOff('you jumped to another folder'); this.load(state.conn.home); }
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
      ev.dataTransfer.effectAllowed = 'copy';
      ev.dataTransfer.setData('text/plain', items.map(x => this.join(x.name)).join('\n'));
      const g = document.createElement('div');
      g.className = 'drag-ghost';
      g.textContent = items.length === 1 ? items[0].name : `${items.length} items`;
      document.body.appendChild(g);
      ev.dataTransfer.setDragImage(g, -10, -10);
      setTimeout(() => g.remove(), 0);
    });
    this.scroll.addEventListener('dragend', () => { dragSrc = null; });
    const accepts = ev => {
      if (!this.enabled || !state.conn) return false;
      if (dragSrc) return dragSrc.side !== this.side;
      // Files from the Finder / Explorer: only the server side takes them.
      return this.remote && ev.dataTransfer && [...ev.dataTransfer.types].includes('Files');
    };
    let overRow = null;
    const clearOver = () => { if (overRow) { overRow.classList.remove('drop'); overRow = null; } this.el.classList.remove('dragover'); };
    this.el.addEventListener('dragover', ev => {
      if (!accepts(ev)) return;
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
  if (res.ok) return onConnected(res);
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
function renderConnectBtn() {
  const b = $('q-connect');
  if (!b) return;
  const off = !!state.conn && !state.barDirty;
  b.disabled = !!state.connecting;
  b.classList.toggle('go', !off);
  b.classList.toggle('stop', off);
  b.innerHTML = state.connecting ? `${I.plug} CONNECTING…` : off ? `${I.unplug} DISCONNECT` : `${I.plug} CONNECT`;
  b.dataset.tip = off ? `Disconnect from ${state.conn.label} (${isMac() ? '⌘D' : 'Ctrl+D'})`
    : state.conn ? 'Connect to this server instead' : '';
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

async function openSites(selectId) {
  const r = await API.sitesList();
  state.sites = r.sites; state.vault = r.vaultAvailable;
  sm.search = ''; $('sm-search').value = '';
  $('ov-sites').classList.add('open');
  const first = selectId || sm.selId || (state.sites[0] && state.sites[0].id);
  selectSite(first && state.sites.find(s => s.id === first) ? first : null);
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
  const open = smOpen();
  let html = '';
  const short = { sftp: 'SFTP', ftps: 'FTPS', 'ftps-implicit': 'FTPS-i', ftp: 'FTP' };
  const draw = (node, depth) => {
    const pad = depth * 14;
    for (const d of [...node.dirs.values()].sort(folderCmp)) {
      const isOpen = !!q || open.has(d.path);
      html += `<div class="sm-folder${isOpen ? ' open' : ''}" data-path="${esc(d.path)}"${q ? '' : ' draggable="true"'} style="padding-left:${6 + pad}px"><span class="chev">${I.chev}</span>${I.folder}<span class="nm">${esc(d.name)}</span><span class="n">${d.count}</span></div>`;
      if (isOpen) draw(d, depth + 1);
    }
    for (const s of node.sites) {
      html += `<div class="sm-item${s.id === sm.selId ? ' sel' : ''}" data-id="${s.id}"${q ? '' : ' draggable="true"'} style="padding-left:${9 + pad + (depth ? 8 : 0)}px"><span class="ic ${s.protocol}">${short[s.protocol]}</span><div class="t"><div class="a">${esc(s.name)}</div><div class="b">${esc(s.user ? s.user + '@' : '')}${esc(s.host)}</div></div></div>`;
    }
  };
  draw(root, 0);
  if (list.length && !q) html += '<div class="sm-drop-end"></div>';
  if (!state.sites.length) html = '<div class="sm-empty" style="padding:30px 10px">No site yet.<br>Create one, or import your FileZilla sites.</div>';
  else if (!list.length) html = '<div class="sm-empty" style="padding:30px 10px">No match.</div>';
  $('sm-list').innerHTML = html;
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
  const el = ev.target.closest('.sm-item, .sm-folder, .sm-drop-end');
  if (!el) return null;
  const r = el.getBoundingClientRect(), y = (ev.clientY - r.top) / r.height;
  if (el.classList.contains('sm-drop-end')) return { el, kind: 'end' };
  if (el.classList.contains('sm-item')) return { el, kind: y < 0.5 ? 'before' : 'after' };
  if (sm.drag && sm.drag.type === 'folder') return { el, kind: y < 0.28 ? 'before' : y > 0.72 ? 'after' : 'into' };
  return { el, kind: 'into' };
}
function smClearMarks() { document.querySelectorAll('#sm-list .drop-before, #sm-list .drop-after, #sm-list .drop-into').forEach(e => e.classList.remove('drop-before', 'drop-after', 'drop-into')); }

async function smApplyDrop(spot) {
  const d = sm.drag;
  if (!d || !spot) return;
  let sites = state.sites.map(s => ({ id: s.id, folder: s.folder || '' }));
  let order = (state.siteFolderOrder || []).slice();
  const all = new Set();
  for (const s of state.sites) { const parts = String(s.folder || '').split(' / ').filter(Boolean); parts.forEach((_, i) => all.add(parts.slice(0, i + 1).join(' / '))); }
  // Every folder gets a place in the order list, so "before / after" means something.
  const known = [...all].sort((a, b) => folderCmp({ path: a, name: baseOf(a) }, { path: b, name: baseOf(b) }));
  for (const f of known) if (!order.includes(f)) order.push(f);

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

function selectSite(id) {
  sm.selId = id;
  sm.pwAction = undefined; sm.ppAction = undefined;
  const s = id ? state.sites.find(x => x.id === id) : null;
  sm.draft = s ? Object.assign({}, s) : null;
  // The folders of the site being shown are opened once, when it is chosen;
  // after that they fold like any other (they used to stay forced open).
  if (s && s.folder) {
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
  ['sm-delete', 'sm-dup'].forEach(id => { $(id).disabled = !d || !d.id; });
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
    const f = ev.target.closest('.sm-folder');
    if (f) { if (ev.altKey) smFoldAll(!f.classList.contains('open')); else smToggle(f.dataset.path); return; }
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
    spot.el.classList.add(spot.kind === 'into' ? 'drop-into' : spot.kind === 'end' ? 'drop-before' : 'drop-' + spot.kind);
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
  $('sm-list').addEventListener('contextmenu', ev => {
    if (!ev.target.closest('.sm-folder')) return;
    ev.preventDefault();
    showMenu(ev.clientX, ev.clientY, [
      { label: 'Expand all folders', icon: I.folder, action: () => smFoldAll(true) },
      { label: 'Collapse all folders', icon: I.folder, action: () => smFoldAll(false) },
    ]);
  });
  $('sm-save').onclick = async () => { const s = await saveSite(); if (s) toast('Saved'); };
  $('sm-connect').onclick = async () => { const s = await saveSite(); if (!s) return; closeSites(); connectWith({ siteId: s.id }, s.name); };
  $('sm-dup').onclick = async () => { if (!sm.draft || !sm.draft.id) return; state.sites = await API.sitesDuplicate(sm.draft.id); renderSiteList(); toast('Duplicated'); };
  $('sm-delete').onclick = async () => {
    const d = sm.draft; if (!d || !d.id) return;
    if (!(await confirmBox(`Delete the site “${d.name}”?`, 'Its remembered password is deleted too.', 'DELETE', true))) return;
    state.sites = await API.sitesDelete(d.id);
    selectSite(state.sites[0] ? state.sites[0].id : null);
  };
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
  toast(`Synchronized browsing on: ${localBase(panels.local.dir) || panels.local.dir} ⇄ ${posixBase(panels.remote.dir) || '/'}`);
}
function syncOff(why) {
  if (!state.sync) return;
  state.sync = false;
  renderSync();
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

function setQTab(tab) {
  state.qtab = tab;
  document.querySelectorAll('#q-tabs button[data-tab]').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
  const log = tab === 'log';
  $('q-log').style.display = log ? '' : 'none';
  $('q-spacer').style.display = log ? 'none' : '';
  $('q-clear').textContent = log ? 'Copy' : 'Clear';
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
function subOf(it, from) {
  if (it.status === 'failed' || it.status === 'stopped') return `<span class="l err" data-tip="${esc(it.error)}">${esc(it.error || 'Stopped')}</span>`;
  if (it.status === 'waiting') return `<span class="l err o" data-tip="${esc(it.error)}">${esc(it.error)}</span>`;
  let right = '';
  if (it.status === 'running' && it.type === 'file') {
    if (it.phase === 'verify') right = it.segs ? 'checking the whole file…' : 'checking…';
    else {
      const left = it.speed > 0 ? fmtDur((it.size - it.done) / it.speed) : '';
      right = `${fmtSize(it.done)} / ${fmtSize(it.size)} · ${fmtSpeed(it.speed)}${left && left !== '—' ? ' · ' + left : ''}`;
      if (it.segs) right = `${it.segs.running} at once · ${it.segs.done} of ${it.segs.total} done · ` + right;
    }
  } else if ((it.status === 'queued' || it.status === 'paused') && it.offset) right = `${fmtSize(it.offset)} already there`;
  return `<span class="l" data-tip="${esc(from)}">${esc(from)}</span>${right ? `<span class="r"${it.segs ? ` data-tip="Split into ${it.segs.total} segments: ${it.segs.running} on the way at once, ${it.segs.done} done and verified"` : ''}>${right}</span>` : ''}`;
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
          ${a.resume ? `<button class="qact" data-a="resume" data-tip="Resume">${I.play}</button>` : `<button class="qact" data-a="pause" data-tip="Pause this file: it stops where it is and resumes from there" ${a.pause ? '' : 'disabled'}>${I.pause}</button>`}
          <button class="qact stp" data-a="stop" data-tip="Stop this file: it goes to Failed, its partial file is kept for a retry" ${a.stop ? '' : 'disabled'}>${I.stop}</button>
          <button class="qact rt" data-a="retry" data-tip="Retry" ${a.retry ? '' : 'disabled'}>${I.retry}</button>
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
    else em.textContent = state.qtab === 'failed' ? 'No failed transfer.' : state.qtab === 'done' ? 'Finished transfers will be listed here.' : 'Drag files from one side to the other, or double-click a file, to transfer it.';
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
  box.style.setProperty('--q-color', verifying ? 'var(--blue)' : 'var(--green)');
  box.style.setProperty('--q-glow', verifying ? 'rgba(77,144,240,.28)' : 'rgba(53,201,139,.28)');
  let title = 'QUEUE';
  if (running) title = verifying ? 'VERIFYING' : (p && p.active.some(a => a.phase === 'connect') && !p.active.some(a => a.phase === 'transfer')) ? 'CONNECTING' : 'TRANSFERRING';
  else if (pending || paused) title = state.qRan ? 'PAUSED' : 'QUEUE';   // added "do not start": never ran
  else if (c.done || c.failed || c.stopped) title = c.failed || c.stopped ? 'FINISHED · WITH ERRORS' : 'FINISHED';
  $('q-title').textContent = title;
  const runBytes = p && p.run ? p.run.bytes : 0;
  const left = c.bytesLeft || 0;
  const pct = running || pending || paused ? (runBytes + left > 0 ? (runBytes / (runBytes + left)) * 100 : 0) : (c.done ? 100 : 0);
  $('q-pct').textContent = running || pending || paused || c.done ? fmtPct(pct) : '–';
  $('q-ring').style.strokeDashoffset = String(150.8 * (1 - pct / 100));

  // The figures, as badges in the tab bar.
  $('q-now').style.visibility = running ? '' : 'hidden';
  const st = [];
  const B = (label, v, cls, tip) => st.push(`<span class="q-stat ${cls || ''}"${tip ? ` data-tip="${esc(tip)}"` : ''}>${label} <span class="n">${v}</span></span>`);
  if (running) B('Speed', fmtSpeed(p ? p.speed : 0), verifying ? 'b' : 'g', 'Total speed of every transfer together');
  if (pending || paused) B('Left', fmtSize(left), '', 'Data still to transfer');
  if (running && p && p.eta) B('ETA', fmtDur(p.eta), '', 'Estimated time left at the current speed');
  $('q-stats').innerHTML = st.join('');

  // Simultaneous transfers: a plain label and a plain value.
  const auto = p && p.auto;
  const isAuto = state.settings.concurrency === 'auto';
  const now = running && p ? (isAuto && auto ? auto.level : p.units) : null;
  $('q-conn-v').textContent = isAuto ? (now ? `Auto · ${now}` : 'Auto') : String(state.settings.concurrency);
  $('q-conn').dataset.tip = isAuto
    ? `How many files go at the same time, each on its own connection. Auto: filo adds connections while the speed goes up, and keeps the fastest number${now ? ` (${now} right now${auto && auto.note ? ', ' + auto.note : ''})` : ''}. Click to choose.`
    : `How many files go at the same time, each on its own connection: ${state.settings.concurrency}. Click to choose, or to let filo find the fastest (Auto).`;

  // Whole queue: play / pause, and stop.
  const b = $('q-start');
  const canStart = !!pending || !!paused;
  b.className = 'btn sq' + (running ? '' : ' go');
  b.innerHTML = running ? I.pause : I.play;
  b.disabled = !running && !canStart;
  b.setAttribute('aria-label', running ? 'Pause' : 'Start');
  b.dataset.tip = running ? 'Pause the whole queue: running files stop, and resume from where they were'
    : pending ? (runBytes || c.done ? 'Resume the whole queue' : 'Start the queue')
    : paused ? 'Resume the files you paused' : 'Nothing to transfer';
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
// Total speed, one point every half second, the last minute. Right-aligned:
// the newest point is at the right edge, as in syncto and ingesto.
const SPARK_N = 120;
let spark = [], sparkT = 0;
function resetSpark() { spark = []; drawSpark(); $('q-now').innerHTML = ''; }
function pushSpark(p) {
  if (!p || p.state !== 'running') return;
  const now = Date.now();
  if (now - sparkT < 500) return;
  sparkT = now;
  spark.push(Math.max(0, p.speed || 0));
  if (spark.length > SPARK_N) spark.shift();
  drawSpark();
  // The speed right now, over the graph, and the best of the last minute.
  $('q-now').innerHTML = `${esc(fmtSpeed(p.speed || 0))}<small>PEAK ${esc(fmtSpeed(Math.max(...spark)))}</small>`;
}
function drawSpark() {
  const svg = $('q-spark');
  const area = svg.querySelector('.spark-area'), line = svg.querySelector('.spark-line');
  if (spark.length < 2) { area.setAttribute('d', ''); line.setAttribute('d', ''); return; }
  const max = Math.max(1, ...spark), step = 100 / (SPARK_N - 1), off = SPARK_N - spark.length;
  const pts = spark.map((v, i) => [((off + i) * step).toFixed(2), (27 - (v / max) * 24).toFixed(2)]);
  const d = 'M' + pts.map(p => p.join(',')).join(' L');
  line.setAttribute('d', d);
  area.setAttribute('d', d + ` L${pts[pts.length - 1][0]},28 L${pts[0][0]},28 Z`);
}

function connMenu() {
  const r = $('q-conn').getBoundingClientRect();
  const cur = state.settings.concurrency;
  const set = v => saveSettings({ concurrency: v }).then(renderQueueHead);
  const items = [{ head: 'Files at the same time' },
    { label: 'Auto: filo finds the fastest', radio: true, on: cur === 'auto', action: () => set('auto') }, 'sep'];
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
    if (state.qstate !== 'running') return playQueue();
    API.queuePause();
    refreshAfterStop(new Set(['up', 'down']));
  };
  $('q-stop').onclick = () => { state.blocked = null; renderBlocked(); API.queueStopAll(); refreshAfterStop(new Set(['up', 'down'])); };
  $('q-conn').onclick = connMenu;
  $('q-sync').onclick = syncToggle;
  $('q-verify').addEventListener('change', async () => {
    await saveSettings({ verify: $('q-verify').checked });
    renderVerifySwitch();
    toast($('q-verify').checked ? 'Checksum on — for every file that starts from now' : 'Checksum off — size only, for every file that starts from now', !$('q-verify').checked);
  });
  $('q-retry').onclick = () => retryItems([]);
  $('q-clear').onclick = async () => {
    if (state.qtab === 'log') { API.copyText(state.logs.map(l => `${fmtTime(l.t)} ${l.level.toUpperCase()} ${l.msg}`).join('\n')); toast('Log copied'); return; }
    if (state.qtab === 'queue') {
      const c = state.qcounts;
      const n = (c.queued || 0) + (c.waiting || 0) + (c.running || 0) + (c.asking || 0) + (c.paused || 0);
      if (!n) return;
      if (!(await confirmBox(`Remove ${plural(n, 'item')} from the queue?`, 'Running transfers stop, and their partial files are deleted.', 'REMOVE', true))) return;
    }
    if (state.qtab === 'failed') {
      const c = state.qcounts;
      const n = (c.failed || 0) + (c.stopped || 0);
      if (!n) return;
      if (!(await confirmBox(`Remove ${plural(n, 'item')} from the Failed list?`, 'Their partial files are deleted: a retry would start again from zero.', 'REMOVE', true))) return;
    }
    API.queueClear(state.qtab);
  };
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
  $('st-ntfy-res').textContent = '';
  renderVerifyRows();
  $('st-known-q').value = '';
  await renderKnown();
  $('ov-settings').classList.add('open');
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
  const ntfyPatch = () => ({ enabled: $('st-ntfy-en').checked, server: $('st-ntfy-server').value.trim(), topic: $('st-ntfy-topic').value.trim() });
  for (const id of ['st-ntfy-en', 'st-ntfy-server', 'st-ntfy-topic']) $(id).addEventListener('change', async () => { state.ntfy = await API.ntfySave(ntfyPatch()); });
  $('st-ntfy-test').onclick = async () => {
    const r = await API.ntfyTest(ntfyPatch());
    const el = $('st-ntfy-res');
    el.className = 'set-test-res ' + (r.ok ? 'ok' : 'err');
    el.textContent = r.ok ? 'Sent' : r.error;
  };
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
  b.classList.toggle('set', v !== 'none');
  b.innerHTML = AFTER[v][1];
  b.dataset.tip = `When the queue finishes: ${AFTER[v][0].toLowerCase()}`;
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
  panels.local.load(panels.local.dir, { keepSel: true });
  if (state.conn) { panels.remote.cache.delete(panels.remote.dir); panels.remote.load(panels.remote.dir, { keepSel: true }); }
  const secs = Math.round(s.durationMs / 1000);
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
  bindTooltips(); bindSplitters(); bindSites(); bindQueue(); bindSettings();
  renderConnPill(); renderAfterBtn(); renderQueueHead(); renderVerifySwitch(); renderSync();
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
    showMenu(r.right - 220, r.bottom + 6, [{ head: 'When the queue finishes' }].concat(['none', 'quit', 'sleep', 'shutdown'].map(v => ({
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
    state.qstate = s; if (s === 'running') state.qRan = true; if (s === 'running' && afterState.timer) stopCountdown(); renderQueueHead(); if (s === 'running') { state.blocked = null; renderBlocked(); } });
  API.on('queue-ask', a => { state.asks.push(a); nextAsk(); });
  API.on('queue-ask-closed', id => {
    state.asks = state.asks.filter(a => a.askId !== id);
    if (dialogTag === 'ask:' + id) closeDialog({ closed: true });
    for (let i = dialogWait.length - 1; i >= 0; i--) if (dialogWait[i].o.tag === 'ask:' + id) dialogWait.splice(i, 1)[0].resolve({ closed: true });
  });
  API.on('queue-blocked', b => { state.blocked = b; renderBlocked(); });
  API.on('queue-finished', s => onFinished(s));
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
  API.on('update-available', u => { $('upd').innerHTML = ` · <a id="lnk-upd">filo ${esc(u.version)} is available</a>`; $('lnk-upd').onclick = () => API.openExternal(u.url); });
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
      default: return null;
    }
  });
  panels.local.scroll.focus();
}

init();
