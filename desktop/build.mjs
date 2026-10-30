#!/usr/bin/env node
// Ludworks Browser desktop build (Node built-ins only, no npm packages).
//
//   node desktop/build.mjs stage                         assemble desktop/build/app (the app code)
//   node desktop/build.mjs fetch   [--target=win32-x64]  download + SHA-256-verify the pinned engine
//   node desktop/build.mjs package [--target=win32-x64]  stage + engine → desktop/dist/<target>/
//   node desktop/build.mjs all     [--target=…]          package and write the release archive
//   node desktop/build.mjs lwb     [--target=…]          the AI agents' CLI → desktop/tools/bin (packages include it)
//
// Targets: win32-x64 win32-arm64 darwin-x64 darwin-arm64 linux-x64 linux-arm64 (default: this machine,
// or win32-x64 when run inside WSL for the Windows host).
//
// The engine is castlabs "Electron for Content Security" (Chromium + Widevine), pinned in
// desktop/electron.lock.json by version and SHA-256. Packaging renames the binary, flips the
// security fuses, drops unused locales, gzips the 20 MB Chromium licence file, and on Windows sets
// the icon and version info (tools/winres, run on Windows). Widevine VMP signing (needed by
// Netflix-class services) happens after that with castlabs' EVS tool when it is configured.

import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { extractZip } from './scripts/lib/unzip.mjs';
import { flipFuses, LUDWORKS_FUSES } from './scripts/lib/fuses.mjs';
import { bundle } from '../scripts/lib/bundle.mjs';
import { createZip } from '../scripts/lib/zip.mjs';
import { createTar } from './scripts/lib/tar.mjs';

const DESKTOP = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(DESKTOP, '..');
const LOCK = JSON.parse(readFileSync(path.join(DESKTOP, 'electron.lock.json'), 'utf8'));
const PKG = JSON.parse(readFileSync(path.join(REPO, 'package.json'), 'utf8'));
export const PRODUCT = 'Ludworks Browser';
export const EXE = { win32: 'LudworksBrowser.exe', linux: 'ludworks-browser', darwin: 'Ludworks Browser.app' };
const KEEP_LOCALES = new Set(['en-US']);

function arg(name, dflt = null) {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : dflt;
}

function defaultTarget() {
  const inWsl = process.platform === 'linux' && /microsoft/i.test(readSafe('/proc/version'));
  if (inWsl) return 'win32-x64';
  return `${process.platform}-${process.arch === 'arm64' ? 'arm64' : 'x64'}`;
}

function readSafe(p) {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return '';
  }
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

// ------------------------------------------------------------------------------------- fetch
export async function fetchEngine(target) {
  const asset = LOCK.assets[target];
  if (!asset) throw new Error(`no pinned engine for ${target}`);
  const dir = path.join(DESKTOP, '.cache', 'electron', LOCK.version);
  const file = path.join(dir, asset.file);
  if (existsSync(file) && sha256(readFileSync(file)) === asset.sha256) return file;
  mkdirSync(dir, { recursive: true });
  const url = LOCK.baseUrl + encodeURIComponent(asset.file).replace(/%2B/g, '%2B');
  console.log(`==> downloading ${asset.file}`);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status} for ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const got = sha256(buf);
  if (got !== asset.sha256) throw new Error(`SHA-256 mismatch for ${asset.file}: expected ${asset.sha256}, got ${got}`);
  writeFileSync(file, buf);
  return file;
}

// ------------------------------------------------------------------------------------- stage
export async function stage(out = path.join(DESKTOP, 'build', 'app')) {
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const src = path.join(DESKTOP, 'src');
  for (const dir of ['main', 'shell', 'pages', 'assets', 'vendor']) cpSync(path.join(src, dir), path.join(out, dir), { recursive: true });
  // Vault/autofill libraries shared with the Ludworks Passwords extension.
  cpSync(path.join(REPO, 'src', 'lib'), path.join(out, 'lib'), { recursive: true, filter: (p) => !p.endsWith('browser.js') });
  mkdirSync(path.join(out, 'preload'), { recursive: true });
  copyFileSync(path.join(src, 'preload', 'shell.cjs'), path.join(out, 'preload', 'shell.cjs'));
  // Chrome extension API additions (frames and service workers of extensions; see src/main/extensions/).
  copyFileSync(path.join(src, 'preload', 'extensions.cjs'), path.join(out, 'preload', 'extensions.cjs'));
  // content.cjs = base (shortcuts, internal page API) + bundled page features (autofill, passkeys).
  let content = readFileSync(path.join(src, 'preload', 'content-base.cjs'), 'utf8');
  const featuresEntry = path.join(src, 'preload', 'features', 'index.js');
  if (existsSync(featuresEntry)) {
    const feat = await bundle(featuresEntry, { root: path.join(src, 'preload') });
    content += `\n// ---- bundled features (src/preload/features + src/lib) ----\n${feat}\n`;
  }
  writeFileSync(path.join(out, 'preload', 'content.cjs'), content);
  writeFileSync(
    path.join(out, 'package.json'),
    JSON.stringify({ name: 'ludworks-browser', productName: PRODUCT, version: PKG.version, description: 'Ludworks Browser', main: 'main/main.js', type: 'module', private: true, license: 'UNLICENSED' }, null, 2) + '\n',
  );
  writeFileSync(path.join(out, 'build-info.json'), JSON.stringify({ version: PKG.version, engine: LOCK.version, flavor: LOCK.flavor }, null, 2) + '\n');
  return out;
}

// ----------------------------------------------------------------------------------- package
export async function packageTarget(target) {
  const [platform, arch] = target.split('-');
  const zip = await fetchEngine(target);
  const appDir = await stage();
  await writeLwbCatalog();
  const distRoot = path.join(DESKTOP, 'dist', target);
  const outDir = path.join(distRoot, platform === 'darwin' ? '' : PRODUCT);
  console.log(`==> extracting engine for ${target}`);
  rmSync(distRoot, { recursive: true, force: true });
  extractZip(readFileSync(zip), platform === 'darwin' ? distRoot : outDir, {
    filter: (name) => !name.startsWith('resources/default_app') && !/(^|\/)default_app\.asar$/.test(name),
  });
  if (platform === 'darwin') return packageMac(distRoot, appDir, arch);

  // locales
  const locDir = path.join(outDir, 'locales');
  for (const f of readdirSync(locDir)) {
    const name = f.replace(/\.pak(\.info)?$/, '');
    if (!KEEP_LOCALES.has(name)) rmSync(path.join(locDir, f));
  }
  // licence (keep it, compressed)
  const lic = path.join(outDir, 'LICENSES.chromium.html');
  if (existsSync(lic)) {
    writeFileSync(`${lic}.gz`, gzipSync(readFileSync(lic), { level: 9 }));
    rmSync(lic);
  }
  // binary
  const from = path.join(outDir, platform === 'win32' ? 'electron.exe' : 'electron');
  const exe = path.join(outDir, EXE[platform]);
  renameSync(from, exe);
  // castlabs' development VMP signature only matches the untouched electron binary.
  for (const sig of ['electron.exe.sig', 'electron.sig']) rmSync(path.join(outDir, sig), { force: true });
  const fuses = flipFuses(exe, LUDWORKS_FUSES);
  console.log('==> fuses', fuses);
  cpSync(appDir, path.join(outDir, 'resources', 'app'), { recursive: true });
  buildLwb(target, path.join(outDir, platform === 'win32' ? 'lwb.exe' : 'lwb'));
  if (platform === 'win32') windowsResources(exe);
  if (platform === 'linux') linuxExtras(outDir);
  writeFileSync(path.join(outDir, 'VERSION'), `${PKG.version}\n`);
  console.log(`==> ${outDir}`);
  return outDir;
}

function windowsResources(exe) {
  // Icon + version info via the Windows resource API (tools/winres, Go, Windows-only).
  const tool = path.join(DESKTOP, 'tools', 'bin', 'winres.exe');
  if (!existsSync(tool)) {
    console.warn('!! tools/bin/winres.exe not built — the executable keeps the Electron icon (run: node desktop/build.mjs tools)');
    return;
  }
  const winPath = (p) => (process.platform === 'win32' ? p : toWindowsPath(p));
  const res = spawnSync(toLocalExe(tool), ['set', '-exe', winPath(exe), '-icon', winPath(path.join(DESKTOP, 'build-res', 'icon.ico')), '-version', PKG.version], { stdio: 'inherit' });
  if (res.status !== 0) throw new Error('winres failed');
  const ver = spawnSync(toLocalExe(tool), ['verify', '-version', PKG.version, winPath(exe)], { stdio: 'inherit' });
  if (ver.status !== 0) throw new Error('winres verify failed');
}

function toWindowsPath(p) {
  const m = /^\/mnt\/([a-z])\/(.*)$/.exec(p);
  if (!m) throw new Error(`cannot map ${p} to a Windows path (run the Windows packaging from /mnt/<drive>)`);
  return `${m[1].toUpperCase()}:\\${m[2].replace(/\//g, '\\')}`;
}

function toLocalExe(p) {
  return p; // WSL runs Windows .exe files directly through interop
}

function linuxExtras(outDir) {
  writeFileSync(
    path.join(outDir, 'ludworks-browser.desktop'),
    [
      '[Desktop Entry]',
      'Version=1.0',
      'Type=Application',
      `Name=${PRODUCT}`,
      'GenericName=Web Browser',
      'Comment=Browse the web with your Ludworks passwords, passkeys and bookmarks',
      'Exec=ludworks-browser %U',
      'Icon=ludworks-browser',
      'Terminal=false',
      'StartupWMClass=ludworks-browser',
      'Categories=Network;WebBrowser;',
      'MimeType=text/html;text/xml;application/xhtml+xml;x-scheme-handler/http;x-scheme-handler/https;',
      'Actions=new-window;new-private-window;',
      '',
      '[Desktop Action new-window]',
      'Name=New Window',
      'Exec=ludworks-browser --new-window',
      '',
      '[Desktop Action new-private-window]',
      'Name=New Private Window',
      'Exec=ludworks-browser --private',
      '',
    ].join('\n'),
  );
  copyFileSync(path.join(DESKTOP, 'src', 'assets', 'icons', 'icon-256.png'), path.join(outDir, 'ludworks-browser.png'));
}

function packageMac(distRoot, appDir, arch) {
  const src = path.join(distRoot, 'Electron.app');
  const app = path.join(distRoot, EXE.darwin);
  renameSync(src, app);
  const contents = path.join(app, 'Contents');
  renameSync(path.join(contents, 'MacOS', 'Electron'), path.join(contents, 'MacOS', PRODUCT));
  const plistPath = path.join(contents, 'Info.plist');
  let plist = readFileSync(plistPath, 'utf8');
  const set = (key, value) => {
    const re = new RegExp(`(<key>${key}</key>\\s*<string>)[^<]*(</string>)`);
    if (re.test(plist)) plist = plist.replace(re, `$1${value}$2`);
    else plist = plist.replace('</dict>\n</plist>', `\t<key>${key}</key>\n\t<string>${value}</string>\n</dict>\n</plist>`);
  };
  set('CFBundleExecutable', PRODUCT);
  set('CFBundleName', PRODUCT);
  set('CFBundleDisplayName', PRODUCT);
  set('CFBundleIdentifier', 'app.ludworks.browser');
  set('CFBundleShortVersionString', PKG.version);
  set('CFBundleVersion', PKG.version);
  set('CFBundleIconFile', 'ludworks.icns');
  set('NSCameraUsageDescription', 'Websites you allow can use your camera.');
  set('NSMicrophoneUsageDescription', 'Websites you allow can use your microphone.');
  set('NSLocationUsageDescription', 'Websites you allow can use your location.');
  if (!plist.includes('<key>CFBundleURLTypes</key>')) {
    plist = plist.replace(
      '</dict>\n</plist>',
      '\t<key>CFBundleURLTypes</key>\n\t<array>\n\t\t<dict>\n\t\t\t<key>CFBundleURLName</key>\n\t\t\t<string>Web site URL</string>\n\t\t\t<key>CFBundleURLSchemes</key>\n\t\t\t<array>\n\t\t\t\t<string>http</string>\n\t\t\t\t<string>https</string>\n\t\t\t</array>\n\t\t</dict>\n\t</array>\n</dict>\n</plist>',
    );
  }
  writeFileSync(plistPath, plist);
  copyFileSync(path.join(DESKTOP, 'build-res', 'icon.icns'), path.join(contents, 'Resources', 'ludworks.icns'));
  const fw = path.join(contents, 'Frameworks', 'Electron Framework.framework', 'Versions', 'A', 'Electron Framework');
  console.log('==> fuses', flipFuses(fw, LUDWORKS_FUSES));
  rmSync(path.join(contents, 'Resources', 'default_app.asar'), { force: true });
  for (const f of readdirSync(path.join(contents, 'Frameworks', 'Electron Framework.framework', 'Versions', 'A', 'Resources'))) {
    if (f.endsWith('.lproj') && !['en.lproj', 'Base.lproj'].includes(f)) rmSync(path.join(contents, 'Frameworks', 'Electron Framework.framework', 'Versions', 'A', 'Resources', f), { recursive: true, force: true });
  }
  cpSync(appDir, path.join(contents, 'Resources', 'app'), { recursive: true });
  buildLwb(`darwin-${arch}`, path.join(contents, 'MacOS', 'lwb'));
  console.log(`==> ${app} (sign with codesign, then VMP-sign with castlabs EVS before notarising)`);
  return app;
}

// --------------------------------------------------------------------------------------- tools
function go(args, env = {}) {
  const r = spawnSync('go', args, { cwd: path.join(DESKTOP, 'tools'), stdio: 'inherit', env: { ...process.env, CGO_ENABLED: '0', GOFLAGS: '-mod=mod', ...env } });
  if (r.status !== 0) throw new Error(`go ${args.join(' ')} failed`);
}

/**
 * lwb, the AI agents' command line and MCP bridge (tools/lwb, Go stdlib only), for a target. Its tool
 * catalog (tools/lwb/tools.json, embedded) is regenerated from the browser's registry first, so the CLI
 * and the browser always agree. Without Go the package ships without lwb (with a warning).
 */
export async function writeLwbCatalog() {
  const { catalog } = await import(pathToFileURL(path.join(DESKTOP, 'src', 'main', 'agent', 'tools.js')).href);
  const file = path.join(DESKTOP, 'tools', 'lwb', 'tools.json');
  const text = `${JSON.stringify(catalog(PKG.version), null, 1)}\n`;
  if (readSafe(file) !== text) writeFileSync(file, text);
  return file;
}

function buildLwb(target, out) {
  const [platform, arch] = target.split('-');
  if (spawnSync('go', ['version'], { stdio: 'ignore' }).status !== 0) {
    console.warn('!! Go not found — packaged without lwb (the AI agents command line)');
    return null;
  }
  mkdirSync(path.dirname(out), { recursive: true });
  go(['build', '-trimpath', '-buildvcs=false', '-ldflags', `-s -w -X main.version=${PKG.version}`, '-o', out, './lwb'], { GOOS: platform === 'win32' ? 'windows' : platform, GOARCH: arch === 'arm64' ? 'arm64' : 'amd64' });
  console.log(`==> ${out}`);
  return out;
}

/** winres.exe (Windows resource editor used while packaging). Needs Go. */
function buildTools() {
  mkdirSync(path.join(DESKTOP, 'tools', 'bin'), { recursive: true });
  go(['build', '-trimpath', '-buildvcs=false', '-ldflags', '-s -w', '-o', path.join(DESKTOP, 'tools', 'bin', 'winres.exe'), './winres'], { GOOS: 'windows', GOARCH: 'amd64' });
}

/** LudworksBrowserSetup-<version>-win-<arch>.exe: Go installer with the packaged browser embedded. */
export function windowsInstaller(target) {
  const [, arch] = target.split('-');
  const appDir = path.join(DESKTOP, 'dist', target, PRODUCT);
  if (!existsSync(appDir)) throw new Error(`package ${target} first`);
  console.log('==> zipping payload');
  const entries = [];
  const walk = (dir, rel) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(p, r);
      else entries.push({ name: r, data: readFileSync(p) });
    }
  };
  walk(appDir, '');
  const payloadDir = path.join(DESKTOP, 'tools', 'setup', 'payload');
  mkdirSync(payloadDir, { recursive: true });
  writeFileSync(path.join(payloadDir, 'payload.zip'), createZip(entries, { level: 9 }));
  const syso = path.join(DESKTOP, 'tools', 'setup', `rsrc_windows_${arch === 'arm64' ? 'arm64' : 'amd64'}.syso`);
  go(['run', './winres', 'syso', '-version', PKG.version, '-arch', arch === 'arm64' ? 'arm64' : 'amd64', '-icon', path.join(DESKTOP, 'build-res', 'icon.ico'), '-out', syso, '-description', `${PRODUCT} Setup`]);
  const out = path.join(DESKTOP, 'dist', `LudworksBrowserSetup-${PKG.version}-win-${arch}.exe`);
  try {
    go(['build', '-trimpath', '-buildvcs=false', '-ldflags', '-s -w -H=windowsgui', '-o', out, './setup'], { GOOS: 'windows', GOARCH: arch === 'arm64' ? 'arm64' : 'amd64' });
  } finally {
    rmSync(syso, { force: true });
    rmSync(path.join(payloadDir, 'payload.zip'), { force: true });
  }
  const sum = sha256(readFileSync(out));
  writeFileSync(`${out}.sha256`, `${sum}  ${path.basename(out)}
`);
  console.log(`==> ${out}
    sha256 ${sum}`);
  return out;
}

// -------------------------------------------------------------------------------------- linux
const LINUX_EXEC = new Set(['ludworks-browser', 'chrome-sandbox', 'chrome_crashpad_handler', 'lwb']);

function listFiles(root) {
  const out = [];
  const walk = (dir, rel) => {
    for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const p = path.join(dir, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        out.push({ rel: r, dir: true });
        walk(p, r);
      } else out.push({ rel: r, abs: p, mode: LINUX_EXEC.has(r) ? 0o755 : 0o644 });
    }
  };
  walk(root, '');
  return out;
}

/** ludworks-browser-<v>-linux-<arch>.tar.gz and ludworks-browser_<v>_<debarch>.deb (pure Go mkdeb). */
export function linuxPackages(target) {
  const [, arch] = target.split('-');
  const debArch = arch === 'arm64' ? 'arm64' : 'amd64';
  const appDir = path.join(DESKTOP, 'dist', target, PRODUCT);
  const files = listFiles(appDir);
  const mtime = Number(process.env.SOURCE_DATE_EPOCH || 0);
  const top = 'ludworks-browser';
  const tar = createTar([{ name: top, dir: true }, ...files.map((f) => (f.dir ? { name: `${top}/${f.rel}`, dir: true } : { name: `${top}/${f.rel}`, data: readFileSync(f.abs), mode: f.mode }))], { mtime });
  const tgz = path.join(DESKTOP, 'dist', `ludworks-browser-${PKG.version}-linux-${arch}.tar.gz`);
  writeFileSync(tgz, gzipSync(tar, { level: 9 }));
  console.log(`==> ${tgz}`);
  // .deb
  const pk = path.join(DESKTOP, 'packaging', 'linux');
  const spec = {
    control: path.join(pk, 'control'),
    files: [
      ...files.filter((f) => !f.dir && !/\.desktop$|^ludworks-browser\.png$/.test(f.rel)).map((f) => ({ src: f.abs, dst: `/opt/ludworks-browser/${f.rel}`, mode: f.mode === 0o755 ? '0755' : '0644' })),
      { src: path.join(appDir, 'ludworks-browser.desktop'), dst: '/usr/share/applications/ludworks-browser.desktop', mode: '0644' },
      ...[16, 24, 32, 48, 64, 128, 256, 512].map((s) => ({ src: path.join(DESKTOP, 'src', 'assets', 'icons', `icon-${s}.png`), dst: `/usr/share/icons/hicolor/${s}x${s}/apps/ludworks-browser.png`, mode: '0644' })),
      { src: path.join(DESKTOP, 'src', 'assets', 'logo.svg'), dst: '/usr/share/icons/hicolor/scalable/apps/ludworks-browser.svg', mode: '0644' },
      { src: path.join(pk, 'apparmor'), dst: '/etc/apparmor.d/ludworks-browser', mode: '0644', conffile: true },
    ],
    dirs: [{ dst: '/opt/ludworks-browser', mode: '0755' }, ...files.filter((f) => f.dir).map((f) => ({ dst: `/opt/ludworks-browser/${f.rel}`, mode: '0755' }))],
    scripts: { postinst: path.join(pk, 'postinst'), prerm: path.join(pk, 'prerm'), postrm: path.join(pk, 'postrm') },
  };
  const specPath = path.join(DESKTOP, 'build', `deb-${debArch}.json`);
  mkdirSync(path.dirname(specPath), { recursive: true });
  writeFileSync(specPath, JSON.stringify(spec, null, 2));
  const deb = path.join(DESKTOP, 'dist', `ludworks-browser_${PKG.version}_${debArch}.deb`);
  go(['run', './mkdeb', 'build', '-spec', specPath, '-version', PKG.version, '-arch', debArch, '-out', deb], { SOURCE_DATE_EPOCH: String(mtime || 1) });
  for (const f of [tgz, deb]) writeFileSync(`${f}.sha256`, `${sha256(readFileSync(f))}  ${path.basename(f)}
`);
  console.log(`==> ${deb}`);
  return { tgz, deb };
}

// ---------------------------------------------------------------------------------------- main
async function main() {
  const cmd = process.argv[2] || 'stage';
  const target = arg('target', defaultTarget());
  if (cmd === 'stage') console.log(await stage(arg('out', '') ? path.resolve(arg('out', '')) : undefined));
  else if (cmd === 'fetch') console.log(await fetchEngine(target));
  else if (cmd === 'tools') buildTools();
  else if (cmd === 'lwb') {
    // for development: desktop/tools/bin/lwb(.exe), found by an unpackaged browser
    await writeLwbCatalog();
    buildLwb(target, path.join(DESKTOP, 'tools', 'bin', target.startsWith('win32') ? 'lwb.exe' : 'lwb'));
  }
  else if (cmd === 'package') await packageTarget(target);
  else if (cmd === 'installer') windowsInstaller(target);
  else if (cmd === 'all') {
    if (target.startsWith('win32')) buildTools();
    await packageTarget(target);
    if (target.startsWith('win32')) windowsInstaller(target);
    if (target.startsWith('linux')) linuxPackages(target);
  } else if (cmd === 'linux-packages') linuxPackages(target);
  else {
    console.error(`unknown command ${cmd}`);
    process.exit(2);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e.stack || e.message);
    process.exit(1);
  });
}

export { statSync };
