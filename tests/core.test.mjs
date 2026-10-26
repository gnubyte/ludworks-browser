import test from 'node:test';
import assert from 'node:assert/strict';

import { createCore } from '../src/background/core.js';
import { createCertObserver } from '../src/background/certpin.js';
import * as vc from '../src/lib/vault-crypto.js';
import { createStorage, createMockServer } from './helpers/fakes.mjs';

const SERVER = 'https://nas.example.com';
const MASTER = 'correct horse battery staple';

function setup({ fingerprint, now } = {}) {
  const server = createMockServer(fingerprint === undefined ? {} : { fingerprint });
  const storage = createStorage();
  const events = [];
  let clock = Date.UTC(2026, 9, 26, 12);
  const core = createCore({
    storage,
    fetchImpl: server.fetch,
    browserName: 'chrome',
    version: '1.0.0',
    now: now || (() => clock),
    emit: (e) => events.push(e),
  });
  return { server, storage, core, events, tick: (ms) => { clock += ms; }, clock: () => clock };
}

async function signedIn(opts = {}) {
  const env = setup(opts);
  const probe = await env.core.probeServer(SERVER);
  if (probe.fingerprint) await env.core.trustServer(SERVER, probe.fingerprint);
  await env.core.login({ serverUrl: SERVER, username: 'alice', password: 'alice-login-pw' });
  return env;
}

async function unlocked(opts = {}) {
  const env = setup(opts);
  env.vaultKey = await env.server.admin.initVault('alice', MASTER);
  env.githubId = await env.server.admin.putItem('alice', env.vaultKey, {
    type: 'login',
    name: 'GitHub',
    favorite: true,
    login: { username: 'alice@example.com', password: 'gh-secret-1', uris: [{ uri: 'https://github.com/login', match: 'domain' }], totp: 'JBSWY3DPEHPK3PXP' },
    x_custom: { keep: true },
  });
  env.noteId = await env.server.admin.putItem('alice', env.vaultKey, { type: 'note', name: 'Wi-Fi', notes: 'key: hunter2' });
  const probe = await env.core.probeServer(SERVER);
  await env.core.trustServer(SERVER, probe.fingerprint);
  await env.core.login({ serverUrl: SERVER, username: 'alice', password: 'alice-login-pw' });
  await env.core.unlock(MASTER);
  return env;
}

test('first connect requires confirming the server fingerprint (TOFU)', async () => {
  const { core, server } = setup();
  const probe = await core.probeServer('nas.example.com/');
  assert.equal(probe.serverUrl, SERVER);
  assert.equal(probe.pinStatus, 'new');
  assert.equal(probe.fingerprint, server.FP);
  assert.equal(probe.fingerprintSource, 'server');
  assert.equal(probe.serverName, 'Test NAS');
  await assert.rejects(core.login({ serverUrl: SERVER, username: 'alice', password: 'alice-login-pw' }), (e) => e.code === 'server_not_trusted' && e.details.fingerprint === server.FP);
  assert.equal(server.state.requests.filter((r) => r.path.endsWith('/auth/login')).length, 0, 'credentials never sent before trust');
  await assert.rejects(core.trustServer(SERVER, 'cd'.repeat(32)), (e) => e.code === 'fingerprint_mismatch');
  const st = await core.trustServer(SERVER, server.FP.toUpperCase().match(/../g).join(':'));
  assert.equal(st.phase, 'logged_out');
  assert.equal((await core.probeServer(SERVER)).pinStatus, 'trusted');
});

test('servers without a reported fingerprint (http://localhost, TLS proxy) need no pin', async () => {
  const { core } = setup({ fingerprint: null });
  const probe = await core.probeServer('http://localhost:18090');
  assert.equal(probe.pinStatus, 'none');
  const st = await core.login({ serverUrl: 'http://localhost:18090', username: 'alice', password: 'alice-login-pw' });
  assert.equal(st.phase, 'uninitialized');
  assert.equal(st.pin, null);
});

test('login: token mode, device name, TOTP step, nothing secret persisted', async () => {
  const { core, server, storage } = setup();
  await core.trustServer(SERVER, server.FP);
  await assert.rejects(core.login({ serverUrl: SERVER, username: 'alice', password: 'wrong' }), (e) => e.code === 'invalid_credentials');
  await assert.rejects(core.login({ serverUrl: SERVER, username: 'bob', password: 'bob-login-pw' }), (e) => e.code === 'totp_required');
  await assert.rejects(core.login({ serverUrl: SERVER, username: 'bob', password: 'bob-login-pw', totpCode: '000000' }), (e) => e.code === 'invalid_credentials');
  const st = await core.login({ serverUrl: SERVER, username: 'bob', password: 'bob-login-pw', totpCode: '123 456' });
  assert.equal(st.phase, 'uninitialized');
  assert.equal(st.user.username, 'bob');
  const login = server.state.requests.filter((r) => r.path === '/api/v1/auth/login').pop();
  assert.equal(login.body.token_mode, true);
  assert.equal(login.body.device_name, 'Chrome extension');
  assert.equal(login.body.totp_code, '123456');
  const local = storage.local.dump();
  assert.ok(!local.includes('bob-login-pw'), 'login password must never be stored');
  assert.match(local, /"token":"lwp_/);
  assert.ok(!local.includes('lws_'), 'the full-scope session token is never stored');
  assert.equal(storage.session.dump(), '{}');
  // recovery code path
  const env2 = setup();
  await env2.core.trustServer(SERVER, env2.server.FP);
  const st2 = await env2.core.login({ serverUrl: SERVER, username: 'bob', password: 'bob-login-pw', recoveryCode: 'recovery-1' });
  assert.equal(st2.phase, 'uninitialized');
});

test('setup_required servers are refused', async () => {
  const { core, server } = setup();
  server.state.setupRequired = true;
  await assert.rejects(core.login({ serverUrl: SERVER, username: 'alice', password: 'x' }), (e) => e.code === 'setup_required');
});

test('unlock: wrong password, then vault key only in session storage', async () => {
  const env = setup();
  env.vaultKey = await env.server.admin.initVault('alice', MASTER);
  await env.server.admin.putItem('alice', env.vaultKey, { type: 'login', name: 'Bank', login: { username: 'me', password: 'bank-pw-123', uris: [] } });
  await env.core.trustServer(SERVER, env.server.FP);
  const st = await env.core.login({ serverUrl: SERVER, username: 'alice', password: 'alice-login-pw' });
  assert.equal(st.phase, 'locked');
  await assert.rejects(env.core.unlock('nope'), (e) => e.code === 'bad_password');
  assert.equal((await env.core.getState()).phase, 'locked');
  const after = await env.core.unlock(MASTER);
  assert.equal(after.phase, 'unlocked');
  const keyB64 = vc.b64encode(env.vaultKey);
  assert.equal((await env.storage.session.get('vaultKey')).vaultKey, keyB64);
  const local = env.storage.local.dump();
  assert.ok(!local.includes(keyB64), 'vault key must not be in local storage');
  assert.ok(!local.includes('bank-pw-123') && !local.includes('"Bank"'), 'no plaintext items in local storage');
  assert.ok(!local.includes(MASTER) && !env.storage.session.dump().includes(MASTER), 'master password never stored');
  assert.equal(Object.keys(JSON.parse(local).vaultCache.items).length, 1, 'encrypted cache persisted');
});

test('list, match, get, TOTP-aware fill resolution', async () => {
  const { core, githubId, noteId } = await unlocked();
  const list = await core.listItems({ url: 'https://github.com/session' });
  assert.deepEqual(list.items.map((i) => i.name), ['GitHub', 'Wi-Fi']);
  assert.deepEqual(list.matches, [githubId]);
  const gh = list.items.find((i) => i.id === githubId);
  assert.equal(gh.subtitle, 'alice@example.com');
  assert.equal(gh.hasTotp, true);
  assert.equal(gh.favorite, true);
  assert.ok(!JSON.stringify(list).includes('gh-secret-1'), 'list summaries never include secrets');
  const item = await core.getItem(githubId);
  assert.equal(item.data.login.password, 'gh-secret-1');
  assert.deepEqual(item.data.x_custom, { keep: true });
  const creds = await core.resolveFill(githubId, 'https://github.com/session');
  assert.equal(creds.username, 'alice@example.com');
  assert.match(creds.totp, /^\d{6}$/);
  await assert.rejects(core.resolveFill(githubId, 'https://github.com.evil.net/'), (e) => e.code === 'uri_mismatch');
  await assert.rejects(core.resolveFill(githubId, 'chrome://settings'), (e) => e.code === 'uri_mismatch');
  await assert.rejects(core.resolveFill(noteId, 'https://github.com/'), (e) => e.code === 'not_login');
  assert.equal(await core.bestMatchFor('https://github.com/'), githubId);
  assert.equal(await core.bestMatchFor('https://gitlab.com/'), null);
});

test('a login saved for another host of the same site: listed with that host, filled only after confirmation', async () => {
  const { core, githubId } = await unlocked();
  const list = await core.listItems({ url: 'https://gist.github.com/' });
  assert.deepEqual(list.matches, [githubId]);
  assert.deepEqual(list.otherHost, { [githubId]: ['github.com'] });
  assert.deepEqual((await core.listItems({ url: 'https://github.com/x' })).otherHost, {}, 'same host: no hint');
  // the fill shortcut never fills it without UI
  assert.equal(await core.bestMatchFor('https://gist.github.com/'), null);
  await assert.rejects(core.resolveFill(githubId, 'https://gist.github.com/'), (e) => e.code === 'other_host' && e.details.savedFor[0] === 'github.com' && e.details.pageHost === 'gist.github.com');
  const creds = await core.resolveFill(githubId, 'https://gist.github.com/', { allowOtherHost: true });
  assert.equal(creds.password, 'gh-secret-1');
});

test('multi-tenant suffixes (PSL): a sibling tenant never gets the login, the shortcut, or an update', async () => {
  const env = await unlocked();
  const { core, server, vaultKey } = env;
  const victimId = await server.admin.putItem('alice', vaultKey, {
    type: 'login', name: 'My project', login: { username: 'alice', password: 'victim-pw', uris: [{ uri: 'https://victim.github.io', match: 'domain' }], totp: '' },
  });
  const nasId = await server.admin.putItem('alice', vaultKey, {
    type: 'login', name: 'My NAS', login: { username: 'alice', password: 'NAS-S3cret!', uris: [{ uri: 'https://nas.duckdns.org', match: 'domain' }] },
  });
  await core.sync();
  for (const [page, id] of [['https://attacker.github.io/phish', victimId], ['https://evil.duckdns.org/login', nasId], ['https://github.io/', victimId]]) {
    assert.deepEqual((await core.listItems({ url: page })).matches, [], page);
    assert.equal(await core.bestMatchFor(page), null, page);
    await assert.rejects(core.resolveFill(id, page, { allowOtherHost: true }), (e) => e.code === 'uri_mismatch', page);
  }
  assert.equal(await core.bestMatchFor('https://victim.github.io/admin'), victimId);
  // offer to save from the sibling tenant: never an "update" of the victim's login
  await core.updateSettings({ saveLogins: true });
  await core.captureSubmitted({ tabId: 9, pageUrl: 'https://evil.duckdns.org/login', username: 'alice', password: 'attacker-chosen' });
  const p = await core.capturePending({ tabId: 9 });
  assert.equal(p.kind, 'save');
  assert.equal(p.host, 'evil.duckdns.org');
  assert.equal(p.domain, 'evil.duckdns.org');
  assert.deepEqual(await core.captureDecision({ tabId: 9, id: p.id, decision: 'update' }), { done: false });
  assert.equal((await core.getItem(nasId)).data.login.password, 'NAS-S3cret!');
});

test('create, update (password history + unknown keys kept), conflict, delete', async () => {
  const { core, server, githubId, vaultKey } = await unlocked();
  const created = await core.saveItem({ data: { type: 'login', name: 'Shop', login: { username: 'u', password: 'p1', uris: [{ uri: 'https://shop.example', match: 'domain' }] } } });
  assert.match(created.id, /^[0-9a-f-]{36}$/);
  const raw = server.admin.rawItems('alice').get(created.id);
  assert.ok(raw.data.startsWith('v1.'), 'server receives only ciphertext');
  const plain = await vc.decryptItem(vaultKey, created.id, raw.data);
  assert.equal(plain.name, 'Shop');
  assert.ok(plain.created_at && plain.updated_at);

  const gh = await core.getItem(githubId);
  gh.data.login.password = 'gh-secret-2';
  await core.saveItem({ id: githubId, data: gh.data, baseRevision: gh.revision });
  const updated = await core.getItem(githubId);
  assert.equal(updated.data.login.password, 'gh-secret-2');
  assert.equal(updated.data.password_history[0].password, 'gh-secret-1');
  assert.deepEqual(updated.data.x_custom, { keep: true });
  assert.equal(updated.revision, 2);

  // Another device changes the item; our stale edit must be refused and the cache refreshed.
  const raw2 = server.admin.rawItems('alice').get(githubId);
  const other = await vc.decryptItem(vaultKey, githubId, raw2.data);
  other.name = 'GitHub (edited elsewhere)';
  raw2.data = await vc.encryptItem(vaultKey, githubId, other);
  raw2.revision = 3;
  const stale = await core.getItem(githubId);
  stale.data.notes = 'my edit';
  await assert.rejects(core.saveItem({ id: githubId, data: stale.data, baseRevision: 2 }), (e) => e.code === 'conflict');
  assert.equal((await core.getItem(githubId)).data.name, 'GitHub (edited elsewhere)');

  await core.deleteItem(created.id);
  assert.equal((await core.listItems()).items.some((i) => i.id === created.id), false);
  assert.equal(server.admin.rawItems('alice').has(created.id), false);
  await assert.rejects(core.saveItem({ data: { type: 'bogus', name: 'x' } }), (e) => e.code === 'validation_failed');
  await assert.rejects(core.saveItem({ data: { type: 'login', name: '  ' } }), (e) => e.code === 'validation_failed');
});

test('incremental sync applies remote additions and deletions', async () => {
  const { core, server, vaultKey, noteId } = await unlocked();
  const newId = await server.admin.putItem('alice', vaultKey, { type: 'note', name: 'From phone', notes: '' });
  server.admin.deleteItem('alice', noteId);
  await core.sync();
  const syncs = server.state.requests.filter((r) => r.path === '/api/v1/vault/sync');
  assert.ok(syncs.length >= 2);
  assert.match(syncs[syncs.length - 1].search, /since=/, 'second sync is incremental');
  const names = (await core.listItems()).items.map((i) => i.name);
  assert.deepEqual(names.sort(), ['From phone', 'GitHub']);
  assert.ok(newId);
});

test('vault re-keyed or re-created on another device: the session key is dropped, never used to encrypt', async () => {
  // master password changed elsewhere (same vault key, new wrapped_key) → lock, unlock with the new one
  const env = await unlocked();
  const rewrapped = await vc.rewrapVaultKey(env.vaultKey, 'new master password');
  env.server.state.vaults.set('alice', rewrapped);
  await env.core.sync();
  assert.equal((await env.core.getState()).phase, 'locked');
  assert.ok(env.events.includes('locked'));
  assert.equal((await env.storage.session.get('vaultKeyFor')).vaultKeyFor, undefined);
  await assert.rejects(env.core.unlock(MASTER), (e) => e.code === 'bad_password');
  assert.equal((await env.core.unlock('new master password')).phase, 'unlocked');
  assert.equal((await env.core.listItems()).undecryptable, 0);

  // vault reset + re-created with a NEW vault key while this device is unlocked: a save must not reach the
  // server encrypted under the old key (other clients could never read it)
  const fresh = await env.server.admin.initVault('alice', 'second vault');
  const posts = () => env.server.state.requests.filter((r) => r.method === 'POST' && r.path === '/api/v1/vault/items').length;
  const before = posts();
  await assert.rejects(env.core.saveItem({ data: { type: 'note', name: 'stale key', notes: '' } }), (e) => e.code === 'locked');
  assert.equal(posts(), before, 'nothing was uploaded');
  assert.equal((await env.core.getState()).phase, 'locked');
  assert.equal((await env.core.unlock('second vault')).phase, 'unlocked');
  const created = await env.core.saveItem({ data: { type: 'note', name: 'new key', notes: '' } });
  const raw = env.server.admin.rawItems('alice').get(created.id);
  assert.equal((await vc.decryptItem(fresh, created.id, raw.data)).name, 'new key', 'encrypted under the new vault key');

  // vault reset (not re-created): locked, encrypted cache dropped, phase "uninitialized"
  env.server.state.vaults.delete('alice');
  await env.core.sync();
  const st = await env.core.getState();
  assert.equal(st.phase, 'uninitialized');
  assert.equal(st.itemCount, 0);
  assert.equal((await env.storage.session.get('vaultKey')).vaultKey, undefined);
});

test('records swapped by a malicious server fail to decrypt and are hidden', async () => {
  const { core, server, githubId, noteId } = await unlocked();
  const items = server.admin.rawItems('alice');
  const a = items.get(githubId);
  const b = items.get(noteId);
  [a.data, b.data] = [b.data, a.data];
  a._seq = b._seq = 999999;
  await core.sync();
  const list = await core.listItems();
  assert.equal(list.items.length, 0);
  assert.equal(list.undecryptable, 2);
  await assert.rejects(core.getItem(githubId), (e) => e.code === 'decrypt_failed');
});

test('lock, offline unlock from the encrypted cache', async () => {
  const { core, server, storage } = await unlocked();
  const st = await core.lock();
  assert.equal(st.phase, 'locked');
  assert.equal((await storage.session.get('vaultKey')).vaultKey, undefined);
  await assert.rejects(core.listItems(), (e) => e.code === 'locked');
  server.state.online = false;
  const st2 = await core.unlock(MASTER);
  assert.equal(st2.phase, 'unlocked');
  assert.equal((await core.listItems()).items.length, 2);
  await assert.rejects(core.sync(), (e) => e.code === 'network_error');
});

test('a revoked device session wipes local account data', async () => {
  const { core, server, storage } = await unlocked();
  server.state.tokens.clear();
  await assert.rejects(core.sync(), (e) => e.code === 'session_expired');
  const st = await core.getState();
  assert.equal(st.phase, 'logged_out');
  const local = JSON.parse(storage.local.dump());
  assert.equal(local.account, undefined);
  assert.equal(local.vaultCache, undefined);
  assert.equal(storage.session.dump(), '{}');
  assert.ok(local.pins, 'pins survive so the next login is still verified');
});

test('certificate change is detected and must be re-trusted', async () => {
  const { core, server } = await unlocked();
  const newFp = 'cd'.repeat(32);
  server.state.fingerprint = newFp;
  await assert.rejects(core.sync(), (e) => e.code === 'certificate_changed');
  const st = await core.getState();
  assert.equal(st.phase, 'cert_changed');
  assert.equal(st.certProblem.presented, newFp);
  await assert.rejects(core.unlock(MASTER), (e) => e.code === 'certificate_changed');
  // until re-confirmed nothing authenticated reaches the server (no token, no ciphertext)
  const before = server.state.requests.length;
  await assert.rejects(core.saveItem({ data: { type: 'note', name: 'n', notes: '' } }), (e) => e.code === 'certificate_changed');
  const anyId = (await core.listItems()).items[0].id;
  await assert.rejects(core.deleteItem(anyId), (e) => e.code === 'certificate_changed');
  await assert.rejects(core.refreshVaultMeta(), (e) => e.code === 'certificate_changed');
  assert.equal(server.state.requests.length, before, 'no request was sent');
  await core.trustServer(SERVER, newFp);
  assert.equal((await core.getState()).phase, 'unlocked');
  await core.sync();
  // forgetting the pin returns to TOFU on the next probe
  await core.forgetPin();
  assert.equal((await core.probeServer(SERVER)).pinStatus, 'new');
});

const MITM_FP = 'ee'.repeat(32);

/**
 * Firefox, faithfully: the REAL certificate observer (certpin.js) on a fake webRequest API, and a network in
 * which (as in Firefox) the request — headers, Authorization, body — reaches whoever terminates TLS BEFORE
 * the blocking onHeadersReceived listener sees the certificate and can cancel the response. `net.presented`
 * is the certificate on the wire (MITM_FP = a browser-trusted interceptor that relays to the real server,
 * which keeps reporting its own fingerprint). `net.wire` logs what the TLS peer received.
 */
function firefoxEnv({ storage = createStorage(), server = createMockServer(), clock = { t: Date.UTC(2026, 9, 26, 12) } } = {}) {
  const net = { presented: server.FP, presentFor: null, wire: [] };
  const listeners = [];
  const infos = new Map();
  let rid = 0;
  const ext = {
    webRequest: {
      onHeadersReceived: {
        addListener: (fn, filter, extra) => listeners.push({ fn, filter, extra }),
        removeListener: (fn) => {
          const i = listeners.findIndex((l) => l.fn === fn);
          if (i >= 0) listeners.splice(i, 1);
        },
        hasListener: (fn) => listeners.some((l) => l.fn === fn),
      },
      getSecurityInfo: async (id) => infos.get(id),
    },
  };
  const now = () => clock.t;
  const certObserver = createCertObserver(ext, { now });
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    const requestId = `r${++rid}`;
    const presented = net.presentFor ? net.presentFor(u, init) : net.presented;
    net.wire.push({ presented, method: init.method || 'GET', path: u.pathname, auth: (init.headers && init.headers.Authorization) || null });
    infos.set(requestId, { state: 'secure', certificates: [{ fingerprint: { sha256: presented } }] });
    const res = await server.fetch(url, init); // delivered (an interceptor relays it to the real server)
    for (const l of [...listeners]) {
      if (!l.filter.urls.some((p) => p === `https://${u.hostname}/*`)) continue;
      const v = await l.fn({ requestId, url });
      if (v && v.cancel) throw new TypeError('NetworkError when attempting to fetch resource.');
    }
    return res;
  };
  const core = createCore({ storage, fetchImpl, browserName: 'firefox', certObserver, now });
  /** Requests carrying a token that reached a peer presenting `fp`. */
  const leaked = (fp = MITM_FP) => net.wire.filter((r) => r.presented === fp && r.auth);
  return { core, server, storage, net, clock, listeners, leaked, tick: (ms) => { clock.t += ms; } };
}

async function firefoxUnlocked(opts) {
  const env = firefoxEnv(opts);
  env.vaultKey = await env.server.admin.initVault('alice', MASTER);
  env.itemId = await env.server.admin.putItem('alice', env.vaultKey, { type: 'login', name: 'Bank', login: { username: 'me', password: 'bank-pw', uris: [{ uri: 'https://bank.example', match: 'domain' }] } });
  const probe = await env.core.probeServer(SERVER);
  assert.equal(probe.fingerprintSource, 'tls');
  await env.core.trustServer(SERVER, probe.fingerprint);
  await env.core.login({ serverUrl: SERVER, username: 'alice', password: 'alice-login-pw' });
  await env.core.unlock(MASTER);
  env.tick(60_000); // nothing verified recently
  return env;
}

test('Firefox pin mismatch on a cancelled response surfaces as certificate_changed (not a network error)', async () => {
  const env = await firefoxUnlocked();
  env.net.presented = MITM_FP;
  await assert.rejects(env.core.sync(), (e) => e.code === 'certificate_changed' && e.details.presented === MITM_FP);
  const st = await env.core.getState();
  assert.equal(st.phase, 'cert_changed');
  assert.equal(st.certProblem.presented, MITM_FP);
  assert.equal(st.certProblem.tokenExposed, false, 'sync probes first: nothing carrying the token went out');
  // logging out with an unresolved certificate problem wipes locally without sending the token
  const before = env.net.wire.length;
  env.net.presented = env.server.FP;
  const out = await env.core.logout();
  assert.equal(out.phase, 'logged_out');
  assert.equal(out.serverRevoked, false, 'the popup tells the user to revoke it from the web app');
  assert.equal(env.net.wire.length, before, 'nothing was sent');
});

test('Firefox: no token-bearing request reaches a browser-trusted interceptor (every path probes first)', async () => {
  const actions = {
    'items.delete': async (env) => env.core.deleteItem(env.itemId),
    'items.save': async (env) => env.core.saveItem({ data: { type: 'note', name: 'n', notes: '' } }),
    'offer-to-save Save': async (env) => {
      await env.core.updateSettings({ saveLogins: true });
      await env.core.captureSubmitted({ tabId: 3, pageUrl: 'https://shop.example/login', username: 'u', password: 'p' });
      const p = await env.core.capturePending({ tabId: 3 });
      return env.core.captureDecision({ tabId: 3, id: p.id, decision: 'save' });
    },
    'vault.sync while locked (refreshVaultMeta)': async (env) => {
      await env.core.lock();
      return env.core.refreshVaultMeta();
    },
    'sync': async (env) => env.core.sync(),
  };
  for (const [name, run] of Object.entries(actions)) {
    const env = await firefoxUnlocked();
    env.net.presented = MITM_FP;
    await assert.rejects(run(env), (e) => e.code === 'certificate_changed', name);
    assert.deepEqual(env.leaked(), [], `${name}: the token never reached the interceptor`);
    assert.equal((await env.core.getState()).phase, 'cert_changed', name);
  }
});

test('Firefox: logout right after an event-page restart arms the pin and probes before sending the token', async () => {
  const env = await firefoxUnlocked();
  env.net.presented = MITM_FP;
  // event page restarted: a new background with a fresh observer (no listener registered yet)
  const restarted = firefoxEnv({ storage: env.storage, server: env.server, clock: env.clock });
  restarted.net.presented = MITM_FP;
  assert.equal(restarted.listeners.length, 0);
  const out = await restarted.core.logout();
  assert.equal(out.serverRevoked, false);
  assert.deepEqual(restarted.leaked(), [], 'POST /auth/logout with the token never went to the interceptor');
  assert.equal(restarted.server.state.tokens.size, 1, 'token not revoked: the user is told to revoke it');

  // without interception the same path revokes the token (after an unauthenticated probe)
  const env2 = await firefoxUnlocked();
  const fresh = firefoxEnv({ storage: env2.storage, server: env2.server, clock: env2.clock });
  const out2 = await fresh.core.logout();
  assert.equal(out2.serverRevoked, true);
  assert.deepEqual(fresh.net.wire.map((r) => `${r.method} ${r.path} ${r.auth ? 'auth' : '-'}`), ['GET /api/v1/setup/status -', 'POST /api/v1/auth/logout auth']);
  assert.equal(env2.server.state.tokens.size, 0);
});

test('Firefox: a recent verified response skips the probe; a stale one does not', async () => {
  const env = await firefoxUnlocked();
  const start = env.net.wire.length;
  await env.core.deleteItem(env.itemId);
  await env.core.saveItem({ data: { type: 'note', name: 'n', notes: '' } });
  const seq = env.net.wire.slice(start).map((r) => `${r.method} ${r.path.replace(/[0-9a-f-]{36}/, ':id')} ${r.auth ? 'auth' : '-'}`);
  assert.deepEqual(seq, [
    'GET /api/v1/setup/status -', // stale: probe first
    'DELETE /api/v1/vault/items/:id auth',
    'GET /api/v1/vault auth', // within the window: no new probe
    'POST /api/v1/vault/items auth',
  ]);
});

test('Firefox: a mismatch found only after a token went out marks the token exposed; re-trusting rotates it', async () => {
  const env = await firefoxUnlocked();
  const exposed = (await env.storage.local.get('account')).account.token;
  // selective interceptor: lets the probe through, intercepts the next connection
  env.net.presentFor = (u) => (u.pathname.endsWith('/setup/status') ? env.server.FP : MITM_FP);
  await assert.rejects(env.core.deleteItem(env.itemId), (e) => e.code === 'certificate_changed' && e.details.tokenExposed === true);
  assert.equal(env.leaked().length, 1, 'the residual risk: detected only after that request went out');
  const st = await env.core.getState();
  assert.equal(st.phase, 'cert_changed');
  assert.equal(st.certProblem.tokenExposed, true);
  // no token is sent again until the user decides (at most unauthenticated probes)
  const n = env.net.wire.length;
  await assert.rejects(env.core.sync(), (e) => e.code === 'certificate_changed');
  await assert.rejects(env.core.saveItem({ data: { type: 'note', name: 'n', notes: '' } }), (e) => e.code === 'certificate_changed');
  assert.deepEqual(env.net.wire.slice(n).filter((r) => r.auth), []);
  // interception gone; the user re-confirms the original certificate: the exposed token is revoked and the
  // user has to sign in again (a new token)
  env.net.presentFor = null;
  const after = await env.core.trustServer(SERVER, env.server.FP);
  assert.equal(after.phase, 'logged_out');
  assert.equal(after.signedOutReason, 'token_exposed');
  assert.equal(env.server.state.tokens.has(exposed), false, 'exposed token revoked on the server');
});

test('Firefox: trusting a rotated certificate works although the pinned one no longer matches', async () => {
  const env = await firefoxUnlocked();
  env.net.presented = MITM_FP; // a legitimate renewal looks the same to the client
  env.server.state.fingerprint = MITM_FP;
  const probe = await env.core.probeServer(SERVER);
  assert.equal(probe.pinStatus, 'changed');
  assert.equal(probe.fingerprint, MITM_FP);
  await assert.rejects(env.core.sync(), (e) => e.code === 'certificate_changed');
  assert.equal((await env.core.trustServer(SERVER, MITM_FP)).phase, 'unlocked');
  env.tick(60_000);
  await env.core.sync();
  assert.equal((await env.core.getState()).pin.fingerprint, MITM_FP);
});

test('a forgotten pin must be confirmed again before anything is sent', async () => {
  const env = await firefoxUnlocked();
  await env.core.forgetPin();
  const n = env.net.wire.length;
  await assert.rejects(env.core.deleteItem(env.itemId), (e) => e.code === 'certificate_changed');
  assert.ok(env.net.wire.slice(n).every((r) => !r.auth), 'only the unauthenticated probe went out');
  const st = await env.core.getState();
  assert.equal(st.phase, 'cert_changed');
  assert.equal(st.certProblem.unpinned, true);
  assert.equal((await env.core.trustServer(SERVER, st.certProblem.presented)).phase, 'unlocked');
});

test('the stored token is vault-only; the full-scope login session is revoked at once', async () => {
  const { core, server, storage } = await signedIn();
  const acc = (await storage.local.get('account')).account;
  assert.match(acc.token, /^lwp_/);
  const info = server.state.tokenInfo.get(acc.token);
  assert.deepEqual(info.scopes, ['vault:read', 'vault:write']);
  assert.equal(info.name, 'Chrome extension');
  assert.equal(info.expiresInDays, 30, 'never longer than the login session would have lasted');
  assert.deepEqual([...server.state.tokenInfo.values()].map((t) => t.kind), ['pat'], 'no session left on the server');
  // what a stolen copy of it can do
  const api = (path, method = 'GET') => server.fetch(`${SERVER}/api/v1${path}`, { method, headers: { Authorization: `Bearer ${acc.token}` } });
  assert.equal((await api('/vault')).status, 200);
  assert.equal((await api('/admin/settings')).status, 403);
  assert.equal((await api('/files')).status, 403);
  assert.equal((await api('/me/tokens', 'POST')).status, 403);
  // logout revokes it
  assert.equal((await core.logout()).serverRevoked, true);
  assert.equal(server.state.tokens.size, 0);
});

test('token minting refused: no account is stored and the session is revoked', async () => {
  const env = setup();
  await env.core.trustServer(SERVER, env.server.FP);
  env.server.state.failTokenMint = { status: 409, code: 'conflict' };
  await assert.rejects(env.core.login({ serverUrl: SERVER, username: 'alice', password: 'alice-login-pw' }), (e) => e.code === 'token_failed');
  assert.equal((await env.storage.local.get('account')).account, undefined);
  assert.equal(env.server.state.tokens.size, 0, 'the full-scope session was revoked');
  assert.equal((await env.core.getState()).phase, 'logged_out');
});

test('an account from an older version (full-scope lws_ token) is upgraded to a vault-only token on next use', async () => {
  const env = await unlocked();
  const { core, server, storage } = env;
  // simulate the old storage: a `*` session token
  const legacy = 'lws_' + 'L'.repeat(43);
  server.state.tokens.set(legacy, 'alice');
  server.state.tokenInfo.set(legacy, { kind: 'session', scopes: ['*'], expiresAt: '2026-11-01T12:00:00Z' });
  const acc = (await storage.local.get('account')).account;
  server.state.tokens.delete(acc.token);
  await storage.local.set({ account: { ...acc, token: legacy, expiresAt: '2026-11-01T12:00:00Z' } });
  await core.sync();
  const next = (await storage.local.get('account')).account;
  assert.match(next.token, /^lwp_/);
  assert.deepEqual(server.state.tokenInfo.get(next.token).scopes, ['vault:read', 'vault:write']);
  assert.equal(server.state.tokenInfo.get(next.token).expiresInDays, 6, 'expires when the session would have');
  assert.equal(server.state.tokens.has(legacy), false, 'legacy session revoked');
});

test('logout revokes the token on the server and wipes local data', async () => {
  const { core, server, storage } = await unlocked();
  await core.updateSettings({ lockMinutes: 5 });
  const st = await core.logout();
  assert.equal(st.phase, 'logged_out');
  assert.equal(server.state.tokens.size, 0);
  assert.equal(server.state.requests.some((r) => r.path === '/api/v1/auth/logout'), true);
  const local = JSON.parse(storage.local.dump());
  assert.equal(local.account, undefined);
  assert.equal(local.settings.lockMinutes, 5);
  await core.clearAllData();
  assert.equal(storage.local.dump(), '{}');
});

test('auto-lock deadline follows activity and the configured timeout', async () => {
  const env = await unlocked();
  const { core } = env;
  await core.touch();
  let s = await core.autoLockStatus();
  assert.equal(s.due, false);
  assert.equal(s.deadline, env.clock() + 15 * 60000);
  env.tick(14 * 60000);
  assert.equal((await core.autoLockStatus()).due, false);
  env.tick(61000);
  assert.equal((await core.autoLockStatus()).due, true);
  await core.updateSettings({ lockMinutes: 60 });
  s = await core.autoLockStatus();
  assert.equal(s.due, false);
  await core.lock();
  assert.deepEqual(await core.autoLockStatus(), { due: false, deadline: null });
});

test('offer to save: new login, update, duplicates, never-for-site', async () => {
  const { core, storage, githubId } = await unlocked();
  const tab = 42;
  // feature disabled by default
  assert.deepEqual(await core.captureSubmitted({ tabId: tab, pageUrl: 'https://shop.example.co.uk/login', username: 'me', password: 'pw-1' }), { pending: false });
  await core.updateSettings({ saveLogins: true });
  // http pages (non-localhost) are never captured
  assert.deepEqual(await core.captureSubmitted({ tabId: tab, pageUrl: 'http://shop.example.co.uk/login', username: 'me', password: 'pw-1' }), { pending: false });
  assert.deepEqual(await core.captureSubmitted({ tabId: tab, pageUrl: 'https://shop.example.co.uk/login', username: 'me', password: 'pw-1' }), { pending: true });
  assert.ok(!storage.local.dump().includes('pw-1'), 'pending captures stay in memory-only session storage');
  const pending = await core.capturePending({ tabId: tab });
  assert.deepEqual({ ...pending, id: 'x' }, { show: true, id: 'x', kind: 'save', host: 'shop.example.co.uk', domain: 'example.co.uk', username: 'me', itemName: '' });
  assert.ok(!JSON.stringify(pending).includes('pw-1'), 'the popup never receives the password');
  assert.deepEqual(await core.capturePending({ tabId: 7 }), { show: false });
  // the decision applies only to the capture the popup displayed
  assert.deepEqual(await core.captureDecision({ tabId: tab, id: '00000000-0000-4000-8000-000000000000', decision: 'save' }), { done: false });
  const saved = await core.captureDecision({ tabId: tab, id: pending.id, decision: 'save' });
  assert.equal(saved.done, true);
  const item = await core.getItem(saved.id);
  assert.equal(item.data.name, 'shop.example.co.uk');
  assert.deepEqual(item.data.login.uris, [{ uri: 'https://shop.example.co.uk', match: 'host' }], 'auto-saved logins are bound to their host');
  assert.equal(item.data.login.password, 'pw-1');
  assert.deepEqual(await core.capturePending({ tabId: tab }), { show: false });

  // same credentials again -> nothing to offer
  assert.deepEqual(await core.captureSubmitted({ tabId: tab, pageUrl: 'https://shop.example.co.uk/login', username: 'ME', password: 'pw-1' }), { pending: false });
  // changed password for an existing username on the same host -> update offer naming the item
  await core.captureSubmitted({ tabId: tab, pageUrl: 'https://github.com/session', username: 'alice@example.com', password: 'gh-new' });
  const up = await core.capturePending({ tabId: tab });
  assert.equal(up.kind, 'update');
  assert.equal(up.itemName, 'GitHub');
  // a newer capture replaced the one shown: a stale decision does nothing
  await core.captureSubmitted({ tabId: tab, pageUrl: 'https://github.com/session', username: 'alice@example.com', password: 'gh-newer' });
  assert.deepEqual(await core.captureDecision({ tabId: tab, id: up.id, decision: 'update' }), { done: false });
  assert.equal((await core.getItem(githubId)).data.login.password, 'gh-secret-1');
  const up2 = await core.capturePending({ tabId: tab });
  await core.captureDecision({ tabId: tab, id: up2.id, decision: 'update' });
  const gh = await core.getItem(githubId);
  assert.equal(gh.data.login.password, 'gh-newer');
  assert.equal(gh.data.password_history[0].password, 'gh-secret-1');

  // another host of the same site never updates that login: it is offered as a separate login
  await core.captureSubmitted({ tabId: tab, pageUrl: 'https://gist.github.com/login', username: 'alice@example.com', password: 'other' });
  assert.equal((await core.capturePending({ tabId: tab })).kind, 'save');
  await core.dropPending(tab);

  // never for this site: stored as a hash only
  await core.captureSubmitted({ tabId: tab, pageUrl: 'https://forum.example.org/login', username: 'x', password: 'y' });
  await core.captureDecision({ tabId: tab, id: (await core.capturePending({ tabId: tab })).id, decision: 'never' });
  assert.ok(!storage.local.dump().includes('example.org'), 'never-save list holds hashes, not domains');
  assert.deepEqual(await core.captureSubmitted({ tabId: tab, pageUrl: 'https://www.example.org/login', username: 'x', password: 'z' }), { pending: false });
  // ...but "never" on one tenant of a shared host does not silence its neighbours (PSL)
  await core.captureSubmitted({ tabId: tab, pageUrl: 'https://evil.github.io/login', username: 'x', password: 'y' });
  await core.captureDecision({ tabId: tab, id: (await core.capturePending({ tabId: tab })).id, decision: 'never' });
  assert.deepEqual(await core.captureSubmitted({ tabId: tab, pageUrl: 'https://mine.github.io/login', username: 'x', password: 'z' }), { pending: true });

  // pending captures expire and are dropped when locked
  await core.captureSubmitted({ tabId: 5, pageUrl: 'https://new.example.net/', username: 'a', password: 'b' });
  await core.lock();
  assert.deepEqual(await core.capturePending({ tabId: 5 }), { show: false });
});

test('state reports pin, settings, counts', async () => {
  const { core } = await unlocked();
  const st = await core.getState();
  assert.equal(st.phase, 'unlocked');
  assert.equal(st.serverUrl, SERVER);
  assert.equal(st.serverName, 'Test NAS');
  assert.equal(st.user.displayName, 'ALICE');
  assert.equal(st.pin.source, 'server');
  assert.equal(st.itemCount, 2);
  assert.deepEqual(st.settings, { lockMinutes: 15, saveLogins: false });
  assert.equal(st.browser, 'chrome');
  assert.ok(st.lastSyncAt);
});
