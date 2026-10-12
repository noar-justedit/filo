/*
 * filo — FTP, FTPS and SFTP client
 * Copyright (C) 2026 Just Edit (Arnaud Augst)
 * Licensed under the GNU General Public License v3.0 or later. See LICENSE.
 */

// Also puts Syncthing for the same system in vendor/syncthing/dist/:
// scripts/syncthing-fetch.js, called at the end of the hook.
//
// Builds the Rust transfer engine (engine/, "filo-engine") for the system an
// app is being packaged for, and leaves it in engine/dist/<mac|win|linux>/,
// where electron-builder picks it up (extraResources) and puts it next to
// the app — signed with it on a Mac.
//
// It runs by itself at every build: electron-builder calls it before packing
// (beforePack in electron-builder.yml), whichever script started the build
// (build_mac.command, build_windows.command, build_on_windows.bat,
// build_linux.sh, build.sh). By hand: node scripts/engine-build.js mac|win|linux
//
// Never a reason for a build to fail. When the engine cannot be built (Rust
// not installed, the Windows cross-compiler missing…), it says why and how to
// fix it, the folder is left EMPTY (never an old engine from an earlier
// build), and the app is built anyway: filo then moves files with its
// built-in engine, as before the Rust engine existed.
//
// What it needs:
//   every system   Rust (https://rustup.rs). scripts/bench-engine.command
//                  offers to install it.
//   Windows, built on the Mac
//                  the Windows target of Rust (added here, automatically) and
//                  the MinGW compiler: brew install mingw-w64
//   Windows, built on Windows
//                  Rust with the Visual Studio C++ build tools (rustup asks).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const ENGINE = path.join(ROOT, 'engine');

const say = s => console.log(`  • [engine] ${s}`);
const warn = s => console.log(`  ⚠ [engine] ${s}`);

// rustup puts cargo in ~/.cargo/bin (%USERPROFILE%\.cargo\bin on Windows),
// which the Finder, the Explorer or a window opened before the install may
// not have in its PATH yet: it is added here, and cargo is looked for there
// first. On Windows the variable is spelled "Path": writing "PATH" next to it
// made two of them, and Windows kept the old one (cargo then "not installed").
const CARGO_BIN = path.join(os.homedir(), '.cargo', 'bin');
const EXT = process.platform === 'win32' ? '.exe' : '';
function env() {
  const e = Object.assign({}, process.env);
  const key = Object.keys(e).find(k => k.toUpperCase() === 'PATH') || 'PATH';
  e[key] = [CARGO_BIN, e[key] || ''].join(path.delimiter);
  return e;
}
// The full path of a tool, or null.
function which(cmd, e) {
  const own = path.join(CARGO_BIN, cmd + EXT);
  if (fs.existsSync(own)) return own;
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { env: e, encoding: 'utf8' });
  if (r.status !== 0) return null;
  return String(r.stdout || '').split(/\r?\n/).find(Boolean) || cmd;
}
function has(cmd, e) { return !!which(cmd, e); }
function run(cmd, args, e) {
  const exe = which(cmd, e) || cmd;
  const r = spawnSync(exe, args, { env: e, stdio: 'inherit', cwd: ENGINE });
  return r.status === 0;
}

// platform: 'mac' | 'win' | 'linux'; arch: 'arm64' | 'x64'
function build(platform, arch) {
  const out = path.join(ENGINE, 'dist', platform);
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  const exe = platform === 'win' ? 'filo-engine.exe' : 'filo-engine';
  const e = env();
  const without = why => { warn(`${why}`); warn('The app is built WITHOUT the Rust engine: filo will move files with its built-in engine.'); return false; };

  if (process.env.FILO_ENGINE_BUILD === '0') return without('FILO_ENGINE_BUILD=0: not built.');
  const cargo = which('cargo', e);
  if (!cargo) return without(`Rust is not installed: no cargo in ${CARGO_BIN} nor in the PATH (https://rustup.rs, or start scripts/bench-engine.command once).`);
  say(`Rust: ${cargo}`);

  const host = process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'win' : 'linux';
  const hostArch = os.arch() === 'arm64' ? 'arm64' : 'x64';
  let target = null;
  if (platform === 'mac') {
    if (host !== 'mac') return without('the Mac engine is built on a Mac.');
    target = arch === 'x64' ? 'x86_64-apple-darwin' : 'aarch64-apple-darwin';
  } else if (platform === 'win') {
    if (arch !== 'x64') return without(`Windows ${arch} is not built.`);
    if (host !== 'win') {
      target = 'x86_64-pc-windows-gnu';
      if (!has('x86_64-w64-mingw32-gcc', e)) return without('the Windows compiler is missing. Install it once: brew install mingw-w64');
      e.CARGO_TARGET_X86_64_PC_WINDOWS_GNU_LINKER = 'x86_64-w64-mingw32-gcc';
      e.CC_x86_64_pc_windows_gnu = 'x86_64-w64-mingw32-gcc';
      e.AR_x86_64_pc_windows_gnu = 'x86_64-w64-mingw32-ar';
    }
  } else {
    if (host !== 'linux') return without('the Linux engine is built on Linux (scripts/build-linux.sh).');
    if (arch !== hostArch) return without(`Linux ${arch} is not built on ${hostArch}.`);
  }

  if (target) {
    // The target's standard library, downloaded once by rustup (a few
    // dozen MB). Nothing happens when it is already there.
    if (has('rustup', e)) run('rustup', ['target', 'add', target], e);
  }
  say(`building filo-engine for ${platform} ${arch}${target ? ` (${target})` : ''}…`);
  const args = ['build', '--release', '--locked'];
  if (target) args.push('--target', target);
  if (!run('cargo', args, e)) return without('the compilation failed (see the lines above).');
  const built = path.join(ENGINE, 'target', ...(target ? [target] : []), 'release', exe);
  if (!fs.existsSync(built)) return without(`${built} was not produced.`);
  fs.copyFileSync(built, path.join(out, exe));
  if (platform !== 'win') fs.chmodSync(path.join(out, exe), 0o755);
  say(`ready: engine/dist/${platform}/${exe}`);
  return true;
}

// electron-builder hook (beforePack). Arch: 0 ia32, 1 x64, 2 armv7l, 3 arm64.
module.exports = async function beforePack(context) {
  const platform = { darwin: 'mac', win32: 'win', linux: 'linux' }[context.electronPlatformName];
  const arch = context.arch === 3 ? 'arm64' : context.arch === 1 ? 'x64' : String(context.arch);
  if (platform) build(platform, arch);
  // SYNCTHING: Syncthing for the same system (scripts/syncthing-fetch.js).
  if (platform) {
    try { await require('./syncthing-fetch').fetchFor(platform, arch); }
    catch (e) { console.log(`  ⚠ [direct] ${e.message}: the app is built WITHOUT SYNCTHING.`); }
  }
};
module.exports.build = build;

if (require.main === module) {
  const platform = process.argv[2];
  const arch = process.argv[3] || (platform === 'win' ? 'x64' : os.arch() === 'arm64' ? 'arm64' : 'x64');
  if (!['mac', 'win', 'linux'].includes(platform)) { console.log('usage: node scripts/engine-build.js mac|win|linux [arm64|x64]'); process.exit(2); }
  process.exit(build(platform, arch) ? 0 : 1);
}
