// Tracking-cookie monitor and "clear recent history" (src/main/privacy/privacy.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ProfileDb } from '../build/app/main/profile/db.js';
import { History } from '../build/app/main/profile/history.js';
import { Prefs } from '../build/app/main/profile/prefs.js';
import { Privacy, TrackerLedger, siteOf, RANGES } from '../build/app/main/privacy/privacy.js';

function fakeBrowser() {
  const dir = mkdtempSync(path.join(tmpdir(), 'lwb-privacy-'));
  const db = new ProfileDb(dir);
  const calls = { cleared: [], downloadsSince: null, refresh: 0 };
  const b = {
    db,
    prefs: new Prefs(db),
    history: new History(db),
    downloads: { clearSince: (s) => (calls.downloadsSince = s) },
    session: { clearCache: async () => calls.cleared.push('cache'), clearCodeCaches: async () => {}, clearStorageData: async (o) => calls.cleared.push(o && o.storages ? 'storage' : 'x') },
    refreshToolbar: () => calls.refresh++,
  };
  return { b, calls, done: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

/** A WebRequestHub stand-in that records the handlers so the test can feed requests. */
function fakeHub() {
  const hub = { before: [], send: [], received: [] };
  return {
    hub,
    api: { onBeforeRequest: (f) => hub.before.push(f), onBeforeSendHeaders: (f) => hub.send.push(f), onHeadersReceived: (f) => hub.received.push(f) },
    nav: (wcId, url) => hub.before.forEach((f) => f({ resourceType: 'mainFrame', webContentsId: wcId, url })),
    send: (wcId, url, headers) => {
      hub.send.forEach((f) => f({ resourceType: 'script', webContentsId: wcId, url }, headers));
      return headers;
    },
    recv: (wcId, url, headers) => hub.received.map((f) => f({ resourceType: 'image', webContentsId: wcId, url }, headers)),
  };
}

const ctlFor = (wcId, url, isPrivate = false) => ({ private: isPrivate, activeTab: () => ({ wc: { id: wcId, isDestroyed: () => false, getURL: () => url } }) });

test('privacy: sites are registrable domains', () => {
  assert.equal(siteOf('https://ads.doubleclick.net/x'), 'doubleclick.net');
  assert.equal(siteOf('https://www.bbc.co.uk/news'), 'bbc.co.uk');
  assert.equal(siteOf('ludworks://settings/'), '');
  assert.equal(siteOf('not a url'), '');
});

test('privacy: a tracker follows you once seen under two sites', () => {
  const l = new TrackerLedger();
  assert.equal(l.add('tracker.com', 'a.com'), true);
  assert.equal(l.add('tracker.com', 'a.com'), false);
  assert.equal(l.following('tracker.com'), false);
  l.add('tracker.com', 'b.com');
  l.add('other.com', 'a.com');
  assert.equal(l.following('tracker.com'), true);
  assert.deepEqual(l.allFollowing(), ['tracker.com']);
});

test('privacy: third-party cookies are recorded, persisted, badged and optionally stripped', () => {
  const { b, done } = fakeBrowser();
  try {
    const p = new Privacy(b);
    const h = fakeHub();
    p.attachSession({}, h.api, { isPrivate: false });
    h.nav(1, 'https://news.example/');
    h.send(1, 'https://cdn.news.example/app.js', { Cookie: 'a=1' }); // first party: ignored
    h.send(1, 'https://px.tracker.test/p.gif', { Cookie: 'uid=1' });
    h.recv(1, 'https://ads.other.test/x', { 'set-cookie': ['id=2'] });
    h.nav(1, 'https://shop.example2/');
    h.send(1, 'https://px.tracker.test/p.gif', { Cookie: 'uid=1' });
    const btn = p.toolbarButtons(ctlFor(1, 'https://shop.example2/'), ctlFor(1, 'https://shop.example2/').activeTab()).find((x) => x.id === 'trackers');
    assert.equal(btn.badge, 1);
    assert.equal(btn.tone, 'warn');
    const data = p.trackerData(ctlFor(1, 'https://shop.example2/'));
    assert.equal(data.site, 'shop.example2');
    assert.deepEqual(data.trackers.map((t) => [t.domain, t.sites, t.following]), [['tracker.test', 2, true]]);
    // persisted: a new instance on the same profile still knows
    assert.equal(new Privacy(b).ledger.count('tracker.test'), 2);

    b.prefs.update({ blockThirdPartyCookies: true });
    const headers = h.send(1, 'https://px.tracker.test/p.gif', { Cookie: 'uid=1', Accept: '*/*' });
    assert.deepEqual(headers, { Accept: '*/*' });
    const resp = { 'Set-Cookie': ['x=1'], 'content-type': ['image/gif'] };
    assert.deepEqual(h.recv(1, 'https://ads.other.test/y', resp), [{ changed: true }]);
    assert.deepEqual(resp, { 'content-type': ['image/gif'] });
  } finally {
    done();
  }
});

test('privacy: private windows are tracked in memory only', () => {
  const { b, done } = fakeBrowser();
  try {
    const p = new Privacy(b);
    const h = fakeHub();
    p.attachSession({}, h.api, { isPrivate: true });
    h.nav(7, 'https://a.example/');
    h.send(7, 'https://t.tracker.test/', { cookie: '1' });
    assert.equal(p.privateLedger.count('tracker.test'), 1);
    assert.equal(p.ledger.count('tracker.test'), 0);
    assert.equal(b.db.all('SELECT * FROM privacy_trackers').length, 0);
  } finally {
    done();
  }
});

test('privacy: clear recent history honours the range', async () => {
  const { b, calls, done } = fakeBrowser();
  try {
    const p = new Privacy(b);
    const now = Date.now();
    b.history.addVisit({ url: 'https://old.example/', at: now - 5 * 24 * 3600e3 });
    b.history.addVisit({ url: 'https://recent.example/', at: now - 3600e3 * 30 });
    b.history.addVisit({ url: 'https://new.example/', at: now - 60e3 });
    await p.clearRecent('24h', { history: true, downloads: true });
    assert.deepEqual(b.history.list({}).map((r) => r.url).sort(), ['https://old.example/', 'https://recent.example/']);
    assert.ok(calls.downloadsSince > now - 24 * 3600e3 - 5000 && calls.downloadsSince <= Date.now() - 24 * 3600e3);
    await p.clearRecent('72h', { history: true, cache: true });
    assert.deepEqual(b.history.list({}).map((r) => r.url), ['https://old.example/']);
    assert.deepEqual(calls.cleared, ['cache']);
    const r = await p.clearRecent('all', { history: true });
    assert.equal(b.history.list({}).length, 0);
    assert.equal(r.last.label, RANGES.all.label);
    await assert.rejects(p.clearRecent('5y', {}), /unknown range/);
  } finally {
    done();
  }
});
