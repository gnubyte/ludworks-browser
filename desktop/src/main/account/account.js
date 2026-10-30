// Ludworks account in the browser: sign-in (token mode → vault-scoped device token), server
// identity (TOFU certificate pin), vault unlock/lock (optionally remembered with the OS key store),
// background sync of the vault and of bookmarks/history/tabs/prefs, and the UI commands for them.

import { app, powerMonitor } from 'electron';
import path from 'node:path';
import os from 'node:os';
import * as vc from '../../lib/vault-crypto.js';
import { ApiError, normalizeServerUrl } from '../../lib/api.js';
import { ServerTransport, normalizeFp, formatFp } from './net.js';
import { VaultStore } from './vault.js';
import { BrowserSync } from './browsersync.js';
import { readSecret, writeSecret, secretsAvailable } from './files.js';
import { summarizeItem, byName, cloneJson, newItem, newLoginItem, ITEM_TYPES } from '../../lib/item-model.js';
import { generatePassword, generatePassphrase, estimateStrength, PASSWORD_DEFAULTS, PASSPHRASE_DEFAULTS } from '../../lib/generator.js';
import { generateTotp } from '../../lib/totp.js';
import { log } from '../util/log.js';

const VAULT_SCOPES = ['vault:read', 'vault:write'];
const TOKEN_DAYS = 180;
const SYNC_EVERY_MS = 5 * 60 * 1000;
// A server without the browser-sync module is asked again after this long (or on "Sync now"), so a
// server update is picked up without restarting the browser.
const BROWSER_SYNC_RECHECK_MS = 30 * 60 * 1000;
const BROWSER_SYNC_MISSING = 'This Ludworks server cannot sync bookmarks, history, tabs and settings yet — update the server. Passwords and passkeys sync normally.';
const OFFLINE = new Set(['network_error', 'timeout']);

function err(code, message, extra = {}) {
  return new ApiError({ code, message, ...extra });
}

function errorInfo(e) {
  return { code: (e && e.code) || 'error', message: (e && e.message) || String(e), details: (e && e.details) || null, retryAfter: (e && e.retryAfter) || null };
}

export class Account {
  /** @param {import('../browser.js').Browser} browser */
  constructor(browser) {
    this.b = browser;
    this.dir = path.join(browser.profileDir, 'Ludworks');
    this.accountFile = path.join(this.dir, 'account.bin');
    this.keyFile = path.join(this.dir, 'vault-key.bin');
    this.transport = new ServerTransport();
    this.acc = readSecret(this.accountFile); // {serverUrl, token, expiresAt, user, serverName, pin}
    this.memoryOnly = !secretsAvailable();
    if (this.acc && this.acc.pin) this.transport.setPin(new URL(this.acc.serverUrl).hostname, this.acc.pin);
    this.vault = new VaultStore({ dir: this.dir, api: () => this.api() });
    this.sync = new BrowserSync({ browser, api: () => this.api() });
    this.status = { syncing: false, lastSyncAt: null, error: null, warning: null };
    this.browserSyncMissingAt = 0; // when the server last answered 404 for browser sync (0 = ask it)
    this.vault.on('key-changed', () => this.onKeyChanged());
    this.vault.on('locked', () => this.changed());
    this.vault.on('unlocked', () => this.changed());
    this.vault.on('items', () => {
      this.changed();
      this.b.autofill && this.b.autofill.refreshAll();
    });
    this.vault.on('synced', () => this.b.autofill && this.b.autofill.refreshAll());
    this.vault.on('warning', (w) => {
      this.status.warning = w;
      this.changed();
    });
    this.timers = [];
    this.changeTimer = null;
  }

  // -------------------------------------------------------------------------------- basics
  api() {
    if (!this.acc || !this.acc.token) throw err('not_logged_in', 'Sign in to your Ludworks server first.');
    return this.transport.api(this.acc.serverUrl, this.acc.token);
  }

  serverUrl() {
    return this.acc ? this.acc.serverUrl : null;
  }

  phase() {
    if (!this.acc || !this.acc.token) return 'logged_out';
    const meta = this.vault.meta;
    if (meta && meta.initialized === false) return 'uninitialized';
    return this.vault.isUnlocked() ? 'unlocked' : 'locked';
  }

  summary() {
    const phase = this.phase();
    const meta = this.vault.meta;
    let itemCount = 0;
    if (this.vault.cache && this.vault.cache.items) itemCount = Object.keys(this.vault.cache.items).length;
    return {
      phase,
      user: this.acc ? { username: this.acc.user.username, displayName: this.acc.user.display_name || '' } : null,
      serverUrl: this.acc ? this.acc.serverUrl : null,
      serverHost: this.acc ? new URL(this.acc.serverUrl).host : null,
      serverName: this.acc ? this.acc.serverName || '' : null,
      pinned: !!(this.acc && this.acc.pin),
      fingerprint: this.acc && this.acc.pin ? formatFp(this.acc.pin) : null,
      lastSyncAt: this.status.lastSyncAt,
      syncing: this.status.syncing,
      error: this.status.error,
      warning: this.status.warning || (this.vault.warnings.length ? this.vault.warnings[0] : null),
      itemCount,
      remember: this.b.prefs.get('rememberVault'),
      secureStorage: !this.memoryOnly,
      initialized: !!(meta && meta.initialized),
      tokenExpiresAt: this.acc ? this.acc.expiresAt || null : null,
    };
  }

  changed() {
    clearTimeout(this.changeTimer);
    this.changeTimer = setTimeout(() => {
      // Runs late: windows and tabs may have closed (or the app be quitting) since the change.
      if (this.b.quitting) return;
      this.b.broadcastShared();
      this.b.forEachWindow((w) => {
        if (w.popup && w.popup.kind === 'account' && w.overlay && !w.overlay.webContents.isDestroyed()) w.overlay.webContents.send('popup-data', { kind: 'account', data: this.summary() });
      });
      for (const t of this.b.allTabs()) {
        if (/^ludworks:\/\/(passwords|sync|newtab|welcome)\//.test(t.wc.getURL())) t.wc.send('page-event', { type: 'account', summary: this.summary() });
      }
    }, 30);
  }

  saveAccount() {
    if (this.memoryOnly) return;
    writeSecret(this.accountFile, this.acc);
  }

  // -------------------------------------------------------------------------------- lifecycle
  async start() {
    this.timers.push(setInterval(() => this.backgroundSync('timer'), SYNC_EVERY_MS));
    this.timers.push(setInterval(() => this.autoLockCheck(), 30 * 1000));
    for (const t of this.timers) t.unref && t.unref();
    powerMonitor.on('lock-screen', () => this.systemLocked());
    powerMonitor.on('suspend', () => this.systemLocked());
    powerMonitor.on('resume', () => this.backgroundSync('resume'));
    app.on('browser-window-focus', () => {
      if (Date.now() - (this.lastFocusSync || 0) > 2 * 60 * 1000) {
        this.lastFocusSync = Date.now();
        this.backgroundSync('focus');
      }
    });
    this.b.bookmarks.on('change', () => this.scheduleSync());
    this.b.history.on('change', () => this.scheduleSync(60 * 1000));
    if (!this.acc) return;
    // Silent unlock with the remembered key (only for the current key_id with a matching key_check).
    if (this.b.prefs.get('rememberVault')) {
      const rem = readSecret(this.keyFile);
      if (rem && typeof rem.key === 'string' && typeof rem.key_id === 'string') {
        const raw = vc.b64decode(rem.key);
        try {
          if (await this.vault.unlockWithRemembered(this.acc, raw, rem.key_id)) await this.sync.setKey(raw, rem.key_id);
          else writeSecret(this.keyFile, null);
        } catch (e) {
          if (e instanceof ApiError && e.status === 401) await this.sessionExpired();
          else log.warn('remembered unlock failed', { code: e && e.code });
        } finally {
          raw.fill(0);
        }
      }
    }
    this.changed();
    this.backgroundSync('start');
  }

  stop() {
    for (const t of this.timers) clearInterval(t);
    clearTimeout(this.changeTimer);
    clearTimeout(this.syncTimer);
  }

  onPrefsChange(keys) {
    if (keys.includes('rememberVault') && !this.b.prefs.get('rememberVault')) writeSecret(this.keyFile, null);
    if (keys.some((k) => ['searchEngine', 'customSearch', 'homepage', 'showBookmarksBar'].includes(k))) this.scheduleSync();
  }

  scheduleSync(delay = 15000) {
    clearTimeout(this.syncTimer);
    this.syncTimer = setTimeout(() => this.backgroundSync('change'), delay);
    this.syncTimer.unref && this.syncTimer.unref();
  }

  async backgroundSync(reason) {
    if (!this.acc) return;
    try {
      await this.syncNow();
    } catch (e) {
      if (!OFFLINE.has(e && e.code)) log.info('background sync failed', { reason, code: e && e.code, message: e && e.message });
    }
  }

  /** @param {{manual?: boolean}} [opts] manual: the user asked ("Sync now"), so re-ask a server that lacked browser sync */
  async syncNow({ manual = false } = {}) {
    if (!this.acc) throw err('not_logged_in', 'Not signed in.');
    if (this.status.syncing) return this.summary();
    this.status.syncing = true;
    this.changed();
    try {
      await this.vault.sync(this.acc);
      const askBrowserSync = manual || !this.browserSyncMissingAt || Date.now() - this.browserSyncMissingAt >= BROWSER_SYNC_RECHECK_MS;
      if (this.vault.isUnlocked() && this.sync.ready() && askBrowserSync) {
        try {
          await this.sync.sync();
          this.resetBrowserSyncCheck();
        } catch (e) {
          // Servers older than the browser-sync module (API.md §16) answer 404: passwords and passkeys
          // still sync through the vault; bookmarks/history/tabs/settings stay local until the update.
          if (!(e instanceof ApiError && e.status === 404)) throw e;
          this.browserSyncMissingAt = Date.now();
          this.status.warning = BROWSER_SYNC_MISSING;
        }
      }
      this.status.lastSyncAt = Date.now();
      this.status.error = null;
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) await this.sessionExpired();
      else if (e instanceof ApiError && e.code === 'vault_key_changed') this.onKeyChanged();
      else this.status.error = errorInfo(e);
      throw e;
    } finally {
      this.status.syncing = false;
      this.changed();
    }
    return this.summary();
  }

  autoLockCheck() {
    if (!this.vault.isUnlocked() || this.b.prefs.get('rememberVault')) return;
    const mins = this.b.prefs.get('vaultLockMinutes');
    if (!mins) return;
    try {
      if (powerMonitor.getSystemIdleTime() >= mins * 60) this.lock({ forget: false });
    } catch {
      /* idle time unavailable */
    }
  }

  systemLocked() {
    if (this.vault.isUnlocked() && !this.b.prefs.get('rememberVault')) this.lock({ forget: false });
  }

  onKeyChanged() {
    writeSecret(this.keyFile, null);
    this.vault.lock();
    this.sync.clearKey();
    this.status.error = { code: 'vault_key_changed', message: 'Your vault was changed on another device (new master password, rotation or reset). Unlock it again.' };
    this.changed();
  }

  async sessionExpired() {
    this.wipeLocal();
    this.status.error = { code: 'session_expired', message: 'Your Ludworks session expired or was revoked. Sign in again.' };
    this.changed();
  }

  wipeLocal() {
    this.vault.wipe();
    this.sync.clearKey();
    writeSecret(this.keyFile, null);
    writeSecret(this.accountFile, null);
    this.acc = null;
    this.resetBrowserSyncCheck();
  }

  /** Forget that the server lacked browser sync (it was updated, or this is another account/server). */
  resetBrowserSyncCheck() {
    this.browserSyncMissingAt = 0;
    if (this.status.warning === BROWSER_SYNC_MISSING) this.status.warning = null;
  }

  // ------------------------------------------------------------------------- server identity
  /**
   * Contact a server without credentials. Reports whether its certificate needs confirming.
   * @returns {Promise<{serverUrl, host, secure, trust: 'ca'|'pinned'|'needs_confirm'|'changed'|'none', fingerprint, reported, interception, serverName, version, setupRequired}>}
   */
  async probe(input) {
    const serverUrl = normalizeServerUrl(input);
    const u = new URL(serverUrl);
    const host = u.hostname;
    const secure = u.protocol === 'https:';
    let st = null;
    let netErr = null;
    try {
      st = await this.transport.api(serverUrl).setupStatus();
    } catch (e) {
      netErr = e;
    }
    const seen = secure ? this.transport.lastSeen(host) : null;
    const pin = this.transport.pins.get(host) || null;
    if (!st) {
      if (secure && seen && !seen.trusted && seen.fingerprint && seen.fingerprint !== pin) {
        return { serverUrl, host, secure, trust: pin ? 'changed' : 'needs_confirm', fingerprint: formatFp(seen.fingerprint), fingerprintHex: seen.fingerprint, pinned: pin ? formatFp(pin) : null, reported: null, interception: false };
      }
      throw netErr || err('network_error', 'Could not reach the server.');
    }
    const reported = normalizeFp(st.tls_fingerprint_sha256);
    const observed = seen ? seen.fingerprint : '';
    return {
      serverUrl,
      host,
      secure,
      trust: !secure ? 'none' : seen && seen.trusted ? 'ca' : 'pinned',
      fingerprint: observed ? formatFp(observed) : null,
      reported: reported ? formatFp(reported) : null,
      interception: !!(observed && reported && observed !== reported && !(seen && seen.trusted)),
      serverName: typeof st.server_name === 'string' ? st.server_name.slice(0, 200) : '',
      version: typeof st.version === 'string' ? st.version.slice(0, 50) : '',
      setupRequired: st.setup_required === true,
    };
  }

  /** The user confirmed this fingerprint for this server (TOFU). */
  trust(serverUrl, fingerprintHex) {
    const host = new URL(normalizeServerUrl(serverUrl)).hostname;
    const fp = normalizeFp(fingerprintHex);
    if (!fp) throw err('bad_request', 'Invalid fingerprint.');
    this.transport.setPin(host, fp);
    this.pendingPin = { host, fp };
    this.b.pinnedHosts.set(host, fp);
  }

  // ------------------------------------------------------------------------------- sign in/out
  async signIn({ serverUrl: input, username, password, totpCode, recoveryCode }) {
    const probe = await this.probe(input);
    if (probe.trust === 'needs_confirm' || probe.trust === 'changed') throw err('server_not_trusted', 'Confirm the server certificate first.', { details: probe });
    if (probe.interception) throw err('certificate_changed', 'The certificate this connection uses differs from the one the server reports — the connection may be intercepted.', { details: probe });
    if (probe.setupRequired) throw err('setup_required', 'This server has not been set up yet. Open it in a tab to finish the first-time setup.');
    if (!probe.secure && !/^(localhost|127\.0\.0\.1|\[::1\])$/.test(probe.host)) throw err('insecure', 'Ludworks needs HTTPS (plain HTTP only works for localhost).');
    const api = this.transport.api(probe.serverUrl);
    const deviceName = `Ludworks Browser (${process.platform === 'win32' ? 'Windows' : process.platform === 'darwin' ? 'macOS' : 'Linux'}, ${os.hostname().split('.')[0].slice(0, 30)})`;
    const res = await api.login({ username, password, totpCode: totpCode ? String(totpCode).replace(/\s+/g, '') : undefined, recoveryCode: recoveryCode || undefined, deviceName });
    // Least privilege: keep only a vault-scoped device token; revoke the full-scope session right away.
    let pat;
    const sessionApi = this.transport.api(probe.serverUrl, res.token);
    try {
      pat = await sessionApi.createToken({ name: deviceName, scopes: VAULT_SCOPES, expiresInDays: TOKEN_DAYS });
    } finally {
      sessionApi.logout().catch(() => {});
    }
    const prev = this.acc;
    const user = { id: String(res.user.id || ''), username: String(res.user.username || ''), display_name: String(res.user.display_name || ''), email: String(res.user.email || '') };
    const sameUser = prev && prev.serverUrl === probe.serverUrl && prev.user && prev.user.id === user.id;
    if (prev && prev.token && !sameUser) {
      this.transport.api(prev.serverUrl, prev.token).logout().catch(() => {});
      this.vault.wipe();
      this.sync.clearKey();
      writeSecret(this.keyFile, null);
    }
    this.acc = {
      serverUrl: probe.serverUrl,
      token: pat.token,
      expiresAt: typeof pat.expires_at === 'string' ? pat.expires_at : null,
      user,
      serverName: probe.serverName,
      pin: probe.trust === 'pinned' ? this.transport.pins.get(probe.host) || null : null,
      signedInAt: new Date().toISOString(),
    };
    if (this.acc.pin) this.b.pinnedHosts.set(probe.host, this.acc.pin);
    this.saveAccount();
    this.status.error = null;
    this.resetBrowserSyncCheck();
    try {
      await this.vault.refreshMeta(this.acc);
    } catch (e) {
      if (!OFFLINE.has(e && e.code)) throw e;
    }
    this.changed();
    return this.summary();
  }

  async signOut() {
    if (this.acc) {
      await this.sync.dropOwnTabs();
      try {
        await this.api().logout();
      } catch {
        /* already revoked / offline: the token is wiped locally anyway */
      }
    }
    this.wipeLocal();
    this.status = { syncing: false, lastSyncAt: null, error: null, warning: null };
    this.changed();
    return this.summary();
  }

  // ---------------------------------------------------------------------------- lock / unlock
  async unlock(password, { remember = null } = {}) {
    if (!this.acc) throw err('not_logged_in', 'Sign in first.');
    const raw = await this.vault.unlockWithPassword(this.acc, password);
    try {
      await this.sync.setKey(raw, this.vault.keyId);
      const keep = remember === null ? this.b.prefs.get('rememberVault') : !!remember;
      if (remember !== null && remember !== this.b.prefs.get('rememberVault')) this.b.prefs.update({ rememberVault: keep });
      if (keep && !this.memoryOnly) writeSecret(this.keyFile, { key_id: this.vault.keyId, key: vc.b64encode(raw) });
    } finally {
      raw.fill(0);
    }
    this.status.error = null;
    this.changed();
    this.syncNow().catch(() => {});
    return this.summary();
  }

  async createVault(password) {
    if (!this.acc) throw err('not_logged_in', 'Sign in first.');
    if (typeof password !== 'string' || password.length < 12) throw err('validation_failed', 'Choose a master password of at least 12 characters.');
    const raw = await this.vault.init(this.acc, password);
    try {
      await this.sync.setKey(raw, this.vault.keyId);
    } finally {
      raw.fill(0);
    }
    this.changed();
    this.syncNow().catch(() => {});
    return this.summary();
  }

  lock({ forget = true } = {}) {
    if (forget) writeSecret(this.keyFile, null);
    this.vault.lock();
    this.sync.clearKey();
    this.changed();
    return this.summary();
  }

  // ----------------------------------------------------------------------------- vault views
  async listItems() {
    const { items, folders } = await this.vault.list();
    const out = [];
    let undecryptable = 0;
    for (const { vi, data, stale } of items.values()) {
      if (!data) {
        undecryptable++;
        continue;
      }
      const s = summarizeItem(vi, data, folders);
      s.passkeys = data.type === 'login' && data.login && Array.isArray(data.login.passkeys) ? data.login.passkeys.length : 0;
      s.stale = stale || null;
      out.push(s);
    }
    out.sort(byName);
    return { items: out, folders: [...folders].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name)), undecryptable };
  }

  /** All decrypted login items (autofill, passkeys). Stale items are excluded (§2.5). */
  async logins() {
    if (!this.vault.isUnlocked()) return [];
    const items = await this.vault.decryptAll();
    const out = [];
    for (const { vi, data, stale } of items.values()) if (data && !stale && data.type === 'login' && data.login) out.push({ id: vi.id, revision: vi.revision, folderId: vi.folder_id || null, data });
    return out;
  }

  // ------------------------------------------------------------------------------- UI: shell
  async shellCommand(ctl, cmd, a) {
    try {
      return { ok: true, value: await this.command(cmd, a, ctl) };
    } catch (e) {
      return { ok: false, error: errorInfo(e) };
    }
  }

  async popupAction(ctl, kind, action, d) {
    return this.shellCommand(ctl, `account.${action}`, d);
  }

  async pageCommand(tab, cmd, a) {
    try {
      return { ok: true, value: await this.command(cmd, a, tab.ctl, tab) };
    } catch (e) {
      return { ok: false, error: errorInfo(e) };
    }
  }

  /** Shared command set for the account popup and the passwords / sync pages. */
  async command(cmd, a, ctl, tab = null) {
    const str = (v, max = 4096) => (typeof v === 'string' ? v.slice(0, max) : '');
    switch (cmd) {
      case 'account.summary':
        return this.summary();
      case 'account.probe':
        return this.probe(str(a.serverUrl, 2048));
      case 'account.trust':
        this.trust(str(a.serverUrl, 2048), str(a.fingerprint, 200));
        return this.probe(str(a.serverUrl, 2048));
      case 'account.signin':
        return this.signIn({ serverUrl: str(a.serverUrl, 2048), username: str(a.username, 320), password: str(a.password, 1024), totpCode: str(a.totpCode, 16) || undefined, recoveryCode: str(a.recoveryCode, 64) || undefined });
      case 'account.signout':
        return this.signOut();
      case 'account.unlock':
        return this.unlock(str(a.password, 1024), { remember: typeof a.remember === 'boolean' ? a.remember : null });
      case 'account.create-vault':
        return this.createVault(str(a.password, 1024));
      case 'account.lock':
        return this.lock({ forget: true });
      case 'account.sync':
        return this.syncNow({ manual: true });
      case 'account.open':
        if (ctl) this.b.openInternal(ctl, a.page === 'sync' ? 'sync' : 'passwords');
        if (ctl) ctl.hidePopup('account');
        return null;
      case 'account.open-web':
        if (ctl && this.acc) {
          ctl.hidePopup('account');
          ctl.newTab({ url: this.acc.serverUrl });
        }
        return null;
      case 'sync.status':
        return { summary: this.summary(), sync: this.sync.lastResult, remoteTabs: this.sync.remoteTabs(), prefs: this.b.prefs.get('sync'), deviceId: this.sync.deviceId };
      case 'sync.set': {
        const cur = { ...this.b.prefs.get('sync') };
        for (const k of ['bookmarks', 'history', 'tabs', 'prefs']) if (typeof a[k] === 'boolean') cur[k] = a[k];
        this.b.prefs.update({ sync: cur });
        return cur;
      }
      case 'sync.open-tab':
        if (tab && typeof a.url === 'string' && /^https?:/i.test(a.url)) this.b.openIn(tab.ctl, a.url, 'new-tab');
        return null;

      // ------------------------------------------------------------- vault (passwords page)
      case 'vault.list':
        return this.listItems();
      case 'vault.get': {
        const e = await this.vault.get(str(a.id, 64));
        return { id: e.vi.id, folderId: e.vi.folder_id || null, revision: e.vi.revision, createdAt: e.vi.created_at, updatedAt: e.vi.updated_at, data: cloneJson(e.data), stale: e.stale || null };
      }
      case 'vault.new':
        if (!ITEM_TYPES.includes(a.type)) throw err('bad_request', 'Unknown item type.');
        return a.type === 'login' ? newLoginItem({ url: str(a.url, 4096) }) : newItem(a.type);
      case 'vault.save':
        return this.vault.save(this.acc, { id: a.id ? str(a.id, 64) : null, folderId: a.folderId === undefined ? undefined : a.folderId ? str(a.folderId, 64) : null, data: a.data, baseRevision: Number.isSafeInteger(a.baseRevision) ? a.baseRevision : null });
      case 'vault.delete':
        await this.vault.remove(this.acc, str(a.id, 64));
        return null;
      case 'vault.folder.create':
        return this.vault.createFolder(this.acc, str(a.name, 500));
      case 'vault.folder.rename':
        return this.vault.renameFolder(this.acc, str(a.id, 64), str(a.name, 500));
      case 'vault.folder.delete':
        return this.vault.deleteFolder(this.acc, str(a.id, 64));
      case 'vault.totp': {
        const e = await this.vault.get(str(a.id, 64));
        const t = e.data.login && e.data.login.totp;
        if (!t) return null;
        return generateTotp(t, Date.now());
      }
      case 'vault.generate':
        return a.mode === 'passphrase' ? generatePassphrase({ ...PASSPHRASE_DEFAULTS, ...(a.options || {}) }) : generatePassword({ ...PASSWORD_DEFAULTS, ...(a.options || {}) });
      case 'vault.strength':
        return estimateStrength(str(a.password, 1024));
      case 'vault.verify':
        return this.vault.verifyPassword(str(a.password, 1024));
      case 'vault.copy': {
        const { copySecret } = await import('../autofill.js');
        copySecret(str(a.text, 8192));
        return null;
      }
      case 'account.signin-popup':
        if (ctl) ctl.shell.send('open-account');
        return null;
      default:
        throw err('bad_request', `Unknown command ${cmd}`);
    }
  }
}
