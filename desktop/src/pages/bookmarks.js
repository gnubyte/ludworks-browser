// Bookmarks manager: folders, rename, move, delete, import/export.
import { h, clear, applyTheme, sideNav, letterIcon } from './ui.js';

const app = document.getElementById('app');
const main = h('main', { class: 'main' });
app.append(sideNav('bookmarks'), main);
const call = (cmd, args = {}) => window.lwPage.call(cmd, args);
let tree = null;
let current = 'toolbar';
let filter = '';

function findNode(id, nodes = Object.values(tree)) {
  for (const n of nodes) {
    if (n.id === id) return n;
    if (n.children) {
      const f = findNode(id, n.children);
      if (f) return f;
    }
  }
  return null;
}

function folders(nodes = Object.values(tree), depth = 0, out = []) {
  for (const n of nodes) {
    if (n.type !== 'folder') continue;
    out.push({ id: n.id, title: n.title, depth });
    folders(n.children || [], depth + 1, out);
  }
  return out;
}

async function load() {
  applyTheme(await call('theme'));
  tree = await call('bookmarks.tree');
  render();
}

function render() {
  clear(main);
  const search = h('input', { class: 'input', type: 'search', placeholder: 'Search bookmarks', value: filter, style: { maxWidth: '320px' } });
  search.addEventListener('input', () => {
    filter = search.value;
    renderList(listBox);
  });
  const folderSel = h('select', { class: 'input', style: { width: '260px' } }, ...folders().map((f) => h('option', { value: f.id }, `${'   '.repeat(f.depth)}${f.title || 'Folder'}`)));
  folderSel.value = current;
  folderSel.addEventListener('change', () => {
    current = folderSel.value;
    render();
  });
  const listBox = h('div', { class: 'card list' });
  main.append(
    h('h1', {}, 'Bookmarks'),
    h(
      'div',
      { class: 'toolbar' },
      folderSel,
      search,
      h('span', { class: 'grow' }),
      h('button', { class: 'btn', onclick: async () => { const t = window.prompt('Folder name'); if (t) { await call('bookmarks.add', { parent: current, type: 'folder', title: t }); load(); } } }, 'New folder'),
      h('button', { class: 'btn', onclick: async () => { const r = await call('import.bookmarks.file'); if (r.ok && r.value) load(); } }, 'Import…'),
      h('button', { class: 'btn', onclick: () => call('export.bookmarks') }, 'Export…'),
    ),
    listBox,
  );
  renderList(listBox);
}

function renderList(box) {
  clear(box);
  const q = filter.trim().toLowerCase();
  let nodes;
  if (q) {
    nodes = [];
    const walk = (list) => list.forEach((n) => { if (n.type === 'url' && ((n.title || '').toLowerCase().includes(q) || (n.url || '').toLowerCase().includes(q))) nodes.push(n); if (n.children) walk(n.children); });
    walk(Object.values(tree));
  } else nodes = (findNode(current) || { children: [] }).children || [];
  if (!nodes.length) box.append(h('div', { class: 'empty' }, q ? 'No matches' : 'This folder is empty.'));
  for (const n of nodes) {
    const moveSel = h('select', { class: 'input', style: { width: '170px', height: '30px' }, title: 'Move to folder' }, h('option', { value: '' }, 'Move to…'), ...folders().filter((f) => f.id !== n.id).map((f) => h('option', { value: f.id }, `${'  '.repeat(f.depth)}${f.title}`)));
    moveSel.addEventListener('change', async () => {
      if (moveSel.value) await call('bookmarks.move', { id: n.id, parent: moveSel.value });
      load();
    });
    const row = h(
      'div',
      { class: 'row' },
      n.type === 'folder' ? h('span', { class: 'favicon letter', style: { width: '22px', height: '22px', fontSize: '12px' } }, '▸') : letterIcon(n.url, 22),
      h('div', { class: 'grow' }, h('div', { class: 't' }, n.title || n.url || '(untitled)'), n.url ? h('div', { class: 's' }, n.url) : h('div', { class: 's' }, `${(n.children || []).length} item(s)`)),
      moveSel,
      h('button', { class: 'btn small', onclick: async () => { const t = window.prompt('Name', n.title || ''); if (t !== null) { const u = n.type === 'url' ? window.prompt('URL', n.url) : undefined; await call('bookmarks.update', { id: n.id, title: t, url: u === null ? undefined : u }); load(); } } }, 'Edit'),
      h('button', { class: 'btn small danger', onclick: async () => { if (window.confirm(n.type === 'folder' ? `Delete folder “${n.title}” and everything in it?` : `Delete “${n.title}”?`)) { await call('bookmarks.remove', { id: n.id }); load(); } } }, 'Delete'),
    );
    row.addEventListener('dblclick', () => {
      if (n.type === 'folder') {
        current = n.id;
        render();
      } else call('bookmarks.open', { url: n.url, newTab: true });
    });
    box.append(row);
  }
}

load();
