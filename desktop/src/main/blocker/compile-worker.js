// Worker thread: compiles the enabled filter lists (≈1.5 s for the default set) off the main thread,
// writes the result to the engine cache and hands it to the main process.

import { parentPort, workerData } from 'node:worker_threads';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import v8 from 'node:v8';
import { compile } from './engine.js';

const { files, badfilters, cacheFile, signature } = workerData;
try {
  const lists = files.map(({ id, file }) => {
    try {
      return { id, text: readFileSync(file, 'utf8') };
    } catch {
      return { id, text: '' };
    }
  });
  const t0 = performance.now();
  const compiled = compile(lists, { badfilters });
  const ms = Math.round(performance.now() - t0);
  if (cacheFile) {
    const tmp = `${cacheFile}.tmp`;
    writeFileSync(tmp, v8.serialize({ signature, compiled }));
    renameSync(tmp, cacheFile);
  }
  parentPort.postMessage({ ok: true, compiled, ms });
} catch (e) {
  parentPort.postMessage({ ok: false, error: String((e && e.message) || e) });
}
