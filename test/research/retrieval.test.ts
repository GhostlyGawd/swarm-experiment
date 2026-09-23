import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('T1-04 actual-model evidence independently recomputes exact scores, labeled recall, timing summaries and retained artifacts', () => {
  const result = spawnSync(process.execPath, ['--experimental-strip-types', 'roadmap/v4/research/retrieval/verify-evidence.mjs'], { encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.stderr);
  const audit = JSON.parse(result.stdout);
  assert.equal(audit.passed, true); assert.equal(audit.scoredQueries, 72); assert.equal(audit.sourceSnapshotsChecked, 8); assert.equal(audit.persistedInferenceLinksChecked, 175);
  // This offline evidence test does not download model weights or pretend to
  // re-run inference; the separately retained hardware audit checks the cache.
  assert.equal(audit.modelArtifactBytesChecked, null);
});
