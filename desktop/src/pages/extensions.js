// ludworks://extensions — installed extensions: turn on/off, pin, options, details (permissions, site
// access, what does not work here, errors), remove, updates; developer mode: load unpacked, reload,
// install from a .crx/.zip file. Talks to src/main/extensions/extensions.js (extensions.* commands).
import { h, clear, applyTheme, sideNav, toggle, confirmDialog, fmtBytes } from './ui.js';

const app = document.getElementById('app');
const main = h('main', { class: 'main' });
app.append(sideNav('extensions'), main);
const call = (cmd, args = {}) => window.lwPage.call(cmd, args);

let list = null;
let detailsId = null;
let status = '';
let filter = '';

const SOURCES = { webstore: 'Chrome Web Store', crx: 'Package file (.crx)', zip: 'Package file (.zip)', unpacked: 'Unpacked folder' };

function ago(ms) {
  if (!ms) return 'never';
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}

function extIcon(src, name, cls = 'ext-ic') {
  if (src && /^data:image\//.test(src)) return h('img', { class: cls, src, alt: '' });
  return h('span', { class: `${cls} ph` }, (String(name || '?').trim()[0] || '?').toUpperCase());
}

function setStatus(text) {
  status = text || '';
  const el = document.getElementById('ext-status');
  if (el) el.textContent = status;
}

async function act(cmd, args, { busy } = {}) {
  if (busy) setStatus(busy);
  try {
    const r = await call(cmd, args);
    if (r && r.list) list = r.list;
    else if (r && Array.isArray(r.items)) list = r;
    if (r && r.ok === false && !r.cancelled) setStatus(r.error || 'Something went wrong.');
    else if (busy) setStatus('');
    return r;
  } catch (e) {
    setStatus(String(e.message || e).replace(/^Error invoking remote method 'page': (Error: )?/, ''));
    return null;
  }
}

// ------------------------------------------------------------------------------------- list
function card(it) {
  const flags = h('div', { class: 'flags' });
  if (it.source === 'unpacked') flags.append(h('span', { class: 'pill muted', title: it.path || '' }, 'Unpacked'));
  if (it.error) flags.append(h('span', { class: 'pill warn', title: it.error }, 'Could not load'));
  if (it.pendingUpdate) flags.append(h('span', { class: 'pill' }, `Update ${it.pendingUpdate.version} needs approval`));
  if (it.unsupported) flags.append(h('span', { class: 'pill muted', title: 'Some features this extension uses are not available in Ludworks Browser' }, 'Partly supported'));
  if (it.errors) flags.append(h('span', { class: 'pill warn' }, `${it.errors} error${it.errors === 1 ? '' : 's'}`));
  return h(
    'div',
    { class: `card ext-card ${it.enabled ? '' : 'off'}`, dataset: { id: it.id } },
    h('div', { class: 'top' }, extIcon(it.icon, it.name), h('div', { class: 'meta' }, h('div', { class: 'name' }, it.name, h('span', { class: 'ver' }, it.version)), h('div', { class: 'desc' }, it.description || ''))),
    flags.children.length ? flags : null,
    h(
      'div',
      { class: 'actions' },
      h('button', { class: 'btn small', onclick: () => openDetails(it.id) }, 'Details'),
      h('button', { class: 'btn small danger', onclick: () => remove(it) }, 'Remove'),
      it.hasOptions && it.enabled ? h('button', { class: 'btn small', onclick: () => call('extensions.options', { id: it.id }) }, 'Options') : null,
      h('span', { class: 'grow' }),
      toggle(it.enabled, (on) => act('extensions.enable', { id: it.id, on }).then(render), `${it.name} on/off`),
    ),
  );
}

async function remove(it) {
  if (!confirmDialog(`Remove “${it.name}” from Ludworks Browser?\n\nIts settings and data are deleted too.`)) return;
  await act('extensions.remove', { id: it.id });
  if (detailsId === it.id) detailsId = null;
  render();
}

function renderList() {
  const top = h(
    'div',
    { class: 'ext-top' },
    h('h1', {}, 'Extensions'),
    h('input', { class: 'input', placeholder: 'Search extensions', 'aria-label': 'Search extensions', style: { width: '220px' }, value: filter, oninput: (e) => { filter = e.target.value; drawGrid(); } }),
    h('label', { class: 'dev' }, 'Developer mode', toggle(list.devMode, (on) => act('extensions.dev-mode', { on }).then(render), 'Developer mode')),
  );
  const tools = h(
    'div',
    { class: 'card ext-dev' },
    h('div', { class: 'grow', id: 'ext-status' }, status || `Updates: ${list.autoUpdate ? 'automatic, daily' : 'off'} · last check ${ago(list.lastCheck)}`),
    h('button', { class: 'btn', onclick: async (e) => { e.currentTarget.disabled = true; const r = await act('extensions.update', {}, { busy: 'Checking for updates…' }); if (r && r.ok) setStatus(r.updated.length ? `Updated: ${r.updated.length}` : r.needsApproval.length ? 'An update needs your approval (see the extension).' : 'All extensions are up to date.'); render(); } }, 'Update now'),
    h('button', { class: 'btn', onclick: () => call('extensions.open-store', {}) }, 'Chrome Web Store'),
    list.devMode ? h('button', { class: 'btn', onclick: async () => { const r = await act('extensions.load-unpacked', {}, { busy: 'Loading…' }); if (r && r.ok) setStatus('Loaded.'); render(); } }, 'Load unpacked') : null,
    list.devMode ? h('button', { class: 'btn', onclick: async () => { const r = await act('extensions.install-file', {}, { busy: 'Installing…' }); if (r && r.ok) setStatus('Installed.'); render(); } }, 'Install from .crx/.zip') : null,
  );
  const grid = h('div', { class: 'ext-grid', id: 'ext-grid' });
  main.append(top, tools, h('div', { class: 'notice ext-note' }, 'Extensions run in normal windows only, not in private windows. Some Chrome features are not available in Ludworks Browser; each extension’s details list what it uses that will not work here.'), grid);
  drawGrid();
}

function drawGrid() {
  const grid = document.getElementById('ext-grid');
  if (!grid) return;
  clear(grid);
  const q = filter.trim().toLowerCase();
  const items = list.items.filter((it) => !q || it.name.toLowerCase().includes(q) || (it.description || '').toLowerCase().includes(q) || it.id.includes(q));
  if (!list.items.length) {
    grid.replaceWith(h('div', { class: 'card ext-empty', id: 'ext-grid' }, h('div', {}, 'No extensions yet.'), h('div', {}, 'Open an extension in the Chrome Web Store and click “Add to Chrome” or the + button in the toolbar.'), h('button', { class: 'btn primary', onclick: () => call('extensions.open-store', {}) }, 'Open the Chrome Web Store')));
    return;
  }
  for (const it of items) grid.append(card(it));
}

// ---------------------------------------------------------------------------------- details
async function openDetails(id) {
  detailsId = id;
  history.replaceState(null, '', `#${id}`);
  render();
}

function closeDetails() {
  detailsId = null;
  history.replaceState(null, '', location.pathname);
  render();
}

function kv(rows) {
  return h('div', { class: 'kv' }, ...rows.filter(Boolean).flatMap(([k, v]) => [h('div', { class: 'k' }, k), h('div', { class: 'v' }, v)]));
}

async function renderDetails() {
  let d;
  try {
    d = await call('extensions.details', { id: detailsId });
  } catch {
    detailsId = null;
    return render();
  }
  clear(main);
  const back = h('button', { class: 'btn small ext-back', onclick: closeDetails }, '← All extensions');
  const head = h(
    'div',
    { class: 'ext-head' },
    extIcon(d.icon, d.name),
    h('div', { class: 'grow' }, h('h1', {}, d.name), h('div', { class: 'muted' }, `Version ${d.version}${d.manifestVersion ? ` · Manifest V${d.manifestVersion}` : ''}`)),
    toggle(d.enabled, (on) => act('extensions.enable', { id: d.id, on }).then(render), 'On/off'),
  );
  const buttons = h(
    'div',
    { class: 'ext-buttons' },
    d.hasOptions && d.enabled ? h('button', { class: 'btn', onclick: () => call('extensions.options', { id: d.id }) }, 'Options') : null,
    h('button', { class: 'btn', onclick: () => act('extensions.pin', { id: d.id, on: !d.pinned }).then(render) }, d.pinned ? 'Unpin from toolbar' : 'Pin to toolbar'),
    d.source === 'webstore' ? h('button', { class: 'btn', onclick: async () => { const r = await act('extensions.update', { id: d.id }, { busy: 'Checking for updates…' }); if (r && r.ok) setStatus(r.updated.length ? 'Updated.' : r.needsApproval.length ? 'The update needs your approval.' : 'Up to date.'); render(); } }, 'Update now') : null,
    d.pendingUpdate ? h('button', { class: 'btn primary', onclick: async () => { await act('extensions.approve-update', { id: d.id }, { busy: 'Updating…' }); render(); } }, `Review update ${d.pendingUpdate.version}`) : null,
    d.source === 'unpacked' || list.devMode ? h('button', { class: 'btn', onclick: async () => { const r = await act('extensions.reload', { id: d.id }, { busy: 'Reloading…' }); if (r && r.ok) setStatus('Reloaded.'); render(); } }, 'Reload') : null,
    d.storeUrl ? h('button', { class: 'btn', onclick: () => call('extensions.open-url', { url: d.storeUrl }) }, 'View in Chrome Web Store') : null,
    d.homepage ? h('button', { class: 'btn', onclick: () => call('extensions.open-url', { url: d.homepage }) }, 'Website') : null,
    list.devMode ? h('button', { class: 'btn', onclick: () => call('extensions.show-folder', { id: d.id }) }, 'Show files') : null,
    h('button', { class: 'btn danger', onclick: () => remove(d) }, 'Remove'),
  );
  const notices = [];
  if (d.error) notices.push(h('div', { class: 'notice warn' }, `Could not be loaded: ${d.error}`));
  if (d.updateError) notices.push(h('div', { class: 'notice warn' }, `Last update failed: ${d.updateError}`));
  if (d.pendingUpdate) notices.push(h('div', { class: 'notice' }, `Version ${d.pendingUpdate.version} asks for more: ${d.pendingUpdate.newPermissions.join('; ')}. It is installed only after you approve it.`));
  const perms = d.permissions.length ? h('ul', { class: 'plist' }, ...d.permissions.map((p) => h('li', {}, p))) : h('ul', { class: 'plist none' }, h('li', {}, 'No special permissions.'));
  const optional = [...d.optional.permissions, ...d.optional.origins];
  const unsupported = d.unsupportedList.length ? h('ul', { class: 'plist' }, ...d.unsupportedList.map((p) => h('li', {}, p))) : h('ul', { class: 'plist none' }, h('li', {}, 'Everything this extension asks for is available.'));
  const errors = d.errorList.length
    ? h('div', {}, ...d.errorList.slice(0, 20).map((e) => h('div', { class: 'err' }, h('div', { class: 'when' }, new Date(e.at).toLocaleString()), h('div', { class: 'mono' }, e.message), e.source ? h('div', { class: 'src' }, e.source) : null)), h('div', { class: 'err' }, h('button', { class: 'btn small', onclick: async () => { await call('extensions.clear-errors', { id: d.id }); render(); } }, 'Clear errors')))
    : h('ul', { class: 'plist none' }, h('li', {}, 'No errors.'));
  main.append(
    back,
    head,
    buttons,
    h('div', { class: 'status muted', id: 'ext-status' }, status),
    ...notices.map((n) => h('div', { style: { marginTop: '10px' } }, n)),
    d.description ? h('p', {}, d.description) : null,
    h('h2', {}, 'Permissions'),
    h('div', { class: 'card' }, perms),
    h('h2', {}, 'Site access'),
    h('div', { class: 'card' }, d.hosts.length ? h('ul', { class: 'plist mono' }, ...d.hosts.slice(0, 100).map((x) => h('li', {}, x))) : h('ul', { class: 'plist none' }, h('li', {}, 'No access to websites.'))),
    optional.length ? h('h2', {}, 'Optional permissions') : null,
    optional.length ? h('div', { class: 'card' }, h('ul', { class: 'plist' }, ...optional.map((o) => h('li', {}, h('span', { class: 'mono' }, o.name), o.granted ? ' — allowed' : ' — not allowed')))) : null,
    h('h2', {}, 'Not available in Ludworks Browser'),
    h('div', { class: 'card' }, unsupported),
    d.commands.length ? h('h2', {}, 'Keyboard shortcuts') : null,
    d.commands.length ? h('div', { class: 'card' }, kv(d.commands.map((c) => [c.description || c.name, c.shortcut || 'Not set']))) : null,
    h('h2', {}, 'Errors'),
    h('div', { class: 'card' }, errors),
    h('h2', {}, 'About'),
    h('div', { class: 'card' }, kv([['ID', h('span', { class: 'mono' }, d.id)], ['Source', SOURCES[d.source] || d.source], d.path ? ['Folder', h('span', { class: 'mono' }, d.path)] : null, ['Size on disk', fmtBytes(d.size)], ['Installed', new Date(d.installedAt).toLocaleString()], d.updatedAt ? ['Updated', new Date(d.updatedAt).toLocaleString()] : null, d.source === 'webstore' ? ['Last update check', ago(d.lastUpdateCheck)] : null])),
  );
}

// --------------------------------------------------------------------------------------- main
async function render() {
  try {
    if (!list || !detailsId) list = await call('extensions.list');
  } catch (e) {
    clear(main);
    main.append(h('h1', {}, 'Extensions'), h('div', { class: 'notice warn' }, `Extensions are unavailable: ${e.message}`));
    return;
  }
  applyTheme(list.theme);
  if (detailsId && list.items.some((x) => x.id === detailsId)) return renderDetails();
  detailsId = null;
  clear(main);
  renderList();
}

if (/^#[a-p]{32}$/.test(location.hash)) detailsId = location.hash.slice(1);
render();
let refreshTimer = null;
window.lwPage.on('page-event', (ev) => {
  if (!ev) return;
  if (ev.type === 'extensions-focus' && /^[a-p]{32}$/.test(ev.id || '')) return openDetails(ev.id);
  if (ev.type !== 'extensions') return;
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(async () => {
    list = await call('extensions.list').catch(() => list);
    if (document.activeElement && document.activeElement.tagName === 'INPUT' && document.activeElement.type !== 'checkbox') return drawGrid();
    render();
  }, 150);
});
