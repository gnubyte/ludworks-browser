// Privacy toolbar features (Browser.registerFeature):
//
// * Tracking cookies — watches third-party requests that send or set cookies. A third-party site whose
//   cookies have been seen under two or more different first-party sites is "following you"; the cookie
//   button shows how many of those are on the current page, lists them with the sites they were seen
//   on, and wipes their cookies. Optionally strips all third-party cookies.
// * Clear history — one click to delete the last hour / 24 h / 48 h / 72 h / 7 days / all browsing
//   history (deletions sync like any other), with optional downloads list, cache, cookies.
//
// Sightings of normal windows are kept in the profile database (privacy_trackers); private windows are
// tracked in memory only and never written.
import { registrableDomain } from '../../lib/url-match.js';
import { log } from '../util/log.js';

const FOLLOW_SITES = 2; // seen under this many first-party sites → following you
const MAX_TRACKERS = 5000;
const MAX_SITES_PER_TRACKER = 500;
export const RANGES = {
  '1h': { label: 'Last hour', ms: 3600e3 },
  '24h': { label: 'Last 24 hours', ms: 24 * 3600e3 },
  '48h': { label: 'Last 48 hours', ms: 48 * 3600e3 },
  '72h': { label: 'Last 72 hours', ms: 72 * 3600e3 },
  '7d': { label: 'Last 7 days', ms: 7 * 24 * 3600e3 },
  all: { label: 'All time', ms: Infinity },
};

/** First-party site (registrable domain) of an http(s) URL, or '' for anything else. */
export function siteOf(url) {
  if (typeof url !== 'string' || !/^https?:/i.test(url)) return '';
  try {
    return registrableDomain(new URL(url).hostname);
  } catch {
    return '';
  }
}

function headerValue(headers, name) {
  for (const k of Object.keys(headers || {})) if (k.toLowerCase() === name) return headers[k];
  return undefined;
}

function deleteHeader(headers, name) {
  let found = false;
  for (const k of Object.keys(headers || {})) {
    if (k.toLowerCase() === name) {
      delete headers[k];
      found = true;
    }
  }
  return found;
}

/**
 * Which sites follow you: tracker → Set(first-party site). Pure bookkeeping, exported for tests.
 */
export class TrackerLedger {
  constructor() {
    this.sites = new Map(); // tracker → Set(site)
  }

  /** Records a sighting; returns true when the pair is new. */
  add(tracker, site) {
    let s = this.sites.get(tracker);
    if (!s) {
      if (this.sites.size >= MAX_TRACKERS) return false;
      s = new Set();
      this.sites.set(tracker, s);
    }
    if (s.has(site) || s.size >= MAX_SITES_PER_TRACKER) return false;
    s.add(site);
    return true;
  }

  count(tracker) {
    const s = this.sites.get(tracker);
    return s ? s.size : 0;
  }

  following(tracker) {
    return this.count(tracker) >= FOLLOW_SITES;
  }

  /** Trackers seen under at least FOLLOW_SITES sites, most widespread first. */
  allFollowing() {
    return [...this.sites.entries()].filter(([, s]) => s.size >= FOLLOW_SITES).sort((a, b) => b[1].size - a[1].size).map(([t]) => t);
  }

  forget(tracker) {
    this.sites.delete(tracker);
  }
}

/**
 * Per page (webContents) state: which third parties used cookies on the page that is shown now.
 * Keyed by webContents id; a main-frame navigation starts a new page.
 */
class PageTrackers {
  constructor(site) {
    this.site = site;
    this.trackers = new Map(); // tracker → {sent, set, blocked}
  }

  note(tracker, kind) {
    let t = this.trackers.get(tracker);
    if (!t) {
      t = { sent: 0, set: 0, blocked: 0 };
      this.trackers.set(tracker, t);
    }
    t[kind]++;
  }
}

export class Privacy {
  /** @param {import('../browser.js').Browser} browser */
  constructor(browser) {
    this.b = browser;
    this.name = 'privacy';
    this.popups = ['trackers', 'clear-history'];
    this.pagePrefix = 'privacy.';
    this.pages = ['settings'];
    this.ledger = new TrackerLedger(); // normal windows (persisted)
    this.privateLedger = new TrackerLedger(); // private windows (memory only)
    this.pageStates = new Map(); // webContents id → PageTrackers
    this.privateSessions = new WeakSet();
    this.refreshTimer = null;
    this.initDb();
  }

  initDb() {
    const db = this.b.db;
    db.db.exec(`CREATE TABLE IF NOT EXISTS privacy_trackers (
      tracker   TEXT NOT NULL,
      site      TEXT NOT NULL,
      last_seen INTEGER NOT NULL,
      PRIMARY KEY (tracker, site)
    ) STRICT`);
    for (const r of db.all('SELECT tracker, site FROM privacy_trackers ORDER BY last_seen DESC LIMIT 200000')) this.ledger.add(r.tracker, r.site);
  }

  // ------------------------------------------------------------------------------- network hooks
  attachSession(ses, hub, { isPrivate }) {
    if (isPrivate) this.privateSessions.add(ses);
    const ledger = isPrivate ? this.privateLedger : this.ledger;
    hub.onBeforeRequest((d) => {
      if (d.resourceType === 'mainFrame' && d.webContentsId) this.pageStates.set(d.webContentsId, new PageTrackers(siteOf(d.url)));
    });
    hub.onBeforeSendHeaders((d, headers) => {
      const ctx = this.thirdParty(d);
      if (!ctx || !headerValue(headers, 'cookie')) return;
      if (this.b.prefs.get('blockThirdPartyCookies')) {
        deleteHeader(headers, 'cookie');
        ctx.page.note(ctx.tracker, 'blocked');
      } else ctx.page.note(ctx.tracker, 'sent');
      this.sighting(ledger, ctx, isPrivate);
    });
    hub.onHeadersReceived((d, headers) => {
      const ctx = this.thirdParty(d);
      if (!ctx || !headerValue(headers, 'set-cookie')) return null;
      this.sighting(ledger, ctx, isPrivate);
      if (this.b.prefs.get('blockThirdPartyCookies')) {
        deleteHeader(headers, 'set-cookie');
        ctx.page.note(ctx.tracker, 'blocked');
        return { changed: true };
      }
      ctx.page.note(ctx.tracker, 'set');
      return null;
    });
  }

  /** {page, tracker, site} for a third-party subresource request of a tab, else null. */
  thirdParty(d) {
    if (!d.webContentsId || d.resourceType === 'mainFrame') return null;
    const page = this.pageStates.get(d.webContentsId);
    if (!page || !page.site) return null;
    const tracker = siteOf(d.url);
    if (!tracker || tracker === page.site) return null;
    return { page, tracker, site: page.site, wcId: d.webContentsId };
  }

  sighting(ledger, ctx, isPrivate) {
    const fresh = ledger.add(ctx.tracker, ctx.site);
    if (fresh && !isPrivate) {
      try {
        this.b.db.run('INSERT INTO privacy_trackers (tracker, site, last_seen) VALUES (?, ?, ?) ON CONFLICT (tracker, site) DO UPDATE SET last_seen = excluded.last_seen', ctx.tracker, ctx.site, Date.now());
      } catch (e) {
        log.debug('tracker sighting not saved', { message: e.message });
      }
    }
    this.scheduleRefresh();
  }

  /** Coalesces toolbar updates (requests arrive by the hundred while a page loads). */
  scheduleRefresh() {
    if (this.refreshTimer) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      this.b.refreshToolbar();
    }, 400);
  }

  // ------------------------------------------------------------------------------------ toolbar
  ledgerFor(ctl) {
    return ctl && ctl.private ? this.privateLedger : this.ledger;
  }

  pageFor(tab) {
    if (!tab || tab.wc.isDestroyed()) return null;
    const page = this.pageStates.get(tab.wc.id);
    return page && page.site === siteOf(tab.wc.getURL()) ? page : null;
  }

  toolbarButtons(ctl, tab) {
    const out = [];
    const prefs = this.b.prefs;
    if (prefs.get('trackerButton')) {
      const page = this.pageFor(tab);
      const ledger = this.ledgerFor(ctl);
      const all = page ? [...page.trackers.keys()] : [];
      const following = all.filter((t) => ledger.following(t));
      const blocking = prefs.get('blockThirdPartyCookies');
      out.push({
        id: 'trackers',
        order: 20,
        icon: 'cookie',
        badge: following.length || null,
        tone: following.length ? (blocking ? 'muted' : 'warn') : 'muted',
        title: following.length
          ? `${following.length} cross-site tracker${following.length === 1 ? '' : 's'} on this page${blocking ? ' (cookies blocked)' : ''}`
          : all.length
            ? `${all.length} third-party site${all.length === 1 ? '' : 's'} used cookies here`
            : 'Tracking cookies',
        popup: { kind: 'trackers', width: 380 },
      });
    }
    if (prefs.get('clearHistoryButton')) out.push({ id: 'clear-history', order: 30, icon: 'eraser', title: 'Clear recent history', popup: { kind: 'clear-history', width: 320 } });
    return out;
  }

  // ------------------------------------------------------------------------------------- popups
  trackerData(ctl) {
    const tab = ctl.activeTab();
    const page = this.pageFor(tab);
    const ledger = this.ledgerFor(ctl);
    const trackers = page
      ? [...page.trackers.entries()]
          .map(([domain, t]) => ({ domain, sites: ledger.count(domain), following: ledger.following(domain), sample: [...(ledger.sites.get(domain) || [])].filter((s) => s !== page.site).slice(0, 4), ...t }))
          .sort((a, b) => b.sites - a.sites || a.domain.localeCompare(b.domain))
      : [];
    return {
      site: page ? page.site : siteOf(tab ? tab.wc.getURL() : ''),
      trackers,
      followingTotal: ledger.allFollowing().length,
      blocking: this.b.prefs.get('blockThirdPartyCookies'),
      private: !!ctl.private,
    };
  }

  openPopup(ctl, kind, anchor) {
    if (kind === 'trackers') return ctl.showPopup('trackers', this.trackerData(ctl), { ...anchor, width: 380 });
    return ctl.showPopup('clear-history', { ranges: Object.entries(RANGES).map(([id, r]) => ({ id, label: r.label })), last: this.b.db.getMeta('clear_history_last', null) }, { ...anchor, width: 320 });
  }

  sessionFor(ctl) {
    return ctl && ctl.private ? this.b.privateSession() : this.b.session;
  }

  async popupAction(ctl, kind, action, d) {
    switch (`${kind}:${action}`) {
      case 'trackers:wipe': {
        const domains = Array.isArray(d.domains) ? d.domains.map(String).slice(0, 500) : [];
        const removed = await wipeCookies(this.sessionFor(ctl), domains);
        this.forgetOnPages(domains);
        return { ...this.trackerData(ctl), wiped: { domains: domains.length, cookies: removed } };
      }
      case 'trackers:wipe-all': {
        const domains = this.ledgerFor(ctl).allFollowing();
        const removed = await wipeCookies(this.sessionFor(ctl), domains);
        this.forgetOnPages(domains);
        return { ...this.trackerData(ctl), wiped: { domains: domains.length, cookies: removed } };
      }
      case 'trackers:block':
        this.b.prefs.update({ blockThirdPartyCookies: !!d.on });
        this.b.refreshToolbar();
        return this.trackerData(ctl);
      case 'trackers:reload': {
        const tab = ctl.activeTab();
        if (tab) tab.wc.reload();
        ctl.hidePopup('trackers');
        return null;
      }
      case 'trackers:settings':
        ctl.hidePopup('trackers');
        this.b.openIn(ctl, 'ludworks://settings/#privacy', 'new-tab');
        return null;
      case 'clear-history:clear': {
        const r = await this.clearRecent(String(d.range || ''), d.what || {}, this.sessionFor(ctl));
        return r;
      }
      default:
        throw new Error(`unknown popup action ${kind}:${action}`);
    }
  }

  /**
   * Clears browsing data of the last `range` (see RANGES). History and the downloads list honour the
   * range; the cache and cookies have no time stamps Chromium lets us filter by, so they are cleared entirely.
   */
  async clearRecent(range, what, ses = this.b.session) {
    const r = RANGES[range];
    if (!r) throw new Error('unknown range');
    const now = Date.now();
    const since = r.ms === Infinity ? 0 : now - r.ms;
    const done = [];
    if (what.history !== false) {
      if (since) this.b.history.removeRange(since, now);
      else this.b.history.clearAll();
      done.push('history');
    }
    if (what.downloads) {
      this.b.downloads.clearSince(since);
      done.push('downloads');
    }
    if (what.cache) {
      await ses.clearCache();
      await ses.clearCodeCaches({});
      done.push('cache');
    }
    if (what.cookies) {
      await ses.clearStorageData({ storages: ['cookies', 'localstorage', 'indexdb', 'serviceworkers', 'cachestorage', 'websql', 'filesystem'] });
      done.push('cookies');
    }
    const last = { range, label: r.label, at: now, done };
    this.b.db.setMeta('clear_history_last', last);
    log.info('cleared browsing data', { range, done });
    return { last };
  }

  // -------------------------------------------------------------------------------- settings page
  async pageCommand(_tab, cmd, a) {
    switch (cmd) {
      case 'privacy.trackers':
        return {
          following: this.ledger.allFollowing().slice(0, 200).map((t) => ({ domain: t, sites: this.ledger.count(t) })),
          blocking: this.b.prefs.get('blockThirdPartyCookies'),
        };
      case 'privacy.wipe':
        return { removed: await wipeCookies(this.b.session, this.ledger.allFollowing()) };
      case 'privacy.forget':
        this.b.db.run('DELETE FROM privacy_trackers');
        this.ledger = new TrackerLedger();
        this.b.refreshToolbar();
        return { ok: true };
      case 'privacy.clear':
        return this.clearRecent(String(a.range || ''), a.what || {});
      default:
        throw new Error('not allowed');
    }
  }

  /** Wiped trackers leave the open pages' counts until they send or set a cookie again. */
  forgetOnPages(domains) {
    for (const page of this.pageStates.values()) for (const d of domains) page.trackers.delete(d);
    this.b.refreshToolbar();
  }

  /** Forgets the page state of web contents that no longer exist (`liveIds`: ids still alive). */
  sweep(liveIds) {
    for (const id of this.pageStates.keys()) if (!liveIds.has(id)) this.pageStates.delete(id);
  }
}

/**
 * Removes every cookie of `domains` (registrable domains, subdomains included) from a session.
 * Returns how many cookies were removed.
 * @param {Electron.Session} ses
 */
export async function wipeCookies(ses, domains) {
  let removed = 0;
  for (const domain of new Set(domains)) {
    if (!/^[a-z0-9.-]+$/i.test(domain)) continue;
    let cookies = [];
    try {
      cookies = await ses.cookies.get({ domain });
    } catch {
      cookies = [];
    }
    for (const c of cookies) {
      const host = String(c.domain || domain).replace(/^\./, '');
      try {
        await ses.cookies.remove(`${c.secure ? 'https' : 'http'}://${host}${c.path || '/'}`, c.name);
        removed++;
      } catch (e) {
        log.debug('cookie not removed', { message: e.message });
      }
    }
    // Partitioned (CHIPS) and other cookies the cookie API doesn't list.
    for (const origin of [`https://${domain}`, `http://${domain}`]) {
      await ses.clearStorageData({ origin, storages: ['cookies'] }).catch(() => {});
    }
  }
  return removed;
}

