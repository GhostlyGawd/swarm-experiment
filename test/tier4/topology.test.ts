import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_COST_MODEL, callGraph, compareShapes, formatPlan, generateGlue, slice,
} from '../../src/tier4/topology.ts';
import { buildLedgerExample, ledgerTelemetry, CAP_LEDGER_APPEND } from '../../src/examples/ledger.ts';

test('the call graph is read from the code, not from configuration', () => {
  const ex = buildLedgerExample();
  const graph = callGraph(ex.module);
  const calls = graph.get(ex.symbols.settle)!;
  assert.ok(calls.has(ex.symbols.feeFor));
  assert.ok(calls.has(ex.symbols.transfer));
  assert.equal(graph.get(ex.symbols.feeFor)!.size, 0);
});

test('FR-4.1: heavy interconnect is recombined into one in-process domain', () => {
  const ex = buildLedgerExample();
  const plan = slice(ex.module, ledgerTelemetry(ex), { symbols: ex.syms, shape: 'auto' });

  const hot = plan.units.find((u) => u.members.includes(ex.symbols.settle))!;
  assert.ok(hot.members.includes(ex.symbols.transfer), 'settle and transfer were co-located');
  assert.ok(hot.members.includes(ex.symbols.feeFor), 'feeFor joined them');
  // Co-location is the property that matters: members of one unit share a
  // memory domain and call each other directly, wherever the unit is deployed.
  assert.equal(hot.members.length, 3);
  assert.ok(plan.recombinations.some((r) => /recombined into one in-process/.test(r)));

  // The cold nightly job stays out of the hot unit.
  const cold = plan.units.find((u) => u.members.includes(ex.symbols.accrue))!;
  assert.notEqual(cold.id, hot.id);
  // No hot edge crosses a boundary any more.
  assert.ok(plan.crossEdges.every((e) => e.callsPerSecond < 1));
});

test('the same graph compiles to different shapes with different prices', () => {
  const ex = buildLedgerExample();
  const plans = compareShapes(ex.module, ledgerTelemetry(ex), { symbols: ex.syms });
  const byShape = new Map(plans.map((p) => [p.shape, p.plan]));

  assert.equal(byShape.get('single_binary')!.units.length, 1);
  assert.equal(byShape.get('single_binary')!.units[0].placement, 'linked');
  assert.ok(byShape.get('containers')!.units.length > 1);
  // The monolith is cheaper to run; nothing about the source changed.
  assert.ok(byShape.get('single_binary')!.monthlyCost < byShape.get('containers')!.monthlyCost);
  assert.equal(byShape.get('single_binary')!.transportLatencyMsPerSecond, 0);
});

test('capabilities decide placement, without an annotation saying so', () => {
  const ex = buildLedgerExample();
  const plan = slice(ex.module, ledgerTelemetry(ex), { symbols: ex.syms, shape: 'edge_workers' });
  const withDb = plan.units.find((u) => u.capabilities.includes(CAP_LEDGER_APPEND))!;
  assert.equal(withDb.placement, 'container', 'a database capability cannot run at the edge');
  const pure = plan.units.find((u) => u.capabilities.length === 0)!;
  assert.equal(pure.placement, 'edge');
});

test('a footprint limit blocks a merge the traffic would otherwise justify', () => {
  const ex = buildLedgerExample();
  const plan = slice(ex.module, ledgerTelemetry(ex), {
    symbols: ex.syms,
    cost: { ...DEFAULT_COST_MODEL, maxUnitMemoryMb: 100 },
  });
  assert.ok(plan.blockedMerges.length > 0);
  assert.match(plan.blockedMerges[0], /exceeds the 100MB unit limit/);
  // The traffic it would have saved is stated, so the trade-off is visible.
  assert.match(plan.blockedMerges[0], /would save \d+/);
  assert.ok(plan.transportLatencyMsPerSecond > 0, 'the boundary now costs real latency');
});

test('an isolated capability is never co-located', () => {
  const ex = buildLedgerExample();
  const plan = slice(ex.module, ledgerTelemetry(ex), {
    symbols: ex.syms,
    isolate: [CAP_LEDGER_APPEND],
  });
  // Both `transfer` and `settle` hold the ledger capability, so each gets a
  // unit to itself even though the traffic between them is heavy.
  const privileged = plan.units.filter((u) => u.capabilities.includes(CAP_LEDGER_APPEND));
  assert.equal(privileged.length, 2);
  for (const unit of privileged) assert.equal(unit.members.length, 1);
  assert.ok(plan.blockedMerges.some((m) => /must run in isolation/.test(m)));
  assert.ok(plan.transportLatencyMsPerSecond > 0, 'isolation is paid for in transport');
});

test('transport glue is derived, and forwards the capability envelope', () => {
  const ex = buildLedgerExample();
  const plan = slice(ex.module, ledgerTelemetry(ex), { symbols: ex.syms });
  const glue = generateGlue(plan, ex.syms);
  assert.match(glue, /export const settle_transfer_feeFor = \{/);
  assert.match(glue, /forwardCapabilities: true/);
  assert.match(glue, /crossing a process boundary must not widen authority/);

  // A monolith needs no transport at all.
  const monolith = slice(ex.module, ledgerTelemetry(ex), { symbols: ex.syms, shape: 'single_binary' });
  assert.match(generateGlue(monolith, ex.syms), /No boundary is crossed/);
});

test('a plan renders to something a human can review', () => {
  const ex = buildLedgerExample();
  const text = formatPlan(slice(ex.module, ledgerTelemetry(ex), { symbols: ex.syms }), ex.syms);
  assert.match(text, /topology auto: 2 unit\(s\)/);
  assert.match(text, /\$\d+\.\d{2}\/month/);
  assert.match(text, /\{settle, transfer, feeFor\}/);
  assert.match(text, /3 member\(s\) sharing one memory domain/);
});

test('E4: concurrency findings become single-writer placement constraints', () => {
  const ex = buildLedgerExample();
  const plan = slice(ex.module, { edges: [], functions: ledgerTelemetry(ex).functions }, {
    symbols: ex.syms,
    concurrencyFindings: [{
      symbols: [ex.symbols.settle, ex.symbols.transfer],
      reason: 'lost update on account balances',
    }],
  });
  const settle = plan.units.find((unit) => unit.members.includes(ex.symbols.settle));
  assert.ok(settle?.members.includes(ex.symbols.transfer));
  assert.ok(plan.recombinations.some((reason) => /single-writer domain/.test(reason)));
});
