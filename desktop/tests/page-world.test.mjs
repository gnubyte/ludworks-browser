// Scripts the tab preload installs in the page's main world (src/preload/features): window.chrome as a
// Chromium page has it, and the passkey shim's hand-off to the platform's WebAuthn.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installChromeApi } from '../src/preload/features/chrome-api.js';
import { installWebAuthnShim } from '../src/preload/features/webauthn.js';

const settle = (ms = 0) => new Promise((r) => setTimeout(r, ms));

function withWindow(win, fn) {
  const had = Object.prototype.hasOwnProperty.call(globalThis, 'window');
  const prev = globalThis.window;
  globalThis.window = win;
  try {
    return fn();
  } finally {
    if (had) globalThis.window = prev;
    else delete globalThis.window;
  }
}

test('window.chrome gets app, csi and loadTimes (Google sign-in needs chrome.app); nothing the page has is replaced', async () => {
  const own = () => 'own';
  const win = { chrome: { csi: own } }; // Electron gives pages an empty window.chrome
  withWindow(win, () => installChromeApi());
  const c = win.chrome;
  assert.equal(c.csi, own);
  assert.equal(typeof c.loadTimes, 'function');
  assert.equal(c.app.isInstalled, false);
  assert.equal(c.app.getDetails(), null);
  assert.equal(c.app.getIsInstalled(), false);
  assert.equal(c.app.runningState(), 'cannot_run');
  assert.equal(c.app.InstallState.NOT_INSTALLED, 'not_installed');
  assert.equal(c.app.RunningState.CANNOT_RUN, 'cannot_run');
  assert.equal(await new Promise((r) => c.app.installState(r)), 'not_installed');
  assert.throws(() => c.app.installState(), TypeError);

  const bare = {};
  withWindow(bare, () => installChromeApi());
  assert.equal(typeof bare.chrome.app, 'object');
  assert.equal(Object.getOwnPropertyDescriptor(bare, 'chrome').configurable, false);
});

test('passkey shim: a conditional request Ludworks passes on stays open; a modal one goes to the platform', async () => {
  const platform = [];
  const C = {
    create: async () => 'platform-create',
    get: async (o) => {
      platform.push(o.mediation || 'modal');
      return 'platform-get';
    },
  };
  function PublicKeyCredential() {}
  const win = { navigator: { credentials: C }, PublicKeyCredential, AuthenticatorAttestationResponse: function () {}, AuthenticatorAssertionResponse: function () {}, DOMException };
  const asked = [];
  const cancelled = [];
  const bridge = {
    create: async () => ({ fallback: true }),
    get: async (json, conditional) => {
      asked.push(conditional);
      return { fallback: true }; // passkeys off, signed out, nothing saved…
    },
    cancel: (id) => cancelled.push(id),
  };
  withWindow(win, () => installWebAuthnShim(bridge));
  const challenge = new Uint8Array([1, 2, 3]);
  const ac = new AbortController();
  // Google's sign-in page asks like this on every visit
  const cond = C.get({ mediation: 'conditional', signal: ac.signal, publicKey: { challenge, rpId: 'google.com' } });
  let settled = false;
  cond.then(
    () => (settled = true),
    () => (settled = true),
  );
  assert.equal(await C.get({ publicKey: { challenge, rpId: 'google.com' } }), 'platform-get');
  await settle(20);
  assert.equal(settled, false);
  assert.deepEqual(platform, ['modal'], 'the conditional request never reaches the platform (it shows a modal dialog in Electron)');
  ac.abort();
  await assert.rejects(cond, (e) => e.name === 'AbortError');
  assert.deepEqual(asked, [true, false]);
  assert.deepEqual(cancelled, [1]);
});
