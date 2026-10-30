// Settings → Extensions: how many are installed, a link to ludworks://extensions and to the store.
import { h, clear, toggle } from './ui.js';

/** @param {(cmd: string, args?: any) => Promise<any>} call */
export function extensionsSection(call) {
  const head = h('h2', { id: 'extensions' }, 'Extensions');
  const card = h('div', { class: 'card' }, h('div', { class: 'setting muted' }, 'Loading…'));
  const render = (s) => {
    clear(card);
    card.append(
      h(
        'div',
        { class: 'setting' },
        h('div', { class: 'grow' }, h('div', {}, s.count ? `${s.count} extension${s.count === 1 ? '' : 's'} installed (${s.enabled} on)` : 'No extensions installed'), h('div', { class: 'd' }, 'Add Chrome extensions from the Chrome Web Store. They run in normal windows, not in private windows.')),
        h('a', { class: 'btn', href: 'ludworks://extensions/' }, 'Manage extensions'),
      ),
      h('div', { class: 'setting' }, h('div', { class: 'grow' }, h('div', {}, 'Update extensions automatically'), h('div', { class: 'd' }, 'Checks the Chrome Web Store once a day. Updates that ask for more permissions wait for your approval.')), toggle(s.autoUpdate, async (on) => { await call('extensions.auto-update', { on }); refresh(); }, 'Update extensions automatically')),
    );
  };
  const refresh = () =>
    call('extensions.summary').then(render, (e) => {
      clear(card);
      card.append(h('div', { class: 'setting muted' }, `Extensions unavailable: ${e.message}`));
    });
  refresh();
  window.lwPage.on('page-event', (ev) => {
    if (ev && ev.type === 'extensions') refresh();
  });
  return [head, card];
}
