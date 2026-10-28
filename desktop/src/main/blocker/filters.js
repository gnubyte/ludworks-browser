// Content blocker: the Adblock Plus / uBlock Origin filter *syntax*, parsed into plain objects.
//
// Clean-room implementation of the publicly documented filter syntax (Adblock Plus "How to write
// filters", the uBlock Origin wiki): network filters (pattern + $options), cosmetic filters (##, #@#,
// #?#, procedural operators) and scriptlet filters (##+js(...)). No Electron here: the compile worker,
// the main-process engine and the unit tests all use this module.

import { domainToASCII } from 'node:url';

// ----------------------------------------------------------------------------- request types
export const TYPE = Object.freeze({
  OTHER: 1,
  SCRIPT: 2,
  IMAGE: 4,
  STYLESHEET: 8,
  OBJECT: 16,
  SUBDOCUMENT: 32,
  XHR: 64,
  PING: 128,
  MEDIA: 256,
  FONT: 512,
  WEBSOCKET: 1024,
  DOCUMENT: 2048,
});
export const ALL_TYPES = 4095;
/** Filters without a type option apply to everything but top-level documents (see `typeMask`). */
export const DEFAULT_TYPES = ALL_TYPES & ~TYPE.DOCUMENT;

/** Electron webRequest `resourceType` → TYPE bit. */
export const RESOURCE_TYPES = Object.freeze({
  mainFrame: TYPE.DOCUMENT,
  subFrame: TYPE.SUBDOCUMENT,
  stylesheet: TYPE.STYLESHEET,
  script: TYPE.SCRIPT,
  image: TYPE.IMAGE,
  font: TYPE.FONT,
  object: TYPE.OBJECT,
  xhr: TYPE.XHR,
  ping: TYPE.PING,
  cspReport: TYPE.OTHER,
  media: TYPE.MEDIA,
  webSocket: TYPE.WEBSOCKET,
  other: TYPE.OTHER,
});

export const TYPE_NAMES = Object.freeze(
  Object.fromEntries([
    [TYPE.OTHER, 'other'],
    [TYPE.SCRIPT, 'script'],
    [TYPE.IMAGE, 'image'],
    [TYPE.STYLESHEET, 'stylesheet'],
    [TYPE.OBJECT, 'object'],
    [TYPE.SUBDOCUMENT, 'frame'],
    [TYPE.XHR, 'xhr'],
    [TYPE.PING, 'ping'],
    [TYPE.MEDIA, 'media'],
    [TYPE.FONT, 'font'],
    [TYPE.WEBSOCKET, 'websocket'],
    [TYPE.DOCUMENT, 'document'],
  ]),
);

const TYPE_OPTIONS = {
  script: TYPE.SCRIPT,
  image: TYPE.IMAGE,
  stylesheet: TYPE.STYLESHEET,
  css: TYPE.STYLESHEET,
  object: TYPE.OBJECT,
  'object-subrequest': TYPE.OBJECT,
  subdocument: TYPE.SUBDOCUMENT,
  frame: TYPE.SUBDOCUMENT,
  xmlhttprequest: TYPE.XHR,
  xhr: TYPE.XHR,
  ping: TYPE.PING,
  beacon: TYPE.PING,
  media: TYPE.MEDIA,
  font: TYPE.FONT,
  websocket: TYPE.WEBSOCKET,
  other: TYPE.OTHER,
  document: TYPE.DOCUMENT,
  doc: TYPE.DOCUMENT,
};

const METHODS = { connect: 1, delete: 2, get: 4, head: 8, options: 16, patch: 32, post: 64, put: 128 };
export function methodBit(m) {
  return METHODS[String(m || 'get').toLowerCase()] || 0;
}

/** Page-level exception flags (`@@…$document`, `$elemhide`, `$generichide`, `$specifichide`). */
export const DOC = Object.freeze({ DOCUMENT: 1, ELEMHIDE: 2, GENERICHIDE: 4, SPECIFICHIDE: 8 });

// Options that make a filter meaningless or unsafe for us: the whole filter is dropped (never
// "the filter minus that option", which could turn a narrow rule into a broad one).
// (popunder, inline-script, header=, cname, ipaddress=, replace=, urlskip=, uritransform=, permissions=,
// AdGuard-only options…: see the default case of the option switch.)

// ------------------------------------------------------------------------------------ helpers
const isTokenCode = (c) => (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 37; // a-z 0-9 %

/**
 * Tokens of a lower-case URL: maximal runs of [a-z0-9%]. The network index files each filter under one
 * token that every matching URL must contain as a whole token.
 * @param {string} s
 * @returns {string[]}
 */
export function urlTokens(s) {
  const out = [];
  const n = Math.min(s.length, 4096);
  let i = 0;
  while (i < n) {
    if (!isTokenCode(s.charCodeAt(i))) {
      i++;
      continue;
    }
    let j = i + 1;
    while (j < n && isTokenCode(s.charCodeAt(j))) j++;
    out.push(s.slice(i, j));
    i = j;
  }
  return out;
}

/**
 * Tokens of a (lower-case) filter pattern that are guaranteed to appear as whole tokens in every URL
 * the pattern matches: bounded on both sides by a separator character, an anchor or `^` — never by a
 * `*` wildcard or an unanchored pattern end.
 */
export function patternTokens(p, hostAnchor, leftAnchor, rightAnchor) {
  const out = [];
  const n = p.length;
  let i = 0;
  while (i < n) {
    if (!isTokenCode(p.charCodeAt(i))) {
      i++;
      continue;
    }
    let j = i + 1;
    while (j < n && isTokenCode(p.charCodeAt(j))) j++;
    const leftOk = i === 0 ? hostAnchor || leftAnchor : p.charCodeAt(i - 1) !== 42; // '*'
    const rightOk = j === n ? rightAnchor : p.charCodeAt(j) !== 42;
    if (leftOk && rightOk) out.push(p.slice(i, j));
    i = j;
  }
  return out;
}

/** Hostname → punycode, lower case; '' when it is not a plausible hostname. */
export function normalizeHostname(h) {
  let s = String(h || '').trim().toLowerCase();
  if (s.endsWith('.')) s = s.slice(0, -1);
  if (/[^\x00-\x7f]/.test(s)) s = domainToASCII(s);
  return /^[a-z0-9_.-]+$/.test(s) && !s.startsWith('.') && !s.includes('..') ? s : '';
}

const ENTITY_RE = /^[a-z0-9_.-]+\.\*$/;

/** `a.com|~b.a.com|example.*` → {inc: Set|null, exc: Set|null}; null when malformed. */
function parseDomainList(value, sep = '|') {
  const inc = new Set();
  const exc = new Set();
  let positives = 0;
  for (let d of value.split(sep)) {
    d = d.trim().toLowerCase();
    if (!d) continue;
    const neg = d.startsWith('~');
    if (neg) d = d.slice(1);
    else positives++;
    if (d.startsWith('/')) return null; // regex domains: not supported
    const host = ENTITY_RE.test(d) ? d : normalizeHostname(d);
    if (!host) continue;
    (neg ? exc : inc).add(host);
  }
  // Positive entries we could not read must not leave a broader filter behind.
  if ((positives && !inc.size) || (!inc.size && !exc.size)) return null;
  return { inc: inc.size ? inc : null, exc: exc.size ? exc : null };
}

/** Split an option string on unescaped commas (regex values may contain `\,`). */
function splitOptions(s) {
  const out = [];
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && s[i + 1] === ',') {
      cur += ',';
      i++;
    } else if (c === ',') {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out.map((o) => o.trim()).filter(Boolean);
}

const OPTION_START_RE = /^~?[a-z0-9_-]+(?:=|,|$)/i;

/** Index of the `$` that starts the options, or -1. */
function optionsIndex(s) {
  if (s.charCodeAt(0) === 47 /* / */) {
    // Regex patterns may contain `$`: the options separator then directly follows the closing slash.
    const i = s.lastIndexOf('/$');
    if (i > 0 && OPTION_START_RE.test(s.slice(i + 2))) return i + 1;
    if (s.endsWith('/')) return -1;
  }
  // The last `$` that is followed by something option-like (option values such as
  // removeparam=/…$/ may contain `$` themselves).
  let i = s.lastIndexOf('$');
  while (i >= 0) {
    if (OPTION_START_RE.test(s.slice(i + 1))) return i;
    i = i > 0 ? s.lastIndexOf('$', i - 1) : -1;
  }
  return -1;
}

/** Is this `/.../` pattern meant as a regular expression (and does it compile)? */
function regexSource(p) {
  if (p.length < 3 || p[0] !== '/' || p[p.length - 1] !== '/') return null;
  const src = p.slice(1, -1);
  if (!/[\\^$[\](){}|?+]/.test(src)) return null; // "/ads/" is a path, not a regex
  try {
    new RegExp(src);
  } catch {
    return undefined; // invalid: drop the filter
  }
  return src;
}

// ------------------------------------------------------------------------------ preprocessing
const ENV = { env_chromium: true, ext_ublock: true, cap_user_stylesheet: true, true: true };

function evalCondition(expr) {
  // !#if expressions: identifiers, !, &&, ||, parentheses. Unknown identifiers are false.
  const toks = expr.match(/!|&&|\|\||\(|\)|[A-Za-z_][\w]*/g) || [];
  let i = 0;
  const or = () => {
    let v = and();
    while (toks[i] === '||') {
      i++;
      v = and() || v;
    }
    return v;
  };
  const and = () => {
    let v = unary();
    while (toks[i] === '&&') {
      i++;
      v = unary() && v;
    }
    return v;
  };
  const unary = () => {
    const t = toks[i++];
    if (t === '!') return !unary();
    if (t === '(') {
      const v = or();
      if (toks[i] === ')') i++;
      return v;
    }
    return ENV[t] === true;
  };
  try {
    return !!or();
  } catch {
    return false;
  }
}

/**
 * Filter lines of a list: comments, headers and `!#if` blocks for other platforms removed, hosts-file
 * entries turned into `||host^`. Yields trimmed lines.
 * @param {string} text
 */
export function* listLines(text) {
  const stack = [];
  let active = true;
  let start = 0;
  const n = text.length;
  while (start < n) {
    let end = text.indexOf('\n', start);
    if (end < 0) end = n;
    let line = text.slice(start, end).trim();
    start = end + 1;
    if (!line) continue;
    if (line.startsWith('!#')) {
      if (line.startsWith('!#if ')) {
        stack.push(active);
        active = active && evalCondition(line.slice(5));
      } else if (line.startsWith('!#else')) {
        const parent = stack.length ? stack[stack.length - 1] : true;
        active = parent && !active;
      } else if (line.startsWith('!#endif')) {
        active = stack.length ? stack.pop() : true;
      }
      continue;
    }
    if (!active) continue;
    const c = line.charCodeAt(0);
    if (c === 33 /* ! */ || c === 91 /* [ */) continue;
    if (c === 35 /* # */ && !line.startsWith('##') && !line.startsWith('#@#') && !line.startsWith('#?#') && !line.startsWith('#$#')) continue; // hosts comment
    // hosts-file entries: "0.0.0.0 host", "127.0.0.1 host # comment"
    const m = /^(?:0\.0\.0\.0|127\.0\.0\.1|::1?|::)\s+([^\s#]+)/.exec(line);
    if (m) {
      const host = normalizeHostname(m[1]);
      if (host && host.includes('.') && host !== '0.0.0.0' && !/^(localhost|local|broadcasthost)$/.test(host)) yield `||${host}^`;
      continue;
    }
    const hash = line.indexOf(' #');
    if (hash > 0 && /^[a-z0-9.-]+\s+#/i.test(line)) line = line.slice(0, hash).trim();
    yield line;
  }
}

// A line that is only a hostname is a hosts-style entry (uBO does the same), unless it looks like a
// file name ("ads.js").
const PLAIN_HOST_RE = /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z][a-z0-9-]+$/i;
const FILE_EXT_RE = /\.(js|css|php|html?|gif|png|jpe?g|svg|swf|aspx?|cgi|json|xml|txt|jsp|webp|mp4|ico)$/i;

// ---------------------------------------------------------------------------- network filters
/**
 * @typedef {object} NetFilter
 * @property {string} raw            the filter line
 * @property {boolean} allow         exception (@@)
 * @property {boolean} important
 * @property {string} pattern        pattern without anchors (lower case unless matchCase)
 * @property {string|null} regex     regex source for /…/ filters
 * @property {boolean} hostAnchor    ||
 * @property {boolean} left          |…
 * @property {boolean} right         …|
 * @property {boolean} matchCase
 * @property {number} typeMask       TYPE bits the filter applies to
 * @property {number} party          0 any, 1 first, 2 third, 3 strict first, 4 strict third
 * @property {{inc: Set<string>|null, exc: Set<string>|null}|null} domains   domain= / from=
 * @property {{inc: Set<string>|null, exc: Set<string>|null}|null} to        to=
 * @property {Set<string>|null} denyallow
 * @property {number} methods
 * @property {string|null} host       set when the pattern is exactly `||host^`
 * @property {string|null} removeparam   '' = all parameters
 * @property {string|null} csp           '' only for exceptions (= every csp filter)
 * @property {number} docFlags       DOC bits (exceptions only)
 * @property {boolean} badfilter
 */

/**
 * Parse one network filter. Returns null for filters we do not support (they are skipped, never
 * approximated).
 * @param {string} raw
 * @returns {NetFilter|null}
 */
export function parseNetworkFilter(raw) {
  let s = raw;
  const f = {
    raw,
    allow: false,
    important: false,
    pattern: '',
    regex: null,
    hostAnchor: false,
    left: false,
    right: false,
    matchCase: false,
    typeMask: 0,
    party: 0,
    domains: null,
    to: null,
    denyallow: null,
    methods: 0,
    host: null,
    removeparam: null,
    csp: null,
    docFlags: 0,
    badfilter: false,
  };
  if (s.startsWith('@@')) {
    f.allow = true;
    s = s.slice(2);
  }
  let types = 0;
  let notTypes = 0;
  let popup = false;
  const oi = optionsIndex(s);
  if (oi >= 0) {
    const opts = splitOptions(s.slice(oi + 1));
    s = s.slice(0, oi);
    for (const o of opts) {
      const eq = o.indexOf('=');
      let name = (eq >= 0 ? o.slice(0, eq) : o).toLowerCase();
      const value = eq >= 0 ? o.slice(eq + 1) : null;
      const neg = name.startsWith('~');
      if (neg) name = name.slice(1);
      if (Object.hasOwn(TYPE_OPTIONS, name)) {
        if (neg) notTypes |= TYPE_OPTIONS[name];
        else types |= TYPE_OPTIONS[name];
        if (name === 'document' || name === 'doc') {
          if (f.allow && !neg) f.docFlags |= DOC.DOCUMENT;
        }
        continue;
      }
      switch (name) {
        case 'third-party':
        case '3p':
          f.party = neg ? 1 : 2;
          break;
        case 'first-party':
        case '1p':
          f.party = neg ? 2 : 1;
          break;
        case 'strict1p':
        case 'strict-first-party':
          f.party = 3;
          break;
        case 'strict3p':
        case 'strict-third-party':
          f.party = 4;
          break;
        case 'all':
          types |= ALL_TYPES;
          break;
        case 'popup':
          popup = true;
          break;
        case 'important':
          f.important = true;
          break;
        case 'match-case':
          f.matchCase = true;
          break;
        case 'domain':
        case 'from':
          if (!value || !(f.domains = parseDomainList(value))) return null;
          break;
        case 'to':
          if (!value || !(f.to = parseDomainList(value))) return null;
          break;
        case 'denyallow': {
          const d = value && parseDomainList(value);
          if (!d || d.exc || !d.inc) return null;
          f.denyallow = d.inc;
          break;
        }
        case 'method': {
          if (!value) return null;
          let inc = 0;
          let exc = 0;
          for (let m of value.toLowerCase().split('|')) {
            const mneg = m.startsWith('~');
            if (mneg) m = m.slice(1);
            if (!METHODS[m]) return null;
            if (mneg) exc |= METHODS[m];
            else inc |= METHODS[m];
          }
          f.methods = inc || 255 & ~exc;
          break;
        }
        // Redirects to neutral resources cannot be served: Chromium (like the Fetch standard) refuses
        // webRequest redirects of subresources to non-HTTP(S) URLs such as data:. `$redirect=` filters
        // therefore simply block; `$redirect-rule=` (redirect only, never block) and redirect
        // exceptions have nothing to do.
        case 'redirect':
        case 'empty':
        case 'mp4':
          if (f.allow) return null;
          break;
        case 'redirect-rule':
          return null;
        case 'removeparam':
        case 'queryprune':
          f.removeparam = value === null ? '' : value;
          break;
        case 'csp':
          if (value === null && !f.allow) return null;
          if (value && /[\r\n]|report-(uri|to)/i.test(value)) return null;
          f.csp = value || '';
          break;
        case 'badfilter':
          f.badfilter = true;
          break;
        case 'elemhide':
        case 'ehide':
          f.docFlags |= DOC.ELEMHIDE;
          break;
        case 'generichide':
        case 'ghide':
          f.docFlags |= DOC.GENERICHIDE;
          break;
        case 'specifichide':
        case 'shide':
          f.docFlags |= DOC.SPECIFICHIDE;
          break;
        case '_':
        case 'reason':
          break;
        default:
          if (/^_+$/.test(name)) break;
          return null; // unsupported or unknown option: drop the filter
      }
    }
  }
  if (f.docFlags && !f.allow) return null; // $generichide & co. only make sense as exceptions
  // popup-only filters: we do not block popups.
  if (popup && !types && !notTypes && !f.docFlags) return null;
  // ----------------------------------------------------------------------------- pattern
  if (s === '' || s === '*' || s === '|' || s === '||') s = '';
  const rx = regexSource(s);
  if (rx === undefined) return null;
  if (rx) {
    f.regex = rx;
    f.pattern = '';
  } else {
    if (s.startsWith('||')) {
      f.hostAnchor = true;
      s = s.slice(2);
    } else if (s.startsWith('|')) {
      f.left = true;
      s = s.slice(1);
    }
    if (s.endsWith('|') && !s.endsWith('\\|')) {
      f.right = true;
      s = s.slice(0, -1);
    }
    while (s.startsWith('*')) {
      s = s.slice(1);
      f.hostAnchor = f.left = false;
    }
    while (s.endsWith('*') && !s.endsWith('\\*')) {
      s = s.slice(0, -1);
      f.right = false;
    }
    if (!f.matchCase) s = s.toLowerCase();
    if (f.hostAnchor && /[^\x00-\x7f]/.test(s)) {
      // IDN hostname part → punycode
      const m = /^([^/^:?*|]+)(.*)$/.exec(s);
      if (m) {
        const h = domainToASCII(m[1]);
        if (!h) return null;
        s = h + m[2];
      }
    }
    f.pattern = s;
    if (f.hostAnchor && !f.right) {
      const m = /^([a-z0-9_-]+(?:\.[a-z0-9_-]+)+)\^$/.exec(s);
      if (m) f.host = m[1];
    }
  }
  if (!f.pattern && !f.regex && !f.hostAnchor && !f.left && !f.right) {
    // Empty pattern: needs something narrowing it, else it would match every request.
    if (!f.domains && !f.to && !f.docFlags && f.removeparam === null && f.csp === null && !f.allow) return null;
  }
  // ------------------------------------------------------------------------------- types
  if (types) f.typeMask = types & ~notTypes;
  else if (notTypes) f.typeMask = ALL_TYPES & ~TYPE.DOCUMENT & ~notTypes;
  else if (f.docFlags) f.typeMask = 0; // page-level exception only
  else if (f.removeparam !== null || f.csp !== null) f.typeMask = TYPE.DOCUMENT | TYPE.SUBDOCUMENT;
  else if (f.host && f.party !== 2 && f.party !== 4) f.typeMask = ALL_TYPES; // `||host^` also blocks the page itself (strict blocking)
  else f.typeMask = DEFAULT_TYPES;
  if (!f.typeMask && !f.docFlags) return null;
  return f;
}

/** Key identifying a filter for `$badfilter` (option order does not matter). */
export function filterKey(raw) {
  let s = raw;
  let pre = '';
  if (s.startsWith('@@')) {
    pre = '@@';
    s = s.slice(2);
  }
  const oi = optionsIndex(s);
  if (oi < 0) return pre + s;
  const opts = splitOptions(s.slice(oi + 1))
    .filter((o) => o.toLowerCase() !== 'badfilter')
    .sort();
  return `${pre}${s.slice(0, oi)}${opts.length ? `$${opts.join(',')}` : ''}`;
}

const escapeRe = (s) => s.replace(/[.+?${}()|[\]\\/]/g, '\\$&');

/** RegExp source for a non-regex pattern (`*` wildcards, `^` separators, anchors). */
export function patternRegex(f) {
  let src = '';
  for (const part of f.pattern.split('*')) {
    if (src) src += '.*';
    src += part
      .split('^')
      .map(escapeRe)
      .join('(?:[^\\w.%-]|$)');
  }
  if (f.hostAnchor) src = `^[a-z][a-z0-9+.-]*:\\/\\/(?:[^\\/?#]*\\.)?${src}`;
  else if (f.left) src = `^${src}`;
  if (f.right) src += '$';
  return new RegExp(src, f.matchCase ? '' : 'i');
}

/** Is this line a network filter that only names a host (`||host^`, no options)? */
export function plainHost(line) {
  const m = /^\|\|([a-z0-9_-]+(?:\.[a-z0-9_-]+)+)\^$/.exec(line);
  return m ? m[1] : null;
}

/** Hostname-only lines are hosts-style entries; returns the `||host^` form or the line itself. */
export function normalizeNetworkLine(line) {
  if (PLAIN_HOST_RE.test(line) && !FILE_EXT_RE.test(line)) {
    const h = normalizeHostname(line);
    if (h) return `||${h}^`;
  }
  return line;
}

// --------------------------------------------------------------------------- cosmetic filters
const MARKERS = ['#@$?#', '#@?#', '#@$#', '#@%#', '#$?#', '#@#', '##', '#?#', '#$#', '#%#'];

/** Procedural operators (uBO + ABP/AdGuard spellings). */
const PROCEDURAL_RE = /:(?:has-text|contains|-abp-contains|-abp-has|-abp-properties|xpath|upward|nth-ancestor|matches-css(?:-before|-after)?|min-text-length|matches-attr|matches-path|matches-media|matches-prop|remove|remove-attr|remove-class|style|watch-attr|others|if|if-not)\(/;

/**
 * Where a cosmetic filter splits into hostnames / marker / body, or null for network filters.
 * @returns {{hosts: string, marker: string, body: string}|null}
 */
function splitCosmetic(line) {
  let from = 0;
  for (;;) {
    const i = line.indexOf('#', from);
    if (i < 0) return null;
    for (const m of MARKERS) {
      if (line.startsWith(m, i)) {
        const hosts = line.slice(0, i);
        // A URL pattern with a fragment is a network filter; "/regex/##…" hostnames are cosmetic
        // (and unsupported, see parseHostList).
        if (/[|$^\s]/.test(hosts) || (hosts.includes('/') && !hosts.startsWith('/'))) return null;
        return { hosts, marker: m, body: line.slice(i + m.length) };
      }
    }
    from = i + 1;
  }
}

/** Is the line a cosmetic (element hiding / scriptlet) filter? */
export function isCosmetic(line) {
  return splitCosmetic(line) !== null;
}

function parseHostList(s) {
  const hosts = [];
  const notHosts = [];
  let positives = 0;
  if (!s || s === '*') return { hosts, notHosts };
  for (let h of s.split(',')) {
    h = h.trim().toLowerCase();
    if (!h) continue;
    const neg = h.startsWith('~');
    if (neg) h = h.slice(1);
    if (h.startsWith('/')) return null; // regex hostnames: not supported
    if (h === '*') continue;
    if (!neg) positives++;
    if (h.endsWith('>>')) h = h.slice(0, -2); // "host>>" = the host and frames inside it; applied to the host
    const host = ENTITY_RE.test(h) ? h : normalizeHostname(h);
    if (!host) continue;
    (neg ? notHosts : hosts).push(host);
  }
  // A specific filter whose hostnames we cannot read must never turn into a generic one.
  if (positives && !hosts.length) return null;
  return { hosts, notHosts };
}

/**
 * @typedef {object} CosmeticFilter
 * @property {'hide'|'style'|'procedural'|'scriptlet'} kind
 * @property {boolean} exception
 * @property {string[]} hosts       positive hostnames / entities (empty = generic)
 * @property {string[]} notHosts    ~negated hostnames
 * @property {string} body          CSS selector, `selector{declarations}` for style, procedural
 *                                  selector, or the scriptlet call as JSON ('' = all scriptlets)
 */

/**
 * Parse a cosmetic filter line. Returns null when unsupported (HTML filters, AdGuard JS/CSS
 * injection, trusted scriptlets, unsafe selectors).
 * @param {string} line
 * @returns {CosmeticFilter|null}
 */
export function parseCosmeticFilter(line) {
  const sp = splitCosmetic(line);
  if (!sp) return null;
  const { marker } = sp;
  let body = sp.body.trim();
  if (marker.includes('%') || marker.includes('$')) return null; // AdGuard JS / CSS injection
  const exception = marker.includes('@');
  const hl = parseHostList(sp.hosts);
  if (!hl) return null;
  if (!body) return null;
  if (body.startsWith('^')) return null; // HTML filtering (response bodies)
  if (body.startsWith('+js(')) {
    if (!body.endsWith(')')) return null;
    const inner = body.slice(4, -1);
    if (!inner.trim()) {
      if (!exception) return null;
      return { kind: 'scriptlet', exception, ...hl, body: '' }; // #@#+js(): every scriptlet off
    }
    const call = parseScriptletCall(inner);
    if (!call) return null;
    return { kind: 'scriptlet', exception, ...hl, body: JSON.stringify(call) };
  }
  // `selector { declarations }` (ABP/AdGuard spelling of :style())
  const braces = /^([^{}]+?)\s*\{([^{}]*)\}$/.exec(body);
  if (braces) body = `${braces[1]}:style(${braces[2].trim()})`;
  if (/[{}]/.test(body) || body.includes('/*') || body.length > 2000) return null;
  body = body
    .replace(/:-abp-has\(/g, ':has(')
    .replace(/:-abp-contains\(/g, ':has-text(')
    .replace(/:contains\(/g, ':has-text(')
    .replace(/:nth-ancestor\(/g, ':upward(');
  if (/:-abp-properties\(|:matches-prop\(|:if\(|:if-not\(/.test(body)) return null;
  if (!PROCEDURAL_RE.test(body)) return { kind: 'hide', exception, ...hl, body };
  // `selector:style(declarations)` with a plain CSS selector: injected as a stylesheet rule.
  const st = /^(.*?):style\((.*)\)$/.exec(body);
  if (st && !PROCEDURAL_RE.test(st[1]) && st[1].trim()) {
    const decl = st[2].trim();
    if (!decl || /url\(|\\|@|expression\(|javascript:/i.test(decl)) return null;
    if (!hl.hosts.length && !exception) return null; // generic :style is not allowed
    return { kind: 'style', exception, ...hl, body: `${st[1].trim()}{${decl}}` };
  }
  if (/:style\(/.test(body) && /url\(|\\|@|expression\(/i.test(body.slice(body.indexOf(':style(')))) return null;
  if (!hl.hosts.length && !exception) return null; // generic procedural filters are not allowed
  return { kind: 'procedural', exception, ...hl, body };
}

/**
 * The class or id a generic selector needs on some element of the page (`.ad-box`, `#banner`), taken
 * from its first compound selector; null for "highly generic" selectors (always injected).
 */
export function genericKey(sel) {
  let i = 0;
  const n = sel.length;
  let first = null;
  while (i < n) {
    const c = sel[i];
    if (c === '#' || c === '.') {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_-]/.test(sel[j])) j++;
      if (j === i + 1 || sel[j] === '\\') return first;
      const key = sel.slice(i, j);
      if (c === '#') return key; // an id is the best key
      if (!first) first = key;
      i = j;
      continue;
    }
    if (/[A-Za-z0-9_*-]/.test(c)) {
      i++;
      continue;
    }
    break; // combinator, attribute, pseudo-class: end of the first compound
  }
  return first;
}

// ------------------------------------------------------------------------------------ scriptlets
/** Supported scriptlets (implemented in src/preload/features/blocker-scriptlets.js) and aliases. */
export const SCRIPTLETS = Object.freeze({
  'abort-current-script': ['acs', 'abort-current-inline-script', 'acis'],
  'abort-on-property-read': ['aopr'],
  'abort-on-property-write': ['aopw'],
  'abort-on-stack-trace': ['aost'],
  'addEventListener-defuser': ['aeld', 'prevent-addEventListener'],
  'adjust-setInterval': ['nano-setInterval-booster', 'nano-sib'],
  'adjust-setTimeout': ['nano-setTimeout-booster', 'nano-stb'],
  'json-prune': [],
  'json-prune-fetch-response': ['jpfr'],
  'json-prune-xhr-response': ['jpxr'],
  'no-fetch-if': ['prevent-fetch'],
  'no-xhr-if': ['prevent-xhr'],
  'no-setTimeout-if': ['nostif', 'prevent-setTimeout', 'setTimeout-defuser'],
  'no-setInterval-if': ['nosiif', 'prevent-setInterval', 'setInterval-defuser'],
  'no-requestAnimationFrame-if': ['norafif', 'prevent-requestAnimationFrame'],
  'no-window-open-if': ['nowoif', 'prevent-window-open', 'window.open-defuser'],
  'noeval-if': ['prevent-eval-if'],
  noeval: [],
  nowebrtc: [],
  'remove-attr': ['ra'],
  'remove-class': ['rc'],
  'remove-node-text': ['rmnt'],
  'remove-cookie': ['cookie-remover'],
  'set-constant': ['set'],
  'set-attr': [],
  'set-cookie': [],
  'set-local-storage-item': [],
  'set-session-storage-item': [],
  'refresh-defuser': ['prevent-refresh'],
  'window.name-defuser': [],
});

const SCRIPTLET_ALIAS = new Map();
for (const [name, aliases] of Object.entries(SCRIPTLETS)) {
  SCRIPTLET_ALIAS.set(name.toLowerCase(), name);
  for (const a of aliases) SCRIPTLET_ALIAS.set(a.toLowerCase(), name);
}

/** Canonical scriptlet name, or null when we do not implement it (trusted-* never). */
export function scriptletName(name) {
  const n = String(name || '')
    .trim()
    .replace(/\.js$/, '')
    .toLowerCase();
  if (n.startsWith('trusted-')) return null;
  return SCRIPTLET_ALIAS.get(n) || null;
}

/**
 * Split scriptlet arguments: comma separated, trimmed, `\,` escapes a comma; an argument may be
 * quoted with ', " or ` to keep commas and surrounding spaces.
 * @param {string} s
 * @returns {string[]}
 */
export function parseScriptletArgs(s) {
  const args = [];
  let i = 0;
  const n = s.length;
  for (;;) {
    while (i < n && (s[i] === ' ' || s[i] === '\t')) i++;
    if (i >= n) {
      if (args.length && /,\s*$/.test(s)) args.push('');
      break;
    }
    const q = s[i];
    let done = false;
    if (q === '"' || q === "'" || q === '`') {
      // quoted: find the closing quote that is followed by optional spaces and a comma / the end
      let j = i + 1;
      let val = '';
      while (j < n) {
        if (s[j] === '\\' && s[j + 1] === q) {
          val += q;
          j += 2;
          continue;
        }
        if (s[j] === q) {
          let k = j + 1;
          while (k < n && (s[k] === ' ' || s[k] === '\t')) k++;
          if (k >= n || s[k] === ',') {
            args.push(val);
            i = k + 1;
            done = true;
            if (k >= n) i = n + 1;
            break;
          }
        }
        val += s[j];
        j++;
      }
      if (done) {
        if (i > n) break;
        continue;
      }
    }
    // unquoted: up to the next unescaped comma
    let val = '';
    let j = i;
    while (j < n) {
      if (s[j] === '\\' && s[j + 1] === ',') {
        val += ',';
        j += 2;
        continue;
      }
      if (s[j] === ',') break;
      val += s[j];
      j++;
    }
    args.push(val.trim());
    if (j >= n) break;
    i = j + 1;
    if (i >= n) {
      args.push('');
      break;
    }
  }
  return args;
}

/** `name, arg1, arg2` → [canonicalName, ...args], or null when unsupported. */
export function parseScriptletCall(inner) {
  const args = parseScriptletArgs(inner);
  if (!args.length) return null;
  const name = scriptletName(args[0]);
  if (!name) return null;
  if (args.length > 12 || args.some((a) => a.length > 2000)) return null;
  return [name, ...args.slice(1)];
}
