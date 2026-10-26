// Behaviour parity with the web app's canonical vault libs (URL matching, registrable domains, TOTP), so an
// item shows up for the same sites and yields the same codes in the extension and the web UI. For
// `starts_with` the extension may only ever be stricter (same origin required for full URLs, §8.3).
// Skips when ludworks-server is not checked out next to this repo.

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import * as extUrl from '../src/lib/url-match.js';
import * as extTotp from '../src/lib/totp.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const LIB = path.resolve(here, '..', '..', 'ludworks-server', 'web', 'assets', 'js', 'lib', 'vault');
const skip = !existsSync(path.join(LIB, 'url-match.js')) && 'ludworks-server web vault lib not checked out next to this repo';
const webUrl = skip ? null : await import(pathToFileURL(path.join(LIB, 'url-match.js')).href);
const webTotp = skip ? null : await import(pathToFileURL(path.join(LIB, 'totp.js')).href);

const ITEM_URIS = [
  'https://github.com/login', 'github.com', 'http://github.com', 'https://gist.github.com', 'https://www.amazon.co.uk/ap/signin',
  'https://192.168.1.10:5001', 'http://localhost:5000', 'localhost:8080', 'https://intranet', 'https://bank.com',
  'https://bank.com/login', 'https://BANK.com.', 'ftp://files.example.com', '^https://([a-z]+\\.)?example\\.org/', '(a+)+$',
  '[invalid', 'https://example.com:8443/app', 'https://xn--bcher-kva.example/', 'https://bücher.example/', '',
];
const PAGES = [
  'https://github.com/login', 'https://gist.github.com/x', 'http://github.com/', 'https://github.com.evil.net/',
  'https://www.amazon.co.uk/', 'https://amazon.co.uk/', 'https://evil.co.uk/', 'https://192.168.1.10:5001/', 'https://192.168.1.10/',
  'http://localhost:5000/login', 'http://localhost:5001/', 'https://intranet/', 'https://bank.com/login?next=1', 'https://bank.com.evil.net/',
  'https://bank.com', 'https://sub.example.org/', 'https://example.com:8443/app/login', 'https://example.com/app',
  'https://xn--bcher-kva.example/', 'chrome://settings', 'about:blank', 'not a url',
];
const MODES = [undefined, null, '', 'domain', 'host', 'exact', 'regex', 'never', 'bogus'];

test('URL matching: same answers as the web app for every mode except the documented starts_with rule', { skip }, () => {
  let compared = 0;
  for (const item of ITEM_URIS) {
    for (const page of PAGES) {
      for (const mode of MODES) {
        assert.equal(extUrl.matchUri(item, page, mode), webUrl.matchUri(item, page, mode), `matchUri(${JSON.stringify(item)}, ${JSON.stringify(page)}, ${mode})`);
        compared++;
      }
      // starts_with: the extension may only be stricter (never matches where the web app does not)
      const e = extUrl.matchUri(item, page, 'starts_with');
      const w = webUrl.matchUri(item, page, 'starts_with');
      if (e) assert.equal(w, true, `starts_with stricter only: ${item} ${page}`);
    }
  }
  assert.ok(compared > 3000);
  assert.equal(extUrl.matchUri('https://bank.com', 'https://bank.com.evil.net/', 'starts_with'), false, 'extension: same origin');
});

test('registrable domains agree (Public Suffix List incl. private section)', { skip }, () => {
  for (const h of ['github.com', 'gist.github.com', 'a.b.c.example.co.uk', 'example.com.au', 'foo.ltd.uk', 'localhost', '127.0.0.1', 'intranet', 'x.gov.uk', 'a.b.ac.jp', 'ex.github.io', 'EXAMPLE.COM', 'example.com.', '::1',
    'github.io', 'nas.duckdns.org', 'a.b.tail1234.ts.net', 'mynas.synology.me', 'www.example.ne.jp', 'b.test.ck', 'www.ck', 'xn--85x722f.xn--55qx5d.cn']) {
    assert.equal(extUrl.registrableDomain(h), webUrl.registrableDomain(h), h);
  }
});

test('TOTP codes and otpauth parsing agree', { skip }, async () => {
  const inputs = [
    'JBSWY3DPEHPK3PXP', 'jbsw y3dp ehpk 3pxp', 'otpauth://totp/GitHub:alice?secret=JBSWY3DPEHPK3PXP&issuer=GitHub',
    'otpauth://totp/X?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&algorithm=SHA256&digits=8&period=60',
    'otpauth://totp/X?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZA&algorithm=SHA512&digits=7',
    'steam://JBSWY3DPEHPK3PXP',
  ];
  for (const s of inputs) {
    for (const t of [0, 59_000, 1_111_111_109_000, Date.UTC(2026, 9, 26, 12)]) {
      const a = await extTotp.generateTotp(s, t);
      const b = await webTotp.generateTotp(s, t);
      assert.equal(a.code, b.code, `${s} @ ${t}`);
      assert.equal(a.period, b.period);
    }
  }
  const uri = 'otpauth://totp/ACME%20Co:john@example.com?secret=HXDMVJECJJWSRB3HWIZR4IFUGFTMXBOZ&issuer=ACME%20Co&algorithm=SHA1&digits=6&period=30';
  assert.deepEqual(extTotp.parseOtpauth(uri), webTotp.parseOtpauth(uri));
});
