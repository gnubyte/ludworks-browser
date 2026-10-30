// Extension action popups: chrome-extension://<id>/<popup>.html in a WebContentsView of its own on top
// of the window (same session as the extension, sandboxed, context-isolated), anchored under the toolbar
// button, sized to its content like Chrome (25×25 to 800×600), closed on blur, Escape, tab switch,
// window blur/resize, or when the popup navigates away from the extension.

import { WebContentsView, Menu, clipboard } from 'electron';
import { log } from '../util/log.js';

const MIN = 25;
const MAX_W = 800;
const MAX_H = 600;

export class ActionPopups {
  /** @param {import('./extensions.js').Extensions} mgr */
  constructor(mgr) {
    this.mgr = mgr;
    this.open = new Map(); // WindowCtl → popup state
  }

  byWebContents(wc) {
    for (const p of this.open.values()) if (p.wc === wc) return p;
    return null;
  }

  ids() {
    const out = [];
    for (const p of this.open.values()) if (!p.wc.isDestroyed()) out.push(p.wc.id);
    return out;
  }

  isOpen(ctl, extId) {
    const p = this.open.get(ctl);
    return !!(p && p.extId === extId);
  }

  /**
   * @param {import('../window.js').WindowCtl} ctl
   * @param {{id: string}} ext
   * @param {string} page popup path inside the extension
   * @param {{x: number, y: number, width: number}} anchor the button's right edge = x + width
   */
  show(ctl, ext, page, anchor) {
    this.closeIn(ctl);
    const ses = this.mgr.ses;
    const view = new WebContentsView({
      webPreferences: { session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false, enablePreferredSizeMode: true, spellcheck: false, backgroundThrottling: false, devTools: true, safeDialogs: true },
    });
    const wc = view.webContents;
    view.setBackgroundColor('#ffffff');
    view.setVisible(false);
    view.setBorderRadius?.(8);
    const st = { ctl, extId: ext.id, view, wc, anchor: { ...anchor }, size: null, shown: false, closing: false, devtools: false };
    this.open.set(ctl, st);
    ctl.win.contentView.addChildView(view);
    this.mgr.api.pushTabMap(); // the extension learns this web contents is not a tab
    const url = `chrome-extension://${ext.id}/${String(page).replace(/^\/+/, '')}`;
    wc.on('preferred-size-changed', (_e, size) => this.resize(st, size));
    wc.on('did-finish-load', () => {
      if (!st.size) this.resize(st, { width: 320, height: 200 });
      if (!st.closing) wc.focus();
    });
    wc.on('blur', () => {
      setTimeout(() => {
        if (st.closing || wc.isDestroyed() || st.devtools || wc.isFocused() || wc.isDevToolsOpened()) return;
        this.close(st);
      }, 120);
    });
    wc.on('before-input-event', (e, input) => {
      if (input.type === 'keyDown' && input.key === 'Escape' && !input.control && !input.alt && !input.meta && !input.shift) {
        e.preventDefault();
        this.close(st);
        return;
      }
      this.mgr.api.onKey(e, input, ctl, null);
    });
    wc.setWindowOpenHandler(({ url: u, disposition }) => {
      this.openLink(st, u, disposition);
      return { action: 'deny' };
    });
    wc.on('will-navigate', (e) => {
      const u = e.url || '';
      if (u.startsWith(`chrome-extension://${ext.id}/`)) return;
      e.preventDefault();
      this.openLink(st, u, 'foreground-tab');
    });
    wc.on('context-menu', (_e, p) => this.contextMenu(st, p));
    wc.on('devtools-opened', () => (st.devtools = true));
    wc.on('devtools-closed', () => {
      st.devtools = false;
      if (!wc.isDestroyed() && !wc.isFocused()) this.close(st);
    });
    wc.on('render-process-gone', () => this.close(st));
    wc.on('destroyed', () => this.close(st)); // window.close() in the popup
    wc.on('console-message', (e) => {
      if (e.level === 'error') this.mgr.noteError(ext.id, `${e.message}`.slice(0, 500), e.sourceId);
    });
    const blur = () => setTimeout(() => !st.devtools && !ctl.destroyed && !ctl.win.isDestroyed() && !ctl.win.isFocused() && this.close(st), 150);
    const resized = () => this.close(st);
    ctl.win.on('blur', blur);
    ctl.win.on('resize', resized);
    st.unhook = () => {
      if (ctl.win.isDestroyed()) return;
      ctl.win.removeListener('blur', blur);
      ctl.win.removeListener('resize', resized);
    };
    wc.loadURL(url).catch((e) => {
      log.warn('extension popup failed to load', { ext: ext.id, message: e.message });
      this.close(st);
    });
    return st;
  }

  resize(st, size) {
    if (st.closing || st.ctl.destroyed || st.ctl.win.isDestroyed()) return;
    // The preferred size comes rounded, so content 374.4px high would get a 374px view and a
    // scrollbar: give one pixel more — unless the page already fills the view exactly (a layout that
    // follows the view's size, 100vh…), where adding a pixel each time would grow it to the maximum.
    const fit = (v, prev, max) => {
      const n = Math.ceil(Number(v) || 0);
      return Math.max(MIN, Math.min(max, prev && n === prev ? n : n + 1));
    };
    const w = fit(size.width, st.size && st.size.width, MAX_W);
    const h = fit(size.height, st.size && st.size.height, MAX_H);
    st.size = { width: w, height: h };
    const [cw, ch] = st.ctl.win.getContentSize();
    const right = st.anchor.x + (st.anchor.width || 0);
    const x = Math.max(4, Math.min(right - w, cw - w - 4));
    const y = Math.max(0, Math.min(st.anchor.y, ch - h - 4));
    st.view.setBounds({ x: Math.round(x), y: Math.round(y), width: w, height: Math.min(h, Math.max(MIN, ch - y - 4)) });
    if (!st.shown) {
      st.shown = true;
      st.view.setVisible(true);
      st.ctl.win.contentView.addChildView(st.view); // topmost
    }
  }

  openLink(st, url, disposition) {
    if (!/^(https?|ftp):/i.test(url) && !url.startsWith(`chrome-extension://${st.extId}/`)) return;
    const ctl = st.ctl;
    this.close(st);
    if (!ctl.destroyed) ctl.newTab({ url, active: disposition !== 'background-tab' });
  }

  contextMenu(st, p) {
    const wc = st.wc;
    const items = [];
    if (p.isEditable) {
      items.push({ role: 'undo', enabled: p.editFlags.canUndo }, { role: 'redo', enabled: p.editFlags.canRedo }, { type: 'separator' }, { role: 'cut', enabled: p.editFlags.canCut }, { role: 'copy', enabled: p.editFlags.canCopy }, { role: 'paste', enabled: p.editFlags.canPaste }, { role: 'selectAll' });
    } else if (p.selectionText) items.push({ role: 'copy' });
    if (p.linkURL) items.push({ label: 'Copy link address', click: () => clipboard.writeText(p.linkURL) });
    if (items.length) items.push({ type: 'separator' });
    items.push({ label: 'Inspect', click: () => wc.openDevTools({ mode: 'detach' }) });
    Menu.buildFromTemplate(items).popup({ window: st.ctl.win });
  }

  close(st) {
    if (!st || st.closing) return;
    st.closing = true;
    if (this.open.get(st.ctl) === st) this.open.delete(st.ctl);
    if (st.unhook) st.unhook();
    try {
      if (!st.ctl.win.isDestroyed()) st.ctl.win.contentView.removeChildView(st.view);
    } catch {
      /* window gone */
    }
    try {
      if (!st.wc.isDestroyed()) st.wc.close();
    } catch {
      /* already closed */
    }
    this.mgr.api.pushTabMap();
    // focus back to the page
    const t = !st.ctl.destroyed && st.ctl.activeTab();
    if (t && !t.wc.isDestroyed() && !st.ctl.shellFocused && st.ctl.win.isFocused()) t.wc.focus();
  }

  closeIn(ctl) {
    const st = this.open.get(ctl);
    if (st) this.close(st);
  }

  closeExtension(extId) {
    for (const st of [...this.open.values()]) if (st.extId === extId) this.close(st);
  }
}
