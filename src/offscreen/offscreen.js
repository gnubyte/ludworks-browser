// Chrome-only offscreen document (reason CLIPBOARD): the MV3 service worker has no DOM, so clearing the
// clipboard after the 30 s timeout happens here. Only accepts messages from this extension.

const ext = globalThis.chrome;

function clearClipboard() {
  let done = false;
  const handler = (e) => {
    e.preventDefault();
    e.clipboardData.setData('text/plain', '');
    done = true;
  };
  document.addEventListener('copy', handler, { capture: true, once: true });
  try {
    document.execCommand('copy');
  } finally {
    document.removeEventListener('copy', handler, { capture: true });
  }
  return done;
}

ext.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target !== 'offscreen' || !sender || sender.id !== ext.runtime.id) return false;
  if (msg.type === 'clipboard.clear') sendResponse({ ok: clearClipboard() });
  return false;
});
