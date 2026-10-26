// Static guarantees about the source tree (complements the extension CSP).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { scanOutput } from '../build.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const SRC = path.join(ROOT, 'src');

async function walk(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(full)));
    else out.push(full);
  }
  return out;
}

test('no innerHTML/eval/remote code/inline handlers anywhere in src', async () => {
  assert.deepEqual(await scanOutput(SRC), []);
});

test('no third-party dependencies', async () => {
  const pkg = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.dependencies, undefined);
  assert.equal(pkg.devDependencies, undefined);
  for (const f of await walk(SRC)) {
    if (!f.endsWith('.js')) continue;
    const text = await readFile(f, 'utf8');
    for (const m of text.matchAll(/^\s*import[^'"]*['"]([^'"]+)['"]/gm)) {
      assert.match(m[1], /^\.{1,2}\//, `${path.relative(ROOT, f)} imports a bare specifier: ${m[1]}`);
    }
  }
});

test('sensitive values never reach persistent storage APIs from UI code', async () => {
  for (const f of await walk(path.join(SRC, 'popup'))) {
    if (!f.endsWith('.js')) continue;
    const text = await readFile(f, 'utf8');
    for (const m of text.matchAll(/storage\.local\.set\(([^)]*)\)/g)) {
      assert.doesNotMatch(m[1], /password|token|vaultKey|secret/i, `${path.relative(ROOT, f)}: ${m[0]}`);
    }
    assert.doesNotMatch(text, /localStorage|sessionStorage|indexedDB/, `${path.relative(ROOT, f)} uses web storage`);
  }
  const core = await readFile(path.join(SRC, 'background', 'core.js'), 'utf8');
  assert.match(core, /session\.set\(\{ vaultKey: b64/, 'vault key goes to session storage');
  assert.doesNotMatch(core, /local\.set\(\{[^}]*vaultKey/, 'vault key never goes to local storage');
});

test('popup HTML loads only local module scripts', async () => {
  for (const f of ['popup/popup.html', 'offscreen/offscreen.html']) {
    const html = await readFile(path.join(SRC, f), 'utf8');
    const scripts = [...html.matchAll(/<script\b([^>]*)>/g)].map((m) => m[1]);
    assert.ok(scripts.length >= 1);
    for (const s of scripts) assert.match(s, /type="module" src="[a-z-]+\.js"/, `${f}: ${s}`);
    assert.doesNotMatch(html, /https?:\/\//, `${f} references a remote URL`);
  }
});
