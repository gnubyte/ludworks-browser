// Password / passphrase generator view and shared preference helpers.

import { ext } from '../../lib/browser.js';
import {
  PASSWORD_DEFAULTS,
  PASSPHRASE_DEFAULTS,
  MIN_LENGTH,
  MAX_LENGTH,
  MIN_WORDS,
  MAX_WORDS,
  generatePassword,
  generatePassphrase,
  estimateStrength,
  scoreForBits,
  STRENGTH_LABELS,
  passwordEntropyBits,
  passphraseEntropyBits,
} from '../../lib/generator.js';
import { h, clear, iconButton, toggle, segmented, nextId } from '../ui.js';

const PREFS_KEY = 'generatorPrefs';

/** Load generator preferences (non-secret) from extension storage. */
export async function loadGeneratorPrefs() {
  let saved = {};
  try {
    const r = await ext.storage.local.get(PREFS_KEY);
    saved = (r && r[PREFS_KEY]) || {};
  } catch {
    saved = {};
  }
  const mode = saved.mode === 'passphrase' ? 'passphrase' : 'password';
  const password = { ...PASSWORD_DEFAULTS, ...(saved.password || {}) };
  const passphrase = { ...PASSPHRASE_DEFAULTS, ...(saved.passphrase || {}) };
  password.length = Math.min(MAX_LENGTH, Math.max(MIN_LENGTH, Number(password.length) || PASSWORD_DEFAULTS.length));
  passphrase.words = Math.min(MAX_WORDS, Math.max(MIN_WORDS, Number(passphrase.words) || PASSPHRASE_DEFAULTS.words));
  if (typeof passphrase.separator !== 'string' || passphrase.separator.length > 3) passphrase.separator = '-';
  if (!password.upper && !password.lower && !password.digits && !password.symbols) password.lower = true;
  return { mode, password, passphrase };
}

function savePrefs(prefs) {
  ext.storage.local.set({ [PREFS_KEY]: prefs }).catch(() => {});
}

/** Generate a value with the given preferences. */
export function generateFromPrefs(prefs) {
  return prefs.mode === 'passphrase' ? generatePassphrase(prefs.passphrase) : generatePassword(prefs.password);
}

/**
 * Strength meter element bound to a value.
 * @returns {{el: HTMLElement, update: (value: string, bitsOverride?: number) => void}}
 */
export function strengthMeter() {
  const bars = Array.from({ length: 5 }, () => h('span', { class: 'meter-bar' }));
  const label = h('span', { class: 'meter-label' });
  const el = h('div', { class: 'meter', role: 'meter', 'aria-valuemin': '0', 'aria-valuemax': '4', 'aria-label': 'Password strength' }, h('div', { class: 'meter-bars' }, bars), label);
  return {
    el,
    /** @param {string} value  @param {number} [exactBits]  known entropy of a generated value */
    update(value, exactBits) {
      const bits = exactBits !== undefined ? exactBits : estimateStrength(value || '').entropyBits;
      const score = scoreForBits(bits);
      const labels = STRENGTH_LABELS;
      bars.forEach((b, i) => {
        b.className = `meter-bar${value && i <= score ? ` s${score}` : ''}`;
      });
      label.textContent = value ? `${labels[score]} · ~${Math.round(bits)} bits` : '';
      el.setAttribute('aria-valuenow', String(value ? score : 0));
      el.setAttribute('aria-valuetext', value ? labels[score] : 'empty');
    },
  };
}

function colorize(value) {
  const out = h('span', { class: 'gen-value mono' });
  for (const ch of value) {
    const cls = /[0-9]/.test(ch) ? 'ch-digit' : /[A-Za-z]/.test(ch) ? 'ch-letter' : 'ch-symbol';
    out.append(h('span', { class: cls, text: ch }));
  }
  return out;
}

/** Stand-alone generator. */
export async function generatorView(app) {
  const prefs = await loadGeneratorPrefs();
  let value = '';
  const output = h('div', { class: 'gen-output', 'aria-live': 'polite' });
  const meter = strengthMeter();
  const options = h('div', { class: 'gen-options' });

  function regenerate() {
    try {
      value = generateFromPrefs(prefs);
    } catch (e) {
      app.toast(e.message, 'error');
      return;
    }
    clear(output).append(colorize(value));
    const bits = prefs.mode === 'passphrase' ? passphraseEntropyBits(prefs.passphrase) : passwordEntropyBits(prefs.password);
    meter.update(value, bits);
    savePrefs(prefs);
  }

  function slider(label, min, max, get, set) {
    const id = nextId('rng');
    const range = h('input', { id, type: 'range', class: 'range', min: String(min), max: String(max), value: String(get()) });
    const num = h('input', { type: 'number', class: 'input input-num', min: String(min), max: String(max), value: String(get()), 'aria-label': label });
    const apply = (v) => {
      const n = Math.min(max, Math.max(min, Math.round(Number(v) || min)));
      set(n);
      range.value = String(n);
      num.value = String(n);
      regenerate();
    };
    range.addEventListener('input', () => apply(range.value));
    num.addEventListener('change', () => apply(num.value));
    return h('div', { class: 'field' }, h('label', { for: id, class: 'field-label', text: label }), h('div', { class: 'range-row' }, range, num));
  }

  function renderOptions() {
    clear(options);
    if (prefs.mode === 'password') {
      const p = prefs.password;
      const setOpt = (key) => (checked, input) => {
        const next = { ...p, [key]: checked };
        if (!next.upper && !next.lower && !next.digits && !next.symbols) {
          input.checked = true;
          app.toast('Keep at least one character set enabled.', 'error');
          return;
        }
        p[key] = checked;
        regenerate();
      };
      options.append(
        slider('Length', MIN_LENGTH, MAX_LENGTH, () => p.length, (n) => { p.length = n; }),
        toggle('Uppercase (A–Z)', p.upper, setOpt('upper')),
        toggle('Lowercase (a–z)', p.lower, setOpt('lower')),
        toggle('Digits (0–9)', p.digits, setOpt('digits')),
        toggle('Symbols (!@#$…)', p.symbols, setOpt('symbols')),
        toggle('Avoid ambiguous characters', p.excludeAmbiguous, (c) => { p.excludeAmbiguous = c; regenerate(); }, 'Leaves out I, l, 1, O and 0.'),
      );
    } else {
      const p = prefs.passphrase;
      const sepId = nextId('sep');
      const sep = h('input', { id: sepId, type: 'text', class: 'input input-num', maxlength: '3', value: p.separator, spellcheck: 'false' });
      sep.addEventListener('input', () => {
        p.separator = sep.value.slice(0, 3);
        regenerate();
      });
      options.append(
        slider('Words', MIN_WORDS, MAX_WORDS, () => p.words, (n) => { p.words = n; }),
        h('div', { class: 'field inline' }, h('label', { for: sepId, class: 'field-label', text: 'Separator' }), sep),
        toggle('Capitalize words', p.capitalize, (c) => { p.capitalize = c; regenerate(); }),
        toggle('Include a number', p.includeNumber, (c) => { p.includeNumber = c; regenerate(); }),
      );
    }
  }

  const mode = segmented('gen-mode', [{ value: 'password', label: 'Password' }, { value: 'passphrase', label: 'Passphrase' }], prefs.mode, (v) => {
    prefs.mode = v;
    renderOptions();
    regenerate();
  }, 'Generator type');

  renderOptions();
  regenerate();

  return h(
    'div',
    { class: 'view view-generator' },
    app.header({ title: 'Generator', back: true }),
    h(
      'main',
      { class: 'view-body' },
      h(
        'div',
        { class: 'gen-box' },
        output,
        h('div', { class: 'gen-actions' }, iconButton('refresh', 'Generate another', regenerate), iconButton('copy', 'Copy', () => app.copy(value, prefs.mode === 'passphrase' ? 'Passphrase' : 'Password'))),
      ),
      meter.el,
      mode,
      options,
    ),
  );
}
