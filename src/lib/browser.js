// WebExtension namespace shim: Firefox exposes promise-based `browser`, Chrome MV3 `chrome` (also promise-based).

/** @type {any} */
export const ext = globalThis.browser && globalThis.browser.runtime ? globalThis.browser : globalThis.chrome;
