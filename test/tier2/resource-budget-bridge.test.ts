import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { DurableEffectBroker, effectPayloadDigest } from '../../src/fabric/effects.ts';
import { encodeCanonical } from '../../src/fabric/encoding.ts';
import { ResourceBudgetBridge } from '../../src/tier2/resource-budget-bridge.ts';
import { openBridgeFixture, effectRequest, amount } from './resource-budget-bridge-fixture.ts';
const temp = () => mkdtempSync(join(tmpdir(), 'aether-budget-bridge-'));
const same = (a: unknown, b: unknown) => assert.deepEqual(encodeCanonical(a), encodeCanonical(b));
test('actual broker dispatch reserves before sink, charges once, and returns only unused handles across restart', () => {
  const directory = temp(); try {
    const f = openBridgeFixture(directory), request = effectRequest(), result = f.broker.dispatch(request, f.adapter);
    assert.equal(result.state, 'committed'); assert.equal(f.sink(request)!.commits, 1);
    same(f.ledger.snapshot('budget-service').spent, amount(7)); same(f.ledger.snapshot('budget-service').available, amount(3));
    same(f.broker.dispatch(request, f.adapter), result); const reopened = openBridgeFixture(directory); same(reopened.broker.dispatch(request, reopened.adapter), result);
    const records = reopened.bridge.records(); assert.equal(records.length, 1); assert.equal(records[0].reserve.operation.kind, 'reserve');
    if (records[0].reserve.operation.kind === 'reserve') assert.equal(records[0].reserve.operation.start, true);
    assert.equal(records[0].settlementReceipt!.refunded.tokens, '3'); assert.equal(reopened.sink(request)!.commits, 1);
    assert.equal(reopened.bridge.reserve(request), false, 'terminal grant cannot regain dispatch permission');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
test('declared exhaustion outcome selects a host fallback and never dispatches a second sink operation', () => {
  const directory = temp(); try {
    const f = openBridgeFixture(directory); assert.equal(f.broker.dispatch(effectRequest(), f.adapter).state, 'committed');
    const request = effectRequest('other-effect'), result = f.broker.dispatch(request, f.adapter); same(result, { state: 'rejected', code: 'budget_exhausted' });
    const selectedPath = result.state === 'rejected' && result.code === 'budget_exhausted' ? 'declared-host-fallback' : 'normal'; assert.equal(selectedPath, 'declared-host-fallback');
    assert.equal(f.sink(request), null); same(f.ledger.snapshot('budget-service').spent, amount(7));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
test('transactional revocation abort writes terminal evidence before refunding the inflight reservation', () => {
  const directory = temp(); try {
    let allowed = true;
    const f = openBridgeFixture(directory, { authorize: () => allowed, afterPrepare: () => { allowed = false; } }), request = effectRequest();
    same(f.broker.dispatch(request, f.adapter), { state: 'rejected', code: 'authorization_denied' });
    assert.equal(f.sink(request)!.state, 'not_committed'); same(f.ledger.snapshot('budget-service').available, amount(10)); same(f.ledger.snapshot('budget-service').spent, amount(0));
    assert.equal(f.bridge.records()[0].settlement!.operation.kind, 'refund');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
test('nontransactional predispatch refusal refunds only after durable broker noncommit', () => {
  const directory = temp(); try {
    let allowed = true;
    const f = openBridgeFixture(directory, { transactional: false, authorize: () => allowed, brokerFault: event => { if (event.dispatchStarted) allowed = false; } }), request = effectRequest();
    assert.deepEqual(f.broker.dispatch(request, f.adapter), { state: 'rejected', code: 'authorization_denied' });
    assert.equal(f.sink(request), null); same(f.ledger.snapshot('budget-service').inflight, amount(0));
    same(f.ledger.snapshot('budget-service').available, amount(10));
    assert.equal(f.bridge.records()[0].settlement?.operation.kind, 'refund');
    const event = f.broker.events()[0]; assert.equal(event.state, 'rejected'); assert.equal(event.dispatchStarted, false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
test('missing sink and missing terminal broker decision leave nontransactional funds inflight', () => {
  const directory = temp(); try {
    const f = openBridgeFixture(directory, { transactional: false }), request = effectRequest();
    assert.equal(f.bridge.reserve(request), true);
    assert.throws(() => f.bridge.release(request), /indeterminate/);
    assert.equal(f.sink(request), null); same(f.ledger.snapshot('budget-service').inflight, amount(10));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
test('process death at each terminal refund handoff recovers the exact broker noncommit', () => {
  for (const phase of ['after-intent', 'after-ledger', 'after-receipt'] as const) {
    const directory = temp(); try {
      openBridgeFixture(directory, { transactional: false });
      const code = `const {openBridgeFixture,effectRequest}=await import(${JSON.stringify(pathToFileURL(resolve('test/tier2/resource-budget-bridge-fixture.ts')).href)});
      let allowed=true;const f=openBridgeFixture(${JSON.stringify(directory)},{transactional:false,authorize:()=>allowed,
        brokerFault:event=>{if(event.dispatchStarted)allowed=false;},
        bridgeFault:(point,operation)=>{if(point===${JSON.stringify(phase)}&&operation==='refund')process.kill(process.pid,'SIGKILL');}});
      f.broker.dispatch(effectRequest(),f.adapter);`;
      const child = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', code], { encoding: 'utf8' });
      assert.equal(child.signal, 'SIGKILL', child.stderr);
      const f = openBridgeFixture(directory, { transactional: false }), request = effectRequest();
      f.broker.recoverDeadWriter();
      const event = f.broker.events()[0]; assert.equal(event.state, 'rejected'); assert.equal(event.dispatchStarted, false);
      assert.equal(f.sink(request), null);
      same(f.ledger.snapshot('budget-service').inflight, amount(phase === 'after-intent' ? 10 : 0));
      same(f.broker.dispatch(request, f.adapter), { state: 'rejected', code: 'authorization_denied' });
      same(f.ledger.snapshot('budget-service').available, amount(10)); same(f.ledger.snapshot('budget-service').inflight, amount(0));
      const sequence = f.ledger.snapshot('budget-service').sequence;
      same(f.broker.reconcile(request, f.adapter), { state: 'rejected', code: 'authorization_denied' });
      assert.equal(f.ledger.snapshot('budget-service').sequence, sequence);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }
});
test('sink-committed uncertainty reconciles the same effect without a second dispatch or charge', () => {
  const directory = temp(); try {
    const f = openBridgeFixture(directory, { afterSink: () => { throw new Error('lost acknowledgment'); } }), request = effectRequest();
    assert.equal(f.broker.dispatch(request, f.adapter).state, 'indeterminate'); same(f.ledger.snapshot('budget-service').spent, amount(0)); same(f.ledger.snapshot('budget-service').inflight, amount(10));
    const reopened = openBridgeFixture(directory); assert.equal(reopened.broker.reconcile(request, reopened.adapter).state, 'committed');
    same(reopened.ledger.snapshot('budget-service').spent, amount(7)); assert.equal(reopened.sink(request)!.commits, 1);
    assert.equal(reopened.broker.reconcile(request, reopened.adapter).state, 'committed'); same(reopened.ledger.snapshot('budget-service').spent, amount(7));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
test('actual replay/shadow/speculative brokers do not call budget hooks, and direct isolated hooks refuse', () => {
  const directory = temp(); try {
    const f = openBridgeFixture(directory), request = effectRequest(), result = f.broker.dispatch(request, f.adapter), before = f.ledger.snapshot('budget-service').sequence;
    const replay = new DurableEffectBroker({ ...f.brokerOptions, directory: join(directory, 'replay'), mode: 'replay', replayEvents: f.broker.events(), budgets: { reserve() { throw new Error('live budget'); }, consume() { throw new Error('live budget'); }, release() { throw new Error('live budget'); } } });
    same(replay.dispatch(request, f.adapter), result); assert.equal(f.ledger.snapshot('budget-service').sequence, before);
    for (const mode of ['shadow', 'speculative'] as const) {
      const isolated = new DurableEffectBroker({ ...f.brokerOptions, directory: join(directory, mode), mode });
      assert.equal(isolated.dispatch({ ...request, branchId: 'isolated' }, f.adapter).state, 'rejected');
      const bridge = new ResourceBudgetBridge({ directory: join(directory, `bridge-${mode}`), profile: f.profile, ledger: f.ledger, key: readFileSync(f.keyPath, 'utf8'), mode: () => mode, authorize: () => true, observe: f.observe });
      assert.throws(() => bridge.reserve(request), /isolated/); assert.throws(() => bridge.release(request), /isolated/); assert.equal(f.ledger.snapshot('budget-service').sequence, before);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
test('changed request/result and forged bridge journal are refused without billing another effect', () => {
  const directory = temp(); try {
    const f = openBridgeFixture(directory), request = effectRequest(); assert.equal(f.broker.dispatch(request, f.adapter).state, 'committed');
    const payload = { tag: 'string' as const, value: 'changed' };
    assert.throws(() => f.bridge.reserve({ ...request, payload, payloadDigest: effectPayloadDigest(payload) }), /identity conflict/);
    assert.throws(() => f.bridge.consume(request, { tag: 'int', value: '99' }), /result changed/);
    const path = join(directory, 'bridge', 'bridge.json'), row = JSON.parse(readFileSync(path, 'utf8')); row.body.records[0].settlementReceipt.charged.tokens = '0'; writeFileSync(path, JSON.stringify(row));
    assert.throws(() => f.bridge.records(), /forged/); same(f.ledger.snapshot('budget-service').spent, amount(7));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
test('noncanonical base64 spelling of a valid journal signature is rejected', () => {
  const directory = temp(); try {
    const f = openBridgeFixture(directory), path = join(directory, 'bridge', 'bridge.json');
    const envelope = JSON.parse(readFileSync(path, 'utf8')) as { body: unknown; signature: string };
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const index = alphabet.indexOf(envelope.signature[85]);
    assert.ok(index >= 0); envelope.signature = envelope.signature.slice(0, 85) + alphabet[(index & ~3) | ((index + 1) & 3)] + '==';
    writeFileSync(path, JSON.stringify(envelope));
    assert.throws(() => f.bridge.records(), /forged budget bridge journal/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
test('actual SIGKILL at bridge/ledger handoff boundaries preserves reservations and terminal charges', () => {
  for (const operation of ['reserve', 'consume'] as const) for (const phase of ['after-intent', 'after-ledger', 'after-receipt'] as const) {
    const directory = temp(); try {
      openBridgeFixture(directory);
      const code = `const {openBridgeFixture,effectRequest}=await import(${JSON.stringify(pathToFileURL(resolve('test/tier2/resource-budget-bridge-fixture.ts')).href)});
        const f=openBridgeFixture(${JSON.stringify(directory)},{bridgeFault:(phase,operation)=>{if(phase===${JSON.stringify(phase)}&&operation===${JSON.stringify(operation)})process.kill(process.pid,'SIGKILL');}});
        f.broker.dispatch(effectRequest(),f.adapter);`;
      const child = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', code], { encoding: 'utf8' }); assert.equal(child.signal, 'SIGKILL', child.stderr);
      const f = openBridgeFixture(directory), request = effectRequest();
      f.broker.recoverDeadWriter();
      const recovered = f.broker.reconcile(request, f.adapter);
      assert.equal(recovered.state, operation === 'reserve' ? 'aborted' : 'committed');
      same(f.ledger.snapshot('budget-service').spent, amount(operation === 'reserve' ? 0 : 7)); same(f.ledger.snapshot('budget-service').inflight, amount(0));
      assert.equal(f.sink(request)!.commits, operation === 'reserve' ? 0 : 1);
      const before = f.ledger.snapshot('budget-service').sequence; same(f.broker.reconcile(request, f.adapter), recovered); assert.equal(f.ledger.snapshot('budget-service').sequence, before);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }
});
