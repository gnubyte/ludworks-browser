// Privacy popups (tracking cookies, clear history). Rendered by overlay.js; actions go to the privacy
// feature (src/main/privacy/privacy.js), which answers with fresh popup data.
import { icon, h, clear } from './icons.js';

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

export const POPUPS = {
  trackers(data, _ctx, { act }) {
    const box = h('div', { class: 'popup privacy' });
    const render = (d) => {
      clear(box);
      const following = d.trackers.filter((t) => t.following);
      box.append(
        h(
          'div',
          { class: 'head' },
          h('span', { class: 'pv-ic' }, icon('cookie', { size: 18 })),
          h('div', { class: 'grow' }, h('h2', {}, 'Tracking cookies'), h('div', { class: 'sub' }, d.site ? `On ${d.site}${d.private ? ' (private window)' : ''}` : 'No website in this tab')),
        ),
      );
      const list = h('div', { class: 'list pv-list' });
      if (!d.trackers.length) list.append(h('div', { class: 'pad muted' }, d.site ? 'No other site used cookies on this page.' : 'Open a website to see who tracks you there.'));
      for (const t of d.trackers) {
        const where = t.following ? `Follows you across ${plural(t.sites, 'site')}${t.sample.length ? `: ${t.sample.join(', ')}${t.sites - 1 > t.sample.length ? '…' : ''}` : ''}` : 'Only seen on this site so far';
        const row = h(
          'div',
          { class: `item pv-row ${t.following ? 'following' : ''}` },
          h('span', { class: 'ic' }, h('span', { class: `pv-dot ${t.following ? 'warn' : ''}` })),
          h('span', { class: 'grow' }, h('div', { class: 't' }, t.domain), h('div', { class: 's' }, where), t.blocked ? h('div', { class: 's pv-blocked' }, `${plural(t.blocked, 'cookie request')} blocked`) : null),
          h('button', { class: 'icon-btn small', title: `Delete ${t.domain} cookies`, 'aria-label': `Delete ${t.domain} cookies`, onclick: async () => render(await act('wipe', { domains: [t.domain] })) }, icon('close', { size: 14 })),
        );
        list.append(row);
      }
      box.append(list);
      if (d.wiped) box.append(h('div', { class: 'pad pv-done' }, h('div', { class: 'notice' }, `Deleted ${plural(d.wiped.cookies, 'cookie')} from ${plural(d.wiped.domains, 'site')}.`)));
      const toggle = h('input', { type: 'checkbox', checked: !!d.blocking });
      toggle.addEventListener('change', async () => render(await act('block', { on: toggle.checked })));
      box.append(
        h(
          'div',
          { class: 'pad stack pv-foot' },
          h('label', { class: 'check' }, toggle, h('span', { class: 'grow' }, 'Block all third-party cookies'), d.trackers.length ? h('button', { class: 'btn small', onclick: () => act('reload', {}) }, 'Reload page') : null),
          h(
            'div',
            { class: 'row end' },
            h('button', { class: 'btn', onclick: () => act('settings', {}) }, 'Settings'),
            d.followingTotal ? h('button', { class: 'btn', title: 'Every site seen following you, on any website', onclick: async () => render(await act('wipe-all', {})) }, `Wipe all ${d.followingTotal}`) : null,
            h('button', { class: 'btn primary', disabled: !d.trackers.length, onclick: async () => render(await act('wipe', { domains: (following.length ? following : d.trackers).map((t) => t.domain) })) }, following.length ? 'Wipe trackers here' : 'Wipe these cookies'),
          ),
        ),
      );
    };
    render(data);
    return box;
  },

  'clear-history'(data, _ctx, { act }) {
    const box = h('div', { class: 'popup privacy' });
    const opts = { history: true, downloads: false, cache: false, cookies: false };
    let armed = null; // range id waiting for a confirming second click (only "All time")
    const render = (last) => {
      clear(box);
      box.append(h('div', { class: 'head' }, h('span', { class: 'pv-ic' }, icon('eraser', { size: 18 })), h('div', { class: 'grow' }, h('h2', {}, 'Clear history'), h('div', { class: 'sub' }, 'Pick how far back to delete'))));
      const list = h('div', { class: 'list' });
      for (const r of data.ranges) {
        const confirming = armed === r.id;
        const btn = h('button', { class: `item pv-range ${confirming ? 'sel' : ''}` }, h('span', { class: 'ic' }, icon(r.id === 'all' ? 'warn' : 'history', { size: 16 })), h('span', { class: 'grow t' }, confirming ? 'Click again to delete everything' : r.label));
        btn.addEventListener('click', async () => {
          if (r.id === 'all' && armed !== 'all') {
            armed = 'all';
            render(last);
            return;
          }
          armed = null;
          btn.disabled = true;
          const res = await act('clear', { range: r.id, what: opts });
          render(res && res.last);
        });
        list.append(btn);
      }
      box.append(list);
      const check = (key, label) => {
        const c = h('input', { type: 'checkbox', checked: opts[key] });
        c.addEventListener('change', () => {
          opts[key] = c.checked;
        });
        return h('label', { class: 'check' }, c, h('span', {}, label));
      };
      box.append(h('div', { class: 'pad stack pv-foot' }, check('history', 'Browsing history'), check('downloads', 'Download list (files stay)'), check('cache', 'Cached images and files'), check('cookies', 'Cookies and site data (all time — signs you out)')));
      if (last) box.append(h('div', { class: 'pad pv-done' }, h('div', { class: 'notice' }, `${last.label}: cleared ${last.done.join(', ') || 'nothing'} — ${new Date(last.at).toLocaleTimeString()}`)));
    };
    render(data.last && Date.now() - data.last.at < 10 * 60e3 ? data.last : null);
    return box;
  },
};
