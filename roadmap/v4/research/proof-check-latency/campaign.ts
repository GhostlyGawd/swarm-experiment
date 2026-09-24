/** Bounded NFR-05 preflight. A failed result is retained, not promoted into a
 * release-profile pass. The verifier checks source/fixture/sample arithmetic;
 * historical elapsed time cannot be re-executed by reading a JSON file. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus, platform, release, totalmem } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as b from '../../../../src/tier1/build.ts';
import { SymbolSpace } from '../../../../src/tier1/symbols.ts';
import { GraphStore } from '../../../../src/tier1/store.ts';
import { domainDigest, executionManifestDigest } from '../../../../src/fabric/identity.ts';
import { encodeCanonical } from '../../../../src/fabric/encoding.ts';
import { checkPortableCertificate, encodePortableCertificate,
  portableCertificateDigest, portableObligationSetDigest,
  type PortableCertificateV1 } from '../../../../src/tier2/portable-proof-checker.ts';
import { generatePortableCertificate } from '../../../../src/tier2/portable-proof-producer.ts';
import { derivePortableObligations } from '../../../../src/tier2/portable-obligations.ts';
import { checkFormulaCertificate } from '../../../../src/tier2/portable-formula-checker.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const profilePath = join(root, 'roadmap/v4/research/proof-check-latency/profile.json');
const stageProfilePath = join(root, 'roadmap/v4/research/proof-check-latency/stage-profile.json');
const profile = JSON.parse(readFileSync(profilePath, 'utf8')) as {
  format: string; specVersion: string; fixture: string; checker: string; warmupChecks: number;
  measuredChecks: number; hardMaximumNs: number; timingScope: string;
};
assert.deepEqual({ format: profile.format, specVersion: profile.specVersion, fixture: profile.fixture,
  checker: profile.checker, warmupChecks: profile.warmupChecks,
  measuredChecks: profile.measuredChecks, hardMaximumNs: profile.hardMaximumNs },
{ format: 'aether.proof-check-latency-profile/1', specVersion: '0.1.0',
  fixture: 'portable-scalar-call-with-seven-obligations/1',
  checker: 'checkPortableCertificate', warmupChecks: 20,
  measuredChecks: 200, hardMaximumNs: 50_000 });
const sha = (value: string | Uint8Array): string =>
  createHash('sha256').update(value).digest('hex');
const git = (...args: string[]): string => execFileSync('git', args,
  { cwd: root, encoding: 'utf8' }).trim();

function fixture() {
  const symbols = new SymbolSpace('nfr05-portable-fixture');
  const entry = symbols.define('entry'), helper = symbols.define('helper'), x = symbols.define('x');
  const contract = b.contract({
    requires: [b.clause(b.ge(b.v(x), b.int(0)), 'nonnegative')],
    ensures: [b.clause(b.eq(b.result(), b.add(b.old(b.v(x)), b.int(1))), 'incremented')],
  });
  const target = b.fn({ symbol: helper, params: [b.param(x, b.Int)], returns: b.Int,
    contract, body: b.ret(b.add(b.v(x), b.int(1))) });
  const caller = b.fn({ symbol: entry, params: [b.param(x, b.Int)], returns: b.Int,
    contract, body: b.ret(b.call(helper, b.v(x))) });
  const module = b.module_({ symbol: symbols.define('module'), members: [caller, target],
    symbolTable: symbols.table() });
  const specification = 'For nonnegative inputs, pure scalar calls return the input plus one.';
  const store = new GraphStore();
  const d = (name: string) => domainDigest('aether.proof-check-latency-fixture/1', name);
  const manifest = { format: 'aether.execution/1' as const, astRoot: store.intern(module),
    specRoot: domainDigest('aether.specification/1', specification),
    dependencies: [{ symbol: helper, declaration: store.intern(target) }],
    semanticsVersion: 'aether-reference/1', compilerDigest: d('compiler'),
    target: { abiVersion: 'scalar/1', profileDigest: d('target'), artifactDigest: d('artifact') },
    capabilityPolicyDigest: d('pure-policy'), evidencePolicyDigest: d('portable-policy') };
  return { module, context: { manifest, expectedManifest: manifest, specification,
    dependencies: [] } };
}

const captured = new Set<string>();
function capture(path: string): void {
  if (captured.has(path)) return;
  const absolute = resolve(root, path);
  const within = relative(root, absolute);
  if (within.startsWith('..') || within.startsWith('/')) throw new Error('source escaped repository');
  captured.add(within);
  if (!within.endsWith('.ts')) return;
  const source = readFileSync(absolute, 'utf8');
  for (const match of source.matchAll(/(?:from\s*|import\s*\()['"](\.{1,2}\/[^'"\n]+\.ts)['"]/g))
    capture(relative(root, resolve(dirname(absolute), match[1])));
  for (const match of source.matchAll(/import\s*['"](\.{1,2}\/[^'"\n]+\.ts)['"]/g))
    capture(relative(root, resolve(dirname(absolute), match[1])));
}
for (const path of ['roadmap/v4/research/proof-check-latency/campaign.ts',
  'roadmap/v4/research/proof-check-latency/profile.json',
  'roadmap/v4/research/proof-check-latency/stage-profile.json', 'package-lock.json']) capture(path);
const sourceFiles = () => Object.fromEntries([...captured].sort().map(path =>
  [path, sha(readFileSync(join(root, path)))]));
const stats = (samplesNs: readonly number[]) => {
  if (samplesNs.length !== profile.measuredChecks
    || samplesNs.some(value => !Number.isSafeInteger(value) || value < 1))
    throw new TypeError('invalid proof-check timing samples');
  const sorted = [...samplesNs].sort((a, z) => a - z);
  return { minimumNs: sorted[0], medianNs: sorted[Math.floor(sorted.length / 2)],
    p95Ns: sorted[Math.ceil(sorted.length * 0.95) - 1], maximumNs: sorted.at(-1)!,
    overBound: samplesNs.filter(value => value > profile.hardMaximumNs).length };
};
const json = (value: unknown): string => JSON.stringify(value, null, 2) + '\n';
const environment = () => ({ node: process.version, platform: platform(), release: release(),
  arch: process.arch, cpu: cpus()[0]?.model, logicalCpus: cpus().length,
  ramBytes: totalmem() });

function measure(output: string): void {
  if (git('status', '--porcelain')) throw new Error('proof-check timing requires a clean source worktree');
  if (existsSync(output)) throw new Error('proof-check evidence output already exists');
  const f = fixture(), certificate = generatePortableCertificate(f.module, f.context);
  if (!certificate || certificate.certificates.length !== 7)
    throw new Error('declared seven-obligation portable certificate fixture changed');
  for (let i = 0; i < profile.warmupChecks; i++) checkPortableCertificate(f.module, certificate, f.context);
  const samplesNs: number[] = [];
  for (let i = 0; i < profile.measuredChecks; i++) {
    const start = process.hrtime.bigint();
    checkPortableCertificate(f.module, certificate, f.context);
    samplesNs.push(Number(process.hrtime.bigint() - start));
  }
  const samples = { format: 'aether.proof-check-latency-samples/1', certificate, samplesNs };
  const observed = stats(samplesNs);
  const manifest = { format: 'aether.proof-check-latency/1', subjectCommit: git('rev-parse', 'HEAD'),
    sourceFiles: sourceFiles(), profile, profileSha256: sha(readFileSync(profilePath)),
    samplesSha256: sha(json(samples)), certificateDigest: portableCertificateDigest(certificate),
    certificateBytes: encodePortableCertificate(certificate).length,
    environment: environment(), warmupChecks: profile.warmupChecks,
    measuredChecks: profile.measuredChecks, ...observed,
    verdict: observed.maximumNs <= profile.hardMaximumNs ? 'pass' : 'fail' };
  mkdirSync(output, { recursive: true });
  writeFileSync(join(output, 'samples.json'), json(samples));
  writeFileSync(join(output, 'manifest.json'), json(manifest));
  console.log(json({ verdict: manifest.verdict, certificateCount: certificate.certificates.length,
    ...observed, hardMaximumNs: profile.hardMaximumNs }));
}

function verify(output: string): void {
  const manifestBytes = readFileSync(join(output, 'manifest.json'), 'utf8');
  const samplesBytes = readFileSync(join(output, 'samples.json'), 'utf8');
  const manifest = JSON.parse(manifestBytes), samples = JSON.parse(samplesBytes);
  if (manifestBytes !== json(manifest) || samplesBytes !== json(samples))
    throw new TypeError('noncanonical proof-check evidence JSON');
  if (manifest.format !== 'aether.proof-check-latency/1'
    || samples.format !== 'aether.proof-check-latency-samples/1'
    || manifest.subjectCommit !== git('rev-parse', 'HEAD')
    || JSON.stringify(manifest.sourceFiles) !== JSON.stringify(sourceFiles())
    || JSON.stringify(manifest.profile) !== JSON.stringify(profile)
    || manifest.profileSha256 !== sha(readFileSync(profilePath))
    || manifest.samplesSha256 !== sha(samplesBytes)
    || JSON.stringify(manifest.environment) !== JSON.stringify(environment())
    || manifest.warmupChecks !== profile.warmupChecks
    || manifest.measuredChecks !== profile.measuredChecks)
    throw new TypeError('proof-check evidence source or profile changed');
  const f = fixture(), certificate = samples.certificate as PortableCertificateV1;
  if (certificate.certificates.length !== 7
    || portableCertificateDigest(certificate) !== manifest.certificateDigest
    || encodePortableCertificate(certificate).length !== manifest.certificateBytes)
    throw new TypeError('proof-check certificate identity changed');
  checkPortableCertificate(f.module, certificate, f.context);
  const observed = stats(samples.samplesNs);
  for (const [name, value] of Object.entries(observed)) if (manifest[name] !== value)
    throw new TypeError('proof-check sample statistic changed');
  if (manifest.verdict !== (observed.maximumNs <= profile.hardMaximumNs ? 'pass' : 'fail'))
    throw new TypeError('proof-check verdict changed');
  console.log(json({ verified: true, sourceMatches: true, verdict: manifest.verdict,
    ...observed, hardMaximumNs: profile.hardMaximumNs }));
}

const STAGE_NAMES = ['full', 'encode', 'executionDigest', 'derive',
  'obligationDigest', 'formulaProofs', 'certificateDigest'] as const;
type StageName = typeof STAGE_NAMES[number];
const stageProfile = JSON.parse(readFileSync(stageProfilePath, 'utf8')) as {
  format: string; specVersion: string; fixture: string;
  warmupChecksPerStage: number; measuredChecksPerStage: number;
  stages: readonly string[]; scope: string;
};
assert.deepEqual({ format: stageProfile.format, specVersion: stageProfile.specVersion,
  fixture: stageProfile.fixture, warmupChecksPerStage: stageProfile.warmupChecksPerStage,
  measuredChecksPerStage: stageProfile.measuredChecksPerStage, stages: stageProfile.stages },
{ format: 'aether.proof-check-stage-profile/1', specVersion: '0.1.0',
  fixture: 'portable-scalar-call-with-seven-obligations/1',
  warmupChecksPerStage: 10, measuredChecksPerStage: 100, stages: STAGE_NAMES });
function stageFunctions(f: ReturnType<typeof fixture>, certificate: PortableCertificateV1):
  Record<StageName, () => unknown> {
  const derived = derivePortableObligations(f.module, f.context);
  return {
    full: () => checkPortableCertificate(f.module, certificate, f.context),
    encode: () => encodeCanonical(certificate),
    executionDigest: () => executionManifestDigest(f.context.manifest),
    derive: () => derivePortableObligations(f.module, f.context),
    obligationDigest: () => portableObligationSetDigest(derived),
    formulaProofs: () => derived.obligations.forEach((obligation, index) =>
      checkFormulaCertificate(obligation.formula, certificate.certificates[index].proof,
        derived.manifestDigest)),
    certificateDigest: () => portableCertificateDigest(certificate),
  };
}
function stageStatistics(samples: Record<StageName, readonly number[]>) {
  return Object.fromEntries(STAGE_NAMES.map(name => {
    const values = samples[name];
    if (!Array.isArray(values) || values.length !== stageProfile.measuredChecksPerStage
      || values.some(value => !Number.isSafeInteger(value) || value < 1))
      throw new TypeError('invalid proof-check stage samples');
    const sorted = [...values].sort((a, z) => a - z);
    return [name, { minimumNs: sorted[0], medianNs: sorted[Math.floor(sorted.length / 2)],
      p95Ns: sorted[Math.ceil(sorted.length * 0.95) - 1], maximumNs: sorted.at(-1)! }];
  })) as Record<StageName, { minimumNs: number; medianNs: number; p95Ns: number; maximumNs: number }>;
}
function measureStages(output: string): void {
  if (git('status', '--porcelain')) throw new Error('proof-check stage timing requires a clean source worktree');
  if (existsSync(output)) throw new Error('proof-check stage evidence output already exists');
  const f = fixture(), certificate = generatePortableCertificate(f.module, f.context);
  if (!certificate || certificate.certificates.length !== 7)
    throw new Error('declared seven-obligation stage fixture changed');
  const functions = stageFunctions(f, certificate);
  const stageSamples = {} as Record<StageName, number[]>;
  for (const name of STAGE_NAMES) stageSamples[name] = [];
  for (const name of STAGE_NAMES) {
    for (let i = 0; i < stageProfile.warmupChecksPerStage; i++) functions[name]();
    for (let i = 0; i < stageProfile.measuredChecksPerStage; i++) {
      const start = process.hrtime.bigint(); functions[name]();
      stageSamples[name].push(Number(process.hrtime.bigint() - start));
    }
  }
  const samples = { format: 'aether.proof-check-stage-samples/1', certificate, stageSamples };
  const report = { format: 'aether.proof-check-stage-report/1', subjectCommit: git('rev-parse', 'HEAD'),
    sourceFiles: sourceFiles(), stageProfile, stageProfileSha256: sha(readFileSync(stageProfilePath)),
    samplesSha256: sha(json(samples)), certificateDigest: portableCertificateDigest(certificate),
    environment: environment(), statistics: stageStatistics(stageSamples) };
  mkdirSync(output, { recursive: true });
  writeFileSync(join(output, 'stage-samples.json'), json(samples));
  writeFileSync(join(output, 'stage-report.json'), json(report));
  console.log(json({ stageProfile: stageProfile.format, statistics: report.statistics }));
}
function verifyStages(output: string): void {
  const reportBytes = readFileSync(join(output, 'stage-report.json'), 'utf8');
  const samplesBytes = readFileSync(join(output, 'stage-samples.json'), 'utf8');
  const report = JSON.parse(reportBytes), samples = JSON.parse(samplesBytes);
  if (reportBytes !== json(report) || samplesBytes !== json(samples)
    || report.format !== 'aether.proof-check-stage-report/1'
    || samples.format !== 'aether.proof-check-stage-samples/1'
    || report.subjectCommit !== git('rev-parse', 'HEAD')
    || JSON.stringify(report.sourceFiles) !== JSON.stringify(sourceFiles())
    || JSON.stringify(report.stageProfile) !== JSON.stringify(stageProfile)
    || report.stageProfileSha256 !== sha(readFileSync(stageProfilePath))
    || report.samplesSha256 !== sha(samplesBytes)
    || JSON.stringify(report.environment) !== JSON.stringify(environment()))
    throw new TypeError('proof-check stage evidence source, profile or hardware changed');
  const f = fixture(), certificate = samples.certificate as PortableCertificateV1;
  if (portableCertificateDigest(certificate) !== report.certificateDigest
    || certificate.certificates.length !== 7)
    throw new TypeError('proof-check stage certificate changed');
  checkPortableCertificate(f.module, certificate, f.context);
  if (JSON.stringify(stageStatistics(samples.stageSamples)) !== JSON.stringify(report.statistics))
    throw new TypeError('proof-check stage statistics changed');
  console.log(json({ verified: true, sourceMatches: true,
    stageProfile: stageProfile.format, statistics: report.statistics }));
}

const [mode, supplied] = process.argv.slice(2);
if (!supplied || !['--measure', '--verify', '--stages', '--verify-stages'].includes(mode))
  throw new Error('usage: campaign.ts --measure|--verify|--stages|--verify-stages OUTPUT_DIRECTORY');
if (mode === '--measure') measure(resolve(supplied));
else if (mode === '--verify') verify(resolve(supplied));
else if (mode === '--stages') measureStages(resolve(supplied));
else verifyStages(resolve(supplied));
