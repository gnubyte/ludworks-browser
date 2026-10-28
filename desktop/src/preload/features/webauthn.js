// Passkeys: route the page's WebAuthn calls (navigator.credentials.create/get with `publicKey`) to the
// browser's own authenticator (VAULT-CRYPTO.md §10), which asks the user in browser UI and signs with
// passkeys from the Ludworks vault. "Use another device or security key" (or no Ludworks account)
// hands the original call to the platform's WebAuthn.
//
// The main-world part is installed with contextBridge.executeInMainWorld, so the page never sees a
// global bridge object; the bridge functions it holds can only ask — the browser derives the origin
// from the calling frame and decides everything else itself.

export function setupWebAuthn() {
  const { contextBridge, ipcRenderer } = require('electron');
  if (!window.isSecureContext) return;
  if (!/^https?:$/.test(location.protocol)) return;
  const bridge = {
    create: (json) => ipcRenderer.invoke('content-call', 'webauthn.create', { options: String(json) }),
    get: (json, conditional) => ipcRenderer.invoke('content-call', 'webauthn.get', { options: String(json), conditional: !!conditional }),
    cancel: (id) => ipcRenderer.send('content', 'webauthn.cancel', { id: String(id) }),
  };
  try {
    if (typeof contextBridge.executeInMainWorld === 'function') contextBridge.executeInMainWorld({ func: installWebAuthnShim, args: [bridge] });
  } catch {
    /* page keeps the platform WebAuthn */
  }
}

// ---------------------------------------------------------------------------------------------------
// Runs in the page's main world. Must be self-contained (it is serialised): no outer references.
export function installWebAuthnShim(bridge) {
  const C = window.navigator.credentials;
  if (!C || typeof window.PublicKeyCredential !== 'function' || C.__ludworks) return;
  const origCreate = C.create.bind(C);
  const origGet = C.get.bind(C);
  const PKC = window.PublicKeyCredential;
  const AttResp = window.AuthenticatorAttestationResponse;
  const AsrResp = window.AuthenticatorAssertionResponse;
  const DOMEx = window.DOMException;
  const toU8 = (v) => (v instanceof ArrayBuffer ? new Uint8Array(v) : ArrayBuffer.isView(v) ? new Uint8Array(v.buffer, v.byteOffset, v.byteLength) : null);
  const b64u = (v) => {
    const u = toU8(v);
    if (!u) return null;
    let s = '';
    for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  };
  const fromB64u = (s) => {
    const b = atob(String(s).replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((String(s).length + 3) % 4));
    const u = new Uint8Array(b.length);
    for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i);
    return u.buffer;
  };
  const mk = (proto, props) => {
    const o = Object.create(proto);
    for (const k of Object.keys(props)) Object.defineProperty(o, k, { value: props[k], enumerable: true, configurable: true });
    return o;
  };
  const cred = (list) => (Array.isArray(list) ? list.map((c) => ({ type: c && c.type, id: b64u(c && c.id), transports: c && Array.isArray(c.transports) ? c.transports.map(String) : undefined })).filter((c) => c.id) : []);
  const fail = (r) => {
    throw new DOMEx(String(r.message || 'The operation failed.'), String(r.error || 'NotAllowedError'));
  };
  const withAbort = (signal, p, onAbort) =>
    new Promise((resolve, reject) => {
      if (signal && signal.aborted) return reject(signal.reason || new DOMEx('The operation was aborted.', 'AbortError'));
      const ab = () => {
        onAbort();
        reject(signal.reason || new DOMEx('The operation was aborted.', 'AbortError'));
      };
      if (signal) signal.addEventListener('abort', ab, { once: true });
      p.then(resolve, reject).finally(() => signal && signal.removeEventListener('abort', ab));
    });
  let seq = 0;

  function buildCreate(r) {
    const resp = mk(AttResp.prototype, {
      clientDataJSON: fromB64u(r.clientDataJSON),
      attestationObject: fromB64u(r.attestationObject),
      getTransports: () => ['internal', 'hybrid'],
      getAuthenticatorData: () => fromB64u(r.authenticatorData),
      getPublicKey: () => fromB64u(r.publicKey),
      getPublicKeyAlgorithm: () => -7,
    });
    const json = () => ({ id: r.id, rawId: r.id, type: 'public-key', authenticatorAttachment: 'platform', clientExtensionResults: r.extensions || {}, response: { clientDataJSON: r.clientDataJSON, attestationObject: r.attestationObject, authenticatorData: r.authenticatorData, publicKey: r.publicKey, publicKeyAlgorithm: -7, transports: ['internal', 'hybrid'] } });
    return mk(PKC.prototype, { id: r.id, rawId: fromB64u(r.id), type: 'public-key', authenticatorAttachment: 'platform', response: resp, getClientExtensionResults: () => r.extensions || {}, toJSON: json });
  }

  function buildGet(r) {
    const resp = mk(AsrResp.prototype, {
      clientDataJSON: fromB64u(r.clientDataJSON),
      authenticatorData: fromB64u(r.authenticatorData),
      signature: fromB64u(r.signature),
      userHandle: r.userHandle ? fromB64u(r.userHandle) : null,
    });
    const json = () => ({ id: r.id, rawId: r.id, type: 'public-key', authenticatorAttachment: 'platform', clientExtensionResults: r.extensions || {}, response: { clientDataJSON: r.clientDataJSON, authenticatorData: r.authenticatorData, signature: r.signature, userHandle: r.userHandle || null } });
    return mk(PKC.prototype, { id: r.id, rawId: fromB64u(r.id), type: 'public-key', authenticatorAttachment: 'platform', response: resp, getClientExtensionResults: () => r.extensions || {}, toJSON: json });
  }

  const create = function create(options) {
    const pk = options && options.publicKey;
    if (!pk) return origCreate(options);
    const req = {
      rp: { id: pk.rp && pk.rp.id, name: pk.rp && pk.rp.name },
      user: { id: b64u(pk.user && pk.user.id), name: pk.user && pk.user.name, displayName: pk.user && pk.user.displayName },
      challenge: b64u(pk.challenge),
      pubKeyCredParams: Array.isArray(pk.pubKeyCredParams) ? pk.pubKeyCredParams.map((p) => ({ type: p && p.type, alg: p && p.alg })) : [],
      excludeCredentials: cred(pk.excludeCredentials),
      authenticatorSelection: pk.authenticatorSelection ? { residentKey: pk.authenticatorSelection.residentKey, requireResidentKey: !!pk.authenticatorSelection.requireResidentKey, userVerification: pk.authenticatorSelection.userVerification, authenticatorAttachment: pk.authenticatorSelection.authenticatorAttachment } : {},
      attestation: pk.attestation,
      extensions: pk.extensions && pk.extensions.credProps ? { credProps: true } : {},
      timeout: pk.timeout,
    };
    const id = ++seq;
    return withAbort(
      options.signal,
      bridge.create(JSON.stringify({ ...req, requestId: id })).then((r) => {
        if (r && r.fallback) return origCreate(options);
        if (!r || r.error) return fail(r || {});
        return buildCreate(r);
      }),
      () => bridge.cancel(id),
    );
  };

  const get = function get(options) {
    const pk = options && options.publicKey;
    if (!pk) return origGet(options);
    const req = {
      rpId: pk.rpId,
      challenge: b64u(pk.challenge),
      allowCredentials: cred(pk.allowCredentials),
      userVerification: pk.userVerification,
      timeout: pk.timeout,
      mediation: options.mediation,
    };
    const id = ++seq;
    const conditional = options.mediation === 'conditional';
    return withAbort(
      options.signal,
      bridge.get(JSON.stringify({ ...req, requestId: id }), conditional).then((r) => {
        if (r && r.fallback) return origGet(options);
        if (!r || r.error) return fail(r || {});
        return buildGet(r);
      }),
      () => bridge.cancel(id),
    );
  };

  const def = (obj, name, fn) => Object.defineProperty(obj, name, { value: fn, configurable: true, writable: true, enumerable: false });
  def(C, 'create', create);
  def(C, 'get', get);
  def(C, '__ludworks', true);
  def(PKC, 'isUserVerifyingPlatformAuthenticatorAvailable', () => Promise.resolve(true));
  def(PKC, 'isConditionalMediationAvailable', () => Promise.resolve(true));
  const origCaps = typeof PKC.getClientCapabilities === 'function' ? PKC.getClientCapabilities.bind(PKC) : null;
  def(PKC, 'getClientCapabilities', async () => ({ ...(origCaps ? await origCaps().catch(() => ({})) : {}), conditionalGet: true, conditionalCreate: false, passkeyPlatformAuthenticator: true, userVerifyingPlatformAuthenticator: true, hybridTransport: true }));
}
