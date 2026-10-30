// Omnibox input → URL or search, display helpers, and the schemes the browser will open.

import { PSL_RULES } from '../../lib/psl-data.js';

/** Top-level domains known to the pinned Public Suffix List (ICANN + private rules' last labels). */
const TLDS = new Set(
  PSL_RULES.split(/\s+/)
    .filter(Boolean)
    .map((r) => r.replace(/^[!*]\.?/, '').split('.').pop())
    .filter(Boolean),
);

const SCHEME_RE = /^([a-zA-Z][a-zA-Z0-9+.-]*):/;
const HOST_LABEL_RE = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/i;
const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** Schemes the user may type or open from a link inside a tab. Everything else is handed to the OS. */
export const WEB_SCHEMES = new Set(['http:', 'https:', 'ftp:', 'file:', 'about:', 'data:', 'blob:', 'view-source:', 'ludworks:']);

/** Map chrome://… / edge://… to our internal pages so muscle memory works. */
const INTERNAL_ALIASES = {
  settings: 'settings',
  history: 'history',
  downloads: 'downloads',
  bookmarks: 'bookmarks',
  'password-manager': 'passwords',
  passwords: 'passwords',
  newtab: 'newtab',
  version: 'about',
  extensions: 'extensions',
  about: 'about',
};

function isIPv4(host) {
  const m = IPV4_RE.exec(host);
  return !!m && m.slice(1).every((n) => Number(n) <= 255);
}

function looksLikeHost(host) {
  const h = host.toLowerCase().replace(/\.$/, '');
  if (h === 'localhost' || h.endsWith('.localhost') || isIPv4(h)) return true;
  if (/^\[[0-9a-f:.]+\]$/i.test(h)) return true;
  const labels = h.split('.');
  if (labels.length < 2 || !labels.every((l) => HOST_LABEL_RE.test(l) || /^xn--/.test(l))) return false;
  return TLDS.has(labels[labels.length - 1]);
}

function isLocalHost(host) {
  const h = host.toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost') || h === '[::1]') return true;
  const m = IPV4_RE.exec(h);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254);
}

/**
 * Interpret what the user typed in the address bar.
 * @param {string} input
 * @returns {{type: 'url', url: string} | {type: 'search', query: string} | null}
 */
export function fixupInput(input) {
  const text = String(input || '').trim();
  if (!text) return null;
  const scheme = SCHEME_RE.exec(text);
  if (scheme) {
    const s = scheme[1].toLowerCase();
    if (s === 'chrome' || s === 'edge' || s === 'brave' || s === 'vivaldi' || s === 'opera') {
      const page = text.slice(scheme[0].length).replace(/^\/\//, '').split(/[/?#]/)[0].toLowerCase();
      return { type: 'url', url: `ludworks://${INTERNAL_ALIASES[page] || 'newtab'}/` };
    }
    if (s === 'javascript') return { type: 'search', query: text };
    // "localhost:3000" / "example.com:8443/x" parse as scheme "localhost"/"example.com"
    if (!/^\d+([/?#]|$)/.test(text.slice(scheme[0].length))) {
      try {
        const u = new URL(text);
        return { type: 'url', url: u.href };
      } catch {
        return { type: 'search', query: text };
      }
    }
  }
  if (/\s/.test(text)) return { type: 'search', query: text };
  // host[:port][/path…]
  const m = /^([^/?#:]+|\[[^\]]+\])(:\d{1,5})?([/?#].*)?$/.exec(text);
  if (m && looksLikeHost(m[1])) {
    const proto = isLocalHost(m[1]) ? 'http' : 'https';
    try {
      return { type: 'url', url: new URL(`${proto}://${text}`).href };
    } catch {
      return { type: 'search', query: text };
    }
  }
  return { type: 'search', query: text };
}

/** Text shown in the address bar for a URL (scheme kept so users always see http vs https). */
export function displayUrl(url) {
  if (!url) return '';
  if (url === 'ludworks://newtab/' || url.startsWith('ludworks://newtab/')) return '';
  try {
    const u = new URL(url);
    if (u.protocol === 'http:' || u.protocol === 'https:') {
      let s = u.href;
      if (u.pathname === '/' && !u.search && !u.hash) s = s.replace(/\/$/, '');
      return decodeURIForDisplay(s);
    }
  } catch {
    /* fall through */
  }
  return url;
}

function decodeURIForDisplay(s) {
  try {
    // Never decode characters that change meaning or could spoof (spaces/controls/bidi stay encoded).
    return s.replace(/%(?![0-9a-f]{2})/gi, '%25').replace(/(%[0-9a-f]{2})+/gi, (seq) => {
      try {
        const d = decodeURIComponent(seq);
        return /[\s\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩/?#&=%]/.test(d) ? seq : d;
      } catch {
        return seq;
      }
    });
  } catch {
    return s;
  }
}

/**
 * Security state of a page for the address bar.
 * @returns {'secure'|'insecure'|'internal'|'file'|'other'}
 */
export function securityState(url) {
  try {
    const u = new URL(url);
    if (u.protocol === 'https:') return 'secure';
    if (u.protocol === 'http:') return isLocalHost(u.hostname) ? 'other' : 'insecure';
    if (u.protocol === 'ludworks:') return 'internal';
    if (u.protocol === 'file:') return 'file';
  } catch {
    /* not a URL */
  }
  return 'other';
}

export function originOf(url) {
  try {
    const u = new URL(url);
    return u.origin === 'null' ? '' : u.origin;
  } catch {
    return '';
  }
}

export function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

export function isHttpUrl(url) {
  return /^https?:\/\//i.test(String(url || ''));
}

export const _internals = { looksLikeHost, isLocalHost, TLDS };
