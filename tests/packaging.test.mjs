import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createZip, readZip } from '../scripts/lib/zip.mjs';
import { encodePng, decodePng } from '../scripts/lib/png.mjs';
import { crc32 } from '../scripts/lib/crc32.mjs';
import { renderAll, renderIcon, ICON_SIZES } from '../scripts/make-icons.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const pythonOk = spawnSync('python3', ['-I', '-c', 'import zipfile'], { encoding: 'utf8' }).status === 0;

test('crc32 known values', () => {
  assert.equal(crc32(Buffer.from('')), 0);
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
  assert.equal(crc32(Buffer.from('The quick brown fox jumps over the lazy dog')), 0x414fa339);
  assert.equal(crc32(Buffer.from('6789'), crc32(Buffer.from('12345'))), 0xcbf43926, 'incremental');
});

test('zip writer: round trip, store vs deflate, UTF-8 names, deterministic', async (t) => {
  const random = Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 2654435761) >>> 24));
  const entries = [
    { name: 'b/readme.txt', data: Buffer.from('hello '.repeat(500)) },
    { name: 'a/empty.bin', data: Buffer.alloc(0) },
    { name: 'c/random.bin', data: random },
    { name: 'd/ünïcödé.json', data: Buffer.from('{"ok":true}') },
  ];
  const zip = createZip(entries);
  const back = readZip(zip);
  assert.deepEqual(back.map((e) => e.name), ['a/empty.bin', 'b/readme.txt', 'c/random.bin', 'd/ünïcödé.json']);
  for (const e of entries) assert.ok(back.find((b) => b.name === e.name).data.equals(e.data), e.name);
  assert.equal(back.find((b) => b.name === 'b/readme.txt').method, 8, 'compressible data is deflated');
  assert.equal(back.find((b) => b.name === 'a/empty.bin').method, 0, 'incompressible data is stored');
  assert.ok(createZip([...entries].reverse()).equals(zip), 'order-independent and timestamp-free -> reproducible');
  assert.ok(zip.length < 4096 + 3000 + 500, 'reasonable size');

  for (const bad of ['/abs', '../x', 'a/../b', 'a\\b', '', 'a//b']) {
    assert.throws(() => createZip([{ name: bad, data: Buffer.alloc(1) }]), /invalid entry name/, bad);
  }
  assert.throws(() => createZip([{ name: 'x', data: Buffer.alloc(1) }, { name: 'x', data: Buffer.alloc(1) }]), /duplicate/);

  if (!pythonOk) {
    t.diagnostic('python3 not available; skipped zipfile -t');
    return;
  }
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lw-zip-'));
  try {
    const file = path.join(dir, 't.zip');
    await writeFile(file, zip);
    const r = spawnSync('python3', ['-I', '-m', 'zipfile', '-t', file], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr || r.stdout);
    const l = spawnSync('python3', ['-I', '-m', 'zipfile', '-l', file], { encoding: 'utf8' });
    assert.match(l.stdout, /d\/ünïcödé\.json/);
    assert.match(l.stdout, /1980-01-01 00:00:00/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('PNG encoder output decodes and verifies', () => {
  const w = 3;
  const h = 2;
  const px = Uint8Array.from({ length: w * h * 4 }, (_, i) => (i * 37) & 0xff);
  const png = encodePng(w, h, px);
  const d = decodePng(png);
  assert.equal(d.width, 3);
  assert.equal(d.height, 2);
  assert.equal(d.bitDepth, 8);
  assert.equal(d.colorType, 6);
  assert.deepEqual(d.chunks, ['IHDR', 'IDAT', 'IEND']);
  assert.ok(d.pixels.equals(Buffer.from(px)));
  const broken = Buffer.from(png);
  broken[20] ^= 0xff;
  assert.throws(() => decodePng(broken), /CRC/);
  assert.throws(() => encodePng(2, 2, new Uint8Array(3)), /mismatch/);
});

test('icons: committed files equal a fresh deterministic render', async () => {
  const fresh = renderAll();
  for (const size of ICON_SIZES) {
    const file = await readFile(path.join(ROOT, 'src', 'icons', `icon-${size}.png`));
    assert.ok(file.equals(fresh.get(size)), `icon-${size}.png is stale (run node scripts/make-icons.mjs)`);
    const d = decodePng(file);
    assert.equal(d.width, size);
    assert.equal(d.height, size);
  }
  const px = renderIcon(128);
  const at = (x, y) => px.subarray((y * 128 + x) * 4, (y * 128 + x) * 4 + 4);
  assert.equal(at(0, 0)[3], 0, 'corners are transparent');
  assert.equal(at(127, 127)[3], 0);
  assert.equal(at(30, 60)[3], 255, 'shield body is opaque');
  assert.ok(at(30, 60)[2] > at(30, 60)[0], 'shield is blue/indigo');
  const key = at(64, 88);
  assert.deepEqual([...key], [255, 255, 255, 255], 'key shaft is white');
});
