// Extensions popups, rendered by overlay.js:
//   extensions     the puzzle menu: installed extensions (click = its action), pin to toolbar, manage,
//                  "Add to Ludworks Browser" on a Chrome Web Store item page
//   ext-install    modal permission prompt before an install / an update that asks for more / a
//                  chrome.permissions.request — answered with prompt.answer {ok: true} or null
import { icon, h, clear } from './icons.js';

if (!document.querySelector('link[data-extensions]')) {
  document.head.append(h('link', { rel: 'stylesheet', href: 'overlay-extensions.css', 'data-extensions': '1' }));
}

const NS = 'http://www.w3.org/2000/svg';
function pinIcon(on) {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '16');
  svg.setAttribute('height', '16');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', 'icon');
  for (const d of ['M9 4h6l-1 6 4 4H6l4-4z', 'M12 14v6']) {
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('d', d);
    p.setAttribute('fill', on && d.startsWith('M9') ? 'currentColor' : 'none');
    p.setAttribute('stroke', 'currentColor');
    p.setAttribute('stroke-width', '1.8');
    p.setAttribute('stroke-linejoin', 'round');
    p.setAttribute('stroke-linecap', 'round');
    svg.append(p);
  }
  return svg;
}

function extIcon(src, size = 20) {
  if (src && /^data:image\//.test(src)) return h('img', { class: 'ex-img', src, width: size, height: size, alt: '', draggable: 'false' });
  return h('span', { class: 'ex-img ex-ph', style: { width: `${size}px`, height: `${size}px` } }, icon('puzzle', { size: Math.round(size * 0.8) }));
}

export const POPUPS = {
  extensions(data, ctx, { act }) {
    const box = h('div', { class: 'popup ex-menu' });
    const run = async (action, d) => {
      const r = await act(action, d || {});
      if (r) render(r);
    };
    const render = (d) => {
      clear(box);
      box.append(h('div', { class: 'head' }, h('h2', { class: 'grow' }, 'Extensions')));
      if (d.added) {
        const it = d.items.find((x) => x.id === d.added);
        if (it) {
          box.append(
            h(
              'div',
              { class: 'ex-added' },
              extIcon(it.icon, 28),
              h('div', { class: 'grow' }, h('div', { class: 't' }, `${it.name} was added`), h('div', { class: 's' }, it.pinned ? 'Its button is on the toolbar.' : 'Pin it to keep its button on the toolbar.')),
              it.pinned ? null : h('button', { class: 'btn small primary', onclick: () => run('pin', { id: it.id, on: true }) }, 'Pin'),
            ),
          );
        }
      }
      if (d.store && !d.store.installed) {
        box.append(
          h(
            'div',
            { class: 'ex-store' },
            h('div', { class: 'grow' }, h('div', { class: 't' }, 'Chrome Web Store'), h('div', { class: 's' }, d.store.busy ? 'Downloading…' : 'Add the extension on this page to Ludworks Browser.')),
            h('button', { class: 'btn small primary', disabled: d.store.busy, onclick: () => act('install', {}) }, 'Add to Ludworks Browser'),
          ),
        );
      }
      const list = h('div', { class: 'list ex-list' });
      if (!d.items.length) list.append(h('div', { class: 'pad muted' }, 'No extensions yet. Find some in the Chrome Web Store.'));
      for (const it of d.items) {
        const sub = !it.enabled ? (it.error ? 'Could not be loaded' : 'Turned off') : it.access === 'site' && d.host ? `Can read and change ${d.host}` : '';
        const row = h(
          'div',
          { class: `item ex-row ${it.enabled ? '' : 'off'}`, title: it.name },
          extIcon(it.icon),
          h('span', { class: 'grow' }, h('div', { class: 't' }, it.name), sub ? h('div', { class: 's' }, sub) : null),
        );
        if (it.enabled && (it.hasPopup || it.hasAction)) {
          row.classList.add('clickable');
          row.addEventListener('click', (e) => {
            if (e.target.closest('button')) return;
            act('click', { id: it.id });
          });
        }
        if (it.hasOptions && it.enabled) row.append(h('button', { class: 'icon-btn small', title: 'Options', 'aria-label': `Options of ${it.name}`, onclick: () => act('options', { id: it.id }) }, icon('menu', { size: 15 })));
        row.append(h('button', { class: `icon-btn small ex-pin ${it.pinned ? 'on' : ''}`, title: it.pinned ? 'Unpin from toolbar' : 'Pin to toolbar', 'aria-label': it.pinned ? `Unpin ${it.name}` : `Pin ${it.name}`, 'aria-pressed': it.pinned ? 'true' : 'false', onclick: () => run('pin', { id: it.id, on: !it.pinned }) }, pinIcon(it.pinned)));
        list.append(row);
      }
      box.append(list, h('div', { class: 'foot ex-foot' }, h('button', { class: 'btn', onclick: () => act('store', {}) }, 'Find extensions'), h('span', { class: 'grow' }), h('button', { class: 'btn', onclick: () => act('manage', {}) }, icon('puzzle', { size: 15 }), 'Manage extensions')));
    };
    ctx.onData = render;
    render(data);
    return box;
  },

  'ext-install'(data, _ctx, { call }) {
    const answer = (ok) => call('prompt.answer', { id: data.promptId, value: ok ? { ok: true } : null });
    const title = data.kind === 'permissions' ? `“${data.name}” wants more access` : data.kind === 'update' ? `Update “${data.name}”?` : `Add “${data.name}”?`;
    const lead = data.kind === 'permissions' ? 'It is asking to:' : 'It can:';
    const okLabel = data.kind === 'permissions' ? 'Allow' : data.kind === 'update' ? 'Update' : 'Add extension';
    const list = h('ul', { class: 'ex-perms' });
    for (const x of data.items || []) list.append(h('li', {}, x));
    const body = h('div', { class: 'pad stack' });
    if ((data.items || []).length) body.append(h('div', { class: 'ex-lead' }, lead), list);
    else body.append(h('div', { class: 'muted' }, 'It does not need any special permissions.'));
    if ((data.unsupported || []).length) body.append(h('div', { class: 'notice warn ex-warn' }, h('b', {}, 'May not fully work in Ludworks Browser. '), `Not available here: ${data.unsupported.join('; ')}.`));
    if (data.kind !== 'permissions' && data.store === false) body.append(h('div', { class: 'notice' }, 'This package does not come from the Chrome Web Store. Only add extensions you trust.'));
    const ok = h('button', { class: 'btn primary', onclick: () => answer(true) }, okLabel);
    setTimeout(() => ok.focus(), 30);
    return h(
      'div',
      { class: 'popup ex-install', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      h('div', { class: 'head' }, extIcon(data.icon, 36), h('div', { class: 'grow' }, h('h2', {}, title), data.version ? h('div', { class: 'sub' }, `Version ${data.version}`) : null)),
      body,
      h('div', { class: 'foot' }, h('button', { class: 'btn', onclick: () => answer(false) }, 'Cancel'), ok),
    );
  },
};
