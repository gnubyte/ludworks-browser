// Chrome extensions: CRX3 parsing/verification, IDs, manifest and permission summaries, Web Store URLs
// and update responses, safe unpacking, the prepared manifest and the chrome.storage.sync shim
// (src/main/extensions/*, src/preload/extensions.cjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createHash } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { crc32 } from 'node:zlib';
import { createZip } from '../../scripts/lib/zip.mjs';
import { verifyCrx, parseCrx, buildCrx, idFromPublicKey, idFromManifestKey, idFromBytes, isExtensionId, WEBSTORE_PUBLISHER_KEY_SHA256 } from '../build/app/main/extensions/crx.js';
import * as M from '../build/app/main/extensions/manifest.js';
import { storeItemId, downloadUrl, updateCheckUrl, parseUpdateResponse, compareVersions, validVersion, trustedCodebase } from '../build/app/main/extensions/webstore.js';
import { safeEntryPath, readExtensionArchive, writeTree, stripJsonComments, LIMITS } from '../build/app/main/extensions/unpack.js';
import { openCrx, openZip, preparedManifest, writePackage, refreshPrepared, rewriteManifest, contentShim, readFolder, CS_SHIM, download } from '../build/app/main/extensions/installer.js';

const PRELOAD = new URL('../build/app/preload/extensions.cjs', import.meta.url);
const rsa = () => generateKeyPairSync('rsa', { modulusLength: 2048 });
const ec = () => ({ ...generateKeyPairSync('ec', { namedCurve: 'P-256' }), algo: 'ecdsa' });
const spki = (k) => k.publicKey.export({ format: 'der', type: 'spki' });
const sha = (b) => createHash('sha256').update(b).digest('hex');

function extZip(manifest = { manifest_version: 3, name: 'Test', version: '1.2.3' }, extra = []) {
  return createZip([{ name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest)) }, { name: 'bg.js', data: Buffer.from('console.log(1)') }, ...extra]);
}

/** A stored (uncompressed) ZIP with arbitrary entry names (createZip refuses unsafe ones). */
function rawZip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const data = Buffer.from(e.data);
    const declared = e.declaredSize ?? data.length;
    const crc = crc32(data) >>> 0;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0x800, 6);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(declared, 22);
    lh.writeUInt16LE(name.length, 26);
    locals.push(lh, name, data);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x800, 8);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(declared, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, name);
    offset += 30 + name.length + data.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

// ----------------------------------------------------------------------------------- IDs, CRX3
test('extension IDs come from the public key (real Web Store vector)', () => {
  // JSON Formatter's developer key, as the Web Store serves it, and its store ID
  const key = 'MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQCqG3lHX5IxspFMDxlInApdzwJ5prcP4k/5tU5R3roeoU+hhdFFgl5rHcdzj+C4G3ExES4cpUvo2rPDEmcKJHJdmw7x2v9FL7eugyPL6MvZNDlY/h6BTP1Y37Cogyz6K5+zgND+pkmHIXQ86Pf8LwU0iO0YKfekFDsM219fr1iXvQIDAQAB';
  assert.equal(idFromManifestKey(key), 'bcjindcccaagfpapjjmafapmmgkkhgoa');
  assert.equal(idFromBytes(Buffer.alloc(16, 0)), 'a'.repeat(32));
  assert.equal(idFromBytes(Buffer.alloc(16, 0xff)), 'p'.repeat(32));
  assert.equal(idFromManifestKey('not a key'), null);
  assert.equal(idFromManifestKey(''), null);
  assert.ok(isExtensionId('bcjindcccaagfpapjjmafapmmgkkhgoa'));
  assert.ok(!isExtensionId('bcjindcccaagfpapjjmafapmmgkkhgoz'));
  assert.ok(!isExtensionId('ABCD'));
});

test('CRX3: a package signed by its developer (and a store key) verifies', async () => {
  const dev = rsa();
  const store = ec();
  const archive = extZip();
  const crx = await buildCrx(archive, [dev, store]);
  const id = idFromPublicKey(spki(dev));
  const p = parseCrx(crx);
  assert.equal(p.proofs.length, 2);
  assert.equal(idFromBytes(p.crxId), id);
  const v = verifyCrx(crx, { expectedId: id, requirePublisher: true, publisherKeyHash: sha(spki(store)) });
  assert.equal(v.id, id);
  assert.equal(v.publisher, true);
  assert.equal(idFromManifestKey(v.key), id, 'the manifest key keeps the ID');
  assert.deepEqual(v.archive, archive);
  // ECDSA developer keys work too
  const dev2 = ec();
  const v2 = verifyCrx(await buildCrx(archive, [dev2]));
  assert.equal(v2.id, idFromPublicKey(spki(dev2)));
  assert.equal(v2.publisher, false);
});

test('CRX3: tampering, wrong IDs, missing proofs and the store requirement are refused', async () => {
  const dev = rsa();
  const other = rsa();
  const archive = extZip();
  const crx = await buildCrx(archive, [dev]);
  const id = idFromPublicKey(spki(dev));
  const code = (fn) => {
    try {
      fn();
    } catch (e) {
      return e.code;
    }
    return 'accepted';
  };
  // one flipped bit in the archive
  const bad = Buffer.from(crx);
  bad[bad.length - 30] ^= 1;
  assert.equal(code(() => verifyCrx(bad)), 'bad_signature');
  // the store asked for another extension
  assert.equal(code(() => verifyCrx(crx, { expectedId: idFromPublicKey(spki(other)) })), 'id_mismatch');
  // signed only by a key the ID does not belong to
  const foreign = await buildCrx(archive, [other], { crxId: createHash('sha256').update(spki(dev)).digest().subarray(0, 16) });
  assert.equal(code(() => verifyCrx(foreign)), 'no_developer_proof');
  // Web Store downloads need the Web Store's own signature
  assert.equal(code(() => verifyCrx(crx, { expectedId: id, requirePublisher: true })), 'no_publisher_proof');
  assert.match(WEBSTORE_PUBLISHER_KEY_SHA256, /^[0-9a-f]{64}$/);
  // formats
  assert.equal(code(() => verifyCrx(Buffer.from('PK\x03\x04 not a crx'))), 'not_crx');
  const crx2 = Buffer.from(crx);
  crx2.writeUInt32LE(2, 4);
  assert.equal(code(() => verifyCrx(crx2)), 'crx2');
  const trunc = Buffer.from(crx.subarray(0, 40));
  assert.equal(code(() => verifyCrx(trunc)), 'malformed');
  const huge = Buffer.from(crx);
  huge.writeUInt32LE(0x7fffffff, 8);
  assert.equal(code(() => verifyCrx(huge)), 'malformed');
});

test('CRX3: the installer reads a verified package and never a broken one', async () => {
  const dev = rsa();
  const crx = await buildCrx(extZip({ manifest_version: 3, name: '__MSG_n__', version: '2.0', default_locale: 'en' }, [{ name: '_locales/en/messages.json', data: Buffer.from(JSON.stringify({ n: { message: 'Hello Ext' } })) }]), [dev]);
  const pkg = openCrx(crx);
  assert.equal(pkg.id, idFromPublicKey(spki(dev)));
  assert.equal(pkg.manifest.version, '2.0');
  assert.ok(pkg.files.some((f) => f.path === '_locales/en/messages.json'));
  const bad = Buffer.from(crx);
  bad[bad.length - 10] ^= 0xff;
  assert.throws(() => openCrx(bad), (e) => e.code === 'bad_signature');
  // a .zip gets a key of its own (stable ID), or keeps the manifest's
  const z = openZip(extZip());
  assert.ok(isExtensionId(z.id));
  assert.equal(idFromManifestKey(z.key), z.id);
  const key = spki(dev).toString('base64');
  assert.equal(openZip(extZip({ manifest_version: 3, name: 'K', version: '1', key })).id, idFromPublicKey(spki(dev)));
});

// ---------------------------------------------------------------------------- unpacking safely
test('archive paths: traversal, absolute, drive and device names are refused', () => {
  for (const bad of ['../evil.js', 'a/../../evil.js', '/etc/passwd', '\\\\server\\share', 'C:/Windows/x.dll', 'c:evil', 'con.txt', 'dir/NUL', 'a:b.js', 'x\0y', 'trailingdot.', 'a/b/..']) {
    assert.throws(() => safeEntryPath(bad), (e) => e.code === 'bad_path', bad);
  }
  assert.equal(safeEntryPath('js/app.js'), 'js/app.js');
  assert.equal(safeEntryPath('./js//app.js'), 'js/app.js');
  assert.equal(safeEntryPath('a\\b.js'), 'a/b.js');
});

test('archives: traversal entries, missing manifest, duplicates and zip bombs are refused', () => {
  const man = { name: 'manifest.json', data: '{"manifest_version":3,"name":"x","version":"1"}' };
  const refuse = (buf, codeRe, limits) => assert.throws(() => readExtensionArchive(buf, limits), (e) => codeRe.test(e.code));
  refuse(rawZip([man, { name: '../../outside.js', data: 'x' }]), /bad_path/);
  refuse(rawZip([man, { name: '/abs.js', data: 'x' }]), /bad_path/);
  refuse(rawZip([man, { name: 'C:/abs.js', data: 'x' }]), /bad_path/);
  refuse(rawZip([{ name: 'readme.txt', data: 'x' }]), /no_manifest/);
  refuse(rawZip([man, { name: 'A.js', data: '1' }, { name: 'a.js', data: '2' }]), /bad_path/);
  // declared sizes beyond the cap are refused before anything is inflated
  refuse(rawZip([man, { name: 'big.bin', data: 'x', declaredSize: LIMITS.maxEntryBytes + 1 }]), /too_large/);
  refuse(rawZip([man, { name: 'b1', data: 'x'.repeat(600) }, { name: 'b2', data: 'x'.repeat(600) }]), /too_large/, { maxTotalBytes: 1000 });
  // a real deflate bomb: 64 MB of zeros in a ~64 KB archive, against a 1 MB total cap
  const bomb = createZip([{ name: 'manifest.json', data: Buffer.from(man.data) }, { name: 'zeros.bin', data: Buffer.alloc(64 * 1024 * 1024) }], { level: 9 });
  assert.ok(bomb.length < 1024 * 1024);
  refuse(bomb, /too_large/, { maxTotalBytes: 1024 * 1024 });
  // an entry whose real data does not match its declared size fails the checksum
  refuse(rawZip([man, { name: 'lie.js', data: 'abcdef', declaredSize: 3 }]), /bad_archive/);
  // fine: one top-level folder is unwrapped
  const ok = readExtensionArchive(createZip([{ name: 'pkg/manifest.json', data: Buffer.from(man.data) }, { name: 'pkg/js/a.js', data: Buffer.from('a') }]));
  assert.deepEqual(ok.files.map((f) => f.path).sort(), ['js/a.js', 'manifest.json']);
  // comments in manifest.json are allowed, like Chrome
  assert.equal(JSON.parse(stripJsonComments('{ // c\n "a": "http://x/*" /* b */ }')).a, 'http://x/*');
});

test('writeTree writes atomically inside its folder only', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'lwb-ext-'));
  try {
    const out = path.join(dir, 'id', '1.0');
    writeTree(out, [{ path: 'manifest.json', data: '{}' }, { path: 'js/a.js', data: 'a' }]);
    assert.equal(readFileSync(path.join(out, 'js', 'a.js'), 'utf8'), 'a');
    assert.throws(() => writeTree(path.join(dir, 'id', '2.0'), [{ path: '../escape.js', data: 'x' }]), (e) => e.code === 'bad_path');
    assert.ok(!existsSync(path.join(dir, 'id', 'escape.js')));
    assert.ok(!existsSync(path.join(dir, 'id', '2.0')));
    assert.deepEqual(readdirSync(path.join(dir, 'id')), ['1.0'], 'no temp folders left behind');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------------ manifests, permissions
test('match patterns', () => {
  assert.ok(M.matchesPattern('<all_urls>', 'https://a.example/x'));
  assert.ok(!M.matchesPattern('<all_urls>', 'ludworks://passwords/'), 'internal pages are never covered');
  assert.ok(!M.matchesPattern('*://*/*', 'ludworks://settings/'));
  assert.ok(!M.matchesPattern('<all_urls>', 'chrome-extension://abc/x'));
  assert.ok(M.matchesPattern('*://*.youtube.com/*', 'https://www.youtube.com/watch?v=1'));
  assert.ok(M.matchesPattern('*://*.youtube.com/*', 'https://youtube.com/'));
  assert.ok(!M.matchesPattern('*://*.youtube.com/*', 'https://notyoutube.com/'));
  assert.ok(M.matchesPattern('https://a.com/api/*', 'https://a.com/api/v1?x=1'));
  assert.ok(!M.matchesPattern('https://a.com/api/*', 'https://a.com/other'));
  assert.ok(!M.matchesPattern('http://a.com/*', 'https://a.com/'));
  assert.ok(M.matchesPattern('file:///*', 'file:///C:/x.html'));
  assert.equal(M.parsePattern('https://a*b.com/*'), null);
  assert.equal(M.parsePattern('ludworks://*/*'), null);
  assert.ok(M.isAllSites('<all_urls>') && M.isAllSites('*://*/*') && M.isAllSites('https://*/*') && !M.isAllSites('https://*.a.com/*'));
  // tabs.query url filters accept any scheme (they only filter)
  assert.ok(M.queryPatternMatch('chrome-extension://abc/*', 'chrome-extension://abc/options.html'));
  assert.ok(M.queryPatternMatch('*://*.a.com/*', 'https://x.a.com/p'));
  assert.ok(!M.queryPatternMatch('*://*.a.com/*', 'ftp://x.a.com/p'));
});

test('permission summaries read like the install prompt', () => {
  const all = M.describeManifest({ manifest_version: 3, permissions: ['tabs', 'storage', 'cookies', 'notifications'], host_permissions: ['<all_urls>'] });
  assert.equal(all.allSites, true);
  assert.deepEqual(all.items, ['Read and change all your data on all websites', 'Read your browsing history', 'Read and change cookies of the sites it can access', 'Show notifications']);
  const some = M.describeManifest({ manifest_version: 3, host_permissions: ['*://*.youtube.com/*', '*://returnyoutubedislikeapi.com/*'], content_scripts: [{ matches: ['*://youtube.com/*', '*://m.youtube.com/*'], js: ['a.js'] }] });
  assert.deepEqual(some.sites, ['*.youtube.com', 'returnyoutubedislikeapi.com'], 'hosts covered by a wildcard are folded into it');
  assert.equal(some.items[0], 'Read and change your data on *.youtube.com, returnyoutubedislikeapi.com');
  const many = M.describeAccess({ origins: ['https://a.com/*', 'https://b.com/*', 'https://c.com/*', 'https://d.com/*', 'https://e.com/*'] });
  assert.equal(many.items[0], 'Read and change your data on a.com, b.com, c.com and 2 other sites');
  assert.deepEqual(M.describeManifest({ manifest_version: 3, permissions: ['storage', 'alarms'] }).items, []);
  assert.deepEqual(M.describeManifest({ manifest_version: 2, permissions: ['https://x.com/*', 'history', 'downloads'] }).items, ['Read and change your data on x.com', 'Read and change your browsing history', 'Manage your downloads']);
});

test('what Ludworks cannot provide is listed (and crashing APIs are stripped)', () => {
  const m = { manifest_version: 3, permissions: ['declarativeNetRequest', 'storage', 'sidePanel', 'offscreen', 'nativeMessaging'], optional_permissions: ['identity'], side_panel: { default_path: 'p.html' }, chrome_url_overrides: { newtab: 'n.html' } };
  const u = M.unsupportedFeatures(m);
  assert.ok(u.includes('Blocking or changing network requests (declarativeNetRequest)'));
  assert.ok(u.includes('Side panel'));
  assert.ok(u.includes('Talking to programs installed on your computer (native messaging)'));
  assert.ok(u.includes('Signing in with a Google account (identity)'));
  assert.ok(u.includes('Replacing the new tab, history or bookmarks page'));
  assert.ok(!u.some((x) => /offscreen/i.test(x)), 'offscreen documents work in Electron 44');
  assert.ok(!M.unsupportedRequired(m).some((x) => /identity/.test(x)), 'optional ones are not install warnings');
  assert.deepEqual(M.unsupportedFeatures({ manifest_version: 3, permissions: ['storage', 'tabs', 'scripting'] }), []);
  const prepared = preparedManifest({ manifest_version: 3, name: 'x', version: '1', permissions: ['storage', 'system.storage', 'system.display', 'system.cpu'] });
  assert.deepEqual(prepared.permissions, ['storage', 'system.cpu']);
});

test('localisation, icons, options pages, commands', () => {
  const msgs = { extname: 'My Ext', desc: 'Costs $$5' };
  assert.equal(M.localize('__MSG_extName__', msgs), 'My Ext');
  assert.equal(M.localize('A __MSG_desc__!', msgs), 'A Costs $5!');
  assert.equal(M.localize('__MSG_missing__', msgs), '__MSG_missing__');
  assert.equal(M.pickIcon({ 16: 'a16.png', 48: 'a48.png', 128: 'a128.png' }, 32), 'a48.png');
  assert.equal(M.pickIcon({ 16: 'a16.png' }, 32), 'a16.png');
  assert.equal(M.pickIcon('one.png', 32), 'one.png');
  assert.equal(M.pickIcon(null), null);
  assert.equal(M.optionsPageOf({ options_ui: { page: 'o.html' } }), 'o.html');
  assert.equal(M.actionOf({ manifest_version: 2, browser_action: { default_popup: 'p.html' } }).default_popup, 'p.html');
  const cmds = M.manifestCommands({ commands: { _execute_action: { suggested_key: { default: 'Ctrl+Shift+Y', linux: 'Ctrl+Shift+U' } }, toggle: { suggested_key: { default: 'alt+shift+d' }, description: 'Toggle' }, none: { description: 'No key' } } }, 'win32');
  assert.deepEqual(cmds.map((c) => [c.name, c.shortcut]), [['_execute_action', 'Ctrl+Shift+Y'], ['toggle', 'Alt+Shift+D'], ['none', '']]);
  assert.equal(M.normalizeShortcut('Shift+A'), '', 'Shift alone is not a modifier for commands');
  assert.equal(M.normalizeShortcut('Ctrl+Shift+9'), 'Ctrl+Shift+9');
  const key = (o) => ({ type: 'keyDown', control: false, meta: false, alt: false, shift: false, ...o });
  assert.ok(M.inputMatchesShortcut(key({ control: true, shift: true, key: 'Y', code: 'KeyY' }), 'Ctrl+Shift+Y', 'win32'));
  assert.ok(!M.inputMatchesShortcut(key({ control: true, key: 'y', code: 'KeyY' }), 'Ctrl+Shift+Y', 'win32'));
  assert.ok(M.inputMatchesShortcut(key({ meta: true, shift: true, key: 'Y', code: 'KeyY' }), 'Ctrl+Shift+Y', 'darwin'));
  assert.ok(M.inputMatchesShortcut(key({ control: true, shift: true, key: '(', code: 'Digit9' }), 'Ctrl+Shift+9', 'win32'));
  assert.deepEqual(M.parseColor('#f00'), [255, 0, 0, 255]);
  assert.deepEqual(M.parseColor([1, 2, 3, 4]), [1, 2, 3, 4]);
  assert.deepEqual(M.parseColor('rgba(10, 20, 30, 0.5)'), [10, 20, 30, 128]);
  assert.equal(M.parseColor('nonsense'), null);
});

test('the prepared manifest: key, content-script shim, granted optional permissions', () => {
  const original = { manifest_version: 3, name: 'x', version: '1', permissions: ['storage'], optional_permissions: ['contextMenus', 'cookies'], optional_host_permissions: ['https://*.a.com/*'], content_scripts: [{ matches: ['<all_urls>'], js: ['cs.js'] }, { matches: ['<all_urls>'], js: ['main.js'], world: 'MAIN' }, { matches: ['<all_urls>'], css: ['x.css'] }] };
  const p = preparedManifest(original, { key: 'KEY', granted: { permissions: ['contextMenus', 'tabs'], origins: ['https://*.a.com/*'] } });
  assert.equal(p.key, 'KEY');
  assert.deepEqual(p.content_scripts[0].js, [CS_SHIM, 'cs.js']);
  assert.deepEqual(p.content_scripts[1].js, ['main.js'], 'never in the page world');
  assert.equal(p.content_scripts[2].js, undefined);
  assert.deepEqual(p.permissions, ['storage', 'contextMenus'], 'only declared optional permissions can be granted');
  assert.deepEqual(p.host_permissions, ['https://*.a.com/*']);
  assert.deepEqual(p.optional_permissions, ['cookies']);
  assert.deepEqual(p.optional_host_permissions, []);
  assert.deepEqual(original.permissions, ['storage'], 'the original is untouched');
});

test('package folders: write, refresh after an app update, rewrite after grants', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'lwb-ext-'));
  try {
    const pkg = openCrx(await buildCrx(extZip({ manifest_version: 3, name: 'x', version: '1', optional_permissions: ['cookies'], content_scripts: [{ matches: ['<all_urls>'], js: ['cs.js'] }] }, [{ name: 'cs.js', data: Buffer.from('1') }]), [rsa()]));
    const out = path.join(dir, pkg.id, '1');
    writePackage(out, pkg, { shim: '// shim v1\n' });
    const m = JSON.parse(readFileSync(path.join(out, 'manifest.json'), 'utf8'));
    assert.equal(idFromManifestKey(m.key), pkg.id, 'the folder keeps the store ID');
    assert.equal(readFileSync(path.join(out, CS_SHIM), 'utf8'), '// shim v1\n');
    assert.equal(refreshPrepared(out, { shim: '// shim v1\n' }), false, 'nothing to do');
    assert.equal(refreshPrepared(out, { shim: '// shim v2\n' }), true);
    assert.equal(readFileSync(path.join(out, CS_SHIM), 'utf8'), '// shim v2\n');
    assert.ok(rewriteManifest(out, { permissions: ['cookies'], origins: [] }));
    assert.deepEqual(JSON.parse(readFileSync(path.join(out, 'manifest.json'), 'utf8')).permissions, ['cookies']);
    // an unpacked folder reads the same way (comments allowed, .git skipped)
    const src = path.join(dir, 'src');
    writeTree(src, [{ path: 'manifest.json', data: '{ // dev\n "manifest_version": 3, "name": "dev", "version": "0.1" }' }, { path: '.git/HEAD', data: 'x' }, { path: 'a.js', data: 'a' }]);
    const f = readFolder(src);
    assert.deepEqual(f.files.map((x) => x.path).sort(), ['a.js', 'manifest.json']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------------------- Web Store
test('Web Store item pages and update service URLs', () => {
  const id = 'eimadpbcbfnmbkopoojfekhnkhdbieeh';
  assert.equal(storeItemId(`https://chromewebstore.google.com/detail/dark-reader/${id}`), id);
  assert.equal(storeItemId(`https://chromewebstore.google.com/detail/${id}?hl=en`), id);
  assert.equal(storeItemId(`https://chrome.google.com/webstore/detail/dark-reader/${id}`), id);
  assert.equal(storeItemId(`http://chromewebstore.google.com/detail/x/${id}`), null);
  assert.equal(storeItemId(`https://chromewebstore.google.com.evil.com/detail/x/${id}`), null);
  assert.equal(storeItemId('https://chromewebstore.google.com/category/extensions'), null);
  const u = new URL(downloadUrl(id, '152.0.7977.167', { platform: 'win32', arch: 'x64' }));
  assert.equal(u.hostname, 'clients2.google.com');
  assert.equal(u.searchParams.get('response'), 'redirect');
  assert.equal(u.searchParams.get('acceptformat'), 'crx3');
  assert.equal(u.searchParams.get('prodversion'), '152.0.7977.167');
  assert.equal(u.searchParams.get('x'), `id=${id}&installsource=ondemand&uc`);
  assert.throws(() => downloadUrl('nope', '1'));
  const c = new URL(updateCheckUrl([{ id, version: '4.9.1' }, { id: 'bcjindcccaagfpapjjmafapmmgkkhgoa', version: '0.10.2' }, { id: 'bad', version: '1' }], '152.0.0.0'));
  assert.deepEqual(c.searchParams.getAll('x'), [`id=${id}&v=4.9.1&installsource=notfromwebstore&uc`, 'id=bcjindcccaagfpapjjmafapmmgkkhgoa&v=0.10.2&installsource=notfromwebstore&uc']);
  assert.ok(trustedCodebase('https://clients2.googleusercontent.com/crx/blobs/x/y.crx'));
  assert.ok(trustedCodebase('https://edgedl.me.gvt1.com/edgedl/x.crx'));
  assert.ok(!trustedCodebase('http://clients2.googleusercontent.com/x.crx'));
  assert.ok(!trustedCodebase('https://googleusercontent.com.evil.net/x.crx'));
});

test('update responses (gupdate) are parsed', () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?><gupdate xmlns="http://www.google.com/update2/response" protocol="2.0" server="prod"><daystart elapsed_days="7239" elapsed_seconds="85660"/><app appid="bcjindcccaagfpapjjmafapmmgkkhgoa" cohort="1::" cohortname="" status="ok"><updatecheck _esbAllowlist="true" codebase="https://clients2.googleusercontent.com/crx/blobs/AAA/BCJ_0_10_2_0.crx" fp="1.5e0e" hash_sha256="5E0EBDE71EE60F997A9F5FC0850E6AE4A9F67006DBF662F00507F99E957C2B21" protected="0" size="20840" status="ok" version="0.10.2"/></app><app appid="eimadpbcbfnmbkopoojfekhnkhdbieeh" cohort="1::" cohortname="" status="ok"><updatecheck _esbAllowlist="true" status="noupdate"/></app><app appid="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" status="error-unknownApplication"/></gupdate>`;
  const r = parseUpdateResponse(xml);
  assert.deepEqual(r.get('bcjindcccaagfpapjjmafapmmgkkhgoa'), { status: 'ok', version: '0.10.2', codebase: 'https://clients2.googleusercontent.com/crx/blobs/AAA/BCJ_0_10_2_0.crx', sha256: '5e0ebde71ee60f997a9f5fc0850e6ae4a9f67006dbf662f00507f99e957c2b21', size: 20840 });
  assert.deepEqual(r.get('eimadpbcbfnmbkopoojfekhnkhdbieeh'), { status: 'noupdate' });
  assert.deepEqual(r.get('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'), { status: 'error-unknownApplication' });
  assert.throws(() => parseUpdateResponse('<html>captive portal</html>'));
  assert.equal(compareVersions('1.2.10', '1.2.9'), 1);
  assert.equal(compareVersions('1.2', '1.2.0.0'), 0);
  assert.equal(compareVersions('2026.1026.1812', '2026.1101.1'), -1);
  assert.ok(validVersion('2026.1026.1812') && validVersion('1') && !validVersion('1.2.3.4.5') && !validVersion('01.2') && !validVersion('65536') && !validVersion('1.a'));
});

test('downloads are capped and checked', async () => {
  const body = (n) => new Response(new Uint8Array(n), { status: 200, headers: { 'content-length': String(n) } });
  const fetchImpl = (n, extra = {}) => async () => Object.assign(body(n), extra);
  await assert.rejects(download(fetchImpl(2048), 'https://clients2.google.com/x', { maxBytes: 1024 }), (e) => e.code === 'too_large');
  const ok = await download(fetchImpl(10), 'https://clients2.google.com/x', { expectSha256: sha(Buffer.alloc(10)) });
  assert.equal(ok.length, 10);
  await assert.rejects(download(fetchImpl(10), 'https://clients2.google.com/x', { expectSha256: sha(Buffer.alloc(11)) }), (e) => e.code === 'hash');
  await assert.rejects(download(async () => new Response(null, { status: 204 }), 'https://clients2.google.com/x'), (e) => e.code === 'not_found');
  const redirected = async () => Object.defineProperty(body(10), 'url', { value: 'https://evil.example/x.crx' });
  await assert.rejects(download(redirected, 'https://clients2.google.com/x'), (e) => e.code === 'untrusted');
});

// ----------------------------------------------------------------------- chrome.storage.sync shim
function fakeChrome() {
  const data = new Map();
  const listeners = [];
  const fire = (changes) => listeners.forEach((fn) => fn(changes, 'local'));
  // callback or promise, like the real StorageArea
  const area = (impl) => (...args) => {
    const cb = typeof args[args.length - 1] === 'function' ? args.pop() : null;
    const p = new Promise((resolve) => queueMicrotask(() => resolve(impl(...args))));
    if (cb) {
      p.then(cb);
      return undefined;
    }
    return p;
  };
  const local = {
    get: area((keys) => {
      const out = {};
      if (keys === null || keys === undefined) for (const [k, v] of data) out[k] = v;
      else if (Array.isArray(keys)) for (const k of keys) data.has(k) && (out[k] = data.get(k));
      else if (typeof keys === 'string') data.has(keys) && (out[keys] = data.get(keys));
      else for (const [k, d] of Object.entries(keys)) out[k] = data.has(k) ? data.get(k) : d;
      return structuredClone(out);
    }),
    set: area((items) => {
      const ch = {};
      for (const [k, v] of Object.entries(items)) {
        ch[k] = { oldValue: data.get(k), newValue: v };
        data.set(k, v);
      }
      fire(ch);
    }),
    remove: area((keys) => {
      const ch = {};
      for (const k of [].concat(keys)) {
        if (!data.has(k)) continue;
        ch[k] = { oldValue: data.get(k) };
        data.delete(k);
      }
      if (Object.keys(ch).length) fire(ch);
    }),
    getBytesInUse: area((keys) => [].concat(keys || []).length * 10),
  };
  const chrome = { runtime: {}, storage: { local, onChanged: { addListener: (fn) => listeners.push(fn), removeListener: (fn) => listeners.splice(listeners.indexOf(fn), 1) } } };
  return { chrome, data };
}

test('storage.sync shim (content scripts and pages): separate from local, events per area', async () => {
  const plain = (o) => JSON.parse(JSON.stringify(o)); // objects from the shim's realm
  const src = contentShim(fileURLToPath(PRELOAD));
  assert.match(src, /function lwStorageShim/);
  const { chrome, data } = fakeChrome();
  vm.runInNewContext(src, { chrome, console, queueMicrotask, structuredClone, Promise });
  const events = [];
  chrome.storage.onChanged.addListener((changes, area) => events.push([area, Object.keys(changes).sort().join(',')]));
  const syncEvents = [];
  chrome.storage.sync.onChanged.addListener((changes) => syncEvents.push(Object.keys(changes).join(',')));
  await chrome.storage.local.set({ a: 1, shared: 'local' });
  await chrome.storage.sync.set({ theme: 'dark', shared: 'sync' });
  assert.deepEqual(plain(await chrome.storage.sync.get(null)), { theme: 'dark', shared: 'sync' });
  assert.deepEqual(plain(await chrome.storage.sync.get('theme')), { theme: 'dark' });
  assert.deepEqual(plain(await chrome.storage.sync.get({ theme: 'x', missing: 7 })), { theme: 'dark', missing: 7 });
  assert.deepEqual(plain(await chrome.storage.local.get(null)), { a: 1, shared: 'local' }, 'local does not show sync items');
  assert.deepEqual(plain(await new Promise((r) => chrome.storage.sync.get(['shared'], r))), { shared: 'sync' }, 'callbacks work');
  assert.deepEqual(events, [['local', 'a,shared'], ['sync', 'shared,theme']]);
  assert.deepEqual(syncEvents, ['theme,shared']);
  await chrome.storage.sync.remove('theme');
  assert.deepEqual(plain(await chrome.storage.sync.getKeys()), ['shared']);
  await chrome.storage.local.clear();
  assert.deepEqual(plain(await chrome.storage.sync.get(null)), { shared: 'sync' }, 'clearing local keeps sync');
  await chrome.storage.sync.clear();
  assert.equal(data.size, 0);
  assert.equal(chrome.storage.sync.QUOTA_BYTES, 102400);
  assert.deepEqual(plain(await chrome.storage.managed.get(null)), {});
});
