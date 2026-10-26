// Clipboard auto-clear. The popup copies with navigator.clipboard (user gesture) and then asks the background
// to clear the clipboard 30 s later — after the popup itself has usually been closed.
//  * Chrome: the service worker has no DOM, so an offscreen document (reason CLIPBOARD) performs the clear.
//  * Firefox: the background event page has a DOM and the clipboardWrite permission.
// Limitations (documented in README): the clear is unconditional (we do not request clipboardRead to check
// whether the clipboard still holds our value), it relies on chrome.alarms (30 s minimum in Chrome), and if
// the browser is closed before the alarm fires the value stays on the OS clipboard.

export const CLIPBOARD_ALARM = 'ludworks-clipboard-clear';
export const CLIPBOARD_CLEAR_MS = 30000;
const OFFSCREEN_PATH = 'offscreen/offscreen.html';

/**
 * @param {any} ext
 * @param {() => number} [now]
 */
export async function scheduleClipboardClear(ext, now = () => Date.now()) {
  await ext.alarms.create(CLIPBOARD_ALARM, { when: now() + CLIPBOARD_CLEAR_MS });
}

function clearWithCopyEvent(doc) {
  let done = false;
  const handler = (e) => {
    e.preventDefault();
    e.clipboardData.setData('text/plain', '');
    done = true;
  };
  doc.addEventListener('copy', handler, { capture: true, once: true });
  try {
    doc.execCommand('copy');
  } finally {
    doc.removeEventListener('copy', handler, { capture: true });
  }
  return done;
}

/**
 * Clear the clipboard now (called from the alarm handler).
 * @param {any} ext
 */
export async function clearClipboard(ext) {
  if (ext.offscreen && typeof ext.offscreen.createDocument === 'function') {
    try {
      await ext.offscreen.createDocument({
        url: OFFSCREEN_PATH,
        reasons: ['CLIPBOARD'],
        justification: 'Clear copied passwords from the clipboard after 30 seconds.',
      });
    } catch (e) {
      if (!/single offscreen|already/i.test(String((e && e.message) || e))) throw e;
    }
    try {
      await ext.runtime.sendMessage({ target: 'offscreen', type: 'clipboard.clear' });
    } finally {
      try {
        await ext.offscreen.closeDocument();
      } catch {
        /* already closed */
      }
    }
    return;
  }
  if (globalThis.navigator && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    try {
      await navigator.clipboard.writeText('');
      return;
    } catch {
      /* fall back to execCommand below */
    }
  }
  if (globalThis.document) clearWithCopyEvent(globalThis.document);
}

export const _internals = { clearWithCopyEvent };
