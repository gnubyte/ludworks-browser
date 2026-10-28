// The profile database (Node's built-in SQLite): bookmarks, history, site permissions, downloads,
// sync bookkeeping and small key/value state. Nothing secret is stored here — passwords and
// passkeys stay in the end-to-end encrypted vault cache (account/store.js).

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const MIGRATIONS = [
  // 1: initial schema
  `
  CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT NOT NULL) STRICT;

  -- Bookmarks mirror the sync schema (VAULT-CRYPTO.md §9): ids are UUIDs, the roots 'toolbar',
  -- 'other' and 'mobile' are implicit. Deleted rows stay as tombstones until the deletion is synced.
  CREATE TABLE bookmarks (
    id         TEXT PRIMARY KEY,
    type       TEXT NOT NULL CHECK (type IN ('url', 'folder')),
    parent     TEXT NOT NULL,
    idx        REAL NOT NULL,
    title      TEXT NOT NULL DEFAULT '',
    url        TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted    INTEGER NOT NULL DEFAULT 0,
    dirty      INTEGER NOT NULL DEFAULT 1,
    revision   INTEGER NOT NULL DEFAULT 0,
    extra      TEXT
  ) STRICT;
  CREATE INDEX bookmarks_parent ON bookmarks (parent, idx) WHERE deleted = 0;
  CREATE INDEX bookmarks_url ON bookmarks (url) WHERE deleted = 0;
  CREATE INDEX bookmarks_dirty ON bookmarks (dirty) WHERE dirty = 1;

  -- History: one row per URL. visits = newest-first epoch-ms list (≤ 30, the synced part).
  CREATE TABLE history (
    url         TEXT PRIMARY KEY,
    title       TEXT NOT NULL DEFAULT '',
    visits      TEXT NOT NULL DEFAULT '[]',
    last_visit  INTEGER NOT NULL,
    visit_count INTEGER NOT NULL DEFAULT 0,
    typed_count INTEGER NOT NULL DEFAULT 0,
    updated_at  TEXT NOT NULL,
    dirty       INTEGER NOT NULL DEFAULT 1,
    revision    INTEGER NOT NULL DEFAULT 0,
    sync_id     TEXT -- derived record id (VAULT-CRYPTO §9); depends on the vault key, reset when it changes
  ) STRICT;
  CREATE INDEX history_last ON history (last_visit DESC);
  CREATE INDEX history_sync_id ON history (sync_id) WHERE sync_id IS NOT NULL;
  CREATE INDEX history_dirty ON history (dirty) WHERE dirty = 1;
  -- Deletions waiting to be synced (record ids are derived from the URL and the vault key).
  CREATE TABLE history_deleted (url TEXT PRIMARY KEY, deleted_at TEXT NOT NULL) STRICT;

  CREATE TABLE permissions (
    origin     TEXT NOT NULL,
    permission TEXT NOT NULL,
    decision   TEXT NOT NULL CHECK (decision IN ('allow', 'deny')),
    updated_at TEXT NOT NULL,
    PRIMARY KEY (origin, permission)
  ) STRICT;

  CREATE TABLE downloads (
    id         TEXT PRIMARY KEY,
    url        TEXT NOT NULL,
    path       TEXT NOT NULL,
    filename   TEXT NOT NULL,
    mime       TEXT NOT NULL DEFAULT '',
    total      INTEGER NOT NULL DEFAULT 0,
    received   INTEGER NOT NULL DEFAULT 0,
    state      TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    ended_at   INTEGER
  ) STRICT;
  CREATE INDEX downloads_started ON downloads (started_at DESC);

  -- Per-collection sync point (API.md §16) and the vault key it belongs to.
  CREATE TABLE sync_state (collection TEXT PRIMARY KEY, since TEXT, key_id TEXT) STRICT;
  -- Open tabs of the user's other devices (decrypted tabs records).
  CREATE TABLE remote_tabs (device_id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT NOT NULL) STRICT;
  `,
];

export class ProfileDb {
  /** @param {string} dir profile directory */
  constructor(dir) {
    mkdirSync(dir, { recursive: true });
    this.db = new DatabaseSync(path.join(dir, 'Profile.sqlite'));
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.migrate();
    this.stmts = new Map();
  }

  migrate() {
    const v = this.db.prepare('PRAGMA user_version').get().user_version;
    for (let i = v; i < MIGRATIONS.length; i++) {
      this.tx(() => {
        this.db.exec(MIGRATIONS[i]);
        this.db.exec(`PRAGMA user_version = ${i + 1}`);
      });
    }
  }

  /** Cached prepared statement. */
  st(sql) {
    let s = this.stmts.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.stmts.set(sql, s);
    }
    return s;
  }

  get(sql, ...p) {
    return this.st(sql).get(...p);
  }
  all(sql, ...p) {
    return this.st(sql).all(...p);
  }
  run(sql, ...p) {
    return this.st(sql).run(...p);
  }

  /** Run fn in one transaction (nested calls join the outer one). */
  tx(fn) {
    if (this.inTx) return fn();
    this.inTx = true;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const r = fn();
      this.db.exec('COMMIT');
      return r;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    } finally {
      this.inTx = false;
    }
  }

  getMeta(k, dflt = null) {
    const row = this.get('SELECT v FROM meta WHERE k = ?', k);
    if (!row) return dflt;
    try {
      return JSON.parse(row.v);
    } catch {
      return dflt;
    }
  }

  setMeta(k, value) {
    if (value === undefined || value === null) this.run('DELETE FROM meta WHERE k = ?', k);
    else this.run('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v', k, JSON.stringify(value));
  }

  close() {
    try {
      this.db.close();
    } catch {
      /* already closed */
    }
  }
}
