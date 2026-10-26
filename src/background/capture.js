// "Offer to save new logins": an optional feature. When the user enables it, the popup requests the
// optional host permissions below at runtime; the background then registers content/capture.js for HTTPS
// pages (and http://localhost). Disabling it unregisters the script and the popup releases the permission.

export const CAPTURE_SCRIPT_ID = 'ludworks-capture';
export const CAPTURE_ORIGINS = Object.freeze(['https://*/*', 'http://localhost/*', 'http://127.0.0.1/*']);

/**
 * Make the registered content scripts match the setting + granted permission.
 * @param {any} ext
 * @param {boolean} enabled
 * @returns {Promise<boolean>} whether capture is active
 */
export async function syncCaptureRegistration(ext, enabled) {
  let granted = false;
  if (enabled) {
    try {
      granted = await ext.permissions.contains({ origins: [...CAPTURE_ORIGINS] });
    } catch {
      granted = false;
    }
  }
  let registered = [];
  try {
    registered = await ext.scripting.getRegisteredContentScripts({ ids: [CAPTURE_SCRIPT_ID] });
  } catch {
    registered = [];
  }
  if (granted && registered.length === 0) {
    await ext.scripting.registerContentScripts([
      {
        id: CAPTURE_SCRIPT_ID,
        js: ['content/capture.js'],
        matches: [...CAPTURE_ORIGINS],
        runAt: 'document_idle',
        allFrames: false,
        persistAcrossSessions: true,
      },
    ]);
  } else if (!granted && registered.length > 0) {
    await ext.scripting.unregisterContentScripts({ ids: [CAPTURE_SCRIPT_ID] });
  }
  return granted;
}
