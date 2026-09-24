import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { after, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertAttestedSinkAdapter, createAttestedSinkAdapter, verifiedSinkReceipt,
  type AttestedSinkClientV1, type AttestedSinkIdentityV1 } from '../../src/fabric/attested-sink-adapter.ts';
import { encodeCanonical, type TaggedValueV1 } from '../../src/fabric/encoding.ts';
import { DurableEffectBroker, effectPayloadDigest, effectRequestDigest, type EffectRequestV1 } from '../../src/fabric/effects.ts';
import { createNamespacedEffectJournalWitness, type WitnessHead } from '../../src/fabric/effect-journal-witness.ts';
import { advanceSinkStateHead, createSinkStateWitness, type SinkStateHeadV1 } from '../../src/fabric/sink-state-witness.ts';
import { domainDigest } from '../../src/fabric/identity.ts';
import { signSinkReceipt, sinkValueDigest, type SignedSinkReceiptV1, type SinkPublicAnchorV1, type SinkReceiptBodyV1 } from '../../src/fabric/sink-receipt.ts';

const paths: string[] = [];
after(() => { for (const path of paths) rmSync(path, { recursive: true, force: true }); });
function directory(): string { const path = mkdtempSync(join(tmpdir(), 'aether-attested-adapter-')); paths.push(path); return path; }
const payload: TaggedValueV1 = { tag: 'sequence', items: [{ tag: 'string', value: 'charge:42' }] };
const value: TaggedValueV1 = { tag: 'int', value: '42' };
function request(patch: Partial<EffectRequestV1> = {}): EffectRequestV1 {
  return { format: 'aether.effect/1', executionId: 'execution:ledger', effectId: 'effect:charge', branchId: null,
    executionManifest: domainDigest('aether.execution/1', 'manifest'), capabilityGrantRef: 'grant:payments', policyEpoch: '7',
    payloadDigest: effectPayloadDigest(payload), payload, budgetReservationId: null, deadline: '1000', ...patch };
}
function fixture() {
  const keys = generateKeyPairSync('ed25519');
  const anchor: SinkPublicAnchorV1 = { format: 'aether.sink-anchor/1', repositoryId: 'repo:payments',
    sinkAuthorityId: 'authority:payments', sinkId: 'sink:payments', keyId: 'key:1', keyEpoch: '1',
    publicKey: keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64') };
  const identity: AttestedSinkIdentityV1 = { repositoryId: anchor.repositoryId, deploymentId: 'deployment:payments',
    approvedAdapterArtifactDigest: domainDigest('aether.effect-adapter-artifact/3', 'approved'), anchor };
  const receipt = (req: EffectRequestV1, disposition: 'committed' | 'not_committed',
    overrides: Partial<SinkReceiptBodyV1> = {}): SignedSinkReceiptV1 => {
    const body: SinkReceiptBodyV1 = { format: 'aether.sink-receipt-body/1', repositoryId: identity.repositoryId,
      deploymentId: identity.deploymentId, executionId: req.executionId, effectId: req.effectId,
      requestDigest: effectRequestDigest(req), payloadDigest: req.payloadDigest,
      sinkAuthorityId: anchor.sinkAuthorityId, sinkId: anchor.sinkId,
      adapterArtifactDigest: identity.approvedAdapterArtifactDigest, policyEpoch: req.policyEpoch,
      capabilityGrantRef: req.capabilityGrantRef, keyId: anchor.keyId, keyEpoch: anchor.keyEpoch,
      disposition, valueDigest: disposition === 'committed' ? sinkValueDigest(value) : null,
      decisionId: 'decision:charge', commitId: disposition === 'committed' ? 'commit:charge' : null,
      sinkSequence: '1', ...overrides };
    return signSinkReceipt(body, keys.privateKey, anchor);
  };
  return { identity, anchor, receipt };
}

test('trusted wrapper accepts exact signed commit, pins copied identity, and exposes a detached proof', () => {
  const f = fixture(), req = request();
  let calls = 0;
  const client: AttestedSinkClientV1 = {
    execute: passed => { calls++; assert.notEqual(passed, req); return { state: 'committed', receipt: f.receipt(req, 'committed'), value }; },
    status: passed => ({ state: 'committed', receipt: f.receipt(passed, 'committed'), value }),
  };
  const callerAnchor = { ...f.anchor };
  const adapter = createAttestedSinkAdapter({ id: 'adapter:payments/1', ...f.identity, anchor: callerAnchor, client });
  callerAnchor.keyEpoch = '9';
  assertAttestedSinkAdapter(adapter, f.identity);
  const result = adapter.execute(req);
  assert.deepEqual({ ...result }, value); assert.notEqual(result, value); assert.equal(calls, 1);
  const proof = verifiedSinkReceipt(adapter, req)!;
  assert.equal(proof.body.requestDigest, effectRequestDigest(req));
  (proof as unknown as { body: SinkReceiptBodyV1 }).body = { ...proof.body, decisionId: 'forged' };
  assert.equal(verifiedSinkReceipt(adapter, req)?.body.decisionId, 'decision:charge');
  const reconciled = adapter.reconcile(req, null);
  assert.equal(reconciled.state, 'committed');
  if (reconciled.state === 'committed') assert.deepEqual({ ...reconciled.value }, value);
  assert.deepEqual({ ...adapter.execute(req) }, value); assert.equal(calls, 2, 'sink enforces idempotency on retry');
  assert.throws(() => assertAttestedSinkAdapter(adapter, { ...f.identity, deploymentId: 'deployment:other' }), /identity mismatch/);
  assert.throws(() => assertAttestedSinkAdapter({ ...adapter }, f.identity), /untrusted/);
  assert.throws(() => verifiedSinkReceipt(adapter, request({ policyEpoch: '8' })), /identity_conflict/);
});

test('forged, mismatched, stale, and contradictory signed responses never yield a committed value', () => {
  const f = fixture(), req = request();
  const cases: Array<{ name: string; receipt: SignedSinkReceiptV1; returnedValue?: TaggedValueV1 }> = [
    { name: 'signature', receipt: { ...f.receipt(req, 'committed'), signature: 'A'.repeat(86) + '==' } },
    { name: 'repository', receipt: (() => { const signed = f.receipt(req, 'committed');
      return { ...signed, body: { ...signed.body, repositoryId: 'repo:other' } }; })() },
    { name: 'deployment', receipt: f.receipt(req, 'committed', { deploymentId: 'deployment:other' }) },
    { name: 'artifact', receipt: f.receipt(req, 'committed', { adapterArtifactDigest: domainDigest('aether.effect-adapter-artifact/3', 'other') }) },
    { name: 'policy', receipt: f.receipt(req, 'committed', { policyEpoch: '8' }) },
    { name: 'grant', receipt: f.receipt(req, 'committed', { capabilityGrantRef: 'grant:other' }) },
    { name: 'payload', receipt: f.receipt(req, 'committed', { payloadDigest: effectPayloadDigest({ tag: 'null' }) }) },
    { name: 'request', receipt: f.receipt(req, 'committed', { requestDigest: effectRequestDigest(request({ deadline: '1001' })) }) },
    { name: 'value', receipt: f.receipt(req, 'committed'), returnedValue: { tag: 'int', value: '43' } },
    { name: 'disposition', receipt: f.receipt(req, 'not_committed') },
  ];
  for (const item of cases) {
    const client: AttestedSinkClientV1 = { execute: () => ({ state: 'committed', receipt: item.receipt, value: item.returnedValue ?? value }),
      status: () => ({ state: 'committed', receipt: item.receipt, value: item.returnedValue ?? value }) };
    const adapter = createAttestedSinkAdapter({ id: 'adapter:payments/1', ...f.identity, client });
    assert.throws(() => adapter.execute(req), /attested_sink_receipt_invalid/, item.name);
    assert.deepEqual(adapter.reconcile(req, null), { state: 'unknown' }, item.name);
    assert.equal(verifiedSinkReceipt(adapter, req), null, item.name);
  }
  const anchorChange = { ...f.anchor, keyEpoch: '2' };
  assert.throws(() => createAttestedSinkAdapter({ id: 'adapter:payments/1', ...f.identity,
    anchor: anchorChange, client: { execute: () => ({ state: 'committed', receipt: f.receipt(req, 'committed'), value }), status: () => ({ state: 'unknown' }) } }).execute(req), /receipt_invalid/);
});

test('reconciliation reports noncommit only from a signed terminal fence; uncertainty stays unknown', () => {
  const f = fixture(), req = request();
  let status: ReturnType<AttestedSinkClientV1['status']> = { state: 'unknown' };
  const adapter = createAttestedSinkAdapter({ id: 'adapter:payments/1', ...f.identity,
    client: { execute: () => { throw new Error('transport lost after dispatch'); }, status: () => status } });
  assert.deepEqual(adapter.reconcile(req, null), { state: 'unknown' });
  status = { state: 'not_committed', receipt: { ...f.receipt(req, 'not_committed'), signature: 'A'.repeat(86) + '==' } };
  assert.deepEqual(adapter.reconcile(req, null), { state: 'unknown' });
  status = { state: 'not_committed', receipt: f.receipt(req, 'not_committed') };
  assert.deepEqual(adapter.reconcile(req, null), { state: 'not_committed' });
  assert.equal(verifiedSinkReceipt(adapter, req)?.body.disposition, 'not_committed');
  assert.throws(() => adapter.execute(req), /fenced/);
  status = { state: 'committed', receipt: f.receipt(req, 'committed'), value };
  assert.deepEqual(adapter.reconcile(req, null), { state: 'unknown' }, 'conflicting signed terminal decision is not accepted');
});

test('broker keeps transport failure indeterminate and releases it only after signed fence', () => {
  const f = fixture(), req = request();
  let fenced = false, dispatches = 0, releases = 0;
  const adapter = createAttestedSinkAdapter({ id: 'adapter:payments/1', ...f.identity,
    client: { execute: () => { dispatches++; throw new Error('lost response'); },
      status: () => fenced ? { state: 'not_committed', receipt: f.receipt(req, 'not_committed') } : { state: 'unknown' } } });
  let head: WitnessHead = { revision: '0', journal: null };
  const witness = createNamespacedEffectJournalWitness({ authorityId: 'operator:test',
    repositoryId: f.identity.repositoryId, catalogDeploymentId: f.identity.deploymentId,
    operationId: 'adapter-broker', clockDomain: 'test-clock/1', read: () => head,
    advance(expected, journal) { assert.equal(head.revision, expected);
      head = { revision: String(BigInt(expected) + 1n), journal }; return head; } });
  const broker = new DurableEffectBroker({ directory: directory(), clockDomain: 'test-clock/1', clock: () => 100n,
    authorize: () => true, authorizeReconciliation: () => true, witness,
    attestedSink: { anchor: f.anchor, deploymentId: f.identity.deploymentId,
      approvedAdapterArtifactDigest: f.identity.approvedAdapterArtifactDigest },
    budgets: { reserve: () => true, consume: () => {}, release: () => { releases++; } } });
  const withBudget = request({ budgetReservationId: 'budget:reserved' });
  // The receipt must bind the exact budget-bearing request as well.
  const sink = createAttestedSinkAdapter({ id: 'adapter:payments/2', ...f.identity,
    client: { execute: () => { dispatches++; throw new Error('lost response'); },
      status: () => fenced ? { state: 'not_committed', receipt: f.receipt(withBudget, 'not_committed') } : { state: 'unknown' } } });
  assert.equal(broker.dispatch(withBudget, sink).state, 'indeterminate');
  assert.equal(dispatches, 1); assert.equal(releases, 0);
  assert.equal(broker.reconcile(withBudget, sink).state, 'indeterminate'); assert.equal(releases, 0);
  fenced = true;
  assert.deepEqual(broker.reconcile(withBudget, sink), { state: 'aborted', code: 'sink_confirmed_not_committed' });
  assert.equal(releases, 1); assert.equal(dispatches, 1);
  assert.equal(adapter.reconcile(req, null).state, 'not_committed');
});

test('V4 broker withholds a valid sink signature until the independent sink head retains it', () => {
  const f = fixture(), req = request(), receipt = f.receipt(req, 'committed');
  let sinkHead: SinkStateHeadV1 = { revision: '0', journal: null };
  const sinkStateWitness = createSinkStateWitness({ authorityId: 'operator:sink', anchor: f.anchor,
    adapterArtifactDigest: f.identity.approvedAdapterArtifactDigest,
    read: () => sinkHead,
    advance(expectedRevision, journal) {
      assert.equal(sinkHead.revision, expectedRevision);
      sinkHead = { revision: String(BigInt(expectedRevision) + 1n), journal };
      return sinkHead;
    } });
  let effectHead: WitnessHead = { revision: '0', journal: null };
  const witness = createNamespacedEffectJournalWitness({ authorityId: 'operator:broker',
    repositoryId: f.identity.repositoryId, catalogDeploymentId: f.identity.deploymentId,
    operationId: 'adapter-broker-v4', clockDomain: 'test-clock/1', read: () => effectHead,
    advance(expected, journal) {
      assert.equal(effectHead.revision, expected);
      effectHead = { revision: String(BigInt(expected) + 1n), journal };
      return effectHead;
    } });
  let executes = 0;
  const adapter = createAttestedSinkAdapter({ id: 'adapter:payments/1', ...f.identity,
    client: { execute: () => { executes++; return { state: 'committed', receipt, value }; },
      status: () => ({ state: 'committed', receipt, value }) } });
  const broker = new DurableEffectBroker({ directory: directory(), clockDomain: 'test-clock/1',
    clock: () => 100n, authorize: () => true, authorizeReconciliation: () => true, witness,
    attestedSinkV4: { anchor: f.anchor, deploymentId: f.identity.deploymentId,
      approvedAdapterArtifactDigest: f.identity.approvedAdapterArtifactDigest, sinkStateWitness } });
  assert.equal(broker.dispatch(req, adapter).state, 'indeterminate');
  assert.equal(executes, 1);
  assert.equal(broker.reconcile(req, adapter).state, 'indeterminate');
  const journal = { format: 'aether.attested-sink-state/2', witnessDigest: sinkStateWitness.digest,
    witnessRevision: '1', anchor: f.anchor,
    adapterArtifactDigest: f.identity.approvedAdapterArtifactDigest,
    decisions: [{ repositoryId: f.identity.repositoryId, deploymentId: f.identity.deploymentId,
      request: req, value, receipt }] };
  advanceSinkStateHead(sinkStateWitness, '0', Buffer.from(encodeCanonical(journal)).toString('utf8'));
  assert.equal(broker.reconcile(req, adapter).state, 'committed');
  assert.equal(broker.inspectRecorded(req, adapter)?.state, 'committed');
  assert.equal(executes, 1);
});
