// Add / edit an item. Edits a deep clone of the decrypted plaintext so unknown keys are preserved.

import { siteName, URI_MATCH_TYPES } from '../../lib/url-match.js';
import { newItem, newLoginItem, cloneJson, CARD_FIELDS, IDENTITY_FIELDS } from '../../lib/item-model.js';
import { parseTotpInput } from '../../lib/totp.js';
import { h, clear, icon, iconButton, button, withBusy, confirmDialog, nextId, segmented } from '../ui.js';
import { loadGeneratorPrefs, generateFromPrefs, strengthMeter } from './generator.js';
import { detailView } from './vault.js';

const MATCH_LABELS = { domain: 'Domain', host: 'Host', starts_with: 'Starts with', exact: 'Exact', regex: 'Regex', never: 'Never' };
const TITLES = { login: 'login', note: 'secure note', card: 'card', identity: 'identity' };

function textInput(id, value, onInput, { type = 'text', placeholder = '', autocomplete = 'off', mono = false, required = false } = {}) {
  const input = h('input', { id, type, class: ['input', mono && 'mono'], value: value ?? '', placeholder, autocomplete, spellcheck: 'false', required });
  input.addEventListener('input', () => onInput(input.value));
  return input;
}

function labelled(label, control, hint) {
  return h('div', { class: 'field' }, h('label', { for: control.id || control.querySelector('input').id, class: 'field-label', text: label }), control, hint || null);
}

function secretInput(id, value, onInput, label, extraButtons = []) {
  const input = textInput(id, value, onInput, { type: 'password', mono: true, autocomplete: 'new-password' });
  const reveal = iconButton('eye', `Show ${label}`, () => {
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    reveal.setAttribute('aria-pressed', String(show));
    reveal.setAttribute('aria-label', `${show ? 'Hide' : 'Show'} ${label}`);
    clear(reveal).append(icon(show ? 'eyeOff' : 'eye'));
  }, { pressed: false, cls: 'input-addon' });
  const group = h('div', { class: 'input-group' }, input, reveal, ...extraButtons);
  group.id = `${id}-group`;
  return { input, group };
}

/**
 * @param {any} app
 * @param {string|null} id  null = new item
 * @param {{type?: string}} [opts]
 */
export async function editView(app, id = null, opts = {}) {
  const prefs = await loadGeneratorPrefs();
  const listed = await app.call('items.list', {});
  const folders = listed.folders || [];
  let revision = null;
  let folderId = null;
  let draft;
  if (id) {
    const it = await app.call('items.get', { id });
    draft = cloneJson(it.data);
    revision = it.revision;
    folderId = it.folderId;
  } else {
    draft = fresh(opts.type || 'login');
  }

  function fresh(type) {
    if (type === 'login') {
      const url = app.webUrl();
      return newLoginItem({ url: url || '', name: url ? siteName(url) : '', password: generateFromPrefs(prefs) });
    }
    return newItem(type);
  }

  function ensureShape() {
    if (draft.type === 'login') {
      draft.login = draft.login && typeof draft.login === 'object' ? draft.login : {};
      for (const k of ['username', 'password', 'totp']) if (typeof draft.login[k] !== 'string') draft.login[k] = draft.login[k] == null ? '' : String(draft.login[k]);
      if (!Array.isArray(draft.login.uris)) draft.login.uris = [];
    }
    if (draft.type === 'card') draft.card = draft.card && typeof draft.card === 'object' ? draft.card : {};
    if (draft.type === 'identity') draft.identity = draft.identity && typeof draft.identity === 'object' ? draft.identity : {};
    if (!Array.isArray(draft.fields)) draft.fields = [];
    if (typeof draft.notes !== 'string') draft.notes = draft.notes == null ? '' : String(draft.notes);
    if (typeof draft.name !== 'string') draft.name = '';
  }
  ensureShape();

  const err = h('div', { class: 'form-error', role: 'alert', hidden: true });
  const sections = h('div', { class: 'edit-sections' });
  const form = h('form', { class: 'view-body form edit', novalidate: true }, sections, err);

  function showError(msg) {
    err.textContent = msg;
    err.hidden = !msg;
    if (msg) err.scrollIntoView({ block: 'nearest' });
  }

  function loginSection() {
    const l = draft.login;
    const meter = strengthMeter();
    const pw = secretInput(nextId('pw'), l.password, (v) => { l.password = v; meter.update(v); }, 'password', [
      iconButton('dice', 'Generate a new password', () => {
        l.password = generateFromPrefs(prefs);
        pw.input.value = l.password;
        meter.update(l.password);
      }, { cls: 'input-addon' }),
    ]);
    meter.update(l.password);
    const totpHint = h('div', { class: 'field-hint', text: 'otpauth:// URI or base32 secret from the site’s 2FA setup.' });
    const totp = textInput(nextId('totp'), l.totp, (v) => {
      l.totp = v;
      totpHint.classList.remove('error');
      totpHint.textContent = 'otpauth:// URI or base32 secret from the site’s 2FA setup.';
    }, { mono: true, placeholder: 'otpauth://totp/…' });
    totp.addEventListener('blur', () => {
      if (!l.totp.trim()) return;
      try {
        parseTotpInput(l.totp);
      } catch (e) {
        totpHint.classList.add('error');
        totpHint.textContent = e.message;
      }
    });

    const uriList = h('div', { class: 'uri-list' });
    const renderUris = () => {
      clear(uriList);
      l.uris.forEach((u, i) => {
        const inputId = nextId('uri');
        const input = textInput(inputId, u.uri, (v) => { u.uri = v; }, { type: 'url', placeholder: 'https://example.com', mono: true });
        input.setAttribute('aria-label', `Website ${i + 1}`);
        const sel = h('select', { class: 'select', 'aria-label': `Match rule for website ${i + 1}` });
        for (const m of URI_MATCH_TYPES) sel.append(h('option', { value: m, text: MATCH_LABELS[m], selected: (u.match || 'domain') === m }));
        sel.addEventListener('change', () => { u.match = sel.value; });
        const remove = iconButton('trash', `Remove website ${i + 1}`, () => {
          l.uris.splice(i, 1);
          renderUris();
        });
        uriList.append(h('div', { class: 'uri-row' }, input, sel, remove));
      });
      uriList.append(button('Add website', { variant: 'ghost', icon: 'plus', onClick: () => {
        const url = app.webUrl();
        const used = new Set(l.uris.map((u) => u.uri));
        let origin = '';
        try {
          origin = url ? new URL(url).origin : '';
        } catch {
          origin = '';
        }
        l.uris.push({ uri: origin && !used.has(origin) ? origin : '', match: 'domain' });
        renderUris();
        const inputs = uriList.querySelectorAll('input');
        if (inputs.length) inputs[inputs.length - 1].focus();
      } }));
    };
    renderUris();

    return h(
      'section',
      { class: 'card-section' },
      labelled('Username', textInput(nextId('user'), l.username, (v) => { l.username = v; }, { autocomplete: 'off' })),
      h('div', { class: 'field' }, h('label', { for: pw.input.id, class: 'field-label', text: 'Password' }), pw.group, meter.el),
      h('div', { class: 'field' }, h('label', { for: totp.id, class: 'field-label', text: 'Authenticator key (TOTP)' }), totp, totpHint),
      h('div', { class: 'field' }, h('div', { class: 'field-label', text: 'Websites' }), uriList),
    );
  }

  function objectSection(title, defs, obj) {
    return h(
      'section',
      { class: 'card-section' },
      h('h3', { class: 'section-title', text: title }),
      defs.map((f) => {
        const id = nextId(f.key);
        if (f.secret) {
          const s = secretInput(id, obj[f.key], (v) => { obj[f.key] = v; }, f.label.toLowerCase());
          return h('div', { class: 'field' }, h('label', { for: id, class: 'field-label', text: f.label }), s.group);
        }
        return labelled(f.label, textInput(id, obj[f.key], (v) => { obj[f.key] = v; }, { mono: !!f.mono }));
      }),
    );
  }

  function customFields() {
    const wrap = h('div', { class: 'cf-list' });
    const render = () => {
      clear(wrap);
      draft.fields.forEach((f, i) => {
        if (!f || typeof f !== 'object') return;
        const name = textInput(nextId('cfn'), f.name, (v) => { f.name = v; }, { placeholder: 'Name' });
        name.setAttribute('aria-label', `Custom field ${i + 1} name`);
        const value = textInput(nextId('cfv'), f.value == null ? '' : String(f.value), (v) => { f.value = v; }, { type: f.hidden ? 'password' : 'text', placeholder: 'Value', mono: true });
        value.setAttribute('aria-label', `Custom field ${i + 1} value`);
        const hide = iconButton(f.hidden ? 'eyeOff' : 'eye', f.hidden ? 'Hidden field (click to make visible)' : 'Visible field (click to hide)', () => {
          f.hidden = !f.hidden;
          render();
        }, { pressed: !!f.hidden });
        const remove = iconButton('trash', `Remove custom field ${i + 1}`, () => {
          draft.fields.splice(i, 1);
          render();
        });
        wrap.append(h('div', { class: 'cf-row' }, name, value, hide, remove));
      });
      wrap.append(button('Add field', { variant: 'ghost', icon: 'plus', onClick: () => {
        draft.fields.push({ name: '', value: '', hidden: false });
        render();
      } }));
    };
    render();
    return h('section', { class: 'card-section' }, h('h3', { class: 'section-title', text: 'Custom fields' }), wrap);
  }

  function renderSections() {
    clear(sections);
    if (!id) {
      sections.append(
        segmented('item-type', [
          { value: 'login', label: 'Login' },
          { value: 'note', label: 'Note' },
          { value: 'card', label: 'Card' },
          { value: 'identity', label: 'Identity' },
        ], draft.type, (t) => {
          const name = draft.name;
          draft = fresh(t);
          if (name && t !== 'login') draft.name = name;
          ensureShape();
          renderSections();
        }, 'Item type'),
      );
    }
    const nameInput = textInput(nextId('name'), draft.name, (v) => { draft.name = v; }, { required: true });
    nameInput.setAttribute('autofocus', '');
    const folderSel = h('select', { id: nextId('folder'), class: 'select' }, h('option', { value: '', text: 'No folder' }));
    for (const f of folders) folderSel.append(h('option', { value: f.id, text: f.name || '(unnamed folder)', selected: f.id === folderId }));
    folderSel.addEventListener('change', () => { folderId = folderSel.value || null; });
    const fav = h('input', { type: 'checkbox', id: nextId('fav'), class: 'checkbox', checked: draft.favorite === true });
    fav.addEventListener('change', () => { draft.favorite = fav.checked; });
    const notesId = nextId('notes');
    const notes = h('textarea', { id: notesId, class: 'input textarea', rows: draft.type === 'note' ? '8' : '3', spellcheck: 'true' });
    notes.value = draft.notes;
    notes.addEventListener('input', () => { draft.notes = notes.value; });

    sections.append(
      h('section', { class: 'card-section' },
        labelled('Name', nameInput),
        folders.length ? labelled('Folder', folderSel) : null,
        h('div', { class: 'check-row' }, fav, h('label', { for: fav.id, text: 'Favorite' })),
      ),
      draft.type === 'login' ? loginSection() : null,
      draft.type === 'card' ? objectSection('Card details', CARD_FIELDS, draft.card) : null,
      draft.type === 'identity' ? objectSection('Identity', IDENTITY_FIELDS, draft.identity) : null,
      h('section', { class: 'card-section' }, h('div', { class: 'field' }, h('label', { for: notesId, class: 'field-label', text: 'Notes' }), notes)),
      customFields(),
    );
    if (id) {
      sections.append(button('Delete item', { variant: 'danger', icon: 'trash', block: true, onClick: async () => {
        const ok = await confirmDialog({ title: 'Delete this item?', message: `“${draft.name}” will be deleted from your vault on every device.`, confirmLabel: 'Delete', danger: true });
        if (!ok) return;
        try {
          await app.call('items.delete', { id });
          app.toast('Item deleted', 'success');
          await app.back(true);
        } catch (e) {
          showError(app.errorMessage(e));
        }
      } }));
    }
    setTimeout(() => nameInput.focus(), 0);
  }

  const save = button('Save', { variant: 'primary', icon: 'check' });
  save.addEventListener('click', () => form.requestSubmit());
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    showError('');
    draft.name = draft.name.trim();
    if (!draft.name) {
      showError('Give the item a name.');
      const n = form.querySelector('input[required]');
      if (n) n.focus();
      return;
    }
    if (draft.type === 'login') {
      draft.login.uris = draft.login.uris
        .filter((u) => u && typeof u.uri === 'string' && u.uri.trim())
        .map((u) => ({ ...u, uri: u.uri.trim(), match: u.match || 'domain' }));
      draft.login.totp = draft.login.totp.trim();
      if (draft.login.totp) {
        try {
          parseTotpInput(draft.login.totp);
        } catch (ex) {
          showError(`Authenticator key: ${ex.message}`);
          return;
        }
      }
    }
    draft.fields = draft.fields.filter((f) => f && (String(f.name || '').trim() || String(f.value ?? '').trim()));
    withBusy(save, async () => {
      try {
        const res = await app.call('items.save', { id, folderId, data: draft, baseRevision: revision });
        app.toast(id ? 'Changes saved' : 'Item saved', 'success');
        if (id) await app.back();
        else {
          app.stack.length = 1;
          await app.go(detailView, res.id);
        }
      } catch (ex) {
        showError(app.errorMessage(ex));
      }
    });
  });

  renderSections();
  return h(
    'div',
    { class: 'view view-edit' },
    app.header({ title: id ? `Edit ${TITLES[draft.type] || 'item'}` : 'New item', back: true, actions: [save] }),
    form,
  );
}
