// Bitwarden "password-protected" (file password) export crypto on Node's crypto module.
//
//   key   = kdfType 0: PBKDF2-SHA256(UTF-8 password, UTF-8 salt string, kdfIterations, 32)
//           kdfType 1: Argon2id(UTF-8 password, SHA-256(UTF-8 salt string), t=kdfIterations, m=kdfMemory MiB,
//                      p=kdfParallelism, 32)            — in a worker thread (never blocks the main process)
//   encKey = HKDF-Expand(key, "enc", 32), macKey = HKDF-Expand(key, "mac", 32)   (SHA-256, single block)
//   EncString type 2 = "2." b64(iv) "|" b64(AES-256-CBC(encKey, iv, pt)) "|" b64(HMAC-SHA256(macKey, iv‖ct))
//   encKeyValidation_DO_NOT_EDIT = EncString(random GUID) — the password check; data = EncString(plain JSON export)
//
// Account-restricted exports ("encrypted": true without "passwordProtected") are sealed with the Bitwarden
// account / organisation key and cannot be opened outside Bitwarden.

import { pbkdf2, createHash, createHmac, createCipheriv, createDecipheriv, randomBytes, timingSafeEqual, randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { promisify } from 'node:util';

const pbkdf2Async = promisify(pbkdf2);

export function bwError(code, message) {
  return Object.assign(new Error(message), { code });
}

// Bounds: Bitwarden's own import limits (password-protected-kdf-config.ts), slightly wider where harmless.
const PBKDF2_MIN = 5000;
const PBKDF2_MAX = 10_000_000;
const ARGON2 = { iterations: [1, 10], memory: [16, 1024], parallelism: [1, 16] };

/**
 * Validate the KDF settings of a password-protected export before anything is derived (they come from the
 * file, so they are attacker-controlled: an unbounded Argon2 memory would be a denial of service).
 * @returns {{kdfType: 0|1, kdfIterations: number, kdfMemory: number|null, kdfParallelism: number|null}}
 */
export function checkKdf(doc) {
  const type = doc.kdfType === undefined || doc.kdfType === null ? 0 : doc.kdfType;
  const int = (v, [lo, hi]) => Number.isInteger(v) && v >= lo && v <= hi;
  if (type === 0) {
    if (!int(doc.kdfIterations, [PBKDF2_MIN, PBKDF2_MAX])) throw bwError('unsupported_kdf', `This export uses PBKDF2 with ${doc.kdfIterations} iterations, outside the supported range (${PBKDF2_MIN}–${PBKDF2_MAX}).`);
    return { kdfType: 0, kdfIterations: doc.kdfIterations, kdfMemory: null, kdfParallelism: null };
  }
  if (type === 1) {
    if (!int(doc.kdfIterations, ARGON2.iterations) || !int(doc.kdfMemory, ARGON2.memory) || !int(doc.kdfParallelism, ARGON2.parallelism)) {
      throw bwError('unsupported_kdf', 'This export uses Argon2id settings outside the supported range (iterations 1–10, memory 16–1024 MiB, parallelism 1–16).');
    }
    return { kdfType: 1, kdfIterations: doc.kdfIterations, kdfMemory: doc.kdfMemory, kdfParallelism: doc.kdfParallelism };
  }
  throw bwError('unsupported_kdf', `This export uses an unknown key derivation (kdfType ${JSON.stringify(type)}).`);
}

function freshCopy(buf) {
  const u = new Uint8Array(buf.length);
  u.set(buf);
  return u;
}

/** Argon2id in a worker thread (falls back to the vendored async implementation, which yields every 40 ms). */
async function argon2id(pw, salt, t, mMiB, p) {
  const pwCopy = freshCopy(pw);
  const saltCopy = freshCopy(salt);
  try {
    return await new Promise((resolve, reject) => {
      let worker;
      try {
        worker = new Worker(new URL('./kdf-worker.js', import.meta.url), {
          workerData: { password: pwCopy.buffer, salt: saltCopy.buffer, iterations: t, memoryKiB: mMiB * 1024, parallelism: p },
          transferList: [pwCopy.buffer, saltCopy.buffer],
        });
      } catch (e) {
        reject(Object.assign(e, { noWorker: true }));
        return;
      }
      let settled = false;
      const done = (fn, v) => {
        if (settled) return;
        settled = true;
        fn(v);
        worker.terminate();
      };
      worker.once('message', (m) => (m && m.ok ? done(resolve, Buffer.from(m.key)) : done(reject, bwError('kdf_failed', `Key derivation failed: ${(m && m.message) || 'unknown error'}`))));
      worker.once('error', (e) => done(reject, bwError('kdf_failed', `Key derivation failed: ${e.message}`)));
      worker.once('exit', (code) => done(reject, bwError('kdf_failed', `Key derivation stopped (exit code ${code}).`)));
    });
  } catch (e) {
    if (!e || !e.noWorker) throw e;
    const { argon2 } = await import('../../vendor/vault/argon2.js');
    const out = await argon2({ password: pw, salt, iterations: t, memory: mMiB * 1024, parallelism: p, hashLength: 32, type: 'argon2id', version: 0x13 });
    const key = Buffer.from(out.subarray(0, 32));
    out.fill(0);
    return key;
  } finally {
    if (!pwCopy.buffer.detached && pwCopy.byteLength) pwCopy.fill(0); // transferred to the worker otherwise
  }
}

/**
 * Derive the export's encryption and MAC keys. Call keys.wipe() when done.
 * @param {string} password
 * @param {string} saltString  the export's "salt" (base64 text, used as its UTF-8 bytes)
 * @param {{kdfType:0|1, kdfIterations:number, kdfMemory?:number|null, kdfParallelism?:number|null}} kdf
 */
export async function deriveExportKeys(password, saltString, kdf) {
  const k = checkKdf(kdf);
  const pw = Buffer.from(String(password), 'utf8');
  const salt = Buffer.from(String(saltString), 'utf8');
  let master;
  try {
    master = k.kdfType === 0 ? await pbkdf2Async(pw, salt, k.kdfIterations, 32, 'sha256') : await argon2id(pw, createHash('sha256').update(salt).digest(), k.kdfIterations, k.kdfMemory, k.kdfParallelism);
  } finally {
    pw.fill(0);
  }
  const encKey = createHmac('sha256', master).update('enc\x01').digest();
  const macKey = createHmac('sha256', master).update('mac\x01').digest();
  master.fill(0);
  return {
    encKey,
    macKey,
    wipe() {
      encKey.fill(0);
      macKey.fill(0);
    },
  };
}

const B64 = /^[A-Za-z0-9+/]*={0,2}$/;
function b64(s, what) {
  if (typeof s !== 'string' || !B64.test(s)) throw bwError('malformed', `The export's ${what} is not valid base64.`);
  return Buffer.from(s, 'base64');
}

/** Split an EncString. Only type 2 (AES-256-CBC + HMAC-SHA256) is accepted. */
export function parseEncString(str, what = 'encrypted data') {
  if (typeof str !== 'string' || !str) throw bwError('malformed', `The export's ${what} is missing.`);
  let s = str.trim();
  let type = 2;
  const dot = s.indexOf('.');
  if (dot > 0 && dot < 3 && /^\d+$/.test(s.slice(0, dot))) {
    type = Number(s.slice(0, dot));
    s = s.slice(dot + 1);
  }
  const parts = s.split('|');
  if (type !== 2) throw bwError('unsupported', `The export's ${what} uses Bitwarden encryption type ${type}; only type 2 (AES-256-CBC with HMAC-SHA256) is supported.`);
  if (parts.length !== 3) throw bwError('malformed', `The export's ${what} is not a valid Bitwarden EncString.`);
  const [iv, ct, mac] = parts.map((p) => b64(p, what));
  if (iv.length !== 16 || mac.length !== 32 || !ct.length || ct.length % 16) throw bwError('malformed', `The export's ${what} has invalid lengths.`);
  return { iv, ct, mac };
}

/** Decrypt a type-2 EncString → Buffer (caller wipes). MAC mismatch → code 'decrypt_failed'. */
export function decryptEncString(str, keys, what) {
  const { iv, ct, mac } = parseEncString(str, what);
  const want = createHmac('sha256', keys.macKey).update(iv).update(ct).digest();
  if (!timingSafeEqual(want, mac)) throw bwError('decrypt_failed', 'The data does not authenticate with this password.');
  try {
    const d = createDecipheriv('aes-256-cbc', keys.encKey, iv);
    return Buffer.concat([d.update(ct), d.final()]);
  } catch {
    throw bwError('decrypt_failed', 'The data could not be decrypted.');
  }
}

/** Encrypt → type-2 EncString. */
export function encryptEncString(plain, keys) {
  const iv = randomBytes(16);
  const c = createCipheriv('aes-256-cbc', keys.encKey, iv);
  const ct = Buffer.concat([c.update(plain), c.final()]);
  const mac = createHmac('sha256', keys.macKey).update(iv).update(ct).digest();
  return `2.${iv.toString('base64')}|${ct.toString('base64')}|${mac.toString('base64')}`;
}

/** Classify a parsed Bitwarden JSON document. */
export function encryptionOf(doc) {
  if (!doc || typeof doc !== 'object' || doc.encrypted !== true) return 'none';
  return doc.passwordProtected === true ? 'password' : 'account';
}

export const ACCOUNT_RESTRICTED_MESSAGE =
  'This is an account-restricted encrypted Bitwarden export. It is sealed with the encryption key of the Bitwarden account (or organization) that made it, so only Bitwarden signed in to that account can read it. In Bitwarden, export again and choose “Password-protected” (with a file password) or the unencrypted .json / .zip format.';

/**
 * Decrypt a password-protected export → the inner (plain JSON export) text.
 * Errors: password_required, bad_password, unsupported_kdf, malformed, account_restricted.
 */
export async function decryptPasswordProtected(doc, password) {
  const enc = encryptionOf(doc);
  if (enc === 'account') throw bwError('account_restricted', ACCOUNT_RESTRICTED_MESSAGE);
  if (enc !== 'password') throw bwError('malformed', 'This export is not password-protected.');
  const kdf = checkKdf(doc);
  if (typeof password !== 'string' || password === '') throw bwError('password_required', 'This export is protected with a file password. Enter the password that was set when it was exported.');
  if (typeof doc.salt !== 'string' || !doc.salt) throw bwError('malformed', 'The password-protected export has no salt.');
  parseEncString(doc.encKeyValidation_DO_NOT_EDIT, 'password check');
  parseEncString(doc.data, 'data');
  const keys = await deriveExportKeys(password, doc.salt, kdf);
  try {
    let check;
    try {
      check = decryptEncString(doc.encKeyValidation_DO_NOT_EDIT, keys, 'password check');
    } catch (e) {
      if (e.code === 'decrypt_failed') throw bwError('bad_password', 'Wrong file password for this export.');
      throw e;
    }
    check.fill(0);
    const inner = decryptEncString(doc.data, keys, 'data');
    const text = inner.toString('utf8');
    inner.fill(0);
    return text;
  } finally {
    keys.wipe();
  }
}

/**
 * Wrap a plain Bitwarden JSON export text in Bitwarden's password-protected format.
 * @param {string} clearText
 * @param {string} password
 * @param {{kdfType?: 0|1, kdfIterations?: number, kdfMemory?: number, kdfParallelism?: number}} [opts]
 */
export async function encryptPasswordProtected(clearText, password, opts = {}) {
  if (typeof password !== 'string' || !password) throw bwError('password_required', 'A file password is required.');
  const kdf =
    (opts.kdfType ?? 0) === 1
      ? checkKdf({ kdfType: 1, kdfIterations: opts.kdfIterations ?? 3, kdfMemory: opts.kdfMemory ?? 64, kdfParallelism: opts.kdfParallelism ?? 4 })
      : checkKdf({ kdfType: 0, kdfIterations: opts.kdfIterations ?? 600000 });
  const salt = randomBytes(16).toString('base64');
  const keys = await deriveExportKeys(password, salt, kdf);
  try {
    const plain = Buffer.from(clearText, 'utf8');
    const out = {
      encrypted: true,
      passwordProtected: true,
      salt,
      kdfType: kdf.kdfType,
      kdfIterations: kdf.kdfIterations,
      kdfMemory: kdf.kdfMemory,
      kdfParallelism: kdf.kdfParallelism,
      encKeyValidation_DO_NOT_EDIT: encryptEncString(Buffer.from(randomUUID(), 'utf8'), keys),
      data: encryptEncString(plain, keys),
    };
    plain.fill(0);
    return JSON.stringify(out, null, 2);
  } finally {
    keys.wipe();
  }
}
