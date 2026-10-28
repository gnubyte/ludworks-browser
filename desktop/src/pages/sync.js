// Ludworks account & sync: status, what syncs, tabs from other devices.
import { h, clear, applyTheme, sideNav, toggle, letterIcon } from './ui.js';

const app = document.getElementById('app');
const main = h('main', { class: 'main' });
app.append(sideNav('sync'), main);
const call = async (cmd, args = {}) => {
  const r = await window.lwPage.call(cmd, args);
  if (r && r.ok === false) throw new Error(r.error.message);
  return r && 'value' in r ? r.value : r;
};

function setting(title, desc, control) {
  return h('div', { class: 'setting' }, h('div', { class: 'grow' }, h('div', {}, title), desc ? h('div', { class: 'd' }, desc) : null), control);
}

async function render() {
  applyTheme(await window.lwPage.call('theme'));
  const st = await call('sync.status');
  const s = st.summary;
  clear(main);
  main.append(h('h1', {}, 'Ludworks sync'));
  if (s.phase === 'logged_out') {
    main.append(h('div', { class: 'card', style: { padding: '24px' } }, h('p', {}, 'Sign in to your Ludworks server to sync passwords, passkeys, bookmarks, history, open tabs and settings — end-to-end encrypted with your master password.'), h('button', { class: 'btn primary', onclick: () => call('account.signin-popup') }, 'Sign in')));
    return;
  }
  const status =
    s.phase === 'unlocked'
      ? `Synced ${s.lastSyncAt ? new Date(s.lastSyncAt).toLocaleString() : '—'}${s.syncing ? ' (syncing…)' : ''}`
      : s.phase === 'locked'
        ? 'Vault locked — unlock it from the account button to sync'
        : 'Vault not set up yet';
  main.append(
    h(
      'div',
      { class: 'card' },
      setting(`${s.user.displayName || s.user.username} on ${s.serverName || s.serverHost}`, `${s.serverUrl}${s.fingerprint ? ` · certificate ${s.fingerprint.slice(0, 23)}…` : ''}`, h('div', { style: { display: 'flex', gap: '8px' } }, h('button', { class: 'btn', onclick: async () => { await call('account.sync'); render(); } }, 'Sync now'), h('button', { class: 'btn danger', onclick: async () => { if (window.confirm('Sign out? Passwords stay in your vault on the server; this computer forgets the device token.')) { await call('account.signout'); render(); } } }, 'Sign out'))),
      setting('Status', status, h('span', {})),
      s.error ? setting('Last error', s.error.message, h('span', {})) : null,
      s.warning ? setting('Warning', s.warning, h('span', {})) : null,
    ),
    h('h2', {}, 'What to sync'),
    h(
      'div',
      { class: 'card' },
      setting('Passwords and passkeys', 'Always on: they are your Ludworks vault.', h('span', { class: 'pill' }, 'On')),
      ...[
        ['bookmarks', 'Bookmarks', null],
        ['history', 'History', 'Pages you visited in the last 90 days.'],
        ['tabs', 'Open tabs', 'Lets your other devices show the tabs open here.'],
        ['prefs', 'Settings', 'Search engine, home page and bookmarks bar.'],
      ].map(([k, label, desc]) => setting(label, desc, toggle(st.prefs[k] !== false, async (v) => { await call('sync.set', { [k]: v }); }))),
    ),
  );
  if (st.remoteTabs.length) {
    main.append(h('h2', {}, 'Tabs from your other devices'));
    for (const dev of st.remoteTabs) {
      const card = h('div', { class: 'card list', style: { marginBottom: '14px' } }, h('div', { class: 'row' }, h('div', { class: 'grow' }, h('div', { class: 't' }, dev.device), h('div', { class: 's' }, `${dev.platform} · updated ${dev.updatedAt ? new Date(dev.updatedAt).toLocaleString() : '—'}`))));
      for (const t of dev.tabs.slice(0, 50)) {
        const row = h('div', { class: 'row' }, letterIcon(t.url, 20), h('div', { class: 'grow' }, h('div', { class: 't' }, t.title || t.url), h('div', { class: 's' }, t.url)));
        row.addEventListener('click', () => call('sync.open-tab', { url: t.url }));
        card.append(row);
      }
      main.append(card);
    }
  }
}

window.lwPage.on('page-event', (ev) => {
  if (ev && ev.type === 'account') render();
});
render();
