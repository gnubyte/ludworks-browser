// Minimal ustar writer (Node built-ins only) for the Linux .tar.gz: regular files and directories,
// explicit modes, root ownership, fixed mtime (reproducible). Names up to 255 bytes (prefix/name split).

function header(name, { size = 0, mode = 0o644, type = '0', mtime = 0 }) {
  const b = Buffer.alloc(512);
  let prefix = '';
  let base = name;
  if (Buffer.byteLength(name) > 100) {
    const i = name.lastIndexOf('/', 155);
    if (i <= 0 || Buffer.byteLength(name.slice(i + 1)) > 100) throw new Error(`tar: name too long: ${name}`);
    prefix = name.slice(0, i);
    base = name.slice(i + 1);
  }
  b.write(base, 0, 100, 'utf8');
  b.write(`${mode.toString(8).padStart(7, '0')}\0`, 100, 'ascii');
  b.write('0000000\0', 108, 'ascii'); // uid
  b.write('0000000\0', 116, 'ascii'); // gid
  b.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 'ascii');
  b.write(`${Math.floor(mtime).toString(8).padStart(11, '0')}\0`, 136, 'ascii');
  b.write('        ', 148, 'ascii');
  b.write(type, 156, 'ascii');
  b.write('ustar\0', 257, 'ascii');
  b.write('00', 263, 'ascii');
  b.write('root', 265, 'ascii');
  b.write('root', 297, 'ascii');
  b.write(prefix, 345, 155, 'utf8');
  let sum = 0;
  for (const x of b) sum += x;
  b.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii');
  return b;
}

/**
 * @param {Array<{name: string, data?: Buffer, mode?: number, dir?: boolean}>} entries
 * @param {{mtime?: number}} [opts] seconds since the epoch
 * @returns {Buffer}
 */
export function createTar(entries, { mtime = 0 } = {}) {
  const parts = [];
  for (const e of entries) {
    if (e.dir) {
      parts.push(header(e.name.endsWith('/') ? e.name : `${e.name}/`, { mode: e.mode ?? 0o755, type: '5', mtime }));
      continue;
    }
    const data = e.data || Buffer.alloc(0);
    parts.push(header(e.name, { size: data.length, mode: e.mode ?? 0o644, mtime }), data);
    const pad = (512 - (data.length % 512)) % 512;
    if (pad) parts.push(Buffer.alloc(pad));
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}
