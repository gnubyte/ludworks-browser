// Key names and chords ("Enter", "Control+Shift+K", "ArrowDown") → CDP Input.dispatchKeyEvent parameters,
// US layout like the DevTools protocol clients do. No Electron here (unit-tested).

export const MOD_BITS = Object.freeze({ Alt: 1, Control: 2, Meta: 4, Shift: 8 });

const NAMED = {
  Enter: { keyCode: 13, code: 'Enter', text: '\r' },
  Tab: { keyCode: 9, code: 'Tab' },
  Backspace: { keyCode: 8, code: 'Backspace' },
  Delete: { keyCode: 46, code: 'Delete' },
  Escape: { keyCode: 27, code: 'Escape' },
  ArrowUp: { keyCode: 38, code: 'ArrowUp' },
  ArrowDown: { keyCode: 40, code: 'ArrowDown' },
  ArrowLeft: { keyCode: 37, code: 'ArrowLeft' },
  ArrowRight: { keyCode: 39, code: 'ArrowRight' },
  Home: { keyCode: 36, code: 'Home' },
  End: { keyCode: 35, code: 'End' },
  PageUp: { keyCode: 33, code: 'PageUp' },
  PageDown: { keyCode: 34, code: 'PageDown' },
  Insert: { keyCode: 45, code: 'Insert' },
  ContextMenu: { keyCode: 93, code: 'ContextMenu' },
  Shift: { keyCode: 16, code: 'ShiftLeft', location: 1 },
  Control: { keyCode: 17, code: 'ControlLeft', location: 1 },
  Alt: { keyCode: 18, code: 'AltLeft', location: 1 },
  Meta: { keyCode: 91, code: 'MetaLeft', location: 1 },
  CapsLock: { keyCode: 20, code: 'CapsLock' },
};
for (let i = 1; i <= 12; i++) NAMED[`F${i}`] = { keyCode: 111 + i, code: `F${i}` };

const ALIASES = {
  ctrl: 'Control', control: 'Control', ctl: 'Control', cmd: 'Meta', command: 'Meta', meta: 'Meta', super: 'Meta', win: 'Meta', windows: 'Meta',
  os: 'Meta', alt: 'Alt', option: 'Alt', opt: 'Alt', shift: 'Shift', esc: 'Escape', escape: 'Escape', return: 'Enter', enter: 'Enter',
  del: 'Delete', delete: 'Delete', backspace: 'Backspace', bksp: 'Backspace', tab: 'Tab', up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft',
  right: 'ArrowRight', arrowup: 'ArrowUp', arrowdown: 'ArrowDown', arrowleft: 'ArrowLeft', arrowright: 'ArrowRight', pgup: 'PageUp',
  pageup: 'PageUp', pgdn: 'PageDown', pgdown: 'PageDown', pagedown: 'PageDown', home: 'Home', end: 'End', ins: 'Insert', insert: 'Insert',
  space: ' ', spacebar: ' ', plus: '+', minus: '-', menu: 'ContextMenu', contextmenu: 'ContextMenu', capslock: 'CapsLock',
};

// Printable US-layout keys: char → [code, keyCode, shifted?]
const PRINTABLE = new Map();
for (let c = 0; c < 26; c++) {
  const lower = String.fromCharCode(97 + c);
  const upper = lower.toUpperCase();
  PRINTABLE.set(lower, [`Key${upper}`, 65 + c, false]);
  PRINTABLE.set(upper, [`Key${upper}`, 65 + c, true]);
}
'0123456789'.split('').forEach((d, i) => PRINTABLE.set(d, [`Digit${d}`, 48 + i, false]));
')!@#$%^&*('.split('').forEach((s, i) => PRINTABLE.set(s, [`Digit${i}`, 48 + i, true]));
for (const [plain, shifted, code, keyCode] of [
  [';', ':', 'Semicolon', 186], ['=', '+', 'Equal', 187], [',', '<', 'Comma', 188], ['-', '_', 'Minus', 189], ['.', '>', 'Period', 190],
  ['/', '?', 'Slash', 191], ['`', '~', 'Backquote', 192], ['[', '{', 'BracketLeft', 219], ['\\', '|', 'Backslash', 220],
  [']', '}', 'BracketRight', 221], ["'", '"', 'Quote', 222],
]) {
  PRINTABLE.set(plain, [code, keyCode, false]);
  PRINTABLE.set(shifted, [code, keyCode, true]);
}
PRINTABLE.set(' ', ['Space', 32, false]);

function canonical(part) {
  const p = part.trim();
  if (!p) return null;
  if (p.length === 1) return p;
  const a = ALIASES[p.toLowerCase()];
  if (a) return a;
  if (Object.hasOwn(NAMED, p)) return p;
  const ci = Object.keys(NAMED).find((k) => k.toLowerCase() === p.toLowerCase());
  return ci || null;
}

export class KeyError extends Error {}

/**
 * Parses a key or chord. "Control+A", "Shift+Tab", "Meta+Shift+Z", "+", "Control++", "ControlOrMeta+K".
 * @param {string} chord
 * @param {{platform?: string}} [o]
 * @returns {{key: string, modifiers: string[]}}
 */
export function parseChord(chord, { platform = process.platform } = {}) {
  const s = String(chord || '');
  if (!s) throw new KeyError('key is empty.');
  // Split on "+" but keep a literal "+" key ("Control++", "+").
  const parts = [];
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '+' && cur !== '') {
      parts.push(cur);
      cur = '';
    } else cur += ch;
  }
  if (cur !== '') parts.push(cur);
  const mods = [];
  let key = null;
  for (const [i, raw] of parts.entries()) {
    const name = raw.toLowerCase() === 'controlormeta' ? (platform === 'darwin' ? 'Meta' : 'Control') : canonical(raw);
    if (!name) throw new KeyError(`Unknown key "${raw}". Use names like Enter, Escape, Tab, ArrowDown, PageDown, F5 or a single character.`);
    if (i < parts.length - 1) {
      if (!Object.hasOwn(MOD_BITS, name)) throw new KeyError(`"${raw}" is not a modifier (Control, Alt, Shift, Meta).`);
      if (!mods.includes(name)) mods.push(name);
    } else key = name;
  }
  return { key, modifiers: mods };
}

/**
 * dispatchKeyEvent parameters for one key press (keyDown with its text, then keyUp).
 * @param {string} key canonical key from parseChord
 * @param {string[]} modifiers
 * @param {{platform?: string}} [o]
 */
export function keyEvents(key, modifiers = [], { platform = process.platform } = {}) {
  let mask = 0;
  for (const m of modifiers) mask |= MOD_BITS[m] || 0;
  let desc;
  if (Object.hasOwn(NAMED, key)) {
    const n = NAMED[key];
    desc = { key, code: n.code, windowsVirtualKeyCode: n.keyCode, text: n.text || '', location: n.location || 0 };
  } else if (PRINTABLE.has(key)) {
    const [code, keyCode, shifted] = PRINTABLE.get(key);
    if (shifted) mask |= MOD_BITS.Shift;
    desc = { key, code, windowsVirtualKeyCode: keyCode, text: key, location: 0 };
  } else {
    desc = { key, code: '', windowsVirtualKeyCode: 0, text: key, location: 0 };
  }
  // A chord with Control/Alt/Meta types nothing; Shift alone still types its character.
  const typing = desc.text && !(mask & (MOD_BITS.Control | MOD_BITS.Alt | MOD_BITS.Meta));
  const commands = platform === 'darwin' && mask & MOD_BITS.Meta ? macCommands(key, mask) : [];
  const down = {
    type: typing ? 'keyDown' : 'rawKeyDown',
    modifiers: mask,
    key: desc.key,
    code: desc.code,
    windowsVirtualKeyCode: desc.windowsVirtualKeyCode,
    nativeVirtualKeyCode: desc.windowsVirtualKeyCode,
    location: desc.location,
    ...(typing ? { text: desc.text, unmodifiedText: desc.text } : {}),
    ...(commands.length ? { commands } : {}),
  };
  const up = { type: 'keyUp', modifiers: mask, key: desc.key, code: desc.code, windowsVirtualKeyCode: desc.windowsVirtualKeyCode, nativeVirtualKeyCode: desc.windowsVirtualKeyCode, location: desc.location };
  return { down, up };
}

// macOS handles editing shortcuts in the app menu, not the page: pass the editing command along.
function macCommands(key, mask) {
  const k = key.toLowerCase();
  const shift = !!(mask & MOD_BITS.Shift);
  if (k === 'a') return ['selectAll'];
  if (k === 'c') return ['copy'];
  if (k === 'x') return ['cut'];
  if (k === 'v') return ['paste'];
  if (k === 'z') return [shift ? 'redo' : 'undo'];
  return [];
}

/** Modifier keyDown/keyUp events wrapped around a chord (some pages watch the modifier keys themselves). */
export function modifierEvents(modifiers, down) {
  const out = [];
  let mask = down ? 0 : modifierMask(modifiers);
  const list = down ? modifiers : [...modifiers].reverse();
  for (const m of list) {
    if (down) mask |= MOD_BITS[m];
    else mask &= ~MOD_BITS[m];
    const n = NAMED[m];
    out.push({ type: down ? 'rawKeyDown' : 'keyUp', modifiers: mask, key: m, code: n.code, windowsVirtualKeyCode: n.keyCode, nativeVirtualKeyCode: n.keyCode, location: 1 });
  }
  return out;
}

/** CDP modifier bitmask of a modifier list. */
export function modifierMask(modifiers = []) {
  let mask = 0;
  for (const m of modifiers) mask |= MOD_BITS[m] || 0;
  return mask;
}
