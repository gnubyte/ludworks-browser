// Vault import/export: the vendored Ludworks web library (Bitwarden JSON/CSV/password-protected JSON,
// KeePass) plus what Ludworks Browser adds on top — passkeys (VAULT-CRYPTO.md §8.4: Bitwarden
// `login.fido2Credentials` ⇄ `login.passkeys`) and Chrome/Edge/Firefox password CSV files.

import { parseBitwardenJson, parseBitwardenCsv, toBitwardenJson, toBitwardenCsv, parseCsv } from '../../vendor/vault/bitwarden.js';
import { bitwardenToVault, vaultToBitwarden, importVault, exportVault, detectFormat as detectLibFormat } from '../../vendor/vault/convert.js';
import { validPasskeyKey } from '../passkeys.js';

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const b64u = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64u = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');

// ----------------------------------------------------------------------------------- passkeys
/** Bitwarden credentialId (GUID or "b64."+base64url) → raw credential id as base64url. */
export function bwCredentialIdToRaw(id) {
  const s = String(id || '');
  if (s.startsWith('b64.')) return b64u(fromB64u(s.slice(4)));
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

export function bwToPasskey(c, warnings, itemName) {
  if (!c || typeof c !== 'object') return null;
  if ((c.keyType && c.keyType !== 'public-key') || (c.keyAlgorithm && c.keyAlgorithm !== 'ECDSA') || (c.keyCurve && c.keyCurve !== 'P-256')) {
    warnings.push(`"${itemName}": a passkey with an unsupported key type was skipped`);
    return null;
  }
  const id = bwCredentialIdToRaw(c.credentialId);
  if (!id || typeof c.keyValue !== 'string' || !validPasskeyKey(c.keyValue) || typeof c.rpId !== 'string' || !c.rpId) {
    warnings.push(`"${itemName}": a passkey that could not be read was skipped`);
    return null;
  }
  const counter = parseInt(String(c.counter ?? '0'), 10);
  return {
    credential_id: id,
    rp_id: String(c.rpId).toLowerCase(),
    rp_name: String(c.rpName || c.rpId),
    user_handle: c.userHandle ? b64u(fromB64u(String(c.userHandle))) : '',
    user_name: String(c.userName || ''),
    user_display_name: String(c.userDisplayName || ''),
    algorithm: -7,
    private_key: b64u(fromB64u(c.keyValue)),
    counter: Number.isSafeInteger(counter) && counter >= 0 ? counter : 0,
    discoverable: String(c.discoverable) !== 'false',
    created_at: typeof c.creationDate === 'string' ? c.creationDate : new Date().toISOString(),
  };
}

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
    creationDate: p.created_at || new Date().toISOString(),
  };
}

/** Bitwarden-shaped data → vault interchange data, keeping passkeys. */
export function bitwardenToVaultWithPasskeys(bw) {
  const conv = bitwardenToVault(bw);
  const live = (bw.items || []).filter((it) => !it.deletedDate);
  conv.warnings = conv.warnings.filter((w) => !/passkeys cannot be transferred/.test(w));
  live.forEach((src, i) => {
    const creds = src && src.type === 1 && src.login && Array.isArray(src.login.fido2Credentials) ? src.login.fido2Credentials : [];
    const dst = conv.items[i];
    if (!creds.length || !dst || dst.type !== 'login') return;
    const pks = creds.map((c) => bwToPasskey(c, conv.warnings, dst.name)).filter(Boolean);
    if (pks.length) dst.login.passkeys = pks;
  });
  return conv;
}

/** Vault interchange data → Bitwarden-shaped data, keeping passkeys. */
export function vaultToBitwardenWithPasskeys(data) {
  const bw = vaultToBitwarden(data);
  (data.items || []).forEach((it, i) => {
    const pks = it && it.login && Array.isArray(it.login.passkeys) ? it.login.passkeys : [];
    if (pks.length && bw.items[i] && bw.items[i].login) bw.items[i].login.fido2Credentials = pks.filter((p) => p && p.algorithm === -7).map(passkeyToBw);
  });
  return bw;
}

// ---------------------------------------------------------------------------- browser CSVs
/** Chrome/Edge ("name,url,username,password,note") and Firefox password CSV exports. */
export function parseBrowserPasswordCsv(text) {
  const rows = parseCsv(text);
  if (!rows.length) return null;
  const head = rows[0].map((h) => String(h).trim().toLowerCase());
  const idx = (n) => head.indexOf(n);
  const iu = idx('url');
  const iuser = idx('username');
  const ipw = idx('password');
  if (iu < 0 || iuser < 0 || ipw < 0) return null;
  const iname = idx('name');
  const inote = idx('note') >= 0 ? idx('note') : idx('notes');
  const items = [];
  const now = new Date().toISOString();
  for (const r of rows.slice(1)) {
    const url = String(r[iu] || '').trim();
    const password = String(r[ipw] || '');
    if (!url && !password) continue;
    let host = url;
    try {
      host = new URL(url).hostname.replace(/^www\./, '');
    } catch {
      /* keep raw */
    }
    items.push({
      folderPath: '',
      type: 'login',
      name: String((iname >= 0 && r[iname]) || host || 'Login'),
      favorite: false,
      notes: inote >= 0 ? String(r[inote] || '') : '',
      fields: [],
      password_history: [],
      login: { username: String(r[iuser] || ''), password, uris: url ? [{ uri: url, match: 'domain' }] : [] },
      created_at: now,
      updated_at: now,
    });
  }
  return { folders: [], items, warnings: [] };
}

/**
 * Detect the format of a password import file.
 * @returns {'bitwarden-json'|'bitwarden-csv'|'browser-csv'|'kdbx'|'keepass-xml'|null}
 */
export function detectFormat(buf) {
  const lib = detectLibFormat(new Uint8Array(buf));
  if (lib && lib !== 'bitwarden-csv') return lib;
  const first = buf.toString('utf8', 0, 4096).replace(/^﻿/, '').split(/\r?\n/, 1)[0].toLowerCase();
  if (/^"?folder"?,"?favorite"?,"?type"?/.test(first)) return 'bitwarden-csv';
  if (/(^|,)"?url"?(,|$)/.test(first) && /(^|,)"?username"?(,|$)/.test(first) && /(^|,)"?password"?(,|$)/.test(first)) return 'browser-csv';
  return lib;
}

/** Is this a password-protected Bitwarden JSON (needs the file password)? */
export function needsPassword(format, buf) {
  if (format === 'kdbx') return true;
  if (format !== 'bitwarden-json') return false;
  try {
    const j = JSON.parse(buf.toString('utf8').replace(/^﻿/, ''));
    return !!(j && j.encrypted === true && j.passwordProtected === true);
  } catch {
    return false;
  }
}

/**
 * Parse an import file into vault interchange data {folders, items, warnings}.
 * @param {Buffer} buf
 * @param {{format?: string, password?: string}} opts
 */
export async function parseImport(buf, { format = null, password = undefined } = {}) {
  const f = format || detectFormat(buf);
  const text = () => buf.toString('utf8').replace(/^﻿/, '');
  switch (f) {
    case 'bitwarden-json':
      return bitwardenToVaultWithPasskeys(await parseBitwardenJson(text(), { password }));
    case 'bitwarden-csv':
      return bitwardenToVault(parseBitwardenCsv(text()));
    case 'browser-csv': {
      const r = parseBrowserPasswordCsv(text());
      if (!r) throw new Error('This CSV file does not look like a password export.');
      return r;
    }
    case 'kdbx':
    case 'keepass-xml':
      return importVault(f, f === 'kdbx' ? new Uint8Array(buf) : text(), { password });
    default:
      throw new Error('Unrecognised file. Supported: Bitwarden JSON (also password-protected) and CSV, Chrome/Edge/Firefox password CSV, KeePass (.kdbx, XML).');
  }
}

/**
 * Serialise vault interchange data.
 * @param {'bitwarden-json'|'bitwarden-json-protected'|'bitwarden-csv'|'kdbx'} format
 * @returns {Promise<string|Uint8Array>}
 */
export async function serializeExport(format, data, { password } = {}) {
  switch (format) {
    case 'bitwarden-json':
      return toBitwardenJson(vaultToBitwardenWithPasskeys(data));
    case 'bitwarden-json-protected':
      if (!password) throw new Error('A file password is required.');
      return toBitwardenJson(vaultToBitwardenWithPasskeys(data), { password, kdfType: 0, kdfIterations: 600000 });
    case 'bitwarden-csv':
      return toBitwardenCsv(vaultToBitwarden(data));
    case 'kdbx':
      if (!password) throw new Error('A database password is required.');
      return exportVault('kdbx', data, { password });
    default:
      throw new Error(`unknown export format ${format}`);
  }
}
