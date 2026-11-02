// One browser tab: a sandboxed WebContentsView plus the navigation state the UI shows.

import { WebContentsView, Menu, clipboard, shell } from 'electron';
import { EventEmitter } from 'node:events';
import { displayUrl, securityState, hostOf, originOf } from './util/urls.js';
import { recordable } from './profile/history.js';
import { log } from './util/log.js';

let nextId = 1;
const MAX_FAVICON_BYTES = 256 * 1024;
const faviconCache = new Map(); // url → data URL (small LRU)

/**
 * Web content preferences shared by every tab and by the windows pages open themselves. The content
 * preload is not set here: it is registered on the session (Browser.setupSession), because Electron
 * does not run a webPreferences preload in window.open / target=_blank children.
 */
export function tabWebPreferences({ session, spellcheck }) {
  return {
    session,
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: true, // our (sandboxed, isolated) preload also runs in iframes
    webviewTag: false,
    enableWebSQL: false,
    plugins: true, // PDF viewer
    safeDialogs: true,
    spellcheck: !!spellcheck,
    autoplayPolicy: 'document-user-activation-required',
    navigateOnDragDrop: true,
    backgroundThrottling: true,
    scrollBounce: process.platform === 'darwin',
  };
}

export class Tab extends EventEmitter {
  /**
   * @param {{ctl: import('./window.js').WindowCtl, url?: string, webContents?: Electron.WebContents, opener?: Tab|null, pinned?: boolean}} o
   */
  constructor({ ctl, url = null, webContents = null, opener = null, pinned = false }) {
    super();
    this.id = nextId++;
    this.ctl = ctl;
    this.browser = ctl.browser;
    this.private = ctl.private;
    this.openerId = opener ? opener.id : null;
    this.pinned = pinned;
    this.view = webContents
      ? new WebContentsView({ webContents })
      : new WebContentsView({ webPreferences: tabWebPreferences({ session: ctl.session, spellcheck: this.browser.prefs.get('spellcheck') }) });
    this.wc = this.view.webContents;
    this.view.setBackgroundColor('#ffffff');
    this.view.setVisible(false);
    this.title = '';
    this.url = url || '';
    this.favicon = null;
    this.loading = false;
    this.audible = false;
    this.error = null; // {kind: 'net'|'cert'|'crash', code, description, url, host?}
    this.typedNavigation = false;
    this.lastActive = Date.now();
    this.find = null;
    this.destroyed = false;
    this.wire();
    if (url && !webContents) this.load(url);
  }

  // --------------------------------------------------------------------------------- state
  snapshot() {
    const wc = this.wc;
    const alive = !this.destroyed && !wc.isDestroyed();
    const url = alive ? wc.getURL() || this.url : this.url;
    const nh = alive ? wc.navigationHistory : null;
    return {
      id: this.id,
      title: this.title || (url ? displayUrl(url) : '') || 'New Tab',
      url,
      display: displayUrl(url),
      favicon: this.favicon,
      loading: this.loading,
      audible: this.audible,
      muted: alive ? wc.isAudioMuted() : false,
      pinned: this.pinned,
      security: this.error && this.error.kind === 'cert-allowed' ? 'dangerous' : securityState(url),
      canGoBack: !!(nh && nh.canGoBack()),
      canGoForward: !!(nh && nh.canGoForward()),
      zoom: alive ? Math.round(wc.getZoomFactor() * 100) : 100,
      error: this.error,
      bookmarked: url ? this.browser.bookmarks.isBookmarked(url) : false,
      find: this.find,
      agent: !!this.agentOwned,
    };
  }

  update() {
    if (!this.destroyed) this.emit('update', this);
  }

  // ---------------------------------------------------------------------------- navigation
  load(url, { typed = false } = {}) {
    // a site that opens in its separate process (separate.js) does not load here
    if (this.browser.separate && this.browser.separate.interceptLoad(this, url)) return;
    this.error = null;
    this.typedNavigation = typed;
    this.url = url;
    this.wc.loadURL(url).catch((e) => {
      // Failures are reported through did-fail-load; aborted loads (ERR_ABORTED) are normal.
      if (e && e.code !== 'ERR_ABORTED') log.debug('loadURL failed', { code: e.code });
    });
    this.update();
  }

  reload(hard = false) {
    this.error = null;
    if (hard) this.wc.reloadIgnoringCache();
    else this.wc.reload();
    this.update();
  }

  // ---------------------------------------------------------------------------------- wiring
  wire() {
    const wc = this.wc;
    wc.setWindowOpenHandler((details) => this.ctl.browser.handleWindowOpen(this, details));

    wc.on('did-start-loading', () => {
      this.loading = true;
      this.update();
    });
    wc.on('did-stop-loading', () => {
      this.loading = false;
      this.update();
    });
    wc.on('did-start-navigation', (d) => {
      if (d.isMainFrame && !d.isSameDocument) {
        this.error = null;
        this.find = null;
        this.update();
      }
    });
    wc.on('did-navigate', (_e, url, httpCode) => {
      this.url = url;
      this.favicon = null;
      if (!this.error || this.error.url !== url) this.error = this.error && this.error.kind === 'cert-allowed' && hostOf(url) === this.error.host ? this.error : null;
      // AI agents' browsing (agent/agent.js) stays out of the user's history
      if (!this.private && !this.agentOwned && recordable(url) && httpCode !== 204) {
        this.browser.history.addVisit({ url, title: '', typed: this.typedNavigation });
      }
      this.typedNavigation = false;
      this.browser.applyStoredZoom(this);
      const af = this.browser.autofill && this.browser.autofill.tabs.get(this.id);
      if (af) {
        af.frames.clear();
        af.dropdown = null;
      }
      if (this.browser.autofill) this.browser.autofill.refreshTab(this);
      this.update();
    });
    wc.on('did-navigate-in-page', (_e, url, isMainFrame) => {
      if (!isMainFrame) return;
      this.url = url;
      this.update();
    });
    wc.on('page-title-updated', (_e, title) => {
      this.title = title;
      const url = wc.getURL();
      if (!this.private && !this.agentOwned) this.browser.history.setTitle(url, title);
      this.update();
    });
    wc.on('page-favicon-updated', (_e, favicons) => this.loadFavicon(favicons));
    wc.on('did-fail-load', (_e, code, description, url, isMainFrame) => {
      if (!isMainFrame || code === -3) return; // -3 = ERR_ABORTED (user stopped, or replaced by another navigation)
      if (this.error && this.error.kind === 'cert') return; // already showing the certificate interstitial
      this.error = { kind: 'net', code, description, url };
      this.loading = false;
      this.update();
    });
    wc.on('certificate-error', (event, url, error, certificate, callback, isMainFrame) => {
      event.preventDefault();
      const host = hostOf(url);
      if (this.browser.certAllowed(host, certificate)) {
        if (isMainFrame) this.error = { kind: 'cert-allowed', host, url };
        callback(true);
        this.update();
        return;
      }
      callback(false);
      if (isMainFrame) {
        this.error = { kind: 'cert', code: error, description: error, url, host, fingerprint: certificate.fingerprint, issuer: certificate.issuerName, subject: certificate.subjectName };
        this.loading = false;
        this.update();
      }
    });
    wc.on('render-process-gone', (_e, details) => {
      if (details.reason === 'clean-exit') return;
      this.error = { kind: 'crash', code: details.reason, description: `The page crashed (${details.reason}).`, url: this.url };
      this.loading = false;
      this.audible = false;
      this.update();
    });
    wc.on('audio-state-changed', (e) => {
      this.audible = !!e.audible;
      this.update();
    });
    wc.on('enter-html-full-screen', () => this.ctl.setHtmlFullscreen(this, true));
    wc.on('leave-html-full-screen', () => this.ctl.setHtmlFullscreen(this, false));
    wc.on('found-in-page', (_e, r) => {
      if (!this.find) return;
      this.find = { ...this.find, matches: r.matches, active: r.activeMatchOrdinal };
      this.update();
    });
    wc.on('zoom-changed', (_e, dir) => this.browser.zoomTab(this, dir === 'in' ? 1 : -1));
    wc.on('context-menu', (_e, params) => this.contextMenu(params));
    wc.on('before-input-event', (event, input) => this.browser.shortcuts.handle(event, input, this.ctl, this));
    wc.on('will-prevent-unload', (event) => {
      if (this.browser.confirmLeave(this)) event.preventDefault();
    });
    wc.on('login', (event, details, authInfo, callback) => {
      event.preventDefault();
      this.ctl.promptHttpAuth(this, details, authInfo).then((cred) => (cred ? callback(cred.username, cred.password) : callback()));
    });
    wc.on('select-client-certificate', (event, _url, _list, callback) => {
      // No client certificate is sent without a picker (not implemented yet): never hand one out silently.
      event.preventDefault();
      callback();
    });
    wc.on('devtools-open-url', (_e, url) => this.ctl.newTab({ url, active: true, opener: this }));
    wc.on('will-navigate', (d) => this.guardNavigation(d));
    wc.on('will-frame-navigate', (d) => this.guardNavigation(d));
    wc.on('did-create-window', () => {});
  }

  /** Web content may not navigate to internal or shell pages (only the user can, from the address bar). */
  guardNavigation(d) {
    const target = String(d.url || '');
    // Pages and frames of installed extensions (their own pages, web-accessible iframes such as a password
    // manager's inline menu): Chromium itself enforces web_accessible_resources for loads from websites.
    if (/^chrome-extension:/i.test(target) && this.browser.extensions && this.browser.extensions.isInstalledUrl(target)) return;
    if (/^(lwshell|chrome|devtools|chrome-extension):/i.test(target)) return d.preventDefault();
    if (/^ludworks:/i.test(target)) {
      const from = d.initiator ? d.initiator.url || '' : this.wc.getURL();
      if (!/^ludworks:/i.test(from)) d.preventDefault();
    }
  }

  async loadFavicon(list) {
    const url = (list || []).find((u) => /^(https?|data):/i.test(u));
    if (!url) return;
    if (url.startsWith('data:image/')) {
      if (url.length <= MAX_FAVICON_BYTES * 1.4) this.favicon = url;
      this.update();
      return;
    }
    if (faviconCache.has(url)) {
      this.favicon = faviconCache.get(url);
      this.update();
      return;
    }
    const pageUrl = this.wc.getURL();
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      // No cookies: Electron's fetch would send all of them, SameSite=Strict included, wherever the page points its icon.
      const res = await this.ctl.session.fetch(url, { signal: ctrl.signal, credentials: 'omit', headers: { Accept: 'image/*' }, referrer: originOf(pageUrl) || undefined });
      clearTimeout(timer);
      if (!res.ok) return;
      const type = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
      if (!/^image\/(png|x-icon|vnd\.microsoft\.icon|gif|jpeg|webp|svg\+xml|avif|bmp)$/.test(type)) return;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > MAX_FAVICON_BYTES) return;
      const dataUrl = `data:${type};base64,${buf.toString('base64')}`;
      faviconCache.set(url, dataUrl);
      if (faviconCache.size > 500) faviconCache.delete(faviconCache.keys().next().value);
      if (!this.destroyed && this.wc.getURL() === pageUrl) {
        this.favicon = dataUrl;
        this.update();
      }
    } catch {
      /* no favicon */
    }
  }

  // --------------------------------------------------------------------------- context menu
  contextMenu(p) {
    const items = [];
    const sep = () => items.length && items[items.length - 1].type !== 'separator' && items.push({ type: 'separator' });
    const b = this.browser;
    if (p.misspelledWord && p.dictionarySuggestions) {
      for (const s of p.dictionarySuggestions.slice(0, 5)) items.push({ label: s, click: () => this.wc.replaceMisspelling(s) });
      if (!p.dictionarySuggestions.length) items.push({ label: 'No spelling suggestions', enabled: false });
      items.push({ label: 'Add to dictionary', click: () => this.wc.session.addWordToSpellCheckerDictionary(p.misspelledWord) });
      sep();
    }
    if (p.linkURL) {
      const link = p.linkURL;
      const isJs = /^javascript:/i.test(link);
      if (!isJs) {
        items.push({ label: 'Open link in new tab', click: () => this.ctl.newTab({ url: link, active: false, opener: this }) });
        items.push({ label: 'Open link in new window', click: () => b.newWindow({ urls: [link] }) });
        if (!this.private) items.push({ label: 'Open link in private window', click: () => b.newWindow({ urls: [link], private: true }) });
        sep();
        items.push({ label: 'Save link as…', click: () => this.wc.downloadURL(link) });
      }
      items.push({ label: 'Copy link address', click: () => clipboard.writeText(link) });
      sep();
    }
    if (p.mediaType === 'image' && p.srcURL) {
      items.push({ label: 'Open image in new tab', click: () => this.ctl.newTab({ url: p.srcURL, active: false, opener: this }) });
      items.push({ label: 'Save image as…', click: () => this.wc.downloadURL(p.srcURL) });
      items.push({ label: 'Copy image', click: () => this.wc.copyImageAt(p.x, p.y) });
      items.push({ label: 'Copy image address', click: () => clipboard.writeText(p.srcURL) });
      sep();
    }
    if ((p.mediaType === 'video' || p.mediaType === 'audio') && p.srcURL && !p.srcURL.startsWith('blob:')) {
      items.push({ label: `Open ${p.mediaType} in new tab`, click: () => this.ctl.newTab({ url: p.srcURL, active: false, opener: this }) });
      items.push({ label: `Save ${p.mediaType} as…`, click: () => this.wc.downloadURL(p.srcURL) });
      sep();
    }
    if (p.mediaType === 'video' && p.mediaFlags && p.mediaFlags.canShowPictureInPicture) {
      items.push({
        label: p.mediaFlags.isShowingPictureInPicture ? 'Exit picture in picture' : 'Picture in picture',
        click: () => this.browser.togglePictureInPicture(this, p),
      });
      sep();
    }
    if (p.isEditable) {
      const f = p.editFlags;
      if (b.autofill.isLoginField(this, p)) {
        items.push({ label: 'Fill password from Ludworks…', click: () => b.autofill.openFillMenu(this, p) });
        items.push({ label: 'Generate strong password', click: () => b.autofill.generateInto(this, p) });
        sep();
      }
      items.push({ role: 'undo', enabled: f.canUndo }, { role: 'redo', enabled: f.canRedo });
      sep();
      items.push({ role: 'cut', enabled: f.canCut }, { role: 'copy', enabled: f.canCopy }, { role: 'paste', enabled: f.canPaste });
      items.push({ role: 'pasteAndMatchStyle', label: 'Paste as plain text', enabled: f.canPaste });
      items.push({ role: 'selectAll', enabled: f.canSelectAll });
      sep();
    } else if (p.selectionText && p.selectionText.trim()) {
      const text = p.selectionText.trim();
      const short = text.length > 30 ? `${text.slice(0, 30)}…` : text;
      items.push({ role: 'copy' });
      items.push({ label: `Search ${b.engine().name} for “${short}”`, click: () => this.ctl.newTab({ url: b.searchUrlFor(text), active: true, opener: this }) });
      sep();
    }
    if (!p.linkURL && !p.isEditable && !p.selectionText && p.mediaType === 'none') {
      const nh = this.wc.navigationHistory;
      items.push({ label: 'Back', enabled: nh.canGoBack(), click: () => nh.goBack() });
      items.push({ label: 'Forward', enabled: nh.canGoForward(), click: () => nh.goForward() });
      items.push({ label: 'Reload', click: () => this.reload() });
      sep();
      items.push({ label: 'Save as…', click: () => b.savePage(this) });
      items.push({ label: 'Print…', click: () => this.wc.print() });
      sep();
      if (/^https?:/.test(this.wc.getURL())) items.push({ label: 'View page source', click: () => this.ctl.newTab({ url: `view-source:${this.wc.getURL()}`, active: true, opener: this }) });
    }
    for (const f of b.features) {
      if (!f.contextMenuItems) continue;
      try {
        const extra = f.contextMenuItems(this, p) || [];
        if (extra.length) {
          sep();
          items.push(...extra);
        }
      } catch (e) {
        log.warn('context menu items failed', { feature: f.name, message: e.message });
      }
    }
    sep();
    items.push({ label: 'Inspect', click: () => this.wc.inspectElement(p.x, p.y) });
    Menu.buildFromTemplate(items).popup({ window: this.ctl.win, frame: p.frame || undefined });
  }

  // ------------------------------------------------------------------------------- teardown
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.removeAllListeners();
    try {
      if (!this.wc.isDestroyed()) this.wc.close();
    } catch (e) {
      log.debug('tab close failed', { message: e.message });
    }
  }
}

export function openExternalSafely(url) {
  if (/^(https?|mailto):/i.test(url)) shell.openExternal(url).catch(() => {});
}
