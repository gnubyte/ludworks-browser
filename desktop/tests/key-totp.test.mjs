// One-time (MFA) codes in the key popup: the browser's `key:totp` answer (src/main/autofill.js) gives a
// code, period and seconds left for logins with a TOTP secret only, and the popup groups the digits the
// way authenticator apps show them (src/shell/overlay-vault.js). The RFC 6238 secret is the standard
// test vector.
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateTotp } from '../build/app/lib/totp.js';

const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'; // "12345678901234567890"

test('a TOTP secret yields a 6-digit code, its period and the seconds it has left', async () => {
  const t = await generateTotp(RFC_SECRET, 59_000);
  assert.equal(t.code, '287082');
  assert.equal(t.period, 30);
  assert.equal(t.remaining, 1);
  const t2 = await generateTotp(RFC_SECRET, 60_000);
  assert.equal(t2.remaining, 30);
});

test('codes are grouped like authenticator apps show them', async () => {
  globalThis.window = { lw: { call: async () => ({ ok: true }) } };
  globalThis.document = { createElementNS: () => ({ setAttribute() {}, append() {} }), createElement: () => ({ append() {}, setAttribute() {}, style: {}, classList: { add() {} } }) };
  const { formatCode } = await import('../build/app/shell/overlay-vault.js');
  assert.equal(formatCode('287082'), '287 082');
  assert.equal(formatCode('94287082'), '9428 7082');
  assert.equal(formatCode('ABCDE'), 'ABCDE');
  assert.equal(formatCode(null), '');
});
