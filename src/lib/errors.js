/**
 * Error type shared by the vault library modules (same contract as the web app's
 * web/assets/js/lib/vault/errors.js so the two copies can be unified).
 *
 * `code` is a stable machine-readable string; UIs branch on it, never on `message`.
 *   invalid_argument     caller passed something unusable (wrong type/length/range)
 *   bad_password         vault unlock failed (wrong master password)
 *   decrypt_failed       AEAD verification failed for a sealed value
 *   unsupported_version  sealed string has an unknown version prefix (not "v1")
 *   malformed            a sealed string / encoded value could not be parsed
 *   unsupported          feature or version this library does not implement
 */
export class VaultError extends Error {
  /**
   * @param {string} code
   * @param {string} [message]
   * @param {{cause?: unknown}} [options]
   */
  constructor(code, message, options) {
    super(message || code, options);
    this.name = 'VaultError';
    this.code = code;
  }
}

/** @param {string} msg */
export const invalidArg = (msg) => new VaultError('invalid_argument', msg);
