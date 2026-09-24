import assert from 'node:assert/strict';
import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import { test } from 'node:test';
import { encodeCanonical, type TaggedValueV1 } from '../../src/fabric/encoding.ts';
import { effectPayloadDigest, effectRequestDigest, type EffectRequestV1 } from '../../src/fabric/effects.ts';
import { domainDigest } from '../../src/fabric/identity.ts';
import { signSinkReceipt, sinkValueDigest, type SinkPublicAnchorV1, type SinkReceiptBodyV1 } from '../../src/fabric/sink-receipt.ts';
import { advanceSinkStateHead, assertSinkStateWitness, createSinkStateWitness,
  readSinkStateHead, validateSinkStateJournalV2, type SinkStateDecisionRowV1,
  type SinkStateHeadV1, type SinkStateJournalV2, type SinkStateWitnessV1 } from '../../src/fabric/sink-state-witness.ts';

const adapterArtifactDigest = domainDigest('aether.effect-adapter-artifact/1', 'approved');
const payload: TaggedValueV1 = { tag: 'string', value: 'append-once' };
function decision(anchor: SinkPublicAnchorV1, key: KeyObject, index: number,
  disposition: 'committed' | 'not_committed' = 'committed', suffix = '',
  identity: Readonly<{ effectId?: string; decisionId?: string; commitId?: string }> = {}): SinkStateDecisionRowV1 {
  const request: EffectRequestV1 = {
    format: 'aether.effect/1', executionId: 'execution:one', effectId: identity.effectId ?? `effect:${index}`,
    branchId: null, executionManifest: domainDigest('aether.execution/1', 'program'),
    capabilityGrantRef: 'grant:one', policyEpoch: '1', payloadDigest: effectPayloadDigest(payload),
    payload, budgetReservationId: null, deadline: '100',
  };
  const value: TaggedValueV1 | null = disposition === 'committed' ? payload : null;
  const body: SinkReceiptBodyV1 = {
    format: 'aether.sink-receipt-body/1', repositoryId: anchor.repositoryId,
    deploymentId: 'deployment:one', executionId: request.executionId, effectId: request.effectId,
    requestDigest: effectRequestDigest(request), payloadDigest: request.payloadDigest,
    sinkAuthorityId: anchor.sinkAuthorityId, sinkId: anchor.sinkId, adapterArtifactDigest,
    policyEpoch: request.policyEpoch, capabilityGrantRef: request.capabilityGrantRef,
    keyId: anchor.keyId, keyEpoch: anchor.keyEpoch, disposition,
    valueDigest: value === null ? null : sinkValueDigest(value),
    decisionId: identity.decisionId ?? `decision:${index}${suffix}`,
    commitId: disposition === 'committed' ? identity.commitId ?? `commit:${index}${suffix}` : null,
    sinkSequence: String(index),
  };
  return { repositoryId: anchor.repositoryId, deploymentId: 'deployment:one', request,
    value, receipt: signSinkReceipt(body, key, anchor) };
}
function fixture() {
  const key = generateKeyPairSync('ed25519');
  const anchor: SinkPublicAnchorV1 = { format: 'aether.sink-anchor/1', repositoryId: 'repo:one',
    sinkAuthorityId: 'sink-authority:one', sinkId: 'sink:one', keyId: 'key:one', keyEpoch: '1',
    publicKey: key.publicKey.export({ format: 'der', type: 'spki' }).toString('base64') };
  let head: SinkStateHeadV1 = { revision: '0', journal: null };
  let advances = 0;
  const witness = createSinkStateWitness({ authorityId: 'operator:one', anchor,
    adapterArtifactDigest, read: () => head,
    advance: (expected, journal) => {
      advances++;
      if (head.revision !== expected) throw new Error('provider CAS lost');
      head = { revision: String(BigInt(expected) + 1n), journal };
      return head;
    } });
  const row = (index: number, disposition: 'committed' | 'not_committed' = 'committed', suffix = '',
    identity: Readonly<{ effectId?: string; decisionId?: string; commitId?: string }> = {}) =>
    decision(anchor, key.privateKey, index, disposition, suffix, identity);
  const record = (rows: readonly SinkStateDecisionRowV1[], revision = String(rows.length)): SinkStateJournalV2 => ({
    format: 'aether.attested-sink-state/2', witnessDigest: witness.digest,
    witnessRevision: revision, anchor, adapterArtifactDigest, decisions: rows,
  });
  const journal = (rows: readonly SinkStateDecisionRowV1[], revision = String(rows.length)) =>
    Buffer.from(encodeCanonical(record(rows, revision))).toString('utf8');
  return { witness, anchor, row, record, journal, head: () => head,
    setHead: (next: SinkStateHeadV1) => { head = next; }, advances: () => advances };
}

test('sink witness binds operator, exact anchor and adapter; advances one signed decision per revision', () => {
  const f = fixture();
  assert.deepEqual(readSinkStateHead(f.witness), { revision: '0', journal: null });
  const one = f.journal([f.row(1)]);
  const two = f.journal([f.row(1), f.row(2, 'not_committed')]);
  assert.deepEqual(advanceSinkStateHead(f.witness, '0', one), { revision: '1', journal: one });
  assert.deepEqual(advanceSinkStateHead(f.witness, '1', two), { revision: '2', journal: two });
  assert.equal(f.advances(), 2);
  const sinkAnchorDigest = domainDigest('aether.sink-anchor/1', f.anchor);
  assert.equal(f.witness.sinkAnchorDigest, sinkAnchorDigest);
  assert.equal(f.witness.digest, domainDigest('aether.sink-state-witness/1', {
    format: 'aether.sink-state-witness/1', authorityId: 'operator:one', repositoryId: 'repo:one',
    sinkAuthorityId: 'sink-authority:one', sinkId: 'sink:one', sinkAnchorDigest,
    adapterArtifactDigest }));
  assert.ok(Object.isFrozen(f.witness));
  assert.throws(() => assertSinkStateWitness({ ...f.witness }), /independently supplied/);
  validateSinkStateJournalV2(f.record([f.row(1)]), f.witness, '1');
});

test('sink witness rejects stale writers, rollback and same-revision equivocation', () => {
  const f = fixture();
  const first = f.journal([f.row(1)]);
  advanceSinkStateHead(f.witness, '0', first);
  assert.throws(() => advanceSinkStateHead(f.witness, '0', first), /stale/);
  assert.equal(f.advances(), 1);
  f.setHead({ revision: '1', journal: f.journal([f.row(1, 'committed', ':fork')]) });
  assert.throws(() => readSinkStateHead(f.witness), /equivocated/);
  f.setHead({ revision: '0', journal: null });
  assert.throws(() => readSinkStateHead(f.witness), /rolled back/);
});

test('sink witness adopts an existing matching head but rejects a changed anchor or adapter at startup', () => {
  const f = fixture();
  const first = f.journal([f.row(1)]);
  f.setHead({ revision: '1', journal: first });
  const matching = createSinkStateWitness({ authorityId: 'operator:one', anchor: f.anchor,
    adapterArtifactDigest, read: f.head, advance: () => { throw new Error('unused'); } });
  assert.deepEqual(readSinkStateHead(matching), { revision: '1', journal: first });
  assert.throws(() => createSinkStateWitness({ authorityId: 'operator:one',
    anchor: { ...f.anchor, keyEpoch: '2' }, adapterArtifactDigest,
    read: f.head, advance: () => { throw new Error('unused'); } }), /identity mismatch|anchor mismatch/);
  assert.throws(() => createSinkStateWitness({ authorityId: 'operator:one', anchor: f.anchor,
    adapterArtifactDigest: domainDigest('aether.effect-adapter-artifact/1', 'other'),
    read: f.head, advance: () => { throw new Error('unused'); } }), /identity mismatch|adapter mismatch/);
});

test('sink witness refuses changed identity, wrong revision/count, invalid rows and noncanonical bytes before CAS', () => {
  const f = fixture();
  const row = f.row(1);
  const valid = f.journal([row]);
  const other = fixture();
  const variants: unknown[] = [
    { ...f.record([row]), witnessDigest: other.witness.digest },
    { ...f.record([row]), witnessRevision: '2' },
    { ...f.record([row]), decisions: [] },
    { ...f.record([row]), decisions: Array(1025).fill({}) },
    { ...f.record([row]), anchor: { ...f.anchor, keyEpoch: '2' } },
    { ...f.record([row]), adapterArtifactDigest: domainDigest('aether.effect-adapter-artifact/1', 'other') },
    { ...f.record([row]), decisions: [{ ...row, receipt: { ...row.receipt, signature: 'A'.repeat(86) + '==' } }] },
    { ...f.record([row]), decisions: [{ ...row, receipt: { ...row.receipt,
      body: { ...row.receipt.body, sinkSequence: '2' } } }] },
    { ...f.record([row]), decisions: [{ ...row, extra: true }] },
    { ...f.record([row]), unexpected: true },
  ];
  for (const variant of variants) assert.throws(() => advanceSinkStateHead(f.witness, '0',
    Buffer.from(encodeCanonical(variant)).toString('utf8')));
  for (const text of [`{}`, ` ${valid}`, `${valid} `,
    valid.replace('{', '{"format":"aether.attested-sink-state/2",'),
    valid.replace('"format"', '"format" '),
    'x'.repeat(8 * 1024 * 1024 + 1)]) assert.throws(() => advanceSinkStateHead(f.witness, '0', text));
  assert.equal(f.advances(), 0);
  f.setHead({ revision: '1', journal: f.journal([row]).replace(f.witness.digest, other.witness.digest) });
  assert.throws(() => readSinkStateHead(f.witness), /identity mismatch/);
  f.setHead({ revision: '1', journal: null });
  assert.throws(() => readSinkStateHead(f.witness), /genesis/);
  f.setHead({ revision: '0', journal: valid });
  assert.throws(() => readSinkStateHead(f.witness), /genesis/);
});

test('sink witness rejects repeated effect, decision and commit identities', () => {
  const f = fixture();
  const first = f.row(1);
  const duplicates = [
    f.row(2, 'committed', '', { effectId: first.request.effectId }),
    f.row(2, 'committed', '', { decisionId: first.receipt.body.decisionId }),
    f.row(2, 'committed', '', { commitId: first.receipt.body.commitId! }),
  ];
  for (const duplicate of duplicates) assert.throws(() =>
    validateSinkStateJournalV2(f.record([first, duplicate]), f.witness, '2'), /duplicate sink witness decision identity/);
});

test('sink witness rejects false CAS success and missing post-CAS retention', () => {
  const f = fixture();
  const journal = f.journal([f.row(1)]);
  const falseReply = createSinkStateWitness({ authorityId: 'operator:one', anchor: f.anchor,
    adapterArtifactDigest, read: () => ({ revision: '0', journal: null }),
    advance: () => ({ revision: '1', journal }) });
  assert.throws(() => advanceSinkStateHead(falseReply, '0', journal), /retain exact next journal|rolled back/);
  let retained: SinkStateHeadV1 = { revision: '0', journal: null };
  const wrongReply = createSinkStateWitness({ authorityId: 'operator:one', anchor: f.anchor,
    adapterArtifactDigest, read: () => retained,
    advance: () => {
      retained = { revision: '1', journal };
      return { revision: '0', journal: null };
    } });
  assert.throws(() => advanceSinkStateHead(wrongReply, '0', journal), /durably accept exact next journal/);
});
