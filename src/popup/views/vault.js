// Main vault list (This site / All / Favorites, search) and item detail.

import { parseHttpUrl, siteName, hostLabel } from '../../lib/url-match.js';
import { searchItems, CARD_FIELDS, IDENTITY_FIELDS, cloneJson } from '../../lib/item-model.js';
import { generateTotp, formatTotp } from '../../lib/totp.js';
import { h, clear, icon, iconButton, button, avatar, confirmDialog, withBusy, formatDate } from '../ui.js';
import { requestServerPermission } from '../rpc.js';
import { editView } from './edit.js';
import { generatorView } from './generator.js';
import { settingsView } from './settings.js';

const PAGE = 100;
const TYPE_LABELS = { login: 'Login', note: 'Secure note', card: 'Card', identity: 'Identity' };
const MATCH_LABELS = { domain: 'Domain', host: 'Host', starts_with: 'Starts with', exact: 'Exact', regex: 'Regex', never: 'Never' };
const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * Fill an item into the active tab; confirms before filling an http://localhost page, and before filling
 * a login that was saved for another host of the same site (the background refuses both otherwise).
 * @param {any} app
 * @param {string} id
 */
export async function fillItem(app, id, allowInsecure = false, allowOtherHost = false) {
  try {
    await app.call('fill.item', { id, allowInsecure, allowOtherHost });
    window.close();
  } catch (e) {
    if (e.code === 'insecure_page' && e.details && e.details.localhost && !allowInsecure) {
      const ok = await confirmDialog({
        title: 'Fill on a non-HTTPS page?',
        message: 'This local page uses plain HTTP, so the password is not protected in transit. Fill anyway?',
        confirmLabel: 'Fill anyway',
        danger: true,
      });
      if (ok) await fillItem(app, id, true, allowOtherHost);
      return;
    }
    if (e.code === 'other_host' && !allowOtherHost) {
      const saved = e.details && Array.isArray(e.details.savedFor) && e.details.savedFor.length ? e.details.savedFor.join(', ') : 'another host';
      const page = (e.details && e.details.pageHost) || hostLabel(app.webUrl() || '') || 'this page';
      const ok = await confirmDialog({
        title: 'Fill on a different host?',
        message: `This login was saved for ${saved}, but this page is ${page}. Only continue if you are sure ${page} belongs to the same service.`,
        confirmLabel: `Fill on ${page}`,
        danger: true,
      });
      if (ok) await fillItem(app, id, allowInsecure, true);
      return;
    }
    app.toast(app.errorMessage(e), 'error');
  }
}

/**
 * "Save this login?" card for a login captured in the active tab (offer to save). It lives in the popup,
 * where the page cannot hide, overlay or click it; null when nothing is waiting.
 * @param {any} app
 */
async function captureCard(app) {
  if (!app.tab || typeof app.tab.id !== 'number') return null;
  let c;
  try {
    c = await app.call('capture.get', { tabId: app.tab.id });
  } catch {
    return null;
  }
  if (!c || !c.show) return null;
  const update = c.kind === 'update';
  const decide = (decision, btn) =>
    withBusy(btn, async () => {
      try {
        const r = await app.call('capture.confirm', { tabId: app.tab.id, id: c.id, decision });
        if (!r || !r.done) app.toast('That login changed meanwhile. Check it again.', 'info');
        else if (decision === 'save') app.toast('Login saved', 'success');
        else if (decision === 'update') app.toast('Password updated', 'success');
      } catch (e) {
        app.toast(app.errorMessage(e), 'error');
      }
      await app.renderTop();
    });
  const primary = button(update ? 'Update' : 'Save', { variant: 'primary', icon: update ? 'refresh' : 'plus' });
  primary.addEventListener('click', () => decide(update ? 'update' : 'save', primary));
  const later = button('Not now', { variant: 'secondary' });
  later.addEventListener('click', () => decide('dismiss', later));
  const never = button('Never for this site', { variant: 'ghost' });
  never.addEventListener('click', () => decide('never', never));
  return h(
    'section',
    { class: 'capture-card', role: 'region', 'aria-label': update ? 'Update saved password' : 'Save login' },
    h('p', { class: 'capture-title', text: update ? `Update the saved password${c.itemName ? ` in “${c.itemName}”` : ''}?` : 'Save the login you just used?' }),
    h('p', { class: 'capture-line', text: `Website: ${c.host}` }),
    h('p', { class: 'capture-line', text: c.username ? `Username: ${c.username}` : 'No username detected' }),
    h('div', { class: 'btn-row' }, primary, later, never),
  );
}

async function copyFromItem(app, id, which) {
  try {
    const it = await app.call('items.get', { id });
    const login = it.data.login || {};
    if (which === 'password') await app.copy(login.password || '', 'Password');
    else await app.copy(login.username || '', 'Username');
  } catch (e) {
    app.toast(app.errorMessage(e), 'error');
  }
}

/** Vault home. */
export async function mainView(app) {
  const url = app.webUrl();
  const [data, capture] = await Promise.all([app.call('items.list', { url }), captureCard(app)]);
  const byId = new Map(data.items.map((it) => [it.id, it]));
  const matchSet = new Set(data.matches);
  const otherHost = data.otherHost || {};
  const siteItems = data.matches.map((id) => byId.get(id)).filter(Boolean);
  const favItems = data.items.filter((it) => it.favorite);
  if (!app.ui.tab) app.ui.tab = siteItems.length ? 'site' : 'all';

  const search = h('input', {
    type: 'search',
    class: 'input search-input',
    placeholder: 'Search vault',
    'aria-label': 'Search vault',
    value: app.ui.query,
    autocomplete: 'off',
    spellcheck: 'false',
    autofocus: true,
  });
  const list = h('ul', { class: 'list', role: 'list', 'aria-label': 'Vault items' });
  const tabsEl = h('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Item filters' });
  const tabDefs = [
    { key: 'site', label: 'This site', count: siteItems.length },
    { key: 'all', label: 'All', count: data.items.length },
    { key: 'fav', label: 'Favorites', count: favItems.length },
  ];
  const tabButtons = tabDefs.map((t) => {
    const b = h(
      'button',
      { type: 'button', role: 'tab', class: 'tab', id: `tab-${t.key}`, 'aria-controls': 'item-list' },
      h('span', { text: t.label }),
      h('span', { class: 'tab-count', text: String(t.count) }),
    );
    b.addEventListener('click', () => {
      app.ui.tab = t.key;
      updateTabs();
      renderList();
    });
    return b;
  });
  tabsEl.append(...tabButtons);
  list.id = 'item-list';

  function updateTabs() {
    tabButtons.forEach((b, i) => {
      const sel = tabDefs[i].key === app.ui.tab;
      b.setAttribute('aria-selected', String(sel));
      b.tabIndex = sel ? 0 : -1;
      b.classList.toggle('active', sel);
    });
    list.setAttribute('aria-labelledby', `tab-${app.ui.tab}`);
  }

  tabsEl.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const idx = tabDefs.findIndex((t) => t.key === app.ui.tab);
    const next = (idx + (e.key === 'ArrowRight' ? 1 : tabDefs.length - 1)) % tabDefs.length;
    app.ui.tab = tabDefs[next].key;
    updateTabs();
    renderList();
    tabButtons[next].focus();
  });

  function row(it) {
    const main = h(
      'button',
      { type: 'button', class: 'row-main', onClick: () => app.go(detailView, it.id) },
      avatar(it.name, it.type),
      h(
        'span',
        { class: 'row-text' },
        h('span', { class: 'row-title' }, h('span', { class: 'truncate', text: it.name || '(no name)' }), it.favorite ? icon('star', { size: 12, filled: true }) : null),
        h('span', { class: 'row-sub truncate', text: it.subtitle || TYPE_LABELS[it.type] || '' }),
        // saved for another host of this site: say which, so a look-alike sibling host stands out
        otherHost[it.id] && url ? h('span', { class: 'row-warn truncate', text: `Saved for ${otherHost[it.id].join(', ') || 'another host'}` }) : null,
      ),
    );
    const actions = h('span', { class: 'row-actions' });
    if (it.type === 'login') {
      if (matchSet.has(it.id) && url) actions.append(iconButton('bolt', `Fill ${it.name}`, () => fillItem(app, it.id), { cls: 'accent' }));
      if (it.hasUsername) actions.append(iconButton('user', `Copy username for ${it.name}`, () => copyFromItem(app, it.id, 'username')));
      if (it.hasPassword) actions.append(iconButton('key', `Copy password for ${it.name}`, () => copyFromItem(app, it.id, 'password')));
    }
    return h('li', { class: 'row' }, main, actions);
  }

  function emptyState(title, text, action) {
    return h('li', { class: 'empty' }, h('div', { class: 'empty-icon' }, icon('search', { size: 22 })), h('p', { class: 'empty-title', text: title }), text ? h('p', { class: 'empty-text', text }) : null, action || null);
  }

  function renderList() {
    clear(list);
    const q = app.ui.query.trim();
    const source = app.ui.tab === 'site' ? siteItems : app.ui.tab === 'fav' ? favItems : data.items;
    const items = searchItems(source, q);
    if (!items.length) {
      if (q) list.append(emptyState('No matches', `Nothing in this list matches “${q}”.`));
      else if (app.ui.tab === 'site' && !url) list.append(emptyState('No website open', 'Open a website to see the logins saved for it.'));
      else if (app.ui.tab === 'site') {
        list.append(emptyState(`No logins for ${siteName(url)}`, 'Save one now with a strong generated password.', button('Add login for this site', { variant: 'primary', icon: 'plus', onClick: () => app.go(editView, null, { type: 'login' }) })));
      } else if (app.ui.tab === 'fav') list.append(emptyState('No favorites yet', 'Mark items with the star to pin them here.'));
      else list.append(emptyState('Your vault is empty', 'Add your first login.', button('New login', { variant: 'primary', icon: 'plus', onClick: () => app.go(editView, null, { type: 'login' }) })));
      return;
    }
    let shown = 0;
    const more = () => {
      const chunk = items.slice(shown, shown + PAGE);
      shown += chunk.length;
      const btn = list.querySelector('.load-more');
      if (btn) btn.remove();
      for (const it of chunk) list.append(row(it));
      if (shown < items.length) {
        list.append(h('li', { class: 'load-more' }, button(`Show more (${items.length - shown})`, { variant: 'ghost', block: true, onClick: more })));
      }
    };
    more();
  }

  list.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const rows = [...list.querySelectorAll('.row-main')];
    const i = rows.indexOf(document.activeElement);
    if (i < 0) return;
    e.preventDefault();
    const next = rows[Math.max(0, Math.min(rows.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))];
    next.focus();
  });
  search.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      const first = list.querySelector('.row-main');
      if (first) {
        e.preventDefault();
        first.focus();
      }
    } else if (e.key === 'Enter') {
      const first = list.querySelector('.row-main');
      if (first) first.click();
    }
  });
  search.addEventListener('input', () => {
    app.ui.query = search.value;
    renderList();
  });

  const syncBtn = iconButton('refresh', 'Sync now', () => {
    const permission = requestServerPermission(app.state.serverUrl);
    return withBusy(syncBtn, async () => {
      try {
        await permission;
        const st = await app.call('vault.sync');
        if (st && st.phase !== 'unlocked') {
          // e.g. the master password was changed or the vault re-created on another device
          app.toast(app.syncOutcomeMessage(st), 'info');
          await app.refresh();
          return;
        }
        app.toast('Vault synced', 'success');
        await app.renderTop();
      } catch (e) {
        app.toast(app.errorMessage(e), 'error');
        if (['certificate_changed', 'session_expired'].includes(e.code)) await app.refresh();
      }
    });
  });
  const header = app.header({
    title: 'Ludworks',
    brand: true,
    actions: [
      syncBtn,
      iconButton('dice', 'Password generator', () => app.go(generatorView)),
      iconButton('settings', 'Settings', () => app.go(settingsView)),
      iconButton('lock', 'Lock now', async () => {
        await app.call('vault.lock');
        await app.refresh();
      }),
    ],
  });

  const banner =
    data.undecryptable > 0
      ? h('div', { class: 'callout callout-warn slim', role: 'status' }, icon('alert', { size: 16 }), h('p', { text: `${data.undecryptable} item(s) could not be decrypted with this vault key. Lock and unlock again, or check them in the web app.` }))
      : null;

  const newMenu = h('div', { class: 'footer' },
    button('New login', { variant: 'primary', icon: 'plus', onClick: () => app.go(editView, null, { type: 'login' }) }),
    button('Note', { variant: 'secondary', icon: 'note', onClick: () => app.go(editView, null, { type: 'note' }) }),
    button('Card', { variant: 'secondary', icon: 'card', onClick: () => app.go(editView, null, { type: 'card' }) }),
    button('Identity', { variant: 'secondary', icon: 'user', onClick: () => app.go(editView, null, { type: 'identity' }) }),
  );

  updateTabs();
  renderList();
  return h(
    'div',
    { class: 'view view-main' },
    header,
    capture,
    h('div', { class: 'toolbar' }, h('div', { class: 'search' }, icon('search', { size: 16 }), search), tabsEl),
    banner,
    h('main', { class: 'view-body list-body' }, list),
    newMenu,
  );
}

// ------------------------------------------------------------------------------------------- detail

function valueRow(app, label, value, { mono = false, copyLabel = label, link = false } = {}) {
  if (!value) return null;
  const actions = h('div', { class: 'kv-actions' });
  if (link && parseHttpUrl(value)) actions.append(iconButton('external', `Open ${value}`, () => app.openUrl(value)));
  actions.append(iconButton('copy', `Copy ${copyLabel.toLowerCase()}`, () => app.copy(value, copyLabel)));
  return h('div', { class: 'kv' }, h('div', { class: 'kv-main' }, h('div', { class: 'kv-label', text: label }), h('div', { class: ['kv-value', mono && 'mono'], text: value })), actions);
}

function secretRow(app, label, value) {
  if (!value) return null;
  const mask = '•'.repeat(Math.min(16, Math.max(8, value.length)));
  let shown = false;
  const val = h('div', { class: 'kv-value mono', text: mask });
  const eye = iconButton('eye', `Show ${label.toLowerCase()}`, () => {
    shown = !shown;
    val.textContent = shown ? value : mask;
    val.classList.toggle('revealed', shown);
    eye.setAttribute('aria-pressed', String(shown));
    eye.setAttribute('aria-label', `${shown ? 'Hide' : 'Show'} ${label.toLowerCase()}`);
    eye.title = `${shown ? 'Hide' : 'Show'} ${label.toLowerCase()}`;
    clear(eye).append(icon(shown ? 'eyeOff' : 'eye'));
  }, { pressed: false });
  return h(
    'div',
    { class: 'kv' },
    h('div', { class: 'kv-main' }, h('div', { class: 'kv-label', text: label }), val),
    h('div', { class: 'kv-actions' }, eye, iconButton('copy', `Copy ${label.toLowerCase()}`, () => app.copy(value, label))),
  );
}

function totpRow(app, secret) {
  const R = 9;
  const C = 2 * Math.PI * R;
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '28');
  svg.setAttribute('height', '28');
  svg.setAttribute('class', 'ring');
  svg.setAttribute('aria-hidden', 'true');
  const bg = document.createElementNS(SVG_NS, 'circle');
  const fg = document.createElementNS(SVG_NS, 'circle');
  for (const c of [bg, fg]) {
    c.setAttribute('cx', '12');
    c.setAttribute('cy', '12');
    c.setAttribute('r', String(R));
    c.setAttribute('fill', 'none');
    c.setAttribute('stroke-width', '3');
  }
  bg.setAttribute('class', 'ring-bg');
  fg.setAttribute('class', 'ring-fg');
  fg.setAttribute('stroke-dasharray', String(C));
  fg.setAttribute('transform', 'rotate(-90 12 12)');
  svg.append(bg, fg);
  const secs = h('span', { class: 'ring-secs', text: '' });
  const code = h('div', { class: 'kv-value mono totp-code', text: '••• •••' });
  const timer = h('div', { class: 'ring-wrap', role: 'timer', 'aria-label': 'Seconds until the code changes' }, svg, secs);
  let current = '';
  const tick = async () => {
    try {
      const r = await generateTotp(secret);
      current = r.code;
      code.textContent = formatTotp(r.code);
      fg.setAttribute('stroke-dashoffset', String(C * (1 - r.remaining / r.period)));
      fg.classList.toggle('ending', r.remaining <= 5);
      secs.textContent = String(r.remaining);
    } catch {
      code.textContent = 'Invalid TOTP secret';
      current = '';
    }
  };
  tick();
  const id = setInterval(tick, 1000);
  app.onLeave(() => clearInterval(id));
  return h(
    'div',
    { class: 'kv' },
    h('div', { class: 'kv-main' }, h('div', { class: 'kv-label', text: 'Verification code (TOTP)' }), h('div', { class: 'totp-line' }, code, timer)),
    h('div', { class: 'kv-actions' }, iconButton('copy', 'Copy verification code', () => app.copy(current, 'Code'))),
  );
}

function section(title, ...rows) {
  const content = rows.flat().filter(Boolean);
  if (!content.length) return null;
  return h('section', { class: 'card-section' }, title ? h('h3', { class: 'section-title', text: title }) : null, content);
}

/** Item detail. */
export async function detailView(app, id) {
  const url = app.webUrl();
  const [item, listed] = await Promise.all([app.call('items.get', { id }), app.call('items.list', { url })]);
  const d = item.data;
  const folder = item.folderId ? listed.folders.find((f) => f.id === item.folderId) : null;
  const folderName = folder && folder.name ? folder.name : '';

  const star = iconButton('star', d.favorite ? 'Remove from favorites' : 'Add to favorites', () =>
    withBusy(star, async () => {
      const next = cloneJson(d);
      next.favorite = !d.favorite;
      try {
        await app.call('items.save', { id, data: next, baseRevision: item.revision });
        await app.replace(detailView, id);
      } catch (e) {
        app.toast(app.errorMessage(e), 'error');
      }
    }),
  { pressed: !!d.favorite, filled: !!d.favorite, cls: d.favorite ? 'starred' : '' });

  const header = app.header({
    title: d.name || '(no name)',
    back: true,
    actions: [star, iconButton('edit', 'Edit item', () => app.go(editView, id))],
  });

  const body = h('main', { class: 'view-body detail' });
  body.append(
    h('div', { class: 'detail-hero' }, avatar(d.name, d.type), h('div', null, h('div', { class: 'detail-name', text: d.name }), h('div', { class: 'muted small', text: [TYPE_LABELS[d.type] || d.type, folderName].filter(Boolean).join(' · ') }))),
  );

  if (d.type === 'login') {
    const l = d.login || {};
    body.append(section('', valueRow(app, 'Username', l.username), secretRow(app, 'Password', l.password), l.totp ? totpRow(app, l.totp) : null));
    const uris = Array.isArray(l.uris) ? l.uris.filter((u) => u && u.uri) : [];
    if (uris.length) {
      body.append(
        section(
          'Websites',
          uris.map((u) =>
            h(
              'div',
              { class: 'kv' },
              h('div', { class: 'kv-main' }, h('div', { class: 'kv-value truncate', text: u.uri, title: u.uri }), u.match && u.match !== 'domain' ? h('div', { class: 'badge', text: MATCH_LABELS[u.match] || u.match }) : null),
              h('div', { class: 'kv-actions' }, parseHttpUrl(u.uri) ? iconButton('external', `Open ${u.uri}`, () => app.openUrl(u.uri)) : null, iconButton('copy', 'Copy website', () => app.copy(u.uri, 'Website'))),
            ),
          ),
        ),
      );
    }
  } else if (d.type === 'card') {
    const c = d.card || {};
    body.append(section('Card', CARD_FIELDS.map((f) => (f.secret ? secretRow(app, f.label, c[f.key]) : valueRow(app, f.label, c[f.key], { mono: f.mono })))));
  } else if (d.type === 'identity') {
    const i = d.identity || {};
    body.append(section('Identity', IDENTITY_FIELDS.map((f) => (f.secret ? secretRow(app, f.label, i[f.key]) : valueRow(app, f.label, i[f.key])))));
  }

  if (d.notes) {
    body.append(section('Notes', h('div', { class: 'notes' }, h('div', { class: 'notes-text', text: d.notes }), iconButton('copy', 'Copy notes', () => app.copy(d.notes, 'Notes')))));
  }
  const fields = Array.isArray(d.fields) ? d.fields.filter((f) => f && (f.name || f.value)) : [];
  if (fields.length) {
    body.append(section('Custom fields', fields.map((f) => (f.hidden ? secretRow(app, f.name || 'Hidden field', String(f.value ?? '')) : valueRow(app, f.name || 'Field', String(f.value ?? ''))))));
  }
  const history = Array.isArray(d.password_history) ? d.password_history.filter((x) => x && x.password) : [];
  if (history.length) {
    body.append(
      h(
        'details',
        { class: 'details card-section' },
        h('summary', { text: `Password history (${history.length})` }),
        history.map((x) => secretRow(app, formatDate(x.changed_at, { dateOnly: true }) ? `Changed ${formatDate(x.changed_at, { dateOnly: true })}` : 'Old password', x.password)),
      ),
    );
  }
  const updated = formatDate(item.updatedAt) || formatDate(d.updated_at);
  if (updated) body.append(h('p', { class: 'meta', text: `Updated ${updated}` }));

  const footer = h('div', { class: 'footer' });
  if (d.type === 'login') {
    const savedFor = listed.otherHost && listed.otherHost[id];
    if (url && listed.matches.includes(id) && savedFor) {
      body.append(
        h('div', { class: 'callout callout-warn', role: 'note' }, icon('alert', { size: 16 }), h('p', { text: `Saved for ${savedFor.join(', ') || 'another host'}; this page is ${hostLabel(url)}.` })),
      );
    }
    if (url && listed.matches.includes(id)) {
      footer.append(button(`Fill on ${hostLabel(url) || siteName(url)}`, { variant: 'primary', icon: 'bolt', block: true, onClick: () => fillItem(app, id) }));
    } else if (d.login && d.login.password) {
      footer.append(button('Copy password', { variant: 'secondary', icon: 'key', block: true, onClick: () => app.copy(d.login.password, 'Password') }));
    }
  }
  return h('div', { class: 'view view-detail' }, header, body, footer.childNodes.length ? footer : null);
}
