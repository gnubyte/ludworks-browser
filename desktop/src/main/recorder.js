// Stream recorder (Browser.registerFeature): "Record video from now" in the context menu of a video or
// audio element — a live stream or anything else playing — and a red toolbar button while the tab
// records (click to stop; "Stop recording" in the context menu too). The page side
// (src/preload/features/recorder.js) captures with MediaRecorder and sends WebM chunks; they are
// appended to "<page title> <date time>.webm" in Downloads as they arrive, so a crash or a closed tab
// keeps everything recorded so far. A Windows notification reports the finished file (click: show it).
// DRM-protected video (Netflix, Disney+, …) cannot be recorded: Widevine blanks every capture.

import { ipcMain, Notification, shell } from 'electron';
import { open, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { downloadsDir } from './paths.js';
import { log } from './util/log.js';

const MAX_BYTES = 64 * 1024 ** 3; // a runaway recording stops at 64 GB

/** "<title> 2026-10-30 14-05-09.webm", safe on every file system. */
export function recordingName(title, when = new Date(), ext = '.webm') {
  const clean = String(title || '')
    .replace(/[\u0000-\u001f<>:"/\\|?*\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '')
    .slice(0, 80);
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${when.getFullYear()}-${p(when.getMonth() + 1)}-${p(when.getDate())} ${p(when.getHours())}-${p(when.getMinutes())}-${p(when.getSeconds())}`;
  return `${clean || 'Recording'} ${stamp}${ext}`;
}

/** Elapsed time as m:ss or h:mm:ss. */
export function elapsed(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const p = (n) => String(n).padStart(2, '0');
  return s >= 3600 ? `${Math.floor(s / 3600)}:${p(Math.floor(s / 60) % 60)}:${p(s % 60)}` : `${Math.floor(s / 60)}:${p(s % 60)}`;
}

export class Recorder {
  /** @param {import('./browser.js').Browser} browser */
  constructor(browser, { dir = downloadsDir, notify = true } = {}) {
    this.b = browser;
    this.name = 'recorder';
    this.dir = dir;
    this.notify = notify;
    this.byId = new Map(); // id → recording
    ipcMain.on('recorder:started', (e, m) => this.withRec(e, m, (r) => this.onStarted(r)));
    ipcMain.on('recorder:data', (e, m) => this.withRec(e, m, (r) => this.onData(r, m)));
    ipcMain.on('recorder:end', (e, m) => this.withRec(e, m, (r) => this.finish(r)));
    ipcMain.on('recorder:error', (e, m) => this.withRec(e, m, (r) => this.finish(r, String((m && m.message) || 'Recording failed.').slice(0, 300))));
  }

  /** Only the frame a recording was started in may feed it. */
  withRec(e, m, fn) {
    const r = m && typeof m.id === 'string' ? this.byId.get(m.id) : null;
    if (!r || e.sender !== r.tab.wc || (r.frame && e.senderFrame && e.senderFrame !== r.frame)) return;
    fn(r);
  }

  recordingOf(tab) {
    for (const r of this.byId.values()) if (r.tab === tab) return r;
    return null;
  }

  // ------------------------------------------------------------------------------- feature hooks
  contextMenuItems(tab, p) {
    const r = this.recordingOf(tab);
    if (r) return [{ label: `Stop recording (${elapsed(Date.now() - r.startedAt)})`, click: () => this.stop(r) }];
    if (p.mediaType !== 'video' && p.mediaType !== 'audio') return [];
    return [{ label: p.mediaType === 'video' ? 'Record video from now' : 'Record audio from now', click: () => this.start(tab, p).catch((e) => log.warn('recorder: start failed', { message: e.message })) }];
  }

  toolbarButtons(ctl, tab) {
    const r = tab && this.recordingOf(tab);
    if (!r) return [];
    const since = new Date(r.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return [{ id: 'recorder', order: 3, icon: 'record', tone: 'warn', pressed: true, title: `Recording since ${since} — click to stop and save` }];
  }

  onButton(ctl, id) {
    const r = id === 'recorder' && this.recordingOf(ctl.activeTab());
    if (r) this.stop(r);
  }

  attachTab(tab) {
    // A closed tab or a new page: keep what was recorded (the page may not get to say goodbye).
    tab.wc.on('destroyed', () => {
      const r = this.recordingOf(tab);
      if (r) this.finish(r);
    });
    tab.wc.on('did-navigate', () => {
      const r = this.recordingOf(tab);
      if (r) this.finish(r);
    });
  }

  // ---------------------------------------------------------------------------------- recording
  async start(tab, p) {
    if (this.recordingOf(tab)) return;
    const frame = p && p.frame && !p.frame.isDestroyed() ? p.frame : tab.wc.mainFrame;
    const dir = this.dir();
    const r = { id: randomUUID(), tab, frame, file: null, fh: null, bytes: 0, startedAt: Date.now(), state: 'starting', writing: Promise.resolve() };
    // Exclusive create: never overwrite an existing file.
    const base = recordingName(tab.wc.getTitle());
    for (let i = 1; i < 100 && !r.fh; i++) {
      const name = i === 1 ? base : base.replace(/\.webm$/, ` (${i}).webm`);
      try {
        r.fh = await open(path.join(dir, name), 'wx');
        r.file = path.join(dir, name);
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
      }
    }
    if (!r.fh) throw new Error('no free file name');
    this.byId.set(r.id, r);
    // The point only helps in the main frame; an iframe recorder picks its playing video.
    const point = frame === tab.wc.mainFrame && p ? { x: p.x, y: p.y } : null;
    frame.send('recorder:start', { id: r.id, point });
    this.b.refreshToolbar(tab.ctl);
  }

  onStarted(r) {
    if (r.state === 'starting') r.state = 'recording';
    this.toast('Recording started', `${path.basename(r.file)}\nStop it with the red button in the toolbar.`, null);
  }

  onData(r, m) {
    if (r.state === 'done' || !m || !(m.buf instanceof Uint8Array)) return;
    const buf = Buffer.from(m.buf.buffer, m.buf.byteOffset, m.buf.byteLength);
    r.bytes += buf.length;
    r.writing = r.writing.then(() => r.fh.write(buf)).catch((e) => log.warn('recorder: write failed', { message: e.message }));
    if (r.bytes > MAX_BYTES) this.stop(r);
  }

  stop(r) {
    if (r.state === 'done' || r.state === 'stopping') return;
    r.state = 'stopping';
    try {
      r.frame.send('recorder:stop', { id: r.id });
    } catch {
      /* frame gone */
    }
    // The page flushes its last chunk and says "end"; if it can't, close the file anyway.
    setTimeout(() => this.finish(r), 5000).unref();
  }

  async finish(r, error = null) {
    if (r.state === 'done') return;
    r.state = 'done';
    this.byId.delete(r.id);
    if (!r.tab.destroyed && r.tab.ctl) this.b.refreshToolbar(r.tab.ctl);
    await r.writing;
    await r.fh.close().catch(() => {});
    if (!r.bytes) {
      await unlink(r.file).catch(() => {});
      this.toast('Nothing was recorded', error || 'The media did not play while recording.', null);
      return;
    }
    const mb = (r.bytes / 1024 / 1024).toFixed(r.bytes < 10 * 1024 * 1024 ? 1 : 0);
    this.toast(error ? 'Recording stopped' : 'Recording saved', `${path.basename(r.file)} · ${elapsed(Date.now() - r.startedAt)} · ${mb} MB${error ? `\n${error}` : ''}`, r.file);
  }

  toast(title, body, file) {
    if (!this.notify || !Notification.isSupported()) return;
    const n = new Notification({ title, body, silent: true });
    if (file) n.on('click', () => shell.showItemInFolder(file));
    n.show();
  }
}
