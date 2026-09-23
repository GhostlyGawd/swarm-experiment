import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compilePackedGuest, sha256 } from '../build.ts';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../../../..');
const path = resolve(process.argv[2] ?? join(here, 'results/string-local-01.json'));
const data = JSON.parse(readFileSync(path, 'utf8'));
assert.equal(data.format, 'aether.packed-hvf-string-campaign-evidence/1');
assert.match(data.sourceCommit, /^[a-f0-9]{40}$/);
assert.equal(data.sourceFiles.length, 14);
for (const source of data.sourceFiles) {
  assert.match(source.path, /^(?:roadmap|src)\/[A-Za-z0-9_./-]+$/);
  assert.ok(!source.path.split('/').includes('..'));
  const pinned = execFileSync('git', ['show', `${data.sourceCommit}:${source.path}`], { cwd: root });
  assert.equal(sha256(pinned), source.sha256, `pinned ${source.path}`);
  assert.equal(sha256(readFileSync(join(root, source.path))), source.sha256, `current ${source.path}`);
}
assert.deepEqual(data.profile, { heapFormat: 'aether.packed-heap/2', records: 16,
  operations: 128, warmups: 20, samples: 1000,
  boundary: 'fresh guest on already-running controller' });
assert.equal(data.input.operations.length, 128);
assert.equal(data.result.observations.length, 128);
assert.equal(data.result.candidateImageDigest, data.input.imageDigest);
const diagnostic = data.result.diagnostics;
assert.equal(diagnostic.kind, 'packed_hvf_guest_sample');
assert.equal(diagnostic.campaignWarmups, 20);
assert.equal(diagnostic.campaignSamples.length, 1000);
assert.equal(diagnostic.guestMappedBytes, 65536);
assert.equal(diagnostic.guestResidentPeakUpperBoundBytes, 65536);
assert.equal(diagnostic.guestImageBytes, data.binary.guestBytes);
assert.ok(diagnostic.processLaunchToExitNs > 0);
assert.ok(Number.isFinite(diagnostic.tickNs) && diagnostic.tickNs > 0);
const durations: number[] = [];
for (let index = 0; index < 1000; index++) {
  const sample = diagnostic.campaignSamples[index];
  assert.equal(sample.ordinal, index);
  assert.equal(sample.residentBytes, 65536);
  assert.equal(sample.ticks.length, 7);
  for (const tick of sample.ticks) assert.ok(Number.isSafeInteger(tick) && tick > 0);
  for (let stage = 0; stage < 6; stage++) assert.ok(sample.ticks[stage] <= sample.ticks[stage + 1]);
  if (index > 0) assert.ok(diagnostic.campaignSamples[index - 1].ticks[6] < sample.ticks[0]);
  durations.push((sample.ticks[6] - sample.ticks[0]) * diagnostic.tickNs);
}
const last = diagnostic.campaignSamples[999].ticks;
assert.equal(String(last[0]), diagnostic.guestStartTick);
assert.equal(String(last[5]), diagnostic.runStartTick);
assert.equal(String(last[6]), diagnostic.validatedResponseTick);
assert.ok(Math.abs(diagnostic.freshGuestToValidatedResponseNs - durations[999]) < 0.06);
const ordered = [...durations].sort((a, b) => a - b);
const summary = { medianNs: (ordered[499] + ordered[500]) / 2, maxNs: ordered[999],
  mappedBytes: diagnostic.guestMappedBytes, observedResidentBytes: 65536,
  boundedBootGatePassed: ordered[999] <= 1_000_000 };
const temp = mkdtempSync('/tmp/aether-packed-hvf-string-verify-');
try {
  const guest = compilePackedGuest(temp), driver = join(temp, 'campaign-driver');
  execFileSync('clang', ['-O2', '-Wall', '-Wextra', '-Werror', join(here, 'driver.c'),
    '-framework', 'Hypervisor', '-o', driver]);
  execFileSync('codesign', ['--force', '--sign', '-', '--entitlements',
    join(root, 'roadmap/v4/research/native/hypervisor.entitlements'), driver]);
  assert.equal(guest.guestSha256, data.binary.guestSha256);
  assert.equal(readFileSync(guest.image).length, data.binary.guestBytes);
  assert.equal(sha256(readFileSync(driver)), data.binary.driverSha256);
  const freshPath = join(temp, 'fresh.json');
  execFileSync(process.execPath, ['--experimental-strip-types', join(here, 'string-run.ts'), freshPath], {
    cwd: root, timeout: 120000, maxBuffer: 1024 * 1024,
  });
  const fresh = JSON.parse(readFileSync(freshPath, 'utf8'));
  assert.deepEqual(fresh.sourceFiles, data.sourceFiles);
  assert.deepEqual(fresh.binary, data.binary);
  assert.deepEqual(fresh.profile, data.profile);
  assert.deepEqual(fresh.input, data.input);
  assert.deepEqual(fresh.result.observations, data.result.observations);
  assert.equal(fresh.result.candidateImageDigest, data.result.candidateImageDigest);
  assert.equal(fresh.result.diagnostics.campaignSamples.length, 1000);
  console.log(JSON.stringify({ verified: true, sourceCommit: data.sourceCommit,
    operations: data.profile.operations, samples: data.profile.samples, ...summary }));
} finally { rmSync(temp, { recursive: true, force: true }); }
