// Set-of-marks screenshots: draws a box and a "e12" ref label for each interactive element straight
// into the captured bitmap (BGRA, as Electron's nativeImage.toBitmap gives it), so the page itself is
// never touched. A 5×7 pixel font for the characters refs use. No Electron here (unit-tested).

const FONT = {
  0: ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  1: ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  2: ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  3: ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
  4: ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  5: ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  6: ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
  7: ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  8: ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  9: ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
  e: ['00000', '00000', '01110', '10001', '11111', '10000', '01110'],
};
// Strong colours that stay readable on light and dark pages (RGB).
const PALETTE = [
  [214, 51, 108],
  [28, 126, 214],
  [43, 138, 62],
  [232, 89, 12],
  [112, 72, 232],
  [12, 133, 153],
];

function put(buf, w, h, x, y, [r, g, b]) {
  if (x < 0 || y < 0 || x >= w || y >= h) return;
  const o = (y * w + x) * 4;
  buf[o] = b;
  buf[o + 1] = g;
  buf[o + 2] = r;
  buf[o + 3] = 255;
}

function fillRect(buf, w, h, x0, y0, rw, rh, color) {
  const x1 = Math.min(w, x0 + rw);
  const y1 = Math.min(h, y0 + rh);
  for (let y = Math.max(0, y0); y < y1; y++) for (let x = Math.max(0, x0); x < x1; x++) put(buf, w, h, x, y, color);
}

function strokeRect(buf, w, h, x, y, rw, rh, t, color) {
  fillRect(buf, w, h, x, y, rw, t, color);
  fillRect(buf, w, h, x, y + rh - t, rw, t, color);
  fillRect(buf, w, h, x, y, t, rh, color);
  fillRect(buf, w, h, x + rw - t, y, t, rh, color);
}

/** Size of a label in pixels at `scale`. */
export function labelSize(text, scale = 2) {
  return { width: text.length * 6 * scale + 2 * scale, height: 9 * scale };
}

function drawText(buf, w, h, x, y, text, scale, color) {
  let cx = x;
  for (const ch of text) {
    const g = FONT[ch];
    if (g) {
      for (let row = 0; row < 7; row++) {
        for (let col = 0; col < 5; col++) if (g[row][col] === '1') fillRect(buf, w, h, cx + col * scale, y + row * scale, scale, scale, color);
      }
    }
    cx += 6 * scale;
  }
}

/**
 * Draws marks into a BGRA bitmap in place.
 * @param {Buffer|Uint8Array} buf width*height*4 bytes, BGRA
 * @param {number} width
 * @param {number} height
 * @param {Array<{x: number, y: number, w: number, h: number, label: string}>} marks image-pixel boxes
 * @param {{scale?: number}} [o]
 * @returns {number} marks drawn
 */
export function drawMarks(buf, width, height, marks, { scale = 2 } = {}) {
  let drawn = 0;
  const placed = [];
  marks.forEach((m, i) => {
    const x = Math.round(m.x);
    const y = Math.round(m.y);
    const mw = Math.max(2, Math.round(m.w));
    const mh = Math.max(2, Math.round(m.h));
    if (x >= width || y >= height || x + mw <= 0 || y + mh <= 0) return;
    const color = PALETTE[i % PALETTE.length];
    strokeRect(buf, width, height, x, y, mw, mh, 2, color);
    const text = String(m.label).replace(/[^0-9e]/g, '');
    const ls = labelSize(text, scale);
    // label above the box's top-left corner, inside it when there is no room above; nudged down when it would cover one already placed
    let lx = Math.max(0, Math.min(x, width - ls.width));
    let ly = y - ls.height >= 0 ? y - ls.height : Math.max(0, y);
    for (let tries = 0; tries < 4 && placed.some((p) => lx < p.x + p.w && lx + ls.width > p.x && ly < p.y + p.h && ly + ls.height > p.y); tries++) ly = Math.min(height - ls.height, ly + ls.height);
    fillRect(buf, width, height, lx, ly, ls.width, ls.height, color);
    drawText(buf, width, height, lx + scale, ly + scale, text, scale, [255, 255, 255]);
    placed.push({ x: lx, y: ly, w: ls.width, h: ls.height });
    drawn++;
  });
  return drawn;
}
