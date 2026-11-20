// Commands available to ludworks:// internal pages (sender frame already checked by the caller).
// Each page may only use its own command group.

import { app, dialog, shell } from 'electron';
import { ENGINES, currentEngine, validTemplate } from './search.js';
import { log } from './util/log.js';
import { bookmarkUrl } from './profile/bookmarks.js';

const ALLOWED = {
  newtab: ['newtab.'],
  settings: ['prefs.', 'engines', 'theme', 'data.', 'site.', 'default-browser.', 'import.', 'about'],
  passwords: ['vault.', 'account.', 'import.', 'export.', 'prefs.', 'theme'],
  bookmarks: ['bookmarks.', 'theme', 'import.', 'export.'],
  history: ['history.', 'theme'],
  downloads: ['downloads.', 'theme'],
  about: ['about', 'theme'],
  welcome: ['prefs.', 'engines', 'theme', 'import.', 'default-browser.', 'account.'],
  sync: ['account.', 'prefs.', 'theme', 'sync.'],
};

function themeOf(browser) {
  return browser.prefs.get('theme');
}

// bookmarks.*: a selection of ids and an insertion point (before a sibling id, or an index)
const idsOf = (a) => (Array.isArray(a.ids) ? a.ids : [a.id]).filter((x) => typeof x === 'string').slice(0, 100000);
const placeOf = (a) => ({ before: typeof a.before === 'string' && a.before ? a.before : undefined, position: Number.isInteger(a.position) ? a.position : undefined });

/**
 * @param {import('./browser.js').Browser} browser
 * @param {import('./tab.js').Tab} tab
 * @param {string} page
 * @param {string} cmd
 * @param {any} a
 */
export async function pageCommand(browser, tab, page, cmd, a) {
  const b = browser;
  const feature = b.features.find((f) => f.pagePrefix && cmd.startsWith(f.pagePrefix));
  if (feature) {
    if (!(feature.pages || []).includes(page)) throw new Error('not allowed');
    return feature.pageCommand(tab, cmd, a || {});
  }
  if (!(ALLOWED[page] || []).some((p) => (p.endsWith('.') ? cmd.startsWith(p) : cmd === p))) throw new Error('not allowed');
  switch (cmd) {
    // ------------------------------------------------------------------- new tab
    case 'newtab.data':
      return {
        theme: themeOf(b),
        chromeTheme: tab.private || !b.themes ? null : b.themes.shellTheme('ludworks://newtab'),
        engine: b.engine().name,
        topSites: tab.private ? [] : b.history.topSites(8),
        server: b.account.serverUrl ? b.account.serverUrl() : null,
        private: !!tab.private,
      };
    case 'newtab.go':
      b.navigateFromOmnibox(tab.ctl, String(a.text || '').slice(0, 2048), 'current');
      return null;
    case 'theme':
      return themeOf(b);

    // -------------------------------------------------------------------- prefs
    case 'prefs.get':
      return { prefs: b.prefs.all(), engines: Object.entries(ENGINES).map(([id, e]) => ({ id, name: e.name })), engine: currentEngine(b.prefs.all()) };
    case 'prefs.set':
      if (a.patch && typeof a.patch === 'object' && a.patch.customSearch && !validTemplate(a.patch.customSearch.url)) throw new Error('The custom search URL must be an http(s) URL containing %s');
      b.prefs.update(a.patch || {});
      return b.prefs.all();
    case 'engines':
      return Object.entries(ENGINES).map(([id, e]) => ({ id, name: e.name }));

    // ------------------------------------------------------------- browsing data
    case 'data.clear': {
      const what = a.what || {};
      const ses = b.session;
      const since = Number.isFinite(a.since) ? a.since : 0;
      if (what.history) {
        if (since > 0) b.history.removeRange(since, Date.now());
        else b.history.clearAll();
      }
      if (what.cookies) await ses.clearStorageData({ storages: ['cookies', 'localstorage', 'indexdb', 'serviceworkers', 'cachestorage', 'shadercache', 'websql', 'filesystem'] });
      if (what.cache) {
        await ses.clearCache();
        await ses.clearCodeCaches({});
      }
      if (what.downloads) b.downloads.clear();
      if (what.permissions) for (const p of b.permissions.all()) b.permissions.clearOrigin(p.origin);
      return { ok: true };
    }
    case 'site.list':
      return b.permissions.all();
    case 'site.clear':
      b.permissions.clearOrigin(String(a.origin || ''));
      return b.permissions.all();

    // ---------------------------------------------------------------- default browser
    case 'default-browser.status':
      return b.defaultBrowser ? b.defaultBrowser.status() : { supported: false };
    case 'default-browser.open':
      if (b.defaultBrowser) return b.defaultBrowser.openSystemSettings();
      return null;

    // ------------------------------------------------------------------- history
    case 'history.list':
      return b.history.list({ text: String(a.text || '').slice(0, 200), before: Number.isSafeInteger(a.before) ? a.before : null, limit: 150 });
    case 'history.remove':
      if (Array.isArray(a.urls)) b.history.remove(a.urls.filter((u) => typeof u === 'string').slice(0, 1000));
      return null;
    case 'history.clear':
      b.history.clearAll();
      return null;
    case 'history.open':
      if (typeof a.url === 'string') b.openIn(tab.ctl, a.url, a.newTab ? 'new-tab' : 'current');
      return null;

    // ----------------------------------------------------------------- downloads
    case 'downloads.list':
      return b.downloads.list(200);
    case 'downloads.act':
      b.downloads.action(String(a.id), String(a.act));
      return b.downloads.list(200);
    case 'downloads.clear':
      b.downloads.clear();
      return [];

    // ----------------------------------------------------------------- bookmarks
    case 'bookmarks.tree':
      return b.bookmarks.tree();
    case 'bookmarks.data': // compact snapshot for the bookmark manager
      return { ...b.bookmarks.flat(), version: b.bookmarks.version, undo: b.bookmarks.undoInfo() };
    case 'bookmarks.icons':
      return b.bookmarks.allIcons();
    case 'bookmarks.add': {
      const type = a.type === 'folder' ? 'folder' : 'url';
      const url = type === 'url' ? bookmarkUrl(a.url) : '';
      const title = String(a.title || '').trim() || (type === 'url' ? b.historyTitle(url) : '');
      return b.bookmarks.add({ parent: String(a.parent || 'other'), type, title, url, ...placeOf(a) });
    }
    case 'bookmarks.update': {
      const n = b.bookmarks.get(String(a.id));
      if (!n) throw new Error('That bookmark no longer exists.');
      b.bookmarks.update(n.id, { title: typeof a.title === 'string' ? a.title : undefined, url: n.type === 'url' && typeof a.url === 'string' ? bookmarkUrl(a.url) : undefined });
      return null;
    }
    case 'bookmarks.move':
      return b.bookmarks.moveMany(idsOf(a), { parent: String(a.parent), ...placeOf(a) });
    case 'bookmarks.copy':
      return b.bookmarks.copyMany(idsOf(a), { parent: String(a.parent), ...placeOf(a) });
    case 'bookmarks.remove':
      return b.bookmarks.removeMany(idsOf(a));
    case 'bookmarks.sort':
      return b.bookmarks.sortFolder(String(a.id));
    case 'bookmarks.undo':
      return b.bookmarks.undo();
    case 'bookmarks.open': {
      // Bookmarklets never run from here: they would execute inside this internal page.
      const urls = (Array.isArray(a.urls) ? a.urls : [a.url]).filter((u) => typeof u === 'string' && u && !/^javascript:/i.test(u)).slice(0, 500);
      const disposition = a.newTab ? 'new-tab' : ['current', 'new-tab', 'background-tab', 'new-window', 'private-window'].includes(a.disposition) ? a.disposition : 'current';
      await b.openBookmarks(tab.ctl, urls, disposition);
      return null;
    }

    // -------------------------------------------------------------------- about
    case 'about':
      return {
        version: app.getVersion(),
        electron: process.versions.electron,
        chrome: process.versions.chrome,
        node: process.versions.node,
        v8: process.versions.v8,
        platform: `${process.platform} ${process.arch}`,
        drm: b.drmStatus || null,
        profile: b.profileDir,
        theme: themeOf(b),
      };

    default:
      if (cmd.startsWith('import.') || cmd.startsWith('export.')) {
        const { importExportCommand } = await import('./import/commands.js');
        return importExportCommand(b, tab, cmd, a);
      }
      if (cmd.startsWith('account.') || cmd.startsWith('vault.') || cmd.startsWith('sync.')) return b.account.pageCommand(tab, cmd, a);
      log.debug('unknown page command', { cmd });
      throw new Error(`unknown command ${cmd}`);
  }
}

export { dialog, shell };
