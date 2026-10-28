// Minimal in-memory ZIP reader for Bitwarden ".zip" exports (data.json + attachments/<item>/<file>).
// Node built-ins only: stored and deflated entries, ZIP64 sizes/offsets, CRC-32 checked, sizes capped.
// Encrypted (password-protected) ZIP entries are refused with a clear message.

import { inflateRawSync, crc32 } from 'node:zlib';

const SIG_EOCD = 0x06054b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_EOCD64_LOC = 0x07064b50;
const SIG_CEN = 0x02014b50;
const SIG_LOC = 0x04034b50;
const MAX32 = 0xffffffff;

function zipError(code, message) {
  return Object.assign(new Error(message), { code });
}

/** Is this buffer a ZIP archive (local file header or empty-archive EOCD)? */
export function isZip(buf) {
  return !!buf && buf.length >= 4 && (buf.readUInt32LE(0) === SIG_LOC || (buf.length === 22 && buf.readUInt32LE(0) === SIG_EOCD));
}

function findEocd(buf) {
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === SIG_EOCD) return i;
  throw zipError('malformed', 'This ZIP file is damaged (no end-of-central-directory record).');
}

function zip64Extra(extra, need) {
  // need: {usize, csize, offset} flags in that order (only the 0xffffffff ones are present)
  for (let i = 0; i + 4 <= extra.length; ) {
    const id = extra.readUInt16LE(i);
    const len = extra.readUInt16LE(i + 2);
    if (id === 0x0001) {
      let p = i + 4;
      const out = {};
      for (const k of ['usize', 'csize', 'offset']) {
        if (!need[k]) continue;
        if (p + 8 > i + 4 + len) break;
        out[k] = Number(extra.readBigUInt64LE(p));
        p += 8;
      }
      return out;
    }
    i += 4 + len;
  }
  return {};
}

/**
 * List the entries of a ZIP held in memory. Each entry has `read()` which inflates and CRC-checks it.
 * @param {Buffer} buf
 * @param {{maxEntries?: number, maxEntryBytes?: number}} [opts]
 * @returns {Array<{name: string, size: number, isDir: boolean, encrypted: boolean, read: () => Buffer}>}
 */
export function readZip(buf, { maxEntries = 100000, maxEntryBytes = 512 * 1024 * 1024 } = {}) {
  const eocd = findEocd(buf);
  let count = buf.readUInt16LE(eocd + 10);
  let cdOffset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdOffset === MAX32) {
    const loc = eocd - 20;
    if (loc < 0 || buf.readUInt32LE(loc) !== SIG_EOCD64_LOC) throw zipError('malformed', 'This ZIP file is damaged (ZIP64 locator missing).');
    const e64 = Number(buf.readBigUInt64LE(loc + 8));
    if (e64 < 0 || e64 + 56 > buf.length || buf.readUInt32LE(e64) !== SIG_EOCD64) throw zipError('malformed', 'This ZIP file is damaged (ZIP64 record missing).');
    count = Number(buf.readBigUInt64LE(e64 + 32));
    cdOffset = Number(buf.readBigUInt64LE(e64 + 48));
  }
  if (count > maxEntries) throw zipError('limit_exceeded', `This ZIP file has too many entries (${count}).`);
  const out = [];
  let p = cdOffset;
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== SIG_CEN) throw zipError('malformed', 'This ZIP file is damaged (bad central directory).');
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    let csize = buf.readUInt32LE(p + 20);
    let usize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    let offset = buf.readUInt32LE(p + 42);
    const rawName = buf.subarray(p + 46, p + 46 + nameLen);
    const name = (flags & 0x800 ? rawName.toString('utf8') : rawName.toString('latin1')).replace(/\\/g, '/');
    if (csize === MAX32 || usize === MAX32 || offset === MAX32) {
      const x = zip64Extra(buf.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen), { usize: usize === MAX32, csize: csize === MAX32, offset: offset === MAX32 });
      if (x.usize !== undefined) usize = x.usize;
      if (x.csize !== undefined) csize = x.csize;
      if (x.offset !== undefined) offset = x.offset;
    }
    p += 46 + nameLen + extraLen + commentLen;
    const isDir = name.endsWith('/');
    const encrypted = !!(flags & 0x1);
    const entry = {
      name,
      size: usize,
      isDir,
      encrypted,
      read() {
        if (encrypted) throw zipError('unsupported', 'This ZIP file is password-protected. Extract it with your archive tool first, then import data.json.');
        if (usize > maxEntryBytes) throw zipError('limit_exceeded', `"${name}" is too large to import.`);
        if (offset + 30 > buf.length || buf.readUInt32LE(offset) !== SIG_LOC) throw zipError('malformed', `This ZIP file is damaged ("${name}").`);
        const start = offset + 30 + buf.readUInt16LE(offset + 26) + buf.readUInt16LE(offset + 28);
        if (start + csize > buf.length) throw zipError('malformed', `This ZIP file is truncated ("${name}").`);
        const comp = buf.subarray(start, start + csize);
        let data;
        if (method === 0) data = Buffer.from(comp);
        else if (method === 8) {
          try {
            data = inflateRawSync(comp, { maxOutputLength: Math.max(1, usize) });
          } catch (e) {
            throw zipError('malformed', `This ZIP file is damaged ("${name}": ${e.message}).`);
          }
        } else throw zipError('unsupported', `"${name}" uses an unsupported ZIP compression method (${method}).`);
        if (data.length !== usize || (crc32(data) >>> 0) !== crc) throw zipError('malformed', `This ZIP file is damaged ("${name}" failed its checksum).`);
        return data;
      },
    };
    out.push(entry);
  }
  return out;
}
