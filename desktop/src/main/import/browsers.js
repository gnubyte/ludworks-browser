// Import bookmarks and history from other Chromium browsers on this machine (Edge, Chrome, Brave,
// Vivaldi), and Netscape bookmark HTML files (exported by every browser). Passwords are not read from
// other browsers' stores: export them as CSV there and import the CSV (vault-io.js).

import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MAX_FILE = 64 * 1024 * 1024;

function chromiumProfiles() {
  const home = os.homedir();
  const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  const roots =
    process.platform === 'win32'
      ? [['edge', 'Microsoft Edge', path.join(local, 'Microsoft', 'Edge', 'User Data')], ['chrome', 'Google Chrome', path.join(local, 'Google', 'Chrome', 'User Data')], ['brave', 'Brave', path.join(local, 'BraveSoftware', 'Brave-Browser', 'User Data')], ['vivaldi', 'Vivaldi', path.join(local, 'Vivaldi', 'User Data')]]
      : process.platform === 'darwin'
        ? [['edge', 'Microsoft Edge', path.join(home, 'Library', 'Application Support', 'Microsoft Edge')], ['chrome', 'Google Chrome', path.join(home, 'Library', 'Application Support', 'Google', 'Chrome')], ['brave', 'Brave', path.join(home, 'Library', 'Application Support', 'BraveSoftware', 'Brave-Browser')]]
        : [['edge', 'Microsoft Edge', path.join(home, '.config', 'microsoft-edge')], ['chrome', 'Google Chrome', path.join(home, '.config', 'google-chrome')], ['chromium', 'Chromium', path.join(home, '.config', 'chromium')], ['brave', 'Brave', path.join(home, '.config', 'BraveSoftware', 'Brave-Browser')]];
  const out = [];
  for (const [id, name, dir] of roots) {
    const prof = path.join(dir, 'Default');
    if (existsSync(path.join(prof, 'Bookmarks')) || existsSync(path.join(prof, 'History'))) out.push({ id, name, dir: prof, bookmarks: existsSync(path.join(prof, 'Bookmarks')), history: existsSync(path.join(prof, 'History')) });
  }
  return out;
}

export function importSources() {
  return chromiumProfiles().map(({ id, name, bookmarks, history }) => ({ id, name, bookmarks, history }));
}

function convertChromiumNode(n, depth = 0) {
  if (!n || depth > 32) return null;
  if (n.type === 'url' && typeof n.url === 'string') return { type: 'url', title: String(n.name || ''), url: n.url };
  if (n.type === 'folder') return { type: 'folder', title: String(n.name || 'Folder'), children: (n.children || []).map((c) => convertChromiumNode(c, depth + 1)).filter(Boolean) };
  return null;
}

/** Chromium "Bookmarks" JSON → {toolbar: nodes, other: nodes}. */
export function parseChromiumBookmarks(text) {
  const j = JSON.parse(text);
  const r = (j && j.roots) || {};
  const kids = (root) => ((root && root.children) || []).map((c) => convertChromiumNode(c)).filter(Boolean);
  return { toolbar: kids(r.bookmark_bar), other: [...kids(r.other), ...kids(r.synced)] };
}

/** Read up to `limit` URLs visited in the last `days` days from a Chromium History database. */
export function readChromiumHistory(file, { days = 90, limit = 20000 } = {}) {
  const tmp = path.join(os.tmpdir(), `ludworks-history-${process.pid}-${Date.now()}.sqlite`);
  copyFileSync(file, tmp); // the source is locked while that browser runs
  try {
    const db = new DatabaseSync(tmp, { readOnly: true });
    try {
      const since = (Date.now() - days * 86400000 + 11644473600000) * 1000; // WebKit µs since 1601
      const rows = db.prepare('SELECT id, url, title, visit_count, typed_count, last_visit_time FROM urls WHERE last_visit_time > ? AND hidden = 0 ORDER BY last_visit_time DESC LIMIT ?').all(since, limit);
      const visits = db.prepare('SELECT visit_time FROM visits WHERE url = ? ORDER BY visit_time DESC LIMIT 30');
      return rows
        .filter((r) => /^https?:/i.test(r.url))
        .map((r) => ({
          url: r.url,
          title: r.title || '',
          typed: r.typed_count > 0,
          visits: visits.all(r.id).map((v) => Math.round(Number(v.visit_time) / 1000 - 11644473600000)).filter((t) => t > 0),
        }));
    } finally {
      db.close();
    }
  } finally {
    rmSync(tmp, { force: true });
  }
}

export function loadFromBrowser(id) {
  const p = chromiumProfiles().find((x) => x.id === id);
  if (!p) throw new Error('That browser was not found on this computer.');
  return {
    name: p.name,
    bookmarks: p.bookmarks ? parseChromiumBookmarks(readFileSync(path.join(p.dir, 'Bookmarks'), 'utf8')) : null,
    history: p.history ? () => readChromiumHistory(path.join(p.dir, 'History')) : null,
  };
}

// ------------------------------------------------------------------------- Netscape HTML format
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
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
