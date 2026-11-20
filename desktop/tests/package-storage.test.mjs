// Detection of Windows package (MSIX) file virtualization around the profile.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { packageRedirectingWrites, packageHolding, packageDisplayName } from '../build/app/main/package-storage.js';

function fakeLocalAppData(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'lw-pkg-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, 'Packages', 'Other.App_8wekyb3d8bbwe', 'LocalCache', 'Local'), { recursive: true });
  return root;
}

test('package storage: a write that stays in the user folder', (t) => {
  const local = fakeLocalAppData(t);
  const profile = path.join(local, 'Ludworks Browser', 'User Data');
  assert.equal(packageRedirectingWrites(profile, local), null);
  assert.deepEqual(readdirSync(path.join(local, 'Ludworks Browser')), [], 'probe removed');
});

test('package storage: a write redirected into another app package', (t) => {
  const local = fakeLocalAppData(t);
  const profile = path.join(local, 'Ludworks Browser', 'User Data');
  // What Windows does inside a package context: the new file shows up in that package's LocalCache.
  const hidden = path.join(local, 'Packages', 'Claude_pzs8sxrjxfjjc', 'LocalCache', 'Local', 'Ludworks Browser');
  mkdirSync(hidden, { recursive: true });
  const twin = path.join(hidden, `.package-probe-${process.pid}`);
  mkdirSync(twin); // stands in for the redirected probe file
  assert.equal(packageRedirectingWrites(profile, local), 'Claude_pzs8sxrjxfjjc');
  assert.ok(!existsSync(path.join(local, 'Ludworks Browser', `.package-probe-${process.pid}`)), 'probe removed');
  assert.equal(packageHolding(local, path.join('Ludworks Browser', 'nothing-here')), null);
});

test('package storage: LOCALAPPDATA set below the real AppData\\Local', (t) => {
  const real = fakeLocalAppData(t);
  const env = path.join(real, 'elsewhere');
  const profile = path.join(env, 'Ludworks Browser', 'User Data');
  const twin = path.join(real, 'Packages', 'Claude_pzs8sxrjxfjjc', 'LocalCache', 'Local', 'elsewhere', 'Ludworks Browser', `.package-probe-${process.pid}`);
  mkdirSync(twin, { recursive: true });
  assert.equal(packageRedirectingWrites(profile, [env, real]), 'Claude_pzs8sxrjxfjjc');
  assert.equal(packageRedirectingWrites(profile, env), null, 'the environment folder alone has no Packages');
});

test('package storage: profiles outside %LOCALAPPDATA% and missing Packages', (t) => {
  const local = fakeLocalAppData(t);
  const elsewhere = mkdtempSync(path.join(os.tmpdir(), 'lw-prof-'));
  t.after(() => rmSync(elsewhere, { recursive: true, force: true }));
  assert.equal(packageRedirectingWrites(path.join(elsewhere, 'User Data'), local), null);
  assert.deepEqual(readdirSync(elsewhere), [], 'nothing written outside %LOCALAPPDATA%');
  assert.equal(packageHolding(path.join(local, 'no-such-dir'), 'x'), null);
});

test('package storage: display name drops the publisher id', () => {
  assert.equal(packageDisplayName('Claude_pzs8sxrjxfjjc'), 'Claude');
  assert.equal(packageDisplayName('Microsoft.WindowsTerminal_8wekyb3d8bbwe'), 'Microsoft.WindowsTerminal');
  assert.equal(packageDisplayName('NoPublisherSuffix'), 'NoPublisherSuffix');
});
