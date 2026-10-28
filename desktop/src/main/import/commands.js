// import.* / export.* commands for the internal pages (passwords, bookmarks, settings, welcome).
// Files are only ever read from / written to paths the user picked in a native dialog.

import { dialog, BrowserWindow } from 'electron';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { vaultImportExport } from './vault-commands.js';
import { importSources, inspectSource, loadFromBrowser, parseBookmarksHtml, parseChromiumBookmarks, toBookmarksHtml, readSmallFile, urlsOf } from './browsers.js';
import { MAX_VISITS } from '../profile/history.js';

function winOf(tab) {
  return tab && tab.ctl && tab.ctl.win && !tab.ctl.win.isDestroyed() ? tab.ctl.win : BrowserWindow.getFocusedWindow();
}

function ok(value) {
  return { ok: true, value };
}
function fail(e) {
  return { ok: false, error: { code: (e && e.code) || 'error', message: (e && e.message) || String(e) } };
}

/**
 * Bookmarks (+ their favicons) and history from another browser profile. mode 'folder' (default)
 * puts the bookmarks into an "Imported from <browser>" folder on the bookmarks bar; 'merge' adds
 * them to the bar and Other bookmarks directly. Re-importing the same profile adds only what is new.
 */
function importFromBrowser(b, id, a) {
  const src = loadFromBrowser(id);
  const done = { name: src.name, bookmarks: 0, skipped: 0, folders: 0, history: 0, folder: null };
  if (a.bookmarks !== false && src.bookmarks) {
    const { toolbar, other } = src.bookmarks;
    const add = (r) => {
      done.bookmarks += r.added;
      done.skipped += r.skipped;
      done.folders += r.folders;
      return r;
    };
    b.bookmarks.batch(() => {
      if (a.mode === 'merge') {
        add(b.bookmarks.importTree(toolbar, { parent: 'toolbar' }));
        add(b.bookmarks.importTree(other, { parent: 'other' }));
      } else {
        const nodes = toolbar.length ? [...toolbar, ...(other.length ? [{ type: 'folder', title: 'Other bookmarks', children: other }] : [])] : other;
        if (nodes.length) done.folder = add(b.bookmarks.importTree(nodes, { parent: 'toolbar', folderTitle: `Imported from ${src.name}` })).folder;
      }
    });
    try {
      for (const ic of src.favicons(urlsOf([...toolbar, ...other]).slice(0, 20000))) b.bookmarks.noteIcon(ic.url, ic.data, { force: true });
    } catch {
      /* favicons are optional */
    }
  }
  if (a.history !== false && src.history) done.history = importHistory(b, src.history());
  return done;
}

/** Adds the imported visits that history does not have yet. @returns {number} pages added or updated */
function importHistory(b, rows) {
  let pages = 0;
  b.db.tx(() => {
    for (const r of rows) {
      const have = b.db.get('SELECT visits FROM history WHERE url = ?', r.url);
      let known = [];
      try {
        known = have ? JSON.parse(have.visits) : [];
      } catch {
        /* treat as none */
      }
      const seen = new Set(Array.isArray(known) ? known : []);
      const floor = seen.size >= MAX_VISITS ? Math.min(...seen) : -Infinity; // only the newest 30 are kept
      const fresh = r.visits.filter((t) => t > floor && !seen.has(t)).sort((x, y) => x - y);
      for (const at of fresh) b.history.addVisit({ url: r.url, title: r.title, typed: false, at });
      if (fresh.length) pages++;
    }
  });
  return pages;
}

export async function importExportCommand(b, tab, cmd, a) {
  try {
    switch (cmd) {
      // ---------------------------------------------- passwords: import / export (vault-commands.js)
      case 'import.vault.pick':
      case 'import.vault.load':
      case 'import.vault.preview':
      case 'import.vault.commit':
      case 'import.vault.status':
      case 'import.vault.attachments':
      case 'import.vault.cancel':
      case 'export.vault':
        return ok(await vaultImportExport(b, tab, cmd, a));

      // ------------------------------------------------------------------------ bookmarks
      case 'import.sources':
        return ok(importSources());
      case 'import.inspect':
        return ok(inspectSource(String(a.browser)));
      case 'import.browser':
        return ok(importFromBrowser(b, String(a.browser), a));
      case 'import.bookmarks.file': {
        const r = await dialog.showOpenDialog(winOf(tab), { title: 'Import bookmarks', properties: ['openFile'], filters: [{ name: 'Bookmark files', extensions: ['html', 'htm', 'json'] }] });
        if (r.canceled || !r.filePaths[0]) return ok(null);
        const text = readSmallFile(r.filePaths[0]).toString('utf8');
        let nodes;
        if (/^\s*\{/.test(text)) {
          const c = parseChromiumBookmarks(text);
          nodes = [...c.toolbar, ...c.other];
        } else nodes = parseBookmarksHtml(text);
        const res = b.bookmarks.importTree(nodes, { parent: 'other', folderTitle: 'Imported bookmarks' });
        return ok({ bookmarks: res.added, skipped: res.skipped, folders: res.folders, folder: res.folder, name: path.basename(r.filePaths[0]) });
      }
      case 'export.bookmarks': {
        const r = await dialog.showSaveDialog(winOf(tab), { title: 'Export bookmarks', defaultPath: `bookmarks_${new Date().toISOString().slice(0, 10)}.html`, filters: [{ name: 'HTML', extensions: ['html'] }] });
        if (r.canceled || !r.filePath) return ok(null);
        writeFileSync(r.filePath, toBookmarksHtml(b.bookmarks.tree()));
        return ok({ path: r.filePath });
      }
      default:
        throw new Error(`unknown command ${cmd}`);
    }
  } catch (e) {
    return fail(e);
  }
}
