// Full-fidelity Bitwarden ⇄ Ludworks vault mapping (import and export) for Ludworks Browser.
//
// Inputs: unencrypted JSON (individual "folders" and organization "collections" exports), password-protected
// JSON (bw-crypto.js), the ".zip" export (data.json + attachments/<item>/<file>), and CSV (individual and
// organization). Account-restricted encrypted exports are detected and explained (they cannot be decrypted
// without the Bitwarden account key).
//
// Output is the vault interchange shape of VAULT-CRYPTO.md §8.4 ({folders, items:[{folderPath, ...§3 item}],
// warnings}). Everything Bitwarden has that the §3 schema has no slot for is kept, visible where it matters,
// as item keys that every Ludworks client preserves on edit (§3 unknown-key rule) and that export back:
//
//   login.passkeys[]           Bitwarden login.fido2Credentials (credential id, PKCS#8 key, rp, user, counter…)
//   login.totp                 as stored (otpauth://, bare base32, steam://)
//   fields[]: {name, value, hidden, type?: 'boolean'|'linked', linked_id?: number, bitwarden?: '<obj>.<key>'}
//              text → hidden:false, hidden → hidden:true, boolean → type 'boolean' ("true"/"false"),
//              linked → type 'linked' + Bitwarden linked_id, value "(linked to <property>)" for other clients
//   reprompt: true             Bitwarden "master password re-prompt" (Ludworks does not re-prompt; kept for export)
//   archived_at                Bitwarden archive date (the item is imported as a normal item)
//   note_type                  'ssh_key' | 'bank_account' | 'drivers_license' | 'passport': Bitwarden item types
//                              5–8 imported as secure notes whose values are custom fields (secrets hidden), each
//                              tagged with `bitwarden: '<object>.<key>'` so export rebuilds the Bitwarden item
//   identity address 3         custom field "Address 3" tagged `bitwarden: 'identity.address3'`
//   unreadable passkeys        hidden custom field "Passkey (not usable here)" with the Bitwarden JSON, tagged
//                              `bitwarden: 'login.fido2Credential'` (exported back unchanged)
// Folders: Bitwarden folders (nested "A/B" names) → folder paths; organization collections → folder paths
// (first collection; further ones are reported). Items in Bitwarden's trash are skipped unless asked for.

import { randomUUID } from 'node:crypto';
import { parseCsv, toCsv } from '../../vendor/vault/bitwarden.js';
import { normalizeFolderPath } from '../../vendor/vault/convert.js';
import { parseTotpInput } from '../../lib/totp.js';
import { validPasskeyKey } from '../passkeys.js';
import { readZip, isZip } from './zip.js';
import { bwError, encryptionOf, checkKdf, decryptPasswordProtected, encryptPasswordProtected, ACCOUNT_RESTRICTED_MESSAGE } from './bw-crypto.js';

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const b64u = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64u = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
const str = (v) => (v === null || v === undefined ? '' : String(v));
const nowIso = () => new Date().toISOString();
const isoOr = (v, fallback) => (typeof v === 'string' && v && Number.isFinite(Date.parse(v)) ? v : fallback);

export const BW_MATCH = ['domain', 'host', 'starts_with', 'exact', 'regex', 'never'];
const CARD_BW = [['cardholder', 'cardholderName'], ['brand', 'brand'], ['number', 'number'], ['exp_month', 'expMonth'], ['exp_year', 'expYear'], ['code', 'code']];
const IDENTITY_BW = [
  ['title', 'title'], ['first_name', 'firstName'], ['middle_name', 'middleName'], ['last_name', 'lastName'], ['company', 'company'],
  ['email', 'email'], ['phone', 'phone'], ['address1', 'address1'], ['address2', 'address2'], ['city', 'city'], ['state', 'state'],
  ['postal_code', 'postalCode'], ['country', 'country'], ['username', 'username'], ['ssn', 'ssn'], ['passport', 'passportNumber'],
  ['license', 'licenseNumber'],
];
const IDENTITY_ORDER = ['title', 'firstName', 'middleName', 'lastName', 'address1', 'address2', 'address3', 'city', 'state', 'postalCode', 'country', 'company', 'email', 'phone', 'ssn', 'username', 'passportNumber', 'licenseNumber'];
/** Bitwarden linked-field ids (LinkedIdType) → property names shown to the user. */
export const LINKED_IDS = {
  100: 'Username', 101: 'Password',
  300: 'Cardholder name', 301: 'Expiration month', 302: 'Expiration year', 303: 'Security code', 304: 'Brand', 305: 'Number',
  400: 'Title', 401: 'Middle name', 402: 'Address 1', 403: 'Address 2', 404: 'Address 3', 405: 'City', 406: 'State', 407: 'Postal code',
  408: 'Country', 409: 'Company', 410: 'Email', 411: 'Phone', 412: 'SSN', 413: 'Username', 414: 'Passport number', 415: 'License number',
  416: 'First name', 417: 'Last name', 418: 'Full name',
};
/** Bitwarden item types without a Ludworks equivalent: imported as notes with tagged fields. [key, label, secret] */
export const NOTE_TYPES = {
  5: { prop: 'sshKey', kind: 'ssh_key', label: 'SSH key', keys: [['privateKey', 'Private key', true], ['publicKey', 'Public key'], ['keyFingerprint', 'Fingerprint']] },
  6: {
    prop: 'bankAccount', kind: 'bank_account', label: 'bank account',
    keys: [['bankName', 'Bank name'], ['nameOnAccount', 'Name on account'], ['accountType', 'Account type'], ['accountNumber', 'Account number', true], ['routingNumber', 'Routing number'], ['branchNumber', 'Branch number'], ['pin', 'PIN', true], ['swiftCode', 'SWIFT / BIC'], ['iban', 'IBAN', true], ['bankContactPhone', 'Bank contact phone']],
  },
  7: {
    prop: 'driversLicense', kind: 'drivers_license', label: "driver's license",
    keys: [['firstName', 'First name'], ['middleName', 'Middle name'], ['lastName', 'Last name'], ['dateOfBirth', 'Date of birth'], ['licenseNumber', 'License number', true], ['issuingCountry', 'Issuing country'], ['issuingState', 'Issuing state'], ['issueDate', 'Issue date'], ['expirationDate', 'Expiration date'], ['issuingAuthority', 'Issuing authority'], ['licenseClass', 'License class']],
  },
  8: {
    prop: 'passport', kind: 'passport', label: 'passport',
    keys: [['surname', 'Surname'], ['givenName', 'Given name'], ['dateOfBirth', 'Date of birth'], ['sex', 'Sex'], ['birthPlace', 'Place of birth'], ['nationality', 'Nationality'], ['issuingCountry', 'Issuing country'], ['passportNumber', 'Passport number', true], ['passportType', 'Passport type'], ['nationalIdentificationNumber', 'National ID number', true], ['issuingAuthority', 'Issuing authority'], ['issueDate', 'Issue date'], ['expirationDate', 'Expiration date']],
  },
};
const NOTE_KIND_TO_TYPE = Object.fromEntries(Object.entries(NOTE_TYPES).map(([t, d]) => [d.kind, Number(t)]));
const UNUSABLE_PASSKEY = 'Passkey (not usable here)';
export const ADDRESS3_LABEL = 'Address 3';

// ---------------------------------------------------------------------------------------------- passkeys
/** Bitwarden credentialId (GUID or "b64."+base64url) → raw credential id as base64url. */
export function bwCredentialIdToRaw(id) {
  const s = String(id || '');
  if (s.startsWith('b64.')) {
    const raw = fromB64u(s.slice(4));
    return raw.length ? b64u(raw) : null;
  }
  if (GUID_RE.test(s)) return b64u(Buffer.from(s.replace(/-/g, ''), 'hex'));
  return null;
}

/** Raw credential id (base64url) → Bitwarden credentialId: GUID form for 16 bytes, else "b64.". */
export function rawToBwCredentialId(b64url) {
  const raw = fromB64u(b64url);
  if (raw.length === 16) {
    const h = raw.toString('hex');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }
  return `b64.${b64u(raw)}`;
}

/** Bitwarden fido2Credential → Ludworks passkey, or null (with a reason) when it cannot be used. */
export function bwToPasskey(c) {
  if (!c || typeof c !== 'object') return { passkey: null, reason: 'it is empty' };
  if ((c.keyType && c.keyType !== 'public-key') || (c.keyAlgorithm && c.keyAlgorithm !== 'ECDSA') || (c.keyCurve && c.keyCurve !== 'P-256')) {
    return { passkey: null, reason: `it uses an unsupported key type (${[c.keyAlgorithm, c.keyCurve].filter(Boolean).join(' ') || c.keyType})` };
  }
  const id = bwCredentialIdToRaw(c.credentialId);
  if (!id) return { passkey: null, reason: 'its credential id is not readable' };
  if (typeof c.keyValue !== 'string' || !validPasskeyKey(c.keyValue)) return { passkey: null, reason: 'its private key is not a P-256 PKCS#8 key' };
  if (typeof c.rpId !== 'string' || !c.rpId) return { passkey: null, reason: 'it has no relying party (rpId)' };
  const counter = parseInt(String(c.counter ?? '0'), 10);
  return {
    passkey: {
      credential_id: id,
      rp_id: String(c.rpId).toLowerCase(),
      rp_name: str(c.rpName || c.rpId),
      user_handle: c.userHandle ? b64u(fromB64u(String(c.userHandle))) : '',
      user_name: str(c.userName),
      user_display_name: str(c.userDisplayName),
      algorithm: -7,
      private_key: b64u(fromB64u(c.keyValue)),
      counter: Number.isSafeInteger(counter) && counter >= 0 ? counter : 0,
      discoverable: String(c.discoverable) !== 'false',
      created_at: isoOr(c.creationDate instanceof Date ? c.creationDate.toISOString() : c.creationDate, nowIso()),
    },
    reason: null,
  };
}

/** Ludworks passkey → Bitwarden fido2Credential. */
export function passkeyToBw(p) {
  return {
    credentialId: rawToBwCredentialId(p.credential_id),
    keyType: 'public-key',
    keyAlgorithm: 'ECDSA',
    keyCurve: 'P-256',
    keyValue: p.private_key,
    rpId: p.rp_id,
    userHandle: p.user_handle || null,
    userName: p.user_name || null,
    counter: String(Number.isSafeInteger(p.counter) ? p.counter : 0),
    rpName: p.rp_name || p.rp_id,
    userDisplayName: p.user_display_name || null,
    discoverable: p.discoverable === false ? 'false' : 'true',
    creationDate: p.created_at || nowIso(),
  };
}

// ------------------------------------------------------------------------------------------ reading files
function parseJson(text) {
  try {
    return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch {
    throw bwError('malformed', 'This file is not valid JSON.');
  }
}

function looksLikeJson(buf) {
  const head = buf.toString('utf8', 0, Math.min(buf.length, 64)).replace(/^﻿/, '').trimStart();
  return head.startsWith('{');
}

function csvHeader(buf) {
  return buf.toString('utf8', 0, Math.min(buf.length, 4096)).replace(/^﻿/, '').split(/\r?\n/, 1)[0].toLowerCase();
}

/** Bitwarden CSV (individual "folder,favorite,type,…" or organization "collections,type,…")? */
export function isBitwardenCsv(buf) {
  const h = csvHeader(buf);
  return /^"?(folder|collections)"?,/.test(h) && /(^|,)"?name"?(,|$)/.test(h) && /(^|,)"?type"?(,|$)/.test(h);
}

function zipParts(buf) {
  const entries = readZip(buf);
  const data = entries.find((e) => !e.isDir && /^(?:[^/]+\/)?data\.json$/i.test(e.name));
  if (!data) throw bwError('malformed', 'This ZIP file is not a Bitwarden export (it has no data.json).');
  const attachments = entries
    .filter((e) => !e.isDir && /(^|\/)attachments\/[^/]+\/[^/]+$/.test(e.name))
    .map((e) => {
      const parts = e.name.split('/');
      return { folder: parts[parts.length - 2], file: parts[parts.length - 1], size: e.size, entry: e };
    });
  return { data, attachments };
}

/**
 * Look at an import file without decrypting it.
 * @param {Buffer} buf
 * @returns {{kind: 'json'|'zip'|'csv'|null, encryption: 'none'|'password'|'account'|null, kdf?: object, attachments?: number}}
 */
export function inspectBitwarden(buf) {
  if (isZip(buf)) {
    const { data, attachments } = zipParts(buf);
    const doc = parseJson(data.read().toString('utf8'));
    return { kind: 'zip', encryption: encryptionOf(doc), kdf: encryptionOf(doc) === 'password' ? kdfInfo(doc) : null, attachments: attachments.length };
  }
  if (looksLikeJson(buf)) {
    const doc = parseJson(buf.toString('utf8'));
    if (!doc || typeof doc !== 'object' || (!Array.isArray(doc.items) && doc.encrypted !== true)) return { kind: null, encryption: null };
    return { kind: 'json', encryption: encryptionOf(doc), kdf: encryptionOf(doc) === 'password' ? kdfInfo(doc) : null };
  }
  if (isBitwardenCsv(buf)) return { kind: 'csv', encryption: 'none' };
  return { kind: null, encryption: null };
}

function kdfInfo(doc) {
  try {
    const k = checkKdf(doc);
    return k.kdfType === 1 ? { name: 'Argon2id', iterations: k.kdfIterations, memory: k.kdfMemory, parallelism: k.kdfParallelism } : { name: 'PBKDF2-SHA256', iterations: k.kdfIterations };
  } catch (e) {
    return { error: e.message };
  }
}

async function openJsonDoc(doc, password) {
  const enc = encryptionOf(doc);
  if (enc === 'account') throw bwError('account_restricted', ACCOUNT_RESTRICTED_MESSAGE);
  if (enc === 'password') {
    const inner = parseJson(await decryptPasswordProtected(doc, password));
    if (encryptionOf(inner) !== 'none') throw bwError('malformed', 'The decrypted export is itself encrypted.');
    return { doc: inner, protected: true };
  }
  return { doc, protected: false };
}

/**
 * Read a Bitwarden export (JSON, password-protected JSON, ZIP with attachments, CSV) into a Bitwarden-shaped
 * document `{folders?, collections?, items}` plus the ZIP's attachments.
 * @param {Buffer} buf
 * @param {{password?: string}} [opts]
 * @returns {Promise<{doc: object, source: string, protected: boolean, attachments: Array<{folder, file, size, entry}>}>}
 */
export async function readBitwarden(buf, { password } = {}) {
  if (isZip(buf)) {
    const { data, attachments } = zipParts(buf);
    const raw = data.read();
    const r = await openJsonDoc(parseJson(raw.toString('utf8')), password);
    raw.fill(0);
    checkDoc(r.doc);
    return { doc: r.doc, source: 'zip', protected: r.protected, attachments };
  }
  if (looksLikeJson(buf)) {
    const r = await openJsonDoc(parseJson(buf.toString('utf8')), password);
    checkDoc(r.doc);
    return { doc: r.doc, source: r.protected ? 'json-protected' : 'json', protected: r.protected, attachments: [] };
  }
  if (isBitwardenCsv(buf)) return { doc: parseBitwardenCsvFull(buf.toString('utf8')), source: 'csv', protected: false, attachments: [] };
  throw bwError('malformed', 'This is not a Bitwarden export.');
}

function checkDoc(doc) {
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.items)) throw bwError('malformed', 'This is not a Bitwarden JSON export (it has no "items" list).');
}

/**
 * Bitwarden CSV → Bitwarden-shaped document. Individual exports: folder,favorite,type,name,notes,fields,reprompt,
 * login_uri,login_username,login_password,login_totp; organization exports have "collections" instead of folder
 * and favorite. Only logins and notes exist in CSV; "fields" holds "name: value" lines.
 */
export function parseBitwardenCsvFull(text) {
  const rows = parseCsv(text);
  if (!rows.length) return { encrypted: false, folders: [], items: [] };
  const head = rows[0].map((h) => h.trim().toLowerCase());
  const col = (r, ...names) => {
    for (const n of names) {
      const i = head.indexOf(n);
      if (i >= 0 && i < r.length) return r[i];
    }
    return '';
  };
  const org = head.includes('collections') && !head.includes('folder');
  const folders = new Map();
  const collections = new Map();
  const items = [];
  for (const r of rows.slice(1)) {
    if (r.every((c) => !String(c).trim())) continue;
    const item = { id: randomUUID(), organizationId: null, folderId: null, type: 1, reprompt: col(r, 'reprompt').trim() === '1' ? 1 : 0, name: col(r, 'name'), notes: col(r, 'notes') || null, favorite: !org && !['', '0'].includes(col(r, 'favorite').trim()), fields: [], collectionIds: null };
    if (org) {
      const names = col(r, 'collections').split(',').map((s) => s.trim()).filter(Boolean);
      item.collectionIds = names.map((n) => {
        if (!collections.has(n)) collections.set(n, randomUUID());
        return collections.get(n);
      });
    } else {
      const f = col(r, 'folder').trim();
      if (f) {
        if (!folders.has(f)) folders.set(f, randomUUID());
        item.folderId = folders.get(f);
      }
    }
    for (const line of col(r, 'fields').split(/\r\n|\r|\n/)) {
      if (!line.trim()) continue;
      const d = line.lastIndexOf(': ');
      if (d < 0) continue;
      item.fields.push({ name: line.slice(0, d), value: line.slice(d + 2), type: 0, linkedId: null });
    }
    const archived = col(r, 'archiveddate').trim();
    if (archived) item.archivedDate = archived;
    if (col(r, 'type').trim().toLowerCase() === 'note') {
      item.type = 2;
      item.secureNote = { type: 0 };
    } else {
      const cell = col(r, 'login_uri', 'uri');
      const uris = cell.trim() ? (parseCsv(cell)[0] || []).map((u) => u.trim()).filter(Boolean) : [];
      item.login = { uris: uris.map((uri) => ({ match: null, uri })), username: col(r, 'login_username', 'username') || null, password: col(r, 'login_password', 'password') || null, totp: col(r, 'login_totp', 'totp') || null };
    }
    items.push(item);
  }
  const doc = { encrypted: false, items };
  if (org) doc.collections = [...collections].map(([name, id]) => ({ id, organizationId: null, name, externalId: null }));
  else doc.folders = [...folders].map(([name, id]) => ({ id, name }));
  return doc;
}

// ------------------------------------------------------------------------------------- Bitwarden → vault
function fieldFromBw(f, counts) {
  const name = str(f.name);
  switch (f.type) {
    case 1:
      return { name, value: str(f.value), hidden: true };
    case 2:
      counts.booleanFields++;
      return { name, value: String(f.value).toLowerCase() === 'true' ? 'true' : 'false', hidden: false, type: 'boolean' };
    case 3: {
      counts.linkedFields++;
      const id = Number(f.linkedId);
      return { name, value: `(linked to ${LINKED_IDS[id] || `Bitwarden property ${id}`})`, hidden: false, type: 'linked', linked_id: Number.isInteger(id) ? id : null };
    }
    default:
      return { name, value: str(f.value), hidden: false };
  }
}

/** Bitwarden sanitises item names for attachment folders in its ZIP export (and numbers repeats "_1", "_2"…). */
function attachmentFolderName(name) {
  return String(name || '').replace(/[/\\><:"|?*]/g, '_').replace(/__+/g, '_');
}

/**
 * Bitwarden-shaped document → vault interchange data, keeping everything (see the header).
 * @param {object} doc  {folders?, collections?, items}
 * @param {{includeTrash?: boolean, attachments?: Array<{folder, file, size}>}} [opts]
 * @returns {{folders: Array<{id,name}>, items: Array<object>, warnings: string[], trash: number, attachments: Array<{item: string, file: string, size: number, index: number}>}}
 */
export function bitwardenToItems(doc, { includeTrash = false, attachments = [] } = {}) {
  const warnings = [];
  const counts = { linkedFields: 0, booleanFields: 0, multiCollection: 0, orgNoCollection: 0, unnamed: 0, unknownType: 0, trash: 0 };
  const folderById = new Map();
  const paths = new Map();
  const addPath = (p) => {
    if (p && !paths.has(p)) paths.set(p, randomUUID());
  };
  for (const f of Array.isArray(doc.folders) ? doc.folders : []) {
    if (!f || typeof f.name !== 'string') continue;
    const p = normalizeFolderPath(f.name);
    if (!p) continue;
    folderById.set(f.id, p);
    addPath(p);
  }
  const collById = new Map();
  for (const c of Array.isArray(doc.collections) ? doc.collections : []) {
    if (!c || typeof c.name !== 'string') continue;
    const p = normalizeFolderPath(c.name);
    if (p) collById.set(c.id, p);
  }
  const items = [];
  const nameSeen = new Map();
  const attachmentOwner = new Map(); // ZIP folder name → item name / index
  for (const it of Array.isArray(doc.items) ? doc.items : []) {
    if (!it || typeof it !== 'object') continue;
    if (it.deletedDate) {
      counts.trash++;
      if (!includeTrash) continue;
    }
    let name = str(it.name).trim();
    const created = isoOr(it.creationDate, isoOr(it.revisionDate, nowIso()));
    const item = {
      folderPath: '',
      type: 'login',
      name,
      favorite: !!it.favorite,
      notes: str(it.notes),
      fields: [],
      password_history: (Array.isArray(it.passwordHistory) ? it.passwordHistory : [])
        .filter((h) => h && h.password)
        .map((h) => ({ password: String(h.password), changed_at: isoOr(h.lastUsedDate, isoOr(it.revisionDate, created)) })),
      created_at: created,
      updated_at: isoOr(it.revisionDate, created),
    };
    // folder: personal folder, else first collection, else Bitwarden trash
    let folder = (it.folderId && folderById.get(it.folderId)) || '';
    const colls = (Array.isArray(it.collectionIds) ? it.collectionIds : []).map((id) => collById.get(id)).filter(Boolean);
    if (!folder && colls.length) folder = colls[0];
    if (colls.length > 1) counts.multiCollection++;
    if (it.organizationId && !colls.length && !folder) counts.orgNoCollection++;
    if (it.deletedDate) folder = normalizeFolderPath(`Bitwarden trash/${folder}`);
    item.folderPath = folder;
    addPath(folder);
    if (it.reprompt === 1 || it.reprompt === true) item.reprompt = true;
    if (it.archivedDate) item.archived_at = isoOr(it.archivedDate, String(it.archivedDate));
    const custom = (Array.isArray(it.fields) ? it.fields : []).filter((f) => f && typeof f === 'object').map((f) => fieldFromBw(f, counts));
    const nt = NOTE_TYPES[it.type];
    switch (it.type) {
      case 1: {
        const l = it.login && typeof it.login === 'object' ? it.login : {};
        item.login = {
          username: str(l.username),
          password: str(l.password),
          uris: (Array.isArray(l.uris) ? l.uris : []).filter((u) => u && u.uri).map((u) => {
            const m = BW_MATCH[u.match];
            return m ? { uri: String(u.uri), match: m } : { uri: String(u.uri) };
          }),
        };
        if (l.totp) item.login.totp = String(l.totp).trim();
        const pks = [];
        for (const c of Array.isArray(l.fido2Credentials) ? l.fido2Credentials : []) {
          const r = bwToPasskey(c);
          if (r.passkey) pks.push(r.passkey);
          else {
            warnings.push(`“${name || '(no name)'}”: a passkey could not be used because ${r.reason}; its Bitwarden data is kept in a hidden custom field.`);
            custom.push({ name: UNUSABLE_PASSKEY, value: JSON.stringify(c), hidden: true, bitwarden: 'login.fido2Credential' });
          }
        }
        if (pks.length) item.login.passkeys = pks;
        break;
      }
      case 2:
        item.type = 'note';
        break;
      case 3:
        item.type = 'card';
        item.card = Object.fromEntries(CARD_BW.map(([k, b]) => [k, str(it.card && it.card[b])]));
        break;
      case 4: {
        item.type = 'identity';
        const id = it.identity && typeof it.identity === 'object' ? it.identity : {};
        item.identity = Object.fromEntries(IDENTITY_BW.map(([k, b]) => [k, str(id[b])]));
        if (id.address3) custom.unshift({ name: ADDRESS3_LABEL, value: str(id.address3), hidden: false, bitwarden: 'identity.address3' });
        break;
      }
      default:
        item.type = 'note';
        if (nt) {
          item.note_type = nt.kind;
          const sub = it[nt.prop] && typeof it[nt.prop] === 'object' ? it[nt.prop] : {};
          const typed = [];
          for (const [k, label, secret] of nt.keys) {
            const v = str(sub[k]);
            if (v || it.type === 5) typed.push({ name: label, value: v, hidden: !!secret, bitwarden: `${nt.prop}.${k}` });
          }
          custom.unshift(...typed);
        } else {
          counts.unknownType++;
          warnings.push(`“${name || '(no name)'}”: unknown Bitwarden item type ${JSON.stringify(it.type)} imported as a secure note (its notes and custom fields are kept).`);
        }
    }
    item.fields = custom;
    if (!name) {
      counts.unnamed++;
      const host = item.login && item.login.uris[0] ? hostOf(item.login.uris[0].uri) : '';
      name = host || (item.login && item.login.username) || `Untitled ${item.note_type ? NOTE_TYPES[it.type].label : item.type}`;
      item.name = name;
    }
    // attachments of this item in a ZIP export: Bitwarden names the folder after the item id (older clients)
    // or the sanitised item name, numbering repeats "_1", "_2"… in export order
    if (attachments.length) {
      const base = attachmentFolderName(it.name);
      const n = nameSeen.get(base) || 0;
      nameSeen.set(base, n + 1);
      const owner = { name, index: items.length };
      attachmentOwner.set(n === 0 ? base : `${base}_${n}`, owner);
      if (it.id) attachmentOwner.set(String(it.id), owner);
    }
    items.push(item);
  }
  if (counts.trash) warnings.push(includeTrash ? `${counts.trash} item(s) from Bitwarden’s trash are imported into the folder “Bitwarden trash”.` : `${counts.trash} item(s) in Bitwarden’s trash were skipped.`);
  if (counts.linkedFields) warnings.push(`${counts.linkedFields} linked custom field(s) (a field that points at another property, e.g. the password) have no Ludworks equivalent: they are kept as labelled fields and export back to Bitwarden as linked fields.`);
  if (counts.multiCollection) warnings.push(`${counts.multiCollection} item(s) belong to several collections; each is filed in the folder of its first collection.`);
  if (counts.orgNoCollection) warnings.push(`${counts.orgNoCollection} organization item(s) have no collection name in this file and are imported without a folder.`);
  if (counts.unnamed) warnings.push(`${counts.unnamed} item(s) had no name and were named after their website or type.`);
  const atts = attachments.map((a, i) => {
    const owner = attachmentOwner.get(a.folder);
    return { item: owner ? owner.name : a.folder, file: a.file, size: a.size, index: i, matched: !!owner };
  });
  if (atts.length) warnings.push(`${atts.length} file attachment(s) cannot be stored in the Ludworks vault (it has no attachments); you can save them to a folder instead.`);
  return { folders: [...paths].map(([name, id]) => ({ id, name })), items, warnings, trash: counts.trash, attachments: atts };
}

function hostOf(uri) {
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:/i.test(uri) ? uri : `https://${uri}`).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** Counts for the import preview. */
export function summarizeItems(items) {
  const s = { total: items.length, logins: 0, withTotp: 0, totpUnreadable: 0, withPasskeys: 0, passkeys: 0, withFields: 0, withHistory: 0, cards: 0, identities: 0, notes: 0, sshKeys: 0, bankAccounts: 0, driversLicenses: 0, passports: 0, reprompt: 0, archived: 0, favorites: 0 };
  for (const it of items) {
    if (it.type === 'login') {
      s.logins++;
      const l = it.login || {};
      if (l.totp) {
        s.withTotp++;
        try {
          parseTotpInput(l.totp);
        } catch {
          s.totpUnreadable++;
        }
      }
      if ((l.passkeys || []).length) {
        s.withPasskeys++;
        s.passkeys += l.passkeys.length;
      }
    } else if (it.type === 'card') s.cards++;
    else if (it.type === 'identity') s.identities++;
    else if (it.note_type === 'ssh_key') s.sshKeys++;
    else if (it.note_type === 'bank_account') s.bankAccounts++;
    else if (it.note_type === 'drivers_license') s.driversLicenses++;
    else if (it.note_type === 'passport') s.passports++;
    else s.notes++;
    if ((it.fields || []).some((f) => !f.bitwarden)) s.withFields++;
    if ((it.password_history || []).length) s.withHistory++;
    if (it.reprompt) s.reprompt++;
    if (it.archived_at) s.archived++;
    if (it.favorite) s.favorites++;
  }
  return s;
}

/** Warnings that depend on the mapped items (TOTP that will not generate codes, re-prompt, archive, new types). */
export function itemWarnings(items, stats = summarizeItems(items)) {
  const w = [];
  if (stats.totpUnreadable) {
    const names = items.filter((it) => it.login && it.login.totp && !totpOk(it.login.totp)).slice(0, 5).map((it) => `“${it.name}”`);
    w.push(`${stats.totpUnreadable} authenticator (TOTP) key(s) are not in a format Ludworks can generate codes from (e.g. HOTP); they are kept exactly as stored: ${names.join(', ')}${stats.totpUnreadable > 5 ? '…' : ''}.`);
  }
  if (stats.reprompt) w.push(`${stats.reprompt} item(s) ask for the master password again in Bitwarden (“re-prompt”). Ludworks does not re-prompt; the setting is kept for export.`);
  if (stats.archived) w.push(`${stats.archived} archived item(s) are imported as regular items (the archive date is kept for export).`);
  const special = [['sshKeys', 'SSH key'], ['bankAccounts', 'bank account'], ['driversLicenses', "driver's license"], ['passports', 'passport']].filter(([k]) => stats[k]);
  if (special.length) w.push(`${special.map(([k, l]) => `${stats[k]} ${l}(s)`).join(', ')} are imported as secure notes with their values as custom fields (secrets hidden); they export back to Bitwarden as the original type.`);
  return w;
}

function totpOk(t) {
  try {
    parseTotpInput(t);
    return true;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------------------------- vault → Bitwarden
const nul = (v) => (v === undefined || v === null || v === '' ? null : String(v));

function takeTagged(fields, tag, fallbackName) {
  let i = fields.findIndex((f) => f && f.bitwarden === tag);
  if (i < 0 && fallbackName) i = fields.findIndex((f) => f && !f.bitwarden && f.name === fallbackName);
  if (i < 0) return undefined;
  return str(fields.splice(i, 1)[0].value);
}

function fieldToBw(f) {
  if (f.type === 'linked' && Number.isInteger(f.linked_id)) return { name: nul(f.name), value: null, type: 3, linkedId: f.linked_id };
  if (f.type === 'boolean') return { name: nul(f.name), value: String(f.value).toLowerCase() === 'true' ? 'true' : 'false', type: 2, linkedId: null };
  return { name: nul(f.name), value: nul(f.value), type: f.hidden ? 1 : 0, linkedId: null };
}

/**
 * Vault interchange data → Bitwarden individual JSON export document (round-trips everything above).
 * @param {{folders?: Array<{id?, name}>, items: Array<object>}} data   items may carry `id` (kept as Bitwarden id)
 * @returns {{doc: object, warnings: string[]}}
 */
export function itemsToBitwarden(data) {
  const warnings = [];
  const folderIds = new Map();
  for (const f of (data && data.folders) || []) {
    const p = normalizeFolderPath(f.name);
    if (p && !folderIds.has(p)) folderIds.set(p, f.id && GUID_RE.test(f.id) ? f.id : randomUUID());
  }
  const items = [];
  for (const it of (data && data.items) || []) {
    const path = normalizeFolderPath(it.folderPath);
    if (path && !folderIds.has(path)) folderIds.set(path, randomUUID());
    const fields = (Array.isArray(it.fields) ? it.fields : []).filter((f) => f && typeof f === 'object').map((f) => ({ ...f }));
    const out = {
      passwordHistory: (it.password_history || []).filter((h) => h && h.password).length ? it.password_history.filter((h) => h && h.password).map((h) => ({ lastUsedDate: h.changed_at || nowIso(), password: String(h.password) })) : null,
      revisionDate: it.updated_at || nowIso(),
      creationDate: it.created_at || it.updated_at || nowIso(),
      deletedDate: null,
    };
    if (it.archived_at) out.archivedDate = it.archived_at;
    Object.assign(out, { id: it.id && GUID_RE.test(it.id) ? it.id : randomUUID(), organizationId: null, folderId: path ? folderIds.get(path) : null, type: 1, reprompt: it.reprompt ? 1 : 0, name: str(it.name), notes: nul(it.notes), favorite: !!it.favorite });
    const type = it.type;
    if (type === 'login' || (!['note', 'card', 'identity'].includes(type) && it.login)) {
      const l = it.login || {};
      const creds = [];
      for (const p of Array.isArray(l.passkeys) ? l.passkeys : []) {
        if (p && p.algorithm === -7 && p.private_key && p.credential_id) creds.push(passkeyToBw(p));
        else warnings.push(`“${it.name}”: a passkey with an algorithm Bitwarden does not support was not exported.`);
      }
      const kept = [];
      for (const f of fields) {
        let c = null;
        if (f.bitwarden === 'login.fido2Credential') {
          try {
            c = JSON.parse(f.value);
          } catch {
            c = null;
          }
        }
        if (c && typeof c === 'object') creds.push(c);
        else kept.push(f);
      }
      fields.splice(0, fields.length, ...kept);
      out.type = 1;
      out.login = {
        fido2Credentials: creds,
        uris: (Array.isArray(l.uris) ? l.uris : []).map((u) => (typeof u === 'string' ? { uri: u } : u)).filter((u) => u && u.uri).map((u) => {
          const i = BW_MATCH.indexOf(u.match);
          return { match: i >= 0 ? i : null, uri: String(u.uri) };
        }),
        username: nul(l.username),
        password: nul(l.password),
        totp: nul(l.totp),
      };
    } else if (type === 'card') {
      out.type = 3;
      out.card = Object.fromEntries(CARD_BW.map(([k, b]) => [b, nul(it.card && it.card[k])]));
    } else if (type === 'identity') {
      out.type = 4;
      const src = it.identity || {};
      const vals = Object.fromEntries(IDENTITY_BW.map(([k, b]) => [b, nul(src[k])]));
      vals.address3 = nul(takeTagged(fields, 'identity.address3', ADDRESS3_LABEL));
      out.identity = Object.fromEntries(IDENTITY_ORDER.map((k) => [k, vals[k] ?? null]));
    } else {
      const t = NOTE_KIND_TO_TYPE[it.note_type];
      const nt = t ? NOTE_TYPES[t] : null;
      let sub = null;
      if (nt) {
        const probe = fields.map((f) => ({ ...f }));
        sub = {};
        for (const [k, label] of nt.keys) {
          const v = takeTagged(probe, `${nt.prop}.${k}`, label);
          sub[k] = t === 5 ? str(v) : nul(v);
        }
        if (t === 5 && !sub.privateKey) sub = null; // Bitwarden refuses an SSH key without a private key
        else fields.splice(0, fields.length, ...probe);
      }
      if (sub) {
        out.type = t;
        out[nt.prop] = sub;
      } else {
        out.type = 2;
        out.secureNote = { type: 0 };
      }
    }
    if (fields.length) out.fields = fields.map(fieldToBw);
    out.collectionIds = null;
    items.push(out);
  }
  return { doc: { encrypted: false, folders: [...folderIds].map(([name, id]) => ({ id, name })), items }, warnings };
}

const CARD_LABELS = [['cardholderName', 'Cardholder name'], ['brand', 'Brand'], ['number', 'Number'], ['expMonth', 'Expiration month'], ['expYear', 'Expiration year'], ['code', 'Security code']];
const IDENTITY_LABELS = IDENTITY_ORDER.map((k) => [k, LINKED_IDS[{ title: 400, middleName: 401, address1: 402, address2: 403, address3: 404, city: 405, state: 406, postalCode: 407, country: 408, company: 409, email: 410, phone: 411, ssn: 412, username: 413, passportNumber: 414, licenseNumber: 415, firstName: 416, lastName: 417 }[k]]]);

/** Bitwarden CSV can only hold logins and notes: other types become notes with their values as fields. */
export function bitwardenDocToCsv(doc) {
  const folderName = new Map((doc.folders || []).map((f) => [f.id, f.name]));
  const rows = [['folder', 'favorite', 'type', 'name', 'notes', 'fields', 'reprompt', 'login_uri', 'login_username', 'login_password', 'login_totp']];
  const one = (s) => String(s ?? '').replace(/\r?\n/g, ' ');
  for (const it of doc.items || []) {
    const fields = [];
    const sub = it.type === 3 ? [it.card, CARD_LABELS] : it.type === 4 ? [it.identity, IDENTITY_LABELS] : NOTE_TYPES[it.type] ? [it[NOTE_TYPES[it.type].prop], NOTE_TYPES[it.type].keys.map(([k, l]) => [k, l])] : null;
    if (sub && sub[0]) for (const [k, label] of sub[1]) if (sub[0][k]) fields.push(`${label}: ${one(sub[0][k])}`);
    for (const f of it.fields || []) fields.push(`${f.name ?? ''}: ${f.type === 3 ? `(linked to ${LINKED_IDS[f.linkedId] || f.linkedId})` : one(f.value)}`);
    const isLogin = it.type === 1;
    rows.push([
      it.folderId ? folderName.get(it.folderId) || '' : '',
      it.favorite ? '1' : '',
      isLogin ? 'login' : 'note',
      it.name ?? '',
      it.notes ?? '',
      fields.join('\n'),
      it.reprompt ? '1' : '0',
      isLogin && it.login ? toCsv([(it.login.uris || []).map((u) => u.uri).filter(Boolean)]).replace(/\r\n$/, '') : '',
      isLogin && it.login ? (it.login.username ?? '') : '',
      isLogin && it.login ? (it.login.password ?? '') : '',
      isLogin && it.login ? (it.login.totp ?? '') : '',
    ]);
  }
  return toCsv(rows);
}

/**
 * Serialise vault interchange data as a Bitwarden export.
 * @param {'json'|'json-protected'|'csv'} kind
 * @param {object} data
 * @param {{password?: string, kdf?: 'pbkdf2'|'argon2id'}} [opts]
 * @returns {Promise<{text: string, warnings: string[]}>}
 */
export async function exportBitwarden(kind, data, { password, kdf = 'pbkdf2' } = {}) {
  const { doc, warnings } = itemsToBitwarden(data);
  if (kind === 'csv') {
    const passkeys = doc.items.reduce((n, it) => n + (it.login && it.login.fido2Credentials ? it.login.fido2Credentials.length : 0), 0);
    if (passkeys) warnings.push(`${passkeys} passkey(s) are not included: Bitwarden CSV cannot hold passkeys (use JSON).`);
    return { text: bitwardenDocToCsv(doc), warnings };
  }
  const clear = JSON.stringify(doc, null, 2);
  if (kind === 'json') return { text: clear, warnings };
  if (kind !== 'json-protected') throw bwError('bad_request', `unknown Bitwarden export kind ${kind}`);
  const opts = kdf === 'argon2id' ? { kdfType: 1, kdfIterations: 3, kdfMemory: 64, kdfParallelism: 4 } : { kdfType: 0, kdfIterations: 600000 };
  return { text: await encryptPasswordProtected(clear, password, opts), warnings };
}
