// CRX3 packages (Chrome Web Store downloads, .crx files): header parsing and signature verification.
// Written from the published format, Node built-ins only:
//
//   "Cr24" | uint32le version (3) | uint32le header length | CrxFileHeader (protobuf) | ZIP archive
//
//   CrxFileHeader      { repeated AsymmetricKeyProof sha256_with_rsa = 2; repeated AsymmetricKeyProof
//                        sha256_with_ecdsa = 3; bytes signed_header_data = 10000; (others ignored) }
//   AsymmetricKeyProof { bytes public_key = 1 (SubjectPublicKeyInfo DER); bytes signature = 2; }
//   SignedData         { bytes crx_id = 1; }   // the first 16 bytes of SHA-256(developer public key)
//
// Every proof signs  "CRX3 SignedData\0" | uint32le len(signed_header_data) | signed_header_data | archive.
// A package is accepted only if every proof verifies, one of them is made with the key the extension ID
// is derived from (crx_id), and — for Web Store downloads — one is made with the Web Store's own key.

import { createHash, createPublicKey, verify as cryptoVerify, constants } from 'node:crypto';

const MAGIC = 'Cr24';
const SIGNED_PREFIX = Buffer.from('CRX3 SignedData\x00', 'latin1');
const MAX_HEADER = 16 * 1024 * 1024;

/**
 * SHA-256 of the Chrome Web Store's publisher key (an ECDSA P-256 SubjectPublicKeyInfo). Every package
 * the store serves carries an extra proof made with this key (observed on every store download, Google's
 * own extensions included); it is how a download is known to come from the store and not just from
 * whoever holds the developer key.
 */
export const WEBSTORE_PUBLISHER_KEY_SHA256 = '61f7f2a6bfcf74cd0bc1fe2497cc9b04254c658f79f2145392867ea8366367cf';

export class CrxError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const fail = (code, message) => {
  throw new CrxError(code, message);
};

/** Extension ID (32 letters a–p) for a public key (DER SubjectPublicKeyInfo) or a raw 16-byte crx_id. */
export function idFromBytes(bytes16) {
  let out = '';
  for (const b of bytes16.subarray(0, 16)) out += String.fromCharCode(97 + (b >> 4), 97 + (b & 15));
  return out;
}

export function idFromPublicKey(spkiDer) {
  return idFromBytes(createHash('sha256').update(spkiDer).digest());
}

/** Extension ID for a manifest "key" (base64 SubjectPublicKeyInfo), or null when it is not one. */
export function idFromManifestKey(b64) {
  if (typeof b64 !== 'string' || !b64.trim()) return null;
  const der = Buffer.from(b64.replace(/\s+/g, ''), 'base64');
  if (der.length < 32) return null;
  try {
    createPublicKey({ key: der, format: 'der', type: 'spki' });
  } catch {
    return null;
  }
  return idFromPublicKey(der);
}

export const isExtensionId = (s) => typeof s === 'string' && /^[a-p]{32}$/.test(s);

// ------------------------------------------------------------------------------- protobuf (subset)
function readVarint(buf, pos) {
  let result = 0n;
  let shift = 0n;
  for (let i = 0; i < 10; i++) {
    if (pos >= buf.length) fail('malformed', 'Truncated package header.');
    const b = buf[pos++];
    result |= BigInt(b & 0x7f) << shift;
    if (!(b & 0x80)) return [result, pos];
    shift += 7n;
  }
  fail('malformed', 'Bad varint in the package header.');
}

/** Fields of one protobuf message: [{field, wire, value: Buffer|bigint}] (groups are refused). */
export function protoFields(buf) {
  const out = [];
  let pos = 0;
  while (pos < buf.length) {
    let key;
    [key, pos] = readVarint(buf, pos);
    const field = Number(key >> 3n);
    const wire = Number(key & 7n);
    if (field <= 0) fail('malformed', 'Bad field number in the package header.');
    if (wire === 0) {
      let v;
      [v, pos] = readVarint(buf, pos);
      out.push({ field, wire, value: v });
    } else if (wire === 1 || wire === 5) {
      const n = wire === 1 ? 8 : 4;
      if (pos + n > buf.length) fail('malformed', 'Truncated package header.');
      out.push({ field, wire, value: buf.subarray(pos, pos + n) });
      pos += n;
    } else if (wire === 2) {
      let len;
      [len, pos] = readVarint(buf, pos);
      if (len > BigInt(buf.length - pos)) fail('malformed', 'Truncated package header.');
      const n = Number(len);
      out.push({ field, wire, value: buf.subarray(pos, pos + n) });
      pos += n;
    } else fail('malformed', `Unsupported protobuf wire type ${wire} in the package header.`);
  }
  return out;
}

function bytesField(fields, n) {
  const f = fields.filter((x) => x.field === n && x.wire === 2);
  return f.length ? f[f.length - 1].value : null;
}

// ------------------------------------------------------------------------------------- parsing
/**
 * Splits a CRX3 file into its proofs, signed data and archive (no verification).
 * @param {Buffer} buf
 */
export function parseCrx(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) fail('malformed', 'This is not an extension package (too short).');
  if (buf.toString('latin1', 0, 4) !== MAGIC) fail('not_crx', 'This is not a Chrome extension package (.crx).');
  const version = buf.readUInt32LE(4);
  if (version === 2) fail('crx2', 'This extension uses the old CRX2 package format, which is no longer accepted.');
  if (version !== 3) fail('malformed', `Unknown extension package version ${version}.`);
  const headerLen = buf.readUInt32LE(8);
  if (headerLen > MAX_HEADER || 12 + headerLen > buf.length) fail('malformed', 'The package header is too large or truncated.');
  const header = buf.subarray(12, 12 + headerLen);
  const archive = buf.subarray(12 + headerLen);
  const fields = protoFields(header);
  const proofs = [];
  for (const f of fields) {
    if ((f.field !== 2 && f.field !== 3) || f.wire !== 2) continue;
    const p = protoFields(f.value);
    const publicKey = bytesField(p, 1);
    const signature = bytesField(p, 2);
    if (!publicKey || !signature) fail('malformed', 'A package signature is incomplete.');
    proofs.push({ algo: f.field === 2 ? 'rsa' : 'ecdsa', publicKey, signature });
  }
  const signedHeaderData = bytesField(fields, 10000);
  if (!signedHeaderData) fail('unsigned', 'The package has no signed header data.');
  const crxId = bytesField(protoFields(signedHeaderData), 1);
  if (!crxId || crxId.length !== 16) fail('malformed', 'The package has no valid extension ID.');
  return { version, proofs, signedHeaderData, crxId, archive };
}

/** The bytes every proof signs. */
export function signedMessage(signedHeaderData, archive) {
  const len = Buffer.alloc(4);
  len.writeUInt32LE(signedHeaderData.length, 0);
  return Buffer.concat([SIGNED_PREFIX, len, signedHeaderData, archive]);
}

function verifyProof(proof, message) {
  let key;
  try {
    key = createPublicKey({ key: proof.publicKey, format: 'der', type: 'spki' });
  } catch {
    return false;
  }
  const kind = key.asymmetricKeyType;
  try {
    if (proof.algo === 'rsa') {
      if (kind !== 'rsa') return false;
      return cryptoVerify('sha256', message, { key, padding: constants.RSA_PKCS1_PADDING }, proof.signature);
    }
    if (kind !== 'ec') return false;
    return cryptoVerify('sha256', message, { key, dsaEncoding: 'der' }, proof.signature);
  } catch {
    return false;
  }
}

/**
 * Verifies a CRX3 package. Throws CrxError when anything is wrong; nothing from a package that failed
 * here may be unpacked or run.
 * @param {Buffer} buf
 * @param {{expectedId?: string|null, requirePublisher?: boolean, publisherKeyHash?: string}} [opts]
 *   publisherKeyHash: only for tests (a test "store" key); defaults to the Web Store's.
 * @returns {{id: string, publicKey: Buffer, key: string, archive: Buffer, publisher: boolean}}
 */
export function verifyCrx(buf, { expectedId = null, requirePublisher = false, publisherKeyHash = WEBSTORE_PUBLISHER_KEY_SHA256 } = {}) {
  const crx = parseCrx(buf);
  if (!crx.proofs.length) fail('unsigned', 'The package is not signed.');
  if (crx.proofs.length > 16) fail('malformed', 'The package has too many signatures.');
  const id = idFromBytes(crx.crxId);
  if (expectedId && id !== expectedId) fail('id_mismatch', `The package is for extension ${id}, not ${expectedId}.`);
  const message = signedMessage(crx.signedHeaderData, crx.archive);
  let developer = null;
  let publisher = false;
  for (const p of crx.proofs) {
    if (!verifyProof(p, message)) fail('bad_signature', 'A package signature is invalid. The download may be damaged or tampered with.');
    const digest = createHash('sha256').update(p.publicKey).digest();
    if (digest.subarray(0, 16).equals(crx.crxId)) developer = p;
    if (digest.toString('hex') === publisherKeyHash) publisher = true;
  }
  if (!developer) fail('no_developer_proof', 'The package is not signed with the key its extension ID belongs to.');
  if (requirePublisher && !publisher) fail('no_publisher_proof', 'The package is not signed by the Chrome Web Store.');
  return { id, publicKey: Buffer.from(developer.publicKey), key: developer.publicKey.toString('base64'), archive: crx.archive, publisher };
}

// ------------------------------------------------------------------------------- building (tests)
function varint(n) {
  const out = [];
  let v = BigInt(n);
  do {
    let b = Number(v & 0x7fn);
    v >>= 7n;
    if (v) b |= 0x80;
    out.push(b);
  } while (v);
  return Buffer.from(out);
}

function lenField(field, bytes) {
  return Buffer.concat([varint((BigInt(field) << 3n) | 2n), varint(bytes.length), bytes]);
}

/**
 * Builds a CRX3 package (used by the tests and for local packing).
 * @param {Buffer} archive ZIP bytes
 * @param {Array<{privateKey: import('node:crypto').KeyObject, publicKey: import('node:crypto').KeyObject, algo?: 'rsa'|'ecdsa'}>} signers first = developer key
 * @param {{crxId?: Buffer, tamper?: (msg: Buffer) => Buffer}} [opts]
 */
export async function buildCrx(archive, signers, { crxId = null } = {}) {
  const { sign } = await import('node:crypto');
  const devDer = signers[0].publicKey.export({ format: 'der', type: 'spki' });
  const id16 = crxId || createHash('sha256').update(devDer).digest().subarray(0, 16);
  const signedHeaderData = lenField(1, id16);
  const message = signedMessage(signedHeaderData, archive);
  const parts = [];
  for (const s of signers) {
    const der = s.publicKey.export({ format: 'der', type: 'spki' });
    const algo = s.algo || (s.publicKey.asymmetricKeyType === 'ec' ? 'ecdsa' : 'rsa');
    const sig = algo === 'rsa' ? sign('sha256', message, { key: s.privateKey, padding: constants.RSA_PKCS1_PADDING }) : sign('sha256', message, { key: s.privateKey, dsaEncoding: 'der' });
    parts.push(lenField(algo === 'rsa' ? 2 : 3, Buffer.concat([lenField(1, der), lenField(2, sig)])));
  }
  parts.push(lenField(10000, signedHeaderData));
  const header = Buffer.concat(parts);
  const head = Buffer.alloc(12);
  head.write(MAGIC, 0, 'latin1');
  head.writeUInt32LE(3, 4);
  head.writeUInt32LE(header.length, 8);
  return Buffer.concat([head, header, archive]);
}
