// Web page features of the tab preload (bundled into preload/content.cjs by desktop/build.mjs).
import { setupAutofill } from './autofill.js';
import { setupChromeApi } from './chrome-api.js';
import { setupWebAuthn } from './webauthn.js';
import { setupBlocker } from './blocker.js';
import { setupMedia } from './media.js';
import { setupRecorder } from './recorder.js';

if (location.protocol === 'https:' || location.protocol === 'http:') {
  try {
    setupBlocker(); // first: scriptlets must run before page scripts
  } catch {
    /* keep the page working without the content blocker */
  }
  try {
    setupChromeApi(); // Google sign-in refuses a Chromium without window.chrome.app
  } catch {
    /* the page keeps Electron's empty window.chrome */
  }
  try {
    setupWebAuthn();
  } catch {
    /* keep the page working without Ludworks passkeys */
  }
  try {
    setupAutofill();
  } catch {
    /* keep the page working without autofill */
  }
  setupMedia(); // image/video saver: idle until the user opens it (never throws)
  setupRecorder(); // "Record video from now": idle until the user starts it (never throws)
}
