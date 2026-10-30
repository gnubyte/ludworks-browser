// Account / vault popups: sign in (with certificate confirmation and two-step verification),
// unlock, create vault, status. Password and key bubbles live in overlay-vault.js.
import { icon, h, clear } from './icons.js';
import { POPUPS as VAULT_POPUPS } from './overlay-vault.js';

const call = (cmd, args) => window.lw.call(cmd, args);

function ago(ms) {
  if (!ms) return 'never';
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(ms).toLocaleString();
}

function errorBox() {
  const el = h('div', { class: 'notice warn', hidden: true });
  return {
    el,
    show(e) {
      el.hidden = !e;
      el.textContent = e ? e.message || String(e) : '';
    },
  };
}

async function run(cmd, args, err, btn) {
  if (btn) btn.disabled = true;
  try {
    const r = await call(cmd, args);
    if (!r || !r.ok) {
      err.show(r ? r.error : { message: 'Something went wrong.' });
      return null;
    }
    err.show(null);
    return r;
  } finally {
    if (btn) btn.disabled = false;
  }
}

function signInView(root, rerender) {
  const server = h('input', { class: 'input', placeholder: 'https://nas.example.com', 'aria-label': 'Server address', autocomplete: 'url', spellcheck: 'false' });
  const user = h('input', { class: 'input', 'aria-label': 'Username or email', autocomplete: 'username', spellcheck: 'false' });
  const pass = h('input', { class: 'input', type: 'password', 'aria-label': 'Account password', autocomplete: 'current-password' });
  const totp = h('input', { class: 'input', inputmode: 'numeric', 'aria-label': 'Authenticator code', autocomplete: 'one-time-code', placeholder: '123 456' });
  const totpField = h('label', { class: 'field', hidden: true }, h('span', {}, 'Two-step verification code'), totp);
  const err = errorBox();
  const btn = h('button', { class: 'btn primary', type: 'submit' }, 'Sign in');
  const form = h('form', { class: 'stack' }, h('label', { class: 'field' }, h('span', {}, 'Ludworks server'), server), h('label', { class: 'field' }, h('span', {}, 'Username or email'), user), h('label', { class: 'field' }, h('span', {}, 'Account password'), pass), totpField, err.el, h('div', { class: 'row end' }, btn));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const args = { serverUrl: server.value.trim(), username: user.value.trim(), password: pass.value, totpCode: totp.value.trim() || undefined };
    const r = await call('account.signin', args).catch((x) => ({ ok: false, error: { message: x.message } }));
    if (r.ok) {
      pass.value = '';
      rerender(r.value);
      return;
    }
    const e2 = r.error || {};
    if (e2.code === 'totp_required') {
      totpField.hidden = false;
      err.show({ message: 'Enter the code from your authenticator app.' });
      totp.focus();
    } else if (e2.code === 'server_not_trusted' && e2.details) {
      trustView(root, e2.details, () => form.requestSubmit());
    } else err.show(e2);
  });
  root.append(
    h('div', { class: 'head' }, h('img', { src: '/assets/logo.svg', width: 28, height: 28, alt: '' }), h('div', {}, h('h2', {}, 'Sign in to Ludworks'), h('div', { class: 'sub' }, 'Sync passwords, passkeys, bookmarks and history.'))),
    form,
    h('div', { class: 'pad sub' }, 'Your vault stays end-to-end encrypted: the server never sees your master password or your data.'),
  );
  setTimeout(() => server.focus(), 30);
}

function trustView(root, probe, onTrusted) {
  clear(root);
  const err = errorBox();
  const changed = probe.trust === 'changed';
  root.append(
    h('div', { class: 'head' }, icon('shield', { size: 22 }), h('div', {}, h('h2', {}, changed ? 'Server certificate changed' : 'Confirm your server'), h('div', { class: 'sub' }, probe.host))),
    h(
      'div',
      { class: 'pad stack' },
      h('div', { class: changed ? 'notice warn' : 'notice' }, changed ? 'The certificate is different from the one you confirmed before. Only continue if you renewed or replaced it yourself.' : 'This server uses its own (self-signed) certificate. Check that the fingerprint matches the one shown in Ludworks under Admin → System (or in the server log) before you continue.'),
      h('div', { class: 'field' }, h('span', {}, 'SHA-256 fingerprint presented now'), h('div', { class: 'mono' }, probe.fingerprint || '—')),
      changed && probe.pinned ? h('div', { class: 'field' }, h('span', {}, 'Fingerprint you trusted before'), h('div', { class: 'mono' }, probe.pinned)) : null,
      err.el,
    ),
    h(
      'div',
      { class: 'foot' },
      h('button', { class: 'btn', onclick: () => call('popup.close', { kind: 'account' }) }, 'Cancel'),
      h(
        'button',
        {
          class: 'btn primary',
          onclick: async (e) => {
            const r = await run('account.trust', { serverUrl: probe.serverUrl, fingerprint: probe.fingerprintHex || probe.fingerprint }, err, e.currentTarget);
            if (r) onTrusted();
          },
        },
        'The fingerprint matches — trust it',
      ),
    ),
  );
}

function unlockView(root, s, rerender) {
  const pass = h('input', { class: 'input', type: 'password', 'aria-label': 'Master password', autocomplete: 'current-password' });
  const remember = h('input', { type: 'checkbox', checked: !!s.remember, disabled: !s.secureStorage });
  const err = errorBox();
  const btn = h('button', { class: 'btn primary', type: 'submit' }, 'Unlock');
  const form = h(
    'form',
    { class: 'stack' },
    h('label', { class: 'field' }, h('span', {}, 'Master password'), pass),
    h('label', { class: 'check' }, remember, s.secureStorage ? 'Keep unlocked on this device (protected by your OS account)' : 'Keep unlocked (no secure key store available)'),
    err.el,
    h('div', { class: 'row end' }, btn),
  );
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const r = await run('account.unlock', { password: pass.value, remember: remember.checked }, err, btn);
    pass.value = '';
    if (r) rerender(r.value);
    else pass.focus();
  });
  root.append(header(s, 'Vault locked'), form, footer(s, rerender, { lock: false }));
  setTimeout(() => pass.focus(), 30);
}

function createView(root, s, rerender) {
  const p1 = h('input', { class: 'input', type: 'password', autocomplete: 'new-password', 'aria-label': 'New master password' });
  const p2 = h('input', { class: 'input', type: 'password', autocomplete: 'new-password', 'aria-label': 'Repeat master password' });
  const err = errorBox();
  const btn = h('button', { class: 'btn primary', type: 'submit' }, 'Create vault');
  const form = h('form', { class: 'stack' }, h('div', { class: 'notice' }, 'Your account has no password vault yet. Choose a master password: it encrypts everything on your devices and is never sent to the server. If you forget it, the vault cannot be recovered.'), h('label', { class: 'field' }, h('span', {}, 'Master password (12+ characters)'), p1), h('label', { class: 'field' }, h('span', {}, 'Repeat it'), p2), err.el, h('div', { class: 'row end' }, btn));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (p1.value !== p2.value) return err.show({ message: 'The passwords do not match.' });
    const r = await run('account.create-vault', { password: p1.value }, err, btn);
    if (r) rerender(r.value);
  });
  root.append(header(s, 'Set up your vault'), form, footer(s, rerender, { lock: false }));
}

function header(s, sub) {
  const name = (s.user && (s.user.displayName || s.user.username)) || 'Ludworks';
  return h('div', { class: 'head' }, h('span', { class: 'avatar' }, name[0].toUpperCase()), h('div', { style: { minWidth: '0' } }, h('h2', { class: 'ellipsis' }, name), h('div', { class: 'sub ellipsis' }, `${s.serverHost}${sub ? ` · ${sub}` : ''}`)));
}

function footer(s, rerender, { lock = true } = {}) {
  const err = errorBox();
  return h(
    'div',
    {},
    h('div', { class: 'pad' }, err.el),
    h(
      'div',
      { class: 'foot' },
      h('button', { class: 'btn', onclick: async (e) => { const r = await run('account.signout', {}, err, e.currentTarget); if (r) rerender(r.value); } }, 'Sign out'),
      lock ? h('button', { class: 'btn', onclick: async (e) => { const r = await run('account.lock', {}, err, e.currentTarget); if (r) rerender(r.value); } }, 'Lock') : null,
    ),
  );
}

function unlockedView(root, s, rerender) {
  const err = errorBox();
  const syncBtn = h('button', { class: 'btn', onclick: async (e) => { const r = await run('account.sync', {}, err, e.currentTarget); if (r) rerender(r.value); } }, icon('sync', { size: 15 }), s.syncing ? 'Syncing…' : 'Sync now');
  root.append(
    header(s, 'unlocked'),
    h(
      'div',
      { class: 'pad stack' },
      h('div', { class: 'row' }, icon('check', { size: 16 }), h('span', {}, `${s.itemCount} vault item${s.itemCount === 1 ? '' : 's'} · synced ${ago(s.lastSyncAt)}`)),
      s.warning ? h('div', { class: 'notice warn' }, s.warning) : null,
      s.error ? h('div', { class: 'notice warn' }, s.error.message) : null,
      err.el,
      h('div', { class: 'row' }, syncBtn, h('button', { class: 'btn', onclick: () => call('account.open', { page: 'passwords' }) }, icon('key', { size: 15 }), 'Passwords'), h('button', { class: 'btn', onclick: () => call('account.open', { page: 'sync' }) }, 'Sync settings')),
      h('button', { class: 'btn', onclick: () => call('account.open-web', {}) }, icon('external', { size: 15 }), `Open ${s.serverName || 'Ludworks'}`),
    ),
    footer(s, rerender),
  );
}

export const POPUPS = {
  account(summary, ctx) {
    const box = h('div', { class: 'popup' });
    const render = (s) => {
      clear(box);
      if (!s || s.phase === 'logged_out') {
        signInView(box, render);
        if (s && s.error) box.append(h('div', { class: 'pad' }, h('div', { class: 'notice warn' }, s.error.message)));
      } else if (s.phase === 'uninitialized') createView(box, s, render);
      else if (s.phase === 'locked') unlockView(box, s, render);
      else unlockedView(box, s, render);
    };
    render(summary);
    ctx.onData = (s) => {
      // keep the sign-in / unlock form the user is typing in; refresh status views
      if (s.phase === 'unlocked' || !box.querySelector('input')) render(s);
    };
    return box;
  },
  ...VAULT_POPUPS,
};
