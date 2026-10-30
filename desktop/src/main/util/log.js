// Minimal logger. Never pass secrets, tokens, passwords, vault data or page contents to it.
// Warnings and errors also go to <profile>/logs/main.log (rotated at 1 MB) once setLogFile() is called,
// so problems users report can be diagnosed.
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import path from 'node:path';

let logFile = null;
const MAX_LOG = 1024 * 1024;

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
    console.error(line);
    toFile(line);
  } else console.log(line);
}

export const log = {
  debug: (m, x) => write('debug', m, x),
  info: (m, x) => write('info', m, x),
  warn: (m, x) => write('warn', m, x),
  error: (m, x) => write('error', m, x),
};
