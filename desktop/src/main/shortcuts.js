// Keyboard shortcuts.
//
// "Reserved" shortcuts (new/close tab, tab switching, address bar, reload, back/forward…) are taken
// before the page sees the key, like in Chrome. "Page-first" shortcuts (find, save, print, zoom,
// bookmark…) go to the page first; the content preload reports them back only when the page did not
// handle them (preventDefault), so web apps that bind e.g. Ctrl+F keep working.

const isMac = process.platform === 'darwin';

/**
 * @param {Electron.Input} input
 * @returns {{cmd: string, arg?: any, reserved: boolean}|null}
 */
export function resolveShortcut(input) {
  if (input.type !== 'keyDown') return null;
  const mod = isMac ? input.meta : input.control;
  const other = isMac ? input.control : input.meta;
  const key = (input.key || '').length === 1 ? input.key.toLowerCase() : input.key;
  const code = input.code || '';
  const R = (cmd, arg) => ({ cmd, arg, reserved: true });
  const P = (cmd, arg) => ({ cmd, arg, reserved: false });
  if (other && !isMac) return null;

  if (mod && !input.alt) {
    if (!input.shift) {
      switch (key) {
        case 't': return R('newTab');
        case 'w': return R('closeTab');
        case 'F4': return R('closeTab');
        case 'n': return R('newWindow');
        case 'l': return R('focusOmnibox');
        case 'k': case 'e': return R('focusSearch');
        case 'r': return R('reload');
        case 'h': return R(isMac ? 'hideApp' : 'history');
        case 'y': return isMac ? R('history') : null;
        case 'j': return R('downloads');
        case 'q': return isMac ? R('quit') : null;
        case 'Tab': return R('nextTab');
        case 'PageDown': return R('nextTab');
        case 'PageUp': return R('prevTab');
        case 'f': return P('find');
        case 'g': return P('findNext');
        case 's': return P('savePage');
        case 'p': return P('print');
        case 'd': return P('bookmarkPage');
        case 'u': return P('viewSource');
        case '=': case '+': return P('zoomIn');
        case '-': return P('zoomOut');
        case '0': return P('zoomReset');
        case '[': return isMac ? R('back') : null;
        case ']': return isMac ? R('forward') : null;
        case ',': return isMac ? R('settings') : null;
        default:
          if (/^[1-8]$/.test(key)) return R('selectTab', Number(key) - 1);
          if (key === '9') return R('lastTab');
          if (code === 'NumpadAdd') return P('zoomIn');
          if (code === 'NumpadSubtract') return P('zoomOut');
          return null;
      }
    }
    switch (key) {
      case 't': return R('reopenTab');
      case 'n': return R('privateWindow');
      case 'b': return R('toggleBookmarksBar');
      case 'o': return R('bookmarks');
      case 'i': return R('devtools');
      case 'j': return R('devtools');
      case 'c': return R('inspect');
      case 'r': return R('hardReload');
      case 'Delete': return R('clearData');
      case 'Tab': return R('prevTab');
      case 'g': return P('findPrev');
      case 'a': return R('tabSearch');
      case '[': return isMac ? R('prevTab') : null;
      case ']': return isMac ? R('nextTab') : null;
      case 'h': return isMac ? R('home') : null;
      case '+': case '=': return P('zoomIn');
      default: return null;
    }
  }
  if (input.alt && !mod && !input.shift) {
    if (key === 'ArrowLeft' && !isMac) return R('back');
    if (key === 'ArrowRight' && !isMac) return R('forward');
    if (key === 'Home') return R('home');
    if (key === 'd' && !isMac) return R('focusOmnibox');
    if ((key === 'f' || key === 'e') && !isMac) return R('menu');
  }
  if (isMac && input.meta && input.alt) {
    if (key === 'ArrowLeft') return R('prevTab');
    if (key === 'ArrowRight') return R('nextTab');
    if (key === 'i') return R('devtools');
  }
  if (!mod && !input.alt) {
    switch (key) {
      case 'F5': return R(input.shift ? 'hardReload' : 'reload');
      case 'F6': return R('focusOmnibox');
      case 'F11': return R('toggleFullscreen');
      case 'F12': return R('devtools');
      case 'F3': return P(input.shift ? 'findPrev' : 'findNext');
      case 'BrowserBack': return R('back');
      case 'BrowserForward': return R('forward');
      case 'BrowserRefresh': return R('reload');
      default: return null;
    }
  }
  if (mod && key === 'F5') return R('hardReload');
  return null;
}

export class Shortcuts {
  /** @param {import('./browser.js').Browser} browser */
  constructor(browser) {
    this.browser = browser;
  }

  /**
   * before-input-event handler for tabs (tab set) and browser UI views (tab null).
   * @param {Electron.Event} event
   * @param {Electron.Input} input
   * @param {import('./window.js').WindowCtl} ctl
   * @param {import('./tab.js').Tab|null} tab
   */
  handle(event, input, ctl, tab) {
    const s = resolveShortcut(input);
    if (!s) return;
    // In a tab, page-first shortcuts are left to the page (the content preload reports unhandled ones).
    if (tab && !s.reserved && tab.wc === event.sender) return;
    event.preventDefault();
    this.browser.command(s.cmd, { ctl, tab: tab || ctl.activeTab(), arg: s.arg });
  }

  /** A page-first shortcut the page did not handle (reported by the content preload). */
  unhandled(ctl, tab, input) {
    const s = resolveShortcut({ ...input, type: 'keyDown' });
    if (!s || s.reserved) return;
    this.browser.command(s.cmd, { ctl, tab, arg: s.arg });
  }
}
