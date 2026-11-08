// Separate engine processes: "Move to separate process" in the tab menu. A Chromium browser draws all of its
// windows through one GPU process, and heavy pages there (a WebGL game and a live stream) queue on its one
// command thread: both stutter. A moved tab opens in another Ludworks instance on a profile of its own —
// numbered from 2, for the main browser is 1: "Separate Process" inside the profile it came from is process 2,
// "Separate Process 3" the next, each with its own GPU process, like more browsers side by side. A site always
// returns to its own process, so two heavy pages never share one. The first time such a profile is created it
// starts as a copy of the main one (cookies, site data, history, settings, the Ludworks sign-in — with a
// browser-sync device id of its own), and every move also sends that site's current cookies ahead in both
// directions, so sign-ins made since the copy travel too. "Move to main process" in those instances goes back.
// No Electron imports: unit-tested in plain Node.
//
// Automatic (SeparateProcess, setting "autoSeparate"): the tab preload's GPU meter (src/preload/features/
// gpu-meter.js) reports a page that keeps issuing many draw calls. Moving reloads the page, so it moves at once
// only when nobody has clicked or typed in it yet (a game still on its loading or login screen); otherwise a
// toolbar button offers it. Either way the site is remembered with its process number, and from then on it
// opens in that process from the start. A manual move remembers it too; moving it back to the main process
// forgets it.

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fsPromises } from 'node:fs';
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { originOf } from './util/urls.js';

/** Process 2's profile (its name predates the numbers; the others are "Separate Process 3", …). */
export const SEPARATE_DIR = 'Separate Process';
const SEPARATE_PREFIX = 'Separate Process ';
/** On the command line of a move back from a separate process: the main process forgets those sites. */
export const FROM_SEPARATE = '--ludworks-from-separate';
/** On the command line of every move: the cookie handoff file (see writeHandoff) the other instance imports. */
export const INCOMING_SWITCH = '--ludworks-incoming';
/** Inside a profile: pending cookie handoffs for pages about to open in it. */
export const INCOMING_DIR = 'ludworks-incoming';
const SITES_KEY = 'separate_sites';
const MAX_SITES = 200;
export const MAX_PROCESSES = 8; // separate processes (2…MAX_PROCESSES+1); a further move shares the highest one
// Input that means the user is using the page (a reload would lose what they did).
const USER_INPUT = new Set(['mouseDown', 'keyDown', 'rawKeyDown', 'char', 'touchStart', 'gestureTap']);

/** The profile directory of separate process `n` (≥ 2) inside `profileDir`. */
export function separateProcessDir(profileDir, n) {
  return path.join(path.resolve(profileDir), n === 2 ? SEPARATE_DIR : `${SEPARATE_PREFIX}${n}`);
}

/**
 * This profile's process number: null for a main profile, else 2, 3… ("Separate Process" is 2). Windows of a
 * process show the number, so you always know which process you are in.
 */
export function separateNumberOf(profileDir) {
  const name = path.basename(path.resolve(profileDir));
  if (name === SEPARATE_DIR) return 2;
  const m = /^Separate Process ([0-9]+)$/.exec(name);
  const n = m && Number(m[1]);
  return Number.isInteger(n) && n >= 3 ? n : null;
}

/** True for a separate-process profile (the instance running on it offers "Move to main process"). */
export function isSeparateProfile(profileDir) {
  return separateNumberOf(profileDir) !== null;
}

export function samePath(a, b) {
  const norm = (p) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
  return norm(a) === norm(b);
}

/** Pages that can move: the web and local files. Internal pages (settings, passwords) belong to their profile. */
export function canMove(url) {
  return /^(https?|file):/i.test(url || '');
}

/** The separate process numbers whose profiles exist among `entries` (a profile directory listing). */
export function separateProcessNumbers(entries) {
  const out = new Set();
  for (const name of entries) {
    if (name === SEPARATE_DIR) out.add(2);
    else {
      const m = /^Separate Process ([0-9]+)$/.exec(name);
      const n = m && Number(m[1]);
      if (Number.isInteger(n) && n >= 2) out.add(n); // "Separate Process 1" is nobody: 1 is the main browser
    }
  }
  return out;
}

/**
 * The process number a moved page opens in: the lowest free one — an exited process's profile is reused, which
 * keeps the sign-ins kept there —, past the cap the highest existing one, so a page always moves somewhere.
 * @param {Set<number>|number[]} numbers the process numbers already taken
 */
export function nextProcessNumber(numbers) {
  const have = [...numbers].filter((n) => Number.isInteger(n) && n >= 2).sort((a, b) => a - b);
  for (let n = 2; n <= MAX_PROCESSES + 1; n++) if (!have.includes(n)) return n;
  return have[have.length - 1] ?? 2;
}

/**
 * The command that opens `url` in the other engine process: it starts that instance, or hands the URL to it
 * through its single-instance lock when it already runs.
 * @param {{execPath: string, appPath?: string|null, profileDir: string, defaultProfileDir: string, url: string,
 *          process?: number|null, incoming?: string|null}} o
 *   appPath: the app directory for unpackaged runs (electron.exe <app dir>), else null
 *   process: the target separate process number (a move from the main browser)
 *   incoming: a cookie handoff file (writeHandoff) the other instance imports before the page loads
 * @returns {{file: string, args: string[]}}
 */
export function otherEngineCommand({ execPath, appPath = null, profileDir, defaultProfileDir, url, process: proc = null, incoming = null }) {
  const args = appPath ? [appPath] : [];
  if (!isSeparateProfile(profileDir)) args.push(`--profile=${separateProcessDir(profileDir, proc ?? 2)}`);
  else {
    // The main profile is named only when it is not the default one, so the default start stays a normal start.
    const main = path.dirname(path.resolve(profileDir));
    if (!samePath(main, defaultProfileDir)) args.push(`--profile=${main}`);
    args.push(FROM_SEPARATE);
  }
  if (incoming) args.push(`${INCOMING_SWITCH}=${incoming}`);
  // Everything after --single-argument is the URL, never a switch (Browser.urlsFromArgv).
  args.push('--single-argument', url);
  return { file: execPath, args };
}

/** The site a page belongs to, as remembered for a separate process: its http(s) origin, else ''. */
export function siteOf(url) {
  return /^https?:/i.test(url || '') ? originOf(url) : '';
}

/** The handoff file `id` (a UUID) that carries cookies into the profile at `profileDir`. */
export function incomingFile(profileDir, id) {
  return path.join(path.resolve(profileDir), INCOMING_DIR, `${id}.bin`);
}

/** `--ludworks-incoming=<file>` in `argv`: the handoff file for the page about to open, or null. */
export function parseIncomingArg(argv) {
  for (const a of argv) {
    if (typeof a === 'string' && a.startsWith(`${INCOMING_SWITCH}=`)) return a.slice(INCOMING_SWITCH.length + 1) || null;
  }
  return null;
}

/**
 * A cookie of `ses.cookies.get` as `ses.cookies.set` writes it into the other profile. A host-only cookie keeps
 * its host (no domain), so it stays host-only; one without an expiration date stays a session cookie.
 * @param {object} c
 */
export function toElectronCookie(c) {
  const host = String(c.domain || '').replace(/^\./, '');
  const out = {
    url: `${c.secure ? 'https' : 'http'}://${host}${c.path || '/'}`,
    name: c.name,
    value: c.value,
    path: c.path || '/',
    secure: !!c.secure,
    httpOnly: !!c.httpOnly,
  };
  if (!c.hostOnly && c.domain) out.domain = c.domain;
  if (typeof c.expirationDate === 'number') out.expirationDate = c.expirationDate;
  if (['no_restriction', 'lax', 'strict'].includes(c.sameSite)) out.sameSite = c.sameSite;
  return out;
}

/**
 * Writes `cookies` (from `ses.cookies.get`) as a handoff file into the profile at `profileDir` and resolves its
 * path — or null when there is nothing to carry or the file cannot be written: the move goes ahead without the
 * refresh. `secrets` is {write} of the OS-protected file helpers (account/files.js), so a handoff is encrypted
 * like the account token.
 * @returns {Promise<string|null>}
 */
export async function writeHandoff(profileDir, cookies, secrets) {
  if (!Array.isArray(cookies) || !cookies.length) return null;
  const file = incomingFile(profileDir, randomUUID());
  try {
    if (!(await secrets.write(file, cookies))) return null;
    return file;
  } catch {
    return null;
  }
}

const HANDOFF_MAX_AGE = 10 * 60 * 1000; // a handoff older than this (a launch that failed) is dropped, not applied

/**
 * Imports the pending cookie handoffs into `ses` — the file named by `--ludworks-incoming` in `argv`, else the
 * pending ones in this profile written in the last few minutes (older ones are stale and only removed) — and
 * removes the files, so a page that opens after this resolves sees the sign-ins sent ahead (a move, separate.js).
 * `keepExisting` (the main browser): a cookie it already has is never replaced, so a separate process's stale
 * or anonymous copy cannot sign the main browser out of a site. Nothing here throws; a cookie that cannot be set
 * just stays unset. `secrets` is {read} of account/files.js; `io` is injectable for the tests.
 * @returns {Promise<number>} how many cookies were set
 */
export async function importHandoff(ses, profileDir, argv, secrets, io = {}) {
  const { readDir = readdirSync, rm = rmSync, mtime = (f) => statSync(f).mtimeMs, now = Date.now(), keepExisting = false } = io;
  let files = [];
  const named = parseIncomingArg(argv);
  if (named) files = [named];
  else {
    const dir = path.join(path.resolve(profileDir), INCOMING_DIR);
    try {
      files = readDir(dir).filter((f) => !f.startsWith('.')).map((f) => path.join(dir, f));
    } catch {
      /* nothing pending */
    }
  }
  let n = 0;
  const bare = (d) => String(d || '').replace(/^\./, '');
  for (const file of files) {
    let fresh;
    try {
      fresh = !!named || now - mtime(file) <= HANDOFF_MAX_AGE;
    } catch {
      fresh = false;
    }
    try {
      const cookies = fresh ? await secrets.read(file) : null;
      if (Array.isArray(cookies)) {
        for (const c of cookies) {
          const ec = toElectronCookie(c);
          if (keepExisting) {
            const have = await Promise.resolve(ses.cookies.get({ url: ec.url, name: ec.name })).catch(() => []);
            if ((have || []).some((x) => (x.path || '/') === ec.path && bare(x.domain) === bare(c.domain))) continue;
          }
          await Promise.resolve(ses.cookies.set(ec)).then(() => n++, () => {});
        }
      }
    } catch {
      /* unreadable handoff: dropped below like the others */
    }
    try {
      rm(file, { force: true });
    } catch {
      /* retried by the next import */
    }
  }
  return n;
}

/** Profile entries that have no place in a copy: nested separate profiles (recursion!), caches, logs, locks. */
const COPY_SKIP = new Set([
  'Cache', 'Code Cache', 'GPUCache', 'DawnCache', 'GraphiteDawnCache', 'ShaderCache', 'Crashpad', 'logs',
  INCOMING_DIR, 'lockfile', 'SingletonLock', 'SingletonCookie', 'SingletonSocket',
]);

/** True for a profile entry that is copied into a new separate-process profile (copyProfile). */
export function copiedProfileEntry(name) {
  if (COPY_SKIP.has(name)) return false;
  return name !== SEPARATE_DIR && !name.startsWith(SEPARATE_PREFIX);
}

/**
 * Copies the profile at `fromDir` into the fresh directory `toDir` (made if needed): its sign-ins, site data,
 * history and settings, so a separate process starts where the main browser is. The main instance keeps running
 * while it is copied, which makes this a crash-image snapshot — a thing Chromium's recovery is built to
 * tolerate; an entry that cannot be read is skipped and counted, and its storage there starts fresh instead.
 * `io` is injectable for the tests.
 * @returns {Promise<{copied: number, failed: number}>}
 */
export const COPY_MARKER = '.ludworks-copy'; // in a separate profile made by copyProfile (older ones started empty)

export async function copyProfile(fromDir, toDir, io = {}) {
  const { readDir = readdirSync, copy = (s, d) => fsPromises.cp(s, d, { recursive: true, force: true }), mark = (f) => writeFileSync(f, `${new Date().toISOString()}\n`) } = io;
  const out = { copied: 0, failed: 0 };
  let entries = [];
  try {
    entries = readDir(fromDir).filter(copiedProfileEntry);
  } catch {
    return out;
  }
  mkdirSync(toDir, { recursive: true });
  for (const name of entries) {
    try {
      await copy(path.join(fromDir, name), path.join(toDir, name));
      out.copied++;
    } catch {
      out.failed++;
    }
  }
  try {
    mark(path.join(toDir, COPY_MARKER));
  } catch {
    /* a later move offers the copy again */
  }
  return out;
}

/**
 * Gives a copied profile (copyProfile) a browser-sync device id of its own: with the main browser's id it would
 * sync as that device — the same records and bookkeeping from two processes. Best effort; a database that
 * cannot be opened just keeps the id it came with. `open` is injectable for the tests.
 * @param {string} dbFile the copied Profile.sqlite
 */
export function rotateDeviceId(dbFile, open = (f) => new DatabaseSync(f)) {
  try {
    const db = open(dbFile);
    try {
      db.exec("DELETE FROM meta WHERE k = 'device_id'");
    } finally {
      db.close();
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Browser feature (Browser.registerFeature) of the main process: sends GPU-heavy and remembered sites to their
 * separate process, and offers the way back — a "Move to main process" toolbar button on every page of a
 * separate process (the tab menu has it too), and an "open it here instead" button in the main browser right
 * after a link was diverted. Diverting does nothing in private windows and in AI agents' windows.
 */
export class SeparateProcess {
  /** @param {import('./browser.js').Browser} browser */
  constructor(browser) {
    this.b = browser;
    this.name = 'separate';
    // Site → process number. Earlier versions stored a plain list of sites: those all belong to process 2.
    const stored = browser.db.getMeta(SITES_KEY, []);
    this.sites = new Map(Array.isArray(stored) ? stored.filter((s) => typeof s === 'string').map((s) => [s, 2]) : Object.entries(stored ?? {}).filter(([, n]) => Number.isInteger(n) && n >= 2));
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
    if (!s) this.tabs.set(tab, (s = { heavy: false, used: false, diverted: null }));
    return s;
  }

  /** The process number a site has been moved to, or undefined. */
  processFor(url) {
    const site = siteOf(url);
    return site ? this.sites.get(site) : undefined;
  }

  isRemembered(url) {
    return !!this.processFor(url);
  }

  /** Remembers that `siteOf(url)` lives in process `n`, so it opens there from then on. */
  remember(url, n = 2) {
    const site = siteOf(url);
    if (!site || this.sites.get(site) === n) return;
    this.sites.set(site, n);
    while (this.sites.size > MAX_SITES) this.sites.delete(this.sites.keys().next().value); // oldest entry
    this.save();
  }

  /** The process number a page opens in: its own when remembered, else the lowest free one, remembered now. */
  targetFor(url) {
    const n = this.processFor(url) ?? this.allocate();
    this.remember(url, n);
    return n;
  }

  /** The lowest free process number, also counting remembered sites (theirs stay theirs even without a profile). */
  allocate() {
    let entries = [];
    try {
      entries = readdirSync(this.b.profileDir);
    } catch {
      /* a profile dir that cannot be read has no separate profiles in it either */
    }
    const used = separateProcessNumbers(entries);
    for (const n of this.sites.values()) used.add(n);
    return nextProcessNumber(used);
  }

  forget(urls) {
    let changed = false;
    for (const u of urls) changed = this.sites.delete(siteOf(u)) || changed;
    if (changed) this.save();
  }

  save() {
    this.b.db.setMeta(SITES_KEY, Object.fromEntries(this.sites));
  }

  /** A command line handed to this process: URLs moved back from a separate process are not sent there again. */
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
      this.tabs.set(tab, { heavy: false, used: false, diverted: null });
      this.b.refreshToolbar(tab.ctl);
    });
    // A remembered site opens in its separate process before it loads here. Links and scripts of the page are
    // caught here, before their navigation starts (cancelling one that already started crashes Chromium);
    // the address bar, bookmarks and session restore in Tab.load, new tabs in Browser.handleWindowOpen.
    wc.on('will-navigate', (e) => {
      if (e.isMainFrame === false || !this.shouldDivert(tab, e.url)) return;
      e.preventDefault();
      this.divert(tab, e.url);
    });
  }

  /** True when `url` should open in its separate process instead of `tab` (a remembered site). */
  shouldDivert(tab, url) {
    if (!this.active() || !this.eligible(tab) || !this.isRemembered(url)) return false;
    if (tab.separateBypass === url) {
      tab.separateBypass = null;
      return false;
    }
    return true;
  }

  /** Tab.load: true when the page opens in its separate process instead. */
  interceptLoad(tab, url) {
    if (!this.shouldDivert(tab, url)) return false;
    this.divert(tab, url);
    return true;
  }

  divert(tab, url) {
    const shown = tab.wc.isDestroyed() ? '' : tab.wc.getURL();
    const proc = this.processFor(url) ?? 2;
    this.b
      .sendToOtherEngine(url, proc)
      .then(() => {
        if (tab.destroyed) return;
        // a tab that was opened for this page goes away; one that shows another page keeps it, with a button
        // to bring the site back here (a remembered site would otherwise always open over there)
        if (!shown || /^(about:blank|ludworks:\/\/newtab)/.test(shown)) tab.ctl.closeTab(tab.id);
        else {
          this.state(tab).diverted = url;
          this.b.refreshToolbar(tab.ctl);
        }
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
    this.remember(url, this.processFor(url) ?? this.allocate());
    const s = this.state(tab);
    s.heavy = true;
    if (!s.used) this.b.moveTabToOtherEngine(tab);
    else this.b.refreshToolbar(tab.ctl);
  }

  toolbarButtons(ctl, tab) {
    // A separate process always offers the way back on its pages (the tab menu has it too).
    if (this.b.separateProcess) {
      return tab && this.eligible(tab) && canMove(tab.wc.isDestroyed() ? '' : tab.wc.getURL())
        ? [{ id: 'separate-main', order: 5, icon: 'back', title: 'Move this page back to the main browser process. It opens there from now on.' }]
        : [];
    }
    if (!tab || !this.active() || !this.eligible(tab)) return [];
    const s = this.state(tab);
    if (s.diverted) {
      return [{ id: 'separate-here', order: 4, icon: 'layers', title: 'This site opened in its separate process. Click to open it here instead; it opens here from now on.' }];
    }
    if (!s.heavy) return [];
    return [{ id: 'separate', order: 4, icon: 'layers', title: 'This page keeps the GPU busy and can slow down your other tabs. Click to move it to its own process (it reloads there). It opens there from now on.' }];
  }

  onButton(ctl, id) {
    const tab = ctl.activeTab();
    if (!tab) return;
    if (id === 'separate' || id === 'separate-main') this.b.moveTabToOtherEngine(tab);
    if (id === 'separate-here') {
      const url = this.state(tab).diverted;
      if (url) {
        this.forget([url]); // opens here from now on
        tab.load(url);
      }
    }
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
