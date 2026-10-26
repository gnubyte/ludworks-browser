import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PSL_INFO } from '../src/lib/psl-data.js';
import {
  registrableDomain,
  hasRegistrableDomain,
  matchUri,
  ruleMatches,
  matchScore,
  bestMatchScore,
  STRONG_MATCH,
  isLocalhost,
  pageSecurity,
  siteName,
  hostLabel,
  parseHttpUrl,
} from '../src/lib/url-match.js';

test('registrableDomain (Public Suffix List, ICANN + PRIVATE)', () => {
  const cases = {
    'example.com': 'example.com',
    'www.example.com': 'example.com',
    'a.b.c.example.com': 'example.com',
    'EXAMPLE.com.': 'example.com',
    'example.com:8443': 'example.com',
    'bbc.co.uk': 'bbc.co.uk',
    'www.bbc.co.uk': 'bbc.co.uk',
    'login.bank.com.au': 'bank.com.au',
    'shop.example.org.nz': 'example.org.nz',
    'x.ltd.uk': 'x.ltd.uk',
    'portal.school.sch.uk': 'portal.school.sch.uk', // *.sch.uk: every school is its own suffix
    'mail.example.co': 'example.co',
    'gist.github.com': 'github.com',
    // multi-tenant hosting (PRIVATE section): every tenant is its own site
    'victim-project.github.io': 'victim-project.github.io',
    'a.b.victim-project.github.io': 'victim-project.github.io',
    'nas.duckdns.org': 'nas.duckdns.org',
    'mynas.synology.me:5001': 'mynas.synology.me',
    'nas.tail1234.ts.net': 'tail1234.ts.net', // one tailnet = one site
    'myapp.herokuapp.com': 'myapp.herokuapp.com',
    'bank.s3.amazonaws.com': 'bank.s3.amazonaws.com',
    'mysite.pages.dev': 'mysite.pages.dev',
    // ICANN second levels the old two/three-label heuristic got wrong
    'www.example.ne.jp': 'example.ne.jp',
    'login.city.gob.mx': 'city.gob.mx',
    'intranet.example.or.at': 'example.or.at',
    // hosts that ARE a public suffix are returned unchanged (and have no registrable domain)
    'co.uk': 'co.uk',
    'github.io': 'github.io',
    'duckdns.org': 'duckdns.org',
    localhost: 'localhost',
    nas: 'nas',
    '192.168.1.10': '192.168.1.10',
    '192.168.1.10:8443': '192.168.1.10',
    '[::1]:8080': '[::1]',
    '': '',
  };
  for (const [host, want] of Object.entries(cases)) assert.equal(registrableDomain(host), want, host);
  assert.equal(registrableDomain(null), '');
  for (const h of ['co.uk', 'github.io', 'duckdns.org', 'ts.net', 'ne.jp', 'localhost', 'nas', '10.0.0.1', '[::1]', '', 'a..b.com']) {
    assert.equal(hasRegistrableDomain(h), false, h);
  }
  for (const h of ['example.com', 'nas.duckdns.org', 'www.bbc.co.uk']) assert.equal(hasRegistrableDomain(h), true, h);
  assert.equal(hasRegistrableDomain(null), false);
});

test('domain mode never matches across tenants of a shared public suffix', () => {
  const crossTenant = [
    ['https://victim-project.github.io/admin/login', 'https://attacker.github.io/phish'],
    ['https://alice.github.io/', 'https://mallory.github.io/'],
    ['https://myapp.herokuapp.com/login', 'https://evil.herokuapp.com/'],
    ['https://corp.azurewebsites.net/', 'https://x.azurewebsites.net/'],
    ['https://mysite.pages.dev/', 'https://evil.pages.dev/'],
    ['https://bank.s3.amazonaws.com/', 'https://evil.s3.amazonaws.com/'],
    ['https://nas.duckdns.org/', 'https://evil.duckdns.org/login'],
    ['https://mynas.synology.me:5001', 'https://evil.synology.me/'],
    ['https://a.myds.me/', 'https://b.myds.me/'],
    ['https://nas.tail1234.ts.net/', 'https://phish.tail9999.ts.net/'],
    ['https://shop.myshopify.com/', 'https://evil.myshopify.com/'],
    ['https://www.example.ne.jp/', 'https://attacker.ne.jp/'],
    ['https://a.ne.jp/', 'https://b.ne.jp/'],
    ['https://login.city.gob.mx/', 'https://evil.gob.mx/'],
    ['https://a.or.at/', 'https://b.or.at/'],
    ['https://www.bbc.co.uk/', 'https://evil.co.uk/'],
  ];
  for (const [item, page] of crossTenant) {
    assert.equal(matchUri(item, page), false, `${item} must not match ${page}`);
    assert.equal(matchScore(page, { uri: item, match: 'domain' }), 0, `${item} score on ${page}`);
  }
  // still the same site
  assert.ok(matchUri('https://github.com/login', 'https://gist.github.com/'));
  assert.ok(matchUri('https://shop.example.co.uk/', 'https://www.example.co.uk/'));
  assert.ok(matchUri('https://a.example.com/', 'https://b.example.com/'));
  assert.ok(matchUri('https://a.tail1234.ts.net/', 'https://b.tail1234.ts.net/'), 'same tailnet');
  assert.ok(matchUri('https://nas.duckdns.org/', 'https://files.nas.duckdns.org/'), 'subdomain of the same tenant');
  // an item saved for a host that IS a public suffix only matches that exact host (§3.1)
  assert.ok(matchUri('https://github.io/', 'https://github.io/x'));
  assert.ok(!matchUri('https://github.io/', 'https://attacker.github.io/'));
  assert.ok(!matchUri('https://attacker.github.io/', 'https://github.io/'));
  assert.equal(matchScore('https://duckdns.org/', { uri: 'https://duckdns.org:8443/' }), 1, 'other port: weak match only');
});

// ---- Shared spec vectors (ludworks-server/docs/spec/vault-test-vectors.json, VAULT-CRYPTO.md §3.1/§8.1)
const specPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'ludworks-server', 'docs', 'spec', 'vault-test-vectors.json');
const spec = existsSync(specPath) ? JSON.parse(readFileSync(specPath, 'utf8')) : null;
const skipSpec = (!spec || !Array.isArray(spec.registrable_domain) || !Array.isArray(spec.url_match)) && 'spec URL-matching vectors not present';

test('spec vectors: same PSL snapshot, registrable_domain and url_match', { skip: skipSpec }, () => {
  assert.equal(spec.public_suffix_list.source_sha256, PSL_INFO.sha256, 'same pinned Public Suffix List snapshot as the other clients');
  for (const v of spec.registrable_domain) assert.equal(registrableDomain(v.host), v.registrable_domain, v.host);
  for (const v of spec.url_match) {
    assert.equal(matchUri(v.item_uri, v.page_url, v.match), v.expected, `${v.item_uri} [${v.match}] ${v.page_url}`);
  }
});

test('PSL edge cases: wildcard and exception rules, trailing dot, IDN', () => {
  // *.ck with the !www.ck exception
  assert.equal(registrableDomain('b.test.ck'), 'b.test.ck');
  assert.equal(registrableDomain('a.b.test.ck'), 'b.test.ck');
  assert.equal(hasRegistrableDomain('test.ck'), false);
  assert.equal(registrableDomain('www.ck'), 'www.ck');
  assert.equal(registrableDomain('www.www.ck'), 'www.ck');
  assert.ok(!matchUri('https://a.test.ck/', 'https://b.test.ck/'), 'wildcard: siblings are separate sites');
  assert.ok(matchUri('https://www.ck/', 'https://login.www.ck/'));
  // trailing dot
  assert.ok(matchUri('https://example.com./', 'https://www.example.com/'));
  assert.ok(!matchUri('https://nas.duckdns.org./', 'https://evil.duckdns.org/'));
  // IDN: Unicode input and punycode hostnames agree
  assert.equal(registrableDomain('www.食狮.公司.cn'), 'xn--85x722f.xn--55qx5d.cn');
  assert.equal(hasRegistrableDomain('公司.cn'), false);
  assert.ok(matchUri('https://食狮.公司.cn/', 'https://www.xn--85x722f.xn--55qx5d.cn/'));
  assert.ok(!matchUri('https://a.公司.cn/', 'https://b.公司.cn/'));
});

test('domain mode (default): same registrable domain, https never matches http', () => {
  const uri = 'https://github.com/login';
  assert.ok(matchUri(uri, 'https://github.com/session'));
  assert.ok(matchUri(uri, 'https://gist.github.com/', 'domain'));
  assert.ok(matchUri(uri, 'https://github.com:8443/'), 'ports are ignored for normal domains');
  assert.ok(!matchUri(uri, 'http://github.com/'), 'no autofill into a downgraded connection');
  assert.ok(matchUri('http://intranet.example.com', 'https://intranet.example.com/'), 'http item may match https page');
  assert.ok(!matchUri(uri, 'https://github.com.evil.net/'));
  assert.ok(!matchUri(uri, 'https://evilgithub.com/'));
  assert.ok(!matchUri(uri, 'https://github.io/'));
  assert.ok(matchUri('github.com', 'https://github.com/'), 'scheme-less item URI -> https://');
  assert.ok(!matchUri('github.com', 'http://github.com/'), 'scheme-less means https, so not on http pages');
  assert.ok(matchUri('github.com', 'https://github.com/', null));
  assert.ok(matchUri('github.com', 'https://github.com/', ''));
});

test('multi-level public suffixes', () => {
  assert.ok(matchUri('https://www.bbc.co.uk/', 'https://account.bbc.co.uk/signin'));
  assert.ok(!matchUri('https://www.bbc.co.uk/', 'https://evil.co.uk/'), 'co.uk is not registrable');
  assert.ok(matchUri('https://bank.com.au', 'https://login.bank.com.au/'));
  assert.ok(!matchUri('https://bank.com.au', 'https://other.com.au/'));
});

test('IPs, localhost and single-label hosts compare host AND port', () => {
  assert.ok(matchUri('https://192.168.1.10:8443/', 'https://192.168.1.10:8443/login'));
  assert.ok(!matchUri('https://192.168.1.10:8443/', 'https://192.168.1.10/'));
  assert.ok(!matchUri('https://192.168.1.10/', 'https://192.168.1.11/'));
  assert.ok(!matchUri('https://10.0.1.10/', 'https://192.0.1.10/'), 'no last-two-labels logic for IPs');
  assert.ok(matchUri('http://localhost:3000', 'http://localhost:3000/login'));
  assert.ok(!matchUri('http://localhost:3000', 'http://localhost:8080/login'), 'different port = different app');
  assert.ok(!matchUri('http://localhost:3000', 'http://127.0.0.1:3000/'));
  assert.ok(matchUri('https://nas:5001', 'https://nas:5001/'));
  assert.ok(!matchUri('https://nas:5001', 'https://nas:5000/'));
  assert.ok(matchUri('http://[::1]:8080/', 'http://[::1]:8080/x'));
});

test('host mode: exact host and port (default ports elided)', () => {
  assert.ok(matchUri('https://nas.example.com:8443/app', 'https://nas.example.com:8443/other', 'host'));
  assert.ok(!matchUri('https://nas.example.com:8443/app', 'https://nas.example.com/', 'host'));
  assert.ok(!matchUri('https://nas.example.com:8443/app', 'https://www.example.com:8443/', 'host'));
  assert.ok(matchUri('https://example.com:443/', 'https://example.com/', 'host'));
  assert.ok(!matchUri('https://example.com/', 'http://example.com/', 'host'));
});

test('starts_with: raw prefix, and (extension hardening) same origin for absolute item URIs', () => {
  assert.ok(matchUri('https://example.com/app', 'https://example.com/app/login', 'starts_with'));
  assert.ok(matchUri('https://example.com/app', 'https://example.com/application', 'starts_with'));
  assert.ok(!matchUri('https://example.com/app', 'https://example.com/other', 'starts_with'));
  assert.ok(!matchUri('https://bank.com', 'https://bank.com.evil.net/login', 'starts_with'), 'lookalike host refused');
  assert.ok(!matchUri('https://bank.com', 'https://bank.com@evil.net/', 'starts_with'));
  assert.ok(matchUri('https://bank.com', 'https://bank.com/', 'starts_with'));
  assert.ok(!matchUri('HTTPS://example.com/app', 'https://example.com/app', 'starts_with'), 'raw string compare');
});

test('exact: raw string equality', () => {
  assert.ok(matchUri('https://example.com/login?next=1', 'https://example.com/login?next=1', 'exact'));
  assert.ok(!matchUri('https://example.com/login?next=1', 'https://example.com/login?next=1#top', 'exact'));
  assert.ok(!matchUri('https://example.com/login', 'https://example.com/login/', 'exact'));
});

test('regex: case-insensitive, length-capped, ReDoS shapes refused; never; unknown', () => {
  assert.ok(matchUri('^https://intranet\\.corp/', 'https://intranet.corp/login', 'regex'));
  assert.ok(matchUri('intranet\\.corp', 'https://INTRANET.corp/login', 'regex'));
  assert.ok(!matchUri('([', 'https://x.corp/', 'regex'));
  assert.ok(!matchUri('a'.repeat(1001), 'https://x.corp/', 'regex'));
  for (const evil of ['(a+)+$', '(\\w*)*x', '(x+){2,}', '(a|aa)+(b+)*']) {
    assert.ok(!matchUri(evil, `https://x.corp/${'a'.repeat(30)}!`, 'regex'), evil);
  }
  assert.ok(matchUri('(foo|bar)+', 'https://x.corp/foo', 'regex'), 'quantified group without inner quantifier is fine');
  assert.ok(!matchUri('https://example.com', 'https://example.com/', 'never'));
  assert.ok(!matchUri('https://example.com', 'https://example.com/', 'fuzzy'), 'unknown -> never');
});

test('non-web pages, empty and odd input never match', () => {
  assert.ok(!matchUri('chrome://settings', 'chrome://settings/', 'domain'));
  assert.ok(!matchUri('file:///etc/passwd', 'file:///etc/passwd', 'host'));
  assert.ok(!matchUri('androidapp://com.example', 'https://example.com/'));
  assert.ok(!matchUri('example.com', 'not a url'));
  assert.ok(!matchUri('   ', 'https://example.com/'));
  assert.ok(!matchUri(null, 'https://example.com/'));
  assert.ok(!matchUri('example.com', `https://example.com/${'x'.repeat(5000)}`));
  assert.ok(ruleMatches('https://github.com/', { uri: 'github.com' }));
  assert.ok(!ruleMatches('https://github.com/', null));
  assert.ok(!ruleMatches('https://github.com/', 'github.com'));
});

test('scores rank more specific rules higher', () => {
  const url = 'https://www.example.com/login';
  assert.equal(matchScore(url, { uri: 'example.com' }), 1);
  assert.equal(matchScore(url, { uri: 'www.example.com' }), 2);
  assert.equal(matchScore(url, { uri: 'https://www.example.com', match: 'host' }), 3);
  assert.equal(matchScore(url, { uri: 'https://www.example.com/log', match: 'starts_with' }), 4);
  assert.equal(matchScore(url, { uri: url, match: 'exact' }), 5);
  assert.equal(matchScore(url, { uri: 'other.com' }), 0);
  assert.equal(bestMatchScore(url, [{ uri: 'example.com' }, { uri: url, match: 'exact' }]), 5);
  assert.equal(bestMatchScore(url, 'nope'), 0);
  // a domain rule saved for another port of the same host is only a weak (same-site) match
  assert.equal(matchScore('https://nas.example.com:8443/', { uri: 'https://nas.example.com:5001' }), 1);
  assert.equal(matchScore('https://intranet.example.com/', { uri: 'http://intranet.example.com' }), 2, 'default ports');
  assert.equal(STRONG_MATCH, 2);
});

test('page security, localhost, site names', () => {
  assert.equal(pageSecurity('https://a.com/'), 'secure');
  assert.equal(pageSecurity('http://localhost:3000/'), 'insecure_localhost');
  assert.equal(pageSecurity('http://127.0.0.1/'), 'insecure_localhost');
  assert.equal(pageSecurity('http://dev.localhost/'), 'insecure_localhost');
  assert.equal(pageSecurity('http://a.com/'), 'insecure');
  assert.equal(pageSecurity('ftp://a.com/'), 'insecure');
  assert.ok(isLocalhost('[::1]'));
  assert.ok(!isLocalhost('localhost.evil.com'));
  assert.ok(!isLocalhost('128.0.0.1'));
  assert.equal(siteName('https://www.github.com/login'), 'github.com');
  assert.equal(siteName('bbc.co.uk'), 'bbc.co.uk');
  assert.equal(siteName(''), '');
  assert.equal(parseHttpUrl('javascript:alert(1)'), null);
  assert.equal(hostLabel('https://NAS.example.com:5001/login'), 'nas.example.com:5001');
  assert.equal(hostLabel('nas.duckdns.org'), 'nas.duckdns.org');
  assert.equal(hostLabel('https://example.com:443/'), 'example.com');
  assert.equal(hostLabel('chrome://settings'), '');
});
