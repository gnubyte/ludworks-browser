// Live Ludworks server helpers for the integration harness: configuration, first-run setup, admin
// operations, and a "web app peer" — the real web UI client code (ludworks-server/web/assets/js/core/api.js
// + apps/vault/session.js + lib/vault/crypto.js) running under node with a same-origin cookie session, as a
// browser tab would. Used to prove cross-client compatibility with the extension.

import { readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import tls from 'node:tls';
import { rawRequest, createCookieJar } from './browser-env.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '..', '..');
export const SERVER_REPO = path.resolve(ROOT, '..', 'ludworks-server');
export const WEB_JS = path.join(SERVER_REPO, 'web', 'assets', 'js');
export const HAVE_WEB = existsSync(path.join(WEB_JS, 'apps', 'vault', 'session.js'));

/**
 * Harness configuration from the environment.
 *   LUDWORKS_IT_URL               http://127.0.0.1:18104 (required; tests skip without it)
 *   LUDWORKS_IT_TLS_URL           https://127.0.0.1:18204 (optional; a --tls self-signed instance)
 *   LUDWORKS_IT_SETUP_TOKEN(_FILE) first-run setup token (only needed when the server is not set up yet)
 *   LUDWORKS_IT_ADMIN / LUDWORKS_IT_ADMIN_PASSWORD   admin account (created by setup when needed)
 */
export function config() {
  const env = process.env;
  let setupToken = env.LUDWORKS_IT_SETUP_TOKEN || '';
  if (!setupToken && env.LUDWORKS_IT_SETUP_TOKEN_FILE && existsSync(env.LUDWORKS_IT_SETUP_TOKEN_FILE)) {
    setupToken = readFileSync(env.LUDWORKS_IT_SETUP_TOKEN_FILE, 'utf8').trim();
  }
  return {
    url: (env.LUDWORKS_IT_URL || '').replace(/\/+$/, ''),
    tlsUrl: (env.LUDWORKS_IT_TLS_URL || '').replace(/\/+$/, ''),
    tlsSetupToken: env.LUDWORKS_IT_TLS_SETUP_TOKEN || (env.LUDWORKS_IT_TLS_SETUP_TOKEN_FILE && existsSync(env.LUDWORKS_IT_TLS_SETUP_TOKEN_FILE) ? readFileSync(env.LUDWORKS_IT_TLS_SETUP_TOKEN_FILE, 'utf8').trim() : ''),
    setupToken,
    admin: env.LUDWORKS_IT_ADMIN || 'itadmin',
    adminPassword: env.LUDWORKS_IT_ADMIN_PASSWORD || 'It-Admin-Passw0rd!2026',
  };
}

export const skipReason = (cfg = config()) => {
  if (!cfg.url) return 'LUDWORKS_IT_URL not set (integration tests need a live Ludworks server)';
  if (!HAVE_WEB) return 'ludworks-server checkout (web app lib) not found next to this repo';
  return false;
};

/** Fetch the server's TLS certificate (PEM) the way a user would see and accept it in a browser tab. */
export function fetchServerCertificate(serverUrl) {
  const u = new URL(serverUrl);
  return new Promise((resolve, reject) => {
    const sock = tls.connect({ host: u.hostname, port: Number(u.port || 443), rejectUnauthorized: false, servername: /^[\d.]+$/.test(u.hostname) ? undefined : u.hostname }, () => {
      const cert = sock.getPeerCertificate(true);
      sock.end();
      if (!cert || !cert.raw) return reject(new Error('no certificate'));
      const b64 = cert.raw.toString('base64').match(/.{1,64}/g).join('\n');
      resolve({ pem: `-----BEGIN CERTIFICATE-----\n${b64}\n-----END CERTIFICATE-----\n`, fingerprint256: cert.fingerprint256 });
    });
    sock.on('error', reject);
  });
}

/**
 * fetch() for a same-origin web page of the server (the web UI in a tab): cookies from the profile jar,
 * Origin on unsafe methods, Sec-Fetch-Site: same-origin.
 */
export function createPageFetch(serverUrl, { jar = createCookieJar(), ca = [] } = {}) {
  const origin = new URL(serverUrl).origin;
  return {
    jar,
    async fetch(input, init = {}) {
      const req = new Request(new URL(String(input), `${origin}/`).href, init);
      const url = new URL(req.url);
      const method = req.method.toUpperCase();
      const body = method === 'GET' || method === 'HEAD' ? null : Buffer.from(await req.arrayBuffer());
      const headers = {};
      for (const [k, v] of req.headers) headers[k] = v;
      if (url.origin === origin) {
        const c = jar.header(url.href);
        if (c) headers.cookie = c;
        if (!['GET', 'HEAD'].includes(method)) headers.origin = origin;
        headers['sec-fetch-site'] = 'same-origin';
      }
      let res;
      try {
        res = await rawRequest(url.href, { method, headers, body, ca, signal: req.signal });
      } catch (e) {
        throw new TypeError('Failed to fetch', { cause: e });
      }
      const sc = res.headers.filter(([k]) => k === 'set-cookie').map(([, v]) => v);
      if (sc.length) jar.store(url.href, sc);
      const h = new Headers();
      for (const [k, v] of res.headers) if (k !== 'set-cookie') h.append(k, v);
      const nullBody = [204, 205, 304].includes(res.status) || method === 'HEAD';
      return new Response(nullBody ? null : res.body, { status: res.status, statusText: res.statusText, headers: h });
    },
  };
}

let webMods = null;
/** Import the web app's own modules (core API client, vault session + model, crypto lib). */
export async function webModules() {
  if (webMods) return webMods;
  const imp = (rel) => import(pathToFileURL(path.join(WEB_JS, rel)).href);
  const [api, session, model, crypto, totp] = await Promise.all([
    imp('core/api.js'),
    imp('apps/vault/session.js'),
    imp('apps/vault/model.js'),
    imp('lib/vault/crypto.js'),
    imp('lib/vault/totp.js'),
  ]);
  webMods = { api, session, model, crypto, totp };
  return webMods;
}

/**
 * The web app in a browser tab: real core/api.js client with cookie + CSRF, and the real vault session.
 * @param {string} serverUrl
 * @param {{jar?: any, ca?: string[]}} [opts]  pass the extension profile's jar to share the browser's cookies
 */
export async function createWebPeer(serverUrl, opts = {}) {
  const m = await webModules();
  const page = createPageFetch(serverUrl, opts);
  let csrf = null;
  const api = m.api.createApi({ base: `${serverUrl}/api/v1`, getCsrf: () => csrf, fetch: page.fetch });
  const peer = {
    api,
    jar: page.jar,
    fetch: page.fetch,
    user: null,
    async login(username, password, extra = {}) {
      const res = await api.post('/auth/login', { username, password, ...extra }, { noRedirect: true });
      csrf = res.csrf_token;
      peer.user = res.user;
      return res;
    },
    async setup({ setupToken, username, password, email }) {
      const res = await api.post('/setup', { setup_token: setupToken, username, password, email, server_name: 'Ludworks integration' }, { noRedirect: true });
      csrf = res.csrf_token;
      peer.user = res.user;
      return res;
    },
    async logout() {
      await api.post('/auth/logout', {}).catch(() => {});
      csrf = null;
    },
    /** A fresh web vault session (as if the Passwords app was opened in this tab). */
    vault() {
      return m.session.createSession({ api });
    },
  };
  return peer;
}

/** Make sure the server is set up and return a logged-in admin web peer. */
export async function adminPeer(cfg = config(), serverUrl = cfg.url, { ca = [], setupToken = cfg.setupToken } = {}) {
  const peer = await createWebPeer(serverUrl, { ca });
  const st = await peer.api.get('/setup/status', { noRedirect: true });
  if (st.setup_required) {
    if (!setupToken) throw new Error(`${serverUrl} needs first-run setup: set LUDWORKS_IT_SETUP_TOKEN(_FILE)`);
    await peer.setup({ setupToken, username: cfg.admin, password: cfg.adminPassword, email: `${cfg.admin}@ludworks.test` });
  } else {
    await peer.login(cfg.admin, cfg.adminPassword);
  }
  return peer;
}

/** Create (or reuse) a regular user; returns {username, password}. Usernames get a per-run suffix. */
export async function createUser(admin, base, password = `Pw-${base}-Integration-2026!`) {
  const username = `${base}${process.pid.toString(36)}${Date.now().toString(36).slice(-4)}`.toLowerCase().slice(0, 32);
  await admin.api.post('/admin/users', { username, email: `${username}@ludworks.test`, password, role: 'user' });
  return { username, password };
}

/** Enable two-step verification for the peer's account; returns the base32 secret and recovery codes. */
export async function enableTotp(peer, codeFor) {
  const setup = await peer.api.post('/me/totp/setup', {});
  const code = await codeFor(setup.secret, Date.now());
  const res = await peer.api.post('/me/totp/enable', { code });
  return { secret: setup.secret, otpauth: setup.otpauth_url, recoveryCodes: res.recovery_codes };
}

export async function readText(p) {
  return readFile(p, 'utf8');
}
