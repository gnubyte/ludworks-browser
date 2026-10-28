// Browsing history: one row per URL with its recent visits (the synced part, VAULT-CRYPTO.md §9),
// plus local counters for address-bar ranking. Private windows never record anything.

import { EventEmitter } from 'node:events';

export const MAX_VISITS = 30;
export const RETENTION_DAYS = 90;
const MAX_URL = 8192;
const MAX_TITLE = 1024;

const nowIso = () => new Date().toISOString();

/** URLs worth remembering: web pages and local files, never internal/data/blob/error pages. */
export function recordable(url) {
  if (typeof url !== 'string' || url.length > MAX_URL) return false;
  return /^(https?|file|ftp):/i.test(url);
}

function parseVisits(s) {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.filter((x) => Number.isSafeInteger(x)) : [];
  } catch {
    return [];
  }
}

export function mergeVisits(a, b) {
  return [...new Set([...a, ...b])].sort((x, y) => y - x).slice(0, MAX_VISITS);
}

function likeEscape(s) {
  return String(s).replace(/[\\%_]/g, (c) => '\\' + c);
}

export class History extends EventEmitter {
  /** @param {import('./db.js').ProfileDb} db */
  constructor(db) {
    super();
    this.db = db;
    this.changedTimer = null;
  }

  changed() {
    if (this.changedTimer) return;
    this.changedTimer = setTimeout(() => {
      this.changedTimer = null;
      this.emit('change');
    }, 250);
  }

  /**
   * Record a main-frame navigation.
   * @param {{url: string, title?: string, typed?: boolean, at?: number}} v
   */
  addVisit({ url, title = '', typed = false, at = Date.now() }) {
    if (!recordable(url)) return;
    const row = this.db.get('SELECT visits, title FROM history WHERE url = ?', url);
    const visits = mergeVisits(row ? parseVisits(row.visits) : [], [at]);
    this.db.run(
      `INSERT INTO history (url, title, visits, last_visit, visit_count, typed_count, updated_at, dirty, revision)
       VALUES (?, ?, ?, ?, 1, ?, ?, 1, 0)
       ON CONFLICT (url) DO UPDATE SET title = CASE WHEN excluded.title <> '' THEN excluded.title ELSE history.title END,
         visits = excluded.visits, last_visit = excluded.last_visit, visit_count = history.visit_count + 1,
         typed_count = history.typed_count + excluded.typed_count, updated_at = excluded.updated_at, dirty = 1`,
      url, String(title || '').slice(0, MAX_TITLE), JSON.stringify(visits), at, typed ? 1 : 0, nowIso(),
    );
    this.db.run('DELETE FROM history_deleted WHERE url = ?', url);
    this.changed();
  }

  setTitle(url, title) {
    if (!recordable(url) || !title) return;
    const r = this.db.run('UPDATE history SET title = ?, updated_at = ?, dirty = 1 WHERE url = ? AND title <> ?', String(title).slice(0, MAX_TITLE), nowIso(), url, String(title).slice(0, MAX_TITLE));
    if (r.changes) this.changed();
  }

  /**
   * Address-bar candidates: URL/title substring matches ranked by frecency (typed and recent count more).
   * @returns {Array<{url: string, title: string, score: number}>}
   */
  suggest(text, limit = 8) {
    const t = String(text || '').trim().toLowerCase();
    if (!t) return [];
    const q = `%${likeEscape(t)}%`;
    const rows = this.db.all(
      `SELECT url, title, last_visit, visit_count, typed_count FROM history
       WHERE url LIKE ? ESCAPE '\\' OR title LIKE ? ESCAPE '\\'
       ORDER BY last_visit DESC LIMIT 400`,
      q, q,
    );
    const now = Date.now();
    const scored = rows.map((r) => {
      const ageDays = Math.max(0, (now - r.last_visit) / 86400000);
      const recency = ageDays < 1 ? 100 : ageDays < 4 ? 70 : ageDays < 14 ? 50 : ageDays < 31 ? 30 : 10;
      const host = (() => {
        try {
          return new URL(r.url).host.replace(/^www\./, '');
        } catch {
          return '';
        }
      })();
      const bare = r.url.replace(/^[a-z]+:\/\/(www\.)?/i, '').toLowerCase();
      let score = recency * Math.log2(2 + r.visit_count) + r.typed_count * 40;
      if (host.startsWith(t) || bare.startsWith(t)) score *= 3;
      if (bare === t || bare === t + '/') score *= 2;
      return { url: r.url, title: r.title, score };
    });
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  }

  /** History page: newest first, optional text filter, paging by last_visit. */
  list({ text = '', before = null, limit = 100 } = {}) {
    const lim = Math.min(Math.max(1, limit | 0), 500);
    const params = [];
    let where = '1=1';
    if (text) {
      where += " AND (url LIKE ? ESCAPE '\\' OR title LIKE ? ESCAPE '\\')";
      const q = `%${likeEscape(text)}%`;
      params.push(q, q);
    }
    if (Number.isSafeInteger(before)) {
      where += ' AND last_visit < ?';
      params.push(before);
    }
    return this.db.all(`SELECT url, title, last_visit, visit_count FROM history WHERE ${where} ORDER BY last_visit DESC LIMIT ?`, ...params, lim);
  }

  topSites(limit = 8) {
    const since = Date.now() - 30 * 86400000;
    return this.db.all('SELECT url, title, visit_count FROM history WHERE last_visit > ? ORDER BY visit_count + typed_count * 3 DESC LIMIT ?', since, limit * 3)
      .filter((r) => /^https?:/i.test(r.url))
      .slice(0, limit);
  }

  remove(urls) {
    const stamp = nowIso();
    this.db.tx(() => {
      for (const url of urls) {
        const r = this.db.run('DELETE FROM history WHERE url = ?', url);
        if (r.changes) this.db.run('INSERT INTO history_deleted (url, deleted_at) VALUES (?, ?) ON CONFLICT (url) DO UPDATE SET deleted_at = excluded.deleted_at', url, stamp);
      }
    });
    this.changed();
  }

  /** Delete visits in [fromMs, toMs]; rows with no visit left are removed (and the removal synced). */
  removeRange(fromMs, toMs) {
    const rows = this.db.all('SELECT url, visits FROM history WHERE last_visit >= ?', fromMs);
    const stamp = nowIso();
    const gone = [];
    this.db.tx(() => {
      for (const r of rows) {
        const keep = parseVisits(r.visits).filter((t) => t < fromMs || t > toMs);
        if (keep.length) this.db.run('UPDATE history SET visits = ?, last_visit = ?, updated_at = ?, dirty = 1 WHERE url = ?', JSON.stringify(keep), keep[0], stamp, r.url);
        else gone.push(r.url);
      }
    });
    if (gone.length) this.remove(gone);
    this.changed();
  }

  clearAll() {
    const urls = this.db.all('SELECT url FROM history').map((r) => r.url);
    this.remove(urls);
  }

  /** Drop entries older than the retention window (deletions sync like any other). */
  prune() {
    const cutoff = Date.now() - RETENTION_DAYS * 86400000;
    const old = this.db.all('SELECT url FROM history WHERE last_visit < ? LIMIT 5000', cutoff).map((r) => r.url);
    if (old.length) this.remove(old);
    this.db.run('DELETE FROM history_deleted WHERE deleted_at < ?', new Date(cutoff).toISOString());
  }

  // ------------------------------------------------------------------------------ sync support

  dirty(limit = 1000) {
    return this.db.all('SELECT url, title, visits, updated_at, revision FROM history WHERE dirty = 1 LIMIT ?', limit).map((r) => ({
      url: r.url,
      revision: r.revision,
      updated_at: r.updated_at,
      record: { url: r.url, title: r.title, visits: parseVisits(r.visits), updated_at: r.updated_at },
    }));
  }

  deletedPending(limit = 1000) {
    return this.db.all('SELECT url, deleted_at FROM history_deleted LIMIT ?', limit);
  }

  markSynced(url, revision, updatedAt) {
    this.db.run('UPDATE history SET dirty = 0, revision = ? WHERE url = ? AND updated_at = ?', revision, url, updatedAt);
  }

  markDeleteSynced(url) {
    this.db.run('DELETE FROM history_deleted WHERE url = ?', url);
  }

  /** Merge a server record: union of visits, newest title. */
  applyRemote(revision, rec) {
    if (!rec || typeof rec.url !== 'string' || !recordable(rec.url)) return;
    const local = this.db.get('SELECT * FROM history WHERE url = ?', rec.url);
    const remoteVisits = Array.isArray(rec.visits) ? rec.visits.filter((x) => Number.isSafeInteger(x)) : [];
    if (!remoteVisits.length) return;
    if (this.db.get('SELECT 1 FROM history_deleted WHERE url = ? AND deleted_at > ?', rec.url, String(rec.updated_at || ''))) return;
    if (!local) {
      const visits = mergeVisits([], remoteVisits);
      this.db.run(
        'INSERT INTO history (url, title, visits, last_visit, visit_count, typed_count, updated_at, dirty, revision) VALUES (?,?,?,?,?,0,?,0,?)',
        rec.url, String(rec.title || '').slice(0, MAX_TITLE), JSON.stringify(visits), visits[0], visits.length, String(rec.updated_at || nowIso()), revision,
      );
    } else {
      const lv = parseVisits(local.visits);
      const merged = mergeVisits(lv, remoteVisits);
      const title = (rec.updated_at || '') > local.updated_at && rec.title ? String(rec.title).slice(0, MAX_TITLE) : local.title;
      const needsUpload = merged.length !== remoteVisits.length || merged.some((v, i) => v !== [...remoteVisits].sort((a, b) => b - a)[i]);
      this.db.run(
        'UPDATE history SET title = ?, visits = ?, last_visit = ?, visit_count = max(visit_count, ?), revision = ?, dirty = ? WHERE url = ?',
        title, JSON.stringify(merged), merged[0], merged.length, revision, needsUpload || local.dirty ? 1 : 0, rec.url,
      );
    }
    this.changed();
  }

  applyRemoteDelete(url) {
    const r = this.db.run('DELETE FROM history WHERE url = ? AND dirty = 0', url);
    if (r.changes) this.changed();
  }

  markAllDirty() {
    this.db.run('UPDATE history SET dirty = 1, revision = 0');
  }
}
