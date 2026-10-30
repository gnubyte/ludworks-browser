// Passwords page commands: import.vault.* (pick / drop → inspect → decrypt + preview → import with progress →
// attachments) and export.vault. Files are only read from paths the user picked in a native dialog or bytes the
// user dropped on the page; they are only written to paths picked in a native dialog. The import run itself
// lives in vault-import.js.

import { dialog, BrowserWindow } from 'electron';
import { writeFileSync, statSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { detectFormat, inspectImport, exportVaultFile } from './vault-io.js';
import { preview, commit, vaultData, writeAttachments, requireUnlocked } from './vault-import.js';

const pending = new Map(); // token → {buf, name, size, format, info, opened, at, running, progress, result}
const TTL = 15 * 60 * 1000;
const MAX_FILE = 64 * 1024 * 1024;
const MAX_ZIP = 1024 * 1024 * 1024; // Bitwarden .zip exports carry attachments
const MAX_DROP = 256 * 1024 * 1024; // bytes sent over IPC from a drag-and-drop

function sweep() {
  for (const [k, v] of pending) if (!v.running && Date.now() - v.at > TTL) pending.delete(k);
}

function winOf(tab) {
  return tab && tab.ctl && tab.ctl.win && !tab.ctl.win.isDestroyed() ? tab.ctl.win : BrowserWindow.getFocusedWindow();
}

function fail(code, message) {
  return Object.assign(new Error(message), { code });
}

function entry(token) {
  const p = pending.get(String(token || ''));
  if (!p) throw fail('expired', 'The import was cancelled or timed out. Choose the file again.');
  p.at = Date.now();
  return p;
}

function register(buf, name) {
  const format = detectFormat(buf);
  const info = inspectImport(buf, format);
  const token = randomUUID();
  pending.set(token, { buf, name, size: buf.length, format, info, opened: null, at: Date.now(), running: false, progress: null, result: null });
  return { token, name, size: buf.length, ...info };
}

function readPicked(file) {
  const st = statSync(file);
  const zip = /\.zip$/i.test(file);
  if (st.size > (zip ? MAX_ZIP : MAX_FILE)) throw fail('too_large', `This file is too large to import (${zip ? '1 GB' : '64 MB'} max).`);
  return readFileSync(file);
}

/** import.vault.* and export.vault for the passwords page. Returns the value or throws. */
export async function vaultImportExport(b, tab, cmd, a) {
  sweep();
  switch (cmd) {
    case 'import.vault.pick': {
      const r = await dialog.showOpenDialog(winOf(tab), {
        title: 'Import passwords',
        properties: ['openFile'],
        filters: [{ name: 'Password exports', extensions: ['json', 'zip', 'csv', 'kdbx', 'xml'] }, { name: 'All files', extensions: ['*'] }],
      });
      if (r.canceled || !r.filePaths[0]) return null;
      return register(readPicked(r.filePaths[0]), path.basename(r.filePaths[0]));
    }
    case 'import.vault.load': {
      // a file dropped on the passwords page (the page cannot know paths; it sends the bytes)
      const d = a.data;
      if (!(d instanceof Uint8Array) && !(d instanceof ArrayBuffer)) throw fail('bad_request', 'No file data.');
      const buf = Buffer.from(d instanceof ArrayBuffer ? new Uint8Array(d) : d);
      if (!buf.length) throw fail('bad_request', 'The file is empty.');
      if (buf.length > MAX_DROP) throw fail('too_large', 'This file is too large to drop here; use “Choose file…” instead.');
      return register(buf, String(a.name || 'dropped file').slice(0, 200));
    }
    case 'import.vault.preview':
      return preview(b, entry(a.token), a);
    case 'import.vault.commit':
      return commit(b, entry(a.token), a);
    case 'import.vault.status': {
      const p = pending.get(String(a.token || ''));
      return p ? { progress: p.progress, running: p.running } : null;
    }
    case 'import.vault.attachments': {
      const p = entry(a.token);
      const r = await dialog.showOpenDialog(winOf(tab), { title: 'Save Bitwarden attachments to…', properties: ['openDirectory', 'createDirectory'] });
      if (r.canceled || !r.filePaths[0]) return null;
      return writeAttachments(p, r.filePaths[0]);
    }
    case 'import.vault.cancel': {
      const p = pending.get(String(a.token || ''));
      if (p && !p.running) pending.delete(String(a.token));
      return null;
    }
    case 'export.vault': {
      requireUnlocked(b);
      const acct = b.account;
      if (!(await acct.vault.verifyPassword(String(a.masterPassword || '')))) throw fail('bad_password', 'Wrong master password.');
      const format = String(a.format);
      if (format === 'bitwarden-json-protected' && !a.filePassword) throw fail('password_required', 'Choose a password for the exported file.');
      const ext = format === 'bitwarden-csv' ? 'csv' : format === 'kdbx' ? 'kdbx' : 'json';
      const stamp = new Date().toISOString().slice(0, 10);
      const r = await dialog.showSaveDialog(winOf(tab), { title: 'Export passwords', defaultPath: `ludworks_export_${stamp}.${ext}`, filters: [{ name: ext.toUpperCase(), extensions: [ext] }] });
      if (r.canceled || !r.filePath) return null;
      const data = await vaultData(acct);
      const res = await exportVaultFile(format, data, { password: typeof a.filePassword === 'string' && a.filePassword ? a.filePassword : undefined, kdf: a.kdf === 'argon2id' ? 'argon2id' : 'pbkdf2' });
      writeFileSync(r.filePath, typeof res.out === 'string' ? res.out : Buffer.from(res.out), { mode: 0o600 });
      return { path: r.filePath, items: data.items.length, warnings: res.warnings.slice(0, 50) };
    }
    default:
      throw fail('bad_request', `unknown command ${cmd}`);
  }
}
