// "Record video from now" (src/main/recorder.js + src/preload/features/recorder.js): file names, the
// chunks a frame sends ending up in order in a new file, only the recording frame being listened to,
// an empty recording leaving no file, and which media element the page side picks. Electron, tabs
// and the DOM are fakes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const listeners = new Map();
globalThis.__lwIpcMain = { on: (ch, fn) => listeners.set(ch, fn) };
const ELECTRON = `
export const ipcMain = globalThis.__lwIpcMain;
export const Notification = class { static isSupported() { return false; } };
export const shell = {};
export const app = { getPath: () => '' };
`;
registerHooks({
  resolve: (spec, ctx, next) => (spec === 'electron' ? { url: `data:text/javascript,${encodeURIComponent(ELECTRON)}`, shortCircuit: true } : next(spec, ctx)),
});
const { Recorder, recordingName, elapsed } = await import('../build/app/main/recorder.js');
const { pickMedia } = await import('../src/preload/features/recorder.js');

function setup(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'lw-rec-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const sent = [];
  const frame = { isDestroyed: () => false, send: (ch, m) => sent.push([ch, m]) };
  const tab = { wc: { getTitle: () => 'Live: Launch / Day 1?', mainFrame: frame, on() {} }, ctl: {} };
  let refreshed = 0;
  const rec = new Recorder({ refreshToolbar: () => refreshed++ }, { dir: () => dir, notify: false });
  const from = { sender: tab.wc, senderFrame: frame };
  const emit = (ch, m, e = from) => listeners.get(ch)(e, m);
  return { dir, sent, tab, rec, emit, refreshed: () => refreshed };
}

test('file names are safe and dated, durations read naturally', () => {
  const when = new Date(2026, 9, 30, 14, 5, 9);
  assert.equal(recordingName('Live: Launch / Day 1?', when), 'Live Launch Day 1 2026-10-30 14-05-09.webm');
  assert.equal(recordingName('  ', when), 'Recording 2026-10-30 14-05-09.webm');
  assert.equal(recordingName('a'.repeat(300), when).length, 80 + ' 2026-10-30 14-05-09.webm'.length);
  assert.equal(elapsed(65_000), '1:05');
  assert.equal(elapsed(3_725_000), '1:02:05');
});

test('a recording writes the chunks in order to a new file in the folder', async (t) => {
  const { dir, sent, tab, rec, emit } = setup(t);
  writeFileSync(path.join(dir, recordingName(tab.wc.getTitle())), 'existing'); // never overwritten
  assert.deepEqual(rec.contextMenuItems(tab, { mediaType: 'video' }).map((i) => i.label), ['Record video from now']);
  assert.deepEqual(rec.contextMenuItems(tab, { mediaType: 'none' }), []);
  await rec.start(tab, { x: 10, y: 20 });
  const [ch, msg] = sent[0];
  assert.equal(ch, 'recorder:start');
  assert.deepEqual(msg.point, { x: 10, y: 20 });
  assert.equal(rec.toolbarButtons({}, tab)[0].id, 'recorder');
  assert.match(rec.contextMenuItems(tab, { mediaType: 'none' })[0].label, /^Stop recording/);

  emit('recorder:started', { id: msg.id, kind: 'video' });
  emit('recorder:data', { id: msg.id, buf: new Uint8Array([1, 2, 3]) });
  emit('recorder:data', { id: msg.id, buf: new Uint8Array([4, 5]) }, { sender: {}, senderFrame: null }); // another page: ignored
  emit('recorder:data', { id: msg.id, buf: new Uint8Array([6]) });
  await rec.finish(rec.byId.get(msg.id));
  const files = readdirSync(dir).sort();
  assert.equal(files.length, 2);
  const made = files.find((f) => f.endsWith('(2).webm'));
  assert.ok(made, files.join());
  assert.deepEqual([...readFileSync(path.join(dir, made))], [1, 2, 3, 6]);
  assert.equal(readFileSync(path.join(dir, recordingName(tab.wc.getTitle())), 'utf8'), 'existing');
  assert.deepEqual(rec.toolbarButtons({}, tab), []);
});

test('a recording that captured nothing (DRM, an error) leaves no file', async (t) => {
  const { dir, sent, tab, rec, emit } = setup(t);
  await rec.start(tab, null);
  const { id } = sent[0][1];
  emit('recorder:error', { id, message: 'This video is DRM-protected' });
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(readdirSync(dir), []);
  assert.equal(rec.byId.size, 0);
});

test('the page side records the media under the pointer, else the playing then largest one', () => {
  const media = (tag, { paused = true, w = 100, h = 100, ready = 4 } = {}) => ({ tagName: tag, paused, ended: false, readyState: ready, getBoundingClientRect: () => ({ width: w, height: h }) });
  const small = media('VIDEO', { paused: false, w: 50, h: 50 });
  const big = media('VIDEO', { w: 800, h: 450 });
  const doc = (hit, list) => ({ elementFromPoint: () => hit, querySelectorAll: () => list });
  assert.equal(pickMedia(doc(null, [big, small]), null), small, 'playing beats larger');
  assert.equal(pickMedia(doc(null, [big, media('VIDEO', { w: 10, h: 10 })]), null), big);
  const overlay = { closest: () => big };
  assert.equal(pickMedia(doc(overlay, [small, big]), { x: 1, y: 1 }), big, 'the one under the pointer');
  assert.equal(pickMedia(doc(null, [media('VIDEO', { ready: 0 })]), null), null);
});
