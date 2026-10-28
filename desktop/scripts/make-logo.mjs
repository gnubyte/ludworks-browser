#!/usr/bin/env node
// Ludworks Browser logo: the Ludworks indigo tile, with the Ludworks "drive bays" (two full bars and
// a short bar with a status light) drawn as the latitudes of a globe — your Ludworks, on the web.
//
// Rendered with pure math (16×16 supersampling per pixel) so every platform and CI run produces the
// same bytes. Writes:
//   src/assets/logo.svg                 vector logo for the browser UI and internal pages
//   src/assets/icons/icon-<n>.png       16 … 1024 px
//   build-res/icon.ico                  Windows (16–256, PNG-compressed entries)
//   build-res/icon.icns                 macOS
//
//   node desktop/scripts/make-logo.mjs          write everything
//   node desktop/scripts/make-logo.mjs --check  exit 1 when committed files differ from a fresh render

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodePng } from '../../scripts/lib/png.mjs';

const DESKTOP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PNG_SIZES = Object.freeze([16, 20, 24, 32, 40, 48, 64, 96, 128, 256, 512, 1024]);
export const ICO_SIZES = Object.freeze([16, 20, 24, 32, 40, 48, 64, 96, 128, 256]);
const SS = 16;

// ----------------------------------------------------------------------------- geometry (180 grid)
const C = 90;
const TOP_COLOR = [0x74, 0x73, 0xec];
const BOTTOM_COLOR = [0x42, 0x41, 0xbd];

/** Geometry per size class: small icons get bolder strokes and two bars. */
function geometry(size) {
  if (size <= 24) {
    return {
      margin: 0,
      radius: 40,
      ring: { r: 56, w: 22 },
      bars: [
        { y: 82, x0: 50, x1: 130, t: 19 },
        { y: 110, x0: 58, x1: 94, t: 19 },
      ],
      dot: { x: 114, y: 110, r: 10.5, a: 0.65 },
    };
  }
  if (size <= 48) {
    return {
      margin: size <= 32 ? 2 : 4,
      radius: 40,
      ring: { r: 54, w: 15 },
      bars: [
        { y: 70, x0: 60, x1: 120, t: 14 },
        { y: 92, x0: 50, x1: 130, t: 14 },
        { y: 114, x0: 60, x1: 94, t: 14 },
      ],
      dot: { x: 112, y: 114, r: 8, a: 0.65 },
      meridian: { rx: 21, ry: 54, w: 11, a: 0.3 },
    };
  }
  return {
    margin: 6,
    radius: 40,
    ring: { r: 53, w: 12 },
    bars: [
      { y: 69, x0: 60, x1: 120, t: 12 },
      { y: 90, x0: 51, x1: 129, t: 12 },
      { y: 111, x0: 60, x1: 95, t: 12 },
    ],
    dot: { x: 112, y: 111, r: 6.8, a: 0.62 },
    meridian: { rx: 21, ry: 53, w: 8, a: 0.34 },
  };
}

function inRoundRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

/** On the stroke of the axis-aligned ellipse centred in the tile (approximate distance). */
function onEllipse(x, y, m) {
  const dx = x - C;
  const dy = y - C;
  const k = Math.hypot(dx / m.rx, dy / m.ry);
  if (k === 0) return false;
  // distance to the ellipse along the ray, scaled by the local radius
  const rr = Math.hypot(dx, dy) / k;
  return Math.abs(Math.hypot(dx, dy) - rr) <= m.w / 2;
}

function inCapsule(x, y, b) {
  const r = b.t / 2;
  const cx = Math.min(Math.max(x, b.x0 + r), b.x1 - r);
  return (x - cx) ** 2 + (y - b.y) ** 2 <= r * r;
}

/**
 * Sample the logo at a point of the 180 grid (already mapped into the tile area).
 * @returns {[number, number, number, number]} straight-alpha RGBA 0..1
 */
function sample(x, y, g) {
  if (!inRoundRect(x, y, 0, 0, 180, 180, g.radius)) return [0, 0, 0, 0];
  // background: diagonal gradient + soft top-left light
  const t = Math.min(1, Math.max(0, (x + y) / 360));
  let r = TOP_COLOR[0] + (BOTTOM_COLOR[0] - TOP_COLOR[0]) * t;
  let gg = TOP_COLOR[1] + (BOTTOM_COLOR[1] - TOP_COLOR[1]) * t;
  let b = TOP_COLOR[2] + (BOTTOM_COLOR[2] - TOP_COLOR[2]) * t;
  const light = Math.max(0, 1 - Math.hypot(x - 40, y - 30) / 150) * 0.16;
  r += (255 - r) * light;
  gg += (255 - gg) * light;
  b += (255 - b) * light;
  const d = Math.hypot(x - C, y - C);
  const ring = Math.abs(d - g.ring.r) <= g.ring.w / 2;
  if (ring || g.bars.some((bar) => inCapsule(x, y, bar))) return [1, 1, 1, 1];
  if (g.meridian && onEllipse(x, y, g.meridian)) {
    const a = g.meridian.a;
    r += (255 - r) * a;
    gg += (255 - gg) * a;
    b += (255 - b) * a;
  }
  if ((x - g.dot.x) ** 2 + (y - g.dot.y) ** 2 <= g.dot.r ** 2) {
    const a = g.dot.a;
    return [(r / 255) * (1 - a) + a, (gg / 255) * (1 - a) + a, (b / 255) * (1 - a) + a, 1];
  }
  return [r / 255, gg / 255, b / 255, 1];
}

/**
 * @param {number} size
 * @returns {Uint8Array} straight-alpha RGBA
 */
export function renderLogo(size) {
  const g = geometry(size);
  const out = new Uint8Array(size * size * 4);
  const margin = (g.margin / 180) * size;
  const scale = 180 / (size - 2 * margin);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let R = 0;
      let G = 0;
      let B = 0;
      let A = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = (px + (sx + 0.5) / SS - margin) * scale;
          const y = (py + (sy + 0.5) / SS - margin) * scale;
          const [r, gg, b, a] = sample(x, y, g);
          R += r * a;
          G += gg * a;
          B += b * a;
          A += a;
        }
      }
      const n = SS * SS;
      const i = (py * size + px) * 4;
      const alpha = A / n;
      out[i + 3] = Math.round(alpha * 255);
      if (A > 0) {
        out[i] = Math.round((R / A) * 255);
        out[i + 1] = Math.round((G / A) * 255);
        out[i + 2] = Math.round((B / A) * 255);
      }
    }
  }
  return out;
}

export function logoSvg() {
  const g = geometry(512);
  const bars = g.bars.map((b) => `<rect x="${b.x0}" y="${b.y - b.t / 2}" width="${b.x1 - b.x0}" height="${b.t}" rx="${b.t / 2}" fill="#fff"/>`).join('');
  const hex = (c) => `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 180 180">' +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${hex(TOP_COLOR)}"/><stop offset="1" stop-color="${hex(BOTTOM_COLOR)}"/></linearGradient>` +
    '<radialGradient id="l" cx="40" cy="30" r="150" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#fff" stop-opacity="0.16"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient></defs>' +
    `<rect width="180" height="180" rx="${g.radius}" fill="url(#g)"/><rect width="180" height="180" rx="${g.radius}" fill="url(#l)"/>` +
    `<ellipse cx="90" cy="90" rx="${g.meridian.rx}" ry="${g.meridian.ry}" fill="none" stroke="#fff" stroke-opacity="${g.meridian.a}" stroke-width="${g.meridian.w}"/>` +
    `<circle cx="90" cy="90" r="${g.ring.r}" fill="none" stroke="#fff" stroke-width="${g.ring.w}"/>` +
    bars +
    `<circle cx="${g.dot.x}" cy="${g.dot.y}" r="${g.dot.r}" fill="#fff" fill-opacity="${g.dot.a}"/>` +
    '</svg>\n'
  );
}

// ------------------------------------------------------------------------------- containers
export function encodeIco(pngs) {
  const header = Buffer.alloc(6 + 16 * pngs.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngs.length, 4);
  let offset = header.length;
  pngs.forEach(({ size, data }, i) => {
    const e = 6 + 16 * i;
    header[e] = size >= 256 ? 0 : size;
    header[e + 1] = size >= 256 ? 0 : size;
    header[e + 2] = 0;
    header[e + 3] = 0;
    header.writeUInt16LE(1, e + 4);
    header.writeUInt16LE(32, e + 6);
    header.writeUInt32LE(data.length, e + 8);
    header.writeUInt32LE(offset, e + 12);
    offset += data.length;
  });
  return Buffer.concat([header, ...pngs.map((p) => p.data)]);
}

const ICNS_TYPES = [
  ['icp4', 16], ['icp5', 32], ['icp6', 64], ['ic07', 128], ['ic08', 256], ['ic09', 512], ['ic10', 1024],
  ['ic11', 32], ['ic12', 64], ['ic13', 256], ['ic14', 512],
];

export function encodeIcns(pngBySize) {
  const chunks = ICNS_TYPES.map(([type, size]) => {
    const data = pngBySize.get(size);
    const head = Buffer.alloc(8);
    head.write(type, 0, 'latin1');
    head.writeUInt32BE(8 + data.length, 4);
    return Buffer.concat([head, data]);
  });
  const body = Buffer.concat(chunks);
  const head = Buffer.alloc(8);
  head.write('icns', 0, 'latin1');
  head.writeUInt32BE(8 + body.length, 4);
  return Buffer.concat([head, body]);
}

export function buildAll() {
  const pngs = new Map(PNG_SIZES.map((s) => [s, encodePng(s, s, renderLogo(s))]));
  const files = new Map();
  files.set('src/assets/logo.svg', Buffer.from(logoSvg()));
  for (const [s, data] of pngs) files.set(`src/assets/icons/icon-${s}.png`, data);
  files.set('build-res/icon.ico', encodeIco(ICO_SIZES.map((s) => ({ size: s, data: pngs.get(s) }))));
  files.set('build-res/icon.icns', encodeIcns(pngs));
  return files;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes('--check');
  const files = buildAll();
  let bad = 0;
  for (const [rel, data] of files) {
    const p = path.join(DESKTOP, rel);
    if (check) {
      if (!existsSync(p) || !readFileSync(p).equals(data)) {
        console.error(`differs: ${rel}`);
        bad++;
      }
    } else {
      mkdirSync(path.dirname(p), { recursive: true });
      writeFileSync(p, data);
    }
  }
  if (check && bad) process.exit(1);
  console.log(check ? 'logo files up to date' : `wrote ${files.size} logo files`);
}
