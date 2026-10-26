// SHA-256 certificate fingerprint helpers (trust-on-first-use pinning).

/**
 * Normalize "AB:CD:..." / "abcd..." / "ab cd ..." to 64 lowercase hex chars.
 * @param {string|null|undefined} value
 * @returns {string|null}  null when not a SHA-256 fingerprint
 */
export function normalizeFingerprint(value) {
  if (typeof value !== 'string') return null;
  const hex = value.replace(/^sha-?256[:= ]*/i, '').replace(/[\s:-]/g, '').toLowerCase();
  return /^[0-9a-f]{64}$/.test(hex) ? hex : null;
}

/**
 * Human format: "AB:CD:EF:..." (uppercase, colon separated).
 * @param {string} value
 * @returns {string}
 */
export function formatFingerprint(value) {
  const hex = normalizeFingerprint(value);
  if (!hex) return '';
  return hex.toUpperCase().match(/../g).join(':');
}

/**
 * Constant-shape comparison of two fingerprints (either format).
 * @param {string|null|undefined} a
 * @param {string|null|undefined} b
 * @returns {boolean}
 */
export function fingerprintsEqual(a, b) {
  const x = normalizeFingerprint(a);
  const y = normalizeFingerprint(b);
  if (!x || !y) return false;
  let diff = 0;
  for (let i = 0; i < 64; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}
