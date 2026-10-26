// Login-form field detection and filling.
//
// Written against a deliberately small DOM surface so it can be unit tested with fake documents:
//   Document: querySelectorAll('input') / querySelectorAll('iframe, frame'), location.origin, location.href
//   Input:    type, name, id, value, disabled, readOnly, form, getAttribute(n), labels?, isConnected,
//             getClientRects(), getBoundingClientRect(), parentElement, nodeType, ownerDocument.defaultView
//   Frame:    contentDocument (null / throws for cross-origin frames)
// No innerHTML, no page-world script execution; everything runs in the content script's isolated world.

const MAX_FIELDS = 500;
const MAX_FRAMES = 20;
const MAX_FRAME_DEPTH = 3;

const USERNAME_TYPES = new Set(['text', 'email', 'tel', 'username', '']);
const TOTP_TYPES = new Set(['text', 'tel', 'number', '']);
const USER_RE = /(user(?:name)?|login|e-?mail|account|identifier|member|userid|uname|signin|sign-in|logon)/i;
const SEARCH_RE = /(search|query|filter|keyword)/i;
const OTP_RE = /(one[-_ ]?time|otp|totp|2fa|mfa|two[-_ ]?factor|verification[-_ ]?code|auth(?:entication)?[-_ ]?code|security[-_ ]?code|passcode|sms[-_ ]?code|token[-_ ]?code)/i;
const NEW_PW_RE = /(new|confirm|repeat|retype|verify|again|re-?enter|create)/i;

function toArray(list) {
  if (!list) return [];
  return Array.from(list);
}

function attr(el, name) {
  try {
    const v = el.getAttribute(name);
    return typeof v === 'string' ? v : '';
  } catch {
    return '';
  }
}

function textOf(node) {
  try {
    return String(node.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  } catch {
    return '';
  }
}

function originOf(doc) {
  try {
    const o = doc && doc.location && doc.location.origin;
    return typeof o === 'string' && o !== 'null' ? o : null;
  } catch {
    return null;
  }
}

/**
 * Describe one input element.
 * @returns {FieldInfo}
 * @typedef {{el: any, doc: any, index: number, depth: number, type: string, name: string, id: string,
 *   autocomplete: string[], hint: string, form: any, group: any, maxLength: number, value: string,
 *   visible: boolean, disabled: boolean, readOnly: boolean}} FieldInfo
 */
function describe(el, doc, index, depth, isVisible) {
  const type = (attr(el, 'type') || el.type || 'text').toLowerCase();
  const autocomplete = attr(el, 'autocomplete').toLowerCase().split(/\s+/).filter(Boolean);
  const labels = toArray(el.labels).map(textOf).join(' ');
  const hint = [
    attr(el, 'name'),
    attr(el, 'id'),
    attr(el, 'placeholder'),
    attr(el, 'aria-label'),
    attr(el, 'title'),
    labels,
    autocomplete.join(' '),
  ]
    .join(' ')
    .toLowerCase();
  const form = el.form || null;
  const maxAttr = Number(attr(el, 'maxlength'));
  let visible = false;
  try {
    visible = !!isVisible(el);
  } catch {
    visible = false;
  }
  return {
    el,
    doc,
    index,
    depth,
    type,
    name: attr(el, 'name'),
    id: attr(el, 'id'),
    autocomplete,
    hint,
    form,
    group: form || doc,
    maxLength: Number.isFinite(maxAttr) && maxAttr > 0 ? maxAttr : -1,
    value: typeof el.value === 'string' ? el.value : '',
    visible,
    disabled: !!el.disabled,
    readOnly: !!el.readOnly,
  };
}

/**
 * Collect input fields from `doc` and its *same-origin*, visible iframes, in document order.
 * @param {any} doc
 * @param {{isVisible?: (el: any) => boolean}} [env]
 * @returns {FieldInfo[]}
 */
export function collectFields(doc, env = {}) {
  const isVisible = env.isVisible || ((el) => isElementVisible(el));
  const topOrigin = originOf(doc);
  const out = [];
  const seen = new Set();
  const walk = (d, depth) => {
    if (!d || seen.has(d) || seen.size >= MAX_FRAMES) return;
    seen.add(d);
    for (const el of toArray(d.querySelectorAll('input'))) {
      if (out.length >= MAX_FIELDS) return;
      out.push(describe(el, d, out.length, depth, isVisible));
    }
    if (depth >= MAX_FRAME_DEPTH) return;
    for (const frame of toArray(d.querySelectorAll('iframe, frame'))) {
      let child = null;
      try {
        child = frame.contentDocument;
      } catch {
        child = null;
      }
      if (!child) continue; // cross-origin: not accessible, never filled
      if (!topOrigin || originOf(child) !== topOrigin) continue;
      let frameVisible = false;
      try {
        frameVisible = !!isVisible(frame);
      } catch {
        frameVisible = false;
      }
      if (!frameVisible) continue;
      walk(child, depth + 1);
    }
  };
  walk(doc, 0);
  return out;
}

const has = (f, token) => f.autocomplete.includes(token);
const isSearchField = (f) => f.type === 'search' || (SEARCH_RE.test(f.hint) && !USER_RE.test(f.hint)) || f.name === 'q';
const isOtpField = (f) => has(f, 'one-time-code') || OTP_RE.test(f.hint);
const isNewPassword = (f) => has(f, 'new-password') || (!has(f, 'current-password') && NEW_PW_RE.test(f.hint));

function pickUsername(textual, pw) {
  if (pw) {
    const preceding = textual.filter((f) => f.doc === pw.doc && f.index < pw.index);
    const sameGroup = preceding.filter((f) => f.group === pw.group);
    const explicitSame = sameGroup.filter((f) => has(f, 'username') || has(f, 'email'));
    if (explicitSame.length) return explicitSame[explicitSame.length - 1];
    if (sameGroup.length) return sameGroup[sameGroup.length - 1];
    const hinted = preceding.filter(
      (f) => has(f, 'username') || has(f, 'email') || f.type === 'email' || USER_RE.test(f.hint),
    );
    return hinted.length ? hinted[hinted.length - 1] : null;
  }
  const explicit = textual.filter((f) => has(f, 'username') || has(f, 'email'));
  if (explicit.length) return explicit[0];
  const hinted = textual.filter((f) => f.type === 'email' || USER_RE.test(f.hint));
  if (hinted.length === 1) return hinted[0];
  return hinted.find((f) => f.form) || null;
}

/**
 * Decide which fields to fill.
 * @param {FieldInfo[]} fields
 * @returns {{username: FieldInfo|null, password: FieldInfo|null, totp: FieldInfo|null,
 *   newPasswords: FieldInfo[], mode: 'login'|'password'|'username'|'totp'|'signup'|'none'}}
 */
export function detectLoginFields(fields) {
  const usable = fields.filter((f) => f.visible && !f.disabled && !f.readOnly && f.type !== 'hidden');
  const pwFields = usable.filter((f) => f.type === 'password');
  const newPasswords = pwFields.filter(isNewPassword);

  let password = null;
  const current = pwFields.filter((f) => has(f, 'current-password'));
  if (current.length) {
    password = current[0];
  } else {
    const candidates = pwFields.filter((f) => !newPasswords.includes(f));
    const countIn = (group) => pwFields.filter((f) => f.group === group).length;
    password = candidates.find((f) => countIn(f.group) === 1) || candidates[0] || null;
  }

  const textual = usable.filter((f) => USERNAME_TYPES.has(f.type) && !isSearchField(f) && !isOtpField(f));
  const username = pickUsername(textual, password);

  const totp =
    usable.find(
      (f) =>
        TOTP_TYPES.has(f.type) &&
        f !== username &&
        isOtpField(f) &&
        (f.maxLength === -1 || (f.maxLength >= 6 && f.maxLength <= 10)),
    ) || null;

  let mode = 'none';
  if (password && username) mode = 'login';
  else if (password) mode = 'password';
  else if (pwFields.length && newPasswords.length === pwFields.length) mode = 'signup';
  else if (username) mode = 'username';
  else if (totp) mode = 'totp';
  return { username, password, totp, newPasswords, mode };
}

/**
 * Does the form owning `field` submit to plain http:// while the page is https://?
 * @param {FieldInfo} field
 * @returns {boolean}
 */
export function formActionInsecure(field) {
  if (!field || !field.form) return false;
  const action = attr(field.form, 'action');
  if (!action) return false;
  let pageUrl = '';
  try {
    pageUrl = field.doc.location.href;
  } catch {
    return false;
  }
  try {
    const target = new URL(action, pageUrl);
    return new URL(pageUrl).protocol === 'https:' && target.protocol === 'http:';
  } catch {
    return false;
  }
}

/**
 * Extract submitted credentials (for "offer to save"). Looks only at fields within `scope`
 * (a form, or the whole field list when null).
 * @param {FieldInfo[]} fields
 * @param {any} [scope]  form element / document to restrict to
 * @returns {{username: string, password: string}|null}
 */
export function extractCredentials(fields, scope = null) {
  const inScope = scope ? fields.filter((f) => f.group === scope || f.form === scope) : fields;
  const pw = inScope.filter((f) => f.type === 'password' && !f.disabled && f.value.length > 0);
  if (!pw.length) return null;
  const fresh = pw.filter(isNewPassword);
  let pwField;
  if (fresh.length) pwField = fresh[0];
  else if (pw.length >= 2 && pw[pw.length - 1].value === pw[pw.length - 2].value) pwField = pw[pw.length - 1];
  else pwField = pw[0];

  const textual = inScope.filter(
    (f) =>
      (USERNAME_TYPES.has(f.type) || (f.type === 'hidden' && (has(f, 'username') || has(f, 'email')))) &&
      !isSearchField(f) &&
      !isOtpField(f) &&
      f.value.length > 0 &&
      f.doc === pwField.doc &&
      f.index < pwField.index,
  );
  const explicit = textual.filter((f) => has(f, 'username') || has(f, 'email'));
  const u = explicit.length ? explicit[explicit.length - 1] : textual[textual.length - 1];
  return { username: u ? u.value.slice(0, 512) : '', password: pwField.value.slice(0, 1024) };
}

/**
 * Visibility check that rejects the usual tricks for harvesting autofilled credentials:
 * display:none / visibility:hidden ancestors, opacity ~0, zero-size and off-page positioned inputs.
 * @param {any} el
 * @param {any} [win]
 * @returns {boolean}
 */
export function isElementVisible(el, win) {
  if (!el || el.isConnected === false) return false;
  const w = win || (el.ownerDocument && el.ownerDocument.defaultView);
  if (!w) return false;
  if ((attr(el, 'type') || '').toLowerCase() === 'hidden' || el.hidden) return false;
  const rects = el.getClientRects ? el.getClientRects() : null;
  if (!rects || rects.length === 0) return false;
  const r = el.getBoundingClientRect();
  if (!r || r.width < 2 || r.height < 2) return false;
  const sx = Number(w.scrollX) || 0;
  const sy = Number(w.scrollY) || 0;
  if (r.right + sx <= 0 || r.bottom + sy <= 0) return false;
  let node = el;
  for (let depth = 0; node && node.nodeType === 1 && depth < 64; depth++) {
    const cs = w.getComputedStyle(node);
    if (!cs) return false;
    if (cs.display === 'none') return false;
    if (depth === 0 && (cs.visibility === 'hidden' || cs.visibility === 'collapse')) return false;
    if (cs.contentVisibility === 'hidden') return false;
    const op = parseFloat(cs.opacity);
    if (Number.isFinite(op) && op < 0.05) return false;
    node = node.parentElement;
  }
  return true;
}

/**
 * Set an input's value the way frameworks (React/Vue/Angular) notice, then fire input/change.
 * @param {any} el
 * @param {string} value
 */
export function fillField(el, value) {
  const w = (el.ownerDocument && el.ownerDocument.defaultView) || globalThis;
  try {
    el.focus({ preventScroll: true });
  } catch {
    /* ignore */
  }
  let setter = null;
  try {
    const proto = w.HTMLInputElement && w.HTMLInputElement.prototype;
    const desc = proto && Object.getOwnPropertyDescriptor(proto, 'value');
    setter = desc && desc.set;
  } catch {
    setter = null;
  }
  if (setter) setter.call(el, value);
  else el.value = value;
  const EventCtor = w.Event || globalThis.Event;
  el.dispatchEvent(new EventCtor('input', { bubbles: true, composed: true }));
  el.dispatchEvent(new EventCtor('change', { bubbles: true }));
}
