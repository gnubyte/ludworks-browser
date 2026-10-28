// The end-to-end encrypted vault on this device (VAULT-CRYPTO.md): encrypted sync cache, unlock /
// lock, key identity (§2.2), freshness / rollback marks (§2.5), item and folder edits, batch import.
//
// Persisted (ciphertext only):  <profile>/Ludworks/vault-cache.json   sync payload + vault parameters
//                               <profile>/Ludworks/vault-marks.json   per-key high-water marks + deleted ids
// In memory while unlocked:     the vault key (non-extractable CryptoKey), decrypted items.
// Never persisted unencrypted:  master password, master/wrap key, vault key (§7).

import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import * as vc from '../../lib/vault-crypto.js';
import { ApiError } from '../../lib/api.js';
import { validateItemData, applyPasswordHistory, cloneJson } from '../../lib/item-model.js';
import { readJson, writeJsonAtomic } from './files.js';

export const AAD_CHECK = 'ludworks/vault/check/v1';
const MAX_SEALED = 512 * 1024;
const OFFLINE = new Set(['network_error', 'timeout']);

const sha = (s) => createHash('sha256').update(s).digest('hex');
const isId = (v) => vc.isValidId(v);

function err(code, message, extra = {}) {
  return new ApiError({ code, message, ...extra });
}

function validVI(vi) {
  return vi && typeof vi === 'object' && isId(vi.id) && typeof vi.data === 'string' && vi.data.length <= MAX_SEALED && Number.isSafeInteger(vi.revision) && (vi.folder_id == null || isId(vi.folder_id));
}

function cleanVI(vi) {
  return { id: vi.id, folder_id: vi.folder_id || null, data: vi.data, revision: vi.revision, created_at: typeof vi.created_at === 'string' ? vi.created_at : null, updated_at: typeof vi.updated_at === 'string' ? vi.updated_at : null };
}

export class VaultStore extends EventEmitter {
  /**
   * @param {{dir: string, api: () => any, now?: () => number}} o  api(): authenticated API client (throws when signed out)
   */
  constructor({ dir, api, now = () => Date.now() }) {
    super();
    this.dir = dir;
    this.apiFn = api;
    this.now = now;
    this.cachePath = `${dir}/vault-cache.json`;
    this.marksPath = `${dir}/vault-marks.json`;
    this.cache = readJson(this.cachePath, null);
    this.marks = readJson(this.marksPath, {});
    this.key = null; // CryptoKey
    this.keyId = null; // key_id the key belongs to
    this.unlockedAt = 0;
    this.unlockedWithPassword = 0;
    this.items = null; // Map id → {vi, data|null, error?, stale?}
    this.folders = null; // Map id → name
    this.warnings = [];
    this.syncing = null;
  }

  get meta() {
    return (this.cache && this.cache.meta) || null;
  }

  isUnlocked() {
    return !!this.key;
  }

  owner(acc) {
    return acc ? `${acc.user.id}@${acc.serverUrl}` : '';
  }

  saveCache() {
    if (this.cache) writeJsonAtomic(this.cachePath, this.cache);
  }

  saveMarks() {
    writeJsonAtomic(this.marksPath, this.marks);
  }

  /** Forget everything stored for the vault (sign-out, other account). */
  wipe() {
    this.lock();
    this.cache = null;
    this.marks = {};
    writeJsonAtomic(this.cachePath, null);
    writeJsonAtomic(this.marksPath, {});
  }

  // ------------------------------------------------------------------------------ parameters
  /**
   * Re-read GET /vault. Locks (and drops a remembered key) when the vault key changed (§2.2).
   * @returns {Promise<object>} meta
   */
  async refreshMeta(acc) {
    const v = await this.apiFn().getVault();
    let meta;
    if (v && v.initialized === true) {
      if (typeof v.kdf_salt !== 'string' || typeof v.wrapped_key !== 'string' || typeof v.key_id !== 'string') throw err('bad_response', 'The server returned incomplete vault parameters.');
      meta = { initialized: true, kdf: v.kdf, kdf_iterations: v.kdf_iterations, kdf_salt: v.kdf_salt, wrapped_key: v.wrapped_key, key_id: v.key_id, key_check: typeof v.key_check === 'string' ? v.key_check : null, updated_at: v.updated_at || null };
    } else meta = { initialized: false };
    const owner = this.owner(acc);
    if (!this.cache || this.cache.owner !== owner) this.cache = { v: 1, owner, meta, since: null, syncedAt: null, items: {}, folders: {} };
    const prev = this.cache.meta;
    this.cache.meta = meta;
    if (!meta.initialized || (prev && prev.key_id && prev.key_id !== meta.key_id)) {
      // vault reset / re-created / rotated: the cached ciphertext belongs to a retired key
      this.cache.items = {};
      this.cache.folders = {};
      this.cache.since = null;
    }
    this.saveCache();
    if (this.key && (!meta.initialized || meta.key_id !== this.keyId)) {
      this.lock();
      this.emit('key-changed');
    }
    return meta;
  }

  // -------------------------------------------------------------------------------- unlock
  /**
   * Unlock with the master password. Returns the raw key bytes (caller zeroes them after use).
   */
  async unlockWithPassword(acc, password) {
    let meta = this.meta;
    try {
      meta = await this.refreshMeta(acc);
    } catch (e) {
      if (!(e instanceof ApiError) || !OFFLINE.has(e.code) || !meta) throw e;
    }
    if (!meta || !meta.initialized) throw err('vault_uninitialized', 'Your password vault has not been set up yet.');
    let raw;
    try {
      raw = await vc.unlockVault(password, meta);
    } catch (e) {
      if (e && e.code === 'bad_password') throw err('bad_password', 'Wrong master password.');
      throw err((e && e.code) || 'unlock_failed', (e && e.message) || 'Could not unlock the vault.');
    }
    const key = await vc.importAesKey(raw);
    // A key_check that does not open under the authoritative unwrapped key is reported, not trusted.
    if (meta.key_check) {
      try {
        await vc.open(key, meta.key_check, AAD_CHECK);
      } catch {
        this.warnings.push('The vault key commitment stored on the server does not match your vault key.');
      }
    } else {
      // best effort: store the commitment so remembered keys can be validated (§2.2)
      vc.seal(key, new Uint8Array(0), AAD_CHECK)
        .then((check) => this.apiFn().request('PUT', '/vault/key-check', { body: { key_id: meta.key_id, key_check: check } }))
        .catch(() => {});
    }
    this.setKey(key, meta.key_id);
    this.unlockedWithPassword = this.now();
    return raw;
  }

  /** Re-use a remembered key (DPAPI/Keychain copy): only for the current key_id and a key_check that opens. */
  async unlockWithRemembered(acc, raw, keyId) {
    let meta = this.meta;
    try {
      meta = await this.refreshMeta(acc);
    } catch (e) {
      if (!(e instanceof ApiError) || !OFFLINE.has(e.code) || !meta) throw e;
    }
    if (!meta || !meta.initialized || meta.key_id !== keyId) return false;
    const key = await vc.importAesKey(raw);
    if (meta.key_check) {
      try {
        await vc.open(key, meta.key_check, AAD_CHECK);
      } catch {
        return false;
      }
    }
    this.setKey(key, keyId);
    return true;
  }

  /** Verify a master password without changing state (passkey user verification, exports). */
  async verifyPassword(password) {
    const meta = this.meta;
    if (!meta || !meta.initialized) return false;
    try {
      const raw = await vc.unlockVault(password, meta);
      raw.fill(0);
      this.unlockedWithPassword = this.now();
      return true;
    } catch {
      return false;
    }
  }

  setKey(key, keyId) {
    this.key = key;
    this.keyId = keyId;
    this.unlockedAt = this.now();
    this.items = null;
    this.emit('unlocked');
  }

  lock() {
    const was = !!this.key;
    this.key = null;
    this.keyId = null;
    this.items = null;
    this.folders = null;
    if (was) this.emit('locked');
  }

  requireKey() {
    if (!this.key) throw err('locked', 'The vault is locked.');
    return this.key;
  }

  /** Create the vault (first device): new random key wrapped with the master password. */
  async init(acc, password) {
    const meta = await this.refreshMeta(acc);
    if (meta.initialized) throw err('conflict', 'This account already has a vault.');
    const { params, vaultKey } = await vc.createVault(password);
    const key = await vc.importAesKey(vaultKey);
    const keyCheck = await vc.seal(key, new Uint8Array(0), AAD_CHECK);
    await this.apiFn().request('POST', '/vault/init', { body: { ...params, key_check: keyCheck } });
    await this.refreshMeta(acc);
    this.setKey(key, this.meta.key_id);
    this.unlockedWithPassword = this.now();
    return vaultKey;
  }

  // ---------------------------------------------------------------------------------- sync
  async sync(acc) {
    if (this.syncing) return this.syncing;
    this.syncing = (async () => {
      const meta = await this.refreshMeta(acc);
      if (!meta.initialized) {
        this.items = null;
        this.emit('synced');
        return { itemCount: 0 };
      }
      const cache = this.cache;
      let res;
      try {
        res = await this.apiFn().vaultSync(cache.since);
      } catch (e) {
        if (cache.since && e instanceof ApiError && (e.code === 'gone' || e.status === 410 || e.code === 'bad_request')) {
          cache.since = null;
          cache.items = {};
          cache.folders = {};
          res = await this.apiFn().vaultSync(null);
        } else throw e;
      }
      if (!res || typeof res !== 'object') throw err('bad_response', 'Unexpected sync response.');
      if (res.key_id !== meta.key_id) {
        // records sealed under another key: never merge them (§2.2)
        this.lock();
        this.emit('key-changed');
        throw err('vault_key_changed', 'Your vault key changed on another device. Unlock again.');
      }
      const full = !cache.since;
      if (full) {
        cache.items = {};
        cache.folders = {};
      }
      const marks = this.marksFor(meta.key_id);
      for (const f of Array.isArray(res.folders) ? res.folders : []) {
        if (f && isId(f.id) && typeof f.name === 'string') cache.folders[f.id] = { id: f.id, name: f.name, revision: f.revision ?? 0 };
      }
      for (const vi of Array.isArray(res.items) ? res.items : []) {
        if (!validVI(vi)) continue;
        cache.items[vi.id] = cleanVI(vi);
      }
      for (const id of Array.isArray(res.deleted_item_ids) ? res.deleted_item_ids : []) {
        delete cache.items[id];
        if (isId(id) && !marks.deleted.includes(id)) marks.deleted.push(id);
      }
      for (const id of Array.isArray(res.deleted_folder_ids) ? res.deleted_folder_ids : []) delete cache.folders[id];
      if (marks.deleted.length > 20000) marks.deleted = marks.deleted.slice(-20000);
      cache.since = typeof res.server_time === 'string' ? res.server_time : null;
      cache.syncedAt = this.now();
      this.saveCache();
      this.saveMarks();
      this.items = null;
      if (this.key) await this.decryptAll();
      this.emit('synced');
      return { itemCount: Object.keys(cache.items).length };
    })();
    try {
      return await this.syncing;
    } finally {
      this.syncing = null;
    }
  }

  marksFor(keyId) {
    if (!this.marks[keyId]) this.marks = { [keyId]: { items: {}, deleted: [] } }; // only the current key matters
    return this.marks[keyId];
  }

  /**
   * Decrypt the cache and apply the §2.5 freshness checks: an item offering a lower `seq` than we
   * saw, the same `seq` with different ciphertext, or a re-appearing deleted id is marked stale
   * (shown with a warning, never used for autofill).
   */
  async decryptAll() {
    const key = this.requireKey();
    if (this.items) return this.items;
    const cache = this.cache || { items: {}, folders: {} };
    const folders = new Map();
    for (const f of Object.values(cache.folders || {})) {
      try {
        folders.set(f.id, await vc.decryptFolder(key, f.id, f.name));
      } catch {
        folders.set(f.id, '');
      }
    }
    const marks = this.marksFor(this.keyId);
    const items = new Map();
    let marksChanged = false;
    for (const vi of Object.values(cache.items || {})) {
      let data = null;
      let error = null;
      try {
        data = await vc.decryptItem(key, vi.id, vi.data);
      } catch (e) {
        error = (e && e.code) || 'decrypt_failed';
      }
      let stale = null;
      if (data) {
        const seq = Number.isSafeInteger(data.seq) ? data.seq : 0;
        const h = sha(vi.data);
        const m = marks.items[vi.id];
        if (marks.deleted.includes(vi.id)) stale = 'This item was deleted earlier and re-appeared on the server.';
        else if (m && seq < m.seq) stale = 'The server offered an older version of this item.';
        else if (m && seq === m.seq && m.hash && m.hash !== h && seq > 0) stale = 'The server offered a different version of this item with the same edit number.';
        else if (!m || seq > m.seq || (seq === m.seq && !m.hash)) {
          marks.items[vi.id] = { seq, updated_at: vi.updated_at, hash: h };
          marksChanged = true;
        }
        if (data.folder_id !== undefined && data.folder_id !== (vi.folder_id || null) && data.folder_id !== null && folders.has(data.folder_id)) {
          stale = stale || 'This item was moved without being re-encrypted.';
        }
      }
      items.set(vi.id, { vi, data, error, stale });
    }
    if (marksChanged) this.saveMarks();
    this.items = items;
    this.folders = folders;
    if ([...items.values()].some((x) => x.stale)) this.emit('warning', 'Some vault items failed the freshness check (possible server rollback).');
    return items;
  }

  // --------------------------------------------------------------------------------- items
  async list() {
    const items = await this.decryptAll();
    return { items, folders: this.folders };
  }

  async get(id) {
    const items = await this.decryptAll();
    const e = items.get(id);
    if (!e) throw err('not_found', 'Item not found.');
    if (!e.data) throw err('decrypt_failed', 'This item could not be decrypted with your vault key.');
    return e;
  }

  putCache(vi) {
    if (!this.cache) return;
    this.cache.items[vi.id] = cleanVI(vi);
    this.saveCache();
  }

  /**
   * Create or update an item. Maintains seq/folder_id (§2.5), password history, key_id (§2.2).
   * @returns {Promise<{id: string, revision: number}>}
   */
  async save(acc, { id = null, folderId = undefined, data, baseRevision = null }) {
    const problem = validateItemData(data);
    if (problem) throw err('validation_failed', problem);
    this.requireKey();
    await this.refreshMeta(acc); // never encrypt with a retired key
    const key = this.requireKey();
    const stamp = new Date(this.now()).toISOString();
    const api = this.apiFn();
    let vi;
    try {
      if (!id) {
        const newId = vc.uuid();
        const folder = folderId || null;
        const obj = { ...cloneJson(data), created_at: data.created_at || stamp, updated_at: stamp, seq: 1, folder_id: folder };
        vi = await api.request('POST', '/vault/items', { body: { id: newId, folder_id: folder, data: await vc.encryptItem(key, newId, obj), key_id: this.keyId } });
      } else {
        const existing = await this.get(id);
        const folder = folderId === undefined ? existing.vi.folder_id || null : folderId;
        const obj = applyPasswordHistory(existing.data, data, stamp);
        obj.updated_at = stamp;
        obj.created_at = obj.created_at || existing.data.created_at || existing.vi.created_at || stamp;
        obj.seq = Math.max(Number.isSafeInteger(existing.data.seq) ? existing.data.seq : 0, 0) + 1;
        obj.folder_id = folder;
        vi = await api.request('PUT', `/vault/items/${id}`, {
          body: { folder_id: folder, data: await vc.encryptItem(key, id, obj), base_revision: Number.isSafeInteger(baseRevision) ? baseRevision : existing.vi.revision, key_id: this.keyId },
        });
      }
    } catch (e) {
      if (e instanceof ApiError && e.code === 'vault_key_changed') {
        this.lock();
        this.emit('key-changed');
        throw err('locked', 'Your vault was changed on another device (new key). Unlock it again.');
      }
      if (e instanceof ApiError && e.code === 'conflict' && e.details && validVI(e.details.current)) {
        this.putCache(e.details.current);
        this.items = null;
        throw err('conflict', 'This item was changed on another device. Review the latest version and try again.', { status: 409 });
      }
      throw e;
    }
    let dec = null;
    if (validVI(vi)) {
      this.putCache(vi);
      const marks = this.marksFor(this.keyId);
      dec = await vc.decryptItem(key, vi.id, vi.data);
      marks.items[vi.id] = { seq: dec.seq || 0, updated_at: vi.updated_at, hash: sha(vi.data) };
      this.saveMarks();
    }
    // keep the decrypted list warm (the item we just wrote) instead of re-decrypting the whole vault next time
    if (this.items && dec) this.items.set(vi.id, { vi: cleanVI(vi), data: dec, error: null, stale: null });
    else this.items = null;
    this.emit('items');
    return { id: vi.id, revision: vi.revision };
  }

  async remove(acc, id) {
    this.requireKey();
    try {
      await this.apiFn().request('DELETE', `/vault/items/${id}`, { query: { key_id: this.keyId } });
    } catch (e) {
      if (e instanceof ApiError && e.code === 'vault_key_changed') {
        this.lock();
        this.emit('key-changed');
        throw err('locked', 'Your vault was changed on another device. Unlock it again.');
      }
      if (!(e instanceof ApiError) || e.code !== 'not_found') throw e;
    }
    if (this.cache) {
      delete this.cache.items[id];
      this.saveCache();
    }
    const marks = this.marksFor(this.keyId);
    if (!marks.deleted.includes(id)) marks.deleted.push(id);
    delete marks.items[id];
    this.saveMarks();
    this.items = null;
    this.emit('items');
  }

  /**
   * Import many new items at once (POST /vault/items/batch, ≤ 1000 per request).
   * @param {Array<{data: object, folderId?: string|null}>} entries
   * @param {{onProgress?: (done: number, total: number) => void}} [opts]
   * @returns {Promise<{created: number, errors: Array<{id: string, error: string}>}>}
   */
  async importBatch(acc, entries, { onProgress } = {}) {
    await this.refreshMeta(acc);
    const key = this.requireKey();
    const stamp = new Date(this.now()).toISOString();
    let created = 0;
    const errors = [];
    for (let i = 0; i < entries.length; i += 500) {
      const chunk = entries.slice(i, i + 500);
      const items = [];
      for (const e of chunk) {
        const problem = validateItemData(e.data);
        if (problem) {
          errors.push({ id: '', error: problem });
          continue;
        }
        const id = vc.uuid();
        const folder = e.folderId || null;
        const obj = { ...cloneJson(e.data), created_at: e.data.created_at || stamp, updated_at: e.data.updated_at || stamp, seq: 1, folder_id: folder };
        items.push({ id, folder_id: folder, data: await vc.encryptItem(key, id, obj) });
      }
      if (!items.length) continue;
      const res = await this.apiFn().request('POST', '/vault/items/batch', { body: { items, key_id: this.keyId } });
      created += Number(res && res.created) || 0;
      for (const x of (res && res.errors) || []) errors.push({ id: String(x.id || ''), error: String(x.error || 'error') });
      if (onProgress) onProgress(Math.min(i + chunk.length, entries.length), entries.length);
    }
    await this.sync(acc);
    return { created, errors };
  }

  // ------------------------------------------------------------------------------- folders
  /** @param {{sync?: boolean}} [opts] sync:false skips the sync (imports create many folders, then sync once) */
  async createFolder(acc, name, { sync = true } = {}) {
    await this.refreshMeta(acc);
    const key = this.requireKey();
    const id = vc.uuid();
    await this.apiFn().request('POST', '/vault/folders', { body: { id, name: await vc.encryptFolder(key, id, String(name).slice(0, 500)), key_id: this.keyId } });
    if (sync) await this.sync(acc);
    return id;
  }

  async renameFolder(acc, id, name) {
    const key = this.requireKey();
    const f = this.cache && this.cache.folders[id];
    if (!f) throw err('not_found', 'Folder not found.');
    await this.apiFn().request('PUT', `/vault/folders/${id}`, { body: { name: await vc.encryptFolder(key, id, String(name).slice(0, 500)), base_revision: f.revision, key_id: this.keyId } });
    await this.sync(acc);
  }

  async deleteFolder(acc, id) {
    this.requireKey();
    await this.apiFn().request('DELETE', `/vault/folders/${id}`, { query: { key_id: this.keyId } });
    await this.sync(acc);
  }

  /** Ensure a folder path exists (imports); returns its id. */
  async ensureFolder(acc, name) {
    await this.decryptAll();
    for (const [id, n] of this.folders) if (n === name) return id;
    return this.createFolder(acc, name);
  }
}
