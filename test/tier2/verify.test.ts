import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dischargeProof, verifyFunction } from '../../src/tier2/verify.ts';
import { buildLedgerExample, ACCOUNT, CENTS } from '../../src/examples/ledger.ts';
import { SymbolSpace } from '../../src/tier1/symbols.ts';
import * as b from '../../src/tier1/build.ts';
import type { Term } from '../../src/tier1/ast.ts';
import type { InvariantId, NodeRef, SymbolId } from '../../src/tier1/ids.ts';

function environment(module: Term): Map<SymbolId, Term> {
  const env = new Map<SymbolId, Term>();
  for (const m of (module as Extract<Term, { kind: 'Module' }>).members) {
    if (m.kind === 'FunctionDecl') env.set(m.symbol, m);
  }
  return env;
}

const member = (module: Term, name: string, syms: SymbolSpace): Term =>
  (module as Extract<Term, { kind: 'Module' }>).members.find(
    (m) => m.kind === 'FunctionDecl' && syms.nameOf(m.symbol) === name,
  )!;

test('FR-2.2: the PRD transfer contract is discharged formally', () => {
  const ex = buildLedgerExample();
  const report = verifyFunction(member(ex.module, 'transfer', ex.syms), {
    symbols: ex.syms,
    environment: environment(ex.module),
  });
  assert.equal(report.verdict, 'proved');
  assert.deepEqual(report.frameViolations, []);
  assert.deepEqual(report.assumptions, [], 'the contract rules out aliasing explicitly');
  assert.deepEqual(
    report.results.map((r) => r.obligation.label),
    ['debit_exact', 'credit_exact', 'conservation'],
  );
});

test('a broken implementation is refuted with a runnable counterexample', () => {
  const ex = buildLedgerExample();
  const syms = ex.syms;
  const transfer = member(ex.module, 'transfer', syms) as Extract<Term, { kind: 'FunctionDecl' }>;
  const sender = transfer.params[0].symbol;
  const receiver = transfer.params[1].symbol;
  const amount = transfer.params[2].symbol;

  // The classic off-by-one: credit the receiver one cent short.
  const broken: Term = {
    ...transfer,
    body: b.block(
      b.assign(b.place(sender, 'balance'), b.sub(b.field(b.v(sender), 'balance'), b.v(amount))),
      b.assign(
        b.place(receiver, 'balance'),
        b.sub(b.add(b.field(b.v(receiver), 'balance'), b.v(amount)), b.typed(CENTS, 1n)),
      ),
      b.ret(b.unit()),
    ),
  };

  const report = verifyFunction(broken, { symbols: syms, environment: environment(ex.module) });
  assert.equal(report.verdict, 'refuted');
  const refuted = report.results.filter((r) => r.verdict === 'refuted').map((r) => r.obligation.label);
  assert.deepEqual(refuted.sort(), ['conservation', 'credit_exact']);
  assert.ok(report.results.find((r) => r.verdict === 'refuted')!.counterexample);
});

test('frame conditions catch writes the contract did not declare', () => {
  const ex = buildLedgerExample();
  const syms = ex.syms;
  const transfer = member(ex.module, 'transfer', syms) as Extract<Term, { kind: 'FunctionDecl' }>;
  const sender = transfer.params[0].symbol;
  const leaky: Term = {
    ...transfer,
    body: b.block(
      // `sender.id` is not in the modifies list.
      b.assign(b.place(sender, 'id'), b.str('tampered')),
      b.ret(b.unit()),
    ),
  };
  const report = verifyFunction(leaky, { symbols: syms, environment: environment(ex.module) });
  assert.equal(report.frameViolations.length, 1);
  assert.match(report.frameViolations[0], /is assigned but not listed in modifies/);
});

test('an un-ruled-out aliasing assumption is reported, not hidden', () => {
  const ex = buildLedgerExample();
  const syms = ex.syms;
  const transfer = member(ex.module, 'transfer', syms) as Extract<Term, { kind: 'FunctionDecl' }>;
  const contract = transfer.contract as Extract<Term, { kind: 'Contract' }>;
  const weakened: Term = {
    ...transfer,
    contract: { ...contract, requires: contract.requires.slice(0, 2) }, // drop distinct_accounts
  };
  const report = verifyFunction(weakened, { symbols: syms, environment: environment(ex.module) });
  assert.equal(report.verdict, 'proved', 'the obligations still discharge under the assumption');
  assert.equal(report.assumptions.length, 1);
  assert.match(report.assumptions[0], /assumed not to alias/);
  // ...but the proof is no longer good enough to open an architectural fence.
  const proof = dischargeProof(report, 'inv:b3:aa' as InvariantId, 'ast:b3:bb' as NodeRef);
  assert.equal(proof!.verdict, 'property_checked');
});

test('loop invariants and a variant are verified without unrolling', () => {
  const ex = buildLedgerExample();
  const report = verifyFunction(member(ex.module, 'accrue', ex.syms), {
    symbols: ex.syms,
    environment: environment(ex.module),
  });
  const kinds = report.results.map((r) => r.obligation.kind);
  assert.ok(kinds.includes('invariant_on_entry'));
  assert.ok(kinds.includes('invariant_preserved'));
  assert.ok(kinds.includes('variant_decreases'));
  assert.ok(kinds.includes('variant_bounded'));
  for (const r of report.results) {
    if (r.obligation.kind !== 'postcondition') assert.equal(r.verdict, 'proved', r.obligation.label);
  }
});

test('a loop with a non-decreasing variant is refuted', () => {
  const syms = new SymbolSpace('spin');
  const n = syms.define('n');
  const i = syms.define('i');
  const decl = b.fn({
    symbol: syms.define('spin'),
    params: [b.param(n, b.Int)],
    returns: b.Int,
    body: b.block(
      b.let_(i, b.Int, b.int(0)),
      b.while_(b.lt(b.v(i), b.v(n)), b.block(), { invariants: [], variant: b.sub(b.v(n), b.v(i)) }),
      b.ret(b.v(i)),
    ),
  });
  const report = verifyFunction(decl, { symbols: syms });
  assert.equal(report.verdict, 'refuted');
  assert.ok(report.results.some((r) => r.obligation.kind === 'variant_decreases' && r.verdict === 'refuted'));
});

test('tiered rigor: property clauses never reach the solver', () => {
  const ex = buildLedgerExample();
  const report = verifyFunction(member(ex.module, 'accrue', ex.syms), {
    symbols: ex.syms,
    environment: environment(ex.module),
  });
  assert.equal(report.verdict, 'delegated');
  assert.deepEqual(report.delegatedToFuzzing, ['never_shrinks']);
  const delegated = report.results.find((r) => r.verdict === 'delegated')!;
  assert.equal(delegated.solver, undefined, 'no solver time was spent on it');
});

test('NFR 6.2: verification stays inside its per-function budget', () => {
  const ex = buildLedgerExample();
  const env = environment(ex.module);
  for (const name of ['transfer', 'feeFor', 'accrue']) {
    const report = verifyFunction(member(ex.module, name, ex.syms), {
      symbols: ex.syms,
      environment: env,
      budgetMs: 2000,
    });
    assert.ok(report.elapsedMs <= 2000, `${name} took ${report.elapsedMs}ms`);
    assert.equal(report.budgetExhausted, false, `${name} exhausted its budget`);
  }
});

test('a callee contract is used modularly at the call site', () => {
  const ex = buildLedgerExample();
  const syms = ex.syms;
  const feeFor = member(ex.module, 'feeFor', syms) as Extract<Term, { kind: 'FunctionDecl' }>;
  const gross = syms.define('grossAmount');

  // Calls feeFor without establishing its non-negative precondition.
  const caller = b.fn({
    symbol: syms.define('charge'),
    params: [b.param(gross, CENTS)],
    returns: CENTS,
    body: b.block(b.ret(b.call(feeFor.symbol, b.v(gross)))),
  });
  const report = verifyFunction(caller, { symbols: syms, environment: environment(ex.module) });
  const callObligations = report.results.filter((r) => r.obligation.kind === 'precondition_at_call');
  assert.equal(callObligations.length, 1);
  assert.equal(callObligations[0].verdict, 'refuted', 'the callee precondition is not established');

  // Establishing it makes the call site verify.
  const guarded = {
    ...caller,
    contract: b.contract({
      requires: [b.clause(b.ge(b.v(gross), b.typed(CENTS, 0n)), 'non_negative')],
    }),
  } as Term;
  const ok = verifyFunction(guarded, { symbols: syms, environment: environment(ex.module) });
  assert.equal(ok.verdict, 'proved');
});

test('every obligation carries a runnable SMT-LIB script', () => {
  const ex = buildLedgerExample();
  const report = verifyFunction(member(ex.module, 'transfer', ex.syms), {
    symbols: ex.syms,
    environment: environment(ex.module),
  });
  for (const r of report.results) {
    assert.match(r.smtLib, /^; postcondition/m);
    assert.match(r.smtLib, /\(set-logic QF_LIA\)/);
    assert.match(r.smtLib, /\(check-sat\)/);
  }
});
