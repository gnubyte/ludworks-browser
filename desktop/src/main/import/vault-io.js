// Vault import/export façade for Ludworks Browser:
//  * Bitwarden — full fidelity (bitwarden-io.js): unencrypted JSON (individual and organization), password-protected
//    JSON (PBKDF2 / Argon2id, bw-crypto.js), the .zip export with attachments, CSV (individual and organization);
//    passkeys (VAULT-CRYPTO.md §8.4: `login.fido2Credentials` ⇄ `login.passkeys`), TOTP, custom field types,
//    password history, SSH keys and the other Bitwarden-only types, re-prompt, archive, collections.
//    Account-restricted encrypted exports are recognised and explained.
//  * KeePass (.kdbx, XML) via the vendored web library; Chrome/Edge/Firefox password CSV files.

import { parseCsv } from '../../vendor/vault/bitwarden.js';
import { importVault, exportVault, detectFormat as detectLibFormat } from '../../vendor/vault/convert.js';
import {
  bwCredentialIdToRaw,
  rawToBwCredentialId,
  bwToPasskey as bwToPasskeyResult,
  passkeyToBw,
  readBitwarden,
  inspectBitwarden,
  bitwardenToItems,
  itemsToBitwarden,
  summarizeItems,
  itemWarnings,
  exportBitwarden,
} from './bitwarden-io.js';
import { isZip } from './zip.js';
import { ACCOUNT_RESTRICTED_MESSAGE } from './bw-crypto.js';

export { bwCredentialIdToRaw, rawToBwCredentialId, passkeyToBw };

/** Bitwarden fido2Credential → Ludworks passkey, or null (reason appended to warnings). */
export function bwToPasskey(c, warnings = [], itemName = '') {
  const r = bwToPasskeyResult(c);
  if (!r.passkey) warnings.push(`“${itemName}”: a passkey could not be used because ${r.reason}`);
  return r.passkey;
}

/** Bitwarden-shaped data → vault interchange data, keeping passkeys and everything else (see bitwarden-io.js). */
export function bitwardenToVaultWithPasskeys(bw, opts) {
  return bitwardenToItems(bw, opts);
}

/** Vault interchange data → Bitwarden-shaped data, keeping passkeys. */
export function vaultToBitwardenWithPasskeys(data) {
  return itemsToBitwarden(data).doc;
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

// ---------------------------------------------------------------------------- detection
const FORMAT_LABELS = {
  'bitwarden-json': 'Bitwarden JSON',
  'bitwarden-zip': 'Bitwarden ZIP (with attachments)',
  'bitwarden-csv': 'Bitwarden CSV',
  'browser-csv': 'Browser password CSV',
  kdbx: 'KeePass database',
  'keepass-xml': 'KeePass XML',
};

export function formatLabel(f) {
  return FORMAT_LABELS[f] || 'Unknown format';
}

/**
 * Detect the format of a password import file.
 * @returns {'bitwarden-json'|'bitwarden-zip'|'bitwarden-csv'|'browser-csv'|'kdbx'|'keepass-xml'|null}
 */
export function detectFormat(buf) {
  if (isZip(buf)) return 'bitwarden-zip';
  const lib = detectLibFormat(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
  if (lib && lib !== 'bitwarden-csv') return lib;
  const first = buf.toString('utf8', 0, 4096).replace(/^﻿/, '').split(/\r?\n/, 1)[0].toLowerCase();
  if (/^"?(folder|collections)"?,/.test(first)) return 'bitwarden-csv';
  if (/(^|,)"?url"?(,|$)/.test(first) && /(^|,)"?username"?(,|$)/.test(first) && /(^|,)"?password"?(,|$)/.test(first)) return 'browser-csv';
  return lib;
}

/**
 * What the import UI needs to know before asking for a password.
 * @returns {{format: string|null, label: string, needsPassword: boolean, accountRestricted: boolean, kdf: object|null, attachments: number, error: string|null}}
 */
export function inspectImport(buf, format = detectFormat(buf)) {
  const out = { format, label: formatLabel(format), needsPassword: format === 'kdbx', accountRestricted: false, kdf: null, attachments: 0, error: null };
  if (format === 'bitwarden-json' || format === 'bitwarden-zip') {
    try {
      const i = inspectBitwarden(buf);
      if (!i.kind) out.error = 'This JSON file is not a Bitwarden export.';
      out.needsPassword = i.encryption === 'password';
      out.accountRestricted = i.encryption === 'account';
      out.kdf = i.kdf || null;
      out.attachments = i.attachments || 0;
      if (i.kdf && i.kdf.error) out.error = i.kdf.error;
      if (out.accountRestricted) out.error = ACCOUNT_RESTRICTED_MESSAGE;
    } catch (e) {
      out.error = e.message;
    }
  }
  return out;
}

/** Is this a password-protected file (needs the file password)? */
export function needsPassword(format, buf) {
  return inspectImport(buf, format).needsPassword;
}

// ---------------------------------------------------------------------------- import
/**
 * Read (and decrypt) an import file. Bitwarden files stay Bitwarden-shaped until mapImport, so options such as
 * "include trash" can be changed without decrypting again.
 * @returns {Promise<{format: string, bitwarden?: {doc, attachments, source}, data?: {folders, items, warnings}}>}
 */
export async function openImport(buf, { format = null, password = undefined } = {}) {
  const f = format || detectFormat(buf);
  const text = () => buf.toString('utf8').replace(/^﻿/, '');
  switch (f) {
    case 'bitwarden-json':
    case 'bitwarden-zip':
    case 'bitwarden-csv': {
      const r = await readBitwarden(buf, { password });
      return { format: f, bitwarden: r };
    }
    case 'browser-csv': {
      const r = parseBrowserPasswordCsv(text());
      if (!r) throw new Error('This CSV file does not look like a password export.');
      return { format: f, data: r };
    }
    case 'kdbx':
    case 'keepass-xml':
      return { format: f, data: await importVault(f, f === 'kdbx' ? new Uint8Array(buf) : text(), { password }) };
    default:
      throw new Error('Unrecognised file. Supported: Bitwarden (.json — also password-protected —, .zip with attachments, .csv), Chrome/Edge/Firefox password CSV, KeePass (.kdbx, XML).');
  }
}

/**
 * Opened import → vault interchange data {folders, items, warnings, stats, attachments, trash}.
 * @param {Awaited<ReturnType<typeof openImport>>} opened
 * @param {{includeTrash?: boolean}} [opts]
 */
export function mapImport(opened, { includeTrash = false } = {}) {
  let conv;
  if (opened.bitwarden) conv = bitwardenToItems(opened.bitwarden.doc, { includeTrash, attachments: opened.bitwarden.attachments });
  else conv = { ...opened.data, warnings: [...(opened.data.warnings || [])], trash: 0, attachments: [] };
  const stats = summarizeItems(conv.items);
  conv.warnings.push(...itemWarnings(conv.items, stats));
  return { ...conv, stats };
}

/**
 * Parse an import file into vault interchange data {folders, items, warnings, stats, …}.
 * @param {Buffer} buf
 * @param {{format?: string, password?: string, includeTrash?: boolean}} opts
 */
export async function parseImport(buf, { format = null, password = undefined, includeTrash = false } = {}) {
  return mapImport(await openImport(buf, { format, password }), { includeTrash });
}

// ---------------------------------------------------------------------------- export
/**
 * Serialise vault interchange data.
 * @param {'bitwarden-json'|'bitwarden-json-protected'|'bitwarden-csv'|'kdbx'} format
 * @param {{password?: string, kdf?: 'pbkdf2'|'argon2id'}} [opts]
 * @returns {Promise<{out: string|Uint8Array, warnings: string[]}>}
 */
export async function exportVaultFile(format, data, { password, kdf } = {}) {
  switch (format) {
    case 'bitwarden-json': {
      const r = await exportBitwarden('json', data);
      return { out: r.text, warnings: r.warnings };
    }
    case 'bitwarden-json-protected': {
      if (!password) throw new Error('A file password is required.');
      const r = await exportBitwarden('json-protected', data, { password, kdf });
      return { out: r.text, warnings: r.warnings };
    }
    case 'bitwarden-csv': {
      const r = await exportBitwarden('csv', data);
      return { out: r.text, warnings: r.warnings };
    }
    case 'kdbx':
      if (!password) throw new Error('A database password is required.');
      return { out: await exportVault('kdbx', data, { password }), warnings: [] };
    default:
      throw new Error(`unknown export format ${format}`);
  }
}

/** Serialise vault interchange data (string or bytes only). */
export async function serializeExport(format, data, opts = {}) {
  return (await exportVaultFile(format, data, opts)).out;
}
