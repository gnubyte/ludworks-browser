// Autofill in web pages (isolated world of the tab preload, every frame).
//
// * Reports which kind of login form the frame has, and focus on login fields (with the field's
//   position in the top-level viewport, when it can be computed) so the browser can show its own
//   autofill dropdown — drawn by the browser over the page, never inside the page's DOM.
// * Fills only what the browser sends after the user picked a login, with the same checks as the
//   Ludworks Passwords extension: secure page, matching URI rules, visible fields, no insecure form
//   action, no sign-up forms, top frame or a frame matching the login's URIs.
// * Reports trusted (user-initiated) submissions so the browser can offer to save the login.

import { collectFields, detectLoginFields, fillField, formActionInsecure, extractCredentials } from '../../../../src/lib/field-detect.js';
import { ruleMatches, pageSecurity } from '../../../../src/lib/url-match.js';

export function setupAutofill() {
  const { ipcRenderer } = require('electron');
  if (location.protocol !== 'https:' && location.protocol !== 'http:') return;

  let lastSig = '';
  let scanTimer = null;
  let lastKey = '';
  let lastAt = 0;

  function detect() {
    try {
      return detectLoginFields(collectFields(document));
    } catch {
      return null;
    }
  }

  function scan() {
    scanTimer = null;
    const det = detect();
    if (!det) return;
    const sig = `${det.mode}|${!!det.username}|${!!det.password}|${!!det.totp}|${det.newPasswords.length}`;
    if (sig === lastSig) return;
    lastSig = sig;
    ipcRenderer.send('content', 'forms', { mode: det.mode, url: location.href });
  }
  const schedule = () => {
    if (!scanTimer) scanTimer = setTimeout(scan, 350);
  };
  document.addEventListener('DOMContentLoaded', schedule);
  window.addEventListener('load', schedule);
  try {
    new MutationObserver(schedule).observe(document, { childList: true, subtree: true });
  } catch {
    /* very early: DOMContentLoaded still triggers a scan */
  }

  // ---------------------------------------------------------------------------- focus → dropdown
  function viewportRect(el) {
    const r = el.getBoundingClientRect();
    let x = r.left;
    let y = r.top;
    try {
      for (let w = window; w !== w.top; w = w.parent) {
        const fe = w.frameElement; // null for cross-origin parents
        if (!fe) return null;
        const fr = fe.getBoundingClientRect();
        x += fr.left + (fe.clientLeft || 0);
        y += fr.top + (fe.clientTop || 0);
      }
    } catch {
      return null;
    }
    return { x, y, width: r.width, height: r.height };
  }

  document.addEventListener(
    'focusin',
    (e) => {
      const el = e.target;
      if (!e.isTrusted || !el || el.tagName !== 'INPUT') return;
      const det = detect();
      if (!det || det.mode === 'none') return;
      let kind = null;
      if (det.username && det.username.el === el) kind = 'username';
      else if (det.password && det.password.el === el) kind = det.mode === 'signup' ? 'new-password' : 'password';
      else if (det.totp && det.totp.el === el) kind = 'totp';
      else if (det.newPasswords.some((f) => f.el === el)) kind = 'new-password';
      if (!kind) return;
      const webauthn = (el.getAttribute('autocomplete') || '').toLowerCase().split(/\s+/).includes('webauthn');
      ipcRenderer.send('content', 'field-focus', { kind, mode: det.mode, rect: viewportRect(el), url: location.href, webauthn });
    },
    true,
  );
  document.addEventListener(
    'focusout',
    (e) => {
      if (e.isTrusted && e.target && e.target.tagName === 'INPUT') ipcRenderer.send('content', 'field-blur', {});
    },
    true,
  );
  document.addEventListener(
    'keydown',
    (e) => {
      if (!e.isTrusted || !e.target || e.target.tagName !== 'INPUT') return;
      if (e.key === 'ArrowDown' || e.key === 'Escape') ipcRenderer.send('content', 'field-key', { key: e.key });
    },
    true,
  );

  // -------------------------------------------------------------------------------------- fill
  function fill(p) {
    if (!p || typeof p !== 'object') return { ok: false, error: 'fill_failed' };
    if (location.href !== p.expectedUrl && new URL(location.href).origin !== p.expectedOrigin) return { ok: false, error: 'origin_changed' };
    const sec = pageSecurity(location.href);
    if (sec === 'insecure' || (sec === 'insecure_localhost' && p.allowInsecure !== true)) return { ok: false, error: 'insecure_page' };
    const uris = Array.isArray(p.uris) ? p.uris : [];
    if (p.mode !== 'generate' && !uris.some((r) => ruleMatches(location.href, r))) return { ok: false, error: 'uri_mismatch' };
    const det = detect();
    if (!det) return { ok: false, error: 'no_fields' };
    if (p.mode === 'generate') {
      const targets = det.newPasswords.length ? det.newPasswords : det.password ? [det.password] : [];
      if (!targets.length) return { ok: false, error: 'no_fields' };
      for (const f of targets) if (formActionInsecure(f)) return { ok: false, error: 'insecure_form' };
      for (const f of targets) fillField(f.el, p.password);
      return { ok: true };
    }
    if (det.mode === 'signup') return { ok: false, error: 'signup_form' };
    const targets = [det.username, det.password, det.totp].filter(Boolean);
    if (!targets.length) return { ok: false, error: 'no_fields' };
    for (const f of targets) if (formActionInsecure(f)) return { ok: false, error: 'insecure_form' };
    let any = false;
    if (det.username && p.username) {
      fillField(det.username.el, p.username);
      any = true;
    }
    if (det.password && p.password) {
      fillField(det.password.el, p.password);
      any = true;
    }
    if (det.totp && typeof p.totp === 'string' && /^[0-9A-Z]{5,8}$/.test(p.totp)) {
      fillField(det.totp.el, p.totp);
      any = true;
    }
    if (!any) return { ok: false, error: 'no_fields' };
    try {
      (det.password || det.totp || det.username).el.focus({ preventScroll: false });
    } catch {
      /* ignore */
    }
    return { ok: true };
  }
  ipcRenderer.on('lw-fill', (_e, payload) => {
    let res;
    try {
      res = fill(payload);
    } catch {
      res = { ok: false, error: 'fill_failed' };
    }
    ipcRenderer.send('content', 'fill-result', { id: payload && payload.id, ...res });
  });

  // ---------------------------------------------------------------------------------- capture
  const scopeFor = (node) => (node && typeof node.closest === 'function' ? node.closest('form') : null);
  function onSubmitLike(scope) {
    let creds;
    try {
      creds = extractCredentials(collectFields(document, { isVisible: () => true }), scope);
    } catch {
      return;
    }
    if (!creds || !creds.password) return;
    const key = `${creds.username.length}:${creds.username}|${creds.password.length}`;
    if (key === lastKey && Date.now() - lastAt < 5000) return;
    lastKey = key;
    lastAt = Date.now();
    ipcRenderer.send('content', 'submitted', { username: creds.username, password: creds.password, url: location.href });
  }
  document.addEventListener('submit', (e) => e.isTrusted && onSubmitLike(scopeFor(e.target) || e.target), true);
  document.addEventListener(
    'click',
    (e) => {
      if (!e.isTrusted || !e.target || typeof e.target.closest !== 'function') return;
      const btn = e.target.closest('button, input[type="submit"], input[type="button"], [role="button"]');
      if (!btn) return;
      const scope = scopeFor(btn);
      if (!(scope || document).querySelector('input[type="password"]')) return;
      onSubmitLike(scope);
    },
    true,
  );
  document.addEventListener(
    'keydown',
    (e) => {
      if (e.isTrusted && e.key === 'Enter' && e.target && e.target.tagName === 'INPUT') onSubmitLike(scopeFor(e.target));
    },
    true,
  );
}
