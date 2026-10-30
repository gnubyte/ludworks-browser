// Image/video saver: file-side helpers (no Electron): type sniffing, safe file names, exclusive file
// creation in the chosen folder, Mark-of-the-Web, data: URLs, and the Cookie / Referer a page's own
// request for an image would carry.

import { open, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { TYPES, extOf } from './pick.js';

/** Per-file size caps. */
export const LIMITS = Object.freeze({ image: 100 * 1024 * 1024, video: 500 * 1024 * 1024 });
export const MAX_NAME = 120; // UTF-16 code units, extension included
const MAX_PATH = 250; // stay below Windows' classic MAX_PATH for Explorer and older apps

// ------------------------------------------------------------------------------------ sniffing
const ascii = (b, off, s) => {
  if (b.length < off + s.length) return false;
  for (let i = 0; i < s.length; i++) if (b[off + i] !== s.charCodeAt(i)) return false;
  return true;
};
const fourcc = (b, off) => (b.length >= off + 4 ? String.fromCharCode(b[off], b[off + 1], b[off + 2], b[off + 3]) : '');

const MP4_BRANDS = new Set(['isom', 'iso2', 'iso3', 'iso4', 'iso5', 'iso6', 'iso8', 'iso9', 'mp41', 'mp42', 'mp71', 'avc1', 'av01', 'M4V ', 'M4VH', 'M4VP', 'dash', 'msdh', 'msix', 'f4v ', 'mmp4', 'MSNV', 'NDAS', 'NDSC', 'NDSH', 'NDSM', 'NDSP', 'NDSS', 'NDXC', 'NDXH', 'NDXM', 'NDXP', 'NDXS', '3gp4', '3gp5', '3gp6', '3g2a', 'XAVC', 'cmfc', 'cmf2']);
const AVIF_BRANDS = new Set(['avif', 'avis']);

function sniffFtyp(b) {
  const major = fourcc(b, 8);
  const size = ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0;
  const brands = [major];
  for (let off = 16; off + 4 <= Math.min(b.length, size, 256); off += 4) brands.push(fourcc(b, off));
  if (brands.some((x) => AVIF_BRANDS.has(x))) return 'avif';
  if (major === 'qt  ') return 'mov';
  if (MP4_BRANDS.has(major)) return 'mp4';
  // HEIC/HEIF stills, audio-only M4A, …: not something pages show or the saver handles
  return '';
}

function sniffEbml(b) {
  const head = Buffer.from(b.buffer, b.byteOffset, Math.min(b.length, 4096)).toString('latin1');
  if (head.includes('webm')) return 'webm';
  if (head.includes('matroska')) return 'mkv';
  return '';
}

function looksLikeSvg(b) {
  let s = Buffer.from(b.buffer, b.byteOffset, Math.min(b.length, 8192)).toString('utf8');
  s = s.replace(/^﻿/, '');
  for (let guard = 0; guard < 64; guard++) {
    s = s.replace(/^\s+/, '');
    if (s.startsWith('<?')) {
      const e = s.indexOf('?>');
      if (e < 0) return false;
      s = s.slice(e + 2);
    } else if (s.startsWith('<!--')) {
      const e = s.indexOf('-->');
      if (e < 0) return false;
      s = s.slice(e + 3);
    } else if (/^<!doctype/i.test(s)) {
      const m = /^<!doctype[^[>]*(\[[\s\S]*?\])?\s*>/i.exec(s);
      if (!m) return false;
      s = s.slice(m[0].length);
    } else break;
  }
  return /^<(?:[a-z_][\w.-]*:)?svg[\s>/]/i.test(s);
}

/**
 * Type key of a file from its first bytes (≥ 64 bytes wanted, SVG needs its prolog), or '' when
 * it is not an image or video the saver knows.
 * @param {Uint8Array} b
 */
export function sniffType(b) {
  if (!b || b.length < 4) return '';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (ascii(b, 0, '\x89PNG\r\n\x1a\n')) return 'png';
  if (ascii(b, 0, 'GIF87a') || ascii(b, 0, 'GIF89a')) return 'gif';
  if (ascii(b, 0, 'RIFF') && ascii(b, 8, 'WEBP')) return 'webp';
  if (ascii(b, 4, 'ftyp')) return sniffFtyp(b);
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return sniffEbml(b);
  if (ascii(b, 0, 'OggS')) return 'ogv';
  if (b[0] === 0xff && b[1] === 0x0a) return 'jxl';
  if (ascii(b, 0, '\0\0\0\x0cJXL \r\n\x87\n')) return 'jxl';
  if (ascii(b, 0, 'BM') && b.length >= 18 && b[6] === 0 && b[7] === 0 && b[8] === 0 && b[9] === 0 && [12, 40, 52, 56, 64, 108, 124].includes(b[14] | (b[15] << 8))) return 'bmp';
  if (b[0] === 0 && b[1] === 0 && (b[2] === 1 || b[2] === 2) && b[3] === 0 && b.length >= 6 && (b[4] | (b[5] << 8)) > 0 && b[5] === 0) return 'ico';
  if (looksLikeSvg(b)) return 'svg';
  return '';
}

const u16le = (b, o) => b[o] | (b[o + 1] << 8);
const u16be = (b, o) => (b[o] << 8) | b[o + 1];
const u32be = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const i32le = (b, o) => b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24);

function jpegSize(b) {
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) {
      i++;
      continue;
    }
    const m = b[i + 1];
    if (m === 0xff) {
      i++;
      continue;
    }
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) {
      i += 2;
      continue;
    }
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { w: u16be(b, i + 7), h: u16be(b, i + 5) };
    i += 2 + u16be(b, i + 2);
  }
  return null;
}

function svgSize(b) {
  const s = Buffer.from(b.buffer, b.byteOffset, Math.min(b.length, 16384)).toString('utf8');
  const tag = /<(?:[a-z_][\w.-]*:)?svg\b([^>]*)>/i.exec(s);
  if (!tag) return null;
  const attr = (n) => {
    const m = new RegExp(`\\s${n}\\s*=\\s*["']\\s*([\\d.]+)\\s*(px)?\\s*["']`, 'i').exec(tag[1]);
    return m ? Number(m[1]) : 0;
  };
  let w = attr('width');
  let h = attr('height');
  const vb = /\sviewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)\s*["']/i.exec(tag[1]);
  if (vb && (!w || !h)) {
    const [vw, vh] = [Number(vb[1]), Number(vb[2])];
    if (!w && !h) [w, h] = [vw, vh];
    else if (!w && vh) w = (h * vw) / vh;
    else if (!h && vw) h = (w * vh) / vw;
  }
  return w && h ? { w: Math.round(w), h: Math.round(h) } : null;
}

/** Pixel size of an image from its header bytes (no decoding), or null. */
export function imageSize(b, type) {
  if (!b || b.length < 10) return null;
  let r = null;
  switch (type) {
    case 'png':
      if (b.length >= 24 && ascii(b, 12, 'IHDR')) r = { w: u32be(b, 16), h: u32be(b, 20) };
      break;
    case 'gif':
      r = { w: u16le(b, 6), h: u16le(b, 8) };
      break;
    case 'jpeg':
      r = jpegSize(b);
      break;
    case 'webp': {
      const chunk = fourcc(b, 12);
      if (chunk === 'VP8 ' && b.length >= 30) r = { w: u16le(b, 26) & 0x3fff, h: u16le(b, 28) & 0x3fff };
      else if (chunk === 'VP8L' && b.length >= 25) {
        const bits = (b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24)) >>> 0;
        r = { w: (bits & 0x3fff) + 1, h: ((bits >>> 14) & 0x3fff) + 1 };
      } else if (chunk === 'VP8X' && b.length >= 30) r = { w: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), h: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)) };
      break;
    }
    case 'avif': {
      const i = Buffer.from(b.buffer, b.byteOffset, Math.min(b.length, 65536)).indexOf('ispe');
      if (i > 0 && b.length >= i + 16) r = { w: u32be(b, i + 8), h: u32be(b, i + 12) };
      break;
    }
    case 'bmp':
      if (b.length >= 26) r = u16le(b, 14) === 12 ? { w: u16le(b, 18), h: u16le(b, 20) } : { w: Math.abs(i32le(b, 18)), h: Math.abs(i32le(b, 22)) };
      break;
    case 'ico':
      r = { w: b[6] || 256, h: b[7] || 256 };
      break;
    case 'svg':
      r = svgSize(b);
      break;
    default:
      r = null;
  }
  return r && r.w > 0 && r.h > 0 && r.w <= 1e6 && r.h <= 1e6 ? r : null;
}

// ---------------------------------------------------------------------------------- file names
const RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$|clock\$)$/i;
// Script/page extensions servers put on image URLs (image.php?id=3): replaced by the real one.
const PAGE_EXTS = new Set(['.php', '.asp', '.aspx', '.ashx', '.axd', '.jsp', '.jspx', '.cgi', '.pl', '.py', '.do', '.action', '.htm', '.html', '.xhtml', '.json', '.xml', '.bin', '.dat', '.tmp', '.img', '.image', '.file', '.raw']);
const KNOWN_EXTS = new Set(Object.values(TYPES).flatMap((t) => t.exts));

/** Cuts a string to at most `max` UTF-16 code units without splitting a surrogate pair. */
function cut(s, max) {
  if (s.length <= max) return s;
  let out = s.slice(0, Math.max(0, max));
  if (/[\ud800-\udbff]$/.test(out)) out = out.slice(0, -1);
  return out;
}

/**
 * A file name that is safe on Windows, macOS and Linux: no path separators or characters Windows
 * rejects, no control / bidi / zero-width characters, no leading dots, no trailing dots or spaces,
 * not a Windows device name (also with an extension: "CON.jpg"), at most `max` code units with the
 * extension kept. Unicode letters stay (NFC).
 */
export function sanitizeFilename(name, { max = MAX_NAME, fallback = 'image' } = {}) {
  let n = String(name ?? '').normalize('NFC');
  n = n.replace(/[\u0000-\u001f\u007f-\u009f]/g, '');
  n = n.replace(/[­؜᠎​-‏‪-‮⁠-⁯﻿￹-￻]/g, '');
  n = n.replace(/[<>:"/\\|?*]/g, '_');
  n = n.replace(/\s+/g, ' ');
  n = n.replace(/^[\s.]+/, '').replace(/[\s.]+$/, '');
  if (!n) n = fallback;
  if (n.length > max) {
    const ext = extOf(n);
    const stem = cut(n.slice(0, n.length - ext.length), max - ext.length).replace(/[\s.]+$/, '');
    n = (stem || fallback) + ext;
  }
  if (RESERVED.test(n.split('.')[0].trim())) n = cut(`_${n}`, max);
  return n;
}

/** `name` with its extension made right for a sniffed type: kept, replaced or added. */
export function nameForType(name, type, fallback = 'image') {
  const t = TYPES[type];
  let n = sanitizeFilename(name, { fallback });
  if (!t) return n;
  const ext = extOf(n);
  if (ext && t.exts.includes(ext)) return n;
  if (ext && (KNOWN_EXTS.has(ext) || PAGE_EXTS.has(ext))) n = n.slice(0, n.length - ext.length).replace(/[\s.]+$/, '') || fallback;
  return sanitizeFilename(`${cut(n, MAX_NAME - t.ext.length)}${t.ext}`, { fallback });
}

/** "name.jpg" → "name (2).jpg" for i ≥ 2. */
export function withIndex(name, i) {
  if (!(i >= 2)) return name;
  const ext = extOf(name);
  return `${name.slice(0, name.length - ext.length)} (${i})${ext}`;
}

/** The filename a Content-Disposition header suggests (filename* preferred), or ''. */
export function dispositionFilename(header) {
  const h = String(header || '');
  const star = /(?:^|;)\s*filename\*\s*=\s*"?([^";]+)"?/i.exec(h);
  if (star) {
    const m = /^([\w!#$%&+^`{}~-]*)'[^']*'(.*)$/.exec(star[1].trim());
    if (m) {
      const charset = m[1].toLowerCase();
      try {
        if (charset === 'utf-8' || charset === 'utf8' || !charset) return decodeURIComponent(m[2]);
        if (charset === 'iso-8859-1' || charset === 'latin1') return m[2].replace(/%([0-9a-f]{2})/gi, (_x, hx) => String.fromCharCode(parseInt(hx, 16)));
      } catch {
        /* malformed: fall back to filename= */
      }
    }
  }
  const plain = /(?:^|;)\s*filename\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;]*))/i.exec(h);
  if (plain) return (plain[1] !== undefined ? plain[1].replace(/\\(.)/g, '$1') : plain[2]).trim();
  return '';
}

/** The last path segment of an http(s) URL, percent-decoded ('' for data:, blob: and bare hosts). */
export function urlFilename(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return '';
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
  const segs = u.pathname.split('/').filter(Boolean);
  const last = segs.length ? segs[segs.length - 1] : '';
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

/**
 * The name to save a file as: Content-Disposition, else the URL's last path segment, else a generic
 * stem; then sanitised, with the extension of the sniffed type.
 */
export function fileNameFor({ url, disposition = '', type, fallback = '' }) {
  const kind = TYPES[type] ? TYPES[type].kind : 'image';
  const stem = fallback || kind;
  const raw = dispositionFilename(disposition) || urlFilename(url) || stem;
  return nameForType(raw.split(/[\\/]/).pop(), type, stem);
}

/**
 * Creates `name` in `dir` without ever overwriting: "name (2).ext", "name (3).ext"… on collision.
 * The file is opened exclusively (O_EXCL), so concurrent saves of the same name cannot clash.
 * @returns {Promise<{fh: import('node:fs/promises').FileHandle, file: string, name: string}>}
 */
export async function createExclusive(dir, name, { maxTries = 999 } = {}) {
  const root = path.resolve(dir);
  if (typeof name !== 'string' || !name || /[\\/:\0]/.test(name) || name === '.' || name === '..') throw new Error('unsafe file name');
  let base = name;
  const room = MAX_PATH - root.length - 1 - 6; // " (999)"
  if (base.length > room) {
    const ext = extOf(base);
    base = `${cut(base.slice(0, base.length - ext.length), Math.max(8, room - ext.length)).replace(/[\s.]+$/, '') || 'file'}${ext}`;
  }
  for (let i = 1; i <= maxTries; i++) {
    const candidate = withIndex(base, i);
    const file = path.join(root, candidate);
    if (path.dirname(file) !== root || path.basename(file) !== candidate) throw new Error('unsafe file name');
    try {
      const fh = await open(file, 'wx');
      return { fh, file, name: candidate };
    } catch (e) {
      if (e && (e.code === 'EEXIST' || e.code === 'EISDIR' || e.code === 'EPERM')) continue;
      throw e;
    }
  }
  throw new Error('too many files with this name');
}

export async function removeQuietly(file) {
  try {
    await unlink(file);
  } catch {
    /* already gone */
  }
}

// ------------------------------------------------------------------------------ Mark of the Web
function motwUrl(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    u.username = '';
    u.password = '';
    u.hash = '';
    return u.href.length <= 2048 ? u.href : '';
  } catch {
    return '';
  }
}

/**
 * Zone.Identifier contents for a file saved from the internet (zone 3), like Chromium writes for
 * downloads. Private windows and data:/blob: sources carry no addresses (HostUrl=about:internet).
 */
export function zoneIdentifier({ hostUrl = '', referrerUrl = '', isPrivate = false } = {}) {
  const host = isPrivate ? '' : motwUrl(hostUrl);
  const ref = isPrivate ? '' : motwUrl(referrerUrl);
  const lines = ['[ZoneTransfer]', 'ZoneId=3'];
  if (ref && host) lines.push(`ReferrerUrl=${ref}`);
  lines.push(`HostUrl=${host || 'about:internet'}`);
  return `${lines.join('\r\n')}\r\n`;
}

/** Windows: marks a saved file as downloaded from the internet (best effort; FAT drives have no streams). */
export async function markOfTheWeb(file, info) {
  if (process.platform !== 'win32') return false;
  try {
    await writeFile(`${file}:Zone.Identifier`, zoneIdentifier(info));
    return true;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------------------------ data: URLs
const isHex = (c) => (c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102);

/** Percent-decodes to bytes; literal non-ASCII characters count as their UTF-8 bytes. */
function percentBytes(s) {
  let a;
  try {
    a = s.replace(/[^\x00-\x7f]+/g, (m) => encodeURIComponent(m));
  } catch {
    a = s.replace(/[^\x00-\x7f]/g, '?'); // lone surrogates
  }
  const out = Buffer.alloc(a.length);
  let n = 0;
  for (let i = 0; i < a.length; i++) {
    const c = a.charCodeAt(i);
    if (c === 37 && i + 2 < a.length && isHex(a.charCodeAt(i + 1)) && isHex(a.charCodeAt(i + 2))) {
      out[n++] = parseInt(a.slice(i + 1, i + 3), 16);
      i += 2;
    } else out[n++] = c;
  }
  return Buffer.from(out.subarray(0, n));
}

/** Decodes a data: URL → {mime, bytes}; null when malformed, {error: 'too-large'} above `max` bytes. */
export function decodeDataUrl(url, max = LIMITS.image) {
  const s = String(url || '');
  const comma = s.indexOf(',');
  if (!/^data:/i.test(s) || comma < 0) return null;
  const meta = s.slice(5, comma);
  const body = s.slice(comma + 1);
  const mime = meta.split(';')[0].trim().toLowerCase();
  const b64 = /;\s*base64\s*$/i.test(meta);
  if ((b64 ? (body.length * 3) / 4 : body.length) > max + 16) return { error: 'too-large' };
  const bytes = b64 ? Buffer.from(body.includes('%') ? percentBytes(body).toString('latin1') : body, 'base64') : percentBytes(body);
  if (bytes.length > max) return { error: 'too-large' };
  return { mime, bytes };
}

// ------------------------------------------------------------------- what a page request carries
/** strict-origin-when-cross-origin: the Referer a page sends for a subresource at `url`. */
export function referrerFor(pageUrl, url) {
  let p;
  let u;
  try {
    p = new URL(pageUrl);
    u = new URL(url);
  } catch {
    return '';
  }
  if (p.protocol !== 'http:' && p.protocol !== 'https:') return '';
  if (p.protocol === 'https:' && u.protocol !== 'https:') return '';
  if (p.origin === u.origin) {
    p.hash = '';
    p.username = '';
    p.password = '';
    return p.href;
  }
  return `${p.origin}/`;
}

function domainMatch(host, cookieDomain, hostOnly) {
  const d = String(cookieDomain || '').replace(/^\./, '').toLowerCase();
  const hh = String(host || '').toLowerCase();
  if (!d) return false;
  if (hostOnly) return hh === d;
  return hh === d || hh.endsWith(`.${d}`);
}

function pathMatch(reqPath, cookiePath) {
  const cp = cookiePath || '/';
  if (reqPath === cp) return true;
  if (!reqPath.startsWith(cp)) return false;
  return cp.endsWith('/') || reqPath[cp.length] === '/';
}

/**
 * The Cookie header a page on `pageSite` would send with its own request for `url` (an <img>): RFC 6265
 * domain/path/secure matching; for a cross-site request only SameSite=None cookies, and none at all
 * when third-party cookies are blocked. `cookies`: Electron cookie objects (session.cookies.get).
 */
export function cookieHeaderFor(cookies, url, { pageSite, urlSite, blockThirdParty = false, now = Date.now() } = {}) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return '';
  }
  const sameSite = !!pageSite && pageSite === urlSite;
  if (!sameSite && blockThirdParty) return '';
  const list = (cookies || []).filter((c) => {
    if (!c || typeof c.name !== 'string' || typeof c.value !== 'string') return false;
    if (!domainMatch(u.hostname, c.domain, c.hostOnly)) return false;
    if (!pathMatch(u.pathname || '/', c.path)) return false;
    if (c.secure && u.protocol !== 'https:' && u.hostname !== 'localhost') return false;
    if (typeof c.expirationDate === 'number' && c.expirationDate * 1000 < now) return false;
    if (!sameSite && c.sameSite !== 'no_restriction') return false;
    return true;
  });
  list.sort((a, b) => (b.path || '/').length - (a.path || '/').length);
  return list.map((c) => (c.name ? `${c.name}=${c.value}` : c.value)).join('; ');
}
