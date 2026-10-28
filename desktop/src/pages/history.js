// History: newest first, grouped by day, search, delete entries, clear all, tabs from other devices.
import { h, clear, applyTheme, sideNav, fmtDay, fmtTime, letterIcon } from './ui.js';

const app = document.getElementById('app');
const main = h('main', { class: 'main' });
app.append(sideNav('history'), main);
const call = (cmd, args = {}) => window.lwPage.call(cmd, args);
let text = '';
let rows = [];

async function load(more = false) {
  const before = more && rows.length ? rows[rows.length - 1].last_visit : null;
  const page = await call('history.list', { text, before });
  rows = more ? [...rows, ...page] : page;
  render(page.length === 150);
}

function render(hasMore) {
  clear(main);
  const search = h('input', { class: 'input', type: 'search', placeholder: 'Search history', value: text, style: { maxWidth: '380px' } });
  let t = null;
  search.addEventListener('input', () => {
    clearTimeout(t);
    t = setTimeout(() => {
      text = search.value;
      load();
    }, 200);
  });
  main.append(
    h('h1', {}, 'History'),
    h('div', { class: 'toolbar' }, search, h('span', { class: 'grow' }), h('button', { class: 'btn danger', onclick: async () => { if (window.confirm('Delete all browsing history? It is also removed from your other synced devices.')) { await call('history.clear'); load(); } } }, 'Clear history')),
  );
  let day = '';
  let card = null;
  if (!rows.length) main.append(h('div', { class: 'card empty' }, text ? 'No matches' : 'Pages you visit appear here.'));
  for (const r of rows) {
    const d = fmtDay(r.last_visit);
    if (d !== day) {
      day = d;
      main.append(h('h2', {}, d));
      card = h('div', { class: 'card list' });
      main.append(card);
    }
    const row = h(
      'div',
      { class: 'row' },
      h('span', { class: 'faint', style: { width: '70px', fontSize: '12.5px' } }, fmtTime(r.last_visit)),
      letterIcon(r.url, 20),
      h('div', { class: 'grow' }, h('a', { class: 't', href: r.url, style: { display: 'block', color: 'var(--text)' } }, r.title || r.url), h('div', { class: 's' }, r.url)),
      h('button', { class: 'btn small', title: 'Remove from history', onclick: async () => { await call('history.remove', { urls: [r.url] }); rows = rows.filter((x) => x.url !== r.url); row.remove(); } }, 'Remove'),
    );
    card.append(row);
  }
  if (hasMore) main.append(h('div', { style: { textAlign: 'center', marginTop: '16px' } }, h('button', { class: 'btn', onclick: () => load(true) }, 'Show more')));
}

(async () => {
  const theme = await call('theme');
  applyTheme(theme);
  load();
})();
