// User preferences (stored in the profile DB, a subset synced as the `prefs` record).

import { EventEmitter } from 'node:events';
import { ENGINES, validTemplate } from '../search.js';

export const DEFAULT_PREFS = Object.freeze({
  searchEngine: 'google',
  customSearch: null, // {name, url} with {q}
  searchSuggestions: true,
  homepage: 'ludworks://newtab/',
  startup: 'restore', // 'restore' | 'newtab'
  showBookmarksBar: true,
  showHomeButton: false,
  theme: 'system', // 'system' | 'light' | 'dark'
  askWhereToSave: false,
  downloadsDir: '',
  sendGpc: true, // Sec-GPC: 1 (Global Privacy Control)
  blockThirdPartyCookies: false, // strip Cookie / Set-Cookie on third-party requests
  trackerButton: true, // toolbar: cross-site tracking cookies
  clearHistoryButton: true, // toolbar: clear recent history
  mediaSaverButton: true, // toolbar: save the pictures and videos of a page
  pipButton: true, // toolbar: picture-in-picture when the page has a video
  autoPip: false, // a playing video goes picture-in-picture when you switch tabs
  offerToSavePasswords: true,
  passkeys: true, // act as WebAuthn authenticator with vault passkeys
  vaultLockMinutes: 15,
  rememberVault: false, // keep an OS-protected copy of the vault key (VAULT-CRYPTO §7)
  sync: { bookmarks: true, history: true, tabs: true, prefs: true },
  zoom: {}, // host → zoom level
  spellcheck: true,
  hardwareAcceleration: true,
  autoSeparate: true, // GPU-heavy pages open in the separate process (separate.js)
  agentAccess: false, // AI agents (Claude Code, Vision, MCP clients) may use the browser (agent/agent.js)
  agentScope: 'own', // 'own': the tabs they open and tabs the user shares | 'all': every normal tab
  agentScripts: true, // browser_evaluate: agents may run JavaScript in their pages
  agentLogins: 'ask', // browser_fill_login with saved passwords: 'ask' | 'allow' (sites already allowed) | 'never'
});

/** Keys that travel in the synced `prefs` record (VAULT-CRYPTO.md §9). */
export const SYNCED_KEYS = Object.freeze({
  searchEngine: 'search_engine',
  customSearch: 'custom_search',
  homepage: 'homepage',
  showBookmarksBar: 'show_bookmarks_bar',
});

const VALIDATORS = {
  searchEngine: (v) => typeof v === 'string' && (v === 'custom' || Object.hasOwn(ENGINES, v)),
  customSearch: (v) => v === null || (v && typeof v === 'object' && typeof v.name === 'string' && v.name.length <= 100 && validTemplate(v.url)),
  searchSuggestions: (v) => typeof v === 'boolean',
  homepage: (v) => typeof v === 'string' && v.length <= 2048 && /^(https?|ludworks):\/\//.test(v),
  startup: (v) => v === 'restore' || v === 'newtab',
  showBookmarksBar: (v) => typeof v === 'boolean',
  showHomeButton: (v) => typeof v === 'boolean',
  theme: (v) => v === 'system' || v === 'light' || v === 'dark',
  askWhereToSave: (v) => typeof v === 'boolean',
  downloadsDir: (v) => typeof v === 'string' && v.length <= 4096,
  sendGpc: (v) => typeof v === 'boolean',
  blockThirdPartyCookies: (v) => typeof v === 'boolean',
  trackerButton: (v) => typeof v === 'boolean',
  clearHistoryButton: (v) => typeof v === 'boolean',
  mediaSaverButton: (v) => typeof v === 'boolean',
  pipButton: (v) => typeof v === 'boolean',
  autoPip: (v) => typeof v === 'boolean',
  offerToSavePasswords: (v) => typeof v === 'boolean',
  passkeys: (v) => typeof v === 'boolean',
  vaultLockMinutes: (v) => Number.isInteger(v) && v >= 0 && v <= 1440,
  rememberVault: (v) => typeof v === 'boolean',
  sync: (v) => v && typeof v === 'object' && ['bookmarks', 'history', 'tabs', 'prefs'].every((k) => typeof v[k] === 'boolean'),
  zoom: (v) => v && typeof v === 'object' && Object.keys(v).length <= 5000,
  spellcheck: (v) => typeof v === 'boolean',
  hardwareAcceleration: (v) => typeof v === 'boolean',
  autoSeparate: (v) => typeof v === 'boolean',
  agentAccess: (v) => typeof v === 'boolean',
  agentScope: (v) => v === 'own' || v === 'all',
  agentScripts: (v) => typeof v === 'boolean',
  agentLogins: (v) => v === 'ask' || v === 'allow' || v === 'never',
};

export class Prefs extends EventEmitter {
  /** @param {import('./db.js').ProfileDb} db */
  constructor(db) {
    super();
    this.db = db;
    const stored = db.getMeta('prefs', {}) || {};
    this.values = { ...DEFAULT_PREFS };
    for (const [k, v] of Object.entries(stored)) if (Object.hasOwn(VALIDATORS, k) && VALIDATORS[k](v)) this.values[k] = v;
    this.syncedAt = db.getMeta('prefs_updated_at', null);
  }

  get(k) {
    return this.values[k];
  }

  all() {
    return { ...this.values };
  }

  /**
   * Apply a validated patch. Returns the keys that changed.
   * @param {Record<string, any>} patch
   * @param {{fromSync?: boolean}} [opts]
   */
  update(patch, { fromSync = false } = {}) {
    const changed = [];
    for (const [k, v] of Object.entries(patch || {})) {
      if (!Object.hasOwn(VALIDATORS, k)) throw new Error(`unknown preference ${k}`);
      if (!VALIDATORS[k](v)) throw new Error(`invalid value for ${k}`);
      if (JSON.stringify(this.values[k]) === JSON.stringify(v)) continue;
      this.values[k] = v;
      changed.push(k);
    }
    if (!changed.length) return changed;
    const toStore = {};
    for (const [k, v] of Object.entries(this.values)) if (JSON.stringify(v) !== JSON.stringify(DEFAULT_PREFS[k])) toStore[k] = v;
    this.db.setMeta('prefs', toStore);
    if (!fromSync && changed.some((k) => Object.hasOwn(SYNCED_KEYS, k))) {
      this.syncedAt = new Date().toISOString();
      this.db.setMeta('prefs_updated_at', this.syncedAt);
      this.db.setMeta('prefs_dirty', true);
    }
    this.emit('change', changed, this.all());
    return changed;
  }
}
