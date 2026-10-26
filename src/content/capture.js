// "Offer to save new logins" (optional feature, registered only after the user enabled it and granted the
// optional host permission). Watches trusted (user-initiated) form submissions and reports the submitted
// credentials to the background, which decides whether they are new.
//
// Nothing is ever shown inside the page: anything in the page's DOM can be hidden, overlaid or
// click-jacked by the page, and a prompt that only appears for new passwords would tell the page whether a
// guessed password is the saved one. The background badges the toolbar button instead and the user
// confirms (Save / Update / Never) in the extension popup. This script receives no answer.

import { collectFields, extractCredentials } from '../lib/field-detect.js';

const ext = globalThis.browser && globalThis.browser.runtime ? globalThis.browser : globalThis.chrome;

let lastKey = '';
let lastAt = 0;

function send(msg) {
  try {
    return Promise.resolve(ext.runtime.sendMessage(msg)).then(
      () => undefined,
      () => undefined,
    );
  } catch {
    return Promise.resolve();
  }
}

function scopeFor(node) {
  const form = node && typeof node.closest === 'function' ? node.closest('form') : null;
  return form || null;
}

async function onSubmitLike(scope) {
  const fields = collectFields(document, { isVisible: () => true });
  const creds = extractCredentials(fields, scope);
  if (!creds || !creds.password) return;
  const key = `${creds.username.length}:${creds.username}|${creds.password.length}`;
  if (key === lastKey && Date.now() - lastAt < 5000) return;
  lastKey = key;
  lastAt = Date.now();
  await send({ type: 'capture.submitted', username: creds.username, password: creds.password });
}

function installListeners() {
  document.addEventListener(
    'submit',
    (e) => {
      if (e.isTrusted) onSubmitLike(scopeFor(e.target) || e.target).catch(() => {});
    },
    true,
  );
  document.addEventListener(
    'click',
    (e) => {
      if (!e.isTrusted || !e.target || typeof e.target.closest !== 'function') return;
      const btn = e.target.closest('button, input[type="submit"], input[type="button"], [role="button"]');
      if (!btn) return;
      const scope = scopeFor(btn);
      const root = scope || document;
      if (!root.querySelector('input[type="password"]')) return;
      onSubmitLike(scope).catch(() => {});
    },
    true,
  );
  document.addEventListener(
    'keydown',
    (e) => {
      if (!e.isTrusted || e.key !== 'Enter' || !e.target || e.target.tagName !== 'INPUT') return;
      onSubmitLike(scopeFor(e.target)).catch(() => {});
    },
    true,
  );
}

if (!globalThis.__ludworksCaptureLoaded) {
  globalThis.__ludworksCaptureLoaded = true;
  installListeners();
  // After a login the page usually navigates; Firefox resets per-tab badges on navigation, so the new page
  // asks the background to show the "login waiting" badge again.
  setTimeout(() => send({ type: 'capture.loaded' }), 400);
}
