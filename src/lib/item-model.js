// Vault item plaintext helpers (VAULT-CRYPTO.md §3). Unknown keys are always preserved on edit.

import { bestMatchScore, siteName } from './url-match.js';

export const ITEM_TYPES = Object.freeze(['login', 'note', 'card', 'identity']);
export const PASSWORD_HISTORY_MAX = 10;
// UTF-8 bytes of the item JSON: sealed ("v1." + nonce + base64(json + tag)) it must stay below the server's
// 256 KiB limit for an item's data (≈ 196 577 bytes of plaintext), with some margin.
export const MAX_ITEM_JSON = 190 * 1024;
const utf8 = new TextEncoder();

/** Field definitions used by the popup to render / edit card and identity items. */
export const CARD_FIELDS = Object.freeze([
  { key: 'cardholder', label: 'Cardholder name' },
  { key: 'brand', label: 'Brand' },
  { key: 'number', label: 'Number', secret: true, mono: true },
  { key: 'exp_month', label: 'Expiry month' },
  { key: 'exp_year', label: 'Expiry year' },
  { key: 'code', label: 'Security code', secret: true, mono: true },
]);

export const IDENTITY_FIELDS = Object.freeze([
  { key: 'title', label: 'Title' },
  { key: 'first_name', label: 'First name' },
  { key: 'middle_name', label: 'Middle name' },
  { key: 'last_name', label: 'Last name' },
  { key: 'company', label: 'Company' },
  { key: 'email', label: 'Email' },
  { key: 'phone', label: 'Phone' },
  { key: 'username', label: 'Username' },
  { key: 'address1', label: 'Address 1' },
  { key: 'address2', label: 'Address 2' },
  { key: 'city', label: 'City' },
  { key: 'state', label: 'State / province' },
  { key: 'postal_code', label: 'Postal code' },
  { key: 'country', label: 'Country' },
  { key: 'ssn', label: 'National ID / SSN', secret: true },
  { key: 'passport', label: 'Passport number', secret: true },
  { key: 'license', label: 'License number', secret: true },
]);

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Deep clone a JSON value (items are JSON by definition).
 * @template T
 * @param {T} v
 * @returns {T}
 */
export function cloneJson(v) {
  return v === undefined ? v : JSON.parse(JSON.stringify(v));
}

/**
 * Validate an item plaintext object before encryption.
 * @param {any} data
 * @returns {string|null} error message, or null when valid
 */
export function validateItemData(data) {
  if (!isPlainObject(data)) return 'Item must be an object';
  if (!ITEM_TYPES.includes(data.type)) return 'Unknown item type';
  if (typeof data.name !== 'string' || !data.name.trim()) return 'Name is required';
  if (data.name.length > 500) return 'Name is too long';
  if (data.type !== 'note' && !isPlainObject(data[data.type])) return `Missing ${data.type} details`;
  if (data.type === 'login') {
    const l = data.login;
    if (l.uris !== undefined && !Array.isArray(l.uris)) return 'URIs must be a list';
    for (const u of l.uris || []) {
      if (!isPlainObject(u) || typeof u.uri !== 'string') return 'Invalid URI entry';
    }
  }
  if (data.fields !== undefined && !Array.isArray(data.fields)) return 'Custom fields must be a list';
  let json;
  try {
    json = JSON.stringify(data);
  } catch {
    return 'Item is not serializable';
  }
  // Measure what is encrypted (UTF-8 bytes), not UTF-16 code units: non-Latin text is 2–4 bytes per char.
  if (json.length > MAX_ITEM_JSON || utf8.encode(json).length > MAX_ITEM_JSON) return 'Item is too large';
  return null;
}

/**
 * New login item, prefilled for a site. Logins saved automatically (offer to save) use `match: 'host'`
 * (VAULT-CRYPTO.md §8.3, defence in depth); ones the user creates default to `domain`.
 * @param {{name?: string, url?: string, username?: string, password?: string, now?: string, match?: 'domain'|'host'}} p
 */
export function newLoginItem({ name = '', url = '', username = '', password = '', now = new Date().toISOString(), match = 'domain' } = {}) {
  let uris = [];
  if (url) {
    try {
      const u = new URL(url);
      if (u.protocol === 'https:' || u.protocol === 'http:') uris = [{ uri: u.origin, match }];
    } catch {
      uris = [];
    }
  }
  return {
    type: 'login',
    name: name || (url ? siteName(url) : ''),
    favorite: false,
    notes: '',
    login: { username, password, uris, totp: '' },
    fields: [],
    password_history: [],
    created_at: now,
    updated_at: now,
  };
}

/**
 * Empty item of a given type.
 * @param {'login'|'note'|'card'|'identity'} type
 * @param {string} [now]
 */
export function newItem(type, now = new Date().toISOString()) {
  if (type === 'login') return newLoginItem({ now });
  const base = { type, name: '', favorite: false, notes: '', fields: [], created_at: now, updated_at: now };
  if (type === 'card') base.card = Object.fromEntries(CARD_FIELDS.map((f) => [f.key, '']));
  if (type === 'identity') base.identity = Object.fromEntries(IDENTITY_FIELDS.map((f) => [f.key, '']));
  return base;
}

/**
 * When a login's password changes, push the old one onto password_history (newest first, capped).
 * Returns a new object; `next` is not mutated.
 * @param {object|null} prev  previous plaintext
 * @param {object} next
 * @param {string} now  ISO time
 */
export function applyPasswordHistory(prev, next, now) {
  const out = cloneJson(next);
  const oldPw = prev && prev.login && typeof prev.login.password === 'string' ? prev.login.password : '';
  const newPw = out.login && typeof out.login.password === 'string' ? out.login.password : '';
  if (out.type === 'login' && oldPw && oldPw !== newPw) {
    const history = Array.isArray(out.password_history) ? out.password_history.filter(isPlainObject) : [];
    out.password_history = [{ password: oldPw, changed_at: now }, ...history].slice(0, PASSWORD_HISTORY_MAX);
  }
  return out;
}

function lastFour(number) {
  const digits = String(number || '').replace(/\D/g, '');
  return digits.length >= 4 ? digits.slice(-4) : '';
}

/**
 * Subtitle shown under the item name in lists.
 * @param {object} data
 * @returns {string}
 */
export function itemSubtitle(data) {
  switch (data.type) {
    case 'login':
      return (data.login && data.login.username) || '';
    case 'card': {
      const c = data.card || {};
      const l4 = lastFour(c.number);
      return [c.brand, l4 ? `•••• ${l4}` : ''].filter(Boolean).join(' ');
    }
    case 'identity': {
      const i = data.identity || {};
      return [i.first_name, i.last_name].filter(Boolean).join(' ') || i.email || '';
    }
    default:
      return '';
  }
}

/**
 * Non-secret summary of an item for list rendering and search.
 * @param {{id: string, folder_id?: string|null, revision?: number, updated_at?: string}} vi
 * @param {object} data  decrypted plaintext
 * @param {Map<string,string>} [folderNames]
 */
export function summarizeItem(vi, data, folderNames = new Map()) {
  const uris = data.type === 'login' && data.login && Array.isArray(data.login.uris) ? data.login.uris : [];
  return {
    id: vi.id,
    type: data.type,
    name: typeof data.name === 'string' ? data.name : '',
    subtitle: itemSubtitle(data),
    favorite: data.favorite === true,
    folderId: vi.folder_id || null,
    folderName: (vi.folder_id && folderNames.get(vi.folder_id)) || '',
    hasPassword: !!(data.login && data.login.password),
    hasUsername: !!(data.login && data.login.username),
    hasTotp: !!(data.login && data.login.totp),
    uris: uris
      .filter((u) => u && typeof u.uri === 'string')
      .map((u) => ({ uri: u.uri, match: u.match || 'domain' }))
      .slice(0, 20),
    updatedAt: vi.updated_at || data.updated_at || '',
  };
}

/**
 * Filter summaries by a free-text query (all whitespace-separated terms must match).
 * @param {ReturnType<typeof summarizeItem>[]} items
 * @param {string} query
 */
export function searchItems(items, query) {
  const terms = String(query || '')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  if (!terms.length) return items;
  return items.filter((it) => {
    const hay = [it.name, it.subtitle, it.folderName, ...it.uris.map((u) => u.uri)].join(' ').toLowerCase();
    return terms.every((t) => hay.includes(t));
  });
}

/**
 * Login summaries matching a page URL with their match score (url-match.js matchScore), best first.
 * A score below STRONG_MATCH means the login was saved for another host of the same site.
 * @param {ReturnType<typeof summarizeItem>[]} items
 * @param {string} url
 * @param {Record<string, number>} [lastUsed]  id -> epoch ms
 * @returns {Array<{it: ReturnType<typeof summarizeItem>, score: number}>}
 */
export function scoredMatches(items, url, lastUsed = {}) {
  const scored = [];
  for (const it of items) {
    if (it.type !== 'login') continue;
    const score = bestMatchScore(url, it.uris);
    if (score > 0) scored.push({ it, score });
  }
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      (lastUsed[b.it.id] || 0) - (lastUsed[a.it.id] || 0) ||
      Number(b.it.favorite) - Number(a.it.favorite) ||
      a.it.name.localeCompare(b.it.name),
  );
  return scored;
}

/**
 * Login summaries matching a page URL, best first.
 * @param {ReturnType<typeof summarizeItem>[]} items
 * @param {string} url
 * @param {Record<string, number>} [lastUsed]  id -> epoch ms
 */
export function matchingItems(items, url, lastUsed = {}) {
  return scoredMatches(items, url, lastUsed).map((s) => s.it);
}

/**
 * Compare two items by name for stable alphabetical lists.
 */
export function byName(a, b) {
  return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.id.localeCompare(b.id);
}
