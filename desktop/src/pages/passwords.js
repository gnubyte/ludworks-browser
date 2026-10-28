// Passwords & passkeys: the Ludworks vault manager (list, detail, edit, generator, import/export).
import { h, clear, applyTheme, sideNav, letterIcon } from './ui.js';

const app = document.getElementById('app');
const api = async (cmd, args = {}) => {
  const r = await window.lwPage.call(cmd, args);
  if (r && r.ok === false) throw Object.assign(new Error((r.error && r.error.message) || 'Failed'), { code: r.error && r.error.code });
  return r && 'value' in r ? r.value : r;
};

const MATCHES = [['domain', 'Same site'], ['host', 'Same host'], ['starts_with', 'Starts with'], ['exact', 'Exact'], ['regex', 'Regex'], ['never', 'Never']];
let summary = null;
let list = { items: [], folders: [] };
let selected = null;
let query = '';
let totpTimer = null;

const main = h('main', { class: 'main' });
app.append(sideNav('passwords'), main);

function toast(msg, warn = false) {
  const t = h('div', { class: `notice ${warn ? 'warn' : 'ok'}`, style: { position: 'fixed', right: '24px', bottom: '24px', maxWidth: '420px', zIndex: '10', boxShadow: 'var(--shadow)' } }, msg);
  document.body.append(t);
  setTimeout(() => t.remove(), 4000);
}

function copy(text, what) {
  // The browser copies and clears the clipboard after 30 s if it still holds the secret.
  api('vault.copy', { text }).then(() => toast(`${what} copied — cleared in 30 s`));
}

async function load() {
  applyTheme(await window.lwPage.call('theme'));
  summary = await api('account.summary');
  render();
}

function render() {
  clear(main);
  clearInterval(totpTimer);
  if (!summary || summary.phase === 'logged_out') {
    main.append(
      h('div', { class: 'card state-card' }, h('h2', {}, 'Sign in to Ludworks'), h('div', { class: 'muted' }, 'Passwords and passkeys live in your end-to-end encrypted Ludworks vault and sync to all your devices. Use the account button in the toolbar to sign in.'), h('div', {}, h('button', { class: 'btn primary', onclick: () => api('account.summary').then(load) }, 'I signed in — reload'))),
    );
    return;
  }
  if (summary.phase === 'uninitialized') {
    main.append(h('div', { class: 'card state-card' }, h('h2', {}, 'Set up your vault'), h('div', { class: 'muted' }, 'Open the account menu in the toolbar to choose a master password.')));
    return;
  }
  if (summary.phase === 'locked') {
    const pass = h('input', { class: 'input', type: 'password', placeholder: 'Master password', autocomplete: 'current-password' });
    const err = h('div', { class: 'notice warn', hidden: true });
    const form = h('form', { class: 'card state-card' }, h('h2', {}, 'Unlock your vault'), h('div', { class: 'muted' }, `${summary.user.displayName || summary.user.username} · ${summary.serverHost}`), pass, err, h('div', {}, h('button', { class: 'btn primary', type: 'submit' }, 'Unlock')));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        summary = await api('account.unlock', { password: pass.value });
        await refresh();
      } catch (x) {
        err.hidden = false;
        err.textContent = x.message;
      }
    });
    main.append(form);
    setTimeout(() => pass.focus(), 30);
    return;
  }
  const search = h('input', { class: 'input', type: 'search', placeholder: 'Search logins, notes, cards…', value: query, style: { maxWidth: '360px' } });
  search.addEventListener('input', () => {
    query = search.value;
    renderList();
  });
  const newSel = h('select', { class: 'input', style: { width: 'auto' } }, h('option', { value: '' }, '+ New item'), h('option', { value: 'login' }, 'Login'), h('option', { value: 'note' }, 'Secure note'), h('option', { value: 'card' }, 'Card'), h('option', { value: 'identity' }, 'Identity'));
  newSel.addEventListener('change', async () => {
    const t = newSel.value;
    newSel.value = '';
    if (t) editItem(null, await api('vault.new', { type: t }));
  });
  main.append(
    h('h1', {}, 'Passwords and passkeys'),
    h('div', { class: 'toolbar' }, search, h('span', { class: 'grow' }), newSel, h('button', { class: 'btn', onclick: importDialog }, 'Import…'), h('button', { class: 'btn', onclick: exportDialog }, 'Export…'), h('button', { class: 'btn', onclick: async () => { await api('account.sync'); await refresh(); toast('Synced'); } }, 'Sync')),
    h('div', { class: 'pw' }, h('div', { class: 'card pw-list list', id: 'list' }), h('div', { class: 'card pw-detail', id: 'detail' }, h('div', { class: 'empty' }, 'Select an item'))),
  );
  renderList();
  if (selected) showItem(selected);
}

function renderList() {
  const box = document.getElementById('list');
  if (!box) return;
  clear(box);
  const q = query.trim().toLowerCase();
  const items = list.items.filter((it) => !q || [it.name, it.subtitle, ...(it.uris || []).map((u) => u.uri)].some((s) => String(s || '').toLowerCase().includes(q)));
  if (!items.length) box.append(h('div', { class: 'empty' }, list.items.length ? 'No matches' : 'Your vault is empty. Add a login or import from Bitwarden.'));
  for (const it of items) {
    const row = h(
      'div',
      { class: `row${it.id === selected ? ' sel' : ''}`, tabindex: '0' },
      letterIcon(it.uris && it.uris[0] ? it.uris[0].uri : it.name, 28),
      h('div', { class: 'grow' }, h('div', { class: 't' }, it.name), h('div', { class: 's' }, [it.subtitle, it.passkeys ? `${it.passkeys} passkey${it.passkeys > 1 ? 's' : ''}` : '', it.type !== 'login' ? it.type : ''].filter(Boolean).join(' · '))),
      it.favorite ? h('span', { class: 'tag' }, '★') : null,
    );
    row.addEventListener('click', () => {
      selected = it.id;
      renderList();
      showItem(it.id);
    });
    box.append(row);
  }
}

function kv(k, v, ...acts) {
  return [h('div', { class: 'k' }, k), v, h('div', { class: 'acts' }, ...acts)];
}

async function showItem(id) {
  const box = document.getElementById('detail');
  clearInterval(totpTimer);
  let it;
  try {
    it = await api('vault.get', { id });
  } catch (e) {
    clear(box).append(h('div', { class: 'notice warn' }, e.message));
    return;
  }
  const d = it.data;
  clear(box);
  box.append(h('h2', {}, d.name), h('div', { class: 'muted' }, `${d.type}${it.updatedAt ? ` · updated ${new Date(it.updatedAt).toLocaleString()}` : ''}`));
  if (it.stale) box.append(h('div', { class: 'stale' }, `⚠ ${it.stale} It is not used for autofill.`));
  const grid = h('div', { class: 'kv' });
  if (d.type === 'login') {
    const l = d.login || {};
    if (l.username) grid.append(...kv('Username', h('div', { class: 'v' }, l.username), h('button', { class: 'btn small', onclick: () => copy(l.username, 'Username') }, 'Copy')));
    if (l.password) {
      const v = h('div', { class: 'v mono' }, '••••••••••');
      let shown = false;
      grid.append(...kv('Password', v, h('button', { class: 'btn small', onclick: (e) => { shown = !shown; v.textContent = shown ? l.password : '••••••••••'; e.currentTarget.textContent = shown ? 'Hide' : 'Show'; } }, 'Show'), h('button', { class: 'btn small', onclick: () => copy(l.password, 'Password') }, 'Copy')));
    }
    if (l.totp) {
      const v = h('div', { class: 'v totp' }, '······');
      const tick = async () => {
        try {
          const t = await api('vault.totp', { id });
          v.textContent = t ? `${t.code.slice(0, Math.ceil(t.code.length / 2))} ${t.code.slice(Math.ceil(t.code.length / 2))}  ·  ${t.remaining ?? ''}s` : '—';
          v.dataset.code = t ? t.code : '';
        } catch {
          v.textContent = '—';
        }
      };
      tick();
      totpTimer = setInterval(tick, 1000);
      grid.append(...kv('One-time code', v, h('button', { class: 'btn small', onclick: () => v.dataset.code && copy(v.dataset.code, 'Code') }, 'Copy')));
    }
    for (const u of l.uris || []) {
      grid.append(...kv('Website', h('div', { class: 'v' }, u.uri, h('span', { class: 'faint' }, ` (${(MATCHES.find((m) => m[0] === (u.match || 'domain')) || ['', u.match])[1]})`)), /^https?:/i.test(u.uri) ? h('a', { class: 'btn small', href: u.uri, target: '_blank' }, 'Open') : null));
    }
    const pks = Array.isArray(l.passkeys) ? l.passkeys : [];
    if (pks.length) {
      const wrap = h('div', { class: 'v' });
      pks.forEach((p, i) => {
        wrap.append(
          h(
            'div',
            { class: 'passkey-row' },
            h('div', { class: 'grow' }, h('div', {}, `${p.user_name || p.user_display_name || 'Passkey'}`), h('div', { class: 'muted', style: { fontSize: '12px' } }, `${p.rp_id} · created ${p.created_at ? new Date(p.created_at).toLocaleDateString() : '—'}`)),
            h('button', { class: 'btn small danger', onclick: async () => { if (!window.confirm(`Delete this passkey for ${p.rp_id}? You will not be able to sign in with it any more.`)) return; const data = JSON.parse(JSON.stringify(d)); data.login.passkeys.splice(i, 1); await api('vault.save', { id, data, baseRevision: it.revision }); await refresh(); } }, 'Delete'),
          ),
        );
      });
      grid.append(...kv('Passkeys', wrap));
    }
  }
  if (d.type === 'card') for (const [k, label] of [['cardholder', 'Cardholder'], ['brand', 'Brand'], ['number', 'Number'], ['exp_month', 'Exp. month'], ['exp_year', 'Exp. year'], ['code', 'Security code']]) if (d.card && d.card[k]) grid.append(...kv(label, h('div', { class: `v${k === 'number' || k === 'code' ? ' mono' : ''}` }, k === 'code' ? '•••' : d.card[k]), h('button', { class: 'btn small', onclick: () => copy(d.card[k], label) }, 'Copy')));
  if (d.type === 'identity') for (const [k, v] of Object.entries(d.identity || {})) if (v) grid.append(...kv(k.replace(/_/g, ' '), h('div', { class: 'v' }, v), h('button', { class: 'btn small', onclick: () => copy(v, k) }, 'Copy')));
  for (const f of d.fields || []) grid.append(...kv(f.name || 'Field', h('div', { class: 'v' }, f.hidden ? '••••••' : f.value), h('button', { class: 'btn small', onclick: () => copy(f.value, f.name || 'Value') }, 'Copy')));
  if (d.notes) grid.append(...kv('Notes', h('div', { class: 'v', style: { whiteSpace: 'pre-wrap' } }, d.notes)));
  if ((d.password_history || []).length) grid.append(...kv('Password history', h('div', { class: 'v muted' }, `${d.password_history.length} earlier password${d.password_history.length > 1 ? 's' : ''}`)));
  box.append(grid, h('div', { class: 'actions' }, h('button', { class: 'btn danger', onclick: async () => { if (!window.confirm(`Delete “${d.name}”?`)) return; await api('vault.delete', { id }); selected = null; await refresh(); } }, 'Delete'), h('button', { class: 'btn primary', onclick: () => editItem(it, d) }, 'Edit')));
}

function editItem(it, data) {
  const box = document.getElementById('detail');
  clearInterval(totpTimer);
  clear(box);
  const d = JSON.parse(JSON.stringify(data));
  const name = h('input', { class: 'input', value: d.name || '' });
  const folder = h('select', { class: 'input' }, h('option', { value: '' }, 'No folder'), ...list.folders.map((f) => h('option', { value: f.id }, f.name)));
  folder.value = (it && it.folderId) || '';
  const fav = h('input', { type: 'checkbox', checked: !!d.favorite });
  const grid = h('div', { class: 'edit-grid' }, h('label', { class: 'field' }, h('span', {}, 'Name'), name), h('label', { class: 'field' }, h('span', {}, 'Folder'), folder));
  let collect = () => {};
  if (d.type === 'login') {
    d.login = d.login || { username: '', password: '', uris: [], totp: '' };
    const user = h('input', { class: 'input', value: d.login.username || '', autocomplete: 'off' });
    const pass = h('input', { class: 'input mono', value: d.login.password || '', type: 'password', autocomplete: 'new-password' });
    const gen = h('button', { class: 'btn small', type: 'button', onclick: async () => { pass.value = await api('vault.generate', {}); pass.type = 'text'; } }, 'Generate');
    const show = h('button', { class: 'btn small', type: 'button', onclick: () => { pass.type = pass.type === 'password' ? 'text' : 'password'; } }, 'Show');
    const totp = h('input', { class: 'input mono', value: d.login.totp || '', placeholder: 'otpauth://… or base32 secret' });
    const uris = h('div', {});
    const addUri = (u = { uri: '', match: 'domain' }) => {
      const inp = h('input', { class: 'input', value: u.uri, placeholder: 'https://example.com' });
      const m = h('select', { class: 'input' }, ...MATCHES.map(([v, l]) => h('option', { value: v }, l)));
      m.value = u.match || 'domain';
      const row = h('div', { class: 'uri-row' }, inp, m, h('button', { class: 'btn small', type: 'button', onclick: () => row.remove() }, '✕'));
      row.dataset.uri = '1';
      uris.append(row);
    };
    (d.login.uris || []).forEach(addUri);
    if (!(d.login.uris || []).length) addUri();
    grid.append(
      h('label', { class: 'field' }, h('span', {}, 'Username'), user),
      h('label', { class: 'field' }, h('span', {}, 'Password'), h('div', { class: 'uri-row' }, pass, show, gen)),
      h('div', { class: 'field full' }, h('span', {}, 'Websites'), uris, h('div', {}, h('button', { class: 'btn small', type: 'button', onclick: () => addUri() }, '+ Website'))),
      h('label', { class: 'field full' }, h('span', {}, 'Authenticator key (TOTP)'), totp),
    );
    if ((d.login.passkeys || []).length) grid.append(h('div', { class: 'field full' }, h('span', {}, 'Passkeys'), h('div', { class: 'muted' }, `${d.login.passkeys.length} passkey(s) — kept as they are`)));
    collect = () => {
      d.login.username = user.value;
      d.login.password = pass.value;
      d.login.totp = totp.value.trim();
      d.login.uris = [...uris.querySelectorAll('[data-uri]')].map((r) => ({ uri: r.querySelector('input').value.trim(), match: r.querySelector('select').value })).filter((u) => u.uri);
    };
  } else if (d.type === 'card' || d.type === 'identity') {
    const obj = d[d.type] || {};
    const inputs = {};
    for (const k of Object.keys(obj)) {
      inputs[k] = h('input', { class: 'input', value: obj[k] || '' });
      grid.append(h('label', { class: 'field' }, h('span', {}, k.replace(/_/g, ' ')), inputs[k]));
    }
    collect = () => {
      for (const k of Object.keys(inputs)) obj[k] = inputs[k].value;
      d[d.type] = obj;
    };
  }
  const notes = h('textarea', { class: 'input', rows: 4 }, d.notes || '');
  grid.append(h('label', { class: 'field full' }, h('span', {}, 'Notes'), notes), h('label', { class: 'field full', style: { flexDirection: 'row', alignItems: 'center', gap: '8px' } }, fav, h('span', {}, 'Favorite')));
  const err = h('div', { class: 'notice warn', hidden: true });
  box.append(
    h('h2', {}, it ? `Edit ${d.name}` : `New ${d.type}`),
    grid,
    err,
    h(
      'div',
      { class: 'actions' },
      h('button', { class: 'btn', onclick: () => (it ? showItem(it.id) : clear(box)) }, 'Cancel'),
      h(
        'button',
        {
          class: 'btn primary',
          onclick: async () => {
            collect();
            d.name = name.value.trim();
            d.notes = notes.value;
            d.favorite = fav.checked;
            try {
              const r = await api('vault.save', { id: it ? it.id : null, folderId: folder.value || null, data: d, baseRevision: it ? it.revision : null });
              selected = r.id;
              await refresh();
              toast('Saved');
            } catch (e) {
              err.hidden = false;
              err.textContent = e.message;
            }
          },
        },
        'Save',
      ),
    ),
  );
}

// ------------------------------------------------------------------------------- import/export
function modal(title, body, buttons) {
  const dlg = h('dialog', {}, h('div', { class: 'dh' }, title), h('div', { class: 'db' }, ...body), h('div', { class: 'df' }, ...buttons));
  document.body.append(dlg);
  dlg.addEventListener('close', () => dlg.remove());
  dlg.showModal();
  return dlg;
}

async function importDialog() {
  let pick;
  try {
    pick = await api('import.vault.pick');
  } catch (e) {
    return toast(e.message, true);
  }
  if (!pick) return;
  const pass = h('input', { class: 'input', type: 'password', placeholder: 'File password' });
  const info = h('div', { class: 'muted' }, `${pick.name} — ${pick.format || 'unknown format'}`);
  const status = h('div', {});
  let previewed = false;
  const go = h('button', { class: 'btn primary' }, pick.needsPassword ? 'Decrypt' : 'Preview');
  const dlg = modal('Import passwords', [info, pick.needsPassword ? h('label', { class: 'field' }, h('span', {}, 'This export is password-protected'), pass) : null, status], [h('button', { class: 'btn', onclick: () => { api('import.vault.cancel', { token: pick.token }); dlg.close(); } }, 'Cancel'), go]);
  go.addEventListener('click', async () => {
    go.disabled = true;
    try {
      if (!previewed) {
        const p = await api('import.vault.preview', { token: pick.token, password: pass.value });
        previewed = true;
        clear(status).append(
          h('div', { class: 'notice ok' }, `${p.items} item(s) in ${p.folders} folder(s): ${Object.entries(p.types).map(([k, v]) => `${v} ${k}`).join(', ')}${p.passkeys ? ` — including ${p.passkeys} passkey(s)` : ''}.`),
          ...p.warnings.slice(0, 8).map((w) => h('div', { class: 'faint' }, w)),
        );
        go.textContent = `Import ${p.items} item(s)`;
      } else {
        const r = await api('import.vault.commit', { token: pick.token });
        clear(status).append(h('div', { class: 'notice ok' }, `Imported ${r.created} item(s).${r.errors.length ? ` ${r.errors.length} failed.` : ''}`));
        go.textContent = 'Done';
        go.onclick = () => dlg.close();
        await refresh();
      }
    } catch (e) {
      clear(status).append(h('div', { class: 'notice warn' }, e.message));
    } finally {
      go.disabled = false;
    }
  });
}

function exportDialog() {
  const fmt = h('select', { class: 'input' }, h('option', { value: 'bitwarden-json-protected' }, 'Bitwarden JSON — password-protected (recommended)'), h('option', { value: 'bitwarden-json' }, 'Bitwarden JSON — unencrypted'), h('option', { value: 'bitwarden-csv' }, 'Bitwarden CSV — unencrypted (no passkeys, cards or identities)'), h('option', { value: 'kdbx' }, 'KeePass database (.kdbx)'));
  const filePw = h('input', { class: 'input', type: 'password', placeholder: 'Password for the exported file' });
  const filePwField = h('label', { class: 'field' }, h('span', {}, 'File password'), filePw);
  const master = h('input', { class: 'input', type: 'password', placeholder: 'Your master password' });
  const warn = h('div', { class: 'notice warn', hidden: true }, 'This file will contain your passwords in plain text. Store it safely and delete it when you are done.');
  const status = h('div', {});
  const sync = () => {
    const plain = fmt.value === 'bitwarden-json' || fmt.value === 'bitwarden-csv';
    filePwField.hidden = plain;
    warn.hidden = !plain;
  };
  fmt.addEventListener('change', sync);
  sync();
  const go = h('button', { class: 'btn primary' }, 'Export');
  const dlg = modal('Export passwords', [h('label', { class: 'field' }, h('span', {}, 'Format'), fmt), filePwField, warn, h('label', { class: 'field' }, h('span', {}, 'Confirm with your master password'), master), status], [h('button', { class: 'btn', onclick: () => dlg.close() }, 'Cancel'), go]);
  go.addEventListener('click', async () => {
    go.disabled = true;
    try {
      const r = await api('export.vault', { format: fmt.value, filePassword: filePw.value, masterPassword: master.value });
      master.value = '';
      if (r) {
        clear(status).append(h('div', { class: 'notice ok' }, `Exported to ${r.path}`));
        go.textContent = 'Done';
        go.onclick = () => dlg.close();
      }
    } catch (e) {
      clear(status).append(h('div', { class: 'notice warn' }, e.message));
    } finally {
      go.disabled = false;
    }
  });
}

async function refresh() {
  summary = await api('account.summary');
  if (summary.phase === 'unlocked') {
    try {
      list = await api('vault.list');
    } catch (e) {
      toast(e.message, true);
    }
  }
  render();
}

window.lwPage.on('page-event', (ev) => {
  if (ev && ev.type === 'account') {
    const was = summary && summary.phase;
    summary = ev.summary;
    if (was !== summary.phase) refresh();
  }
});

load().then(refresh);
