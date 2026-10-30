// Built-in content blocker (uBlock Origin–style), registered with Browser.registerFeature:
//
//   * network filtering for every browsing session (default and private) through the session's
//     WebRequestHub — block, strip tracking parameters, add CSP;
//   * cosmetic filtering + scriptlets: the tab preload (src/preload/features/blocker.js) asks over
//     IPC for its frame's rules; the site is always taken from the sending frame;
//   * the toolbar shield (badge = requests blocked on the page), its popup (per-site switch, what was
//     blocked, element picker) and the "Content blocking" section of ludworks://settings;
//   * filter lists downloaded at runtime (lists.js), compiled in a worker (compile-worker.js) and
//     cached in <profile>/blocker/engine.bin so a normal start only deserialises the cache.
//
// Never filtered: ludworks://, lwshell://, devtools and every other non-web scheme, requests that do
// not come from a tab (the browser's own fetches), and the user's Ludworks server.

import { app, ipcMain, webContents as allWebContents } from 'electron';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { readFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import v8 from 'node:v8';
import { createHash } from 'node:crypto';
import { log } from '../util/log.js';
import { TYPE, TYPE_NAMES, RESOURCE_TYPES, DOC, normalizeHostname, parseCosmeticFilter } from './filters.js';
import { Engine, ENGINE_VERSION, compile, requestContext, matchRequest, stripParams, cspFor, docFlags, cosmeticFor, genericSelectors, hideCss, urlHost, hostInfo } from './engine.js';
import { CATALOG, ListStore } from './lists.js';

const SETTINGS_KEY = 'blocker';
const STATS_KEY = 'blocker_stats';
const MAX_CUSTOM = 512 * 1024;
const UPDATE_CHECK_EVERY = 3600 * 1000;
const FIRST_UPDATE_DELAY = 20 * 1000;
const GENERIC_KEY_RE = /^[.#][A-Za-z_-][\w-]{0,80}$/;

const isWeb = (url) => /^https?:/i.test(url || '');
const typeNames = (mask) => Object.entries(TYPE_NAMES).filter(([bit]) => mask & Number(bit)).map(([, n]) => n);

export class Blocker {
  /** @param {import('../browser.js').Browser} browser */
  constructor(browser) {
    this.b = browser;
    this.name = 'blocker';
    this.popups = ['blocker'];
    this.pagePrefix = 'blocker.';
    this.pages = ['settings'];
    this.dir = path.join(browser.profileDir, 'blocker');
    mkdirSync(this.dir, { recursive: true });
    this.cacheFile = path.join(this.dir, 'engine.bin');
    const s = browser.db.getMeta(SETTINGS_KEY, null) || {};
    this.settings = {
      enabled: s.enabled !== false,
      lists: s.lists && typeof s.lists === 'object' ? { ...s.lists } : {},
      allow: Array.isArray(s.allow) ? s.allow.map(normalizeHostname).filter(Boolean) : [],
      custom: typeof s.custom === 'string' ? s.custom.slice(0, MAX_CUSTOM) : '',
    };
    this.allowSet = new Set(this.settings.allow);
    const st = browser.db.getMeta(STATS_KEY, null) || {};
    this.stats = { total: Number(st.total) || 0, since: Number(st.since) || Date.now() };
    if (!st.since) browser.db.setMeta(STATS_KEY, this.stats);
    this.statsDirty = false;
    this.store = new ListStore({ dir: this.dir, fetch: (u, init) => browser.session.fetch(u, init), log });
    this.listEngine = null;
    this.engineSig = null;
    this.userEngine = null;
    this.userCounts = { network: 0, cosmetic: 0, unsupported: 0 };
    this.engines = [];
    this.pageStats = new Map(); // webContents id → state of the page shown in it
    this.frameCache = new Map(); // `${host}|${flags}` → cosmeticFor() result
    this.picking = new Set(); // webContents ids with an element picker open
    this.dirty = new Set();
    this.refreshTimer = null;
    this.status = { compiling: false, updating: false, lastCompileMs: null, loadMs: null };
    this.compileUser();
    this.registerIpc();
    app.on('web-contents-created', (_e, wc) => this.watch(wc));
    app.on('before-quit', () => this.flushStats());
    setInterval(() => this.flushStats(), 60 * 1000).unref();
    // ready: the cached engine is in place (or there is none); a full compile, when needed, runs after.
    this.ready = this.loadCache().catch((e) => log.warn('content blocker: start failed', { message: e && e.message }));
    this.ready
      .then(() => (this.listEngine ? null : this.recompile()))
      .finally(() => this.scheduleUpdates());
  }

  /** Resolves when the cached filters are loaded, or after `ms` at the latest (the browser waits for
   *  this before opening windows, so restored tabs are filtered from their first request). */
  whenReady(ms) {
    return Promise.race([this.ready, new Promise((r) => setTimeout(r, ms))]);
  }

  // =============================================================================== settings
  saveSettings() {
    this.settings.allow = [...this.allowSet].sort();
    this.b.db.setMeta(SETTINGS_KEY, this.settings);
  }

  flushStats() {
    if (!this.statsDirty) return;
    this.statsDirty = false;
    try {
      this.b.db.setMeta(STATS_KEY, this.stats);
    } catch {
      /* profile closing */
    }
  }

  isListOn(c) {
    return Object.hasOwn(this.settings.lists, c.id) ? !!this.settings.lists[c.id] : c.on;
  }

  enabledLists() {
    return CATALOG.filter((c) => this.isListOn(c));
  }

  serverHost() {
    let u = null;
    try {
      u = this.b.account && this.b.account.serverUrl ? this.b.account.serverUrl() : null;
    } catch {
      u = null;
    }
    if (u !== this._serverUrl) {
      this._serverUrl = u;
      try {
        this._serverHost = u ? new URL(u).hostname.toLowerCase() : null;
      } catch {
        this._serverHost = null;
      }
    }
    return this._serverHost;
  }

  /** Is blocking switched off for this host by the user (allowlist, suffix match)? */
  isAllowed(host) {
    if (!host || !this.allowSet.size) return false;
    for (const s of hostInfo(host).suffixes) if (this.allowSet.has(s)) return true;
    return false;
  }

  siteOn(host) {
    return this.settings.enabled && !!host && !this.isAllowed(host) && host !== this.serverHost();
  }

  setEnabled(on) {
    if (this.settings.enabled === on) return;
    this.settings.enabled = on;
    this.saveSettings();
    this.b.refreshToolbar();
    this.notifyPages();
  }

  /** Per-site switch from the popup: off = add the site to the allowlist. */
  setSiteBlocking(host, on) {
    const h = normalizeHostname(host);
    if (!h) return;
    if (on) {
      for (const s of hostInfo(h).suffixes) this.allowSet.delete(s);
    } else this.allowSet.add(h.replace(/^www\./, ''));
    this.saveSettings();
    this.b.refreshToolbar();
    this.notifyPages();
  }

  setAllowlist(text) {
    this.allowSet = new Set(
      String(text || '')
        .split(/[\s,]+/)
        .map((x) => normalizeHostname(x.replace(/^\*\./, '').replace(/^https?:\/\//, '').replace(/[/:].*$/, '')))
        .filter(Boolean)
        .slice(0, 5000),
    );
    this.saveSettings();
    this.b.refreshToolbar();
  }

  setCustom(text) {
    const before = this.userBadfilters().join('\n');
    this.settings.custom = String(text || '').replace(/\r\n?/g, '\n').slice(0, MAX_CUSTOM);
    this.saveSettings();
    this.compileUser();
    if (this.userBadfilters().join('\n') !== before) this.recompile();
  }

  userBadfilters() {
    return this.settings.custom
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('!') && /[$,]badfilter(,|$)/.test(l));
  }

  setList(id, on) {
    const c = CATALOG.find((x) => x.id === id);
    if (!c) throw new Error('unknown filter list');
    if (on === c.on) delete this.settings.lists[id];
    else this.settings.lists[id] = on;
    this.saveSettings();
    clearTimeout(this.listTimer);
    this.listTimer = setTimeout(() => {
      if (on && !this.store.has(id)) this.updateLists();
      else this.recompile();
    }, 400);
  }

  // ================================================================================ engines
  compileUser() {
    const text = this.settings.custom;
    this.userEngine = null;
    this.userCounts = { network: 0, cosmetic: 0, unsupported: 0 };
    if (text.trim()) {
      try {
        const c = compile([{ id: 'user', text }]);
        this.userEngine = new Engine(c);
        this.userCounts = c.stats.user || this.userCounts;
      } catch (e) {
        log.warn('content blocker: my filters failed to compile', { message: e.message });
      }
    }
    this.rebuildEngines();
  }

  rebuildEngines() {
    this.engines = [this.listEngine, this.userEngine].filter(Boolean);
    this.frameCache.clear();
    if (this.b.windows) this.b.refreshToolbar();
  }

  signature() {
    const parts = [ENGINE_VERSION, ...this.enabledLists().filter((c) => this.store.has(c.id)).map((c) => `${c.id}:${(this.store.meta[c.id] && this.store.meta[c.id].sha) || '?'}`), ...this.userBadfilters()];
    return createHash('sha256').update(parts.join('\n')).digest('hex');
  }

  async loadCache() {
    const sig = this.signature();
    try {
      const buf = await readFile(this.cacheFile);
      const t0 = performance.now();
      const o = v8.deserialize(buf);
      if (o && o.signature === sig && o.compiled && o.compiled.version === ENGINE_VERSION) {
        this.listEngine = new Engine(o.compiled);
        this.engineSig = sig;
        this.status.loadMs = Math.round(performance.now() - t0);
        this.rebuildEngines();
        log.info('content blocker: filters loaded from cache', { ms: this.status.loadMs, network: o.compiled.counts.network, cosmetic: o.compiled.counts.cosmetic });
      }
    } catch {
      /* no or outdated cache: compiled after start (see constructor) */
    }
  }

  scheduleUpdates() {
    setTimeout(() => this.updateLists(), this.listEngine ? FIRST_UPDATE_DELAY : 1000).unref();
    setInterval(() => this.updateLists(), UPDATE_CHECK_EVERY).unref();
  }

  /** Check stale (with force: all) enabled lists — conditional requests, so unchanged lists cost a 304 — and recompile when something changed. */
  updateLists({ force = false } = {}) {
    if (this.updating) return this.updating;
    this.status.updating = true;
    this.notifyPages();
    this.updating = (async () => {
      const todo = this.enabledLists().filter((c) => force || this.store.stale(c.id));
      let changed = false;
      for (let i = 0; i < todo.length; i += 4) {
        const res = await Promise.all(todo.slice(i, i + 4).map((c) => this.store.update(c).catch(() => false)));
        if (res.some(Boolean)) changed = true;
      }
      if (changed || this.signature() !== this.engineSig) await this.recompile();
    })()
      .catch((e) => log.warn('content blocker: update failed', { message: e && e.message }))
      .finally(() => {
        this.updating = null;
        this.status.updating = false;
        this.notifyPages();
      });
    return this.updating;
  }

  /** Compile the enabled, downloaded lists in a worker and swap the engine in. */
  recompile() {
    if (this.compiling) {
      this.recompileAgain = true;
      return this.compiling;
    }
    const sig = this.signature();
    const files = this.enabledLists()
      .filter((c) => this.store.has(c.id))
      .map((c) => ({ id: c.id, file: this.store.file(c.id) }));
    if (!files.length) {
      this.listEngine = null;
      this.engineSig = sig;
      this.rebuildEngines();
      return Promise.resolve();
    }
    this.status.compiling = true;
    this.notifyPages();
    this.compiling = new Promise((resolve) => {
      let w;
      try {
        w = new Worker(new URL('./compile-worker.js', import.meta.url), { workerData: { files, badfilters: this.userBadfilters(), cacheFile: this.cacheFile, signature: sig } });
      } catch (e) {
        log.warn('content blocker: cannot start the compiler', { message: e.message });
        resolve();
        return;
      }
      w.once('message', (m) => {
        if (m && m.ok) {
          const t0 = performance.now();
          this.listEngine = new Engine(m.compiled);
          this.engineSig = sig;
          this.status.lastCompileMs = m.ms;
          this.rebuildEngines();
          log.info('content blocker: filters compiled', { lists: files.length, ms: m.ms, swapMs: Math.round(performance.now() - t0), network: m.compiled.counts.network, cosmetic: m.compiled.counts.cosmetic });
        } else log.warn('content blocker: compile failed', { message: m && m.error });
        resolve();
      });
      w.once('error', (e) => {
        log.warn('content blocker: compiler crashed', { message: e && e.message });
        resolve();
      });
      w.once('exit', () => resolve());
    }).finally(() => {
      this.compiling = null;
      this.status.compiling = false;
      this.notifyPages();
      if (this.recompileAgain) {
        this.recompileAgain = false;
        this.recompile();
      }
    });
    return this.compiling;
  }

  filterCounts() {
    const l = this.listEngine ? this.listEngine.counts : { network: 0, cosmetic: 0 };
    return { network: l.network + this.userCounts.network, cosmetic: l.cosmetic + this.userCounts.cosmetic };
  }

  // ============================================================================ page state
  watch(wc) {
    const id = wc.id;
    wc.on('did-navigate', (_e, url) => this.onCommit(id, url));
    wc.once('destroyed', () => {
      this.pageStats.delete(id);
      this.picking.delete(id);
    });
  }

  /** A main-frame navigation committed. Ones we saw as a request keep their counters. */
  onCommit(id, url) {
    const p = this.pageStats.get(id);
    if (p && p.pending) {
      p.pending = null;
      p.url = url;
      return;
    }
    this.newPage(id, url);
    this.markDirty(id);
  }

  newPage(id, url) {
    const host = isWeb(url) ? urlHost(url).host : '';
    const p = { id, url, host, blocked: 0, domains: new Map(), cosmetic: { hide: 0, generic: 0, scriptlets: 0, procedural: 0, hidden: 0 }, cosmeticSeen: new Set(), genericSeen: new Set(), flags: 0, active: this.siteOn(host), pending: null, mainBlocked: false };
    if (p.active && this.engines.length) {
      p.flags = docFlags(this.engines, url);
      if (p.flags & DOC.DOCUMENT) p.active = false;
    }
    this.pageStats.set(id, p);
    return p;
  }

  pageFor(wcId, d) {
    let wc = d && d.webContents;
    if (!wc) wc = allWebContents.fromId(wcId);
    if (!wc || wc.isDestroyed()) return null;
    return this.newPage(wcId, wc.getURL());
  }

  /** URL (origin) of the document that made a request. */
  docUrlOf(d, type, page) {
    try {
      const f = d.frame;
      const fr = f ? (type === TYPE.SUBDOCUMENT ? f.parent : f) : null;
      if (fr) {
        const o = fr.origin;
        if (o && o !== 'null' && isWeb(o)) return o;
        const u = fr.url;
        if (isWeb(u)) return u;
      }
    } catch {
      /* frame gone */
    }
    return page.url;
  }

  // ======================================================================= network hooks
  attachSession(ses, hub) {
    hub.onBeforeRequest((d) => this.onRequest(d));
    hub.onHeadersReceived((d, headers) => this.onHeaders(d, headers));
  }

  onRequest(d) {
    if (!this.settings.enabled || !this.engines.length) return null;
    const url = d.url;
    if (!url.startsWith('http') && !url.startsWith('ws')) return null;
    const wcId = d.webContentsId;
    if (wcId === undefined || wcId === null) return null; // the browser's own requests
    const type = RESOURCE_TYPES[d.resourceType] || TYPE.OTHER;
    let page;
    if (type === TYPE.DOCUMENT) {
      page = this.newPage(wcId, url);
      page.pending = url;
      this.markDirty(wcId);
    } else page = this.pageStats.get(wcId) || this.pageFor(wcId, d);
    if (!page || !page.active) return null;
    const ctx = requestContext(url, type, type === TYPE.DOCUMENT ? url : this.docUrlOf(d, type, page), d.method);
    const server = this.serverHost();
    if (server && ctx.host === server) return null;
    const v = matchRequest(this.engines, ctx);
    if (v && v.block) {
      this.record(page, ctx, v);
      return { cancel: true };
    }
    if (!v && url.includes('?')) {
      const stripped = stripParams(this.engines, ctx);
      if (stripped && stripped !== url) return { redirectURL: stripped };
    }
    return null;
  }

  onHeaders(d, headers) {
    if (!this.settings.enabled || !this.engines.length) return null;
    const type = RESOURCE_TYPES[d.resourceType];
    if ((type !== TYPE.DOCUMENT && type !== TYPE.SUBDOCUMENT) || !isWeb(d.url) || d.webContentsId == null) return null;
    const page = this.pageStats.get(d.webContentsId);
    if (!page || !page.active) return null;
    const ctx = requestContext(d.url, type, type === TYPE.DOCUMENT ? d.url : this.docUrlOf(d, type, page), d.method);
    const list = cspFor(this.engines, ctx);
    if (!list.length) return null;
    const key = Object.keys(headers).find((k) => k.toLowerCase() === 'content-security-policy') || 'Content-Security-Policy';
    headers[key] = [...(headers[key] || []), ...list];
    return { changed: true };
  }

  record(page, ctx, v) {
    page.blocked++;
    this.stats.total++;
    this.statsDirty = true;
    if (ctx.type === TYPE.DOCUMENT) page.mainBlocked = true;
    const dom = ctx.hinfo.domain || ctx.host;
    let e = page.domains.get(dom);
    if (!e && page.domains.size < 500) {
      e = { count: 0, types: 0, hosts: new Set(), filter: v.filter };
      page.domains.set(dom, e);
    }
    if (e) {
      e.count++;
      e.types |= ctx.type;
      if (e.hosts.size < 8) e.hosts.add(ctx.host);
    }
    this.markDirty(page.id);
  }

  /** Coalesced toolbar/popup refresh for pages whose counters changed. */
  markDirty(id) {
    this.dirty.add(id);
    if (!this.refreshTimer) this.refreshTimer = setTimeout(() => this.refreshNow(), 250);
  }

  refreshNow() {
    this.refreshTimer = null;
    const ids = this.dirty;
    this.dirty = new Set();
    for (const ctl of this.b.windows) {
      if (ctl.destroyed) continue;
      const t = ctl.activeTab();
      if (!t || t.wc.isDestroyed() || !ids.has(t.wc.id)) continue;
      this.b.refreshToolbar(ctl);
      if (ctl.popup && ctl.popup.kind === 'blocker' && ctl.overlay) ctl.overlay.webContents.send('popup-data', { kind: 'blocker', data: this.popupData(ctl) });
    }
  }

  // ================================================================= cosmetic (preload IPC)
  registerIpc() {
    ipcMain.on('blocker:frame', (e) => {
      try {
        e.returnValue = this.frameRules(e);
      } catch (x) {
        log.warn('content blocker: frame rules failed', { message: x.message });
        e.returnValue = null;
      }
    });
    ipcMain.handle('blocker:generic', (e, keys) => this.genericCss(e, keys));
    ipcMain.handle('blocker:pick', (e, a) => this.pickCreate(e, a));
    ipcMain.on('blocker:hidden', (e, a) => {
      const fi = this.frameInfo(e);
      const p = fi && this.pageStats.get(fi.wc.id);
      if (p && a && Number.isFinite(a.procedural)) {
        p.cosmetic.hidden = Math.max(p.cosmetic.hidden, Math.min(100000, a.procedural));
        this.markDirty(p.id);
      }
    });
  }

  /** The tab, frame and site of an IPC message from the content preload (never trusted from the page). */
  frameInfo(e) {
    const wc = e.sender;
    const frame = e.senderFrame;
    if (!frame || !wc || wc.isDestroyed() || !this.b.tabForWebContents(wc)) return null;
    let url = '';
    let host = '';
    try {
      url = frame.url || '';
      host = isWeb(url) ? urlHost(url).host : '';
      if (!host && isWeb(frame.origin)) {
        url = frame.origin;
        host = urlHost(url).host;
      }
    } catch {
      return null;
    }
    if (!host) return null;
    return { wc, frame, url, host, top: frame === wc.mainFrame };
  }

  framePage(fi) {
    let p = this.pageStats.get(fi.wc.id);
    if (!p) p = this.newPage(fi.wc.id, fi.wc.getURL());
    return p;
  }

  frameFlags(fi, page) {
    return fi.top ? page.flags : docFlags(this.engines, fi.url);
  }

  cosmetic(host, flags) {
    const key = `${host}|${flags}`;
    let r = this.frameCache.get(key);
    if (!r) {
      r = cosmeticFor(this.engines, host, flags);
      if (this.frameCache.size > 400) this.frameCache.clear();
      this.frameCache.set(key, r);
    }
    return r;
  }

  frameRules(e) {
    if (!this.settings.enabled || !this.engines.length) return null;
    const fi = this.frameInfo(e);
    if (!fi) return null;
    const page = this.framePage(fi);
    if (!page.active || this.isAllowed(fi.host)) return null;
    const flags = this.frameFlags(fi, page);
    const r = this.cosmetic(fi.host, flags);
    // counted once per site of the page's frames (many frames of one site share the same rules)
    const key = `${fi.host}|${flags}`;
    if (!page.cosmeticSeen.has(key)) {
      page.cosmeticSeen.add(key);
      page.cosmetic.hide += r.hide;
      page.cosmetic.scriptlets += r.scriptlets.length;
      page.cosmetic.procedural += r.procedural.length;
      if (r.hide || r.scriptlets.length) this.markDirty(page.id);
    }
    return { css: r.css, scriptlets: r.scriptlets, procedural: r.procedural, generic: r.generic };
  }

  genericCss(e, keys) {
    if (!this.settings.enabled || !this.engines.length || !Array.isArray(keys)) return '';
    const fi = this.frameInfo(e);
    if (!fi) return '';
    const page = this.pageStats.get(fi.wc.id);
    if (!page || !page.active) return '';
    const r = this.cosmetic(fi.host, this.frameFlags(fi, page));
    if (!r.generic) return '';
    const list = keys.filter((k) => typeof k === 'string' && GENERIC_KEY_RE.test(k)).slice(0, 5000);
    const sels = genericSelectors(this.engines, list, r.exceptions);
    if (!sels.length) return '';
    let fresh = 0;
    for (const s of sels) {
      if (page.genericSeen.size < 5000 && !page.genericSeen.has(s)) {
        page.genericSeen.add(s);
        fresh++;
      }
    }
    if (fresh) {
      page.cosmetic.generic += fresh;
      this.markDirty(page.id);
    }
    return hideCss(sels);
  }

  /** The element picker saved a selector: add `site##selector` to My filters. */
  pickCreate(e, a) {
    const fi = this.frameInfo(e);
    if (!fi || !fi.top || !this.picking.has(fi.wc.id)) return { ok: false };
    const sel = String((a && a.selector) || '').trim();
    if (!sel || sel.length > 1000 || /[{}\r\n]/.test(sel) || sel.includes('/*')) return { ok: false };
    const line = `${fi.host.replace(/^www\./, '')}##${sel}`;
    const parsed = parseCosmeticFilter(line);
    if (!parsed || parsed.kind !== 'hide') return { ok: false };
    this.picking.delete(fi.wc.id);
    const cur = this.settings.custom.replace(/\s+$/, '');
    this.setCustom(`${cur ? `${cur}\n` : ''}${line}\n`);
    this.notifyPages();
    return { ok: true, css: hideCss([sel]) };
  }

  // ========================================================================= toolbar + popup
  toolbarButtons(ctl, tab) {
    if (!tab || tab.wc.isDestroyed()) return [];
    const url = tab.wc.getURL();
    const web = isWeb(url);
    const host = web ? urlHost(url).host : '';
    const on = web && this.siteOn(host);
    const p = this.pageStats.get(tab.wc.id);
    const n = on && p && p.active ? p.blocked : 0;
    const title = !this.settings.enabled ? 'Content blocker is off' : !web ? 'Content blocker' : on ? `Content blocker: ${n} blocked on this page` : `Content blocker is off for ${host}`;
    return [{ id: 'blocker', order: 10, icon: 'shield', title, badge: n ? (n > 999 ? '999+' : n) : null, tone: on ? undefined : 'muted', pressed: on, popup: { kind: 'blocker', width: 340 } }];
  }

  popupData(ctl) {
    const tab = ctl.activeTab();
    const url = tab && !tab.wc.isDestroyed() ? tab.wc.getURL() : '';
    const web = isWeb(url);
    const host = web ? urlHost(url).host : '';
    const p = tab ? this.pageStats.get(tab.wc.id) : null;
    const siteOn = web && this.siteOn(host);
    const domains = p
      ? [...p.domains]
          .sort((a, b) => b[1].count - a[1].count)
          .slice(0, 100)
          .map(([domain, e]) => ({ domain, count: e.count, types: typeNames(e.types), hosts: [...e.hosts] }))
      : [];
    return {
      host,
      web,
      enabled: this.settings.enabled,
      siteOn,
      canToggle: web && !!host && host !== this.serverHost(),
      isServer: !!host && host === this.serverHost(),
      needsReload: !!(web && p && p.host === host && p.active !== siteOn),
      blocked: p && p.active ? p.blocked : 0,
      mainBlocked: !!(p && p.mainBlocked),
      domains,
      cosmetic: p && p.active ? { ...p.cosmetic } : null,
      total: this.stats.total,
      since: this.stats.since,
      ready: this.engines.length > 0,
      busy: this.status.compiling || this.status.updating,
      filters: this.filterCounts(),
    };
  }

  openPopup(ctl, kind, anchor) {
    return ctl.showPopup('blocker', this.popupData(ctl), { ...anchor, width: 340 });
  }

  popupAction(ctl, kind, action, d) {
    const tab = ctl.activeTab();
    const url = tab ? tab.wc.getURL() : '';
    switch (action) {
      case 'site':
        if (isWeb(url)) this.setSiteBlocking(urlHost(url).host, !!d.on);
        return this.popupData(ctl);
      case 'enabled':
        this.setEnabled(!!d.on);
        return this.popupData(ctl);
      case 'reload':
        ctl.hidePopup('blocker');
        if (tab) tab.reload();
        return null;
      case 'settings': {
        ctl.hidePopup('blocker');
        const t = this.b.openInternal(ctl, 'settings');
        if (t) t.wc.executeJavaScript("location.hash = '#blocker'", true).catch(() => {});
        return null;
      }
      case 'pick':
        ctl.hidePopup('blocker');
        if (tab && isWeb(url)) {
          this.picking.add(tab.wc.id);
          tab.wc.focus();
          tab.wc.send('blocker:pick');
        }
        return null;
      default:
        throw new Error(`unknown action ${action}`);
    }
  }

  // ============================================================================ settings page
  state() {
    const counts = this.listEngine ? this.listEngine.stats : {};
    return {
      enabled: this.settings.enabled,
      ready: this.engines.length > 0,
      compiling: this.status.compiling,
      updating: this.status.updating,
      total: this.stats.total,
      since: this.stats.since,
      filters: this.filterCounts(),
      lists: CATALOG.map((c) => {
        const m = this.store.meta[c.id] || {};
        const st = counts[c.id];
        return {
          id: c.id,
          title: c.title,
          group: c.group,
          on: this.isListOn(c),
          entries: st ? st.network + st.cosmetic : null,
          downloaded: this.store.has(c.id),
          updatedAt: m.updatedAt || null,
          checkedAt: m.checkedAt || null,
          error: m.error || null,
          url: m.url || c.urls[0],
        };
      }),
      custom: this.settings.custom,
      customCounts: this.userCounts,
      allow: [...this.allowSet].sort(),
    };
  }

  notifyPages() {
    clearTimeout(this.notifyTimer);
    this.notifyTimer = setTimeout(() => {
      for (const t of this.b.allTabs()) {
        if (!t.wc.isDestroyed() && t.wc.getURL().startsWith('ludworks://settings')) t.wc.send('page-event', { type: 'blocker' });
      }
    }, 100);
  }

  async pageCommand(tab, cmd, a) {
    switch (cmd) {
      case 'blocker.state':
        return this.state();
      case 'blocker.enabled':
        this.setEnabled(!!a.on);
        return this.state();
      case 'blocker.list':
        this.setList(String(a.id || ''), !!a.on);
        return this.state();
      case 'blocker.update':
        this.updateLists({ force: true });
        return { ...this.state(), updating: true };
      case 'blocker.custom':
        this.setCustom(String(a.text || ''));
        return this.state();
      case 'blocker.allowlist':
        this.setAllowlist(String(a.text || ''));
        return this.state();
      case 'blocker.reset-stats':
        this.stats = { total: 0, since: Date.now() };
        this.statsDirty = true;
        this.flushStats();
        return this.state();
      default:
        throw new Error(`unknown command ${cmd}`);
    }
  }
}
