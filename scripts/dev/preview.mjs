#!/usr/bin/env node
// Dev-only popup preview: serves the repository over http://127.0.0.1:<port> and rewrites
// /src/popup/popup.html to load scripts/dev/harness.js (fake `chrome` API + real background core + mock
// server) instead of talking to a real browser extension runtime. Node built-ins only; never packaged.
//
//   node scripts/dev/preview.mjs [--port=18097]
//   open http://127.0.0.1:18097/src/popup/popup.html?scenario=unlocked   (login | locked | unlocked)

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const portArg = process.argv.find((a) => a.startsWith('--port='));
const PORT = portArg ? Number(portArg.slice(7)) : 18097;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.json': 'application/json' };
const ALLOWED = [/^\/src\//, /^\/scripts\/dev\/harness\.js$/, /^\/tests\/helpers\/fakes\.mjs$/];

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const rel = decodeURIComponent(url.pathname);
  if (rel === '/' || rel === '') {
    res.writeHead(302, { Location: '/src/popup/popup.html?scenario=unlocked' });
    res.end();
    return;
  }
  const file = path.resolve(ROOT, `.${rel}`);
  if (!file.startsWith(ROOT + path.sep) || !ALLOWED.some((re) => re.test(rel))) {
    res.writeHead(404).end('not found');
    return;
  }
  try {
    let body = await readFile(file);
    if (rel === '/src/popup/popup.html') {
      body = Buffer.from(body.toString('utf8').replace('<script type="module" src="popup.js"></script>', '<script type="module" src="/scripts/dev/harness.js"></script>'));
    }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
      // Same policy as the extension pages (connect-src is irrelevant: the mock server is in-page).
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; img-src 'self'; style-src 'self'",
    });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Popup preview: http://127.0.0.1:${PORT}/src/popup/popup.html?scenario=unlocked  (login | locked | unlocked)`);
});
