// Separate engine process: "Move to separate process" in the tab menu. A Chromium browser draws all of its
// windows through one GPU process, and two heavy pages there (a WebGL game and a live stream) queue on its one
// command thread: both stutter. A moved tab opens in a second Ludworks instance on a profile of its own
// ("Separate Process" inside the profile it came from), which has its own GPU process, like a second browser.
// A running profile cannot share its cookies, so sites there keep their own sign-ins. "Move to main process"
// in that instance goes back. No Electron imports: unit-tested in plain Node.
//
// Automatic (SeparateProcess, setting "autoSeparate"): the tab preload's GPU meter (src/preload/features/
// gpu-meter.js) reports a page that keeps issuing many draw calls. Moving reloads the page, so it moves at once
// only when nobody has clicked or typed in it yet (a game still on its loading or login screen); otherwise a
// toolbar button offers it. Either way the site is remembered, and from then on it opens in the separate process
// from the start. A manual move remembers the site too; moving it back to the main process forgets it.

import { spawn } from 'node:child_process';
import path from 'node:path';
import { originOf } from './util/urls.js';

export const SEPARATE_DIR = 'Separate Process';
/** On the command line of a move back from the separate process: the main process forgets those sites. */
export const FROM_SEPARATE = '--ludworks-from-separate';
const SITES_KEY = 'separate_sites';
const MAX_SITES = 200;
// Input that means the user is using the page (a reload would lose what they did).
const USER_INPUT = new Set(['mouseDown', 'keyDown', 'rawKeyDown', 'char', 'touchStart', 'gestureTap']);

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
    args.push(FROM_SEPARATE);
  }
  // Everything after --single-argument is the URL, never a switch (Browser.urlsFromArgv).
  args.push('--single-argument', url);
  return { file: execPath, args };
}

/** The site a page belongs to, as remembered for the separate process: its http(s) origin, else ''. */
export function siteOf(url) {
  return /^https?:/i.test(url || '') ? originOf(url) : '';
}

/**
 * Browser feature (Browser.registerFeature) of the main process: sends GPU-heavy and remembered sites to the
 * separate process. Does nothing in the separate process itself, in private windows and in AI agents' windows.
 */
export class SeparateProcess {
  /** @param {import('./browser.js').Browser} browser */
  constructor(browser) {
    this.b = browser;
    this.name = 'separate';
    const stored = browser.db.getMeta(SITES_KEY, []);
    this.sites = new Set(Array.isArray(stored) ? stored.filter((s) => typeof s === 'string') : []);
    this.tabs = new WeakMap(); // tab → {heavy, used}: since its last page load
  }

  active() {
    return !this.b.separateProcess && this.b.prefs.get('autoSeparate');
  }

  eligible(tab) {
    return !tab.destroyed && !tab.private && !tab.agentOwned && !tab.ctl.private && !tab.ctl.agent;
  }

  state(tab) {
    let s = this.tabs.get(tab);
    if (!s) this.tabs.set(tab, (s = { heavy: false, used: false }));
    return s;
  }

  isRemembered(url) {
    const site = siteOf(url);
    return !!site && this.sites.has(site);
  }

  remember(url) {
    const site = siteOf(url);
    if (!site || this.sites.has(site)) return;
    this.sites.add(site);
    while (this.sites.size > MAX_SITES) this.sites.delete(this.sites.values().next().value);
    this.save();
  }

  forget(urls) {
    let changed = false;
    for (const u of urls) changed = this.sites.delete(siteOf(u)) || changed;
    if (changed) this.save();
  }

  save() {
    this.b.db.setMeta(SITES_KEY, [...this.sites]);
  }

  /** A command line handed to this process: URLs moved back from the separate process are not sent there again. */
  onCommandLine(argv, urls) {
    if (argv.includes(FROM_SEPARATE)) this.forget(urls);
  }

  // ------------------------------------------------------------------------------- feature hooks
  attachTab(tab) {
    const wc = tab.wc;
    wc.on('input-event', (_e, input) => {
      if (input && USER_INPUT.has(input.type)) this.state(tab).used = true;
    });
    wc.on('did-navigate', () => {
      this.tabs.set(tab, { heavy: false, used: false });
      this.b.refreshToolbar(tab.ctl);
    });
    // A remembered site opens in the separate process before it loads here. Links and scripts of the page are
    // caught here, before their navigation starts (cancelling one that already started crashes Chromium);
    // the address bar, bookmarks and session restore in Tab.load, new tabs in Browser.handleWindowOpen.
    wc.on('will-navigate', (e) => {
      if (e.isMainFrame === false || !this.shouldDivert(tab, e.url)) return;
      e.preventDefault();
      this.divert(tab, e.url);
    });
  }

  /** True when `url` should open in the separate process instead of `tab` (a remembered site). */
  shouldDivert(tab, url) {
    if (!this.active() || !this.eligible(tab) || !this.isRemembered(url)) return false;
    if (tab.separateBypass === url) {
      tab.separateBypass = null;
      return false;
    }
    return true;
  }

  /** Tab.load: true when the page opens in the separate process instead. */
  interceptLoad(tab, url) {
    if (!this.shouldDivert(tab, url)) return false;
    this.divert(tab, url);
    return true;
  }

  divert(tab, url) {
    const shown = tab.wc.isDestroyed() ? '' : tab.wc.getURL();
    this.b
      .openInOtherEngine(url)
      .then(() => {
        // a tab that was opened for this page goes away; one that shows another page keeps it
        if (!tab.destroyed && (!shown || /^(about:blank|ludworks:\/\/newtab)/.test(shown))) tab.ctl.closeTab(tab.id);
      })
      .catch(() => {
        if (tab.destroyed) return;
        tab.separateBypass = url; // the separate process did not start: load it here after all
        tab.load(url);
      });
  }

  /** The GPU meter of a frame in `tab` measured a heavy page. */
  gpuHeavy(tab) {
    if (!this.active() || !this.eligible(tab)) return;
    const url = tab.wc.getURL();
    if (!siteOf(url)) return;
    this.remember(url);
    const s = this.state(tab);
    s.heavy = true;
    if (!s.used) this.b.moveTabToOtherEngine(tab);
    else this.b.refreshToolbar(tab.ctl);
  }

  toolbarButtons(ctl, tab) {
    if (!tab || !this.active() || !this.eligible(tab) || !this.state(tab).heavy) return [];
    return [{ id: 'separate', order: 4, icon: 'layers', title: 'This page keeps the GPU busy and can slow down your other tabs. Click to move it to a separate process (it reloads there). It opens there from now on.' }];
  }

  onButton(ctl, id) {
    const tab = ctl.activeTab();
    if (id === 'separate' && tab) this.b.moveTabToOtherEngine(tab);
  }
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
