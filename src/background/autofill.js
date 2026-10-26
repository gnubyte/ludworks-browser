// On-demand autofill: injects content/fill.js into the TOP frame of the active tab only after an explicit
// user action (popup "Fill" button or the fill-login shortcut; both grant activeTab). The content script
// re-verifies origin, HTTPS and the item's URI rules inside the page before touching any field.

import { ApiError } from '../lib/api.js';
import { pageSecurity, parseHttpUrl } from '../lib/url-match.js';

const FILL_SCRIPT = 'content/fill.js';

const FILL_ERRORS = {
  not_ready: 'Could not prepare this page for filling.',
  origin_changed: 'The page changed while filling. Try again.',
  insecure_page: 'Ludworks only fills on HTTPS pages.',
  insecure_form: 'This login form submits over plain HTTP, so Ludworks refused to fill it.',
  uri_mismatch: 'This login is not saved for this website.',
  no_fields: 'No login form was found on this page.',
  signup_form: 'This looks like a sign-up or change-password form; use Copy instead.',
  fill_failed: 'Filling failed on this page.',
};

/**
 * Decide whether a tab URL may be filled, before injecting anything.
 * @param {string} url
 * @param {boolean} allowInsecure  user confirmed filling on http://localhost
 * @returns {{ok: true, origin: string} | {ok: false, code: string, localhost?: boolean}}
 */
export function preflight(url, allowInsecure) {
  const u = parseHttpUrl(url);
  if (!u) return { ok: false, code: 'unsupported_page' };
  const sec = pageSecurity(url);
  if (sec === 'insecure') return { ok: false, code: 'insecure_page', localhost: false };
  if (sec === 'insecure_localhost' && !allowInsecure) return { ok: false, code: 'insecure_page', localhost: true };
  return { ok: true, origin: u.origin };
}

/**
 * Fill credentials into a tab.
 * @param {any} ext  WebExtension namespace
 * @param {{id: number, url: string}} tab
 * @param {{username: string, password: string, totp: string, uris: Array}} creds
 * @param {{allowInsecure?: boolean}} [opts]
 * @returns {Promise<{filled: {username: boolean, password: boolean, totp: boolean}}>}
 */
export async function fillTab(ext, tab, creds, { allowInsecure = false } = {}) {
  const pre = preflight(tab.url, allowInsecure);
  if (!pre.ok) {
    if (pre.code === 'unsupported_page') {
      throw new ApiError({ code: 'unsupported_page', message: 'Ludworks can only fill on websites (http/https).' });
    }
    throw new ApiError({
      code: pre.code,
      message: pre.localhost
        ? 'This page is not using HTTPS. Confirm to fill on this local page anyway.'
        : FILL_ERRORS.insecure_page,
      details: { localhost: !!pre.localhost },
    });
  }
  const target = { tabId: tab.id, frameIds: [0] };
  let results;
  try {
    await ext.scripting.executeScript({ target, files: [FILL_SCRIPT] });
    results = await ext.scripting.executeScript({
      target,
      func: (payload) => {
        const f = globalThis.__ludworksFill;
        return typeof f === 'function' ? f(payload) : { ok: false, error: 'not_ready' };
      },
      args: [
        {
          username: creds.username,
          password: creds.password,
          totp: creds.totp,
          uris: creds.uris,
          expectedOrigin: pre.origin,
          allowInsecure: !!allowInsecure,
        },
      ],
    });
  } catch (e) {
    throw new ApiError({
      code: 'injection_failed',
      message: 'This page cannot be filled (browser pages, extension stores and some protected sites are off-limits).',
      details: { cause: String((e && e.message) || e) },
    });
  }
  const r = results && results[0] ? results[0].result : null;
  if (!r || typeof r !== 'object') throw new ApiError({ code: 'fill_failed', message: FILL_ERRORS.fill_failed });
  if (!r.ok) {
    const code = typeof r.error === 'string' && FILL_ERRORS[r.error] ? r.error : 'fill_failed';
    throw new ApiError({ code, message: FILL_ERRORS[code] });
  }
  return { filled: { username: !!r.filled?.username, password: !!r.filled?.password, totp: !!r.filled?.totp } };
}
