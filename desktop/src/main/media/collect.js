// Image/video saver: per-tab network counting (the toolbar badge) and merging what the frames of a
// page report into one de-duplicated list. Pure bookkeeping, no Electron (unit-tested).

import { TYPES, typeFromMime, typeFromUrl, streamKind } from './pick.js';

/** Image responses smaller than this are tracking pixels, spacers and icons: not counted. */
export const MIN_COUNT_BYTES = 2048;
export const MAX_ITEMS = 1500;
const MAX_PER_PAGE = 3000;
const KINDS = new Set(['img', 'picture', 'bg', 'video', 'source', 'poster', 'link']);
export const REASONS = new Set(['mse', 'drm', 'hls', 'dash', 'live']);
const OK_STATUS = new Set([200, 203, 206, 304]);
// <img>/CSS images, <video>/<audio>, and an image or video opened as the page (or a frame) itself
export const COUNTED_RESOURCES = new Set(['image', 'media', 'mainFrame', 'subFrame']);
const NEGOTIATED = new Set(['webp', 'avif']);
const CLASSIC = new Set(['jpeg', 'png', 'gif']);

/**
 * WebP/AVIF for a .jpg/.png/.gif address: a CDN picked the format from the page's Accept header. The
 * saver asks for the classic format (and bypasses the cache), so the address type is what gets saved.
 */
export function negotiated(type, url) {
  return NEGOTIATED.has(type) && CLASSIC.has(typeFromUrl(url));
}

/** URL without its #fragment (same resource). */
export function noHash(url) {
  const s = String(url || '');
  if (/^data:/i.test(s)) return s;
  const i = s.indexOf('#');
  return i < 0 ? s : s.slice(0, i);
}

function header(headers, name) {
  if (!headers) return '';
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() !== name) continue;
    const v = headers[k];
    return Array.isArray(v) ? String(v[0] ?? '') : String(v ?? '');
  }
  return '';
}

/** Total size of a response: Content-Range's total for 206, else Content-Length; null when unknown. */
export function responseSize(statusCode, headers) {
  if (statusCode === 206) {
    const m = /\/\s*(\d+)\s*$/.exec(header(headers, 'content-range'));
    return m ? Number(m[1]) : null;
  }
  const v = header(headers, 'content-length');
  return /^\d+$/.test(v.trim()) ? Number(v) : null;
}

/**
 * Counts the images and videos each tab (webContents) loaded since its last main-frame navigation,
 * from webRequest completions. A navigation that never commits (a download) keeps the previous page,
 * so the badge of the page still shown is not lost.
 */
export class MediaCounter {
  constructor({ minBytes = MIN_COUNT_BYTES, maxPerPage = MAX_PER_PAGE } = {}) {
    this.minBytes = minBytes;
    this.maxPerPage = maxPerPage;
    this.tabs = new Map(); // webContents id → {cur, prev}
  }

  /** A main-frame request in tab `wcId`: a new page starts. */
  reset(wcId, url) {
    const t = this.tabs.get(wcId);
    this.tabs.set(wcId, { cur: { url: noHash(url), entries: new Map(), counted: 0 }, prev: t ? t.cur : null });
  }

  /**
   * A completed request of tab `wcId` ({url, resourceType, statusCode, responseHeaders}).
   * Returns true when the tab's count changed.
   */
  note(wcId, d) {
    if (!d || !COUNTED_RESOURCES.has(d.resourceType)) return false;
    if (!OK_STATUS.has(d.statusCode) || !/^https?:/i.test(d.url || '')) return false;
    const ct = header(d.responseHeaders, 'content-type');
    let type = typeFromMime(ct);
    if (!type && (!ct || /^(application|binary)\/octet-stream/i.test(ct))) type = typeFromUrl(d.url);
    if (!type || type === 'ico') return false;
    let t = this.tabs.get(wcId);
    if (!t) {
      this.reset(wcId, '');
      t = this.tabs.get(wcId);
    }
    const page = t.cur;
    const key = noHash(d.url);
    const bytes = responseSize(d.statusCode, d.responseHeaders);
    const known = page.entries.get(key);
    if (known) {
      if (bytes && (!known.bytes || bytes > known.bytes)) known.bytes = bytes;
      return false;
    }
    if (page.entries.size >= this.maxPerPage) return false;
    const countable = TYPES[type].kind === 'video' || bytes === null || bytes >= this.minBytes;
    page.entries.set(key, { url: key, type, bytes, countable });
    if (!countable) return false;
    page.counted++;
    return true;
  }

  /** The page state for what tab `wcId` shows at `url`. */
  page(wcId, url = null) {
    const t = this.tabs.get(wcId);
    if (!t) return null;
    if (url !== null && t.prev && t.cur.url !== noHash(url) && t.prev.url === noHash(url)) return t.prev;
    return t.cur;
  }

  count(wcId, url = null) {
    const p = this.page(wcId, url);
    return p ? p.counted : 0;
  }

  /** What the network saw for the page: [{url, type, bytes, countable}]. */
  entries(wcId, url = null) {
    const p = this.page(wcId, url);
    return p ? [...p.entries.values()] : [];
  }

  drop(wcId) {
    this.tabs.delete(wcId);
  }
}

// ------------------------------------------------------------------------------ frame reports
const num = (v) => (Number.isFinite(v) && v > 0 ? Math.min(Math.round(v), 1e6) : 0);

/** A URL a page may hand us: http(s), data: images/videos (size-capped) or blob:. Else ''. */
export function cleanUrl(u, { dataMax = 6e6 } = {}) {
  if (typeof u !== 'string' || !u) return '';
  if (/^https?:\/\//i.test(u)) return u.length <= 8192 ? noHash(u) : '';
  if (/^data:(image|video)\/[a-z0-9.+-]+[;,]/i.test(u)) return u.length <= dataMax ? u : '';
  if (/^blob:https?:\/\/[^\s/]+\/[\w-]{8,64}$/i.test(u)) return u;
  return '';
}

/** Validates one item a frame reported (page-controlled data: everything is checked). */
export function cleanItem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  // URL-less streams (a camera or call shown with srcObject) are listed under a placeholder key
  const stream = REASONS.has(raw.reason) && typeof raw.url === 'string' && /^stream:[a-z0-9]{1,24}$/i.test(raw.url);
  const url = stream ? raw.url : cleanUrl(raw.url);
  if (!url) return null;
  const kind = KINDS.has(raw.kind) ? raw.kind : 'img';
  const item = {
    url,
    kinds: [kind],
    type: typeof raw.type === 'string' && Object.hasOwn(TYPES, raw.type) ? raw.type : '',
    w: num(raw.w),
    h: num(raw.h),
    dw: num(raw.dw),
    dh: num(raw.dh),
    alt: typeof raw.alt === 'string' ? raw.alt.replace(/\s+/g, ' ').trim().slice(0, 200) : '',
    thumb: cleanUrl(raw.thumb) || '',
    aka: Array.isArray(raw.aka) ? raw.aka.slice(0, 32).map((a) => cleanUrl(a, { dataMax: 0 })).filter(Boolean) : [],
    reason: REASONS.has(raw.reason) ? raw.reason : '',
    bytes: num(raw.bytes),
  };
  if (!item.type) item.type = typeFromUrl(url);
  if (!item.reason && /^https?:/i.test(url)) {
    const s = streamKind(url);
    if (s) item.reason = s;
  }
  return item;
}

function mergeInto(a, b) {
  for (const k of b.kinds) if (!a.kinds.includes(k)) a.kinds.push(k);
  if (b.w * b.h > a.w * a.h) {
    a.w = b.w;
    a.h = b.h;
  }
  if (b.dw * b.dh > a.dw * a.dh) {
    a.dw = b.dw;
    a.dh = b.dh;
  }
  a.alt = a.alt || b.alt;
  a.type = a.type || b.type;
  a.thumb = a.thumb || b.thumb;
  a.bytes = a.bytes || b.bytes;
  if (a.reason && !b.reason) a.reason = '';
  for (const x of b.aka) if (a.aka.length < 48 && !a.aka.includes(x)) a.aka.push(x);
}

/**
 * One list from the frames' reports ([{frame, items}], main frame first) and what the network saw
 * for the page ([{url, type, bytes, countable}]): de-duplicated by URL, every srcset alternative of
 * an image known so the network copy of the displayed size is not listed twice, network-only
 * images (CSS pseudo-elements, script-loaded) appended. Items get ids m0, m1….
 */
export function mergeReports(reports, network = [], { max = MAX_ITEMS } = {}) {
  const byUrl = new Map();
  const order = [];
  for (const r of reports || []) {
    for (const raw of (r && Array.isArray(r.items) ? r.items : []).slice(0, 5000)) {
      const it = cleanItem(raw);
      if (!it) continue;
      const known = byUrl.get(it.url);
      if (known) {
        mergeInto(known, it);
        continue;
      }
      if (order.length >= max) continue;
      it.frame = /^blob:/i.test(it.url) || /^blob:/i.test(it.thumb) ? r.frame || null : null;
      byUrl.set(it.url, it);
      order.push(it);
    }
  }
  const aka = new Set();
  for (const it of order) {
    aka.add(it.url);
    if (it.thumb) aka.add(noHash(it.thumb));
    for (const a of it.aka) aka.add(a);
  }
  const net = new Map((network || []).map((n) => [noHash(n.url), n]));
  for (const it of order) {
    const same = net.get(it.url);
    const shown = it.thumb ? net.get(noHash(it.thumb)) : null;
    if (same) {
      // What the server sent the page wins over the extension, except WebP/AVIF for a .jpg/.png/.gif
      // address: format negotiation, and the saver asks for the classic format (see media.js).
      const neg = negotiated(same.type, it.url);
      if (same.type && !neg) it.type = same.type;
      if (!neg && !it.bytes && same.bytes) it.bytes = same.bytes; // a negotiated copy's size is not the file's
    } else if (!it.type && shown && shown.type) it.type = shown.type;
  }
  for (const n of network || []) {
    if (order.length >= max) break;
    const key = noHash(n.url);
    if (!n.countable || aka.has(key) || byUrl.has(key)) continue;
    const it = { url: key, kinds: ['net'], type: n.type || typeFromUrl(key), w: 0, h: 0, dw: 0, dh: 0, alt: '', thumb: '', aka: [], reason: '', bytes: n.bytes || 0, frame: null };
    byUrl.set(key, it);
    order.push(it);
  }
  order.forEach((it, i) => {
    it.id = `m${i}`;
  });
  return order;
}

/** Whether an item is tiny (< `min` px on its longest side) when its size is known. */
export function isSmall(it, min = 48) {
  const w = it.w || it.dw;
  const h = it.h || it.dh;
  if (!w && !h) return false;
  return Math.max(w, h) < min;
}
