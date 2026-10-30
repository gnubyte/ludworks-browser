// Unpacking extension archives (verified CRX payloads, .zip files) safely: no path traversal, no
// absolute or drive paths, no device names, no zip bombs (entry count, per-file and total size caps,
// checked against the real inflated sizes), manifest.json required at the root.

import { mkdirSync, writeFileSync, rmSync, existsSync, renameSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { readZip } from '../import/zip.js';

export const LIMITS = Object.freeze({
  maxEntries: 20000,
  maxEntryBytes: 128 * 1024 * 1024,
  maxTotalBytes: 512 * 1024 * 1024,
  maxNameLength: 512,
  maxDepth: 32,
});

const WIN_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

export class UnpackError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/**
 * Normalised relative path for an archive entry, or throws when the name is unsafe.
 * @param {string} name
 */
export function safeEntryPath(name) {
  const n = String(name);
  if (!n || n.length > LIMITS.maxNameLength || n.includes('\0')) throw new UnpackError('bad_path', 'The archive contains an invalid file name.');
  if (n.startsWith('/') || n.startsWith('\\') || /^[a-zA-Z]:/.test(n)) throw new UnpackError('bad_path', `The archive contains an absolute path (${n.slice(0, 80)}).`);
  const parts = n.replace(/\\/g, '/').split('/');
  const isDir = n.endsWith('/');
  const clean = [];
  for (const p of parts) {
    if (p === '' || p === '.') continue;
    if (p === '..') throw new UnpackError('bad_path', `The archive tries to write outside its folder (${n.slice(0, 80)}).`);
    if (/[<>:"|?*\u0000-\u001f]/.test(p) || WIN_RESERVED.test(p) || /[. ]$/.test(p)) throw new UnpackError('bad_path', `The archive contains a file name that is not allowed (${p.slice(0, 80)}).`);
    clean.push(p);
  }
  if (!clean.length && !isDir) throw new UnpackError('bad_path', 'The archive contains an empty file name.');
  if (clean.length > LIMITS.maxDepth) throw new UnpackError('bad_path', 'The archive is nested too deeply.');
  return clean.join('/');
}

/**
 * Lists and reads the files of an extension archive in memory (all checks done before anything is
 * written). Returns {files: [{path, data}], manifest, manifestText}.
 * @param {Buffer} zipBuf
 * @param {Partial<typeof LIMITS>} [limits]
 */
export function readExtensionArchive(zipBuf, limits = {}) {
  const L = { ...LIMITS, ...limits };
  let entries;
  try {
    entries = readZip(zipBuf, { maxEntries: L.maxEntries, maxEntryBytes: L.maxEntryBytes });
  } catch (e) {
    throw new UnpackError(e.code === 'limit_exceeded' ? 'too_large' : 'bad_archive', e.message);
  }
  let declared = 0;
  for (const e of entries) {
    if (e.encrypted) throw new UnpackError('bad_archive', 'The archive is encrypted.');
    declared += e.isDir ? 0 : e.size;
    if (declared > L.maxTotalBytes) throw new UnpackError('too_large', 'The extension is too large to install.');
  }
  const files = [];
  const seen = new Set();
  let total = 0;
  for (const e of entries) {
    const rel = safeEntryPath(e.name);
    if (e.isDir) continue;
    const key = rel.toLowerCase();
    if (seen.has(key)) throw new UnpackError('bad_path', `The archive contains "${rel}" twice.`);
    seen.add(key);
    let data;
    try {
      data = e.read(); // inflates at most the declared size and checks it and the CRC
    } catch (x) {
      throw new UnpackError(x.code === 'limit_exceeded' ? 'too_large' : 'bad_archive', x.message);
    }
    total += data.length;
    if (total > L.maxTotalBytes) throw new UnpackError('too_large', 'The extension is too large to install.');
    files.push({ path: rel, data });
  }
  // Packages made by some tools put everything in one top-level folder: accept that too.
  let prefix = '';
  if (!files.some((f) => f.path === 'manifest.json')) {
    const tops = new Set(files.map((f) => f.path.split('/')[0]));
    if (tops.size === 1) {
      const top = [...tops][0];
      if (files.some((f) => f.path === `${top}/manifest.json`)) prefix = `${top}/`;
    }
  }
  const manifestFile = files.find((f) => f.path === `${prefix}manifest.json`);
  if (!manifestFile) throw new UnpackError('no_manifest', 'This is not an extension (manifest.json is missing).');
  const manifestText = manifestFile.data.toString('utf8').replace(/^﻿/, '');
  let manifest;
  try {
    manifest = JSON.parse(stripJsonComments(manifestText));
  } catch (e) {
    throw new UnpackError('bad_manifest', `manifest.json is not valid JSON (${e.message}).`);
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new UnpackError('bad_manifest', 'manifest.json is not an object.');
  return { files: prefix ? files.map((f) => ({ path: f.path.slice(prefix.length), data: f.data })).filter((f) => f.path) : files, manifest };
}

/** Chrome accepts // and /* *\/ comments in manifest.json. */
export function stripJsonComments(s) {
  let out = '';
  let i = 0;
  let inStr = false;
  while (i < s.length) {
    const c = s[i];
    if (inStr) {
      out += c;
      if (c === '\\') {
        out += s[i + 1] || '';
        i += 2;
        continue;
      }
      if (c === '"') inStr = false;
      i++;
    } else if (c === '"') {
      inStr = true;
      out += c;
      i++;
    } else if (c === '/' && s[i + 1] === '/') {
      while (i < s.length && s[i] !== '\n') i++;
    } else if (c === '/' && s[i + 1] === '*') {
      i += 2;
      while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) i++;
      i += 2;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/**
 * Writes files into a new folder next to `finalDir`, then renames it into place (the folder appears
 * complete or not at all). `finalDir` must not exist yet.
 * @param {string} finalDir
 * @param {Array<{path: string, data: Buffer|string}>} files
 */
export function writeTree(finalDir, files) {
  const parent = path.dirname(finalDir);
  mkdirSync(parent, { recursive: true });
  const tmp = path.join(parent, `.tmp-${path.basename(finalDir)}-${process.pid}-${Date.now()}`);
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  try {
    for (const f of files) {
      const rel = safeEntryPath(f.path);
      const dest = path.resolve(tmp, rel);
      if (dest !== tmp && !dest.startsWith(tmp + path.sep)) throw new UnpackError('bad_path', `Refusing to write outside the extension folder (${rel}).`);
      mkdirSync(path.dirname(dest), { recursive: true });
      writeFileSync(dest, f.data);
    }
    if (existsSync(finalDir)) rmSync(finalDir, { recursive: true, force: true });
    renameSync(tmp, finalDir);
  } catch (e) {
    rmSync(tmp, { recursive: true, force: true });
    throw e;
  }
  return finalDir;
}

/** Removes leftovers of interrupted installs (".tmp-*" folders) under an extension's folder. */
export function cleanTemp(dir) {
  try {
    for (const n of readdirSync(dir)) if (n.startsWith('.tmp-')) rmSync(path.join(dir, n), { recursive: true, force: true });
  } catch {
    /* nothing there */
  }
}

/** Total size of a folder (for the details page). */
export function dirSize(dir, limit = 20000) {
  let total = 0;
  let n = 0;
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (++n > limit) return;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) total += statSync(p).size;
    }
  };
  try {
    walk(dir);
  } catch {
    /* gone */
  }
  return total;
}
