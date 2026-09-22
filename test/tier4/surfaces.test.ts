import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyTuning, domainValues, findSurfaces, tune, verifyOnlyParametersChanged,
  type Assignment, type Measurement, type Objective,
} from '../../src/tier4/surfaces.ts';
import { GraphStore } from '../../src/tier1/store.ts';
import { buildLedgerExample } from '../../src/examples/ledger.ts';
import { verifyFunction } from '../../src/tier2/verify.ts';
import { simulateModule } from '../../src/tier3/microworld.ts';
import type { Term } from '../../src/tier1/ast.ts';
import type { SymbolId } from '../../src/tier1/ids.ts';

/**
 * A stand-in for production telemetry: latency is convex in batch size with a
 * minimum at 24, and the cache policies differ by a constant. The tuner never
 * sees this function, only the measurements it returns.
 */
function objective(ex: ReturnType<typeof buildLedgerExample>): Objective & { calls: number } {
  const policyPenalty: Record<string, number> = { none: 40, lru: 12, lfu: 18, arc: 9 };
  const self = {
    calls: 0,
    measure(assignment: Assignment): Measurement {
      self.calls++;
      const batch = Number(assignment.get(ex.symbols.batchSize) ?? 8n);
      const policy = String(assignment.get(ex.symbols.cachePolicy) ?? 'none');
      const latency = (batch - 24) ** 2 / 12 + 30 + (policyPenalty[policy] ?? 40);
      return { latencyMs: latency, costPerMonth: 20 + batch * 0.4, memoryMb: 32 + batch * 2 };
    },
  };
  return self;
}

function surfacesOf(ex: ReturnType<typeof buildLedgerExample>) {
  const store = new GraphStore();
  const root = store.intern(ex.module);
  return { store, root, surfaces: findSurfaces(store, root) };
}

test('surfaces are found with the path needed to rewrite them', () => {
  const ex = buildLedgerExample();
  const { surfaces } = surfacesOf(ex);
  const names = surfaces.map((s) => ex.syms.nameOf(s.symbol)).sort();
  assert.deepEqual(names, ['batchSize', 'cachePolicy']);
  for (const s of surfaces) assert.ok(s.path.length > 0, 'every surface has a path from the root');
});

test('a domain enumerates exactly what the author allowed', () => {
  const ex = buildLedgerExample();
  const { surfaces } = surfacesOf(ex);
  const batch = surfaces.find((s) => ex.syms.nameOf(s.symbol) === 'batchSize')!;
  const values = domainValues(batch.node);
  assert.equal(values[0], 1n);
  assert.equal(values[values.length - 1], 64n);
  assert.equal(values.length, 64);

  const cache = surfaces.find((s) => ex.syms.nameOf(s.symbol) === 'cachePolicy')!;
  assert.deepEqual(domainValues(cache.node), ['lru', 'lfu', 'arc', 'none']);
});

test('FR-4.2: tuning descends a measured objective it cannot see into', () => {
  const ex = buildLedgerExample();
  const { surfaces } = surfacesOf(ex);
  const model = objective(ex);
  const result = tune(surfaces, model, { maxEvaluations: 200 });

  assert.ok(result.improvement > 0.4, `improvement was ${(result.improvement * 100).toFixed(1)}%`);
  // The optimum is batchSize=24 (grid minimum) and the cheapest policy, arc.
  assert.equal(result.after.get(ex.symbols.batchSize), 24n);
  assert.equal(result.after.get(ex.symbols.cachePolicy), 'arc');
  assert.ok(result.converged);
  assert.ok(result.evaluations <= 200, 'stayed inside the evaluation budget');
  assert.ok(result.tuned.latencyMs < result.baseline.latencyMs);
});

test('the evaluation budget is a hard ceiling, because measurements cost traffic', () => {
  const ex = buildLedgerExample();
  const { surfaces } = surfacesOf(ex);
  const model = objective(ex);
  const result = tune(surfaces, model, { maxEvaluations: 6 });
  assert.ok(model.calls <= 6, `made ${model.calls} measurements`);
  assert.ok(result.evaluations <= 6);
});

test('a gradient is recorded for range surfaces and not invented for choices', () => {
  const ex = buildLedgerExample();
  const { surfaces } = surfacesOf(ex);
  const result = tune(surfaces, objective(ex));
  const batchSteps = result.history.filter((h) => h.symbol === ex.symbols.batchSize);
  const cacheSteps = result.history.filter((h) => h.symbol === ex.symbols.cachePolicy);
  assert.ok(batchSteps.length > 0 && batchSteps.every((h) => h.gradient !== null));
  assert.ok(cacheSteps.length > 0 && cacheSteps.every((h) => h.gradient === null));
});

test('FR-4.2: applying a tuning rewrites parameters and nothing else', () => {
  const ex = buildLedgerExample();
  const { store, root, surfaces } = surfacesOf(ex);
  const result = tune(surfaces, objective(ex));
  const applied = applyTuning(store, root, result.after);

  assert.notEqual(applied.root, root);
  const audit = verifyOnlyParametersChanged(store, root, applied.root);
  assert.ok(audit.ok, `tuner overstepped: ${audit.offending.join(', ')}`);

  // The new values really are in the graph.
  const after = findSurfaces(store, applied.root);
  const batch = after.find((s) => s.symbol === ex.symbols.batchSize)!;
  assert.equal(batch.node.current, 24n);

  // Sibling subtrees keep their addresses, so cached results stay warm.
  const shared = [...store.reachable(applied.root)].filter((r) => store.reachable(root).has(r));
  assert.ok(shared.length > 100, `${shared.length} nodes were reused unchanged`);
});

test('a tuned module still verifies and still passes its micro-worlds', () => {
  const ex = buildLedgerExample();
  const { store, root, surfaces } = surfacesOf(ex);
  const applied = applyTuning(store, root, tune(surfaces, objective(ex)).after);
  const tuned = store.hydrate(applied.root);

  const env = new Map<SymbolId, Term>();
  for (const m of (tuned as Extract<Term, { kind: 'Module' }>).members) {
    if (m.kind === 'FunctionDecl') env.set(m.symbol, m);
  }
  for (const m of (tuned as Extract<Term, { kind: 'Module' }>).members) {
    if (m.kind !== 'FunctionDecl') continue;
    const report = verifyFunction(m, { symbols: ex.syms, environment: env });
    assert.notEqual(report.verdict, 'refuted', `${ex.syms.nameOf(m.symbol)} broke under tuning`);
  }
  for (const report of simulateModule(tuned, {
    registry: ex.capabilities, symbols: ex.syms, seed: 'tuned',
  })) {
    assert.ok(report.accepted, `${ex.syms.nameOf(report.symbol)} failed after tuning`);
  }
});

test('an objective with no better configuration converges without changing anything', () => {
  const ex = buildLedgerExample();
  const { store, root, surfaces } = surfacesOf(ex);
  const flat: Objective = { measure: () => ({ latencyMs: 10, costPerMonth: 10, memoryMb: 10 }) };
  const result = tune(surfaces, flat);
  assert.equal(result.improvement, 0);
  assert.ok(result.converged);
  assert.deepEqual([...result.after], [...result.before]);
  assert.equal(applyTuning(store, root, result.after).unchanged, true);
});

test('the tuner optimizes each surface for the objective it declares', () => {
  const ex = buildLedgerExample();
  const { surfaces } = surfacesOf(ex);
  // Both surfaces in the example minimize latency, so both should move when
  // only latency improves, and neither when only cost does.
  const latencyOnly: Objective = {
    measure: (a) => ({
      latencyMs: Number(a.get(ex.symbols.batchSize) ?? 8n),
      costPerMonth: 100 - Number(a.get(ex.symbols.batchSize) ?? 8n),
      memoryMb: 1,
    }),
  };
  const result = tune(surfaces, latencyOnly);
  assert.equal(result.after.get(ex.symbols.batchSize), 1n, 'drove latency to its minimum');
  assert.ok(result.tuned.costPerMonth > result.baseline.costPerMonth,
    'and accepted the cost, because latency is what it was told to minimize');
});
