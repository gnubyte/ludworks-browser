// Settings: lock timeout, offer-to-save, server + certificate pin, account and local data.

import { ext } from '../../lib/browser.js';
import { LOCK_MINUTES } from '../../lib/messages.js';
import { formatFingerprint } from '../../lib/fingerprint.js';
import { h, icon, button, withBusy, toggle, confirmDialog, relativeTime, nextId } from '../ui.js';
import { requestServerPermission } from '../rpc.js';

const CAPTURE_ORIGINS = ['https://*/*', 'http://localhost/*', 'http://127.0.0.1/*'];

function lockLabel(m) {
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'}`;
  return `${m / 60} hour${m === 60 ? '' : 's'}`;
}

function sectionEl(title, ...children) {
  return h('section', { class: 'card-section settings-section' }, h('h2', { class: 'section-title', text: title }), children);
}

function info(label, value, { mono = false } = {}) {
  return h('div', { class: 'kv kv-static' }, h('div', { class: 'kv-main' }, h('div', { class: 'kv-label', text: label }), h('div', { class: ['kv-value', mono && 'mono small'], text: value })));
}

export async function settingsView(app) {
  const s = await app.call('state');
  app.state = s;
  const settings = s.settings;
  const isFirefox = s.browser === 'firefox';
  const signedIn = s.phase !== 'logged_out';

  // --- security
  const lockId = nextId('lock');
  const lockSel = h('select', { id: lockId, class: 'select' });
  for (const m of LOCK_MINUTES) lockSel.append(h('option', { value: String(m), text: lockLabel(m), selected: m === settings.lockMinutes }));
  lockSel.addEventListener('change', async () => {
    try {
      await app.call('settings.update', { lockMinutes: Number(lockSel.value) });
      app.toast('Lock timeout saved', 'success');
    } catch (e) {
      app.toast(app.errorMessage(e), 'error');
    }
  });

  const security = sectionEl(
    'Security',
    h('div', { class: 'field' }, h('label', { for: lockId, class: 'field-label', text: 'Lock the vault after inactivity' }), lockSel,
      h('div', { class: 'field-hint', text: 'The vault also locks when your computer locks or goes idle, and whenever the browser restarts. The decrypted vault key lives only in memory.' })),
    s.phase === 'unlocked'
      ? button('Lock now', { variant: 'secondary', icon: 'lock', onClick: async () => { await app.call('vault.lock'); await app.refresh(); } })
      : null,
  );

  // --- autofill
  const saveToggle = toggle(
    'Offer to save new logins',
    settings.saveLogins,
    (checked, input) => {
      if (checked) {
        // permissions.request must run synchronously in the click handler.
        let p;
        try {
          p = ext.permissions.request({ origins: CAPTURE_ORIGINS });
        } catch (e) {
          p = Promise.reject(e);
        }
        p.then(
          async (granted) => {
            if (!granted) {
              input.checked = false;
              app.toast('Permission was not granted; the feature stays off.', 'error');
              return;
            }
            const res = await app.call('settings.update', { saveLogins: true });
            input.checked = !!res.saveLogins;
            app.toast(res.saveLogins ? 'Ludworks will offer to save new logins' : 'Could not enable the feature', res.saveLogins ? 'success' : 'error');
          },
          () => {
            input.checked = false;
          },
        );
      } else {
        app
          .call('settings.update', { saveLogins: false })
          .then(() => ext.permissions.remove({ origins: CAPTURE_ORIGINS }))
          .then(async () => {
            // Removing the broad pattern can also drop the server's own host permission in some browsers.
            const u = s.serverUrl ? new URL(s.serverUrl) : null;
            const still = !u || (await ext.permissions.contains({ origins: [`${u.protocol}//${u.hostname}/*`] }));
            app.toast(still ? 'Offer to save turned off' : 'Offer to save turned off. Click “Sync now” to reconnect to your server.', 'success');
          })
          .catch((e) => app.toast(app.errorMessage(e), 'error'));
      }
    },
    'Needs permission to read HTTPS pages. Ludworks only looks at login fields when you submit a form, and asks before saving anything.',
  );
  const shortcutsHint = isFirefox
    ? 'Change shortcuts in about:addons → gear menu → Manage Extension Shortcuts.'
    : 'Change shortcuts at chrome://extensions/shortcuts.';
  const autofill = sectionEl(
    'Autofill',
    saveToggle,
    h('div', { class: 'kbd-list' },
      h('div', { class: 'kbd-row' }, h('span', { text: 'Open Ludworks' }), h('kbd', { text: 'Ctrl+Shift+L' })),
      h('div', { class: 'kbd-row' }, h('span', { text: 'Fill best match on this page' }), h('kbd', { text: 'Ctrl+Shift+F' })),
    ),
    h('p', { class: 'field-hint', text: `${shortcutsHint} Ludworks fills only after you click Fill or press the shortcut, only on HTTPS pages, only into visible fields, and only when the page matches the login’s website rules.` }),
  );

  // --- server
  let server = null;
  if (signedIn) {
    const pinText = s.pin ? formatFingerprint(s.pin.fingerprint) : 'Not pinned';
    let pinStatus;
    if (!s.pin) pinStatus = s.serverUrl && s.serverUrl.startsWith('http:') ? 'Plain HTTP on localhost — no certificate to pin.' : 'No fingerprint was available when you signed in (for example TLS terminated by a reverse proxy). The browser’s certificate validation protects the connection.';
    else if (s.pin.source === 'tls') pinStatus = `${s.certCheck && s.certCheck.verified ? `Pinned. Firefox verified the certificate ${relativeTime(s.certCheck.at)}.` : 'Pinned.'} Firefox checks the certificate on every response; your access token is only sent right after the pinned certificate was seen.`;
    else pinStatus = 'Pinned to the fingerprint your server reports. Chrome extensions cannot read certificates, so this detects certificate changes; the browser’s certificate validation protects the connection.';
    const syncBtn = button('Sync now', { variant: 'secondary', icon: 'refresh' });
    syncBtn.addEventListener('click', () => {
      const permission = requestServerPermission(s.serverUrl);
      return withBusy(syncBtn, async () => {
        try {
          await permission;
          const st = await app.call('vault.sync');
          if (st && st.phase !== 'unlocked' && st.phase !== s.phase) {
            app.toast(app.syncOutcomeMessage(st), 'info');
            await app.refresh();
            return;
          }
          app.toast('Vault synced', 'success');
          await app.replace(settingsView);
        } catch (e) {
          app.toast(app.errorMessage(e), 'error');
          if (['certificate_changed', 'session_expired'].includes(e.code)) await app.refresh();
        }
      });
    });
    server = sectionEl(
      'Server',
      info('Server', s.serverName ? `${s.serverName} — ${s.serverUrl}` : s.serverUrl),
      info('Signed in as', s.user ? (s.user.displayName && s.user.displayName !== s.user.username ? `${s.user.displayName} (${s.user.username})` : s.user.username) : '—'),
      info('Certificate (SHA-256)', pinText, { mono: !!s.pin }),
      h('p', { class: 'field-hint', text: pinStatus }),
      s.pin
        ? button('Forget pinned certificate', {
            variant: 'ghost',
            onClick: async () => {
              const ok = await confirmDialog({ title: 'Forget the pinned certificate?', message: 'You will be asked to confirm the server fingerprint again the next time you sign in or unlock.', confirmLabel: 'Forget' });
              if (!ok) return;
              await app.call('server.forgetPin');
              await app.replace(settingsView);
            },
          })
        : null,
      info('Last sync', relativeTime(s.lastSyncAt)),
      h('div', { class: 'btn-row' }, syncBtn, button('Open web app', { variant: 'secondary', icon: 'external', onClick: () => app.openUrl(`${s.serverUrl}/`) })),
      button('Log out', {
        variant: 'ghost',
        icon: 'logout',
        onClick: async () => {
          const ok = await confirmDialog({ title: 'Log out?', message: 'This revokes this browser’s access on the server and removes the cached encrypted vault from this browser.', confirmLabel: 'Log out' });
          if (!ok) return;
          await app.logout();
        },
      }),
    );
  }

  // --- data & about
  const data = sectionEl(
    'Data',
    h('p', { class: 'field-hint', text: 'Copied secrets are cleared from the clipboard after 30 seconds. The clear is unconditional and cannot happen if the browser is closed first.' }),
    button('Clear all local data', {
      variant: 'danger',
      icon: 'trash',
      onClick: async () => {
        const ok = await confirmDialog({ title: 'Clear all local data?', message: 'Removes your sign-in, the cached encrypted vault, pinned certificates and settings from this browser. Your vault on the server is not touched.', confirmLabel: 'Clear data', danger: true });
        if (!ok) return;
        await app.call('data.clear');
        ext.permissions.remove({ origins: CAPTURE_ORIGINS }).catch(() => {});
        await app.refresh();
      },
    }),
  );
  const about = sectionEl(
    'About',
    info('Version', `${s.version} (${isFirefox ? 'Firefox' : s.browser === 'chrome' ? 'Chrome' : s.browser})`),
    h('p', { class: 'field-hint' }, icon('shield', { size: 14 }), ' End-to-end encrypted: your master password and decrypted vault never leave this device. No remote favicons, no analytics.'),
  );

  return h(
    'div',
    { class: 'view view-settings' },
    app.header({ title: 'Settings', back: app.stack.length > 1 }),
    h('main', { class: 'view-body' }, security, autofill, server, data, about),
  );
}
