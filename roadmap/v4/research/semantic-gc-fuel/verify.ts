/** Independent process rerun of the bounded reference-runtime counterexample. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('./baseline.ts', import.meta.url));
const retained = fileURLToPath(new URL('./baseline-results.json', import.meta.url));
const expected = readFileSync(retained);
const actual = execFileSync(process.execPath, ['--experimental-strip-types', source]);
assert.deepEqual(actual, expected, 'retained raw baseline differs from a fresh reference-runtime run');
const data = JSON.parse(actual.toString()) as {
  format: string;
  sourceRoot: string;
  candidateRoot: string;
  observations: Array<{ maxSteps: number;
    source: { ok: boolean; fault: string | null; effects: string[]; steps: number };
    redirected: { ok: boolean; fault: string | null; effects: string[]; steps: number } }>;
  sourceTrace: Array<{ step: number; kind: string; depth: number }>;
  redirectedTrace: Array<{ step: number; kind: string; depth: number }>;
};
assert.equal(data.format, 'aether.gc-fuel-baseline/1');
assert.notEqual(data.sourceRoot, data.candidateRoot);
assert.deepEqual(data.observations.map(row => row.maxSteps),
  Array.from({ length: 32 }, (_, index) => index + 1));
for (const budget of [11, 12]) {
  const row = data.observations[budget - 1];
  assert.equal(row.source.fault, 'step_budget');
  assert.equal(row.source.effects.length, 0);
  assert.deepEqual(row.redirected.effects, ['4']);
}
for (const budget of [13, 14]) {
  const row = data.observations[budget - 1];
  assert.equal(row.source.fault, 'step_budget');
  assert.equal(row.redirected.ok, true);
}
assert.equal(data.observations[31].source.steps, 17);
assert.equal(data.observations[31].redirected.steps, 13);
assert.ok(data.sourceTrace.some(event => event.kind === 'call' && event.depth === 3));
assert.ok(!data.redirectedTrace.some(event => event.kind === 'call' && event.depth === 3));
process.stdout.write(JSON.stringify({ verified: true, cases: data.observations.length,
  sourceRoot: data.sourceRoot, candidateRoot: data.candidateRoot,
  observedEffectDivergenceBudgets: [11, 12],
  observedSuccessDivergenceBudgets: [13, 14],
  sourceSteps: 17, redirectedSteps: 13 }) + '\n');
