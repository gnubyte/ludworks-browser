// Detects Windows package (MSIX) file virtualization. A program started by a packaged desktop app (Claude, or any
// packaged app that opens links in the default browser) can inherit that app's package context: Windows then
// redirects the files it creates under %LOCALAPPDATA% into %LOCALAPPDATA%\Packages\<package>\LocalCache\Local and
// shows it a merged view of both. A profile used from there ends up split between the user's folder and the other
// app's private storage, and a normal start later finds a different profile (lost sign-ins, cookies, history).
// No Electron imports: unit-tested in plain Node.

import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Windows redirects by the real AppData\Local folder; LOCALAPPDATA (paths.js) can point elsewhere.
const localAppDataDirs = () => [...new Set([process.env.LOCALAPPDATA, path.join(os.homedir(), 'AppData', 'Local')].filter(Boolean))];

/** The package folder whose LocalCache holds `relPath` (relative to %LOCALAPPDATA%), or null. */
export function packageHolding(localAppData, relPath) {
  let packages;
  try {
    packages = readdirSync(path.join(localAppData, 'Packages'));
  } catch {
    return null;
  }
  return packages.find((p) => existsSync(path.join(localAppData, 'Packages', p, 'LocalCache', 'Local', relPath))) || null;
}

/**
 * Creates a probe file next to `profileDir` and returns the package folder the write was redirected into, or null
 * when it stayed in the user's own folder (also for profiles outside %LOCALAPPDATA%, which are never redirected).
 * `localAppData`: one folder or several candidates.
 */
export function packageRedirectingWrites(profileDir, localAppData = localAppDataDirs()) {
  const dir = path.dirname(profileDir);
  const inside = [localAppData].flat().map((base) => ({ base, rel: path.relative(base, dir) }));
  const bases = inside.filter(({ rel }) => rel && !rel.startsWith('..') && !path.isAbsolute(rel));
  if (!bases.length) return null;
  const name = `.package-probe-${process.pid}`;
  const probe = path.join(dir, name);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(probe, '');
  } catch {
    return null;
  }
  try {
    for (const { base, rel } of bases) {
      const pkg = packageHolding(base, path.join(rel, name));
      if (pkg) return pkg;
    }
    return null;
  } finally {
    rmSync(probe, { force: true });
  }
}

/** "Claude_pzs8sxrjxfjjc" → "Claude" (a package family name ends in "_" + the 13-character publisher id). */
export function packageDisplayName(packageFolder) {
  return packageFolder.replace(/_[a-z0-9]{13}$/i, '');
}
