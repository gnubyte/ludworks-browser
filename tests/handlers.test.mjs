import test from 'node:test';
import assert from 'node:assert/strict';

import { createMessageHandler, errorPayload } from '../src/background/handlers.js';
import { createCore } from '../src/background/core.js';
import { ApiError } from '../src/lib/api.js';
import { createStorage, createMockServer } from './helpers/fakes.mjs';

const RID = 'ext-id';
const ORIGIN = 'chrome-extension://ext-id/';
const POPUP = { id: RID, url: `${ORIGIN}popup/popup.html` };
const content = (url = 'https://shop.example/login', extra = {}) => ({ id: RID, url, frameId: 0, tab: { id: 12, active: true }, ...extra });

function setup() {
  const server = createMockServer();
  const core = createCore({ storage: createStorage(), fetchImpl: server.fetch, browserName: 'firefox', version: '1.0.0' });
  const calls = [];
  const handle = createMessageHandler({
    core,
    runtimeId: RID,
    extensionOrigin: ORIGIN,
    fill: async (id, allowInsecure, allowOtherHost) => {
      calls.push(['fill', id, allowInsecure, allowOtherHost]);
      return { filled: { username: true, password: true, totp: false } };
    },
    onCaptureBadge: async (tabId, pending) => calls.push(['badge', tabId, pending]),
    onActivity: async () => calls.push(['activity']),
    onSettingsChanged: async (patch, s) => {
      calls.push(['settings', patch]);
      return s;
    },
    onClipboardCopied: async () => calls.push(['clipboard']),
    onClearData: async () => calls.push(['clear']),
  });
  return { server, core, handle, calls };
}

test('popup messages are validated, counted as activity and dispatched', async () => {
  const { handle, calls, server } = setup();
  const st = await handle({ type: 'state' }, POPUP);
  assert.equal(st.phase, 'logged_out');
  assert.equal(st.browser, 'firefox');
  const probe = await handle({ type: 'server.probe', serverUrl: 'nas.example.com' }, POPUP);
  assert.equal(probe.fingerprint, server.FP);
  await handle({ type: 'clipboard.copied' }, POPUP);
  const s = await handle({ type: 'settings.update', lockMinutes: 30 }, POPUP);
  assert.equal(s.lockMinutes, 30);
  await handle({ type: 'fill.item', id: '3b241101-e2bb-4255-8caf-4136c566a962' }, POPUP);
  await handle({ type: 'data.clear' }, POPUP);
  assert.deepEqual(calls.filter((c) => c[0] !== 'activity'), [
    ['clipboard'],
    ['settings', { type: 'settings.update', lockMinutes: 30 }],
    ['fill', '3b241101-e2bb-4255-8caf-4136c566a962', false, false],
    ['clear'],
  ]);
  assert.equal(calls.filter((c) => c[0] === 'activity').length, 6);
});

test('invalid messages and foreign senders are rejected before reaching the core', async () => {
  const { handle, calls } = setup();
  await assert.rejects(handle({ type: 'vault.unlock' }, POPUP), (e) => e.code === 'bad_message');
  await assert.rejects(handle({ type: 'nope' }, POPUP), (e) => e.code === 'bad_message');
  await assert.rejects(handle({ type: 'state', evil: true }, POPUP), (e) => e.code === 'bad_message');
  await assert.rejects(handle({ type: 'state' }, { id: 'other-ext', url: `${ORIGIN}popup/popup.html` }), (e) => e.code === 'forbidden');
  await assert.rejects(handle({ type: 'state' }, content()), (e) => e.code === 'bad_message', 'content scripts cannot use popup messages');
  await assert.rejects(handle({ type: 'items.get', id: '3b241101-e2bb-4255-8caf-4136c566a962' }, content()), (e) => e.code === 'bad_message');
  await assert.rejects(handle({ type: 'capture.loaded' }, content('https://x/', { frameId: 3 })), (e) => e.code === 'forbidden');
  await assert.rejects(handle({ type: 'capture.loaded' }, content('https://x/', { tab: { id: 1, active: false } })), (e) => e.code === 'forbidden');
  assert.equal(calls.length, 0, 'no side effects for rejected messages');
});

test('content messages use the browser-supplied tab id and URL, never message fields', async () => {
  const { handle } = setup();
  assert.equal(await handle({ type: 'capture.loaded' }, content()), null);
  assert.equal(await handle({ type: 'capture.submitted', username: 'u', password: 'p' }, content()), null, 'feature off by default');
  await assert.rejects(handle({ type: 'capture.submitted', username: 'u', password: 'p', url: 'https://spoof/' }, content()), (e) => e.code === 'bad_message');
});

const MASTER = 'correct horse battery staple';

test('offer to save: a content script can neither decide nor observe; the popup confirms the displayed capture', async () => {
  const { handle, core, server, calls } = setup();
  await server.admin.initVault('alice', MASTER);
  await core.trustServer('https://nas.example.com', server.FP);
  await core.login({ serverUrl: 'https://nas.example.com', username: 'alice', password: 'alice-login-pw' });
  await core.unlock(MASTER);
  await core.updateSettings({ saveLogins: true });
  const page = content('https://shop.example/login');

  // the content script learns nothing: the same null whether a capture is now pending or not
  assert.equal(await handle({ type: 'capture.submitted', username: 'u', password: 'p1' }, page), null);
  assert.deepEqual(calls.filter((c) => c[0] === 'badge'), [['badge', 12, true]], 'toolbar badge shown');
  // and it cannot take the decision (the in-page prompt is gone; a page could overlay or click-jack it)
  for (const msg of [{ type: 'capture.decision', decision: 'save' }, { type: 'capture.decision', decision: 'update' }, { type: 'capture.confirm', tabId: 12, id: '3b241101-e2bb-4255-8caf-4136c566a962', decision: 'save' }]) {
    await assert.rejects(handle(msg, page), (e) => e.code === 'bad_message');
  }
  assert.equal((await core.listItems()).items.length, 0, 'nothing was written');

  // the popup shows it (without the password) and confirms exactly that capture
  const shown = await handle({ type: 'capture.get', tabId: 12 }, POPUP);
  assert.equal(shown.show, true);
  assert.equal(shown.host, 'shop.example');
  assert.ok(!JSON.stringify(shown).includes('p1'));
  const r = await handle({ type: 'capture.confirm', tabId: 12, id: shown.id, decision: 'save' }, POPUP);
  assert.equal(r.done, true);
  assert.equal((await core.getItem(r.id)).data.login.password, 'p1');
  assert.deepEqual(calls.filter((c) => c[0] === 'badge').at(-1), ['badge', 12, false], 'badge cleared');
  // a page load in that tab re-shows the badge only while something waits
  await handle({ type: 'capture.loaded' }, page);
  assert.deepEqual(calls.filter((c) => c[0] === 'badge').at(-1), ['badge', 12, false]);
});

test('fill.item passes the other-host confirmation through', async () => {
  const { handle, calls } = setup();
  await handle({ type: 'fill.item', id: '3b241101-e2bb-4255-8caf-4136c566a962', allowOtherHost: true }, POPUP);
  assert.deepEqual(calls.filter((c) => c[0] === 'fill'), [['fill', '3b241101-e2bb-4255-8caf-4136c566a962', false, true]]);
});

test('errorPayload never leaks stacks and keeps details JSON-safe', () => {
  const circular = {};
  circular.self = circular;
  assert.deepEqual(errorPayload(new ApiError({ status: 429, code: 'rate_limited', message: 'slow', retryAfter: 5, details: { a: 1 } })), { code: 'rate_limited', message: 'slow', status: 429, retryAfter: 5, details: { a: 1 } });
  assert.deepEqual(errorPayload(Object.assign(new Error('x'), { code: 'c', details: circular })), { code: 'c', message: 'x', status: 0, retryAfter: null, details: undefined });
  assert.deepEqual(errorPayload(new TypeError('secret stack')), { code: 'internal', message: 'Unexpected error in the extension.', status: 0, retryAfter: null });
});
