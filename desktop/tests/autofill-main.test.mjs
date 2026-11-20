// Browser side of autofill (src/main/autofill.js): where the dropdown goes (zoom, frames below cross-origin
// parents), what it offers per field kind / vault state / page security, and how it reacts to the page.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Autofill, dropdownAnchor, dropdownItems } from '../build/app/main/autofill.js';

const settle = (ms = 0) => new Promise((r) => setTimeout(r, ms));

function login(id, uri, username, extra = {}) {
  return { id, data: { type: 'login', name: `Item ${id}`, login: { username, password: `pw-${id}`, uris: [{ uri, match: extra.match || 'domain' }], totp: extra.totp || '' } } };
}

function fakeFrame(url, { processId = 1, routingId = 1, parent = null } = {}) {
  const f = { url, processId, routingId, parent, sent: [], destroyed: false };
  f.send = (ch, payload) => f.sent.push([ch, payload]);
  f.isDestroyed = () => f.destroyed;
  return f;
}

function setup({ url = 'https://example.com/login', phase = 'unlocked', logins = [], zoom = 1 } = {}) {
  const calls = [];
  const mainFrame = fakeFrame(url);
  const ctl = {
    activeId: 1,
    destroyed: false,
    popup: null,
    topInset: 80,
    overlay: { webContents: { isFocused: () => false, isDestroyed: () => false, focus: () => calls.push(['overlay-focus']), send: (ch, v) => calls.push(['overlay-send', ch, v]) } },
    contentRect: () => ({ x: 0, y: 80, width: 1200, height: 800 }),
    async showPopup(kind, data, anchor) {
      ctl.popup = { kind, anchor };
      calls.push(['show', kind, data, anchor]);
    },
    hidePopup(kind) {
      if (!ctl.popup || (kind && ctl.popup.kind !== kind)) return;
      ctl.popup = null;
      calls.push(['hide', kind]);
    },
    sendState() {},
    shell: { send: (ch) => calls.push(['shell', ch]) },
  };
  const tab = {
    id: 1,
    destroyed: false,
    private: false,
    ctl,
    wc: { getZoomFactor: () => zoom, getURL: () => url, mainFrame },
  };
  ctl.activeTab = () => tab;
  const browser = {
    account: {
      phase: () => phase,
      logins: async () => logins,
      vault: { isUnlocked: () => phase === 'unlocked', get: async (id) => ({ data: logins.find((l) => l.id === id).data, vi: { revision: 1 } }) },
    },
    passkeys: { conditionalFor: async () => [], onTabClosed() {} },
    prefs: { get: () => true },
    db: { getMeta: () => [], setMeta() {} },
    allTabs: () => [tab],
  };
  const af = new Autofill(browser);
  const shows = () => calls.filter((c) => c[0] === 'show');
  return { af, tab, ctl, calls, shows, mainFrame };
}

test('dropdownAnchor: under the field, scaled by the page zoom, clamped to the tab area', () => {
  const area = { x: 0, y: 80, width: 1200, height: 800 };
  assert.deepEqual(dropdownAnchor(area, 1, { x: 100, y: 200, width: 320, height: 40 }), { x: 100, y: 323, width: 320 });
  assert.deepEqual(dropdownAnchor(area, 1.5, { x: 100, y: 200, width: 320, height: 40 }), { x: 150, y: 443, width: 440 });
  assert.deepEqual(dropdownAnchor(area, 1, { x: 100, y: 200, width: 120, height: 20 }).width, 300, 'never narrower than 300');
  assert.equal(dropdownAnchor(area, 1, { x: 1150, y: 10, width: 320, height: 20 }).x, 1200 - 320 - 4, 'stays inside the tab');
  assert.equal(dropdownAnchor(area, 1, { x: 10, y: 5000, width: 320, height: 20 }).y, 80 + 800 - 60);
  assert.deepEqual(dropdownAnchor(area, 1, null), { x: 820, y: 78, width: 360 }, 'unknown position: top right of the page');
});

test('dropdownItems: TOTP fields list logins with a code, new-password fields none, typing narrows', () => {
  const url = 'https://example.com/login';
  const m = (l, score = 2) => ({ ...l, score, uris: l.data.login.uris });
  const a = m(login('a', 'https://example.com', 'alice@example.com', { totp: 'JBSWY3DPEHPK3PXP' }));
  const b = m(login('b', 'https://example.com', 'bob@example.com'));
  const c = m(login('c', 'https://other.example.com', 'carol@example.com'), 1);
  assert.deepEqual(dropdownItems([a, b, c], 'username', url).map((i) => i.id), ['a', 'b', 'c']);
  assert.deepEqual(dropdownItems([a, b, c], 'totp', url).map((i) => i.id), ['a']);
  assert.deepEqual(dropdownItems([a, b, c], 'new-password', url), []);
  assert.deepEqual(dropdownItems([a, b, c], 'username', url, 'BO').map((i) => i.id), ['b']);
  assert.deepEqual(dropdownItems([a, b, c], 'username', url, 'zed'), []);
  assert.deepEqual(dropdownItems([c], 'password', url)[0].otherHost, ['other.example.com']);
  assert.equal(dropdownItems([a], 'password', url)[0].otherHost, null);
});

test('field focus shows the dropdown under the field; clicking the same field again does not redraw it', async () => {
  const { af, tab, shows, mainFrame } = setup({ logins: [login('a', 'https://example.com', 'alice')] });
  const focus = { kind: 'username', mode: 'login', rect: { x: 100, y: 200, width: 320, height: 40 }, url: mainFrame.url };
  af.contentMessage(tab, mainFrame, 'field-focus', focus);
  await settle(5);
  assert.equal(shows().length, 1);
  const [, kind, data, anchor] = shows()[0];
  assert.equal(kind, 'fill');
  assert.deepEqual(data.items.map((i) => i.username), ['alice']);
  assert.equal(data.locked, false);
  assert.deepEqual(anchor, { x: 100, y: 323, width: 320 });
  af.contentMessage(tab, mainFrame, 'field-focus', focus);
  await settle(5);
  assert.equal(shows().length, 1, 'same field, same place: left as it is');
  af.contentMessage(tab, mainFrame, 'field-focus', { ...focus, rect: { ...focus.rect, y: 260 } });
  await settle(5);
  assert.equal(shows().length, 2, 'the field moved: redrawn at the new place');
});

test('a frame below a cross-origin parent: the dropdown waits for the offset reported by the frames above', async () => {
  const { af, tab, shows, mainFrame } = setup({ logins: [login('a', 'https://idmsa.example.com', 'alice')] });
  const framed = fakeFrame('https://idmsa.example.com/signin', { routingId: 7, parent: mainFrame });
  af.contentMessage(tab, framed, 'field-focus', { kind: 'username', rect: { x: 90, y: 5, width: 460, height: 56 }, offsetToken: 'tok1' });
  await settle(5);
  assert.equal(shows().length, 0, 'waiting for the offset');
  af.contentMessage(tab, mainFrame, 'frame-offset', { token: 'tok1', x: 513, y: 374 });
  await settle(5);
  assert.equal(shows().length, 1);
  assert.deepEqual(shows()[0][3], { x: 513, y: 80 + 374 + 56 + 3, width: 440 });

  // the offset may also arrive before the focus message (different processes)
  const s2 = setup({ logins: [login('a', 'https://idmsa.example.com', 'alice')] });
  const f2 = fakeFrame('https://idmsa.example.com/signin', { routingId: 9, parent: s2.mainFrame });
  s2.af.contentMessage(s2.tab, s2.mainFrame, 'frame-offset', { token: 'tok2', x: 40, y: 60 });
  s2.af.contentMessage(s2.tab, f2, 'field-focus', { kind: 'password', rect: { x: 1, y: 2, width: 300, height: 30 }, offsetToken: 'tok2' });
  await settle(5);
  assert.deepEqual(s2.shows()[0][3], { x: 40, y: 80 + 60 + 30 + 3, width: 300 });

  // no answer (frame above without the preload): shown at the fallback place after a short wait
  const s3 = setup({ logins: [login('a', 'https://idmsa.example.com', 'alice')] });
  const f3 = fakeFrame('https://idmsa.example.com/signin', { routingId: 11, parent: s3.mainFrame });
  s3.af.contentMessage(s3.tab, f3, 'field-focus', { kind: 'username', rect: { x: 1, y: 2, width: 300, height: 30 }, offsetToken: 'never' });
  await settle(400);
  assert.deepEqual(s3.shows()[0][3], { x: 820, y: 78, width: 360 });

  // junk offsets are ignored
  const s4 = setup();
  s4.af.contentMessage(s4.tab, s4.mainFrame, 'frame-offset', { token: 'x', x: 'NaN', y: 1 });
  s4.af.contentMessage(s4.tab, s4.mainFrame, 'frame-offset', { token: '', x: 1, y: 1 });
  assert.equal(s4.af.st(s4.tab).offsets.size, 0);
  // a page posting probes in a loop cannot grow the cache
  for (let i = 0; i < 500; i++) s4.af.contentMessage(s4.tab, s4.mainFrame, 'frame-offset', { token: `t${i}`, x: i, y: i });
  assert.ok(s4.af.st(s4.tab).offsets.size <= 33);
  assert.ok(s4.af.st(s4.tab).offsets.has('t499'), 'the newest offsets are kept');
});

test('typing narrows the dropdown to matching usernames and closes it when nothing matches', async () => {
  const { af, tab, ctl, calls, shows, mainFrame } = setup({ logins: [login('a', 'https://example.com', 'alice'), login('b', 'https://example.com', 'bob')] });
  af.contentMessage(tab, mainFrame, 'field-focus', { kind: 'username', rect: { x: 10, y: 10, width: 300, height: 30 } });
  await settle(5);
  assert.equal(shows()[0][2].items.length, 2);
  af.contentMessage(tab, mainFrame, 'field-input', { password: false, value: 'b' });
  await settle(5);
  assert.deepEqual(shows().at(-1)[2].items.map((i) => i.username), ['bob']);
  af.contentMessage(tab, mainFrame, 'field-input', { password: false, value: 'bz' });
  await settle(5);
  assert.equal(ctl.popup, null);
  assert.deepEqual(calls.at(-1), ['hide', 'fill']);
  // typing a password closes it at once (the value never leaves the page)
  af.contentMessage(tab, mainFrame, 'field-focus', { kind: 'password', rect: { x: 10, y: 50, width: 300, height: 30 } });
  await settle(5);
  assert.equal(ctl.popup.kind, 'fill');
  af.contentMessage(tab, mainFrame, 'field-input', { password: true, value: '' });
  assert.equal(ctl.popup, null);
});

test('locked vault: login and code fields offer to unlock, new-password fields still get the generator', async () => {
  const { af, tab, shows, mainFrame } = setup({ phase: 'locked', logins: [login('a', 'https://example.com', 'alice')] });
  for (const kind of ['username', 'password', 'totp']) {
    af.contentMessage(tab, mainFrame, 'field-focus', { kind, rect: { x: 10, y: 10 + shows().length * 40, width: 300, height: 30 } });
    await settle(5);
    const d = shows().at(-1)[2];
    assert.equal(d.locked, true, kind);
    assert.equal(d.kind, kind);
  }
  af.contentMessage(tab, mainFrame, 'field-focus', { kind: 'new-password', rect: { x: 10, y: 400, width: 300, height: 30 } });
  await settle(5);
  const d = shows().at(-1)[2];
  assert.equal(d.locked, false);
  assert.equal(d.generate, true);
});

test('plain-http pages: never filled; localhost asks first; generation allowed on localhost only', async () => {
  const http = setup({ url: 'http://shop.example.com/login', logins: [login('a', 'http://shop.example.com', 'alice')] });
  http.af.contentMessage(http.tab, http.mainFrame, 'field-focus', { kind: 'username', rect: { x: 10, y: 10, width: 300, height: 30 } });
  await settle(5);
  const d = http.shows()[0][2];
  assert.equal(d.blocked, true);
  assert.deepEqual(d.items, [], 'nothing to pick on an insecure page');
  await http.af.generateInto(http.tab, { frame: http.mainFrame });
  assert.equal(http.mainFrame.sent.at(-1)[1].allowInsecure, false);

  const local = setup({ url: 'http://127.0.0.1:8080/signup' });
  await local.af.generateInto(local.tab, { frame: local.mainFrame });
  const [ch, p] = local.mainFrame.sent.at(-1);
  assert.equal(ch, 'lw-fill');
  assert.equal(p.mode, 'generate');
  assert.equal(p.allowInsecure, true);
  local.af.contentMessage(local.tab, local.mainFrame, 'field-focus', { kind: 'new-password', rect: { x: 10, y: 10, width: 300, height: 30 } });
  await settle(5);
  assert.equal(local.shows()[0][2].generate, true);
  assert.equal(local.shows()[0][2].insecure, true);
});

test('keyboard: ArrowDown opens the dropdown, or moves focus into it when it is open', async () => {
  const { af, tab, calls, mainFrame } = setup({ logins: [login('a', 'https://example.com', 'alice')] });
  af.contentMessage(tab, mainFrame, 'field-key', { key: 'ArrowDown', kind: 'username', rect: { x: 10, y: 10, width: 300, height: 30 } });
  await settle(5);
  assert.ok(calls.some((c) => c[0] === 'show'));
  assert.deepEqual(calls.slice(-2), [['overlay-focus'], ['overlay-send', 'popup-select', 0]]);
  calls.length = 0;
  af.contentMessage(tab, mainFrame, 'field-key', { key: 'ArrowDown', kind: 'username', rect: { x: 10, y: 10, width: 300, height: 30 } });
  assert.deepEqual(calls, [['overlay-focus'], ['overlay-send', 'popup-select', 0]]);
  af.contentMessage(tab, mainFrame, 'field-key', { key: 'Escape' });
  assert.deepEqual(calls.at(-1), ['hide', 'fill']);
});

test('the page scrolling under the dropdown closes it (any frame of the tab)', async () => {
  const { af, tab, ctl, mainFrame } = setup({ logins: [login('a', 'https://example.com', 'alice')] });
  const framed = fakeFrame('https://example.com/frame', { routingId: 3, parent: mainFrame });
  af.contentMessage(tab, framed, 'field-focus', { kind: 'username', rect: { x: 10, y: 10, width: 300, height: 30 } });
  await settle(5);
  assert.equal(ctl.popup.kind, 'fill');
  af.contentMessage(tab, mainFrame, 'page-scroll', {});
  assert.equal(ctl.popup, null, 'the parent frame scrolled the field away');
  // right after it opened (focus-time scrolling / animation): the field's frame is asked to place it again
  // once the scrolling stops
  await settle(260);
  assert.deepEqual(framed.sent.at(-1), ['lw-autofill', { cmd: 'reanchor' }]);
  // later scrolling only closes it
  const n = framed.sent.length;
  af.st(tab).requestedAt = Date.now() - 5000;
  af.contentMessage(tab, mainFrame, 'page-scroll', {});
  await settle(260);
  assert.equal(framed.sent.length, n);
  // nothing to close: other popups are left alone
  ctl.popup = { kind: 'menu' };
  af.contentMessage(tab, mainFrame, 'page-scroll', {});
  assert.equal(ctl.popup.kind, 'menu');
});

test('key bubble and fill shortcut fill the frame that has the login form (e.g. a cross-origin sign-in frame)', async () => {
  const { af, tab, mainFrame, shows } = setup({ url: 'https://www.icloud.example/', logins: [login('a', 'https://idmsa.icloud.example', 'alice')] });
  const framed = fakeFrame('https://idmsa.icloud.example/signin', { routingId: 5, parent: mainFrame });
  af.contentMessage(tab, mainFrame, 'forms', { mode: 'none' });
  af.contentMessage(tab, framed, 'forms', { mode: 'login' });
  assert.equal(af.fillTarget(tab), framed);
  await af.openKeyBubble(tab.ctl, { x: 900, y: 70, width: 360 });
  const bubble = shows().at(-1);
  assert.equal(bubble[1], 'key');
  assert.equal(bubble[2].host, 'idmsa.icloud.example', 'the bubble lists the logins of the frame it fills');
  assert.deepEqual(bubble[2].items.map((i) => [i.id, i.otherHost]), [['a', false]]);
  const r = await af.popupAction(tab.ctl, 'key', 'fill', { id: 'a' });
  assert.deepEqual(r, { ok: true });
  const [ch, p] = framed.sent.at(-1);
  assert.equal(ch, 'lw-fill');
  assert.equal(p.username, 'alice');
  assert.equal(p.expectedOrigin, 'https://idmsa.icloud.example');
  // a frame that went away no longer counts as a login form (key icon, context menu)
  assert.equal(af.isLoginField(tab, { formControlType: 'input-text' }), true);
  framed.destroyed = true;
  assert.equal(af.fillTarget(tab), mainFrame);
  assert.equal(af.isLoginField(tab, { formControlType: 'input-text' }), false);
});

test('many logins for one site: the key bubble lists them all, the dropdown far more than a screenful', async () => {
  const logins = Array.from({ length: 40 }, (_, i) => login(`g${i}`, 'https://google.com', `user${i}@gmail.com`));
  const { af, tab, mainFrame, shows } = setup({ url: 'https://accounts.google.com/v3/signin/identifier', logins });
  await af.openKeyBubble(tab.ctl, { x: 900, y: 70, width: 360 });
  const bubble = shows().at(-1)[2];
  assert.equal(bubble.total, 40);
  assert.equal(bubble.items.length, 40, 'the 13th and later logins were cut off before');
  assert.ok(bubble.items.some((i) => i.username === 'user39@gmail.com'));
  af.contentMessage(tab, mainFrame, 'field-focus', { kind: 'username', rect: { x: 10, y: 10, width: 300, height: 30 } });
  await settle(5);
  assert.equal(shows().at(-1)[2].items.length, 40);
  assert.equal(dropdownItems(Array.from({ length: 80 }, (_, i) => ({ ...login(`x${i}`, 'https://google.com', `u${i}`), score: 100, uris: [] })), 'username', 'https://google.com/').length, 50);
});

test('fills from the dropdown go to the frame that asked; TOTP codes are generated for it', async () => {
  const { af, tab, mainFrame } = setup({ logins: [login('a', 'https://example.com', 'alice', { totp: 'JBSWY3DPEHPK3PXP' })] });
  af.contentMessage(tab, mainFrame, 'field-focus', { kind: 'totp', rect: { x: 10, y: 10, width: 300, height: 30 } });
  await settle(5);
  const r = await af.popupAction(tab.ctl, 'fill', 'fill', { id: 'a' });
  assert.deepEqual(r, { ok: true });
  const [, p] = mainFrame.sent.at(-1);
  assert.match(p.totp, /^\d{6}$/);
  assert.equal(p.password, 'pw-a');
  assert.equal(tab.ctl.popup, null, 'the dropdown closes when a login is picked');
});

test('password badge: the whole vault is searchable; a login of another site fills only once the user confirmed', async () => {
  const logins = [login('a', 'https://example.com', 'alice'), login('g', 'https://github.com', 'octo', { totp: 'JBSWY3DPEHPK3PXP' }), login('b', 'https://bank.test', 'bob')];
  const { af, tab, mainFrame, shows } = setup({ url: 'https://example.com/login', logins });
  await af.openKeyBubble(tab.ctl, { x: 900, y: 70, width: 380 }, { browse: true });
  assert.equal(shows().at(-1)[2].browse, true);
  assert.deepEqual(shows().at(-1)[2].items.map((i) => i.id), ['a'], 'this site first');
  const r = await af.popupAction(tab.ctl, 'key', 'search', { q: 'GIT' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.value.items.map((i) => [i.id, i.site, i.otherSite, i.totp]), [['g', 'github.com', true, true]]);
  assert.deepEqual((await af.popupAction(tab.ctl, 'key', 'search', { q: 'o' })).value.items.map((i) => i.id), ['a', 'b', 'g'], 'this site’s logins before the others');
  assert.deepEqual((await af.popupAction(tab.ctl, 'key', 'search', { q: '' })).value.items, []);
  // another site's login: refused unless confirmed, then filled under this page's origin
  const refused = await af.popupAction(tab.ctl, 'key', 'fill', { id: 'g' });
  assert.equal(refused.ok, false);
  assert.match(refused.error.message, /not saved for this website/);
  const ok = await af.popupAction(tab.ctl, 'key', 'fill', { id: 'g', allowAnySite: true });
  assert.deepEqual(ok, { ok: true });
  const [ch, p] = mainFrame.sent.at(-1);
  assert.equal(ch, 'lw-fill');
  assert.equal(p.username, 'octo');
  assert.deepEqual(p.uris, [{ uri: 'https://example.com', match: 'host' }]);
  // the autofill dropdown can never fill another site's login
  assert.equal((await af.popupAction(tab.ctl, 'fill', 'fill', { id: 'g', allowAnySite: true })).ok, false);
});
