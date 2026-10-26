import test from 'node:test';
import assert from 'node:assert/strict';

import {
  collectFields,
  detectLoginFields,
  extractCredentials,
  formActionInsecure,
  isElementVisible,
  fillField,
} from '../src/lib/field-detect.js';
import { FakeDocument, nativeSetCount } from './helpers/fake-dom.mjs';

const visible = (el) => isElementVisible(el);
const detect = (doc) => detectLoginFields(collectFields(doc, { isVisible: visible }));
const nameOf = (f) => (f ? f.el.getAttribute('name') || f.el.getAttribute('id') : null);

function loginForm(doc, extra = {}) {
  const user = doc.el('input', { type: 'text', name: 'user', ...extra.user });
  const pass = doc.el('input', { type: 'password', name: 'pass', ...extra.pass });
  const form = doc.el('form', { action: '/session' }, user, pass, doc.el('button', { type: 'submit' }));
  doc.body.append(form);
  return { form, user, pass };
}

test('classic login form: nearest preceding text input is the username', () => {
  const doc = new FakeDocument();
  doc.body.append(doc.el('input', { type: 'text', name: 'newsletter' }));
  loginForm(doc);
  const d = detect(doc);
  assert.equal(d.mode, 'login');
  assert.equal(nameOf(d.username), 'user');
  assert.equal(nameOf(d.password), 'pass');
});

test('autocomplete attributes win over position', () => {
  const doc = new FakeDocument();
  const email = doc.el('input', { type: 'email', name: 'login_email', autocomplete: 'username' });
  const other = doc.el('input', { type: 'text', name: 'company' });
  const pass = doc.el('input', { type: 'password', name: 'pw', autocomplete: 'current-password' });
  doc.body.append(doc.el('form', {}, email, other, pass));
  const d = detect(doc);
  assert.equal(nameOf(d.username), 'login_email');
  assert.equal(nameOf(d.password), 'pw');
});

test('search boxes and OTP fields are never taken as the username', () => {
  const doc = new FakeDocument();
  const search = doc.el('input', { type: 'search', name: 'q' });
  const s2 = doc.el('input', { type: 'text', name: 'site-search', placeholder: 'Search' });
  doc.body.append(doc.el('form', {}, search, s2, doc.el('input', { type: 'password', name: 'pw' })));
  const d = detect(doc);
  assert.equal(d.username, null);
  assert.equal(d.mode, 'password');
});

test('hidden, invisible, off-page, disabled and read-only fields are never filled', () => {
  const doc = new FakeDocument();
  const hiddenType = doc.el('input', { type: 'hidden', name: 'h_user' });
  const noneUser = doc.el('input', { type: 'text', name: 'none_user' });
  noneUser.style.display = 'none';
  const wrapper = doc.el('div', {}, doc.el('input', { type: 'password', name: 'ghost_pw' }));
  wrapper.style.opacity = 0;
  const offPage = doc.el('input', { type: 'password', name: 'offpage_pw' });
  offPage.rect = { left: -9999, top: 10, width: 200, height: 30 };
  const tiny = doc.el('input', { type: 'password', name: 'tiny_pw' });
  tiny.rect = { left: 10, top: 10, width: 1, height: 1 };
  const invisible = doc.el('input', { type: 'password', name: 'vis_pw' });
  invisible.style.visibility = 'hidden';
  const disabled = doc.el('input', { type: 'password', name: 'dis_pw', disabled: '' });
  const ro = doc.el('input', { type: 'password', name: 'ro_pw', readonly: '' });
  doc.body.append(doc.el('form', {}, hiddenType, noneUser, wrapper, offPage, tiny, invisible, disabled, ro));
  const d = detect(doc);
  assert.equal(d.mode, 'none');
  assert.equal(d.password, null);
  assert.equal(d.username, null);
});

test('a hidden honeypot password next to the real one is ignored', () => {
  const doc = new FakeDocument();
  const { form } = loginForm(doc);
  const trap = doc.el('input', { type: 'password', name: 'trap' });
  trap.style.display = 'none';
  form.append(trap);
  const d = detect(doc);
  assert.equal(nameOf(d.password), 'pass');
});

test('multi-step logins: username-only step, then password-only step', () => {
  const step1 = new FakeDocument();
  step1.body.append(step1.el('form', {}, step1.el('input', { type: 'email', name: 'identifier', autocomplete: 'username webauthn' })));
  const d1 = detect(step1);
  assert.equal(d1.mode, 'username');
  assert.equal(nameOf(d1.username), 'identifier');

  const step2 = new FakeDocument();
  const hiddenUser = step2.el('input', { type: 'email', name: 'identifier', autocomplete: 'username' });
  hiddenUser.style.display = 'none';
  step2.body.append(step2.el('form', {}, hiddenUser, step2.el('input', { type: 'password', name: 'Passwd', autocomplete: 'current-password' })));
  const d2 = detect(step2);
  assert.equal(d2.mode, 'password');
  assert.equal(d2.username, null, 'hidden username field must not be filled');
  assert.equal(nameOf(d2.password), 'Passwd');
});

test('sign-up and change-password forms', () => {
  const signup = new FakeDocument();
  signup.body.append(
    signup.el('form', {},
      signup.el('input', { type: 'email', name: 'email' }),
      signup.el('input', { type: 'password', name: 'password', autocomplete: 'new-password' }),
      signup.el('input', { type: 'password', name: 'password_confirm', autocomplete: 'new-password' })),
  );
  assert.equal(detect(signup).mode, 'signup');

  const change = new FakeDocument();
  change.body.append(
    change.el('form', {},
      change.el('input', { type: 'password', name: 'old', autocomplete: 'current-password' }),
      change.el('input', { type: 'password', name: 'new1', autocomplete: 'new-password' }),
      change.el('input', { type: 'password', name: 'new2', autocomplete: 'new-password' })),
  );
  const d = detect(change);
  assert.equal(nameOf(d.password), 'old');
  assert.equal(d.newPasswords.length, 2);

  const hinted = new FakeDocument();
  hinted.body.append(
    hinted.el('form', {},
      hinted.el('input', { type: 'text', name: 'user' }),
      hinted.el('input', { type: 'password', name: 'password' }),
      hinted.el('input', { type: 'password', name: 'confirm_password' })),
  );
  assert.equal(nameOf(detect(hinted).password), 'password');
});

test('prefers the form that holds a single password field', () => {
  const doc = new FakeDocument();
  doc.body.append(
    doc.el('form', { id: 'register' }, doc.el('input', { type: 'text', name: 'r_user' }), doc.el('input', { type: 'password', name: 'r_pw' }), doc.el('input', { type: 'password', name: 'r_pw2' })),
    doc.el('form', { id: 'login' }, doc.el('input', { type: 'text', name: 'l_user' }), doc.el('input', { type: 'password', name: 'l_pw' })),
  );
  const d = detect(doc);
  assert.equal(nameOf(d.password), 'l_pw');
  assert.equal(nameOf(d.username), 'l_user');
});

test('TOTP step detection', () => {
  const doc = new FakeDocument();
  doc.body.append(doc.el('form', {}, doc.el('input', { type: 'text', name: 'otp', autocomplete: 'one-time-code', maxlength: '6', inputmode: 'numeric' })));
  const d = detect(doc);
  assert.equal(d.mode, 'totp');
  assert.equal(nameOf(d.totp), 'otp');
  const doc2 = new FakeDocument();
  doc2.body.append(doc2.el('form', {}, doc2.el('input', { type: 'tel', id: 'verification-code', maxlength: '8' })));
  assert.equal(nameOf(detect(doc2).totp), 'verification-code');
  const doc3 = new FakeDocument();
  doc3.body.append(doc3.el('input', { type: 'text', name: 'otp_comment', maxlength: '200' }));
  assert.equal(detect(doc3).totp, null, 'long free-text fields are not OTP inputs');
});

test('same-origin iframes are searched, cross-origin ones never', () => {
  const top = new FakeDocument({ origin: 'https://example.com' });
  const inner = new FakeDocument({ origin: 'https://example.com', path: '/frame/login' });
  inner.body.append(inner.el('form', {}, inner.el('input', { type: 'text', name: 'fu' }), inner.el('input', { type: 'password', name: 'fp' })));
  const frame = top.el('iframe', {});
  frame.contentDocument = inner;
  top.body.append(frame);
  const d = detect(top);
  assert.equal(nameOf(d.password), 'fp');
  assert.equal(d.password.depth, 1);

  const top2 = new FakeDocument({ origin: 'https://example.com' });
  const evil = new FakeDocument({ origin: 'https://evil.example.net' });
  evil.body.append(evil.el('input', { type: 'password', name: 'evil_pw' }));
  const f2 = top2.el('iframe', {});
  f2.contentDocument = evil;
  const f3 = top2.el('iframe', {});
  Object.defineProperty(f3, 'contentDocument', { get() { throw new Error('SecurityError'); } });
  top2.body.append(f2, f3);
  assert.equal(detect(top2).mode, 'none');

  const top3 = new FakeDocument({ origin: 'https://example.com' });
  const hiddenInner = new FakeDocument({ origin: 'https://example.com' });
  hiddenInner.body.append(hiddenInner.el('input', { type: 'password', name: 'hp' }));
  const hiddenFrame = top3.el('iframe', {});
  hiddenFrame.style.display = 'none';
  hiddenFrame.contentDocument = hiddenInner;
  top3.body.append(hiddenFrame);
  assert.equal(detect(top3).mode, 'none', 'fields inside an invisible frame are ignored');
});

test('form action over plain http is flagged on https pages', () => {
  const doc = new FakeDocument({ origin: 'https://example.com' });
  doc.body.append(doc.el('form', { action: 'http://example.com/login' }, doc.el('input', { type: 'password', name: 'p' })));
  assert.equal(formActionInsecure(detect(doc).password), true);
  const ok = new FakeDocument({ origin: 'https://example.com' });
  ok.body.append(ok.el('form', { action: '/login' }, ok.el('input', { type: 'password', name: 'p' })));
  assert.equal(formActionInsecure(detect(ok).password), false);
  const noForm = new FakeDocument();
  noForm.body.append(noForm.el('input', { type: 'password', name: 'p' }));
  assert.equal(formActionInsecure(detect(noForm).password), false);
});

test('isElementVisible', () => {
  const doc = new FakeDocument();
  const a = doc.el('input', { type: 'text' });
  doc.body.append(a);
  assert.equal(isElementVisible(a), true);
  a.isConnected = false;
  assert.equal(isElementVisible(a), false);
  a.isConnected = true;
  a.rect = { left: 0, top: -500, width: 100, height: 20 };
  assert.equal(isElementVisible(a), false, 'above the page');
  a.rect = { left: 0, top: 0, width: 100, height: 20 };
  a.hidden = true;
  assert.equal(isElementVisible(a), false);
  assert.equal(isElementVisible(null), false);
});

test('extractCredentials for login, sign-up and change-password submissions', () => {
  const doc = new FakeDocument();
  const { form, user, pass } = loginForm(doc);
  user.value = 'me@example.com';
  pass.value = 's3cret!';
  const all = collectFields(doc, { isVisible: () => true });
  assert.deepEqual(extractCredentials(all, form), { username: 'me@example.com', password: 's3cret!' });

  const su = new FakeDocument();
  const email = su.el('input', { type: 'email', name: 'email', value: 'new@example.com' });
  const p1 = su.el('input', { type: 'password', name: 'password', value: 'N3w-pass' });
  const p2 = su.el('input', { type: 'password', name: 'confirm', value: 'N3w-pass' });
  const suForm = su.el('form', {}, email, p1, p2);
  su.body.append(suForm);
  assert.deepEqual(extractCredentials(collectFields(su, { isVisible: () => true }), suForm), { username: 'new@example.com', password: 'N3w-pass' });

  const ch = new FakeDocument();
  const hiddenUser = ch.el('input', { type: 'hidden', name: 'u', autocomplete: 'username', value: 'carol' });
  const old = ch.el('input', { type: 'password', name: 'old', autocomplete: 'current-password', value: 'old-pw' });
  const n1 = ch.el('input', { type: 'password', name: 'n1', autocomplete: 'new-password', value: 'brand-new' });
  const n2 = ch.el('input', { type: 'password', name: 'n2', autocomplete: 'new-password', value: 'brand-new' });
  const chForm = ch.el('form', {}, hiddenUser, old, n1, n2);
  ch.body.append(chForm);
  assert.deepEqual(extractCredentials(collectFields(ch, { isVisible: () => true }), chForm), { username: 'carol', password: 'brand-new' });

  const empty = new FakeDocument();
  loginForm(empty);
  assert.equal(extractCredentials(collectFields(empty, { isVisible: () => true }), null), null);
});

test('fillField uses the native value setter and fires bubbling input/change events', () => {
  const doc = new FakeDocument();
  const input = doc.el('input', { type: 'text', name: 'user' });
  doc.body.append(input);
  // Imitate React's value tracker: an own-property accessor on the instance.
  let trackerSaw = null;
  const proto = Object.getPrototypeOf(input);
  const desc = Object.getOwnPropertyDescriptor(proto, 'value');
  Object.defineProperty(input, 'value', {
    configurable: true,
    get() { return desc.get.call(this); },
    set(v) { trackerSaw = v; desc.set.call(this, v); },
  });
  const before = nativeSetCount();
  fillField(input, 'alice');
  assert.equal(input.value, 'alice');
  assert.equal(trackerSaw, null, 'instance setter (framework tracker) must be bypassed');
  assert.equal(nativeSetCount(), before + 1);
  assert.deepEqual(input.events, ['input', 'change']);
  assert.equal(input.focused, true);
});
