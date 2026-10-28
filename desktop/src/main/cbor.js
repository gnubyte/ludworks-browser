// Minimal deterministic CBOR encoder (RFC 8949) for WebAuthn attestation objects and COSE keys:
// unsigned/negative integers, byte strings, text strings, arrays and maps (keys emitted in the order
// given; callers pass CTAP2-canonical order).

function head(major, n) {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 0x100) return Buffer.from([(major << 5) | 24, n]);
  if (n < 0x10000) {
    const b = Buffer.alloc(3);
    b[0] = (major << 5) | 25;
    b.writeUInt16BE(n, 1);
    return b;
  }
  if (n < 0x100000000) {
    const b = Buffer.alloc(5);
    b[0] = (major << 5) | 26;
    b.writeUInt32BE(n, 1);
    return b;
  }
  throw new Error('cbor: value too large');
}

/** A map with an explicit key order: new CborMap([[k, v], ...]). */
export class CborMap {
  constructor(entries) {
    this.entries = entries;
  }
}

/**
 * @param {number|string|Uint8Array|Buffer|Array|CborMap} v
 * @returns {Buffer}
 */
export function encode(v) {
  if (typeof v === 'number') {
    if (!Number.isSafeInteger(v)) throw new Error('cbor: only integers are supported');
    return v >= 0 ? head(0, v) : head(1, -1 - v);
  }
  if (typeof v === 'string') {
    const b = Buffer.from(v, 'utf8');
    return Buffer.concat([head(3, b.length), b]);
  }
  if (v instanceof Uint8Array) return Buffer.concat([head(2, v.length), Buffer.from(v)]);
  if (Array.isArray(v)) return Buffer.concat([head(4, v.length), ...v.map(encode)]);
  if (v instanceof CborMap) return Buffer.concat([head(5, v.entries.length), ...v.entries.flatMap(([k, x]) => [encode(k), encode(x)])]);
  throw new Error('cbor: unsupported type');
}
