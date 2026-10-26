import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { parseOtpauth, parseTotpInput, buildOtpauth, generateTotp, computeTotp, base32decode, base32encode, formatTotp } from '../src/lib/totp.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const vectors = JSON.parse(readFileSync(path.join(here, 'fixtures', 'crypto-vectors.json'), 'utf8'));
const te = new TextEncoder();
const code = (c) => (e) => e && e.code === c;

// RFC 6238 Appendix B
const RFC = [
  [59, '94287082', '46119246', '90693936'],
  [1111111109, '07081804', '68084774', '25091201'],
  [1111111111, '14050471', '67062674', '99943326'],
  [1234567890, '89005924', '91819424', '93441116'],
  [2000000000, '69279037', '90698825', '38618901'],
  [20000000000, '65353130', '77737706', '47863826'],
];
const SECRETS = {
  SHA1: te.encode('12345678901234567890'),
  SHA256: te.encode('12345678901234567890123456789012'),
  SHA512: te.encode('1234567890123456789012345678901234567890123456789012345678901234'),
};

test('RFC 6238 Appendix B (SHA1/SHA256/SHA512, 8 digits) via otpauth URIs', async () => {
  for (const [time, ...codes] of RFC) {
    for (const [i, alg] of ['SHA1', 'SHA256', 'SHA512'].entries()) {
      const uri = `otpauth://totp/RFC:test?secret=${base32encode(SECRETS[alg])}&algorithm=${alg}&digits=8&period=30`;
      assert.equal((await generateTotp(uri, time * 1000)).code, codes[i], `${alg} @ ${time}`);
      assert.equal((await computeTotp(SECRETS[alg], { algorithm: alg, digits: 8 }, time * 1000)).code, codes[i]);
    }
  }
});

test('python-generated TOTP vectors (own fixture)', async () => {
  for (const v of vectors.totp) assert.equal((await generateTotp(v.uri, v.time * 1000)).code, v.code, `${v.uri} @ ${v.time}`);
});

test('remaining seconds', async () => {
  const r = await generateTotp('JBSWY3DPEHPK3PXP', 61_000);
  assert.equal(r.remaining, 29);
  assert.equal(r.period, 30);
  assert.equal((await generateTotp('otpauth://totp/x?secret=JBSWY3DPEHPK3PXP&period=60', 61_000)).remaining, 59);
});

test('Steam Guard codes', async () => {
  const p = parseOtpauth('steam://JBSWY3DPEHPK3PXP');
  assert.deepEqual(p, { type: 'totp', secret: 'JBSWY3DPEHPK3PXP', algorithm: 'SHA1', digits: 5, period: 30, issuer: 'Steam', account: '', encoder: 'steam' });
  const r = await generateTotp('steam://JBSWY3DPEHPK3PXP', 1_700_000_000_000);
  assert.match(r.code, /^[23456789BCDFGHJKMNPQRTVWXY]{5}$/);
  const viaParam = await generateTotp('otpauth://totp/Steam:me?secret=JBSWY3DPEHPK3PXP&encoder=steam', 1_700_000_000_000);
  assert.equal(viaParam.code, r.code);
  assert.equal(formatTotp(r.code), r.code);
});

test('base32 is case-insensitive and ignores spaces, hyphens and padding', () => {
  const a = base32decode('JBSWY3DPEHPK3PXP');
  assert.deepEqual([...a], [72, 101, 108, 108, 111, 33, 0xde, 0xad, 0xbe, 0xef]); // "Hello!" + DEADBEEF
  assert.deepEqual(base32decode('jbsw y3dp ehpk 3pxp'), a);
  assert.deepEqual(base32decode('JBSWY3DPEHPK3PXP===='), a);
  assert.deepEqual(base32decode('JBSW-Y3DP-EHPK-3PXP'), a);
  assert.throws(() => base32decode('JBSWY3DPEHPK3PX1'), code('malformed'));
  assert.throws(() => base32decode(''), code('malformed'));
  assert.equal(base32encode(a), 'JBSWY3DPEHPK3PXP');
});

test('parseOtpauth result shape (canonical)', () => {
  const p = parseOtpauth('otpauth://totp/ACME%20Co:john@example.com?secret=jbsw%20y3dp&issuer=ACME%20Co&algorithm=SHA256&digits=8&period=45');
  assert.deepEqual(p, { type: 'totp', secret: 'JBSWY3DP', algorithm: 'SHA256', digits: 8, period: 45, issuer: 'ACME Co', account: 'john@example.com', encoder: 'rfc6238' });
  assert.equal(parseOtpauth('otpauth://totp/Label?secret=JBSWY3DPEHPK3PXP').issuer, '');
  assert.equal(parseOtpauth('otpauth://totp/Iss:acct?secret=JBSWY3DPEHPK3PXP').issuer, 'Iss');
  assert.equal(parseOtpauth('otpauth://totp/x?secret=JBSWY3DPEHPK3PXP&algorithm=sha-512').algorithm, 'SHA512');
  assert.deepEqual(parseTotpInput(' jbsw y3dp ehpk 3pxp '), { type: 'totp', secret: 'JBSWY3DPEHPK3PXP', algorithm: 'SHA1', digits: 6, period: 30, issuer: '', account: '', encoder: 'rfc6238' });
});

test('parseOtpauth / parseTotpInput reject bad input', () => {
  const cases = [
    ['otpauth://hotp/x?secret=JBSWY3DPEHPK3PXP&counter=1', 'unsupported'],
    ['otpauth://totp/x?secret=JBSWY3DPEHPK3PXP&digits=5', 'unsupported'],
    ['otpauth://totp/x?secret=JBSWY3DPEHPK3PXP&digits=9', 'unsupported'],
    ['otpauth://totp/x?secret=JBSWY3DPEHPK3PXP&algorithm=MD5', 'unsupported'],
    ['otpauth://totp/x?secret=JBSWY3DPEHPK3PXP&period=0', 'malformed'],
    ['otpauth://totp/x?secret=', 'malformed'],
    ['https://example.com', 'malformed'],
  ];
  for (const [input, c] of cases) assert.throws(() => parseOtpauth(input), code(c), input);
  assert.throws(() => parseTotpInput('not base32 !!'), code('malformed'));
  assert.throws(() => parseTotpInput('   '), code('invalid_argument'));
  assert.throws(() => parseOtpauth(null), code('invalid_argument'));
});

test('buildOtpauth round trip', () => {
  const uri = buildOtpauth({ secret: 'jbsw y3dp ehpk 3pxp', issuer: 'ACME Co', account: 'me@x', algorithm: 'SHA256', digits: 8, period: 60 });
  assert.equal(uri, 'otpauth://totp/ACME%20Co:me%40x?secret=JBSWY3DPEHPK3PXP&issuer=ACME%20Co&algorithm=SHA256&digits=8&period=60');
  assert.deepEqual(parseOtpauth(uri), { type: 'totp', secret: 'JBSWY3DPEHPK3PXP', algorithm: 'SHA256', digits: 8, period: 60, issuer: 'ACME Co', account: 'me@x', encoder: 'rfc6238' });
  assert.equal(buildOtpauth({ secret: 'JBSWY3DPEHPK3PXP' }), 'otpauth://totp/Ludworks?secret=JBSWY3DPEHPK3PXP');
});

test('formatTotp groups digits', () => {
  assert.equal(formatTotp('123456'), '123 456');
  assert.equal(formatTotp('12345678'), '1234 5678');
  assert.equal(formatTotp('1234567'), '1234567');
  assert.equal(formatTotp(null), '');
});
