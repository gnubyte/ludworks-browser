// Content blocker scriptlets: small, named counter-measures that filter lists ask for on specific sites
// (`example.com##+js(set-constant, adsEnabled, false)`). Our own implementation of the documented
// scriptlet behaviour (names, arguments) of the uBlock Origin filter syntax.
//
// runScriptlets runs in the page's MAIN world at document start, before any page script, through
// contextBridge.executeInMainWorld. It is serialised, so it must be self-contained: no outer
// references. Arguments are plain strings from the filter lists; nothing is ever evaluated as code.

export function runScriptlets(list) {
  'use strict';
  if (!Array.isArray(list) || !list.length) return;
  const W = window;
  const D = document;
  const defineProperty = Object.defineProperty;
  const getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
  const apply = Reflect.apply;
  const NativeRegExp = RegExp;
  const NativeProxy = Proxy;
  const NativeMO = W.MutationObserver;
  const magic = `lwb${Math.floor(Math.random() * 982451653 + 982451653).toString(36)}`;
  let errorTrapInstalled = false;

  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  /** "/re/flags" → that regex, "text" → literal match, "" → matches everything. */
  const toRegex = (s, flags = '') => {
    s = String(s || '');
    const m = /^\/(.+)\/([gimsu]*)$/.exec(s);
    if (m) {
      try {
        return new NativeRegExp(m[1], m[2] || flags);
      } catch {
        return /(?!)/;
      }
    }
    return new NativeRegExp(escapeRe(s), flags);
  };
  /** Needle with optional leading "!" (negation). */
  const needle = (s) => {
    s = String(s || '');
    const not = s.startsWith('!');
    const re = toRegex(not ? s.slice(1) : s);
    return { not, re, empty: s === '', test: (t) => re.test(String(t)) !== not };
  };
  const trapErrors = () => {
    if (errorTrapInstalled) return;
    errorTrapInstalled = true;
    W.addEventListener(
      'error',
      (e) => {
        if (String(e && e.message).includes(magic)) e.preventDefault();
      },
      true,
    );
  };
  const abortError = () => {
    trapErrors();
    return new ReferenceError(magic);
  };
  const onReady = (fn) => {
    if (D.readyState === 'loading') D.addEventListener('DOMContentLoaded', fn, { once: true });
    else fn();
  };
  /** Run fn now/at DOMContentLoaded and again (throttled) whenever the DOM changes. */
  const whenDom = (fn, options) => {
    let timer = 0;
    const run = () => {
      timer = 0;
      try {
        fn();
      } catch {
        /* keep the page working */
      }
    };
    const schedule = () => {
      if (!timer) timer = W.setTimeout(run, 50);
    };
    onReady(run);
    try {
      new NativeMO(schedule).observe(D, { childList: true, subtree: true, ...(options || {}) });
    } catch {
      /* no observer: the DOMContentLoaded run still happens */
    }
  };

  /**
   * Install a descriptor for the last property of `chain` ("a.b.c") on its owner object — also when
   * the intermediate objects are created later by the page.
   * @param {object} root
   * @param {string} chain
   * @param {(owner: object, prop: string, value: any, desc: PropertyDescriptor|undefined) => PropertyDescriptor} make
   */
  const trapChain = (root, chain, make) => {
    const dot = chain.indexOf('.');
    if (dot < 0) {
      const desc = getOwnPropertyDescriptor(root, chain);
      if (desc && desc.configurable === false) return;
      let value;
      try {
        value = root[chain];
      } catch {
        value = undefined;
      }
      try {
        defineProperty(root, chain, { configurable: true, enumerable: desc ? desc.enumerable : true, ...make(root, chain, value, desc) });
      } catch {
        /* not definable */
      }
      return;
    }
    const head = chain.slice(0, dot);
    const rest = chain.slice(dot + 1);
    let v;
    try {
      v = root[head];
    } catch {
      return;
    }
    if (v !== null && (typeof v === 'object' || typeof v === 'function')) {
      trapChain(v, rest, make);
      return;
    }
    const desc = getOwnPropertyDescriptor(root, head);
    if (desc && desc.configurable === false) return;
    let value = v;
    try {
      defineProperty(root, head, {
        configurable: true,
        enumerable: true,
        get() {
          return value;
        },
        set(nv) {
          value = nv;
          if (nv !== null && (typeof nv === 'object' || typeof nv === 'function')) trapChain(nv, rest, make);
        },
      });
    } catch {
      /* not definable */
    }
  };

  // -------------------------------------------------------------------------- JSON paths
  /** Walk "a.b.[].c" / "*" / "[-]" paths; mode 'has' tests, 'delete' removes the leaf. */
  const walk = (obj, segs, i, mode) => {
    if (obj === null || typeof obj !== 'object') return false;
    const s = segs[i];
    const last = i === segs.length - 1;
    if (s === '[]' || s === '*' || s === '[-]') {
      let found = false;
      const keys = Array.isArray(obj) ? obj.map((_x, k) => k) : Object.keys(obj);
      for (let k = keys.length - 1; k >= 0; k--) {
        const key = keys[k];
        if (last) {
          found = true;
          if (mode === 'delete') {
            if (Array.isArray(obj)) obj.splice(key, 1);
            else delete obj[key];
          }
          continue;
        }
        if (s === '[-]') {
          if (walk(obj[key], segs, i + 1, 'has')) {
            found = true;
            if (mode === 'delete') {
              if (Array.isArray(obj)) obj.splice(key, 1);
              else delete obj[key];
            }
          }
        } else if (walk(obj[key], segs, i + 1, mode)) found = true;
      }
      return found;
    }
    if (!(s in obj)) return false;
    if (last) {
      if (mode === 'delete') delete obj[s];
      return true;
    }
    return walk(obj[s], segs, i + 1, mode);
  };
  const paths = (s) =>
    String(s || '')
      .split(/ +/)
      .filter(Boolean)
      .map((p) => p.split('.'));
  const makePruner = (pruneArg, needArg) => {
    const prune = paths(pruneArg);
    const need = paths(needArg);
    return (obj) => {
      if (obj === null || typeof obj !== 'object' || !prune.length) return false;
      for (const p of need) if (!walk(obj, p, 0, 'has')) return false;
      let changed = false;
      for (const p of prune) if (walk(obj, p, 0, 'delete')) changed = true;
      return changed;
    };
  };
  /** propsToMatch: "url-needle" or "key:needle key2:needle2" against {url, method, body, …}. */
  const propsMatcher = (s) => {
    s = String(s || '').trim();
    if (!s) return null;
    const pairs = [];
    for (const part of s.split(/\s+/)) {
      const m = /^(\w+):(.*)$/.exec(part);
      if (m && /^(url|method|body|headers|mode|credentials|cache|redirect|referrer|referrerPolicy|integrity|keepalive|signal|responseType)$/.test(m[1])) pairs.push([m[1], needle(m[2])]);
      else pairs.push(['url', needle(part)]);
    }
    return (props) => pairs.every(([k, n]) => props[k] !== undefined && n.test(props[k]));
  };
  const fetchProps = (args) => {
    const [res, init] = args;
    const props = { url: '', method: 'GET' };
    try {
      if (res instanceof W.Request) {
        props.url = res.url;
        props.method = res.method;
        props.mode = res.mode;
        props.credentials = res.credentials;
      } else props.url = String(res);
      if (init && typeof init === 'object') for (const k of Object.keys(init)) if (typeof init[k] !== 'object' || k === 'body') props[k] = typeof init[k] === 'string' ? init[k] : String(init[k]);
      props.url = new URL(props.url, D.baseURI).href;
    } catch {
      /* keep what we have */
    }
    return props;
  };
  const fetchVarArgs = (rest) => {
    const o = {};
    for (let i = 0; i + 1 < rest.length; i += 2) o[rest[i]] = rest[i + 1];
    return o;
  };

  // -------------------------------------------------------------------------- constants
  const NONE = {};
  const constValue = (raw, as) => {
    let v;
    switch (raw) {
      case 'undefined':
        v = undefined;
        break;
      case 'false':
      case 'no':
        v = false;
        break;
      case 'true':
      case 'yes':
        v = true;
        break;
      case 'null':
        v = null;
        break;
      case "''":
      case '':
      case 'emptyStr':
        v = '';
        break;
      case 'noopFunc':
        v = function () {};
        break;
      case 'trueFunc':
        v = function () {
          return true;
        };
        break;
      case 'falseFunc':
        v = function () {
          return false;
        };
        break;
      case 'throwFunc':
        v = function () {
          throw abortError();
        };
        break;
      case 'emptyArr':
      case '[]':
        v = [];
        break;
      case 'emptyObj':
      case '{}':
        v = {};
        break;
      case 'noopPromiseResolve':
        v = function () {
          return Promise.resolve();
        };
        break;
      case 'noopPromiseReject':
        v = function () {
          return Promise.reject();
        };
        break;
      case 'NaN':
        v = NaN;
        break;
      case 'Infinity':
        v = Infinity;
        break;
      case '-Infinity':
        v = -Infinity;
        break;
      default:
        if (/^-?\d+(\.\d+)?$/.test(raw) && Math.abs(Number(raw)) <= 0x7fff) v = Number(raw);
        else if (/^'.*'$/.test(raw) && raw.length <= 202) v = raw.slice(1, -1);
        else return NONE;
    }
    if (as === 'asFunction') return () => v;
    if (as === 'asCallback') return () => () => v;
    if (as === 'asResolved') return Promise.resolve(v);
    if (as === 'asRejected') return Promise.reject(v);
    return v;
  };
  const SAFE_STORAGE = /^(?:\$remove\$|undefined|false|true|null|''|emptyArr|emptyObj|yes|no|on|off|y|n|ok|accept(?:ed)?|reject(?:ed)?|allow(?:ed)?|den(?:y|ied)|block(?:ed)?|necessary|required|essential|nonessential|hide|hidden|show|shown|checked|unchecked|dismiss(?:ed)?|closed?|done|-1|\d{1,5}|)$/i;

  // -------------------------------------------------------------------------- timers
  const defuseTimer = (name, needleArg, delayArg) => {
    const n = needle(needleArg);
    const dStr = String(delayArg || '');
    const dNot = dStr.startsWith('!');
    const dVal = dStr ? Number(dNot ? dStr.slice(1) : dStr) : NaN;
    if (n.empty && !dStr) return; // log-only form
    const orig = W[name];
    if (typeof orig !== 'function') return;
    W[name] = new NativeProxy(orig, {
      apply(target, thisArg, args) {
        const fn = args[0];
        const text = typeof fn === 'function' ? Function.prototype.toString.call(fn) : String(fn);
        let hit = n.empty || n.test(text);
        if (hit && dStr) hit = (Number(args[1]) === dVal) !== dNot;
        if (hit) return apply(target, thisArg, [function () {}, args[1]]);
        return apply(target, thisArg, args);
      },
    });
  };
  const adjustTimer = (name, needleArg, delayArg, boostArg) => {
    const n = needle(needleArg);
    const delay = delayArg === '*' ? -1 : Number(delayArg || 1000);
    let boost = Number(boostArg || 0.05);
    if (!Number.isFinite(boost)) boost = 0.05;
    boost = Math.min(50, Math.max(0.001, boost));
    const orig = W[name];
    if (typeof orig !== 'function') return;
    W[name] = new NativeProxy(orig, {
      apply(target, thisArg, args) {
        const fn = args[0];
        const text = typeof fn === 'function' ? Function.prototype.toString.call(fn) : String(fn);
        if ((delay < 0 || Number(args[1]) === delay) && (n.empty || n.test(text))) {
          const a = [...args];
          a[1] = Number(args[1] || 0) * boost;
          return apply(target, thisArg, a);
        }
        return apply(target, thisArg, args);
      },
    });
  };

  // -------------------------------------------------------------------------- scriptlets
  const S = {
    'set-constant'(chain, raw, as) {
      if (!chain) return;
      const value = constValue(String(raw === undefined ? '' : raw), as);
      if (value === NONE) return;
      trapChain(W, chain, (_owner, _prop, _cur, desc) => ({
        get() {
          return value;
        },
        set(nv) {
          if (desc && typeof desc.set === 'function') {
            try {
              desc.set.call(this, nv);
            } catch {
              /* ignore */
            }
          }
        },
      }));
    },
    'abort-on-property-read'(chain) {
      if (!chain) return;
      trapChain(W, chain, () => ({
        get() {
          throw abortError();
        },
        set() {},
      }));
    },
    'abort-on-property-write'(chain) {
      if (!chain) return;
      trapChain(W, chain, (_o, _p, cur) => {
        let value = cur;
        return {
          get() {
            return value;
          },
          set() {
            throw abortError();
          },
        };
      });
    },
    'abort-current-script'(chain, needleArg, contextArg) {
      if (!chain) return;
      const n = needle(needleArg);
      const ctx = contextArg ? needle(contextArg) : null;
      const self = D.currentScript;
      const check = () => {
        const s = D.currentScript;
        if (!s || s === self || !(s instanceof HTMLScriptElement)) return;
        const text = s.src ? `${s.src}\n${s.textContent || ''}` : s.textContent || '';
        if (ctx && !ctx.test(s.src || 'inlineScript')) return;
        if (n.empty || n.test(text)) throw abortError();
      };
      trapChain(W, chain, (owner, _prop, cur, desc) => {
        let value = cur;
        return {
          get() {
            check();
            return desc && desc.get ? desc.get.call(owner) : value;
          },
          set(nv) {
            check();
            if (desc && desc.set) desc.set.call(owner, nv);
            else value = nv;
          },
        };
      });
    },
    'abort-on-stack-trace'(chain, needleArg) {
      if (!chain || !needleArg) return;
      const n = needle(needleArg);
      const check = () => {
        const stack = new Error().stack || '';
        if (n.test(stack)) throw abortError();
      };
      trapChain(W, chain, (owner, _prop, cur, desc) => {
        let value = cur;
        return {
          get() {
            check();
            return desc && desc.get ? desc.get.call(owner) : value;
          },
          set(nv) {
            check();
            if (desc && desc.set) desc.set.call(owner, nv);
            else value = nv;
          },
        };
      });
    },
    'json-prune'(pruneArg, needArg) {
      const pruner = makePruner(pruneArg, needArg);
      JSON.parse = new NativeProxy(JSON.parse, {
        apply(target, thisArg, args) {
          const r = apply(target, thisArg, args);
          try {
            pruner(r);
          } catch {
            /* ignore */
          }
          return r;
        },
      });
      const RJ = W.Response && W.Response.prototype.json;
      if (typeof RJ === 'function') {
        W.Response.prototype.json = new NativeProxy(RJ, {
          apply(target, thisArg, args) {
            return apply(target, thisArg, args).then((r) => {
              try {
                pruner(r);
              } catch {
                /* ignore */
              }
              return r;
            });
          },
        });
      }
    },
    'json-prune-fetch-response'(pruneArg, needArg, ...rest) {
      const pruner = makePruner(pruneArg, needArg);
      const opts = fetchVarArgs(rest);
      const match = propsMatcher(opts.propsToMatch);
      if (typeof W.fetch !== 'function') return;
      W.fetch = new NativeProxy(W.fetch, {
        apply(target, thisArg, args) {
          const p = apply(target, thisArg, args);
          if (match && !match(fetchProps(args))) return p;
          return p.then((resp) =>
            resp
              .clone()
              .json()
              .then((obj) => {
                if (!pruner(obj)) return resp;
                const out = new W.Response(JSON.stringify(obj), { status: resp.status, statusText: resp.statusText, headers: resp.headers });
                defineProperty(out, 'url', { value: resp.url });
                defineProperty(out, 'type', { value: resp.type });
                return out;
              })
              .catch(() => resp),
          );
        },
      });
    },
    'json-prune-xhr-response'(pruneArg, needArg, ...rest) {
      const pruner = makePruner(pruneArg, needArg);
      const opts = fetchVarArgs(rest);
      const match = propsMatcher(opts.propsToMatch);
      const X = W.XMLHttpRequest;
      if (!X) return;
      const urls = new WeakMap();
      const proto = X.prototype;
      proto.open = new NativeProxy(proto.open, {
        apply(target, thisArg, args) {
          urls.set(thisArg, { method: String(args[0] || 'GET'), url: String(args[1] || '') });
          return apply(target, thisArg, args);
        },
      });
      const wrapGetter = (prop) => {
        const desc = getOwnPropertyDescriptor(proto, prop);
        if (!desc || typeof desc.get !== 'function') return;
        const cache = new WeakMap();
        defineProperty(proto, prop, {
          ...desc,
          get() {
            const v = desc.get.call(this);
            if (this.readyState !== 4) return v;
            const info = urls.get(this);
            if (!info || (match && !match(info))) return v;
            if (cache.has(this)) return cache.get(this);
            let out = v;
            try {
              if (typeof v === 'string' && v) {
                const obj = JSON.parse(v);
                if (pruner(obj)) out = JSON.stringify(obj);
              } else if (v && typeof v === 'object' && pruner(v)) out = v;
            } catch {
              /* not JSON */
            }
            cache.set(this, out);
            return out;
          },
        });
      };
      wrapGetter('response');
      wrapGetter('responseText');
    },
    'no-fetch-if'(propsArg, bodyArg) {
      const match = propsMatcher(propsArg);
      if (!match || typeof W.fetch !== 'function') return;
      const body = bodyArg === 'emptyObj' ? '{}' : bodyArg === 'emptyArr' ? '[]' : '';
      W.fetch = new NativeProxy(W.fetch, {
        apply(target, thisArg, args) {
          const props = fetchProps(args);
          if (!match(props)) return apply(target, thisArg, args);
          const r = new W.Response(body, { status: 200, statusText: 'OK', headers: { 'Content-Type': body ? 'application/json' : 'text/plain' } });
          defineProperty(r, 'url', { value: props.url });
          return Promise.resolve(r);
        },
      });
    },
    'no-xhr-if'(propsArg) {
      const match = propsMatcher(propsArg);
      const X = W.XMLHttpRequest;
      if (!match || !X) return;
      const blocked = new WeakMap();
      const proto = X.prototype;
      proto.open = new NativeProxy(proto.open, {
        apply(target, thisArg, args) {
          const props = { method: String(args[0] || 'GET'), url: '' };
          try {
            props.url = new URL(String(args[1] || ''), D.baseURI).href;
          } catch {
            props.url = String(args[1] || '');
          }
          if (match(props)) blocked.set(thisArg, props);
          else blocked.delete(thisArg);
          return apply(target, thisArg, args);
        },
      });
      proto.send = new NativeProxy(proto.send, {
        apply(target, thisArg, args) {
          const props = blocked.get(thisArg);
          if (!props) return apply(target, thisArg, args);
          const xhr = thisArg;
          const rt = xhr.responseType;
          const body = rt === 'json' ? null : rt === 'arraybuffer' ? new ArrayBuffer(0) : rt === 'blob' ? new Blob([]) : rt === 'document' ? null : '';
          defineProperty(xhr, 'readyState', { value: 4, configurable: true });
          defineProperty(xhr, 'status', { value: 200, configurable: true });
          defineProperty(xhr, 'statusText', { value: 'OK', configurable: true });
          defineProperty(xhr, 'response', { value: body, configurable: true });
          defineProperty(xhr, 'responseText', { value: typeof body === 'string' ? body : '', configurable: true });
          defineProperty(xhr, 'responseURL', { value: props.url, configurable: true });
          W.setTimeout(() => {
            for (const t of ['readystatechange', 'load', 'loadend']) xhr.dispatchEvent(new Event(t));
          }, 1);
        },
      });
    },
    'no-setTimeout-if'(n, d) {
      defuseTimer('setTimeout', n, d);
    },
    'no-setInterval-if'(n, d) {
      defuseTimer('setInterval', n, d);
    },
    'no-requestAnimationFrame-if'(n) {
      const nd = needle(n);
      const orig = W.requestAnimationFrame;
      if (typeof orig !== 'function') return;
      W.requestAnimationFrame = new NativeProxy(orig, {
        apply(target, thisArg, args) {
          const text = typeof args[0] === 'function' ? Function.prototype.toString.call(args[0]) : String(args[0]);
          if (nd.empty || nd.test(text)) return apply(target, thisArg, [function () {}]);
          return apply(target, thisArg, args);
        },
      });
    },
    'adjust-setTimeout'(n, d, b) {
      adjustTimer('setTimeout', n, d, b);
    },
    'adjust-setInterval'(n, d, b) {
      adjustTimer('setInterval', n, d, b);
    },
    'no-window-open-if'(n) {
      const nd = needle(n);
      const orig = W.open;
      if (typeof orig !== 'function') return;
      W.open = new NativeProxy(orig, {
        apply(target, thisArg, args) {
          if (nd.empty || nd.test(String(args[0] === undefined ? '' : args[0]))) return null;
          return apply(target, thisArg, args);
        },
      });
    },
    'noeval-if'(n) {
      const nd = needle(n);
      const orig = W.eval;
      W.eval = new NativeProxy(orig, {
        apply(target, thisArg, args) {
          if (nd.empty || nd.test(String(args[0]))) return undefined;
          return apply(target, thisArg, args);
        },
      });
    },
    noeval() {
      S['noeval-if']('');
    },
    'addEventListener-defuser'(typeArg, n) {
      if (!typeArg && !n) return;
      const tn = needle(typeArg);
      const nd = needle(n);
      const proto = W.EventTarget && W.EventTarget.prototype;
      if (!proto) return;
      proto.addEventListener = new NativeProxy(proto.addEventListener, {
        apply(target, thisArg, args) {
          const [type, handler] = args;
          let text = '';
          try {
            text = typeof handler === 'function' ? Function.prototype.toString.call(handler) : handler && typeof handler.handleEvent === 'function' ? Function.prototype.toString.call(handler.handleEvent) : String(handler);
          } catch {
            /* ignore */
          }
          if ((tn.empty || tn.test(type)) && (nd.empty || nd.test(text))) return undefined;
          return apply(target, thisArg, args);
        },
      });
    },
    nowebrtc() {
      const names = ['RTCPeerConnection', 'webkitRTCPeerConnection', 'mozRTCPeerConnection'];
      const Stub = function () {};
      Stub.prototype = {
        close() {},
        createDataChannel() {
          return { close() {}, send() {} };
        },
        createOffer() {
          return Promise.resolve({});
        },
        createAnswer() {
          return Promise.resolve({});
        },
        setLocalDescription() {
          return Promise.resolve();
        },
        setRemoteDescription() {
          return Promise.resolve();
        },
        addIceCandidate() {
          return Promise.resolve();
        },
        addEventListener() {},
        removeEventListener() {},
        getStats() {
          return Promise.resolve(new Map());
        },
      };
      for (const n of names) if (W[n]) W[n] = Stub;
    },
    'remove-attr'(attrsArg, selector) {
      const attrs = String(attrsArg || '')
        .split(/\s*\|\s*/)
        .filter((a) => /^[\w:-]+$/.test(a));
      if (!attrs.length) return;
      const sel = selector || attrs.map((a) => `[${a}]`).join(',');
      whenDom(
        () => {
          for (const el of D.querySelectorAll(sel)) for (const a of attrs) el.removeAttribute(a);
        },
        { attributes: true, attributeFilter: attrs },
      );
    },
    'remove-class'(classesArg, selector) {
      const classes = String(classesArg || '')
        .split(/\s*\|\s*/)
        .filter((c) => /^[\w-]+$/.test(c));
      if (!classes.length) return;
      const sel = selector || classes.map((c) => `.${c}`).join(',');
      whenDom(
        () => {
          for (const el of D.querySelectorAll(sel)) el.classList.remove(...classes);
        },
        { attributes: true, attributeFilter: ['class'] },
      );
    },
    'set-attr'(selector, attr, value) {
      if (!selector || !/^[\w:-]+$/.test(attr || '')) return;
      const v = String(value || '');
      const copy = /^\[([\w:-]+)\]$/.exec(v);
      if (!copy && !/^(?:|true|false|-?\d{1,5})$/.test(v)) return;
      whenDom(() => {
        for (const el of D.querySelectorAll(selector)) {
          const nv = copy ? el.getAttribute(copy[1]) : v;
          if (nv !== null && el.getAttribute(attr) !== nv) el.setAttribute(attr, nv);
        }
      });
    },
    'remove-node-text'(nodeName, needleArg) {
      if (!nodeName) return;
      const nn = needle(nodeName.toLowerCase() === '#text' ? '#text' : nodeName.toLowerCase());
      const nd = needle(needleArg);
      const handle = (node) => {
        const name = node.nodeName.toLowerCase();
        if (!nn.test(name)) return;
        if (!nd.empty && !nd.test(node.textContent || '')) return;
        // Removing a parser-inserted <script> before the parser reaches its end tag keeps it from
        // running; assigning its text would throw on pages that enforce Trusted Types.
        try {
          if (node.nodeType === 3) node.data = '';
          else if (node.parentNode) node.parentNode.removeChild(node);
        } catch {
          /* ignore */
        }
      };
      const scan = (root) => {
        const tw = D.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
        const list = [];
        for (let n = tw.currentNode; n; n = tw.nextNode()) list.push(n);
        for (const n of list) handle(n);
      };
      try {
        new NativeMO((records) => {
          for (const r of records) for (const n of r.addedNodes) handle(n);
        }).observe(D, { childList: true, subtree: true });
      } catch {
        /* ignore */
      }
      if (D.documentElement) scan(D.documentElement);
    },
    'set-cookie'(name, value, path) {
      if (!name || !SAFE_STORAGE.test(String(value || '')) || String(value).startsWith('$')) return;
      const v = String(value || '');
      const enc = encodeURIComponent(name);
      if (D.cookie.split(/;\s*/).includes(`${enc}=${v}`)) return;
      const p = path === 'none' ? '' : '; path=/';
      try {
        D.cookie = `${enc}=${v}${p}; max-age=31536000; samesite=lax`;
      } catch {
        /* sandboxed document */
      }
    },
    'remove-cookie'(needleArg) {
      const nd = needle(needleArg);
      const removeAll = () => {
        let cookies = '';
        try {
          cookies = D.cookie;
        } catch {
          return;
        }
        for (const c of cookies.split(/;\s*/)) {
          const name = c.split('=')[0];
          if (!name || !(nd.empty || nd.test(name))) continue;
          const host = location.hostname;
          const domains = ['', host, `.${host}`];
          const parts = host.split('.');
          if (parts.length > 2) domains.push(`.${parts.slice(-2).join('.')}`);
          for (const d of domains) for (const p of ['/', location.pathname]) {
            try {
              D.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=${p}${d ? `; domain=${d}` : ''}`;
            } catch {
              /* ignore */
            }
          }
        }
      };
      removeAll();
      W.addEventListener('beforeunload', removeAll);
      onReady(removeAll);
    },
    'set-local-storage-item'(key, value) {
      setStorage('localStorage', key, value);
    },
    'set-session-storage-item'(key, value) {
      setStorage('sessionStorage', key, value);
    },
    'refresh-defuser'() {
      onReady(() => {
        const m = D.querySelector('meta[http-equiv="refresh" i]');
        if (m) W.stop();
      });
    },
    'window.name-defuser'() {
      if (W === W.top) W.name = '';
    },
  };
  function setStorage(which, key, value) {
    if (!key || !SAFE_STORAGE.test(String(value === undefined ? '' : value))) return;
    let st;
    try {
      st = W[which];
    } catch {
      return;
    }
    if (!st) return;
    try {
      if (value === '$remove$') st.removeItem(key);
      else {
        const v = value === 'emptyArr' ? '[]' : value === 'emptyObj' ? '{}' : value === "''" ? '' : String(value);
        if (st.getItem(key) !== v) st.setItem(key, v);
      }
    } catch {
      /* storage blocked */
    }
  }

  for (const call of list) {
    if (!Array.isArray(call) || typeof call[0] !== 'string') continue;
    const fn = S[call[0]];
    if (!fn) continue;
    try {
      fn(...call.slice(1).map((a) => String(a)));
    } catch {
      /* one broken scriptlet must not stop the others */
    }
  }
}
