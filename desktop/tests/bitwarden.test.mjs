// Bitwarden import/export at full fidelity: every item type and field, password-protected exports (PBKDF2 and
// Argon2id — generated here by an independent WebCrypto implementation of Bitwarden's format), wrong password, account-restricted detection, KDF bounds, the ZIP export with
// attachments, CSV, import → export → import equality, duplicate handling and the import run (progress,
// folders, merges) against a vault that really encrypts. Runs against the staged app (node desktop/build.mjs stage).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateKeyPairSync, webcrypto, createHash, randomBytes, randomUUID } from 'node:crypto';
import { createZip } from '../../scripts/lib/zip.mjs';
import { parseImport, serializeExport, exportVaultFile, detectFormat, inspectImport } from '../build/app/main/import/vault-io.js';
import { planImport, mergeLogin, contentKey } from '../build/app/main/import/dedupe.js';
import { preview, commit, writeAttachments, vaultData } from '../build/app/main/import/vault-import.js';
import { argon2Sync } from '../build/app/vendor/vault/argon2.js';
import * as vc from '../build/app/lib/vault-crypto.js';

const subtle = webcrypto.subtle;
const te = new TextEncoder();
const b64u = (b) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const pkcs8 = () => b64u(generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ format: 'der', type: 'pkcs8' }));
const code = (c) => (e) => {
  assert.equal(e.code, c, `expected ${c}, got ${e.code}: ${e.message}`);
  return true;
};
const strip = (items) => items.map((it) => JSON.parse(JSON.stringify(it)));

const KEY1 = pkcs8();
const KEY2 = pkcs8();
const SSH_PRIVATE = generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' });
const ID = (n) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`;
const login = (n, name, l, extra = {}) => ({ passwordHistory: null, revisionDate: '2025-01-01T00:00:00.000Z', creationDate: '2024-01-01T00:00:00.000Z', deletedDate: null, id: ID(n), organizationId: null, folderId: null, type: 1, reprompt: 0, name, notes: null, favorite: false, login: { fido2Credentials: [], uris: [], username: null, password: null, totp: null, ...l }, collectionIds: null, ...extra });

/** A synthetic individual Bitwarden export with every item type and field Bitwarden has. */
function fullExport() {
  return {
    encrypted: false,
    folders: [{ id: 'f-work', name: 'Work' }, { id: 'f-email', name: 'Work/Email' }, { id: 'f-empty', name: 'Empty folder' }],
    items: [
      {
        passwordHistory: [{ lastUsedDate: '2024-05-01T00:00:00.000Z', password: 'old-2' }, { lastUsedDate: '2024-01-01T00:00:00.000Z', password: 'old-1' }],
        revisionDate: '2025-02-03T04:05:06.000Z', creationDate: '2023-01-02T03:04:05.000Z', deletedDate: null,
        id: ID(1), organizationId: null, folderId: 'f-email', type: 1, reprompt: 1, name: 'GitHub', notes: 'multi\nline, "quoted"', favorite: true,
        fields: [
          { name: 'Text', value: 'plain', type: 0, linkedId: null },
          { name: 'PIN', value: '1234', type: 1, linkedId: null },
          { name: '2FA enabled', value: 'true', type: 2, linkedId: null },
          { name: 'Login name', value: null, type: 3, linkedId: 100 },
          { name: 'Secret', value: null, type: 3, linkedId: 101 },
        ],
        login: {
          fido2Credentials: [
            { credentialId: 'c0c1c2c3-c4c5-c6c7-c8c9-cacbcccdcecf', keyType: 'public-key', keyAlgorithm: 'ECDSA', keyCurve: 'P-256', keyValue: KEY1, rpId: 'github.com', userHandle: b64u(Buffer.from('user-1')), userName: 'octo', counter: '7', rpName: 'GitHub', userDisplayName: 'Octo Cat', discoverable: 'true', creationDate: '2025-01-02T03:04:05.000Z' },
            { credentialId: `b64.${b64u(Buffer.alloc(32, 9))}`, keyType: 'public-key', keyAlgorithm: 'ECDSA', keyCurve: 'P-256', keyValue: KEY2, rpId: 'github.com', userHandle: null, userName: 'octo2', counter: '0', rpName: 'GitHub', userDisplayName: null, discoverable: 'false', creationDate: '2025-01-03T03:04:05.000Z' },
          ],
          uris: [
            { match: null, uri: 'https://github.com/login' }, { match: 0, uri: 'https://github.com' }, { match: 1, uri: 'https://gist.github.com' }, { match: 2, uri: 'https://api.github.com/v3' },
            { match: 3, uri: 'https://github.com/exact' }, { match: 4, uri: '^https://(www\\.)?github\\.com/.*$' }, { match: 5, uri: 'https://never.github.com' }, { match: null, uri: 'androidapp://com.github.android' },
          ],
          username: 'octo', password: 'pw-1 ✓ "q"', totp: 'otpauth://totp/GitHub:octo?secret=JBSWY3DPEHPK3PXP&issuer=GitHub&algorithm=SHA256&digits=8&period=60',
        },
        collectionIds: null,
      },
      login(2, 'Bare base32', { username: 'b', password: 'p', totp: 'JBSW Y3DP EHPK 3PXP', uris: [{ match: null, uri: 'https://base32.example' }] }),
      login(3, 'Steam', { username: 's', password: 'p', totp: 'steam://JBSWY3DPEHPK3PXP' }, { folderId: 'f-work' }),
      login(4, 'Counter based', { username: 'h', password: 'p', totp: 'otpauth://hotp/X?secret=JBSWY3DPEHPK3PXP&counter=1' }),
      login(5, 'Ed25519 passkey', { username: 'e', fido2Credentials: [{ credentialId: 'd0d1d2d3-d4d5-d6d7-d8d9-dadbdcdddedf', keyType: 'public-key', keyAlgorithm: 'EdDSA', keyCurve: 'Ed25519', keyValue: 'AAAA', rpId: 'ed.example', userHandle: null, userName: 'e', counter: '0', rpName: 'Ed', userDisplayName: null, discoverable: 'true', creationDate: '2025-01-01T00:00:00.000Z' }] }),
      { id: ID(6), type: 2, name: 'Secure note', notes: 'secret note', favorite: false, folderId: 'f-work', secureNote: { type: 0 }, fields: [{ name: 'Hidden', value: 'h', type: 1, linkedId: null }], revisionDate: '2025-01-01T00:00:00.000Z', creationDate: '2024-01-01T00:00:00.000Z', reprompt: 0 },
      { id: ID(7), type: 3, name: 'Visa', notes: null, favorite: false, folderId: null, reprompt: 0, card: { cardholderName: 'Jane Doe', brand: 'Visa', number: '4111111111111111', expMonth: '12', expYear: '2030', code: '123' }, fields: [{ name: 'Card PIN', value: null, type: 3, linkedId: 303 }], revisionDate: '2025-01-01T00:00:00.000Z', creationDate: '2024-01-01T00:00:00.000Z' },
      {
        id: ID(8), type: 4, name: 'Me', notes: 'id notes', favorite: false, folderId: null, reprompt: 0, revisionDate: '2025-01-01T00:00:00.000Z', creationDate: '2024-01-01T00:00:00.000Z',
        identity: { title: 'Dr', firstName: 'Jane', middleName: 'Q', lastName: 'Doe', address1: '1 Main St', address2: 'Apt 2', address3: 'Building C', city: 'Springfield', state: 'IL', postalCode: '62701', country: 'US', company: 'ACME', email: 'jane@example.test', phone: '+1 555 0100', ssn: '000-00-0000', username: 'jdoe', passportNumber: 'X0000000', licenseNumber: 'D000-0000' },
        fields: [{ name: 'Nickname', value: 'JD', type: 0, linkedId: null }],
      },
      { id: ID(9), type: 5, name: 'Server key', notes: 'deploy key', favorite: false, folderId: 'f-work', reprompt: 0, sshKey: { privateKey: SSH_PRIVATE, publicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample me@host', keyFingerprint: 'SHA256:4mGn7d2xExampleFingerprint' }, revisionDate: '2025-01-01T00:00:00.000Z', creationDate: '2024-01-01T00:00:00.000Z' },
      { id: ID(10), type: 6, name: 'Checking', notes: null, favorite: false, folderId: null, reprompt: 0, bankAccount: { bankName: 'Test Bank', nameOnAccount: 'Jane Doe', accountType: 'Checking', accountNumber: '000123456789', routingNumber: '000000000', branchNumber: null, pin: '9999', swiftCode: 'TESTUS00', iban: 'XX00TEST0000000000', bankContactPhone: '+1 555 0101' }, revisionDate: '2025-01-01T00:00:00.000Z', creationDate: '2024-01-01T00:00:00.000Z' },
      { id: ID(11), type: 7, name: 'Driving licence', notes: null, favorite: false, folderId: null, reprompt: 0, driversLicense: { firstName: 'Jane', middleName: null, lastName: 'Doe', dateOfBirth: '1990-01-01', licenseNumber: 'D000-0000', issuingCountry: 'US', issuingState: 'IL', issueDate: '2020-01-01', expirationDate: '2030-01-01', issuingAuthority: 'DMV', licenseClass: 'C' }, revisionDate: '2025-01-01T00:00:00.000Z', creationDate: '2024-01-01T00:00:00.000Z' },
      { id: ID(12), type: 8, name: 'Passport', notes: null, favorite: true, folderId: null, reprompt: 1, passport: { surname: 'Doe', givenName: 'Jane', dateOfBirth: '1990-01-01', sex: 'F', birthPlace: 'Springfield', nationality: 'US', issuingCountry: 'US', passportNumber: 'X0000000', passportType: 'P', nationalIdentificationNumber: null, issuingAuthority: 'DoS', issueDate: '2020-01-01', expirationDate: '2030-01-01' }, revisionDate: '2025-01-01T00:00:00.000Z', creationDate: '2024-01-01T00:00:00.000Z' },
      login(13, 'Old forum', { username: 'a', password: 'p', uris: [{ match: null, uri: 'https://forum.example' }] }, { archivedDate: '2025-03-01T00:00:00.000Z' }),
      login(14, 'Deleted', { username: 'x', password: 'y' }, { deletedDate: '2025-01-05T00:00:00.000Z', folderId: 'f-work' }),
      login(15, '', { username: 'nameless', password: 'p', uris: [{ match: null, uri: 'https://www.unnamed.example/login' }] }),
      { id: ID(16), type: 99, name: 'Future type', notes: 'kept', favorite: false, folderId: null, reprompt: 0, revisionDate: '2025-01-01T00:00:00.000Z', creationDate: '2024-01-01T00:00:00.000Z' },
    ],
  };
}
const FULL = Buffer.from(JSON.stringify(fullExport(), null, 2));

// Independent implementation of Bitwarden's password-protected export (raw WebCrypto, Bitwarden's documented
// format) so the importer is checked against files it did not produce itself.
async function independentProtect(clearJson, password, kdf) {
  const salt = randomBytes(16).toString('base64');
  let master;
  if (kdf.kdfType === 0) {
    const base = await subtle.importKey('raw', te.encode(password), 'PBKDF2', false, ['deriveBits']);
    master = new Uint8Array(await subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: te.encode(salt), iterations: kdf.kdfIterations }, base, 256));
  } else {
    master = argon2Sync({ password: te.encode(password), salt: createHash('sha256').update(salt, 'utf8').digest(), iterations: kdf.kdfIterations, memory: kdf.kdfMemory * 1024, parallelism: kdf.kdfParallelism, hashLength: 32, type: 'argon2id', version: 0x13 });
  }
  const prk = await subtle.importKey('raw', master, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const encKey = new Uint8Array(await subtle.sign('HMAC', prk, te.encode('enc\u0001')));
  const macKey = new Uint8Array(await subtle.sign('HMAC', prk, te.encode('mac\u0001')));
  const encString = async (text) => {
    const iv = randomBytes(16);
    const k = await subtle.importKey('raw', encKey, { name: 'AES-CBC' }, false, ['encrypt']);
    const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-CBC', iv }, k, te.encode(text)));
    const mk = await subtle.importKey('raw', macKey, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const mac = new Uint8Array(await subtle.sign('HMAC', mk, Buffer.concat([iv, ct])));
    return `2.${Buffer.from(iv).toString('base64')}|${Buffer.from(ct).toString('base64')}|${Buffer.from(mac).toString('base64')}`;
  };
  return JSON.stringify({
    encrypted: true, passwordProtected: true, salt, kdfType: kdf.kdfType, kdfIterations: kdf.kdfIterations, kdfMemory: kdf.kdfMemory ?? null, kdfParallelism: kdf.kdfParallelism ?? null,
    encKeyValidation_DO_NOT_EDIT: await encString(randomUUID()), data: await encString(clearJson),
  });
}

const byName = (r, n) => r.items.find((i) => i.name === n);

// ------------------------------------------------------------------------------------------------ mapping
test('every Bitwarden item type and field is imported (nothing silently dropped)', async () => {
  assert.equal(detectFormat(FULL), 'bitwarden-json');
  const info = inspectImport(FULL);
  assert.equal(info.needsPassword, false);
  assert.equal(info.accountRestricted, false);
  const r = await parseImport(FULL);
  assert.equal(r.items.length, 15, 'trash skipped');
  assert.deepEqual(r.folders.map((f) => f.name).sort(), ['Empty folder', 'Work', 'Work/Email']);

  const gh = byName(r, 'GitHub');
  assert.equal(gh.type, 'login');
  assert.equal(gh.folderPath, 'Work/Email');
  assert.equal(gh.favorite, true);
  assert.equal(gh.reprompt, true);
  assert.equal(gh.notes, 'multi\nline, "quoted"');
  assert.equal(gh.created_at, '2023-01-02T03:04:05.000Z');
  assert.equal(gh.updated_at, '2025-02-03T04:05:06.000Z');
  assert.equal(gh.login.username, 'octo');
  assert.equal(gh.login.password, 'pw-1 ✓ "q"');
  assert.equal(gh.login.totp, 'otpauth://totp/GitHub:octo?secret=JBSWY3DPEHPK3PXP&issuer=GitHub&algorithm=SHA256&digits=8&period=60');
  assert.deepEqual(gh.login.uris, [
    { uri: 'https://github.com/login' }, { uri: 'https://github.com', match: 'domain' }, { uri: 'https://gist.github.com', match: 'host' }, { uri: 'https://api.github.com/v3', match: 'starts_with' },
    { uri: 'https://github.com/exact', match: 'exact' }, { uri: '^https://(www\\.)?github\\.com/.*$', match: 'regex' }, { uri: 'https://never.github.com', match: 'never' }, { uri: 'androidapp://com.github.android' },
  ]);
  assert.deepEqual(gh.password_history, [{ password: 'old-2', changed_at: '2024-05-01T00:00:00.000Z' }, { password: 'old-1', changed_at: '2024-01-01T00:00:00.000Z' }]);
  assert.deepEqual(gh.fields, [
    { name: 'Text', value: 'plain', hidden: false },
    { name: 'PIN', value: '1234', hidden: true },
    { name: '2FA enabled', value: 'true', hidden: false, type: 'boolean' },
    { name: 'Login name', value: '(linked to Username)', hidden: false, type: 'linked', linked_id: 100 },
    { name: 'Secret', value: '(linked to Password)', hidden: false, type: 'linked', linked_id: 101 },
  ]);
  const [p1, p2] = gh.login.passkeys;
  assert.equal(gh.login.passkeys.length, 2);
  assert.deepEqual(p1, {
    credential_id: b64u(Buffer.from('c0c1c2c3c4c5c6c7c8c9cacbcccdcecf', 'hex')), rp_id: 'github.com', rp_name: 'GitHub', user_handle: b64u(Buffer.from('user-1')), user_name: 'octo', user_display_name: 'Octo Cat',
    algorithm: -7, private_key: KEY1, counter: 7, discoverable: true, created_at: '2025-01-02T03:04:05.000Z',
  });
  assert.equal(p2.credential_id, b64u(Buffer.alloc(32, 9)));
  assert.equal(p2.discoverable, false);
  assert.equal(p2.user_handle, '');

  assert.equal(byName(r, 'Bare base32').login.totp, 'JBSW Y3DP EHPK 3PXP');
  assert.equal(byName(r, 'Steam').login.totp, 'steam://JBSWY3DPEHPK3PXP');
  assert.equal(byName(r, 'Steam').folderPath, 'Work');
  assert.equal(byName(r, 'Counter based').login.totp, 'otpauth://hotp/X?secret=JBSWY3DPEHPK3PXP&counter=1');

  const ed = byName(r, 'Ed25519 passkey');
  assert.equal(ed.login.passkeys, undefined);
  assert.equal(ed.fields.length, 1);
  assert.equal(ed.fields[0].hidden, true);
  assert.equal(ed.fields[0].bitwarden, 'login.fido2Credential');
  assert.equal(JSON.parse(ed.fields[0].value).keyCurve, 'Ed25519');

  const note = byName(r, 'Secure note');
  assert.equal(note.type, 'note');
  assert.equal(note.notes, 'secret note');
  assert.deepEqual(note.fields, [{ name: 'Hidden', value: 'h', hidden: true }]);

  const card = byName(r, 'Visa');
  assert.deepEqual(card.card, { cardholder: 'Jane Doe', brand: 'Visa', number: '4111111111111111', exp_month: '12', exp_year: '2030', code: '123' });
  assert.deepEqual(card.fields, [{ name: 'Card PIN', value: '(linked to Security code)', hidden: false, type: 'linked', linked_id: 303 }]);

  const me = byName(r, 'Me');
  assert.equal(me.identity.first_name, 'Jane');
  assert.equal(me.identity.passport, 'X0000000');
  assert.equal(me.identity.license, 'D000-0000');
  assert.deepEqual(me.fields[0], { name: 'Address 3', value: 'Building C', hidden: false, bitwarden: 'identity.address3' });
  assert.deepEqual(me.fields[1], { name: 'Nickname', value: 'JD', hidden: false });

  const ssh = byName(r, 'Server key');
  assert.equal(ssh.type, 'note');
  assert.equal(ssh.note_type, 'ssh_key');
  assert.equal(ssh.notes, 'deploy key');
  assert.deepEqual(ssh.fields.map((f) => [f.name, f.hidden, f.bitwarden]), [['Private key', true, 'sshKey.privateKey'], ['Public key', false, 'sshKey.publicKey'], ['Fingerprint', false, 'sshKey.keyFingerprint']]);
  assert.equal(ssh.fields[0].value, SSH_PRIVATE);

  const bank = byName(r, 'Checking');
  assert.equal(bank.note_type, 'bank_account');
  assert.equal(bank.fields.find((f) => f.bitwarden === 'bankAccount.accountNumber').hidden, true);
  assert.equal(bank.fields.find((f) => f.bitwarden === 'bankAccount.iban').value, 'XX00TEST0000000000');
  assert.ok(!bank.fields.some((f) => f.bitwarden === 'bankAccount.branchNumber'), 'empty values are not turned into fields');
  assert.equal(byName(r, 'Driving licence').note_type, 'drivers_license');
  assert.equal(byName(r, 'Passport').note_type, 'passport');
  assert.equal(byName(r, 'Passport').reprompt, true);
  assert.equal(byName(r, 'Old forum').archived_at, '2025-03-01T00:00:00.000Z');
  assert.equal(byName(r, 'unnamed.example').login.username, 'nameless');
  assert.equal(byName(r, 'Future type').type, 'note');
  assert.equal(byName(r, 'Future type').notes, 'kept');

  assert.deepEqual(
    { logins: r.stats.logins, withTotp: r.stats.withTotp, totpUnreadable: r.stats.totpUnreadable, withPasskeys: r.stats.withPasskeys, passkeys: r.stats.passkeys, cards: r.stats.cards, identities: r.stats.identities, notes: r.stats.notes, sshKeys: r.stats.sshKeys, bank: r.stats.bankAccounts, dl: r.stats.driversLicenses, passports: r.stats.passports, reprompt: r.stats.reprompt, archived: r.stats.archived },
    { logins: 7, withTotp: 4, totpUnreadable: 1, withPasskeys: 1, passkeys: 2, cards: 1, identities: 1, notes: 2, sshKeys: 1, bank: 1, dl: 1, passports: 1, reprompt: 2, archived: 1 },
  );
  const w = r.warnings.join('\n');
  for (const re of [/1 item\(s\) in Bitwarden’s trash were skipped/, /3 linked custom field/, /Ed25519 passkey.*unsupported key type/, /unknown Bitwarden item type 99/, /had no name/, /TOTP\) key\(s\) are not in a format.*Counter based/, /re-prompt/, /archived item/, /SSH key\(s\).*bank account\(s\).*driver's license\(s\).*passport\(s\)/]) {
    assert.match(w, re);
  }
});

test('Bitwarden trash can be imported on request (into “Bitwarden trash”)', async () => {
  const r = await parseImport(FULL, { includeTrash: true });
  assert.equal(r.items.length, 16);
  assert.equal(byName(r, 'Deleted').folderPath, 'Bitwarden trash/Work');
  assert.match(r.warnings.join('\n'), /imported into the folder “Bitwarden trash”/);
});

test('organization export: collections become folders', async () => {
  const doc = {
    encrypted: false,
    collections: [{ id: 'c1', organizationId: 'o1', name: 'Team/Infra', externalId: null }, { id: 'c2', organizationId: 'o1', name: 'Shared', externalId: null }],
    items: [
      login(1, 'Router', { username: 'admin', password: 'p' }, { organizationId: 'o1', collectionIds: ['c1'] }),
      login(2, 'Wiki', { username: 'w', password: 'p' }, { organizationId: 'o1', collectionIds: ['c2', 'c1'] }),
      login(3, 'Orphan', { username: 'o', password: 'p' }, { organizationId: 'o1', collectionIds: [] }),
    ],
  };
  const r = await parseImport(Buffer.from(JSON.stringify(doc)));
  assert.equal(byName(r, 'Router').folderPath, 'Team/Infra');
  assert.equal(byName(r, 'Wiki').folderPath, 'Shared');
  assert.equal(byName(r, 'Orphan').folderPath, '');
  assert.match(r.warnings.join('\n'), /1 item\(s\) belong to several collections/);
  assert.match(r.warnings.join('\n'), /1 organization item\(s\) have no collection/);
});

// ------------------------------------------------------------------------------------------- round trips
test('import → export → import keeps everything (JSON, password-protected PBKDF2 and Argon2id)', async () => {
  const data = await parseImport(FULL);
  for (const [format, kdf] of [['bitwarden-json'], ['bitwarden-json-protected', 'pbkdf2'], ['bitwarden-json-protected', 'argon2id']]) {
    const { out, warnings } = await exportVaultFile(format, data, { password: 'file päss ✓', kdf });
    assert.deepEqual(warnings, []);
    const buf = Buffer.from(out);
    const info = inspectImport(buf);
    assert.equal(info.needsPassword, format !== 'bitwarden-json');
    if (kdf) {
      const j = JSON.parse(out);
      assert.equal(j.kdfType, kdf === 'argon2id' ? 1 : 0);
      assert.equal(j.kdfIterations, kdf === 'argon2id' ? 3 : 600000);
      if (kdf === 'argon2id') assert.deepEqual([j.kdfMemory, j.kdfParallelism], [64, 4]);
    }
    const back = await parseImport(buf, { password: 'file päss ✓' });
    assert.deepEqual(strip(back.items), strip(data.items), `${format} ${kdf || ''} round trip`);
    assert.deepEqual(back.folders.map((f) => f.name).sort(), data.folders.map((f) => f.name).sort());
  }
});

test('the exported Bitwarden JSON has Bitwarden’s shape (types, field types, passkeys, SSH key, identity)', async () => {
  const data = await parseImport(FULL);
  const j = JSON.parse(await serializeExport('bitwarden-json', data));
  assert.equal(j.encrypted, false);
  const it = (n) => j.items.find((x) => x.name === n);
  const gh = it('GitHub');
  assert.equal(gh.type, 1);
  assert.equal(gh.reprompt, 1);
  assert.equal(gh.favorite, true);
  assert.equal(j.folders.find((f) => f.id === gh.folderId).name, 'Work/Email');
  assert.deepEqual(gh.fields, [
    { name: 'Text', value: 'plain', type: 0, linkedId: null },
    { name: 'PIN', value: '1234', type: 1, linkedId: null },
    { name: '2FA enabled', value: 'true', type: 2, linkedId: null },
    { name: 'Login name', value: null, type: 3, linkedId: 100 },
    { name: 'Secret', value: null, type: 3, linkedId: 101 },
  ]);
  assert.deepEqual(gh.login.uris.map((u) => u.match), [null, 0, 1, 2, 3, 4, 5, null]);
  assert.equal(gh.login.fido2Credentials[0].credentialId, 'c0c1c2c3-c4c5-c6c7-c8c9-cacbcccdcecf');
  assert.equal(gh.login.fido2Credentials[0].counter, '7');
  assert.equal(gh.login.fido2Credentials[0].keyValue, KEY1);
  assert.equal(gh.login.fido2Credentials[1].credentialId, `b64.${b64u(Buffer.alloc(32, 9))}`);
  assert.equal(gh.login.fido2Credentials[1].discoverable, 'false');
  assert.deepEqual(gh.passwordHistory, [{ lastUsedDate: '2024-05-01T00:00:00.000Z', password: 'old-2' }, { lastUsedDate: '2024-01-01T00:00:00.000Z', password: 'old-1' }]);
  assert.equal(it('Ed25519 passkey').login.fido2Credentials[0].keyCurve, 'Ed25519', 'unusable passkey goes back unchanged');
  assert.equal(it('Ed25519 passkey').fields, undefined);
  assert.equal(it('Me').type, 4);
  assert.equal(it('Me').identity.address3, 'Building C');
  assert.deepEqual(it('Me').fields, [{ name: 'Nickname', value: 'JD', type: 0, linkedId: null }]);
  assert.deepEqual(it('Server key').sshKey, { privateKey: SSH_PRIVATE, publicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample me@host', keyFingerprint: 'SHA256:4mGn7d2xExampleFingerprint' });
  assert.equal(it('Server key').type, 5);
  assert.equal(it('Server key').fields, undefined);
  assert.equal(it('Checking').type, 6);
  assert.equal(it('Checking').bankAccount.accountNumber, '000123456789');
  assert.equal(it('Checking').bankAccount.branchNumber, null);
  assert.equal(it('Driving licence').type, 7);
  assert.equal(it('Passport').type, 8);
  assert.equal(it('Passport').passport.passportNumber, 'X0000000');
  assert.equal(it('Old forum').archivedDate, '2025-03-01T00:00:00.000Z');
  assert.equal(it('Secure note').type, 2);
  assert.deepEqual(it('Secure note').secureNote, { type: 0 });
  assert.equal(it('Visa').card.number, '4111111111111111');
  assert.ok(j.items.every((x) => /^[0-9a-f-]{36}$/.test(x.id) && x.organizationId === null && x.collectionIds === null && x.deletedDate === null));
});

test('an SSH key whose private key field was removed exports as a plain secure note (Bitwarden refuses empty keys)', async () => {
  const data = await parseImport(FULL);
  const ssh = byName(data, 'Server key');
  ssh.fields = ssh.fields.filter((f) => f.bitwarden !== 'sshKey.privateKey');
  const j = JSON.parse(await serializeExport('bitwarden-json', { folders: [], items: [ssh] }));
  assert.equal(j.items[0].type, 2);
  assert.deepEqual(j.items[0].fields.map((f) => f.name), ['Public key', 'Fingerprint']);
});

// ---------------------------------------------------------------------------------------- encrypted files
test('independently encrypted exports (PBKDF2, Argon2id) decrypt to the same items; wrong/missing password', async () => {
  const plain = await parseImport(FULL);
  for (const kdf of [{ kdfType: 0, kdfIterations: 5000 }, { kdfType: 1, kdfIterations: 2, kdfMemory: 16, kdfParallelism: 2 }]) {
    const buf = Buffer.from(await independentProtect(FULL.toString('utf8'), 'pässwörd ✓', kdf));
    assert.equal(inspectImport(buf).needsPassword, true);
    const r = await parseImport(buf, { password: 'pässwörd ✓' });
    assert.deepEqual(strip(r.items), strip(plain.items));
    await assert.rejects(parseImport(buf, { password: 'wrong' }), code('bad_password'));
    await assert.rejects(parseImport(buf), code('password_required'));
  }
});

test('account-restricted exports are recognised and explained; hostile KDF settings and EncString types are refused', async () => {
  const acct = Buffer.from(JSON.stringify({ encrypted: true, encKeyValidation_DO_NOT_EDIT: '2.AAAAAAAAAAAAAAAAAAAAAA==|AAAAAAAAAAAAAAAAAAAAAA==|AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=', folders: [{ id: 'f', name: '2.x|y|z' }], items: [{ id: 'i', type: 1, name: '2.x|y|z', data: '2.x|y|z' }] }));
  const info = inspectImport(acct);
  assert.equal(info.accountRestricted, true);
  assert.equal(info.needsPassword, false);
  assert.match(info.error, /account-restricted.*Password-protected/s);
  await assert.rejects(parseImport(acct, { password: 'x' }), code('account_restricted'));

  const base = JSON.parse(await independentProtect('{"encrypted":false,"items":[]}', 'pw', { kdfType: 0, kdfIterations: 5000 }));
  const t0 = Date.now();
  await assert.rejects(parseImport(Buffer.from(JSON.stringify({ ...base, kdfType: 1, kdfIterations: 3, kdfMemory: 999999, kdfParallelism: 4 })), { password: 'pw' }), code('unsupported_kdf'));
  await assert.rejects(parseImport(Buffer.from(JSON.stringify({ ...base, kdfIterations: 100 })), { password: 'pw' }), code('unsupported_kdf'));
  await assert.rejects(parseImport(Buffer.from(JSON.stringify({ ...base, kdfType: 7 })), { password: 'pw' }), code('unsupported_kdf'));
  assert.ok(Date.now() - t0 < 2000, 'refused before deriving keys');
  assert.match(inspectImport(Buffer.from(JSON.stringify({ ...base, kdfType: 1, kdfIterations: 3, kdfMemory: 999999, kdfParallelism: 4 }))).error, /Argon2id settings outside/);
  await assert.rejects(parseImport(Buffer.from(JSON.stringify({ ...base, data: `0.${base.data.slice(2).split('|').slice(0, 2).join('|')}` })), { password: 'pw' }), code('unsupported'));
  // right password, tampered data → authentication failure, not garbage
  const [iv, ct, mac] = base.data.slice(2).split('|');
  const bad = Buffer.from(ct, 'base64');
  bad[0] ^= 1;
  await assert.rejects(parseImport(Buffer.from(JSON.stringify({ ...base, data: `2.${iv}|${bad.toString('base64')}|${mac}` })), { password: 'pw' }), code('decrypt_failed'));
});

test('Argon2id runs off the main thread (the event loop keeps ticking while a 64 MiB derivation runs)', async () => {
  // Bitwarden's default Argon2id cost: 3 iterations, 64 MiB, 4 lanes.
  const buf = Buffer.from(await independentProtect(FULL.toString('utf8'), 'a', { kdfType: 1, kdfIterations: 3, kdfMemory: 64, kdfParallelism: 4 }));
  let maxGap = 0;
  let last = Date.now();
  const timer = setInterval(() => {
    const now = Date.now();
    maxGap = Math.max(maxGap, now - last);
    last = now;
  }, 10);
  const t0 = Date.now();
  try {
    await parseImport(buf, { password: 'a' });
  } finally {
    clearInterval(timer);
  }
  const took = Date.now() - t0;
  assert.ok(maxGap < Math.max(150, took / 3), `event loop blocked for ${maxGap} ms during a ${took} ms derivation`);
});

// ------------------------------------------------------------------------------------------------- ZIP
test('ZIP export with attachments: data.json is imported, attachments are matched to items and can be saved', async () => {
  const shot = randomBytes(5000); // incompressible → stored entry
  const receipt = Buffer.from('%PDF-1.4 synthetic receipt '.repeat(50)); // deflated entry
  const zip = createZip([
    { name: 'data.json', data: FULL },
    { name: `attachments/${ID(1)}/screen shot.png`, data: shot }, // older clients: folder = item id
    { name: 'attachments/Visa/receipt.pdf', data: receipt }, // newer clients: folder = sanitised item name
    { name: 'attachments/Server key/id_ed25519.pub', data: Buffer.from('ssh-ed25519 AAAA me@host\n') },
  ]);
  assert.equal(detectFormat(zip), 'bitwarden-zip');
  const info = inspectImport(zip);
  assert.equal(info.attachments, 3);
  assert.equal(info.needsPassword, false);
  const r = await parseImport(zip);
  assert.equal(r.items.length, 15);
  assert.deepEqual(r.attachments.map((a) => [a.item, a.file, a.size, a.matched]).sort(), [['GitHub', 'screen shot.png', 5000, true], ['Server key', 'id_ed25519.pub', 25, true], ['Visa', 'receipt.pdf', receipt.length, true]].sort());
  assert.match(r.warnings.join('\n'), /3 file attachment\(s\) cannot be stored/);

  const p = { buf: zip, format: 'bitwarden-zip', opened: null };
  await preview(fakeBrowser(new FakeVault()).b, p, {});
  const dir = mkdtempSync(path.join(os.tmpdir(), 'lw-att-'));
  try {
    const res = writeAttachments(p, dir);
    assert.equal(res.saved, 3);
    assert.deepEqual(readdirSync(dir).sort(), ['GitHub', 'Server key', 'Visa']);
    assert.ok(readFileSync(path.join(dir, 'GitHub', 'screen shot.png')).equals(shot));
    assert.ok(readFileSync(path.join(dir, 'Visa', 'receipt.pdf')).equals(receipt));
    writeAttachments(p, dir); // never overwrites
    assert.deepEqual(readdirSync(path.join(dir, 'Visa')).sort(), ['receipt (2).pdf', 'receipt.pdf']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  // a ZIP whose data.json is password-protected, and a damaged ZIP
  const pz = createZip([{ name: 'data.json', data: Buffer.from(await independentProtect(FULL.toString('utf8'), 'zip-pw', { kdfType: 0, kdfIterations: 5000 })) }]);
  assert.equal(inspectImport(pz).needsPassword, true);
  assert.equal((await parseImport(pz, { password: 'zip-pw' })).items.length, 15);
  const broken = Buffer.from(zip);
  broken[zip.indexOf(Buffer.from('data.json')) + 9 + 20] ^= 0xff; // inside data.json's compressed bytes
  await assert.rejects(parseImport(broken), /damaged|checksum|not valid JSON/);
  await assert.rejects(parseImport(createZip([{ name: 'other.txt', data: Buffer.from('x') }])), /no data\.json/);
});

// ------------------------------------------------------------------------------------------------- CSV
test('Bitwarden CSV (individual and organization) and CSV export', async () => {
  const csv = [
    'folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp',
    'Work,1,login,GitHub,"line1\nline2","PIN: 1234\nRegion: eu: west",1,"https://github.com/login,https://gist.github.com",octo,"p,a""ss",JBSWY3DPEHPK3PXP',
    ',,note,Note,secret,,0,,,,',
  ].join('\n');
  assert.equal(detectFormat(Buffer.from(csv)), 'bitwarden-csv');
  const r = await parseImport(Buffer.from(csv));
  const gh = byName(r, 'GitHub');
  assert.equal(gh.folderPath, 'Work');
  assert.equal(gh.favorite, true);
  assert.equal(gh.reprompt, true);
  assert.equal(gh.notes, 'line1\nline2');
  assert.deepEqual(gh.fields, [{ name: 'PIN', value: '1234', hidden: false }, { name: 'Region: eu', value: 'west', hidden: false }]);
  assert.deepEqual(gh.login.uris.map((u) => u.uri), ['https://github.com/login', 'https://gist.github.com']);
  assert.equal(gh.login.password, 'p,a"ss');
  assert.equal(gh.login.totp, 'JBSWY3DPEHPK3PXP');
  assert.equal(byName(r, 'Note').type, 'note');

  const org = 'collections,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp\n"Team A,Team B",login,Router,,,0,https://192.168.1.1,admin,pw,\n';
  assert.equal(detectFormat(Buffer.from(org)), 'bitwarden-csv');
  const o = await parseImport(Buffer.from(org));
  assert.equal(o.items[0].folderPath, 'Team A');
  assert.match(o.warnings.join('\n'), /several collections/);

  // CSV export: everything that CSV can express (other types as notes with their values as fields)
  const data = await parseImport(FULL);
  const { out, warnings } = await exportVaultFile('bitwarden-csv', data);
  assert.match(warnings.join('\n'), /3 passkey\(s\) are not included/); // 2 usable + 1 kept for Bitwarden
  const back = await parseImport(Buffer.from(out));
  assert.equal(back.items.length, data.items.length);
  assert.equal(byName(back, 'GitHub').login.totp, byName(data, 'GitHub').login.totp);
  assert.equal(byName(back, 'GitHub').reprompt, true);
  assert.equal(byName(back, 'GitHub').folderPath, 'Work/Email');
  assert.ok(byName(back, 'Server key').fields.some((f) => f.name === 'Public key' && f.value.startsWith('ssh-ed25519')));
  assert.ok(byName(back, 'Visa').fields.some((f) => f.name === 'Number' && f.value === '4111111111111111'));
  assert.ok(byName(back, 'GitHub').fields.some((f) => f.name === 'Secret' && f.value === '(linked to Password)'));
});

// ------------------------------------------------------------------------------------------- duplicates
const asExisting = (items) => items.map(({ folderPath, ...data }, i) => (void folderPath, { id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, revision: 1, data }));

test('duplicates: skip exact duplicates, keep both, merge by website + username', async () => {
  const data = await parseImport(FULL);
  const existing = asExisting(data.items);
  assert.equal(planImport(data.items, existing, 'skip').create.length, 0);
  assert.equal(planImport(data.items, existing, 'skip').skipped.length, 15);
  assert.equal(planImport(data.items, existing, 'keep').create.length, 15);
  assert.equal(planImport(data.items, [], 'merge').create.length, 15);
  // favourite / folder / dates differences are not content differences
  const moved = data.items.map((it) => ({ ...it, folderPath: 'Elsewhere', favorite: !it.favorite, updated_at: '2026-01-01T00:00:00.000Z' }));
  assert.equal(planImport(moved, existing, 'skip').create.length, 0);

  // a newer Bitwarden copy of GitHub: new password, extra website, a third passkey, different TOTP, new field
  const gh = JSON.parse(JSON.stringify(byName(data, 'GitHub')));
  const newer = { ...gh, name: 'GitHub (new)', updated_at: '2026-01-01T00:00:00.000Z', fields: [...gh.fields, { name: 'Recovery', value: 'r-1', hidden: true }], login: { ...gh.login, password: 'pw-2', totp: 'JBSWY3DPEHPK3PXQ', uris: [...gh.login.uris, { uri: 'https://github.blog' }], passkeys: [...gh.login.passkeys, { ...gh.login.passkeys[0], credential_id: b64u(Buffer.alloc(16, 3)) }] } };
  const other = { folderPath: '', type: 'login', name: 'Other', favorite: false, notes: '', fields: [], password_history: [], login: { username: 'someone', password: 'x', uris: [{ uri: 'https://github.com' }] } };
  const plan = planImport([newer, other], existing, 'merge');
  assert.equal(plan.merge.length, 1);
  assert.equal(plan.create.length, 1, 'other username → created');
  const m = plan.merge[0];
  assert.equal(m.id, existing.find((e) => e.data.name === 'GitHub').id);
  assert.equal(m.data.name, 'GitHub', 'existing name kept');
  assert.equal(m.data.login.password, 'pw-2', 'newer password wins (VaultStore.save moves the old one into the history)');
  assert.equal(m.data.login.totp, gh.login.totp, 'existing TOTP kept');
  assert.ok(m.data.fields.some((f) => f.name === 'Authenticator key (imported)' && f.value === 'JBSWY3DPEHPK3PXQ' && f.hidden));
  assert.ok(m.data.fields.some((f) => f.name === 'Recovery'));
  assert.equal(m.data.login.passkeys.length, 3);
  assert.ok(m.data.login.uris.some((u) => u.uri === 'https://github.blog'));
  assert.equal(m.data.login.uris.length, gh.login.uris.length + 1);

  // an older copy with a different password: the vault's password stays, the imported one goes to the history
  const older = { ...gh, updated_at: '2020-01-01T00:00:00.000Z', login: { ...gh.login, password: 'ancient' } };
  const r2 = mergeLogin(existing.find((e) => e.data.name === 'GitHub').data, older);
  assert.equal(r2.changed, true);
  assert.equal(r2.data.login.password, gh.login.password);
  assert.deepEqual(r2.data.password_history.map((h) => h.password), ['old-2', 'old-1', 'ancient']);
  // nothing new → reported as skipped, not merged
  const same = planImport([{ ...gh, name: 'GitHub copy' }], existing, 'merge');
  assert.equal(same.merge.length, 0);
  assert.equal(same.skipped.length, 1);
  assert.notEqual(contentKey(gh), contentKey({ ...gh, name: 'GitHub copy' }));
});

// ------------------------------------------------------------------------------------- the import run
/** In-memory vault with VaultStore's interface that really seals items (vault-crypto) and opens them again. */
class FakeVault {
  constructor() {
    this.items = new Map(); // id → {vi, sealed}
    this.folders = new Map(); // id → name
    this.key = null;
    this.calls = [];
  }
  async ready() {
    if (!this.key) this.key = await vc.importAesKey(new Uint8Array(randomBytes(32)));
  }
  async list() {
    await this.ready();
    const items = new Map();
    for (const [id, x] of this.items) items.set(id, { vi: x.vi, data: await vc.decryptItem(this.key, id, x.vi.data), error: null, stale: null });
    return { items, folders: new Map(this.folders) };
  }
  async createFolder(acc, name, opts) {
    this.calls.push(['createFolder', name, opts]);
    const id = randomUUID();
    this.folders.set(id, name);
    return id;
  }
  async sync() {
    this.calls.push(['sync']);
  }
  async importBatch(acc, entries, { onProgress } = {}) {
    await this.ready();
    let created = 0;
    for (let i = 0; i < entries.length; i += 500) {
      for (const e of entries.slice(i, i + 500)) {
        const id = randomUUID();
        const obj = { ...e.data, seq: 1, folder_id: e.folderId || null };
        this.items.set(id, { vi: { id, folder_id: e.folderId || null, revision: 1, data: await vc.encryptItem(this.key, id, obj), updated_at: obj.updated_at } });
        created++;
      }
      if (onProgress) onProgress(Math.min(i + 500, entries.length), entries.length);
    }
    this.calls.push(['importBatch', entries.length]);
    return { created, errors: [] };
  }
  async save(acc, { id, data, baseRevision }) {
    const cur = this.items.get(id);
    assert.equal(baseRevision, cur.vi.revision);
    this.items.set(id, { vi: { ...cur.vi, revision: cur.vi.revision + 1, data: await vc.encryptItem(this.key, id, { ...data, seq: 2 }) } });
    this.calls.push(['save', id]);
    return { id, revision: cur.vi.revision + 1 };
  }
}

function fakeBrowser(vault) {
  let refreshed = 0;
  const b = { account: { phase: () => 'unlocked', acc: {}, vault }, autofill: { refreshAll: () => refreshed++ } };
  return { b, refreshed: () => refreshed };
}

test('import run: preview, folders (no sync per folder), batch upload with progress, re-import skips, merge', async () => {
  const vault = new FakeVault();
  const { b, refreshed } = fakeBrowser(vault);
  const p = { buf: FULL, format: detectFormat(FULL), opened: null };
  const pv = await preview(b, p, {});
  assert.equal(p.buf, null, 'plaintext file dropped once decoded');
  assert.equal(pv.stats.total, 15);
  assert.equal(pv.trash, 1);
  assert.deepEqual(pv.duplicates, { exact: 0, mergeTargets: 0, mergeItems: 0, mergeNothingNew: 0 });
  const seen = new Set();
  const poll = setInterval(() => p.progress && seen.add(p.progress.phase), 0).unref();
  const r = await commit(b, p, { duplicates: 'skip', folder: 'From Bitwarden' });
  clearInterval(poll);
  assert.equal(r.created, 15);
  assert.equal(r.failedCount, 0);
  assert.equal(p.progress.phase, 'done');
  assert.equal(refreshed(), 1);
  assert.deepEqual([...vault.folders.values()].sort(), ['From Bitwarden', 'From Bitwarden/Empty folder', 'From Bitwarden/Work', 'From Bitwarden/Work/Email']);
  assert.ok(vault.calls.filter((c) => c[0] === 'createFolder').every((c) => c[2] && c[2].sync === false));
  // what landed in the vault (sealed and opened again) is the full item, incl. passkeys and extras
  const { items, folders } = await vault.list();
  const stored = [...items.values()].map((e) => ({ ...e.data, folder: folders.get(e.vi.folder_id) }));
  const gh = stored.find((x) => x.name === 'GitHub');
  assert.equal(gh.folder, 'From Bitwarden/Work/Email');
  assert.equal(gh.login.passkeys.length, 2);
  assert.equal(gh.reprompt, true);
  assert.equal(stored.find((x) => x.name === 'Server key').note_type, 'ssh_key');
  assert.equal(stored.find((x) => x.name === 'Visa').folder, 'From Bitwarden');

  // exporting the vault gives the same items back (ids = vault ids)
  const exp = await vaultData(b.account);
  assert.ok(exp.items.every((it) => items.has(it.id)));
  const back = await parseImport(Buffer.from(await serializeExport('bitwarden-json', exp)));
  const orig = await parseImport(FULL);
  const norm = (list) => strip(list).map(({ folderPath, ...x }) => (void folderPath, x)).sort((a, c) => a.name.localeCompare(c.name));
  assert.deepEqual(norm(back.items), norm(orig.items));

  // importing the same file again adds nothing
  const p2 = { buf: FULL, format: 'bitwarden-json', opened: null };
  assert.equal((await preview(b, p2, {})).duplicates.exact, 15);
  const r2 = await commit(b, p2, { duplicates: 'skip' });
  assert.deepEqual([r2.created, r2.skipped, r2.merged], [0, 15, 0]);

  // a newer export with a changed password → merged into the existing login
  const doc = fullExport();
  doc.items[0].login.password = 'pw-NEW';
  doc.items[0].revisionDate = '2026-05-05T00:00:00.000Z';
  const p3 = { buf: Buffer.from(JSON.stringify(doc)), format: 'bitwarden-json', opened: null };
  const pv3 = await preview(b, p3, {});
  assert.deepEqual([pv3.duplicates.exact, pv3.duplicates.mergeItems], [14, 1]);
  const r3 = await commit(b, p3, { duplicates: 'merge' });
  assert.deepEqual([r3.created, r3.merged, r3.skipped], [0, 1, 14]);
  const after = [...(await vault.list()).items.values()].find((e) => e.data.name === 'GitHub');
  assert.equal(after.data.login.password, 'pw-NEW');
  assert.equal(after.vi.revision, 2);
});

test('import run reports items the vault would reject (e.g. too large) by name and imports the rest', async () => {
  const doc = { encrypted: false, folders: [], items: [login(1, 'Huge', { username: 'u', password: 'p' }, { notes: 'x'.repeat(200 * 1024) }), login(2, 'Fine', { username: 'u', password: 'p' })] };
  const vault = new FakeVault();
  const p = { buf: Buffer.from(JSON.stringify(doc)), format: 'bitwarden-json', opened: null };
  await preview(fakeBrowser(vault).b, p, {});
  const r = await commit(fakeBrowser(vault).b, p, {});
  assert.equal(r.created, 1);
  assert.deepEqual(r.failed, [{ name: 'Huge', error: 'Item is too large' }]);
});

test('a 5 000-item vault is mapped, planned and imported in chunks without long stalls', async () => {
  const items = [];
  for (let i = 0; i < 5000; i++) {
    items.push(login(i + 1, `Site ${i}`, { username: `user${i}@example.test`, password: `pw-${i}`, totp: i % 10 ? null : 'JBSWY3DPEHPK3PXP', uris: [{ match: null, uri: `https://site${i}.example/login` }] }, { folderId: `f${i % 20}`, fields: [{ name: 'n', value: String(i), type: 0, linkedId: null }] }));
  }
  const doc = { encrypted: false, folders: Array.from({ length: 20 }, (_, i) => ({ id: `f${i}`, name: `Folder ${i}` })), items };
  const buf = Buffer.from(JSON.stringify(doc));
  const vault = new FakeVault();
  const { b } = fakeBrowser(vault);
  const p = { buf, format: 'bitwarden-json', opened: null };
  let t = Date.now();
  const pv = await preview(b, p, {});
  assert.equal(pv.stats.logins, 5000);
  assert.ok(Date.now() - t < 5000, `preview took ${Date.now() - t} ms`);
  const progress = [];
  const poll = setInterval(() => p.progress && progress.push(`${p.progress.phase}:${p.progress.done}`), 1).unref();
  t = Date.now();
  const r = await commit(b, p, { duplicates: 'skip' });
  clearInterval(poll);
  assert.equal(r.created, 5000);
  assert.ok(progress.some((x) => x.startsWith('items:') && x !== 'items:0' && x !== 'items:5000'), `progress was reported while uploading: ${[...new Set(progress)].slice(0, 20)}`);
  // the second import of a 5 000-item vault against 5 000 existing items stays fast (indexed duplicate check)
  t = Date.now();
  const p2 = { buf, format: 'bitwarden-json', opened: null };
  assert.equal((await preview(b, p2, {})).duplicates.exact, 5000);
  assert.ok(Date.now() - t < 10000, `duplicate preview took ${Date.now() - t} ms`);
});
