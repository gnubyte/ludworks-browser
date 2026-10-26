// Popup <-> background messaging.

import { ext } from '../lib/browser.js';

/** Error returned by the background (code/message/details mirror the server's error envelope). */
export class RpcError extends Error {
  constructor({ code = 'internal', message = 'Unexpected error', details, status = 0, retryAfter = null } = {}) {
    super(message);
    this.name = 'RpcError';
    this.code = code;
    this.details = details;
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

/**
 * Send a typed request to the background and unwrap {ok, data|error}.
 * @param {string} type
 * @param {Record<string, any>} [payload]
 */
export async function call(type, payload = {}) {
  let res;
  try {
    res = await ext.runtime.sendMessage({ type, ...payload });
  } catch (e) {
    throw new RpcError({ code: 'no_background', message: `The extension background is not responding (${(e && e.message) || e}).` });
  }
  if (!res || typeof res !== 'object') throw new RpcError({ code: 'no_response', message: 'No response from the extension background.' });
  if (!res.ok) throw new RpcError(res.error || {});
  return res.data;
}

/**
 * Ask for (or confirm) host permission for the server origin. MUST be called synchronously from a user
 * gesture handler; resolves immediately without a prompt when the permission is already granted.
 * @param {string|null} serverUrl
 * @returns {Promise<boolean>}
 */
export function requestServerPermission(serverUrl) {
  if (!serverUrl) return Promise.resolve(false);
  try {
    const u = new URL(serverUrl);
    return Promise.resolve(ext.permissions.request({ origins: [`${u.protocol}//${u.hostname}/*`] })).catch(() => false);
  } catch {
    return Promise.resolve(false);
  }
}

/**
 * Subscribe to background events ({event: 'locked'|'unlocked'|'synced'|'items'|'state'|'logged_out'}).
 * Only messages from this extension (not from tabs/content scripts) are accepted.
 * @param {(event: string) => void} fn
 */
export function onBackgroundEvent(fn) {
  ext.runtime.onMessage.addListener((msg, sender) => {
    if (!sender || sender.id !== ext.runtime.id || sender.tab) return false;
    if (msg && typeof msg.event === 'string') fn(msg.event);
    return false;
  });
}
