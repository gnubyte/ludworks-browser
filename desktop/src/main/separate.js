// Separate engine process: "Move to separate process" in the tab menu. A Chromium browser draws all of its
// windows through one GPU process, and two heavy pages there (a WebGL game and a live stream) queue on its one
// command thread: both stutter. A moved tab opens in a second Ludworks instance on a profile of its own
// ("Separate Process" inside the profile it came from), which has its own GPU process, like a second browser.
// A running profile cannot share its cookies, so sites there keep their own sign-ins. "Move to main process"
// in that instance goes back. No Electron imports: unit-tested in plain Node.

import { spawn } from 'node:child_process';
import path from 'node:path';

export const SEPARATE_DIR = 'Separate Process';

/** The separate-process profile that belongs to `profileDir`. */
export function separateProfileDir(profileDir) {
  return path.join(path.resolve(profileDir), SEPARATE_DIR);
}

/** True for a separate-process profile (the instance running on it offers "Move to main process"). */
export function isSeparateProfile(profileDir) {
  return path.basename(path.resolve(profileDir)) === SEPARATE_DIR;
}

export function samePath(a, b) {
  const norm = (p) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
  return norm(a) === norm(b);
}

/** Pages that can move: the web and local files. Internal pages (settings, passwords) belong to their profile. */
export function canMove(url) {
  return /^(https?|file):/i.test(url || '');
}

/**
 * The command that opens `url` in the other engine process: it starts that instance, or hands the URL to it
 * through its single-instance lock when it already runs.
 * @param {{execPath: string, appPath?: string|null, profileDir: string, defaultProfileDir: string, url: string}} o
 *   appPath: the app directory for unpackaged runs (electron.exe <app dir>), else null
 * @returns {{file: string, args: string[]}}
 */
export function otherEngineCommand({ execPath, appPath = null, profileDir, defaultProfileDir, url }) {
  const args = appPath ? [appPath] : [];
  if (!isSeparateProfile(profileDir)) args.push(`--profile=${separateProfileDir(profileDir)}`);
  else {
    // The main profile is named only when it is not the default one, so the default start stays a normal start.
    const main = path.dirname(path.resolve(profileDir));
    if (!samePath(main, defaultProfileDir)) args.push(`--profile=${main}`);
  }
  // Everything after --single-argument is the URL, never a switch (Browser.urlsFromArgv).
  args.push('--single-argument', url);
  return { file: execPath, args };
}

/** Starts the command detached from this process. Resolves once it runs, rejects when it cannot start. */
export function launch({ file, args }, spawnFn = spawn) {
  return new Promise((resolve, reject) => {
    const child = spawnFn(file, args, { detached: true, stdio: 'ignore' });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}
