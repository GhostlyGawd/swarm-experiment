import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { cases, buildProgram, differential, editWitness } from './verify.ts';

const root = resolve(import.meta.dirname, '../../../..');
const sources = [
  'roadmap/v4/research/native-fallback-ast/compiler.ts',
  'roadmap/v4/research/native-fallback-ast/driver.c',
  'roadmap/v4/research/native-fallback-ast/verify.ts',
  'roadmap/v4/research/native-fallback-ast/campaign.ts',
  'roadmap/v4/research/native-fallback-ast/audit.ts',
  'test/tier3/native-fallback-ast.test.ts',
  'test/tier3/fallback-tree-fixture.ts',
  'src/tier3/fallback-tree.ts',
  'src/tier2/typecheck.ts',
  'src/tier1/ast.ts',
  'package-lock.json',
];
const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
export const sourceHashes = () => Object.fromEntries(sources.map(path => [path, sha(readFileSync(join(root, path)))]));
function command(program: string, args: readonly string[], maxBuffer = 32 * 1024 * 1024): string {
  const child = spawnSync(program, [...args], { cwd: root, encoding: 'utf8', maxBuffer });
  if (child.status !== 0) throw new Error(`${program} ${args.join(' ')} failed (${child.status}): ${child.stderr}`);
  return child.stdout.trim();
}
export function cleanSource(): string {
  const status = command('git', ['status', '--porcelain']);
  if (status) throw new Error('native fallback campaign requires a clean source tree');
  return command('git', ['rev-parse', 'HEAD']);
}
function statistics(input: readonly number[]) {
  assert.ok(input.length > 0 && input.every(Number.isFinite));
  const sorted = [...input].sort((a, b) => a - b);
  const percentile = (p: number) => sorted[Math.ceil(p * sorted.length) - 1];
  return { count: sorted.length, min: sorted[0], p50: percentile(0.50),
    p95: percentile(0.95), p99: percentile(0.99), max: sorted.at(-1)!,
    above50ns: sorted.filter(value => value > 50).length };
}
export function register(directory: string): string {
  directory = resolve(directory);
  if (existsSync(directory)) throw new Error('native fallback campaign directory already exists');
  const commit = cleanSource(), pinnedSources = sourceHashes();
  mkdirSync(directory, { recursive: true });
  const record = { format: 'aether.ast-native-fallback-preregistration/1', registeredAt: new Date().toISOString(),
    commit, sourceHashes: pinnedSources, compiler: command('clang', ['--version']).split('\n')[0],
    compilerFlags: ['-O3', '-std=c11', '-Wall', '-Wextra', '-Werror', '-fno-lto'],
    hardware: { architecture: command('uname', ['-m']),
      processor: process.platform === 'darwin' ? command('sysctl', ['-n', 'machdep.cpu.brand_string']) : command('uname', ['-p']),
      os: command('uname', ['-srm']) },
    experiment: { scope: 'AST-derived pure record-reference fallback, one signed i64 field, native same-frame rollback',
      differentialCases: cases, warmup: 10000, trials: 5, samplesPerTrial: 2000,
      switchStart: 'before volatile fault read after Tier 1 speculative mutation',
      switchEnd: 'first Tier 2 prologue timer read after frame restoration, permission and native call transfer',
      excluded: ['full Aether Int/heap/effects/proof admission', 'remote sink status', 'durable host journal', 'guest runtime'],
      hardLimitNs: 50, timerOverheadSubtracted: false } };
  const file = join(directory, 'preregistration.json');
  writeFileSync(file, JSON.stringify(record, null, 2) + '\n', { flag: 'wx' });
  return file;
}
export function run(directory: string): string {
  directory = resolve(directory);
  const registration = join(directory, 'preregistration.json');
  const pre = JSON.parse(readFileSync(registration, 'utf8'));
  if (pre.format !== 'aether.ast-native-fallback-preregistration/1' || pre.commit !== cleanSource()
    || JSON.stringify(pre.sourceHashes) !== JSON.stringify(sourceHashes())
    || JSON.stringify(pre.experiment.differentialCases) !== JSON.stringify(cases)
    || pre.experiment.warmup !== 10000 || pre.experiment.trials !== 5 || pre.experiment.samplesPerTrial !== 2000
    || pre.experiment.hardLimitNs !== 50 || pre.experiment.timerOverheadSubtracted !== false)
    throw new Error('native fallback preregistration/source mismatch');
  if (existsSync(join(directory, 'raw.jsonl')) || existsSync(join(directory, 'report.json')))
    throw new Error('native fallback campaign already executed');
  const compiledAt = new Date().toISOString();
  const programs = new Map((['primary', 'fallback', 'abort'] as const).map(mode => [mode, buildProgram(directory, mode)] as const));
  const compared = differential(programs), edited = editWitness(directory, programs.get('fallback')!);
  writeFileSync(join(directory, 'differential.json'), JSON.stringify({ cases: compared, edited }, null, 2) + '\n', { flag: 'wx' });
  const startedAt = new Date().toISOString();
  const raw = command(programs.get('fallback')!.binary, ['--benchmark', '10000', '5', '2000']) + '\n';
  writeFileSync(join(directory, 'raw.jsonl'), raw, { flag: 'wx' });
  const lines = raw.trimEnd().split('\n').map(line => JSON.parse(line));
  const meta = lines.shift();
  assert.equal(meta.kind, 'metadata'); assert.equal(meta.warmup, 10000);
  assert.equal(meta.trials, 5); assert.equal(meta.samplesPerTrial, 2000);
  assert.equal(lines.length, 10000);
  const streams = { switch: [] as number[], full: [] as number[], timerPair: [] as number[] };
  const byTrial = [];
  for (let trial = 0; trial < 5; trial++) {
    const sub = lines.slice(trial * 2000, (trial + 1) * 2000);
    const per = { switch: [] as number[], full: [] as number[], timerPair: [] as number[] };
    for (const [index, row] of sub.entries()) {
      assert.equal(row.kind, 'sample'); assert.equal(row.trial, trial); assert.equal(row.index, index);
      for (const [name, field] of [['switch', 'switchTicks'], ['full', 'fullTicks'], ['timerPair', 'timerPairTicks']] as const) {
        assert.ok(Number.isSafeInteger(row[field]) && row[field] >= 0);
        const ns = row[field] * meta.tickNs;
        per[name].push(ns); streams[name].push(ns);
      }
    }
    byTrial.push(Object.fromEntries(Object.entries(per).map(([name, values]) => [name, statistics(values)])));
  }
  const summary = Object.fromEntries(Object.entries(streams).map(([name, values]) => [name, statistics(values)]));
  const report = { format: 'aether.ast-native-fallback-report/1', preregistrationSha256: sha(readFileSync(registration)),
    commit: pre.commit, sourceHashes: sourceHashes(), compiledAt, startedAt, finishedAt: new Date().toISOString(),
    programs: [...programs.values()].map(program => ({ mode: program.mode,
      root: program.lowered.root, manifestDigest: program.lowered.manifestDigest,
      sourceSha256: program.lowered.sourceSha256, binarySha256: program.binarySha256,
      assemblySha256: program.assemblySha256 })).concat([{ mode: 'edited', ...edited.editedProgram }]),
    differentialSha256: sha(readFileSync(join(directory, 'differential.json'))), rawSha256: sha(readFileSync(join(directory, 'raw.jsonl'))),
    differentialCases: compared.length, editWitness: { editedRoot: edited.editedRoot,
      changedBinary: edited.originalBinarySha256 !== edited.editedBinarySha256 },
    clock: meta.clock, tickNs: meta.tickNs, summary, byTrial,
    verdict: summary.switch.max > 50 ? 'miss' : 'inconclusive',
    qualification: 'Research only: AST-derived bounded native frame, no full runtime/effects/proof admission; clock quantization and raw maximum retained.' };
  const file = join(directory, 'report.json');
  writeFileSync(file, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  return file;
}
const [action, path] = process.argv.slice(2);
if (action && path) {
  if (action === 'register') process.stdout.write(`${register(path)}\n`);
  else if (action === 'run') process.stdout.write(`${run(path)}\n`);
  else throw new Error('usage: campaign.ts register|run <new-directory>');
}
