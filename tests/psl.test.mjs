// Public Suffix List table: generated file is fresh (not stale, not hand-edited), the vendored snapshot
// matches its pinned SHA-256, and the lookup reproduces the publicsuffix.org reference test cases.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { domainToASCII } from 'node:url';

import { generate, parseDat, DAT_PATH, OUT_PATH, PSL_SHA256 } from '../scripts/psl/make-psl.mjs';
import { PSL_INFO, PSL_RULES } from '../src/lib/psl-data.js';
import { registrableDomain, hasRegistrableDomain } from '../src/lib/url-match.js';

test('vendored list matches the pinned SHA-256 and src/lib/psl-data.js is regenerated from it', async () => {
  const dat = await readFile(DAT_PATH);
  assert.equal(createHash('sha256').update(dat.toString('utf8').replace(/\r\n/g, '\n')).digest('hex'), PSL_SHA256);
  const committed = (await readFile(OUT_PATH, 'utf8')).replace(/\r\n/g, '\n');
  assert.equal(committed, generate(dat), 'psl-data.js is stale or was edited by hand: run node scripts/psl/make-psl.mjs');
  assert.equal(PSL_INFO.sha256, PSL_SHA256);
  assert.equal(PSL_RULES.split(' ').length, PSL_INFO.rules);
  assert.ok(PSL_INFO.private > 1000 && PSL_INFO.icann > 5000, 'both sections present');
  assert.throws(() => generate(`${dat.toString('utf8')}\nevil.example\n`), /pinned/);
});

test('parser: sections, wildcards, exceptions, IDN to punycode', () => {
  const dat = [
    '// ===BEGIN ICANN DOMAINS===',
    'com',
    '*.ck',
    '!www.ck',
    '公司.cn',
    '// ===END ICANN DOMAINS===',
    '// ===BEGIN PRIVATE DOMAINS===',
    'github.io  // trailing comment',
    '// ===END PRIVATE DOMAINS===',
  ].join('\n');
  assert.deepEqual(parseDat(dat), { rules: ['!www.ck', '*.ck', 'com', 'github.io', 'xn--55qx5d.cn'], icann: 4, private: 1 });
  assert.throws(() => parseDat('// ===BEGIN ICANN DOMAINS===\na.*.b\n// ===END ICANN DOMAINS===\n// ===BEGIN PRIVATE DOMAINS===\nx\n'), /wildcard/);
  assert.throws(() => parseDat('stray.rule\n'), /outside/);
});

// https://raw.githubusercontent.com/publicsuffix/list/master/tests/test_psl.txt (checkPublicSuffix cases).
// null = the host has no registrable domain.
const REFERENCE = [
  ['com', null], ['example.com', 'example.com'], ['www.example.com', 'example.com'],
  ['uk.com', null], ['example.uk.com', 'example.uk.com'], ['b.example.uk.com', 'example.uk.com'], ['a.b.example.uk.com', 'example.uk.com'],
  ['test.ac', 'test.ac'],
  ['mm', null], ['c.mm', null], ['b.c.mm', 'b.c.mm'], ['a.b.c.mm', 'b.c.mm'],
  ['jp', null], ['test.jp', 'test.jp'], ['www.test.jp', 'test.jp'], ['ac.jp', null], ['test.ac.jp', 'test.ac.jp'], ['www.test.ac.jp', 'test.ac.jp'],
  ['kyoto.jp', null], ['test.kyoto.jp', 'test.kyoto.jp'], ['ide.kyoto.jp', null], ['b.ide.kyoto.jp', 'b.ide.kyoto.jp'], ['a.b.ide.kyoto.jp', 'b.ide.kyoto.jp'],
  ['c.kobe.jp', null], ['b.c.kobe.jp', 'b.c.kobe.jp'], ['a.b.c.kobe.jp', 'b.c.kobe.jp'], ['city.kobe.jp', 'city.kobe.jp'], ['www.city.kobe.jp', 'city.kobe.jp'],
  ['ck', null], ['test.ck', null], ['b.test.ck', 'b.test.ck'], ['a.b.test.ck', 'b.test.ck'], ['www.ck', 'www.ck'], ['www.www.ck', 'www.ck'],
  ['us', null], ['test.us', 'test.us'], ['www.test.us', 'test.us'], ['ak.us', null], ['test.ak.us', 'test.ak.us'], ['www.test.ak.us', 'test.ak.us'],
  ['k12.ak.us', null], ['test.k12.ak.us', 'test.k12.ak.us'], ['www.test.k12.ak.us', 'test.k12.ak.us'],
  ['食狮.com.cn', '食狮.com.cn'], ['食狮.公司.cn', '食狮.公司.cn'], ['www.食狮.公司.cn', '食狮.公司.cn'], ['shishi.公司.cn', 'shishi.公司.cn'], ['公司.cn', null],
  ['食狮.中国', '食狮.中国'], ['www.食狮.中国', '食狮.中国'], ['shishi.中国', 'shishi.中国'], ['中国', null],
  ['xn--85x722f.com.cn', 'xn--85x722f.com.cn'], ['xn--85x722f.xn--55qx5d.cn', 'xn--85x722f.xn--55qx5d.cn'],
  ['www.xn--85x722f.xn--55qx5d.cn', 'xn--85x722f.xn--55qx5d.cn'], ['shishi.xn--55qx5d.cn', 'shishi.xn--55qx5d.cn'], ['xn--55qx5d.cn', null],
  ['xn--85x722f.xn--fiqs8s', 'xn--85x722f.xn--fiqs8s'], ['www.xn--85x722f.xn--fiqs8s', 'xn--85x722f.xn--fiqs8s'], ['shishi.xn--fiqs8s', 'shishi.xn--fiqs8s'], ['xn--fiqs8s', null],
  // mixed case, unlisted TLD
  ['COM', null], ['example.COM', 'example.com'], ['WwW.example.COM', 'example.com'],
  ['example', null], ['example.example', 'example.example'], ['b.example.example', 'example.example'], ['a.b.example.example', 'example.example'],
];

test('publicsuffix.org reference cases', () => {
  for (const [host, want] of REFERENCE) {
    const got = hasRegistrableDomain(host) ? registrableDomain(host) : null;
    assert.equal(got, want === null ? null : domainToASCII(want), host);
  }
});
