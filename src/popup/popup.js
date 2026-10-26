// Popup application shell: routing by background phase, a small navigation stack, shared helpers.

import { ext } from '../lib/browser.js';
import { parseHttpUrl } from '../lib/url-match.js';
import { call, onBackgroundEvent } from './rpc.js';
import { h, clear, toast, logo, iconButton, alertDialog } from './ui.js';
import { loginView, unlockView, uninitializedView, certChangedView } from './views/auth.js';
import { mainView } from './views/vault.js';

const AUTO_SYNC_MS = 2 * 60 * 1000;

const ERROR_MESSAGES = {
  invalid_credentials: 'Wrong username or password.',
  totp_required: 'Enter your two-step verification code.',
  forbidden: 'This account is disabled or not allowed to sign in.',
  rate_limited: (e) =>
    `Too many attempts. Try again in ${e.retryAfter ? `${e.retryAfter} seconds` : 'a little while'}.`,
  network_error:
    'Could not reach the server. Check the address and your connection. If it uses the default self-signed certificate, open the server in a browser tab and trust its certificate first.',
  timeout: 'The server did not respond in time.',
  setup_required: 'This server has not finished its first-time setup. Open it in a browser tab to complete setup.',
  session_expired: 'Your session expired or was revoked. Please sign in again.',
  not_logged_in: 'Sign in to your Ludworks server first.',
  locked: 'The vault is locked.',
  bad_password: 'Wrong master password.',
  certificate_changed: 'The server certificate changed. Review it before continuing.',
  certificate_unverified: 'Could not verify the server’s certificate, so nothing was sent. Try again.',
  other_host: (e) => e.message,
  token_failed: (e) => e.message,
  conflict: 'This item was changed on another device. Your edit was not saved.',
  quota_exceeded: 'Your storage quota on the server is full.',
  payload_too_large: 'This item is too large to save.',
  no_background: 'The extension background is not responding. Try reopening the popup.',
};

const app = {
  root: /** @type {HTMLElement} */ (document.getElementById('app')),
  /** @type {any} */ state: null,
  /** @type {{id: number, url: string}|null} */ tab: null,
  /** @type {Array<{view: Function, args: any[]}>} */ stack: [],
  /** @type {Array<() => void>} */ cleanups: [],
  ui: { query: '', tab: null },
  call,
  toast,

  /** Friendly message for an error from the background. */
  errorMessage(e) {
    const m = e && ERROR_MESSAGES[e.code];
    if (typeof m === 'function') return m(e);
    return m || (e && e.message) || 'Something went wrong.';
  },

  /** Toast text for a sync that ended in another phase than "unlocked". */
  syncOutcomeMessage(state) {
    if (state.phase === 'locked') return 'Your vault was changed on another device (new master password or reset). Unlock it again.';
    if (state.phase === 'uninitialized') return 'Your vault was deleted in the Ludworks web app.';
    if (state.phase === 'cert_changed') return ERROR_MESSAGES.certificate_changed;
    if (state.phase === 'logged_out') return ERROR_MESSAGES.session_expired;
    return 'Vault synced';
  },

  /**
   * Log out (revokes this browser's token on the server when that can be done safely) and route to the
   * login view. When the token could not be revoked (offline, or the server's certificate is in doubt so
   * the token was not sent), the user is told to revoke it from the web app.
   */
  async logout() {
    let st = null;
    try {
      st = await call('auth.logout');
    } catch {
      st = null;
    }
    await app.refresh();
    if (st && st.serverRevoked === false) {
      await alertDialog({
        title: 'Revoke this browser on the server',
        message: 'You are signed out here, but this browser’s access could not be revoked on the server (it was unreachable, or its certificate could not be verified, so nothing was sent). From a network you trust, open the Ludworks web app → Sessions and revoke the browser extension entry.',
        label: 'Got it',
      });
    }
  },

  /** Active tab's URL when it is a web page, else null. */
  webUrl() {
    return app.tab && parseHttpUrl(app.tab.url) ? app.tab.url : null;
  },

  /** Register a function to run when the current view is left. */
  onLeave(fn) {
    app.cleanups.push(fn);
  },

  async renderTop() {
    for (const fn of app.cleanups.splice(0)) {
      try {
        fn();
      } catch {
        /* ignore */
      }
    }
    const top = app.stack[app.stack.length - 1];
    if (!top) return;
    let node;
    try {
      node = await top.view(app, ...top.args);
    } catch (e) {
      if (e && (e.code === 'locked' || e.code === 'session_expired' || e.code === 'not_logged_in' || e.code === 'certificate_changed')) {
        await app.refresh();
        return;
      }
      node = h('div', { class: 'view' }, app.header({ title: 'Error', back: app.stack.length > 1 }), h('div', { class: 'view-body' }, h('p', { class: 'form-error', role: 'alert', text: app.errorMessage(e) })));
    }
    if (app.stack[app.stack.length - 1] !== top) return; // navigated away meanwhile
    clear(app.root);
    app.root.append(node);
    const auto = app.root.querySelector('[autofocus]');
    if (auto) auto.focus();
  },

  /** Push a view. */
  async go(view, ...args) {
    app.stack.push({ view, args });
    await app.renderTop();
  },

  /** Replace the current view. */
  async replace(view, ...args) {
    app.stack[app.stack.length - 1] = { view, args };
    await app.renderTop();
  },

  /** Pop back one view (or to the root when `toRoot`). */
  async back(toRoot = false) {
    if (app.stack.length > 1) {
      if (toRoot) app.stack.length = 1;
      else app.stack.pop();
    }
    await app.renderTop();
  },

  /** Reload background state and route to the view for the current phase. */
  async refresh() {
    try {
      app.state = await call('state');
    } catch (e) {
      clear(app.root);
      app.root.append(h('div', { class: 'view' }, h('div', { class: 'view-body center' }, h('p', { class: 'form-error', role: 'alert', text: app.errorMessage(e) }))));
      return;
    }
    const views = {
      logged_out: loginView,
      cert_changed: certChangedView,
      uninitialized: uninitializedView,
      locked: unlockView,
      unlocked: mainView,
    };
    app.stack = [{ view: views[app.state.phase] || loginView, args: [] }];
    await app.renderTop();
    // Keep the encrypted cache fresh without blocking the UI; a 'synced' event re-renders the list and
    // problems (certificate change, revoked session) arrive as phase changes.
    if (app.state.phase === 'unlocked' && (!app.state.lastSyncAt || Date.now() - app.state.lastSyncAt > AUTO_SYNC_MS)) {
      call('vault.sync').catch(() => {});
    }
  },

  /**
   * Standard header bar.
   * @param {{title?: string, back?: boolean, brand?: boolean, actions?: Node[]}} p
   */
  header({ title = '', back = false, brand = false, actions = [] }) {
    const left = h('div', { class: 'header-left' });
    if (back) left.append(iconButton('back', 'Back', () => app.back()));
    if (brand) left.append(logo(26));
    left.append(h('h1', { class: 'header-title', text: title }));
    return h('header', { class: 'header' }, left, h('div', { class: 'header-actions' }, actions));
  },

  /** Copy to clipboard and schedule the 30 s auto-clear. */
  async copy(value, what) {
    if (!value) return;
    let ok = false;
    try {
      await navigator.clipboard.writeText(value);
      ok = true;
    } catch {
      const ta = h('textarea', { class: 'sr-only', 'aria-hidden': 'true' });
      ta.value = value;
      document.body.append(ta);
      ta.select();
      try {
        ok = document.execCommand('copy');
      } finally {
        ta.value = '';
        ta.remove();
      }
    }
    if (!ok) {
      toast('Copy failed.', 'error');
      return;
    }
    call('clipboard.copied').catch(() => {});
    toast(`${what} copied — clipboard clears in 30 s`, 'success');
  },

  /** Open an http(s) URL in a new tab. */
  async openUrl(url) {
    const u = parseHttpUrl(url);
    if (!u) {
      toast('Only http(s) links can be opened.', 'error');
      return;
    }
    await ext.tabs.create({ url: u.href });
    window.close();
  },
};

onBackgroundEvent((event) => {
  if (!app.state) return;
  if (event === 'locked' || event === 'logged_out' || event === 'unlocked') {
    app.refresh();
  } else if (event === 'state') {
    call('state')
      .then((s) => {
        const phaseChanged = s.phase !== app.state.phase;
        app.state = s;
        if (phaseChanged) app.refresh();
      })
      .catch(() => {});
  } else if ((event === 'synced' || event === 'items') && app.stack.length === 1 && app.state.phase === 'unlocked') {
    app.renderTop();
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && app.stack.length > 1 && !document.querySelector('dialog[open]')) {
    e.preventDefault();
    app.back();
  }
});

async function boot() {
  try {
    const tabs = await ext.tabs.query({ active: true, currentWindow: true });
    const t = tabs && tabs[0];
    app.tab = t && typeof t.id === 'number' ? { id: t.id, url: t.url || '' } : null;
  } catch {
    app.tab = null;
  }
  await app.refresh();
}

boot();
