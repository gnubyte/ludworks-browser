import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { preflight, fillTab } from '../src/background/autofill.js';
import { bundle } from '../scripts/lib/bundle.mjs';
import { FakeDocument, FakeEvent } from './helpers/fake-dom.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(here, '..', 'src');

test('preflight: https only, localhost needs explicit consent', () => {
  assert.deepEqual(preflight('https://github.com/login', false), { ok: true, origin: 'https://github.com' });
  assert.deepEqual(preflight('http://github.com/login', true), { ok: false, code: 'insecure_page', localhost: false });
  assert.deepEqual(preflight('http://localhost:3000/', false), { ok: false, code: 'insecure_page', localhost: true });
  assert.deepEqual(preflight('http://localhost:3000/', true), { ok: true, origin: 'http://localhost:3000' });
  assert.deepEqual(preflight('chrome://extensions', false), { ok: false, code: 'unsupported_page' });
  assert.deepEqual(preflight('', false), { ok: false, code: 'unsupported_page' });
});

function fakeExt(result, { throwOnInject = false } = {}) {
  const calls = [];
  return {
    calls,
    scripting: {
      async executeScript(opts) {
        calls.push(opts);
        if (throwOnInject) throw new Error('Cannot access contents of the page');
        if (opts.files) return [{ frameId: 0, result: undefined }];
        const saved = globalThis.__ludworksFill;
        globalThis.__ludworksFill = () => result;
        try {
          return [{ frameId: 0, result: opts.func(...opts.args) }];
        } finally {
          globalThis.__ludworksFill = saved;
        }
      },
    },
  };
}

const CREDS = { username: 'me', password: 'pw', totp: '', uris: [{ uri: 'https://github.com', match: 'domain' }] };

test('fillTab injects into the top frame only, then calls the filler with the expected origin', async () => {
  const ext = fakeExt({ ok: true, filled: { username: true, password: true, totp: false } });
  const res = await fillTab(ext, { id: 9, url: 'https://github.com/login' }, CREDS);
  assert.deepEqual(res, { filled: { username: true, password: true, totp: false } });
  assert.equal(ext.calls.length, 2);
  assert.deepEqual(ext.calls[0], { target: { tabId: 9, frameIds: [0] }, files: ['content/fill.js'] });
  assert.deepEqual(ext.calls[1].target, { tabId: 9, frameIds: [0] });
  assert.equal(ext.calls[1].args[0].expectedOrigin, 'https://github.com');
  assert.equal(ext.calls[1].args[0].allowInsecure, false);
});

test('fillTab error mapping', async () => {
  await assert.rejects(fillTab(fakeExt({}), { id: 1, url: 'http://github.com/' }, CREDS), (e) => e.code === 'insecure_page' && e.details.localhost === false);
  await assert.rejects(fillTab(fakeExt({}), { id: 1, url: 'http://localhost/' }, CREDS), (e) => e.code === 'insecure_page' && e.details.localhost === true);
  await assert.rejects(fillTab(fakeExt({}), { id: 1, url: 'about:blank' }, CREDS), (e) => e.code === 'unsupported_page');
  await assert.rejects(fillTab(fakeExt({}, { throwOnInject: true }), { id: 1, url: 'https://github.com/' }, CREDS), (e) => e.code === 'injection_failed');
  await assert.rejects(fillTab(fakeExt({ ok: false, error: 'no_fields' }), { id: 1, url: 'https://github.com/' }, CREDS), (e) => e.code === 'no_fields');
  await assert.rejects(fillTab(fakeExt({ ok: false, error: 'weird' }), { id: 1, url: 'https://github.com/' }, CREDS), (e) => e.code === 'fill_failed');
  await assert.rejects(fillTab(fakeExt(null), { id: 1, url: 'https://github.com/' }, CREDS), (e) => e.code === 'fill_failed');
});

// ---- the real (bundled) content script, executed against the fake DOM ------------------------------

let fillCode;
async function runFill(doc, payload) {
  fillCode = fillCode || (await bundle(path.join(SRC, 'content', 'fill.js'), { root: SRC }));
  const sandbox = { document: doc, location: doc.location, URL, Event: FakeEvent };
  sandbox.window = sandbox;
  sandbox.top = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fillCode, sandbox, { filename: 'content/fill.js' });
  assert.equal(typeof sandbox.__ludworksFill, 'function');
  // Results cross a structured-clone boundary in the browser; JSON mirrors that across VM realms.
  return JSON.parse(JSON.stringify(sandbox.__ludworksFill(payload)));
}

function page(origin = 'https://github.com', formAttrs = {}) {
  const doc = new FakeDocument({ origin, path: '/login' });
  const user = doc.el('input', { type: 'text', name: 'login' });
  const pass = doc.el('input', { type: 'password', name: 'password' });
  doc.body.append(doc.el('form', formAttrs, user, pass));
  return { doc, user, pass };
}

const payload = (extra = {}) => ({
  username: 'alice',
  password: 'S3cret!',
  totp: '',
  uris: [{ uri: 'https://github.com/login', match: 'domain' }],
  expectedOrigin: 'https://github.com',
  allowInsecure: false,
  ...extra,
});

test('bundled fill script fills a matching HTTPS login form', async () => {
  const { doc, user, pass } = page();
  const r = await runFill(doc, payload());
  assert.deepEqual(r, { ok: true, filled: { username: true, password: true, totp: false } });
  assert.equal(user.value, 'alice');
  assert.equal(pass.value, 'S3cret!');
  assert.deepEqual(pass.events, ['input', 'change']);
});

test('bundled fill script refuses unsafe situations', async () => {
  assert.deepEqual(await runFill(page().doc, payload({ expectedOrigin: 'https://gitlab.com' })), { ok: false, error: 'origin_changed' });
  assert.deepEqual(await runFill(page('http://github.com').doc, payload({ expectedOrigin: 'http://github.com' })), { ok: false, error: 'insecure_page' });
  assert.deepEqual(await runFill(page().doc, payload({ uris: [{ uri: 'https://gitlab.com', match: 'domain' }] })), { ok: false, error: 'uri_mismatch' });
  assert.deepEqual(await runFill(page().doc, payload({ uris: [{ uri: 'https://github.com/login', match: 'never' }] })), { ok: false, error: 'uri_mismatch' });
  assert.deepEqual(await runFill(page('https://github.com', { action: 'http://github.com/session' }).doc, payload()), { ok: false, error: 'insecure_form' });
  const empty = new FakeDocument({ origin: 'https://github.com' });
  assert.deepEqual(await runFill(empty, payload()), { ok: false, error: 'no_fields' });
  const { doc, pass } = page();
  pass.style.display = 'none';
  const r = await runFill(doc, payload());
  assert.deepEqual(r, { ok: true, filled: { username: true, password: false, totp: false } }, 'hidden password field is skipped');
  assert.equal(pass.value, '');
  assert.deepEqual(await runFill(page().doc, null), { ok: false, error: 'fill_failed' });
});

test('bundled fill script: http://localhost only with consent; TOTP step', async () => {
  const local = () => page('http://localhost:3000').doc;
  const p = payload({ uris: [{ uri: 'http://localhost:3000' }], expectedOrigin: 'http://localhost:3000' });
  assert.deepEqual(await runFill(local(), p), { ok: false, error: 'insecure_page' });
  assert.equal((await runFill(local(), { ...p, allowInsecure: true })).ok, true);

  const doc = new FakeDocument({ origin: 'https://github.com', path: '/sessions/two-factor' });
  const otp = doc.el('input', { type: 'text', name: 'app_otp', autocomplete: 'one-time-code', maxlength: '6' });
  doc.body.append(doc.el('form', {}, otp));
  const r = await runFill(doc, payload({ totp: '123456' }));
  assert.deepEqual(r, { ok: true, filled: { username: false, password: false, totp: true } });
  assert.equal(otp.value, '123456');
  const doc2 = new FakeDocument({ origin: 'https://github.com' });
  doc2.body.append(doc2.el('input', { type: 'text', autocomplete: 'one-time-code' }));
  assert.deepEqual(await runFill(doc2, payload({ totp: 'not-a-code' })), { ok: false, error: 'no_fields' });
});

test('bundled fill script refuses sign-up forms', async () => {
  const doc = new FakeDocument({ origin: 'https://github.com' });
  doc.body.append(doc.el('form', {}, doc.el('input', { type: 'password', autocomplete: 'new-password' })));
  assert.deepEqual(await runFill(doc, payload()), { ok: false, error: 'signup_form' });
});
