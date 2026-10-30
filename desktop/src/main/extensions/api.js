// Main-process side of the chrome.* APIs that Electron does not implement (the extension preload calls
// these through the bridge). The calling extension is `ext` (from the sender, see bridge.js); every
// method checks that extension's permissions here, not in the extension's world.
//
// Tab IDs are web contents IDs (what Electron's own tabs/scripting/messaging use), window IDs are
// BrowserWindow IDs. Private windows do not exist for extensions (like Chrome's default).

import { Notification, nativeImage, webFrameMain } from 'electron';
import { randomUUID } from 'node:crypto';
import { matchesPattern, isAllSites, cookieDomainUrl, queryPatternMatch, parseColor, globRe } from './manifest.js';
import { STORE_ORIGIN } from './webstore.js';
import { resolveShortcut } from '../shortcuts.js';
import { log } from '../util/log.js';

const WINDOW_ID_NONE = -1;
const WINDOW_ID_CURRENT = -2;
const MAX_MENU_ITEMS = 1000;
const MIN_ALARM_MS = 30 * 1000;

const fail = (msg) => {
  throw new Error(msg);
};
const isObj = (o) => !!o && typeof o === 'object' && !Array.isArray(o);


export class Api {
  /** @param {import('./extensions.js').Extensions} mgr */
  constructor(mgr) {
    this.mgr = mgr;
    this.b = mgr.b;
    this.snaps = new WeakMap(); // tab → last state sent with tabs.onUpdated
    this.activeTab = new Map(); // ext id → Set(tab wc id) with a temporary activeTab grant
    this.notifications = new Map(); // `${ext}\n${id}` → Notification
    this.seenWindows = new WeakSet();
    this.alarmTimer = null;
    this.tabMapTimer = null;
    this.webRequestOn = false;
  }

  /** Runs one API call from an extension context. */
  async call(ctx, method, args) {
    const ext = this.mgr.loaded.get(ctx.extId);
    if (!ext) fail('The extension is not loaded.');
    const fn = METHODS[method];
    if (!fn) fail(`${method} is not supported in Ludworks Browser.`);
    return fn.call(this, ctx, ext, ...args);
  }

  // ======================================================================== windows and tabs
  windows() {
    return [...this.b.windows].filter((w) => !w.destroyed && !w.private && !w.win.isDestroyed());
  }

  lastFocused() {
    const w = this.b.focusedWindow({ allowPrivate: false });
    return w && !w.private && !w.destroyed ? w : null;
  }

  winById(id, ctx) {
    if (id === WINDOW_ID_CURRENT || id === null || id === undefined) return ctx ? this.ctxWindow(ctx) : this.lastFocused();
    return this.windows().find((w) => w.win.id === id) || null;
  }

  liveTabs(ctl) {
    return ctl.tabs.filter((t) => !t.destroyed && !t.wc.isDestroyed());
  }

  tabById(id) {
    if (!Number.isInteger(id)) return null;
    for (const w of this.windows()) for (const t of w.tabs) if (!t.destroyed && !t.wc.isDestroyed() && t.wc.id === id) return t;
    return null;
  }

  needTab(id) {
    const t = this.tabById(id);
    if (!t) fail(`No tab with id: ${id}.`);
    return t;
  }

  /** The tab an extension page is shown in (options page in a tab), else null. */
  ctxTab(ctx) {
    if (ctx.kind !== 'frame') return null;
    const t = this.b.tabForWebContents(ctx.wc);
    return t && !t.private ? t : null;
  }

  /** "Current window" of a context: its tab's or popup's window, else the last focused window. */
  ctxWindow(ctx) {
    if (ctx && ctx.kind === 'frame') {
      const t = this.ctxTab(ctx);
      if (t) return t.ctl;
      const p = this.mgr.views.byWebContents(ctx.wc);
      if (p && !p.ctl.destroyed) return p.ctl;
    }
    return this.lastFocused();
  }

  hasHost(ext, url) {
    return ext.hostPatterns.some((p) => matchesPattern(p, url));
  }

  canSeeTab(ext, tab, url) {
    if (ext.apiPerms.has('tabs')) return true;
    const g = this.activeTab.get(ext.id);
    if (g && g.has(tab.wc.id)) return true;
    return this.hasHost(ext, url);
  }

  grantActiveTab(ext, tab) {
    if (!ext || !tab || !ext.apiPerms.has('activeTab')) return;
    let g = this.activeTab.get(ext.id);
    if (!g) this.activeTab.set(ext.id, (g = new Set()));
    g.add(tab.wc.id);
  }

  tabObj(ext, tab) {
    const ctl = tab.ctl;
    const wc = tab.wc;
    const alive = !tab.destroyed && !wc.isDestroyed();
    const url = alive ? wc.getURL() || tab.url : tab.url;
    const active = ctl.activeId === tab.id;
    const o = {
      id: alive ? wc.id : -1,
      index: ctl.tabs.indexOf(tab),
      windowId: ctl.win.isDestroyed() ? WINDOW_ID_NONE : ctl.win.id,
      highlighted: active,
      active,
      selected: active,
      pinned: !!tab.pinned,
      audible: alive && wc.isCurrentlyAudible(),
      discarded: false,
      autoDiscardable: true,
      frozen: false,
      mutedInfo: { muted: alive && wc.isAudioMuted() },
      incognito: false,
      status: tab.loading ? 'loading' : 'complete',
      lastAccessed: tab.lastActive || Date.now(),
      groupId: -1,
      splitViewId: -1,
    };
    try {
      const bnd = tab.view.getBounds();
      o.width = bnd.width;
      o.height = bnd.height;
    } catch {
      /* view gone */
    }
    if (tab.openerId) {
      const op = ctl.tabById(tab.openerId);
      if (op && !op.wc.isDestroyed()) o.openerTabId = op.wc.id;
    }
    if (this.canSeeTab(ext, tab, url)) {
      o.url = url;
      o.title = tab.title || '';
      if (tab.favicon && tab.favicon.length <= 96 * 1024) o.favIconUrl = tab.favicon;
      if (tab.loading && tab.url && tab.url !== url) o.pendingUrl = tab.url;
    }
    return o;
  }

  winObj(ext, ctl, { populate = false } = {}) {
    const w = ctl.win;
    const b = w.getBounds();
    const o = {
      id: w.id,
      focused: w.isFocused(),
      top: b.y,
      left: b.x,
      width: b.width,
      height: b.height,
      incognito: false,
      type: ctl.extWindowType || 'normal',
      state: w.isFullScreen() ? 'fullscreen' : w.isMinimized() ? 'minimized' : w.isMaximized() ? 'maximized' : 'normal',
      alwaysOnTop: w.isAlwaysOnTop(),
    };
    if (populate) o.tabs = this.liveTabs(ctl).map((t) => this.tabObj(ext, t));
    return o;
  }

  /** Compact tab info pushed to extension contexts (fixes Electron's sender.tab). */
  tabMap() {
    const tabs = {};
    for (const w of this.windows()) {
      for (const t of this.liveTabs(w)) {
        const active = w.activeId === t.id;
        tabs[t.wc.id] = { windowId: w.win.id, index: w.tabs.indexOf(t), active, highlighted: active, selected: active, pinned: !!t.pinned, incognito: false, status: t.loading ? 'loading' : 'complete' };
      }
    }
    return { tabs, notTabs: this.mgr.extensionViewIds() };
  }

  pushTabMap() {
    clearTimeout(this.tabMapTimer);
    this.tabMapTimer = setTimeout(() => this.mgr.bridge.broadcast('__tabs', [this.tabMap()]), 30);
  }

  /** URL an extension may open in a tab (relative URLs are relative to the extension). */
  resolveUrl(ext, raw) {
    let url;
    try {
      url = new URL(String(raw), `chrome-extension://${ext.id}/`).href;
    } catch {
      fail(`Invalid url: "${String(raw).slice(0, 200)}".`);
    }
    if (/^chrome:\/\/extensions/i.test(url)) return 'ludworks://extensions/';
    if (/^chrome:\/\/newtab/i.test(url) || /^ludworks:\/\/newtab\/?$/i.test(url)) return this.b.newTabUrl();
    if (/^(https?|ftp):/i.test(url) || url === 'about:blank') return url;
    const m = /^chrome-extension:\/\/([a-p]{32})\//.exec(url);
    if (m && (m[1] === ext.id || this.mgr.loaded.has(m[1]))) return url;
    fail(`Extensions cannot open ${url.split(':')[0]}: URLs here.`);
  }

  emitAll(name, argsFor, opts) {
    for (const ext of this.mgr.loaded.values()) {
      if (!this.mgr.bridge.listening(ext.id, name)) continue;
      let args;
      try {
        args = argsFor(ext);
      } catch (e) {
        log.debug('extension event args failed', { name, message: e.message });
        args = null;
      }
      if (args) this.mgr.bridge.emit(ext.id, name, args, opts);
    }
  }

  // ------------------------------------------------------------------ tab and window lifecycle
  watchWindow(ctl) {
    if (ctl.private || this.seenWindows.has(ctl)) return;
    this.seenWindows.add(ctl);
    const w = ctl.win;
    const id = w.id;
    this.emitAll('windows.onCreated', (ext) => [this.winObj(ext, ctl)]);
    w.on('focus', () => this.emitAll('windows.onFocusChanged', () => [id]));
    w.on('blur', () =>
      setTimeout(() => {
        if (!this.windows().some((x) => x.win.isFocused())) this.emitAll('windows.onFocusChanged', () => [WINDOW_ID_NONE]);
      }, 50),
    );
    let boundsTimer = null;
    const bounds = () => {
      clearTimeout(boundsTimer);
      boundsTimer = setTimeout(() => !w.isDestroyed() && this.emitAll('windows.onBoundsChanged', (ext) => [this.winObj(ext, ctl)]), 300);
    };
    w.on('resize', bounds);
    w.on('move', bounds);
    w.once('closed', () => {
      clearTimeout(boundsTimer);
      this.emitAll('windows.onRemoved', () => [id]);
      this.mgr.views.closeIn(ctl);
    });
    ctl.shell.on('before-input-event', (e, input) => this.onKey(e, input, ctl, null));
  }

  onTabCreated(tab) {
    if (tab.private) return;
    this.watchWindow(tab.ctl);
    const wc = tab.wc;
    const wcId = wc.id;
    const ctl = tab.ctl;
    // Chrome's order: the tab exists (index, URL) before onCreated
    setImmediate(() => {
      if (tab.destroyed || wc.isDestroyed()) return;
      this.snaps.set(tab, this.snapOf(tab));
      this.emitAll('tabs.onCreated', (ext) => [this.tabObj(ext, tab)]);
      if (tab.openerId) {
        const op = ctl.tabById(tab.openerId);
        if (op && !op.wc.isDestroyed()) this.emitAll('webNavigation.onCreatedNavigationTarget', (ext) => (ext.apiPerms.has('webNavigation') ? [{ sourceTabId: op.wc.id, sourceProcessId: -1, sourceFrameId: 0, tabId: wcId, url: wc.getURL() || tab.url || '', timeStamp: Date.now() }] : null));
      }
      if (ctl.activeId === tab.id) this.emitAll('tabs.onActivated', () => [{ tabId: wcId, windowId: ctl.win.id }]);
      this.pushTabMap();
    });
    tab.on('update', () => this.onTabUpdate(tab));
    wc.on('did-navigate', () => this.onMainFrameCommit(tab));
    // tab.ctl, not ctl: the tab may have moved to another window since (Browser.moveTabToWindow)
    wc.once('destroyed', () => {
      const closing = tab.ctl.destroyed || tab.ctl.win.isDestroyed();
      const windowId = tab.ctl.win.isDestroyed() ? WINDOW_ID_NONE : tab.ctl.win.id;
      for (const ext of this.mgr.loaded.values()) {
        if (ext.action) ext.action.tabs.delete(wcId);
        const g = this.activeTab.get(ext.id);
        if (g) g.delete(wcId);
      }
      this.emitAll('tabs.onRemoved', () => [wcId, { windowId, isWindowClosing: closing }]);
      this.pushTabMap();
    });
    wc.on('before-input-event', (e, input) => this.onKey(e, input, tab.ctl, tab));
    this.watchNavigation(tab);
  }

  /** A tab moved from window `from` (where it was at `fromIndex`) to tab.ctl: Chrome's detach / attach events. */
  onTabMoved(tab, from, fromIndex) {
    if (tab.private || tab.wc.isDestroyed()) return;
    const to = tab.ctl;
    this.watchWindow(to); // a window made for the tab (dragged out) has had no tab created in it
    const wcId = tab.wc.id;
    const oldWindowId = from.win.isDestroyed() ? WINDOW_ID_NONE : from.win.id;
    this.emitAll('tabs.onDetached', () => [wcId, { oldWindowId, oldPosition: fromIndex }]);
    this.emitAll('tabs.onAttached', () => [wcId, { newWindowId: to.win.id, newPosition: to.tabs.indexOf(tab) }]);
    if (to.activeId === tab.id) this.emitAll('tabs.onActivated', () => [{ tabId: wcId, windowId: to.win.id }]);
    const next = !from.destroyed && from.activeTab();
    if (next && !next.wc.isDestroyed()) this.emitAll('tabs.onActivated', () => [{ tabId: next.wc.id, windowId: oldWindowId }]);
    this.pushTabMap();
  }

  onTabSwitch(ctl, from, to) {
    if (ctl.private || !to || to.wc.isDestroyed()) return;
    this.mgr.views.closeIn(ctl);
    const tabId = to.wc.id;
    this.emitAll('tabs.onActivated', () => [{ tabId, windowId: ctl.win.id }]);
    this.emitAll('tabs.onHighlighted', () => [{ windowId: ctl.win.id, tabIds: [tabId] }]);
    this.pushTabMap();
  }

  snapOf(tab) {
    const wc = tab.wc;
    return { url: wc.getURL() || tab.url || '', title: tab.title || '', favicon: tab.favicon || null, status: tab.loading ? 'loading' : 'complete', pinned: !!tab.pinned, muted: wc.isAudioMuted(), audible: !!tab.audible };
  }

  onTabUpdate(tab) {
    if (tab.destroyed || tab.wc.isDestroyed()) return;
    const snap = this.snapOf(tab);
    const prev = this.snaps.get(tab);
    this.snaps.set(tab, snap);
    if (!prev) return;
    const change = {};
    if (snap.status !== prev.status) change.status = snap.status;
    if (snap.url !== prev.url) change.url = snap.url;
    if (snap.title !== prev.title) change.title = snap.title;
    if (snap.favicon !== prev.favicon && snap.favicon && snap.favicon.length <= 96 * 1024) change.favIconUrl = snap.favicon;
    if (snap.pinned !== prev.pinned) change.pinned = snap.pinned;
    if (snap.muted !== prev.muted) change.mutedInfo = { muted: snap.muted };
    if (snap.audible !== prev.audible) change.audible = snap.audible;
    if (!Object.keys(change).length) return;
    if (change.pinned !== undefined || change.status !== undefined) this.pushTabMap();
    const tabId = tab.wc.id;
    this.emitAll('tabs.onUpdated', (ext) => {
      const c = { ...change };
      if (!this.canSeeTab(ext, tab, snap.url)) {
        delete c.url;
        delete c.title;
        delete c.favIconUrl;
      }
      return Object.keys(c).length ? [tabId, c, this.tabObj(ext, tab)] : null;
    });
  }

  /** A new document in a tab: tab-specific action values and activeTab grants end (like Chrome). */
  onMainFrameCommit(tab) {
    const id = tab.wc.id;
    let changed = false;
    for (const ext of this.mgr.loaded.values()) {
      if (ext.action && ext.action.tabs.delete(id)) changed = true;
      const g = this.activeTab.get(ext.id);
      if (g) g.delete(id);
    }
    if (changed && tab.ctl.activeId === tab.id) this.mgr.refreshToolbar(tab.ctl);
  }

  // ------------------------------------------------------------------------------ webNavigation
  frameIdOf(wc, frame) {
    if (!frame || frame === wc.mainFrame) return 0;
    return frame.frameTreeNodeId;
  }

  frameInfo(wc, frame) {
    const parent = frame.parent;
    return { frameId: this.frameIdOf(wc, frame), parentFrameId: parent ? this.frameIdOf(wc, parent) : -1, processId: frame.processId, url: frame.url, errorOccurred: false, frameType: parent ? 'sub_frame' : 'outermost_frame', documentLifecycle: 'active' };
  }

  watchNavigation(tab) {
    const wc = tab.wc;
    const navEmit = (name, build) => {
      if (tab.destroyed || wc.isDestroyed()) return;
      this.emitAll(`webNavigation.${name}`, (ext) => {
        if (!ext.apiPerms.has('webNavigation')) return null;
        const d = build();
        if (!d || !d.url || /^(ludworks|lwshell|devtools|chrome):/i.test(d.url)) return null;
        return [{ tabId: wc.id, timeStamp: Date.now(), ...d }];
      });
    };
    const fromIds = (pid, rid) => {
      try {
        return webFrameMain.fromId(pid, rid);
      } catch {
        return null;
      }
    };
    wc.on('did-start-navigation', (d) => {
      if (d.isSameDocument) return;
      const f = d.frame;
      navEmit('onBeforeNavigate', () => ({ url: d.url, processId: -1, frameId: d.isMainFrame ? 0 : f ? f.frameTreeNodeId : -1, parentFrameId: d.isMainFrame ? -1 : f && f.parent ? this.frameIdOf(wc, f.parent) : 0, frameType: d.isMainFrame ? 'outermost_frame' : 'sub_frame' }));
    });
    wc.on('did-frame-navigate', (_e, url, _code, _text, isMainFrame, pid, rid) => {
      const f = fromIds(pid, rid);
      navEmit('onCommitted', () => ({ url, processId: pid, frameId: isMainFrame ? 0 : f ? f.frameTreeNodeId : -1, parentFrameId: isMainFrame ? -1 : f && f.parent ? this.frameIdOf(wc, f.parent) : 0, transitionType: tab.typedNavigation ? 'typed' : 'link', transitionQualifiers: [], frameType: isMainFrame ? 'outermost_frame' : 'sub_frame' }));
    });
    wc.on('dom-ready', () => navEmit('onDOMContentLoaded', () => ({ url: wc.getURL(), processId: wc.mainFrame.processId, frameId: 0, parentFrameId: -1, frameType: 'outermost_frame' })));
    wc.on('did-frame-finish-load', (_e, isMainFrame, pid, rid) => {
      const f = fromIds(pid, rid);
      navEmit('onCompleted', () => ({ url: f ? f.url : wc.getURL(), processId: pid, frameId: isMainFrame ? 0 : f ? f.frameTreeNodeId : -1, parentFrameId: isMainFrame ? -1 : f && f.parent ? this.frameIdOf(wc, f.parent) : 0, frameType: isMainFrame ? 'outermost_frame' : 'sub_frame' }));
    });
    wc.on('did-fail-load', (_e, code, desc, url, isMainFrame, pid, rid) => {
      if (code === -3) return;
      const f = fromIds(pid, rid);
      navEmit('onErrorOccurred', () => ({ url, processId: pid, frameId: isMainFrame ? 0 : f ? f.frameTreeNodeId : -1, parentFrameId: isMainFrame ? -1 : 0, error: `net::${String(desc || code)}` }));
    });
    let lastUrl = '';
    wc.on('did-navigate', (_e, url) => {
      lastUrl = url;
    });
    wc.on('did-navigate-in-page', (_e, url, isMainFrame, pid, rid) => {
      const f = fromIds(pid, rid);
      const sameButHash = isMainFrame && lastUrl && lastUrl.split('#')[0] === url.split('#')[0];
      if (isMainFrame) lastUrl = url;
      navEmit(sameButHash ? 'onReferenceFragmentUpdated' : 'onHistoryStateUpdated', () => ({ url, processId: pid, frameId: isMainFrame ? 0 : f ? f.frameTreeNodeId : -1, parentFrameId: isMainFrame ? -1 : 0, transitionType: 'link', transitionQualifiers: [] }));
    });
  }

  // ------------------------------------------------------------------------------- commands
  onKey(event, input, ctl, tab) {
    if (input.type !== 'keyDown' || ctl.private) return;
    if (!this.mgr.commandsActive()) return;
    if (resolveShortcut(input)) return; // the browser's own shortcuts win
    const hit = this.mgr.commandFor(input);
    if (!hit) return;
    event.preventDefault();
    const t = tab || ctl.activeTab();
    this.runCommand(hit.ext, hit.name, ctl, t);
  }

  runCommand(ext, name, ctl, tab) {
    if (tab) this.grantActiveTab(ext, tab);
    if (['_execute_action', '_execute_browser_action', '_execute_page_action'].includes(name)) {
      this.mgr.actionClick(ctl, ext.id, null);
      return;
    }
    this.mgr.bridge.emit(ext.id, 'commands.onCommand', [name, tab ? this.tabObj(ext, tab) : undefined]);
  }

  // --------------------------------------------------------------------------- notifications
  notificationIcon(ext, url) {
    if (typeof url !== 'string' || !url) return this.mgr.iconImage(ext, 128);
    try {
      if (/^data:image\//i.test(url)) return nativeImage.createFromDataURL(url);
      const u = new URL(url, `chrome-extension://${ext.id}/`);
      if (u.protocol === 'chrome-extension:' && u.host === ext.id) {
        const file = this.mgr.extFile(ext, decodeURIComponent(u.pathname));
        if (file) return nativeImage.createFromPath(file);
      }
    } catch {
      /* fall back to the extension icon */
    }
    return this.mgr.iconImage(ext, 128);
  }

  showNotification(ext, id, o) {
    const key = `${ext.id}\n${id}`;
    const old = this.notifications.get(key);
    if (old) {
      old.__lwReplaced = true;
      try {
        old.close();
      } catch {
        /* gone */
      }
    }
    const lines = [String(o.message || '')];
    if (Array.isArray(o.items)) for (const it of o.items.slice(0, 8)) if (it) lines.push(`${it.title || ''}: ${it.message || ''}`);
    if (Number.isFinite(o.progress)) lines.push(`${Math.max(0, Math.min(100, Math.round(o.progress)))}%`);
    if (o.contextMessage) lines.push(String(o.contextMessage));
    const n = new Notification({ title: String(o.title || ext.name).slice(0, 200), body: lines.filter(Boolean).join('\n').slice(0, 1000), icon: this.notificationIcon(ext, o.iconUrl), silent: !!o.silent, timeoutType: o.requireInteraction ? 'never' : 'default' });
    n.__lwOptions = o;
    n.on('click', () => this.mgr.bridge.emit(ext.id, 'notifications.onClicked', [id]));
    n.on('close', () => {
      if (this.notifications.get(key) === n) this.notifications.delete(key);
      if (!n.__lwReplaced) this.mgr.bridge.emit(ext.id, 'notifications.onClosed', [id, true]);
    });
    n.on('action', (_e, index) => this.mgr.bridge.emit(ext.id, 'notifications.onButtonClicked', [id, index]));
    this.notifications.set(key, n);
    n.show();
  }

  clearNotifications(extId) {
    for (const [k, n] of this.notifications) {
      if (!k.startsWith(`${extId}\n`)) continue;
      n.__lwReplaced = true;
      try {
        n.close();
      } catch {
        /* gone */
      }
      this.notifications.delete(k);
    }
  }

  // ------------------------------------------------------------------------------------ cookies
  cookieAllowed(ext, domain, secure = true) {
    return ext.apiPerms.has('cookies') && this.hasHost(ext, cookieDomainUrl(domain, secure));
  }

  chromeCookie(c) {
    const o = { name: c.name, value: c.value, domain: c.domain, hostOnly: !!c.hostOnly, path: c.path || '/', secure: !!c.secure, httpOnly: !!c.httpOnly, sameSite: c.sameSite || 'unspecified', session: !!c.session, storeId: '0' };
    if (!c.session && Number.isFinite(c.expirationDate)) o.expirationDate = c.expirationDate;
    return o;
  }

  watchCookies(ses) {
    ses.cookies.on('changed', (_e, cookie, cause, removed) => {
      const map = { explicit: 'explicit', overwrite: 'overwrite', expired: 'expired', evicted: 'evicted', 'expired-overwrite': 'expired_overwrite', inserted: 'explicit', 'inserted-no-change-overwrite': 'overwrite', 'inserted-no-value-change-overwrite': 'overwrite' };
      this.emitAll('cookies.onChanged', (ext) => (this.cookieAllowed(ext, cookie.domain, cookie.secure) ? [{ removed: !!removed, cookie: this.chromeCookie(cookie), cause: map[cause] || 'explicit' }] : null), { wake: true });
    });
  }

  // -------------------------------------------------------------------------------------- alarms
  scheduleAlarms() {
    clearTimeout(this.alarmTimer);
    let next = Infinity;
    for (const ext of this.mgr.loaded.values()) for (const a of this.mgr.alarmsOf(ext.id).values()) next = Math.min(next, a.scheduledTime);
    if (next === Infinity) return;
    const delay = Math.max(0, Math.min(next - Date.now(), 2 ** 31 - 1));
    this.alarmTimer = setTimeout(() => this.fireAlarms(), delay);
    this.alarmTimer.unref?.();
  }

  fireAlarms() {
    const now = Date.now();
    for (const ext of this.mgr.loaded.values()) {
      const alarms = this.mgr.alarmsOf(ext.id);
      let changed = false;
      for (const [name, a] of [...alarms]) {
        if (a.scheduledTime > now + 50) continue;
        const fired = { name, scheduledTime: a.scheduledTime, ...(a.periodInMinutes ? { periodInMinutes: a.periodInMinutes } : {}) };
        if (a.periodInMinutes) {
          const period = a.periodInMinutes * 60000;
          let t = a.scheduledTime;
          while (t <= now) t += period;
          a.scheduledTime = t;
        } else alarms.delete(name);
        changed = true;
        this.mgr.bridge.emit(ext.id, 'alarms.onAlarm', [fired], { wake: true });
      }
      if (changed) this.mgr.saveAlarms(ext.id);
    }
    this.scheduleAlarms();
  }

  // ---------------------------------------------------------------------------------- webRequest
  /**
   * Electron sends requests either through session.webRequest (which Ludworks uses for its content
   * blocker, privacy headers and tracking-cookie monitor) or through the extensions' chrome.webRequest
   * — never both. So extensions get read-only copies of the events from Ludworks' own dispatcher:
   * observing works, blocking or changing requests does not.
   */
  attachWebRequest(hub) {
    const mk = (name, extra) => (d, more) => {
      if (!this.webRequestOn) return null;
      this.webRequestEvent(name, d, extra ? extra(d, more) : null);
      return null;
    };
    hub.onBeforeRequest(mk('onBeforeRequest'));
    hub.onBeforeSendHeaders(mk('onSendHeaders', (_d, headers) => ({ requestHeaders: Object.entries(headers || {}).map(([name, value]) => ({ name, value: String(value) })) })));
    hub.onHeadersReceived(mk('onHeadersReceived', (d) => ({ statusCode: d.statusCode, statusLine: d.statusLine, responseHeaders: Object.entries(d.responseHeaders || {}).flatMap(([name, v]) => (Array.isArray(v) ? v : [v]).map((value) => ({ name, value: String(value) }))) })));
    hub.onCompleted(mk('onCompleted', (d) => ({ statusCode: d.statusCode, statusLine: d.statusLine, fromCache: !!d.fromCache, ip: d.ip })));
    hub.onErrorOccurred(mk('onErrorOccurred', (d) => ({ error: d.error, fromCache: !!d.fromCache })));
  }

  webRequestListenersChanged() {
    let on = false;
    for (const ext of this.mgr.loaded.values()) for (const n of ['onBeforeRequest', 'onSendHeaders', 'onBeforeSendHeaders', 'onHeadersReceived', 'onCompleted', 'onErrorOccurred', 'onResponseStarted']) if (this.mgr.bridge.listening(ext.id, `webRequest.${n}`)) on = true;
    this.webRequestOn = on;
  }

  webRequestEvent(name, d, extra) {
    const url = d.url || '';
    if (!/^(https?|wss?):/i.test(url)) return;
    const tab = d.webContentsId != null ? this.tabByWcId(d.webContentsId) : null;
    if (d.webContentsId != null && !tab) return; // extension pages, private windows, the browser UI
    const typeMap = { mainFrame: 'main_frame', subFrame: 'sub_frame', stylesheet: 'stylesheet', script: 'script', image: 'image', font: 'font', object: 'object', xhr: 'xmlhttprequest', ping: 'ping', cspReport: 'csp_report', media: 'media', webSocket: 'websocket', other: 'other' };
    const type = typeMap[d.resourceType] || 'other';
    const base = { requestId: String(d.id), url, method: d.method, frameId: type === 'main_frame' ? 0 : d.frame && tab ? this.frameIdOf(tab.wc, d.frame) : 0, parentFrameId: type === 'main_frame' ? -1 : 0, tabId: tab ? tab.wc.id : -1, type, timeStamp: d.timestamp || Date.now(), initiator: d.referrer ? safeOrigin(d.referrer) : undefined, ...(extra || {}) };
    const names = name === 'onSendHeaders' ? ['webRequest.onBeforeSendHeaders', 'webRequest.onSendHeaders'] : name === 'onHeadersReceived' ? ['webRequest.onHeadersReceived', 'webRequest.onResponseStarted'] : [`webRequest.${name}`];
    for (const ext of this.mgr.loaded.values()) {
      if (!ext.apiPerms.has('webRequest') || !this.hasHost(ext, url)) continue;
      for (const n of names) {
        if (!this.mgr.bridge.listening(ext.id, n)) continue;
        const filters = this.mgr.bridge.filtersOf(ext.id, n);
        if (filters && !filters.some((f) => webRequestFilterMatches(f, base, tab))) continue;
        this.mgr.bridge.emit(ext.id, n, [base], { wake: false });
      }
    }
  }

  tabByWcId(id) {
    for (const w of this.windows()) for (const t of w.tabs) if (!t.wc.isDestroyed() && t.wc.id === id) return t;
    return null;
  }
}

function safeOrigin(u) {
  try {
    const o = new URL(u).origin;
    return o === 'null' ? undefined : o;
  } catch {
    return undefined;
  }
}

function webRequestFilterMatches(f, d, tab) {
  if (Array.isArray(f.types) && f.types.length && !f.types.includes(d.type)) return false;
  if (Number.isInteger(f.tabId) && f.tabId !== d.tabId) return false;
  if (Number.isInteger(f.windowId) && (!tab || tab.ctl.win.id !== f.windowId)) return false;
  if (Array.isArray(f.urls) && f.urls.length && !f.urls.some((p) => queryPatternMatch(p, d.url))) return false;
  return true;
}

// =============================================================================== API methods
// Each: (ctx, ext, ...args) with `this` = Api. Values must be structured-clonable.
const METHODS = {
  // ------------------------------------------------------------------------------- tabs
  'tabs.query'(ctx, ext, q) {
    q = isObj(q) ? q : {};
    const cur = this.ctxWindow(ctx);
    const last = this.lastFocused();
    let wins = this.windows();
    if (q.windowId !== undefined && q.windowId !== null) {
      const want = q.windowId === WINDOW_ID_CURRENT ? (cur ? cur.win.id : null) : q.windowId;
      wins = wins.filter((w) => w.win.id === want);
    }
    if (q.currentWindow === true) wins = wins.filter((w) => w === cur);
    else if (q.currentWindow === false) wins = wins.filter((w) => w !== cur);
    if (q.lastFocusedWindow === true) wins = wins.filter((w) => w === last);
    else if (q.lastFocusedWindow === false) wins = wins.filter((w) => w !== last);
    if (q.windowType) wins = wins.filter((w) => (w.extWindowType || 'normal') === q.windowType);
    const urls = q.url === undefined || q.url === null ? null : (Array.isArray(q.url) ? q.url : [q.url]).map(String);
    const title = typeof q.title === 'string' ? globRe(q.title) : null;
    const out = [];
    for (const w of wins) {
      for (const t of this.liveTabs(w)) {
        const o = this.tabObj(ext, t);
        const bools = { active: o.active, highlighted: o.highlighted, pinned: o.pinned, audible: o.audible, discarded: false, autoDiscardable: true, frozen: false };
        if (Object.keys(bools).some((k) => typeof q[k] === 'boolean' && q[k] !== bools[k])) continue;
        if (typeof q.muted === 'boolean' && q.muted !== o.mutedInfo.muted) continue;
        if (q.status && q.status !== o.status) continue;
        if (Number.isInteger(q.index) && q.index !== o.index) continue;
        if (Number.isInteger(q.groupId) && q.groupId !== -1) continue;
        if (urls && !(o.url && urls.some((p) => queryPatternMatch(p, o.url)))) continue;
        if (title && !(o.title !== undefined && title.test(o.title))) continue;
        out.push(o);
      }
    }
    return out;
  },
  'tabs.get'(ctx, ext, id) {
    return this.tabObj(ext, this.needTab(id));
  },
  'tabs.getCurrent'(ctx, ext) {
    const t = this.ctxTab(ctx);
    return t ? this.tabObj(ext, t) : undefined;
  },
  'tabs.create'(ctx, ext, p) {
    p = isObj(p) ? p : {};
    const url = p.url !== undefined ? this.resolveUrl(ext, p.url) : this.b.newTabUrl();
    let ctl = p.windowId !== undefined ? this.winById(p.windowId, ctx) : this.ctxWindow(ctx);
    if (p.windowId !== undefined && !ctl) fail(`No window with id: ${p.windowId}.`);
    if (!ctl) {
      ctl = this.b.newWindow({ urls: [url] });
      return this.tabObj(ext, ctl.activeTab());
    }
    const active = p.active !== undefined ? !!p.active : p.selected !== undefined ? !!p.selected : true;
    const opener = Number.isInteger(p.openerTabId) ? this.tabById(p.openerTabId) : null;
    const tab = ctl.newTab({ url, active, index: Number.isInteger(p.index) && p.index >= 0 ? p.index : null, opener: opener && opener.ctl === ctl ? opener : null, pinned: !!p.pinned });
    return this.tabObj(ext, tab);
  },
  'tabs.duplicate'(ctx, ext, id) {
    const t = this.needTab(id);
    const nt = t.ctl.newTab({ url: t.wc.getURL() || t.url, index: t.ctl.tabs.indexOf(t) + 1, opener: t });
    return this.tabObj(ext, nt);
  },
  'tabs.update'(ctx, ext, id, p) {
    p = isObj(p) ? p : {};
    let t;
    if (id === null || id === undefined) {
      const ctl = this.ctxWindow(ctx);
      t = ctl ? ctl.activeTab() : null;
      if (!t) fail('No active tab.');
    } else t = this.needTab(id);
    if (p.url !== undefined) {
      if (/^\s*javascript:/i.test(String(p.url))) fail('JavaScript URLs are not allowed in API based extension navigations. Use chrome.scripting.executeScript instead.');
      t.load(this.resolveUrl(ext, p.url));
    }
    if (p.active === true || p.highlighted === true || p.selected === true) t.ctl.activate(t.id);
    if (typeof p.pinned === 'boolean' && p.pinned !== !!t.pinned) {
      t.pinned = p.pinned;
      t.update();
    }
    if (typeof p.muted === 'boolean') {
      t.wc.setAudioMuted(p.muted);
      t.update();
    }
    if (p.openerTabId !== undefined) {
      const op = this.tabById(p.openerTabId);
      t.openerId = op && op.ctl === t.ctl ? op.id : null;
    }
    return this.tabObj(ext, t);
  },
  'tabs.remove'(ctx, ext, ids) {
    const list = (Array.isArray(ids) ? ids : [ids]).map((x) => this.needTab(x));
    for (const t of list) if (!t.destroyed) t.ctl.closeTab(t.id);
  },
  'tabs.highlight'(ctx, ext, info) {
    const ctl = this.winById(isObj(info) ? info.windowId : null, ctx);
    if (!ctl) fail('No window.');
    const idx = Array.isArray(info.tabs) ? info.tabs : [info.tabs];
    const t = ctl.tabs[idx[0]];
    if (!t) fail(`No tab at index: ${idx[0]}.`);
    ctl.activate(t.id);
    return this.winObj(ext, ctl, { populate: true });
  },
  'tabs.move'(ctx, ext, ids, p) {
    const list = (Array.isArray(ids) ? ids : [ids]).map((x) => this.needTab(x));
    p = isObj(p) ? p : {};
    const out = [];
    for (const t of list) {
      if (p.windowId !== undefined && p.windowId !== t.ctl.win.id) {
        const w = this.winById(p.windowId, ctx);
        if (!w || w.agent) fail(`No window with id: ${p.windowId}.`);
        this.b.moveTabToWindow(t, w, { index: Number.isInteger(p.index) && p.index >= 0 ? p.index : null });
      } else {
        const to = Number.isInteger(p.index) && p.index >= 0 ? p.index : t.ctl.tabs.length - 1;
        t.ctl.moveTab(t.id, to);
      }
      out.push(this.tabObj(ext, t));
    }
    if (out.length) this.pushTabMap();
    return Array.isArray(ids) ? out : out[0];
  },
  'tabs.reload'(ctx, ext, id, p) {
    const t = id === null || id === undefined ? (this.ctxWindow(ctx) || {}).activeTab?.() : this.needTab(id);
    if (!t) fail('No active tab.');
    t.reload(!!(isObj(p) && p.bypassCache));
  },
  'tabs.goBack'(ctx, ext, id) {
    const t = id === null ? this.ctxWindow(ctx)?.activeTab() : this.needTab(id);
    if (!t) fail('No active tab.');
    const nh = t.wc.navigationHistory;
    if (!nh.canGoBack()) fail('Cannot find a next page in history.');
    nh.goBack();
  },
  'tabs.goForward'(ctx, ext, id) {
    const t = id === null ? this.ctxWindow(ctx)?.activeTab() : this.needTab(id);
    if (!t) fail('No active tab.');
    const nh = t.wc.navigationHistory;
    if (!nh.canGoForward()) fail('Cannot find a next page in history.');
    nh.goForward();
  },
  'tabs.getZoom'(ctx, ext, id) {
    const t = id === null ? this.ctxWindow(ctx)?.activeTab() : this.needTab(id);
    if (!t) fail('No active tab.');
    return t.wc.getZoomFactor();
  },
  'tabs.setZoom'(ctx, ext, id, factor) {
    const t = id === null ? this.ctxWindow(ctx)?.activeTab() : this.needTab(id);
    if (!t) fail('No active tab.');
    const old = t.wc.getZoomFactor();
    if (!Number.isFinite(factor)) fail('Invalid zoom factor.');
    if (factor === 0) t.wc.setZoomLevel(0);
    else t.wc.setZoomFactor(Math.max(0.25, Math.min(5, factor)));
    t.update();
    this.emitAll('tabs.onZoomChange', () => [{ tabId: t.wc.id, oldZoomFactor: old, newZoomFactor: t.wc.getZoomFactor(), zoomSettings: { mode: 'automatic', scope: 'per-tab' } }]);
  },
  'tabs.getZoomSettings'() {
    return { mode: 'automatic', scope: 'per-origin', defaultZoomFactor: 1 };
  },
  'tabs.setZoomSettings'() {
    return undefined;
  },
  async 'tabs.detectLanguage'(ctx, ext, id) {
    const t = id === null ? this.ctxWindow(ctx)?.activeTab() : this.needTab(id);
    if (!t || !/^https?:/i.test(t.wc.getURL())) return 'und';
    try {
      const r = await t.wc.executeJavaScriptInIsolatedWorld(1001, [{ code: 'String(document.documentElement.lang || "")' }]);
      return /^[a-z]{2,3}([-_][a-z0-9]{2,8})?$/i.test(r) ? r.split(/[-_]/)[0].toLowerCase() : 'und';
    } catch {
      return 'und';
    }
  },
  async 'tabs.captureVisibleTab'(ctx, ext, windowId, opts) {
    const ctl = this.winById(windowId, ctx);
    const t = ctl && ctl.activeTab();
    if (!t) fail('No active tab.');
    const url = t.wc.getURL();
    // like Chrome: not the browser's own pages, the Web Store, or files (extensions get no file access)
    if (!/^(https?|ftp):/i.test(url) || url.startsWith(`${STORE_ORIGIN}/`)) fail('Cannot capture this page.');
    const g = this.activeTab.get(ext.id);
    if (!(ext.hostPatterns.some(isAllSites) || (g && g.has(t.wc.id)))) fail('Either the "<all_urls>" or the "activeTab" permission is required.');
    const img = await t.wc.capturePage();
    const o = isObj(opts) ? opts : {};
    if (o.format === 'png') return `data:image/png;base64,${img.toPNG().toString('base64')}`;
    const q = Number.isInteger(o.quality) ? Math.max(0, Math.min(100, o.quality)) : 92;
    return `data:image/jpeg;base64,${img.toJPEG(q).toString('base64')}`;
  },

  // ---------------------------------------------------------------------------- windows
  'windows.get'(ctx, ext, id, o) {
    const ctl = this.winById(id, ctx);
    if (!ctl) fail(`No window with id: ${id}.`);
    return this.winObj(ext, ctl, { populate: !!(o && o.populate) });
  },
  'windows.getCurrent'(ctx, ext, o) {
    const ctl = this.ctxWindow(ctx);
    if (!ctl) fail('No current window.');
    return this.winObj(ext, ctl, { populate: !!(o && o.populate) });
  },
  'windows.getLastFocused'(ctx, ext, o) {
    const ctl = this.lastFocused();
    if (!ctl) fail('No last-focused window.');
    return this.winObj(ext, ctl, { populate: !!(o && o.populate) });
  },
  'windows.getAll'(ctx, ext, o) {
    const types = o && Array.isArray(o.windowTypes) ? o.windowTypes : null;
    return this.windows()
      .filter((w) => !types || types.includes(w.extWindowType || 'normal'))
      .map((w) => this.winObj(ext, w, { populate: !!(o && o.populate) }));
  },
  'windows.create'(ctx, ext, p) {
    p = isObj(p) ? p : {};
    const moving = p.tabId !== undefined ? this.needTab(p.tabId) : null; // moves that tab into the new window
    if (moving && (p.incognito || moving.ctl.agent)) fail(`Tab ${p.tabId} cannot move to that window.`);
    const urls = (p.url === undefined ? [] : Array.isArray(p.url) ? p.url : [p.url]).slice(0, 50).map((u) => this.resolveUrl(ext, u));
    const num = (v, min, max) => (Number.isFinite(v) ? Math.max(min, Math.min(max, Math.round(v))) : null);
    const width = num(p.width, 200, 4000);
    const height = num(p.height, 150, 3000);
    let bounds = null;
    if (width || height) {
      bounds = { width: width || 800, height: (height || 600) + (p.type === 'popup' ? 82 : 0) };
      if (Number.isFinite(p.left) && Number.isFinite(p.top)) Object.assign(bounds, { x: Math.round(p.left), y: Math.round(p.top) });
    }
    const ctl = this.b.newWindow({ urls: urls.length ? urls : null, private: !!p.incognito, bounds, empty: !!moving });
    if (moving) this.b.moveTabToWindow(moving, ctl);
    if (p.incognito) return undefined; // the extension does not see private windows
    if (p.type === 'popup' || p.type === 'panel') ctl.extWindowType = 'popup';
    if (p.state === 'maximized') ctl.win.maximize();
    else if (p.state === 'fullscreen') ctl.win.setFullScreen(true);
    else if (p.state === 'minimized') ctl.win.minimize();
    this.watchWindow(ctl);
    return this.winObj(ext, ctl, { populate: true });
  },
  'windows.update'(ctx, ext, id, p) {
    const ctl = this.winById(id, ctx);
    if (!ctl) fail(`No window with id: ${id}.`);
    p = isObj(p) ? p : {};
    const w = ctl.win;
    if (p.state === 'minimized') w.minimize();
    else if (p.state === 'maximized') w.maximize();
    else if (p.state === 'fullscreen') w.setFullScreen(true);
    else if (p.state === 'normal') {
      if (w.isFullScreen()) w.setFullScreen(false);
      if (w.isMaximized()) w.unmaximize();
      if (w.isMinimized()) w.restore();
    }
    const b = w.getBounds();
    const nb = { x: Number.isFinite(p.left) ? Math.round(p.left) : b.x, y: Number.isFinite(p.top) ? Math.round(p.top) : b.y, width: Number.isFinite(p.width) ? Math.max(200, Math.round(p.width)) : b.width, height: Number.isFinite(p.height) ? Math.max(150, Math.round(p.height)) : b.height };
    if (nb.x !== b.x || nb.y !== b.y || nb.width !== b.width || nb.height !== b.height) w.setBounds(nb);
    if (p.focused === true) {
      if (w.isMinimized()) w.restore();
      w.focus();
    } else if (p.focused === false) w.blur();
    if (p.drawAttention === true) w.flashFrame(true);
    else if (p.drawAttention === false) w.flashFrame(false);
    return this.winObj(ext, ctl);
  },
  'windows.remove'(ctx, ext, id) {
    const ctl = this.winById(id, ctx);
    if (!ctl) fail(`No window with id: ${id}.`);
    ctl.win.close();
  },

  // ----------------------------------------------------------------------------- action
  'action.setTitle'(ctx, ext, o) {
    return this.mgr.setActionValue(ext, o.tabId, 'title', typeof o.title === 'string' ? o.title.slice(0, 500) : null);
  },
  'action.getTitle'(ctx, ext, o) {
    return this.mgr.actionState(ext, o.tabId).title;
  },
  'action.setPopup'(ctx, ext, o) {
    let v = null;
    if (typeof o.popup === 'string') {
      if (o.popup === '') v = '';
      else {
        let u;
        try {
          u = new URL(o.popup, `chrome-extension://${ext.id}/`);
        } catch {
          fail('Invalid popup path.');
        }
        if (u.protocol !== 'chrome-extension:' || u.host !== ext.id) fail('The popup must be a page of the extension.');
        v = u.pathname.replace(/^\//, '') + u.search + u.hash;
      }
    }
    return this.mgr.setActionValue(ext, o.tabId, 'popup', v);
  },
  'action.getPopup'(ctx, ext, o) {
    const p = this.mgr.actionState(ext, o.tabId).popup;
    return p ? `chrome-extension://${ext.id}/${p}` : '';
  },
  'action.setBadgeText'(ctx, ext, o) {
    return this.mgr.setActionValue(ext, o.tabId, 'badgeText', o.text === undefined || o.text === null ? null : String(o.text).slice(0, 12));
  },
  'action.getBadgeText'(ctx, ext, o) {
    return this.mgr.actionState(ext, o.tabId).badgeText || '';
  },
  'action.setBadgeBackgroundColor'(ctx, ext, o) {
    const c = parseColor(o.color);
    if (!c) fail('Invalid badge color.');
    return this.mgr.setActionValue(ext, o.tabId, 'badgeBg', c);
  },
  'action.getBadgeBackgroundColor'(ctx, ext, o) {
    return this.mgr.actionState(ext, o.tabId).badgeBg || [217, 48, 37, 255];
  },
  'action.setBadgeTextColor'(ctx, ext, o) {
    const c = parseColor(o.color);
    if (!c) fail('Invalid badge text color.');
    return this.mgr.setActionValue(ext, o.tabId, 'badgeFg', c);
  },
  'action.getBadgeTextColor'(ctx, ext, o) {
    return this.mgr.actionState(ext, o.tabId).badgeFg || [255, 255, 255, 255];
  },
  'action.setIcon'(ctx, ext, o) {
    const icon = this.mgr.actionIconFrom(ext, o);
    if (!icon) fail('Could not load the action icon.');
    return this.mgr.setActionValue(ext, o.tabId, 'icon', icon);
  },
  'action.enable'(ctx, ext, tabId) {
    return this.mgr.setActionValue(ext, tabId, 'enabled', true);
  },
  'action.disable'(ctx, ext, tabId) {
    return this.mgr.setActionValue(ext, tabId, 'enabled', false);
  },
  'action.isEnabled'(ctx, ext, tabId) {
    return this.mgr.actionState(ext, tabId).enabled !== false;
  },
  'action.getUserSettings'(ctx, ext) {
    return { isOnToolbar: !!this.mgr.item(ext.id)?.pinned };
  },
  'action.openPopup'(ctx, ext, o) {
    const ctl = this.winById(isObj(o) && Number.isInteger(o.windowId) ? o.windowId : null, ctx);
    if (!ctl) fail('No window.');
    if (!this.mgr.actionState(ext, ctl.activeTab() ? ctl.activeTab().wc.id : null).popup) fail('The extension has no popup for this tab.');
    this.mgr.actionClick(ctl, ext.id, null);
  },

  // --------------------------------------------------------------------------- commands
  'commands.getAll'(ctx, ext) {
    return ext.commands.map((c) => ({ name: c.name, description: c.description, shortcut: c.shortcut }));
  },

  // ------------------------------------------------------------------------ contextMenus
  'contextMenus.create'(ctx, ext, p) {
    const menus = this.mgr.menusOf(ext.id);
    if (!isObj(p)) fail('Invalid menu item.');
    const id = p.id;
    if (typeof id !== 'string' && typeof id !== 'number') fail('Menu items need an id.');
    if (menus.has(id)) fail(`Cannot create item with duplicate id ${id}`);
    if (menus.size >= MAX_MENU_ITEMS) fail('Too many menu items.');
    const item = menuItem(p, null);
    if (item.parentId !== undefined && !menus.has(item.parentId)) fail(`Cannot find menu item with id ${item.parentId}`);
    menus.set(id, item);
    this.mgr.saveMenus(ext.id);
  },
  'contextMenus.update'(ctx, ext, id, p) {
    const menus = this.mgr.menusOf(ext.id);
    const cur = menus.get(id);
    if (!cur) fail(`Cannot find menu item with id ${id}`);
    const next = menuItem({ ...cur, ...(isObj(p) ? p : {}), id }, cur);
    if (next.parentId !== undefined && (next.parentId === id || !menus.has(next.parentId))) fail('Invalid parent menu item.');
    menus.set(id, next);
    this.mgr.saveMenus(ext.id);
  },
  'contextMenus.remove'(ctx, ext, id) {
    const menus = this.mgr.menusOf(ext.id);
    if (!menus.has(id)) fail(`Cannot find menu item with id ${id}`);
    const drop = (x) => {
      menus.delete(x);
      for (const [k, v] of [...menus]) if (v.parentId === x) drop(k);
    };
    drop(id);
    this.mgr.saveMenus(ext.id);
  },
  'contextMenus.removeAll'(ctx, ext) {
    this.mgr.menusOf(ext.id).clear();
    this.mgr.saveMenus(ext.id);
  },
  'contextMenus.refresh'() {
    return undefined;
  },

  // ----------------------------------------------------------------------- notifications
  'notifications.create'(ctx, ext, id, o) {
    if (!ext.apiPerms.has('notifications')) fail('The "notifications" permission is required.');
    const nid = typeof id === 'string' && id ? id.slice(0, 500) : randomUUID();
    this.showNotification(ext, nid, isObj(o) ? o : {});
    return nid;
  },
  'notifications.update'(ctx, ext, id, o) {
    const n = this.notifications.get(`${ext.id}\n${id}`);
    if (!n) return false;
    this.showNotification(ext, id, { ...(n.__lwOptions || {}), ...(isObj(o) ? o : {}) });
    return true;
  },
  'notifications.clear'(ctx, ext, id) {
    const key = `${ext.id}\n${id}`;
    const n = this.notifications.get(key);
    if (!n) return false;
    this.notifications.delete(key);
    n.__lwReplaced = true;
    n.close();
    this.mgr.bridge.emit(ext.id, 'notifications.onClosed', [id, false]);
    return true;
  },
  'notifications.getAll'(ctx, ext) {
    const out = {};
    for (const k of this.notifications.keys()) if (k.startsWith(`${ext.id}\n`)) out[k.slice(ext.id.length + 1)] = true;
    return out;
  },
  'notifications.getPermissionLevel'() {
    return Notification.isSupported() ? 'granted' : 'denied';
  },

  // ------------------------------------------------------------------------------ cookies
  async 'cookies.get'(ctx, ext, d) {
    if (typeof d.url !== 'string' || typeof d.name !== 'string') fail('url and name are required.');
    if (!ext.apiPerms.has('cookies') || !this.hasHost(ext, d.url)) fail(`No host permissions for cookies at url: "${d.url}".`);
    if (d.storeId && d.storeId !== '0') return null;
    const list = await this.mgr.ses.cookies.get({ url: d.url, name: d.name });
    if (!list.length) return null;
    list.sort((a, b) => (b.path || '').length - (a.path || '').length || (b.domain || '').length - (a.domain || '').length);
    return this.chromeCookie(list[0]);
  },
  async 'cookies.getAll'(ctx, ext, d) {
    if (!ext.apiPerms.has('cookies')) fail('The "cookies" permission is required.');
    if (d.storeId && d.storeId !== '0') return [];
    const filter = {};
    for (const k of ['url', 'name', 'domain', 'path']) if (typeof d[k] === 'string') filter[k] = d[k];
    for (const k of ['secure', 'session']) if (typeof d[k] === 'boolean') filter[k] = d[k];
    if (filter.url && !this.hasHost(ext, filter.url)) return [];
    const list = await this.mgr.ses.cookies.get(filter);
    return list.filter((c) => this.cookieAllowed(ext, c.domain, c.secure) || this.cookieAllowed(ext, c.domain, false)).map((c) => this.chromeCookie(c));
  },
  async 'cookies.set'(ctx, ext, d) {
    if (typeof d.url !== 'string') fail('url is required.');
    if (!ext.apiPerms.has('cookies') || !this.hasHost(ext, d.url)) fail(`No host permissions for cookies at url: "${d.url}".`);
    const c = { url: d.url };
    for (const k of ['name', 'value', 'domain', 'path']) if (typeof d[k] === 'string') c[k] = d[k];
    for (const k of ['secure', 'httpOnly']) if (typeof d[k] === 'boolean') c[k] = d[k];
    if (Number.isFinite(d.expirationDate)) c.expirationDate = d.expirationDate;
    if (['no_restriction', 'lax', 'strict', 'unspecified'].includes(d.sameSite)) c.sameSite = d.sameSite;
    await this.mgr.ses.cookies.set(c);
    const got = await this.mgr.ses.cookies.get({ url: d.url, name: c.name || '' });
    return got.length ? this.chromeCookie(got[0]) : null;
  },
  async 'cookies.remove'(ctx, ext, d) {
    if (typeof d.url !== 'string' || typeof d.name !== 'string') fail('url and name are required.');
    if (!ext.apiPerms.has('cookies') || !this.hasHost(ext, d.url)) fail(`No host permissions for cookies at url: "${d.url}".`);
    await this.mgr.ses.cookies.remove(d.url, d.name);
    return { url: d.url, name: d.name, storeId: '0' };
  },
  'cookies.getAllCookieStores'() {
    const tabIds = [];
    for (const w of this.windows()) for (const t of this.liveTabs(w)) tabIds.push(t.wc.id);
    return [{ id: '0', tabIds }];
  },
  'cookies.getPartitionKey'() {
    return { partitionKey: {} };
  },

  // ------------------------------------------------------------------------------- alarms
  'alarms.create'(ctx, ext, name, info) {
    if (!ext.apiPerms.has('alarms')) fail('The "alarms" permission is required.');
    info = isObj(info) ? info : {};
    const alarms = this.mgr.alarmsOf(ext.id);
    if (!alarms.has(String(name)) && alarms.size >= 500) fail('Too many alarms.');
    const minMs = this.mgr.item(ext.id)?.source === 'unpacked' ? 0 : MIN_ALARM_MS;
    const period = Number.isFinite(info.periodInMinutes) && info.periodInMinutes > 0 ? Math.max(info.periodInMinutes, minMs / 60000) : 0;
    let when;
    if (Number.isFinite(info.when)) when = info.when;
    else if (Number.isFinite(info.delayInMinutes)) when = Date.now() + Math.max(info.delayInMinutes * 60000, minMs);
    else if (period) when = Date.now() + period * 60000;
    else fail('Alarm needs "when", "delayInMinutes" or "periodInMinutes".');
    alarms.set(String(name), { scheduledTime: when, periodInMinutes: period || undefined });
    this.mgr.saveAlarms(ext.id);
    this.scheduleAlarms();
  },
  'alarms.get'(ctx, ext, name) {
    const a = this.mgr.alarmsOf(ext.id).get(String(name));
    return a ? { name: String(name), scheduledTime: a.scheduledTime, ...(a.periodInMinutes ? { periodInMinutes: a.periodInMinutes } : {}) } : undefined;
  },
  'alarms.getAll'(ctx, ext) {
    return [...this.mgr.alarmsOf(ext.id)].map(([name, a]) => ({ name, scheduledTime: a.scheduledTime, ...(a.periodInMinutes ? { periodInMinutes: a.periodInMinutes } : {}) }));
  },
  'alarms.clear'(ctx, ext, name) {
    const ok = this.mgr.alarmsOf(ext.id).delete(String(name));
    if (ok) this.mgr.saveAlarms(ext.id);
    this.scheduleAlarms();
    return ok;
  },
  'alarms.clearAll'(ctx, ext) {
    const a = this.mgr.alarmsOf(ext.id);
    const had = a.size > 0;
    a.clear();
    this.mgr.saveAlarms(ext.id);
    this.scheduleAlarms();
    return had;
  },

  // -------------------------------------------------------------------------- permissions
  'permissions.contains'(ctx, ext, p) {
    return this.mgr.permissionsContain(ext, p);
  },
  'permissions.getAll'(ctx, ext) {
    return { permissions: [...ext.apiPerms], origins: [...ext.hostPatterns] };
  },
  async 'permissions.request'(ctx, ext, p, gesture) {
    return this.mgr.requestPermissions(ext, p, { gesture: !!gesture, ctl: this.ctxWindow(ctx) });
  },
  async 'permissions.remove'(ctx, ext, p) {
    return this.mgr.removePermissions(ext, p);
  },

  // ------------------------------------------------------------------------------ runtime
  'runtime.openOptionsPage'(ctx, ext) {
    if (!this.mgr.openOptions(ext.id, this.ctxWindow(ctx))) fail('Could not create an options page.');
  },
  'runtime.setUninstallURL'(ctx, ext, url) {
    if (url && (!/^https?:\/\//i.test(url) || url.length > 1023)) fail('Invalid URL: the uninstall URL must be an http(s) URL of up to 1023 characters.');
    this.mgr.setItem(ext.id, { uninstallUrl: url || '' });
  },
  async 'runtime.requestUpdateCheck'(ctx, ext) {
    return this.mgr.requestUpdateCheck(ext.id);
  },

  // ------------------------------------------------------------------------ webNavigation
  'webNavigation.getFrame'(ctx, ext, d) {
    if (!ext.apiPerms.has('webNavigation')) fail('The "webNavigation" permission is required.');
    const t = this.tabById(d.tabId);
    if (!t) return null;
    const wc = t.wc;
    const frame = d.frameId === 0 ? wc.mainFrame : wc.mainFrame.framesInSubtree.find((f) => f.frameTreeNodeId === d.frameId);
    if (!frame) return null;
    const fi = this.frameInfo(wc, frame);
    return { errorOccurred: false, url: fi.url, parentFrameId: fi.parentFrameId, frameType: fi.frameType, documentLifecycle: 'active' };
  },
  'webNavigation.getAllFrames'(ctx, ext, d) {
    if (!ext.apiPerms.has('webNavigation')) fail('The "webNavigation" permission is required.');
    const t = this.tabById(d.tabId);
    if (!t) return null;
    return t.wc.mainFrame.framesInSubtree.map((f) => this.frameInfo(t.wc, f));
  },
  'webRequest.handlerBehaviorChanged'() {
    return undefined;
  },
};

/** A validated context-menu item (only the fields Chrome defines). */
function menuItem(p, prev) {
  const types = ['normal', 'checkbox', 'radio', 'separator'];
  const contexts = ['all', 'page', 'frame', 'selection', 'link', 'editable', 'image', 'video', 'audio', 'launcher', 'browser_action', 'page_action', 'action'];
  const type = types.includes(p.type) ? p.type : (prev && prev.type) || 'normal';
  if (type !== 'separator' && typeof p.title !== 'string' && !(prev && prev.title)) throw new Error('Menu items need a title.');
  const list = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string').slice(0, 100) : undefined);
  const item = {
    id: p.id,
    type,
    title: typeof p.title === 'string' ? p.title.slice(0, 300) : prev ? prev.title : '',
    contexts: (Array.isArray(p.contexts) ? p.contexts : typeof p.contexts === 'string' ? [p.contexts] : prev ? prev.contexts : ['page']).filter((c) => contexts.includes(c)),
    checked: typeof p.checked === 'boolean' ? p.checked : prev ? prev.checked : false,
    enabled: typeof p.enabled === 'boolean' ? p.enabled : prev ? prev.enabled : true,
    visible: typeof p.visible === 'boolean' ? p.visible : prev ? prev.visible : true,
    documentUrlPatterns: p.documentUrlPatterns !== undefined ? list(p.documentUrlPatterns) : prev ? prev.documentUrlPatterns : undefined,
    targetUrlPatterns: p.targetUrlPatterns !== undefined ? list(p.targetUrlPatterns) : prev ? prev.targetUrlPatterns : undefined,
  };
  if (p.parentId !== undefined && p.parentId !== null) item.parentId = p.parentId;
  if (!item.contexts.length) item.contexts = ['page'];
  return item;
}

