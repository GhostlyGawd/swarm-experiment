import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CapabilitySealer } from '../../src/tier2/ocap.ts';
import { ACCOUNT, buildLedgerExample, ledgerTelemetry } from '../../src/examples/ledger.ts';
import { TopologyHost } from '../../src/tier4/host.ts';
import { slice } from '../../src/tier4/topology.ts';

const setup = () => {
  const ex = buildLedgerExample('distributed-host');
  const plan = slice(ex.module, ledgerTelemetry(ex), { symbols: ex.syms });
  const sealer = new CapabilitySealer(new Uint8Array(32).fill(7), () => 100);
  const host = new TopologyHost(ex.module, plan, {
    registry: ex.capabilities, symbols: ex.syms, sealer, clock: () => 100,
  });
  return { ex, host, sealer };
};

test('D1: the topology host executes functions through their planned unit', () => {
  const { ex, host } = setup();
  const result = host.call(ex.symbols.feeFor, [100n]);
  assert.equal(result.ok && result.value, 1n);
  assert.ok(host.unitFor(ex.symbols.feeFor));
});

test('D2/D3: wire calls require sealed authority and expose partition semantics', () => {
  const { ex, host } = setup();
  const alice = host.allocateRecord(ACCOUNT, { id: 'alice', balance: 100n });
  const bob = host.allocateRecord(ACCOUNT, { id: 'bob', balance: 0n });
  const request = {
    id: 'req-1', from: ex.symbols.settle, to: ex.symbols.transfer,
    args: [alice, bob, 10n], capabilities: [],
  } as const;
  const denied = host.dispatch(request);
  assert.equal(denied.ok, false);
  if (!denied.ok) assert.equal(denied.fault.kind, 'authority');

  const authorized = host.dispatch({ ...request, capabilities: host.issueTokens(ex.symbols.transfer) });
  assert.equal(authorized.ok, true);
  const unit = host.unitFor(ex.symbols.transfer)!;
  host.setPartition(unit, true);
  const partitioned = host.dispatch({ ...request, capabilities: host.issueTokens(ex.symbols.transfer) });
  assert.equal(partitioned.ok, false);
  if (!partitioned.ok) {
    assert.equal(partitioned.fault.kind, 'partition');
    assert.equal(partitioned.fault.retryable, true);
    assert.equal(partitioned.fault.committed, false);
  }
});

test('D4/D5: a quiescent function moves live and host traffic becomes slicer telemetry', () => {
  const { ex, host } = setup();
  const target = host.unitFor(ex.symbols.settle)!;
  host.move(ex.symbols.accrue, target);
  assert.equal(host.unitFor(ex.symbols.accrue), target);
  host.call(ex.symbols.feeFor, [100n], ex.symbols.settle);
  host.call(ex.symbols.feeFor, [200n], ex.symbols.settle);
  const telemetry = host.collectTelemetry(2);
  const edge = telemetry.edges.find((candidate) =>
    candidate.from === ex.symbols.settle && candidate.to === ex.symbols.feeFor);
  assert.equal(edge?.callsPerSecond, 1);
  assert.equal(telemetry.functions.find((fn) => fn.symbol === ex.symbols.feeFor)?.selfMs, 0);
});
