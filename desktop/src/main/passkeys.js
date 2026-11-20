// WebAuthn authenticator backed by passkeys stored in the Ludworks vault (VAULT-CRYPTO.md §3, §10).
//
// The page asks through the tab preload; everything that matters is decided here: the origin comes
// from the calling frame as the browser knows it, the RP ID is checked against the Public Suffix
// List, the user confirms in a browser-owned dialog, and private keys never leave the main process.

import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { encode, CborMap } from './cbor.js';
import { registrableDomain, hasRegistrableDomain, isLocalhost } from '../lib/url-match.js';
import { log } from './util/log.js';

export const AAGUID = Buffer.from('a70a1e9f20e74d33a38e04115decb9c6', 'hex');
const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_BE = 0x08;
const FLAG_BS = 0x10;
const FLAG_AT = 0x40;
const UV_FRESH_MS = 15 * 60 * 1000;
const MAX_OPTIONS = 64 * 1024;

export const b64u = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const fromB64u = (s) => Buffer.from(String(s || '').replace(/-/g, '+').replace(/_/g, '/'), 'base64');
const sha256 = (b) => createHash('sha256').update(b).digest();

/**
 * Origin and RP ID checks (§10). Throws {name, message} for the page.
 * @param {Electron.WebFrameMain} frame
 * @param {string|undefined} requested
 */
export function checkRp(frame, requested) {
  const bad = (name, message) => Object.assign(new Error(message), { webauthn: name });
  let u;
  try {
    u = new URL(frame.url);
  } catch {
    throw bad('SecurityError', 'Invalid document URL.');
  }
  const secure = u.protocol === 'https:' || (u.protocol === 'http:' && isLocalhost(u.hostname));
  if (!secure) throw bad('SecurityError', 'WebAuthn needs a secure context.');
  const top = frame.top || frame;
  if (top !== frame) {
    let topOrigin = '';
    try {
      topOrigin = new URL(top.url).origin;
    } catch {
      topOrigin = '';
    }
    if (topOrigin !== u.origin) throw bad('NotAllowedError', 'Passkeys in cross-origin frames are not supported.');
  }
  const host = u.hostname.toLowerCase();
  const rpId = String(requested || host).toLowerCase().replace(/\.$/, '');
  if (!rpId || rpId.length > 253) throw bad('SecurityError', 'Invalid RP ID.');
  if (rpId !== host) {
    const isIp = /^[\d.]+$/.test(host) || host.startsWith('[');
    if (isIp || !host.endsWith(`.${rpId}`) || !hasRegistrableDomain(rpId) || registrableDomain(host) !== registrableDomain(rpId)) {
      throw bad('SecurityError', `The RP ID "${rpId}" is not valid for ${host}.`);
    }
  }
  return { origin: u.origin, rpId, host };
}

/** clientDataJSON with the member order WebAuthn specifies. */
export function clientDataJSON(type, challengeB64u, origin) {
  return Buffer.from(`{"type":${JSON.stringify(type)},"challenge":${JSON.stringify(challengeB64u)},"origin":${JSON.stringify(origin)},"crossOrigin":false}`, 'utf8');
}

export function coseKey(publicKey) {
  const jwk = publicKey.export({ format: 'jwk' });
  return encode(new CborMap([[1, 2], [3, -7], [-1, 1], [-2, fromB64u(jwk.x)], [-3, fromB64u(jwk.y)]]));
}

export function authenticatorData(rpId, flags, counter, attested = null) {
  const head = Buffer.alloc(37);
  sha256(Buffer.from(rpId, 'utf8')).copy(head, 0);
  head[32] = flags;
  head.writeUInt32BE(counter >>> 0, 33);
  return attested ? Buffer.concat([head, attested]) : head;
}

/** Create a new ES256 passkey record and the registration response. */
export function makeCredential({ rpId, rpName, user, challenge, origin, uv = true }) {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const credId = randomBytes(16);
  const lenBuf = Buffer.alloc(2);
  lenBuf.writeUInt16BE(credId.length, 0);
  const attested = Buffer.concat([AAGUID, lenBuf, credId, coseKey(publicKey)]);
  const flags = FLAG_UP | (uv ? FLAG_UV : 0) | FLAG_BE | FLAG_BS | FLAG_AT;
  const authData = authenticatorData(rpId, flags, 0, attested);
  const attObj = encode(new CborMap([['fmt', 'none'], ['attStmt', new CborMap([])], ['authData', authData]]));
  const cdj = clientDataJSON('webauthn.create', challenge, origin);
  const passkey = {
    credential_id: b64u(credId),
    rp_id: rpId,
    rp_name: String(rpName || rpId).slice(0, 200),
    user_handle: String(user.id || ''),
    user_name: String(user.name || '').slice(0, 320),
    user_display_name: String(user.displayName || '').slice(0, 320),
    algorithm: -7,
    private_key: b64u(privateKey.export({ format: 'der', type: 'pkcs8' })),
    counter: 0,
    discoverable: true,
    created_at: new Date().toISOString(),
  };
  const response = {
    id: passkey.credential_id,
    clientDataJSON: b64u(cdj),
    attestationObject: b64u(attObj),
    authenticatorData: b64u(authData),
    publicKey: b64u(publicKey.export({ format: 'der', type: 'spki' })),
  };
  return { passkey, response };
}

/** Sign an assertion with a stored passkey. Returns the response and the counter to store. */
export function getAssertion({ passkey, rpId, challenge, origin, uv = true, now = Date.now() }) {
  const key = createPrivateKey({ key: fromB64u(passkey.private_key), format: 'der', type: 'pkcs8' });
  if (key.asymmetricKeyType !== 'ec' || (key.asymmetricKeyDetails && key.asymmetricKeyDetails.namedCurve !== 'prime256v1')) throw new Error('unsupported key');
  const stored = Number.isSafeInteger(passkey.counter) && passkey.counter > 0 ? passkey.counter : 0;
  const counter = stored === 0 ? 0 : Math.min(0xffffffff, Math.max(stored + 1, Math.floor(now / 1000)));
  const flags = FLAG_UP | (uv ? FLAG_UV : 0) | FLAG_BE | FLAG_BS;
  const authData = authenticatorData(rpId, flags, counter);
  const cdj = clientDataJSON('webauthn.get', challenge, origin);
  const signature = sign('sha256', Buffer.concat([authData, sha256(cdj)]), key); // DER (ASN.1) ECDSA, as WebAuthn expects
  return {
    counter,
    response: {
      id: passkey.credential_id,
      clientDataJSON: b64u(cdj),
      authenticatorData: b64u(authData),
      signature: b64u(signature),
      userHandle: passkey.discoverable === false ? null : passkey.user_handle || null,
    },
  };
}

/** Does a stored passkey's key parse as a P-256 private key? (imports) */
export function validPasskeyKey(pkcs8b64u) {
  try {
    const k = createPrivateKey({ key: fromB64u(pkcs8b64u), format: 'der', type: 'pkcs8' });
    return k.asymmetricKeyType === 'ec' && (!k.asymmetricKeyDetails || k.asymmetricKeyDetails.namedCurve === 'prime256v1');
  } catch {
    return false;
  }
}

export function publicKeyOf(pkcs8b64u) {
  return createPublicKey(createPrivateKey({ key: fromB64u(pkcs8b64u), format: 'der', type: 'pkcs8' }));
}

// ---------------------------------------------------------------------------------------------------
export class Passkeys {
  /** @param {import('./browser.js').Browser} browser */
  constructor(browser) {
    this.b = browser;
    this.conditional = new Map(); // key → {tabId, frame, rpId, allow, challenge, origin, uv, resolve}
  }

  /** Passkeys stored for an RP (unlocked vault only). */
  async candidates(rpId, allow = []) {
    const out = [];
    const allowSet = new Set(allow.map((c) => c.id));
    for (const it of await this.b.account.logins()) {
      for (const pk of Array.isArray(it.data.login.passkeys) ? it.data.login.passkeys : []) {
        if (!pk || pk.rp_id !== rpId || pk.algorithm !== -7 || typeof pk.private_key !== 'string') continue;
        if (allowSet.size && !allowSet.has(pk.credential_id)) continue;
        if (!allowSet.size && pk.discoverable === false) continue;
        out.push({ itemId: it.id, itemName: it.data.name, passkey: pk, key: `${it.id}:${pk.credential_id}` });
      }
    }
    return out;
  }

  async call(tab, frame, cmd, args) {
    try {
      if (!this.b.prefs.get('passkeys')) return { fallback: true };
      if (!frame || typeof args.options !== 'string' || args.options.length > MAX_OPTIONS) return { error: 'NotAllowedError', message: 'Bad request.' };
      const opts = JSON.parse(args.options);
      const acct = this.b.account;
      if (acct.phase() === 'logged_out') return { fallback: true };
      if (cmd === 'webauthn.create') return await this.create(tab, frame, opts);
      if (cmd === 'webauthn.get') return await this.get(tab, frame, opts, !!args.conditional);
      return { error: 'NotSupportedError', message: 'Unsupported.' };
    } catch (e) {
      if (e && e.webauthn) return { error: e.webauthn, message: e.message };
      log.warn('passkey request failed', { message: e && e.message });
      return { error: 'NotAllowedError', message: 'The operation failed.' };
    }
  }

  needsPassword(uvPref) {
    return uvPref === 'required' && Date.now() - this.b.account.vault.unlockedWithPassword > UV_FRESH_MS;
  }

  async ensureUnlocked(ans) {
    const acct = this.b.account;
    if (ans && typeof ans.password === 'string' && ans.password) {
      if (!acct.vault.isUnlocked()) await acct.unlock(ans.password, { remember: null });
      else if (!(await acct.vault.verifyPassword(ans.password))) throw Object.assign(new Error('Wrong master password.'), { webauthn: 'NotAllowedError' });
    }
    if (!acct.vault.isUnlocked()) throw Object.assign(new Error('The vault is locked.'), { webauthn: 'NotAllowedError' });
  }

  async create(tab, frame, o) {
    const { origin, rpId } = checkRp(frame, o.rp && o.rp.id);
    const params = Array.isArray(o.pubKeyCredParams) ? o.pubKeyCredParams : [];
    if (params.length && !params.some((p) => p && p.type === 'public-key' && p.alg === -7)) return { fallback: true };
    const sel = o.authenticatorSelection || {};
    if (sel.authenticatorAttachment === 'cross-platform') return { fallback: true };
    if (typeof o.challenge !== 'string' || !o.user || typeof o.user.id !== 'string' || fromB64u(o.user.id).length < 1 || fromB64u(o.user.id).length > 64) {
      return { error: 'TypeError', message: 'Invalid options.' };
    }
    const acct = this.b.account;
    const locked = !acct.vault.isUnlocked();
    let excluded = false;
    let logins = [];
    if (!locked) {
      const ex = new Set((o.excludeCredentials || []).map((c) => c.id));
      excluded = (await this.candidates(rpId)).some((c) => ex.has(c.passkey.credential_id));
      logins = (await this.b.autofill.loginsForUrl(frame.url)).map((l) => ({ id: l.id, name: l.data.name, username: (l.data.login && l.data.login.username) || '' }));
    }
    tab.ctl.activate(tab.id);
    const ans = await tab.ctl.ask('passkey-create', {
      rpId,
      rpName: String((o.rp && o.rp.name) || rpId).slice(0, 200),
      userName: String(o.user.name || '').slice(0, 320),
      displayName: String(o.user.displayName || '').slice(0, 320),
      locked,
      needsPassword: locked || this.needsPassword(sel.userVerification),
      excluded,
      logins,
    });
    if (!ans) return { error: 'NotAllowedError', message: 'The user cancelled.' };
    if (ans.fallback) return { fallback: true };
    await this.ensureUnlocked(ans);
    if (excluded || (await this.candidates(rpId)).some((c) => new Set((o.excludeCredentials || []).map((x) => x.id)).has(c.passkey.credential_id))) {
      return { error: 'InvalidStateError', message: 'A passkey for this account is already saved in Ludworks.' };
    }
    const { passkey, response } = makeCredential({ rpId, rpName: (o.rp && o.rp.name) || rpId, user: o.user, challenge: o.challenge, origin, uv: true });
    await this.storePasskey(ans.itemId || null, passkey, rpId);
    if (o.extensions && o.extensions.credProps) response.extensions = { credProps: { rk: true } };
    return response;
  }

  async storePasskey(itemId, passkey, rpId) {
    const acct = this.b.account;
    if (itemId) {
      const e = await acct.vault.get(itemId);
      const data = JSON.parse(JSON.stringify(e.data));
      if (data.type !== 'login') throw new Error('not a login');
      data.login.passkeys = [...(Array.isArray(data.login.passkeys) ? data.login.passkeys : []), passkey];
      if (!data.login.username && passkey.user_name) data.login.username = passkey.user_name;
      await acct.vault.save(acct.acc, { id: itemId, data, baseRevision: e.vi.revision });
    } else {
      const now = new Date().toISOString();
      await acct.vault.save(acct.acc, {
        data: {
          type: 'login',
          name: passkey.rp_name || rpId,
          favorite: false,
          notes: '',
          login: { username: passkey.user_name || '', password: '', uris: [{ uri: `https://${rpId}`, match: 'domain' }], totp: '', passkeys: [passkey] },
          fields: [],
          password_history: [],
          created_at: now,
          updated_at: now,
        },
      });
    }
  }

  async get(tab, frame, o, conditional) {
    const { origin, rpId } = checkRp(frame, o.rpId);
    if (typeof o.challenge !== 'string') return { error: 'TypeError', message: 'Invalid options.' };
    const allow = Array.isArray(o.allowCredentials) ? o.allowCredentials : [];
    const acct = this.b.account;
    if (conditional) {
      // Resolved when the user picks a passkey in the autofill dropdown (or aborted by the page).
      return new Promise((resolve) => {
        const key = `${tab.id}:${o.requestId}`;
        this.conditional.set(key, { tabId: tab.id, frame, rpId, allow, challenge: o.challenge, origin, uv: o.userVerification, resolve });
        this.b.autofill.refreshTab(tab);
        // the page asked after its sign-in field already had focus and a dropdown: show it again with the passkeys
        this.b.autofill.refreshDropdown(tab);
      });
    }
    const locked = !acct.vault.isUnlocked();
    const list = locked ? [] : await this.candidates(rpId, allow);
    if (!locked && !list.length) return { fallback: true };
    tab.ctl.activate(tab.id);
    const ans = await tab.ctl.ask('passkey-get', {
      rpId,
      locked,
      needsPassword: locked || this.needsPassword(o.userVerification),
      candidates: list.map((c) => ({ key: c.key, userName: c.passkey.user_name, displayName: c.passkey.user_display_name, itemName: c.itemName })),
    });
    if (!ans) return { error: 'NotAllowedError', message: 'The user cancelled.' };
    if (ans.fallback) return { fallback: true };
    await this.ensureUnlocked(ans);
    const all = await this.candidates(rpId, allow);
    const chosen = all.find((c) => c.key === ans.key) || (all.length === 1 ? all[0] : null);
    if (!chosen) return all.length ? { error: 'NotAllowedError', message: 'No passkey chosen.' } : { fallback: true };
    return this.sign(chosen, rpId, o.challenge, origin);
  }

  async sign(chosen, rpId, challenge, origin) {
    const { counter, response } = getAssertion({ passkey: chosen.passkey, rpId, challenge, origin, uv: true });
    if (counter !== 0) {
      // keep the counter monotonic across devices: write it back before answering
      const acct = this.b.account;
      const e = await acct.vault.get(chosen.itemId);
      const data = JSON.parse(JSON.stringify(e.data));
      for (const pk of data.login.passkeys || []) if (pk.credential_id === chosen.passkey.credential_id) pk.counter = counter;
      await acct.vault.save(acct.acc, { id: chosen.itemId, data, baseRevision: e.vi.revision });
    }
    return response;
  }

  /** Pending conditional requests of a tab, with their candidates (for the autofill dropdown). */
  async conditionalFor(tab) {
    const out = [];
    for (const [key, c] of this.conditional) {
      if (c.tabId !== tab.id) continue;
      if (c.frame.isDestroyed && c.frame.isDestroyed()) {
        this.conditional.delete(key);
        continue;
      }
      const list = this.b.account.vault.isUnlocked() ? await this.candidates(c.rpId, c.allow) : [];
      for (const x of list) out.push({ requestKey: key, key: x.key, userName: x.passkey.user_name, displayName: x.passkey.user_display_name, itemName: x.itemName, rpId: c.rpId });
    }
    return out;
  }

  async completeConditional(requestKey, candidateKey) {
    const c = this.conditional.get(requestKey);
    if (!c) return false;
    const list = await this.candidates(c.rpId, c.allow);
    const chosen = list.find((x) => x.key === candidateKey);
    if (!chosen) return false;
    this.conditional.delete(requestKey);
    try {
      c.resolve(await this.sign(chosen, c.rpId, c.challenge, c.origin));
    } catch (e) {
      c.resolve({ error: 'NotAllowedError', message: (e && e.message) || 'Failed.' });
    }
    return true;
  }

  cancel(tab, id) {
    const key = `${tab.id}:${id}`;
    const c = this.conditional.get(key);
    if (c) {
      this.conditional.delete(key);
      c.resolve({ error: 'AbortError', message: 'Aborted.' });
    }
  }

  onTabClosed(tab) {
    for (const [key, c] of this.conditional) if (c.tabId === tab.id) this.conditional.delete(key);
  }

  async shellCommand() {
    return null;
  }

  async popupAction() {
    return null;
  }
}
