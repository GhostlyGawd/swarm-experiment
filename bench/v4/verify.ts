/** Independent reader for the versioned v4 token benchmark artifact. It
 * recomputes every count and verdict from retained raw messages. Verification
 * of a measured miss is success; release enforcement is a separate decision. */
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { arch, cpus, platform, release, totalmem } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { digest, enforcementFailures, evaluate, measureCorpus, profile, type BenchmarkRunV1, type Measurement } from './manifest.ts';
import { TOKENIZER, ledgerV6Corpus, type TokenWorkload } from './tokens.ts';

const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;
function readCanonical(path: string): unknown {
  if (statSync(path).size > MAX_ARTIFACT_BYTES) throw new RangeError('oversized benchmark artifact');
  const text = readFileSync(path, 'utf8'), value = JSON.parse(text);
  if (JSON.stringify(value, null, 2) + '\n' !== text) throw new TypeError('noncanonical benchmark JSON');
  return value;
}
function same(a: unknown, b: unknown): boolean { return JSON.stringify(a) === JSON.stringify(b); }
function sourcePaths(root: string): string[] {
  return execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--',
    'src', 'bench', 'package.json', 'package-lock.json', 'tsconfig.json'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean).sort();
}
function validPath(path: unknown): path is string {
  return typeof path === 'string' && !path.startsWith('/') && !path.includes('..') && !path.includes('\\')
    && (path.startsWith('src/') || path.startsWith('bench/') || ['package.json', 'package-lock.json', 'tsconfig.json'].includes(path));
}
export interface BenchmarkVerification {
  readonly verified: true;
  readonly subjectCommit: string;
  readonly sourceMatches: boolean | null;
  readonly requiredFailures: readonly string[];
  readonly releaseEligible: boolean;
}
export function verifyBenchmarkEvidence(directory: string, options: { sourceRoot?: string; exactSource?: boolean } = {}): BenchmarkVerification {
  const root = options.sourceRoot ?? fileURLToPath(new URL('../..', import.meta.url));
  const manifest = readCanonical(join(directory, 'manifest.json')) as BenchmarkRunV1;
  const samples = readCanonical(join(directory, 'samples.json')) as { format: string; tokenizer: unknown; corpus: TokenWorkload[];
    sourceFiles: Array<{ path: string; digest: string }>; workloads: unknown; aggregates: ReturnType<typeof measureCorpus>['aggregates'] };
  if (manifest?.format !== 'aether.benchmark/1' || !manifest.profile || !Array.isArray(manifest.measurements)
    || !/^[0-9a-f]{40}$/.test(manifest.subjectCommit) || typeof manifest.workingTreeDirty !== 'boolean'
    || manifest.samplesArtifact !== 'samples.json' || manifest.samplesDigest !== digest(samples)) throw new TypeError('benchmark manifest/sample binding mismatch');
  if (samples?.format !== 'aether.benchmark.samples/1' || !same(samples.tokenizer, TOKENIZER)
    || !Array.isArray(samples.corpus) || !Array.isArray(samples.sourceFiles)) throw new TypeError('invalid benchmark samples');
  if (!['ledger-baseline/1', 'ledger-warm-v6/1', 'v4-release/1', 'v4-release/2'].includes(manifest.profile.id))
    throw new TypeError('unknown benchmark target profile');
  if ((manifest.profile.id === 'ledger-warm-v6/1' || manifest.profile.id === 'v4-release/2')
    && !same(samples.corpus, ledgerV6Corpus())) throw new TypeError('Agent-IR6 benchmark corpus differs from executable fixture');
  const selected = profile(manifest.profile.id, samples.corpus.map(item => item.id));
  if (!same(manifest.profile, selected) || manifest.targetProfileDigest !== digest(selected)
    || manifest.workloadDigest !== digest(samples.corpus)) throw new TypeError('benchmark target/corpus changed');
  const counts = measureCorpus(samples.corpus);
  if (!same(samples.workloads, counts.workloads) || !same(samples.aggregates, counts.aggregates)) throw new TypeError('benchmark token counts changed');
  const paths = samples.sourceFiles.map(item => item.path);
  if (paths.some(path => !validPath(path)) || new Set(paths).size !== paths.length || !same(paths, [...paths].sort())
    || samples.sourceFiles.some(item => !/^sha256:[0-9a-f]{64}$/.test(item.digest))
    || manifest.sourceTreeDigest !== digest(samples.sourceFiles)) throw new TypeError('benchmark source-list binding mismatch');
  if (manifest.seed !== 'ledger-example' || manifest.warmup !== 0 || manifest.trials !== 1
    || manifest.environment?.tokenizerPackage !== TOKENIZER.package
    || manifest.environment?.tokenizerVersion !== TOKENIZER.version
    || manifest.environment?.tokenizerEncoding !== TOKENIZER.encoding
    || manifest.environment?.model !== 'none (offline text tokenization)' || manifest.environment?.clock !== 'not timed')
    throw new TypeError('benchmark environment/profile mismatch');
  const values = new Map<string, number | null>();
  for (const [metric, value] of Object.entries(counts.aggregates)) values.set(`aggregate:${metric}`, value.ratio);
  for (const workload of counts.workloads) for (const metric of ['warmBody', 'warmMessage', 'cold', 'fullSession'] as const)
    values.set(`${workload.id}:${metric}`, workload[metric].ratio);
  const expected = selected.targets.map(target => evaluate(target, values.get(target.metric) ?? null));
  if (!same(manifest.measurements, expected)) throw new TypeError('benchmark measurement/verdict differs from raw corpus');
  let sourceMatches: boolean | null = null;
  if (options.exactSource) {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    const current = sourcePaths(root);
    sourceMatches = head === manifest.subjectCommit && same(current, paths)
      && current.every((path, index) => digest(readFileSync(join(root, path), 'utf8')) === samples.sourceFiles[index].digest);
    if (!sourceMatches) throw new Error('benchmark source differs from measured commit/files');
    const packageLock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
    const spec = readFileSync(join(root, 'docs/implementation/v4/SPEC.md'), 'utf8').match(/Specification version\s*\|\s*\*\*([^*]+)\*\*/)?.[1];
    if (manifest.environment.packageLockDigest !== digest(packageLock) || manifest.specVersion !== spec
      || manifest.environment.os !== platform() || manifest.environment.release !== release()
      || manifest.environment.arch !== arch() || manifest.environment.cpu !== (cpus()[0]?.model ?? 'unknown')
      || manifest.environment.logicalCpus !== String(cpus().length)
      || manifest.environment.ramBytes !== String(totalmem()) || manifest.environment.node !== process.version)
      throw new Error('benchmark package/specification/environment differs from measured source');
  }
  const requiredFailures = enforcementFailures(selected, manifest.measurements as Measurement[]);
  return { verified: true, subjectCommit: manifest.subjectCommit, sourceMatches, requiredFailures,
    releaseEligible: manifest.profile.id.startsWith('v4-release/')
      && !manifest.workingTreeDirty && sourceMatches === true && requiredFailures.length === 0 };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const input = process.argv[2], exactSource = process.argv[3] === '--exact-source';
  if (!input || (process.argv.length > 3 && !exactSource) || process.argv.length > 4) throw new Error('usage: verify.ts OUTPUT_DIRECTORY [--exact-source]');
  console.log(JSON.stringify(verifyBenchmarkEvidence(resolve(input), { exactSource }), null, 2));
}
