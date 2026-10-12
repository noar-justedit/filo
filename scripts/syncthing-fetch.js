/*
 * filo — FTP, FTPS and SFTP client
 * Copyright (C) 2026 Just Edit (Arnaud Augst)
 * Licensed under the GNU General Public License v3.0 or later. See LICENSE.
 */

// SYNCTHING: puts Syncthing (https://syncthing.net, MPL-2.0) for the system an
// app is being packaged for in vendor/syncthing/dist/<mac|win|linux>/, where
// electron-builder picks it up (extraResources → resources/syncthing/).
//
// It runs by itself at every build, from scripts/engine-build.js (the
// beforePack hook). By hand: node scripts/syncthing-fetch.js mac|win|linux
// (with no argument: this computer's system, for npm run dev). Mac: arm64 unless x64 is given.
//
// The program is Syncthing's own release, downloaded once from GitHub
// (github.com/syncthing/syncthing/releases) and kept in vendor/syncthing/
// (not in the repository). Its SHA-256 must be the one written below,
// copied from the release's signed sha256sum.txt.asc: a different file is
// refused. filo never changes Syncthing; it starts it as a separate program.
//
// What goes next to it, as its licence asks: LICENSE.txt (MPL-2.0),
// AUTHORS.txt, and SOURCE.txt (where its source code is, for this exact
// version).
//
// Never a reason for a build to fail: without network, the folder stays
// EMPTY and the app is built without SYNCTHING (everything else works).
//
// To move to a newer Syncthing: change VERSION and the three SHA256 lines
// (from sha256sum.txt.asc of that release), build, and test SYNCTHING between
// two computers before publishing.

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const VERSION = 'v2.1.5';
const ASSETS = {
  // filo for Mac is built for Apple silicon (arm64); x64 is there for a build
  // someone would make for an Intel Mac.
  mac: { file: `syncthing-macos-arm64-${VERSION}.zip`, sha256: '4a3153cce6f3bdc6290824e409b1622c3b78ad8b8a8b2fc846c0061b61e44d4a', exe: 'syncthing' },
  'mac-x64': { file: `syncthing-macos-amd64-${VERSION}.zip`, sha256: 'f4535e479472a1ae43d3e6ffc4bcfc7651179e948387c08f3696847d142b62c7', exe: 'syncthing' },
  win: { file: `syncthing-windows-amd64-${VERSION}.zip`, sha256: '39571e4d0900c2a2cab14c0b170f49751340a869e49734ccc8079d9b98a7974b', exe: 'syncthing.exe' },
  linux: { file: `syncthing-linux-amd64-${VERSION}.tar.gz`, sha256: '3d222b609f7ab2944e02748cb10488b4160d446b49e0eafc107ef2a525ab3486', exe: 'syncthing' },
};
const ROOT = path.join(__dirname, '..');
const VENDOR = path.join(ROOT, 'vendor', 'syncthing');

const say = s => console.log(`  • [direct] ${s}`);
const warn = s => console.log(`  ⚠ [direct] ${s}`);

function download(url, dest, redirects) {
  return new Promise((res, rej) => {
    https.get(url, { headers: { 'User-Agent': 'filo-build' } }, r => {
      if ([301, 302, 303, 307, 308].includes(r.statusCode) && r.headers.location && (redirects || 0) < 5) {
        r.resume();
        return download(new URL(r.headers.location, url).toString(), dest, (redirects || 0) + 1).then(res, rej);
      }
      if (r.statusCode !== 200) { r.resume(); return rej(new Error(`HTTP ${r.statusCode}`)); }
      const tmp = dest + '.part';
      const out = fs.createWriteStream(tmp);
      r.pipe(out);
      out.on('finish', () => out.close(() => { fs.renameSync(tmp, dest); res(); }));
      out.on('error', rej);
      r.on('error', rej);
    }).on('error', rej);
  });
}
function sha256(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }

// Opening the archive: unzip for the .zip when there is one (macOS, most
// Linux), else tar (Windows 10+ has bsdtar, which also opens .zip; GNU tar
// on Linux for the .tar.gz).
function extract(archive, into) {
  fs.mkdirSync(into, { recursive: true });
  if (archive.endsWith('.zip')) {
    const u = spawnSync('unzip', ['-q', '-o', archive, '-d', into], { stdio: 'inherit' });
    if (!u.error && u.status === 0) return true;
  }
  const r = spawnSync('tar', ['-xf', archive, '-C', into], { stdio: 'inherit' });
  return !r.error && r.status === 0;
}
// The program itself: the largest file of that name (the archive also has
// small service files called "syncthing" in etc/).
function find(dir, name, best) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) best = find(p, name, best);
    else if (e.name === name) { const n = fs.statSync(p).size; if (!best || n > best.size) best = { p, size: n }; }
  }
  return best;
}

async function fetchFor(platform, arch) {
  const a = ASSETS[platform === 'mac' && arch === 'x64' ? 'mac-x64' : platform];
  const out = path.join(VENDOR, 'dist', platform);
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  const without = why => { warn(why); warn('The app is built WITHOUT SYNCTHING (live sync between two filo). Everything else works.'); return false; };
  if (!a) return without(`no Syncthing for ${platform}.`);
  if (process.env.FILO_DIRECT_BUILD === '0') return without('FILO_DIRECT_BUILD=0: not included.');

  const cache = path.join(VENDOR, VERSION);
  fs.mkdirSync(cache, { recursive: true });
  const archive = path.join(cache, a.file);
  if (!fs.existsSync(archive) || sha256(archive) !== a.sha256) {
    const url = `https://github.com/syncthing/syncthing/releases/download/${VERSION}/${a.file}`;
    say(`downloading Syncthing ${VERSION} for ${platform} (once)…`);
    try { await download(url, archive); } catch (e) { return without(`could not download ${url} (${e.message}).`); }
  }
  const got = sha256(archive);
  if (got !== a.sha256) { fs.rmSync(archive, { force: true }); return without(`${a.file}: its SHA-256 is not the one of the release (${got}). Refused.`); }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'filo-st-'));
  try {
    if (!extract(archive, tmp)) return without(`could not open ${a.file} (tar).`);
    const hit = find(tmp, a.exe);
    if (!hit || hit.size < 1000000) return without(`${a.exe} not found in ${a.file}.`);
    const exe = hit.p;
    const dir = path.dirname(exe);
    fs.copyFileSync(exe, path.join(out, a.exe));
    if (platform !== 'win') fs.chmodSync(path.join(out, a.exe), 0o755);
    for (const f of ['LICENSE.txt', 'AUTHORS.txt']) {
      const src = fs.existsSync(path.join(dir, f)) ? path.join(dir, f) : (find(tmp, f) || {}).p;
      if (src) fs.copyFileSync(src, path.join(out, f));
    }
    fs.writeFileSync(path.join(out, 'SOURCE.txt'), [
      `Syncthing ${VERSION}, unmodified, shipped with filo as a separate program`,
      'for its SYNCTHING live sync (filo starts it and drives it through its local API).',
      '',
      'Licence: Mozilla Public License 2.0 (LICENSE.txt, next to this file).',
      `Source code of this exact version: https://github.com/syncthing/syncthing/tree/${VERSION}`,
      `Release and its signed checksums: https://github.com/syncthing/syncthing/releases/tag/${VERSION}`,
      'Website: https://syncthing.net',
      '',
    ].join('\n'));
    say(`ready: vendor/syncthing/dist/${platform}/${a.exe} (Syncthing ${VERSION})`);
    return true;
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

module.exports = { fetchFor, VERSION };

if (require.main === module) {
  const platform = process.argv[2] || { darwin: 'mac', win32: 'win', linux: 'linux' }[process.platform];
  const arch = process.argv[3] || (os.arch() === 'arm64' ? 'arm64' : 'x64');
  if (!ASSETS[platform]) { console.log('usage: node scripts/syncthing-fetch.js [mac|win|linux] [arm64|x64]'); process.exit(2); }
  fetchFor(platform, arch).then(ok => process.exit(ok ? 0 : 1));
}
