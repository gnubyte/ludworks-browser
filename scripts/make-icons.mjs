#!/usr/bin/env node
// Renders the Ludworks Passwords logo (indigo shield with a white key) into RGBA pixels with 8x8
// supersampling and writes src/icons/icon-{16,32,48,128}.png. Pure math + node:zlib, fully deterministic.
//
//   node scripts/make-icons.mjs          write the icons
//   node scripts/make-icons.mjs --check  exit 1 if the committed icons differ from a fresh render

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { encodePng } from './lib/png.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const ICON_SIZES = Object.freeze([16, 32, 48, 128]);
const SS = 8; // supersampling factor per axis

// Geometry on a 24x24 grid (same shapes as the popup's SVG logo).
function cubic(p0, p1, p2, p3, steps) {
  const pts = [];
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const u = 1 - t;
    pts.push([
      u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
      u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1],
    ]);
  }
  return pts;
}

const SHIELD = (() => {
  const pts = [[12, 1.5], [21, 4.9], [21, 11.5]];
  pts.push(...cubic([21, 11.5], [21, 16.8], [17.2, 21.1], [12, 22.5], 48));
  pts.push(...cubic([12, 22.5], [6.8, 21.1], [3, 16.8], [3, 11.5], 48));
  pts.push([3, 4.9]);
  return pts;
})();

function inPolygon(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function distToSegment(x, y, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(x - (ax + t * dx), y - (ay + t * dy));
}

function inKey(x, y, stroke) {
  const half = stroke / 2;
  const r = Math.hypot(x - 12, y - 9.3);
  if (Math.abs(r - 3.1) <= half) return true; // bow (ring)
  if (distToSegment(x, y, 12, 12.4, 12, 18.2) <= half) return true; // shaft
  if (distToSegment(x, y, 12, 15.4, 14.4, 15.4) <= half) return true; // bit 1
  if (distToSegment(x, y, 12, 17.6, 13.8, 17.6) <= half) return true; // bit 2
  return false;
}

const TOP = [99, 102, 241]; // #6366f1
const BOTTOM = [67, 56, 202]; // #4338ca

/**
 * Render the logo as straight-alpha RGBA.
 * @param {number} size
 * @returns {Uint8Array}
 */
export function renderIcon(size) {
  const stroke = size <= 16 ? 2.7 : size <= 32 ? 2.3 : size <= 48 ? 2.0 : 1.8;
  const px = new Uint8Array(size * size * 4);
  const scale = 24 / size;
  for (let py = 0; py < size; py++) {
    for (let pxx = 0; pxx < size; pxx++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = (pxx + (sx + 0.5) / SS) * scale;
          const y = (py + (sy + 0.5) / SS) * scale;
          if (!inPolygon(x, y, SHIELD)) continue;
          a += 1;
          if (inKey(x, y, stroke)) {
            r += 255;
            g += 255;
            b += 255;
          } else {
            const t = Math.min(1, Math.max(0, (y - 1.5) / 21));
            r += TOP[0] + (BOTTOM[0] - TOP[0]) * t;
            g += TOP[1] + (BOTTOM[1] - TOP[1]) * t;
            b += TOP[2] + (BOTTOM[2] - TOP[2]) * t;
          }
        }
      }
      const i = (py * size + pxx) * 4;
      if (a > 0) {
        px[i] = Math.round(r / a);
        px[i + 1] = Math.round(g / a);
        px[i + 2] = Math.round(b / a);
        px[i + 3] = Math.round((a / (SS * SS)) * 255);
      }
    }
  }
  return px;
}

/** @returns {Map<number, Buffer>} size -> PNG bytes */
export function renderAll() {
  return new Map(ICON_SIZES.map((s) => [s, encodePng(s, s, renderIcon(s))]));
}

async function main() {
  const check = process.argv.includes('--check');
  const dir = path.join(ROOT, 'src', 'icons');
  await mkdir(dir, { recursive: true });
  let stale = 0;
  for (const [size, png] of renderAll()) {
    const file = path.join(dir, `icon-${size}.png`);
    if (check) {
      let current = null;
      try {
        current = await readFile(file);
      } catch {
        current = null;
      }
      if (!current || !current.equals(png)) {
        stale++;
        console.error(`stale: ${path.relative(ROOT, file)}`);
      }
    } else {
      await writeFile(file, png);
      console.log(`wrote ${path.relative(ROOT, file)} (${png.length} bytes)`);
    }
  }
  if (check && stale) {
    console.error('Icons are out of date; run: node scripts/make-icons.mjs');
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
