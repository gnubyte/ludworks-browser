// Settings → Content blocking: master switch, filter lists, "My filters" and the sites where blocking
// is off. Talks to the blocker feature through its `blocker.*` page commands.
import { h, clear, toggle } from './ui.js';

const fmt = (n) => Number(n || 0).toLocaleString();

function ago(ms) {
  if (!ms) return 'never';
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}

/**
 * The section's elements (filled asynchronously).
 * @param {(cmd: string, args?: any) => Promise<any>} call
 */
export function blockerSection(call) {
  const head = h('h2', { id: 'blocker' }, 'Content blocking');
  const main = h('div', { class: 'card' }, h('div', { class: 'setting muted' }, 'Loading…'));
  const listsHead = h('h2', { id: 'blocker-lists', style: { fontSize: '13.5px' } }, 'Filter lists');
  const lists = h('div', { class: 'card' });
  const mineHead = h('h2', { id: 'blocker-mine', style: { fontSize: '13.5px' } }, 'My filters');
  const mine = h('div', { class: 'card' });
  const allowHead = h('h2', { id: 'blocker-allow', style: { fontSize: '13.5px' } }, 'Sites where blocking is off');
  const allow = h('div', { class: 'card' });
  let state = null;
  let customDirty = false;

  const textarea = h('textarea', { class: 'input', rows: '10', spellcheck: 'false', placeholder: '! One filter per line, e.g.\n||ads.example.com^\nexample.com##.sponsored\n@@||cdn.example.com^$script', style: { fontFamily: 'ui-monospace, "Cascadia Mono", Consolas, monospace', fontSize: '12.5px', minHeight: '180px', whiteSpace: 'pre', overflowWrap: 'normal', overflowX: 'auto' } });
  textarea.addEventListener('input', () => {
    customDirty = true;
    saveBtn.disabled = false;
  });
  const customInfo = h('span', { class: 'muted', style: { fontSize: '12.5px', flex: '1' } });
  const saveBtn = h('button', { class: 'btn primary', disabled: true }, 'Save');
  saveBtn.addEventListener('click', async () => {
    saveBtn.disabled = true;
    customDirty = false;
    render(await call('blocker.custom', { text: textarea.value }));
    saveBtn.textContent = 'Saved ✓';
    setTimeout(() => (saveBtn.textContent = 'Save'), 1500);
  });
  mine.append(
    h('div', { class: 'setting', style: { display: 'block' } }, h('div', { class: 'd', style: { marginBottom: '10px' } }, 'Your own filters, in Adblock Plus / uBlock Origin syntax. Elements you hide with “Hide an element…” in the shield menu are added here.'), textarea, h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', marginTop: '10px' } }, customInfo, saveBtn)),
  );

  const allowList = h('div', { class: 'list' });
  const allowInput = h('input', { class: 'input', placeholder: 'example.com', spellcheck: 'false', style: { maxWidth: '320px' } });
  const addAllow = async () => {
    const v = allowInput.value.trim();
    if (!v || !state) return;
    allowInput.value = '';
    render(await call('blocker.allowlist', { text: [...state.allow, v].join('\n') }));
  };
  allowInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') addAllow();
  });
  allow.append(allowList, h('div', { class: 'setting' }, h('div', { class: 'grow' }, allowInput), h('button', { class: 'btn', onclick: addAllow }, 'Add site')));

  function render(s) {
    state = s;
    // ---- main switch + stats
    clear(main);
    const updateBtn = h('button', { class: 'btn', disabled: s.updating || s.compiling }, s.updating ? 'Updating…' : s.compiling ? 'Preparing…' : 'Update now');
    updateBtn.addEventListener('click', async () => {
      updateBtn.disabled = true;
      updateBtn.textContent = 'Updating…';
      render(await call('blocker.update'));
    });
    const lastCheck = Math.max(0, ...s.lists.filter((l) => l.on).map((l) => l.checkedAt || 0));
    main.append(
      h(
        'div',
        { class: 'setting' },
        h('div', { class: 'grow' }, h('div', {}, 'Block ads, trackers and malware'), h('div', { class: 'd' }, s.ready ? `${fmt(s.filters.network)} network and ${fmt(s.filters.cosmetic)} cosmetic filters active. Private windows are protected too.` : s.compiling || s.updating ? 'Downloading and preparing filter lists…' : 'No filter lists downloaded yet.')),
        toggle(s.enabled, async (v) => render(await call('blocker.enabled', { on: v }))),
      ),
      h(
        'div',
        { class: 'setting' },
        h('div', { class: 'grow' }, h('div', {}, `${fmt(s.total)} requests blocked`), h('div', { class: 'd' }, `Since ${new Date(s.since).toLocaleDateString()}`)),
        h('button', { class: 'btn', onclick: async () => window.confirm('Reset the blocked-requests counter?') && render(await call('blocker.reset-stats')) }, 'Reset counter'),
      ),
      h('div', { class: 'setting' }, h('div', { class: 'grow' }, h('div', {}, 'Filter list updates'), h('div', { class: 'd' }, `Lists update automatically as often as each publisher asks (usually every few days). Last check: ${ago(lastCheck)}.`)), updateBtn),
    );
    // ---- lists by group
    clear(lists);
    let group = null;
    for (const l of s.lists) {
      if (l.group !== group) {
        group = l.group;
        lists.append(h('div', { class: 'setting', style: { padding: '10px 18px 6px', color: 'var(--faint)', fontSize: '11.5px', fontWeight: '650', textTransform: 'uppercase', letterSpacing: '0.04em' } }, group));
      }
      const info = l.error && !l.downloaded ? `Download failed: ${l.error}` : !l.downloaded ? (l.on ? (s.updating ? 'Downloading…' : 'Not downloaded yet') : 'Off') : `${l.entries !== null ? `${fmt(l.entries)} filters · ` : ''}updated ${ago(l.updatedAt)}${l.error ? ` · last check failed: ${l.error}` : ''}`;
      lists.append(
        h(
          'div',
          { class: 'setting' },
          h('div', { class: 'grow' }, h('div', {}, l.title), h('div', { class: 'd', title: l.url }, info)),
          toggle(l.on, async (v) => render(await call('blocker.list', { id: l.id, on: v })), l.title),
        ),
      );
    }
    // ---- my filters
    if (!customDirty) textarea.value = s.custom;
    const c = s.customCounts || {};
    customInfo.textContent = s.custom.trim() ? `${fmt(c.network)} network, ${fmt(c.cosmetic)} cosmetic${c.unsupported ? `, ${fmt(c.unsupported)} not supported` : ''}` : '';
    // ---- allowlist
    clear(allowList);
    if (!s.allow.length) allowList.append(h('div', { class: 'row muted' }, 'Blocking is on everywhere. Switch it off for a site from the shield button in the toolbar.'));
    for (const host of s.allow) {
      allowList.append(h('div', { class: 'row' }, h('div', { class: 'grow' }, h('div', { class: 't' }, host)), h('button', { class: 'btn small', onclick: async () => render(await call('blocker.allowlist', { text: s.allow.filter((x) => x !== host).join('\n') })) }, 'Remove')));
    }
  }

  const refresh = async () => {
    try {
      render(await call('blocker.state'));
    } catch (e) {
      clear(main);
      main.append(h('div', { class: 'setting muted' }, `Content blocker unavailable: ${e.message}`));
    }
  };
  refresh();
  window.lwPage.on('page-event', (ev) => {
    if (ev && ev.type === 'blocker') refresh();
  });
  return [head, main, listsHead, lists, mineHead, mine, allowHead, allow];
}
