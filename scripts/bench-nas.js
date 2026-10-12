/*
 * filo — FTP, FTPS and SFTP client
 * Copyright (C) 2026 Just Edit (Arnaud Augst)
 * Licensed under the GNU General Public License v3.0 or later. See LICENSE.
 */

// Speed test between this computer and a NAS (or any server). Started by
// bench-nas.command. Two questions only: which of filo's sites, and its
// password (typed hidden, kept in this process only). Everything else is
// found or chosen here:
//   - the server folder: the site's home folder + /filo-bench (removed after);
//   - the SMB reference: a share of the same NAS already mounted in the
//     Finder, found by itself (skipped when there is none);
//   - FTPS and FTP: tried on port 21 with the same account (skipped when the
//     NAS does not offer them).
// What is measured, each time sending then receiving: SMB, OpenSSH sftp,
// filo SFTP with 1 connection, filo SFTP Auto + segments (with and without
// checksum), filo SFTP Auto on many small files, filo FTPS and FTP.
// Environment variables can still set anything (BENCH_HOST, BENCH_PORT,
// BENCH_USER, BENCH_PW, BENCH_REMOTE, BENCH_SMB, BENCH_BIG_GB, BENCH_SMALL_N,
// BENCH_SMALL_MB, BENCH_DIR).

const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const proto = require(path.join(ROOT, 'src/main/proto'));
const { setHostKeyPolicy } = require(path.join(ROOT, 'src/main/proto/sftp'));
const { setCertPolicy } = require(path.join(ROOT, 'src/main/proto/ftp'));
const { TransferQueue } = require(path.join(ROOT, 'src/main/core/queue'));

const E = process.env;
const num = v => Number(String(v == null ? '' : v).replace(',', '.'));
let HOST = E.BENCH_HOST, PORT = num(E.BENCH_PORT) || 22, USER = E.BENCH_USER, PW = E.BENCH_PW || '';
let REMOTE = E.BENCH_REMOTE ? E.BENCH_REMOTE.replace(/\/+$/, '') : '';
let MODE = E.BENCH_MODE || '';
let SMB = E.BENCH_SMB ? E.BENCH_SMB.replace(/\/+$/, '') : '';
const BIG = Math.round(Math.max(0.5, num(E.BENCH_BIG_GB) || 10) * 1024 ** 3);
const SMALL_N = Math.max(10, num(E.BENCH_SMALL_N) || 200), SMALL = Math.round(Math.max(0.1, num(E.BENCH_SMALL_MB) || 20) * 1024 ** 2);
const DIR = E.BENCH_DIR || path.join(os.homedir(), 'filo-bench');
const MB = 1024 * 1024;

const lines = [];
const say = (s = '') => { console.log(s); lines.push(s); };
const mbps = (bytes, ms) => (bytes / MB) / (ms / 1000);
const fmt = v => (v == null ? '—' : `${v.toFixed(0)} MB/s`);

// The server's identity: accepted at first sight for this test, and shown.
let fingerprint = null;
setHostKeyPolicy({ known: () => fingerprint, remember: (_k, _h, _p, fp) => { fingerprint = fp; } });
let certFp = null;
setCertPolicy({ known: () => certFp, remember: (_k, _h, _p, fp) => { certFp = fp; } });
const EP = () => ({ protocol: 'sftp', host: HOST, port: PORT, user: USER, password: PW, acceptFingerprint: fingerprint });
const FTP_EP = protocol => ({ protocol, host: HOST, port: 21, user: USER, password: PW, acceptFingerprint: certFp });

async function connect() {
  let r = proto.createRemote(EP());
  try { await r.connect(); return r; }
  catch (e) {
    if (e.code !== 'TRUST_NEEDED') throw e;
    fingerprint = e.trust.fingerprint;
    say(`Server identity: ${fingerprint}`);
    r = proto.createRemote(EP());
    await r.connect();
    return r;
  }
}

// ── Test files ─────────────────────────────────────────────────────────────
// Random content: a NAS or a link that compresses would make zeros look fast.
function writeRandom(file, size) {
  if (fs.existsSync(file) && fs.statSync(file).size === size) return;
  const fd = fs.openSync(file, 'w');
  const block = Buffer.alloc(16 * MB);
  for (let done = 0; done < size;) {
    const n = Math.min(block.length, size - done);
    crypto.randomFillSync(block, 0, n);
    fs.writeSync(fd, block, 0, n);
    done += n;
  }
  fs.closeSync(fd);
}
function prepare() {
  fs.mkdirSync(path.join(DIR, 'small'), { recursive: true });
  say(`Preparing the test files in ${DIR} (only once)…`);
  writeRandom(path.join(DIR, 'big.bin'), BIG);
  for (let i = 0; i < SMALL_N; i++) writeRandom(path.join(DIR, 'small', `clip_${String(i).padStart(4, '0')}.bin`), SMALL);
}

// ── The NAS itself, watched through SSH (an administrator account) ─────────
// The SFTP account rarely has a shell (on a Synology, only administrators
// do), so the load of the NAS is read with a second account, asked at the
// start (Enter skips it). Read before and after each line:
//  - the processor, in total;
//  - the busiest SSH process, in % of ONE core: a single SFTP connection is
//    served by a single process, so by a single core. Near 100 %, the NAS
//    processor is the limit of that line, whatever the client does;
//  - the busiest disk (% of the time it was working).
function askpassEnv(pw) {
  const ap = path.join(DIR, '.askpass.sh');
  fs.writeFileSync(ap, '#!/bin/sh\nprintf "%s\\n" "$BENCH_PW"\n', { mode: 0o700 });
  // The password typed at the start goes to ssh through this variable, in
  // memory only (never in the script file).
  return Object.assign({}, process.env, { BENCH_PW: pw == null ? PW : pw, SSH_ASKPASS: ap, SSH_ASKPASS_REQUIRE: 'force', DISPLAY: process.env.DISPLAY || ':0' });
}
const SSH_OPTS = (port) => ['-p', String(port || PORT), '-o', 'StrictHostKeyChecking=accept-new', '-o', `UserKnownHostsFile=${path.join(DIR, '.known_hosts')}`, '-o', 'NumberOfPasswordPrompts=1', '-o', 'ConnectTimeout=8'];
let MON = { user: E.BENCH_SSH_USER || '', port: num(E.BENCH_SSH_PORT) || 22, pw: E.BENCH_SSH_PW || '' };
function sshRun(cmd) {
  if (!MON.user) return null;
  const r = spawnSync('ssh', [...SSH_OPTS(MON.port), `${MON.user}@${HOST}`, cmd], { env: askpassEnv(MON.pw), encoding: 'utf8', timeout: 20000 });
  return r.status === 0 ? r.stdout : null;
}
const SNAP = 'getconf CLK_TCK; echo @@; cat /proc/stat; echo @@; for p in /proc/[0-9]*; do read -r s < "$p/stat" 2>/dev/null && echo "$s"; done | grep -E "\\((sshd|sftp-server)\\)"; echo @@; cat /proc/diskstats';
function snapshot() {
  const out = sshRun(SNAP);
  if (!out) return null;
  const [hz, stat, procs, disks] = out.split('@@\n');
  const cpu = (stat || '').split('\n').find(l => /^cpu\s/.test(l));
  const n = cpu ? cpu.trim().split(/\s+/).slice(1).map(Number) : [];
  const p = new Map();
  for (const l of (procs || '').split('\n')) {
    const m = /^(\d+) \((.*)\) (.*)$/.exec(l.trim());
    if (!m) continue;
    const f = m[3].split(' ');
    p.set(m[1], { name: m[2], ticks: Number(f[11]) + Number(f[12]) });
  }
  const d = new Map();
  for (const l of (disks || '').split('\n')) {
    const t = l.trim().split(/\s+/);
    if (t.length > 12 && /^(sd[a-z]+|sata\d+|nvme\d+n\d+)$/.test(t[2])) d.set(t[2], Number(t[12]));
  }
  return { at: Date.now(), hz: Number(hz) || 100, idle: (n[3] || 0) + (n[4] || 0), total: n.reduce((x, y) => x + y, 0), p, d };
}
function nasLoad(a, b) {
  if (!a || !b || b.total <= a.total) return null;
  const sec = (b.at - a.at) / 1000;
  const cpu = Math.round(100 * (1 - (b.idle - a.idle) / (b.total - a.total)));
  let top = null;
  for (const [pid, x] of b.p) {
    const y = a.p.get(pid);
    const pct = Math.round(100 * (x.ticks - (y ? y.ticks : 0)) / (b.hz * sec));
    if (!top || pct > top.pct) top = { pct: Math.min(100, pct), name: x.name };
  }
  let disk = null;
  for (const [name, ms] of b.d) {
    const pct = Math.min(100, Math.round(100 * (ms - (a.d.get(name) || ms)) / (sec * 1000)));
    if (!disk || pct > disk.pct) disk = { pct, name };
  }
  return { cpu, top, disk };
}
let shellOk = false;
async function measure(label, bytes, fn) {
  const s0 = shellOk ? snapshot() : null;
  const t0 = Date.now();
  let err = null;
  try { await fn(); } catch (e) { err = e; }
  const ms = Date.now() - t0;
  const load = shellOk ? nasLoad(s0, snapshot()) : null;
  if (err) { say(`  ${label.padEnd(46)} FAILED: ${err.message}`); return { label, error: err.message }; }
  const v = mbps(bytes, ms);
  const nas = load ? `   NAS: CPU ${load.cpu} %${load.top ? ` · ${load.top.name} ${load.top.pct} % of a core` : ''}${load.disk ? ` · disk ${load.disk.pct} %` : ''}` : '';
  say(`  ${label.padEnd(46)} ${fmt(v).padStart(9)}   ${(ms / 1000).toFixed(1).padStart(6)} s${nas}`);
  return { label, mbps: Math.round(v), seconds: ms / 1000, nas: load };
}

// ── The references ─────────────────────────────────────────────────────────
function run(cmd, args, env, input) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { env: env || process.env, stdio: [input ? 'pipe' : 'ignore', 'ignore', 'pipe'] });
    if (input) { p.stdin.end(input); }
    let errText = '';
    p.stderr.on('data', d => { errText += d; });
    // The last lines say why (the very last one is often just "Connection closed").
    p.on('close', code => (code === 0 ? resolve() : reject(new Error(errText.trim().split('\n').filter(Boolean).slice(-3).join(' | ') || `${cmd} ended with ${code}`))));
  });
}
async function smbTests(results) {
  if (!SMB) return;
  if (!fs.existsSync(SMB)) { say(`  SMB: ${SMB} is not mounted, skipped`); return; }
  const dst = path.join(SMB, 'filo-bench-smb');
  fs.mkdirSync(dst, { recursive: true });
  results.push(await measure('1. SMB (Finder share)  send', BIG, () => run('cp', [path.join(DIR, 'big.bin'), path.join(dst, 'big.bin')])));
  // Read back from the share. macOS may serve it from memory right after
  // writing it: the copy below is from the share, the cache is emptied
  // when `purge` is allowed (it asks for nothing when it is not).
  spawnSync('purge', [], { timeout: 60000 });
  const back = path.join(DIR, 'down'); fs.rmSync(back, { recursive: true, force: true }); fs.mkdirSync(back, { recursive: true });
  results.push(await measure('1. SMB (Finder share)  receive', BIG, () => run('cp', [path.join(dst, 'big.bin'), path.join(back, 'big.bin')])));
  fs.rmSync(dst, { recursive: true, force: true });
}
async function opensshTests(results) {
  const back = path.join(DIR, 'down'); fs.rmSync(back, { recursive: true, force: true }); fs.mkdirSync(back, { recursive: true });
  // The commands go in through stdin, not "-b": batch mode forbids a password.
  const up = `-mkdir ${REMOTE}\nput "${path.join(DIR, 'big.bin')}" "${REMOTE}/ssh.bin"\nbye\n`;
  const down = `get "${REMOTE}/ssh.bin" "${path.join(back, 'ssh.bin')}"\nrm "${REMOTE}/ssh.bin"\nbye\n`;
  const args = [...SSH_OPTS().map(x => (x === '-p' ? '-P' : x)), `${USER}@${HOST}`];
  results.push(await measure('2. OpenSSH sftp  send', BIG, async () => { await run('sftp', args, askpassEnv(), up); if (!fs.existsSync(path.join(DIR, 'big.bin'))) throw new Error('?'); }));
  results.push(await measure('2. OpenSSH sftp  receive', BIG, async () => { await run('sftp', args, askpassEnv(), down); if (!fs.existsSync(path.join(back, 'ssh.bin')) || fs.statSync(path.join(back, 'ssh.bin')).size !== BIG) throw new Error('the file did not arrive (password, or SFTP refused)'); }));
}

// ── filo's own engine ──────────────────────────────────────────────────────
function queue(settings, tuneLog, ep) {
  return new TransferQueue({
    laneMode: 'worker',
    getEndpoint: async () => (ep ? ep() : EP()),
    settings: () => Object.assign({ autoMax: 10, retries: 2, existingUp: 'overwrite', existingDown: 'overwrite', verify: true, serverHash: true, readBack: true, tempNames: true, segments: true, keepDates: true, limitUp: 0, limitDown: 0 }, settings),
    log: (lv, m) => { if (/^Auto:|segments of|Server checksums/.test(m)) tuneLog.push(m); if (lv === 'error') tuneLog.push('error: ' + m); },
  });
}
function runQ(q, specs) {
  return new Promise((resolve, reject) => {
    // Waiting for a password or a trust that nobody will give: a failure.
    q.once('blocked', b => { q.stopAll(); reject(new Error((b && b.message) || 'the server refused')); });
    q.add(specs);
    q.once('finished', s => (s.failed ? reject(new Error(`${s.failed} file(s) failed: ${(s.errors[0] || {}).message || ''}`)) : resolve(s)));
    q.start();
  });
}
async function filoTest(results, tag, settings, files, remoteSub, ep) {
  const tune = [];
  const rdir = `${REMOTE}/${remoteSub}`;
  const back = path.join(DIR, 'down'); fs.rmSync(back, { recursive: true, force: true }); fs.mkdirSync(back, { recursive: true });
  const bytes = files.reduce((a, f) => a + fs.statSync(f).size, 0);
  let q = queue(settings, tune, ep);
  results.push(await measure(`${tag}  send`, bytes, () => runQ(q, files.map(f => ({ dir: 'up', type: 'file', local: f, remote: `${rdir}/${path.basename(f)}`, size: fs.statSync(f).size, endpointId: 'b', endpointLabel: 'bench' })))));
  q.closeAll();
  q = queue(settings, tune, ep);
  results.push(await measure(`${tag}  receive`, bytes, () => runQ(q, files.map(f => ({ dir: 'down', type: 'file', local: path.join(back, path.basename(f)), remote: `${rdir}/${path.basename(f)}`, size: fs.statSync(f).size, endpointId: 'b', endpointLabel: 'bench' })))));
  q.closeAll();
  const notes = [...new Set(tune)].slice(0, 12);
  for (const n of notes) say(`      ${n}`);
  results[results.length - 1].log = notes;
}

// ── The two questions ──────────────────────────────────────────────────────
function profileDirs() {
  const h = os.homedir();
  if (process.platform === 'darwin') return [path.join(h, 'Library/Application Support/filo')];
  if (process.platform === 'win32') return [path.join(E.APPDATA || h, 'filo')];
  return [path.join(E.XDG_CONFIG_HOME || path.join(h, '.config'), 'filo')];
}
function filoSites() {
  for (const d of profileDirs()) {
    try { const j = JSON.parse(fs.readFileSync(path.join(d, 'preferences.json'), 'utf8')); return (j.sites || []).filter(s => s.protocol === 'sftp'); } catch (_) {}
  }
  return [];
}
function ask(q, hidden) {
  return new Promise(resolve => {
    process.stdout.write(q);
    const stdin = process.stdin;
    let val = '';
    if (hidden && stdin.isTTY) stdin.setRawMode(true);
    stdin.resume(); stdin.setEncoding('utf8');
    const on = ch => {
      for (const c of ch) {
        if (c === '\r' || c === '\n') { stdin.removeListener('data', on); if (hidden && stdin.isTTY) stdin.setRawMode(false); stdin.pause(); process.stdout.write('\n'); return resolve(val); }
        if (c === '\u0003') process.exit(1);
        if (c === '\u007f' || c === '\b') { val = val.slice(0, -1); continue; }
        val += c;
        if (!hidden) continue;
      }
    };
    stdin.on('data', on);
  });
}
async function questions() {
  // What the environment already gives (BENCH_HOST, BENCH_USER…) is not asked.
  if (!HOST) {
    const sites = filoSites();
    if (sites.length) {
      console.log('Your SFTP sites in filo:');
      sites.forEach((s, i) => console.log(`  ${i + 1}. ${s.name}  (${s.user}@${s.host}:${s.port || 22})`));
      const n = parseInt(await ask(`Which one? [1]: `), 10) || 1;
      const s = sites[Math.min(sites.length, Math.max(1, n)) - 1];
      HOST = s.host; PORT = Number(s.port) || 22; USER = USER || s.user;
    } else {
      HOST = (await ask('NAS address (e.g. 192.168.1.20): ')).trim();
      PORT = num(await ask('SFTP port [22]: ')) || 22;
    }
  }
  if (!USER) USER = (await ask('User: ')).trim();
  if (!PW) PW = await ask('Password (hidden): ', true);
  // The load of the NAS during each line: an account allowed to use SSH (on a
  // Synology, an administrator; Control Panel → Terminal & SNMP → SSH).
  if (!MON.user && !E.BENCH_SSH_SKIP) {
    MON.user = (await ask('NAS load: administrator account for SSH [Enter = skip]: ')).trim();
    if (MON.user) {
      MON.port = num(await ask(`SSH port (Control Panel → Terminal & SNMP) [${MON.port}]: `)) || MON.port;
      MON.pw = await ask(`Password of ${MON.user} (hidden, Enter = same as above): `, true) || PW;
    }
  } else if (MON.user && !MON.pw) MON.pw = await ask(`Password of ${MON.user} for SSH (hidden, Enter = same as above): `, true) || PW;
  // Enter = filo looks for a folder where this account may write. The test
  // works in a "filo-bench" folder made inside it, removed at the end.
  if (!REMOTE) REMOTE = (await ask('Server folder for the test [Enter = find one]: ')).trim().replace(/\/+$/, '');
  if (!MODE) MODE = (await ask('1 = quick: one connection, filo against OpenSSH, ~5 min · 2 = everything, ~30 min [1]: ')).trim() === '2' ? 'full' : 'quick';
}
// A share of the same NAS mounted in the Finder (macOS / Linux).
function findSmb() {
  if (SMB) return SMB;
  const r = spawnSync('mount', [], { encoding: 'utf8' });
  for (const line of String(r.stdout || '').split('\n')) {
    const m = /^\/\/(?:[^@]*@)?([^/]+)\/\S* on (.+?) \((smbfs|cifs)/.exec(line);
    if (m && m[1].toLowerCase() === String(HOST).toLowerCase()) {
      try { fs.accessSync(m[2], fs.constants.W_OK); return m[2]; } catch (_) {}
    }
  }
  return '';
}
function portOpen(port) {
  return new Promise(resolve => {
    const s = net.connect({ host: HOST, port, timeout: 3000 });
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('error', () => resolve(false));
    s.once('timeout', () => { s.destroy(); resolve(false); });
  });
}

// ── Probes: one connection, filo's SFTP engine alone, against OpenSSH ──────
// Nothing is written to this computer's disk and nothing is verified: only
// the SFTP conversation is measured, with different depths (requests in
// flight), request sizes and receive windows. Each line moves PROBE bytes.
// The first line is repeated at the end: if the two differ a lot, the NAS
// itself changed speed during the test (cache, disks), and the lines in
// between must be read with that in mind.
const PROBE = Math.round(Math.max(0.5, num(E.BENCH_PROBE_GB) || 3) * 1024 ** 3);
function opensshCipher() {
  const r = spawnSync('sftp', ['-v', ...SSH_OPTS().map(x => (x === '-p' ? '-P' : x)), `${USER}@${HOST}`], { env: askpassEnv(), input: 'bye\n', encoding: 'utf8', timeout: 20000 });
  const m = /kex: server->client cipher: (\S+) MAC: (\S+)/.exec(r.stderr || '');
  return m ? `${m[1]}${m[2] === '<implicit>' ? '' : ' + ' + m[2]}` : 'unknown';
}
async function probes(results) {
  const { PipelinedReader, PipelinedWriter } = require(path.join(ROOT, 'src/main/proto/sftp-pipe'));
  const { Readable, Writable, pipeline } = require('stream');
  const file = `${REMOTE}/probe.bin`;
  // The file sent is a real one on this computer (~/filo-bench/probe.bin),
  // the same for filo and OpenSSH, and kept afterwards: it can be sent with
  // another client (FileZilla) for a comparison on the very same file.
  const local = path.join(DIR, 'probe.bin');
  if (!(fs.existsSync(local) && fs.statSync(local).size === PROBE)) say(`  Preparing ${local} (${(PROBE / 1024 ** 3).toFixed(1)} GB, only once)…`);
  writeRandom(local, PROBE);
  const source = () => fs.createReadStream(local, { highWaterMark: 8 * MB });
  const sink = () => new Writable({ highWaterMark: 8 * MB, write(c, e, cb) { cb(); } });
  const r0 = await connect();
  // This script and filo's own files must come from the same folder (same ZIP).
  if (typeof r0._chunk !== 'function') { r0.close(); throw new Error('this test needs filo\'s files from the same ZIP (src/ is older than scripts/bench-nas.js). Unzip the latest test ZIP and run it from there.'); }
  const a = r0.algos && r0.algos.cs;
  say(`  Cipher: filo ${a ? a.cipher + (/gcm|poly1305/.test(a.cipher) ? '' : ' + ' + a.mac) : 'unknown'} · OpenSSH ${opensshCipher()} · requests up to ${Math.round(r0._chunk('read') / 1024)} KB`);
  r0.close();
  // Each line on a connection of its own: a setting left by one line (window,
  // depth) must not slow down the next.
  const one = async (label, fn) => {
    const r = await connect();
    try { results.push(await measure(label, PROBE, () => fn(r))); } finally { r.close(); }
  };
  const pipe = (from, to) => new Promise((res, rej) => pipeline(from, to, e => (e ? rej(e) : res())));
  const w = (chunk, depth) => r => pipe(source(), new PipelinedWriter(r, file, { chunkSize: chunk, concurrency: depth }));
  // The window asked here is the one used: the reader's own request is turned off.
  const rd = (chunk, depth, win) => r => { if (win) { r._wantWindow(win); r._wantWindow = () => {}; } return pipe(new PipelinedReader(r, file, depth ? { chunkSize: chunk, concurrency: depth } : { chunkSize: chunk }), sink()); };
  const now = { send: r => pipe(source(), r.createWriteStream(file)), receive: r => pipe(r.createReadStream(file), sink()) };
  await one('P1. filo send, as filo does now', now.send);
  await one('P2. filo send     32 KB × 64 (filo 0.3.4)', w(32 * 1024, 64));
  await one('P3. filo send     32 KB × 256', w(32 * 1024, 256));
  await one('P4. filo send    255 KB × 128', w(255 * 1024, 128));
  await one('P5. filo receive, as filo does now', now.receive);
  // What filo did before the TEST g fix: requests as large as the server takes.
  await one('P6. filo receive 254 KB, adaptive (before)', r => rd(Math.max(4096, Math.min(Number(r.sftp && r.sftp._maxReadLen) || 32 * 1024, 256 * 1024)), 0)(r));
  await one('P7. filo receive 255 KB × 32, window 8 MB', rd(255 * 1024, 32, 8 * MB));
  await one('P8. filo receive 255 KB × 64, window 16 MB', rd(255 * 1024, 64, 16 * MB));
  // OpenSSH: the same file, to nowhere, and a local copy sent back.
  const args = [...SSH_OPTS().map(x => (x === '-p' ? '-P' : x)), `${USER}@${HOST}`];
  await one('P9. OpenSSH receive', () => run('sftp', args, askpassEnv(), `get "${file}" /dev/null\nbye\n`));
  await one('P10. OpenSSH send', () => run('sftp', args, askpassEnv(), `put "${local}" "${file}"\nbye\n`));
  // The first ones again: has the NAS changed speed meanwhile?
  await one('P11. filo send, as filo does now (again)', now.send);
  await one('P12. filo receive, as filo does now (again)', now.receive);
  const r2 = await connect();
  await r2.unlink(file).catch(() => {});
  r2.close();
}

// ── The Rust engine (prototype, engine/), against OpenSSH ──────────────────
// BENCH_MODE=engine (scripts/bench-engine.command builds it first). The same
// file as the P lines (~/filo-bench/probe.bin), sent then received, OpenSSH
// first as the reference, then the engine on 1, 2 and 4 connections (the file
// in contiguous parts). Received to nowhere, like the P lines.
const ENGINE = E.BENCH_ENGINE || path.join(ROOT, 'engine', 'target', 'release', process.platform === 'win32' ? 'filo-engine.exe' : 'filo-engine');
function runEngine(args) {
  return new Promise((resolve, reject) => {
    const p = spawn(ENGINE, args, { env: Object.assign({}, process.env, { FILO_PW: PW }), stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    p.stdout.on('data', d => { out += d; });
    p.on('error', reject);
    p.on('close', () => {
      let r = null;
      try { r = JSON.parse(out.trim().split('\n').pop()); } catch (_) {}
      if (r && r.ok) return resolve(r);
      reject(new Error((r && r.error) || out.trim() || 'the engine stopped'));
    });
  });
}
async function engineTests(results) {
  if (!fs.existsSync(ENGINE)) throw new Error(`the engine is not built (${ENGINE}): start scripts/bench-engine.command`);
  const local = path.join(DIR, 'probe.bin');
  if (!(fs.existsSync(local) && fs.statSync(local).size === PROBE)) say(`  Preparing ${local} (${(PROBE / 1024 ** 3).toFixed(1)} GB, only once)…`);
  writeRandom(local, PROBE);
  const file = `${REMOTE}/probe.bin`;
  const base = ['--host', HOST, '--port', String(PORT), '--user', USER, '--fingerprint', fingerprint || ''];
  const args = [...SSH_OPTS().map(x => (x === '-p' ? '-P' : x)), `${USER}@${HOST}`];
  let cipher = '';
  const eng = (label, cmd, conns) => measure(label, PROBE, async () => {
    const r = await runEngine([cmd, ...base, '--remote', file, '--local', cmd === 'get' ? '-' : local, '--conns', String(conns), '--chunk', cmd === 'get' ? '32768' : '261120', '--depth', '64']);
    cipher = r.cipher;
  });
  say(`  Cipher: OpenSSH ${opensshCipher()}`);
  results.push(await measure('R1. OpenSSH send', PROBE, () => run('sftp', args, askpassEnv(), `put "${local}" "${file}"\nbye\n`)));
  results.push(await eng('R2. Rust send, 1 connection', 'put', 1));
  results.push(await eng('R3. Rust send, 2 connections', 'put', 2));
  results.push(await eng('R4. Rust send, 4 connections', 'put', 4));
  results.push(await measure('R5. OpenSSH receive', PROBE, () => run('sftp', args, askpassEnv(), `get "${file}" /dev/null\nbye\n`)));
  results.push(await eng('R6. Rust receive, 1 connection', 'get', 1));
  results.push(await eng('R7. Rust receive, 2 connections', 'get', 2));
  results.push(await eng('R8. Rust receive, 4 connections', 'get', 4));
  results.push(await eng('R9. Rust receive, 1 connection (again)', 'get', 1));
  if (cipher) say(`  Cipher: Rust engine ${cipher}`);
}

// A folder of the server where this account may write. A Synology shows its
// shared folders at the root ("/video", "/homes"…) and "/" itself takes no
// file: the home folder first, then the usual homes, then each share.
async function writableFolder(r) {
  const tryDir = async base => {
    const dir = base.replace(/\/+$/, '') + '/filo-bench';
    try { await r.mkdir(dir); } catch (_) {}
    const st = await r.stat(dir).catch(() => null);
    if (!st || st.type !== 'folder') return null;
    // Exists: may we write in it? A small folder made and removed tells.
    const probe = dir + '/.probe-' + process.pid;
    try { await r.mkdir(probe); await r.rmdir(probe); return dir; } catch (_) { return null; }
  };
  if (REMOTE) { const d = await tryDir(REMOTE.replace(/\/filo-bench$/, '')); if (!d) throw new Error(`filo may not write in ${REMOTE} with this account.`); return d; }
  const cand = [];
  const home = ((await r.home().catch(() => '')) || '').replace(/\/+$/, '');
  if (home) cand.push(home);
  cand.push('/home', `/homes/${USER}`);
  const root = await r.list('/').catch(() => []);
  for (const e of root) if ((e.type === 'folder' || e.linkTo === 'folder') && !/^(\.|#|@)/.test(e.name)) cand.push('/' + e.name);
  for (const c of [...new Set(cand)]) {
    if (!c) continue;
    const ok = await tryDir(c);
    if (ok) return ok;
  }
  return null;
}

async function main() {
  await questions();
  if (!HOST || !USER) throw new Error('No server given.');
  fs.mkdirSync(DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16);
  say('');
  say(`filo — speed test with ${USER}@${HOST}:${PORT}, ${new Date().toLocaleString()}`);
  say(`This computer: ${os.hostname()} · ${os.cpus().length} cores · ${process.platform} ${os.release()}`);

  const r = await connect();
  const algos = await r.hashAlgos().catch(() => []);
  REMOTE = await writableFolder(r);
  r.close();
  if (!REMOTE) throw new Error('No folder of this NAS accepts files from this account over SFTP. On a Synology: Control Panel → Shared Folder → give "' + USER + '" Read/Write on one share (or Control Panel → User → Advanced → enable the user home service).');
  say(`Server folder for the test: ${REMOTE}`);
  say(`Server checksums: ${algos.length ? algos.join(', ') : 'not available: filo reads each sent file back to verify it'}`);

  const info = MON.user ? sshRun('grep -c ^processor /proc/cpuinfo; cat /proc/sys/kernel/syno_hw_version 2>/dev/null || uname -m') : null;
  if (info) {
    shellOk = !!snapshot();
    const [cores, model] = info.trim().split('\n');
    say(`NAS: ${(model || '').trim() || 'model unknown'} · ${String(cores).trim()} cores · load read through SSH (${MON.user}, port ${MON.port})${shellOk ? '' : ', but /proc could not be read'}`);
  } else say(MON.user ? `NAS: SSH refused for ${MON.user} on port ${MON.port}: its load is not measured` : 'NAS: load not measured (no SSH account given)');
  SMB = findSmb();
  say(SMB ? `SMB share of the NAS found: ${SMB}` : 'SMB: no share of this NAS mounted in the Finder: skipped (Finder → Go → Connect to Server to add it)');
  const ftpOpen = await portOpen(21);
  say(ftpOpen ? 'FTP port 21 open: FTPS and FTP tested too' : 'FTP port 21 closed: FTPS and FTP skipped');
  say('');

  const results = [];
  if (MODE === 'engine') {
    say('Rust engine (prototype) against OpenSSH, nothing verified, received to nowhere');
    say(`  Test file: ${(PROBE / 1024 ** 3).toFixed(1)} GB`);
    await engineTests(results);
    say('');
    return finish(stamp, results, algos);
  }
  say('Probes: one connection, the SFTP conversation alone (nothing written here, nothing verified)');
  say(`  Test file: ${(PROBE / 1024 ** 3).toFixed(1)} GB`);
  await probes(results);
  say('');
  if (MODE !== 'full') return finish(stamp, results, algos);
  prepare();
  say(`Large file: ${(BIG / 1024 ** 3).toFixed(1)} GB · small files: ${SMALL_N} × ${(SMALL / MB).toFixed(1)} MB`);
  const big = [path.join(DIR, 'big.bin')];
  const small = fs.readdirSync(path.join(DIR, 'small')).sort().slice(0, SMALL_N).map(f => path.join(DIR, 'small', f));
  await smbTests(results);
  await opensshTests(results);
  await filoTest(results, '3. filo SFTP, 1 connection', { concurrency: 1, segments: false }, big, 't3');
  await filoTest(results, '4. filo SFTP, Auto + segments', { concurrency: 'auto' }, big, 't4');
  await filoTest(results, '5. filo SFTP, Auto, small files', { concurrency: 'auto' }, small, 't5');
  await filoTest(results, '6. filo SFTP, Auto + segm., no checksum', { concurrency: 'auto', verify: false }, big, 't6');
  // The same thing FileZilla does: one connection, one file, nothing verified.
  await filoTest(results, '6b. filo SFTP, 1 connection, no checksum', { concurrency: 1, segments: false, verify: false }, big, 't6b');
  // FTPS / FTP with the same account: one connection first, to accept the
  // certificate and to see whether the account may use them at all.
  const ftpUsable = async protocol => {
    for (let i = 0; i < 2; i++) {
      const c = proto.createRemote(FTP_EP(protocol));
      try { await c.connect(); c.close(); return true; }
      catch (e) {
        if (e.code === 'TRUST_NEEDED' && e.trust) { certFp = e.trust.fingerprint; continue; }
        say(`  ${protocol.toUpperCase()}: ${e.message} — skipped`);
        return false;
      }
    }
    return false;
  };
  if (ftpOpen) {
    if (await ftpUsable('ftps')) await filoTest(results, '7. filo FTPS (encrypted), no checksum', { concurrency: 'auto', verify: false }, big, 't7', () => FTP_EP('ftps'));
    if (await ftpUsable('ftp')) await filoTest(results, '8. filo FTP (NOT encrypted), no checksum', { concurrency: 'auto', verify: false }, big, 't8', () => FTP_EP('ftp'));
  }

  return finish(stamp, results, algos);
}

async function finish(stamp, results, algos) {
  // Clean the server and the received copies; the test files stay for next time.
  try {
    const c = await connect();
    const rm = async d => { for (const e of await c.list(d).catch(() => [])) { const p = `${d}/${e.name}`; if (e.type === 'folder') await rm(p); else await c.unlink(p).catch(() => {}); } await c.rmdir(d).catch(() => {}); };
    await rm(REMOTE);
    c.close();
  } catch (_) {}
  fs.rmSync(path.join(DIR, 'down'), { recursive: true, force: true });

  say('');
  say('Reading: 1 Gb/s ≈ 110 MB/s at most · 2.5 Gb/s ≈ 280 MB/s · 10 Gb/s ≈ 1100 MB/s.');
  say('SMB much faster than SFTP = the NAS processor (encryption) is the limit, not the network.');
  if (results.some(x => x.nas)) say('NAS: "sshd N % of a core" near 100 % = the NAS processor is the limit of that line (one connection = one core); "disk" near 100 % = its disks.');
  if (results.some(x => /^R\d/.test(x.label))) say('R lines: the Rust engine (prototype) against OpenSSH, same file (~/filo-bench/probe.bin, kept), received to nowhere. If R6 and R9 differ a lot, the NAS changed speed during the test.');
  if (results.some(x => /^P\d/.test(x.label))) say('P lines: one connection, nothing verified; sent from ~/filo-bench/probe.bin (kept), received to nowhere. If P1 and P11 (or P5 and P12) differ a lot, the NAS changed speed during the test.');
  if (results.some(x => /^\d/.test(x.label))) say('Tests 3 to 5 include the checksum, as filo is used every day; 6 to 8 show the speed without it (6b = what FileZilla does: one connection, nothing verified).');
  const out = path.join(DIR, `results-${stamp}.txt`);
  fs.writeFileSync(out, lines.join('\n') + '\n');
  fs.writeFileSync(out.replace(/\.txt$/, '.json'), JSON.stringify({ host: HOST, port: PORT, big: BIG, small: [SMALL_N, SMALL], algos, results }, null, 2));
  say('');
  say(`Saved: ${out}`);
  process.exit(0);
}

main().catch(e => { say(`\nThe test stopped: ${e.message}`); process.exit(1); });
