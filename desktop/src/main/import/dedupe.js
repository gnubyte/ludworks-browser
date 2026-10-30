// Duplicate handling for vault imports.
//
//   skip  — an imported item whose content (type, name, notes, login/card/identity values, URIs, TOTP, passkeys,
//           custom fields) equals an item already in the vault is not imported again (dates, folder and favourite
//           are not compared). Everything else is created.
//   keep  — everything is created ("keep both").
//   merge — exact duplicates are skipped; an imported login whose username and a website host match an existing
//           login is merged into it (URIs, passkeys, custom fields, TOTP, notes and password history are added;
//           the newer password wins and the other is kept in the password history); everything else is created.

const norm = (v) => String(v ?? '').replace(/\r\n?/g, '\n').trim();

function uriKey(u) {
  return `${norm(u && u.uri)}|${(u && u.match) || ''}`;
}

/** Canonical string of what the user sees in an item (equal ⇒ exact duplicate). */
export function contentKey(d) {
  if (!d || typeof d !== 'object') return '';
  const l = d.type === 'login' && d.login ? d.login : null;
  return JSON.stringify([
    d.type,
    d.note_type || '',
    norm(d.name),
    norm(d.notes),
    l ? [norm(l.username), String(l.password ?? ''), norm(l.totp), (l.uris || []).map(uriKey).sort(), (l.passkeys || []).map((p) => p && p.credential_id).sort()] : null,
    d.type === 'card' && d.card ? Object.keys(d.card).sort().map((k) => [k, norm(d.card[k])]) : null,
    d.type === 'identity' && d.identity ? Object.keys(d.identity).sort().map((k) => [k, norm(d.identity[k])]) : null,
    (d.fields || []).filter((f) => f && typeof f === 'object').map((f) => [norm(f.name), String(f.value ?? ''), !!f.hidden]),
  ]);
}

export function hostOf(uri) {
  const s = String(uri || '').trim();
  if (!s) return '';
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    return u.hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** Merge keys of a login: "host\nusername" for every web URI. */
export function loginKeys(d) {
  if (!d || d.type !== 'login' || !d.login) return [];
  const user = norm(d.login.username).toLowerCase();
  return [...new Set((d.login.uris || []).map((u) => hostOf(u && u.uri)).filter(Boolean))].map((h) => `${h}\n${user}`);
}

const time = (v) => {
  const t = Date.parse(v || '');
  return Number.isFinite(t) ? t : 0;
};

/**
 * Merge an imported login into an existing one. Returns the new plaintext (existing is not mutated).
 * @returns {{data: object, changed: boolean}}
 */
export function mergeLogin(existing, inc) {
  const out = JSON.parse(JSON.stringify(existing));
  const before = contentKey(out) + JSON.stringify(out.password_history || []);
  out.login = out.login || { username: '', password: '', uris: [] };
  const l = out.login;
  const il = inc.login || {};
  // websites
  l.uris = Array.isArray(l.uris) ? l.uris : [];
  const haveUri = new Set(l.uris.map((u) => norm(u && u.uri)));
  for (const u of il.uris || []) {
    if (u && u.uri && !haveUri.has(norm(u.uri))) {
      l.uris.push({ ...u });
      haveUri.add(norm(u.uri));
    }
  }
  // password: the newer one wins; the older one ends up in the history (when the vault's password is
  // replaced, saving the item records it there, VaultStore.save → applyPasswordHistory)
  const history = Array.isArray(out.password_history) ? out.password_history.filter((h) => h && h.password) : [];
  const pushHistory = (password, at) => {
    if (password && password !== l.password && !history.some((h) => h.password === password)) history.push({ password, changed_at: at || new Date().toISOString() });
  };
  let replaced = null;
  if (il.password && il.password !== l.password) {
    if (!l.password || time(inc.updated_at) > time(existing.updated_at)) {
      replaced = l.password || null;
      l.password = il.password;
    } else pushHistory(il.password, inc.updated_at);
  }
  for (const h of inc.password_history || []) if (h && h.password !== replaced) pushHistory(h.password, h.changed_at || inc.updated_at);
  history.sort((a, b) => time(b.changed_at) - time(a.changed_at));
  out.password_history = history;
  // TOTP
  const fields = Array.isArray(out.fields) ? out.fields : [];
  if (il.totp && norm(il.totp) !== norm(l.totp)) {
    if (!norm(l.totp)) l.totp = il.totp;
    else fields.push({ name: 'Authenticator key (imported)', value: il.totp, hidden: true });
  }
  // passkeys
  const pks = Array.isArray(l.passkeys) ? l.passkeys : [];
  const havePk = new Set(pks.map((p) => p && p.credential_id));
  for (const p of il.passkeys || []) if (p && !havePk.has(p.credential_id)) pks.push(p);
  if (pks.length) l.passkeys = pks;
  // custom fields
  const haveField = new Set(fields.map((f) => `${norm(f.name)}\n${String(f.value ?? '')}`));
  for (const f of inc.fields || []) {
    const k = `${norm(f.name)}\n${String(f.value ?? '')}`;
    if (!haveField.has(k)) {
      fields.push({ ...f });
      haveField.add(k);
    }
  }
  out.fields = fields;
  // notes
  const en = norm(out.notes);
  const inn = norm(inc.notes);
  if (inn && !en.includes(inn)) out.notes = en ? `${out.notes}\n\n${inc.notes}` : inc.notes;
  if (inc.favorite) out.favorite = true;
  if (inc.reprompt) out.reprompt = true;
  return { data: out, changed: contentKey(out) + JSON.stringify(out.password_history || []) !== before };
}

/**
 * Plan an import against the current vault.
 * @param {Array<object>} items  interchange items (with folderPath)
 * @param {Array<{id: string, revision: number, data: object, updatedAt?: string}>} existing  decrypted vault items
 * @param {'skip'|'keep'|'merge'} mode
 * @returns {{create: Array<object>, merge: Array<{id: string, revision: number, data: object, names: string[]}>, skipped: Array<{name: string, reason: string}>}}
 */
export function planImport(items, existing, mode = 'skip') {
  const create = [];
  const skipped = [];
  if (mode === 'keep') return { create: [...items], merge: [], skipped };
  const exact = new Set();
  const byKey = new Map();
  for (const e of existing) {
    if (!e || !e.data) continue;
    exact.add(contentKey(e.data));
    if (mode === 'merge') {
      for (const k of loginKeys(e.data)) {
        const cur = byKey.get(k);
        if (!cur || time(e.data.updated_at || e.updatedAt) > time(cur.data.updated_at || cur.updatedAt)) byKey.set(k, e);
      }
    }
  }
  const merges = new Map(); // id → {id, revision, data, names}
  for (const it of items) {
    const { folderPath, ...data } = it;
    void folderPath;
    if (exact.has(contentKey(data))) {
      skipped.push({ name: it.name, reason: 'already in your vault' });
      continue;
    }
    const target = mode === 'merge' ? loginKeys(data).map((k) => byKey.get(k)).find(Boolean) : null;
    if (target) {
      const prev = merges.get(target.id);
      const r = mergeLogin(prev ? prev.data : target.data, data);
      if (!r.changed) {
        skipped.push({ name: it.name, reason: 'nothing new for the matching login' });
        continue;
      }
      if (prev) {
        prev.data = r.data;
        prev.names.push(it.name);
      } else merges.set(target.id, { id: target.id, revision: target.revision, data: r.data, names: [it.name] });
      continue;
    }
    create.push(it);
  }
  return { create, merge: [...merges.values()], skipped };
}
