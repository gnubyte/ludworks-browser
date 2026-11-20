// Windows integration, run by the installer (--ludworks-integrate) and by "Uninstall" in
// Settings → Apps (--ludworks-uninstall). Per-user only (HKCU): no administrator rights needed.
// The MSI (packaging/windows) integrates with --msi (no uninstall entry of our own: Windows Installer
// has one) and undoes it with --ludworks-unintegrate before removing the files itself.
//
// Registers the browser like Chrome does: ProgIDs for documents and URLs (with --single-argument so
// a crafted URL can never inject command-line switches), StartMenuInternet + Capabilities +
// RegisteredApplications (so it appears in Settings → Default apps), App Paths, the uninstall
// entry, and Start menu / desktop shortcuts carrying the AppUserModelID (taskbar grouping, toasts).

import { app, shell, dialog } from 'electron';
import { execFile, spawn } from 'node:child_process';
import { existsSync, rmSync, statSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { APP_NAME, APP_USER_MODEL_ID, defaultProfileDir } from './paths.js';

const PROGID_HTML = 'LudworksBrowserHTML';
const PROGID_URL = 'LudworksBrowserURL';
const CLIENT_KEY = `HKCU\\Software\\Clients\\StartMenuInternet\\${APP_NAME}`;
const UNINSTALL_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\LudworksBrowser';
const FILE_TYPES = ['.htm', '.html', '.shtml', '.xht', '.xhtml', '.svg', '.webp', '.pdf'];
const URL_TYPES = ['http', 'https'];

function reg(args) {
  return new Promise((resolve, reject) => {
    execFile('reg.exe', args, { windowsHide: true, timeout: 15000 }, (err, _out, stderr) => (err ? reject(new Error(`reg ${args.join(' ')}: ${stderr || err.message}`)) : resolve()));
  });
}
const set = (key, name, value, type = 'REG_SZ') => reg(['add', key, ...(name === null ? ['/ve'] : ['/v', name]), '/t', type, '/d', String(value), '/f']);
const del = (key) => reg(['delete', key, '/f']).catch(() => {});

function dirSizeKb(dir) {
  let total = 0;
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else total += statSync(p).size;
    }
  };
  try {
    walk(dir);
  } catch {
    /* best effort */
  }
  return Math.round(total / 1024);
}

function shortcutPaths() {
  const startMenu = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', `${APP_NAME}.lnk`);
  const desktop = path.join(app.getPath('desktop'), `${APP_NAME}.lnk`);
  return { startMenu, desktop };
}

export async function integrate({ desktopShortcut = true, uninstallEntry = true } = {}) {
  const exe = process.execPath;
  const dir = path.dirname(exe);
  const icon = `${exe},0`;
  const open = `"${exe}" --single-argument %1`;
  for (const [progid, label] of [[PROGID_HTML, `${APP_NAME} HTML Document`], [PROGID_URL, `${APP_NAME} URL`]]) {
    const k = `HKCU\\Software\\Classes\\${progid}`;
    await set(k, null, label);
    if (progid === PROGID_URL) await set(k, 'URL Protocol', '');
    await set(`${k}\\DefaultIcon`, null, icon);
    await set(`${k}\\shell\\open\\command`, null, open);
    await set(`${k}\\Application`, 'ApplicationName', APP_NAME);
    await set(`${k}\\Application`, 'ApplicationIcon', icon);
    await set(`${k}\\Application`, 'AppUserModelId', APP_USER_MODEL_ID);
  }
  await set(CLIENT_KEY, null, APP_NAME);
  await set(`${CLIENT_KEY}\\DefaultIcon`, null, icon);
  await set(`${CLIENT_KEY}\\shell\\open\\command`, null, `"${exe}"`);
  await set(`${CLIENT_KEY}\\Capabilities`, 'ApplicationName', APP_NAME);
  await set(`${CLIENT_KEY}\\Capabilities`, 'ApplicationDescription', 'Fast Chromium browser with your Ludworks passwords, passkeys and bookmarks');
  await set(`${CLIENT_KEY}\\Capabilities`, 'ApplicationIcon', icon);
  await set(`${CLIENT_KEY}\\Capabilities\\StartMenu`, 'StartMenuInternet', APP_NAME);
  for (const ext of FILE_TYPES) await set(`${CLIENT_KEY}\\Capabilities\\FileAssociations`, ext, PROGID_HTML);
  for (const scheme of URL_TYPES) await set(`${CLIENT_KEY}\\Capabilities\\URLAssociations`, scheme, PROGID_URL);
  await set(`${CLIENT_KEY}\\InstallInfo`, 'IconsVisible', 1, 'REG_DWORD');
  await set('HKCU\\Software\\RegisteredApplications', APP_NAME, `Software\\Clients\\StartMenuInternet\\${APP_NAME}\\Capabilities`);
  for (const ext of FILE_TYPES) await set(`HKCU\\Software\\Classes\\${ext}\\OpenWithProgids`, PROGID_HTML, '', 'REG_NONE').catch(() => {});
  await set(`HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${path.basename(exe)}`, null, exe);
  await set(`HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${path.basename(exe)}`, 'Path', dir);
  // Uninstall entry (Settings → Apps): not for an MSI install, which Windows Installer lists itself
  if (uninstallEntry) await setUninstallEntry(exe, dir, icon);
  else await del(UNINSTALL_KEY); // a setup .exe install this MSI replaced
  // Shortcuts
  const { startMenu, desktop } = shortcutPaths();
  const lnk = { target: exe, cwd: dir, description: APP_NAME, icon: exe, iconIndex: 0, appUserModelId: APP_USER_MODEL_ID };
  shell.writeShortcutLink(startMenu, existsSync(startMenu) ? 'replace' : 'create', lnk);
  if (desktopShortcut) shell.writeShortcutLink(desktop, existsSync(desktop) ? 'replace' : 'create', lnk);
}

async function setUninstallEntry(exe, dir, icon) {
  await set(UNINSTALL_KEY, 'DisplayName', APP_NAME);
  await set(UNINSTALL_KEY, 'DisplayIcon', icon);
  await set(UNINSTALL_KEY, 'DisplayVersion', app.getVersion());
  await set(UNINSTALL_KEY, 'Publisher', 'Ludworks');
  await set(UNINSTALL_KEY, 'InstallLocation', dir);
  await set(UNINSTALL_KEY, 'UninstallString', `"${exe}" --ludworks-uninstall`);
  await set(UNINSTALL_KEY, 'QuietUninstallString', `"${exe}" --ludworks-uninstall --silent`);
  await set(UNINSTALL_KEY, 'NoModify', 1, 'REG_DWORD');
  await set(UNINSTALL_KEY, 'NoRepair', 1, 'REG_DWORD');
  await set(UNINSTALL_KEY, 'EstimatedSize', dirSizeKb(dir), 'REG_DWORD');
  await set(UNINSTALL_KEY, 'InstallDate', new Date().toISOString().slice(0, 10).replace(/-/g, ''));
}

export async function unintegrate() {
  await del(`HKCU\\Software\\Classes\\${PROGID_HTML}`);
  await del(`HKCU\\Software\\Classes\\${PROGID_URL}`);
  await del(CLIENT_KEY);
  await reg(['delete', 'HKCU\\Software\\RegisteredApplications', '/v', APP_NAME, '/f']).catch(() => {});
  for (const ext of FILE_TYPES) await reg(['delete', `HKCU\\Software\\Classes\\${ext}\\OpenWithProgids`, '/v', PROGID_HTML, '/f']).catch(() => {});
  await del(`HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${path.basename(process.execPath)}`);
  await del(UNINSTALL_KEY);
  const { startMenu, desktop } = shortcutPaths();
  rmSync(startMenu, { force: true });
  rmSync(desktop, { force: true });
}

/** Handle installer / uninstaller command lines. Returns true when the process should just exit. */
export async function handleInstallerArgs(argv) {
  if (process.platform !== 'win32') return false;
  if (argv.includes('--ludworks-integrate')) {
    await integrate({ desktopShortcut: !argv.includes('--no-desktop-shortcut'), uninstallEntry: !argv.includes('--msi') });
    return true;
  }
  if (argv.includes('--ludworks-unintegrate')) {
    await unintegrate();
    return true;
  }
  if (argv.includes('--ludworks-uninstall')) {
    const silent = argv.includes('--silent');
    let removeData = false;
    if (!silent) {
      await app.whenReady();
      const r = await dialog.showMessageBox({
        type: 'question',
        title: `Uninstall ${APP_NAME}`,
        message: `Uninstall ${APP_NAME}?`,
        detail: 'Your passwords and passkeys stay in your Ludworks vault on the server.',
        buttons: ['Uninstall', 'Cancel'],
        defaultId: 0,
        cancelId: 1,
        checkboxLabel: 'Also delete browsing data on this computer (bookmarks, history, cookies, settings)',
        checkboxChecked: false,
      });
      if (r.response !== 0) return true;
      removeData = r.checkboxChecked;
    }
    await unintegrate();
    // Remove the program folder (and optionally the profile) after this process has exited.
    const dir = path.dirname(process.execPath);
    const targets = [dir, ...(removeData ? [path.dirname(defaultProfileDir())] : [])].filter((p) => /Ludworks Browser/i.test(p));
    const script = `ping -n 3 127.0.0.1 >nul & ${targets.map((t) => `rmdir /s /q "${t}"`).join(' & ')}`;
    spawn('cmd.exe', ['/d', '/c', script], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    return true;
  }
  return false;
}
