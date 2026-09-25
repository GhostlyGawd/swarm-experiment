/** Clean-source external-sink living campaign and offline verifier. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, loadavg, platform, release, tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeCanonical } from '../../../../src/fabric/encoding.ts';
import { domainDigest } from '../../../../src/fabric/identity.ts';
import { assertLivingEffectAuthorizationV4 } from '../../../../src/tier3/living-effect-authorization.ts';
import { measureR04JsonEvents } from '../../../../src/tier3/living-campaign.ts';
import { externalFixture, EXTERNAL_REPOSITORY } from './fixture.ts';
import { auditExternalRaw, prepareExternal, runExternal, type ExternalCampaignResult,
  type ExternalRegistration } from './harness.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const profilePath = join(root, 'roadmap/v4/research/microworld-external/profile.json');
const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const captured = new Set<string>();
function capture(path: string): void {
  if (captured.has(path)) return; captured.add(path);
  if (!path.endsWith('.ts')) return;
  const source = readFileSync(join(root, path), 'utf8');
  for (const match of source.matchAll(/(?:from\s*|import\s*\()['"](\.{1,2}\/[^'"\n]+\.ts)['"]/g)) {
    capture(relative(root, resolve(root, dirname(path), match[1])));
  }
}
for (const path of ['roadmap/v4/research/microworld-external/campaign.ts',
  'roadmap/v4/research/microworld-external/worker.ts',
  'roadmap/v4/research/microworld-external/gateway.ts',
  'src/fabric/witness-service-cli.ts', 'src/fabric/attested-sink-service-cli.ts',
  'roadmap/v4/research/microworld-external/profile.json', 'package-lock.json']) capture(path);
const sourcePaths = [...captured].sort();
const sources = () => Object.fromEntries(sourcePaths.map(path => [path, sha(readFileSync(join(root, path)))]));
const diagnostic = () => ({ at: new Date().toISOString(), node: process.version,
  platform: platform(), release: release(), arch: process.arch, cpus: cpus().map(cpu => cpu.model),
  load: loadavg(), memory: process.memoryUsage() });
function durabilityProbe(): {
  format: 'aether.living-durability-probe/1'; warmups: number; samples: number; bytesPerRecord: number;
  raw: { ordinal: number; fileFsyncNs: string; directoryFsyncNs: string; totalNs: string }[];
  minimumNs: string; medianNs: string; maximumNs: string; serialRecordsPerSecond: number;
} {
  const directory = mkdtempSync(join(tmpdir(), 'aether-living-fsync-probe-'));
  try {
    const raw: { ordinal: number; fileFsyncNs: string; directoryFsyncNs: string; totalNs: string }[] = [];
    for (let ordinal = -10; ordinal < 100; ordinal++) {
      const started = process.hrtime.bigint();
      const fd = openSync(join(directory, `record-${ordinal}`), 'wx', 0o600);
      let fileFsyncNs: bigint;
      try {
        writeFileSync(fd, Buffer.alloc(256, ordinal & 255));
        const before = process.hrtime.bigint(); fsyncSync(fd); fileFsyncNs = process.hrtime.bigint() - before;
      } finally { closeSync(fd); }
      const dirFd = openSync(directory, 'r'); let directoryFsyncNs: bigint;
      try { const before = process.hrtime.bigint(); fsyncSync(dirFd); directoryFsyncNs = process.hrtime.bigint() - before; }
      finally { closeSync(dirFd); }
      const totalNs = process.hrtime.bigint() - started;
      if (ordinal >= 0) raw.push({ ordinal, fileFsyncNs: String(fileFsyncNs),
        directoryFsyncNs: String(directoryFsyncNs), totalNs: String(totalNs) });
    }
    const ordered = raw.map(sample => BigInt(sample.totalNs)).sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
    const sum = ordered.reduce((a, b) => a + b, 0n);
    return { format: 'aether.living-durability-probe/1', warmups: 10, samples: 100, bytesPerRecord: 256,
      raw, minimumNs: String(ordered[0]), medianNs: String((ordered[49] + ordered[50]) / 2n),
      maximumNs: String(ordered.at(-1)!), serialRecordsPerSecond: 100 / (Number(sum) / 1e9) };
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
function write(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const fd = openSync(path, 'wx', 0o600);
  try { writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
  const parent = openSync(dirname(path), 'r'); try { fsyncSync(parent); } finally { closeSync(parent); }
}
const read = (path: string): any => JSON.parse(readFileSync(path, 'utf8'));
const equal = (actual: unknown, expected: unknown): void => {
  assert.ok(Buffer.from(encodeCanonical(actual)).equals(Buffer.from(encodeCanonical(expected))), 'external campaign observation changed');
};
function validateRegistration(registration: ExternalRegistration): void {
  const fixture = externalFixture(), authorization = registration.authorization;
  assert.equal(authorization?.format, 'aether.living-effect-authorization/4');
  assertLivingEffectAuthorizationV4(authorization, { candidateRoot: fixture.manifest.candidateRoot,
    campaignDigest: fixture.campaignDigest, repositoryId: EXTERNAL_REPOSITORY,
    policyEpoch: '1', signer: 'living-integrated-operator', key: registration.operatorPublicKeyPem });
  equal(registration.anchor, authorization.externalSink.anchor);
  assert.equal(registration.generated.length, 15);
  const expectedManifest = domainDigest('aether.living-effect-campaign/4', { manifest: fixture.manifest, authorization });
  assert.ok(registration.generated.every(item => item.manifestDigest === expectedManifest));
}
async function measure(directory: string): Promise<void> {
  if (existsSync(directory)) throw new Error('external campaign output must not exist');
  const gitHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const gitStatus = execFileSync('git', ['status', '--short'], { cwd: root, encoding: 'utf8' });
  const privateDirectory = mkdtempSync(join(tmpdir(), 'aether-living-external-private-'));
  let prepared;
  try {
    prepared = await prepareExternal(privateDirectory, directory);
    validateRegistration(prepared.registration);
    const profile = read(profilePath);
    assert.equal(profile.format, 'aether.living-external-research-profile/3');
    assert.equal(profile.minimumBoundaryPermutationsPerSecond, 2_000_000);
    write(join(directory, 'preregistration.json'), { format: 'aether.living-external-preregistration/1',
      at: new Date().toISOString(), gitHead, gitStatus, profileSha256: sha(readFileSync(profilePath)),
      registrationSha256: sha(readFileSync(prepared.registrationPath)), sources: sources(),
      declared: prepared.registration.generated.length,
      seeds: prepared.registration.generated.map(item => item.seed), diagnostic: diagnostic() });
    write(join(directory, 'attempt.json'), { format: 'aether.living-external-attempt/1',
      registrationSha256: sha(readFileSync(prepared.registrationPath)), before: diagnostic() });
    const started = process.hrtime.bigint();
    const result = await runExternal(prepared, directory);
    auditExternalRaw(directory, result, prepared.registration);
    for (let index = 0; index < result.cases.length; index++) write(join(directory, 'cases', `${index}.json`), result.cases[index]);
    write(join(directory, 'process-result.json'), result);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    // Fixed R04 kernel remains a separate materialized-input observation. Its
    // pass/fail cannot authorize the signed/external campaign rate above.
    const kernel = measureR04JsonEvents();
    write(join(directory, 'r04-kernel.json'), kernel);
    const durable = durabilityProbe();
    write(join(directory, 'durability-probe.json'), durable);
    const pipeline = result.pipeline;
    write(join(directory, 'results.json'), { format: 'aether.living-external-measurement/3',
      registrationSha256: sha(readFileSync(prepared.registrationPath)),
      declared: 15, generated: result.generated, executed: result.executed, filtered: result.filtered,
      passed: result.passed, failed: result.failed, attempted: result.attempted,
      separateFailedPartitionAttempts: 1, partitionUnknown: result.partitionUnknown,
      reconciled: result.reconciled, sinkDecisions: result.sinkDecisions,
      candidateRestarts: result.candidateRestarts, workerTermination: result.workerTermination,
      seeds: result.seeds, coverage: result.coverage, elapsedMs,
      completeCasesPerSecond: result.executed / (elapsedMs / 1000),
      pipeline,
      r04KernelPass: kernel.pass,
      serialDurabilityProbePerSecond: durable.serialRecordsPerSecond,
      minimumBoundaryPermutationsPerSecond: profile.minimumBoundaryPermutationsPerSecond,
      r04RateQualified: kernel.pass,
      fullCampaignRateTarget: null,
      productionAuthorized: false,
      timingScope: 'Outer timer includes launch of independent sink, gateway and two Aether worker processes; lost response, absent gateway, signed recovery/rejoin, all 15 generated cases, duplicate delivery, raw state copy/audit and durable observations. Two pipeline phases separately retain the failed pre-restart attempt and all post-restart recoveries/executions. R04 JSON kernel, preregistration and final measurement publication are excluded from outer timer.',
      after: diagnostic() });
    console.log(`Complete ${result.executed}/${result.generated} witnessed external cases in ${elapsedMs.toFixed(3)} ms (${(result.executed / (elapsedMs / 1000)).toFixed(2)}/s).`);
  } finally { rmSync(privateDirectory, { recursive: true, force: true }); }
}
async function verify(directory: string): Promise<void> {
  const preregistration = read(join(directory, 'preregistration.json')),
    registration = read(join(directory, 'registration.json')) as ExternalRegistration,
    result = read(join(directory, 'process-result.json')) as ExternalCampaignResult,
    measured = read(join(directory, 'results.json'));
  assert.equal(preregistration.format, 'aether.living-external-preregistration/1');
  assert.equal(preregistration.profileSha256, sha(readFileSync(profilePath)));
  assert.equal(preregistration.registrationSha256, sha(readFileSync(join(directory, 'registration.json'))));
  equal(preregistration.sources, sources());
  validateRegistration(registration);
  assert.equal(measured.registrationSha256, preregistration.registrationSha256);
  assert.equal(measured.format, 'aether.living-external-measurement/3');
  assert.equal(result.generated, 15); assert.equal(result.executed, 15);
  assert.equal(result.filtered, 0); assert.equal(result.passed, 15); assert.equal(result.failed, 0);
  assert.equal(result.attempted, 17); assert.equal(result.partitionUnknown, 1);
  assert.equal(result.reconciled, 1); assert.equal(result.sinkDecisions, 9);
  assert.equal(result.candidateRestarts, 1); assert.equal(result.workerTermination, 'SIGKILL');
  assert.equal(result.partitionAttempt.passed, false);
  assert.equal(result.partitionAttempt.filtered, false);
  assert.equal(result.partitionAttempt.externalEffects.indeterminate, 1);
  equal(result.seeds, registration.generated.map(item => item.seed));
  auditExternalRaw(directory, result, registration);
  for (let index = 0; index < result.cases.length; index++) equal(read(join(directory, 'cases', `${index}.json`)), result.cases[index]);
  for (const key of ['generated', 'executed', 'filtered', 'passed', 'failed', 'attempted', 'partitionUnknown', 'reconciled', 'sinkDecisions'] as const)
    assert.equal(measured[key], result[key]);
  equal(measured.seeds, result.seeds); equal(measured.coverage, result.coverage);
  assert.equal(measured.candidateRestarts, 1); assert.equal(measured.workerTermination, 'SIGKILL');
  equal(measured.pipeline, result.pipeline);
  const kernel = read(join(directory, 'r04-kernel.json'));
  assert.equal(kernel.format, 'aether.r04-json-event-measurement/1');
  assert.equal(kernel.minimumPerSecond, 2_000_000);
  assert.equal(kernel.warmups, 1); assert.equal(kernel.inputsPerTrial, 20_000);
  assert.equal(kernel.samples.length, 5);
  for (const [index, sample] of kernel.samples.entries()) {
    assert.equal(sample.trial, index); assert.equal(sample.generated, 20_000);
    assert.equal(sample.executed, 20_000); assert.equal(sample.filtered, 0);
    assert.equal(sample.checksum, 25_534);
    assert.ok(Math.abs(sample.inputsPerSecond - 20_000 / (Number(sample.elapsedNs) / 1e9)) < 1e-6);
    assert.equal(sample.pass, sample.inputsPerSecond >= 2_000_000);
  }
  assert.equal(kernel.pass, kernel.samples.every((sample: { pass: boolean }) => sample.pass));
  assert.equal(measured.r04KernelPass, kernel.pass);
  const durable = read(join(directory, 'durability-probe.json'));
  assert.equal(durable.format, 'aether.living-durability-probe/1');
  assert.equal(durable.warmups, 10); assert.equal(durable.samples, 100);
  assert.equal(durable.bytesPerRecord, 256); assert.equal(durable.raw.length, 100);
  const orderedDurability = durable.raw.map((sample: { ordinal: number; fileFsyncNs: string;
    directoryFsyncNs: string; totalNs: string }, ordinal: number) => {
    assert.equal(sample.ordinal, ordinal);
    assert.ok(BigInt(sample.totalNs) >= BigInt(sample.fileFsyncNs) + BigInt(sample.directoryFsyncNs));
    return BigInt(sample.totalNs);
  }).sort((a: bigint, b: bigint) => a < b ? -1 : a > b ? 1 : 0);
  assert.equal(durable.minimumNs, String(orderedDurability[0]));
  assert.equal(durable.medianNs, String((orderedDurability[49] + orderedDurability[50]) / 2n));
  assert.equal(durable.maximumNs, String(orderedDurability.at(-1)));
  assert.ok(Math.abs(durable.serialRecordsPerSecond - 100 /
    (Number(orderedDurability.reduce((a: bigint, b: bigint) => a + b, 0n)) / 1e9)) < 1e-9);
  assert.equal(measured.serialDurabilityProbePerSecond, durable.serialRecordsPerSecond);
  assert.equal(measured.minimumBoundaryPermutationsPerSecond, 2_000_000);
  assert.equal(measured.productionAuthorized, false);
  assert.equal(measured.r04RateQualified, kernel.pass);
  assert.equal(measured.fullCampaignRateTarget, null);
  assert.ok(Math.abs(measured.completeCasesPerSecond - result.executed / (measured.elapsedMs / 1000)) < 1e-9);
  const freshPrivate = mkdtempSync(join(tmpdir(), 'aether-living-external-fresh-'));
  const freshPublic = mkdtempSync(join(tmpdir(), 'aether-living-external-audit-'));
  try {
    const fresh = await prepareExternal(freshPrivate, freshPublic);
    const repeated = await runExternal(fresh, freshPublic);
    auditExternalRaw(freshPublic, repeated, fresh.registration);
    for (const key of ['generated', 'executed', 'filtered', 'passed', 'failed', 'attempted',
      'partitionUnknown', 'reconciled', 'sinkDecisions'] as const) assert.equal(repeated[key], result[key]);
    for (const key of ['generated', 'executed', 'attemptedExecutions', 'failedAttempts',
      'filteredAttempts', 'recoveries'] as const)
      assert.equal(repeated.pipeline[key], result.pipeline[key]);
    assert.equal(repeated.pipeline.phases[0].complete, false);
    assert.equal(repeated.pipeline.phases[1].complete, true);
    equal(repeated.seeds, result.seeds); equal(repeated.coverage, result.coverage);
    equal(registration.generated.map(({ manifestDigest: _manifestDigest, ...item }) => item),
      fresh.registration.generated.map(({ manifestDigest: _manifestDigest, ...item }) => item));
  } finally { rmSync(freshPrivate, { recursive: true, force: true }); rmSync(freshPublic, { recursive: true, force: true }); }
  console.log('Verified 15 exact-source signed external cases, raw receipts/witnesses and fresh partition/rejoin run.');
}
const [mode, supplied] = process.argv.slice(2);
if (!['--measure', '--verify'].includes(mode) || !supplied) throw new Error('usage: campaign.ts --measure|--verify OUTPUT_DIRECTORY');
const directory = resolve(supplied);
if (mode === '--measure') await measure(directory); else await verify(directory);
