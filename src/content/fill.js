// Injected on demand (scripting.executeScript, top frame of the active tab only) after the user clicked
// "Fill" or pressed the fill shortcut. Exposes one function in the extension's isolated world; the page
// cannot see or call it. Every safety check is repeated here, inside the page, right before filling.

import { ruleMatches, pageSecurity } from '../lib/url-match.js';
import { collectFields, detectLoginFields, fillField, formActionInsecure } from '../lib/field-detect.js';

function fail(error) {
  return { ok: false, error };
}

function frameUrlOk(field, uris) {
  if (!field || field.depth === 0) return true;
  try {
    const href = field.doc.location.href;
    return uris.some((r) => ruleMatches(href, r));
  } catch {
    return false;
  }
}

function fill(payload) {
  try {
    if (!payload || typeof payload !== 'object') return fail('fill_failed');
    if (window.top !== window) return fail('fill_failed');
    if (location.origin !== payload.expectedOrigin) return fail('origin_changed');
    const sec = pageSecurity(location.href);
    if (sec === 'insecure' || (sec === 'insecure_localhost' && payload.allowInsecure !== true)) {
      return fail('insecure_page');
    }
    const uris = Array.isArray(payload.uris) ? payload.uris : [];
    if (!uris.some((r) => ruleMatches(location.href, r))) return fail('uri_mismatch');

    const det = detectLoginFields(collectFields(document));
    if (det.mode === 'signup') return fail('signup_form');
    const targets = [det.username, det.password, det.totp].filter(Boolean);
    if (!targets.length) return fail('no_fields');
    for (const f of targets) {
      if (formActionInsecure(f)) return fail('insecure_form');
      if (!frameUrlOk(f, uris)) return fail('uri_mismatch');
    }

    const filled = { username: false, password: false, totp: false };
    if (det.username && typeof payload.username === 'string' && payload.username) {
      fillField(det.username.el, payload.username);
      filled.username = true;
    }
    if (det.password && typeof payload.password === 'string' && payload.password) {
      fillField(det.password.el, payload.password);
      filled.password = true;
    }
    if (det.totp && typeof payload.totp === 'string' && /^[0-9A-Z]{5,8}$/.test(payload.totp)) {
      fillField(det.totp.el, payload.totp);
      filled.totp = true;
    }
    if (!filled.username && !filled.password && !filled.totp) return fail('no_fields');
    const focusField = det.password || det.totp || det.username;
    try {
      focusField.el.focus({ preventScroll: false });
    } catch {
      /* ignore */
    }
    return { ok: true, filled };
  } catch {
    return fail('fill_failed');
  }
}

globalThis.__ludworksFill = fill;
