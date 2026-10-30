// Image/video saver (src/main/media): file names, type sniffing, srcset picking, de-duplication,
// the per-tab counter, and what our own requests carry (cookies, Referer, Mark-of-the-Web).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { TYPES, typeFromMime, typeFromUrl, streamKind, parseSrcset, largestCandidate, cssUrls } from '../build/app/main/media/pick.js';
import { MediaCounter, mergeReports, cleanItem, isSmall, responseSize, MIN_COUNT_BYTES } from '../build/app/main/media/collect.js';
import {
  sanitizeFilename,
  nameForType,
  withIndex,
  fileNameFor,
  dispositionFilename,
  urlFilename,
  createExclusive,
  sniffType,
  imageSize,
  decodeDataUrl,
  zoneIdentifier,
  referrerFor,
  cookieHeaderFor,
  MAX_NAME,
} from '../build/app/main/media/files.js';

const bytes = (...parts) => Buffer.concat(parts.map((p) => (typeof p === 'string' ? Buffer.from(p, 'latin1') : Buffer.from(p))));
const pad = (b, n = 64) => Buffer.concat([b, Buffer.alloc(Math.max(0, n - b.length))]);

// ------------------------------------------------------------------------------------- names
test('media: file names lose separators, control and bidi characters, traversal', () => {
  assert.equal(sanitizeFilename('a/b\\c:d*e?f"g<h>i|j.jpg'), 'a_b_c_d_e_f_g_h_i_j.jpg');
  assert.equal(sanitizeFilename('../../etc/passwd'), '_.._etc_passwd');
  assert.equal(sanitizeFilename('..\\..\\Windows\\win.ini'), '_.._Windows_win.ini');
  assert.equal(sanitizeFilename('..'), 'image');
  assert.equal(sanitizeFilename('.hidden.png'), 'hidden.png');
  assert.equal(sanitizeFilename('tab\there\nnew\u0000line.png'), 'tabherenewline.png');
  assert.equal(sanitizeFilename('cat\u202Egnp.exe'), 'catgnp.exe'); // right-to-left override removed
  assert.equal(sanitizeFilename('zero\u200Bwidth.gif'), 'zerowidth.gif');
  assert.equal(sanitizeFilename('trailing. . .'), 'trailing');
  assert.equal(sanitizeFilename('  spaced   out  .png  '), 'spaced out .png');
  assert.equal(sanitizeFilename(''), 'image');
  assert.equal(sanitizeFilename('   ', { fallback: 'video' }), 'video');
});

test('media: Windows device names are never produced, with or without an extension', () => {
  for (const n of ['CON', 'con', 'PRN.jpg', 'aux.png', 'NUL.tar.gz', 'COM1.webp', 'com9', 'LPT1.gif', 'lpt9.jpeg', 'COM¹.jpg', 'CONIN$', 'conout$.png', 'con .jpg']) {
    const s = sanitizeFilename(n);
    assert.ok(s.startsWith('_'), `${n} → ${s}`);
  }
  for (const n of ['CONSOLE.jpg', 'icon.png', 'COM10.jpg', 'nullable.gif', 'auxiliary.png']) assert.equal(sanitizeFilename(n), n);
  assert.equal(nameForType('nul', 'png'), '_nul.png');
});

test('media: unicode names are kept (NFC) and long names are cut without splitting characters', () => {
  assert.equal(sanitizeFilename('e\u0301te\u0301.jpg'), 'été.jpg');
  assert.equal(sanitizeFilename('東京タワー.webp'), '東京タワー.webp');
  const long = `${'😀'.repeat(100)}.jpeg`;
  const s = sanitizeFilename(long);
  assert.ok(s.length <= MAX_NAME, String(s.length));
  assert.ok(s.endsWith('.jpeg'));
  assert.ok(!/[\ud800-\udbff](?![\udc00-\udfff])/.test(s), 'no lone high surrogate');
  assert.equal(sanitizeFilename(`${'x'.repeat(300)}.png`).length, MAX_NAME);
  assert.ok(nameForType('y'.repeat(500), 'webp').endsWith('.webp'));
  assert.ok(nameForType('y'.repeat(500), 'webp').length <= MAX_NAME);
});

test('media: the extension follows the real type', () => {
  assert.equal(nameForType('photo.jpg', 'webp'), 'photo.webp'); // CDN served WebP for a .jpg URL
  assert.equal(nameForType('photo.JPEG', 'jpeg'), 'photo.JPEG');
  assert.equal(nameForType('photo.jpg', 'jpeg'), 'photo.jpg');
  assert.equal(nameForType('image.php', 'png'), 'image.png');
  assert.equal(nameForType('render.aspx', 'gif'), 'render.gif');
  assert.equal(nameForType('photo-1500000000000', 'avif'), 'photo-1500000000000.avif');
  assert.equal(nameForType('clip.mp4', 'webm'), 'clip.webm');
  assert.equal(nameForType('archive.tar', 'png'), 'archive.tar.png');
  assert.equal(nameForType('evil.exe', 'gif'), 'evil.exe.gif');
  assert.equal(nameForType('evil.hta', 'svg'), 'evil.hta.svg');
  assert.equal(nameForType('.jpg', 'jpeg'), 'jpg.jpg');
});

test('media: names from Content-Disposition, the URL, or a fallback', () => {
  assert.equal(dispositionFilename('attachment; filename="a \\"b\\".png"'), 'a "b".png');
  assert.equal(dispositionFilename("inline; filename*=UTF-8''%E2%82%AC%20rates.jpg; filename=\"rates.jpg\""), '€ rates.jpg');
  assert.equal(dispositionFilename("attachment; filename*=iso-8859-1'en'%E9t%E9.gif"), 'été.gif');
  assert.equal(dispositionFilename('attachment; filename=plain.webp'), 'plain.webp');
  assert.equal(dispositionFilename('inline'), '');
  assert.equal(urlFilename('https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Foo_bar.jpg/440px-Foo_bar.jpg?x=1#y'), '440px-Foo_bar.jpg');
  assert.equal(urlFilename('https://example.com/%C3%A9t%C3%A9.png'), 'été.png');
  assert.equal(urlFilename('https://example.com/bad%E0%A4%A.png'), 'bad%E0%A4%A.png');
  assert.equal(urlFilename('data:image/png;base64,AAAA'), '');
  assert.equal(fileNameFor({ url: 'https://images.example/photo-123?w=1080&fm=jpg', type: 'jpeg' }), 'photo-123.jpg');
  assert.equal(fileNameFor({ url: 'https://x.test/dl?id=4', disposition: 'attachment; filename="../../evil.exe"', type: 'png' }), 'evil.exe.png');
  assert.equal(fileNameFor({ url: 'data:image/png;base64,AAAA', type: 'png' }), 'image.png');
  assert.equal(fileNameFor({ url: 'data:video/webm;base64,AAAA', type: 'webm' }), 'video.webm');
  assert.equal(fileNameFor({ url: 'blob:https://x.test/0f8e0d6a-9c55-4d43-8f32-1f9c3c0e8f11', type: 'gif', fallback: 'A cat' }), 'A cat.gif');
  assert.equal(fileNameFor({ url: 'https://x.test/', type: 'webp' }), 'image.webp');
});

test('media: never overwrite, never write outside the folder', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'lwb-media-'));
  try {
    assert.equal(withIndex('a.jpg', 1), 'a.jpg');
    assert.equal(withIndex('a.jpg', 2), 'a (2).jpg');
    assert.equal(withIndex('noext', 3), 'noext (3)');
    const one = await createExclusive(dir, 'a.jpg');
    await one.fh.close();
    const two = await createExclusive(dir, 'a.jpg');
    await two.fh.close();
    assert.equal(two.name, 'a (2).jpg');
    // concurrent saves of the same name each get their own file
    const many = await Promise.all(Array.from({ length: 6 }, () => createExclusive(dir, 'same.png')));
    await Promise.all(many.map((m) => m.fh.close()));
    assert.equal(new Set(many.map((m) => m.name)).size, 6);
    assert.deepEqual(readdirSync(dir).filter((n) => n.startsWith('same')).sort(), ['same (2).png', 'same (3).png', 'same (4).png', 'same (5).png', 'same (6).png', 'same.png']);
    for (const bad of ['../x.jpg', '..\\x.jpg', 'sub/x.jpg', '/abs.jpg']) await assert.rejects(() => createExclusive(dir, bad), /unsafe file name/, bad);
    assert.ok(!existsSync(path.join(dir, '..', 'x.jpg')));
    // a very deep folder keeps the whole path short enough
    const deep = await createExclusive(dir, `${'z'.repeat(119)}.png`);
    await deep.fh.close();
    assert.ok(deep.file.length <= 260, String(deep.file.length));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------- sniffing
test('media: magic bytes', () => {
  assert.equal(sniffType(pad(bytes([0xff, 0xd8, 0xff, 0xe0]))), 'jpeg');
  assert.equal(sniffType(pad(bytes('\x89PNG\r\n\x1a\n'))), 'png');
  assert.equal(sniffType(pad(bytes('GIF89a'))), 'gif');
  assert.equal(sniffType(pad(bytes('GIF87a'))), 'gif');
  assert.equal(sniffType(pad(bytes('RIFF', [0x10, 0, 0, 0], 'WEBPVP8 '))), 'webp');
  assert.equal(sniffType(pad(bytes('RIFF', [0x10, 0, 0, 0], 'WAVEfmt '))), ''); // audio
  assert.equal(sniffType(pad(bytes([0, 0, 0, 0x1c], 'ftypavif', [0, 0, 0, 0], 'avifmif1miaf'))), 'avif');
  assert.equal(sniffType(pad(bytes([0, 0, 0, 0x1c], 'ftypmif1', [0, 0, 0, 0], 'mif1avifmiaf'))), 'avif');
  assert.equal(sniffType(pad(bytes([0, 0, 0, 0x18], 'ftypheic', [0, 0, 0, 0], 'mif1heic'))), ''); // HEIC: not handled
  assert.equal(sniffType(pad(bytes([0, 0, 0, 0x20], 'ftypisom', [0, 0, 2, 0], 'isomiso2avc1mp41'))), 'mp4');
  assert.equal(sniffType(pad(bytes([0, 0, 0, 0x14], 'ftypqt  ', [0, 0, 0, 0], 'qt  '))), 'mov');
  assert.equal(sniffType(pad(bytes([0, 0, 0, 0x18], 'ftypM4A ', [0, 0, 0, 0], 'M4A '))), ''); // audio
  assert.equal(sniffType(pad(bytes([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0x82, 0x84], 'webm'))), 'webm');
  assert.equal(sniffType(pad(bytes([0x1a, 0x45, 0xdf, 0xa3, 0xa3, 0x42, 0x82, 0x88], 'matroska'))), 'mkv');
  assert.equal(sniffType(pad(bytes('OggS', [0, 2]))), 'ogv');
  const bmp = Buffer.alloc(64);
  bmp.write('BM', 0, 'latin1');
  bmp[14] = 40;
  assert.equal(sniffType(bmp), 'bmp');
  assert.equal(sniffType(pad(bytes('BMW is not a bitmap'))), '');
  assert.equal(sniffType(pad(bytes([0, 0, 1, 0, 1, 0, 16, 16]))), 'ico');
  assert.equal(sniffType(pad(bytes([0xff, 0x0a]))), 'jxl');
  assert.equal(sniffType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>')), 'svg');
  assert.equal(sniffType(Buffer.from('\ufeff<?xml version="1.0"?>\n<!-- made by hand -->\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "x.dtd" [<!ENTITY a "b">]>\n<svg:svg xmlns:svg="http://www.w3.org/2000/svg"></svg:svg>')), 'svg');
  assert.equal(sniffType(Buffer.from('<!doctype html><html><body><svg></svg></body></html>')), '');
  assert.equal(sniffType(Buffer.from('<html><head><title>403 Forbidden</title></head></html>')), '');
  assert.equal(sniffType(Buffer.from('{"error":"not found"}')), '');
  assert.equal(sniffType(Buffer.alloc(2)), '');
});

test('media: picture sizes from header bytes (formats the browser process cannot decode too)', () => {
  const png = Buffer.alloc(33);
  png.write('\x89PNG\r\n\x1a\n', 0, 'latin1');
  png.writeUInt32BE(13, 8);
  png.write('IHDR', 12, 'latin1');
  png.writeUInt32BE(640, 16);
  png.writeUInt32BE(480, 20);
  assert.deepEqual(imageSize(png, 'png'), { w: 640, h: 480 });
  assert.deepEqual(imageSize(pad(bytes('GIF89a', [0x40, 0x01, 0xf0, 0x00])), 'gif'), { w: 320, h: 240 });
  const jpg = bytes([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10], Buffer.alloc(14), [0xff, 0xc4, 0x00, 0x04, 0, 0], [0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0x58, 0x03, 0x20, 0x03], Buffer.alloc(16));
  assert.deepEqual(imageSize(jpg, 'jpeg'), { w: 800, h: 600 });
  const riff = (chunk) => {
    const b = Buffer.alloc(30);
    b.write('RIFF', 0, 'latin1');
    b.write('WEBP', 8, 'latin1');
    b.write(chunk, 12, 'latin1');
    return b;
  };
  const vp8x = riff('VP8X');
  vp8x.writeUIntLE(1919, 24, 3);
  vp8x.writeUIntLE(1079, 27, 3);
  assert.deepEqual(imageSize(vp8x, 'webp'), { w: 1920, h: 1080 });
  const vp8 = riff('VP8 ');
  vp8.writeUInt16LE(550, 26);
  vp8.writeUInt16LE(368, 28);
  assert.deepEqual(imageSize(vp8, 'webp'), { w: 550, h: 368 });
  const vp8l = riff('VP8L');
  vp8l[20] = 0x2f;
  vp8l.writeUInt32LE((100 - 1) | ((50 - 1) << 14), 21);
  assert.deepEqual(imageSize(vp8l, 'webp'), { w: 100, h: 50 });
  const avif = bytes([0, 0, 0, 0x1c], 'ftypavif', Buffer.alloc(16), [0, 0, 0, 0x14], 'ispe', [0, 0, 0, 0], [0, 0, 0x0f, 0], [0, 0, 0x08, 0x70]);
  assert.deepEqual(imageSize(avif, 'avif'), { w: 3840, h: 2160 });
  const bmp = Buffer.alloc(54);
  bmp.write('BM', 0, 'latin1');
  bmp.writeUInt32LE(40, 14);
  bmp.writeInt32LE(256, 18);
  bmp.writeInt32LE(-128, 22); // top-down
  assert.deepEqual(imageSize(bmp, 'bmp'), { w: 256, h: 128 });
  assert.deepEqual(imageSize(pad(bytes([0, 0, 1, 0, 1, 0, 0, 0])), 'ico'), { w: 256, h: 256 });
  assert.deepEqual(imageSize(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80px"></svg>'), 'svg'), { w: 120, h: 80 });
  assert.deepEqual(imageSize(Buffer.from('<?xml version="1.0"?><svg viewBox="0 0 512 256"/>'), 'svg'), { w: 512, h: 256 });
  assert.deepEqual(imageSize(Buffer.from('<svg width="100%" height="100%" viewBox="0, 0, 30, 10"/>'), 'svg'), { w: 30, h: 10 });
  assert.deepEqual(imageSize(Buffer.from('<svg width="60" viewBox="0 0 30 10"/>'), 'svg'), { w: 60, h: 20 });
  assert.equal(imageSize(Buffer.from('<svg width="10em" height="2em"/>'), 'svg'), null);
  assert.equal(imageSize(pad(bytes('GIF89a', [0, 0, 0, 0])), 'gif'), null);
  assert.equal(imageSize(pad(bytes('OggS')), 'ogv'), null);
  assert.equal(imageSize(Buffer.alloc(3), 'png'), null);
});

test('media: data: URLs decode (base64 and percent-encoded), with a size cap', () => {
  const png = decodeDataUrl('data:image/png;base64,iVBORw0KGgo=');
  assert.equal(png.mime, 'image/png');
  assert.equal(sniffType(pad(png.bytes)), 'png');
  const svg = decodeDataUrl("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'%3E%3Ctext%3E€%3C/text%3E%3C/svg%3E");
  assert.equal(svg.mime, 'image/svg+xml');
  assert.match(svg.bytes.toString('utf8'), /^<svg xmlns='http:\/\/www.w3.org\/2000\/svg'><text>€<\/text><\/svg>$/);
  assert.equal(sniffType(svg.bytes), 'svg');
  assert.deepEqual(decodeDataUrl('data:image/png;base64,AAAAAAAA', 4), { error: 'too-large' });
  assert.equal(decodeDataUrl('data:image/png;base64'), null);
  assert.equal(decodeDataUrl('https://x.test/a.png'), null);
});

// ---------------------------------------------------------------------------- srcset, types
test('media: srcset parsing and the largest candidate', () => {
  const set = parseSrcset('https://res.cloudinary.com/x/image/upload/w_300,h_200,c_fill/a.jpg 300w, https://res.cloudinary.com/x/image/upload/w_1200,h_800,c_fill/a.jpg 1200w,https://res.cloudinary.com/x/image/upload/w_600,h_400,c_fill/a.jpg 600w');
  assert.equal(set.length, 3);
  assert.equal(set[0].url, 'https://res.cloudinary.com/x/image/upload/w_300,h_200,c_fill/a.jpg');
  assert.equal(largestCandidate(set).url, 'https://res.cloudinary.com/x/image/upload/w_1200,h_800,c_fill/a.jpg');
  assert.equal(largestCandidate(set).w, 1200);
  const dens = parseSrcset('/a/330px-Foo.jpg 1.5x, /a/440px-Foo.jpg 2x, /a/220px-Foo.jpg');
  assert.deepEqual(dens.map((c) => c.x), [1.5, 2, 1]);
  assert.equal(largestCandidate(dens).url, '/a/440px-Foo.jpg');
  // w beats x descriptors; junk descriptors drop that candidate; trailing commas end a URL
  assert.equal(largestCandidate(parseSrcset('a.jpg 3x, b.jpg 800w')).url, 'b.jpg');
  assert.deepEqual(parseSrcset('a.jpg 100q, b.jpg 2x').map((c) => c.url), ['b.jpg']);
  assert.deepEqual(parseSrcset('a.jpg,, b.jpg 2x').map((c) => c.url), ['a.jpg', 'b.jpg']);
  assert.deepEqual(parseSrcset(''), []);
  assert.equal(largestCandidate([]), null);
});

test('media: types from URLs, MIME types, CSS values; streaming manifests', () => {
  assert.equal(typeFromUrl('https://x.test/a/b.JPG?w=2'), 'jpeg');
  assert.equal(typeFromUrl('https://x.test/clip.webm#t=3'), 'webm');
  assert.equal(typeFromUrl('https://x.test/clip.m4v'), 'mp4');
  assert.equal(typeFromUrl('https://x.test/page.html'), '');
  assert.equal(typeFromUrl('https://x.test/img?format=png'), '');
  assert.equal(typeFromUrl('data:image/svg+xml;utf8,<svg/>'), 'svg');
  assert.equal(typeFromMime('image/jpeg; charset=binary'), 'jpeg');
  assert.equal(typeFromMime('IMAGE/PJPEG'), 'jpeg');
  assert.equal(typeFromMime('image/vnd.microsoft.icon'), 'ico');
  assert.equal(typeFromMime('text/html'), '');
  assert.equal(streamKind('https://x.test/master.m3u8?token=1'), 'hls');
  assert.equal(streamKind('https://x.test/manifest.mpd'), 'dash');
  assert.equal(streamKind('https://x.test/v', 'application/vnd.apple.mpegurl'), 'hls');
  assert.equal(streamKind('https://x.test/v.mp4'), '');
  assert.deepEqual(cssUrls('url("https://x.test/a.png"), linear-gradient(red, blue), url(b.jpg), url(\'c d.webp\')'), ['https://x.test/a.png', 'b.jpg', 'c d.webp']);
  assert.deepEqual(cssUrls('image-set(url("a.png") 1x, url("a@2x.png") 2x)'), ['a.png', 'a@2x.png']);
  assert.deepEqual(cssUrls('none'), []);
  for (const t of Object.values(TYPES)) assert.ok(t.exts.includes(t.ext), t.label);
});

// ----------------------------------------------------------------------------------- counter
const resp = (url, type, size, { status = 200, resourceType = 'image', range = null } = {}) => ({
  url,
  resourceType,
  statusCode: status,
  responseHeaders: { 'Content-Type': [type], ...(size !== null ? { 'Content-Length': [String(size)] } : {}), ...(range ? { 'content-range': [range] } : {}) },
});

test('media: the per-tab counter counts real pictures and videos once', () => {
  const c = new MediaCounter();
  c.reset(7, 'https://news.test/a#top');
  assert.equal(c.note(7, resp('https://cdn.test/1.jpg', 'image/jpeg', 50000)), true);
  assert.equal(c.note(7, resp('https://cdn.test/1.jpg#again', 'image/jpeg', 50000)), false); // same file
  assert.equal(c.note(7, resp('https://cdn.test/pixel.gif', 'image/gif', 43)), false); // tracking pixel
  assert.equal(c.note(7, resp('https://cdn.test/icon.svg', 'image/svg+xml', 900)), false); // tiny icon
  assert.equal(c.note(7, resp('https://cdn.test/fav.ico', 'image/x-icon', 9000)), false); // favicons are not pictures
  assert.equal(c.note(7, resp('https://cdn.test/2.webp', 'image/webp', null)), true); // size unknown (chunked)
  assert.equal(c.note(7, resp('https://cdn.test/3.avif', 'image/avif', MIN_COUNT_BYTES)), true);
  assert.equal(c.note(7, resp('https://cdn.test/404.png', 'image/png', 9000, { status: 404 })), false);
  assert.equal(c.note(7, resp('https://cdn.test/page', 'text/html', 9000)), false);
  assert.equal(c.note(7, resp('https://cdn.test/script.js', 'text/javascript', 9000, { resourceType: 'script' })), false);
  assert.equal(c.note(7, resp('https://cdn.test/clip.webm', 'video/webm', 1024, { status: 206, resourceType: 'media', range: 'bytes 0-1023/7340032' })), true);
  assert.equal(c.note(7, resp('https://cdn.test/clip.webm', 'video/webm', 1024, { status: 206, resourceType: 'media', range: 'bytes 1024-2047/7340032' })), false);
  assert.equal(c.note(7, resp('https://cdn.test/raw.mp4', 'application/octet-stream', 5e6, { resourceType: 'media' })), true); // type from the URL
  assert.equal(c.note(7, resp('data:image/png;base64,AAAA', 'image/png', 9000)), false);
  assert.equal(c.count(7), 5);
  assert.equal(c.count(7, 'https://news.test/a'), 5);
  const e = c.entries(7).find((x) => x.url === 'https://cdn.test/clip.webm');
  assert.equal(e.bytes, 7340032);
  assert.equal(responseSize(206, { 'Content-Range': ['bytes 0-0/99'] }), 99);
  assert.equal(responseSize(200, {}), null);
  // other tabs are separate; a new page starts from zero
  assert.equal(c.count(8), 0);
  c.reset(7, 'https://news.test/b');
  assert.equal(c.count(7), 0);
  c.note(7, resp('https://cdn.test/9.png', 'image/png', 9000));
  assert.equal(c.count(7, 'https://news.test/b'), 1);
  // a navigation that turned into a download never committed: the page still shown keeps its count
  c.reset(7, 'https://files.test/big.zip');
  assert.equal(c.count(7, 'https://news.test/b'), 1);
  assert.equal(c.count(7, 'https://files.test/big.zip'), 0);
  c.drop(7);
  assert.equal(c.count(7), 0);
  // an image or video opened as the page itself counts; pages and script fetches do not
  c.reset(9, 'https://img.test/photo.jpg');
  assert.equal(c.note(9, resp('https://img.test/photo.jpg', 'image/jpeg', 90000, { resourceType: 'mainFrame' })), true);
  assert.equal(c.note(9, resp('https://img.test/page', 'text/html', 90000, { resourceType: 'mainFrame' })), false);
  assert.equal(c.note(9, resp('https://img.test/x.png', 'image/png', 90000, { resourceType: 'xhr' })), false);
  assert.equal(c.count(9), 1);
});

// -------------------------------------------------------------------------- merge + dedupe
test('media: frame reports merge into one list without duplicates', () => {
  const main = {
    frame: { processId: 1, routingId: 1 },
    items: [
      { url: 'https://up.test/440px-Foo.jpg', kind: 'img', w: 440, h: 300, dw: 220, dh: 150, thumb: 'https://up.test/220px-Foo.jpg', aka: ['https://up.test/220px-Foo.jpg', 'https://up.test/330px-Foo.jpg'], alt: 'Foo' },
      { url: 'https://up.test/440px-Foo.jpg#x', kind: 'link' }, // same file, other element
      { url: 'https://cdn.test/hero.webp', kind: 'bg', dw: 900, dh: 300 },
      { url: 'blob:https://page.test/0f8e0d6a-9c55-4d43-8f32-1f9c3c0e8f11', kind: 'video', reason: 'mse', dw: 640, dh: 360 },
      { url: 'blob:https://page.test/1f8e0d6a-9c55-4d43-8f32-1f9c3c0e8f11', kind: 'img', w: 64, h: 64 },
      { url: 'https://cdn.test/live/master.m3u8', kind: 'video' },
      { url: 'stream:abc1', kind: 'video', reason: 'live' },
      { url: 'stream:abc2', kind: 'video' }, // a placeholder without a reason is dropped
      { url: 'javascript:alert(1)', kind: 'img' },
      { url: 'file:///C:/Windows/win.ini', kind: 'link' },
      { url: 'ludworks://settings/', kind: 'img' },
      { url: 'data:image/png;base64,iVBORw0KGgo=', kind: 'img', w: 1, h: 1 },
      { url: 'data:text/html,<script>', kind: 'img' },
      { url: `https://x.test/${'a'.repeat(9000)}.png`, kind: 'img' },
      'garbage',
      null,
    ],
  };
  const sub = { frame: { processId: 2, routingId: 5 }, items: [{ url: 'https://up.test/440px-Foo.jpg', kind: 'img', w: 880, h: 600 }, { url: 'https://ads.test/banner.png', kind: 'img', w: 728, h: 90, type: 'nonsense' }] };
  const network = [
    { url: 'https://up.test/220px-Foo.jpg', type: 'jpeg', bytes: 12000, countable: true }, // the displayed size of Foo
    { url: 'https://cdn.test/hero.webp', type: 'avif', bytes: 80000, countable: true }, // negotiated format
    { url: 'https://cdn.test/sprite.png', type: 'png', bytes: 30000, countable: true }, // only the network saw it
    { url: 'https://cdn.test/pixel.gif', type: 'gif', bytes: 43, countable: false },
  ];
  const items = mergeReports([main, sub], network);
  const urls = items.map((i) => i.url);
  assert.deepEqual(urls, [
    'https://up.test/440px-Foo.jpg',
    'https://cdn.test/hero.webp',
    'blob:https://page.test/0f8e0d6a-9c55-4d43-8f32-1f9c3c0e8f11',
    'blob:https://page.test/1f8e0d6a-9c55-4d43-8f32-1f9c3c0e8f11',
    'https://cdn.test/live/master.m3u8',
    'stream:abc1',
    'data:image/png;base64,iVBORw0KGgo=',
    'https://ads.test/banner.png',
    'https://cdn.test/sprite.png',
  ]);
  assert.deepEqual(items.map((i) => i.id), items.map((_x, i) => `m${i}`));
  const foo = items[0];
  assert.deepEqual(foo.kinds, ['img', 'link']);
  assert.equal(foo.w, 880); // the larger natural size wins
  assert.equal(foo.type, 'jpeg');
  assert.equal(foo.alt, 'Foo');
  assert.equal(items[1].type, 'avif'); // what the server sent beats the extension
  assert.equal(items[1].bytes, 80000);
  assert.equal(items[2].reason, 'mse');
  assert.deepEqual(items[3].frame, { processId: 1, routingId: 1 }); // blob: is read by its frame
  assert.equal(items[0].frame, null);
  assert.equal(items[4].reason, 'hls');
  assert.equal(items[5].reason, 'live');
  assert.equal(items[7].type, 'png');
  assert.deepEqual(items[8].kinds, ['net']);
  assert.equal(mergeReports([main], [], { max: 2 }).length, 2);
  assert.equal(cleanItem({ url: 'https://x.test/a.png', w: -5, h: 1e12, alt: 7, kind: 'evil' }).w, 0);
  assert.equal(cleanItem({ url: 'https://x.test/a.png', w: -5, h: 1e12, alt: 7, kind: 'evil' }).h, 1e6);
  assert.deepEqual(cleanItem({ url: 'https://x.test/a.png', kind: 'evil' }).kinds, ['img']);
});

test('media: WebP/AVIF a CDN negotiated for a .jpg/.png address keeps the address type (the saver asks for it)', () => {
  const items = mergeReports(
    [{ frame: null, items: [{ url: 'https://up.test/a.jpg', kind: 'img' }, { url: 'https://cdn.test/photo-1?w=800', kind: 'img' }, { url: 'https://cdn.test/b.png', kind: 'img' }, { url: 'https://cdn.test/c.webp', kind: 'img' }] }],
    [
      { url: 'https://up.test/a.jpg', type: 'webp', bytes: 1000, countable: true },
      { url: 'https://cdn.test/photo-1?w=800', type: 'avif', bytes: 1000, countable: true },
      { url: 'https://cdn.test/b.png', type: 'jpeg', bytes: 1000, countable: true },
      { url: 'https://cdn.test/c.webp', type: 'avif', bytes: 1000, countable: true },
    ],
  );
  assert.deepEqual(items.map((i) => i.type), ['jpeg', 'avif', 'jpeg', 'avif']);
});

test('media: small pictures are recognised when their size is known', () => {
  assert.equal(isSmall({ w: 16, h: 16 }), true);
  assert.equal(isSmall({ w: 47, h: 20 }), true);
  assert.equal(isSmall({ w: 48, h: 10 }), false);
  assert.equal(isSmall({ w: 0, h: 0, dw: 24, dh: 24 }), true);
  assert.equal(isSmall({ w: 0, h: 0, dw: 0, dh: 0 }), false); // unknown: shown
});

// --------------------------------------------------------------- what our requests carry
test('media: Referer like a page subresource (strict-origin-when-cross-origin)', () => {
  assert.equal(referrerFor('https://site.test/a/b?q=1#frag', 'https://site.test/img.png'), 'https://site.test/a/b?q=1');
  assert.equal(referrerFor('https://user:pw@site.test/a', 'https://site.test/img.png'), 'https://site.test/a');
  assert.equal(referrerFor('https://site.test/a/b', 'https://cdn.test/img.png'), 'https://site.test/');
  assert.equal(referrerFor('https://site.test/a/b', 'http://cdn.test/img.png'), '');
  assert.equal(referrerFor('http://site.test/a', 'https://cdn.test/img.png'), 'http://site.test/');
  assert.equal(referrerFor('ludworks://settings/', 'https://cdn.test/img.png'), '');
});

test('media: cookies like a page subresource (no Lax/Strict cookies cross-site)', () => {
  const now = Date.UTC(2026, 9, 28);
  const jar = [
    { name: 'strict', value: '1', domain: 'img.site.test', hostOnly: true, path: '/', secure: true, sameSite: 'strict' },
    { name: 'lax', value: '2', domain: '.site.test', hostOnly: false, path: '/', secure: false, sameSite: 'lax' },
    { name: 'dflt', value: '3', domain: '.site.test', hostOnly: false, path: '/', secure: false, sameSite: 'unspecified' },
    { name: 'none', value: '4', domain: '.site.test', hostOnly: false, path: '/', secure: true, sameSite: 'no_restriction' },
    { name: 'deep', value: '5', domain: '.site.test', hostOnly: false, path: '/photos', secure: false, sameSite: 'no_restriction' },
    { name: 'other', value: '6', domain: 'www.site.test', hostOnly: true, path: '/', secure: false, sameSite: 'no_restriction' },
    { name: 'old', value: '7', domain: '.site.test', hostOnly: false, path: '/', secure: false, sameSite: 'no_restriction', expirationDate: now / 1000 - 10 },
    { name: 'pathy', value: '8', domain: '.site.test', hostOnly: false, path: '/photo', secure: false, sameSite: 'no_restriction' },
  ];
  const url = 'https://img.site.test/photos/1.jpg';
  assert.equal(cookieHeaderFor(jar, url, { pageSite: 'site.test', urlSite: 'site.test', now }), 'deep=5; strict=1; lax=2; dflt=3; none=4');
  assert.equal(cookieHeaderFor(jar, url, { pageSite: 'evil.test', urlSite: 'site.test', now }), 'deep=5; none=4');
  assert.equal(cookieHeaderFor(jar, url, { pageSite: 'evil.test', urlSite: 'site.test', blockThirdParty: true, now }), '');
  assert.equal(cookieHeaderFor(jar, 'http://img.site.test/x.jpg', { pageSite: 'site.test', urlSite: 'site.test', now }), 'lax=2; dflt=3'); // no Secure cookies over http
  assert.equal(cookieHeaderFor(jar, url, { pageSite: '', urlSite: 'site.test', now }), 'deep=5; none=4'); // no page site: cross-site rules
  assert.equal(cookieHeaderFor([], url, { pageSite: 'site.test', urlSite: 'site.test' }), '');
});

test('media: Mark-of-the-Web contents', () => {
  assert.equal(zoneIdentifier({ hostUrl: 'https://u:p@cdn.test/a.jpg#x', referrerUrl: 'https://site.test/page' }), '[ZoneTransfer]\r\nZoneId=3\r\nReferrerUrl=https://site.test/page\r\nHostUrl=https://cdn.test/a.jpg\r\n');
  assert.equal(zoneIdentifier({ hostUrl: 'https://cdn.test/a.jpg', referrerUrl: 'https://site.test/page', isPrivate: true }), '[ZoneTransfer]\r\nZoneId=3\r\nHostUrl=about:internet\r\n');
  assert.equal(zoneIdentifier({ hostUrl: 'data:image/png;base64,AAAA', referrerUrl: 'https://site.test/' }), '[ZoneTransfer]\r\nZoneId=3\r\nHostUrl=about:internet\r\n');
});
