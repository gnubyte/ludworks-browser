import test from 'node:test';
import assert from 'node:assert/strict';

import {
  UPPER,
  LOWER,
  DIGITS,
  SYMBOLS,
  AMBIGUOUS,
  byteSource,
  randomInt,
  generatePassword,
  generatePassphrase,
  estimateStrength,
  passwordEntropyBits,
  passphraseEntropyBits,
  scoreForBits,
} from '../src/lib/generator.js';
import { WORDS } from '../src/lib/wordlist.js';

const code = (c) => (e) => e && e.code === c;

test('word list: >= 2048 unique, sorted, lowercase words of 3-9 letters', () => {
  assert.ok(WORDS.length >= 2048, `only ${WORDS.length} words`);
  assert.equal(new Set(WORDS).size, WORDS.length, 'duplicates present');
  for (const w of WORDS) assert.match(w, /^[a-z]{3,9}$/);
  assert.deepEqual([...WORDS], [...WORDS].sort(), 'sorted');
  assert.ok(Object.isFrozen(WORDS));
});

test('byteSource reads little-endian uint32 values from a buffered stream', () => {
  const calls = [];
  const src = byteSource((n) => {
    calls.push(n);
    const b = new Uint8Array(n);
    b.set([1, 0, 0, 0, 0xff, 0xff, 0xff, 0xff]);
    return b;
  });
  assert.equal(src.u32(), 1);
  assert.equal(src.u32(), 0xffffffff);
  assert.equal(src.u32(), 0);
  assert.deepEqual(calls, [256]);
});

test('randomInt rejects biased draws (limit = 2^32 - 2^32 mod n)', () => {
  // n = 3: limit = 0xFFFFFFFF, so 0xFFFFFFFF must be rejected and the next draw used.
  const draws = [0xffffffff, 5];
  const src = { u32: () => draws.shift() };
  assert.equal(randomInt(3, src), 2);
  assert.equal(draws.length, 0);
  assert.equal(randomInt(1, { u32: () => 123 }), 0);
  assert.throws(() => randomInt(0), code('invalid_argument'));
  assert.throws(() => randomInt(2 ** 32 + 1), code('invalid_argument'));
  assert.throws(() => randomInt(3, { u32: () => 0xffffffff }), /not producing/);
});

test('randomInt is uniform (chi-square sanity check)', () => {
  const n = 86;
  const samples = 86 * 600;
  const counts = new Array(n).fill(0);
  const src = byteSource();
  for (let i = 0; i < samples; i++) counts[randomInt(n, src)]++;
  const expected = samples / n;
  const chi2 = counts.reduce((s, c) => s + (c - expected) ** 2 / expected, 0);
  assert.ok(chi2 < 150, `chi2=${chi2.toFixed(1)} (df=85)`);
});

test('generatePassword honours length and sets, includes every enabled set', () => {
  for (let i = 0; i < 300; i++) {
    const pw = generatePassword({ length: 8 });
    assert.equal(pw.length, 8);
    assert.ok(/[A-Z]/.test(pw) && /[a-z]/.test(pw) && /[0-9]/.test(pw), pw);
    assert.ok([...pw].some((c) => SYMBOLS.includes(c)), pw);
  }
  assert.match(generatePassword({ length: 30, upper: false, lower: false, symbols: false }), /^[0-9]{30}$/);
  const noAmb = generatePassword({ length: 128, excludeAmbiguous: true });
  assert.equal(noAmb.length, 128);
  for (const c of AMBIGUOUS) assert.ok(!noAmb.includes(c));
  const allowed = new Set(UPPER + LOWER + DIGITS + SYMBOLS);
  for (const c of generatePassword({ length: 128 })) assert.ok(allowed.has(c));
  assert.equal(generatePassword().length, 20);
  assert.equal(SYMBOLS, '!@#$%^&*()-_=+[]{};:,.?/');
});

test('generatePassword rejects invalid options', () => {
  assert.throws(() => generatePassword({ length: 7 }), code('invalid_argument'));
  assert.throws(() => generatePassword({ length: 129 }), code('invalid_argument'));
  assert.throws(() => generatePassword({ length: 12.5 }), code('invalid_argument'));
  assert.throws(() => generatePassword({ upper: false, lower: false, digits: false, symbols: false }), code('invalid_argument'));
});

test('generated characters are evenly distributed', () => {
  const counts = new Map();
  let total = 0;
  for (let i = 0; i < 400; i++) {
    for (const c of generatePassword({ length: 64, symbols: false })) {
      counts.set(c, (counts.get(c) || 0) + 1);
      total++;
    }
  }
  assert.equal(counts.size, 62);
  const expected = total / 62;
  for (const [c, n] of counts) assert.ok(Math.abs(n - expected) / expected < 0.25, `${c}: ${n} vs ${expected}`);
});

test('generatePassphrase options', () => {
  const words = new Set(WORDS);
  const parts = generatePassphrase({ words: 5, separator: '.' }).split('.');
  assert.equal(parts.length, 5);
  for (const w of parts) assert.ok(words.has(w), w);
  for (const w of generatePassphrase({ words: 4, separator: ' ', capitalize: true }).split(' ')) assert.match(w, /^[A-Z][a-z]+$/);
  for (let i = 0; i < 50; i++) {
    const tokens = generatePassphrase({ words: 3, includeNumber: true }).split('-');
    assert.equal(tokens.length, 3);
    assert.equal(tokens.filter((t) => /[0-9]$/.test(t)).length, 1);
  }
  assert.equal(generatePassphrase().split('-').length, 6, 'defaults: 6 words joined with "-"');
  assert.equal(generatePassphrase({ words: 3, wordlist: ['only'] }), 'only-only-only');
  assert.throws(() => generatePassphrase({ words: 2 }), code('invalid_argument'));
  assert.throws(() => generatePassphrase({ words: 13 }), code('invalid_argument'));
  assert.throws(() => generatePassphrase({ separator: '123456789' }), code('invalid_argument'));
});

test('deterministic output with an injected rng', () => {
  const fixed = (n) => Uint8Array.from({ length: n }, (_, i) => (i * 97 + 13) & 0xff);
  assert.equal(generatePassword({ rng: fixed }), generatePassword({ rng: fixed }));
  assert.equal(generatePassphrase({ rng: fixed }), generatePassphrase({ rng: fixed }));
});

test('entropy helpers', () => {
  assert.ok(Math.abs(passwordEntropyBits({ length: 20 }) - 20 * Math.log2(86)) < 1e-9);
  assert.ok(passphraseEntropyBits({ words: 6 }) > 66);
  assert.ok(passphraseEntropyBits({ words: 6, includeNumber: true }) > passphraseEntropyBits({ words: 6 }));
  assert.deepEqual([27, 28, 39, 40, 51, 52, 63, 64].map(scoreForBits), [0, 1, 1, 2, 2, 3, 3, 4]);
});

test('estimateStrength ranks passwords sensibly', () => {
  const s = (pw) => estimateStrength(pw);
  assert.deepEqual(s(''), { score: 0, entropyBits: 0, feedback: ['Enter a password.'], label: 'Empty' });
  for (const weak of ['password', 'Password1', 'P@ssw0rd', 'qwerty123', 'aaaaaaaaaaaaaaaa', 'abcdefghijkl', '12345678', 'qwertyuiop']) {
    assert.ok(s(weak).score <= 1, `${weak}: ${JSON.stringify(s(weak))}`);
  }
  assert.ok(s('summer2024').score <= 1);
  assert.ok(s('Tr0ub4dor&3').score >= 1);
  assert.equal(s(generatePassword({ length: 20 })).score, 4);
  const pp = generatePassphrase({ words: 6 });
  assert.ok(s(pp).score >= 3, pp);
  assert.ok(s('abcabcabcabcabc').entropyBits < 30);
  assert.ok(s('x'.repeat(5000)).entropyBits < 40, 'long input stays linear and is penalised');
  assert.ok(Array.isArray(s('hello world').feedback));
});
