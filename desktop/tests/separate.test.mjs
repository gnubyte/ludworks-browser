// "Move to separate process" and GPU-heavy pages: the numbered second engine instances' profiles and command
// lines, the site → process memory and when a page moves on its own, the cookie handoff that carries sign-ins
// over, the first-use profile copy, and the page's GPU meter.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  SEPARATE_DIR, FROM_SEPARATE, INCOMING_SWITCH, MAX_PROCESSES, separateProcessDir, separateNumberOf,
  isSeparateProfile, separateProcessNumbers, nextProcessNumber, canMove, siteOf, otherEngineCommand, launch,
  incomingFile, parseIncomingArg, toElectronCookie, writeHandoff, importHandoff, copiedProfileEntry, copyProfile, COPY_MARKER,
  rotateDeviceId, SeparateProcess,
} from '../build/app/main/separate.js';
import { installGpuMeter } from '../src/preload/features/gpu-meter.js';

const main = path.resolve('/profiles/User Data');
const sep = path.join(main, SEPARATE_DIR);

test('separate: numbered profiles next to the main one, recognised by their folder', () => {
  assert.equal(separateProcessDir(main, 2), sep);
  assert.equal(separateProcessDir(main, 3), path.join(main, 'Separate Process 3'));
  assert.equal(separateNumberOf(sep), 2);
  assert.equal(separateNumberOf(path.join(main, 'Separate Process 3')), 3);
  assert.equal(separateNumberOf(`${sep}${path.sep}`), 2);
  assert.equal(separateNumberOf(main), null);
  assert.equal(separateNumberOf(path.join(main, 'Separate Process 1')), null); // 1 is the main browser
  assert.ok(isSeparateProfile(sep));
  assert.ok(!isSeparateProfile(main));
});

test('separate: only web pages and files move', () => {
  for (const u of ['https://www.twitch.tv/x', 'http://192.0.2.10:43594/', 'file:///C:/game/index.html']) assert.ok(canMove(u), u);
  for (const u of ['ludworks://settings/', 'ludworks://newtab/', 'about:blank', 'chrome-extension://abc/popup.html', '', null]) assert.ok(!canMove(u), String(u));
});

test('separate: the next free process number — an exited process\'s profile is reused, the cap shares the highest', () => {
  assert.equal(nextProcessNumber([]), 2);
  assert.equal(nextProcessNumber([2]), 3);
  assert.equal(nextProcessNumber([2, 4]), 3);
  assert.equal(nextProcessNumber(new Set([2, 3, 4])), 5);
  assert.equal(nextProcessNumber([1, 'x', 2.5, 2]), 3); // not process numbers: ignored
  const full = Array.from({ length: MAX_PROCESSES }, (_, i) => i + 2); // 2…MAX_PROCESSES+1
  assert.equal(nextProcessNumber(full), MAX_PROCESSES + 1);
});

test('separate: which process numbers a profile listing holds', () => {
  const names = ['Cookies', 'Local State', SEPARATE_DIR, 'Separate Process 3', 'Separate Process 7', 'separate process 4', 'Separate Process 1'];
  assert.deepEqual([...separateProcessNumbers(names)].sort(), [2, 3, 7]);
});

test('separate: main → separate names that process\'s profile; the URL can never be a switch', () => {
  const c = otherEngineCommand({ execPath: '/opt/lwb', profileDir: main, defaultProfileDir: main, url: 'https://www.twitch.tv/x', process: 2 });
  assert.deepEqual(c, { file: '/opt/lwb', args: [`--profile=${sep}`, '--single-argument', 'https://www.twitch.tv/x'] });
  const third = otherEngineCommand({ execPath: '/opt/lwb', profileDir: main, defaultProfileDir: main, url: 'https://x.test/', process: 3, incoming: '/h/cookies.bin' });
  assert.deepEqual(third.args, [`--profile=${path.join(main, 'Separate Process 3')}`, `${INCOMING_SWITCH}=/h/cookies.bin`, '--single-argument', 'https://x.test/']);
});

test('separate: back to a default main profile starts it normally (no --profile) and says where it comes from', () => {
  const c = otherEngineCommand({ execPath: '/opt/lwb', profileDir: sep, defaultProfileDir: main, url: 'https://x.test/' });
  assert.deepEqual(c.args, [FROM_SEPARATE, '--single-argument', 'https://x.test/']);
});

test('separate: back to a named main profile names it; a cookie handoff rides along; unpackaged runs keep the app dir first', () => {
  const other = path.resolve('/tmp/test-profile');
  const c = otherEngineCommand({ execPath: '/opt/electron', appPath: '/src/app', profileDir: separateProcessDir(other, 3), defaultProfileDir: main, url: 'https://x.test/', incoming: '/h/c.bin' });
  assert.deepEqual(c.args, ['/src/app', `--profile=${other}`, FROM_SEPARATE, `${INCOMING_SWITCH}=/h/c.bin`, '--single-argument', 'https://x.test/']);
});

test('separate: launch resolves once the process runs, rejects when it cannot start', async () => {
  const calls = [];
  const fake = (outcome) => (file, args, opts) => {
    calls.push({ file, args, opts });
    const child = Object.assign(new EventEmitter(), { unref: () => (child.unrefd = true) });
    setImmediate(() => (outcome === 'spawn' ? child.emit('spawn') : child.emit('error', new Error('ENOENT'))));
    return child;
  };
  await launch({ file: '/opt/lwb', args: ['a'] }, fake('spawn'));
  assert.deepEqual(calls[0], { file: '/opt/lwb', args: ['a'], opts: { detached: true, stdio: 'ignore' } });
  await assert.rejects(launch({ file: '/nope', args: [] }, fake('error')), /ENOENT/);
});

// ------------------------------------------------------------------------ sign-ins carried over
test('handoff: a cookie crosses as ses.cookies.set would write it, keeping host-only and session cookies', () => {
  assert.deepEqual(
    toElectronCookie({ name: 'sid', value: 'v1', domain: '.example.org', hostOnly: false, path: '/', secure: true, httpOnly: true, sameSite: 'lax', expirationDate: 123.5 }),
    { url: 'https://example.org/', name: 'sid', value: 'v1', path: '/', secure: true, httpOnly: true, domain: '.example.org', expirationDate: 123.5, sameSite: 'lax' },
  );
  const session = toElectronCookie({ name: 's', value: 'v2', domain: 'www.example.org', hostOnly: true, path: '/x', secure: false, httpOnly: false, sameSite: 'unspecified' });
  assert.equal(session.url, 'http://www.example.org/x');
  assert.equal('domain' in session, false); // stays a cookie of that host alone
  assert.equal('expirationDate' in session, false); // stays a session cookie
  assert.equal('sameSite' in session, false);
});

test('handoff: written into the target profile, OS-encrypted; nothing to carry or a failed write means no file', async () => {
  assert.equal(await writeHandoff(main, [], { write: () => true }), null);
  const writes = [];
  const file = await writeHandoff(main, [{ name: 'sid', value: 'v', domain: '.a.test', hostOnly: true, path: '/' }], { write: (f, v) => (writes.push({ f, v }), true) });
  assert.equal(path.dirname(file), path.resolve(main, 'ludworks-incoming'));
  assert.ok(file.endsWith('.bin'));
  assert.deepEqual(writes, [{ f: file, v: [{ name: 'sid', value: 'v', domain: '.a.test', hostOnly: true, path: '/' }] }]);
  assert.equal(await writeHandoff(main, [{ name: 'x' }], { write: () => false }), null); // no secure store
  assert.equal(await writeHandoff(main, [{ name: 'x' }], { write: () => { throw new Error('disk'); } }), null);
});

test('handoff: imported before the page loads, then removed — the named file, or every pending one', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'lwb-handoff-'));
  try {
    const cookies = [{ name: 'sid', value: 'v', domain: '.a.test', hostOnly: true, path: '/', secure: true }];
    const a = incomingFile(dir, randomUUID());
    const b = incomingFile(dir, randomUUID());
    for (const f of [a, b]) {
      mkdirSync(path.dirname(f), { recursive: true });
      writeFileSync(f, 'encrypted');
    }
    const bad = incomingFile(dir, randomUUID());
    writeFileSync(bad, 'encrypted');
    const set = [];
    const ses = { cookies: { set: (c) => (set.push(c), Promise.resolve()) } };
    const secrets = { read: (f) => (f === bad ? '{not json' : cookies) };
    // a start that names its file imports only that one
    assert.equal(await importHandoff(ses, dir, [`${INCOMING_SWITCH}=${a}`], secrets), 1);
    assert.ok(!existsSync(a) && existsSync(b));
    // a start without the argument sweeps the profile's pending files, unreadable ones included
    assert.equal(await importHandoff(ses, dir, [], secrets), 1);
    assert.deepEqual(set, [toElectronCookie(cookies[0]), toElectronCookie(cookies[0])]);
    assert.ok(!existsSync(b) && !existsSync(bad));
    // a profile with nothing pending (and none readable) is fine
    assert.equal(await importHandoff(ses, dir, [], secrets), 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('handoff: a stale pending file is dropped unread; the main browser never replaces a cookie it has', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'lwb-handoff-'));
  try {
    const old = incomingFile(dir, randomUUID());
    mkdirSync(path.dirname(old), { recursive: true });
    writeFileSync(old, 'encrypted');
    const reads = [];
    const set = [];
    const ses = { cookies: { set: (c) => (set.push(c), Promise.resolve()), get: async ({ name }) => (name === 'sid' ? [{ name: 'sid', domain: '.a.test', path: '/' }] : []) } };
    const secrets = { read: (f) => (reads.push(f), [{ name: 'sid', value: 'stale', domain: '.a.test', path: '/' }, { name: 'pref', value: 'x', domain: '.a.test', path: '/' }]) };
    // written an hour ago: a launch that failed long since
    assert.equal(await importHandoff(ses, dir, [], secrets, { now: Date.now() + 3600e3 }), 0);
    assert.deepEqual(reads, []);
    assert.ok(!existsSync(old));
    // a named handoff into the main browser adds what it lacks and keeps its own session cookie
    const named = incomingFile(dir, randomUUID());
    writeFileSync(named, 'encrypted');
    assert.equal(await importHandoff(ses, dir, [`${INCOMING_SWITCH}=${named}`], secrets, { keepExisting: true }), 1);
    assert.deepEqual(set.map((c) => c.name), ['pref']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('copy: a copied profile is marked, so profiles from before copying are told apart', async () => {
  const to = path.join(mkdtempSync(path.join(os.tmpdir(), 'lwb-copy-')), 'Separate Process');
  const marks = [];
  await copyProfile('/main', to, { readDir: () => ['Cookies'], copy: async () => {}, mark: (f) => marks.push(f) });
  assert.deepEqual(marks, [path.join(to, COPY_MARKER)]);
  rmSync(path.dirname(to), { recursive: true, force: true });
});

test('handoff: parseIncomingArg finds the switch, ignores everything else', () => {
  assert.equal(parseIncomingArg([`--profile=${sep}`, `${INCOMING_SWITCH}=/h/x.bin`, '--single-argument', 'https://x/']), '/h/x.bin');
  assert.equal(parseIncomingArg(['--single-argument', 'https://x/']), null);
  assert.equal(parseIncomingArg([`${INCOMING_SWITCH}=`]), null);
});

test('copy: what a new separate-process profile starts from — never nested processes, caches, logs or locks', () => {
  for (const n of ['Cookies', 'Network', 'Local Storage', 'IndexedDB', 'Local State', 'Preferences', 'Profile.sqlite', 'Ludworks', 'Service Worker', 'WebStorage']) assert.ok(copiedProfileEntry(n), n);
  for (const n of [SEPARATE_DIR, 'Separate Process 3', 'Cache', 'Code Cache', 'GPUCache', 'DawnCache', 'GraphiteDawnCache', 'ShaderCache', 'Crashpad', 'logs', 'ludworks-incoming', 'lockfile', 'SingletonLock', 'SingletonCookie', 'SingletonSocket']) assert.ok(!copiedProfileEntry(n), n);
});

test('copy: entries land in the fresh directory; one that cannot be read is skipped and counted', async () => {
  const to = mkdtempSync(path.join(os.tmpdir(), 'lwb-copy-'));
  try {
    const copies = [];
    const io = {
      readDir: () => ['Cookies', 'Local State', 'Cache', 'Separate Process 3', 'Local Storage', 'ludworks-incoming'],
      copy: async (s, d) => {
        copies.push([s, d]);
        if (path.basename(s) === 'Local Storage') throw new Error('EBUSY');
      },
    };
    assert.deepEqual(await copyProfile('/from', to, io), { copied: 2, failed: 1 });
    assert.deepEqual(copies.map(([s]) => path.basename(s)), ['Cookies', 'Local State', 'Local Storage']);
    assert.ok(copies.every(([, d]) => d.startsWith(to)));
    assert.deepEqual(await copyProfile('/not-there', to, { readDir: () => { throw new Error('ENOENT'); } }), { copied: 0, failed: 0 });
  } finally {
    rmSync(to, { recursive: true, force: true });
  }
});

test('copy: the copy gets a browser-sync device id of its own', () => {
  const db = { sql: [], exec(s) { this.sql.push(s); }, close() {} };
  assert.equal(rotateDeviceId('/copy/Profile.sqlite', () => db), true);
  assert.equal(db.sql.length, 1);
  assert.match(db.sql[0], /DELETE FROM meta WHERE k = 'device_id'/);
  assert.equal(rotateDeviceId('/copy/Profile.sqlite', () => { throw new Error('locked'); }), false);
});

// ------------------------------------------------------------------------------ GPU-heavy pages
function fakeBrowser({ separateProcess = false, autoSeparate = true, stored = [], launchFails = false } = {}) {
  const meta = new Map([['separate_sites', stored]]);
  return {
    separateProcess,
    profileDir: main,
    prefs: { get: (k) => (k === 'autoSeparate' ? autoSeparate : undefined) },
    db: { getMeta: (k, d) => (meta.has(k) ? meta.get(k) : d), setMeta: (k, v) => meta.set(k, v) },
    meta,
    moved: [],
    sent: [],
    moveTabToOtherEngine(tab) {
      this.moved.push(tab);
    },
    sendToOtherEngine(url, n) {
      this.sent.push({ url, n });
      return launchFails ? Promise.reject(new Error('ENOENT')) : Promise.resolve();
    },
    refreshToolbar() {},
  };
}

function fakeTab(url, { priv = false, agent = null } = {}) {
  const wc = new EventEmitter();
  let shown = url;
  wc.getURL = () => shown;
  wc.isDestroyed = () => false;
  return {
    id: 7,
    wc,
    private: priv,
    destroyed: false,
    loads: [],
    load(u) {
      this.loads.push(u);
    },
    ctl: {
      private: priv,
      agent,
      closed: [],
      closeTab(id) {
        this.closed.push(id);
      },
    },
    show(u) {
      shown = u;
    },
  };
}

const settle = () => new Promise((r) => setImmediate(r));
/** A link or script of the page navigates: returns whether the navigation was cancelled. */
function linkNav(tab, url, isMainFrame = true) {
  let prevented = false;
  tab.wc.emit('will-navigate', { url, isMainFrame, preventDefault: () => (prevented = true) });
  return prevented;
}

test('separate: sites are http(s) origins', () => {
  assert.equal(siteOf('https://www.twitch.tv/caedrel?x=1'), 'https://www.twitch.tv');
  assert.equal(siteOf('http://192.0.2.10:43594/'), 'http://192.0.2.10:43594');
  for (const u of ['file:///C:/game/index.html', 'ludworks://settings/', '', null]) assert.equal(siteOf(u), '', String(u));
});

test('separate: each remembered site has its own process, remembered with it; a list from before all meant 2', () => {
  const b = fakeBrowser({ stored: { 'https://old.test': 2 } });
  const sp = new SeparateProcess(b);
  assert.equal(sp.processFor('https://old.test/page'), 2);
  assert.equal(sp.targetFor('https://one.test/'), 3); // 2 is taken by a site, so this gets the next one
  assert.equal(sp.targetFor('https://two.test/'), 4);
  assert.equal(sp.targetFor('https://one.test/x'), 3); // a site keeps its own process
  assert.deepEqual(b.meta.get('separate_sites'), { 'https://old.test': 2, 'https://one.test': 3, 'https://two.test': 4 });
  const legacy = new SeparateProcess(fakeBrowser({ stored: ['https://a.test', 'https://b.test'] }));
  assert.equal(legacy.processFor('https://a.test/x'), 2);
  assert.equal(legacy.processFor('https://b.test/x'), 2);
});

test('separate: a heavy page nobody has used yet moves at once, into a process of its own', () => {
  const b = fakeBrowser();
  const sp = new SeparateProcess(b);
  const tab = fakeTab('http://192.0.2.10:43594/');
  sp.attachTab(tab);
  sp.gpuHeavy(tab);
  assert.deepEqual(b.moved, [tab]);
  assert.deepEqual(b.meta.get('separate_sites'), { 'http://192.0.2.10:43594': 2 });
});

test('separate: a heavy page the user has clicked or typed in stays (a reload would lose that), with a button to move it', () => {
  const b = fakeBrowser();
  const sp = new SeparateProcess(b);
  const tab = fakeTab('https://game.test/play');
  sp.attachTab(tab);
  tab.wc.emit('input-event', {}, { type: 'mouseMove' });
  tab.wc.emit('input-event', {}, { type: 'mouseDown' });
  sp.gpuHeavy(tab);
  assert.deepEqual(b.moved, []);
  assert.equal(sp.processFor('https://game.test/other'), 2);
  const [btn] = sp.toolbarButtons(tab.ctl, tab);
  assert.equal(btn.id, 'separate');
  sp.onButton({ activeTab: () => tab }, 'separate');
  assert.deepEqual(b.moved, [tab]);
  // a new page in the tab starts over: no button, input forgotten
  tab.wc.emit('did-navigate');
  assert.deepEqual(sp.toolbarButtons(tab.ctl, tab), []);
  sp.gpuHeavy(tab);
  assert.equal(b.moved.length, 2);
});

test('separate: a remembered site opens in its process before it loads here', async () => {
  const b = fakeBrowser({ stored: { 'https://game.test': 3 } });
  const sp = new SeparateProcess(b);
  // address bar, bookmark or session restore into a tab opened for it: that tab goes away
  const fresh = fakeTab('');
  sp.attachTab(fresh);
  assert.ok(sp.interceptLoad(fresh, 'https://game.test/play'));
  await settle();
  assert.deepEqual(b.sent, [{ url: 'https://game.test/play', n: 3 }]);
  assert.deepEqual(fresh.ctl.closed, [7]);
  // a link in a tab showing another page: cancelled before it starts, and the tab keeps its page
  const forum = fakeTab('https://forum.test/thread');
  sp.attachTab(forum);
  assert.ok(linkNav(forum, 'https://game.test/'));
  await settle();
  assert.deepEqual(b.sent, [{ url: 'https://game.test/play', n: 3 }, { url: 'https://game.test/', n: 3 }]);
  assert.deepEqual(forum.ctl.closed, []);
  // other sites and subframes are left alone
  assert.ok(!linkNav(forum, 'https://other.test/'));
  assert.ok(!linkNav(forum, 'https://game.test/frame', false));
  assert.ok(!sp.interceptLoad(forum, 'https://other.test/'));
  assert.equal(b.sent.length, 2);
});

test('separate: when the separate process cannot start, the page loads here (once, no loop)', async () => {
  const b = fakeBrowser({ stored: { 'https://game.test': 2 }, launchFails: true });
  const sp = new SeparateProcess(b);
  const tab = fakeTab('');
  sp.attachTab(tab);
  assert.ok(sp.interceptLoad(tab, 'https://game.test/'));
  await settle();
  assert.deepEqual(tab.loads, ['https://game.test/']);
  assert.ok(!sp.interceptLoad(tab, 'https://game.test/')); // that load goes through
  assert.ok(sp.interceptLoad(tab, 'https://game.test/')); // the next one tries the separate process again
  assert.deepEqual(tab.ctl.closed, []);
});

test('separate: nothing happens in the separate processes, with the setting off, in private or AI agent windows', async () => {
  const cases = [
    [fakeBrowser({ separateProcess: true, stored: { 'https://game.test': 2 } }), fakeTab('')],
    [fakeBrowser({ autoSeparate: false, stored: { 'https://game.test': 2 } }), fakeTab('')],
    [fakeBrowser({ stored: { 'https://game.test': 2 } }), fakeTab('', { priv: true })],
    [fakeBrowser({ stored: { 'https://game.test': 2 } }), fakeTab('', { agent: { client: 'Claude Code' } })],
  ];
  for (const [b, tab] of cases) {
    const sp = new SeparateProcess(b);
    sp.attachTab(tab);
    assert.ok(!sp.interceptLoad(tab, 'https://game.test/'));
    assert.ok(!linkNav(tab, 'https://game.test/'));
    tab.show('https://game.test/');
    sp.gpuHeavy(tab);
    await settle();
    assert.deepEqual(b.moved, []);
    assert.deepEqual(b.sent, []);
    // the separate process offers the way back (below); the others offer nothing at all
    if (!b.separateProcess) assert.deepEqual(sp.toolbarButtons(tab.ctl, tab), []);
  }
});

test('separate: a separate process offers "Move to main process" on every page that can move', () => {
  const b = fakeBrowser({ separateProcess: true });
  const sp = new SeparateProcess(b);
  const tab = fakeTab('https://game.test/play');
  const [btn] = sp.toolbarButtons(tab.ctl, tab);
  assert.equal(btn.id, 'separate-main');
  sp.onButton({ activeTab: () => tab }, 'separate-main');
  assert.deepEqual(b.moved, [tab]);
  // internal pages (settings, new tab) and private windows do not move
  for (const url of ['ludworks://settings/', 'about:blank']) {
    tab.show(url);
    assert.deepEqual(sp.toolbarButtons(tab.ctl, tab), []);
  }
  tab.show('https://game.test/');
  assert.deepEqual(sp.toolbarButtons(tab.ctl, fakeTab('', { priv: true })), []);
});

test('separate: a diverted link offers to open the site here instead — and doing so forgets it', async () => {
  const b = fakeBrowser({ stored: { 'https://game.test': 3 } });
  const sp = new SeparateProcess(b);
  const forum = fakeTab('https://forum.test/thread');
  sp.attachTab(forum);
  assert.ok(linkNav(forum, 'https://game.test/'));
  await settle();
  const [btn] = sp.toolbarButtons(forum.ctl, forum);
  assert.equal(btn.id, 'separate-here');
  sp.onButton({ activeTab: () => forum }, 'separate-here');
  assert.equal(sp.isRemembered('https://game.test/'), false);
  assert.deepEqual(forum.loads, ['https://game.test/']);
  assert.deepEqual(b.meta.get('separate_sites'), {});
  // the button was for that navigation: another page in the tab does not offer it
  forum.wc.emit('did-navigate');
  assert.deepEqual(sp.toolbarButtons(forum.ctl, forum), []);
});

test('separate: sites moved back from a separate process are forgotten', () => {
  const b = fakeBrowser({ stored: { 'https://game.test': 5, 'https://www.twitch.tv': 2 } });
  const sp = new SeparateProcess(b);
  sp.onCommandLine(['--single-argument', 'https://www.twitch.tv/x'], ['https://www.twitch.tv/x']);
  assert.equal(sp.processFor('https://www.twitch.tv/x'), 2);
  sp.onCommandLine([FROM_SEPARATE, '--single-argument', 'https://www.twitch.tv/x'], ['https://www.twitch.tv/x']);
  assert.equal(sp.processFor('https://www.twitch.tv/x'), undefined);
  assert.deepEqual(b.meta.get('separate_sites'), { 'https://game.test': 5 });
});

// ------------------------------------------------------------------------------------ GPU meter
function fakeGl() {
  class WebGLRenderingContext {
    drawArrays() {
      return 'drawn';
    }
    drawElements() {}
  }
  class WebGL2RenderingContext extends WebGLRenderingContext {}
  Object.defineProperty(WebGL2RenderingContext.prototype, 'drawArrays', { value: WebGLRenderingContext.prototype.drawArrays, writable: true, configurable: true });
  return { WebGLRenderingContext, WebGL2RenderingContext };
}

/** Draws `perTick` times every 5 ms for `ms`, with the meter sampling every 20 ms. */
async function drive(perTick, ms, { minRate, samples = 5 } = {}) {
  const win = fakeGl();
  const native = win.WebGL2RenderingContext.prototype.drawArrays;
  const reports = [];
  globalThis.window = win;
  try {
    installGpuMeter((rate) => reports.push(rate), { minRate, samples, intervalMs: 20 });
  } finally {
    delete globalThis.window;
  }
  const gl = new win.WebGL2RenderingContext();
  assert.equal(gl.drawArrays(), 'drawn'); // the page still gets its result
  const until = Date.now() + ms;
  while (Date.now() < until) {
    for (let i = 0; i < perTick; i++) gl.drawArrays();
    await new Promise((r) => setTimeout(r, 5));
  }
  return { reports, restored: win.WebGL2RenderingContext.prototype.drawArrays === native };
}

test('GPU meter: a page that keeps drawing a lot is reported once and the counters are removed', async () => {
  const { reports, restored } = await drive(200, 400, { minRate: 10000 });
  assert.equal(reports.length, 1);
  assert.ok(reports[0] >= 10000, String(reports[0]));
  assert.ok(restored);
});

test('GPU meter: a page drawing a little is never reported and keeps running normally', async () => {
  const { reports, restored } = await drive(2, 300, { minRate: 10000 });
  assert.deepEqual(reports, []);
  assert.ok(!restored); // still measuring
});
