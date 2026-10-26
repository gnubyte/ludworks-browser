// URI matching for autofill (VAULT-CRYPTO.md §3 and the §8.3 reference rules).
// `matchUri(itemUri, pageUrl, mode)` and `registrableDomain(host)` keep the canonical web signatures
// (web/assets/js/lib/vault/url-match.js) so the copies can be unified. Rules:
//  * `domain`/`host` only match http(s) pages, and an https item URI never matches an http page.
//  * Item URIs without a scheme get https://.
//  * `domain`: same registrable domain = public suffix + one label, computed with the Public Suffix List
//    (ICANN *and* PRIVATE sections, src/lib/psl-data.js), so tenants of shared hosts such as github.io,
//    duckdns.org, ts.net, synology.me, herokuapp.com or ne.jp are different sites. A host that is itself a
//    public suffix only matches that exact host. IP addresses, localhost and single-label hosts compare host
//    AND port.
//  * `host`: host + port (default ports elided).
//  * `exact`: raw string equality.
//  * `starts_with`: raw string prefix — PLUS (extension hardening, documented deviation) the page must
//    have the same origin as the item URI when the item URI is an absolute http(s) URL, so a rule like
//    "https://bank.com" can never fill into "https://bank.com.evil.net/".
//  * `regex`: case-insensitive, <= 1000 chars; invalid patterns and nested-quantifier (ReDoS) shapes never match.
//  * `never` and unknown modes never match.

import { PSL_RULES } from './psl-data.js';

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const MAX_REGEX_LENGTH = 1000;
const MAX_URL_LENGTH = 4096;
// A quantified group that itself contains a quantifier ("(a+)+", "(\w*)*", "(x+){2,}") is the classic
// catastrophic-backtracking shape; vault data can come from imported files, so such patterns are refused.
const NESTED_QUANTIFIER_RE = /\((?:[^()\\]|\\.)*[+*}](?:[^()\\]|\\.)*\)\s*(?:[+*]|\{\d*,?\d*\})/;

export const URI_MATCH_TYPES = Object.freeze(['domain', 'host', 'starts_with', 'exact', 'regex', 'never']);

function isIp(host) {
  return IPV4_RE.test(host) || host.includes(':') || host.startsWith('[');
}

function stripPort(host) {
  if (host.startsWith('[')) {
    const end = host.indexOf(']');
    return end > 0 ? host.slice(0, end + 1) : host;
  }
  const m = /^([^:]+):\d+$/.exec(host);
  return m ? m[1] : host;
}

let psl = null;

/** Rule sets, built on first use from the generated table (scripts/psl/make-psl.mjs). */
function pslSets() {
  if (psl) return psl;
  const rules = new Set();
  const wildcards = new Set(); // "*.ck"    -> "ck"
  const exceptions = new Set(); // "!www.ck" -> "www.ck"
  for (const r of PSL_RULES.split(' ')) {
    if (!r) continue;
    if (r.startsWith('!')) exceptions.add(r.slice(1));
    else if (r.startsWith('*.')) wildcards.add(r.slice(2));
    else rules.add(r);
  }
  psl = { rules, wildcards, exceptions };
  return psl;
}

/** Lower-case, ":port" and trailing dot removed, IDN converted to punycode (as URL.hostname reports it). */
function normalizeHost(host) {
  let h = stripPort(host.trim().toLowerCase());
  if (h.endsWith('.')) h = h.slice(0, -1);
  if (/[^\x00-\x7f]/.test(h)) {
    try {
      h = new URL(`http://${h}/`).hostname;
    } catch {
      /* left as is: then it never equals a valid hostname */
    }
  }
  return h;
}

/**
 * Number of labels in the public suffix of `labels` (PSL algorithm: an exception rule wins; otherwise the
 * longest matching normal or wildcard rule; otherwise the implicit "*" rule, i.e. the last label).
 * @param {string[]} labels
 */
function publicSuffixLabels(labels) {
  const { rules, wildcards, exceptions } = pslSets();
  let best = 1;
  for (let i = labels.length - 1; i >= 0; i--) {
    const suffix = labels.slice(i).join('.');
    const n = labels.length - i;
    if (exceptions.has(suffix)) return n - 1;
    if (rules.has(suffix)) best = Math.max(best, n);
    if (i > 0 && wildcards.has(suffix)) best = Math.max(best, n + 1);
  }
  return best;
}

/**
 * eTLD+1 of a normalized host, or null when it has none: IP, localhost, single label, malformed, or the
 * host is itself a public suffix ("github.io", "co.uk", "duckdns.org").
 * @param {string} h  normalized host
 * @returns {string|null}
 */
function siteOf(h) {
  if (!h || isIp(h) || h === 'localhost' || !h.includes('.')) return null;
  const labels = h.split('.');
  if (labels.some((l) => l === '')) return null;
  const n = publicSuffixLabels(labels);
  return labels.length > n ? labels.slice(labels.length - n - 1).join('.') : null;
}

/**
 * Registrable domain (eTLD+1 under the Public Suffix List, ICANN + PRIVATE) of a hostname (":port" suffix
 * ignored). IPs, localhost, single-label hosts and hosts that are themselves a public suffix are returned
 * unchanged (see `hasRegistrableDomain`).
 * @param {string} host
 * @returns {string}
 */
export function registrableDomain(host) {
  if (typeof host !== 'string') return '';
  const h = normalizeHost(host);
  return siteOf(h) || h;
}

/**
 * Does the host have a registrable domain? False for IPs, localhost, single-label hosts and hosts that are
 * themselves a public suffix: those only ever match by exact host + port.
 * @param {string} host
 * @returns {boolean}
 */
export function hasRegistrableDomain(host) {
  return typeof host === 'string' && siteOf(normalizeHost(host)) !== null;
}

function parseUrl(s, assumeScheme) {
  if (typeof s !== 'string') return null;
  let str = s.trim();
  if (!str || str.length > MAX_URL_LENGTH) return null;
  if (assumeScheme && !/^[a-z][a-z0-9+.-]*:\/\//i.test(str)) str = `https://${str}`;
  try {
    return new URL(str);
  } catch {
    return null;
  }
}

const isWeb = (u) => u.protocol === 'https:' || u.protocol === 'http:';

function hostKey(hostname) {
  let h = hostname.toLowerCase();
  if (h.endsWith('.')) h = h.slice(0, -1);
  return h;
}

/**
 * Does a saved item URI match the page URL under the given match mode?
 * @param {string} itemUri  saved URI (scheme optional for domain/host; https:// is assumed)
 * @param {string} pageUrl  full page URL
 * @param {string|null} [mode]  'domain' (default) | 'host' | 'starts_with' | 'exact' | 'regex' | 'never'
 * @returns {boolean}
 */
export function matchUri(itemUri, pageUrl, mode) {
  if (typeof itemUri !== 'string' || typeof pageUrl !== 'string' || !itemUri.trim()) return false;
  if (pageUrl.length > MAX_URL_LENGTH) return false;
  const m = mode === undefined || mode === null || mode === '' ? 'domain' : mode;
  switch (m) {
    case 'never':
      return false;
    case 'exact':
      return itemUri === pageUrl;
    case 'starts_with': {
      if (!pageUrl.startsWith(itemUri)) return false;
      const item = /^https?:\/\//i.test(itemUri) ? parseUrl(itemUri, false) : null;
      const page = parseUrl(pageUrl, false);
      if (item && (!page || item.origin !== page.origin)) return false;
      return true;
    }
    case 'regex': {
      if (itemUri.length > MAX_REGEX_LENGTH || NESTED_QUANTIFIER_RE.test(itemUri)) return false;
      try {
        return new RegExp(itemUri, 'i').test(pageUrl);
      } catch {
        return false;
      }
    }
    case 'host':
    case 'domain': {
      const page = parseUrl(pageUrl, false);
      const item = parseUrl(itemUri, true);
      if (!page || !item || !isWeb(page) || !isWeb(item)) return false;
      if (item.protocol === 'https:' && page.protocol !== 'https:') return false;
      const ph = hostKey(page.hostname);
      const ih = hostKey(item.hostname);
      if (!ph || !ih) return false;
      if (m === 'host' || isIp(ih) || ih === 'localhost' || !ih.includes('.')) {
        return ih === ph && item.port === page.port;
      }
      // eTLD+1 under the PSL (VAULT-CRYPTO.md §3.1). A host that is itself a public suffix ("github.io") is
      // its own registrable domain, so it only ever matches that exact host — never a tenant below it.
      return (siteOf(ih) || ih) === (siteOf(ph) || ph);
    }
    default:
      return false;
  }
}

/**
 * Convenience: does a stored URI rule object ({uri, match}) match the page?
 * @param {string} pageUrl
 * @param {{uri: string, match?: string|null}|null|undefined} rule
 * @returns {boolean}
 */
export function ruleMatches(pageUrl, rule) {
  return !!rule && typeof rule === 'object' && matchUri(rule.uri, pageUrl, rule.match);
}

/**
 * Scores >= STRONG_MATCH mean "saved for this very host" (or a stricter rule). A score of 1 is a `domain`
 * rule saved for ANOTHER host (or port) of the same registrable domain: listed, but never filled without
 * the user confirming the other host (fill shortcut, offer-to-save updates: see background/core.js).
 */
export const STRONG_MATCH = 2;

/**
 * How specific a matching rule is (0 = no match). Used to rank "This site" results and pick the best
 * login for the fill shortcut: exact > starts_with > host/regex > same host+port > same domain only.
 * @param {string} pageUrl
 * @param {{uri: string, match?: string|null}} rule
 * @returns {number}
 */
export function matchScore(pageUrl, rule) {
  if (!ruleMatches(pageUrl, rule)) return 0;
  const mode = rule.match || 'domain';
  if (mode === 'exact') return 5;
  if (mode === 'starts_with') return 4;
  if (mode === 'host' || mode === 'regex') return 3;
  const page = parseUrl(pageUrl, false);
  const item = parseUrl(rule.uri, true);
  return page && item && hostKey(page.hostname) === hostKey(item.hostname) && page.port === item.port ? 2 : 1;
}

/**
 * Best score of any rule in `uris` against `pageUrl` (0 = none match).
 * @param {string} pageUrl
 * @param {Array<{uri: string, match?: string}>} uris
 * @returns {number}
 */
export function bestMatchScore(pageUrl, uris) {
  if (!Array.isArray(uris)) return 0;
  let best = 0;
  for (const r of uris) best = Math.max(best, matchScore(pageUrl, r));
  return best;
}

/**
 * localhost, *.localhost, 127.0.0.0/8 and ::1.
 * @param {string} host
 * @returns {boolean}
 */
export function isLocalhost(host) {
  if (typeof host !== 'string') return false;
  let h = host.toLowerCase().replace(/\.$/, '');
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  return h === 'localhost' || h.endsWith('.localhost') || h === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

/**
 * Parse a page URL; only http/https are accepted.
 * @param {string|URL} value
 * @returns {URL|null}
 */
export function parseHttpUrl(value) {
  let u;
  try {
    u = value instanceof URL ? value : new URL(String(value));
  } catch {
    return null;
  }
  return u.protocol === 'https:' || u.protocol === 'http:' ? u : null;
}

/**
 * Autofill policy for a page: 'secure' (https), 'insecure_localhost' (http on localhost; needs explicit
 * consent) or 'insecure' (never filled).
 * @param {string} url
 * @returns {'secure'|'insecure_localhost'|'insecure'}
 */
export function pageSecurity(url) {
  const u = parseHttpUrl(url);
  if (!u) return 'insecure';
  if (u.protocol === 'https:') return 'secure';
  return isLocalhost(u.hostname) ? 'insecure_localhost' : 'insecure';
}

/**
 * Friendly site name for a URL: hostname without a leading "www.".
 * @param {string} url
 * @returns {string}
 */
export function siteName(url) {
  const u = parseUrl(url, true);
  return u ? u.hostname.replace(/^www\./i, '') : '';
}

/**
 * Host (with a non-default port) of a page URL or saved item URI (scheme optional, https assumed), for
 * showing exactly which host a login was saved for. '' when it is not an http(s) URL.
 * @param {string} url
 * @returns {string}
 */
export function hostLabel(url) {
  const u = parseUrl(url, true);
  return u && isWeb(u) ? u.host.toLowerCase() : '';
}
