// Chrome Web Store: recognising item pages, and Google's public update service (the same endpoint
// Chrome uses) for downloads and update checks. Pure helpers; the network calls live in installer.js.

import { isExtensionId } from './crx.js';

export const STORE_ORIGIN = 'https://chromewebstore.google.com';
const UPDATE_URL = 'https://clients2.google.com/service/update2/crx';

/** Extension ID of a Chrome Web Store item page (new and old store), else null. */
export function storeItemId(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:') return null;
  let m = null;
  if (u.hostname === 'chromewebstore.google.com') m = /^\/detail\/(?:[^/]+\/)?([a-p]{32})(?:[/?#]|$)/.exec(u.pathname);
  else if (u.hostname === 'chrome.google.com') m = /^\/webstore\/detail\/(?:[^/]+\/)?([a-p]{32})(?:[/?#]|$)/.exec(u.pathname);
  return m && isExtensionId(m[1]) ? m[1] : null;
}

export const storePageUrl = (id) => `${STORE_ORIGIN}/detail/${id}`;

function platformParams(platform = process.platform, arch = process.arch) {
  const os = platform === 'win32' ? 'win' : platform === 'darwin' ? 'mac' : 'linux';
  const a = arch === 'arm64' ? 'arm64' : arch === 'ia32' ? 'x86' : 'x64';
  const osArch = arch === 'arm64' ? 'arm64' : arch === 'ia32' ? 'x86' : 'x86_64';
  return { os, arch: a, os_arch: osArch, nacl_arch: arch === 'arm64' ? 'arm' : 'x86-64' };
}

/** Download URL for the current package of an extension (redirects to the CRX3 file). */
export function downloadUrl(id, chromeVersion, { platform, arch } = {}) {
  if (!isExtensionId(id)) throw new Error('invalid extension id');
  const p = platformParams(platform, arch);
  const q = new URLSearchParams({ response: 'redirect', os: p.os, arch: p.arch, os_arch: p.os_arch, nacl_arch: p.nacl_arch, prod: 'chromecrx', prodchannel: '', prodversion: chromeVersion, lang: 'en-US', acceptformat: 'crx3' });
  return `${UPDATE_URL}?${q}&x=${encodeURIComponent(`id=${id}&installsource=ondemand&uc`)}`;
}

/** Update-check URL for several installed extensions ({id, version}). */
export function updateCheckUrl(items, chromeVersion, { platform, arch } = {}) {
  const p = platformParams(platform, arch);
  const q = new URLSearchParams({ response: 'updatecheck', os: p.os, arch: p.arch, os_arch: p.os_arch, nacl_arch: p.nacl_arch, prod: 'chromecrx', prodchannel: '', prodversion: chromeVersion, lang: 'en-US', acceptformat: 'crx3' });
  const xs = items.filter((x) => isExtensionId(x.id)).map((x) => `x=${encodeURIComponent(`id=${x.id}&v=${/^[0-9.]{1,40}$/.test(x.version) ? x.version : '0.0.0.0'}&installsource=notfromwebstore&uc`)}`);
  return `${UPDATE_URL}?${q}&${xs.join('&')}`;
}

function attrs(tag) {
  const out = {};
  const re = /([A-Za-z_:][\w:.-]*)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = re.exec(tag))) out[m[1]] = decodeXml(m[3] !== undefined ? m[3] : m[4]);
  return out;
}

const decodeXml = (s) => s.replace(/&(lt|gt|quot|apos|amp|#\d+|#x[0-9a-f]+);/gi, (_, e) => ({ lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' })[e.toLowerCase()] ?? (e[1].toLowerCase() === 'x' ? String.fromCodePoint(parseInt(e.slice(2), 16)) : String.fromCodePoint(Number(e.slice(1)))));

/**
 * Parses a gupdate (protocol 2.0) update-check response.
 * @returns {Map<string, {status: string, version?: string, codebase?: string, sha256?: string, size?: number}>}
 */
export function parseUpdateResponse(xml) {
  const out = new Map();
  const text = String(xml || '');
  if (text.length > 4 * 1024 * 1024 || !/<gupdate[\s>]/.test(text)) throw new Error('not an update response');
  const appRe = /<app\b([^>]*?)(\/>|>([\s\S]*?)<\/app>)/g;
  let m;
  while ((m = appRe.exec(text))) {
    const a = attrs(m[1]);
    if (!isExtensionId(a.appid)) continue;
    const body = m[3] || '';
    const uc = /<updatecheck\b([^>]*?)\/?>/.exec(body);
    if (!uc) {
      out.set(a.appid, { status: a.status || 'error' });
      continue;
    }
    const u = attrs(uc[1]);
    const r = { status: u.status || 'error' };
    if (u.status === 'ok') {
      r.version = u.version;
      r.codebase = u.codebase;
      if (/^[0-9a-f]{64}$/i.test(u.hash_sha256 || '')) r.sha256 = u.hash_sha256.toLowerCase();
      if (/^\d+$/.test(u.size || '')) r.size = Number(u.size);
    }
    out.set(a.appid, r);
  }
  return out;
}

/** Chrome version comparison: "1.2.10" > "1.2.9" (missing parts are 0). */
export function compareVersions(a, b) {
  const pa = String(a || '').split('.').map((x) => parseInt(x, 10) || 0);
  const pb = String(b || '').split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** A valid extension version string ("1" to "65535.65535.65535.65535"). */
export function validVersion(v) {
  return typeof v === 'string' && /^\d{1,5}(\.\d{1,5}){0,3}$/.test(v) && v.split('.').every((x) => Number(x) <= 65535 && (x === '0' || !x.startsWith('0')));
}

/** Download URLs we accept from an update response (Google's servers, https only). */
export function trustedCodebase(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && /(^|\.)(google\.com|googleusercontent\.com|gvt1\.com)$/i.test(u.hostname);
  } catch {
    return false;
  }
}
