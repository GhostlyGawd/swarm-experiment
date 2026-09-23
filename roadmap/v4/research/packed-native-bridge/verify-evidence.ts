import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../..', import.meta.url));
const evidencePath = join(root, 'roadmap/v4/research/packed-native-bridge/results/local-01.json');
const testPath = 'roadmap/v4/research/packed-native-bridge/bridge.test.ts';
const sha256 = (bytes: Uint8Array) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const source = JSON.parse(readFileSync(evidencePath, 'utf8')) as {
  format: string; sourceCommit: string; sources: { path: string; sha256: string }[];
  executableSha256: string; registration: { seed: string; totalOperations: number };
  campaigns: { maxRelative: number; overflow: string; operations: unknown[]; observations: unknown[] }[];
};
assert.equal(source.format, 'aether.packed-native-differential/1');
assert.equal(source.registration.seed, '0x62d8a441');
assert.equal(source.registration.totalOperations, 768);
assert.equal(source.campaigns.length, 6);
for (const item of source.sources) {
  assert.match(item.path, /^(roadmap\/v4\/research\/(?:packed-native-bridge|packed-heap)\/|src\/tier3\/)[a-z0-9.-]+$/);
  const committed = execFileSync('git', ['show', `${source.sourceCommit}:${item.path}`], { cwd: root, maxBuffer: 4 * 1024 * 1024 });
  assert.equal(sha256(committed), item.sha256, `committed source ${item.path}`);
}
for (const [index, item] of source.campaigns.entries()) {
  assert.equal(item.maxRelative, index < 3 ? 1 : 15);
  assert.equal(item.overflow, ['trap', 'wrap', 'saturate'][index % 3]);
  assert.equal(item.operations.length, 128);
  assert.equal(item.observations.length, 128);
}
const folder = mkdtempSync(join(tmpdir(), 'aether-packed-native-verify-'));
try {
  const checkout = join(folder, 'source');
  execFileSync('git', ['worktree', 'add', '--detach', checkout, source.sourceCommit], { cwd: root, stdio: 'ignore' });
  symlinkSync(join(root, 'node_modules'), join(checkout, 'node_modules'), 'dir');
  const rerunPath = join(folder, 'rerun.json');
  execFileSync(process.execPath, ['--test', '--experimental-strip-types', testPath], {
    cwd: checkout, env: { ...process.env, AETHER_PACKED_NATIVE_EVIDENCE: rerunPath },
    encoding: 'utf8', timeout: 60000, maxBuffer: 1024 * 1024,
  });
  const rerun = JSON.parse(readFileSync(rerunPath, 'utf8')) as typeof source;
  assert.equal(rerun.executableSha256, source.executableSha256);
  assert.deepEqual(rerun.sources, source.sources);
  assert.deepEqual(rerun.campaigns, source.campaigns);
  console.log(JSON.stringify({ format: 'aether.packed-native-evidence-verification/1',
    sourceCommit: source.sourceCommit, pinnedSources: source.sources.length,
    campaigns: source.campaigns.length, operations: source.registration.totalOperations,
    nativeBinaryMatches: true, rawRerunMatches: true }, null, 2));
} finally {
  try { execFileSync('git', ['worktree', 'remove', '--force', join(folder, 'source')], { cwd: root, stdio: 'ignore' }); }
  finally { rmSync(folder, { recursive: true, force: true }); }
}
