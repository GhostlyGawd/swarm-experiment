import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { digest, type BenchmarkRunV1 } from '../../bench/v4/manifest.ts';
import { verifyBenchmarkEvidence } from '../../bench/v4/verify.ts';

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'aether-bench-verify-'));
  const child = spawnSync(process.execPath, ['--experimental-strip-types', 'bench/v4/cli.ts', '--measure', '--output', directory], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  return directory;
}
const read = (directory: string, file: string) => JSON.parse(readFileSync(join(directory, file), 'utf8'));
const write = (directory: string, file: string, value: unknown) => writeFileSync(join(directory, file), JSON.stringify(value, null, 2) + '\n');

test('independent benchmark reader recounts complete messages, target rows and current source bytes', () => {
  const directory = fixture(); try {
    const result = verifyBenchmarkEvidence(directory, { sourceRoot: resolve('.') });
    const manifest = read(directory, 'manifest.json') as BenchmarkRunV1;
    assert.equal(manifest.profile.id, 'v4-release/2');
    assert.deepEqual(manifest.measurements.filter(row => row.required && row.requirement === 'V4-NFR-11')
      .map(row => row.verdict), ['pass', 'pass']);
    assert.equal(manifest.measurements.filter(row =>
      row.required && row.verdict === 'not_measured').length, 15);
    assert.equal(result.verified, true); assert.equal(result.sourceMatches, null);
    assert.equal(result.requiredFailures.length, 15); assert.equal(result.releaseEligible, false);
    const exact = verifyBenchmarkEvidence(directory, { sourceRoot: resolve('.'), exactSource: true });
    assert.equal(exact.sourceMatches, true); assert.equal(exact.releaseEligible, false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('verifier refuses altered verdicts, thresholds, raw messages, source list and noncanonical JSON', () => {
  for (const tamper of ['verdict', 'threshold', 'raw', 'source', 'duplicate-json'] as const) {
    const directory = fixture(); try {
      const manifest = read(directory, 'manifest.json'), samples = read(directory, 'samples.json');
      if (tamper === 'verdict') {
        const original = manifest.measurements[0].verdict;
        manifest.measurements[0].verdict = original === 'pass' ? 'fail' : 'pass';
        assert.notEqual(manifest.measurements[0].verdict, original);
      }
      if (tamper === 'threshold') { manifest.profile.targets[0].minimum = 0; manifest.targetProfileDigest = digest(manifest.profile); }
      if (tamper === 'raw') {
        samples.corpus[0].session[0].candidate += ' extra tokens';
        manifest.samplesDigest = digest(samples); manifest.workloadDigest = digest(samples.corpus);
      }
      if (tamper === 'source') { samples.sourceFiles[0].digest = digest('different bytes'); manifest.samplesDigest = digest(samples); manifest.sourceTreeDigest = digest(samples.sourceFiles); }
      if (tamper === 'duplicate-json') {
        const path = join(directory, 'manifest.json');
        writeFileSync(path, readFileSync(path, 'utf8').replace('"format": "aether.benchmark/1",', '"format": "aether.benchmark/1", "format": "aether.benchmark/1",'));
      } else { write(directory, 'manifest.json', manifest); write(directory, 'samples.json', samples); }
      if (tamper === 'source') assert.throws(() => verifyBenchmarkEvidence(directory, { sourceRoot: resolve('.'), exactSource: true }), /source differs/);
      else if (tamper === 'verdict') assert.throws(() => verifyBenchmarkEvidence(directory, { sourceRoot: resolve('.') }),
        /benchmark measurement\/verdict differs from raw corpus/);
      else assert.throws(() => verifyBenchmarkEvidence(directory, { sourceRoot: resolve('.') }), /benchmark|noncanonical/i);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }
});

test('source commit substitution cannot pass exact-source verification', () => {
  const directory = fixture(); try {
    const manifest = read(directory, 'manifest.json'); manifest.subjectCommit = '0'.repeat(40); write(directory, 'manifest.json', manifest);
    assert.throws(() => verifyBenchmarkEvidence(directory, { sourceRoot: resolve('.'), exactSource: true }), /source differs/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('changed hardware diagnostics cannot pass exact-source verification', () => {
  const directory = fixture(); try {
    const manifest = read(directory, 'manifest.json'); manifest.environment.cpu = 'made-up CPU'; write(directory, 'manifest.json', manifest);
    assert.throws(() => verifyBenchmarkEvidence(directory, { sourceRoot: resolve('.'), exactSource: true }), /environment differs/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
