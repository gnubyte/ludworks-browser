// WebAuthn authenticator (VAULT-CRYPTO.md §10) + shared vectors (docs/spec/browser-test-vectors.json).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { makeCredential, getAssertion, checkRp, clientDataJSON, fromB64u, b64u, AAGUID } from '../build/app/main/passkeys.js';

const vectors = JSON.parse(readFileSync(new URL('./fixtures/browser-test-vectors.json', import.meta.url), 'utf8'));
const sha256 = (b) => createHash('sha256').update(b).digest();

function frame(url, topUrl = url) {
  const top = { url: topUrl };
  top.top = top;
  return url === topUrl ? top : { url, top };
}

test('RP ID rules: own host, registrable parents, never public suffixes or foreign sites', () => {
  assert.equal(checkRp(frame('https://login.example.com/x'), undefined).rpId, 'login.example.com');
  assert.equal(checkRp(frame('https://login.example.com/x'), 'example.com').rpId, 'example.com');
  assert.equal(checkRp(frame('https://a.b.example.co.uk/'), 'example.co.uk').rpId, 'example.co.uk');
  for (const [url, rp] of [['https://login.example.com/', 'com'], ['https://example.co.uk/', 'co.uk'], ['https://evil.com/', 'example.com'], ['https://user.github.io/', 'github.io'], ['https://example.com.evil.net/', 'example.com'], ['https://192.168.1.10/', '168.1.10']]) {
    assert.throws(() => checkRp(frame(url), rp), (e) => e.webauthn === 'SecurityError', `${url} / ${rp}`);
  }
  assert.throws(() => checkRp(frame('http://example.com/'), undefined), (e) => e.webauthn === 'SecurityError');
  assert.equal(checkRp(frame('http://localhost:3000/'), undefined).rpId, 'localhost');
  assert.throws(() => checkRp(frame('https://ads.example.net/', 'https://site.example.com/'), undefined), (e) => e.webauthn === 'NotAllowedError');
  assert.equal(checkRp(frame('https://site.example.com/frame', 'https://site.example.com/'), undefined).rpId, 'site.example.com');
});

test('registration: authData layout, attestation object, COSE key matches SPKI', () => {
  const { passkey, response } = makeCredential({ rpId: 'example.com', rpName: 'Example', user: { id: b64u(Buffer.from('u1')), name: 'alice', displayName: 'Alice' }, challenge: b64u(Buffer.alloc(32, 1)), origin: 'https://example.com' });
  const auth = fromB64u(response.authenticatorData);
  assert.deepEqual(auth.subarray(0, 32), sha256(Buffer.from('example.com')));
  assert.equal(auth[32], 0x5d); // UP | UV | BE | BS | AT
  assert.equal(auth.readUInt32BE(33), 0);
  assert.deepEqual(auth.subarray(37, 53), AAGUID);
  assert.equal(auth.readUInt16BE(53), 16);
  assert.equal(b64u(auth.subarray(55, 71)), passkey.credential_id);
  const att = fromB64u(response.attestationObject);
  assert.equal(att[0], 0xa3); // map(3)
  assert.ok(att.includes(Buffer.from('fmt')) && att.includes(Buffer.from('none')) && att.includes(auth));
  const cdj = JSON.parse(fromB64u(response.clientDataJSON).toString());
  assert.deepEqual(Object.keys(cdj), ['type', 'challenge', 'origin', 'crossOrigin']);
  assert.equal(cdj.type, 'webauthn.create');
  // the SPKI public key verifies an assertion made with the stored private key
  const a = getAssertion({ passkey, rpId: 'example.com', challenge: b64u(Buffer.alloc(32, 2)), origin: 'https://example.com' });
  const signed = Buffer.concat([fromB64u(a.response.authenticatorData), sha256(fromB64u(a.response.clientDataJSON))]);
  assert.ok(verify('sha256', signed, createPublicKey({ key: fromB64u(response.publicKey), format: 'der', type: 'spki' }), fromB64u(a.response.signature)));
  assert.equal(a.response.userHandle, passkey.user_handle);
});

test('shared vectors: create/get authenticator data and clientDataJSON are byte-identical', () => {
  const v = vectors.passkey;
  assert.equal(clientDataJSON('webauthn.create', v.challenge_b64url, v.origin).toString(), v.create.client_data_json);
  assert.equal(clientDataJSON('webauthn.get', v.challenge_b64url, v.origin).toString(), v.get.client_data_json);
  const pk = { credential_id: v.credential_id_b64url, private_key: v.private_key_pkcs8_b64url, counter: 0, user_handle: '' };
  const a = getAssertion({ passkey: pk, rpId: v.rp_id, challenge: v.challenge_b64url, origin: v.origin, now: v.get.counter_policy.now_ms });
  assert.equal(fromB64u(a.response.authenticatorData).toString('hex'), v.get.authenticator_data_hex);
  const pub = createPublicKey({ key: fromB64u(v.public_key_spki_b64url), format: 'der', type: 'spki' });
  assert.ok(verify('sha256', Buffer.concat([Buffer.from(v.get.authenticator_data_hex, 'hex'), sha256(Buffer.from(v.get.client_data_json))]), pub, fromB64u(a.response.signature)));
  const c = getAssertion({ passkey: { ...pk, counter: v.get.counter_policy.stored }, rpId: v.rp_id, challenge: v.challenge_b64url, origin: v.origin, now: v.get.counter_policy.now_ms });
  assert.equal(c.counter, v.get.counter_policy.expected_counter);
});
