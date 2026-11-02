// Chrome themes (manifest "theme" key): colours, tints, images and new-tab-page properties turned into what
// the browser UI draws with. No Electron here (unit-tested).
//
// The format (developer.chrome.com/docs/extensions/mv3/themes, Chromium's browser_theme_pack.cc):
//   colors    name → [r, g, b] or [r, g, b, alpha 0..1]    frame, toolbar, tab_text, tab_background_text,
//             bookmark_text, ntp_background, ntp_text, ntp_link, omnibox_background, omnibox_text,
//             toolbar_button_icon, frame_inactive, …
//   tints     name → [h, s, l], each 0..1 or -1 for "keep"   buttons, frame, frame_inactive, background_tab
//   images    name → path in the package                     theme_frame, theme_toolbar, theme_tab_background,
//             theme_ntp_background, theme_ntp_attribution, theme_frame_overlay, …
//   properties  ntp_background_alignment ("center", "top", "bottom left", …), ntp_background_repeat
//             ("no-repeat", "repeat", "repeat-x", "repeat-y"), ntp_logo_alternate (0/1)

const DEFAULT = {
  light: { frame: [222, 225, 230], toolbar: [255, 255, 255], text: [31, 31, 31], muted: [95, 99, 104], icon: [95, 99, 104] },
  dark: { frame: [32, 33, 36], toolbar: [53, 54, 58], text: [232, 234, 237], muted: [154, 160, 166], icon: [154, 160, 166] },
};
export const IMAGE_KEYS = Object.freeze({
  frame: 'theme_frame',
  frameInactive: 'theme_frame_inactive',
  frameOverlay: 'theme_frame_overlay',
  toolbar: 'theme_toolbar',
  tabBackground: 'theme_tab_background',
  ntpBackground: 'theme_ntp_background',
  ntpAttribution: 'theme_ntp_attribution',
});
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp)$/i;
const ALIGN = new Set(['center', 'top', 'bottom', 'left', 'right']);
const REPEAT = new Set(['no-repeat', 'repeat', 'repeat-x', 'repeat-y']);

export function isThemeManifest(m) {
  return !!(m && m.theme && typeof m.theme === 'object' && !m.background && !m.content_scripts && !m.action && !m.browser_action);
}

/** [r, g, b(, a)] with numbers in range → {r, g, b, a}; anything else → null. */
export function parseColor(v) {
  if (!Array.isArray(v) || v.length < 3 || v.length > 4) return null;
  const [r, g, b] = v.slice(0, 3).map(Number);
  if (![r, g, b].every((x) => Number.isFinite(x) && x >= 0 && x <= 255)) return null;
  let a = v.length === 4 ? Number(v[3]) : 1;
  if (!Number.isFinite(a)) a = 1;
  // a few themes give alpha as 0..255
  if (a > 1) a = Math.min(255, a) / 255;
  return { r: Math.round(r), g: Math.round(g), b: Math.round(b), a: Math.max(0, Math.min(1, a)) };
}

const rgb = (c) => (c.a >= 1 ? `rgb(${c.r}, ${c.g}, ${c.b})` : `rgba(${c.r}, ${c.g}, ${c.b}, ${Math.round(c.a * 1000) / 1000})`);
const fromArr = ([r, g, b]) => ({ r, g, b, a: 1 });

/** Relative luminance (WCAG), 0 black … 1 white. */
export function luminance(c) {
  const f = (x) => {
    const s = x / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
}

function toHsl({ r, g, b }) {
  const R = r / 255;
  const G = g / 255;
  const B = b / 255;
  const max = Math.max(R, G, B);
  const min = Math.min(R, G, B);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === R) h = (G - B) / d + (G < B ? 6 : 0);
  else if (max === G) h = (B - R) / d + 2;
  else h = (R - G) / d + 4;
  return { h: h / 6, s, l };
}

function fromHsl({ h, s, l }, a = 1) {
  if (s === 0) {
    const v = Math.round(l * 255);
    return { r: v, g: v, b: v, a };
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const ch = (t) => {
    let x = t;
    if (x < 0) x += 1;
    if (x > 1) x -= 1;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  };
  return { r: Math.round(ch(h + 1 / 3) * 255), g: Math.round(ch(h) * 255), b: Math.round(ch(h - 1 / 3) * 255), a };
}

/** A tint [h, s, l] (-1 = keep) or null. */
export function parseTint(v) {
  if (!Array.isArray(v) || v.length !== 3) return null;
  const t = v.map(Number);
  if (!t.every((x) => Number.isFinite(x) && (x === -1 || (x >= 0 && x <= 1)))) return null;
  return t;
}

/**
 * Chromium's HSL shift (color_utils::HSLShift): hue replaced unless -1; saturation and lightness 0..0.5
 * scale towards grey / black, 0.5..1 towards full / white, 0.5 and -1 keep.
 */
export function applyTint(c, tint) {
  if (!tint) return c;
  const [th, ts, tl] = tint;
  const hsl = toHsl(c);
  if (th >= 0) hsl.h = th;
  if (ts >= 0 && ts !== 0.5) hsl.s = ts < 0.5 ? hsl.s * ts * 2 : hsl.s + (1 - hsl.s) * (ts - 0.5) * 2;
  let out = fromHsl(hsl, c.a);
  if (tl >= 0 && tl !== 0.5) {
    const mix = (x) => Math.round(tl < 0.5 ? x * tl * 2 : x + (255 - x) * (tl - 0.5) * 2);
    out = { r: mix(out.r), g: mix(out.g), b: mix(out.b), a: out.a };
  }
  return out;
}

const mixColor = (a, b, t) => ({ r: Math.round(a.r + (b.r - a.r) * t), g: Math.round(a.g + (b.g - a.g) * t), b: Math.round(a.b + (b.b - a.b) * t), a: 1 });

/** A package path for an image: relative, no "..", an image file. */
export function safeImagePath(p) {
  if (typeof p !== 'string' || !p || p.length > 300) return null;
  const n = p.replace(/\\/g, '/').replace(/^\.\//, '');
  if (n.startsWith('/') || /^[a-z]+:/i.test(n) || n.split('/').some((s) => s === '..' || s === '') || !IMAGE_EXT.test(n)) return null;
  return n;
}

function cssPosition(v) {
  const words = String(v || 'center').toLowerCase().trim().split(/\s+/).filter((w) => ALIGN.has(w));
  return words.length ? words.join(' ') : 'center';
}

/**
 * What the browser draws from a theme manifest.
 * @returns {{name: string, base: 'light'|'dark', vars: Record<string, string>, images: Record<string, string>,
 *   ntp: {position: string, repeat: string, attributionPosition: string, logoAlternate: boolean}}}
 */
export function themePalette(manifest) {
  const t = (manifest && manifest.theme) || {};
  const colors = t.colors && typeof t.colors === 'object' ? t.colors : {};
  const tints = t.tints && typeof t.tints === 'object' ? t.tints : {};
  const props = t.properties && typeof t.properties === 'object' ? t.properties : {};
  const col = (k) => parseColor(colors[k]);
  const tint = (k) => parseTint(tints[k]);
  const images = {};
  for (const [key, name] of Object.entries(IMAGE_KEYS)) {
    const p = safeImagePath(t.images && t.images[name]);
    if (p) images[key] = p;
  }
  // light or dark base: from the toolbar (what most of the UI sits on), else the frame
  const guess = col('toolbar') || col('frame') || (tint('frame') ? applyTint(fromArr(DEFAULT.light.frame), tint('frame')) : null);
  const base = guess && luminance(guess) < 0.3 ? 'dark' : 'light';
  const d = DEFAULT[base];
  const frame = col('frame') || applyTint(fromArr(d.frame), tint('frame'));
  const frameInactive = col('frame_inactive') || (tint('frame_inactive') ? applyTint(fromArr(d.frame), tint('frame_inactive')) : frame);
  const toolbar = col('toolbar') || fromArr(d.toolbar);
  const text = col('toolbar_text') || col('tab_text') || col('bookmark_text') || fromArr(d.text);
  const tabText = col('tab_text') || text;
  const frameText = col('tab_background_text') || col('background_tab_text') || (luminance(frame) < 0.3 ? fromArr(DEFAULT.dark.text) : fromArr(DEFAULT.light.muted));
  const icon = col('toolbar_button_icon') || (tint('buttons') ? applyTint(fromArr(d.icon), tint('buttons')) : mixColor(text, toolbar, 0.25));
  const omni = col('omnibox_background') || mixColor(toolbar, luminance(toolbar) < 0.3 ? { r: 255, g: 255, b: 255 } : { r: 0, g: 0, b: 0 }, 0.07);
  const omniText = col('omnibox_text') || text;
  const ntpBg = col('ntp_background') || (base === 'dark' ? fromArr([32, 33, 36]) : fromArr([255, 255, 255]));
  const ntpText = col('ntp_text') || (luminance(ntpBg) < 0.3 ? fromArr(DEFAULT.dark.text) : fromArr(DEFAULT.light.text));
  const ntpLink = col('ntp_link') || col('ntp_header') || ntpText;
  const vars = {
    '--frame': rgb(frame),
    '--frame-inactive': rgb(frameInactive),
    '--frame-text': rgb(frameText),
    '--toolbar': rgb(toolbar),
    '--text': rgb(text),
    '--tab-text': rgb(tabText),
    '--bookmark-text': rgb(col('bookmark_text') || text),
    '--icon': rgb(icon),
    '--omni': rgb(omni),
    '--omni-focus': rgb(col('omnibox_background') ? omni : toolbar),
    '--omni-text': rgb(omniText),
    '--ntp-bg': rgb(ntpBg),
    '--ntp-text': rgb(ntpText),
    '--ntp-link': rgb(ntpLink),
  };
  const repeat = REPEAT.has(String(props.ntp_background_repeat || '').toLowerCase()) ? String(props.ntp_background_repeat).toLowerCase() : 'no-repeat';
  return {
    name: String(manifest && manifest.name ? manifest.name : 'Theme').slice(0, 100),
    base,
    vars,
    images,
    ntp: { position: cssPosition(props.ntp_background_alignment), repeat, attributionPosition: 'right bottom', logoAlternate: Number(props.ntp_logo_alternate) === 1 },
    frameColor: rgb({ ...frame, a: 1 }),
    frameTextColor: rgb({ ...frameText, a: 1 }),
  };
}
