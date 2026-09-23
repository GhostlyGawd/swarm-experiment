import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DurableEffectBroker, effectPayloadDigest, type EffectAdapter, type EffectRequestV1 } from '../../src/fabric/effects.ts';
import { createEffectJournalWitness, type WitnessHead } from '../../src/fabric/effect-journal-witness.ts';
import { encodeCanonical } from '../../src/fabric/encoding.ts';
import { domainDigest } from '../../src/fabric/identity.ts';

const dirs: string[] = [];
after(() => dirs.forEach(directory => rmSync(directory, { recursive: true, force: true })));
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'aether-witness-')); dirs.push(directory);
  const file = join(directory, 'effects-v2.json');
  let head: WitnessHead = { revision: '0', journal: null };
  let failAfterPublish: ((journal: string) => boolean) | null = null;
  const witness = createEffectJournalWitness({ authorityId: 'operator:test', repositoryId: 'repo:test',
    deploymentId: 'deployment:test', clockDomain: 'witness-clock/1', read: () => head,
    advance(expected, journal) {
      assert.equal(head.revision, expected, 'witness CAS must not admit a stale writer');
      head = { revision: String(BigInt(expected) + 1n), journal };
      if (failAfterPublish?.(journal)) throw new Error('witness response lost after durable CAS');
      return head;
    } });
  const opts = { directory, clockDomain: 'witness-clock/1', clock: () => 100n,
    authorize: () => true, authorizeReconciliation: () => true, witness };
  const payload = { tag: 'sequence' as const, items: [{ tag: 'string' as const, value: 'cap:test' }] };
  const request: EffectRequestV1 = { format: 'aether.effect/1', executionId: 'execution:test', effectId: 'effect:test',
    branchId: null, executionManifest: domainDigest('aether.execution/1', 'test'), capabilityGrantRef: 'grant:test',
    policyEpoch: '1', payload, payloadDigest: effectPayloadDigest(payload), budgetReservationId: null, deadline: '1000' };
  let calls = 0;
  const adapter: EffectAdapter = { id: 'adapter:test', semantics: { readOnly: false, atomicIdempotency: true,
    transactional: false, reconciliation: true }, execute() { calls++; return { tag: 'int', value: '7' }; },
    reconcile() { return { state: 'not_committed' }; } };
  return { directory, file, witness, opts, request, adapter, calls: () => calls,
    head: () => head, setHead: (value: WitnessHead) => { head = value; },
    failAfterPublish: (predicate: ((journal: string) => boolean) | null) => { failAfterPublish = predicate; } };
}

test('V2 witnessed broker refuses recomputed local terminal receipts and restores deleted/older files', () => {
  const f = fixture(), broker = new DurableEffectBroker(f.opts);
  const receipt = broker.dispatch(f.request, f.adapter);
  assert.equal(receipt.state, 'committed'); assert.equal(f.calls(), 1);
  assert.equal(f.head().revision, '5');
  const observer = new DurableEffectBroker({ ...f.opts,
    authorize: () => { throw new Error('inspection reached live authority'); },
    authorizeReconciliation: () => { throw new Error('inspection reached cleanup authority'); } });
  const passive = { ...f.adapter, execute: () => { throw new Error('inspection reached the sink'); },
    reconcile: () => { throw new Error('inspection reached sink status'); } };
  assert.deepEqual(encodeCanonical(observer.inspectRecorded(f.request, passive)), encodeCanonical(receipt));
  assert.equal(observer.inspectRecorded({ ...f.request, effectId: 'effect:missing' }, passive), null);
  const committed = readFileSync(f.file, 'utf8');
  const forged = JSON.parse(committed);
  forged.records[0].outcome.value.value = '999';
  forged.records[0].outcome.receiptDigest = domainDigest('aether.effect-receipt/1', {
    requestDigest: forged.records[0].requestDigest, adapterId: forged.records[0].adapterId,
    adapterSemanticsDigest: forged.records[0].adapterSemanticsDigest,
    observedAt: forged.records[0].observedAt, value: forged.records[0].outcome.value });
  writeFileSync(f.file, encodeCanonical(forged));
  assert.throws(() => new DurableEffectBroker(f.opts).dispatch(f.request, f.adapter), /diverges from witness/);
  assert.equal(f.calls(), 1);
  writeFileSync(f.file, committed);
  unlinkSync(f.file);
  assert.deepEqual(encodeCanonical(new DurableEffectBroker(f.opts).dispatch(f.request, f.adapter)), encodeCanonical(receipt));
  assert.equal(readFileSync(f.file, 'utf8'), committed);
  const prior = { ...JSON.parse(committed), revision: '4' };
  writeFileSync(f.file, encodeCanonical(prior));
  assert.deepEqual(encodeCanonical(new DurableEffectBroker(f.opts).dispatch(f.request, f.adapter)), encodeCanonical(receipt));
  assert.equal(readFileSync(f.file, 'utf8'), committed);
  assert.equal(f.calls(), 1);
  assert.throws(() => new DurableEffectBroker({ ...f.opts, witness: undefined }), /original authority/);
  assert.throws(() => new DurableEffectBroker({ ...f.opts, witness: createEffectJournalWitness({
    authorityId: 'operator:test', repositoryId: 'repo:other', deploymentId: 'deployment:test',
    clockDomain: 'witness-clock/1', read: f.head, advance: () => { throw new Error('must not advance'); } }) }).events(), /identity\/canonical mismatch/);
});

test('uncertain witness response after pre-sink marker never dispatches and reopens from witnessed state', () => {
  const f = fixture();
  f.failAfterPublish(journal => JSON.parse(journal).records[0].dispatchStarted === true);
  assert.throws(() => new DurableEffectBroker(f.opts).dispatch(f.request, f.adapter), /response lost/);
  assert.equal(f.calls(), 0);
  assert.ok(existsSync(f.file));
  assert.equal(JSON.parse(readFileSync(f.file, 'utf8')).revision, '3');
  assert.equal(f.head().revision, '4');
  f.failAfterPublish(null);
  const reopened = new DurableEffectBroker(f.opts);
  assert.deepEqual(reopened.reconcile(f.request, f.adapter), { state: 'aborted', code: 'sink_confirmed_not_committed' });
  assert.equal(f.calls(), 0);
  assert.equal(reopened.events()[0].dispatchStarted, true);
  assert.equal(f.head().revision, '5');
});

test('same-anchor witness rollback and local V1 adoption fail closed', () => {
  const f = fixture();
  new DurableEffectBroker(f.opts).dispatch(f.request, f.adapter);
  f.setHead({ revision: '0', journal: null });
  assert.throws(() => new DurableEffectBroker(f.opts).events(), /rolled back/);
  const legacy = fixture();
  writeFileSync(join(legacy.directory, 'effects.json'), '{}');
  assert.throws(() => new DurableEffectBroker(legacy.opts), /explicit offline migration/);
});
