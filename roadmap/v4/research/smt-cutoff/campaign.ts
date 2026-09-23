/** Preregistered NFR-08 process cutoff experiment. Exploratory runs go in a
 * new directory; source changes invalidate a registered measurement. */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { arch, cpus, platform, release } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as s from '../../../../src/tier2/smt.ts';
import { proveWithHardCutoff, V4_SMT_HARD_CUTOFF_MS } from '../../../../src/tier2/hard-solver.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const sources = ['roadmap/v4/research/smt-cutoff/campaign.ts', 'src/tier2/hard-solver.ts', 'src/tier2/solver.ts', 'src/tier2/smt.ts', 'src/fabric/encoding.ts', 'package-lock.json'];
const profile = { format: 'aether.smt-cutoff-campaign/1', query: 'pigeonhole-9-into-8/1', warmups: 1, trials: 5, maximumMs: V4_SMT_HARD_CUTOFF_MS, requireHardCancellation: true } as const;
const sha = (value: Uint8Array | string): string => createHash('sha256').update(value).digest('hex');
const pins = (): Record<string, string> => Object.fromEntries(sources.map(path => [path, sha(readFileSync(join(root, path)))]));
const sync = (directory: string): void => { const fd = openSync(directory, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } };
const write = (path: string, value: unknown): void => {
  const fd = openSync(path, 'wx', 0o600);
  try { writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
  sync(dirname(path));
};
function query(): s.SmtFormula {
  const pigeons = 9, holes = 8, clauses: s.SmtFormula[] = [], slot = (pigeon: number, hole: number) => s.boolVar(`p${pigeon}_${hole}`);
  for (let pigeon = 0; pigeon < pigeons; pigeon++) clauses.push(s.or(...Array.from({ length: holes }, (_, hole) => slot(pigeon, hole))));
  for (let hole = 0; hole < holes; hole++) for (let left = 0; left < pigeons; left++) for (let right = left + 1; right < pigeons; right++) {
    clauses.push(s.or(s.not(slot(left, hole)), s.not(slot(right, hole))));
  }
  if (clauses.length !== 297) throw new Error('hard SMT workload changed');
  return s.not(s.and(...clauses));
}
function observe(trial: number) {
  const started = process.hrtime.bigint(), result = proveWithHardCutoff(query()), elapsedNs = String(process.hrtime.bigint() - started);
  return { trial, elapsedNs, solverElapsedMs: result.elapsedMs, status: result.status, reason: result.reason ?? null,
    pass: BigInt(elapsedNs) <= BigInt(profile.maximumMs) * 1_000_000n && result.status === 'unknown' && result.reason === 'timeout' };
}
const [mode, supplied] = process.argv.slice(2);
if (!['--register', '--run', '--verify'].includes(mode) || !supplied) throw new Error('usage: campaign.ts --register|--run|--verify NEW_OUTPUT_DIRECTORY');
const output = resolve(supplied), profileDigest = sha(JSON.stringify(profile));
if (mode === '--register') {
  if (existsSync(output)) throw new Error('SMT campaign output already exists');
  mkdirSync(output, { recursive: true });
  write(join(output, 'registration.json'), { format: profile.format, profile, profileDigest, sources: pins(), gitHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    gitStatus: execFileSync('git', ['status', '--short'], { cwd: root, encoding: 'utf8' }).trim(), at: new Date().toISOString(),
    environment: { platform: platform(), arch: arch(), release: release(), node: process.version, cpu: cpus()[0]?.model, logicalCpus: cpus().length } });
  console.log(`registered ${output}`);
} else {
  const registration = JSON.parse(readFileSync(join(output, 'registration.json'), 'utf8')) as { profile: typeof profile; profileDigest: string; sources: Record<string, string> };
  if (registration.profileDigest !== profileDigest || sha(JSON.stringify(registration.profile)) !== profileDigest || JSON.stringify(registration.sources) !== JSON.stringify(pins())) throw new Error('SMT campaign source/profile changed after registration');
  if (mode === '--run') {
    if (existsSync(join(output, 'results.json'))) throw new Error('completed SMT campaign cannot be overwritten');
    const warmup = observe(-1); write(join(output, 'warmup.json'), warmup);
    const samples = [];
    for (let trial = 0; trial < profile.trials; trial++) { const sample = observe(trial); write(join(output, `trial-${trial}.json`), sample); samples.push(sample); }
    const result = { format: profile.format, profileDigest, warmup, samples, pass: samples.every(sample => sample.pass),
      maximumObservedMs: Math.max(...samples.map(sample => Number(BigInt(sample.elapsedNs)) / 1e6)), requiredMaximumMs: profile.maximumMs };
    write(join(output, 'results.json'), result); console.log(JSON.stringify({ pass: result.pass, maximumObservedMs: result.maximumObservedMs, samples }, null, 2));
  } else {
    const result = JSON.parse(readFileSync(join(output, 'results.json'), 'utf8')) as { format: string; profileDigest: string; warmup: ReturnType<typeof observe>; samples: ReturnType<typeof observe>[]; pass: boolean; maximumObservedMs: number; requiredMaximumMs: number };
    if (result.format !== profile.format || result.profileDigest !== profileDigest || result.samples.length !== profile.trials || result.requiredMaximumMs !== profile.maximumMs) throw new Error('SMT campaign summary mismatch');
    const warmup = JSON.parse(readFileSync(join(output, 'warmup.json'), 'utf8')); if (JSON.stringify(warmup) !== JSON.stringify(result.warmup) || warmup.trial !== -1) throw new Error('SMT warmup changed');
    for (const [trial, sample] of result.samples.entries()) {
      const raw = JSON.parse(readFileSync(join(output, `trial-${trial}.json`), 'utf8'));
      if (JSON.stringify(raw) !== JSON.stringify(sample) || sample.trial !== trial || sample.pass !== (BigInt(sample.elapsedNs) <= BigInt(profile.maximumMs) * 1_000_000n && sample.status === 'unknown' && sample.reason === 'timeout')) throw new Error('SMT raw trial/threshold mismatch');
    }
    if (result.pass !== result.samples.every(sample => sample.pass) || result.maximumObservedMs !== Math.max(...result.samples.map(sample => Number(BigInt(sample.elapsedNs)) / 1e6))) throw new Error('SMT summary arithmetic mismatch');
    console.log(JSON.stringify({ verified: true, pass: result.pass, trials: result.samples.length, maximumObservedMs: result.maximumObservedMs }));
  }
}
