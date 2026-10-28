// Password autofill and "offer to save", driven by the tab preload (preload/features/autofill.js).
//
// The dropdown and every prompt are drawn by the browser (overlay view) — a page can neither see nor
// click-jack them. Fills happen only after the user picks a login, only into the frame that asked,
// with the same URI rules as the Ludworks Passwords extension (VAULT-CRYPTO.md §8.3).

import { createHash } from 'node:crypto';
import { clipboard } from 'electron';
import { ruleMatches, bestMatchScore, STRONG_MATCH, pageSecurity, registrableDomain, hostLabel, siteName, parseHttpUrl } from '../lib/url-match.js';
import { newLoginItem } from '../lib/item-model.js';
import { generatePassword, PASSWORD_DEFAULTS } from '../lib/generator.js';
import { generateTotp } from '../lib/totp.js';
import { log } from './util/log.js';

const CAPTURE_TTL = 5 * 60 * 1000;
const sha = (s) => createHash('sha256').update(s).digest('hex');
const frameKey = (f) => `${f.processId}:${f.routingId}`;

export class Autofill {
  /** @param {import('./browser.js').Browser} browser */
  constructor(browser) {
    this.b = browser;
    this.tabs = new Map(); // tab id → {frames: Map, matchCount, capture, dropdown}
    this.lastUsed = new Map(); // item id → ms
  }

  st(tab) {
    let s = this.tabs.get(tab.id);
    if (!s) {
      s = { frames: new Map(), matchCount: 0, capture: null, dropdown: null, hideTimer: null };
      this.tabs.set(tab.id, s);
    }
    return s;
  }

  onTabClosed(tab) {
    this.tabs.delete(tab.id);
    this.b.passkeys.onTabClosed(tab);
  }

  isLoginField(tab, params) {
    const s = this.tabs.get(tab.id);
    return !!(s && [...s.frames.values()].some((f) => f.mode !== 'none') && params.formControlType && /input/.test(params.formControlType) && this.b.account.phase() !== 'logged_out');
  }

  // ------------------------------------------------------------------------------ matching
  async loginsForUrl(url) {
    if (!parseHttpUrl(url)) return [];
    const out = [];
    for (const it of await this.b.account.logins()) {
      const uris = Array.isArray(it.data.login.uris) ? it.data.login.uris.filter((u) => u && typeof u.uri === 'string') : [];
      if (!uris.some((u) => ruleMatches(url, u))) continue;
      out.push({ ...it, score: bestMatchScore(url, uris), uris });
    }
    out.sort((a, b) => b.score - a.score || (this.lastUsed.get(b.id) || 0) - (this.lastUsed.get(a.id) || 0) || String(a.data.name).localeCompare(String(b.data.name)));
    return out;
  }

  /** Recompute the omnibox key state for a tab (after navigation, vault changes, new forms). */
  async refreshTab(tab) {
    if (!tab || tab.destroyed) return;
    const s = this.st(tab);
    try {
      s.matchCount = this.b.account.vault.isUnlocked() ? (await this.loginsForUrl(tab.wc.getURL())).length : 0;
    } catch {
      s.matchCount = 0;
    }
    tab.ctl.sendState();
  }

  refreshAll() {
    for (const t of this.b.allTabs()) this.refreshTab(t);
  }

  keyStateFor(tab) {
    if (!tab) return null;
    const phase = this.b.account.phase();
    if (phase === 'logged_out') return null;
    const s = this.tabs.get(tab.id);
    const hasForm = !!(s && [...s.frames.values()].some((f) => f.mode !== 'none'));
    const capture = !!(s && s.capture && Date.now() - s.capture.at < CAPTURE_TTL);
    return { show: hasForm || capture || !!(s && s.matchCount), count: s ? s.matchCount : 0, locked: phase !== 'unlocked', capture };
  }

  // ------------------------------------------------------------------------- content messages
  contentMessage(tab, frame, cmd, a) {
    if (!frame) return;
    const s = this.st(tab);
    switch (cmd) {
      case 'forms':
        s.frames.set(frameKey(frame), { mode: String(a.mode || 'none'), url: frame.url });
        this.refreshTab(tab);
        break;
      case 'field-focus':
        clearTimeout(s.hideTimer);
        this.showDropdown(tab, frame, a).catch((e) => log.debug('dropdown failed', { message: e.message }));
        break;
      case 'field-blur':
        clearTimeout(s.hideTimer);
        s.hideTimer = setTimeout(() => {
          const ov = tab.ctl.overlay;
          if (tab.ctl.popup && tab.ctl.popup.kind === 'fill' && !(ov && ov.webContents.isFocused())) tab.ctl.hidePopup('fill');
        }, 180);
        break;
      case 'field-key':
        if (a.key === 'Escape') tab.ctl.hidePopup('fill');
        else if (a.key === 'ArrowDown' && tab.ctl.popup && tab.ctl.popup.kind === 'fill' && tab.ctl.overlay) tab.ctl.overlay.webContents.focus();
        break;
      case 'fill-result':
        if (a && a.ok === false && a.error !== 'no_fields') log.info('fill refused by page checks', { error: a.error });
        break;
      case 'submitted':
        this.onSubmitted(tab, frame, a).catch((e) => log.debug('capture failed', { message: e.message }));
        break;
      case 'webauthn.cancel':
        this.b.passkeys.cancel(tab, String(a.id || ''));
        break;
      default:
        break;
    }
  }

  async contentCall() {
    return null;
  }

  // -------------------------------------------------------------------------------- dropdown
  anchorFor(tab, rect) {
    const z = tab.wc.getZoomFactor();
    const area = tab.ctl.contentRect();
    if (!rect || !Number.isFinite(rect.x)) return { x: Math.max(8, area.width - 380), y: tab.ctl.topInset - 2, width: 360 };
    const x = Math.round(rect.x * z);
    const y = Math.round(area.y + (rect.y + rect.height) * z + 3);
    return { x: Math.max(4, x), y: Math.min(y, area.y + area.height - 60), width: Math.max(300, Math.min(440, Math.round(rect.width * z))) };
  }

  async showDropdown(tab, frame, f) {
    if (tab.ctl.activeId !== tab.id || tab.ctl.destroyed) return;
    const acct = this.b.account;
    const phase = acct.phase();
    if (phase === 'logged_out' || phase === 'uninitialized') return;
    const s = this.st(tab);
    const url = frame.url;
    const unlocked = phase === 'unlocked';
    const matches = unlocked ? await this.loginsForUrl(url) : [];
    const passkeys = await this.b.passkeys.conditionalFor(tab);
    const generate = f.kind === 'new-password';
    if (unlocked && !matches.length && !passkeys.length && !generate) return;
    if (!unlocked && !(f.kind === 'username' || f.kind === 'password' || f.webauthn)) return;
    s.dropdown = { frame, url, kind: f.kind, rect: f.rect, generated: null };
    const items = matches.slice(0, 8).map((m) => ({
      id: m.id,
      name: String(m.data.name || ''),
      username: String((m.data.login && m.data.login.username) || ''),
      otherHost: m.score < STRONG_MATCH ? [...new Set(m.uris.filter((u) => ruleMatches(url, u)).map((u) => hostLabel(u.uri)).filter(Boolean))] : null,
      totp: !!(m.data.login && m.data.login.totp),
    }));
    tab.ctl.showPopup(
      'fill',
      { locked: !unlocked, host: hostLabel(url), items, passkeys: passkeys.map((p) => ({ requestKey: p.requestKey, key: p.key, userName: p.userName, displayName: p.displayName, itemName: p.itemName })), generate, insecure: pageSecurity(url) !== 'secure' },
      this.anchorFor(tab, f.rect),
      { focus: false, closeOnBlur: true },
    );
  }

  /** Fill a login into the frame that owns the dropdown (or the top frame for the key bubble). */
  async fillItem(tab, frame, itemId, { allowOtherHost = false, allowInsecure = false } = {}) {
    const acct = this.b.account;
    const e = await acct.vault.get(itemId);
    if (e.stale) throw new Error('This item failed the freshness check and is not used for autofill.');
    const data = e.data;
    if (data.type !== 'login' || !data.login) throw new Error('Only logins can be filled.');
    const url = frame.url;
    const uris = (data.login.uris || []).filter((u) => u && typeof u.uri === 'string');
    if (!uris.some((u) => ruleMatches(url, u))) throw new Error('This login is not saved for this website.');
    if (bestMatchScore(url, uris) < STRONG_MATCH && !allowOtherHost) throw new Error('other_host');
    const sec = pageSecurity(url);
    if (sec === 'insecure') throw new Error('Passwords are never filled into insecure (http) pages.');
    let totp = '';
    if (typeof data.login.totp === 'string' && data.login.totp.trim()) {
      try {
        totp = (await generateTotp(data.login.totp, Date.now())).code;
      } catch {
        totp = '';
      }
    }
    const u = new URL(url);
    frame.send('lw-fill', {
      id: itemId,
      expectedOrigin: u.origin,
      expectedUrl: url,
      uris: uris.map((x) => ({ uri: x.uri, match: x.match || 'domain' })),
      username: typeof data.login.username === 'string' ? data.login.username : '',
      password: typeof data.login.password === 'string' ? data.login.password : '',
      totp,
      allowInsecure: sec === 'insecure_localhost' && allowInsecure,
    });
    this.lastUsed.set(itemId, Date.now());
    return { totp: !!totp };
  }

  /** Fill shortcut / context menu: the best login for this very host, else open the key bubble. */
  async fillBest(tab) {
    const frame = tab.wc.mainFrame;
    const m = (await this.loginsForUrl(frame.url)).filter((x) => x.score >= STRONG_MATCH);
    if (m.length === 1) return this.fillItem(tab, frame, m[0].id);
    tab.ctl.shell.send('open-key');
    return null;
  }

  openFillMenu(tab) {
    tab.ctl.shell.send('open-key');
  }

  async generateInto(tab, params) {
    const frame = params && params.frame ? params.frame : tab.wc.mainFrame;
    const password = generatePassword({ ...PASSWORD_DEFAULTS });
    frame.send('lw-fill', { mode: 'generate', password, expectedOrigin: new URL(frame.url).origin, expectedUrl: frame.url });
    return password;
  }

  // -------------------------------------------------------------------------------- capture
  async neverList() {
    return this.b.db.getMeta('never_save', []) || [];
  }

  async onSubmitted(tab, frame, a) {
    if (!this.b.prefs.get('offerToSavePasswords') || tab.private) return;
    if (this.b.account.phase() !== 'unlocked') return;
    const url = String(a.url || frame.url);
    const username = String(a.username || '').slice(0, 512);
    const password = String(a.password || '').slice(0, 1024);
    if (!password || pageSecurity(url) === 'insecure') return;
    const u = parseHttpUrl(url);
    if (!u) return;
    const domain = registrableDomain(u.hostname);
    if ((await this.neverList()).includes(sha(domain))) return;
    let target = null;
    for (const m of await this.loginsForUrl(url)) {
      const user = String(m.data.login.username || '');
      if (user.toLowerCase() !== username.toLowerCase()) continue;
      if (m.data.login.password === password) return; // already saved
      if (m.score >= STRONG_MATCH && !target) target = m;
    }
    const s = this.st(tab);
    s.capture = { id: sha(`${Date.now()}${Math.random()}`).slice(0, 16), kind: target ? 'update' : 'save', itemId: target ? target.id : null, itemName: target ? String(target.data.name || '') : '', origin: u.origin, host: u.host, domain, username, password, at: Date.now() };
    tab.ctl.sendState();
    // Ask after the page has had a moment to navigate (most logins redirect).
    setTimeout(() => {
      if (!tab.destroyed && tab.ctl.activeId === tab.id && s.capture) tab.ctl.shell.send('open-key');
    }, 900);
  }

  // ----------------------------------------------------------------------- key bubble + popups
  async openKeyBubble(ctl, anchor) {
    const tab = ctl.activeTab();
    if (!tab) return null;
    const acct = this.b.account;
    const phase = acct.phase();
    const s = this.st(tab);
    const capture = s.capture && Date.now() - s.capture.at < CAPTURE_TTL ? s.capture : null;
    const url = tab.wc.getURL();
    const matches = phase === 'unlocked' ? await this.loginsForUrl(url) : [];
    return ctl.showPopup(
      'key',
      {
        phase,
        host: hostLabel(url),
        capture: capture ? { id: capture.id, kind: capture.kind, host: capture.host, username: capture.username, itemName: capture.itemName } : null,
        items: matches.slice(0, 12).map((m) => ({ id: m.id, name: String(m.data.name || ''), username: String(m.data.login.username || ''), otherHost: m.score < STRONG_MATCH, totp: !!m.data.login.totp, passkeys: Array.isArray(m.data.login.passkeys) ? m.data.login.passkeys.length : 0 })),
      },
      { ...anchor, width: 360 },
      { closeOnBlur: !capture },
    );
  }

  async popupAction(ctl, kind, action, d) {
    const tab = ctl.activeTab();
    if (!tab) return null;
    const s = this.st(tab);
    try {
      switch (`${kind}:${action}`) {
        case 'fill:fill':
        case 'key:fill': {
          const frame = kind === 'fill' && s.dropdown && !s.dropdown.frame.isDestroyed() ? s.dropdown.frame : tab.wc.mainFrame;
          ctl.hidePopup(kind);
          await this.fillItem(tab, frame, String(d.id), { allowOtherHost: !!d.allowOtherHost, allowInsecure: !!d.allowInsecure });
          return { ok: true };
        }
        case 'fill:passkey':
          ctl.hidePopup('fill');
          return { ok: await this.b.passkeys.completeConditional(String(d.requestKey), String(d.key)) };
        case 'fill:generate': {
          const frame = s.dropdown && !s.dropdown.frame.isDestroyed() ? s.dropdown.frame : tab.wc.mainFrame;
          ctl.hidePopup('fill');
          await this.generateInto(tab, { frame });
          return { ok: true };
        }
        case 'fill:unlock':
        case 'key:unlock': {
          await this.b.account.unlock(String(d.password || ''), { remember: null });
          await this.refreshTab(tab);
          if (kind === 'key') return this.openKeyBubble(ctl, ctl.popup ? ctl.popup.anchor : { x: 0, y: ctl.topInset, width: 360 });
          if (s.dropdown) await this.showDropdown(tab, s.dropdown.frame, { kind: s.dropdown.kind, rect: s.dropdown.rect });
          return { ok: true };
        }
        case 'fill:manage':
        case 'key:manage':
          ctl.hidePopup(kind);
          this.b.openInternal(ctl, 'passwords');
          return { ok: true };
        case 'key:copy': {
          const e = await this.b.account.vault.get(String(d.id));
          const field = d.field === 'username' ? e.data.login.username : d.field === 'totp' ? (await generateTotp(e.data.login.totp, Date.now())).code : e.data.login.password;
          copySecret(String(field || ''));
          return { ok: true };
        }
        case 'key:generate':
          return { ok: true, value: generatePassword({ ...PASSWORD_DEFAULTS }) };
        case 'key:signin':
          ctl.hidePopup('key');
          ctl.shell.send('open-account');
          return { ok: true };
        case 'key:capture': {
          const c = s.capture;
          if (!c || c.id !== d.id) return { ok: false };
          s.capture = null;
          ctl.hidePopup('key');
          tab.ctl.sendState();
          if (d.decision === 'never') {
            const list = await this.neverList();
            const h = sha(c.domain);
            if (!list.includes(h)) this.b.db.setMeta('never_save', [...list, h].slice(-5000));
            return { ok: true };
          }
          if (d.decision === 'update' && c.kind === 'update') {
            const e = await this.b.account.vault.get(c.itemId);
            const data = JSON.parse(JSON.stringify(e.data));
            data.login.password = c.password;
            await this.b.account.vault.save(this.b.account.acc, { id: c.itemId, data, baseRevision: e.vi.revision });
          } else if (d.decision === 'save') {
            // saved automatically: bound to the exact host it was captured on (§8.3)
            const data = newLoginItem({ name: siteName(c.origin), url: c.origin, username: c.username, password: c.password, match: 'host' });
            await this.b.account.vault.save(this.b.account.acc, { data });
          }
          await this.refreshTab(tab);
          return { ok: true };
        }
        default:
          return { ok: false, error: { message: `unknown action ${kind}:${action}` } };
      }
    } catch (e) {
      return { ok: false, error: { code: e.code || 'error', message: e.message === 'other_host' ? 'other_host' : e.message } };
    }
  }

  async shellCommand() {
    return null;
  }
}

/** Copy a secret and clear the clipboard after 30 s if it still holds it. */
export function copySecret(text) {
  clipboard.writeText(text);
  setTimeout(() => {
    if (clipboard.readText() === text) clipboard.writeText('');
  }, 30000).unref();
}
