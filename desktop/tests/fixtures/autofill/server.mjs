// Local fixture server for manual / CDP-driven autofill testing (zero dependencies).
//   node desktop/tests/fixtures/autofill/server.mjs [port=18120] [framePort=18121]
// Serves this folder on 127.0.0.1:<port> (open http://127.0.0.1:<port>/) and on <framePort> (the
// cross-origin iframe: http://localhost:<framePort>/frame-login.html, a different site than 127.0.0.1).
// POST /login, /change and /signup answer with a small HTML page; POST /api/login with JSON. Submitted
// values are never logged or stored.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json' };
const ports = process.argv.slice(2).map(Number).filter(Boolean);
if (!ports.length) ports.push(18120, 18121);

function handler(req, res) {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'POST') {
    req.resume();
    req.on('end', () => {
      if (url.pathname.startsWith('/api/')) {
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      res.writeHead(200, { 'content-type': TYPES['.html'], 'cache-control': 'no-store' });
      res.end(`<!doctype html><meta charset="utf-8"><title>Done: ${url.pathname.slice(1)}</title><h1 id="done">Done (${url.pathname.slice(1)})</h1><p><a href="/">Back to the fixtures</a></p>`);
    });
    return;
  }
  let p = decodeURIComponent(url.pathname);
  if (p.endsWith('/')) p += 'index.html';
  const file = path.join(DIR, path.normalize(p).replace(/^([/\\])+/, ''));
  if (!file.startsWith(DIR) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
    return;
  }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
  fs.createReadStream(file).pipe(res);
}

for (const port of ports) {
  http.createServer(handler).listen(port, '127.0.0.1', () => console.log(`autofill fixtures on http://127.0.0.1:${port}/`));
}
