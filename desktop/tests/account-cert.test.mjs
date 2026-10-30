// The Ludworks server's self-signed certificate over time (src/main/account/account.js): an announced
// renewal is accepted ahead of the switch and becomes the pin once the server presents it; a forged
// announcement (fingerprint and certificate disagree) is ignored; an unannounced new certificate is
// reported for the user to confirm, and confirming it while signed in updates the pin. Electron, the
// transport and the vault are fakes; the certificate is a real Ludworks self-signed leaf.
import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { X509Certificate } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ELECTRON = `
export const app = { on() {} };
export const powerMonitor = { on() {}, getSystemIdleTime: () => 0 };
export const safeStorage = { isEncryptionAvailable: () => false };
export const session = { fromPartition: () => ({ setCertificateVerifyProc() {}, setPermissionRequestHandler() {} }) };
`;
registerHooks({
  resolve: (spec, ctx, next) => (spec === 'electron' ? { url: `data:text/javascript,${encodeURIComponent(ELECTRON)}`, shortCircuit: true } : next(spec, ctx)),
});
const { Account } = await import('../build/app/main/account/account.js');

const PEM = readFileSync(new URL('./fixtures/certs/server-leaf.crt', import.meta.url), 'utf8');
const NEXT = new X509Certificate(PEM).fingerprint256.replace(/:/g, '').toLowerCase();
const PIN = 'a'.repeat(64);
const HOST = 'nas.example';

function signedIn(t, status) {
  const dir = mkdtempSync(path.join(tmpdir(), 'lw-cert-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const meta = new Map();
  const b = { profileDir: dir, db: { getMeta: (k, d) => (meta.has(k) ? meta.get(k) : d), setMeta: (k, v) => meta.set(k, v) }, prefs: { get: () => false }, broadcastShared() {}, forEachWindow() {}, allTabs: () => [], pinnedHosts: new Map(), pinnedNext: new Map() };
  const account = new Account(b);
  t.after(() => account.stop());
  account.acc = { serverUrl: `https://${HOST}:8444`, token: 't', user: { id: '1', username: 'pat', display_name: '' }, pin: PIN };
  const seen = { fingerprint: PIN, pem: 'x', trusted: false };
  account.transport = {
    pins: new Map([[HOST, PIN]]),
    nextPins: new Map(),
    setPin(h, v) { this.pins.set(h, v); },
    setNextPin(h, v) { if (v) this.nextPins.set(h, v); else this.nextPins.delete(h); },
    lastSeen: () => seen,
    api: () => ({ setupStatus: async () => status() }),
  };
  account.vault = { sync: async () => {}, isUnlocked: () => false, warnings: [], meta: { initialized: true }, cache: null, wipe() {}, lock() {} };
  return { account, b, seen };
}

test('an announced renewal is trusted ahead of the switch, then becomes the pin', async (t) => {
  const { account, b, seen } = signedIn(t, () => ({ tls_next_fingerprint_sha256: NEXT.match(/../g).join(':').toUpperCase(), tls_next_certificate: PEM }));
  await account.followCertificate({ force: true });
  assert.equal(account.acc.nextPin, NEXT);
  assert.equal(account.transport.nextPins.get(HOST), NEXT);
  assert.equal(b.pinnedNext.get(HOST), NEXT);
  assert.equal(account.acc.pin, PIN, 'still the old pin until the server switches');

  seen.fingerprint = NEXT; // the server now presents the announced certificate
  await account.followCertificate();
  assert.equal(account.acc.pin, NEXT);
  assert.equal(account.acc.nextPin, null);
  assert.equal(account.transport.pins.get(HOST), NEXT);
  assert.equal(b.pinnedHosts.get(HOST), NEXT);
  assert.equal(b.pinnedNext.has(HOST), false);
});

test('an announcement whose certificate does not match its fingerprint is ignored', async (t) => {
  const { account } = signedIn(t, () => ({ tls_next_fingerprint_sha256: 'b'.repeat(64), tls_next_certificate: PEM }));
  await account.followCertificate({ force: true });
  assert.equal(account.acc.nextPin, undefined);
  assert.equal(account.transport.nextPins.size, 0);
});

test('an unannounced new certificate is reported, and confirming it while signed in re-pins', async (t) => {
  const { account, b, seen } = signedIn(t, () => ({}));
  account.syncNow = async () => {}; // trust() re-syncs; not needed here
  seen.fingerprint = NEXT;
  const c = account.changedCertificate();
  assert.equal(c.trust, 'changed');
  assert.equal(c.fingerprintHex, NEXT);
  assert.match(c.pinned, /^AA:AA/);

  account.trust(c.serverUrl, c.fingerprintHex);
  assert.equal(account.acc.pin, NEXT);
  assert.equal(b.pinnedHosts.get(HOST), NEXT);
  assert.equal(account.changedCertificate(), null);
  assert.equal(account.summary().osTrust.trusted, false);
});
