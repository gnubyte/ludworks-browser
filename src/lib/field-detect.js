// Login-form field detection and filling.
//
// Written against a deliberately small DOM surface so it can be unit tested with fake documents:
//   Document:   querySelectorAll('*'), location.origin, location.href
//   ShadowRoot: querySelectorAll('*'), host (open shadow roots, reached through element.shadowRoot)
//   Input:      type, name, id, value, disabled, readOnly, form, getAttribute(n), labels?, isConnected,
//               getClientRects(), getBoundingClientRect(), parentElement, nodeType, ownerDocument.defaultView,
//               parentNode / assignedSlot (shadow DOM, optional)
//   Frame:      contentDocument (null / throws for cross-origin frames)
// Fields inside open shadow roots (web components, nested to any depth) are found in composed-tree order.
// No innerHTML, no page-world script execution; everything runs in the content script's isolated world.

const MAX_FIELDS = 500;
const MAX_FRAMES = 20;
const MAX_FRAME_DEPTH = 3;
const MAX_NODES = 60000; // elements visited per document (incl. shadow trees): bounds the cost on huge pages
const MAX_SHADOW_DEPTH = 32;

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
 * Parent in the composed (flattened) tree: a slotted node's slot, else its parent element, else — at the top
 * of a shadow tree — the shadow host.
 * @param {any} node
 * @returns {any}
 */
export function composedParent(node) {
  if (!node) return null;
  try {
    if (node.assignedSlot) return node.assignedSlot;
    if (node.parentElement) return node.parentElement;
    const p = node.parentNode;
    return p && p.nodeType === 11 && p.host ? p.host : null;
  } catch {
    return null;
  }
}

/**
 * The form a field belongs to: its own form owner, or — for an input inside a shadow root (a web component
 * text field) — the closest <form> around it in the composed tree. Light-DOM inputs keep `el.form`.
 */
function formOf(el, root, doc) {
  if (el.form) return el.form;
  if (!root || root === doc) return null;
  let n = composedParent(el);
  for (let i = 0; n && i < 256; i++, n = composedParent(n)) {
    if (String(n.tagName).toUpperCase() === 'FORM') return n;
  }
  return null;
}

/**
 * Describe one input element.
 * @returns {FieldInfo}
 * @typedef {{el: any, doc: any, root: any, index: number, depth: number, type: string, name: string, id: string,
 *   autocomplete: string[], hint: string, form: any, group: any, maxLength: number, value: string,
 *   visible: boolean, disabled: boolean, readOnly: boolean, inputMode: string}} FieldInfo
 */
function describe(el, doc, index, depth, isVisible, root = doc) {
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
  const form = formOf(el, root, doc);
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
    root,
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
    inputMode: attr(el, 'inputmode').toLowerCase(),
  };
}

const defaultShadowRoot = (el) => {
  try {
    const sr = el.shadowRoot; // open shadow roots only (closed ones are private to the page)
    return sr && typeof sr.querySelectorAll === 'function' ? sr : null;
  } catch {
    return null;
  }
};

/**
 * Inputs and frames of a document, including those inside (nested) open shadow roots, in composed-tree order:
 * a shadow tree's contents are listed at its host's position.
 * @param {any} doc
 * @param {(el: any) => any} shadowOf
 * @returns {{inputs: Array<{el: any, root: any}>, frames: any[], roots: any[]}}
 */
export function walkDocument(doc, shadowOf = defaultShadowRoot) {
  const inputs = [];
  const frames = [];
  const roots = [];
  let budget = MAX_NODES;
  const visit = (root, depth) => {
    let all;
    try {
      all = root.querySelectorAll('*');
    } catch {
      return;
    }
    for (const el of toArray(all)) {
      if (--budget < 0) return;
      const tag = String(el.tagName).toUpperCase(); // lower-case in XHTML documents
      if (tag === 'INPUT') inputs.push({ el, root });
      else if (tag === 'IFRAME' || tag === 'FRAME') frames.push(el);
      if (depth < MAX_SHADOW_DEPTH) {
        const sr = shadowOf(el);
        if (sr) {
          roots.push(sr);
          visit(sr, depth + 1);
        }
      }
    }
  };
  visit(doc, 0);
  return { inputs, frames, roots };
}

/**
 * Collect input fields from `doc` (open shadow roots included) and its *same-origin*, visible iframes, in
 * document order.
 * @param {any} doc
 * @param {{isVisible?: (el: any) => boolean, shadowRoot?: (el: any) => any}} [env]
 * @returns {FieldInfo[]}
 */
export function collectFields(doc, env = {}) {
  const isVisible = env.isVisible || ((el) => isElementVisible(el));
  const shadowOf = env.shadowRoot || defaultShadowRoot;
  const topOrigin = originOf(doc);
  const out = [];
  const seen = new Set();
  const walk = (d, depth) => {
    if (!d || seen.has(d) || seen.size >= MAX_FRAMES) return;
    seen.add(d);
    const { inputs, frames } = walkDocument(d, shadowOf);
    for (const { el, root } of inputs) {
      if (out.length >= MAX_FIELDS) return;
      out.push(describe(el, d, out.length, depth, isVisible, root));
    }
    if (depth >= MAX_FRAME_DEPTH) return;
    for (const frame of frames) {
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
 * @returns {{username: FieldInfo|null, password: FieldInfo|null, totp: FieldInfo|null, totpBoxes: FieldInfo[],
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

  const totpBoxes = pickOtpBoxes(usable);
  const textual = usable.filter((f) => USERNAME_TYPES.has(f.type) && !isSearchField(f) && !isOtpField(f) && !totpBoxes.includes(f));
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
  else if (totp || totpBoxes.length) mode = 'totp';
  return { username, password, totp, totpBoxes: totp ? [] : totpBoxes, newPasswords, mode };
}

/**
 * A one-time code split over 4–8 adjacent one-character boxes (banks, Steam, many sign-in flows): the boxes,
 * in order, or [] when there are none. At least one box must look like a code field (one-time-code,
 * OTP-ish name/label, or numeric keyboard).
 * @param {FieldInfo[]} usable
 * @returns {FieldInfo[]}
 */
function pickOtpBoxes(usable) {
  const boxes = usable.filter((f) => TOTP_TYPES.has(f.type) && f.maxLength === 1);
  let run = [];
  const runs = [];
  for (const f of boxes) {
    const prev = run[run.length - 1];
    if (prev && f.index === prev.index + 1 && f.group === prev.group && f.doc === prev.doc) run.push(f);
    else {
      if (run.length) runs.push(run);
      run = [f];
    }
  }
  if (run.length) runs.push(run);
  const codeLike = (f) => isOtpField(f) || f.inputMode === 'numeric' || f.type === 'tel' || f.type === 'number';
  return runs.find((r) => r.length >= 4 && r.length <= 8 && r.some(codeLike)) || [];
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
  // Ancestors in the composed tree: through shadow roots up to the host, so a transparent / hidden web
  // component hides the inputs inside it too.
  let node = el;
  for (let depth = 0; node && node.nodeType === 1 && depth < 64; depth++) {
    const cs = w.getComputedStyle(node);
    if (!cs) return false;
    if (cs.display === 'none') return false;
    if (depth === 0 && (cs.visibility === 'hidden' || cs.visibility === 'collapse')) return false;
    if (cs.contentVisibility === 'hidden') return false;
    const op = parseFloat(cs.opacity);
    if (Number.isFinite(op) && op < 0.05) return false;
    node = composedParent(node);
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
  // An InputEvent like the browser's own autofill / autocomplete replacement (some input libraries look at
  // inputType); a plain Event where InputEvent does not exist.
  let input = null;
  try {
    if (typeof w.InputEvent === 'function') input = new w.InputEvent('input', { bubbles: true, composed: true, inputType: 'insertReplacementText' });
  } catch {
    input = null;
  }
  el.dispatchEvent(input || new EventCtor('input', { bubbles: true, composed: true }));
  el.dispatchEvent(new EventCtor('change', { bubbles: true }));
}
