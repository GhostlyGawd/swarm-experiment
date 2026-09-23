import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as s from '../../src/tier2/smt.ts';
import { proveWithHardCutoff, V4_SMT_HARD_CUTOFF_MS } from '../../src/tier2/hard-solver.ts';
import { verifyFunction } from '../../src/tier2/verify.ts';
import { SymbolSpace } from '../../src/tier1/symbols.ts';
import * as b from '../../src/tier1/build.ts';

test('v4 isolated SMT path returns exact easy proofs and independently checked counterexamples', () => {
  const tautology = s.or(s.boolVar('p'), s.not(s.boolVar('p')));
  const valid = proveWithHardCutoff(tautology);
  assert.equal(valid.status, 'unsat'); assert.ok(valid.elapsedMs < V4_SMT_HARD_CUTOFF_MS);
  const formula = s.implies(s.ge(s.intVar('x'), s.num(1)), s.ge(s.intVar('x'), s.num(2)));
  const counterexample = proveWithHardCutoff(formula);
  assert.equal(counterexample.status, 'sat'); assert.ok(counterexample.model);
  assert.equal(s.evaluate(formula, counterexample.model!), false);
  assert.ok(counterexample.elapsedMs < V4_SMT_HARD_CUTOFF_MS);
});

test('short v4 deadline kills a child before it can return an unchecked answer', () => {
  const result = proveWithHardCutoff(s.eq(s.intVar('x'), s.num(3)), 50);
  assert.equal(result.status, 'unknown'); assert.equal(result.reason, 'timeout');
  assert.ok(result.elapsedMs < V4_SMT_HARD_CUTOFF_MS, `actual wall time ${result.elapsedMs}`);
});

test('an actual hard unsatisfiable query is cancelled without fabricating a proof', () => {
  const pigeons = 9, holes = pigeons - 1, clauses: s.SmtFormula[] = [];
  const inHole = (pigeon: number, hole: number) => s.boolVar(`p${pigeon}_${hole}`);
  for (let pigeon = 0; pigeon < pigeons; pigeon++) clauses.push(s.or(...Array.from({ length: holes }, (_, hole) => inHole(pigeon, hole))));
  for (let hole = 0; hole < holes; hole++) for (let left = 0; left < pigeons; left++) for (let right = left + 1; right < pigeons; right++) {
    clauses.push(s.or(s.not(inHole(left, hole)), s.not(inHole(right, hole))));
  }
  const result = proveWithHardCutoff(s.not(s.and(...clauses)), 150);
  assert.equal(result.status, 'unknown'); assert.equal(result.reason, 'timeout');
});

test('bounded input validation rejects cycles, accessors, bad scalars and oversized literals before spawning', () => {
  const cyclic: { k: 'not'; arg?: unknown } = { k: 'not' }; cyclic.arg = cyclic;
  assert.throws(() => proveWithHardCutoff(cyclic as s.SmtFormula), /cyclic/);
  let invoked = false;
  const getter = Object.defineProperty({}, 'k', { get() { invoked = true; return 'true'; }, enumerable: true });
  assert.throws(() => proveWithHardCutoff(getter as s.SmtFormula), /tag/); assert.equal(invoked, false);
  assert.throws(() => proveWithHardCutoff(s.eq(s.num(10n ** 129n), s.num(0))), /integer/);
  assert.throws(() => proveWithHardCutoff(s.boolVar('p'), 1501), /cutoff/);
});

test('opt-in v4 function verification uses the process cutoff and refuses a wider budget', () => {
  const symbols = new SymbolSpace('hard-verifier'), entry = symbols.define('entry');
  const declaration = b.fn({ symbol: entry, returns: b.Int, contract: b.contract({ ensures: [b.clause(b.eq(b.result(), b.int(1)), 'exact-one')] }), body: b.ret(b.int(1)) });
  const report = verifyFunction(declaration, { solverProfile: 'v4-hard/1' });
  assert.equal(report.verdict, 'proved'); assert.ok(report.elapsedMs < V4_SMT_HARD_CUTOFF_MS);
  assert.throws(() => verifyFunction(declaration, { solverProfile: 'v4-hard/1', budgetMs: 1501 }), /hard solver budget/);
});
