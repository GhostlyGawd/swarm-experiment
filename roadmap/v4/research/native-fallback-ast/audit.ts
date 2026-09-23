/** Independent recount and source rebuild for a retained AST-native fallback campaign.
 * Historical timing is not rerun; every saved raw sample is recomputed. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildProgram, cases, differential, editWitness } from './verify.ts';
import { cleanSource, sourceHashes } from './campaign.ts';

const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
function readJson(path: string): any {
  const bytes = readFileSync(path, 'utf8'), value = JSON.parse(bytes);
  assert.equal(bytes, JSON.stringify(value, null, 2) + '\n', `noncanonical ${path}`);
  return value;
}
function stats(values: readonly number[]) {
  assert.ok(values.length && values.every(value => Number.isFinite(value) && value >= 0));
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p: number) => sorted[Math.ceil(p * sorted.length) - 1];
  return { count: values.length, min: sorted[0], p50: at(0.5), p95: at(0.95),
    p99: at(0.99), max: sorted.at(-1)!, above50ns: sorted.filter(value => value > 50).length };
}
export function audit(directory: string) {
  directory = resolve(directory);
  const pre = readJson(join(directory, 'preregistration.json'));
  const report = readJson(join(directory, 'report.json'));
  const recorded = readJson(join(directory, 'differential.json'));
  assert.equal(pre.format, 'aether.ast-native-fallback-preregistration/1');
  assert.equal(report.format, 'aether.ast-native-fallback-report/1');
  assert.equal(pre.commit, cleanSource());
  assert.deepEqual(pre.sourceHashes, sourceHashes());
  assert.deepEqual(report.sourceHashes, sourceHashes());
  assert.equal(report.commit, pre.commit);
  assert.deepEqual(pre.experiment.differentialCases, cases);
  assert.equal(report.preregistrationSha256, sha(readFileSync(join(directory, 'preregistration.json'))));
  assert.equal(report.differentialSha256, sha(readFileSync(join(directory, 'differential.json'))));
  assert.equal(report.rawSha256, sha(readFileSync(join(directory, 'raw.jsonl'))));
  const rebuild = mkdtempSync(join(tmpdir(), 'aether-native-fallback-audit-'));
  try {
    const programs = new Map((['primary', 'fallback', 'abort'] as const).map(mode =>
      [mode, buildProgram(rebuild, mode)] as const));
    const compared = differential(programs), edited = editWitness(rebuild, programs.get('fallback')!);
    assert.deepEqual(recorded, { cases: compared, edited });
    assert.equal(report.differentialCases, compared.length);
    assert.equal(report.editWitness.editedRoot, edited.editedRoot);
    assert.equal(report.editWitness.changedBinary, true);
    const expectedPrograms = [...programs.values()].map(program => ({ mode: program.mode,
      root: program.lowered.root, manifestDigest: program.lowered.manifestDigest,
      sourceSha256: program.lowered.sourceSha256, binarySha256: program.binarySha256,
      assemblySha256: program.assemblySha256 })).concat([{ mode: 'edited', ...edited.editedProgram }]);
    assert.deepEqual(report.programs, expectedPrograms);
    for (const program of report.programs) {
      const path = join(directory, program.mode);
      assert.equal(sha(readFileSync(join(path, 'generated.h'))), program.sourceSha256);
      assert.equal(sha(readFileSync(join(path, 'native-fallback'))), program.binarySha256);
      assert.equal(sha(readFileSync(join(path, 'native-fallback.s'))), program.assemblySha256);
    }
  } finally { rmSync(rebuild, { recursive: true, force: true }); }
  const raw = readFileSync(join(directory, 'raw.jsonl'), 'utf8');
  assert.ok(raw.endsWith('\n'));
  const lines = raw.trimEnd().split('\n').map(line => JSON.parse(line));
  const meta = lines.shift();
  assert.equal(meta.kind, 'metadata');
  assert.equal(meta.warmup, 10000); assert.equal(meta.trials, 5); assert.equal(meta.samplesPerTrial, 2000);
  assert.equal(lines.length, 10000);
  assert.equal(report.clock, meta.clock); assert.equal(report.tickNs, meta.tickNs);
  const all = { switch: [] as number[], full: [] as number[], timerPair: [] as number[] };
  const byTrial = [];
  for (let trial = 0; trial < 5; trial++) {
    const trialValues = { switch: [] as number[], full: [] as number[], timerPair: [] as number[] };
    for (let index = 0; index < 2000; index++) {
      const row = lines[trial * 2000 + index];
      assert.equal(row.kind, 'sample'); assert.equal(row.trial, trial); assert.equal(row.index, index);
      for (const [name, field] of [['switch', 'switchTicks'], ['full', 'fullTicks'], ['timerPair', 'timerPairTicks']] as const) {
        assert.ok(Number.isSafeInteger(row[field]) && row[field] >= 0);
        const ns = row[field] * meta.tickNs;
        trialValues[name].push(ns); all[name].push(ns);
      }
    }
    byTrial.push(Object.fromEntries(Object.entries(trialValues).map(([name, values]) => [name, stats(values)])));
  }
  const summary = Object.fromEntries(Object.entries(all).map(([name, values]) => [name, stats(values)]));
  assert.deepEqual(report.byTrial, byTrial);
  assert.deepEqual(report.summary, summary);
  assert.equal(report.verdict, summary.switch.max > 50 ? 'miss' : 'inconclusive');
  return { format: 'aether.ast-native-fallback-audit/1', sourceCommit: pre.commit,
    differentialCases: recorded.cases.length, rawSamples: lines.length,
    maxSwitchNs: summary.switch.max, verdict: report.verdict, pass: true };
}
const path = process.argv[2];
if (path) {
  const result = audit(path);
  const output = join(resolve(path), 'audit.json');
  writeFileSync(output, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
  process.stdout.write(`${output}\n`);
}
