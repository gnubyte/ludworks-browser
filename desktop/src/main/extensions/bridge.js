// IPC between the extension preload (src/preload/extensions.cjs) and the main process.
//
// Contexts: every extension page/frame (popup, options page, MV2 background page…) and the extension's
// service worker. The extension a message belongs to is always taken from the sender — the frame's
// chrome-extension:// URL/origin or the worker's scope — never from the message.
//
// Events reach every context of the extension that listens for them. A stopped service worker is
// started (ses.serviceWorkers.startWorkerForScope) for the events it registered listeners for while it
// last ran ("lazy" listeners, remembered across restarts), and the event is delivered once the worker's
// script has run and registered them again.
//
// A worker only receives messages once Chromium reports it "running": ServiceWorkerMain.send() drops
// them silently while it is still "starting" (its preload can already have said ready by then), so
// events for a worker that is not running yet wait in its queue.

import { ipcMain } from 'electron';
import { log } from '../util/log.js';

const READY_TIMEOUT = 15000;
const MAX_QUEUE = 300;
const EXT_URL = /^chrome-extension:\/\/([a-p]{32})\//;

export class Bridge {
  /** @param {import('./extensions.js').Extensions} mgr */
  constructor(mgr) {
    this.mgr = mgr;
    this.frames = new Map(); // frame key → ctx
    this.workers = new Map(); // extension id → service-worker ctx
    this.hooked = new WeakSet();
    this.status = new Map(); // service worker version id → running status (starting | running | stopping)
    this.pending = new Map(); // extension id → [{name, args, until}] waiting for the background context
    ipcMain.handle('lwext:call', (e, method, args) => this.handleCall(this.frameCtx(e), method, args));
    ipcMain.handle('lwext:hello', (e) => this.hello(this.newFrameCtx(e)));
    ipcMain.on('lwext:listen', (e, name, on, filter) => this.listen(this.frameCtx(e), name, on, filter));
    ipcMain.on('lwext:ready', (e, names) => this.ready(this.frameCtx(e), names));
    ipcMain.on('lwext:log', (e, msg) => log.warn('extension preload', { url: e.senderFrame && e.senderFrame.url.slice(0, 120), msg: String(msg).slice(0, 300) }));
    ipcMain.handle('lwext:store', (e, method, args) => mgr.storeCall(e, String(method), Array.isArray(args) ? args : []));
  }

  // ------------------------------------------------------------------------------- contexts
  /** Who sent a frame IPC message: a page of a loaded extension in our session, else null. */
  identify(e) {
    const frame = e.senderFrame;
    const wc = e.sender;
    if (!frame || !wc || wc.isDestroyed() || wc.session !== this.mgr.ses) return null;
    const url = frame.url || '';
    // extension pages, and about:blank / srcdoc frames inside them (same origin)
    const m = EXT_URL.exec(url) || (/^about:(blank|srcdoc)/.test(url) ? /^chrome-extension:\/\/([a-p]{32})$/.exec(frame.origin || '') : null);
    if (!m || frame.origin !== `chrome-extension://${m[1]}`) return null;
    const ext = this.mgr.loaded.get(m[1]);
    if (!ext) return null;
    return { frame, wc, ext, key: `${frame.processId}:${frame.routingId}` };
  }

  /** A document said hello: it replaces any earlier context of the same frame. */
  newFrameCtx(e) {
    const who = this.identify(e);
    if (!who) return null;
    const { frame, wc, ext, key } = who;
    for (const [k, c] of this.frames) if (k === key || (c.wc === wc && c.treeId === frame.frameTreeNodeId)) this.frames.delete(k);
    const ctx = { kind: 'frame', key, extId: ext.id, frame, wc, treeId: frame.frameTreeNodeId, listeners: new Set(), filters: new Map(), ready: false, queue: [] };
    this.frames.set(key, ctx);
    if (!wc.__lwextWatched) {
      wc.__lwextWatched = true;
      wc.once('destroyed', () => {
        for (const [k, c] of this.frames) if (c.wc === wc) this.frames.delete(k);
      });
    }
    return ctx;
  }

  /** The frame context of an IPC event (null when it is not a page of a loaded extension). */
  frameCtx(e) {
    const who = this.identify(e);
    if (!who) return null;
    const ctx = this.frames.get(who.key);
    if (ctx && ctx.extId === who.ext.id) return ctx;
    return this.newFrameCtx(e);
  }

  /** Hooks a service worker of the session as soon as it starts (before its preload talks to us). */
  attachSession(ses) {
    ses.serviceWorkers.on('running-status-changed', ({ versionId, runningStatus }) => {
      if (runningStatus === 'stopped') this.status.delete(versionId);
      else this.status.set(versionId, runningStatus);
      if (runningStatus === 'starting' || runningStatus === 'running') {
        let sw;
        try {
          sw = ses.serviceWorkers.getWorkerFromVersionID(versionId);
        } catch {
          sw = null;
        }
        if (sw) this.hookWorker(sw);
      } else if (runningStatus === 'stopped' || runningStatus === 'stopping') {
        for (const w of this.workers.values()) {
          if (w.versionId === versionId) {
            w.running = false;
            w.ready = false;
            w.live = false;
            w.sw = null;
          }
        }
      }
    });
  }

  hookWorker(sw) {
    const m = EXT_URL.exec(sw.scope || '');
    if (!m || !this.mgr.loaded.has(m[1])) return;
    const extId = m[1];
    let ctx = this.workers.get(extId);
    if (!ctx || ctx.versionId !== sw.versionId) {
      ctx = { kind: 'sw', extId, versionId: sw.versionId, sw, listeners: new Set(), filters: new Map(), ready: false, running: true, live: false, queue: [], readyWaiters: [] };
      this.workers.set(extId, ctx);
    } else {
      ctx.sw = sw;
      ctx.running = true;
    }
    ctx.live = this.status.get(sw.versionId) === 'running';
    if (ctx.live) this.flushReady(ctx);
    if (this.hooked.has(sw)) return;
    this.hooked.add(sw);
    const own = (e) => {
      const c = this.workers.get(extId);
      return c && e.versionId === c.versionId ? c : null;
    };
    sw.ipc.handle('lwext:call', (e, method, args) => {
      const c = own(e);
      let task = null;
      try {
        task = sw.startTask();
      } catch {
        task = null;
      }
      return this.handleCall(c, method, args).finally(() => {
        try {
          if (task) task.end();
        } catch {
          /* worker gone */
        }
      });
    });
    sw.ipc.handle('lwext:hello', (e) => {
      const c = own(e);
      if (c) {
        c.ready = false;
        c.listeners = new Set();
      }
      return this.hello(c);
    });
    sw.ipc.on('lwext:listen', (e, name, on, filter) => this.listen(own(e), name, on, filter));
    sw.ipc.on('lwext:ready', (e, names) => this.ready(own(e), names));
    sw.ipc.on('lwext:log', (_e, msg) => log.warn('extension worker preload', { ext: extId, msg: String(msg).slice(0, 300) }));
  }

  hello(ctx) {
    if (!ctx) return null;
    return { tabs: this.mgr.api.tabMap() };
  }

  listen(ctx, name, on, filter) {
    if (!ctx || typeof name !== 'string' || name.length > 80) return;
    if (on) {
      ctx.listeners.add(name);
      if (filter) {
        const l = ctx.filters.get(name) || [];
        if (l.length < 50) l.push(filter);
        ctx.filters.set(name, l);
      }
    } else {
      ctx.listeners.delete(name);
      ctx.filters.delete(name);
    }
    if (ctx.kind === 'sw' && ctx.ready) this.mgr.setLazyEvents(ctx.extId, [...ctx.listeners]);
    if (name.startsWith('webRequest.')) this.mgr.api.webRequestListenersChanged();
  }

  ready(ctx, names) {
    if (!ctx) return;
    for (const n of Array.isArray(names) ? names : []) if (typeof n === 'string' && n.length <= 80) ctx.listeners.add(n);
    ctx.ready = true;
    if (ctx.kind === 'sw') {
      this.mgr.setLazyEvents(ctx.extId, [...ctx.listeners]);
      for (const r of ctx.readyWaiters.splice(0)) r(true);
    }
    this.flushReady(ctx);
  }

  /** Delivers what waited for a context: its queued events, then the background's pending ones. */
  flushReady(ctx) {
    if (!ctx.ready || (ctx.kind === 'sw' && !ctx.live)) return;
    for (const q of ctx.queue.splice(0)) if (q.direct || ctx.listeners.has(q.name)) this.send(ctx, q.name, q.args);
    this.flushPending(ctx.extId, ctx);
  }

  async handleCall(ctx, method, args) {
    if (!ctx) return { e: 'Not an extension context.' };
    try {
      const v = await this.mgr.api.call(ctx, String(method), Array.isArray(args) ? args : []);
      // undefined stays undefined (tabs.getCurrent() outside a tab, alarms.get() of an unknown alarm…)
      return v === undefined ? { u: 1 } : { v };
    } catch (e) {
      return { e: e && e.message ? e.message : String(e) };
    }
  }

  // ---------------------------------------------------------------------------------- events
  contextsOf(extId) {
    const out = [];
    for (const c of this.frames.values()) if (c.extId === extId) out.push(c);
    const w = this.workers.get(extId);
    if (w) out.push(w);
    return out;
  }

  /** Does any context of the extension listen for `name` (or would a stopped worker)? */
  listening(extId, name) {
    for (const c of this.contextsOf(extId)) if (c.listeners.has(name)) return true;
    return this.mgr.lazyEvents(extId).includes(name);
  }

  /** Filters registered by the extension for an event (webRequest), null when any listener takes all. */
  filtersOf(extId, name) {
    const out = [];
    for (const c of this.contextsOf(extId)) {
      if (!c.listeners.has(name)) continue;
      const f = c.filters.get(name);
      if (!f || !f.length) return null;
      out.push(...f);
    }
    return out;
  }

  send(ctx, name, args) {
    try {
      if (ctx.kind === 'frame') {
        if (ctx.wc.isDestroyed() || ctx.frame.detached) {
          this.frames.delete(ctx.key);
          return false;
        }
        ctx.frame.send('lwext:event', name, args);
      } else {
        if (!ctx.sw || ctx.sw.isDestroyed()) return false;
        if (!ctx.live) {
          // still starting: send() would be dropped; delivered by flushReady() once it runs
          if (ctx.queue.length < MAX_QUEUE) ctx.queue.push({ name, args, direct: true });
          return true;
        }
        let task = null;
        try {
          task = ctx.sw.startTask();
        } catch {
          task = null;
        }
        ctx.sw.send('lwext:event', name, args);
        if (task) setTimeout(() => {
          try {
            task.end();
          } catch {
            /* gone */
          }
        }, 1500).unref();
      }
      return true;
    } catch (e) {
      if (ctx.kind === 'frame') this.frames.delete(ctx.key);
      log.debug('extension event not delivered', { name, message: e.message });
      return false;
    }
  }

  /**
   * Delivers an event to every context of an extension listening for it; wakes the service worker
   * for events it listens for (lazy) when `wake` is set.
   */
  emit(extId, name, args, { wake = true } = {}) {
    for (const c of this.frames.values()) {
      if (c.extId !== extId) continue;
      if (c.ready) {
        if (c.listeners.has(name)) this.send(c, name, args);
      } else if (c.queue.length < MAX_QUEUE) c.queue.push({ name, args });
    }
    const w = this.workers.get(extId);
    if (w && w.running && w.sw) {
      if (w.ready) {
        if (w.listeners.has(name)) this.send(w, name, args);
      } else if (w.queue.length < MAX_QUEUE) w.queue.push({ name, args });
      return;
    }
    if (wake && this.mgr.lazyEvents(extId).includes(name) && this.mgr.hasWorker(extId)) {
      this.wake(extId)
        .then((ctx) => {
          if (ctx && ctx.listeners.has(name)) this.send(ctx, name, args);
        })
        .catch((e) => log.debug('extension worker did not start', { ext: extId, message: e.message }));
    }
  }

  /** Delivers once the background context (worker / background page) has registered its listeners. */
  emitToBackground(extId, name, args) {
    const w = this.workers.get(extId);
    if (w && w.ready && w.running) {
      if (w.listeners.has(name)) this.send(w, name, args);
      return;
    }
    const bg = [...this.frames.values()].find((c) => c.extId === extId && c.ready && c.wc.getType() === 'backgroundPage');
    if (bg) {
      if (bg.listeners.has(name)) this.send(bg, name, args);
      return;
    }
    const list = this.pending.get(extId) || [];
    list.push({ name, args, until: Date.now() + READY_TIMEOUT });
    this.pending.set(extId, list);
    // a new/updated worker starts anyway; at startup only workers that listen for onStartup are started
    const wanted = name === 'runtime.onInstalled' || this.mgr.lazyEvents(extId).includes(name);
    if (wanted && this.mgr.hasWorker(extId)) this.wake(extId).catch(() => {});
  }

  flushPending(extId, ctx) {
    const list = this.pending.get(extId);
    if (!list) return;
    const isBackground = ctx.kind === 'sw' || ctx.wc.getType() === 'backgroundPage';
    if (!isBackground) return;
    this.pending.delete(extId);
    const now = Date.now();
    for (const p of list) if (p.until >= now && ctx.listeners.has(p.name)) this.send(ctx, p.name, p.args);
  }

  /** Starts the extension's service worker (if needed) and resolves once its listeners are known. */
  wake(extId) {
    const w = this.workers.get(extId);
    if (w && w.running && w.ready) return Promise.resolve(w);
    const scope = `chrome-extension://${extId}/`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout')), READY_TIMEOUT);
      const done = () => {
        clearTimeout(timer);
        resolve(this.workers.get(extId));
      };
      const waitReady = () => {
        const c = this.workers.get(extId);
        if (c && c.ready && c.running) return done();
        if (c) c.readyWaiters.push(done);
        else setTimeout(waitReady, 50);
      };
      this.mgr.ses.serviceWorkers
        .startWorkerForScope(scope)
        .then((sw) => {
          this.hookWorker(sw);
          waitReady();
        })
        .catch((e) => {
          clearTimeout(timer);
          reject(e);
        });
    });
  }

  /** Sends an internal event (__tabs, __permissions) to every context of one or all extensions. */
  broadcast(name, args, extId = null) {
    for (const c of this.frames.values()) if (!extId || c.extId === extId) this.send(c, name, args);
    for (const w of this.workers.values()) if ((!extId || w.extId === extId) && w.running && w.sw) this.send(w, name, args);
  }

  /** Forgets everything about an unloaded extension. */
  drop(extId) {
    for (const [k, c] of this.frames) if (c.extId === extId) this.frames.delete(k);
    this.workers.delete(extId);
    this.pending.delete(extId);
  }

  /** Web contents showing pages of an extension (popups, options pages, background page). */
  webContentsOf(extId) {
    const out = new Set();
    for (const c of this.frames.values()) if (c.extId === extId && !c.wc.isDestroyed()) out.add(c.wc);
    return [...out];
  }
}
