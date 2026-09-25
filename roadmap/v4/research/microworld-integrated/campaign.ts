/** Preregistered exact-source combined signed Aether process campaign. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, loadavg, platform, release, tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeCanonical } from '../../../../src/fabric/encoding.ts';
import { domainDigest } from '../../../../src/fabric/identity.ts';
import { LivingCampaign, type LivingEffectCampaignReportV2 } from '../../../../src/tier3/living-campaign.ts';
import { integratedFixture, integratedTrust, signIntegratedFixture } from './fixture.ts';
import { auditCombinedRaw, runCombinedProcess, type CombinedProcessResult } from './harness.ts';
import { runPhysicalMemoryPressure, type PhysicalMemoryPressureObservationV1 } from './memory-pressure.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const profilePath = join(root, 'roadmap/v4/research/microworld-integrated/profile.json');
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
for (const path of ['roadmap/v4/research/microworld-integrated/campaign.ts',
  'roadmap/v4/research/microworld-integrated/worker.ts',
  'roadmap/v4/research/microworld-integrated/memory-worker.ts',
  'roadmap/v4/research/microworld-integrated/profile.json', 'package-lock.json']) capture(path);
const sourcePaths = [...captured].sort();
const sources = () => Object.fromEntries(sourcePaths.map(path => [path, sha(readFileSync(join(root, path)))]));
const diagnostic = () => ({ at: new Date().toISOString(), node: process.version, platform: platform(), release: release(), arch: process.arch,
  cpus: cpus().map(cpu => cpu.model), load: loadavg(), memory: process.memoryUsage() });
function write(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const fd = openSync(path, 'wx', 0o600);
  try { writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
  const parent = openSync(dirname(path), 'r'); try { fsyncSync(parent); } finally { closeSync(parent); }
}
const read = (path: string): any => JSON.parse(readFileSync(path, 'utf8'));
const equal = (actual: unknown, expected: unknown): void => {
  assert.ok(Buffer.from(encodeCanonical(actual)).equals(Buffer.from(encodeCanonical(expected))), 'registered campaign divergence');
};
function temporary<T>(run: (directory: string) => T): T {
  const directory = mkdtempSync(join(tmpdir(), 'aether-living-integrated-'));
  try { return run(directory); } finally { rmSync(directory, { recursive: true, force: true }); }
}
interface Registration {
  readonly format: 'aether.living-integrated-registration/1'; readonly gitHead: string; readonly gitStatus: string;
  readonly at: string; readonly profileSha256: string; readonly sources: Record<string, string>;
  readonly profile: { readonly seed: string; readonly declaredGoodCases: number;
    readonly declaredBrokenCases: number; readonly r04BoundaryMinimumPerSecond: number;
    readonly campaignRateQualification: string;
    readonly physicalMemoryPressure: { readonly residentBytes: number;
      readonly touchStrideBytes: number; readonly minimumOsRssDeltaBytes: number;
      readonly caseScenario: string } };
  readonly publicKeyPem: string;
  readonly authorization: NonNullable<ConstructorParameters<typeof LivingCampaign>[0]['effectAuthorization']>;
  readonly brokenAuthorization: NonNullable<ConstructorParameters<typeof LivingCampaign>[0]['effectAuthorization']>;
  readonly memoryAuthorization: NonNullable<ConstructorParameters<typeof LivingCampaign>[0]['effectAuthorization']>;
  readonly generated: ReturnType<LivingCampaign['generate']>;
  readonly brokenGenerated: ReturnType<LivingCampaign['generate']>;
  readonly memoryGenerated: ReturnType<LivingCampaign['generate']>;
  readonly diagnostic: ReturnType<typeof diagnostic>;
}
function executor(registration: Registration, directory: string, broken: boolean): LivingCampaign {
  const fixture = integratedFixture(broken);
  return new LivingCampaign({ manifest: fixture.manifest, module: fixture.module, registry: fixture.registry, directory,
    effectAuthorization: broken ? registration.brokenAuthorization : registration.authorization,
    effectTrust: integratedTrust(registration.publicKeyPem) });
}
function check(directory: string): Registration {
  const registration = read(join(directory, 'registration.json')) as Registration;
  assert.equal(registration.format, 'aether.living-integrated-registration/1');
  assert.equal(registration.profileSha256, sha(readFileSync(profilePath)));
  equal(registration.sources, sources());
  temporary(path => {
    equal(executor(registration, join(path, 'good'), false).generate(), registration.generated);
    equal(executor(registration, join(path, 'broken'), true).generate(), registration.brokenGenerated);
    const fixture = integratedFixture();
    equal(new LivingCampaign({ manifest: fixture.manifest, module: fixture.module,
      registry: fixture.registry, directory: join(path, 'memory'),
      effectAuthorization: registration.memoryAuthorization,
      effectTrust: integratedTrust(registration.publicKeyPem) }).generate(),
    registration.memoryGenerated);
  });
  return registration;
}
function stableProcess(value: CombinedProcessResult) {
  const { workerPids: _workerPids, ...rest } = value; return rest;
}
function stableReport(value: LivingEffectCampaignReportV2) {
  const { elapsedMs: _elapsedMs, executedCasesPerSecond: _executedCasesPerSecond,
    evaluatedOperationsPerSecond: _evaluatedOperationsPerSecond, ...rest } = value; return rest;
}
async function run(directory: string, registration: Registration): Promise<void> {
  write(join(directory, 'attempt.json'), { format: 'aether.living-integrated-attempt/1',
    registrationSha256: sha(readFileSync(join(directory, 'registration.json'))), before: diagnostic() });
  const goodStart = process.hrtime.bigint();
  const good = await runCombinedProcess(join(directory, 'registration.json'), join(directory, 'raw', 'good'), registration.generated);
  auditCombinedRaw(join(directory, 'raw', 'good'), good);
  for (let index = 0; index < good.cases.length; index++)
    write(join(directory, 'cases', `good-${index}.json`), good.cases[index]);
  write(join(directory, 'good-process.json'), good);
  const goodElapsedMs = Number(process.hrtime.bigint() - goodStart) / 1e6;
  const brokenStart = process.hrtime.bigint();
  const brokenExecutor = executor(registration, join(directory, 'raw', 'broken'), true);
  const broken = brokenExecutor.runEffectful();
  if (broken.accepted || !broken.counterexamples.length) throw new Error('seeded broken candidate did not retain failures');
  for (const witness of broken.counterexamples) brokenExecutor.replayCounterexample(witness);
  write(join(directory, 'broken-report.json'), broken);
  const brokenElapsedMs = Number(process.hrtime.bigint() - brokenStart) / 1e6;
  const memory = await runPhysicalMemoryPressure(join(directory, 'registration.json'),
    join(directory, 'raw', 'memory'), registration.profile.physicalMemoryPressure);
  write(join(directory, 'memory-pressure.json'), memory);
  write(join(directory, 'results.json'), { format: 'aether.living-integrated-measurement/2',
    registrationSha256: sha(readFileSync(join(directory, 'registration.json'))),
    good: { generated: good.generated, executed: good.executed, filtered: good.filtered, passed: good.passed,
      failed: good.failed, attemptedCaseExecutions: good.attemptedCaseExecutions,
      malformedTcpFrames: good.malformedTcpFrames, truncatedTcpFrames: good.truncatedTcpFrames,
      recovered: good.recovered, unknown: good.unknown, seeds: good.seeds, coverage: good.coverage,
      elapsedMs: goodElapsedMs, completeCasesPerSecond: good.executed / (goodElapsedMs / 1000) },
    broken: { generated: broken.generated, executed: broken.executed, filtered: broken.filtered,
      passed: broken.passed, failed: broken.failed, counterexamples: broken.counterexamples.length,
      elapsedMs: brokenElapsedMs, completeCasesPerSecond: broken.executed / (brokenElapsedMs / 1000) },
    r04BoundaryMinimumPerSecond: registration.profile.r04BoundaryMinimumPerSecond,
    campaignRateQualification: registration.profile.campaignRateQualification,
    physicalMemoryPressure: { observationDigest: domainDigest('aether.living-physical-memory-pressure/1', memory),
      caseDigest: memory.caseDigest, requestedBytes: memory.requestedBytes,
      osRssDeltaBytes: memory.osRssPressuredBytes - memory.osRssBaselineBytes,
      casePassed: memory.result.passed, caseFiltered: memory.result.filtered },
    productionAuthorized: false,
    timingScope: 'Good timer includes worker launch, TCP faults, all 15 original cases, one SIGKILL, recovery, duplicate delivery, raw audit and observation publication. Broken timer includes all 15 original signed cases, durable shrink/replay and report publication. Registration and final measurement write are excluded.',
    after: diagnostic() });
  console.log(`Good ${good.executed}/${good.generated} at ${(good.executed / (goodElapsedMs / 1000)).toFixed(2)}/s; broken ${broken.executed}/${broken.generated} at ${(broken.executed / (brokenElapsedMs / 1000)).toFixed(2)}/s.`);
}
async function verify(directory: string, registration: Registration): Promise<void> {
  const results = read(join(directory, 'results.json')),
    good = read(join(directory, 'good-process.json')) as CombinedProcessResult,
    broken = read(join(directory, 'broken-report.json')) as LivingEffectCampaignReportV2,
    memory = read(join(directory, 'memory-pressure.json')) as PhysicalMemoryPressureObservationV1;
  assert.ok(existsSync(join(directory, 'attempt.json')));
  assert.equal(results.registrationSha256, sha(readFileSync(join(directory, 'registration.json'))));
  assert.equal(results.format, 'aether.living-integrated-measurement/2');
  assert.equal(results.r04BoundaryMinimumPerSecond, 2_000_000);
  assert.equal(results.campaignRateQualification, registration.profile.campaignRateQualification);
  assert.equal(results.productionAuthorized, false);
  assert.equal(good.generated, 15); assert.equal(good.executed, 15);
  assert.equal(good.filtered, 0); assert.equal(good.passed, 15); assert.equal(good.failed, 0);
  assert.equal(good.attemptedCaseExecutions, 17); assert.equal(good.recovered, 1); assert.equal(good.unknown, 0);
  assert.equal(good.malformedTcpFrames, 1); assert.equal(good.truncatedTcpFrames, 1);
  assert.equal(new Set(good.workerPids).size, 2);
  equal(good.seeds, registration.generated.map(item => item.seed));
  auditCombinedRaw(join(directory, 'raw', 'good'), good);
  for (let index = 0; index < good.cases.length; index++) equal(read(join(directory, 'cases', `good-${index}.json`)), good.cases[index]);
  assert.equal(results.good.generated, good.generated); assert.equal(results.good.executed, good.executed);
  assert.equal(results.good.filtered, good.filtered); assert.equal(results.good.passed, good.passed);
  equal(results.good.seeds, good.seeds); equal(results.good.coverage, good.coverage);
  assert.ok(Math.abs(results.good.completeCasesPerSecond - good.executed / (results.good.elapsedMs / 1000)) < 1e-9);
  assert.ok(!Object.hasOwn(results.good, 'throughputQualified'));
  assert.equal(broken.generated, 15); assert.equal(broken.executed, 15); assert.equal(broken.filtered, 0);
  assert.equal(broken.accepted, false); assert.ok(broken.counterexamples.length > 0);
  assert.equal(results.broken.counterexamples, broken.counterexamples.length);
  assert.ok(Math.abs(results.broken.completeCasesPerSecond - broken.executed / (results.broken.elapsedMs / 1000)) < 1e-9);
  assert.ok(!Object.hasOwn(results.broken, 'throughputQualified'));
  const pressureProfile = registration.profile.physicalMemoryPressure;
  assert.equal(memory.format, 'aether.living-physical-memory-pressure/1');
  assert.equal(memory.requestedBytes, pressureProfile.residentBytes);
  assert.equal(memory.touchStrideBytes, pressureProfile.touchStrideBytes);
  assert.equal(memory.minimumOsRssDeltaBytes, pressureProfile.minimumOsRssDeltaBytes);
  const pressureCase = registration.memoryGenerated.find(item => item.scenario === pressureProfile.caseScenario
    && item.ordinal === 0);
  assert.ok(pressureCase);
  assert.equal(memory.caseDigest, domainDigest('aether.living-case/1', pressureCase));
  assert.ok(memory.osRssPressuredBytes - memory.osRssBaselineBytes
    >= pressureProfile.minimumOsRssDeltaBytes);
  assert.ok(memory.osRssAfterCaseBytes - memory.osRssBaselineBytes
    >= pressureProfile.minimumOsRssDeltaBytes);
  assert.ok(memory.workerRssPressuredBytes - memory.workerRssBaselineBytes
    >= pressureProfile.minimumOsRssDeltaBytes);
  assert.ok(memory.workerRssAfterCaseBytes - memory.workerRssBaselineBytes
    >= pressureProfile.minimumOsRssDeltaBytes);
  assert.ok(Number.isSafeInteger(memory.workerPid) && memory.workerPid > 0);
  assert.equal(memory.touchedPages, Math.ceil(pressureProfile.residentBytes / pressureProfile.touchStrideBytes));
  let expectedChecksum = 0;
  for (let index = 0; index < memory.touchedPages; index++)
    expectedChecksum = (expectedChecksum + ((index * 17 + 3) & 255)) >>> 0;
  assert.equal(memory.checksum, expectedChecksum, 'physical pressure checksum changed');
  assert.equal(memory.result.caseDigest, memory.caseDigest);
  assert.equal(memory.result.passed, true); assert.equal(memory.result.filtered, false);
  assert.ok(memory.result.coverage.includes('resource:exhausted'));
  equal(results.physicalMemoryPressure, { observationDigest: domainDigest('aether.living-physical-memory-pressure/1', memory),
    caseDigest: memory.caseDigest, requestedBytes: memory.requestedBytes,
    osRssDeltaBytes: memory.osRssPressuredBytes - memory.osRssBaselineBytes,
    casePassed: true, caseFiltered: false });
  const reopened = executor(registration, join(directory, 'raw', 'broken'), true);
  for (const witness of broken.counterexamples) reopened.replayCounterexample(witness);
  const replayDirectory = mkdtempSync(join(tmpdir(), 'aether-integrated-replay-'));
  try {
    const repeat = await runCombinedProcess(join(directory, 'registration.json'), join(replayDirectory, 'good'), registration.generated);
    equal(stableProcess(repeat), stableProcess(good));
    const brokenRepeat = executor(registration, join(replayDirectory, 'broken'), true).runEffectful();
    equal(stableReport(brokenRepeat), stableReport(broken));
    const memoryRepeat = await runPhysicalMemoryPressure(join(directory, 'registration.json'),
      join(replayDirectory, 'memory'), pressureProfile);
    assert.equal(memoryRepeat.caseDigest, memory.caseDigest);
    equal(memoryRepeat.result, memory.result);
  } finally { rmSync(replayDirectory, { recursive: true, force: true }); }
  console.log('Verified all 15 signed process cases, 15 broken cases, durable shrunk replays and one OS-RSS-pressure case under exact source.');
}
const [mode, supplied] = process.argv.slice(2);
if (!['--register', '--run', '--verify'].includes(mode) || !supplied)
  throw new Error('usage: campaign.ts --register|--run|--verify OUTPUT_DIRECTORY');
const directory = resolve(supplied);
if (mode === '--register') {
  if (existsSync(directory)) throw new Error('registration requires a new directory');
  const profile = read(profilePath);
  assert.equal(profile.format, 'aether.living-integrated-profile/2');
  assert.equal(profile.r04BoundaryMinimumPerSecond, 2_000_000);
  assert.equal(profile.campaignRateQualification, 'reported-only; signed Aether candidate execution, fault handling, transport and durability are separate from the frozen R04 generator/evaluator rate');
  assert.deepEqual(profile.physicalMemoryPressure, { residentBytes: 67_108_864,
    touchStrideBytes: 4096, minimumOsRssDeltaBytes: 50_331_648,
    caseScenario: 'bounded-allocation' });
  const keys = generateKeyPairSync('ed25519'), good = integratedFixture(), broken = integratedFixture(true);
  const authorization = signIntegratedFixture(good, keys.privateKey, 'sigkill-once-after-dispatch');
  const brokenAuthorization = signIntegratedFixture(broken, keys.privateKey);
  const memoryAuthorization = signIntegratedFixture(good, keys.privateKey);
  const publicKeyPem = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const generated = temporary(path => new LivingCampaign({ manifest: good.manifest, module: good.module,
    registry: good.registry, directory: join(path, 'good'), effectAuthorization: authorization,
    effectTrust: integratedTrust(publicKeyPem) }).generate());
  const brokenGenerated = temporary(path => new LivingCampaign({ manifest: broken.manifest, module: broken.module,
    registry: broken.registry, directory: join(path, 'broken'), effectAuthorization: brokenAuthorization,
    effectTrust: integratedTrust(publicKeyPem) }).generate());
  const memoryGenerated = temporary(path => new LivingCampaign({ manifest: good.manifest,
    module: good.module, registry: good.registry, directory: join(path, 'memory'),
    effectAuthorization: memoryAuthorization,
    effectTrust: integratedTrust(publicKeyPem) }).generate());
  mkdirSync(directory, { recursive: true });
  write(join(directory, 'registration.json'), { format: 'aether.living-integrated-registration/1',
    at: new Date().toISOString(), gitHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    gitStatus: execFileSync('git', ['status', '--short'], { cwd: root, encoding: 'utf8' }),
    profileSha256: sha(readFileSync(profilePath)), sources: sources(),
    profile: { seed: profile.seed, declaredGoodCases: profile.declaredGoodCases,
      declaredBrokenCases: profile.declaredBrokenCases,
      r04BoundaryMinimumPerSecond: profile.r04BoundaryMinimumPerSecond,
      campaignRateQualification: profile.campaignRateQualification,
      physicalMemoryPressure: profile.physicalMemoryPressure },
    publicKeyPem, authorization, brokenAuthorization, memoryAuthorization,
    generated, brokenGenerated, memoryGenerated, diagnostic: diagnostic() });
  console.log(`Registered ${generated.length} good and ${brokenGenerated.length} broken signed cases.`);
} else {
  const registration = check(directory);
  if (mode === '--run') { if (existsSync(join(directory, 'attempt.json'))) throw new Error('attempt already exists'); await run(directory, registration); }
  else await verify(directory, registration);
}
