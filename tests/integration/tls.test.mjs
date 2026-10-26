// TLS + certificate pinning against a LIVE `--tls self-signed` Ludworks server (LUDWORKS_IT_TLS_URL).
//
// A local TLS front ("proxy") sits between the extension and the server so the same origin can be served
//   pass       → raw TCP passthrough: the browser sees the server's own certificate;
//   intercept  → TLS terminated with ANOTHER certificate that the browser profile trusts (a MITM whose CA is
//                installed), requests re-encrypted to the server — /setup/status still reports the real one;
//   rotate     → like intercept, but /setup/status reports the new certificate too (what a legitimate
//                certificate change looks like from the client).
// Firefox reads the presented certificate (webRequest.getSecurityInfo) and must refuse interception;
// Chrome can only compare the server-reported fingerprint (documented limitation) but must catch rotations.

import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { installExtension } from './extension.mjs';
import { config, adminPeer, createUser, createWebPeer, fetchServerCertificate, HAVE_WEB } from './live-server.mjs';

const cfg = config();
const TLS_URL = cfg.tlsUrl;

function haveOpenssl() {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
const skip = (!TLS_URL && 'LUDWORKS_IT_TLS_URL not set (needs a --tls self-signed server)') || (!HAVE_WEB && 'ludworks-server checkout missing') || (!haveOpenssl() && 'openssl CLI not available');

function makeCert() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'lw-mitm-'));
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-days', '2',
      '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost', '-addext', 'basicConstraints=critical,CA:TRUE',
      '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem')], { stdio: 'ignore' });
    const cert = readFileSync(path.join(dir, 'cert.pem'), 'utf8');
    const key = readFileSync(path.join(dir, 'key.pem'), 'utf8');
    const fp = execFileSync('openssl', ['x509', '-noout', '-fingerprint', '-sha256', '-in', path.join(dir, 'cert.pem')], { encoding: 'utf8' }).split('=')[1].trim();
    return { cert, key, fingerprint256: fp };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const norm = (fp) => fp.replace(/:/g, '').toLowerCase();

/** TLS front for the server with switchable mode (see header). */
function startFront(targetUrl, mitm) {
  const target = new URL(targetUrl);
  const state = { mode: 'pass', seen: [] };
  const terminator = https.createServer({ key: mitm.key, cert: mitm.cert }, (req, res) => {
    state.seen.push(`${state.mode} ${req.method} ${req.url}`);
    const up = https.request({ host: target.hostname, port: target.port, method: req.method, path: req.url, headers: { ...req.headers, host: target.host }, rejectUnauthorized: false, agent: false }, (ur) => {
      if (state.mode === 'rotate' && req.url.startsWith('/api/v1/setup/status')) {
        const chunks = [];
        ur.on('data', (c) => chunks.push(c));
        ur.on('end', () => {
          const body = JSON.parse(Buffer.concat(chunks).toString());
          body.tls_fingerprint_sha256 = mitm.fingerprint256;
          const out = Buffer.from(JSON.stringify(body));
          res.writeHead(ur.statusCode, { ...ur.headers, 'content-length': out.length });
          res.end(out);
        });
        return;
      }
      res.writeHead(ur.statusCode, ur.headers);
      ur.pipe(res);
    });
    up.on('error', () => res.destroy());
    req.pipe(up);
  });
  const sockets = new Set();
  const track = (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
    return s;
  };
  const server = net.createServer((client) => {
    track(client).on('error', () => {});
    if (state.mode === 'pass') {
      const up = track(net.connect(Number(target.port), target.hostname));
      up.on('error', () => client.destroy());
      client.pipe(up).pipe(client);
    } else {
      terminator.emit('connection', client);
    }
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      state.url = `https://127.0.0.1:${server.address().port}`;
      state.close = () => new Promise((r) => {
        for (const s of sockets) s.destroy();
        terminator.closeAllConnections();
        server.close(() => r());
      });
      resolve(state);
    });
  });
}

async function setupTls() {
  const { pem, fingerprint256 } = await fetchServerCertificate(TLS_URL);
  const admin = await adminPeer(cfg, TLS_URL, { ca: [pem], setupToken: cfg.tlsSetupToken });
  const user = await createUser(admin, 'tls');
  const web = await createWebPeer(TLS_URL, { ca: [pem] });
  await web.login(user.username, user.password);
  const wv = web.vault();
  await wv.load();
  await wv.initialize('tls master password');
  await wv.saveItem({ plain: { type: 'login', name: 'Over TLS', login: { username: 'u', password: 'p', uris: [{ uri: 'https://example.com' }] } }, folderId: null });
  return { pem, fingerprint256, user, web };
}

async function grant(popup, url) {
  assert.equal(await popup.requestServerPermission(url), true);
}

test('setup-required servers are refused before any credential is sent', { skip, timeout: 60_000 }, async (t) => {
  const { pem } = await fetchServerCertificate(TLS_URL);
  const st = await (await createWebPeer(TLS_URL, { ca: [pem] })).api.get('/setup/status', { noRedirect: true });
  if (!st.setup_required) return t.skip('TLS server already set up (run against a fresh data dir to cover this)');
  const ext = await installExtension('chrome');
  t.after(() => ext.dispose());
  await ext.startBackground({ installReason: 'install' });
  ext.browser.network.trust(pem);
  const popup = await ext.openPopup();
  await grant(popup, TLS_URL);
  const probe = await popup.call('server.probe', { serverUrl: TLS_URL });
  assert.equal(probe.setupRequired, true);
  await assert.rejects(popup.call('auth.login', { serverUrl: TLS_URL, username: 'x', password: 'y' }), (e) => e.code === 'setup_required');
  assert.ok(!ext.browser.network.log.some((r) => r.url.endsWith('/auth/login')), 'no login request was made');
});

test('Firefox: certificate read from the TLS connection, interception refused', { skip, timeout: 180_000 }, async (t) => {
  const env = await setupTls();
  const mitm = makeCert();
  const front = await startFront(TLS_URL, mitm);
  t.after(() => front.close());
  const ext = await installExtension('firefox');
  t.after(() => ext.dispose());
  await ext.startBackground({ installReason: 'install' });
  const popup = await ext.openPopup();
  await grant(popup, front.url);

  await t.test('untrusted self-signed certificate → network error with guidance', async () => {
    await assert.rejects(popup.call('server.probe', { serverUrl: front.url }), (e) => e.code === 'network_error');
  });

  await t.test('trusted → fingerprint from TLS, equal to the server-reported and logged one; pin; sign in; verified', async () => {
    ext.browser.network.trust(env.pem);
    const probe = await popup.call('server.probe', { serverUrl: front.url });
    assert.equal(probe.fingerprintSource, 'tls');
    assert.equal(probe.fingerprint, norm(env.fingerprint256));
    assert.equal(probe.reportedFingerprint, norm(env.fingerprint256));
    assert.equal(probe.interceptionSuspected, false);
    assert.equal(probe.pinStatus, 'new');
    await assert.rejects(popup.call('auth.login', { serverUrl: front.url, username: env.user.username, password: env.user.password }), (e) => e.code === 'server_not_trusted');
    await popup.call('server.trust', { serverUrl: probe.serverUrl, fingerprint: probe.fingerprint });
    const st = await popup.call('auth.login', { serverUrl: front.url, username: env.user.username, password: env.user.password });
    assert.equal(st.phase, 'locked');
    assert.equal(st.pin.source, 'tls');
    assert.equal((await popup.call('vault.unlock', { password: 'tls master password' })).phase, 'unlocked');
    const s2 = await popup.call('state');
    assert.equal(s2.certCheck.verified, true, 'responses verified against the pin');
    assert.deepEqual((await popup.call('items.list', {})).items.map((i) => i.name), ['Over TLS']);
  });

  await t.test('MITM with a browser-trusted certificate: response cancelled, extension stops (cert_changed)', async () => {
    ext.browser.network.trust(mitm.cert); // e.g. a corporate/antivirus CA installed in the profile
    front.mode = 'intercept';
    await assert.rejects(popup.call('vault.sync'), (e) => e.code === 'certificate_changed');
    const st = await popup.call('state');
    assert.equal(st.phase, 'cert_changed');
    assert.equal(st.certProblem.presented, norm(mitm.fingerprint256));
    assert.ok(ext.browser.network.log.some((r) => r.blocked === 'webRequest'), 'blocked by the webRequest listener');
    // probes and a new sign-in are cancelled the same way: no password goes to the interceptor
    const sent = front.seen.length;
    await assert.rejects(popup.call('server.probe', { serverUrl: front.url }), (e) => e.code === 'certificate_changed');
    await assert.rejects(popup.call('auth.login', { serverUrl: front.url, username: env.user.username, password: env.user.password }), (e) => e.code === 'certificate_changed');
    assert.ok(!front.seen.slice(sent).some((s) => s.includes('/auth/login')), 'login never reached the interceptor');
  });

  await t.test('without a pin (first contact through the interceptor) Firefox flags presented ≠ reported', async () => {
    const ff = await installExtension('firefox');
    try {
      await ff.startBackground({ installReason: 'install' });
      ff.browser.network.trust(mitm.cert);
      const p = await ff.openPopup();
      await grant(p, front.url);
      const probe = await p.call('server.probe', { serverUrl: front.url });
      assert.equal(probe.fingerprint, norm(mitm.fingerprint256));
      assert.equal(probe.reportedFingerprint, norm(env.fingerprint256));
      assert.equal(probe.interceptionSuspected, true);
      await assert.rejects(p.call('auth.login', { serverUrl: front.url, username: env.user.username, password: env.user.password }), (e) => e.code === 'certificate_changed');
    } finally {
      await ff.dispose();
    }
  });

  await t.test('interception gone: re-confirming the original certificate restores access', async () => {
    front.mode = 'pass';
    await assert.rejects(popup.call('server.trust', { serverUrl: front.url, fingerprint: norm(mitm.fingerprint256) }), (e) => e.code === 'fingerprint_mismatch');
    await popup.call('server.trust', { serverUrl: front.url, fingerprint: norm(env.fingerprint256) });
    const st = await popup.call('vault.sync');
    assert.equal(st.phase, 'unlocked');
  });
});

test('Chrome: server-reported fingerprint pin catches certificate changes (not a browser-trusted MITM)', { skip, timeout: 180_000 }, async (t) => {
  const env = await setupTls();
  const mitm = makeCert();
  const front = await startFront(TLS_URL, mitm);
  t.after(() => front.close());
  const ext = await installExtension('chrome');
  t.after(() => ext.dispose());
  await ext.startBackground({ installReason: 'install' });
  const popup = await ext.openPopup();
  await grant(popup, front.url);
  ext.browser.network.trust(env.pem);

  await t.test('TOFU with the server-reported fingerprint', async () => {
    const probe = await popup.call('server.probe', { serverUrl: front.url });
    assert.equal(probe.fingerprintSource, 'server');
    assert.equal(probe.fingerprint, norm(env.fingerprint256), 'reported = certificate the browser received');
    assert.equal(probe.pinStatus, 'new');
    await popup.call('server.trust', { serverUrl: probe.serverUrl, fingerprint: probe.fingerprint });
    await popup.call('auth.login', { serverUrl: front.url, username: env.user.username, password: env.user.password });
    assert.equal((await popup.call('vault.unlock', { password: 'tls master password' })).phase, 'unlocked');
  });

  await t.test('documented limitation: a MITM the browser trusts is not visible to a Chrome extension', async () => {
    ext.browser.network.trust(mitm.cert);
    front.mode = 'intercept';
    const st = await popup.call('vault.sync');
    assert.equal(st.phase, 'unlocked');
    assert.ok(front.seen.some((s) => s.startsWith('intercept GET /api/v1/vault/sync')));
  });

  await t.test('certificate change (reported fingerprint differs) → cert_changed until re-confirmed', async () => {
    front.mode = 'rotate';
    await assert.rejects(popup.call('vault.sync'), (e) => e.code === 'certificate_changed');
    let st = await popup.call('state');
    assert.equal(st.phase, 'cert_changed');
    assert.equal(st.certProblem.presented, norm(mitm.fingerprint256));
    // nothing authenticated is sent until the user re-confirms (no token, no ciphertext)
    const sent = front.seen.length;
    await assert.rejects(popup.call('items.save', { data: { type: 'note', name: 'x', notes: '' } }), (e) => e.code === 'certificate_changed');
    await assert.rejects(popup.call('vault.sync'), (e) => e.code === 'certificate_changed');
    assert.deepEqual(front.seen.slice(sent).filter((s) => !s.endsWith('/api/v1/setup/status')), [], 'only unauthenticated probes went out');
    await popup.call('server.trust', { serverUrl: front.url, fingerprint: st.certProblem.presented });
    st = await popup.call('vault.sync');
    assert.equal(st.phase, 'unlocked');
    assert.equal(st.pin.fingerprint, norm(mitm.fingerprint256));
  });
});
