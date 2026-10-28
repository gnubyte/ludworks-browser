// First run: make default, import from the previous browser, sign in to Ludworks.
import { h, clear, applyTheme } from './ui.js';

const call = (cmd, args = {}) => window.lwPage.call(cmd, args);
const app = document.getElementById('app');
app.className = '';
app.style.maxWidth = '760px';
app.style.margin = '0 auto';
app.style.padding = '8vh 24px 40px';

function step(n, title, desc, ...actions) {
  return h('div', { class: 'card', style: { padding: '20px 22px', marginBottom: '14px', display: 'flex', gap: '18px', alignItems: 'center' } }, h('div', { class: 'pill', style: { fontSize: '14px', minWidth: '28px', justifyContent: 'center' } }, String(n)), h('div', { style: { flex: '1' } }, h('div', { style: { fontWeight: '650', fontSize: '15px' } }, title), h('div', { class: 'muted', style: { marginTop: '4px' } }, desc)), ...actions);
}

async function render() {
  applyTheme(await call('theme'));
  const db = await call('default-browser.status').catch(() => ({ supported: false }));
  const sources = await call('import.sources').then((r) => (r && r.ok ? r.value : [])).catch(() => []);
  const acct = await call('account.summary').then((r) => (r && r.ok ? r.value : null)).catch(() => null);
  clear(app);
  app.append(
    h('div', { style: { display: 'flex', alignItems: 'center', gap: '16px', marginBottom: '28px' } }, h('img', { src: '/assets/logo.svg', width: 64, height: 64, alt: '' }), h('div', {}, h('h1', { style: { margin: 0, fontSize: '28px' } }, 'Welcome to Ludworks Browser'), h('div', { class: 'muted' }, 'Fast Chromium browsing, with your passwords, passkeys and bookmarks synced through your own Ludworks server.'))),
    step(1, 'Make it your default browser', 'Links from other apps will open here.', db.isDefault ? h('span', { class: 'pill' }, 'Done') : h('button', { class: 'btn primary', onclick: () => call('default-browser.open') }, 'Make default')),
    ...sources.map((s, i) =>
      step(2 + i, `Bring over your bookmarks and history from ${s.name}`, 'Passwords: export them from that browser as a CSV file and import it on the Passwords page.', h('button', { class: 'btn', onclick: async (e) => { const b = e.currentTarget; b.disabled = true; const r = await call('import.browser', { browser: s.id }); b.textContent = r.ok ? `Imported ${r.value.bookmarks} bookmarks · ${r.value.history} pages` : r.error.message; } }, 'Import')),
    ),
    step(2 + sources.length, 'Sign in to Ludworks', acct && acct.phase !== 'logged_out' ? `Signed in as ${acct.user.username} on ${acct.serverHost}.` : 'Sync passwords, passkeys, bookmarks, history and open tabs — end-to-end encrypted.', acct && acct.phase !== 'logged_out' ? h('span', { class: 'pill' }, 'Done') : h('button', { class: 'btn primary', onclick: () => call('account.signin-popup') }, 'Sign in')),
    step(3 + sources.length, 'Import from Bitwarden', 'Bring your Bitwarden vault — passwords, passkeys, TOTP, cards and notes — into Ludworks.', h('a', { class: 'btn', href: 'ludworks://passwords/' }, 'Open Passwords')),
    h('div', { style: { textAlign: 'right', marginTop: '20px' } }, h('a', { class: 'btn', href: 'ludworks://newtab/' }, 'Start browsing')),
  );
}

let lastPhase = null;
window.lwPage.on('page-event', (ev) => {
  if (ev && ev.type === 'account' && ev.summary.phase !== lastPhase) {
    lastPhase = ev.summary.phase;
    render();
  }
});
render();
