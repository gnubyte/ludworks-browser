// What an agent can do in one tab, over the DevTools protocol (cdp.js): accessibility snapshots with
// stable refs, real (trusted) mouse and keyboard input at an element's on-screen point, screenshots,
// script, and the page's dialogs. Input goes to the tab's main target, which routes it to the right
// frame, so elements of out-of-process iframes are clicked at their position in the top viewport.

import { nativeImage } from 'electron';
import { TabCdp, CdpError } from './cdp.js';
import { RefMap, buildSnapshot, formatSnapshot, lineForRef, describeLine } from './snapshot.js';
import { parseChord, keyEvents, modifierEvents, KeyError } from './keys.js';
import { drawMarks } from './annotate.js';

export class AgentError extends Error {}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MAX_FRAMES = 60;
const CONSOLE_KEEP = 300;
const NETWORK_KEEP = 500;
const SHOT_MAX_EDGE = 1568; // larger images are scaled down by the model APIs anyway, which would skew x/y
const FULL_PAGE_MAX = 6000;

// ----------------------------------------------------------------------------- in-page helpers
// Run with Runtime.callFunctionOn (`this` = the element) or Runtime.evaluate. They must not use closures.

function fnInfo() {
  const el = this;
  const tag = el.tagName ? el.tagName.toLowerCase() : '';
  const type = tag === 'input' ? String(el.type || 'text').toLowerCase() : '';
  const role = el.getAttribute ? String(el.getAttribute('role') || '').toLowerCase() : '';
  return {
    tag,
    type,
    role,
    editable: !!el.isContentEditable,
    checked: 'checked' in el ? !!el.checked : el.getAttribute && el.getAttribute('aria-checked') === 'true',
    multiple: !!el.multiple,
    disabled: !!el.disabled,
    readOnly: !!el.readOnly,
  };
}

function fnSelectAll() {
  const el = this;
  el.focus && el.focus({ preventScroll: true });
  if (typeof el.select === 'function' && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) {
    try {
      el.select();
      return true;
    } catch {
      /* number inputs: fall through */
    }
  }
  const doc = el.ownerDocument;
  const sel = doc.getSelection();
  if (el.isContentEditable && sel) {
    const r = doc.createRange();
    r.selectNodeContents(el);
    sel.removeAllRanges();
    sel.addRange(r);
    return true;
  }
  return false;
}

// Sets a value through the element's own prototype setter (so React & co. see it) and fires input + change.
function fnSetValue(value) {
  const el = this;
  const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  const desc = Object.getOwnPropertyDescriptor(proto, 'value');
  if (desc && desc.set) desc.set.call(el, value);
  else el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return el.value;
}

function fnSelectOptions(values) {
  const el = this;
  if (el.tagName !== 'SELECT') return { error: 'not-select' };
  const wanted = values.map((v) => String(v).trim().toLowerCase());
  const opts = [...el.options];
  const picked = [];
  for (const w of wanted) {
    const o = opts.find((x) => x.value.toLowerCase() === w) || opts.find((x) => x.label.trim().toLowerCase() === w || x.text.trim().toLowerCase() === w) || opts.find((x) => x.text.trim().toLowerCase().includes(w));
    if (!o) return { error: 'missing', value: w, options: opts.slice(0, 40).map((x) => x.text.trim() || x.value) };
    picked.push(o);
    if (!el.multiple) break;
  }
  for (const o of opts) o.selected = picked.includes(o);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return { selected: picked.map((o) => o.text.trim() || o.value) };
}

function fnScroll(how, dx, dy) {
  const el = this && this.nodeType === 1 ? this : document.scrollingElement || document.documentElement;
  if (how === 'top') el.scrollTo({ top: 0, behavior: 'instant' });
  else if (how === 'bottom') el.scrollTo({ top: el.scrollHeight, behavior: 'instant' });
  else el.scrollBy({ left: dx, top: dy, behavior: 'instant' });
  return { top: Math.round(el.scrollTop), height: el.scrollHeight, view: el.clientHeight, left: Math.round(el.scrollLeft), width: el.scrollWidth };
}

function fnScrollInfo() {
  const el = document.scrollingElement || document.documentElement;
  return { top: Math.round(el.scrollTop), height: el.scrollHeight, view: el.clientHeight, left: Math.round(el.scrollLeft), width: el.scrollWidth, viewW: el.clientWidth };
}

function fnRelated(hit) {
  const up = (n, target) => {
    for (let i = 0; n && i < 1000; i++) {
      if (n === target) return true;
      n = n.parentNode || n.host;
    }
    return false;
  };
  // `this` is the target: a click lands on it when the topmost element there is it, inside it, or around it
  return up(hit, this) || up(this, hit);
}

// Readable text: the main content first, headings as #, list items as -, links as [text](url).
function fnReadable(links) {
  const root = this && this.nodeType === 1 ? this : document.querySelector('main, [role=main], article') || document.body;
  if (!root) return '';
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'CANVAS', 'IFRAME', 'OBJECT', 'EMBED', 'HEAD', 'META', 'LINK']);
  const BLOCK = /^(ADDRESS|ARTICLE|ASIDE|BLOCKQUOTE|DD|DETAILS|DIALOG|DIV|DL|DT|FIELDSET|FIGCAPTION|FIGURE|FOOTER|FORM|H[1-6]|HEADER|HR|LI|MAIN|NAV|OL|P|PRE|SECTION|SUMMARY|TABLE|TR|UL|BR|TD|TH|CAPTION|LABEL|OPTION)$/;
  const out = [];
  let line = '';
  const flush = () => {
    const t = line.replace(/[ \t ]+/g, ' ').trim();
    if (t) out.push(t);
    line = '';
  };
  const hidden = (el) => {
    if (el.hidden || el.getAttribute('aria-hidden') === 'true') return true;
    const cs = getComputedStyle(el);
    return cs.display === 'none' || cs.visibility === 'hidden';
  };
  const walk = (n, depth) => {
    if (depth > 200) return;
    if (n.nodeType === 3) {
      line += n.nodeValue;
      return;
    }
    if (n.nodeType !== 1 && n.nodeType !== 11) return;
    if (n.nodeType === 1) {
      if (SKIP.has(n.tagName) || hidden(n)) return;
      if (n.tagName === 'INPUT' || n.tagName === 'TEXTAREA' || n.tagName === 'SELECT') return;
    }
    const tag = n.nodeType === 1 ? n.tagName : '';
    const block = BLOCK.test(tag);
    if (block) flush();
    if (/^H[1-6]$/.test(tag)) line += `${'#'.repeat(Number(tag[1]))} `;
    if (tag === 'LI') line += '- ';
    if (tag === 'TD' || tag === 'TH') line += '| ';
    const kids = n.shadowRoot ? [...n.shadowRoot.childNodes, ...n.childNodes] : n.childNodes;
    if (tag === 'A' && links && n.href && !/^javascript:/i.test(n.getAttribute('href') || '')) {
      const start = line.length;
      for (const c of kids) walk(c, depth + 1);
      const text = line.slice(start).replace(/\s+/g, ' ').trim();
      line = `${line.slice(0, start)}${text ? `[${text}](${n.href})` : ''}`;
    } else {
      for (const c of kids) walk(c, depth + 1);
    }
    if (block) flush();
  };
  walk(root, 0);
  flush();
  const dedup = [];
  for (const l of out) if (l !== dedup[dedup.length - 1]) dedup.push(l);
  const title = document.title ? `Title: ${document.title}\n` : '';
  return `${title}${dedup.join('\n')}`;
}

function fnWaitCheck(text, gone, selector) {
  const body = document.body ? document.body.innerText : '';
  if (text && !body.includes(text)) return false;
  if (gone && body.includes(gone)) return false;
  if (selector) {
    const el = document.querySelector(selector);
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    if (!(r.width > 0 && r.height > 0) || cs.visibility === 'hidden' || cs.display === 'none') return false;
  }
  return true;
}

// ------------------------------------------------------------------------------------- the tab
export class AgentTab {
  /**
   * @param {import('../tab.js').Tab} tab
   */
  constructor(tab) {
    this.tab = tab;
    this.wc = tab.wc;
    this.cdp = new TabCdp(this.wc);
    this.refs = new RefMap();
    this.snap = null;
    this.shotScale = 1;
    this.dialog = null; // {type, message, defaultPrompt, url, session}
    this.console = [];
    this.consoleTotal = 0;
    this.network = [];
    this.networkTotal = 0;
    this.inflight = new Set();
    this.lastNet = Date.now();
    this.lifecycle = new Set();
    this.mainFrameId = null;
    this.cdp.on('event', (m, p, sid) => this.onEvent(m, p, sid));
    this.cdp.on('child-gone', (sid) => this.refs.dropSession(sid));
    this.onConsole = (e, level, message, line, sourceId) => {
      // Electron ≥ 35 puts the details on the event; older versions pass them as arguments.
      const lvl = e && e.level !== undefined ? e.level : level;
      const text = e && e.message !== undefined ? e.message : message;
      const name = typeof lvl === 'number' ? ['debug', 'info', 'warning', 'error'][lvl] || 'info' : String(lvl || 'info');
      if (/^%cElectron Security Warning/.test(String(text || ''))) return; // unpackaged runs only, not the page's
      this.pushConsole({ level: name === 'warn' ? 'warning' : name, text: String(text || '').slice(0, 2000), source: String((e && e.sourceId) || sourceId || '').slice(0, 300), line: (e && e.lineNumber) || line || 0 });
    };
    this.wc.on('console-message', this.onConsole);
  }

  async ensure() {
    if (this.wc.isDestroyed()) throw new AgentError('This tab was closed.');
    await this.cdp.attach();
    if (!this.mainFrameId) {
      const { frameTree } = await this.cdp.send('Page.getFrameTree');
      this.mainFrameId = frameTree.frame.id;
    }
  }

  dispose() {
    this.cdp.detach();
    if (!this.wc.isDestroyed()) this.wc.off('console-message', this.onConsole);
  }

  onEvent(method, p, sid) {
    switch (method) {
      case 'Page.javascriptDialogOpening':
        this.dialog = { type: p.type, message: String(p.message || '').slice(0, 2000), defaultPrompt: p.defaultPrompt || '', url: p.url || '', session: sid, hasBrowserHandler: !!p.hasBrowserHandler };
        break;
      case 'Page.javascriptDialogClosed':
        this.dialog = null;
        break;
      case 'Page.frameNavigated':
        if (!sid && p.frame && !p.frame.parentId) {
          this.mainFrameId = p.frame.id;
          this.refs.reset();
          this.snap = null;
        }
        break;
      case 'Page.lifecycleEvent':
        if (!sid && p.frameId === this.mainFrameId) {
          if (p.name === 'init') this.lifecycle.clear();
          this.lifecycle.add(p.name);
        }
        break;
      default:
        break;
    }
  }

  pushConsole(entry) {
    this.console.push({ ...entry, n: ++this.consoleTotal, at: Date.now() });
    if (this.console.length > CONSOLE_KEEP) this.console.splice(0, this.console.length - CONSOLE_KEEP);
  }

  /** webRequest events of this tab (from the session's WebRequestHub). */
  netStart(d) {
    this.inflight.add(d.id);
    this.lastNet = Date.now();
  }

  netEnd(d, failed) {
    this.inflight.delete(d.id);
    this.lastNet = Date.now();
    this.network.push({ n: ++this.networkTotal, method: d.method, url: String(d.url || '').slice(0, 1000), status: d.statusCode || 0, type: d.resourceType || '', fromCache: !!d.fromCache, error: failed ? String(d.error || 'failed') : '', at: Date.now() });
    if (this.network.length > NETWORK_KEEP) this.network.splice(0, this.network.length - NETWORK_KEEP);
  }

  checkDialog() {
    if (this.dialog) throw new AgentError(`A ${this.dialog.type} dialog is open: ${JSON.stringify(this.dialog.message)}. Answer it first with browser_handle_dialog.`);
  }

  /** Races a CDP call that may block behind a JavaScript dialog the action opens. */
  async raceDialog(promise) {
    let off;
    const opened = new Promise((resolve) => {
      const on = (m) => {
        if (m === 'Page.javascriptDialogOpening') resolve('dialog');
      };
      this.cdp.on('event', on);
      off = () => this.cdp.off('event', on);
    });
    promise.catch(() => {});
    try {
      return await Promise.race([promise, opened]);
    } finally {
      off();
    }
  }

  async call(el, fn, args = [], { awaitPromise = false, userGesture = false, timeoutMs = 15000 } = {}) {
    const res = await this.cdp.send('Runtime.callFunctionOn', { objectId: el.objectId, functionDeclaration: fn.toString(), arguments: args, returnByValue: true, awaitPromise, userGesture }, el.session, timeoutMs);
    if (res.exceptionDetails) throw new AgentError(exceptionText(res.exceptionDetails));
    return res.result ? res.result.value : undefined;
  }

  async evaluate(expression, { awaitPromise = false, userGesture = false, timeoutMs = 15000 } = {}) {
    const res = await this.cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise, userGesture, allowUnsafeEvalBlockedByCSP: true }, '', timeoutMs);
    if (res.exceptionDetails) throw new AgentError(exceptionText(res.exceptionDetails));
    return res.result ? res.result.value : undefined;
  }

  // ------------------------------------------------------------------------------- snapshot
  /** Fetches the accessibility trees of every frame and builds the outline (refs registered). */
  async snapshot() {
    await this.ensure();
    this.checkDialog();
    const sessions = ['', ...this.cdp.children.keys()];
    // Every frame of every session; the main frame first. A frame's <iframe> element lives in its parent
    // session: the same one for in-process frames, the parent's for an out-of-process frame's own document.
    const inputs = [];
    for (const sid of sessions) {
      let tree;
      try {
        ({ frameTree: tree } = await this.cdp.send('Page.getFrameTree', {}, sid));
      } catch {
        continue;
      }
      const list = [];
      const walk = (node, top) => {
        if (list.length + inputs.length >= MAX_FRAMES) return;
        list.push({ frameId: node.frame.id, top });
        for (const c of node.childFrames || []) walk(c, false);
      };
      walk(tree, true);
      for (const f of list) {
        const main = !sid && f.top;
        let parentSession = null;
        let ownerBackendId = null;
        if (!main) {
          const child = this.cdp.children.get(sid);
          parentSession = f.top ? (child ? child.parentSession : '') : sid;
          try {
            ({ backendNodeId: ownerBackendId } = await this.cdp.send('DOM.getFrameOwner', { frameId: f.frameId }, parentSession));
          } catch {
            ownerBackendId = null;
          }
        }
        let nodes = [];
        try {
          ({ nodes } = await this.cdp.send('Accessibility.getFullAXTree', main ? {} : { frameId: f.frameId }, sid, 20000));
        } catch {
          nodes = [];
        }
        inputs.push({ key: `${sid}|${f.frameId}`, session: sid, nodes, parentSession, ownerBackendId });
      }
    }
    const extras = new Map();
    for (const sid of sessions) await this.domExtras(sid, extras).catch(() => {});
    this.snap = buildSnapshot({ frames: inputs, refs: this.refs, extras, pageUrl: this.wc.getURL() });
    return this.snap;
  }

  /** Click listeners / pointer cursors (elements that act like buttons without saying so) and password inputs. */
  async domExtras(sid, extras) {
    const snap = await this.cdp.send('DOMSnapshot.captureSnapshot', { computedStyles: ['cursor'], includeDOMRects: false }, sid, 20000);
    const strings = snap.strings || [];
    for (const doc of snap.documents || []) {
      const nodes = doc.nodes || {};
      const backend = nodes.backendNodeId || [];
      const parent = nodes.parentIndex || [];
      const names = nodes.nodeName || [];
      const attrs = nodes.attributes || [];
      const clickable = new Set((nodes.isClickable && nodes.isClickable.index) || []);
      const pointer = new Set();
      const layout = doc.layout || {};
      (layout.nodeIndex || []).forEach((ni, li) => {
        const st = (layout.styles || [])[li];
        if (st && st.length && strings[st[0]] === 'pointer') pointer.add(ni);
      });
      for (let i = 0; i < backend.length; i++) {
        const isPtr = pointer.has(i) && !pointer.has(parent[i]);
        const name = strings[names[i]];
        let password = false;
        if (name === 'INPUT') {
          const a = attrs[i] || [];
          for (let k = 0; k + 1 < a.length; k += 2) if (strings[a[k]] === 'type' && String(strings[a[k + 1]]).toLowerCase() === 'password') password = true;
        }
        if (clickable.has(i) || isPtr || password) extras.set(`${sid}|${backend[i]}`, { clickable: clickable.has(i) || isPtr, password });
      }
    }
  }

  /** The snapshot as text (fresh unless `reuse`). */
  async snapshotText(o = {}) {
    const snap = o.reuse && this.snap ? this.snap : await this.snapshot();
    return formatSnapshot(snap, o);
  }

  describe(ref) {
    return describeLine(lineForRef(this.snap, ref)) || ref;
  }

  // -------------------------------------------------------------------------------- elements
  async resolve(ref) {
    await this.ensure();
    this.checkDialog();
    const r = this.refs.get(ref);
    if (!r) throw new AgentError(`There is no element ${ref} on this page. Refs come from the latest browser_snapshot of this tab — take a new snapshot.`);
    if (r.session && !this.cdp.children.has(r.session)) throw new AgentError(`Element ${ref} is gone (its frame was replaced). Take a new snapshot.`);
    try {
      const { object } = await this.cdp.send('DOM.resolveNode', { backendNodeId: r.backendId }, r.session);
      if (!object || !object.objectId) throw new Error('no object');
      return { ref, session: r.session, backendId: r.backendId, objectId: object.objectId };
    } catch {
      throw new AgentError(`Element ${ref} is no longer on the page (it changed). Take a new snapshot.`);
    }
  }

  async layout() {
    const m = await this.cdp.send('Page.getLayoutMetrics');
    const v = m.cssLayoutViewport || m.layoutViewport;
    const vv = m.cssVisualViewport || m.visualViewport || v;
    const c = m.cssContentSize || m.contentSize;
    return { width: v.clientWidth, height: v.clientHeight, pageX: vv.pageX || 0, pageY: vv.pageY || 0, contentWidth: c.width, contentHeight: c.height };
  }

  async frameOffset(session) {
    let x = 0;
    let y = 0;
    let sid = session;
    for (let i = 0; sid && i < 10; i++) {
      const c = this.cdp.children.get(sid);
      if (!c) break;
      const { backendNodeId } = await this.cdp.send('DOM.getFrameOwner', { frameId: c.frameId }, c.parentSession);
      const { model } = await this.cdp.send('DOM.getBoxModel', { backendNodeId }, c.parentSession);
      x += model.content[0];
      y += model.content[1];
      sid = c.parentSession;
    }
    return { x, y };
  }

  /** The element's box(es) in top-viewport CSS pixels (after scrolling it into view). */
  async boxOf(el, { scroll = true } = {}) {
    if (scroll) {
      await this.cdp.send('DOM.scrollIntoViewIfNeeded', { backendNodeId: el.backendId }, el.session).catch(() =>
        this.call(el, function () {
          this.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
        }).catch(() => {}),
      );
    }
    let quads = [];
    try {
      ({ quads } = await this.cdp.send('DOM.getContentQuads', { backendNodeId: el.backendId }, el.session));
    } catch {
      quads = [];
    }
    const off = el.session ? await this.frameOffset(el.session) : { x: 0, y: 0 };
    const boxes = [];
    for (const q of quads || []) {
      const xs = [q[0], q[2], q[4], q[6]].map((v) => v + off.x);
      const ys = [q[1], q[3], q[5], q[7]].map((v) => v + off.y);
      const box = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
      if (box.w >= 1 && box.h >= 1) boxes.push(box);
    }
    return boxes;
  }

  /** Where to click an element: the centre of its first box, clipped to the viewport. */
  async pointOf(el) {
    const boxes = await this.boxOf(el);
    if (!boxes.length) throw new AgentError(`${this.describe(el.ref)} has no size on screen (hidden, collapsed or empty). Open what contains it first, or check with a screenshot.`);
    const vp = await this.layout();
    for (const b of boxes) {
      const x0 = Math.max(0, b.x);
      const y0 = Math.max(0, b.y);
      const x1 = Math.min(vp.width, b.x + b.w);
      const y1 = Math.min(vp.height, b.y + b.h);
      if (x1 - x0 >= 1 && y1 - y0 >= 1) return { x: (x0 + x1) / 2, y: (y0 + y1) / 2 };
    }
    throw new AgentError(`${this.describe(el.ref)} is outside the visible area and could not be scrolled into view.`);
  }

  /** null when a click at x,y reaches the element; otherwise what covers it. */
  async coveredBy(el, x, y) {
    if (el.session) return null; // inside an out-of-process frame: the frame itself is hit at this level
    let hit;
    try {
      hit = await this.cdp.send('DOM.getNodeForLocation', { x: Math.round(x), y: Math.round(y), includeUserAgentShadowDOM: false, ignorePointerEventsNone: false });
    } catch {
      return null;
    }
    if (!hit || !hit.backendNodeId || hit.backendNodeId === el.backendId) return null;
    try {
      const { object } = await this.cdp.send('DOM.resolveNode', { backendNodeId: hit.backendNodeId });
      if (await this.call(el, fnRelated, [{ objectId: object.objectId }])) return null;
      const { node } = await this.cdp.send('DOM.describeNode', { backendNodeId: hit.backendNodeId });
      const a = node.attributes || [];
      const get = (n) => {
        const i = a.indexOf(n);
        return i >= 0 && i % 2 === 0 ? a[i + 1] : '';
      };
      const ref = this.refs.byKey.get(`|${hit.backendNodeId}`);
      const cls = get('class').trim().split(/\s+/).slice(0, 3).join('.');
      return `<${String(node.localName || node.nodeName).toLowerCase()}${get('id') ? `#${get('id')}` : ''}${cls ? `.${cls}` : ''}>${ref ? ` (${ref})` : ''}`;
    } catch {
      return null;
    }
  }

  /** Point in screenshot pixels → CSS pixels. */
  fromShot(x, y) {
    const k = this.shotScale || 1;
    return { x: x / k, y: y / k };
  }

  mouse(type, x, y, extra = {}) {
    return this.cdp.send('Input.dispatchMouseEvent', { type, x, y, button: 'none', ...extra });
  }

  /** A full click; resolves early with 'dialog' when the click opens a JavaScript dialog. */
  async click(x, y, { button = 'left', count = 1, modifiers = 0 } = {}) {
    const buttons = { left: 1, right: 2, middle: 4 }[button] || 1;
    await this.mouse('mouseMoved', x, y, { modifiers });
    for (let i = 1; i <= count; i++) {
      if ((await this.raceDialog(this.mouse('mousePressed', x, y, { button, buttons, clickCount: i, modifiers }))) === 'dialog') return 'dialog';
      if ((await this.raceDialog(this.mouse('mouseReleased', x, y, { button, buttons: 0, clickCount: i, modifiers }))) === 'dialog') return 'dialog';
    }
    return 'ok';
  }

  async drag(from, to) {
    await this.cdp.send('Input.setInterceptDrags', { enabled: true }).catch(() => {});
    let intercepted = null;
    const on = (m, p) => {
      if (m === 'Input.dragIntercepted') intercepted = p.data;
    };
    this.cdp.on('event', on);
    try {
      await this.mouse('mouseMoved', from.x, from.y);
      await this.mouse('mousePressed', from.x, from.y, { button: 'left', buttons: 1, clickCount: 1 });
      const steps = 8;
      for (let i = 1; i <= steps; i++) {
        const x = from.x + ((to.x - from.x) * i) / steps;
        const y = from.y + ((to.y - from.y) * i) / steps;
        await this.mouse('mouseMoved', x, y, { button: 'left', buttons: 1 });
        if (intercepted) break;
        await sleep(16);
      }
      if (intercepted) {
        // an HTML5 drag started: deliver it as drag events at the target
        for (const type of ['dragEnter', 'dragOver', 'drop']) await this.cdp.send('Input.dispatchDragEvent', { type, x: to.x, y: to.y, data: intercepted });
      }
      await this.mouse('mouseReleased', to.x, to.y, { button: 'left', buttons: 0, clickCount: 1 });
    } finally {
      this.cdp.off('event', on);
      await this.cdp.send('Input.setInterceptDrags', { enabled: false }).catch(() => {});
    }
    return intercepted ? 'html5' : 'mouse';
  }

  async wheel(x, y, dx, dy) {
    await this.mouse('mouseMoved', x, y);
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: dx, deltaY: dy, button: 'none' });
  }

  async press(chord, { repeat = 1 } = {}) {
    let parsed;
    try {
      parsed = parseChord(chord);
    } catch (e) {
      if (e instanceof KeyError) throw new AgentError(e.message);
      throw e;
    }
    const { key, modifiers } = parsed;
    for (let i = 0; i < Math.max(1, Math.min(100, repeat)); i++) {
      for (const ev of modifierEvents(modifiers, true)) await this.cdp.send('Input.dispatchKeyEvent', ev);
      const { down, up } = keyEvents(key, modifiers);
      if ((await this.raceDialog(this.cdp.send('Input.dispatchKeyEvent', down))) === 'dialog') return 'dialog';
      await this.cdp.send('Input.dispatchKeyEvent', up);
      for (const ev of modifierEvents(modifiers, false)) await this.cdp.send('Input.dispatchKeyEvent', ev);
    }
    return 'ok';
  }

  async insertText(text) {
    if (!text) return 'ok';
    return (await this.raceDialog(this.cdp.send('Input.insertText', { text }))) === 'dialog' ? 'dialog' : 'ok';
  }

  /** Types key by key: characters of the US layout as key events, anything else inserted. */
  async typeSlowly(text) {
    for (const ch of text) {
      if (ch === '\n') {
        if ((await this.press('Enter')) === 'dialog') return 'dialog';
        continue;
      }
      const { down, up } = keyEvents(ch, []);
      if (down.windowsVirtualKeyCode) {
        if ((await this.raceDialog(this.cdp.send('Input.dispatchKeyEvent', down))) === 'dialog') return 'dialog';
        await this.cdp.send('Input.dispatchKeyEvent', up);
      } else if ((await this.insertText(ch)) === 'dialog') return 'dialog';
      await sleep(12);
    }
    return 'ok';
  }

  async focus(el) {
    try {
      await this.cdp.send('DOM.focus', { backendNodeId: el.backendId }, el.session);
      return true;
    } catch {
      return false;
    }
  }

  info(el) {
    return this.call(el, fnInfo);
  }

  selectAll(el) {
    return this.call(el, fnSelectAll);
  }

  setValue(el, value) {
    return this.call(el, fnSetValue, [{ value: String(value) }], { userGesture: true });
  }

  selectOptions(el, values) {
    return this.call(el, fnSelectOptions, [{ value: values }], { userGesture: true });
  }

  async setFiles(el, files) {
    await this.cdp.send('DOM.setFileInputFiles', { files, backendNodeId: el.backendId }, el.session);
  }

  /** Clicks something that opens a file chooser and answers the chooser with files. */
  async chooseFiles(clickFn, files) {
    await this.cdp.send('Page.setInterceptFileChooserDialog', { enabled: true });
    try {
      const opened = this.cdp.waitEvent('Page.fileChooserOpened', 5000);
      opened.catch(() => {});
      await clickFn();
      const { params, sessionId } = await opened;
      await this.cdp.send('DOM.setFileInputFiles', { files, backendNodeId: params.backendNodeId }, sessionId);
      return params.mode;
    } finally {
      await this.cdp.send('Page.setInterceptFileChooserDialog', { enabled: false }).catch(() => {});
    }
  }

  scroll(el, how, dx, dy) {
    if (el) return this.call(el, fnScroll, [{ value: how }, { value: dx }, { value: dy }]);
    return this.evaluate(`(${fnScroll.toString()}).call(null, ${JSON.stringify(how)}, ${Number(dx) || 0}, ${Number(dy) || 0})`);
  }

  scrollInfo() {
    return this.evaluate(`(${fnScrollInfo.toString()})()`);
  }

  readable(el, links) {
    if (el) return this.call(el, fnReadable, [{ value: links }], { timeoutMs: 20000 });
    return this.evaluate(`(${fnReadable.toString()}).call(null, ${links ? 'true' : 'false'})`, { timeoutMs: 20000 });
  }

  waitCheck(text, gone, selector) {
    return this.evaluate(`(${fnWaitCheck.toString()})(${JSON.stringify(text || '')}, ${JSON.stringify(gone || '')}, ${JSON.stringify(selector || '')})`, { timeoutMs: 5000 });
  }

  async handleDialog(accept, promptText) {
    if (!this.dialog) throw new AgentError('No dialog is open in this tab.');
    const d = this.dialog;
    await this.cdp.send('Page.handleJavaScriptDialog', { accept: !!accept, ...(promptText !== undefined ? { promptText: String(promptText) } : {}) }, d.session);
    this.dialog = null;
    return d;
  }

  // ------------------------------------------------------------------------------ screenshots
  async devicePixelRatio() {
    try {
      return Number(await this.evaluate('window.devicePixelRatio', { timeoutMs: 3000 })) || 1;
    } catch {
      return 1;
    }
  }

  /**
   * @param {{fullPage?: boolean, el?: any, format?: 'png'|'jpeg', marks?: Array<{x,y,w,h,label}>}} o boxes in CSS px
   * @returns {Promise<{data: string, mimeType: string, width: number, height: number, scale: number, note?: string}>}
   */
  async screenshot({ fullPage = false, el = null, format = 'png', marks = null } = {}) {
    await this.ensure();
    this.checkDialog();
    const vp = await this.layout();
    const dpr = await this.devicePixelRatio();
    let clip;
    let note = '';
    if (el) {
      const boxes = await this.boxOf(el);
      if (!boxes.length) throw new AgentError(`${this.describe(el.ref)} has no size on screen.`);
      const b = boxes[0];
      clip = { x: b.x + vp.pageX, y: b.y + vp.pageY, width: b.w, height: b.h };
    } else if (fullPage) {
      const h = Math.min(vp.contentHeight, FULL_PAGE_MAX);
      if (vp.contentHeight > FULL_PAGE_MAX) note = `The page is ${Math.round(vp.contentHeight)} px tall; this shows the first ${FULL_PAGE_MAX} px.`;
      clip = { x: 0, y: 0, width: Math.min(vp.contentWidth, 4000), height: h };
    } else {
      clip = { x: vp.pageX, y: vp.pageY, width: vp.width, height: vp.height };
    }
    const k = Math.min(1, SHOT_MAX_EDGE / Math.max(clip.width, fullPage ? 0 : clip.height, 1));
    const params = { format, ...(format === 'jpeg' ? { quality: 80 } : {}), clip: { ...clip, scale: k / dpr }, captureBeyondViewport: !!fullPage || !!el, fromSurface: true };
    let data;
    try {
      ({ data } = await this.cdp.send('Page.captureScreenshot', params, '', 20000));
    } catch (e) {
      if (fullPage || el) throw e;
      // fallback: the compositor capture Electron uses for hidden pages
      const img = await this.wc.capturePage(undefined, { stayHidden: true });
      const sized = img.resize({ width: Math.round(clip.width * k) });
      data = (format === 'jpeg' ? sized.toJPEG(80) : sized.toPNG()).toString('base64');
    }
    let width = Math.round(clip.width * k);
    let height = Math.round(clip.height * k);
    if (marks && marks.length) {
      const img = nativeImage.createFromBuffer(Buffer.from(data, 'base64'));
      const size = img.getSize();
      const bmp = Buffer.from(img.toBitmap());
      const sx = size.width / clip.width;
      const sy = size.height / clip.height;
      drawMarks(bmp, size.width, size.height, marks.map((m) => ({ x: (m.x + vp.pageX - clip.x) * sx, y: (m.y + vp.pageY - clip.y) * sy, w: m.w * sx, h: m.h * sy, label: m.label })), { scale: size.width >= 1000 ? 2 : 1 });
      const out = nativeImage.createFromBitmap(bmp, { width: size.width, height: size.height });
      data = (format === 'jpeg' ? out.toJPEG(85) : out.toPNG()).toString('base64');
      width = size.width;
      height = size.height;
    }
    if (!el && !fullPage) this.shotScale = width / clip.width;
    return { data, mimeType: format === 'jpeg' ? 'image/jpeg' : 'image/png', width, height, scale: width / clip.width, note };
  }
}

function exceptionText(d) {
  const e = d.exception;
  const msg = (e && (e.description || (e.value !== undefined ? String(e.value) : ''))) || d.text || 'Script error';
  return String(msg).split('\n').slice(0, 6).join('\n').slice(0, 1500);
}

export { CdpError };
