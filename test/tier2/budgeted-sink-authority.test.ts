import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { encodeCanonical } from '../../src/fabric/encoding.ts';
import { effectPayloadDigest } from '../../src/fabric/effects.ts';
import { domainDigest } from '../../src/fabric/identity.ts';
import { createSinkStateWitness, type SinkStateHeadV1 } from '../../src/fabric/sink-state-witness.ts';
import type { SinkPublicAnchorV1 } from '../../src/fabric/sink-receipt.ts';
import { BudgetedSinkAuthority, budgetedSinkGrantRefV3 }
  from '../../src/tier2/budgeted-sink-authority.ts';
import { ResourceBudgetBridge } from '../../src/tier2/resource-budget-bridge.ts';
import { openBridgeFixture, effectRequest, amount } from './resource-budget-bridge-fixture.ts';

test('operator budget authority pins a real bridge and exact full requests before host config', () => {
  const directory = mkdtempSync(join(tmpdir(), 'aether-budgeted-sink-authority-'));
  try {
    const bridge = openBridgeFixture(directory).bridge;
    const key = generateKeyPairSync('ed25519');
    const anchor: SinkPublicAnchorV1 = { format: 'aether.sink-anchor/1',
      repositoryId: 'repo:budget-authority', sinkAuthorityId: 'operator:budget-authority',
      sinkId: 'sink:budget-authority', keyId: 'key:budget-authority', keyEpoch: '1',
      publicKey: key.publicKey.export({ format: 'der', type: 'spki' }).toString('base64') };
    const artifact = domainDigest('aether.effect-adapter-artifact/3', 'budget-authority');
    let head: SinkStateHeadV1 = { revision: '0', journal: null };
    const witness = createSinkStateWitness({ authorityId: 'operator:witness', anchor,
      adapterArtifactDigest: artifact, read: () => head,
      advance: (expected, journal) => {
        assert.equal(head.revision, expected);
        head = { revision: String(BigInt(expected) + 1n), journal }; return head;
      } });
    const request = effectRequest('one', 'grant-0');
    const options = { repositoryId: anchor.repositoryId, deploymentId: 'deployment:budget-authority',
      anchor, sinkStateWitness: witness, approvedAdapterArtifactDigest: artifact,
      owner: 'budget-service', charge: amount(7), expectedRequests: [request], bridge };
    const authority = new BudgetedSinkAuthority(options);
    BudgetedSinkAuthority.assert(authority);
    assert.equal(authority.bridge, bridge);
    assert.equal(authority.bridgeProfileDigest, bridge.profileDigest);
    assert.equal(authority.reservationFor(request), 'grant-0');
    assert.deepEqual(encodeCanonical(authority.expectedRequest(request.executionId, request.effectId)),
      encodeCanonical(request));
    assert.throws(() => authority.expectedRequest(request.executionId, 'other'),
      /unplanned budgeted sink effect/);
    const alteredPayload = { tag: 'string' as const, value: 'different' };
    assert.throws(() => authority.reservationFor({ ...request, payload: alteredPayload,
      payloadDigest: effectPayloadDigest(alteredPayload) }), /differs from operator inventory/);
    const forgedBridge = Object.assign(Object.create(ResourceBudgetBridge.prototype),
      { profileDigest: bridge.profileDigest }) as ResourceBudgetBridge;
    assert.throws(() => new BudgetedSinkAuthority({ ...options, bridge: forgedBridge }),
      /branded|instance|bridge/i);
    assert.throws(() => BudgetedSinkAuthority.assert({ ...authority }), /independently selected/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('budgeted grant reference v3 binds host, target, reservation and signed policy without host config', () => {
  const base = { repositoryId: 'repo:budget-authority',
    deploymentId: 'deployment:budget-authority',
    hostJournalWitnessDigest: domainDigest('aether.process-host-journal-witness/1', 'host'),
    executionManifest: domainDigest('aether.execution/1', 'module'),
    signedEffectPolicyDigest: domainDigest('aether.effect-resource-policy/6', 'policy'),
    sinkAnchorDigest: domainDigest('aether.sink-anchor/1', 'sink'),
    sinkStateWitnessDigest: domainDigest('aether.sink-state-witness/1', 'witness'),
    approvedAdapterArtifactDigest: domainDigest('aether.effect-adapter-artifact/3', 'artifact'),
    generation: '1', unit: 'worker', operationId: 'effect-boundary',
    effectId: 'operation-0', capability: 'cap:test:sink', policyEpoch: '1',
    reservationId: 'grant-0', resourcePath: ['account', 'alice'] };
  const reference = budgetedSinkGrantRefV3(base);
  for (const changed of [
    { ...base, reservationId: 'grant-1' },
    { ...base, resourcePath: ['account', 'bob'] },
    { ...base, signedEffectPolicyDigest: domainDigest('aether.effect-resource-policy/6', 'other') },
    { ...base, hostJournalWitnessDigest: domainDigest('aether.process-host-journal-witness/1', 'other') },
    { ...base, generation: '2' },
  ]) assert.notEqual(budgetedSinkGrantRefV3(changed), reference);
  assert.throws(() => budgetedSinkGrantRefV3({ ...base, resourcePath: [] }),
    /bounded budgeted sink resource path/);
});
