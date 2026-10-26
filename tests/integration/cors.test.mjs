// CORS / Origin behaviour of a LIVE server towards extension origins, through the harness's browser network
// stack (real preflights and Access-Control-* checks when the extension has no host permission; CORS
// bypass with a host permission, as in Chrome and Firefox). ARCHITECTURE.md §2.9: extension origins are
// allowed for Bearer requests only, never with cookies; security.allowed_extension_origins narrows them.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createNetwork, rawRequest } from './browser-env.mjs';
import { config, skipReason, adminPeer, createUser, createWebPeer } from './live-server.mjs';

const cfg = config();
const skip = skipReason(cfg);
const SERVER = cfg.url;
const CHROME_A = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
const CHROME_B = 'chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba';
const MOZ = 'moz-extension://11111111-2222-3333-4444-555555555555';

function net(origin, { privileged = false } = {}) {
  return createNetwork({ kind: origin.startsWith('moz') ? 'firefox' : 'chrome', origin, hostPermitted: () => privileged });
}

const json = async (res) => JSON.parse(await res.text());

async function tokenLogin(username, password) {
  const r = await rawRequest(`${SERVER}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: CHROME_A },
    body: Buffer.from(JSON.stringify({ username, password, token_mode: true, device_name: 'CORS test' })),
  });
  assert.equal(r.status, 200, r.body.toString());
  return JSON.parse(r.body.toString()).token;
}

test('CORS towards extension origins (live server)', { skip, timeout: 120_000 }, async (t) => {
  const admin = await adminPeer(cfg);
  const user = await createUser(admin, 'cors');
  const token = await tokenLogin(user.username, user.password);
  const bearer = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
  t.after(() => admin.api.patch('/admin/settings', { security: { allowed_extension_origins: [] } }).catch(() => {}));

  await t.test('Bearer requests from chrome-extension:// work through real CORS (GET, POST+JSON preflight, PUT, DELETE)', async () => {
    const n = net(CHROME_A);
    const res = await n.fetch(`${SERVER}/api/v1/vault`, { headers: bearer, credentials: 'omit' });
    assert.equal(res.status, 200);
    assert.equal((await json(res)).initialized, false);
    assert.equal(n.log.at(-1).preflight.status, 204, 'Authorization makes it non-simple → preflight');
    assert.ok(res.headers.get('x-request-id'), 'exposed header readable');
    // POST with a JSON body: the error envelope is readable cross-origin (409: vault not set up)
    const post = await n.fetch(`${SERVER}/api/v1/vault/items`, {
      method: 'POST', credentials: 'omit', headers: { ...bearer, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: '3f0c9a52-7d1e-4b6a-9c2f-8e5d4a1b0c7e', data: 'v1.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA==' }),
    });
    assert.equal(post.status, 409);
    assert.equal((await json(post)).error.code, 'conflict');
    for (const method of ['PUT', 'DELETE']) {
      const r = await n.fetch(`${SERVER}/api/v1/vault/items/3f0c9a52-7d1e-4b6a-9c2f-8e5d4a1b0c7e`, {
        method, credentials: 'omit', headers: { ...bearer, 'Content-Type': 'application/json' },
        body: method === 'PUT' ? JSON.stringify({ data: 'v1.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA==', base_revision: 1 }) : undefined,
      });
      assert.ok([404, 409].includes(r.status), `${method} reached the server (${r.status})`);
      assert.ok((await json(r)).error.code);
    }
  });

  await t.test('moz-extension:// works the same', async () => {
    const n = net(MOZ);
    const res = await n.fetch(`${SERVER}/api/v1/auth/session`, { headers: bearer, credentials: 'omit' });
    assert.equal(res.status, 200);
    assert.equal((await json(res)).user.username, user.username);
  });

  await t.test('401 and its JSON envelope are readable cross-origin; Retry-After is an exposed header', async () => {
    const n = net(CHROME_A);
    const res = await n.fetch(`${SERVER}/api/v1/vault`, { headers: { Authorization: 'Bearer lws_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }, credentials: 'omit' });
    assert.equal(res.status, 401);
    assert.equal((await json(res)).error.code, 'unauthorized');
    const raw = await rawRequest(`${SERVER}/api/v1/vault`, { headers: { origin: CHROME_A, authorization: `Bearer ${token}` } });
    const expose = raw.headers.find(([k]) => k === 'access-control-expose-headers')[1].toLowerCase();
    assert.match(expose, /retry-after/);
    assert.equal(raw.headers.find(([k]) => k === 'access-control-allow-credentials'), undefined, 'never ACAC');
  });

  await t.test('unauthenticated endpoints get no CORS: the extension needs its host permission for login/probe', async () => {
    const n = net(CHROME_A);
    await assert.rejects(n.fetch(`${SERVER}/api/v1/setup/status`, { credentials: 'omit' }), TypeError);
    await assert.rejects(n.fetch(`${SERVER}/api/v1/auth/login`, {
      method: 'POST', credentials: 'omit', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: user.username, password: user.password, token_mode: true }),
    }), TypeError);
    assert.equal(n.log.at(-1).preflight.status, 403);
    // …and with the host permission (what the extension requests at sign-in) both work, Origin and all
    const p = net(CHROME_A, { privileged: true });
    assert.equal((await p.fetch(`${SERVER}/api/v1/setup/status`, { credentials: 'omit' })).status, 200);
    const login = await p.fetch(`${SERVER}/api/v1/auth/login`, {
      method: 'POST', credentials: 'omit', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: user.username, password: user.password, token_mode: true, device_name: 'CORS test 2' }),
    });
    assert.equal(login.status, 200);
    assert.match((await json(login)).token, /^lws_/);
  });

  await t.test('cookie auth from an extension origin is refused under CORS', async () => {
    const web = await createWebPeer(SERVER);
    await web.login(user.username, user.password);
    const n = net(CHROME_A);
    for (const [k, v] of web.jar.cookies) n.jar.cookies.set(k, v); // same browser profile
    await assert.rejects(n.fetch(`${SERVER}/api/v1/vault`, { credentials: 'include' }), TypeError, 'GET: no ACAO/ACAC for cookies');
    assert.equal(n.log.at(-1).blocked, 'response');
    await assert.rejects(n.fetch(`${SERVER}/api/v1/vault/init`, {
      method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': 'x' }, body: '{}',
    }), TypeError, 'unsafe: preflight without Authorization refused');
    // even bypassing CORS (host permission), the CSRF/Origin check refuses cookie writes from the extension
    const r = await rawRequest(`${SERVER}/api/v1/vault/init`, {
      method: 'POST', headers: { origin: CHROME_A, cookie: web.jar.header(SERVER), 'x-csrf-token': 'whatever', 'content-type': 'application/json' }, body: Buffer.from('{}'),
    });
    assert.equal(r.status, 403);
  });

  // Formerly a todo (server issue): cookie GETs with an extension Origin were served, so a
  // CORS-bypassing extension could read them. The server now refuses them (403).
  await t.test('cookie-authenticated reads with an extension Origin are refused server-side', async () => {
    const web = await createWebPeer(SERVER);
    await web.login(user.username, user.password);
    const r = await rawRequest(`${SERVER}/api/v1/vault`, { headers: { origin: CHROME_A, cookie: web.jar.header(SERVER) } });
    assert.equal(r.status, 403, `got ${r.status}`);
  });

  await t.test('security.allowed_extension_origins pins the extension ids', async () => {
    await admin.api.patch('/admin/settings', { security: { allowed_extension_origins: [CHROME_A] } });
    const ok = await net(CHROME_A).fetch(`${SERVER}/api/v1/vault`, { headers: bearer, credentials: 'omit' });
    assert.equal(ok.status, 200);
    const other = net(CHROME_B);
    await assert.rejects(other.fetch(`${SERVER}/api/v1/vault`, { headers: bearer, credentials: 'omit' }), TypeError);
    assert.equal(other.log.at(-1).preflight.status, 403);
    await assert.rejects(net(MOZ).fetch(`${SERVER}/api/v1/vault`, { headers: bearer, credentials: 'omit' }), TypeError);
    await admin.api.patch('/admin/settings', { security: { allowed_extension_origins: [] } });
    assert.equal((await other.fetch(`${SERVER}/api/v1/vault`, { headers: bearer, credentials: 'omit' })).status, 200, 'empty list = any extension');
  });

  // Formerly a todo (server issue): allowed_extension_origins only gated CORS headers. The
  // server now refuses every request from an extension origin that is not allowed (403).
  await t.test('a non-allowed extension origin is refused server-side even when it bypasses CORS', async () => {
    await admin.api.patch('/admin/settings', { security: { allowed_extension_origins: [CHROME_A] } });
    try {
      const res = await net(CHROME_B, { privileged: true }).fetch(`${SERVER}/api/v1/vault`, { headers: bearer, credentials: 'omit' });
      assert.equal(res.status, 403, `got ${res.status}`);
    } finally {
      await admin.api.patch('/admin/settings', { security: { allowed_extension_origins: [] } });
    }
  });
});
