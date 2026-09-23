import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { GraphStore } from '../../src/tier1/store.ts';
import type { NodeRef } from '../../src/tier1/ids.ts';
import { Runtime } from '../../src/tier3/runtime.ts';
import { ProductionRuntime } from '../../src/tier3/compile.ts';
import { BrokerEffectRouter, brokerReconcileBoundary } from '../../src/tier3/effects.ts';
import { TopologyHost } from '../../src/tier4/host.ts';
import { slice } from '../../src/tier4/topology.ts';
import { buildLedgerExample, ACCOUNT, CAP_LEDGER_APPEND } from '../../src/examples/ledger.ts';
import { DurableEffectBroker, type EffectAdapter, type EffectBrokerOptions } from '../../src/fabric/effects.ts';
import { domainDigest, type ExecutionManifestV1 } from '../../src/fabric/identity.ts';

const directories: string[] = [];
function directory(): string { const path = mkdtempSync(join(tmpdir(), 'aether-runtime-effects-')); directories.push(path); return path; }
after(() => directories.forEach(path => rmSync(path, { recursive: true, force: true })));
const ex = buildLedgerExample('runtime-effects');
const metadata = domainDigest('aether.fixture/1', 'runtime-integration-test');
const manifest: ExecutionManifestV1 = {
  format: 'aether.execution/1', astRoot: new GraphStore().intern(ex.module), specRoot: metadata,
  dependencies: [], semanticsVersion: 'aether-reference/1', compilerDigest: metadata,
  target: { abiVersion: 'local/1', profileDigest: metadata, artifactDigest: metadata },
  capabilityPolicyDigest: metadata, evidencePolicyDigest: metadata,
};
function settings(): EffectBrokerOptions { return { directory: directory(), clockDomain: 'test/1', clock: () => 1n, authorize: request => request.capabilityGrantRef === 'grant:ledger' }; }
const semantics = { readOnly: false, atomicIdempotency: false, transactional: false, reconciliation: true };
function router(broker: DurableEffectBroker, adapter: EffectAdapter, extra: Partial<ConstructorParameters<typeof BrokerEffectRouter>[0]> = {}) {
  return new BrokerEffectRouter({ broker, manifest, executionId: 'transfer:test', policyEpoch: '1', deadline: '1000',
    adapters: new Map([[CAP_LEDGER_APPEND, adapter]]), grant: () => 'grant:ledger', ...extra });
}
function runtime(kind: 'dev' | 'prod', effectRouter: BrokerEffectRouter) {
  const opts = { registry: ex.capabilities, effectRouter, effects: new Map([[CAP_LEDGER_APPEND, () => { throw new Error('legacy callback must not execute'); }]]) };
  return kind === 'dev' ? new Runtime(opts).load(ex.module) : ProductionRuntime.compile(ex.module, opts);
}

test('F04 integration: both runtimes route effects through durable receipts and idempotent retry', () => {
  for (const kind of ['dev', 'prod'] as const) {
    const opts = settings(); let appends = 0;
    const adapter: EffectAdapter = { id: 'ledger/1', semantics, execute: request => {
      appends++;
      assert.equal(request.payload.tag, 'sequence');
      if (request.payload.tag === 'sequence') assert.deepEqual(request.payload.items.map(v => v.tag), ['string', 'string', 'string', 'int']);
      return { tag: 'null' };
    }, reconcile: () => ({ state: 'committed', value: { tag: 'null' } }) };
    for (let retry = 0; retry < 2; retry++) {
      const rt = runtime(kind, router(new DurableEffectBroker(opts), adapter));
      const a = rt.allocateRecord(ACCOUNT, { id: 'a', balance: 100n });
      const b = rt.allocateRecord(ACCOUNT, { id: 'b', balance: 0n });
      assert.equal(rt.call(ex.symbols.transfer, [a, b, 10n]).ok, true);
      assert.equal(rt.readRecord(a).get('balance'), 90n);
    }
    assert.equal(appends, 1);
    assert.equal(new DurableEffectBroker(opts).events().length, 1);
  }
});

test('F04 integration: replay produces identical transfer state without executing the sink', () => {
  const live = new DurableEffectBroker(settings()); let appends = 0;
  const adapter: EffectAdapter = { id: 'ledger/1', semantics, execute: () => { appends++; return { tag: 'null' }; }, reconcile: () => ({ state: 'unknown' }) };
  const rt = runtime('dev', router(live, adapter));
  const a = rt.allocateRecord(ACCOUNT, { id: 'a', balance: 100n }), b = rt.allocateRecord(ACCOUNT, { id: 'b', balance: 0n });
  assert.equal(rt.call(ex.symbols.transfer, [a, b, 10n]).ok, true);
  const replay = new DurableEffectBroker({ ...settings(), mode: 'replay', replayEvents: live.events(), authorize: () => { throw new Error('live authority forbidden'); } });
  const replayRt = runtime('prod', router(replay, { ...adapter, execute: () => { throw new Error('sink forbidden'); } }));
  const aa = replayRt.allocateRecord(ACCOUNT, { id: 'a', balance: 100n }), bb = replayRt.allocateRecord(ACCOUNT, { id: 'b', balance: 0n });
  assert.equal(replayRt.call(ex.symbols.transfer, [aa, bb, 10n]).ok, true);
  assert.equal(replayRt.readRecord(aa).get('balance'), rt.readRecord(a).get('balance'));
  replay.assertReplayComplete(); assert.equal(appends, 1);
});

test('F04 integration: unknown commit remains structured through development, production and host dispatch', () => {
  for (const kind of ['dev', 'prod', 'host'] as const) {
    let appends = 0;
    const broker = new DurableEffectBroker({ ...settings(), beforePersist: event => { if (event.state === 'committed') throw new Error('receipt disk failure'); } });
    const adapter: EffectAdapter = { id: 'ledger/1', semantics, execute: () => { appends++; return { tag: 'null' }; }, reconcile: () => ({ state: 'unknown' }) };
    const bound = router(broker, adapter);
    if (kind === 'host') {
      const host = new TopologyHost(ex.module, slice(ex.module, { edges: [], functions: [] }, { shape: 'containers' }), { registry: ex.capabilities, effectRouter: bound });
      const a = host.allocateRecord(ACCOUNT, { id: 'a', balance: 100n }), b = host.allocateRecord(ACCOUNT, { id: 'b', balance: 0n });
      const result = host.dispatch({ id: 'request', from: null, to: ex.symbols.transfer, args: [a, b, 10n], capabilities: host.issueTokens(ex.symbols.transfer), timeoutMs: -1 });
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.fault.kind, 'indeterminate'); assert.equal(result.fault.committed, null);
        assert.equal(result.fault.retryable, false); assert.ok(result.fault.recoveryId);
      }
    } else {
      const rt = runtime(kind, bound);
      const a = rt.allocateRecord(ACCOUNT, { id: 'a', balance: 100n }), b = rt.allocateRecord(ACCOUNT, { id: 'b', balance: 0n });
      const result = rt.call(ex.symbols.transfer, [a, b, 10n]);
      assert.equal(result.ok, false);
      if (!result.ok) { assert.equal(result.fault.kind, 'effect_indeterminate'); assert.ok(result.fault.recoveryId); }
    }
    assert.equal(appends, 1);
    assert.equal(broker.events()[0].state, 'indeterminate');
  }
});

test('F04 integration: code identity and isolated fork authority are enforced before dispatch', () => {
  const broker = new DurableEffectBroker(settings()); let calls = 0;
  const adapter: EffectAdapter = { id: 'ledger/1', semantics, execute: () => { calls++; return { tag: 'null' }; }, reconcile: () => ({ state: 'unknown' }) };
  const bound = router(broker, adapter);
  const other = buildLedgerExample('different-module');
  assert.throws(() => new Runtime({ registry: ex.capabilities, effectRouter: bound }).load(other.module), /manifest/);
  assert.throws(() => ProductionRuntime.compile(other.module, { registry: ex.capabilities, effectRouter: bound }), /manifest/);
  const rt = runtime('dev', bound) as Runtime;
  assert.throws(() => rt.fork(), /isolated effect router/);
  const shared = router(broker, adapter, { isolatedFork: () => router(broker, adapter) });
  assert.throws(() => (runtime('dev', shared) as Runtime).fork(), /live effect authority/);
  const isolated = new DurableEffectBroker({ ...settings(), mode: 'speculative' });
  const live = router(broker, adapter, { isolatedFork: () => router(isolated, adapter, { branchId: 'fork:1' }) });
  const fork = (runtime('dev', live) as Runtime).fork();
  const a = fork.allocateRecord(ACCOUNT, { id: 'a', balance: 100n }), b = fork.allocateRecord(ACCOUNT, { id: 'b', balance: 0n });
  const outcome = fork.call(ex.symbols.transfer, [a, b, 10n]);
  assert.equal(outcome.ok, false); // buffered intent is explicitly pending, not fabricated success
  assert.equal(isolated.intents().length, 1); assert.equal(calls, 0);
});

test('authorized broker recovery rejects altered host arguments before querying sink status', () => {
  const opts = { ...settings(), beforePersist: (event: { state: string }) => {
    if (event.state === 'committed') throw new Error('receipt write failed');
  } };
  let executions = 0, reconciliations = 0;
  const adapter: EffectAdapter = { id: 'ledger/1', semantics,
    execute: () => { executions++; return { tag: 'null' }; },
    reconcile: () => { reconciliations++; return { state: 'committed', value: { tag: 'null' } }; } };
  const live = router(new DurableEffectBroker(opts), adapter); live.bind(manifest.astRoot as NodeRef);
  assert.throws(() => live.invoke(CAP_LEDGER_APPEND, ['a', 'b', 10n]), /effect_indeterminate/);
  const recovery = router(new DurableEffectBroker({ ...opts, beforePersist: undefined,
    authorizeReconciliation: () => true }), adapter);
  recovery.bind(manifest.astRoot as NodeRef);
  const correct = [{ tag: 'string' as const, value: 'a' }, { tag: 'string' as const, value: 'b' },
    { tag: 'int' as const, value: '10' }];
  assert.throws(() => brokerReconcileBoundary(recovery, CAP_LEDGER_APPEND,
    [...correct.slice(0, 2), { tag: 'int', value: '11' }], 'operation-0'), /exact host boundary/);
  assert.equal(reconciliations, 0);
  assert.equal(brokerReconcileBoundary(recovery, CAP_LEDGER_APPEND, correct, 'operation-0').state, 'committed');
  assert.equal(executions, 1); assert.equal(reconciliations, 1);
});
