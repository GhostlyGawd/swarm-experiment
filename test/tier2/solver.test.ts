import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CapabilityEnvelope } from '../../src/tier2/ocap.ts';
import { SMT_SOLVER_PROCESS, proveWithExternalFallback } from '../../src/tier2/external-solver.ts';
import { checkSat, prove } from '../../src/tier2/solver.ts';
import * as s from '../../src/tier2/smt.ts';

const x = s.intVar('x');
const y = s.intVar('y');
const z = s.intVar('z');

test('propositional reasoning', () => {
  assert.equal(prove(s.or(s.boolVar('p'), s.not(s.boolVar('p')))).status, 'unsat', 'p ∨ ¬p is valid');
  assert.equal(prove(s.boolVar('p')).status, 'sat', 'a bare variable is not valid');
  assert.equal(checkSat(s.and(s.boolVar('p'), s.not(s.boolVar('p')))).status, 'unsat');
  assert.equal(
    prove(s.implies(s.and(s.implies(s.boolVar('p'), s.boolVar('q')), s.boolVar('p')), s.boolVar('q'))).status,
    'unsat',
    'modus ponens',
  );
});

test('linear arithmetic: valid implications are proved', () => {
  // x >= 0 ∧ y >= 0 → x + y >= 0
  assert.equal(
    prove(s.implies(s.and(s.ge(x, s.num(0)), s.ge(y, s.num(0))), s.ge(s.add(x, y), s.num(0)))).status,
    'unsat',
  );
  // x > y ∧ y > z → x > z
  assert.equal(
    prove(s.implies(s.and(s.gt(x, y), s.gt(y, z)), s.gt(x, z))).status,
    'unsat',
  );
  // 2x = 6 → x = 3
  assert.equal(
    prove(s.implies(s.eq(s.mul(s.num(2), x), s.num(6)), s.eq(x, s.num(3)))).status,
    'unsat',
  );
});

test('linear arithmetic: invalid implications yield a runnable counterexample', () => {
  // x >= 0 → x >= 1 is false at x = 0.
  const r = prove(s.implies(s.ge(x, s.num(0)), s.ge(x, s.num(1))));
  assert.equal(r.status, 'sat');
  assert.ok(r.model, 'a counterexample was produced');
  // The model must actually falsify the claim, not merely be reported.
  assert.equal(s.evaluate(s.implies(s.ge(x, s.num(0)), s.ge(x, s.num(1))), r.model!), false);
});

test('integer tightening beats rational reasoning', () => {
  // Over the rationals x > 0 ∧ x < 1 is satisfiable; over the integers it is not.
  assert.equal(checkSat(s.and(s.gt(x, s.num(0)), s.lt(x, s.num(1)))).status, 'unsat');
  // 2x = 1 has no integer solution.
  assert.equal(checkSat(s.eq(s.mul(s.num(2), x), s.num(1))).status, 'unsat');
});

test('unsatisfiable conjunctions are detected', () => {
  assert.equal(checkSat(s.and(s.ge(x, s.num(5)), s.le(x, s.num(3)))).status, 'unsat');
  assert.equal(
    checkSat(s.and(s.ge(s.add(x, y), s.num(10)), s.le(x, s.num(2)), s.le(y, s.num(2)))).status,
    'unsat',
  );
});

test('satisfiable systems return a validated model', () => {
  const f = s.and(s.ge(x, s.num(3)), s.le(x, s.num(7)), s.eq(y, s.add(x, s.num(1))));
  const r = checkSat(f);
  assert.equal(r.status, 'sat');
  assert.ok(s.evaluate(f, r.model!));
  assert.ok((r.model!.x as bigint) >= 3n && (r.model!.x as bigint) <= 7n);
});

test('the PRD transfer contract is discharged', () => {
  const sb = s.intVar('sender.balance');
  const rb = s.intVar('receiver.balance');
  const amt = s.intVar('amount');
  const sb2 = s.sub(sb, amt);
  const rb2 = s.add(rb, amt);
  const pre = s.and(s.ge(sb, amt), s.gt(amt, s.num(0)));
  const post = s.and(
    s.eq(sb2, s.sub(sb, amt)),
    s.eq(rb2, s.add(rb, amt)),
    s.eq(s.add(sb2, rb2), s.add(sb, rb)), // conservation
  );
  assert.equal(prove(s.implies(pre, post)).status, 'unsat');
  // The sufficient-funds precondition is exactly what rules out an overdraft.
  assert.equal(prove(s.implies(pre, s.ge(sb2, s.num(0)))).status, 'unsat');
  const weakened = s.gt(amt, s.num(0)); // drop `sender.balance >= amount`
  const overdraft = prove(s.implies(weakened, s.ge(sb2, s.num(0))));
  assert.equal(overdraft.status, 'sat', 'dropping the precondition makes overdraft reachable');
  assert.equal(s.evaluate(s.implies(weakened, s.ge(sb2, s.num(0))), overdraft.model!), false);
});

test('nonlinear terms are abstracted congruently and stay sound', () => {
  // x*y = x*y is true by congruence even though the product is abstracted.
  assert.equal(prove(s.eq(s.mul(x, y), s.mul(x, y))).status, 'unsat');
  // x*y = y*x is NOT provable this way, and must not be claimed.
  const commuted = prove(s.eq(s.mul(x, y), s.mul(y, x)));
  assert.notEqual(commuted.status, 'unsat');
  assert.ok(commuted.abstractedTerms >= 2);
});

test('ite is encoded exactly, not abstracted', () => {
  const f = s.eq(s.ite(s.gt(x, s.num(0)), s.num(1), s.num(0)), s.num(1));
  assert.equal(prove(s.implies(s.gt(x, s.num(0)), f)).status, 'unsat');
  assert.equal(prove(s.implies(s.le(x, s.num(0)), f)).status, 'sat');
});

test('the solver honours its time budget', () => {
  // A deliberately wide boolean space; the point is that it returns, in budget.
  const vars = Array.from({ length: 40 }, (_, i) => s.intVar(`v${i}`));
  const wide = s.and(...vars.map((v, i) => s.or(s.ge(v, s.num(i)), s.le(v, s.num(-i)))));
  const started = Date.now();
  const r = checkSat(wide, { timeoutMs: 250 });
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 2000, `returned in ${elapsed}ms`);
  assert.ok(['sat', 'unsat', 'unknown'].includes(r.status));
  // An `unknown` here must be attributable to the budget or to elimination
  // blow-up, never to a silent modelling gap.
  if (r.status === 'unknown') assert.ok(['timeout', 'too_large'].includes(r.reason!), r.reason);
});

test('SMT-LIB output is a runnable script', () => {
  const script = s.toSmtLibScript(s.implies(s.ge(x, s.num(0)), s.ge(s.add(x, s.num(1)), s.num(1))), {
    comment: 'verification condition',
  });
  assert.match(script, /\(set-logic QF_LIA\)/);
  assert.match(script, /\(declare-const x Int\)/);
  assert.match(script, /\(assert \(=> \(>= x 0\) \(>= \(\+ x 1\) 1\)\)\)/);
  assert.match(script, /\(check-sat\)/);
  // Names that are not plain SMT-LIB symbols are quoted.
  assert.match(s.toSmtLibScript(s.ge(s.intVar('a b'), s.num(0))), /\|a b\|/);
});

test('C1: external SMT fallback is capability-bounded and only trusts proofs', () => {
  const formula = s.eq(x, x);
  assert.throws(
    () => proveWithExternalFallback(formula, {
      envelope: CapabilityEnvelope.empty(), timeoutMs: -1,
      runner: () => ({ stdout: 'unsat\n' }),
    }),
    /requires cap:process:smt_solver/,
  );
  const proved = proveWithExternalFallback(formula, {
    envelope: CapabilityEnvelope.of(SMT_SOLVER_PROCESS), timeoutMs: -1,
    runner: (_command, _args, input) => {
      assert.match(input, /\(check-sat\)/);
      return { stdout: 'unsat\n' };
    },
  });
  assert.equal(proved.status, 'unsat');
  const satWithoutModel = proveWithExternalFallback(s.ge(x, s.num(0)), {
    envelope: CapabilityEnvelope.of(SMT_SOLVER_PROCESS), timeoutMs: -1,
    runner: () => ({ stdout: 'sat\n' }),
  });
  assert.equal(satWithoutModel.status, 'unknown');
  assert.equal(satWithoutModel.reason, 'external_no_model');
});

test('C4: uninterpreted applications obey congruence', () => {
  const congruence = s.implies(
    s.eq(x, y),
    s.eq(s.app('price', x), s.app('price', y)),
  );
  assert.equal(prove(congruence).status, 'unsat');
  const script = s.toSmtLibScript(s.eq(s.app('price', x), s.num(1)));
  assert.match(script, /\(declare-fun price \(Int\) Int\)/);
});
