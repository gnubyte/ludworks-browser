// Message routing for the background: sender classification + schema validation + dispatch to the core.
// Browser-specific side effects are injected so the same code runs in the extension, in unit tests and in
// the dev preview harness (scripts/dev/preview.mjs).

import { ApiError } from '../lib/api.js';
import { POPUP_SCHEMAS, CONTENT_SCHEMAS, validateMessage, classifySender } from '../lib/messages.js';

/**
 * Serialize an error for the {ok:false, error} response envelope (no stacks, details JSON-safe).
 * @param {any} e
 */
export function errorPayload(e) {
  if (e && typeof e.code === 'string') {
    let details;
    try {
      details = e.details === undefined ? undefined : JSON.parse(JSON.stringify(e.details));
    } catch {
      details = undefined;
    }
    return { code: e.code, message: String(e.message || e.code), status: e.status || 0, retryAfter: e.retryAfter ?? null, details };
  }
  return { code: 'internal', message: 'Unexpected error in the extension.', status: 0, retryAfter: null };
}

/**
 * @param {{
 *   core: ReturnType<typeof import('./core.js').createCore>,
 *   runtimeId: string,
 *   extensionOrigin: string,
 *   fill: (id: string, allowInsecure: boolean, allowOtherHost: boolean) => Promise<any>,
 *   onActivity?: () => Promise<void>,
 *   onSettingsChanged?: (patch: object, settings: object) => Promise<object>,
 *   onClipboardCopied?: () => Promise<void>,
 *   onClearData?: () => Promise<void>,
 *   onCaptureBadge?: (tabId: number, pending: boolean) => Promise<void>,
 * }} deps
 * @returns {(msg: any, sender: any) => Promise<any>}
 */
export function createMessageHandler(deps) {
  const { core } = deps;
  const noop = async () => {};
  const onActivity = deps.onActivity || noop;
  const onCaptureBadge = deps.onCaptureBadge || noop;
  const badge = (tabId, on) => Promise.resolve().then(() => onCaptureBadge(tabId, on)).catch(() => {});
  /** Show (or clear) the toolbar badge that tells the user a captured login waits in the popup. */
  const refreshBadge = async (tabId) => {
    const p = await core.capturePending({ tabId });
    await badge(tabId, !!p.show);
    return p;
  };

  const popup = {
    'state': () => core.getState(),
    'server.probe': (m) => core.probeServer(m.serverUrl),
    'server.trust': (m) => core.trustServer(m.serverUrl, m.fingerprint),
    'server.forgetPin': () => core.forgetPin(),
    'auth.login': (m) =>
      core.login({ serverUrl: m.serverUrl, username: m.username, password: m.password, totpCode: m.totpCode, recoveryCode: m.recoveryCode }),
    'auth.logout': () => core.logout(),
    'vault.unlock': (m) => core.unlock(m.password),
    'vault.lock': () => core.lock(),
    'vault.sync': async () => {
      // sync() re-reads the vault parameters itself (and locks on a re-keyed vault); when locked only the
      // parameters matter ("Check again" after the vault was created in the web app).
      if (await core.isUnlocked()) await core.sync();
      else await core.refreshVaultMeta();
      return core.getState();
    },
    'items.list': (m) => core.listItems({ url: m.url || null }),
    'items.get': (m) => core.getItem(m.id),
    'items.save': (m) => core.saveItem({ id: m.id || null, folderId: m.folderId, data: m.data, baseRevision: m.baseRevision }),
    'items.delete': (m) => core.deleteItem(m.id),
    'fill.item': (m) => deps.fill(m.id, m.allowInsecure === true, m.allowOtherHost === true),
    'capture.get': (m) => refreshBadge(m.tabId),
    'capture.confirm': async (m) => {
      const r = await core.captureDecision({ tabId: m.tabId, id: m.id, decision: m.decision });
      await refreshBadge(m.tabId);
      return r;
    },
    'settings.update': async (m) => {
      const s = await core.updateSettings(m);
      return deps.onSettingsChanged ? deps.onSettingsChanged(m, s) : s;
    },
    'clipboard.copied': async () => {
      if (deps.onClipboardCopied) await deps.onClipboardCopied();
      return true;
    },
    'data.clear': async () => {
      if (deps.onClearData) await deps.onClearData().catch(() => {});
      return core.clearAllData();
    },
  };

  // Content scripts get nothing back (null): whether a login is now pending must not be observable from
  // the page side. The user is told through the toolbar badge and decides in the popup.
  const content = {
    'capture.submitted': async (m, s) => {
      const r = await core.captureSubmitted({ tabId: s.tab.id, pageUrl: s.url, username: m.username, password: m.password });
      if (r.pending) await badge(s.tab.id, true);
      return null;
    },
    // a page load in a tab with a waiting capture (Firefox resets per-tab badges on navigation)
    'capture.loaded': async (m, s) => {
      await refreshBadge(s.tab.id);
      return null;
    },
  };

  return async function handleMessage(msg, sender) {
    const kind = classifySender(sender, { runtimeId: deps.runtimeId, extensionOrigin: deps.extensionOrigin });
    if (kind === 'extension') {
      const v = validateMessage(msg, POPUP_SCHEMAS);
      if (!v.ok) throw new ApiError({ code: 'bad_message', message: v.error });
      await onActivity();
      return popup[msg.type](msg, sender);
    }
    if (kind === 'content') {
      const v = validateMessage(msg, CONTENT_SCHEMAS);
      if (!v.ok) throw new ApiError({ code: 'bad_message', message: v.error });
      return content[msg.type](msg, sender);
    }
    throw new ApiError({ code: 'forbidden', message: 'Message sender is not allowed.' });
  };
}
