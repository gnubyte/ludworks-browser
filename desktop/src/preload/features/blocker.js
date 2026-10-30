// Content blocker, page side (isolated world of the tab preload, every frame).
//
// At document start the frame asks the browser (one synchronous IPC; the browser derives the site
// from the sending frame, never from the page) for its cosmetic rules, then:
//   * injects specific + always-on generic hide rules as a *user* stylesheet (pages cannot see,
//     remove or out-rank it),
//   * runs the site's scriptlets in the page's main world before any page script
//     (contextBridge.executeInMainWorld),
//   * evaluates procedural filters (blocker-procedural.js),
//   * collects the class names / ids that appear in the page and asks for the generic hide rules
//     keyed on them (throttled, only new names are sent).
// The top frame also hosts the element picker when the user starts it from the shield popup.

import { runScriptlets } from './blocker-scriptlets.js';
import { startProcedural } from './blocker-procedural.js';
import { startPicker } from './blocker-picker.js';

const KEY_RE = /^[A-Za-z_-][\w-]{0,80}$/;

export function setupBlocker() {
  const { ipcRenderer, webFrame, contextBridge } = require('electron');
  const insertCss = (css) => {
    if (!css) return;
    try {
      webFrame.insertCSS(css, { cssOrigin: 'user' });
    } catch {
      /* frame gone */
    }
  };
  if (window === window.top) {
    ipcRenderer.on('blocker:pick', () => {
      startPicker({
        create: (selector) =>
          ipcRenderer.invoke('blocker:pick', { selector: String(selector).slice(0, 1000) }).then((r) => {
            if (!r || !r.ok) return false;
            insertCss(r.css);
            return true;
          }),
      });
    });
  }
  let rules = null;
  try {
    rules = ipcRenderer.sendSync('blocker:frame');
  } catch {
    rules = null;
  }
  if (!rules || typeof rules !== 'object') return;
  if (Array.isArray(rules.scriptlets) && rules.scriptlets.length && typeof contextBridge.executeInMainWorld === 'function') {
    try {
      contextBridge.executeInMainWorld({ func: runScriptlets, args: [rules.scriptlets] });
    } catch {
      /* keep the page working */
    }
  }
  insertCss(rules.css);
  if (Array.isArray(rules.procedural) && rules.procedural.length) {
    try {
      let reported = 0;
      startProcedural(rules.procedural, insertCss, (n) => {
        if (n > reported) {
          reported = n;
          ipcRenderer.send('blocker:hidden', { procedural: n });
        }
      });
    } catch {
      /* ignore */
    }
  }
  if (rules.generic) collectGeneric(ipcRenderer, insertCss);
}

/** Watch the DOM for class names and ids; fetch the generic hide rules keyed on new ones. */
function collectGeneric(ipcRenderer, insertCss) {
  const seen = new Set();
  let pending = [];
  let timer = 0;
  let last = 0;
  let inflight = false;
  const add = (k) => {
    if (!seen.has(k)) {
      seen.add(k);
      pending.push(k);
    }
  };
  const collect = (el) => {
    if (el.nodeType !== 1) return;
    const id = el.id;
    if (id && typeof id === 'string' && KEY_RE.test(id)) add(`#${id}`);
    const cl = el.classList;
    if (cl) for (let i = 0; i < cl.length; i++) if (KEY_RE.test(cl[i])) add(`.${cl[i]}`);
  };
  const flush = () => {
    timer = 0;
    if (!pending.length) return;
    if (inflight) {
      schedule();
      return;
    }
    last = Date.now();
    const keys = pending.slice(0, 4000);
    pending = pending.slice(4000);
    inflight = true;
    ipcRenderer
      .invoke('blocker:generic', keys)
      .then(insertCss, () => {})
      .finally(() => {
        inflight = false;
        if (pending.length) schedule();
      });
  };
  const schedule = () => {
    if (!timer) timer = setTimeout(flush, Math.max(16, 100 - (Date.now() - last)));
  };
  const scanAll = () => {
    if (!document.documentElement) return;
    collect(document.documentElement);
    for (const el of document.querySelectorAll('[id],[class]')) collect(el);
    flush();
  };
  try {
    new MutationObserver((records) => {
      for (const r of records) {
        if (r.type === 'attributes') collect(r.target);
        else {
          for (const n of r.addedNodes) {
            if (n.nodeType !== 1) continue;
            collect(n);
            if (n.firstElementChild) for (const el of n.querySelectorAll('[id],[class]')) collect(el);
          }
        }
      }
      if (pending.length) schedule();
    }).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'id'] });
  } catch {
    /* observer unavailable: DOMContentLoaded scan below still runs */
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', scanAll, { once: true });
  else scanAll();
}
