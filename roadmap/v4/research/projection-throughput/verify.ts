/** Independent source/identity/recount verifier for NFR-09 raw trials. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { cpus, platform, release } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { executableBundle, parseExecutableBundle } from '../../../../src/projection/executable.ts';
import { GraphStore } from '../../../../src/tier1/store.ts';
import { projectionThroughputCorpus } from './corpus.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const profilePath = join(root, 'roadmap/v4/research/projection-throughput/profile.json');
const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const read = (path: string): any => JSON.parse(readFileSync(path, 'utf8'));
const listed = new Set<string>();
function discover(path: string): void {
  if (!existsSync(join(root, path)) || listed.has(path)) return;
  listed.add(path);
  if (!/\.(ts|mjs)$/.test(path)) return;
  const text = readFileSync(join(root, path), 'utf8');
  for (const match of text.matchAll(/(?:from\s*|import\s*\()['"](\.{1,2}\/[^'"\n]+\.(?:ts|mjs))['"]/g))
    discover(relative(root, resolve(root, dirname(path), match[1])));
}
for (const path of ['roadmap/v4/research/projection-throughput/campaign.ts',
  'roadmap/v4/research/projection-throughput/verify.ts',
  'roadmap/v4/research/projection-throughput/profile.json', 'package-lock.json',
  'tsconfig.check.json']) discover(path);
const requiredSources = [...listed].sort();
function physicalLines(text: string): number {
  assert.ok(!text.includes('\r'), 'projection source LF rule');
  return text.length === 0 ? 0 : text.split('\n').length - Number(text.endsWith('\n'));
}
function expectedOutputs(): Map<string, any> {
  const result = new Map<string, any>();
  for (const item of projectionThroughputCorpus()) for (const target of ['typescript', 'python', 'rust'] as const) {
    const bundle = executableBundle(item.module, item.symbols, target, { modules: item.modules });
    const parsed = parseExecutableBundle(bundle), store = new GraphStore();
    assert.equal(store.intern(parsed.module), item.expectedRoot);
    const roots = [...(item.modules?.keys() ?? [])].sort();
    assert.deepEqual([...parsed.modules.keys()].sort(), roots);
    for (const [root, term] of parsed.modules) assert.equal(store.intern(term), root);
    const dependencies = [...(bundle.dependencies ?? new Map<string, string>())].sort(([a], [b]) => a.localeCompare(b));
    const sourceLines = physicalLines(bundle.source);
    const dependencyFiles = dependencies.map(([name, text]) => ({ name,
      lines: physicalLines(text), bytes: Buffer.byteLength(text), sha256: sha(text) }));
    result.set(`${target}/${item.id}`, {
      task: item.id, workload: item.workload, variant: item.variant, target, root: item.expectedRoot,
      dependencyRoots: roots, sourceLines,
      dependencyLines: dependencyFiles.reduce((sum, file) => sum + file.lines, 0),
      totalLines: sourceLines + dependencyFiles.reduce((sum, file) => sum + file.lines, 0),
      sourceBytes: Buffer.byteLength(bundle.source), runtimeBytes: Buffer.byteLength(bundle.runtime),
      sourceSha256: sha(bundle.source), runtimeSha256: sha(bundle.runtime), dependencyFiles,
    });
  }
  return result;
}
function verify(directory: string): void {
  const registration = read(join(directory, 'preregistration.json')),
    attempt = read(join(directory, 'attempt.json')),
    report = read(join(directory, 'report.json')),
    profile = read(profilePath);
  assert.equal(registration.format, 'aether.projection-throughput-registration/1');
  assert.equal(profile.format, 'aether.projection-throughput-profile/1');
  assert.equal(registration.profileSha256, sha(readFileSync(profilePath)));
  assert.deepEqual(Object.keys(registration.sources).sort(), requiredSources);
  for (const path of requiredSources) assert.equal(registration.sources[path], sha(readFileSync(join(root, path))), `source changed: ${path}`);
  assert.equal(registration.hardware.platform, platform());
  assert.equal(registration.hardware.release, release());
  assert.equal(registration.hardware.arch, process.arch);
  assert.deepEqual(registration.hardware.cpuModels, cpus().map(cpu => cpu.model));
  assert.equal(registration.hardware.node, process.version);
  assert.equal(registration.hardware.nodeBinary.sha256, sha(readFileSync(realpathSync(process.execPath))));
  for (const name of ['python', 'rustc', 'tsc']) {
    const row = registration.hardware[name];
    if (row.path !== null && existsSync(row.path)) assert.equal(row.sha256, sha(readFileSync(row.path)), `tool changed: ${name}`);
  }
  const corpus = projectionThroughputCorpus();
  assert.deepEqual(registration.cases, corpus.map(item => ({ id: item.id, workload: item.workload,
    variant: item.variant, root: item.expectedRoot, dependencyRoots: [...(item.modules?.keys() ?? [])].sort() })));
  assert.equal(registration.targetLinesPerSecond, 75_000);
  assert.equal(registration.warmups, 1); assert.equal(registration.measuredTrials, 5);
  assert.equal(attempt.format, 'aether.projection-throughput-attempt/1');
  assert.equal(attempt.registrationSha256, sha(readFileSync(join(directory, 'preregistration.json'))));
  assert.equal(report.format, 'aether.projection-throughput-report/1');
  assert.equal(report.registrationSha256, attempt.registrationSha256);
  assert.equal(report.profileSha256, registration.profileSha256);
  assert.equal(report.sourceCommit, registration.gitHead);
  assert.equal(report.corpusCases, 16); assert.equal(report.outputsPerTrial, 48);
  assert.equal(report.warmups, 1); assert.equal(report.measuredTrials, 5);
  assert.equal(report.targetLinesPerSecond, 75_000);
  assert.equal(report.releaseQualified, false);
  const expected = expectedOutputs();
  assert.equal(expected.size, 48);
  const summaries = new Map<string, number[]>(), projectionOnly = new Map<string, number[]>();
  for (const trial of [-1, 0, 1, 2, 3, 4]) {
    const raw = read(join(directory, 'trials', trial === -1 ? 'warmup.json' : `${trial}.json`));
    assert.equal(raw.format, 'aether.projection-throughput-trial/1');
    assert.equal(raw.trial, trial);
    assert.equal(raw.outputs.length, 48); assert.equal(raw.targets.length, 3);
    const seen = new Set<string>();
    for (const row of raw.outputs) {
      const key = `${row.target}/${row.task}`, baseline = expected.get(key);
      assert.ok(baseline && !seen.has(key), `missing or duplicate output: ${key}`);
      seen.add(key);
      for (const field of ['task', 'workload', 'variant', 'target', 'root', 'sourceLines',
        'dependencyLines', 'totalLines', 'sourceBytes', 'runtimeBytes', 'sourceSha256', 'runtimeSha256'])
        assert.deepEqual(row[field], baseline[field], `${key}/${field}`);
      assert.deepEqual(row.dependencyRoots, baseline.dependencyRoots);
      assert.deepEqual(row.dependencyFiles, baseline.dependencyFiles);
      assert.ok(BigInt(row.projectionNs) > 0n && BigInt(row.parseIdentityNs) > 0n);
    }
    assert.equal(seen.size, expected.size);
    for (const [index, target] of (['typescript', 'python', 'rust'] as const).entries()) {
      const metric = raw.targets[index];
      assert.equal(metric.target, target); assert.equal(metric.outputs, 16);
      const subset = raw.outputs.filter((row: any) => row.target === target);
      const lines = subset.reduce((sum: number, row: any) => sum + row.totalLines, 0),
        projectNs = subset.reduce((sum: bigint, row: any) => sum + BigInt(row.projectionNs), 0n),
        parseNs = subset.reduce((sum: bigint, row: any) => sum + BigInt(row.parseIdentityNs), 0n),
        wallNs = BigInt(metric.wallNs);
      assert.equal(metric.lines, lines);
      assert.equal(metric.projectionNs, String(projectNs));
      assert.equal(metric.parseIdentityNs, String(parseNs));
      assert.ok(wallNs >= projectNs + parseNs);
      assert.ok(Math.abs(metric.wallLinesPerSecond - lines / (Number(wallNs) / 1e9)) < 1e-6);
      assert.ok(Math.abs(metric.projectionOnlyLinesPerSecond - lines / (Number(projectNs) / 1e9)) < 1e-6);
      assert.equal(metric.pass, metric.wallLinesPerSecond >= 75_000);
      if (trial >= 0) {
        (summaries.get(target) ?? (summaries.set(target, []), summaries.get(target)!)).push(metric.wallLinesPerSecond);
        (projectionOnly.get(target) ?? (projectionOnly.set(target, []), projectionOnly.get(target)!)).push(metric.projectionOnlyLinesPerSecond);
      }
    }
  }
  assert.equal(report.summaries.length, 3);
  for (const [index, target] of (['typescript', 'python', 'rust'] as const).entries()) {
    const summary = report.summaries[index], rates = summaries.get(target)!;
    assert.equal(summary.target, target);
    assert.equal(summary.outputsPerTrial, 16);
    assert.equal(summary.linesPerTrial, [...expected.values()].filter(row => row.target === target)
      .reduce((sum, row) => sum + row.totalLines, 0));
    assert.deepEqual(summary.rates, rates);
    assert.deepEqual(summary.projectionOnlyRates, projectionOnly.get(target));
    assert.equal(summary.minimumLinesPerSecond, Math.min(...rates));
    assert.equal(summary.minimumProjectionOnlyLinesPerSecond, Math.min(...projectionOnly.get(target)!));
    assert.equal(summary.allTrialsPass, rates.every(rate => rate >= 75_000));
  }
  assert.equal(report.preflightPass, report.summaries.every((row: { allTrialsPass: boolean }) => row.allTrialsPass));
  console.log(JSON.stringify({ verified: true, sourceCommit: registration.gitHead,
    summaries: report.summaries, preflightPass: report.preflightPass }));
}
const directory = process.argv[2];
if (!directory) throw new Error('usage: verify.ts OUTPUT_DIRECTORY');
verify(resolve(directory));
