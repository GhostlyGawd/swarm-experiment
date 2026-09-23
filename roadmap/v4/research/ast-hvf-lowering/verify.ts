/** Independent retained-evidence audit; does not import the guest compiler. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url)), repo = resolve(here, '../../../..'), output = join(here, 'results/local-01');
const hash = (bytes: Uint8Array) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const report = JSON.parse(readFileSync(join(output, 'report.json'), 'utf8')) as {
  format: string; gitCommit: string; sourceHashes: Record<string, string>; platform: { arch: string; platform: string; hardware: string; pageBytes: number };
  artifacts: Record<string, { root: string; manifestDigest: string; generatedSourceSha256: string; guestImageSha256: string; guestImageBytes: number; controllerSha256: string }>;
  comparisons: { name: string; args: (string | Record<string, string>)[]; expected: string; actual: string; frameSha256: string; sample: Record<string, number | string> }[];
  adversarial: { editedImageSha256: string; editedResult: string; wrongDigestExit: number; badFieldStatus: number; overflowStatus: number; divisionByZeroStatus: number; divisionByZeroReference: { state: string; fault: string } };
};
assert.equal(report.format, 'aether.ast-hvf-lowering-research/1');
assert.match(report.gitCommit, /^[0-9a-f]{40}$/);
assert.equal(report.platform.arch, 'arm64'); assert.equal(report.platform.platform, 'darwin');
assert.equal(report.platform.pageBytes, 16384);
for (const [path, expected] of Object.entries(report.sourceHashes)) {
  const absolute = resolve(here, path), repoPath = relative(repo, absolute);
  assert.ok(!repoPath.startsWith('..'), `source path outside repository: ${path}`);
  assert.equal(hash(readFileSync(absolute)), expected, `current source changed: ${path}`);
  assert.equal(hash(execFileSync('git', ['show', `${report.gitCommit}:${repoPath}`], { cwd: repo })), expected, `pinned source changed: ${path}`);
}
assert.deepEqual(Object.keys(report.artifacts).sort(), ['arithmetic', 'division', 'packed']);
for (const [name, artifact] of Object.entries(report.artifacts)) {
  assert.match(artifact.root, /^ast:b3:[0-9a-f]{64}$/);
  assert.match(artifact.manifestDigest, /^aether\.execution\/1:b3:[0-9a-f]{64}$/);
  assert.equal(hash(readFileSync(join(output, `${name}.c`))), artifact.generatedSourceSha256);
  const image = readFileSync(join(output, `${name}.bin`));
  assert.equal(image.length, artifact.guestImageBytes);
  assert.equal(hash(image), artifact.guestImageSha256);
}
assert.equal(hash(readFileSync(join(output, 'driver'))), report.artifacts.arithmetic!.controllerSha256);
assert.equal(hash(readFileSync(join(output, 'edited.bin'))), report.adversarial.editedImageSha256);
assert.equal(hash(readFileSync(join(output, 'edited.c'))).startsWith('sha256:'), true);
assert.equal(report.adversarial.editedResult, '29');
assert.equal(report.adversarial.wrongDigestExit, 2);
assert.equal(report.adversarial.badFieldStatus, 3);
assert.equal(report.adversarial.overflowStatus, 1);
assert.equal(report.adversarial.divisionByZeroStatus, 2);
assert.deepEqual({ state: report.adversarial.divisionByZeroReference.state, fault: report.adversarial.divisionByZeroReference.fault },
  { state: 'faulted', fault: 'division_by_zero' });
assert.equal(report.comparisons.length, 57);
let arithmetic = 0, packed = 0, division = 0;
const intervals: number[] = [];
for (const [index, row] of report.comparisons.entries()) {
  const args = row.args;
  let independent: bigint;
  if (row.name === 'arithmetic') {
    arithmetic++; const x = BigInt(args[0] as string), y = BigInt(args[1] as string);
    independent = x > y ? x * 3n + y : y - x;
  } else if (row.name === 'packed') {
    packed++; const record = args[0] as Record<string, string>, x = BigInt(args[1] as string);
    assert.deepEqual(Object.keys(record).sort(), ['delta', 'number']);
    independent = x > 0n ? BigInt(record.number) + x * 2n : BigInt(record.delta) - x;
  } else {
    assert.equal(row.name, 'division', `unexpected case ${index}`); division++;
    independent = BigInt(args[0] as string) / BigInt(args[1] as string);
  }
  assert.equal(row.expected, String(independent), `independent expected ${index}`);
  assert.equal(row.actual, row.expected, `guest result ${index}`);
  assert.match(row.frameSha256, /^sha256:[0-9a-f]{64}$/);
  const sample = row.sample;
  assert.equal(sample.kind, 'ast_hvf_guest_sample');
  for (const key of ['mainStartTick', 'guestStartTick', 'runStartTick', 'validatedResponseTick']) assert.ok(Number.isSafeInteger(sample[key]));
  assert.ok((sample.mainStartTick as number) <= (sample.guestStartTick as number));
  assert.ok((sample.guestStartTick as number) <= (sample.runStartTick as number));
  assert.ok((sample.runStartTick as number) <= (sample.validatedResponseTick as number));
  const ns = ((sample.validatedResponseTick as number) - (sample.guestStartTick as number)) * (sample.tickNs as number);
  assert.ok(Math.abs(ns - (sample.freshGuestToValidatedResponseNs as number)) < 2, `timing arithmetic ${index}`);
  assert.equal(sample.guestMappedBytes, 65536);
  assert.ok((sample.guestResidentObservedBytes as number) > 0 && (sample.guestResidentObservedBytes as number) <= 65536);
  intervals.push(ns);
}
assert.deepEqual([arithmetic, packed, division], [28, 27, 2]);
const rerun = execFileSync(process.execPath, ['--experimental-strip-types', join(here, 'run.ts'), '--verify'],
  { cwd: repo, encoding: 'utf8', timeout: 120_000, maxBuffer: 1024 * 1024 });
assert.match(rerun, /retained evidence verified against rebuilt artifacts and 57 fresh guest comparisons/);
intervals.sort((a, b) => a - b);
console.log(JSON.stringify({ verified: 57, independentReference: true, rebuiltAndReranGuest: true,
  minFreshGuestNs: intervals[0], medianFreshGuestNs: intervals[Math.floor(intervals.length / 2)], maxFreshGuestNs: intervals.at(-1),
  maxPassesOneMillisecond: intervals.at(-1)! <= 1_000_000 }));
