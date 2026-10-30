// Image/video saver (Browser.registerFeature).
//
// * Toolbar button: its badge counts the pictures and videos the page in the tab loaded, from the
//   session's webRequest completions (no DOM scanning while you browse; tracking pixels and other
//   tiny responses are not counted).
// * Popup: on open, every frame of the tab lists its pictures and videos (content preload,
//   src/preload/features/media.js); merged with what the network saw, de-duplicated, shown as a grid
//   of thumbnails with checkboxes, type filters and a small-image toggle (src/shell/overlay-media.js).
//   Streams that cannot be saved (MediaSource, DRM, live, HLS/DASH) are listed with the reason.
// * Thumbnails are fetched here through the tab's own session, downscaled with nativeImage (PNG,
//   JPEG) or passed on as the original bytes (other formats, when small) — always data: URLs, the
//   popup's CSP allows no remote images. Sent in batches so the popup opens at once and fills in.
// * "Save N to folder…": native folder picker (last folder remembered per profile; private windows
//   remember it in memory only), then up to 4 files at a time through the tab's session — with the
//   cookies and Referer the page's own request would carry, never SameSite=Strict/Lax cookies for a
//   cross-site file — size caps, the real type sniffed from the bytes, safe unique names (never
//   overwriting) and on Windows a Mark-of-the-Web. Progress and the result stay in the popup.
//
// Private windows use their session; nothing is kept but the files the user saves.

import { app, ipcMain, dialog, shell, nativeImage, webFrameMain, webContents as allWebContents } from 'electron';
import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { registrableDomain } from '../../lib/url-match.js';
import { log } from '../util/log.js';
import { TYPES, typeFromMime } from './pick.js';
import { MediaCounter, mergeReports, negotiated, COUNTED_RESOURCES } from './collect.js';
import { LIMITS, sniffType, imageSize, fileNameFor, createExclusive, removeQuietly, markOfTheWeb, decodeDataUrl, referrerFor, cookieHeaderFor } from './files.js';

export const POPUP_WIDTH = 600;
const COLLECT_TIMEOUT = 2500; // frames answer at once; blob: video checks take up to 1.8 s
const THUMB_PX = 220;
const THUMB_FETCH_MAX = 16 * 1024 * 1024;
const RAW_THUMB_MAX = 1.5 * 1024 * 1024; // per picture the popup decodes itself (WebP, AVIF, GIF, SVG…)
const RAW_THUMB_TOTAL = 48 * 1024 * 1024; // per popup
const THUMB_CONCURRENCY = 6;
const SAVE_CONCURRENCY = 4;
const BLOB_MAX = 128 * 1024 * 1024;
const HEAD_BYTES = 4096;
const STALL_MS = 60 * 1000;
const MARKER = 'x-ludworks-media';
const DIR_KEY = 'media_saver_dir';
// Saved files should be the JPEG/PNG/GIF the address names: CDNs that pick a format from Accept
// (Wikimedia, imgix, Cloudinary, Cloudflare…) only send WebP/AVIF to clients that list them.
// Thumbnails ask the same way, so what the popup shows is what gets saved.
const ACCEPT_IMAGE = 'image/jpeg,image/png,image/gif,image/svg+xml,image/*;q=0.8,*/*;q=0.5';

const siteOf = (url) => {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? registrableDomain(u.hostname) : '';
  } catch {
    return '';
  }
};

/** Hosts of the local machine / private networks: never fetched for a thumbnail on a public page's behalf. */
function privateHost(host) {
  const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  return h === '::1' || /^f[cd][0-9a-f]{2}:/.test(h) || /^fe80:/.test(h);
}

/**
 * Whether the popup may request `url` by itself (thumbnails, size probes): http(s), and not a
 * local/private-network host unless the page is on one too. Saving is the user's explicit choice.
 */
function mayFetch(s, url) {
  let host;
  let pageHost = '';
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    host = u.hostname;
    pageHost = new URL(s.pageUrl).hostname;
  } catch {
    if (!host) return false;
  }
  return !privateHost(host) || privateHost(pageHost);
}

class SaveError extends Error {}

export class MediaSaver {
  /** @param {import('../browser.js').Browser} browser */
  constructor(browser) {
    this.b = browser;
    this.name = 'media';
    this.popups = ['media'];
    this.counter = new MediaCounter();
    this.watched = new Set();
    this.dirty = new Set();
    this.refreshTimer = null;
    this.sessions = new Map(); // WindowCtl → popup session (the page's list, thumbnails, UI state)
    this.jobs = new Map(); // WindowCtl → latest save job
    this.anchors = new Map(); // WindowCtl → where the popup last opened (the toolbar button)
    this.collects = new Map(); // request id → frames being asked for their lists
    this.blobReads = new Map(); // request id → a frame reading one of its blob: URLs
    this.requests = new Map(); // marker → what our own request should carry (see ownRequestHeaders)
    this.thumbCaches = new WeakMap(); // Electron session → Map(url → thumbnail)
    this.privateDirs = new WeakMap(); // private session → last folder (never written to the profile)
    ipcMain.on('media:found', (e, msg) => this.onFound(e, msg));
    ipcMain.on('media:blob-data', (e, msg) => this.onBlobData(e, msg));
  }

  // ===================================================================== network: badge counts
  attachSession(ses, hub) {
    hub.onBeforeRequest((d) => {
      if (d.resourceType !== 'mainFrame' || d.webContentsId == null) return null;
      this.counter.reset(d.webContentsId, d.url);
      this.watch(d.webContentsId);
      this.markDirty(d.webContentsId);
      return null;
    });
    hub.onBeforeSendHeaders((d, headers) => {
      if (d.webContentsId == null) this.ownRequestHeaders(d, headers);
      return null;
    });
    hub.onCompleted((d) => {
      if (d.webContentsId == null || !COUNTED_RESOURCES.has(d.resourceType)) return;
      if (this.counter.note(d.webContentsId, d)) this.markDirty(d.webContentsId);
    });
  }

  watch(wcId) {
    if (this.watched.has(wcId)) return;
    const wc = allWebContents.fromId(wcId);
    if (!wc || wc.isDestroyed()) return;
    this.watched.add(wcId);
    wc.once('destroyed', () => {
      this.watched.delete(wcId);
      this.counter.drop(wcId);
    });
  }

  markDirty(id) {
    this.dirty.add(id);
    if (!this.refreshTimer) this.refreshTimer = setTimeout(() => this.refreshNow(), 400);
  }

  refreshNow() {
    this.refreshTimer = null;
    const ids = this.dirty;
    this.dirty = new Set();
    if (!this.b.prefs.get('mediaSaverButton')) return;
    for (const ctl of this.b.windows) {
      if (ctl.destroyed) continue;
      const t = ctl.activeTab();
      if (t && !t.wc.isDestroyed() && ids.has(t.wc.id)) this.b.refreshToolbar(ctl);
    }
  }

  // ============================================================= our own requests (thumbs, saves)
  /**
   * Fetches `url` through the tab's session as the page's own request would go out: no SameSite
   * Lax/Strict cookies for a cross-site file (none at all when third-party cookies are blocked), the
   * page as Referer (strict-origin-when-cross-origin), recomputed for every redirect hop; cookies
   * only for the original host. Electron's fetch would otherwise send every cookie, and no Referer.
   */
  async mediaFetch(s, url, { signal, accept = ACCEPT_IMAGE, range = null, cache = 'default' } = {}) {
    let host = '';
    try {
      host = new URL(url).hostname;
    } catch {
      throw new SaveError('bad address');
    }
    let cookies = [];
    try {
      cookies = await s.ses.cookies.get({ url });
    } catch {
      cookies = [];
    }
    const token = randomUUID();
    this.requests.set(token, { pageUrl: s.pageUrl, pageSite: siteOf(s.pageUrl), host, cookies, block: !!this.b.prefs.get('blockThirdPartyCookies') });
    const headers = { Accept: accept, [MARKER]: token };
    if (range) headers.Range = range;
    try {
      return await s.ses.fetch(url, { credentials: 'omit', redirect: 'follow', cache, headers, signal, bypassCustomProtocolHandlers: true });
    } finally {
      this.requests.delete(token); // the final response's headers are in: no more hops
    }
  }

  ownRequestHeaders(d, headers) {
    let key = null;
    for (const k of Object.keys(headers)) {
      if (k.toLowerCase() === MARKER) {
        key = k;
        break;
      }
    }
    if (!key) return;
    const ctx = this.requests.get(String(headers[key]));
    delete headers[key];
    for (const k of Object.keys(headers)) if (/^(cookie|referer)$/i.test(k)) delete headers[k];
    if (!ctx) return;
    const ref = referrerFor(ctx.pageUrl, d.url);
    if (ref) headers.Referer = ref;
    let host = '';
    try {
      host = new URL(d.url).hostname;
    } catch {
      return;
    }
    if (host !== ctx.host || !ctx.cookies.length) return;
    const cookie = cookieHeaderFor(ctx.cookies, d.url, { pageSite: ctx.pageSite, urlSite: siteOf(d.url), blockThirdParty: ctx.block });
    if (cookie) headers.Cookie = cookie;
  }

  // ===================================================================================== toolbar
  toolbarButtons(ctl, tab) {
    if (!this.b.prefs.get('mediaSaverButton')) return [];
    const url = tab && !tab.wc.isDestroyed() ? tab.wc.getURL() : '';
    const n = /^https?:/i.test(url) ? this.counter.count(tab.wc.id, url) : 0;
    const job = this.jobs.get(ctl);
    const busy = job && !job.finished;
    const title = busy ? `Saving ${job.saved.length + job.failed.length} of ${job.total}…` : n ? `Save images and videos (${n} on this page)` : 'Save images and videos';
    return [{ id: 'media', order: 40, icon: 'images', badge: n ? (n > 999 ? '999+' : n) : null, tone: n || busy ? undefined : 'muted', pressed: !!busy, title, popup: { kind: 'media', width: POPUP_WIDTH } }];
  }

  contextMenuItems(tab, p) {
    if (!/^https?:/i.test(tab.wc.getURL())) return [];
    if (p.isEditable || (p.linkURL && p.mediaType === 'none') || (p.selectionText && p.selectionText.trim())) return [];
    return [{ label: 'Save images on this page…', click: () => this.openFromMenu(tab) }];
  }

  openFromMenu(tab) {
    const ctl = tab.ctl;
    if (!ctl || ctl.destroyed || tab.destroyed) return;
    if (ctl.activeId !== tab.id) ctl.activate(tab.id);
    const [cw] = ctl.win.getContentSize();
    const anchor = this.anchors.get(ctl) || { x: Math.max(8, cw - POPUP_WIDTH - 110), y: ctl.topInset - 4, width: POPUP_WIDTH };
    this.b.openPopup(ctl, 'media', anchor, {}).catch((e) => log.warn('media: popup failed', { message: e.message }));
  }

  // ======================================================================================= popup
  async openPopup(ctl, _kind, anchor) {
    for (const c of [...this.sessions.keys(), ...this.jobs.keys()]) {
      if (!c.destroyed) continue; // closed windows: forget their lists, thumbnails and results
      this.sessions.delete(c);
      this.jobs.delete(c);
      this.anchors.delete(c);
    }
    const [cw, ch] = ctl.win.getContentSize();
    const width = Math.max(320, Math.min(POPUP_WIDTH, cw - 24));
    const a = { ...anchor, x: anchor.x + (anchor.width || width) - width, width };
    this.anchors.set(ctl, anchor);
    const tab = ctl.activeTab();
    const url = tab && !tab.wc.isDestroyed() ? tab.wc.getURL() : '';
    const done = this.jobs.get(ctl);
    if (done && done.finished && (done.pageUrl !== url || Date.now() - done.endedAt > 5 * 60 * 1000)) this.jobs.delete(ctl); // an old result
    const web = /^https?:/i.test(url);
    let host = '';
    try {
      host = web ? new URL(url).host : '';
    } catch {
      host = '';
    }
    const s = {
      sid: randomUUID(),
      ctl,
      tabId: tab ? tab.id : null,
      wc: tab ? tab.wc : null,
      ses: tab ? tab.wc.session : null,
      pageUrl: url,
      host,
      web,
      private: !!ctl.private,
      anchor: a,
      maxHeight: Math.max(240, ch - a.y - 24),
      items: [],
      byId: new Map(),
      thumbs: new Map(),
      collecting: web,
      picking: false,
      thumbing: false,
      ui: carryUi(this.sessions.get(ctl), url),
    };
    this.sessions.set(ctl, s);
    await ctl.showPopup('media', this.popupData(ctl, s), a);
    if (web) this.collect(ctl, s).catch((e) => log.warn('media: collect failed', { message: e.message }));
  }

  popupData(ctl, s) {
    return {
      sid: s.sid,
      web: s.web,
      host: s.host,
      private: s.private,
      collecting: s.collecting,
      picking: s.picking,
      maxHeight: s.maxHeight,
      items: s.items.filter((it) => !it.gone).map(publicItem),
      thumbs: [...s.thumbs.values()].filter((t) => !t.notMedia),
      ui: s.ui,
      job: jobView(this.jobs.get(ctl)),
    };
  }

  /** Sends fresh data to the media popup of `ctl`, if it shows session `s`. */
  send(ctl, s, data) {
    if (ctl.destroyed || !ctl.popup || ctl.popup.kind !== 'media' || !ctl.overlay || this.sessions.get(ctl) !== s) return false;
    ctl.overlay.webContents.send('popup-data', { kind: 'media', data: { sid: s.sid, ...data } });
    return true;
  }

  /** The popup closes while the native folder dialog is up (the window loses focus): bring it back. */
  reshow(ctl, s) {
    if (ctl.destroyed || this.sessions.get(ctl) !== s) return;
    if (ctl.popup && ctl.popup.kind === 'media') {
      this.send(ctl, s, this.popupData(ctl, s));
      return;
    }
    if (ctl.popup || ctl.activeId !== s.tabId) return; // something else is open now: the job runs on
    ctl.showPopup('media', this.popupData(ctl, s), s.anchor).then(() => this.thumbs(ctl, s));
  }

  live(ctl, s) {
    return !ctl.destroyed && this.sessions.get(ctl) === s && ((ctl.popup && ctl.popup.kind === 'media') || s.picking);
  }

  async popupAction(ctl, _kind, action, d) {
    const s = this.sessions.get(ctl);
    const mine = s && d && d.sid === s.sid;
    switch (action) {
      case 'save':
        if (!mine) return { error: 'The page changed: open the list again.' };
        return this.startSave(ctl, s, Array.isArray(d.ids) ? d.ids.filter((x) => typeof x === 'string').slice(0, 5000) : [], cleanUi(d.ui));
      case 'ui':
        if (mine) s.ui = cleanUi(d.ui);
        return null;
      case 'cancel': {
        const job = this.jobs.get(ctl);
        if (job && !job.finished) {
          job.cancelled = true;
          job.abort.abort();
        }
        return jobView(job);
      }
      case 'open-folder': {
        const job = this.jobs.get(ctl);
        if (job && job.dir) shell.openPath(job.dir).catch(() => {});
        ctl.hidePopup('media');
        return null;
      }
      case 'dismiss':
        if (this.jobs.get(ctl) && this.jobs.get(ctl).finished) this.jobs.delete(ctl);
        return null;
      case 'rescan':
        if (mine) s.ui = cleanUi(d.ui);
        return this.openPopup(ctl, 'media', this.anchors.get(ctl) || s.anchor);
      case 'open': {
        const it = mine ? s.byId.get(String(d.id)) : null;
        const tab = ctl.tabById(s ? s.tabId : -1);
        if (it && /^https?:/i.test(it.url)) ctl.newTab({ url: it.url, active: true, opener: tab || null });
        return null;
      }
      default:
        throw new Error(`unknown popup action media:${action}`);
    }
  }

  // ===================================================================================== collect
  async collect(ctl, s) {
    const wc = s.wc;
    if (!wc || wc.isDestroyed()) return;
    let frames = [];
    try {
      frames = wc.mainFrame.framesInSubtree.filter((f) => /^https?:/i.test(f.url || ''));
    } catch {
      frames = [];
    }
    const id = randomUUID();
    const p = { wcId: wc.id, expected: 0, got: 0, seen: new Set(), reports: [], resolve: null };
    const done = new Promise((resolve) => {
      p.resolve = resolve;
    });
    this.collects.set(id, p);
    for (const f of frames) {
      try {
        f.send('media:collect', { id });
        p.expected++;
      } catch {
        /* frame gone */
      }
    }
    const timer = setTimeout(p.resolve, COLLECT_TIMEOUT);
    if (!p.expected) p.resolve();
    await done;
    clearTimeout(timer);
    this.collects.delete(id);
    const order = new Map(frames.map((f, i) => [`${f.processId}:${f.routingId}`, i]));
    p.reports.sort((x, y) => (order.get(x.key) ?? 1e9) - (order.get(y.key) ?? 1e9));
    const items = mergeReports(p.reports, this.counter.entries(wc.id, s.pageUrl));
    for (const it of items) it.saveable = !it.reason && (/^(https?|data):/i.test(it.url) || (/^blob:/i.test(it.url) && !!it.frame));
    if (this.sessions.get(ctl) !== s) return;
    s.items = items;
    s.byId = new Map(items.map((it) => [it.id, it]));
    s.collecting = false;
    this.send(ctl, s, { items: items.map(publicItem), collecting: false });
    this.thumbs(ctl, s);
  }

  onFound(e, msg) {
    if (!msg || typeof msg.id !== 'string') return;
    const p = this.collects.get(msg.id);
    const f = e.senderFrame;
    if (!p || !f || !e.sender || e.sender.id !== p.wcId) return;
    const key = `${f.processId}:${f.routingId}`;
    if (p.seen.has(key)) return;
    p.seen.add(key);
    p.reports.push({ key, frame: { processId: f.processId, routingId: f.routingId }, items: Array.isArray(msg.items) ? msg.items.slice(0, 5000) : [] });
    if (++p.got >= p.expected) p.resolve();
  }

  /** Bytes of a blob: URL, read by the frame that created it (the only one that can). */
  readBlob(s, fr, url, max) {
    let frame = null;
    try {
      frame = fr ? webFrameMain.fromId(fr.processId, fr.routingId) : null;
    } catch {
      frame = null;
    }
    if (!frame || !s.wc || s.wc.isDestroyed() || frame.top !== s.wc.mainFrame) return Promise.resolve({ ok: false, error: 'gone' });
    const id = randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.blobReads.delete(id);
        resolve({ ok: false, error: 'timeout' });
      }, 30 * 1000);
      this.blobReads.set(id, { key: `${fr.processId}:${fr.routingId}`, max, resolve: (r) => (clearTimeout(timer), resolve(r)) });
      try {
        frame.send('media:blob', { id, url, max });
      } catch {
        this.blobReads.delete(id);
        clearTimeout(timer);
        resolve({ ok: false, error: 'gone' });
      }
    });
  }

  onBlobData(e, msg) {
    if (!msg || typeof msg.id !== 'string') return;
    const p = this.blobReads.get(msg.id);
    const f = e.senderFrame;
    if (!p || !f || `${f.processId}:${f.routingId}` !== p.key) return;
    this.blobReads.delete(msg.id);
    const b = msg.bytes;
    if (b instanceof Uint8Array && b.byteLength > p.max) return p.resolve({ ok: false, error: 'too-large' }); // the page side is not trusted with the cap
    if (!msg.ok || !(b instanceof Uint8Array)) return p.resolve({ ok: false, error: msg.error === 'too-large' ? 'too-large' : 'gone' });
    p.resolve({ ok: true, type: typeof msg.type === 'string' ? msg.type : '', bytes: Buffer.from(b.buffer, b.byteOffset, b.byteLength) });
  }

  // ================================================================================== thumbnails
  cacheFor(ses) {
    let c = this.thumbCaches.get(ses);
    if (!c) {
      c = new Map();
      this.thumbCaches.set(ses, c);
    }
    return c;
  }

  async thumbs(ctl, s) {
    if (s.thumbing) return;
    s.thumbing = true;
    try {
      const todo = s.items.filter((it) => !s.thumbs.has(it.id) && !it.gone);
      let batch = [];
      let gone = [];
      let last = Date.now();
      const flush = () => {
        if (batch.length || gone.length) this.send(ctl, s, { thumbs: batch, remove: gone });
        batch = [];
        gone = [];
        last = Date.now();
      };
      const worker = async () => {
        while (todo.length && this.live(ctl, s)) {
          const it = todo.shift();
          let t;
          try {
            t = await this.thumbFor(s, it);
          } catch {
            t = { id: it.id };
          }
          s.thumbs.set(it.id, t);
          if (t.fallback && it.thumb) {
            it.url = it.thumb; // the largest srcset size is broken: the shown size is what gets saved
            it.thumb = '';
          }
          if (t.notMedia && it.kinds.every((k) => k === 'link')) {
            // a link that only looked like a picture (a page about it, a download page…): not listed
            it.gone = true;
            it.saveable = false;
            gone.push(it.id);
          } else {
            if (t.exact && negotiated(t.type, it.url)) {
              // the cached copy is the WebP/AVIF the page got; the save asks for the address type
              t.exact = false;
              t.shape = true;
              delete t.bytes;
            } else {
              if (t.type && (t.exact || !it.type)) it.type = t.type; // the bytes we would save decide
              if (t.bytes && t.exact) it.bytes = t.bytes;
            }
            if (it.type && TYPES[it.type]) t.label = TYPES[it.type].label;
            const cap = it.type && TYPES[it.type] ? LIMITS[TYPES[it.type].kind] : 0;
            if (cap && it.saveable && it.bytes > cap && /^https?:/i.test(it.url)) {
              it.saveable = false; // known up front: say so instead of failing after the folder dialog
              it.reason = 'big';
              Object.assign(t, { reason: 'big', limitMB: Math.round(cap / 1048576) });
            }
            batch.push(t);
          }
          if (batch.length + gone.length >= 12 || Date.now() - last > 250) flush();
        }
      };
      await Promise.all(Array.from({ length: THUMB_CONCURRENCY }, worker));
      flush();
    } finally {
      s.thumbing = false;
    }
  }

  async thumbFor(s, it) {
    const out = { id: it.id };
    const video = (it.type && TYPES[it.type].kind === 'video') || it.kinds.includes('video') || it.kinds.includes('source');
    if (video) {
      if (!it.reason && mayFetch(s, it.url)) {
        const info = await this.probeFile(s, it.url);
        if (info.fetched && !info.type) out.notMedia = true;
        else if (info.fetched) Object.assign(out, { bytes: info.bytes, type: info.type, exact: true });
      }
      if (it.thumb && !out.notMedia) {
        const p = await this.imageThumb(s, it.thumb, it);
        if (p && p.src) Object.assign(out, { src: p.src, raw: p.raw });
      }
      return out;
    }
    if (it.reason) return out;
    const src = it.thumb || it.url;
    const p = await this.imageThumb(s, src, it);
    const shown = p && p.type ? p : null; // the thumbnail's source is a picture
    // What a save would get, when the thumbnail does not say: another srcset size was shown, or the
    // cached copy is a WebP/AVIF the page negotiated. The first bytes, uncached, as the save asks.
    let info = null;
    if (mayFetch(s, it.url) && (src !== it.url || !shown || shown.type === 'webp' || shown.type === 'avif')) info = await this.probeFile(s, it.url, { accept: ACCEPT_IMAGE });
    const probed = info && info.fetched && info.type ? info : null;
    const broken = !!info && (info.status >= 400 || (info.fetched && !info.type));
    if (p) {
      out.src = p.src;
      out.raw = p.raw;
    }
    const exact = (x, dims) => Object.assign(out, { type: x.type, bytes: x.bytes, exact: true }, dims && dims.w && dims.h ? { w: dims.w, h: dims.h } : {});
    if (src !== it.url) {
      // the largest size listed does not load: save the size the page shows
      if (broken && shown) return Object.assign(exact(shown, shown), { fallback: true });
      if (probed) {
        const shape = it.w && shown && shown.w ? { w: it.w, h: Math.round((it.w * shown.h) / shown.w) } : null; // srcset width + the shown shape
        return exact(probed, probed.w ? probed : shape);
      }
      if (broken || (p && !shown)) return Object.assign(out, { notMedia: true });
      if (shown) {
        if (!it.type) out.type = shown.type;
        if (it.w && !it.h && shown.w) Object.assign(out, { w: it.w, h: Math.round((it.w * shown.h) / shown.w), shape: true });
      }
      return out;
    }
    if (shown) return exact(probed ? { type: probed.type, bytes: probed.bytes } : shown, probed && probed.w ? probed : shown);
    if (probed) return exact(probed, probed);
    if (broken || p) return Object.assign(out, { notMedia: true });
    return out;
  }

  /** {src, w, h, bytes, type, raw} for an image URL (cached per session), or null. */
  async imageThumb(s, url, it) {
    const cache = this.cacheFor(s.ses);
    if (cache.has(url)) return cache.get(url);
    let bytes = null;
    if (/^data:/i.test(url)) {
      const d = decodeDataUrl(url, THUMB_FETCH_MAX);
      bytes = d && d.bytes ? d.bytes : null;
    } else if (/^blob:/i.test(url)) {
      const r = await this.readBlob(s, it && it.frame, url, THUMB_FETCH_MAX);
      bytes = r.ok ? r.bytes : null;
    } else {
      if (!mayFetch(s, url)) return null;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 20 * 1000);
      try {
        const res = await this.mediaFetch(s, url, { signal: ctrl.signal });
        if (!res.ok) return null;
        bytes = await readAll(res, THUMB_FETCH_MAX, ctrl);
      } catch {
        return null;
      } finally {
        clearTimeout(timer);
      }
    }
    if (!bytes) return null;
    const type = sniffType(bytes);
    const size = type ? imageSize(bytes, type) : null;
    const r = { src: '', w: size ? size.w : 0, h: size ? size.h : 0, bytes: bytes.length, type, raw: false };
    if (type === 'jpeg' || type === 'png') {
      const img = nativeImage.createFromBuffer(bytes);
      if (!img.isEmpty()) {
        const { width, height } = img.getSize();
        if (!r.w) [r.w, r.h] = [width, height];
        const scale = Math.min(1, THUMB_PX / Math.max(width, height));
        const small = scale < 1 ? img.resize({ width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)), quality: 'good' }) : img;
        r.src = type === 'jpeg' ? `data:image/jpeg;base64,${small.toJPEG(82).toString('base64')}` : small.toDataURL();
      }
    }
    if (!r.src && type && TYPES[type].kind === 'image' && bytes.length <= RAW_THUMB_MAX && (s.rawBytes || 0) + bytes.length <= RAW_THUMB_TOTAL) {
      // Formats nativeImage cannot decode (WebP, AVIF, GIF, SVG, BMP…): the popup draws the original.
      s.rawBytes = (s.rawBytes || 0) + bytes.length;
      r.src = `data:${TYPES[type].mime};base64,${bytes.toString('base64')}`;
      r.raw = true;
    }
    cache.set(url, r);
    if (cache.size > 600) cache.delete(cache.keys().next().value);
    return r;
  }

  /**
   * Type, total size and (from the header) pixel size of a file without downloading it: its first
   * bytes, by a range request, uncached and with the Accept header a save sends.
   */
  async probeFile(s, url, { accept = '*/*' } = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10 * 1000);
    try {
      const res = await this.mediaFetch(s, url, { signal: ctrl.signal, accept, range: `bytes=0-${HEAD_BYTES - 1}`, cache: 'no-store' });
      if (!res.ok) {
        ctrl.abort();
        return { status: res.status };
      }
      const head = await readAll(res, HEAD_BYTES, ctrl, { truncate: true });
      let bytes = 0;
      if (res.status === 206) bytes = Number((/\/\s*(\d+)\s*$/.exec(res.headers.get('content-range') || '') || [])[1]) || 0;
      else bytes = Number(res.headers.get('content-length')) || 0;
      const declared = typeFromMime(res.headers.get('content-type'));
      const type = sniffType(head) || (declared && TYPES[declared].kind === 'video' ? declared : '');
      const size = type && TYPES[type].kind === 'image' ? imageSize(head, type) : null;
      return { fetched: true, bytes, type, w: size ? size.w : 0, h: size ? size.h : 0 };
    } catch {
      return {};
    } finally {
      clearTimeout(timer);
    }
  }

  // ======================================================================================== save
  startSave(ctl, s, ids, ui) {
    const running = this.jobs.get(ctl);
    if (running && !running.finished) return { error: 'Already saving: wait for it to finish or cancel it.' };
    const items = ids.map((id) => s.byId.get(id)).filter((it) => it && it.saveable);
    if (!items.length) return { error: 'Select the pictures or videos to save.' };
    s.ui = ui;
    s.picking = true;
    (async () => {
      let dir = null;
      try {
        dir = await this.chooseFolder(ctl);
      } finally {
        s.picking = false;
      }
      if (!dir || ctl.destroyed) {
        this.reshow(ctl, s);
        return;
      }
      if (ctl.private) this.privateDirs.set(ctl.session, dir); // memory only, gone with the private session
      else this.b.db.setMeta(DIR_KEY, dir);
      const expected = items.every((it) => it.bytes > 0) ? items.reduce((n, it) => n + it.bytes, 0) : 0;
      const job = { id: randomUUID(), dir, pageUrl: s.pageUrl, total: items.length, expected, saved: [], failed: [], bytes: 0, finished: false, cancelled: false, abort: new AbortController(), startedAt: Date.now(), pushedAt: 0 };
      job.onBytes = () => this.pushJob(ctl, job);
      this.jobs.set(ctl, job);
      this.b.refreshToolbar(ctl);
      this.reshow(ctl, s);
      await this.runJob(ctl, s, job, items);
    })().catch((e) => log.warn('media: save failed', { message: e.message }));
    return { picking: true };
  }

  lastDir(ctl) {
    return (ctl.private && this.privateDirs.get(ctl.session)) || this.b.db.getMeta(DIR_KEY, '') || '';
  }

  /**
   * The folder to save into: the native folder picker. Tests (an explicit --user-data-dir profile
   * started with LUDWORKS_TEST_SAVE_DIR) skip the dialog, which automation cannot drive.
   */
  async chooseFolder(ctl) {
    const test = process.env.LUDWORKS_TEST_SAVE_DIR;
    if (test && this.b.explicitProfile && path.isAbsolute(test)) return test;
    let def = this.lastDir(ctl);
    if (def) {
      try {
        if (!(await stat(def)).isDirectory()) def = '';
      } catch {
        def = '';
      }
    }
    if (!def) {
      try {
        def = app.getPath('pictures');
      } catch {
        def = app.getPath('downloads');
      }
    }
    const res = await dialog.showOpenDialog(ctl.win, { title: 'Save pictures and videos to', buttonLabel: 'Save here', defaultPath: def, properties: ['openDirectory', 'createDirectory', 'promptToCreate'] });
    if (res.canceled || !res.filePaths || !res.filePaths[0]) return null;
    try {
      return (await stat(res.filePaths[0])).isDirectory() ? res.filePaths[0] : null;
    } catch {
      return null;
    }
  }

  async runJob(ctl, s, job, items) {
    const queue = items.slice();
    const worker = async () => {
      while (queue.length && !job.cancelled) {
        const it = queue.shift();
        try {
          job.saved.push(await this.saveOne(s, job, it));
        } catch (e) {
          job.failed.push({ id: it.id, name: shortName(it), error: job.cancelled ? 'Cancelled' : friendly(e) });
        }
        this.pushJob(ctl, job);
      }
    };
    await Promise.all(Array.from({ length: Math.min(SAVE_CONCURRENCY, queue.length) }, worker));
    for (const it of queue) job.failed.push({ id: it.id, name: shortName(it), error: 'Cancelled' });
    job.finished = true;
    job.endedAt = Date.now();
    this.pushJob(ctl, job, true);
    this.b.refreshToolbar(ctl);
    log.info('media: saved', { saved: job.saved.length, failed: job.failed.length, cancelled: job.cancelled });
  }

  pushJob(ctl, job, force = false) {
    const now = Date.now();
    if (!force && now - job.pushedAt < 150) return;
    job.pushedAt = now;
    const s = this.sessions.get(ctl);
    if (s && this.jobs.get(ctl) === job) this.send(ctl, s, { job: jobView(job) });
    if (force || now - (job.toolbarAt || 0) > 1000) {
      job.toolbarAt = now;
      this.b.refreshToolbar(ctl);
    }
  }

  /** Saves one item into job.dir; returns {id, name, bytes}. */
  async saveOne(s, job, it) {
    const signal = job.abort.signal;
    const src = await this.openSource(s, it, signal);
    let file = null;
    let fh = null;
    try {
      const head = await src.head(HEAD_BYTES);
      let type = sniffType(head);
      if (!type) {
        const declared = typeFromMime(src.contentType);
        // A server can say image/… for bytes we do not recognise (rare formats): trust it unless the
        // bytes are a web page or script.
        if (declared && declared !== 'svg' && !/^\s*</.test(head.subarray(0, 64).toString('latin1'))) type = declared;
      }
      if (!type) throw new SaveError('not-media');
      const cap = LIMITS[TYPES[type].kind];
      if (src.length > cap) throw new SaveError(`too-large:${cap}`);
      const name = fileNameFor({ url: it.url, disposition: src.disposition, type, fallback: fallbackStem(it) });
      const created = await createExclusive(job.dir, name);
      fh = created.fh;
      file = created.file;
      let written = 0;
      const write = async (buf) => {
        written += buf.length;
        if (written > cap) throw new SaveError(`too-large:${cap}`);
        for (let off = 0; off < buf.length; ) off += (await fh.write(buf, off, buf.length - off)).bytesWritten;
        job.bytes += buf.length;
        if (job.onBytes) job.onBytes(); // throttled progress for big files
      };
      await write(head);
      for (;;) {
        if (signal.aborted) throw new SaveError('cancelled');
        const chunk = await src.next();
        if (!chunk) break;
        await write(chunk);
      }
      await fh.close();
      fh = null;
      await markOfTheWeb(file, { hostUrl: it.url, referrerUrl: s.pageUrl, isPrivate: s.private });
      return { id: it.id, name: created.name, bytes: written };
    } catch (e) {
      if (fh) await fh.close().catch(() => {});
      if (file) await removeQuietly(file);
      src.cancel();
      throw e;
    }
  }

  /**
   * A readable source for an item: {head(n), next(), cancel(), contentType, disposition, length}.
   * http(s) through the tab's session, data: decoded here, blob: read by the frame that made it.
   */
  async openSource(s, it, signal) {
    if (/^data:/i.test(it.url)) {
      const d = decodeDataUrl(it.url, LIMITS.video);
      if (!d) throw new SaveError('not-media');
      if (d.error) throw new SaveError(`too-large:${LIMITS.video}`);
      return bufferSource(d.bytes, d.mime);
    }
    if (/^blob:/i.test(it.url)) {
      const r = await this.readBlob(s, it.frame, it.url, BLOB_MAX);
      if (!r.ok) throw new SaveError(r.error === 'too-large' ? `too-large:${BLOB_MAX}` : 'blob-gone');
      return bufferSource(r.bytes, r.type);
    }
    const video = it.type && TYPES[it.type].kind === 'video';
    // Not from the HTTP cache: servers that pick the format from Accept rarely say Vary: Accept, so a
    // cached copy would be the WebP/AVIF the page asked for (and nothing we save goes into the cache).
    const res = await this.mediaFetch(s, it.url, { signal, accept: video ? '*/*' : ACCEPT_IMAGE, cache: 'no-store' });
    if (!res.ok) {
      try {
        if (res.body) res.body.cancel();
      } catch {
        /* ignore */
      }
      throw new SaveError(`http:${res.status}`);
    }
    return streamSource(res, signal);
  }
}

// ------------------------------------------------------------------------------------- helpers
function bufferSource(bytes, contentType) {
  let pos = 0;
  return {
    contentType: contentType || '',
    disposition: '',
    length: bytes.length,
    async head(n) {
      pos = Math.min(n, bytes.length);
      return bytes.subarray(0, pos);
    },
    async next() {
      if (pos >= bytes.length) return null;
      const c = bytes.subarray(pos, pos + 1024 * 1024);
      pos += c.length;
      return c;
    },
    cancel() {},
  };
}

/** Reads a fetch Response body as a source, with a stall timeout per chunk. */
function streamSource(res, signal) {
  const reader = res.body.getReader();
  let pending = [];
  const read = async () => {
    let timer;
    const stall = new Promise((_r, reject) => {
      timer = setTimeout(() => reject(new SaveError('stalled')), STALL_MS);
    });
    try {
      const { done, value } = await Promise.race([reader.read(), stall]);
      return done ? null : Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    } finally {
      clearTimeout(timer);
    }
  };
  const lenHeader = res.headers.get('content-length');
  return {
    contentType: res.headers.get('content-type') || '',
    disposition: res.headers.get('content-disposition') || '',
    length: lenHeader && /^\d+$/.test(lenHeader) ? Number(lenHeader) : 0,
    async head(n) {
      const parts = [];
      let got = 0;
      while (got < n) {
        if (signal.aborted) throw new SaveError('cancelled');
        const c = await read();
        if (!c) break;
        parts.push(c);
        got += c.length;
      }
      const all = Buffer.concat(parts);
      pending = all.length > n ? [all.subarray(n)] : [];
      return all.subarray(0, Math.min(n, all.length));
    },
    async next() {
      if (pending.length) return pending.shift();
      return read();
    },
    cancel() {
      reader.cancel().catch(() => {});
    },
  };
}

/** The whole body of a response up to `max` bytes (aborts beyond; `truncate` keeps the first `max`). */
async function readAll(res, max, ctrl, { truncate = false } = {}) {
  const len = Number(res.headers.get('content-length')) || 0;
  if (len > max && !truncate) {
    ctrl.abort();
    return null;
  }
  const reader = res.body.getReader();
  const parts = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
    got += value.byteLength;
    if (got >= max) {
      ctrl.abort();
      if (!truncate) return null;
      break;
    }
  }
  const all = Buffer.concat(parts);
  return truncate ? all.subarray(0, max) : all;
}

function publicItem(it) {
  const data = /^data:/i.test(it.url);
  return {
    id: it.id,
    href: data ? `data:${(/^data:([^;,]*)/i.exec(it.url) || [])[1] || ''} (inline)` : /^stream:/.test(it.url) ? '' : it.url.slice(0, 2048),
    name: shortName(it),
    type: it.type || '',
    label: it.type && TYPES[it.type] ? TYPES[it.type].label : '',
    video: (it.type ? TYPES[it.type].kind === 'video' : false) || it.kinds.includes('video') || it.kinds.includes('source'),
    w: it.w,
    h: it.h,
    dw: it.dw,
    dh: it.dh,
    bytes: it.bytes || 0,
    alt: it.alt,
    kinds: it.kinds,
    reason: it.reason,
    saveable: !!it.saveable,
  };
}

function shortName(it) {
  if (/^data:/i.test(it.url)) return it.alt || 'Inline image';
  if (/^(blob|stream):/i.test(it.url)) return it.alt || (it.kinds.includes('video') ? 'Video' : 'Image');
  try {
    const u = new URL(it.url);
    const last = u.pathname.split('/').filter(Boolean).pop() || u.hostname;
    return decodeURIComponent(last).slice(0, 120);
  } catch {
    return it.url.slice(0, 120);
  }
}

function fallbackStem(it) {
  const alt = String(it.alt || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  return alt || (it.type && TYPES[it.type].kind === 'video' ? 'video' : 'image');
}

function jobView(job) {
  if (!job) return null;
  return {
    id: job.id,
    total: job.total,
    expected: job.expected || 0,
    saved: job.saved.length,
    failed: job.failed.slice(0, 50).map((f) => ({ name: f.name, error: f.error })),
    failedCount: job.failed.length,
    bytes: job.bytes,
    finished: job.finished,
    cancelled: job.cancelled,
    dir: job.dir,
    dirName: path.basename(job.dir) || job.dir,
  };
}

/** Filters and the small-image toggle survive reopening the popup on the same page (not the selection). */
function carryUi(prev, url) {
  if (!prev || prev.pageUrl !== url || !prev.ui) return null;
  return { selected: [], off: prev.ui.off, small: prev.ui.small };
}

function cleanUi(ui) {
  if (!ui || typeof ui !== 'object') return null;
  const strs = (a, n) => (Array.isArray(a) ? a.filter((x) => typeof x === 'string' && x.length <= 32).slice(0, n) : []);
  return { selected: strs(ui.selected, 5000), off: strs(ui.off, 32), small: !!ui.small };
}

function friendly(e) {
  const m = String((e && e.message) || e || '');
  if (m.startsWith('http:')) return `The server answered HTTP ${m.slice(5)}`;
  if (m.startsWith('too-large:')) return `Larger than ${Math.round(Number(m.slice(10)) / 1048576)} MB`;
  if (m === 'not-media') return 'Not a picture or video (the server sent something else)';
  if (m === 'blob-gone') return 'The page no longer has this file';
  if (m === 'stalled') return 'The download stalled';
  if (m === 'cancelled' || (e && e.name === 'AbortError')) return 'Cancelled';
  if (/ENOSPC/.test(m)) return 'The disk is full';
  if (/EACCES|EPERM/.test(m)) return 'No permission to write in this folder';
  if (/^net::/.test(m)) return `Network error (${m.slice(5)})`;
  return 'Could not be saved';
}
