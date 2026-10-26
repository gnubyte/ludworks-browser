// CI supply-chain rules for this repository (Node.js built-ins only):
//
// 1. Every action in .github/workflows/*.yml is pinned to a full commit SHA with the tag in a
//    trailing comment (`uses: owner/repo@<40 hex> # vX.Y.Z`). A tag can be moved by whoever
//    controls the action's repository; a commit SHA cannot.
// 2. Every `pip install` installs only from hash-pinned requirements files under
//    .github/requirements/ (--require-hashes, wheels only); nothing is resolved by name.
// 3. Every requirements file pins exact versions (name==version) with SHA-256 hashes.
// 4. A job that uploads artifacts (the extension zips) sets up no Python and installs no
//    Python packages, so no third-party code runs where the packages are built.
// 5. .github/dependabot.yml keeps the action SHAs and requirements current, with a cooldown.
//
// Usage: node .github/check-supply-chain.mjs [repo root]. Exit status 1 and one line per
// violation when a rule is broken. The checks are exported for tests.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const USES = /^\s*(?:-\s+)?uses:\s*(\S+)(.*)$/;
const PINNED = /^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/;
const VERSION_COMMENT = /^\s+# v\d+(?:\.\d+)*\s*$/;
const REQUIREMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*==[0-9][^\s;]*(\s*;.+)?$/;
const HASH = /^--hash=sha256:[0-9a-f]{64}$/;

/** Joins backslash-continued lines: [[first line number, joined line], ...]. */
export function logicalLines(text) {
  const out = [];
  let buf = '';
  let start = 0;
  text.split(/\r?\n/).forEach((line, i) => {
    if (!buf) start = i + 1;
    const trimmed = line.trimEnd();
    if (trimmed.endsWith('\\')) {
      buf += trimmed.slice(0, -1) + ' ';
      return;
    }
    out.push([start, buf + line]);
    buf = '';
  });
  if (buf) out.push([start, buf]);
  return out;
}

export function checkUses(name, text) {
  const errors = [];
  text.split(/\r?\n/).forEach((line, i) => {
    const m = USES.exec(line);
    if (m && !(PINNED.test(m[1]) && VERSION_COMMENT.test(m[2]))) {
      errors.push(`${name}:${i + 1}: action not pinned to a commit SHA with a version comment: ${line.trim()}`);
    }
  });
  return errors;
}

export function checkPip(name, text) {
  const errors = [];
  for (const [n, line] of logicalLines(text)) {
    const m = /\bpip\s+install\b(.*)/.exec(line);
    if (!m) continue;
    const args = m[1].split('#')[0].trim().split(/\s+/).filter(Boolean).map((a) => a.replace(/^["']|["']$/g, ''));
    const reqFiles = [];
    const opts = new Set();
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '-r' || a === '--requirement') {
        reqFiles.push(args[++i] ?? '');
      } else if (a.startsWith('-')) {
        opts.add(a);
        opts.add(a.split('=')[0]);
      } else {
        errors.push(`${name}:${n}: pip installs '${a}' by name; use a hash-pinned requirements file`);
      }
    }
    for (const r of reqFiles) {
      if (!r.startsWith('.github/requirements/')) errors.push(`${name}:${n}: requirements file '${r}' is not under .github/requirements/`);
    }
    if (reqFiles.length && !(opts.has('--require-hashes') && opts.has('--only-binary=:all:'))) {
      errors.push(`${name}:${n}: pip install -r needs --require-hashes and --only-binary=:all:`);
    }
  }
  return errors;
}

/** Splits a workflow into its jobs: Map(job id -> text). */
export function jobs(text) {
  const out = new Map();
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  let current = null;
  for (const line of lines.slice(start + 1)) {
    const m = /^ {2}([A-Za-z_][\w-]*):\s*$/.exec(line);
    if (m) {
      current = m[1];
      out.set(current, '');
    } else if (/^\S/.test(line)) {
      current = null;
    } else if (current) {
      out.set(current, out.get(current) + line + '\n');
    }
  }
  return out;
}

export function checkUploadJobs(name, text) {
  const errors = [];
  for (const [id, body] of jobs(text)) {
    if (!/uses:\s*actions\/upload-artifact@/.test(body)) continue;
    if (/uses:\s*actions\/setup-python@/.test(body) || /\bpip\s+install\b/.test(body)) {
      errors.push(`${name}: job '${id}' uploads artifacts but sets up Python or installs Python packages`);
    }
  }
  return errors;
}

export function checkRequirements(name, text) {
  const errors = [];
  let count = 0;
  for (const [n, raw] of logicalLines(text)) {
    const line = raw.split(' #')[0].trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(/\s+/);
    let end = parts.findIndex((p) => p.startsWith('--hash='));
    if (end < 0) end = parts.length;
    const spec = parts.slice(0, end).join(' ');
    const hashes = parts.slice(end);
    if (!REQUIREMENT.test(spec)) errors.push(`${name}:${n}: not an exact name==version pin: ${spec}`);
    if (!hashes.length || !hashes.every((h) => HASH.test(h))) {
      errors.push(`${name}:${n}: ${spec.split('==')[0]} has no (or a malformed) --hash=sha256:...`);
    }
    count++;
  }
  if (!count) errors.push(`${name}: no requirements`);
  return errors;
}

export function checkDependabot(text, needPip) {
  const errors = [];
  const blocks = ('\n' + text).split(/\n\s*- package-ecosystem:\s*/).slice(1);
  const eco = new Map(blocks.map((b) => [b.split(/\s/)[0], b]));
  for (const want of ['github-actions', ...(needPip ? ['pip'] : [])]) {
    const b = eco.get(want);
    if (!b) errors.push(`dependabot.yml: no ${want} updates`);
    else if (!b.includes('cooldown:')) errors.push(`dependabot.yml: ${want} updates have no cooldown`);
  }
  if (needPip && eco.has('pip') && !eco.get('pip').includes('directory: /.github/requirements')) {
    errors.push('dependabot.yml: pip updates do not cover /.github/requirements');
  }
  return errors;
}

export function check(root) {
  const errors = [];
  const gh = path.join(root, '.github');
  const wfDir = path.join(gh, 'workflows');
  const workflows = existsSync(wfDir) ? readdirSync(wfDir).filter((f) => /\.ya?ml$/.test(f)).sort() : [];
  if (!workflows.length) errors.push('.github/workflows: no workflows found');
  for (const f of workflows) {
    const text = readFileSync(path.join(wfDir, f), 'utf8');
    const rel = `.github/workflows/${f}`;
    errors.push(...checkUses(rel, text), ...checkPip(rel, text), ...checkUploadJobs(rel, text));
  }
  const reqDir = path.join(gh, 'requirements');
  const reqs = existsSync(reqDir) ? readdirSync(reqDir).filter((f) => f.endsWith('.txt')).sort() : [];
  for (const f of reqs) {
    errors.push(...checkRequirements(`.github/requirements/${f}`, readFileSync(path.join(reqDir, f), 'utf8')));
  }
  const dependabot = path.join(gh, 'dependabot.yml');
  if (!existsSync(dependabot)) errors.push('.github/dependabot.yml is missing');
  else errors.push(...checkDependabot(readFileSync(dependabot, 'utf8'), reqs.length > 0));
  return errors;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = process.argv[2] ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const errors = check(root);
  for (const e of errors) console.log(e);
  if (errors.length) {
    console.error(`${errors.length} supply-chain rule violation(s)`);
    process.exit(1);
  }
  console.log('CI supply-chain rules: OK');
}
