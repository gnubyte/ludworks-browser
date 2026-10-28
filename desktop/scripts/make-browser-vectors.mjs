#!/usr/bin/env node
// Test vectors for Ludworks Browser sync (VAULT-CRYPTO.md §9) and passkeys (§10), shared by every
// client (desktop, Android). Deterministic: fixed vault key, nonces and P-256 key.
//
//   node desktop/scripts/make-browser-vectors.mjs           print JSON
//   node desktop/scripts/make-browser-vectors.mjs --write   write ../ludworks-server/docs/spec/browser-test-vectors.json
//                                                            (or LUDWORKS_SPEC_DIR) and desktop/tests/fixtures/

import { webcrypto, createPrivateKey, createPublicKey, verify } from 'node:crypto';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// Imports the staged app (run `node desktop/build.mjs stage` first): main/ resolves ../lib like at runtime.
import { __testing, importAesKey } from '../build/app/lib/vault-crypto.js';
import { clientDataJSON, authenticatorData, coseKey, AAGUID, b64u, fromB64u, getAssertion } from '../build/app/main/passkeys.js';
import { encode, CborMap } from '../build/app/main/cbor.js';

const subtle = webcrypto.subtle;
const te = new TextEncoder();
const hex = (b) => Buffer.from(b).toString('hex');
const seq = (start, n) => Uint8Array.from({ length: n }, (_, i) => start + i);

async function hkdf(raw, info) {
  const base = await subtle.importKey('raw', raw, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: te.encode(info) }, base, 256));
}

async function derivedId(idKeyBytes, collection, natural) {
  const k = await subtle.importKey('raw', idKeyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await subtle.sign('HMAC', k, te.encode(`${collection}\n${natural}`)));
  return Buffer.from(sig).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '').slice(0, 32);
}

export async function makeVectors() {
  const vaultKey = seq(0x10, 32); // same vault key as vault-test-vectors.json
  const browserKey = await hkdf(vaultKey, 'ludworks/browser/key/v1');
  const idKey = await hkdf(vaultKey, 'ludworks/browser/id/v1');
  const ids = [];
  for (const url of ['https://example.com/', 'https://www.ludworks.app/docs?x=1#top', 'http://localhost:8080/path/ü']) {
    ids.push({ collection: 'history', natural_key: url, id: await derivedId(idKey, 'history', url) });
  }
  const aesKey = await importAesKey(browserKey);
  const records = [];
  const samples = [
    ['bookmarks', '6f9619ff-8b86-4d01-b42d-00c04fc964ff', { type: 'url', parent: 'toolbar', index: 1, title: 'Ludworks', url: 'https://ludworks.app/', created_at: '2026-10-27T12:00:00.000Z', updated_at: '2026-10-27T12:00:00.000Z' }],
    ['history', ids[0].id, { url: 'https://example.com/', title: 'Example Domain', visits: [1793100000000, 1793000000000], updated_at: '2026-10-27T12:00:00.000Z' }],
    ['prefs', 'prefs', { updated_at: '2026-10-27T12:00:00.000Z', search_engine: 'duckduckgo', custom_search: null, homepage: 'ludworks://newtab/', show_bookmarks_bar: true }],
  ];
  for (const [i, [collection, id, obj]] of samples.entries()) {
    const nonce = seq(0x60 + i * 0x10, 12);
    const plaintext = JSON.stringify(obj);
    const aad = `ludworks/browser/record/v1:${collection}:${id}`;
    records.push({ collection, id, aad, plaintext_json: plaintext, nonce_hex: hex(nonce), sealed: await __testing.sealWithNonce(aesKey, te.encode(plaintext), aad, nonce) });
  }

  // Passkey: fixed P-256 private scalar d = 0x01..0x20 (valid: < n)
  const d = seq(1, 32);
  // PKCS#8 (RFC 5915 ECPrivateKey without the optional public key) for d
  const pkcs8 = Buffer.concat([Buffer.from('308141020100301306072a8648ce3d020106082a8648ce3d030107042730250201010420', 'hex'), Buffer.from(d)]);
  const priv = createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' });
  const pub = createPublicKey(priv);
  const rpId = 'example.com';
  const origin = 'https://login.example.com';
  const challenge = b64u(seq(0xa0, 32));
  const credId = seq(0xc0, 16);
  const lenBuf = Buffer.alloc(2);
  lenBuf.writeUInt16BE(16, 0);
  const createAuth = authenticatorData(rpId, 0x5d, 0, Buffer.concat([AAGUID, lenBuf, Buffer.from(credId), coseKey(pub)]));
  const attObj = encode(new CborMap([['fmt', 'none'], ['attStmt', new CborMap([])], ['authData', createAuth]]));
  const passkey = { credential_id: b64u(credId), rp_id: rpId, rp_name: 'Example', user_handle: b64u(seq(0xe0, 16)), user_name: 'alice@example.com', user_display_name: 'Alice', algorithm: -7, private_key: b64u(pkcs8), counter: 0, discoverable: true, created_at: '2026-10-27T12:00:00.000Z' };
  const assertion = getAssertion({ passkey, rpId, challenge, origin, uv: true, now: 1793100000000 });
  const signedData = Buffer.concat([fromB64u(assertion.response.authenticatorData), Buffer.from(await subtle.digest('SHA-256', fromB64u(assertion.response.clientDataJSON)))]);
  if (!verify('sha256', signedData, pub, fromB64u(assertion.response.signature))) throw new Error('self-check: signature does not verify');
  const counterPk = { ...passkey, counter: 41 };
  const counted = getAssertion({ passkey: counterPk, rpId, challenge, origin, uv: true, now: 1793100000000 });

  return {
    description: 'Ludworks Browser sync + passkey vectors (VAULT-CRYPTO.md §9, §10). Generated by ludworks-browser/desktop/scripts/make-browser-vectors.mjs.',
    vault_key_hex: hex(vaultKey),
    browser_key_hex: hex(browserKey),
    browser_idkey_hex: hex(idKey),
    derived_ids: ids,
    records,
    passkey: {
      private_key_pkcs8_b64url: b64u(pkcs8),
      public_key_spki_b64url: b64u(pub.export({ format: 'der', type: 'spki' })),
      cose_key_hex: hex(coseKey(pub)),
      aaguid_hex: hex(AAGUID),
      rp_id: rpId,
      origin,
      challenge_b64url: challenge,
      credential_id_b64url: b64u(credId),
      create: {
        client_data_json: clientDataJSON('webauthn.create', challenge, origin).toString('utf8'),
        flags_hex: '5d',
        authenticator_data_hex: hex(createAuth),
        attestation_object_hex: hex(attObj),
      },
      get: {
        client_data_json: clientDataJSON('webauthn.get', challenge, origin).toString('utf8'),
        flags_hex: '1d',
        authenticator_data_hex: hex(fromB64u(assertion.response.authenticatorData)),
        signature_note: 'ECDSA signatures are randomised: verify the signature with the public key over authenticator_data || SHA-256(client_data_json) instead of comparing bytes.',
        counter_policy: { stored: 41, now_ms: 1793100000000, expected_counter: counted.counter },
      },
      bitwarden_guid_example: { credential_id_b64url: b64u(credId), bitwarden_credentialId: 'c0c1c2c3-c4c5-c6c7-c8c9-cacbcccdcecf' },
    },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const v = await makeVectors();
  const json = JSON.stringify(v, null, 2) + '\n';
  if (!process.argv.includes('--write')) process.stdout.write(json);
  else {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const fixtures = path.join(here, '..', 'tests', 'fixtures');
    mkdirSync(fixtures, { recursive: true });
    writeFileSync(path.join(fixtures, 'browser-test-vectors.json'), json);
    const specDir = process.env.LUDWORKS_SPEC_DIR || path.join(here, '..', '..', '..', 'ludworks-server', 'docs', 'spec');
    if (existsSync(specDir)) writeFileSync(path.join(specDir, 'browser-test-vectors.json'), json);
    console.log('wrote browser-test-vectors.json');
  }
}
