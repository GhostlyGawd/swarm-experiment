import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as b from '../src/tier1/build.ts';
import { GraphStore } from '../src/tier1/store.ts';
import { capability, typeName, type InvariantId } from '../src/tier1/ids.ts';
import { ProvenanceLedger, type DischargeProof } from '../src/tier1/provenance.ts';
import { SymbolSpace } from '../src/tier1/symbols.ts';
import type { Term, Ty } from '../src/tier1/ast.ts';
import { CapabilityRegistry } from '../src/tier2/ocap.ts';
import { typecheck } from '../src/tier2/typecheck.ts';
import { dischargeProof, verifyFunction } from '../src/tier2/verify.ts';
import { ProductionRuntime } from '../src/tier3/compile.ts';
import { Runtime } from '../src/tier3/runtime.ts';
import { buildLedgerExample, ACCOUNT } from '../src/examples/ledger.ts';
import { ledgerTelemetry } from '../src/examples/ledger.ts';
import { slice } from '../src/tier4/topology.ts';

const registry = new CapabilityRegistry();

test('I1: a mutating callee cannot make an impossible assertion prove vacuously', () => {
  const syms = new SymbolSpace('callee-effects-regression');
  const increment = syms.define('increment');
  const wrapper = syms.define('wrapper');
  const p = syms.define('p');
  const q = syms.define('q');
  const counter: Ty = {
    t: 'Record', name: typeName('type:test:counter'), fields: [['n', b.Int]],
  };
  const callee = b.fn({
    symbol: increment,
    params: [b.param(p, counter)],
    returns: b.Unit,
    contract: b.contract({
      ensures: [
        b.clause(
          b.eq(b.field(b.v(p), 'n'), b.add(b.old(b.field(b.v(p), 'n')), b.int(1))),
          'incremented',
        ),
      ],
      modifies: [b.place(p, 'n')],
    }),
    body: b.block(
      b.assign(b.place(p, 'n'), b.add(b.field(b.v(p), 'n'), b.int(1))),
      b.ret(b.unit()),
    ),
  });
  const caller = b.fn({
    symbol: wrapper,
    params: [b.param(q, counter)],
    returns: b.Unit,
    body: b.block(
      b.exprStmt(b.call(increment, b.v(q))),
      b.assert_(b.bool(false), 'must_fail'),
      b.ret(b.unit()),
    ),
  });

  const report = verifyFunction(caller, { symbols: syms, environment: new Map([[increment, callee]]) });
  assert.equal(report.verdict, 'refuted');
  assert.ok(report.results.some((r) => r.obligation.label === 'must_fail' && r.verdict === 'refuted'));
});

test('I2: production elision rejects stale and assumption-dependent reports', () => {
  const syms = new SymbolSpace('stale-report-regression');
  const f = syms.define('f');
  const contract = b.contract({ ensures: [b.clause(b.eq(b.result(), b.int(1)), 'always_one')] });
  const good = b.fn({ symbol: f, returns: b.Int, contract, body: b.block(b.ret(b.int(1))) });
  const stale = verifyFunction(good, { symbols: syms });
  const broken = { ...good, body: b.block(b.ret(b.int(0))) } as Extract<Term, { kind: 'FunctionDecl' }>;
  const prod = ProductionRuntime.compile(broken, {
    registry, symbols: syms, verification: new Map([[f, stale]]),
  });
  const staleResult = prod.call(f, []);
  assert.equal(staleResult.ok, false);
  assert.match(prod.report.decisions[0].reason, /different declaration contents/);

  const ex = buildLedgerExample('assumption-elision-regression');
  const transfer = (ex.module as Extract<Term, { kind: 'Module' }>).members.find(
    (m) => m.kind === 'FunctionDecl' && m.symbol === ex.symbols.transfer,
  ) as Extract<Term, { kind: 'FunctionDecl' }>;
  const weakened = {
    ...transfer,
    contract: { ...transfer.contract as Extract<Term, { kind: 'Contract' }>, requires: (transfer.contract as Extract<Term, { kind: 'Contract' }>).requires.slice(0, 2) },
  };
  const report = verifyFunction(weakened, { symbols: ex.syms });
  assert.equal(report.assumptions.length, 1);
  const guarded = ProductionRuntime.compile(weakened, {
    registry: ex.capabilities,
    symbols: ex.syms,
    verification: new Map([[weakened.symbol, report]]),
  });
  const account = guarded.allocateRecord(ACCOUNT, { id: 'same', balance: 1000n });
  assert.equal(guarded.call(weakened.symbol, [account, account, 10n]).ok, false);
  assert.ok(guarded.report.decisions.some((d) => /modelling assumptions/.test(d.reason)));
});

test('I3: truncated path exploration cannot report a proof', () => {
  const syms = new SymbolSpace('truncation-regression');
  const f = syms.define('f');
  const flag = syms.define('flag');
  const decl = b.fn({
    symbol: f,
    params: [b.param(flag, b.Bool)],
    returns: b.Int,
    contract: b.contract({ ensures: [b.clause(b.eq(b.result(), b.int(1)), 'always_one')] }),
    body: b.block(
      b.if_(b.v(flag), b.block(b.ret(b.int(1))), b.block(b.ret(b.int(0)))),
      b.exprStmt(b.unit()),
    ),
  });
  const report = verifyFunction(decl, { symbols: syms, maxPaths: 1 });
  assert.equal(report.verdict, 'unproven');
  assert.equal(report.budgetExhausted, true);
});

test('I4: frame violations reject verification and architectural proofs', () => {
  const ex = buildLedgerExample('frame-proof-regression');
  const transfer = (ex.module as Extract<Term, { kind: 'Module' }>).members.find(
    (m) => m.kind === 'FunctionDecl' && m.symbol === ex.symbols.transfer,
  ) as Extract<Term, { kind: 'FunctionDecl' }>;
  const sender = transfer.params[0].symbol;
  const leaky = {
    ...transfer,
    body: {
      ...transfer.body as Extract<Term, { kind: 'Block' }>,
      stmts: [
        b.assign(b.place(sender, 'id'), b.str('tampered')),
        ...(transfer.body as Extract<Term, { kind: 'Block' }>).stmts,
      ],
    },
  };
  const report = verifyFunction(leaky, { symbols: ex.syms });
  assert.equal(report.verdict, 'refuted');
  assert.equal(report.frameViolations.length, 1);
  assert.equal(dischargeProof(report, 'inv:b3:test' as InvariantId, report.subject), null);

  const noWrites = { ...leaky, contract: { ...(leaky.contract as Extract<Term, { kind: 'Contract' }>), modifies: [] } };
  assert.ok(verifyFunction(noWrites, { symbols: ex.syms }).frameViolations.length > 0);
});

test('I5: return expressions must match the declared return type', () => {
  const syms = new SymbolSpace('return-type-regression');
  const decl = b.fn({
    symbol: syms.define('wrong'), returns: b.Int, body: b.block(b.ret(b.str('wrong'))),
  });
  const result = typecheck(decl, { registry, symbols: syms });
  assert.equal(result.ok, false);
  assert.ok(result.diagnostics.some((d) => d.code === 'type_mismatch' && /return value/.test(d.message)));
});

test('I6: production compilation rejects unregistered capabilities', () => {
  const syms = new SymbolSpace('registry-regression');
  const cap = capability('cap:test:missing');
  const decl = b.fn({
    symbol: syms.define('effect'),
    returns: b.Unit,
    purity: 'effectful',
    capabilities: [cap],
    body: b.block(b.exprStmt(b.invoke(cap)), b.ret(b.unit())),
  });
  assert.throws(
    () => ProductionRuntime.compile(decl, { registry, symbols: syms }),
    /unregistered capability/,
  );
});

test('I7: a fence only accepts a proof bound to the replacement node', () => {
  const invariant = 'inv:b3:fence' as InvariantId;
  const ledger = new ProvenanceLedger(() => 1);
  const provenance = ledger.record({
    intent: 'protect the invariant',
    origin: { kind: 'spec_clause', ref: 'TEST-1' },
    guard: { invariant, priority: 'architectural', rationale: 'test guard' },
  });
  const store = new GraphStore();
  const original = store.intern(b.int(1));
  const replacement = store.intern(b.int(2));
  ledger.bind(original, provenance);
  const unrelated: DischargeProof = {
    invariant, verdict: 'proved', evidence: 'proved elsewhere', subject: original,
  };
  assert.equal(ledger.guardMutation(original, replacement, [unrelated]).allowed, false);
  assert.equal(
    ledger.guardMutation(original, replacement, [{ ...unrelated, subject: replacement }]).allowed,
    true,
  );
});

test('I8: every published tier subpath resolves after the package build', async () => {
  const specifiers = [1, 2, 3, 4].map((tier) => `@ghostlygawd/aether/tier${tier}`);
  const modules = await Promise.all(specifiers.map((specifier) => import(specifier)));
  assert.equal(typeof modules[0].GraphStore, 'function');
  assert.equal(typeof modules[1].verifyFunction, 'function');
  assert.equal(typeof modules[2].Runtime, 'function');
  assert.equal(typeof modules[3].slice, 'function');
});

test('I9: the containers target places every unit in a container', () => {
  const ex = buildLedgerExample('container-placement-regression');
  const plan = slice(ex.module, ledgerTelemetry(ex), { shape: 'containers', symbols: ex.syms });
  assert.ok(plan.units.length > 1);
  assert.ok(plan.units.every((unit) => unit.placement === 'container'));
});
