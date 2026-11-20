// Window-wide effects view (WindowCtl.flyDownload): shown only while an effect plays.
//   fly  a download card pops up over the page, then flies on a curve into the toolbar's downloads button
import { icon, h } from './icons.js';

export const FLY_MS = 950; // keep in sync with src/main/window.js FLY_MS

/** Points along a quadratic curve from `a` to `b` that bows upwards. */
function curve(a, b, n) {
  const c = { x: a.x + (b.x - a.x) * 0.35, y: Math.min(a.y, b.y) - 90 };
  return Array.from({ length: n + 1 }, (_, i) => {
    const t = i / n;
    return { x: (1 - t) * (1 - t) * a.x + 2 * (1 - t) * t * c.x + t * t * b.x, y: (1 - t) * (1 - t) * a.y + 2 * (1 - t) * t * c.y + t * t * b.y, t };
  });
}

function fly({ from, to, name, theme }) {
  document.documentElement.dataset.theme = theme || 'light';
  document.body.replaceChildren();
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const card = h('div', { class: 'fly' }, h('span', { class: 'ic' }, icon('download', { size: 18 })), h('span', { class: 'name' }, name || 'Download'));
  document.body.append(card);
  const w = card.offsetWidth;
  const hgt = card.offsetHeight;
  const at = (p, s, o = 1) => ({ transform: `translate(${p.x - w / 2}px, ${p.y - hgt / 2}px) scale(${s})`, opacity: o });
  if (reduce) {
    card.animate([at(to, 0.4, 1), at(to, 0.3, 0)], { duration: 300, fill: 'forwards' });
    return;
  }
  const pop = 0.3; // share of the time the card sits over the page before it flies
  const path = curve(from, to, 14);
  const frames = [
    { ...at(from, 0.6, 0), offset: 0 },
    { ...at(from, 1.08, 1), offset: pop * 0.45 },
    { ...at(from, 1, 1), offset: pop },
    ...path.slice(1).map((p) => ({ ...at(p, 1 - 0.8 * p.t, 1 - 0.25 * p.t), offset: pop + (1 - pop) * p.t })),
  ];
  frames[frames.length - 1].opacity = 0.2;
  card.animate(frames, { duration: FLY_MS, easing: 'linear', fill: 'forwards' });
  // a short glowing trail behind it
  for (let k = 1; k <= 4; k++) {
    const dot = h('div', { class: 'trail' });
    dot.style.opacity = '0';
    document.body.append(dot);
    const lag = 0.035 * k;
    dot.animate(
      [
        { transform: `translate(${from.x}px, ${from.y}px)`, opacity: 0, offset: 0 },
        { transform: `translate(${from.x}px, ${from.y}px)`, opacity: 0, offset: Math.min(0.99, pop + lag) },
        ...path.slice(1).map((p) => ({ transform: `translate(${p.x}px, ${p.y}px) scale(${1 - 0.15 * k})`, opacity: (0.55 - 0.1 * k) * (1 - p.t * 0.6), offset: Math.min(1, pop + lag + (1 - pop - lag) * p.t) })),
      ],
      { duration: FLY_MS, easing: 'linear', fill: 'forwards' },
    );
  }
}

window.lw.on('fly', fly);
