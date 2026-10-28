// The import run behind the passwords page (no Electron APIs here, so it is unit-tested in plain Node):
// preview (counts, warnings, attachments, duplicates against the unlocked vault) and commit (folders → batch
// create with progress → merges), export data collection, and writing ZIP attachments into a folder.

import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { openImport, mapImport } from './vault-io.js';
import { planImport } from './dedupe.js';
import { normalizeFolderPath } from '../../vendor/vault/convert.js';
import { validateItemData } from '../../lib/item-model.js';

export const LIST_MAX = 300;

function fail(code, message) {
  return Object.assign(new Error(message), { code });
}

export function requireUnlocked(b) {
  const phase = b.account.phase();
  if (phase !== 'unlocked') throw fail('locked', phase === 'logged_out' ? 'Sign in to Ludworks first.' : 'Unlock your vault first.');
}

/** Decrypted vault items usable for duplicate checks (stale / undecryptable ones are never merge targets). */
export async function existingItems(b) {
  const { items, folders } = await b.account.vault.list();
  const out = [];
  for (const e of items.values()) if (e.data && !e.stale) out.push({ id: e.vi.id, revision: e.vi.revision, data: e.data, updatedAt: e.vi.updated_at });
  return { items: out, folders };
}

export function withDestination(items, dest) {
  const d = normalizeFolderPath(dest);
  return d ? items.map((it) => ({ ...it, folderPath: normalizeFolderPath(`${d}/${it.folderPath || ''}`) })) : items;
}

/** Vault interchange data from the unlocked vault (for export); item ids are kept as Bitwarden ids. */
export async function vaultData(account) {
  const { items, folders } = await account.vault.list();
  const data = { folders: [...folders].map(([id, name]) => ({ id, name })), items: [] };
  for (const { data: d, vi } of items.values()) {
    if (!d) continue;
    const { seq, folder_id, ...rest } = d; // vault bookkeeping is never exported (VAULT-CRYPTO §3)
    void seq;
    void folder_id;
    data.items.push({ ...rest, id: vi.id, folderPath: (vi.folder_id && folders.get(vi.folder_id)) || '' });
  }
  return data;
}

/**
 * Decrypt (once) and describe a pending import.
 * @param {object} b  browser (b.account)
 * @param {{buf, format, opened}} p  pending import (p.opened is filled in)
 * @param {{password?: string, includeTrash?: boolean}} a
 */
export async function preview(b, p, a) {
  if (!p.opened) {
    p.opened = await openImport(p.buf, { format: p.format, password: typeof a.password === 'string' && a.password ? a.password : undefined });
    p.buf = null; // decrypted content is kept only until the import runs (ZIP entries keep the archive for attachments)
  }
  const conv = mapImport(p.opened, { includeTrash: a.includeTrash === true });
  const out = {
    format: p.format,
    source: p.opened.bitwarden ? p.opened.bitwarden.source : p.format,
    stats: conv.stats,
    folders: conv.folders.length,
    folderNames: conv.folders.map((f) => f.name).slice(0, LIST_MAX),
    trash: conv.trash || 0,
    warnings: conv.warnings.slice(0, LIST_MAX),
    attachments: (conv.attachments || []).slice(0, LIST_MAX).map(({ item, file, size }) => ({ item, file, size })),
    attachmentCount: (conv.attachments || []).length,
    duplicates: null,
    vaultFolders: [],
  };
  if (b.account.phase() === 'unlocked') {
    const ex = await existingItems(b);
    const skip = planImport(conv.items, ex.items, 'skip');
    const merge = planImport(conv.items, ex.items, 'merge');
    out.duplicates = { exact: skip.skipped.length, mergeTargets: merge.merge.length, mergeItems: merge.merge.reduce((n, m) => n + m.names.length, 0), mergeNothingNew: merge.skipped.length - skip.skipped.length };
    out.vaultFolders = [...new Set(ex.folders.values())].filter(Boolean).sort();
  }
  return out;
}

/**
 * Run the import. Progress is published on p.progress = {phase, done, total} for the page to poll.
 * @param {{duplicates?: 'skip'|'keep'|'merge', folder?: string, includeTrash?: boolean}} a
 */
export async function commit(b, p, a) {
  requireUnlocked(b);
  if (!p.opened) throw fail('not_ready', 'Preview the file first.');
  if (p.running) throw fail('busy', 'This import is already running.');
  const mode = ['skip', 'keep', 'merge'].includes(a.duplicates) ? a.duplicates : 'skip';
  const acct = b.account;
  p.running = true;
  p.progress = { phase: 'preparing', done: 0, total: 0 };
  try {
    const conv = mapImport(p.opened, { includeTrash: a.includeTrash === true });
    const items = withDestination(conv.items, a.folder);
    const ex = await existingItems(b);
    const plan = planImport(items, ex.items, mode);
    const failed = [];
    const create = [];
    for (const it of plan.create) {
      const { folderPath, ...data } = it;
      const problem = validateItemData(data);
      if (problem) failed.push({ name: it.name, error: problem });
      else create.push({ folderPath: normalizeFolderPath(folderPath || ''), data });
    }
    // folders: those the new items need, plus folders that are empty in the export
    const used = new Set(conv.items.map((it) => normalizeFolderPath(it.folderPath || '')));
    const emptyInFile = withDestination(conv.folders.filter((f) => !used.has(f.name)).map((f) => ({ folderPath: f.name })), a.folder).map((f) => f.folderPath);
    const needed = [...new Set([...create.map((c) => c.folderPath), ...emptyInFile])].filter(Boolean);
    const byName = new Map();
    for (const [id, name] of ex.folders) if (name && !byName.has(name)) byName.set(name, id);
    const missing = needed.filter((n) => !byName.has(n));
    p.progress = { phase: 'folders', done: 0, total: missing.length };
    for (const name of missing) {
      byName.set(name, await acct.vault.createFolder(acct.acc, name, { sync: false }));
      p.progress.done++;
    }
    let created = 0;
    p.progress = { phase: 'items', done: 0, total: create.length };
    if (create.length) {
      const res = await acct.vault.importBatch(acct.acc, create.map((c) => ({ data: c.data, folderId: c.folderPath ? byName.get(c.folderPath) || null : null })), {
        onProgress: (done, total) => {
          p.progress = { phase: 'items', done, total };
        },
      });
      created = res.created;
      for (const e of res.errors) failed.push({ name: '', error: e.error });
    } else if (missing.length) await acct.vault.sync(acct.acc);
    let merged = 0;
    p.progress = { phase: 'merging', done: 0, total: plan.merge.length };
    for (const m of plan.merge) {
      try {
        await acct.vault.save(acct.acc, { id: m.id, data: m.data, baseRevision: m.revision });
        merged++;
      } catch (e) {
        failed.push({ name: m.data.name, error: (e && e.message) || String(e) });
      }
      p.progress.done++;
    }
    if (b.autofill) b.autofill.refreshAll();
    p.result = {
      created,
      merged,
      mergedFrom: plan.merge.reduce((n, m) => n + m.names.length, 0),
      skipped: plan.skipped.length,
      foldersCreated: missing.length,
      failed: failed.slice(0, LIST_MAX),
      failedCount: failed.length,
      warnings: conv.warnings.slice(0, LIST_MAX),
      attachmentCount: (conv.attachments || []).length,
    };
    p.progress = { phase: 'done', done: 1, total: 1 };
    return p.result;
  } catch (e) {
    p.progress = { phase: 'error', done: 0, total: 0, error: (e && e.message) || String(e) };
    throw e;
  } finally {
    p.running = false;
  }
}

export function safeName(s, fallback) {
  let n = String(s || '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/, '').replace(/^\.+/, '_').slice(0, 120);
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(n)) n = `_${n}`;
  return n || fallback;
}

function uniquePath(p) {
  if (!existsSync(p)) return p;
  const ext = path.extname(p);
  const base = p.slice(0, p.length - ext.length);
  for (let i = 2; ; i++) if (!existsSync(`${base} (${i})${ext}`)) return `${base} (${i})${ext}`;
}

/** Write a ZIP export's attachments into root/<item name>/<file> (never overwriting). */
export function writeAttachments(p, root) {
  const atts = p.opened && p.opened.bitwarden ? p.opened.bitwarden.attachments : [];
  if (!atts.length) throw fail('none', 'This export has no attachments.');
  const conv = mapImport(p.opened, { includeTrash: true });
  let saved = 0;
  const errors = [];
  for (const a of conv.attachments) {
    try {
      const dir = path.join(root, safeName(a.item, 'Item'));
      mkdirSync(dir, { recursive: true });
      writeFileSync(uniquePath(path.join(dir, safeName(a.file, 'attachment'))), atts[a.index].entry.read(), { mode: 0o600 });
      saved++;
    } catch (e) {
      errors.push(`${a.item} / ${a.file}: ${e.message}`);
    }
  }
  return { saved, dir: root, errors: errors.slice(0, 50) };
}
