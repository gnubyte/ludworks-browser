// Image/video saver, page side (isolated world of the tab preload, every frame).
//
// Idle until the browser asks, which happens only when the user opens the saver popup:
//   media:collect  → lists the frame's pictures and videos (<img> with the largest srcset / <picture>
//                    candidate, lazy-load attributes, CSS backgrounds of visible elements of a
//                    meaningful size, <video>/<source> + posters, links to image and video files),
//                    also inside open shadow roots and same-origin about:blank/srcdoc frames;
//   media:blob     → reads one blob: URL this frame created (size-capped).
// Streams that cannot be saved as a file (MediaSource, DRM, live camera/call, HLS/DASH manifests) are
// reported with a reason instead of being left out. Nothing runs in the page's own world.

import { parseSrcset, largestCandidate, cssUrls, typeFromUrl, typeFromMime, streamKind } from '../../main/media/pick.js';

const MAX_ITEMS = 3000;
const MAX_ELEMENTS = 80000;
const BG_BUDGET_MS = 300;
const MIN_BG = 48;
const LAZY_SRC = ['data-src', 'data-lazy-src', 'data-original', 'data-lazy', 'data-hi-res-src', 'data-full-src', 'data-large-file', 'data-orig-file', 'data-zoom-src'];
const LAZY_SRCSET = ['data-srcset', 'data-lazy-srcset'];
const MAX_DATA_URL = 6e6;

export function setupMedia() {
  try {
    const { ipcRenderer } = require('electron');
    ipcRenderer.on('media:collect', (_e, req) => {
      const id = req && typeof req.id === 'string' ? req.id.slice(0, 64) : '';
      if (!id) return;
      collect()
        .catch(() => [])
        .then((items) => ipcRenderer.send('media:found', { id, items }));
    });
    ipcRenderer.on('media:blob', (_e, req) => {
      const id = req && typeof req.id === 'string' ? req.id.slice(0, 64) : '';
      if (!id) return;
      readBlob(String(req.url || ''), Number(req.max) || 0).then((r) => ipcRenderer.send('media:blob-data', { id, ...r }));
    });
  } catch {
    /* keep the page working without the image saver */
  }
}

function abs(u, base) {
  if (!u || typeof u !== 'string') return '';
  const s = u.trim();
  if (/^data:/i.test(s)) return s.length <= MAX_DATA_URL && /^data:(image|video)\//i.test(s) ? s : '';
  try {
    const x = new URL(s, base);
    return x.protocol === 'http:' || x.protocol === 'https:' || x.protocol === 'blob:' ? x.href : '';
  } catch {
    return '';
  }
}

function rectOf(el) {
  try {
    const r = el.getBoundingClientRect();
    return { dw: Math.round(r.width), dh: Math.round(r.height) };
  } catch {
    return { dw: 0, dh: 0 };
  }
}

async function readBlob(url, max) {
  if (!/^blob:/i.test(url) || !(max > 0)) return { ok: false, error: 'unreadable' };
  try {
    const r = await fetch(url);
    const blob = await r.blob();
    if (blob.size > max) return { ok: false, error: 'too-large' };
    return { ok: true, type: blob.type || '', bytes: new Uint8Array(await blob.arrayBuffer()) };
  } catch {
    return { ok: false, error: 'unreadable' };
  }
}

/** A blob: URL of a <video>: a real file (readable) or a MediaSource stream (fetch fails). */
async function probeBlob(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 1500);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    const bytes = Number(r.headers.get('content-length')) || 0;
    const type = r.headers.get('content-type') || '';
    try {
      if (r.body) r.body.cancel();
    } catch {
      /* ignore */
    }
    return { ok: true, bytes, type };
  } catch {
    return { ok: false };
  } finally {
    clearTimeout(timer);
  }
}

async function collect() {
  const out = new Map();
  const probes = [];
  const t0 = performance.now();
  let streams = 0;

  const add = (url, props) => {
    if (!url) return;
    const prev = out.get(url);
    if (!prev) {
      if (out.size < MAX_ITEMS) out.set(url, { url, aka: [], ...props });
      return;
    }
    if ((props.w || 0) * (props.h || 0) > (prev.w || 0) * (prev.h || 0)) {
      prev.w = props.w;
      prev.h = props.h;
    }
    if ((props.dw || 0) * (props.dh || 0) > (prev.dw || 0) * (prev.dh || 0)) {
      prev.dw = props.dw;
      prev.dh = props.dh;
    }
    prev.alt = prev.alt || props.alt || '';
    prev.thumb = prev.thumb || props.thumb || '';
    prev.type = prev.type || props.type || '';
    for (const a of props.aka || []) if (prev.aka.length < 32 && !prev.aka.includes(a)) prev.aka.push(a);
  };

  const image = (el, base) => {
    const cur = abs(el.currentSrc, base);
    const loaded = el.complete && el.naturalWidth > 0;
    const lazy = LAZY_SRC.map((a) => abs(el.getAttribute(a), base)).find(Boolean) || '';
    const lazySets = LAZY_SRCSET.filter((a) => el.hasAttribute(a)).map((a) => parseSrcset(el.getAttribute(a)).map((c) => abs(c.url, base)));
    // A spacer or (blurred) stand-in shown until a lazy-loading script swaps in the picture named by
    // data-src / data-srcset; once swapped, the current source is one of those.
    const upgraded = !!cur && (cur === lazy || lazySets.some((l) => l.includes(cur)));
    const placeholder = !cur || (/^data:/i.test(cur) && (!loaded || el.naturalWidth <= 4)) || (!!(lazy || lazySets.length) && !upgraded);
    const sets = [];
    const pic = el.parentElement && el.parentElement.tagName === 'PICTURE' ? el.parentElement : null;
    if (pic) {
      for (const s of pic.children) {
        if (s.tagName !== 'SOURCE') continue;
        sets.push({ cands: parseSrcset(s.getAttribute('srcset') || s.getAttribute('data-srcset')), type: typeFromMime(s.getAttribute('type')) });
      }
    }
    const own = parseSrcset(el.getAttribute('srcset'));
    const rawSrc = el.getAttribute('src') || '';
    if (!own.length && rawSrc && !/^data:/i.test(rawSrc.trim())) own.push({ url: rawSrc, w: 0, x: 1 });
    sets.push({ cands: own, type: '' });
    for (const a of LAZY_SRCSET) if (el.hasAttribute(a)) sets.push({ cands: parseSrcset(el.getAttribute(a)), type: '', lazy: true });
    for (const s of sets) s.cands = s.cands.map((c) => ({ ...c, url: abs(c.url, base) })).filter((c) => c.url && !(placeholder && c.url === cur));
    const src = abs(el.getAttribute('src'), base);
    let active = cur && !placeholder ? sets.find((s) => s.cands.some((c) => c.url === cur)) : null;
    if (!active && placeholder) active = sets.find((s) => s.lazy && s.cands.length) || (lazy ? null : sets.find((s) => s.cands.length)) || null;
    if (pic && active && (active.type === 'avif' || active.type === 'webp')) {
      // <picture> with AVIF/WebP plus a JPEG/PNG fallback: save the fallback every viewer opens
      const classic = sets.find((s) => s.cands.length && (s.type === 'jpeg' || s.type === 'png' || s.type === 'gif')) || sets.find((s) => s.cands.length && !s.type);
      if (classic) active = classic;
    }
    const big = active ? largestCandidate(active.cands) : null;
    const best = big ? big.url : !placeholder ? cur : lazy || (src && !/^data:/i.test(src) && src !== cur ? src : '') || cur;
    if (!best) return;
    const r = rectOf(el);
    let w = 0;
    let h = 0;
    if (loaded && best === cur) {
      w = el.naturalWidth;
      h = el.naturalHeight;
    } else if (big && big.w) {
      w = big.w;
      h = loaded && el.naturalWidth ? Math.round((big.w * el.naturalHeight) / el.naturalWidth) : 0;
    }
    const aka = [];
    for (const s of sets) for (const c of s.cands) if (aka.length < 24) aka.push(c.url);
    for (const u of [cur, src, lazy]) if (u && !/^data:/i.test(u)) aka.push(u);
    add(best, {
      kind: pic ? 'picture' : 'img',
      w,
      h,
      ...r,
      alt: (el.getAttribute('alt') || el.getAttribute('title') || '').slice(0, 200),
      thumb: !placeholder && cur !== best ? cur : '',
      type: active && active.type ? active.type : '',
      aka,
    });
  };

  const video = (el, base) => {
    const r = rectOf(el);
    const poster = abs(el.getAttribute('poster'), base);
    const sources = [];
    for (const s of el.children) {
      if (s.tagName !== 'SOURCE') continue;
      sources.push({ url: abs(s.getAttribute('src'), base), type: s.getAttribute('type') || '', w: Number(s.getAttribute('data-width')) || 0, h: Number(s.getAttribute('data-height')) || 0 });
    }
    const cur = abs(el.currentSrc, base) || abs(el.getAttribute('src'), base) || (sources.find((s) => s.url) || {}).url || '';
    const chosen = sources.find((s) => s.url === cur) || {};
    const props = { kind: 'video', w: el.videoWidth || chosen.w || 0, h: el.videoHeight || chosen.h || 0, ...r, thumb: poster, alt: (el.getAttribute('title') || el.getAttribute('aria-label') || '').slice(0, 200) };
    if (poster) add(poster, { kind: 'poster', ...r, alt: props.alt });
    if (el.srcObject) {
      add(`stream:${Date.now().toString(36)}${streams++}`, { ...props, reason: 'live' });
      return;
    }
    if (!cur) return;
    const typeAttr = (sources.find((s) => s.url === cur) || {}).type || '';
    const type = typeFromUrl(cur) || typeFromMime(typeAttr);
    if (el.mediaKeys) add(cur, { ...props, type, reason: 'drm' });
    else if (streamKind(cur, typeAttr)) add(cur, { ...props, type, reason: streamKind(cur, typeAttr) });
    else if (/^blob:/i.test(cur)) {
      add(cur, { ...props, type });
      probes.push(
        probeBlob(cur).then((p) => {
          const it = out.get(cur);
          if (!it) return;
          if (!p.ok) it.reason = 'mse';
          else {
            it.bytes = p.bytes;
            it.type = it.type || typeFromMime(p.type);
          }
        }),
      );
    } else add(cur, { ...props, type });
    // Other encodings / resolutions offered by <source> (Wikimedia Commons lists several).
    for (const s of sources) {
      if (!s.url || s.url === cur || /^blob:/i.test(s.url) || streamKind(s.url, s.type)) continue;
      add(s.url, { kind: 'source', w: s.w, h: s.h, ...r, thumb: poster, type: typeFromUrl(s.url) || typeFromMime(s.type), alt: props.alt });
    }
  };

  const link = (el, base) => {
    const href = abs(el.getAttribute('href'), base);
    if (!href || !/^https?:/i.test(href)) return;
    const type = typeFromUrl(href);
    if (!type) return;
    // "…/wiki/File:Foo.jpg" (MediaWiki and similar namespaces) is a page about the file, not the file
    const last = decodeURIComponent(new URL(href).pathname.split('/').pop() || '');
    if (last.includes(':')) return;
    add(href, { kind: 'link', w: 0, h: 0, dw: 0, dh: 0, type, alt: (el.getAttribute('title') || el.textContent || '').trim().slice(0, 200) });
  };

  const background = (el, base) => {
    const r = rectOf(el);
    if (r.dw < MIN_BG || r.dh < MIN_BG) return;
    let v = '';
    try {
      v = getComputedStyle(el).backgroundImage;
    } catch {
      return;
    }
    if (!v || v === 'none' || !v.includes('url(')) return;
    for (const u of cssUrls(v)) add(abs(u, base), { kind: 'bg', w: 0, h: 0, ...r, type: '' });
  };

  const roots = [{ root: document, base: document.baseURI }];
  let seen = 0;
  while (roots.length && seen < MAX_ELEMENTS) {
    const { root, base } = roots.shift();
    let all;
    try {
      all = root.querySelectorAll('*');
    } catch {
      continue;
    }
    for (const el of all) {
      if (++seen > MAX_ELEMENTS) break;
      if (el.shadowRoot) roots.push({ root: el.shadowRoot, base });
      try {
        switch (el.tagName) {
          case 'IMG':
            image(el, base);
            break;
          case 'VIDEO':
            video(el, base);
            break;
          case 'A':
            link(el, base);
            break;
          case 'IFRAME':
          case 'FRAME': {
            // about:blank / srcdoc frames have no preload of their own; same-origin, so readable here
            const d = el.contentDocument;
            if (d && !/^https?:/i.test(d.location.href)) roots.push({ root: d, base: d.baseURI });
            break;
          }
          case 'SOURCE':
          case 'SCRIPT':
          case 'STYLE':
          case 'HEAD':
          case 'META':
          case 'LINK':
            break;
          default:
            if (performance.now() - t0 < BG_BUDGET_MS) background(el, base);
        }
      } catch {
        /* one odd element must not stop the scan */
      }
    }
  }
  if (probes.length) await Promise.race([Promise.all(probes), new Promise((r) => setTimeout(r, 1800))]);
  return [...out.values()];
}
