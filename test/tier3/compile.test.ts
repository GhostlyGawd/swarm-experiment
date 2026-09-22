import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProductionRuntime, formatCompilation } from '../../src/tier3/compile.ts';
import { Runtime } from '../../src/tier3/runtime.ts';
import { RevocationList } from '../../src/tier2/ocap.ts';
import { verifyFunction, type VerificationReport } from '../../src/tier2/verify.ts';
import { ACCOUNT, CAP_LEDGER_APPEND, CENTS, buildLedgerExample } from '../../src/examples/ledger.ts';
import { generateCase, materialise } from '../../src/tier3/generate.ts';
import { rng } from '../../src/util/rng.ts';
import * as b from '../../src/tier1/build.ts';
import type { Term } from '../../src/tier1/ast.ts';
import type { SymbolId } from '../../src/tier1/ids.ts';
import type { Value } from '../../src/tier3/values.ts';

function verified(ex: ReturnType<typeof buildLedgerExample>): Map<SymbolId, VerificationReport> {
  const env = new Map<SymbolId, Term>();
  for (const m of (ex.module as Extract<Term, { kind: 'Module' }>).members) {
    if (m.kind === 'FunctionDecl') env.set(m.symbol, m);
  }
  const out = new Map<SymbolId, VerificationReport>();
  for (const [symbol, decl] of env) {
    out.set(symbol, verifyFunction(decl, { symbols: ex.syms, environment: env }));
  }
  return out;
}

const effects = new Map([[CAP_LEDGER_APPEND, () => null as Value]]);

test('R2: the two runtimes agree on every generated case', () => {
  const ex = buildLedgerExample();
  const members = (ex.module as Extract<Term, { kind: 'Module' }>).members;

  for (const decl of members) {
    if (decl.kind !== 'FunctionDecl' || decl.body === null) continue;
    const random = rng(`equiv/${ex.syms.nameOf(decl.symbol)}`);

    for (let i = 0; i < 120; i++) {
      const args = generateCase(decl.params, random.fork(`case/${i}`));

      const dev = new Runtime({ registry: ex.capabilities, symbols: ex.syms, effects });
      dev.load(ex.module);
      const devResult = dev.callDeclaration(decl, materialise(args, dev));

      const prod = ProductionRuntime.compile(ex.module, {
        registry: ex.capabilities, symbols: ex.syms, effects, policy: 'enforce',
      });
      const prodResult = prod.call(decl.symbol, materialise(args, prod));

      assert.equal(prodResult.ok, devResult.ok,
        `${ex.syms.nameOf(decl.symbol)} case ${i}: ok differs`);
      if (devResult.ok && prodResult.ok) {
        assert.deepEqual(prodResult.value, devResult.value, `case ${i}: return value differs`);
        assert.deepEqual(prod.snapshot(), dev.inspect().heap, `case ${i}: heap differs`);
      } else if (!devResult.ok && !prodResult.ok) {
        assert.equal(prodResult.fault.kind, devResult.fault.kind, `case ${i}: fault kind differs`);
        assert.equal(prodResult.fault.label, devResult.fault.label, `case ${i}: fault label differs`);
      }
    }
  }
});

test('R2: a proved clause is elided; an unproved one is kept', () => {
  const ex = buildLedgerExample();
  const prod = ProductionRuntime.compile(ex.module, {
    registry: ex.capabilities, symbols: ex.syms, effects,
    verification: verified(ex),
  });
  const report = prod.report;
  assert.equal(report.policy, 'verified_elision');
  assert.ok(report.clausesElided > 0, 'proof bought something');

  const decision = (fn: string, label: string) =>
    report.decisions.find((d) => d.function === fn && d.label === label)!;

  // transfer's postconditions were all discharged by the solver.
  for (const label of ['debit_exact', 'credit_exact', 'conservation']) {
    const d = decision('transfer', label);
    assert.equal(d.decision, 'elided', label);
    assert.match(d.reason, /discharged by the SMT solver/);
  }
  // accrue's `never_shrinks` is a property clause — it never reached the
  // solver, so production must still check it.
  const delegated = decision('accrue', 'never_shrinks');
  assert.equal(delegated.decision, 'kept');
  assert.match(delegated.reason, /verdict was delegated, not proved/);

  // Preconditions stay, because an external caller may exist.
  const pre = decision('transfer', 'sufficient_funds');
  assert.equal(pre.decision, 'kept');
  assert.match(pre.reason, /entry points not declared/);
});

test('R2: eliding a proved clause cannot change an observable outcome', () => {
  const ex = buildLedgerExample();
  const reports = verified(ex);
  const build = (policy: 'enforce' | 'verified_elision') =>
    ProductionRuntime.compile(ex.module, {
      registry: ex.capabilities, symbols: ex.syms, effects, verification: reports, policy,
    });

  const random = rng('elision-equivalence');
  const transfer = (ex.module as Extract<Term, { kind: 'Module' }>).members[2] as Extract<Term, { kind: 'FunctionDecl' }>;
  for (let i = 0; i < 200; i++) {
    const args = generateCase(transfer.params, random.fork(`case/${i}`));
    const strict = build('enforce');
    const lean = build('verified_elision');
    const a = strict.call(transfer.symbol, materialise(args, strict));
    const c = lean.call(transfer.symbol, materialise(args, lean));
    assert.equal(c.ok, a.ok, `case ${i}`);
    if (a.ok && c.ok) {
      assert.deepEqual(c.value, a.value);
      assert.deepEqual(lean.snapshot(), strict.snapshot());
    } else if (!a.ok && !c.ok) {
      assert.equal(c.fault.label, a.fault.label);
    }
  }
});

test('R2: a precondition is elided only when every call site proved it', () => {
  const ex = buildLedgerExample();
  const reports = verified(ex);

  // `settle` is the only entry point; feeFor and transfer are internal, and
  // settle's call sites discharged their preconditions.
  const prod = ProductionRuntime.compile(ex.module, {
    registry: ex.capabilities, symbols: ex.syms, effects,
    verification: reports,
    entryPoints: [ex.symbols.settle, ex.symbols.accrue],
  });
  const find = (fn: string, label: string) =>
    prod.report.decisions.find((d) => d.function === fn && d.label === label)!;

  const internal = find('transfer', 'sufficient_funds');
  assert.equal(internal.decision, 'elided');
  assert.match(internal.reason, /established at all 1 verified call site/);

  // settle is an entry point, so its own preconditions stay.
  const entry = find('settle', 'sufficient_funds');
  assert.equal(entry.decision, 'kept');
  assert.match(entry.reason, /an entry point/);
});

test('R2: security is not telemetry — capabilities survive stripping', () => {
  const ex = buildLedgerExample();
  const revocations = new RevocationList(() => 0);
  const prod = ProductionRuntime.compile(ex.module, {
    registry: ex.capabilities, symbols: ex.syms, effects, revocations,
    verification: verified(ex), policy: 'elide',
  });
  const alice = prod.allocateRecord(ACCOUNT, { id: 'alice', balance: 1000n });
  const bob = prod.allocateRecord(ACCOUNT, { id: 'bob', balance: 0n });

  assert.equal(prod.call(ex.symbols.transfer, [alice, bob, 10n]).ok, true);

  // Revocation still takes effect with no rebuild, even with all contracts elided.
  revocations.revoke(CAP_LEDGER_APPEND, { by: 'sre@aether' });
  const after = prod.call(ex.symbols.transfer, [alice, bob, 10n]);
  assert.equal(after.ok, false);
  if (!after.ok) assert.equal(after.fault.kind, 'capability_revoked');
});

test('R2: an ungranted capability fails to compile, not at runtime', () => {
  const ex = buildLedgerExample();
  const syms = ex.syms;
  const sneaky = b.fn({
    symbol: syms.define('sneaky'),
    returns: b.Unit,
    purity: 'effectful',
    capabilities: [],
    body: b.block(b.exprStmt(b.invoke(CAP_LEDGER_APPEND, b.str('a'), b.str('b'), b.int(1))), b.ret(b.unit())),
  });
  assert.throws(
    () => ProductionRuntime.compile(sneaky, { registry: ex.capabilities, symbols: syms }),
    /may not invoke cap:db:ledger_append/,
  );
});

test('R2: the stripped artifact is materially faster than the journaling one', () => {
  const ex = buildLedgerExample();
  const reports = verified(ex);
  const iterations = 3000;

  const dev = new Runtime({ registry: ex.capabilities, symbols: ex.syms, effects });
  dev.load(ex.module);
  const devAccounts = [
    dev.allocateRecord(ACCOUNT, { id: 'a', balance: 10n ** 12n }),
    dev.allocateRecord(ACCOUNT, { id: 'b', balance: 0n }),
  ];
  const devStart = process.hrtime.bigint();
  for (let i = 0; i < iterations; i++) dev.call(ex.symbols.settle, [devAccounts[0], devAccounts[1], 1000n]);
  const devMs = Number(process.hrtime.bigint() - devStart) / 1e6;

  const prod = ProductionRuntime.compile(ex.module, {
    registry: ex.capabilities, symbols: ex.syms, effects, verification: reports,
    entryPoints: [ex.symbols.settle],
  });
  const prodAccounts = [
    prod.allocateRecord(ACCOUNT, { id: 'a', balance: 10n ** 12n }),
    prod.allocateRecord(ACCOUNT, { id: 'b', balance: 0n }),
  ];
  const prodStart = process.hrtime.bigint();
  for (let i = 0; i < iterations; i++) prod.call(ex.symbols.settle, [prodAccounts[0], prodAccounts[1], 1000n]);
  const prodMs = Number(process.hrtime.bigint() - prodStart) / 1e6;

  assert.ok(prodMs < devMs, `production ${prodMs.toFixed(1)}ms vs development ${devMs.toFixed(1)}ms`);
  assert.ok(
    devMs / prodMs > 2,
    `expected a >2x gap, got ${(devMs / prodMs).toFixed(2)}x ` +
      `(dev ${devMs.toFixed(1)}ms, prod ${prodMs.toFixed(1)}ms)`,
  );
  // Both must still agree about the answer.
  assert.deepEqual(prod.snapshot(), dev.inspect().heap);
});

test('R2: loop invariants and variants carry no runtime cost', () => {
  const ex = buildLedgerExample();
  const prod = ProductionRuntime.compile(ex.module, {
    registry: ex.capabilities, symbols: ex.syms, effects, verification: verified(ex),
  });
  const result = prod.call(ex.symbols.accrue, [100_000n, 12n]);
  assert.equal(result.ok, true);
  // The invariants are verification artifacts; nothing about them is reported
  // as a kept clause, because they are not compiled at all.
  assert.equal(prod.report.decisions.some((d) => d.label.startsWith('invariant')), false);
});

test('R2: the compilation report says exactly what is unchecked and why', () => {
  const ex = buildLedgerExample();
  const prod = ProductionRuntime.compile(ex.module, {
    registry: ex.capabilities, symbols: ex.syms, effects, verification: verified(ex),
  });
  const text = formatCompilation(prod.report);
  assert.match(text, /compiled \d+ function\(s\) under policy "verified_elision"/);
  assert.match(text, /− transfer\.conservation \[postcondition\] — discharged by the SMT solver/);
  assert.match(text, /✓ accrue\.never_shrinks \[postcondition\] — verdict was delegated/);
  // Every clause in the module is accounted for, one way or the other.
  for (const d of prod.report.decisions) assert.ok(d.reason.length > 0, d.label);
});

test('R2: with no verification result, nothing is elided', () => {
  const ex = buildLedgerExample();
  const prod = ProductionRuntime.compile(ex.module, {
    registry: ex.capabilities, symbols: ex.syms, effects,
  });
  assert.equal(prod.report.clausesElided, 0);
  for (const d of prod.report.decisions) {
    assert.equal(d.decision, 'kept');
    assert.match(d.reason, /no verification result|entry points not declared/);
  }
});

test('R2: a contract that does fail still faults in production', () => {
  const ex = buildLedgerExample();
  const prod = ProductionRuntime.compile(ex.module, {
    registry: ex.capabilities, symbols: ex.syms, effects, verification: verified(ex),
  });
  const alice = prod.allocateRecord(ACCOUNT, { id: 'alice', balance: 5n });
  const bob = prod.allocateRecord(ACCOUNT, { id: 'bob', balance: 0n });
  const result = prod.call(ex.symbols.transfer, [alice, bob, 100n]);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.fault.kind, 'precondition');
    assert.equal(result.fault.label, 'sufficient_funds');
    // No binding snapshot: collecting one is development telemetry.
    assert.deepEqual(result.fault.bindings, {});
  }
});
