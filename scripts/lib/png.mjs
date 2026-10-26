// Minimal PNG encoder/decoder for RGBA8 images (icons). Node built-ins only.

import { deflateSync, inflateSync } from 'node:zlib';
import { crc32 } from './crc32.mjs';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/**
 * Encode straight-alpha RGBA pixels as a PNG (colour type 6, 8-bit, filter 0 on every row).
 * @param {number} width
 * @param {number} height
 * @param {Uint8Array} rgba  width*height*4 bytes
 * @returns {Buffer}
 */
export function encodePng(width, height, rgba) {
  if (rgba.length !== width * height * 4) throw new Error('encodePng: pixel buffer size mismatch');
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

/**
 * Parse and verify a PNG produced by encodePng (CRC of every chunk is checked).
 * @param {Buffer} buf
 * @returns {{width: number, height: number, bitDepth: number, colorType: number, chunks: string[], pixels: Buffer}}
 */
export function decodePng(buf) {
  if (!buf.subarray(0, 8).equals(SIGNATURE)) throw new Error('not a PNG');
  let off = 8;
  const chunks = [];
  let ihdr = null;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    const crc = buf.readUInt32BE(off + 8 + len);
    if (crc !== crc32(buf.subarray(off + 4, off + 8 + len))) throw new Error(`bad CRC in ${type}`);
    chunks.push(type);
    if (type === 'IHDR') ihdr = data;
    if (type === 'IDAT') idat.push(data);
    off += 12 + len;
    if (type === 'IEND') break;
  }
  if (!ihdr) throw new Error('missing IHDR');
  const width = ihdr.readUInt32BE(0);
  const height = ihdr.readUInt32BE(4);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  if (raw.length !== (stride + 1) * height) throw new Error('unexpected image data size');
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    if (raw[y * (stride + 1)] !== 0) throw new Error('unsupported filter');
    raw.copy(pixels, y * stride, y * (stride + 1) + 1, (y + 1) * (stride + 1));
  }
  return { width, height, bitDepth: ihdr[8], colorType: ihdr[9], chunks, pixels };
}
