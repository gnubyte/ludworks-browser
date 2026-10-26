// Integration-test browser environment: a faithful fake of the WebExtension APIs the extension uses
// (storage.local/session, alarms, runtime messaging, permissions, scripting, tabs, idle, action, commands,
// offscreen on Chrome, webRequest + getSecurityInfo on Firefox) plus a browser-like network stack that the
// background's fetch goes through. Node built-ins only.
//
// Network fidelity (what makes the live-server tests meaningful):
//   * every request from an extension context carries `Origin: chrome-extension://<id>` / `moz-extension://<uuid>`;
//   * requests to hosts the extension holds a host permission for bypass CORS (as in real browsers); all other
//     cross-origin requests go through a real CORS check: preflight for non-simple requests, then
//     Access-Control-Allow-Origin / -Credentials on the response, CORS-filtered response headers;
//   * credentials: 'omit' never sends or stores cookies; 'include' uses the browser profile's cookie jar
//     (shared with "web app tabs"), with Set-Cookie hidden from scripts;
//   * redirect: 'error' fails on 3xx; HTTPS uses the profile's trust store (self-signed certificates must be
//     trusted explicitly, like a user accepting them in a tab) and exposes the presented certificate to the
//     Firefox webRequest.getSecurityInfo emulation; blocking onHeadersReceived listeners can cancel a response.

import http from 'node:http';
import https from 'node:https';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';

// ------------------------------------------------------------------------------------------------ helpers

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const tick = () => new Promise((r) => setImmediate(r));

export function createEvent() {
  const listeners = [];
  return {
    listeners,
    addListener(fn, ...extra) {
      if (typeof fn !== 'function') throw new TypeError('listener must be a function');
      listeners.push({ fn, extra });
    },
    removeListener(fn) {
      const i = listeners.findIndex((l) => l.fn === fn);
      if (i >= 0) listeners.splice(i, 1);
    },
    hasListener: (fn) => listeners.some((l) => l.fn === fn),
    hasListeners: () => listeners.length > 0,
    dispatch(...args) {
      return [...listeners].map((l) => l.fn(...args));
    },
  };
}

/** Virtual wall clock: Date.now() = real time + offset (so the code under test sees time jump). */
export function installClock() {
  const realNow = Date.now.bind(Date);
  let offset = 0;
  Date.now = () => realNow() + offset;
  return {
    get offset() {
      return offset;
    },
    advance(ms) {
      offset += ms;
    },
    reset() {
      offset = 0;
    },
    uninstall() {
      Date.now = realNow;
    },
  };
}

// ---------------------------------------------------------------------------------------- match patterns

/** Parse a WebExtension match pattern (ports are not part of patterns: they match every port). */
export function parsePattern(p) {
  if (p === '<all_urls>') return { scheme: '*', host: '*', path: '/*', all: true };
  const m = /^(\*|https?|wss?|file|ftp):\/\/(\*|\*\.[^/*]+|[^/*]+)(\/.*)$/.exec(p);
  if (!m) throw new Error(`Invalid match pattern '${p}'`);
  return { scheme: m[1], host: m[2], path: m[3] };
}

function globToRe(glob) {
  return new RegExp(`^${glob.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
}

function hostMatches(patHost, host) {
  if (patHost === '*') return true;
  if (patHost.startsWith('*.')) {
    const base = patHost.slice(2);
    return host === base || host.endsWith(`.${base}`);
  }
  return patHost === host;
}

/** Does match pattern `p` match URL `url`? */
export function patternMatchesUrl(p, url) {
  const pat = parsePattern(p);
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  const scheme = u.protocol.slice(0, -1);
  if (pat.scheme === '*' ? !['http', 'https', 'ws', 'wss'].includes(scheme) : pat.scheme !== scheme) return false;
  if (!hostMatches(pat.host, u.hostname.replace(/^\[|\]$/g, ''))) return false;
  return globToRe(pat.path).test(u.pathname + u.search);
}

/** Does granted pattern `a` cover requested pattern `b`? */
function patternCovers(a, b) {
  const A = parsePattern(a);
  const B = parsePattern(b);
  if (A.all) return true;
  if (A.scheme !== '*' && A.scheme !== B.scheme) return false;
  if (A.scheme === '*' && !['*', 'http', 'https', 'ws', 'wss'].includes(B.scheme)) return false;
  if (A.host !== '*') {
    if (B.host === '*') return false;
    const bh = B.host.startsWith('*.') ? B.host.slice(2) : B.host;
    if (A.host.startsWith('*.')) {
      if (!hostMatches(A.host, bh)) return false;
    } else if (B.host.startsWith('*.') || A.host !== B.host) return false;
  }
  return globToRe(A.path).test(B.path.replace(/\*/g, '')) || A.path === '/*';
}

// ----------------------------------------------------------------------------------------------- storage

const SESSION_QUOTA = 10 * 1024 * 1024;

function createStorageArea(name, onChanged, { quota = Infinity } = {}) {
  const data = new Map();
  const areaChanged = createEvent();
  const notify = (changes) => {
    if (!Object.keys(changes).length) return;
    setImmediate(() => {
      areaChanged.dispatch(clone(changes));
      onChanged.dispatch(clone(changes), name);
    });
  };
  const size = () => [...data].reduce((n, [k, v]) => n + k.length + JSON.stringify(v).length, 0);
  const area = {
    data,
    onChanged: areaChanged,
    QUOTA_BYTES: quota,
    async get(keys) {
      await tick();
      const out = {};
      if (keys === null || keys === undefined) {
        for (const [k, v] of data) out[k] = clone(v);
        return out;
      }
      const list = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
      for (const k of list) {
        if (data.has(k)) out[k] = clone(data.get(k));
        else if (keys && typeof keys === 'object' && !Array.isArray(keys) && keys[k] !== undefined) out[k] = keys[k];
      }
      return out;
    },
    async set(items) {
      await tick();
      if (!items || typeof items !== 'object') throw new TypeError('storage.set expects an object');
      const changes = {};
      const before = new Map(data);
      for (const [k, v] of Object.entries(items)) {
        if (v === undefined) continue;
        const nv = clone(v);
        const ov = data.get(k);
        data.set(k, nv);
        if (JSON.stringify(ov) !== JSON.stringify(nv)) changes[k] = { oldValue: ov, newValue: nv };
      }
      if (size() > quota) {
        data.clear();
        for (const [k, v] of before) data.set(k, v);
        throw new Error(`QUOTA_BYTES quota exceeded (storage.${name})`);
      }
      notify(changes);
    },
    async remove(keys) {
      await tick();
      const changes = {};
      for (const k of typeof keys === 'string' ? [keys] : keys) {
        if (data.has(k)) changes[k] = { oldValue: data.get(k) };
        data.delete(k);
      }
      notify(changes);
    },
    async clear() {
      await tick();
      const changes = {};
      for (const [k, v] of data) changes[k] = { oldValue: v };
      data.clear();
      notify(changes);
    },
    async getBytesInUse() {
      return size();
    },
  };
  return area;
}

// ----------------------------------------------------------------------------------------------- network

const SAFELISTED_REQ = new Set(['accept', 'accept-language', 'content-language', 'content-type']);
const SIMPLE_CT = new Set(['application/x-www-form-urlencoded', 'multipart/form-data', 'text/plain']);
const SAFELISTED_RES = new Set(['cache-control', 'content-language', 'content-length', 'content-type', 'expires', 'last-modified', 'pragma']);
// Request headers scripts cannot set (Fetch spec "forbidden request-header"); the browser sets its own.
const FORBIDDEN_REQ = new Set([
  'accept-charset', 'accept-encoding', 'access-control-request-headers', 'access-control-request-method', 'connection',
  'content-length', 'cookie', 'cookie2', 'date', 'dnt', 'expect', 'host', 'keep-alive', 'origin', 'referer',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'via',
]);

function splitList(v) {
  return String(v || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/** Minimal cookie jar (host-only cookies, enough for the Ludworks session cookie). */
export function createCookieJar() {
  const cookies = new Map(); // `${host}|${name}` -> {host, name, value, path, sameSite, httpOnly, expires}
  return {
    cookies,
    store(url, setCookieHeaders) {
      const u = new URL(url);
      for (const line of setCookieHeaders) {
        const [pair, ...attrs] = line.split(';').map((s) => s.trim());
        const eq = pair.indexOf('=');
        if (eq <= 0) continue;
        const c = { host: u.hostname, name: pair.slice(0, eq), value: pair.slice(eq + 1), path: '/', sameSite: 'lax', httpOnly: false, expires: null };
        for (const a of attrs) {
          const [k, v = ''] = a.split('=');
          const key = k.toLowerCase();
          if (key === 'path') c.path = v || '/';
          else if (key === 'samesite') c.sameSite = v.toLowerCase();
          else if (key === 'httponly') c.httpOnly = true;
          else if (key === 'max-age') c.expires = Date.now() + Number(v) * 1000;
          else if (key === 'expires' && c.expires === null) c.expires = Date.parse(v);
        }
        const id = `${c.host}|${c.name}`;
        if (c.expires !== null && c.expires <= Date.now()) cookies.delete(id);
        else cookies.set(id, c);
      }
    },
    header(url) {
      const u = new URL(url);
      const out = [];
      for (const c of cookies.values()) {
        if (c.host !== u.hostname || !u.pathname.startsWith(c.path)) continue;
        if (c.expires !== null && c.expires <= Date.now()) continue;
        out.push(`${c.name}=${c.value}`);
      }
      return out.join('; ');
    },
    clear() {
      cookies.clear();
    },
  };
}

/**
 * One HTTP(S) exchange over node:http(s). Never follows redirects.
 * @returns {Promise<{status: number, statusText: string, headers: Array<[string,string]>, body: Buffer, cert: any, secure: boolean}>}
 */
export function rawRequest(url, { method = 'GET', headers = {}, body = null, signal, ca = [] } = {}) {
  const u = new URL(url);
  const isHttps = u.protocol === 'https:';
  const mod = isHttps ? https : http;
  const hdrs = { ...headers };
  if (body && body.length) hdrs['content-length'] = String(body.length);
  return new Promise((resolve, reject) => {
    const req = mod.request(
      {
        method,
        hostname: u.hostname.replace(/^\[|\]$/g, ''),
        port: u.port || (isHttps ? 443 : 80),
        path: u.pathname + u.search,
        headers: hdrs,
        agent: false,
        signal,
        ...(isHttps ? { ca: ca.length ? ca : undefined, servername: /^[\d.]+$|:/.test(u.hostname) ? undefined : u.hostname } : {}),
      },
      (res) => {
        let cert = null;
        if (isHttps && res.socket && typeof res.socket.getPeerCertificate === 'function') {
          const pc = res.socket.getPeerCertificate();
          if (pc && pc.fingerprint256) cert = { fingerprint256: pc.fingerprint256, subject: pc.subject, raw: pc.raw };
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const list = [];
          for (let i = 0; i < res.rawHeaders.length; i += 2) list.push([res.rawHeaders[i].toLowerCase(), res.rawHeaders[i + 1]]);
          resolve({ status: res.statusCode, statusText: res.statusMessage || '', headers: list, body: Buffer.concat(chunks), cert, secure: isHttps });
        });
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    if (body && body.length) req.write(body);
    req.end();
  });
}

function headerValues(list, name) {
  return list.filter(([k]) => k === name).map(([, v]) => v);
}

/**
 * Browser network stack for one profile.
 * @param {{kind: 'chrome'|'firefox', origin: string, hostPermitted: (url: string) => boolean,
 *   onHeadersReceived?: (details: object) => Promise<{cancel?: boolean}|undefined>}} opts
 */
export function createNetwork({ kind, origin, hostPermitted, onHeadersReceived = null }) {
  const trusted = []; // PEM certificates the profile trusts
  const jar = createCookieJar();
  const log = [];
  let requestSeq = 0;
  const securityInfo = new Map();
  let offline = false;

  const networkError = (cause) => {
    const e = new TypeError(kind === 'firefox' ? 'NetworkError when attempting to fetch resource.' : 'Failed to fetch');
    if (cause) e.cause = cause;
    return e;
  };

  async function exchange(url, opts) {
    if (offline) throw new Error('net::ERR_INTERNET_DISCONNECTED');
    return rawRequest(url, { ...opts, ca: trusted });
  }

  /** fetch() as seen by an extension context (background, popup, offscreen). */
  async function extFetch(input, init = {}) {
    const req = new Request(input, init);
    const url = new URL(req.url);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw networkError(new Error('unsupported scheme'));
    if (req.signal && req.signal.aborted) throw req.signal.reason || new DOMException('The operation was aborted.', 'AbortError');
    const method = req.method.toUpperCase();
    const body = method === 'GET' || method === 'HEAD' ? null : Buffer.from(await req.arrayBuffer());
    const privileged = hostPermitted(url.href);
    const headers = {};
    for (const [k, v] of req.headers) if (!FORBIDDEN_REQ.has(k) && !k.startsWith('sec-') && !k.startsWith('proxy-')) headers[k] = v;
    headers.origin = origin; // extension pages and workers are cross-origin to every server
    headers['user-agent'] = kind === 'firefox' ? 'Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0' : 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
    const credentials = req.credentials; // Request defaults to 'same-origin' == omit for cross-origin
    const sendCookies = credentials === 'include';
    if (sendCookies) {
      const c = jar.header(url.href);
      if (c) headers.cookie = c;
    }
    const entry = { method, url: url.href, privileged, headers: { ...headers }, preflight: null, status: 0, blocked: null };
    log.push(entry);

    if (!privileged) {
      // ---- real CORS: preflight for non-simple requests
      const nonSafe = Object.keys(headers).filter((k) => {
        if (k === 'origin' || k === 'cookie' || k === 'user-agent') return false;
        if (!SAFELISTED_REQ.has(k)) return true;
        if (k === 'content-type') return !SIMPLE_CT.has(headers[k].split(';')[0].trim().toLowerCase());
        return false;
      });
      const simpleMethod = ['GET', 'HEAD', 'POST'].includes(method);
      if (!simpleMethod || nonSafe.length) {
        const pre = await exchange(url.href, {
          method: 'OPTIONS',
          headers: {
            origin,
            'access-control-request-method': method,
            ...(nonSafe.length ? { 'access-control-request-headers': nonSafe.sort().join(',') } : {}),
          },
          signal: req.signal,
        }).catch((e) => {
          throw networkError(e);
        });
        const h = (n) => (headerValues(pre.headers, n)[0] || '');
        const acao = h('access-control-allow-origin');
        const okOrigin = acao === origin || (acao === '*' && !sendCookies);
        const methods = splitList(h('access-control-allow-methods'));
        const allowHeaders = splitList(h('access-control-allow-headers'));
        const okMethod = simpleMethod || methods.includes(method.toLowerCase()) || (methods.includes('*') && !sendCookies);
        const okHeaders = nonSafe.every((x) => allowHeaders.includes(x) || (allowHeaders.includes('*') && x !== 'authorization' && !sendCookies));
        const okCreds = !sendCookies || h('access-control-allow-credentials') === 'true';
        entry.preflight = { status: pre.status, acao, methods, allowHeaders };
        if (pre.status < 200 || pre.status > 299 || !okOrigin || !okMethod || !okHeaders || !okCreds) {
          entry.blocked = 'preflight';
          throw networkError(new Error(`CORS preflight rejected (status ${pre.status}, ACAO '${acao}')`));
        }
      }
    }

    let res;
    try {
      res = await exchange(url.href, { method, headers, body, signal: req.signal });
    } catch (e) {
      if (req.signal && req.signal.aborted) throw req.signal.reason || new DOMException('The operation was aborted.', 'AbortError');
      throw networkError(e);
    }
    entry.status = res.status;
    const requestId = String(++requestSeq);
    securityInfo.set(requestId, res.secure && res.cert
      ? { state: 'secure', certificates: [{ fingerprint: { sha256: res.cert.fingerprint256 }, subject: res.cert.subject }] }
      : { state: 'insecure', certificates: [] });
    if (onHeadersReceived && privileged) {
      const verdict = await onHeadersReceived({ requestId, url: url.href, method, statusCode: res.status, responseHeaders: res.headers.map(([name, value]) => ({ name, value })) });
      if (verdict && verdict.cancel) {
        entry.blocked = 'webRequest';
        throw networkError(new Error('cancelled by webRequest'));
      }
    }
    if (credentials !== 'omit') {
      const sc = headerValues(res.headers, 'set-cookie');
      if (sc.length && (privileged || sendCookies)) jar.store(url.href, sc);
    }
    if (res.status >= 300 && res.status < 400 && headerValues(res.headers, 'location').length) {
      if (req.redirect === 'error') throw networkError(new Error('redirect not allowed'));
      if (req.redirect === 'follow') return extFetch(new URL(headerValues(res.headers, 'location')[0], url).href, { ...init, method: res.status === 303 ? 'GET' : method, body: res.status === 303 ? undefined : init.body });
    }
    const resHeaders = new Headers();
    if (privileged) {
      for (const [k, v] of res.headers) if (k !== 'set-cookie' && k !== 'set-cookie2') resHeaders.append(k, v);
    } else {
      const h = (n) => (headerValues(res.headers, n)[0] || '');
      const acao = h('access-control-allow-origin');
      if (!(acao === origin || (acao === '*' && !sendCookies)) || (sendCookies && h('access-control-allow-credentials') !== 'true')) {
        entry.blocked = 'response';
        throw networkError(new Error(`CORS: response has no matching Access-Control-Allow-Origin ('${acao}')`));
      }
      const exposed = new Set(splitList(h('access-control-expose-headers')));
      for (const [k, v] of res.headers) if (SAFELISTED_RES.has(k) || exposed.has(k)) resHeaders.append(k, v);
    }
    const nullBody = [101, 103, 204, 205, 304].includes(res.status) || method === 'HEAD';
    return new Response(nullBody ? null : res.body, { status: res.status, statusText: res.statusText, headers: resHeaders });
  }

  return {
    fetch: extFetch,
    jar,
    log,
    trust(pem) {
      if (!trusted.includes(pem)) trusted.push(pem);
    },
    untrustAll() {
      trusted.length = 0;
    },
    get trusted() {
      return [...trusted];
    },
    setOffline(v) {
      offline = !!v;
    },
    getSecurityInfo(requestId) {
      return securityInfo.get(String(requestId)) || null;
    },
  };
}

// ------------------------------------------------------------------------------------------ the browser

/**
 * A browser profile with one installed extension.
 * @param {{kind: 'chrome'|'firefox', extensionId?: string, manifest: object, extensionDir: string,
 *          clock?: ReturnType<typeof installClock>}} opts
 */
export function createBrowser({ kind, extensionId, manifest, extensionDir, clock = null }) {
  const id = extensionId || (kind === 'firefox' ? 'passwords@ludworks.app' : 'kdhgflmnbcjpcmdnhcjbmhakakhokfli');
  const internalUuid = '7f3a9c2e-1b4d-4e6f-8a0b-2c3d4e5f6a7b';
  const extOrigin = kind === 'firefox' ? `moz-extension://${internalUuid}` : `chrome-extension://${id}`;
  const storageChanged = createEvent();
  const storage = {
    local: createStorageArea('local', storageChanged),
    session: createStorageArea('session', storageChanged, { quota: SESSION_QUOTA }),
  };
  let sessionAccessLevel = 'TRUSTED_CONTEXTS';

  const optional = new Set([...(manifest.optional_host_permissions || []), ...(manifest.optional_permissions || [])]);
  const granted = { origins: new Set(manifest.host_permissions || []), permissions: new Set(manifest.permissions || []) };
  const permAdded = createEvent();
  const permRemoved = createEvent();
  let gestureDepth = 0;
  let promptAnswer = () => true; // the "user" answering the permission prompt

  const tabs = new Map(); // id -> {id, url, active, windowId, page, activeTabGrant}
  const tabRemoved = createEvent();
  const registeredScripts = new Map();
  const alarmsMap = new Map();
  const alarmEvent = createEvent();
  const alarmTimers = new Map();
  const idleChanged = createEvent();
  let idleInterval = 60;
  const commandEvent = createEvent();
  const badge = { title: manifest.action && manifest.action.default_title, text: new Map(), color: new Map(), popupOpens: 0 };
  let offscreenDoc = null;
  const webRequestListeners = [];
  const contexts = new Set();
  const lifecycle = { installed: createEvent(), startup: createEvent() };
  const clipboard = { value: '' };

  const hostPermitted = (url) => [...granted.origins].some((p) => {
    try {
      return patternMatchesUrl(p, url);
    } catch {
      return false;
    }
  });

  const network = createNetwork({
    kind,
    origin: extOrigin,
    hostPermitted,
    onHeadersReceived: kind === 'firefox'
      ? async (details) => {
          for (const l of [...webRequestListeners]) {
            const urls = (l.filter && l.filter.urls) || ['<all_urls>'];
            if (!urls.some((p) => patternMatchesUrl(p, details.url))) continue;
            const r = await l.fn(details);
            if (r && r.cancel && l.extra.includes('blocking')) return { cancel: true };
          }
          return undefined;
        }
      : null,
  });

  // ---- alarms: fire on their own (real timer) and when the virtual clock is advanced
  function scheduleAlarmTimer(name) {
    clearTimeout(alarmTimers.get(name));
    const a = alarmsMap.get(name);
    if (!a) return;
    const t = setTimeout(() => fireDueAlarms(), Math.max(0, a.scheduledTime - Date.now()));
    t.unref();
    alarmTimers.set(name, t);
  }
  function fireDueAlarms() {
    const now = Date.now();
    for (const a of [...alarmsMap.values()]) {
      if (a.scheduledTime > now) continue;
      if (a.periodInMinutes) {
        a.scheduledTime = now + a.periodInMinutes * 60000;
        scheduleAlarmTimer(a.name);
      } else {
        alarmsMap.delete(a.name);
        clearTimeout(alarmTimers.get(a.name));
      }
      alarmEvent.dispatch({ name: a.name, scheduledTime: a.scheduledTime, periodInMinutes: a.periodInMinutes });
    }
  }

  function requireGesture(api) {
    if (gestureDepth <= 0) throw new Error(`${api} may only be called from a user gesture.`);
  }

  // ---- messaging between extension contexts
  async function deliverRuntime(from, msg, sender) {
    const payload = JSON.stringify(msg === undefined ? null : msg);
    await tick();
    const targets = [...contexts].filter((c) => c !== from && c.type !== 'content' && c.onMessage.hasListeners());
    if (!targets.length) throw new Error('Could not establish connection. Receiving end does not exist.');
    return new Promise((resolve, reject) => {
      let done = false;
      let open = 0;
      const respond = (v) => {
        if (done) return;
        done = true;
        resolve(v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
      };
      for (const t of targets) {
        for (const l of [...t.onMessage.listeners]) {
          let r;
          try {
            r = l.fn(JSON.parse(payload), clone(sender), respond);
          } catch (e) {
            if (!done) {
              done = true;
              reject(e);
            }
            return;
          }
          if (r === true) open++;
          else if (r && typeof r.then === 'function' && kind === 'firefox') {
            open++;
            r.then(respond, (e) => {
              if (!done) {
                done = true;
                reject(new Error(String((e && e.message) || e)));
              }
            });
          }
        }
      }
      if (!done && open === 0) {
        done = true;
        reject(new Error('The message port closed before a response was received.'));
      }
    });
  }

  function namespaceFor(ctx) {
    const onMessage = ctx.onMessage;
    const ns = {
      runtime: {
        id,
        getURL: (p = '') => `${extOrigin}/${String(p).replace(/^\//, '')}`,
        getManifest: () => clone(manifest),
        sendMessage: (msg) => deliverRuntime(ctx, msg, ctx.senderInfo()),
        onMessage,
        onInstalled: lifecycle.installed,
        onStartup: lifecycle.startup,
        lastError: undefined,
      },
      storage: {
        local: storage.local,
        session: Object.assign(Object.create(storage.session), {
          async setAccessLevel({ accessLevel }) {
            if (ctx.type !== 'background') throw new Error('setAccessLevel is only available in privileged contexts');
            sessionAccessLevel = accessLevel;
          },
        }),
        onChanged: storageChanged,
      },
      alarms: {
        async create(name, info = {}) {
          if (typeof name === 'object') {
            info = name;
            name = '';
          }
          let when = info.when ?? (info.delayInMinutes !== undefined ? Date.now() + info.delayInMinutes * 60000 : undefined);
          if (when === undefined && info.periodInMinutes) when = Date.now() + info.periodInMinutes * 60000;
          if (when === undefined) throw new Error('alarms.create: when, delayInMinutes or periodInMinutes is required');
          alarmsMap.set(name, { name, scheduledTime: when, periodInMinutes: info.periodInMinutes });
          scheduleAlarmTimer(name);
        },
        async get(name = '') {
          return clone(alarmsMap.get(name));
        },
        async getAll() {
          return clone([...alarmsMap.values()]);
        },
        async clear(name = '') {
          clearTimeout(alarmTimers.get(name));
          return alarmsMap.delete(name);
        },
        async clearAll() {
          for (const n of alarmsMap.keys()) clearTimeout(alarmTimers.get(n));
          alarmsMap.clear();
          return true;
        },
        onAlarm: alarmEvent,
      },
      permissions: {
        async contains({ origins = [], permissions = [] } = {}) {
          return origins.every((o) => [...granted.origins].some((g) => patternCovers(g, o))) && permissions.every((p) => granted.permissions.has(p));
        },
        async getAll() {
          return { origins: [...granted.origins], permissions: [...granted.permissions] };
        },
        request({ origins = [], permissions = [] } = {}) {
          // Synchronous gesture check, like Chrome/Firefox (the promise is created inside the handler).
          requireGesture('permissions.request');
          for (const o of origins) {
            parsePattern(o);
            const declared = [...optional].some((p) => {
              try {
                return patternCovers(p, o);
              } catch {
                return false;
              }
            }) || (manifest.host_permissions || []).some((p) => patternCovers(p, o));
            if (!declared) return Promise.reject(new Error(`Only permissions specified in the manifest may be requested: ${o}`));
          }
          const missing = origins.filter((o) => ![...granted.origins].some((g) => patternCovers(g, o)));
          if (!missing.length && permissions.every((p) => granted.permissions.has(p))) return Promise.resolve(true);
          return Promise.resolve().then(() => {
            if (!promptAnswer({ origins, permissions })) return false;
            for (const o of missing) granted.origins.add(o);
            for (const p of permissions) granted.permissions.add(p);
            permAdded.dispatch({ origins: missing, permissions });
            return true;
          });
        },
        async remove({ origins = [], permissions = [] } = {}) {
          const removed = origins.filter((o) => granted.origins.delete(o));
          for (const p of permissions) granted.permissions.delete(p);
          if (removed.length || permissions.length) permRemoved.dispatch({ origins: removed, permissions });
          return removed.length > 0 || permissions.length > 0;
        },
        onAdded: permAdded,
        onRemoved: permRemoved,
      },
      scripting: {
        async registerContentScripts(list) {
          for (const s of list) if (registeredScripts.has(s.id)) throw new Error(`Duplicate script ID '${s.id}'`);
          for (const s of list) {
            for (const m of s.matches || []) parsePattern(m);
            registeredScripts.set(s.id, clone(s));
          }
        },
        async getRegisteredContentScripts(filter = {}) {
          const all = [...registeredScripts.values()];
          return clone(filter.ids ? all.filter((s) => filter.ids.includes(s.id)) : all);
        },
        async unregisterContentScripts(filter = {}) {
          const ids = filter.ids || [...registeredScripts.keys()];
          for (const sid of ids) if (!registeredScripts.has(sid)) throw new Error(`Nonexistent script ID '${sid}'`);
          for (const sid of ids) registeredScripts.delete(sid);
        },
        async executeScript({ target, files, func, args = [] }) {
          const tab = tabs.get(target && target.tabId);
          if (!tab) throw new Error(`No tab with id: ${target && target.tabId}.`);
          if (!tab.activeTabGrant && !hostPermitted(tab.url)) {
            throw new Error('Cannot access contents of the page. Extension manifest must request permission to access the respective host.');
          }
          if (!tab.page) throw new Error('Cannot access contents of url (no page loaded in this fake tab).');
          const sandbox = tab.page.sandbox;
          if (files) {
            for (const f of files) {
              const code = await readFile(path.join(extensionDir, f), 'utf8');
              vm.runInContext(code, sandbox, { filename: f });
            }
            return [{ frameId: 0, result: null, documentId: 'doc-1' }];
          }
          // Like the browser: the function is serialized and re-evaluated in the page's (isolated) world.
          sandbox.__harnessArgs = JSON.parse(JSON.stringify(args));
          const result = vm.runInContext(`(${func.toString()})(...__harnessArgs)`, sandbox);
          return [{ frameId: 0, result: result === undefined ? null : JSON.parse(JSON.stringify(result)), documentId: 'doc-1' }];
        },
      },
      tabs: {
        async query(q = {}) {
          return [...tabs.values()]
            .filter((t) => (q.active === undefined || t.active === q.active))
            .map((t) => {
              const visible = t.activeTabGrant || hostPermitted(t.url) || granted.permissions.has('tabs');
              return { id: t.id, windowId: 1, active: t.active, index: 0, ...(visible ? { url: t.url, title: t.title || '' } : {}) };
            });
        },
        async create({ url }) {
          const t = browser.openTab(url, { active: true });
          return { id: t.id, url };
        },
        async sendMessage() {
          throw new Error('Could not establish connection. Receiving end does not exist.');
        },
        onRemoved: tabRemoved,
      },
      idle: {
        setDetectionInterval(sec) {
          if (!Number.isInteger(sec) || sec < 15) throw new Error('idle.setDetectionInterval: interval must be an integer >= 15');
          idleInterval = sec;
        },
        async queryState() {
          return 'active';
        },
        onStateChanged: idleChanged,
      },
      action: {
        async setTitle({ title }) {
          badge.title = title;
        },
        async getTitle() {
          return badge.title;
        },
        async setBadgeText({ text, tabId }) {
          badge.text.set(tabId ?? null, text);
        },
        async setBadgeBackgroundColor({ color, tabId }) {
          badge.color.set(tabId ?? null, color);
        },
        async openPopup() {
          badge.popupOpens++;
        },
      },
      commands: { onCommand: commandEvent },
    };
    if (kind === 'chrome') {
      ns.offscreen = {
        async createDocument({ url, reasons, justification }) {
          if (offscreenDoc) throw new Error('Only a single offscreen document may be created.');
          if (!Array.isArray(reasons) || !reasons.length || !justification) throw new Error('offscreen.createDocument: reasons and justification are required');
          offscreenDoc = { url, reasons };
          await browser.startOffscreen(url);
        },
        async closeDocument() {
          if (!offscreenDoc) throw new Error('No current offscreen document.');
          offscreenDoc = null;
          browser.stopOffscreen();
        },
        async hasDocument() {
          return !!offscreenDoc;
        },
      };
    } else {
      ns.webRequest = {
        onHeadersReceived: {
          addListener(fn, filter, extra = []) {
            if (!granted.permissions.has('webRequest')) throw new Error('webRequest permission missing');
            if (extra.includes('blocking') && !granted.permissions.has('webRequestBlocking')) throw new Error('webRequestBlocking permission missing');
            webRequestListeners.push({ fn, filter, extra });
          },
          removeListener(fn) {
            const i = webRequestListeners.findIndex((l) => l.fn === fn);
            if (i >= 0) webRequestListeners.splice(i, 1);
          },
          hasListener: (fn) => webRequestListeners.some((l) => l.fn === fn),
        },
        async getSecurityInfo(requestId) {
          const info = network.getSecurityInfo(requestId);
          if (!info) throw new Error(`Invalid requestId ${requestId}`);
          return clone(info);
        },
      };
    }
    return ns;
  }

  function createContext(type, url, { tabId = null } = {}) {
    const ctx = { type, url, onMessage: createEvent() };
    ctx.senderInfo = () => {
      if (type === 'content') {
        // content script in the top frame of a tab: the browser fills in tab, frame and URL
        const t = tabs.get(tabId);
        const tab = t ? { id: t.id, url: t.url, active: t.active, windowId: 1, index: 0 } : undefined;
        return kind === 'chrome'
          ? { id, url: ctx.url, origin: new URL(ctx.url).origin, tab, frameId: 0, documentId: `doc-${tabId}` }
          : { id, url: ctx.url, tab, frameId: 0, envType: 'content_child' };
      }
      return kind === 'chrome' ? { id, url: ctx.url, origin: extOrigin } : { id, url: ctx.url, envType: 'extension_child' };
    };
    ctx.ns = namespaceFor(ctx);
    contexts.add(ctx);
    ctx.close = () => contexts.delete(ctx);
    return ctx;
  }

  const browser = {
    kind,
    id,
    extOrigin,
    manifest,
    storage,
    network,
    granted,
    tabs,
    registeredScripts,
    alarms: alarmsMap,
    badge,
    clipboard,
    contexts,
    webRequestListeners,
    get idleInterval() {
      return idleInterval;
    },
    get sessionAccessLevel() {
      return sessionAccessLevel;
    },
    get offscreen() {
      return offscreenDoc;
    },
    hostPermitted,
    createContext,
    /** Run fn as a user gesture (click / keyboard command): permissions.request is allowed inside. */
    withGesture(fn) {
      gestureDepth++;
      try {
        return fn();
      } finally {
        gestureDepth--;
      }
    },
    answerPermissionPrompts(fn) {
      promptAnswer = fn;
    },
    revokeHostPermission(pattern) {
      if (granted.origins.delete(pattern)) permRemoved.dispatch({ origins: [pattern], permissions: [] });
    },
    openTab(url, { active = true, page = null } = {}) {
      const tid = tabs.size ? Math.max(...tabs.keys()) + 1 : 1;
      if (active) for (const t of tabs.values()) t.active = false;
      const t = { id: tid, url, active, page, activeTabGrant: false };
      tabs.set(tid, t);
      return t;
    },
    closeTab(tid) {
      if (tabs.delete(tid)) tabRemoved.dispatch(tid, { windowId: 1, isWindowClosing: false });
    },
    /** The user clicked the toolbar button / used a command on the active tab: grants activeTab. */
    grantActiveTab() {
      for (const t of tabs.values()) if (t.active) t.activeTabGrant = true;
    },
    command(name) {
      browser.grantActiveTab();
      const t = [...tabs.values()].find((x) => x.active);
      const tabInfo = t ? { id: t.id, url: t.url, active: true, windowId: 1 } : undefined;
      return browser.withGesture(() => commandEvent.dispatch(name, tabInfo));
    },
    setIdleState(state) {
      idleChanged.dispatch(state);
    },
    /** Advance the virtual clock and fire alarms that became due. */
    async advance(ms) {
      if (!clock) throw new Error('no virtual clock installed');
      clock.advance(ms);
      fireDueAlarms();
      await tick();
    },
    fireDueAlarms,
    installed(reason = 'install') {
      lifecycle.installed.dispatch({ reason });
    },
    /** Browser restart: storage.session is wiped, contexts die, alarms survive (Chrome persists them). */
    restart() {
      for (const c of [...contexts]) c.close();
      lifecycle.installed.listeners.length = 0;
      lifecycle.startup.listeners.length = 0;
      storage.session.data.clear();
      offscreenDoc = null;
      for (const t of tabs.values()) t.activeTabGrant = false;
    },
    /** Service worker / event page terminated (idle): contexts die, storage survives. */
    terminateBackground() {
      for (const c of [...contexts]) if (c.type === 'background') c.close();
      lifecycle.installed.listeners.length = 0;
      lifecycle.startup.listeners.length = 0;
      alarmEvent.listeners.length = 0;
      idleChanged.listeners.length = 0;
      commandEvent.listeners.length = 0;
      tabRemoved.listeners.length = 0;
      permAdded.listeners.length = 0;
      permRemoved.listeners.length = 0;
      webRequestListeners.length = 0;
    },
    startup() {
      lifecycle.startup.dispatch();
    },
    // offscreen document hooks (set by the extension loader)
    startOffscreen: async () => {},
    stopOffscreen: () => {},
  };
  return browser;
}
