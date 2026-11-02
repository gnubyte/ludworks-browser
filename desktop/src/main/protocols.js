// lwshell:// (browser UI) and ludworks:// (internal pages) are served from the app directory with a
// strict CSP. Only files under the allowed folders are served; everything else is 404.
//
//   lwshell://ui/<file>            src/shell/<file>
//   ludworks://<page>/             src/pages/<page>.html (and its scripts/styles by relative path)
//   <either>://<host>/assets/…     src/assets/… (same-origin, so a strict img-src 'self' still works)
//   <either>://<host>/lib/…        shared vault libraries (ES modules)
//   lwshell://ui/_theme/…, ludworks://newtab/_theme/…   the current Chrome theme's images (themes/themes.js)

import { net } from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { existsSync, statSync } from 'node:fs';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
};

const CSP_SHELL = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const CSP_PAGE = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/** Internal pages: ludworks://<page>/ → src/pages/<page>.html (and its assets). */
export const INTERNAL_PAGES = Object.freeze(['newtab', 'settings', 'passwords', 'bookmarks', 'history', 'downloads', 'about', 'welcome', 'sync', 'extensions']);

const notFound = () => new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain' } });

async function respond(file, csp) {
  const type = MIME[path.extname(file).toLowerCase()];
  if (!type || !existsSync(file) || !statSync(file).isFile()) return notFound();
  const res = await net.fetch(pathToFileURL(file).toString());
  return new Response(await res.arrayBuffer(), {
    status: 200,
    headers: {
      'Content-Type': type,
      'Content-Security-Policy': csp,
      'X-Content-Type-Options': 'nosniff',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Cache-Control': 'no-cache',
      'Referrer-Policy': 'no-referrer',
    },
  });
}

function safeJoin(root, rel) {
  const p = path.resolve(root, rel);
  return p === root || p.startsWith(root + path.sep) ? p : null;
}

function shared(appDir, rel, csp) {
  if (rel.startsWith('assets/')) {
    const f = safeJoin(path.join(appDir, 'assets'), rel.slice(7));
    return f ? respond(f, csp) : notFound();
  }
  if (rel.startsWith('lib/')) {
    const f = safeJoin(path.join(appDir, 'lib'), rel.slice(4));
    return f ? respond(f, csp) : notFound();
  }
  return null;
}

/**
 * @param {Electron.Session} ses
 * @param {string} appDir
 * @param {{shell: boolean, pages: boolean, themeFile?: (rel: string) => string|null}} which
 */
export function registerProtocols(ses, appDir, { shell, pages, themeFile = () => null }) {
  const theme = (rel, csp) => {
    const f = themeFile(rel.slice('_theme/'.length));
    return f ? respond(f, csp) : notFound();
  };
  const shellRoot = path.join(appDir, 'shell');
  const pagesRoot = path.join(appDir, 'pages');
  if (shell && !ses.protocol.isProtocolHandled('lwshell')) {
    ses.protocol.handle('lwshell', (req) => {
      const u = new URL(req.url);
      if (u.host !== 'ui') return notFound();
      const rel = decodeURIComponent(u.pathname).replace(/^\/+/, '');
      if (rel.startsWith('_theme/')) return theme(rel, CSP_SHELL);
      const s = shared(appDir, rel, CSP_SHELL);
      if (s) return s;
      const f = safeJoin(shellRoot, rel);
      return f ? respond(f, CSP_SHELL) : notFound();
    });
  }
  if (pages && !ses.protocol.isProtocolHandled('ludworks')) {
    ses.protocol.handle('ludworks', (req) => {
      const u = new URL(req.url);
      if (!INTERNAL_PAGES.includes(u.host)) return notFound();
      let rel = decodeURIComponent(u.pathname).replace(/^\/+/, '');
      if (rel.startsWith('_theme/')) return u.host === 'newtab' ? theme(rel, CSP_PAGE) : notFound();
      const s = shared(appDir, rel, CSP_PAGE);
      if (s) return s;
      if (!rel) rel = `${u.host}.html`;
      const f = safeJoin(pagesRoot, rel);
      return f ? respond(f, CSP_PAGE) : notFound();
    });
  }
}
