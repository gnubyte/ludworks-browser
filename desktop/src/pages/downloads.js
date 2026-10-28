// Downloads list.
import { h, clear, applyTheme, sideNav, fmtBytes } from './ui.js';

const app = document.getElementById('app');
const main = h('main', { class: 'main' });
app.append(sideNav('downloads'), main);
const call = (cmd, args = {}) => window.lwPage.call(cmd, args);

function render(list) {
  clear(main);
  main.append(h('h1', {}, 'Downloads'), h('div', { class: 'toolbar' }, h('span', { class: 'grow' }), h('button', { class: 'btn', onclick: async () => render(await call('downloads.clear')) }, 'Clear list')));
  const card = h('div', { class: 'card list' });
  main.append(card);
  if (!list.length) card.append(h('div', { class: 'empty' }, 'Files you download appear here.'));
  for (const d of list) {
    const act = (a, label, cls = 'btn small') => h('button', { class: cls, onclick: async () => render(await call('downloads.act', { id: d.id, act: a })) }, label);
    const status = d.state === 'progressing' ? `${fmtBytes(d.received)} of ${fmtBytes(d.total)}${d.paused ? ' · paused' : ''}` : d.state === 'completed' ? (d.exists === false ? 'Deleted' : fmtBytes(d.total || d.received)) : d.state === 'cancelled' ? 'Cancelled' : 'Failed';
    card.append(
      h(
        'div',
        { class: 'row' },
        h('div', { class: 'grow' }, h('div', { class: 't' }, d.filename), h('div', { class: 's' }, `${status} · ${d.url}`), d.dangerous && d.state === 'completed' ? h('div', { class: 's', style: { color: 'var(--danger)' } }, 'This type of file can harm your computer. Open it only if you trust where it came from.') : null),
        d.state === 'progressing' ? [act(d.paused ? 'resume' : 'pause', d.paused ? 'Resume' : 'Pause'), act('cancel', 'Cancel')] : null,
        d.state === 'completed' && d.exists !== false ? [act('open', 'Open'), act('show', 'Show in folder')] : null,
        d.state !== 'progressing' ? act('remove', 'Remove') : null,
      ),
    );
  }
}

(async () => {
  applyTheme(await call('theme'));
  render(await call('downloads.list'));
  setInterval(async () => render(await call('downloads.list')), 2000);
})();
