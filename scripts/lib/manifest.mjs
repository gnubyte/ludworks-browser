// Manifest generation: src/manifest.base.json + src/manifest.<target>.json -> manifest.json, and validation.

import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

export const TARGETS = Object.freeze(['chrome', 'firefox']);
export const GECKO_ID = 'passwords@ludworks.app';
export const GECKO_MIN = '128.0';

/** Permissions each target may request (anything else fails validation). */
export const ALLOWED_PERMISSIONS = Object.freeze({
  chrome: ['storage', 'unlimitedStorage', 'alarms', 'idle', 'activeTab', 'scripting', 'clipboardWrite', 'offscreen'],
  firefox: ['storage', 'unlimitedStorage', 'alarms', 'idle', 'activeTab', 'scripting', 'clipboardWrite', 'webRequest', 'webRequestBlocking'],
});
export const OPTIONAL_HOSTS = Object.freeze(['https://*/*', 'http://localhost/*', 'http://127.0.0.1/*']);

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Deep merge: objects merge recursively, arrays concatenate (deduplicated), `null` deletes a key.
 * @param {object} base
 * @param {object} over
 */
export function deepMerge(base, over) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    if (v === null) delete out[k];
    else if (Array.isArray(v) && Array.isArray(out[k])) out[k] = [...new Set([...out[k], ...v])];
    else if (isObject(v) && isObject(out[k])) out[k] = deepMerge(out[k], v);
    else out[k] = v;
  }
  return out;
}

/**
 * @param {string} srcDir
 * @param {'chrome'|'firefox'} target
 * @param {string} version
 */
export async function buildManifest(srcDir, target, version) {
  if (!TARGETS.includes(target)) throw new Error(`unknown target ${target}`);
  const base = JSON.parse(await readFile(path.join(srcDir, 'manifest.base.json'), 'utf8'));
  const over = JSON.parse(await readFile(path.join(srcDir, `manifest.${target}.json`), 'utf8'));
  const m = deepMerge(base, over);
  m.version = version;
  return m;
}

function parseCsp(csp) {
  const map = new Map();
  for (const part of String(csp).split(';')) {
    const tokens = part.trim().split(/\s+/).filter(Boolean);
    if (tokens.length) map.set(tokens[0].toLowerCase(), tokens.slice(1));
  }
  return map;
}

async function exists(file) {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

/**
 * Validate a generated manifest for a target. Returns a list of problems (empty = valid).
 * @param {any} m
 * @param {'chrome'|'firefox'} target
 * @param {{dir?: string}} [opts]  when `dir` is given, referenced files must exist there
 * @returns {Promise<string[]>}
 */
export async function validateManifest(m, target, { dir } = {}) {
  const errors = [];
  const req = (cond, msg) => {
    if (!cond) errors.push(msg);
  };
  req(m.manifest_version === 3, 'manifest_version must be 3');
  req(typeof m.name === 'string' && m.name.length > 0 && m.name.length <= 75, 'name is required (<= 75 chars)');
  req(typeof m.description === 'string' && m.description.length <= 132, 'description is required (<= 132 chars)');
  req(typeof m.version === 'string' && /^\d+(\.\d+){0,3}$/.test(m.version), 'version must be 1-4 dot-separated integers');
  req(isObject(m.icons) && ['16', '32', '48', '128'].every((s) => typeof m.icons[s] === 'string'), 'icons 16/32/48/128 required');
  req(isObject(m.action) && typeof m.action.default_popup === 'string', 'action.default_popup required');

  // permissions: minimal + known
  const perms = Array.isArray(m.permissions) ? m.permissions : [];
  for (const p of perms) req(ALLOWED_PERMISSIONS[target].includes(p), `permission not allowed for ${target}: ${p}`);
  for (const p of ['storage', 'activeTab', 'scripting', 'alarms', 'idle']) req(perms.includes(p), `missing required permission ${p}`);
  req(!perms.includes('tabs'), 'the broad "tabs" permission must not be requested (activeTab is enough)');
  req(!perms.includes('<all_urls>') && !perms.some((p) => p.includes('://')), 'host patterns must not be in permissions');
  req(m.host_permissions === undefined || (Array.isArray(m.host_permissions) && m.host_permissions.length === 0), 'no install-time host_permissions allowed');
  req(
    Array.isArray(m.optional_host_permissions) && m.optional_host_permissions.length === OPTIONAL_HOSTS.length && OPTIONAL_HOSTS.every((o) => m.optional_host_permissions.includes(o)),
    `optional_host_permissions must be exactly ${OPTIONAL_HOSTS.join(', ')}`,
  );
  req(m.content_scripts === undefined, 'no static content_scripts (scripts are injected on demand)');
  req(m.web_accessible_resources === undefined, 'no web_accessible_resources (avoids page fingerprinting)');
  req(m.optional_permissions === undefined || (Array.isArray(m.optional_permissions) && m.optional_permissions.length === 0), 'no optional_permissions expected');

  // CSP
  const csp = m.content_security_policy && m.content_security_policy.extension_pages;
  req(typeof csp === 'string', 'content_security_policy.extension_pages required');
  if (typeof csp === 'string') {
    const d = parseCsp(csp);
    const script = d.get('script-src') || [];
    req(script.length === 1 && script[0] === "'self'", "script-src must be exactly 'self'");
    req((d.get('object-src') || []).join(' ') === "'none'", "object-src must be 'none'");
    req(!/unsafe-(eval|inline)|wasm-unsafe-eval|strict-dynamic/.test(csp), 'CSP must not contain unsafe-* sources');
    req(!(d.get('default-src') || []).some((s) => /^(https?:|\*|data:|blob:)/.test(s)), 'default-src must not allow remote/data/blob sources');
  }
  req(typeof m.content_security_policy.sandbox === 'undefined', 'no sandbox pages');

  // commands
  const cmds = m.commands || {};
  req(cmds._execute_action && cmds._execute_action.suggested_key && cmds._execute_action.suggested_key.default === 'Ctrl+Shift+L', '_execute_action must default to Ctrl+Shift+L');
  req(cmds['fill-login'] && cmds['fill-login'].suggested_key && cmds['fill-login'].suggested_key.default === 'Ctrl+Shift+F', 'fill-login must default to Ctrl+Shift+F');

  // background + browser specifics
  const bg = m.background || {};
  if (target === 'chrome') {
    req(typeof bg.service_worker === 'string', 'chrome: background.service_worker required');
    req(bg.scripts === undefined && bg.page === undefined, 'chrome: background.scripts/page not allowed in MV3');
    req(bg.type === 'module', 'chrome: background.type must be "module"');
    req(m.browser_specific_settings === undefined, 'chrome: browser_specific_settings must not be present');
    req(typeof m.minimum_chrome_version === 'string', 'chrome: minimum_chrome_version required');
    req(perms.includes('offscreen'), 'chrome: offscreen permission required for clipboard clearing');
    req(!perms.includes('webRequest') && !perms.includes('webRequestBlocking'), 'chrome: webRequest must not be requested');
  } else {
    req(Array.isArray(bg.scripts) && bg.scripts.length === 1, 'firefox: background.scripts required');
    req(bg.service_worker === undefined, 'firefox: background.service_worker not supported');
    req(bg.type === 'module', 'firefox: background.type must be "module"');
    const gecko = m.browser_specific_settings && m.browser_specific_settings.gecko;
    req(gecko && gecko.id === GECKO_ID, `firefox: gecko.id must be ${GECKO_ID}`);
    req(gecko && gecko.strict_min_version === GECKO_MIN, `firefox: strict_min_version must be ${GECKO_MIN}`);
    req(!perms.includes('offscreen'), 'firefox: offscreen permission is not supported');
    req(m.minimum_chrome_version === undefined, 'firefox: minimum_chrome_version not applicable');
    req(m.externally_connectable === undefined, 'firefox: externally_connectable not supported');
  }

  if (dir) {
    const refs = [
      ...Object.values(m.icons || {}),
      ...Object.values((m.action && m.action.default_icon) || {}),
      m.action && m.action.default_popup,
      bg.service_worker,
      ...(bg.scripts || []),
      'content/fill.js',
      'content/capture.js',
      'lib/build-info.js',
      ...(target === 'chrome' ? ['offscreen/offscreen.html', 'offscreen/offscreen.js'] : []),
    ].filter(Boolean);
    for (const r of refs) req(await exists(path.join(dir, r)), `referenced file missing: ${r}`);
  }
  return errors;
}
