import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

import { build, scanOutput } from '../build.mjs';
import { validateManifest, deepMerge, buildManifest } from '../scripts/lib/manifest.mjs';
import { readZip } from '../scripts/lib/zip.mjs';
import { bundle } from '../scripts/lib/bundle.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const SRC = path.join(ROOT, 'src');

const exists = async (p) => {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
};
const pythonOk = spawnSync('python3', ['-I', '-c', 'import zipfile'], { encoding: 'utf8' }).status === 0;

let out;
let results;
test.before(async () => {
  out = await mkdtemp(path.join(os.tmpdir(), 'lw-build-'));
  results = await build({ outDir: out });
});
test.after(async () => {
  if (out) await rm(out, { recursive: true, force: true });
});

test('builds both browsers with valid manifests', async () => {
  assert.deepEqual(results.map((r) => r.target), ['chrome', 'firefox']);
  for (const r of results) {
    assert.deepEqual(await validateManifest(r.manifest, r.target, { dir: r.dir }), [], r.target);
    const onDisk = JSON.parse(await readFile(path.join(r.dir, 'manifest.json'), 'utf8'));
    assert.deepEqual(onDisk, r.manifest);
    assert.equal(onDisk.version, JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8')).version);
    const info = await readFile(path.join(r.dir, 'lib', 'build-info.js'), 'utf8');
    assert.match(info, new RegExp(`"browser":"${r.target}"`));
  }
});

test('Chrome build: service worker + offscreen; Firefox build: event page + gecko settings', async () => {
  const [chrome, firefox] = results;
  assert.equal(chrome.manifest.background.service_worker, 'background/main.js');
  assert.equal(chrome.manifest.background.type, 'module');
  assert.ok(chrome.manifest.permissions.includes('offscreen'));
  assert.ok(!chrome.manifest.permissions.includes('webRequest'));
  assert.equal(chrome.manifest.browser_specific_settings, undefined);
  assert.ok(await exists(path.join(chrome.dir, 'offscreen', 'offscreen.html')));

  assert.deepEqual(firefox.manifest.background, { scripts: ['background/main.js'], type: 'module' });
  assert.equal(firefox.manifest.browser_specific_settings.gecko.id, 'passwords@ludworks.app');
  assert.equal(firefox.manifest.browser_specific_settings.gecko.strict_min_version, '128.0');
  assert.ok(!firefox.manifest.permissions.includes('offscreen'));
  assert.ok(firefox.manifest.permissions.includes('webRequestBlocking'));
  assert.equal(await exists(path.join(firefox.dir, 'offscreen')), false, 'offscreen document is Chrome-only');

  for (const r of results) {
    assert.equal(r.manifest.host_permissions, undefined, 'no install-time host access');
    assert.deepEqual(r.manifest.optional_host_permissions, ['https://*/*', 'http://localhost/*', 'http://127.0.0.1/*']);
    assert.equal(r.manifest.content_scripts, undefined);
    assert.match(r.manifest.content_security_policy.extension_pages, /script-src 'self';/);
    assert.match(r.manifest.content_security_policy.extension_pages, /object-src 'none'/);
    assert.equal(await exists(path.join(r.dir, 'manifest.base.json')), false);
    assert.equal(await exists(path.join(r.dir, 'manifest.chrome.json')), false);
  }
});

test('content scripts are self-contained classic scripts', async () => {
  for (const r of results) {
    for (const f of ['content/fill.js', 'content/capture.js']) {
      const code = await readFile(path.join(r.dir, f), 'utf8');
      assert.doesNotThrow(() => new vm.Script(code, { filename: f }));
      assert.doesNotMatch(code, /^\s*(import|export)\b/m, `${f} must not contain module syntax`);
      assert.match(code, /^\/\/ Ludworks Passwords/);
    }
  }
});

test('output passes the forbidden-construct scan', async () => {
  for (const r of results) assert.deepEqual(await scanOutput(r.dir), []);
});

test('zip packages are valid, complete and reproducible', async (t) => {
  for (const r of results) {
    const buf = await readFile(r.zipPath);
    const entries = readZip(buf);
    const names = entries.map((e) => e.name);
    assert.ok(names.includes('manifest.json'));
    assert.ok(names.includes('icons/icon-128.png'));
    assert.deepEqual(names, [...names].sort(), 'entries sorted');
    const manifest = JSON.parse(entries.find((e) => e.name === 'manifest.json').data.toString('utf8'));
    assert.equal(manifest.manifest_version, 3);
    if (pythonOk) {
      const p = spawnSync('python3', ['-I', '-m', 'zipfile', '-t', r.zipPath], { encoding: 'utf8' });
      assert.equal(p.status, 0, p.stderr || p.stdout);
    } else {
      t.diagnostic('python3 not available; skipped zipfile -t');
    }
  }
  const again = await mkdtemp(path.join(os.tmpdir(), 'lw-build2-'));
  try {
    const second = await build({ outDir: again });
    for (let i = 0; i < results.length; i++) {
      assert.ok((await readFile(results[i].zipPath)).equals(await readFile(second[i].zipPath)), `${results[i].target} zip is byte-identical`);
    }
  } finally {
    await rm(again, { recursive: true, force: true });
  }
});

test('validateManifest rejects risky changes', async () => {
  const chrome = await buildManifest(SRC, 'chrome', '1.0.0');
  const firefox = await buildManifest(SRC, 'firefox', '1.0.0');
  assert.deepEqual(await validateManifest(chrome, 'chrome'), []);
  assert.deepEqual(await validateManifest(firefox, 'firefox'), []);
  const bad = async (m, target, re) => {
    const errs = await validateManifest(m, target);
    assert.ok(errs.some((e) => re.test(e)), `${re} not in ${JSON.stringify(errs)}`);
  };
  await bad({ ...chrome, permissions: [...chrome.permissions, 'tabs'] }, 'chrome', /tabs/);
  await bad({ ...chrome, permissions: [...chrome.permissions, 'cookies'] }, 'chrome', /not allowed/);
  await bad({ ...chrome, host_permissions: ['<all_urls>'] }, 'chrome', /host_permissions/);
  await bad({ ...chrome, content_scripts: [{ matches: ['<all_urls>'], js: ['x.js'] }] }, 'chrome', /content_scripts/);
  await bad({ ...chrome, web_accessible_resources: [] }, 'chrome', /web_accessible_resources/);
  await bad({ ...chrome, content_security_policy: { extension_pages: "script-src 'self' 'unsafe-eval'; object-src 'none'" } }, 'chrome', /script-src|unsafe/);
  await bad({ ...chrome, content_security_policy: { extension_pages: "script-src 'self' https://cdn.example; object-src 'none'" } }, 'chrome', /script-src/);
  await bad({ ...chrome, background: { scripts: ['b.js'] } }, 'chrome', /service_worker/);
  await bad({ ...chrome, manifest_version: 2 }, 'chrome', /manifest_version/);
  await bad({ ...chrome, version: '1.0-beta' }, 'chrome', /version/);
  await bad({ ...firefox, browser_specific_settings: { gecko: { id: 'x@y', strict_min_version: '128.0' } } }, 'firefox', /gecko.id/);
  await bad({ ...firefox, background: { service_worker: 'b.js', type: 'module' } }, 'firefox', /background.scripts/);
  await bad({ ...firefox, permissions: [...firefox.permissions, 'offscreen'] }, 'firefox', /offscreen/);
  await bad({ ...firefox, optional_host_permissions: ['<all_urls>'] }, 'firefox', /optional_host_permissions/);
});

test('deepMerge semantics', () => {
  assert.deepEqual(deepMerge({ a: [1, 2], b: { c: 1, d: 2 }, e: 1 }, { a: [2, 3], b: { d: 3 }, e: null, f: 'x' }), { a: [1, 2, 3], b: { c: 1, d: 3 }, f: 'x' });
});

test('bundler: aliases, rejects unsupported syntax, missing exports and cycles', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lw-bundle-'));
  try {
    await mkdir(path.join(dir, 'lib'));
    await writeFile(path.join(dir, 'lib', 'a.js'), "export const A = 1;\nexport function twice(x) { return x * 2; }\nconst hidden = 3;\nexport { hidden as visible };\n");
    await writeFile(path.join(dir, 'entry.js'), "import { A, twice as dbl, visible } from './lib/a.js';\nglobalThis.result = dbl(A) + visible;\n");
    const code = await bundle(path.join(dir, 'entry.js'), { root: dir });
    const ctx = vm.createContext({});
    vm.runInContext(code, ctx);
    assert.equal(ctx.result, 5);

    const cases = {
      'default.js': "import x from './lib/a.js';\n",
      'namespace.js': "import * as ns from './lib/a.js';\n",
      'dynamic.js': "const m = import('./lib/a.js');\n",
      'missing.js': "import { nope } from './lib/a.js';\n",
      'reexport.js': "export * from './lib/a.js';\n",
    };
    for (const [name, src] of Object.entries(cases)) {
      await writeFile(path.join(dir, name), src);
      await assert.rejects(bundle(path.join(dir, name), { root: dir }), Error, name);
    }
    await writeFile(path.join(dir, 'c1.js'), "import { b } from './c2.js';\nexport const a = 1;\n");
    await writeFile(path.join(dir, 'c2.js'), "import { a } from './c1.js';\nexport const b = 2;\n");
    await assert.rejects(bundle(path.join(dir, 'c1.js'), { root: dir }), /cycle/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
