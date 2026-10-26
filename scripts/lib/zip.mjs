// Small, deterministic ZIP writer (+ a reader used by tests). Node built-ins only.
// Writes PKZIP 2.0 entries (deflate or store), UTF-8 names, fixed timestamps, sorted entries; no ZIP64.

import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { crc32 } from './crc32.mjs';

const MAX32 = 0xffffffff;

function dosDateTime(date) {
  const min = new Date(Date.UTC(1980, 0, 1));
  const d = date < min ? min : date;
  const time = (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | Math.floor(d.getUTCSeconds() / 2);
  const day = ((d.getUTCFullYear() - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate();
  return { time, day };
}

function checkName(name) {
  const bad =
    typeof name !== 'string' ||
    !name ||
    name.startsWith('/') ||
    name.includes('\\') ||
    name.split('/').some((p) => p === '..' || p === '.' || p === '');
  if (bad) throw new Error(`zip: invalid entry name ${JSON.stringify(name)}`);
}

/**
 * Build a ZIP archive.
 * @param {Array<{name: string, data: Uint8Array}>} entries
 * @param {{date?: Date, level?: number}} [opts]  date defaults to 1980-01-01 (reproducible builds)
 * @returns {Buffer}
 */
export function createZip(entries, { date = new Date(Date.UTC(1980, 0, 1)), level = 9 } = {}) {
  const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  if (sorted.length > 0xffff) throw new Error('zip: too many entries');
  const seen = new Set();
  const { time, day } = dosDateTime(date);
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const e of sorted) {
    checkName(e.name);
    if (seen.has(e.name)) throw new Error(`zip: duplicate entry ${e.name}`);
    seen.add(e.name);
    const data = Buffer.from(e.data);
    const name = Buffer.from(e.name, 'utf8');
    const crc = crc32(data);
    let method = 8;
    let body = deflateRawSync(data, { level });
    if (body.length >= data.length) {
      method = 0;
      body = data;
    }
    if (data.length > MAX32 || body.length > MAX32 || offset > MAX32) throw new Error('zip: ZIP64 not supported');
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4); // version needed to extract
    lh.writeUInt16LE(0x0800, 6); // general purpose flags: UTF-8 names
    lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(time, 10);
    lh.writeUInt16LE(day, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(body.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    lh.writeUInt16LE(0, 28);
    locals.push(lh, name, body);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE((3 << 8) | 20, 4); // made by UNIX, spec 2.0
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt16LE(time, 12);
    ch.writeUInt16LE(day, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(body.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt16LE(0, 30); // extra length
    ch.writeUInt16LE(0, 32); // comment length
    ch.writeUInt16LE(0, 34); // disk number
    ch.writeUInt16LE(0, 36); // internal attributes
    ch.writeUInt32LE((0o100644 << 16) >>> 0, 38); // external attributes: regular file rw-r--r--
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, name);
    offset += lh.length + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(sorted.length, 8);
  eocd.writeUInt16LE(sorted.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, cd, eocd]);
}

/**
 * Read a ZIP produced by createZip (verifies sizes and CRCs). Test helper.
 * @param {Buffer} buf
 * @returns {Array<{name: string, method: number, data: Buffer}>}
 */
export function readZip(buf) {
  const eocdAt = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocdAt < 0) throw new Error('no end-of-central-directory record');
  const count = buf.readUInt16LE(eocdAt + 10);
  let p = buf.readUInt32LE(eocdAt + 16);
  const out = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('bad central directory header');
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28);
    const elen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const lho = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nlen);
    if (buf.readUInt32LE(lho) !== 0x04034b50) throw new Error(`bad local header for ${name}`);
    const lnlen = buf.readUInt16LE(lho + 26);
    const lelen = buf.readUInt16LE(lho + 28);
    const start = lho + 30 + lnlen + lelen;
    const body = buf.subarray(start, start + csize);
    const data = method === 8 ? inflateRawSync(body) : Buffer.from(body);
    if (data.length !== usize || crc32(data) !== crc) throw new Error(`CRC/size mismatch for ${name}`);
    out.push({ name, method, data });
    p += 46 + nlen + elen + clen;
  }
  return out;
}
