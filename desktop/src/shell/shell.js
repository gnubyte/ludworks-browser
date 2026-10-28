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

// Drag a tab to reorder (within the strip).
function setupDrag(el, id) {
  let startX = 0;
  let dragging = false;
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('.close,.audio')) return;
    startX = e.clientX;
    dragging = false;
    el.setPointerCapture(e.pointerId);
  });
  el.addEventListener('pointermove', (e) => {
    if (!el.hasPointerCapture(e.pointerId)) return;
    if (!dragging && Math.abs(e.clientX - startX) > 6) {
      dragging = true;
      el.classList.add('dragging');
    }
  });
  el.addEventListener('pointerup', (e) => {
    if (!el.hasPointerCapture(e.pointerId)) return;
    el.releasePointerCapture(e.pointerId);
    if (!dragging) return;
    el.classList.remove('dragging');
    const others = [...$('tabs').children].filter((c) => c !== el);
    let index = others.length;
    for (let i = 0; i < others.length; i++) {
      const r = others[i].getBoundingClientRect();
      if (e.clientX < r.left + r.width / 2) {
        index = i;
        break;
      }
    }
    call('tab.move', { id, index });
  });
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

function renderBookmarksBar() {
  const bar = $('bookmarks-bar');
  const items = state.bookmarksBar;
  const show = Array.isArray(items) && !state.private;
  bar.hidden = !show;
  $('chrome').classList.toggle('no-bar', !show);
  if (!show) return;
  const key = JSON.stringify(items);
  if (bar.dataset.key === key) return;
  bar.dataset.key = key;
  clear(bar);
  if (!items.length) {
    bar.append(h('span', { class: 'empty' }, 'Bookmarks you add to the bar appear here. Press Ctrl+D to bookmark a page.'));
    return;
  }
  for (const b of items) {
    const btn = h('button', { class: 'bm', title: b.type === 'url' ? `${b.title}\n${b.url}` : b.title }, b.type === 'folder' ? icon('folder', { size: 15 }) : faviconEl(null, b.title || b.url, 15), h('span', { class: 't' }, b.title || b.url || 'Untitled'));
    btn.addEventListener('click', (e) => {
      if (b.type === 'folder') call('bookmark.folder', { id: b.id, anchor: anchorOf(btn, { width: 280 }) });
      else call('bookmark.open', { id: b.id, disposition: e.ctrlKey || e.metaKey ? 'background-tab' : e.shiftKey ? 'new-window' : 'current' });
    });
    btn.addEventListener('auxclick', (e) => {
      if (e.button === 1 && b.type === 'url') call('bookmark.open', { id: b.id, disposition: 'background-tab' });
    });
    bar.append(btn);
  }
}

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

function render(s) {
  state = s;
  root.dataset.theme = s.theme;
  root.dataset.fullscreen = String(!!s.fullscreen);
  root.dataset.htmlfs = String(!!s.htmlFullscreen);
  renderTabs();
  renderToolbar();
  renderBookmarksBar();
  renderFind();
  updateWindowControlsInset();
  reportLayout();
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
window.addEventListener('resize', () => state && renderTabs());
