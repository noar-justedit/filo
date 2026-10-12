/*
 * filo — FTP, FTPS and SFTP client
 * Copyright (C) 2026 Just Edit (Arnaud Augst)
 * Licensed under the GNU General Public License v3.0 or later. See LICENSE.
 */

// The command line: another program (ingesto, presto, a script) asks filo to
// send, fetch or synchronise. See docs/CLI.md.
//
// The filo executable started with a command (`filo upload …`) never opens a
// window of its own. It talks to the filo that is running — starting it when
// there is none — through a local channel only this user can use:
//   - a Unix socket in filo's profile folder (macOS, Linux), or a named pipe
//     (Windows);
//   - plus a random token, re-made at each start of filo and kept in the
//     profile folder (readable by this user only), sent with every request.
// So there is one filo, one queue, and what a command adds shows in the
// window. No password ever travels on the command line: commands use the
// sites of the site manager, with their saved password or key.

const net = require('net');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// "sync" is the earlier name of LIVE SYNC: still understood, so a script
// written then keeps working.
const COMMANDS = ['upload', 'download', 'livesync', 'sync', 'queue', 'status', 'help', 'version'];

const HELP = `filo — command line

  filo upload   --site <site> --to <server folder>  <local file or folder>…
  filo download --site <site> --to <local folder>   <server file or folder>…
  filo livesync --pair <live sync>
  filo queue    start | pause | stop
  filo status
  filo help | version

Options
  --wait         wait until the files are done; the exit code tells how it went
  --json         one JSON line per event (for programs)
  --out <file>   also write the final result, as JSON, to this file
  --background   when filo has to be started, start it minimised

  <site> and <live sync> are names from filo (site manager, LIVE SYNC window),
  or ids.
  No password on the command line: the site's saved password or key is used.

Exit codes
  0  done (with --wait: every file arrived and was verified)
  1  some files failed or were stopped
  2  the command is not right (see above)
  3  the site or the live sync does not exist, or cannot be used
  4  filo could not be started or reached

Examples
  filo upload --site "Studio NAS" --to /Rushes/Day2 --wait /Volumes/CARD_A/A001
  filo download --site "Client SFTP" --to ~/Projects/Doha /Delivery/Final_v3.mov
  filo livesync --pair "Exports → client" --wait --json
`;

// argv: what follows the executable (and, in development, the app folder).
// Returns null when this is not a command (a normal start of the app).
function parse(argv) {
  const a = (argv || []).filter(x => !/^-psn_/.test(x) && x !== '--dev');
  const i = a.findIndex(x => COMMANDS.includes(x) || x === '--help' || x === '-h' || x === '--version');
  if (i < 0) return null;
  const cmdWord = a[i];
  const cmd = cmdWord === '--help' || cmdWord === '-h' ? 'help' : cmdWord === '--version' ? 'version' : cmdWord === 'sync' ? 'livesync' : cmdWord;
  const rest = a.slice(i + 1);
  const o = { cmd, site: null, pair: null, to: null, wait: false, json: false, out: null, background: false, args: [] };
  for (let k = 0; k < rest.length; k++) {
    const x = rest[k];
    const val = () => { const v = rest[++k]; if (v == null) throw new Error(`${x} needs a value`); return v; };
    try {
      if (x === '--site') o.site = val();
      else if (x === '--pair') o.pair = val();
      else if (x === '--to') o.to = val();
      else if (x === '--out') o.out = val();
      else if (x === '--wait') o.wait = true;
      else if (x === '--json') o.json = true;
      else if (x === '--background') o.background = true;
      else if (/^--/.test(x)) return { cmd, error: `unknown option ${x}` };
      else o.args.push(x);
    } catch (e) { return { cmd, error: e.message }; }
  }
  if (cmd === 'upload' || cmd === 'download') {
    if (!o.site) return { cmd, error: '--site is missing' };
    if (!o.to) return { cmd, error: '--to is missing' };
    if (!o.args.length) return { cmd, error: `nothing to ${cmd}` };
  }
  if (cmd === 'livesync' && !o.pair) return { cmd, error: '--pair is missing' };
  if (cmd === 'queue' && !['start', 'pause', 'stop'].includes(o.args[0])) return { cmd, error: 'queue start | pause | stop' };
  return o;
}

function channel(userData) {
  if (process.platform === 'win32') return '\\\\.\\pipe\\filo-cli-' + crypto.createHash('sha1').update(userData.toLowerCase()).digest('hex').slice(0, 16);
  return path.join(userData, 'cli.sock');
}
const tokenFile = userData => path.join(userData, 'cli-token');

// ── In the running filo ─────────────────────────────────────────────────────
// handler(req, emit) → Promise<final object>; emit(event) streams events.
function serve(userData, handler, log) {
  const where = channel(userData);
  const token = crypto.randomBytes(24).toString('hex');
  try { fs.writeFileSync(tokenFile(userData), token, { mode: 0o600 }); } catch (_) {}
  if (process.platform !== 'win32') { try { fs.unlinkSync(where); } catch (_) {} }
  const server = net.createServer(sock => {
    let buf = '', taken = false;
    sock.setEncoding('utf8');
    sock.on('error', () => {});
    sock.on('data', async chunk => {
      if (taken) return;                              // one request per connection
      buf += chunk;
      if (buf.length > 1024 * 1024) { sock.destroy(); return; }
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      const line = buf.slice(0, nl); buf = ''; taken = true;
      let req;
      try { req = JSON.parse(line); } catch (_) { sock.end(JSON.stringify({ type: 'result', code: 2, error: 'bad request' }) + '\n'); return; }
      const a = Buffer.from(String(req.token || '')), b = Buffer.from(token);
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) { sock.end(JSON.stringify({ type: 'result', code: 4, error: 'refused' }) + '\n'); return; }
      const emit = ev => { if (!sock.destroyed) sock.write(JSON.stringify(ev) + '\n'); };
      let res;
      try { res = await handler(req, emit, () => sock.destroyed); }
      catch (e) { res = { code: 4, error: e.message }; }
      if (!sock.destroyed) sock.end(JSON.stringify(Object.assign({ type: 'result' }, res)) + '\n');
    });
  });
  server.on('error', e => { if (log) log('warn', `Command line not available: ${e.message}`); });
  server.listen(where, () => { if (process.platform !== 'win32') { try { fs.chmodSync(where, 0o600); } catch (_) {} } });
  return server;
}

// ── In the command started by another program ───────────────────────────────
function connectOnce(where) {
  return new Promise((resolve, reject) => {
    const s = net.connect(where);
    s.once('connect', () => resolve(s));
    s.once('error', reject);
  });
}

// opts: { userData, spawnApp: () => void, write: line => void }
async function client(o, opts) {
  const write = opts.write;
  const done = (code, obj) => {
    const res = Object.assign({ type: 'result', code }, obj || {});
    if (o.out) { try { fs.writeFileSync(o.out, JSON.stringify(res, null, 2)); } catch (_) {} }
    if (o.json) write(JSON.stringify(res));
    else if (res.error) write(`filo: ${res.error}`);
    else if (res.message) write(`filo: ${res.message}`);
    return code;
  };
  if (o.error) { write(`filo: ${o.error}\n`); write(HELP); return done(2, { error: o.error }); }
  if (o.cmd === 'help') { write(HELP); return 0; }
  if (o.cmd === 'version') { write(opts.version); return 0; }

  // Local paths are the caller's: made absolute here, from its folder.
  if (o.cmd === 'upload') o.args = o.args.map(p => path.resolve(p));
  if (o.cmd === 'download') o.to = path.resolve(o.to);

  const where = channel(opts.userData);
  let sock = null;
  try { sock = await connectOnce(where); }
  catch (_) {
    opts.spawnApp(o.background);
    for (let i = 0; i < 60 && !sock; i++) {
      await new Promise(r => setTimeout(r, 500));
      try { sock = await connectOnce(where); } catch (_) {}
    }
  }
  if (!sock) return done(4, { error: 'filo could not be started or reached.' });
  let token = '';
  try { token = fs.readFileSync(tokenFile(opts.userData), 'utf8').trim(); } catch (_) {}
  return new Promise(resolve => {
    let buf = '', final = null;
    sock.setEncoding('utf8');
    sock.on('data', chunk => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        let ev; try { ev = JSON.parse(line); } catch (_) { continue; }
        if (ev.type === 'result') { final = ev; continue; }
        if (o.json) write(JSON.stringify(ev));
        else if (ev.message) write(`filo: ${ev.message}`);
      }
    });
    const finish = () => {
      if (!final) return resolve(done(4, { error: 'filo stopped answering.' }));
      const { type: _t, code, ...rest } = final;
      resolve(done(code == null ? 0 : code, rest));
    };
    sock.on('end', finish);
    sock.on('error', () => { if (!final) resolve(done(4, { error: 'filo stopped answering.' })); });
    const req = Object.assign({ token }, o);
    delete req.out; delete req.json;
    sock.write(JSON.stringify(req) + '\n');
  });
}

module.exports = { parse, serve, client, channel, HELP, COMMANDS };
