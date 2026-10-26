import test from 'node:test';
import assert from 'node:assert/strict';

import { createApi, normalizeServerUrl, originPattern, ApiError } from '../src/lib/api.js';

const TOKEN = `lws_${'A'.repeat(43)}`;

function fakeFetch(handler) {
  const calls = [];
  const f = async (url, init) => {
    calls.push({ url, init });
    return handler(url, init);
  };
  f.calls = calls;
  return f;
}
const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

test('normalizeServerUrl', () => {
  const cases = {
    'nas.example.com': 'https://nas.example.com',
    'https://nas.example.com/': 'https://nas.example.com',
    'https://nas.example.com:8443': 'https://nas.example.com:8443',
    'https://example.com/ludworks/': 'https://example.com/ludworks',
    'https://example.com/ludworks/api/v1': 'https://example.com/ludworks',
    'HTTPS://NAS.Example.COM': 'https://nas.example.com',
    'http://localhost:18090': 'http://localhost:18090',
    'http://127.0.0.1:8080/': 'http://127.0.0.1:8080',

    '  https://nas  ': 'https://nas',
  };
  for (const [input, want] of Object.entries(cases)) assert.equal(normalizeServerUrl(input), want, input);
  const rejects = {
    'http://nas.example.com': 'insecure_server_url',
    'http://192.168.1.5': 'insecure_server_url',
    'http://[::1]:8080': 'insecure_server_url',
    'http://dev.localhost': 'insecure_server_url',
    'ftp://nas': 'bad_server_url',
    'https://user:pw@nas': 'bad_server_url',
    'https://nas/?x=1': 'bad_server_url',
    'https://nas/#x': 'bad_server_url',
    '': 'bad_server_url',
    'https://': 'bad_server_url',
  };
  for (const [input, code] of Object.entries(rejects)) {
    assert.throws(() => normalizeServerUrl(input), (e) => e instanceof ApiError && e.code === code, input);
  }
});

test('originPattern drops the port (match patterns are port-agnostic)', () => {
  assert.equal(originPattern('https://nas.example.com:8443/x'), 'https://nas.example.com/*');
  assert.equal(originPattern('http://localhost:18090'), 'http://localhost/*');
});

test('requests use Bearer auth, no cookies, no redirects, no-store', async () => {
  const f = fakeFetch(() => json(200, { initialized: false }));
  const api = createApi({ baseUrl: 'https://nas.example.com/sub', token: TOKEN, fetchImpl: f });
  assert.deepEqual(await api.getVault(), { initialized: false });
  const { url, init } = f.calls[0];
  assert.equal(url, 'https://nas.example.com/sub/api/v1/vault');
  assert.equal(init.method, 'GET');
  assert.equal(init.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(init.headers.Accept, 'application/json');
  assert.equal(init.credentials, 'omit');
  assert.equal(init.redirect, 'error');
  assert.equal(init.cache, 'no-store');
  assert.equal(init.referrerPolicy, 'no-referrer');
  assert.equal(init.body, undefined);
});

test('login sends token_mode + device_name and validates the returned token', async () => {
  const f = fakeFetch(() => json(200, { user: { id: 'u1', username: 'a' }, csrf_token: 'c', expires_at: 'x', token: TOKEN }));
  const api = createApi({ baseUrl: 'https://nas', fetchImpl: f });
  const res = await api.login({ username: 'a', password: 'pw', totpCode: '123456', deviceName: 'Chrome extension' });
  assert.equal(res.token, TOKEN);
  const { url, init } = f.calls[0];
  assert.equal(url, 'https://nas/api/v1/auth/login');
  assert.equal(init.method, 'POST');
  assert.equal(init.headers['Content-Type'], 'application/json');
  assert.equal(init.headers.Authorization, undefined);
  assert.deepEqual(JSON.parse(init.body), { username: 'a', password: 'pw', token_mode: true, device_name: 'Chrome extension', totp_code: '123456' });

  const noToken = createApi({ baseUrl: 'https://nas', fetchImpl: fakeFetch(() => json(200, { user: {}, token: 'session-cookie-ish' })) });
  await assert.rejects(noToken.login({ username: 'a', password: 'b', deviceName: 'x' }), (e) => e.code === 'bad_response');
});

test('error envelope mapping', async () => {
  const api = (status, body, headers) => createApi({ baseUrl: 'https://nas', token: TOKEN, fetchImpl: fakeFetch(() => (typeof body === 'string' ? new Response(body, { status, headers }) : json(status, body, headers))) });
  await assert.rejects(api(401, { error: { code: 'totp_required', message: 'Code needed' } }).login({ username: 'a', password: 'b', deviceName: 'x' }), (e) => e.code === 'totp_required' && e.status === 401 && e.message === 'Code needed');
  await assert.rejects(api(429, { error: { code: 'rate_limited', message: 'slow down' } }, { 'Retry-After': '17' }).getVault(), (e) => e.code === 'rate_limited' && e.retryAfter === 17);
  await assert.rejects(api(409, { error: { code: 'conflict', message: 'x', details: { current: { id: 'a' } } } }).getVault(), (e) => e.details.current.id === 'a');
  await assert.rejects(api(502, '<html>bad gateway</html>').getVault(), (e) => e.code === 'http_error' && e.status === 502);
  await assert.rejects(api(503, 'nope').getVault(), (e) => e.code === 'setup_required');
  await assert.rejects(api(200, 'not json').getVault(), (e) => e.code === 'bad_response');
});

test('204 -> null, network error, timeout, missing token', async () => {
  const empty = createApi({ baseUrl: 'https://nas', token: TOKEN, fetchImpl: fakeFetch(() => new Response(null, { status: 204 })) });
  assert.equal(await empty.logout(), null);
  const down = createApi({ baseUrl: 'https://nas', token: TOKEN, fetchImpl: async () => { throw new TypeError('Failed to fetch'); } });
  await assert.rejects(down.getVault(), (e) => e.code === 'network_error' && e.status === 0);
  // an error already classified by a fetch wrapper (Firefox pin mismatch) is not turned into network_error
  const pinned = createApi({
    baseUrl: 'https://nas',
    token: TOKEN,
    fetchImpl: async () => { throw new ApiError({ code: 'certificate_changed', message: 'pin mismatch', details: { presented: 'ab' } }); },
  });
  await assert.rejects(pinned.getVault(), (e) => e.code === 'certificate_changed' && e.details.presented === 'ab');
  const hang = createApi({
    baseUrl: 'https://nas',
    token: TOKEN,
    timeoutMs: 30,
    fetchImpl: (url, init) => new Promise((_res, rej) => init.signal.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')))),
  });
  await assert.rejects(hang.getVault(), (e) => e.code === 'timeout');
  const f = fakeFetch(() => json(200, {}));
  const anon = createApi({ baseUrl: 'https://nas', token: null, fetchImpl: f });
  await assert.rejects(anon.getVault(), (e) => e.code === 'unauthorized');
  const weird = createApi({ baseUrl: 'https://nas', token: 'Bearer abc', fetchImpl: f });
  await assert.rejects(weird.getVault(), (e) => e.code === 'unauthorized');
  assert.equal(f.calls.length, 0, 'no request without a well-formed token');
});

test('vault endpoints build correct paths and bodies', async () => {
  const f = fakeFetch(() => json(200, { id: 'x' }));
  const api = createApi({ baseUrl: 'https://nas', token: () => TOKEN, fetchImpl: f });
  await api.vaultSync('2026-10-26T12:00:00Z');
  await api.vaultSync(null);
  await api.createItem({ id: '3b241101-e2bb-4255-8caf-4136c566a962', data: 'v1.a.b' });
  await api.updateItem('3b241101-e2bb-4255-8caf-4136c566a962', { folderId: null, data: 'v1.c.d', baseRevision: 4 });
  await api.deleteItem('3b241101-e2bb-4255-8caf-4136c566a962');
  assert.equal(f.calls[0].url, 'https://nas/api/v1/vault/sync?since=2026-10-26T12%3A00%3A00Z');
  assert.equal(f.calls[1].url, 'https://nas/api/v1/vault/sync');
  assert.deepEqual(JSON.parse(f.calls[2].init.body), { id: '3b241101-e2bb-4255-8caf-4136c566a962', folder_id: null, data: 'v1.a.b' });
  assert.equal(f.calls[3].init.method, 'PUT');
  assert.deepEqual(JSON.parse(f.calls[3].init.body), { folder_id: null, data: 'v1.c.d', base_revision: 4 });
  assert.equal(f.calls[4].init.method, 'DELETE');
  assert.throws(() => api.deleteItem('../admin'), (e) => e.code === 'bad_request');
  await assert.rejects(api.request('GET', '/../../etc'), (e) => e.code === 'bad_request');
});
