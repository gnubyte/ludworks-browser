// Inline SVG icons built with DOM APIs (no innerHTML). 24×24 viewBox, stroke icons.

const NS = 'http://www.w3.org/2000/svg';

const PATHS = {
  bot: ['M6.5 9h11a2 2 0 0 1 2 2v6.5a2 2 0 0 1-2 2h-11a2 2 0 0 1-2-2V11a2 2 0 0 1 2-2z', 'M12 9V5.5', 'M12 4.5h.01', 'M9.5 13.5v1', 'M14.5 13.5v1', 'M2.5 13v2.5', 'M21.5 13v2.5'],
  back: ['M15 18l-6-6 6-6'],
  send: ['M21.5 2.5L10.8 13.2', 'M21.5 2.5l-6.8 19-3.9-8.3-8.3-3.9z'],
  forward: ['M9 18l6-6-6-6'],
  reload: ['M20 11a8 8 0 1 0-2.3 5.7', 'M20 4v7h-7'],
  stop: ['M6 6l12 12', 'M18 6L6 18'],
  record: ['M12 6.5a5.5 5.5 0 1 0 0 11a5.5 5.5 0 1 0 0-11z', 'M12 10a2 2 0 1 0 0 4a2 2 0 1 0 0-4z'],
  close: ['M7 7l10 10', 'M17 7L7 17'],
  plus: ['M12 5v14', 'M5 12h14'],
  home: ['M4 11l8-7 8 7', 'M6 10v10h12V10'],
  star: ['M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z'],
  menu: ['M12 5.5h.01', 'M12 12h.01', 'M12 18.5h.01'],
  download: ['M12 4v11', 'M7 10.5l5 5 5-5', 'M5 20h14'],
  lock: ['M7 11V8a5 5 0 0 1 10 0v3', 'M5.5 11h13v9h-13z'],
  info: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M12 11v5', 'M12 7.5h.01'],
  warn: ['M12 3.5l9.5 16.5h-19z', 'M12 10v4.5', 'M12 17.5h.01'],
  key: ['M14.5 4a5.5 5.5 0 1 1-4.6 8.5L4 18.5V21h3v-2h2v-2h2l1.4-1.4A5.5 5.5 0 0 1 14.5 4z', 'M16 8.5h.01'],
  user: ['M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z', 'M4.5 20a7.5 7.5 0 0 1 15 0'],
  globe: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M3 12h18', 'M12 3a14 14 0 0 1 0 18', 'M12 3a14 14 0 0 0 0 18'],
  folder: ['M3.5 6.5h6l2 2h9v10h-17z'],
  search: ['M10.5 17a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13z', 'M15.5 15.5L20 20'],
  history: ['M3.5 12a8.5 8.5 0 1 0 2.5-6', 'M3.5 4.5V9H8', 'M12 7.5V12l3 2'],
  tab: ['M4 6h16v12H4z', 'M4 9.5h16'],
  up: ['M6 15l6-6 6 6'],
  down: ['M6 9l6 6 6-6'],
  speaker: ['M4 9.5h4l5-4v13l-5-4H4z', 'M16.5 8.5a5 5 0 0 1 0 7', 'M19 6a8.5 8.5 0 0 1 0 12'],
  muted: ['M4 9.5h4l5-4v13l-5-4H4z', 'M16.5 9.5l5 5', 'M21.5 9.5l-5 5'],
  puzzle: ['M9 4h6v3a2 2 0 1 0 4 0V4h1v16H4V4h1v3a2 2 0 1 0 4 0z'],
  check: ['M5 12.5l4.5 4.5L19 7.5'],
  sync: ['M20 7a8.5 8.5 0 0 0-15.3 2', 'M4 17a8.5 8.5 0 0 0 15.3-2', 'M20 3v4h-4', 'M4 21v-4h4'],
  shield: ['M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6z'],
  eye: ['M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z', 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z'],
  copy: ['M8 8h11v12H8z', 'M5 16V4h11'],
  passkey: ['M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z', 'M3 20a6 6 0 0 1 9.5-4.9', 'M17.5 15a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z', 'M17.5 15v6', 'M17.5 18.5h2'],
  minimize: ['M6 12h12'],
  maximize: ['M6.5 6.5h11v11h-11z'],
  restore: ['M8.5 8.5h9v9h-9z', 'M6.5 15.5v-9h9'],
  external: ['M14 4h6v6', 'M20 4l-9 9', 'M18 14v6H4V6h6'],
  chevrons: ['M6 7l5 5-5 5', 'M13 7l5 5-5 5'],
  cookie: ['M12 3a9 9 0 1 0 9 9 3 3 0 0 1-3.5-3A3 3 0 0 1 14 5.5 3 3 0 0 1 12 3z', 'M8.5 9.5h.01', 'M7.5 14h.01', 'M12 12.5h.01', 'M15.5 16h.01', 'M11 17h.01'],
  pip: ['M3.5 5.5h17v13h-17z', 'M12 11.5h6.5v5H12z'],
  eraser: ['M8.5 20H20', 'M3.6 14.3l9.2-9.2a2 2 0 0 1 2.8 0l3.3 3.3a2 2 0 0 1 0 2.8L11.2 19.9a2 2 0 0 1-1.4.6H8.2a2 2 0 0 1-1.4-.6l-3.2-3.2a2 2 0 0 1 0-2.4z', 'M8 9.9l6.1 6.1'],
  images: ['M3.5 8h13v11.5h-13z', 'M7 4.5h13.5V16', 'M3.5 17l3.5-3.5 2.5 2.5 3-3 4 4', 'M7.5 11h.01'],
  film: ['M3.5 6h17v12h-17z', 'M10.5 9.5v5l4-2.5z'],
  layers: ['M12 3.5l8.5 4.5-8.5 4.5L3.5 8z', 'M3.5 12l8.5 4.5 8.5-4.5', 'M3.5 16l8.5 4.5 8.5-4.5'],
};

/**
 * @param {keyof typeof PATHS} name
 * @param {{size?: number, cls?: string, fill?: boolean}} [o]
 */
export function icon(name, { size = 16, cls = '', fill = false } = {}) {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', `icon ${cls}`.trim());
  for (const d of PATHS[name] || []) {
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('d', d);
    p.setAttribute('fill', fill ? 'currentColor' : 'none');
    p.setAttribute('stroke', 'currentColor');
    p.setAttribute('stroke-width', '1.8');
    p.setAttribute('stroke-linecap', 'round');
    p.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(p);
  }
  return svg;
}

/**
 * Tiny element builder: h('div', {class: 'x', onclick: fn, dataset: {id: 1}}, child, 'text').
 */
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k === 'style') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'text') el.textContent = v;
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

/** A favicon image, or a letter avatar when there is none. */
export function faviconEl(src, title, size = 16) {
  if (src && /^data:image\//.test(src)) {
    const img = h('img', { class: 'favicon', width: size, height: size, alt: '', draggable: 'false' });
    img.src = src;
    return img;
  }
  const letter = (String(title || '').replace(/^(https?:\/\/)?(www\.)?/, '').trim()[0] || '•').toUpperCase();
  return h('span', { class: 'favicon letter', style: { width: `${size}px`, height: `${size}px`, fontSize: `${Math.round(size * 0.62)}px` } }, letter);
}
