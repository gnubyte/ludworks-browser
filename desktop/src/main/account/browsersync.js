// Bookmarks / history / open tabs / preferences sync (API.md §16, VAULT-CRYPTO.md §9).
//
// Records are sealed with keys derived from the vault key, so the server stores only ciphertext.
// One sync point covers all collections. Pull first (apply newest-wins per record), then push local
// changes with optimistic concurrency (base_revision); conflicts are merged and retried.

import { EventEmitter } from 'node:events';
import { webcrypto } from 'node:crypto';
import os from 'node:os';
import * as vc from '../../lib/vault-crypto.js';
import { ApiError } from '../../lib/api.js';
import { SYNCED_KEYS } from '../profile/prefs.js';
import { log } from '../util/log.js';

const subtle = webcrypto.subtle;
const te = new TextEncoder();
const td = new TextDecoder();
const COLLECTIONS = ['bookmarks', 'history', 'tabs', 'prefs'];
const PUSH_BATCH = 500;
const MAX_ROUNDS = 6;

function b64url(bytes) {
  return Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function hkdf(raw, info) {
  const base = await subtle.importKey('raw', raw, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: te.encode(info) }, base, 256));
}

export class BrowserSync extends EventEmitter {
  /**
   * @param {{browser: import('../browser.js').Browser, api: () => any}} o
   */
  constructor({ browser, api }) {
    super();
    this.b = browser;
    this.db = browser.db;
    this.apiFn = api;
    this.key = null;
    this.idKey = null;
    this.keyId = null;
    this.running = null;
    this.lastResult = null;
    this.deviceId = this.db.getMeta('device_id', null);
    if (!this.deviceId) {
      this.deviceId = webcrypto.randomUUID();
      this.db.setMeta('device_id', this.deviceId);
    }
  }

  /** Derive the record keys from the raw vault key (caller keeps ownership of `raw`). */
  async setKey(raw, keyId) {
    const k = await hkdf(raw, 'ludworks/browser/key/v1');
    const i = await hkdf(raw, 'ludworks/browser/id/v1');
    this.key = await vc.importAesKey(k);
    this.idKey = await subtle.importKey('raw', i, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    k.fill(0);
    i.fill(0);
    if (this.keyId !== keyId) {
      const st = this.state();
      if (st.key_id && st.key_id !== keyId) {
        // a new vault key: everything is uploaded again under it (the server dropped the old records)
        this.db.run("UPDATE history SET sync_id = NULL");
        this.b.bookmarks.markAllDirty();
        this.b.history.markAllDirty();
        this.db.setMeta('prefs_dirty', true);
        this.setState({ since: null, key_id: keyId });
      }
    }
    this.keyId = keyId;
  }

  clearKey() {
    this.key = null;
    this.idKey = null;
    this.keyId = null;
  }

  ready() {
    return !!(this.key && this.idKey && this.keyId);
  }

  state() {
    return this.db.get("SELECT since, key_id FROM sync_state WHERE collection = '*'") || { since: null, key_id: null };
  }

  setState({ since, key_id }) {
    this.db.run("INSERT INTO sync_state (collection, since, key_id) VALUES ('*', ?, ?) ON CONFLICT (collection) DO UPDATE SET since = excluded.since, key_id = excluded.key_id", since, key_id);
  }

  async recordId(collection, natural) {
    const sig = new Uint8Array(await subtle.sign('HMAC', this.idKey, te.encode(`${collection}\n${natural}`)));
    return b64url(sig).slice(0, 32);
  }

  aad(collection, id) {
    return `ludworks/browser/record/v1:${collection}:${id}`;
  }

  async seal(collection, id, obj) {
    return vc.seal(this.key, te.encode(JSON.stringify(obj)), this.aad(collection, id));
  }

  async open(collection, id, data) {
    const obj = JSON.parse(td.decode(await vc.open(this.key, data, this.aad(collection, id))));
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('record is not an object');
    return obj;
  }

  enabled(collection) {
    const s = this.b.prefs.get('sync') || {};
    return s[collection] !== false;
  }

  /** Make sure every history row has its derived record id (needed to match server tombstones). */
  async fillHistoryIds() {
    for (;;) {
      const rows = this.db.all('SELECT url FROM history WHERE sync_id IS NULL LIMIT 500');
      if (!rows.length) return;
      for (const r of rows) this.db.run('UPDATE history SET sync_id = ? WHERE url = ?', await this.recordId('history', r.url), r.url);
    }
  }

  // ------------------------------------------------------------------------------------- run
  async sync() {
    if (!this.ready()) return null;
    if (this.running) return this.running;
    this.running = (async () => {
      const started = Date.now();
      await this.fillHistoryIds();
      const pulled = await this.pull();
      const pushed = await this.push();
      this.lastResult = { at: Date.now(), ms: Date.now() - started, pulled, pushed, error: null };
      this.emit('synced', this.lastResult);
      return this.lastResult;
    })();
    try {
      return await this.running;
    } catch (e) {
      this.lastResult = { at: Date.now(), error: (e && e.message) || String(e) };
      this.emit('synced', this.lastResult);
      throw e;
    } finally {
      this.running = null;
    }
  }

  async pull() {
    const api = this.apiFn();
    const st = this.state();
    let since = st.key_id === this.keyId ? st.since : null;
    let full = !since;
    let seen = full ? { bookmarks: new Set(), history: new Set() } : null;
    let cursor = null;
    let n = 0;
    for (let guard = 0; guard < 10000; guard++) {
      let res;
      try {
        res = await api.request('GET', '/browser/sync', { query: cursor ? { cursor, limit: 1000 } : { since: since || undefined, limit: 1000 } });
      } catch (e) {
        if (e instanceof ApiError && (e.status === 410 || e.code === 'gone') && !cursor) {
          // sync point expired (key change, purged tombstones): full sync
          since = null;
          full = true;
          seen = { bookmarks: new Set(), history: new Set() };
          continue;
        }
        throw e;
      }
      if (!res || !Array.isArray(res.changes)) throw new ApiError({ code: 'bad_response', message: 'Unexpected browser sync response.' });
      if (res.key_id && res.key_id !== this.keyId) {
        const e = new ApiError({ code: 'vault_key_changed', message: 'Your vault key changed on another device.' });
        throw e;
      }
      for (const c of res.changes) {
        if (await this.applyChange(c, seen)) n++;
      }
      if (res.more && res.next_cursor) {
        cursor = res.next_cursor;
        continue;
      }
      since = res.server_time || since;
      break;
    }
    this.setState({ since, key_id: this.keyId });
    if (full && seen) this.reconcileAfterFull(seen);
    return n;
  }

  /** After a full sync, local records the server does not have are uploaded as new. */
  reconcileAfterFull(seen) {
    this.db.tx(() => {
      for (const r of this.db.all('SELECT id FROM bookmarks WHERE deleted = 0')) {
        if (!seen.bookmarks.has(r.id)) this.db.run('UPDATE bookmarks SET dirty = 1, revision = 0 WHERE id = ?', r.id);
      }
      this.db.run('DELETE FROM bookmarks WHERE deleted = 1 AND revision = 0');
      for (const r of this.db.all('SELECT url, sync_id FROM history')) {
        if (!r.sync_id || !seen.history.has(r.sync_id)) this.db.run('UPDATE history SET dirty = 1, revision = 0 WHERE url = ?', r.url);
      }
    });
    this.db.setMeta('prefs_dirty', true);
  }

  async applyChange(c, seen) {
    if (!c || !COLLECTIONS.includes(c.collection) || typeof c.id !== 'string') return false;
    const { collection, id, revision } = c;
    if (c.data === null) {
      if (collection === 'bookmarks') return this.b.bookmarks.applyRemote(id, revision, null);
      if (collection === 'history') {
        const row = this.db.get('SELECT url FROM history WHERE sync_id = ?', id);
        if (row) this.b.history.applyRemoteDelete(row.url);
        return !!row;
      }
      if (collection === 'tabs') {
        this.db.run('DELETE FROM remote_tabs WHERE device_id = ?', id);
        return true;
      }
      return false;
    }
    let rec;
    try {
      rec = await this.open(collection, id, c.data);
    } catch (e) {
      log.warn('browser sync: undecryptable record skipped', { collection });
      return false;
    }
    if (seen && seen[collection]) seen[collection].add(id);
    switch (collection) {
      case 'bookmarks':
        if (!this.enabled('bookmarks')) return false;
        return this.b.bookmarks.applyRemote(id, revision, rec);
      case 'history': {
        if (!this.enabled('history') || typeof rec.url !== 'string') return false;
        if ((await this.recordId('history', rec.url)) !== id) return false; // id must match its URL
        this.b.history.applyRemote(revision, rec);
        this.db.run('UPDATE history SET sync_id = ?, revision = ? WHERE url = ?', id, revision, rec.url);
        return true;
      }
      case 'tabs':
        if (id === this.deviceId) {
          this.db.setMeta('tabs_revision', revision);
          return false;
        }
        this.db.run(
          'INSERT INTO remote_tabs (device_id, data, updated_at) VALUES (?,?,?) ON CONFLICT (device_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at',
          id, JSON.stringify(rec), String(rec.updated_at || ''),
        );
        return true;
      case 'prefs': {
        if (id !== 'prefs' || !this.enabled('prefs')) return false;
        const localAt = this.b.prefs.syncedAt || '';
        if (typeof rec.updated_at === 'string' && rec.updated_at > localAt) {
          const patch = {};
          for (const [k, wire] of Object.entries(SYNCED_KEYS)) if (rec[wire] !== undefined) patch[k] = rec[wire];
          try {
            this.b.prefs.update(patch, { fromSync: true });
          } catch {
            /* invalid remote value: ignore */
          }
          this.b.prefs.syncedAt = rec.updated_at;
          this.db.setMeta('prefs_updated_at', rec.updated_at);
          this.db.setMeta('prefs_dirty', false);
        }
        return true;
      }
      default:
        return false;
    }
  }

  // ------------------------------------------------------------------------------------ push
  async collectChanges() {
    const out = [];
    if (this.enabled('bookmarks')) {
      for (const d of this.b.bookmarks.dirty(PUSH_BATCH)) {
        if (d.deleted && d.revision === 0) {
          this.b.bookmarks.markSynced(d.id, 0, d.updated_at); // never uploaded: nothing to delete
          continue;
        }
        out.push({ collection: 'bookmarks', id: d.id, data: d.deleted ? null : await this.seal('bookmarks', d.id, d.record), base_revision: d.revision, _local: d });
      }
    }
    if (this.enabled('history')) {
      for (const d of this.b.history.dirty(PUSH_BATCH)) {
        const id = await this.recordId('history', d.url);
        out.push({ collection: 'history', id, data: await this.seal('history', id, d.record), base_revision: d.revision, _local: d });
      }
      for (const d of this.b.history.deletedPending(PUSH_BATCH)) {
        const id = await this.recordId('history', d.url);
        out.push({ collection: 'history', id, data: null, base_revision: null, _deleted: d });
      }
    }
    if (this.enabled('tabs') && this.db.getMeta('tabs_dirty', true)) {
      const rec = { device: this.deviceName(), platform: platformName(), tabs: this.b.syncableTabs(), updated_at: new Date().toISOString() };
      out.push({ collection: 'tabs', id: this.deviceId, data: await this.seal('tabs', this.deviceId, rec), base_revision: null, _tabs: true });
    }
    if (this.enabled('prefs') && this.db.getMeta('prefs_dirty', false)) {
      const p = this.b.prefs.all();
      const rec = { updated_at: this.b.prefs.syncedAt || new Date().toISOString() };
      for (const [k, wire] of Object.entries(SYNCED_KEYS)) rec[wire] = p[k];
      out.push({ collection: 'prefs', id: 'prefs', data: await this.seal('prefs', 'prefs', rec), base_revision: null, _prefs: true });
    }
    return out;
  }

  async push() {
    const api = this.apiFn();
    let total = 0;
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const changes = await this.collectChanges();
      if (!changes.length) break;
      for (let i = 0; i < changes.length; i += PUSH_BATCH) {
        const chunk = changes.slice(i, i + PUSH_BATCH);
        let res;
        try {
          res = await api.request('POST', '/browser/records', {
            body: { key_id: this.keyId, changes: chunk.map(({ collection, id, data, base_revision }) => ({ collection, id, data, base_revision })) },
          });
        } catch (e) {
          if (e instanceof ApiError && e.code === 'vault_key_changed') throw e;
          throw e;
        }
        const results = Array.isArray(res && res.results) ? res.results : [];
        for (let j = 0; j < chunk.length; j++) {
          const ch = chunk[j];
          const r = results[j];
          if (!r || r.collection !== ch.collection || r.id !== ch.id) continue;
          if (r.status === 'ok') {
            total++;
            this.ack(ch, r.revision || 0);
          } else if (r.status === 'conflict') {
            await this.resolveConflict(ch, r.current || null);
          } else if (r.status === 'error') {
            log.warn('browser sync: change refused', { collection: ch.collection, code: r.error && r.error.code });
            if (r.error && r.error.code === 'quota_exceeded') return total;
            this.ack(ch, ch.base_revision || 0); // do not retry forever
          }
        }
      }
    }
    return total;
  }

  ack(ch, revision) {
    if (ch.collection === 'bookmarks') this.b.bookmarks.markSynced(ch.id, revision, ch._local.updated_at);
    else if (ch.collection === 'history') {
      if (ch._deleted) this.b.history.markDeleteSynced(ch._deleted.url);
      else {
        this.b.history.markSynced(ch._local.url, revision, ch._local.updated_at);
        this.db.run('UPDATE history SET sync_id = ? WHERE url = ?', ch.id, ch._local.url);
      }
    } else if (ch._tabs) this.db.setMeta('tabs_dirty', false);
    else if (ch._prefs) this.db.setMeta('prefs_dirty', false);
  }

  async resolveConflict(ch, current) {
    if (ch.collection === 'bookmarks') {
      if (!current) {
        // it never existed on the server: create
        this.db.run('UPDATE bookmarks SET revision = 0 WHERE id = ?', ch.id);
        return;
      }
      await this.applyChange(current, null);
      const local = this.db.get('SELECT dirty FROM bookmarks WHERE id = ?', ch.id);
      if (local && local.dirty) this.db.run('UPDATE bookmarks SET revision = ? WHERE id = ?', current.revision, ch.id);
    } else if (ch.collection === 'history') {
      if (current && current.data) await this.applyChange(current, null); // merges visits, keeps dirty if ours has more
      this.db.run('UPDATE history SET revision = ?, dirty = 1 WHERE url = ?', current ? current.revision : 0, ch._local ? ch._local.url : '');
    }
  }

  deviceName() {
    const os = platformName();
    const label = { windows: 'Windows', macos: 'Mac', linux: 'Linux' }[os] || os;
    return `Ludworks Browser on ${label} (${shortHost()})`;
  }

  /** Other devices' open tabs. */
  remoteTabs() {
    return this.db
      .all('SELECT device_id, data, updated_at FROM remote_tabs ORDER BY updated_at DESC')
      .map((r) => {
        try {
          const d = JSON.parse(r.data);
          return { deviceId: r.device_id, device: String(d.device || 'Device'), platform: String(d.platform || ''), updatedAt: r.updated_at, tabs: Array.isArray(d.tabs) ? d.tabs.slice(0, 200) : [] };
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  }

  /** Remove this device's tabs record (sign-out). */
  async dropOwnTabs() {
    if (!this.ready()) return;
    try {
      await this.apiFn().request('POST', '/browser/records', { body: { key_id: this.keyId, changes: [{ collection: 'tabs', id: this.deviceId, data: null, base_revision: null }] } });
    } catch {
      /* best effort */
    }
  }
}

function platformName() {
  return process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux';
}

function shortHost() {
  try {
    return os.hostname().split('.')[0].slice(0, 40) || 'this computer';
  } catch {
    return 'this computer';
  }
}
