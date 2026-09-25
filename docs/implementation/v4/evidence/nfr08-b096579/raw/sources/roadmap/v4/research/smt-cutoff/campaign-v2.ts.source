/** Preregistered multi-shape hard-cutoff campaign. This is a measured research
 * profile, not a universal scheduling or release guarantee. */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { arch, cpus, platform, release } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as s from '../../../../src/tier2/smt.ts';
import { proveWithHardCutoff, V4_SMT_HARD_CUTOFF_MS } from '../../../../src/tier2/hard-solver.ts';
import { verifyFunction } from '../../../../src/tier2/verify.ts';
import { SymbolSpace } from '../../../../src/tier1/symbols.ts';
import * as b from '../../../../src/tier1/build.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const profile = { format: 'aether.smt-cutoff-campaign/2', maximumMs: V4_SMT_HARD_CUTOFF_MS,
  warmups: 1, trials: 5, cases: [
    { id: 'boolean-tautology/1', expected: 'unsat' },
    { id: 'linear-valid/1', expected: 'unsat' },
    { id: 'linear-counterexample/1', expected: 'sat' },
    { id: 'wide-boolean/1', expected: 'unsat' },
    { id: 'actual-function/1', expected: 'proved' },
    { id: 'pigeonhole-hard/1', expected: 'unknown/timeout' },
  ] } as const;
type CaseId = typeof profile.cases[number]['id'];
type Sample = { caseId: CaseId; trial: number; elapsedNs: string; innerElapsedMs: number; status: string;
  reason: string | null; model: readonly (readonly [string, string, string])[] | null; modelValid: boolean | null; pass: boolean };
const sha = (value: Uint8Array | string): string => createHash('sha256').update(value).digest('hex');
const sync = (directory: string): void => { const fd = openSync(directory, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } };
const write = (path: string, value: unknown): void => {
  const fd = openSync(path, 'wx', 0o600);
  try { writeFileSync(fd, typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
  sync(dirname(path));
};
const sourcePaths = (): string[] => execFileSync('git', ['ls-files', '-z', '--', 'src', 'package.json', 'package-lock.json',
  'roadmap/v4/research/smt-cutoff/campaign-v2.ts'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean).sort();
const pins = (): Record<string, string> => Object.fromEntries(sourcePaths().map(path => [path, sha(readFileSync(join(root, path)))]));

function formula(id: CaseId): s.SmtFormula {
  const x = s.intVar('x'), y = s.intVar('y');
  if (id === 'boolean-tautology/1') return s.or(s.boolVar('p'), s.not(s.boolVar('p')));
  if (id === 'linear-valid/1') return s.implies(s.and(s.ge(x, s.num(2)), s.ge(y, s.num(3))), s.ge(s.add(x, y), s.num(5)));
  if (id === 'linear-counterexample/1') return s.implies(s.ge(x, s.num(1)), s.ge(x, s.num(2)));
  if (id === 'wide-boolean/1') return s.or(s.boolVar('p'), s.not(s.boolVar('p')),
    ...Array.from({ length: 4094 }, (_, index) => s.boolVar(`q${index}`)));
  if (id !== 'pigeonhole-hard/1') throw new Error('formula case mismatch');
  const pigeons = 9, holes = 8, clauses: s.SmtFormula[] = [], slot = (pigeon: number, hole: number) => s.boolVar(`p${pigeon}_${hole}`);
  for (let pigeon = 0; pigeon < pigeons; pigeon++) clauses.push(s.or(...Array.from({ length: holes }, (_, hole) => slot(pigeon, hole))));
  for (let hole = 0; hole < holes; hole++) for (let left = 0; left < pigeons; left++) for (let right = left + 1; right < pigeons; right++) {
    clauses.push(s.or(s.not(slot(left, hole)), s.not(slot(right, hole))));
  }
  if (clauses.length !== 297) throw new Error('hard query changed');
  return s.not(s.and(...clauses));
}
function observe(item: typeof profile.cases[number], trial: number): Sample {
  const started = process.hrtime.bigint();
  let status: string, reason: string | null = null, innerElapsedMs: number, model: Sample['model'] = null, modelValid: boolean | null = null;
  if (item.id === 'actual-function/1') {
    const symbols = new SymbolSpace('smt-cutoff-campaign-v2'), entry = symbols.define('entry');
    const declaration = b.fn({ symbol: entry, returns: b.Int, contract: b.contract({ ensures: [b.clause(b.eq(b.result(), b.int(1)), 'exact-one')] }), body: b.ret(b.int(1)) });
    const report = verifyFunction(declaration, { solverProfile: 'v4-hard/1' });
    status = report.verdict; innerElapsedMs = report.elapsedMs;
  } else {
    const query = formula(item.id), result = proveWithHardCutoff(query);
    status = result.status; reason = result.reason ?? null; innerElapsedMs = result.elapsedMs;
    if (result.status === 'sat') {
      modelValid = result.model !== undefined && s.evaluate(query, result.model) === false;
      model = result.model ? Object.entries(result.model).sort(([a], [b]) => a.localeCompare(b))
        .map(([name, value]) => [name, typeof value === 'bigint' ? 'int' : 'bool', String(value)] as const) : null;
    }
  }
  const elapsedNs = String(process.hrtime.bigint() - started), observed = status === 'unknown' && reason === 'timeout' ? 'unknown/timeout' : status;
  return { caseId: item.id, trial, elapsedNs, innerElapsedMs, status, reason, model, modelValid,
    pass: BigInt(elapsedNs) <= BigInt(profile.maximumMs) * 1_000_000n && observed === item.expected && (status !== 'sat' || modelValid === true) };
}
function summary(samples: readonly Sample[]) {
  const values = samples.map(sample => Number(BigInt(sample.elapsedNs)) / 1e6).sort((a, b) => a - b);
  const percentile = (value: number) => values[Math.max(0, Math.ceil(value * values.length) - 1)];
  return { count: values.length, p50Ms: percentile(0.50), p95Ms: percentile(0.95), p99Ms: percentile(0.99), maximumMs: values.at(-1)!, pass: samples.every(sample => sample.pass) };
}
const [mode, supplied] = process.argv.slice(2);
if (!['--register', '--run', '--verify'].includes(mode) || !supplied) throw new Error('usage: campaign-v2.ts --register|--run|--verify OUTPUT_DIRECTORY');
const output = resolve(supplied), profileDigest = sha(JSON.stringify(profile));
if (mode === '--register') {
  if (existsSync(output)) throw new Error('campaign output already exists');
  const gitHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const gitStatus = execFileSync('git', ['status', '--short'], { cwd: root, encoding: 'utf8' }).trim();
  if (gitStatus) throw new Error('campaign registration requires a clean source tree');
  const sourceHashes = pins(); mkdirSync(output, { recursive: true });
  for (const path of Object.keys(sourceHashes)) {
    const target = join(output, 'sources', `${path}.source`); mkdirSync(dirname(target), { recursive: true }); write(target, readFileSync(join(root, path)).toString());
  }
  write(join(output, 'registration.json'), { format: profile.format, profile, profileDigest, sourceHashes, gitHead, gitStatus,
    at: new Date().toISOString(), environment: { platform: platform(), arch: arch(), release: release(), node: process.version,
      cpu: cpus()[0]?.model, logicalCpus: cpus().length } });
  console.log(`registered ${output}`);
} else {
  const registration = JSON.parse(readFileSync(join(output, 'registration.json'), 'utf8')) as {
    format: string; profile: typeof profile; profileDigest: string; sourceHashes: Record<string, string>; gitHead: string; gitStatus: string };
  if (registration.format !== profile.format || registration.profileDigest !== profileDigest
    || sha(JSON.stringify(registration.profile)) !== profileDigest || registration.gitStatus !== '') throw new Error('campaign profile/registration mismatch');
  if (JSON.stringify(Object.keys(registration.sourceHashes)) !== JSON.stringify(sourcePaths())) throw new Error('incomplete campaign source pin set');
  for (const [path, expected] of Object.entries(registration.sourceHashes)) {
    if (sha(readFileSync(join(output, 'sources', `${path}.source`))) !== expected) throw new Error(`source snapshot changed: ${path}`);
  }
  if (mode === '--run') {
    if (registration.gitHead !== execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
      || JSON.stringify(registration.sourceHashes) !== JSON.stringify(pins())) throw new Error('campaign source changed after preregistration');
    if (existsSync(join(output, 'results.json'))) throw new Error('completed campaign cannot be overwritten');
    const warmups: Sample[] = [], samples: Sample[] = [];
    for (const item of profile.cases) {
      const safe = item.id.replace(/[^a-z0-9]+/g, '-');
      for (let trial = -profile.warmups; trial < profile.trials; trial++) {
        const sample = observe(item, trial);
        write(join(output, `${safe}-${trial < 0 ? `warmup-${-trial}` : `trial-${trial}`}.json`), sample);
        (trial < 0 ? warmups : samples).push(sample);
      }
    }
    const byCase = profile.cases.map(item => ({ caseId: item.id, ...summary(samples.filter(sample => sample.caseId === item.id)) }));
    const result = { format: profile.format, profileDigest, warmups, samples, byCase, overall: summary(samples),
      pass: byCase.every(row => row.pass) };
    write(join(output, 'results.json'), result);
    console.log(JSON.stringify({ pass: result.pass, byCase, overall: result.overall }, null, 2));
  } else {
    const result = JSON.parse(readFileSync(join(output, 'results.json'), 'utf8')) as {
      format: string; profileDigest: string; warmups: Sample[]; samples: Sample[]; byCase: ReturnType<typeof summary>[];
      overall: ReturnType<typeof summary>; pass: boolean };
    if (result.format !== profile.format || result.profileDigest !== profileDigest
      || result.warmups.length !== profile.cases.length * profile.warmups || result.samples.length !== profile.cases.length * profile.trials)
      throw new Error('campaign result shape mismatch');
    for (const sample of [...result.warmups, ...result.samples]) {
      const item = profile.cases.find(row => row.id === sample.caseId); if (!item) throw new Error('unknown case');
      const safe = item.id.replace(/[^a-z0-9]+/g, '-'), name = `${safe}-${sample.trial < 0 ? `warmup-${-sample.trial}` : `trial-${sample.trial}`}.json`;
      if (!Number.isFinite(sample.innerElapsedMs) || sample.innerElapsedMs < 0 || !/^(0|[1-9][0-9]*)$/.test(sample.elapsedNs))
        throw new Error(`invalid wall-time sample: ${name}`);
      if (sample.status === 'sat') {
        if (!sample.model || item.id === 'actual-function/1') throw new Error(`missing SMT counterexample: ${name}`);
        const values: Record<string, bigint | boolean> = Object.create(null);
        for (const [key, sort, encoded] of sample.model) {
          if (Object.hasOwn(values, key)) throw new Error(`duplicate SMT model key: ${name}`);
          if (sort === 'int' && /^-?(0|[1-9][0-9]*)$/.test(encoded)) values[key] = BigInt(encoded);
          else if (sort === 'bool' && (encoded === 'true' || encoded === 'false')) values[key] = encoded === 'true';
          else throw new Error(`invalid SMT model value: ${name}`);
        }
        if (sample.modelValid !== (s.evaluate(formula(item.id), values) === false)) throw new Error(`false SMT model check: ${name}`);
      } else if (sample.model !== null || sample.modelValid !== null) throw new Error(`unexpected SMT model: ${name}`);
      if (JSON.stringify(JSON.parse(readFileSync(join(output, name), 'utf8'))) !== JSON.stringify(sample)
        || sample.pass !== (BigInt(sample.elapsedNs) <= BigInt(profile.maximumMs) * 1_000_000n
          && (sample.status === 'unknown' && sample.reason === 'timeout' ? 'unknown/timeout' : sample.status) === item.expected
          && (sample.status !== 'sat' || sample.modelValid === true))) throw new Error(`raw SMT sample mismatch: ${name}`);
    }
    const byCase = profile.cases.map(item => ({ caseId: item.id, ...summary(result.samples.filter(sample => sample.caseId === item.id)) }));
    if (JSON.stringify(byCase) !== JSON.stringify(result.byCase) || JSON.stringify(summary(result.samples)) !== JSON.stringify(result.overall)
      || result.pass !== byCase.every(row => row.pass)) throw new Error('SMT campaign summary mismatch');
    console.log(JSON.stringify({ verified: true, pass: result.pass, byCase, overall: result.overall }, null, 2));
  }
}
