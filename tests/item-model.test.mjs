import test from 'node:test';
import assert from 'node:assert/strict';

import { validateItemData, MAX_ITEM_JSON, applyPasswordHistory, newLoginItem } from '../src/lib/item-model.js';
import * as vc from '../src/lib/vault-crypto.js';

const SERVER_MAX_SEALED = 256 * 1024; // ludworks-server internal/vault MaxItemDataLen (sealed string length)

test('item size limit counts UTF-8 bytes, so every accepted item fits the server limit once sealed', async () => {
  const cjk = { type: 'note', name: 'n', notes: '日本語'.repeat(30000) }; // 90 000 chars, 270 000 bytes
  assert.ok(JSON.stringify(cjk).length < MAX_ITEM_JSON, 'short in UTF-16 code units…');
  assert.equal(validateItemData(cjk), 'Item is too large', '…but too large in bytes');
  const emoji = { type: 'note', name: 'n', notes: '🔑'.repeat(60000) }; // 120 000 code units, 240 000 bytes
  assert.equal(validateItemData(emoji), 'Item is too large');

  // the largest item the extension accepts, in ASCII and in multi-byte text, seals within the server limit
  const key = vc.randomBytes(32);
  const base = JSON.stringify({ type: 'note', name: 'n', notes: '' }).length;
  for (const unit of ['x', 'é', '日', '🔑']) {
    const bytes = new TextEncoder().encode(unit).length;
    const count = Math.floor((MAX_ITEM_JSON - base) / bytes);
    const item = { type: 'note', name: 'n', notes: unit.repeat(count) };
    assert.equal(validateItemData(item), null, `max ${unit}`);
    const sealed = await vc.encryptItem(key, vc.uuid(), item);
    assert.ok(sealed.length <= SERVER_MAX_SEALED, `${unit}: ${sealed.length} ≤ ${SERVER_MAX_SEALED}`);
    assert.equal(validateItemData({ ...item, notes: item.notes + unit.repeat(2) }), 'Item is too large');
  }
});

test('password history and new login shape', () => {
  const prev = newLoginItem({ url: 'https://shop.example.com/login', username: 'u', password: 'one', now: '2026-01-01T00:00:00.000Z' });
  assert.deepEqual(prev.login.uris, [{ uri: 'https://shop.example.com', match: 'domain' }]);
  assert.deepEqual(newLoginItem({ url: 'https://nas.duckdns.org:5001/login', match: 'host' }).login.uris, [{ uri: 'https://nas.duckdns.org:5001', match: 'host' }]);
  const next = { ...prev, login: { ...prev.login, password: 'two' } };
  const out = applyPasswordHistory(prev, next, '2026-02-01T00:00:00.000Z');
  assert.deepEqual(out.password_history, [{ password: 'one', changed_at: '2026-02-01T00:00:00.000Z' }]);
  assert.equal(next.password_history.length, 0, 'input not mutated');
});
