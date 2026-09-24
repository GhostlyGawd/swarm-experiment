import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { cpus, totalmem, platform, arch, release } from 'node:os';
import { aggregateCounts, measureWorkload, TOKENIZER, type TokenWorkload } from './tokens.ts';

export type Verdict = 'pass' | 'fail' | 'not_measured' | 'inconclusive';
export interface Target {
  requirement: string;
  metric: string;
  unit: string;
  bound: string;
  required: boolean;
  minimum?: number;
}
export interface Profile {
  id: 'ledger-baseline/1' | 'ledger-warm-v6/1' | 'v4-release/1' | 'v4-release/2';
  scope: string;
  targets: Target[];
}
export interface Measurement extends Target { value: number | null; verdict: Verdict; reason: string }
export interface BenchmarkRunV1 {
  format: 'aether.benchmark/1';
  specVersion: string;
  subjectCommit: string;
  sourceTreeDigest: string;
  workingTreeDirty: boolean;
  workloadDigest: string;
  targetProfileDigest: string;
  environment: Record<string, string>;
  seed: string;
  warmup: number;
  trials: number;
  samplesArtifact: string;
  samplesDigest: string;
  measurements: Measurement[];
  profile: Profile;
}

export function digest(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

const remainingNfr = [
  ['01', 'ast.retrieval', 'ms', '≤2 ms at 100M DAG nodes'],
  ['02', 'replication.convergence', 'ms', '≤50 ms across 1,000 agents'],
  ['03', 'checkpoint.rollback', 'ms', '≤5 ms'],
  ['04', 'fallback.dispatch', 'ns', '≤50 ns within the active frame'],
  ['05', 'certificate.check', 'µs', '≤50 µs per bounded certificate'],
  ['06', 'unikernel.boot', 'ms/MB', '≤1 ms boot-to-response and ≤2 MB footprint'],
  ['07', 'state_lens.overhead', '%', '≤3.5% versus matched raw SQL'],
  ['08', 'smt.cutoff', 'ms', '≤1,500 ms including hard-query cancellation'],
  ['09', 'projection.throughput', 'lines/sec', '≥75,000 lines/sec'],
  ['10', 'zk.verification', 'ms', '≤5 ms'],
  ['12', 'multimodal.extraction', 'ms', '≤400 ms Figma-to-AST'],
  ['13', 'mutation.safety', 'agents', '1,000 mutating agents; no lock contention, deadlocks or write skew'],
  ['14', 'graph.capacity', 'nodes', '100M nodes with measured scaling behavior'],
  ['15', 'execution.determinism', 'identity', 'Identical heaps/register states for identical event logs, inputs and tokens'],
  ['16', 'capability.containment', 'probability', 'Pr[Escape] = 0 under explicitly proved model and trusted computing base'],
] as const;

export function profile(id: Profile['id'], workloadIds: readonly string[]): Profile {
  if ((id === 'ledger-warm-v6/1' || id === 'v4-release/2')
    && (workloadIds.length !== 1 || workloadIds[0] !== 'ledger-warm-v6/1'))
    throw new TypeError('Agent-IR6 benchmark profile requires its declared workload');
  const tokenTarget = (metric: string, required: boolean): Target => ({
    requirement: 'V4-NFR-11', metric, unit: 'baseline/candidate tokens', bound: '≥4×', minimum: 4, required,
  });
  const targets = ['aggregate', ...workloadIds].flatMap(workload => [
    tokenTarget(`${workload}:warmMessage`, true),
    tokenTarget(`${workload}:warmBody`, false),
    tokenTarget(`${workload}:cold`, false),
    tokenTarget(`${workload}:fullSession`, false),
  ]);
  if (id === 'v4-release/1' || id === 'v4-release/2') targets.push(...remainingNfr.map(([suffix, metric, unit, bound]) => ({
    requirement: `V4-NFR-${suffix}`, metric, unit, bound, required: true,
  })));
  return {
    id,
    scope: id === 'ledger-baseline/1' || id === 'ledger-warm-v6/1'
      ? 'Ledger token accounting only. Required ≥4× applies to complete warm wires per workload and aggregate; cold, body and complete-session ratios are diagnostics. This fixture does not qualify V4-Q03.'
      : 'Provisional v4 measurement inventory. Includes every NFR; missing target-specific workloads/hardware profiles remain not_measured. A successful run cannot alone close a release or establish KPI/governance obligations.',
    targets,
  };
}

export function evaluate(target: Target, value: number | null): Measurement {
  if (value === null) return { ...target, value, verdict: 'not_measured', reason: 'No qualifying measurement for this required target profile.' };
  if (!Number.isFinite(value) || target.minimum === undefined) {
    return { ...target, value: Number.isFinite(value) ? value : null, verdict: 'inconclusive', reason: 'Nonfinite value or undefined acceptance calculation.' };
  }
  return { ...target, value, verdict: value >= target.minimum ? 'pass' : 'fail', reason: `Observed ratio ${value}; required minimum ${target.minimum}.` };
}

/** Validate every expected target; deleting a failed row never permits admission. */
export function enforcementFailures(expected: Profile, measurements: readonly Measurement[]): string[] {
  const failures: string[] = [];
  for (const target of expected.targets) {
    if (!target.required) continue;
    const rows = measurements.filter(row => row.requirement === target.requirement && row.metric === target.metric);
    if (rows.length !== 1) { failures.push(`${target.metric}: missing or duplicate measurement`); continue; }
    const row = rows[0];
    const computed = evaluate(target, row.value);
    if (row.unit !== target.unit || row.bound !== target.bound || row.required !== target.required
      || row.minimum !== target.minimum || row.reason !== computed.reason
      || computed.verdict !== 'pass' || row.verdict !== computed.verdict) failures.push(`${target.metric}: ${computed.verdict}`);
  }
  return failures;
}

export function measureCorpus(corpus: readonly TokenWorkload[]) {
  if (corpus.length === 0 || new Set(corpus.map(workload => workload.id)).size !== corpus.length) throw new Error('Corpus needs unique, nonempty workloads');
  const workloads = corpus.map(measureWorkload);
  const aggregates = {
    warmBody: aggregateCounts(workloads.map(workload => workload.warmBody)),
    warmMessage: aggregateCounts(workloads.map(workload => workload.warmMessage)),
    cold: aggregateCounts(workloads.map(workload => workload.cold)),
    fullSession: aggregateCounts(workloads.map(workload => workload.fullSession)),
  };
  return { workloads, aggregates };
}

export function createRun(corpus: TokenWorkload[], selected: Profile, samplesArtifact: string, root: string) {
  const packageLock = JSON.parse(readFileSync(`${root}/package-lock.json`, 'utf8'));
  const installed = JSON.parse(readFileSync(`${root}/node_modules/js-tiktoken/package.json`, 'utf8'));
  if (installed.version !== TOKENIZER.version || packageLock.packages['node_modules/js-tiktoken'].version !== TOKENIZER.version) {
    throw new Error(`Pinned tokenizer ${TOKENIZER.version} required; version the corpus/profile before changing it`);
  }
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  const paths = git('ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', 'src', 'bench', 'package.json', 'package-lock.json', 'tsconfig.json').split('\0').filter(Boolean).sort();
  const sourceFiles = paths.map(path => ({ path, digest: digest(readFileSync(`${root}/${path}`, 'utf8')) }));
  const samples = {
    format: 'aether.benchmark.samples/1', tokenizer: TOKENIZER, corpus,
    sourceFiles,
    // Tokenization is deterministic; no latency or API usage is claimed.
    ...measureCorpus(corpus),
  };
  const values = new Map<string, number | null>();
  for (const [metric, counts] of Object.entries(samples.aggregates)) values.set(`aggregate:${metric}`, counts.ratio);
  for (const workload of samples.workloads) {
    for (const metric of ['warmBody', 'warmMessage', 'cold', 'fullSession'] as const) values.set(`${workload.id}:${metric}`, workload[metric].ratio);
  }
  const spec = readFileSync(`${root}/docs/implementation/v4/SPEC.md`, 'utf8').match(/Specification version\s*\|\s*\*\*([^*]+)\*\*/)?.[1];
  if (!spec) throw new Error('Specification version missing');
  const run: BenchmarkRunV1 = {
    format: 'aether.benchmark/1', specVersion: spec,
    subjectCommit: git('rev-parse', 'HEAD'), sourceTreeDigest: digest(sourceFiles), workingTreeDirty: git('status', '--porcelain').length > 0,
    workloadDigest: digest(corpus), targetProfileDigest: digest(selected),
    environment: {
      os: platform(), release: release(), arch: arch(), cpu: cpus()[0]?.model ?? 'unknown',
      logicalCpus: String(cpus().length), ramBytes: String(totalmem()), node: process.version,
      tokenizerPackage: TOKENIZER.package, tokenizerVersion: installed.version, tokenizerEncoding: TOKENIZER.encoding,
      packageLockDigest: digest(packageLock), model: 'none (offline text tokenization)', clock: 'not timed',
    },
    seed: 'ledger-example', warmup: 0, trials: 1,
    samplesArtifact, samplesDigest: digest(samples), profile: selected,
    measurements: selected.targets.map(target => evaluate(target, values.get(target.metric) ?? null)),
  };
  return { run, samples };
}
