import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const report = JSON.parse(readFileSync(new URL('./results/campaign-01.json', import.meta.url), 'utf8'));
assert.equal(report.format, 'aether.capability-matrix-v2/1');
assert.match(report.commit, /^[0-9a-f]{40}$/);
assert.equal(typeof report.dirty, 'boolean');
assert.equal(report.sourceCommitted, true, 'source files were not committed at measurement time');
assert.equal(report.sourceStable, true, 'source files changed during measurement');
assert.match(report.nodeVersion, /^v\d+\.\d+\.\d+$/);
assert.ok(['darwin', 'linux', 'win32'].includes(report.platform));
const expectedSources = [
  ...execFileSync('git', ['ls-tree', '-r', '--name-only', report.commit, 'src'], { cwd: root, encoding: 'utf8' }).trim().split('\n').filter(Boolean),
  'roadmap/v4/research/capability-matrix-v2/run.ts',
  'roadmap/v4/research/capability-matrix-v2/verify.mjs',
].sort();
assert.deepEqual(Object.keys(report.sourceHashes), expectedSources);
for (const [path, digest] of Object.entries(report.sourceHashes)) {
  assert.match(digest, /^[0-9a-f]{64}$/);
  assert.equal(createHash('sha256').update(execFileSync('git', ['show', `${report.commit}:${path}`], { cwd: root })).digest('hex'), digest, path + ' does not match recorded commit');
  if (process.argv.includes('--exact-source'))
    assert.equal(createHash('sha256').update(readFileSync(join(root, path))).digest('hex'), digest, path);
}
const required = [];
for (const boundary of ['topology/direct', 'process/direct', 'deployment/direct']) {
  for (const attack of ['missing', 'forged', 'wrong-audience', 'wrong-path', 'narrowed',
    'extra', 'duplicate', 'edited-policy', 'revoked', 'stale-epoch', 'stale-policy', 'expired'])
    required.push(boundary + '/' + attack);
}
required.push(
  'topology/closure/revoked-before-protected-sink',
  'topology/task/revoked-before-protected-sink',
  'topology/cross-unit/revoked-before-protected-sink',
  'process/cross-process/wrong-audience',
  'process/cross-process/positive',
  'process/cross-process/replay-revoked',
  'process/cross-process/revoked-at-boundary',
  'process/cross-process/reopen-after-boundary-revocation',
  'process/reopen/denial-persistence',
  'process/effect/revoked-before-sink',
  'process/effect/reopen-after-revocation',
  'process/effect/retry-revoked',
  'process/final-publication/revoked',
  'process/final-publication/reopen',
  'deployment/reopen/denial-persistence',
  'deployment/direct/positive',
  'deployment/direct/replay-revoked',
  'deployment/direct/replay-revoked-after-reopen',
);
for (const attack of ['forged', 'wrong-audience', 'wrong-path', 'narrowed', 'duplicate'])
  required.push('process/effect-grant/' + attack);
const ids = report.cases.map(row => row.id);
assert.equal(new Set(ids).size, ids.length, 'duplicate case IDs');
assert.deepEqual([...ids].sort(), [...required].sort(), 'unexpected or missing cases');
for (const row of report.cases) {
  assert.equal(typeof row.observed, 'string', row.id);
  assert.ok(row.observed.length > 0, row.id);
  assert.ok(Number.isSafeInteger(row.sinkBefore) && Number.isSafeInteger(row.sinkAfter) && row.sinkBefore >= 0 && row.sinkAfter >= row.sinkBefore, row.id);
  assert.equal(row.sinkAfter - row.sinkBefore, row.sinkDelta, row.id);
  assert.equal(row.heapBefore !== row.heapAfter, row.heapChanged, row.id);
  assert.match(row.heapBefore, /^(?:[0-9a-f]{64}|aether\.state\/1:b3:[0-9a-f]{64})$/, row.id);
  assert.match(row.heapAfter, /^(?:[0-9a-f]{64}|aether\.state\/1:b3:[0-9a-f]{64})$/, row.id);
  if (row.id === 'process/cross-process/positive') {
    assert.equal(row.expected, 'allow-one-sink-changed-heap', row.id);
    assert.equal(row.observed, 'completed', row.id);
    assert.equal(row.denied, false, row.id);
    assert.equal(row.sinkDelta, 1, row.id);
    assert.equal(row.heapChanged, true, row.id);
  } else if (row.id === 'deployment/direct/positive') {
    assert.equal(row.expected, 'allow-zero-sink-changed-heap', row.id);
    assert.equal(row.observed, 'completed', row.id);
    assert.equal(row.denied, false, row.id);
    assert.equal(row.sinkDelta, 0, row.id);
    assert.equal(row.heapChanged, true, row.id);
  } else {
    assert.equal(row.expected, 'deny-zero-sink-unchanged-heap', row.id);
    assert.equal(row.denied, true, row.id + ' allowed an attack: ' + row.observed);
    assert.equal(row.sinkDelta, 0, row.id + ' reached a live sink');
    assert.equal(row.heapChanged, false, row.id + ' published heap state');
    if (row.id.startsWith('topology/direct/')) {
      assert.equal(row.observed, 'authority', row.id);
    } else if (row.id.startsWith('topology/')) {
      assert.match(row.observed, /authority_denied/, row.id);
    } else if (row.id.endsWith('/denial-persistence') || row.id.endsWith('/reopen') || row.id.includes('/reopen-after-')) {
      assert.equal(row.observed, 'unchanged', row.id);
    } else if (row.id === 'process/effect-grant/narrowed') {
      const result = JSON.parse(row.observed);
      assert.equal(result.state, 'completed', row.id);
      assert.equal(result.execution?.ok, false, row.id);
      assert.match(result.execution.fault?.message, /authority_denied/, row.id);
    } else if (row.id === 'process/effect/revoked-before-sink'
      || row.id === 'process/cross-process/revoked-at-boundary'
      || row.id === 'process/final-publication/revoked') {
      const result = JSON.parse(row.observed);
      assert.equal(result.state, 'indeterminate', row.id);
      if (row.id !== 'process/effect/revoked-before-sink') assert.match(result.reason, /authority_denied/, row.id);
      else assert.match(result.reason, /effect_indeterminate/, row.id);
    } else {
      assert.match(row.observed, /authority_denied|capability grant identity mismatch/, row.id);
    }
  }
}
console.log(JSON.stringify({ verified: report.cases.length, commit: report.commit,
  exactSource: process.argv.includes('--exact-source'), sourcePaths: expectedSources.length }));
