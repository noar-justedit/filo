/*
 * filo — engine test suite
 * Copyright (C) 2026 Just Edit (Arnaud Augst)
 * Licensed under the GNU General Public License v3.0 or later. See LICENSE.
 *
 * Plain `node test/run-tests.js` (or `npm test`). No Electron, no window, no
 * network: a real SFTP server runs inside this process (test/sftp-server.js),
 * on real files in a temporary folder.
 *
 * FTP / FTPS are tested against real servers only when they are given:
 *   FILO_TEST_FTP=host:port FILO_TEST_FTPS=host:port FILO_TEST_FTP_USER=… FILO_TEST_FTP_PASS=…
 * (see ETAT_PROJET.md, "Tests").
 */

'use strict';

// Small segments, so a few-megabyte file is already split. Must be set before
// core/transfer.js is loaded.
process.env.FILO_TEST_SEGMENT_MB = process.env.FILO_TEST_SEGMENT_MB || '1';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { startSftpServer } = require('./sftp-server');
const proto = require('../src/main/proto');
const { setHostKeyPolicy } = require('../src/main/proto/sftp');
const { setCertPolicy, parseListDate, parseFtpTimestamp, formatFtpTimestamp } = require('../src/main/proto/ftp');
const existing = require('../src/main/core/existing');
const sites = require('../src/main/core/sites');
const { safeLocalName } = require('../src/main/core/scan');
const { AutoTuner, better } = require('../src/main/core/autotune');
const { Limiter } = require('../src/main/core/throttle');
const hash = require('../src/main/core/hash');
const { RemoteError } = require('../src/main/core/errors');
const { TransferQueue } = require('../src/main/core/queue');
const transfer = require('../src/main/core/transfer');
const { normalizeSettings } = require('../src/main/config');
const notify = require('../src/main/notify');

let passed = 0, failed = 0;
const failures = [];
let section = '';
function ok(cond, label) {
  if (cond) { passed++; process.stdout.write('.'); }
  else { failed++; failures.push(`[${section}] ${label}`); process.stdout.write('x'); }
}
function eq(a, b, label) {
  const same = JSON.stringify(a) === JSON.stringify(b);
  if (same) { passed++; process.stdout.write('.'); }
  else { failed++; failures.push(`[${section}] ${label}\n      expected ${JSON.stringify(b)}\n      got      ${JSON.stringify(a)}`); process.stdout.write('x'); }
}

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'filo-test-'));
let caseNo = 0;
function scratch() { const d = path.join(ROOT, 'c' + (++caseNo)); fs.mkdirSync(d, { recursive: true }); return d; }
// Non-repeating content: a test that passes on zeros proves nothing.
function randomFile(p, size) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, crypto.randomBytes(size)); return p; }
const sha = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Every server the tests start is trusted on first sight.
const known = new Map();
const trustAll = {
  known: (k, h, p) => known.get(`${k}:${h}:${p}`) || null,
  remember: (k, h, p, fp) => known.set(`${k}:${h}:${p}`, fp),
};
setHostKeyPolicy(trustAll);
setCertPolicy(trustAll);

async function connectTrusting(ep) {
  let r = proto.createRemote(ep);
  try { await r.connect(); return r; }
  catch (e) {
    if (e.code !== 'TRUST_NEEDED') throw e;
    r = proto.createRemote(Object.assign({}, ep, { acceptFingerprint: e.trust.fingerprint }));
    await r.connect();
    return r;
  }
}

const SETTINGS = {
  concurrency: 3, autoMax: 10, retries: 3, existingUp: 'overwrite', existingDown: 'overwrite',
  verify: true, serverHash: true, readBack: true, tempNames: true, segments: true, keepDates: true,
  limitUp: 0, limitDown: 0,
};

function makeQueue(ep, settings, mode, extra) {
  const logs = [];
  const q = new TransferQueue(Object.assign({
    laneMode: mode || 'inline',
    getEndpoint: async () => Object.assign({}, ep, { known: { sftp: known.get(`sftp:${ep.host}:${ep.port}`), ftps: known.get(`ftps:${ep.host}:${ep.port}`) } }),
    settings: () => settings,
    log: (lv, m) => logs.push(`${lv} ${m}`),
  }, extra || {}));
  q.logs = logs;
  return q;
}
function runQueue(q, timeoutMs) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('queue timeout\n' + q.logs.slice(-15).join('\n'))), timeoutMs || 60000);
    q.once('finished', s => { clearTimeout(t); resolve(s); });
    q.start();
  });
}

// ══ Sections ═════════════════════════════════════════════════════════════
const SECTIONS = [];
const SEC = (name, fn) => SECTIONS.push([name, fn]);

SEC('urls', () => {
  const u = proto.parseUrl('sftp://noar@nas.local:2222/volume1/rushes');
  eq([u.protocol, u.user, u.host, u.port, u.path], ['sftp', 'noar', 'nas.local', 2222, '/volume1/rushes'], 'sftp url');
  eq(proto.parseUrl('ftpes://a:b%40c@h/').protocol, 'ftps', 'ftpes = explicit');
  eq(proto.parseUrl('ftpes://a:b%40c@h/').password, 'b@c', 'password decoded');
  eq(proto.parseUrl('ftps://h').protocol, 'ftps-implicit', 'ftps:// = implicit, like FileZilla');
  eq(proto.parseUrl('ftps://h').port, 990, 'implicit default port');
  eq(proto.parseUrl('sftp://[::1]:22/x').host, '::1', 'IPv6 host');
  eq(proto.parseUrl('nas.local'), null, 'a bare host is not a URL');
  eq(proto.describe({ protocol: 'sftp', host: 'h', port: 22, user: 'u', password: 'secret' }), 'sftp://u@h', 'describe never shows the password');
  ok(!proto.describe({ protocol: 'ftp', host: 'h', port: 21, user: 'u', password: 'secret' }).includes('secret'), 'no password in ftp description');
});

SEC('ftp dates', () => {
  const now = new Date(Date.UTC(2026, 9, 9, 12));
  eq(parseListDate('Oct 08 12:30', now), { t: Date.UTC(2026, 9, 8, 12, 30), hasTime: true }, 'this year, with time');
  eq(parseListDate('Dec 31 23:59', now).t, Date.UTC(2025, 11, 31, 23, 59), 'a future date is last year');
  eq(parseListDate('Jan 05  2024', now), { t: Date.UTC(2024, 0, 5), hasTime: false }, 'older, no time');
  eq(parseListDate('10-08-26 01:30PM', now).t, Date.UTC(2026, 9, 8, 13, 30), 'IIS format');
  eq(parseListDate('nonsense').t, 0, 'unknown format');
  const t = Date.UTC(2026, 2, 4, 5, 6, 7);
  eq(parseFtpTimestamp(formatFtpTimestamp(t)), t, 'MDTM/MFMT round trip');
  eq(parseFtpTimestamp('20260304050607.250'), t + 250, 'fractions');
});

SEC('existing', async () => {
  const src = { size: 100, mtime: 10000 }, older = { size: 100, mtime: 1000 }, smaller = { size: 40, mtime: 20000 }, bigger = { size: 200, mtime: 1 };
  eq(existing.resolve('overwrite', src, older), 'overwrite', 'overwrite');
  eq(existing.resolve('skip', src, older), 'skip', 'skip');
  eq(existing.resolve('newer', src, older), 'overwrite', 'newer: source newer');
  eq(existing.resolve('newer', src, { size: 1, mtime: 9000 }), 'skip', 'newer: within 2 s slack is not newer');
  eq(existing.resolve('newer', src, { size: 1, mtime: 0 }), 'overwrite', 'newer: unknown date → overwrite');
  eq(existing.resolve('sizeDiffers', src, older), 'skip', 'same size');
  eq(existing.resolve('sizeDiffers', src, smaller), 'overwrite', 'size differs');
  eq(existing.resolve('resume', src, smaller), 'resume', 'resume a smaller target');
  eq(existing.resolve('resume', src, older), 'skip', 'resume: same size = done');
  eq(existing.resolve('resume', src, bigger), 'overwrite', 'resume: bigger target is not a partial copy');
  eq(existing.resolve(undefined, src, older), 'skip', 'an unknown rule never overwrites');
  const taken = new Set(['clip.mov', 'clip (1).mov']);
  eq(await existing.freeName('clip.mov', async n => taken.has(n)), 'clip (2).mov', 'free name');
  eq(await existing.freeName('README', async () => false), 'README (1)', 'no extension');
});

SEC('ids: an SVG definition never shares its id with an element', () => {
  // 0.9.1: the ring's clipPath was called lv-disc, like the DISCONNECT button;
  // url(#lv-disc) found the button, the clip did nothing and the speed graph
  // came out of the ring.
  const rd = f => fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', f), 'utf8');
  const html = rd('index.html'), js = rd('app.js');
  const defs = [...js.matchAll(/<(?:clipPath|linearGradient|radialGradient|mask|filter|pattern)\s+id="([^"]+)"/g)].map(m => m[1]);
  ok(defs.length > 0, 'the SVG definitions are found');
  for (const id of defs) {
    const others = (html.match(new RegExp('\\bid="' + id + '"', 'g')) || []).length + (js.match(new RegExp('<(?!clipPath|linearGradient|radialGradient|mask|filter|pattern)[a-zA-Z]+[^>]*\\bid="' + id + '"', 'g')) || []).length;
    eq(others, 0, `the id "${id}" is used by nothing else`);
  }
});

SEC('sites', async () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<FileZilla3 version="3.71.1" platform="mac">
  <Servers>
    <Server>
      <Host>nas.local</Host><Port>2222</Port><Protocol>1</Protocol><Type>0</Type>
      <User>noar</User><Pass encoding="base64">${Buffer.from('pä$$ <&>').toString('base64')}</Pass>
      <Logontype>1</Logontype><PasvMode>MODE_DEFAULT</PasvMode><Name>NAS &amp; rushes</Name>
      <RemoteDir>1 0 7 volume1 10 My Rushes</RemoteDir><LocalDir>/Users/noar/Rushes</LocalDir>
    </Server>
    <Folder expanded="1">Clients
      <Server><Host>ftp.client.example</Host><Port>21</Port><Protocol>4</Protocol><Type>0</Type><User>x</User>
        <Pass encoding="crypt" pubkey="abc">ZZZZ</Pass><Logontype>1</Logontype><PasvMode>MODE_ACTIVE</PasvMode>
        <MaximumMultipleConnections>2</MaximumMultipleConnections><Name>Client X</Name></Server>
      <Folder expanded="0">Old
        <Server><Host>old.example</Host><Port>21</Port><Protocol>6</Protocol><Type>0</Type><User>w</User><Logontype>2</Logontype><Name>Old</Name></Server>
      </Folder>
    </Folder>
    <Server><Host>k.example</Host><Port>22</Port><Protocol>1</Protocol><Type>0</Type><User>u</User><Keyfile>/Users/noar/.ssh/id_ed25519</Keyfile><Logontype>5</Logontype><Name>Key</Name></Server>
    <Server><Host>imp.example</Host><Port>990</Port><Protocol>3</Protocol><Type>0</Type><Logontype>0</Logontype><Name>Anon</Name></Server>
  </Servers>
</FileZilla3>`;
  eq(sites.detectFormat(xml), 'filezilla', 'detect FileZilla');
  const list = sites.importFileZilla(xml);
  eq(list.length, 5, 'five servers, nested folders included');
  const nas = list[0];
  eq([nas.site.name, nas.site.protocol, nas.site.host, nas.site.port, nas.site.user, nas.site.logon], ['NAS & rushes', 'sftp', 'nas.local', 2222, 'noar', 'normal'], 'NAS fields');
  eq(nas.password, 'pä$$ <&>', 'base64 password decoded (UTF-8, special characters)');
  eq(nas.site.remoteDir, '/volume1/My Rushes', 'RemoteDir with a space in a name');
  eq(nas.site.localDir, '/Users/noar/Rushes', 'LocalDir');
  eq(list[1].site.folder, 'Clients', 'folder');
  eq(list[1].site.protocol, 'ftps', 'FTPES → ftps');
  eq(list[1].passwordEncrypted, true, 'master-password protected password is flagged, not read');
  eq(list[1].password, '', 'and not used');
  eq(list[1].site.transferMode, 'active', 'active mode kept');
  eq(list[1].site.maxConnections, 2, 'connection limit kept');
  eq(list[2].site.folder, 'Clients / Old', 'nested folder');
  eq([list[2].site.protocol, list[2].site.logon], ['ftp', 'ask'], 'insecure FTP + ask');
  eq([list[3].site.logon, list[3].site.keyPath], ['key', '/Users/noar/.ssh/id_ed25519'], 'key file');
  eq([list[4].site.protocol, list[4].site.logon], ['ftps-implicit', 'anonymous'], 'implicit + anonymous');
  eq(sites.parseFzRemoteDir('1 0 1 a 3 b c 1 c'), '/a/b c/c', 'RemoteDir read (names with a space)');

  // Export → import: nothing lost but the passwords.
  const withSecrets = list.map(x => Object.assign({}, x.site, { passwordEnc: 'BLOB', passphraseEnc: 'BLOB2' }));
  ok(typeof sites.exportFileZilla === 'undefined', 'no FileZilla export any more (import only)');
  const filoOut = await sites.exportFilo(withSecrets);
  ok(!filoOut.includes('BLOB'), 'filo export carries no password');
  eq(sites.detectFormat(filoOut), 'filo', 'detect filo');
  eq((await sites.importFilo(filoOut)).map(x => x.site.name), list.map(x => x.site.name), 'filo round trip');
  ok((await sites.importFilo(filoOut)).every(x => !x.site.passwordEnc), 'imported filo sites have no password');

  // Export with passwords (0.9.0): encrypted by a passphrase, tied to the hosts.
  const keep = list.map((x, i) => ({ password: i === 0 ? 'S3cret-pw!' : '', passphrase: i === 3 ? 'key-pass-77' : '' }));
  const PASS = 'correct horse battery';
  const encOut = await sites.exportFilo(list.map(x => x.site), { secrets: keep, passphrase: PASS });
  ok(!encOut.includes('S3cret-pw!') && !encOut.includes('key-pass-77'), 'encrypted export: no password in clear in the file');
  ok(sites.isEncrypted(encOut) && !sites.isEncrypted(filoOut), 'isEncrypted tells them apart');
  eq(JSON.parse(encOut).sites.map(x => x.host), list.map(x => x.site.host), 'encrypted export: the sites stay readable');
  const back = await sites.importFilo(encOut, PASS);
  eq([back[0].password, back[1].password, back[3].passphrase], ['S3cret-pw!', '', 'key-pass-77'], 'right passphrase: passwords and key passphrase come back');
  ok((await sites.importFilo(encOut)).every(x => !x.password && !x.passphrase), 'no passphrase given: sites only, no password');
  let code = null; try { await sites.importFilo(encOut, 'wrong passphrase!'); } catch (e) { code = e.code; }
  eq(code, 'BAD_PASSPHRASE', 'wrong passphrase refused');
  const tampered = JSON.parse(encOut); tampered.sites[0].host = 'evil.example.com';
  code = null; try { await sites.importFilo(JSON.stringify(tampered), PASS); } catch (e) { code = e.code; }
  eq(code, 'BAD_PASSPHRASE', 'a host edited after the export: refused, no password goes to another server');
  let short = null; try { await sites.exportFilo([list[0].site], { secrets: [{ password: 'x' }], passphrase: 'short' }); } catch (e) { short = e.message; }
  ok(/at least 10/.test(short || ''), 'passphrase under 10 characters refused');
  ok(JSON.parse(await sites.exportFilo([list[0].site], { secrets: [{ password: '' }], passphrase: PASS })).secrets === undefined, 'nothing to protect: plain export, no secrets block');
  eq(JSON.parse(encOut).version, 2, 'encrypted export is version 2');
  eq((await sites.importFilo(encOut.replace('"version": 2', '"version": 1'))).length, list.length, 'an older filo, which ignores the block, still reads the sites');

  const n = sites.normalizeSite({ protocol: 'ftp', logon: 'key', port: 99999, transferMode: 'active' });
  eq([n.logon, n.port, n.transferMode], ['normal', 21, 'active'], 'normalize: key only for SFTP, bad port fixed');
  eq(sites.normalizeSite({ protocol: 'sftp', transferMode: 'active' }).transferMode, 'passive', 'no active mode for SFTP');
  ok(!('passwordEnc' in sites.publicSite(sites.normalizeSite({ passwordEnc: 'x' }))), 'publicSite hides the blob');
  eq(sites.publicSite(sites.normalizeSite({ passwordEnc: 'x' })).hasPassword, true, 'but says one exists');
  eq(sites.parseXml('<a x="1&amp;2"><b>t&lt;</b><!-- <c/> --></a>').children[0].children[0].text, 't<', 'xml reader');
});

SEC('local folders', async () => {
  // ensureLocalDir walks up to what exists instead of a recursive mkdir
  // (which asks for the drive root on Windows and gets EPERM on S:\).
  const d = scratch();
  const { ensureLocalDirForTest } = transfer;
  await ensureLocalDirForTest(path.join(d, 'a', 'b', 'c'));
  ok(fs.statSync(path.join(d, 'a', 'b', 'c')).isDirectory(), 'nested folders created');
  await ensureLocalDirForTest(path.join(d, 'a', 'b', 'c'));
  ok(true, 'existing folder: no error');
  await ensureLocalDirForTest(path.parse(d).root);
  ok(true, 'a drive / filesystem root: nothing created, no error');
  fs.writeFileSync(path.join(d, 'file'), 'x');
  try { await ensureLocalDirForTest(path.join(d, 'file', 'sub')); ok(false, 'a file in the way must fail'); }
  catch (e) { ok(/not a folder/.test(e.message) || e.code === 'ENOTDIR', 'a file in the way is reported'); }
});

SEC('local names', () => {
  eq(safeLocalName('a:b*c?.mov', 'win32'), 'a_b_c_.mov', 'Windows forbidden characters');
  eq(safeLocalName('name. ', 'win32'), 'name__', 'trailing dot and space');
  eq(safeLocalName('CON.txt', 'win32'), '_CON.txt', 'reserved name');
  eq(safeLocalName('a:b', 'darwin'), 'a:b', 'macOS keeps ":"');
  eq(safeLocalName('a/b', 'linux'), 'a_b', 'never a separator');
});

SEC('auto tuner', () => {
  // Bandwidth-limited: two connections already fill the line.
  let t = new AutoTuner({ max: 10, start: 2, now: 0 });
  let now = 0;
  const window = (busy, bps, fps) => {
    now += 1600;                       // past the settling time
    t.winStart = Math.min(t.winStart, now - 0);
    const start = now;
    t.addBytes(0, start);
    t.winStart = start;
    t.winBytes = bps * 8; t.winFiles = Math.round(fps * 8);
    now += 8000;
    return t.tick(busy === undefined ? t.limit() : busy, 100, now);
  };
  window(undefined, 100e6, 0);  eq(t.limit(), 3, 'first window: climbs to 3');
  window(undefined, 160e6, 0);  eq(t.limit(), 4, '+60 %: climbs to 4');
  window(undefined, 162e6, 0);  eq(t.limit(), 3, 'no gain: back to the best (3)');
  eq(t.phase, 'hold', 'and holds');
  // Small files: bytes flat, files per second up.
  t = new AutoTuner({ max: 10, start: 2, now: 0 }); now = 0;
  window(undefined, 5e6, 20); window(undefined, 5.1e6, 30); window(undefined, 5e6, 42);
  eq(t.limit(), 5, 'files per second alone makes it climb');
  // A window where connections were idle does not count.
  t = new AutoTuner({ max: 10, start: 2, now: 0 }); now = 0;
  window(1, 100e6, 0);
  eq(t.limit(), 2, 'unsaturated window ignored');
  // The server refuses a connection: never above that again.
  t = new AutoTuner({ max: 10, start: 6, now: 0 });
  t.serverRefused(4, 0);
  eq(t.limit(), 4, 'server limit caps the level');
  t.setMax(2);
  eq(t.limit(), 2, 'a lower maximum wins');
  ok(better({ bps: 110, fps: 1 }, { bps: 100, fps: 1 }) && !better({ bps: 105, fps: 1 }, { bps: 100, fps: 1 }), 'better(): 10 % threshold');
  ok(!better({ bps: 200, fps: 0.5 }, { bps: 100, fps: 1 }), 'better(): one measure may not lose more than 10 %');
  // A file in segments: the climb starts at 4, once, and never above the caps.
  t = new AutoTuner({ max: 10, start: 2, now: 0 });
  ok(t.boost(4, 0) && t.limit() === 4, 'segments: starts at 4');
  ok(!t.boost(4, 0), 'segments: only once');
  t = new AutoTuner({ max: 3, start: 2, now: 0 });
  t.boost(4, 0); eq(t.limit(), 3, 'segments: never above the maximum');
  t = new AutoTuner({ max: 10, start: 2, now: 0 });
  t.serverRefused(2, 0); t.boost(4, 0); eq(t.limit(), 2, 'segments: never above a server limit');
  // A file SENT in segments: the climb starts at 1, once, and only on a fresh run.
  t = new AutoTuner({ max: 10, start: 2, now: 0 });
  ok(t.startLow(1, 0) && t.limit() === 1, 'segments sent: starts at 1');
  ok(!t.startLow(1, 0) && !t.boost(4, 0), 'segments sent: decided once (no later jump to 4)');
  t = new AutoTuner({ max: 10, start: 2, now: 0 });
  t.results.set(2, { bps: 100, fps: 1 });
  ok(!t.startLow(1, 0) && t.limit() === 2, 'segments sent: nothing lowered once something was measured');
});

SEC('ftp passive: always the control host', async () => {
  const transfer = require('basic-ftp/dist/transfer');
  const realConnect = transfer.connectForPassiveTransfer;
  const calls = [];
  // The module keeps its own reference: test through a fake ftp context whose
  // _newSocket records where the data connection goes.
  const fakeFtp = (replies) => ({
    socket: { remoteAddress: '::ffff:203.0.113.7' }, closed: false, timeout: 1000, ipFamily: undefined, tlsOptions: {},
    request: async cmd => { const r = replies[cmd]; if (r instanceof Error) throw r; calls.push(cmd); return { code: 200, message: r }; },
    _newSocket: () => {
      const { EventEmitter } = require('events');
      const so = new EventEmitter();
      so.setTimeout = () => {}; so.destroy = () => {}; so.removeListener = so.off;
      so.connect = (o, cb) => { calls.push(`connect ${o.host}:${o.port}`); setImmediate(cb); };
      return so;
    },
    set dataSocket(v) { this._ds = v; }, get dataSocket() { return this._ds; },
    log: () => {},
  });
  const { makePassive } = require('../src/main/proto/ftp-passive');
  // A server behind NAT: EPSV unknown, PASV announces its private address.
  let ftpc = fakeFtp({ EPSV: Object.assign(new Error('500 EPSV not understood'), { code: 500 }), PASV: '227 Entering Passive Mode (192,168,1,20,195,80)' });
  let prep = makePassive();
  await prep(ftpc);
  ok(calls.includes('connect 203.0.113.7:50000'), 'PASV: the port is kept, the address is the control host');
  ok(!calls.some(c => c.startsWith('connect 192.168')), 'PASV: the announced address is never used');
  calls.length = 0;
  await prep(ftpc);
  ok(!calls.includes('EPSV') && calls[0] === 'PASV', 'PASV kept for the next transfers');
  // A modern server: EPSV.
  calls.length = 0;
  ftpc = fakeFtp({ EPSV: '229 Entering Extended Passive Mode (|||6446|)' });
  await makePassive()(ftpc);
  ok(calls.includes('connect 203.0.113.7:6446'), 'EPSV: control host, given port');
  ok(realConnect === transfer.connectForPassiveTransfer, 'basic-ftp untouched');
});

SEC('throttle', async () => {
  const l = new Limiter();
  ok(l.take(1e9) === null, 'no limit: never waits');
  l.setRate(4e6);
  const t0 = Date.now();
  let n = 0;
  while (n < 6e6) { const w = l.take(512 * 1024); if (w) await w; n += 512 * 1024; }
  const s = (Date.now() - t0) / 1000;
  ok(s > 1.0 && s < 2.2, `6 MB at 4 MB/s takes ~1.5 s (took ${s.toFixed(2)} s)`);
  l.setRate(0);
  ok(l.take(1e9) === null, 'limit removed');
});

SEC('hash', async () => {
  const d = scratch();
  const f = randomFile(path.join(d, 'x.bin'), 3 * 1024 * 1024 + 17);
  eq(await hash.hashFile(f, 'sha256'), sha(f), 'SHA-256 = Node crypto');
  const buf = fs.readFileSync(f);
  eq(await hash.hashFile(f, 'md5', null, null, 1000, 2000), crypto.createHash('md5').update(buf.subarray(1000, 2000)).digest('hex'), 'range hash');
  eq(await hash.hashFile(f, 'sha1', null, null, 5, 5), crypto.createHash('sha1').digest('hex'), 'empty range');
  const x1 = await hash.hashFile(f, 'xxh64');
  const h = await hash.createHasher('xxh64'); h.init(); h.update(buf.subarray(0, 100)); h.update(buf.subarray(100));
  eq(h.digest().toLowerCase(), x1, 'xxHash64 streaming = whole');
  eq((await hash.hashFile(f, 'crc32')).length, 8, 'CRC32 is 8 hex digits');
});

SEC('errors', () => {
  const e = RemoteError.from(Object.assign(new Error('connect ECONNREFUSED 1.2.3.4:22'), { code: 'ECONNREFUSED' }));
  ok(e.fatal && !e.network, 'refused = fatal');
  ok(/nothing is listening/.test(e.message), 'refused: plain words');
  ok(RemoteError.from(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })).network, 'reset = network');
  ok(RemoteError.from(Object.assign(new Error('530 Login incorrect.'), { code: 530 })).fatal, '530 = fatal');
  ok(RemoteError.from(Object.assign(new Error('421 Too many'), { code: 421 })).network, '421 = try later');
  ok(RemoteError.from(new Error('All configured authentication methods failed')).fatal, 'SSH auth = fatal');
  ok(RemoteError.from(new Error('ENOSPC: no space left on device')).noSpace, 'no space');
  // A file error on this computer (Windows: mkdir 'S:\' on a mapped drive).
  const le = RemoteError.from(Object.assign(new Error("EPERM: operation not permitted, mkdir 'S:\\'"), { code: 'EPERM', syscall: 'mkdir', path: 'S:\\' }));
  ok(le.local && le.fatal && !le.network, 'local file error: fatal, not a network one');
  ok(/on this computer/.test(le.message) && !/EPERM/.test(le.message), `local file error in plain words (${le.message})`);
  const { serializeError } = require('../src/main/core/runner');
  const se = serializeError(Object.assign(new Error('EACCES: permission denied, open \'/x\''), { code: 'EACCES', syscall: 'open', path: '/x' }));
  ok(/on this computer/.test(se.message) && se.fatal, 'a worker thread sends the plain-words message');
});

SEC('settings', () => {
  const s = normalizeSettings({ concurrency: '14', retries: -3, existingUp: 'bogus', limitUp: '2.55', segments: 0 });
  eq([s.concurrency, s.retries, s.existingUp, s.limitUp, s.segments], [10, 0, 'ask', 2.6, false], 'normalized');
  eq(normalizeSettings({}).concurrency, 'auto', 'Auto by default');
  eq(normalizeSettings({}).verify, false, 'SAFE COPY off by default (0.9.6)');
  const n = notify.forQueue({ done: 2, bytes: 3e9, durationMs: 61000, verified: 2, endpointLabel: 'NAS' });
  ok(/^[\x20-\x7E]+$/.test(n.title), 'ntfy title is plain ASCII (it is an HTTP header)');
});

SEC('segment sizes', () => {
  // Measured by the code itself, not the test setting (FILO_TEST_SEGMENT_MB).
  const MB = 1024 * 1024, GB = 1024 * MB;
  const sizeFor = size => Math.min(256 * MB, Math.max(32 * MB, Math.ceil(size / 16 / MB) * MB));
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'core', 'transfer.js'), 'utf8');
  ok(/SEG_MIN = 32 \* MB, SEG_MAX = 256 \* MB, SEG_TARGET = 16/.test(src), 'segments: 32 to 256 MB, about 16 per file');
  eq([1 * GB, 4 * GB, 300 * GB].map(x => Math.ceil(x / sizeFor(x))), [16, 16, 1200], '1 GB and 4 GB: 16 segments; 300 GB: 256 MB each');
  eq(Math.ceil(100 * MB / sizeFor(100 * MB)), 4, '100 MB: 4 segments of 32 MB');
});

SEC('site manager order', () => {
  const { Prefs } = require('../src/main/config');
  const d = scratch();
  const p = new Prefs(d).load();
  const a = p.saveSite({ name: 'A', host: 'a' }), b = p.saveSite({ name: 'B', host: 'b', folder: 'X' }), c = p.saveSite({ name: 'C', host: 'c' });
  p.arrangeSites([{ id: c.id, folder: 'X / Y' }, { id: a.id, folder: '' }, { id: 'ffffffff', folder: 'Z' }], ['X', 'X / Y']);
  const again = new Prefs(d).load();
  eq(again.listSites().map(s => s.name + '@' + s.folder), ['C@X / Y', 'A@', 'B@X'], 'new order and folders kept; unknown id ignored; a forgotten site stays');
  eq(again.data.siteFolderOrder, ['X', 'X / Y'], 'folder order kept');
  // A copy goes right under its source (0.9.0).
  const cp = again.saveSite({ name: 'C copy', host: 'c' });
  again.placeAfter(cp.id, c.id);
  eq(again.listSites().map(s => s.name), ['C', 'C copy', 'A', 'B'], 'a duplicate lands right under its source');
  const cp2 = again.saveSite({ name: 'A copy', host: 'a' });
  again.placeAfter(cp2.id, a.id);
  eq(again.listSites().map(s => s.name), ['C', 'C copy', 'A', 'A copy', 'B'], 'and for a second one, under its own source');
  again.deleteSite(cp.id); again.deleteSite(cp2.id);
  // Recent connections: sites and quick ones; a deleted site leaves; a broken
  // entry on disk is dropped instead of blocking every connection.
  again.pushQuick({ siteId: a.id }); again.pushQuick({ protocol: 'sftp', host: 'h', port: 22, user: 'u' }); again.pushQuick({ siteId: a.id });
  eq(again.data.quickHistory.map(x => x.siteId ? 'site' : x.host), ['site', 'h'], 'recent: last first, no duplicate');
  again.deleteSite(a.id);
  eq(again.data.quickHistory.map(x => x.siteId ? 'site' : x.host), ['h'], 'recent: a deleted site leaves');
  const raw = JSON.parse(fs.readFileSync(path.join(d, 'preferences.json'), 'utf8'));
  raw.quickHistory = [null, 5, { siteId: 'abc' }, { host: 'k', protocol: 'ftp' }, {}];
  fs.writeFileSync(path.join(d, 'preferences.json'), JSON.stringify(raw));
  const third = new Prefs(d).load();
  eq(third.data.quickHistory.length, 2, 'recent: broken entries dropped on load');
  third.pushQuick({ protocol: 'sftp', host: 'z', port: 22 });
  eq(third.data.quickHistory.length, 3, 'recent: still works after');
});

SEC('preload bridge', () => {
  // A channel registered twice makes Electron throw at startup, and every
  // handler after it is missing: the window then cannot even connect.
  const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8');
  const handled = [...mainSrc.matchAll(/ipcMain\.handle\('([\w-]+)'/g)].map(x => x[1]);
  eq(handled.filter((c, i) => handled.indexOf(c) !== i), [], 'no channel registered twice');
  const preSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'preload.js'), 'utf8');
  const keys = [...preSrc.matchAll(/^\s*(\w+)\s*:/gm)].map(x => x[1]);
  eq(keys.filter((k, i) => keys.indexOf(k) !== i), [], 'no bridge method defined twice');
  // Every argument a method receives must reach ipcRenderer: a bridge that
  // drops one makes no noise (syncto's shutdown never worked until 0.7.3).
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'preload.js'), 'utf8');
  const re = /^\s*(\w+)\s*:\s*\(([^)]*)\)\s*=>\s*inv\('([\w-]+)'((?:,\s*[\w]+)*)\)/gm;
  let m, n = 0;
  while ((m = re.exec(src))) {
    n++;
    const params = m[2].split(',').map(x => x.trim()).filter(Boolean);
    const args = m[4].split(',').map(x => x.trim()).filter(Boolean);
    eq(args, params, `${m[1]} forwards every argument`);
  }
  ok(n > 40, `bridge methods checked (${n})`);
  // And every channel the bridge calls has a handler.
  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8');
  const chans = [...src.matchAll(/inv\('([\w-]+)'/g)].map(x => x[1]);
  for (const c of chans) ok(main.includes(`ipcMain.handle('${c}'`), `handler for ${c}`);
});

// ── Against a real SFTP server ────────────────────────────────────────────
let SRV = null, EP = null;
async function server(opts) {
  const root = scratch();
  const srv = await startSftpServer(Object.assign({ root }, opts || {}));
  // A new server may get the port of an earlier one, with another key: the
  // old identity must not make it look like an attack (an intermittent
  // "identity has changed" in the suite).
  known.delete(`sftp:127.0.0.1:${srv.port}`);
  const ep = { protocol: 'sftp', host: '127.0.0.1', port: srv.port, user: srv.username, password: srv.password };
  const r = await connectTrusting(ep);
  await r.close();
  return { srv, ep, root };
}

SEC('sftp basics', async () => {
  const { srv, ep, root } = await server();
  SRV = srv; EP = ep;
  const r = await connectTrusting(ep);
  const changed = proto.createRemote(Object.assign({}, ep));
  known.set(`sftp:${ep.host}:${ep.port}`, 'SHA256:somethingelse');
  try { await changed.connect(); ok(false, 'a changed host key must be refused'); }
  catch (e) { eq(e.code, 'HOST_KEY_CHANGED', 'changed host key refused before login'); }
  known.delete(`sftp:${ep.host}:${ep.port}`);
  const r2 = await connectTrusting(ep); await r2.close();
  await r.mkdir('/d');
  const big = crypto.randomBytes(300 * 1024 + 5);
  fs.writeFileSync(path.join(root, 'd', 'f.bin'), big);
  const list = await r.list('/d');
  eq(list.map(e => [e.name, e.type, e.size]), [['f.bin', 'file', big.length]], 'list');
  eq((await r.stat('/d/f.bin')).size, big.length, 'stat');
  eq(await r.stat('/d/nope'), null, 'stat of nothing = null');
  // Ranges.
  const chunks = [];
  const { Writable } = require('stream');
  await r.downloadRange('/d/f.bin', new Writable({ write(c, e, cb) { chunks.push(c); cb(); } }), 1000, 70000);
  ok(Buffer.concat(chunks).equals(big.subarray(1000, 70000)), 'downloadRange reads exactly [start, end)');
  const { Readable } = require('stream');
  await r.uploadRange(Readable.from([Buffer.alloc(100, 7)]), '/d/f.bin', 5000);
  const after = fs.readFileSync(path.join(root, 'd', 'f.bin'));
  ok(after.length === big.length && after.subarray(5000, 5100).equals(Buffer.alloc(100, 7)) && after.subarray(0, 5000).equals(big.subarray(0, 5000)) && after.subarray(5100).equals(big.subarray(5100)), 'uploadRange writes in place without truncating');
  await r.createEmpty('/d/empty.bin');
  eq(fs.statSync(path.join(root, 'd', 'empty.bin')).size, 0, 'createEmpty');
  await r.rename('/d/empty.bin', '/d/e2.bin');
  ok(fs.existsSync(path.join(root, 'd', 'e2.bin')), 'rename');
  await r.unlink('/d/e2.bin');
  ok(!fs.existsSync(path.join(root, 'd', 'e2.bin')), 'unlink');
  eq(await r.hashAlgos(), [], 'no shell on the test server: no server checksum');
  await r.close();
});

async function uploadDownloadCase(mode, extraSettings, size, label) {
  const d = scratch();
  const src = path.join(d, 'src');
  const files = {
    'a.mov': size,
    'sub/b.bin': 70 * 1024,
    'sub/deeper/c.txt': 0,                 // an empty file is still a file
  };
  for (const [rel, sz] of Object.entries(files)) randomFile(path.join(src, rel), sz);
  fs.mkdirSync(path.join(src, 'empty-folder'), { recursive: true });
  const settings = Object.assign({}, SETTINGS, extraSettings || {});
  const remoteBase = `/${label.replace(/\W+/g, '-')}`;
  // Upload
  let q = makeQueue(EP, settings, mode);
  const specs = [{ dir: 'up', type: 'folder', local: src, remote: remoteBase + '/src', endpointId: 'e', endpointLabel: 'test' }];
  for (const rel of Object.keys(files)) specs.push({ dir: 'up', type: 'file', local: path.join(src, rel), remote: `${remoteBase}/src/${rel}`, size: files[rel], endpointId: 'e', endpointLabel: 'test' });
  specs.push({ dir: 'up', type: 'folder', local: path.join(src, 'empty-folder'), remote: `${remoteBase}/src/empty-folder`, endpointId: 'e', endpointLabel: 'test' });
  q.add(specs);
  let s = await runQueue(q);
  q.closeAll();
  eq([s.done, s.failed], [3, 0], `${label}: upload done`);
  const serverRoot = SRV_ROOT();
  for (const rel of Object.keys(files)) eq(sha(path.join(serverRoot, remoteBase, 'src', rel)), sha(path.join(src, rel)), `${label}: ${rel} identical on the server`);
  ok(fs.existsSync(path.join(serverRoot, remoteBase, 'src', 'empty-folder')), `${label}: empty folder created`);
  ok(!fs.readdirSync(path.join(serverRoot, remoteBase, 'src')).some(n => n.endsWith('.filopart')), `${label}: no .filopart left`);
  // Download it all back
  q = makeQueue(EP, settings, mode);
  const back = path.join(d, 'back');
  q.add(Object.keys(files).map(rel => ({ dir: 'down', type: 'file', local: path.join(back, rel), remote: `${remoteBase}/src/${rel}`, size: files[rel], endpointId: 'e', endpointLabel: 'test' })));
  s = await runQueue(q);
  q.closeAll();
  eq([s.done, s.failed], [3, 0], `${label}: download done`);
  for (const rel of Object.keys(files)) eq(sha(path.join(back, rel)), sha(path.join(src, rel)), `${label}: ${rel} identical after the round trip`);
  const items = q.page('done', 0, 10).items;
  const big = items.find(i => i.local.endsWith('a.mov'));
  if (settings.verify) ok(big && big.verify && big.verify.level !== 'size', `${label}: the big file was verified (${big && JSON.stringify(big.verify)})`);
  else eq(big && big.verify, { level: 'size' }, `${label}: verification off = size only`);
  return { q, d };
}
let SRV_ROOT = () => '';

SEC('queue: inline lanes', async () => {
  const { srv, ep, root } = await server();
  SRV = srv; EP = ep; SRV_ROOT = () => root;
  await uploadDownloadCase('inline', {}, 300 * 1024, 'plain');
  await uploadDownloadCase('inline', { verify: false }, 300 * 1024, 'no verification');
  await srv.close();
});

SEC('read depth: grows with the round trip, not with its own queue', async () => {
  // The depth is sized on the shortest round trip. Sized on the average (which
  // is mostly the queue of requests ahead), it doubled itself every second up
  // to 1024, even on a LAN, and one connection ran 2 to 3 times slower.
  const { PipelinedReader } = require('../src/main/proto/sftp-pipe');
  const { Writable, pipeline } = require('stream');
  const read = async (srvOpts, size) => {
    const { srv, ep, root } = await server(srvOpts);
    fs.writeFileSync(path.join(root, 'd.bin'), crypto.randomBytes(size));
    const r = await connectTrusting(ep);
    const rd = new PipelinedReader(r, '/d.bin', {});
    let n = 0;
    await new Promise((res, rej) => pipeline(rd, new Writable({ write(c, e, cb) { n += c.length; cb(); } }), e => (e ? rej(e) : res())));
    await r.close(); await srv.close();
    return { n, depth: rd.limit };
  };
  const lan = await read({}, 48 * 1024 * 1024);
  ok(lan.n === 48 * 1024 * 1024 && lan.depth <= 128, `no latency: the depth stays low (${lan.depth})`);
  // The rule itself: what a link needs, from the shortest round trip.
  const rd = new PipelinedReader({}, '/x', {});
  const tune = (bytesPerSec, minRttMs) => { rd.limit = 64; rd.rtt = minRttMs; rd.rttPrev = 0; rd.rttAt = Date.now(); rd.winBytes = bytesPerSec; rd.winStart = Date.now() - 1000; rd._retune(); return rd.limit; };
  eq(tune(240e6, 0.3), 64, 'LAN, 240 MB/s, 0.3 ms: 64 requests are plenty');
  eq(tune(20e6, 100), 123, '100 ms at 20 MB/s: twice what the link holds (123 requests)');
  eq(tune(100e6, 150), 128, 'never more than double at once');
  const far = await read({ latencyMs: 60 }, 24 * 1024 * 1024);
  ok(far.n === 24 * 1024 * 1024 && far.depth > 64, `60 ms per reply: the depth grows (${far.depth})`);
});

SEC('queue: segments (worker threads)', async () => {
  const { srv, ep, root } = await server({ latencyMs: 2 });
  SRV = srv; EP = ep; SRV_ROOT = () => root;
  // 1 MB segments (FILO_TEST_SEGMENT_MB), from 2 MB: 5.5 MB = 6 segments.
  const { q } = await uploadDownloadCase('worker', { concurrency: 4 }, 5.5 * 1024 * 1024, 'segments');
  ok(q.logs.some(l => /6 segments/.test(l)), 'the big file was split in 6 segments');
  await srv.close();
});

// The Rust engine (engine/): only when it is built (cargo build --release in
// engine/) and not turned off (FILO_ENGINE=0). The other sections run through
// it too when it is there; this one checks that it really is the engine that
// moved the bytes, the speed limit, and the fall back to the built-in path.
SEC('rust engine', async () => {
  const { enginePath } = require('../src/main/proto/sftp-engine');
  if (!enginePath()) { process.stdout.write(' (skipped: engine not built, or FILO_ENGINE=0)'); return; }
  const { srv, ep, root } = await server();
  SRV = srv; EP = ep; SRV_ROOT = () => root;
  const d = scratch();
  const f = randomFile(path.join(d, 'up.bin'), 6 * 1024 * 1024);
  // Whole file and segments, both ways, with the checks.
  for (const segments of [false, true]) {
    let q = makeQueue(ep, Object.assign({}, SETTINGS, { segments, concurrency: 2 }), 'worker');
    q.add([{ dir: 'up', type: 'file', local: f, remote: `/eng${segments}/up.bin`, size: 6 * 1024 * 1024, endpointId: 'e', endpointLabel: 't' }]);
    let s = await runQueue(q); q.closeAll();
    eq([s.done, s.failed], [1, 0], `segments=${segments}: sent`);
    eq(sha(path.join(root, `eng${segments}`, 'up.bin')), sha(f), `segments=${segments}: identical on the server`);
    ok(q.logs.some(l => /Rust engine: /.test(l)), `segments=${segments}: the Rust engine moved it`);
    q = makeQueue(ep, Object.assign({}, SETTINGS, { segments, concurrency: 2 }), 'worker');
    q.add([{ dir: 'down', type: 'file', local: path.join(d, `back${segments}.bin`), remote: `/eng${segments}/up.bin`, size: 6 * 1024 * 1024, endpointId: 'e', endpointLabel: 't' }]);
    s = await runQueue(q); q.closeAll();
    eq([s.done, s.failed], [1, 0], `segments=${segments}: received`);
    eq(sha(path.join(d, `back${segments}.bin`)), sha(f), `segments=${segments}: identical on this disk`);
  }
  // The speed limit is applied by the engine: 6 MB at 2 MB/s takes 2.5 s at least.
  {
    const q = makeQueue(ep, Object.assign({}, SETTINGS, { segments: false, concurrency: 1, limitDown: 2 }), 'worker');
    q.add([{ dir: 'down', type: 'file', local: path.join(d, 'slow.bin'), remote: '/engfalse/up.bin', size: 6 * 1024 * 1024, endpointId: 'e', endpointLabel: 't' }]);
    const t0 = Date.now();
    const s = await runQueue(q); q.closeAll();
    const sec = (Date.now() - t0) / 1000;
    eq([s.done, s.failed], [1, 0], 'limited: received');
    ok(sec >= 2.5 && sec < 8, `limited to 2 MB/s: 6 MB took ${sec.toFixed(1)} s`);
    ok(q.logs.some(l => /Rust engine: /.test(l)), 'limited: still the Rust engine');
  }
  // The engine refused (here: a password the engine is given wrong): the
  // connection keeps the built-in engine, the file still arrives.
  {
    const r = await connectTrusting(ep);
    const logs = [];
    r.log = (lv, m) => logs.push(`${lv} ${m}`);
    r.opts.password = 'not-the-password';
    const got = await r.engineJob({ op: 'get', remote: '/engfalse/up.bin', local: path.join(d, 'x.bin'), start: 0, segment: false, hash: false }, () => {}, null, null);
    eq(got, null, 'refused: the caller moves the bytes itself');
    ok(r.engineOff && logs.some(l => /Rust engine not used/.test(l)), 'refused: said once in the log');
    await r.close();
  }
  await srv.close();
});

SEC('queue: pause and resume', async () => {
  const { srv, ep, root } = await server({ latencyMs: 8 });
  SRV = srv; EP = ep; SRV_ROOT = () => root;
  for (const segments of [false, true]) {
    const d = scratch();
    const f = randomFile(path.join(d, 'clip.mov'), 12 * 1024 * 1024);
    const settings = Object.assign({}, SETTINGS, { segments, concurrency: 2 });
    const q = makeQueue(ep, settings, 'inline');
    q.add([{ dir: 'up', type: 'file', local: f, remote: '/r' + segments + '/clip.mov', size: 12 * 1024 * 1024, endpointId: 'e', endpointLabel: 't' }]);
    let paused = false;
    q.on('progress', p => {
      const a = p.active[0];
      if (!paused && a && a.done > 6 * 1024 * 1024) { paused = true; q.pause(); }
    });
    q.start();
    for (let i = 0; i < 200 && !paused; i++) await sleep(50);
    ok(paused, `segments=${segments}: paused mid-file`);
    await sleep(300);
    eq(q.state, 'stopped', 'queue stopped');
    ok(fs.existsSync(path.join(root, 'r' + segments, 'clip.mov.filopart')), 'the partial file is kept');
    ok(!fs.existsSync(path.join(root, 'r' + segments, 'clip.mov')), 'the real name does not exist yet');
    const s = await runQueue(q);
    q.closeAll();
    eq([s.done, s.failed], [1, 0], `segments=${segments}: finished after resuming`);
    eq(sha(path.join(root, 'r' + segments, 'clip.mov')), sha(f), `segments=${segments}: identical`);
    ok(s.bytes < 12 * 1024 * 1024, `segments=${segments}: the resumed run did not send everything again (${s.bytes} bytes)`);
  }
  await srv.close();
});

SEC('queue: one file at a time (pause, stop, resume, stop all)', async () => {
  const { srv, ep, root } = await server({ latencyMs: 8 });
  SRV = srv; EP = ep; SRV_ROOT = () => root;
  for (const dir of ['up', 'down']) for (const mode of ['inline', 'worker']) {
    const d = scratch();
    const tag = `${dir}-${mode}`;
    const srcDir = dir === 'up' ? d : path.join(root, 'src-' + tag);
    fs.mkdirSync(srcDir, { recursive: true });
    const files = [0, 1, 2, 3].map(i => randomFile(path.join(srcDir, `c${i}.mov`), 16 * 1024 * 1024));
    const settings = Object.assign({}, SETTINGS, { concurrency: 2, limitUp: 4, limitDown: 4, segments: false });
    const q = makeQueue(ep, settings, mode);
    q.add([0, 1, 2, 3].map(i => dir === 'up'
      ? { dir, type: 'file', local: files[i], remote: `/one-${tag}/c${i}.mov`, size: 16 * 1024 * 1024, endpointId: 'e', endpointLabel: 't' }
      : { dir, type: 'file', local: path.join(d, 'got', `c${i}.mov`), remote: `/src-${tag}/c${i}.mov`, size: 16 * 1024 * 1024, endpointId: 'e', endpointLabel: 't' }));
    const ids = q.order.slice();
    const st = id => q.items.get(id).status;
    q.start();
    for (let i = 0; i < 200 && !(st(ids[0]) === 'running' && q.items.get(ids[0]).done > 0); i++) await sleep(25);
    q.pauseItems([ids[0]]);          // running → paused
    q.pauseItems([ids[3]]);          // queued → paused
    // A held file lets go of its connection at once, not when its transfer
    // would have finished (16 MB at 2 MB/s: 8 s).
    const settled = async (id) => { const t = Date.now(); for (let i = 0; i < 200 && q._unitsOf(q.items.get(id)).length; i++) await sleep(25); return Date.now() - t; };
    const t0 = await settled(ids[0]);
    ok(t0 < 2000, `${tag}: pausing a running file stops it at once (${t0} ms)`);
    eq([st(ids[0]), st(ids[3])], ['paused', 'paused'], `${tag}: a running and a queued file paused`);
    eq(q.state, 'running', `${tag}: the queue keeps going`);
    for (let i = 0; i < 200 && st(ids[1]) !== 'running'; i++) await sleep(25);
    q.stopItems([ids[1]]);
    await settled(ids[1]);
    eq(st(ids[1]), 'stopped', `${tag}: a running file stopped`);
    ok(q.page('failed', 0, 10).items.some(it => it.id === ids[1]), `${tag}: a stopped file is in the Failed tab`);
    ok(q.page('queue', 0, 10).items.some(it => it.id === ids[0]), `${tag}: a paused file stays in the Queue tab`);
    // Stop everything while files run.
    q.resumeItems([ids[0]]);
    for (let i = 0; i < 200 && st(ids[0]) !== 'running'; i++) await sleep(25);
    q.stopAll();
    let tAll = 0;
    for (const id of ids) tAll += await settled(id);
    ok(tAll < 2000, `${tag}: Stop all stops running files at once (${tAll} ms)`);
    eq(ids.map(st), ['stopped', 'stopped', 'stopped', 'stopped'], `${tag}: Stop all stops every file, running ones included`);
    eq(q.state, 'stopped', `${tag}: the queue is stopped`);
    // Retry → everything finishes, identical.
    settings.limitUp = 0; settings.limitDown = 0;
    // "Start again": a file that had started forgets its partial copy.
    q.retry([ids[0]], 'restart');
    eq([st(ids[0]), q.items.get(ids[0]).restartFromZero, q.items.get(ids[0]).offset], ['queued', true, 0], `${tag}: start again resets a started file`);
    q.retry([]);
    const s = await runQueue(q);
    q.closeAll();
    eq(s.failed, 0, `${tag}: retried files finish`);
    for (let i = 0; i < 4; i++) eq(sha(dir === 'up' ? path.join(root, `one-${tag}`, `c${i}.mov`) : path.join(d, 'got', `c${i}.mov`)), sha(files[i]), `${tag}: file ${i} identical`);
  }
  await srv.close();
});

SEC('queue: own partial file under the real name', async () => {
  const { srv, ep, root } = await server({ latencyMs: 8 });
  SRV = srv; EP = ep; SRV_ROOT = () => root;
  // No temporary names, rule "overwrite if newer": after a cut, the partial
  // file at the real name is newer than the source. It is filo's own work, so
  // it must be completed, not skipped as "already there".
  const d = scratch();
  const f = randomFile(path.join(d, 'own.mov'), 12 * 1024 * 1024);
  fs.utimesSync(f, new Date(Date.now() - 86400e3), new Date(Date.now() - 86400e3));
  const settings = Object.assign({}, SETTINGS, { tempNames: false, existingUp: 'newer', segments: false, concurrency: 1, limitUp: 4 });
  const q = makeQueue(ep, settings, 'inline');
  q.add([{ dir: 'up', type: 'file', local: f, remote: '/own/own.mov', size: 12 * 1024 * 1024, endpointId: 'e', endpointLabel: 't' }]);
  const id = q.order[0];
  q.start();
  for (let i = 0; i < 400 && !(q.items.get(id).done > 3 * 1024 * 1024); i++) await sleep(25);
  q.pause();
  for (let i = 0; i < 200 && q._unitsOf(q.items.get(id)).length; i++) await sleep(25);
  ok(fs.existsSync(path.join(root, 'own', 'own.mov')), 'the partial file is at the real name');
  settings.limitUp = 0;
  const s = await runQueue(q);
  q.closeAll();
  eq([s.done, s.skipped], [1, 0], 'completed, not skipped');
  eq(sha(path.join(root, 'own', 'own.mov')), sha(f), 'identical');
  // Removed while running: gone from the queue, and the queue finishes.
  const q2 = makeQueue(ep, Object.assign({}, settings, { limitUp: 4 }), 'inline');
  q2.add([{ dir: 'up', type: 'file', local: f, remote: '/own/gone.mov', size: 12 * 1024 * 1024, endpointId: 'e', endpointLabel: 't' },
          { dir: 'up', type: 'file', local: f, remote: '/own/stays.mov', size: 12 * 1024 * 1024, endpointId: 'e', endpointLabel: 't' }]);
  const gone = q2.order[0];
  const fin = new Promise(r => q2.once('finished', r));
  q2.start();
  for (let i = 0; i < 200 && q2.items.get(gone).status !== 'running'; i++) await sleep(25);
  q2.remove([gone]);
  for (let i = 0; i < 120 && q2.items.has(gone); i++) await sleep(25);
  ok(!q2.items.has(gone), 'a removed running file leaves the queue');
  q2.opts.settings = () => Object.assign({}, settings, { limitUp: 0 }); q2.applyLimits();
  await Promise.race([fin, sleep(30000)]);
  eq(q2.state, 'stopped', 'the queue still finishes');
  q2.closeAll();
  await srv.close();
});

SEC('local writes are grouped', async () => {
  // A slow disk (network drive): 32 KB pieces arriving while a write is on its
  // way go out together. Same bytes, far fewer writes.
  const { LocalSink } = require('../src/main/proto/local');
  const { Readable } = require('stream');
  const d = scratch();
  const out = path.join(d, 'sink.bin');
  const src = crypto.randomBytes(8 * 1024 * 1024);
  const orig = fs.write;
  let calls = 0;
  fs.write = function (fd, buf, off, len, pos, cb) { calls++; setTimeout(() => orig.call(fs, fd, buf, off, len, pos, cb), 3); };
  try {
    let at = 0;
    const r = new Readable({ highWaterMark: 64 * 1024, read() { setImmediate(() => { if (at >= src.length) return this.push(null); this.push(src.subarray(at, at + 32768)); at += 32768; }); } });
    await new Promise((res, rej) => r.pipe(new LocalSink(out, 0)).on('finish', res).on('error', rej));
  } finally { fs.write = orig; }
  eq(sha(out), crypto.createHash('sha256').update(src).digest('hex'), 'identical bytes');
  ok(calls < 256 / 2, `${calls} writes for 256 pieces`);
});

SEC('queue: resuming after a stop, a pause, a restart, or adding the file again', async () => {
  const { srv, ep, root } = await server({ latencyMs: 4 });
  SRV = srv; EP = ep; SRV_ROOT = () => root;
  const SZ = 16 * 1024 * 1024;
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  const f = randomFile(path.join(root, 'src', 'big.mov'), SZ);
  for (const segments of [false, true]) for (const how of ['stop-retry', 'pause-start', 'restart-app', 'add-again']) {
    const d = scratch();
    const memStore = { data: null, load() { return this.data; }, save(a) { this.data = JSON.parse(JSON.stringify(a)); } };
    const settings = Object.assign({}, SETTINGS, { segments, concurrency: 2, limitDown: 4 });
    const spec = () => [{ dir: 'down', type: 'file', local: path.join(d, 'big.mov'), remote: '/src/big.mov', size: SZ, endpointId: 'e', endpointLabel: 't' }];
    let q = makeQueue(ep, settings, 'worker', { store: memStore });
    q.add(spec());
    const id = q.order[0];
    q.start();
    for (let i = 0; i < 400 && !(q.items.get(id).done > 6 * 1024 * 1024); i++) await sleep(25);
    if (how === 'stop-retry') q.stopItems([id]); else q.pause();
    for (let i = 0; i < 200 && q._unitsOf(q.items.get(id)).length; i++) await sleep(25);
    q._save();
    if (segments) {
      // Segments cut half-way keep what they received (0.3.1).
      const ch = q.items.get(id).seg.chunks;
      ok(ch.some(c => c.st !== 'd' && c.got > 0), `${how}: a segment cut half-way keeps its first part (${ch.filter(c => c.got > 0).map(c => c.got).join(', ')})`);
      const done = q.items.get(id).done, sum = ch.reduce((a, c) => a + (c.st === 'd' ? c.e - c.s : (c.got || 0)), 0);
      eq(done, sum, `${how}: the progress shows exactly what is in place`);
    }
    settings.limitDown = 0;
    let s;
    if (how === 'stop-retry') { q.retry([id]); s = await runQueue(q); q.closeAll(); }
    else if (how === 'pause-start') { s = await runQueue(q); q.closeAll(); }
    else if (how === 'restart-app') { q.closeAll(); const q2 = makeQueue(ep, settings, 'worker', { store: memStore }); s = await runQueue(q2); q2.closeAll(); }
    else {
      // The same file added again: the stopped item comes back with what it had.
      q.stopItems([id]);
      for (let i = 0; i < 200 && q._unitsOf(q.items.get(id)).length; i++) await sleep(25);
      const r = q.add(spec());
      eq([r.length, r.revived.length, r.revived[0] && r.revived[0].id], [0, 1, id], `segments=${segments}: added again → the same item, with its partial copy`);
      q.retry(r.revived.map(x => x.id), 'resume');
      s = await runQueue(q); q.closeAll();
    }
    ok(s.bytes < SZ, `segments=${segments} ${how}: resumed, not started again (${(s.bytes / 1048576).toFixed(1)} MB of 16 sent)`);
    eq(sha(path.join(d, 'big.mov')), sha(f), `${how} identical`);
  }
  await srv.close();
});

SEC('queue: resuming an UPLOAD (whole and segments), checks off', async () => {
  // 0.9.2 (Noar): an upload stopped then started again landed corrupted on
  // the server. Checks are OFF here on purpose: they would redo a bad file
  // and hide the bug. What lands must be identical without them.
  const { srv, ep, root } = await server({ latencyMs: 4 });
  SRV = srv; EP = ep; SRV_ROOT = () => root;
  const SZ = 16 * 1024 * 1024;
  const d0 = scratch();
  const f = randomFile(path.join(d0, 'big.mov'), SZ);
  let n = 0;
  for (const segments of [false, true]) for (const how of (process.env.FILO_HOWS ? process.env.FILO_HOWS.split(',') : ['stop-retry', 'pause-start', 'restart-app', 'add-again', 'twice', 'net-cut'])) {
    const dir = `/up${n++}`;
    const memStore = { data: null, load() { return this.data; }, save(a) { this.data = JSON.parse(JSON.stringify(a)); } };
    const settings = Object.assign({}, SETTINGS, { segments, concurrency: 2, limitUp: 4, verify: false });
    const spec = () => [{ dir: 'up', type: 'file', local: f, remote: dir + '/big.mov', size: SZ, endpointId: 'e', endpointLabel: 't' }];
    let q = makeQueue(ep, settings, 'worker', { store: memStore });
    q.add(spec());
    const id = q.order[0];
    const cut = async (qq, at) => {
      qq.start();
      for (let i = 0; i < 600 && !(qq.items.get(id).done > at); i++) await sleep(25);
      if (how === 'net-cut') { srv.cutAll(); return; }
      if (how === 'crash') { qq._save(); memStore.snap = JSON.parse(JSON.stringify(memStore.data)); return; }       // filo killed: only what was saved while it ran
      if (how === 'stop-retry' || how === 'add-again') qq.stopItems([id]); else qq.pause();
      for (let i = 0; i < 200 && qq._unitsOf(qq.items.get(id)).length; i++) await sleep(25);
      qq._save();
    };
    await cut(q, 5 * 1024 * 1024);
    if (how === 'twice') { await cut(q, 10 * 1024 * 1024); }
    settings.limitUp = 0;
    let s;
    if (how === 'stop-retry') { q.retry([id]); s = await runQueue(q); q.closeAll(); }
    else if (how === 'pause-start' || how === 'twice') { s = await runQueue(q); q.closeAll(); }
    else if (how === 'net-cut') { s = await new Promise(res => q.once('finished', res)); q.closeAll(); }
    else if (how === 'restart-app') { q.closeAll(); const q2 = makeQueue(ep, settings, 'worker', { store: memStore }); s = await runQueue(q2); q2.closeAll(); }
    else { const r = q.add(spec()); q.retry(r.revived.map(x => x.id), 'resume'); s = await runQueue(q); q.closeAll(); }
    eq([s.done, s.failed], [1, 0], `up segments=${segments} ${how}: done`);
    ok(how === 'net-cut' ? s.bytes < SZ * 1.2 : s.bytes < SZ, `up segments=${segments} ${how}: resumed (${(s.bytes / 1048576).toFixed(1)} MB of 16 sent${how === 'net-cut' ? ', the part before the cut included' : ''})`);
    eq(sha(path.join(root, dir.slice(1), 'big.mov')), sha(f), `up segments=${segments} ${how}: identical on the server`);
  }
  await srv.close();
});

SEC('sftp writer: what is kept after a cut is what the server acknowledged without a gap', async () => {
  // 0.9.2: a segment cut half-way used to keep "sent minus 6 MB", and with
  // 16 MB of writes in flight that left holes in the server's file.
  const { PipelinedWriter } = require('../src/main/proto/sftp-pipe');
  const { Readable, pipeline } = require('stream');
  const run = (order, failAt) => new Promise(res => {
    const pending = [];
    const sftp = {
      open: (p, f, cb) => cb(null, 'h'),
      close: (h, cb) => cb && cb(),
      write: (h, buf, o, len, at, cb) => { pending.push({ at, cb }); if (pending.length === 8) flush(); },
    };
    const flush = () => {
      const list = pending.splice(0);
      for (const i of order(list.length)) { const w = list[i]; w.cb(w.at === failAt ? new Error('cut') : null); }
    };
    const w = new PipelinedWriter({ sftp }, '/x', { start: 1000, chunkSize: 100, concurrency: 8 });
    const src = Readable.from([Buffer.alloc(800)]);
    pipeline(src, w, err => res({ err, kept: w.kept }));
  });
  // Acknowledged in reverse, the write at 1300 refused: only 1000..1300 is surely there.
  let r = await run(n => [...Array(n).keys()].reverse(), 1300);
  eq([!!r.err, r.kept], [true, 300], 'out of order, one refused: kept stops at the hole');
  r = await run(n => [...Array(n).keys()], -1);
  eq([!!r.err, r.kept], [false, 800], 'all acknowledged: everything kept');
});

SEC('a server that will not open one file twice (exclusive open)', async () => {
  // 0.9.5 (Noar, sftp.ldlcarena.com): every file sent in segments failed with
  // "File is already exclusively open". Now the server's files go whole.
  const { srv, ep, root } = await server({ exclusive: true, latencyMs: 2 });
  SRV = srv; EP = ep; SRV_ROOT = () => root;
  const d = scratch();
  const files = [0, 1, 2].map(i => randomFile(path.join(d, `f${i}.mov`), 12 * 1024 * 1024));
  const q = makeQueue(ep, Object.assign({}, SETTINGS, { segments: true, concurrency: 3 }), 'worker');
  q.add(files.map((f, i) => ({ dir: 'up', type: 'file', local: f, remote: `/ex/f${i}.mov`, size: 12 * 1024 * 1024, endpointId: 'e', endpointLabel: 't' })));
  const s = await runQueue(q, 90000); q.closeAll();
  if (s.failed) console.log('\n' + q.logs.join('\n'));
  eq([s.done, s.failed], [3, 0], 'every file arrives');
  for (let i = 0; i < 3; i++) eq(sha(path.join(root, 'ex', `f${i}.mov`)), sha(files[i]), `f${i} identical on the server`);
  ok(q.logs.some(l => /does not let one file be written by several connections/.test(l)), 'said once in the log');
  eq(q.logs.filter(l => /does not let one file/.test(l)).length, 1, 'only once');
  await srv.close();
});

SEC('queue: a resume starts the progress where it was', async () => {
  // 0.9.6 (Noar, asked before): resumed at 25 %, the queue's bar showed 0 %.
  const { srv, ep, root } = await server({ latencyMs: 4 });
  SRV = srv; EP = ep; SRV_ROOT = () => root;
  const SZ = 16 * 1024 * 1024;
  fs.mkdirSync(path.join(root, 'pr'), { recursive: true });
  randomFile(path.join(root, 'pr', 'big.mov'), SZ);
  for (const segments of [false, true]) {
    const d = scratch();
    const settings = Object.assign({}, SETTINGS, { segments, concurrency: 2, limitDown: 4 });
    const q = makeQueue(ep, settings, 'worker');
    q.add([{ dir: 'down', type: 'file', local: path.join(d, 'big.mov'), remote: '/pr/big.mov', size: SZ, endpointId: 'e', endpointLabel: 't' }]);
    const id = q.order[0];
    q.start();
    for (let i = 0; i < 400 && !(q.items.get(id).done > 6 * 1024 * 1024); i++) await sleep(25);
    q.pause();
    for (let i = 0; i < 200 && q._unitsOf(q.items.get(id)).length; i++) await sleep(25);
    const had = q.items.get(id).done;
    let first = null;
    q.on('progress', p => { if (first == null && p.run) first = (p.run.bytes + p.run.kept) / (p.run.bytes + p.run.kept + p.counts.bytesLeft); });
    settings.limitDown = 0;
    const s = await runQueue(q); q.closeAll();
    eq([s.done, s.failed], [1, 0], `segments=${segments}: done`);
    ok(first >= (had / SZ) * 0.9, `segments=${segments}: the bar starts at ${(first * 100).toFixed(0)} %, not 0 (${(had / SZ * 100).toFixed(0)} % was in place)`);
  }
  await srv.close();
});

SEC('0.9.8: big files are probed by small batches', async () => {
  // 1 200 segments of a 300 GB file: the check must not be one read of tens of
  // MB under a single time limit. Batches of at most 64 windows, a total of 1 024
  // windows at most (fewer per region, then one region out of N).
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'filo-probe-'));
  const f = path.join(tmp, 'a.bin'); fs.writeFileSync(f, crypto.randomBytes(8 * 1024 * 1024));
  const calls = [];
  const remote = { readRanges: async (_p, wins) => { calls.push(wins.length); return wins.map(([a, b]) => fs.readFileSync(f).subarray(a, b)); } };
  const mk = n => Array.from({ length: n }, (_, i) => [i * 4096, i * 4096 + 4096]);
  let r = await transfer.regionsMatch(remote, f, f, mk(700));
  ok(r.every(Boolean) && r.length === 700, 'identical regions match');
  ok(calls.length >= 10 && Math.max(...calls) <= 64, `700 regions read in batches of at most 64 (${calls.length} calls, max ${Math.max(...calls)})`);
  ok(calls.reduce((a, b) => a + b, 0) <= 700, 'one window per region past 512 regions');
  calls.length = 0;
  r = await transfer.regionsMatch(remote, f, f, mk(2000));
  ok(calls.reduce((a, b) => a + b, 0) <= 1024 && r.length === 2000 && r.every(Boolean), 'the total never goes past 1 024 windows (32 MB), whatever the size');
  const bad = { readRanges: async (_p, wins) => wins.map(([a, b]) => { const x = Buffer.from(fs.readFileSync(f).subarray(a, b)); if (a === 10 * 4096) x[0] ^= 1; return x; }) };
  r = await transfer.regionsMatch(bad, f, f, mk(20));
  ok(r[10] === false && r.filter(Boolean).length === 19, 'a damaged region is found, the others stay trusted');
  fs.rmSync(tmp, { recursive: true, force: true });
});

SEC('0.9.8: the queue saves without blocking, and the last save wins', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'filo-qsave-'));
  const cfg = require('../src/main/config');
  const file = path.join(tmp, 'q.json');
  const store = { load: () => null, save: l => cfg.writeAtomic(file, JSON.stringify(l)), saveAsync: (l, cur) => cfg.writeAtomicAsync(file, JSON.stringify(l), cur) };
  const q = new TransferQueue({ store, log: () => {} });
  let n = 0; q.on('changed', () => n++);
  for (let i = 0; i < 50; i++) q._changed();
  ok(n <= 2, `50 changes in a burst, ${n} event(s) (first at once, the rest grouped)`);
  await new Promise(r => setTimeout(r, 120));
  ok(n <= 3, `the late one went out (${n} in all)`);
  await cfg.writeAtomicAsync(file, '[1]', () => false).then(v => ok(v === false, 'an outdated write does not replace the file'));
  ok(!fs.readdirSync(tmp).some(x => x.includes('.tmp-')), 'no temporary file left');
  fs.rmSync(tmp, { recursive: true, force: true });
});

SEC('resume: a damaged partial is never trusted (checks off)', async () => {
  // 0.9.7 (Noar: "le resume doit être robuste, surtout en multi-parts").
  // SAFE COPY is off, so nothing at the end would catch a bad resume: the
  // partial itself must be checked before filo builds on it.
  const { srv, ep, root } = await server({ latencyMs: 4 });
  SRV = srv; EP = ep; SRV_ROOT = () => root;
  const SZ = 16 * 1024 * 1024;
  const d0 = scratch();
  const src = randomFile(path.join(d0, 'big.mov'), SZ);
  fs.mkdirSync(path.join(root, 'rs'), { recursive: true });
  fs.copyFileSync(src, path.join(root, 'rs', 'big.mov'));
  let n = 0;
  for (const dir of ['up', 'down']) for (const segments of [false, true]) for (const harm of ['hole', 'truncate', 'replaced']) {
    const tag = `${dir} segments=${segments} ${harm}`;
    const d = scratch();
    const remote = dir === 'up' ? `/rs/up${n++}.mov` : '/rs/big.mov';
    const local = dir === 'up' ? src : path.join(d, 'big.mov');
    const settings = Object.assign({}, SETTINGS, { segments, concurrency: 2, limitUp: 4, limitDown: 4, verify: false });
    const q = makeQueue(ep, settings, 'worker');
    q.add([{ dir, type: 'file', local, remote, size: SZ, endpointId: 'e', endpointLabel: 't' }]);
    const id = q.order[0];
    q.start();
    for (let i = 0; i < 600 && !(q.items.get(id).done > 8 * 1024 * 1024); i++) await sleep(25);
    q.pause();
    for (let i = 0; i < 200 && q._unitsOf(q.items.get(id)).length; i++) await sleep(25);
    // The partial, where it is.
    const part = dir === 'up' ? path.join(root, remote.slice(1) + '.filopart') : local + '.filopart';
    ok(fs.existsSync(part), `${tag}: a partial exists`);
    const size = fs.statSync(part).size;
    if (harm === 'hole') {
      // What a cut leaves wrong: the end of each region said to be in place
      // is not (writes lost on the way, zeros or old bytes instead).
      const it = q.items.get(id);
      const ends = it.seg ? it.seg.chunks.map(c => (c.st === 'd' ? c.e : c.s + (c.got || 0))).filter((e, i) => e > it.seg.chunks[i].s) : [size];   // a whole file: the end of the partial itself
      const fd = fs.openSync(part, 'r+');
      for (const e of ends) { const len = Math.min(256 * 1024, e); fs.writeSync(fd, Buffer.alloc(len), 0, len, e - len); }
      fs.closeSync(fd);
    } else if (harm === 'truncate') {
      fs.truncateSync(part, Math.floor(size / 3));
    } else {
      // Another file of the same size took its place.
      fs.writeFileSync(part, crypto.randomBytes(size));
    }
    settings.limitUp = 0; settings.limitDown = 0;
    const s = await runQueue(q); q.closeAll();
    eq([s.done, s.failed], [1, 0], `${tag}: done`);
    const got = dir === 'up' ? path.join(root, remote.slice(1)) : local;
    eq(sha(got), sha(src), `${tag}: identical`);
  }
  await srv.close();
});

SEC('resume: the source changed between two attempts (checks off)', async () => {
  const { srv, ep, root } = await server({ latencyMs: 4 });
  SRV = srv; EP = ep; SRV_ROOT = () => root;
  const SZ = 16 * 1024 * 1024;
  for (const segments of [false, true]) {
    const d = scratch();
    const src = randomFile(path.join(d, 'v1.mov'), SZ);
    const settings = Object.assign({}, SETTINGS, { segments, concurrency: 2, limitUp: 4, verify: false });
    const q = makeQueue(ep, settings, 'worker');
    q.add([{ dir: 'up', type: 'file', local: src, remote: `/ch${segments}/v.mov`, size: SZ, endpointId: 'e', endpointLabel: 't' }]);
    const id = q.order[0];
    q.start();
    for (let i = 0; i < 600 && !(q.items.get(id).done > 6 * 1024 * 1024); i++) await sleep(25);
    q.pause();
    for (let i = 0; i < 200 && q._unitsOf(q.items.get(id)).length; i++) await sleep(25);
    // A new export over the same name, same size.
    fs.writeFileSync(src, crypto.randomBytes(SZ));
    fs.utimesSync(src, new Date(), new Date(Date.now() + 5000));
    settings.limitUp = 0;
    const s = await runQueue(q); q.closeAll();
    eq([s.done, s.failed], [1, 0], `segments=${segments}: done`);
    eq(sha(path.join(root, `ch${segments}`, 'v.mov')), sha(src), `segments=${segments}: the server holds the NEW source`);
  }
  await srv.close();
});

SEC('resume: filo killed in the middle (SIGKILL), whole and segments', async () => {
  // 0.9.7: a crash or a power cut leaves only what the queue saved while it
  // ran. A whole file used to start again from zero (its resume record was
  // only known at the end of an attempt); a segment, from its start.
  const { spawn } = require('child_process');
  const { srv, ep, root } = await server({ latencyMs: 4 });
  SRV = srv; EP = ep; SRV_ROOT = () => root;
  const fp = known.get(`sftp:${ep.host}:${ep.port}`);
  const SZ = 24 * 1024 * 1024;
  const d0 = scratch();
  const src = randomFile(path.join(d0, 'big.mov'), SZ);
  fs.mkdirSync(path.join(root, 'kl'), { recursive: true });
  fs.copyFileSync(src, path.join(root, 'kl', 'big.mov'));
  let n = 0;
  for (const dir of ['up', 'down']) for (const segments of [false, true]) {
    const tag = `${dir} segments=${segments}`;
    const d = scratch();
    const storeFile = path.join(d, 'queue.json');
    const remote = dir === 'up' ? `/kl/up${n++}.mov` : '/kl/big.mov';
    const local = dir === 'up' ? src : path.join(d, 'big.mov');
    const settings = Object.assign({}, SETTINGS, { segments, concurrency: 2, limitUp: 3, limitDown: 3, verify: false });
    const child = spawn(process.execPath, [path.join(__dirname, 'crash-child.js'), JSON.stringify({ ep, fp, store: storeFile, settings,
      items: [{ dir, type: 'file', local, remote, size: SZ, endpointId: 'e', endpointLabel: 't' }] })], { stdio: 'ignore', env: Object.assign({}, process.env, { FILO_TEST_SEGMENT_MB: process.env.FILO_TEST_SEGMENT_MB || '' }) });
    // Killed once the saved queue says more than 8 MB are in place.
    const saved = () => { try { const l = JSON.parse(fs.readFileSync(storeFile, 'utf8')); const it = l[0]; return it && it.seg ? it.seg.chunks.reduce((t, c) => t + (c.st === 'd' ? c.e - c.s : c.got || 0), 0) : (it ? it.done || 0 : 0); } catch (_) { return 0; } };
    for (let i = 0; i < 800 && saved() < 8 * 1024 * 1024; i++) await sleep(50);
    const before = saved();
    child.kill('SIGKILL');
    await new Promise(r => child.once('exit', r));
    ok(before >= 8 * 1024 * 1024, `${tag}: the running queue saved its progress (${(before / 1048576).toFixed(1)} MB)`);
    const list = JSON.parse(fs.readFileSync(storeFile, 'utf8'));
    ok(!!(list[0] && list[0].resume), `${tag}: the resume record was saved while it ran`);
    settings.limitUp = 0; settings.limitDown = 0;
    const store = { data: list, load() { return this.data; }, save(a) { this.data = a; } };
    const q = makeQueue(ep, settings, 'worker', { store });
    const s = await runQueue(q); q.closeAll();
    eq([s.done, s.failed], [1, 0], `${tag}: done after the restart`);
    ok(s.bytes <= SZ - 6 * 1024 * 1024, `${tag}: resumed, not started again (${(s.bytes / 1048576).toFixed(1)} MB of 24 sent after the crash)`);
    eq(sha(dir === 'up' ? path.join(root, remote.slice(1)) : local), sha(src), `${tag}: identical`);
  }
  await srv.close();
});

SEC('queue: file already there', async () => {
  const { srv, ep, root } = await server();
  SRV = srv; EP = ep; SRV_ROOT = () => root;
  const d = scratch();
  const f = randomFile(path.join(d, 'x.bin'), 50000);
  fs.mkdirSync(path.join(root, 'ex'), { recursive: true });
  const spec = () => [{ dir: 'up', type: 'file', local: f, remote: '/ex/x.bin', size: 50000, endpointId: 'e', endpointLabel: 't' }];
  // skip
  fs.writeFileSync(path.join(root, 'ex', 'x.bin'), 'old');
  let q = makeQueue(ep, Object.assign({}, SETTINGS, { existingUp: 'skip' }), 'inline');
  q.add(spec()); let s = await runQueue(q); q.closeAll();
  eq([s.done, s.skipped, fs.readFileSync(path.join(root, 'ex', 'x.bin'), 'utf8')], [0, 1, 'old'], 'skip leaves the target alone');
  // rename
  q = makeQueue(ep, Object.assign({}, SETTINGS, { existingUp: 'rename' }), 'inline');
  q.add(spec()); s = await runQueue(q); q.closeAll();
  eq(sha(path.join(root, 'ex', 'x (1).bin')), sha(f), 'rename: new name, old file kept');
  // ask → overwrite, answered "for all"
  q = makeQueue(ep, Object.assign({}, SETTINGS, { existingUp: 'ask' }), 'worker');
  let asked = 0;
  q.on('ask', a => { asked++; q.answer(a.askId, 'overwrite', true); });
  q.add(spec()); s = await runQueue(q); q.closeAll();
  eq([asked, sha(path.join(root, 'ex', 'x.bin'))], [1, sha(f)], 'ask, through a worker thread: overwrite');
  // resume a smaller target (another client stopped half way)
  // SFTP resumes 2 MB before the end of what is there (writes may have
  // landed out of order before the cut): 5 MB file, 4 MB there → 3 MB sent.
  const big = randomFile(path.join(d, 'big.bin'), 5 * 1024 * 1024);
  fs.writeFileSync(path.join(root, 'ex', 'big.bin'), fs.readFileSync(big).subarray(0, 4 * 1024 * 1024));
  q = makeQueue(ep, Object.assign({}, SETTINGS, { existingUp: 'resume', segments: false }), 'inline');
  q.add([{ dir: 'up', type: 'file', local: big, remote: '/ex/big.bin', size: 5 * 1024 * 1024, endpointId: 'e', endpointLabel: 't' }]);
  s = await runQueue(q); q.closeAll();
  eq(sha(path.join(root, 'ex', 'big.bin')), sha(big), 'resume completes a partial target');
  ok(s.bytes === 3 * 1024 * 1024, `resume sent the rest, from 2 MB before the end of the partial file (${s.bytes})`);
  await srv.close();
});

SEC('queue: server connection limit', async () => {
  const { srv, ep, root } = await server({ maxSessions: 2 });
  SRV = srv; EP = ep; SRV_ROOT = () => root;
  const d = scratch();
  const specs = [];
  for (let i = 0; i < 8; i++) specs.push({ dir: 'up', type: 'file', local: randomFile(path.join(d, `f${i}.bin`), 200000), remote: `/lim/f${i}.bin`, size: 200000, endpointId: 'e', endpointLabel: 't' });
  const q = makeQueue(ep, Object.assign({}, SETTINGS, { concurrency: 'auto', autoMax: 6 }), 'inline');
  q.tuner = new AutoTuner({ max: 6, start: 5 });
  q.add(specs);
  const s = await runQueue(q, 90000);
  q.closeAll();
  eq([s.done, s.failed], [8, 0], 'every file arrived despite the limit');
  ok(q.tuner.cap <= 2, `the limit was learnt (cap ${q.tuner.cap})`);
  await srv.close();
});

SEC('key login through the transfer threads', async () => {
  // Up to this fix, a site with a key could browse (main process) but every
  // transfer was refused: the key, a Buffer, reached the thread as a plain
  // Uint8Array, which ssh2 does not take, and the login went without it.
  let k = null;
  for (let i = 0; i < 20 && !k; i++) { const g = require('ssh2').utils.generateKeyPairSync('ed25519'); if (!(require('ssh2').utils.parseKey(g.private) instanceof Error)) k = g; }
  const root = scratch();
  const srv = await startSftpServer({ root, clientKey: k.public });
  known.delete(`sftp:127.0.0.1:${srv.port}`);
  const ep = { protocol: 'sftp', host: '127.0.0.1', port: srv.port, user: srv.username, privateKey: Buffer.from(k.private) };
  const r = await connectTrusting(ep); await r.mkdir('/k'); await r.close();
  const d = scratch();
  const f = randomFile(path.join(d, 'k.bin'), 3 * 1024 * 1024);
  let q = makeQueue(ep, Object.assign({}, SETTINGS, { segments: false }), 'worker');
  q.add([{ dir: 'up', type: 'file', local: f, remote: '/k/k.bin', size: 3 * 1024 * 1024, endpointId: 'e', endpointLabel: 't' }]);
  let s = await runQueue(q); q.closeAll();
  eq([s.done, s.failed, sha(path.join(root, 'k', 'k.bin'))], [1, 0, sha(f)], 'upload with a key, through a thread');
  q = makeQueue(ep, Object.assign({}, SETTINGS, { segments: false }), 'worker');
  q.add([{ dir: 'down', type: 'file', local: path.join(d, 'back.bin'), remote: '/k/k.bin', size: 3 * 1024 * 1024, endpointId: 'e', endpointLabel: 't' }]);
  s = await runQueue(q); q.closeAll();
  eq([s.done, sha(path.join(d, 'back.bin'))], [1, sha(f)], 'download with a key, through a thread');
  await srv.close();
});

SEC('review 0.3.4: no silent replace, kept progress', async () => {
  const MB = 1024 * 1024;
  // Two different files for one destination: the second is left out.
  let q = makeQueue({}, SETTINGS, 'inline');
  const a = q.add([
    { dir: 'down', type: 'file', local: '/x/C0001.MP4', remote: '/cardA/C0001.MP4', size: 10, endpointId: 'e' },
    { dir: 'down', type: 'file', local: '/x/C0001.MP4', remote: '/cardB/C0001.MP4', size: 10, endpointId: 'e' },
  ]);
  eq([a.length, a.conflict], [1, 1], 'same destination, different source: the second is not queued');
  q.closeAll();

  const { srv, ep, root } = await server();
  SRV = srv; EP = ep; SRV_ROOT = () => root;
  const d = scratch();
  fs.mkdirSync(path.join(root, 'rv'), { recursive: true });

  // START AGAIN on a file that filo never wrote under the real name: the rule
  // ("skip") still applies, the file there is kept.
  const f = randomFile(path.join(d, 's.bin'), 60000);
  fs.writeFileSync(path.join(root, 'rv', 's.bin'), 'theirs');
  q = makeQueue(ep, Object.assign({}, SETTINGS, { existingUp: 'skip' }), 'inline');
  const [id] = q.add([{ dir: 'up', type: 'file', local: f, remote: '/rv/s.bin', size: 60000, endpointId: 'e', endpointLabel: 't' }]);
  q.get(id).restartFromZero = true;
  let s = await runQueue(q); q.closeAll();
  eq([s.skipped, fs.readFileSync(path.join(root, 'rv', 's.bin'), 'utf8')], [1, 'theirs'], 'start again does not override "skip"');

  // A file that appears under the real name while the transfer runs: the rule
  // decides at the end ("skip"), nothing is replaced, no partial file is left.
  for (const dir of ['down', 'up']) {
    const big = dir === 'up' ? randomFile(path.join(d, 'late-up.bin'), 3 * MB) : randomFile(path.join(root, 'rv', 'late-down.bin'), 3 * MB);
    const target = dir === 'up' ? path.join(root, 'rv', 'late-up.bin') : path.join(d, 'late-down.bin');
    q = makeQueue(ep, Object.assign({}, SETTINGS, { existingUp: 'skip', existingDown: 'skip', segments: false, limitUp: 2, limitDown: 2 }), 'inline');
    q.add([dir === 'up'
      ? { dir, type: 'file', local: big, remote: '/rv/late-up.bin', size: 3 * MB, endpointId: 'e', endpointLabel: 't' }
      : { dir, type: 'file', local: target, remote: '/rv/late-down.bin', size: 3 * MB, endpointId: 'e', endpointLabel: 't' }]);
    setTimeout(() => fs.writeFileSync(target, 'arrived meanwhile'), 400);
    s = await runQueue(q); q.closeAll();
    eq([s.skipped, fs.readFileSync(target, 'utf8'), fs.existsSync(target + '.filopart')], [1, 'arrived meanwhile', false], `${dir}: a file arriving meanwhile is not replaced`);
  }
  await srv.close();

  // A segment that fails before saying what it holds keeps what was known.
  q = makeQueue({}, SETTINGS, 'inline');
  const it = { id: 'x', dir: 'down', type: 'file', local: path.join(d, 'k'), remote: '/k', size: 64 * MB, status: 'running', done: 20 * MB, endpointId: 'e',
    seg: { chunks: [{ s: 0, e: 32 * MB, st: 'r', got: 20 * MB, by: 'u1' }, { s: 32 * MB, e: 64 * MB, st: 'p' }] } };
  q.items.set('x', it); q.order.push('x');
  q._unitFailed({ id: 'u1', it, kind: 'seg', idx: 0, bytes: 0, aborted: false, phase: 'connect' }, Object.assign(new Error('x'), { network: true }));
  eq([it.seg.chunks[0].got, it.done], [20 * MB, 20 * MB], 'segment: 20 MB kept, progress unchanged');
  q.closeAll();

  // After a relaunch, a stopped file still knows what it had: "start again"
  // applies, and the window can ask.
  let saved = null;
  const store = { load: () => saved, save: x => { saved = JSON.parse(JSON.stringify(x)); } };
  q = makeQueue({}, SETTINGS, 'inline', { store });
  q.items.set('y', { id: 'y', dir: 'up', type: 'file', local: '/l', remote: '/r', size: 1e9, status: 'stopped', done: 5e8, offset: 4e8, resume: { srcSize: 1e9, srcMtime: 1 }, endpointId: 'e' });
  q.order.push('y'); q._save(); q.closeAll();
  q = makeQueue({}, SETTINGS, 'inline', { store });
  eq([q.get('y').done, q.get('y').offset], [5e8, 4e8], 'progress kept across a relaunch');
  q.retry(['y'], 'restart');
  ok(q.get('y').restartFromZero === true, 'start again after a relaunch');
  // Retry while units of the file are still ending: deferred, not mixed.
  const z = { id: 'z', dir: 'up', type: 'file', local: '/l2', remote: '/r2', size: 10, status: 'failed', endpointId: 'e' };
  q.items.set('z', z); q.order.push('z');
  const ghost = { id: 'g', it: z, kind: 'seg', idx: 0 };
  q.units.add(ghost);
  q.retry(['z'], 'resume');
  eq([z.status, z._pendingRetry], ['failed', 'resume'], 'retry waits for the last unit of the file');
  q.units.delete(ghost);
  q.closeAll();

  // Auto: a limit learned from one server does not cap the next run.
  const t = new AutoTuner({ max: 10, start: 2, now: 0 });
  t.serverRefused(3, 0); t.newRun(0);
  ok(t.limit() >= 2 && t.cap === Infinity && !t.boosted, 'a new run forgets the server limit');
});

SEC('sync plan', () => {
  const { plan } = require('../src/main/core/syncplan');
  const M = obj => new Map(Object.entries(obj));
  const F = (size, mtime) => ({ type: 'file', size, mtime });
  let state = { files: {} }, seen = new Map(), now = 1e9;
  const run = (direction, L, R, dt) => { now += dt == null ? 20000 : dt; const o = plan({ direction, L: M(L), R: M(R), state, seen, now, stableMs: 10000 }); state = { files: o.files }; return o; };
  let o = run('up', { 'a.mov': F(10, 5000) }, {}, 0);
  eq([o.copies.length, o.waiting], [0, 1], 'a new file waits until it is stable');
  o = run('up', { 'a.mov': F(10, 5000) }, {});
  eq(o.copies.map(c => c.from + c.rel + c.reason), ['la.movnew'], 'then it is sent');
  o = run('up', { 'a.mov': F(10, 5000) }, { 'a.mov': F(10, 60000) });
  eq([o.copies.length, state.files['a.mov'].pend], [0, undefined], 'the server copy is adopted (its own date), nothing sent again');
  o = run('up', { 'a.mov': F(10, 5000) }, { 'a.mov': F(10, 60000) });
  eq(o.copies.length, 0, 'in step: nothing to do');
  run('up', { 'a.mov': F(12, 9000) }, { 'a.mov': F(10, 60000) }, 0);
  o = run('up', { 'a.mov': F(12, 9000) }, { 'a.mov': F(10, 60000) });
  eq(o.copies.map(c => c.reason), ['changed'], 'changed here: sent');
  o = run('up', { 'a.mov': F(12, 9000) }, { 'a.mov': F(12, 120000) });
  o = run('up', { 'a.mov': F(12, 9000) }, { 'a.mov': F(99, 180000) });
  eq(o.copies.length, 0, 'up: changed on the server only: left alone');
  o = run('up', { 'a.mov': F(13, 99000) }, { 'a.mov': F(98, 240000) });
  eq(o.conflicts.length, 1, 'changed on both sides: a conflict, nothing copied');
  // deletion on the other side is respected
  state = { files: { 'b.mov': { l: { s: 5, m: 1000 }, r: { s: 5, m: 60000 } } } }; seen = new Map();
  o = run('up', { 'b.mov': F(5, 1000) }, {});
  eq([o.copies.length, o.respected.length], [0, 1], 'deleted on the server: not sent again');
  o = run('up', {}, { 'b.mov': F(5, 60000) });
  eq([o.copies.length, o.respected.length], [0, 0], 'up: deleted here: nothing deleted on the server');
  // 2 WAYS
  state = { files: {} }; seen = new Map();
  run('both', {}, { 'c.mov': F(7, 3000) }, 0);
  o = run('both', {}, { 'c.mov': F(7, 3000) });
  eq(o.copies.map(c => c.from), ['r'], '2 WAYS: new on the server comes here');
  // first contact
  state = { files: {} }; seen = new Map();
  o = run('up', { 'd.mov': F(5, 1000) }, { 'd.mov': F(5, 2000000) });
  eq([o.copies.length, !!state.files['d.mov']], [0, true], 'first look, same size: taken as in step');
  run('up', { 'e.mov': F(6, 9000000) }, { 'e.mov': F(5, 1000) }, 0);
  o = run('up', { 'e.mov': F(6, 9000000) }, { 'e.mov': F(5, 1000) });
  eq(o.copies.map(c => c.reason), ['newer'], 'first look, newer here: sent');
  o = run('up', { 'f.mov': F(6, 1000) }, { 'f.mov': F(5, 9000000) });
  eq(o.conflicts.length, 1, 'first look, newer on the server: a conflict');
  o = run('up', { sub: { type: 'folder' } }, {});
  eq(o.folders.map(f => f.to + f.rel), ['rsub'], 'a new folder is created on the other side');
});

SEC('auto sync with a real server', async () => {
  const { Syncer } = require('../src/main/syncer');
  const { srv, ep, root } = await server();
  SRV = srv; EP = ep; SRV_ROOT = () => root;
  const d = scratch();
  const loc = path.join(d, 'Exports');
  randomFile(path.join(loc, 'a.bin'), 70000);
  randomFile(path.join(loc, 'sub', 'b.bin'), 50000);
  fs.writeFileSync(path.join(loc, '.DS_Store'), 'x');
  const pairs = [{ id: 'aaaaaaaaaaaaaaaa', name: 'Exports', siteId: 's1', local: loc, remote: '/sync/exports', direction: 'up', auto: false, interval: 5, exclude: '.DS_Store|*.filopart' }];
  const prefs = { listSyncPairs: () => pairs, getSyncPair: id => pairs.find(p => p.id === id), getSite: () => ({ id: 's1' }) };
  const q = makeQueue(ep, SETTINGS, 'inline');
  const sy = new Syncer({ prefs, queue: q, log: () => {}, resolveEndpoint: async () => ep, createRemote: e => proto.createRemote(e), dir: path.join(d, 'state'), stableMs: 300 });
  let r = await sy.run(pairs[0].id, 'test');
  eq([r.copies, r.waiting], [0, 2], 'first run: the files are not stable yet');
  await sleep(400);
  r = await sy.run(pairs[0].id, 'test');
  eq([r.copies, r.folders], [2, 1], 'second run: 2 files and a folder for the queue (.DS_Store excluded)');
  await runQueue(q);
  eq([sha(path.join(root, 'sync/exports/a.bin')), fs.existsSync(path.join(root, 'sync/exports/.DS_Store'))], [sha(path.join(loc, 'a.bin')), false], 'on the server, excluded file left out');
  r = await sy.run(pairs[0].id, 'test');
  eq(r.copies, 0, 'in step: nothing more');
  randomFile(path.join(loc, 'a.bin'), 80000);
  await sy.run(pairs[0].id, 'test'); await sleep(400);
  r = await sy.run(pairs[0].id, 'test');
  eq(r.copies, 1, 'a changed file is sent again');
  await runQueue(q);
  eq(sha(path.join(root, 'sync/exports/a.bin')), sha(path.join(loc, 'a.bin')), 'the server has the new version');
  // The "settling" run armed by the first look at the changed file (stableMs
  // + 1 s) is let go first: under load it fired in the middle of the next
  // step and counted a.bin again (test timing, review 0.7.2).
  await sleep(1500); if ([...q.items.values()].some(i => i.status !== 'done' && !i.removed)) await runQueue(q);
  fs.unlinkSync(path.join(root, 'sync/exports/sub/b.bin'));
  r = await sy.run(pairs[0].id, 'test');
  eq([r.copies, r.respected.length], [0, 1], 'deleted on the server: not sent again');
  // SERVER → LOCAL
  const back = path.join(d, 'Back');
  fs.mkdirSync(back);
  pairs.push({ id: 'bbbbbbbbbbbbbbbb', name: 'Back', siteId: 's1', local: back, remote: '/sync/exports', direction: 'down', auto: false, interval: 5, exclude: '' });
  await sy.run(pairs[1].id, 'test'); await sleep(400);
  r = await sy.run(pairs[1].id, 'test');
  await runQueue(q);
  eq(sha(path.join(back, 'a.bin')), sha(path.join(loc, 'a.bin')), 'server → local');
  // A local folder that is not there is never read as "everything deleted".
  await sleep(1600);                                  // the "settling" re-runs are over
  pairs[1].local = path.join(d, 'not-mounted');
  r = await sy.run(pairs[1].id, 'test');
  ok(r.ok === false && /not there/.test(r.error), 'missing local folder: the run stops '+ (r.ok === false ? '' : JSON.stringify(r)));
  sy.stopAll(); q.closeAll();
  await srv.close();
});

SEC('failsafe: the MASTER settings on the server', async () => {
  const { Syncer } = require('../src/main/syncer');
  const { srv, ep, root } = await server();
  SRV = srv; EP = ep; SRV_ROOT = () => root;
  const mk = (role, dir) => {
    const pairs = [{ id: role === 'master' ? 'mmmmmmmmmmmmmmmm' : 'ssssssssssssssss', name: 'Rushes', via: 'hybrid', role, siteId: 's1', local: dir, remote: '/fs', direction: role === 'master' ? 'up' : 'down', auto: true, fsAuto: true, interval: 5, exclude: '', peer: { id: 'AAAAAAA-BBBBBBB-CCCCCCC-DDDDDDD-EEEEEEE-FFFFFFF-GGGGGGG-HHHHHHH', name: 'PC · Windows 11' } }];
    const prefs = { listSyncPairs: () => pairs, getSyncPair: id => pairs.find(x => x.id === id), getSite: () => ({ id: 's1' }) };
    return { pairs, prefs };
  };
  const dm = scratch(), ds = scratch();
  fs.writeFileSync(path.join(dm, 'a.mov'), 'one');
  fs.mkdirSync(path.join(dm, '.filo-trash')); fs.writeFileSync(path.join(dm, '.filo-trash', 'old.mov'), 'x');
  fs.writeFileSync(path.join(dm, '.stignore'), '/.filo-trash');
  const M = mk('master', dm);
  const qm = makeQueue(ep, SETTINGS, 'inline');
  let got = null;
  const sm = new Syncer({ prefs: M.prefs, queue: qm, log: () => {}, resolveEndpoint: async () => ep, createRemote: e => proto.createRemote(e), dir: path.join(dm, '..', 'stm'), stableMs: 0, directFirst: () => false,
    sessionFile: async () => ({ filo: 'direct', v: 1, name: 'Rushes', direction: 'up', exclude: '' }) });
  await sm.run(M.pairs[0].id, 'test'); await sleep(50); await sm.run(M.pairs[0].id, 'test');
  await runQueue(qm); qm.closeAll();
  const sess = path.join(root, 'fs', '.filo-session');
  ok(fs.existsSync(sess) && JSON.parse(fs.readFileSync(sess, 'utf8')).name === 'Rushes', 'the MASTER writes its session on the server');
  ok(fs.existsSync(path.join(root, 'fs', 'a.mov')) && !fs.existsSync(path.join(root, 'fs', '.filo-trash')) && !fs.existsSync(path.join(root, 'fs', '.stignore')), 'files go, the trash and Syncthing\'s own files never');
  const S2 = mk('slave', ds);
  const qs = makeQueue(ep, SETTINGS, 'inline');
  const ss = new Syncer({ prefs: S2.prefs, queue: qs, log: () => {}, resolveEndpoint: async () => ep, createRemote: e => proto.createRemote(e), dir: path.join(ds, '..', 'sts'), stableMs: 0, directFirst: () => false,
    onSession: (pair, o) => { got = o; } });
  await ss.run(S2.pairs[0].id, 'test'); await sleep(50); await ss.run(S2.pairs[0].id, 'test');
  await runQueue(qs); qs.closeAll();
  ok(got && got.name === 'Rushes' && got.direction === 'up', 'the SLAVE reads it');
  ok(fs.existsSync(path.join(ds, 'a.mov')) && !fs.existsSync(path.join(ds, '.filo-session')), 'the SLAVE gets the files, never the session file');
  // A file deleted here (it is in this side's trash) is not brought back from the server.
  const ds2 = scratch();
  fs.mkdirSync(path.join(ds2, '.filo-trash')); fs.writeFileSync(path.join(ds2, '.filo-trash', 'a.mov'), 'one');
  const S3 = mk('slave', ds2);
  const q3 = makeQueue(ep, SETTINGS, 'inline');
  const s3 = new Syncer({ prefs: S3.prefs, queue: q3, log: () => {}, resolveEndpoint: async () => ep, createRemote: e => proto.createRemote(e), dir: path.join(ds2, '..', 'sts3'), stableMs: 0, directFirst: () => false, onSession: () => {} });
  await s3.run(S3.pairs[0].id, 'test'); await sleep(50); const r3 = await s3.run(S3.pairs[0].id, 'test');
  await runQueue(q3); q3.closeAll();
  ok(!fs.existsSync(path.join(ds2, 'a.mov')) && r3.respected.some(x => x.rel === 'a.mov'), 'a file in the trash is not brought back by the failsafe');
  S3.pairs[0].fsAuto = false;
  const off = await s3.run(S3.pairs[0].id, 'failsafe');
  ok(!off.ok && /off/.test(off.error), 'FAILSAFE switched off: the server is not used');
  sm.stopAll(); ss.stopAll(); s3.stopAll();
});

SEC('dual sync: the server, a mirror of the MASTER', async () => {
  const { Syncer } = require('../src/main/syncer');
  const { mirrorPlan } = require('../src/main/core/syncplan');
  // The plan alone.
  const f = (size, mtime) => ({ type: 'file', size, mtime });
  let mp = mirrorPlan({ L: new Map([['a', f(5, 1000)]]), R: new Map([['a', f(5, 9000)]]), state: { files: {} }, seen: new Map(), now: 0, stableMs: 0 });
  eq([mp.uploads.length, mp.deletes.length], [0, 0], 'first look, same size: taken as the same file');
  mp = mirrorPlan({ L: new Map([['a', f(5, 60500)]]), R: new Map([['a', f(5, 9000)]]), state: { files: mp.files }, seen: new Map([['l:a', { size: 5, mtime: 60500, at: 0 }]]), now: 10, stableMs: 0 });
  eq(mp.uploads.map(u => u.rel), ['a'], 'changed here since, same size: sent again');
  mp = mirrorPlan({ L: new Map(), R: new Map([['a', f(5, 1)], ['d', { type: 'folder' }], ['d/x', f(1, 1)]]), state: { files: { a: { l: { s: 5, m: 1 }, r: { s: 5, m: 1 } }, '/d': { dir: true } } }, seen: new Map(), now: 0, stableMs: 0, pull: true });
  ok(mp.emptyGuard && !mp.deletes.length && !mp.downloads.some(d => d.rel === 'a'), 'local folder empty, server not: nothing deleted (a disk not connected?)');
  const RD = () => new Map([['k', f(1, 1)], ['d', { type: 'folder' }], ['d/x', f(1, 1)]]);
  mp = mirrorPlan({ L: new Map([['k', f(1, 1)]]), R: RD(), state: { files: { '/d': { dir: true }, 'd/x': { l: { s: 1, m: 1 }, r: { s: 1, m: 1 } } } }, seen: new Map(), now: 0, stableMs: 0 });
  eq(mp.deletes.map(d => d.rel), ['d'], 'a folder gone here goes whole from the server');
  mp = mirrorPlan({ L: new Map([['k', f(1, 1)]]), R: RD(), state: { files: {} }, seen: new Map([['r:d/x', { size: 1, mtime: 1, at: 0 }]]), now: 1, stableMs: 0, pull: true });
  eq([mp.deletes.length, mp.localFolders, mp.downloads.map(d => d.rel)], [0, ['d'], ['d/x']], 'put on the server by hand: brought here (3 ways), never deleted');
  mp = mirrorPlan({ L: new Map([['k', f(1, 1)]]), R: RD(), state: { files: {} }, seen: new Map(), now: 0, stableMs: 0, pull: false });
  eq([mp.deletes.length, mp.downloads.length], [0, 0], 'the MASTER only sends: left on the server');
  mp = mirrorPlan({ L: new Map([['k', f(1, 1)]]), R: new Map([['k', f(1, 1)], ['n.mov', f(9, 70000)]]), state: { files: { k: { l: { s: 1, m: 1 }, r: { s: 1, m: 1 } } } }, seen: new Map([['r:n.mov', { size: 9, mtime: 70000, at: 0 }]]), now: 1, stableMs: 0, pull: true });
  eq(mp.downloads.map(d => d.rel), ['n.mov'], 'a new file on the server, the rest known: brought here');
  mp = mirrorPlan({ L: new Map([['k', f(1, 1)]]), R: new Map([['k', f(1, 90000)]]), state: { files: { k: { l: { s: 1, m: 1 }, r: { s: 1, m: 1 } } } }, seen: new Map([['r:k', { size: 1, mtime: 90000, at: 0 }]]), now: 1, stableMs: 0, pull: true });
  eq(mp.downloads.map(d => d.rel), ['k'], 'changed only on the server: brought here');
  mp = mirrorPlan({ L: new Map([['k', f(2, 90000)]]), R: new Map([['k', f(3, 90000)]]), state: { files: { k: { l: { s: 1, m: 1 }, r: { s: 1, m: 1 } } } }, seen: new Map([['l:k', { size: 2, mtime: 90000, at: 0 }]]), now: 1, stableMs: 0, pull: true });
  ok(mp.uploads.length === 1 && mp.uploads[0].keep, 'changed on both sides: the MASTER wins, the server\'s version is kept beside');
  mp = mirrorPlan({ L: new Map([['k', f(1, 1)], ['d', { type: 'folder', partial: true }]]), R: RD(), state: { files: { 'd/x': { l: { s: 1, m: 1 }, r: { s: 1, m: 1 } } } }, seen: new Map(), now: 0, stableMs: 0 });
  eq(mp.deletes.length, 0, 'nothing deleted under a folder not read whole here');
  mp = mirrorPlan({ L: new Map([['v.mov', f(100, 5000)]]), R: new Map([['v.mov', f(100, 9000)]]), state: { files: { 'v.mov': { r: { s: 100, m: 9000 }, pend: 'l' } } }, seen: new Map(), now: 0, stableMs: 0 });
  eq(mp.uploads.length, 0, 'a file the S-FTP relay brought here is not sent back up');
  const { plan } = require('../src/main/core/syncplan');
  const pc = plan({ direction: 'both', L: new Map([['v.mov', f(100, 70000)]]), R: new Map([['v.mov', f(100, 90000)]]), state: { files: { 'v.mov': { l: { s: 50, m: 1000 }, r: { s: 50, m: 1000 } } } }, seen: new Map(), now: 0, stableMs: 0, prefer: 'r' });
  eq([pc.copies.length, pc.conflicts.length], [0, 0], 'DUAL SYNC: changed on both sides into the same file: no conflict copy');

  // With a real server.
  const { srv, ep, root } = await server();
  SRV = srv; EP = ep; SRV_ROOT = () => root;
  const dm = scratch();
  fs.writeFileSync(path.join(dm, 'a.mov'), 'the master version');
  fs.mkdirSync(path.join(dm, 'sub')); fs.writeFileSync(path.join(dm, 'sub', 'b.mov'), 'bbb');
  fs.mkdirSync(path.join(dm, '.filo-trash')); fs.writeFileSync(path.join(dm, '.filo-trash', 'old.mov'), 'x');
  const sr = path.join(root, 'mir');
  fs.mkdirSync(path.join(sr, 'oldfolder'), { recursive: true });
  fs.writeFileSync(path.join(sr, 'a.mov'), 'stale');
  fs.writeFileSync(path.join(sr, 'old.mov'), 'deleted on the computers');
  fs.writeFileSync(path.join(sr, 'oldfolder', 'x.mov'), 'x');
  const pairs = [{ id: 'mmmmmmmmmmmmmmmn', name: 'Rushes', via: 'hybrid', role: 'master', siteId: 's1', local: dm, remote: '/mir', direction: 'both', auto: true, fsAuto: true, interval: 5, exclude: '', peer: { id: 'AAAAAAA-BBBBBBB-CCCCCCC-DDDDDDD-EEEEEEE-FFFFFFF-GGGGGGG-HHHHHHH', name: 'PC' } }];
  const prefs = { listSyncPairs: () => pairs, getSyncPair: id => pairs.find(x => x.id === id), getSite: () => ({ id: 's1' }) };
  const q = makeQueue(ep, SETTINGS, 'inline');
  let ready = true;
  const sm = new Syncer({ prefs, queue: q, log: () => {}, resolveEndpoint: async () => ep, createRemote: e => proto.createRemote(e), dir: path.join(dm, '..', 'stmir'), stableMs: 0,
    directFirst: () => true, mirrorReady: () => ready, sessionFile: async () => ({ filo: 'direct', v: 1, name: 'Rushes' }) });
  const pass = async () => { await sm.run(pairs[0].id, 'mirror'); await sleep(30); const x = await sm.run(pairs[0].id, 'mirror'); await runQueue(q); return x; };
  let res = await pass();
  ok(res.mirror, 'SYNCTHING done: the MASTER writes the mirror');
  eq(fs.readFileSync(path.join(sr, 'a.mov'), 'utf8'), 'the master version', 'a different file on the server: replaced by the MASTER\'s');
  ok(fs.existsSync(path.join(sr, 'sub', 'b.mov')), 'a missing file: sent');
  ok(fs.existsSync(path.join(sr, 'old.mov')) && fs.existsSync(path.join(dm, 'old.mov')) && fs.existsSync(path.join(dm, 'oldfolder', 'x.mov')), 'put on the server by hand: kept there, and brought to the MASTER (3 ways)');
  ok(fs.readdirSync(sr).some(n => /^a\.sync-conflict-.*-from-server\.mov$/.test(n)), 'different on the server at first look: the MASTER\'s goes, the server\'s is kept beside');
  ok(fs.existsSync(path.join(sr, '.filo-session')) && !fs.existsSync(path.join(sr, '.filo-trash')), 'the session file stays, the trash never goes');
  fs.unlinkSync(path.join(dm, 'sub', 'b.mov'));
  res = await pass();
  ok(!fs.existsSync(path.join(sr, 'sub', 'b.mov')) && fs.existsSync(path.join(sr, 'sub')), 'a file deleted here: deleted on the server');
  fs.rmSync(path.join(dm, 'sub'), { recursive: true });
  res = await pass();
  ok(!fs.existsSync(path.join(sr, 'sub')), 'a folder deleted here: deleted on the server');
  pairs[0].remote = '/';
  res = await sm.run(pairs[0].id, 'mirror');
  ok(!res.ok && /root/.test(res.error), 'the root of the server is never a backup folder');
  pairs[0].remote = '/mir';
  ready = false;
  res = await sm.run(pairs[0].id, 'timer');
  ok(res.standby, 'SYNCTHING not finished: the mirror waits');
  ready = true; pairs[0].role = 'slave';
  res = await sm.run(pairs[0].id, 'timer');
  ok(res.standby, 'the SLAVE never writes the mirror');
  q.closeAll(); sm.stopAll();

  // Holds: only the copies held for SYNCTHING go on again, never one paused by hand.
  pairs[0].role = 'master';
  const items = new Map([['m1', { id: 'm1', type: 'file', status: 'queued', remote: '/mir/1', sync: { pairId: pairs[0].id, mirror: true } }], ['u1', { id: 'u1', type: 'file', status: 'paused', remote: '/mir/2', sync: { pairId: pairs[0].id, mirror: true } }]]);
  const fq = { items, get: id => items.get(id), pauseItems: ids => ids.forEach(i => { items.get(i).status = 'paused'; }), resumeItems: ids => ids.forEach(i => { items.get(i).status = 'queued'; }), stopItems: ids => ids.forEach(i => { items.get(i).status = 'stopped'; }) };
  const sh = new Syncer({ prefs, queue: fq, log: () => {}, dir: path.join(dm, '..', 'sth') });
  sh.holdMirror(pairs[0].id, true);
  ok(items.get('m1').status === 'paused' && items.get('m1').sync.held, 'SYNCTHING busy: the backup copy waits (marked, kept after a restart)');
  sh.holdMirror(pairs[0].id, false);
  eq([items.get('m1').status, items.get('u1').status], ['queued', 'paused'], 'SYNCTHING done: it goes on; the one paused by hand stays paused');
  pairs[0].fsAuto = false; sh.apply(pairs[0]);
  eq(items.get('m1').status, 'stopped', 'S-FTP BACKUP switched off: its copies stop');
  pairs[0].fsAuto = true; sh.stopAll();

  // When: SYNCTHING up to date for a while (the MASTER may write), busy again (the copies wait).
  const { createDirect } = require('../src/main/direct-app');
  const pr = new (require('../src/main/config').Prefs)(scratch()).load();
  const hp = pr.saveSyncPair({ via: 'hybrid', role: 'master', name: 'H', siteId: 's1', remote: '/h', local: dm, direction: 'up', folderId: newFolderIdT('up'), peer: { id: 'AAAAAAA-BBBBBBB-CCCCCCC-DDDDDDD-EEEEEEE-FFFFFFF-GGGGGGG-HHHHHHH', name: 'MAC' }, auto: true, exclude: '' });
  const calls = [];
  const DF = createDirect({ prefs: pr, log: () => {}, send: () => {}, home: scratch(), bin: null, onStatus: () => {}, mirrorDelayMs: 80, onMirror: id => calls.push('mirror'), onBusy: (id, on) => calls.push(on ? 'hold' : 'go') });
  DF.direct.emit('status', hp.id, { state: 'insync', peer: { connected: true } });
  ok(!DF.mirrorReady(hp), 'just up to date: not yet');
  await sleep(200);
  ok(DF.mirrorReady(hp) && calls.includes('mirror'), 'up to date for a while: the mirror pass starts');
  DF.direct.emit('status', hp.id, { state: 'syncing', peer: { connected: true } });
  ok(!DF.mirrorReady(hp) && calls.includes('hold'), 'SYNCTHING busy again: the mirror\'s copies wait');
  DF.direct.emit('status', hp.id, { state: 'insync', peer: { connected: true } });
  ok(calls.includes('go'), 'and go on once it is done');
  // The other computer gone and the folder quiet (Syncthing says nothing more): the backup still takes over.
  let fo2 = 0;
  const DG = createDirect({ prefs: pr, log: () => {}, send: () => {}, home: scratch(), bin: null, onStatus: () => {}, onFailover: () => fo2++, missRecheckMs: 60, mirrorDelayMs: 100000 });
  DG.direct.emit('status', hp.id, { state: 'insync', peer: { connected: true } });
  DG.direct.emit('status', hp.id, { state: 'offline', peer: { connected: false } });
  ok(fo2 === 0, 'one missed look: not yet');
  await sleep(150);
  ok(fo2 === 1, 'no news after that: the S-FTP BACKUP takes over');
});

SEC('site manager: folders of their own', () => {
  const { Prefs } = require('../src/main/config');
  const d = scratch();
  fs.writeFileSync(path.join(d, 'preferences.json'), JSON.stringify({ sites: [{ id: 'aaaaaaaaaaaaaaaa', name: 'A', host: 'a', protocol: 'sftp', folder: 'Clients / X' }], siteFolderOrder: ['Gone long ago', 'Clients / X', 'Clients'] }));
  const p1 = new Prefs(d).load();
  eq(p1.data.siteFolderOrder.slice().sort(), ['Clients', 'Clients / X'], 'first start of 0.6.4: folders emptied long ago do not come back');
  p1.arrangeSites(p1.listSites().map(x => ({ id: x.id, folder: x.folder })), p1.data.siteFolderOrder.concat('Archives'));
  const p2 = new Prefs(d).load();
  ok(p2.data.siteFolderOrder.includes('Archives'), 'an empty folder made since stays');
});

SEC('segment relay between two filo', async () => {
  const { Syncer } = require('../src/main/syncer');
  const { srv, ep, root } = await server();
  SRV = srv; EP = ep; SRV_ROOT = () => root;
  const d = scratch();
  const MB = 1024 * 1024;
  const src = randomFile(path.join(d, 'out', 'render.mov'), 6 * MB);
  fs.mkdirSync(path.join(root, 'team'), { recursive: true });
  // The sender: 6 segments of 1 MB, slowed down so the receiver can start early.
  const qA = makeQueue(ep, Object.assign({}, SETTINGS, { limitUp: 1.5, concurrency: 2 }), 'inline');
  qA.add([{ dir: 'up', type: 'file', local: src, remote: '/team/render.mov', size: 6 * MB, endpointId: 'e', endpointLabel: 't', relayOut: true }]);
  let senderDoneAt = 0;
  const senderDone = runQueue(qA, 90000).then(x => { senderDoneAt = Date.now(); return x; });
  // The receiver: a SERVER → LOCAL sync with the relay.
  const inbox = path.join(d, 'inbox'); fs.mkdirSync(inbox);
  const pairs = [{ id: 'cccccccccccccccc', name: 'Team', siteId: 's1', local: inbox, remote: '/team', direction: 'down', auto: false, interval: 5, exclude: '.DS_Store|*.filopart|.*.filoparts', relay: true }];
  const prefs = { listSyncPairs: () => pairs, getSyncPair: id => pairs.find(p => p.id === id), getSite: () => ({ id: 's1' }) };
  const qB = makeQueue(ep, SETTINGS, 'inline');
  let firstSegAt = 0;
  qB.on('changed', () => { for (const it of qB.items.values()) if (!firstSegAt && it.seg && it.seg.chunks.some(c => c.st === 'd')) firstSegAt = Date.now(); });
  const sy = new Syncer({ prefs, queue: qB, log: () => {}, resolveEndpoint: async () => ep, createRemote: e => proto.createRemote(e), dir: path.join(d, 'state'), stableMs: 300, relayPollMs: 300 });
  let it = null;
  for (let i = 0; i < 40 && !it; i++) {
    await sleep(250);
    await sy.run(pairs[0].id, 'test');
    it = [...qB.items.values()].find(x => x.relay);
  }
  ok(!!it, 'the receiver found the file being sent');
  await senderDone;
  for (let i = 0; i < 120 && !(it.status === 'done'); i++) await sleep(250);
  eq(it.status, 'done', 'the receiver finished');
  ok(firstSegAt && firstSegAt < senderDoneAt - 500, `segments arrived before the sender had finished (${senderDoneAt - firstSegAt} ms earlier)`);
  eq(sha(path.join(inbox, 'render.mov')), sha(src), 'the received file is the sender\'s, byte for byte');
  eq(it.verify && it.verify.level, 'relay', 'every segment checked against the sender\'s hashes');
  ok(!fs.existsSync(path.join(root, 'team', '.render.mov.filoparts')) && !fs.existsSync(path.join(inbox, 'render.mov.filopart')), 'no relay folder on the server, no partial file here');
  sy.stopAll(); qA.closeAll(); qB.closeAll();
  await srv.close();
});

SEC('verification catches corruption', async () => {
  // A server that stores something else than what it received.
  const d = scratch();
  const f = randomFile(path.join(d, 'v.bin'), 100000);
  const store = new Map();
  const { Writable, Readable } = require('stream');
  const fake = {
    canSetMTime: false, canSegment: false,
    async stat(p) { if (store.has(p)) return { type: 'file', size: store.get(p).length, mtime: 0 }; if (p === '/' || p === '/v') return { type: 'folder' }; return null; },
    async list() { return []; },
    async mkdir() {},
    async rename(a, b) { store.set(b, store.get(a)); store.delete(a); },
    async unlink(p) { store.delete(p); },
    async hashAlgos() { return []; },
    upload(src, p) { const parts = []; return new Promise((res, rej) => src.pipe(new Writable({ write(c, e, cb) { parts.push(c); cb(); }, final(cb) { const b = Buffer.concat(parts); b[500] ^= 0xff; store.set(p, b); cb(); res(); } })).on('error', rej)); },
    download(p, dest) { return new Promise((res, rej) => { const rs = Readable.from([store.get(p)]); rs.pipe(dest); dest.on('finish', res); dest.on('error', rej); }); },
  };
  const item = { dir: 'up', type: 'file', local: f, remote: '/v/v.bin', size: 100000 };
  const ctx = { remote: fake, settings: Object.assign({}, SETTINGS), token: {}, log: () => {}, onBytes: () => {}, ask: async () => 'overwrite' };
  try { await transfer.runFile(item, ctx); ok(false, 'a corrupted copy must not pass'); }
  catch (e) { ok(e.mismatch, `corruption detected by read-back (${e.message})`); }
  ok(!store.has('/v/v.bin'), 'and the real name was never given to it');
});

SEC('direct: rules and codes', () => {
  const { toIgnore, directionOfOffer, newFolderId } = require('../src/main/direct');
  const { normalizeSyncPair, FOLDER_ID, Prefs } = require('../src/main/config');
  eq(toIgnore('*.tmp|/Cache/\n*/proxy/|  |.DS_Store'), ['(?i)*.tmp', '(?i)/Cache', '(?i)/*/proxy', '(?i).DS_Store'], 'exclusions become .stignore lines');
  const { parseDeviceId } = require('../src/main/direct');
  const RID = '6DXHEPR-5LCKNZ5-DU2ICUS-322SSXZ-3GP6M45-7P4LVMC-COPSNME-LGAIUAY';
  eq([parseDeviceId(' ' + RID.toLowerCase().replace(/-/g, ' ') + '\n'), parseDeviceId(RID.slice(0, -1) + 'Z'), parseDeviceId('hello')], [RID, null, null], 'a pasted SYNCTHING ID is cleaned, a typo is caught');
  eq(toIgnore('*.tmp, /Cache/; .DS_Store'), ['(?i)*.tmp', '(?i)/Cache', '(?i).DS_Store'], 'commas (and semicolons) separate a filter too');
  eq(toIgnore('!/.filo-trash|#include x|//c|(?d)a.tmp|/b.txt:'), ['(?i)/.filo-trash', '(?i)a.tmp', '(?i)/b.txt'], 'Syncthing\'s own marks never get in');
  const id = newFolderId('up');
  ok(FOLDER_ID.test(id), `folder ID ${id} has the expected shape`);
  eq(directionOfOffer(id), 'down', 'a folder sent by the other side is received here');
  eq(directionOfOffer(newFolderId('both')), 'both', 'two ways stays two ways');
  const dev = 'AAAAAAA-BBBBBBB-CCCCCCC-DDDDDDD-EEEEEEE-FFFFFFF-GGGGGGG-HHHHHHH';
  const p = normalizeSyncPair({ via: 'direct', peer: { id: dev, name: 'PC' }, folderId: id, local: '/x', direction: 'up' });
  eq([p.via, p.peer.id, p.folderId], ['direct', dev, id], 'a SYNCTHING pair keeps its fields');
  eq(normalizeSyncPair({ via: 'direct', peer: { id: 'nope' }, folderId: 'bad' }).peer, null, 'a wrong device ID is dropped');
  eq(normalizeSyncPair({}).via, 'server', 'an old pair is a server pair');
  // The code given to the other computer: read back, checked.
  const { createDirect } = require('../src/main/direct-app');
  const prefs = new Prefs(scratch()).load();
  const D = createDirect({ prefs, log: () => {}, send: () => {}, home: scratch(), bin: null });
  const code = D.shareCode({ filo: 'direct', v: 1, device: dev, deviceName: 'MAC', folder: id, name: 'Exports', direction: 'down', exclude: '*.tmp' });
  ok(code.startsWith('filo-direct:') && D.isCode('hello ' + code + ' bye'), 'the code is recognised inside a message');
  return D.readCode('copied: ' + code + '\n').then(r => {
    eq([r.direct.device, r.direct.folder, r.direct.direction, r.direct.name], [dev, id, 'down', 'Exports'], 'the code is read back');
    return D.readCode('filo-direct:eyJmaWxvIjoiZGlyZWN0In0').then(() => ok(false, 'a code without a device is refused'), e => ok(/not a filo LIVE SYNC config/.test(e.message), 'a code without a device is refused'));
  });
});

const newFolderIdT = d => require('../src/main/direct').newFolderId(d);
SEC('direct with S-FTP failsafe: who works when', async () => {
  const { Syncer } = require('../src/main/syncer');
  const d = scratch();
  const pairs = [{ id: 'bbbbbbbbbbbbbbbb', name: 'Rushes', via: 'hybrid', siteId: 's1', local: d, remote: '/x', direction: 'up', auto: false, fsAuto: true, interval: 5, exclude: '' }];
  const prefs = { listSyncPairs: () => pairs, getSyncPair: id => pairs.find(p => p.id === id), getSite: () => ({ id: 's1' }) };
  let direct = true, connects = 0;
  const sy = new Syncer({ prefs, queue: null, log: () => {}, resolveEndpoint: async () => { connects++; throw new Error('no server in this test'); }, createRemote: () => null, dir: path.join(d, 'state'), directFirst: () => direct });
  let r = await sy.run(pairs[0].id, 'timer');
  ok(r.ok && r.standby && connects === 0, 'the other filo is reachable: the server is left alone');
  eq(sy.statusOf(pairs[0].id).state, 'standby', 'and the session says standby');
  direct = false;
  r = await sy.run(pairs[0].id, 'failsafe');
  ok(connects === 1, 'the other filo is not reachable: the failsafe goes to the server');
  direct = 'wait';
  r = await sy.run(pairs[0].id, 'start');
  ok(r.standby && connects === 1, 'SYNCTHING still starting: the server waits');
  sy.stopAll();
  const { normalizeSyncPair } = require('../src/main/config');
  eq(normalizeSyncPair({ via: 'hybrid' }).via, 'hybrid', 'a hybrid session keeps its kind');
  eq(normalizeSyncPair({ watch: false }).watch, false, 'AUTO WATCH off is kept');
  eq(normalizeSyncPair({}).watch, true, 'AUTO WATCH is on by default');
  eq([normalizeSyncPair({}).role, normalizeSyncPair({ role: 'slave' }).role, normalizeSyncPair({}).fsAuto], ['master', 'slave', true], 'MASTER by default, SLAVE kept, failsafe on by default');
  // The MASTER wins a conflict on the server too: its side copies, marked
  // 'master' (the caller keeps the other version first).
  const { plan } = require('../src/main/core/syncplan');
  const L = new Map([['a.mov', { type: 'file', size: 10, mtime: 1000 }]]), R = new Map([['a.mov', { type: 'file', size: 20, mtime: 5000 }]]);
  const st = { files: { 'a.mov': { l: { s: 5, m: 500 }, r: { s: 5, m: 500 } } } };
  const seen = new Map([['l:a.mov', { size: 10, mtime: 1000, at: 0 }], ['r:a.mov', { size: 20, mtime: 5000, at: 0 }]]);
  const base = plan({ direction: 'both', L, R, state: st, seen: new Map(seen), now: 99999, stableMs: 10 });
  eq([base.conflicts.length, base.copies.length], [1, 0], 'without a MASTER: a conflict, left as it is');
  const m = plan({ direction: 'both', L, R, state: st, seen: new Map(seen), now: 99999, stableMs: 10, prefer: 'l' });
  eq([m.conflicts.length, m.copies.length, m.copies[0] && m.copies[0].from, m.copies[0] && m.copies[0].reason], [0, 1, 'l', 'master'], 'MASTER here: this side is sent');
  const sl = plan({ direction: 'both', L, R, state: st, seen: new Map(seen), now: 99999, stableMs: 10, prefer: 'r' });
  eq([sl.copies[0] && sl.copies[0].from], ['r'], 'SLAVE here: the server (the MASTER\'s) is brought');
  // A SLAVE takes the MASTER's settings (direction the other way round).
  const { createDirect } = require('../src/main/direct-app');
  const pr = new (require('../src/main/config').Prefs)(scratch()).load();
  const MID = 'AAAAAAA-BBBBBBB-CCCCCCC-DDDDDDD-EEEEEEE-FFFFFFF-GGGGGGG-HHHHHHH';
  const sp = pr.saveSyncPair({ via: 'direct', role: 'slave', name: 'Old', local: d, direction: 'down', folderId: newFolderIdT('up'), peer: { id: MID, name: 'MAC' }, exclude: '' });
  const DD = createDirect({ prefs: pr, log: () => {}, send: () => {}, home: scratch(), bin: null });
  DD.takeSession(sp, { v: 1, master: 'MAC · macOS', masterId: MID, name: 'New name', masterDirection: 'both', exclude: '*.tmp' }, 'test');
  const sp2 = pr.getSyncPair(sp.id);
  eq([sp2.name, sp2.direction, sp2.exclude], ['New name', 'both', '*.tmp'], 'the SLAVE takes the MASTER\'s name, direction and filter');
  DD.takeSession(sp2, { v: 1, masterId: 'ZZZZZZZ-BBBBBBB-CCCCCCC-DDDDDDD-EEEEEEE-FFFFFFF-GGGGGGG-HHHHHHH', name: 'Intruder', masterDirection: 'up' }, 'test');
  eq(pr.getSyncPair(sp.id).name, 'New name', 'settings from another computer are ignored');
  // One way: the SLAVE pastes the MASTER's SYNCTHING ID (join); the MASTER
  // accepts it and shares a SYNCTHING session (accept → shareTo).
  const RID2 = '6DXHEPR-5LCKNZ5-DU2ICUS-322SSXZ-3GP6M45-7P4LVMC-COPSNME-LGAIUAY';
  eq(DD.join('nope').ok, false, 'not an ID: refused');
  const jn = await DD.join(RID2.toLowerCase());
  ok(jn.ok && pr.listDirectDevices().some(x => x.id === RID2), 'the SLAVE trusts the MASTER it pasted');
  const mp = pr.saveSyncPair({ via: 'direct', role: 'master', name: 'Quick', local: scratch(), direction: 'up', folderId: newFolderIdT('up'), exclude: '' });
  const SID = 'AAAAAAA-BBBBBBB-CCCCCCC-DDDDDDD-EEEEEEE-FFFFFFF-GGGGGGG-HHHHHHA';
  ok(DD.accept({ id: SID, name: 'PC · Windows 11' }, [mp.id, sp.id]).ok, 'the MASTER accepts it');
  eq([pr.getSyncPair(mp.id).peer && pr.getSyncPair(mp.id).peer.id, pr.getSyncPair(sp.id).peer.id], [SID, MID], 'and shares the chosen SYNCTHING session (never a SLAVE\'s one)');
  DD.takeSession(pr.getSyncPair(sp.id), { v: 1, name: 'No ID', masterDirection: 'up' }, 'test');
  eq(pr.getSyncPair(sp.id).name, 'New name', 'settings without the MASTER\'s ID are ignored');
  // Who works when, on the SYNCTHING side: the SYNCTHING switch, and one missed look.
  let fo = 0;
  const DF = createDirect({ prefs: pr, log: () => {}, send: () => {}, home: scratch(), bin: null, onStatus: () => {}, onFailover: () => fo++ });
  DF.direct.bin = 'fake';                                    // "available", never started here
  const hp = pr.saveSyncPair({ via: 'hybrid', role: 'master', name: 'H', siteId: 's1', remote: '/h', local: d, direction: 'up', folderId: newFolderIdT('up'), peer: { id: MID, name: 'MAC' }, auto: true, exclude: '' });
  DF.direct.emit('status', hp.id, { state: 'insync', peer: { id: MID, connected: true } });
  eq(DF.directFirst(hp), true, 'SYNCTHING on and the other computer there: SYNCTHING works');
  eq(DF.directFirst(Object.assign({}, hp, { auto: false })), false, 'SYNCTHING switched off: the failsafe works');
  DF.direct.emit('status', hp.id, { state: 'error', error: 'busy' });
  ok(fo === 0 && DF.directFirst(hp) === true, 'one missed look: no failover yet');
  DF.direct.emit('status', hp.id, { state: 'error', error: 'busy' });
  ok(fo === 1 && DF.directFirst(hp) === false, 'two missed looks: the failsafe takes over');
  // The .filo-session file holds both: direction (the SLAVE's, read at import) and masterDirection.
  DD.takeSession(pr.getSyncPair(sp.id), { v: 1, masterId: MID, name: 'New name', direction: 'down', masterDirection: 'up', exclude: '*.tmp' }, 'test');
  eq(pr.getSyncPair(sp.id).direction, 'down', 'MASTER LOCAL -> REMOTE: the SLAVE is REMOTE -> LOCAL, whatever the file\'s "direction" key');
});

SEC('direct: two filo, peer to peer', async () => {
  const { Direct, binPath, newFolderId } = require('../src/main/direct');
  if (!binPath()) { process.stdout.write(' (skipped: no Syncthing, run node scripts/syncthing-fetch.js)'); return; }
  const fa = scratch(), fb = scratch();
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const until = async (fn, ms) => { const t = Date.now() + (ms || 30000); while (Date.now() < t) { try { if (fn()) return true; } catch (_) {} await sleep(200); } return false; };
  const logs = [];
  const pa = 22300 + Math.floor(Math.random() * 300), pb = pa + 1;
  const A = new Direct({ home: scratch(), log: (l, m) => logs.push('A ' + m), name: 'MAC', testing: { listen: [`tcp://127.0.0.1:${pa}`], addresses: {} } });
  const B = new Direct({ home: scratch(), log: (l, m) => logs.push('B ' + m), name: 'PC', testing: { listen: [`tcp://127.0.0.1:${pb}`], addresses: {} } });
  try {
    const ida = await A.start(), idb = await B.start();
    ok(ida && idb && ida !== idb, 'each filo has its own ID');
    A.o.testing.addresses[idb] = `tcp://127.0.0.1:${pb}`; B.o.testing.addresses[ida] = `tcp://127.0.0.1:${pa}`;
    A.setFast(true); B.setFast(true);
    fs.writeFileSync(path.join(fa, 'clip.mov'), crypto.randomBytes(3 * 1024 * 1024));
    fs.writeFileSync(path.join(fa, 'render.tmp'), 'x');
    const fid = newFolderId('up');
    const pairA = { id: 'a', name: 'Exports', local: fa, direction: 'up', auto: true, folderId: fid, peer: null, exclude: '*.tmp' };
    const pairB = { id: 'b', name: 'Exports', local: fb, direction: 'down', auto: true, folderId: fid, peer: { id: ida, name: 'MAC' }, exclude: '*.tmp' };
    const stB = {}; B.on('status', (id, st) => { stB[id] = st; });
    const items = []; B.on('item', it => items.push(it));
    await A.reconcile([pairA], []);
    await B.reconcile([pairB], [{ id: ida, name: 'MAC' }]);
    // A is asked about B (B imported A's code), and nothing moves before.
    ok(await until(() => A.pending.devices.some(d => d.id === idb), 30000), 'the first computer is asked to accept the other');
    ok(!fs.existsSync(path.join(fb, 'clip.mov')), 'nothing arrives before the user accepts');
    let linked = null;
    A.on('link', l => { linked = l; pairA.peer = l.peer; A.reconcile([pairA], [l.peer]); });
    await A.reconcile([pairA], [{ id: idb, name: 'PC' }]);
    ok(await until(() => linked, 30000), 'once accepted, the live sync links itself (folder offered back)');
    ok(await until(() => fs.existsSync(path.join(fb, 'clip.mov')) && sha(path.join(fb, 'clip.mov')) === sha(path.join(fa, 'clip.mov')), 40000), 'the file arrives, identical');
    ok(!fs.existsSync(path.join(fb, 'render.tmp')), 'an excluded file stays');
    ok(await until(() => items.some(i => i.item === 'clip.mov' && i.pairId === 'b' && !i.error), 10000), 'the receiving side reports the file (journal, LIVE SYNC view)');
    ok(await until(() => stB.b && stB.b.state === 'insync', 20000), `the receiving side says up to date (${stB.b && stB.b.state})`);
    ok(stB.b.peer && stB.b.peer.connected && stB.b.peer.via === 'lan', 'connected, on the local network');
    // Linked once: a new live sync from B is offered to A, no code needed.
    const fid2 = newFolderId('up');
    const fb2 = scratch();
    await B.reconcile([pairB, { id: 'b2', name: 'Rushes', local: fb2, direction: 'up', auto: true, folderId: fid2, peer: { id: ida, name: 'MAC' }, exclude: '' }], [{ id: ida, name: 'MAC' }]);
    ok(await until(() => A.pending.folders.some(f => f.folderId === fid2), 30000), 'a new live sync of the linked computer is offered');
    const offer = A.pending.folders.find(f => f.folderId === fid2) || {};
    eq([offer.name, offer.direction, offer.deviceId], ['Rushes', 'down', idb], 'the offer says what, which way, from whom');
    // A deletion goes to the other computer's trash, never lost; the trash
    // itself is never synced.
    fs.mkdirSync(path.join(fa, '.filo-trash'), { recursive: true });
    fs.writeFileSync(path.join(fa, '.filo-trash', 'old.mov'), 'x');
    fs.unlinkSync(path.join(fa, 'clip.mov'));
    await A.rescan(pairA);
    ok(await until(() => !fs.existsSync(path.join(fb, 'clip.mov')) && fs.existsSync(path.join(fb, '.filo-trash', 'clip.mov')), 20000), 'a file deleted on one side goes to the trash of the other');
    ok(!fs.existsSync(path.join(fb, '.filo-trash', 'old.mov')), 'the trash is never synced');
    // MASTER / SLAVE: a file changed on both computers; the SLAVE's version
    // is the newer one, Syncthing would keep it: the MASTER's wins.
    const fc = scratch(), fd = scratch();
    const fid3 = newFolderId('both');
    const pC = { id: 'c', name: 'Edit', local: fc, direction: 'both', auto: true, folderId: fid3, peer: { id: idb, name: 'PC · Linux' }, exclude: '', role: 'master' };
    const pD = { id: 'd', name: 'Edit', local: fd, direction: 'both', auto: true, folderId: fid3, peer: { id: ida, name: 'MAC · Linux' }, exclude: '', role: 'slave' };
    A.on('item', it => { if (it.pairId === 'c' && !it.error) A.masterWins(pC, it.item); });
    fs.writeFileSync(path.join(fc, 'cut.txt'), 'v1');
    await A.reconcile([pairA, pC], [{ id: idb }]);
    await B.reconcile([pairB, pD], [{ id: ida, name: 'MAC' }]);
    ok(await until(() => fs.existsSync(path.join(fd, 'cut.txt')), 30000), 'a two-way session between MASTER and SLAVE runs');
    pC.auto = false; pD.auto = false;
    await A.reconcile([pairA, pC], [{ id: idb }]); await B.reconcile([pairB, pD], [{ id: ida, name: 'MAC' }]);
    fs.writeFileSync(path.join(fc, 'cut.txt'), 'MASTER version');
    await sleep(2100);
    fs.writeFileSync(path.join(fd, 'cut.txt'), 'SLAVE version, newer');
    pC.auto = true; pD.auto = true;
    await A.reconcile([pairA, pC], [{ id: idb }]); await B.reconcile([pairB, pD], [{ id: ida, name: 'MAC' }]);
    await A.rescan(pC); await B.rescan(pD);
    const read = f => { try { return fs.readFileSync(f, 'utf8'); } catch (_) { return null; } };
    const settled = () => read(path.join(fc, 'cut.txt')) === 'MASTER version' && read(path.join(fd, 'cut.txt')) === 'MASTER version'
      && fs.readdirSync(fd).some(f => /^cut\.sync-conflict-\d{8}-\d{6}-from-PC\.txt$/.test(f) && read(path.join(fd, f)) === 'SLAVE version, newer');
    ok(await until(settled, 45000), `the MASTER's version wins on both computers, the SLAVE's is kept beside it with its name (MASTER: ${fs.readdirSync(fc).map(f => f + '=' + read(path.join(fc, f))).join(', ')} | SLAVE: ${fs.readdirSync(fd).map(f => f + '=' + read(path.join(fd, f))).join(', ')})`);
    // Paused: nothing moves.
    pairA.auto = false; await A.reconcile([pairA], [{ id: idb }]);
    fs.writeFileSync(path.join(fa, 'later.txt'), 'later');
    await sleep(3000);
    ok(!fs.existsSync(path.join(fb, 'later.txt')), 'paused: nothing is sent');
    pairA.auto = true; await A.reconcile([pairA], [{ id: idb }]); await A.rescan(pairA);
    ok(await until(() => fs.existsSync(path.join(fb, 'later.txt')), 30000), 'ON again: it goes');
    // Files in name order: the LIVE SYNC queue moves from the top.
    const fcfg = await B.req('GET', `/rest/config/folders/${fid}`);
    eq(fcfg.order, 'alphabetic', 'files go in name order');
    // PAUSE from the queue: the session stays connected, nothing moves, a
    // reconcile keeps it paused; RESUME: it goes.
    await B.hold(pairB, true);
    await B.reconcile([pairB, pD], [{ id: ida, name: 'MAC' }]);
    ok((await B.req('GET', `/rest/config/folders/${fid}`)).paused === true, 'PAUSE: the folder is paused, a reconcile keeps it so');
    ok(await until(() => stB.b && stB.b.state === 'held', 10000), `PAUSE: the session says paused (${stB.b && stB.b.state})`);
    fs.writeFileSync(path.join(fa, 'held.txt'), 'held'); await A.rescan(pairA);
    await sleep(3000);
    ok(!fs.existsSync(path.join(fb, 'held.txt')), 'PAUSE: nothing arrives');
    await B.hold(pairB, false);
    ok(await until(() => fs.existsSync(path.join(fb, 'held.txt')), 30000), 'RESUME: it goes');
    // Restart keeps the same identity; a Syncthing left running is stopped.
    const home = A.home;
    await A.stop();
    ok(!A.child, 'stopped cleanly');
    const A2 = new Direct({ home, log: () => {}, testing: { listen: [`tcp://127.0.0.1:${pa}`], addresses: {} } });
    eq(await A2.start(), ida, 'the same ID after a restart');
    A2.child.removeAllListeners('exit');   // as if filo had crashed: Syncthing still runs
    const A3 = new Direct({ home, log: (l, m) => logs.push('A3 ' + m), testing: { listen: [`tcp://127.0.0.1:${pa}`], addresses: {} } });
    eq(await A3.start(), ida, 'a new filo takes over from a Syncthing left running');
    ok(logs.some(l => /left by the previous filo/.test(l)), 'the old one was asked to stop');
    await A3.stop();
  } finally {
    await A.stop().catch(() => {}); await B.stop().catch(() => {});
  }
});

SEC('check against the other side', async () => {
  const compare = require('../src/main/core/compare');
  const { hashFile } = require('../src/main/core/hash');
  const { srv, ep, root } = await server();
  const L = scratch();
  const put = (base, rel, data) => { const f = path.join(base, ...rel.split('/')); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, data); };
  const same = crypto.randomBytes(200000), a = crypto.randomBytes(5000), b = Buffer.from(a); b[100] ^= 1;
  for (const [base, extra] of [[L, 'only-here.mov'], [path.join(root, 'deliv'), 'only-there.mov']]) {
    put(base, 'DAY1/same.mov', same); put(base, 'DAY1/sub/same2.mov', same); put(base, extra, 'x'); put(base, 'DAY1/.DS_Store', 'junk');
  }
  put(L, 'DAY1/flip.mov', a); put(path.join(root, 'deliv'), 'DAY1/flip.mov', b);
  put(L, 'DAY1/size.mov', 'abc'); put(path.join(root, 'deliv'), 'DAY1/size.mov', 'abcd');
  const r = await connectTrusting(ep);
  try {
    const names = ['DAY1', 'only-here.mov', 'only-there.mov'];
    const p = await compare.plan(r, { localRoot: L, remoteRoot: '/deliv', names });
    eq(p.algo, null, 'this test server computes no checksum');
    eq(p.both.sort(), ['DAY1/flip.mov', 'DAY1/same.mov', 'DAY1/sub/same2.mov'], 'same size on both sides: to check; .DS_Store left out');
    const res = await compare.run(r, p, { localRoot: L, remoteRoot: '/deliv', readBack: true });
    eq(res.same, ['DAY1/same.mov', 'DAY1/sub/same2.mov'], 'identical files, read back');
    eq(res.different.map(d => d.rel), ['DAY1/flip.mov', 'DAY1/size.mov'], 'one byte changed, and a size that differs');
    eq([res.onlyLocal, res.onlyRemote], [['only-here.mov'], ['only-there.mov']], 'what is on one side only');
    const no = await compare.run(r, p, { localRoot: L, remoteRoot: '/deliv', readBack: false });
    eq(no.unchecked.length, 3, 'no checksum and no read back: not checked, never called identical');
    // A server that computes a checksum: asked, never read back.
    const h = await hashFile(path.join(L, 'DAY1/same.mov'), 'sha256');
    let reads = 0;
    const fake = { hashAlgos: async () => ['sha256'], serverHash: async () => h, download: async () => { reads++; } };
    const res2 = await compare.run(fake, Object.assign({}, p, { algo: 'sha256', both: ['DAY1/same.mov'] }), { localRoot: L, remoteRoot: '/deliv', readBack: true });
    ok(res2.same.length === 1 && reads === 0, 'the server\'s checksum, nothing downloaded');
  } finally { await r.close(); }
});

SEC('command after the queue', async () => {
  const hook = require('../src/main/core/hook');
  eq(hook.tokenize(`/bin/x "a b" 'c d' e`), ['/bin/x', 'a b', 'c d', 'e'], 'quotes keep spaces together');
  eq(hook.argvFor('{local}/run.sh "{local}" {result}', { local: '/tmp/My Folder; rm -rf ~', result: 'ok' }), ['{local}/run.sh', '/tmp/My Folder; rm -rf ~', 'ok'], 'a variable is one argument, never the program, never a command');
  const v = hook.varsFor({ done: 2, failed: 1, bytes: 10, endpointLabel: 'NAS' }, [
    { type: 'file', dir: 'up', local: '/U/a/x/1.mov', remote: '/r/d/x/1.mov' }, { type: 'file', dir: 'up', local: '/U/a/y/2.mov', remote: '/r/d/y/2.mov' }]);
  eq([v.result, v.done, v.failed, v.local, v.remote, v.direction, v.server], ['errors', 2, 1, '/U/a', '/r/d', 'up', 'NAS'], 'what the command is told');
  const d = scratch(), out = path.join(d, 'out.txt');
  const r = await hook.run([process.execPath, '-e', 'require("fs").writeFileSync(process.argv[1], process.argv.slice(2).join("|"))', out, 'a b', 'ok']);
  ok(r.ok && fs.readFileSync(out, 'utf8') === 'a b|ok', 'it runs, its arguments as given, and filo waits for it');
  const bad = await hook.run([process.execPath, '-e', 'process.exit(3)']);
  eq([bad.ok, bad.code], [false, 3], 'an exit code is a failure, said so');
  const none = await hook.run(['/no/such/program-filo']);
  ok(!none.ok && /not found/.test(none.error), 'a program that does not exist: said so');
  const slow = await hook.run([process.execPath, '-e', 'setTimeout(()=>{}, 5000)'], { timeoutMs: 300 });
  ok(!slow.ok && /still running/.test(slow.error), 'too long: filo goes on');
});

SEC('direct: a missing local folder is never created', async () => {
  const { Direct, binPath, newFolderId } = require('../src/main/direct');
  if (!binPath()) { process.stdout.write(' (skipped: no Syncthing)'); return; }
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const until = async (fn, ms) => { const t = Date.now() + (ms || 20000); while (Date.now() < t) { try { if (fn()) return true; } catch (_) {} await sleep(200); } return false; };
  const base = scratch(), gone = path.join(base, 'Downloads', 'TEST');
  const logs = [];
  const port = 22700 + Math.floor(Math.random() * 200);
  const A = new Direct({ home: scratch(), log: (l, m) => logs.push(m), name: 'LINUX', testing: { listen: [`tcp://127.0.0.1:${port}`], addresses: {} } });
  try {
    await A.start();
    const st = {}; A.on('status', (id, s) => { st[id] = s; });
    const pair = { id: 'm', name: 'TEST', local: gone, direction: 'both', auto: true, folderId: newFolderId('both'), peer: null, exclude: '' };
    await A.reconcile([pair], []);
    await sleep(3000);
    ok(!fs.existsSync(gone), 'a session whose folder was deleted does not create it again at launch');
    ok(await until(() => st.m && st.m.state === 'error' && /missing/.test(st.m.error)), 'the session says its local folder is missing');
    ok(logs.some(m => /local folder is missing/.test(m)), 'and the log says so');
    fs.mkdirSync(gone, { recursive: true });
    ok(await until(() => fs.existsSync(path.join(gone, '.stfolder')), 30000), 'the folder back: the session starts again by itself');
  } finally { await A.stop().catch(() => {}); }
});

SEC('LIVE SYNC down: phone alert', () => {
  const { reason, SyncAlert } = require('../src/main/core/syncalert');
  const P = { id: 'p', name: 'Rushes', via: 'direct', auto: true, peer: { id: 'X', name: 'PC-MONTAGE · Windows 11' } };
  eq(reason(P, { state: 'insync', peer: { connected: true } }), '', 'working: nothing');
  eq(reason(P, { state: 'offline', peer: { connected: false } }), 'PC-MONTAGE not reachable', 'the other computer away');
  eq(reason(P, { state: 'waiting', peer: { connected: false } }), '', 'never linked yet: not an alert');
  eq(reason(Object.assign({}, P, { auto: false }), { state: 'paused', peer: { connected: false } }), '', 'disconnected by hand: nothing');
  eq(reason({ id: 's', via: 'server', auto: true }, { state: 'error', error: 'auth failed' }), 'server: auth failed', 'S-FTP in error');
  eq(reason({ id: 'h', via: 'hybrid', auto: false, fsAuto: true }, { server: { state: 'error', error: 'NAS off' } }), 'S-FTP BACKUP: NAS off', 'DUAL SYNC: its backup in error');
  const A = new SyncAlert(), M = 60000, down = { state: 'offline', peer: { connected: false } }, up = { state: 'insync', peer: { connected: true } };
  eq(A.step([{ pair: P, status: down }], 0, 10 * M, true), [], 'just down: wait');
  eq(A.step([{ pair: P, status: down }], 9 * M, 10 * M, true), [], 'not yet the limit');
  const a1 = A.step([{ pair: P, status: down }], 10 * M, 10 * M, true);
  eq(a1.map(x => [x.kind, x.minutes]), [['down', 10]], 'down for the limit: one alert');
  eq(A.step([{ pair: P, status: down }], 20 * M, 10 * M, true), [], 'only once');
  eq(A.step([{ pair: P, status: up }], 25 * M, 10 * M, true).map(x => [x.kind, x.minutes]), [['up', 25]], 'works again: one more');
  A.step([{ pair: P, status: down }], 30 * M, 10 * M, true);
  eq(A.step([{ pair: P, status: up }], 32 * M, 10 * M, true), [], 'a short drop never announced: nothing');
  A.step([{ pair: P, status: down }], 40 * M, 10 * M, false);
  eq(A.step([{ pair: P, status: down }], 60 * M, 10 * M, false), [], 'alerts off: nothing sent');
});

SEC('ftp (real servers, optional)', async () => {
  const targets = [['ftp', process.env.FILO_TEST_FTP], ['ftps', process.env.FILO_TEST_FTPS], ['ftps-implicit', process.env.FILO_TEST_FTPS_IMPLICIT]].filter(x => x[1]);
  if (!targets.length) { process.stdout.write(' (skipped: no FILO_TEST_FTP*)'); return; }
  for (const [protocol, hp] of targets) {
    const [host, port] = hp.split(':');
    const ep = { protocol, host, port: Number(port), user: process.env.FILO_TEST_FTP_USER, password: process.env.FILO_TEST_FTP_PASS };
    for (const transferMode of ['passive', 'active']) {
      const r = await connectTrusting(Object.assign({ transferMode }, ep));
      const home = await r.home();
      const data = crypto.randomBytes(1234567);
      const { Readable, Writable } = require('stream');
      const p = `${home}/filo-test-${protocol}-${transferMode}.bin`;
      await r.upload(Readable.from([data]), p, 0);
      const got = [];
      await r.download(p, new Writable({ write(c, e, cb) { got.push(c); cb(); } }), 0);
      ok(Buffer.concat(got).equals(data), `${protocol} ${transferMode}: round trip`);
      // Resume: a first part, then the rest appended.
      await r.upload(Readable.from([data.subarray(0, 1000000)]), p, 0);
      await r.upload(Readable.from([data.subarray(1000000)]), p, 1000000);
      const got2 = [];
      await r.download(p, new Writable({ write(c, e, cb) { got2.push(c); cb(); } }), 0);
      ok(Buffer.concat(got2).equals(data), `${protocol} ${transferMode}: resumed upload (APPE) = whole file`);
      const tail = [];
      await r.download(p, new Writable({ write(c, e, cb) { tail.push(c); cb(); } }), 1200000);
      ok(Buffer.concat(tail).equals(data.subarray(1200000)), `${protocol} ${transferMode}: resumed download (REST)`);
      await r.unlink(p);
      await r.close();
    }
  }
});

SEC('resume over FTP and FTPS (real servers, optional)', async () => {
  // 0.9.7: the same as the SFTP resume tests, on a real FTP server (vsftpd):
  // stopped, damaged partial, killed. FILO_TEST_FTP_ROOT: the account's
  // folder on this machine (to damage the partial by hand).
  const targets = [['ftp', process.env.FILO_TEST_FTP], ['ftps', process.env.FILO_TEST_FTPS]].filter(x => x[1]);
  const fsRoot = process.env.FILO_TEST_FTP_ROOT;
  if (!targets.length || !fsRoot) { process.stdout.write(' (skipped: no FILO_TEST_FTP* / FILO_TEST_FTP_ROOT)'); return; }
  const { spawn } = require('child_process');
  const SZ = 12 * 1024 * 1024;
  const d0 = scratch();
  const src = randomFile(path.join(d0, 'big.mov'), SZ);
  let n = 0;
  for (const [protocol, hp] of targets) {
    const [host, port] = hp.split(':');
    const ep = { protocol, host, port: Number(port), user: process.env.FILO_TEST_FTP_USER, password: process.env.FILO_TEST_FTP_PASS };
    const r0 = await connectTrusting(ep); const home = await r0.home(); await r0.close();
    const fp = known.get(`${protocol === 'sftp' ? 'sftp' : 'ftps'}:${host}:${port}`) || null;
    const srvSrc = path.join(fsRoot, `filo-src-${protocol}.mov`);
    fs.copyFileSync(src, srvSrc); try { fs.chownSync(srvSrc, fs.statSync(fsRoot).uid, fs.statSync(fsRoot).gid); } catch (_) {}
    for (const dir of ['up', 'down']) for (const harm of ['clean', 'replaced', 'truncate', 'kill']) {
      const tag = `${protocol} ${dir} ${harm}`;
      const d = scratch();
      const name = dir === 'up' ? `filo-up-${n++}.mov` : `filo-src-${protocol}.mov`;
      const remote = `${home}/${name}`;
      const local = dir === 'up' ? src : path.join(d, 'big.mov');
      const settings = Object.assign({}, SETTINGS, { segments: false, concurrency: 1, limitUp: 3, limitDown: 3, verify: false });
      const spec = [{ dir, type: 'file', local, remote, size: SZ, endpointId: 'e', endpointLabel: 't' }];
      let store = null;
      if (harm === 'kill') {
        settings.limitUp = 1.5; settings.limitDown = 1.5;
        const storeFile = path.join(d, 'queue.json');
        const child = spawn(process.execPath, [path.join(__dirname, 'crash-child.js'), JSON.stringify({ ep, fp, store: storeFile, settings, items: spec })], { stdio: 'ignore' });
        const saved = () => { try { return JSON.parse(fs.readFileSync(storeFile, 'utf8'))[0].done || 0; } catch (_) { return 0; } };
        for (let i = 0; i < 800 && saved() < 4 * 1024 * 1024; i++) await sleep(50);
        child.kill('SIGKILL'); await new Promise(r => child.once('exit', r));
        store = { data: JSON.parse(fs.readFileSync(storeFile, 'utf8')), load() { return this.data; }, save(a) { this.data = a; } };
      }
      const q = makeQueue(ep, settings, 'worker', store ? { store } : undefined);
      if (!store) {
        q.add(spec);
        const id = q.order[0];
        q.start();
        for (let i = 0; i < 600 && !(q.items.get(id).done > 4 * 1024 * 1024); i++) await sleep(25);
        q.pause();
        for (let i = 0; i < 200 && q._unitsOf(q.items.get(id)).length; i++) await sleep(25);
        const part = dir === 'up' ? path.join(fsRoot, name + '.filopart') : local + '.filopart';
        if (harm === 'replaced') { const sz = fs.statSync(part).size; fs.writeFileSync(part, crypto.randomBytes(sz)); }
        if (harm === 'truncate') fs.truncateSync(part, Math.floor(fs.statSync(part).size / 3));
      }
      settings.limitUp = 0; settings.limitDown = 0;
      const s = await runQueue(q); q.closeAll();
      eq([s.done, s.failed], [1, 0], `${tag}: done`);
      if (harm === 'clean' || harm === 'kill') ok(s.bytes < SZ, `${tag}: resumed (${(s.bytes / 1048576).toFixed(1)} MB of 12 sent)`);
      eq(sha(dir === 'up' ? path.join(fsRoot, name) : local), sha(src), `${tag}: identical`);
      if (dir === 'up') try { fs.unlinkSync(path.join(fsRoot, name)); } catch (_) {}
    }
    try { fs.unlinkSync(srvSrc); } catch (_) {}
  }
});

SEC('review 0.7.2: nothing local is lost', async () => {
  const { srv, ep, root } = await server();
  SRV = srv; EP = ep; SRV_ROOT = () => root;
  const d = scratch();
  // 1. "Temporary names" off: a download still goes to .filopart; stopped half
  //    way, the file that was there is as it was.
  randomFile(path.join(root, 'big.bin'), 6 * 1024 * 1024);
  const mine = randomFile(path.join(d, 'big.bin'), 1000);
  const before = sha(mine);
  {
    const settings = Object.assign({}, SETTINGS, { tempNames: false, segments: false, concurrency: 1, limitDown: 2 });
    const q = makeQueue(ep, settings, 'worker');
    const [id] = q.add([{ dir: 'down', type: 'file', local: mine, remote: '/big.bin', size: 6 * 1024 * 1024, endpointId: 'e', endpointLabel: 't', existing: 'overwrite' }]);
    q.start(); await sleep(1500); q.stopItems([id]); await sleep(500);
    eq(sha(mine), before, 'temp names off, download stopped: the local file is untouched');
    ok(fs.existsSync(mine + '.filopart'), 'the bytes received went to .filopart');
    q.closeAll();
  }
  // 2. LIVE SYNC S-FTP replacing a local file: the old one goes to .filo-trash.
  {
    const { Syncer } = require('../src/main/syncer');
    const loc = path.join(d, 'Here');
    const old = randomFile(path.join(loc, 'sub', 'a.bin'), 40000);
    const oldSha = sha(old);
    const past = new Date(Date.now() - 3600e3);
    fs.utimesSync(old, past, past);
    randomFile(path.join(root, 'sync2', 'sub', 'a.bin'), 50000);
    const pairs = [{ id: 'cccccccccccccccc', name: 'Here', siteId: 's1', local: loc, remote: '/sync2', direction: 'down', auto: false, interval: 5, exclude: '' }];
    const prefs = { listSyncPairs: () => pairs, getSyncPair: id => pairs.find(p => p.id === id), getSite: () => ({ id: 's1' }) };
    const q = makeQueue(ep, SETTINGS, 'inline');
    const sy = new Syncer({ prefs, queue: q, log: () => {}, resolveEndpoint: async () => ep, createRemote: e => proto.createRemote(e), dir: path.join(d, 'state'), stableMs: 0 });
    let r = await sy.run(pairs[0].id, 'test');
    if (!r.copies) { await sleep(400); r = await sy.run(pairs[0].id, 'test'); }
    eq(r.copies, 1, 'server newer on first look: one copy planned');
    await runQueue(q);
    eq(sha(path.join(loc, 'sub', 'a.bin')), sha(path.join(root, 'sync2', 'sub', 'a.bin')), 'the server version is here');
    const tdir = path.join(loc, '.filo-trash', 'sub');
    const kept = fs.existsSync(tdir) ? fs.readdirSync(tdir) : [];
    ok(kept.length === 1 && /^a~\d{8}-\d{6}\.bin$/.test(kept[0]), `the replaced version is in .filo-trash/sub (${kept.join(', ')})`);
    if (kept.length === 1) eq(sha(path.join(tdir, kept[0])), oldSha, 'and it is the old file, whole');
    // A manual download replacing a file never goes to the trash.
    const q2 = makeQueue(ep, SETTINGS, 'inline');
    q2.add([{ dir: 'down', type: 'file', local: path.join(loc, 'sub', 'a.bin'), remote: '/big.bin', size: 6 * 1024 * 1024, endpointId: 'e', endpointLabel: 't', existing: 'overwrite' }]);
    await runQueue(q2); q2.closeAll();
    eq(fs.readdirSync(tdir).length, 1, 'a manual download does not use the trash');
    sy.stopAll(); q.closeAll();
  }
  await srv.close();
  // 3. preferences.json damaged: the copy from the last start is taken back.
  {
    const { Prefs } = require('../src/main/config');
    const dir = path.join(d, 'prefs');
    const p1 = new Prefs(dir).load();
    p1.data.sites = [{ id: 'a1b2c3d4e5f60718', name: 'Kept', protocol: 'sftp', host: 'h', port: 22, user: 'u' }];
    p1.save();
    new Prefs(dir).load();                                  // a start that reads it well: .bak made
    ok(fs.existsSync(path.join(dir, 'preferences.json.bak')), 'a good file is kept as .bak at start');
    fs.writeFileSync(path.join(dir, 'preferences.json'), '{"sites": [ {"id": "a1b2');   // cut by a power failure
    const p2 = new Prefs(dir).load();
    eq([p2.recovered, p2.data.sites.length, p2.data.sites[0] && p2.data.sites[0].name], ['bak', 1, 'Kept'], 'damaged file: the .bak is taken back');
    ok(fs.readdirSync(dir).some(n => n.startsWith('preferences.json.corrupt-')), 'the damaged file is kept aside');
  }
});

SEC('speed test (0.8.0)', async () => {
  const { runSpeedTest, stepsFor, suggest, PREFIX } = require('../src/main/core/speedtest');
  const netid = require('../src/main/core/netid');
  // 1. The model: a profile is clamped, kept, never exported.
  eq(sites.normalizeSpeed(null), null, 'no profile');
  eq(sites.normalizeSpeed({ out: { conn: 0, mbps: 5 } }), null, 'a profile with nothing usable is dropped');
  const sp = sites.normalizeSpeed({ at: 5, net: 'abc', out: { conn: 99, seg: true, mbps: 12.34 }, in: { conn: 3, seg: 'x', mbps: -1 }, maxOpen: 50 });
  eq([sp.out.conn, sp.out.seg, sp.out.mbps, sp.in, sp.maxOpen], [10, true, 12.3, null, 10], 'clamped, a bad direction dropped');
  const withSpeed = sites.normalizeSite({ id: 'a1b2c3d4e5f60718', name: 'x', host: 'h', speed: sp });
  ok(JSON.parse(await sites.exportFilo([withSpeed])).sites[0].speed === undefined, 'the filo export never carries a speed profile');
  {
    const { Prefs } = require('../src/main/config');
    const d = scratch();
    const p = new Prefs(d).load();
    const s1 = p.saveSite({ name: 'NAS', protocol: 'sftp', host: 'nas', port: 22, user: 'u' });
    p.saveSite({ id: s1.id, speed: sp });
    ok(p.getSite(s1.id).speed && p.getSite(s1.id).speed.out.conn === 10, 'the profile is stored');
    p.saveSite({ id: s1.id, name: 'NAS 2', protocol: 'sftp', host: 'nas', port: 22, user: 'u' });
    ok(p.getSite(s1.id).speed, 'renaming the bookmark keeps its profile');
    p.saveSite({ id: s1.id, name: 'NAS 2', protocol: 'sftp', host: 'other', port: 22, user: 'u' });
    eq(p.getSite(s1.id).speed, null, 'another server: the old profile is gone');
  }
  {
    const prof = { at: 1, net: 'n1', out: { conn: 4, seg: true, mbps: 50 }, in: null };
    ok(sites.learnFromTransfer(prof, 'n1', 'up', 6, 80, 9).out.conn === 6, 'a faster real transfer updates the profile');
    eq(sites.learnFromTransfer(prof, 'n1', 'up', 6, 80, 9).out.src, 'transfer', 'and says where the figures come from');
    eq(sites.learnFromTransfer(prof, 'n1', 'up', 6, 80, 9).out.seg, true, 'segments are kept as measured');
    eq(sites.learnFromTransfer(prof, 'n1', 'up', 6, 51, 9), null, 'hardly faster: left alone');
    eq(sites.learnFromTransfer(prof, 'n1', 'up', 2, 20, 9), null, 'slower: never lowered');
    eq(sites.learnFromTransfer(prof, 'n2', 'up', 6, 80, 9), null, 'another network: left alone');
    eq(sites.learnFromTransfer(prof, 'n1', 'down', 6, 80, 9), null, 'a direction never tested is not created');
    eq(sites.learnFromTransfer(null, 'n1', 'up', 6, 80, 9), null, 'no profile: nothing');
  }
  // 2. Auto starts where the profile says, once, and still measures.
  {
    const t = new AutoTuner({ max: 6, start: 2 });
    ok(t.preset(5) && t.limit() === 5, 'preset moves the start');
    ok(!t.preset(3) && t.limit() === 5, 'only once');
    const t2 = new AutoTuner({ max: 4, start: 2 }); t2.preset(9);
    eq(t2.limit(), 4, 'never above the maximum');
    const t3 = new AutoTuner({ max: 8, start: 2 }); t3.serverRefused(3); t3.newRun(); t3.preset(7);
    ok(t3.limit() <= 7, 'a new run presets again');
  }
  eq(stepsFor(8), [1, 2, 4, 8], 'steps for 8'); eq(stepsFor(3), [1, 2, 3], 'steps for 3'); eq(stepsFor(1), [1], 'steps for 1');
  eq(suggest([{ n: 1, mbps: 10 }, { n: 2, mbps: 20 }, { n: 4, mbps: 21 }]), 2, 'one more connection must buy 10 %');
  // 3. The network is read, or left empty; never an error.
  const c = await netid.refresh();
  ok(typeof c.id === 'string' && typeof netid.current() === 'string', 'the network identity is a string');
  // 4. The engine against a real server; nothing is left on it.
  const left = root => { const out = []; (function walk(d) { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) walk(p); else out.push(p); } })(root); return out; };
  {
    const { srv, ep, root } = await server({ maxSessions: 3 });
    fs.mkdirSync(path.join(root, 'home'), { recursive: true });
    const events = [];
    const res = await runSpeedTest({ create: () => proto.createRemote(Object.assign({}, ep, { acceptFingerprint: null })), protocol: 'SFTP', dir: '/', durationMs: 6000, token: { cancelled: false }, onEvent: e => events.push(e.type + (e.phase ? ':' + e.phase : '')) });
    eq([...new Set(events)].filter(x => x !== 'sample'), ['phase:connect', 'info', 'phase:out', 'dir', 'phase:in', 'done'], 'the test goes connect, out, in, done');
    eq([res.maxOpen, res.capped], [3, true], 'a server that takes 3 connections: 3 found, and said so');
    eq(res.out.steps.map(x => x.n), [1, 2, 3], 'steps stop at what the server accepts');
    ok(res.out.mbps > 0 && res.in.mbps > 0, `both directions measured (${res.out.mbps.toFixed(1)} / ${res.in.mbps.toFixed(1)} MB/s)`);
    ok(res.out.conn >= 1 && res.out.conn <= 3 && res.in.conn >= 1 && res.in.conn <= 3, 'a suggestion within what the server takes');
    eq(left(root), [], 'no temporary file is left on the server');
    // Cancelled half way: stops at once, and still cleans.
    const token = { cancelled: false };
    setTimeout(() => { token.cancelled = true; if (token.cut) token.cut(); }, 2500);
    let err = null;
    const t0 = Date.now();
    try { await runSpeedTest({ create: () => proto.createRemote(Object.assign({}, ep)), protocol: 'SFTP', dir: '/', durationMs: 20000, token }); } catch (e) { err = e; }
    ok(err && err.cancelled, 'a cancelled test says so');
    ok(Date.now() - t0 < 8000, `and stops at once (${Date.now() - t0} ms)`);
    eq(left(root), [], 'a cancelled test leaves nothing either');
    await srv.close();
  }
  // 5. Not even one connection: the real reason, nothing left behind.
  {
    const { srv, ep, root } = await server();
    let err = null;
    try { await runSpeedTest({ create: () => proto.createRemote(Object.assign({}, ep, { password: 'wrong' })), dir: '/', durationMs: 6000, token: { cancelled: false } }); } catch (e) { err = e; }
    ok(err && /refused the login|login/i.test(err.message), 'a wrong password is reported as such: ' + (err && err.message.split('\n')[0]));
    await srv.close();
  }
  // 5b. Where the test works: root => the user chooses; read-only => asked; picked folder => used.
  {
    const { resolveDir } = require('../src/main/core/speedtest');
    const fake = writable => ({
      upload: async (_s, p) => { if (!writable.some(w => p.startsWith(w === '/' ? '/' : w + '/'))) throw new Error('Permission denied'); },
      unlink: async () => {},
    });
    const code = async f => { try { await f(); return null; } catch (e) { return e.code; } };
    eq(await code(() => resolveDir(fake(['/']), '/', { dir: '' })), 'PICK_DIR', 'bookmark on the server root: the user is asked for a folder');
    eq(await code(() => resolveDir(fake(['/']), '/', { dir: '' , readOnly: false })), 'PICK_DIR', 'login folder = root, no folder set: asked');
    eq(await resolveDir(fake(['/video']), '/', { dir: '/video' }), '/video', 'a folder picked or kept in the bookmark is used when it accepts a file');
    eq(await resolveDir(fake(['/home/me']), '/home/me', { dir: '' }), '/home/me', 'a writable login folder that is not the root: no question');
    eq(await code(() => resolveDir(fake([]), '/', { dir: '/docs' })), 'READONLY', 'a read-only bookmark folder: the user is asked');
    eq(await resolveDir(fake([]), '/', { dir: '/docs', readOnly: true }), '/docs', 'reception only: no write needed');
  }
  // 5c. Reception only, on the real server: nothing is written, only RECEIVE is measured.
  {
    const { srv, ep, root } = await server();
    fs.mkdirSync(path.join(root, 'media'));
    fs.writeFileSync(path.join(root, 'media', 'clip.bin'), crypto.randomBytes(3 * 1024 * 1024));
    const before = fs.readdirSync(path.join(root, 'media')).join();
    const res = await runSpeedTest({ create: () => proto.createRemote(Object.assign({}, ep, { acceptFingerprint: null })), protocol: 'SFTP', durationMs: 6000, dir: '/media', readOnly: true, token: { cancelled: false } });
    ok(res.out === null && res.in && res.in.mbps > 0, 'reception only: no send figure, a receive figure');
    eq(fs.readdirSync(path.join(root, 'media')).join(), before, 'reception only: nothing written on the server');
    let c = null; try { await runSpeedTest({ create: () => proto.createRemote(Object.assign({}, ep, { acceptFingerprint: null })), durationMs: 6000, dir: '/', readOnly: true, token: { cancelled: false } }); } catch (e) { c = e.code; }
    eq(c, 'NO_FILE', 'reception only on an empty folder: clear error');
    let pk = null; try { await runSpeedTest({ create: () => proto.createRemote(Object.assign({}, ep, { acceptFingerprint: null })), durationMs: 6000, dir: '', token: { cancelled: false } }); } catch (e) { pk = e.code; }
    eq(pk, 'PICK_DIR', 'server root as login folder, no folder set: asked');
    await srv.close();
  }
  // 6. The queue starts Auto from the profile, and sends a file whole when
  //    the test found no gain from segments.
  {
    const { srv, ep, root } = await server();
    const d = scratch();
    const mk = (n, name) => ({ dir: 'up', type: 'file', local: randomFile(path.join(d, name), 3 * 1024 * 1024), remote: '/' + name, size: 3 * 1024 * 1024, endpointId: 'site:' + n, endpointLabel: 't' });
    const seen = [];
    const q = makeQueue(ep, Object.assign({}, SETTINGS, { concurrency: 'auto', autoMax: 6, segments: true }), 'inline', { speedProfile: (id, dir) => { seen.push(id + ':' + dir); return { conn: 4, seg: false, mbps: 50 }; } });
    q.add([mk('a1b2c3d4e5f60718', 'p1.bin'), mk('a1b2c3d4e5f60718', 'p2.bin')]);
    let sawSeg = false;
    const watch = setInterval(() => { for (const i of q.items.values()) if (i.seg) sawSeg = true; }, 10);
    await runQueue(q, 60000);
    clearInterval(watch);
    ok(seen.length > 0 && seen.every(x => x === 'site:a1b2c3d4e5f60718:up'), 'the queue asks the profile of the site, for the direction of the file');
    ok(q.logs.some(l => /this server's speed test/.test(l)), 'Auto says it started from the speed test');
    ok(q.tuner.preset_done, 'the preset was used once');
    ok(!sawSeg, 'segments off by the profile: the files went whole');
    q.closeAll();
    // And without a profile the same file is cut in segments (control).
    const q2 = makeQueue(ep, Object.assign({}, SETTINGS, { concurrency: 'auto', autoMax: 6, segments: true }), 'inline');
    q2.add([mk('x', 'p3.bin')]);
    let sawSeg2 = false;
    const watch2 = setInterval(() => { for (const i of q2.items.values()) if (i.seg) sawSeg2 = true; }, 10);
    await runQueue(q2, 60000);
    clearInterval(watch2);
    ok(sawSeg2, 'control: without a profile, a file this size is sent in segments');
    q2.closeAll();
    // What a run measured goes up with the summary (one server, one direction, big enough).
    const q3 = makeQueue(ep, Object.assign({}, SETTINGS, { concurrency: 'auto', autoMax: 6 }), 'inline');
    q3.add([mk('a1b2c3d4e5f60718', 'p4.bin')]);
    const s3 = await runQueue(q3, 60000);
    ok(s3.profile === undefined, 'a small run says nothing about the server (under 100 MB, under 10 s)');
    q3.closeAll();
    await srv.close();
  }
});

// ══ Run ══════════════════════════════════════════════════════════════════
(async () => {
  const only = process.argv[2];
  const t0 = Date.now();
  for (const [name, fn] of SECTIONS) {
    if (only && !name.includes(only)) continue;
    section = name;
    process.stdout.write(`\n${name.padEnd(36)} `);
    try { await fn(); }
    catch (e) { failed++; failures.push(`[${name}] UNCAUGHT: ${e && e.stack || e}`); process.stdout.write('X'); }
  }
  console.log(`\n\n${passed} passed, ${failed} failed (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  if (failures.length) console.log('\n' + failures.map(f => '  ✗ ' + f).join('\n'));
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch (_) {}
  process.exit(failed ? 1 : 0);
})();
