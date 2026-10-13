'use strict';
// ── The command after the queue (Noar, 12/10/2026) ─────────────────────────
// The same as ingesto's post-ingest command: what Noar typed, run WITHOUT a
// shell. The line is cut into arguments (quotes keep spaces together), then
// each argument has its {variables} replaced as a whole value, never the
// program itself (argv[0]): a file or folder name, whatever it holds, stays
// one argument and can never become a command.
//
// Variables:
//   {result}  ok | errors      {done}   files transferred   {failed}  files failed
//   {bytes}   bytes moved      {server} the server(s)
//   {local}   the local folder the files share   {remote}  the server folder
//   {direction} up | down | both
//
// Windows: a .bat or .cmd cannot start without a shell; call its interpreter
// (cmd /c script.bat) or use an .exe / PowerShell: powershell -File x.ps1.
const { spawn } = require('child_process');
const path = require('path');

function tokenize(str) {
  const out = []; let cur = '', q = null, has = false;
  for (const c of String(str || '')) {
    if (q) { if (c === q) q = null; else cur += c; continue; }
    if (c === '"' || c === "'") { q = c; has = true; continue; }
    if (c === ' ' || c === '\t') { if (has || cur) { out.push(cur); cur = ''; has = false; } continue; }
    cur += c; has = true;
  }
  if (has || cur) out.push(cur);
  return out;
}

function argvFor(cmd, vars) {
  return tokenize(cmd).map((tok, i) => {
    if (i === 0) return tok;
    let t = tok;
    for (const [k, v] of Object.entries(vars || {})) t = t.split('{' + k + '}').join(String(v == null ? '' : v));
    return t;
  });
}

// The folder a list of paths shares ('' for none), in their own style.
function commonDir(paths, posix) {
  const P = posix ? path.posix : path;
  const list = paths.filter(Boolean);
  if (!list.length) return '';
  let common = P.dirname(list[0]).split(P.sep);
  for (const p of list.slice(1)) {
    const s = P.dirname(p).split(P.sep);
    let i = 0; while (i < common.length && i < s.length && common[i] === s[i]) i++;
    common = common.slice(0, i);
  }
  return common.join(P.sep) || P.sep;
}

// What the command is told about the run that just ended.
function varsFor(summary, items) {
  const files = (items || []).filter(i => i.type !== 'folder');
  const ups = files.filter(i => i.dir === 'up'), downs = files.filter(i => i.dir !== 'up');
  return {
    result: summary.failed || summary.stopped ? 'errors' : 'ok',
    done: summary.done || 0, failed: summary.failed || 0, bytes: summary.bytes || 0,
    server: summary.endpointLabel || '',
    local: commonDir(files.map(i => i.local), false),
    remote: commonDir(files.map(i => i.remote), true),
    direction: ups.length && downs.length ? 'both' : ups.length ? 'up' : 'down',
  };
}

// Runs it and waits for its end (the end action, quit or shut down, comes
// after it), up to timeoutMs; past that it is left running and filo goes on.
function run(argv, { timeoutMs = 30 * 60000 } = {}) {
  return new Promise(resolve => {
    if (!Array.isArray(argv) || !argv.length || !String(argv[0] || '').trim()) return resolve({ ok: false, error: 'no command' });
    let settled = false, child;
    const done = v => { if (!settled) { settled = true; clearTimeout(t); resolve(v); } };
    const t = setTimeout(() => done({ ok: false, error: `still running after ${Math.round(timeoutMs / 60000)} min: filo goes on without it` }), timeoutMs);
    if (t.unref) t.unref();
    try { child = spawn(argv[0], argv.slice(1), { windowsHide: true, stdio: 'ignore' }); }
    catch (e) { return done({ ok: false, error: e.message }); }
    child.on('error', e => done({ ok: false, error: e.code === 'ENOENT' ? `${argv[0]} not found` : e.message }));
    child.on('exit', (code, sig) => done(code === 0 ? { ok: true, code } : { ok: false, code, error: sig ? `stopped (${sig})` : `exit code ${code}` }));
  });
}

module.exports = { tokenize, argvFor, varsFor, run, commonDir };
