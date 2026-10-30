// Site permissions: remembered allow/deny decisions per origin, and the policy for each
// permission type Chromium asks Electron about.

/**
 * How a permission is decided when there is no stored decision:
 *   'allow'  granted without asking (Chrome grants these too)
 *   'ask'    the user is asked (prompt anchored to the address bar)
 *   'deny'   never granted
 */
export const POLICY = Object.freeze({
  'clipboard-sanitized-write': 'allow',
  fullscreen: 'allow',
  pointerLock: 'allow',
  keyboardLock: 'allow',
  'window-placement': 'ask',
  'window-management': 'ask',
  media: 'ask',
  geolocation: 'ask',
  notifications: 'ask',
  midi: 'allow',
  midiSysex: 'ask',
  'clipboard-read': 'ask',
  'display-capture': 'ask',
  'idle-detection': 'ask',
  'storage-access': 'ask',
  'top-level-storage-access': 'ask',
  'speaker-selection': 'ask',
  openExternal: 'ask',
  mediaKeySystem: 'allow', // DRM (Widevine) for streaming services
  'persistent-storage': 'allow',
  fileSystem: 'ask',
  'background-sync': 'allow',
  'automatic-fullscreen': 'deny',
  unknown: 'deny',
  hid: 'deny',
  serial: 'deny',
  usb: 'deny',
});

/** Permissions whose decision is remembered per origin (others are asked each time). */
const REMEMBERED = new Set(['media', 'geolocation', 'notifications', 'midiSysex', 'clipboard-read', 'window-management', 'window-placement', 'idle-detection', 'storage-access', 'top-level-storage-access', 'speaker-selection', 'fileSystem']);

export const LABELS = Object.freeze({
  media: 'use your camera and microphone',
  'media:video': 'use your camera',
  'media:audio': 'use your microphone',
  geolocation: 'know your location',
  notifications: 'show notifications',
  midiSysex: 'control MIDI devices',
  'clipboard-read': 'see text and images copied to the clipboard',
  'display-capture': 'share your screen',
  'window-management': 'manage windows on all your displays',
  'window-placement': 'manage windows on all your displays',
  'idle-detection': 'know when you are actively using this device',
  'storage-access': 'use cookies and site data in an embedded page',
  'top-level-storage-access': 'use cookies and site data from another site',
  'speaker-selection': 'choose audio output devices',
  openExternal: 'open an external application',
  fileSystem: 'edit files on your device',
});

export class Permissions {
  /** @param {import('./db.js').ProfileDb} db */
  constructor(db) {
    this.db = db;
  }

  policy(permission) {
    return POLICY[permission] || 'deny';
  }

  remembered(permission) {
    return REMEMBERED.has(permission);
  }

  /** @returns {'allow'|'deny'|null} */
  stored(origin, permission) {
    const r = this.db.get('SELECT decision FROM permissions WHERE origin = ? AND permission = ?', origin, permission);
    return r ? r.decision : null;
  }

  set(origin, permission, decision) {
    if (decision === null) this.db.run('DELETE FROM permissions WHERE origin = ? AND permission = ?', origin, permission);
    else this.db.run(
      'INSERT INTO permissions (origin, permission, decision, updated_at) VALUES (?,?,?,?) ON CONFLICT (origin, permission) DO UPDATE SET decision = excluded.decision, updated_at = excluded.updated_at',
      origin, permission, decision, new Date().toISOString(),
    );
  }

  forOrigin(origin) {
    return this.db.all('SELECT permission, decision, updated_at FROM permissions WHERE origin = ? ORDER BY permission', origin);
  }

  all() {
    return this.db.all('SELECT origin, permission, decision, updated_at FROM permissions ORDER BY origin, permission');
  }

  clearOrigin(origin) {
    this.db.run('DELETE FROM permissions WHERE origin = ?', origin);
  }
}
