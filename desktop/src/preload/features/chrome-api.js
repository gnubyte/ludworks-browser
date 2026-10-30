// `window.chrome` as every Chromium page has it. Electron hands pages an empty `window.chrome`, and Google's
// sign-in turns such a browser away ("Couldn't sign you in — This browser or app may not be secure"). Measured
// on accounts.google.com with a made-up address: the missing `chrome.app` alone decides it (with it Google
// answers "Couldn't find this account"); the Sec-CH-UA headers Electron does not send made no difference.
// `chrome.csi` and `chrome.loadTimes` complete the set Chromium's renderer adds. Nothing a page already has
// is replaced.
//
// Installed with contextBridge.executeInMainWorld, before the page's own scripts run.

export function setupChromeApi() {
  const { contextBridge } = require('electron');
  if (typeof contextBridge.executeInMainWorld === 'function') contextBridge.executeInMainWorld({ func: installChromeApi });
}

// ---------------------------------------------------------------------------------------------------
// Runs in the page's main world. Must be self-contained (it is serialised): no outer references.
export function installChromeApi() {
  if (!window.chrome || typeof window.chrome !== 'object') {
    try {
      Object.defineProperty(window, 'chrome', { value: {}, writable: true, enumerable: true, configurable: false });
    } catch {
      return;
    }
  }
  const chrome = window.chrome;
  const def = (obj, name, value) => Object.defineProperty(obj, name, { value, writable: true, enumerable: true, configurable: true });
  const secs = (ms) => ms / 1000;
  try {
    if (!chrome.loadTimes) {
      def(chrome, 'loadTimes', {
        loadTimes() {
          const t = performance.timing;
          const nav = performance.getEntriesByType('navigation')[0];
          const proto = (nav && nav.nextHopProtocol) || 'http/1.1';
          const spdy = proto === 'h2' || proto === 'h3';
          return {
            requestTime: secs(t.requestStart),
            startLoadTime: secs(t.requestStart),
            commitLoadTime: secs(t.responseStart),
            finishDocumentLoadTime: secs(t.domContentLoadedEventEnd),
            finishLoadTime: secs(t.loadEventEnd),
            firstPaintTime: 0,
            firstPaintAfterLoadTime: 0,
            navigationType: 'Other',
            wasFetchedViaSpdy: spdy,
            wasNpnNegotiated: spdy,
            npnNegotiatedProtocol: spdy ? proto : 'unknown',
            wasAlternateProtocolAvailable: false,
            connectionInfo: proto,
          };
        },
      }.loadTimes);
    }
    if (!chrome.csi) {
      def(chrome, 'csi', {
        csi() {
          const t = performance.timing;
          return { startE: t.navigationStart, onloadT: t.domContentLoadedEventEnd, pageT: performance.now(), tran: 15 };
        },
      }.csi);
    }
    if (!chrome.app) {
      def(chrome, 'app', {
        isInstalled: false,
        getDetails() {
          return null;
        },
        getIsInstalled() {
          return false;
        },
        installState(callback) {
          if (typeof callback !== 'function') throw new TypeError('Error in invocation of app.installState(function callback)');
          setTimeout(() => callback('not_installed'), 0);
        },
        runningState() {
          return 'cannot_run';
        },
        InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
        RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' },
      });
    }
  } catch {
    /* a frozen window.chrome: the page keeps what it has */
  }
}
