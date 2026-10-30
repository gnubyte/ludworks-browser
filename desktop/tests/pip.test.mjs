// Picture-in-picture feature (src/main/pip.js): which frame gets the video, toggling, the toolbar button,
// automatic picture-in-picture on tab switches. Frames are fakes that answer like the in-page script.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Pip } from '../build/app/main/pip.js';

/** A frame whose page state is `st`; executeJavaScript answers the scan / enter / exit like FRAME_SCRIPT. */
function frame(url, st) {
  return {
    url,
    st,
    calls: [],
    isDestroyed: () => false,
    async executeJavaScript(code, gesture) {
      const act = /const act = "(\w+)"/.exec(code)[1];
      this.calls.push([act, gesture]);
      const out = { count: st.count, playing: st.playing, inPip: st.inPip, score: st.score };
      if (act === 'enter' && st.count) st.inPip = true;
      if (act === 'exit') st.inPip = false;
      return { ...out, inPip: st.inPip };
    },
  };
}

function setup(frames, prefs = {}) {
  const tab = { wc: { isDestroyed: () => false, mainFrame: { framesInSubtree: frames } }, ctl: {} };
  let refreshed = 0;
  const b = { prefs: { get: (k) => ({ pipButton: true, autoPip: false, ...prefs })[k] }, refreshToolbar: () => refreshed++, allTabs: () => [tab] };
  const pip = new Pip(b);
  return { pip, tab, refreshed: () => refreshed };
}

test('pip: the playing video in an iframe wins over a paused one in the page', async () => {
  const top = frame('https://news.example/', { count: 1, playing: false, inPip: false, score: 500 * 300 });
  const embed = frame('https://player.example/embed', { count: 1, playing: true, inPip: false, score: 1e9 + 640 * 360 });
  const ads = frame('about:blank', { count: 0, playing: false, inPip: false, score: -1 });
  const { pip, tab } = setup([top, embed, ads]);
  assert.equal(await pip.toggle(tab), true);
  assert.equal(embed.st.inPip, true);
  assert.equal(top.st.inPip, false);
  assert.deepEqual(embed.calls.at(-1), ['enter', true]); // with a user gesture
  assert.equal(pip.toolbarButtons({}, tab)[0].pressed, true);
  // toggling again leaves picture-in-picture wherever it is
  assert.equal(await pip.toggle(tab), false);
  assert.equal(embed.st.inPip, false);
});

test('pip: internal and extension frames are never scripted; no video → no button', async () => {
  const internal = frame('ludworks://passwords/', { count: 1, playing: true, inPip: false, score: 1e9 });
  const ext = frame('chrome-extension://abc/popup.html', { count: 1, playing: true, inPip: false, score: 1e9 });
  const { pip, tab } = setup([internal, ext]);
  assert.equal(await pip.toggle(tab), false);
  assert.equal(internal.calls.length + ext.calls.length, 0);
  assert.deepEqual(pip.toolbarButtons({}, tab), []);
});

test('pip: automatic picture-in-picture follows the playing video between tabs', async () => {
  const f = frame('https://video.example/', { count: 1, playing: true, inPip: false, score: 1e9 });
  const { pip, tab } = setup([f], { autoPip: true });
  const other = { wc: { isDestroyed: () => false, mainFrame: { framesInSubtree: [] } }, ctl: {} };
  await pip.onTabSwitch({}, tab, other);
  assert.equal(f.st.inPip, true);
  await pip.onTabSwitch({}, other, tab);
  assert.equal(f.st.inPip, false);
  // off by default
  const g = frame('https://video.example/', { count: 1, playing: true, inPip: false, score: 1e9 });
  const s2 = setup([g]);
  await s2.pip.onTabSwitch({}, s2.tab, other);
  assert.equal(g.st.inPip, false);
});

test('pip: the button can be switched off', async () => {
  const f = frame('https://video.example/', { count: 1, playing: false, inPip: false, score: 10 });
  const { pip, tab } = setup([f], { pipButton: false });
  await pip.scan(tab);
  assert.deepEqual(pip.toolbarButtons({}, tab), []);
});
