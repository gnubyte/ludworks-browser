// Minimal logger. Never pass secrets, tokens, passwords, vault data or page contents to it.

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
  if (level === 'error' || level === 'warn') console.error(line);
  else console.log(line);
}

export const log = {
  debug: (m, x) => write('debug', m, x),
  info: (m, x) => write('info', m, x),
  warn: (m, x) => write('warn', m, x),
  error: (m, x) => write('error', m, x),
};
