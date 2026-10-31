// "Move to separate process" and GPU-heavy pages: the second engine instance's profile and command line, the site
// memory and when a page moves on its own, and the page's GPU meter.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { SEPARATE_DIR, FROM_SEPARATE, separateProfileDir, isSeparateProfile, canMove, siteOf, otherEngineCommand, launch, SeparateProcess } from '../build/app/main/separate.js';
import { installGpuMeter } from '../src/preload/features/gpu-meter.js';

const main = path.resolve('/profiles/User Data');
const sep = path.join(main, SEPARATE_DIR);

test('separate: profile next to the main one, recognised by its folder', () => {
  assert.equal(separateProfileDir(main), sep);
  assert.ok(isSeparateProfile(sep));
  assert.ok(isSeparateProfile(`${sep}${path.sep}`));
  assert.ok(!isSeparateProfile(main));
});

test('separate: only web pages and files move', () => {
  for (const u of ['https://www.twitch.tv/x', 'http://192.0.2.10:43594/', 'file:///C:/game/index.html']) assert.ok(canMove(u), u);
  for (const u of ['ludworks://settings/', 'ludworks://newtab/', 'about:blank', 'chrome-extension://abc/popup.html', '', null]) assert.ok(!canMove(u), String(u));
});

test('separate: main → separate names the separate profile; the URL can never be a switch', () => {
  const c = otherEngineCommand({ execPath: '/opt/lwb', profileDir: main, defaultProfileDir: main, url: 'https://www.twitch.tv/x' });
  assert.deepEqual(c, { file: '/opt/lwb', args: [`--profile=${sep}`, '--single-argument', 'https://www.twitch.tv/x'] });
});

test('separate: back to a default main profile starts it normally (no --profile) and says where it comes from', () => {
  const c = otherEngineCommand({ execPath: '/opt/lwb', profileDir: sep, defaultProfileDir: main, url: 'https://x.test/' });
  assert.deepEqual(c.args, [FROM_SEPARATE, '--single-argument', 'https://x.test/']);
});

test('separate: back to a named main profile names it; unpackaged runs keep the app directory first', () => {
  const other = path.resolve('/tmp/test-profile');
  const c = otherEngineCommand({ execPath: '/opt/electron', appPath: '/src/app', profileDir: separateProfileDir(other), defaultProfileDir: main, url: 'https://x.test/' });
  assert.deepEqual(c.args, ['/src/app', `--profile=${other}`, FROM_SEPARATE, '--single-argument', 'https://x.test/']);
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

// ------------------------------------------------------------------------------ GPU-heavy pages
function fakeBrowser({ separateProcess = false, autoSeparate = true, stored = [], launchFails = false } = {}) {
  const meta = new Map([['separate_sites', stored]]);
  return {
    separateProcess,
    prefs: { get: (k) => (k === 'autoSeparate' ? autoSeparate : undefined) },
    db: { getMeta: (k, d) => (meta.has(k) ? meta.get(k) : d), setMeta: (k, v) => meta.set(k, v) },
    meta,
    moved: [],
    opened: [],
    moveTabToOtherEngine(tab) {
      this.moved.push(tab);
    },
    openInOtherEngine(url) {
      this.opened.push(url);
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

test('separate: a heavy page nobody has used yet moves at once, and its site is remembered', () => {
  const b = fakeBrowser();
  const sp = new SeparateProcess(b);
  const tab = fakeTab('http://192.0.2.10:43594/');
  sp.attachTab(tab);
  sp.gpuHeavy(tab);
  assert.deepEqual(b.moved, [tab]);
  assert.deepEqual(b.meta.get('separate_sites'), ['http://192.0.2.10:43594']);
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
  assert.ok(sp.isRemembered('https://game.test/other'));
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

test('separate: a remembered site opens in the separate process before it loads here', async () => {
  const b = fakeBrowser({ stored: ['https://game.test'] });
  const sp = new SeparateProcess(b);
  // address bar, bookmark or session restore into a tab opened for it: that tab goes away
  const fresh = fakeTab('');
  sp.attachTab(fresh);
  assert.ok(sp.interceptLoad(fresh, 'https://game.test/play'));
  await settle();
  assert.deepEqual(b.opened, ['https://game.test/play']);
  assert.deepEqual(fresh.ctl.closed, [7]);
  // a link in a tab showing another page: cancelled before it starts, and the tab keeps its page
  const forum = fakeTab('https://forum.test/thread');
  sp.attachTab(forum);
  assert.ok(linkNav(forum, 'https://game.test/'));
  await settle();
  assert.deepEqual(b.opened, ['https://game.test/play', 'https://game.test/']);
  assert.deepEqual(forum.ctl.closed, []);
  // other sites and subframes are left alone
  assert.ok(!linkNav(forum, 'https://other.test/'));
  assert.ok(!linkNav(forum, 'https://game.test/frame', false));
  assert.ok(!sp.interceptLoad(forum, 'https://other.test/'));
  assert.equal(b.opened.length, 2);
});

test('separate: when the separate process cannot start, the page loads here (once, no loop)', async () => {
  const b = fakeBrowser({ stored: ['https://game.test'], launchFails: true });
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

test('separate: nothing happens in the separate process, with the setting off, in private or AI agent windows', async () => {
  const cases = [
    [fakeBrowser({ separateProcess: true, stored: ['https://game.test'] }), fakeTab('')],
    [fakeBrowser({ autoSeparate: false, stored: ['https://game.test'] }), fakeTab('')],
    [fakeBrowser({ stored: ['https://game.test'] }), fakeTab('', { priv: true })],
    [fakeBrowser({ stored: ['https://game.test'] }), fakeTab('', { agent: { client: 'Claude Code' } })],
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
    assert.deepEqual(b.opened, []);
    assert.deepEqual(sp.toolbarButtons(tab.ctl, tab), []);
  }
});

test('separate: sites moved back from the separate process are forgotten', () => {
  const b = fakeBrowser({ stored: ['https://game.test', 'https://www.twitch.tv'] });
  const sp = new SeparateProcess(b);
  sp.onCommandLine(['--single-argument', 'https://www.twitch.tv/x'], ['https://www.twitch.tv/x']);
  assert.ok(sp.isRemembered('https://www.twitch.tv/x'));
  sp.onCommandLine([FROM_SEPARATE, '--single-argument', 'https://www.twitch.tv/x'], ['https://www.twitch.tv/x']);
  assert.ok(!sp.isRemembered('https://www.twitch.tv/x'));
  assert.deepEqual(b.meta.get('separate_sites'), ['https://game.test']);
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
