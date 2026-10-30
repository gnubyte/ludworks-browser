// Getting extension packages onto disk: Web Store downloads (CRX3, verified with the developer and the
// Web Store signatures), local .crx/.zip files and unpacked folders. Every package becomes a folder
// <profile>/Extensions/<id>/<version>/ (unpacked ones: a copy under _unpacked/) that Ludworks prepares:
//
//   * "key" is added to manifest.json so the folder keeps the extension's Web Store ID;
//   * ludworks-browser/cs.js (the chrome.storage.sync shim, the same code the extension preload uses) is put in
//     front of every content script running in the extension's isolated world;
//   * optional permissions the user granted are moved into the permission lists (Chromium only knows
//     about manifest permissions), and ludworks-browser/manifest.original.json keeps the publisher's version.
//
// Nothing from a package is written before its signature (CRX) and every path and size in it is checked.

import { createHash, generateKeyPairSync } from 'node:crypto';
import { readFileSync, existsSync, mkdirSync, readdirSync, statSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { verifyCrx, idFromManifestKey, CrxError } from './crx.js';
import { readExtensionArchive, writeTree, safeEntryPath, UnpackError, LIMITS, stripJsonComments } from './unpack.js';
import { downloadUrl, trustedCodebase, validVersion } from './webstore.js';
import { optionalPermissions, apiPermissions, STRIPPED_PERMISSIONS } from './manifest.js';

export const SHIM_DIR = 'ludworks-browser';
export const CS_SHIM = `${SHIM_DIR}/cs.js`;
const ORIGINAL = `${SHIM_DIR}/manifest.original.json`;
const MAX_DOWNLOAD = 160 * 1024 * 1024;

export class InstallError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

let shimSource = null;
/** The storage shim for content scripts, cut out of the extension preload (single source of truth). */
export function contentShim(preloadFile) {
  if (shimSource) return shimSource;
  const text = readFileSync(preloadFile, 'utf8');
  const a = text.indexOf('/* <lw-storage-shim> */');
  const b = text.indexOf('/* </lw-storage-shim> */');
  if (a < 0 || b < a) throw new Error('storage shim markers missing in the extension preload');
  const fn = text.slice(a + '/* <lw-storage-shim> */'.length, b).trim();
  // chrome and, when the engine exposes it separately, the `browser` namespace
  const apply = 'if (typeof chrome !== \'undefined\') lwStorageShim(chrome);\n    if (typeof browser !== \'undefined\' && (typeof chrome === \'undefined\' || browser !== chrome)) lwStorageShim(browser);';
  shimSource = `// Added by Ludworks Browser: chrome.storage.sync for this extension's content scripts.\n(function () {\n  'use strict';\n  ${fn}\n  try {\n    ${apply}\n  } catch (e) {\n    /* leave storage as it is */\n  }\n})();\n`;
  return shimSource;
}

// --------------------------------------------------------------------------------------- download
/**
 * Fetches a URL into memory with a size cap (the browser's own request: no cookies).
 * @param {(url: string, init: object) => Promise<Response>} fetchImpl
 */
export async function download(fetchImpl, url, { maxBytes = MAX_DOWNLOAD, timeoutMs = 120000, expectSha256 = null } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: ctrl.signal, redirect: 'follow', credentials: 'omit', cache: 'no-store' });
    if (res.status === 204 || res.status === 404) throw new InstallError('not_found', 'This extension is not available from the Chrome Web Store (it may have been removed, or not be offered for this browser).');
    if (!res.ok) throw new InstallError('http', `The download failed (HTTP ${res.status}).`);
    if (res.url && !trustedCodebase(res.url)) throw new InstallError('untrusted', 'The download was redirected to an unexpected server.');
    const len = Number(res.headers.get('content-length') || 0);
    if (len > maxBytes) throw new InstallError('too_large', 'The extension is too large to download.');
    const chunks = [];
    let total = 0;
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxBytes) {
        ctrl.abort();
        throw new InstallError('too_large', 'The extension is too large to download.');
      }
      chunks.push(Buffer.from(value));
    }
    const buf = Buffer.concat(chunks, total);
    if (expectSha256 && createHash('sha256').update(buf).digest('hex') !== expectSha256) throw new InstallError('hash', 'The downloaded file does not match the checksum the Web Store announced.');
    return buf;
  } catch (e) {
    if (e instanceof InstallError) throw e;
    if (e && e.name === 'AbortError') throw new InstallError('timeout', 'The download took too long.');
    throw new InstallError('network', `The download failed (${e && e.message ? e.message : e}).`);
  } finally {
    clearTimeout(timer);
  }
}

/** Downloads and verifies the current Web Store package of an extension. */
export async function fetchFromStore(fetchImpl, id, chromeVersion, { url = null, expectSha256 = null } = {}) {
  const buf = await download(fetchImpl, url || downloadUrl(id, chromeVersion), { expectSha256 });
  return openCrx(buf, { expectedId: id, requirePublisher: true });
}

/** Verifies a CRX3 package and reads its archive (in memory). */
export function openCrx(buf, { expectedId = null, requirePublisher = false } = {}) {
  let v;
  try {
    v = verifyCrx(buf, { expectedId, requirePublisher });
  } catch (e) {
    if (e instanceof CrxError) throw new InstallError(e.code, e.message);
    throw e;
  }
  const pkg = readArchive(v.archive);
  return { ...pkg, id: v.id, key: v.key, publisher: v.publisher };
}

/** Reads a .zip (no signature: the extension gets a key of its own unless its manifest has one). */
export function openZip(buf) {
  const pkg = readArchive(buf);
  let key = typeof pkg.manifest.key === 'string' ? pkg.manifest.key : null;
  let id = key ? idFromManifestKey(key) : null;
  if (!id) {
    const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    key = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
    id = idFromManifestKey(key);
  }
  return { ...pkg, id, key, publisher: false };
}

function readArchive(buf) {
  try {
    const { files, manifest } = readExtensionArchive(buf);
    checkManifest(manifest);
    return { files, manifest };
  } catch (e) {
    if (e instanceof UnpackError) throw new InstallError(e.code, e.message);
    throw e;
  }
}

export function checkManifest(m) {
  if (m.manifest_version !== 2 && m.manifest_version !== 3) throw new InstallError('bad_manifest', `Unsupported manifest version ${m.manifest_version}.`);
  if (typeof m.name !== 'string' || !m.name.trim()) throw new InstallError('bad_manifest', 'The extension has no name.');
  if (!validVersion(String(m.version || ''))) throw new InstallError('bad_manifest', 'The extension has an invalid version.');
  if (m.theme && !m.background && !m.content_scripts) throw new InstallError('theme', 'Themes are not supported.');
  if (m.app || m.platforms) throw new InstallError('app', 'Chrome apps are not supported.');
}

// ------------------------------------------------------------------------------- preparing a folder
/**
 * The manifest Ludworks loads: publisher manifest + key + content-script shim + granted optional
 * permissions.
 * @param {object} original
 * @param {{key?: string|null, granted?: {permissions?: string[], origins?: string[]}}} o
 */
export function preparedManifest(original, { key = null, granted = null } = {}) {
  const m = JSON.parse(JSON.stringify(original));
  if (key) m.key = key;
  if (Array.isArray(m.content_scripts)) {
    m.content_scripts = m.content_scripts.map((cs) => {
      if (!cs || !Array.isArray(cs.js) || !cs.js.length || cs.world === 'MAIN' || cs.js.includes(CS_SHIM)) return cs;
      return { ...cs, js: [CS_SHIM, ...cs.js] };
    });
  }
  if (granted) {
    const opt = optionalPermissions(original);
    const perms = (granted.permissions || []).filter((p) => opt.permissions.includes(p));
    const origins = (granted.origins || []).filter((p) => opt.origins.includes(p));
    if (perms.length) m.permissions = [...new Set([...(Array.isArray(m.permissions) ? m.permissions : []), ...perms])];
    if (origins.length) {
      if (m.manifest_version >= 3) m.host_permissions = [...new Set([...(Array.isArray(m.host_permissions) ? m.host_permissions : []), ...origins])];
      else m.permissions = [...new Set([...(Array.isArray(m.permissions) ? m.permissions : []), ...origins])];
    }
    const keepPerm = (list) => list.filter((p) => !perms.includes(p) && !origins.includes(p));
    if (Array.isArray(m.optional_permissions)) m.optional_permissions = keepPerm(m.optional_permissions);
    if (Array.isArray(m.optional_host_permissions)) m.optional_host_permissions = keepPerm(m.optional_host_permissions);
  }
  // APIs whose engine implementation crashes the browser are never exposed (see STRIPPED_PERMISSIONS).
  for (const k of ['permissions', 'optional_permissions']) if (Array.isArray(m[k])) m[k] = m[k].filter((p) => !STRIPPED_PERMISSIONS.includes(p));
  return m;
}

/**
 * Writes a package into its final folder (atomically) with the Ludworks additions.
 * @returns {string} the folder
 */
export function writePackage(dir, pkg, { shim, granted = null }) {
  const files = pkg.files.filter((f) => f.path !== 'manifest.json' && !f.path.startsWith(`${SHIM_DIR}/`));
  const original = pkg.manifest;
  files.push(
    { path: 'manifest.json', data: Buffer.from(JSON.stringify(preparedManifest(original, { key: pkg.key, granted }), null, 2)) },
    { path: ORIGINAL, data: Buffer.from(JSON.stringify({ manifest: original, key: pkg.key || null }, null, 2)) },
    { path: CS_SHIM, data: Buffer.from(shim) },
  );
  return writeTree(dir, files);
}

/**
 * Brings a prepared folder up to date with this version of Ludworks before it is loaded: the content
 * script shim and manifest.json (re-derived from the publisher's manifest). Writes only what changed.
 */
export function refreshPrepared(dir, { shim, granted = null }) {
  const o = readOriginal(dir);
  if (!o) return false;
  const write = (rel, text) => {
    const f = path.join(dir, rel);
    let cur = null;
    try {
      cur = readFileSync(f, 'utf8');
    } catch {
      cur = null;
    }
    if (cur !== text) {
      mkdirSync(path.dirname(f), { recursive: true });
      writeFileSync(f, text);
      return true;
    }
    return false;
  };
  const a = write(CS_SHIM, shim);
  const b = write('manifest.json', JSON.stringify(preparedManifest(o.manifest, { key: o.key, granted }), null, 2));
  return a || b;
}

/** Rewrites manifest.json of a prepared folder (after permission changes). */
export function rewriteManifest(dir, granted) {
  const o = readOriginal(dir);
  if (!o) return false;
  writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(preparedManifest(o.manifest, { key: o.key, granted }), null, 2));
  return true;
}

export function readOriginal(dir) {
  try {
    const j = JSON.parse(readFileSync(path.join(dir, ORIGINAL), 'utf8'));
    return j && j.manifest ? j : null;
  } catch {
    return null;
  }
}

/** Reads manifest.json of a folder (comments allowed, like Chrome). */
export function readManifestFile(dir) {
  const text = readFileSync(path.join(dir, 'manifest.json'), 'utf8').replace(/^﻿/, '');
  return JSON.parse(stripJsonComments(text));
}

// --------------------------------------------------------------------------------- unpacked folders
/** Reads an unpacked extension folder into memory (same limits as archives; .git is skipped). */
export function readFolder(src) {
  const files = [];
  let total = 0;
  const walk = (dir, rel, depth) => {
    if (depth > LIMITS.maxDepth) throw new InstallError('bad_path', 'The folder is nested too deeply.');
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === '.git' || e.name === SHIM_DIR) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      const p = path.join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) walk(p, r, depth + 1);
      else if (e.isFile()) {
        safeEntryPath(r);
        const size = statSync(p).size;
        total += size;
        if (files.length >= LIMITS.maxEntries || size > LIMITS.maxEntryBytes || total > LIMITS.maxTotalBytes) throw new InstallError('too_large', 'The folder is too large to load as an extension.');
        files.push({ path: r, data: readFileSync(p) });
      }
    }
  };
  walk(src, '', 0);
  const mf = files.find((f) => f.path === 'manifest.json');
  if (!mf) throw new InstallError('no_manifest', 'This folder has no manifest.json.');
  let manifest;
  try {
    manifest = JSON.parse(stripJsonComments(mf.data.toString('utf8').replace(/^﻿/, '')));
  } catch (e) {
    throw new InstallError('bad_manifest', `manifest.json is not valid JSON (${e.message}).`);
  }
  checkManifest(manifest);
  return { files, manifest, key: typeof manifest.key === 'string' ? manifest.key : null, id: typeof manifest.key === 'string' ? idFromManifestKey(manifest.key) : null };
}

/** Stable folder for the working copy of an unpacked extension. */
export function unpackedCopyDir(root, src) {
  return path.join(root, '_unpacked', createHash('sha256').update(path.resolve(src).toLowerCase()).digest('hex').slice(0, 16));
}

export function removeDir(dir) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    return true;
  } catch {
    return false;
  }
}

export function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
  return dir;
}

export { existsSync, apiPermissions };
