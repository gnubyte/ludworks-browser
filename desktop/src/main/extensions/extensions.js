// Chrome extensions (Browser.registerFeature). Installs from the Chrome Web Store (and .crx/.zip files
// or unpacked folders in developer mode) with a permission prompt, keeps them up to date, loads them
// into the default browsing session (never into private windows, like Chrome's default), shows their
// toolbar buttons and popups, the puzzle menu and ludworks://extensions, and adds the parts of the
// extension API that Electron lacks (preload/extensions.cjs + api.js).
//
//   <profile>/Extensions/<id>/<version>/   installed packages (prepared by installer.js)
//   <profile>/Extensions/_unpacked/<hash>/  working copies of unpacked extensions (developer mode)
//   profile db meta "extensions"            the list (enabled, pinned, source, granted permissions…)
//   profile db meta "extension_state:<id>"  context-menu items and alarms (they survive restarts)

import { app, dialog, Menu, nativeImage, shell } from 'electron';
import path from 'node:path';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import { log } from '../util/log.js';
import { Bridge } from './bridge.js';
import { Api } from './api.js';
import { ActionPopups } from './popup.js';
import * as M from './manifest.js';
import { cssColor } from './manifest.js';
import * as I from './installer.js';
import { storeItemId, storePageUrl, updateCheckUrl, parseUpdateResponse, compareVersions, trustedCodebase, STORE_ORIGIN } from './webstore.js';
import { idFromManifestKey, isExtensionId } from './crx.js';
import { dirSize, cleanTemp } from './unpack.js';
import { isThemeManifest } from '../themes/chrome-theme.js';

const META = 'extensions';
const STATE = 'extension_state:';
const UPDATE_EVERY = 24 * 3600 * 1000;
const FIRST_UPDATE_DELAY = 2 * 60 * 1000;
const MAX_FILE = 160 * 1024 * 1024;
const MAX_ERRORS = 30;
const ICON_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.bmp': 'image/bmp', '.ico': 'image/x-icon' };
// Permissions only our own API code checks: granting them needs no reload of the extension.
const SHIM_PERMISSIONS = new Set(['contextMenus', 'menus', 'notifications', 'cookies', 'alarms', 'webNavigation', 'activeTab', 'tabs']);

const sanitize = (it) => ({
  id: it.id,
  version: typeof it.version === 'string' ? it.version : '0',
  dirName: typeof it.dirName === 'string' && /^[\w.-]{1,40}$/.test(it.dirName) ? it.dirName : null,
  source: ['webstore', 'crx', 'zip', 'unpacked'].includes(it.source) ? it.source : 'webstore',
  path: typeof it.path === 'string' ? it.path : null,
  devKey: typeof it.devKey === 'string' ? it.devKey : null,
  enabled: it.enabled !== false,
  pinned: !!it.pinned,
  installedAt: Number(it.installedAt) || Date.now(),
  updatedAt: Number(it.updatedAt) || 0,
  granted: { permissions: Array.isArray(it.granted && it.granted.permissions) ? it.granted.permissions.filter((x) => typeof x === 'string') : [], origins: Array.isArray(it.granted && it.granted.origins) ? it.granted.origins.filter((x) => typeof x === 'string') : [] },
  lazyEvents: Array.isArray(it.lazyEvents) ? it.lazyEvents.filter((x) => typeof x === 'string').slice(0, 200) : [],
  uninstallUrl: typeof it.uninstallUrl === 'string' ? it.uninstallUrl : '',
  lastUpdateCheck: Number(it.lastUpdateCheck) || 0,
  updateError: typeof it.updateError === 'string' ? it.updateError : null,
  pendingUpdate: it.pendingUpdate && typeof it.pendingUpdate === 'object' ? { version: String(it.pendingUpdate.version || ''), newPermissions: Array.isArray(it.pendingUpdate.newPermissions) ? it.pendingUpdate.newPermissions.map(String) : [] } : null,
  error: typeof it.error === 'string' ? it.error : null,
});

export class Extensions {
  /** @param {import('../browser.js').Browser} browser */
  constructor(browser) {
    this.b = browser;
    this.name = 'extensions';
    this.popups = ['extensions'];
    this.pagePrefix = 'extensions.';
    this.pages = ['extensions', 'settings'];
    this.root = path.join(browser.profileDir, 'Extensions');
    this.preloadFile = path.join(browser.appDir, 'preload', 'extensions.cjs');
    const s = browser.db.getMeta(META, null) || {};
    this.settings = { devMode: !!s.devMode, autoUpdate: s.autoUpdate !== false, lastCheck: Number(s.lastCheck) || 0 };
    this.items = new Map();
    for (const it of Array.isArray(s.items) ? s.items : []) if (it && isExtensionId(it.id)) this.items.set(it.id, sanitize(it));
    this.loaded = new Map(); // id → runtime info (see runtimeOf)
    this.state = new Map(); // id → {menus: Map, alarms: Map}
    this.errors = new Map(); // id → [{at, message, source}]
    this.installing = new Map(); // store id → promise
    this.busy = new Map(); // store id → label shown on the toolbar while downloading
    this.bridge = new Bridge(this);
    this.api = new Api(this);
    this.views = new ActionPopups(this);
    this.ses = null;
    this.ready = Promise.resolve();
  }

  whenReady(ms) {
    return Promise.race([this.ready, new Promise((r) => setTimeout(r, ms))]);
  }

  // ===================================================================================== setup
  attachSession(ses, hub, { isPrivate }) {
    if (isPrivate || this.ses) return; // Electron cannot load extensions into in-memory sessions
    this.ses = ses;
    // Session preloads: extension service workers and pages (the script itself returns at once anywhere else).
    ses.registerPreloadScript({ type: 'service-worker', id: 'ludworks-extensions-sw', filePath: this.preloadFile });
    ses.registerPreloadScript({ type: 'frame', id: 'ludworks-extensions', filePath: this.preloadFile });
    this.bridge.attachSession(ses);
    this.api.watchCookies(ses);
    this.api.attachWebRequest(hub);
    ses.serviceWorkers.on('console-message', (_e, m) => {
      if (m.level < 3) return;
      const x = /^chrome-extension:\/\/([a-p]{32})\//.exec(m.sourceUrl || '');
      if (x) this.noteError(x[1], String(m.message || '').slice(0, 500), m.sourceUrl);
    });
    this.fetchImpl = (url, init) => ses.fetch(url, { ...init, credentials: 'omit', bypassCustomProtocolHandlers: true });
    this.ready = this.loadAll().catch((e) => log.warn('extensions: start failed', { message: e && e.message }));
  }

  async loadAll() {
    cleanTemp(this.root);
    const list = [...this.items.values()].filter((it) => it.enabled);
    await Promise.all(list.map((it) => this.loadOne(it, { reason: 'startup' })));
    // Developers (unpackaged runs only, never a release build): --load-extension=<folder>[,<folder>…]
    if (this.b.dev) {
      for (const a of process.argv) {
        const m = /^--load-extension=(.+)$/.exec(a);
        if (!m) continue;
        for (const dir of m[1].split(',').map((x) => x.trim()).filter(Boolean)) {
          const r = await this.loadUnpacked(dir);
          if (!r.ok) log.warn('extensions: --load-extension failed', { dir, error: r.error });
        }
      }
    }
    this.api.scheduleAlarms();
    this.refreshToolbar();
    setTimeout(() => this.maybeCheckUpdates(), FIRST_UPDATE_DELAY).unref();
    setInterval(() => this.maybeCheckUpdates(), 3600 * 1000).unref();
  }

  // ================================================================================== registry
  save() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.saveNow(), 200);
  }

  saveNow() {
    clearTimeout(this.saveTimer);
    try {
      this.b.db.setMeta(META, { ...this.settings, items: [...this.items.values()] });
    } catch (e) {
      log.warn('extensions: could not save', { message: e.message });
    }
  }

  item(id) {
    return this.items.get(id) || null;
  }

  /** A chrome-extension:// URL of an installed, loaded extension (not the engine's PDF viewer). */
  isInstalledUrl(url) {
    const m = /^chrome-extension:\/\/([a-p]{32})\//i.exec(String(url || ''));
    return !!(m && this.loaded.has(m[1].toLowerCase()));
  }

  setItem(id, patch) {
    const it = this.items.get(id);
    if (!it) return;
    Object.assign(it, patch);
    this.save();
  }

  dirOf(item) {
    if (item.source === 'unpacked') return I.unpackedCopyDir(this.root, item.path || '');
    return path.join(this.root, item.id, item.dirName || item.version);
  }

  lazyEvents(id) {
    const it = this.items.get(id);
    return it ? it.lazyEvents : [];
  }

  setLazyEvents(id, names) {
    const it = this.items.get(id);
    if (!it) return;
    const next = [...new Set(names)].sort();
    if (next.join('\n') !== it.lazyEvents.join('\n')) {
      it.lazyEvents = next;
      this.save();
    }
    this.api.webRequestListenersChanged();
  }

  hasWorker(id) {
    const ext = this.loaded.get(id);
    return !!(ext && ext.manifest.background && ext.manifest.background.service_worker);
  }

  // ------------------------------------------------------------------- menus + alarms (persisted)
  stateOf(id) {
    let s = this.state.get(id);
    if (!s) {
      const raw = this.b.db.getMeta(STATE + id, null) || {};
      s = { menus: new Map((Array.isArray(raw.menus) ? raw.menus : []).filter((m) => m && (typeof m.id === 'string' || typeof m.id === 'number')).map((m) => [m.id, m])), alarms: new Map(Object.entries(raw.alarms && typeof raw.alarms === 'object' ? raw.alarms : {}).filter(([, a]) => a && Number.isFinite(a.scheduledTime))) };
      this.state.set(id, s);
    }
    return s;
  }

  menusOf(id) {
    return this.stateOf(id).menus;
  }

  alarmsOf(id) {
    return this.stateOf(id).alarms;
  }

  saveState(id) {
    const s = this.stateOf(id);
    clearTimeout(s.timer);
    s.timer = setTimeout(() => {
      try {
        this.b.db.setMeta(STATE + id, { menus: [...s.menus.values()], alarms: Object.fromEntries(s.alarms) });
      } catch (e) {
        log.warn('extensions: could not save state', { message: e.message });
      }
    }, 150);
  }

  saveMenus(id) {
    this.saveState(id);
  }

  saveAlarms(id) {
    this.saveState(id);
  }

  // ============================================================================ loading/unloading
  runtimeOf(item, e, dir) {
    const m = e.manifest || {};
    const original = (I.readOriginal(dir) || {}).manifest || m;
    const messages = M.loadMessages(dir, m, app.getLocale());
    const L = (s) => M.localize(s || '', messages);
    const action = M.actionOf(m);
    return {
      id: e.id,
      item,
      dir,
      manifest: m,
      original,
      messages,
      version: m.version,
      mv: m.manifest_version || 2,
      name: L(m.name) || e.name || e.id,
      shortName: L(m.short_name),
      description: L(m.description),
      apiPerms: new Set(M.apiPermissions(m.permissions)),
      hostPatterns: M.hostPermissions(m),
      csMatches: M.contentScriptMatches(m),
      optional: M.optionalPermissions(original),
      actionDef: action ? { popup: typeof action.default_popup === 'string' ? action.default_popup.replace(/^\/+/, '') : '', title: L(action.default_title), icon: action.default_icon || null } : null,
      options: M.optionsPageOf(m),
      commands: M.manifestCommands(m).map((c) => ({ ...c, description: L(c.description) || (c.name.startsWith('_execute') ? 'Activate the extension' : c.name) })),
      unsupported: M.unsupportedFeatures(original),
      action: { global: {}, tabs: new Map() },
      iconCache: new Map(),
    };
  }

  /** Loads one extension into the session. reason: startup | install | update | enable | reload. */
  async loadOne(item, { reason = 'startup', previousVersion = null } = {}) {
    if (!this.ses) return null;
    const dir = this.dirOf(item);
    if (!existsSync(path.join(dir, 'manifest.json'))) {
      item.error = 'The extension files are missing. Remove it and install it again.';
      this.save();
      return null;
    }
    let e;
    try {
      I.refreshPrepared(dir, { shim: I.contentShim(this.preloadFile), granted: item.granted });
    } catch (err) {
      log.warn('extensions: could not refresh package', { id: item.id, message: err.message });
    }
    try {
      e = await this.ses.extensions.loadExtension(dir, { allowFileAccess: false });
    } catch (err) {
      item.error = String(err && err.message ? err.message : err).replace(/^Loading extension at .*? failed with: /, '');
      this.noteError(item.id, `Could not load: ${item.error}`);
      this.save();
      return null;
    }
    if (e.id !== item.id) {
      try {
        this.ses.extensions.removeExtension(e.id);
      } catch {
        /* ignore */
      }
      item.error = 'The extension ID does not match its package.';
      this.save();
      return null;
    }
    item.error = null;
    const ext = this.runtimeOf(item, e, dir);
    this.loaded.set(ext.id, ext);
    this.stateOf(ext.id);
    if (reason === 'install' || reason === 'update') this.bridge.emitToBackground(ext.id, 'runtime.onInstalled', [reason === 'install' ? { reason: 'install' } : { reason: 'update', previousVersion: previousVersion || '' }]);
    else if (reason === 'startup') this.bridge.emitToBackground(ext.id, 'runtime.onStartup', []);
    this.api.scheduleAlarms();
    this.save();
    this.refreshToolbar();
    this.notifyPages();
    return ext;
  }

  /** Unloads an extension from the session (files stay). */
  unload(id, { closeTabs = false } = {}) {
    this.views.closeExtension(id);
    const urlPrefix = `chrome-extension://${id}/`;
    const tabs = this.b.allTabs().filter((t) => !t.wc.isDestroyed() && t.wc.getURL().startsWith(urlPrefix));
    if (closeTabs) for (const t of tabs) t.ctl.closeTab(t.id);
    if (this.loaded.has(id)) {
      try {
        this.ses.extensions.removeExtension(id);
      } catch (e) {
        log.debug('extensions: unload failed', { id, message: e.message });
      }
    }
    this.loaded.delete(id);
    this.bridge.drop(id);
    this.api.clearNotifications(id);
    this.refreshToolbar();
    return closeTabs ? [] : tabs;
  }

  /** Reloads a loaded extension (after permission changes, developer reload). Its open pages reload too. */
  async reloadExtension(id, { reason = 'reload' } = {}) {
    const item = this.items.get(id);
    if (!item) return null;
    const tabs = this.unload(id);
    const ext = await this.loadOne(item, { reason });
    for (const t of tabs) if (!t.destroyed && !t.wc.isDestroyed()) t.reload();
    return ext;
  }

  // ================================================================================= installing
  /** Package info for the consent prompt (name, icon, what it can do, what will not work). */
  consentData(pkg, { kind = 'install' } = {}) {
    const files = new Map(pkg.files.map((f) => [f.path, f.data]));
    const m = pkg.manifest;
    const messages = {};
    if (m.default_locale) {
      const loc = String(app.getLocale() || 'en').replace('-', '_');
      for (const c of [...new Set(['en', m.default_locale, loc.split('_')[0], loc])]) {
        const data = files.get(`_locales/${c}/messages.json`);
        if (!data) continue;
        try {
          for (const [k, v] of Object.entries(JSON.parse(data.toString('utf8').replace(/^﻿/, '')))) if (v && typeof v.message === 'string') messages[k.toLowerCase()] = v.message;
        } catch {
          /* skip */
        }
      }
    }
    const iconPath = M.pickIcon(m.icons, 48) || M.pickIcon((M.actionOf(m) || {}).default_icon, 48);
    let icon = null;
    if (iconPath) {
      const data = files.get(String(iconPath).replace(/^\/+/, ''));
      const type = ICON_TYPES[path.extname(String(iconPath)).toLowerCase()];
      if (data && type && data.length < 512 * 1024) icon = `data:${type};base64,${data.toString('base64')}`;
    }
    const d = M.describeManifest(m);
    return { kind, id: pkg.id, name: M.localize(m.name, messages), version: m.version, icon, items: d.items, allSites: d.allSites, unsupported: M.unsupportedRequired(m), store: pkg.publisher };
  }

  async confirmInstall(ctl, pkg, kind = 'install') {
    if (!ctl || ctl.destroyed) return false;
    ctl.activate(ctl.activeId);
    const ans = await ctl.ask('ext-install', this.consentData(pkg, { kind }));
    return !!(ans && ans.ok);
  }

  /** Writes a package and loads it (install, reinstall or update), keeping the previous version until the new one loads. */
  async installPackage(pkg, { source }) {
    const id = pkg.id;
    const version = pkg.manifest.version;
    const existing = this.items.get(id);
    if (existing && existing.source === 'unpacked' && source !== 'unpacked') throw new I.InstallError('conflict', 'An unpacked extension with the same ID is loaded. Remove it first.');
    let dirName = version;
    for (let n = 1; existing && existsSync(path.join(this.root, id, dirName)); n++) dirName = `${version}_${n}`;
    const dir = path.join(this.root, id, dirName);
    I.writePackage(dir, pkg, { shim: I.contentShim(this.preloadFile), granted: existing ? existing.granted : null });
    const item = existing || sanitize({ id, source, enabled: true, pinned: false, installedAt: Date.now() });
    const prev = existing ? { dirName: item.dirName, version: item.version, source: item.source } : null;
    const wasLoaded = this.loaded.has(id);
    const tabs = wasLoaded ? this.unload(id) : [];
    Object.assign(item, { dirName, version, source: source === 'crx' && pkg.publisher ? 'webstore' : source, updatedAt: existing ? Date.now() : 0, pendingUpdate: null, updateError: null, enabled: existing ? item.enabled : true });
    if (!existing) this.items.set(id, item);
    const ext = item.enabled ? await this.loadOne(item, { reason: existing ? 'update' : 'install', previousVersion: prev ? prev.version : null }) : null;
    if (item.enabled && !ext) {
      // keep the version that worked
      const err = item.error || 'The extension could not be loaded.';
      I.removeDir(dir);
      if (prev) {
        Object.assign(item, prev);
        if (wasLoaded) await this.loadOne(item, { reason: 'enable' });
      } else this.items.delete(id);
      this.save();
      throw new I.InstallError('load_failed', err);
    }
    if (prev && prev.dirName && prev.dirName !== dirName) I.removeDir(path.join(this.root, id, prev.dirName));
    for (const t of tabs) if (!t.destroyed && !t.wc.isDestroyed()) t.reload();
    this.saveNow();
    this.notifyPages();
    return item;
  }

  /** Web Store install: download, verify, ask, install. */
  installFromStore(ctl, id, { quiet = false } = {}) {
    if (!isExtensionId(id)) return Promise.resolve({ ok: false, error: 'Invalid extension ID.' });
    if (!this.ses || (ctl && ctl.private)) return Promise.resolve({ ok: false, error: 'Extensions are not available in private windows.' });
    if (this.installing.has(id)) return this.installing.get(id);
    const p = (async () => {
      this.busy.set(id, 'Downloading…');
      this.refreshToolbar();
      let pkg;
      try {
        pkg = await I.fetchFromStore(this.fetchImpl, id, process.versions.chrome);
      } catch (e) {
        log.warn('extensions: store download failed', { id, code: e.code, message: e.message });
        if (!quiet) this.showError(ctl, 'Could not add the extension', e.message);
        return { ok: false, error: e.message };
      } finally {
        this.busy.delete(id);
        this.refreshToolbar();
      }
      if (isThemeManifest(pkg.manifest)) return this.installTheme(ctl, pkg, 'webstore', { quiet });
      const existing = this.items.get(id);
      if (existing && existing.version === pkg.manifest.version && this.loaded.has(id)) return { ok: true, id, already: true };
      if (!(await this.confirmInstall(ctl, pkg, existing ? 'update' : 'install'))) return { ok: false, cancelled: true };
      try {
        await this.installPackage(pkg, { source: 'webstore' });
      } catch (e) {
        if (!quiet) this.showError(ctl, 'Could not add the extension', e.message);
        return { ok: false, error: e.message };
      }
      this.afterInstall(ctl, id);
      return { ok: true, id };
    })().finally(() => this.installing.delete(id));
    this.installing.set(id, p);
    return p;
  }

  /** A theme package goes to the themes feature (src/main/themes): shown at once, no permission prompt (as in Chrome). */
  installTheme(ctl, pkg, source, { quiet = false } = {}) {
    try {
      const t = this.b.themes.install(pkg, { source });
      return { ok: true, id: pkg.id, theme: t.name };
    } catch (e) {
      log.warn('extensions: theme install failed', { id: pkg.id, message: e.message });
      if (!quiet) this.showError(ctl, 'Could not add the theme', e.message);
      return { ok: false, error: e.message };
    }
  }

  afterInstall(ctl, id) {
    if (!ctl || ctl.destroyed) return;
    const [cw] = ctl.win.getContentSize();
    ctl.showPopup('extensions', this.menuData(ctl, { added: id }), { x: Math.max(8, cw - 352), y: Math.max(40, ctl.topInset - 4), width: 340 });
  }

  showError(ctl, title, message) {
    const win = ctl && !ctl.destroyed ? ctl.win : undefined;
    dialog.showMessageBox(win, { type: 'warning', title, message: title, detail: String(message || '').slice(0, 800) }).catch(() => {});
  }

  async installFromFile(ctl, file) {
    let buf;
    try {
      if (statSync(file).size > MAX_FILE) throw new I.InstallError('too_large', 'The file is too large.');
      buf = readFileSync(file);
    } catch (e) {
      return { ok: false, error: e.message };
    }
    let pkg;
    try {
      pkg = buf.toString('latin1', 0, 4) === 'Cr24' ? I.openCrx(buf) : I.openZip(buf);
    } catch (e) {
      return { ok: false, error: e.message };
    }
    if (isThemeManifest(pkg.manifest)) return this.installTheme(ctl, pkg, 'file', { quiet: true });
    if (!(await this.confirmInstall(ctl, pkg, this.items.has(pkg.id) ? 'update' : 'install'))) return { ok: false, cancelled: true };
    try {
      await this.installPackage(pkg, { source: buf.toString('latin1', 0, 4) === 'Cr24' ? 'crx' : 'zip' });
    } catch (e) {
      return { ok: false, error: e.message };
    }
    return { ok: true, id: pkg.id };
  }

  /** Developer mode: load (or reload) an unpacked extension from a folder (a working copy is used). */
  async loadUnpacked(src) {
    let pkg;
    try {
      pkg = I.readFolder(src);
    } catch (e) {
      return { ok: false, error: e.message };
    }
    if (isThemeManifest(pkg.manifest)) {
      const key = pkg.key || generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
      return this.installTheme(null, { ...pkg, id: idFromManifestKey(key) }, 'unpacked', { quiet: true });
    }
    const same = [...this.items.values()].find((it) => it.source === 'unpacked' && it.path && path.resolve(it.path).toLowerCase() === path.resolve(src).toLowerCase());
    let key = pkg.key;
    let devKey = null;
    if (!key) {
      devKey = same && same.devKey ? same.devKey : generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
      key = devKey;
    }
    const id = idFromManifestKey(key);
    if (!id) return { ok: false, error: 'The "key" in manifest.json is not a valid public key.' };
    const other = this.items.get(id);
    if (other && other !== same && other.source !== 'unpacked') return { ok: false, error: 'An installed extension has the same ID. Remove it first.' };
    if (same && same.id !== id) await this.removeExtension(same.id, { keepFiles: false });
    const existing = this.items.get(id);
    const item = existing || sanitize({ id, source: 'unpacked', path: path.resolve(src), devKey, enabled: true, pinned: false, installedAt: Date.now() });
    item.path = path.resolve(src);
    item.devKey = devKey;
    const tabs = this.loaded.has(id) ? this.unload(id) : [];
    try {
      I.writePackage(I.unpackedCopyDir(this.root, item.path), { ...pkg, key }, { shim: I.contentShim(this.preloadFile), granted: item.granted });
    } catch (e) {
      return { ok: false, error: e.message };
    }
    const prevVersion = existing ? existing.version : null;
    item.version = pkg.manifest.version;
    item.enabled = true;
    if (!existing) this.items.set(id, item);
    const ext = await this.loadOne(item, { reason: existing ? 'update' : 'install', previousVersion: prevVersion });
    for (const t of tabs) if (!t.destroyed && !t.wc.isDestroyed()) t.reload();
    this.saveNow();
    return ext ? { ok: true, id } : { ok: false, error: item.error || 'The extension could not be loaded.' };
  }

  async removeExtension(id, { keepFiles = false } = {}) {
    const item = this.items.get(id);
    if (!item) return false;
    const uninstallUrl = item.uninstallUrl;
    this.unload(id, { closeTabs: true });
    this.items.delete(id);
    this.state.delete(id);
    this.errors.delete(id);
    this.saveNow();
    try {
      this.b.db.setMeta(STATE + id, null);
    } catch {
      /* ignore */
    }
    if (!keepFiles) {
      I.removeDir(item.source === 'unpacked' ? I.unpackedCopyDir(this.root, item.path || '') : path.join(this.root, id));
      const origin = `chrome-extension://${id}`;
      this.ses.clearStorageData({ origin }).catch(() => {});
      for (const d of ['Local Extension Settings', 'Sync Extension Settings', 'Managed Extension Settings']) I.removeDir(path.join(this.ses.getStoragePath() || this.b.profileDir, d, id));
    }
    if (uninstallUrl && /^https?:\/\//i.test(uninstallUrl)) {
      const ctl = this.b.focusedWindow({ allowPrivate: false });
      if (ctl) ctl.newTab({ url: uninstallUrl, active: true });
    }
    this.api.scheduleAlarms();
    this.refreshToolbar();
    this.notifyPages();
    return true;
  }

  async setEnabled(id, on) {
    const item = this.items.get(id);
    if (!item || item.enabled === on) return;
    item.enabled = on;
    this.save();
    if (on) await this.loadOne(item, { reason: 'enable' });
    else this.unload(id, { closeTabs: true });
    this.notifyPages();
  }

  setPinned(id, on) {
    const item = this.items.get(id);
    if (!item || item.pinned === !!on) return;
    item.pinned = !!on;
    this.save();
    this.refreshToolbar();
    if (this.loaded.has(id)) this.bridge.emit(id, 'action.onUserSettingsChanged', [{ isOnToolbar: item.pinned }], { wake: false });
    this.notifyPages();
  }

  // ==================================================================================== updates
  maybeCheckUpdates() {
    if (!this.settings.autoUpdate || Date.now() - this.settings.lastCheck < UPDATE_EVERY) return;
    this.checkUpdates().catch((e) => log.warn('extensions: update check failed', { message: e.message }));
  }

  checkUpdates({ ids = null } = {}) {
    if (this.checking) return this.checking;
    this.checking = (async () => {
      const items = [...this.items.values()].filter((it) => it.source === 'webstore' && (!ids || ids.includes(it.id)));
      if (!items.length) return { checked: 0, updated: [], failed: [], needsApproval: [] };
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 30000);
      let map;
      try {
        const res = await this.fetchImpl(updateCheckUrl(items.map((i) => ({ id: i.id, version: i.version })), process.versions.chrome), { signal: ctrl.signal, cache: 'no-store' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        map = parseUpdateResponse(await res.text());
      } finally {
        clearTimeout(timer);
      }
      if (!ids) this.settings.lastCheck = Date.now();
      const out = { checked: items.length, updated: [], failed: [], needsApproval: [] };
      for (const it of items) {
        const r = map.get(it.id);
        it.lastUpdateCheck = Date.now();
        if (!r || r.status !== 'ok') {
          it.updateError = r && r.status && r.status !== 'noupdate' ? `Web Store: ${r.status}` : null;
          continue;
        }
        if (!r.version || compareVersions(r.version, it.version) <= 0) {
          it.updateError = null;
          continue;
        }
        try {
          if (!r.codebase || !trustedCodebase(r.codebase)) throw new Error('The update is not hosted by Google.');
          const res = await this.updateOne(it, r);
          if (res === 'approval') out.needsApproval.push(it.id);
          else if (res === 'updated') out.updated.push({ id: it.id, version: it.version });
          it.updateError = null;
        } catch (e) {
          it.updateError = e.message;
          out.failed.push({ id: it.id, error: e.message });
          log.warn('extensions: update failed', { id: it.id, message: e.message });
        }
      }
      this.saveNow();
      this.notifyPages();
      return out;
    })().finally(() => {
      this.checking = null;
    });
    return this.checking;
  }

  async updateOne(item, r) {
    const pkg = await I.fetchFromStore(this.fetchImpl, item.id, process.versions.chrome, { url: r.codebase, expectSha256: r.sha256 || null });
    if (compareVersions(pkg.manifest.version, item.version) <= 0) return 'same';
    const cur = this.loaded.get(item.id);
    const before = new Set(M.describeManifest(cur ? cur.original : I.readOriginal(this.dirOf(item))?.manifest || {}).items);
    const added = M.describeManifest(pkg.manifest).items.filter((x) => !before.has(x));
    if (added.length) {
      // Like Chrome: an update that asks for more stays unapplied until the user agrees.
      item.pendingUpdate = { version: pkg.manifest.version, newPermissions: added };
      return 'approval';
    }
    await this.installPackage(pkg, { source: 'webstore' });
    return 'updated';
  }

  async approveUpdate(ctl, id) {
    const item = this.items.get(id);
    if (!item || !item.pendingUpdate) return { ok: false, error: 'No update is waiting.' };
    let pkg;
    try {
      pkg = await I.fetchFromStore(this.fetchImpl, id, process.versions.chrome);
    } catch (e) {
      return { ok: false, error: e.message };
    }
    if (!(await this.confirmInstall(ctl, pkg, 'update'))) return { ok: false, cancelled: true };
    try {
      await this.installPackage(pkg, { source: 'webstore' });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  async requestUpdateCheck(id) {
    const item = this.items.get(id);
    if (!item || item.source !== 'webstore') return { status: 'no_update' };
    if (Date.now() - item.lastUpdateCheck < 5 * 60 * 1000) return { status: 'throttled' };
    const r = await this.checkUpdates({ ids: [id] });
    const u = r.updated.find((x) => x.id === id);
    if (u) return { status: 'update_available', version: u.version };
    if (item.pendingUpdate) return { status: 'update_available', version: item.pendingUpdate.version };
    return { status: 'no_update' };
  }

  // ============================================================================== permissions
  covers(granted, wanted) {
    if (granted === wanted) return true;
    const g = M.parsePattern(granted);
    const w = M.parsePattern(wanted);
    if (!g || !w) return false;
    if (g.all) return w.schemes.every((s) => g.schemes.includes(s));
    if (!w.schemes.every((s) => g.schemes.includes(s))) return false;
    if (g.host !== '*' && !(w.host === g.host || (g.sub && (w.host === g.host || w.host.endsWith(`.${g.host}`)) && (!w.sub || w.host !== '*')))) return false;
    if (g.host !== '*' && w.host === '*') return false;
    return g.path.test(w.raw.replace(/^[^:]+:\/\/[^/]*/, '').replace(/\*/g, ''));
  }

  permissionsContain(ext, p) {
    const perms = Array.isArray(p.permissions) ? p.permissions : [];
    const origins = Array.isArray(p.origins) ? p.origins : [];
    return perms.every((x) => ext.apiPerms.has(x)) && origins.every((o) => ext.hostPatterns.some((h) => this.covers(h, o)));
  }

  async requestPermissions(ext, p, { gesture, ctl }) {
    const perms = [...new Set(Array.isArray(p.permissions) ? p.permissions : [])];
    const origins = [...new Set(Array.isArray(p.origins) ? p.origins : [])];
    const declaredPerms = new Set([...M.apiPermissions(ext.original.permissions), ...ext.optional.permissions]);
    const declaredOrigins = [...M.hostPermissions(ext.original), ...ext.optional.origins];
    for (const x of perms) if (!declaredPerms.has(x)) throw new Error('Only permissions specified in the manifest may be requested.');
    for (const o of origins) if (!declaredOrigins.some((d) => this.covers(d, o))) throw new Error('Only permissions specified in the manifest may be requested.');
    const missP = perms.filter((x) => !ext.apiPerms.has(x));
    const missO = origins.filter((o) => !ext.hostPatterns.some((h) => this.covers(h, o)));
    if (!missP.length && !missO.length) return true;
    if (!gesture) throw new Error('This function must be called during a user gesture');
    const target = ctl && !ctl.destroyed && !ctl.private ? ctl : this.b.focusedWindow({ allowPrivate: false });
    if (!target) return false;
    const d = M.describeAccess({ permissions: missP, origins: missO });
    const unsupported = missP.filter((x) => M.UNSUPPORTED_PERMISSIONS[x]).map((x) => M.UNSUPPORTED_PERMISSIONS[x]);
    const ans = await target.ask('ext-install', { kind: 'permissions', id: ext.id, name: ext.name, icon: this.iconDataUrl(ext, 48), items: d.items.length ? d.items : missP.map((x) => `Use ${x}`), unsupported });
    if (!ans || !ans.ok) return false;
    const item = ext.item;
    item.granted = { permissions: [...new Set([...item.granted.permissions, ...missP])], origins: [...new Set([...item.granted.origins, ...missO])] };
    this.saveNow();
    I.rewriteManifest(ext.dir, item.granted);
    for (const x of missP) ext.apiPerms.add(x);
    ext.hostPatterns = [...new Set([...ext.hostPatterns, ...missO])];
    this.bridge.broadcast('__permissions', [{ permissions: missP }], ext.id);
    this.bridge.emit(ext.id, 'permissions.onAdded', [{ permissions: missP, origins: missO }]);
    if (missO.length || missP.some((x) => !SHIM_PERMISSIONS.has(x))) setTimeout(() => this.reloadExtension(ext.id), 600);
    return true;
  }

  async removePermissions(ext, p) {
    const perms = Array.isArray(p.permissions) ? p.permissions : [];
    const origins = Array.isArray(p.origins) ? p.origins : [];
    const item = ext.item;
    if (perms.some((x) => M.apiPermissions(ext.original.permissions).includes(x)) || origins.some((o) => M.hostPermissions(ext.original).includes(o))) throw new Error('You cannot remove required permissions.');
    const gp = item.granted.permissions.filter((x) => !perms.includes(x));
    const go = item.granted.origins.filter((x) => !origins.includes(x));
    const removedP = item.granted.permissions.filter((x) => perms.includes(x));
    const removedO = item.granted.origins.filter((x) => origins.includes(x));
    if (!removedP.length && !removedO.length) return false;
    item.granted = { permissions: gp, origins: go };
    this.saveNow();
    I.rewriteManifest(ext.dir, item.granted);
    for (const x of removedP) ext.apiPerms.delete(x);
    ext.hostPatterns = ext.hostPatterns.filter((x) => !removedO.includes(x));
    this.bridge.emit(ext.id, 'permissions.onRemoved', [{ permissions: removedP, origins: removedO }]);
    setTimeout(() => this.reloadExtension(ext.id), 600);
    return true;
  }

  // ===================================================================================== action
  actionState(ext, tabId) {
    const d = ext.actionDef || {};
    const g = ext.action.global;
    const t = Number.isInteger(tabId) ? ext.action.tabs.get(tabId) || {} : {};
    const pick = (k, dflt) => (t[k] !== undefined ? t[k] : g[k] !== undefined ? g[k] : dflt);
    return { title: pick('title', d.title || ext.name), popup: pick('popup', d.popup || ''), badgeText: pick('badgeText', ''), badgeBg: pick('badgeBg', null), badgeFg: pick('badgeFg', null), icon: pick('icon', null), enabled: pick('enabled', true) };
  }

  setActionValue(ext, tabId, key, value) {
    if (Number.isInteger(tabId)) {
      if (!this.api.tabById(tabId)) throw new Error(`No tab with id: ${tabId}.`);
      const t = ext.action.tabs.get(tabId) || {};
      if (value === null) delete t[key];
      else t[key] = value;
      ext.action.tabs.set(tabId, t);
    } else if (value === null) delete ext.action.global[key];
    else ext.action.global[key] = value;
    this.scheduleToolbar();
  }

  /** chrome.action.setIcon: ImageData (raw RGBA) or icon paths → data: URL. */
  actionIconFrom(ext, o) {
    if (o.imageData && typeof o.imageData === 'object') {
      const sizes = Object.keys(o.imageData).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
      const s = sizes.find((x) => x >= 32) || sizes[sizes.length - 1];
      const img = s !== undefined ? o.imageData[s] : null;
      if (!img || !Number.isInteger(img.width) || !Number.isInteger(img.height) || img.width < 1 || img.height < 1 || img.width > 512 || img.height > 512) return null;
      const rgba = Buffer.from(img.data && img.data.buffer ? new Uint8Array(img.data.buffer, img.data.byteOffset || 0, img.data.byteLength) : img.data || []);
      if (rgba.length !== img.width * img.height * 4) return null;
      const bgra = Buffer.from(rgba);
      for (let i = 0; i < bgra.length; i += 4) {
        bgra[i] = rgba[i + 2];
        bgra[i + 2] = rgba[i];
      }
      const ni = nativeImage.createFromBitmap(bgra, { width: img.width, height: img.height });
      return ni.isEmpty() ? null : ni.toDataURL();
    }
    if (o.path) {
      const rel = typeof o.path === 'string' ? o.path : M.pickIcon(o.path, 32);
      return rel ? this.iconDataUrl(ext, 0, rel) : null;
    }
    return null;
  }

  /** A file of the extension (no way out of its folder), or null. */
  extFile(ext, rel) {
    let clean = '';
    try {
      // like a URL relative to the extension root ("../icons/x.png" and "/icons/x.png" both work)
      clean = decodeURIComponent(new URL(String(rel || ''), `chrome-extension://${ext.id}/`).pathname).replace(/^\/+/, '');
    } catch {
      return null;
    }
    if (!clean) return null;
    const p = path.resolve(ext.dir, clean);
    if (!p.startsWith(path.resolve(ext.dir) + path.sep) || !existsSync(p)) return null;
    return p;
  }

  /** Data URL of an extension icon (size: best icon for that size; or an explicit path). */
  iconDataUrl(ext, size = 32, rel = null) {
    const r = rel || M.pickIcon(ext.actionDef && ext.actionDef.icon, size) || M.pickIcon(ext.manifest.icons, size);
    if (!r) return null;
    const key = `${size}:${r}`;
    if (ext.iconCache.has(key)) return ext.iconCache.get(key);
    let out = null;
    const file = this.extFile(ext, r);
    const type = ICON_TYPES[path.extname(String(r)).toLowerCase()];
    if (file && type) {
      try {
        const data = readFileSync(file);
        if (data.length <= 512 * 1024) out = `data:${type};base64,${data.toString('base64')}`;
      } catch {
        out = null;
      }
    }
    ext.iconCache.set(key, out);
    return out;
  }

  iconImage(ext, size = 128) {
    const r = M.pickIcon(ext.manifest.icons, size) || M.pickIcon(ext.actionDef && ext.actionDef.icon, size);
    const file = r ? this.extFile(ext, r) : null;
    return file ? nativeImage.createFromPath(file) : undefined;
  }

  /** Click on an extension's toolbar button (or its puzzle-menu row, or its _execute_action key). */
  actionClick(ctl, id, anchor) {
    const ext = this.loaded.get(id);
    if (!ext || !ctl || ctl.destroyed || ctl.private) return;
    if (this.views.isOpen(ctl, id)) {
      this.views.closeIn(ctl);
      return;
    }
    ctl.hidePopup();
    const tab = ctl.activeTab();
    if (tab) this.api.grantActiveTab(ext, tab);
    const st = this.actionState(ext, tab ? tab.wc.id : null);
    if (st.enabled === false) return;
    if (st.popup) {
      this.views.show(ctl, ext, st.popup, anchor && Number.isFinite(anchor.x) ? anchor : this.defaultAnchor(ctl));
      this.refreshToolbar(ctl);
      return;
    }
    if (ext.actionDef) this.bridge.emit(id, 'action.onClicked', [tab ? this.api.tabObj(ext, tab) : undefined]);
  }

  defaultAnchor(ctl) {
    const [cw] = ctl.win.getContentSize();
    return { x: cw - 120, y: Math.max(40, ctl.topInset - 4), width: 100 };
  }

  // ============================================================================= toolbar, menus
  scheduleToolbar() {
    if (this.toolbarTimer) return;
    this.toolbarTimer = setTimeout(() => {
      this.toolbarTimer = null;
      this.refreshToolbar();
    }, 60);
  }

  refreshToolbar(ctl = null) {
    if (this.b.windows) this.b.refreshToolbar(ctl);
  }

  sortedLoaded() {
    return [...this.loaded.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  toolbarButtons(ctl, tab) {
    if (ctl.private) return [];
    const out = [];
    const tabId = tab && !tab.wc.isDestroyed() ? tab.wc.id : null;
    const url = tab && !tab.wc.isDestroyed() ? tab.wc.getURL() : '';
    let order = 70;
    for (const ext of this.sortedLoaded()) {
      if (!ext.item.pinned) continue;
      const st = this.actionState(ext, tabId);
      order += 0.01;
      out.push({ id: `ext:${ext.id}`, order, image: st.icon || this.iconDataUrl(ext, 32) || undefined, icon: 'puzzle', title: st.title || ext.name, badge: st.badgeText || null, badgeColor: cssColor(st.badgeBg) || undefined, tone: st.enabled === false ? 'muted' : undefined, pressed: this.views.isOpen(ctl, ext.id) });
    }
    const storeId = storeItemId(url);
    if (storeId) {
      const installed = this.items.has(storeId);
      const busy = this.busy.get(storeId);
      out.push({ id: 'store', order: 69, icon: busy ? 'download' : installed ? 'check' : 'plus', title: busy || (installed ? 'Installed in Ludworks Browser' : 'Add to Ludworks Browser'), pressed: !installed, tone: installed ? 'muted' : undefined });
    }
    if (this.items.size || storeId) out.push({ id: 'menu', order: 90, icon: 'puzzle', title: 'Extensions', popup: { kind: 'extensions', width: 340 } });
    return out;
  }

  onButton(ctl, id, anchor, { menu }) {
    if (id === 'store') {
      const t = ctl.activeTab();
      const storeId = t ? storeItemId(t.wc.getURL()) : null;
      if (!storeId) return null;
      if (menu || this.items.has(storeId)) {
        this.openManager(ctl, storeId);
        return null;
      }
      this.installFromStore(ctl, storeId);
      return null;
    }
    if (id.startsWith('ext:')) {
      const extId = id.slice(4);
      if (menu) this.extensionMenu(ctl, extId, anchor);
      else this.actionClick(ctl, extId, anchor);
    }
    return null;
  }

  extensionMenu(ctl, id, anchor) {
    const ext = this.loaded.get(id);
    const item = this.items.get(id);
    if (!item) return;
    const tab = ctl.activeTab();
    const items = [{ label: (ext ? ext.name : id).replace(/&/g, '&&'), enabled: false }, { type: 'separator' }];
    if (ext) {
      const actionMenus = this.menuEntries(ext, tab, null, ['action', 'browser_action', 'page_action', 'all']);
      if (actionMenus.length) items.push(...actionMenus, { type: 'separator' });
      if (ext.options) items.push({ label: 'Options', click: () => this.openOptions(id, ctl) });
    }
    items.push(
      { label: item.pinned ? 'Unpin from toolbar' : 'Pin to toolbar', click: () => this.setPinned(id, !item.pinned) },
      { label: 'Manage extension', click: () => this.openManager(ctl, id) },
      { type: 'separator' },
      {
        label: 'Remove from Ludworks Browser…',
        click: async () => {
          const r = await dialog.showMessageBox(ctl.win, { type: 'question', buttons: ['Remove', 'Cancel'], defaultId: 1, cancelId: 1, title: 'Remove extension', message: `Remove “${ext ? ext.name : id}”?`, detail: 'Its settings and data are deleted too.' });
          if (r.response === 0) this.removeExtension(id);
        },
      },
    );
    const a = anchor && Number.isFinite(anchor.x) ? anchor : this.defaultAnchor(ctl);
    Menu.buildFromTemplate(items).popup({ window: ctl.win, x: Math.round(a.x + (a.width || 0) - 220), y: Math.round(a.y) });
  }

  openManager(ctl, id = null) {
    const t = this.b.openInternal(ctl, 'extensions');
    if (t && id) setTimeout(() => !t.wc.isDestroyed() && t.wc.send('page-event', { type: 'extensions-focus', id }), 400);
  }

  openOptions(id, ctl) {
    const ext = this.loaded.get(id);
    if (!ext || !ext.options) return false;
    const url = `chrome-extension://${ext.id}/${ext.options.replace(/^\/+/, '')}`;
    const base = url.split(/[?#]/)[0];
    for (const t of this.b.allTabs()) {
      if (!t.private && t.wc.getURL().split(/[?#]/)[0] === base) {
        t.ctl.activate(t.id);
        t.ctl.win.focus();
        return true;
      }
    }
    const target = ctl && !ctl.private && !ctl.destroyed ? ctl : this.b.focusedWindow({ allowPrivate: false });
    if (target) target.newTab({ url, active: true });
    else this.b.newWindow({ urls: [url] });
    return true;
  }

  /** Data of the puzzle menu (overlay-extensions.js). */
  menuData(ctl, extra = {}) {
    const tab = ctl.activeTab();
    const url = tab && !tab.wc.isDestroyed() ? tab.wc.getURL() : '';
    const storeId = storeItemId(url);
    // extensions never run on the Web Store itself
    const web = /^(https?|file|ftp):/i.test(url) && !/^https:\/\/(chromewebstore\.google\.com|chrome\.google\.com\/webstore)/i.test(url);
    const items = [...this.items.values()]
      .map((it) => {
        const ext = this.loaded.get(it.id);
        const access = ext && web ? (ext.hostPatterns.some((p) => M.matchesPattern(p, url)) || ext.csMatches.some((p) => M.matchesPattern(p, url)) ? 'site' : 'none') : 'none';
        return { id: it.id, name: ext ? ext.name : it.id, icon: ext ? this.iconDataUrl(ext, 32) : null, pinned: it.pinned, enabled: it.enabled && !!ext, error: it.error, hasPopup: !!(ext && this.actionState(ext, tab ? tab.wc.id : null).popup), hasAction: !!(ext && ext.actionDef), hasOptions: !!(ext && ext.options), access };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
    return { items, host: web ? hostOf(url) : '', store: storeId ? { id: storeId, installed: this.items.has(storeId), busy: !!this.busy.get(storeId) } : null, ...extra };
  }

  openPopup(ctl, kind, anchor) {
    if (kind !== 'extensions') throw new Error(`unknown popup ${kind}`);
    return ctl.showPopup('extensions', this.menuData(ctl), { ...anchor, width: 340 });
  }

  async popupAction(ctl, kind, action, d) {
    const id = typeof d.id === 'string' ? d.id : '';
    switch (action) {
      case 'click': {
        const anchor = ctl.popup ? ctl.popup.anchor : null;
        ctl.hidePopup('extensions');
        this.actionClick(ctl, id, anchor);
        return null;
      }
      case 'pin':
        this.setPinned(id, !!d.on);
        return this.menuData(ctl);
      case 'options':
        ctl.hidePopup('extensions');
        this.openOptions(id, ctl);
        return null;
      case 'manage':
        ctl.hidePopup('extensions');
        this.openManager(ctl, id || null);
        return null;
      case 'store':
        ctl.hidePopup('extensions');
        ctl.newTab({ url: `${STORE_ORIGIN}/category/extensions`, active: true });
        return null;
      case 'install': {
        ctl.hidePopup('extensions');
        const t = ctl.activeTab();
        const storeId = t ? storeItemId(t.wc.getURL()) : null;
        if (storeId) this.installFromStore(ctl, storeId);
        return null;
      }
      default:
        throw new Error(`unknown action ${action}`);
    }
  }

  // ------------------------------------------------------------------------ page context menu
  menuEntries(ext, tab, p, contexts) {
    const menus = this.menusOf(ext.id);
    if (!menus.size || !tab) return [];
    const pageUrl = (p && (p.frameURL || p.pageURL)) || tab.wc.getURL();
    const sel = p && p.selectionText ? p.selectionText.trim() : '';
    const short = sel.length > 32 ? `${sel.slice(0, 32)}…` : sel;
    const visible = (it) => {
      if (it.visible === false) return false;
      if (!it.contexts.some((c) => contexts.includes(c))) return false;
      if (it.documentUrlPatterns && it.documentUrlPatterns.length && !it.documentUrlPatterns.some((x) => M.matchesPattern(x, pageUrl))) return false;
      if (p && it.targetUrlPatterns && it.targetUrlPatterns.length) {
        const target = p.linkURL || p.srcURL || '';
        if (target && !it.targetUrlPatterns.some((x) => M.matchesPattern(x, target))) return false;
      }
      return true;
    };
    const build = (parentId) => {
      const out = [];
      for (const it of menus.values()) {
        if ((it.parentId === undefined ? undefined : it.parentId) !== parentId || !visible(it)) continue;
        if (it.type === 'separator') {
          out.push({ type: 'separator' });
          continue;
        }
        const kids = build(it.id);
        const label = (it.title || '').replace(/%s/g, short).replace(/&/g, '&&') || ext.name;
        const click = () => this.menuClicked(ext, it, tab, p);
        if (kids.length) out.push({ label, enabled: it.enabled !== false, submenu: kids });
        else if (it.type === 'checkbox' || it.type === 'radio') out.push({ label, type: it.type, checked: !!it.checked, enabled: it.enabled !== false, click });
        else out.push({ label, enabled: it.enabled !== false, click });
      }
      while (out.length && out[0].type === 'separator') out.shift();
      while (out.length && out[out.length - 1].type === 'separator') out.pop();
      return out;
    };
    return build(undefined);
  }

  contextMenuItems(tab, p) {
    if (tab.private || !this.loaded.size) return [];
    const pageUrl = p.pageURL || tab.wc.getURL();
    // Never on internal pages (Passwords!) or the Web Store, like Chrome.
    if (!/^(https?|file|ftp|chrome-extension):/i.test(pageUrl) || /^https:\/\/(chromewebstore\.google\.com|chrome\.google\.com\/webstore)/i.test(pageUrl)) return [];
    const contexts = ['all'];
    if (p.linkURL) contexts.push('link');
    if (p.selectionText) contexts.push('selection');
    if (p.isEditable) contexts.push('editable');
    if (p.mediaType && ['image', 'video', 'audio'].includes(p.mediaType)) contexts.push(p.mediaType);
    if (p.frameURL && p.frameURL !== p.pageURL) contexts.push('frame');
    if (contexts.length === 1 || (contexts.length === 2 && contexts[1] === 'frame')) contexts.push('page');
    const out = [];
    for (const ext of this.sortedLoaded()) {
      const entries = this.menuEntries(ext, tab, p, contexts);
      if (!entries.length) continue;
      const icon = this.menuIcon(ext);
      if (entries.length === 1 && !entries[0].submenu) out.push({ ...entries[0], icon });
      else out.push({ label: ext.name.replace(/&/g, '&&'), icon, submenu: entries });
    }
    return out;
  }

  menuIcon(ext) {
    try {
      const url = this.iconDataUrl(ext, 16);
      if (!url || !/^data:image\/(png|jpeg)/.test(url)) return undefined;
      const img = nativeImage.createFromDataURL(url);
      return img.isEmpty() ? undefined : img.resize({ width: 16, height: 16 });
    } catch {
      return undefined;
    }
  }

  menuClicked(ext, it, tab, p) {
    if (!this.loaded.has(ext.id) || tab.destroyed || tab.wc.isDestroyed()) return;
    const wasChecked = !!it.checked;
    const menus = this.menusOf(ext.id);
    if (it.type === 'checkbox') it.checked = !wasChecked;
    if (it.type === 'radio') {
      const siblings = [...menus.values()].filter((x) => x.parentId === it.parentId);
      let i = siblings.indexOf(it);
      let a = i;
      while (a > 0 && siblings[a - 1].type === 'radio') a--;
      for (i = a; i < siblings.length && siblings[i].type === 'radio'; i++) siblings[i].checked = siblings[i] === it;
    }
    this.saveMenus(ext.id);
    this.api.grantActiveTab(ext, tab);
    const info = { menuItemId: it.id, editable: !!(p && p.isEditable), pageUrl: (p && p.pageURL) || tab.wc.getURL() };
    if (it.parentId !== undefined) info.parentMenuItemId = it.parentId;
    if (p) {
      if (p.frameURL) {
        info.frameUrl = p.frameURL;
        info.frameId = p.frame && p.frame !== tab.wc.mainFrame ? p.frame.frameTreeNodeId : 0;
      }
      if (p.linkURL) info.linkUrl = p.linkURL;
      if (p.srcURL) info.srcUrl = p.srcURL;
      if (p.mediaType && p.mediaType !== 'none') info.mediaType = p.mediaType;
      if (p.selectionText) info.selectionText = p.selectionText;
    }
    if (it.type === 'checkbox' || it.type === 'radio') Object.assign(info, { wasChecked, checked: !!it.checked });
    this.bridge.emit(ext.id, 'contextMenus.onClicked', [info, this.api.tabObj(ext, tab)]);
  }

  // ------------------------------------------------------------------------------- commands
  commandsActive() {
    for (const ext of this.loaded.values()) if (ext.commands.some((c) => c.shortcut)) return true;
    return false;
  }

  commandFor(input) {
    for (const ext of this.loaded.values()) for (const c of ext.commands) if (c.shortcut && M.inputMatchesShortcut(input, c.shortcut)) return { ext, name: c.name };
    return null;
  }

  // -------------------------------------------------------------------------- tab/window hooks
  attachTab(tab) {
    this.api.onTabCreated(tab);
  }

  onTabMoved(tab, from, fromIndex) {
    this.api.onTabMoved(tab, from, fromIndex);
  }

  onTabSwitch(ctl, from, to) {
    this.api.onTabSwitch(ctl, from, to);
  }

  /** Web contents of extension views that Electron would report as tabs (popups, background pages). */
  extensionViewIds() {
    const out = new Set(this.views.ids());
    for (const c of this.bridge.frames.values()) {
      if (c.wc.isDestroyed()) continue;
      if (!this.b.tabForWebContents(c.wc)) out.add(c.wc.id);
    }
    return [...out];
  }

  noteError(id, message, source) {
    if (!isExtensionId(id)) return;
    const list = this.errors.get(id) || [];
    list.push({ at: Date.now(), message: String(message || '').slice(0, 500), source: String(source || '').slice(0, 300) });
    if (list.length > MAX_ERRORS) list.splice(0, list.length - MAX_ERRORS);
    this.errors.set(id, list);
    this.notifyPages();
  }

  // ======================================================================== Chrome Web Store page
  /** chrome.webstorePrivate on chromewebstore.google.com (preload) → the normal install flow. */
  async storeCall(e, method, args) {
    const frame = e.senderFrame;
    const tab = this.b.tabForWebContents(e.sender);
    if (!tab || tab.private || !frame || frame !== e.sender.mainFrame || frame.origin !== STORE_ORIGIN) return { e: 'not allowed' };
    try {
      switch (method) {
        case 'getExtensionStatus': {
          const it = this.items.get(String(args[0] || ''));
          return { v: it ? (it.enabled ? 'enabled' : 'disabled') : 'installable' };
        }
        case 'beginInstall': {
          const id = String((args[0] && args[0].id) || '');
          if (!isExtensionId(id)) return { v: 'invalid_id' };
          if (this.items.has(id) && this.loaded.has(id)) return { v: 'already_installed' };
          tab.ctl.activate(tab.id);
          const r = await this.installFromStore(tab.ctl, id);
          return { v: r.ok ? '' : r.cancelled ? 'user_cancelled' : 'unknown_error' };
        }
        case 'completeInstall': {
          const id = String(args[0] || '');
          if (this.loaded.has(id)) return { v: null };
          return { e: 'Installation failed.' };
        }
        case 'uninstall': {
          const id = String(args[0] || '');
          const ext = this.loaded.get(id);
          if (!this.items.has(id)) return { v: false };
          const r = await dialog.showMessageBox(tab.ctl.win, { type: 'question', buttons: ['Remove', 'Cancel'], defaultId: 1, cancelId: 1, title: 'Remove extension', message: `Remove “${ext ? ext.name : id}”?`, detail: 'Its settings and data are deleted too.' });
          if (r.response !== 0) return { v: false };
          return { v: await this.removeExtension(id) };
        }
        case 'fullVersion':
          return { v: { version_number: process.versions.chrome, app_name: 'Ludworks Browser' } };
        default:
          return { e: 'not supported' };
      }
    } catch (x) {
      return { e: x.message };
    } finally {
      this.refreshToolbar(tab.ctl);
    }
  }

  // ============================================================================ manage page API
  notifyPages() {
    clearTimeout(this.notifyTimer);
    this.notifyTimer = setTimeout(() => {
      for (const t of this.b.allTabs()) {
        const u = t.wc.getURL();
        if (u.startsWith('ludworks://extensions') || u.startsWith('ludworks://settings')) t.wc.send('page-event', { type: 'extensions' });
      }
    }, 120);
  }

  summary(it) {
    const ext = this.loaded.get(it.id);
    const access = ext ? M.describeAccess({ permissions: [], origins: ext.hostPatterns, contentScripts: ext.csMatches }) : null;
    return {
      id: it.id,
      name: ext ? ext.name : it.id,
      description: ext ? ext.description : '',
      version: it.version,
      icon: ext ? this.iconDataUrl(ext, 48) : null,
      enabled: it.enabled,
      loaded: !!ext,
      pinned: it.pinned,
      source: it.source,
      path: it.source === 'unpacked' ? it.path : null,
      error: it.error,
      updateError: it.updateError,
      pendingUpdate: it.pendingUpdate,
      hasOptions: !!(ext && ext.options),
      siteAccess: !access ? '' : access.allSites ? 'All sites' : access.sites.length ? `${access.sites.length} site${access.sites.length === 1 ? '' : 's'}` : 'No site access',
      unsupported: ext ? ext.unsupported.length : 0,
      errors: (this.errors.get(it.id) || []).length,
    };
  }

  listData() {
    return { theme: this.b.prefs.get('theme'), devMode: this.settings.devMode, autoUpdate: this.settings.autoUpdate, lastCheck: this.settings.lastCheck, checking: !!this.checking, items: [...this.items.values()].map((it) => this.summary(it)).sort((a, b) => a.name.localeCompare(b.name)) };
  }

  details(id) {
    const it = this.items.get(id);
    if (!it) throw new Error('This extension is not installed.');
    const ext = this.loaded.get(id);
    const m = ext ? ext.original : (I.readOriginal(this.dirOf(it)) || {}).manifest || {};
    const access = M.describeAccess({ permissions: M.apiPermissions(m.permissions), origins: M.hostPermissions(m), contentScripts: M.contentScriptMatches(m) });
    const opt = M.optionalPermissions(m);
    return {
      ...this.summary(it),
      installedAt: it.installedAt,
      updatedAt: it.updatedAt,
      lastUpdateCheck: it.lastUpdateCheck,
      manifestVersion: m.manifest_version,
      dir: this.dirOf(it),
      size: dirSize(this.dirOf(it)),
      storeUrl: it.source === 'webstore' ? storePageUrl(id) : null,
      homepage: typeof m.homepage_url === 'string' && /^https?:\/\//.test(m.homepage_url) ? m.homepage_url : null,
      permissions: access.items,
      apiPermissions: M.apiPermissions(m.permissions),
      hosts: [...new Set([...M.hostPermissions(m), ...M.contentScriptMatches(m)])],
      optional: { permissions: opt.permissions.map((p) => ({ name: p, granted: it.granted.permissions.includes(p) })), origins: opt.origins.map((p) => ({ name: p, granted: it.granted.origins.includes(p) })) },
      unsupportedList: M.unsupportedFeatures(m),
      commands: ext ? ext.commands.filter((c) => c.shortcut || !c.name.startsWith('_')).map((c) => ({ name: c.name, description: c.description, shortcut: c.shortcut })) : [],
      errorList: (this.errors.get(id) || []).slice().reverse(),
    };
  }

  async pageCommand(tab, cmd, a) {
    const id = typeof a.id === 'string' ? a.id : '';
    const ctl = tab.ctl;
    switch (cmd) {
      case 'extensions.list':
        return this.listData();
      case 'extensions.summary':
        return { count: this.items.size, enabled: [...this.items.values()].filter((x) => x.enabled).length, devMode: this.settings.devMode, autoUpdate: this.settings.autoUpdate };
      case 'extensions.details':
        return this.details(id);
      case 'extensions.enable':
        await this.setEnabled(id, !!a.on);
        return this.listData();
      case 'extensions.remove':
        await this.removeExtension(id);
        return this.listData();
      case 'extensions.options':
        return { ok: this.openOptions(id, ctl) };
      case 'extensions.pin':
        this.setPinned(id, !!a.on);
        return this.listData();
      case 'extensions.update': {
        try {
          const r = await this.checkUpdates({ ids: id ? [id] : null });
          return { ok: true, ...r, list: this.listData() };
        } catch (e) {
          return { ok: false, error: e.message, list: this.listData() };
        }
      }
      case 'extensions.approve-update':
        return { ...(await this.approveUpdate(ctl, id)), list: this.listData() };
      case 'extensions.dev-mode':
        this.settings.devMode = !!a.on;
        this.saveNow();
        return this.listData();
      case 'extensions.auto-update':
        this.settings.autoUpdate = !!a.on;
        this.saveNow();
        return this.listData();
      case 'extensions.load-unpacked': {
        if (!this.settings.devMode) throw new Error('Turn on developer mode first.');
        const r = await dialog.showOpenDialog(ctl.win, { title: 'Load unpacked extension', properties: ['openDirectory'] });
        if (r.canceled || !r.filePaths[0]) return { ok: false, cancelled: true };
        return { ...(await this.loadUnpacked(r.filePaths[0])), list: this.listData() };
      }
      case 'extensions.reload': {
        const it = this.items.get(id);
        if (!it) throw new Error('This extension is not installed.');
        if (it.source === 'unpacked') return { ...(await this.loadUnpacked(it.path)), list: this.listData() };
        await this.reloadExtension(id);
        return { ok: this.loaded.has(id), error: it.error, list: this.listData() };
      }
      case 'extensions.install-file': {
        if (!this.settings.devMode) throw new Error('Turn on developer mode first.');
        const r = await dialog.showOpenDialog(ctl.win, { title: 'Install extension from file', properties: ['openFile'], filters: [{ name: 'Extension packages', extensions: ['crx', 'zip'] }] });
        if (r.canceled || !r.filePaths[0]) return { ok: false, cancelled: true };
        return { ...(await this.installFromFile(ctl, r.filePaths[0])), list: this.listData() };
      }
      case 'extensions.open-store':
        ctl.newTab({ url: id ? storePageUrl(id) : `${STORE_ORIGIN}/category/extensions`, active: true });
        return null;
      case 'extensions.open-url':
        if (typeof a.url === 'string' && /^https:\/\//.test(a.url)) ctl.newTab({ url: a.url, active: true });
        return null;
      case 'extensions.show-folder': {
        const it = this.items.get(id);
        if (it) shell.openPath(it.source === 'unpacked' && it.path ? it.path : this.dirOf(it)).catch(() => {});
        return null;
      }
      case 'extensions.clear-errors':
        this.errors.delete(id);
        return this.details(id);
      default:
        throw new Error(`unknown command ${cmd}`);
    }
  }
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}
