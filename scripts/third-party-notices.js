#!/usr/bin/env node
// Writes THIRD_PARTY_NOTICES.md: every external component shipped inside a
// filo build, its licence, and the licence texts that come with it.
//
// Why: the MIT, Apache-2.0, BSD and ISC licences of filo's components ask
// that their copyright notice and licence text travel with any copy of the
// program, including a build. filo itself is GPL-3.0-or-later; every
// licence listed here is compatible with it.
//
// Run it again whenever a dependency changes (npm install of a new package,
// a crate added or updated in engine/Cargo.toml):
//     node scripts/third-party-notices.js
// It needs node_modules (npm install) and Rust (cargo) on the machine. It
// reads only files already on disk: nothing is downloaded.

'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'THIRD_PARTY_NOTICES.md');
const LICENSE_FILE = /^(licen[cs]e|copying|notice|unlicense)([-._].*)?$/i;

function die(msg) { console.error('third-party-notices: ' + msg); process.exit(1); }

function licenseFiles(dir) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch (_) { return []; }
  return names.filter(n => LICENSE_FILE.test(n) && fs.statSync(path.join(dir, n)).isFile())
    .sort()
    .map(n => ({ name: n, text: fs.readFileSync(path.join(dir, n), 'utf8').replace(/\r\n/g, '\n').trim() }));
}

function cargoBin() {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const local = path.join(home, '.cargo', 'bin', process.platform === 'win32' ? 'cargo.exe' : 'cargo');
  return fs.existsSync(local) ? local : 'cargo';
}

// --- Rust crates of the engine (all target platforms: Mac, Windows, Linux) ---
function crates() {
  let meta;
  try {
    meta = JSON.parse(execFileSync(cargoBin(), ['metadata', '--format-version', '1', '--locked',
      '--manifest-path', path.join(ROOT, 'engine', 'Cargo.toml')], { maxBuffer: 256 << 20, encoding: 'utf8' }));
  } catch (e) { die('cargo metadata failed (is Rust installed?): ' + e.message); }
  const byId = new Map(meta.packages.map(p => [p.id, p]));
  const nodes = new Map(meta.resolve.nodes.map(n => [n.id, n]));
  // Only what the engine really pulls in (normal and build dependencies).
  const seen = new Set();
  const todo = [meta.resolve.root];
  while (todo.length) {
    const id = todo.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    for (const d of (nodes.get(id) || { deps: [] }).deps) {
      if (d.dep_kinds.some(k => k.kind !== 'dev')) todo.push(d.pkg);
    }
  }
  seen.delete(meta.resolve.root);
  return [...seen].map(id => byId.get(id)).map(p => ({
    name: p.name, version: p.version,
    license: p.license || (p.license_file ? 'see file' : 'not declared'),
    url: p.repository || p.homepage || `https://crates.io/crates/${p.name}`,
    files: licenseFiles(path.dirname(p.manifest_path)),
  }));
}

// --- npm packages inside the app (production dependencies only) ---
function npmPackages() {
  const lockPath = path.join(ROOT, 'package-lock.json');
  if (!fs.existsSync(path.join(ROOT, 'node_modules'))) die('node_modules is missing: run npm install first.');
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  const out = [];
  for (const [key, info] of Object.entries(lock.packages || {})) {
    if (!key || info.dev || info.devOptional) continue;
    const dir = path.join(ROOT, key);
    let pkg = {};
    try { pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')); } catch (_) { continue; }
    // Optional native modules of ssh2: never packed (electron-builder.yml).
    if (['cpu-features', 'nan'].includes(pkg.name)) continue;
    let url = pkg.repository && (pkg.repository.url || pkg.repository);
    if (typeof url === 'string') url = url.replace(/^git\+/, '').replace(/\.git$/, '');
    out.push({
      name: pkg.name, version: pkg.version,
      license: (typeof pkg.license === 'string' ? pkg.license : (pkg.license && pkg.license.type)) || 'not declared',
      url: url || pkg.homepage || `https://www.npmjs.com/package/${pkg.name}`,
      files: licenseFiles(dir),
    });
  }
  return out;
}

// Recognise the two licences whose texts are standard, to label a package
// that forgot to declare one (ssh2) and to point a package that ships no
// licence file (russh) to the standard text another package brings.
const KNOWN = [
  ['Apache-2.0', /Apache License[\s\S]{0,40}Version 2\.0[\s\S]*TERMS AND CONDITIONS/],
  ['MIT', /Permission is hereby granted, free of charge/],
];
function kind(text) { const k = KNOWN.find(([, re]) => re.test(text)); return k ? k[0] : null; }
function fixLicense(p) {
  if (p.license === 'not declared') {
    const k = p.files.map(f => kind(f.text)).find(Boolean);
    if (k) p.license = k + ' (from its licence file)';
  }
  return p;
}

const rust = crates().map(fixLicense).sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
const npm = npmPackages().map(fixLicense).sort((a, b) => a.name.localeCompare(b.name));

// Identical texts (the Apache-2.0 text, mostly) are written once.
const texts = new Map();
function ref(f) {
  const h = crypto.createHash('sha256').update(f.text).digest('hex').slice(0, 10);
  if (!texts.has(h)) texts.set(h, { text: f.text, users: [] });
  return h;
}

function table(list) {
  const rows = ['| Component | Version | Licence | Source |', '|---|---|---|---|'];
  for (const p of list) rows.push(`| ${p.name} | ${p.version} | ${p.license.replace(/\|/g, '/')} | ${p.url} |`);
  return rows.join('\n');
}

// Standard texts found in other packages, by licence.
const standard = {};
for (const p of [...rust, ...npm]) for (const f of p.files) {
  const k = kind(f.text);
  if (k === 'Apache-2.0' && !standard[k] && !/Copyright \d{4}/.test(f.text.split('APPENDIX')[0])) standard[k] = f;
}

function details(list) {
  const out = [];
  for (const p of list) {
    out.push(`### ${p.name} ${p.version}\n`);
    if (!p.files.length) {
      const k = Object.keys(standard).find(id => p.license.split(/\s+(?:OR|AND)\s+|[()\/]/).includes(id));
      if (k) {
        const h = ref(standard[k]);
        texts.get(h).users.push(`${p.name} ${p.version}`);
        out.push(`No licence file in the package. Declared licence: ${p.license}.` +
          ` Standard ${k} text: see [text ${h}](#text-${h}). Copyright: the authors listed at ${p.url}.\n`);
      } else {
        out.push(`No licence file in the package. Declared licence: ${p.license}` +
          ` (standard text: https://spdx.org/licenses/). Copyright: the authors listed at ${p.url}.\n`);
      }
      continue;
    }
    for (const f of p.files) {
      const h = ref(f);
      texts.get(h).users.push(`${p.name} ${p.version}`);
      out.push(`- ${f.name}: see [text ${h}](#text-${h})`);
    }
    out.push('');
  }
  return out.join('\n');
}

const rustDetails = details(rust);
const npmDetails = details(npm);

const md = [];
md.push('# Third-party notices');
md.push('');
md.push('filo is free software under the GNU General Public License v3.0 or later');
md.push('(see `LICENSE`). Its builds also contain the components below, each under');
md.push('its own licence. All of them are compatible with the GPL v3.');
md.push('');
md.push('This file is generated by `scripts/third-party-notices.js`. Do not edit it');
md.push('by hand: run the script again when a dependency changes.');
md.push('');
md.push('## Electron');
md.push('');
md.push('filo runs on Electron (MIT licence, https://github.com/electron/electron),');
md.push('which contains Chromium, Node.js and their own components. Every build');
md.push('ships their notices next to the application: `LICENSE.electron.txt` and');
md.push('`LICENSES.chromium.html`.');
md.push('');
md.push('## Icons and font');
md.push('');
md.push('- **Lucide icons** (ISC licence; the parts that come from Feather are under');
md.push('  the MIT licence), drawn inside `src/renderer/app.js`.');
md.push('  Copyright: Cole Bemis (Feather) and the Lucide Contributors.');
md.push('  Licence: https://github.com/lucide-icons/lucide/blob/main/LICENSE');
md.push('- **Poppins** font (SIL Open Font License 1.1), Copyright 2020 The Poppins');
md.push('  Project Authors (https://github.com/itfoundry/Poppins). Its licence text');
md.push('  ships with the font: `src/renderer/fonts/Poppins-OFL.txt`.');
md.push('');
let stVersion = '';
try { stVersion = require('./syncthing-fetch').VERSION; } catch (_) {}
md.push('## Syncthing (DIRECT live sync)');
md.push('');
md.push(`filo ships Syncthing ${stVersion}, unmodified, as a separate program that it`);
md.push('starts for its DIRECT live sync (resources/syncthing/ in a build).');
md.push('Licence: Mozilla Public License 2.0. Copyright: the Syncthing Authors');
md.push('(AUTHORS.txt). Its licence text, its authors and where its source code is');
md.push('(SOURCE.txt) are next to the program in every build. Source code:');
md.push(`https://github.com/syncthing/syncthing/tree/${stVersion}`);
md.push('');
md.push(`## Rust transfer engine (filo-engine): ${rust.length} crates`);
md.push('');
md.push('Crates compiled into the `filo-engine` program. Where a crate offers a');
md.push('choice of licences (for example "MIT OR Apache-2.0"), any of them applies.');
md.push('');
md.push(table(rust));
md.push('');
md.push(`## JavaScript packages: ${npm.length} packages`);
md.push('');
md.push(table(npm));
md.push('');
md.push('## Licence files per component');
md.push('');
md.push(rustDetails);
md.push(npmDetails);
md.push('## Licence texts');
md.push('');
for (const [h, t] of texts) {
  md.push(`<a id="text-${h}"></a>`);
  md.push(`### Text ${h}`);
  md.push('');
  md.push(`Used by: ${[...new Set(t.users)].join(', ')}`);
  md.push('');
  md.push('```text');
  md.push(t.text.replace(/```/g, "'''"));
  md.push('```');
  md.push('');
}

fs.writeFileSync(OUT, md.join('\n'));
const missing = [...rust, ...npm].filter(p => !p.files.length).map(p => p.name);
console.log(`THIRD_PARTY_NOTICES.md written: ${rust.length} crates, ${npm.length} npm packages, ${texts.size} distinct licence texts.`);
if (missing.length) console.log('No licence file in: ' + missing.join(', '));
const odd = [...rust, ...npm].filter(p => /GPL|SSPL|not declared/i.test(p.license) && !/ OR /.test(p.license));
if (odd.length) console.log('CHECK BY HAND: ' + odd.map(p => `${p.name} (${p.license})`).join(', '));
