import test from 'node:test';
import assert from 'node:assert/strict';

import { syncCaptureRegistration, CAPTURE_ORIGINS, CAPTURE_SCRIPT_ID } from '../src/background/capture.js';
import { createCertObserver } from '../src/background/certpin.js';
import { scheduleClipboardClear, clearClipboard, CLIPBOARD_ALARM, _internals } from '../src/background/clipboard.js';

function captureExt({ granted }) {
  const registered = new Map();
  const log = [];
  return {
    registered,
    log,
    permissions: { contains: async (p) => { log.push(['contains', p]); return granted; } },
    scripting: {
      getRegisteredContentScripts: async ({ ids }) => ids.filter((id) => registered.has(id)).map((id) => registered.get(id)),
      registerContentScripts: async (list) => { for (const s of list) registered.set(s.id, s); log.push(['register']); },
      unregisterContentScripts: async ({ ids }) => { for (const id of ids) registered.delete(id); log.push(['unregister']); },
    },
  };
}

test('capture script is registered only when enabled AND permission granted', async () => {
  const off = captureExt({ granted: true });
  assert.equal(await syncCaptureRegistration(off, false), false);
  assert.equal(off.registered.size, 0);

  const noPerm = captureExt({ granted: false });
  assert.equal(await syncCaptureRegistration(noPerm, true), false);
  assert.equal(noPerm.registered.size, 0);

  const on = captureExt({ granted: true });
  assert.equal(await syncCaptureRegistration(on, true), true);
  const s = on.registered.get(CAPTURE_SCRIPT_ID);
  assert.deepEqual(s.js, ['content/capture.js']);
  assert.deepEqual(s.matches, [...CAPTURE_ORIGINS]);
  assert.equal(s.allFrames, false);
  assert.deepEqual(on.log[0], ['contains', { origins: [...CAPTURE_ORIGINS] }]);
  // idempotent, then disabling unregisters
  await syncCaptureRegistration(on, true);
  assert.equal(on.log.filter((l) => l[0] === 'register').length, 1);
  assert.equal(await syncCaptureRegistration(on, false), false);
  assert.equal(on.registered.size, 0);
});

function webRequestExt(infos) {
  const listeners = [];
  return {
    listeners,
    webRequest: {
      onHeadersReceived: {
        addListener: (fn, filter, extra) => listeners.push({ fn, filter, extra }),
        removeListener: (fn) => {
          const i = listeners.findIndex((l) => l.fn === fn);
          if (i >= 0) listeners.splice(i, 1);
        },
      },
      getSecurityInfo: async (requestId) => infos[requestId],
    },
  };
}

const FP_A = 'AA:'.repeat(31) + 'AA';
const FP_B = 'BB:'.repeat(31) + 'BB';
const secure = (fp) => ({ state: 'secure', certificates: [{ fingerprint: { sha256: fp } }] });

test('Firefox cert observer: records, verifies and blocks mismatching certificates', async () => {
  assert.equal(createCertObserver({}), null, 'no webRequest (Chrome) -> no observer');
  const ext = webRequestExt({ r1: secure(FP_A), r2: secure(FP_B), r3: { state: 'insecure', certificates: [] }, r4: secure(FP_A) });
  const obs = createCertObserver(ext);
  obs.watch('https://nas.example.com', null);
  assert.equal(ext.listeners.length, 1);
  assert.deepEqual(ext.listeners[0].filter, { urls: ['https://nas.example.com/*'] });
  assert.deepEqual(ext.listeners[0].extra, ['blocking']);
  const fn = () => ext.listeners[0].fn;

  // TOFU: nothing pinned yet -> observe only
  assert.deepEqual(await fn()({ requestId: 'r1', url: 'https://nas.example.com/api/v1/setup/status' }), {});
  assert.equal(obs.observed('https://nas.example.com'), 'aa'.repeat(32));
  assert.equal(obs.status('https://nas.example.com').verified, false);
  // other origins (e.g. different port) are ignored by this listener
  assert.deepEqual(await fn()({ requestId: 'r2', url: 'https://nas.example.com:9999/x' }), {});

  // pinned: matching passes, mismatching / insecure is cancelled and reported once
  obs.watch('https://nas.example.com', 'aa'.repeat(32));
  assert.equal(ext.listeners.length, 1, 'still one listener (pins are read live)');
  assert.deepEqual(await fn()({ requestId: 'r4', url: 'https://nas.example.com/api/v1/vault' }), {});
  assert.equal(obs.status('https://nas.example.com').verified, true);
  assert.deepEqual(await fn()({ requestId: 'r2', url: 'https://nas.example.com/api/v1/vault' }), { cancel: true });
  assert.equal(obs.takeMismatch('https://nas.example.com'), 'bb'.repeat(32));
  assert.equal(obs.takeMismatch('https://nas.example.com'), null);
  assert.deepEqual(await fn()({ requestId: 'r3', url: 'https://nas.example.com/api/v1/vault' }), { cancel: true });
  assert.deepEqual(await fn()({ requestId: 'missing', url: 'https://nas.example.com/api/v1/vault' }), { cancel: true });

  // plain-http localhost servers have no certificate to watch (and do not disarm the https server)
  obs.watch('http://localhost:18090', null);
  assert.equal(ext.listeners.length, 1);
  assert.deepEqual(ext.listeners[0].filter, { urls: ['https://nas.example.com/*'] });
});

test('Firefox cert observer: several servers at once, fresh observations, recent verification', async () => {
  let clock = 1000;
  const ext = webRequestExt({ a: secure(FP_A), b: secure(FP_B), c: secure(FP_A) });
  const obs = createCertObserver(ext, { now: () => clock });
  obs.watch('https://nas.example.com', FP_A);
  obs.watch('https://old.example.net', null); // e.g. revoking the token of a previous server
  assert.equal(ext.listeners.length, 1, 'one listener');
  assert.deepEqual(ext.listeners[0].filter.urls, ['https://nas.example.com/*', 'https://old.example.net/*']);
  obs.watch('https://nas.example.com', FP_A);
  assert.equal(ext.listeners.length, 1, 'idempotent');
  const fn = ext.listeners[0].fn;

  // only observations made after mark() count as fresh
  const m0 = obs.mark();
  assert.equal(obs.observedSince('https://nas.example.com', m0), null);
  assert.equal(obs.recentlyVerified('https://nas.example.com', FP_A, 5000), false, 'nothing seen yet');
  assert.deepEqual(await fn({ requestId: 'a', url: 'https://nas.example.com/api/v1/setup/status' }), {});
  assert.equal(obs.observedSince('https://nas.example.com', m0).fingerprint, 'aa'.repeat(32));
  assert.equal(obs.recentlyVerified('https://nas.example.com', FP_A, 5000), true);
  assert.equal(obs.recentlyVerified('https://nas.example.com', FP_B, 5000), false, 'other pin');
  clock += 5001;
  assert.equal(obs.recentlyVerified('https://nas.example.com', FP_A, 5000), false, 'too old');
  const m1 = obs.mark();
  assert.equal(obs.observedSince('https://nas.example.com', m1), null, 'stale observation is not fresh');

  // the second server is observed (no pin), never cancelled
  assert.deepEqual(await fn({ requestId: 'b', url: 'https://old.example.net/api/v1/auth/logout' }), {});
  assert.equal(obs.observed('https://old.example.net'), 'bb'.repeat(32));
  // a mismatch on the pinned server is still cancelled, and is a fresh (unverified) observation
  const m2 = obs.mark();
  assert.deepEqual(await fn({ requestId: 'b', url: 'https://nas.example.com/api/v1/vault' }), { cancel: true });
  assert.equal(obs.observedSince('https://nas.example.com', m2).fingerprint, 'bb'.repeat(32));
  assert.equal(obs.recentlyVerified('https://nas.example.com', FP_A, 5000), false);
  assert.equal(obs.takeMismatch('https://nas.example.com'), 'bb'.repeat(32));
});

test('clipboard: 30 s alarm, offscreen clear on Chrome', async () => {
  const alarms = [];
  await scheduleClipboardClear({ alarms: { create: async (name, info) => alarms.push([name, info]) } }, () => 1000);
  assert.deepEqual(alarms, [[CLIPBOARD_ALARM, { when: 31000 }]]);

  const log = [];
  const chromeLike = {
    offscreen: {
      createDocument: async (o) => log.push(['create', o.url, o.reasons]),
      closeDocument: async () => log.push(['close']),
    },
    runtime: { sendMessage: async (m) => log.push(['send', m]) },
  };
  await clearClipboard(chromeLike);
  assert.deepEqual(log, [
    ['create', 'offscreen/offscreen.html', ['CLIPBOARD']],
    ['send', { target: 'offscreen', type: 'clipboard.clear' }],
    ['close'],
  ]);
});

test('clipboard copy-event clearing writes an empty string', () => {
  let handler = null;
  let data = 'secret';
  const doc = {
    addEventListener: (type, fn) => { if (type === 'copy') handler = fn; },
    removeEventListener: () => { handler = null; },
    execCommand: (cmd) => {
      if (cmd === 'copy' && handler) handler({ preventDefault() {}, clipboardData: { setData: (_t, v) => { data = v; } } });
      return true;
    },
  };
  assert.equal(_internals.clearWithCopyEvent(doc), true);
  assert.equal(data, '');
});
