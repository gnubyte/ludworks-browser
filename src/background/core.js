// Background core: account session, server identity (TOFU pin), vault metadata + encrypted cache, unlock/lock,
// sync, item CRUD, fill resolution and "offer to save" state.
//
// Browser-API agnostic so it can be unit tested: it only needs two storage areas with the
// chrome.storage get/set/remove/clear promise API and a fetch implementation.
//
// Storage rules (VAULT-CRYPTO.md §7):
//   storage.local   : account {serverUrl, token, user}, pins, settings, vaultMeta (KDF params + wrapped key),
//                     vaultCache (ENCRYPTED sync payload), neverSave (SHA-256 of registrable domains)
//   storage.session : vaultKey (base64, memory only), lastActivity, lastUsed, pendingCaptures, certProblem
// The master password, master key and wrap key are never stored anywhere.
//
// The stored token is a personal access token limited to `vault:read vault:write` (never the full-scope
// `*` session the login returns, which is revoked right after the vault token was issued), expiring when
// the login session would have.

import * as vc from '../lib/vault-crypto.js';
import { ApiError, createApi, normalizeServerUrl } from '../lib/api.js';
import { ruleMatches, registrableDomain, pageSecurity, parseHttpUrl, siteName, hostLabel, matchScore, bestMatchScore, STRONG_MATCH } from '../lib/url-match.js';
import { normalizeFingerprint, fingerprintsEqual } from '../lib/fingerprint.js';
import {
  summarizeItem,
  applyPasswordHistory,
  validateItemData,
  newLoginItem,
  scoredMatches,
  byName,
  cloneJson,
} from '../lib/item-model.js';
import { generateTotp } from '../lib/totp.js';

export const DEFAULT_SETTINGS = Object.freeze({ lockMinutes: 15, saveLogins: false });
/** The only scopes the extension's stored token carries (API.md: vault endpoints). */
export const VAULT_SCOPES = Object.freeze(['vault:read', 'vault:write']);
const TOKEN_MAX_DAYS = 30;
/**
 * Firefox: a token is only sent when the pinned certificate was seen on a response from the server within
 * this window; otherwise an unauthenticated /setup/status probe runs first (certpin.js explains why).
 */
export const CERT_VERIFY_WINDOW_MS = 5000;
const PENDING_TTL_MS = 5 * 60 * 1000;
const isId = (v) => vc.isValidId(v);
const MAX_SEALED = 512 * 1024;
const OFFLINE_CODES = new Set(['network_error', 'timeout']);

const te = new TextEncoder();

function err(code, message, extra = {}) {
  return new ApiError({ code, message, ...extra });
}

function isValidVI(vi) {
  return (
    vi &&
    typeof vi === 'object' &&
    typeof vi.id === 'string' &&
    isId(vi.id) &&
    typeof vi.data === 'string' &&
    vi.data.length <= MAX_SEALED &&
    Number.isSafeInteger(vi.revision) &&
    (vi.folder_id === undefined || vi.folder_id === null || isId(vi.folder_id))
  );
}

function isValidVF(vf) {
  return vf && typeof vf === 'object' && isId(vf.id) && typeof vf.name === 'string';
}

function cleanVI(vi) {
  return {
    id: vi.id,
    folder_id: vi.folder_id || null,
    data: vi.data,
    revision: vi.revision,
    created_at: typeof vi.created_at === 'string' ? vi.created_at : null,
    updated_at: typeof vi.updated_at === 'string' ? vi.updated_at : null,
  };
}

function pickUser(u) {
  return {
    id: String(u.id || ''),
    username: String(u.username || ''),
    display_name: String(u.display_name || ''),
    email: String(u.email || ''),
  };
}

async function sha256Hex(text) {
  const d = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', te.encode(text)));
  return Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('');
}

function originOf(serverUrl) {
  return new URL(serverUrl).origin;
}

/**
 * @param {{
 *   storage: {local: any, session: any},
 *   fetchImpl?: typeof fetch,
 *   browserName?: string,
 *   version?: string,
 *   now?: () => number,
 *   certObserver?: {watch(origin: string, pin: string|null): void, observed(origin: string): string|null,
 *                   takeMismatch(origin: string): string|null, status(origin: string): any}|null,
 *   emit?: (event: string) => void,
 * }} deps
 */
export function createCore({
  storage,
  fetchImpl = (...a) => globalThis.fetch(...a),
  browserName = 'dev',
  version = '0.0.0',
  now = () => Date.now(),
  certObserver = null,
  emit = () => {},
}) {
  const local = storage.local;
  const session = storage.session;
  const deviceName = `${browserName === 'firefox' ? 'Firefox' : browserName === 'chrome' ? 'Chrome' : 'Browser'} extension`;

  let cacheGen = 0;
  let decrypted = null;
  let keyCache = null;
  let syncing = null;

  const iso = () => new Date(now()).toISOString();
  const invalidate = () => {
    cacheGen++;
    decrypted = null;
  };

  async function getLocal(keys) {
    return (await local.get(keys)) || {};
  }
  async function getSession(keys) {
    return (await session.get(keys)) || {};
  }

  async function pinFor(origin) {
    const { pins } = await getLocal('pins');
    return (pins && pins[origin]) || null;
  }

  /**
   * Record an unresolved certificate problem. `tokenSent`: the mismatch was found on the response to a
   * request that carried a token, so the token may be in the interceptor's hands (kept until resolved).
   */
  async function recordCertProblem(origin, presented, { tokenSent = false, unpinned = false } = {}) {
    const prev = await certProblemFor(origin);
    const problem = { origin, presented: presented || null, at: now(), tokenExposed: !!(tokenSent || (prev && prev.tokenExposed)) };
    if (unpinned) problem.unpinned = true;
    await session.set({ certProblem: problem });
    emit('state');
    return problem;
  }

  function apiFor(serverUrl, token = null) {
    const origin = originOf(serverUrl);
    return createApi({
      baseUrl: serverUrl,
      token,
      fetchImpl: async (url, init) => {
        // Firefox: arm the pin check for EVERY request to the server (also the first one after an
        // event-page restart, logout and token revocation), not only for some code paths.
        if (certObserver) {
          const pin = await pinFor(origin);
          certObserver.watch(origin, pin ? pin.fingerprint : null);
        }
        try {
          return await fetchImpl(url, init);
        } catch (e) {
          const presented = certObserver && certObserver.takeMismatch(origin);
          if (presented) {
            const problem = await recordCertProblem(origin, presented, { tokenSent: !!token });
            throw err('certificate_changed', 'The server presented a different TLS certificate than the one you trusted.', {
              details: { presented, tokenExposed: problem.tokenExposed },
            });
          }
          throw e;
        }
      },
    });
  }

  async function account() {
    const { account: acc } = await getLocal('account');
    return acc && acc.serverUrl && acc.token ? acc : null;
  }

  async function requireAccount() {
    const acc = await account();
    if (!acc) throw err('not_logged_in', 'Sign in to your Ludworks server first.');
    return acc;
  }

  /** The unresolved certificate problem for an origin, if any (set by checkIdentity / the Firefox observer). */
  async function certProblemFor(origin) {
    const { certProblem } = await getSession('certProblem');
    return certProblem && certProblem.origin === origin ? certProblem : null;
  }

  function certChangedError(problem) {
    return err('certificate_changed', 'The server certificate does not match the one you trusted. Review it before continuing.', {
      details: { presented: problem.presented || null, tokenExposed: !!problem.tokenExposed },
    });
  }

  /**
   * Gate in front of EVERY request that carries a token. Nothing is sent while a certificate problem is
   * unresolved. On Firefox the pin can only be checked on a response, i.e. after the request (and its
   * Authorization header) went out, so a token is only sent when the pinned certificate was just seen on a
   * response from this server; otherwise an unauthenticated probe runs first and must pass.
   * @param {string} serverUrl
   */
  async function guardServer(serverUrl) {
    const origin = originOf(serverUrl);
    const problem = await certProblemFor(origin);
    if (problem) throw certChangedError(problem);
    if (!certObserver || !serverUrl.startsWith('https:')) return;
    const pin = await pinFor(origin);
    if (pin && certObserver.recentlyVerified(origin, pin.fingerprint, CERT_VERIFY_WINDOW_MS)) return;
    await checkIdentity(serverUrl);
  }

  /** A token-bearing call to `serverUrl` through the certificate gate. */
  async function withToken(serverUrl, token, fn) {
    await guardServer(serverUrl);
    return fn(apiFor(serverUrl, token));
  }

  /** Revoke a token on its server (best effort, never sent past the certificate gate). */
  async function revokeToken(serverUrl, token) {
    try {
      await withToken(serverUrl, token, (api) => api.logout());
      return true;
    } catch (e) {
      // already invalid on the server: nothing left to revoke
      return e instanceof ApiError && e.status === 401;
    }
  }

  /**
   * Exchange a freshly issued full-scope (`*`) session token for a vault-only personal access token that
   * expires no later than the session would have (at most TOKEN_MAX_DAYS). The caller revokes the session.
   * @returns {Promise<{token: string, expiresAt: string|null}>}
   */
  async function mintVaultToken(serverUrl, sessionToken, sessionExpiresAt) {
    const left = Date.parse(sessionExpiresAt || '') - now();
    const days = Number.isFinite(left) ? Math.min(TOKEN_MAX_DAYS, Math.max(1, Math.ceil(left / 86400000))) : TOKEN_MAX_DAYS;
    const res = await withToken(serverUrl, sessionToken, (api) =>
      api.createToken({ name: deviceName, scopes: [...VAULT_SCOPES], expiresInDays: days }),
    );
    return { token: res.token, expiresAt: typeof res.expires_at === 'string' ? res.expires_at : null };
  }

  let upgrading = null;

  /**
   * Accounts signed in by an older version hold a full-scope `lws_` session token: swap it for a vault-only
   * token once (single flight), then revoke the session. Offline or refused: keep working, retry later.
   */
  async function upgradeLegacyToken(acc) {
    if (!acc.token.startsWith('lws_')) return acc;
    if (!upgrading) {
      upgrading = (async () => {
        let scoped;
        try {
          scoped = await mintVaultToken(acc.serverUrl, acc.token, acc.expiresAt);
        } catch (e) {
          if (e instanceof ApiError && (e.status === 401 || e.code === 'certificate_changed' || e.code === 'certificate_unverified')) throw e;
          return acc;
        }
        const next = { ...acc, token: scoped.token, expiresAt: scoped.expiresAt || acc.expiresAt || null };
        await local.set({ account: next });
        await revokeToken(acc.serverUrl, acc.token);
        return next;
      })().finally(() => {
        upgrading = null;
      });
    }
    return upgrading;
  }

  /**
   * Run an authenticated API call through the certificate gate; a 401 wipes the (revoked/expired) device
   * access. While the server's certificate does not match the pin, nothing (and no token) is sent until the
   * user re-confirms it.
   */
  async function authed(fn) {
    let acc = await requireAccount();
    try {
      await guardServer(acc.serverUrl);
      acc = await upgradeLegacyToken(acc);
      return await fn(apiFor(acc.serverUrl, acc.token), acc);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        await wipeAccount();
        throw err('session_expired', 'Your session expired or was revoked. Please sign in again.', { status: 401 });
      }
      throw e;
    }
  }

  // ---------------------------------------------------------------------------------------- state

  async function getState() {
    const { account: acc, vaultMeta, settings, pins, vaultCache } = await getLocal([
      'account',
      'vaultMeta',
      'settings',
      'pins',
      'vaultCache',
    ]);
    const { vaultKey, certProblem } = await getSession(['vaultKey', 'certProblem']);
    let phase;
    if (!acc || !acc.token) phase = 'logged_out';
    else if (certProblem) phase = 'cert_changed';
    else if (vaultMeta && vaultMeta.initialized === false) phase = 'uninitialized';
    else if (!vaultKey) phase = 'locked';
    else phase = 'unlocked';
    const origin = acc ? originOf(acc.serverUrl) : null;
    const pin = origin && pins ? pins[origin] : null;
    return {
      phase,
      browser: browserName,
      version,
      settings: { ...DEFAULT_SETTINGS, ...(settings || {}) },
      serverUrl: acc ? acc.serverUrl : null,
      serverName: acc ? acc.serverName || '' : null,
      user: acc ? { username: acc.user.username, displayName: acc.user.display_name || '' } : null,
      pin: pin ? { fingerprint: pin.fingerprint, source: pin.source, trustedAt: pin.trustedAt } : null,
      certProblem: certProblem || null,
      certCheck: certObserver && origin ? certObserver.status(origin) : null,
      lastSyncAt: vaultCache && vaultCache.syncedAt ? vaultCache.syncedAt : null,
      itemCount: vaultCache && vaultCache.items ? Object.keys(vaultCache.items).length : 0,
    };
  }

  // ------------------------------------------------------------------------- server identity / pin

  /**
   * Contact a server (no credentials) and report its identity relative to any pinned certificate.
   * @param {string} serverUrlInput
   */
  async function probeServer(serverUrlInput) {
    const serverUrl = normalizeServerUrl(serverUrlInput);
    const origin = originOf(serverUrl);
    const pin = await pinFor(origin);
    // Firefox: only the certificate seen on THIS probe's response counts (never an older observation).
    const tlsObserved = !!certObserver && serverUrl.startsWith('https:');
    const mark = tlsObserved ? certObserver.mark() : 0;
    let st;
    try {
      st = await apiFor(serverUrl).setupStatus();
    } catch (e) {
      if (!(e instanceof ApiError) || e.code !== 'certificate_changed' || !tlsObserved || !pin) throw e;
      // Firefox cancelled the (unauthenticated) response because the certificate differs from the pin:
      // report what was presented so the user can review it, like Chrome does with the reported one.
      const seen = certObserver.observedSince(origin, mark);
      return {
        serverUrl,
        origin,
        secure: true,
        serverName: '',
        version: '',
        setupRequired: false,
        fingerprint: seen ? normalizeFingerprint(seen.fingerprint) : null,
        fingerprintSource: 'tls',
        reportedFingerprint: null,
        interceptionSuspected: false,
        pinStatus: 'changed',
        pinnedFingerprint: pin.fingerprint,
      };
    }
    if (!st || typeof st !== 'object') throw err('bad_response', 'Unexpected response from server.');
    const reported = normalizeFingerprint(st.tls_fingerprint_sha256);
    const seen = tlsObserved ? certObserver.observedSince(origin, mark) : null;
    const observed = seen ? normalizeFingerprint(seen.fingerprint) : null;
    const fingerprint = observed || reported;
    const source = observed ? 'tls' : reported ? 'server' : null;
    let pinStatus;
    if (!pin) pinStatus = fingerprint ? 'new' : 'none';
    else if (tlsObserved && !observed) pinStatus = 'unverified'; // Firefox saw no certificate on this response
    else if (!fingerprint) pinStatus = 'changed';
    else pinStatus = fingerprintsEqual(pin.fingerprint, fingerprint) ? 'trusted' : 'changed';
    return {
      serverUrl,
      origin,
      secure: serverUrl.startsWith('https:'),
      serverName: typeof st.server_name === 'string' ? st.server_name.slice(0, 200) : '',
      version: typeof st.version === 'string' ? st.version.slice(0, 50) : '',
      setupRequired: st.setup_required === true,
      fingerprint,
      fingerprintSource: source,
      reportedFingerprint: reported,
      interceptionSuspected: !!(observed && reported && !fingerprintsEqual(observed, reported)),
      pinStatus,
      pinnedFingerprint: pin ? pin.fingerprint : null,
    };
  }

  /**
   * Pin the fingerprint the server presents right now (must equal what the user confirmed). When the
   * problem being resolved may have exposed the stored token (a mismatch found only after a token-bearing
   * request went out), that token is revoked and the user must sign in again, so it rotates.
   */
  async function trustServer(serverUrlInput, fingerprint) {
    const probe = await probeServer(serverUrlInput);
    const fp = normalizeFingerprint(fingerprint);
    if (!fp || !probe.fingerprint || !fingerprintsEqual(fp, probe.fingerprint)) {
      throw err('fingerprint_mismatch', 'The server certificate changed while you were confirming it. Check again.');
    }
    const { pins } = await getLocal('pins');
    const next = { ...(pins || {}) };
    next[probe.origin] = { fingerprint: fp, source: probe.fingerprintSource, trustedAt: iso() };
    await local.set({ pins: next });
    const problem = await certProblemFor(probe.origin);
    if (problem) await session.remove('certProblem');
    if (certObserver) certObserver.watch(probe.origin, fp);
    const acc = await account();
    if (problem && problem.tokenExposed && acc && originOf(acc.serverUrl) === probe.origin) {
      await revokeToken(acc.serverUrl, acc.token);
      await wipeAccount();
      return { ...(await getState()), signedOutReason: 'token_exposed' };
    }
    emit('state');
    return getState();
  }

  async function forgetPin() {
    const acc = await account();
    const { pins } = await getLocal('pins');
    if (acc && pins) {
      const next = { ...pins };
      delete next[originOf(acc.serverUrl)];
      await local.set({ pins: next });
    }
    await session.remove('certProblem');
    emit('state');
    return getState();
  }

  /**
   * Verify the server identity against the pin before credentials or a token are sent; records a
   * certProblem and throws on mismatch. A signed-in server that presents a fingerprint but has no pin (the
   * user forgot it) must be confirmed again first.
   */
  async function checkIdentity(serverUrl) {
    const probe = await probeServer(serverUrl);
    if (probe.pinStatus === 'unverified') {
      throw err('certificate_unverified', 'Could not verify the server certificate. Try again.');
    }
    const unpinned = probe.pinStatus === 'new';
    if (probe.pinStatus === 'changed' || probe.interceptionSuspected || unpinned) {
      const problem = await recordCertProblem(probe.origin, probe.fingerprint, { unpinned });
      throw err('certificate_changed', 'The server certificate does not match the one you trusted.', {
        details: { presented: probe.fingerprint, pinned: probe.pinnedFingerprint, tokenExposed: problem.tokenExposed },
      });
    }
    return probe;
  }

  // ------------------------------------------------------------------------------------ auth

  async function login({ serverUrl: input, username, password, totpCode, recoveryCode }) {
    const probe = await probeServer(input);
    if (probe.setupRequired) {
      throw err('setup_required', 'This server has not been set up yet. Open it in a browser tab to finish the first-time setup.');
    }
    if (probe.interceptionSuspected || probe.pinStatus === 'changed') {
      throw err('certificate_changed', 'The server certificate does not match the one you trusted.', { details: probe });
    }
    if (probe.pinStatus === 'unverified') {
      throw err('certificate_unverified', 'Could not verify the server certificate. Try again.');
    }
    if (probe.pinStatus === 'new') {
      throw err('server_not_trusted', 'Confirm the server fingerprint before signing in.', { details: probe });
    }
    // A stale problem for this server is resolved by the probe that just passed.
    await session.remove('certProblem');
    const api = apiFor(probe.serverUrl);
    const res = await api.login({
      username,
      password,
      totpCode: totpCode ? totpCode.replace(/\s+/g, '') : undefined,
      recoveryCode: recoveryCode || undefined,
      deviceName,
    });
    // Least privilege: the login returns a full-scope session (files, notes, admin, token minting...). Keep
    // only a vault-scoped token and revoke the session at once; never store the session token.
    let scoped;
    try {
      scoped = await mintVaultToken(probe.serverUrl, res.token, res.expires_at);
    } catch (e) {
      await revokeToken(probe.serverUrl, res.token);
      if (e instanceof ApiError && e.code === 'certificate_changed') throw e;
      throw err('token_failed', `The server did not issue a vault access token for this browser: ${(e && e.message) || 'unknown error'}`, {
        status: (e && e.status) || 0,
        details: { cause: (e && e.code) || null },
      });
    }
    await revokeToken(probe.serverUrl, res.token);
    const prev = await account();
    const user = pickUser(res.user);
    const same = prev && prev.serverUrl === probe.serverUrl && prev.user && prev.user.id === user.id;
    if (prev && prev.token && prev.token !== scoped.token) {
      // best effort: revoke the previous device token we are replacing (through the certificate gate)
      revokeToken(prev.serverUrl, prev.token).catch(() => {});
    }
    if (!same) await local.remove(['vaultMeta', 'vaultCache']);
    await session.remove(['vaultKey', 'pendingCaptures', 'lastUsed', 'certProblem']);
    invalidate();
    keyCache = null;
    await local.set({
      account: {
        serverUrl: probe.serverUrl,
        token: scoped.token,
        user,
        expiresAt: scoped.expiresAt || (typeof res.expires_at === 'string' ? res.expires_at : null),
        serverName: probe.serverName,
        loggedInAt: iso(),
      },
    });
    try {
      await refreshVaultMeta();
    } catch (e) {
      if (!(e instanceof ApiError) || !OFFLINE_CODES.has(e.code)) throw e;
    }
    emit('state');
    return getState();
  }

  async function wipeAccount() {
    await local.remove(['account', 'vaultMeta', 'vaultCache']);
    await session.clear();
    invalidate();
    keyCache = null;
    emit('logged_out');
  }

  /**
   * Revoke the device token on the server, then wipe locally. The revocation goes through the certificate
   * gate: with an unresolved certificate problem (or a failed pre-send check) the token is NOT sent to
   * whoever answers now; the local wipe still happens and `serverRevoked: false` tells the popup to ask the
   * user to revoke "<browser> extension" from the Sessions list of the web app on a trusted network.
   */
  async function logout() {
    const acc = await account();
    const serverRevoked = acc ? await revokeToken(acc.serverUrl, acc.token) : true;
    await wipeAccount();
    return { ...(await getState()), serverRevoked };
  }

  async function clearAllData() {
    await local.clear();
    await session.clear();
    invalidate();
    keyCache = null;
    emit('logged_out');
    return getState();
  }

  // ------------------------------------------------------------------------------- vault

  /**
   * Fetch GET /vault and cache it. The vault key in storage.session is only valid for the wrapped key it
   * was unwrapped from: when another device changed the master password, or reset and re-created the
   * vault (a NEW vault key), the session key is dropped (vault locked) so it can never be used to encrypt
   * items that the other clients could not read. Same rule as the web app (wrapped_key changed → lock).
   */
  async function refreshVaultMeta() {
    const v = await authed((api) => api.getVault());
    let meta;
    if (v && v.initialized === true) {
      if (typeof v.kdf_salt !== 'string' || typeof v.wrapped_key !== 'string') {
        throw err('bad_response', 'The server returned incomplete vault parameters.');
      }
      meta = {
        initialized: true,
        kdf: v.kdf,
        kdf_iterations: v.kdf_iterations,
        kdf_salt: v.kdf_salt,
        wrapped_key: v.wrapped_key,
        updated_at: typeof v.updated_at === 'string' ? v.updated_at : null,
      };
    } else {
      meta = { initialized: false };
    }
    await local.set({ vaultMeta: meta });
    const { vaultKey, vaultKeyFor } = await getSession(['vaultKey', 'vaultKeyFor']);
    if (vaultKey && (!meta.initialized || vaultKeyFor !== meta.wrapped_key)) await lock();
    return meta;
  }

  async function unlock(password) {
    const acc = await requireAccount();
    let { vaultMeta: meta } = await getLocal('vaultMeta');
    try {
      await checkIdentity(acc.serverUrl);
      meta = await refreshVaultMeta();
    } catch (e) {
      if (!(e instanceof ApiError) || !OFFLINE_CODES.has(e.code) || !meta) throw e;
      // offline: unlock with the cached KDF parameters and wrapped key
    }
    if (!meta || !meta.initialized) throw err('vault_uninitialized', 'Your password vault has not been set up yet.');
    let vk;
    try {
      vk = await vc.unlockVault(password, meta);
    } catch (e) {
      if (e && e.code === 'bad_password') throw err('bad_password', 'Wrong master password.');
      throw err((e && e.code) || 'unlock_failed', (e && e.message) || 'Could not unlock the vault.');
    }
    const b64 = vc.b64encode(vk);
    vk.fill(0);
    await session.set({ vaultKey: b64, vaultKeyFor: meta.wrapped_key, lastActivity: now() });
    invalidate();
    emit('unlocked');
    try {
      await sync({ metaFresh: true });
    } catch (e) {
      if (!(e instanceof ApiError) || !OFFLINE_CODES.has(e.code)) throw e;
    }
    return getState();
  }

  async function lock() {
    await session.remove(['vaultKey', 'vaultKeyFor', 'pendingCaptures', 'lastUsed']);
    invalidate();
    keyCache = null;
    emit('locked');
    return getState();
  }

  async function isUnlocked() {
    const { vaultKey } = await getSession('vaultKey');
    return typeof vaultKey === 'string' && vaultKey.length > 0;
  }

  async function getKey() {
    const { vaultKey } = await getSession('vaultKey');
    if (!vaultKey) throw err('locked', 'The vault is locked.');
    if (!keyCache || keyCache.b64 !== vaultKey) {
      const raw = vc.b64decode(vaultKey);
      try {
        keyCache = { b64: vaultKey, key: await vc.importAesKey(raw) };
      } finally {
        raw.fill(0);
      }
    }
    return keyCache.key;
  }

  /**
   * Pull changes into the encrypted cache. Also re-reads the vault parameters (unless the caller just did):
   * a vault reset / re-created / re-keyed on another device locks this one (see refreshVaultMeta).
   * @param {{metaFresh?: boolean}} [opts]
   */
  async function sync({ metaFresh = false } = {}) {
    if (syncing) return syncing;
    syncing = (async () => {
      const acc = await requireAccount();
      const owner = `${acc.user.id}@${acc.serverUrl}`;
      await checkIdentity(acc.serverUrl);
      if (!metaFresh) {
        const meta = await refreshVaultMeta();
        if (!meta.initialized) {
          await local.remove('vaultCache');
          invalidate();
          emit('synced');
          return { itemCount: 0, syncedAt: null };
        }
      }
      const { vaultCache } = await getLocal('vaultCache');
      let cache = vaultCache && vaultCache.owner === owner ? vaultCache : null;
      let res;
      try {
        res = await authed((api) => api.vaultSync(cache ? cache.since : null));
      } catch (e) {
        if (cache && cache.since && e instanceof ApiError && (e.code === 'gone' || e.code === 'bad_request')) {
          cache = null;
          res = await authed((api) => api.vaultSync(null));
        } else {
          throw e;
        }
      }
      if (!res || typeof res !== 'object') throw err('bad_response', 'Unexpected sync response.');
      const full = !cache || !cache.since;
      const next = full ? { owner, since: null, items: {}, folders: {} } : cloneJson(cache);
      for (const f of Array.isArray(res.folders) ? res.folders : []) {
        if (isValidVF(f)) next.folders[f.id] = { id: f.id, name: f.name, revision: f.revision ?? 0 };
      }
      for (const vi of Array.isArray(res.items) ? res.items : []) {
        if (isValidVI(vi)) next.items[vi.id] = cleanVI(vi);
      }
      for (const id of Array.isArray(res.deleted_item_ids) ? res.deleted_item_ids : []) delete next.items[id];
      for (const id of Array.isArray(res.deleted_folder_ids) ? res.deleted_folder_ids : []) delete next.folders[id];
      next.since = typeof res.server_time === 'string' ? res.server_time : null;
      next.syncedAt = now();
      await local.set({ vaultCache: next });
      invalidate();
      emit('synced');
      return { itemCount: Object.keys(next.items).length, syncedAt: next.syncedAt };
    })();
    try {
      return await syncing;
    } finally {
      syncing = null;
    }
  }

  async function decryptAll() {
    const key = await getKey();
    const gen = cacheGen;
    if (decrypted && decrypted.gen === gen && decrypted.keyB64 === keyCache.b64) return decrypted;
    const { vaultCache } = await getLocal('vaultCache');
    const folders = new Map();
    const items = new Map();
    for (const f of Object.values((vaultCache && vaultCache.folders) || {})) {
      try {
        folders.set(f.id, await vc.decryptFolder(key, f.id, f.name));
      } catch {
        folders.set(f.id, '');
      }
    }
    for (const vi of Object.values((vaultCache && vaultCache.items) || {})) {
      try {
        items.set(vi.id, { vi, data: await vc.decryptItem(key, vi.id, vi.data) });
      } catch (e) {
        items.set(vi.id, { vi, data: null, error: (e && e.code) || 'decrypt_failed' });
      }
    }
    const result = { gen, keyB64: keyCache.b64, items, folders };
    if (gen === cacheGen) decrypted = result;
    return result;
  }

  async function listItems({ url = null } = {}) {
    const d = await decryptAll();
    const { lastUsed } = await getSession('lastUsed');
    const { vaultCache } = await getLocal('vaultCache');
    const items = [];
    let undecryptable = 0;
    for (const { vi, data } of d.items.values()) {
      if (!data) {
        undecryptable++;
        continue;
      }
      items.push(summarizeItem(vi, data, d.folders));
    }
    items.sort(byName);
    const scored = url ? scoredMatches(items, url, lastUsed || {}) : [];
    const matches = scored.map((s) => s.it.id);
    // Logins saved for ANOTHER host of the same site (domain rule): listed, but the popup shows which host
    // they belong to and asks before filling; the fill shortcut never fills them.
    const otherHost = {};
    for (const { it, score } of scored) {
      if (score >= STRONG_MATCH) continue;
      otherHost[it.id] = [...new Set(it.uris.filter((u) => matchScore(url, u) > 0).map((u) => hostLabel(u.uri)).filter(Boolean))];
    }
    const folders = [...d.folders]
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return { items, matches, otherHost, folders, undecryptable, syncedAt: (vaultCache && vaultCache.syncedAt) || null };
  }

  async function getItem(id) {
    const d = await decryptAll();
    const entry = d.items.get(id);
    if (!entry) throw err('not_found', 'Item not found.');
    if (!entry.data) throw err('decrypt_failed', 'This item could not be decrypted with your vault key.');
    return {
      id,
      folderId: entry.vi.folder_id || null,
      revision: entry.vi.revision,
      createdAt: entry.vi.created_at,
      updatedAt: entry.vi.updated_at,
      data: cloneJson(entry.data),
    };
  }

  async function putCacheItem(vi) {
    const { vaultCache } = await getLocal('vaultCache');
    if (!vaultCache) return;
    const next = { ...vaultCache, items: { ...vaultCache.items, [vi.id]: cleanVI(vi) } };
    await local.set({ vaultCache: next });
    invalidate();
  }

  async function dropCacheItem(id) {
    const { vaultCache } = await getLocal('vaultCache');
    if (!vaultCache || !vaultCache.items || !vaultCache.items[id]) return;
    const items = { ...vaultCache.items };
    delete items[id];
    await local.set({ vaultCache: { ...vaultCache, items } });
    invalidate();
  }

  async function saveItem({ id = null, folderId, data, baseRevision = null }) {
    const problem = validateItemData(data);
    if (problem) throw err('validation_failed', problem);
    await getKey(); // locked → fail before any request
    // Never encrypt with a key the vault no longer uses (re-keyed / re-created on another device).
    await refreshVaultMeta();
    const key = await getKey().catch(() => {
      throw err('locked', 'Your vault was changed on another device (new master password or reset). Unlock it again.');
    });
    const stamp = iso();
    let vi;
    if (!id) {
      const newId = vc.uuid();
      const obj = { ...cloneJson(data), created_at: data.created_at || stamp, updated_at: stamp };
      const enc = await vc.encryptItem(key, newId, obj);
      vi = await authed((api) => api.createItem({ id: newId, folderId: folderId || null, data: enc }));
    } else {
      const d = await decryptAll();
      const existing = d.items.get(id);
      if (!existing) throw err('not_found', 'Item not found.');
      if (!existing.data) throw err('decrypt_failed', 'This item cannot be edited because it could not be decrypted.');
      const obj = applyPasswordHistory(existing.data, data, stamp);
      obj.updated_at = stamp;
      obj.created_at = obj.created_at || existing.data.created_at || existing.vi.created_at || stamp;
      const enc = await vc.encryptItem(key, id, obj);
      try {
        vi = await authed((api) =>
          api.updateItem(id, {
            folderId: folderId === undefined ? existing.vi.folder_id || null : folderId,
            data: enc,
            baseRevision: Number.isSafeInteger(baseRevision) ? baseRevision : existing.vi.revision,
          }),
        );
      } catch (e) {
        if (e instanceof ApiError && e.code === 'conflict') {
          const current = e.details && e.details.current;
          if (isValidVI(current)) await putCacheItem(current);
          emit('items');
          throw err('conflict', 'This item was changed on another device. Your edit was not saved — review the latest version and try again.', { status: 409 });
        }
        throw e;
      }
    }
    if (isValidVI(vi)) await putCacheItem(vi);
    else await sync();
    emit('items');
    return { id: isValidVI(vi) ? vi.id : id, revision: isValidVI(vi) ? vi.revision : null };
  }

  async function deleteItem(id) {
    await getKey(); // must be unlocked
    try {
      await authed((api) => api.deleteItem(id));
    } catch (e) {
      if (!(e instanceof ApiError) || e.code !== 'not_found') throw e;
    }
    await dropCacheItem(id);
    emit('items');
    return { id };
  }

  // ------------------------------------------------------------------------------ autofill

  /**
   * Credentials for filling item `id` into `pageUrl`. Enforces the item's URI rules. A login saved for
   * another host of the same site (domain rule, score 1) is only filled after the user confirmed that
   * host (`allowOtherHost`, set by the popup's confirmation dialog); the error names the saved host(s).
   * @param {string} id
   * @param {string} pageUrl
   * @param {{allowOtherHost?: boolean}} [opts]
   * @returns {Promise<{username: string, password: string, totp: string, uris: Array}>}
   */
  async function resolveFill(id, pageUrl, { allowOtherHost = false } = {}) {
    const item = await getItem(id);
    const data = item.data;
    if (data.type !== 'login' || !data.login) throw err('not_login', 'Only logins can be filled.');
    const uris = Array.isArray(data.login.uris) ? data.login.uris.filter((u) => u && typeof u.uri === 'string') : [];
    if (!parseHttpUrl(pageUrl) || !uris.some((u) => ruleMatches(pageUrl, u))) {
      throw err('uri_mismatch', 'This login is not saved for this website.');
    }
    if (bestMatchScore(pageUrl, uris) < STRONG_MATCH && !allowOtherHost) {
      const savedFor = [...new Set(uris.filter((u) => ruleMatches(pageUrl, u)).map((u) => hostLabel(u.uri)).filter(Boolean))];
      throw err('other_host', `This login was saved for ${savedFor.join(', ') || 'another host'}, not for ${hostLabel(pageUrl)}.`, {
        details: { savedFor, pageHost: hostLabel(pageUrl) },
      });
    }
    let totp = '';
    if (typeof data.login.totp === 'string' && data.login.totp.trim()) {
      try {
        totp = (await generateTotp(data.login.totp, now())).code;
      } catch {
        totp = '';
      }
    }
    return {
      username: typeof data.login.username === 'string' ? data.login.username : '',
      password: typeof data.login.password === 'string' ? data.login.password : '',
      totp,
      uris: uris.map((u) => ({ uri: u.uri, match: u.match || 'domain' })),
    };
  }

  /**
   * The login the fill shortcut may fill without any UI: only one saved for this very host (or a stricter
   * rule). Logins saved for another host of the same site are never filled this way (the shortcut opens
   * the popup, which names the saved host and asks).
   * @returns {Promise<string|null>}
   */
  async function bestMatchFor(pageUrl) {
    const { matches, otherHost } = await listItems({ url: pageUrl });
    return matches.length && !otherHost[matches[0]] ? matches[0] : null;
  }

  async function markUsed(id) {
    const { lastUsed } = await getSession('lastUsed');
    await session.set({ lastUsed: { ...(lastUsed || {}), [id]: now() } });
  }

  // ------------------------------------------------------------------------------ settings & activity

  async function getSettings() {
    const { settings } = await getLocal('settings');
    return { ...DEFAULT_SETTINGS, ...(settings || {}) };
  }

  async function updateSettings(patch) {
    const next = { ...(await getSettings()) };
    if (patch.lockMinutes !== undefined) next.lockMinutes = patch.lockMinutes;
    if (patch.saveLogins !== undefined) next.saveLogins = patch.saveLogins;
    await local.set({ settings: next });
    emit('state');
    return next;
  }

  async function touch() {
    await session.set({ lastActivity: now() });
  }

  /** @returns {Promise<{due: boolean, deadline: number|null}>} */
  async function autoLockStatus() {
    if (!(await isUnlocked())) return { due: false, deadline: null };
    const { lastActivity } = await getSession('lastActivity');
    const { lockMinutes } = await getSettings();
    const deadline = (Number(lastActivity) || 0) + lockMinutes * 60000;
    return { due: now() >= deadline, deadline };
  }

  // ------------------------------------------------------------------------------ offer to save
  //
  // Nothing is ever shown inside the page (a page can hide, overlay or click-jack anything in its DOM, and
  // could tell from a prompt whether a submitted password is the saved one). A captured login waits per tab
  // in memory-only session storage; the background badges the toolbar button and the user confirms in the
  // extension popup, which shows the exact host and username and which pages cannot reach. Content scripts
  // can only report a submission. "Update" only ever targets a login saved for that very host.

  async function neverHashes() {
    const { neverSave } = await getLocal('neverSave');
    return Array.isArray(neverSave) ? neverSave : [];
  }

  async function pendingMap() {
    const { pendingCaptures } = await getSession('pendingCaptures');
    const map = { ...(pendingCaptures || {}) };
    for (const [k, v] of Object.entries(map)) if (!v || now() - v.at > PENDING_TTL_MS) delete map[k];
    return map;
  }

  async function captureSubmitted({ tabId, pageUrl, username, password }) {
    const settings = await getSettings();
    if (!settings.saveLogins || !(await isUnlocked())) return { pending: false };
    const sec = pageSecurity(pageUrl);
    if (sec === 'insecure') return { pending: false };
    const u = parseHttpUrl(pageUrl);
    const domain = registrableDomain(u.hostname);
    if (!domain) return { pending: false };
    if ((await neverHashes()).includes(await sha256Hex(domain))) return { pending: false };
    const d = await decryptAll();
    let target = null;
    for (const [id, { data }] of d.items) {
      if (!data || data.type !== 'login' || !data.login) continue;
      const uris = Array.isArray(data.login.uris) ? data.login.uris : [];
      const score = bestMatchScore(pageUrl, uris);
      if (score === 0) continue;
      const user = String(data.login.username || '');
      if (user.toLowerCase() !== username.toLowerCase()) continue;
      if (data.login.password === password) return { pending: false }; // already saved
      // Only a login saved for this very host can be updated from this page. Another host of the same
      // site gets the offer to save a separate login instead of overwriting that one.
      if (score >= STRONG_MATCH && !target) target = { id, name: typeof data.name === 'string' ? data.name : '' };
    }
    const map = await pendingMap();
    map[String(tabId)] = {
      id: vc.uuid(),
      kind: target ? 'update' : 'save',
      itemId: target ? target.id : null,
      itemName: target ? target.name.slice(0, 200) : '',
      pageUrl: pageUrl.slice(0, 4096),
      origin: u.origin,
      host: u.host,
      domain,
      username,
      password,
      at: now(),
    };
    await session.set({ pendingCaptures: map });
    return { pending: true };
  }

  /**
   * The login captured in a tab and waiting for the user, for the popup only (it carries no password).
   * @param {{tabId: number}} p
   */
  async function capturePending({ tabId }) {
    if (!(await isUnlocked())) return { show: false };
    const p = (await pendingMap())[String(tabId)];
    if (!p) return { show: false };
    return { show: true, id: p.id, kind: p.kind, host: p.host, domain: p.domain, username: p.username, itemName: p.itemName || '' };
  }

  /**
   * The user's decision in the popup on the capture it displayed (`id`): a capture that changed or
   * expired meanwhile is left alone, so the user only ever confirms exactly what they saw.
   * @param {{tabId: number, id: string, decision: 'save'|'update'|'never'|'dismiss'}} p
   */
  async function captureDecision({ tabId, id, decision }) {
    const map = await pendingMap();
    const key = String(tabId);
    const p = map[key];
    if (!p || p.id !== id) return { done: false };
    delete map[key];
    await session.set({ pendingCaptures: map });
    if (decision === 'dismiss') return { done: true };
    if (decision === 'never') {
      const hashes = await neverHashes();
      const h = await sha256Hex(p.domain);
      if (!hashes.includes(h)) await local.set({ neverSave: [...hashes, h].slice(-5000) });
      return { done: true };
    }
    if (decision !== p.kind) return { done: false };
    if (decision === 'update') {
      const item = await getItem(p.itemId);
      const data = cloneJson(item.data);
      const uris = data.login && Array.isArray(data.login.uris) ? data.login.uris : [];
      if (data.type !== 'login' || bestMatchScore(p.pageUrl, uris) < STRONG_MATCH) {
        throw err('uri_mismatch', 'That login is no longer saved for this website.');
      }
      data.login.password = p.password;
      await saveItem({ id: p.itemId, data, baseRevision: item.revision });
      return { done: true, id: p.itemId };
    }
    // saved automatically: bound to the exact host it was captured on (VAULT-CRYPTO.md §8.3)
    const data = newLoginItem({ name: siteName(p.origin), url: p.origin, username: p.username, password: p.password, now: iso(), match: 'host' });
    const res = await saveItem({ data });
    return { done: true, id: res.id };
  }

  async function dropPending(tabId) {
    const map = await pendingMap();
    if (map[String(tabId)]) {
      delete map[String(tabId)];
      await session.set({ pendingCaptures: map });
    }
  }

  return {
    getState,
    probeServer,
    trustServer,
    forgetPin,
    login,
    logout,
    clearAllData,
    refreshVaultMeta,
    unlock,
    lock,
    isUnlocked,
    sync,
    listItems,
    getItem,
    saveItem,
    deleteItem,
    resolveFill,
    bestMatchFor,
    markUsed,
    getSettings,
    updateSettings,
    touch,
    autoLockStatus,
    captureSubmitted,
    capturePending,
    captureDecision,
    dropPending,
    account,
  };
}
