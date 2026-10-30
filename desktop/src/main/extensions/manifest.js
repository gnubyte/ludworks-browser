// Extension manifests: what an extension asks for, in words people understand, and what Ludworks
// Browser cannot give it. Also match patterns, __MSG_…__ localisation and icon picking. Pure functions
// (no Electron), so they are unit-tested directly.

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const MATCH_SCHEMES = ['http', 'https', 'file', 'ftp', 'ws', 'wss', 'urn'];

// ---------------------------------------------------------------------------------- match patterns
/**
 * Parses a Chrome match pattern ("<all_urls>", "*://*.example.com/*", "https://a.b/path*").
 * @returns {{all: boolean, schemes: string[], host: string, sub: boolean, path: RegExp, raw: string}|null}
 */
export function parsePattern(p) {
  if (typeof p !== 'string') return null;
  if (p === '<all_urls>') return { all: true, schemes: ['http', 'https', 'file', 'ftp', 'ws', 'wss'], host: '*', sub: true, path: /^.*$/s, raw: p };
  const m = /^(\*|[a-z][a-z0-9+.-]*):\/\/([^/]*)(\/.*)$/i.exec(p);
  if (!m) {
    if (/^file:\/\/\//i.test(p)) return { all: false, schemes: ['file'], host: '', sub: false, path: globToRe(p.slice(7)), raw: p };
    return null;
  }
  const scheme = m[1].toLowerCase();
  if (scheme !== '*' && !MATCH_SCHEMES.includes(scheme)) return null;
  let host = m[2].toLowerCase();
  let sub = false;
  if (host === '*') sub = true;
  else if (host.startsWith('*.')) {
    sub = true;
    host = host.slice(2);
  } else if (host.includes('*')) return null;
  host = host.replace(/:\d+$|:\*$/, '');
  if (scheme !== 'file' && !host) return null;
  return { all: false, schemes: scheme === '*' ? ['http', 'https', 'ws', 'wss'] : [scheme], host, sub, path: globToRe(m[3]), raw: p };
}

function globToRe(glob) {
  return new RegExp(`^${glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`, 's');
}

/** Does `url` match the (parsed or raw) pattern? */
export function matchesPattern(pattern, url) {
  const p = typeof pattern === 'string' ? parsePattern(pattern) : pattern;
  if (!p) return false;
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  const scheme = u.protocol.slice(0, -1);
  if (!p.schemes.includes(scheme)) return false;
  if (scheme !== 'file') {
    const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (p.host !== '*' && host !== p.host && !(p.sub && host.endsWith(`.${p.host}`))) return false;
  }
  if (p.all) return true;
  return p.path.test(u.pathname + u.search);
}

export const matchesAny = (patterns, url) => (patterns || []).some((p) => matchesPattern(p, url));

/** Does the pattern cover every site (all hosts on http/https)? */
export function isAllSites(p) {
  const x = typeof p === 'string' ? parsePattern(p) : p;
  return !!x && (x.all || (x.host === '*' && x.schemes.some((s) => s === 'http' || s === 'https')));
}

/** Domain-ish host for a pattern (for "on example.com"). Cookie domains: ".a.b" → "a.b". */
export function cookieDomainUrl(domain, secure = true) {
  const d = String(domain || '').replace(/^\./, '');
  return d ? `${secure ? 'https' : 'http'}://${d}/` : '';
}

// ------------------------------------------------------------------------------------ permissions
const isPatternLike = (s) => typeof s === 'string' && (s === '<all_urls>' || s.includes('://'));

/** API permission names (strings that are not host patterns) from a manifest list. */
export function apiPermissions(list) {
  return (Array.isArray(list) ? list : []).filter((p) => typeof p === 'string' && !isPatternLike(p));
}

/** Host permission patterns: MV3 host_permissions, MV2 patterns inside permissions. */
export function hostPermissions(m) {
  const out = [];
  if (Array.isArray(m.host_permissions)) out.push(...m.host_permissions.filter(isPatternLike));
  if (Array.isArray(m.permissions)) out.push(...m.permissions.filter(isPatternLike));
  return [...new Set(out)];
}

export function optionalPermissions(m) {
  const all = [...(Array.isArray(m.optional_permissions) ? m.optional_permissions : []), ...(Array.isArray(m.optional_host_permissions) ? m.optional_host_permissions : [])];
  return { permissions: apiPermissions(all), origins: [...new Set(all.filter(isPatternLike))] };
}

/** Sites the extension's content scripts run on. */
export function contentScriptMatches(m) {
  const out = [];
  for (const cs of Array.isArray(m.content_scripts) ? m.content_scripts : []) if (cs && Array.isArray(cs.matches)) out.push(...cs.matches.filter((x) => typeof x === 'string'));
  return [...new Set(out)];
}

// Short, plain-language warnings in the spirit of Chrome's install prompt (our own wording).
const WARNINGS = {
  tabs: 'Read your browsing history',
  webNavigation: 'Read your browsing history',
  history: 'Read and change your browsing history',
  bookmarks: 'Read and change your bookmarks',
  cookies: 'Read and change cookies of the sites it can access',
  downloads: 'Manage your downloads',
  'downloads.open': 'Open downloaded files',
  clipboardRead: 'Read data you copy and paste',
  clipboardWrite: 'Change data you copy and paste',
  notifications: 'Show notifications',
  geolocation: 'Detect your physical location',
  nativeMessaging: 'Communicate with programs installed on your computer',
  management: 'Manage your extensions',
  privacy: 'Change your privacy-related settings',
  proxy: 'Read and change all your data on all websites',
  debugger: 'Access the page debugger backend',
  desktopCapture: 'Capture the contents of your screen',
  tabCapture: 'Capture the contents of your tabs',
  pageCapture: 'Read and change all your data on all websites',
  contentSettings: 'Change the settings that control what websites may use (cookies, JavaScript, camera…)',
  declarativeNetRequest: 'Block content on any page',
  topSites: 'Read a list of your most visited websites',
  sessions: 'Read your browsing history on all your signed-in devices',
  'identity.email': 'Know your email address',
  favicon: 'Read the icons of the websites you visit',
  readingList: 'Read and change your reading list',
  tabGroups: 'View and manage your tab groups',
  userScripts: 'Run scripts you add on websites',
  webAuthenticationProxy: 'Read and change your passkey and security-key requests',
  'system.storage': 'Identify and eject storage devices',
  'system.cpu': 'Read information about your computer',
  'system.memory': 'Read information about your computer',
  'system.display': 'Read information about your displays',
  ttsEngine: 'Read all text spoken by synthesized speech',
  input: 'Read everything you type',
  fileSystemProvider: 'Add file systems to your computer',
};

/**
 * Plain-language summary of what a set of permissions allows.
 * @param {{permissions?: string[], origins?: string[], contentScripts?: string[]}} p
 * @returns {{allSites: boolean, sites: string[], items: string[]}}
 */
export function describeAccess({ permissions = [], origins = [], contentScripts = [] }) {
  const patterns = [...new Set([...origins, ...contentScripts])].map(parsePattern).filter(Boolean);
  const allSites = patterns.some(isAllSites);
  let sites = allSites ? [] : [...new Set(patterns.map((p) => (p.schemes.length === 1 && p.schemes[0] === 'file' ? 'local files' : `${p.sub && p.host !== '*' ? '*.' : ''}${p.host}`)).filter(Boolean))].sort();
  // "*.youtube.com" already covers youtube.com and m.youtube.com
  const wild = sites.filter((s) => s.startsWith('*.')).map((s) => s.slice(2));
  sites = sites.filter((s) => s.startsWith('*.') || !wild.some((d) => s === d || s.endsWith(`.${d}`)));
  const items = [];
  if (allSites) items.push('Read and change all your data on all websites');
  else if (sites.length) {
    const list = sites.length <= 4 ? sites.join(', ') : `${sites.slice(0, 3).join(', ')} and ${sites.length - 3} other sites`;
    items.push(`Read and change your data on ${list}`);
  }
  const seen = new Set(items);
  for (const perm of permissions) {
    const w = WARNINGS[perm];
    if (!w || seen.has(w) || (allSites && w === WARNINGS.proxy)) continue;
    if (perm === 'cookies' && !allSites && !sites.length) continue;
    seen.add(w);
    items.push(w);
  }
  return { allSites, sites, items };
}

/** Summary of a whole manifest (required permissions only). */
export function describeManifest(m) {
  return describeAccess({ permissions: apiPermissions(m.permissions), origins: hostPermissions(m), contentScripts: contentScriptMatches(m) });
}

// ------------------------------------------------------------------------- what we cannot provide
/** Permission-gated APIs Ludworks Browser does not provide (left undefined so extensions can detect it). */
export const UNSUPPORTED_PERMISSIONS = {
  declarativeNetRequest: 'Blocking or changing network requests (declarativeNetRequest)',
  declarativeNetRequestWithHostAccess: 'Blocking or changing network requests (declarativeNetRequest)',
  declarativeNetRequestFeedback: 'Blocking or changing network requests (declarativeNetRequest)',
  webRequestBlocking: 'Blocking or changing requests with webRequest',
  webRequestAuthProvider: 'Answering sign-in prompts of websites (webRequest)',
  nativeMessaging: 'Talking to programs installed on your computer (native messaging)',
  identity: 'Signing in with a Google account (identity)',
  'identity.email': 'Signing in with a Google account (identity)',
  sidePanel: 'Side panel',
  userScripts: 'User scripts',
  debugger: 'Debugger access',
  tabCapture: 'Capturing tabs',
  desktopCapture: 'Capturing the screen',
  pageCapture: 'Saving pages (pageCapture)',
  downloads: 'Downloads',
  history: 'Browsing history',
  bookmarks: 'Bookmarks',
  topSites: 'Most visited sites',
  sessions: 'Recently closed tabs and other devices',
  tts: 'Text to speech',
  ttsEngine: 'Text-to-speech engine',
  proxy: 'Proxy settings',
  privacy: 'Privacy settings',
  contentSettings: 'Site settings',
  fontSettings: 'Font settings',
  browsingData: 'Clearing browsing data',
  gcm: 'Push messages (gcm)',
  readingList: 'Reading list',
  tabGroups: 'Tab groups',
  search: 'Search engine API',
  webAuthenticationProxy: 'Passkey proxy',
  declarativeContent: 'Page-dependent toolbar icons (declarativeContent)',
  favicon: 'Website icons',
  'system.display': 'Display information (system.display)',
  'system.storage': 'Storage device information (system.storage)',
  printing: 'Printing',
  printerProvider: 'Printers',
  geolocation: 'Location',
  wallpaper: 'Wallpaper',
  platformKeys: 'Platform keys',
  enterprise: 'Enterprise policies',
  'enterprise.platformKeys': 'Enterprise policies',
  'enterprise.deviceAttributes': 'Enterprise policies',
  loginState: 'Login state',
  documentScan: 'Document scanners',
  vpnProvider: 'VPN',
  certificateProvider: 'Certificates',
  fileSystemProvider: 'File systems',
  accessibilityFeatures: 'Accessibility settings',
  'accessibilityFeatures.read': 'Accessibility settings',
  'accessibilityFeatures.modify': 'Accessibility settings',
};

const UNSUPPORTED_KEYS = {
  chrome_url_overrides: 'Replacing the new tab, history or bookmarks page',
  chrome_settings_overrides: 'Changing the search engine or home page',
  omnibox: 'Address-bar keyword',
  side_panel: 'Side panel',
  tts_engine: 'Text-to-speech engine',
  input_components: 'Input methods',
  file_browser_handlers: 'File handlers',
  file_system_provider_capabilities: 'File systems',
};

/**
 * Permissions removed from the manifest Ludworks loads: their Electron implementation crashes the whole
 * browser (system.storage.getInfo / system.display.getInfo, Electron 44), so no extension gets them.
 */
export const STRIPPED_PERMISSIONS = Object.freeze(['system.storage', 'system.display']);

/** What an extension asks for that will not work here (deduplicated labels). */
export function unsupportedFeatures(m) {
  const out = new Set();
  const perms = [...apiPermissions(m.permissions), ...apiPermissions(m.optional_permissions)];
  for (const p of perms) if (UNSUPPORTED_PERMISSIONS[p]) out.add(UNSUPPORTED_PERMISSIONS[p]);
  for (const k of Object.keys(UNSUPPORTED_KEYS)) if (m[k] !== undefined) out.add(UNSUPPORTED_KEYS[k]);
  if (m.manifest_version === 2) out.add('Manifest V2 (Chrome no longer supports it; parts may not work)');
  if (m.background && m.background.page && m.manifest_version !== 2) out.add('Background pages');
  return [...out];
}

/** Required (not optional) features that will not work: shown as the install warning. */
export function unsupportedRequired(m) {
  const out = new Set();
  for (const p of apiPermissions(m.permissions)) if (UNSUPPORTED_PERMISSIONS[p]) out.add(UNSUPPORTED_PERMISSIONS[p]);
  for (const k of Object.keys(UNSUPPORTED_KEYS)) if (m[k] !== undefined) out.add(UNSUPPORTED_KEYS[k]);
  return [...out];
}

// ---------------------------------------------------------------------------------- localisation
/**
 * Loads the messages of the best locale for `uiLocale` ("en-US" → en_US, en, default_locale).
 * @returns {Record<string, string>} lower-cased message name → text
 */
export function loadMessages(dir, manifest, uiLocale = 'en-US') {
  const def = typeof manifest.default_locale === 'string' ? manifest.default_locale : null;
  if (!def) return {};
  const loc = String(uiLocale || 'en').replace('-', '_');
  const candidates = [...new Set([loc, loc.split('_')[0], def, 'en'])];
  const out = {};
  for (const c of candidates.reverse()) {
    if (!/^[A-Za-z]{2,3}(_[A-Za-z0-9]{2,8})?$/.test(c)) continue;
    const f = path.join(dir, '_locales', c, 'messages.json');
    if (!existsSync(f)) continue;
    try {
      const j = JSON.parse(readFileSync(f, 'utf8').replace(/^﻿/, ''));
      for (const [k, v] of Object.entries(j || {})) if (v && typeof v.message === 'string') out[k.toLowerCase()] = v.message;
    } catch {
      /* broken locale file: skip */
    }
  }
  return out;
}

/** Replaces __MSG_name__ placeholders. */
export function localize(text, messages) {
  if (typeof text !== 'string') return text;
  return text.replace(/__MSG_([A-Za-z0-9_@]+)__/g, (all, name) => {
    const v = messages[name.toLowerCase()];
    return typeof v === 'string' ? v.replace(/\$\$/g, '$') : all.startsWith('__MSG_@@') ? '' : all;
  });
}

// --------------------------------------------------------------------------------------- icons
/**
 * Best icon path for a size from an icons dictionary or a single path.
 * @param {string|Record<string,string>|undefined} icons
 */
export function pickIcon(icons, size = 32) {
  if (!icons) return null;
  if (typeof icons === 'string') return icons;
  const sizes = Object.keys(icons)
    .map(Number)
    .filter((n) => Number.isFinite(n) && typeof icons[n] === 'string')
    .sort((a, b) => a - b);
  if (!sizes.length) return null;
  const s = sizes.find((n) => n >= size) || sizes[sizes.length - 1];
  return icons[s];
}

/** The action (MV3 action / MV2 browser_action / page_action) part of a manifest. */
export function actionOf(m) {
  return (m.manifest_version >= 3 ? m.action : m.browser_action || m.page_action) || null;
}

/** Options page path and whether it opens embedded (options_ui) or in a tab. */
export function optionsPageOf(m) {
  if (m.options_ui && typeof m.options_ui.page === 'string') return m.options_ui.page;
  if (typeof m.options_page === 'string') return m.options_page;
  return null;
}

// ----------------------------------------------------------------------------------- commands
/** Manifest commands with the key for this platform: [{name, description, shortcut, global}]. */
export function manifestCommands(m, platform = process.platform) {
  const plat = platform === 'darwin' ? 'mac' : platform === 'win32' ? 'windows' : platform === 'linux' ? 'linux' : 'default';
  const out = [];
  for (const [name, c] of Object.entries(m.commands && typeof m.commands === 'object' ? m.commands : {})) {
    if (!c || typeof c !== 'object') continue;
    const sk = c.suggested_key;
    const key = typeof sk === 'string' ? sk : sk && typeof sk === 'object' ? sk[plat] || sk.default || '' : '';
    out.push({ name, description: typeof c.description === 'string' ? c.description : '', shortcut: normalizeShortcut(key), global: !!c.global });
  }
  return out;
}

/** "ctrl+shift+y" → "Ctrl+Shift+Y"; '' when it is not a valid extension shortcut. */
export function normalizeShortcut(s) {
  if (typeof s !== 'string' || !s.trim()) return '';
  const parts = s.split('+').map((x) => x.trim()).filter(Boolean);
  if (parts.length < 2 || parts.length > 4) return '';
  const mods = [];
  let key = null;
  for (const p of parts) {
    const l = p.toLowerCase();
    if (['ctrl', 'control', 'command', 'macctrl'].includes(l)) mods.push(l === 'command' ? 'Command' : l === 'macctrl' ? 'MacCtrl' : 'Ctrl');
    else if (l === 'alt') mods.push('Alt');
    else if (l === 'shift') mods.push('Shift');
    else if (key === null) key = p.length === 1 ? p.toUpperCase() : p[0].toUpperCase() + p.slice(1);
    else return '';
  }
  if (!key || !mods.length || (mods.length === 1 && mods[0] === 'Shift')) return '';
  const order = ['Ctrl', 'Command', 'MacCtrl', 'Alt', 'Shift'];
  return [...new Set(mods)].sort((a, b) => order.indexOf(a) - order.indexOf(b)).concat(key).join('+');
}

const KEY_ALIASES = { Comma: ',', Period: '.', Space: ' ', Insert: 'Insert', Delete: 'Delete', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown', Up: 'ArrowUp', Down: 'ArrowDown', Left: 'ArrowLeft', Right: 'ArrowRight', MediaNextTrack: 'MediaTrackNext', MediaPlayPause: 'MediaPlayPause', MediaPrevTrack: 'MediaTrackPrevious', MediaStop: 'MediaStop' };

/** Does an Electron before-input-event `input` match a normalized shortcut? */
export function inputMatchesShortcut(input, shortcut, platform = process.platform) {
  if (!shortcut || !input || input.type !== 'keyDown' || input.isAutoRepeat) return false;
  const parts = shortcut.split('+');
  const key = parts.pop();
  const want = { ctrl: false, meta: false, alt: false, shift: false };
  for (const m of parts) {
    if (m === 'Ctrl') want[platform === 'darwin' ? 'meta' : 'ctrl'] = true;
    else if (m === 'Command') want.meta = true;
    else if (m === 'MacCtrl') want.ctrl = true;
    else if (m === 'Alt') want.alt = true;
    else if (m === 'Shift') want.shift = true;
  }
  if (!!input.control !== want.ctrl || !!input.meta !== want.meta || !!input.alt !== want.alt || !!input.shift !== want.shift) return false;
  const expected = KEY_ALIASES[key] || key;
  if (expected.length === 1) {
    const code = String(input.code || '');
    if (/^[A-Z]$/.test(expected)) return code === `Key${expected}`;
    if (/^[0-9]$/.test(expected)) return code === `Digit${expected}` || code === `Numpad${expected}`;
    return String(input.key || '').toUpperCase() === expected.toUpperCase();
  }
  return String(input.key || '') === expected || String(input.code || '') === expected;
}

// ------------------------------------------------------------------------- query patterns, colors
const COLOR_NAMES = { black: [0, 0, 0], white: [255, 255, 255], red: [255, 0, 0], green: [0, 128, 0], blue: [0, 0, 255], yellow: [255, 255, 0], orange: [255, 165, 0], purple: [128, 0, 128], gray: [128, 128, 128], grey: [128, 128, 128] };

/** Match pattern for tabs.query({url}) — any scheme, like Chrome (it only filters, it grants nothing). */
export function queryPatternMatch(pattern, url) {
  if (pattern === '<all_urls>') return /^(https?|wss?|ftp|file):/.test(url);
  const m = /^(\*|[a-z][a-z0-9+.-]*):\/\/([^/]*)(\/.*)?$/i.exec(String(pattern));
  if (!m) return false;
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  const scheme = u.protocol.slice(0, -1);
  if (m[1] === '*' ? !['http', 'https'].includes(scheme) : scheme !== m[1].toLowerCase()) return false;
  const host = m[2].toLowerCase().replace(/:\d+$/, '');
  const h = u.hostname.toLowerCase();
  if (host !== '*' && !(host.startsWith('*.') ? h === host.slice(2) || h.endsWith(host.slice(1)) : h === host)) return false;
  const re = new RegExp(`^${(m[3] || '/').replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`, 's');
  return re.test(u.pathname + u.search);
}

export const globRe = (s) => new RegExp(`^${String(s).replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`, 'is');

/** CSS color / [r,g,b,a] → [r,g,b,a] (0..255). */
export function parseColor(c) {
  if (Array.isArray(c) && c.length >= 3) return [0, 1, 2, 3].map((i) => Math.max(0, Math.min(255, Math.round(Number(c[i] ?? 255)) || 0)));
  const s = String(c || '').trim().toLowerCase();
  let m = /^#([0-9a-f]{3,4})$/.exec(s);
  if (m) return [...m[1].padEnd(4, 'f')].map((x) => parseInt(x + x, 16));
  m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/.exec(s);
  if (m) return [parseInt(m[1].slice(0, 2), 16), parseInt(m[1].slice(2, 4), 16), parseInt(m[1].slice(4, 6), 16), m[2] ? parseInt(m[2], 16) : 255];
  m = /^rgba?\(([^)]+)\)$/.exec(s);
  if (m) {
    const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    if (p.length >= 3 && p.slice(0, 3).every(Number.isFinite)) return [p[0], p[1], p[2], p.length > 3 ? Math.round((p[3] <= 1 ? p[3] * 255 : p[3]) || 0) : 255].map((x) => Math.max(0, Math.min(255, Math.round(x))));
  }
  if (COLOR_NAMES[s]) return [...COLOR_NAMES[s], 255];
  return null;
}

export const cssColor = (a) => (a ? `rgba(${a[0]}, ${a[1]}, ${a[2]}, ${(a[3] / 255).toFixed(3)})` : null);
