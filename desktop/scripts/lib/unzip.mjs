// Minimal ZIP extractor for the pinned Electron release archives (Node built-ins only).
// Supports stored and deflated entries, Zip64 sizes/offsets, Unix modes and symlinks (macOS
// framework bundles). Every entry is CRC-checked; names that would escape the destination are
// refused.

import { mkdirSync, writeFileSync, symlinkSync, chmodSync, rmSync, lstatSync } from 'node:fs';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { crc32 } from '../../../scripts/lib/crc32.mjs';

const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;
const S_IFDIR = 0o040000;

function findEocd(buf) {
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i;
  }
  throw new Error('zip: no end-of-central-directory record');
}

/**
 * List the entries of a ZIP held in memory.
 * @param {Buffer} buf
 * @returns {Array<{name: string, method: number, crc: number, csize: number, usize: number, offset: number, mode: number, isDir: boolean, isLink: boolean}>}
 */
export function listZip(buf) {
  const eocd = findEocd(buf);
  let count = buf.readUInt16LE(eocd + 10);
  let cdOffset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdOffset === 0xffffffff) {
    const locAt = eocd - 20;
    if (buf.readUInt32LE(locAt) !== 0x07064b50) throw new Error('zip: missing zip64 locator');
    const z64 = Number(buf.readBigUInt64LE(locAt + 8));
    if (buf.readUInt32LE(z64) !== 0x06064b50) throw new Error('zip: bad zip64 end record');
    count = Number(buf.readBigUInt64LE(z64 + 32));
    cdOffset = Number(buf.readBigUInt64LE(z64 + 48));
  }
  const out = [];
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('zip: bad central directory header');
    const madeBy = buf.readUInt16LE(p + 4) >> 8;
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    let csize = buf.readUInt32LE(p + 20);
    let usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28);
    const elen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const external = buf.readUInt32LE(p + 38);
    let offset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nlen);
    // Zip64 extra field (id 0x0001) holds the values that overflowed, in this order.
    let e = p + 46 + nlen;
    const eEnd = e + elen;
    while (e + 4 <= eEnd) {
      const id = buf.readUInt16LE(e);
      const size = buf.readUInt16LE(e + 2);
      if (id === 0x0001) {
        let q = e + 4;
        if (usize === 0xffffffff) { usize = Number(buf.readBigUInt64LE(q)); q += 8; }
        if (csize === 0xffffffff) { csize = Number(buf.readBigUInt64LE(q)); q += 8; }
        if (offset === 0xffffffff) { offset = Number(buf.readBigUInt64LE(q)); q += 8; }
      }
      e += 4 + size;
    }
    const unixMode = madeBy === 3 ? external >>> 16 : 0;
    const isDir = name.endsWith('/') || (unixMode & S_IFMT) === S_IFDIR;
    const isLink = (unixMode & S_IFMT) === S_IFLNK;
    out.push({ name, method, crc, csize, usize, offset, mode: unixMode & 0o7777, isDir, isLink });
    p += 46 + nlen + elen + clen;
  }
  return out;
}

/**
 * Read one entry's bytes (CRC and size verified).
 * @param {Buffer} buf
 * @param {ReturnType<typeof listZip>[number]} ent
 */
export function readEntry(buf, ent) {
  if (buf.readUInt32LE(ent.offset) !== 0x04034b50) throw new Error(`zip: bad local header for ${ent.name}`);
  const lnlen = buf.readUInt16LE(ent.offset + 26);
  const lelen = buf.readUInt16LE(ent.offset + 28);
  const start = ent.offset + 30 + lnlen + lelen;
  const body = buf.subarray(start, start + ent.csize);
  let data;
  if (ent.method === 0) data = Buffer.from(body);
  else if (ent.method === 8) data = inflateRawSync(body);
  else throw new Error(`zip: unsupported compression method ${ent.method} for ${ent.name}`);
  if (data.length !== ent.usize || crc32(data) !== ent.crc) throw new Error(`zip: CRC/size mismatch for ${ent.name}`);
  return data;
}

/**
 * Extract every entry into `dest` (created; existing content is replaced).
 * @param {Buffer} buf
 * @param {string} dest
 * @param {{filter?: (name: string) => boolean}} [opts]
 * @returns {number} number of files written
 */
export function extractZip(buf, dest, { filter = () => true } = {}) {
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  const root = path.resolve(dest);
  let n = 0;
  const links = [];
  for (const ent of listZip(buf)) {
    if (!filter(ent.name)) continue;
    const target = path.resolve(root, ent.name);
    if (target !== root && !target.startsWith(root + path.sep)) throw new Error(`zip: entry escapes destination: ${ent.name}`);
    if (ent.isDir) {
      mkdirSync(target, { recursive: true });
      continue;
    }
    mkdirSync(path.dirname(target), { recursive: true });
    const data = readEntry(buf, ent);
    if (ent.isLink) {
      links.push({ target, to: data.toString('utf8') });
      continue;
    }
    writeFileSync(target, data);
    if (ent.mode && process.platform !== 'win32') chmodSync(target, ent.mode);
    n++;
  }
  // Symlinks last (their targets exist by then); only relative links inside the tree.
  for (const { target, to } of links) {
    const resolved = path.resolve(path.dirname(target), to);
    if (path.isAbsolute(to) || (resolved !== root && !resolved.startsWith(root + path.sep))) {
      throw new Error(`zip: symlink escapes destination: ${target} -> ${to}`);
    }
    try {
      lstatSync(target);
      rmSync(target, { recursive: true, force: true });
    } catch {
      /* not there yet */
    }
    symlinkSync(to, target);
    n++;
  }
  return n;
}
