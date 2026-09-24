import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { after, test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAttestedSinkAdapter, type AttestedSinkStatusV1 } from '../../src/fabric/attested-sink-adapter.ts';
import { createEffectJournalWitness, createNamespacedEffectJournalWitness, type WitnessHead } from '../../src/fabric/effect-journal-witness.ts';
import { encodeCanonical, type TaggedValueV1 } from '../../src/fabric/encoding.ts';
import { DurableEffectBroker, effectPayloadDigest, effectRequestDigest, type EffectAdapter, type EffectBrokerOptions, type EffectRequestV1 } from '../../src/fabric/effects.ts';
import { domainDigest } from '../../src/fabric/identity.ts';
import { signSinkReceipt, sinkValueDigest, type SignedSinkReceiptV1, type SinkPublicAnchorV1, type SinkReceiptBodyV1 } from '../../src/fabric/sink-receipt.ts';

const directories: string[] = [];
after(() => directories.forEach(directory => rmSync(directory, { recursive: true, force: true })));
const value: TaggedValueV1 = { tag: 'int', value: '9' };
const payload: TaggedValueV1 = { tag: 'sequence', items: [{ tag: 'string', value: 'cap:test:write' }] };
const artifact = domainDigest('aether.effect-adapter-artifact/2', 'approved source');

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'aether-attested-broker-')); directories.push(directory);
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const anchor: SinkPublicAnchorV1 = { format: 'aether.sink-anchor/1', repositoryId: 'repo:test',
    sinkAuthorityId: 'authority:sink', sinkId: 'sink:test', keyId: 'key:test', keyEpoch: '1',
    publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64') };
  const request: EffectRequestV1 = { format: 'aether.effect/1', executionId: 'execution:test', effectId: 'effect:test',
    branchId: null, executionManifest: domainDigest('aether.execution/1', 'program'),
    capabilityGrantRef: 'grant:test', policyEpoch: '1', payloadDigest: effectPayloadDigest(payload),
    payload, budgetReservationId: null, deadline: '1000' };
  const signed = (disposition: SinkReceiptBodyV1['disposition'], override: Partial<SinkReceiptBodyV1> = {}): SignedSinkReceiptV1 => {
    const body: SinkReceiptBodyV1 = { format: 'aether.sink-receipt-body/1', repositoryId: anchor.repositoryId,
      deploymentId: 'deployment:test', executionId: request.executionId, effectId: request.effectId,
      requestDigest: effectRequestDigest(request), payloadDigest: request.payloadDigest,
      sinkAuthorityId: anchor.sinkAuthorityId, sinkId: anchor.sinkId, adapterArtifactDigest: artifact,
      policyEpoch: request.policyEpoch, capabilityGrantRef: request.capabilityGrantRef,
      keyId: anchor.keyId, keyEpoch: anchor.keyEpoch, disposition,
      valueDigest: disposition === 'committed' ? sinkValueDigest(value) : null,
      decisionId: 'decision:test', commitId: disposition === 'committed' ? 'commit:test' : null,
      sinkSequence: '1', ...override };
    return signSinkReceipt(body, privateKey, anchor);
  };
  const file = join(directory, 'effects-v3.json');
  let head: WitnessHead = { revision: '0', journal: null };
  const witness = () => createNamespacedEffectJournalWitness({ authorityId: 'operator:test',
    repositoryId: anchor.repositoryId, catalogDeploymentId: 'deployment:test', operationId: 'operation:test',
    clockDomain: 'clock:test', read: () => head, advance(expected, journal) {
      assert.equal(head.revision, expected);
      head = { revision: String(BigInt(expected) + 1n), journal };
      return head;
    } });
  let dispatches = 0, statusCalls = 0, decision: AttestedSinkStatusV1 = { state: 'unknown' };
  let executeFault = false;
  const adapter = () => createAttestedSinkAdapter({ id: 'adapter:test', repositoryId: anchor.repositoryId,
    deploymentId: 'deployment:test', approvedAdapterArtifactDigest: artifact, anchor,
    client: { execute() {
      dispatches++;
      if (executeFault) throw new Error('sink transport lost after marker');
      const committed = { state: 'committed' as const, value, receipt: signed('committed') };
      decision = committed; return committed;
    }, status() { statusCalls++; return decision; } } });
  const options = (extra: Partial<EffectBrokerOptions> = {}): EffectBrokerOptions => ({
    directory, clockDomain: 'clock:test', clock: () => 100n, authorize: () => true,
    authorizeReconciliation: () => true, witness: witness(),
    attestedSink: { anchor, deploymentId: 'deployment:test', approvedAdapterArtifactDigest: artifact }, ...extra,
  });
  return { directory, file, request, anchor, signed, adapter, options, witness, dispatches: () => dispatches,
    statusCalls: () => statusCalls, head: () => head, setHead: (next: WitnessHead) => { head = next; },
    setDecision: (next: AttestedSinkStatusV1) => { decision = next; },
    failExecute: () => { executeFault = true; } };
}

test('V3 retains an exact signed receipt and rechecks it on cached dispatch, inspect, reconcile, and replay', () => {
  const f = fixture(), a = f.adapter(), broker = new DurableEffectBroker(f.options());
  const result = broker.dispatch(f.request, a);
  assert.equal(result.state, 'committed'); assert.equal(f.dispatches(), 1);
  const event = broker.events()[0];
  assert.equal(event.format, 'aether.effect-event/3');
  assert.deepEqual(encodeCanonical(event.signedSinkReceipt), encodeCanonical(f.signed('committed')));
  assert.equal(JSON.parse(readFileSync(f.file, 'utf8')).format, 'aether.effect-journal/3');
  const passive = f.adapter();
  const reopened = new DurableEffectBroker(f.options({ authorize: () => { throw new Error('cached read reached live grant'); },
    authorizeReconciliation: () => { throw new Error('cached read reached cleanup grant'); } }));
  assert.deepEqual(encodeCanonical(reopened.dispatch(f.request, passive)), encodeCanonical(result));
  assert.deepEqual(encodeCanonical(reopened.inspectRecorded(f.request, passive)), encodeCanonical(result));
  assert.deepEqual(encodeCanonical(reopened.reconcile(f.request, passive)), encodeCanonical(result));
  assert.equal(f.dispatches(), 1); assert.equal(f.statusCalls(), 0);
  const replay = new DurableEffectBroker(f.options({ mode: 'replay', replayEvents: broker.events() }));
  assert.deepEqual(encodeCanonical(replay.dispatch(f.request, passive)), encodeCanonical(result));
  replay.assertReplayComplete();
  assert.equal(f.dispatches(), 1);
});

test('V3 crash after sink success is indeterminate until receipt-backed read-only reconciliation', () => {
  const f = fixture(), a = f.adapter();
  const broken = new DurableEffectBroker(f.options({ beforePersist(event) {
    if (event.state === 'committed' || event.state === 'indeterminate') throw new Error('journal write lost');
  } }));
  assert.deepEqual(broken.dispatch(f.request, a), { state: 'indeterminate', recoveryId: effectRequestDigest(f.request) });
  assert.equal(f.dispatches(), 1);
  const marker = JSON.parse(readFileSync(f.file, 'utf8'));
  assert.equal(marker.records[0].state, 'prepared'); assert.equal(marker.records[0].dispatchStarted, true);
  assert.equal(marker.records[0].signedSinkReceipt, null);
  const reopened = new DurableEffectBroker(f.options());
  assert.equal(reopened.dispatch(f.request, f.adapter()).state, 'indeterminate');
  assert.equal(f.dispatches(), 1);
  assert.equal(reopened.reconcile(f.request, f.adapter()).state, 'committed');
  assert.deepEqual(encodeCanonical(reopened.events()[0].signedSinkReceipt), encodeCanonical(f.signed('committed')));
  assert.equal(f.dispatches(), 1); assert.equal(f.statusCalls(), 1);
});

test('V3 will not certify a forged sink commit or reuse an unsigned structural adapter', () => {
  const f = fixture();
  const structural: EffectAdapter = { id: 'adapter:test', semantics: { readOnly: false, atomicIdempotency: true,
    transactional: false, reconciliation: true }, execute: () => value, reconcile: () => ({ state: 'committed', value }) };
  const broker = new DurableEffectBroker(f.options());
  assert.throws(() => broker.dispatch(f.request, structural), /attested sink adapter/i);
  assert.equal(f.dispatches(), 0);
  const forged = f.signed('committed', { capabilityGrantRef: 'grant:other' });
  const bad = createAttestedSinkAdapter({ id: 'adapter:test', repositoryId: f.anchor.repositoryId,
    deploymentId: 'deployment:test', approvedAdapterArtifactDigest: artifact, anchor: f.anchor,
    client: { execute: () => ({ state: 'committed', value, receipt: forged }),
      status: () => ({ state: 'committed', value, receipt: forged }) } });
  assert.equal(broker.dispatch(f.request, bad).state, 'indeterminate');
  assert.equal(broker.reconcile(f.request, bad).state, 'indeterminate');
  assert.equal(broker.events()[0].signedSinkReceipt, null);
});

test('V3 verifies a signed durable noncommit fence before terminal abort', () => {
  const f = fixture(); f.failExecute();
  f.setDecision({ state: 'not_committed', receipt: f.signed('not_committed') });
  const broker = new DurableEffectBroker(f.options());
  assert.equal(broker.dispatch(f.request, f.adapter()).state, 'indeterminate');
  assert.deepEqual(broker.reconcile(f.request, f.adapter()), { state: 'aborted', code: 'sink_confirmed_not_committed' });
  assert.deepEqual(encodeCanonical(broker.events()[0].signedSinkReceipt), encodeCanonical(f.signed('not_committed')));
  assert.equal(new DurableEffectBroker(f.options()).events()[0].state, 'aborted');
  assert.equal(f.dispatches(), 1);
});

test('V3 rejects forged witnessed cached records, missing signed proof, V1 witness, and downgrade', () => {
  const f = fixture(), a = f.adapter();
  const broker = new DurableEffectBroker(f.options());
  broker.dispatch(f.request, a);
  const corruptTrace = JSON.parse(JSON.stringify(broker.events()));
  corruptTrace[0].signedSinkReceipt.body.capabilityGrantRef = 'grant:forged';
  assert.throws(() => new DurableEffectBroker(f.options({ mode: 'replay', replayEvents: corruptTrace })), /signed sink receipt invalid/);
  const original = JSON.parse(f.head().journal!);
  const forged = structuredClone(original);
  forged.records[0].outcome.value = { tag: 'int', value: '10' };
  forged.records[0].outcome.receiptDigest = domainDigest('aether.effect-receipt/1', {
    requestDigest: forged.records[0].requestDigest, adapterId: forged.records[0].adapterId,
    adapterSemanticsDigest: forged.records[0].adapterSemanticsDigest,
    observedAt: forged.records[0].observedAt, value: forged.records[0].outcome.value,
  });
  f.setHead({ revision: f.head().revision, journal: Buffer.from(encodeCanonical(forged)).toString('utf8') });
  unlinkSync(f.file);
  assert.throws(() => new DurableEffectBroker(f.options()).inspectRecorded(f.request, f.adapter()), /signed sink receipt invalid/);
  const missing = structuredClone(original); missing.records[0].signedSinkReceipt = null;
  f.setHead({ revision: f.head().revision, journal: Buffer.from(encodeCanonical(missing)).toString('utf8') });
  assert.throws(() => new DurableEffectBroker(f.options()).events(), /signed sink receipt invalid/);
  f.setHead({ revision: f.head().revision, journal: Buffer.from(encodeCanonical(original)).toString('utf8') });
  new DurableEffectBroker(f.options()).events();
  assert.throws(() => new DurableEffectBroker(f.options({ attestedSink: undefined })), /original authority/);
  const v1 = createEffectJournalWitness({ authorityId: 'operator:test', repositoryId: f.anchor.repositoryId,
    deploymentId: 'deployment:test', clockDomain: 'clock:test', read: f.head,
    advance: () => { throw new Error('must not advance'); } });
  assert.throws(() => new DurableEffectBroker(f.options({ witness: v1 })), /requires a namespaced witness/);
});
