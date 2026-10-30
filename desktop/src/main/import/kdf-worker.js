// Worker thread: Argon2id for password-protected Bitwarden exports, so a 64 MiB – 1 GiB derivation never
// blocks the browser's main process. Input/output buffers are transferred and wiped after use.
import { parentPort, workerData } from 'node:worker_threads';
import { argon2Sync } from '../../vendor/vault/argon2.js';

const { password, salt, iterations, memoryKiB, parallelism } = workerData;
const pw = new Uint8Array(password);
try {
  const out = argon2Sync({ password: pw, salt: new Uint8Array(salt), iterations, memory: memoryKiB, parallelism, hashLength: 32, type: 'argon2id', version: 0x13 });
  const key = new Uint8Array(32);
  key.set(out.subarray(0, 32));
  out.fill(0);
  parentPort.postMessage({ ok: true, key: key.buffer }, [key.buffer]);
} catch (e) {
  parentPort.postMessage({ ok: false, message: String((e && e.message) || e) });
} finally {
  pw.fill(0);
}
