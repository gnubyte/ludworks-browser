// Content blocker popup (toolbar shield button). Rendered by overlay.js; actions go to the blocker
// feature (src/main/blocker/blocker.js), which answers with fresh popup data. Live counters arrive
// as popup-data while the popup is open.
import { icon, h, clear } from './icons.js';

// Popup styles live next to this module (the overlay's CSP allows same-origin stylesheets only).
if (!document.querySelector('link[data-blocker]')) {
  document.head.append(h('link', { rel: 'stylesheet', href: 'overlay-blocker.css', 'data-blocker': '1' }));
}

const fmt = (n) => Number(n || 0).toLocaleString();
const plural = (n, one, many = `${one}s`) => `${fmt(n)} ${n === 1 ? one : many}`;

export const POPUPS = {
  blocker(data, ctx, { act }) {
    const box = h('div', { class: 'popup blocker' });
    let showAll = false;
    let last = data;
    const run = async (action, d) => {
      const r = await act(action, d || {});
      if (r) render(r);
    };
    const render = (d) => {
      last = d;
      clear(box);
      box.append(
        h(
          'div',
          { class: 'head' },
          h('span', { class: `bk-ic ${d.siteOn ? 'on' : ''}` }, icon('shield', { size: 18 })),
          h('div', { class: 'grow' }, h('h2', {}, 'Content blocker'), h('div', { class: 'sub ellipsis' }, d.web ? d.host : 'No website in this tab')),
        ),
      );
      if (!d.enabled) {
        box.append(h('div', { class: 'pad stack' }, h('div', { class: 'notice' }, 'Content blocking is turned off everywhere.'), h('div', { class: 'row end' }, h('button', { class: 'btn primary', onclick: () => run('enabled', { on: true }) }, 'Turn on'))));
      } else if (d.isServer) {
        box.append(h('div', { class: 'pad' }, h('div', { class: 'notice' }, 'Your Ludworks server is never filtered.')));
      } else if (d.web) {
        const sw = h('input', { type: 'checkbox', checked: d.siteOn, 'aria-label': 'Blocking on this site' });
        sw.addEventListener('change', () => run('site', { on: sw.checked }));
        box.append(
          h(
            'label',
            { class: 'bk-site' },
            h('span', { class: 'grow' }, h('div', { class: 't' }, 'Blocking on this site'), h('div', { class: 's' }, d.siteOn ? 'Ads, trackers and malware are blocked' : 'Everything on this site is allowed')),
            h('span', { class: 'bk-switch' }, sw, h('span', {})),
          ),
        );
        if (d.needsReload) box.append(h('div', { class: 'pad bk-tight' }, h('div', { class: 'notice bk-reload' }, h('span', { class: 'grow' }, 'Reload the page to apply.'), h('button', { class: 'btn small primary', onclick: () => run('reload') }, 'Reload'))));
        if (d.mainBlocked && d.siteOn) box.append(h('div', { class: 'pad bk-tight' }, h('div', { class: 'notice warn' }, 'This page itself was blocked by a filter list (known ad, tracking or malware site). Switch blocking off for this site to open it anyway.')));
      } else {
        box.append(h('div', { class: 'pad muted' }, 'Open a website to see what is blocked on it.'));
      }

      // counters
      const cos = d.cosmetic;
      const cosText = cos ? [cos.hide + cos.generic ? plural(cos.hide + cos.generic, 'hiding rule') : null, cos.scriptlets ? plural(cos.scriptlets, 'scriptlet') : null, cos.hidden ? `${fmt(cos.hidden)} hidden by procedural rules` : null].filter(Boolean).join(' · ') : '';
      box.append(
        h(
          'div',
          { class: 'bk-stats' },
          h('div', { class: 'bk-stat' }, h('div', { class: 'n' }, fmt(d.blocked)), h('div', { class: 's' }, 'blocked on this page')),
          h('div', { class: 'bk-stat' }, h('div', { class: 'n' }, fmt(d.total)), h('div', { class: 's' }, `in total since ${new Date(d.since).toLocaleDateString()}`)),
        ),
      );
      if (cosText) box.append(h('div', { class: 'bk-cos' }, `Cosmetic: ${cosText} applied`));
      if (!d.ready) box.append(h('div', { class: 'pad bk-tight' }, h('div', { class: 'notice' }, d.busy ? 'Downloading and preparing filter lists…' : 'No filter lists yet — check your connection or the settings.')));

      // what was blocked
      if (d.domains.length) {
        const list = h('div', { class: 'list bk-list' });
        const rows = showAll ? d.domains : d.domains.slice(0, 6);
        for (const x of rows) {
          list.append(
            h(
              'div',
              { class: 'item bk-row', title: `${x.hosts.join(', ')}` },
              h('span', { class: 'grow' }, h('div', { class: 't' }, x.domain), h('div', { class: 's' }, x.types.join(', '))),
              h('span', { class: 'bk-count' }, fmt(x.count)),
            ),
          );
        }
        box.append(h('div', { class: 'bk-label' }, `Blocked on this page · ${plural(d.domains.length, 'domain')}`), list);
        if (d.domains.length > 6) box.append(h('button', { class: 'bk-more', onclick: () => ((showAll = !showAll), render(last)) }, showAll ? 'Show fewer' : `Show all ${d.domains.length}`));
      }

      box.append(
        h(
          'div',
          { class: 'foot bk-foot' },
          d.enabled && d.web && d.siteOn ? h('button', { class: 'btn', title: 'Click an element on the page to hide it on this site', onclick: () => run('pick') }, icon('eye', { size: 15 }), 'Hide an element…') : null,
          h('span', { class: 'grow' }),
          h('button', { class: 'btn', onclick: () => run('settings') }, 'Settings'),
        ),
      );
    };
    ctx.onData = (d) => render(d);
    render(data);
    return box;
  },
};
