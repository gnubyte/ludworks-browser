// Downloads: saved straight to the downloads folder (unique names), progress in the toolbar bubble,
// history in the profile DB. Potentially dangerous file types are flagged and never opened without
// an explicit second click.

import { EventEmitter } from 'node:events';
import { app, shell, dialog } from 'electron';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { downloadsDir } from './paths.js';

const DANGEROUS = new Set([
  '.exe', '.msi', '.msix', '.appx', '.bat', '.cmd', '.com', '.scr', '.ps1', '.psm1', '.vbs', '.vbe', '.js', '.jse', '.wsf', '.wsh', '.hta',
  '.lnk', '.reg', '.dll', '.cpl', '.jar', '.app', '.dmg', '.pkg', '.sh', '.command', '.deb', '.rpm', '.appimage', '.iso', '.img', '.vhd', '.vhdx', '.msp', '.scf', '.url',
]);

export function isDangerous(filename) {
  return DANGEROUS.has(path.extname(filename).toLowerCase());
}

function sanitizeName(name) {
  let n = String(name || 'download').replace(/[\u0000-\u001f<>:"/\\|?*‪-‮⁦-⁩]/g, '_').trim();
  n = n.replace(/[. ]+$/, '');
  if (!n || /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(n)) n = `_${n || 'download'}`;
  return n.slice(0, 200);
}

function uniquePath(dir, name) {
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  let p = path.join(dir, name);
  for (let i = 1; existsSync(p) && i < 1000; i++) p = path.join(dir, `${base} (${i})${ext}`);
  return p;
}

export class Downloads extends EventEmitter {
  /** @param {{db: import('./profile/db.js').ProfileDb, prefs: import('./profile/prefs.js').Prefs}} o */
  constructor({ db, prefs }) {
    super();
    this.db = db;
    this.prefs = prefs;
    this.active = new Map(); // id → {item, state}
    this.unseen = 0;
    // Interrupted downloads from a previous run are not resumable here; mark them.
    db.run("UPDATE downloads SET state = 'interrupted' WHERE state = 'progressing'");
  }

  /** @param {Electron.Session} ses */
  attach(ses, { isPrivate = false } = {}) {
    ses.on('will-download', (_e, item, wc) => this.onWillDownload(item, wc, isPrivate));
  }

  onWillDownload(item, wc, isPrivate) {
    const id = randomUUID();
    const dir = this.prefs.get('downloadsDir') || downloadsDir();
    const name = sanitizeName(item.getFilename());
    // silentFor (set by the AI agents feature): an agent's tab cannot answer a save dialog
    if (this.prefs.get('askWhereToSave') && !(this.silentFor && this.silentFor(wc))) {
      const res = dialog.showSaveDialogSync({ defaultPath: path.join(dir, name) });
      if (!res) {
        item.cancel();
        return;
      }
      item.setSavePath(res);
    } else {
      item.setSavePath(uniquePath(dir, name));
    }
    const rec = {
      id,
      url: item.getURL(),
      path: item.getSavePath(),
      filename: path.basename(item.getSavePath()),
      mime: item.getMimeType() || '',
      total: item.getTotalBytes(),
      received: 0,
      state: 'progressing',
      started_at: Date.now(),
      ended_at: null,
      dangerous: isDangerous(item.getSavePath()),
      private: isPrivate,
      paused: false,
    };
    this.active.set(id, { item, rec });
    if (!isPrivate) {
      this.db.run(
        'INSERT INTO downloads (id, url, path, filename, mime, total, received, state, started_at) VALUES (?,?,?,?,?,?,?,?,?)',
        id, rec.url.slice(0, 8192), rec.path, rec.filename, rec.mime, rec.total, 0, rec.state, rec.started_at,
      );
    }
    this.unseen++;
    let lastEmit = 0;
    item.on('updated', (_ev, state) => {
      rec.received = item.getReceivedBytes();
      rec.total = item.getTotalBytes();
      rec.paused = item.isPaused();
      rec.state = state === 'interrupted' ? 'interrupted' : 'progressing';
      const now = Date.now();
      if (now - lastEmit > 250) {
        lastEmit = now;
        this.emit('change', { started: false });
      }
    });
    item.once('done', (_ev, state) => {
      rec.received = item.getReceivedBytes();
      rec.state = state; // completed | cancelled | interrupted
      rec.ended_at = Date.now();
      this.active.delete(id);
      if (!isPrivate) this.db.run('UPDATE downloads SET received = ?, total = ?, state = ?, ended_at = ? WHERE id = ?', rec.received, rec.total, rec.state, rec.ended_at, id);
      else this.recentPrivate = [rec, ...(this.recentPrivate || [])].slice(0, 20);
      if (state === 'completed' && process.platform === 'darwin') {
        if (app.dock) app.dock.downloadFinished(rec.path);
      }
      this.emit('change', { finished: rec });
    });
    this.emit('change', { started: rec, webContents: wc });
  }

  list(limit = 50) {
    const live = [...this.active.values()].map((a) => a.rec);
    const done = this.db.all('SELECT * FROM downloads WHERE state <> ? ORDER BY started_at DESC LIMIT ?', 'progressing', limit).map((r) => ({
      ...r,
      dangerous: isDangerous(r.filename),
      exists: existsSync(r.path),
    }));
    return [...live, ...(this.recentPrivate || []), ...done].slice(0, limit);
  }

  summary() {
    const live = [...this.active.values()].map((a) => a.rec);
    const total = live.reduce((s, r) => s + (r.total || 0), 0);
    const received = live.reduce((s, r) => s + (r.received || 0), 0);
    return { active: live.length, progress: total > 0 ? received / total : null, unseen: this.unseen, any: live.length > 0 || this.db.get('SELECT 1 AS x FROM downloads LIMIT 1') !== undefined };
  }

  markSeen() {
    if (this.unseen) {
      this.unseen = 0;
      this.emit('change', {});
    }
  }

  action(id, act) {
    const a = this.active.get(id);
    if (a) {
      if (act === 'pause') a.item.pause();
      else if (act === 'resume' && a.item.canResume()) a.item.resume();
      else if (act === 'cancel') a.item.cancel();
      this.emit('change', {});
      return;
    }
    const r = this.db.get('SELECT * FROM downloads WHERE id = ?', id) || (this.recentPrivate || []).find((x) => x.id === id);
    if (!r) return;
    if (act === 'show') shell.showItemInFolder(r.path);
    else if (act === 'open') shell.openPath(r.path);
    else if (act === 'remove') {
      this.db.run('DELETE FROM downloads WHERE id = ?', id);
      this.emit('change', {});
    }
  }

  clear() {
    this.clearSince(0);
  }

  /** Forgets finished downloads started at or after `since` (ms; 0 = all). Files stay on disk. */
  clearSince(since = 0) {
    this.db.run("DELETE FROM downloads WHERE state <> 'progressing' AND started_at >= ?", since);
    this.recentPrivate = (this.recentPrivate || []).filter((r) => r.started_at < since);
    this.emit('change', {});
  }
}
