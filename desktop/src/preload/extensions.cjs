// Preload for Chrome extensions (registered on the browsing session for frames AND service workers,
// see src/main/extensions/extensions.js). Electron implements only part of the extension API; this adds
// the missing pieces (chrome.action, tabs, windows, contextMenus, notifications, cookies, alarms,
// permissions, commands, storage.sync, webNavigation, runtime.onInstalled…) to the extension's own
// JavaScript world. Every call goes to the main process, which takes the extension ID from the sender
// (frame URL / service-worker scope) and checks the extension's permissions there.
//
// It runs in every frame and service worker of the session and returns at once for anything that is not
// an extension page/worker (or the Chrome Web Store, where it adds the install bridge).
//
// The functions passed to contextBridge.executeInMainWorld are serialised: they cannot use anything
// from this file's scope except what is passed in `args`.
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const IS_FRAME = typeof window !== 'undefined' && typeof document !== 'undefined';
// Component extensions of the engine (PDF viewer): never touched.
const COMPONENT_IDS = ['mhjfbmdgcfjojefgiehjai'];

function currentHref() {
  if (IS_FRAME) {
    try {
      return String(location.href);
    } catch {
      return '';
    }
  }
  try {
    return String(contextBridge.executeInMainWorld({ func: () => String(globalThis.location && globalThis.location.href) }));
  } catch {
    return '';
  }
}

const href = currentHref();
let extMatch = /^chrome-extension:\/\/([a-p]{32})\//.exec(href);
if (!extMatch && IS_FRAME && /^about:(blank|srcdoc)/.test(href)) {
  // an about:blank / srcdoc frame of an extension page has the extension's origin (and its API)
  try {
    extMatch = /^chrome-extension:\/\/([a-p]{32})$/.exec(String(self.origin || ''));
  } catch {
    extMatch = null;
  }
}

if (extMatch && !COMPONENT_IDS.includes(extMatch[1])) setupExtension();
else if (IS_FRAME && /^https:\/\/chromewebstore\.google\.com\//.test(href) && window === window.top) setupStore();

// ------------------------------------------------------------------------------------- plumbing
function later(ms) {
  const st = typeof setTimeout === 'function' ? setTimeout : (() => {
    try {
      return require('timers').setTimeout;
    } catch {
      return null;
    }
  })();
  return new Promise((r) => (st ? st(r, ms) : r()));
}

/** ipcRenderer.invoke that waits for the main process to hook a just-started service worker. */
async function invoke(channel, ...args) {
  for (let i = 0; ; i++) {
    try {
      return await ipcRenderer.invoke(channel, ...args);
    } catch (e) {
      if (i < 7 && /No handler registered/.test(String(e && e.message))) {
        await later(20 * 2 ** i);
        continue;
      }
      throw e;
    }
  }
}

function setupExtension() {
  let dispatch = null;
  const queue = [];
  ipcRenderer.on('lwext:event', (_e, name, args) => {
    if (dispatch) dispatch(name, args);
    else if (queue.length < 500) queue.push([name, args]);
  });
  const bridge = {
    call: (method, args) => invoke('lwext:call', String(method), Array.isArray(args) ? args : []),
    hello: () => invoke('lwext:hello', IS_FRAME ? 'frame' : 'sw'),
    listen: (name, on, filter) => ipcRenderer.send('lwext:listen', String(name), !!on, filter && typeof filter === 'object' ? filter : null),
    ready: (names) => ipcRenderer.send('lwext:ready', Array.isArray(names) ? names.map(String) : []),
    onEvent: (fn) => {
      dispatch = fn;
      for (const [n, a] of queue.splice(0)) fn(n, a);
    },
  };
  try {
    // Electron creates MV2 background pages and offscreen documents without context isolation: there
    // this preload already runs in the extension's own world (and the bridge is the extension's anyway).
    if (IS_FRAME && process.contextIsolated === false) installExtensionApi(bridge, { frame: true });
    else contextBridge.executeInMainWorld({ func: installExtensionApi, args: [bridge, { frame: IS_FRAME }] });
  } catch (e) {
    ipcRenderer.send('lwext:log', `api install failed: ${e && e.message}`);
  }
}

function setupStore() {
  const call = (method, args) => {
    // Installing needs a click on the page. Read here, in the isolated world: scripts in the page's
    // world (the store's, or an extension's) cannot fake it.
    const gesture = !!(navigator.userActivation && navigator.userActivation.isActive);
    if (method === 'beginInstall' && !gesture) return Promise.resolve({ v: 'user_gesture_required' });
    if (method === 'uninstall' && !gesture) return Promise.resolve({ v: false });
    return ipcRenderer.invoke('lwext:store', String(method), Array.isArray(args) ? args : []);
  };
  try {
    contextBridge.executeInMainWorld({ func: installWebstoreShim, args: [{ call }] });
  } catch {
    /* the store page still works, just without "Add to Chrome" */
  }
}

// ============================================================================ extension main world
function installExtensionApi(bridge, ctx) {
  const chrome = globalThis.chrome;
  if (!chrome || !chrome.runtime || !chrome.runtime.id || typeof chrome.runtime.getManifest !== 'function') return false;
  if (globalThis.__ludworksExtensionApi) return true;
  Object.defineProperty(globalThis, '__ludworksExtensionApi', { value: true });
  // Chromium also exposes the extension API as `browser`: a separate object with the same native
  // bindings. Everything below is added to both (listeners are shared).
  const roots = [chrome];
  try {
    const b = globalThis.browser;
    if (b && typeof b === 'object' && b !== chrome && b.runtime) roots.push(b);
  } catch {
    /* no browser namespace */
  }

  const manifest = chrome.runtime.getManifest() || {};
  const mv = manifest.manifest_version || 2;
  const perms = new Set((Array.isArray(manifest.permissions) ? manifest.permissions : []).filter((p) => typeof p === 'string'));
  const has = (p) => perms.has(p);
  const define = (obj, key, value) => {
    try {
      Object.defineProperty(obj, key, { value, writable: true, configurable: true, enumerable: true });
    } catch {
      try {
        obj[key] = value;
      } catch {
        /* read-only native property */
      }
    }
  };
  /** A namespace object of a root (created when the engine has none). */
  const nsOf = (root, name) => {
    let o = null;
    try {
      o = root[name];
    } catch {
      o = null;
    }
    if (!o || typeof o !== 'object') {
      o = {};
      define(root, name, o);
    }
    return o;
  };

  // ---------------------------------------------------------------- errors, calls, events
  function withLastError(err, fn) {
    const set = [];
    for (const root of roots) {
      const rt = root.runtime;
      try {
        Object.defineProperty(rt, 'lastError', { configurable: true, enumerable: true, get: () => ({ message: err && err.message ? err.message : String(err) }) });
        set.push(rt);
      } catch {
        /* native property */
      }
    }
    try {
      fn();
    } finally {
      for (const rt of set) {
        try {
          delete rt.lastError;
        } catch {
          /* ignore */
        }
      }
    }
  }

  function call(method, args, cb) {
    const p = Promise.resolve(bridge.call(method, args)).then((r) => {
      if (r && r.e !== undefined) throw new Error(r.e);
      return r && !r.u ? r.v : undefined;
    });
    if (typeof cb === 'function') {
      p.then(
        (v) => cb(v),
        (e) => withLastError(e, () => cb()),
      );
      return undefined;
    }
    return p;
  }

  const listeners = new Map(); // event name → [{fn, filter}]
  let ready = false;
  function makeEvent(name) {
    return {
      addListener(fn, filter) {
        if (typeof fn !== 'function') throw new TypeError('Listener must be a function');
        let l = listeners.get(name);
        if (!l) listeners.set(name, (l = []));
        if (l.some((x) => x.fn === fn)) return;
        l.push({ fn, filter: filter && typeof filter === 'object' ? filter : null });
        if (l.length === 1 || name.startsWith('webRequest.')) bridge.listen(name, true, name.startsWith('webRequest.') ? filterForMain(filter) : null);
      },
      removeListener(fn) {
        const l = listeners.get(name);
        if (!l) return;
        const i = l.findIndex((x) => x.fn === fn);
        if (i < 0) return;
        l.splice(i, 1);
        if (!l.length) {
          listeners.delete(name);
          bridge.listen(name, false, null);
        }
      },
      hasListener(fn) {
        return !!(listeners.get(name) || []).some((x) => x.fn === fn);
      },
      hasListeners() {
        return !!(listeners.get(name) || []).length;
      },
      addRules() {
        throw new Error('Declarative rules are not supported.');
      },
      getRules() {
        throw new Error('Declarative rules are not supported.');
      },
      removeRules() {
        throw new Error('Declarative rules are not supported.');
      },
    };
  }

  function filterForMain(f) {
    if (!f || typeof f !== 'object') return null;
    return { urls: Array.isArray(f.urls) ? f.urls.map(String).slice(0, 200) : null, types: Array.isArray(f.types) ? f.types.map(String) : null, tabId: Number.isInteger(f.tabId) ? f.tabId : null, windowId: Number.isInteger(f.windowId) ? f.windowId : null };
  }

  // --------------------------------------------------------------- filters (client side)
  function patternRe(p) {
    if (p === '<all_urls>') return /^(https?|wss?|ftp|file):\/\//;
    const m = /^(\*|https?|wss?|ftp|file|urn):\/\/([^/]*)(\/.*)?$/.exec(String(p));
    if (!m) return /$^/;
    const esc = (s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    const scheme = m[1] === '*' ? '(https?|wss?)' : esc(m[1]);
    let host = m[2];
    host = host === '*' ? '[^/]*' : host.startsWith('*.') ? `([^/]*\\.)?${esc(host.slice(2))}` : esc(host);
    const pathRe = esc(m[3] || '/').replace(/\\\*/g, '.*');
    return new RegExp(`^${scheme}:\\/\\/${host}(:\\d+)?${pathRe}$`);
  }
  const urlMatches = (patterns, url) => patterns.some((p) => patternRe(p).test(String(url || '')));

  function urlFilterMatches(filters, url) {
    if (!Array.isArray(filters) || !filters.length) return true;
    let u;
    try {
      u = new URL(url);
    } catch {
      return false;
    }
    const host = u.hostname;
    const path = u.pathname;
    const query = u.search.replace(/^\?/, '');
    const full = u.href;
    return filters.some((f) => {
      if (!f || typeof f !== 'object') return false;
      const s = (v) => String(v);
      if (f.hostContains !== undefined && !host.includes(s(f.hostContains))) return false;
      if (f.hostEquals !== undefined && host !== s(f.hostEquals)) return false;
      if (f.hostPrefix !== undefined && !host.startsWith(s(f.hostPrefix))) return false;
      if (f.hostSuffix !== undefined && !host.endsWith(s(f.hostSuffix))) return false;
      if (f.pathContains !== undefined && !path.includes(s(f.pathContains))) return false;
      if (f.pathEquals !== undefined && path !== s(f.pathEquals)) return false;
      if (f.pathPrefix !== undefined && !path.startsWith(s(f.pathPrefix))) return false;
      if (f.pathSuffix !== undefined && !path.endsWith(s(f.pathSuffix))) return false;
      if (f.queryContains !== undefined && !query.includes(s(f.queryContains))) return false;
      if (f.queryEquals !== undefined && query !== s(f.queryEquals)) return false;
      if (f.queryPrefix !== undefined && !query.startsWith(s(f.queryPrefix))) return false;
      if (f.querySuffix !== undefined && !query.endsWith(s(f.querySuffix))) return false;
      if (f.urlContains !== undefined && !full.includes(s(f.urlContains))) return false;
      if (f.urlEquals !== undefined && full !== s(f.urlEquals)) return false;
      if (f.urlPrefix !== undefined && !full.startsWith(s(f.urlPrefix))) return false;
      if (f.urlSuffix !== undefined && !full.endsWith(s(f.urlSuffix))) return false;
      if (f.urlMatches !== undefined) {
        try {
          if (!new RegExp(s(f.urlMatches)).test(full)) return false;
        } catch {
          return false;
        }
      }
      if (f.originAndPathMatches !== undefined) {
        try {
          if (!new RegExp(s(f.originAndPathMatches)).test(u.origin + path)) return false;
        } catch {
          return false;
        }
      }
      if (Array.isArray(f.schemes) && !f.schemes.includes(u.protocol.slice(0, -1))) return false;
      if (Array.isArray(f.ports)) {
        const port = Number(u.port || (u.protocol === 'https:' ? 443 : u.protocol === 'http:' ? 80 : 0));
        if (!f.ports.some((p) => (Array.isArray(p) ? port >= p[0] && port <= p[1] : port === p))) return false;
      }
      return true;
    });
  }

  function passesFilter(name, filter, args) {
    if (!filter) return true;
    if (name === 'tabs.onUpdated') {
      const [tabId, change, tab] = args;
      if (Number.isInteger(filter.tabId) && filter.tabId !== tabId) return false;
      if (Number.isInteger(filter.windowId) && tab && filter.windowId !== tab.windowId) return false;
      if (Array.isArray(filter.properties) && !filter.properties.some((p) => p in change)) return false;
      if (Array.isArray(filter.urls) && !(tab && tab.url && urlMatches(filter.urls, tab.url))) return false;
      return true;
    }
    if (name.startsWith('webNavigation.')) return urlFilterMatches(filter.url, args[0] && args[0].url);
    return true;
  }

  // ----------------------------------------------------------------- incoming events
  let tabInfo = { tabs: {}, notTabs: [] };
  const menuClicks = new Map(); // MV2 contextMenus onclick handlers of this context
  const internal = {
    __tabs(map) {
      tabInfo = map && typeof map === 'object' ? map : tabInfo;
    },
    __permissions(p) {
      for (const x of (p && p.permissions) || []) perms.add(x);
      for (const f of optionalInstallers) f();
    },
  };
  bridge.onEvent((name, args) => {
    if (internal[name]) return internal[name](...(args || []));
    if (name === 'contextMenus.onClicked') {
      const h = menuClicks.get(args[0] && args[0].menuItemId);
      if (h) {
        try {
          h(...args);
        } catch (e) {
          console.error(e);
        }
      }
    }
    for (const { fn, filter } of [...(listeners.get(name) || [])]) {
      if (!passesFilter(name, filter, args || [])) continue;
      try {
        fn(...(args || []));
      } catch (e) {
        console.error(e);
      }
    }
  });

  // --------------------------------------------------------------- sender.tab fix-up
  // Electron reports every web contents as a tab (the action popup too) and leaves out windowId/index/…
  function fixSender(sender) {
    try {
      if (sender && sender.tab && typeof sender.tab.id === 'number') {
        const id = sender.tab.id;
        if (tabInfo.notTabs.includes(id)) delete sender.tab;
        else if (tabInfo.tabs[id]) Object.assign(sender.tab, tabInfo.tabs[id]);
      }
    } catch {
      /* frozen */
    }
    return sender;
  }
  function wrapMessaging(ev, kind) {
    if (!ev || typeof ev.addListener !== 'function') return;
    const wrapped = new WeakMap();
    const add = ev.addListener.bind(ev);
    const remove = ev.removeListener.bind(ev);
    const hasL = ev.hasListener.bind(ev);
    const wrapperOf = (fn) => {
      let w = wrapped.get(fn);
      if (!w) {
        w =
          kind === 'port'
            ? function (port) {
                if (port) fixSender(port.sender);
                return fn.apply(this, arguments);
              }
            : function (msg, sender, sendResponse) {
                return fn.call(this, msg, fixSender(sender), sendResponse);
              };
        wrapped.set(fn, w);
      }
      return w;
    };
    try {
      define(ev, 'addListener', (fn, ...rest) => (typeof fn === 'function' ? add(wrapperOf(fn), ...rest) : add(fn, ...rest)));
      define(ev, 'removeListener', (fn) => remove(wrapped.get(fn) || fn));
      define(ev, 'hasListener', (fn) => hasL(wrapped.get(fn) || fn));
    } catch {
      /* leave native */
    }
  }

  // The rest is added to every root (chrome, browser).
  const optionalInstallers = [];
  for (const root of roots) patchRoot(root);

  function patchRoot(chrome) {
  const ns = (name) => nsOf(chrome, name);
  // declarativeNetRequest: Electron keeps the rules but never applies them while the session uses
  // session.webRequest (Ludworks always does), so extensions see it as missing instead of silently inert.
  try {
    delete chrome.declarativeNetRequest;
  } catch {
    /* non-configurable */
  }
  if (chrome.declarativeNetRequest) define(chrome, 'declarativeNetRequest', undefined);
  // --------------------------------------------------------------------------- runtime
  const runtime = chrome.runtime;
  define(runtime, 'onInstalled', makeEvent('runtime.onInstalled'));
  define(runtime, 'onStartup', makeEvent('runtime.onStartup'));
  define(runtime, 'onUpdateAvailable', makeEvent('runtime.onUpdateAvailable'));
  define(runtime, 'openOptionsPage', (cb) => call('runtime.openOptionsPage', [], cb));
  define(runtime, 'setUninstallURL', (url, cb) => call('runtime.setUninstallURL', [url === undefined ? '' : String(url)], cb));
  define(runtime, 'requestUpdateCheck', (cb) => call('runtime.requestUpdateCheck', [], cb));
  wrapMessaging(runtime.onMessage, 'message');
  wrapMessaging(runtime.onMessageExternal, 'message');
  wrapMessaging(runtime.onConnect, 'port');
  wrapMessaging(runtime.onConnectExternal, 'port');

  // chrome.extension: Electron leaves out these two (extensions get no file:// access and never run in
  // private windows here).
  const extension = chrome.extension;
  if (extension && typeof extension === 'object') {
    const answer = (v) => (cb) => {
      const p = Promise.resolve(v);
      if (typeof cb === 'function') {
        p.then(cb);
        return undefined;
      }
      return p;
    };
    if (typeof extension.isAllowedFileSchemeAccess !== 'function') define(extension, 'isAllowedFileSchemeAccess', answer(false));
    if (typeof extension.isAllowedIncognitoAccess !== 'function') define(extension, 'isAllowedIncognitoAccess', answer(false));
    if (extension.inIncognitoContext === undefined) define(extension, 'inIncognitoContext', false);
  }

  // ---------------------------------------------------------------------------- storage
  /* <lw-storage-shim> */
  function lwStorageShim(chrome) {
    if (!chrome || !chrome.storage || !chrome.storage.local || chrome.storage.__lwShim) return;
    const storage = chrome.storage;
    const local = storage.local;
    const P = '__lwsync:';
    const isSync = (k) => typeof k === 'string' && k.startsWith(P);
    const lastErr = () => {
      try {
        return chrome.runtime && chrome.runtime.lastError;
      } catch {
        return null;
      }
    };
    // the native methods, captured before `local` gets the wrappers below
    const native = { get: local.get, set: local.set, remove: local.remove, getBytesInUse: local.getBytesInUse };
    const nat = (m, ...a) =>
      new Promise((resolve, reject) => {
        try {
          native[m].call(local, ...a, (v) => {
            const e = lastErr();
            if (e) reject(new Error(e.message));
            else resolve(v);
          });
        } catch (e) {
          reject(e);
        }
      });
    const done = (p, cb) => {
      if (typeof cb === 'function') {
        p.then(
          (v) => cb(v),
          (e) => {
            console.error(e);
            cb();
          },
        );
        return undefined;
      }
      return p;
    };
    const defineOn = (o, k, v) => {
      try {
        Object.defineProperty(o, k, { value: v, writable: true, configurable: true, enumerable: true });
      } catch {
        try {
          o[k] = v;
        } catch {
          /* ignore */
        }
      }
    };
    const strip = (obj) => {
      const out = {};
      for (const k of Object.keys(obj || {})) if (isSync(k)) out[k.slice(P.length)] = obj[k];
      return out;
    };
    const nativeChanged = storage.onChanged;
    const nativeLocalChanged = local.onChanged;
    const split = (changes) => {
      const loc = {};
      const syn = {};
      let l = false;
      let s = false;
      for (const k of Object.keys(changes || {})) {
        if (isSync(k)) {
          syn[k.slice(P.length)] = changes[k];
          s = true;
        } else {
          loc[k] = changes[k];
          l = true;
        }
      }
      return { loc: l ? loc : null, syn: s ? syn : null };
    };
    const eventOver = (target, make) => {
      const map = new Map();
      return {
        addListener(fn) {
          if (typeof fn !== 'function' || map.has(fn) || !target) return;
          const w = make(fn);
          map.set(fn, w);
          target.addListener(w);
        },
        removeListener(fn) {
          const w = map.get(fn);
          if (w && target) target.removeListener(w);
          map.delete(fn);
        },
        hasListener: (fn) => map.has(fn),
        hasListeners: () => map.size > 0,
      };
    };
    const sync = {
      QUOTA_BYTES: 102400,
      QUOTA_BYTES_PER_ITEM: 8192,
      MAX_ITEMS: 512,
      MAX_WRITE_OPERATIONS_PER_HOUR: 1800,
      MAX_WRITE_OPERATIONS_PER_MINUTE: 120,
      MAX_SUSTAINED_WRITE_OPERATIONS_PER_MINUTE: 1000000,
      get(keys, cb) {
        if (typeof keys === 'function') {
          cb = keys;
          keys = null;
        }
        const p = (async () => {
          if (keys === null || keys === undefined) return strip(await nat('get', null));
          if (typeof keys === 'string') return strip(await nat('get', [P + keys]));
          if (Array.isArray(keys)) return strip(await nat('get', keys.map((k) => P + k)));
          const pref = {};
          for (const k of Object.keys(keys)) pref[P + k] = keys[k];
          return strip(await nat('get', pref));
        })();
        return done(p, cb);
      },
      set(items, cb) {
        const pref = {};
        for (const k of Object.keys(items || {})) pref[P + k] = items[k];
        return done(nat('set', pref), cb);
      },
      remove(keys, cb) {
        const list = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : [];
        return done(nat('remove', list.map((k) => P + k)), cb);
      },
      clear(cb) {
        return done(
          (async () => {
            const ks = Object.keys(await nat('get', null)).filter(isSync);
            if (ks.length) await nat('remove', ks);
          })(),
          cb,
        );
      },
      getBytesInUse(keys, cb) {
        if (typeof keys === 'function') {
          cb = keys;
          keys = null;
        }
        return done(
          (async () => {
            let ks = keys === null || keys === undefined ? Object.keys(await nat('get', null)).filter(isSync) : (typeof keys === 'string' ? [keys] : keys).map((k) => P + k);
            if (!ks.length || typeof local.getBytesInUse !== 'function') return 0;
            return nat('getBytesInUse', ks);
          })(),
          cb,
        );
      },
      getKeys(cb) {
        return done((async () => Object.keys(strip(await nat('get', null))))(), cb);
      },
      setAccessLevel(_o, cb) {
        return done(Promise.resolve(), cb);
      },
      onChanged: eventOver(nativeChanged, (fn) => (changes, area) => {
        if (area !== 'local') return;
        const { syn } = split(changes);
        if (syn) fn(syn);
      }),
    };
    defineOn(storage, '__lwShim', true);
    defineOn(storage, 'sync', sync);
    // local: hide the sync entries
    const nGet = local.get;
    defineOn(local, 'get', function (keys, cb) {
      if (typeof keys === 'function') {
        cb = keys;
        keys = null;
      }
      if (keys !== null && keys !== undefined) return cb ? nGet.call(local, keys, cb) : nGet.call(local, keys);
      const p = nat('get', null).then((all) => {
        const out = {};
        for (const k of Object.keys(all || {})) if (!isSync(k)) out[k] = all[k];
        return out;
      });
      return done(p, cb);
    });
    defineOn(local, 'clear', (cb) =>
      done(
        (async () => {
          const ks = Object.keys(await nat('get', null)).filter((k) => !isSync(k));
          if (ks.length) await nat('remove', ks);
        })(),
        cb,
      ),
    );
    if (typeof local.getKeys === 'function') defineOn(local, 'getKeys', (cb) => done(nat('get', null).then((all) => Object.keys(all || {}).filter((k) => !isSync(k))), cb));
    if (typeof local.getBytesInUse === 'function') {
      const nBytes = local.getBytesInUse;
      defineOn(local, 'getBytesInUse', function (keys, cb) {
        if (typeof keys === 'function') {
          cb = keys;
          keys = null;
        }
        if (keys !== null && keys !== undefined) return cb ? nBytes.call(local, keys, cb) : nBytes.call(local, keys);
        return done(
          nat('get', null).then((all) => {
            const ks = Object.keys(all || {}).filter((k) => !isSync(k));
            return ks.length ? nat('getBytesInUse', ks) : 0;
          }),
          cb,
        );
      });
    }
    if (nativeLocalChanged) {
      defineOn(
        local,
        'onChanged',
        eventOver(nativeLocalChanged, (fn) => (changes) => {
          const { loc } = split(changes);
          if (loc) fn(loc);
        }),
      );
    }
    defineOn(
      storage,
      'onChanged',
      eventOver(nativeChanged, (fn) => (changes, area) => {
        if (area !== 'local') return fn(changes, area);
        const { loc, syn } = split(changes);
        if (loc) fn(loc, 'local');
        if (syn) fn(syn, 'sync');
      }),
    );
    // No enterprise policies here: managed storage is always empty.
    defineOn(storage, 'managed', {
      get: (keys, cb) => done(Promise.resolve({}), typeof keys === 'function' ? keys : cb),
      getBytesInUse: (keys, cb) => done(Promise.resolve(0), typeof keys === 'function' ? keys : cb),
      onChanged: eventOver(null, () => () => {}),
    });
  }
  /* </lw-storage-shim> */
  if (chrome.storage && chrome.storage.local) lwStorageShim(chrome);

  // ---------------------------------------------------------------------------- scripting
  // Content scripts get the storage.sync shim (ludworks-browser/cs.js, added to the package at install).
  const CS_SHIM = 'ludworks-browser/cs.js';
  if (chrome.scripting && typeof chrome.scripting.executeScript === 'function') {
    const sc = chrome.scripting;
    const nExec = sc.executeScript.bind(sc);
    define(sc, 'executeScript', (inj, cb) => {
      if (inj && Array.isArray(inj.files) && inj.files.length && inj.world !== 'MAIN' && !inj.files.includes(CS_SHIM)) inj = { ...inj, files: [CS_SHIM, ...inj.files] };
      return cb ? nExec(inj, cb) : nExec(inj);
    });
    const addShim = (list) => (Array.isArray(list) ? list.map((s) => (s && Array.isArray(s.js) && s.js.length && s.world !== 'MAIN' && !s.js.includes(CS_SHIM) ? { ...s, js: [CS_SHIM, ...s.js] } : s)) : list);
    for (const m of ['registerContentScripts', 'updateContentScripts']) {
      if (typeof sc[m] !== 'function') continue;
      const n = sc[m].bind(sc);
      define(sc, m, (scripts, cb) => (cb ? n(addShim(scripts), cb) : n(addShim(scripts))));
    }
  }

  // ------------------------------------------------------------------------------- tabs
  const tabs = ns('tabs');
  const optTab = (a, b, c) => (typeof a === 'number' || a === null || a === undefined ? [a ?? null, b, c] : [null, a, b]);
  Object.assign(tabs, {
    TAB_ID_NONE: -1,
    TAB_INDEX_NONE: -1,
    MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND: 2,
  });
  const tabMethods = {
    query: (q, cb) => call('tabs.query', [q && typeof q === 'object' ? q : {}], cb),
    get: (tabId, cb) => call('tabs.get', [tabId], cb),
    getCurrent: (cb) => call('tabs.getCurrent', [], cb),
    create: (p, cb) => call('tabs.create', [p && typeof p === 'object' ? p : {}], cb),
    duplicate: (tabId, cb) => call('tabs.duplicate', [tabId], cb),
    highlight: (info, cb) => call('tabs.highlight', [info || {}], cb),
    move: (ids, p, cb) => call('tabs.move', [ids, p || {}], cb),
    remove: (ids, cb) => call('tabs.remove', [ids], cb),
    discard: (tabId, cb) => call('tabs.get', [tabId ?? null], cb),
    update(a, b, c) {
      const [tabId, props, cb] = optTab(a, b, c);
      return call('tabs.update', [tabId, props || {}], cb);
    },
    reload(a, b, c) {
      const [tabId, props, cb] = typeof a === 'function' ? [null, null, a] : optTab(a, b, c);
      return call('tabs.reload', [tabId, props && typeof props === 'object' ? props : {}], typeof props === 'function' ? props : cb);
    },
    goBack(a, b) {
      const [tabId, cb] = typeof a === 'function' ? [null, a] : [a ?? null, b];
      return call('tabs.goBack', [tabId], cb);
    },
    goForward(a, b) {
      const [tabId, cb] = typeof a === 'function' ? [null, a] : [a ?? null, b];
      return call('tabs.goForward', [tabId], cb);
    },
    getZoom(a, b) {
      const [tabId, cb] = typeof a === 'function' ? [null, a] : [a ?? null, b];
      return call('tabs.getZoom', [tabId], cb);
    },
    setZoom(a, b, c) {
      const [tabId, factor, cb] = typeof b === 'number' ? [a ?? null, b, c] : [null, a, b];
      return call('tabs.setZoom', [tabId, factor], cb);
    },
    getZoomSettings(a, b) {
      const [tabId, cb] = typeof a === 'function' ? [null, a] : [a ?? null, b];
      return call('tabs.getZoomSettings', [tabId], cb);
    },
    setZoomSettings(a, b, c) {
      const [tabId, s, cb] = typeof a === 'number' ? [a, b, c] : [null, a, b];
      return call('tabs.setZoomSettings', [tabId, s || {}], cb);
    },
    detectLanguage(a, b) {
      const [tabId, cb] = typeof a === 'function' ? [null, a] : [a ?? null, b];
      return call('tabs.detectLanguage', [tabId], cb);
    },
    captureVisibleTab(a, b, c) {
      let windowId = null;
      let opts = {};
      let cb;
      for (const x of [a, b, c]) {
        if (typeof x === 'function') cb = x;
        else if (typeof x === 'number') windowId = x;
        else if (x && typeof x === 'object') opts = x;
      }
      return call('tabs.captureVisibleTab', [windowId, opts], cb);
    },
  };
  for (const [k, v] of Object.entries(tabMethods)) define(tabs, k, v);
  for (const e of ['onCreated', 'onUpdated', 'onActivated', 'onRemoved', 'onHighlighted', 'onMoved', 'onAttached', 'onDetached', 'onReplaced', 'onZoomChange', 'onActiveChanged', 'onSelectionChanged', 'onHighlightChanged']) define(tabs, e, makeEvent(`tabs.${e}`));
  // MV2 tabs.executeScript/insertCSS/removeCSS without a tab id mean "the active tab" (Electron refuses -1).
  for (const m of ['executeScript', 'insertCSS', 'removeCSS']) {
    const n = tabs[m];
    if (typeof n !== 'function') continue;
    define(tabs, m, function (a, b, c) {
      if (typeof a === 'number') return n.call(tabs, a, b, c);
      const details = a;
      const cb = b;
      const p = call('tabs.query', [{ active: true, lastFocusedWindow: true }]).then((list) => {
        if (!list || !list[0]) throw new Error('No active tab.');
        return new Promise((resolve, reject) => n.call(tabs, list[0].id, details, (r) => (chrome.runtime.lastError ? reject(new Error(chrome.runtime.lastError.message)) : resolve(r))));
      });
      if (typeof cb === 'function') {
        p.then(cb, (e) => withLastError(e, () => cb()));
        return undefined;
      }
      return p;
    });
  }

  // ----------------------------------------------------------------------------- windows
  const windows = ns('windows');
  Object.assign(windows, { WINDOW_ID_NONE: -1, WINDOW_ID_CURRENT: -2, WindowType: { NORMAL: 'normal', POPUP: 'popup', PANEL: 'panel', APP: 'app', DEVTOOLS: 'devtools' }, WindowState: { NORMAL: 'normal', MINIMIZED: 'minimized', MAXIMIZED: 'maximized', FULLSCREEN: 'fullscreen', LOCKED_FULLSCREEN: 'locked-fullscreen' }, CreateType: { NORMAL: 'normal', POPUP: 'popup', PANEL: 'panel' } });
  const getOpts = (a, b) => (typeof a === 'function' ? [{}, a] : [a && typeof a === 'object' ? a : {}, b]);
  define(windows, 'get', (id, a, b) => {
    const [o, cb] = getOpts(a, b);
    return call('windows.get', [id, o], cb);
  });
  define(windows, 'getCurrent', (a, b) => {
    const [o, cb] = getOpts(a, b);
    return call('windows.getCurrent', [o], cb);
  });
  define(windows, 'getLastFocused', (a, b) => {
    const [o, cb] = getOpts(a, b);
    return call('windows.getLastFocused', [o], cb);
  });
  define(windows, 'getAll', (a, b) => {
    const [o, cb] = getOpts(a, b);
    return call('windows.getAll', [o], cb);
  });
  define(windows, 'create', (a, b) => {
    const [o, cb] = getOpts(a, b);
    return call('windows.create', [o], cb);
  });
  define(windows, 'update', (id, info, cb) => call('windows.update', [id, info || {}], cb));
  define(windows, 'remove', (id, cb) => call('windows.remove', [id], cb));
  for (const e of ['onCreated', 'onRemoved', 'onFocusChanged', 'onBoundsChanged']) define(windows, e, makeEvent(`windows.${e}`));

  // ------------------------------------------------------------------------------ action
  const actionKey = mv >= 3 ? (manifest.action ? 'action' : null) : manifest.browser_action ? 'browserAction' : manifest.page_action ? 'pageAction' : null;
  if (actionKey) {
    const action = ns(actionKey);
    const d = (o) => (o && typeof o === 'object' ? o : {});
    const tabArg = (a, b) => (typeof a === 'function' ? [null, a] : [Number.isInteger(a) ? a : null, b]);
    const imageOf = (img) => {
      if (!img) return null;
      const one = (x) => (x && x.data && Number.isInteger(x.width) && Number.isInteger(x.height) ? { width: x.width, height: x.height, data: new Uint8Array(x.data.buffer ? x.data.buffer.slice(x.data.byteOffset || 0, (x.data.byteOffset || 0) + x.data.byteLength) : x.data) } : null);
      if (img.data) return { 16: one(img) };
      const out = {};
      for (const k of Object.keys(img)) {
        const v = one(img[k]);
        if (v) out[k] = v;
      }
      return out;
    };
    const methods = {
      setTitle: (o, cb) => call('action.setTitle', [d(o)], cb),
      getTitle: (o, cb) => call('action.getTitle', [d(o)], cb),
      setPopup: (o, cb) => call('action.setPopup', [d(o)], cb),
      getPopup: (o, cb) => call('action.getPopup', [d(o)], cb),
      setBadgeText: (o, cb) => call('action.setBadgeText', [d(o)], cb),
      getBadgeText: (o, cb) => call('action.getBadgeText', [d(o)], cb),
      setBadgeBackgroundColor: (o, cb) => call('action.setBadgeBackgroundColor', [d(o)], cb),
      getBadgeBackgroundColor: (o, cb) => call('action.getBadgeBackgroundColor', [d(o)], cb),
      setBadgeTextColor: (o, cb) => call('action.setBadgeTextColor', [d(o)], cb),
      getBadgeTextColor: (o, cb) => call('action.getBadgeTextColor', [d(o)], cb),
      setIcon(o, cb) {
        const x = d(o);
        return call('action.setIcon', [{ tabId: Number.isInteger(x.tabId) ? x.tabId : null, path: x.path ?? null, imageData: x.imageData ? imageOf(x.imageData) : null }], cb);
      },
      enable(a, b) {
        const [tabId, cb] = tabArg(a, b);
        return call('action.enable', [tabId], cb);
      },
      disable(a, b) {
        const [tabId, cb] = tabArg(a, b);
        return call('action.disable', [tabId], cb);
      },
      isEnabled(a, b) {
        const [tabId, cb] = tabArg(a, b);
        return call('action.isEnabled', [tabId], cb);
      },
      show(a, b) {
        const [tabId, cb] = tabArg(a, b);
        return call('action.enable', [tabId], cb);
      },
      hide(a, b) {
        const [tabId, cb] = tabArg(a, b);
        return call('action.disable', [tabId], cb);
      },
      getUserSettings: (cb) => call('action.getUserSettings', [], cb),
      openPopup: (o, cb) => call('action.openPopup', [typeof o === 'object' && o ? o : {}], typeof o === 'function' ? o : cb),
    };
    for (const [k, v] of Object.entries(methods)) define(action, k, v);
    define(action, 'onClicked', makeEvent('action.onClicked'));
    define(action, 'onUserSettingsChanged', makeEvent('action.onUserSettingsChanged'));
  }

  // ---------------------------------------------------------------------------- commands
  const commands = ns('commands');
  define(commands, 'getAll', (cb) => call('commands.getAll', [], cb));
  define(commands, 'onCommand', makeEvent('commands.onCommand'));
  define(commands, 'onChanged', makeEvent('commands.onChanged'));

  // ------------------------------------------------------------------------- permissions
  const permissions = ns('permissions');
  const pp = (o) => ({ permissions: Array.isArray(o && o.permissions) ? o.permissions.map(String) : [], origins: Array.isArray(o && o.origins) ? o.origins.map(String) : [] });
  define(permissions, 'contains', (o, cb) => call('permissions.contains', [pp(o)], cb));
  define(permissions, 'getAll', (cb) => call('permissions.getAll', [], cb));
  define(permissions, 'remove', (o, cb) => call('permissions.remove', [pp(o)], cb));
  define(permissions, 'request', (o, cb) => {
    const gesture = ctx.frame && globalThis.navigator && navigator.userActivation ? !!navigator.userActivation.isActive : false;
    return call('permissions.request', [pp(o), gesture], cb);
  });
  define(permissions, 'onAdded', makeEvent('permissions.onAdded'));
  define(permissions, 'onRemoved', makeEvent('permissions.onRemoved'));

  // ------------------------------------------------- permission-gated namespaces
  const installed = new Set();
  optionalInstallers.push(installOptional);
  function installOptional() {
    if ((has('contextMenus') || has('menus')) && !installed.has('menus')) {
      installed.add('menus');
      const menus = ns('contextMenus');
      let auto = 0;
      Object.assign(menus, { ACTION_MENU_TOP_LEVEL_LIMIT: 6, ContextType: { ALL: 'all', PAGE: 'page', FRAME: 'frame', SELECTION: 'selection', LINK: 'link', EDITABLE: 'editable', IMAGE: 'image', VIDEO: 'video', AUDIO: 'audio', LAUNCHER: 'launcher', BROWSER_ACTION: 'browser_action', PAGE_ACTION: 'page_action', ACTION: 'action' }, ItemType: { NORMAL: 'normal', CHECKBOX: 'checkbox', RADIO: 'radio', SEPARATOR: 'separator' } });
      define(menus, 'create', (props, cb) => {
        const p = { ...(props || {}) };
        if (p.id === undefined || p.id === null) p.id = `__auto${++auto}_${Date.now().toString(36)}`;
        if (typeof p.onclick === 'function') menuClicks.set(p.id, p.onclick);
        delete p.onclick;
        call('contextMenus.create', [p], typeof cb === 'function' ? cb : () => {});
        return p.id;
      });
      define(menus, 'update', (id, props, cb) => {
        const p = { ...(props || {}) };
        if (typeof p.onclick === 'function') menuClicks.set(id, p.onclick);
        delete p.onclick;
        return call('contextMenus.update', [id, p], cb);
      });
      define(menus, 'remove', (id, cb) => {
        menuClicks.delete(id);
        return call('contextMenus.remove', [id], cb);
      });
      define(menus, 'removeAll', (cb) => {
        menuClicks.clear();
        return call('contextMenus.removeAll', [], cb);
      });
      define(menus, 'onClicked', makeEvent('contextMenus.onClicked'));
      define(menus, 'onShown', makeEvent('contextMenus.onShown'));
      define(menus, 'onHidden', makeEvent('contextMenus.onHidden'));
      define(menus, 'refresh', (cb) => call('contextMenus.refresh', [], cb));
      if (has('menus')) define(chrome, 'menus', menus);
    }
    if (has('notifications') && !installed.has('notifications')) {
      installed.add('notifications');
      const n = ns('notifications');
      Object.assign(n, { TemplateType: { BASIC: 'basic', IMAGE: 'image', LIST: 'list', PROGRESS: 'progress' }, PermissionLevel: { GRANTED: 'granted', DENIED: 'denied' } });
      define(n, 'create', (a, b, c) => {
        const [id, opts, cb] = typeof a === 'string' ? [a, b, c] : [null, a, b];
        return call('notifications.create', [id, opts || {}], cb);
      });
      define(n, 'update', (id, opts, cb) => call('notifications.update', [String(id), opts || {}], cb));
      define(n, 'clear', (id, cb) => call('notifications.clear', [String(id)], cb));
      define(n, 'getAll', (cb) => call('notifications.getAll', [], cb));
      define(n, 'getPermissionLevel', (cb) => call('notifications.getPermissionLevel', [], cb));
      for (const e of ['onClicked', 'onClosed', 'onButtonClicked', 'onPermissionLevelChanged', 'onShowSettings']) define(n, e, makeEvent(`notifications.${e}`));
    }
    if (has('cookies') && !installed.has('cookies')) {
      installed.add('cookies');
      const c = ns('cookies');
      Object.assign(c, { SameSiteStatus: { NO_RESTRICTION: 'no_restriction', LAX: 'lax', STRICT: 'strict', UNSPECIFIED: 'unspecified' }, OnChangedCause: { EVICTED: 'evicted', EXPIRED: 'expired', EXPLICIT: 'explicit', EXPIRED_OVERWRITE: 'expired_overwrite', OVERWRITE: 'overwrite' } });
      for (const m of ['get', 'getAll', 'set', 'remove']) define(c, m, (o, cb) => call(`cookies.${m}`, [o && typeof o === 'object' ? o : {}], cb));
      define(c, 'getAllCookieStores', (cb) => call('cookies.getAllCookieStores', [], cb));
      define(c, 'getPartitionKey', (o, cb) => call('cookies.getPartitionKey', [o || {}], cb));
      define(c, 'onChanged', makeEvent('cookies.onChanged'));
    }
    if (has('alarms') && !installed.has('alarms')) {
      installed.add('alarms');
      const a = ns('alarms');
      define(a, 'create', (x, y, z) => {
        const [name, info, cb] = typeof x === 'string' ? [x, y, z] : [null, x, y];
        return call('alarms.create', [name ?? '', info || {}], cb);
      });
      define(a, 'get', (x, y) => {
        const [name, cb] = typeof x === 'function' ? ['', x] : [x ?? '', y];
        return call('alarms.get', [String(name)], cb);
      });
      define(a, 'getAll', (cb) => call('alarms.getAll', [], cb));
      define(a, 'clear', (x, y) => {
        const [name, cb] = typeof x === 'function' ? ['', x] : [x ?? '', y];
        return call('alarms.clear', [String(name)], cb);
      });
      define(a, 'clearAll', (cb) => call('alarms.clearAll', [], cb));
      define(a, 'onAlarm', makeEvent('alarms.onAlarm'));
    }
    if (has('webNavigation') && !installed.has('webNavigation')) {
      installed.add('webNavigation');
      const w = ns('webNavigation');
      define(w, 'getFrame', (o, cb) => call('webNavigation.getFrame', [o || {}], cb));
      define(w, 'getAllFrames', (o, cb) => call('webNavigation.getAllFrames', [o || {}], cb));
      for (const e of ['onBeforeNavigate', 'onCommitted', 'onDOMContentLoaded', 'onCompleted', 'onErrorOccurred', 'onCreatedNavigationTarget', 'onReferenceFragmentUpdated', 'onHistoryStateUpdated', 'onTabReplaced']) define(w, e, makeEvent(`webNavigation.${e}`));
    }
    if (has('webRequest') && !installed.has('webRequest')) {
      installed.add('webRequest');
      const w = ns('webRequest');
      for (const e of ['onBeforeRequest', 'onBeforeSendHeaders', 'onSendHeaders', 'onHeadersReceived', 'onAuthRequired', 'onResponseStarted', 'onBeforeRedirect', 'onCompleted', 'onErrorOccurred']) define(w, e, makeEvent(`webRequest.${e}`));
      define(w, 'handlerBehaviorChanged', (cb) => call('webRequest.handlerBehaviorChanged', [], cb));
      define(w, 'MAX_HANDLER_BEHAVIOR_CHANGED_CALLS_PER_10_MINUTES', 20);
    }
  }
  installOptional();
  }

  // ------------------------------------------------------------------------- hand-over
  Promise.resolve(bridge.hello())
    .then((info) => {
      if (info && info.tabs) tabInfo = info.tabs;
    })
    .catch(() => {});
  // Listeners registered while the script first runs are known once it has finished (service workers
  // are woken for those events later).
  setTimeout(() => {
    ready = true;
    bridge.ready([...listeners.keys()]);
  }, 0);
  return ready || true;
}

// ============================================================================ Chrome Web Store page
// The store's own "Add to Chrome" button: chrome.webstorePrivate (the part the store page calls) mapped
// to the normal Ludworks install flow (download, signature check, our permission prompt). The store
// confirms an install through chrome.management.onInstalled, which Electron never fires for our loads,
// so it is fired here after a successful install. Only on https://chromewebstore.google.com (top frame);
// the main process checks the sender again.
function installWebstoreShim(bridge) {
  const chrome = (globalThis.chrome = globalThis.chrome || {});
  if (chrome.webstorePrivate) return;
  const cbOrPromise = (p, cb) => {
    const q = Promise.resolve(p);
    if (typeof cb === 'function') {
      q.then(
        (v) => cb(v),
        () => cb(),
      );
      return undefined;
    }
    return q;
  };
  const call = (m, args) =>
    Promise.resolve(bridge.call(m, args)).then((r) => {
      if (r && r.e !== undefined) throw new Error(r.e);
      return r ? r.v : undefined;
    });
  const installedListeners = new Set();
  const uninstalledListeners = new Set();
  const mg = chrome.management;
  if (mg && typeof mg.getAll === 'function') {
    // Electron reports every loaded extension as a "development" install; for the store they are normal ones.
    const fix = (x) => (x && typeof x === 'object' && x.installType === 'development' ? { ...x, installType: 'normal' } : x);
    const nGet = mg.get.bind(mg);
    const nAll = mg.getAll.bind(mg);
    const ev = mg.onInstalled;
    const def = (k, v) => {
      try {
        Object.defineProperty(mg, k, { value: v, configurable: true, writable: true });
      } catch {
        /* leave the native one */
      }
    };
    def('get', (id, cb) => (typeof cb === 'function' ? nGet(id, (x) => cb(fix(x))) : nGet(id).then(fix)));
    def('getAll', (cb) => (typeof cb === 'function' ? nAll((x) => cb((x || []).map(fix))) : nAll().then((x) => (x || []).map(fix))));
    const relay = (native, set) => ({
      addListener(fn) {
        set.add(fn);
        if (native) native.addListener(fn);
      },
      removeListener(fn) {
        set.delete(fn);
        if (native) native.removeListener(fn);
      },
      hasListener: (fn) => set.has(fn),
      hasListeners: () => set.size > 0,
    });
    if (ev) def('onInstalled', relay(ev, installedListeners));
    if (mg.onUninstalled) def('onUninstalled', relay(mg.onUninstalled, uninstalledListeners));
    // "Remove from Chrome" on the store: our confirmation and removal (Electron's would bypass Ludworks).
    def('uninstall', (id, opts, cb) => {
      if (typeof opts === 'function') cb = opts;
      const p = call('uninstall', [String(id)]).then((removed) => {
        if (!removed) throw new Error('User cancelled uninstall');
        for (const fn of [...uninstalledListeners]) {
          try {
            fn(String(id));
          } catch {
            /* the store's problem */
          }
        }
      });
      if (typeof cb === 'function') {
        p.then(
          () => cb(),
          () => cb(),
        );
        return undefined;
      }
      return p;
    });
  }
  const announce = (id) => {
    if (!mg || !installedListeners.size) return;
    mg.get(id, (info) => {
      if (!info) return;
      for (const fn of [...installedListeners]) {
        try {
          fn(info);
        } catch {
          /* the store's problem */
        }
      }
    });
  };
  const noEvent = { addListener() {}, removeListener() {}, hasListener: () => false, hasListeners: () => false };
  const api = {
    getExtensionStatus: (id, manifest, cb) => cbOrPromise(call('getExtensionStatus', [String(id)]), typeof manifest === 'function' ? manifest : cb),
    beginInstallWithManifest3: (details, cb) => cbOrPromise(call('beginInstall', [{ id: String((details && details.id) || '') }]), cb),
    completeInstall: (id, cb) =>
      cbOrPromise(
        call('completeInstall', [String(id)]).then((v) => {
          setTimeout(() => announce(String(id)), 0);
          return v;
        }),
        cb,
      ),
    getBrowserLogin: (cb) => cbOrPromise({ login: '' }, cb),
    getStoreLogin: (cb) => cbOrPromise('', cb),
    setStoreLogin: (_l, cb) => cbOrPromise(undefined, cb),
    getWebGLStatus: (cb) => cbOrPromise('webgl_allowed', cb),
    getIsLauncherEnabled: (cb) => cbOrPromise(false, cb),
    isInIncognitoMode: (cb) => cbOrPromise(false, cb),
    isPendingCustodianApproval: (_id, cb) => cbOrPromise(false, cb),
    getReferrerChain: (cb) => cbOrPromise('', cb),
    getMV2DeprecationStatus: (cb) => cbOrPromise('inactive', cb),
    getFullChromeVersion: (cb) => cbOrPromise(call('fullVersion', []), cb),
    enableAppLauncher: (cb) => cbOrPromise(undefined, cb),
    getEphemeralAppsEnabled: (cb) => cbOrPromise(false, cb),
    onInstallStageChanged: noEvent,
    onDownloadProgress: noEvent,
  };
  try {
    Object.defineProperty(chrome, 'webstorePrivate', { value: Object.freeze(api), configurable: false, enumerable: false });
  } catch {
    chrome.webstorePrivate = api;
  }
}
