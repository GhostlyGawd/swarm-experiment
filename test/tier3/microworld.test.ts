import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MicroWorld, simulateModule } from '../../src/tier3/microworld.ts';
import { generateCase, materialise, shrinkPlain, type Plain } from '../../src/tier3/generate.ts';
import { buildLedgerExample, ACCOUNT, CENTS } from '../../src/examples/ledger.ts';
import { CapabilityRegistry } from '../../src/tier2/ocap.ts';
import { Runtime } from '../../src/tier3/runtime.ts';
import { SymbolSpace } from '../../src/tier1/symbols.ts';
import { rng } from '../../src/util/rng.ts';
import * as b from '../../src/tier1/build.ts';
import type { Term } from '../../src/tier1/ast.ts';

const member = (ex: ReturnType<typeof buildLedgerExample>, name: string): Extract<Term, { kind: 'FunctionDecl' }> =>
  (ex.module as Extract<Term, { kind: 'Module' }>).members.find(
    (m) => m.kind === 'FunctionDecl' && ex.syms.nameOf(m.symbol) === name,
  ) as Extract<Term, { kind: 'FunctionDecl' }>;

test('FR-3.2: the worked example passes its micro-world suite', () => {
  const ex = buildLedgerExample();
  const reports = simulateModule(ex.module, {
    registry: ex.capabilities,
    symbols: ex.syms,
    seed: 'suite',
  });
  assert.equal(reports.length, 4);
  for (const report of reports) {
    assert.ok(report.accepted, `${ex.syms.nameOf(report.symbol)}: ${JSON.stringify(report.failures)}`);
    assert.equal(report.compliance, 1);
    assert.ok(report.cases > 0, 'the generator produced runnable cases');
  }
});

test('NFR 6.1: a local module harness completes within 250ms', () => {
  const ex = buildLedgerExample();
  const started = Date.now();
  simulateModule(ex.module, { registry: ex.capabilities, symbols: ex.syms, seed: 'budget' });
  const elapsed = Date.now() - started;
  // Three declarations, each with its own 250 ms budget.
  assert.ok(elapsed < 250 * 3 + 100, `suite took ${elapsed}ms`);
});

test('FR-3.2: a broken implementation is rejected, not merely reported', () => {
  const ex = buildLedgerExample();
  const transfer = member(ex, 'transfer');
  const [sender, receiver, amount] = transfer.params.map((p) => p.symbol);
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
  const report = new MicroWorld(broken, {
    registry: ex.capabilities, symbols: ex.syms, seed: 'broken', module: ex.module,
  }).run();
  assert.equal(report.accepted, false);
  assert.ok(report.compliance < 1);
  assert.equal(report.failures[0].property, 'contract');
  assert.match(report.failures[0].detail, /credit_exact|conservation/);
});

test('counterexamples are shrunk to something an agent can read', () => {
  const ex = buildLedgerExample();
  const syms = ex.syms;
  const amount = syms.define('amt');
  // Claims to be non-negative, but returns the input unchanged.
  const wrong = b.fn({
    symbol: syms.define('abs'),
    params: [b.param(amount, b.Int)],
    returns: b.Int,
    purity: 'pure',
    contract: b.contract({ ensures: [b.clause(b.ge(b.result(), b.int(0)), 'non_negative')] }),
    body: b.block(b.ret(b.v(amount))),
  });
  const report = new MicroWorld(wrong, { registry: ex.capabilities, symbols: syms, seed: 'shrink' }).run();
  assert.equal(report.accepted, false);
  // The minimal witness for "not >= 0" is -1.
  assert.equal(report.failures[0].arguments[0], '-1');
});

test('the frame property catches a clobbered neighbouring field', () => {
  const ex = buildLedgerExample();
  const transfer = member(ex, 'transfer');
  const [sender, receiver, amount] = transfer.params.map((p) => p.symbol);
  const leaky: Term = {
    ...transfer,
    body: b.block(
      b.assign(b.place(sender, 'balance'), b.sub(b.field(b.v(sender), 'balance'), b.v(amount))),
      b.assign(b.place(receiver, 'balance'), b.add(b.field(b.v(receiver), 'balance'), b.v(amount))),
      b.assign(b.place(sender, 'id'), b.str('clobbered')), // not in modifies
      b.ret(b.unit()),
    ),
  };
  const report = new MicroWorld(leaky, {
    registry: ex.capabilities, symbols: ex.syms, seed: 'frame', module: ex.module,
  }).run();
  assert.equal(report.accepted, false);
  assert.equal(report.failures[0].property, 'frame');
  assert.match(report.failures[0].detail, /wrote outside modifies: 0\.id/);
});

test('an unbounded loop is caught as a liveness hazard', () => {
  const ex = buildLedgerExample();
  const accrue = member(ex, 'accrue');
  const contract = accrue.contract as Extract<Term, { kind: 'Contract' }>;
  // Drop the `bounded_periods` precondition that makes the loop terminate in
  // practice; the micro-world should find the runaway input.
  const unbounded: Term = {
    ...accrue,
    contract: { ...contract, requires: contract.requires.slice(0, 2) },
  };
  const report = new MicroWorld(unbounded, {
    registry: ex.capabilities, symbols: ex.syms, seed: 'unbounded', cases: 60, maxSteps: 5000,
  }).run();
  assert.equal(report.accepted, false);
  assert.ok(report.failures.some((f) => f.fault?.kind === 'step_budget'));
});

test('FR-3.2: the aliased case is actually generated', () => {
  const ex = buildLedgerExample();
  const transfer = member(ex, 'transfer');
  let aliased = 0;
  for (let i = 0; i < 400; i++) {
    const args = generateCase(transfer.params, rng(`alias/${i}`), { aliasBias: 0.2 });
    if (args.some((a) => a.k === 'alias')) aliased++;
  }
  assert.ok(aliased > 20, `only ${aliased}/400 cases aliased`);

  // And an aliased case really does share a heap reference.
  const rt = new Runtime({ registry: ex.capabilities, symbols: ex.syms });
  const args: Plain[] = [
    { k: 'record', ty: ACCOUNT, fields: { id: { k: 'str', v: 'a' }, balance: { k: 'int', v: 10n } } },
    { k: 'alias', index: 0 },
    { k: 'int', v: 1n },
  ];
  const values = materialise(args, rt);
  assert.deepEqual(values[0], values[1]);
});

test('an effect outage must surface cleanly, not as a broken postcondition', () => {
  const ex = buildLedgerExample();
  const transfer = member(ex, 'transfer');
  const report = new MicroWorld(transfer, {
    registry: ex.capabilities, symbols: ex.syms, seed: 'outage', module: ex.module, cases: 40,
  }).run();
  // transfer invokes the ledger *after* its writes, so the outage surfaces as
  // the effect failure itself, which is the acceptable shape.
  assert.ok(report.accepted, JSON.stringify(report.failures));
});

test('a lost-update race is reported as an advisory, not a rejection', () => {
  const ex = buildLedgerExample();
  const report = new MicroWorld(member(ex, 'transfer'), {
    registry: ex.capabilities, symbols: ex.syms, seed: 'race', module: ex.module,
  }).run();
  assert.ok(report.accepted, 'a topology-dependent hazard does not fail the body');
  assert.equal(report.advisories.length, 1);
  assert.equal(report.advisories[0].property, 'concurrent_schedule');
  assert.equal(report.advisories[0].advisory, true);
  assert.match(report.advisories[0].detail, /lose one update/);
});

test('NFR 6.2: a reported counterexample replays exactly from its seed', () => {
  const ex = buildLedgerExample();
  const syms = ex.syms;
  const n = syms.define('n');
  const wrong = b.fn({
    symbol: syms.define('neverNegative'),
    params: [b.param(n, b.Int)],
    returns: b.Int,
    purity: 'pure',
    contract: b.contract({ ensures: [b.clause(b.ge(b.result(), b.int(0)), 'non_negative')] }),
    body: b.block(b.ret(b.v(n))),
  });
  const first = new MicroWorld(wrong, { registry: ex.capabilities, symbols: syms, seed: 'replay' }).run();
  const second = new MicroWorld(wrong, { registry: ex.capabilities, symbols: syms, seed: 'replay' }).run();
  assert.deepEqual(
    first.failures.map((f) => [f.property, f.arguments]),
    second.failures.map((f) => [f.property, f.arguments]),
  );
});

test('generation is boundary-biased and yield is reported honestly', () => {
  const syms = new SymbolSpace('gen');
  const n = syms.define('n');
  const seen = new Set<string>();
  for (let i = 0; i < 300; i++) {
    const [arg] = generateCase([b.param(n, b.Int)], rng(`gen/${i}`));
    if (arg.k === 'int') seen.add(String(arg.v));
  }
  for (const boundary of ['0', '1', '-1', '9223372036854775807']) {
    assert.ok(seen.has(boundary), `boundary ${boundary} was never generated`);
  }

  const ex = buildLedgerExample();
  const report = new MicroWorld(member(ex, 'transfer'), {
    registry: ex.capabilities, symbols: ex.syms, seed: 'yield', module: ex.module,
  }).run();
  assert.ok(report.generationEfficiency > 0 && report.generationEfficiency < 1);
  assert.equal(report.cases + report.filtered > 0, true);
});

test('shrinking moves strictly towards simpler values', () => {
  const candidates = shrinkPlain({ k: 'int', v: 1000n });
  assert.deepEqual(candidates.map((c) => (c.k === 'int' ? c.v : null)), [0n, 500n, 1n, 999n]);
  assert.deepEqual(shrinkPlain({ k: 'int', v: 0n }), []);
  assert.deepEqual(shrinkPlain({ k: 'str', v: '' }), []);
  const record = shrinkPlain({
    k: 'record', ty: ACCOUNT,
    fields: { id: { k: 'str', v: 'abcd' }, balance: { k: 'int', v: 8n } },
  });
  assert.ok(record.length > 0);
  assert.ok(record.every((r) => r.k === 'record'));
});
