// import.* / export.* commands for the internal pages (passwords, bookmarks, settings, welcome).
// Files are only ever read from / written to paths the user picked in a native dialog.

import { dialog, BrowserWindow } from 'electron';
import { writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { detectFormat, needsPassword, parseImport, serializeExport } from './vault-io.js';
import { importSources, loadFromBrowser, parseBookmarksHtml, parseChromiumBookmarks, toBookmarksHtml, readSmallFile } from './browsers.js';
import { normalizeFolderPath } from '../../vendor/vault/convert.js';

const pending = new Map(); // token → {buf, name, format, parsed?, at}
const TTL = 10 * 60 * 1000;

function sweep() {
  for (const [k, v] of pending) if (Date.now() - v.at > TTL) pending.delete(k);
}

function winOf(tab) {
  return tab && tab.ctl && tab.ctl.win && !tab.ctl.win.isDestroyed() ? tab.ctl.win : BrowserWindow.getFocusedWindow();
}

function ok(value) {
  return { ok: true, value };
}
function fail(e) {
  return { ok: false, error: { code: (e && e.code) || 'error', message: (e && e.message) || String(e) } };
}

/** Vault interchange data from the unlocked vault (for export). */
async function vaultData(account) {
  const { items, folders } = await account.vault.list();
  const data = { folders: [...folders].map(([id, name]) => ({ id, name })), items: [] };
  for (const { data: d, vi } of items.values()) {
    if (!d) continue;
    const { seq, folder_id, ...rest } = d; // vault bookkeeping is never exported (VAULT-CRYPTO §3)
    void seq;
    void folder_id;
    data.items.push({ ...rest, folderPath: (vi.folder_id && folders.get(vi.folder_id)) || '' });
  }
  return data;
}

export async function importExportCommand(b, tab, cmd, a) {
  sweep();
  try {
    switch (cmd) {
      // ---------------------------------------------------------------- passwords: import
      case 'import.vault.pick': {
        const r = await dialog.showOpenDialog(winOf(tab), {
          title: 'Import passwords',
          properties: ['openFile'],
          filters: [{ name: 'Password exports', extensions: ['json', 'csv', 'kdbx', 'xml'] }, { name: 'All files', extensions: ['*'] }],
        });
        if (r.canceled || !r.filePaths[0]) return ok(null);
        const buf = readSmallFile(r.filePaths[0]);
        const format = detectFormat(buf);
        const token = randomUUID();
        pending.set(token, { buf, name: path.basename(r.filePaths[0]), format, at: Date.now() });
        return ok({ token, name: path.basename(r.filePaths[0]), format, needsPassword: needsPassword(format, buf) });
      }
      case 'import.vault.preview': {
        const p = pending.get(String(a.token));
        if (!p) throw new Error('Pick the file again.');
        p.parsed = await parseImport(p.buf, { format: p.format, password: typeof a.password === 'string' && a.password ? a.password : undefined });
        p.buf = null; // decrypted content is kept only until the import runs
        const types = {};
        let passkeys = 0;
        for (const it of p.parsed.items) {
          types[it.type] = (types[it.type] || 0) + 1;
          passkeys += it.login && Array.isArray(it.login.passkeys) ? it.login.passkeys.length : 0;
        }
        return ok({ items: p.parsed.items.length, folders: p.parsed.folders.length, types, passkeys, warnings: p.parsed.warnings.slice(0, 50) });
      }
      case 'import.vault.commit': {
        const p = pending.get(String(a.token));
        if (!p || !p.parsed) throw new Error('Nothing to import.');
        pending.delete(String(a.token));
        const acct = b.account;
        const folderIds = new Map();
        for (const it of p.parsed.items) {
          const fp = normalizeFolderPath(it.folderPath || '');
          if (fp && !folderIds.has(fp)) folderIds.set(fp, await acct.vault.ensureFolder(acct.acc, fp));
        }
        const entries = p.parsed.items.map(({ folderPath, ...data }) => ({ data, folderId: folderIds.get(normalizeFolderPath(folderPath || '')) || null }));
        const res = await acct.vault.importBatch(acct.acc, entries);
        b.autofill.refreshAll();
        return ok({ created: res.created, errors: res.errors.slice(0, 50), warnings: p.parsed.warnings.slice(0, 50) });
      }
      case 'import.vault.cancel':
        pending.delete(String(a.token));
        return ok(null);

      // ---------------------------------------------------------------- passwords: export
      case 'export.vault': {
        const acct = b.account;
        if (!(await acct.vault.verifyPassword(String(a.masterPassword || '')))) throw new Error('Wrong master password.');
        const format = String(a.format);
        const ext = format === 'bitwarden-csv' ? 'csv' : format === 'kdbx' ? 'kdbx' : 'json';
        const stamp = new Date().toISOString().slice(0, 10);
        const r = await dialog.showSaveDialog(winOf(tab), { title: 'Export passwords', defaultPath: `ludworks_export_${stamp}.${ext}`, filters: [{ name: ext.toUpperCase(), extensions: [ext] }] });
        if (r.canceled || !r.filePath) return ok(null);
        const out = await serializeExport(format, await vaultData(acct), { password: typeof a.filePassword === 'string' ? a.filePassword : undefined });
        writeFileSync(r.filePath, typeof out === 'string' ? out : Buffer.from(out), { mode: 0o600 });
        return ok({ path: r.filePath });
      }

      // ------------------------------------------------------------------------ bookmarks
      case 'import.sources':
        return ok(importSources());
      case 'import.browser': {
        const src = loadFromBrowser(String(a.browser));
        const done = { bookmarks: 0, history: 0, name: src.name };
        if (a.bookmarks !== false && src.bookmarks) {
          done.bookmarks += b.bookmarks.importNodes(src.bookmarks.toolbar, { parent: 'toolbar', folderTitle: `Imported from ${src.name}` });
          done.bookmarks += b.bookmarks.importNodes(src.bookmarks.other, { parent: 'other', folderTitle: `Other bookmarks (${src.name})` });
        }
        if (a.history !== false && src.history) {
          const rows = src.history();
          b.db.tx(() => {
            for (const r of rows) {
              for (const at of r.visits.length ? [...r.visits].reverse() : []) b.history.addVisit({ url: r.url, title: r.title, typed: false, at });
            }
          });
          done.history = rows.length;
        }
        return ok(done);
      }
      case 'import.bookmarks.file': {
        const r = await dialog.showOpenDialog(winOf(tab), { title: 'Import bookmarks', properties: ['openFile'], filters: [{ name: 'Bookmark files', extensions: ['html', 'htm', 'json'] }] });
        if (r.canceled || !r.filePaths[0]) return ok(null);
        const text = readSmallFile(r.filePaths[0]).toString('utf8');
        let n = 0;
        if (/^\s*\{/.test(text)) {
          const c = parseChromiumBookmarks(text);
          n += b.bookmarks.importNodes([...c.toolbar, ...c.other], { parent: 'other', folderTitle: 'Imported bookmarks' });
        } else n += b.bookmarks.importNodes(parseBookmarksHtml(text), { parent: 'other', folderTitle: 'Imported bookmarks' });
        return ok({ bookmarks: n });
      }
      case 'export.bookmarks': {
        const r = await dialog.showSaveDialog(winOf(tab), { title: 'Export bookmarks', defaultPath: `bookmarks_${new Date().toISOString().slice(0, 10)}.html`, filters: [{ name: 'HTML', extensions: ['html'] }] });
        if (r.canceled || !r.filePath) return ok(null);
        writeFileSync(r.filePath, toBookmarksHtml(b.bookmarks.tree()));
        return ok({ path: r.filePath });
      }
      default:
        throw new Error(`unknown command ${cmd}`);
    }
  } catch (e) {
    return fail(e);
  }
}
