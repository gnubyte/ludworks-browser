// The Ludworks server's self-signed certificate in the Windows trust store (the current user's
// "Trusted Root Certification Authorities"), so other browsers and apps on this PC trust the server
// too. Only the exact certificate the user pinned is ever added, and Windows itself asks the user to
// confirm every addition and removal: nothing here can (or tries to) skip that prompt. The server's
// certificate is a leaf (CA:FALSE), so trusting it cannot vouch for any other site.

import { execFile } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const osTrustSupported = process.platform === 'win32';

const certutil = () => path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'certutil.exe');

/** sha256 (lowercase hex, the pin format) and sha1 (the Windows thumbprint) of a PEM certificate. */
export function certIds(pem) {
  const x = new X509Certificate(pem);
  if (x.ca) throw new Error('refusing to trust a CA certificate');
  const hex = (fp) => fp.replace(/:/g, '').toLowerCase();
  return { sha256: hex(x.fingerprint256), sha1: hex(x.fingerprint), notAfter: x.validTo };
}

function run(args, { timeout = 5 * 60 * 1000 } = {}) {
  return new Promise((resolve) => {
    execFile(certutil(), args, { windowsHide: true, timeout }, (e, stdout) => resolve({ ok: !e, stdout: String(stdout || '') }));
  });
}

/** Whether the certificate with this sha1 thumbprint is in the current user's Root store. */
export async function isTrusted(sha1) {
  if (!osTrustSupported || !/^[0-9a-f]{40}$/.test(sha1)) return false;
  return (await run(['-user', '-verifystore', 'Root', sha1], { timeout: 20000 })).ok;
}

/**
 * Add a certificate (PEM) to the current user's Root store. Windows shows its security prompt;
 * resolves true when the certificate ended up trusted (false when the user said No).
 */
export async function addTrusted(pem) {
  if (!osTrustSupported) return false;
  const { sha1 } = certIds(pem);
  if (await isTrusted(sha1)) return true;
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lw-cert-'));
  try {
    const file = path.join(dir, 'ludworks-server.cer');
    await writeFile(file, pem);
    await run(['-user', '-addstore', 'Root', file]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  return isTrusted(sha1);
}

/** Remove a certificate from the current user's Root store (Windows asks to confirm). */
export async function removeTrusted(sha1) {
  if (!osTrustSupported || !(await isTrusted(sha1))) return true;
  await run(['-user', '-delstore', 'Root', sha1]);
  return !(await isTrusted(sha1));
}
