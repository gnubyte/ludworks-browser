// Ludworks Browser — main process entry point.
//
// Boot order matters: everything before `app.whenReady()` runs synchronously at startup (scheme
// privileges, command-line switches, profile path, single-instance lock).

import { app, dialog, protocol } from 'electron';
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { packageDisplayName, packageRedirectingWrites } from './package-storage.js';
import { APP_NAME, APP_USER_MODEL_ID, profileDirFromArgs, defaultProfileDir, inDefaultProfile } from './paths.js';
import { log, setLogFile } from './util/log.js';

const explicitProfile = profileDirFromArgs(process.argv);
const profileDir = explicitProfile || defaultProfileDir();
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
// one even when named, nor for a folder inside it, which holds sign-ins too.
if (!explicitProfile || inDefaultProfile(profileDir)) {
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
} else if (refuseForeignPackage()) {
  // Started inside another app's package: only offers a normal start, see below.
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
  app.on('before-quit', (e) => browser.beforeQuit(e));
  // Unpackaged runs (electron.exe <app dir> ...) carry the app directory as the first argument.
  await browser.start(process.argv.slice(process.defaultApp ? 2 : 1), pendingUrls.splice(0));
}

/**
 * Started inside another app's Windows package (package-storage.js), the default profile would partly land in that
 * app's private storage, so the browser refuses to run there. A running browser has already taken this command line
 * through the single-instance lock above; otherwise the lock and the profile are let go before Chromium opens
 * anything, and the user may start the browser normally through Explorer, whose shell instance launches programs in
 * the user's own context. Returns true when this process must not start the browser.
 */
function refuseForeignPackage() {
  // a --profile naming the default profile (or a folder inside it) is checked like no --profile
  if ((explicitProfile && !inDefaultProfile(profileDir)) || process.platform !== 'win32' || process.defaultApp) return false;
  const pkg = packageRedirectingWrites(profileDir);
  if (!pkg) return false;
  log.info('started inside another app package', { package: pkg });
  app.releaseSingleInstanceLock();
  // Chromium still needs a profile to show the dialog: a throwaway one (earlier refusals' are removed).
  const tmp = os.tmpdir();
  for (const name of readdirSync(tmp).filter((n) => n.startsWith('ludworks-browser-refused-'))) {
    try {
      rmSync(path.join(tmp, name), { recursive: true, force: true });
    } catch {
      /* still showing its dialog */
    }
  }
  app.setPath('userData', mkdtempSync(path.join(tmp, 'ludworks-browser-refused-')));
  app.whenReady().then(() => {
    const owner = packageDisplayName(pkg);
    const choice = dialog.showMessageBoxSync({
      type: 'warning',
      title: APP_NAME,
      message: `Open ${APP_NAME} from the Start menu or the taskbar`,
      detail: `${owner} started it inside its own app package, where Windows would keep your sign-ins, history and settings in ${owner}'s storage instead of your profile.`,
      buttons: ['Open normally', 'Close'],
      defaultId: 0,
      cancelId: 1,
    });
    if (choice === 0) {
      const explorer = path.join(process.env.SystemRoot || 'C:\\Windows', 'explorer.exe');
      spawn(explorer, [process.execPath], { detached: true, stdio: 'ignore' }).unref();
    }
    app.exit(0);
  });
  return true;
}
