// Chrome themes (Browser.registerFeature): a theme from the Chrome Web Store ("Add to Chrome" on a theme
// page), a .crx/.zip file or an unpacked folder (extensions.js hands theme packages here) recolours the
// tab strip, toolbar, bookmarks bar and new tab page, with its images. One theme at a time, as in Chrome;
// private windows keep their own look. Settings → Appearance shows it and resets to the default.
//
// Files: <profile>/Themes/<id>/<version>/ (manifest, images, _locales only). Images reach the UI through
// lwshell://ui/_theme/<rev>/<path> and ludworks://newtab/_theme/<rev>/<path> (protocols.js themeFile).

import { app } from 'electron';
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { themePalette, safeImagePath } from './chrome-theme.js';
import { writeTree } from '../extensions/unpack.js';
import { localize } from '../extensions/manifest.js';
import { log } from '../util/log.js';

const STORE_URL = 'https://chromewebstore.google.com/category/themes';

export class Themes {
  /** @param {import('../browser.js').Browser} browser */
  constructor(browser) {
    this.name = 'themes';
    this.b = browser;
    this.pagePrefix = 'themes.';
    this.pages = ['settings'];
    this.root = path.join(browser.profileDir, 'Themes');
    this.current = null; // {id, version, dirName, name, source, installedAt}
    this.palette = null;
    this.rev = 0;
    const saved = browser.db.getMeta('chrome_theme', null);
    if (saved && typeof saved.id === 'string' && /^[a-p]{32}$/.test(saved.id) && typeof saved.dirName === 'string' && existsSync(path.join(this.root, saved.id, saved.dirName, 'manifest.json'))) this.load(saved);
  }

  get dir() {
    return this.current ? path.join(this.root, this.current.id, this.current.dirName) : null;
  }

  load(cur) {
    try {
      const dir = path.join(this.root, cur.id, cur.dirName);
      const manifest = JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8').replace(/^﻿/, ''));
      this.current = cur;
      this.palette = themePalette({ ...manifest, name: cur.name || manifest.name });
      this.rev++;
      return true;
    } catch (e) {
      log.warn('theme could not be loaded', { id: cur.id, message: e.message });
      this.current = null;
      this.palette = null;
      return false;
    }
  }

  /**
   * Installs a theme package (from extensions.js: Web Store, file or folder) and shows it at once.
   * @param {{id: string, manifest: any, files: {path: string, data: Buffer}[]}} pkg
   */
  install(pkg, { source = 'webstore' } = {}) {
    const m = pkg.manifest;
    const keep = new Set(['manifest.json']);
    for (const p of Object.values((m.theme && m.theme.images) || {})) {
      const s = safeImagePath(p);
      if (s) keep.add(s);
    }
    const files = pkg.files.filter((f) => keep.has(f.path) || /^_locales\/[A-Za-z_-]+\/messages\.json$/.test(f.path));
    const version = String(m.version || '0');
    let dirName = version;
    for (let n = 1; existsSync(path.join(this.root, pkg.id, dirName)); n++) dirName = `${version}_${n}`;
    writeTree(path.join(this.root, pkg.id, dirName), files);
    const name = localize(String(m.name || 'Theme'), messagesOf(pkg.files, m)) || 'Theme';
    const cur = { id: pkg.id, version, dirName, name: name.slice(0, 100), source, installedAt: Date.now() };
    if (!this.load(cur)) throw new Error('The theme could not be read.');
    this.b.db.setMeta('chrome_theme', cur);
    this.prune();
    log.info('theme installed', { id: pkg.id, name: cur.name, source });
    this.apply();
    return cur;
  }

  reset() {
    this.current = null;
    this.palette = null;
    this.rev++;
    this.b.db.setMeta('chrome_theme', null);
    this.prune();
    this.apply();
  }

  /** Removes every theme folder but the current one. */
  prune() {
    let ids = [];
    try {
      ids = readdirSync(this.root);
    } catch {
      return;
    }
    for (const id of ids) {
      if (this.current && id === this.current.id) {
        for (const d of readdirSync(path.join(this.root, id))) if (d !== this.current.dirName) rmSync(path.join(this.root, id, d), { recursive: true, force: true });
        continue;
      }
      rmSync(path.join(this.root, id), { recursive: true, force: true });
    }
  }

  apply() {
    this.b.forEachWindow((w) => w.applyTheme());
    this.b.broadcastShared();
    for (const w of this.b.windows) for (const t of w.tabs) if (!t.wc.isDestroyed() && /^ludworks:\/\/(newtab|settings)\//.test(t.wc.getURL())) t.wc.send('page-event', { type: 'theme' });
  }

  /** The theme for a window: null for private windows and without a theme. */
  forWindow(ctl) {
    return ctl && ctl.private ? null : this.palette;
  }

  /** What the shell draws with: {rev, name, base, vars, images: {key: url}}. */
  shellTheme(origin = 'lwshell://ui') {
    const p = this.palette;
    if (!p) return null;
    const images = {};
    for (const [k, rel] of Object.entries(p.images)) images[k] = `${origin}/_theme/${this.rev}/${rel.split('/').map(encodeURIComponent).join('/')}`;
    return { rev: this.rev, name: p.name, base: p.base, vars: p.vars, images, ntp: p.ntp };
  }

  /** A theme image for protocols.js: the file under the current theme folder, or null. */
  file(rel) {
    const dir = this.dir;
    const m = /^(\d+)\/(.+)$/.exec(rel || '');
    if (!dir || !m) return null;
    const p = safeImagePath(m[2]);
    if (!p || !this.palette || !Object.values(this.palette.images).includes(p)) return null;
    return path.join(dir, ...p.split('/'));
  }

  async pageCommand(_tab, cmd) {
    switch (cmd) {
      case 'themes.state':
        return { theme: this.current ? { name: this.current.name, id: this.current.id, source: this.current.source, installedAt: this.current.installedAt, base: this.palette.base, frame: this.palette.vars['--frame'], toolbar: this.palette.vars['--toolbar'] } : null, store: STORE_URL };
      case 'themes.reset':
        this.reset();
        return { ok: true };
      case 'themes.store':
        this.b.openUrls([STORE_URL]);
        return { ok: true };
      default:
        throw new Error('not allowed');
    }
  }
}

/** The best locale's messages of a package (for a "__MSG_name__" theme name). */
function messagesOf(files, m) {
  const messages = {};
  if (!m.default_locale) return messages;
  const byPath = new Map(files.map((f) => [f.path, f.data]));
  const loc = String(app.getLocale() || 'en').replace('-', '_');
  for (const c of [...new Set(['en', m.default_locale, loc.split('_')[0], loc])]) {
    const data = byPath.get(`_locales/${c}/messages.json`);
    if (!data) continue;
    try {
      for (const [k, v] of Object.entries(JSON.parse(data.toString('utf8').replace(/^﻿/, '')))) if (v && typeof v.message === 'string') messages[k.toLowerCase()] = v.message;
    } catch {
      /* skip */
    }
  }
  return messages;
}
