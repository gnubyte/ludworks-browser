// Local profile stores (node:sqlite) and address-bar input handling.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { webcrypto } from 'node:crypto';
import { ProfileDb } from '../build/app/main/profile/db.js';
import { Bookmarks } from '../build/app/main/profile/bookmarks.js';
import { History, mergeVisits } from '../build/app/main/profile/history.js';
import { fixupInput, displayUrl } from '../build/app/main/util/urls.js';
import { __testing, importAesKey } from '../build/app/lib/vault-crypto.js';
import { readFileSync } from 'node:fs';

function tmpDb() {
  const dir = mkdtempSync(path.join(tmpdir(), 'lwb-test-'));
  const db = new ProfileDb(dir);
  return { db, done: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('address bar: URLs vs searches', () => {
  const u = (s) => fixupInput(s);
  assert.deepEqual(u('example.com'), { type: 'url', url: 'https://example.com/' });
  assert.deepEqual(u('localhost:3000/x'), { type: 'url', url: 'http://localhost:3000/x' });
  assert.deepEqual(u('192.168.1.5:8443'), { type: 'url', url: 'http://192.168.1.5:8443/' });
  assert.equal(u('nas.example.com:8443/files').url, 'https://nas.example.com:8443/files');
  assert.equal(u('how to cook rice').type, 'search');
  assert.equal(u('node.js').type, 'search'); // .js is not a TLD
  assert.equal(u('javascript:alert(1)').type, 'search');
  assert.equal(u('chrome://settings').url, 'ludworks://settings/');
  assert.equal(u('https://a.test/?q=1').url, 'https://a.test/?q=1');
  assert.equal(displayUrl('https://example.com/'), 'https://example.com');
  assert.equal(displayUrl('https://example.com/a%20b'), 'https://example.com/a%20b'); // spaces stay encoded
  assert.equal(displayUrl('ludworks://newtab/'), '');
});

test('bookmarks: tree, move, delete subtree, orphans and cycles land in "other"', () => {
  const { db, done } = tmpDb();
  try {
    const b = new Bookmarks(db);
    const f = b.add({ parent: 'toolbar', type: 'folder', title: 'F' });
    const a = b.add({ parent: f, title: 'A', url: 'https://a.test/' });
    const c = b.add({ parent: f, title: 'C', url: 'https://c.test/' });
    b.add({ parent: f, title: 'B', url: 'https://b.test/', position: 1 });
    assert.deepEqual(b.children(f).map((n) => n.title), ['A', 'B', 'C']);
    b.move(c, { parent: 'toolbar', position: 0 });
    assert.deepEqual(b.children('toolbar').map((n) => n.title), ['C', 'F']);
    assert.throws(() => b.move(f, { parent: f }));
    // remote records: orphan + 2-cycle
    b.applyRemote('o1', 1, { type: 'url', parent: 'missing', index: 1, title: 'Orphan', url: 'https://o.test/', updated_at: '2026-01-01T00:00:00Z' });
    b.applyRemote('x', 1, { type: 'folder', parent: 'y', index: 1, title: 'X', updated_at: '2026-01-01T00:00:00Z' });
    b.applyRemote('y', 1, { type: 'folder', parent: 'x', index: 1, title: 'Y', updated_at: '2026-01-01T00:00:00Z' });
    const t = b.tree();
    const otherTitles = t.other.children.map((n) => n.title);
    assert.ok(otherTitles.includes('Orphan') && otherTitles.includes('X') && otherTitles.includes('Y'));
    // newest wins; an older remote copy does not overwrite a newer local edit
    b.update(a, { title: 'A2' });
    assert.equal(b.applyRemote(a, 5, { type: 'url', parent: f, index: 1, title: 'A-old', url: 'https://a.test/', updated_at: '2000-01-01T00:00:00Z' }), false);
    assert.equal(b.get(a).title, 'A2');
    b.remove(f);
    assert.equal(b.get(a), null);
    assert.ok(b.dirty().some((d) => d.id === a && d.deleted));
  } finally {
    done();
  }
});

test('history: visits merge (union, newest 30), remote deletes, suggestions', () => {
  const { db, done } = tmpDb();
  try {
    const h = new History(db);
    h.addVisit({ url: 'https://news.test/', title: 'News', typed: true, at: 1000 });
    h.addVisit({ url: 'https://news.test/', at: 2000 });
    h.applyRemote(3, { url: 'https://news.test/', title: 'News!', visits: [1500, 2500], updated_at: '2999-01-01T00:00:00Z' });
    const row = db.get('SELECT visits, title FROM history WHERE url = ?', 'https://news.test/');
    assert.deepEqual(JSON.parse(row.visits), [2500, 2000, 1500, 1000]);
    assert.equal(row.title, 'News!');
    assert.equal(mergeVisits(Array.from({ length: 40 }, (_, i) => i), [100]).length, 30);
    assert.equal(h.suggest('news')[0].url, 'https://news.test/');
    h.remove(['https://news.test/']);
    assert.equal(h.deletedPending().length, 1);
    h.addVisit({ url: 'ludworks://settings/', at: 1 });
    assert.equal(db.get('SELECT count(*) AS n FROM history').n, 0); // internal pages are never recorded
  } finally {
    done();
  }
});

test('browser sync vectors: record sealing and derived ids (VAULT-CRYPTO §9)', async () => {
  const v = JSON.parse(readFileSync(new URL('./fixtures/browser-test-vectors.json', import.meta.url), 'utf8'));
  const te = new TextEncoder();
  const hk = async (info) => {
    const base = await webcrypto.subtle.importKey('raw', Buffer.from(v.vault_key_hex, 'hex'), 'HKDF', false, ['deriveBits']);
    return Buffer.from(await webcrypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: te.encode(info) }, base, 256)).toString('hex');
  };
  assert.equal(await hk('ludworks/browser/key/v1'), v.browser_key_hex);
  assert.equal(await hk('ludworks/browser/id/v1'), v.browser_idkey_hex);
  const key = await importAesKey(Buffer.from(v.browser_key_hex, 'hex'));
  for (const r of v.records) assert.equal(await __testing.sealWithNonce(key, te.encode(r.plaintext_json), r.aad, Buffer.from(r.nonce_hex, 'hex')), r.sealed);
});
