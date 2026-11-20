// Dragging a tab out of its window's tab strip. The shell (src/shell/shell.js) says when the drag leaves the
// strip, moves and ends; positions come from the OS cursor, not from the page, so a window that follows the
// cursor does not jitter. Pulled out, the tab moves into a window of its own that follows the cursor (a
// window's only tab moves the window itself); dropped on another window's tab strip, it joins that window at
// the marked spot. Tabs only move between windows of the same kind (normal or private, never an AI agent's).

/** @typedef {{x: number, y: number, width: number, height: number}} Rect */

const STRIP_SLOP = 16; // px around a window's tab strip that still count as "on the strip"
const SNAP_EDGE = 6; // px from a screen's top / left / right edge where a dropped window maximizes or takes half
const HOVER_OPACITY = 0.6; // the dragged window while it is over a strip it would join, so the drop marker shows

export class TabDrag {
  /**
   * @param {import('./browser.js').Browser} browser
   * @param {() => {x: number, y: number}} cursor screen position of the mouse (DIP)
   * @param {{displayAt?: (p: {x: number, y: number}) => {bounds: Rect, workArea: Rect}|null,
   *   preview?: {show: (r: Rect, above: any) => void, hide: () => void, dispose?: () => void}}} [screenOpts]
   *   the display under a point, and the outline that shows where a dropped window will snap
   */
  constructor(browser, cursor, { displayAt = () => null, preview = { show() {}, hide() {} } } = {}) {
    this.b = browser;
    this.cursor = cursor;
    this.displayAt = displayAt;
    this.preview = preview;
    this.drag = null; // {tab, win, created, grab, target: {ctl, index}|null}
  }

  /**
   * The tab left its strip. `grab` is where the cursor holds the window: content coordinates of the point
   * under the cursor once the tab is that window's first tab.
   */
  start(ctl, tab, grab) {
    if (this.drag) this.end();
    if (!tab || tab.destroyed || tab.ctl !== ctl || !movable(ctl) || ctl.win.isFullScreen()) return false;
    let win = ctl;
    let created = false;
    if (ctl.tabs.length > 1) {
      const p = this.cursor();
      const nb = ctl.win.getNormalBounds();
      win = this.b.newWindow({ private: ctl.private, empty: true, inactive: true, bounds: { x: Math.round(p.x - grab.x), y: Math.round(p.y - grab.y), width: nb.width, height: nb.height } });
      this.b.moveTabToWindow(tab, win, { focus: false });
      created = true;
    } else if (ctl.win.isMaximized()) ctl.win.unmaximize();
    // the size is set with every move: setPosition alone grows a window a pixel at a time at fractional display scaling
    const { width, height } = win.win.getBounds();
    this.drag = { tab, win, created, grab: { x: grab.x, y: grab.y }, size: { width, height }, target: null };
    this.move();
    return true;
  }

  move() {
    const d = this.drag;
    if (!d) return;
    if (d.win.destroyed || d.win.win.isDestroyed() || d.tab.destroyed) {
      this.drag = null;
      this.setTarget(d, null);
      if (this.preview.dispose) this.preview.dispose();
      return;
    }
    const p = this.cursor();
    const w = d.win.win;
    const b = w.getBounds();
    const c = w.getContentBounds();
    w.setBounds({ x: Math.round(p.x - d.grab.x + b.x - c.x), y: Math.round(p.y - d.grab.y + b.y - c.y), ...d.size });
    const target = this.targetAt(p, d);
    this.setTarget(d, target);
    // pushed against a screen's top edge it will fill that screen, against a side edge half of it (as Windows does)
    const snap = target ? null : snapZone(p, this.displayAt(p));
    if (JSON.stringify(snap) !== JSON.stringify(d.snap || null)) {
      d.snap = snap;
      if (snap) this.preview.show(snap.rect, w);
      else this.preview.hide();
    }
  }

  /** The mouse button was released: join the window under the cursor, or stay in the window that followed it. */
  end() {
    const d = this.drag;
    if (!d) return;
    this.move();
    if (this.drag !== d) return; // the tab or its window went away
    this.drag = null;
    const t = d.target;
    this.setTarget(d, null);
    if (this.preview.dispose) this.preview.dispose();
    else this.preview.hide();
    if (!t && d.snap && !d.win.destroyed && !d.win.win.isDestroyed()) {
      d.win.win.setBounds(d.snap.rect);
      if (d.snap.zone === 'max') d.win.win.maximize();
    }
    if (t && !t.ctl.destroyed && !d.tab.destroyed && this.b.moveTabToWindow(d.tab, t.ctl, { index: t.index })) {
      t.ctl.win.focus();
      return;
    }
    d.win.showInactive = false; // not shown yet: it shows (and takes focus) once it has painted
    if (d.win.win.isVisible()) d.win.win.focus();
    const a = d.win.activeTab();
    if (a && !a.wc.isDestroyed()) a.wc.focus();
  }

  /** The window whose tab strip is under the screen point `p`, and where in it the tab would land. */
  targetAt(p, d) {
    let best = null;
    for (const ctl of this.b.windows) {
      if (ctl === d.win || ctl.private !== d.tab.private || !movable(ctl) || !ctl.tabStrip) continue;
      const w = ctl.win;
      if (w.isDestroyed() || !w.isVisible() || w.isMinimized() || w.isFullScreen()) continue;
      const c = w.getContentBounds();
      const x = p.x - c.x;
      const y = p.y - c.y;
      if (x < 0 || x > c.width || y < -STRIP_SLOP || y > ctl.tabStrip.bottom + STRIP_SLOP) continue;
      // overlapping windows: the one focused last is most likely in front
      if (!best || (ctl.focusedAt || 0) > (best.ctl.focusedAt || 0)) best = { ctl, x };
    }
    return best ? { ctl: best.ctl, index: dropIndex(best.ctl, best.x, d.tab.pinned) } : null;
  }

  setTarget(d, t) {
    const prev = d.target;
    d.target = t;
    if (prev && (!t || prev.ctl !== t.ctl)) send(prev.ctl, null);
    if (t && (!prev || prev.ctl !== t.ctl || prev.index !== t.index)) send(t.ctl, { index: t.index });
    if (!!prev !== !!t && !d.win.destroyed && !d.win.win.isDestroyed()) d.win.win.setOpacity(t ? HOVER_OPACITY : 1);
  }
}

/**
 * Where a window dropped with the cursor at `p` snaps on `display`: {zone: 'max'|'left'|'right', rect} filling the
 * work area or its left / right half, or null away from the edges.
 */
export function snapZone(p, display) {
  if (!display || !display.bounds || !display.workArea) return null;
  const b = display.bounds;
  const wa = display.workArea;
  if (p.x < b.x || p.x >= b.x + b.width || p.y < b.y - SNAP_EDGE || p.y >= b.y + b.height) return null;
  const half = Math.floor(wa.width / 2);
  if (p.y <= b.y + SNAP_EDGE) return { zone: 'max', rect: { x: wa.x, y: wa.y, width: wa.width, height: wa.height } };
  if (p.x <= b.x + SNAP_EDGE) return { zone: 'left', rect: { x: wa.x, y: wa.y, width: half, height: wa.height } };
  if (p.x >= b.x + b.width - 1 - SNAP_EDGE) return { zone: 'right', rect: { x: wa.x + half, y: wa.y, width: wa.width - half, height: wa.height } };
  return null;
}

/** Tabs may leave or join normal and private windows, not AI agents' windows (agent/agent.js). */
function movable(ctl) {
  return !ctl.destroyed && !ctl.agent;
}

/**
 * Index in `ctl.tabs` before which a tab dropped at content x `x` goes: past every tab whose middle is left of
 * it, pinned tabs staying in front of the others.
 */
export function dropIndex(ctl, x, pinned) {
  const rects = new Map((ctl.tabStrip.tabs || []).map((r) => [r.id, r]));
  let index = 0;
  ctl.tabs.forEach((t, i) => {
    const r = rects.get(t.id);
    if (r && x > (r.left + r.right) / 2) index = i + 1;
  });
  const pinnedCount = ctl.tabs.filter((t) => t.pinned).length;
  return pinned ? Math.min(index, pinnedCount) : Math.max(index, pinnedCount);
}

function send(ctl, msg) {
  if (!ctl.destroyed && !ctl.shell.isDestroyed()) ctl.shell.send('tab-drop', msg);
}

/** The tab strip geometry a shell reports (`tab.strip`), checked: {tabs: [{id, left, right}], bottom}. */
export function cleanStrip(a) {
  const num = (v) => Number.isFinite(v) && Math.abs(v) < 1e5;
  if (!a || !Array.isArray(a.tabs) || !num(a.bottom)) return null;
  const tabs = a.tabs
    .slice(0, 1000)
    .filter((r) => r && Number.isInteger(r.id) && num(r.left) && num(r.right))
    .map((r) => ({ id: r.id, left: r.left, right: r.right }));
  return { tabs, bottom: Math.max(0, Math.min(400, a.bottom)) };
}
