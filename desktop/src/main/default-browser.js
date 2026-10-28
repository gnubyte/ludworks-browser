// Default-browser status and the OS screen where the user chooses it. Windows only lets the user pick
// (Settings → Default apps); the installer registers Ludworks Browser there (StartMenuInternet,
// Capabilities, RegisteredApplications, ProgIds LudworksBrowserHTML / LudworksBrowserURL).

import { app, shell } from 'electron';
import { execFile } from 'node:child_process';

export const PROGID_URL = 'LudworksBrowserURL';
export const REGISTERED_NAME = 'Ludworks Browser';

function regQuery(key, value) {
  return new Promise((resolve) => {
    execFile('reg.exe', ['query', key, '/v', value], { windowsHide: true, timeout: 5000 }, (err, out) => {
      if (err) return resolve(null);
      const m = new RegExp(`${value}\\s+REG_\\w+\\s+(.+)`, 'i').exec(String(out));
      resolve(m ? m[1].trim() : null);
    });
  });
}

export class DefaultBrowser {
  async status() {
    if (process.platform === 'win32') {
      const https = await regQuery('HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice', 'ProgId');
      const registered = (await regQuery('HKCU\\Software\\RegisteredApplications', REGISTERED_NAME)) !== null || (await regQuery('HKLM\\Software\\RegisteredApplications', REGISTERED_NAME)) !== null;
      return { supported: true, isDefault: https === PROGID_URL || https === 'LudworksBrowserHTML', current: https, registered };
    }
    if (process.platform === 'darwin' || process.platform === 'linux') {
      return { supported: true, isDefault: app.isDefaultProtocolClient('https') && app.isDefaultProtocolClient('http'), registered: true };
    }
    return { supported: false };
  }

  async openSystemSettings() {
    if (process.platform === 'win32') {
      // Windows 11 opens our own page in Default apps; Windows 10 falls back to the general page.
      await shell.openExternal(`ms-settings:defaultapps?registeredAppUser=${encodeURIComponent(REGISTERED_NAME)}`).catch(() => shell.openExternal('ms-settings:defaultapps'));
      return { opened: true };
    }
    // macOS shows the system confirmation; Linux updates xdg settings.
    app.setAsDefaultProtocolClient('http');
    app.setAsDefaultProtocolClient('https');
    return { opened: true };
  }
}
