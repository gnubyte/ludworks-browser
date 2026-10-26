// Tiny ES-module -> classic-script bundler for content scripts (scripting.executeScript / registered
// content scripts cannot be ES modules). Supports exactly what our own sources use:
//   import { a, b as c } from './relative.js';
//   export function / async function / const / let / class NAME ...;  export { a, b as c };
// Each module becomes an IIFE scope returning its exports; the whole bundle is one IIFE.
// Anything else (default/namespace/side-effect/dynamic imports, re-exports) is rejected loudly.

import { readFile } from 'node:fs/promises';
import path from 'node:path';

const IMPORT_RE = /^[ \t]*import[ \t]*\{([^}]*)\}[ \t]*from[ \t]*['"](\.{1,2}\/[^'"]+)['"][ \t]*;?[ \t]*$/gm;
const EXPORT_DECL_RE = /^export[ \t]+((?:async[ \t]+)?function\*?|const|let|class)[ \t]+([A-Za-z_$][\w$]*)/gm;
const EXPORT_LIST_RE = /^export[ \t]*\{([^}]*)\}[ \t]*;?[ \t]*$/gm;
const IDENT_RE = /^[A-Za-z_$][\w$]*$/;

function parseSpecifiers(list, file) {
  return list
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const [name, alias] = s.split(/\s+as\s+/);
      const local = (alias || name).trim();
      if (!IDENT_RE.test(name.trim()) || !IDENT_RE.test(local)) throw new Error(`${file}: bad specifier "${s}"`);
      return { name: name.trim(), local };
    });
}

/**
 * Bundle `entryFile` and its relative imports into a single classic script.
 * @param {string} entryFile
 * @param {{root?: string, banner?: string}} [opts]
 * @returns {Promise<string>}
 */
export async function bundle(entryFile, { root = path.dirname(entryFile), banner = '' } = {}) {
  const modules = new Map();
  const order = [];

  async function load(file, stack) {
    if (stack.includes(file)) throw new Error(`import cycle: ${[...stack, file].map((f) => path.relative(root, f)).join(' -> ')}`);
    if (modules.has(file)) return modules.get(file);
    const src = await readFile(file, 'utf8');
    const imports = [];
    let code = src.replace(IMPORT_RE, (_m, list, spec) => {
      imports.push({ specs: parseSpecifiers(list, file), file: path.resolve(path.dirname(file), spec) });
      return '';
    });
    const exports = [];
    code = code.replace(EXPORT_DECL_RE, (_m, kind, name) => {
      exports.push({ exported: name, local: name });
      return `${kind} ${name}`;
    });
    code = code.replace(EXPORT_LIST_RE, (_m, list) => {
      for (const s of parseSpecifiers(list, file)) exports.push({ exported: s.local, local: s.name });
      return '';
    });
    if (/^[ \t]*(import|export)\b/m.test(code)) throw new Error(`${path.relative(root, file)}: unsupported import/export syntax`);
    if (/\bimport\s*\(/.test(code)) throw new Error(`${path.relative(root, file)}: dynamic import() is not allowed in content scripts`);
    const mod = { id: `__lw_m${modules.size}`, file, code, exports, deps: [] };
    modules.set(file, mod);
    for (const imp of imports) {
      const dep = await load(imp.file, [...stack, file]);
      for (const s of imp.specs) {
        if (!dep.exports.some((e) => e.exported === s.name)) {
          throw new Error(`${path.relative(root, file)}: "${s.name}" is not exported by ${path.relative(root, dep.file)}`);
        }
      }
      mod.deps.push({ dep, specs: imp.specs });
    }
    order.push(mod);
    return mod;
  }

  await load(path.resolve(entryFile), []);
  let out = `${banner}(() => {\n'use strict';\n`;
  for (const m of order) {
    const bindings = m.deps
      .map(({ dep, specs }) => `const { ${specs.map((s) => (s.name === s.local ? s.name : `${s.name}: ${s.local}`)).join(', ')} } = ${dep.id};`)
      .join('\n');
    const ret = m.exports.map((e) => (e.exported === e.local ? e.local : `${e.exported}: ${e.local}`)).join(', ');
    out += `\n// ---- ${path.relative(root, m.file).split(path.sep).join('/')}\nconst ${m.id} = (() => {\n${bindings}\n${m.code.trim()}\nreturn { ${ret} };\n})();\n`;
  }
  out += '})();\n';
  return out;
}
