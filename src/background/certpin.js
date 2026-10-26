// TLS certificate pinning on Firefox.
//
// Firefox exposes the certificate actually presented on a connection through
// webRequest.getSecurityInfo() in a blocking onHeadersReceived listener. We use it to
//   * show the user the fingerprint of the certificate the browser really received (TOFU prompt), and
//   * cancel any response from the Ludworks server whose certificate does not match the pinned fingerprint.
// LIMIT: onHeadersReceived fires after the request (headers, Authorization, body) was already sent on that
// connection. Cancelling hides the response but cannot take back what was sent. So the background never
// sends a token without first seeing the pinned certificate on a fresh response (an unauthenticated probe
// of /setup/status, or another response within the last few seconds): see core.js `guardServer`. A MITM that
// lets the probe's connection through and intercepts a later one is still detected, but only after that
// request went out (README, "TLS and self-signed certificates").
// Chrome has no equivalent API: there the extension relies on the browser trust store and on comparing the
// fingerprint the server reports in /setup/status.

import { normalizeFingerprint, fingerprintsEqual } from '../lib/fingerprint.js';

const MAX_WATCHED = 8;

/**
 * @typedef {{
 *   watch(origin: string, pin: string|null): void,
 *   mark(): number,
 *   observedSince(origin: string, mark: number): {fingerprint: string|null, at: number}|null,
 *   recentlyVerified(origin: string, pin: string, maxAgeMs: number): boolean,
 *   observed(origin: string): string|null,
 *   takeMismatch(origin: string): string|null,
 *   status(origin: string): {mode: 'tls', verified: boolean, at: number|null},
 * }} CertObserver
 */

/**
 * @param {any} ext
 * @param {{now?: () => number}} [opts]
 * @returns {CertObserver|null}
 */
export function createCertObserver(ext, { now = () => Date.now() } = {}) {
  const wr = ext && ext.webRequest;
  if (!wr || typeof wr.getSecurityInfo !== 'function' || !wr.onHeadersReceived) return null;

  const watched = new Map(); // https origin -> normalized pin | null (insertion order = least recently armed first)
  const seen = new Map(); // origin -> {fingerprint, at, verified, seq}
  const mismatches = new Map(); // origin -> presented fingerprint
  let seq = 0;
  let filterKey = '';

  async function onHeaders(details) {
    let u;
    try {
      u = new URL(details.url);
    } catch {
      return {};
    }
    if (u.protocol !== 'https:' || !watched.has(u.origin)) return {};
    const origin = u.origin;
    const pin = watched.get(origin);
    let info = null;
    try {
      info = await wr.getSecurityInfo(details.requestId, {});
    } catch {
      info = null;
    }
    const cert = info && Array.isArray(info.certificates) ? info.certificates[0] : null;
    const fp = normalizeFingerprint(cert && cert.fingerprint && cert.fingerprint.sha256);
    const secure = info && (info.state === 'secure' || info.state === 'weak');
    if (!fp || !secure) {
      if (pin) {
        mismatches.set(origin, fp || 'unavailable');
        seen.set(origin, { fingerprint: null, at: now(), verified: false, seq: ++seq });
        return { cancel: true };
      }
      return {};
    }
    if (pin && !fingerprintsEqual(pin, fp)) {
      mismatches.set(origin, fp);
      seen.set(origin, { fingerprint: fp, at: now(), verified: false, seq: ++seq });
      return { cancel: true };
    }
    seen.set(origin, { fingerprint: fp, at: now(), verified: !!pin, seq: ++seq });
    return {};
  }

  function isRegistered() {
    const ev = wr.onHeadersReceived;
    return typeof ev.hasListener === 'function' ? ev.hasListener(onHeaders) : filterKey !== '';
  }

  /** (Re-)register the single blocking listener so its filter covers exactly the watched hosts. */
  function arm() {
    const urls = [...new Set([...watched.keys()].map((o) => `https://${new URL(o).hostname}/*`))].sort();
    const key = urls.join(' ');
    const registered = isRegistered();
    if (registered && key === filterKey) return; // pins are read live by the listener
    if (registered) wr.onHeadersReceived.removeListener(onHeaders);
    filterKey = '';
    if (!urls.length) return;
    wr.onHeadersReceived.addListener(onHeaders, { urls }, ['blocking']);
    filterKey = key;
  }

  return {
    /** Check responses from `origin` against `pin` (null = observe only). Idempotent and cheap. */
    watch(origin, pin) {
      if (typeof origin !== 'string' || !origin.startsWith('https:')) return;
      const normPin = normalizeFingerprint(pin);
      if (!(watched.has(origin) && watched.get(origin) === normPin)) {
        watched.delete(origin);
        watched.set(origin, normPin);
        while (watched.size > MAX_WATCHED) watched.delete(watched.keys().next().value);
      }
      arm();
    },
    /** Opaque marker: observations made after this call have a greater sequence number. */
    mark() {
      return seq;
    },
    /** The certificate seen on a response from `origin` after `mark` (null when none was seen). */
    observedSince(origin, mark) {
      const s = seen.get(origin);
      return s && s.seq > mark ? { fingerprint: s.fingerprint, at: s.at } : null;
    },
    /** Was the pinned certificate seen on a response from `origin` within the last `maxAgeMs`? */
    recentlyVerified(origin, pin, maxAgeMs) {
      const s = seen.get(origin);
      return !!(s && s.fingerprint && pin && fingerprintsEqual(s.fingerprint, pin) && now() - s.at <= maxAgeMs && now() >= s.at);
    },
    observed(origin) {
      const s = seen.get(origin);
      return s ? s.fingerprint : null;
    },
    takeMismatch(origin) {
      const m = mismatches.get(origin) || null;
      mismatches.delete(origin);
      return m;
    },
    status(origin) {
      const s = seen.get(origin);
      return s ? { mode: 'tls', verified: s.verified, at: s.at } : { mode: 'tls', verified: false, at: null };
    },
  };
}
