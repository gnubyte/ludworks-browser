// Browser chrome: tab strip, toolbar with the address bar, bookmarks bar and find bar.
import { icon, h, clear, faviconEl } from './icons.js';

const $ = (id) => document.getElementById(id);
const root = document.documentElement;
root.dataset.platform = window.lw.platform;

let state = null;
let omniFocused = false;
let omniEdited = false;
let selIndex = -1;
let suggestionsOpen = false;
let lastTop = -1;
const tabEls = new Map();

// ------------------------------------------------------------------------------- static icons
$('newtab').append(icon('plus', { size: 18 }));
$('back').append(icon('back', { size: 18 }));
$('forward').append(icon('forward', { size: 18 }));
$('reload').append(icon('reload', { size: 17 }));
$('home').append(icon('home', { size: 17 }));
$('star').append(icon('star', { size: 16 }));
$('key').append(icon('key', { size: 16 }));
$('downloads').append(icon('download', { size: 18 }));
$('menu').append(icon('menu', { size: 18 }));
$('find-prev').append(icon('up', { size: 16 }));
$('find-next').append(icon('down', { size: 16 }));
$('find-close').append(icon('close', { size: 16 }));

const call = (cmd, args) => window.lw.call(cmd, args).catch((e) => console.warn(cmd, e && e.message));

function anchorOf(el, { align = 'left', width = 320, dy = 2 } = {}) {
  const r = el.getBoundingClientRect();
  return { x: Math.round(align === 'right' ? r.right - width : r.left), y: Math.round(r.bottom + dy), width, align: 'left' };
}

// ------------------------------------------------------------------------------- layout report
function reportLayout() {
  const top = Math.ceil($('chrome').getBoundingClientRect().height);
  if (top !== lastTop) {
    lastTop = top;
    call('layout', { top });
  }
}
new ResizeObserver(reportLayout).observe($('chrome'));

function updateWindowControlsInset() {
  const wco = navigator.windowControlsOverlay;
  if (window.lw.platform === 'darwin' || !wco || !wco.visible) {
    $('wincontrols').hidden = true;
    return;
  }
  const r = wco.getTitlebarAreaRect();
  const right = Math.max(0, window.innerWidth - (r.x + r.width));
  root.style.setProperty('--wco-width', `${right + 4}px`);
  $('wincontrols').hidden = false;
}
if (navigator.windowControlsOverlay) navigator.windowControlsOverlay.addEventListener('geometrychange', updateWindowControlsInset);
window.addEventListener('resize', updateWindowControlsInset);

// ------------------------------------------------------------------------------------- tabs
function tabEl(t) {
  let el = tabEls.get(t.id);
  if (!el) {
    el = h('div', { class: 'tab', role: 'tab', dataset: { id: t.id } });
    el.addEventListener('mousedown', (e) => {
      if (e.button === 0 && !e.target.closest('.close,.audio')) call('tab.activate', { id: t.id });
      if (e.button === 1) e.preventDefault();
    });
    el.addEventListener('auxclick', (e) => {
      if (e.button === 1) call('tab.close', { id: t.id });
    });
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      call('tab.menu', { id: t.id });
    });
    el.addEventListener('dblclick', (e) => e.stopPropagation());
    setupDrag(el, t.id);
    tabEls.set(t.id, el);
  }
  return el;
}

function renderTab(el, t, active, narrow) {
  el.classList.toggle('active', active);
  el.classList.toggle('pinned', !!t.pinned);
  el.classList.toggle('narrow', narrow);
  el.classList.toggle('crashed', !!(t.error && t.error.kind === 'crash'));
  el.classList.toggle('agent', !!t.agent); // an AI agent is using this tab (shared with it)
  el.setAttribute('aria-selected', active ? 'true' : 'false');
  el.title = t.title + (t.url && !t.url.startsWith('ludworks://newtab') ? `\n${t.display || t.url}` : '');
  const key = JSON.stringify([t.title, t.favicon, t.loading, t.audible, t.muted, t.pinned, !!t.error]);
  if (el.dataset.key === key) return;
  el.dataset.key = key;
  clear(el);
  if (t.loading && !t.favicon) el.append(h('span', { class: 'spinner' }));
  else if (t.loading) el.append(h('span', { class: 'spinner' }));
  else if (t.url && t.url.startsWith('ludworks://')) el.append(logoMark());
  else el.append(faviconEl(t.favicon, t.title, 16));
  el.append(h('span', { class: 'title' }, t.title || 'New Tab'));
  if (t.audible || t.muted) {
    el.append(
      h('button', { class: 'audio', title: t.muted ? 'Unmute tab' : 'Mute tab', 'aria-label': t.muted ? 'Unmute tab' : 'Mute tab', onclick: (e) => { e.stopPropagation(); call('tab.mute', { id: t.id }); } }, icon(t.muted ? 'muted' : 'speaker', { size: 14 })),
    );
  }
  el.append(h('button', { class: 'close', title: 'Close tab (Ctrl+W)', 'aria-label': 'Close tab', onclick: (e) => { e.stopPropagation(); call('tab.close', { id: t.id }); } }, icon('close', { size: 14 })));
  el.append(h('span', { class: 'curve-r' }));
}

function logoMark() {
  const img = h('img', { class: 'favicon', width: 16, height: 16, alt: '', draggable: 'false' });
  img.src = '/assets/logo.svg';
  return img;
}

function renderTabs() {
  const box = $('tabs');
  const ids = new Set(state.tabs.map((t) => t.id));
  for (const [id, el] of tabEls) if (!ids.has(id)) {
    el.remove();
    tabEls.delete(id);
  }
  const avail = box.parentElement.clientWidth - 180;
  const unpinned = state.tabs.filter((t) => !t.pinned).length || 1;
  const narrow = avail / unpinned < 90;
  state.tabs.forEach((t, i) => {
    const el = tabEl(t);
    renderTab(el, t, t.id === state.activeId, narrow);
    if (box.children[i] !== el) box.insertBefore(el, box.children[i] || null);
  });
}

// Drag a tab along the strip to reorder it. Pulled out of the strip it moves into a window of its own that
// follows the cursor; dropped on another window's strip it joins that window (src/main/tab-drag.js: the main
// process moves the windows, from the OS cursor, and marks the drop spot in the other window's strip).
const DETACH_DISTANCE = 30; // px above / below the strip (or beside the window) that pull a tab out
let tabDrag = null; // {id, el, pointerId, x, grab: {x, y}, mode: null|'strip'|'out', sent}
const tabDrop = h('div', { id: 'tab-drop', hidden: true });
$('tabstrip').append(tabDrop);

function setupDrag(el, id) {
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('.close,.audio')) return;
    if (tabDrag) endTabDrag(null, false); // a drag that never saw its pointer released
    const r = el.getBoundingClientRect();
    // where the cursor holds the tab once it is the first tab of a window of its own
    const grab = { x: Math.round($('tabs').getBoundingClientRect().left + e.clientX - r.left), y: Math.round(e.clientY) };
    tabDrag = { id, el, pointerId: e.pointerId, x: e.clientX, grab, mode: null, sent: false };
    el.setPointerCapture(e.pointerId);
  });
}

function outOfStrip(e) {
  const r = $('tabstrip').getBoundingClientRect();
  return e.clientY < r.top - DETACH_DISTANCE || e.clientY > r.bottom + DETACH_DISTANCE || e.clientX < -DETACH_DISTANCE || e.clientX > window.innerWidth + DETACH_DISTANCE;
}

/** Live tab elements other than the dragged one, and the index before which a drop at clientX lands. */
function stripDropIndex(clientX, exceptEl) {
  const others = [...$('tabs').children].filter((c) => c !== exceptEl);
  let index = others.length;
  for (let i = 0; i < others.length; i++) {
    const r = others[i].getBoundingClientRect();
    if (clientX < r.left + r.width / 2) {
      index = i;
      break;
    }
  }
  return { others, index };
}

/** The drop marker before tab `index` of `others` (after the last one past the end); null hides it. */
function showTabDrop(others, index) {
  if (index === null || !others.length) {
    tabDrop.hidden = true;
    return;
  }
  const base = $('tabstrip').getBoundingClientRect().left;
  const x = index < others.length ? others[index].getBoundingClientRect().left : others[others.length - 1].getBoundingClientRect().right;
  tabDrop.style.left = `${Math.round(x - base - 1)}px`;
  tabDrop.hidden = false;
}

window.addEventListener('pointermove', (e) => {
  const d = tabDrag;
  if (!d || e.pointerId !== d.pointerId) return;
  if (d.mode === 'out') {
    if (!d.sent) {
      d.sent = true; // one move in flight at a time
      requestAnimationFrame(() => {
        d.sent = false;
        if (tabDrag === d) call('tab.drag', { phase: 'move' });
      });
    }
    return;
  }
  if (!state.agent && !state.fullscreen && outOfStrip(e)) {
    // the page keeps sending until the button is released: hold the pointer on the strip, as the tab's own
    // element goes away when the tab moves into a window of its own
    d.mode = 'out';
    d.el.classList.add('dragging');
    showTabDrop([], null);
    $('tabstrip').setPointerCapture(d.pointerId);
    call('tab.drag', { phase: 'start', id: d.id, x: d.grab.x, y: d.grab.y });
    return;
  }
  if (!d.mode && Math.abs(e.clientX - d.x) > 6) {
    d.mode = 'strip';
    d.el.classList.add('dragging');
  }
  if (d.mode === 'strip') {
    const { others, index } = stripDropIndex(e.clientX, d.el);
    showTabDrop(others, index);
  }
});

function endTabDrag(e, released) {
  const d = tabDrag;
  tabDrag = null;
  d.el.classList.remove('dragging');
  showTabDrop([], null);
  if (d.mode === 'out') call('tab.drag', { phase: 'end' });
  else if (d.mode === 'strip' && released) call('tab.move', { id: d.id, index: stripDropIndex(e.clientX, d.el).index });
}
window.addEventListener('pointerup', (e) => {
  if (tabDrag && e.pointerId === tabDrag.pointerId) endTabDrag(e, true);
});
window.addEventListener('pointercancel', (e) => {
  if (tabDrag && e.pointerId === tabDrag.pointerId) endTabDrag(e, false);
});
// Capture lost without a pointerup (e.g. the window lost the mouse); the hand-over to the strip is not a loss.
window.addEventListener('lostpointercapture', (e) => {
  const d = tabDrag;
  if (!d || e.pointerId !== d.pointerId || (d.mode === 'out' && e.target !== $('tabstrip'))) return;
  endTabDrag(e, false);
});

// Another window's tab being dragged over this strip: where it would land (src/main/tab-drag.js).
window.lw.on('tab-drop', (m) => {
  const others = [...$('tabs').children];
  showTabDrop(others, m && Number.isInteger(m.index) ? Math.min(m.index, others.length) : null);
});

// The strip's geometry, for the main process to place tabs dropped here from other windows.
let lastStrip = '';
function reportStrip() {
  const tabs = [...$('tabs').children].map((el) => {
    const r = el.getBoundingClientRect();
    return { id: Number(el.dataset.id), left: Math.round(r.left), right: Math.round(r.right) };
  });
  const msg = { tabs, bottom: Math.round($('tabstrip').getBoundingClientRect().bottom) };
  const key = JSON.stringify(msg);
  if (key === lastStrip) return;
  lastStrip = key;
  call('tab.strip', msg);
}

// --------------------------------------------------------------------------------- toolbar
function active() {
  return state && state.tabs.find((t) => t.id === state.activeId);
}

function renderToolbar() {
  const t = active();
  $('back').disabled = !(t && t.canGoBack);
  $('forward').disabled = !(t && t.canGoForward);
  clear($('reload')).append(icon(t && t.loading ? 'stop' : 'reload', { size: 17 }));
  $('reload').title = t && t.loading ? 'Stop loading' : 'Reload (Ctrl+R)';
  $('home').hidden = !state.showHomeButton;
  if (!omniFocused || !omniEdited) {
    const v = t ? t.display : '';
    if ($('url').value !== v && !omniFocused) $('url').value = v;
  }
  // security chip
  const si = $('siteinfo');
  clear(si);
  si.className = `omni-chip ${t ? t.security : ''}`;
  if (t && (t.security === 'insecure' || t.security === 'dangerous')) {
    si.append(icon('warn', { size: 15 }), h('span', { class: 'label' }, 'Not secure'));
  } else if (t && t.security === 'secure') si.append(icon('lock', { size: 15 }));
  else if (t && t.security === 'internal') si.append(logoMark());
  else si.append(icon('info', { size: 15 }));
  $('star').classList.toggle('on', !!(t && t.bookmarked));
  $('star').hidden = !(t && /^(https?|file|ftp):/.test(t.url || ''));
  const zc = $('zoom-chip');
  zc.hidden = !t || t.zoom === 100;
  zc.textContent = t ? `${t.zoom}%` : '';
  // key (passwords) chip
  const k = state.keyState || null;
  $('key').hidden = !(k && k.show);
  $('key').classList.toggle('on', !!(k && k.count));
  $('key').classList.toggle('locked', !!(k && k.locked));
  $('key').classList.toggle('capture', !!(k && k.capture));
  $('key').title = k && k.capture ? 'Save password?' : k && k.locked ? 'Ludworks vault is locked' : k && k.count ? `${k.count} saved login${k.count === 1 ? '' : 's'} for this site` : 'Passwords';
  // downloads
  const d = state.downloads || {};
  const db = $('downloads');
  db.hidden = !d.any;
  clear(db).append(icon('download', { size: 18 }));
  if (d.active && d.progress !== null) {
    const ring = h('span', { class: 'ring' });
    const pct = Math.round(d.progress * 100);
    ring.style.background = `conic-gradient(var(--accent) ${pct}%, transparent ${pct}%)`;
    ring.style.mask = 'radial-gradient(circle, transparent 11px, #000 11.5px)';
    db.append(ring);
  }
  if (d.unseen) db.append(h('span', { class: 'badge' }));
  // account
  const a = state.account || {};
  const ab = $('account');
  clear(ab);
  if (a.phase === 'logged_out' || !a.user) {
    ab.append(icon('user', { size: 18 }));
    ab.title = 'Sign in to Ludworks';
  } else {
    const letter = ((a.user.displayName || a.user.username || '?').trim()[0] || '?').toUpperCase();
    ab.append(h('span', { class: `avatar ${a.phase === 'unlocked' ? '' : 'locked'}` }, letter));
    ab.title = `${a.user.displayName || a.user.username} — ${a.serverHost || 'Ludworks'}${a.phase === 'unlocked' ? '' : ' (locked)'}`;
  }
}

// Buttons contributed by feature modules (Browser.registerFeature): icon, optional count badge, popup.
function renderFeatureButtons() {
  const box = $('feature-buttons');
  const buttons = state.toolbarButtons || [];
  const key = JSON.stringify(buttons);
  if (box.dataset.key === key) return;
  box.dataset.key = key;
  clear(box);
  for (const b of buttons) {
    const btn = h('button', { class: `icon-btn feature ${b.pressed ? 'on' : ''} ${b.tone ? `tone-${b.tone}` : ''}`, title: b.title || '', 'aria-label': b.title || b.id, dataset: { id: b.id } }, icon(b.icon, { size: 18 }));
    if (b.badge !== undefined && b.badge !== null && b.badge !== '' && b.badge !== 0) btn.append(h('span', { class: 'count' }, String(b.badge)));
    if (b.popup) btn.addEventListener('click', () => call('popup.open', { kind: b.popup.kind, anchor: anchorOf(btn, { align: 'right', width: b.popup.width || 340 }) }));
    box.append(btn);
  }
}

// ---------------------------------------------------------------------------- bookmarks bar
// HTML5 drag and drop: drag items to reorder them, onto a folder to move them in (hovering opens
// the folder's menu, which takes drops too), drag links from pages, the address-bar text or the
// site chip in to bookmark them at that spot, and drag items out as links. Right-click / Delete /
// F2 go to the main process (native context menu, edit popup). Items that don't fit go into a »
// menu.
const BM_DND = 'application/x-ludworks-bookmark';
const BM_TITLE = 'application/x-ludworks-title';
const bmBar = { icons: {}, iconsVersion: null, iconsLoaded: 0, overflowAt: -1, drag: null, stale: false, hover: { key: null, timer: null }, popupByDrag: false };

function bmHost(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
}

function renderBookmarksBar() {
  const bar = $('bookmarks-bar');
  const items = state.bookmarksBar;
  const show = Array.isArray(items) && !state.private;
  bar.hidden = !show;
  $('chrome').classList.toggle('no-bar', !show);
  if (!show) return;
  if (state.bookmarkIcons !== bmBar.iconsVersion) {
    bmBar.iconsVersion = state.bookmarkIcons;
    window.lw.call('bookmark.icons').then((m) => {
      bmBar.icons = m || {};
      bmBar.iconsLoaded++;
      renderBookmarksBar();
    }, () => {});
  }
  const key = JSON.stringify([items, bmBar.iconsLoaded]);
  if (bar.dataset.key === key) return;
  if (bmBar.drag) {
    bmBar.stale = true; // re-drawing now would cancel the drag in progress
    return;
  }
  bar.dataset.key = key;
  clear(bar);
  const list = h('div', { class: 'bm-items', role: 'toolbar', 'aria-label': 'Bookmarks' });
  if (!items.length) list.append(h('span', { class: 'empty' }, `Drag links here, or press ${window.lw.platform === 'darwin' ? '⌘' : 'Ctrl+'}D to bookmark a page.`));
  for (const b of items) list.append(barButton(b));
  const more = h('button', { class: 'bm-more', title: 'More bookmarks', 'aria-label': 'More bookmarks', hidden: true }, icon('chevrons', { size: 15 }));
  more.addEventListener('click', () => call('bookmark.folder', { id: 'toolbar', start: bmBar.overflowAt, anchor: anchorOf(more, { align: 'right', width: 300 }) }));
  bar.append(list, more, h('div', { class: 'bm-drop', hidden: true }));
  layoutBookmarksBar();
}

function barButton(b) {
  const btn = h(
    'button',
    { class: `bm${b.type === 'folder' ? ' folder' : ''}`, draggable: 'true', dataset: { id: b.id }, title: b.type === 'url' ? `${b.title || ''}\n${b.url}` : b.title || 'Folder' },
    b.type === 'folder' ? icon('folder', { size: 15 }) : faviconEl(bmBar.icons[bmHost(b.url)] || null, b.title || b.url, 15),
    h('span', { class: 't' }, b.title || (b.type === 'url' ? b.url : 'Folder')),
  );
  const menu = () => call('bookmark.menu', { id: b.id, anchor: anchorOf(btn, { width: 340 }) });
  btn.addEventListener('click', (e) => {
    if (b.type === 'folder') call('bookmark.folder', { id: b.id, anchor: anchorOf(btn, { width: 300 }) });
    else call('bookmark.open', { id: b.id, disposition: e.ctrlKey || e.metaKey ? 'background-tab' : e.shiftKey ? 'new-window' : 'current' });
  });
  btn.addEventListener('auxclick', (e) => {
    if (e.button === 1 && b.type === 'url') call('bookmark.open', { id: b.id, disposition: 'background-tab' });
  });
  btn.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    menu();
  });
  btn.addEventListener('keydown', (e) => {
    if (e.key === 'Delete' || (e.key === 'Backspace' && e.metaKey)) call('bookmark.remove', { id: b.id });
    else if (e.key === 'F2') call('bookmark.edit', { id: b.id, anchor: anchorOf(btn, { width: 340 }) });
    else if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) menu();
    else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      const all = [...$('bookmarks-bar').querySelectorAll('.bm:not(.over), .bm-more:not([hidden])')];
      const next = all[all.indexOf(btn) + (e.key === 'ArrowRight' ? 1 : -1)];
      if (next) next.focus();
    } else return;
    e.preventDefault();
  });
  btn.addEventListener('dragstart', (e) => {
    bmBar.drag = { id: b.id };
    e.dataTransfer.effectAllowed = 'copyMove';
    e.dataTransfer.setData(BM_DND, JSON.stringify({ ids: [b.id] }));
    if (b.url) {
      e.dataTransfer.setData('text/uri-list', b.url);
      e.dataTransfer.setData('text/plain', b.url);
      e.dataTransfer.setData(BM_TITLE, b.title || '');
    }
    btn.classList.add('dragging');
  });
  btn.addEventListener('dragend', endBarDrag);
  return btn;
}

function endBarDrag() {
  for (const el of $('bookmarks-bar').querySelectorAll('.bm.dragging')) el.classList.remove('dragging');
  bmBar.drag = null;
  clearBarDrop();
  if (bmBar.popupByDrag) {
    bmBar.popupByDrag = false;
    call('popup.close', { kind: 'bookmark-folder' });
  }
  if (bmBar.stale) {
    bmBar.stale = false;
    renderBookmarksBar();
  }
}
// A drag can end without a dragend reaching the source (e.g. dropped in another view): settle on the next move.
window.addEventListener('mousemove', (e) => {
  if (bmBar.drag && e.buttons === 0) endBarDrag();
});

/** Hides the items that don't fit behind the » button. */
function layoutBookmarksBar() {
  const bar = $('bookmarks-bar');
  const list = bar.querySelector('.bm-items');
  const more = bar.querySelector('.bm-more');
  if (!list || bar.hidden) return;
  const btns = [...list.querySelectorAll('.bm')];
  for (const b of btns) b.classList.remove('over');
  more.hidden = true;
  bmBar.overflowAt = -1;
  const fits = () => btns.findIndex((b) => b.offsetLeft + b.offsetWidth > list.clientWidth + 1);
  if (!btns.length || fits() < 0) return;
  more.hidden = false; // the » button takes some room itself
  const at = fits();
  if (at < 0) {
    more.hidden = true;
    return;
  }
  for (let j = at; j < btns.length; j++) btns[j].classList.add('over');
  bmBar.overflowAt = at;
}
new ResizeObserver(() => layoutBookmarksBar()).observe($('bookmarks-bar'));

/** Where a drag over the bar would land: {kind: 'into', id} a folder, {kind: 'more'}, or {kind: 'line', before, x}. */
function barTarget(e) {
  const types = [...e.dataTransfer.types];
  if (!types.includes(BM_DND) && !types.includes('text/uri-list') && !types.includes('text/plain')) return null;
  const bar = $('bookmarks-bar');
  if (e.target.closest && e.target.closest('.bm-more')) return { kind: 'more' };
  const btns = [...bar.querySelectorAll('.bm-items .bm:not(.over)')];
  const base = bar.getBoundingClientRect().left;
  for (let i = 0; i < btns.length; i++) {
    const r = btns[i].getBoundingClientRect();
    const id = btns[i].dataset.id;
    if (e.clientX >= r.left && e.clientX <= r.right && btns[i].classList.contains('folder') && !(bmBar.drag && bmBar.drag.id === id)) {
      const f = (e.clientX - r.left) / r.width;
      if (f > 0.22 && f < 0.78) return { kind: 'into', id, btn: btns[i] };
    }
    if (e.clientX < r.left + r.width / 2) return { kind: 'line', before: id, x: r.left - base - 1 };
  }
  const items = state.bookmarksBar || [];
  const last = btns[btns.length - 1];
  return { kind: 'line', before: bmBar.overflowAt >= 0 && items[bmBar.overflowAt] ? items[bmBar.overflowAt].id : null, x: last ? last.getBoundingClientRect().right - base + 1 : 10 };
}

function clearBarDrop() {
  const bar = $('bookmarks-bar');
  const line = bar.querySelector('.bm-drop');
  if (line) line.hidden = true;
  bar.classList.remove('drop-empty');
  for (const el of bar.querySelectorAll('.drop-into')) el.classList.remove('drop-into');
  clearTimeout(bmBar.hover.timer);
  bmBar.hover.key = null;
}

/** Hovering a drag over a folder (or ») for a moment opens its menu, which accepts the drop too. */
function hoverOpen(t) {
  const key = t.kind === 'more' ? 'more' : t.id;
  if (bmBar.hover.key === key) return;
  clearTimeout(bmBar.hover.timer);
  bmBar.hover.key = key;
  bmBar.hover.timer = setTimeout(() => {
    const bar = $('bookmarks-bar');
    const anchorEl = t.kind === 'more' ? bar.querySelector('.bm-more') : t.btn;
    if (!anchorEl || !anchorEl.isConnected) return;
    bmBar.popupByDrag = true;
    call('bookmark.folder', { id: t.kind === 'more' ? 'toolbar' : t.id, start: t.kind === 'more' ? bmBar.overflowAt : 0, drag: true, anchor: anchorOf(anchorEl, { align: t.kind === 'more' ? 'right' : 'left', width: 300 }) });
  }, 550);
}

$('bookmarks-bar').addEventListener('dragover', (e) => {
  const t = barTarget(e);
  const bar = $('bookmarks-bar');
  for (const el of bar.querySelectorAll('.drop-into')) el.classList.remove('drop-into');
  const line = bar.querySelector('.bm-drop');
  if (line) line.hidden = true;
  if (!t) return;
  e.preventDefault();
  const own = [...e.dataTransfer.types].includes(BM_DND);
  const allowed = e.dataTransfer.effectAllowed;
  e.dataTransfer.dropEffect = own ? 'move' : /copy|all|uninitialized/i.test(allowed) ? 'copy' : 'link';
  if (t.kind === 'into' || t.kind === 'more') {
    (t.kind === 'more' ? bar.querySelector('.bm-more') : t.btn).classList.add('drop-into');
    hoverOpen(t);
    return;
  }
  clearTimeout(bmBar.hover.timer);
  bmBar.hover.key = null;
  if (!(state.bookmarksBar || []).length) bar.classList.add('drop-empty');
  else if (line) {
    line.hidden = false;
    line.style.left = `${Math.round(t.x)}px`;
  }
});
$('bookmarks-bar').addEventListener('dragleave', (e) => {
  if (!$('bookmarks-bar').contains(e.relatedTarget)) clearBarDrop();
});
$('bookmarks-bar').addEventListener('drop', (e) => {
  const t = barTarget(e);
  clearBarDrop();
  if (!t || t.kind === 'more') return;
  e.preventDefault();
  const parent = t.kind === 'into' ? t.id : 'toolbar';
  const before = t.kind === 'line' && t.before ? t.before : undefined;
  const own = e.dataTransfer.getData(BM_DND);
  if (own) {
    let ids = [];
    try {
      ids = JSON.parse(own).ids || [];
    } catch {
      /* not ours */
    }
    if (ids.length) call('bookmark.move', { ids, parent, before });
    return;
  }
  const uri = (e.dataTransfer.getData('text/uri-list') || '').split(/\r?\n/).find((l) => l && !l.startsWith('#'));
  const url = (uri || e.dataTransfer.getData('text/plain') || '').trim();
  if (!url) return;
  let title = e.dataTransfer.getData(BM_TITLE);
  if (!title) {
    const html = e.dataTransfer.getData('text/html');
    const a = html ? new DOMParser().parseFromString(html, 'text/html').querySelector('a[href]') : null;
    title = a ? a.textContent.trim() : '';
  }
  call('bookmark.drop', { url: url.slice(0, 8192), title: title.slice(0, 1024), parent, before });
});
$('bookmarks-bar').addEventListener('contextmenu', (e) => {
  e.preventDefault();
  const r = $('bookmarks-bar').getBoundingClientRect();
  call('bookmark.menu', { id: null, anchor: { x: Math.round(e.clientX), y: Math.round(r.bottom + 2), width: 340 } });
});

// The site chip carries the current page: drag it to the bar (or anywhere) to bookmark / share it.
$('siteinfo').draggable = true;
$('siteinfo').addEventListener('dragstart', (e) => {
  const t = active();
  if (!t || !/^(https?|file|ftp):/i.test(t.url || '')) {
    e.preventDefault();
    return;
  }
  e.dataTransfer.effectAllowed = 'copyLink';
  e.dataTransfer.setData('text/uri-list', t.url);
  e.dataTransfer.setData('text/plain', t.url);
  e.dataTransfer.setData(BM_TITLE, t.title || '');
});

function renderFind() {
  const t = active();
  const fb = $('findbar');
  const show = !!(t && t.find);
  fb.hidden = !show;
  if (!show) return;
  const f = t.find;
  $('find-count').textContent = f.text ? `${f.matches ? f.active : 0}/${f.matches || 0}` : '';
  $('find-input').classList.toggle('nomatch', !!(f.text && f.matches === 0));
}

// An AI agent's own window (src/main/agent/agent.js): a coloured frame around the page (pulsing while the
// agent works) and a bar saying who is in control, with Stop.
function renderAgent() {
  const a = state.agent;
  root.dataset.agent = String(!!a);
  root.dataset.agentBusy = String(!!(a && a.busy && !a.stopped));
  let bar = $('agent-bar');
  if (!a) {
    if (bar) bar.remove();
    return;
  }
  if (!bar) {
    bar = h('div', { id: 'agent-bar', role: 'status' });
    $('chrome').append(bar);
  }
  const key = JSON.stringify(a);
  if (bar.dataset.key === key) return;
  bar.dataset.key = key;
  clear(bar);
  const act = (action) => call('popup.action', { kind: 'agents', action, data: { key: a.key } });
  bar.append(
    icon('bot', { size: 15 }),
    h('span', { class: 'who' }, `${a.client}${a.label ? ` · ${a.label}` : ''}`),
    h('span', { class: 'what' }, a.stopped ? 'stopped by you' : a.busy ? 'is working in this window…' : 'is using this window'),
    h('span', { class: 'grow' }),
    a.stopped ? h('button', { class: 'agent-btn', onclick: () => act('resume') }, 'Resume') : h('button', { class: 'agent-btn', title: 'Stop this agent (it cannot continue until you resume it)', onclick: () => act('stop') }, 'Stop'),
    h('button', { class: 'agent-btn', title: 'Disconnect the agent (the tabs stay)', onclick: () => act('disconnect') }, 'Disconnect'),
  );
}

function render(s) {
  state = s;
  root.dataset.theme = s.theme;
  root.dataset.fullscreen = String(!!s.fullscreen);
  root.dataset.htmlfs = String(!!s.htmlFullscreen);
  renderAgent();
  renderTabs();
  renderToolbar();
  renderFeatureButtons();
  renderBookmarksBar();
  renderFind();
  updateWindowControlsInset();
  reportLayout();
  reportStrip();
}

// --------------------------------------------------------------------------------- omnibox
const url = $('url');
url.addEventListener('focus', () => {
  omniFocused = true;
  omniEdited = false;
  $('omnibox').classList.add('focused');
  const t = active();
  if (t && t.url && !t.url.startsWith('ludworks://newtab')) url.value = t.url;
  setTimeout(() => url.select(), 0);
  call('focus', { focused: true });
});
url.addEventListener('blur', () => {
  omniFocused = false;
  $('omnibox').classList.remove('focused');
  call('focus', { focused: false });
  setTimeout(() => {
    if (!omniFocused) {
      call('omnibox.close');
      suggestionsOpen = false;
      omniEdited = false;
      renderToolbar();
    }
  }, 150);
});
url.addEventListener('input', () => {
  omniEdited = true;
  selIndex = -1;
  const r = $('omnibox').getBoundingClientRect();
  suggestionsOpen = !!url.value.trim();
  call('omnibox.input', { text: url.value, anchor: { x: Math.round(r.left), y: Math.round(r.bottom + 4), width: Math.round(r.width) } });
});
url.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    const disposition = e.altKey || e.metaKey ? 'new-tab' : e.shiftKey ? 'new-window' : 'current';
    const text = url.value.trim();
    if (!text) return;
    if (selIndex >= 0 && suggestionsOpen) call('omnibox.commit', { index: selIndex, disposition });
    else call('omnibox.commit', { text, disposition });
    omniEdited = false;
    suggestionsOpen = false;
    selIndex = -1;
    url.blur();
  } else if (e.key === 'Escape') {
    if (suggestionsOpen) {
      call('omnibox.close');
      suggestionsOpen = false;
    } else {
      omniEdited = false;
      const t = active();
      url.value = t ? t.url || '' : '';
      url.select();
    }
    e.preventDefault();
  } else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && suggestionsOpen) {
    e.preventDefault();
    selIndex = Math.max(-1, selIndex + (e.key === 'ArrowDown' ? 1 : -1));
    call('omnibox.select', { index: selIndex });
  }
});
window.lw.on('suggestions-closed', () => {
  suggestionsOpen = false;
  selIndex = -1;
});
window.lw.on('focus-omnibox', (o) => {
  url.focus();
  if (!o || o.select !== false) url.select();
});

// ------------------------------------------------------------------------- toolbar buttons
$('newtab').addEventListener('click', () => call('tab.new'));
$('tabstrip').addEventListener('dblclick', (e) => {
  if (e.target === $('drag-spacer') || e.target === $('tabs')) call('tab.new');
});
$('back').addEventListener('click', () => call('nav', { action: 'back' }));
$('forward').addEventListener('click', () => call('nav', { action: 'forward' }));
$('reload').addEventListener('click', (e) => {
  const t = active();
  call('nav', { action: t && t.loading ? 'stop' : e.shiftKey ? 'hardReload' : 'reload' });
});
$('home').addEventListener('click', () => call('nav', { action: 'home' }));
$('siteinfo').addEventListener('click', () => call('popup.open', { kind: 'site-info', anchor: anchorOf($('siteinfo'), { width: 340 }) }));
$('star').addEventListener('click', () => call('popup.open', { kind: 'star', anchor: anchorOf($('star'), { align: 'right', width: 340 }) }));
$('key').addEventListener('click', () => call('popup.open', { kind: 'key', anchor: anchorOf($('key'), { align: 'right', width: 360 }) }));
$('downloads').addEventListener('click', () => call('popup.open', { kind: 'downloads', anchor: anchorOf($('downloads'), { align: 'right', width: 380 }) }));
$('account').addEventListener('click', () => call('popup.open', { kind: 'account', anchor: anchorOf($('account'), { align: 'right', width: 340 }) }));
$('menu').addEventListener('click', () => call('popup.open', { kind: 'menu', anchor: anchorOf($('menu'), { align: 'right', width: 300 }) }));
$('zoom-chip').addEventListener('click', () => call('command', { cmd: 'zoomReset' }));
window.lw.on('open-star', () => {
  if (!$('star').hidden) $('star').click();
});
window.lw.on('open-menu', () => $('menu').click());
window.lw.on('open-account', () => $('account').click());
window.lw.on('open-key', () => {
  if (!$('key').hidden) $('key').click();
});
window.lw.on('open-tab-search', () => call('popup.open', { kind: 'tab-search', anchor: anchorOf($('newtab'), { width: 380 }) }));
window.lw.on('download-started', () => {
  const d = $('downloads');
  d.classList.remove('pulse');
  void d.offsetWidth;
  d.classList.add('pulse');
});
window.lw.on('zoom-bubble', () => {});

// -------------------------------------------------------------------------------- find bar
const fi = $('find-input');
let findTimer = null;
window.lw.on('find-open', () => {
  setTimeout(() => {
    fi.focus();
    fi.select();
  }, 0);
});
fi.addEventListener('input', () => {
  clearTimeout(findTimer);
  findTimer = setTimeout(() => call('find', { text: fi.value }), 80);
});
fi.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    call('find', { text: fi.value, forward: !e.shiftKey, next: true });
  } else if (e.key === 'Escape') {
    e.preventDefault();
    call('find', { close: true });
  }
});
$('find-next').addEventListener('click', () => call('find', { text: fi.value, forward: true, next: true }));
$('find-prev').addEventListener('click', () => call('find', { text: fi.value, forward: false, next: true }));
$('find-close').addEventListener('click', () => call('find', { close: true }));

// ------------------------------------------------------------------------------------ boot
window.lw.on('state', render);
call('ready').then((s) => s && render(s));
window.addEventListener('resize', () => {
  if (!state) return;
  renderTabs();
  reportStrip();
});
