import test from 'node:test';
import assert from 'node:assert/strict';

import { validateMessage, classifySender, POPUP_SCHEMAS, CONTENT_SCHEMAS } from '../src/lib/messages.js';

const ok = (m, s = POPUP_SCHEMAS) => assert.equal(validateMessage(m, s).ok, true, JSON.stringify(validateMessage(m, s)));
const bad = (m, s = POPUP_SCHEMAS) => assert.equal(validateMessage(m, s).ok, false, JSON.stringify(m));

test('valid popup messages', () => {
  ok({ type: 'state' });
  ok({ type: 'auth.login', serverUrl: 'https://nas', username: 'a', password: 'b' });
  ok({ type: 'auth.login', serverUrl: 'https://nas', username: 'a', password: 'b', totpCode: '123 456' });
  ok({ type: 'items.list', url: null });
  ok({ type: 'items.list' });
  ok({ type: 'items.save', data: { type: 'note', name: 'x' } });
  ok({ type: 'items.save', id: '3b241101-e2bb-4255-8caf-4136c566a962', folderId: null, data: {}, baseRevision: 3 });
  ok({ type: 'settings.update', lockMinutes: 15 });
  ok({ type: 'fill.item', id: '3b241101-e2bb-4255-8caf-4136c566a962', allowInsecure: true });
  ok({ type: 'server.trust', serverUrl: 'https://x', fingerprint: 'ab'.repeat(32) });
});

test('invalid popup messages are rejected', () => {
  bad(null);
  bad('state');
  bad([]);
  bad({});
  bad({ type: 'nope' });
  bad({ type: 'toString' });
  bad({ type: '__proto__' });
  bad({ type: 'state', extra: 1 });
  bad({ type: 'auth.login', serverUrl: 'https://nas', username: 'a' });
  bad({ type: 'auth.login', serverUrl: 'https://nas', username: '', password: 'b' });
  bad({ type: 'auth.login', serverUrl: 'https://nas', username: 'a', password: 'x'.repeat(1025) });
  bad({ type: 'auth.login', serverUrl: 'https://nas', username: 'a', password: 'b', totpCode: 'abc' });
  bad({ type: 'items.get', id: '../../etc' });
  bad({ type: 'items.get', id: 'short' });
  bad({ type: 'items.get', id: '3B241101-E2BB-4255-8CAF-4136C566A962' });
  bad({ type: 'items.save', data: [] });
  bad({ type: 'items.save', data: { big: 'x'.repeat(200 * 1024) } });
  bad({ type: 'items.save', data: new (class X {})() });
  bad({ type: 'items.save', data: {}, baseRevision: -1 });
  bad({ type: 'items.save', data: {}, baseRevision: 1.5 });
  bad({ type: 'settings.update', lockMinutes: 7 });
  bad({ type: 'settings.update', saveLogins: 'yes' });
  bad({ type: 'fill.item', id: '3b241101-e2bb-4255-8caf-4136c566a962', allowInsecure: 1 });
  bad({ type: 'fill.item', id: 'abcdefgh' });
  bad({ type: 'items.list', url: 5 });
});

test('content scripts may only report a submission (never decide a save or update)', () => {
  ok({ type: 'capture.submitted', username: 'u', password: 'p' }, CONTENT_SCHEMAS);
  ok({ type: 'capture.loaded' }, CONTENT_SCHEMAS);
  for (const decision of ['save', 'update', 'never', 'dismiss']) {
    bad({ type: 'capture.decision', decision }, CONTENT_SCHEMAS);
    bad({ type: 'capture.confirm', tabId: 1, id: '3b241101-e2bb-4255-8caf-4136c566a962', decision }, CONTENT_SCHEMAS);
  }
  bad({ type: 'capture.pending' }, CONTENT_SCHEMAS);
  bad({ type: 'capture.get', tabId: 1 }, CONTENT_SCHEMAS);
  bad({ type: 'capture.submitted', username: 'u', password: '' }, CONTENT_SCHEMAS);
  bad({ type: 'items.get', id: '3b241101-e2bb-4255-8caf-4136c566a962' }, CONTENT_SCHEMAS);
  bad({ type: 'vault.unlock', password: 'x' }, CONTENT_SCHEMAS);
  bad({ type: 'capture.loaded', url: 'https://spoofed' }, CONTENT_SCHEMAS);
});

test('popup capture and fill confirmation messages', () => {
  ok({ type: 'capture.get', tabId: 4 });
  ok({ type: 'capture.confirm', tabId: 4, id: '3b241101-e2bb-4255-8caf-4136c566a962', decision: 'update' });
  ok({ type: 'fill.item', id: '3b241101-e2bb-4255-8caf-4136c566a962', allowOtherHost: true });
  bad({ type: 'capture.get', tabId: -1 });
  bad({ type: 'capture.get', tabId: '4' });
  bad({ type: 'capture.confirm', tabId: 4, id: '3b241101-e2bb-4255-8caf-4136c566a962', decision: 'steal' });
  bad({ type: 'capture.confirm', tabId: 4, decision: 'save' });
  bad({ type: 'fill.item', id: '3b241101-e2bb-4255-8caf-4136c566a962', allowOtherHost: 'yes' });
});

test('classifySender', () => {
  const ctx = { runtimeId: 'ext-id', extensionOrigin: 'chrome-extension://ext-id/' };
  assert.equal(classifySender({ id: 'ext-id', url: 'chrome-extension://ext-id/popup/popup.html' }, ctx), 'extension');
  assert.equal(classifySender({ id: 'ext-id', url: 'chrome-extension://ext-id/popup/popup.html', tab: { id: 3, active: false } }, ctx), 'extension');
  const content = { id: 'ext-id', url: 'https://site.example/login', frameId: 0, tab: { id: 7, active: true } };
  assert.equal(classifySender(content, ctx), 'content');
  assert.equal(classifySender({ ...content, frameId: 2 }, ctx), null, 'sub-frames rejected');
  assert.equal(classifySender({ ...content, tab: { id: 7, active: false } }, ctx), null, 'background tabs rejected');
  assert.equal(classifySender({ ...content, url: 'file:///x' }, ctx), null);
  assert.equal(classifySender({ ...content, id: 'other-extension' }, ctx), null, 'other extensions rejected');
  assert.equal(classifySender({ id: 'ext-id', url: 'chrome-extension://other/popup.html' }, ctx), null);
  assert.equal(classifySender({ id: 'ext-id' }, ctx), null);
  assert.equal(classifySender(null, ctx), null);
  assert.equal(classifySender({ id: undefined }, { runtimeId: undefined, extensionOrigin: '' }), null);
});
