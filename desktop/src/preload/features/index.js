// Web page features of the tab preload (bundled into preload/content.cjs by desktop/build.mjs).
import { setupAutofill } from './autofill.js';
import { setupWebAuthn } from './webauthn.js';

if (location.protocol === 'https:' || location.protocol === 'http:') {
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
}
