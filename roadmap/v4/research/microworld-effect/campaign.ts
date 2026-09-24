/** Exact-source signed effectful LivingCampaign measurement and replay. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, loadavg, platform, release, tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeCanonical } from '../../../../src/fabric/encoding.ts';
import { DurableEffectBroker } from '../../../../src/fabric/effects.ts';
import { domainDigest } from '../../../../src/fabric/identity.ts';
import { LivingCampaign, type LivingEffectCampaignReportV2 } from '../../../../src/tier3/living-campaign.ts';
import { effectFixture, signEffectFixture } from './fixture.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const profilePath = join(root, 'roadmap/v4/research/microworld-effect/profile.json');
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
for (const path of ['roadmap/v4/research/microworld-effect/campaign.ts',
  'roadmap/v4/research/microworld-effect/profile.json', 'package-lock.json']) capture(path);
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
  assert.ok(Buffer.from(encodeCanonical(actual)).equals(Buffer.from(encodeCanonical(expected))), 'campaign result diverged');
};
function temporary<T>(run: (directory: string) => T): T {
  const directory = mkdtempSync(join(tmpdir(), 'aether-living-effect-'));
  try { return run(directory); } finally { rmSync(directory, { recursive: true, force: true }); }
}
interface Registration {
  readonly format: 'aether.living-effect-registration/2'; readonly gitHead: string; readonly gitStatus: string;
  readonly at: string; readonly profileSha256: string; readonly sources: Record<string, string>;
  readonly profile: { seed: string; cases: number; minimumBoundaryPermutationsPerSecond: number };
  readonly publicKeyPem: string; readonly authorization: ReturnType<typeof signEffectFixture>;
  readonly generated: ReturnType<LivingCampaign['generate']>; readonly diagnostic: ReturnType<typeof diagnostic>;
}
function trust(registration: Registration) {
  return { repositoryId: 'living-effect-research', policyEpoch: '1', signer: 'living-effect-research-operator', key: registration.publicKeyPem };
}
function campaign(registration: Registration, directory: string): LivingCampaign {
  const fixture = effectFixture(registration.profile.seed, registration.profile.cases);
  return new LivingCampaign({ manifest: fixture.manifest, module: fixture.example.module, registry: fixture.example.capabilities,
    directory, effectAuthorization: registration.authorization, effectTrust: trust(registration) });
}
function check(directory: string): Registration {
  const registration = read(join(directory, 'registration.json')) as Registration;
  assert.equal(registration.format, 'aether.living-effect-registration/2');
  assert.equal(registration.profileSha256, sha(readFileSync(profilePath)));
  equal(registration.sources, sources());
  temporary(path => equal(campaign(registration, path).generate(), registration.generated));
  return registration;
}
function stable(report: LivingEffectCampaignReportV2) {
  const { elapsedMs: _elapsedMs, executedCasesPerSecond: _executedCasesPerSecond,
    evaluatedOperationsPerSecond: _evaluatedOperationsPerSecond, ...rest } = report;
  return rest;
}
function auditRaw(directory: string, report: LivingEffectCampaignReportV2): void {
  const reportId = domainDigest('aether.living-effect-campaign-report/2', report);
  const durableReport = readFileSync(join(directory, 'reports', `${reportId.split(':').at(-1)}.json`));
  assert.ok(durableReport.equals(Buffer.from(encodeCanonical(report))), 'durable report differs from observation');
  for (const item of report.cases) {
    const caseEvidence = { input: item.input, result: item.result };
    const caseId = domainDigest('aether.living-effect-case-evidence/2', caseEvidence);
    assert.ok(readFileSync(join(directory, 'cases', `${caseId.split(':').at(-1)}.json`))
      .equals(Buffer.from(encodeCanonical(caseEvidence))), 'durable case differs from observation');
    const suffix = item.result.caseDigest.split(':').at(-1)!;
    const broker = new DurableEffectBroker({ directory: join(directory, 'effect-journals', suffix),
      clockDomain: 'living-effect-clock/2', clock: () => 100n, authorize: () => true });
    const events = broker.events();
    assert.equal(domainDigest('aether.living-effect-journal/2', events), item.result.effects.journalDigest);
    assert.equal(events.length, item.result.effects.eventCount);
    const sink = join(directory, 'effect-sinks', suffix), names = readdirSync(sink).filter(name => name.endsWith('.json')).sort();
    assert.equal(names.length, item.result.effects.sinkWrites);
    assert.equal(domainDigest('aether.living-effect-sink-set/2', names.map(file => ({ file, bytes: readFileSync(join(sink, file), 'utf8') }))),
      item.result.effects.sinkDigest);
  }
}
async function run(directory: string, registration: Registration): Promise<void> {
  write(join(directory, 'attempt.json'), { format: 'aether.living-effect-attempt/2', before: diagnostic(),
    registrationSha256: sha(readFileSync(join(directory, 'registration.json'))) });
  const started = process.hrtime.bigint();
  const executor = campaign(registration, join(directory, 'raw'));
  equal(executor.generate(), registration.generated);
  const report = executor.runEffectful();
  const receipt = executor.admitEffectful(report);
  auditRaw(join(directory, 'raw'), report);
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  write(join(directory, 'report.json'), report);
  const seeds = report.cases.map(item => item.input.seed),
    coverage = [...new Set(report.cases.flatMap(item => item.result.coverage))].sort();
  write(join(directory, 'results.json'), { format: 'aether.living-effect-measurement/2',
    registrationSha256: sha(readFileSync(join(directory, 'registration.json'))),
    declared: report.declared, generated: report.generated, executed: report.executed, filtered: report.filtered,
    passed: report.passed, failed: report.failed, effectEvents: report.effectEvents,
    indeterminateEffects: report.indeterminateEffects, seeds, coverage, receipt,
    elapsedMs, completeCasesPerSecond: report.executed / (elapsedMs / 1000),
    minimumBoundaryPermutationsPerSecond: registration.profile.minimumBoundaryPermutationsPerSecond,
    throughputQualified: report.executed / (elapsedMs / 1000) >= registration.profile.minimumBoundaryPermutationsPerSecond,
    productionAuthorized: false, after: diagnostic(),
    timingScope: 'Timer includes construction, case generation/check, all Aether calls and broker dispatches, durable case/report publication, and admission; excludes registration and final measurement write.' });
  console.log(`Complete ${report.executed} signed effectful cases in ${elapsedMs.toFixed(3)} ms (${(report.executed / (elapsedMs / 1000)).toFixed(2)}/s).`);
}
async function verify(directory: string, registration: Registration): Promise<void> {
  const results = read(join(directory, 'results.json')), report = read(join(directory, 'report.json')) as LivingEffectCampaignReportV2;
  assert.ok(existsSync(join(directory, 'attempt.json')));
  assert.equal(results.registrationSha256, sha(readFileSync(join(directory, 'registration.json'))));
  assert.equal(results.declared, registration.profile.cases);
  assert.equal(results.generated, results.declared); assert.equal(results.executed, results.declared);
  assert.equal(results.filtered, 0); assert.equal(results.passed, results.declared); assert.equal(results.failed, 0);
  assert.equal(results.effectEvents, results.declared); assert.equal(results.indeterminateEffects, 0);
  assert.equal(results.receipt.productionAuthorized, false); assert.equal(results.productionAuthorized, false);
  assert.equal(results.minimumBoundaryPermutationsPerSecond, 2_000_000);
  assert.equal(results.throughputQualified, results.completeCasesPerSecond >= results.minimumBoundaryPermutationsPerSecond);
  assert.ok(Math.abs(results.completeCasesPerSecond - results.executed / (results.elapsedMs / 1000)) < 1e-9);
  equal(results.seeds, registration.generated.map(item => item.seed));
  equal(results.coverage, [...new Set(report.cases.flatMap(item => item.result.coverage))].sort());
  auditRaw(join(directory, 'raw'), report);
  temporary(path => {
    const fresh = campaign(registration, path), replay = fresh.runEffectful();
    equal(stable(replay), stable(report));
    equal(fresh.admitEffectful(replay).effectAuthorizationDigest, results.receipt.effectAuthorizationDigest);
  });
  console.log(`Verified ${results.executed} signed effectful cases, exact source, and fresh durable replay.`);
}
const [mode, supplied] = process.argv.slice(2);
if (!['--register', '--run', '--verify'].includes(mode) || !supplied) throw new Error('usage: campaign.ts --register|--run|--verify OUTPUT_DIRECTORY');
const directory = resolve(supplied);
if (mode === '--register') {
  if (existsSync(directory)) throw new Error('registration requires a new directory');
  const profile = read(profilePath);
  assert.equal(profile.format, 'aether.living-effect-campaign-profile/2');
  assert.equal(profile.minimumBoundaryPermutationsPerSecond, 2_000_000);
  const fixture = effectFixture(profile.seed, profile.cases);
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const authorization = signEffectFixture(fixture, privateKey);
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const generated = temporary(path => new LivingCampaign({ manifest: fixture.manifest, module: fixture.example.module,
    registry: fixture.example.capabilities, directory: path, effectAuthorization: authorization,
    effectTrust: { repositoryId: 'living-effect-research', policyEpoch: '1', signer: 'living-effect-research-operator', key: publicKeyPem } }).generate());
  mkdirSync(directory, { recursive: true });
  write(join(directory, 'registration.json'), { format: 'aether.living-effect-registration/2', at: new Date().toISOString(),
    gitHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    gitStatus: execFileSync('git', ['status', '--short'], { cwd: root, encoding: 'utf8' }),
    profileSha256: sha(readFileSync(profilePath)), sources: sources(),
    profile: { seed: profile.seed, cases: profile.cases,
      minimumBoundaryPermutationsPerSecond: profile.minimumBoundaryPermutationsPerSecond },
    publicKeyPem, authorization, generated, diagnostic: diagnostic() });
  console.log(`Registered ${generated.length} signed effectful cases.`);
} else {
  const registration = check(directory);
  if (mode === '--run') { if (existsSync(join(directory, 'attempt.json'))) throw new Error('attempt already exists'); await run(directory, registration); }
  else await verify(directory, registration);
}
