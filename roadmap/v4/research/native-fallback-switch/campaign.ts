import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cases, differential } from './verify.ts';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../../..');
const sourcePaths = [
  'roadmap/v4/research/native-fallback-switch/switch.c',
  'roadmap/v4/research/native-fallback-switch/verify.ts',
  'roadmap/v4/research/native-fallback-switch/campaign.ts',
  'test/tier3/fallback-tree-fixture.ts',
  'src/tier3/fallback-tree.ts',
  'src/tier3/compile.ts',
];
const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const hashes = () => Object.fromEntries(sourcePaths.map(path => [path, sha(readFileSync(join(root, path)))]));
function command(program: string, args: string[], options: { cwd?: string } = {}): string {
  const child = spawnSync(program, args, { encoding: 'utf8', cwd: options.cwd, maxBuffer: 32 * 1024 * 1024 });
  if (child.status !== 0) throw new Error(`${program} ${args.join(' ')} failed (${child.status}): ${child.stderr}`);
  return child.stdout.trim();
}
function statistics(input: readonly number[]) {
  assert.ok(input.length > 0 && input.every(Number.isFinite));
  const sorted = [...input].sort((a, b) => a - b);
  const percentile = (p: number) => sorted[Math.ceil(p * sorted.length) - 1];
  return { count: sorted.length, min: sorted[0], p50: percentile(0.50),
    p95: percentile(0.95), p99: percentile(0.99), max: sorted.at(-1)!,
    above50ns: sorted.filter(value => value > 50).length };
}
function register(directory: string) {
  if (existsSync(directory)) throw new Error('campaign directory already exists');
  mkdirSync(directory, { recursive: true });
  const pre = {
    format: 'aether.native-fallback-switch-preregistration/1',
    registeredAt: new Date().toISOString(),
    sourceHashes: hashes(),
    compiler: command('clang', ['--version']).split('\n')[0],
    compilerFlags: ['-O3', '-std=c11', '-Wall', '-Wextra', '-Werror', '-fno-lto'],
    hardware: { architecture: command('uname', ['-m']),
      processor: process.platform === 'darwin' ? command('sysctl', ['-n', 'machdep.cpu.brand_string']) : command('uname', ['-p']),
      os: command('uname', ['-srm']) },
    experiment: {
      profile: 'bounded pure record-reference fallback; actual Tier 1 fault, whole-frame state and allocator rollback, alias-preserving Tier 2 execution',
      comparison: '12 native cases against FallbackTreeRuntime with the existing Aether AST fixture',
      bound: '50 ns maximum within the active frame; raw individual brackets, no timer-overhead subtraction',
      switchStart: 'immediately before volatile Tier 1 fault-marker check, after speculative Tier 1 mutation',
      switchEnd: 'first instruction of noinline Tier 2 body, after frame restoration, grant check and call transfer',
      excludedFromSwitch: ['Tier 1 speculative body before detection', 'Tier 2 body after entry', 'durable journal', 'proof verification', 'external effects'],
      warmup: 10000, trials: 5, samplesPerTrial: 2000,
      workload: 'aliased record argument; Tier 1 allocates ID 2, writes 99 and faults; rollback; Tier 2 allocates ID 2, increments record and validates contract',
      differentialCases: cases,
    },
  };
  writeFileSync(join(directory, 'preregistration.json'), JSON.stringify(pre, null, 2) + '\n', { flag: 'wx' });
  process.stdout.write(`${join(directory, 'preregistration.json')}\n`);
}
function run(directory: string) {
  const preregPath = join(directory, 'preregistration.json');
  const pre = JSON.parse(readFileSync(preregPath, 'utf8'));
  if (pre.format !== 'aether.native-fallback-switch-preregistration/1'
      || JSON.stringify(pre.sourceHashes) !== JSON.stringify(hashes()))
    throw new Error('source pins drifted after preregistration');
  if (existsSync(join(directory, 'report.json')) || existsSync(join(directory, 'raw.jsonl')))
    throw new Error('campaign already executed');
  const binary = join(directory, 'native-switch');
  const assembly = join(directory, 'native-switch.s');
  const base = ['-O3', '-std=c11', '-Wall', '-Wextra', '-Werror', '-fno-lto'];
  command('clang', [...base, '-o', binary, join(here, 'switch.c')]);
  command('clang', [...base, '-S', '-o', assembly, join(here, 'switch.c')]);
  const compiledAt = new Date().toISOString();
  const compared = differential(binary);
  writeFileSync(join(directory, 'differential.json'), JSON.stringify({ cases: compared }, null, 2) + '\n', { flag: 'wx' });
  const startedAt = new Date().toISOString();
  const raw = command(binary, ['--benchmark', '10000', '5', '2000']) + '\n';
  writeFileSync(join(directory, 'raw.jsonl'), raw, { flag: 'wx' });
  const lines = raw.trimEnd().split('\n').map(line => JSON.parse(line));
  const meta = lines.shift();
  assert.equal(meta.kind, 'metadata');
  assert.equal(meta.warmup, 10000); assert.equal(meta.trials, 5); assert.equal(meta.samplesPerTrial, 2000);
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
  const report = {
    format: 'aether.native-fallback-switch-report/1',
    preregistrationSha256: sha(readFileSync(preregPath)),
    sourceHashes: hashes(), compiledAt, startedAt, finishedAt: new Date().toISOString(),
    binarySha256: sha(readFileSync(binary)), assemblySha256: sha(readFileSync(assembly)),
    differentialSha256: sha(readFileSync(join(directory, 'differential.json'))),
    rawSha256: sha(readFileSync(join(directory, 'raw.jsonl'))),
    differentialCases: compared.length, clock: meta.clock, tickNs: meta.tickNs,
    summary, byTrial,
    verdict: summary.switch.max > 50 ? 'miss' : 'inconclusive',
    qualification: 'Research only: bounded manually lowered state, no Aether native compiler/guest runtime, durable journal, proof, effects, broader state, or statistically defensible hard maximum; clock quantization and observer overhead are retained.',
  };
  writeFileSync(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  process.stdout.write(`${JSON.stringify({ report: join(directory, 'report.json'), verdict: report.verdict, switch: summary.switch, full: summary.full }, null, 2)}\n`);
}
const [action, path] = process.argv.slice(2);
if (!path || !['register', 'run'].includes(action)) throw new Error('usage: campaign.ts register|run <new-directory>');
if (action === 'register') register(resolve(path)); else run(resolve(path));
