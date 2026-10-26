// Test doubles: chrome.storage areas, a mock Ludworks server (fetch-level), vault param builder.

import * as vc from '../../src/lib/vault-crypto.js';

/** In-memory chrome.storage.* area with JSON semantics. */
export function createStorageArea() {
  const data = new Map();
  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  return {
    data,
    async get(keys) {
      const out = {};
      if (keys === null || keys === undefined) {
        for (const [k, v] of data) out[k] = clone(v);
        return out;
      }
      const list = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
      for (const k of list) {
        if (data.has(k)) out[k] = clone(data.get(k));
        else if (keys && typeof keys === 'object' && !Array.isArray(keys) && k in keys) out[k] = keys[k];
      }
      return out;
    },
    async set(obj) {
      for (const [k, v] of Object.entries(obj)) data.set(k, clone(v));
    },
    async remove(keys) {
      for (const k of typeof keys === 'string' ? [keys] : keys) data.delete(k);
    },
    async clear() {
      data.clear();
    },
    dump() {
      return JSON.stringify(Object.fromEntries(data));
    },
  };
}

export function createStorage() {
  return { local: createStorageArea(), session: createStorageArea() };
}

/** Vault params (as returned by GET /vault) with a low iteration count for fast tests. */
export async function makeVaultParams(password, iterations = 600000) {
  const salt = vc.randomBytes(16);
  const vaultKey = vc.randomBytes(32);
  const wk = await vc.deriveWrapKey(await vc.deriveMasterKey(password, salt, iterations));
  return {
    vaultKey,
    params: {
      kdf: 'pbkdf2-sha256',
      kdf_iterations: iterations,
      kdf_salt: vc.b64encode(salt),
      wrapped_key: await vc.seal(wk, vaultKey, 'ludworks/vault/key/v1'),
    },
  };
}

const FP = 'ab'.repeat(32);

/**
 * Fetch-level fake of the Ludworks API subset used by the extension.
 * @param {{fingerprint?: string|null}} [opts]
 */
export function createMockServer({ fingerprint = FP } = {}) {
  const state = {
    fingerprint,
    setupRequired: false,
    online: true,
    users: new Map([
      ['alice', { id: 'u_alice_00000001', username: 'alice', password: 'alice-login-pw', totp: null }],
      ['bob', { id: 'u_bob_000000000001', username: 'bob', password: 'bob-login-pw', totp: '123456' }],
    ]),
    tokens: new Map(), // token -> username
    tokenInfo: new Map(), // token -> {kind: 'session'|'pat', scopes, name, expiresAt}
    failTokenMint: null, // {status, code} to make POST /me/tokens fail
    vaults: new Map(), // username -> params
    items: new Map(), // username -> Map(id -> VI)
    tombstones: new Map(), // username -> Map(id -> seq)
    seq: 0,
    requests: [],
  };
  const stamp = () => {
    state.seq += 1;
    return `2026-10-26T12:00:00.${String(state.seq).padStart(3, '0')}Z|${String(state.seq).padStart(6, '0')}`;
  };
  const seqOf = (s) => (s ? Number(String(s).split('|')[1]) : 0);
  const newToken = (prefix) => `${prefix}${vc.b64encode(vc.randomBytes(32)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;
  const json = (status, body, headers = {}) =>
    new Response(body === undefined ? null : JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json', ...headers },
    });
  const error = (status, code, message = code, details) => json(status, { error: { code, message, ...(details ? { details } : {}) } });
  const itemsFor = (u) => {
    if (!state.items.has(u)) state.items.set(u, new Map());
    if (!state.tombstones.has(u)) state.tombstones.set(u, new Map());
    return state.items.get(u);
  };

  async function handle(method, url, headers, body) {
    const path = url.pathname.replace(/^\/api\/v1/, '');
    if (method === 'GET' && path === '/setup/status') {
      return json(200, {
        setup_required: state.setupRequired,
        server_name: 'Test NAS',
        registration_enabled: false,
        version: '1.0.0',
        tls_fingerprint_sha256: state.fingerprint,
      });
    }
    if (method === 'POST' && path === '/auth/login') {
      const u = state.users.get(body.username);
      if (!u || u.password !== body.password) return error(401, 'invalid_credentials', 'Invalid username or password');
      if (u.totp) {
        if (!body.totp_code && !body.recovery_code) return error(401, 'totp_required', 'Two-factor code required');
        if (body.totp_code !== u.totp && body.recovery_code !== 'recovery-1') return error(401, 'invalid_credentials', 'Bad code');
      }
      if (body.token_mode !== true) return error(400, 'bad_request', 'expected token_mode');
      const token = newToken('lws_');
      state.tokens.set(token, u.username);
      state.tokenInfo.set(token, { kind: 'session', scopes: ['*'], name: body.device_name, expiresAt: '2026-11-26T12:00:00Z' });
      return json(200, {
        user: { id: u.id, username: u.username, email: `${u.username}@example.com`, display_name: u.username.toUpperCase(), role: 'user' },
        csrf_token: 'csrf',
        expires_at: '2026-11-26T12:00:00Z',
        token,
      });
    }
    const auth = headers.Authorization || headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
    const user = token ? state.tokens.get(token) : null;
    if (!user) return error(401, 'unauthorized', 'Not authenticated');

    const info = state.tokenInfo.get(token) || { kind: 'session', scopes: ['*'] };
    const has = (scope) => info.scopes.includes('*') || info.scopes.includes(scope);

    if (method === 'POST' && path === '/auth/logout') {
      state.tokens.delete(token);
      state.tokenInfo.delete(token);
      return new Response(null, { status: 204 });
    }
    if (method === 'GET' && path === '/auth/session') {
      return json(200, { user: { id: user, username: user }, csrf_token: 'csrf', expires_at: info.expiresAt || null, scopes: info.scopes });
    }
    if (method === 'POST' && path === '/me/tokens') {
      if (!has('account')) return error(403, 'forbidden', 'Insufficient scope');
      if (state.failTokenMint) return error(state.failTokenMint.status, state.failTokenMint.code, 'token mint refused');
      const days = body.expires_in_days;
      if (!body.name || !Array.isArray(body.scopes) || !body.scopes.length || (days !== undefined && (!Number.isInteger(days) || days < 1 || days > 3650))) {
        return error(422, 'validation_failed', 'bad token request');
      }
      if (body.scopes.some((s) => !has(s))) return error(403, 'forbidden', 'Cannot grant a scope you do not hold');
      const pat = newToken('lwp_');
      const expiresAt = days ? new Date(Date.UTC(2026, 9, 26, 12) + days * 86400000).toISOString() : null;
      state.tokens.set(pat, user);
      state.tokenInfo.set(pat, { kind: 'pat', scopes: [...body.scopes], name: body.name, expiresAt, expiresInDays: days });
      return json(201, { id: `tok_${state.tokenInfo.size}`, name: body.name, scopes: body.scopes, created_at: '2026-10-26T12:00:00Z', last_used_at: null, expires_at: expiresAt, prefix: pat.slice(0, 8), token: pat });
    }
    if (path.startsWith('/vault') && !has(method === 'GET' ? 'vault:read' : 'vault:write')) {
      return error(403, 'forbidden', 'Insufficient scope');
    }
    if (path.startsWith('/admin') || path.startsWith('/files') || path.startsWith('/me')) {
      if (!info.scopes.includes('*')) return error(403, 'forbidden', 'Insufficient scope');
      return json(200, { ok: true });
    }
    if (method === 'GET' && path === '/vault') {
      const p = state.vaults.get(user);
      return json(200, p ? { initialized: true, ...p, updated_at: '2026-10-26T12:00:00Z' } : { initialized: false, kdf: 'pbkdf2-sha256', kdf_iterations: 0, kdf_salt: '', wrapped_key: '' });
    }
    if (method === 'GET' && path === '/vault/sync') {
      const since = seqOf(url.searchParams.get('since'));
      const items = [...itemsFor(user).values()].filter((vi) => vi._seq > since).map(({ _seq, ...vi }) => vi);
      const deleted = [...state.tombstones.get(user)].filter(([, s]) => s > since).map(([id]) => id);
      return json(200, { folders: [], items, deleted_item_ids: deleted, deleted_folder_ids: [], server_time: stamp() });
    }
    if (method === 'POST' && path === '/vault/items') {
      const map = itemsFor(user);
      if (map.has(body.id)) return error(409, 'conflict', 'exists');
      const s = stamp();
      const vi = { id: body.id, folder_id: body.folder_id ?? null, data: body.data, revision: 1, created_at: s, updated_at: s, _seq: state.seq };
      map.set(body.id, vi);
      const { _seq, ...out } = vi;
      return json(201, out);
    }
    const m = path.match(/^\/vault\/items\/([A-Za-z0-9_-]+)$/);
    if (m) {
      const map = itemsFor(user);
      const cur = map.get(m[1]);
      if (!cur) return error(404, 'not_found', 'no such item');
      if (method === 'PUT') {
        const { _seq, ...current } = cur;
        if (body.base_revision !== cur.revision) return error(409, 'conflict', 'revision mismatch', { current });
        const s = stamp();
        const vi = { ...cur, data: body.data, folder_id: body.folder_id ?? null, revision: cur.revision + 1, updated_at: s, _seq: state.seq };
        map.set(cur.id, vi);
        const { _seq: _x, ...out } = vi;
        return json(200, out);
      }
      if (method === 'DELETE') {
        map.delete(cur.id);
        stamp();
        state.tombstones.get(user).set(cur.id, state.seq);
        return new Response(null, { status: 204 });
      }
    }
    return error(404, 'not_found', `no route ${method} ${path}`);
  }

  async function fetchImpl(input, init = {}) {
    if (!state.online) throw new TypeError('NetworkError when attempting to fetch resource.');
    const url = new URL(String(input));
    const headers = init.headers || {};
    const body = init.body ? JSON.parse(init.body) : undefined;
    state.requests.push({ method: init.method || 'GET', path: url.pathname, search: url.search, headers, body, init });
    return handle(init.method || 'GET', url, headers, body);
  }

  /** Server-side helpers that act like another device. */
  const admin = {
    async initVault(username, password, iterations = 600000) {
      const v = await makeVaultParams(password, iterations);
      state.vaults.set(username, v.params);
      return v.vaultKey;
    },
    async putItem(username, vaultKey, obj, id = vc.uuid()) {
      const map = itemsFor(username);
      const s = stamp();
      map.set(id, { id, folder_id: null, data: await vc.encryptItem(vaultKey, id, obj), revision: 1, created_at: s, updated_at: s, _seq: state.seq });
      return id;
    },
    rawItems(username) {
      return itemsFor(username);
    },
    deleteItem(username, id) {
      itemsFor(username).delete(id);
      stamp();
      state.tombstones.get(username).set(id, state.seq);
    },
  };

  return { fetch: fetchImpl, state, admin, FP };
}
