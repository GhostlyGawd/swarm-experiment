import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compilePackedGuest, sha256 } from '../packed-hvf-guest/build.ts';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../../..');
const path = resolve(process.argv[2] ?? join(here, 'results/local-01.json'));
const data = JSON.parse(readFileSync(path, 'utf8'));
assert.equal(data.format, 'aether.hvf-map-coalescing-evidence/1');
assert.match(data.sourceCommit, /^[a-f0-9]{40}$/);
assert.equal(data.sourceFiles.length, 9);
for (const item of data.sourceFiles) {
  assert.match(item.path, /^(?:roadmap|src)\/[A-Za-z0-9_./-]+$/);
  assert.ok(!item.path.split('/').includes('..'));
  const historical = execFileSync('git', ['show', `${data.sourceCommit}:${item.path}`], { cwd: root });
  assert.equal(sha256(historical), item.sha256, `pinned ${item.path}`);
  assert.equal(sha256(readFileSync(join(root, item.path))), item.sha256, `current ${item.path}`);
}
const raw = data.raw;
assert.equal(raw.format, 'aether.hvf-map-coalescing-raw/1');
assert.equal(raw.warmupPairs, 20);
assert.equal(raw.samplePairs, 1000);
assert.equal(raw.guestMappedBytes, 65536);
assert.equal(raw.frameBytes, 7360);
assert.ok(Number.isSafeInteger(raw.guestImageBytes) && raw.guestImageBytes > 0 && raw.guestImageBytes <= 16384);
assert.ok(Number.isSafeInteger(raw.tickNumer) && raw.tickNumer > 0);
assert.ok(Number.isSafeInteger(raw.tickDenom) && raw.tickDenom > 0);
assert.equal(raw.samples.length, 2000);
const scale = raw.tickNumer / raw.tickDenom;
const elapsed: number[][] = [[], []];
const stages: number[][][] = [Array.from({ length: 6 }, () => []), Array.from({ length: 6 }, () => [])];
for (let pair = 0; pair < 1000; pair++) {
  for (let mode = 0; mode < 2; mode++) {
    const sample = raw.samples[pair * 2 + mode];
    assert.equal(sample.pair, pair);
    assert.equal(sample.mode, mode);
    assert.equal(sample.residentBytes, 65536);
    assert.equal(sample.ticks.length, 7);
    const ticks = sample.ticks.map((value: number) => BigInt(value));
    for (let step = 0; step < 6; step++) {
      assert.ok(ticks[step] <= ticks[step + 1]);
      stages[mode][step].push(Number(ticks[step + 1] - ticks[step]) * scale);
    }
    elapsed[mode].push(Number(ticks[6] - ticks[0]) * scale);
  }
  const first = raw.samples[pair * 2 + (pair & 1)];
  const second = raw.samples[pair * 2 + ((pair & 1) ^ 1)];
  assert.ok(BigInt(first.ticks[6]) < BigInt(second.ticks[0]), 'alternating paired execution');
}
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return (sorted[499] + sorted[500]) / 2;
}
const maximum = (values: number[]) => Math.max(...values);
const summary = {
  split: { medianNs: median(elapsed[0]), maxNs: maximum(elapsed[0]),
    rwMedianNs: median(stages[0][3]) },
  coalesced: { medianNs: median(elapsed[1]), maxNs: maximum(elapsed[1]),
    rwMedianNs: median(stages[1][3]) },
  optimized: median(elapsed[1]) < median(elapsed[0]),
  boundedBootGatePassed: maximum(elapsed[1]) <= 1_000_000,
  allResidentBytes: 65536,
};
const temp = mkdtempSync('/tmp/aether-hvf-map-verify-');
try {
  const guest = compilePackedGuest(temp), driver = join(temp, 'map-driver');
  execFileSync('clang', ['-O2', '-Wall', '-Wextra', '-Werror', join(here, 'driver.c'),
    '-framework', 'Hypervisor', '-o', driver]);
  execFileSync('codesign', ['--force', '--sign', '-', '--entitlements',
    join(root, 'roadmap/v4/research/native/hypervisor.entitlements'), driver]);
  assert.equal(guest.guestSha256, data.binary.guestSha256);
  assert.equal(readFileSync(guest.image).length, raw.guestImageBytes);
  assert.equal(sha256(readFileSync(driver)), data.binary.driverSha256);
  console.log(JSON.stringify({ verified: true, sourceCommit: data.sourceCommit, ...summary }));
} finally { rmSync(temp, { recursive: true, force: true }); }
