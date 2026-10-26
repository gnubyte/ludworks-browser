// Cross-client crypto interoperability: the extension's src/lib/vault-crypto.js against the web app's
// canonical lib (ludworks-server/web/assets/js/lib/vault/crypto.js). Both must reproduce the shared vectors
// identically, open each other's ciphertexts (items, folders, wrapped keys, raw seals) and fail the same
// way on malformed / tampered input. Skips when ludworks-server is not checked out next to this repo.

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import * as ext from '../src/lib/vault-crypto.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.resolve(here, '..', '..', 'ludworks-server');
const WEB_CRYPTO = path.join(SERVER, 'web', 'assets', 'js', 'lib', 'vault', 'crypto.js');
const VECTORS = path.join(SERVER, 'docs', 'spec', 'vault-test-vectors.json');
const skip = !(existsSync(WEB_CRYPTO) && existsSync(VECTORS)) && 'ludworks-server (web vault lib + vectors) not checked out next to this repo';

const web = skip ? null : await import(pathToFileURL(WEB_CRYPTO).href);
const V = skip ? null : JSON.parse(readFileSync(VECTORS, 'utf8'));
const hex = (u8) => Buffer.from(u8).toString('hex');
const unhex = (s) => new Uint8Array(Buffer.from(s, 'hex'));

/** Outcome of a call: {ok, value} or {code} — for comparing the two libraries' behaviour. */
async function outcome(fn) {
  try {
    const v = await fn();
    return { ok: true, value: v instanceof Uint8Array ? hex(v) : v };
  } catch (e) {
    return { ok: false, code: e && e.code, name: e && e.name };
  }
}

const LIBS = () => [['extension', ext], ['web', web]];

test('interop: both libraries export the same canonical surface and constants', { skip }, () => {
  for (const name of ['KDF_PBKDF2', 'DEFAULT_ITERATIONS', 'MIN_ITERATIONS', 'MAX_ITERATIONS', 'SALT_BYTES', 'KEY_BYTES', 'NONCE_BYTES', 'AAD_KEY', 'AAD_ITEM_PREFIX', 'AAD_FOLDER_PREFIX']) {
    assert.equal(ext[name], web[name], name);
  }
  for (const fn of ['uuid', 'isValidId', 'deriveMasterKey', 'deriveWrapKey', 'importAesKey', 'seal', 'open', 'createVault', 'unlockVault', 'rewrapVaultKey', 'encryptItem', 'decryptItem', 'encryptFolder', 'decryptFolder', 'b64encode', 'b64decode', 'randomBytes']) {
    assert.equal(typeof ext[fn], 'function', `extension ${fn}`);
    assert.equal(typeof web[fn], 'function', `web ${fn}`);
  }
  assert.equal(typeof ext.__testing.sealWithNonce, 'function');
  assert.equal(typeof web.__testing.sealWithNonce, 'function');
});

test('interop: shared vectors give byte-identical results in both libraries', { skip }, async () => {
  for (const [name, lib] of LIBS()) {
    const k = V.kdf;
    const mk = await lib.deriveMasterKey(k.password, unhex(k.kdf_salt_hex), k.kdf_iterations);
    assert.equal(hex(mk), k.master_key_hex, `${name} master key`);
    assert.equal(hex(await lib.__testing.deriveWrapKeyBytes(mk)), k.wrap_key_hex, `${name} wrap key`);
    assert.equal(hex(await lib.unlockVault(k.password, V.wrapped_key.server_params)), V.wrapped_key.vault_key_hex, `${name} unlock`);
    const wk = V.wrapped_key;
    const vaultKey = unhex(wk.vault_key_hex);
    assert.equal(await lib.__testing.sealWithNonce(unhex(k.wrap_key_hex), vaultKey, wk.aad, unhex(wk.nonce_hex)), wk.sealed, `${name} wrapped key seal`);
    const it = V.item;
    assert.equal(await lib.__testing.sealWithNonce(vaultKey, it.plaintext_json, it.aad, unhex(it.nonce_hex)), it.data, `${name} item seal`);
    assert.deepEqual(await lib.decryptItem(vaultKey, it.id, it.data), JSON.parse(it.plaintext_json), `${name} item open`);
    const f = V.folder;
    assert.equal(await lib.__testing.sealWithNonce(vaultKey, f.plaintext_json, f.aad, unhex(f.nonce_hex)), f.sealed, `${name} folder seal`);
    assert.equal(await lib.decryptFolder(vaultKey, f.id, f.sealed), f.name, `${name} folder open`);
  }
  // each library opens the other's fresh (random-nonce) seal of the vector plaintexts
  const vaultKey = unhex(V.wrapped_key.vault_key_hex);
  assert.deepEqual(await web.decryptItem(vaultKey, V.item.id, await ext.encryptItem(vaultKey, V.item.id, JSON.parse(V.item.plaintext_json))), JSON.parse(V.item.plaintext_json));
  assert.equal(await ext.decryptFolder(vaultKey, V.folder.id, await web.encryptFolder(vaultKey, V.folder.id, V.folder.name)), V.folder.name);
});

test('interop: open_must_fail cases fail with the same error code in both libraries', { skip }, async () => {
  assert.ok(V.open_must_fail.length > 0);
  for (const c of V.open_must_fail) {
    const key = unhex(c.key_hex);
    const a = await outcome(() => ext.open(key, c.sealed, c.aad));
    const b = await outcome(() => web.open(key, c.sealed, c.aad));
    assert.equal(a.ok, false, c.case);
    assert.deepEqual(a, b, `same failure for "${c.case}"`);
    if (c.error || c.expect) assert.equal(a.code, c.error || c.expect, c.case);
  }
});

function randomString(maxLen) {
  const pools = ['abcXYZ019 ', 'äöüßéèçñ', '✓☃€', '日本語中文한국어', '😀💡🔑', '\n\t"\\/<>&\u0000'];
  const n = Math.floor(Math.random() * maxLen);
  let s = '';
  for (let i = 0; i < n; i++) {
    const p = [...pools[Math.floor(Math.random() * pools.length)]];
    s += p[Math.floor(Math.random() * p.length)];
  }
  return s;
}

test('interop: random items, folders and raw seals round-trip in both directions', { skip }, async () => {
  for (let i = 0; i < 60; i++) {
    const key = ext.randomBytes(32);
    const id = i % 2 ? ext.uuid() : web.uuid();
    assert.ok(ext.isValidId(id) && web.isValidId(id));
    const item = {
      type: ['login', 'note', 'card', 'identity'][i % 4],
      name: randomString(40) || 'x',
      notes: randomString(400),
      login: { username: randomString(30), password: randomString(64), uris: [{ uri: `https://${i}.example.com/${encodeURIComponent(randomString(10))}`, match: 'domain' }], totp: '' },
      fields: [{ name: randomString(10), value: randomString(50), hidden: i % 3 === 0 }],
      nested: { deep: [1, 2.5, null, true, randomString(5)] },
    };
    const [enc, dec] = i % 2 ? [ext, web] : [web, ext];
    const data = await enc.encryptItem(key, id, item);
    assert.deepEqual(await dec.decryptItem(key, id, data), item);
    // bound to the id: the other library refuses it under another id
    assert.deepEqual(await outcome(() => dec.decryptItem(key, ext.uuid(), data)), { ok: false, code: 'decrypt_failed', name: 'VaultError' });

    const folderName = `${randomString(20)}/${randomString(20)}` || 'f';
    const fname = await dec.encryptFolder(key, id, folderName);
    assert.equal(await enc.decryptFolder(key, id, fname), folderName);
    // an item ciphertext is not a valid folder name for the same id (domain separation)
    assert.equal((await outcome(() => enc.decryptFolder(key, id, data))).code, 'decrypt_failed');

    const raw = ext.randomBytes(Math.floor(Math.random() * 2000));
    const aad = randomString(30);
    assert.equal(hex(await web.open(key, await ext.seal(key, raw, aad), aad)), hex(raw));
    assert.equal(hex(await ext.open(key, await web.seal(key, raw, aad), aad)), hex(raw));
  }
});

test('interop: vaults created / re-keyed by one library unlock in the other', { skip }, async () => {
  const pw = 'Ünïcödé master ✓ password'; // NFC/NFD forms must both work across clients
  const a = await ext.createVault(pw);
  assert.equal(hex(await web.unlockVault(pw.normalize('NFD'), a.params)), hex(a.vaultKey));
  const b = await web.createVault(pw.normalize('NFD'));
  assert.equal(hex(await ext.unlockVault(pw, b.params)), hex(b.vaultKey));
  assert.equal((await outcome(() => ext.unlockVault('wrong', b.params))).code, 'bad_password');
  assert.equal((await outcome(() => web.unlockVault('wrong', a.params))).code, 'bad_password');
  const rewrapped = await web.rewrapVaultKey(a.vaultKey, 'next password');
  assert.equal(hex(await ext.unlockVault('next password', rewrapped)), hex(a.vaultKey));
  const rewrapped2 = await ext.rewrapVaultKey(b.vaultKey, 'next password 2');
  assert.equal(hex(await web.unlockVault('next password 2', rewrapped2)), hex(b.vaultKey));
});

test('interop: malformed input, weak KDF parameters and ids are judged identically', { skip }, async () => {
  const key = ext.randomBytes(32);
  const good = await ext.seal(key, 'x', 'aad');
  const [, n, c] = good.split('.');
  const sealedCases = [
    '', 'v1', 'v1..', 'v2.' + n + '.' + c, `v1.${n}.${c}.extra`, `v1.${n}`, `v1.${n.slice(1)}.${c}`, `v1.${n}.${c.slice(0, -4)}`,
    `v1.${n}.${c.replace(/\+/g, '-')}`, `v1.${n} .${c}`, `V1.${n}.${c}`, `v1.${n}.${'A'.repeat(20)}`,
    `v1.${n}.${c}`.replace(/.$/, (ch) => (ch === 'A' ? 'B' : 'A')), 42, null,
  ];
  for (const s of sealedCases) {
    const a = await outcome(() => ext.open(key, s, 'aad'));
    const b = await outcome(() => web.open(key, s, 'aad'));
    assert.deepEqual(a, b, `open(${JSON.stringify(s)})`);
  }
  const b64Cases = ['', 'AA==', 'AAA=', 'AAAA', 'A===', 'AA=', '-_8=', 'AA==\n', ' AA==', 'AA==AA==', 'QUJD'];
  for (const s of b64Cases) {
    assert.deepEqual(await outcome(() => ext.b64decode(s)), await outcome(() => web.b64decode(s)), `b64decode(${JSON.stringify(s)})`);
  }
  // Deliberate difference: unpadded base64 ("AA", "QUJ") is accepted by the web lib (it also parses import
  // formats) but refused by the extension, which only accepts the canonical padded form that the server
  // enforces for every stored sealed string and salt. Nothing the server stores can hit this difference.
  for (const s of ['AA', 'QUJ']) {
    assert.equal((await outcome(() => ext.b64decode(s))).code, 'malformed');
    assert.equal((await outcome(() => web.b64decode(s))).ok, true);
  }
  const idCases = [ext.uuid(), web.uuid(), 'ABCDEF00-0000-4000-8000-000000000000', '3f0c9a52-7d1e-4b6a-9c2f-8e5d4a1b0c7e', '3f0c9a527d1e4b6a9c2f8e5d4a1b0c7e', 'not-an-id', '', null, 7, '3f0c9a52-7d1e-0b6a-0c2f-8e5d4a1b0c7e'];
  for (const id of idCases) assert.equal(ext.isValidId(id), web.isValidId(id), `isValidId(${JSON.stringify(id)})`);
  const base = (await web.createVault('pw', { iterations: 600000 })).params;
  const paramCases = [
    { ...base, kdf: 'argon2id' },
    { ...base, kdf_iterations: 599999 },
    { ...base, kdf_iterations: 10_000_001 },
    { ...base, kdf_iterations: '600000' },
    { ...base, kdf_salt: ext.b64encode(new Uint8Array(15)) },
    { ...base, kdf_salt: ext.b64encode(new Uint8Array(65)) },
    { ...base, kdf_salt: 'not base64!' },
    { ...base, wrapped_key: 'v1.AAAA.AAAA' },
    null,
  ];
  for (const p of paramCases) {
    const a = await outcome(() => ext.unlockVault('pw', p));
    const b = await outcome(() => web.unlockVault('pw', p));
    assert.equal(a.ok, false);
    assert.deepEqual(a, b, `unlockVault(${JSON.stringify(p && { ...p, wrapped_key: p.wrapped_key && p.wrapped_key.slice(0, 12) })})`);
  }
});
