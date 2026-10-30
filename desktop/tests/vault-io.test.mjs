// Bitwarden / browser CSV import-export incl. passkeys (VAULT-CRYPTO.md §8.4). Runs against the staged app
// (node desktop/build.mjs stage), whose modules resolve ../lib like at runtime.
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { bwCredentialIdToRaw, rawToBwCredentialId, parseImport, serializeExport, detectFormat, needsPassword, parseBrowserPasswordCsv } from '../build/app/main/import/vault-io.js';

const b64u = (b) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const pkcs8 = () => b64u(generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ format: 'der', type: 'pkcs8' }));

function bitwardenExport() {
  return {
    encrypted: false,
    folders: [{ id: 'f1', name: 'Work' }],
    items: [
      {
        id: 'i1', organizationId: null, folderId: 'f1', type: 1, reprompt: 0, name: 'GitHub', notes: 'n', favorite: true,
        fields: [{ name: 'PIN', value: '1234', type: 1, linkedId: null }],
        login: {
          uris: [{ match: null, uri: 'https://github.com/login' }, { match: 1, uri: 'https://gist.github.com' }],
          username: 'octo', password: 'pw-1', totp: 'JBSWY3DPEHPK3PXP',
          fido2Credentials: [
            { credentialId: 'c0c1c2c3-c4c5-c6c7-c8c9-cacbcccdcecf', keyType: 'public-key', keyAlgorithm: 'ECDSA', keyCurve: 'P-256', keyValue: pkcs8(), rpId: 'github.com', userHandle: b64u(Buffer.from('user-1')), userName: 'octo', counter: '7', rpName: 'GitHub', userDisplayName: 'Octo Cat', discoverable: 'true', creationDate: '2025-01-02T03:04:05.000Z' },
            { credentialId: `b64.${b64u(Buffer.alloc(32, 9))}`, keyType: 'public-key', keyAlgorithm: 'ECDSA', keyCurve: 'P-256', keyValue: pkcs8(), rpId: 'github.com', userHandle: null, userName: 'octo2', counter: '0', rpName: 'GitHub', userDisplayName: null, discoverable: 'false', creationDate: '2025-01-02T03:04:05.000Z' },
            { credentialId: 'not-a-guid', keyType: 'public-key', keyAlgorithm: 'ECDSA', keyCurve: 'P-256', keyValue: 'AAAA', rpId: 'github.com' },
          ],
        },
        passwordHistory: [{ lastUsedDate: '2024-01-01T00:00:00.000Z', password: 'old' }],
        revisionDate: '2025-01-02T03:04:05.000Z', creationDate: '2024-01-02T03:04:05.000Z', deletedDate: null,
      },
      { id: 'trash', type: 1, name: 'Deleted', login: { username: 'x', password: 'y' }, deletedDate: '2025-01-01T00:00:00.000Z' },
      { id: 'i2', type: 2, name: 'Note', notes: 'secret note', secureNote: { type: 0 }, revisionDate: '2025-01-02T03:04:05.000Z' },
      { id: 'i3', type: 3, name: 'Visa', card: { cardholderName: 'A', brand: 'Visa', number: '4111111111111111', expMonth: '1', expYear: '2030', code: '123' } },
    ],
  };
}

test('credential id mapping: GUID ⇄ 16 raw bytes, b64. for other lengths', () => {
  const raw = bwCredentialIdToRaw('c0c1c2c3-c4c5-c6c7-c8c9-cacbcccdcecf');
  assert.equal(Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('hex'), 'c0c1c2c3c4c5c6c7c8c9cacbcccdcecf');
  assert.equal(rawToBwCredentialId(raw), 'c0c1c2c3-c4c5-c6c7-c8c9-cacbcccdcecf');
  const long = b64u(Buffer.alloc(32, 9));
  assert.equal(bwCredentialIdToRaw(`b64.${long}`), long);
  assert.equal(rawToBwCredentialId(long), `b64.${long}`);
  assert.equal(bwCredentialIdToRaw('nope'), null);
});

test('Bitwarden JSON import keeps passkeys, skips trash and unreadable passkeys', async () => {
  const buf = Buffer.from(JSON.stringify(bitwardenExport()));
  assert.equal(detectFormat(buf), 'bitwarden-json');
  assert.equal(needsPassword('bitwarden-json', buf), false);
  const r = await parseImport(buf);
  assert.equal(r.items.length, 3);
  const gh = r.items.find((i) => i.name === 'GitHub');
  assert.equal(gh.folderPath, 'Work');
  assert.equal(gh.login.passkeys.length, 2);
  const [p1, p2] = gh.login.passkeys;
  assert.equal(p1.rp_id, 'github.com');
  assert.equal(p1.counter, 7);
  assert.equal(p1.discoverable, true);
  assert.equal(p1.algorithm, -7);
  assert.equal(p2.discoverable, false);
  assert.ok(r.warnings.some((w) => /a passkey could not be used because its credential id is not readable/.test(w)));
  assert.equal(gh.fields.filter((f) => f.bitwarden === 'login.fido2Credential').length, 1, 'the unreadable passkey is kept (hidden field) for export');
  assert.ok(!r.warnings.some((w) => /cannot be transferred/.test(w)));
});

test('export → import round trip (unencrypted and password-protected) keeps passkeys', async () => {
  const data = await parseImport(Buffer.from(JSON.stringify(bitwardenExport())));
  for (const fmt of ['bitwarden-json', 'bitwarden-json-protected']) {
    const out = await serializeExport(fmt, data, { password: 'file pass 123' });
    const buf = Buffer.from(out);
    assert.equal(needsPassword('bitwarden-json', buf), fmt === 'bitwarden-json-protected');
    if (fmt === 'bitwarden-json') {
      const j = JSON.parse(out);
      const creds = j.items.find((i) => i.name === 'GitHub').login.fido2Credentials;
      assert.equal(creds[0].credentialId, 'c0c1c2c3-c4c5-c6c7-c8c9-cacbcccdcecf');
      assert.equal(creds[0].counter, '7');
      assert.equal(creds[1].discoverable, 'false');
    }
    const back = await parseImport(buf, { password: 'file pass 123' });
    const gh = back.items.find((i) => i.name === 'GitHub');
    assert.deepEqual(gh.login.passkeys.map((p) => p.credential_id), data.items.find((i) => i.name === 'GitHub').login.passkeys.map((p) => p.credential_id));
    assert.equal(gh.login.password, 'pw-1');
    assert.equal(back.items.find((i) => i.type === 'card').card.number, '4111111111111111');
  }
  await assert.rejects(parseImport(Buffer.from(await serializeExport('bitwarden-json-protected', data, { password: 'right' })), { password: 'wrong' }), /wrong (export|file) password|bad_password/i);
});

test('Bitwarden CSV round trip', async () => {
  const data = await parseImport(Buffer.from(JSON.stringify(bitwardenExport())));
  const csv = await serializeExport('bitwarden-csv', data);
  assert.equal(detectFormat(Buffer.from(csv)), 'bitwarden-csv');
  const back = await parseImport(Buffer.from(csv));
  assert.equal(back.items.find((i) => i.name === 'GitHub').login.username, 'octo');
});

test('Chrome/Edge and Firefox password CSV', async () => {
  const chrome = 'name,url,username,password,note\nexample.com,https://example.com/login,alice,s3cret,hello\n,https://x.test/,bob,pw,\n';
  assert.equal(detectFormat(Buffer.from(chrome)), 'browser-csv');
  const r = await parseImport(Buffer.from(chrome));
  assert.equal(r.items.length, 2);
  assert.equal(r.items[0].login.uris[0].uri, 'https://example.com/login');
  assert.equal(r.items[1].name, 'x.test');
  const ff = '"url","username","password","httpRealm","formActionOrigin","guid","timeCreated","timeLastUsed","timePasswordChanged"\n"https://moz.test","u","p",,"https://moz.test","{x}","1","1","1"\n';
  assert.equal(parseBrowserPasswordCsv(ff).items[0].login.username, 'u');
});
