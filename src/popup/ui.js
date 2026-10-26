// Small DOM toolkit for the popup. Never uses innerHTML: every node is created with createElement /
// createElementNS and text is always assigned through textContent.

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * Create an element. Props: class, text, value, checked, disabled, dataset, on<Event> handlers,
 * any other key becomes an attribute (true -> empty attribute, false/null/undefined -> omitted).
 * @param {string} tag
 * @param {Record<string, any>|null} [props]
 * @param {...any} children
 * @returns {HTMLElement}
 */
export function h(tag, props = null, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = Array.isArray(v) ? v.filter(Boolean).join(' ') : v;
    else if (k === 'text') el.textContent = String(v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked') el.checked = !!v;
    else if (k === 'disabled') el.disabled = true;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'style') throw new Error('Use element.style or classes, not style attributes (CSP)');
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  append(el, children);
  return el;
}

/** Append children (nodes, strings, numbers, nested arrays; null/false skipped). */
export function append(el, children) {
  for (const c of [children].flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

/** Remove all children. */
export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

// 24x24 stroke icons (original simple geometry).
const ICONS = {
  lock: [['rect', { x: 5, y: 11, width: 14, height: 10, rx: 2 }], ['path', { d: 'M8 11V7a4 4 0 0 1 8 0v4' }]],
  unlock: [['rect', { x: 5, y: 11, width: 14, height: 10, rx: 2 }], ['path', { d: 'M8 11V7a4 4 0 0 1 7.6-1.7' }]],
  settings: [
    ['path', { d: 'M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1' }],
    ['circle', { cx: 15, cy: 6, r: 2 }],
    ['circle', { cx: 9, cy: 12, r: 2 }],
    ['circle', { cx: 17, cy: 18, r: 2 }],
  ],
  search: [['circle', { cx: 11, cy: 11, r: 7 }], ['path', { d: 'M20 20l-4-4' }]],
  copy: [['rect', { x: 9, y: 9, width: 11, height: 11, rx: 2 }], ['path', { d: 'M5 15V6a2 2 0 0 1 2-2h9' }]],
  eye: [['path', { d: 'M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z' }], ['circle', { cx: 12, cy: 12, r: 3 }]],
  eyeOff: [
    ['path', { d: 'M2 12s3.6-7 10-7c2 0 3.8.7 5.2 1.6M22 12s-3.6 7-10 7c-2 0-3.8-.7-5.2-1.6' }],
    ['path', { d: 'M3 3l18 18' }],
  ],
  star: [['path', { d: 'M12 3l2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.3 6.4 20.2l1.1-6.2L3 9.6l6.2-.9z' }]],
  plus: [['path', { d: 'M12 5v14M5 12h14' }]],
  back: [['path', { d: 'M19 12H5M11 18l-6-6 6-6' }]],
  refresh: [['path', { d: 'M20 12a8 8 0 1 1-2.3-5.7L20 8.6' }], ['path', { d: 'M20 3v5.6h-5.6' }]],
  external: [['path', { d: 'M14 4h6v6M10 14L20 4' }], ['path', { d: 'M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5' }]],
  key: [['circle', { cx: 8, cy: 15, r: 4 }], ['path', { d: 'M11 12l9-9M16 7l3 3M14 9l2 2' }]],
  globe: [['circle', { cx: 12, cy: 12, r: 9 }], ['path', { d: 'M3 12h18M12 3c3 3.2 3 14.8 0 18M12 3c-3 3.2-3 14.8 0 18' }]],
  note: [['rect', { x: 5, y: 3, width: 14, height: 18, rx: 2 }], ['path', { d: 'M9 8h6M9 12h6M9 16h4' }]],
  card: [['rect', { x: 3, y: 5, width: 18, height: 14, rx: 2 }], ['path', { d: 'M3 10h18M7 15h4' }]],
  user: [['circle', { cx: 12, cy: 8, r: 4 }], ['path', { d: 'M4 21a8 8 0 0 1 16 0' }]],
  trash: [['path', { d: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13' }]],
  edit: [['path', { d: 'M4 20h4L19 9l-4-4L4 16z' }], ['path', { d: 'M13 7l4 4' }]],
  check: [['path', { d: 'M20 6L9 17l-5-5' }]],
  close: [['path', { d: 'M6 6l12 12M18 6L6 18' }]],
  bolt: [['path', { d: 'M13 2L4 14h7l-1 8 9-12h-7z' }]],
  dice: [
    ['rect', { x: 4, y: 4, width: 16, height: 16, rx: 3 }],
    ['circle', { cx: 9, cy: 9, r: 1.2 }],
    ['circle', { cx: 15, cy: 15, r: 1.2 }],
    ['circle', { cx: 15, cy: 9, r: 1.2 }],
    ['circle', { cx: 9, cy: 15, r: 1.2 }],
  ],
  shield: [['path', { d: 'M12 3l8 3v6c0 4.6-3.4 8.4-8 9.5C7.4 20.4 4 16.6 4 12V6z' }]],
  logout: [['path', { d: 'M10 20H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h4' }], ['path', { d: 'M15 16l4-4-4-4M19 12H9' }]],
  folder: [['path', { d: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z' }]],
  alert: [['path', { d: 'M12 3l10 18H2z' }], ['path', { d: 'M12 10v4M12 17.5v.5' }]],
  info: [['circle', { cx: 12, cy: 12, r: 9 }], ['path', { d: 'M12 11v6M12 7.5v.5' }]],
  server: [['rect', { x: 3, y: 4, width: 18, height: 7, rx: 2 }], ['rect', { x: 3, y: 13, width: 18, height: 7, rx: 2 }], ['path', { d: 'M7 7.5h.01M7 16.5h.01' }]],
};

/**
 * Inline SVG icon.
 * @param {keyof typeof ICONS} name
 * @param {{size?: number, label?: string, filled?: boolean}} [opts]
 * @returns {SVGSVGElement}
 */
export function icon(name, { size = 18, label = '', filled = false } = {}) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', filled ? 'currentColor' : 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('class', 'icon');
  if (label) {
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', label);
  } else {
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
  }
  for (const [tag, attrs] of ICONS[name] || []) {
    const child = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) child.setAttribute(k, String(v));
    svg.appendChild(child);
  }
  return svg;
}

/** Brand mark: filled shield with a key hole. */
export function logo(size = 28) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', 'logo');
  const shield = document.createElementNS(SVG_NS, 'path');
  shield.setAttribute('d', 'M12 1.5l9 3.4v6.6c0 5.3-3.8 9.6-9 11-5.2-1.4-9-5.7-9-11V4.9z');
  shield.setAttribute('class', 'logo-shield');
  const ring = document.createElementNS(SVG_NS, 'circle');
  ring.setAttribute('cx', '12');
  ring.setAttribute('cy', '9.5');
  ring.setAttribute('r', '3.2');
  ring.setAttribute('class', 'logo-key');
  const shaft = document.createElementNS(SVG_NS, 'path');
  shaft.setAttribute('d', 'M12 12.7v5.3M12 15.3h2.2M12 17.4h1.6');
  shaft.setAttribute('class', 'logo-key');
  svg.append(shield, ring, shaft);
  return svg;
}

/**
 * Icon-only button with an accessible name and tooltip.
 * @param {string} iconName
 * @param {string} label
 * @param {(e: Event) => void} onClick
 * @param {{pressed?: boolean, filled?: boolean, cls?: string, disabled?: boolean}} [opts]
 */
export function iconButton(iconName, label, onClick, { pressed, filled = false, cls = '', disabled = false } = {}) {
  const b = h('button', {
    type: 'button',
    class: ['icon-btn', cls],
    title: label,
    'aria-label': label,
    'aria-pressed': pressed === undefined ? null : String(!!pressed),
    disabled,
    onClick,
  });
  b.append(icon(iconName, { filled }));
  return b;
}

/**
 * Text button.
 * @param {string} label
 * @param {{variant?: 'primary'|'secondary'|'ghost'|'danger', icon?: string, onClick?: Function, type?: string, block?: boolean, disabled?: boolean}} [opts]
 */
export function button(label, { variant = 'secondary', icon: iconName, onClick, type = 'button', block = false, disabled = false } = {}) {
  const b = h('button', { type, class: ['btn', `btn-${variant}`, block && 'btn-block'], disabled, onClick });
  if (iconName) b.append(icon(iconName, { size: 16 }));
  b.append(h('span', { text: label }));
  return b;
}

/** Busy state for a button while an async action runs. */
export async function withBusy(btn, fn) {
  btn.disabled = true;
  btn.classList.add('busy');
  btn.setAttribute('aria-busy', 'true');
  try {
    return await fn();
  } finally {
    btn.disabled = false;
    btn.classList.remove('busy');
    btn.removeAttribute('aria-busy');
  }
}

let toastTimer = null;
/**
 * Show a transient status message (announced by screen readers).
 * @param {string} message
 * @param {'info'|'success'|'error'} [kind]
 */
export function toast(message, kind = 'info') {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = message;
  el.className = `toast show toast-${kind}`;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.className = 'toast';
  }, kind === 'error' ? 4500 : 2600);
}

/**
 * Modal confirmation using <dialog>. Resolves true when confirmed.
 * @param {{title: string, message: string, confirmLabel?: string, danger?: boolean}} p
 * @returns {Promise<boolean>}
 */
export function confirmDialog({ title, message, confirmLabel = 'Confirm', danger = false, cancelLabel = 'Cancel' }) {
  return new Promise((resolve) => {
    const dlg = h('dialog', { class: 'dialog', 'aria-labelledby': 'dlg-title' });
    const cancel = cancelLabel ? button(cancelLabel, { variant: 'secondary', onClick: () => dlg.close('cancel') }) : null;
    const ok = button(confirmLabel, { variant: danger ? 'danger' : 'primary', onClick: () => dlg.close('ok') });
    dlg.append(
      h('h2', { id: 'dlg-title', class: 'dialog-title', text: title }),
      h('p', { class: 'dialog-text', text: message }),
      h('div', { class: 'dialog-actions' }, cancel, ok),
    );
    dlg.addEventListener('close', () => {
      const v = dlg.returnValue === 'ok';
      dlg.remove();
      resolve(v);
    });
    document.body.append(dlg);
    dlg.showModal();
    (cancel || ok).focus();
  });
}

/** Modal notice with a single button. */
export function alertDialog({ title, message, label = 'OK' }) {
  return confirmDialog({ title, message, confirmLabel: label, cancelLabel: null });
}

const AVATAR_COLORS = 8;
function hash(s) {
  let x = 2166136261;
  for (let i = 0; i < s.length; i++) x = Math.imul(x ^ s.charCodeAt(i), 16777619);
  return x >>> 0;
}

/**
 * Letter avatar (no remote favicons — privacy).
 * @param {string} name
 * @param {string} type  item type
 */
export function avatar(name, type = 'login') {
  const el = h('div', { class: ['avatar', `av-${hash(name || '?') % AVATAR_COLORS}`], 'aria-hidden': 'true' });
  if (type === 'login') {
    const m = String(name || '').match(/[\p{L}\p{N}]/u);
    el.textContent = m ? m[0].toUpperCase() : '?';
  } else {
    el.append(icon(type === 'note' ? 'note' : type === 'card' ? 'card' : 'user', { size: 18 }));
  }
  return el;
}

/**
 * Locale date(-time) string for an RFC 3339 timestamp; '' when missing or unparseable.
 * @param {string|null|undefined} value
 * @param {{dateOnly?: boolean}} [opts]
 */
export function formatDate(value, { dateOnly = false } = {}) {
  if (typeof value !== 'string' || !value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return dateOnly ? d.toLocaleDateString() : d.toLocaleString();
}

/** "3 min ago" style relative time. */
export function relativeTime(ms) {
  if (!ms) return 'never';
  const d = Date.now() - ms;
  if (d < 45000) return 'just now';
  if (d < 3600000) return `${Math.round(d / 60000)} min ago`;
  if (d < 86400000) return `${Math.round(d / 3600000)} h ago`;
  return new Date(ms).toLocaleString();
}

/**
 * Labelled form field wrapper.
 * @param {string} label
 * @param {HTMLElement} control  must have an id
 * @param {string} [hint]
 */
export function field(label, control, hint = '') {
  const hintId = hint ? `${control.id}-hint` : null;
  if (hintId) control.setAttribute('aria-describedby', hintId);
  return h(
    'div',
    { class: 'field' },
    h('label', { for: control.id, class: 'field-label', text: label }),
    control,
    hint ? h('div', { id: hintId, class: 'field-hint', text: hint }) : null,
  );
}

let uid = 0;
/** Unique DOM id. */
export function nextId(prefix = 'f') {
  uid += 1;
  return `${prefix}-${uid}`;
}

/**
 * Accessible toggle switch (a checkbox styled as a switch).
 * @param {string} label
 * @param {boolean} checked
 * @param {(checked: boolean, input: HTMLInputElement) => void} onChange
 * @param {string} [description]
 */
export function toggle(label, checked, onChange, description = '') {
  const id = nextId('tg');
  const input = h('input', { type: 'checkbox', id, class: 'switch-input', role: 'switch', checked });
  input.addEventListener('change', () => onChange(input.checked, input));
  return h(
    'div',
    { class: 'switch-row' },
    h(
      'label',
      { for: id, class: 'switch-label' },
      h('span', { class: 'switch-text', text: label }),
      description ? h('span', { class: 'switch-desc', text: description }) : null,
    ),
    input,
  );
}

/**
 * Segmented control (radio group).
 * @param {string} name
 * @param {Array<{value: string, label: string}>} options
 * @param {string} value
 * @param {(v: string) => void} onChange
 * @param {string} ariaLabel
 */
export function segmented(name, options, value, onChange, ariaLabel) {
  const group = h('div', { class: 'segmented', role: 'radiogroup', 'aria-label': ariaLabel });
  for (const o of options) {
    const id = nextId('seg');
    const input = h('input', { type: 'radio', name, id, value: o.value, checked: o.value === value, class: 'seg-input' });
    input.addEventListener('change', () => input.checked && onChange(o.value));
    group.append(input, h('label', { for: id, class: 'seg-label', text: o.label }));
  }
  return group;
}
