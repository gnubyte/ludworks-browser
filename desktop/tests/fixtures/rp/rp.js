// A minimal, strict WebAuthn relying party in the page (no server): registers a passkey and
// verifies assertions exactly like a server would (clientDataJSON, rpIdHash, flags, ES256 signature
// over authenticatorData || SHA-256(clientDataJSON) with the registered public key).
const rpId = location.hostname;
const te = new TextEncoder();
const out = (o) => (document.getElementById('out').textContent = JSON.stringify(o, null, 1));
const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const sha256 = async (b) => new Uint8Array(await crypto.subtle.digest('SHA-256', b));
const eq = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
let challenge = null;
let stored = null; // {id, spki}

function derToRaw(der) {
  // ECDSA-Sig-Value ::= SEQUENCE { r INTEGER, s INTEGER } → r||s (32 bytes each)
  let i = 2;
  const int = () => {
    if (der[i++] !== 0x02) throw new Error('bad DER');
    let len = der[i++];
    let v = der.slice(i, i + len);
    i += len;
    while (v.length > 32 && v[0] === 0) v = v.slice(1);
    const o = new Uint8Array(32);
    o.set(v, 32 - v.length);
    return o;
  };
  const r = int();
  const s = int();
  const raw = new Uint8Array(64);
  raw.set(r);
  raw.set(s, 32);
  return raw;
}

async function checkClientData(cdjBuf, type) {
  const cd = JSON.parse(new TextDecoder().decode(cdjBuf));
  if (cd.type !== type) throw new Error(`type ${cd.type}`);
  if (cd.challenge !== b64u(challenge)) throw new Error('challenge mismatch');
  if (cd.origin !== location.origin) throw new Error(`origin ${cd.origin}`);
  return cd;
}

export async function register() {
  challenge = crypto.getRandomValues(new Uint8Array(32));
  const cred = await navigator.credentials.create({
    publicKey: {
      rp: { name: 'LW Test RP', id: rpId },
      user: { id: crypto.getRandomValues(new Uint8Array(16)), name: 'tester@localhost', displayName: 'Tester' },
      challenge,
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
      authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
      attestation: 'none',
      extensions: { credProps: true },
    },
  });
  if (!(cred instanceof PublicKeyCredential)) throw new Error('not a PublicKeyCredential');
  if (!(cred.response instanceof AuthenticatorAttestationResponse)) throw new Error('not an attestation response');
  await checkClientData(cred.response.clientDataJSON, 'webauthn.create');
  const auth = new Uint8Array(cred.response.getAuthenticatorData());
  if (!eq(auth.slice(0, 32), await sha256(te.encode(rpId)))) throw new Error('rpIdHash mismatch');
  if ((auth[32] & 0x41) !== 0x41) throw new Error('UP/AT flags missing');
  if (cred.response.getPublicKeyAlgorithm() !== -7) throw new Error('alg');
  stored = { id: cred.id, spki: cred.response.getPublicKey() };
  const r = { ok: true, id: cred.id, flags: auth[32].toString(16), credProps: cred.getClientExtensionResults().credProps || null, transports: cred.response.getTransports(), json: !!cred.toJSON().response.attestationObject };
  out(r);
  return r;
}

export async function authenticate({ conditional = false } = {}) {
  challenge = crypto.getRandomValues(new Uint8Array(32));
  const a = await navigator.credentials.get({ publicKey: { challenge, rpId, allowCredentials: [], userVerification: 'preferred' }, mediation: conditional ? 'conditional' : undefined });
  if (!(a.response instanceof AuthenticatorAssertionResponse)) throw new Error('not an assertion response');
  await checkClientData(a.response.clientDataJSON, 'webauthn.get');
  const auth = new Uint8Array(a.response.authenticatorData);
  if (!eq(auth.slice(0, 32), await sha256(te.encode(rpId)))) throw new Error('rpIdHash mismatch');
  if (!(auth[32] & 0x01)) throw new Error('UP flag missing');
  if (!stored || stored.id !== a.id) throw new Error('unknown credential');
  const key = await crypto.subtle.importKey('spki', stored.spki, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  const signed = new Uint8Array([...auth, ...(await sha256(a.response.clientDataJSON))]);
  const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, derToRaw(new Uint8Array(a.response.signature)), signed);
  const r = { ok, id: a.id, flags: auth[32].toString(16), counter: new DataView(auth.buffer).getUint32(33), userHandle: a.response.userHandle ? b64u(a.response.userHandle) : null };
  out(r);
  return r;
}

window.rp = { register, authenticate, uvpaa: () => PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable(), cma: () => PublicKeyCredential.isConditionalMediationAvailable() };
document.getElementById('reg').addEventListener('click', () => register().catch((e) => out({ error: String(e) })));
document.getElementById('auth').addEventListener('click', () => authenticate().catch((e) => out({ error: String(e) })));
document.getElementById('login').addEventListener('submit', (e) => {
  e.preventDefault();
  out({ submitted: document.getElementById('user').value });
});
