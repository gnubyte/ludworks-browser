// Electron fuses: build-time feature switches stored in the executable (or the macOS framework
// binary) right after a sentinel string. Wire format v1: sentinel, version byte (1), fuse count,
// then one ASCII byte per fuse: '0' off, '1' on, 'r' removed. Order from electron/build/fuses/fuses.json5.

import { readFileSync, writeFileSync } from 'node:fs';

export const SENTINEL = 'dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX';
export const FUSE_ORDER = Object.freeze([
  'run_as_node',
  'cookie_encryption',
  'node_options',
  'node_cli_inspect',
  'embedded_asar_integrity_validation',
  'only_load_app_from_asar',
  'load_browser_process_specific_v8_snapshot',
  'grant_file_protocol_extra_privileges',
  'wasm_trap_handlers',
]);

/** What Ludworks Browser ships with. Unknown/newer fuses keep Electron's default. */
export const LUDWORKS_FUSES = Object.freeze({
  run_as_node: false, // ELECTRON_RUN_AS_NODE would turn the browser into a plain Node.js runtime
  cookie_encryption: true, // cookies encrypted at rest with the OS key store (DPAPI / Keychain / libsecret)
  node_options: false, // NODE_OPTIONS must not inject code into the browser process
  node_cli_inspect: false, // no --inspect debugger on the main process
  grant_file_protocol_extra_privileges: false, // file:// behaves like in Chrome
});

/**
 * Read the fuse wire of a binary.
 * @param {Buffer} buf
 * @returns {{offset: number, version: number, values: Record<string, string>}}
 */
export function readFuses(buf) {
  const at = buf.indexOf(Buffer.from(SENTINEL, 'latin1'));
  if (at < 0) throw new Error('fuses: sentinel not found (not an Electron binary?)');
  if (buf.indexOf(Buffer.from(SENTINEL, 'latin1'), at + 1) >= 0) throw new Error('fuses: sentinel found twice');
  const offset = at + SENTINEL.length;
  const version = buf[offset];
  const count = buf[offset + 1];
  if (version !== 1) throw new Error(`fuses: unsupported wire version ${version}`);
  const values = {};
  for (let i = 0; i < count; i++) {
    const name = FUSE_ORDER[i] || `fuse_${i}`;
    values[name] = String.fromCharCode(buf[offset + 2 + i]);
  }
  return { offset, version, values };
}

/**
 * Flip fuses in a binary file in place.
 * @param {string} file
 * @param {Record<string, boolean>} wanted
 * @returns {Record<string, string>} the resulting wire values
 */
export function flipFuses(file, wanted = LUDWORKS_FUSES) {
  const buf = readFileSync(file);
  const { offset, values } = readFuses(buf);
  for (const [name, on] of Object.entries(wanted)) {
    const i = FUSE_ORDER.indexOf(name);
    if (i < 0) throw new Error(`fuses: unknown fuse ${name}`);
    if (!(name in values)) throw new Error(`fuses: binary has no fuse ${name}`);
    if (values[name] === 'r') throw new Error(`fuses: fuse ${name} was removed from this Electron`);
    buf[offset + 2 + i] = on ? 0x31 : 0x30;
  }
  writeFileSync(file, buf);
  return readFuses(buf).values;
}
