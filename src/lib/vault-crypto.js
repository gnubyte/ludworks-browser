// Ludworks vault end-to-end encryption, v1 (ludworks-server docs/spec/VAULT-CRYPTO.md §1–§2, §7, §8.3).
//
// Uses only WebCrypto + standard web globals (TextEncoder, atob/btoa), so it runs unchanged in extension
// pages, MV3 service workers, Firefox event pages and Node >= 20 (tests). Exported names and error codes
// match the canonical web copy (web/assets/js/lib/vault/crypto.js) so the two can be unified.

import { VaultError, invalidArg } from './errors.js';

export { VaultError } from './errors.js';

const te = new TextEncoder();
const td = new TextDecoder('utf-8', { fatal: true });

export const KDF_PBKDF2 = 'pbkdf2-sha256';
export const DEFAULT_ITERATIONS = 600000;
/** The server rejects lower counts; clients refuse to create or unlock with fewer too (§8.3). */
export const MIN_ITERATIONS = 600000;
export const MAX_ITERATIONS = 10000000;
export const SALT_BYTES = 16;
export const KEY_BYTES = 32;
export const NONCE_BYTES = 12;

const WRAP_INFO = 'ludworks/vault/wrap/v1';
export const AAD_KEY = 'ludworks/vault/key/v1';
export const AAD_ITEM_PREFIX = 'ludworks/vault/item/v1:';
export const AAD_FOLDER_PREFIX = 'ludworks/vault/folder/v1:';
const SEAL_VERSION = 'v1';
const TAG_BYTES = 16;
const MAX_SEALED_CHARS = 8 * 1024 * 1024;

// Lowercase hyphenated UUID; ids are bound into the AAD, so anything else is refused outright.
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const B64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function subtle() {
  const s = globalThis.crypto && globalThis.crypto.subtle;
  if (!s) throw new VaultError('unsupported', 'WebCrypto is not available in this context');
  return s;
}

function asBytes(v, what = 'value') {
  if (v instanceof Uint8Array) return v;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  throw invalidArg(`${what} must be a Uint8Array`);
}

/**
 * Standard base64 (RFC 4648 §4) with padding.
 * @param {Uint8Array|ArrayBuffer} bytes
 * @returns {string}
 */
export function b64encode(bytes) {
  const u8 = asBytes(bytes, 'b64encode input');
  let bin = '';
  for (let i = 0; i < u8.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

/**
 * Strict standard base64 decoder (padding required; no whitespace or URL-safe alphabet).
 * @param {string} str
 * @returns {Uint8Array}
 */
export function b64decode(str) {
  if (typeof str !== 'string' || str.length % 4 !== 0 || !B64_RE.test(str)) {
    throw new VaultError('malformed', 'invalid base64');
  }
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Cryptographically secure random bytes.
 * @param {number} n
 * @returns {Uint8Array}
 */
export function randomBytes(n) {
  if (!Number.isInteger(n) || n < 0) throw invalidArg('randomBytes: invalid length');
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i += 65536) {
    globalThis.crypto.getRandomValues(out.subarray(i, Math.min(n, i + 65536)));
  }
  return out;
}

/**
 * Random UUID v4, lowercase with hyphens (client-generated item/folder ids).
 * @returns {string}
 */
export function uuid() {
  if (typeof globalThis.crypto.randomUUID === 'function') return globalThis.crypto.randomUUID();
  const b = randomBytes(16);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/**
 * Is `id` an acceptable vault item/folder id (lowercase hyphenated UUID)?
 * @param {unknown} id
 * @returns {boolean}
 */
export function isValidId(id) {
  return typeof id === 'string' && ID_RE.test(id);
}

function checkId(id) {
  if (!isValidId(id)) throw invalidArg('id must be a lowercase hyphenated UUID');
}

function checkIterations(iterations, min) {
  if (!Number.isInteger(iterations) || iterations < min || iterations > MAX_ITERATIONS) {
    throw invalidArg(`kdf_iterations must be an integer in [${min}, ${MAX_ITERATIONS}]`);
  }
}

function checkPassword(password) {
  if (typeof password !== 'string' || password.length === 0) throw invalidArg('master password must be a non-empty string');
}

/**
 * master_key = PBKDF2-HMAC-SHA256(UTF-8(NFC(password)), salt, iterations, 32).
 * Accepts any iteration count in [1, MAX_ITERATIONS] so known-answer tests can use small counts;
 * the vault-level functions enforce MIN_ITERATIONS.
 * @param {string} password
 * @param {Uint8Array} saltBytes
 * @param {number} iterations
 * @returns {Promise<Uint8Array>} 32 bytes
 */
export async function deriveMasterKey(password, saltBytes, iterations) {
  if (typeof password !== 'string') throw invalidArg('password must be a string');
  const salt = asBytes(saltBytes, 'salt');
  checkIterations(iterations, 1);
  const pw = te.encode(password.normalize('NFC'));
  const base = await subtle().importKey('raw', pw, 'PBKDF2', false, ['deriveBits']);
  pw.fill(0);
  const bits = await subtle().deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, base, KEY_BYTES * 8);
  return new Uint8Array(bits);
}

function hkdfParams() {
  // Empty salt == RFC 5869 default salt of HashLen zero bytes (HMAC zero-pads short keys).
  return { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: te.encode(WRAP_INFO) };
}

/**
 * wrap_key = HKDF-SHA256(IKM = master_key, salt = empty, info = "ludworks/vault/wrap/v1", L = 32),
 * returned as a NON-EXTRACTABLE AES-256-GCM CryptoKey.
 * @param {Uint8Array} masterKeyBytes
 * @returns {Promise<CryptoKey>}
 */
export async function deriveWrapKey(masterKeyBytes) {
  const ikm = asBytes(masterKeyBytes, 'master key');
  if (ikm.length !== KEY_BYTES) throw invalidArg('master key must be 32 bytes');
  const base = await subtle().importKey('raw', ikm, 'HKDF', false, ['deriveKey']);
  return subtle().deriveKey(hkdfParams(), base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

/** Test/vector helper: raw wrap_key bytes (never used by the extension itself). */
async function deriveWrapKeyBytes(masterKeyBytes) {
  const base = await subtle().importKey('raw', asBytes(masterKeyBytes), 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await subtle().deriveBits(hkdfParams(), base, KEY_BYTES * 8));
}

/**
 * Import 32 raw bytes as a non-extractable AES-256-GCM key. Callers that seal/open many records import
 * the vault key once and pass the CryptoKey around.
 * @param {Uint8Array} bytes
 * @returns {Promise<CryptoKey>}
 */
export async function importAesKey(bytes) {
  const raw = asBytes(bytes, 'key');
  if (raw.length !== KEY_BYTES) throw invalidArg('AES key must be 32 bytes');
  return subtle().importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

async function toKey(keyOrBytes) {
  if (typeof CryptoKey !== 'undefined' && keyOrBytes instanceof CryptoKey) return keyOrBytes;
  if (keyOrBytes && typeof keyOrBytes === 'object' && keyOrBytes.type === 'secret' && keyOrBytes.algorithm) {
    return keyOrBytes; // CryptoKey from another realm
  }
  return importAesKey(keyOrBytes);
}

async function sealWithNonce(keyOrBytes, plaintext, aad, nonce) {
  if (typeof aad !== 'string') throw invalidArg('aad must be a string');
  const iv = asBytes(nonce, 'nonce');
  if (iv.length !== NONCE_BYTES) throw invalidArg('nonce must be 12 bytes');
  const key = await toKey(keyOrBytes);
  const pt = typeof plaintext === 'string' ? te.encode(plaintext) : asBytes(plaintext, 'plaintext');
  const ct = await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: te.encode(aad), tagLength: TAG_BYTES * 8 }, key, pt);
  return `${SEAL_VERSION}.${b64encode(iv)}.${b64encode(new Uint8Array(ct))}`;
}

/**
 * Seal(key, plaintext, aad) = "v1." + b64(nonce) + "." + b64(ciphertext || tag)  (AES-256-GCM, random nonce)
 * @param {CryptoKey|Uint8Array} keyOrBytes
 * @param {Uint8Array|string} plaintextBytes  strings are UTF-8 encoded
 * @param {string} aad
 * @returns {Promise<string>}
 */
export async function seal(keyOrBytes, plaintextBytes, aad) {
  return sealWithNonce(keyOrBytes, plaintextBytes, aad, randomBytes(NONCE_BYTES));
}

/**
 * Open a sealed string. Throws VaultError 'malformed', 'unsupported_version' or 'decrypt_failed'.
 * @param {CryptoKey|Uint8Array} keyOrBytes
 * @param {string} sealed
 * @param {string} aad
 * @returns {Promise<Uint8Array>}
 */
export async function open(keyOrBytes, sealed, aad) {
  if (typeof sealed !== 'string' || sealed.length > MAX_SEALED_CHARS) throw new VaultError('malformed', 'sealed value must be a string');
  if (typeof aad !== 'string') throw invalidArg('aad must be a string');
  const parts = sealed.split('.');
  if (parts.length !== 3) throw new VaultError('malformed', 'sealed value must have 3 parts');
  if (parts[0] !== SEAL_VERSION) throw new VaultError('unsupported_version', `unknown sealed version "${parts[0].slice(0, 16)}"`);
  const iv = b64decode(parts[1]);
  const ct = b64decode(parts[2]);
  if (iv.length !== NONCE_BYTES || ct.length < TAG_BYTES) throw new VaultError('malformed', 'sealed value has bad lengths');
  const key = await toKey(keyOrBytes);
  try {
    const pt = await subtle().decrypt({ name: 'AES-GCM', iv, additionalData: te.encode(aad), tagLength: TAG_BYTES * 8 }, key, ct);
    return new Uint8Array(pt);
  } catch (e) {
    throw new VaultError('decrypt_failed', 'authentication failed (wrong key or tampered data)', { cause: e });
  }
}

async function wrapParams(vaultKey, password, iterations, salt) {
  const master = await deriveMasterKey(password, salt, iterations);
  const wrapKey = await deriveWrapKey(master);
  master.fill(0);
  const wrapped = await seal(wrapKey, vaultKey, AAD_KEY);
  return { kdf: KDF_PBKDF2, kdf_iterations: iterations, kdf_salt: b64encode(salt), wrapped_key: wrapped };
}

/**
 * Create a brand-new vault: random 32-byte vault key wrapped under the master password.
 * @param {string} password
 * @param {{iterations?: number}} [opts]
 * @returns {Promise<{params: {kdf: string, kdf_iterations: number, kdf_salt: string, wrapped_key: string}, vaultKey: Uint8Array}>}
 *   `params` is exactly the body for POST /api/v1/vault/init.
 */
export async function createVault(password, { iterations = DEFAULT_ITERATIONS } = {}) {
  checkPassword(password);
  checkIterations(iterations, MIN_ITERATIONS);
  const vaultKey = randomBytes(KEY_BYTES);
  const params = await wrapParams(vaultKey, password, iterations, randomBytes(SALT_BYTES));
  return { params, vaultKey };
}

/**
 * Unlock: derive wrap_key and open wrapped_key. Wrong password -> VaultError('bad_password').
 * Weak or odd parameters are refused BEFORE deriving (§8.3): a malicious server must not be able to make
 * a client derive (and later re-wrap) with a downgraded KDF.
 * @param {string} password
 * @param {{kdf: string, kdf_iterations: number, kdf_salt: string, wrapped_key: string}} params  GET /vault
 * @returns {Promise<Uint8Array>} the 32-byte vault key
 */
export async function unlockVault(password, params) {
  if (typeof password !== 'string') throw invalidArg('password must be a string');
  if (!params || typeof params !== 'object' || params.kdf !== KDF_PBKDF2) throw new VaultError('unsupported', 'unsupported vault kdf');
  checkIterations(params.kdf_iterations, MIN_ITERATIONS);
  const salt = b64decode(String(params.kdf_salt ?? ''));
  if (salt.length < SALT_BYTES || salt.length > 64) throw new VaultError('malformed', 'kdf_salt must be 16-64 bytes');
  if (typeof params.wrapped_key !== 'string') throw new VaultError('malformed', 'missing wrapped key');
  const master = await deriveMasterKey(password, salt, params.kdf_iterations);
  const wrapKey = await deriveWrapKey(master);
  master.fill(0);
  let vaultKey;
  try {
    vaultKey = await open(wrapKey, params.wrapped_key, AAD_KEY);
  } catch (e) {
    if (e instanceof VaultError && e.code === 'decrypt_failed') throw new VaultError('bad_password', 'wrong master password', { cause: e });
    throw e;
  }
  if (vaultKey.length !== KEY_BYTES) {
    vaultKey.fill(0);
    throw new VaultError('malformed', 'unwrapped vault key has the wrong length');
  }
  return vaultKey;
}

/**
 * Change master password: fresh salt, same vault key. Send the result plus `previous_wrapped_key` to
 * PUT /api/v1/vault/key.
 * @param {Uint8Array} vaultKey
 * @param {string} newPassword
 * @param {{iterations?: number}} [opts]
 * @returns {Promise<{kdf: string, kdf_iterations: number, kdf_salt: string, wrapped_key: string}>}
 */
export async function rewrapVaultKey(vaultKey, newPassword, { iterations = DEFAULT_ITERATIONS } = {}) {
  const vk = asBytes(vaultKey, 'vault key');
  if (vk.length !== KEY_BYTES) throw invalidArg('vault key must be 32 bytes');
  checkPassword(newPassword);
  checkIterations(iterations, MIN_ITERATIONS);
  return wrapParams(vk, newPassword, iterations, randomBytes(SALT_BYTES));
}

function parseJson(bytes) {
  try {
    return JSON.parse(td.decode(bytes));
  } catch (e) {
    throw new VaultError('malformed', 'decrypted payload is not valid JSON', { cause: e });
  }
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Encrypt an item's plaintext object (§3), bound to its id.
 * @param {CryptoKey|Uint8Array} vaultKey
 * @param {string} id  client UUID
 * @param {object} obj
 * @returns {Promise<string>} sealed `data`
 */
export async function encryptItem(vaultKey, id, obj) {
  checkId(id);
  if (!isPlainObject(obj)) throw invalidArg('item must be an object');
  return seal(vaultKey, te.encode(JSON.stringify(obj)), AAD_ITEM_PREFIX + id);
}

/**
 * Decrypt an item's sealed `data` -> plaintext object.
 * @param {CryptoKey|Uint8Array} vaultKey
 * @param {string} id
 * @param {string} data
 * @returns {Promise<object>}
 */
export async function decryptItem(vaultKey, id, data) {
  checkId(id);
  const obj = parseJson(await open(vaultKey, data, AAD_ITEM_PREFIX + id));
  if (!isPlainObject(obj)) throw new VaultError('malformed', 'item payload is not an object');
  return obj;
}

/**
 * Encrypt a folder name (plaintext JSON {"name": ...}) bound to the folder id.
 * @param {CryptoKey|Uint8Array} vaultKey
 * @param {string} id
 * @param {string} name
 * @returns {Promise<string>}
 */
export async function encryptFolder(vaultKey, id, name) {
  checkId(id);
  if (typeof name !== 'string') throw invalidArg('folder name must be a string');
  return seal(vaultKey, te.encode(JSON.stringify({ name })), AAD_FOLDER_PREFIX + id);
}

/**
 * Decrypt a folder's sealed name -> string.
 * @param {CryptoKey|Uint8Array} vaultKey
 * @param {string} id
 * @param {string} data
 * @returns {Promise<string>}
 */
export async function decryptFolder(vaultKey, id, data) {
  checkId(id);
  const obj = parseJson(await open(vaultKey, data, AAD_FOLDER_PREFIX + id));
  if (!isPlainObject(obj) || typeof obj.name !== 'string') throw new VaultError('malformed', 'folder payload has no name');
  return obj.name;
}

/**
 * Test-only hooks (same as the canonical web copy). sealWithNonce exists solely to reproduce
 * deterministic test vectors; reusing a nonce with the same key breaks AES-GCM, so application code
 * must never call it.
 */
export const __testing = Object.freeze({ sealWithNonce, deriveWrapKeyBytes });
