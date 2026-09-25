/** Preregistered exact-source shrink/replay of the witnessed external fault. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, loadavg, platform, release, tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeCanonical } from '../../../../src/fabric/encoding.ts';
import { domainDigest } from '../../../../src/fabric/identity.ts';
import { measureR04JsonEvents } from '../../../../src/tier3/living-campaign.ts';
import { auditExternalRaw, type ExternalCampaignResult, type ExternalFaultActionV1,
  type ExternalRegistration } from './harness.ts';
import { auditExternalFault, observeExternalFault, shrinkExternalFault,
  type ExternalFaultCounterexampleV1, type ExternalFaultObservationV1 } from './fault-shrink.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const profilePath = join(root, 'roadmap/v4/research/microworld-external/profile.json');
const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const captured = new Set<string>();
function capture(path: string): void {
  if (captured.has(path)) return; captured.add(path);
  if (!path.endsWith('.ts')) return;
  const source = readFileSync(join(root, path), 'utf8');
  for (const match of source.matchAll(/(?:from\s*|import\s*\()['"](\.{1,2}\/[^'"\n]+\.ts)['"]/g))
    capture(relative(root, resolve(root, dirname(path), match[1])));
}
for (const path of ['roadmap/v4/research/microworld-external/fault-campaign.ts',
  'roadmap/v4/research/microworld-external/worker.ts',
  'roadmap/v4/research/microworld-external/gateway.ts',
  'src/fabric/witness-service-cli.ts', 'src/fabric/attested-sink-service-cli.ts',
  'roadmap/v4/research/microworld-external/profile.json', 'package-lock.json']) capture(path);
const sourcePaths = [...captured].sort();
const sources = () => Object.fromEntries(sourcePaths.map(path => [path, sha(readFileSync(join(root, path)))]));
const diagnostic = () => ({ at: new Date().toISOString(), node: process.version,
  platform: platform(), release: release(), arch: process.arch, cpus: cpus().map(cpu => cpu.model),
  load: loadavg(), memory: process.memoryUsage() });
function write(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const fd = openSync(path, 'wx', 0o600);
  try { writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
  const parent = openSync(dirname(path), 'r'); try { fsyncSync(parent); } finally { closeSync(parent); }
}
const read = (path: string): any => JSON.parse(readFileSync(path, 'utf8'));
const equal = (left: unknown, right: unknown): void => {
  assert.ok(Buffer.from(encodeCanonical(left)).equals(Buffer.from(encodeCanonical(right))), 'fault campaign observation changed');
};
const rate = (observation: ExternalFaultObservationV1) => observation.executed / (Number(observation.elapsedNs) / 1e9);
interface Profile {
  readonly format: 'aether.living-external-research-profile/3';
  readonly minimumBoundaryPermutationsPerSecond: number;
  readonly faultShrink: { readonly format: 'aether.living-external-fault-shrink/1'; readonly seed: string;
    readonly originalActions: readonly ExternalFaultActionV1[]; readonly limit: number };
}
function profile(): Profile {
  const value = read(profilePath) as Profile;
  assert.equal(value.format, 'aether.living-external-research-profile/3');
  assert.equal(value.minimumBoundaryPermutationsPerSecond, 2_000_000);
  assert.equal(value.faultShrink.format, 'aether.living-external-fault-shrink/1');
  assert.deepEqual(value.faultShrink.originalActions, ['malformed-command', 'truncated-command', 'healthy-case']);
  assert.equal(value.faultShrink.limit, 8);
  return value;
}
async function measure(directory: string): Promise<void> {
  if (existsSync(directory)) throw new Error('fault campaign output must not exist');
  const gitHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const gitStatus = execFileSync('git', ['status', '--short'], { cwd: root, encoding: 'utf8' });
  const selected = profile();
  write(join(directory, 'preregistration.json'), { format: 'aether.living-external-fault-preregistration/1',
    at: new Date().toISOString(), gitHead, gitStatus, profileSha256: sha(readFileSync(profilePath)),
    sources: sources(), seed: selected.faultShrink.seed, originalActions: selected.faultShrink.originalActions,
    limit: selected.faultShrink.limit, declaredCasesPerObservation: 15,
    minimumBoundaryPermutationsPerSecond: 2_000_000, diagnostic: diagnostic() });
  write(join(directory, 'attempt.json'), { format: 'aether.living-external-fault-attempt/1',
    preregistrationSha256: sha(readFileSync(join(directory, 'preregistration.json'))), before: diagnostic() });
  const started = process.hrtime.bigint();
  const witness = await shrinkExternalFault(join(directory, 'fault'), selected.faultShrink.seed,
    selected.faultShrink.originalActions, selected.faultShrink.limit);
  auditExternalFault(join(directory, 'fault'), witness);
  const replayPath = join(directory, 'replay', 'observations', '100');
  const replay = await observeExternalFault(replayPath, 100, witness.shrunk.actions);
  const replayRegistration = read(join(replayPath, 'registration.json')) as ExternalRegistration,
    replayResult = read(join(replayPath, 'result.json')) as ExternalCampaignResult;
  auditExternalRaw(replayPath, replayResult, replayRegistration);
  if (replay.candidateRoot !== witness.candidateRoot || replay.property !== witness.shrunk.property
    || replay.executionManifestDigest !== witness.shrunk.executionManifestDigest
    || replay.effectPolicyBodyDigest !== witness.shrunk.effectPolicyBodyDigest
    || replay.generated !== 15 || replay.executed !== 15 || replay.filtered !== 0)
    throw new Error('fresh external fault replay diverged');
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  const kernel = measureR04JsonEvents();
  write(join(directory, 'r04-kernel.json'), kernel);
  const observations = [witness.original, ...witness.proposals, replay];
  write(join(directory, 'results.json'), { format: 'aether.living-external-fault-measurement/1',
    preregistrationSha256: sha(readFileSync(join(directory, 'preregistration.json'))),
    witnessDigest: domainDigest('aether.living-external-fault-shrink/1', witness),
    candidateRoot: witness.candidateRoot, originalActions: witness.original.actions,
    shrunkActions: witness.shrunk.actions, shrinkAttempts: witness.attempts,
    reductions: witness.reductions, limitReached: witness.limitReached,
    observations: observations.map(item => ({ ordinal: item.ordinal, actions: item.actions,
      executionManifestDigest: item.executionManifestDigest,
      effectPolicyBodyDigest: item.effectPolicyBodyDigest,
      generated: item.generated, executed: item.executed, filtered: item.filtered,
      attempted: item.attempted, failedAttempts: 1, recoveries: 2,
      candidateRestarts: 1, workerTermination: 'SIGKILL', sinkDecisions: item.sinkDecisions,
      elapsedNs: item.elapsedNs, completeCasesPerSecond: rate(item),
      resultDigest: item.resultDigest, registrationDigest: item.registrationDigest })),
    totalGenerated: observations.reduce((sum, item) => sum + item.generated, 0),
    totalExecuted: observations.reduce((sum, item) => sum + item.executed, 0),
    totalFiltered: observations.reduce((sum, item) => sum + item.filtered, 0),
    totalAttempts: observations.reduce((sum, item) => sum + item.attempted, 0),
    totalFailedAttempts: observations.length,
    totalRecoveries: observations.length * 2,
    totalSinkDecisions: observations.reduce((sum, item) => sum + item.sinkDecisions, 0),
    elapsedMs, r04RateQualified: kernel.pass, r04MinimumPerSecond: 2_000_000,
    fullCampaignRateTarget: null, productionAuthorized: false,
    timingScope: 'Each observation independently launches a signed candidate, sink, witness and gateway, executes all 15 generated cases with one external-sink response fault and a fresh candidate-process restart, retains raw evidence and reports its own full rate. The outer timer includes all shrink proposals and one fresh shrunk replay. R04 kernel is measured separately after the outer timer.',
    after: diagnostic() });
  console.log(`Shrunk ${witness.original.actions.length} to ${witness.shrunk.actions.length} optional actions in ${witness.attempts} full proposals; replayed 15/15.`);
}
async function verify(directory: string): Promise<void> {
  const selected = profile(), prereg = read(join(directory, 'preregistration.json')),
    witness = read(join(directory, 'fault', 'counterexample.json')) as ExternalFaultCounterexampleV1,
    measured = read(join(directory, 'results.json'));
  assert.equal(prereg.format, 'aether.living-external-fault-preregistration/1');
  assert.equal(prereg.profileSha256, sha(readFileSync(profilePath)));
  equal(prereg.sources, sources());
  assert.equal(prereg.seed, selected.faultShrink.seed);
  equal(prereg.originalActions, selected.faultShrink.originalActions);
  assert.equal(prereg.limit, selected.faultShrink.limit);
  assert.equal(measured.preregistrationSha256, sha(readFileSync(join(directory, 'preregistration.json'))));
  auditExternalFault(join(directory, 'fault'), witness);
  assert.equal(witness.original.actions.length, 3);
  assert.equal(witness.shrunk.actions.length, 0);
  assert.equal(witness.attempts, 3); assert.equal(witness.reductions, 3);
  const replayPath = join(directory, 'replay', 'observations', '100');
  const replay = read(join(replayPath, 'observation.json')) as ExternalFaultObservationV1,
    registration = read(join(replayPath, 'registration.json')) as ExternalRegistration,
    result = read(join(replayPath, 'result.json')) as ExternalCampaignResult;
  assert.equal(domainDigest('aether.living-external-registration/1', registration), replay.registrationDigest);
  assert.equal(domainDigest('aether.living-external-campaign/3', result), replay.resultDigest);
  equal(replay.actions, witness.shrunk.actions);
  auditExternalRaw(replayPath, result, registration);
  assert.equal(measured.witnessDigest, domainDigest('aether.living-external-fault-shrink/1', witness));
  assert.equal(measured.candidateRoot, witness.candidateRoot);
  equal(measured.originalActions, witness.original.actions); equal(measured.shrunkActions, witness.shrunk.actions);
  assert.equal(measured.shrinkAttempts, witness.attempts); assert.equal(measured.reductions, witness.reductions);
  const observations = [witness.original, ...witness.proposals, replay];
  assert.equal(measured.observations.length, observations.length);
  for (const [index, observation] of observations.entries()) {
    const summary = measured.observations[index];
    equal(summary.actions, observation.actions);
    for (const key of ['ordinal', 'executionManifestDigest', 'effectPolicyBodyDigest',
      'generated', 'executed', 'filtered', 'attempted', 'sinkDecisions',
      'elapsedNs', 'resultDigest', 'registrationDigest'] as const) assert.equal(summary[key], observation[key]);
    assert.equal(summary.failedAttempts, 1); assert.equal(summary.recoveries, 2);
    assert.equal(summary.candidateRestarts, 1); assert.equal(summary.workerTermination, 'SIGKILL');
    assert.ok(Math.abs(summary.completeCasesPerSecond - rate(observation)) < 1e-9);
  }
  assert.equal(measured.totalGenerated, observations.reduce((sum, item) => sum + item.generated, 0));
  assert.equal(measured.totalExecuted, observations.reduce((sum, item) => sum + item.executed, 0));
  assert.equal(measured.totalFiltered, 0); assert.equal(measured.r04MinimumPerSecond, 2_000_000);
  assert.equal(measured.totalAttempts, observations.reduce((sum, item) => sum + item.attempted, 0));
  assert.equal(measured.totalFailedAttempts, observations.length);
  assert.equal(measured.totalRecoveries, observations.length * 2);
  assert.equal(measured.totalSinkDecisions, observations.reduce((sum, item) => sum + item.sinkDecisions, 0));
  assert.equal(measured.productionAuthorized, false); assert.equal(measured.fullCampaignRateTarget, null);
  const kernel = read(join(directory, 'r04-kernel.json'));
  assert.equal(kernel.format, 'aether.r04-json-event-measurement/1');
  assert.equal(kernel.samples.length, 5); assert.equal(kernel.inputsPerTrial, 20_000);
  for (const sample of kernel.samples) {
    assert.equal(sample.generated, 20_000); assert.equal(sample.executed, 20_000);
    assert.equal(sample.filtered, 0); assert.equal(sample.checksum, 25_534);
    assert.ok(Math.abs(sample.inputsPerSecond - 20_000 / (Number(sample.elapsedNs) / 1e9)) < 1e-6);
    assert.equal(sample.pass, sample.inputsPerSecond >= 2_000_000);
  }
  assert.equal(kernel.pass, kernel.samples.every((sample: { pass: boolean }) => sample.pass));
  assert.equal(measured.r04RateQualified, kernel.pass);
  const freshRoot = mkdtempSync(join(tmpdir(), 'aether-external-shrunk-replay-'));
  try {
    const fresh = await observeExternalFault(join(freshRoot, 'observations', '101'), 101, witness.shrunk.actions);
    assert.equal(fresh.candidateRoot, witness.candidateRoot);
    assert.equal(fresh.executionManifestDigest, witness.shrunk.executionManifestDigest);
    assert.equal(fresh.effectPolicyBodyDigest, witness.shrunk.effectPolicyBodyDigest);
    assert.equal(fresh.property, witness.shrunk.property);
    assert.equal(fresh.generated, 15); assert.equal(fresh.executed, 15); assert.equal(fresh.filtered, 0);
  } finally { rmSync(freshRoot, { recursive: true, force: true }); }
  console.log(`Verified ${observations.length} full signed fault observations, three reductions and fresh process replay.`);
}
const [mode, supplied] = process.argv.slice(2);
if (!['--measure', '--verify'].includes(mode) || !supplied)
  throw new Error('usage: fault-campaign.ts --measure|--verify OUTPUT_DIRECTORY');
const directory = resolve(supplied);
if (mode === '--measure') await measure(directory); else await verify(directory);
