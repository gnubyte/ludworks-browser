// Image/video saver: helpers shared by the main process (src/main/media) and the content preload
// (src/preload/features/media.js bundles this file). No imports and no Node or DOM APIs here.

/** Media types the saver knows: label for the filter chips, canonical extension, MIME, image | video. */
export const TYPES = Object.freeze({
  jpeg: { label: 'JPEG', ext: '.jpg', mime: 'image/jpeg', kind: 'image', exts: ['.jpg', '.jpeg', '.jpe', '.jfif', '.pjpeg', '.pjp'] },
  png: { label: 'PNG', ext: '.png', mime: 'image/png', kind: 'image', exts: ['.png', '.apng'] },
  gif: { label: 'GIF', ext: '.gif', mime: 'image/gif', kind: 'image', exts: ['.gif'] },
  webp: { label: 'WebP', ext: '.webp', mime: 'image/webp', kind: 'image', exts: ['.webp'] },
  avif: { label: 'AVIF', ext: '.avif', mime: 'image/avif', kind: 'image', exts: ['.avif'] },
  jxl: { label: 'JPEG XL', ext: '.jxl', mime: 'image/jxl', kind: 'image', exts: ['.jxl'] },
  svg: { label: 'SVG', ext: '.svg', mime: 'image/svg+xml', kind: 'image', exts: ['.svg'] },
  bmp: { label: 'BMP', ext: '.bmp', mime: 'image/bmp', kind: 'image', exts: ['.bmp', '.dib'] },
  ico: { label: 'ICO', ext: '.ico', mime: 'image/x-icon', kind: 'image', exts: ['.ico', '.cur'] },
  webm: { label: 'WebM', ext: '.webm', mime: 'video/webm', kind: 'video', exts: ['.webm'] },
  mp4: { label: 'MP4', ext: '.mp4', mime: 'video/mp4', kind: 'video', exts: ['.mp4', '.m4v'] },
  ogv: { label: 'Ogg', ext: '.ogv', mime: 'video/ogg', kind: 'video', exts: ['.ogv'] },
  mov: { label: 'MOV', ext: '.mov', mime: 'video/quicktime', kind: 'video', exts: ['.mov'] },
  mkv: { label: 'MKV', ext: '.mkv', mime: 'video/x-matroska', kind: 'video', exts: ['.mkv'] },
});

const MIME_ALIASES = {
  'image/jpg': 'jpeg',
  'image/pjpeg': 'jpeg',
  'image/x-png': 'png',
  'image/apng': 'png',
  'image/x-ms-bmp': 'bmp',
  'image/vnd.microsoft.icon': 'ico',
  'video/x-m4v': 'mp4',
  'application/ogg': 'ogv',
  'video/x-webm': 'webm',
};

/** Streaming manifests: never one file, so never saveable. */
const STREAM_EXTS = { '.m3u8': 'hls', '.m3u': 'hls', '.mpd': 'dash', '.ism': 'dash' };
const STREAM_MIMES = { 'application/vnd.apple.mpegurl': 'hls', 'application/x-mpegurl': 'hls', 'audio/mpegurl': 'hls', 'application/dash+xml': 'dash' };

const BY_MIME = new Map(Object.entries(TYPES).map(([k, t]) => [t.mime, k]));
const BY_EXT = new Map();
for (const [k, t] of Object.entries(TYPES)) for (const e of t.exts) BY_EXT.set(e, k);

/** Type key for a MIME type ("image/jpeg; charset=…" → 'jpeg'), or ''. */
export function typeFromMime(mime) {
  const m = String(mime || '').split(';')[0].trim().toLowerCase();
  return BY_MIME.get(m) || MIME_ALIASES[m] || '';
}

/** Lower-case extension of a file name or URL path ('.jpg'), or ''. */
export function extOf(name) {
  const m = /\.([a-z0-9]{1,8})$/i.exec(String(name || ''));
  return m ? `.${m[1].toLowerCase()}` : '';
}

/** Path of an http(s)/blob URL without query and fragment, or '' when it does not parse. */
function urlPath(url) {
  const m = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*([^?#]*)/i.exec(String(url || ''));
  return m ? m[1] : '';
}

/** Type key guessed from a URL: the MIME of a data: URL, else the path's extension. '' when unknown. */
export function typeFromUrl(url) {
  const u = String(url || '');
  if (/^data:/i.test(u)) return typeFromMime(/^data:([^;,]*)/i.exec(u)[1]);
  return BY_EXT.get(extOf(urlPath(u))) || '';
}

/** 'hls' / 'dash' for streaming manifests (by URL extension or MIME), else ''. */
export function streamKind(url, mime = '') {
  const m = String(mime || '').split(';')[0].trim().toLowerCase();
  if (STREAM_MIMES[m]) return STREAM_MIMES[m];
  return STREAM_EXTS[extOf(urlPath(url))] || '';
}

const isSpace = (c) => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f';

/**
 * Parses a srcset attribute (HTML "parse a srcset attribute", simplified): URLs may contain commas
 * (CDN transforms like w_300,h_200), descriptors are `<n>w`, `<n>x` or `<n>h`.
 * @returns {{url: string, w: number, x: number}[]}
 */
export function parseSrcset(text) {
  const s = String(text || '');
  const out = [];
  let i = 0;
  while (i < s.length && out.length < 64) {
    while (i < s.length && (isSpace(s[i]) || s[i] === ',')) i++;
    if (i >= s.length) break;
    const start = i;
    while (i < s.length && !isSpace(s[i])) i++;
    let url = s.slice(start, i);
    let desc = '';
    if (url.endsWith(',')) {
      url = url.replace(/,+$/, '');
    } else {
      const ds = i;
      let depth = 0;
      while (i < s.length) {
        const c = s[i];
        if (c === '(') depth++;
        else if (c === ')') depth = Math.max(0, depth - 1);
        else if (c === ',' && depth === 0) break;
        i++;
      }
      desc = s.slice(ds, i).trim();
      i++;
    }
    if (!url) continue;
    let w = 0;
    let x = 0;
    let bad = false;
    for (const d of desc.split(/\s+/).filter(Boolean)) {
      const m = /^(\d+(?:\.\d+)?)([wxh])$/i.exec(d);
      if (!m) {
        bad = true;
        break;
      }
      const n = Number(m[1]);
      if (m[2].toLowerCase() === 'w') w = Math.round(n);
      else if (m[2].toLowerCase() === 'x') x = n;
    }
    if (bad) continue;
    out.push({ url, w, x: w ? 0 : x || 1 });
  }
  return out;
}

/**
 * The largest candidate of a parsed srcset: the widest `w` candidate when there are any (they say
 * the real pixel width), else the highest density. Null for an empty list.
 */
export function largestCandidate(cands) {
  let best = null;
  for (const c of cands || []) {
    if (!c || !c.url) continue;
    if (!best) best = c;
    else if (c.w || best.w) {
      if ((c.w || 0) > (best.w || 0)) best = c;
    } else if ((c.x || 1) > (best.x || 1)) best = c;
  }
  return best;
}

/** The url(...) values of a computed CSS image value (background-image, image-set, layered). */
export function cssUrls(value) {
  const out = [];
  const re = /url\(\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|([^)\s]*))\s*\)/gi;
  let m;
  const v = String(value || '');
  while ((m = re.exec(v)) && out.length < 16) {
    const u = (m[1] ?? m[2] ?? m[3] ?? '').replace(/\\(.)/g, '$1');
    if (u) out.push(u);
  }
  return out;
}
