// Rule 1 of .github/check-supply-chain.mjs: actions pinned to commit SHAs, local reusable workflows allowed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkUses } from '../.github/check-supply-chain.mjs';

const SHA = '3d3c42e5aac5ba805825da76410c181273ba90b1';

test('supply chain: pinned actions and local reusable workflows pass', () => {
  assert.deepEqual(checkUses('w.yml', `      - uses: actions/checkout@${SHA} # v7.0.1`), []);
  assert.deepEqual(checkUses('w.yml', '    uses: ./.github/workflows/desktop.yml'), []);
});

test('supply chain: tags, branches, missing comments and other local paths fail', () => {
  for (const line of [
    '      - uses: actions/checkout@v7',
    `      - uses: actions/checkout@${SHA}`,
    '      - uses: someone/action@main # v1',
    '    uses: ./.github/workflows/../../evil.yml',
    '      - uses: ./local-action',
    '    uses: other/repo/.github/workflows/x.yml@main',
  ]) {
    assert.equal(checkUses('w.yml', line).length, 1, line);
  }
});
