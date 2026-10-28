#!/usr/bin/env node
// Security updates for the browser engine: move desktop/electron.lock.json to the newest stable
// castlabs "Electron for Content Security" release (Chromium + Widevine) and pin every platform
// archive by SHA-256 from that release's SHASUMS256.txt.
//
//   node desktop/scripts/bump-electron.mjs                 newest stable release of the pinned major
//   node desktop/scripts/bump-electron.mjs --major         allow a newer major (new Chromium milestone)
//   node desktop/scripts/bump-electron.mjs --version=44.9.4+wvcus
//   node desktop/scripts/bump-electron.mjs --check         exit 3 when an update is available (CI)
//
// Electron backports Chromium security fixes to its three newest majors; castlabs re-releases
// them with Widevine within days. Staying on the newest patch of a supported major is the minimum;
// moving to a new major every ~8 weeks keeps the engine on current Chromium.

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DESKTOP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOCK = path.join(DESKTOP, 'electron.lock.json');
const REPO = 'castlabs/electron-releases';
const PLATFORMS = ['win32-x64', 'win32-arm64', 'darwin-x64', 'darwin-arm64', 'linux-x64', 'linux-arm64'];
const arg = (n) => {
  const a = process.argv.find((x) => x === `--${n}` || x.startsWith(`--${n}=`));
  return a ? (a.includes('=') ? a.split('=').slice(1).join('=') : true) : null;
};

function parse(tag) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)\+wvcus$/.exec(tag);
  return m ? { tag: tag.replace(/^v/, ''), major: +m[1], minor: +m[2], patch: +m[3] } : null;
}
const cmp = (a, b) => a.major - b.major || a.minor - b.minor || a.patch - b.patch;

async function gh(url) {
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'ludworks-browser-bump' };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res;
}

async function latest(lock) {
  const current = parse(lock.version);
  const releases = await (await gh(`https://api.github.com/repos/${REPO}/releases?per_page=50`)).json();
  const stable = releases.filter((r) => !r.prerelease && !r.draft).map((r) => parse(r.tag_name)).filter(Boolean);
  const pool = arg('major') ? stable : stable.filter((v) => v.major === current.major);
  pool.sort(cmp);
  return pool[pool.length - 1] || current;
}

async function main() {
  const lock = JSON.parse(readFileSync(LOCK, 'utf8'));
  const wanted = arg('version') ? parse(String(arg('version'))) : await latest(lock);
  if (!wanted) throw new Error('bad --version');
  const current = parse(lock.version);
  if (cmp(wanted, current) === 0) {
    console.log(`engine is current: ${lock.version}`);
    return;
  }
  if (arg('check')) {
    console.log(`update available: ${lock.version} -> ${wanted.tag}`);
    process.exit(3);
  }
  const enc = encodeURIComponent(`v${wanted.tag}`);
  const base = `https://github.com/${REPO}/releases/download/${enc}/`;
  const sums = await (await gh(`${base}SHASUMS256.txt`)).text();
  const assets = {};
  for (const p of PLATFORMS) {
    const file = `electron-v${wanted.tag}-${p}.zip`;
    const line = sums.split(/\r?\n/).find((l) => l.endsWith(` *${file}`) || l.endsWith(`  ${file}`));
    if (!line) throw new Error(`no checksum for ${file} in SHASUMS256.txt`);
    const sha256 = line.split(/\s+/)[0].toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error(`bad checksum line for ${file}`);
    assets[p] = { file, sha256 };
  }
  const next = { ...lock, version: wanted.tag, release: `https://github.com/${REPO}/releases/tag/${enc}`, baseUrl: base, assets };
  writeFileSync(LOCK, `${JSON.stringify(next, null, 2)}\n`);
  console.log(`engine: ${lock.version} -> ${wanted.tag}`);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
