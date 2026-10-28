#!/usr/bin/env node
// The vendored web vault library (desktop/src/vendor/vault) must stay identical to the server's
// copy (ludworks-server/web/assets/js/lib/vault). Skips when the server checkout is not next to
// this repository (e.g. in this repository's CI).
//
//   node desktop/scripts/check-vendor.mjs            fail on drift
//   node desktop/scripts/check-vendor.mjs --update   copy the server versions in

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const vendor = path.join(here, '..', 'src', 'vendor', 'vault');
const server = process.env.LUDWORKS_SERVER_DIR ? path.join(process.env.LUDWORKS_SERVER_DIR, 'web', 'assets', 'js', 'lib', 'vault') : path.join(here, '..', '..', '..', 'ludworks-server', 'web', 'assets', 'js', 'lib', 'vault');
if (!existsSync(server)) {
  console.log('check-vendor: ludworks-server checkout not found, skipped');
  process.exit(0);
}
let drift = 0;
for (const f of readdirSync(vendor).filter((x) => x.endsWith('.js'))) {
  const a = readFileSync(path.join(vendor, f));
  const b = readFileSync(path.join(server, f));
  if (a.equals(b)) continue;
  if (process.argv.includes('--update')) writeFileSync(path.join(vendor, f), b);
  else console.error(`check-vendor: ${f} differs from the server copy`);
  drift++;
}
if (drift && !process.argv.includes('--update')) process.exit(1);
console.log(drift ? `check-vendor: updated ${drift} file(s)` : 'check-vendor: vendored vault library matches the server');
