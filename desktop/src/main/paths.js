// Names and locations shared by the main process.

import { app } from 'electron';
import os from 'node:os';
import path from 'node:path';

export const APP_NAME = 'Ludworks Browser';
export const APP_USER_MODEL_ID = 'app.ludworks.browser';
export const PROTOCOL_INTERNAL = 'ludworks';
export const PROTOCOL_SHELL = 'lwshell';

/**
 * `--user-data-dir=<dir>` (or `--profile=<dir>`) selects another profile, e.g. for tests.
 * @param {string[]} argv
 * @returns {string|null}
 */
export function profileDirFromArgs(argv) {
  for (const a of argv) {
    const m = /^--(?:user-data-dir|profile)=(.+)$/.exec(a);
    if (m && m[1].trim()) return path.resolve(m[1].trim());
  }
  return null;
}

/** Per-machine (not roaming) profile location, like Chrome's "User Data". */
export function defaultProfileDir() {
  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(base, APP_NAME, 'User Data');
  }
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', APP_NAME);
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, 'ludworks-browser');
}

export function downloadsDir() {
  try {
    return app.getPath('downloads');
  } catch {
    return path.join(os.homedir(), 'Downloads');
  }
}
