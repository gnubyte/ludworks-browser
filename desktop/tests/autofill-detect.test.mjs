// Login field detection on real-world page shapes (shared src/lib/field-detect.js, staged copy): web components
// with open shadow roots (reddit.com-style nested form-associated fields), one-time codes split over boxes,
// and the events a fill dispatches. Uses the extension's tiny fake DOM (tests/helpers/fake-dom.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { collectFields, detectLoginFields, extractCredentials, isElementVisible, fillField, walkDocument } from '../build/app/lib/field-detect.js';
import { FakeDocument } from '../../tests/helpers/fake-dom.mjs';

const detect = (doc) => detectLoginFields(collectFields(doc, { isVisible: (el) => isElementVisible(el) }));
const nameOf = (f) => (f ? f.el.getAttribute('name') || f.el.getAttribute('id') : null);

/** <text-field>: a custom element whose <input> lives in its own open shadow root. */
function textField(doc, attrs) {
  const host = doc.el('text-field', {});
  const root = host.attachShadow({ mode: 'open' });
  const input = doc.el('input', attrs);
  root.append(doc.el('label', {}), input);
  return { host, input };
}

test('a login form inside an open shadow root is detected and filled', () => {
  const doc = new FakeDocument({ origin: 'https://www.reddit.com' });
  const card = doc.el('login-card', {});
  doc.body.append(doc.el('h1', {}), card);
  const root = card.attachShadow({ mode: 'open' });
  root.append(doc.el('form', { action: '/login' }, doc.el('input', { type: 'text', name: 'username', autocomplete: 'username' }), doc.el('input', { type: 'password', name: 'password', autocomplete: 'current-password' })));
  const d = detect(doc);
  assert.equal(d.mode, 'login');
  assert.equal(nameOf(d.username), 'username');
  assert.equal(nameOf(d.password), 'password');
  assert.equal(d.password.doc, doc, 'fields keep their owner document (URI / form-action checks)');
  assert.equal(d.password.root, root);
  assert.equal(d.password.form.tagName, 'FORM');
});

test('nested shadow roots: form-associated text fields inside an app shadow root (reddit.com)', () => {
  const doc = new FakeDocument({ origin: 'https://www.reddit.com' });
  const app = doc.el('auth-flow', {});
  doc.body.append(app);
  const appRoot = app.attachShadow({ mode: 'open' });
  const user = textField(doc, { type: 'text', name: 'username', autocomplete: 'username webauthn' });
  const pass = textField(doc, { type: 'password', name: 'password', autocomplete: 'current-password' });
  const form = doc.el('form', { action: '/svc/shreddit/account/login' }, user.host, pass.host, doc.el('button', { type: 'submit' }));
  appRoot.append(form);
  const d = detect(doc);
  assert.equal(d.mode, 'login');
  assert.equal(d.username.el, user.input);
  assert.equal(d.password.el, pass.input);
  assert.equal(d.password.form, form, 'the form around the host owns fields in nested shadow roots');
  // capture on submit of that form (the submit event fires inside the shadow root)
  user.input.value = 'someone@example.com';
  pass.input.value = 'Not-A-Real-Password-123!';
  assert.deepEqual(extractCredentials(collectFields(doc, { isVisible: () => true }), form), { username: 'someone@example.com', password: 'Not-A-Real-Password-123!' });
});

test('shadow-root fields are listed at their host position (composed-tree order)', () => {
  const doc = new FakeDocument();
  const user = textField(doc, { type: 'email', name: 'email' });
  doc.body.append(doc.el('form', {}, user.host, doc.el('input', { type: 'password', name: 'pw' })));
  const fields = collectFields(doc, { isVisible: () => true });
  assert.deepEqual(fields.map((f) => f.name), ['email', 'pw']);
  const d = detect(doc);
  assert.equal(nameOf(d.username), 'email', 'the email in the shadow root precedes the password');
  assert.equal(nameOf(d.password), 'pw');
});

test('closed shadow roots stay private; a custom shadowRoot lookup can reach them', () => {
  const doc = new FakeDocument();
  const host = doc.el('secret-login', {});
  doc.body.append(host);
  const root = host.attachShadow({ mode: 'closed' });
  root.append(doc.el('input', { type: 'password', name: 'pw' }));
  assert.equal(detect(doc).mode, 'none');
  const fields = collectFields(doc, { isVisible: () => true, shadowRoot: (el) => (el === host ? root : null) });
  assert.equal(detectLoginFields(fields).mode, 'password');
});

test('a hidden or transparent web component hides the inputs inside it', () => {
  for (const style of [{ display: 'none' }, { opacity: 0 }]) {
    const doc = new FakeDocument();
    const host = doc.el('login-card', {});
    Object.assign(host.style, style);
    doc.body.append(host);
    host.attachShadow({ mode: 'open' }).append(doc.el('input', { type: 'text', name: 'u' }), doc.el('input', { type: 'password', name: 'p' }));
    assert.equal(detect(doc).mode, 'none', JSON.stringify(style));
  }
});

test('frames inside shadow roots are found too', () => {
  const doc = new FakeDocument();
  const host = doc.el('auth-widget', {});
  doc.body.append(host);
  const frame = doc.el('iframe', {});
  host.attachShadow({ mode: 'open' }).append(frame);
  assert.deepEqual(walkDocument(doc).frames, [frame]);
  const inner = new FakeDocument({ origin: 'https://example.com', path: '/frame' });
  inner.body.append(inner.el('input', { type: 'password', name: 'framed' }));
  frame.contentDocument = inner;
  assert.equal(nameOf(detect(doc).password), 'framed');
});

test('one-time codes split over 4–8 single-character boxes', () => {
  const boxes = (doc, n, attrs = {}) => Array.from({ length: n }, (_, i) => doc.el('input', { maxlength: '1', inputmode: 'numeric', 'aria-label': `Digit ${i + 1}`, ...attrs }));
  const doc = new FakeDocument();
  const six = boxes(doc, 6);
  doc.body.append(doc.el('form', {}, ...six));
  const d = detect(doc);
  assert.equal(d.mode, 'totp');
  assert.equal(d.totp, null);
  assert.deepEqual(d.totpBoxes.map((f) => f.el), six);
  assert.equal(d.username, null, 'code boxes are never a username');

  const three = new FakeDocument();
  three.body.append(three.el('form', {}, ...boxes(three, 3)));
  assert.equal(detect(three).totpBoxes.length, 0, 'too few boxes');

  const plain = new FakeDocument();
  plain.body.append(plain.el('form', {}, ...boxes(plain, 6, { inputmode: 'text' })));
  assert.equal(detect(plain).totpBoxes.length, 0, 'single-character text boxes without any code hint');

  const both = new FakeDocument();
  both.body.append(both.el('form', {}, both.el('input', { type: 'text', name: 'otp', autocomplete: 'one-time-code', maxlength: '6' })), both.el('form', {}, ...boxes(both, 6)));
  const db = detect(both);
  assert.equal(nameOf(db.totp), 'otp', 'a single code field wins');
  assert.deepEqual(db.totpBoxes, []);
});

test('fillField dispatches an InputEvent (insertReplacementText) when the page has InputEvent', () => {
  const doc = new FakeDocument();
  const input = doc.el('input', { type: 'text', name: 'user' });
  doc.body.append(input);
  class InputEvent {
    constructor(type, init) {
      this.type = type;
      Object.assign(this, init);
    }
  }
  doc.defaultView.InputEvent = InputEvent;
  const seen = [];
  input.dispatchEvent = (e) => seen.push(e);
  fillField(input, 'alice');
  assert.equal(input.value, 'alice');
  assert.equal(seen.length, 2);
  assert.ok(seen[0] instanceof InputEvent);
  assert.equal(seen[0].inputType, 'insertReplacementText');
  assert.equal(seen[0].bubbles, true);
  assert.equal(seen[0].composed, true, 'reaches listeners outside the shadow root');
  assert.equal(seen[0].data, undefined, 'the value itself is not put on the event');
  assert.equal(seen[1].type, 'change');
});
