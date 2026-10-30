// Keyboard shortcuts, search templates, CBOR.
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveShortcut } from '../build/app/main/shortcuts.js';
import { validTemplate, searchUrl, currentEngine } from '../build/app/main/search.js';
import { encode, CborMap } from '../build/app/main/cbor.js';

const key = (k, mods = {}) => ({ type: 'keyDown', key: k, code: '', control: false, meta: false, shift: false, alt: false, ...mods });
const primary = process.platform === 'darwin' ? 'meta' : 'control';

test('shortcuts: browser-reserved vs page-first', () => {
  assert.deepEqual(resolveShortcut(key('t', { [primary]: true })), { cmd: 'newTab', arg: undefined, reserved: true });
  assert.equal(resolveShortcut(key('w', { [primary]: true })).reserved, true);
  assert.deepEqual(resolveShortcut(key('3', { [primary]: true })), { cmd: 'selectTab', arg: 2, reserved: true });
  assert.equal(resolveShortcut(key('T', { [primary]: true, shift: true })).cmd, 'reopenTab');
  assert.deepEqual(resolveShortcut(key('P', { [primary]: true, shift: true })), { cmd: 'pictureInPicture', arg: undefined, reserved: false });
  // pages see these first (web apps may bind them)
  for (const k of ['f', 's', 'p', 'd', '=', '-', '0']) assert.equal(resolveShortcut(key(k, { [primary]: true })).reserved, false, k);
  assert.equal(resolveShortcut(key('F5')).cmd, 'reload');
  assert.equal(resolveShortcut(key('F12')).cmd, 'devtools');
  assert.equal(resolveShortcut(key('c', { [primary]: true })), null); // copy/paste untouched
  assert.equal(resolveShortcut({ ...key('t', { [primary]: true }), type: 'keyUp' }), null);
});

test('search: templates and engines', () => {
  assert.ok(validTemplate('https://search.example/?q=%s'));
  assert.ok(validTemplate('https://search.example/?q={q}'));
  assert.ok(!validTemplate('https://search.example/'));
  assert.ok(!validTemplate('javascript:alert(%s)'));
  assert.equal(searchUrl({ search: 'https://x.test/?q={q}' }, 'a b&c'), 'https://x.test/?q=a%20b%26c');
  assert.equal(currentEngine({ searchEngine: 'duckduckgo' }).name, 'DuckDuckGo');
  assert.equal(currentEngine({ searchEngine: 'nope' }).id, 'google');
  assert.equal(currentEngine({ searchEngine: 'custom', customSearch: { name: 'Mine', url: 'https://m.test/?s=%s' } }).name, 'Mine');
});

test('CBOR: RFC 8949 appendix A examples', () => {
  const hex = (v) => encode(v).toString('hex');
  assert.equal(hex(0), '00');
  assert.equal(hex(23), '17');
  assert.equal(hex(24), '1818');
  assert.equal(hex(1000), '1903e8');
  assert.equal(hex(1000000), '1a000f4240');
  assert.equal(hex(-1), '20');
  assert.equal(hex(-1000), '3903e7');
  assert.equal(hex(''), '60');
  assert.equal(hex('IETF'), '6449455446');
  assert.equal(hex(new Uint8Array([1, 2, 3, 4])), '4401020304');
  assert.equal(hex([1, [2, 3], [4, 5]]), '8301820203820405');
  assert.equal(hex(new CborMap([[1, 2], [3, 4]])), 'a201020304');
  assert.equal(hex(new CborMap([['a', 1], ['b', [2, 3]]])), 'a26161016162820203');
});
