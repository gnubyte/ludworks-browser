// Bookmark store operations used by the manager / bookmarks bar, and importing from other browsers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ProfileDb } from '../build/app/main/profile/db.js';
import { Bookmarks } from '../build/app/main/profile/bookmarks.js';
import {
  firefoxBookmarksFrom,
  firefoxHistoryFrom,
  knownBrowsers,
  listSources,
  parseChromiumBookmarks,
  parseIni,
  readChromiumHistory,
  withDatabaseCopy,
} from '../build/app/main/import/browsers.js';

function tmpStore() {
  const dir = mkdtempSync(path.join(tmpdir(), 'lwb-bm-'));
  const db = new ProfileDb(dir);
  const b = new Bookmarks(db);
  return { db, b, dir, done: () => { b.saveIcons(); db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

const titles = (b, parent) => b.children(parent).map((n) => n.title);
const clean = (db) => db.run('UPDATE bookmarks SET dirty = 0');
const dirtyIds = (db) => db.all('SELECT id FROM bookmarks WHERE dirty = 1').map((r) => r.id);

function seed(b, parent, names) {
  return Object.fromEntries(names.map((t) => [t, b.add({ parent, title: t, url: `https://${t.toLowerCase()}.test/` })]));
}

test('moveMany: multi-select reorder within a folder keeps the selection order and the rest stable', () => {
  const { b, db, done } = tmpStore();
  try {
    const n = seed(b, 'toolbar', ['A', 'B', 'C', 'D', 'E', 'F']);
    // Shift-selected B..D dropped before F
    assert.equal(b.moveMany([n.B, n.C, n.D], { parent: 'toolbar', before: n.F }), 3);
    assert.deepEqual(titles(b, 'toolbar'), ['A', 'E', 'B', 'C', 'D', 'F']);
    // Ctrl-selected F, A (in that order) dropped at the start
    b.moveMany([n.F, n.A], { parent: 'toolbar', position: 0 });
    assert.deepEqual(titles(b, 'toolbar'), ['F', 'A', 'E', 'B', 'C', 'D']);
    // `before` pointing at one of the moved nodes means "where that node was"
    b.moveMany([n.E, n.B], { parent: 'toolbar', before: n.B });
    assert.deepEqual(titles(b, 'toolbar'), ['F', 'A', 'E', 'B', 'C', 'D']);
    b.moveMany([n.D, n.E], { parent: 'toolbar', before: n.E });
    assert.deepEqual(titles(b, 'toolbar'), ['F', 'A', 'D', 'E', 'B', 'C']);
    // to the end
    b.moveMany([n.F], { parent: 'toolbar' });
    assert.deepEqual(titles(b, 'toolbar'), ['A', 'D', 'E', 'B', 'C', 'F']);
    // dropping a node back onto its own place does not touch anything (no sync churn, no undo step)
    clean(db);
    const undoBefore = b.undoStack.length;
    assert.equal(b.moveMany([n.E], { parent: 'toolbar', before: n.B }), 0);
    assert.equal(b.moveMany([n.D, n.E], { parent: 'toolbar', before: n.D }), 0);
    assert.deepEqual(dirtyIds(db), []);
    assert.equal(b.undoStack.length, undoBefore);
    // only the moved node becomes dirty when there is room between its new neighbours
    b.moveMany([n.F], { parent: 'toolbar', before: n.D });
    assert.deepEqual(dirtyIds(db), [n.F]);
    assert.deepEqual(titles(b, 'toolbar'), ['A', 'F', 'D', 'E', 'B', 'C']);
  } finally {
    done();
  }
});

test('moveMany: across folders, ancestors carry their descendants, cycles are refused', () => {
  const { b, done } = tmpStore();
  try {
    const work = b.add({ parent: 'toolbar', type: 'folder', title: 'Work' });
    const proj = b.add({ parent: work, type: 'folder', title: 'Projects' });
    const deep = b.add({ parent: proj, type: 'folder', title: 'Deep' });
    const x = b.add({ parent: proj, title: 'X', url: 'https://x.test/' });
    const n = seed(b, 'other', ['A', 'B']);
    // folder + its own child selected together: the child stays inside the moved folder
    assert.equal(b.moveMany([proj, x, n.A], { parent: 'other', before: n.B }), 2);
    assert.deepEqual(titles(b, 'other'), ['Projects', 'A', 'B']);
    assert.deepEqual(titles(b, proj), ['Deep', 'X']);
    // into itself / into a descendant (any depth) / a selection containing an ancestor of the target
    assert.throws(() => b.moveMany([proj], { parent: proj }), /itself/);
    assert.throws(() => b.moveMany([proj], { parent: deep }), /itself/);
    const deeper = b.add({ parent: deep, type: 'folder', title: 'Deeper' });
    assert.throws(() => b.moveMany([n.B, proj], { parent: deeper }), /itself/);
    assert.deepEqual(titles(b, 'other'), ['Projects', 'A', 'B']); // nothing moved
    assert.throws(() => b.move(work, { parent: work }));
    assert.throws(() => b.moveMany([n.A], { parent: 'nope' }), /parent/);
    // roots cannot be moved; missing ids are ignored
    assert.equal(b.moveMany(['toolbar', 'missing'], { parent: 'other' }), 0);
    // whole folder moves back into the bar folder with its subtree
    b.moveMany([proj], { parent: work, position: 0 });
    assert.deepEqual(titles(b, work), ['Projects']);
    assert.deepEqual(b.ancestors(deeper), [deep, proj, work]);
    const t = b.tree();
    assert.equal(t.toolbar.children[0].children[0].children[0].children[0].title, 'Deeper');
  } finally {
    done();
  }
});

test('positions stay consistent when the gaps run out (renumbering)', () => {
  const { b, done } = tmpStore();
  try {
    const n = seed(b, 'toolbar', ['A', 'Z']);
    // keep inserting right after A: halves the gap every time until it renumbers
    const order = ['A'];
    for (let i = 0; i < 70; i++) {
      const id = b.add({ parent: 'toolbar', title: `N${i}`, url: `https://n${i}.test/`, before: b.children('toolbar')[1].id });
      assert.ok(id);
      order.splice(1, 0, `N${i}`);
    }
    order.push('Z');
    assert.deepEqual(titles(b, 'toolbar'), order);
    // multi-move into the tightest spot
    const kids = b.children('toolbar');
    b.moveMany([n.Z, kids[5].id], { parent: 'toolbar', before: kids[2].id });
    const after = titles(b, 'toolbar');
    assert.deepEqual(after.slice(0, 4), ['A', order[1], 'Z', order[5]]);
    assert.equal(new Set(b.children('toolbar').map((c) => c.index)).size, after.length); // no ties
  } finally {
    done();
  }
});

test('removeMany + undo (tombstone revived, or re-created after the deletion synced); undo of moves, edits, sort, paste', () => {
  const { b, db, done } = tmpStore();
  try {
    const f = b.add({ parent: 'toolbar', type: 'folder', title: 'F' });
    const inner = seed(b, f, ['One', 'Two']);
    const n = seed(b, 'toolbar', ['A', 'B', 'C']);
    clean(db);
    assert.deepEqual(b.removeMany([f, inner.One, n.B]), { bookmarks: 3, folders: 1 });
    assert.deepEqual(titles(b, 'toolbar'), ['A', 'C']);
    assert.equal(db.get('SELECT count(*) AS c FROM bookmarks WHERE deleted = 1 AND dirty = 1').c, 4); // tombstones to sync
    assert.match(b.undoInfo().label, /Delete 2 items/);
    assert.deepEqual(b.undo(), { label: 'Delete 2 items' });
    assert.deepEqual(titles(b, 'toolbar'), ['F', 'A', 'B', 'C']);
    assert.deepEqual(titles(b, f), ['One', 'Two']);
    assert.equal(b.get(f).id, f); // same records come back (they sync as edits)

    // deletion already synced (tombstone purged) → re-created under new ids, same structure
    b.removeMany([f]);
    for (const d of b.dirty()) b.markSynced(d.id, 3, d.updated_at);
    assert.equal(db.get('SELECT count(*) AS c FROM bookmarks WHERE id = ?', f).c, 0);
    b.undo();
    const back = b.children('toolbar')[0];
    assert.equal(back.title, 'F');
    assert.notEqual(back.id, f);
    assert.deepEqual(titles(b, back.id), ['One', 'Two']);

    // undo of a multi-move restores both folders exactly
    const before = titles(b, 'toolbar');
    b.moveMany([n.A, n.C], { parent: back.id, position: 1 });
    assert.deepEqual(titles(b, back.id), ['One', 'A', 'C', 'Two']);
    assert.equal(b.undo().label, 'Move 2 items');
    assert.deepEqual(titles(b, 'toolbar'), before);
    assert.deepEqual(titles(b, back.id), ['One', 'Two']);

    // edit, sort, paste
    b.update(n.A, { title: 'Renamed', url: 'https://renamed.test/' });
    b.undo();
    assert.equal(b.get(n.A).title, 'A');
    assert.equal(b.get(n.A).url, 'https://a.test/');
    seed(b, 'other', ['b', 'C10', 'a', 'C9']);
    b.add({ parent: 'other', type: 'folder', title: 'zeta' });
    b.sortFolder('other');
    assert.deepEqual(titles(b, 'other'), ['zeta', 'a', 'b', 'C9', 'C10']);
    b.undo();
    assert.deepEqual(titles(b, 'other'), ['b', 'C10', 'a', 'C9', 'zeta']);
    const copies = b.copyMany([back.id, n.B], { parent: 'other', position: 0 });
    assert.equal(copies.length, 2);
    assert.deepEqual(titles(b, 'other').slice(0, 2), ['F', 'B']);
    assert.deepEqual(titles(b, copies[0]), ['One', 'Two']); // deep copy with new ids
    assert.notEqual(b.children(copies[0])[0].id, b.children(back.id)[0].id);
    b.undo();
    assert.deepEqual(titles(b, 'other'), ['b', 'C10', 'a', 'C9', 'zeta']);
    assert.throws(() => b.remove('toolbar'));
  } finally {
    done();
  }
});

test('change events: one per batch operation', () => {
  const { b, done } = tmpStore();
  try {
    let events = 0;
    b.on('change', () => events++);
    const nodes = Array.from({ length: 500 }, (_, i) => ({ type: 'url', title: `T${i}`, url: `https://t${i}.test/` }));
    b.importTree(nodes, { parent: 'other', folderTitle: 'Big' });
    assert.equal(events, 1);
    const ids = b.children(b.children('other')[0].id).map((n) => n.id);
    b.moveMany(ids.slice(0, 200), { parent: 'toolbar' });
    b.removeMany(ids.slice(200));
    assert.equal(events, 3);
  } finally {
    done();
  }
});

test('importTree: re-importing the same source adds nothing; folders merge by title', () => {
  const { b, done } = tmpStore();
  try {
    const src = [
      { type: 'url', title: 'Docs', url: 'https://docs.test/' },
      { type: 'folder', title: 'News', children: [{ type: 'url', title: 'Paper', url: 'https://paper.test/' }, { type: 'folder', title: 'Tech', children: [{ type: 'url', title: 'HN', url: 'https://hn.test/' }] }] },
      { type: 'url', title: 'bad', url: '' },
    ];
    const r1 = b.importTree(src, { parent: 'toolbar', folderTitle: 'Imported from Edge' });
    assert.deepEqual({ ...r1, folder: typeof r1.folder }, { added: 3, skipped: 0, folders: 3, folder: 'string' });
    const r2 = b.importTree(src, { parent: 'toolbar', folderTitle: 'Imported from Edge' });
    assert.equal(r2.added, 0);
    assert.equal(r2.skipped, 3);
    assert.equal(r2.folders, 0);
    assert.equal(r2.folder, r1.folder);
    assert.deepEqual(titles(b, 'toolbar'), ['Imported from Edge']);
    // the source gained a bookmark: only that one is added, in the existing folder
    src[1].children[1].children.push({ type: 'url', title: 'Lobsters', url: 'https://lobste.rs/' });
    const r3 = b.importTree(src, { parent: 'toolbar', folderTitle: 'Imported from Edge' });
    assert.equal(r3.added, 1);
    const tech = b.tree().toolbar.children[0].children[1].children[1];
    assert.deepEqual(tech.children.map((n) => n.title), ['HN', 'Lobsters']);
    // the earlier import was reorganised (a folder moved elsewhere, a bookmark moved out):
    // importing again still adds nothing and leaves no empty duplicate folders behind
    const news = b.children(r1.folder)[1];
    b.moveMany([news.id], { parent: 'other' });
    b.moveMany([b.children(r1.folder)[0].id], { parent: 'mobile' });
    const before = b.flat().rows.length;
    const r5 = b.importTree(src, { parent: 'toolbar', folderTitle: 'Imported from Edge' });
    assert.deepEqual([r5.added, r5.folders, r5.skipped], [0, 0, 4]);
    assert.equal(b.flat().rows.length, before);
    // merge mode straight into the bar: nothing known is duplicated, no empty "News" folder appears
    b.add({ parent: 'toolbar', title: 'Docs (mine)', url: 'https://docs.test/' });
    const r4 = b.importTree(src, { parent: 'toolbar' });
    assert.deepEqual([r4.added, r4.skipped, r4.folders], [0, 4, 0]);
    assert.deepEqual(titles(b, 'toolbar'), ['Imported from Edge', 'Docs (mine)']);
    // duplicates inside one source are kept on the first import; empty source folders are imported
    const r6 = b.importTree([{ type: 'url', title: 'N', url: 'https://n.test/' }, { type: 'folder', title: 'Again', children: [{ type: 'url', title: 'N2', url: 'https://n.test/' }] }, { type: 'folder', title: 'Empty', children: [] }], { parent: 'other' });
    assert.deepEqual([r6.added, r6.folders], [2, 2]);
    assert.equal(b.importNodes([{ type: 'url', title: 'New', url: 'https://new.test/' }], { parent: 'other' }), 1);
  } finally {
    done();
  }
});

test('favicon cache: only for bookmarked pages unless forced, keyed by site, persisted', () => {
  const { b, db, done } = tmpStore();
  try {
    const png = `data:image/png;base64,${Buffer.from('89504e470d0a1a0a', 'hex').toString('base64')}`;
    assert.equal(b.noteIcon('https://www.site.test/a', png), false); // not bookmarked
    b.add({ parent: 'toolbar', title: 'S', url: 'https://www.site.test/a' });
    assert.equal(b.noteIcon('https://www.site.test/a', png), true);
    assert.equal(b.iconFor('https://site.test/other'), png);
    assert.equal(b.noteIcon('https://x.test/', 'data:text/html;base64,AAAA', { force: true }), false);
    assert.equal(b.noteIcon('javascript:alert(1)', png, { force: true }), false);
    b.saveIcons();
    const again = new Bookmarks(db);
    assert.equal(again.iconFor('https://site.test/'), png);
  } finally {
    done();
  }
});

test('flat snapshot lists parents before children with effective parents', () => {
  const { b, done } = tmpStore();
  try {
    const f = b.add({ parent: 'other', type: 'folder', title: 'F' });
    b.add({ parent: f, title: 'In', url: 'https://in.test/' });
    b.applyRemote('orphan', 1, { type: 'url', parent: 'gone', index: 1, title: 'Orphan', url: 'https://o.test/', updated_at: '2026-01-01T00:00:00Z' });
    const { roots, rows } = b.flat();
    assert.deepEqual(roots.map((r) => r.id), ['toolbar', 'other', 'mobile']);
    const pos = new Map(rows.map((r, i) => [r[0], i]));
    const inRow = rows.find((r) => r[3] === 'In');
    assert.ok(pos.get(f) < pos.get(inRow[0]));
    assert.equal(rows.find((r) => r[0] === 'orphan')[1], 'other');
  } finally {
    done();
  }
});

// ------------------------------------------------------------------------------- importers

function makePlaces(file, { wal = false } = {}) {
  const db = new DatabaseSync(file);
  if (wal) db.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;');
  db.exec(`
    CREATE TABLE moz_places (id INTEGER PRIMARY KEY, url TEXT, title TEXT, hidden INTEGER DEFAULT 0, typed INTEGER DEFAULT 0, last_visit_date INTEGER, visit_count INTEGER DEFAULT 0);
    CREATE TABLE moz_bookmarks (id INTEGER PRIMARY KEY, type INTEGER, fk INTEGER, parent INTEGER, position INTEGER, title TEXT, guid TEXT, dateAdded INTEGER);
    CREATE TABLE moz_historyvisits (id INTEGER PRIMARY KEY, place_id INTEGER, visit_date INTEGER, visit_type INTEGER);
  `);
  const now = Date.now() * 1000;
  const place = db.prepare('INSERT INTO moz_places (id, url, title, hidden, typed, last_visit_date) VALUES (?,?,?,?,?,?)');
  place.run(1, 'https://mozilla.org/', 'Mozilla', 0, 1, now - 1000);
  place.run(2, 'https://news.test/', 'News', 0, 0, now - 2000);
  place.run(3, 'place:sort=8&maxResults=10', 'Most visited', 0, 0, null);
  place.run(4, 'https://menu.test/', 'Menu item', 0, 0, now - 400 * 86400e6); // older than 90 days
  place.run(5, 'https://hidden.test/', 'Hidden', 1, 0, now);
  place.run(6, 'https://mobile.test/', 'Phone', 0, 0, null);
  const bm = db.prepare('INSERT INTO moz_bookmarks (id, type, fk, parent, position, title, guid) VALUES (?,?,?,?,?,?,?)');
  bm.run(1, 2, null, 0, 0, '', 'root________');
  bm.run(2, 2, null, 1, 0, 'menu', 'menu________');
  bm.run(3, 2, null, 1, 1, 'toolbar', 'toolbar_____');
  bm.run(4, 2, null, 1, 2, 'tags', 'tags________');
  bm.run(5, 2, null, 1, 3, 'unfiled', 'unfiled_____');
  bm.run(6, 2, null, 1, 4, 'mobile', 'mobile______');
  bm.run(10, 1, 1, 3, 1, 'Mozilla', 'aaaaaaaaaaaa');
  bm.run(11, 2, null, 3, 0, 'Reading', 'bbbbbbbbbbbb');
  bm.run(12, 1, 2, 11, 0, null, 'cccccccccccc'); // untitled → URL later
  bm.run(13, 3, null, 3, 2, '', 'separator___');
  bm.run(14, 1, 3, 3, 3, 'Most visited', 'dddddddddddd'); // place: query, skipped
  bm.run(15, 1, 4, 2, 0, 'Menu item', 'eeeeeeeeeeee');
  bm.run(16, 1, 1, 5, 0, 'Other one', 'ffffffffffff');
  bm.run(17, 1, 6, 6, 0, 'Phone', 'gggggggggggg');
  bm.run(18, 1, 2, 4, 0, 'tag entry', 'hhhhhhhhhhhh'); // under tags: ignored
  const v = db.prepare('INSERT INTO moz_historyvisits (place_id, visit_date, visit_type) VALUES (?,?,1)');
  v.run(1, now - 1000);
  v.run(1, now - 5000);
  v.run(2, now - 2000);
  return db;
}

test('Firefox places.sqlite: bookmarks (roots mapped, queries/separators/tags skipped) and history', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'lwb-ff-'));
  try {
    const file = path.join(dir, 'places.sqlite');
    const live = makePlaces(file, { wal: true }); // keep it open: the rows are still only in the -wal file
    const { bm, hist } = withDatabaseCopy(file, (db) => ({ bm: firefoxBookmarksFrom(db), hist: firefoxHistoryFrom(db) }));
    live.close();
    assert.deepEqual(bm.toolbar.map((n) => n.title), ['Reading', 'Mozilla']);
    assert.deepEqual(bm.toolbar[0].children, [{ type: 'url', title: '', url: 'https://news.test/' }]);
    assert.deepEqual(bm.other.map((n) => n.title), ['Bookmarks Menu', 'Other one', 'Mobile bookmarks']);
    assert.deepEqual(bm.other[0].children.map((n) => n.url), ['https://menu.test/']);
    assert.deepEqual(bm.other[2].children.map((n) => n.title), ['Phone']);
    assert.deepEqual(hist.map((h) => h.url), ['https://mozilla.org/', 'https://news.test/']);
    assert.equal(hist[0].typed, true);
    assert.equal(hist[0].visits.length, 2);
    assert.ok(Math.abs(hist[0].visits[0] - Date.now()) < 60000);
    // and into the store: untitled bookmarks get their URL as title, re-import is a no-op
    const { b, done } = tmpStore();
    try {
      const nodes = [...bm.toolbar, { type: 'folder', title: 'Other bookmarks', children: bm.other }];
      assert.equal(b.importTree(nodes, { parent: 'toolbar', folderTitle: 'Imported from Mozilla Firefox' }).added, 5);
      assert.equal(b.importTree(nodes, { parent: 'toolbar', folderTitle: 'Imported from Mozilla Firefox' }).added, 0);
      assert.equal(b.findByUrl('https://news.test/')[0].title, 'https://news.test/');
    } finally {
      done();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('source discovery: Chromium profiles from Local State, Opera single-profile, Firefox profiles.ini', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'lwb-home-'));
  try {
    const local = path.join(home, 'AppData', 'Local');
    const roaming = path.join(home, 'AppData', 'Roaming');
    const edge = path.join(local, 'Microsoft', 'Edge', 'User Data');
    const chromeJson = JSON.stringify({ roots: { bookmark_bar: { children: [{ type: 'url', name: 'E', url: 'https://e.test/' }] }, other: { children: [] }, synced: { children: [] } } });
    for (const p of ['Default', 'Profile 3', 'Guest Profile']) {
      mkdirSync(path.join(edge, p), { recursive: true });
      writeFileSync(path.join(edge, p, 'Bookmarks'), chromeJson);
    }
    mkdirSync(path.join(edge, 'Profile 9'), { recursive: true }); // no data: not listed
    writeFileSync(path.join(edge, 'Local State'), JSON.stringify({ profile: { last_used: 'Profile 3', info_cache: { Default: { name: 'Personal' }, 'Profile 3': { name: 'Work' }, 'Profile 9': { name: 'Empty' } } } }));
    const opera = path.join(roaming, 'Opera Software', 'Opera Stable');
    mkdirSync(opera, { recursive: true });
    writeFileSync(path.join(opera, 'Bookmarks'), chromeJson);
    const ff = path.join(roaming, 'Mozilla', 'Firefox');
    mkdirSync(path.join(ff, 'Profiles', 'abc.default-release'), { recursive: true });
    mkdirSync(path.join(ff, 'Profiles', 'old.default'), { recursive: true });
    writeFileSync(path.join(ff, 'Profiles', 'abc.default-release', 'places.sqlite'), '');
    writeFileSync(path.join(ff, 'Profiles', 'old.default', 'places.sqlite'), '');
    writeFileSync(path.join(ff, 'profiles.ini'), '[Install308046B0AF4A39CB]\r\nDefault=Profiles/abc.default-release\r\nLocked=1\r\n\r\n[Profile1]\r\nName=default\r\nIsRelative=1\r\nPath=Profiles/old.default\r\nDefault=1\r\n\r\n[Profile0]\r\nName=default-release\r\nIsRelative=1\r\nPath=Profiles/abc.default-release\r\n');
    const sources = listSources(knownBrowsers('win32', { LOCALAPPDATA: local, APPDATA: roaming }, home));
    assert.deepEqual(
      sources.map((s) => [s.id, s.name, s.kind]),
      [
        ['edge', 'Microsoft Edge (Work)', 'chromium'],
        ['edge:Default', 'Microsoft Edge (Personal)', 'chromium'],
        ['opera', 'Opera', 'chromium'],
        ['firefox', 'Mozilla Firefox (default-release)', 'firefox'],
        ['firefox:Profiles/old.default', 'Mozilla Firefox (default)', 'firefox'],
      ],
    );
    assert.equal(sources[0].dir, path.join(edge, 'Profile 3'));
    assert.equal(sources[2].dir, opera);
    assert.equal(parseIni('[A]\nx = 1\n;c\n[B]\ny=2=3').B.y, '2=3');
    // every platform has the common browsers
    for (const pl of ['win32', 'darwin', 'linux']) {
      const ids = knownBrowsers(pl, {}, '/home/u').map((x) => x.browser);
      for (const id of ['edge', 'chrome', 'brave', 'vivaldi', 'opera', 'chromium', 'firefox', 'librewolf', 'waterfox']) assert.ok(ids.includes(id), `${pl} ${id}`);
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('Chromium History: WebKit µs timestamps beyond 2^53 are read correctly', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'lwb-ch-'));
  try {
    const file = path.join(dir, 'History');
    const db = new DatabaseSync(file);
    db.exec('CREATE TABLE urls (id INTEGER PRIMARY KEY, url TEXT, title TEXT, visit_count INTEGER, typed_count INTEGER, last_visit_time INTEGER, hidden INTEGER DEFAULT 0); CREATE TABLE visits (id INTEGER PRIMARY KEY, url INTEGER, visit_time INTEGER);');
    const webkit = (ms) => (BigInt(ms) + 11644473600000n) * 1000n; // ~1.34e16
    const now = Date.now() - 60000;
    db.prepare('INSERT INTO urls VALUES (?,?,?,?,?,?,0)').run(1, 'https://edge.test/', 'Edge', 2, 1, webkit(now));
    db.prepare('INSERT INTO urls VALUES (?,?,?,?,?,?,0)').run(2, 'https://old.test/', 'Old', 1, 0, webkit(now - 200 * 86400000));
    db.prepare('INSERT INTO visits (url, visit_time) VALUES (?,?)').run(1, webkit(now));
    db.prepare('INSERT INTO visits (url, visit_time) VALUES (?,?)').run(1, webkit(now - 3600000));
    db.close();
    const rows = readChromiumHistory(file);
    assert.deepEqual(rows.map((r) => r.url), ['https://edge.test/']);
    assert.deepEqual(rows[0].visits, [now, now - 3600000]);
    assert.equal(rows[0].typed, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Chromium Bookmarks JSON: bar, other and mobile roots', () => {
  const r = parseChromiumBookmarks(
    JSON.stringify({
      roots: {
        bookmark_bar: { children: [{ type: 'folder', name: 'F', children: [{ type: 'url', name: 'A', url: 'https://a.test/' }] }] },
        other: { children: [{ type: 'url', name: 'O', url: 'https://o.test/' }] },
        synced: { children: [{ type: 'url', name: 'M', url: 'https://m.test/' }] },
      },
    }),
  );
  assert.equal(r.toolbar[0].children[0].url, 'https://a.test/');
  assert.deepEqual(r.other.map((n) => n.title), ['O', 'Mobile bookmarks']);
});
