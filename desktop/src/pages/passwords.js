// Passwords & passkeys: the Ludworks vault manager (list, detail, edit, generator, import/export).
import { h, clear, applyTheme, sideNav, letterIcon, fmtBytes } from './ui.js';

const app = document.getElementById('app');
const api = async (cmd, args = {}) => {
  const r = await window.lwPage.call(cmd, args);
  if (r && r.ok === false) throw Object.assign(new Error((r.error && r.error.message) || 'Failed'), { code: r.error && r.error.code });
  return r && 'value' in r ? r.value : r;
};

const NOTE_TYPE_LABELS = { ssh_key: 'SSH key', bank_account: 'bank account', drivers_license: "driver's license", passport: 'passport' };
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
    h('div', { class: 'toolbar' }, search, h('span', { class: 'grow' }), newSel, h('button', { class: 'btn', onclick: () => importDialog() }, 'Import…'), h('button', { class: 'btn', onclick: exportDialog }, 'Export…'), h('button', { class: 'btn', onclick: async () => { await api('account.sync'); await refresh(); toast('Synced'); } }, 'Sync')),
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
  box.append(h('h2', {}, d.name), h('div', { class: 'muted' }, `${NOTE_TYPE_LABELS[d.note_type] || d.type}${it.updatedAt ? ` · updated ${new Date(it.updatedAt).toLocaleString()}` : ''}`, d.reprompt ? h('span', { class: 'tag', title: 'Bitwarden asked for the master password before showing this item. Ludworks keeps the setting for export.' }, 're-prompt (Bitwarden)') : null));
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
  for (const f of d.fields || []) {
    if (!f || typeof f !== 'object') continue;
    if (f.type === 'linked') {
      grid.append(...kv(f.name || 'Field', h('div', { class: 'v muted', title: 'A Bitwarden linked field: it stands for another property of this item.' }, String(f.value ?? ''))));
      continue;
    }
    const v = h('div', { class: `v${f.hidden || /\n/.test(String(f.value ?? '')) ? ' mono' : ''}`, style: { whiteSpace: 'pre-wrap' } }, f.hidden ? '••••••' : String(f.value ?? ''));
    let shown = false;
    const show = f.hidden ? h('button', { class: 'btn small', onclick: (e) => { shown = !shown; v.textContent = shown ? String(f.value ?? '') : '••••••'; e.currentTarget.textContent = shown ? 'Hide' : 'Show'; } }, 'Show') : null;
    grid.append(...kv(f.name || 'Field', v, show, h('button', { class: 'btn small', onclick: () => copy(String(f.value ?? ''), f.name || 'Value') }, 'Copy')));
  }
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
function modal(title, body, buttons, { wide = false } = {}) {
  const dlg = h('dialog', { class: wide ? 'wide' : null }, h('div', { class: 'dh' }, title), h('div', { class: 'db' }, ...body), h('div', { class: 'df' }, ...buttons));
  document.body.append(dlg);
  dlg.addEventListener('close', () => dlg.remove());
  dlg.showModal();
  return dlg;
}

const num = (v) => Number(v || 0).toLocaleString();
const plural = (v, one, many = `${one}s`) => `${num(v)} ${v === 1 ? one : many}`;
const PHASES = {
  preparing: () => 'Checking your vault for duplicates…',
  folders: (p) => `Creating folders — ${num(p.done)} of ${num(p.total)}`,
  items: (p) => `Encrypting and uploading — ${num(p.done)} of ${num(p.total)} items`,
  merging: (p) => `Merging into existing logins — ${num(p.done)} of ${num(p.total)}`,
  done: () => 'Finishing…',
};
let importOpen = null; // {load(file)} while the import dialog is open

function kdfText(k) {
  if (!k || k.error) return '';
  return k.memory ? `${k.name}, ${k.memory} MiB, ${k.iterations} iterations, ${k.parallelism} threads` : `${k.name}, ${num(k.iterations)} iterations`;
}

/**
 * Import tool: choose or drop a file → file password (if protected) → preview with counts, warnings and options
 * → import with progress → summary (and saving attachments, which the vault cannot store).
 */
function importDialog(dropped = null) {
  if (importOpen) {
    if (dropped) importOpen.load(dropped);
    return;
  }
  let pick = null;
  let preview = null;
  let includeTrash = false;
  let busy = false;
  const body = h('div', { class: 'imp' });
  const primary = h('button', { class: 'btn primary', hidden: true });
  const cancelBtn = h('button', { class: 'btn' }, 'Cancel');
  const dlg = modal('Import passwords', [body], [cancelBtn, primary], { wide: true });
  cancelBtn.onclick = () => dlg.close();
  dlg.addEventListener('cancel', (e) => {
    if (busy) e.preventDefault();
  });
  dlg.addEventListener('close', () => {
    importOpen = null;
    if (pick) api('import.vault.cancel', { token: pick.token }).catch(() => {});
  });
  const setPrimary = (label, fn) => {
    primary.hidden = !label;
    primary.textContent = label || '';
    primary.onclick = fn || null;
    primary.disabled = false;
  };
  const warnBox = (msg) => h('div', { class: 'notice warn' }, msg);
  const show = (...nodes) => clear(body).append(...nodes.filter(Boolean)); // append() would print "null"
  const fileLine = () => (pick ? h('div', { class: 'file-line' }, `${pick.name}`, h('span', { class: 'muted' }, ` · ${pick.label} · ${fmtBytes(pick.size)}`)) : null);
  const working = (text) => {
    show(fileLine(), h('div', { class: 'working' }, h('span', { class: 'spinner' }), text));
    setPrimary(null);
  };
  const release = () => {
    if (pick) api('import.vault.cancel', { token: pick.token }).catch(() => {});
    pick = null;
    preview = null;
    includeTrash = false;
  };

  async function load(file) {
    if (busy) return toast('An import is running — wait until it has finished.', true);
    release();
    working(`Reading ${file.name}…`);
    try {
      const data = new Uint8Array(await file.arrayBuffer());
      onPicked(await api('import.vault.load', { name: file.name, data }));
    } catch (e) {
      stepChoose(e.message);
    }
  }

  async function choose() {
    let r;
    try {
      r = await api('import.vault.pick');
    } catch (e) {
      return stepChoose(e.message);
    }
    if (!r) return;
    release();
    onPicked(r);
  }

  function stepChoose(err = null) {
    const zone = h(
      'div',
      { class: 'drop' },
      h('div', { class: 'drop-t' }, 'Drop your export file here'),
      h('div', { class: 'muted' }, 'Bitwarden .json (also password-protected and organization exports), .zip with attachments or .csv — and KeePass .kdbx / .xml or Chrome, Edge and Firefox password .csv files.'),
      h('div', {}, h('button', { class: 'btn', type: 'button', onclick: choose }, 'Choose file…')),
    );
    for (const ev of ['dragenter', 'dragover']) zone.addEventListener(ev, () => zone.classList.add('over'));
    for (const ev of ['dragleave', 'drop']) zone.addEventListener(ev, () => zone.classList.remove('over'));
    show(
      zone,
      err ? warnBox(err) : null,
      h('div', { class: 'faint small' }, 'In Bitwarden open Tools → Export vault (or Settings → Vault options → Export). Logins with their passkeys and authenticator (TOTP) keys, custom fields, password history, cards, identities, secure notes, SSH keys, folders and collections are imported. The file is read on this device only; every item is encrypted with your vault key before it is uploaded.'),
    );
    setPrimary(null);
  }

  function onPicked(r) {
    pick = r;
    if (r.accountRestricted) {
      show(fileLine(), warnBox(r.error || 'This export is account-restricted and cannot be opened outside Bitwarden.'));
      return setPrimary('Choose another file', () => {
        release();
        stepChoose();
      });
    }
    if (!r.format || (r.error && !r.needsPassword)) {
      show(fileLine(), warnBox(r.error || 'This file is not a supported password export.'));
      return setPrimary('Choose another file', () => {
        release();
        stepChoose();
      });
    }
    if (r.needsPassword) return stepPassword();
    runPreview();
  }

  function stepPassword(err = null) {
    const pw = h('input', { class: 'input', type: 'password', placeholder: 'File password', autocomplete: 'off' });
    const form = h(
      'form',
      { class: 'field' },
      h('span', {}, pick.format === 'kdbx' ? 'Database password' : 'This export is protected with a file password'),
      pw,
      pick.kdf ? h('span', { class: 'faint small' }, `Key derivation: ${kdfText(pick.kdf)}${pick.kdf.name === 'Argon2id' ? ' — unlocking can take a few seconds.' : ''}`) : null,
    );
    const submit = () => {
      if (!pw.value) return pw.focus();
      const v = pw.value;
      pw.value = '';
      runPreview(v);
    };
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      submit();
    });
    show(fileLine(), form, err ? warnBox(err) : null);
    setPrimary('Unlock file', submit);
    setTimeout(() => pw.focus(), 30);
  }

  async function runPreview(password) {
    busy = true;
    working(password ? 'Decrypting the export…' : 'Reading the export…');
    try {
      preview = await api('import.vault.preview', { token: pick.token, password, includeTrash });
      stepPreview();
    } catch (e) {
      if (e.code === 'bad_password' || e.code === 'password_required' || e.code === 'bad_credentials') stepPassword(e.message);
      else if (e.code === 'expired') stepChoose(e.message);
      else {
        show(fileLine(), warnBox(e.message));
        setPrimary('Choose another file', () => {
          release();
          stepChoose();
        });
      }
    } finally {
      busy = false;
    }
  }

  function stepPreview() {
    const s = preview.stats;
    const d = preview.duplicates || { exact: 0, mergeTargets: 0, mergeItems: 0, mergeNothingNew: 0 };
    const tile = (value, label, sub = '') => h('div', { class: 'stat' }, h('b', {}, num(value)), h('span', {}, label), sub ? h('span', { class: 'faint' }, sub) : null);
    const tiles = [
      tile(s.logins, 'Logins'),
      tile(s.withTotp, 'with authenticator key', s.totpUnreadable ? `${num(s.totpUnreadable)} kept as text` : ''),
      tile(s.withPasskeys, 'with passkeys', s.passkeys ? plural(s.passkeys, 'passkey') : ''),
      tile(s.withFields, 'with custom fields'),
      tile(s.cards, 'Cards'),
      tile(s.identities, 'Identities'),
      tile(s.notes, 'Secure notes'),
      tile(s.sshKeys, 'SSH keys'),
      s.bankAccounts ? tile(s.bankAccounts, 'Bank accounts') : null,
      s.driversLicenses ? tile(s.driversLicenses, "Driver's licenses") : null,
      s.passports ? tile(s.passports, 'Passports') : null,
      tile(preview.folders, 'Folders'),
      tile(preview.attachmentCount, 'Attachments', preview.attachmentCount ? 'not stored — see below' : ''),
    ];
    const radio = (value, label, hint, checked = false) =>
      h('label', { class: 'opt' }, h('input', { type: 'radio', name: 'dups', value, checked }), h('span', {}, label, hint ? h('span', { class: 'muted' }, ` — ${hint}`) : null));
    const dupBox = h(
      'div',
      { class: 'field' },
      h('span', {}, 'Items that are already in your vault'),
      radio('skip', 'Skip exact duplicates', d.exact ? `${plural(d.exact, 'item')} already in your vault` : 'none found', true),
      radio('merge', 'Merge logins with the same website and username into the existing login', d.mergeItems ? `${plural(d.mergeItems, 'login')} into ${plural(d.mergeTargets, 'existing login')}` : 'no matches'),
      radio('keep', 'Import everything (keep both copies)', ''),
    );
    const dest = h('input', { class: 'input', placeholder: 'Keep the folders from the file', list: 'imp-folders', autocomplete: 'off' });
    const destList = h('datalist', { id: 'imp-folders' }, ...preview.vaultFolders.map((f) => h('option', { value: f })));
    const trash = preview.trash ? h('input', { type: 'checkbox', checked: includeTrash }) : null;
    if (trash) {
      trash.addEventListener('change', () => {
        includeTrash = trash.checked;
        runPreview();
      });
    }
    const mode = () => (dupBox.querySelector('input[name=dups]:checked') || {}).value || 'skip';
    const count = () => {
      if (mode() === 'keep') return s.total;
      if (mode() === 'merge') return Math.max(0, s.total - d.exact - d.mergeItems - d.mergeNothingNew);
      return Math.max(0, s.total - d.exact);
    };
    const merging = () => mode() === 'merge' && d.mergeItems > 0;
    const label = () => {
      const c = count();
      if (c) return `Import ${plural(c, 'item')}${merging() ? ` and merge ${plural(d.mergeItems, 'login')}` : ''}`;
      return merging() ? `Merge ${plural(d.mergeItems, 'login')}` : 'Nothing new to import';
    };
    const syncPrimary = () => {
      primary.textContent = label();
      primary.disabled = !count() && !merging();
    };
    dupBox.addEventListener('change', syncPrimary);
    const warnings = preview.warnings || [];
    show(
      fileLine(),
      h('div', { class: 'stat-grid' }, ...tiles),
      warnings.length
        ? h('details', { class: 'notes', open: warnings.length <= 4 }, h('summary', {}, `${plural(warnings.length, 'note')} about this file`), h('ul', {}, ...warnings.map((w) => h('li', {}, w))))
        : h('div', { class: 'notice ok' }, 'Everything in this file has a place in your Ludworks vault.'),
      preview.attachmentCount
        ? h('details', { class: 'notes' }, h('summary', {}, `${plural(preview.attachmentCount, 'attachment')} (saved to a folder of your choice after the import)`), h('ul', {}, ...preview.attachments.map((a) => h('li', {}, `${a.item} — ${a.file} (${fmtBytes(a.size)})`))))
        : null,
      dupBox,
      h('label', { class: 'field' }, h('span', {}, 'Put everything into this folder (optional)'), dest, destList),
      trash ? h('label', { class: 'opt' }, trash, h('span', {}, `Also import ${plural(preview.trash, 'item')} from Bitwarden’s trash (into “Bitwarden trash”)`)) : null,
    );
    setPrimary(label(), () => runImport({ duplicates: mode(), folder: dest.value.trim(), includeTrash }));
    syncPrimary();
  }

  async function runImport(opts) {
    busy = true;
    cancelBtn.disabled = true;
    const bar = h('progress', { max: 1, value: 0 });
    const text = h('div', { class: 'muted' }, PHASES.preparing());
    show(fileLine(), h('div', { class: 'field' }, bar, text));
    setPrimary(null);
    const poll = setInterval(async () => {
      try {
        const st = await api('import.vault.status', { token: pick.token });
        const p = st && st.progress;
        if (!p) return;
        text.textContent = (PHASES[p.phase] || PHASES.preparing)(p);
        if (p.total) {
          bar.max = p.total;
          bar.value = p.done;
        } else bar.removeAttribute('value');
      } catch {
        /* keep polling */
      }
    }, 250);
    try {
      const r = await api('import.vault.commit', { token: pick.token, ...opts });
      clearInterval(poll);
      stepDone(r);
      refresh();
    } catch (e) {
      clearInterval(poll);
      show(fileLine(), warnBox(`The import stopped: ${e.message}`), h('div', { class: 'muted small' }, 'Items imported before the error are in your vault. Importing the same file again with “Skip exact duplicates” adds only what is missing.'));
      setPrimary('Close', () => dlg.close());
      refresh();
    } finally {
      busy = false;
      cancelBtn.disabled = false;
    }
  }

  function stepDone(r) {
    const parts = [`Imported ${plural(r.created, 'item')}`];
    if (r.merged) parts.push(`merged ${plural(r.mergedFrom, 'login')} into ${plural(r.merged, 'existing login')}`);
    if (r.skipped) parts.push(`skipped ${plural(r.skipped, 'duplicate')}`);
    const attBox = h('div', {});
    if (r.attachmentCount) {
      const save = h('button', { class: 'btn small', type: 'button' }, 'Save attachments to a folder…');
      save.onclick = async () => {
        save.disabled = true;
        try {
          const s = await api('import.vault.attachments', { token: pick.token });
          if (s) attBox.append(h('div', { class: 'notice ok' }, `Saved ${plural(s.saved, 'file')} to ${s.dir}${s.errors.length ? ` (${s.errors.length} failed: ${s.errors.join('; ')})` : ''}.`));
        } catch (e) {
          attBox.append(warnBox(e.message));
        } finally {
          save.disabled = false;
        }
      };
      attBox.append(h('div', { class: 'notice warn' }, `${plural(r.attachmentCount, 'file attachment')} could not be imported: the Ludworks vault cannot store files. Save them somewhere safe:`, h('div', { style: { marginTop: '8px' } }, save)));
    }
    show(
      fileLine(),
      h('div', { class: 'notice ok' }, `${parts.join(', ')}.${r.foldersCreated ? ` Created ${plural(r.foldersCreated, 'folder')}.` : ''}`),
      r.failedCount
        ? h('details', { class: 'notes', open: true }, h('summary', {}, `${plural(r.failedCount, 'item')} could not be imported`), h('ul', {}, ...r.failed.map((f) => h('li', {}, `${f.name ? `“${f.name}”: ` : ''}${f.error}`))))
        : null,
      attBox,
      (r.warnings || []).length ? h('details', { class: 'notes' }, h('summary', {}, plural(r.warnings.length, 'note')), h('ul', {}, ...r.warnings.map((w) => h('li', {}, w)))) : null,
    );
    cancelBtn.hidden = true;
    setPrimary('Done', () => dlg.close());
  }

  importOpen = {
    load,
    // the vault locked (idle / screen lock): a running import reports the error itself; otherwise close the tool
    // so it does not sit modally over the unlock form
    locked() {
      if (busy) return;
      dlg.close();
      toast('Your vault locked, so the import was cancelled. Unlock it and import the file again.', true);
    },
  };
  if (dropped) load(dropped);
  else stepChoose();
}

function exportDialog() {
  const fmt = h(
    'select',
    { class: 'input' },
    h('option', { value: 'bitwarden-json-protected' }, 'Bitwarden JSON — password-protected (recommended)'),
    h('option', { value: 'bitwarden-json' }, 'Bitwarden JSON — unencrypted'),
    h('option', { value: 'bitwarden-csv' }, 'Bitwarden CSV — unencrypted (logins and notes only, no passkeys)'),
    h('option', { value: 'kdbx' }, 'KeePass database (.kdbx)'),
  );
  const filePw = h('input', { class: 'input', type: 'password', placeholder: 'Password for the exported file', autocomplete: 'new-password' });
  const filePwField = h('label', { class: 'field' }, h('span', {}, 'File password'), filePw);
  const kdf = h('select', { class: 'input' }, h('option', { value: 'pbkdf2' }, 'PBKDF2-SHA256, 600,000 iterations (Bitwarden default)'), h('option', { value: 'argon2id' }, 'Argon2id, 64 MiB, 3 iterations, 4 threads'));
  const kdfField = h('label', { class: 'field' }, h('span', {}, 'Key derivation'), kdf);
  const master = h('input', { class: 'input', type: 'password', placeholder: 'Your master password', autocomplete: 'current-password' });
  const warn = h('div', { class: 'notice warn', hidden: true }, 'This file will contain your passwords, passkeys and authenticator keys in plain text. Store it safely and delete it when you are done.');
  const note = h('div', { class: 'faint small' }, 'Bitwarden JSON keeps everything: passkeys, authenticator (TOTP) keys, custom fields (incl. hidden, boolean and linked), password history, folders, cards, identities, notes and SSH keys. Bitwarden imports it under Tools → Import data → “Bitwarden (json)”.');
  const status = h('div', {});
  const sync = () => {
    const plain = fmt.value === 'bitwarden-json' || fmt.value === 'bitwarden-csv';
    filePwField.hidden = plain;
    kdfField.hidden = fmt.value !== 'bitwarden-json-protected';
    warn.hidden = !plain;
    note.hidden = !fmt.value.startsWith('bitwarden-json');
  };
  fmt.addEventListener('change', sync);
  sync();
  const go = h('button', { class: 'btn primary' }, 'Export');
  const dlg = modal('Export passwords', [h('label', { class: 'field' }, h('span', {}, 'Format'), fmt), filePwField, kdfField, warn, note, h('label', { class: 'field' }, h('span', {}, 'Confirm with your master password'), master), status], [h('button', { class: 'btn', onclick: () => dlg.close() }, 'Cancel'), go]);
  go.addEventListener('click', async () => {
    go.disabled = true;
    try {
      const r = await api('export.vault', { format: fmt.value, filePassword: filePw.value, masterPassword: master.value, kdf: kdf.value });
      master.value = '';
      if (r) {
        filePw.value = '';
        clear(status).append(h('div', { class: 'notice ok' }, `Exported ${plural(r.items, 'item')} to ${r.path}`), ...(r.warnings || []).map((w) => h('div', { class: 'faint small' }, w)));
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

// Dropping an export file anywhere on the page opens the import tool (internal pages never navigate to files).
const hasFiles = (e) => !!(e.dataTransfer && [...(e.dataTransfer.types || [])].includes('Files'));
document.addEventListener('dragover', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = summary && summary.phase === 'unlocked' ? 'copy' : 'none';
});
document.addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  const f = e.dataTransfer.files && e.dataTransfer.files[0];
  if (!f) return;
  if (!summary || summary.phase !== 'unlocked') return toast('Unlock your vault to import passwords.', true);
  importDialog(f);
});

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
    if (was !== summary.phase) {
      if (summary.phase !== 'unlocked' && importOpen) importOpen.locked();
      refresh();
    }
  }
});

load().then(refresh);
