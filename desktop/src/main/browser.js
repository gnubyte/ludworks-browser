// The browser: profile services, sessions, windows, commands and IPC wiring.

import { app, session, ipcMain, dialog, nativeTheme, shell, Menu, desktopCapturer, webContents as allWebContents } from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { WindowCtl } from './window.js';
import { Shortcuts } from './shortcuts.js';
import { ProfileDb } from './profile/db.js';
import { Prefs } from './profile/prefs.js';
import { Bookmarks, ROOTS } from './profile/bookmarks.js';
import { History } from './profile/history.js';
import { Permissions, LABELS as PERMISSION_LABELS } from './profile/permissions.js';
import { Downloads } from './downloads.js';
import { registerProtocols, INTERNAL_PAGES } from './protocols.js';
import { fixupInput, originOf, hostOf, displayUrl } from './util/urls.js';
import { currentEngine, searchUrl, fetchSuggestions, ENGINES } from './search.js';
import { chromeUserAgent } from './util/ua.js';
import { log } from './util/log.js';
import { APP_NAME } from './paths.js';
import { DefaultBrowser } from './default-browser.js';

const NEWTAB = 'ludworks://newtab/';
const SESSION_SAVE_DELAY = 1500;

export class Browser {
  constructor({ profileDir, explicitProfile, appDir }) {
    this.profileDir = profileDir;
    this.explicitProfile = explicitProfile;
    this.appDir = appDir;
    this.dev = !app.isPackaged || process.env.LUDWORKS_DEV === '1';
    this.paths = {
      shellPreload: path.join(appDir, 'preload', 'shell.cjs'),
      contentPreload: path.join(appDir, 'preload', 'content.cjs'),
      pagePreload: path.join(appDir, 'preload', 'pages.cjs'),
      windowIcon: process.platform === 'linux' ? path.join(appDir, 'assets', 'icons', 'icon-256.png') : null,
    };
    this.windows = new Set();
    this.lastFocused = null;
    this.quitting = false;
    this.certAllowances = new Map(); // host → Set(fingerprint) allowed by the user this session
    this.pinnedHosts = new Map(); // host → fingerprint (Ludworks server pin, set by the account service)
    this.pendingPermission = new Map(); // tab id → [{...}]
    this.shortcuts = new Shortcuts(this);
    this.sessionTimer = null;
  }

  // ---------------------------------------------------------------------------------- startup
  async start(argv, earlyUrls = []) {
    this.db = new ProfileDb(this.profileDir);
    this.prefs = new Prefs(this.db);
    this.bookmarks = new Bookmarks(this.db);
    this.history = new History(this.db);
    this.permissions = new Permissions(this.db);
    this.downloads = new Downloads({ db: this.db, prefs: this.prefs });
    this.defaultBrowser = new DefaultBrowser();
    if (!this.prefs.get('hardwareAcceleration')) app.disableHardwareAcceleration();
    this.session = session.defaultSession;
    this.ua = chromeUserAgent();
    app.userAgentFallback = this.ua;
    this.setupSession(this.session, { isPrivate: false });
    registerProtocols(session.fromPartition('lwui'), this.appDir, { shell: true, pages: false });

    const { Account } = await import('./account/account.js');
    const { Autofill } = await import('./autofill.js');
    const { Passkeys } = await import('./passkeys.js');
    this.account = new Account(this);
    if (this.account.acc && this.account.acc.pin) this.pinnedHosts.set(new URL(this.account.acc.serverUrl).hostname, this.account.acc.pin);
    this.autofill = new Autofill(this);
    this.passkeys = new Passkeys(this);
    this.registerIpc();

    this.bookmarks.on('change', () => this.broadcastShared());
    this.downloads.on('change', (ev) => this.onDownloadsChange(ev));
    this.prefs.on('change', (keys) => this.onPrefsChange(keys));
    nativeTheme.on('updated', () => this.forEachWindow((w) => w.applyTheme()));

    this.startEngineComponents();
    const restored = this.prefs.get('startup') === 'restore' ? this.restoreSession() : 0;
    const urls = [...this.urlsFromArgv(argv), ...earlyUrls];
    const firstRun = !this.db.getMeta('welcomed', false);
    if (firstRun) this.db.setMeta('welcomed', true);
    if (!restored) this.newWindow({ urls: urls.length ? urls : [firstRun ? 'ludworks://welcome/' : this.newTabUrl()] });
    else if (urls.length) this.openUrls(urls);
    this.account.start().catch((e) => log.warn('account start failed', { message: e.message }));
    setInterval(() => this.history.prune(), 6 * 3600 * 1000).unref();
    setTimeout(() => this.history.prune(), 60 * 1000).unref();
  }

  /** castlabs ECS: make sure the Widevine CDM component is installed/updated (DRM streaming). */
  async startEngineComponents() {
    let components;
    try {
      ({ components } = await import('electron'));
    } catch {
      components = null;
    }
    if (!components || typeof components.whenReady !== 'function') {
      log.info('Widevine components API not available in this Electron build');
      return;
    }
    try {
      await components.whenReady();
      this.drmStatus = components.status ? components.status() : { ready: true };
      log.info('DRM components ready', this.drmStatus);
    } catch (e) {
      this.drmStatus = { error: String(e && e.message ? e.message : e) };
      log.warn('DRM components failed', this.drmStatus);
    }
  }

  // ---------------------------------------------------------------------------------- sessions
  /** @param {Electron.Session} ses */
  setupSession(ses, { isPrivate }) {
    ses.setUserAgent(this.ua);
    registerProtocols(ses, this.appDir, { shell: false, pages: true });
    ses.setPermissionRequestHandler((wc, permission, callback, details) => this.onPermissionRequest(wc, permission, callback, details));
    ses.setPermissionCheckHandler((wc, permission, requestingOrigin, details) => this.onPermissionCheck(wc, permission, requestingOrigin, details));
    ses.setDevicePermissionHandler(() => false);
    ses.setDisplayMediaRequestHandler((request, callback) => this.onDisplayMedia(request, callback), { useSystemPicker: process.platform === 'darwin' });
    ses.setSpellCheckerEnabled(this.prefs.get('spellcheck'));
    this.downloads.attach(ses, { isPrivate });
    // Global Privacy Control / Do-Not-Track style headers and a cookie-free suggestion fetch path.
    ses.webRequest.onBeforeSendHeaders((details, cb) => {
      const headers = details.requestHeaders;
      if (this.prefs.get('sendGpc')) headers['Sec-GPC'] = '1';
      cb({ requestHeaders: headers });
    });
    ses.setCertificateVerifyProc((req, cb) => {
      // The Ludworks server's pinned certificate (trust-on-first-use, confirmed by the user) is
      // accepted for that host; everything else gets Chromium's normal verdict.
      const pin = this.pinnedHosts.get(req.hostname);
      if (pin && fingerprintMatches(req.certificate, pin)) return cb(0);
      cb(-3);
    });
  }

  privateSession() {
    if (!this._private) {
      this._private = session.fromPartition(`private-${randomUUID()}`);
      this.setupSession(this._private, { isPrivate: true });
    }
    return this._private;
  }

  // ---------------------------------------------------------------------------------- windows
  newWindow({ urls = null, private: isPrivate = false, bounds = null, maximized = false, tabs = null, active = 0, empty = false } = {}) {
    const saved = !bounds && !isPrivate ? this.db.getMeta('window_state', null) : null;
    const ctl = new WindowCtl({ browser: this, private: isPrivate, bounds: bounds || (saved && saved.bounds) || null, maximized: maximized || !!(saved && saved.maximized) });
    this.windows.add(ctl);
    this.lastFocused = ctl;
    if (empty) {
      // the caller adds the first tab (window.open popups adopt the opener-created webContents)
    } else if (tabs && tabs.length) {
      tabs.forEach((t, i) => ctl.newTab({ url: t.url, active: i === active, pinned: !!t.pinned }));
    } else {
      for (const [i, u] of (urls && urls.length ? urls : [this.newTabUrl()]).entries()) ctl.newTab({ url: u, active: i === 0 });
    }
    ctl.win.on('resize', () => this.rememberWindowState(ctl));
    ctl.win.on('move', () => this.rememberWindowState(ctl));
    return ctl;
  }

  rememberWindowState(ctl) {
    if (ctl.private || ctl.win.isFullScreen() || ctl.win.isMinimized()) return;
    clearTimeout(this.winStateTimer);
    this.winStateTimer = setTimeout(() => {
      if (ctl.destroyed) return;
      this.db.setMeta('window_state', { bounds: ctl.win.getNormalBounds(), maximized: ctl.win.isMaximized() });
    }, 500);
  }

  ensureWindow() {
    if (![...this.windows].some((w) => !w.private)) this.newWindow({});
    else this.focusedWindow().win.focus();
  }

  focusedWindow({ allowPrivate = true } = {}) {
    const list = [...this.windows].filter((w) => !w.destroyed && (allowPrivate || !w.private));
    if (this.lastFocused && list.includes(this.lastFocused)) return this.lastFocused;
    return list[list.length - 1] || null;
  }

  forEachWindow(fn) {
    for (const w of this.windows) if (!w.destroyed) fn(w);
  }

  openUrls(urls, { background = false } = {}) {
    const list = urls.filter(Boolean);
    if (!list.length) return;
    let ctl = this.focusedWindow({ allowPrivate: false });
    if (!ctl) {
      this.newWindow({ urls: list });
      return;
    }
    list.forEach((u, i) => ctl.newTab({ url: u, active: !background && i === 0 }));
    if (ctl.win.isMinimized()) ctl.win.restore();
    ctl.win.focus();
  }

  handleCommandLine(argv) {
    const isPrivate = argv.includes('--incognito') || argv.includes('--private') || argv.includes('--inprivate');
    const urls = this.urlsFromArgv(argv);
    if (isPrivate || argv.includes('--new-window')) this.newWindow({ urls, private: isPrivate });
    else if (urls.length) this.openUrls(urls);
    else this.ensureWindow();
  }

  urlsFromArgv(argv) {
    const out = [];
    // Shell-launched URLs come as `--single-argument <url>`: everything after it is one URL, never switches.
    const single = argv.indexOf('--single-argument');
    if (single >= 0) {
      const one = argv.slice(single + 1).join(' ').trim();
      const f = one && (/^[a-z]:[\\/]/i.test(one) ? { type: 'url', url: pathToFileURL(one).href } : fixupInput(one));
      return f && f.type === 'url' ? [f.url] : [];
    }
    for (const a of argv) {
      if (!a || a.startsWith('-')) continue;
      if (/^[a-z][a-z0-9+.-]*:/i.test(a) && !/^[a-z]:[\\/]/i.test(a)) {
        const f = fixupInput(a);
        if (f && f.type === 'url') out.push(f.url);
      } else if (path.isAbsolute(a)) {
        out.push(pathToFileURL(a).href);
      }
    }
    return out;
  }

  newTabUrl() {
    return NEWTAB;
  }

  onWindowClosed(ctl) {
    this.windows.delete(ctl);
    if (this.lastFocused === ctl) this.lastFocused = null;
    if (ctl.private && ![...this.windows].some((w) => w.private) && this._private) {
      const ses = this._private;
      this._private = null;
      ses.clearStorageData().catch(() => {});
      ses.clearCache().catch(() => {});
    }
    if (!ctl.private) this.scheduleSessionSave();
  }

  onTabClosed(tab) {
    this.pendingPermission.delete(tab.id);
    this.autofill.onTabClosed(tab);
  }

  confirmCloseWindow(ctl) {
    if (!this.dev && process.platform !== 'darwin' && this.windows.size === 1) return true;
    return true;
  }

  confirmLeave(tab) {
    const r = dialog.showMessageBoxSync(tab.ctl.win, {
      type: 'question',
      buttons: ['Leave', 'Stay'],
      defaultId: 1,
      cancelId: 1,
      title: 'Leave site?',
      message: 'Leave site?',
      detail: 'Changes you made may not be saved.',
    });
    return r === 0;
  }

  // ---------------------------------------------------------------------------- session restore
  scheduleSessionSave() {
    if (this.sessionTimer) return;
    this.sessionTimer = setTimeout(() => {
      this.sessionTimer = null;
      this.saveSession();
    }, SESSION_SAVE_DELAY);
  }

  saveSession() {
    if (!this.db) return;
    const windows = [...this.windows]
      .filter((w) => !w.private && !w.destroyed && w.tabs.length)
      .map((w) => ({
        bounds: w.win.isDestroyed() ? null : w.win.getNormalBounds(),
        maximized: w.win.isDestroyed() ? false : w.win.isMaximized(),
        active: Math.max(0, w.tabs.findIndex((t) => t.id === w.activeId)),
        tabs: w.tabs.map((t) => ({ url: t.wc.isDestroyed() ? t.url : t.wc.getURL() || t.url, title: t.title, pinned: t.pinned })).filter((t) => t.url),
      }));
    if (windows.length || this.quitting) this.db.setMeta('session', { windows, savedAt: Date.now() });
    const tabsSig = JSON.stringify(this.syncableTabs().map((t) => t.url));
    if (tabsSig !== this.lastTabsSig) {
      this.lastTabsSig = tabsSig;
      this.db.setMeta('tabs_dirty', true);
      if (this.account) this.account.scheduleSync(60 * 1000);
    }
  }

  restoreSession() {
    const s = this.db.getMeta('session', null);
    if (!s || !Array.isArray(s.windows) || !s.windows.length) return 0;
    let n = 0;
    for (const w of s.windows.slice(0, 20)) {
      const tabs = (w.tabs || []).filter((t) => t && typeof t.url === 'string').slice(0, 200);
      if (!tabs.length) continue;
      this.newWindow({ tabs, bounds: w.bounds || null, maximized: !!w.maximized, active: Math.min(w.active || 0, tabs.length - 1) });
      n++;
    }
    return n;
  }

  beforeQuit() {
    this.quitting = true;
    this.saveSession();
    try {
      this.account.stop();
    } catch {
      /* ignore */
    }
  }

  // ------------------------------------------------------------------------------- navigation
  engine() {
    return currentEngine(this.prefs.all());
  }

  searchUrlFor(text) {
    return searchUrl(this.engine(), text);
  }

  /**
   * Address-bar commit. disposition: 'current' | 'new-tab' | 'background-tab' | 'new-window'.
   */
  navigateFromOmnibox(ctl, text, disposition = 'current') {
    const f = fixupInput(text);
    if (!f) return;
    const url = f.type === 'url' ? f.url : this.searchUrlFor(f.query);
    this.openIn(ctl, url, disposition, { typed: true });
  }

  openIn(ctl, url, disposition = 'current', { typed = false } = {}) {
    if (/^javascript:/i.test(url)) {
      const tab = ctl.activeTab();
      if (tab) tab.wc.executeJavaScript(decodeURIComponent(url.slice(11)), true).catch(() => {});
      return;
    }
    if (disposition === 'new-window') this.newWindow({ urls: [url], private: ctl.private });
    else if (disposition === 'new-tab' || disposition === 'background-tab') ctl.newTab({ url, active: disposition === 'new-tab', typed });
    else {
      const tab = ctl.activeTab();
      if (tab) {
        tab.load(url, { typed });
        tab.wc.focus();
      } else ctl.newTab({ url, typed });
    }
  }

  /** window.open / target=_blank / middle-click from a page. */
  handleWindowOpen(tab, details) {
    const { url, disposition } = details;
    if (!/^(https?|ftp|about|data|blob|file|ludworks):/i.test(url)) {
      // External protocols go through the openExternal permission flow via a navigation.
      return { action: 'deny' };
    }
    if (/^ludworks:/i.test(url) && !/^ludworks:/i.test(tab.wc.getURL())) return { action: 'deny' };
    const ctl = tab.ctl;
    const background = disposition === 'background-tab';
    return {
      action: 'allow',
      outlivesOpener: true,
      createWindow: (options) => {
        if (disposition === 'new-window' && details.features) {
          // Sized popups (OAuth, payment): their own window, sized as the page asked (plus our toolbar).
          const num = (v, min, max) => (Number.isFinite(v) ? Math.max(min, Math.min(max, Math.round(v))) : null);
          const w = num(options.width, 320, 2400);
          const hh = num(options.height, 240, 1600);
          const bounds = w && hh ? { width: w, height: hh + 90, ...(Number.isFinite(options.x) && Number.isFinite(options.y) ? { x: Math.round(options.x), y: Math.round(options.y) } : {}) } : null;
          const nw = this.newWindow({ private: ctl.private, empty: true, bounds });
          const t = nw.newTab({ webContents: options.webContents, opener: null });
          return t.wc;
        }
        const t = ctl.newTab({ webContents: options.webContents, active: !background, opener: tab });
        return t.wc;
      },
    };
  }

  // ------------------------------------------------------------------------------ permissions
  onPermissionCheck(wc, permission, requestingOrigin) {
    const origin = requestingOrigin || (wc ? originOf(wc.getURL()) : '');
    const policy = this.permissions.policy(permission);
    if (policy === 'allow') return true;
    if (policy === 'deny' || !origin) return false;
    return this.permissions.stored(origin, permission) === 'allow';
  }

  onPermissionRequest(wc, permission, callback, details) {
    const origin = originOf(details.requestingUrl || (wc ? wc.getURL() : ''));
    const policy = this.permissions.policy(permission);
    if (policy === 'allow') return callback(true);
    if (policy === 'deny' || !origin || !wc) return callback(false);
    const tab = this.tabForWebContents(wc);
    if (!tab) return callback(false);
    const remembered = this.permissions.remembered(permission);
    const stored = remembered ? this.permissions.stored(origin, permission) : null;
    if (stored) return callback(stored === 'allow');
    let label = PERMISSION_LABELS[permission] || permission;
    if (permission === 'media' && Array.isArray(details.mediaTypes)) {
      const v = details.mediaTypes.includes('video');
      const a = details.mediaTypes.includes('audio');
      label = v && a ? PERMISSION_LABELS.media : v ? PERMISSION_LABELS['media:video'] : PERMISSION_LABELS['media:audio'];
    }
    let detail = '';
    if (permission === 'openExternal') {
      const ext = String(details.externalURL || '');
      const scheme = ext.split(':')[0];
      if (!/^[a-z][a-z0-9+.-]*$/i.test(scheme) || /^(file|javascript|vbscript|data|ms-msdt|search-ms|ms-officecmd)$/i.test(scheme)) return callback(false);
      detail = `${scheme}:`;
      const allowed = this.permissions.stored(origin, `openExternal:${scheme}`);
      if (allowed) return callback(allowed === 'allow');
    }
    const req = { id: randomUUID(), origin, host: hostOf(origin) || origin, permission, label, detail, remembered: remembered || permission === 'openExternal', callback, scheme: detail.replace(/:$/, '') };
    const q = this.pendingPermission.get(tab.id) || [];
    q.push(req);
    this.pendingPermission.set(tab.id, q);
    if (q.length === 1) this.showPermissionPrompt(tab);
  }

  showPermissionPrompt(tab) {
    const q = this.pendingPermission.get(tab.id);
    if (!q || !q.length) return;
    const r = q[0];
    if (tab.ctl.activeId !== tab.id) return; // shown when the tab is activated
    tab.ctl.showPopup('permission', { id: r.id, host: r.host, label: r.label, detail: r.detail, remembered: r.remembered }, { x: 90, y: tab.ctl.topInset - 6, width: 360 }, { closeOnBlur: false });
  }

  answerPermission(ctl, id, decision) {
    const tab = ctl.activeTab();
    const q = tab && this.pendingPermission.get(tab.id);
    if (!q || !q.length || q[0].id !== id) return;
    const r = q.shift();
    const allow = decision === 'allow' || decision === 'allow-once';
    if (r.permission === 'openExternal' && decision === 'allow') this.permissions.set(r.origin, `openExternal:${r.scheme}`, 'allow');
    else if (r.remembered && (decision === 'allow' || decision === 'block')) this.permissions.set(r.origin, r.permission, allow ? 'allow' : 'deny');
    try {
      r.callback(allow);
    } catch {
      /* page gone */
    }
    ctl.hidePopup('permission');
    if (q.length) setTimeout(() => this.showPermissionPrompt(tab), 100);
    else this.pendingPermission.delete(tab.id);
  }

  async onDisplayMedia(request, callback) {
    const wc = request.frame ? allWebContents.fromFrame(request.frame) : null;
    const tab = wc ? this.tabForWebContents(wc) : null;
    if (!tab) return callback({});
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 240, height: 135 }, fetchWindowIcons: false });
      const list = sources.slice(0, 40).map((s) => ({ id: s.id, name: s.name, thumb: s.thumbnail.isEmpty() ? null : s.thumbnail.toDataURL(), screen: s.id.startsWith('screen:') }));
      tab.ctl.activate(tab.id);
      const ans = await tab.ctl.ask('display-media', { host: hostOf(originOf(wc.getURL())), sources: list, audio: process.platform === 'win32' });
      const chosen = ans && sources.find((s) => s.id === ans.id);
      if (!chosen) return callback({});
      callback({ video: chosen, ...(ans.audio && process.platform === 'win32' ? { audio: 'loopback' } : {}) });
    } catch (e) {
      log.warn('display media failed', { message: e.message });
      callback({});
    }
  }

  // ------------------------------------------------------------------------------ certificates
  certAllowed(host, cert) {
    const set = this.certAllowances.get(host);
    return !!(set && set.has(cert.fingerprint));
  }

  allowCertificate(host, fingerprint) {
    if (!host || !fingerprint) return;
    const set = this.certAllowances.get(host) || new Set();
    set.add(fingerprint);
    this.certAllowances.set(host, set);
  }

  // ------------------------------------------------------------------------------------- zoom
  zoomTab(tab, delta) {
    const wc = tab.wc;
    const levels = [-3.8, -3, -2.2, -1.6, -1, -0.6, 0, 0.6, 1.2, 1.8, 2.2, 3, 3.8, 4.4, 5];
    const cur = wc.getZoomLevel();
    let next;
    if (delta === 0) next = 0;
    else if (delta > 0) next = levels.find((l) => l > cur + 0.01) ?? cur;
    else next = [...levels].reverse().find((l) => l < cur - 0.01) ?? cur;
    wc.setZoomLevel(next);
    const host = hostOf(wc.getURL());
    if (host && !tab.private) {
      const z = { ...this.prefs.get('zoom') };
      if (next === 0) delete z[host];
      else z[host] = next;
      this.prefs.update({ zoom: z });
    }
    tab.update();
    tab.ctl.shell.send('zoom-bubble', Math.round(wc.getZoomFactor() * 100));
  }

  applyStoredZoom(tab) {
    const host = hostOf(tab.wc.getURL());
    const z = host ? this.prefs.get('zoom')[host] : undefined;
    if (typeof z === 'number' && Math.abs(tab.wc.getZoomLevel() - z) > 0.01) tab.wc.setZoomLevel(z);
  }

  // ----------------------------------------------------------------------------------- misc
  async savePage(tab) {
    const title = (tab.title || 'page').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 100);
    const res = await dialog.showSaveDialog(tab.ctl.win, {
      defaultPath: path.join(app.getPath('downloads'), `${title}.html`),
      filters: [{ name: 'Web page, complete', extensions: ['html'] }, { name: 'Web page, HTML only', extensions: ['htm'] }, { name: 'Web archive (MHTML)', extensions: ['mhtml'] }],
    });
    if (res.canceled || !res.filePath) return;
    const ext = path.extname(res.filePath).toLowerCase();
    const type = ext === '.mhtml' ? 'MHTML' : ext === '.htm' ? 'HTMLOnly' : 'HTMLComplete';
    tab.wc.savePage(res.filePath, type).catch((e) => log.warn('save page failed', { message: e.message }));
  }

  togglePictureInPicture(tab, p) {
    const js = `(() => { const v = document.elementFromPoint(${Number(p.x)}, ${Number(p.y)}); const vid = v && (v.tagName === 'VIDEO' ? v : v.closest && v.closest('video')); if (!vid) return; if (document.pictureInPictureElement) document.exitPictureInPicture(); else vid.requestPictureInPicture(); })()`;
    tab.wc.executeJavaScript(js, true).catch(() => {});
  }

  allTabs() {
    const out = [];
    for (const w of this.windows) out.push(...w.tabs);
    return out;
  }

  /** Open tabs of normal windows for the synced `tabs` record (VAULT-CRYPTO §9). */
  syncableTabs() {
    const out = [];
    for (const w of this.windows) {
      if (w.private) continue;
      for (const t of w.tabs) {
        const url = t.wc.isDestroyed() ? t.url : t.wc.getURL();
        if (/^https?:/i.test(url)) out.push({ url: url.slice(0, 4096), title: String(t.title || '').slice(0, 300), last_used: t.lastActive || Date.now() });
      }
    }
    return out.sort((a, b) => b.last_used - a.last_used).slice(0, 200);
  }

  tabForWebContents(wc) {
    for (const w of this.windows) for (const t of w.tabs) if (t.wc === wc) return t;
    return null;
  }

  windowForShell(wc) {
    for (const w of this.windows) {
      if (w.shell === wc || (w.overlay && w.overlay.webContents === wc) || (w.panel && w.panel.webContents === wc)) return w;
    }
    return null;
  }

  openInternal(ctl, page) {
    const url = `ludworks://${page}/`;
    for (const t of ctl.tabs) {
      if (t.wc.getURL().startsWith(url)) {
        ctl.activate(t.id);
        return t;
      }
    }
    const cur = ctl.activeTab();
    if (cur && cur.wc.getURL() === NEWTAB) {
      cur.load(url);
      return cur;
    }
    return ctl.newTab({ url });
  }

  // ------------------------------------------------------------------------------- commands
  command(cmd, { ctl, tab = null, arg } = {}) {
    if (!ctl || ctl.destroyed) return;
    tab = tab || ctl.activeTab();
    const nh = tab ? tab.wc.navigationHistory : null;
    switch (cmd) {
      case 'newTab':
        ctl.newTab({ active: true });
        ctl.shell.focus();
        ctl.shell.send('focus-omnibox', { select: true });
        break;
      case 'closeTab':
        if (tab) ctl.closeTab(tab.id);
        break;
      case 'newWindow':
        this.newWindow({});
        break;
      case 'privateWindow':
        this.newWindow({ private: true });
        break;
      case 'focusOmnibox':
      case 'focusSearch':
        ctl.shellFocused = true;
        ctl.shell.focus();
        ctl.shell.send('focus-omnibox', { select: true });
        break;
      case 'reload':
        if (tab) tab.reload(false);
        break;
      case 'hardReload':
        if (tab) tab.reload(true);
        break;
      case 'stop':
        if (tab) tab.wc.stop();
        break;
      case 'back':
        if (nh && nh.canGoBack()) nh.goBack();
        break;
      case 'forward':
        if (nh && nh.canGoForward()) nh.goForward();
        break;
      case 'home':
        if (tab) tab.load(this.prefs.get('homepage') || NEWTAB);
        break;
      case 'nextTab':
        ctl.cycleTab(1);
        break;
      case 'prevTab':
        ctl.cycleTab(-1);
        break;
      case 'selectTab':
        if (ctl.tabs[arg]) ctl.activate(ctl.tabs[arg].id);
        break;
      case 'lastTab':
        if (ctl.tabs.length) ctl.activate(ctl.tabs[ctl.tabs.length - 1].id);
        break;
      case 'reopenTab':
        ctl.reopenClosedTab();
        break;
      case 'find':
        if (tab) {
          tab.find = tab.find || { text: '', matches: 0, active: 0 };
          tab.update();
          ctl.shell.focus();
          ctl.shell.send('find-open');
        }
        break;
      case 'findNext':
      case 'findPrev':
        if (tab && tab.find && tab.find.text) tab.wc.findInPage(tab.find.text, { forward: cmd === 'findNext', findNext: true });
        else this.command('find', { ctl, tab });
        break;
      case 'savePage':
        if (tab) this.savePage(tab);
        break;
      case 'print':
        if (tab) tab.wc.print({}, () => {});
        break;
      case 'bookmarkPage':
        ctl.shell.send('open-star');
        break;
      case 'viewSource':
        if (tab && /^https?:/.test(tab.wc.getURL())) ctl.newTab({ url: `view-source:${tab.wc.getURL()}`, opener: tab });
        break;
      case 'zoomIn':
        if (tab) this.zoomTab(tab, 1);
        break;
      case 'zoomOut':
        if (tab) this.zoomTab(tab, -1);
        break;
      case 'zoomReset':
        if (tab) this.zoomTab(tab, 0);
        break;
      case 'devtools':
      case 'inspect':
        if (tab) {
          if (tab.wc.isDevToolsOpened()) tab.wc.closeDevTools();
          else tab.wc.openDevTools({ mode: 'detach' });
        }
        break;
      case 'history':
      case 'downloads':
      case 'bookmarks':
      case 'settings':
      case 'passwords':
      case 'about':
        this.openInternal(ctl, cmd);
        break;
      case 'clearData': {
        const t = this.openInternal(ctl, 'settings');
        if (t) t.wc.executeJavaScript("location.hash = '#privacy'", true).catch(() => {});
        break;
      }
      case 'toggleBookmarksBar':
        this.prefs.update({ showBookmarksBar: !this.prefs.get('showBookmarksBar') });
        break;
      case 'toggleFullscreen':
        ctl.win.setFullScreen(!ctl.win.isFullScreen());
        break;
      case 'menu':
        ctl.shell.focus();
        ctl.shell.send('open-menu');
        break;
      case 'tabSearch':
        ctl.shell.send('open-tab-search');
        break;
      case 'quit':
        app.quit();
        break;
      case 'hideApp':
        app.hide();
        break;
      case 'fillPassword':
        if (tab) this.autofill.fillBest(tab);
        break;
      case 'signin':
        ctl.shell.send('open-account');
        break;
      case 'passwordsPage':
        this.openInternal(ctl, 'passwords');
        break;
      default:
        log.debug('unknown command', { cmd });
    }
  }

  // ------------------------------------------------------------------------- shared shell state
  sharedShellState() {
    const prefs = this.prefs.all();
    const bar = prefs.showBookmarksBar ? this.bookmarks.children('toolbar').slice(0, 200).map((n) => ({ id: n.id, type: n.type, title: n.title, url: n.url })) : null;
    return {
      bookmarksBar: bar,
      showHomeButton: prefs.showHomeButton,
      engine: this.engine().name,
      downloads: this.downloads.summary(),
      account: this.account ? this.account.summary() : { phase: 'logged_out' },
      dev: this.dev,
      version: app.getVersion(),
    };
  }

  broadcastShared() {
    this.forEachWindow((w) => w.sendState());
  }

  onPrefsChange(keys) {
    if (keys.includes('theme')) {
      nativeTheme.themeSource = this.prefs.get('theme');
      this.forEachWindow((w) => w.applyTheme());
    }
    if (keys.includes('spellcheck')) this.session.setSpellCheckerEnabled(this.prefs.get('spellcheck'));
    this.broadcastShared();
    this.account && this.account.onPrefsChange(keys);
  }

  onDownloadsChange(ev) {
    this.broadcastShared();
    if (ev && ev.started) {
      const ctl = this.focusedWindow();
      if (ctl) ctl.shell.send('download-started');
    }
    this.forEachWindow((w) => {
      if (w.popup && w.popup.kind === 'downloads' && w.overlay) w.overlay.webContents.send('popup-data', { kind: 'downloads', data: this.downloads.list(30) });
    });
  }

  onPopupClosed(ctl, popup) {
    if (popup.kind === 'suggestions') ctl.shell.send('suggestions-closed');
    if (popup.kind === 'permission') {
      // closing the prompt without a decision = dismiss (deny this time)
      const tab = ctl.activeTab();
      const q = tab && this.pendingPermission.get(tab.id);
      if (q && q.length && popup.kind === 'permission' && !this.answering) {
        const r = q.shift();
        try {
          r.callback(false);
        } catch {
          /* gone */
        }
        if (!q.length) this.pendingPermission.delete(tab.id);
      }
    }
  }

  // ----------------------------------------------------------------------------------- IPC
  registerIpc() {
    ipcMain.handle('shell', async (e, cmd, args) => {
      const ctl = this.windowForShell(e.sender);
      if (!ctl || typeof cmd !== 'string') throw new Error('not allowed');
      return this.shellCommand(ctl, e.sender, cmd, args && typeof args === 'object' ? args : {});
    });
    ipcMain.handle('page', async (e, cmd, args) => {
      const frame = e.senderFrame;
      const tab = this.tabForWebContents(e.sender);
      if (!tab || !frame || frame !== e.sender.mainFrame || !/^ludworks:\/\//.test(frame.url)) throw new Error('not allowed');
      const page = new URL(frame.url).host;
      if (!INTERNAL_PAGES.includes(page)) throw new Error('not allowed');
      const { pageCommand } = await import('./pages-api.js');
      return pageCommand(this, tab, page, cmd, args && typeof args === 'object' ? args : {});
    });
    ipcMain.on('content', (e, cmd, args) => {
      const tab = this.tabForWebContents(e.sender);
      if (!tab || typeof cmd !== 'string') return;
      this.contentMessage(tab, e.senderFrame, cmd, args && typeof args === 'object' ? args : {});
    });
    ipcMain.handle('content-call', async (e, cmd, args) => {
      const tab = this.tabForWebContents(e.sender);
      if (!tab || typeof cmd !== 'string') throw new Error('not allowed');
      return this.contentCall(tab, e.senderFrame, cmd, args && typeof args === 'object' ? args : {});
    });
  }

  /** Fire-and-forget messages from the content preload of a tab. */
  contentMessage(tab, frame, cmd, args) {
    switch (cmd) {
      case 'shortcut':
        if (frame === tab.wc.mainFrame || frame) this.shortcuts.unhandled(tab.ctl, tab, args);
        break;
      default:
        this.autofill.contentMessage(tab, frame, cmd, args);
    }
  }

  /** Request/response calls from the content preload (passkeys, autofill). */
  async contentCall(tab, frame, cmd, args) {
    if (cmd.startsWith('webauthn.')) return this.passkeys.call(tab, frame, cmd, args);
    return this.autofill.contentCall(tab, frame, cmd, args);
  }

  async shellCommand(ctl, sender, cmd, a) {
    const tab = ctl.activeTab();
    const byId = (id) => ctl.tabById(Number(id));
    switch (cmd) {
      case 'ready':
        return ctl.state();
      case 'layout':
        if (sender === ctl.shell && Number.isFinite(a.top)) ctl.setTopInset(a.top);
        return null;
      case 'focus':
        ctl.shellFocused = !!a.focused;
        return null;
      case 'tab.new':
        ctl.newTab({ active: true });
        ctl.shell.send('focus-omnibox', { select: true });
        return null;
      case 'tab.close':
        ctl.closeTab(Number(a.id));
        return null;
      case 'tab.activate':
        ctl.activate(Number(a.id));
        if (this.pendingPermission.has(Number(a.id))) setTimeout(() => this.showPermissionPrompt(byId(a.id)), 50);
        return null;
      case 'tab.move':
        ctl.moveTab(Number(a.id), Number(a.index));
        return null;
      case 'tab.mute': {
        const t = byId(a.id);
        if (t) {
          t.wc.setAudioMuted(!t.wc.isAudioMuted());
          t.update();
        }
        return null;
      }
      case 'tab.menu':
        this.tabMenu(ctl, byId(a.id));
        return null;
      case 'nav':
        if (a.action === 'stop') {
          if (tab) tab.wc.stop();
        } else this.command(a.action, { ctl, tab });
        return null;
      case 'command':
        this.command(String(a.cmd), { ctl, tab, arg: a.arg });
        return null;
      case 'omnibox.commit': {
        ctl.hidePopup('suggestions');
        const disposition = ['current', 'new-tab', 'background-tab', 'new-window'].includes(a.disposition) ? a.disposition : 'current';
        const picked = Number.isInteger(a.index) && Array.isArray(ctl.suggestions) ? ctl.suggestions[a.index] : null;
        if (picked) return this.popupAction(ctl, 'suggestions', 'open', { url: picked.url, tabId: picked.tabId, disposition });
        this.navigateFromOmnibox(ctl, String(a.text || ''), disposition);
        return null;
      }
      case 'omnibox.input':
        return this.omniboxSuggest(ctl, String(a.text || '').slice(0, 2048), a.anchor);
      case 'omnibox.select':
        if (ctl.overlay && ctl.popup && ctl.popup.kind === 'suggestions') ctl.overlay.webContents.send('popup-select', Number(a.index));
        return null;
      case 'omnibox.close':
        ctl.hidePopup('suggestions');
        return null;
      case 'popup.open':
        return this.openPopup(ctl, String(a.kind), a.anchor || { x: 0, y: ctl.topInset, width: 320 }, a.data || {});
      case 'popup.size':
        ctl.resizePopup(Number(a.seq), Number(a.width), Number(a.height));
        return null;
      case 'popup.close':
        ctl.hidePopup(a.kind || null);
        return null;
      case 'popup.action':
        return this.popupAction(ctl, String(a.kind), String(a.action), a.data || {});
      case 'prompt.answer':
        ctl.answer(String(a.id), a.value === undefined ? null : a.value);
        return null;
      case 'find':
        if (!tab) return null;
        if (a.close) {
          tab.find = null;
          tab.wc.stopFindInPage('keepSelection');
          tab.update();
          tab.wc.focus();
        } else {
          const text = String(a.text || '').slice(0, 1000);
          tab.find = { text, matches: tab.find && tab.find.text === text ? tab.find.matches : 0, active: 0 };
          if (text) tab.wc.findInPage(text, { forward: a.forward !== false, findNext: !!a.next });
          else tab.wc.stopFindInPage('clearSelection');
          tab.update();
        }
        return null;
      case 'bookmark.open': {
        const n = this.bookmarks.get(String(a.id));
        if (n && n.url) this.openIn(ctl, n.url, a.disposition || 'current');
        return null;
      }
      case 'bookmark.folder':
        return this.openPopup(ctl, 'bookmark-folder', a.anchor, { id: String(a.id) });
      case 'win':
        if (a.action === 'minimize') ctl.win.minimize();
        else if (a.action === 'maximize') ctl.win.isMaximized() ? ctl.win.unmaximize() : ctl.win.maximize();
        else if (a.action === 'close') ctl.win.close();
        return null;
      case 'panel.action':
        return this.panelAction(ctl, a);
      case 'downloads.seen':
        this.downloads.markSeen();
        return null;
      default:
        if (cmd.startsWith('account.') || cmd.startsWith('vault.')) return this.account.shellCommand(ctl, cmd, a);
        if (cmd.startsWith('autofill.')) return this.autofill.shellCommand(ctl, cmd, a);
        if (cmd.startsWith('passkey.')) return this.passkeys.shellCommand(ctl, cmd, a);
        throw new Error(`unknown command ${cmd}`);
    }
  }

  tabMenu(ctl, tab) {
    if (!tab) return;
    const i = ctl.tabs.indexOf(tab);
    Menu.buildFromTemplate([
      { label: 'New tab to the right', click: () => ctl.newTab({ index: i + 1 }) },
      { type: 'separator' },
      { label: 'Reload', click: () => tab.reload() },
      { label: 'Duplicate', click: () => ctl.newTab({ url: tab.wc.getURL(), index: i + 1 }) },
      { label: tab.pinned ? 'Unpin' : 'Pin', click: () => { tab.pinned = !tab.pinned; ctl.moveTab(tab.id, tab.pinned ? ctl.tabs.filter((t) => t.pinned && t !== tab).length : i); tab.update(); } },
      { label: tab.wc.isAudioMuted() ? 'Unmute site' : 'Mute site', click: () => { tab.wc.setAudioMuted(!tab.wc.isAudioMuted()); tab.update(); } },
      { type: 'separator' },
      { label: 'Close', click: () => ctl.closeTab(tab.id) },
      { label: 'Close other tabs', enabled: ctl.tabs.length > 1, click: () => ctl.tabs.filter((t) => t !== tab && !t.pinned).forEach((t) => ctl.closeTab(t.id)) },
      { label: 'Close tabs to the right', enabled: i < ctl.tabs.length - 1, click: () => ctl.tabs.slice(i + 1).forEach((t) => ctl.closeTab(t.id)) },
      { type: 'separator' },
      { label: 'Reopen closed tab', enabled: ctl.closedTabs.length > 0, click: () => ctl.reopenClosedTab() },
    ]).popup({ window: ctl.win });
  }

  async omniboxSuggest(ctl, text, anchor) {
    const seq = (this.omniSeq = (this.omniSeq || 0) + 1);
    if (!text.trim()) {
      ctl.hidePopup('suggestions');
      return { inline: null };
    }
    const list = [];
    const seen = new Set();
    const push = (s) => {
      if (seen.has(s.url) || list.length >= 9) return;
      seen.add(s.url);
      list.push(s);
    };
    const f = fixupInput(text);
    const engine = this.engine();
    if (f && f.type === 'url') push({ kind: 'url', title: displayUrl(f.url), url: f.url, subtitle: 'Go to' });
    // Open tabs, bookmarks, history
    const t = text.toLowerCase();
    for (const w of this.windows) {
      for (const tb of w.tabs) {
        const u = tb.wc.isDestroyed() ? '' : tb.wc.getURL();
        if (!u || u.startsWith('ludworks://newtab')) continue;
        if ((tb.title || '').toLowerCase().includes(t) || u.toLowerCase().includes(t)) {
          if (list.filter((x) => x.kind === 'tab').length < 2) push({ kind: 'tab', title: tb.title || u, url: u, subtitle: 'Switch to tab', tabId: tb.id, windowPrivate: w.private });
        }
      }
    }
    for (const b of this.bookmarks.search(text, 3)) push({ kind: 'bookmark', title: b.title || b.url, url: b.url, subtitle: displayUrl(b.url) });
    for (const h of ctl.private ? [] : this.history.suggest(text, 5)) push({ kind: 'history', title: h.title || displayUrl(h.url), url: h.url, subtitle: displayUrl(h.url) });
    const searchItem = { kind: 'search', title: text, url: this.searchUrlFor(text), subtitle: `${engine.name} search` };
    if (!f || f.type === 'search') list.unshift(searchItem);
    else push(searchItem);
    const show = (items) => {
      if (seq !== this.omniSeq || !ctl.shellFocused) return;
      ctl.suggestions = items;
      const a = anchor && Number.isFinite(anchor.x) ? anchor : { x: 100, y: ctl.topInset - 4, width: 600 };
      if (ctl.popup && ctl.popup.kind === 'suggestions') ctl.overlay.webContents.send('popup-data', { kind: 'suggestions', data: { items } });
      else ctl.showPopup('suggestions', { items }, { x: a.x, y: a.y, width: a.width }, { focus: false, closeOnBlur: false });
    };
    show(list);
    // Search provider suggestions (not from private windows' typing unless enabled… never in private).
    if (this.prefs.get('searchSuggestions') && !ctl.private && (!f || f.type === 'search' || text.length < 40)) {
      const fetchImpl = (u, init) => this.session.fetch(u, { ...init, credentials: 'omit', bypassCustomProtocolHandlers: true });
      const sugg = await fetchSuggestions(engine, text, fetchImpl);
      if (seq !== this.omniSeq) return { inline: null };
      const extra = sugg.filter((s) => s.toLowerCase() !== t).slice(0, 4).map((s) => ({ kind: 'search', title: s, url: this.searchUrlFor(s), subtitle: `${engine.name} search` }));
      if (extra.length) {
        const merged = [...list];
        const at = merged.findIndex((x) => x.kind === 'search') + 1;
        merged.splice(at, 0, ...extra.filter((e) => !seen.has(e.url)));
        show(merged.slice(0, 10));
      }
    }
    const inline = list.find((x) => x.kind === 'history' || x.kind === 'bookmark');
    return { inline: inline ? inline.url : null };
  }

  async openPopup(ctl, kind, anchor, data) {
    const a = { x: Number(anchor.x) || 0, y: Number(anchor.y) || ctl.topInset, width: Number(anchor.width) || 320, align: anchor.align === 'right' ? 'right' : 'left' };
    const tab = ctl.activeTab();
    switch (kind) {
      case 'menu':
        return ctl.showPopup('menu', { private: ctl.private, zoom: tab ? Math.round(tab.wc.getZoomFactor() * 100) : 100, account: this.account.summary(), dev: this.dev }, { ...a, width: 300 });
      case 'downloads':
        this.downloads.markSeen();
        return ctl.showPopup('downloads', this.downloads.list(30), { ...a, width: 380 });
      case 'site-info': {
        const url = tab ? tab.wc.getURL() : '';
        const origin = originOf(url);
        return ctl.showPopup('site-info', { url, host: hostOf(url), security: tab ? tab.snapshot().security : 'other', error: tab && tab.error, permissions: origin ? this.permissions.forOrigin(origin) : [] }, { ...a, width: 340 });
      }
      case 'star': {
        if (!tab) return null;
        const url = tab.wc.getURL();
        if (!/^(https?|file|ftp):/i.test(url)) return null;
        let existing = this.bookmarks.findByUrl(url)[0];
        if (!existing) {
          const id = this.bookmarks.add({ parent: 'toolbar', type: 'url', title: tab.title || displayUrl(url), url });
          existing = this.bookmarks.get(id);
        }
        tab.update();
        return ctl.showPopup('star', { bookmark: existing, folders: this.folderList() }, { ...a, width: 340 });
      }
      case 'bookmark-folder': {
        const id = String(data.id);
        const items = this.bookmarks.children(id).map((n) => ({ id: n.id, type: n.type, title: n.title, url: n.url }));
        return ctl.showPopup('bookmark-folder', { id, items }, { ...a, width: 280 });
      }
      case 'account':
        return ctl.showPopup('account', this.account.summary(), { ...a, width: 340 });
      case 'key':
        return this.autofill.openKeyBubble(ctl, a);
      case 'tab-search':
        return ctl.showPopup('tab-search', { tabs: ctl.tabs.map((t) => ({ id: t.id, title: t.title, url: t.wc.getURL() })) }, { ...a, width: 380 });
      default:
        throw new Error(`unknown popup ${kind}`);
    }
  }

  folderList() {
    const out = [];
    const tree = this.bookmarks.tree();
    const walk = (node, depth) => {
      out.push({ id: node.id, title: node.title, depth });
      if (depth < 12) for (const c of node.children || []) if (c.type === 'folder') walk(c, depth + 1);
    };
    for (const id of Object.keys(ROOTS)) walk(tree[id], 0);
    return out;
  }

  async popupAction(ctl, kind, action, d) {
    const tab = ctl.activeTab();
    switch (`${kind}:${action}`) {
      case 'suggestions:open':
        ctl.hidePopup('suggestions');
        if (d.tabId) {
          for (const w of this.windows) {
            const t = w.tabById(Number(d.tabId));
            if (t) {
              w.activate(t.id);
              w.win.focus();
              return null;
            }
          }
        }
        if (typeof d.url === 'string') this.openIn(ctl, d.url, d.disposition || 'current', { typed: true });
        return null;
      case 'menu:command':
        ctl.hidePopup('menu');
        this.command(String(d.cmd), { ctl, tab, arg: d.arg });
        return null;
      case 'menu:zoom':
        if (tab) this.zoomTab(tab, Number(d.delta) || 0);
        return tab ? Math.round(tab.wc.getZoomFactor() * 100) : 100;
      case 'downloads:act':
        this.downloads.action(String(d.id), String(d.act));
        return this.downloads.list(30);
      case 'downloads:all':
        ctl.hidePopup('downloads');
        this.openInternal(ctl, 'downloads');
        return null;
      case 'permission:decide':
        this.answering = true;
        try {
          this.answerPermission(ctl, String(d.id), String(d.decision));
        } finally {
          this.answering = false;
        }
        return null;
      case 'site-info:reset': {
        const origin = originOf(tab ? tab.wc.getURL() : '');
        if (origin) this.permissions.clearOrigin(origin);
        ctl.hidePopup('site-info');
        return null;
      }
      case 'site-info:set': {
        const origin = originOf(tab ? tab.wc.getURL() : '');
        if (origin && typeof d.permission === 'string' && ['allow', 'deny', null].includes(d.decision)) this.permissions.set(origin, d.permission, d.decision);
        return origin ? this.permissions.forOrigin(origin) : [];
      }
      case 'star:save': {
        const id = String(d.id);
        if (typeof d.title === 'string') this.bookmarks.update(id, { title: d.title });
        if (typeof d.parent === 'string' && this.bookmarks.folderExists(d.parent)) {
          const n = this.bookmarks.get(id);
          if (n && n.parent !== d.parent) this.bookmarks.move(id, { parent: d.parent });
        }
        ctl.hidePopup('star');
        if (tab) tab.update();
        return null;
      }
      case 'star:remove':
        this.bookmarks.remove(String(d.id));
        ctl.hidePopup('star');
        if (tab) tab.update();
        return null;
      case 'star:more':
        ctl.hidePopup('star');
        this.openInternal(ctl, 'bookmarks');
        return null;
      case 'bookmark-folder:open': {
        ctl.hidePopup('bookmark-folder');
        const n = this.bookmarks.get(String(d.id));
        if (n && n.url) this.openIn(ctl, n.url, d.disposition || 'current');
        return null;
      }
      case 'bookmark-folder:children':
        return this.bookmarks.children(String(d.id)).map((n) => ({ id: n.id, type: n.type, title: n.title, url: n.url }));
      case 'tab-search:open':
        ctl.hidePopup('tab-search');
        ctl.activate(Number(d.id));
        return null;
      default:
        if (kind === 'account' || kind === 'unlock' || kind === 'signin') return this.account.popupAction(ctl, kind, action, d);
        if (kind === 'key' || kind === 'save-password' || kind === 'fill') return this.autofill.popupAction(ctl, kind, action, d);
        if (kind === 'passkey') return this.passkeys.popupAction(ctl, kind, action, d);
        throw new Error(`unknown popup action ${kind}:${action}`);
    }
  }

  panelAction(ctl, a) {
    const tab = ctl.tabById(Number(a.tabId));
    if (!tab) return null;
    switch (a.action) {
      case 'retry':
        tab.error = null;
        tab.update();
        tab.wc.reload();
        break;
      case 'back':
        tab.error = null;
        tab.update();
        if (tab.wc.navigationHistory.canGoBack()) tab.wc.navigationHistory.goBack();
        else tab.load(NEWTAB);
        break;
      case 'proceed':
        if (tab.error && tab.error.kind === 'cert' && tab.error.fingerprint) {
          this.allowCertificate(tab.error.host, tab.error.fingerprint);
          const url = tab.error.url;
          tab.error = null;
          tab.load(url);
        }
        break;
      case 'search':
        if (tab.error && tab.error.url) tab.load(this.searchUrlFor(hostOf(tab.error.url) || tab.error.url));
        break;
      default:
        break;
    }
    return null;
  }
}

function fingerprintMatches(cert, pinHex) {
  // Electron: "sha256/<base64>"; pins are stored as lowercase hex without separators.
  const m = /^sha256\/(.+)$/.exec(String(cert.fingerprint || ''));
  if (!m) return false;
  const hex = Buffer.from(m[1], 'base64').toString('hex');
  return hex === pinHex;
}

export { APP_NAME, ENGINES };
