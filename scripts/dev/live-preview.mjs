#!/usr/bin/env node
// Dev-only: the BUILT popup against a LIVE Ludworks server, in an ordinary browser tab.
//
//   node build.mjs --no-zip
//   node scripts/dev/live-preview.mjs --server=http://127.0.0.1:18104 [--port=18197] [--target=chrome]
//   open http://127.0.0.1:18197/popup/popup.html?url=https://github.com/login
//
// Serves dist/<target>/ with the extension's CSP. popup.html loads scripts/dev/live-harness.js first, which
// installs a fake `chrome` namespace whose runtime.sendMessage runs the REAL background core + handlers in
// the page (storage.local → localStorage, storage.session → sessionStorage). The core's requests to the
// configured server are routed through /__server/ on this origin: this process forwards them with an
// `Origin: chrome-extension://…` header and no cookies, i.e. what a background fetch with the server's host
// permission looks like. Only the configured server is reachable (not an open proxy). Never packaged.

import http from 'node:http';
import https from 'node:https';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const arg = (name, def) => {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : def;
};
const PORT = Number(arg('port', '18197'));
const TARGET = arg('target', 'chrome');
const SERVER = new URL(arg('server', 'http://127.0.0.1:18104'));
const EXT_ORIGIN = TARGET === 'firefox' ? 'moz-extension://7f3a9c2e-1b4d-4e6f-8a0b-2c3d4e5f6a7b' : 'chrome-extension://kdhgflmnbcjpcmdnhcjbmhakakhokfli';
const DIST = path.join(ROOT, 'dist', TARGET);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.json': 'application/json' };
const CSP = "default-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; img-src 'self'; style-src 'self'; connect-src 'self'";

function proxy(req, res, rest) {
  const target = new URL(rest, SERVER.origin);
  if (target.origin !== SERVER.origin || !target.pathname.startsWith('/api/v1/')) {
    res.writeHead(403).end('only the configured server API is proxied');
    return;
  }
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (['host', 'cookie', 'origin', 'referer', 'connection'].includes(k) || k.startsWith('sec-')) continue;
    headers[k] = v;
  }
  headers.origin = EXT_ORIGIN;
  const mod = target.protocol === 'https:' ? https : http;
  const up = mod.request(target, { method: req.method, headers, rejectUnauthorized: false, agent: false }, (ur) => {
    const out = { ...ur.headers };
    delete out['set-cookie'];
    delete out['content-security-policy'];
    res.writeHead(ur.statusCode, out);
    ur.pipe(res);
  });
  up.on('error', (e) => {
    res.writeHead(502, { 'content-type': 'text/plain' }).end(String(e.message));
  });
  req.pipe(up);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  if (url.pathname.startsWith('/__server/')) return proxy(req, res, url.pathname.slice('/__server'.length) + url.search);
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || rel === '') {
    res.writeHead(302, { Location: '/popup/popup.html' }).end();
    return;
  }
  let file;
  if (rel === '/__dev/live-harness.js') file = path.join(ROOT, 'scripts', 'dev', 'live-harness.js');
  else file = path.resolve(DIST, `.${rel}`);
  if (!file.startsWith(DIST + path.sep) && !file.endsWith(`${path.sep}live-harness.js`)) {
    res.writeHead(404).end('not found');
    return;
  }
  try {
    let body = await readFile(file);
    if (rel === '/popup/popup.html') {
      body = Buffer.from(body.toString('utf8').replace('<script type="module" src="popup.js"></script>', '<script type="module" src="/__dev/live-harness.js"></script>'));
    }
    if (rel === '/__dev/live-harness.js') {
      body = Buffer.from(body.toString('utf8').replace('__SERVER_ORIGIN__', SERVER.origin).replace('__EXT_ORIGIN__', EXT_ORIGIN).replace('__TARGET__', TARGET));
    }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store', 'Content-Security-Policy': CSP });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Live popup preview (${TARGET} build → ${SERVER.origin}): http://127.0.0.1:${PORT}/popup/popup.html?url=https://github.com/login`);
});
