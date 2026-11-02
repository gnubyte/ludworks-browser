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

// One step for every browser profile found (Edge, Chrome, Firefox, …): pick one, import bookmarks + history.
const imported = new Map(); // source id → result text (kept across re-renders)
function importStep(n, sources) {
  const pick = h('select', { class: 'input', style: { width: '230px' }, 'aria-label': 'Browser to import from' }, ...sources.map((s) => h('option', { value: s.id }, s.name)));
  const btn = h('button', { class: 'btn' }, 'Import');
  const note = h('div', { class: 'muted', style: { marginTop: '6px', fontSize: '12.5px' } });
  const show = () => {
    note.textContent = imported.get(pick.value) || '';
    btn.textContent = imported.has(pick.value) ? 'Import again' : 'Import';
  };
  pick.addEventListener('change', show);
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.textContent = 'Importing…';
    const r = await call('import.browser', { browser: pick.value }).catch((e) => ({ ok: false, error: { message: String(e.message || e) } }));
    btn.disabled = false;
    imported.set(pick.value, r.ok ? `✓ ${r.value.bookmarks.toLocaleString()} bookmarks added${r.value.skipped ? ` (${r.value.skipped.toLocaleString()} already here)` : ''} · ${r.value.history.toLocaleString()} history pages` : r.error.message);
    show();
  });
  show();
  const desc = h('div', {}, `Bookmarks and the last 90 days of history${sources.length > 1 ? ` — ${sources.length} browser profiles found` : ` from ${sources[0].name}`}. Passwords: export them from that browser as a CSV file and import it on the Passwords page.`, note);
  return step(n, 'Bring over your bookmarks and history', desc, h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' } }, sources.length > 1 ? pick : null, btn));
}

// The AI apps the "Send to AI" toolbar badge offers (src/main/agent/send.js); also in Settings → AI agents.
function aiStep(n, st) {
  const box = (key, label) => {
    const c = h('input', { type: 'checkbox', checked: !!st.sendTo[key] });
    c.addEventListener('change', () => call('send.set', { sendTo: { [key]: c.checked } }));
    return h('label', { style: { display: 'inline-flex', gap: '6px', alignItems: 'center', whiteSpace: 'nowrap' } }, c, label);
  };
  const desc = h('div', {}, 'A toolbar badge sends the page you are on — or a snapshot of it — to your AI app with what you want done, and can let it control the page.', h('div', { style: { display: 'flex', gap: '16px', flexWrap: 'wrap', marginTop: '10px' } }, box('vision', st.vision.found ? 'Vision' : 'Vision (not installed yet)'), box('claude', 'Claude'), box('openclaw', 'OpenClaw')));
  return step(n, 'Send pages to AI apps', desc);
}

async function render() {
  applyTheme(await call('theme'));
  const db = await call('default-browser.status').catch(() => ({ supported: false }));
  const sources = await call('import.sources').then((r) => (r && r.ok ? r.value : [])).catch(() => []);
  const ai = await call('send.state').catch(() => null);
  const acct = await call('account.summary').then((r) => (r && r.ok ? r.value : null)).catch(() => null);
  clear(app);
  app.append(
    h('div', { style: { display: 'flex', alignItems: 'center', gap: '16px', marginBottom: '28px' } }, h('img', { src: '/assets/logo.svg', width: 64, height: 64, alt: '' }), h('div', {}, h('h1', { style: { margin: 0, fontSize: '28px' } }, 'Welcome to Ludworks Browser'), h('div', { class: 'muted' }, 'Fast Chromium browsing, with your passwords, passkeys and bookmarks synced through your own Ludworks server.'))),
    step(1, 'Make it your default browser', 'Links from other apps will open here.', db.isDefault ? h('span', { class: 'pill' }, 'Done') : h('button', { class: 'btn primary', onclick: () => call('default-browser.open') }, 'Make default')),
    sources.length ? importStep(2, sources) : null,
    step(sources.length ? 3 : 2, 'Sign in to Ludworks', acct && acct.phase !== 'logged_out' ? `Signed in as ${acct.user.username} on ${acct.serverHost}.` : 'Sync passwords, passkeys, bookmarks, history and open tabs — end-to-end encrypted.', acct && acct.phase !== 'logged_out' ? h('span', { class: 'pill' }, 'Done') : h('button', { class: 'btn primary', onclick: () => call('account.signin-popup') }, 'Sign in')),
    step(sources.length ? 4 : 3, 'Import from Bitwarden', 'Bring your Bitwarden vault — passwords, passkeys, TOTP, cards and notes — into Ludworks.', h('a', { class: 'btn', href: 'ludworks://passwords/' }, 'Open Passwords')),
    ai ? aiStep(sources.length ? 5 : 4, ai) : null,
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
