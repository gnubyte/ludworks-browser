// Transport to the Ludworks server: Chromium's network stack on a private, cookie-less session, with
// trust-on-first-use certificate pinning for self-signed servers.
//
// * A certificate Chromium trusts (public CA, or the OS store) is accepted as usual.
// * An untrusted certificate (Ludworks' default self-signed one) is accepted only when its SHA-256
//   fingerprint equals the pin the user confirmed. Nothing — no credentials, no token — is sent to an
//   unconfirmed or changed certificate: the TLS handshake fails before the request leaves.
// * The certificate actually presented is recorded so the UI can show it for confirmation.

import { session } from 'electron';
import { createApi } from '../../lib/api.js';

const PARTITION = 'lwapi'; // in-memory: no cookies or cache survive

/** Electron "sha256/<base64>" → lowercase hex. */
export function fingerprintHex(electronFp) {
  const m = /^sha256\/(.+)$/.exec(String(electronFp || ''));
  return m ? Buffer.from(m[1], 'base64').toString('hex') : '';
}

/** Any fingerprint notation (hex with/without colons) → lowercase hex, or ''. */
export function normalizeFp(v) {
  const s = String(v || '').replace(/[^0-9a-f]/gi, '').toLowerCase();
  return s.length === 64 ? s : '';
}

export function formatFp(hex) {
  return (hex.match(/.{2}/g) || []).join(':').toUpperCase();
}

export class ServerTransport {
  constructor() {
    this.pins = new Map(); // host → hex fingerprint
    this.seen = new Map(); // host → {fingerprint, trusted (CA), at}
    this.ses = session.fromPartition(PARTITION);
    this.ses.setCertificateVerifyProc((req, cb) => {
      const fp = fingerprintHex(req.certificate.fingerprint);
      const caTrusted = req.verificationResult === 'net::OK';
      this.seen.set(req.hostname, { fingerprint: fp, trusted: caTrusted, at: Date.now(), error: caTrusted ? null : req.verificationResult });
      if (caTrusted) return cb(0); // publicly / OS-trusted certificate for this host name
      const pin = this.pins.get(req.hostname);
      cb(pin && pin === fp ? 0 : -2); // self-signed: exactly the certificate the user confirmed
    });
    this.ses.setPermissionRequestHandler((_wc, _p, cb) => cb(false));
  }

  setPin(host, hex) {
    if (hex) this.pins.set(host, hex);
    else this.pins.delete(host);
  }

  lastSeen(host) {
    return this.seen.get(host) || null;
  }

  fetch(url, init = {}) {
    return this.ses.fetch(url, { ...init, credentials: 'omit', bypassCustomProtocolHandlers: true });
  }

  /** The extension's API client over this transport. */
  api(baseUrl, token = null) {
    return createApi({ baseUrl, token, fetchImpl: (u, i) => this.fetch(u, i), timeoutMs: 30000 });
  }
}
