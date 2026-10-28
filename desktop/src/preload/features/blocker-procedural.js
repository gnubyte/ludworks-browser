// Content blocker: procedural cosmetic filters (`example.com##.post:has-text(Sponsored)`), evaluated in
// the isolated world of the tab preload. Selectors are split into a plain CSS prefix and a chain of
// operators (:has-text, :upward, :xpath, :matches-css, :min-text-length, :matches-attr, :matches-path,
// :matches-media, :watch-attr, :has/:not with procedural arguments, CSS combinator steps) ending in an
// action: hide (default), :remove(), :style(...), :remove-attr(...), :remove-class(...).
// Our own implementation of the documented operator semantics.

const OPS = new Set(['has-text', 'has', 'not', 'upward', 'xpath', 'matches-css', 'matches-css-before', 'matches-css-after', 'min-text-length', 'matches-attr', 'matches-path', 'matches-media', 'watch-attr', 'others', 'remove', 'style', 'remove-attr', 'remove-class']);
const ACTIONS = new Set(['remove', 'style', 'remove-attr', 'remove-class']);
const PROC_RE = /:(?:has-text|xpath|upward|matches-css(?:-before|-after)?|min-text-length|matches-attr|matches-path|matches-media|watch-attr|others|remove|style|remove-attr|remove-class)\(/;

/** Argument of an operator starting at s[i] (just after "("); returns [arg, index after ")"]. */
function readArg(s, i) {
  if (s[i] === '/') {
    // regex argument: up to the closing slash + flags + ")"
    for (let j = i + 1; j < s.length; j++) {
      if (s[j] === '\\') {
        j++;
        continue;
      }
      if (s[j] === '/') {
        const m = /^\/[gimsu]*\)/.exec(s.slice(j));
        if (m) return [s.slice(i, j + m[0].length - 1), j + m[0].length];
      }
    }
  }
  let depth = 1;
  let quote = '';
  for (let j = i; j < s.length; j++) {
    const c = s[j];
    if (c === '\\') {
      j++;
      continue;
    }
    if (quote) {
      if (c === quote) quote = '';
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return [s.slice(i, j), j + 1];
  }
  return null;
}

/**
 * Parse a procedural selector into {prefix, steps, action}. Returns null when malformed.
 * @param {string} s
 */
export function parseProcedural(s) {
  const steps = [];
  let prefix = null;
  let buf = '';
  let action = null;
  const flush = () => {
    if (prefix === null) prefix = buf.trim();
    else if (buf.trim()) steps.push({ op: 'spath', arg: buf });
    buf = '';
  };
  for (let i = 0; i < s.length; ) {
    const c = s[i];
    if (c === '\\') {
      buf += s.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (c === '"' || c === "'") {
      const end = s.indexOf(c, i + 1);
      if (end < 0) return null;
      buf += s.slice(i, end + 1);
      i = end + 1;
      continue;
    }
    if (c === '[') {
      const end = s.indexOf(']', i);
      if (end < 0) return null;
      buf += s.slice(i, end + 1);
      i = end + 1;
      continue;
    }
    if (c === ':') {
      const m = /^:([a-z-]+)\(/.exec(s.slice(i, i + 40));
      if (m && OPS.has(m[1])) {
        const r = readArg(s, i + m[0].length);
        if (!r) return null;
        const [arg, end] = r;
        // :has() / :not() with a plain CSS argument stay native CSS
        if ((m[1] === 'has' || m[1] === 'not') && !PROC_RE.test(arg)) {
          buf += s.slice(i, end);
          i = end;
          continue;
        }
        flush();
        if (action) return null; // an action must be last
        if (ACTIONS.has(m[1])) action = { op: m[1], arg: arg.trim() };
        else {
          const step = { op: m[1], arg: arg.trim() };
          if (m[1] === 'has' || m[1] === 'not') {
            step.sub = parseProcedural(step.arg);
            if (!step.sub) return null;
          }
          steps.push(step);
        }
        i = end;
        continue;
      }
    }
    if (c === '(') {
      const r = readArg(s, i + 1);
      if (!r) return null;
      buf += s.slice(i, r[1]);
      i = r[1];
      continue;
    }
    buf += c;
    i++;
  }
  flush();
  if (action && buf.trim()) return null;
  return { prefix: prefix || '', steps, action: action || { op: 'hide', arg: '' } };
}

const textNeedle = (arg) => {
  const m = /^\/(.*)\/([gimsu]*)$/.exec(arg);
  if (m) {
    try {
      const re = new RegExp(m[1], m[2].replace('g', ''));
      return (t) => re.test(t);
    } catch {
      return () => false;
    }
  }
  const a = arg.replace(/^["']|["']$/g, '');
  return (t) => t.includes(a);
};

/** Elements matched by a parsed procedural selector, relative to `root` (document or element). */
export function runProcedural(task, root = document) {
  let nodes;
  if (task.prefix) {
    try {
      if (root === document) nodes = [...document.querySelectorAll(task.prefix)];
      else nodes = [...root.querySelectorAll(/^[>+~]/.test(task.prefix) ? `:scope ${task.prefix}` : task.prefix)];
    } catch {
      return [];
    }
  } else nodes = [root];
  for (const step of task.steps) {
    if (!nodes.length) break;
    nodes = applyStep(step, nodes);
  }
  return nodes.filter((n) => n && n.nodeType === 1);
}

function applyStep(step, nodes) {
  const { op, arg } = step;
  switch (op) {
    case 'has-text': {
      const t = step.fn || (step.fn = textNeedle(arg));
      return nodes.filter((n) => t(n.textContent || ''));
    }
    case 'has':
      return nodes.filter((n) => runProcedural(step.sub, n).length > 0);
    case 'not':
      return nodes.filter((n) => !matchesSelf(step.sub, n));
    case 'upward': {
      const num = Number(arg);
      const out = new Set();
      for (const n of nodes) {
        let p = n.nodeType === 1 ? n : null;
        if (Number.isInteger(num) && num > 0) {
          for (let k = 0; k < Math.min(num, 256) && p; k++) p = p.parentElement;
        } else {
          try {
            p = p && p.parentElement ? p.parentElement.closest(arg) : null;
          } catch {
            p = null;
          }
        }
        if (p && p !== document.documentElement && p !== document.body) out.add(p);
      }
      return [...out];
    }
    case 'xpath': {
      const out = new Set();
      for (const n of nodes) {
        try {
          const r = document.evaluate(arg, n.nodeType ? n : document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
          for (let k = 0; k < r.snapshotLength; k++) {
            const x = r.snapshotItem(k);
            if (x && x.nodeType === 1) out.add(x);
          }
        } catch {
          return [];
        }
      }
      return [...out];
    }
    case 'matches-css':
    case 'matches-css-before':
    case 'matches-css-after': {
      const m = /^([\w-]+)\s*:\s*(.+)$/.exec(arg);
      if (!m) return [];
      const prop = m[1];
      const val = m[2].trim();
      const re = /^\/.*\/[gimsu]*$/.test(val) ? textNeedle(val) : (t) => t === val;
      const pseudo = op === 'matches-css-before' ? '::before' : op === 'matches-css-after' ? '::after' : null;
      return nodes.filter((n) => n.nodeType === 1 && re(getComputedStyle(n, pseudo).getPropertyValue(prop)));
    }
    case 'min-text-length': {
      const len = Number(arg) || 0;
      return nodes.filter((n) => (n.textContent || '').length >= len);
    }
    case 'matches-attr': {
      const m = /^(".*?"|'.*?'|\/.*?\/[a-z]*|[^=]+)(?:=(.*))?$/.exec(arg);
      if (!m) return [];
      const nameT = textNeedle(m[1].replace(/^["']|["']$/g, ''));
      const exactName = !m[1].startsWith('/');
      const name = m[1].replace(/^["']|["']$/g, '');
      const valT = m[2] !== undefined ? textNeedle(m[2].replace(/^["']|["']$/g, '')) : null;
      const valExact = m[2] !== undefined && !/^["']?\//.test(m[2]) ? m[2].replace(/^["']|["']$/g, '') : null;
      return nodes.filter((n) => {
        if (n.nodeType !== 1) return false;
        for (const a of n.attributes) {
          if (exactName ? a.name !== name : !nameT(a.name)) continue;
          if (!valT) return true;
          if (valExact !== null ? a.value === valExact : valT(a.value)) return true;
        }
        return false;
      });
    }
    case 'matches-path': {
      const t = step.fn || (step.fn = textNeedle(arg));
      return t(location.pathname + location.search) ? nodes : [];
    }
    case 'matches-media':
      try {
        return matchMedia(arg).matches ? nodes : [];
      } catch {
        return [];
      }
    case 'watch-attr':
      return nodes;
    case 'spath': {
      const sel = arg.trim();
      const out = new Set();
      for (const n of nodes) {
        try {
          if (n === document) for (const x of document.querySelectorAll(sel)) out.add(x);
          else if (/^[+~]/.test(sel)) {
            const rest = sel.slice(1).trim();
            for (let s = n.nextElementSibling; s; s = s.nextElementSibling) {
              if (s.matches(rest)) out.add(s);
              if (sel[0] === '+') break;
            }
          } else for (const x of n.querySelectorAll(`:scope ${sel}`)) out.add(x);
        } catch {
          return [];
        }
      }
      return [...out];
    }
    default:
      return []; // :others() and anything unknown: match nothing
  }
}

function matchesSelf(task, el) {
  try {
    if (task.prefix && !el.matches(task.prefix)) return false;
  } catch {
    return false;
  }
  let nodes = [el];
  for (const step of task.steps) {
    if (!nodes.length) break;
    nodes = applyStep(step, nodes);
  }
  return nodes.length > 0;
}

/**
 * Apply procedural filters now and whenever the DOM changes (throttled).
 * @param {string[]} selectors
 * @param {(css: string) => void} insertCss  user-origin stylesheet injection
 * @param {(n: number) => void} [onCount]
 */
export function startProcedural(selectors, insertCss, onCount) {
  const tasks = [];
  for (const s of selectors) {
    const t = parseProcedural(s);
    if (t) tasks.push(t);
  }
  if (!tasks.length) return;
  const tag = `lwb${Math.random().toString(36).slice(2, 8)}`;
  let css = `[${tag}-h]{display:none!important}\n`;
  tasks.forEach((t, i) => {
    if (t.action.op === 'style' && !/url\(|\\|@|expression\(/i.test(t.action.arg)) css += `[${tag}-s${i}]{${t.action.arg.replace(/\s*!important/g, '').split(';').filter((d) => d.trim()).map((d) => `${d.trim()} !important`).join(';')}}\n`;
  });
  insertCss(css);
  const watchAttrs = new Set();
  for (const t of tasks) for (const st of t.steps) if (st.op === 'watch-attr') for (const a of st.arg.split(/\s*,\s*/).filter(Boolean)) watchAttrs.add(a);
  const done = new WeakSet();
  let hidden = 0;
  const run = () => {
    timer = 0;
    tasks.forEach((t, i) => {
      let nodes;
      try {
        nodes = runProcedural(t);
      } catch {
        return;
      }
      for (const n of nodes) {
        switch (t.action.op) {
          case 'remove':
            n.remove();
            hidden++;
            break;
          case 'style':
            n.setAttribute(`${tag}-s${i}`, '');
            break;
          case 'remove-attr':
            for (const a of t.action.arg.split('|')) n.removeAttribute(a.trim());
            break;
          case 'remove-class':
            for (const c of t.action.arg.split('|')) n.classList.remove(c.trim());
            break;
          default:
            if (!done.has(n)) {
              done.add(n);
              hidden++;
            }
            n.setAttribute(`${tag}-h`, '');
        }
      }
    });
    if (onCount) onCount(hidden);
  };
  let timer = 0;
  let last = 0;
  const schedule = () => {
    if (timer) return;
    const wait = Math.max(0, 120 - (Date.now() - last));
    timer = setTimeout(() => {
      last = Date.now();
      run();
    }, wait);
  };
  // From document start: elements are handled while the page is still being parsed.
  try {
    new MutationObserver(schedule).observe(document, { childList: true, subtree: true, ...(watchAttrs.size ? { attributes: true, attributeFilter: [...watchAttrs] } : {}) });
  } catch {
    /* ignore */
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run, { once: true });
  else run();
}
