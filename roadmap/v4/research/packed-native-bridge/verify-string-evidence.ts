import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../..', import.meta.url));
const path = join(root, 'roadmap/v4/research/packed-native-bridge/results/local-02-strings.json');
const sha256 = (bytes: Uint8Array) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const evidence = JSON.parse(readFileSync(path, 'utf8')) as {
  format: string; sourceCommit: string; sources: { path: string; sha256: string }[];
  executableSha256: string; registration: { seed: string; records: number; operations: number; samples: number };
  inputSnapshotDigest: string; inputImageDigest: string; layoutDigest: string; candidateImageDigest: string;
  operations: unknown[]; observations: unknown[]; samplesNs: number[];
  latencyNs: { median: number; maximum: number };
};
assert.equal(evidence.format, 'aether.packed-native-string-differential/2');
assert.deepEqual(evidence.registration, { seed: '0x6c327a91', generator: 'xorshift32', records: 16, operations: 256, samples: 30 });
assert.equal(evidence.operations.length, 256);
assert.equal(evidence.observations.length, 256);
assert.equal(evidence.samplesNs.length, 30);
assert(evidence.samplesNs.every(value => Number.isSafeInteger(value) && value > 0));
const sorted = [...evidence.samplesNs].sort((a, b) => a - b);
assert.deepEqual(evidence.latencyNs, { median: (sorted[14] + sorted[15]) / 2, maximum: sorted[29] });
for (const item of evidence.sources) {
  assert.match(item.path, /^(roadmap\/v4\/research\/(?:packed-native-bridge|packed-heap)\/|src\/tier3\/)[a-z0-9.-]+$/);
  assert.equal(sha256(readFileSync(join(root, item.path))), item.sha256, `current source ${item.path}`);
  const committed = execFileSync('git', ['show', `${evidence.sourceCommit}:${item.path}`], { cwd: root, maxBuffer: 4 * 1024 * 1024 });
  assert.equal(sha256(committed), item.sha256, `committed source ${item.path}`);
}
const folder = mkdtempSync(join(tmpdir(), 'aether-native-string-verify-'));
try {
  const rerunPath = join(folder, 'rerun.json');
  execFileSync(process.execPath, ['--test', '--experimental-strip-types', 'roadmap/v4/research/packed-native-bridge/bridge-strings.test.ts'], {
    cwd: root, env: { ...process.env, AETHER_PACKED_NATIVE_STRING_EVIDENCE: rerunPath },
    encoding: 'utf8', timeout: 60000, maxBuffer: 1024 * 1024,
  });
  const rerun = JSON.parse(readFileSync(rerunPath, 'utf8')) as typeof evidence;
  for (const key of ['sources', 'executableSha256', 'registration', 'inputSnapshotDigest', 'inputImageDigest',
    'layoutDigest', 'candidateImageDigest', 'operations', 'observations'] as const) {
    assert.deepEqual(rerun[key], evidence[key], `rerun ${key}`);
  }
  console.log(JSON.stringify({ format: 'aether.packed-native-string-evidence-verification/1',
    sourceCommit: evidence.sourceCommit, pinnedSources: evidence.sources.length,
    records: evidence.registration.records, operations: evidence.registration.operations,
    samples: evidence.registration.samples, executableMatches: true, rawObservationsMatch: true }, null, 2));
} finally { rmSync(folder, { recursive: true, force: true }); }
