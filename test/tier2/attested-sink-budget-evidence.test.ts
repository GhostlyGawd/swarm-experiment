import assert from 'node:assert/strict';
import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import { test } from 'node:test';
import { encodeCanonical, type TaggedValueV1 } from '../../src/fabric/encoding.ts';
import { effectPayloadDigest, effectRequestDigest, type EffectRequestV1 } from '../../src/fabric/effects.ts';
import { domainDigest } from '../../src/fabric/identity.ts';
import { signSinkReceipt, sinkValueDigest, type SinkPublicAnchorV1,
  type SinkReceiptBodyV1 } from '../../src/fabric/sink-receipt.ts';
import { advanceSinkStateHead, createSinkStateWitness, type SinkStateDecisionRowV1,
  type SinkStateHeadV1, type SinkStateWitnessV1 } from '../../src/fabric/sink-state-witness.ts';
import { attestedSinkBudgetEvidencePolicyDigest,
  createAttestedSinkBudgetEvidence } from '../../src/tier2/attested-sink-budget-evidence.ts';
import { type BudgetObservation, type BudgetSettlementWitness } from '../../src/tier2/resource-budget-bridge.ts';
import { type ResourceAmounts, type ResourceSettlement } from '../../src/tier2/resource-budget.ts';

const ledgerDigest = domainDigest('aether.resource-budget/1', 'budget-ledger');
const artifact = domainDigest('aether.effect-adapter-artifact/3', 'approved-sink');
const charge: ResourceAmounts = { usdMicros: '7', tokens: '2', nanoseconds: '100', memoryBytes: '0' };
const zero: ResourceAmounts = { usdMicros: '0', tokens: '0', nanoseconds: '0', memoryBytes: '0' };
const payload: TaggedValueV1 = { tag: 'string', value: 'append-one' };
function request(effectId: string): EffectRequestV1 {
  return { format: 'aether.effect/1', executionId: 'execution:one', effectId,
    branchId: null, executionManifest: domainDigest('aether.execution/1', 'program'),
    capabilityGrantRef: 'grant:one', policyEpoch: '1', payloadDigest: effectPayloadDigest(payload),
    payload, budgetReservationId: `budget:${effectId}`, deadline: '1000' };
}
function row(anchor: SinkPublicAnchorV1, key: KeyObject, r: EffectRequestV1,
  sequence: number, disposition: 'committed' | 'not_committed'): SinkStateDecisionRowV1 {
  const value = disposition === 'committed' ? payload : null;
  const body: SinkReceiptBodyV1 = {
    format: 'aether.sink-receipt-body/1', repositoryId: anchor.repositoryId,
    deploymentId: 'deployment:one', executionId: r.executionId, effectId: r.effectId,
    requestDigest: effectRequestDigest(r), payloadDigest: r.payloadDigest,
    sinkAuthorityId: anchor.sinkAuthorityId, sinkId: anchor.sinkId, adapterArtifactDigest: artifact,
    policyEpoch: r.policyEpoch, capabilityGrantRef: r.capabilityGrantRef,
    keyId: anchor.keyId, keyEpoch: anchor.keyEpoch, disposition,
    valueDigest: value === null ? null : sinkValueDigest(value), decisionId: `decision:${sequence}`,
    commitId: value === null ? null : `commit:${sequence}`, sinkSequence: String(sequence),
  };
  return { repositoryId: anchor.repositoryId, deploymentId: 'deployment:one', request: r,
    value, receipt: signSinkReceipt(body, key, anchor) };
}
function fixture(expectedRequests: readonly EffectRequestV1[] = [
  request('effect:commit'), request('effect:fence'), request('effect:absent'), request('effect:one'),
]) {
  const key = generateKeyPairSync('ed25519');
  const anchor: SinkPublicAnchorV1 = { format: 'aether.sink-anchor/1', repositoryId: 'repository:one',
    sinkAuthorityId: 'operator:one', sinkId: 'sink:one', keyId: 'key:one', keyEpoch: '1',
    publicKey: key.publicKey.export({ format: 'der', type: 'spki' }).toString('base64') };
  let head: SinkStateHeadV1 = { revision: '0', journal: null }, outage = false;
  const witness: SinkStateWitnessV1 = createSinkStateWitness({ authorityId: 'external:operator',
    anchor, adapterArtifactDigest: artifact,
    read: () => { if (outage) throw new Error('external witness offline'); return head; },
    advance: (expected, journal) => {
      if (head.revision !== expected) throw new Error('stale witness CAS');
      head = { revision: String(BigInt(expected) + 1n), journal }; return head;
    } });
  const policyOptions = { witness, anchor, repositoryId: anchor.repositoryId,
    deploymentId: 'deployment:one', approvedAdapterArtifactDigest: artifact,
    owner: 'budget-service', charge, expectedRequests };
  const evidence = createAttestedSinkBudgetEvidence({ ...policyOptions, ledgerDigest });
  const rows: SinkStateDecisionRowV1[] = [];
  const append = (r: EffectRequestV1, disposition: 'committed' | 'not_committed') => {
    rows.push(row(anchor, key.privateKey, r, rows.length + 1, disposition));
    const journal = Buffer.from(encodeCanonical({ format: 'aether.attested-sink-state/2',
      witnessDigest: witness.digest, witnessRevision: String(rows.length), anchor,
      adapterArtifactDigest: artifact, decisions: rows })).toString('utf8');
    advanceSinkStateHead(witness, String(rows.length - 1), journal);
  };
  return { anchor, witness, evidence, policyOptions, append, rows, head: () => head,
    setOutage: (value: boolean) => { outage = value; },
    rollback: () => { head = { revision: '0', journal: null }; } };
}
function settlement(r: EffectRequestV1, observation: Exclude<BudgetObservation, { state: 'unknown' }>): ResourceSettlement {
  const committed = observation.state === 'committed';
  const outer: BudgetSettlementWitness = { format: 'aether.resource-budget-settlement/1', request: r,
    disposition: committed ? 'committed' : 'not_committed',
    value: committed ? observation.value : null, charge: committed ? observation.charge : zero,
    evidence: observation.evidence };
  return { ledgerDigest, owner: 'budget-service', binding: {
    executionId: r.executionId, effectId: r.effectId, executionManifest: r.executionManifest,
    payloadDigest: r.payloadDigest, policyEpoch: r.policyEpoch,
  }, disposition: outer.disposition, charge: outer.charge,
    evidence: { tag: 'string', value: Buffer.from(encodeCanonical(outer)).toString('utf8') } };
}
function known(value: BudgetObservation): Exclude<BudgetObservation, { state: 'unknown' }> {
  assert.notEqual(value.state, 'unknown');
  return value as Exclude<BudgetObservation, { state: 'unknown' }>;
}

test('one signed commit and one signed fence settle fixed charge and terminal refund', () => {
  const f = fixture(), committed = request('effect:commit'), fenced = request('effect:fence');
  assert.deepEqual(f.evidence.observe(committed), { state: 'unknown' });
  f.append(committed, 'committed'); f.append(fenced, 'not_committed');
  const commit = known(f.evidence.observe(committed));
  const fence = known(f.evidence.observe(fenced));
  assert.equal(commit.state, 'committed'); assert.equal(fence.state, 'not_committed');
  if (commit.state !== 'committed') throw new Error('expected committed evidence');
  assert.deepEqual(encodeCanonical(commit.charge), encodeCanonical(charge));
  assert.equal(f.evidence.verifySettlement(settlement(committed, commit)), true);
  assert.equal(f.evidence.verifySettlement(settlement(fenced, fence)), true);
  const changed = { ...committed, policyEpoch: '2' };
  assert.throws(() => f.evidence.observe(changed), /identity conflict/);
  // A predispatch refund with no signed sink fence stays encumbered here.
  const absent = request('effect:absent');
  assert.deepEqual(f.evidence.observe(absent), { state: 'unknown' });
  assert.equal(f.evidence.verifySettlement(settlement(absent, fence)), false);
});

test('policy digest is stable on reopen and changes with charge, trust roots and full request inventory', () => {
  const r = request('effect:one');
  const f = fixture([r, request('effect:fence')]);
  const base = attestedSinkBudgetEvidencePolicyDigest(f.policyOptions);
  assert.equal(f.evidence.policyDigest, base);
  assert.ok(base.startsWith('aether.attested-sink-budget-evidence-policy/1:b3:'));
  assert.notEqual(attestedSinkBudgetEvidencePolicyDigest({ ...f.policyOptions,
    charge: { ...charge, tokens: '3' } }), base);
  assert.notEqual(attestedSinkBudgetEvidencePolicyDigest({ ...f.policyOptions,
    deploymentId: 'deployment:other' }), base);
  assert.notEqual(attestedSinkBudgetEvidencePolicyDigest({ ...f.policyOptions,
    owner: 'other-budget-owner' }), base);
  assert.notEqual(attestedSinkBudgetEvidencePolicyDigest({ ...f.policyOptions,
    expectedRequests: [{ ...r, capabilityGrantRef: 'grant:other' }, request('effect:fence')] }), base);
  assert.notEqual(attestedSinkBudgetEvidencePolicyDigest({ ...f.policyOptions,
    expectedRequests: [{ ...r, budgetReservationId: 'budget:other' }, request('effect:fence')] }), base);
  assert.equal(attestedSinkBudgetEvidencePolicyDigest({ ...f.policyOptions,
    expectedRequests: [request('effect:fence'), r] }), base);
  const otherWitness = createSinkStateWitness({ authorityId: 'external:other', anchor: f.anchor,
    adapterArtifactDigest: artifact, read: f.head,
    advance: () => { throw new Error('unused'); } });
  assert.notEqual(attestedSinkBudgetEvidencePolicyDigest({ ...f.policyOptions,
    witness: otherWitness }), base);
  const otherKey = generateKeyPairSync('ed25519');
  const otherAnchor = { ...f.anchor,
    publicKey: otherKey.publicKey.export({ format: 'der', type: 'spki' }).toString('base64') };
  const otherAnchorWitness = createSinkStateWitness({ authorityId: 'external:operator',
    anchor: otherAnchor, adapterArtifactDigest: artifact,
    read: () => ({ revision: '0', journal: null }),
    advance: () => { throw new Error('unused'); } });
  assert.notEqual(attestedSinkBudgetEvidencePolicyDigest({ ...f.policyOptions,
    anchor: otherAnchor, witness: otherAnchorWitness }), base);
  f.append(r, 'committed');
  const reopened = createSinkStateWitness({ authorityId: 'external:operator', anchor: f.anchor,
    adapterArtifactDigest: artifact, read: f.head,
    advance: () => { throw new Error('unused'); } });
  assert.equal(attestedSinkBudgetEvidencePolicyDigest({ ...f.policyOptions,
    witness: reopened }), base);
  assert.equal(createAttestedSinkBudgetEvidence({ ...f.policyOptions,
    witness: reopened, ledgerDigest }).policyDigest, base);
  f.setOutage(true);
  assert.equal(attestedSinkBudgetEvidencePolicyDigest({ ...f.policyOptions,
    witness: reopened }), base);
});

test('outer settlement binds exact request, result, charge, owner and inner receipt', () => {
  const f = fixture(), r = request('effect:one'); f.append(r, 'committed');
  const observed = known(f.evidence.observe(r));
  const good = settlement(r, observed);
  assert.equal(f.evidence.verifySettlement(good), true);
  assert.equal(f.evidence.verifySettlement({ ...good, ledgerDigest: domainDigest('aether.resource-budget/1', 'other') }), false);
  assert.equal(f.evidence.verifySettlement({ ...good, owner: 'other' }), false);
  assert.equal(f.evidence.verifySettlement({ ...good, binding: { ...good.binding, policyEpoch: '2' } }), false);
  assert.equal(f.evidence.verifySettlement({ ...good, charge: { ...charge, tokens: '3' } }), false);
  const outer = JSON.parse((good.evidence as { value: string }).value) as BudgetSettlementWitness;
  const changedValue: TaggedValueV1 = { tag: 'string', value: 'wrong-result' };
  const altered = (patch: Partial<BudgetSettlementWitness>): ResourceSettlement => ({ ...good,
    evidence: { tag: 'string', value: Buffer.from(encodeCanonical({ ...outer, ...patch })).toString('utf8') } });
  assert.equal(f.evidence.verifySettlement(altered({ value: changedValue })), false);
  assert.equal(f.evidence.verifySettlement(altered({ charge: { ...charge, tokens: '3' } })), false);
  assert.equal(f.evidence.verifySettlement(altered({ request: { ...r, policyEpoch: '2' } })), false);
  const inner = JSON.parse((outer.evidence as { value: string }).value) as { signature: string };
  const forged: TaggedValueV1 = { tag: 'string', value: Buffer.from(encodeCanonical({ ...inner,
    signature: Buffer.alloc(64).toString('base64') })).toString('utf8') };
  assert.equal(f.evidence.verifySettlement(altered({ evidence: forged })), false);
});

test('witness outage and rollback never authorize charge or refund', () => {
  const f = fixture(), r = request('effect:one'); f.append(r, 'committed');
  const observed = known(f.evidence.observe(r)), good = settlement(r, observed);
  f.setOutage(true);
  assert.deepEqual(f.evidence.observe(r), { state: 'unknown' });
  assert.equal(f.evidence.verifySettlement(good), false);
  f.setOutage(false); assert.equal(f.evidence.verifySettlement(good), true);
  f.rollback();
  assert.deepEqual(f.evidence.observe(r), { state: 'unknown' });
  assert.equal(f.evidence.verifySettlement(good), false);
});

test('helper requires the branded witness and exact independently pinned identity', () => {
  const f = fixture();
  const options = { witness: f.witness, anchor: f.anchor, repositoryId: f.anchor.repositoryId,
    deploymentId: 'deployment:one', approvedAdapterArtifactDigest: artifact,
    ledgerDigest, owner: 'budget-service', charge, expectedRequests: [request('effect:one')] };
  assert.throws(() => createAttestedSinkBudgetEvidence({ ...options, witness: { ...f.witness } }), /independently supplied/);
  assert.throws(() => createAttestedSinkBudgetEvidence({ ...options,
    approvedAdapterArtifactDigest: domainDigest('aether.effect-adapter-artifact/3', 'other') }), /identity differs/);
  assert.throws(() => createAttestedSinkBudgetEvidence({ ...options, repositoryId: 'other' }), /identity differs/);
  assert.throws(() => createAttestedSinkBudgetEvidence({ ...options,
    charge: { ...charge, tokens: '-1' } }), /canonical decimal/);
  assert.throws(() => createAttestedSinkBudgetEvidence({ ...options, expectedRequests: [] }), /bounded expected/);
  assert.throws(() => createAttestedSinkBudgetEvidence({ ...options,
    expectedRequests: [request('effect:one'), { ...request('effect:one'), capabilityGrantRef: 'other-grant' }] }), /ambiguous expected/);
  assert.throws(() => createAttestedSinkBudgetEvidence({ ...options,
    expectedRequests: [request('effect:one'), { ...request('effect:two'), budgetReservationId: 'budget:effect:one' }] }), /ambiguous expected/);
});

test('direct-ledger alias cannot settle a different signed grant or reservation under the same five-field binding', () => {
  const authorized = request('effect:one');
  for (const patch of [
    { capabilityGrantRef: 'grant:other' },
    { budgetReservationId: 'budget:other' },
    { capabilityGrantRef: 'grant:other', budgetReservationId: 'budget:other' },
  ]) {
    const f = fixture([authorized]);
    const alien = { ...authorized, ...patch };
    f.append(alien, 'committed');
    assert.throws(() => f.evidence.observe(alien), /identity conflict/);
    assert.throws(() => f.evidence.observe(authorized), /identity conflict/);
    const signedReceipt: TaggedValueV1 = { tag: 'string', value: Buffer.from(
      encodeCanonical(f.rows[0].receipt)).toString('utf8') };
    const signedAlien = settlement(alien, { state: 'committed', value: payload,
      charge, evidence: signedReceipt });
    // ResourceBinding intentionally omits grantRef and reservation ID; those
    // five fields are equal here. The predeclared full digest rejects the alias.
    assert.deepEqual(encodeCanonical(signedAlien.binding), encodeCanonical(settlement(authorized,
      { state: 'committed', value: payload, charge, evidence: signedReceipt }).binding));
    assert.equal(f.evidence.verifySettlement(signedAlien), false);
  }
});
