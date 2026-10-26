// End-to-end: the BUILT extension (background modules in a faithful fake browser) against a LIVE Ludworks
// server, with the real web app client code as the "other device". See tests/integration/README.md.
//
//   LUDWORKS_IT_URL=http://127.0.0.1:18104 LUDWORKS_IT_ADMIN=admin LUDWORKS_IT_ADMIN_PASSWORD=... \
//     node --test --test-concurrency=1 "tests/integration/*.test.mjs"

import test from 'node:test';
import assert from 'node:assert/strict';

import { installExtension, loginPage, settle } from './extension.mjs';
import { config, skipReason, adminPeer, createUser, createWebPeer, enableTotp, webModules } from './live-server.mjs';
import { generateTotp } from '../../src/lib/totp.js';
import { rawRequest } from './browser-env.mjs';

const cfg = config();
const skip = skipReason(cfg);
const SERVER = cfg.url;

async function rejectsCode(promise, code, msg) {
  await assert.rejects(promise, (e) => {
    assert.equal(e.code, code, `${msg || ''} expected ${code}, got ${e.code}: ${e.message}`);
    return true;
  });
}

const totpAt = async (secret, ms) => (await generateTotp(secret, ms)).code;

/** Sign the popup in like the real login view: host permission inside the click, then probe + login. */
async function signIn(ext, popup, { username, password, totpCode, recoveryCode, serverUrl = SERVER }) {
  const perm = popup.click(() => popup.ns.permissions.request({ origins: [`${new URL(serverUrl).protocol}//${new URL(serverUrl).hostname}/*`] }));
  assert.equal(await perm, true, 'host permission granted');
  const probe = await popup.call('server.probe', { serverUrl });
  if (probe.pinStatus === 'new') await popup.call('server.trust', { serverUrl: probe.serverUrl, fingerprint: probe.fingerprint });
  return popup.call('auth.login', { serverUrl: probe.serverUrl, username, password, ...(totpCode ? { totpCode } : {}), ...(recoveryCode ? { recoveryCode } : {}) });
}

const WEB_ITEMS = (now) => [
  {
    type: 'login', name: 'GitHub', favorite: true, notes: 'Ünïcödé ✓ notes\nline 2',
    login: { username: 'alice@example.com', password: 'gh-T7#qLm2!vR9x', uris: [{ uri: 'https://github.com/login', match: 'domain' }], totp: 'otpauth://totp/GitHub:alice?secret=JBSWY3DPEHPK3PXP&issuer=GitHub' },
    fields: [{ name: 'PIN', value: '4821', hidden: true }],
    password_history: [{ password: 'old-pass-1', changed_at: '2026-05-01T10:00:00Z' }],
    x_future_key: { kept: true, list: [1, 2, 3] },
    created_at: now, updated_at: now,
  },
  { type: 'login', name: 'Local NAS', login: { username: 'admin', password: 'nas-pw-💡', uris: [{ uri: 'http://localhost:5000', match: 'host' }], totp: '' }, created_at: now, updated_at: now },
  { type: 'login', name: 'Bank', login: { username: 'b.user', password: 'B4nk$', uris: [{ uri: 'https://online.bank.example/', match: 'starts_with' }] }, created_at: now, updated_at: now },
  { type: 'note', name: 'Wi-Fi', notes: 'SSID: Ludworks-5G', created_at: now, updated_at: now },
  { type: 'card', name: 'Visa', card: { cardholder: 'Alice Example', brand: 'Visa', number: '4242424242424242', exp_month: '04', exp_year: '2029', code: '123' }, created_at: now, updated_at: now },
  { type: 'identity', name: 'Alice', identity: { first_name: 'Alice', last_name: 'Example', email: 'alice@example.com' }, created_at: now, updated_at: now },
];

test('extension ↔ live server ↔ web app (Chrome build)', { skip, timeout: 600_000 }, async (t) => {
  const admin = await adminPeer(cfg);
  const alice = await createUser(admin, 'alice');
  const MASTER = 'correct horse battery staple 2026';

  // ---- the web app (another device) creates the vault and some items, including a folder
  const web = await createWebPeer(SERVER);
  await web.login(alice.username, alice.password);
  const wv = web.vault();
  assert.equal(await wv.load(), 'uninitialized');
  await wv.initialize(MASTER);
  const work = await wv.createFolder('Work/Dev');
  const now = new Date().toISOString();
  const webRecs = [];
  for (const [i, plain] of WEB_ITEMS(now).entries()) webRecs.push(await wv.saveItem({ plain, folderId: i === 0 ? work.id : null }));
  const ghRec = webRecs[0];

  const ext = await installExtension('chrome');
  t.after(() => ext.dispose());
  await ext.startBackground({ installReason: 'install' });
  const popup = await ext.openPopup();

  await t.test('fresh install is logged out; idle interval and session access level set', async () => {
    const st = await popup.call('state');
    assert.equal(st.phase, 'logged_out');
    assert.equal(st.browser, 'chrome');
    assert.equal(ext.browser.sessionAccessLevel, 'TRUSTED_CONTEXTS');
    assert.equal(ext.browser.idleInterval, 900);
  });

  await t.test('without host permission the unauthenticated probe is blocked by CORS (by design)', async () => {
    await rejectsCode(popup.call('server.probe', { serverUrl: SERVER }), 'network_error');
    const blocked = ext.browser.network.log.at(-1);
    assert.equal(blocked.privileged, false);
    assert.ok(blocked.blocked, 'request was stopped by the CORS check');
  });

  await t.test('sign in (token_mode) creates a "Chrome extension" device session', async () => {
    await rejectsCode(signIn(ext, popup, { username: alice.username, password: 'wrong-password' }), 'invalid_credentials');
    const st = await signIn(ext, popup, { username: alice.username, password: alice.password });
    assert.equal(st.phase, 'locked', 'vault exists → locked');
    assert.equal(st.user.username, alice.username);
    assert.equal(st.pin, null, 'TLS off: nothing to pin');
    const acc = (await ext.browser.storage.local.get('account')).account;
    assert.match(acc.token, /^lws_/);
    const login = ext.browser.network.log.find((r) => r.url.endsWith('/auth/login'));
    assert.equal(login.headers.origin, ext.browser.extOrigin, 'Origin header was sent');
    assert.equal(login.headers.cookie, undefined, 'no cookies');
    const sessions = await web.api.get('/me/sessions');
    const mine = sessions.filter((s) => s.device_name === 'Chrome extension');
    assert.equal(mine.length, 1, JSON.stringify(sessions));
    assert.equal(mine[0].kind, 'session', 'a revocable device session (PATs are kind "token")');
    assert.match(mine[0].user_agent, /Chrome\//);
  });

  await t.test('unlock: wrong master password, then right one; vault key only in storage.session', async () => {
    await rejectsCode(popup.call('vault.unlock', { password: 'nope' }), 'bad_password');
    const st = await popup.call('vault.unlock', { password: MASTER });
    assert.equal(st.phase, 'unlocked');
    assert.equal(st.itemCount, WEB_ITEMS(now).length);
    assert.ok((await ext.browser.storage.session.get('vaultKey')).vaultKey);
    const local = JSON.stringify(Object.fromEntries(ext.browser.storage.local.data));
    assert.ok(!local.includes(MASTER) && !local.includes('gh-T7#qLm2!vR9x'), 'no secrets in storage.local');
    assert.ok(!local.includes((await ext.browser.storage.session.get('vaultKey')).vaultKey), 'vault key not in storage.local');
  });

  await t.test('items created by the web app decrypt in the extension (incl. folder and unknown keys)', async () => {
    const list = await popup.call('items.list', { url: 'https://github.com/login' });
    assert.equal(list.undecryptable, 0);
    assert.equal(list.items.length, WEB_ITEMS(now).length);
    assert.deepEqual(list.folders.map((f) => f.name), ['Work/Dev']);
    const gh = list.items.find((i) => i.name === 'GitHub');
    assert.equal(gh.folderName, 'Work/Dev');
    assert.deepEqual(list.matches, [ghRec.id]);
    const item = await popup.call('items.get', { id: ghRec.id });
    assert.deepEqual(item.data, WEB_ITEMS(now)[0]);
    assert.equal(item.revision, ghRec.revision);
    // URL matching rules on the other web items
    assert.deepEqual((await popup.call('items.list', { url: 'http://localhost:5000/login' })).matches, [webRecs[1].id]);
    assert.deepEqual((await popup.call('items.list', { url: 'http://localhost:5001/login' })).matches, []);
    assert.deepEqual((await popup.call('items.list', { url: 'https://online.bank.example/login' })).matches, [webRecs[2].id]);
    assert.deepEqual((await popup.call('items.list', { url: 'https://online.bank.example.evil.net/' })).matches, []);
  });

  let extId;
  await t.test('items created / edited in the extension display correctly in the web app', async () => {
    const draft = {
      type: 'login', name: 'Example Shop', favorite: false, notes: 'from the extension',
      login: { username: 'shopper', password: 'first-Pa55!', uris: [{ uri: 'https://shop.example.com', match: 'domain' }], totp: 'JBSWY3DPEHPK3PXP' },
      fields: [{ name: 'Member no', value: '991', hidden: false }], password_history: [],
    };
    const created = await popup.call('items.save', { data: draft, folderId: work.id });
    extId = created.id;
    assert.match(extId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    await wv.sync();
    let rec = wv.items.get(extId);
    assert.ok(rec, 'web app sees the extension item');
    assert.equal(rec.error, null, 'web app decrypts it');
    assert.equal(rec.folder_id, work.id);
    assert.equal(rec.view.name, 'Example Shop');
    assert.equal(rec.view.login.password, 'first-Pa55!');
    assert.ok(rec.view.created_at && rec.view.updated_at, 'timestamps present');
    assert.ok(!Number.isNaN(Date.parse(rec.view.created_at)));

    // edit in the extension: password change → history, unknown keys preserved
    const cur = await popup.call('items.get', { id: extId });
    const next = structuredClone(cur.data);
    next.login.password = 'second-Pa55!';
    next.x_ext_future = 'keep me';
    const saved = await popup.call('items.save', { id: extId, data: next, baseRevision: cur.revision });
    assert.equal(saved.revision, cur.revision + 1);
    await wv.sync();
    rec = wv.items.get(extId);
    assert.equal(rec.view.login.password, 'second-Pa55!');
    assert.deepEqual(rec.view.history.map((h) => h.password), ['first-Pa55!']);
    assert.equal(rec.plain.x_ext_future, 'keep me');
    assert.equal(rec.plain.created_at, cur.data.created_at, 'created_at kept');
    assert.equal(rec.folder_id, work.id, 'folder kept on edit');

    // and the web app edits the extension's item (finalizeItem: history + unknown keys)
    const m = await webModules();
    const edited = structuredClone(rec.plain);
    edited.login.password = 'third-Pa55!';
    await wv.saveItem({ plain: m.model.finalizeItem(rec.plain, edited), folderId: rec.folder_id, original: rec });
    await popup.call('vault.sync');
    const after = await popup.call('items.get', { id: extId });
    assert.equal(after.data.login.password, 'third-Pa55!');
    assert.deepEqual(after.data.password_history.map((h) => h.password), ['second-Pa55!', 'first-Pa55!']);
    assert.equal(after.data.x_ext_future, 'keep me');
  });

  await t.test('conflict: a stale edit is refused, the extension adopts the server copy, retry works', async () => {
    const stale = await popup.call('items.get', { id: ghRec.id });
    const rec = wv.items.get(ghRec.id);
    const m = await webModules();
    const webEdit = structuredClone(rec.plain);
    webEdit.notes = 'edited on the web';
    await wv.saveItem({ plain: m.model.finalizeItem(rec.plain, webEdit), folderId: rec.folder_id, original: rec });

    const mine = structuredClone(stale.data);
    mine.name = 'GitHub (ext edit)';
    await rejectsCode(popup.call('items.save', { id: ghRec.id, data: mine, baseRevision: stale.revision }), 'conflict');
    const fresh = await popup.call('items.get', { id: ghRec.id });
    assert.equal(fresh.data.notes, 'edited on the web', 'details.current adopted into the cache');
    assert.equal(fresh.revision, stale.revision + 1);
    const retry = structuredClone(fresh.data);
    retry.name = 'GitHub (ext edit)';
    await popup.call('items.save', { id: ghRec.id, data: retry, baseRevision: fresh.revision });
    await wv.sync();
    assert.equal(wv.items.get(ghRec.id).view.name, 'GitHub (ext edit)');
    assert.equal(wv.items.get(ghRec.id).view.notes, 'edited on the web');
  });

  await t.test('deletes propagate both ways (incremental sync tombstones)', async () => {
    await popup.call('items.delete', { id: extId });
    await wv.sync();
    assert.equal(wv.items.has(extId), false);
    await wv.deleteItem(webRecs[3].id); // the note
    const before = ext.browser.network.log.length;
    await popup.call('vault.sync');
    const syncReq = ext.browser.network.log.slice(before).find((r) => r.url.includes('/vault/sync'));
    assert.match(syncReq.url, /since=/, 'incremental sync');
    const list = await popup.call('items.list', {});
    assert.ok(!list.items.some((i) => i.id === webRecs[3].id));
    assert.ok(!list.items.some((i) => i.id === extId));
  });

  await t.test('autofill: Fill puts the web app credentials (and TOTP) into the page', async () => {
    const page = loginPage('https://github.com/login', { totp: true });
    ext.browser.openTab('https://github.com/login', { page });
    const p2 = await ext.openPopup();
    const res = await p2.call('fill.item', { id: ghRec.id });
    assert.deepEqual(res, { filled: { username: true, password: true, totp: true } });
    assert.equal(page.fields.user.value, 'alice@example.com');
    assert.equal(page.fields.pass.value, 'gh-T7#qLm2!vR9x');
    assert.equal(page.fields.otp.value, await totpAt('JBSWY3DPEHPK3PXP', Date.now()));
    // keyboard shortcut path (best match), on another site: no match → '?' badge
    const other = loginPage('https://gitlab.com/users/sign_in');
    const tab = ext.browser.openTab('https://gitlab.com/users/sign_in', { page: other });
    await ext.browser.command('fill-login');
    await settle(20);
    assert.equal(ext.browser.badge.text.get(tab.id), '?');
    assert.equal(other.fields.pass.value, '');
    p2.close();
  });

  await t.test('offer to save: permission + content script registration, then a captured login lands on the server', async () => {
    const p = await ext.openPopup();
    const CAPTURE = ['https://*/*', 'http://localhost/*', 'http://127.0.0.1/*'];
    assert.equal(await p.click(() => p.ns.permissions.request({ origins: CAPTURE })), true);
    const s = await p.call('settings.update', { saveLogins: true });
    assert.equal(s.saveLogins, true);
    const reg = ext.browser.registeredScripts.get('ludworks-capture');
    assert.ok(reg, 'capture content script registered');
    assert.deepEqual(reg.matches, CAPTURE);
    // the content script in the top frame of the active tab reports a submitted login
    const tab = ext.browser.openTab('https://forum.example.org/login');
    const cs = ext.browser.createContext('content', 'https://forum.example.org/login', { tabId: tab.id });
    const send = (msg) => cs.ns.runtime.sendMessage(msg);
    let r = await send({ type: 'capture.submitted', username: 'poster', password: 'Forum-pw-1' });
    assert.deepEqual(r, { ok: true, data: { pending: true } });
    r = await send({ type: 'capture.pending' });
    assert.deepEqual(r.data, { show: true, kind: 'save', domain: 'example.org', username: 'poster' });
    // a content script must not be able to call popup-only messages
    r = await send({ type: 'items.list' });
    assert.equal(r.ok, false);
    r = await send({ type: 'capture.decision', decision: 'save' });
    assert.equal(r.ok, true, JSON.stringify(r));
    const savedId = r.data.id;
    await wv.sync();
    const rec = wv.items.get(savedId);
    assert.equal(rec.error, null);
    assert.equal(rec.view.login.username, 'poster');
    assert.equal(rec.view.login.password, 'Forum-pw-1');
    assert.deepEqual(rec.view.login.uris, [{ uri: 'https://forum.example.org', match: 'domain' }]);
    // a changed password → "update" adds history, visible on the web
    await send({ type: 'capture.submitted', username: 'poster', password: 'Forum-pw-2' });
    assert.equal((await send({ type: 'capture.pending' })).data.kind, 'update');
    await send({ type: 'capture.decision', decision: 'update' });
    await wv.sync();
    assert.equal(wv.items.get(savedId).view.login.password, 'Forum-pw-2');
    assert.deepEqual(wv.items.get(savedId).view.history.map((h) => h.password), ['Forum-pw-1']);
    cs.close();
    // turning the feature off unregisters the script
    await p.call('settings.update', { saveLogins: false });
    assert.equal(ext.browser.registeredScripts.has('ludworks-capture'), false);
    await p.ns.permissions.remove({ origins: CAPTURE });
    // (the dev server is http://127.0.0.1, whose host permission is one of the capture patterns)
    if (!ext.browser.hostPermitted(SERVER)) assert.equal(await p.requestServerPermission(SERVER), true);
    await wv.deleteItem(savedId);
    p.close();
  });

  await t.test('moving items between folders and out of them round-trips with the web app', async () => {
    const p = await ext.openPopup();
    const it = await p.call('items.get', { id: webRecs[4].id }); // the card, no folder
    await p.call('items.save', { id: it.id, data: it.data, folderId: work.id, baseRevision: it.revision });
    await wv.sync();
    assert.equal(wv.items.get(it.id).folder_id, work.id);
    assert.equal(wv.folderPath(wv.items.get(it.id).folder_id), 'Work/Dev');
    const moved = await p.call('items.get', { id: it.id });
    await p.call('items.save', { id: it.id, data: moved.data, folderId: null, baseRevision: moved.revision });
    await wv.sync();
    assert.equal(wv.items.get(it.id).folder_id, null, 'null un-files');
    p.close();
  });

  await t.test('an item too large for the server is refused locally (UTF-8 size, not string length)', async () => {
    const p = await ext.openPopup();
    const before = ext.browser.network.log.length;
    const big = { type: 'note', name: 'CJK essay', notes: '日本語'.repeat(30000) }; // 90k chars, 270 KB UTF-8
    await rejectsCode(p.call('items.save', { data: big }), 'validation_failed');
    assert.ok(!ext.browser.network.log.slice(before).some((r) => r.method === 'POST'), 'nothing uploaded');
    // the largest accepted item really fits the server's 256 KiB limit for sealed data
    const fits = { type: 'note', name: 'ASCII essay', notes: 'x'.repeat(190 * 1024 - 200) };
    const created = await p.call('items.save', { data: fits });
    await wv.sync();
    assert.equal(wv.items.get(created.id).view.notes.length, fits.notes.length);
    await p.call('items.delete', { id: created.id });
    p.close();
  });

  await t.test('clipboard auto-clear uses the offscreen document', async () => {
    ext.browser.clipboard.value = 'copied-secret';
    await popup.call('clipboard.copied');
    assert.ok(ext.browser.alarms.has('ludworks-clipboard-clear'));
    await ext.browser.advance(31_000);
    await settle(30);
    assert.equal(ext.browser.clipboard.value, '');
    assert.equal(ext.browser.offscreen, null, 'offscreen document closed again');
  });

  await t.test('lock, auto-lock alarm, idle lock, worker restart and browser restart', async () => {
    let st = await popup.call('vault.lock');
    assert.equal(st.phase, 'locked');
    await rejectsCode(popup.call('items.list', {}), 'locked');

    await popup.call('vault.unlock', { password: MASTER });
    await popup.call('settings.update', { lockMinutes: 1 });
    assert.equal(ext.browser.idleInterval, 60);
    await settle();
    const alarm = ext.browser.alarms.get('ludworks-autolock');
    assert.ok(alarm, 'auto-lock alarm scheduled');
    assert.ok(Math.abs(alarm.scheduledTime - (Date.now() + 60_000)) < 5_000, 'deadline = last activity + 1 min');
    // (no popup calls while waiting: every popup message counts as activity)
    await ext.browser.advance(30_000);
    await settle(20);
    assert.ok((await ext.browser.storage.session.get('vaultKey')).vaultKey, 'not locked yet');
    await ext.browser.advance(31_000);
    await settle(20);
    assert.equal((await ext.browser.storage.session.get('vaultKey')).vaultKey, undefined, 'auto-locked after the timeout');
    st = await popup.call('state');
    assert.equal(st.phase, 'locked');
    ext.clock.reset();

    await popup.call('vault.unlock', { password: MASTER });
    ext.browser.setIdleState('locked');
    await settle(20);
    assert.equal((await popup.call('state')).phase, 'locked', 'screen lock → vault lock');

    await popup.call('vault.unlock', { password: MASTER });
    await ext.restartWorker();
    const p2 = await ext.openPopup();
    assert.equal((await p2.call('state')).phase, 'unlocked', 'a service-worker restart keeps the session');
    assert.equal((await p2.call('items.list', {})).undecryptable, 0);

    await ext.restartBrowser();
    const p3 = await ext.openPopup();
    st = await p3.call('state');
    assert.equal(st.phase, 'locked', 'browser restart → locked');
    // offline unlock from the encrypted cache works
    ext.browser.network.setOffline(true);
    st = await p3.call('vault.unlock', { password: MASTER });
    assert.equal(st.phase, 'unlocked');
    assert.ok((await p3.call('items.list', {})).items.length > 0);
    ext.browser.network.setOffline(false);
    await p3.call('settings.update', { lockMinutes: 15 });
  });

  await t.test('master password changed on the web: the extension re-locks and unlocks with the new one', async () => {
    const p = await ext.openPopup();
    assert.equal((await p.call('state')).phase, 'unlocked');
    const NEW = 'new master password 2026!';
    await wv.changeMasterPassword(MASTER, NEW);
    await p.call('vault.sync');
    assert.equal((await p.call('state')).phase, 'locked', 'wrapped key changed → lock');
    await rejectsCode(p.call('vault.unlock', { password: MASTER }), 'bad_password');
    assert.equal((await p.call('vault.unlock', { password: NEW })).phase, 'unlocked');
    await wv.changeMasterPassword(NEW, MASTER);
    await p.call('vault.sync');
    await p.call('vault.unlock', { password: MASTER });
  });

  await t.test('vault reset + re-init on the web: no stale key is ever used to encrypt', async () => {
    const p = await ext.openPopup();
    assert.equal((await p.call('state')).phase, 'unlocked');
    await wv.reset(alice.password);
    const M2 = 'second vault master pw';
    assert.equal(await wv.load(), 'uninitialized');
    await wv.initialize(M2);
    const fresh = await wv.saveItem({ plain: { type: 'note', name: 'after reset', notes: 'x', created_at: now, updated_at: now }, folderId: null });

    // the popup opens and syncs: the old key must not survive
    const before = ext.browser.network.log.length;
    await p.call('vault.sync');
    const syncs = ext.browser.network.log.slice(before).filter((r) => r.url.includes('/vault/sync'));
    assert.equal(syncs[0].status, 410, 'since predates the re-init → 410 gone');
    assert.doesNotMatch(syncs[1].url, /since=/, 'then a full sync');
    const st = await p.call('state');
    assert.equal(st.phase, 'locked', `after a re-init the extension must lock, got ${st.phase}`);
    await rejectsCode(p.call('items.save', { data: { type: 'note', name: 'stale', notes: '' } }), 'locked');
    assert.equal((await p.call('vault.unlock', { password: M2 })).phase, 'unlocked');
    const list = await p.call('items.list', {});
    assert.equal(list.undecryptable, 0);
    assert.deepEqual(list.items.map((i) => i.id), [fresh.id], 'old cache replaced by the new vault');
  });

  await t.test('log out revokes the device session on the server and wipes local data', async () => {
    const p = await ext.openPopup();
    const token = (await ext.browser.storage.local.get('account')).account.token;
    const st = await p.call('auth.logout');
    assert.equal(st.phase, 'logged_out');
    const r = await rawRequest(`${SERVER}/api/v1/auth/session`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(r.status, 401, 'token revoked');
    const local = await ext.browser.storage.local.get(null);
    assert.equal(local.account, undefined);
    assert.equal(local.vaultCache, undefined);
    assert.deepEqual(await ext.browser.storage.session.get(null), {});
  });

  await t.test('a session revoked elsewhere signs the extension out on the next request', async () => {
    const p = await ext.openPopup();
    await signIn(ext, p, { username: alice.username, password: alice.password });
    await p.call('vault.unlock', { password: 'second vault master pw' });
    const sessions = await web.api.get('/me/sessions');
    const extSession = sessions.find((s) => s.device_name === 'Chrome extension');
    await web.api.del(`/me/sessions/${extSession.id}`);
    await rejectsCode(p.call('vault.sync'), 'session_expired');
    assert.equal((await p.call('state')).phase, 'logged_out');
  });
});

test('two-step verification and recovery codes (Firefox build)', { skip, timeout: 300_000 }, async (t) => {
  const admin = await adminPeer(cfg);
  const bob = await createUser(admin, 'bob');
  const web = await createWebPeer(SERVER);
  await web.login(bob.username, bob.password);
  const { secret, recoveryCodes } = await enableTotp(web, totpAt);
  assert.equal(recoveryCodes.length, 10);

  const ext = await installExtension('firefox');
  t.after(() => ext.dispose());
  await ext.startBackground({ installReason: 'install' });
  const popup = await ext.openPopup();

  await t.test('password alone → totp_required, wrong code → rejected, next-step code → signed in', async () => {
    await rejectsCode(signIn(ext, popup, { username: bob.username, password: bob.password }), 'totp_required');
    assert.equal((await popup.call('state')).phase, 'logged_out');
    await assert.rejects(signIn(ext, popup, { username: bob.username, password: bob.password, totpCode: '000000' }), (e) => ['invalid_credentials', 'totp_required'].includes(e.code));
    // the code used to enable TOTP is spent; the next 30 s step is accepted (±1 step skew)
    const code = await totpAt(secret, Date.now() + 30_000);
    const st = await signIn(ext, popup, { username: bob.username, password: bob.password, totpCode: `${code.slice(0, 3)} ${code.slice(3)}` });
    assert.equal(st.phase, 'uninitialized', 'bob has no vault yet');
    const sessions = await web.api.get('/me/sessions');
    assert.ok(sessions.some((s) => s.device_name === 'Firefox extension'));
  });

  await t.test('vault created later on the web is picked up by "Check again"', async () => {
    const wv = web.vault();
    await wv.load();
    await wv.initialize('bob master password 1');
    const st = await popup.call('vault.sync');
    assert.equal(st.phase, 'locked');
    assert.equal((await popup.call('vault.unlock', { password: 'bob master password 1' })).phase, 'unlocked');
  });

  await t.test('recovery code sign-in', async () => {
    await popup.call('auth.logout');
    const st = await signIn(ext, popup, { username: bob.username, password: bob.password, recoveryCode: recoveryCodes[0] });
    assert.equal(st.phase, 'locked');
    await popup.call('auth.logout');
    await assert.rejects(signIn(ext, popup, { username: bob.username, password: bob.password, recoveryCode: recoveryCodes[0] }), (e) => e.code === 'invalid_credentials', 'a recovery code works once');
  });

  await t.test('Firefox requests carry the moz-extension origin and no cookies', async () => {
    const req = ext.browser.network.log.find((r) => r.url.endsWith('/auth/login'));
    assert.match(req.headers.origin, /^moz-extension:\/\/[0-9a-f-]{36}$/);
    assert.equal(req.headers.cookie, undefined);
  });
});

test('a large vault imported on the web (streamed sync, batches) loads in the extension', { skip, timeout: 300_000 }, async (t) => {
  const admin = await adminPeer(cfg);
  const dave = await createUser(admin, 'dave');
  const web = await createWebPeer(SERVER);
  await web.login(dave.username, dave.password);
  const wv = web.vault();
  await wv.load();
  await wv.initialize('dave master password');
  const N = 2500;
  const entries = Array.from({ length: N }, (_, i) => ({
    plain: { type: 'login', name: `Site ${String(i).padStart(4, '0')}`, login: { username: `user${i}`, password: `pw-${i}-${'x'.repeat(i % 50)}`, uris: [{ uri: `https://login.site${i % 300}.com`, match: 'domain' }] } },
    folderPath: `Imported/Group ${i % 7}`,
  }));
  const res = await wv.importEntries(entries);
  assert.equal(res.created, N);

  const ext = await installExtension('chrome');
  t.after(() => ext.dispose());
  await ext.startBackground({ installReason: 'install' });
  const popup = await ext.openPopup();
  await signIn(ext, popup, { username: dave.username, password: dave.password });
  const t0 = Date.now();
  const st = await popup.call('vault.unlock', { password: 'dave master password' });
  assert.equal(st.itemCount, N);
  const list = await popup.call('items.list', { url: 'https://www.site42.com/login' });
  const ms = Date.now() - t0;
  assert.equal(list.items.length, N);
  assert.equal(list.undecryptable, 0);
  assert.equal(list.folders.length, 7);
  assert.equal(list.matches.length, Math.ceil((N - 42) / 300));
  assert.ok(ms < 60_000, `unlock + full sync + decrypt of ${N} items took ${ms} ms`);
  t.diagnostic(`unlock + sync + decrypt ${N} items: ${ms} ms`);
  const cacheBytes = JSON.stringify((await ext.browser.storage.local.get('vaultCache')).vaultCache).length;
  t.diagnostic(`encrypted cache in storage.local: ${(cacheBytes / 1024).toFixed(0)} KiB`);
});

test('login lockout surfaces as rate_limited with the Retry-After seconds', { skip, timeout: 120_000 }, async (t) => {
  const admin = await adminPeer(cfg);
  const erin = await createUser(admin, 'erin');
  const ext = await installExtension('chrome');
  t.after(() => ext.dispose());
  await ext.startBackground({ installReason: 'install' });
  const popup = await ext.openPopup();
  let last = null;
  for (let i = 0; i < 8 && (!last || last.code !== 'rate_limited'); i++) {
    last = await signIn(ext, popup, { username: erin.username, password: `wrong-${i}` }).catch((e) => e);
  }
  assert.equal(last.code, 'rate_limited', `${last.code}: ${last.message}`);
  assert.equal(last.status, 429);
  assert.ok(Number.isInteger(last.retryAfter) && last.retryAfter > 0, `retryAfter=${last.retryAfter}`);
  // after the lock expires the right password works (and resets the counters)
  await new Promise((r) => setTimeout(r, (last.retryAfter + 1) * 1000));
  const st = await signIn(ext, popup, { username: erin.username, password: erin.password });
  assert.equal(st.phase, 'uninitialized');
});

test('web app vault session + extension share one browser profile without cookie leakage', { skip, timeout: 300_000 }, async (t) => {
  const admin = await adminPeer(cfg);
  const carol = await createUser(admin, 'carol');
  const ext = await installExtension('chrome');
  t.after(() => ext.dispose());
  await ext.startBackground({ installReason: 'install' });
  // the user is signed in to the web UI in a tab of the same profile (shared cookie jar)
  const web = await createWebPeer(SERVER, { jar: ext.browser.network.jar });
  await web.login(carol.username, carol.password);
  assert.ok(ext.browser.network.jar.header(SERVER), 'web session cookie is in the profile jar');
  const popup = await ext.openPopup();
  await t.test('the extension never rides on the web session cookie', async () => {
    const st = await popup.call('state');
    assert.equal(st.phase, 'logged_out');
    await popup.requestServerPermission(SERVER);
    await popup.call('server.probe', { serverUrl: SERVER });
    for (const r of ext.browser.network.log) assert.equal(r.headers.cookie, undefined, r.url);
  });
});
