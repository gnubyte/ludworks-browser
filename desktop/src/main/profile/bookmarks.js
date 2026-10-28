// Bookmarks: a tree under three implicit roots, stored as flat records exactly like the synced
// `bookmarks` collection (VAULT-CRYPTO.md §9) so sync is a straight mapping.

import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';

export const ROOTS = Object.freeze({ toolbar: 'Bookmarks bar', other: 'Other bookmarks', mobile: 'Mobile bookmarks' });
const MAX_TITLE = 1024;
const MAX_URL = 8192;
const MIN_GAP = 1e-6;

const isRoot = (id) => Object.hasOwn(ROOTS, id);
const nowIso = () => new Date().toISOString();

function rowToNode(r) {
  return { id: r.id, type: r.type, parent: r.parent, index: r.idx, title: r.title, url: r.url || undefined, created_at: r.created_at, updated_at: r.updated_at };
}

export class Bookmarks extends EventEmitter {
  /** @param {import('./db.js').ProfileDb} db */
  constructor(db) {
    super();
    this.db = db;
  }

  changed() {
    this.emit('change');
  }

  get(id) {
    const r = this.db.get('SELECT * FROM bookmarks WHERE id = ? AND deleted = 0', id);
    return r ? rowToNode(r) : null;
  }

  /** Live children of a folder, in order. Orphans (missing parent) are listed under `other`. */
  children(parent) {
    const rows = this.db.all('SELECT * FROM bookmarks WHERE parent = ? AND deleted = 0 ORDER BY idx, id', parent);
    if (parent === 'other') {
      const orphans = this.db.all(
        `SELECT b.* FROM bookmarks b WHERE b.deleted = 0 AND b.parent NOT IN ('toolbar','other','mobile')
         AND NOT EXISTS (SELECT 1 FROM bookmarks p WHERE p.id = b.parent AND p.deleted = 0 AND p.type = 'folder')
         ORDER BY b.idx, b.id`,
      );
      return [...rows, ...orphans].map(rowToNode);
    }
    return rows.map(rowToNode);
  }

  /** Whole tree for the bookmarks page / bar / menus. Breaks parent cycles defensively. */
  tree() {
    const all = this.db.all('SELECT * FROM bookmarks WHERE deleted = 0 ORDER BY idx, id').map(rowToNode);
    const byId = new Map(all.map((n) => [n.id, { ...n, children: n.type === 'folder' ? [] : undefined }]));
    const roots = Object.fromEntries(Object.entries(ROOTS).map(([id, title]) => [id, { id, type: 'folder', title, root: true, children: [] }]));
    // Effective parent: the stored one, unless it is missing / not a folder (→ "other") or the node
    // sits on a parent cycle (→ "other", which breaks the cycle).
    const effectiveParent = (n) => {
      if (isRoot(n.parent)) return n.parent;
      const first = byId.get(n.parent);
      if (!first || first.type !== 'folder') return 'other';
      const seen = new Set([n.id]);
      for (let cur = first; cur && !isRoot(cur.parent); ) {
        if (seen.has(cur.id)) return 'other';
        seen.add(cur.id);
        const next = byId.get(cur.parent);
        if (!next || next.type !== 'folder') break;
        if (seen.has(next.id)) return 'other';
        cur = next;
      }
      return n.parent;
    };
    for (const n of byId.values()) {
      const p = effectiveParent(n);
      (isRoot(p) ? roots[p] : byId.get(p)).children.push(n);
    }
    return roots;
  }

  isBookmarked(url) {
    return !!this.db.get('SELECT 1 FROM bookmarks WHERE url = ? AND deleted = 0 AND type = ? LIMIT 1', url, 'url');
  }

  findByUrl(url) {
    return this.db.all('SELECT * FROM bookmarks WHERE url = ? AND deleted = 0 AND type = ?', url, 'url').map(rowToNode);
  }

  search(text, limit = 50) {
    const q = `%${String(text).replace(/[\\%_]/g, (c) => '\\' + c)}%`;
    return this.db
      .all("SELECT * FROM bookmarks WHERE deleted = 0 AND type = 'url' AND (title LIKE ? ESCAPE '\\' OR url LIKE ? ESCAPE '\\') ORDER BY updated_at DESC LIMIT ?", q, q, limit)
      .map(rowToNode);
  }

  folderExists(id) {
    return isRoot(id) || !!this.db.get("SELECT 1 FROM bookmarks WHERE id = ? AND deleted = 0 AND type = 'folder'", id);
  }

  /** idx for inserting at `position` (0-based, among live siblings excluding `exceptId`). */
  slotIndex(parent, position, exceptId = null) {
    const sibs = this.db.all('SELECT id, idx FROM bookmarks WHERE parent = ? AND deleted = 0 ORDER BY idx, id', parent).filter((s) => s.id !== exceptId);
    const pos = Number.isInteger(position) && position >= 0 && position <= sibs.length ? position : sibs.length;
    const before = pos > 0 ? sibs[pos - 1].idx : null;
    const after = pos < sibs.length ? sibs[pos].idx : null;
    if (before === null && after === null) return 1;
    if (before === null) return after - 1;
    if (after === null) return before + 1;
    if (after - before > MIN_GAP) return (before + after) / 2;
    // Renumber the folder (1, 2, 3, …) and retry; every renumbered node syncs.
    const stamp = nowIso();
    this.db.tx(() => {
      sibs.forEach((s, i) => this.db.run('UPDATE bookmarks SET idx = ?, updated_at = ?, dirty = 1 WHERE id = ?', i + 1, stamp, s.id));
    });
    return pos + 0.5;
  }

  /**
   * @param {{parent?: string, type?: 'url'|'folder', title?: string, url?: string, position?: number}} p
   * @returns {string} new id
   */
  add({ parent = 'toolbar', type = 'url', title = '', url = '', position } = {}) {
    if (!this.folderExists(parent)) throw new Error('parent folder does not exist');
    if (type !== 'url' && type !== 'folder') throw new Error('bad bookmark type');
    if (type === 'url' && (!url || url.length > MAX_URL)) throw new Error('bad bookmark url');
    const id = randomUUID();
    const stamp = nowIso();
    const idx = this.slotIndex(parent, position);
    this.db.run(
      'INSERT INTO bookmarks (id, type, parent, idx, title, url, created_at, updated_at, deleted, dirty, revision) VALUES (?,?,?,?,?,?,?,?,0,1,0)',
      id, type, parent, idx, String(title).slice(0, MAX_TITLE), type === 'url' ? url : null, stamp, stamp,
    );
    this.changed();
    return id;
  }

  update(id, { title, url } = {}) {
    const n = this.get(id);
    if (!n) throw new Error('bookmark not found');
    const nextTitle = title === undefined ? n.title : String(title).slice(0, MAX_TITLE);
    const nextUrl = n.type === 'url' && url !== undefined ? String(url).slice(0, MAX_URL) : n.url || null;
    this.db.run('UPDATE bookmarks SET title = ?, url = ?, updated_at = ?, dirty = 1 WHERE id = ?', nextTitle, nextUrl, nowIso(), id);
    this.changed();
  }

  move(id, { parent, position }) {
    const n = this.get(id);
    if (!n) throw new Error('bookmark not found');
    if (!this.folderExists(parent)) throw new Error('parent folder does not exist');
    // A folder cannot move into itself or its descendants.
    for (let p = parent; !isRoot(p); ) {
      if (p === id) throw new Error('cannot move a folder into itself');
      const pn = this.db.get('SELECT parent FROM bookmarks WHERE id = ?', p);
      if (!pn) break;
      p = pn.parent;
    }
    const idx = this.slotIndex(parent, position, id);
    this.db.run('UPDATE bookmarks SET parent = ?, idx = ?, updated_at = ?, dirty = 1 WHERE id = ?', parent, idx, nowIso(), id);
    this.changed();
  }

  /** Delete a node and (for folders) all descendants; tombstones sync the deletion. */
  remove(id) {
    if (isRoot(id)) throw new Error('cannot delete a root folder');
    const stamp = nowIso();
    this.db.tx(() => {
      const stack = [id];
      while (stack.length) {
        const cur = stack.pop();
        for (const c of this.db.all('SELECT id FROM bookmarks WHERE parent = ? AND deleted = 0', cur)) stack.push(c.id);
        this.db.run('UPDATE bookmarks SET deleted = 1, dirty = 1, updated_at = ? WHERE id = ? AND deleted = 0', stamp, cur);
      }
    });
    this.changed();
  }

  /**
   * Bulk import (Chrome/Edge JSON, HTML, Bitwarden-less sources). Nodes: {type, title, url?, children?}.
   * Creates a folder named `folderTitle` under `parent` unless folderTitle is empty.
   * @returns {number} bookmarks created
   */
  importNodes(nodes, { parent = 'other', folderTitle = '' } = {}) {
    let count = 0;
    this.db.tx(() => {
      let target = parent;
      if (folderTitle) target = this.add({ parent, type: 'folder', title: folderTitle });
      const walk = (list, into, depth) => {
        if (depth > 32) return;
        for (const n of list) {
          if (count > 100000) return;
          if (n.type === 'folder') {
            const fid = this.add({ parent: into, type: 'folder', title: n.title || 'Folder' });
            walk(n.children || [], fid, depth + 1);
          } else if (n.url && typeof n.url === 'string' && n.url.length <= MAX_URL) {
            this.add({ parent: into, type: 'url', title: n.title || n.url, url: n.url });
            count++;
          }
        }
      };
      walk(nodes, target, 0);
    });
    this.changed();
    return count;
  }

  // ------------------------------------------------------------------------------ sync support

  /** Local changes not yet uploaded (including tombstones). */
  dirty(limit = 1000) {
    return this.db.all('SELECT * FROM bookmarks WHERE dirty = 1 LIMIT ?', limit).map((r) => ({
      id: r.id,
      deleted: !!r.deleted,
      revision: r.revision,
      updated_at: r.updated_at,
      record: r.deleted ? null : { ...(r.extra ? safeParse(r.extra) : {}), type: r.type, parent: r.parent, index: r.idx, title: r.title, ...(r.type === 'url' ? { url: r.url } : {}), created_at: r.created_at, updated_at: r.updated_at },
    }));
  }

  markSynced(id, revision, updatedAt) {
    // Only clear the flag if nothing changed locally since the upload started.
    this.db.run('UPDATE bookmarks SET dirty = 0, revision = ? WHERE id = ? AND updated_at = ?', revision, id, updatedAt);
    this.db.run('DELETE FROM bookmarks WHERE id = ? AND deleted = 1 AND dirty = 0', id);
  }

  /** Server copy of a record (decrypted). Newest updated_at wins; local unsynced edits win ties. */
  applyRemote(id, revision, rec) {
    const local = this.db.get('SELECT * FROM bookmarks WHERE id = ?', id);
    if (rec === null) {
      if (!local) return false;
      if (local.dirty && !local.deleted) {
        // Edited here after the other device deleted it: keep ours (it will be re-created).
        this.db.run('UPDATE bookmarks SET revision = 0 WHERE id = ?', id);
        return false;
      }
      this.db.run('DELETE FROM bookmarks WHERE id = ?', id);
      this.changed();
      return true;
    }
    if (!rec || (rec.type !== 'url' && rec.type !== 'folder') || typeof rec.parent !== 'string') return false;
    const updated = typeof rec.updated_at === 'string' ? rec.updated_at : '';
    if (local && local.updated_at > updated) {
      // Older than what we have (rollback, or our newer edit): keep ours, remember the revision.
      this.db.run('UPDATE bookmarks SET revision = ?, dirty = 1 WHERE id = ?', revision, id);
      return false;
    }
    const { type, parent, index, title, url, created_at, updated_at, ...extra } = rec;
    this.db.run(
      `INSERT INTO bookmarks (id, type, parent, idx, title, url, created_at, updated_at, deleted, dirty, revision, extra)
       VALUES (?,?,?,?,?,?,?,?,0,0,?,?)
       ON CONFLICT (id) DO UPDATE SET type = excluded.type, parent = excluded.parent, idx = excluded.idx, title = excluded.title,
         url = excluded.url, created_at = excluded.created_at, updated_at = excluded.updated_at, deleted = 0, dirty = 0,
         revision = excluded.revision, extra = excluded.extra`,
      id, type, String(parent).slice(0, 64), Number.isFinite(index) ? index : 0, String(title || '').slice(0, MAX_TITLE),
      type === 'url' ? String(url || '').slice(0, MAX_URL) : null, String(created_at || updated || nowIso()), updated || nowIso(),
      revision, Object.keys(extra).length ? JSON.stringify(extra) : null,
    );
    this.changed();
    return true;
  }

  /** After a vault key change every record must be uploaded again. */
  markAllDirty() {
    this.db.run('UPDATE bookmarks SET dirty = 1, revision = 0');
    this.db.run('DELETE FROM bookmarks WHERE deleted = 1');
  }
}

function safeParse(s) {
  try {
    const v = JSON.parse(s);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}
