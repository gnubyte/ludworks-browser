// Sign-in (with TOFU certificate confirmation and two-step verification), unlock, vault-not-initialized
// and certificate-changed screens.

import { ext } from '../../lib/browser.js';
import { normalizeServerUrl, originPattern } from '../../lib/api.js';
import { formatFingerprint } from '../../lib/fingerprint.js';
import { h, clear, icon, iconButton, button, withBusy, field, nextId, logo, confirmDialog, alertDialog } from '../ui.js';
import { requestServerPermission } from '../rpc.js';
import { settingsView } from './settings.js';

const DRAFT_KEY = 'loginDraft';

async function loadDraft() {
  try {
    const { [DRAFT_KEY]: d } = await ext.storage.local.get(DRAFT_KEY);
    return d && typeof d === 'object' ? d : {};
  } catch {
    return {};
  }
}

function saveDraft(serverUrl, username) {
  // Non-secret convenience only: remembers the server address and username for the next sign-in.
  ext.storage.local.set({ [DRAFT_KEY]: { serverUrl, username } }).catch(() => {});
}

function passwordInput(id, autocomplete, label) {
  const input = h('input', {
    id,
    type: 'password',
    class: 'input',
    autocomplete,
    required: true,
    spellcheck: 'false',
    autocapitalize: 'off',
  });
  const reveal = iconButton('eye', `Show ${label}`, () => {
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    reveal.setAttribute('aria-pressed', String(show));
    reveal.setAttribute('aria-label', `${show ? 'Hide' : 'Show'} ${label}`);
    reveal.title = `${show ? 'Hide' : 'Show'} ${label}`;
    clear(reveal).append(icon(show ? 'eyeOff' : 'eye'));
  }, { pressed: false, cls: 'input-addon' });
  return { input, wrap: h('div', { class: 'input-group' }, input, reveal) };
}

function fingerprintBlock(fp) {
  const pairs = formatFingerprint(fp).split(':');
  const lines = [];
  for (let i = 0; i < pairs.length; i += 8) lines.push(pairs.slice(i, i + 8).join(':'));
  return h('div', { class: 'fingerprint', 'aria-label': 'SHA-256 fingerprint' }, lines.map((l) => h('div', { text: l })));
}

function sourceNote(source) {
  return source === 'tls'
    ? 'Read by Firefox from the TLS connection itself. Every later connection is checked against it.'
    : 'Reported by the server. Chrome does not let extensions read certificates, so this check detects certificate changes only; your browser’s certificate trust is what protects the connection.';
}

function authShell(app, title, subtitle, body, { iconName = null, settings = false } = {}) {
  const actions = settings ? [iconButton('settings', 'Settings', () => app.go(settingsView))] : [];
  return h(
    'div',
    { class: 'view view-auth' },
    app.header({ title: 'Ludworks', brand: true, actions }),
    h(
      'main',
      { class: 'view-body auth-body' },
      h('div', { class: 'auth-hero' }, iconName ? h('div', { class: 'hero-icon' }, icon(iconName, { size: 28 })) : logo(48)),
      h('h2', { class: 'auth-title', text: title }),
      subtitle ? h('p', { class: 'auth-sub', text: subtitle }) : null,
      body,
    ),
  );
}

/** Sign-in flow: credentials -> (fingerprint confirmation) -> (two-step code) -> done. */
export async function loginView(app) {
  const draft = await loadDraft();
  const flow = { serverUrl: '', username: '', password: '' };
  const host = h('div');

  function showError(box, msg) {
    box.textContent = msg;
    box.hidden = !msg;
  }

  async function doLogin(serverUrl, extra, errBox) {
    try {
      await app.call('auth.login', { serverUrl, username: flow.username, password: flow.password, ...extra });
      flow.password = '';
      await app.refresh();
    } catch (e) {
      if (e.code === 'totp_required') {
        renderTotp(serverUrl, Object.keys(extra).length > 0);
      } else if (e.code === 'server_not_trusted' && e.details) {
        renderFingerprint(e.details);
      } else if (e.code === 'certificate_changed' && e.details && e.details.fingerprint) {
        renderFingerprint(e.details);
      } else {
        showError(errBox, app.errorMessage(e));
      }
    }
  }

  async function proceed(serverUrl, errBox) {
    let probe;
    try {
      probe = await app.call('server.probe', { serverUrl });
    } catch (e) {
      showError(errBox, app.errorMessage(e));
      return;
    }
    if (probe.setupRequired) {
      showError(errBox, app.errorMessage({ code: 'setup_required' }));
      return;
    }
    if (probe.interceptionSuspected || probe.pinStatus === 'new' || probe.pinStatus === 'changed') {
      renderFingerprint(probe);
      return;
    }
    await doLogin(probe.serverUrl, {}, errBox);
  }

  function renderCredentials() {
    const serverId = nextId('server');
    const userId = nextId('user');
    const server = h('input', {
      id: serverId,
      type: 'url',
      class: 'input',
      inputmode: 'url',
      autocomplete: 'url',
      placeholder: 'https://nas.example.com',
      value: flow.serverUrl || draft.serverUrl || '',
      required: true,
      spellcheck: 'false',
      autocapitalize: 'off',
    });
    const user = h('input', {
      id: userId,
      type: 'text',
      class: 'input',
      autocomplete: 'username',
      value: flow.username || draft.username || '',
      required: true,
      spellcheck: 'false',
      autocapitalize: 'off',
    });
    const pw = passwordInput(nextId('pw'), 'current-password', 'password');
    const err = h('div', { class: 'form-error', role: 'alert', hidden: true });
    const submit = button('Sign in', { variant: 'primary', type: 'submit', block: true });
    if (!server.value) server.setAttribute('autofocus', '');
    else if (!user.value) user.setAttribute('autofocus', '');
    else pw.input.setAttribute('autofocus', '');

    const form = h(
      'form',
      { class: 'form', novalidate: true },
      field('Server address', server),
      field('Username or email', user),
      h('div', { class: 'field' }, h('label', { for: pw.input.id, class: 'field-label', text: 'Password' }), pw.wrap),
      err,
      submit,
      h(
        'div',
        { class: 'note' },
        icon('info', { size: 16 }),
        h(
          'p',
          { text: 'HTTPS is required (plain HTTP only for localhost). If your server uses its default self-signed certificate, open the server address in this browser once and trust the certificate first — or give the server a certificate from a trusted CA. You will be asked to confirm the certificate fingerprint on first connect.' },
        ),
      ),
    );

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      showError(err, '');
      let serverUrl;
      try {
        serverUrl = normalizeServerUrl(server.value);
      } catch (ex) {
        showError(err, ex.message);
        server.focus();
        return;
      }
      if (!user.value.trim() || !pw.input.value) {
        showError(err, 'Enter your username and password.');
        (user.value.trim() ? pw.input : user).focus();
        return;
      }
      // Must be called synchronously inside the user gesture (Firefox is strict about this).
      let permission;
      try {
        permission = ext.permissions.request({ origins: [originPattern(serverUrl)] });
      } catch (ex) {
        permission = Promise.reject(ex);
      }
      flow.serverUrl = serverUrl;
      flow.username = user.value.trim();
      flow.password = pw.input.value;
      saveDraft(serverUrl, flow.username);
      withBusy(submit, async () => {
        let granted = false;
        try {
          granted = await permission;
        } catch {
          granted = false;
        }
        if (!granted) {
          showError(err, 'Ludworks needs your permission to connect to this server. Click Sign in again and allow access.');
          return;
        }
        await proceed(serverUrl, err);
      });
    });
    clear(host).append(authShell(app, 'Sign in', 'Connect to your self-hosted Ludworks server.', form));
    const auto = host.querySelector('[autofocus]');
    if (auto) setTimeout(() => auto.focus(), 0);
  }

  function renderFingerprint(probe) {
    const err = h('div', { class: 'form-error', role: 'alert', hidden: true });
    const blocked = !!probe.interceptionSuspected;
    const changed = probe.pinStatus === 'changed';
    const ack = h('input', { type: 'checkbox', id: nextId('ack'), class: 'checkbox' });
    const trust = button(changed ? 'Trust new certificate' : 'Trust and continue', { variant: changed ? 'danger' : 'primary', block: true });
    trust.disabled = true;
    ack.addEventListener('change', () => {
      trust.disabled = !ack.checked;
    });
    trust.addEventListener('click', () =>
      withBusy(trust, async () => {
        try {
          await app.call('server.trust', { serverUrl: probe.serverUrl, fingerprint: probe.fingerprint });
          await doLogin(probe.serverUrl, {}, err);
        } catch (e) {
          showError(err, app.errorMessage(e));
        }
      }),
    );
    const name = probe.serverName ? `${probe.serverName} (${new URL(probe.serverUrl).host})` : new URL(probe.serverUrl).host;
    const body = h(
      'div',
      { class: 'form' },
      blocked
        ? h(
            'div',
            { class: 'callout callout-danger', role: 'alert' },
            icon('alert', { size: 18 }),
            h('p', { text: 'The certificate your browser received does not match the one the server reports. Something between you and the server may be intercepting the connection. Ludworks will not connect.' }),
          )
        : null,
      changed && !blocked
        ? h(
            'div',
            { class: 'callout callout-warn', role: 'alert' },
            icon('alert', { size: 18 }),
            h('p', { text: 'This server’s certificate is different from the one you trusted before. That is expected after a certificate renewal — otherwise, do not continue.' }),
          )
        : null,
      h('p', { class: 'muted', text: `Compare this SHA-256 fingerprint for ${name} with the one shown in the Ludworks admin page (System) or in the server log.` }),
      probe.fingerprint ? fingerprintBlock(probe.fingerprint) : h('p', { class: 'form-error', text: 'The server did not provide a certificate fingerprint.' }),
      changed && probe.pinnedFingerprint ? h('details', { class: 'details' }, h('summary', { text: 'Previously trusted fingerprint' }), fingerprintBlock(probe.pinnedFingerprint)) : null,
      h('p', { class: 'field-hint', text: sourceNote(probe.fingerprintSource) }),
      blocked
        ? null
        : h('div', { class: 'check-row' }, ack, h('label', { for: ack.id, text: 'I compared the fingerprint and it matches' })),
      err,
      blocked ? null : trust,
      button('Back', { variant: 'ghost', block: true, onClick: () => renderCredentials() }),
    );
    clear(host).append(authShell(app, changed ? 'Certificate changed' : 'Verify your server', '', body, { iconName: changed || blocked ? 'alert' : 'shield' }));
  }

  function renderTotp(serverUrl, retried) {
    let recovery = false;
    const err = h('div', { class: 'form-error', role: 'alert', hidden: !retried });
    if (retried) err.textContent = 'That code did not work. Try the current code.';
    const codeId = nextId('otp');
    const code = h('input', {
      id: codeId,
      type: 'text',
      class: 'input input-code',
      inputmode: 'numeric',
      autocomplete: 'one-time-code',
      maxlength: '9',
      required: true,
      autofocus: true,
      spellcheck: 'false',
    });
    const label = h('label', { for: codeId, class: 'field-label', text: 'Authentication code' });
    const toggleBtn = button('Use a recovery code instead', { variant: 'ghost' });
    toggleBtn.addEventListener('click', () => {
      recovery = !recovery;
      label.textContent = recovery ? 'Recovery code' : 'Authentication code';
      code.value = '';
      code.setAttribute('inputmode', recovery ? 'text' : 'numeric');
      code.setAttribute('maxlength', recovery ? '64' : '9');
      code.setAttribute('autocomplete', recovery ? 'off' : 'one-time-code');
      code.classList.toggle('input-code', !recovery);
      toggleBtn.querySelector('span').textContent = recovery ? 'Use an authenticator code instead' : 'Use a recovery code instead';
      code.focus();
    });
    const submit = button('Verify', { variant: 'primary', type: 'submit', block: true });
    const form = h('form', { class: 'form', novalidate: true }, h('div', { class: 'field' }, label, code), err, submit, toggleBtn, button('Back', { variant: 'ghost', block: true, onClick: () => renderCredentials() }));
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const v = code.value.trim();
      if (!recovery && !/^[0-9 ]{6,9}$/.test(v)) {
        showError(err, 'Enter the 6–8 digit code from your authenticator app.');
        return;
      }
      if (recovery && !v) {
        showError(err, 'Enter one of your recovery codes.');
        return;
      }
      withBusy(submit, () => doLogin(serverUrl, recovery ? { recoveryCode: v } : { totpCode: v.replace(/\s+/g, '') }, err));
    });
    clear(host).append(authShell(app, 'Two-step verification', 'Enter the code from your authenticator app.', form, { iconName: 'shield' }));
    setTimeout(() => code.focus(), 0);
  }

  renderCredentials();
  return host;
}

/** Master-password unlock. */
export function unlockView(app) {
  const s = app.state;
  const pw = passwordInput(nextId('master'), 'off', 'master password');
  pw.input.setAttribute('autofocus', '');
  const err = h('div', { class: 'form-error', role: 'alert', hidden: true });
  const submit = button('Unlock', { variant: 'primary', type: 'submit', block: true, icon: 'unlock' });
  const who = s.user ? s.user.displayName || s.user.username : '';
  let host = '';
  try {
    host = new URL(s.serverUrl).host;
  } catch {
    host = '';
  }
  const form = h(
    'form',
    { class: 'form', novalidate: true },
    h('div', { class: 'field' }, h('label', { for: pw.input.id, class: 'field-label', text: 'Master password' }), pw.wrap),
    err,
    submit,
    h('p', { class: 'field-hint center', text: 'Your master password never leaves this device.' }),
    button('Log out', {
      variant: 'ghost',
      block: true,
      icon: 'logout',
      onClick: async () => {
        if (await confirmDialog({ title: 'Log out?', message: 'This signs this browser out of Ludworks and removes the cached vault.', confirmLabel: 'Log out' })) {
          await app.logout();
        }
      },
    }),
  );
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!pw.input.value) {
      err.textContent = 'Enter your master password.';
      err.hidden = false;
      return;
    }
    // Re-confirm host access to the server inside the gesture (no prompt when still granted; restores it
    // if the user revoked it in the browser's extension settings).
    const permission = requestServerPermission(s.serverUrl);
    withBusy(submit, async () => {
      try {
        await permission;
        await app.call('vault.unlock', { password: pw.input.value });
        pw.input.value = '';
        await app.refresh();
      } catch (ex) {
        if (['certificate_changed', 'session_expired', 'vault_uninitialized', 'not_logged_in'].includes(ex.code)) {
          await app.refresh();
          return;
        }
        err.textContent = app.errorMessage(ex);
        err.hidden = false;
        pw.input.select();
        form.classList.remove('shake');
        void form.offsetWidth;
        form.classList.add('shake');
      }
    });
  });
  const subtitle = [who, s.serverName || host].filter(Boolean).join(' · ');
  return authShell(app, 'Unlock your vault', subtitle, form, { iconName: 'lock', settings: true });
}

/** Signed in, but the account has no vault yet. */
export function uninitializedView(app) {
  const check = button('Check again', { variant: 'secondary', block: true, icon: 'refresh' });
  check.addEventListener('click', () =>
    withBusy(check, async () => {
      try {
        await app.call('vault.sync');
      } catch (e) {
        app.toast(app.errorMessage(e), 'error');
      }
      await app.refresh();
    }),
  );
  const body = h(
    'div',
    { class: 'form' },
    h('p', { class: 'muted', text: 'Your account does not have a password vault yet. Create it in the Ludworks web app — you will choose a master password there. It is separate from your sign-in password and is never sent to the server.' }),
    button('Open the Ludworks web app', { variant: 'primary', block: true, icon: 'external', onClick: () => app.openUrl(`${app.state.serverUrl}/vault`) }),
    check,
    button('Log out', { variant: 'ghost', block: true, icon: 'logout', onClick: () => app.logout() }),
  );
  return authShell(app, 'Set up your vault', '', body, { iconName: 'key', settings: true });
}

/** The pinned certificate no longer matches. */
export function certChangedView(app) {
  const p = app.state.certProblem || {};
  const err = h('div', { class: 'form-error', role: 'alert', hidden: true });
  const presented = typeof p.presented === 'string' && /^[0-9a-f]{64}$/.test(p.presented) ? p.presented : null;
  const ack = h('input', { type: 'checkbox', id: nextId('ack'), class: 'checkbox' });
  const trust = button(presented ? 'Trust new certificate' : 'Forget pinned certificate', { variant: 'danger', block: true });
  trust.disabled = true;
  ack.addEventListener('change', () => {
    trust.disabled = !ack.checked;
  });
  trust.addEventListener('click', () =>
    withBusy(trust, async () => {
      try {
        let st = null;
        if (presented) st = await app.call('server.trust', { serverUrl: app.state.serverUrl, fingerprint: presented });
        else await app.call('server.forgetPin');
        await app.refresh();
        if (st && st.signedOutReason === 'token_exposed') {
          await alertDialog({
            title: 'Sign in again',
            message: 'Your previous sign-in may have been exposed before the certificate change was noticed, so it was revoked. Sign in again to continue.',
            label: 'OK',
          });
        }
      } catch (e) {
        err.textContent = app.errorMessage(e);
        err.hidden = false;
      }
    }),
  );
  const intro = p.unpinned
    ? 'You asked Ludworks to forget the certificate of your server. Confirm the fingerprint it presents now before anything else is sent to it.'
    : 'The certificate presented by your server no longer matches the one you trusted. This is expected after a certificate renewal. If you did not change anything on the server, someone may be intercepting your connection — do not continue.';
  const body = h(
    'div',
    { class: 'form' },
    h('div', { class: p.unpinned ? 'callout callout-warn' : 'callout callout-danger' }, icon('alert', { size: 18 }), h('p', { text: intro })),
    p.tokenExposed
      ? h(
          'div',
          { class: 'callout callout-danger', role: 'alert' },
          icon('alert', { size: 18 }),
          h('p', { text: 'A request carrying this browser’s access token was sent before the different certificate was detected, so the token may have been captured. From a network you trust, open the Ludworks web app → Sessions and revoke the browser extension entry. Trusting the certificate below also revokes the token and signs this browser out.' }),
        )
      : null,
    app.state.pin ? h('details', { class: 'details' }, h('summary', { text: 'Trusted fingerprint' }), fingerprintBlock(app.state.pin.fingerprint)) : null,
    presented ? h('div', null, h('p', { class: 'field-label', text: 'Fingerprint now presented' }), fingerprintBlock(presented)) : h('p', { class: 'muted', text: 'The server no longer provides a certificate fingerprint.' }),
    h('div', { class: 'check-row' }, ack, h('label', { for: ack.id, text: 'I verified the new fingerprint in the Ludworks admin page' })),
    err,
    trust,
    button('Log out', { variant: 'ghost', block: true, icon: 'logout', onClick: () => app.logout() }),
  );
  return authShell(app, p.unpinned ? 'Confirm server certificate' : 'Server certificate changed', '', body, { iconName: 'alert' });
}
