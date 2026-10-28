// Content blocker: element picker ("zapper"). Started from the shield popup; the user points at an
// element, adjusts the proposed selector and confirms — the browser then saves `host##selector` in
// "My filters". The UI lives in a closed shadow root over the page; page clicks are swallowed while
// picking. The page can at worst create a hide rule for its own site, and only while a pick is on.

let active = null;

/** A short CSS selector for `el` that does not depend on volatile-looking ids/classes. */
export function selectorFor(el, depth = 0) {
  const esc = (s) => CSS.escape(s);
  const tag = el.localName;
  const stable = (s) => /^[A-Za-z_-][\w-]{0,60}$/.test(s) && !/\d{4,}/.test(s) && !/^(?:active|hover|focus|open|show|visible|selected)$/.test(s);
  if (el.id && stable(el.id)) {
    const sel = `#${esc(el.id)}`;
    try {
      if (document.querySelectorAll(sel).length === 1) return sel;
    } catch {
      /* fall through */
    }
  }
  const classes = [...el.classList].filter(stable).slice(0, 4);
  let sel = tag + classes.map((c) => `.${esc(c)}`).join('');
  if (!classes.length && (tag === 'iframe' || tag === 'img' || tag === 'embed') && el.getAttribute('src')) {
    try {
      const u = new URL(el.getAttribute('src'), location.href);
      const v = `${u.origin}${u.pathname}`.slice(0, 100).replace(/["\\]/g, '');
      if (/^https?:/.test(v)) return `${tag}[src^="${v}"]`;
    } catch {
      /* no src hint */
    }
  }
  let count = 0;
  try {
    count = document.querySelectorAll(sel).length;
  } catch {
    count = 2;
  }
  if ((count > 1 || !classes.length) && depth < 4) {
    const parent = el.parentElement;
    if (parent && parent !== document.documentElement) {
      const same = [...parent.children].filter((c) => c.localName === tag);
      const nth = same.length > 1 && (!classes.length || count > 1) ? `:nth-of-type(${same.indexOf(el) + 1})` : '';
      sel = `${parent === document.body ? 'body' : selectorFor(parent, depth + 1)} > ${sel}${nth}`;
    }
  }
  return sel;
}

/**
 * @param {{create: (selector: string) => Promise<boolean>}} opts
 */
export function startPicker({ create }) {
  if (active || !document.documentElement) return;
  const hostEl = document.createElement('div');
  const imp = (p, v) => hostEl.style.setProperty(p, v, 'important');
  imp('position', 'fixed');
  imp('inset', '0');
  imp('z-index', '2147483647');
  imp('pointer-events', 'none');
  imp('display', 'block');
  imp('margin', '0');
  imp('padding', '0');
  imp('border', '0');
  imp('background', 'transparent');
  const root = hostEl.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = `
    :host { all: initial; }
    * { box-sizing: border-box; font: 13px/1.4 system-ui, "Segoe UI", sans-serif; }
    .hl { position: fixed; border: 2px solid #5352d1; background: rgba(83, 82, 209, 0.18); border-radius: 3px; pointer-events: none; display: none; }
    .hl.alt { border-style: dashed; background: rgba(83, 82, 209, 0.08); }
    .panel { position: fixed; right: 16px; bottom: 16px; width: 380px; background: #fff; color: #1d2030; border: 1px solid #dcdfe9; border-radius: 12px; box-shadow: 0 8px 28px rgba(16, 18, 40, 0.25); padding: 12px 14px; pointer-events: auto; }
    .t { font-weight: 650; font-size: 14px; margin-bottom: 4px; }
    .s { color: #5d6275; font-size: 12px; margin-bottom: 8px; }
    input { width: 100%; height: 32px; border: 1px solid #dcdfe9; border-radius: 8px; padding: 0 8px; font-family: ui-monospace, Consolas, monospace; font-size: 12px; color: #1d2030; background: #fff; }
    input:focus { outline: none; border-color: #5352d1; box-shadow: 0 0 0 3px rgba(83, 82, 209, 0.15); }
    .row { display: flex; gap: 8px; margin-top: 10px; align-items: center; }
    .grow { flex: 1; color: #5d6275; font-size: 12px; }
    button { height: 30px; padding: 0 12px; border-radius: 8px; border: 1px solid #dcdfe9; background: #fff; color: #1d2030; font-weight: 560; cursor: default; }
    button:hover { background: #eef0f6; }
    button.primary { background: #5352d1; border-color: #5352d1; color: #fff; }
    button:disabled { opacity: 0.5; }
    @media (prefers-color-scheme: dark) {
      .panel { background: #22232b; color: #e6e7ef; border-color: #353642; }
      .s, .grow { color: #a6a9b8; }
      input, button { background: #22232b; color: #e6e7ef; border-color: #353642; }
      button:hover { background: #2b2c36; }
      button.primary { background: #9a9af7; border-color: #9a9af7; color: #12122a; }
    }`;
  const hl = document.createElement('div');
  hl.className = 'hl';
  const extra = [];
  const panel = document.createElement('div');
  panel.className = 'panel';
  const title = document.createElement('div');
  title.className = 't';
  title.textContent = 'Hide an element';
  const hint = document.createElement('div');
  hint.className = 's';
  hint.textContent = 'Click the element to hide. Esc cancels.';
  const input = document.createElement('input');
  input.spellcheck = false;
  input.placeholder = 'CSS selector';
  const count = document.createElement('span');
  count.className = 'grow';
  const parentBtn = document.createElement('button');
  parentBtn.textContent = 'Wider';
  parentBtn.title = 'Select the surrounding element';
  const cancelBtn = document.createElement('button');
  cancelBtn.textContent = 'Cancel';
  const hideBtn = document.createElement('button');
  hideBtn.className = 'primary';
  hideBtn.textContent = 'Hide';
  hideBtn.disabled = true;
  const row = document.createElement('div');
  row.className = 'row';
  row.append(count, parentBtn, cancelBtn, hideBtn);
  panel.append(title, hint, input, row);
  root.append(style, hl, panel);
  (document.body || document.documentElement).appendChild(hostEl);

  let target = null;
  let frozen = false;
  const box = (el, r) => {
    const b = r.getBoundingClientRect();
    el.style.left = `${b.left}px`;
    el.style.top = `${b.top}px`;
    el.style.width = `${b.width}px`;
    el.style.height = `${b.height}px`;
    el.style.display = 'block';
  };
  const showMatches = () => {
    for (const x of extra.splice(0)) x.remove();
    let list = [];
    try {
      list = input.value.trim() ? [...document.querySelectorAll(input.value.trim())] : [];
    } catch {
      list = null;
    }
    if (list === null) {
      count.textContent = 'Invalid selector';
      hideBtn.disabled = true;
      return;
    }
    count.textContent = `${list.length} element${list.length === 1 ? '' : 's'}`;
    hideBtn.disabled = !list.length;
    for (const el of list.slice(0, 50)) {
      if (el === target) continue;
      const d = document.createElement('div');
      d.className = 'hl alt';
      root.append(d);
      box(d, el);
      extra.push(d);
    }
  };
  const pick = (el) => {
    target = el;
    frozen = true;
    box(hl, el);
    input.value = selectorFor(el);
    hint.textContent = 'Adjust the selector if needed, then press Hide.';
    showMatches();
  };
  const isOurs = (e) => e.composedPath().includes(hostEl);
  const elementAt = (x, y) => {
    const el = document.elementFromPoint(x, y);
    return el && el !== hostEl && el !== document.documentElement && el !== document.body ? el : null;
  };
  const onMove = (e) => {
    if (frozen || isOurs(e)) return;
    const el = elementAt(e.clientX, e.clientY);
    if (el) box(hl, el);
  };
  const swallow = (e) => {
    if (isOurs(e)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
  };
  const onClick = (e) => {
    if (isOurs(e)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const el = elementAt(e.clientX, e.clientY);
    if (el) pick(el);
  };
  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopImmediatePropagation();
      stop();
    }
  };
  const onScroll = () => {
    if (target && frozen) {
      box(hl, target);
      showMatches();
    }
  };
  const listeners = [
    ['mousemove', onMove],
    ['click', onClick],
    ['mousedown', swallow],
    ['mouseup', swallow],
    ['pointerdown', swallow],
    ['pointerup', swallow],
    ['auxclick', swallow],
    ['contextmenu', swallow],
    ['keydown', onKey],
    ['scroll', onScroll],
  ];
  for (const [t, f] of listeners) window.addEventListener(t, f, true);
  function stop() {
    for (const [t, f] of listeners) window.removeEventListener(t, f, true);
    hostEl.remove();
    active = null;
  }
  input.addEventListener('input', showMatches);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !hideBtn.disabled) hideBtn.click();
  });
  parentBtn.addEventListener('click', () => {
    const p = target && target.parentElement;
    if (p && p !== document.body && p !== document.documentElement) pick(p);
  });
  cancelBtn.addEventListener('click', stop);
  hideBtn.addEventListener('click', async () => {
    const sel = input.value.trim();
    if (!sel) return;
    hideBtn.disabled = true;
    const ok = await create(sel).catch(() => false);
    if (ok) stop();
    else {
      count.textContent = 'Could not save this filter';
      hideBtn.disabled = false;
    }
  });
  active = { stop };
}
