// Content-side autofill helpers (src/preload/features/autofill.js): event targets and focus inside shadow
// roots, which dropdown a focused field gets, and the geometry used to place the dropdown under fields in
// (cross-origin) frames.
import test from 'node:test';
import assert from 'node:assert/strict';
import { eventTarget, deepActiveElement, closestComposed, fieldKind, frameContentOffset, offsetToReachableTop, childWindowOf, findFrameElement, splitCode } from '../src/preload/features/autofill.js';
import { collectFields, detectLoginFields } from '../../src/lib/field-detect.js';
import { FakeDocument } from '../../tests/helpers/fake-dom.mjs';

test('eventTarget: the real target inside open shadow roots (composedPath), else event.target', () => {
  const inner = { nodeType: 1, tagName: 'INPUT' };
  const host = { nodeType: 1, tagName: 'TEXT-FIELD' };
  assert.equal(eventTarget({ target: host, composedPath: () => [inner, { nodeType: 11 }, host] }), inner);
  assert.equal(eventTarget({ target: host, composedPath: () => [] }), host);
  assert.equal(eventTarget({ target: host }), host);
  assert.equal(eventTarget({ target: host, composedPath: () => { throw new Error('x'); } }), host);
});

test('deepActiveElement descends through shadow roots', () => {
  const input = { tagName: 'INPUT', shadowRoot: null };
  const inner = { tagName: 'TEXT-FIELD', shadowRoot: { activeElement: input } };
  const outer = { tagName: 'AUTH-FLOW', shadowRoot: { activeElement: inner } };
  assert.equal(deepActiveElement({ activeElement: outer }), input);
  assert.equal(deepActiveElement({ activeElement: input }), input);
  assert.equal(deepActiveElement({ activeElement: { tagName: 'X', shadowRoot: { activeElement: null } } }).tagName, 'X');
  assert.equal(deepActiveElement(null), null);
});

test('closestComposed crosses shadow boundaries (button in a shadow root → form around its host)', () => {
  const mk = (tag, parent) => ({ nodeType: 1, tagName: tag, parentElement: parent, matches: (sel) => sel.split(',').map((s) => s.trim().toUpperCase()).includes(tag) });
  const form = mk('FORM', null);
  const host = mk('LOGIN-BUTTON', form);
  const root = { nodeType: 11, host };
  const button = mk('BUTTON', null);
  button.parentNode = root;
  assert.equal(closestComposed(button, 'button'), button);
  assert.equal(closestComposed(button, 'form'), form);
  assert.equal(closestComposed(button, 'table'), null);
});

test('fieldKind: what the dropdown offers for the focused field', () => {
  const doc = new FakeDocument();
  const user = doc.el('input', { type: 'email', name: 'email', autocomplete: 'username' });
  const pass = doc.el('input', { type: 'password', name: 'pw', autocomplete: 'current-password' });
  doc.body.append(doc.el('form', {}, user, pass));
  const det = detectLoginFields(collectFields(doc, { isVisible: () => true }));
  assert.equal(fieldKind(det, user), 'username');
  assert.equal(fieldKind(det, pass), 'password');
  assert.equal(fieldKind(det, doc.el('input', {})), null);
  assert.equal(fieldKind(null, user), null);

  const su = new FakeDocument();
  const email = su.el('input', { type: 'email', name: 'email', autocomplete: 'email' });
  const p1 = su.el('input', { type: 'password', name: 'p1', autocomplete: 'new-password' });
  su.body.append(su.el('form', {}, email, p1, su.el('input', { type: 'password', name: 'p2', autocomplete: 'new-password' })));
  const sdet = detectLoginFields(collectFields(su, { isVisible: () => true }));
  assert.equal(sdet.mode, 'signup');
  assert.equal(fieldKind(sdet, email), null, 'no saved logins under the email field of a sign-up form');
  assert.equal(fieldKind(sdet, p1), 'new-password');

  const otp = new FakeDocument();
  const boxes = Array.from({ length: 6 }, () => otp.el('input', { maxlength: '1', inputmode: 'numeric' }));
  otp.body.append(otp.el('form', {}, ...boxes));
  const odet = detectLoginFields(collectFields(otp, { isVisible: () => true }));
  assert.equal(fieldKind(odet, boxes[3]), 'totp');
});

test('splitCode: one character per box, only when the code fits exactly', () => {
  const six = Array.from({ length: 6 }, () => ({}));
  assert.deepEqual(splitCode('123456', six), ['1', '2', '3', '4', '5', '6']);
  assert.equal(splitCode('12345678', six), null);
  assert.equal(splitCode('123', six.slice(0, 3)), null);
  assert.equal(splitCode('', six), null);
});

// ------------------------------------------------------------------- frame geometry (fake windows)
function frameEl(left, top, { border = 0, padding = 0, win = null } = {}) {
  return {
    clientLeft: border,
    clientTop: border,
    contentWindow: win,
    getBoundingClientRect: () => ({ left, top, width: 400, height: 300 }),
    ownerDocument: { defaultView: { getComputedStyle: () => ({ paddingLeft: `${padding}px`, paddingTop: `${padding}px` }) } },
  };
}

test('frameContentOffset: border box + border + padding', () => {
  assert.deepEqual(frameContentOffset(frameEl(100, 50, { border: 1, padding: 4 })), { x: 105, y: 55 });
  assert.deepEqual(frameContentOffset(frameEl(10, 20)), { x: 10, y: 20 });
});

test('offsetToReachableTop: sums same-origin frame offsets, stops below a cross-origin parent', () => {
  const top = {};
  top.top = top;
  top.parent = top;
  // top → A (same-origin, at 100,50) → B (same-origin inside A, at 10,20)
  const a = { top, parent: top, frameElement: frameEl(100, 50, { border: 2 }) };
  const b = { top, parent: a, frameElement: frameEl(10, 20) };
  assert.deepEqual(offsetToReachableTop(b), { x: 112, y: 72, win: top, top: true });
  assert.deepEqual(offsetToReachableTop(top), { x: 0, y: 0, win: top, top: true });
  // top → X (cross-origin: frameElement is null) → C (same-origin with X, at 5,6)
  const x = { top, parent: top, frameElement: null };
  const c = { top, parent: x, frameElement: frameEl(5, 6) };
  const r = offsetToReachableTop(c);
  assert.equal(r.top, false);
  assert.equal(r.win, x, 'the probe is posted to X.parent, from where X is a direct child');
  assert.deepEqual([r.x, r.y], [5, 6]);
});

test('childWindowOf / findFrameElement: locate the <iframe> a probe came through', () => {
  const self = {};
  const child = { parent: self };
  const grandchild = { parent: child };
  assert.equal(childWindowOf(self, child), child);
  assert.equal(childWindowOf(self, grandchild), child, 'a nested sender resolves to our direct child');
  const stranger = {};
  stranger.parent = stranger;
  assert.equal(childWindowOf(self, stranger), null);
  assert.equal(childWindowOf(self, null), null);

  const doc = new FakeDocument();
  const host = doc.el('auth-widget', {});
  const iframe = doc.el('iframe', {});
  const other = doc.el('iframe', {});
  other.contentWindow = {};
  iframe.contentWindow = child;
  host.attachShadow({ mode: 'open' }).append(iframe);
  doc.body.append(other, host);
  assert.equal(findFrameElement(doc, child), iframe, 'iframes inside open shadow roots too');
  assert.equal(findFrameElement(doc, {}), null);
});
