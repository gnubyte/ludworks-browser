// Content blocker: filter list catalog and updater.
//
// Lists are never bundled: they are downloaded from their publishers (CDN mirror first, then the
// other official mirrors), stored in <profile>/blocker/lists/<id>.txt and refreshed when their
// `! Expires:` period (default 4 days) has passed — with If-None-Match / If-Modified-Since, so an
// unchanged list costs one 304.

import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

const UBO = (f) => [`https://ublockorigin.github.io/uAssetsCDN/filters/${f}`, `https://ublockorigin.pages.dev/filters/${f}`, `https://cdn.jsdelivr.net/gh/uBlockOrigin/uAssetsCDN@main/filters/${f}`];
const THIRD = (f) => [`https://ublockorigin.github.io/uAssetsCDN/thirdparties/${f}`, `https://ublockorigin.pages.dev/thirdparties/${f}`, `https://cdn.jsdelivr.net/gh/uBlockOrigin/uAssetsCDN@main/thirdparties/${f}`];

/** Available lists, in compile order (earlier lists win duplicate filters). */
export const CATALOG = Object.freeze([
  { id: 'ublock-filters', title: 'uBlock filters – Ads', group: 'Built-in', on: true, urls: UBO('filters.min.txt') },
  { id: 'ublock-badware', title: 'uBlock filters – Badware risks', group: 'Built-in', on: true, urls: UBO('badware.min.txt') },
  { id: 'ublock-privacy', title: 'uBlock filters – Privacy', group: 'Built-in', on: true, urls: UBO('privacy.min.txt') },
  { id: 'ublock-quick-fixes', title: 'uBlock filters – Quick fixes', group: 'Built-in', on: true, urls: UBO('quick-fixes.min.txt') },
  { id: 'ublock-unbreak', title: 'uBlock filters – Unbreak', group: 'Built-in', on: true, urls: UBO('unbreak.min.txt') },
  { id: 'easylist', title: 'EasyList', group: 'Ads', on: true, urls: [...THIRD('easylist.txt'), 'https://easylist.to/easylist/easylist.txt'] },
  { id: 'easyprivacy', title: 'EasyPrivacy', group: 'Privacy', on: true, urls: [...THIRD('easyprivacy.txt'), 'https://easylist.to/easylist/easyprivacy.txt'] },
  { id: 'adguard-spyware-url', title: 'AdGuard/uBO – URL tracking protection', group: 'Privacy', on: false, urls: UBO('privacy-removeparam.txt') },
  { id: 'urlhaus-1', title: 'Online Malicious URL Blocklist', group: 'Malware protection', on: true, urls: ['https://malware-filter.gitlab.io/urlhaus-filter/urlhaus-filter-vivaldi-online.txt', 'https://curbengh.github.io/malware-filter/urlhaus-filter-vivaldi-online.txt'] },
  { id: 'curben-phishing', title: 'Phishing URL Blocklist', group: 'Malware protection', on: false, urls: ['https://malware-filter.gitlab.io/phishing-filter/phishing-filter.txt', 'https://curbengh.github.io/phishing-filter/phishing-filter.txt', 'https://phishing-filter.pages.dev/phishing-filter.txt'] },
  { id: 'plowe-0', title: 'Peter Lowe’s Ad and tracking server list', group: 'Multipurpose', on: true, urls: ['https://pgl.yoyo.org/adservers/serverlist.php?hostformat=hosts&showintro=1&mimetype=plaintext'] },
  { id: 'ublock-cookies', title: 'uBlock filters – Cookie notices', group: 'Cookie notices', on: false, urls: UBO('annoyances-cookies.txt') },
  { id: 'easylist-cookies', title: 'EasyList – Cookie notices', group: 'Cookie notices', on: false, urls: [...THIRD('easylist-cookies.txt'), 'https://secure.fanboy.co.nz/fanboy-cookiemonster_ubo.txt'] },
  { id: 'ublock-annoyances', title: 'uBlock filters – Annoyances', group: 'Annoyances', on: false, urls: UBO('annoyances.min.txt') },
  { id: 'easylist-annoyances', title: 'EasyList – Other annoyances', group: 'Annoyances', on: false, urls: THIRD('easylist-annoyances.txt') },
  { id: 'easylist-social', title: 'EasyList – Social widgets', group: 'Annoyances', on: false, urls: [...THIRD('easylist-social.txt'), 'https://secure.fanboy.co.nz/fanboy-social_ubo.txt'] },
  { id: 'easylist-newsletters', title: 'EasyList – Newsletter notices', group: 'Annoyances', on: false, urls: THIRD('easylist-newsletters.txt') },
  { id: 'DEU-0', title: 'EasyList Germany', group: 'Regional', on: false, urls: ['https://easylist.to/easylistgermany/easylistgermany.txt', 'https://easylist-downloads.adblockplus.org/easylistgermany.txt'] },
  { id: 'FRA-0', title: 'AdGuard Français', group: 'Regional', on: false, urls: ['https://filters.adtidy.org/extension/ublock/filters/16.txt'] },
  { id: 'spa-0', title: 'EasyList Spanish', group: 'Regional', on: false, urls: ['https://easylist-downloads.adblockplus.org/easylistspanish.txt'] },
  { id: 'ITA-0', title: 'EasyList Italy', group: 'Regional', on: false, urls: ['https://easylist-downloads.adblockplus.org/easylistitaly.txt'] },
  { id: 'NLD-0', title: 'AdGuard Dutch', group: 'Regional', on: false, urls: ['https://filters.adtidy.org/extension/ublock/filters/8.txt'] },
  { id: 'POL-0', title: 'Polish filters for uBlock Origin', group: 'Regional', on: false, urls: ['https://raw.githubusercontent.com/MajkiIT/polish-ads-filter/master/polish-adblock-filters/adblock.txt'] },
  { id: 'RUS-0', title: 'RU AdList', group: 'Regional', on: false, urls: ['https://cdn.jsdelivr.net/gh/dimisa-RUAdList/RUAdListCDN@main/lists/ruadlist.ubo.min.txt', 'https://raw.githubusercontent.com/easylist/ruadlist/master/RuAdList-uBO.txt'] },
  { id: 'JPN-1', title: 'AdGuard Japanese', group: 'Regional', on: false, urls: ['https://filters.adtidy.org/extension/ublock/filters/7.txt'] },
  { id: 'CHN-0', title: 'AdGuard Chinese', group: 'Regional', on: false, urls: ['https://filters.adtidy.org/extension/ublock/filters/224.txt'] },
  { id: 'KOR-1', title: 'Korean filters', group: 'Regional', on: false, urls: ['https://cdn.jsdelivr.net/npm/@filteringdev/filterslists-ko@latest/dist/filterslist-uBlockOrigin-classic.txt'] },
  { id: 'IND-0', title: 'IndianList', group: 'Regional', on: false, urls: ['https://easylist-downloads.adblockplus.org/indianlist.txt'] },
]);

export const DEFAULT_EXPIRES = 4 * 86400 * 1000;
const MIN_EXPIRES = 2 * 3600 * 1000;
const MAX_EXPIRES = 14 * 86400 * 1000;
const RETRY_AFTER_ERROR = 3600 * 1000;
const MAX_LIST_BYTES = 40 * 1024 * 1024;
const FETCH_TIMEOUT = 90 * 1000;

/** `! Expires: 4 days (update frequency)` / `12 hours` → ms (clamped), default 4 days. */
export function parseExpires(text) {
  const head = text.slice(0, 4096);
  const m = /^[!#]\s*Expires\s*:\s*(\d+)\s*(day|hour|d|h)/im.exec(head);
  if (!m) return DEFAULT_EXPIRES;
  const n = Number(m[1]) * (m[2].startsWith('h') ? 3600 * 1000 : 86400 * 1000);
  return Math.min(MAX_EXPIRES, Math.max(MIN_EXPIRES, n));
}

/** `! Title:` of a list (for custom URLs). */
export function parseTitle(text) {
  const m = /^[!#]\s*Title\s*:\s*(.+)$/im.exec(text.slice(0, 4096));
  return m ? m[1].trim().slice(0, 120) : null;
}

export class ListStore {
  /**
   * @param {{dir: string, fetch: (url: string, init?: any) => Promise<Response>, log: any}} o
   */
  constructor({ dir, fetch, log }) {
    this.dir = path.join(dir, 'lists');
    this.metaFile = path.join(dir, 'lists.json');
    this.fetch = fetch;
    this.log = log;
    mkdirSync(this.dir, { recursive: true });
    try {
      this.meta = JSON.parse(readFileSync(this.metaFile, 'utf8')) || {};
    } catch {
      this.meta = {};
    }
  }

  file(id) {
    return path.join(this.dir, `${id.replace(/[^\w.-]/g, '_')}.txt`);
  }

  has(id) {
    return existsSync(this.file(id));
  }

  read(id) {
    try {
      return readFileSync(this.file(id), 'utf8');
    } catch {
      return null;
    }
  }

  save() {
    const tmp = `${this.metaFile}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.meta));
    renameSync(tmp, this.metaFile);
  }

  remove(id) {
    rmSync(this.file(id), { force: true });
    delete this.meta[id];
    this.save();
  }

  /** Does the list need a download (missing, expired, or a failed attempt that may be retried)? */
  stale(id, now = Date.now()) {
    const m = this.meta[id];
    if (!m) return true;
    const since = now - (m.checkedAt || 0);
    if (m.error) return since > (this.has(id) ? RETRY_AFTER_ERROR : RETRY_AFTER_ERROR / 4);
    if (!this.has(id)) return true;
    return since > (m.expires || DEFAULT_EXPIRES);
  }

  /**
   * Download one list. Returns true when its content changed.
   * @param {{id: string, urls: string[]}} entry
   */
  async update(entry) {
    const prev = this.meta[entry.id] || {};
    const now = Date.now();
    let lastErr = null;
    for (const url of entry.urls) {
      try {
        const headers = { Accept: 'text/plain, */*;q=0.5' };
        if (prev.url === url && this.has(entry.id)) {
          if (prev.etag) headers['If-None-Match'] = prev.etag;
          if (prev.lastModified) headers['If-Modified-Since'] = prev.lastModified;
        }
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT);
        let res;
        try {
          res = await this.fetch(url, { headers, signal: ctrl.signal, cache: 'no-store', credentials: 'omit', redirect: 'follow' });
        } finally {
          clearTimeout(timer);
        }
        if (res.status === 304) {
          this.meta[entry.id] = { ...prev, checkedAt: now, error: null };
          this.save();
          return false;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const len = Number(res.headers.get('content-length') || 0);
        if (len > MAX_LIST_BYTES) throw new Error('list too large');
        const text = await res.text();
        if (text.length > MAX_LIST_BYTES) throw new Error('list too large');
        if (!text.trim() || /^\s*<(!doctype|html)/i.test(text)) throw new Error('not a filter list');
        const sha = createHash('sha256').update(text).digest('hex');
        const changed = sha !== prev.sha || !this.has(entry.id);
        if (changed) {
          const tmp = `${this.file(entry.id)}.tmp`;
          writeFileSync(tmp, text);
          renameSync(tmp, this.file(entry.id));
        }
        this.meta[entry.id] = {
          url,
          etag: res.headers.get('etag') || null,
          lastModified: res.headers.get('last-modified') || null,
          sha,
          size: text.length,
          checkedAt: now,
          updatedAt: changed ? now : prev.updatedAt || now,
          expires: parseExpires(text),
          title: parseTitle(text),
          error: null,
        };
        this.save();
        return changed;
      } catch (e) {
        lastErr = e;
        this.log.warn('filter list download failed', { id: entry.id, url, message: e && e.message });
      }
    }
    this.meta[entry.id] = { ...prev, checkedAt: now, error: lastErr ? String(lastErr.message || lastErr).slice(0, 200) : 'failed' };
    this.save();
    return false;
  }
}
