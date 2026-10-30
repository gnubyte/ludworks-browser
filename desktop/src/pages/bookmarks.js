// Bookmark manager (ludworks://bookmarks/): folder tree + folder contents, search across everything,
// drag and drop of bookmarks and whole folders (reorder, move into any folder in either pane,
// auto-expand on hover), multi-select (click, Ctrl/Cmd+click, Shift+click ranges, Ctrl+A), keyboard,
// context menu, cut/copy/paste, undo, inline rename, bulk "Move to…", import from other browsers
// and bookmark files, export. The contents pane is virtualised (fixed-height rows) so folders with
// thousands of bookmarks stay fast. Every change goes through the main process (bookmarks.*), which
// keeps sync bookkeeping, positions and cycle checks in one place.
import { h, clear, applyTheme, sideNav, letterIcon } from './ui.js';

const call = (cmd, args = {}) => window.lwPage.call(cmd, args);
const isMac = window.lwPage.platform === 'darwin';
const MOD = isMac ? '⌘' : 'Ctrl+';
const ROW_H = 36;
const DND = 'application/x-ludworks-bookmark';
const MAX_RESULTS = 5000;

// --------------------------------------------------------------------------------------- icons
const SVG_NS = 'http://www.w3.org/2000/svg';
const PATHS = {
  folder: ['M3.5 6.5h6l2 2h9v10h-17z'],
  bar: ['M3.5 6.5h17v11h-17z', 'M3.5 10h17'],
  chevron: ['M9.5 6.5l5.5 5.5-5.5 5.5'],
  more: ['M5.5 12h.01', 'M12 12h.01', 'M18.5 12h.01'],
  search: ['M10.5 17a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13z', 'M15.5 15.5L20 20'],
  plus: ['M12 5v14', 'M5 12h14'],
  folderPlus: ['M3.5 6.5h6l2 2h9v10h-17z', 'M12 10.5v5', 'M9.5 13h5'],
  import: ['M12 4v11', 'M7 10.5l5 5 5-5', 'M5 20h14'],
  export: ['M12 15V4', 'M7 8.5l5-5 5 5', 'M5 20h14'],
  close: ['M7 7l10 10', 'M17 7L7 17'],
  star: ['M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z'],
};

function svg(name, size = 16) {
  const s = document.createElementNS(SVG_NS, 'svg');
  for (const [k, v] of Object.entries({ viewBox: '0 0 24 24', width: size, height: size, 'aria-hidden': 'true', class: 'icon' })) s.setAttribute(k, String(v));
  for (const d of PATHS[name] || []) {
    const p = document.createElementNS(SVG_NS, 'path');
    for (const [k, v] of Object.entries({ d, fill: 'none', stroke: 'currentColor', 'stroke-width': '1.8', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })) p.setAttribute(k, v);
    s.append(p);
  }
  return s;
}

// --------------------------------------------------------------------------------------- state
const model = { nodes: new Map(), roots: [], total: 0, version: -1 };
let icons = {}; // site → favicon data: URL
let rows = []; // nodes listed in the contents pane
let rowIndex = new Map(); // id → index in rows
const ui = {
  folder: 'toolbar',
  query: '',
  sel: new Set(),
  anchor: null, // Shift+click range anchor
  focus: null, // keyboard cursor in the list
  treeFocus: null,
  expanded: new Set(['toolbar', 'other']),
  clip: null, // {mode: 'cut'|'copy', ids, set, text}
  edit: null, // inline rename {id, where: 'list'|'tree', els}
};
let drag = null; // {ids, set} while dragging our own bookmarks
let reloadPending = false;

const node = (id) => model.nodes.get(id);
const modKey = (e) => (isMac ? e.metaKey : e.ctrlKey);
const fmt = (n) => Number(n).toLocaleString();
const plural = (n, one, many = `${one}s`) => `${fmt(n)} ${n === 1 ? one : many}`;
const errMsg = (e) => String((e && e.message) || e).replace(/^Error invoking remote method '[^']*': /, '').replace(/^Error: /, '');

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
}
const shortUrl = (url) => String(url || '').replace(/^https?:\/\/(www\.)?/i, '').replace(/\/$/, '');
const titleOf = (n) => (n ? n.title || (n.type === 'url' ? shortUrl(n.url) : 'Untitled folder') : '');

function pathTo(id) {
  const out = [];
  for (let n = node(id), g = 0; n && g < 256; n = node(n.parent), g++) out.unshift(n);
  return out;
}
function isAncestorOrSelf(a, id) {
  for (let n = node(id), g = 0; n && g < 256; n = node(n.parent), g++) if (n.id === a) return true;
  return false;
}
const folderLabel = (id) => pathTo(id).map(titleOf).join(' › ');
const visibleRoots = () => model.roots.filter((r) => r.id !== 'mobile' || r.children.length);

function urlsIn(nodes, out = [], depth = 0) {
  for (const n of nodes) {
    if (out.length >= 500) break;
    if (n.type === 'url') out.push(n.url);
    else if (depth < 32) urlsIn(n.children, out, depth + 1);
  }
  return out;
}

function buildModel(data) {
  const nodes = new Map();
  for (const r of data.roots) nodes.set(r.id, { id: r.id, parent: null, type: 'folder', title: r.title, root: true, children: [] });
  let total = 0;
  for (const [id, parent, type, title, url, added] of data.rows) {
    const n = { id, parent, type, title, url, added, children: type === 'folder' ? [] : null, lc: null };
    nodes.set(id, n);
    const p = nodes.get(parent);
    if (p && p.children) p.children.push(n);
    if (type === 'url') total++;
  }
  model.nodes = nodes;
  model.roots = data.roots.map((r) => nodes.get(r.id));
  model.total = total;
  model.version = data.version;
}

function loadUi() {
  try {
    const s = JSON.parse(localStorage.getItem('bookmarks-ui') || '{}');
    if (Array.isArray(s.expanded)) ui.expanded = new Set(s.expanded.filter((x) => typeof x === 'string'));
    if (typeof s.folder === 'string') ui.folder = s.folder;
  } catch {
    /* defaults */
  }
}
function saveUi() {
  try {
    localStorage.setItem('bookmarks-ui', JSON.stringify({ expanded: [...ui.expanded].slice(-500), folder: ui.folder }));
  } catch {
    /* not persisted */
  }
}

// ------------------------------------------------------------------------------------ skeleton
const app = document.getElementById('app');
const searchInput = h('input', { class: 'input', type: 'search', placeholder: 'Search bookmarks', 'aria-label': 'Search bookmarks', spellcheck: 'false' });
const treeEl = h('nav', { class: 'bm-tree card', tabindex: '0', role: 'tree', 'aria-label': 'Bookmark folders' });
const treeLine = h('div', { class: 'bm-treeline', hidden: true });
const crumbsEl = h('div', { class: 'bm-crumbs' });
const colHead = h('div', { class: 'bm-colhead' });
const listEl = h('div', { class: 'bm-list', tabindex: '0', role: 'listbox', 'aria-multiselectable': 'true', 'aria-label': 'Folder contents' });
const spacer = h('div', { class: 'bm-spacer' });
const rowsEl = h('div', { class: 'bm-rows' });
const dropLine = h('div', { class: 'bm-dropline', hidden: true });
const emptyEl = h('div', { class: 'bm-empty', hidden: true });
const selbar = h('div', { class: 'bm-selbar', hidden: true });
const pane = h('section', { class: 'bm-pane card' }, crumbsEl, colHead, listEl, selbar);
spacer.append(rowsEl, dropLine);
listEl.append(spacer, emptyEl);
const head = h(
  'header',
  { class: 'bm-head' },
  h('h1', {}, 'Bookmarks'),
  h('div', { class: 'bm-search' }, svg('search', 16), searchInput),
  h('span', { class: 'grow' }),
  h('button', { class: 'btn', title: 'Add a bookmark to the open folder', onclick: () => editDialog({ parent: targetFolder() }) }, svg('plus', 16), 'Bookmark'),
  h('button', { class: 'btn', title: 'New folder in the open folder', onclick: () => newFolder(targetFolder()) }, svg('folderPlus', 16), 'Folder'),
  h('button', { class: 'btn', title: 'Import bookmarks from another browser or a file', onclick: () => importDialog() }, svg('import', 16), 'Import'),
  h('button', { class: 'btn', title: 'Save all bookmarks as an HTML file', onclick: () => exportAll() }, svg('export', 16), 'Export'),
);
app.append(sideNav('bookmarks'), h('main', { class: 'bm-main' }, head, h('div', { class: 'bm-body' }, treeEl, pane)));

const targetFolder = () => (ui.query ? 'other' : ui.folder);

// --------------------------------------------------------------------------------------- tree
function renderTree() {
  const st = treeEl.scrollTop;
  clear(treeEl);
  for (const r of visibleRoots()) treeEl.append(treeBranch(r, 0));
  treeEl.append(treeLine);
  treeEl.scrollTop = st;
}

function treeBranch(n, depth) {
  const subs = n.children.filter((c) => c.type === 'folder');
  const open = subs.length > 0 && ui.expanded.has(n.id);
  const editing = ui.edit && ui.edit.where === 'tree' && ui.edit.id === n.id;
  const row = h('div', {
    class: `tn${!ui.query && ui.folder === n.id ? ' cur' : ''}${ui.treeFocus === n.id ? ' kf' : ''}`,
    role: 'treeitem',
    'aria-level': String(depth + 1),
    'aria-expanded': subs.length ? String(open) : undefined,
    'aria-selected': String(!ui.query && ui.folder === n.id),
    draggable: n.root || editing ? undefined : 'true',
    dataset: { id: n.id },
    style: { paddingLeft: `${4 + depth * 14}px` },
    title: n.root ? titleOf(n) : folderLabel(n.id),
  });
  row.append(h('span', { class: `tw${open ? ' open' : ''}${subs.length ? '' : ' none'}`, dataset: { act: 'twisty' } }, svg('chevron', 14)), h('span', { class: 'fi' }, svg(n.id === 'toolbar' ? 'bar' : 'folder', 16)));
  if (editing) row.append(ui.edit.els[0]);
  else row.append(h('span', { class: 't' }, titleOf(n)), h('span', { class: 'n' }, n.children.length ? fmt(n.children.length) : ''));
  if (!open) return row;
  return h('div', { role: 'group' }, row, ...subs.map((c) => treeBranch(c, depth + 1)));
}

const treeRowOf = (id) => treeEl.querySelector(`.tn[data-id="${CSS.escape(id)}"]`);

function toggleExpand(id, open = !ui.expanded.has(id)) {
  if (open) ui.expanded.add(id);
  else ui.expanded.delete(id);
  saveUi();
  renderTree();
}

treeEl.addEventListener('click', (e) => {
  const row = e.target.closest('.tn');
  if (!row || e.target.closest('input')) return;
  const id = row.dataset.id;
  if (e.target.closest('[data-act="twisty"]')) {
    toggleExpand(id);
    return;
  }
  openFolder(id);
});
treeEl.addEventListener('dblclick', (e) => {
  const row = e.target.closest('.tn');
  if (row && !e.target.closest('[data-act="twisty"], input')) toggleExpand(row.dataset.id);
});
treeEl.addEventListener('contextmenu', (e) => {
  const row = e.target.closest('.tn');
  e.preventDefault();
  if (row && !e.target.closest('input')) treeMenu(row.dataset.id, e.clientX, e.clientY);
});
treeEl.addEventListener('auxclick', (e) => {
  const row = e.target.closest('.tn');
  if (row && e.button === 1) openUrls(urlsIn(node(row.dataset.id).children), 'background-tab');
});

treeEl.addEventListener('keydown', (e) => {
  if (e.target !== treeEl) return;
  const vis = [...treeEl.querySelectorAll('.tn')].map((r) => r.dataset.id);
  let i = vis.indexOf(ui.treeFocus || ui.folder);
  if (i < 0) i = 0;
  const n = node(vis[i]);
  if (!n) return;
  const subs = n.children.some((c) => c.type === 'folder');
  const mod = modKey(e);
  const go = (j) => {
    const id = vis[Math.max(0, Math.min(vis.length - 1, j))];
    openFolder(id, { keepTreeFocus: true });
    const r = treeRowOf(id);
    if (r) r.scrollIntoView({ block: 'nearest' });
  };
  switch (e.key) {
    case 'ArrowDown':
      go(i + 1);
      break;
    case 'ArrowUp':
      go(i - 1);
      break;
    case 'Home':
      go(0);
      break;
    case 'End':
      go(vis.length - 1);
      break;
    case 'ArrowRight':
      if (subs && !ui.expanded.has(n.id)) toggleExpand(n.id, true);
      else if (subs) go(i + 1);
      break;
    case 'ArrowLeft':
      if (subs && ui.expanded.has(n.id)) toggleExpand(n.id, false);
      else if (n.parent) go(vis.indexOf(n.parent));
      break;
    case 'Enter':
      listEl.focus();
      if (!ui.focus && rows[0]) {
        ui.focus = rows[0].id;
        paintRows();
      }
      break;
    case 'F2':
      if (!n.root) startRename(n.id, 'tree');
      break;
    case 'Delete':
      if (!n.root) deleteNodes([n]);
      break;
    case 'ContextMenu':
      openTreeMenuAtRow(n.id);
      break;
    case 'F10':
      if (!e.shiftKey) return;
      openTreeMenuAtRow(n.id);
      break;
    default:
      if (mod && (e.key === 'x' || e.key === 'c') && !n.root) setClip(e.key === 'x' ? 'cut' : 'copy', [n]);
      else if (mod && e.key === 'v') pasteSoon({ parent: n.id, before: null });
      return; // not swallowed: the copy/cut/paste events still fire
  }
  e.preventDefault();
});

function openTreeMenuAtRow(id) {
  const r = treeRowOf(id);
  const rect = r ? r.getBoundingClientRect() : treeEl.getBoundingClientRect();
  treeMenu(id, rect.left + 24, rect.bottom);
}

// ---------------------------------------------------------------------------- contents list
function currentRows() {
  const q = ui.query.trim().toLowerCase();
  if (!q) return (node(ui.folder) || node('toolbar')).children;
  const terms = q.split(/\s+/).filter(Boolean);
  const out = [];
  for (const n of model.nodes.values()) {
    if (n.root) continue;
    const s = n.lc || (n.lc = `${n.title}\n${n.url || ''}`.toLowerCase());
    if (terms.every((t) => s.includes(t))) {
      out.push(n);
      if (out.length >= MAX_RESULTS) break;
    }
  }
  return out;
}

function renderList(resetScroll = false) {
  rows = currentRows();
  rowIndex = new Map(rows.map((n, i) => [n.id, i]));
  for (const id of [...ui.sel]) if (!rowIndex.has(id)) ui.sel.delete(id);
  if (ui.focus && !rowIndex.has(ui.focus)) ui.focus = null;
  pane.classList.toggle('searching', !!ui.query);
  clear(colHead).append(...[h('span', {}), h('span', { class: 'c1' }, 'Name'), h('span', { class: 'c2' }, 'Address'), ui.query ? h('span', { class: 'c3' }, 'Folder') : null, h('span', {})].filter(Boolean));
  spacer.style.height = `${rows.length * ROW_H + 8}px`;
  if (resetScroll) listEl.scrollTop = 0;
  renderEmpty();
  drawRows(true);
  renderSelbar();
}

let drawn = { first: -1, last: -1 };
function drawRows(force = false) {
  const top = listEl.scrollTop;
  const vh = listEl.clientHeight || 800;
  const first = Math.max(0, Math.floor(top / ROW_H) - 8);
  const last = Math.min(rows.length, Math.ceil((top + vh) / ROW_H) + 8);
  if (!force && first === drawn.first && last === drawn.last) return;
  drawn = { first, last };
  const frag = document.createDocumentFragment();
  for (let i = first; i < last; i++) frag.append(rowEl(rows[i], i));
  clear(rowsEl).append(frag);
}
listEl.addEventListener('scroll', () => drawRows());
new ResizeObserver(() => drawRows(true)).observe(listEl);

function iconFor(n, size = 18) {
  if (n.type === 'folder') return h('span', { class: 'ic' }, svg('folder', size));
  const src = icons[hostOf(n.url)];
  if (src) {
    const img = h('img', { class: 'favicon', width: size, height: size, alt: '', draggable: 'false' });
    img.src = src;
    return h('span', { class: 'ic' }, img);
  }
  return h('span', { class: 'ic' }, letterIcon(n.url, size));
}

function rowEl(n, i) {
  const el = h('div', { class: `bm-row${n.type === 'folder' ? ' folder' : ''}`, role: 'option', dataset: { id: n.id, i: String(i) }, style: { top: `${i * ROW_H + 4}px` } });
  if (ui.edit && ui.edit.where === 'list' && ui.edit.id === n.id) {
    el.classList.add('editing');
    el.append(iconFor(n), ...ui.edit.els);
    return paintRow(el);
  }
  el.draggable = true;
  el.title = n.type === 'url' ? `${titleOf(n)}\n${n.url}` : folderLabel(n.id);
  el.append(iconFor(n), h('span', { class: 'name' }, titleOf(n)), h('span', { class: 'addr' }, n.type === 'url' ? shortUrl(n.url) : plural(n.children.length, 'item')));
  if (ui.query) {
    const path = pathTo(n.parent).map(titleOf);
    el.append(h('span', { class: 'where', title: path.join(' › ') }, path.length > 2 ? `… › ${path.slice(-2).join(' › ')}` : path.join(' › ')));
  }
  el.append(h('button', { class: 'icon-btn more', tabindex: '-1', title: 'More actions', 'aria-label': 'More actions', dataset: { act: 'more' } }, svg('more', 16)));
  return paintRow(el);
}

function paintRow(el) {
  const id = el.dataset.id;
  const sel = ui.sel.has(id);
  el.classList.toggle('sel', sel);
  el.classList.toggle('focus', ui.focus === id);
  el.classList.toggle('cut', !!(ui.clip && ui.clip.mode === 'cut' && ui.clip.set.has(id)));
  el.classList.toggle('dragsrc', !!(drag && drag.set.has(id)));
  el.setAttribute('aria-selected', String(sel));
  return el;
}

/** Selection / focus / cut changes: restyle the drawn rows in place (never re-create them: that would cancel a drag about to start). */
function paintRows() {
  for (const el of rowsEl.children) paintRow(el);
  renderSelbar();
}

function renderEmpty() {
  clear(emptyEl);
  emptyEl.hidden = rows.length > 0;
  if (rows.length) return;
  if (ui.query) {
    emptyEl.append(h('div', { class: 'big' }, svg('search', 40)), h('h3', {}, 'No matching bookmarks'), h('div', {}, `Nothing in your bookmarks matches “${ui.query.trim()}”.`));
  } else if (model.total === 0 && model.nodes.size <= 3) {
    emptyEl.append(
      h('div', { class: 'big' }, svg('star', 40)),
      h('h3', {}, 'No bookmarks yet'),
      h('div', {}, `Press ${MOD}D on any page to bookmark it, or bring your bookmarks over from another browser.`),
      h('div', { class: 'btns' }, h('button', { class: 'btn primary', onclick: () => importDialog() }, 'Import bookmarks…'), h('button', { class: 'btn', onclick: () => editDialog({ parent: ui.folder }) }, 'Add bookmark')),
    );
  } else {
    emptyEl.append(
      h('div', { class: 'big' }, svg('folder', 40)),
      h('h3', {}, 'This folder is empty'),
      h('div', {}, 'Drag bookmarks or folders here, or add one.'),
      h('div', { class: 'btns' }, h('button', { class: 'btn', onclick: () => editDialog({ parent: ui.folder }) }, 'Add bookmark'), h('button', { class: 'btn', onclick: () => newFolder(ui.folder) }, 'New folder')),
    );
  }
}

function renderCrumbs() {
  clear(crumbsEl);
  if (ui.query) {
    crumbsEl.append(h('span', { class: 'qlabel' }, `Search results for “${ui.query.trim()}”`), h('button', { class: 'btn small', onclick: () => clearSearch() }, 'Clear search'), h('span', { class: 'count' }, rows.length >= MAX_RESULTS ? `First ${fmt(MAX_RESULTS)} results` : plural(rows.length, 'result')));
    return;
  }
  const path = pathTo(ui.folder);
  path.forEach((n, i) => {
    if (i) crumbsEl.append(h('span', { class: 'sep' }, svg('chevron', 14)));
    crumbsEl.append(h('button', { class: `crumb${i === path.length - 1 ? ' last' : ''}`, dataset: { id: n.id }, title: titleOf(n), onclick: () => openFolder(n.id) }, titleOf(n)));
  });
  const f = node(ui.folder);
  crumbsEl.append(h('span', { class: 'count' }, plural(f ? f.children.length : 0, 'item')));
}

function selectedNodes() {
  return rows.filter((n) => ui.sel.has(n.id));
}

function renderSelbar() {
  const sel = ui.sel.size > 1 ? selectedNodes() : [];
  selbar.hidden = sel.length < 2;
  if (sel.length < 2) return;
  const urls = urlsIn(sel);
  clear(selbar).append(
    h('span', { class: 'what' }, `${fmt(sel.length)} selected`),
    h('button', { class: 'btn small', disabled: !urls.length || undefined, onclick: () => openUrls(urls, 'new-tab') }, `Open ${urls.length >= 500 ? '500+' : fmt(urls.length)}`),
    h('button', { class: 'btn small', onclick: () => moveDialog(sel) }, 'Move to…'),
    h('button', { class: 'btn small danger', onclick: () => deleteNodes(sel) }, 'Delete'),
    h('button', { class: 'icon-btn', title: 'Clear selection', 'aria-label': 'Clear selection', onclick: () => { ui.sel.clear(); paintRows(); } }, svg('close', 15)),
  );
}

function renderAll({ resetScroll = false } = {}) {
  renderList(resetScroll);
  renderCrumbs();
  renderTree();
}

function ensureVisible(i) {
  if (!(i >= 0)) return;
  const top = i * ROW_H;
  if (top < listEl.scrollTop) listEl.scrollTop = top;
  else if (top + ROW_H + 8 > listEl.scrollTop + listEl.clientHeight) listEl.scrollTop = top + ROW_H + 8 - listEl.clientHeight;
  drawRows();
}

// --------------------------------------------------------------------------------- navigation
function openFolder(id, { select = null, focusList = false, keepTreeFocus = false, push = true } = {}) {
  const f = node(id);
  if (!f || f.type !== 'folder') return;
  const changed = ui.folder !== id || !!ui.query;
  ui.folder = id;
  ui.treeFocus = id;
  if (ui.query) {
    ui.query = '';
    searchInput.value = '';
  }
  for (const p of pathTo(id).slice(0, -1)) ui.expanded.add(p.id);
  if (changed || select) {
    ui.sel = new Set(select || []);
    ui.anchor = select ? select[0] : null;
    ui.focus = ui.anchor;
  }
  saveUi();
  const hash = `#${encodeURIComponent(id)}`;
  if (location.hash !== hash) history[push ? 'pushState' : 'replaceState'](null, '', hash);
  renderAll({ resetScroll: changed });
  if (select && select[0]) ensureVisible(rowIndex.get(select[0]));
  if (focusList) listEl.focus({ preventScroll: true });
  else if (keepTreeFocus) treeEl.focus({ preventScroll: true });
}
window.addEventListener('popstate', () => {
  const id = decodeURIComponent(location.hash.slice(1));
  if (node(id)) openFolder(id, { push: false });
});

function clearSearch() {
  searchInput.value = '';
  ui.query = '';
  ui.sel.clear();
  renderAll({ resetScroll: true });
}

let searchTimer = null;
searchInput.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    ui.query = searchInput.value;
    ui.sel.clear();
    ui.focus = null;
    renderAll({ resetScroll: true });
  }, 70);
});
searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && searchInput.value) {
    e.preventDefault();
    clearSearch();
  } else if (e.key === 'ArrowDown' || e.key === 'Enter') {
    e.preventDefault();
    clearTimeout(searchTimer);
    if (ui.query !== searchInput.value) {
      ui.query = searchInput.value;
      renderAll({ resetScroll: true });
    }
    if (rows[0]) {
      selectOnly(rows[0].id);
      paintRows();
    }
    listEl.focus();
  }
});

// ---------------------------------------------------------------------------------- selection
function selectOnly(id) {
  ui.sel = new Set(id ? [id] : []);
  ui.anchor = id;
  ui.focus = id;
}
function toggleSel(id) {
  if (ui.sel.has(id)) ui.sel.delete(id);
  else ui.sel.add(id);
  ui.anchor = id;
  ui.focus = id;
}
function rangeSelect(to, add) {
  const a = rowIndex.has(ui.anchor) ? rowIndex.get(ui.anchor) : to;
  const [lo, hi] = a < to ? [a, to] : [to, a];
  if (!add) ui.sel = new Set();
  for (let i = lo; i <= hi; i++) ui.sel.add(rows[i].id);
  ui.focus = rows[to].id;
}

let pendingSingle = null; // mousedown on an already-selected row: collapse the selection on click, unless it becomes a drag

listEl.addEventListener('mousedown', (e) => {
  if (e.target.closest('input')) return;
  const r = e.target.closest('.bm-row');
  if (e.button === 1) e.preventDefault(); // no autoscroll; middle-click opens
  if (!r) {
    if (e.button === 0 && !e.shiftKey && !modKey(e) && ui.sel.size) {
      ui.sel.clear();
      paintRows();
    }
    return;
  }
  const id = r.dataset.id;
  const i = Number(r.dataset.i);
  if (e.button === 2) {
    if (!ui.sel.has(id)) {
      selectOnly(id);
      paintRows();
    }
    return;
  }
  if (e.button !== 0) return;
  if (e.target.closest('[data-act="more"]')) {
    if (!ui.sel.has(id)) selectOnly(id);
  } else if (e.shiftKey) rangeSelect(i, modKey(e));
  else if (modKey(e)) toggleSel(id);
  else if (!ui.sel.has(id)) selectOnly(id);
  else {
    pendingSingle = id;
    ui.focus = id;
  }
  paintRows();
  if (document.activeElement !== listEl) listEl.focus({ preventScroll: true });
});

listEl.addEventListener('click', (e) => {
  const r = e.target.closest('.bm-row');
  if (!r || e.target.closest('input')) return;
  const id = r.dataset.id;
  const more = e.target.closest('[data-act="more"]');
  if (more) {
    const rect = more.getBoundingClientRect();
    listMenu(rect.left, rect.bottom + 2);
  } else if (pendingSingle === id && !e.shiftKey && !modKey(e)) {
    selectOnly(id);
    paintRows();
  }
  pendingSingle = null;
});

listEl.addEventListener('dblclick', (e) => {
  const r = e.target.closest('.bm-row');
  if (!r || e.target.closest('input, [data-act]')) return;
  activate([node(r.dataset.id)], e);
});

listEl.addEventListener('auxclick', (e) => {
  const r = e.target.closest('.bm-row');
  if (!r || e.button !== 1) return;
  const n = node(r.dataset.id);
  openUrls(urlsIn([n]), 'background-tab');
});

listEl.addEventListener('contextmenu', (e) => {
  if (e.target.closest('input')) return;
  e.preventDefault();
  const r = e.target.closest('.bm-row');
  if (r && !ui.sel.has(r.dataset.id)) {
    selectOnly(r.dataset.id);
    paintRows();
  }
  if (!r && ui.sel.size) {
    ui.sel.clear();
    paintRows();
  }
  listMenu(e.clientX, e.clientY);
});

listEl.addEventListener('keydown', (e) => {
  if (e.target !== listEl) return;
  const mod = modKey(e);
  const cur = rowIndex.has(ui.focus) ? rowIndex.get(ui.focus) : -1;
  const page = Math.max(1, Math.floor(listEl.clientHeight / ROW_H) - 1);
  const move = (to) => {
    if (!rows.length) return;
    to = Math.max(0, Math.min(rows.length - 1, to));
    if (e.shiftKey) {
      if (!rowIndex.has(ui.anchor)) ui.anchor = rows[cur >= 0 ? cur : to].id;
      rangeSelect(to, mod);
    } else if (mod) ui.focus = rows[to].id;
    else selectOnly(rows[to].id);
    ensureVisible(to);
    paintRows();
  };
  switch (e.key) {
    case 'ArrowDown':
      move(cur < 0 ? 0 : cur + 1);
      break;
    case 'ArrowUp':
      if (e.altKey) goUp();
      else move(cur < 0 ? 0 : cur - 1);
      break;
    case 'Home':
      move(0);
      break;
    case 'End':
      move(rows.length - 1);
      break;
    case 'PageDown':
      move(cur + page);
      break;
    case 'PageUp':
      move(cur - page);
      break;
    case ' ':
      if (cur >= 0) {
        if (mod) toggleSel(rows[cur].id);
        else if (!ui.sel.has(rows[cur].id)) selectOnly(rows[cur].id);
        paintRows();
      }
      break;
    case 'Enter': {
      const sel = selectedNodes();
      activate(sel.length ? sel : cur >= 0 ? [rows[cur]] : [], e);
      break;
    }
    case 'Delete':
      deleteSelection();
      break;
    case 'Backspace':
      if (isMac && e.metaKey) deleteSelection();
      else goUp();
      break;
    case 'F2':
      if (cur >= 0) startRename(rows[cur].id, 'list');
      else if (selectedNodes()[0]) startRename(selectedNodes()[0].id, 'list');
      break;
    case 'Escape':
      if (ui.clip && ui.clip.mode === 'cut') ui.clip = null;
      else ui.sel.clear();
      paintRows();
      break;
    case 'ContextMenu':
      openListMenuAtFocus();
      break;
    case 'F10':
      if (!e.shiftKey) return;
      openListMenuAtFocus();
      break;
    default:
      if (!mod) return;
      if (e.key === 'a' || e.key === 'A') {
        ui.sel = new Set(rows.map((n) => n.id));
        if (!ui.focus && rows[0]) ui.focus = rows[0].id;
        paintRows();
      } else if (e.key === 'x' || e.key === 'c') {
        setClip(e.key === 'x' ? 'cut' : 'copy', selectedNodes());
        return; // the copy/cut event also puts the URLs on the system clipboard
      } else if (e.key === 'v') {
        pasteSoon(pasteTarget());
        return; // handled by the paste event (system clipboard) or the fallback timer
      } else return;
  }
  e.preventDefault();
});

function openListMenuAtFocus() {
  const i = rowIndex.has(ui.focus) ? rowIndex.get(ui.focus) : -1;
  const el = i >= 0 ? rowsEl.querySelector(`.bm-row[data-i="${i}"]`) : null;
  const r = (el || listEl).getBoundingClientRect();
  listMenu(r.left + 40, el ? r.bottom : r.top + 10);
}

function goUp() {
  if (ui.query) return;
  const f = node(ui.folder);
  if (f && f.parent) openFolder(f.parent, { select: [f.id], focusList: true });
}

// ----------------------------------------------------------------------------------- actions
async function reload() {
  if (drag || ui.edit) {
    reloadPending = true;
    return;
  }
  reloadPending = false;
  const data = await call('bookmarks.data');
  buildModel(data);
  const f = node(ui.folder);
  if (!f || f.type !== 'folder') ui.folder = 'toolbar';
  if (ui.clip) {
    ui.clip.ids = ui.clip.ids.filter((id) => model.nodes.has(id));
    ui.clip.set = new Set(ui.clip.ids);
  }
  renderAll();
}

async function refreshIcons() {
  try {
    icons = (await call('bookmarks.icons')) || {};
  } catch {
    icons = {};
  }
}

/** A bookmarks.* change; the page re-reads the tree afterwards (also on failure). */
async function op(cmd, args) {
  try {
    return await call(cmd, args);
  } catch (e) {
    toast(errMsg(e));
    return null;
  } finally {
    await reload();
  }
}

function openUrls(urls, disposition) {
  if (urls.length) call('bookmarks.open', { urls, disposition }).catch((e) => toast(errMsg(e)));
}

function activate(nodes, e) {
  if (!nodes.length) return;
  if (nodes.length === 1 && nodes[0].type === 'folder') {
    openFolder(nodes[0].id, { focusList: true });
    return;
  }
  openUrls(urlsIn(nodes), e && e.shiftKey ? 'new-window' : e && modKey(e) ? 'background-tab' : 'new-tab');
}

/** Moves (or copies) nodes; announces it when they leave the open folder (or always, `announce`). @returns {number} */
async function moveTo(ids, parent, before = null, { copy = false, announce = false } = {}) {
  if (!ids.length) return 0;
  const r = await op(copy ? 'bookmarks.copy' : 'bookmarks.move', { ids, parent, before: before || undefined });
  if (r === null) return 0;
  const n = copy ? r.length : r;
  if (!n) return 0;
  if (announce || copy || parent !== ui.folder || ui.query) toast(`${copy ? 'Copied' : 'Moved'} ${plural(n, 'item')} to “${titleOf(node(parent))}”`, { canUndo: true });
  if (parent === ui.folder && !ui.query) {
    ui.sel = new Set(copy ? r : ids);
    paintRows();
  }
  return n;
}

function deleteSelection() {
  const sel = selectedNodes();
  if (!sel.length && rowIndex.has(ui.focus)) sel.push(node(ui.focus));
  deleteNodes(sel, { keyboard: true });
}

async function deleteNodes(nodes, { keyboard = false } = {}) {
  if (!nodes.length) return;
  const first = Math.min(...nodes.map((n) => (rowIndex.has(n.id) ? rowIndex.get(n.id) : Infinity)));
  const r = await op('bookmarks.remove', { ids: nodes.map((n) => n.id) });
  if (!r) return;
  const what = nodes.length === 1 ? `“${titleOf(nodes[0])}”` : plural(nodes.length, 'item');
  const inside = r.folders && r.bookmarks ? ` and ${plural(r.bookmarks, 'bookmark')} in ${r.folders === 1 ? 'it' : 'them'}` : '';
  toast(`Deleted ${what}${inside}`, { canUndo: true });
  if (keyboard && Number.isFinite(first) && rows.length) {
    selectOnly(rows[Math.min(first, rows.length - 1)].id);
    paintRows();
  }
}

async function undo() {
  if (ui.edit) return;
  const r = await op('bookmarks.undo', {});
  toast(r ? `Undone: ${r.label}` : 'Nothing to undo');
}

async function newFolder(parent, before = null) {
  const id = await op('bookmarks.add', { parent, type: 'folder', title: 'New folder', before: before || undefined });
  if (!id) return;
  if (parent === ui.folder && !ui.query) {
    selectOnly(id);
    paintRows();
    startRename(id, 'list');
  } else {
    ui.expanded.add(parent);
    renderTree();
    startRename(id, 'tree');
  }
}

async function sortFolder(id) {
  const r = await op('bookmarks.sort', { id });
  if (r) toast(`Sorted “${titleOf(node(id))}” by name`, { canUndo: true });
}

function showInFolder(n) {
  openFolder(n.parent, { select: [n.id], focusList: true });
}

// --------------------------------------------------------------------------- clipboard
function setClip(mode, nodes) {
  if (!nodes.length) return;
  const ids = nodes.map((n) => n.id);
  ui.clip = { mode, ids, set: new Set(ids), text: urlsIn(nodes).join('\n') };
  paintRows();
  toast(`${mode === 'cut' ? 'Cut' : 'Copied'} ${plural(nodes.length, 'item')} — paste with ${MOD}V`);
}

const editable = (el) => !!(el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)));

document.addEventListener('copy', (e) => {
  if (editable(document.activeElement) || !ui.clip || !ui.clip.text) return;
  e.clipboardData.setData('text/plain', ui.clip.text);
  e.preventDefault();
});
document.addEventListener('cut', (e) => {
  if (editable(document.activeElement) || !ui.clip || !ui.clip.text) return;
  e.clipboardData.setData('text/plain', ui.clip.text);
  e.preventDefault();
});

let pasteWait = null; // {target, timer}: Ctrl+V pressed, waiting for the paste event
function pasteSoon(target) {
  if (!target) return;
  clearTimeout(pasteWait && pasteWait.timer);
  pasteWait = { target, timer: setTimeout(() => runPaste(''), 120) };
}
document.addEventListener('paste', (e) => {
  if (editable(document.activeElement)) return;
  e.preventDefault();
  const text = e.clipboardData ? e.clipboardData.getData('text/plain') : '';
  if (!pasteWait) pasteWait = { target: pasteTarget(), timer: null };
  runPaste(text);
});

function runPaste(text) {
  if (!pasteWait) return;
  const { target, timer } = pasteWait;
  clearTimeout(timer);
  pasteWait = null;
  paste(target, text);
}

function pasteTarget() {
  if (ui.query) return null;
  const sel = selectedNodes();
  const last = sel[sel.length - 1] || node(ui.focus);
  const i = last && rowIndex.has(last.id) ? rowIndex.get(last.id) : -1;
  return { parent: ui.folder, before: i >= 0 && i + 1 < rows.length ? rows[i + 1].id : null };
}

/** URLs in pasted/dropped text (one per line), as {url, title}. */
function linksFromText(text) {
  const out = [];
  for (const line of String(text || '').split(/[\r\n]+/)) {
    const t = line.trim();
    if (!t || t.startsWith('#') || out.length >= 200) continue;
    if (/^(https?|ftp|file):\/\/\S+$/i.test(t)) out.push({ url: t, title: '' });
    else if (/^[a-z0-9-]+(\.[a-z0-9-]+)+(:\d+)?(\/\S*)?$/i.test(t)) out.push({ url: `https://${t}`, title: '' });
  }
  return out;
}

async function addLinks(links, target) {
  let n = 0;
  for (const l of links) {
    try {
      await call('bookmarks.add', { parent: target.parent, title: l.title || '', url: l.url, before: target.before || undefined });
      n++;
    } catch (e) {
      toast(errMsg(e));
    }
  }
  await reload();
  if (n) toast(`Added ${plural(n, 'bookmark')} to “${titleOf(node(target.parent))}”`, { canUndo: false });
}

async function paste(target, text) {
  if (!target) return;
  const c = ui.clip;
  const sys = linksFromText(text);
  if (c && c.ids.length && (!sys.length || text === c.text)) {
    hideToast();
    if (c.mode === 'cut') {
      ui.clip = null;
      await moveTo(c.ids, target.parent, target.before, { announce: true });
    } else await moveTo(c.ids, target.parent, target.before, { copy: true });
  } else if (sys.length) await addLinks(sys, target);
}

// ------------------------------------------------------------------------------ rename inline
function startRename(id, where) {
  const n = node(id);
  if (!n || n.root) return;
  if (ui.edit) finishRename(true);
  const title = h('input', { value: n.title, 'aria-label': 'Name', spellcheck: 'false', placeholder: n.type === 'folder' ? 'Folder name' : 'Name' });
  const url = n.type === 'url' && where === 'list' ? h('input', { value: n.url, 'aria-label': 'Address', spellcheck: 'false', placeholder: 'https://' }) : null;
  ui.edit = { id, where, els: url ? [title, url] : [title], title, url, n };
  for (const el of ui.edit.els) {
    el.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        e.preventDefault();
        finishRename(true);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        finishRename(false);
      }
    });
    el.addEventListener('blur', () =>
      setTimeout(() => {
        if (ui.edit && ui.edit.id === id && !ui.edit.els.includes(document.activeElement)) finishRename(true);
      }, 0),
    );
    el.addEventListener('mousedown', (e) => e.stopPropagation());
    el.addEventListener('dblclick', (e) => e.stopPropagation());
  }
  if (where === 'list') {
    const i = rowIndex.get(id);
    ensureVisible(i);
    drawRows(true);
  } else {
    for (const p of pathTo(n.parent)) ui.expanded.add(p.id);
    renderTree();
    const r = treeRowOf(id);
    if (r) r.scrollIntoView({ block: 'nearest' });
  }
  title.focus();
  title.select();
}

async function finishRename(save) {
  const ed = ui.edit;
  if (!ed) return;
  ui.edit = null;
  const t = ed.title.value;
  const u = ed.url ? ed.url.value.trim() : undefined;
  const refocus = ed.where === 'list' ? listEl : treeEl;
  if (save && (t !== ed.n.title || (ed.url && u !== ed.n.url))) {
    try {
      await call('bookmarks.update', { id: ed.id, title: t, url: u });
    } catch (e) {
      toast(errMsg(e));
    }
  }
  refocus.focus({ preventScroll: true });
  await reload();
}

// ----------------------------------------------------------------------------- drag and drop
const ownDrag = (e) => [...(e.dataTransfer ? e.dataTransfer.types : [])].includes(DND);
const linkDrag = (e) => [...(e.dataTransfer ? e.dataTransfer.types : [])].some((t) => t === 'text/uri-list' || t === 'text/plain');
const acceptable = (e) => ownDrag(e) || linkDrag(e);
const dropEffect = (e) => (!drag && !ownDrag(e) ? 'copy' : (isMac ? e.altKey : e.ctrlKey) ? 'copy' : 'move');

function startDrag(e, ids) {
  drag = { ids, set: new Set(ids) };
  const nodes = ids.map(node).filter(Boolean);
  const urls = urlsIn(nodes);
  e.dataTransfer.effectAllowed = 'copyMove';
  e.dataTransfer.setData(DND, JSON.stringify({ ids }));
  if (urls.length) {
    e.dataTransfer.setData('text/uri-list', urls.join('\r\n'));
    e.dataTransfer.setData('text/plain', urls.join('\n'));
  }
  if (ids.length > 1) {
    const img = h('div', { class: 'bm-dragimg' }, `${fmt(ids.length)} items`);
    document.body.append(img);
    e.dataTransfer.setDragImage(img, -12, -8);
    setTimeout(() => img.remove(), 0);
  }
  document.body.classList.add('dragging');
}

function endDrag() {
  if (!drag && !document.body.classList.contains('dragging')) return;
  drag = null;
  document.body.classList.remove('dragging');
  hideDrops();
  for (const el of document.querySelectorAll('.dragsrc')) el.classList.remove('dragsrc');
  clearTimeout(expandTimer.t);
  if (reloadPending) reload();
}
document.addEventListener('dragend', endDrag, true);
document.addEventListener('drop', () => setTimeout(endDrag, 0), true);
window.addEventListener('mousemove', (e) => {
  if (drag && e.buttons === 0) endDrag(); // the source row was re-drawn mid-drag: no dragend reached us
});

function hideDrops() {
  dropLine.hidden = true;
  treeLine.hidden = true;
  listEl.classList.remove('drop-here');
  for (const el of document.querySelectorAll('.drop-into')) el.classList.remove('drop-into');
}

/** Blocks drops that would put a folder inside itself (the main process refuses them too). */
function allowed(t) {
  if (!t || !drag) return t;
  for (const id of drag.ids) if (isAncestorOrSelf(id, t.parent)) return null;
  return t;
}

function listTarget(e) {
  if (!acceptable(e)) return null;
  const rect = listEl.getBoundingClientRect();
  const y = e.clientY - rect.top + listEl.scrollTop - 4;
  const i = Math.floor(y / ROW_H);
  if (i < 0 || i >= rows.length) return ui.query ? null : allowed({ kind: 'line', parent: ui.folder, before: null, at: rows.length });
  const n = rows[i];
  const f = (y - i * ROW_H) / ROW_H;
  if (n.type === 'folder' && !(drag && drag.set.has(n.id)) && (ui.query || (f > 0.25 && f < 0.75))) return allowed({ kind: 'into', parent: n.id, before: null, id: n.id });
  if (ui.query) return null;
  const at = f >= 0.5 ? i + 1 : i;
  return allowed({ kind: 'line', parent: ui.folder, before: at < rows.length ? rows[at].id : null, at });
}

function showListDrop(t) {
  hideDrops();
  if (t.kind === 'into') {
    const el = rowsEl.querySelector(`.bm-row[data-id="${CSS.escape(t.id)}"]`);
    if (el) el.classList.add('drop-into');
  } else if (!rows.length) listEl.classList.add('drop-here');
  else {
    dropLine.hidden = false;
    dropLine.style.top = `${t.at * ROW_H + 3}px`;
    dropLine.style.left = '14px';
    dropLine.style.right = '14px';
  }
}

function autoScroll(el, e) {
  const r = el.getBoundingClientRect();
  if (e.clientY < r.top + 32) el.scrollTop -= 14;
  else if (e.clientY > r.bottom - 32) el.scrollTop += 14;
}

listEl.addEventListener('dragstart', (e) => {
  const r = e.target.closest && e.target.closest('.bm-row');
  if (!r || ui.edit) {
    e.preventDefault();
    return;
  }
  const id = r.dataset.id;
  pendingSingle = null;
  if (!ui.sel.has(id)) selectOnly(id);
  startDrag(e, rows.filter((n) => ui.sel.has(n.id)).map((n) => n.id));
  paintRows();
});

listEl.addEventListener('dragover', (e) => {
  const t = listTarget(e);
  autoScroll(listEl, e);
  if (!t) {
    hideDrops();
    return;
  }
  e.preventDefault();
  e.dataTransfer.dropEffect = dropEffect(e);
  showListDrop(t);
});
listEl.addEventListener('dragleave', (e) => {
  if (!listEl.contains(e.relatedTarget)) hideDrops();
});
listEl.addEventListener('drop', (e) => {
  const t = listTarget(e);
  hideDrops();
  if (!t) return;
  e.preventDefault();
  performDrop(e, t);
});

async function performDrop(e, t) {
  const copy = dropEffect(e) === 'copy';
  let ids = null;
  try {
    const d = JSON.parse(e.dataTransfer.getData(DND) || 'null');
    ids = d && Array.isArray(d.ids) ? d.ids.filter((x) => typeof x === 'string') : null;
  } catch {
    ids = null;
  }
  const links = ids ? [] : linksFromDrop(e.dataTransfer);
  endDrag();
  if (ids && ids.length) await moveTo(ids, t.parent, t.before, { copy });
  else if (links.length) await addLinks(links, t);
}

function linksFromDrop(dt) {
  const uris = (dt.getData('text/uri-list') || '').split(/\r?\n/).filter((l) => l && !l.startsWith('#'));
  let title = '';
  try {
    const html = dt.getData('text/html');
    if (html) {
      const a = new DOMParser().parseFromString(html, 'text/html').querySelector('a[href]');
      if (a) title = a.textContent.trim().slice(0, 300);
    }
  } catch {
    /* no title */
  }
  if (uris.length) return uris.slice(0, 200).map((url, i) => ({ url: url.trim(), title: i === 0 ? title : '' }));
  return linksFromText(dt.getData('text/plain'));
}

// tree drops: middle = into, top/bottom quarter = before/after (folders reorder among their siblings)
const expandTimer = { id: null, t: null };
function treeTarget(e) {
  if (!acceptable(e)) return null;
  const row = e.target.closest && e.target.closest('.tn');
  if (!row) return null;
  const n = node(row.dataset.id);
  if (!n) return null;
  const r = row.getBoundingClientRect();
  const f = (e.clientY - r.top) / r.height;
  const subs = n.children.some((c) => c.type === 'folder');
  const open = subs && ui.expanded.has(n.id);
  if (n.root || (f > 0.25 && f < 0.75)) return allowed({ kind: 'into', parent: n.id, before: null, row, n });
  if (f <= 0.25) return allowed({ kind: 'line', parent: n.parent, before: n.id, row, n, edge: 'top' });
  if (open) return allowed({ kind: 'line', parent: n.id, before: n.children[0] ? n.children[0].id : null, row, n, edge: 'bottom', indent: 1 });
  const sibs = node(n.parent).children;
  const next = sibs[sibs.indexOf(n) + 1];
  return allowed({ kind: 'line', parent: n.parent, before: next ? next.id : null, row, n, edge: 'bottom' });
}

function showTreeDrop(t) {
  hideDrops();
  if (t.kind === 'into') {
    t.row.classList.add('drop-into');
    if (t.n.children.some((c) => c.type === 'folder') && !ui.expanded.has(t.n.id)) {
      if (expandTimer.id !== t.n.id) {
        clearTimeout(expandTimer.t);
        expandTimer.id = t.n.id;
        expandTimer.t = setTimeout(() => {
          ui.expanded.add(t.n.id);
          saveUi();
          renderTree();
        }, 650);
      }
    } else clearTimeout(expandTimer.t);
    return;
  }
  clearTimeout(expandTimer.t);
  expandTimer.id = null;
  const pad = parseFloat(t.row.style.paddingLeft) || 4;
  treeLine.hidden = false;
  treeLine.style.top = `${t.row.offsetTop + (t.edge === 'top' ? -1 : t.row.offsetHeight - 1)}px`;
  treeLine.style.left = `${pad + 26 + (t.indent ? 14 : 0)}px`;
  treeLine.style.right = '8px';
}

treeEl.addEventListener('dragstart', (e) => {
  const row = e.target.closest && e.target.closest('.tn');
  if (!row || ui.edit || node(row.dataset.id).root) {
    e.preventDefault();
    return;
  }
  startDrag(e, [row.dataset.id]);
  row.classList.add('dragsrc');
});
treeEl.addEventListener('dragover', (e) => {
  autoScroll(treeEl, e);
  const t = treeTarget(e);
  if (!t) {
    hideDrops();
    return;
  }
  e.preventDefault();
  e.dataTransfer.dropEffect = dropEffect(e);
  showTreeDrop(t);
});
treeEl.addEventListener('dragleave', (e) => {
  if (!treeEl.contains(e.relatedTarget)) {
    hideDrops();
    clearTimeout(expandTimer.t);
    expandTimer.id = null;
  }
});
treeEl.addEventListener('drop', (e) => {
  const t = treeTarget(e);
  hideDrops();
  if (!t) return;
  e.preventDefault();
  performDrop(e, t);
});

// breadcrumb segments are drop targets too ("into")
crumbsEl.addEventListener('dragover', (e) => {
  const c = e.target.closest && e.target.closest('.crumb');
  const t = c && acceptable(e) ? allowed({ kind: 'into', parent: c.dataset.id, before: null }) : null;
  if (!t) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = dropEffect(e);
  hideDrops();
  c.classList.add('drop-into');
});
crumbsEl.addEventListener('dragleave', (e) => {
  const c = e.target.closest && e.target.closest('.crumb');
  if (c && !c.contains(e.relatedTarget)) c.classList.remove('drop-into');
});
crumbsEl.addEventListener('drop', (e) => {
  const c = e.target.closest && e.target.closest('.crumb');
  const t = c && acceptable(e) ? allowed({ kind: 'into', parent: c.dataset.id, before: null }) : null;
  hideDrops();
  if (!t) return;
  e.preventDefault();
  performDrop(e, t);
});

// ------------------------------------------------------------------------------- context menu
let menuEl = null;
function closeMenu() {
  if (menuEl) menuEl.remove();
  menuEl = null;
}

function showMenu(x, y, items, returnFocus) {
  closeMenu();
  const el = h('div', { class: 'bm-menu', role: 'menu' });
  for (const it of items) {
    if (it === '-') {
      if (el.lastChild && !el.lastChild.classList.contains('sepr')) el.append(h('div', { class: 'sepr', role: 'separator' }));
      continue;
    }
    if (!it || it.hidden) continue;
    const b = h('button', { class: `mi${it.danger ? ' danger' : ''}`, role: 'menuitem', disabled: it.disabled || undefined }, h('span', {}, it.label), it.kbd ? h('span', { class: 'k' }, it.kbd) : null);
    b.addEventListener('click', () => {
      closeMenu();
      if (returnFocus) returnFocus.focus({ preventScroll: true });
      it.action();
    });
    el.append(b);
  }
  while (el.lastChild && el.lastChild.classList.contains('sepr')) el.lastChild.remove();
  if (!el.children.length) return;
  document.body.append(el);
  const r = el.getBoundingClientRect();
  el.style.left = `${Math.max(4, Math.min(x, window.innerWidth - r.width - 4))}px`;
  el.style.top = `${Math.max(4, y + r.height > window.innerHeight - 4 ? Math.max(4, y - r.height) : y)}px`;
  menuEl = el;
  const btns = () => [...el.querySelectorAll('.mi:not(:disabled)')];
  if (btns()[0]) btns()[0].focus();
  el.addEventListener('keydown', (e) => {
    const list = btns();
    const i = list.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') list[(i + 1) % list.length].focus();
    else if (e.key === 'ArrowUp') list[(i - 1 + list.length) % list.length].focus();
    else if (e.key === 'Home') list[0].focus();
    else if (e.key === 'End') list[list.length - 1].focus();
    else if (e.key === 'Escape' || e.key === 'Tab') {
      closeMenu();
      if (returnFocus) returnFocus.focus({ preventScroll: true });
    } else return;
    e.preventDefault();
    e.stopPropagation();
  });
}
document.addEventListener('mousedown', (e) => {
  if (menuEl && !menuEl.contains(e.target)) closeMenu();
}, true);
window.addEventListener('blur', closeMenu);
window.addEventListener('resize', closeMenu);
listEl.addEventListener('scroll', closeMenu);

function openItems(nodes) {
  const one = nodes.length === 1 ? nodes[0] : null;
  const urls = urlsIn(nodes);
  const n = urls.length >= 500 ? '500+' : fmt(urls.length);
  if (one && one.type === 'url') {
    return [
      { label: 'Open', action: () => openUrls(urls, 'current') },
      { label: 'Open in new tab', action: () => openUrls(urls, 'new-tab') },
      { label: 'Open in new window', action: () => openUrls(urls, 'new-window') },
      { label: 'Open in private window', action: () => openUrls(urls, 'private-window') },
    ];
  }
  return [
    { label: `Open all (${n})`, disabled: !urls.length, action: () => openUrls(urls, 'new-tab') },
    { label: 'Open all in new window', disabled: !urls.length, action: () => openUrls(urls, 'new-window') },
    { label: 'Open all in private window', disabled: !urls.length, action: () => openUrls(urls, 'private-window') },
  ];
}

function listMenu(x, y) {
  const sel = selectedNodes();
  const one = sel.length === 1 ? sel[0] : null;
  const folder = node(ui.folder);
  const target = pasteTarget();
  const canPaste = !!(target && ui.clip && ui.clip.ids.length);
  const items = [];
  if (sel.length) {
    items.push(
      ...openItems(sel),
      '-',
      { label: one && one.type === 'folder' ? 'Rename…' : 'Edit…', kbd: one ? 'F2' : null, hidden: !one, action: () => (one.type === 'folder' ? startRename(one.id, 'list') : editDialog({ id: one.id })) },
      { label: 'Show in folder', hidden: !(one && ui.query), action: () => showInFolder(one) },
      '-',
      { label: 'Cut', kbd: `${MOD}X`, action: () => setClip('cut', sel) },
      { label: 'Copy', kbd: `${MOD}C`, action: () => setClip('copy', sel) },
      { label: 'Paste', kbd: `${MOD}V`, hidden: !!ui.query, disabled: !canPaste, action: () => paste(target, '') },
      '-',
      { label: 'Move to…', action: () => moveDialog(sel) },
      { label: sel.length > 1 ? `Delete ${fmt(sel.length)} items` : 'Delete', kbd: 'Del', danger: true, action: () => deleteNodes(sel) },
    );
  } else if (!ui.query) items.push(...openItems([folder]), '-', { label: 'Paste', kbd: `${MOD}V`, disabled: !canPaste, action: () => paste(target, '') });
  if (!ui.query) {
    items.push(
      '-',
      { label: 'Add bookmark…', action: () => editDialog({ parent: ui.folder, before: target && target.before }) },
      { label: 'New folder', action: () => newFolder(ui.folder, target && target.before) },
      { label: 'Sort by name', disabled: folder.children.length < 2, action: () => sortFolder(ui.folder) },
    );
  }
  if (ui.query && !sel.length) items.push({ label: 'Clear search', action: () => clearSearch() });
  showMenu(x, y, items, listEl);
}

function treeMenu(id, x, y) {
  const n = node(id);
  if (!n) return;
  ui.treeFocus = id;
  const canPaste = !!(ui.clip && ui.clip.ids.length);
  showMenu(
    x,
    y,
    [
      ...openItems([n]),
      '-',
      { label: 'Add bookmark…', action: () => editDialog({ parent: id }) },
      { label: 'New folder', action: () => newFolder(id) },
      { label: 'Rename…', kbd: 'F2', hidden: n.root, action: () => startRename(id, 'tree') },
      { label: 'Sort by name', disabled: n.children.length < 2, action: () => sortFolder(id) },
      '-',
      { label: 'Cut', kbd: `${MOD}X`, hidden: n.root, action: () => setClip('cut', [n]) },
      { label: 'Copy', kbd: `${MOD}C`, hidden: n.root, action: () => setClip('copy', [n]) },
      { label: 'Paste into folder', kbd: `${MOD}V`, disabled: !canPaste, action: () => paste({ parent: id, before: null }, '') },
      '-',
      { label: 'Move to…', hidden: n.root, action: () => moveDialog([n]) },
      { label: 'Delete', kbd: 'Del', danger: true, hidden: n.root, action: () => deleteNodes([n]) },
    ],
    treeEl,
  );
}

// ------------------------------------------------------------------------------------ dialogs
function modal({ title, sub = null, body, actions, wide = false, initial = null, onClose = null }) {
  closeMenu();
  const prev = document.activeElement;
  const back = h('div', { class: 'bm-modal' });
  const box = h('div', { class: `bm-dialog${wide ? ' wide' : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': title });
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    back.remove();
    document.removeEventListener('keydown', onKey, true);
    if (onClose) onClose();
    if (prev && prev.focus && document.contains(prev)) prev.focus({ preventScroll: true });
  };
  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  };
  document.addEventListener('keydown', onKey, true);
  back.addEventListener('mousedown', (e) => {
    if (e.target === back) close();
  });
  box.append(h('header', {}, h('h2', {}, title), sub ? h('div', { class: 'sub' }, sub) : null), h('div', { class: 'body' }, ...body), h('footer', {}, ...actions(close)));
  back.append(box);
  document.body.append(back);
  setTimeout(() => {
    const f = initial || box.querySelector('input, select, .btn.primary');
    if (f) f.focus();
  }, 0);
  return { close, box };
}

const field = (label, input) => h('label', { class: 'field' }, h('span', {}, label), input);

function folderOptions(sel, excludeId = null) {
  const s = h('select', { class: 'input', 'aria-label': 'Folder' });
  const walk = (n, depth) => {
    if (excludeId && n.id === excludeId) return;
    s.append(h('option', { value: n.id }, `${' '.repeat(depth)}${titleOf(n)}`));
    for (const c of n.children) if (c.type === 'folder' && depth < 30) walk(c, depth + 1);
  };
  for (const r of visibleRoots()) walk(r, 0);
  s.value = node(sel) ? sel : 'toolbar';
  return s;
}

function editDialog({ id = null, parent = ui.folder, before = null } = {}) {
  const n = id ? node(id) : null;
  const isFolder = !!(n && n.type === 'folder');
  const name = h('input', { class: 'input', value: n ? n.title : '', placeholder: isFolder ? 'Folder name' : 'Name (optional)', spellcheck: 'false' });
  const url = isFolder ? null : h('input', { class: 'input', value: n ? n.url : '', placeholder: 'https://example.com', spellcheck: 'false' });
  const folder = folderOptions(n ? n.parent : parent, isFolder ? n.id : null);
  const err = h('div', { class: 'err', hidden: true });
  const save = async (close) => {
    err.hidden = true;
    try {
      if (n) {
        await call('bookmarks.update', { id: n.id, title: name.value, url: url ? url.value : undefined });
        if (folder.value !== n.parent) await call('bookmarks.move', { ids: [n.id], parent: folder.value });
      } else {
        if (!url.value.trim()) throw new Error('Enter the address of the page.');
        await call('bookmarks.add', { parent: folder.value, type: 'url', title: name.value, url: url.value, before: folder.value === parent && before ? before : undefined });
      }
      close();
      await reload();
    } catch (e) {
      err.textContent = errMsg(e);
      err.hidden = false;
    }
  };
  const d = modal({
    title: n ? (isFolder ? 'Edit folder' : 'Edit bookmark') : 'Add bookmark',
    body: [field('Name', name), url ? field('Address (URL)', url) : null, field('Folder', folder), err],
    initial: n ? name : url,
    actions: (close) => [h('button', { class: 'btn', onclick: close }, 'Cancel'), h('button', { class: 'btn primary', onclick: () => save(close) }, 'Save')],
  });
  for (const el of [name, url]) if (el) el.addEventListener('keydown', (e) => e.key === 'Enter' && save(d.close));
}

function moveDialog(nodes) {
  if (!nodes.length) return;
  const ids = nodes.map((n) => n.id);
  const banned = nodes.filter((n) => n.type === 'folder').map((n) => n.id);
  let chosen = !ui.query && !banned.some((b) => isAncestorOrSelf(b, ui.folder)) ? ui.folder : 'other';
  const filter = h('input', { class: 'input', type: 'search', placeholder: 'Find a folder', spellcheck: 'false' });
  const list = h('div', { class: 'bm-picker', role: 'listbox', 'aria-label': 'Folders' });
  const go = (close) => {
    close();
    moveTo(ids, chosen);
  };
  let closeFn = null;
  const render = () => {
    clear(list);
    const q = filter.value.trim().toLowerCase();
    const walk = (n, depth) => {
      if (banned.some((b) => isAncestorOrSelf(b, n.id))) return;
      if (!q || titleOf(n).toLowerCase().includes(q)) {
        const where = q && n.parent ? pathTo(n.parent).map(titleOf) : [];
        const row = h(
          'div',
          { class: `pf${chosen === n.id ? ' sel' : ''}`, role: 'option', 'aria-selected': String(chosen === n.id), dataset: { id: n.id }, title: folderLabel(n.id), style: { paddingLeft: `${8 + (q ? 0 : depth * 16)}px` } },
          svg(n.id === 'toolbar' ? 'bar' : 'folder', 16),
          h('span', { class: 't' }, titleOf(n)),
          where.length ? h('span', { class: 't faint', style: { fontSize: '12px' } }, `in ${where.length > 2 ? `… › ${where.slice(-2).join(' › ')}` : where.join(' › ')}`) : null,
        );
        row.addEventListener('click', () => {
          chosen = n.id;
          render();
        });
        row.addEventListener('dblclick', () => {
          chosen = n.id;
          go(closeFn);
        });
        list.append(row);
      }
      for (const c of n.children) if (c.type === 'folder' && depth < 30) walk(c, depth + 1);
    };
    for (const r of visibleRoots()) walk(r, 0);
    const s = list.querySelector('.pf.sel');
    if (s) s.scrollIntoView({ block: 'nearest' });
  };
  filter.addEventListener('input', render);
  filter.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') go(closeFn);
  });
  const d = modal({
    title: `Move ${nodes.length === 1 ? `“${titleOf(nodes[0])}”` : plural(nodes.length, 'item')} to…`,
    body: [filter, list],
    initial: filter,
    actions: (close) => [
      h('button', { class: 'btn', onclick: async () => { const id = await op('bookmarks.add', { parent: chosen, type: 'folder', title: 'New folder' }); if (id) { chosen = id; render(); } } }, svg('folderPlus', 16), 'New folder'),
      h('span', { class: 'grow' }),
      h('button', { class: 'btn', onclick: close }, 'Cancel'),
      h('button', { class: 'btn primary', onclick: () => go(close) }, 'Move here'),
    ],
  });
  closeFn = d.close;
  render();
}

const BROWSER_COLORS = { edge: '#0c7bd0', chrome: '#1e8e3e', brave: '#fb542b', vivaldi: '#ef3939', opera: '#e3122a', 'opera-gx': '#fa1e4e', arc: '#5b3fd1', chromium: '#4587f3', yandex: '#f33', firefox: '#ff7139', librewolf: '#00acff', waterfox: '#3d8fd8', zen: '#202124' };
function browserLogo(s) {
  const base = s.browser.startsWith('opera-gx') ? 'opera-gx' : s.browser.split('-')[0];
  const tile = h('span', { class: 'logo' }, (s.browserName || s.name || '?').replace(/^(Microsoft|Google|Mozilla)\s+/, '')[0]);
  tile.style.background = BROWSER_COLORS[base] || 'var(--accent)';
  return tile;
}

async function importDialog() {
  let lastFolder = null;
  const cbBm = h('input', { type: 'checkbox', checked: true });
  const cbHist = h('input', { type: 'checkbox', checked: true });
  const modeFolder = h('input', { type: 'radio', name: 'bm-mode', value: 'folder', checked: true });
  const modeMerge = h('input', { type: 'radio', name: 'bm-mode', value: 'merge' });
  const srcBox = h('div', { class: 'bm-sources' }, h('div', { class: 'muted' }, 'Looking for other browsers on this computer…'));
  const fileSub = h('div', { class: 's' }, 'Exported from any browser: Chrome, Edge, Firefox, Safari…');
  const fileBtn = h('button', { class: 'btn' }, 'Choose file…');
  fileBtn.addEventListener('click', async () => {
    const r = await call('import.bookmarks.file');
    if (!r.ok) {
      fileSub.className = 's bad';
      fileSub.textContent = r.error.message;
    } else if (r.value) {
      fileSub.className = 's ok';
      fileSub.textContent = `${r.value.name}: added ${plural(r.value.bookmarks, 'bookmark')}${r.value.skipped ? ` · ${fmt(r.value.skipped)} already here` : ''}`;
      lastFolder = r.value.folder;
      await reload();
    }
  });
  modal({
    title: 'Import bookmarks',
    sub: 'Bring bookmarks and history over from another browser on this computer, or from a bookmarks file. Importing the same browser again only adds what’s new.',
    wide: true,
    body: [
      h('h3', {}, 'From another browser'),
      srcBox,
      h(
        'div',
        { class: 'bm-opts' },
        h('div', { class: 'row2' }, h('label', {}, cbBm, 'Bookmarks'), h('label', {}, cbHist, 'History (last 90 days)')),
        h('label', {}, modeFolder, 'Put bookmarks in a new folder on the bookmarks bar (“Imported from …”)'),
        h('label', {}, modeMerge, 'Merge them into my bookmarks bar and Other bookmarks'),
      ),
      h('h3', {}, 'From a file'),
      h('div', { class: 'bm-src' }, h('span', { class: 'logo', style: { background: 'var(--muted)' } }, svg('import', 18)), h('div', { class: 'grow' }, h('div', { class: 't' }, 'Bookmarks HTML file'), fileSub), fileBtn),
      h('div', { class: 'notice' }, 'Passwords aren’t read from other browsers — they keep them encrypted. Export them as a CSV file in that browser, then import the file on the ', h('a', { href: 'ludworks://passwords/' }, 'Passwords page'), '.'),
    ],
    actions: (close) => [h('button', { class: 'btn primary', onclick: close }, 'Done')],
    onClose: () => {
      if (lastFolder && node(lastFolder)) openFolder(lastFolder);
    },
  });
  let sources = [];
  try {
    const r = await call('import.sources');
    sources = r && r.ok ? r.value : [];
  } catch {
    sources = [];
  }
  clear(srcBox);
  if (!sources.length) srcBox.append(h('div', { class: 'muted' }, 'No other browsers were found on this computer. You can still import a bookmarks file exported from any browser.'));
  const subs = [];
  for (const s of sources) {
    const sub = h('div', { class: 's' }, s.bookmarks ? 'Counting bookmarks…' : s.history ? 'History' : '');
    const btn = h('button', { class: 'btn' }, 'Import');
    btn.addEventListener('click', async () => {
      if (!cbBm.checked && !cbHist.checked) {
        sub.className = 's bad';
        sub.textContent = 'Choose bookmarks, history or both.';
        return;
      }
      btn.disabled = true;
      btn.textContent = 'Importing…';
      sub.className = 's';
      sub.textContent = 'Importing…';
      const r = await call('import.browser', { browser: s.id, bookmarks: cbBm.checked, history: cbHist.checked, mode: modeMerge.checked ? 'merge' : 'folder' }).catch((e) => ({ ok: false, error: { message: errMsg(e) } }));
      btn.disabled = false;
      if (r.ok) {
        const v = r.value;
        const parts = [];
        if (cbBm.checked && s.bookmarks) parts.push(v.bookmarks ? `Added ${plural(v.bookmarks, 'bookmark')}` : 'No new bookmarks');
        if (cbBm.checked && v.skipped) parts.push(`${fmt(v.skipped)} already here`);
        if (cbHist.checked && s.history) parts.push(v.history ? `${plural(v.history, 'history page')} added` : 'history up to date');
        sub.className = 's ok';
        sub.textContent = `✓ ${parts.join(' · ') || 'Done'}`;
        btn.textContent = 'Import again';
        if (v.folder) lastFolder = v.folder;
        await refreshIcons();
        await reload();
      } else {
        sub.className = 's bad';
        sub.textContent = r.error.message;
        btn.textContent = 'Try again';
      }
    });
    srcBox.append(h('div', { class: 'bm-src', dataset: { source: s.id } }, browserLogo(s), h('div', { class: 'grow' }, h('div', { class: 't' }, s.name), sub), btn));
    subs.push([s, sub]);
  }
  for (const [s, sub] of subs) {
    if (!s.bookmarks) continue;
    const r = await call('import.inspect', { browser: s.id }).catch(() => null);
    if (sub.textContent !== 'Counting bookmarks…') continue;
    if (r && r.ok) sub.textContent = `${plural(r.value.bookmarks, 'bookmark')}${r.value.folders ? ` in ${plural(r.value.folders, 'folder')}` : ''}${s.history ? ' · history' : ''}`;
    else sub.textContent = r && r.error ? r.error.message : 'Bookmarks and history';
  }
}

async function exportAll() {
  const r = await call('export.bookmarks').catch((e) => ({ ok: false, error: { message: errMsg(e) } }));
  if (!r.ok) toast(r.error.message);
  else if (r.value) toast(`Exported ${plural(model.total, 'bookmark')} to ${r.value.path}`);
}

// --------------------------------------------------------------------------------------- toast
let toastEl = null;
let toastTimer = null;
function hideToast() {
  if (toastEl) toastEl.remove();
  toastEl = null;
  clearTimeout(toastTimer);
}
function toast(msg, { canUndo = false, ms = 6000 } = {}) {
  hideToast();
  toastEl = h(
    'div',
    { class: 'bm-toast', role: 'status' },
    h('span', { class: 'msg', title: msg }, msg),
    canUndo ? h('button', { class: 'btn small', onclick: () => { hideToast(); undo(); } }, 'Undo') : null,
    h('button', { class: 'icon-btn', title: 'Dismiss', 'aria-label': 'Dismiss', onclick: hideToast }, svg('close', 14)),
  );
  document.body.append(toastEl);
  toastTimer = setTimeout(hideToast, ms);
}

// ----------------------------------------------------------------------------------- global keys
document.addEventListener('keydown', (e) => {
  if (document.querySelector('.bm-modal') || editable(document.activeElement)) return;
  const mod = modKey(e);
  if (mod && !e.shiftKey && (e.key === 'z' || e.key === 'Z')) {
    e.preventDefault();
    undo();
  } else if ((mod && e.key === 'f') || (e.key === '/' && !mod)) {
    e.preventDefault();
    searchInput.focus();
    searchInput.select();
  }
});

// ------------------------------------------------------------------------------------- startup
let reloadTimer = null;
window.lwPage.on('page-event', (ev) => {
  if (!ev || ev.type !== 'bookmarks' || ev.version === model.version) return;
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => reload(), 60);
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') refreshIcons().then(() => drawRows(true));
});

async function start() {
  loadUi();
  const [theme, data] = await Promise.all([call('theme'), call('bookmarks.data'), refreshIcons()]);
  applyTheme(theme);
  buildModel(data);
  const fromHash = decodeURIComponent(location.hash.slice(1));
  if (node(fromHash) && node(fromHash).type === 'folder') ui.folder = fromHash;
  if (!node(ui.folder) || node(ui.folder).type !== 'folder') ui.folder = 'toolbar';
  history.replaceState(null, '', `#${encodeURIComponent(ui.folder)}`);
  ui.treeFocus = ui.folder;
  for (const p of pathTo(ui.folder).slice(0, -1)) ui.expanded.add(p.id);
  renderAll({ resetScroll: true });
  listEl.focus({ preventScroll: true });
}
start();
