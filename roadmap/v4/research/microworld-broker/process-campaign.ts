/** Preregistered exact-source process/socket living campaign. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, loadavg, platform, release, tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeCanonical } from '../../../../src/fabric/encoding.ts';
import { domainDigest } from '../../../../src/fabric/identity.ts';
import { generateCases, type BrokerCase, type Candidate } from './harness.ts';
import { runProcessCase, type ProcessCaseResult } from './process-harness.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const profilePath = join(root, 'roadmap/v4/research/microworld-broker/process-profile.json');
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
for (const path of ['roadmap/v4/research/microworld-broker/process-campaign.ts',
  'roadmap/v4/research/microworld-broker/process-worker.ts',
  'roadmap/v4/research/microworld-broker/process-profile.json', 'package-lock.json']) capture(path);
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
function equal(actual: unknown, expected: unknown): void {
  assert.ok(Buffer.from(encodeCanonical(actual)).equals(Buffer.from(encodeCanonical(expected))), 'canonical campaign result changed');
}
function temporary<T>(run: (path: string) => T): T {
  const directory = mkdtempSync(join(tmpdir(), 'aether-process-campaign-'));
  try { return run(directory); } finally { rmSync(directory, { recursive: true, force: true }); }
}
const portable = (result: ProcessCaseResult) => ({ ...result, workerPids: result.workerPids.length });
function required(result: ProcessCaseResult): void {
  assert.equal(result.sourcePassed, true);
  assert.equal(result.filtered, false);
  assert.equal(new Set(result.workerPids).size, 2);
  for (const item of ['tcp:truncated-frame', 'tcp:malformed-frame', 'process:sigkill-after-sink',
    'broker:reconciled-after-process-restart', 'tcp:duplicate-delivery', 'broker:isolated-replay']) {
    assert.ok(result.coverage.includes(item), `missing coverage: ${item}`);
  }
  assert.equal(result.replayConsumed, result.journalEvents);
}
interface Registration {
  readonly format: 'aether.living-process-broker-registration/1'; readonly at: string; readonly gitHead: string;
  readonly gitStatus: string; readonly profile: { readonly seed: string; readonly casesPerCandidate: number; readonly minimumBoundaryPermutationsPerSecond: number };
  readonly profileSha256: string; readonly sources: Record<string, string>; readonly cases: readonly BrokerCase[];
  readonly diagnostic: ReturnType<typeof diagnostic>;
}
function check(directory: string): Registration {
  const registration = read(join(directory, 'registration.json')) as Registration;
  assert.equal(registration.format, 'aether.living-process-broker-registration/1');
  assert.equal(registration.profileSha256, sha(readFileSync(profilePath)));
  equal(registration.sources, sources());
  temporary(path => equal(generateCases(registration.profile.seed, registration.profile.casesPerCandidate, path), registration.cases));
  return registration;
}
const rowName = (candidate: Candidate, ordinal: number) => `${candidate}-${ordinal}.json`;
function auditRaw(directory: string, result: ProcessCaseResult): void {
  const journal = read(join(directory, 'broker', 'effects.json'));
  assert.equal(journal.records.length, result.journalEvents);
  assert.equal(domainDigest('aether.living-process-broker-journal/1', journal.records), result.journalDigest);
  const sink = join(directory, 'sink'), names = readdirSync(sink).filter(name => name.endsWith('.json')).sort();
  assert.equal(names.length, result.sinkWrites);
  assert.equal(domainDigest('aether.living-process-broker-sink/1', names.map(name => ({ name, content: readFileSync(join(sink, name), 'utf8') }))), result.sinkDigest);
}
async function run(directory: string, registration: Registration): Promise<void> {
  write(join(directory, 'attempt.json'), { format: 'aether.living-process-broker-attempt/1', registrationSha256: sha(readFileSync(join(directory, 'registration.json'))), before: diagnostic() });
  const start = process.hrtime.bigint();
  const rows: { candidate: Candidate; ordinal: number; portableDigest: string; passed: boolean; failure: string | null; elapsedMs: number }[] = [];
  for (const candidate of ['stable-effect-id', 'attempt-derived-effect-id'] as const) for (const input of registration.cases) {
    const caseStart = process.hrtime.bigint();
    const raw = join(directory, 'raw', candidate, String(input.ordinal));
    const result = await runProcessCase(input, candidate, raw);
    const elapsedMs = Number(process.hrtime.bigint() - caseStart) / 1e6;
    required(result); auditRaw(raw, result);
    assert.equal(result.failure, candidate === 'stable-effect-id' ? null : 'duplicate-effect');
    write(join(directory, 'cases', rowName(candidate, input.ordinal)), { input, result, elapsedMs });
    rows.push({ candidate, ordinal: input.ordinal, portableDigest: domainDigest('aether.living-process-broker-result/1', portable(result)),
      passed: result.passed, failure: result.failure, elapsedMs });
  }
  const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
  const generated = registration.cases.length * 2, executed = rows.length, filtered = 0;
  write(join(directory, 'results.json'), { format: 'aether.living-process-broker-campaign/1',
    registrationSha256: sha(readFileSync(join(directory, 'registration.json'))), declared: generated, generated, executed, filtered,
    goodPassed: rows.filter(row => row.candidate === 'stable-effect-id' && row.passed).length,
    brokenFailed: rows.filter(row => row.candidate === 'attempt-derived-effect-id' && row.failure === 'duplicate-effect').length,
    seeds: registration.cases.map(input => input.seed), coverage: [...new Set(rows.flatMap(row => read(join(directory, 'cases', rowName(row.candidate, row.ordinal))).result.coverage))].sort(),
    rows, elapsedMs, completeCasesPerSecond: executed / (elapsedMs / 1000),
    minimumBoundaryPermutationsPerSecond: registration.profile.minimumBoundaryPermutationsPerSecond,
    throughputQualified: executed / (elapsedMs / 1000) >= registration.profile.minimumBoundaryPermutationsPerSecond,
    productionAuthorized: false, after: diagnostic(),
    timingScope: 'Timer includes every original process/socket case, process launches, real SIGKILL, recovery, replay, and durable raw observations; excludes preregistration and final result publication.' });
  console.log(`Complete ${executed} process/socket cases in ${elapsedMs.toFixed(3)} ms (${(executed / (elapsedMs / 1000)).toFixed(2)}/s).`);
}
async function verify(directory: string, registration: Registration): Promise<void> {
  assert.ok(existsSync(join(directory, 'attempt.json')));
  const results = read(join(directory, 'results.json'));
  assert.equal(results.registrationSha256, sha(readFileSync(join(directory, 'registration.json'))));
  assert.equal(results.declared, registration.cases.length * 2);
  assert.equal(results.generated, results.declared);
  assert.equal(results.executed, results.generated);
  assert.equal(results.filtered, 0);
  assert.equal(results.goodPassed, registration.cases.length);
  assert.equal(results.brokenFailed, registration.cases.length);
  assert.equal(results.productionAuthorized, false);
  assert.equal(results.rows.length, results.executed);
  assert.ok(Math.abs(results.completeCasesPerSecond - results.executed / (results.elapsedMs / 1000)) < 1e-9);
  assert.equal(results.throughputQualified, results.completeCasesPerSecond >= registration.profile.minimumBoundaryPermutationsPerSecond);
  const coverage = new Set<string>();
  for (const candidate of ['stable-effect-id', 'attempt-derived-effect-id'] as const) for (const input of registration.cases) {
    const raw = join(directory, 'raw', candidate, String(input.ordinal));
    const observation = read(join(directory, 'cases', rowName(candidate, input.ordinal)));
    equal(observation.input, input);
    required(observation.result); auditRaw(raw, observation.result);
    const row = results.rows.find((item: { candidate: string; ordinal: number }) => item.candidate === candidate && item.ordinal === input.ordinal);
    assert.ok(row);
    assert.deepEqual(row, { candidate, ordinal: input.ordinal, portableDigest: domainDigest('aether.living-process-broker-result/1', portable(observation.result)),
      passed: observation.result.passed, failure: observation.result.failure, elapsedMs: observation.elapsedMs });
    for (const item of observation.result.coverage) coverage.add(item);
    const replayDirectory = mkdtempSync(join(tmpdir(), 'aether-process-replay-'));
    try { equal(portable(await runProcessCase(input, candidate, replayDirectory)), portable(observation.result)); }
    finally { rmSync(replayDirectory, { recursive: true, force: true }); }
  }
  equal([...coverage].sort(), results.coverage);
  equal(registration.cases.map(input => input.seed), results.seeds);
  console.log(`Verified ${results.executed} exact process/socket cases, raw broker/sink records, and replay.`);
}
const [mode, supplied] = process.argv.slice(2);
if (!['--register', '--run', '--verify'].includes(mode) || !supplied) throw new Error('usage: process-campaign.ts --register|--run|--verify OUTPUT_DIRECTORY');
const directory = resolve(supplied);
if (mode === '--register') {
  if (existsSync(directory)) throw new Error('registration requires a new directory');
  const profile = read(profilePath);
  assert.equal(profile.format, 'aether.living-process-broker-profile/1');
  assert.equal(profile.minimumBoundaryPermutationsPerSecond, 2_000_000);
  const cases = temporary(path => generateCases(profile.seed, profile.casesPerCandidate, path));
  mkdirSync(directory, { recursive: true });
  write(join(directory, 'registration.json'), { format: 'aether.living-process-broker-registration/1', at: new Date().toISOString(),
    gitHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    gitStatus: execFileSync('git', ['status', '--short'], { cwd: root, encoding: 'utf8' }),
    profile: { seed: profile.seed, casesPerCandidate: profile.casesPerCandidate,
      minimumBoundaryPermutationsPerSecond: profile.minimumBoundaryPermutationsPerSecond },
    profileSha256: sha(readFileSync(profilePath)), sources: sources(), cases, diagnostic: diagnostic() });
  console.log(`Registered ${cases.length} cases per candidate.`);
} else {
  const registration = check(directory);
  if (mode === '--run') { if (existsSync(join(directory, 'attempt.json'))) throw new Error('attempt already exists'); await run(directory, registration); }
  else await verify(directory, registration);
}
