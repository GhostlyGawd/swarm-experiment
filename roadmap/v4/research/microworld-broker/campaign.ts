/** Preregistered, exact-source, local effectful micro-world research campaign. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, loadavg, platform, release, tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeCanonical } from '../../../../src/fabric/encoding.ts';
import { domainDigest } from '../../../../src/fabric/identity.ts';
import { generateCases, resultDigest, runCase, shrinkFailure, type BrokerCase, type BrokerCaseResult, type BrokerCounterexample, type Candidate } from './harness.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const profilePath = join(root, 'roadmap/v4/research/microworld-broker/profile.json');
const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const captured = new Set<string>();
function capture(path: string): void {
  if (captured.has(path)) return;
  captured.add(path);
  if (!path.endsWith('.ts')) return;
  const source = readFileSync(join(root, path), 'utf8');
  for (const match of source.matchAll(/(?:from\s*|import\s*\()['"](\.{1,2}\/[^'"\n]+\.ts)['"]/g)) {
    capture(relative(root, resolve(root, dirname(path), match[1])));
  }
}
for (const path of ['roadmap/v4/research/microworld-broker/campaign.ts', 'roadmap/v4/research/microworld-broker/profile.json', 'package-lock.json']) capture(path);
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
function read(path: string): any { return JSON.parse(readFileSync(path, 'utf8')); }
function canonicalEqual(actual: unknown, expected: unknown): void {
  assert.ok(Buffer.from(encodeCanonical(actual)).equals(Buffer.from(encodeCanonical(expected))), 'canonical research result changed');
}
function temporary<T>(run: (path: string) => T): T {
  const directory = mkdtempSync(join(tmpdir(), 'aether-living-broker-'));
  try { return run(directory); } finally { rmSync(directory, { recursive: true, force: true }); }
}
function required(result: BrokerCaseResult): void {
  assert.equal(result.sourcePassed, true);
  assert.equal(result.withheldDeliveries, 1);
  assert.equal(result.liveDispatches, 2);
  for (const item of ['aether:effect-call', 'network:sent', 'network:partition', 'network:withheld', 'network:dropped', 'network:duplicated',
    'network:healed', 'fault:receipt-write', 'sink:durable-write', 'broker:reopened', 'broker:reconciled', 'broker:isolated-replay']) {
    assert.ok(result.coverage.includes(item), `missing coverage: ${item}`);
  }
  assert.equal(result.replayConsumed, result.journalEvents);
}
interface Registration {
  readonly format: 'aether.living-broker-registration/1'; readonly at: string; readonly gitHead: string;
  readonly gitStatus: string; readonly profile: { seed: string; casesPerCandidate: number; shrinkLimit: number };
  readonly profileSha256: string; readonly sources: Record<string, string>; readonly cases: readonly BrokerCase[];
  readonly diagnostic: ReturnType<typeof diagnostic>;
}
function checkRegistration(directory: string): Registration {
  const registration = read(join(directory, 'registration.json')) as Registration;
  assert.equal(registration.format, 'aether.living-broker-registration/1');
  assert.equal(registration.profileSha256, sha(readFileSync(profilePath)));
  canonicalEqual(registration.sources, sources());
  temporary(temp => canonicalEqual(generateCases(registration.profile.seed, registration.profile.casesPerCandidate, temp), registration.cases));
  return registration;
}
function resultName(candidate: Candidate, ordinal: number): string { return `${candidate}-${ordinal}.json`; }
function auditRaw(path: string, result: BrokerCaseResult): void {
  const journal = read(join(path, 'broker', 'effects.json'));
  assert.equal(journal.format, 'aether.effect-journal/1');
  assert.equal(journal.records.length, result.journalEvents);
  assert.equal(domainDigest('aether.living-broker-journal/1', journal.records), result.journalDigest);
  const sinkPath = join(path, 'sink');
  const names = readdirSync(sinkPath).filter(name => name.endsWith('.json')).sort();
  assert.equal(names.length, result.sinkWrites);
  assert.equal(domainDigest('aether.living-broker-sink/1', names.map(name => ({ name, content: readFileSync(join(sinkPath, name), 'utf8') }))), result.sinkDigest);
}
function run(directory: string, registration: Registration): void {
  write(join(directory, 'attempt.json'), { format: 'aether.living-broker-attempt/1', registrationSha256: sha(readFileSync(join(directory, 'registration.json'))), before: diagnostic() });
  const started = process.hrtime.bigint();
  const rows: { candidate: Candidate; ordinal: number; resultDigest: string; elapsedMs: number; passed: boolean; failure: string | null }[] = [];
  let counterexample: BrokerCounterexample | null = null;
  for (const candidate of ['stable-effect-id', 'attempt-derived-effect-id'] as const) {
    for (const input of registration.cases) {
      const caseStarted = process.hrtime.bigint();
      const result = runCase(input, candidate, join(directory, 'raw', candidate, String(input.ordinal)));
      const elapsedMs = Number(process.hrtime.bigint() - caseStarted) / 1e6;
      required(result);
      assert.equal(result.failure, candidate === 'stable-effect-id' ? null : 'duplicate-effect');
      write(join(directory, 'cases', resultName(candidate, input.ordinal)), { format: 'aether.living-broker-observation/1', input, result, elapsedMs });
      rows.push({ candidate, ordinal: input.ordinal, resultDigest: resultDigest(result), elapsedMs, passed: result.passed, failure: result.failure });
      if (candidate === 'attempt-derived-effect-id' && counterexample === null) {
        counterexample = shrinkFailure(input, candidate, 'duplicate-effect', join(directory, 'shrink-raw'), registration.profile.shrinkLimit);
        assert.ok(counterexample.reductions > 0 && counterexample.shrunk.actions.length < counterexample.original.actions.length);
        write(join(directory, 'counterexample.json'), counterexample);
      }
    }
  }
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  write(join(directory, 'results.json'), { format: 'aether.living-broker-campaign-result/1', registrationSha256: sha(readFileSync(join(directory, 'registration.json'))),
    declaredPerCandidate: registration.cases.length, generated: registration.cases.length * 2, executed: rows.length,
    goodPassed: rows.filter(row => row.candidate === 'stable-effect-id' && row.passed).length,
    brokenFailed: rows.filter(row => row.candidate === 'attempt-derived-effect-id' && row.failure === 'duplicate-effect').length,
    excluded: 0, rows, counterexampleDigest: domainDigest('aether.living-broker-counterexample/1', counterexample),
    elapsedMs, originalCasesPerSecond: rows.length / (elapsedMs / 1000),
    timingScope: 'Generated inputs were preregistered. Timer includes all original case executions, durable raw observation publication, and one broken-case shrink campaign; excludes registration and final results publication.',
    distributedThroughputQualified: false, productionAuthorized: false, after: diagnostic() });
  console.log(`Complete: ${rows.length} original cases in ${elapsedMs.toFixed(3)} ms (${(rows.length / (elapsedMs / 1000)).toFixed(2)} original cases/s including shrink).`);
}
function verify(directory: string, registration: Registration): void {
  assert.ok(existsSync(join(directory, 'attempt.json')));
  const results = read(join(directory, 'results.json'));
  assert.equal(results.registrationSha256, sha(readFileSync(join(directory, 'registration.json'))));
  assert.equal(results.declaredPerCandidate, registration.cases.length);
  assert.equal(results.generated, registration.cases.length * 2);
  assert.equal(results.executed, results.generated);
  assert.equal(results.excluded, 0);
  assert.equal(results.goodPassed, registration.cases.length);
  assert.equal(results.brokenFailed, registration.cases.length);
  assert.equal(results.productionAuthorized, false);
  assert.equal(results.distributedThroughputQualified, false);
  assert.equal(results.rows.length, results.executed);
  assert.ok(Math.abs(results.originalCasesPerSecond - results.executed / (results.elapsedMs / 1000)) < 1e-9);
  for (const candidate of ['stable-effect-id', 'attempt-derived-effect-id'] as const) for (const input of registration.cases) {
    const observation = read(join(directory, 'cases', resultName(candidate, input.ordinal)));
    canonicalEqual(observation.input, input);
    const row = results.rows.find((item: { candidate: string; ordinal: number }) => item.candidate === candidate && item.ordinal === input.ordinal);
    assert.ok(row);
    assert.equal(row.resultDigest, resultDigest(observation.result));
    assert.equal(row.elapsedMs, observation.elapsedMs);
    assert.equal(row.passed, observation.result.passed);
    assert.equal(row.failure, observation.result.failure);
    required(observation.result);
    auditRaw(join(directory, 'raw', candidate, String(input.ordinal)), observation.result);
    temporary(temp => canonicalEqual(runCase(input, candidate, temp), observation.result));
  }
  const witness = read(join(directory, 'counterexample.json')) as BrokerCounterexample;
  assert.equal(results.counterexampleDigest, domainDigest('aether.living-broker-counterexample/1', witness));
  assert.equal(witness.originalResult.failure, 'duplicate-effect');
  assert.equal(witness.shrunkResult.failure, 'duplicate-effect');
  assert.ok(witness.reductions > 0 && witness.shrunk.actions.length < witness.original.actions.length);
  auditRaw(join(directory, 'shrink-raw', 'original'), witness.originalResult);
  temporary(temp => canonicalEqual(runCase(witness.original, witness.candidate, temp), witness.originalResult));
  temporary(temp => canonicalEqual(runCase(witness.shrunk, witness.candidate, temp), witness.shrunkResult));
  console.log(`Verified ${results.executed} exact original cases and shrunk counterexample with source pins.`);
}
const [mode, supplied] = process.argv.slice(2);
if (!['--register', '--run', '--verify'].includes(mode) || !supplied) throw new Error('usage: campaign.ts --register|--run|--verify OUTPUT_DIRECTORY');
const directory = resolve(supplied);
if (mode === '--register') {
  if (existsSync(directory)) throw new Error('registration requires a new directory');
  const profile = read(profilePath);
  assert.equal(profile.format, 'aether.living-broker-research-profile/1');
  const cases = temporary(temp => generateCases(profile.seed, profile.casesPerCandidate, temp));
  mkdirSync(directory, { recursive: true });
  write(join(directory, 'registration.json'), { format: 'aether.living-broker-registration/1', at: new Date().toISOString(),
    gitHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    gitStatus: execFileSync('git', ['status', '--short'], { cwd: root, encoding: 'utf8' }),
    profile: { seed: profile.seed, casesPerCandidate: profile.casesPerCandidate, shrinkLimit: profile.shrinkLimit },
    profileSha256: sha(readFileSync(profilePath)), sources: sources(), cases, diagnostic: diagnostic() });
  console.log(`Registered ${cases.length} cases per candidate at ${directory}.`);
} else {
  const registration = checkRegistration(directory);
  if (mode === '--run') {
    if (existsSync(join(directory, 'attempt.json'))) throw new Error('attempt already exists');
    run(directory, registration);
  } else verify(directory, registration);
}
