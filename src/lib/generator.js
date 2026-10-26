// Password / passphrase generator and strength estimator (VAULT-CRYPTO.md §5, §8.2).
//
// Every draw is an unbiased integer from rejection sampling over LITTLE-ENDIAN uint32 values taken from a
// buffered byte source (CSPRNG in production). The byte consumption order matches §8.2 so the spec's
// determinism vectors can be reproduced with an injected `rng`. Option names match the canonical web copy.

import { invalidArg } from './errors.js';
import { WORDS } from './wordlist.js';

export const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
export const LOWER = 'abcdefghijklmnopqrstuvwxyz';
export const DIGITS = '0123456789';
export const SYMBOLS = '!@#$%^&*()-_=+[]{};:,.?/';
export const AMBIGUOUS = 'Il1O0';
export const MIN_LENGTH = 8;
export const MAX_LENGTH = 128;
export const MIN_WORDS = 3;
export const MAX_WORDS = 12;

export const PASSWORD_DEFAULTS = Object.freeze({ length: 20, upper: true, lower: true, digits: true, symbols: true, excludeAmbiguous: false });
export const PASSPHRASE_DEFAULTS = Object.freeze({ words: 6, separator: '-', capitalize: false, includeNumber: false });

const MAX_ATTEMPTS = 10000;

/**
 * Buffered byte source over a `(n) => Uint8Array` function (default: CSPRNG).
 * @param {(n: number) => Uint8Array} [rng]
 * @returns {{u32: () => number}}
 */
export function byteSource(rng) {
  const fill = rng || ((n) => globalThis.crypto.getRandomValues(new Uint8Array(n)));
  let buf = new Uint8Array(0);
  let pos = 0;
  return {
    u32() {
      if (pos + 4 > buf.length) {
        const fresh = fill(256);
        if (!(fresh instanceof Uint8Array) || fresh.length < 4) throw invalidArg('rng must return a Uint8Array of the requested length');
        const rest = buf.subarray(pos);
        const merged = new Uint8Array(rest.length + fresh.length);
        merged.set(rest);
        merged.set(fresh, rest.length);
        buf = merged;
        pos = 0;
      }
      const v = (buf[pos] | (buf[pos + 1] << 8) | (buf[pos + 2] << 16) | (buf[pos + 3] << 24)) >>> 0;
      pos += 4;
      return v;
    },
  };
}

/**
 * Uniform integer in [0, n): draws >= 2^32 - (2^32 mod n) are rejected (no modulo bias).
 * @param {number} n  1..2^32
 * @param {{u32: () => number}} [src]
 * @returns {number}
 */
export function randomInt(n, src = byteSource()) {
  if (!Number.isInteger(n) || n < 1 || n > 0x100000000) throw invalidArg('randomInt: n out of range');
  const limit = 0x100000000 - (0x100000000 % n);
  for (let i = 0; i < 100000; i++) {
    const x = src.u32();
    if (x < limit) return x % n;
  }
  throw new Error('randomInt: random source is not producing usable values');
}

function stripAmbiguous(set, exclude) {
  return exclude ? [...set].filter((c) => !AMBIGUOUS.includes(c)).join('') : set;
}

/**
 * Character sets enabled by `opts`, in draw order (ambiguous characters removed when requested).
 * @param {object} opts
 * @returns {string[]}
 */
export function enabledSets(opts = {}) {
  const o = { ...PASSWORD_DEFAULTS, ...opts };
  const sets = [];
  if (o.upper) sets.push(stripAmbiguous(UPPER, o.excludeAmbiguous));
  if (o.lower) sets.push(stripAmbiguous(LOWER, o.excludeAmbiguous));
  if (o.digits) sets.push(stripAmbiguous(DIGITS, o.excludeAmbiguous));
  if (o.symbols) sets.push(SYMBOLS);
  return sets;
}

/**
 * Random password, uniform over all passwords of the length that contain every enabled set.
 * @param {{length?: number, upper?: boolean, lower?: boolean, digits?: boolean, symbols?: boolean,
 *          excludeAmbiguous?: boolean, rng?: (n: number) => Uint8Array}} [opts]  `rng`: tests only
 * @returns {string}
 */
export function generatePassword(opts = {}) {
  const { length } = { ...PASSWORD_DEFAULTS, ...opts };
  if (!Number.isInteger(length) || length < MIN_LENGTH || length > MAX_LENGTH) {
    throw invalidArg(`length must be an integer in [${MIN_LENGTH}, ${MAX_LENGTH}]`);
  }
  const sets = enabledSets(opts);
  if (sets.length === 0) throw invalidArg('enable at least one character set');
  const pool = sets.join('');
  const src = byteSource(opts.rng);
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    let pw = '';
    for (let i = 0; i < length; i++) pw += pool[randomInt(pool.length, src)];
    if (sets.every((set) => [...pw].some((c) => set.includes(c)))) return pw;
  }
  throw new Error('password generation failed to satisfy constraints'); // probability ~0 for length >= 8
}

/**
 * Passphrase from the bundled word list. Draw order: one index per word, then (includeNumber) the word
 * position, then the digit.
 * @param {{words?: number, separator?: string, capitalize?: boolean, includeNumber?: boolean,
 *          rng?: (n: number) => Uint8Array, wordlist?: ReadonlyArray<string>}} [opts]
 * @returns {string}
 */
export function generatePassphrase(opts = {}) {
  const { words, separator, capitalize, includeNumber } = { ...PASSPHRASE_DEFAULTS, ...opts };
  const list = opts.wordlist || WORDS;
  if (!Number.isInteger(words) || words < MIN_WORDS || words > MAX_WORDS) {
    throw invalidArg(`words must be an integer in [${MIN_WORDS}, ${MAX_WORDS}]`);
  }
  if (typeof separator !== 'string' || separator.length > 8) throw invalidArg('separator must be a string of at most 8 characters');
  const src = byteSource(opts.rng);
  const picked = [];
  for (let i = 0; i < words; i++) picked.push(list[randomInt(list.length, src)]);
  const out = capitalize ? picked.map((w) => w[0].toUpperCase() + w.slice(1)) : picked;
  if (includeNumber) {
    const at = randomInt(words, src);
    out[at] += String(randomInt(10, src));
  }
  return out.join(separator);
}

/**
 * Entropy (bits) of a generated password with `opts` (ignores the tiny at-least-one-of-each loss).
 * @param {object} opts
 */
export function passwordEntropyBits(opts = {}) {
  const o = { ...PASSWORD_DEFAULTS, ...opts };
  const n = enabledSets(o).join('').length;
  return n > 0 ? o.length * Math.log2(n) : 0;
}

/**
 * Entropy (bits) of a generated passphrase with `opts`.
 * @param {object} opts
 */
export function passphraseEntropyBits(opts = {}) {
  const o = { ...PASSPHRASE_DEFAULTS, ...opts };
  const n = (opts.wordlist || WORDS).length;
  let bits = o.words * Math.log2(n);
  if (o.includeNumber) bits += Math.log2(10) + Math.log2(o.words);
  return bits;
}

// ---- strength estimation ------------------------------------------------------------------------

const COMMON = [
  'password', 'passw0rd', '123456', '12345678', '123456789', '1234567890', '1234567', '12345', 'qwerty',
  'qwertyuiop', 'qwerty123', 'asdfghjkl', 'zxcvbnm', 'letmein', 'welcome', 'admin', 'administrator', 'login',
  'iloveyou', 'monkey', 'dragon', 'master', 'sunshine', 'princess', 'football', 'baseball', 'superman',
  'batman', 'trustno1', 'shadow', 'starwars', 'whatever', 'freedom', 'secret', 'changeme', 'default', 'abc123',
  '111111', '000000', '654321', '666666', '121212', '123123', 'qazwsx', '1q2w3e4r', '1qaz2wsx', 'hello',
  'charlie', 'michael', 'computer', 'internet', 'summer', 'winter', 'flower', 'hunter2', 'mustang', 'access',
  'pass', 'test', 'guest', 'root', 'toor', 'password1', 'password123', 'welcome1', 'ludworks', 'azerty',
];
const COMMON_SET = new Set(COMMON);
const WORD_SET = new Set(WORDS);
const KEY_ROWS = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm', '1234567890', 'qwertzuiop', 'azertyuiop'];
const KEY_LINES = KEY_ROWS.flatMap((r) => [r, [...r].reverse().join('')]);
const LEET = { 0: 'o', 1: 'l', 3: 'e', 4: 'a', 5: 's', 7: 't', '@': 'a', $: 's', '!': 'i' };
const LABELS = ['Very weak', 'Weak', 'Fair', 'Strong', 'Very strong'];
const MAX_ANALYZED = 256;

const unleet = (s) => [...s.toLowerCase()].map((c) => LEET[c] || c).join('');

function charsetSize(pw) {
  let n = 0;
  if (/[a-z]/.test(pw)) n += 26;
  if (/[A-Z]/.test(pw)) n += 26;
  if (/[0-9]/.test(pw)) n += 10;
  if (/[\x20-\x2f\x3a-\x40\x5b-\x60\x7b-\x7e]/.test(pw)) n += 33;
  if (/[^\x00-\x7f]/.test(pw)) n += 100;
  return Math.max(n, 10);
}

function runLength(chars, i) {
  let r = 1;
  while (i + r < chars.length && chars[i + r] === chars[i]) r++;
  return r;
}

function sequenceLength(chars, i) {
  if (i + 1 >= chars.length) return 1;
  const d = chars[i + 1].codePointAt(0) - chars[i].codePointAt(0);
  if (d !== 1 && d !== -1) return 1;
  let n = 2;
  while (i + n < chars.length && chars[i + n].codePointAt(0) - chars[i + n - 1].codePointAt(0) === d) n++;
  return n;
}

function keyboardRun(chars, i) {
  let best = 0;
  for (let len = 3; i + len <= chars.length && len <= 12; len++) {
    const seg = chars.slice(i, i + len).join('').toLowerCase();
    if (!KEY_LINES.some((line) => line.includes(seg))) break;
    best = len;
  }
  return best;
}

/**
 * Pattern-aware entropy estimate: common passwords, dictionary words, repeats, sequences, keyboard runs
 * and years are charged as patterns; everything else costs log2(charset) per character.
 * @param {string} password
 * @returns {{score: 0|1|2|3|4, entropyBits: number, feedback: string[], label: string}}
 */
export function estimateStrength(password) {
  const pw = typeof password === 'string' ? password : '';
  if (!pw) return { score: 0, entropyBits: 0, feedback: ['Enter a password.'], label: 'Empty' };
  const lower = pw.toLowerCase();
  const stripped = lower.replace(/[^a-z]+$/, '');
  if (COMMON_SET.has(lower) || COMMON_SET.has(unleet(pw)) || (stripped.length >= 4 && COMMON_SET.has(unleet(stripped)) && pw.length - stripped.length <= 4)) {
    return { score: 0, entropyBits: 4, feedback: ['This is one of the most common passwords.'], label: LABELS[0] };
  }
  const feedback = new Set();
  const chars = [...pw];
  const perChar = Math.log2(charsetSize(pw));
  let bits = 0;
  let i = 0;
  while (i < chars.length) {
    let step = null; // [length, cost]
    if (i >= MAX_ANALYZED) step = [chars.length - i, perChar * (chars.length - i)];
    if (!step) {
      for (let len = Math.min(9, chars.length - i); len >= 4; len--) {
        const seg = chars.slice(i, i + len).join('');
        const plain = unleet(seg);
        if (WORD_SET.has(plain) || COMMON_SET.has(plain)) {
          let cost = Math.log2(WORDS.length);
          if (seg !== seg.toLowerCase()) cost += seg[0] === seg[0].toUpperCase() && seg.slice(1) === seg.slice(1).toLowerCase() ? 1 : 2;
          if (plain !== seg.toLowerCase()) cost += 1;
          step = [len, cost];
          feedback.add('Single dictionary words are easy to guess; combine several random words or use random characters.');
          break;
        }
      }
    }
    if (!step) {
      const r = runLength(chars, i);
      if (r >= 3) {
        step = [r, perChar + Math.log2(r)];
        feedback.add('Avoid repeated characters.');
      }
    }
    if (!step && /^(19|20)\d\d$/.test(chars.slice(i, i + 4).join(''))) {
      step = [4, 7];
      feedback.add('Years and dates are easy to guess.');
    }
    if (!step) {
      const seq = sequenceLength(chars, i);
      const kb = keyboardRun(chars, i);
      if (seq >= 3 && seq >= kb) {
        step = [seq, Math.log2(26) + Math.log2(seq)];
        feedback.add('Avoid sequences like “abc” or “123”.');
      } else if (kb >= 4) {
        step = [kb, Math.log2(12) + Math.log2(kb) + 1];
        feedback.add('Avoid keyboard patterns like “qwerty”.');
      }
    }
    if (!step) step = [1, perChar];
    bits += step[1];
    i += step[0];
  }
  const rep = pw.length <= MAX_ANALYZED ? /^(.+?)\1+$/.exec(pw) : null;
  if (rep) {
    bits = Math.min(bits, (bits * rep[1].length) / pw.length + Math.log2(pw.length / rep[1].length));
    feedback.add('Avoid repeating the same pattern.');
  }
  bits = Math.round(bits * 10) / 10;
  const score = bits < 28 ? 0 : bits < 40 ? 1 : bits < 52 ? 2 : bits < 64 ? 3 : 4;
  if (score < 3) {
    if (chars.length < 12) feedback.add('Use at least 12 characters, or a passphrase of 5+ words.');
    if (charsetSize(pw) <= 36) feedback.add('Add uppercase letters, digits or symbols.');
  }
  return { score, entropyBits: bits, feedback: [...feedback], label: LABELS[score] };
}

/** Score (0–4) for a known entropy in bits, using the estimator's thresholds. */
export function scoreForBits(bits) {
  return bits < 28 ? 0 : bits < 40 ? 1 : bits < 52 ? 2 : bits < 64 ? 3 : 4;
}

export const STRENGTH_LABELS = Object.freeze(LABELS);
