// Small DOM helpers shared by the internal pages (no innerHTML anywhere).

export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k === 'style') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'text') el.textContent = v;
    else if (k === 'value') el.value = v;
    else if (k === 'checked') el.checked = !!v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
  return el;
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

export function applyTheme(theme) {
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
}

export function fmtBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n >= 10 || i === 0 ? Math.round(n) : n.toFixed(1)} ${u[i]}`;
}

export function fmtTime(ms) {
  const d = new Date(ms);
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

export function fmtDay(ms) {
  const d = new Date(ms);
  const today = new Date();
  const y = new Date(today);
  y.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === y.toDateString()) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
}

export function letterIcon(text, size = 18) {
  let host = String(text || '');
  try {
    host = new URL(host).hostname.replace(/^www\./, '');
  } catch {
    /* plain text */
  }
  return h('span', { class: 'favicon letter', style: { width: `${size}px`, height: `${size}px`, fontSize: `${Math.round(size * 0.6)}px` } }, (host.trim()[0] || '•').toUpperCase());
}

/** Shared left navigation for the internal "app" pages. */
export function sideNav(active) {
  const links = [
    ['settings', 'Settings'],
    ['passwords', 'Passwords & passkeys'],
    ['bookmarks', 'Bookmarks'],
    ['history', 'History'],
    ['downloads', 'Downloads'],
    ['extensions', 'Extensions'],
    ['sync', 'Ludworks sync'],
    ['about', 'About'],
  ];
  return h(
    'aside',
    { class: 'side' },
    h('div', { class: 'brand' }, h('img', { src: '/assets/logo.svg', alt: '' }), 'Ludworks Browser'),
    h('nav', { class: 'nav' }, ...links.map(([id, label]) => h('a', { href: `ludworks://${id}/`, class: id === active ? 'active' : '' }, label))),
  );
}

export function toggle(checked, onchange, label) {
  const input = h('input', { type: 'checkbox', checked, 'aria-label': label || '' });
  input.addEventListener('change', () => onchange(input.checked));
  return h('label', { class: 'switch' }, input, h('span', {}));
}

export function confirmDialog(message) {
  // window.confirm is a native dialog in Electron: modal, cannot be drawn over by pages.
  return window.confirm(message);
}
