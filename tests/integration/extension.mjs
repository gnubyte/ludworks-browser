// Loads the BUILT extension (dist output of build.mjs) into the fake browser: the background entry point
// (Chrome service worker / Firefox event page) with its real modules, a popup-side RPC client (the real
// popup/rpc.js), and the Chrome offscreen document. Every load gets a fresh copy of the build so a
// "restarted" service worker starts with fresh module state, exactly like a real worker restart.

import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { pathToFileURL } from 'node:url';
import { build } from '../../build.mjs';
import { createBrowser, installClock } from './browser-env.mjs';
import { FakeDocument, FakeEvent } from '../helpers/fake-dom.mjs';

let buildRoot = null;
let instanceSeq = 0;

/** Build both targets once per process into a temp dir. */
export async function buildOnce() {
  if (buildRoot) return buildRoot;
  buildRoot = await mkdtemp(path.join(os.tmpdir(), 'ludworks-it-'));
  await build({ outDir: buildRoot, zip: false });
  process.on('exit', () => {
    try {
      // best effort; tmp is also cleaned by the OS
      import('node:fs').then((fs) => fs.rmSync(buildRoot, { recursive: true, force: true }));
    } catch {
      /* ignore */
    }
  });
  return buildRoot;
}

async function freshCopy(kind) {
  const root = await buildOnce();
  const dir = path.join(root, `inst-${kind}-${++instanceSeq}`);
  await cp(path.join(root, kind), dir, { recursive: true });
  return dir;
}

function setGlobals(kind, ns) {
  const saved = { chrome: globalThis.chrome, browser: globalThis.browser };
  globalThis.chrome = ns;
  if (kind === 'firefox') globalThis.browser = ns;
  else delete globalThis.browser;
  return () => {
    globalThis.chrome = saved.chrome;
    if (saved.browser === undefined) delete globalThis.browser;
    else globalThis.browser = saved.browser;
  };
}

/** Run fn with `chrome`/`browser` bound to a context's namespace (sync). */
function withGlobals(kind, ns, fn) {
  const restore = setGlobals(kind, ns);
  try {
    return fn();
  } finally {
    restore();
  }
}

/** Import a module of a fresh build copy while `chrome`/`browser` point at the context's namespace. */
async function importIn(kind, ns, file) {
  const restore = setGlobals(kind, ns);
  try {
    return await import(pathToFileURL(file).href);
  } finally {
    restore();
  }
}

/**
 * A browser profile with the built extension installed.
 * @param {'chrome'|'firefox'} kind
 */
export async function installExtension(kind, { clock = installClock() } = {}) {
  const root = await buildOnce();
  const manifest = JSON.parse(await readFile(path.join(root, kind, 'manifest.json'), 'utf8'));
  const browser = createBrowser({ kind, manifest, extensionDir: path.join(root, kind), clock });
  const handle = { browser, clock, manifest, kind, background: null, popups: [] };
  const outerFetch = globalThis.fetch; // restored on dispose (profiles can be nested in one test)

  // Chrome offscreen document: a real page context running offscreen/offscreen.js with a tiny DOM whose
  // execCommand('copy') dispatches a copy event that writes to the profile clipboard.
  let offscreenCtx = null;
  browser.startOffscreen = async (url) => {
    const ctx = browser.createContext('offscreen', browser.manifest && `${browser.extOrigin}/${url}`);
    const doc = {
      listeners: [],
      addEventListener(type, fn) {
        this.listeners.push({ type, fn });
      },
      removeEventListener(type, fn) {
        this.listeners = this.listeners.filter((l) => l.fn !== fn);
      },
      execCommand(cmd) {
        if (cmd !== 'copy') return false;
        let data = null;
        const ev = { preventDefault() {}, clipboardData: { setData: (_t, v) => { data = v; } } };
        for (const l of [...this.listeners]) if (l.type === 'copy') l.fn(ev);
        if (data !== null) browser.clipboard.value = data;
        return true;
      },
    };
    const code = await readFile(path.join(root, kind, url.replace(/\.html$/, '.js')), 'utf8');
    const sandbox = vm.createContext({ chrome: ctx.ns, document: doc, console });
    vm.runInContext(code, sandbox, { filename: 'offscreen.js' });
    offscreenCtx = ctx;
  };
  browser.stopOffscreen = () => {
    if (offscreenCtx) offscreenCtx.close();
    offscreenCtx = null;
  };

  /** Start (or restart) the background. `reason` fires runtime.onInstalled when given. */
  handle.startBackground = async ({ installReason = null, startup = false } = {}) => {
    const dir = await freshCopy(kind);
    const bgUrl = kind === 'chrome' ? `${browser.extOrigin}/background/main.js` : `${browser.extOrigin}/_generated_background_page.html`;
    const ctx = browser.createContext('background', bgUrl);
    globalThis.fetch = browser.network.fetch; // the background's fetch (core.js resolves globalThis.fetch per call)
    await importIn(kind, ctx.ns, path.join(dir, 'background', 'main.js'));
    handle.background = { ctx, dir };
    if (installReason) browser.installed(installReason);
    if (startup) browser.startup();
    await settle();
    return handle.background;
  };

  /** Open the popup page: returns the real rpc.js call() bound to a popup context. */
  handle.openPopup = async () => {
    browser.grantActiveTab(); // clicking the toolbar button grants activeTab
    const dir = await freshCopy(kind);
    const ctx = browser.createContext('popup', `${browser.extOrigin}/popup/popup.html`);
    const rpc = await importIn(kind, ctx.ns, path.join(dir, 'popup', 'rpc.js'));
    const events = [];
    withGlobals(kind, ctx.ns, () => rpc.onBackgroundEvent((e) => events.push(e)));
    const popup = {
      ctx,
      ns: ctx.ns,
      events,
      call: (type, payload) => rpc.call(type, payload),
      /** Run a click handler: permissions.request() inside fn is a user gesture. */
      click: (fn) => browser.withGesture(() => withGlobals(kind, ctx.ns, fn)),
      requestServerPermission: (serverUrl) => browser.withGesture(() => rpc.requestServerPermission(serverUrl)),
      close: () => ctx.close(),
    };
    handle.popups.push(popup);
    return popup;
  };

  handle.restartBrowser = async () => {
    browser.restart();
    for (const p of handle.popups) p.close();
    handle.popups = [];
    return handle.startBackground({ startup: true });
  };

  handle.restartWorker = async () => {
    browser.terminateBackground();
    return handle.startBackground();
  };

  handle.dispose = async () => {
    browser.terminateBackground();
    for (const p of handle.popups) p.close();
    clock.uninstall();
    globalThis.fetch = outerFetch;
  };

  return handle;
}

/** Let queued microtasks / immediates / storage events run. */
export async function settle(rounds = 5) {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setImmediate(r));
}

/** A fake web page (top frame) with a login form, usable as a tab page for scripting.executeScript. */
export function loginPage(url, { totp = false, action = '/session' } = {}) {
  const u = new URL(url);
  const doc = new FakeDocument({ origin: u.origin, path: u.pathname + u.search });
  const user = doc.el('input', { type: 'email', name: 'login', autocomplete: 'username', id: 'login_field' });
  const pass = doc.el('input', { type: 'password', name: 'password', autocomplete: 'current-password', id: 'password' });
  const form = doc.el('form', { action, method: 'post' }, user, pass);
  doc.body.append(form);
  let otp = null;
  if (totp) {
    otp = doc.el('input', { type: 'text', name: 'otp', autocomplete: 'one-time-code', inputmode: 'numeric', id: 'otp' });
    form.append(otp);
  }
  const sandbox = { document: doc, location: doc.location, URL, Event: FakeEvent, console };
  sandbox.window = sandbox;
  sandbox.top = sandbox;
  vm.createContext(sandbox);
  return { doc, sandbox, fields: { user, pass, otp } };
}

export async function cleanupBuilds() {
  if (buildRoot) await rm(buildRoot, { recursive: true, force: true });
  buildRoot = null;
}
