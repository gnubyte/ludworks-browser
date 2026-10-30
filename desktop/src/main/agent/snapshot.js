// Page snapshots for agents: Chromium's accessibility tree (CDP Accessibility.getFullAXTree, one tree
// per frame, stitched under their <iframe> nodes) as a compact indented outline:
//
//   - heading "Sign in" [level=1] [ref=e4]
//   - textbox "Email" [required] [ref=e7] value="ada@example.com"
//   - button "Continue" [ref=e9]
//   - link "Forgot password?" [ref=e11] → /reset
//
// Refs are stable per element (session + backendDOMNodeId) for the life of the tab, and never reused
// after a navigation, so a stale ref fails instead of hitting another element. No Electron here.

/** Roles whose element can be clicked, typed into or otherwise operated. */
const INTERACTIVE = new Set([
  'link', 'button', 'textbox', 'searchbox', 'checkbox', 'radio', 'combobox', 'listbox', 'option', 'menuitem', 'menuitemcheckbox',
  'menuitemradio', 'tab', 'switch', 'slider', 'spinbutton', 'treeitem', 'DisclosureTriangle', 'ComboBoxSelect', 'ComboBoxMenuButton',
  'MenuListOption', 'PopUpButton', 'ToggleButton', 'textFieldWithComboBox', 'ColorWell', 'Date', 'DateTime', 'InputTime', 'SearchBox',
  'scrollbar', 'Video', 'Audio',
]);
/** Containers that add nothing to the outline: their children are printed in their place. */
const TRANSPARENT = new Set(['generic', 'none', 'presentation', 'GenericContainer', 'LayoutTable', 'LayoutTableRow', 'LayoutTableCell', 'Unknown', 'Section', 'Div', 'Span', 'Ruby']);
/** Inline formatting: its text joins the surrounding text. */
const INLINE = new Set(['strong', 'emphasis', 'mark', 'code', 'time', 'Abbr', 'superscript', 'subscript', 'deletion', 'insertion', 'Strong', 'Emphasis', 'Code', 'Time', 'Mark', 'Superscript', 'Subscript']);
/** Never printed (with their subtree). */
const SKIP = new Set(['InlineTextBox', 'LineBreak', 'ListMarker']);
/** Non-interactive nodes that still get a ref (to scroll to, screenshot, or read). */
const REF_ROLES = new Set(['heading', 'img', 'image', 'Iframe', 'IframePresentational', 'dialog', 'alertdialog', 'form', 'table', 'grid', 'article', 'region', 'Canvas', 'figure', 'Figure']);
const DISPLAY = {
  StaticText: 'text', image: 'img', Iframe: 'iframe', IframePresentational: 'iframe', LabelText: 'label', DisclosureTriangle: 'button',
  ComboBoxSelect: 'combobox', ComboBoxMenuButton: 'combobox', MenuListPopup: 'listbox', MenuListOption: 'option', PopUpButton: 'button',
  ToggleButton: 'button', textFieldWithComboBox: 'combobox', SearchBox: 'searchbox', DescriptionList: 'list', DescriptionListTerm: 'term',
  DescriptionListDetail: 'definition', Figcaption: 'caption', Pre: 'pre', Video: 'video', Audio: 'audio', Canvas: 'canvas', Figure: 'figure',
  ColorWell: 'colorpicker', Date: 'date', DateTime: 'datetime', InputTime: 'time', Legend: 'legend', Abbr: 'abbr', Mark: 'mark',
};
/** Controls printed without their inner parts. */
const LEAF = new Set(['Date', 'DateTime', 'InputTime', 'ColorWell', 'slider', 'progressbar', 'meter']);
const VALUE_ROLES = new Set(['textbox', 'searchbox', 'combobox', 'ComboBoxSelect', 'ComboBoxMenuButton', 'textFieldWithComboBox', 'spinbutton', 'slider', 'SearchBox', 'Date', 'DateTime', 'InputTime', 'ColorWell', 'progressbar', 'meter']);

const NAME_MAX = 160;
const TEXT_MAX = 300;
const VALUE_MAX = 200;
const URL_MAX = 140;

/** ref ↔ element, per tab. */
export class RefMap {
  constructor() {
    this.next = 1;
    this.byKey = new Map(); // `${session}|${backendId}` → ref
    this.byRef = new Map(); // ref → {session, backendId}
  }

  ref(session, backendId) {
    const key = `${session || ''}|${backendId}`;
    let r = this.byKey.get(key);
    if (!r) {
      r = `e${this.next++}`;
      this.byKey.set(key, r);
      this.byRef.set(r, { session: session || '', backendId });
    }
    return r;
  }

  get(ref) {
    return this.byRef.get(String(ref || '').trim()) || null;
  }

  /** A new document: old refs stop resolving, numbering continues. */
  reset() {
    this.byKey.clear();
    this.byRef.clear();
  }

  /** Forget the refs of one frame session (an out-of-process frame went away). */
  dropSession(session) {
    for (const [key, r] of this.byKey) {
      if (key.startsWith(`${session}|`)) {
        this.byKey.delete(key);
        this.byRef.delete(r);
      }
    }
  }
}

const collapse = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
const cut = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const quote = (s) => JSON.stringify(s);
const axValue = (v) => (v && v.value !== undefined && v.value !== null ? v.value : undefined);

function props(n) {
  const out = {};
  for (const p of n.properties || []) out[p.name] = axValue(p.value);
  return out;
}

/**
 * Builds the node tree of one frame's AX node list.
 * @returns {{root: any, byBackend: Map<number, any>}}
 */
function frameTree(nodes, session, frameKey) {
  const byId = new Map();
  const byBackend = new Map();
  for (const raw of nodes || []) {
    const n = {
      id: raw.nodeId,
      parentId: raw.parentId,
      childIds: raw.childIds || [],
      ignored: !!raw.ignored,
      role: String(axValue(raw.role) ?? ''),
      name: collapse(axValue(raw.name)),
      description: collapse(axValue(raw.description)),
      value: axValue(raw.value),
      props: props(raw),
      backendId: raw.backendDOMNodeId,
      session,
      frameKey,
      children: [],
      frame: null, // stitched child frame root (iframes)
    };
    byId.set(n.id, n);
    if (Number.isInteger(n.backendId) && !n.ignored) byBackend.set(n.backendId, n);
  }
  let root = null;
  for (const n of byId.values()) {
    for (const cid of n.childIds) {
      const c = byId.get(cid);
      if (c) n.children.push(c);
    }
    if (!n.parentId || !byId.has(n.parentId)) {
      if (!root || n.role === 'RootWebArea') root = n;
    }
  }
  return { root, byBackend };
}

/**
 * @typedef {{key: string, session: string, nodes: any[], parentSession?: string|null, ownerBackendId?: number|null}} FrameInput
 *   The first frame is the page's main frame. Others name the session holding their <iframe> element
 *   (backend node ids are unique per session) and that element's backend id.
 * @typedef {{clickable?: boolean, password?: boolean}} Extra
 * @param {{frames: FrameInput[], refs: RefMap, extras?: Map<string, Extra>, pageUrl?: string}} input
 *   extras is keyed `${session}|${backendId}` (from DOMSnapshot: click listeners, password inputs).
 * @returns {{lines: Array<{depth: number, text: string, kind: string, ref?: string, interactive?: boolean, heading?: boolean, node?: any}>, roots: Map<string, any>, title: string}}
 */
export function buildSnapshot({ frames, refs, extras = new Map(), pageUrl = '' }) {
  const trees = new Map();
  const bySession = new Map();
  for (const f of frames) {
    const t = { ...frameTree(f.nodes, f.session, f.key), input: f };
    trees.set(f.key, t);
    if (!bySession.has(f.session)) bySession.set(f.session, []);
    bySession.get(f.session).push(t);
  }
  // stitch child frames under their <iframe> nodes
  for (const t of trees.values()) {
    const f = t.input;
    if (f.parentSession === null || f.parentSession === undefined || !Number.isInteger(f.ownerBackendId) || !t.root) continue;
    for (const p of bySession.get(f.parentSession) || []) {
      const owner = p !== t ? p.byBackend.get(f.ownerBackendId) : null;
      if (owner) {
        owner.frame = t.root;
        break;
      }
    }
  }
  const top = frames.length ? trees.get(frames[0].key) : null;
  const origin = originOf(pageUrl);
  const lines = [];
  const ctx = { lines, refs, extras, origin, lastText: null };
  if (top && top.root) for (const c of top.root.children) emit(c, 0, ctx);
  return { lines, roots: trees, title: top && top.root ? top.root.name : '' };
}

function originOf(u) {
  try {
    return new URL(u).origin;
  } catch {
    return '';
  }
}

function extraOf(ctx, n) {
  return (Number.isInteger(n.backendId) && ctx.extras.get(`${n.session}|${n.backendId}`)) || null;
}

function isInteractive(n, ctx) {
  if (INTERACTIVE.has(n.role)) return true;
  const ex = extraOf(ctx, n);
  // labels take clicks for their field, which is listed itself
  if (ex && ex.clickable && !['RootWebArea', 'StaticText', 'LabelText', 'label'].includes(n.role) && !REF_ROLES.has(n.role)) return true;
  // focusable widgets without an interactive role (div tabindex=0 with a name)
  return n.props.focusable === true && !!n.name && !['RootWebArea', 'StaticText', 'Iframe', 'dialog', 'alertdialog', 'region', 'main', 'article', 'document', 'application'].includes(n.role);
}

/** Text of a node made only of text and inline formatting (null when it has other content). */
function inlineText(n, ctx, depth = 0) {
  if (depth > 12) return null;
  if (n.role === 'StaticText') return n.name;
  if (n.role === 'LineBreak') return ' ';
  if (n.ignored || TRANSPARENT.has(n.role) || INLINE.has(n.role)) {
    if (!n.ignored && isInteractive(n, ctx)) return null;
    return inlineChildren(n, ctx, depth + 1);
  }
  return null;
}

/** The text of a node's children when they are only text (null when they are more than that). */
function inlineChildren(n, ctx, depth = 0) {
  const parts = [];
  for (const c of n.children) {
    if (SKIP.has(c.role) && c.role !== 'LineBreak') continue;
    const t = inlineText(c, ctx, depth);
    if (t === null) return null;
    parts.push(t);
  }
  return collapse(parts.join(' '));
}

function contentText(n, depth = 0, budget = { left: 400 }) {
  if (depth > 20 || budget.left <= 0) return '';
  if (n.role === 'StaticText') {
    budget.left -= n.name.length;
    return n.name;
  }
  return collapse(n.children.map((c) => contentText(c, depth + 1, budget)).join(' '));
}

function hasInteractive(n, ctx, depth = 0) {
  if (depth > 40) return false;
  for (const c of n.children) {
    if (!c.ignored && isInteractive(c, ctx)) return true;
    if (hasInteractive(c, ctx, depth + 1)) return true;
  }
  return !!n.frame;
}

function displayRole(role) {
  if (Object.hasOwn(DISPLAY, role)) return DISPLAY[role];
  return role ? role[0].toLowerCase() + role.slice(1) : 'node';
}

function shortUrl(url, origin) {
  let u = String(url || '');
  if (!u || /^javascript:/i.test(u)) return '';
  if (origin && u.startsWith(`${origin}/`)) u = u.slice(origin.length);
  return cut(u, URL_MAX);
}

function stateAttrs(n, ctx, role) {
  const p = n.props;
  const a = [];
  if (n.role === 'heading' && p.level) a.push(`[level=${p.level}]`);
  if (p.checked === 'true' || p.checked === true) a.push('[checked]');
  else if (p.checked === 'mixed') a.push('[checked=mixed]');
  if (p.pressed === 'true' || p.pressed === true) a.push('[pressed]');
  else if (p.pressed === 'mixed') a.push('[pressed=mixed]');
  if (p.selected === true) a.push('[selected]');
  if (p.expanded === true) a.push('[expanded]');
  else if (p.expanded === false) a.push('[collapsed]');
  if (p.disabled === true) a.push('[disabled]');
  if (p.readonly === true && VALUE_ROLES.has(n.role)) a.push('[readonly]');
  if (p.required === true) a.push('[required]');
  if (p.invalid && p.invalid !== 'false') a.push('[invalid]');
  if (p.modal === true) a.push('[modal]');
  if (p.focused === true) a.push('[focused]');
  const ex = extraOf(ctx, n);
  if (ex && ex.clickable && !INTERACTIVE.has(n.role) && role !== 'clickable') a.push('[clickable]');
  return a;
}

function valueOf(n, ctx) {
  if (!VALUE_ROLES.has(n.role)) return '';
  const ex = extraOf(ctx, n);
  let v = n.props.valuetext !== undefined ? n.props.valuetext : n.value;
  if (v === undefined || v === null || v === '') return '';
  v = String(v);
  if (ex && ex.password) return ' value="••••••"';
  return ` value=${quote(cut(v.replace(/\r?\n/g, '\n'), VALUE_MAX))}`;
}

function pushText(ctx, depth, text) {
  const t = collapse(text);
  if (!t) return;
  const last = ctx.lastText;
  if (last && last.depth === depth && ctx.lines[ctx.lines.length - 1] === last) {
    last.raw = `${last.raw} ${t}`;
    last.text = `- text: ${cut(last.raw, TEXT_MAX)}`;
    return;
  }
  const line = { depth, kind: 'text', raw: t, text: `- text: ${cut(t, TEXT_MAX)}` };
  ctx.lines.push(line);
  ctx.lastText = line;
}

function emit(n, depth, ctx) {
  if (SKIP.has(n.role)) return;
  const interactive = !n.ignored && isInteractive(n, ctx);
  if (n.ignored || ((TRANSPARENT.has(n.role) || INLINE.has(n.role)) && !interactive)) {
    for (const c of n.children) emit(c, depth, ctx);
    if (n.frame) for (const c of n.frame.children) emit(c, depth, ctx);
    return;
  }
  if (n.role === 'StaticText') {
    pushText(ctx, depth, n.name);
    return;
  }
  if (n.role === 'RootWebArea') {
    // a stitched frame's document: its content
    for (const c of n.children) emit(c, depth, ctx);
    return;
  }
  let name = n.name;
  const inline = !n.frame && !hasInteractive(n, ctx) ? inlineChildren(n, ctx) : null;
  if (!name && interactive) name = collapse(n.description) || cut(contentText(n), 80);
  const role = interactive && !INTERACTIVE.has(n.role) && TRANSPARENT.has(n.role) ? 'clickable' : displayRole(n.role);
  const wantsRef = Number.isInteger(n.backendId) && (interactive || REF_ROLES.has(n.role) || n.frame);
  const ref = wantsRef ? ctx.refs.ref(n.session, n.backendId) : null;
  const attrs = stateAttrs(n, ctx, role);
  let text = `- ${role}${name ? ` ${quote(cut(name, NAME_MAX))}` : ''}${attrs.length ? ` ${attrs.join(' ')}` : ''}${ref ? ` [ref=${ref}]` : ''}${valueOf(n, ctx)}`;
  if (n.role === 'link' && n.props.url) {
    const u = shortUrl(n.props.url, ctx.origin);
    if (u) text += ` → ${u}`;
  }
  const showInline = inline && inline !== name && !(name && inline && name.includes(inline));
  if (showInline) text += `: ${cut(inline, TEXT_MAX)}`;
  const line = { depth, kind: 'node', text, ref: ref || undefined, interactive, heading: n.role === 'heading', node: n };
  ctx.lines.push(line);
  ctx.lastText = null;
  if (inline !== null) return; // text already on the line (or equal to the name)
  if (LEAF.has(n.role)) return; // its parts (a date's day/month/year fields) are set through it
  if (VALUE_ROLES.has(n.role) && n.role !== 'combobox' && n.role !== 'ComboBoxSelect' && valueOf(n, ctx)) return; // its inner text is the value shown
  for (const c of n.children) emit(c, depth + 1, ctx);
  if (n.frame) for (const c of n.frame.children) emit(c, depth + 1, ctx);
  ctx.lastText = null;
}

/**
 * The outline as text.
 * @param {{lines: any[]}} snap
 * @param {{filter?: 'all'|'interactive', ref?: string, maxChars?: number, offset?: number}} o
 * @returns {{text: string, total: number, from: number, to: number, more: boolean}}
 */
export function formatSnapshot(snap, { filter = 'all', ref = null, maxChars = 12000, offset = 0 } = {}) {
  let lines = snap.lines;
  if (ref) {
    const i = lines.findIndex((l) => l.ref === ref);
    if (i < 0) return { text: '', total: 0, from: 0, to: 0, more: false, missing: true };
    const base = lines[i].depth;
    let j = i + 1;
    while (j < lines.length && lines[j].depth > base) j++;
    lines = lines.slice(i, j).map((l) => ({ ...l, depth: l.depth - base }));
  }
  if (filter === 'interactive') {
    lines = lines.filter((l) => l.interactive || l.heading || (l.node && (l.node.role === 'dialog' || l.node.role === 'alertdialog' || l.node.frame))).map((l) => ({ ...l, depth: 0 }));
  }
  const total = lines.length;
  const from = Math.max(0, Math.min(offset | 0, total));
  const out = [];
  let size = 0;
  let to = from;
  for (; to < total; to++) {
    const s = `${'  '.repeat(Math.min(lines[to].depth, 40))}${lines[to].text}`;
    if (size + s.length + 1 > maxChars && out.length) break;
    out.push(s);
    size += s.length + 1;
  }
  return { text: out.join('\n'), total, from, to, more: to < total };
}

const SYNONYMS = {
  input: ['textbox', 'searchbox', 'combobox', 'spinbutton'],
  field: ['textbox', 'searchbox', 'combobox', 'spinbutton'],
  box: ['textbox', 'searchbox', 'checkbox', 'combobox', 'listbox'],
  dropdown: ['combobox', 'listbox', 'menu'],
  select: ['combobox', 'listbox'],
  image: ['img'],
  picture: ['img'],
  photo: ['img'],
  title: ['heading'],
  toggle: ['switch', 'checkbox'],
};

/** Snapshot lines (elements and text) matching every word of the query (or a synonym of it), in page order. */
export function findInSnapshot(snap, query, limit = 20) {
  const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const out = [];
  for (const l of snap.lines) {
    const hay = (l.kind === 'text' ? `- text: ${l.raw}` : l.text).toLowerCase();
    if (words.every((w) => hay.includes(w) || (SYNONYMS[w] || []).some((s) => hay.includes(`- ${s}`)))) {
      out.push(l);
      if (out.length >= limit) break;
    }
  }
  return out;
}

/** Node of a ref in a built snapshot (to describe what was clicked). */
export function lineForRef(snap, ref) {
  return snap && snap.lines.find((l) => l.ref === ref) || null;
}

/** 'button "Sign in"' — role and name of a snapshot line, for action reports. */
export function describeLine(line) {
  if (!line) return '';
  const m = /^- (\S+)( "(?:[^"\\]|\\.)*")?/.exec(line.text);
  return m ? `${m[1]}${m[2] || ''}`.slice(0, 120) : '';
}
