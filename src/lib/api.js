// Minimal Ludworks HTTP API v1 client (see ludworks-server docs/spec/API.md) for the extension.
// Bearer-token only (never cookies), no redirects followed, JSON error envelope mapped to ApiError.

const DEFAULT_TIMEOUT_MS = 30000;
const TOKEN_RE = /^lw[sp]_[A-Za-z0-9_-]{16,256}$/;
const PAT_RE = /^lwp_[A-Za-z0-9_-]{16,256}$/;
const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

const STATUS_CODES = {
  400: 'bad_request',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not_found',
  409: 'conflict',
  410: 'gone',
  413: 'payload_too_large',
  415: 'unsupported_media_type',
  422: 'validation_failed',
  429: 'rate_limited',
  500: 'internal',
  501: 'not_implemented',
  503: 'setup_required',
  507: 'insufficient_storage',
};

/** Error carrying the server's `{"error":{"code","message","details"}}` (or a local code). */
export class ApiError extends Error {
  /**
   * @param {{status?: number, code: string, message?: string, details?: any, retryAfter?: number|null}} init
   */
  constructor({ status = 0, code, message, details, retryAfter = null }) {
    super(message || code);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.retryAfter = retryAfter;
  }
}

/**
 * Validate and normalize a user-entered server URL.
 * HTTPS is required unless the host is localhost / 127.0.0.1 / ::1.
 * A path prefix (reverse-proxy sub-path) is kept; query, fragment and credentials are rejected.
 * @param {string} input
 * @returns {string} e.g. "https://nas.example.com" or "https://example.com/ludworks"
 */
export function normalizeServerUrl(input) {
  if (typeof input !== 'string' || !input.trim()) {
    throw new ApiError({ code: 'bad_server_url', message: 'Enter your Ludworks server address.' });
  }
  let s = input.trim();
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s}`;
  let u;
  try {
    u = new URL(s);
  } catch {
    throw new ApiError({ code: 'bad_server_url', message: 'That does not look like a valid server address.' });
  }
  if (u.username || u.password) {
    throw new ApiError({ code: 'bad_server_url', message: 'Do not put credentials in the server address.' });
  }
  if (u.search || u.hash) {
    throw new ApiError({ code: 'bad_server_url', message: 'The server address must not contain ? or #.' });
  }
  if (u.protocol === 'http:') {
    // Exactly the hosts covered by optional_host_permissions and the extension CSP's connect-src.
    if (u.hostname !== 'localhost' && u.hostname !== '127.0.0.1') {
      throw new ApiError({
        code: 'insecure_server_url',
        message: 'HTTPS is required. Plain HTTP is only allowed for localhost and 127.0.0.1.',
      });
    }
  } else if (u.protocol !== 'https:') {
    throw new ApiError({ code: 'bad_server_url', message: 'The server address must start with https://' });
  }
  let path = u.pathname.replace(/\/+$/, '');
  if (path.endsWith('/api/v1')) path = path.slice(0, -'/api/v1'.length);
  return `${u.protocol}//${u.host}${path}`;
}

/**
 * Host-permission match pattern for a server URL (ports are not part of match patterns).
 * @param {string} serverUrl
 * @returns {string}
 */
export function originPattern(serverUrl) {
  const u = new URL(serverUrl);
  return `${u.protocol}//${u.hostname}/*`;
}

function encId(id) {
  if (typeof id !== 'string' || !ID_RE.test(id)) throw new ApiError({ code: 'bad_request', message: 'Invalid id' });
  return encodeURIComponent(id);
}

/**
 * Create an API client.
 * @param {{baseUrl: string, token?: string|null|(() => (string|null)), fetchImpl?: typeof fetch, timeoutMs?: number}} opts
 */
export function createApi({ baseUrl, token = null, fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const base = normalizeServerUrl(baseUrl);
  const getToken = typeof token === 'function' ? token : () => token;

  /**
   * @param {string} method
   * @param {string} path  relative to /api/v1, starting with '/'
   * @param {{query?: Record<string, any>, body?: any, auth?: boolean}} [opts]
   */
  async function request(method, path, { query, body, auth = true } = {}) {
    if (!path.startsWith('/') || path.includes('..')) throw new ApiError({ code: 'bad_request', message: 'Bad path' });
    const url = new URL(`${base}/api/v1${path}`);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
      }
    }
    const headers = { Accept: 'application/json' };
    const init = {
      method,
      headers,
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
    };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    if (auth) {
      const t = getToken();
      if (typeof t !== 'string' || !TOKEN_RE.test(t)) {
        throw new ApiError({ status: 401, code: 'unauthorized', message: 'Not signed in.' });
      }
      headers.Authorization = `Bearer ${t}`;
    }
    let controller = null;
    let timer = null;
    if (typeof AbortController !== 'undefined' && timeoutMs > 0) {
      controller = new AbortController();
      init.signal = controller.signal;
      timer = setTimeout(() => controller.abort(), timeoutMs);
    }
    let res;
    try {
      res = await fetchImpl(url.toString(), init);
    } catch (e) {
      if (controller && controller.signal.aborted) {
        throw new ApiError({ code: 'timeout', message: 'The server did not respond in time.' });
      }
      // A fetch wrapper may already have classified the failure (e.g. certificate_changed when Firefox
      // cancelled a response whose certificate does not match the pin): keep it.
      if (e instanceof ApiError) throw e;
      throw new ApiError({
        code: 'network_error',
        message:
          'Could not reach the server. Check the address, your connection, and that the browser trusts its TLS certificate.',
        details: { cause: String((e && e.message) || e) },
      });
    } finally {
      if (timer) clearTimeout(timer);
    }

    const retryHeader = res.headers && res.headers.get ? res.headers.get('Retry-After') : null;
    const retryAfter = retryHeader && /^\d+$/.test(retryHeader) ? Number(retryHeader) : null;
    if (res.status === 204 || res.status === 205) return null;
    const text = await res.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = undefined;
      }
    }
    if (!res.ok) {
      const err = data && typeof data === 'object' && data.error && typeof data.error === 'object' ? data.error : null;
      throw new ApiError({
        status: res.status,
        code: (err && typeof err.code === 'string' && err.code) || STATUS_CODES[res.status] || 'http_error',
        message: (err && typeof err.message === 'string' && err.message) || `Server returned HTTP ${res.status}`,
        details: err ? err.details : undefined,
        retryAfter,
      });
    }
    if (data === undefined) {
      throw new ApiError({ status: res.status, code: 'bad_response', message: 'The server sent an invalid response.' });
    }
    return data;
  }

  return {
    baseUrl: base,
    request,
    health: () => request('GET', '/health', { auth: false }),
    setupStatus: () => request('GET', '/setup/status', { auth: false }),
    /**
     * POST /auth/login in token mode. Throws ApiError code 'totp_required' when a code is needed.
     * @param {{username: string, password: string, totpCode?: string, recoveryCode?: string, deviceName: string}} p
     */
    async login({ username, password, totpCode, recoveryCode, deviceName }) {
      const body = { username, password, token_mode: true, device_name: deviceName };
      if (totpCode) body.totp_code = totpCode;
      if (recoveryCode) body.recovery_code = recoveryCode;
      const res = await request('POST', '/auth/login', { body, auth: false });
      if (!res || typeof res.token !== 'string' || !TOKEN_RE.test(res.token) || !res.user) {
        throw new ApiError({ code: 'bad_response', message: 'The server did not return a session token.' });
      }
      return res;
    },
    /**
     * POST /me/tokens: a personal access token limited to `scopes` (needs a session with the account scope).
     * @param {{name: string, scopes: string[], expiresInDays: number}} p
     * @returns {Promise<{token: string, expires_at: string|null, scopes: string[]}>}
     */
    async createToken({ name, scopes, expiresInDays }) {
      const res = await request('POST', '/me/tokens', { body: { name, scopes, expires_in_days: expiresInDays } });
      if (!res || typeof res.token !== 'string' || !PAT_RE.test(res.token)) {
        throw new ApiError({ code: 'bad_response', message: 'The server did not return an access token.' });
      }
      const granted = Array.isArray(res.scopes) ? res.scopes : null;
      if (granted && granted.some((s) => !scopes.includes(s))) {
        throw new ApiError({ code: 'bad_response', message: 'The server returned a token with unexpected scopes.' });
      }
      return res;
    },
    logout: () => request('POST', '/auth/logout'),
    session: () => request('GET', '/auth/session'),
    getVault: () => request('GET', '/vault'),
    vaultSync: (since) => request('GET', '/vault/sync', { query: { since } }),
    createItem: ({ id, folderId = null, data }) =>
      request('POST', '/vault/items', { body: { id, folder_id: folderId, data } }),
    updateItem: (id, { folderId = null, data, baseRevision }) =>
      request('PUT', `/vault/items/${encId(id)}`, {
        body: { folder_id: folderId, data, base_revision: baseRevision },
      }),
    deleteItem: (id) => request('DELETE', `/vault/items/${encId(id)}`),
  };
}

export const _internals = { TOKEN_RE, PAT_RE, ID_RE };
