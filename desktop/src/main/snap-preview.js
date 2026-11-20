// The outline that shows where a window dragged by its tab will snap when dropped at a screen edge
// (tab-drag.js snapZone): a click-through, translucent window under the dragged one, like Windows' own preview.

import { BrowserWindow } from 'electron';

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;height:100%;background:transparent;overflow:hidden}
div{position:absolute;inset:6px;border-radius:12px;background:rgba(83,82,209,.18);border:2px solid rgba(124,123,240,.85);
box-shadow:0 0 0 1px rgba(255,255,255,.35) inset,0 0 28px 6px rgba(83,82,209,.35);animation:in .14s ease-out}
@keyframes in{from{opacity:0;transform:scale(.97)}}
</style></head><body><div></div></body></html>`;

export class SnapPreview {
  constructor() {
    this.win = null;
  }

  /** Shows the outline over `rect` (screen DIP), just under the window `above`. */
  show(rect, above) {
    if (!this.win || this.win.isDestroyed()) {
      this.win = new BrowserWindow({
        show: false,
        frame: false,
        transparent: true,
        resizable: false,
        movable: false,
        focusable: false,
        skipTaskbar: true,
        hasShadow: false,
        backgroundColor: '#00000000',
        webPreferences: { sandbox: true, contextIsolation: true, javascript: false, spellcheck: false },
      });
      this.win.setIgnoreMouseEvents(true);
      this.win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(PAGE)}`);
    }
    this.win.setBounds(rect);
    this.win.showInactive();
    if (above && !above.isDestroyed()) above.moveTop();
  }

  hide() {
    if (this.win && !this.win.isDestroyed()) this.win.hide();
  }

  /** At the end of a drag: an idle window would keep the app from quitting with its last browser window. */
  dispose() {
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
    this.win = null;
  }
}
