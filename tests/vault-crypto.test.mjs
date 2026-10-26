import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import * as vc from '../src/lib/vault-crypto.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const vectors = JSON.parse(readFileSync(path.join(here, 'fixtures', 'crypto-vectors.json'), 'utf8'));
const te = new TextEncoder();
const td = new TextDecoder();
const { sealWithNonce, deriveWrapKeyBytes } = vc.__testing;
const hex = (s) => Uint8Array.from(s.match(/../g).map((x) => parseInt(x, 16)));
const toHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const code = (c) => (e) => e instanceof vc.VaultError && e.code === c;

function pythonAvailable() {
  return spawnSync('python3', ['-I', '-c', 'import cryptography'], { encoding: 'utf8' }).status === 0;
}

test('base64 is standard, padded, and strict', () => {
  const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);
  assert.equal(vc.b64encode(bytes), 'AAEC+vv8/f7/');
  assert.deepEqual(vc.b64decode('AAEC+vv8/f7/'), bytes);
  assert.equal(vc.b64encode(new Uint8Array([1])), 'AQ==');
  for (const bad of ['AQ', 'AQ=', 'A Q==', 'AQ==\n', '-_8=', 'AQ==AQ==', 42, null]) {
    assert.throws(() => vc.b64decode(bad), code('malformed'), String(bad));
  }
  const big = vc.randomBytes(200000);
  assert.deepEqual(vc.b64decode(vc.b64encode(big)), big);
});

test('randomBytes, uuid and id validation', () => {
  assert.equal(vc.randomBytes(0).length, 0);
  assert.equal(vc.randomBytes(70000).length, 70000);
  assert.throws(() => vc.randomBytes(-1), code('invalid_argument'));
  const ids = new Set();
  for (let i = 0; i < 200; i++) {
    const id = vc.uuid();
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.ok(vc.isValidId(id));
    ids.add(id);
  }
  assert.equal(ids.size, 200);
  for (const bad of ['3F0C9A52-7D1E-4B6A-9C2F-8E5D4A1B0C7E', 'abcdefgh', '../x', '', null, '3f0c9a52-7d1e-4b6a-9c2f-8e5d4a1b0c7e ']) {
    assert.equal(vc.isValidId(bad), false, String(bad));
  }
});

for (const c of vectors.kdf) {
  test(`own KDF known answers (python cryptography): ${c.name}`, async () => {
    const salt = vc.b64decode(c.kdf_salt);
    const mk = await vc.deriveMasterKey(c.password, salt, c.kdf_iterations);
    assert.equal(vc.b64encode(mk), c.master_key);
    assert.equal(vc.b64encode(await deriveWrapKeyBytes(mk)), c.wrap_key);
    const wk = await vc.deriveWrapKey(mk);
    assert.equal(wk.extractable, false, 'wrap key is a non-extractable CryptoKey');
    assert.deepEqual(wk.usages.sort(), ['decrypt', 'encrypt']);
    assert.equal(vc.b64encode(await vc.open(wk, c.wrapped_key, vc.AAD_KEY)), c.vault_key);
    assert.equal(await sealWithNonce(vc.b64decode(c.wrap_key), vc.b64decode(c.vault_key), vc.AAD_KEY, vc.b64decode(c.wrap_nonce)), c.wrapped_key);
    assert.equal(vc.b64encode(await vc.unlockVault(c.password, c)), c.vault_key);
    const nfd = c.password.normalize('NFD');
    if (nfd !== c.password) assert.equal(vc.b64encode(await vc.deriveMasterKey(nfd, salt, c.kdf_iterations)), c.master_key, 'NFC normalization');
  });
}

for (const it of vectors.items) {
  test(`own item known answer ${it.id}`, async () => {
    const vk = vc.b64decode(vectors.vault_key);
    const obj = await vc.decryptItem(vk, it.id, it.data);
    assert.equal(JSON.stringify(obj), it.plaintext_json);
    assert.equal(await sealWithNonce(vk, te.encode(it.plaintext_json), vc.AAD_ITEM_PREFIX + it.id, vc.b64decode(it.nonce)), it.data);
  });
}

test('own folder known answer', async () => {
  const vk = vc.b64decode(vectors.vault_key);
  for (const f of vectors.folders) {
    assert.equal(await vc.decryptFolder(vk, f.id, f.sealed), f.name);
    assert.equal(await sealWithNonce(vk, te.encode(f.plaintext_json), vc.AAD_FOLDER_PREFIX + f.id, vc.b64decode(f.nonce)), f.sealed);
  }
});

test('wrong master password -> bad_password', async () => {
  const c = vectors.kdf[1];
  await assert.rejects(vc.unlockVault(`${c.password}x`, c), code('bad_password'));
});

test('unlock hardening: refuse weak/odd params before deriving (§8.3)', async () => {
  const c = vectors.kdf[0];
  await assert.rejects(vc.unlockVault(c.password, { ...c, kdf: 'argon2id' }), code('unsupported'));
  await assert.rejects(vc.unlockVault(c.password, { ...c, kdf_iterations: 599999 }), code('invalid_argument'));
  await assert.rejects(vc.unlockVault(c.password, { ...c, kdf_iterations: 1 }), code('invalid_argument'));
  await assert.rejects(vc.unlockVault(c.password, { ...c, kdf_iterations: 10_000_001 }), code('invalid_argument'));
  await assert.rejects(vc.unlockVault(c.password, { ...c, kdf_iterations: '600000' }), code('invalid_argument'));
  await assert.rejects(vc.unlockVault(c.password, { ...c, kdf_salt: 'AAAA' }), code('malformed'));
  await assert.rejects(vc.unlockVault(c.password, { ...c, kdf_salt: vc.b64encode(new Uint8Array(65)) }), code('malformed'));
  await assert.rejects(vc.unlockVault(c.password, null), code('unsupported'));
});

test('seal/open round trip, AAD binding and tamper detection', async () => {
  const key = vc.randomBytes(32);
  const pt = te.encode('hello wörld');
  const sealed = await vc.seal(key, pt, 'aad-1');
  assert.match(sealed, /^v1\.[A-Za-z0-9+/]{16}\.[A-Za-z0-9+/=]+$/);
  assert.equal(td.decode(await vc.open(key, sealed, 'aad-1')), 'hello wörld');
  assert.notEqual(await vc.seal(key, pt, 'aad-1'), sealed, 'random nonces');
  await assert.rejects(vc.open(key, sealed, 'aad-2'), code('decrypt_failed'));
  await assert.rejects(vc.open(vc.randomBytes(32), sealed, 'aad-1'), code('decrypt_failed'));
  const [v, n, c] = sealed.split('.');
  const ct = vc.b64decode(c);
  ct[0] ^= 1;
  await assert.rejects(vc.open(key, `${v}.${n}.${vc.b64encode(ct)}`, 'aad-1'), code('decrypt_failed'));
  await assert.rejects(vc.open(key, sealed.replace(/^v1/, 'v2'), 'aad-1'), code('unsupported_version'));
  await assert.rejects(vc.open(key, 'v1.abc', 'aad-1'), code('malformed'));
  await assert.rejects(vc.open(key, `v1.${vc.b64encode(vc.randomBytes(8))}.${c}`, 'aad-1'), code('malformed'));
  await assert.rejects(vc.open(key, `v1.${n}.AAAA`, 'aad-1'), code('malformed'));
  await assert.rejects(vc.open(key, 12, 'aad-1'), code('malformed'));
  const ck = await vc.importAesKey(key);
  assert.equal(td.decode(await vc.open(ck, await vc.seal(ck, 'str input', 'x'), 'x')), 'str input');
  await assert.rejects(vc.seal(vc.randomBytes(16), pt, 'x'), code('invalid_argument'));
  await assert.rejects(sealWithNonce(key, pt, 'x', new Uint8Array(8)), code('invalid_argument'));
});

test('items are bound to their id (a malicious server cannot swap records)', async () => {
  const vk = vc.randomBytes(32);
  const a = vc.uuid();
  const b = vc.uuid();
  const data = await vc.encryptItem(vk, a, { type: 'note', name: 'A', notes: 'x' });
  await assert.rejects(vc.decryptItem(vk, b, data), code('decrypt_failed'));
  const folder = await vc.encryptFolder(vk, a, 'Work');
  await assert.rejects(vc.decryptFolder(vk, b, folder), code('decrypt_failed'));
  await assert.rejects(vc.decryptFolder(vk, a, data), code('decrypt_failed'));
  await assert.rejects(vc.encryptItem(vk, 'not-a-uuid', {}), code('invalid_argument'));
  await assert.rejects(vc.encryptItem(vk, a, ['array']), code('invalid_argument'));
});

test('decryptItem preserves unknown keys and rejects non-object plaintext', async () => {
  const vk = vc.randomBytes(32);
  const id = vc.uuid();
  const obj = { type: 'login', name: 'X', login: { username: 'u', password: 'p', uris: [] }, x_new: { a: [1, { b: 2 }] } };
  assert.deepEqual(await vc.decryptItem(vk, id, await vc.encryptItem(vk, id, obj)), obj);
  await assert.rejects(vc.decryptItem(vk, id, await vc.seal(vk, '[1,2]', vc.AAD_ITEM_PREFIX + id)), code('malformed'));
  await assert.rejects(vc.decryptItem(vk, id, await vc.seal(vk, '{nope', vc.AAD_ITEM_PREFIX + id)), code('malformed'));
  await assert.rejects(vc.decryptItem(vk, id, await vc.seal(vk, new Uint8Array([0xff, 0xfe]), vc.AAD_ITEM_PREFIX + id)), code('malformed'));
});

test('createVault / unlockVault / rewrapVaultKey', async () => {
  await assert.rejects(vc.createVault('pw', { iterations: 599999 }), code('invalid_argument'));
  await assert.rejects(vc.createVault(''), code('invalid_argument'));
  const { vaultKey, params } = await vc.createVault('master pässword');
  assert.deepEqual(Object.keys(params).sort(), ['kdf', 'kdf_iterations', 'kdf_salt', 'wrapped_key']);
  assert.equal(params.kdf, 'pbkdf2-sha256');
  assert.equal(params.kdf_iterations, 600000);
  assert.equal(vc.b64decode(params.kdf_salt).length, 16);
  assert.equal(vaultKey.length, 32);
  assert.deepEqual(await vc.unlockVault('master pässword', params), vaultKey);
  const next = await vc.rewrapVaultKey(vaultKey, 'new master', { iterations: 600001 });
  assert.equal(next.kdf_iterations, 600001);
  assert.notEqual(next.kdf_salt, params.kdf_salt);
  assert.deepEqual(await vc.unlockVault('new master', next), vaultKey);
  await assert.rejects(vc.unlockVault('master pässword', next), code('bad_password'));
  await assert.rejects(vc.rewrapVaultKey(vaultKey, 'x', { iterations: 1000 }), code('invalid_argument'));
  await assert.rejects(vc.rewrapVaultKey(vaultKey, ''), code('invalid_argument'));
});

test('python cryptography independently verifies JS output', { skip: !pythonAvailable() && 'python3 + cryptography not available' }, async () => {
  const password = 'Zürich naïve — 🔐';
  const salt = vc.randomBytes(16);
  const iterations = 1500;
  const mk = await vc.deriveMasterKey(password, salt, iterations);
  const wkBytes = await deriveWrapKeyBytes(mk);
  const vk = vc.randomBytes(32);
  const wrapped = await vc.seal(await vc.deriveWrapKey(mk), vk, vc.AAD_KEY);
  const id = vc.uuid();
  const item = { type: 'login', name: 'Bank ✓', login: { username: 'me', password: 'p@ss', uris: [] } };
  const data = await vc.encryptItem(vk, id, item);
  const doc = {
    kdf: [{ name: 'js', password, kdf_salt: vc.b64encode(salt), kdf_iterations: iterations, master_key: vc.b64encode(mk), wrap_key: vc.b64encode(wkBytes), wrapped_key: wrapped, vault_key: vc.b64encode(vk) }],
    sealed: [{ name: 'item', key: vc.b64encode(vk), sealed: data, aad: vc.AAD_ITEM_PREFIX + id, plaintext: vc.b64encode(te.encode(JSON.stringify(item))) }],
  };
  const r = spawnSync('python3', ['-I', path.join(root, 'scripts', 'vectors', 'make_vectors.py'), 'verify'], { input: JSON.stringify(doc), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr || r.stdout);
  assert.deepEqual(JSON.parse(r.stdout), { ok: true, errors: [] });
});

// ---- Shared spec vectors (docs/spec/vault-test-vectors.json, produced by the canonical web implementation)
const specPath = path.resolve(root, '..', 'ludworks-server', 'docs', 'spec', 'vault-test-vectors.json');
const spec = existsSync(specPath) ? JSON.parse(readFileSync(specPath, 'utf8')) : null;
const skipSpec = !spec && 'ludworks-server/docs/spec/vault-test-vectors.json not present';

test('spec vectors: kdf, nfc and wrapped key', { skip: skipSpec }, async () => {
  const k = spec.kdf;
  const mk = await vc.deriveMasterKey(k.password, hex(k.kdf_salt_hex), k.kdf_iterations);
  assert.equal(toHex(mk), k.master_key_hex);
  assert.equal(vc.b64encode(hex(k.kdf_salt_hex)), k.kdf_salt);
  assert.equal(toHex(await deriveWrapKeyBytes(mk)), k.wrap_key_hex);

  const n = spec.nfc;
  assert.notEqual(n.password, n.password.normalize('NFC'), 'vector password is deliberately not NFC');
  assert.equal(toHex(te.encode(n.password.normalize('NFC'))), n.password_nfc_utf8_hex);
  assert.equal(toHex(await vc.deriveMasterKey(n.password, hex(n.kdf_salt_hex), n.kdf_iterations)), n.master_key_hex);

  const w = spec.wrapped_key;
  assert.equal(await sealWithNonce(hex(k.wrap_key_hex), hex(w.vault_key_hex), w.aad, hex(w.nonce_hex)), w.sealed);
  assert.equal(toHex(await vc.unlockVault(k.password, w.server_params)), w.vault_key_hex);
  await assert.rejects(vc.unlockVault('not the password', w.server_params), code('bad_password'));
});

test('spec vectors: item, folder and open_must_fail', { skip: skipSpec }, async () => {
  const vk = hex(spec.wrapped_key.vault_key_hex);
  const it = spec.item;
  assert.equal(it.aad, vc.AAD_ITEM_PREFIX + it.id);
  assert.equal(await sealWithNonce(vk, te.encode(it.plaintext_json), it.aad, hex(it.nonce_hex)), it.data);
  const obj = await vc.decryptItem(vk, it.id, it.data);
  assert.equal(JSON.stringify(obj), it.plaintext_json, 'byte-for-byte plaintext');
  const f = spec.folder;
  assert.equal(await sealWithNonce(vk, te.encode(f.plaintext_json), f.aad, hex(f.nonce_hex)), f.sealed);
  assert.equal(await vc.decryptFolder(vk, f.id, f.sealed), f.name);
  assert.ok(spec.open_must_fail.length >= 4);
  for (const c of spec.open_must_fail) {
    await assert.rejects(vc.open(hex(c.key_hex), c.sealed, c.aad), code(c.error), c.case);
  }
});

test('spec vectors: TOTP and otpauth parsing', { skip: skipSpec }, async () => {
  const { computeTotp, base32decode, parseOtpauth } = await import('../src/lib/totp.js');
  assert.ok(spec.totp.length >= 18);
  for (const v of spec.totp) {
    const r = await computeTotp(base32decode(v.secret_base32), { algorithm: v.algorithm, digits: v.digits, period: v.period }, v.unix_time * 1000);
    assert.equal(r.code, v.code, `${v.algorithm}/${v.digits}/${v.period} @ ${v.unix_time}`);
  }
  for (const v of spec.otpauth) assert.deepEqual(parseOtpauth(v.uri), v.parsed, v.uri);
});

test('spec vectors: generator determinism (§8.2)', { skip: skipSpec }, async () => {
  const { generatePassword, generatePassphrase } = await import('../src/lib/generator.js');
  const g = spec.generator;
  const seed = te.encode(g.seed_utf8);
  async function stream(nBlocks) {
    const out = new Uint8Array(nBlocks * 32);
    for (let i = 0; i < nBlocks; i++) {
      const msg = new Uint8Array(seed.length + 4);
      msg.set(seed);
      new DataView(msg.buffer).setUint32(seed.length, i, true);
      out.set(new Uint8Array(await crypto.subtle.digest('SHA-256', msg)), i * 32);
    }
    let pos = 0;
    return (n) => {
      const chunk = out.subarray(pos, pos + n);
      pos += n;
      if (chunk.length < n) throw new Error('test stream exhausted');
      return Uint8Array.from(chunk);
    };
  }
  for (const c of g.passwords) {
    assert.equal(generatePassword({ ...c.options, rng: await stream(4096) }), c.password, JSON.stringify(c.options));
  }
  // Passphrase vectors index into the canonical web word list; reproduce them with that list when present.
  const canonicalList = path.resolve(root, '..', 'ludworks-server', 'web', 'assets', 'js', 'lib', 'vault', 'wordlist.js');
  if (existsSync(canonicalList)) {
    const { WORDS } = await import(canonicalList);
    assert.equal(WORDS.length, g.passphrase.wordlist_size);
    const pp = generatePassphrase({ ...g.passphrase.options, rng: await stream(4096), wordlist: WORDS });
    assert.equal(pp, g.passphrase.passphrase);
  }
});
