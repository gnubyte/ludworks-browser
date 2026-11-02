// A browser window: the shell UI (tab strip, toolbar, bookmarks bar) in the window's own
// webContents, one WebContentsView per tab, an overlay view for popups (menus, address-bar
// suggestions, bubbles, prompts) and an error panel shown over a tab that failed to load.

import { BrowserWindow, WebContentsView, nativeTheme, screen } from 'electron';
import { EventEmitter } from 'node:events';
import { Tab } from './tab.js';
import { THEME } from './theme.js';
import { log } from './util/log.js';

const SHELL_URL = 'lwshell://ui/shell.html';
const OVERLAY_URL = 'lwshell://ui/overlay.html';
const PANEL_URL = 'lwshell://ui/panel.html';
const FX_URL = 'lwshell://ui/fx.html';
const FLY_MS = 950; // src/shell/fx.js FLY_MS
const TITLEBAR_HEIGHT = 40;
// Transparent margin around popup cards in the overlay view (src/shell/overlay.css #root padding).
const OVERLAY_PAD = { x: 18, top: 4, bottom: 30 };
// An AI agent's window: the page sits inside a coloured frame the shell draws (src/shell/shell.css .agent).
const AGENT_FRAME = 3;
// A page of the user's that an AI agent controls (agent.js controlOf): a wider glowing frame around it.
const CONTROL_FRAME = 6;

export class WindowCtl extends EventEmitter {
  /**
   * @param {{browser: import('./browser.js').Browser, private?: boolean, bounds?: any, maximized?: boolean, agent?: any, inactive?: boolean}} o
   *   agent: {client, label, busy, stopped} while an AI agent uses this window (agent/agent.js)
   *   inactive: show without taking focus (a window made for a tab being dragged out: tab-drag.js)
   */
  constructor({ browser, private: isPrivate = false, bounds = null, maximized = false, agent = null, inactive = false }) {
    super();
    this.browser = browser;
    this.private = isPrivate;
    this.agent = agent;
    // an agent's window must not take the keyboard from what the user is doing
    this.showInactive = !!agent || inactive;
    this.focusedAt = Date.now(); // the most recently focused window is the frontmost one (tab-drag.js)
    this.tabStrip = null; // {tabs: [{id, left, right}], bottom} reported by the shell, for dropping dragged tabs
    this.session = isPrivate ? browser.privateSession() : browser.session;
    this.tabs = [];
    this.activeId = null;
    this.closedTabs = [];
    this.topInset = 82;
    this.htmlFullscreenTab = null;
    this.popup = null; // {kind, anchor}
    this.pendingPrompts = new Map(); // id → resolve
    this.destroyed = false;
    const t = this.frameColors();
    const b = bounds || defaultBounds();
    this.win = new BrowserWindow({
      ...b,
      minWidth: 500,
      minHeight: 360,
      show: false,
      title: isPrivate ? 'Private — Ludworks Browser' : 'Ludworks Browser',
      backgroundColor: t.frame,
      icon: browser.paths.windowIcon || undefined,
      titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
      ...(process.platform === 'darwin'
        ? { trafficLightPosition: { x: 12, y: 13 } }
        : { titleBarOverlay: { color: isPrivate ? THEME.private.frame : t.frame, symbolColor: isPrivate ? THEME.private.text : t.text, height: TITLEBAR_HEIGHT } }),
      webPreferences: {
        preload: browser.paths.shellPreload,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        spellcheck: false,
        partition: 'lwui',
        devTools: browser.dev,
        backgroundThrottling: false,
      },
    });
    if (maximized) this.win.maximize();
    this.shell = this.win.webContents;
    this.shell.on('before-input-event', (event, input) => browser.shortcuts.handle(event, input, this, null));
    this.shell.setWindowOpenHandler(() => ({ action: 'deny' }));
    this.shell.on('will-navigate', (e) => e.preventDefault());
    this.shell.on('page-title-updated', (e) => e.preventDefault()); // the window title follows the active tab
    this.shell.loadURL(SHELL_URL);
    this.win.once('ready-to-show', () => (this.showInactive ? this.win.showInactive() : this.win.show()));

    this.win.on('resize', () => this.layout());
    this.win.on('maximize', () => this.sendState());
    this.win.on('unmaximize', () => this.sendState());
    this.win.on('enter-full-screen', () => this.layout());
    this.win.on('leave-full-screen', () => {
      if (this.htmlFullscreenTab) {
        const t = this.htmlFullscreenTab;
        this.htmlFullscreenTab = null;
        if (!t.destroyed && !t.wc.isDestroyed()) t.wc.executeJavaScript('document.fullscreenElement && document.exitFullscreen()', true).catch(() => {});
      }
      this.layout();
    });
    this.win.on('focus', () => {
      browser.lastFocused = this;
      this.focusedAt = Date.now();
      if (this.activeTab()) this.activeTab().lastActive = Date.now();
    });
    this.win.on('blur', () => this.hidePopup());
    this.win.on('close', (e) => {
      if (!browser.quitting && this.tabs.length > 1 && !browser.confirmCloseWindow(this)) e.preventDefault();
      else browser.onWindowClosing(this);
    });
    this.win.on('closed', () => this.destroy());
    this.stateTimer = null;
  }

  isDark() {
    const pref = this.browser.prefs.get('theme');
    return pref === 'dark' || (pref === 'system' && nativeTheme.shouldUseDarkColors);
  }

  /** The window frame's colour and its caption buttons' (a Chrome theme's, src/main/themes). */
  frameColors() {
    if (this.private) return THEME.private;
    const ct = this.browser.themes && this.browser.themes.forWindow(this);
    if (ct) return { frame: ct.frameColor, text: ct.frameTextColor };
    return THEME[this.isDark() ? 'dark' : 'light'];
  }

  applyTheme() {
    const t = this.frameColors();
    this.win.setBackgroundColor(t.frame);
    if (process.platform !== 'darwin') {
      try {
        this.win.setTitleBarOverlay({ color: t.frame, symbolColor: t.text, height: TITLEBAR_HEIGHT });
      } catch {
        /* overlay not supported on this platform */
      }
    }
    this.sendState();
    if (this.overlay) this.overlay.webContents.send('theme', this.themeName());
    if (this.panel) this.panel.webContents.send('theme', this.themeName());
  }

  themeName() {
    if (this.private) return 'private';
    const ct = this.browser.themes && this.browser.themes.forWindow(this);
    if (ct) return ct.base;
    return this.isDark() ? 'dark' : 'light';
  }

  // ------------------------------------------------------------------------------------ tabs
  activeTab() {
    return this.tabs.find((t) => t.id === this.activeId) || null;
  }

  tabById(id) {
    return this.tabs.find((t) => t.id === id) || null;
  }

  /**
   * @param {{url?: string, active?: boolean, index?: number, opener?: Tab|null, webContents?: Electron.WebContents, pinned?: boolean, typed?: boolean}} o
   */
  newTab({ url = null, active = true, index = null, opener = null, webContents = null, pinned = false, typed = false } = {}) {
    const target = url || (webContents ? null : this.browser.newTabUrl());
    const tab = new Tab({ ctl: this, url: null, webContents, opener, pinned });
    this.browser.onTabCreated(tab);
    tab.on('update', () => tab.ctl.onTabUpdate(tab)); // tab.ctl: tabs can move to other windows (adoptTab)
    let at = this.tabs.length;
    if (Number.isInteger(index)) at = Math.max(0, Math.min(index, this.tabs.length));
    else if (opener) {
      // Open next to the opener, after the tabs it already opened (like Chrome).
      const oi = this.tabs.indexOf(opener);
      if (oi >= 0) {
        at = oi + 1;
        while (at < this.tabs.length && this.tabs[at].openerId === opener.id) at++;
      }
    }
    this.tabs.splice(at, 0, tab);
    this.win.contentView.addChildView(tab.view);
    if (target) tab.load(target, { typed });
    if (active || !this.activeId) this.activate(tab.id);
    else this.layout();
    this.sendState();
    this.browser.scheduleSessionSave();
    return tab;
  }

  /** `focus: false` leaves the keyboard where it is (a tab joining a window it is being dragged with). */
  activate(id, { focus = true } = {}) {
    const tab = this.tabById(id);
    if (!tab) return;
    const prev = this.activeTab();
    if (prev && prev !== tab) prev.view.setVisible(false);
    if (prev && prev !== tab) this.browser.onTabSwitch(this, prev, tab);
    this.activeId = id;
    tab.lastActive = Date.now();
    this.hidePopup();
    this.layout();
    // an agent switching tabs in its window must not pull that window in front of the user's work
    if (focus && !this.shellFocused && !(this.agent && !this.win.isFocused())) tab.wc.focus();
    this.sendState();
  }

  closeTab(id) {
    const i = this.tabs.findIndex((t) => t.id === id);
    if (i < 0) return;
    const tab = this.tabs[i];
    const url = tab.wc.isDestroyed() ? tab.url : tab.wc.getURL();
    if (url && !this.private) this.closedTabs.push({ url, title: tab.title, index: i });
    if (this.closedTabs.length > 25) this.closedTabs.shift();
    if (this.htmlFullscreenTab === tab) this.setHtmlFullscreen(tab, false);
    this.tabs.splice(i, 1);
    try {
      this.win.contentView.removeChildView(tab.view);
    } catch {
      /* window already gone */
    }
    tab.destroy();
    this.browser.onTabClosed(tab);
    if (!this.tabs.length) {
      this.win.close();
      return;
    }
    if (this.activeId === id) {
      // Back to the opener if it still exists, else the neighbour.
      const opener = tab.openerId && this.tabById(tab.openerId);
      this.activate((opener || this.tabs[Math.min(i, this.tabs.length - 1)]).id);
    }
    this.sendState();
    this.browser.scheduleSessionSave();
  }

  /**
   * Takes a tab out of this window with its page left running, for another window to adopt
   * (Browser.moveTabToWindow). The window stays open even when that was its last tab.
   */
  releaseTab(tab) {
    const i = this.tabs.indexOf(tab);
    if (i < 0) return;
    const wasActive = this.activeId === tab.id;
    if (this.htmlFullscreenTab === tab) this.setHtmlFullscreen(tab, false);
    if (wasActive) this.hidePopup(); // popups (permission prompts, autofill) are about the active tab
    this.tabs.splice(i, 1);
    try {
      this.win.contentView.removeChildView(tab.view);
    } catch {
      /* window already gone */
    }
    if (wasActive) {
      this.activeId = null;
      if (this.tabs.length) this.activate(this.tabs[Math.min(i, this.tabs.length - 1)].id);
    }
    this.sendState();
    this.browser.scheduleSessionSave();
  }

  /** Takes in a tab released by another window (releaseTab) at `index` (default: last) and shows it. */
  adoptTab(tab, { index = null, focus = true } = {}) {
    tab.ctl = this;
    tab.openerId = null; // "back to the opener on close" is about tabs of one window
    const at = Number.isInteger(index) ? Math.max(0, Math.min(index, this.tabs.length)) : this.tabs.length;
    this.tabs.splice(at, 0, tab);
    this.win.contentView.addChildView(tab.view);
    if (this.overlay && this.popup) this.win.contentView.addChildView(this.overlay); // keep an open popup above the page
    this.activate(tab.id, { focus });
    this.sendState();
    this.browser.scheduleSessionSave();
  }

  reopenClosedTab() {
    const t = this.closedTabs.pop();
    if (t) this.newTab({ url: t.url, index: t.index });
  }

  moveTab(id, index) {
    const i = this.tabs.findIndex((t) => t.id === id);
    if (i < 0 || !Number.isInteger(index)) return;
    const [tab] = this.tabs.splice(i, 1);
    this.tabs.splice(Math.max(0, Math.min(index, this.tabs.length)), 0, tab);
    this.sendState();
    this.browser.scheduleSessionSave();
  }

  cycleTab(delta) {
    if (this.tabs.length < 2) return;
    const i = this.tabs.findIndex((t) => t.id === this.activeId);
    this.activate(this.tabs[(i + delta + this.tabs.length) % this.tabs.length].id);
  }

  onTabUpdate(tab) {
    if (tab.id === this.activeId) this.layoutPanel();
    this.sendState();
    this.browser.scheduleSessionSave();
  }

  // ---------------------------------------------------------------------------------- layout
  contentRect() {
    const [width, height] = this.win.getContentSize();
    const full = this.win.isFullScreen() && this.htmlFullscreenTab;
    const top = full ? 0 : this.topInset;
    const f = full ? 0 : this.agent ? AGENT_FRAME : this.controlFramed ? CONTROL_FRAME : 0;
    return { x: f, y: top, width: Math.max(0, width - 2 * f), height: Math.max(0, height - top - f) };
  }

  layout() {
    if (this.destroyed) return;
    const rect = this.contentRect();
    for (const t of this.tabs) {
      if (t.id === this.activeId) {
        t.view.setBounds(rect);
        t.view.setVisible(true);
      } else t.view.setVisible(false);
    }
    this.layoutPanel();
    if (this.popup && this.overlay) this.positionOverlay();
  }

  setTopInset(px) {
    const v = Math.max(0, Math.min(400, Math.round(px)));
    if (v === this.topInset) return;
    this.topInset = v;
    this.layout();
  }

  setHtmlFullscreen(tab, on) {
    if (on) {
      this.htmlFullscreenTab = tab;
      this.win.setFullScreen(true);
    } else if (this.htmlFullscreenTab === tab) {
      this.htmlFullscreenTab = null;
      this.win.setFullScreen(false);
    }
    this.layout();
    this.sendState();
  }

  // ----------------------------------------------------------------------------- error panel
  ensurePanel() {
    if (this.panel) return this.panel;
    this.panel = new WebContentsView({
      webPreferences: { preload: this.browser.paths.shellPreload, sandbox: true, contextIsolation: true, partition: 'lwui', spellcheck: false, devTools: this.browser.dev },
    });
    this.panel.setVisible(false);
    this.panel.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    this.panel.webContents.on('will-navigate', (e) => e.preventDefault());
    this.panel.webContents.on('before-input-event', (event, input) => this.browser.shortcuts.handle(event, input, this, this.activeTab()));
    // The first error can arrive before the panel page has loaded: replay the latest state then.
    this.panel.webContents.on('did-finish-load', () => {
      if (this.panelData) this.panel.webContents.send('panel', this.panelData);
    });
    this.panel.webContents.loadURL(PANEL_URL);
    this.win.contentView.addChildView(this.panel);
    return this.panel;
  }

  layoutPanel() {
    const tab = this.activeTab();
    const err = tab && tab.error && tab.error.kind !== 'cert-allowed' ? tab.error : null;
    if (!err) {
      if (this.panel) this.panel.setVisible(false);
      return;
    }
    const panel = this.ensurePanel();
    // keep above the tab view
    this.win.contentView.addChildView(panel);
    if (this.overlay && this.popup) this.win.contentView.addChildView(this.overlay);
    panel.setBounds(this.contentRect());
    panel.setVisible(true);
    this.panelData = { tabId: tab.id, error: err, theme: this.themeName(), engine: this.browser.engine().name };
    if (!panel.webContents.isLoading()) panel.webContents.send('panel', this.panelData);
  }

  // ---------------------------------------------------------------------------------- effects
  /**
   * A new download flies from the middle of the page into the downloads button at `to` (shell coordinates):
   * a transparent view over the whole window (src/shell/fx.html), there only while the effect plays.
   */
  async flyDownload(to, name) {
    if (this.destroyed || this.win.isMinimized() || !this.win.isVisible() || this.agent) return;
    if (!this.fx) {
      this.fx = new WebContentsView({
        webPreferences: { preload: this.browser.paths.shellPreload, sandbox: true, contextIsolation: true, partition: 'lwui', spellcheck: false, transparent: true, devTools: this.browser.dev },
      });
      this.fx.setBackgroundColor('#00000000');
      this.fx.setVisible(false);
      this.fx.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      this.fx.webContents.on('will-navigate', (e) => e.preventDefault());
      this.fxReady = new Promise((resolve) => this.fx.webContents.once('did-finish-load', resolve));
      this.fx.webContents.loadURL(FX_URL);
    }
    await this.fxReady;
    if (this.destroyed || this.fx.webContents.isDestroyed()) return;
    const [width, height] = this.win.getContentSize();
    const page = this.contentRect();
    this.fx.setBounds({ x: 0, y: 0, width, height });
    this.win.contentView.addChildView(this.fx); // topmost
    this.fx.setVisible(true);
    this.fx.webContents.send('fly', { from: { x: page.x + page.width / 2, y: page.y + Math.min(page.height / 2, 320) }, to, name: String(name || '').slice(0, 200), theme: this.themeName() });
    clearTimeout(this.fxTimer);
    this.fxTimer = setTimeout(() => {
      if (!this.destroyed && this.fx && !this.fx.webContents.isDestroyed()) this.fx.setVisible(false);
    }, FLY_MS + 60);
  }

  // ----------------------------------------------------------------------------------- popups
  ensureOverlay() {
    if (this.overlay) return this.overlay;
    this.overlay = new WebContentsView({
      webPreferences: { preload: this.browser.paths.shellPreload, sandbox: true, contextIsolation: true, partition: 'lwui', spellcheck: false, transparent: true, devTools: this.browser.dev },
    });
    this.overlay.setBackgroundColor('#00000000');
    this.overlay.setVisible(false);
    this.overlay.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    this.overlay.webContents.on('will-navigate', (e) => e.preventDefault());
    this.overlay.webContents.on('before-input-event', (event, input) => {
      if (input.type === 'keyDown' && input.key === 'Escape') {
        event.preventDefault();
        this.hidePopup();
        return;
      }
      this.browser.shortcuts.handle(event, input, this, this.activeTab());
    });
    this.overlay.webContents.on('blur', () => {
      if (!this.popup || !this.popup.closeOnBlur) return;
      // The overlay also loses focus while its window closes (e.g. "Exit" in the menu popup): by the time the
      // timer runs, the window and its views may be gone.
      setTimeout(() => {
        if (this.destroyed || !this.popup || !this.popup.closeOnBlur) return;
        const wc = this.overlay && this.overlay.webContents;
        if (!wc || wc.isDestroyed() || wc.isFocused()) return;
        this.hidePopup();
      }, 50);
    });
    this.overlayReady = new Promise((resolve) => this.overlay.webContents.once('did-finish-load', resolve));
    this.overlay.webContents.loadURL(OVERLAY_URL);
    this.win.contentView.addChildView(this.overlay);
    return this.overlay;
  }

  /**
   * Show a popup in the overlay view.
   * @param {string} kind
   * @param {any} data
   * @param {{x: number, y: number, width: number, height?: number, align?: 'left'|'right'}} anchor window-content coordinates
   * @param {{focus?: boolean, closeOnBlur?: boolean, modal?: boolean}} [opts]
   */
  async showPopup(kind, data, anchor, { focus = true, closeOnBlur = true, modal = false } = {}) {
    const ov = this.ensureOverlay();
    await this.overlayReady;
    if (this.destroyed) return;
    const seq = (this.popupSeq = (this.popupSeq || 0) + 1);
    this.popup = { kind, anchor, width: anchor.width + 2 * OVERLAY_PAD.x, height: anchor.height || 40, closeOnBlur, modal, seq };
    this.win.contentView.addChildView(ov); // topmost
    // The card's room below its anchor (window bottom, see positionOverlay): long lists scroll inside it.
    const ch = this.win.getContentSize()[1];
    const maxHeight = modal ? null : Math.max(120, ch - Math.max(0, anchor.y - OVERLAY_PAD.top) - 4 - OVERLAY_PAD.top - OVERLAY_PAD.bottom);
    ov.webContents.send('popup', { kind, data, seq, theme: this.themeName(), width: anchor.width, modal, maxHeight });
    this.positionOverlay();
    ov.setVisible(true);
    if (focus) ov.webContents.focus();
  }

  /** The overlay reports its rendered size. */
  resizePopup(seq, width, height) {
    if (!this.popup || this.popup.seq !== seq) return;
    this.popup.width = Math.max(40, Math.min(1000, Math.round(width)));
    this.popup.height = Math.max(20, Math.min(2000, Math.round(height)));
    this.positionOverlay();
  }

  positionOverlay() {
    if (!this.popup || !this.overlay) return;
    const [cw, ch] = this.win.getContentSize();
    const p = this.popup;
    if (p.modal) {
      this.overlay.setBounds({ x: 0, y: 0, width: cw, height: ch });
      return;
    }
    const a = p.anchor;
    const w = Math.min(p.width, cw);
    let x = (a.align === 'right' ? a.x + (a.width || 0) - w + OVERLAY_PAD.x : a.x - OVERLAY_PAD.x);
    x = Math.max(0, Math.min(x, cw - w));
    const y = Math.max(0, a.y - OVERLAY_PAD.top);
    const h = Math.min(p.height, ch - y - 4);
    this.overlay.setBounds({ x: Math.round(x), y: Math.round(y), width: Math.round(w), height: Math.max(0, Math.round(h)) });
  }

  hidePopup(kind = null) {
    if (!this.popup || (kind && this.popup.kind !== kind)) return;
    const was = this.popup;
    this.popup = null;
    // The window fires blur while it closes; by then its views may already be gone.
    if (this.destroyed || this.win.isDestroyed()) return;
    if (this.overlay && !this.overlay.webContents.isDestroyed()) {
      this.overlay.setVisible(false);
      this.overlay.webContents.send('popup', null);
    }
    this.browser.onPopupClosed(this, was);
    if (was.modal || was.closeOnBlur) {
      const t = this.activeTab();
      if (t && !this.shellFocused && !t.wc.isDestroyed()) t.wc.focus();
    }
  }

  /** Modal question in the overlay; resolves with the answer object (or null on dismiss). */
  ask(kind, data) {
    return new Promise((resolve) => {
      const id = `${Date.now()}-${Math.random()}`;
      this.pendingPrompts.set(id, resolve);
      this.showPopup(kind, { ...data, promptId: id }, { x: 0, y: 0, width: 420 }, { modal: true, closeOnBlur: false });
    });
  }

  answer(id, value) {
    const r = this.pendingPrompts.get(id);
    if (!r) return;
    this.pendingPrompts.delete(id);
    r(value);
    if (this.popup && this.popup.modal) this.hidePopup();
  }

  promptHttpAuth(tab, details, authInfo) {
    this.activate(tab.id);
    return this.ask('http-auth', { host: authInfo.host, realm: authInfo.realm || '', isProxy: !!authInfo.isProxy, scheme: authInfo.scheme });
  }

  // ------------------------------------------------------------------------------------ state
  sendState() {
    if (this.stateTimer || this.destroyed) return;
    this.stateTimer = setTimeout(() => {
      this.stateTimer = null;
      if (this.destroyed || this.shell.isDestroyed()) return;
      const t = this.activeTab();
      const title = `${this.agent ? `${this.agent.client} · ` : ''}${(t && t.title) || 'New Tab'} - Ludworks Browser${this.private ? ' (Private)' : ''}${this.browser.processNumber > 1 ? ` (Process ${this.browser.processNumber})` : ''}`;
      if (this.win.getTitle() !== title) this.win.setTitle(title);
      const st = this.state();
      if (!!st.control !== !!this.controlFramed) {
        this.controlFramed = !!st.control;
        this.layout();
      }
      this.shell.send('state', st);
    }, 16);
  }

  state() {
    return {
      private: this.private,
      theme: this.themeName(),
      chromeTheme: this.private || !this.browser.themes ? null : this.browser.themes.shellTheme(),
      platform: process.platform,
      maximized: this.win.isMaximized(),
      fullscreen: this.win.isFullScreen(),
      htmlFullscreen: !!this.htmlFullscreenTab,
      agent: this.agent,
      control: this.browser.agent && !this.agent ? this.browser.agent.controlOf(this.activeTab()) : null,
      activeId: this.activeId,
      tabs: this.tabs.map((t) => t.snapshot()),
      keyState: this.browser.autofill ? this.browser.autofill.keyStateFor(this.activeTab()) : null,
      toolbarButtons: this.browser.featureButtons(this),
      ...this.browser.sharedShellState(),
    };
  }

  // -------------------------------------------------------------------------------- teardown
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const t of this.tabs) t.destroy();
    this.tabs = [];
    for (const r of this.pendingPrompts.values()) r(null);
    this.pendingPrompts.clear();
    clearTimeout(this.fxTimer);
    for (const v of [this.overlay, this.panel, this.fx]) {
      try {
        if (v && !v.webContents.isDestroyed()) v.webContents.close();
      } catch (e) {
        log.debug('view close failed', { message: e.message });
      }
    }
    this.browser.onWindowClosed(this);
  }
}

function defaultBounds() {
  const { workArea } = screen.getPrimaryDisplay();
  const width = Math.min(1440, Math.round(workArea.width * 0.85));
  const height = Math.min(960, Math.round(workArea.height * 0.88));
  return { width, height, x: workArea.x + Math.round((workArea.width - width) / 2), y: workArea.y + Math.round((workArea.height - height) / 2) };
}
