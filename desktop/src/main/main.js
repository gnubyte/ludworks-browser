// Ludworks Browser — main process entry point.
//
// Boot order matters: everything before `app.whenReady()` runs synchronously at startup (scheme
// privileges, command-line switches, profile path, single-instance lock).

import { app, protocol } from 'electron';
import path from 'node:path';
import { APP_NAME, APP_USER_MODEL_ID, profileDirFromArgs, defaultProfileDir } from './paths.js';
import { log, setLogFile } from './util/log.js';

const explicitProfile = profileDirFromArgs(process.argv);
const profileDir = explicitProfile || defaultProfileDir();
import { isSeparateProfile, samePath } from './separate.js';
app.setName(APP_NAME);
app.setPath('userData', profileDir);
setLogFile(path.join(profileDir, 'logs', 'main.log'));

// An exception escaping an event handler would otherwise show Electron's "A JavaScript error occurred
// in the main process" dialog (seen at shutdown). Log it and keep going; startup failures are handled
// by boot() below.
process.on('uncaughtException', (e) => log.error('uncaught exception', e));
process.on('unhandledRejection', (e) => log.warn('unhandled promise rejection', e instanceof Error ? e : { reason: String(e) }));
if (process.platform === 'win32') app.setAppUserModelId(APP_USER_MODEL_ID);

// Remote debugging hands every cookie and open page to whoever connects. Like Chrome 136+, it is
// only honoured for a non-default profile directory (tests, developer profiles): not for the default
// one even when named, nor for a separate-process profile (separate.js), which holds sign-ins too.
if (!explicitProfile || samePath(profileDir, defaultProfileDir()) || isSeparateProfile(profileDir)) {
  for (const sw of ['remote-debugging-port', 'remote-debugging-pipe', 'remote-allow-origins']) app.commandLine.removeSwitch(sw);
}

// Hardware HEVC decode/encode where the platform has it (streaming), mDNS-masked local IPs in WebRTC,
// partitioned third-party storage like current Chrome.
app.commandLine.appendSwitch(
  'enable-features',
  ['PlatformHEVCDecoderSupport', 'PlatformHEVCEncoderSupport', 'WebRtcHideLocalIpsWithMdns', 'ThirdPartyStoragePartitioning'].join(','),
);

protocol.registerSchemesAsPrivileged([
  // Browser UI (tab strip, toolbar, popups). Never loaded in tabs.
  { scheme: 'lwshell', privileges: { standard: true, secure: true, supportFetchAPI: true, codeCache: true } },
  // Internal pages shown in tabs: ludworks://newtab, settings, passwords, bookmarks, history, downloads…
  { scheme: 'ludworks', privileges: { standard: true, secure: true, supportFetchAPI: true, codeCache: true } },
]);

// URLs handed to us before the browser is up (macOS open-url fires very early).
const pendingUrls = [];
let browser = null;
app.on('open-url', (e, url) => {
  e.preventDefault();
  if (browser) browser.openUrls([url]);
  else pendingUrls.push(url);
});

const installerMode = process.argv.includes('--ludworks-integrate') || process.argv.includes('--ludworks-uninstall');
if (installerMode) {
  // Run by the Windows installer / Settings → Apps: register or unregister, then exit.
  (async () => {
    if (process.argv.includes('--ludworks-uninstall') && !app.requestSingleInstanceLock()) {
      await app.whenReady();
      const { dialog } = await import('electron');
      await dialog.showMessageBox({ type: 'warning', title: APP_NAME, message: `Close ${APP_NAME} before uninstalling it.` });
      app.exit(1);
      return;
    }
    const { handleInstallerArgs } = await import('./install-win.js');
    await handleInstallerArgs(process.argv);
    app.exit(0);
  })().catch((e) => {
    log.error('installer integration failed', e);
    app.exit(1);
  });
} else if (!app.requestSingleInstanceLock({ argv: process.argv.slice(1) })) {
  app.quit();
} else {
  boot().catch((e) => {
    log.error('fatal startup error', e);
    app.exit(1);
  });
}

async function boot() {
  // Imported lazily so a second instance exits before loading anything heavy.
  const { Browser } = await import('./browser.js');
  await app.whenReady();
  browser = new Browser({ profileDir, explicitProfile: !!explicitProfile, appDir: path.resolve(import.meta.dirname, '..') });
  app.on('second-instance', (_e, argv, _cwd, extra) => {
    browser.handleCommandLine(extra && Array.isArray(extra.argv) ? extra.argv : argv.slice(1));
  });
  app.on('activate', () => browser.ensureWindow());
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
  app.on('before-quit', () => browser.beforeQuit());
  // Unpackaged runs (electron.exe <app dir> ...) carry the app directory as the first argument.
  await browser.start(process.argv.slice(process.defaultApp ? 2 : 1), pendingUrls.splice(0));
}
