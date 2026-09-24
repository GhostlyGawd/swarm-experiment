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
import { domainDigest } from '../../../../src/fabric/identity.ts';
import { checkPortableCertificate, encodePortableCertificate,
  portableCertificateDigest, type PortableCertificateV1 } from '../../../../src/tier2/portable-proof-checker.ts';
import { generatePortableCertificate } from '../../../../src/tier2/portable-proof-producer.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const profilePath = join(root, 'roadmap/v4/research/proof-check-latency/profile.json');
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
  'roadmap/v4/research/proof-check-latency/profile.json', 'package-lock.json']) capture(path);
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

const [mode, supplied] = process.argv.slice(2);
if (!supplied || !['--measure', '--verify'].includes(mode))
  throw new Error('usage: campaign.ts --measure|--verify OUTPUT_DIRECTORY');
if (mode === '--measure') measure(resolve(supplied));
else verify(resolve(supplied));
