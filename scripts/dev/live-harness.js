// Dev-only page harness for scripts/dev/live-preview.mjs (never packaged): a fake `chrome` namespace whose
// runtime.sendMessage runs the REAL built background core + message handlers in this page, talking to the
// live server through the preview's /__server/ forwarder. Then the real popup is loaded.
//   ?url=<active tab URL>  (default https://github.com/login)

import { createCore } from '../background/core.js';
import { createMessageHandler, errorPayload } from '../background/handlers.js';

const SERVER_ORIGIN = '__SERVER_ORIGIN__';
const EXT_ORIGIN = `${location.origin}/`;
const RUNTIME_ID = 'ludworks-live-preview';
const tabUrl = new URLSearchParams(location.search).get('url') || 'https://github.com/login';

/** chrome.storage area over Web Storage (JSON values), so state survives a popup reload like the real one. */
function area(store, prefix) {
  const keys = () => Object.keys(store).filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length));
  return {
    async get(sel) {
      const out = {};
      const list = sel == null ? keys() : typeof sel === 'string' ? [sel] : Array.isArray(sel) ? sel : Object.keys(sel);
      for (const k of list) {
        const v = store.getItem(prefix + k);
        if (v !== null) out[k] = JSON.parse(v);
      }
      return out;
    },
    async set(obj) {
      for (const [k, v] of Object.entries(obj)) if (v !== undefined) store.setItem(prefix + k, JSON.stringify(v));
    },
    async remove(ks) {
      for (const k of typeof ks === 'string' ? [ks] : ks) store.removeItem(prefix + k);
    },
    async clear() {
      for (const k of keys()) store.removeItem(prefix + k);
    },
  };
}

const storage = { local: area(localStorage, 'lw.local.'), session: area(sessionStorage, 'lw.session.') };
const listeners = [];
const emit = (event) => {
  for (const fn of listeners) {
    try {
      fn({ event }, { id: RUNTIME_ID, url: `${EXT_ORIGIN}background/main.js` });
    } catch {
      /* ignore */
    }
  }
};

// Background fetch with host permission ≈ same-origin request to the forwarder.
const fetchImpl = (url, init) => {
  const u = new URL(url);
  if (u.origin !== SERVER_ORIGIN) return Promise.reject(new TypeError(`Failed to fetch (preview only reaches ${SERVER_ORIGIN})`));
  return fetch(`${location.origin}/__server${u.pathname}${u.search}`, { ...init, credentials: 'omit' });
};

const core = createCore({ storage, fetchImpl, browserName: '__TARGET__', version: 'live-preview', emit });
const handle = createMessageHandler({
  core,
  runtimeId: RUNTIME_ID,
  extensionOrigin: EXT_ORIGIN,
  fill: async (id) => {
    const creds = await core.resolveFill(id, tabUrl);
    console.info('[live-preview] would fill', { username: creds.username, totp: creds.totp ? 'yes' : 'no' });
    return { filled: { username: !!creds.username, password: !!creds.password, totp: !!creds.totp } };
  },
});

globalThis.chrome = {
  runtime: {
    id: RUNTIME_ID,
    getURL: (p = '') => EXT_ORIGIN + p,
    async sendMessage(msg) {
      try {
        const data = await handle(JSON.parse(JSON.stringify(msg)), { id: RUNTIME_ID, url: location.href });
        return { ok: true, data: data === undefined ? null : JSON.parse(JSON.stringify(data)) };
      } catch (e) {
        console.warn('[live-preview]', msg.type, e && e.code, e && e.message);
        return { ok: false, error: errorPayload(e) };
      }
    },
    onMessage: { addListener: (fn) => listeners.push(fn) },
  },
  storage: { local: storage.local, session: storage.session },
  tabs: {
    query: async () => [{ id: 1, url: tabUrl, active: true }],
    create: async ({ url }) => console.info('[live-preview] open tab', url),
  },
  permissions: { request: async () => true, contains: async () => true, remove: async () => true },
};

import('../popup/popup.js');
