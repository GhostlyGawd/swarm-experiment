/** Frozen NFR-09 preflight: real projection, parse and exact identity work. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { cpus, loadavg, platform, release, totalmem } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { executableBundle, parseExecutableBundle, type ExecutableTarget } from '../../../../src/projection/executable.ts';
import { GraphStore } from '../../../../src/tier1/store.ts';
import { projectionThroughputCorpus } from './corpus.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const profilePath = join(root, 'roadmap/v4/research/projection-throughput/profile.json');
const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const read = (path: string): any => JSON.parse(readFileSync(path, 'utf8'));
function write(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const fd = openSync(path, 'wx', 0o600);
  try { writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
  const parent = openSync(dirname(path), 'r'); try { fsyncSync(parent); } finally { closeSync(parent); }
}
const pinned = new Set<string>();
function capture(path: string): void {
  // Projection source contains quoted generated imports for virtual runtime
  // files. Only actual filesystem source imports enter the source closure.
  if (!existsSync(join(root, path)) || pinned.has(path)) return;
  pinned.add(path);
  if (!/\.(?:ts|mjs)$/.test(path)) return;
  const source = readFileSync(join(root, path), 'utf8');
  for (const match of source.matchAll(/(?:from\s*|import\s*\()['"](\.{1,2}\/[^'"\n]+\.(?:ts|mjs))['"]/g))
    capture(relative(root, resolve(root, dirname(path), match[1])));
}
for (const path of ['roadmap/v4/research/projection-throughput/campaign.ts',
  'roadmap/v4/research/projection-throughput/verify.ts',
  'roadmap/v4/research/projection-throughput/profile.json', 'package-lock.json',
  'tsconfig.check.json']) capture(path);
const sourcePaths = [...pinned].sort();
const sources = () => Object.fromEntries(sourcePaths.map(path => [path, sha(readFileSync(join(root, path)))]));
function tool(name: string): { path: string | null; version: string | null; sha256: string | null } {
  try {
    const path = realpathSync(execFileSync('which', [name], { encoding: 'utf8' }).trim());
    return { path, version: execFileSync(name, ['--version'], { encoding: 'utf8' }).trim().split('\n')[0],
      sha256: sha(readFileSync(path)) };
  } catch { return { path: null, version: null, sha256: null }; }
}
const hardware = () => ({ at: new Date().toISOString(), platform: platform(), release: release(),
  arch: process.arch, cpuModels: cpus().map(cpu => cpu.model), totalMemoryBytes: totalmem(),
  load: loadavg(), node: process.version, nodeBinary: { path: realpathSync(process.execPath),
    sha256: sha(readFileSync(realpathSync(process.execPath))) },
  python: tool('python3'), rustc: tool('rustc'), tsc: tool(join(root, 'node_modules/.bin/tsc')) });
function lines(source: string): number {
  if (source.includes('\r')) throw new Error('projection emitted non-LF source');
  return source.length ? source.split('\n').length - Number(source.endsWith('\n')) : 0;
}
type Output = { task: string; workload: string; variant: string; target: ExecutableTarget;
  root: string; dependencyRoots: readonly string[]; sourceLines: number; dependencyLines: number;
  totalLines: number; sourceBytes: number; runtimeBytes: number; sourceSha256: string;
  runtimeSha256: string; dependencyFiles: readonly { name: string; lines: number; bytes: number; sha256: string }[];
  projectionNs: string; parseIdentityNs: string };
function oneTrial(trial: number): { format: 'aether.projection-throughput-trial/1'; trial: number;
  targets: readonly { target: ExecutableTarget; wallNs: string; projectionNs: string;
    parseIdentityNs: string; lines: number; outputs: number; wallLinesPerSecond: number;
    projectionOnlyLinesPerSecond: number; pass: boolean }[]; outputs: readonly Output[] } {
  const corpus = projectionThroughputCorpus(), outputs: Output[] = [], targets = [];
  for (const target of ['typescript', 'python', 'rust'] as const) {
    const pending: { item: typeof corpus[number]; bundle: ReturnType<typeof executableBundle>;
      projectionNs: bigint; parseIdentityNs: bigint; sourceLines: number; dependencyLines: number }[] = [];
    const targetStarted = process.hrtime.bigint();
    for (const item of corpus) {
      const started = process.hrtime.bigint();
      const bundle = executableBundle(item.module, item.symbols, target, { modules: item.modules });
      const projectionNs = process.hrtime.bigint() - started;
      const parseStarted = process.hrtime.bigint(), parsed = parseExecutableBundle(bundle), store = new GraphStore();
      if (store.intern(parsed.module) !== item.expectedRoot) throw new Error(`projection root changed: ${item.id}/${target}`);
      const expectedDependencies = new Set(item.modules?.keys() ?? []);
      if (parsed.modules.size !== expectedDependencies.size
        || [...parsed.modules].some(([root, module]) => !expectedDependencies.has(root) || store.intern(module) !== root))
        throw new Error(`projection dependency identity changed: ${item.id}/${target}`);
      const parseIdentityNs = process.hrtime.bigint() - parseStarted;
      const sourceLines = lines(bundle.source);
      const dependencyLines = [...(bundle.dependencies?.values() ?? [])].reduce((sum, source) => sum + lines(source), 0);
      pending.push({ item, bundle, projectionNs, parseIdentityNs, sourceLines, dependencyLines });
    }
    const wallNs = process.hrtime.bigint() - targetStarted;
    const totalLines = pending.reduce((sum, row) => sum + row.sourceLines + row.dependencyLines, 0);
    const projectionNs = pending.reduce((sum, row) => sum + row.projectionNs, 0n);
    const parseIdentityNs = pending.reduce((sum, row) => sum + row.parseIdentityNs, 0n);
    const wallLinesPerSecond = totalLines / (Number(wallNs) / 1e9);
    targets.push({ target, wallNs: String(wallNs), projectionNs: String(projectionNs),
      parseIdentityNs: String(parseIdentityNs), lines: totalLines, outputs: pending.length,
      wallLinesPerSecond, projectionOnlyLinesPerSecond: totalLines / (Number(projectionNs) / 1e9),
      pass: wallLinesPerSecond >= 75_000 });
    // Hashing and raw artifact construction occur after the target timer.
    for (const row of pending) {
      const dependencies = [...(row.bundle.dependencies ?? new Map())].sort(([a], [b]) => a.localeCompare(b));
      const dependencyFiles = dependencies.map(([name, source]) => ({ name, lines: lines(source),
        bytes: Buffer.byteLength(source), sha256: sha(source) }));
      outputs.push({ task: row.item.id, workload: row.item.workload, variant: row.item.variant,
        target, root: row.item.expectedRoot,
        dependencyRoots: [...(row.item.modules?.keys() ?? [])].sort(),
        sourceLines: row.sourceLines, dependencyLines: row.dependencyLines,
        totalLines: row.sourceLines + row.dependencyLines,
        sourceBytes: Buffer.byteLength(row.bundle.source), runtimeBytes: Buffer.byteLength(row.bundle.runtime),
        sourceSha256: sha(row.bundle.source), runtimeSha256: sha(row.bundle.runtime),
        dependencyFiles, projectionNs: String(row.projectionNs), parseIdentityNs: String(row.parseIdentityNs) });
    }
  }
  return { format: 'aether.projection-throughput-trial/1', trial, targets, outputs };
}
function checkProfile(): any {
  const profile = read(profilePath);
  assert.equal(profile.format, 'aether.projection-throughput-profile/1');
  assert.equal(profile.targetLinesPerSecond, 75_000); assert.equal(profile.warmups, 1);
  assert.equal(profile.measuredTrials, 5); assert.deepEqual(profile.targets, ['typescript', 'python', 'rust']);
  assert.equal(profile.workloads.length, 8);
  return profile;
}
function register(directory: string): void {
  if (existsSync(directory)) throw new Error('projection registration requires new directory');
  const profile = checkProfile(), corpus = projectionThroughputCorpus();
  assert.equal(corpus.length, profile.workloads.length * 2);
  const gitHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const gitStatus = execFileSync('git', ['status', '--short'], { cwd: root, encoding: 'utf8' });
  mkdirSync(directory, { recursive: true });
  write(join(directory, 'preregistration.json'), { format: 'aether.projection-throughput-registration/1',
    at: new Date().toISOString(), gitHead, gitStatus,
    profileSha256: sha(readFileSync(profilePath)), sources: sources(), hardware: hardware(),
    cases: corpus.map(item => ({ id: item.id, workload: item.workload, variant: item.variant,
      root: item.expectedRoot, dependencyRoots: [...(item.modules?.keys() ?? [])].sort() })),
    targetLinesPerSecond: 75_000, warmups: 1, measuredTrials: 5,
    timedBoundary: profile.timedBoundary, passRule: profile.passRule, scope: profile.scope });
  console.log(`Registered ${corpus.length} exact-root variants across three target projections.`);
}
function run(directory: string): void {
  const profile = checkProfile(), registration = read(join(directory, 'preregistration.json'));
  assert.equal(registration.profileSha256, sha(readFileSync(profilePath)));
  assert.deepEqual(registration.sources, sources());
  const cases = projectionThroughputCorpus().map(item => ({ id: item.id, workload: item.workload,
    variant: item.variant, root: item.expectedRoot, dependencyRoots: [...(item.modules?.keys() ?? [])].sort() }));
  assert.deepEqual(registration.cases, cases);
  assert.equal(registration.hardware.nodeBinary.sha256, hardware().nodeBinary.sha256);
  if (existsSync(join(directory, 'attempt.json'))) throw new Error('projection campaign attempt already exists');
  write(join(directory, 'attempt.json'), { format: 'aether.projection-throughput-attempt/1',
    registrationSha256: sha(readFileSync(join(directory, 'preregistration.json'))), before: hardware() });
  const trials = [];
  for (let trial = -1; trial < 5; trial++) {
    const sample = oneTrial(trial);
    write(join(directory, 'trials', trial < 0 ? 'warmup.json' : `${trial}.json`), sample);
    trials.push(sample);
  }
  const measured = trials.filter(item => item.trial >= 0);
  const summaries = (['typescript', 'python', 'rust'] as const).map(target => {
    const rows = measured.map(item => item.targets.find(row => row.target === target)!);
    const rates = rows.map(row => row.wallLinesPerSecond),
      projectionOnlyRates = rows.map(row => row.projectionOnlyLinesPerSecond);
    return { target, outputsPerTrial: rows[0].outputs, linesPerTrial: rows[0].lines,
      rates, projectionOnlyRates, minimumLinesPerSecond: Math.min(...rates),
      minimumProjectionOnlyLinesPerSecond: Math.min(...projectionOnlyRates),
      allTrialsPass: rows.every(row => row.pass) };
  });
  write(join(directory, 'report.json'), { format: 'aether.projection-throughput-report/1',
    registrationSha256: sha(readFileSync(join(directory, 'preregistration.json'))),
    profileSha256: sha(readFileSync(profilePath)), sourceCommit: registration.gitHead,
    corpusCases: cases.length, outputsPerTrial: cases.length * 3,
    warmups: 1, measuredTrials: 5, targetLinesPerSecond: 75_000,
    summaries, preflightPass: summaries.every(item => item.allTrialsPass),
    releaseQualified: false,
    scope: 'Authored eight-workload/one-edit preflight with real TypeScript/Python/Rust source projection and Aether parse/identity; no target compiler execution or representative production repository distribution.',
    after: hardware() });
  console.log(JSON.stringify({ summaries, preflightPass: summaries.every(item => item.allTrialsPass) }));
}
const [mode, supplied] = process.argv.slice(2);
if (!['--register', '--run'].includes(mode) || !supplied)
  throw new Error('usage: campaign.ts --register|--run OUTPUT_DIRECTORY');
const directory = resolve(supplied);
if (mode === '--register') register(directory); else run(directory);
