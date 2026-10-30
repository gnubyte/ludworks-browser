// Password & passkey popups: the autofill dropdown under a login field, the key bubble in the address
// bar (fill / copy / save prompt), and the passkey dialogs (create, sign in).
import { icon, h, clear } from './icons.js';

const call = (cmd, args) => window.lw.call(cmd, args);
const act = (kind, action, data) => call('popup.action', { kind, action, data });
const answer = (id, value) => call('prompt.answer', { id, value });

function letter(name) {
  return h('span', { class: 'favicon letter', style: { width: '26px', height: '26px', fontSize: '13px', borderRadius: '7px' } }, (String(name || '?').trim()[0] || '?').toUpperCase());
}

function notice(text, warn = false) {
  return h('div', { class: `notice${warn ? ' warn' : ''}` }, text);
}

function unlockForm(kind, onDone) {
  const pass = h('input', { class: 'input', type: 'password', 'aria-label': 'Master password', placeholder: 'Master password', autocomplete: 'current-password' });
  const err = h('div', { class: 'error-text', hidden: true });
  const btn = h('button', { class: 'btn primary', type: 'submit' }, 'Unlock');
  const form = h('form', { class: 'row', style: { padding: '8px 10px' } }, pass, btn);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    btn.disabled = true;
    const r = await act(kind, 'unlock', { password: pass.value }).catch((x) => ({ ok: false, error: { message: x.message } }));
    btn.disabled = false;
    pass.value = '';
    if (r && r.ok === false) {
      err.hidden = false;
      err.textContent = (r.error && r.error.message) || 'Could not unlock.';
      pass.focus();
    } else if (onDone) onDone(r);
  });
  return h('div', {}, form, h('div', { style: { padding: '0 12px 8px' } }, err));
}

/**
 * A dropdown row: chosen with the mouse on mousedown (focus stays in the page), or with the keyboard
 * (Enter / Space on the focused row: a click without a pointer, detail 0).
 */
function choice(content, onChoose) {
  const row = h('button', { class: 'item' }, ...content);
  row.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    onChoose();
  });
  row.addEventListener('click', (e) => {
    if (e.detail === 0) onChoose();
  });
  return row;
}

/** Brief check mark on a copy button once the copy went through. */
function copied(btn, r, iconName) {
  if (!r || r.ok === false) return;
  btn.replaceChildren(icon('check', { size: 14 }));
  btn.classList.add('copied');
  setTimeout(() => {
    btn.replaceChildren(icon(iconName, { size: 14 }));
    btn.classList.remove('copied');
  }, 1200);
}

/**
 * One-time (MFA) codes in the key popup: each login with a TOTP secret gets a chip showing its current
 * code and a ring that empties as the code runs out (it turns orange in the last 5 seconds); a click
 * copies the code. Codes come from the browser (`key:totp`) and are fetched again when they roll over;
 * the ticker stops when the popup closes or re-renders.
 */
function totpTicker(box) {
  const chips = [];
  let loading = false;
  const refresh = async () => {
    if (loading || !chips.length) return;
    loading = true;
    try {
      const r = await act('key', 'totp', { ids: chips.map((c) => c.id) });
      const now = Date.now();
      for (const c of chips) {
        const v = r && r.ok && r.value ? r.value[c.id] : null;
        c.code.textContent = v ? formatCode(v.code) : '—';
        c.period = v ? v.period : 30;
        c.expires = v ? now + v.remaining * 1000 : 0;
      }
    } finally {
      loading = false;
    }
    tick();
  };
  const tick = () => {
    if (!box.isConnected) return clearInterval(timer);
    const now = Date.now();
    let stale = false;
    for (const c of chips) {
      if (!c.expires) continue;
      const left = Math.max(0, (c.expires - now) / 1000);
      if (left <= 0) stale = true;
      c.ring.style.setProperty('--p', `${Math.round((left / c.period) * 360)}deg`);
      c.btn.classList.toggle('expiring', left <= 5);
      c.btn.title = `Copy one-time code (MFA) · ${Math.ceil(left)} s left`;
    }
    if (stale) refresh();
  };
  const timer = setInterval(tick, 1000);
  setTimeout(refresh, 0);
  return {
    chip(it) {
      const code = h('span', { class: 'totp-code' }, '··· ···');
      const ring = h('span', { class: 'totp-ring', 'aria-hidden': 'true' });
      const btn = h('button', {
        class: 'btn small totp',
        title: 'Copy one-time code (MFA)',
        'aria-label': 'Copy one-time code',
        onclick: async (e) => {
          e.stopPropagation();
          const r = await act('key', 'copy', { id: it.id, field: 'totp' });
          if (!r || r.ok === false) return;
          btn.classList.add('copied');
          setTimeout(() => btn.classList.remove('copied'), 1200);
        },
      }, ring, code);
      chips.push({ id: it.id, code, ring, btn, period: 30, expires: 0 });
      return btn;
    },
  };
}

/** "123456" → "123 456", "12345678" → "1234 5678" (as authenticator apps show them). */
export function formatCode(code) {
  const s = String(code || '');
  if (/^\d{6}$/.test(s)) return `${s.slice(0, 3)} ${s.slice(3)}`;
  if (/^\d{8}$/.test(s)) return `${s.slice(0, 4)} ${s.slice(4)}`;
  return s;
}

export const POPUPS = {
  // ------------------------------------------------------------------ dropdown under a field
  fill(d, ctx) {
    const box = h('div', { class: 'popup fit dropdown' });
    const list = h('div', { class: 'list scroll' });
    if (d.locked) {
      box.append(h('div', { class: 'head' }, icon('key', { size: 16 }), h('div', { class: 'sub' }, d.kind === 'totp' ? 'Unlock Ludworks to fill one-time codes' : 'Unlock Ludworks to fill passwords')), unlockForm('fill'));
      return box;
    }
    if (d.blocked) list.append(h('div', { class: 'pad' }, notice(`${d.host} does not use a secure (HTTPS) connection: Ludworks does not fill passwords here.`, true)));
    for (const p of d.passkeys || []) {
      list.append(choice([h('span', { class: 'ic' }, icon('passkey', { size: 18 })), h('span', { class: 'grow' }, h('div', { class: 't' }, p.userName || p.displayName || 'Passkey'), h('div', { class: 's' }, `Passkey · ${p.itemName || ''}`))], () => act('fill', 'passkey', { requestKey: p.requestKey, key: p.key })));
    }
    for (const it of d.items || []) {
      const sub = it.otherHost ? `Saved for ${it.otherHost.join(', ')}` : d.kind === 'totp' ? `One-time code · ${it.name}` : it.name;
      list.append(
        choice([letter(it.name), h('span', { class: 'grow' }, h('div', { class: 't' }, it.username || it.name), h('div', { class: 's' }, sub))], () => {
          if (it.otherHost && !window.confirm(`This login was saved for ${it.otherHost.join(', ')}, not ${d.host}. Fill it anyway?`)) return;
          if (d.insecure && !window.confirm(`${d.host} is not using a secure (HTTPS) connection. Fill anyway?`)) return;
          act('fill', 'fill', { id: it.id, allowOtherHost: !!it.otherHost, allowInsecure: !!d.insecure });
        }),
      );
    }
    if (d.generate) {
      list.append(choice([h('span', { class: 'ic' }, icon('shield', { size: 18 })), h('span', { class: 'grow' }, h('div', { class: 't' }, 'Use a strong password'), h('div', { class: 's' }, 'Generated by Ludworks — you can save it after signing up'))], () => act('fill', 'generate', {})));
    }
    // below the scrolling list, so it stays in reach however many logins there are
    const foot = h('div', { class: 'list' }, h('div', { class: 'sep' }), choice([h('span', { class: 'ic' }, icon('key', { size: 16 })), h('span', { class: 'grow t muted' }, 'Manage passwords…')], () => act('fill', 'manage', {})));
    // Keyboard: ArrowDown in the field moves focus here (first row); arrows move, Enter picks, Esc closes.
    const rows = () => [...box.querySelectorAll('button.item')];
    if (ctx) {
      ctx.select = (i) => {
        const r = rows()[i];
        if (r) r.focus();
      };
    }
    box.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      e.preventDefault();
      const all = rows();
      if (!all.length) return;
      const i = all.indexOf(document.activeElement);
      const n = all.length;
      const next = e.key === 'ArrowDown' ? (i < 0 ? 0 : (i + 1) % n) : i < 0 ? n - 1 : (i + n - 1) % n;
      all[next].focus();
    });
    box.append(list, foot);
    return box;
  },

  // -------------------------------------------------------------------- key bubble (omnibox)
  key(d, ctx) {
    const box = h('div', { class: 'popup fit' });
    const render = (data) => {
      clear(box);
      if (data.phase === 'logged_out') {
        box.append(h('div', { class: 'pad stack' }, h('h2', { style: { margin: 0, fontSize: '15px' } }, 'Ludworks passwords'), notice('Sign in to your Ludworks server to fill and save passwords and passkeys on every device.'), h('div', { class: 'row end' }, h('button', { class: 'btn primary', onclick: () => act('key', 'signin', {}) }, 'Sign in'))));
        return;
      }
      if (data.phase === 'locked') {
        box.append(h('div', { class: 'head' }, icon('key', { size: 18 }), h('div', {}, h('h2', {}, 'Vault locked'), h('div', { class: 'sub' }, data.host))), unlockForm('key', () => {}));
        return;
      }
      if (data.capture) {
        const c = data.capture;
        const decide = (decision) => act('key', 'capture', { id: c.id, decision });
        box.append(
          h('div', { class: 'head' }, icon('key', { size: 18 }), h('div', {}, h('h2', {}, c.kind === 'update' ? 'Update saved password?' : 'Save password?'), h('div', { class: 'sub' }, c.kind === 'update' ? `${c.itemName} · ${c.host}` : c.host))),
          h('div', { class: 'pad stack' }, h('div', { class: 'field' }, h('span', {}, 'Username'), h('div', {}, c.username || '(none)')), h('div', { class: 'sub' }, 'Saved to your end-to-end encrypted Ludworks vault and synced to your devices.')),
          h('div', { class: 'foot' }, h('button', { class: 'btn', onclick: () => decide('never') }, 'Never for this site'), h('button', { class: 'btn', onclick: () => decide('dismiss') }, 'Not now'), h('button', { class: 'btn primary', onclick: () => decide(c.kind) }, c.kind === 'update' ? 'Update' : 'Save')),
        );
        return;
      }
      const total = data.total || data.items.length;
      box.append(h('div', { class: 'head' }, icon('key', { size: 18 }), h('div', {}, h('h2', {}, 'Passwords'), h('div', { class: 'sub' }, `${data.host || ''}${total > 1 ? ` · ${total} logins` : ''}`))));
      const list = h('div', { class: 'list scroll' });
      const rows = []; // [{row, text}] for the search box
      if (!data.items.length) list.append(h('div', { class: 'pad muted' }, 'No saved logins for this site.'));
      const codes = totpTicker(box);
      for (const it of data.items) {
        const copy = (field, label) => {
          const btn = h('button', { class: 'icon-btn small', title: `Copy ${label}`, 'aria-label': `Copy ${label}`, onclick: async (e) => { e.stopPropagation(); copied(btn, await act('key', 'copy', { id: it.id, field }), field === 'username' ? 'user' : 'lock'); } }, icon(field === 'username' ? 'user' : 'lock', { size: 14 }));
          return btn;
        };
        const row = h(
          'div',
          { class: 'item' },
          letter(it.name),
          h('span', { class: 'grow' }, h('div', { class: 't' }, it.name), h('div', { class: 's' }, `${it.username || '—'}${it.passkeys ? ` · ${it.passkeys} passkey${it.passkeys > 1 ? 's' : ''}` : ''}${it.otherHost ? ' · other host' : ''}`)),
          copy('username', 'username'),
          copy('password', 'password'),
          it.totp ? codes.chip(it) : null,
          h('button', {
            class: 'btn small primary',
            onclick: async () => {
              const allowOtherHost = !!it.otherHost && window.confirm('This login was saved for another host of this site. Fill it here?');
              if (data.insecure && !window.confirm(`${data.host} is not using a secure (HTTPS) connection. Fill anyway?`)) return;
              const r = await act('key', 'fill', { id: it.id, allowOtherHost, allowInsecure: !!data.insecure });
              if (r && r.ok === false) window.alert(r.error.message === 'other_host' ? 'This login was saved for another host of this site.' : r.error.message);
            },
          }, 'Fill'),
        );
        rows.push({ row, text: `${it.name}\n${it.username || ''}`.toLowerCase() });
        list.append(row);
      }
      // Many logins for one site (several Google accounts, say): a search box over the scrolling list.
      if (data.items.length > 6) {
        const none = h('div', { class: 'pad muted', hidden: true }, 'No matching logins.');
        const input = h('input', { class: 'input', type: 'search', placeholder: `Search ${total} logins`, 'aria-label': 'Search logins', autocomplete: 'off', spellcheck: 'false' });
        input.addEventListener('input', () => {
          const q = input.value.trim().toLowerCase();
          let shown = 0;
          for (const r of rows) {
            r.row.hidden = !!q && !r.text.includes(q);
            if (!r.row.hidden) shown++;
          }
          none.hidden = shown > 0;
          list.scrollTop = 0;
        });
        list.append(none);
        box.append(h('div', { class: 'search' }, input));
        setTimeout(() => input.focus(), 30);
      }
      const gen = h('div', { class: 'mono', hidden: true, style: { padding: '0 16px 8px' } });
      box.append(
        list,
        gen,
        h('div', { class: 'foot' }, h('button', { class: 'btn', onclick: async () => { const r = await act('key', 'generate', {}); if (r && r.ok) { gen.hidden = false; gen.textContent = r.value; } } }, 'Generate password'), h('button', { class: 'btn', onclick: () => act('key', 'manage', {}) }, 'Manage…')),
      );
    };
    render(d);
    ctx.onData = render;
    return box;
  },

  // ------------------------------------------------------------------------ passkey: create
  'passkey-create'(d) {
    const id = d.promptId;
    const pass = d.needsPassword ? h('input', { class: 'input', type: 'password', autocomplete: 'current-password', 'aria-label': 'Master password' }) : null;
    const target = h('select', { class: 'input', 'aria-label': 'Save to' }, h('option', { value: '' }, `New login: ${d.rpName}`), ...(d.logins || []).map((l) => h('option', { value: l.id }, `${l.name}${l.username ? ` (${l.username})` : ''}`)));
    const go = () => answer(id, { itemId: target.value || null, password: pass ? pass.value : '' });
    if (pass) setTimeout(() => pass.focus(), 30);
    return h(
      'div',
      { class: 'popup' },
      h('div', { class: 'head' }, icon('passkey', { size: 22 }), h('div', {}, h('h2', {}, 'Create a passkey?'), h('div', { class: 'sub' }, d.rpId))),
      h(
        'div',
        { class: 'pad stack' },
        h('div', {}, `For ${d.userName || d.displayName || 'your account'} on ${d.rpName}. It is saved in your Ludworks vault and works on all your devices.`),
        d.excluded ? notice('A passkey for this account is already saved in Ludworks.', true) : null,
        !d.locked && d.logins && d.logins.length ? h('label', { class: 'field' }, h('span', {}, 'Save to'), target) : null,
        pass ? h('label', { class: 'field' }, h('span', {}, d.locked ? 'Master password (vault is locked)' : 'Confirm with your master password'), pass) : null,
      ),
      h('div', { class: 'foot' }, h('button', { class: 'btn', onclick: () => answer(id, { fallback: true }) }, 'Use another device or key'), h('button', { class: 'btn', onclick: () => answer(id, null) }, 'Cancel'), h('button', { class: 'btn primary', onclick: go }, 'Create passkey')),
    );
  },

  // --------------------------------------------------------------------------- passkey: get
  'passkey-get'(d) {
    const id = d.promptId;
    const pass = d.needsPassword ? h('input', { class: 'input', type: 'password', autocomplete: 'current-password', 'aria-label': 'Master password' }) : null;
    let chosen = d.candidates && d.candidates.length ? d.candidates[0].key : null;
    const list = h('div', { class: 'list' });
    for (const c of d.candidates || []) {
      const row = h('button', { class: `item${c.key === chosen ? ' sel' : ''}` }, h('span', { class: 'ic' }, icon('passkey', { size: 18 })), h('span', { class: 'grow' }, h('div', { class: 't' }, c.userName || c.displayName || 'Passkey'), h('div', { class: 's' }, c.itemName)));
      row.addEventListener('click', () => {
        chosen = c.key;
        list.querySelectorAll('.item').forEach((x) => x.classList.toggle('sel', x === row));
      });
      row.addEventListener('dblclick', () => answer(id, { key: c.key, password: pass ? pass.value : '' }));
      list.append(row);
    }
    if (pass) setTimeout(() => pass.focus(), 30);
    return h(
      'div',
      { class: 'popup' },
      h('div', { class: 'head' }, icon('passkey', { size: 22 }), h('div', {}, h('h2', {}, 'Sign in with a passkey'), h('div', { class: 'sub' }, d.rpId))),
      d.locked ? h('div', { class: 'pad' }, notice('Unlock your Ludworks vault to use the passkeys saved in it.')) : list,
      pass ? h('div', { class: 'pad' }, h('label', { class: 'field' }, h('span', {}, d.locked ? 'Master password' : 'Confirm with your master password'), pass)) : null,
      h('div', { class: 'foot' }, h('button', { class: 'btn', onclick: () => answer(id, { fallback: true }) }, 'Use another device or key'), h('button', { class: 'btn', onclick: () => answer(id, null) }, 'Cancel'), h('button', { class: 'btn primary', onclick: () => answer(id, { key: chosen, password: pass ? pass.value : '' }) }, 'Continue')),
    );
  },
};
