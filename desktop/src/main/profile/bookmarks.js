// Bookmarks: a tree under three implicit roots, stored as flat records exactly like the synced
// `bookmarks` collection (VAULT-CRYPTO.md §9) so sync is a straight mapping.
//
// Every local change goes through this class: rows are marked dirty (uploaded by browsersync.js),
// deletions leave tombstones until synced, folders never move into themselves, and sibling order is
// the REAL `idx` column (fractional inserts, renumbering a folder only when the gaps run out).

import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { fixupInput } from '../util/urls.js';

export const ROOTS = Object.freeze({ toolbar: 'Bookmarks bar', other: 'Other bookmarks', mobile: 'Mobile bookmarks' });
const MAX_TITLE = 1024;
const MAX_URL = 8192;
const MIN_GAP = 1e-6;
const MAX_UNDO = 30;
const MAX_DEPTH = 64;
const MAX_IMPORT = 100000;
const MAX_ICONS = 300;
const MAX_ICON_LEN = 8 * 1024; // data: URL length (a 32×32 PNG is ~1–3 KB)

const isRoot = (id) => Object.hasOwn(ROOTS, id);
const nowIso = () => new Date().toISOString();
const range = (n, f) => Array.from({ length: n }, (_, i) => f(i));

function rowToNode(r) {
  return { id: r.id, type: r.type, parent: r.parent, index: r.idx, title: r.title, url: r.url || undefined, created_at: r.created_at, updated_at: r.updated_at };
}

/**
 * What the user typed or dropped as a bookmark address → the URL to store. Bookmarklets
 * (javascript:) are kept as they are; anything else must be a URL the address bar would open.
 */
export function bookmarkUrl(text) {
  const t = String(text ?? '').trim();
  if (/^javascript:/i.test(t) && t.length <= MAX_URL) return t;
  if (/^(https?|ftp|file):\/\//i.test(t)) {
    try {
      const u = new URL(t).href;
      if (u.length <= MAX_URL) return u;
    } catch {
      /* fall through */
    }
  }
  const f = t && t.length <= MAX_URL ? fixupInput(t) : null;
  if (f && f.type === 'url') return f.url;
  throw new Error('Enter a valid address, like https://example.com');
}

/** Host key for the favicon cache ("www." dropped). */
export function iconHost(url) {
  try {
    const u = new URL(String(url));
    return /^(https?|ftp):$/.test(u.protocol) ? u.hostname.replace(/^www\./, '').toLowerCase() : null;
  } catch {
    return null;
  }
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

export class Bookmarks extends EventEmitter {
  /** @param {import('./db.js').ProfileDb} db */
  constructor(db) {
    super();
    this.db = db;
    this.version = 0;
    this.iconVersion = 0;
    this.batchDepth = 0;
    this.pendingChange = false;
    /** @type {Array<{label: string, kind: 'order'|'restore'|'unadd'|'update', [k: string]: any}>} */
    this.undoStack = [];
    this.icons = null; // host → data: URL, loaded lazily (local cache, never synced)
    this.iconTimer = null;
  }

  changed() {
    if (this.batchDepth > 0) this.pendingChange = true;
    else this.emitChange();
  }

  emitChange() {
    this.version++; // lets views skip re-reading a tree they already have
    this.emit('change');
  }

  /** Runs fn in one transaction and emits a single 'change' afterwards. */
  batch(fn) {
    this.batchDepth++;
    try {
      return this.db.tx(fn);
    } finally {
      if (--this.batchDepth === 0 && this.pendingChange) {
        this.pendingChange = false;
        this.emitChange();
      }
    }
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

  /**
   * Compact snapshot for the bookmark manager: every live node in tree order (parents before
   * children) as [id, parent, type, title, url, addedMs].
   */
  flat() {
    const t = this.tree();
    const rows = [];
    const walk = (node, depth) => {
      for (const c of node.children || []) {
        rows.push([c.id, node.id, c.type, c.title, c.url || '', Date.parse(c.created_at) || 0]);
        if (c.type === 'folder' && depth < MAX_DEPTH) walk(c, depth + 1);
      }
    };
    for (const id of Object.keys(ROOTS)) walk(t[id], 0);
    return { roots: Object.entries(ROOTS).map(([id, title]) => ({ id, title })), rows };
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

  /** Folders above a node, nearest first (stops at a root, a missing parent or a cycle). */
  ancestors(id) {
    const out = [];
    const seen = new Set([id]);
    let r = this.db.get('SELECT parent FROM bookmarks WHERE id = ?', id);
    while (r && !isRoot(r.parent) && !seen.has(r.parent)) {
      out.push(r.parent);
      seen.add(r.parent);
      r = this.db.get('SELECT parent FROM bookmarks WHERE id = ? AND deleted = 0', r.parent);
    }
    return out;
  }

  /** True when moving `id` into `parent` would put a folder inside itself. */
  wouldCycle(id, parent) {
    return parent === id || this.ancestors(parent).includes(id);
  }

  /** Live, non-root, de-duplicated ids (order kept), minus nodes whose ancestor is also listed. */
  normalizeSelection(ids) {
    const list = [];
    const set = new Set();
    for (const raw of Array.isArray(ids) ? ids.slice(0, MAX_IMPORT) : []) {
      const id = String(raw);
      if (isRoot(id) || set.has(id) || !this.get(id)) continue;
      set.add(id);
      list.push(id);
    }
    if (list.length < 2) return list;
    return list.filter((id) => !this.ancestors(id).some((a) => set.has(a)));
  }

  kids(parent) {
    return this.db.all('SELECT id, idx, parent FROM bookmarks WHERE parent = ? AND deleted = 0 ORDER BY idx, id', parent);
  }

  /**
   * The sibling to insert before: `before` (a child id; if it is one of the moved nodes, the next
   * child that is not), else the child at `position` (counted over all current children), else
   * null = append.
   */
  anchorFor(parent, before, position, skip) {
    const all = this.kids(parent);
    let i = -1;
    if (typeof before === 'string' && before) i = all.findIndex((s) => s.id === before);
    else if (Number.isInteger(position) && position >= 0) i = Math.min(position, all.length);
    if (i < 0) return null;
    for (; i < all.length; i++) if (!skip.has(all[i].id)) return all[i].id;
    return null;
  }

  /**
   * idx values for `count` nodes inserted before `beforeId` (null = end) among the live children of
   * `parent` that are not in `skip`. Renumbers the folder (1, 2, 3, …) when the gap is too small;
   * every renumbered node syncs.
   */
  slots(parent, beforeId, count, skip = new Set()) {
    const sibs = this.kids(parent).filter((s) => !skip.has(s.id));
    let pos = beforeId == null ? sibs.length : sibs.findIndex((s) => s.id === beforeId);
    if (pos < 0) pos = sibs.length;
    const prev = pos > 0 ? sibs[pos - 1].idx : null;
    const next = pos < sibs.length ? sibs[pos].idx : null;
    if (prev === null && next === null) return range(count, (i) => i + 1);
    if (prev === null) return range(count, (i) => next - count + i);
    if (next === null) return range(count, (i) => prev + 1 + i);
    const step = (next - prev) / (count + 1);
    if (step > MIN_GAP) return range(count, (i) => prev + step * (i + 1));
    const stamp = nowIso();
    this.db.tx(() => {
      sibs.forEach((s, i) => {
        const v = i < pos ? i + 1 : i + 1 + count;
        if (s.idx !== v) this.db.run('UPDATE bookmarks SET idx = ?, updated_at = ?, dirty = 1 WHERE id = ?', v, stamp, s.id);
      });
    });
    return range(count, (i) => pos + 1 + i);
  }

  /** idx for inserting at `position` (0-based, among live siblings excluding `exceptId`). */
  slotIndex(parent, position, exceptId = null) {
    const skip = new Set(exceptId ? [exceptId] : []);
    const sibs = this.kids(parent).filter((s) => !skip.has(s.id));
    const before = Number.isInteger(position) && position >= 0 && position < sibs.length ? sibs[position].id : null;
    return this.slots(parent, before, 1, skip)[0];
  }

  insertRow(type, parent, idx, title, url, stamp = nowIso(), id = randomUUID()) {
    this.db.run(
      'INSERT INTO bookmarks (id, type, parent, idx, title, url, created_at, updated_at, deleted, dirty, revision) VALUES (?,?,?,?,?,?,?,?,0,1,0)',
      id, type, parent, idx, String(title ?? '').slice(0, MAX_TITLE), type === 'url' ? url : null, stamp, stamp,
    );
    return id;
  }

  /**
   * @param {{parent?: string, type?: 'url'|'folder', title?: string, url?: string, position?: number, before?: string}} p
   * @returns {string} new id
   */
  add({ parent = 'toolbar', type = 'url', title = '', url = '', position, before } = {}) {
    if (!this.folderExists(parent)) throw new Error('parent folder does not exist');
    if (type !== 'url' && type !== 'folder') throw new Error('bad bookmark type');
    if (type === 'url' && (!url || typeof url !== 'string' || url.length > MAX_URL)) throw new Error('bad bookmark url');
    const id = this.batch(() => {
      const anchor = this.anchorFor(parent, before, position, new Set());
      return this.insertRow(type, parent, this.slots(parent, anchor, 1)[0], title, url);
    });
    this.changed();
    return id;
  }

  update(id, { title, url } = {}, { undo = true } = {}) {
    const n = this.get(id);
    if (!n) throw new Error('bookmark not found');
    const nextTitle = title === undefined || title === null ? n.title : String(title).slice(0, MAX_TITLE);
    let nextUrl = n.url || null;
    if (n.type === 'url' && url !== undefined && url !== null) {
      const u = String(url).trim().slice(0, MAX_URL);
      if (!u) throw new Error('bad bookmark url');
      nextUrl = u;
    }
    if (nextTitle === n.title && nextUrl === (n.url || null)) return;
    this.db.run('UPDATE bookmarks SET title = ?, url = ?, updated_at = ?, dirty = 1 WHERE id = ?', nextTitle, nextUrl, nowIso(), id);
    if (undo) this.pushUndo({ label: n.type === 'folder' ? 'Rename' : 'Edit', kind: 'update', id, title: n.title, url: n.url || null });
    this.changed();
  }

  move(id, { parent, position, before }) {
    if (!this.get(id)) throw new Error('bookmark not found');
    this.moveMany([id], { parent, position, before });
  }

  /**
   * Moves nodes (in the given order) into `parent`, before the child `before` / at `position` /
   * at the end. A node whose ancestor is also selected travels with that ancestor. Throws when a
   * folder would end up inside itself. Records an undo step.
   * @returns {number} nodes moved (0 when they already sit exactly there)
   */
  moveMany(ids, { parent, position, before } = {}, { undo = true } = {}) {
    parent = String(parent);
    if (!this.folderExists(parent)) throw new Error('parent folder does not exist');
    const sel = this.normalizeSelection(ids);
    if (!sel.length) return 0;
    const chain = new Set([parent, ...this.ancestors(parent)]);
    if (sel.some((id) => chain.has(id))) throw new Error('cannot move a folder into itself');
    const skip = new Set(sel);
    return this.batch(() => {
      const anchor = this.anchorFor(parent, before, position, skip);
      // Already exactly there? (dropping an item back onto its own place must not churn sync)
      const current = this.kids(parent).map((s) => s.id);
      const rest = current.filter((x) => !skip.has(x));
      const at = anchor === null ? rest.length : rest.indexOf(anchor);
      const wanted = [...rest.slice(0, at), ...sel, ...rest.slice(at)];
      if (wanted.length === current.length && wanted.every((x, i) => x === current[i])) return 0;
      const parents = new Set([parent]);
      for (const id of sel) parents.add(this.db.get('SELECT parent FROM bookmarks WHERE id = ?', id).parent);
      const snapshot = undo ? this.orderSnapshot(parents) : null;
      const idxs = this.slots(parent, anchor, sel.length, skip);
      const stamp = nowIso();
      sel.forEach((id, i) => this.db.run('UPDATE bookmarks SET parent = ?, idx = ?, updated_at = ?, dirty = 1 WHERE id = ?', parent, idxs[i], stamp, id));
      if (snapshot) this.pushUndo({ label: sel.length === 1 ? 'Move' : `Move ${sel.length} items`, kind: 'order', rows: snapshot });
      this.changed();
      return sel.length;
    });
  }

  /** Deep-copies nodes into `parent` (new ids). @returns {string[]} ids of the new top-level copies */
  copyMany(ids, { parent, position, before } = {}) {
    parent = String(parent);
    if (!this.folderExists(parent)) throw new Error('parent folder does not exist');
    const sel = this.normalizeSelection(ids);
    if (!sel.length) return [];
    const trees = sel.map((id) => this.subtree(id)).filter(Boolean);
    return this.batch(() => {
      const anchor = this.anchorFor(parent, before, position, new Set());
      const idxs = this.slots(parent, anchor, trees.length);
      const stamp = nowIso();
      let budget = MAX_IMPORT;
      const insert = (n, into, idx, depth) => {
        if (budget-- <= 0) return null;
        const id = this.insertRow(n.type, into, idx, n.title, n.url, stamp);
        if (n.type === 'folder' && depth < MAX_DEPTH) n.children.forEach((c, i) => insert(c, id, i + 1, depth + 1));
        return id;
      };
      const created = trees.map((t, i) => insert(t, parent, idxs[i], 0)).filter(Boolean);
      this.pushUndo({ label: created.length === 1 ? 'Paste' : `Paste ${created.length} items`, kind: 'unadd', ids: created });
      this.changed();
      return created;
    });
  }

  /** {type, title, url, children} of a live node and its live descendants. */
  subtree(id, depth = 0, seen = new Set()) {
    const r = this.db.get('SELECT * FROM bookmarks WHERE id = ? AND deleted = 0', id);
    if (!r || seen.has(id)) return null;
    seen.add(id);
    const n = { type: r.type, title: r.title, url: r.url };
    if (r.type === 'folder') n.children = depth < MAX_DEPTH ? this.kids(id).map((c) => this.subtree(c.id, depth + 1, seen)).filter(Boolean) : [];
    return n;
  }

  /** Delete a node and (for folders) all descendants; tombstones sync the deletion. */
  remove(id) {
    if (isRoot(id)) throw new Error('cannot delete a root folder');
    this.removeMany([id]);
  }

  /**
   * Deletes nodes with their descendants (tombstones sync the deletion) and records an undo step.
   * @returns {{bookmarks: number, folders: number}}
   */
  removeMany(ids, { undo = true } = {}) {
    const sel = this.normalizeSelection(ids);
    const out = { bookmarks: 0, folders: 0 };
    if (!sel.length) return out;
    this.batch(() => {
      const stamp = nowIso();
      const rows = [];
      for (const id of sel) {
        const stack = [id];
        while (stack.length) {
          const cur = stack.pop();
          const r = this.db.get('SELECT * FROM bookmarks WHERE id = ? AND deleted = 0', cur);
          if (!r) continue;
          rows.push(r); // pre-order: a folder is recorded before its children
          if (r.type === 'folder') out.folders++;
          else out.bookmarks++;
          for (const c of this.db.all('SELECT id FROM bookmarks WHERE parent = ? AND deleted = 0 ORDER BY idx DESC', cur)) stack.push(c.id);
          this.db.run('UPDATE bookmarks SET deleted = 1, dirty = 1, updated_at = ? WHERE id = ?', stamp, cur);
        }
      }
      if (undo) {
        const what = sel.length === 1 ? `“${(rows[0] && rows[0].title) || (rows[0] && rows[0].url) || 'item'}”` : `${sel.length} items`;
        this.pushUndo({ label: `Delete ${what}`, kind: 'restore', rows: rows.map((r) => ({ id: r.id, type: r.type, parent: r.parent, idx: r.idx, title: r.title, url: r.url, created_at: r.created_at, extra: r.extra })) });
      }
      this.changed();
    });
    return out;
  }

  /** Sorts a folder's children: folders first, then by title (natural order), then URL. */
  sortFolder(id) {
    if (!this.folderExists(id)) throw new Error('folder not found');
    return this.batch(() => {
      const rows = this.db.all('SELECT id, type, title, url, idx FROM bookmarks WHERE parent = ? AND deleted = 0 ORDER BY idx, id', id);
      const sorted = [...rows].sort((a, b) => (a.type === b.type ? 0 : a.type === 'folder' ? -1 : 1) || collator.compare(a.title || a.url || '', b.title || b.url || '') || collator.compare(a.url || '', b.url || ''));
      if (sorted.every((r, i) => r === rows[i])) return 0;
      this.pushUndo({ label: 'Sort', kind: 'order', rows: this.orderSnapshot([id]) });
      const stamp = nowIso();
      sorted.forEach((r, i) => {
        if (r.idx !== i + 1) this.db.run('UPDATE bookmarks SET idx = ?, updated_at = ?, dirty = 1 WHERE id = ?', i + 1, stamp, r.id);
      });
      this.changed();
      return rows.length;
    });
  }

  // ------------------------------------------------------------------------------------ undo

  orderSnapshot(parents) {
    const rows = [];
    for (const p of parents) for (const r of this.kids(p)) rows.push({ id: r.id, parent: r.parent, idx: r.idx });
    return rows;
  }

  pushUndo(entry) {
    this.undoStack.push(entry);
    if (this.undoStack.length > MAX_UNDO) this.undoStack.shift();
  }

  undoInfo() {
    const e = this.undoStack[this.undoStack.length - 1];
    return e ? { label: e.label } : null;
  }

  /**
   * Reverts the most recent move / delete / paste / sort / edit (best effort: nodes deleted or
   * re-parented since are skipped, never put into a cycle). @returns {{label: string}|null}
   */
  undo() {
    const e = this.undoStack.pop();
    if (!e) return null;
    this.batch(() => {
      const stamp = nowIso();
      if (e.kind === 'order') {
        for (const r of e.rows) {
          const cur = this.db.get('SELECT parent, idx FROM bookmarks WHERE id = ? AND deleted = 0', r.id);
          if (!cur || (cur.parent === r.parent && cur.idx === r.idx)) continue;
          if (!this.folderExists(r.parent) || this.wouldCycle(r.id, r.parent)) continue;
          this.db.run('UPDATE bookmarks SET parent = ?, idx = ?, updated_at = ?, dirty = 1 WHERE id = ?', r.parent, r.idx, stamp, r.id);
        }
      } else if (e.kind === 'restore') {
        const idMap = new Map();
        for (const r of e.rows) {
          let parent = idMap.get(r.parent) || r.parent;
          if (!this.folderExists(parent)) parent = 'other';
          const existing = this.db.get('SELECT deleted FROM bookmarks WHERE id = ?', r.id);
          if (existing && !existing.deleted) continue;
          if (existing) {
            // The tombstone is still here: bring the same record back (it syncs as an edit).
            this.db.run('UPDATE bookmarks SET deleted = 0, parent = ?, idx = ?, title = ?, url = ?, updated_at = ?, dirty = 1 WHERE id = ?', parent, r.idx, r.title, r.url, stamp, r.id);
          } else {
            // Already purged after syncing the deletion: re-create under a new id.
            const id = randomUUID();
            idMap.set(r.id, id);
            this.db.run(
              'INSERT INTO bookmarks (id, type, parent, idx, title, url, created_at, updated_at, deleted, dirty, revision, extra) VALUES (?,?,?,?,?,?,?,?,0,1,0,?)',
              id, r.type, parent, r.idx, r.title, r.url, r.created_at || stamp, stamp, r.extra || null,
            );
          }
        }
      } else if (e.kind === 'unadd') {
        this.removeMany(e.ids, { undo: false });
      } else if (e.kind === 'update') {
        const n = this.get(e.id);
        if (n) this.update(e.id, { title: e.title, url: e.url || undefined }, { undo: false });
      }
      this.changed();
    });
    return { label: e.label };
  }

  // ---------------------------------------------------------------------------------- import

  /**
   * Bulk import (Chromium JSON, Firefox places, bookmark HTML). Nodes: {type, title, url?, children?}.
   * With `folderTitle`, everything goes into that folder under `parent` (an existing live folder
   * of that name is reused). With `dedupe` (default), a URL that was already bookmarked anywhere
   * before the import is skipped and folders merge by title; folders are only created once
   * something is added inside them. So importing the same source again — even after the earlier
   * import was reorganised — adds only what is new, and never empty duplicate folders.
   * @returns {{added: number, skipped: number, folders: number, folder: string|null}}
   */
  importTree(nodes, { parent = 'other', folderTitle = '', dedupe = true } = {}) {
    const res = { added: 0, skipped: 0, folders: 0, folder: null };
    if (!this.folderExists(parent)) throw new Error('parent folder does not exist');
    if (!Array.isArray(nodes) || !nodes.length) return res;
    this.batch(() => {
      const stamp = nowIso();
      // Known before this import started: duplicates inside the source itself are kept.
      const known = dedupe ? new Set(this.db.all("SELECT url FROM bookmarks WHERE deleted = 0 AND type = 'url'").map((r) => r.url)) : new Set();
      const state = new Map(); // folder id → {next idx, folders: title → id}
      const info = (folder) => {
        let s = state.get(folder);
        if (!s) {
          s = { next: 1, folders: new Map() };
          for (const r of this.db.all('SELECT id, type, title, idx FROM bookmarks WHERE parent = ? AND deleted = 0 ORDER BY idx, id', folder)) {
            s.next = Math.max(s.next, Math.floor(r.idx) + 1);
            if (r.type === 'folder' && !s.folders.has(r.title)) s.folders.set(r.title, r.id);
          }
          state.set(folder, s);
        }
        return s;
      };
      const folderIn = (into, title) => {
        const s = info(into);
        const t = String(title || 'Folder').slice(0, MAX_TITLE);
        let id = dedupe ? s.folders.get(t) : undefined;
        if (!id) {
          id = this.insertRow('folder', into, s.next++, t, null, stamp);
          s.folders.set(t, id);
          state.set(id, { next: 1, folders: new Map() });
          res.folders++;
        }
        return id;
      };
      // A folder handle {title, up, id?} becomes a real folder on first use.
      const ensure = (f) => {
        if (!f.id) f.id = folderIn(ensure(f.up), f.title);
        return f.id;
      };
      const walk = (list, here, depth) => {
        if (depth > 32) return;
        for (const n of list) {
          if (res.added + res.skipped >= MAX_IMPORT) return;
          if (!n || typeof n !== 'object') continue;
          if (n.type === 'folder') {
            const kids = Array.isArray(n.children) ? n.children : [];
            const f = { title: n.title, up: here };
            if (!kids.length) ensure(f); // an empty folder in the source is imported as such
            walk(kids, f, depth + 1);
          } else if (typeof n.url === 'string' && n.url && n.url.length <= MAX_URL) {
            if (known.has(n.url)) {
              res.skipped++;
              continue;
            }
            const into = ensure(here);
            this.insertRow('url', into, info(into).next++, n.title || n.url, n.url, stamp);
            res.added++;
          }
        }
      };
      const root = folderTitle ? { title: folderTitle, up: { id: parent } } : { id: parent };
      walk(nodes, root, 0);
      res.folder = root.id || (dedupe ? info(parent).folders.get(String(folderTitle).slice(0, MAX_TITLE)) || null : null);
      if (res.added || res.folders) this.changed();
    });
    return res;
  }

  /** Bulk import, legacy shape. @returns {number} bookmarks created */
  importNodes(nodes, opts = {}) {
    return this.importTree(nodes, opts).added;
  }

  // -------------------------------------------------------------------- favicons (local cache)

  iconMap() {
    if (!this.icons) {
      const saved = this.db.getMeta('bookmark_icons', {});
      this.icons = new Map(Object.entries(saved && typeof saved === 'object' ? saved : {}).filter(([k, v]) => k && typeof v === 'string' && v.startsWith('data:image/') && v.length <= MAX_ICON_LEN));
    }
    return this.icons;
  }

  /** Cached favicon (data: URL) for a bookmark URL's site, or null. */
  iconFor(url) {
    const host = iconHost(url);
    return (host && this.iconMap().get(host)) || null;
  }

  /** Every cached favicon, host → data: URL. */
  allIcons() {
    return Object.fromEntries(this.iconMap());
  }

  /**
   * Remembers a page's favicon for its site when that page is bookmarked (or `force`, for imports).
   * @returns {boolean} whether the cache changed
   */
  noteIcon(pageUrl, dataUrl, { force = false } = {}) {
    if (typeof dataUrl !== 'string' || !/^data:image\/(png|x-icon|vnd\.microsoft\.icon|gif|jpeg|webp|svg\+xml|avif|bmp);base64,/.test(dataUrl) || dataUrl.length > MAX_ICON_LEN) return false;
    const host = iconHost(pageUrl);
    if (!host) return false;
    const m = this.iconMap();
    if (m.get(host) === dataUrl) return false;
    if (!force && !this.isBookmarked(pageUrl)) return false;
    m.delete(host);
    m.set(host, dataUrl);
    while (m.size > MAX_ICONS) m.delete(m.keys().next().value);
    this.iconVersion++;
    if (!this.iconTimer) {
      this.iconTimer = setTimeout(() => this.saveIcons(), 3000);
      if (this.iconTimer.unref) this.iconTimer.unref();
    }
    return true;
  }

  saveIcons() {
    clearTimeout(this.iconTimer);
    this.iconTimer = null;
    if (this.icons) this.db.setMeta('bookmark_icons', Object.fromEntries(this.icons));
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
