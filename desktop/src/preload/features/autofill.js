// Autofill in web pages (isolated world of the tab preload, every frame).
//
// * Reports which kind of login form the frame has, and focus on login fields (with the field's
//   position in the top-level viewport) so the browser can show its own autofill dropdown — drawn by the
//   browser over the page, never inside the page's DOM. Fields inside open shadow roots (web components)
//   count; clicking an already focused field shows the dropdown again; a field that is focused while its
//   form is still fading in is re-checked shortly after; focus moves caused by a fill (or by the page
//   getting focus back) never reopen it.
// * In a frame below a cross-origin parent the position is completed by its ancestors: the frame posts a
//   probe to its parent, whose preload adds the <iframe> element's offset and reports it (or forwards it
//   further up). The probe carries a random token and coordinates only.
// * Fills only what the browser sends after the user picked a login, with the same checks as the
//   Ludworks Passwords extension: secure page, matching URI rules, visible fields, no insecure form
//   action, no sign-up forms, top frame or a frame matching the login's URIs.
// * Reports trusted (user-initiated) submissions so the browser can offer to save the login.

import { collectFields, detectLoginFields, fillField, formActionInsecure, extractCredentials, walkDocument, composedParent } from '../../../../src/lib/field-detect.js';
import { ruleMatches, pageSecurity } from '../../../../src/lib/url-match.js';

const PROBE = '__ludworksFrameProbe';
const FILL_QUIET_MS = 1500; // focus events caused by a fill (and the tab getting focus back) don't reopen the dropdown
const RETRY_MS = [250, 700, 1500];
const SCAN_MIN_MS = 350;
const SCAN_MAX_MS = 2000;

// ---------------------------------------------------------------------------------- helpers (tested)
/** The real target of an event, inside open shadow roots (at the document it is retargeted to the host). */
export function eventTarget(e) {
  try {
    const path = typeof e.composedPath === 'function' ? e.composedPath() : null;
    if (path && path.length && path[0] && path[0].nodeType === 1) return path[0];
  } catch {
    /* fall through */
  }
  return e.target;
}

/** The focused element, looking into open shadow roots. */
export function deepActiveElement(doc) {
  let a = doc ? doc.activeElement : null;
  for (let i = 0; a && i < 32; i++) {
    const sr = a.shadowRoot;
    if (!sr || !sr.activeElement) break;
    a = sr.activeElement;
  }
  return a;
}

/** Closest ancestor (composed tree, through shadow roots) matching a selector. */
export function closestComposed(el, selector) {
  for (let n = el, i = 0; n && i < 256; n = composedParent(n), i++) {
    try {
      if (n.nodeType === 1 && n.matches(selector)) return n;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * What the browser should offer for a focused field.
 * @returns {'username'|'password'|'new-password'|'totp'|null}
 */
export function fieldKind(det, el) {
  if (!det || det.mode === 'none' || !el) return null;
  if (det.username && det.username.el === el) return det.mode === 'signup' ? null : 'username';
  if (det.password && det.password.el === el) return det.mode === 'signup' ? 'new-password' : 'password';
  if (det.totp && det.totp.el === el) return 'totp';
  if (det.totpBoxes && det.totpBoxes.some((f) => f.el === el)) return 'totp';
  if (det.newPasswords.some((f) => f.el === el)) return 'new-password';
  return null;
}

/** Content-box origin of an <iframe>/<frame> element in its own document's viewport (CSS px). */
export function frameContentOffset(fe) {
  const r = fe.getBoundingClientRect();
  let pl = 0;
  let pt = 0;
  try {
    const cs = fe.ownerDocument.defaultView.getComputedStyle(fe);
    pl = parseFloat(cs.paddingLeft) || 0;
    pt = parseFloat(cs.paddingTop) || 0;
  } catch {
    /* no padding info */
  }
  return { x: r.left + (fe.clientLeft || 0) + pl, y: r.top + (fe.clientTop || 0) + pt };
}

/**
 * Offset of window `w`'s viewport in the viewport of the highest ancestor reachable through same-origin
 * frame elements. `top` is true when that ancestor is the top-level window.
 * @returns {{x: number, y: number, win: any, top: boolean}}
 */
export function offsetToReachableTop(w) {
  let x = 0;
  let y = 0;
  for (let i = 0; i < 16; i++) {
    let isTop = false;
    try {
      isTop = w === w.top;
    } catch {
      isTop = false;
    }
    if (isTop) return { x, y, win: w, top: true };
    let fe = null;
    try {
      fe = w.frameElement; // null when the parent is cross-origin
    } catch {
      fe = null;
    }
    if (!fe) return { x, y, win: w, top: false };
    const o = frameContentOffset(fe);
    x += o.x;
    y += o.y;
    w = w.parent;
  }
  return { x, y, win: w, top: false };
}

/** The child window of `self` that `source` is (or is nested in), walking up `parent` (allowed cross-origin). */
export function childWindowOf(self, source) {
  let w = source;
  for (let i = 0; w && i < 16; i++) {
    let p = null;
    try {
      p = w.parent;
    } catch {
      return null;
    }
    if (p === self) return w;
    if (!p || p === w) return null;
    w = p;
  }
  return null;
}

/** The <iframe>/<frame> element (light DOM or open shadow roots) whose window is `win`. */
export function findFrameElement(doc, win) {
  for (const fe of walkDocument(doc).frames) {
    try {
      if (fe.contentWindow === win) return fe;
    } catch {
      /* next */
    }
  }
  return null;
}

/** The characters of a one-time code to put into split boxes, or null when they cannot hold it. */
export function splitCode(code, boxes) {
  if (typeof code !== 'string' || !boxes || boxes.length < 4 || code.length !== boxes.length) return null;
  return code.split('');
}

function randomToken() {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------------------------------- feature
export function setupAutofill() {
  const { ipcRenderer } = require('electron');
  if (location.protocol !== 'https:' && location.protocol !== 'http:') return;
  const send = (cmd, args) => ipcRenderer.send('content', cmd, args);

  let lastSig = '';
  let scanTimer = null;
  let scanDelay = SCAN_MIN_MS;
  let lastKey = '';
  let lastAt = 0;
  let filling = false;
  let lastFill = 0;
  let filled = new WeakSet(); // fields the last fill wrote (and focused)
  let lastPointer = { el: null, at: 0 }; // last mousedown on an input: its focus is the user's
  let shownFor = null; // field the dropdown was last requested for (until it loses focus / Esc)
  let refocus = null; // field that kept focus while the page lost it (window / browser popup)
  let shadowPassword = false; // the last detection saw a password field inside a shadow root

  // ------------------------------------------------------------------------------------ detection
  const hooked = new WeakSet();
  let observer = null;
  function hookRoot(root) {
    // submit does not cross shadow boundaries and mutations in shadow trees are not seen from the document
    if (!root || hooked.has(root)) return;
    hooked.add(root);
    try {
      root.addEventListener('submit', onSubmitEvent, true);
      if (observer) observer.observe(root, { childList: true, subtree: true });
    } catch {
      /* ignore */
    }
  }
  function hookShadowRootsOf(el) {
    try {
      for (let r = el.getRootNode(), i = 0; r && r.nodeType === 11 && i < 32; r = r.host.getRootNode(), i++) hookRoot(r);
    } catch {
      /* ignore */
    }
  }

  function detect() {
    try {
      const fields = collectFields(document);
      const det = detectLoginFields(fields);
      shadowPassword = false;
      for (const f of fields) {
        if (f.root && f.root.nodeType === 11) {
          hookShadowRootsOf(f.el);
          if (f.type === 'password') shadowPassword = true;
        }
      }
      return det;
    } catch {
      return null;
    }
  }

  function scan() {
    scanTimer = null;
    const det = detect();
    if (!det) return;
    const sig = `${det.mode}|${!!det.username}|${!!det.password}|${!!det.totp}|${det.totpBoxes.length}|${det.newPasswords.length}`;
    if (sig === lastSig) {
      scanDelay = Math.min(SCAN_MAX_MS, Math.round(scanDelay * 1.5)); // busy pages: back off while nothing changes
      return;
    }
    scanDelay = SCAN_MIN_MS;
    lastSig = sig;
    send('forms', { mode: det.mode, url: location.href });
  }
  const schedule = () => {
    if (!scanTimer) scanTimer = setTimeout(scan, scanDelay);
  };
  document.addEventListener('DOMContentLoaded', schedule);
  window.addEventListener('load', schedule);
  try {
    observer = new MutationObserver(schedule);
    observer.observe(document, { childList: true, subtree: true });
  } catch {
    /* very early: DOMContentLoaded still triggers a scan */
  }

  // ---------------------------------------------------------------------------- focus → dropdown
  const isInput = (el) => !!el && String(el.tagName).toUpperCase() === 'INPUT';
  /** Focus on `el` comes from our own fill (or the page reacting to it), not from the user. */
  const quiet = (el) => (filling || Date.now() - lastFill < FILL_QUIET_MS) && filled.has(el);

  /** Ask the browser for its dropdown under `el`. False when `el` is not (yet) a login field. */
  function request(el, cmd = 'field-focus') {
    const det = detect();
    const kind = fieldKind(det, el);
    if (!kind) return false;
    const r = el.getBoundingClientRect();
    const pos = offsetToReachableTop(window);
    const rect = { x: r.left + pos.x, y: r.top + pos.y, width: r.width, height: r.height };
    let offsetToken = null;
    if (!pos.top) {
      // A cross-origin ancestor: let the frames above add their <iframe> offsets.
      offsetToken = randomToken();
      try {
        pos.win.parent.postMessage({ [PROBE]: offsetToken, x: rect.x, y: rect.y }, '*');
      } catch {
        offsetToken = null;
      }
    }
    const webauthn = (el.getAttribute('autocomplete') || '').toLowerCase().split(/\s+/).includes('webauthn');
    send(cmd, { kind, mode: det.mode, rect, offsetToken, url: location.href, webauthn, key: cmd === 'field-key' ? 'ArrowDown' : undefined });
    shownFor = el;
    return true;
  }

  function retryWhileFocused(el) {
    // A login form that is still fading / sliding in (modals, animated sign-in pages) is not "visible" at the
    // moment it gets focus; check again while it keeps focus.
    for (const ms of RETRY_MS) {
      setTimeout(() => {
        if (shownFor === el || quiet(el) || deepActiveElement(document) !== el) return;
        request(el);
      }, ms);
    }
  }

  document.addEventListener(
    'focusin',
    (e) => {
      if (!e.isTrusted) return;
      const el = eventTarget(e);
      if (!isInput(el)) return;
      const back = refocus === el;
      refocus = null;
      if (filling) return; // the fill itself focuses the fields it writes
      const byPointer = lastPointer.el === el && Date.now() - lastPointer.at < 600;
      // The page reacting to our fill, or the tab getting focus back: not a new field focus (a click is).
      if (!byPointer && (back || quiet(el))) return;
      if (!request(el)) retryWhileFocused(el);
    },
    true,
  );
  document.addEventListener(
    'focusout',
    (e) => {
      if (!e.isTrusted) return;
      const el = eventTarget(e);
      if (!isInput(el)) return;
      send('field-blur', {});
      shownFor = null;
      // Still the focused element afterwards: the page itself lost focus (other window, browser UI).
      setTimeout(() => {
        refocus = !document.hasFocus() && deepActiveElement(document) === el ? el : null;
      }, 0);
    },
    true,
  );
  // Clicking a field that already has focus (dropdown dismissed, or the page focused it before the form
  // was visible) shows the dropdown again — like a click into a field that did not have focus.
  document.addEventListener(
    'mousedown',
    (e) => {
      if (!e.isTrusted || e.button !== 0) return;
      const el = eventTarget(e);
      if (!isInput(el)) return;
      lastPointer = { el, at: Date.now() };
      if (deepActiveElement(document) !== el) return; // not focused yet: focusin follows
      refocus = null;
      request(el);
    },
    true,
  );
  document.addEventListener(
    'keydown',
    (e) => {
      if (!e.isTrusted) return;
      const el = eventTarget(e);
      if (!isInput(el)) return;
      if (e.key === 'ArrowDown' && !e.altKey && !e.ctrlKey && !e.metaKey) request(el, 'field-key');
      else if (e.key === 'Escape') {
        shownFor = null; // dismissed: stays closed until the field is clicked or focused again
        send('field-key', { key: 'Escape' });
      }
    },
    true,
  );
  // Typing: the browser narrows the list to matching usernames (or closes it). Password values never leave.
  document.addEventListener(
    'input',
    (e) => {
      if (!e.isTrusted) return;
      const el = eventTarget(e);
      if (!isInput(el) || shownFor !== el) return;
      const isPw = (el.type || '').toLowerCase() === 'password';
      send('field-input', { password: isPw, value: isPw ? '' : String(el.value || '').slice(0, 256) });
    },
    true,
  );

  // The focused field moved (the page, a scroll container or — for a field in a child frame — this frame
  // scrolled): the dropdown would float at the old place, so the browser closes it. When that happens right
  // after the dropdown opened (Tab into a field below the fold, pages scrolling or animating a login form
  // into place), the browser asks the field's frame to place it again once the scrolling stops ('reanchor');
  // not when the user scrolled the page.
  let lastScroll = 0;
  let userScrollAt = 0;
  const userScroll = (e) => {
    if (e.isTrusted) userScrollAt = Date.now();
  };
  window.addEventListener('wheel', userScroll, { capture: true, passive: true });
  window.addEventListener('touchmove', userScroll, { capture: true, passive: true });
  window.addEventListener(
    'scroll',
    (e) => {
      const a = document.activeElement; // the field, the <iframe> holding it, or a shadow host around it
      if (!a || !(a.tagName === 'INPUT' || a.tagName === 'IFRAME' || a.tagName === 'FRAME' || a.shadowRoot)) return;
      const t = e.target;
      const moved = t === document || t === document.documentElement || t === document.scrollingElement || (!!t && typeof t.contains === 'function' && t.contains(a));
      if (!moved || Date.now() - lastScroll < 100) return;
      lastScroll = Date.now();
      send('page-scroll', {});
    },
    { capture: true, passive: true },
  );
  ipcRenderer.on('lw-autofill', (_e, m) => {
    if (!m || m.cmd !== 'reanchor') return;
    const el = shownFor;
    if (el && deepActiveElement(document) === el && !quiet(el) && Date.now() - userScrollAt > 600) request(el);
  });

  // Frame offset probes from child frames (see the header). Coordinates and a token only.
  window.addEventListener(
    'message',
    (e) => {
      const d = e.data;
      if (!e.isTrusted || !d || typeof d !== 'object' || typeof d[PROBE] !== 'string' || d[PROBE].length > 64) return;
      const x0 = Number(d.x);
      const y0 = Number(d.y);
      if (!Number.isFinite(x0) || !Number.isFinite(y0)) return;
      const child = childWindowOf(window, e.source);
      const fe = child ? findFrameElement(document, child) : null;
      if (!fe) return;
      const o = frameContentOffset(fe);
      const pos = offsetToReachableTop(window);
      const x = x0 + o.x + pos.x;
      const y = y0 + o.y + pos.y;
      if (pos.top) send('frame-offset', { token: d[PROBE], x, y });
      else {
        try {
          pos.win.parent.postMessage({ [PROBE]: d[PROBE], x, y }, '*');
        } catch {
          /* ignore */
        }
      }
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
      filled = new WeakSet(targets.map((f) => f.el));
      for (const f of targets) fillField(f.el, p.password);
      return { ok: true };
    }
    if (det.mode === 'signup') return { ok: false, error: 'signup_form' };
    const targets = [det.username, det.password, det.totp, ...det.totpBoxes].filter(Boolean);
    if (!targets.length) return { ok: false, error: 'no_fields' };
    for (const f of targets) if (formActionInsecure(f)) return { ok: false, error: 'insecure_form' };
    filled = new WeakSet(targets.map((f) => f.el));
    let any = false;
    if (det.username && p.username) {
      fillField(det.username.el, p.username);
      any = true;
    }
    if (det.password && p.password) {
      fillField(det.password.el, p.password);
      any = true;
    }
    const code = typeof p.totp === 'string' && /^[0-9A-Z]{5,8}$/.test(p.totp) ? p.totp : '';
    if (det.totp && code) {
      fillField(det.totp.el, code);
      any = true;
    } else if (code && splitCode(code, det.totpBoxes)) {
      splitCode(code, det.totpBoxes).forEach((c, i) => fillField(det.totpBoxes[i].el, c));
      any = true;
    }
    if (!any) return { ok: false, error: 'no_fields' };
    try {
      const last = det.password || det.totp || det.totpBoxes[det.totpBoxes.length - 1] || det.username;
      last.el.focus({ preventScroll: false });
    } catch {
      /* ignore */
    }
    return { ok: true };
  }
  ipcRenderer.on('lw-fill', (_e, payload) => {
    let res;
    filling = true;
    try {
      res = fill(payload);
    } catch {
      res = { ok: false, error: 'fill_failed' };
    } finally {
      filling = false;
      lastFill = Date.now();
    }
    ipcRenderer.send('content', 'fill-result', { id: payload && payload.id, ...res });
  });

  // ---------------------------------------------------------------------------------- capture
  const scopeFor = (node) => closestComposed(node, 'form');
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
    send('submitted', { username: creds.username, password: creds.password, url: location.href });
  }
  function onSubmitEvent(e) {
    if (e.isTrusted) onSubmitLike(scopeFor(eventTarget(e)) || eventTarget(e));
  }
  const hasPasswordField = () => shadowPassword || !!document.querySelector('input[type="password"]');
  document.addEventListener('submit', onSubmitEvent, true);
  document.addEventListener(
    'click',
    (e) => {
      if (!e.isTrusted) return;
      const t = eventTarget(e);
      if (!t || t.nodeType !== 1) return;
      const btn = closestComposed(t, 'button, input[type="submit"], input[type="button"], [role="button"]');
      if (!btn || !hasPasswordField()) return;
      onSubmitLike(scopeFor(btn));
    },
    true,
  );
  document.addEventListener(
    'keydown',
    (e) => {
      if (!e.isTrusted || e.key !== 'Enter') return;
      const t = eventTarget(e);
      if (isInput(t)) onSubmitLike(scopeFor(t));
    },
    true,
  );
}
