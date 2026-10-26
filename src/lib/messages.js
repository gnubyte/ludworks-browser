// Message schemas between popup/content scripts and the background, plus strict sender validation.
// Every message is a plain object {type, ...fields}; unknown types or unknown/ill-typed fields are rejected.

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const str = (max, { min = 0, pattern = null } = {}) => ({ kind: 'string', max, min, pattern });
const bool = () => ({ kind: 'boolean' });
const int = (min, max) => ({ kind: 'int', min, max });
const oneOf = (values) => ({ kind: 'enum', values });
const obj = (maxJson) => ({ kind: 'object', maxJson });
const id = () => str(36, { min: 36, pattern: ID_RE });
const optional = (spec) => ({ ...spec, optional: true });
const nullable = (spec) => ({ ...spec, nullable: true });

export const LOCK_MINUTES = Object.freeze([1, 5, 15, 30, 60, 240]);

/** Messages accepted from the extension's own pages (popup, options-in-tab). */
export const POPUP_SCHEMAS = Object.freeze({
  'state': {},
  'server.probe': { serverUrl: str(2048, { min: 1 }) },
  'server.trust': { serverUrl: str(2048, { min: 1 }), fingerprint: str(200, { min: 32 }) },
  'server.forgetPin': {},
  'auth.login': {
    serverUrl: str(2048, { min: 1 }),
    username: str(320, { min: 1 }),
    password: str(1024, { min: 1 }),
    totpCode: optional(str(16, { pattern: /^[0-9 ]*$/ })),
    recoveryCode: optional(str(64)),
  },
  'auth.logout': {},
  'vault.unlock': { password: str(1024, { min: 1 }) },
  'vault.lock': {},
  'vault.sync': {},
  'items.list': { url: optional(nullable(str(8192))) },
  'items.get': { id: id() },
  'items.save': {
    id: optional(nullable(id())),
    folderId: optional(nullable(id())),
    data: obj(192 * 1024),
    baseRevision: optional(nullable(int(0, Number.MAX_SAFE_INTEGER))),
  },
  'items.delete': { id: id() },
  'fill.item': { id: id(), allowInsecure: optional(bool()), allowOtherHost: optional(bool()) },
  // offer to save: the login captured in a tab is confirmed here, never inside the page
  'capture.get': { tabId: int(0, Number.MAX_SAFE_INTEGER) },
  'capture.confirm': { tabId: int(0, Number.MAX_SAFE_INTEGER), id: id(), decision: oneOf(['save', 'update', 'never', 'dismiss']) },
  'settings.update': {
    lockMinutes: optional(oneOf(LOCK_MINUTES)),
    saveLogins: optional(bool()),
  },
  'clipboard.copied': {},
  'data.clear': {},
});

/**
 * Messages accepted from our content scripts (offer-to-save capture only). A content script can report a
 * submitted login and ask for the toolbar badge to be refreshed; it can never decide anything (save,
 * update, never) and gets nothing back, so a page cannot steer vault writes or learn whether a submitted
 * password is the saved one.
 */
export const CONTENT_SCHEMAS = Object.freeze({
  'capture.submitted': { username: str(512), password: str(1024, { min: 1 }) },
  'capture.loaded': {},
});

function isPlainObject(v) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function checkField(name, spec, value) {
  if (value === undefined) return spec.optional ? null : `${name} is required`;
  if (value === null) return spec.nullable ? null : `${name} must not be null`;
  switch (spec.kind) {
    case 'string':
      if (typeof value !== 'string') return `${name} must be a string`;
      if (value.length < spec.min || value.length > spec.max) return `${name} has an invalid length`;
      if (spec.pattern && !spec.pattern.test(value)) return `${name} has an invalid format`;
      return null;
    case 'boolean':
      return typeof value === 'boolean' ? null : `${name} must be a boolean`;
    case 'int':
      return Number.isSafeInteger(value) && value >= spec.min && value <= spec.max ? null : `${name} is out of range`;
    case 'enum':
      return spec.values.includes(value) ? null : `${name} is not an allowed value`;
    case 'object': {
      if (!isPlainObject(value)) return `${name} must be an object`;
      let json;
      try {
        json = JSON.stringify(value);
      } catch {
        return `${name} is not serializable`;
      }
      return json.length <= spec.maxJson ? null : `${name} is too large`;
    }
    default:
      return `${name}: unknown schema`;
  }
}

/**
 * Validate a message against a schema table.
 * @param {any} msg
 * @param {Record<string, Record<string, object>>} schemas
 * @returns {{ok: true, type: string} | {ok: false, error: string}}
 */
export function validateMessage(msg, schemas) {
  if (!isPlainObject(msg)) return { ok: false, error: 'Message must be an object' };
  const { type } = msg;
  if (typeof type !== 'string' || !Object.prototype.hasOwnProperty.call(schemas, type)) {
    return { ok: false, error: 'Unknown message type' };
  }
  const schema = schemas[type];
  for (const key of Object.keys(msg)) {
    if (key !== 'type' && !Object.prototype.hasOwnProperty.call(schema, key)) {
      return { ok: false, error: `Unexpected field: ${key}` };
    }
  }
  for (const [name, spec] of Object.entries(schema)) {
    const err = checkField(name, spec, msg[name]);
    if (err) return { ok: false, error: err };
  }
  return { ok: true, type };
}

/**
 * Classify a runtime.onMessage sender.
 *  'extension' — one of our own extension pages (popup, offscreen, extension page in a tab)
 *  'content'   — our content script in the TOP frame of the currently ACTIVE tab, on an http(s) page
 *  null        — anything else (other extensions, inactive tabs, sub-frames, ...): reject
 * @param {any} sender
 * @param {{runtimeId: string, extensionOrigin: string}} ctx  extensionOrigin = runtime.getURL('')
 * @returns {'extension'|'content'|null}
 */
export function classifySender(sender, { runtimeId, extensionOrigin }) {
  if (!sender || typeof sender !== 'object' || !runtimeId || sender.id !== runtimeId) return null;
  const url = typeof sender.url === 'string' ? sender.url : '';
  if (extensionOrigin && url.startsWith(extensionOrigin)) return 'extension';
  const tab = sender.tab;
  if (!tab || typeof tab.id !== 'number' || tab.id < 0) return null;
  if (sender.frameId !== 0) return null;
  if (tab.active !== true) return null;
  if (!/^https?:\/\//i.test(url)) return null;
  return 'content';
}
