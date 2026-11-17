// Settings.
import { h, clear, applyTheme, sideNav, toggle } from './ui.js';
import { blockerSection } from './settings-blocker.js';
import { extensionsSection } from './settings-extensions.js';
import { agentsSection, sendSection } from './settings-agents.js';

const app = document.getElementById('app');
const main = h('main', { class: 'main' });
app.append(sideNav('settings'), main);
const call = (cmd, args = {}) => window.lwPage.call(cmd, args);
let prefs = null;
let engines = [];

async function set(patch) {
  try {
    prefs = await call('prefs.set', { patch });
    applyTheme(prefs.theme);
  } catch (e) {
    window.alert(e.message);
  }
}

function setting(title, desc, control) {
  return h('div', { class: 'setting' }, h('div', { class: 'grow' }, h('div', {}, title), desc ? h('div', { class: 'd' }, desc) : null), control);
}

function select(options, value, onchange) {
  const s = h('select', { class: 'input', style: { width: '220px' } }, ...options.map(([v, l]) => h('option', { value: v }, l)));
  s.value = String(value);
  s.addEventListener('change', () => onchange(s.value));
  return s;
}

function section(id, title, ...rows) {
  return [h('h2', { id }, title), h('div', { class: 'card' }, ...rows)];
}

async function render() {
  const d = await call('prefs.get');
  prefs = d.prefs;
  engines = d.engines;
  applyTheme(prefs.theme);
  const db = await call('default-browser.status').catch(() => ({ supported: false }));
  const ct = await call('themes.state').catch(() => null);
  const sources = await call('import.sources').then((r) => (r && r.ok ? r.value : [])).catch(() => []);
  clear(main);

  const customName = h('input', { class: 'input', placeholder: 'Name', value: (prefs.customSearch && prefs.customSearch.name) || '', style: { width: '160px' } });
  const customUrl = h('input', { class: 'input', placeholder: 'https://search.example/?q=%s', value: (prefs.customSearch && prefs.customSearch.url) || '' });
  const homepage = h('input', { class: 'input', value: prefs.homepage, style: { width: '320px' } });
  homepage.addEventListener('change', () => set({ homepage: homepage.value.trim() || 'ludworks://newtab/' }));

  const clearRange = select([['3600000', 'Last hour'], ['86400000', 'Last 24 hours'], ['172800000', 'Last 48 hours'], ['259200000', 'Last 72 hours'], ['604800000', 'Last 7 days'], ['0', 'All time']], '0', () => {});
  const what = { history: h('input', { type: 'checkbox', checked: true }), cookies: h('input', { type: 'checkbox' }), cache: h('input', { type: 'checkbox', checked: true }), downloads: h('input', { type: 'checkbox' }), permissions: h('input', { type: 'checkbox' }) };
  const label = (cb, t) => h('label', { style: { display: 'flex', gap: '8px', alignItems: 'center' } }, cb, t);
  const clearBtn = h('button', { class: 'btn danger' }, 'Clear data');
  clearBtn.addEventListener('click', async () => {
    if (!window.confirm('Clear the selected browsing data?')) return;
    const ms = Number(clearRange.value);
    await call('data.clear', { since: ms ? Date.now() - ms : 0, what: Object.fromEntries(Object.entries(what).map(([k, v]) => [k, v.checked])) });
    clearBtn.textContent = 'Cleared ✓';
  });

  const perms = await call('site.list');
  const permList = h('div', { class: 'list' });
  const renderPerms = (list) => {
    clear(permList);
    if (!list.length) permList.append(h('div', { class: 'row muted' }, 'No site permissions saved.'));
    for (const p of list) permList.append(h('div', { class: 'row' }, h('div', { class: 'grow' }, h('div', { class: 't' }, p.origin), h('div', { class: 's' }, `${p.permission.replace(/^openExternal:/, 'open ')} — ${p.decision}`)), h('button', { class: 'btn small', onclick: async () => renderPerms(await call('site.clear', { origin: p.origin })) }, 'Reset site')));
  };
  renderPerms(perms);

  const importRows = sources.length
    ? sources.map((s) => setting(`Import from ${s.name}`, 'Bookmarks and the last 90 days of history. For passwords, export them from that browser as CSV and import the file under Passwords.', h('button', { class: 'btn', onclick: async (e) => { e.currentTarget.disabled = true; const r = await call('import.browser', { browser: s.id }); e.currentTarget.textContent = r.ok ? `Imported ${r.value.bookmarks} bookmarks, ${r.value.history} pages` : r.error.message; } }, 'Import')))
    : [setting('Import from another browser', 'No Chromium-based browser profile was found on this computer.', h('span', {}))];

  main.append(
    h('h1', {}, 'Settings'),
    ...section(
      'default',
      'Default browser',
      db.supported
        ? setting(db.isDefault ? 'Ludworks Browser is your default browser' : 'Make Ludworks Browser your default browser', db.isDefault ? 'Links from other apps open here.' : 'Windows asks you to confirm in Settings → Default apps.', db.isDefault ? h('span', { class: 'pill' }, 'Default') : h('button', { class: 'btn primary', onclick: () => call('default-browser.open') }, 'Make default'))
        : setting('Default browser', 'Not available on this platform.', h('span', {})),
    ),
    ...section(
      'appearance',
      'Appearance',
      setting('Theme', ct && ct.theme ? 'The Chrome theme below sets the colours; this applies to private-window popups and pages.' : null, select([['system', 'Match system'], ['light', 'Light'], ['dark', 'Dark']], prefs.theme, (v) => set({ theme: v }))),
      ct
        ? setting(
            ct.theme ? `Chrome theme: ${ct.theme.name}` : 'Chrome themes',
            ct.theme ? `Installed ${new Date(ct.theme.installedAt).toLocaleDateString()}${ct.theme.source === 'webstore' ? ' from the Chrome Web Store' : ''}. New windows and tabs use it; private windows keep their own look.` : 'Any theme from the Chrome Web Store works here: open one and press “Add to Chrome”. A .crx file or an unpacked theme folder works too (Extensions).',
            h('div', { style: { display: 'flex', gap: '8px' } }, h('button', { class: 'btn', onclick: () => call('themes.store') }, 'Get themes'), ct.theme ? h('button', { class: 'btn', onclick: async () => { await call('themes.reset'); render(); } }, 'Reset to default') : null),
          )
        : null,
      setting('Show bookmarks bar', null, toggle(prefs.showBookmarksBar, (v) => set({ showBookmarksBar: v }))),
      setting('Show home button', null, toggle(prefs.showHomeButton, (v) => set({ showHomeButton: v }))),
    ),
    ...section(
      'search',
      'Search',
      setting('Search engine', 'Used by the address bar and the new tab page. Synced with your Ludworks account.', select([...engines.map((e) => [e.id, e.name]), ['custom', 'Custom…']], prefs.searchEngine, (v) => set({ searchEngine: v }))),
      setting('Custom search engine', 'Use %s where the search terms go.', h('div', { style: { display: 'flex', gap: '8px', flex: '1', maxWidth: '520px' } }, customName, customUrl, h('button', { class: 'btn', onclick: () => set({ customSearch: { name: customName.value.trim() || 'Custom', url: customUrl.value.trim() }, searchEngine: 'custom' }) }, 'Use'))),
      setting('Search suggestions', 'Send what you type in the address bar to the search engine for suggestions (never in private windows).', toggle(prefs.searchSuggestions, (v) => set({ searchSuggestions: v }))),
    ),
    ...section(
      'startup',
      'On startup',
      setting('When the browser starts', null, select([['restore', 'Continue where you left off'], ['newtab', 'Open a new tab']], prefs.startup, (v) => set({ startup: v }))),
      setting('Home page', 'Used by the home button.', homepage),
    ),
    ...section(
      'passwords',
      'Passwords and passkeys',
      setting('Offer to save passwords', 'After you sign in somewhere, offer to save the login in your Ludworks vault.', toggle(prefs.offerToSavePasswords, (v) => set({ offerToSavePasswords: v }))),
      setting('Use Ludworks for passkeys', 'Create and use passkeys stored in your vault on every device. You can always choose another device or a security key instead.', toggle(prefs.passkeys, (v) => set({ passkeys: v }))),
      setting('Keep the vault unlocked on this device', 'Protected by your operating-system account (Windows DPAPI / macOS Keychain / Secret Service). Off: the vault locks after inactivity and when the computer locks.', toggle(prefs.rememberVault, (v) => set({ rememberVault: v }))),
      setting('Lock the vault after inactivity', null, select([['5', '5 minutes'], ['15', '15 minutes'], ['30', '30 minutes'], ['60', '1 hour'], ['240', '4 hours'], ['0', 'Never']], prefs.vaultLockMinutes, (v) => set({ vaultLockMinutes: Number(v) }))),
      setting('Manage passwords', null, h('a', { class: 'btn', href: 'ludworks://passwords/' }, 'Open')),
    ),
    ...section(
      'privacy',
      'Privacy and security',
      setting('Send Global Privacy Control', 'Tells websites not to sell or share your data (Sec-GPC header).', toggle(prefs.sendGpc, (v) => set({ sendGpc: v }))),
      setting('Block third-party cookies', 'Stops sites embedded in pages (ad and analytics networks) from reading or setting cookies. A few sign-in widgets and embeds may stop working.', toggle(prefs.blockThirdPartyCookies, (v) => set({ blockThirdPartyCookies: v }))),
      setting('Show the tracking-cookie button', 'Counts the sites on a page that follow you from site to site, and wipes their cookies.', toggle(prefs.trackerButton, (v) => set({ trackerButton: v }))),
      setting('Show the clear-history button', 'One click to clear the last hour, 24, 48 or 72 hours, 7 days or everything.', toggle(prefs.clearHistoryButton, (v) => set({ clearHistoryButton: v }))),
      setting(
        'Cross-site trackers',
        'Every site seen following you so far.',
        h(
          'div',
          { style: { display: 'flex', gap: '8px' } },
          h('button', { class: 'btn', onclick: async (e) => { const b = e.currentTarget; const r = await call('privacy.wipe'); b.textContent = r.ok ? `Deleted ${r.value.removed} cookies` : r.error.message; } }, 'Wipe their cookies'),
          h('button', { class: 'btn', onclick: async (e) => { const b = e.currentTarget; const r = await call('privacy.forget'); b.textContent = r.ok ? 'Forgotten' : r.error.message; } }, 'Forget the list'),
        ),
      ),
      setting('Spell check', null, toggle(prefs.spellcheck, (v) => set({ spellcheck: v }))),
      h('div', { class: 'setting', style: { flexWrap: 'wrap' } }, h('div', { class: 'grow' }, h('div', {}, 'Clear browsing data'), h('div', { style: { display: 'flex', gap: '16px', flexWrap: 'wrap', marginTop: '10px' } }, label(what.history, 'History'), label(what.cookies, 'Cookies and site data (all time — signs you out of websites)'), label(what.cache, 'Cached files'), label(what.downloads, 'Download list'), label(what.permissions, 'Site permissions'))), clearRange, clearBtn),
    ),
    ...blockerSection(call),
    ...extensionsSection(call),
    ...agentsSection(call),
    ...sendSection(call),
    h('h2', { id: 'sites' }, 'Site permissions'),
    h('div', { class: 'card' }, permList),
    ...section(
      'downloads',
      'Downloads',
      setting('Ask where to save each file', null, toggle(prefs.askWhereToSave, (v) => set({ askWhereToSave: v }))),
      setting('Show the save-pictures button', 'Counts the pictures and videos on a page; pick the ones you want and save them to a folder. Also on the page’s right-click menu.', toggle(prefs.mediaSaverButton, (v) => set({ mediaSaverButton: v }))),
    ),
    ...section(
      'video',
      'Picture in picture',
      setting('Show the picture-in-picture button', 'Appears in the toolbar when a page has a video. Shortcut: Ctrl+Shift+P, or right-click a video.', toggle(prefs.pipButton, (v) => set({ pipButton: v }))),
      setting('Automatic picture in picture', 'A playing video keeps playing in a floating window when you switch to another tab, and returns when you come back.', toggle(prefs.autoPip, (v) => set({ autoPip: v }))),
    ),
    ...section('import', 'Import data', ...importRows, setting('Import bookmarks from a file', 'HTML bookmark files from any browser, or Chrome/Edge "Bookmarks" JSON.', h('button', { class: 'btn', onclick: async (e) => { const r = await call('import.bookmarks.file'); if (r.ok && r.value) e.currentTarget.textContent = `Imported ${r.value.bookmarks}`; } }, 'Choose file…'))),
    ...section(
      'system',
      'System',
      setting('Use hardware acceleration', 'Takes effect after restarting the browser.', toggle(prefs.hardwareAcceleration, (v) => set({ hardwareAcceleration: v }))),
    ),
  );
  if (location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView();
}

render();
window.lwPage.on('page-event', (ev) => {
  if (ev && ev.type === 'theme') render();
});
window.addEventListener('hashchange', () => document.getElementById(location.hash.slice(1))?.scrollIntoView());
