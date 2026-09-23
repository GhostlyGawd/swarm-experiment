import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256 } from './build.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const path = resolve(process.argv[2] ?? join(root, 'roadmap/v4/research/packed-hvf-guest/results/local-01.json'));
const retained = JSON.parse(readFileSync(path, 'utf8'));
assert.equal(retained.format, 'aether.packed-hvf-guest-evidence/1');
assert.match(retained.sourceCommit, /^[a-f0-9]{40}$/);
assert.ok(Array.isArray(retained.sourceFiles) && retained.sourceFiles.length >= 12);
for (const source of retained.sourceFiles) {
  assert.match(source.path, /^(?:src|roadmap)\/[A-Za-z0-9_./-]+$/);
  assert.ok(!source.path.split('/').includes('..'));
  const blob = execFileSync('git', ['show', `${retained.sourceCommit}:${source.path}`], { cwd: root });
  assert.equal(sha256(blob), source.sha256, `pinned source ${source.path}`);
  assert.equal(sha256(readFileSync(join(root, source.path))), source.sha256, `current source ${source.path}`);
}
function checkDiagnostic(item: any) {
  const d = item.diagnostics;
  assert.ok(d && typeof d === 'object');
  const main = BigInt(d.mainStartTick), guest = BigInt(d.guestStartTick);
  const run = BigInt(d.runStartTick), response = BigInt(d.validatedResponseTick);
  assert.ok(main <= guest && guest <= run && run <= response);
  assert.ok(Number.isFinite(d.tickNs) && d.tickNs > 0);
  const close = (actual: number, ticks: bigint) => assert.ok(Math.abs(actual - Number(ticks) * d.tickNs) < 0.05);
  close(d.mainToResponseNs, response - main);
  close(d.freshGuestToValidatedResponseNs, response - guest);
  close(d.hvVcpuRunToValidatedResponseNs, response - run);
  assert.equal(d.guestImageBytes, retained.binary.guestBytes);
  assert.equal(d.guestMappedBytes, 65536);
  assert.ok(d.guestResidentObservedBytes > 0 && d.guestResidentObservedBytes <= d.guestMappedBytes);
  assert.equal(d.guestResidentPeakUpperBoundBytes, d.guestMappedBytes);
  assert.ok(d.controllerCurrentRssBytes > 0 && d.controllerPeakRssBytes >= d.controllerCurrentRssBytes);
  assert.ok(d.processLaunchToExitNs > 0);
}
for (const item of retained.cases) if (item.diagnostics) checkDiagnostic(item);
const folder = mkdtempSync(join(tmpdir(), 'aether-packed-hvf-verify-'));
try {
  const freshPath = join(folder, 'fresh.json');
  execFileSync(process.execPath, ['--test', '--experimental-strip-types',
    join(root, 'roadmap/v4/research/packed-hvf-guest/bridge.test.ts')], {
    cwd: root, env: { ...process.env, AETHER_PACKED_HVF_EVIDENCE: freshPath },
    timeout: 120000, maxBuffer: 1024 * 1024,
  });
  const fresh = JSON.parse(readFileSync(freshPath, 'utf8'));
  assert.deepEqual(fresh.sourceFiles, retained.sourceFiles);
  assert.deepEqual(fresh.binary, retained.binary);
  assert.deepEqual(fresh.environment, retained.environment);
  const semantic = (value: any) => value.cases.map(({ diagnostics: _diagnostics, ...item }: any) => item);
  assert.deepEqual(semantic(fresh), semantic(retained));
  for (const item of fresh.cases) if (item.diagnostics) checkDiagnostic(item);
  console.log(JSON.stringify({ verified: true, sourceCommit: retained.sourceCommit,
    cases: retained.cases.length, guestRuns: retained.cases.filter((item: any) => item.diagnostics).length,
    operations: retained.cases.reduce((sum: number, item: any) => sum + (item.operations?.length ?? 0), 0),
    guestSha256: retained.binary.guestSha256, driverSha256: retained.binary.driverSha256 }));
} finally { rmSync(folder, { recursive: true, force: true }); }
