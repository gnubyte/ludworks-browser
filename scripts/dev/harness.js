// Dev-only browser harness (served by scripts/dev/preview.mjs, never packaged). Installs a fake `chrome`
// namespace whose runtime.sendMessage goes through the REAL background message handler and core, backed by
// the in-memory mock Ludworks server from the tests, then loads the real popup.
//
// Query parameters: ?scenario=login|locked|unlocked (default unlocked), &url=<active tab URL>

import { createCore } from '../../src/background/core.js';
import { createMessageHandler, errorPayload } from '../../src/background/handlers.js';
import { createMockServer, createStorage } from '../../tests/helpers/fakes.mjs';

const params = new URLSearchParams(location.search);
const scenario = params.get('scenario') || 'unlocked';
const tabUrl = params.get('url') || 'https://github.com/login';
const SERVER = 'https://nas.example.com';
const MASTER = 'correct horse battery staple';
const RUNTIME_ID = 'ludworks-dev-preview';
const EXT_ORIGIN = `${location.origin}/`;

const server = createMockServer();
const storage = createStorage();
const listeners = [];
const emit = (event) => {
  for (const fn of listeners) {
    try {
      fn({ event }, { id: RUNTIME_ID });
    } catch {
      /* ignore */
    }
  }
};
const core = createCore({ storage, fetchImpl: server.fetch, browserName: 'chrome', version: 'dev-preview', emit });
const handle = createMessageHandler({
  core,
  runtimeId: RUNTIME_ID,
  extensionOrigin: EXT_ORIGIN,
  fill: async (id) => {
    const creds = await core.resolveFill(id, tabUrl);
    console.info('[preview] would fill', { username: creds.username, totp: creds.totp ? 'yes' : 'no' });
    return { filled: { username: true, password: true, totp: false } };
  },
});

globalThis.chrome = {
  runtime: {
    id: RUNTIME_ID,
    getURL: (p = '') => EXT_ORIGIN + p,
    async sendMessage(msg) {
      await new Promise((r) => setTimeout(r, 40)); // feel the async boundary
      try {
        const data = await handle(JSON.parse(JSON.stringify(msg)), { id: RUNTIME_ID, url: location.href });
        return { ok: true, data: data === undefined ? null : JSON.parse(JSON.stringify(data)) };
      } catch (e) {
        return { ok: false, error: errorPayload(e) };
      }
    },
    onMessage: { addListener: (fn) => listeners.push(fn) },
  },
  storage: { local: storage.local, session: storage.session },
  tabs: {
    query: async () => [{ id: 1, url: tabUrl }],
    create: async ({ url }) => console.info('[preview] open tab', url),
  },
  permissions: {
    request: async () => true,
    contains: async () => true,
    remove: async () => true,
  },
};

async function seed() {
  const vk = await server.admin.initVault('alice', MASTER);
  const items = [
    { type: 'login', name: 'GitHub', favorite: true, notes: 'Work account.\nSSO via company IdP.', login: { username: 'alice@example.com', password: 'gh-T7#qLm2!vR9x', uris: [{ uri: 'https://github.com/login', match: 'domain' }], totp: 'otpauth://totp/GitHub:alice?secret=JBSWY3DPEHPK3PXP&issuer=GitHub' }, fields: [{ name: 'Recovery email', value: 'alice.backup@example.com', hidden: false }, { name: 'PIN', value: '4821', hidden: true }], password_history: [{ password: 'old-pass-1', changed_at: '2026-05-01T10:00:00Z' }] },
    { type: 'login', name: 'GitHub (personal)', login: { username: 'alice-dev', password: 'p3rs0nal!Pass', uris: [{ uri: 'https://github.com', match: 'host' }] } },
    { type: 'login', name: 'Amazon', login: { username: 'alice@example.com', password: 'Amz-2026-x!', uris: [{ uri: 'https://www.amazon.com' }] } },
    { type: 'login', name: 'Bank of Example', favorite: true, login: { username: 'alice.w', password: 'B4nk$ecure-99', uris: [{ uri: 'https://online.bank.example' }] } },
    { type: 'login', name: 'NAS admin', login: { username: 'admin', password: 'nas-admin-pw', uris: [{ uri: 'https://192.168.1.10:5001' }] } },
    { type: 'note', name: 'Wi-Fi at home', notes: 'SSID: Ludworks-5G\nKey: correct-horse-battery' },
    { type: 'card', name: 'Visa ending 4242', card: { cardholder: 'Alice Example', brand: 'Visa', number: '4242424242424242', exp_month: '04', exp_year: '2029', code: '123' } },
    { type: 'identity', name: 'Alice (personal)', identity: { first_name: 'Alice', last_name: 'Example', email: 'alice@example.com', phone: '+1 555 0100', city: 'Springfield', country: 'US' } },
  ];
  for (const it of items) await server.admin.putItem('alice', vk, it);
  if (scenario === 'login') return;
  await core.trustServer(SERVER, server.FP);
  await core.login({ serverUrl: SERVER, username: 'alice', password: 'alice-login-pw' });
  if (scenario === 'unlocked') await core.unlock(MASTER);
}

seed()
  .catch((e) => console.error('[preview] seed failed', e))
  .then(() => import('../../src/popup/popup.js'));
