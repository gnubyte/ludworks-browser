// Chrome themes (src/main/themes/chrome-theme.js): colours, tints, images and new-tab properties.
import test from 'node:test';
import assert from 'node:assert/strict';
import { isThemeManifest, parseColor, parseTint, applyTint, luminance, safeImagePath, themePalette } from '../build/app/main/themes/chrome-theme.js';

test('chrome theme: only manifests that are themes and nothing else', () => {
  assert.ok(isThemeManifest({ manifest_version: 3, name: 'T', version: '1', theme: { colors: {} } }));
  assert.ok(!isThemeManifest({ theme: {}, background: { service_worker: 'x.js' } }));
  assert.ok(!isThemeManifest({ theme: {}, content_scripts: [] }));
  assert.ok(!isThemeManifest({ name: 'ext' }));
});

test('chrome theme: colours and tints are checked', () => {
  assert.deepEqual(parseColor([10, 20, 30]), { r: 10, g: 20, b: 30, a: 1 });
  assert.deepEqual(parseColor([10, 20, 30, 0.5]), { r: 10, g: 20, b: 30, a: 0.5 });
  assert.equal(parseColor([10, 20, 30, 255]).a, 1);
  assert.equal(parseColor([300, 0, 0]), null);
  assert.equal(parseColor('#fff'), null);
  assert.equal(parseColor([1, 2]), null);
  assert.deepEqual(parseTint([-1, 0.5, 0.2]), [-1, 0.5, 0.2]);
  assert.equal(parseTint([2, 0, 0]), null);
  // keep everything / lightness 0 = black / 1 = white / hue replaced
  assert.deepEqual(applyTint({ r: 100, g: 150, b: 200, a: 1 }, [-1, -1, -1]), { r: 100, g: 150, b: 200, a: 1 });
  assert.deepEqual(applyTint({ r: 100, g: 150, b: 200, a: 1 }, [-1, -1, 0]), { r: 0, g: 0, b: 0, a: 1 });
  assert.deepEqual(applyTint({ r: 100, g: 150, b: 200, a: 1 }, [-1, -1, 1]), { r: 255, g: 255, b: 255, a: 1 });
  const red = applyTint({ r: 100, g: 150, b: 200, a: 1 }, [0, -1, -1]);
  assert.ok(red.r > red.g && red.r > red.b);
  assert.ok(luminance({ r: 0, g: 0, b: 0 }) === 0 && luminance({ r: 255, g: 255, b: 255 }) === 1);
});

test('chrome theme: image paths stay inside the package', () => {
  assert.equal(safeImagePath('images/theme_frame.png'), 'images/theme_frame.png');
  assert.equal(safeImagePath('./a.JPG'), 'a.JPG');
  assert.equal(safeImagePath('a\\b.png'), 'a/b.png');
  for (const bad of ['../x.png', '/etc/x.png', 'C:/x.png', 'a//b.png', 'x.svg', 'x.js', '', null, 5]) assert.equal(safeImagePath(bad), null, String(bad));
});

test('chrome theme: a dark theme with images', () => {
  const p = themePalette({
    name: 'Night',
    theme: {
      images: { theme_frame: 'images/frame.png', theme_toolbar: 'images/toolbar.png', theme_ntp_background: 'images/ntp.jpg', theme_ntp_attribution: '../bad.png' },
      colors: { frame: [20, 20, 40], toolbar: [40, 40, 70], tab_text: [255, 255, 255], tab_background_text: [180, 180, 200], bookmark_text: [230, 230, 250], ntp_background: [0, 0, 0], ntp_text: [240, 240, 240] },
      tints: { buttons: [-1, -1, 0.9] },
      properties: { ntp_background_alignment: 'bottom left', ntp_background_repeat: 'repeat-x' },
    },
  });
  assert.equal(p.name, 'Night');
  assert.equal(p.base, 'dark');
  assert.equal(p.vars['--frame'], 'rgb(20, 20, 40)');
  assert.equal(p.vars['--toolbar'], 'rgb(40, 40, 70)');
  assert.equal(p.vars['--tab-text'], 'rgb(255, 255, 255)');
  assert.equal(p.vars['--frame-text'], 'rgb(180, 180, 200)');
  assert.equal(p.vars['--bookmark-text'], 'rgb(230, 230, 250)');
  assert.equal(p.vars['--ntp-bg'], 'rgb(0, 0, 0)');
  assert.deepEqual(p.images, { frame: 'images/frame.png', toolbar: 'images/toolbar.png', ntpBackground: 'images/ntp.jpg' });
  assert.deepEqual(p.ntp, { position: 'bottom left', repeat: 'repeat-x', attributionPosition: 'right bottom', logoAlternate: false });
  assert.equal(p.frameColor, 'rgb(20, 20, 40)');
});

test('chrome theme: a light theme from a frame tint only, with defaults for the rest', () => {
  const p = themePalette({ name: 'Mint', theme: { tints: { frame: [0.4, 0.6, 0.6] }, properties: { ntp_background_alignment: 'nonsense', ntp_background_repeat: 'sideways' } } });
  assert.equal(p.base, 'light');
  assert.notEqual(p.vars['--frame'], 'rgb(222, 225, 230)');
  assert.equal(p.vars['--toolbar'], 'rgb(255, 255, 255)');
  assert.equal(p.ntp.position, 'center');
  assert.equal(p.ntp.repeat, 'no-repeat');
  assert.deepEqual(p.images, {});
});
