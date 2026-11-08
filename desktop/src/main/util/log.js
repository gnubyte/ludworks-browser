// Minimal logger. Never pass secrets, tokens, passwords, vault data or page contents to it.
// Warnings and errors also go to <profile>/logs/main.log (rotated at 1 MB) once setLogFile() is called,
// so problems users report can be diagnosed.
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import path from 'node:path';

let logFile = null;
const MAX_LOG = 1024 * 1024;
// Started by a program that gave the browser a pipe for its output and then went away, every console write
// throws EPIPE; logging must never throw (a throwing log call aborts whatever was logging). The console is
// dropped for the rest of the run at its first failure.
let consoleOk = true;
for (const s of [process.stdout, process.stderr]) {
  if (s && typeof s.on === 'function') s.on('error', () => (consoleOk = false));
}

function toConsole(fn, line) {
  if (!consoleOk) return;
  try {
    fn(line);
  } catch {
    consoleOk = false;
  }
}

/** Starts writing warnings and errors to `file` (best effort: logging never throws). */
export function setLogFile(file) {
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    logFile = file;
  } catch {
    logFile = null;
  }
}

function toFile(line) {
  if (!logFile) return;
  try {
    try {
      if (statSync(logFile).size > MAX_LOG) renameSync(logFile, `${logFile}.1`);
    } catch {
      /* no file yet */
    }
    appendFileSync(logFile, `${line}\n`);
  } catch {
    /* disk full, read-only profile: keep running */
  }
}

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[process.env.LUDWORKS_LOG || 'info'] || LEVELS.info;

function fmt(level, msg, extra) {
  const ts = new Date().toISOString();
  let tail = '';
  if (extra instanceof Error) tail = ` ${extra.stack || extra.message}`;
  else if (extra !== undefined) {
    try {
      tail = ` ${JSON.stringify(extra)}`;
    } catch {
      tail = ' [unserialisable]';
    }
  }
  return `${ts} ${level.toUpperCase()} ${msg}${tail}`;
}

function write(level, msg, extra) {
  if (LEVELS[level] < threshold) return;
  const line = fmt(level, msg, extra);
  if (level === 'error' || level === 'warn') {
    toFile(line);
    toConsole(console.error, line);
  } else toConsole(console.log, line);
}

export const log = {
  debug: (m, x) => write('debug', m, x),
  info: (m, x) => write('info', m, x),
  warn: (m, x) => write('warn', m, x),
  error: (m, x) => write('error', m, x),
};
