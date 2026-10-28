// Popup overlay: renders whichever popup the main process asks for and reports its size.
import { icon, h, clear, faviconEl } from './icons.js';
import { POPUPS as ACCOUNT_POPUPS } from './overlay-account.js';
import { POPUPS as BLOCKER_POPUPS } from './overlay-blocker.js';
import { POPUPS as PRIVACY_POPUPS } from './overlay-privacy.js';

const rootEl = document.getElementById('root');
const html = document.documentElement;
let current = null; // {kind, seq, data, modal}

const call = (cmd, args) => window.lw.call(cmd, args);
const act = (kind, action, data) => call('popup.action', { kind, action, data });
const close = (kind) => call('popup.close', { kind });

function fmtBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n >= 10 || i === 0 ? Math.round(n) : n.toFixed(1)} ${u[i]}`;
}

function reportSize() {
  if (!current) return;
  const el = rootEl.firstElementChild;
  if (!el || current.modal) return;
  const r = el.getBoundingClientRect();
  call('popup.size', { seq: current.seq, width: Math.ceil(r.width + 36), height: Math.ceil(r.height + 34) });
}
const ro = new ResizeObserver(() => reportSize());

// --------------------------------------------------------------------------------- popups
const POPUPS = {
  suggestions(data, ctx) {
    const box = h('div', { class: 'popup sugg' }, h('div', { class: 'list' }));
    const list = box.firstChild;
    const items = data.items || [];
    items.forEach((it, i) => {
      const ic =
        it.kind === 'search' ? icon('search', { size: 16 }) : it.kind === 'history' ? icon('history', { size: 16 }) : it.kind === 'bookmark' ? icon('star', { size: 16 }) : it.kind === 'tab' ? icon('tab', { size: 16 }) : icon('globe', { size: 16 });
      const row = h(
        'button',
        { class: 'item', dataset: { i } },
        h('span', { class: 'ic' }, ic),
        h('span', { class: 'grow' }, h('div', { class: 't' }, it.title || it.url), it.subtitle ? h('div', { class: 's' }, it.subtitle) : null),
      );
      row.addEventListener('mousedown', (e) => {
        e.preventDefault();
        act('suggestions', 'open', { url: it.url, tabId: it.tabId || null, disposition: e.button === 1 || e.ctrlKey ? 'background-tab' : 'current' });
      });
      list.append(row);
    });
    ctx.select = (i) => [...list.children].forEach((c, j) => c.classList.toggle('sel', i === j));
    return box;
  },

  menu(data, ctx) {
    const cmd = (c, arg) => () => act('menu', 'command', { cmd: c, arg });
    const item = (label, c, kbd, ic) => h('button', { class: 'item', onclick: cmd(c) }, h('span', { class: 'ic' }, ic ? icon(ic, { size: 16 }) : null), h('span', { class: 'grow t' }, label), kbd ? h('span', { class: 'kbd' }, kbd) : null);
    const mod = window.lw.platform === 'darwin' ? '⌘' : 'Ctrl+';
    const zoomVal = h('span', { class: 'val' }, `${data.zoom}%`);
    const zoom = async (delta) => {
      const z = await act('menu', 'zoom', { delta });
      zoomVal.textContent = `${z}%`;
    };
    const a = data.account || {};
    const acct =
      a.user
        ? h('div', { class: 'acct' }, h('span', { class: 'avatar' }, (a.user.displayName || a.user.username || '?')[0].toUpperCase()), h('div', { class: 'grow' }, h('div', { class: 't' }, a.user.displayName || a.user.username), h('div', { class: 's' }, a.phase === 'unlocked' ? `Synced with ${a.serverHost}` : `${a.serverHost} · locked`)))
        : h('button', { class: 'item', onclick: () => act('menu', 'command', { cmd: 'signin' }) }, h('span', { class: 'ic' }, icon('user', { size: 16 })), h('span', { class: 'grow t' }, 'Sign in to Ludworks to sync'));
    return h(
      'div',
      { class: 'popup menu' },
      h(
        'div',
        { class: 'list' },
        acct,
        h('div', { class: 'sep' }),
        item('New tab', 'newTab', `${mod}T`, 'plus'),
        item('New window', 'newWindow', `${mod}N`),
        item('New private window', 'privateWindow', `${mod}Shift+N`, 'shield'),
        h('div', { class: 'sep' }),
        item('Passwords and passkeys', 'passwords', null, 'key'),
        item('History', 'history', `${mod}H`, 'history'),
        item('Downloads', 'downloads', `${mod}J`, 'download'),
        item('Bookmarks', 'bookmarks', `${mod}Shift+O`, 'star'),
        h('div', { class: 'sep' }),
        h(
          'div',
          { class: 'zoom' },
          h('span', { class: 'grow' }, 'Zoom'),
          h('button', { class: 'icon-btn small', 'aria-label': 'Zoom out', onclick: () => zoom(-1) }, '−'),
          zoomVal,
          h('button', { class: 'icon-btn small', 'aria-label': 'Zoom in', onclick: () => zoom(1) }, '+'),
          h('button', { class: 'icon-btn small', 'aria-label': 'Full screen', title: 'Full screen (F11)', onclick: cmd('toggleFullscreen') }, icon('maximize', { size: 14 })),
        ),
        h('div', { class: 'sep' }),
        item('Print…', 'print', `${mod}P`),
        item('Find in page…', 'find', `${mod}F`, 'search'),
        item('Save page as…', 'savePage', `${mod}S`),
        item('Developer tools', 'devtools', `${mod}Shift+I`),
        h('div', { class: 'sep' }),
        item('Settings', 'settings', null, 'menu'),
        item('About Ludworks Browser', 'about', null, 'info'),
        h('div', { class: 'sep' }),
        item(window.lw.platform === 'darwin' ? 'Quit' : 'Exit', 'quit'),
      ),
    );
  },

  downloads(list, ctx) {
    const wrap = h('div', { class: 'popup' });
    const render = (items) => {
      clear(wrap);
      wrap.append(h('div', { class: 'head' }, h('h2', {}, 'Downloads')));
      const box = h('div', { class: 'list' });
      if (!items.length) box.append(h('div', { class: 'pad muted' }, 'Files you download appear here.'));
      for (const d of items.slice(0, 8)) {
        const progressing = d.state === 'progressing';
        const pct = d.total > 0 ? Math.round((d.received / d.total) * 100) : null;
        const sub = progressing ? `${fmtBytes(d.received)}${d.total ? ` of ${fmtBytes(d.total)}` : ''}${d.paused ? ' · paused' : ''}` : d.state === 'completed' ? (d.exists === false ? 'Deleted' : fmtBytes(d.total || d.received)) : d.state === 'cancelled' ? 'Cancelled' : 'Failed';
        const actions = h('span', { class: 'row' });
        const btn = (label, a, ic) => h('button', { class: 'icon-btn small', title: label, 'aria-label': label, onclick: async (e) => { e.stopPropagation(); render(await act('downloads', 'act', { id: d.id, act: a })); } }, icon(ic, { size: 15 }));
        if (progressing) {
          actions.append(btn(d.paused ? 'Resume' : 'Pause', d.paused ? 'resume' : 'pause', d.paused ? 'forward' : 'minimize'), btn('Cancel', 'cancel', 'close'));
        } else if (d.state === 'completed' && d.exists !== false) {
          actions.append(btn('Show in folder', 'show', 'folder'));
        }
        const row = h(
          'div',
          { class: 'dl' },
          h('span', { class: 'ic' }, icon('download', { size: 18 })),
          h('div', { class: 'grow', style: { minWidth: '0', flex: '1' } }, h('div', { class: 't ellipsis' }, d.filename), h('div', { class: 's muted' }, sub), d.dangerous && d.state === 'completed' ? h('div', { class: 'warn' }, 'This type of file can harm your device. Open it only if you trust its source.') : null, progressing ? h('div', { class: 'bar' }, h('i', { style: { width: `${pct || 3}%` } })) : null),
          actions,
        );
        if (d.state === 'completed' && d.exists !== false) row.addEventListener('dblclick', () => act('downloads', 'act', { id: d.id, act: 'open' }));
        box.append(row);
      }
      wrap.append(box, h('div', { class: 'foot' }, h('button', { class: 'btn', onclick: () => act('downloads', 'all', {}) }, 'All downloads')));
    };
    render(list);
    ctx.onData = render;
    return wrap;
  },

  'site-info'(data) {
    const secure = data.security === 'secure';
    const internal = data.security === 'internal';
    const title = internal ? 'Ludworks Browser page' : secure ? 'Connection is secure' : data.security === 'dangerous' ? 'Your connection is not private' : data.security === 'insecure' ? 'Connection is not secure' : 'Site information';
    const desc = internal
      ? 'This page is part of Ludworks Browser.'
      : secure
        ? 'Information you send to this site (passwords, card numbers) is private when it is sent.'
        : data.security === 'dangerous'
          ? 'You chose to continue despite a certificate error. Do not enter passwords or payment details.'
          : 'Do not enter sensitive information on this site: it could be read or changed in transit.';
    const perms = h('div', { class: 'stack' });
    const renderPerms = (list) => {
      clear(perms);
      if (!list.length) return;
      perms.append(h('div', { class: 'sub' }, 'Permissions'));
      for (const p of list) {
        const sel = h('select', { class: 'input' }, h('option', { value: 'allow' }, 'Allow'), h('option', { value: 'deny' }, 'Block'), h('option', { value: '' }, 'Ask (default)'));
        sel.value = p.decision;
        sel.addEventListener('change', async () => renderPerms(await act('site-info', 'set', { permission: p.permission, decision: sel.value || null })));
        perms.append(h('div', { class: 'perm-row' }, h('span', { class: 'grow' }, p.permission.replace(/^openExternal:/, 'Open ').replace(/-/g, ' ')), sel));
      }
    };
    renderPerms(data.permissions || []);
    return h(
      'div',
      { class: 'popup' },
      h('div', { class: 'head' }, icon(secure ? 'lock' : internal ? 'info' : 'warn', { size: 18 }), h('div', {}, h('h2', {}, data.host || title), h('div', { class: 'sub' }, title))),
      h('div', { class: 'pad stack' }, h('div', { class: 'muted' }, desc), perms),
      (data.permissions || []).length ? h('div', { class: 'foot' }, h('button', { class: 'btn', onclick: () => act('site-info', 'reset', {}) }, 'Reset permissions')) : null,
    );
  },

  star(data) {
    const b = data.bookmark;
    const name = h('input', { class: 'input', value: b.title || '', 'aria-label': 'Name' });
    const folder = h('select', { class: 'input', style: { width: '100%' }, 'aria-label': 'Folder' });
    for (const f of data.folders) folder.append(h('option', { value: f.id }, `${'   '.repeat(f.depth)}${f.title || 'Folder'}`));
    folder.value = b.parent;
    const save = () => act('star', 'save', { id: b.id, title: name.value, parent: folder.value });
    name.addEventListener('keydown', (e) => e.key === 'Enter' && save());
    setTimeout(() => {
      name.focus();
      name.select();
    }, 30);
    return h(
      'div',
      { class: 'popup' },
      h('div', { class: 'head' }, h('h2', {}, 'Bookmark added')),
      h('div', { class: 'pad stack' }, h('label', { class: 'field' }, h('span', {}, 'Name'), name), h('label', { class: 'field' }, h('span', {}, 'Folder'), folder)),
      h('div', { class: 'foot' }, h('button', { class: 'btn', onclick: () => act('star', 'more', {}) }, 'More…'), h('button', { class: 'btn danger', onclick: () => act('star', 'remove', { id: b.id }) }, 'Remove'), h('button', { class: 'btn primary', onclick: save }, 'Done')),
    );
  },

  // A bookmarks-bar folder (or the bar's » overflow): open, browse subfolders, drag to reorder or
  // to move into a subfolder / onto the bar, drop links and bar items in, right-click, Delete key.
  'bookmark-folder'(data, ctx) {
    const DND = 'application/x-ludworks-bookmark';
    const box = h('div', { class: 'popup' });
    const head = h('div', { class: 'head', style: { padding: '8px 10px 0' } });
    const list = h('div', { class: 'list', style: { maxHeight: '520px', overflow: 'auto', position: 'relative', minWidth: '240px' } });
    const line = h('div', { hidden: true, style: { position: 'absolute', left: '12px', right: '12px', height: '2px', borderRadius: '1px', background: 'var(--accent)', pointerEvents: 'none' } });
    const stack = []; // parent folders when browsing into subfolders
    let cur = { id: data.id, start: data.start || 0, title: data.title || '' };
    let items = data.items || [];
    let dragId = null;
    let hover = { id: null, t: null };
    const into = (n) => {
      stack.push(cur);
      cur = { id: n.id, start: 0, title: n.title };
      load();
    };
    const load = async () => render(await act('bookmark-folder', 'children', { id: cur.id, start: cur.start }));
    const render = (list2) => {
      items = list2 || [];
      clear(head);
      if (stack.length) {
        head.append(
          h('button', { class: 'icon-btn small', title: 'Back', 'aria-label': 'Back', onclick: () => { cur = stack.pop(); load(); } }, icon('back', { size: 15 })),
          h('h2', { class: 'grow t', style: { fontSize: '13px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, cur.title || 'Folder'),
        );
      }
      head.hidden = !stack.length;
      clear(list);
      if (!items.length) list.append(h('div', { class: 'pad muted', dataset: { empty: '1' } }, 'Empty folder — drop bookmarks here'));
      for (const n of items) {
        const row = h('button', { class: 'item', draggable: 'true', dataset: { id: n.id }, title: n.type === 'url' ? `${n.title || ''}\n${n.url}` : n.title }, h('span', { class: 'ic' }, n.type === 'folder' ? icon('folder', { size: 16 }) : faviconEl(n.icon, n.title || n.url, 16)), h('span', { class: 'grow t' }, n.title || n.url), n.type === 'folder' ? h('span', { class: 'kbd' }, icon('forward', { size: 14 })) : null);
        row.addEventListener('click', (e) => {
          if (n.type === 'folder') into(n);
          else act('bookmark-folder', 'open', { id: n.id, disposition: e.ctrlKey || e.metaKey ? 'background-tab' : e.shiftKey ? 'new-window' : 'current' });
        });
        row.addEventListener('auxclick', (e) => {
          if (e.button === 1 && n.type === 'url') act('bookmark-folder', 'open', { id: n.id, disposition: 'background-tab' });
        });
        row.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          e.stopPropagation();
          act('bookmark-folder', 'menu', { id: n.id, parent: cur.id });
        });
        row.addEventListener('keydown', async (e) => {
          if (e.key === 'Delete') {
            e.preventDefault();
            render(await act('bookmark-folder', 'remove', { id: n.id, folder: cur.id, start: cur.start }));
          } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            const sib = e.key === 'ArrowDown' ? row.nextElementSibling : row.previousElementSibling;
            if (sib && sib.focus) sib.focus();
          } else if (e.key === 'ArrowRight' && n.type === 'folder') into(n);
          else if ((e.key === 'ArrowLeft' || e.key === 'Backspace') && stack.length) {
            cur = stack.pop();
            load();
          }
        });
        row.addEventListener('dragstart', (e) => {
          dragId = n.id;
          e.dataTransfer.effectAllowed = 'copyMove';
          e.dataTransfer.setData(DND, JSON.stringify({ ids: [n.id] }));
          if (n.url) {
            e.dataTransfer.setData('text/uri-list', n.url);
            e.dataTransfer.setData('text/plain', n.url);
          }
          row.style.opacity = '0.5';
        });
        row.addEventListener('dragend', () => {
          dragId = null;
          row.style.opacity = '';
        });
        list.append(row);
      }
      list.append(line);
    };
    const target = (e) => {
      const types = [...e.dataTransfer.types];
      if (!types.includes(DND) && !types.includes('text/uri-list') && !types.includes('text/plain')) return null;
      const row = e.target.closest && e.target.closest('.item[data-id]');
      if (!row) {
        const rowsNow = list.querySelectorAll('.item[data-id]');
        const last = rowsNow[rowsNow.length - 1];
        return { parent: cur.id, before: null, y: last ? last.offsetTop + last.offsetHeight : 6 };
      }
      const n = items.find((x) => x.id === row.dataset.id);
      const f = (e.clientY - row.getBoundingClientRect().top) / row.offsetHeight;
      if (n.type === 'folder' && n.id !== dragId && f > 0.25 && f < 0.75) return { parent: n.id, before: null, row, n };
      const i = items.indexOf(n) + (f >= 0.5 ? 1 : 0);
      return { parent: cur.id, before: items[i] ? items[i].id : null, y: row.offsetTop + (f >= 0.5 ? row.offsetHeight : 0) };
    };
    const clearMarks = () => {
      line.hidden = true;
      for (const el of list.querySelectorAll('.item.sel')) el.classList.remove('sel');
    };
    list.addEventListener('dragover', (e) => {
      const t = target(e);
      clearMarks();
      if (!t) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = [...e.dataTransfer.types].includes(DND) ? 'move' : 'copy';
      if (t.row) {
        t.row.classList.add('sel');
        if (hover.id !== t.n.id) {
          clearTimeout(hover.t);
          hover = { id: t.n.id, t: setTimeout(() => into(t.n), 800) }; // hovering a subfolder opens it
        }
      } else {
        clearTimeout(hover.t);
        hover.id = null;
        line.hidden = false;
        line.style.top = `${t.y - 1}px`;
      }
    });
    list.addEventListener('dragleave', (e) => {
      if (!list.contains(e.relatedTarget)) {
        clearMarks();
        clearTimeout(hover.t);
        hover.id = null;
      }
    });
    list.addEventListener('drop', async (e) => {
      const t = target(e);
      clearMarks();
      clearTimeout(hover.t);
      hover.id = null;
      if (!t) return;
      e.preventDefault();
      const where = { parent: t.parent, before: t.before, folder: cur.id, start: cur.start };
      try {
        const own = e.dataTransfer.getData(DND);
        if (own) render(await act('bookmark-folder', 'move', { ...where, ids: JSON.parse(own).ids }));
        else {
          const url = (e.dataTransfer.getData('text/uri-list') || '').split(/\r?\n/).find((l) => l && !l.startsWith('#')) || e.dataTransfer.getData('text/plain').trim();
          const html = e.dataTransfer.getData('text/html');
          const a = html ? new DOMParser().parseFromString(html, 'text/html').querySelector('a[href]') : null;
          if (url) render(await act('bookmark-folder', 'drop', { ...where, url, title: e.dataTransfer.getData('application/x-ludworks-title') || (a ? a.textContent.trim() : '') }));
        }
      } catch {
        load();
      }
    });
    list.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      act('bookmark-folder', 'menu', { id: null, parent: cur.id });
    });
    ctx.onData = (d) => {
      if (d && d.refresh) load();
    };
    render(items);
    box.append(head, list);
    return box;
  },

  // Edit a bookmark / rename a folder / add a page or folder (from the bookmarks bar context menu).
  'bookmark-edit'(data) {
    const isFolder = data.type === 'folder';
    const name = h('input', { class: 'input', 'aria-label': 'Name', placeholder: isFolder ? 'Folder name' : 'Name', spellcheck: 'false' });
    name.value = data.title || (data.mode === 'add-folder' ? 'New folder' : '');
    const url = isFolder ? null : h('input', { class: 'input', 'aria-label': 'URL', placeholder: 'https://example.com', spellcheck: 'false' });
    if (url) url.value = data.url || '';
    const folder = h('select', { class: 'input', style: { width: '100%' }, 'aria-label': 'Folder' });
    let skipBelow = -1; // a folder cannot go into itself or below itself
    for (const f of data.folders || []) {
      if (skipBelow >= 0 && f.depth > skipBelow) continue;
      skipBelow = -1;
      if (isFolder && f.id === data.id) {
        skipBelow = f.depth;
        continue;
      }
      folder.append(h('option', { value: f.id }, `${' '.repeat(f.depth)}${f.title || 'Folder'}`));
    }
    folder.value = data.parent;
    const err = h('div', { class: 'notice warn', hidden: true });
    const save = async () => {
      const r = await act('bookmark-edit', 'save', { mode: data.mode, id: data.id, title: name.value, url: url ? url.value : undefined, parent: folder.value, before: folder.value === data.parent ? data.before : null });
      if (r && r.ok === false) {
        err.textContent = r.error;
        err.hidden = false;
      }
    };
    for (const el of [name, url]) if (el) el.addEventListener('keydown', (e) => e.key === 'Enter' && save());
    setTimeout(() => {
      const f = data.mode === 'add-page' && !data.url ? url : name;
      f.focus();
      f.select();
    }, 30);
    const heading = data.mode === 'add-folder' ? 'New folder' : data.mode === 'add-page' ? 'Add page' : isFolder ? 'Rename folder' : 'Edit bookmark';
    return h(
      'div',
      { class: 'popup' },
      h('div', { class: 'head' }, h('h2', {}, heading)),
      h('div', { class: 'pad stack' }, h('label', { class: 'field' }, h('span', {}, 'Name'), name), url ? h('label', { class: 'field' }, h('span', {}, 'URL'), url) : null, h('label', { class: 'field' }, h('span', {}, 'Folder'), folder), err),
      h('div', { class: 'foot' }, h('button', { class: 'btn', onclick: () => close('bookmark-edit') }, 'Cancel'), h('button', { class: 'btn primary', onclick: save }, 'Save')),
    );
  },

  permission(data) {
    const decide = (decision) => act('permission', 'decide', { id: data.id, decision });
    return h(
      'div',
      { class: 'popup perm' },
      h('div', { class: 'pad stack' }, h('div', {}, h('span', { class: 'host' }, data.host), ' wants to'), h('div', { class: 'row' }, icon(data.label.includes('camera') ? 'eye' : data.label.includes('location') ? 'globe' : 'info', { size: 18 }), h('span', {}, data.label + (data.detail ? ` (${data.detail})` : '')))),
      h('div', { class: 'foot' }, data.remembered ? h('button', { class: 'btn', onclick: () => decide('block') }, 'Block') : h('button', { class: 'btn', onclick: () => decide('block-once') }, 'Block'), data.remembered ? h('button', { class: 'btn', onclick: () => decide('allow-once') }, 'Allow this time') : null, h('button', { class: 'btn primary', onclick: () => decide(data.remembered ? 'allow' : 'allow-once') }, 'Allow')),
    );
  },

  'http-auth'(data) {
    const user = h('input', { class: 'input', autocomplete: 'username', 'aria-label': 'Username' });
    const pass = h('input', { class: 'input', type: 'password', autocomplete: 'current-password', 'aria-label': 'Password' });
    const answer = (v) => call('prompt.answer', { id: data.promptId, value: v });
    const form = h('form', { class: 'stack' }, h('label', { class: 'field' }, h('span', {}, 'Username'), user), h('label', { class: 'field' }, h('span', {}, 'Password'), pass));
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      answer({ username: user.value, password: pass.value });
    });
    setTimeout(() => user.focus(), 30);
    return h(
      'div',
      { class: 'popup' },
      h('div', { class: 'head' }, h('div', {}, h('h2', {}, 'Sign in'), h('div', { class: 'sub' }, `${data.isProxy ? 'Proxy ' : ''}${data.host}${data.realm ? ` — “${data.realm}”` : ''}`))),
      form,
      data.scheme === 'basic' && !data.isProxy ? h('div', { class: 'pad' }, h('div', { class: 'notice' }, 'Your connection to this site is only private if it uses HTTPS.')) : null,
      h('div', { class: 'foot' }, h('button', { class: 'btn', onclick: () => answer(null) }, 'Cancel'), h('button', { class: 'btn primary', onclick: () => answer({ username: user.value, password: pass.value }) }, 'Sign in')),
    );
  },

  'display-media'(data) {
    let chosen = null;
    let audio = false;
    const grid = h('div', { class: 'sources' });
    const share = h('button', { class: 'btn primary', disabled: true, onclick: () => call('prompt.answer', { id: data.promptId, value: { id: chosen, audio } }) }, 'Share');
    for (const s of data.sources) {
      const el = h('button', { class: 'source' }, s.thumb ? h('img', { src: s.thumb, alt: '' }) : h('div', { class: 'muted' }, 'No preview'), h('span', {}, s.name));
      el.addEventListener('click', () => {
        chosen = s.id;
        grid.querySelectorAll('.source').forEach((x) => x.classList.toggle('sel', x === el));
        share.disabled = false;
      });
      grid.append(el);
    }
    const audioBox = data.audio ? h('label', { class: 'check pad' }, h('input', { type: 'checkbox', onchange: (e) => { audio = e.target.checked; } }), 'Also share system audio') : null;
    return h(
      'div',
      { class: 'popup', style: { width: 'min(640px, calc(100vw - 32px))' } },
      h('div', { class: 'head' }, h('div', {}, h('h2', {}, 'Choose what to share'), h('div', { class: 'sub' }, `${data.host} will be able to see the contents of your screen`))),
      grid,
      audioBox,
      h('div', { class: 'foot' }, h('button', { class: 'btn', onclick: () => call('prompt.answer', { id: data.promptId, value: null }) }, 'Cancel'), share),
    );
  },

  'tab-search'(data) {
    const input = h('input', { class: 'input', placeholder: 'Search tabs', 'aria-label': 'Search tabs' });
    const list = h('div', { class: 'list' });
    const render = () => {
      clear(list);
      const q = input.value.toLowerCase();
      for (const t of data.tabs.filter((x) => !q || (x.title || '').toLowerCase().includes(q) || (x.url || '').toLowerCase().includes(q)).slice(0, 12)) {
        list.append(h('button', { class: 'item', onclick: () => act('tab-search', 'open', { id: t.id }) }, h('span', { class: 'grow' }, h('div', { class: 't' }, t.title || t.url), h('div', { class: 's' }, t.url))));
      }
    };
    input.addEventListener('input', render);
    render();
    setTimeout(() => input.focus(), 30);
    return h('div', { class: 'popup' }, h('div', { class: 'pad' }, input), list);
  },

  ...ACCOUNT_POPUPS,
  ...BLOCKER_POPUPS,
  ...PRIVACY_POPUPS,
};

// ------------------------------------------------------------------------------------- wiring
const ctx = { select: null, onData: null };

window.lw.on('popup', (p) => {
  ro.disconnect();
  clear(rootEl);
  ctx.select = null;
  ctx.onData = null;
  if (!p) {
    current = null;
    return;
  }
  current = { kind: p.kind, seq: p.seq, data: p.data, modal: !!p.modal };
  html.dataset.theme = p.theme;
  rootEl.className = p.modal ? 'modal' : '';
  rootEl.style.width = p.modal ? '' : `${p.width + 36}px`; // card width + #root side padding
  const build = POPUPS[p.kind];
  if (!build) return;
  const el = build(p.data, ctx, { act: (a, d) => act(p.kind, a, d), close: () => close(p.kind), call });
  if (p.modal) {
    el.addEventListener('mousedown', (e) => e.stopPropagation());
    rootEl.addEventListener('mousedown', () => p.data && p.data.promptId && call('prompt.answer', { id: p.data.promptId, value: null }), { once: true });
  }
  rootEl.append(el);
  ro.observe(el);
  reportSize();
});

window.lw.on('popup-data', ({ kind, data }) => {
  if (!current || current.kind !== kind) return;
  if (ctx.onData) ctx.onData(data);
  else if (kind === 'suggestions') {
    clear(rootEl);
    const el = POPUPS.suggestions(data, ctx);
    rootEl.append(el);
    ro.observe(el);
  }
  reportSize();
});

window.lw.on('popup-select', (i) => ctx.select && ctx.select(i));
window.lw.on('theme', (t) => {
  html.dataset.theme = t;
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && current) {
    if (current.data && current.data.promptId) call('prompt.answer', { id: current.data.promptId, value: null });
    else close(current.kind);
  }
});
