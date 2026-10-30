// Bookmarks/history/tabs/settings sync against a Ludworks server without the browser-sync module
// (src/main/account/account.js): the warning, waiting before asking that server again, "Sync now" and
// signing out asking at once, and the warning clearing once the server has the module. Electron, the
// vault and the record sync are fakes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// account.js runs in Electron's main process: give it just enough of the 'electron' module.
const ELECTRON = `
export const app = { on() {} };
export const powerMonitor = { on() {}, getSystemIdleTime: () => 0 };
export const safeStorage = { isEncryptionAvailable: () => false };
export const session = { fromPartition: () => ({ setCertificateVerifyProc() {}, setPermissionRequestHandler() {} }) };
`;
registerHooks({
  resolve: (spec, ctx, next) => (spec === 'electron' ? { url: `data:text/javascript,${encodeURIComponent(ELECTRON)}`, shortCircuit: true } : next(spec, ctx)),
});
const { Account } = await import('../build/app/main/account/account.js');
const { ApiError } = await import('../build/app/lib/api.js');

const MINUTE = 60 * 1000;
const SIGNED_IN = { serverUrl: 'https://nas.example:8444', token: 'device-token', user: { id: '1', username: 'pat', display_name: '' } };

/** A signed-in, unlocked account; its server answers browser sync with `server.status` and counts `asked`. */
function signedIn(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'lw-account-'));
  const meta = new Map();
  const browser = {
    profileDir: dir,
    db: { getMeta: (k, d) => (meta.has(k) ? meta.get(k) : d), setMeta: (k, v) => meta.set(k, v) },
    prefs: { get: () => false },
    broadcastShared() {},
    forEachWindow() {},
    allTabs: () => [],
  };
  const account = new Account(browser);
  const server = { status: 404, asked: 0 };
  account.acc = { ...SIGNED_IN };
  account.vault = { sync: async () => {}, isUnlocked: () => true, warnings: [], meta: { initialized: true }, cache: null, wipe() {}, lock() {} };
  account.sync = {
    ready: () => true,
    clearKey() {},
    dropOwnTabs: async () => {},
    sync: async () => {
      server.asked++;
      if (server.status === 404) throw new ApiError({ status: 404, code: 'not_found', message: 'Not found' });
    },
  };
  t.after(() => {
    account.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  return { account, server };
}

test('a server without browser sync: warns, keeps syncing the vault and waits before asking again', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-29T20:00:00Z') });
  const { account, server } = signedIn(t);
  const first = await account.syncNow();
  assert.equal(server.asked, 1);
  assert.match(first.warning, /cannot sync bookmarks, history, tabs and settings/);
  assert.equal(first.error, null);
  assert.ok(first.lastSyncAt, 'the vault part still synced');

  t.mock.timers.tick(5 * MINUTE); // background syncs
  await account.syncNow();
  t.mock.timers.tick(20 * MINUTE);
  await account.syncNow();
  assert.equal(server.asked, 1, 'not asked again within half an hour');

  server.status = 200; // the server was updated
  t.mock.timers.tick(5 * MINUTE);
  const later = await account.syncNow();
  assert.equal(server.asked, 2, 'asked again after half an hour');
  assert.equal(later.warning, null);
});

test('"Sync now" asks again at once, and the warning clears once the server syncs', async (t) => {
  const { account, server } = signedIn(t);
  await account.syncNow();
  await account.syncNow();
  assert.equal(server.asked, 1);
  assert.match((await account.command('account.sync', {}, null)).warning, /update the server/);
  assert.equal(server.asked, 2);

  server.status = 200;
  const synced = await account.command('account.sync', {}, null);
  assert.equal(server.asked, 3);
  assert.equal(synced.warning, null);
  await account.syncNow();
  assert.equal(server.asked, 4, 'a server that syncs is asked on every sync');
});

test('a vault warning is left alone when browser sync starts working', async (t) => {
  const { account, server } = signedIn(t);
  await account.syncNow();
  account.status.warning = 'Some vault items could not be read.';
  server.status = 200;
  assert.equal((await account.command('account.sync', {}, null)).warning, 'Some vault items could not be read.');
});

test('signing out forgets the old server: the next sign-in is asked right away', async (t) => {
  const { account, server } = signedIn(t);
  await account.syncNow();
  assert.ok(account.summary().warning);
  await account.signOut();
  assert.equal(account.summary().warning, null);

  account.acc = { ...SIGNED_IN }; // signed in again, to the updated server
  server.status = 200;
  const s = await account.syncNow();
  assert.equal(server.asked, 2);
  assert.equal(s.warning, null);
});
