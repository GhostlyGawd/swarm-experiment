import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { test } from 'node:test';
import { encodeCanonical, type TaggedValueV1 } from '../../src/fabric/encoding.ts';
import { effectPayloadDigest, effectRequestDigest, type EffectRequestV1 } from '../../src/fabric/effects.ts';
import { domainDigest } from '../../src/fabric/identity.ts';
import {
  signSinkReceipt, sinkValueDigest, validateSignedSinkReceipt, validateSinkPublicAnchor,
  validateSinkReceiptBody, verifySinkReceipt,
  type SinkPublicAnchorV1, type SinkReceiptBodyV1, type SinkReceiptExpectationV1,
} from '../../src/fabric/sink-receipt.ts';

const payload: TaggedValueV1 = { tag: 'sequence', items: [{ tag: 'string', value: 'charge:42' }] };
const result: TaggedValueV1 = { tag: 'int', value: '42' };
const artifact = domainDigest('aether.effect-adapter-artifact/3', 'approved-code');
function request(patch: Partial<EffectRequestV1> = {}): EffectRequestV1 {
  return {
    format: 'aether.effect/1', executionId: 'execution:1', effectId: 'effect:1', branchId: null,
    executionManifest: domainDigest('aether.execution/1', 'manifest'), capabilityGrantRef: 'grant:1',
    policyEpoch: '7', payloadDigest: effectPayloadDigest(payload), payload, budgetReservationId: 'budget:1', deadline: '1000', ...patch,
  };
}
function fixture(disposition: 'committed' | 'not_committed' = 'committed') {
  const keys = generateKeyPairSync('ed25519');
  const anchor: SinkPublicAnchorV1 = {
    format: 'aether.sink-anchor/1', repositoryId: 'repo:a', sinkAuthorityId: 'authority:payments', sinkId: 'sink:1',
    keyId: 'key:payments:1', keyEpoch: '3', publicKey: keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
  };
  const req = request();
  const body: SinkReceiptBodyV1 = {
    format: 'aether.sink-receipt-body/1', repositoryId: anchor.repositoryId, deploymentId: 'deployment:1',
    executionId: req.executionId, effectId: req.effectId, requestDigest: effectRequestDigest(req), payloadDigest: req.payloadDigest,
    sinkAuthorityId: anchor.sinkAuthorityId, sinkId: anchor.sinkId, adapterArtifactDigest: artifact,
    policyEpoch: req.policyEpoch, capabilityGrantRef: req.capabilityGrantRef, keyId: anchor.keyId, keyEpoch: anchor.keyEpoch,
    disposition, valueDigest: disposition === 'committed' ? sinkValueDigest(result) : null,
    decisionId: 'decision:1', commitId: disposition === 'committed' ? 'commit:1' : null, sinkSequence: '1',
  };
  const expected: SinkReceiptExpectationV1 = {
    repositoryId: anchor.repositoryId, deploymentId: body.deploymentId, request: req,
    sinkAuthorityId: anchor.sinkAuthorityId, sinkId: anchor.sinkId, adapterArtifactDigest: artifact,
    disposition, value: disposition === 'committed' ? result : null,
  };
  return { keys, anchor, body, expected, receipt: signSinkReceipt(body, keys.privateKey, anchor) };
}

test('signed sink commit binds exact request, payload, approved adapter and committed value', () => {
  const { anchor, body, expected, receipt } = fixture();
  validateSinkPublicAnchor(anchor); validateSinkReceiptBody(body); validateSignedSinkReceipt(receipt);
  assert.equal(verifySinkReceipt(receipt, anchor, expected), true);
  assert.equal(verifySinkReceipt(receipt, anchor, expected), true, 'an exact retry is idempotent; caller retains decision state');
  assert.equal('privateKey' in anchor, false); assert.equal('publicKey' in receipt, false);
  assert.equal(body.requestDigest, effectRequestDigest(expected.request));
  assert.equal(body.valueDigest, sinkValueDigest(result));
});

test('signed terminal fence has no committed value or commit ID', () => {
  const { anchor, body, expected, receipt } = fixture('not_committed');
  assert.equal(verifySinkReceipt(receipt, anchor, expected), true);
  assert.equal(body.valueDigest, null); assert.equal(body.commitId, null);
  assert.equal(verifySinkReceipt(receipt, anchor, { ...expected, disposition: 'committed', value: result }), false);
  assert.throws(() => validateSinkReceiptBody({ ...body, commitId: 'false-commit' }), /fenced/);
  assert.throws(() => validateSinkReceiptBody({ ...body, valueDigest: sinkValueDigest(result) }), /fenced/);
  assert.throws(() => validateSinkReceiptBody({ ...body, sinkSequence: '0' }), /sequence/);
});

test('forgery, signed-field alteration, wrong key and signer mismatch are refused', () => {
  const { anchor, body, expected, receipt, keys } = fixture();
  const other = generateKeyPairSync('ed25519');
  const wrongKeyAnchor = { ...anchor, publicKey: other.publicKey.export({ format: 'der', type: 'spki' }).toString('base64') };
  assert.equal(verifySinkReceipt(receipt, wrongKeyAnchor, expected), false);
  assert.throws(() => signSinkReceipt(body, other.privateKey, anchor), /does not match anchor/);
  for (const altered of [
    { ...body, deploymentId: 'deployment:2' }, { ...body, decisionId: 'decision:forged' },
    { ...body, sinkSequence: '2' }, { ...body, commitId: 'commit:2' },
    { ...body, policyEpoch: '8' }, { ...body, adapterArtifactDigest: domainDigest('aether.effect-adapter-artifact/3', 'evil') },
  ]) assert.equal(verifySinkReceipt({ ...receipt, body: altered }, anchor, expected), false);
  assert.equal(verifySinkReceipt({ ...receipt, signature: 'A'.repeat(86) + '==' }, anchor, expected), false);
  assert.equal(verifySinkReceipt({ ...receipt, signature: receipt.signature.slice(0, -2) + '!!' }, anchor, expected), false);
  assert.throws(() => signSinkReceipt({ ...body, sinkId: 'sink:wrong' }, keys.privateKey, anchor), /anchor context/);
  assert.throws(() => signSinkReceipt(body, generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey, anchor), /Ed25519/);
});

test('valid signature cannot be replayed into a different operation, repository, deployment, policy or value', () => {
  const { anchor, expected, receipt } = fixture();
  const changedPayload: TaggedValueV1 = { tag: 'string', value: 'charge:99' };
  const wrongCases: SinkReceiptExpectationV1[] = [
    { ...expected, repositoryId: 'repo:b' }, { ...expected, deploymentId: 'deployment:2' },
    { ...expected, sinkAuthorityId: 'authority:other' }, { ...expected, sinkId: 'sink:2' },
    { ...expected, adapterArtifactDigest: domainDigest('aether.effect-adapter-artifact/3', 'unapproved') },
    { ...expected, request: request({ executionId: 'execution:2' }) },
    { ...expected, request: request({ effectId: 'effect:2' }) },
    { ...expected, request: request({ policyEpoch: '8' }) },
    { ...expected, request: request({ capabilityGrantRef: 'grant:2' }) },
    { ...expected, request: request({ payload: changedPayload, payloadDigest: effectPayloadDigest(changedPayload) }) },
    { ...expected, request: request({ deadline: '1001' }) },
    { ...expected, disposition: 'not_committed', value: null },
    { ...expected, value: { tag: 'int', value: '43' } },
  ];
  for (const item of wrongCases) assert.equal(verifySinkReceipt(receipt, anchor, item), false, encodeCanonical(item).toString());
  assert.equal(verifySinkReceipt(receipt, { ...anchor, keyEpoch: '4' }, expected), false);
  assert.equal(verifySinkReceipt(receipt, { ...anchor, keyId: 'key:rotated' }, expected), false);
  assert.equal(verifySinkReceipt(receipt, { ...anchor, repositoryId: 'repo:other' }, expected), false);
});

test('even a valid sink signature must agree with independently supplied request and grant context', () => {
  const { anchor, body, expected, keys } = fixture();
  for (const changed of [
    { requestDigest: domainDigest('aether.effect/1', 'different') },
    { payloadDigest: effectPayloadDigest({ tag: 'null' }) },
    { policyEpoch: '8' }, { capabilityGrantRef: 'grant:other' },
    { adapterArtifactDigest: domainDigest('aether.effect-adapter-artifact/3', 'other') },
    { valueDigest: sinkValueDigest({ tag: 'int', value: '99' }) },
    { deploymentId: 'deployment:other' },
  ]) {
    const signed = signSinkReceipt({ ...body, ...changed }, keys.privateKey, anchor);
    assert.equal(verifySinkReceipt(signed, anchor, expected), false);
  }
});

test('malformed, oversized, accessor and noncanonical receipt or anchor objects fail closed', () => {
  const { anchor, body, expected, receipt } = fixture();
  const malformed = [
    { ...receipt, debug: 'extra' }, { ...receipt, format: 'aether.sink-receipt/2' },
    { ...receipt, signature: receipt.signature + '=' },
    { ...receipt, body: { ...body, requestDigest: 'bad' } },
    { ...receipt, body: { ...body, valueDigest: null } },
    { ...receipt, body: { ...body, commitId: null } },
    { ...receipt, body: { ...body, sinkSequence: '01' } },
    { ...receipt, body: { ...body, extra: true } },
    { ...receipt, body: { ...body, decisionId: 'x'.repeat(70_000) } },
    Object.defineProperty({ ...receipt }, 'signature', { enumerable: true, get() { throw new Error('accessor read'); } }),
  ];
  for (const item of malformed) assert.equal(verifySinkReceipt(item, anchor, expected), false);
  for (const item of [
    { ...anchor, publicKey: anchor.publicKey + '=' }, { ...anchor, keyEpoch: '03' },
    { ...anchor, extra: true }, { ...anchor, publicKey: 'not-a-key' },
    { ...anchor, publicKey: Buffer.concat([Buffer.from(anchor.publicKey, 'base64'), Buffer.from([0])]).toString('base64') },
    { ...anchor, publicKey: generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({ format: 'der', type: 'spki' }).toString('base64') },
  ]) assert.equal(verifySinkReceipt(receipt, item as SinkPublicAnchorV1, expected), false);
});
