import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DurableEffectBroker, effectPayloadDigest, effectReplayOutcomeDigest, type EffectAdapter, type EffectRequestV1 } from '../../src/fabric/effects.ts';
import { domainDigest } from '../../src/fabric/identity.ts';
const directories: string[] = [];
const temporary = () => { const directory = mkdtempSync(join(tmpdir(), 'aether-replay-prefix-')); directories.push(directory); return directory; };
after(() => directories.forEach(directory => rmSync(directory, { recursive: true, force: true })));

test('isolated replay prefix rewind/resume checks complete ordered request/outcome bindings without callbacks', () => {
  let calls = 0;
  const adapter: EffectAdapter = { id: 'counter', semantics: { readOnly: false, atomicIdempotency: true, transactional: false, reconciliation: false }, execute: () => ({ tag: 'int', value: String(++calls) }) };
  const live = new DurableEffectBroker({ directory: temporary(), clockDomain: 'test', clock: () => 1n, authorize: () => true });
  const requests: EffectRequestV1[] = [0, 1].map(index => { const payload = { tag: 'int' as const, value: String(index) }; return { format: 'aether.effect/1', executionId: 'execution', effectId: `effect-${index}`, branchId: null, executionManifest: domainDigest('aether.execution/1', 'manifest'), capabilityGrantRef: 'grant', policyEpoch: '0', payloadDigest: effectPayloadDigest(payload), payload, budgetReservationId: null, deadline: '100' }; });
  requests.forEach(request => live.dispatch(request, adapter)); const events = live.events();
  const prefix = events.map(event => ({ requestDigest: event.requestDigest, outcomeDigest: effectReplayOutcomeDigest(event.outcome!) }));
  assert.throws(() => live.restoreReplayPrefix([]), /live broker/);
  for (const mode of ['replay', 'shadow', 'speculative'] as const) {
    const forbidden = () => { throw new Error('unexpected live callback'); };
    const replay = new DurableEffectBroker({ directory: temporary(), mode, clockDomain: 'test', authorize: forbidden, authorizeReconciliation: forbidden, authorizeBranch: forbidden, budgets: { reserve: forbidden, consume: forbidden, release: forbidden }, replayEvents: events });
    replay.restoreReplayPrefix(prefix.slice(0, 1)); assert.equal(replay.replayRemaining, 1);
    assert.throws(() => replay.restoreReplayPrefix([...prefix, prefix[0]]), /size/); assert.equal(replay.replayRemaining, 1);
    assert.throws(() => replay.restoreReplayPrefix([prefix[0], prefix[0]]), /duplicate/); assert.equal(replay.replayRemaining, 1);
    assert.throws(() => replay.restoreReplayPrefix([{ ...prefix[0], outcomeDigest: domainDigest('aether.effect-replay-outcome/1', 'wrong') }]), /mismatch/); assert.equal(replay.replayRemaining, 1);
    assert.deepEqual(replay.dispatch(requests[1], { ...adapter, execute: forbidden }), events[1].outcome); replay.assertReplayComplete();
    replay.restoreReplayPrefix([]); assert.equal(replay.replayRemaining, 2);
    assert.deepEqual(replay.dispatch(requests[0], { ...adapter, execute: forbidden }), events[0].outcome);
  }
  assert.equal(calls, 2);
});

test('isolated buffer restoration is atomic, preserves historical identities and never grants live authority', () => {
  const forbidden = () => { throw new Error('unexpected callback'); };
  const broker = new DurableEffectBroker({ directory: temporary(), mode: 'speculative', clockDomain: 'test', authorize: forbidden, authorizeBranch: forbidden, authorizeReconciliation: forbidden, budgets: { reserve: forbidden, consume: forbidden, release: forbidden } });
  const adapter: EffectAdapter = { id: 'unused', semantics: { readOnly: false, atomicIdempotency: true, transactional: false, reconciliation: false }, execute: forbidden };
  const request = (index: number, value = index): EffectRequestV1 => { const payload = { tag: 'int' as const, value: String(value) }; return { format: 'aether.effect/1', executionId: 'execution', effectId: `effect-${index}`, branchId: 'branch', executionManifest: domainDigest('aether.execution/1', 'manifest'), capabilityGrantRef: 'grant', policyEpoch: '0', payloadDigest: effectPayloadDigest(payload), payload, budgetReservationId: null, deadline: '100' }; };
  broker.dispatch(request(0), adapter); broker.dispatch(request(1), adapter);
  const saved = { prefix: [], bufferedIntents: broker.intents() };
  broker.restoreIsolatedState({ prefix: [], bufferedIntents: saved.bufferedIntents.slice(0, 1) });
  const before = broker.intents();
  for (const bufferedIntents of [[request(0), request(1, 99)], [request(1), request(0)], [request(0), { ...request(1), executionId: 'other' }], [request(0), request(0)]]) {
    assert.throws(() => broker.restoreIsolatedState({ prefix: [], bufferedIntents })); assert.deepEqual(broker.intents(), before); assert.equal(broker.replayRemaining, 0);
  }
  assert.throws(() => broker.dispatch(request(1, 99), adapter), /identity_conflict/);
  assert.throws(() => broker.restoreIsolatedState({ prefix: [], bufferedIntents: Array(100001).fill(request(0)) }), /size/); assert.deepEqual(broker.intents(), before);
  const fresh = new DurableEffectBroker({ directory: temporary(), mode: 'shadow', clockDomain: 'test', authorize: forbidden }); fresh.restoreIsolatedState(saved); assert.deepEqual(fresh.intents(), saved.bufferedIntents);
  const live = new DurableEffectBroker({ directory: temporary(), clockDomain: 'test', authorize: forbidden }); assert.throws(() => live.restoreIsolatedState({ prefix: [], bufferedIntents: [] }), /live broker/);
});
