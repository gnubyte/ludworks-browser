// Content blocker engine.
//
// compile(lists) (run in a worker) turns filter lists into a compact, structured-clone friendly object:
// network filters are grouped by where the matcher will look for them — the request hostname
// (`||host^…`), the rarest token of their pattern, or the page's domain (`domain=` filters without a
// usable token) — and stored as raw filter text. `new Engine(compiled)` (main process) parses a group
// only the first time a request touches it, so startup costs a few Map constructions and most of the
// ~200k filters are never parsed at all. A request is tokenised once ([a-z0-9%] runs) and only the
// groups of its tokens, its hostname suffixes and its page's domain suffixes are checked.
//
// Matching follows the documented semantics: a request is blocked when a block filter matches and no
// exception does, unless the block filter is $important; `$document`/`$elemhide`/`$generichide`/
// `$specifichide` exceptions switch filtering off per page.

import { registrableDomain } from '../../lib/url-match.js';
import {
  TYPE,
  ALL_TYPES,
  DOC,
  listLines,
  isCosmetic,
  parseCosmeticFilter,
  parseNetworkFilter,
  normalizeNetworkLine,
  plainHost,
  filterKey,
  patternTokens,
  patternRegex,
  urlTokens,
  genericKey,
  methodBit,
} from './filters.js';

export const ENGINE_VERSION = 5;
const INDEXES = ['block', 'allow', 'important', 'removeparam', 'csp', 'docallow'];

// Tokens present in (nearly) every URL: a filter filed under one of them would be tested on almost
// every request, so they are only used when a filter has nothing better.
const COMMON_TOKENS = new Set(['http', 'https', 'www', 'com', 'net', 'org', 'js', 'css', 'html', 'htm', 'php', 'cdn', 'static', 'api', 'img', 'images', 'image', 'assets', 'min', 'json', 'gif', 'png', 'jpg', 'jpeg', 'webp', 'svg', 'ad', 'ads', 'www2', 'v1', 'v2', 'id', 'en', 'co', 'uk', 'de', 'io', 'media', 'content', 'wp', 'index', 'src', 'dist', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm', 'n', 'o', 'p', 'q', 'r', 's', 't', 'u', 'v', 'w', 'x', 'y', 'z']);

// ================================================================================= compiling
/**
 * Compile filter lists. `lists` = [{id, text}]; filters already seen in an earlier list are skipped.
 * @param {{id: string, text: string}[]} lists
 * @param {{badfilters?: string[]}} [opts]  extra `$badfilter` lines (from the user's own filters)
 */
export function compile(lists, { badfilters = [] } = {}) {
  const seen = new Set();
  const bad = new Set(badfilters.map(filterKey));
  const plain = [];
  const net = [];
  const cos = [];
  const stats = {};
  for (const { id, text } of lists) {
    const st = { network: 0, cosmetic: 0, unsupported: 0 };
    for (let line of listLines(String(text || ''))) {
      if (seen.has(line)) continue;
      seen.add(line);
      if (isCosmetic(line)) {
        const c = parseCosmeticFilter(line);
        if (c) {
          cos.push(c);
          st.cosmetic++;
        } else st.unsupported++;
        continue;
      }
      line = normalizeNetworkLine(line);
      const ph = plainHost(line);
      if (ph) {
        plain.push(ph);
        st.network++;
        continue;
      }
      const f = parseNetworkFilter(line);
      if (!f) {
        st.unsupported++;
        continue;
      }
      if (f.badfilter) {
        bad.add(filterKey(line));
        continue;
      }
      net.push(f);
      st.network++;
    }
    stats[id] = st;
  }
  const out = { version: ENGINE_VERSION, plainHosts: [], net: {}, cosmetic: null, stats, counts: { network: 0, cosmetic: cos.length } };
  for (const h of new Set(plain)) if (!bad.has(`||${h}^`)) out.plainHosts.push(h);
  const kept = bad.size ? net.filter((f) => !bad.has(filterKey(f.raw))) : net;
  out.counts.network = out.plainHosts.length + kept.length;
  // token frequency over all filters: each filter goes to its least used token
  const freq = new Map();
  for (const f of kept) {
    f._tokens = f.regex ? regexTokens(f.regex, f.matchCase) : f.host ? [] : patternTokens(f.matchCase ? f.pattern.toLowerCase() : f.pattern, f.hostAnchor, f.left, f.right);
    for (const t of f._tokens) freq.set(t, (freq.get(t) || 0) + 1);
  }
  const idx = Object.fromEntries(INDEXES.map((k) => [k, { hosts: new Map(), tokens: new Map(), domains: new Map(), any: [] }]));
  const put = (map, key, line) => {
    const l = map.get(key);
    if (l) l.push(line);
    else map.set(key, [line]);
  };
  for (const f of kept) {
    for (const name of indexesOf(f)) {
      const ix = idx[name];
      if (f.host) {
        put(ix.hosts, f.host, f.raw);
        continue;
      }
      let best = null;
      let bestScore = Infinity;
      for (const t of f._tokens) {
        const score = (freq.get(t) || 0) + (COMMON_TOKENS.has(t) ? 1e6 : 0) + (t.length < 3 ? 1000 : 0) - t.length / 100;
        if (score < bestScore) {
          best = t;
          bestScore = score;
        }
      }
      if (best && bestScore < 1e6) put(ix.tokens, best, f.raw);
      else if (f.domains && f.domains.inc && !f.domains.exc) for (const d of f.domains.inc) put(ix.domains, d, f.raw);
      else if (best) put(ix.tokens, best, f.raw);
      else ix.any.push(f.raw);
    }
  }
  const pack = (m) => [...m].map(([k, v]) => [k, v.join('\n')]);
  for (const name of INDEXES) {
    const ix = idx[name];
    out.net[name] = { hosts: pack(ix.hosts), tokens: pack(ix.tokens), domains: pack(ix.domains), any: ix.any.join('\n') };
  }
  out.cosmetic = compileCosmetic(cos);
  return out;
}

/** Which indexes a network filter belongs to. */
function indexesOf(f) {
  if (f.allow) {
    const out = [];
    if (f.docFlags) out.push('docallow');
    if (f.removeparam !== null) out.push('removeparam');
    else if (f.csp !== null) out.push('csp');
    else if (f.typeMask) out.push('allow');
    return out;
  }
  if (f.removeparam !== null) return ['removeparam'];
  if (f.csp !== null) return ['csp'];
  return [f.important ? 'important' : 'block'];
}

/**
 * Tokens a regex filter's matches must contain: literal [a-z0-9%] runs at the top level of the
 * expression (not inside a group, class or alternation), bounded by literal separators.
 */
function regexTokens(src, matchCase) {
  const s = matchCase ? src : src.toLowerCase();
  const out = [];
  let depth = 0;
  let inClass = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') {
      i++;
      continue;
    }
    if (inClass) {
      if (c === ']') inClass = false;
      continue;
    }
    if (c === '[') inClass = true;
    else if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === '|' && depth === 0) return []; // top-level alternation: no token is guaranteed
  }
  depth = 0;
  inClass = false;
  const boundary = (i) => {
    // literal separator at s[i] (escaped punctuation, '/', '-', '_', '=', '&', ':'), or anchor
    if (i < 0 || i >= s.length) return false;
    const c = s[i];
    return c === '/' || c === '-' || c === '_' || c === '=' || c === '&' || c === ':' || c === ',' || c === ';' || c === '!' || c === '~' || c === '@' || c === "'" || c === '"';
  };
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') {
      i++;
      continue;
    }
    if (inClass) {
      if (c === ']') inClass = false;
      continue;
    }
    if (c === '[') {
      inClass = true;
      continue;
    }
    if (c === '(') {
      depth++;
      continue;
    }
    if (c === ')') {
      depth--;
      continue;
    }
    const code = s.charCodeAt(i);
    if (!((code >= 97 && code <= 122) || (code >= 48 && code <= 57) || code === 37)) continue;
    let j = i + 1;
    while (j < s.length && /[a-z0-9%]/.test(s[j])) j++;
    const before = i - 1;
    const leftOk = depth === 0 && (i === 0 ? false : s[before] === '^' || (s[before - 1] === '\\' && /[./\-_?=&:]/.test(s[before])) || (boundary(before) && s[before - 1] !== '\\'));
    const next = s[j];
    const rightOk = depth === 0 && j < s.length && !/[?*+{]/.test(s[j + 1] || '') && (next === '$' || (next === '\\' && /[./\-_?=&:]/.test(s[j + 1] || '') && !/[?*+{]/.test(s[j + 2] || '')) || boundary(j));
    const quantified = /[?*+{]/.test(next || '');
    if (leftOk && rightOk && !quantified) out.push(s.slice(i, j));
    i = j - 1;
  }
  return out;
}

function compileCosmetic(list) {
  const m = () => new Map();
  const c = { hide: m(), hideExc: m(), style: m(), styleExc: m(), proc: m(), procExc: m(), js: m(), jsExc: m(), generic: m(), high: [], genericJs: [] };
  const genericExc = new Set();
  const genericJsExc = new Set();
  const put = (map, key, v) => {
    const l = map.get(key);
    if (l) l.push(v);
    else map.set(key, [v]);
  };
  const generic = [];
  for (const f of list) {
    const [map, exc] = f.kind === 'hide' ? [c.hide, c.hideExc] : f.kind === 'style' ? [c.style, c.styleExc] : f.kind === 'procedural' ? [c.proc, c.procExc] : [c.js, c.jsExc];
    if (f.exception) {
      if (!f.hosts.length) {
        if (f.kind === 'scriptlet') genericJsExc.add(f.body);
        else genericExc.add(f.body);
      }
      for (const h of f.hosts) put(exc, h, f.body);
      continue;
    }
    for (const h of f.notHosts) put(exc, h, f.body);
    if (f.hosts.length) {
      for (const h of f.hosts) put(map, h, f.body);
    } else if (f.kind === 'hide') generic.push(f.body);
    else if (f.kind === 'scriptlet') c.genericJs.push(f.body);
  }
  for (const sel of new Set(generic)) {
    if (genericExc.has(sel)) continue;
    const key = genericKey(sel);
    if (key) put(c.generic, key, sel);
    else c.high.push(sel);
  }
  c.genericJs = [...new Set(c.genericJs)].filter((b) => !genericJsExc.has(b));
  const pack = (mm) => [...mm].map(([k, v]) => [k, [...new Set(v)].join('\n')]);
  return {
    hide: pack(c.hide),
    hideExc: pack(c.hideExc),
    style: pack(c.style),
    styleExc: pack(c.styleExc),
    proc: pack(c.proc),
    procExc: pack(c.procExc),
    js: pack(c.js),
    jsExc: pack(c.jsExc),
    generic: pack(c.generic),
    high: c.high.join('\n'),
    genericJs: c.genericJs.join('\n'),
  };
}

// ================================================================================= hostnames
const HOST_CACHE = new Map();
const IP_RE = /^(\d{1,3}\.){3}\d{1,3}$|^\[|:/;

/**
 * Hostname facts used by the matcher: suffixes ("a.b.c" → a.b.c, b.c, c), entity keys
 * ("a.example.*", "example.*") and the registrable domain.
 * @param {string} host
 */
export function hostInfo(host) {
  let i = HOST_CACHE.get(host);
  if (i) return i;
  const suffixes = [];
  const entities = [];
  let domain = host;
  if (host && !IP_RE.test(host)) {
    domain = registrableDomain(host) || host;
    let h = host;
    for (;;) {
      suffixes.push(h);
      const d = h.indexOf('.');
      if (d < 0) break;
      h = h.slice(d + 1);
    }
    const dot = domain.indexOf('.');
    if (dot > 0) {
      const ps = domain.slice(dot); // ".co.uk"
      for (const s of suffixes) if (s.length > ps.length && s.endsWith(ps)) entities.push(`${s.slice(0, s.length - ps.length + 1)}*`);
    }
  } else if (host) suffixes.push(host);
  i = { host, domain, suffixes, entities };
  if (HOST_CACHE.size > 4000) HOST_CACHE.clear();
  HOST_CACHE.set(host, i);
  return i;
}

/** {host, hostEnd} of an absolute URL (hostEnd = index just after the hostname). */
export function urlHost(url) {
  const p = url.indexOf('://');
  if (p < 0) return { host: '', hostEnd: 0 };
  let start = p + 3;
  let end = start;
  const n = url.length;
  while (end < n) {
    const c = url.charCodeAt(end);
    if (c === 47 || c === 63 || c === 35) break; // / ? #
    end++;
  }
  // userinfo
  const at = url.lastIndexOf('@', end);
  if (at >= start) start = at + 1;
  let hostEnd = end;
  if (url.charCodeAt(start) === 91) {
    const rb = url.indexOf(']', start);
    if (rb > 0 && rb < end) hostEnd = rb + 1;
  } else {
    const colon = url.indexOf(':', start);
    if (colon >= 0 && colon < end) hostEnd = colon;
  }
  let host = url.slice(start, hostEnd).toLowerCase();
  if (host.endsWith('.')) host = host.slice(0, -1);
  return { host, hostEnd };
}

let GEN = 0;

/**
 * Everything the matcher needs about one request.
 * @param {string} url
 * @param {number} type      TYPE bit
 * @param {string} docUrl    URL (or origin) of the page/frame that made the request ('' = unknown)
 * @param {string} [method]
 */
export function requestContext(url, type, docUrl, method = 'GET') {
  const lurl = url.toLowerCase();
  const { host, hostEnd } = urlHost(lurl);
  const hinfo = hostInfo(host);
  const docHost = type === TYPE.DOCUMENT ? host : docUrl ? urlHost(docUrl.toLowerCase()).host : '';
  const dinfo = docHost ? hostInfo(docHost) : hinfo;
  return {
    url,
    lurl,
    host,
    hostEnd,
    hinfo,
    docHost: docHost || host,
    dinfo,
    third: !!docHost && dinfo.domain !== hinfo.domain,
    type,
    method: methodBit(method),
    tokens: urlTokens(lurl),
    gen: ++GEN,
  };
}

// ================================================================================== matching
const K_EMPTY = 1;
const K_PLAIN = 2;
const K_HOSTPATH = 3;
const K_REGEX = 4;
const K_HOST = 5;

function classify(f) {
  if (f.host) return (f.kind = K_HOST);
  if (f.regex) {
    f.re = new RegExp(f.regex, f.matchCase ? '' : 'i');
    return (f.kind = K_REGEX);
  }
  const p = f.pattern;
  if (!p) return (f.kind = K_EMPTY);
  const special = /[*^]/.test(p);
  if (!special && !f.hostAnchor) return (f.kind = K_PLAIN);
  if (!special && f.hostAnchor) {
    const m = /^([a-z0-9_.-]+)(\/.*)$/.exec(p);
    if (m && !m[1].startsWith('.') && !m[1].endsWith('.')) {
      f.hpart = m[1];
      f.rest = m[2];
      return (f.kind = K_HOSTPATH);
    }
  }
  f.re = patternRegex(f);
  return (f.kind = K_REGEX);
}

function testPattern(f, ctx) {
  const kind = f.kind || classify(f);
  switch (kind) {
    case K_HOST:
      return ctx.hinfo.suffixes.includes(f.host);
    case K_EMPTY:
      return true;
    case K_PLAIN: {
      const u = f.matchCase ? ctx.url : ctx.lurl;
      if (f.left) return f.right ? u === f.pattern : u.startsWith(f.pattern);
      if (f.right) return u.endsWith(f.pattern);
      return u.includes(f.pattern);
    }
    case K_HOSTPATH: {
      const h = ctx.host;
      const hp = f.hpart;
      if (!(h === hp || (h.endsWith(hp) && h.charCodeAt(h.length - hp.length - 1) === 46))) return false;
      const u = f.matchCase ? ctx.url : ctx.lurl;
      if (!u.startsWith(f.rest, ctx.hostEnd)) return false;
      return !f.right || u.length === ctx.hostEnd + f.rest.length;
    }
    default:
      // /regex/ filters see the URL as is (case-insensitive unless $match-case), patterns the lower-case URL
      return f.re.test(f.regex || f.matchCase ? ctx.url : ctx.lurl);
  }
}

/** Does a domain= / to= list apply to a host? Most specific entry wins. */
function domainMatch(d, info) {
  const { suffixes, entities } = info;
  for (let i = 0; i < suffixes.length; i++) {
    const s = suffixes[i];
    if (d.exc && d.exc.has(s)) return false;
    if (d.inc && d.inc.has(s)) return true;
    const e = entities[i];
    if (e) {
      if (d.exc && d.exc.has(e)) return false;
      if (d.inc && d.inc.has(e)) return true;
    }
  }
  return !d.inc;
}

function matches(f, ctx) {
  // typeMask 0: page-level exceptions ($generichide…), which only live in the docallow index
  if (f.typeMask !== 0 && (f.typeMask & ctx.type) === 0) return false;
  switch (f.party) {
    case 1:
      if (ctx.third) return false;
      break;
    case 2:
      if (!ctx.third) return false;
      break;
    case 3:
      if (ctx.host !== ctx.docHost) return false;
      break;
    case 4:
      if (ctx.host === ctx.docHost) return false;
      break;
    default:
  }
  if (f.methods && (f.methods & ctx.method) === 0) return false;
  if (!testPattern(f, ctx)) return false;
  if (f.domains && !domainMatch(f.domains, ctx.dinfo)) return false;
  if (f.to && !domainMatch(f.to, ctx.hinfo)) return false;
  if (f.denyallow) {
    for (const s of ctx.hinfo.suffixes) if (f.denyallow.has(s)) return false;
  }
  return true;
}

function parseLines(text) {
  const out = [];
  for (const line of text.split('\n')) {
    const f = parseNetworkFilter(line);
    if (f) out.push(f);
  }
  return out;
}

class NetIndex {
  constructor(d) {
    this.hosts = new Map(d.hosts);
    this.tokens = new Map(d.tokens);
    this.domains = new Map(d.domains);
    this.anyText = d.any;
    this.anyList = null;
    this.empty = !this.hosts.size && !this.tokens.size && !this.domains.size && !d.any;
  }

  get(map, key) {
    const v = map.get(key);
    if (v === undefined || typeof v !== 'string') return v;
    const list = parseLines(v);
    map.set(key, list);
    return list;
  }

  /**
   * First matching filter, or every matching filter when `all` is an array to fill.
   * @param {ReturnType<typeof requestContext>} ctx
   * @param {any[]|null} [all]
   */
  find(ctx, all = null) {
    if (this.empty) return null;
    const scan = (list) => {
      if (!list || list.gen === ctx.gen) return null;
      list.gen = ctx.gen;
      for (let i = 0; i < list.length; i++) {
        const f = list[i];
        if (matches(f, ctx)) {
          if (!all) return f;
          all.push(f);
        }
      }
      return null;
    };
    let r;
    if (this.hosts.size) for (const s of ctx.hinfo.suffixes) if ((r = scan(this.get(this.hosts, s)))) return r;
    if (this.tokens.size) for (const t of ctx.tokens) if ((r = scan(this.get(this.tokens, t)))) return r;
    if (this.domains.size) {
      const { suffixes, entities } = ctx.dinfo;
      for (const s of suffixes) if ((r = scan(this.get(this.domains, s)))) return r;
      for (const s of entities) if ((r = scan(this.get(this.domains, s)))) return r;
    }
    if (this.anyText) {
      if (!this.anyList) this.anyList = parseLines(this.anyText);
      if ((r = scan(this.anyList))) return r;
    }
    return null;
  }
}

const splitMap = (pairs) => new Map(pairs.map(([k, v]) => [k, v]));
const lines = (v) => (v ? (typeof v === 'string' ? v.split('\n') : v) : []);

let ENGINE_ID = 0;

export class Engine {
  /** @param {ReturnType<typeof compile>} c */
  constructor(c) {
    if (!c || c.version !== ENGINE_VERSION) throw new Error('incompatible compiled filters');
    this.id = ++ENGINE_ID;
    this.plain = new Set(c.plainHosts);
    this.net = {};
    for (const k of INDEXES) this.net[k] = new NetIndex(c.net[k]);
    const co = c.cosmetic;
    this.cos = {
      hide: splitMap(co.hide),
      hideExc: splitMap(co.hideExc),
      style: splitMap(co.style),
      styleExc: splitMap(co.styleExc),
      proc: splitMap(co.proc),
      procExc: splitMap(co.procExc),
      js: splitMap(co.js),
      jsExc: splitMap(co.jsExc),
      generic: splitMap(co.generic),
      high: lines(co.high),
      genericJs: lines(co.genericJs),
    };
    this.stats = c.stats;
    this.counts = c.counts;
  }

  /** A block filter matching the request (plain host list first), or null. */
  blockFilter(ctx) {
    if (this.plain.size) {
      for (const s of ctx.hinfo.suffixes) if (this.plain.has(s)) return { raw: `||${s}^`, typeMask: ALL_TYPES };
    }
    return this.net.block.find(ctx);
  }

  /** Cosmetic lookup helper: values of `map` for every key, split into lines. */
  collect(map, keys, out) {
    for (const k of keys) {
      const v = map.get(k);
      if (v === undefined) continue; // '' is a value: `#@#+js()` (every scriptlet off)
      const arr = typeof v === 'string' ? v.split('\n') : v;
      if (typeof v === 'string') map.set(k, arr);
      for (const s of arr) out.push(s);
    }
    return out;
  }
}

// ======================================================================== multi-engine verdicts
// The browser runs two engines: the filter lists and the user's own filters. Exceptions in either
// apply to blocks from both.

/**
 * @param {Engine[]} engines
 * @param {ReturnType<typeof requestContext>} ctx
 * @returns {{block: boolean, filter: string, important?: boolean}|null}
 */
export function matchRequest(engines, ctx) {
  for (const e of engines) {
    const f = e.net.important.find(ctx);
    if (f) return { block: true, important: true, filter: f.raw };
  }
  let blk = null;
  for (const e of engines) if ((blk = e.blockFilter(ctx))) break;
  if (!blk) return null;
  for (const e of engines) {
    const a = e.net.allow.find(ctx);
    if (a) return { block: false, filter: a.raw };
  }
  return { block: true, filter: blk.raw };
}

/** URL with `$removeparam` parameters removed, or null when nothing changes. */
export function stripParams(engines, ctx) {
  const q = ctx.url.indexOf('?');
  if (q < 0) return null;
  const all = [];
  for (const e of engines) e.net.removeparam.find(ctx, all);
  if (!all.length) return null;
  const off = new Set();
  for (const f of all) if (f.allow) off.add(f.removeparam);
  if (off.has('')) return null;
  const rules = all.filter((f) => !f.allow && !off.has(f.removeparam)).map((f) => f.removeparam);
  if (!rules.length) return null;
  const hash = ctx.url.indexOf('#', q);
  const query = ctx.url.slice(q + 1, hash < 0 ? undefined : hash);
  const parts = query.split('&');
  const keep = parts.filter((p) => {
    if (!p) return false;
    const name = p.split('=')[0];
    for (const r of rules) {
      if (r === '') return false;
      if (r.startsWith('/')) {
        const m = /^\/(.*)\/([a-z]*)$/.exec(r);
        try {
          if (m && new RegExp(m[1], m[2].replace(/[^imsu]/g, '')).test(p)) return false;
        } catch {
          /* bad regex: ignore */
        }
      } else if (r.startsWith('~')) {
        if (name !== r.slice(1)) return false;
      } else if (name === r) return false;
    }
    return true;
  });
  if (keep.length === parts.filter(Boolean).length) return null;
  const base = ctx.url.slice(0, q);
  return base + (keep.length ? `?${keep.join('&')}` : '') + (hash < 0 ? '' : ctx.url.slice(hash));
}

/** CSP directives to add to a document response. */
export function cspFor(engines, ctx) {
  const all = [];
  for (const e of engines) e.net.csp.find(ctx, all);
  if (!all.length) return [];
  const off = new Set();
  for (const f of all) if (f.allow) off.add(f.csp);
  if (off.has('')) return [];
  return [...new Set(all.filter((f) => !f.allow && !off.has(f.csp)).map((f) => f.csp))];
}

/** Page-level exception flags (DOC bits) for a page/frame URL. */
export function docFlags(engines, url) {
  const ctx = requestContext(url, TYPE.DOCUMENT, url);
  ctx.type = ALL_TYPES;
  const all = [];
  for (const e of engines) e.net.docallow.find(ctx, all);
  let flags = 0;
  for (const f of all) flags |= f.docFlags;
  return flags;
}

const hideCss = (sels) => (sels.length ? `${sels.join('{display:none!important}\n')}{display:none!important}\n` : '');

/**
 * Cosmetic filtering for a frame on `host`: CSS for specific hide/style filters (and the always-on
 * generic selectors), procedural selectors and scriptlet calls.
 * @param {Engine[]} engines
 * @param {string} host
 * @param {number} flags DOC bits for the frame
 */
export function cosmeticFor(engines, host, flags) {
  const info = hostInfo(host);
  const keys = info.host ? [...info.suffixes, ...info.entities] : [];
  const res = { css: '', hide: 0, procedural: [], scriptlets: [], generic: false, exceptions: null };
  if (flags & DOC.ELEMHIDE) return res;
  const hideExc = new Set();
  const styleExc = new Set();
  const procExc = new Set();
  const jsExc = new Set();
  for (const e of engines) {
    for (const s of e.collect(e.cos.hideExc, keys, [])) hideExc.add(s);
    for (const s of e.collect(e.cos.styleExc, keys, [])) styleExc.add(s);
    for (const s of e.collect(e.cos.procExc, keys, [])) procExc.add(s);
    for (const s of e.collect(e.cos.jsExc, keys, [])) jsExc.add(s);
  }
  const hide = new Set();
  const styles = new Set();
  const proc = new Set();
  const js = new Set();
  if (!(flags & DOC.SPECIFICHIDE)) {
    for (const e of engines) {
      for (const s of e.collect(e.cos.hide, keys, [])) if (!hideExc.has(s)) hide.add(s);
      for (const s of e.collect(e.cos.style, keys, [])) if (!styleExc.has(s)) styles.add(s);
      for (const s of e.collect(e.cos.proc, keys, [])) if (!procExc.has(s)) proc.add(s);
      if (!jsExc.has('')) for (const s of e.collect(e.cos.js, keys, [])) if (!jsExc.has(s)) js.add(s);
    }
  }
  if (!jsExc.has('')) for (const e of engines) for (const s of e.cos.genericJs) if (!jsExc.has(s)) js.add(s);
  let css = hideCss([...hide]);
  if (styles.size) css += `${[...styles].map((s) => s.replace(/\{([^}]*)\}$/, (_m, d) => `{${d.replace(/\s*!important\s*/g, '').replace(/;\s*$/, '').split(';').map((x) => `${x.trim()} !important`).join(';')}}`)).join('\n')}\n`;
  res.hide = hide.size + styles.size;
  res.generic = !(flags & DOC.GENERICHIDE);
  if (res.generic) {
    for (const e of engines) {
      const high = hideExc.size ? e.cos.high.filter((s) => !hideExc.has(s)) : e.cos.high;
      if (!hideExc.size) {
        if (!e.highCss) e.highCss = hideCss(e.cos.high);
        css += e.highCss;
      } else css += hideCss(high);
    }
  }
  res.css = css;
  res.procedural = [...proc];
  res.scriptlets = [...js].map((b) => JSON.parse(b));
  res.exceptions = hideExc;
  return res;
}

/**
 * Generic hide selectors for the classes/ids found in a frame (`.cls`, `#id` keys), minus the
 * page's exceptions.
 * @param {Engine[]} engines
 * @param {string[]} keys
 * @param {Set<string>|null} exceptions
 */
export function genericSelectors(engines, keys, exceptions) {
  const out = [];
  for (const e of engines) {
    if (!e.cos.generic.size) continue;
    for (const k of keys) {
      const v = e.cos.generic.get(k);
      if (!v) continue;
      const arr = typeof v === 'string' ? v.split('\n') : v;
      if (typeof v === 'string') e.cos.generic.set(k, arr);
      for (const s of arr) if (!exceptions || !exceptions.has(s)) out.push(s);
    }
  }
  return out;
}

export { hideCss };
