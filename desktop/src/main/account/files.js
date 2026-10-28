// Small JSON file helpers (atomic replace) and OS-protected secrets (Electron safeStorage:
// DPAPI on Windows, Keychain on macOS, libsecret/KWallet on Linux).

import { safeStorage } from 'electron';
import { mkdirSync, readFileSync, renameSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';

export function readJson(file, dflt) {
  try {
    const v = JSON.parse(readFileSync(file, 'utf8'));
    return v === null ? dflt : v;
  } catch {
    return dflt;
  }
}

export function writeJsonAtomic(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
  renameSync(tmp, file);
}

export function secretsAvailable() {
  try {
    return safeStorage.isEncryptionAvailable() && (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text');
  } catch {
    return false;
  }
}

/** Store a JSON value encrypted with the OS key store. Returns false when no secure store exists. */
export function writeSecret(file, value) {
  if (value === null || value === undefined) {
    rmSync(file, { force: true });
    return true;
  }
  if (!secretsAvailable()) return false;
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, safeStorage.encryptString(JSON.stringify(value)), { mode: 0o600 });
  renameSync(tmp, file);
  return true;
}

export function readSecret(file) {
  if (!existsSync(file) || !secretsAvailable()) return null;
  try {
    return JSON.parse(safeStorage.decryptString(readFileSync(file)));
  } catch {
    return null;
  }
}
