// Import bookmarks and history from the other browsers on this machine — Chromium family (Edge,
// Chrome, Brave, Vivaldi, Opera, Opera GX, Arc, Chromium, …) and Firefox family (Firefox, LibreWolf,
// Waterfox, Zen) on Windows, macOS and Linux, every profile — and Netscape bookmark HTML files
// (exported by every browser). Other browsers' files are only ever read (databases are copied to a
// temp folder first: they are locked while that browser runs). Passwords are not read from other
// browsers' stores (Chromium encrypts them with app-bound keys): export them as CSV there and
// import the CSV on the Passwords page (vault-io.js).

import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MAX_FILE = 64 * 1024 * 1024;
const MAX_NODES = 100000;
const WEBKIT_EPOCH_MS = 11644473600000; // 1601-01-01 → 1970-01-01

// ----------------------------------------------------------------------------------- discovery

/**
 * Known browsers and where they keep their user data, per platform.
 * @returns {Array<{browser: string, name: string, kind: 'chromium'|'firefox', dirs: string[]}>}
 */
export function knownBrowsers(platform = process.platform, env = process.env, home = os.homedir()) {
  const j = (...p) => path.join(...p);
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA || j(home, 'AppData', 'Local');
    const roaming = env.APPDATA || j(home, 'AppData', 'Roaming');
    return [
      { browser: 'edge', name: 'Microsoft Edge', kind: 'chromium', dirs: [j(local, 'Microsoft', 'Edge', 'User Data')] },
      { browser: 'edge-beta', name: 'Microsoft Edge Beta', kind: 'chromium', dirs: [j(local, 'Microsoft', 'Edge Beta', 'User Data')] },
      { browser: 'edge-dev', name: 'Microsoft Edge Dev', kind: 'chromium', dirs: [j(local, 'Microsoft', 'Edge Dev', 'User Data')] },
      { browser: 'edge-canary', name: 'Microsoft Edge Canary', kind: 'chromium', dirs: [j(local, 'Microsoft', 'Edge SxS', 'User Data')] },
      { browser: 'chrome', name: 'Google Chrome', kind: 'chromium', dirs: [j(local, 'Google', 'Chrome', 'User Data')] },
      { browser: 'chrome-beta', name: 'Google Chrome Beta', kind: 'chromium', dirs: [j(local, 'Google', 'Chrome Beta', 'User Data')] },
      { browser: 'chrome-canary', name: 'Google Chrome Canary', kind: 'chromium', dirs: [j(local, 'Google', 'Chrome SxS', 'User Data')] },
      { browser: 'brave', name: 'Brave', kind: 'chromium', dirs: [j(local, 'BraveSoftware', 'Brave-Browser', 'User Data')] },
      { browser: 'vivaldi', name: 'Vivaldi', kind: 'chromium', dirs: [j(local, 'Vivaldi', 'User Data')] },
      { browser: 'opera', name: 'Opera', kind: 'chromium', dirs: [j(roaming, 'Opera Software', 'Opera Stable')] },
      { browser: 'opera-gx', name: 'Opera GX', kind: 'chromium', dirs: [j(roaming, 'Opera Software', 'Opera GX Stable')] },
      { browser: 'arc', name: 'Arc', kind: 'chromium', dirs: arcWindowsDirs(local) },
      { browser: 'chromium', name: 'Chromium', kind: 'chromium', dirs: [j(local, 'Chromium', 'User Data')] },
      { browser: 'yandex', name: 'Yandex Browser', kind: 'chromium', dirs: [j(local, 'Yandex', 'YandexBrowser', 'User Data')] },
      { browser: 'firefox', name: 'Mozilla Firefox', kind: 'firefox', dirs: [j(roaming, 'Mozilla', 'Firefox')] },
      { browser: 'librewolf', name: 'LibreWolf', kind: 'firefox', dirs: [j(roaming, 'librewolf')] },
      { browser: 'waterfox', name: 'Waterfox', kind: 'firefox', dirs: [j(roaming, 'Waterfox')] },
      { browser: 'zen', name: 'Zen Browser', kind: 'firefox', dirs: [j(roaming, 'zen')] },
    ];
  }
  if (platform === 'darwin') {
    const as = j(home, 'Library', 'Application Support');
    return [
      { browser: 'edge', name: 'Microsoft Edge', kind: 'chromium', dirs: [j(as, 'Microsoft Edge')] },
      { browser: 'edge-beta', name: 'Microsoft Edge Beta', kind: 'chromium', dirs: [j(as, 'Microsoft Edge Beta')] },
      { browser: 'edge-dev', name: 'Microsoft Edge Dev', kind: 'chromium', dirs: [j(as, 'Microsoft Edge Dev')] },
      { browser: 'chrome', name: 'Google Chrome', kind: 'chromium', dirs: [j(as, 'Google', 'Chrome')] },
      { browser: 'chrome-beta', name: 'Google Chrome Beta', kind: 'chromium', dirs: [j(as, 'Google', 'Chrome Beta')] },
      { browser: 'chrome-canary', name: 'Google Chrome Canary', kind: 'chromium', dirs: [j(as, 'Google', 'Chrome Canary')] },
      { browser: 'brave', name: 'Brave', kind: 'chromium', dirs: [j(as, 'BraveSoftware', 'Brave-Browser')] },
      { browser: 'vivaldi', name: 'Vivaldi', kind: 'chromium', dirs: [j(as, 'Vivaldi')] },
      { browser: 'opera', name: 'Opera', kind: 'chromium', dirs: [j(as, 'com.operasoftware.Opera')] },
      { browser: 'opera-gx', name: 'Opera GX', kind: 'chromium', dirs: [j(as, 'com.operasoftware.OperaGX')] },
      { browser: 'arc', name: 'Arc', kind: 'chromium', dirs: [j(as, 'Arc', 'User Data')] },
      { browser: 'chromium', name: 'Chromium', kind: 'chromium', dirs: [j(as, 'Chromium')] },
      { browser: 'firefox', name: 'Mozilla Firefox', kind: 'firefox', dirs: [j(as, 'Firefox')] },
      { browser: 'librewolf', name: 'LibreWolf', kind: 'firefox', dirs: [j(as, 'librewolf')] },
      { browser: 'waterfox', name: 'Waterfox', kind: 'firefox', dirs: [j(as, 'Waterfox')] },
      { browser: 'zen', name: 'Zen Browser', kind: 'firefox', dirs: [j(as, 'zen')] },
    ];
  }
  const cfg = env.XDG_CONFIG_HOME || j(home, '.config');
  const flat = (id, ...p) => j(home, '.var', 'app', id, ...p);
  return [
    { browser: 'edge', name: 'Microsoft Edge', kind: 'chromium', dirs: [j(cfg, 'microsoft-edge'), flat('com.microsoft.Edge', 'config', 'microsoft-edge')] },
    { browser: 'edge-beta', name: 'Microsoft Edge Beta', kind: 'chromium', dirs: [j(cfg, 'microsoft-edge-beta')] },
    { browser: 'edge-dev', name: 'Microsoft Edge Dev', kind: 'chromium', dirs: [j(cfg, 'microsoft-edge-dev')] },
    { browser: 'chrome', name: 'Google Chrome', kind: 'chromium', dirs: [j(cfg, 'google-chrome'), flat('com.google.Chrome', 'config', 'google-chrome')] },
    { browser: 'chrome-beta', name: 'Google Chrome Beta', kind: 'chromium', dirs: [j(cfg, 'google-chrome-beta')] },
    { browser: 'chrome-canary', name: 'Google Chrome Unstable', kind: 'chromium', dirs: [j(cfg, 'google-chrome-unstable')] },
    { browser: 'brave', name: 'Brave', kind: 'chromium', dirs: [j(cfg, 'BraveSoftware', 'Brave-Browser'), flat('com.brave.Browser', 'config', 'BraveSoftware', 'Brave-Browser')] },
    { browser: 'vivaldi', name: 'Vivaldi', kind: 'chromium', dirs: [j(cfg, 'vivaldi'), flat('com.vivaldi.Vivaldi', 'config', 'vivaldi')] },
    { browser: 'opera', name: 'Opera', kind: 'chromium', dirs: [j(cfg, 'opera')] },
    { browser: 'chromium', name: 'Chromium', kind: 'chromium', dirs: [j(cfg, 'chromium'), j(home, 'snap', 'chromium', 'common', 'chromium'), flat('org.chromium.Chromium', 'config', 'chromium')] },
    { browser: 'yandex', name: 'Yandex Browser', kind: 'chromium', dirs: [j(cfg, 'yandex-browser')] },
    { browser: 'firefox', name: 'Mozilla Firefox', kind: 'firefox', dirs: [j(home, '.mozilla', 'firefox'), j(home, 'snap', 'firefox', 'common', '.mozilla', 'firefox'), flat('org.mozilla.firefox', '.mozilla', 'firefox'), j(cfg, 'mozilla', 'firefox')] },
    { browser: 'librewolf', name: 'LibreWolf', kind: 'firefox', dirs: [j(home, '.librewolf'), flat('io.gitlab.librewolf-community', '.librewolf')] },
    { browser: 'waterfox', name: 'Waterfox', kind: 'firefox', dirs: [j(home, '.waterfox')] },
    { browser: 'zen', name: 'Zen Browser', kind: 'firefox', dirs: [j(home, '.zen'), flat('app.zen_browser.zen', '.zen')] },
  ];
}

function arcWindowsDirs(local) {
  // Arc for Windows is an MSIX package: %LOCALAPPDATA%\Packages\TheBrowserCompany.Arc_<hash>\LocalCache\Local\Arc\User Data
  try {
    const pk = path.join(local, 'Packages');
    return readdirSync(pk)
      .filter((d) => /^TheBrowserCompany\.Arc_/i.test(d))
      .map((d) => path.join(pk, d, 'LocalCache', 'Local', 'Arc', 'User Data'));
  } catch {
    return [];
  }
}

function readJson(file) {
  try {
    const st = statSync(file);
    if (!st.isFile() || st.size > MAX_FILE) return null;
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Profiles of one Chromium user-data dir: [{key, name, dir, last}] (Opera keeps one profile in the root). */
function chromiumProfilesIn(root) {
  if (!existsSync(root)) return [];
  const state = readJson(path.join(root, 'Local State'));
  const cache = (state && state.profile && state.profile.info_cache) || {};
  const last = state && state.profile && state.profile.last_used;
  const keys = new Set(Object.keys(cache));
  try {
    for (const d of readdirSync(root)) if (d === 'Default' || /^Profile \d+$/.test(d)) keys.add(d);
  } catch {
    /* unreadable */
  }
  const out = [];
  for (const key of keys) {
    if (typeof key !== 'string' || key.includes('..') || /[\\/]/.test(key) || /^(System|Guest) Profile$/.test(key)) continue;
    const dir = path.join(root, key);
    const info = cache[key] || {};
    out.push({ key, name: String(info.name || info.gaia_name || (key === 'Default' ? 'Default' : key)), dir, last: key === last });
  }
  if (!out.some((p) => hasChromiumData(p.dir)) && hasChromiumData(root)) out.push({ key: '', name: 'Default', dir: root, last: true });
  return out.filter((p) => hasChromiumData(p.dir)).sort((a, b) => (b.last - a.last) || (a.key === 'Default' ? -1 : b.key === 'Default' ? 1 : a.key.localeCompare(b.key, undefined, { numeric: true })));
}

function hasChromiumData(dir) {
  return existsSync(path.join(dir, 'Bookmarks')) || existsSync(path.join(dir, 'History'));
}

/** Minimal INI reader for Firefox profiles.ini / installs.ini. */
export function parseIni(text) {
  const out = {};
  let sec = null;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line[0] === ';' || line[0] === '#') continue;
    const m = /^\[(.+)\]$/.exec(line);
    if (m) {
      sec = out[m[1]] = out[m[1]] || {};
      continue;
    }
    const eq = line.indexOf('=');
    if (sec && eq > 0) sec[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return out;
}

/** Profiles of one Firefox-family root (the folder holding profiles.ini). */
function firefoxProfilesIn(root) {
  let ini;
  try {
    ini = parseIni(readFileSync(path.join(root, 'profiles.ini'), 'utf8'));
  } catch {
    return [];
  }
  const installDefaults = new Set(Object.entries(ini).filter(([k]) => /^Install/i.test(k)).map(([, v]) => v.Default).filter(Boolean));
  const out = [];
  for (const [sec, v] of Object.entries(ini)) {
    if (!/^Profile\d+$/i.test(sec) || !v.Path) continue;
    const dir = v.IsRelative === '0' ? path.normalize(v.Path) : path.join(root, ...v.Path.split(/[\\/]/));
    if (!existsSync(path.join(dir, 'places.sqlite'))) continue;
    // The [Install…] default is the profile that installation really uses; Default=1 is legacy.
    out.push({ key: v.Path, name: v.Name || path.basename(dir), dir, last: installDefaults.has(v.Path) ? 2 : v.Default === '1' ? 1 : 0 });
  }
  return out.sort((a, b) => b.last - a.last || a.name.localeCompare(b.name));
}

/**
 * Every importable browser profile on this machine.
 * @returns {Array<{id: string, browser: string, browserName: string, kind: 'chromium'|'firefox', profile: string, name: string, dir: string, bookmarks: boolean, history: boolean}>}
 */
export function listSources(browsers = knownBrowsers()) {
  const out = [];
  for (const b of browsers) {
    const seen = new Set();
    const profiles = [];
    for (const dir of b.dirs) {
      for (const p of b.kind === 'firefox' ? firefoxProfilesIn(dir) : chromiumProfilesIn(dir)) {
        if (seen.has(p.dir)) continue;
        seen.add(p.dir);
        profiles.push(p);
      }
    }
    const many = profiles.length > 1;
    profiles.forEach((p, i) => {
      const bookmarks = b.kind === 'firefox' ? true : existsSync(path.join(p.dir, 'Bookmarks'));
      const history = b.kind === 'firefox' ? true : existsSync(path.join(p.dir, 'History'));
      out.push({
        id: i === 0 ? b.browser : `${b.browser}:${p.key}`,
        browser: b.browser,
        browserName: b.name,
        kind: b.kind,
        profile: p.name,
        name: many ? `${b.name} (${p.name})` : b.name,
        dir: p.dir,
        bookmarks,
        history,
      });
    });
  }
  return out;
}

/** Sources as shown to pages (no file system paths). */
export function importSources() {
  return listSources().map(({ dir, ...s }) => {
    void dir;
    return s;
  });
}

function findSource(id) {
  const s = listSources().find((x) => x.id === id);
  if (!s) throw new Error('That browser profile was not found on this computer.');
  return s;
}

// ------------------------------------------------------------------------- SQLite copies

/**
 * Copies a (possibly locked, WAL-mode) SQLite database and its -wal file to a private temp folder,
 * opens the copy and runs fn(db). The original is never opened.
 */
export function withDatabaseCopy(file, fn) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ludworks-import-'));
  try {
    const copy = path.join(dir, 'db.sqlite');
    try {
      copyFileSync(file, copy);
      if (existsSync(`${file}-wal`)) copyFileSync(`${file}-wal`, `${copy}-wal`);
    } catch (e) {
      throw Object.assign(new Error('Could not read that browser’s data. Close the browser and try again.'), { code: 'locked', cause: e });
    }
    // Read-write on our own copy so SQLite can fold the -wal file in.
    const db = new DatabaseSync(copy);
    try {
      return fn(db);
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------------------------- Chromium

function convertChromiumNode(n, depth, budget) {
  if (!n || depth > 32 || budget.n <= 0) return null;
  if (n.type === 'url' && typeof n.url === 'string') {
    budget.n--;
    return { type: 'url', title: String(n.name || ''), url: n.url };
  }
  if (n.type === 'folder') return { type: 'folder', title: String(n.name || 'Folder'), children: (Array.isArray(n.children) ? n.children : []).map((c) => convertChromiumNode(c, depth + 1, budget)).filter(Boolean) };
  return null;
}

/** Chromium "Bookmarks" JSON → {toolbar: nodes, other: nodes}. */
export function parseChromiumBookmarks(text) {
  const j = JSON.parse(text);
  const r = (j && j.roots) || {};
  const budget = { n: MAX_NODES };
  const kids = (root) => ((root && Array.isArray(root.children) && root.children) || []).map((c) => convertChromiumNode(c, 0, budget)).filter(Boolean);
  const mobile = kids(r.synced);
  return { toolbar: kids(r.bookmark_bar), other: [...kids(r.other), ...(mobile.length ? [{ type: 'folder', title: 'Mobile bookmarks', children: mobile }] : [])] };
}

/** Read up to `limit` URLs visited in the last `days` days from a Chromium History database. */
export function readChromiumHistory(file, { days = 90, limit = 20000 } = {}) {
  return withDatabaseCopy(file, (db) => {
    // WebKit timestamps are µs since 1601 (~1.3e16): beyond JS's safe integers, so they are bound
    // as BigInt and divided down to ms inside SQLite.
    const since = BigInt(Date.now() - days * 86400000 + WEBKIT_EPOCH_MS) * 1000n;
    const rows = db.prepare('SELECT id, url, title, typed_count FROM urls WHERE last_visit_time > ? AND hidden = 0 ORDER BY last_visit_time DESC LIMIT ?').all(since, limit);
    const visits = db.prepare('SELECT visit_time / 1000 AS ms FROM visits WHERE url = ? ORDER BY visit_time DESC LIMIT 30');
    return rows
      .filter((r) => /^https?:/i.test(r.url))
      .map((r) => ({
        url: r.url,
        title: r.title || '',
        typed: r.typed_count > 0,
        visits: visits.all(r.id).map((v) => Number(v.ms) - WEBKIT_EPOCH_MS).filter((t) => t > 0),
      }));
  });
}

/** Favicons of bookmarked pages from a Chromium "Favicons" database: [{url, data}] (data: URLs). */
export function readChromiumFavicons(file, pageUrls, { limit = 2000 } = {}) {
  if (!existsSync(file) || !pageUrls.length) return [];
  return withDatabaseCopy(file, (db) => {
    const q = db.prepare(
      `SELECT b.image_data AS data FROM icon_mapping m JOIN favicon_bitmaps b ON b.icon_id = m.icon_id
       WHERE m.page_url = ? AND b.image_data IS NOT NULL ORDER BY abs(b.width - 32) LIMIT 1`,
    );
    return iconRows(pageUrls, limit, (u) => q.get(u));
  });
}

function iconRows(pageUrls, limit, lookup) {
  const out = [];
  const hosts = new Set();
  for (const url of pageUrls) {
    if (out.length >= limit) break;
    let host;
    try {
      host = new URL(url).hostname;
    } catch {
      continue;
    }
    if (hosts.has(host)) continue;
    const r = lookup(url);
    const buf = r && r.data ? Buffer.from(r.data) : null;
    if (!buf || buf.length < 8 || buf.length > 6000) continue;
    const type = buf[0] === 0x89 && buf[1] === 0x50 ? 'png' : buf[0] === 0xff && buf[1] === 0xd8 ? 'jpeg' : buf[0] === 0x47 && buf[1] === 0x49 ? 'gif' : buf.subarray(0, 4).toString('latin1') === 'RIFF' ? 'webp' : /^\s*</.test(buf.subarray(0, 64).toString('latin1')) ? 'svg+xml' : buf[0] === 0 && buf[1] === 0 && buf[2] === 1 ? 'x-icon' : null;
    if (!type) continue;
    hosts.add(host);
    out.push({ url, data: `data:image/${type};base64,${buf.toString('base64')}` });
  }
  return out;
}

// -------------------------------------------------------------------------------- Firefox

const FF_ROOTS = { toolbar: 'toolbar_____', menu: 'menu________', unfiled: 'unfiled_____', mobile: 'mobile______' };

/** Bookmarks from an open Firefox places database → {toolbar: nodes, other: nodes}. */
export function firefoxBookmarksFrom(db) {
  const rows = db
    .prepare('SELECT b.id, b.type, b.parent, b.position, b.title, b.guid, p.url FROM moz_bookmarks b LEFT JOIN moz_places p ON p.id = b.fk ORDER BY b.parent, b.position, b.id')
    .all();
  const kids = new Map();
  const byGuid = new Map();
  for (const r of rows) {
    if (!kids.has(r.parent)) kids.set(r.parent, []);
    kids.get(r.parent).push(r);
    if (r.guid) byGuid.set(r.guid, r);
  }
  let budget = MAX_NODES;
  const convert = (parentId, depth, seen) => {
    const out = [];
    if (depth > 32) return out;
    for (const r of kids.get(parentId) || []) {
      if (budget <= 0) break;
      if (r.type === 2) {
        if (seen.has(r.id)) continue;
        out.push({ type: 'folder', title: String(r.title || 'Folder'), children: convert(r.id, depth + 1, new Set([...seen, r.id])) });
      } else if (r.type === 1 && typeof r.url === 'string' && r.url && !/^place:/i.test(r.url)) {
        budget--;
        out.push({ type: 'url', title: String(r.title || ''), url: r.url });
      }
    }
    return out;
  };
  const rootKids = (guid) => {
    const r = byGuid.get(guid);
    return r ? convert(r.id, 0, new Set([r.id])) : [];
  };
  const menu = rootKids(FF_ROOTS.menu);
  const mobile = rootKids(FF_ROOTS.mobile);
  return {
    toolbar: rootKids(FF_ROOTS.toolbar),
    other: [...(menu.length ? [{ type: 'folder', title: 'Bookmarks Menu', children: menu }] : []), ...rootKids(FF_ROOTS.unfiled), ...(mobile.length ? [{ type: 'folder', title: 'Mobile bookmarks', children: mobile }] : [])],
  };
}

/** History from an open Firefox places database (same shape as readChromiumHistory). */
export function firefoxHistoryFrom(db, { days = 90, limit = 20000 } = {}) {
  const since = (Date.now() - days * 86400000) * 1000; // µs since 1970
  const rows = db.prepare('SELECT id, url, title, typed, last_visit_date FROM moz_places WHERE last_visit_date > ? AND hidden = 0 ORDER BY last_visit_date DESC LIMIT ?').all(since, limit);
  const visits = db.prepare('SELECT visit_date FROM moz_historyvisits WHERE place_id = ? ORDER BY visit_date DESC LIMIT 30');
  return rows
    .filter((r) => /^https?:/i.test(r.url))
    .map((r) => ({
      url: r.url,
      title: r.title || '',
      typed: r.typed > 0,
      visits: visits.all(r.id).map((v) => Math.round(Number(v.visit_date) / 1000)).filter((t) => t > 0),
    }));
}

/** Favicons for page URLs from a Firefox favicons.sqlite database. */
export function readFirefoxFavicons(file, pageUrls, { limit = 2000 } = {}) {
  if (!existsSync(file) || !pageUrls.length) return [];
  return withDatabaseCopy(file, (db) => {
    const q = db.prepare(
      `SELECT i.data AS data FROM moz_pages_w_icons p JOIN moz_icons_to_pages ip ON ip.page_id = p.id JOIN moz_icons i ON i.id = ip.icon_id
       WHERE p.page_url = ? AND i.data IS NOT NULL ORDER BY abs(i.width - 32) LIMIT 1`,
    );
    return iconRows(pageUrls, limit, (u) => q.get(u));
  });
}

// ----------------------------------------------------------------------------- one source

function countNodes(nodes) {
  let bookmarks = 0;
  let folders = 0;
  const walk = (list) => {
    for (const n of list) {
      if (n.type === 'folder') {
        folders++;
        walk(n.children || []);
      } else bookmarks++;
    }
  };
  walk(nodes);
  return { bookmarks, folders };
}

function urlsOf(nodes, out = []) {
  for (const n of nodes) {
    if (n.type === 'folder') urlsOf(n.children || [], out);
    else out.push(n.url);
  }
  return out;
}

/** Bookmarks of a source → {toolbar, other} (throws a friendly error when it cannot be read). */
function bookmarksOf(s) {
  if (s.kind === 'firefox') return withDatabaseCopy(path.join(s.dir, 'places.sqlite'), firefoxBookmarksFrom);
  const f = path.join(s.dir, 'Bookmarks');
  if (!existsSync(f)) return { toolbar: [], other: [] };
  return parseChromiumBookmarks(readSmallFile(f).toString('utf8'));
}

/** Counts for the import dialog. */
export function inspectSource(id) {
  const s = findSource(id);
  const bm = bookmarksOf(s);
  const c = countNodes([...bm.toolbar, ...bm.other]);
  return { id: s.id, name: s.name, bookmarks: c.bookmarks, folders: c.folders, history: s.history };
}

/**
 * Everything needed to import one source; history and favicons are read lazily.
 * @returns {{name: string, browserName: string, bookmarks: {toolbar: any[], other: any[]}|null, history: (() => any[])|null, favicons: ((urls: string[]) => Array<{url: string, data: string}>)}}
 */
export function loadFromBrowser(id) {
  const s = findSource(String(id));
  return {
    name: s.name,
    browserName: s.browserName,
    bookmarks: s.bookmarks ? bookmarksOf(s) : null,
    history: s.history ? () => (s.kind === 'firefox' ? withDatabaseCopy(path.join(s.dir, 'places.sqlite'), (db) => firefoxHistoryFrom(db)) : readChromiumHistory(path.join(s.dir, 'History'))) : null,
    favicons: (urls) => (s.kind === 'firefox' ? readFirefoxFavicons(path.join(s.dir, 'favicons.sqlite'), urls) : readChromiumFavicons(path.join(s.dir, 'Favicons'), urls)),
  };
}

export { urlsOf, countNodes };

// ------------------------------------------------------------------------- Netscape HTML format
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function decodeEntities(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : '';
    }
    return ENT[e.toLowerCase()] ?? m;
  });
}

/** Parse a Netscape bookmark file (what Chrome/Edge/Firefox/Safari export). */
export function parseBookmarksHtml(html) {
  if (html.length > MAX_FILE) throw new Error('File too large.');
  const root = { type: 'folder', title: '', children: [] };
  const stack = [root];
  let pendingFolder = null;
  const re = /<(\/?)(dl|h3|a)\b([^>]*)>([^<]*)/gi;
  let m;
  while ((m = re.exec(html))) {
    const [, close, tagRaw, attrs, text] = m;
    const tag = tagRaw.toLowerCase();
    const top = stack[stack.length - 1];
    if (tag === 'h3' && !close) {
      pendingFolder = { type: 'folder', title: decodeEntities(text.trim()) || 'Folder', children: [] };
      top.children.push(pendingFolder);
    } else if (tag === 'dl' && !close) {
      if (pendingFolder && stack.length < 40) stack.push(pendingFolder);
      else if (stack.length < 40 && top !== root) stack.push(top);
      pendingFolder = null;
    } else if (tag === 'dl' && close) {
      if (stack.length > 1) stack.pop();
    } else if (tag === 'a' && !close) {
      const href = /\bhref\s*=\s*"([^"]*)"/i.exec(attrs) || /\bhref\s*=\s*'([^']*)'/i.exec(attrs);
      if (href) top.children.push({ type: 'url', title: decodeEntities(text.trim()), url: decodeEntities(href[1]) });
    }
  }
  // Exports usually wrap everything in one top-level folder per root ("Bookmarks bar", "Other").
  return root.children;
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Netscape bookmark HTML from the bookmark tree (Bookmarks.tree()). */
export function toBookmarksHtml(tree) {
  const lines = ['<!DOCTYPE NETSCAPE-Bookmark-file-1>', '<!-- This is an automatically generated file. It will be read and overwritten. DO NOT EDIT! -->', '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">', '<TITLE>Bookmarks</TITLE>', '<H1>Bookmarks</H1>', '<DL><p>'];
  const walk = (nodes, depth) => {
    const pad = '    '.repeat(depth);
    for (const n of nodes) {
      const add = Math.floor(Date.parse(n.created_at || '') / 1000) || '';
      if (n.type === 'folder') {
        lines.push(`${pad}<DT><H3${add ? ` ADD_DATE="${add}"` : ''}${n.id === 'toolbar' ? ' PERSONAL_TOOLBAR_FOLDER="true"' : ''}>${esc(n.title)}</H3>`, `${pad}<DL><p>`);
        walk(n.children || [], depth + 1);
        lines.push(`${pad}</DL><p>`);
      } else lines.push(`${pad}<DT><A HREF="${esc(n.url)}"${add ? ` ADD_DATE="${add}"` : ''}>${esc(n.title)}</A>`);
    }
  };
  walk([tree.toolbar, tree.other, tree.mobile].filter((r) => r && r.children && r.children.length), 1);
  lines.push('</DL><p>', '');
  return lines.join('\n');
}

export function readSmallFile(p) {
  const st = statSync(p);
  if (st.size > MAX_FILE) throw new Error('File too large (64 MB max).');
  return readFileSync(p);
}
