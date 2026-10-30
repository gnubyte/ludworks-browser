// Dragging tabs between windows (src/main/tab-drag.js): pulling a tab out into a window that follows the cursor,
// a window's only tab moving the window itself, dropping onto another window's strip (index, pinned tabs, the
// frontmost window), the drop marker and the see-through dragged window. Windows and the browser are fakes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { TabDrag, dropIndex, cleanStrip } from '../build/app/main/tab-drag.js';

let nextId = 1;

/** A BrowserWindow: content starts `frame` px inside the window bounds. */
function fakeWin({ x = 0, y = 0, width = 1000, height = 700, frame = { x: 0, y: 0 }, maximized = false } = {}) {
  const w = {
    b: { x, y, width, height },
    frame,
    maximized,
    visible: true,
    opacity: 1,
    focused: 0,
    getBounds: () => ({ ...w.b }),
    getContentBounds: () => ({ x: w.b.x + frame.x, y: w.b.y + frame.y, width: w.b.width - 2 * frame.x, height: w.b.height - frame.y - frame.x }),
    getNormalBounds: () => ({ ...w.b }),
    setBounds: (nb) => Object.assign(w.b, nb),
    setOpacity: (o) => (w.opacity = o),
    isDestroyed: () => false,
    isVisible: () => w.visible,
    isMinimized: () => false,
    isFullScreen: () => false,
    isMaximized: () => w.maximized,
    unmaximize: () => (w.maximized = false),
    focus: () => w.focused++,
  };
  return w;
}

function fakeTab(o = {}) {
  return { id: nextId++, pinned: false, private: false, destroyed: false, wc: { isDestroyed: () => false, focus() {} }, ...o };
}

/** A WindowCtl with `tabs`; its strip reports 100 px wide tabs from x = 8. */
function fakeCtl(b, tabs, winOpts, extra = {}) {
  const ctl = {
    win: fakeWin(winOpts),
    tabs: [],
    private: false,
    agent: null,
    destroyed: false,
    focusedAt: 0,
    sent: [],
    shell: { isDestroyed: () => false, send: (ch, m) => ctl.sent.push([ch, m]) },
    activeTab: () => ctl.tabs[0] || null,
    ...extra,
  };
  for (const t of tabs) {
    t.ctl = ctl;
    t.private = ctl.private;
    ctl.tabs.push(t);
  }
  ctl.strip = () => {
    ctl.tabStrip = { tabs: ctl.tabs.map((t, i) => ({ id: t.id, left: 8 + i * 100, right: 108 + i * 100 })), bottom: 40 };
  };
  ctl.strip();
  b.windows.add(ctl);
  return ctl;
}

function fakeBrowser() {
  const b = {
    windows: new Set(),
    created: [],
    moves: [],
    newWindow(o) {
      const ctl = fakeCtl(b, [], { ...o.bounds }, { private: !!o.private, showInactive: !!o.inactive });
      b.created.push({ ctl, o });
      return ctl;
    },
    moveTabToWindow(tab, to, o = {}) {
      const from = tab.ctl;
      if (from === to || from.private !== to.private) return false;
      b.moves.push({ tab, from, to, o });
      from.tabs.splice(from.tabs.indexOf(tab), 1);
      const at = Number.isInteger(o.index) ? o.index : to.tabs.length;
      to.tabs.splice(at, 0, tab);
      tab.ctl = to;
      if (!from.tabs.length) {
        from.destroyed = true;
        b.windows.delete(from);
      }
      from.strip();
      to.strip();
      return true;
    },
  };
  return b;
}

function setup() {
  const b = fakeBrowser();
  let cursor = { x: 0, y: 0 };
  const drag = new TabDrag(b, () => cursor);
  return { b, drag, at: (x, y) => (cursor = { x, y }) };
}

test('tab drag: a tab pulled out of a window with others moves into a new window that follows the cursor', () => {
  const { b, drag, at } = setup();
  const [t1, t2] = [fakeTab(), fakeTab()];
  const src = fakeCtl(b, [t1, t2], { x: 100, y: 100, width: 1200, height: 800 });
  at(400, 300);
  assert.equal(drag.start(src, t2, { x: 60, y: 20 }), true);
  const nw = b.created[0];
  assert.equal(nw.o.inactive, true, 'opens without taking focus while dragging');
  assert.equal(nw.o.private, false);
  assert.equal(nw.o.bounds.width, 1200, "the size of the window it leaves");
  assert.deepEqual(b.moves[0].o, { focus: false });
  assert.equal(t2.ctl, nw.ctl);
  assert.deepEqual(nw.ctl.win.getContentBounds().x, 400 - 60);
  at(700, 520);
  drag.move();
  assert.deepEqual(nw.ctl.win.b, { x: 640, y: 500, width: 1200, height: 800 });
  drag.end();
  assert.equal(nw.ctl.showInactive, false, 'shows with focus once it has painted');
  assert.equal(nw.ctl.win.focused, 1);
  assert.equal(drag.drag, null);
  assert.deepEqual(src.tabs, [t1]);
});

test('tab drag: the window frame is accounted for, so the grabbed point stays under the cursor', () => {
  const { b, drag, at } = setup();
  const t = fakeTab();
  const src = fakeCtl(b, [t], { x: 50, y: 50, frame: { x: 7, y: 30 } });
  at(300, 200);
  drag.start(src, t, { x: 40, y: 15 });
  const c = src.win.getContentBounds();
  assert.deepEqual([c.x + 40, c.y + 15], [300, 200]);
});

test("tab drag: a window's only tab moves the window itself, restoring it from maximized first", () => {
  const { b, drag, at } = setup();
  const t = fakeTab();
  const src = fakeCtl(b, [t], { x: 0, y: 0, maximized: true });
  at(500, 400);
  drag.start(src, t, { x: 70, y: 18 });
  assert.equal(b.created.length, 0);
  assert.equal(src.win.maximized, false);
  assert.deepEqual([src.win.b.x, src.win.b.y], [430, 382]);
  drag.end();
  assert.equal(src.win.focused, 1);
  assert.deepEqual(src.tabs, [t]);
});

test("tab drag: dropped on another window's strip, the tab joins it where the marker showed", () => {
  const { b, drag, at } = setup();
  const t = fakeTab();
  const src = fakeCtl(b, [t, fakeTab()], { x: 0, y: 0 });
  const [a1, a2, a3] = [fakeTab(), fakeTab(), fakeTab()];
  const other = fakeCtl(b, [a1, a2, a3], { x: 1200, y: 100 });
  at(500, 500);
  drag.start(src, t, { x: 60, y: 20 });
  const dragged = t.ctl;
  // over the second tab's right half (content x 8+100+70 = 178) of the other window
  at(1200 + 178, 100 + 20);
  drag.move();
  assert.deepEqual(other.sent.at(-1), ['tab-drop', { index: 2 }]);
  assert.equal(dragged.win.opacity, 0.6, 'see-through while over a strip it would join');
  // off the strip again: marker gone, opaque again
  at(1200 + 178, 100 + 200);
  drag.move();
  assert.deepEqual(other.sent.at(-1), ['tab-drop', null]);
  assert.equal(dragged.win.opacity, 1);
  at(1200 + 30, 100 + 10);
  drag.move();
  drag.end();
  assert.deepEqual(other.tabs, [t, a1, a2, a3]);
  assert.equal(other.win.focused, 1);
  assert.equal(dragged.destroyed, true, 'the window made for the drag closes once empty');
  assert.deepEqual(other.sent.at(-1), ['tab-drop', null]);
});

test('tab drag: a tab pulled out can go back to the window it came from', () => {
  const { b, drag, at } = setup();
  const [t1, t2, t3] = [fakeTab(), fakeTab(), fakeTab()];
  const src = fakeCtl(b, [t1, t2, t3], { x: 0, y: 0 });
  at(150, 200);
  drag.start(src, t2, { x: 60, y: 20 });
  at(300, 20); // right of the remaining two tabs
  drag.end();
  assert.deepEqual(src.tabs, [t1, t3, t2]);
});

test('tab drag: tabs only join windows of their kind, not AI agent windows, and the frontmost wins', () => {
  const { b, drag, at } = setup();
  const t = fakeTab();
  const src = fakeCtl(b, [t, fakeTab()], { x: 0, y: 0 });
  const priv = fakeCtl(b, [fakeTab()], { x: 2000, y: 0 }, { private: true });
  const agent = fakeCtl(b, [fakeTab()], { x: 3000, y: 0 }, { agent: { client: 'x' } });
  const back = fakeCtl(b, [fakeTab()], { x: 4000, y: 0 }, { focusedAt: 1 });
  const front = fakeCtl(b, [fakeTab()], { x: 4000, y: 0 }, { focusedAt: 5 });
  at(100, 300);
  drag.start(src, t, { x: 60, y: 20 });
  for (const ctl of [priv, agent]) {
    at(ctl.win.b.x + 50, 20);
    drag.move();
    assert.equal(drag.drag.target, null);
  }
  at(4050, 20);
  drag.move();
  assert.equal(drag.drag.target.ctl, front);
  assert.equal(back.sent.length, 0);
});

test('tab drag: refused for AI agent windows and full-screen windows', () => {
  const { b, drag } = setup();
  const t = fakeTab();
  const agent = fakeCtl(b, [t, fakeTab()], {}, { agent: { client: 'x' } });
  assert.equal(drag.start(agent, t, { x: 1, y: 1 }), false);
  const u = fakeTab();
  const fs = fakeCtl(b, [u, fakeTab()], {});
  fs.win.isFullScreen = () => true;
  assert.equal(drag.start(fs, u, { x: 1, y: 1 }), false);
  assert.equal(b.created.length, 0);
});

test('tab drag: the drag ends quietly when the dragged window goes away', () => {
  const { b, drag, at } = setup();
  const t = fakeTab();
  const src = fakeCtl(b, [t], {});
  drag.start(src, t, { x: 1, y: 1 });
  src.destroyed = true;
  at(10, 10);
  drag.move();
  assert.equal(drag.drag, null);
  drag.end();
});

test('dropIndex: by tab middles; pinned tabs stay in front of the others', () => {
  const b = fakeBrowser();
  const [p1, p2, a, c] = [fakeTab({ pinned: true }), fakeTab({ pinned: true }), fakeTab(), fakeTab()];
  const ctl = fakeCtl(b, [p1, p2, a, c], {});
  // middles at 58, 158, 258, 358
  assert.equal(dropIndex(ctl, 0, false), 2);
  assert.equal(dropIndex(ctl, 300, false), 3);
  assert.equal(dropIndex(ctl, 999, false), 4);
  assert.equal(dropIndex(ctl, 999, true), 2);
  assert.equal(dropIndex(ctl, 100, true), 1);
});

test('cleanStrip: keeps well-formed tab rectangles only', () => {
  assert.equal(cleanStrip(null), null);
  assert.equal(cleanStrip({ tabs: [] }), null);
  assert.deepEqual(cleanStrip({ tabs: [{ id: 1, left: 8, right: 108, x: 'junk' }, { id: 'a', left: 0, right: 1 }, { id: 2, left: NaN, right: 3 }], bottom: 40 }), { tabs: [{ id: 1, left: 8, right: 108 }], bottom: 40 });
  assert.equal(cleanStrip({ tabs: [], bottom: 9999 }).bottom, 400);
});
