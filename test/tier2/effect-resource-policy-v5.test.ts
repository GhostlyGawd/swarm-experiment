import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { buildLedgerExample, CAP_LEDGER_APPEND } from '../../src/examples/ledger.ts';
import { createEvidenceManifest } from '../../src/fabric/evidence.ts';
import { encodeCanonical } from '../../src/fabric/encoding.ts';
import { domainDigest } from '../../src/fabric/identity.ts';
import { effectAdapterDigest } from '../../src/fabric/effects.ts';
import { createEffectSignerAnchor, assertAnchoredEffectPolicy } from '../../src/tier2/effect-signer-anchor.ts';
import { assertEffectResourceAdapterV5, assertEffectResourceSinkContextV5,
  assertSignedEffectResourcePolicyV5, effectResourcePathV5, effectResourcePolicyDigestV5,
  signEffectResourcePolicyV5, validateEffectResourcePolicyBodyV5,
  type EffectResourcePolicyBodyV5 } from '../../src/tier2/effect-resource-policy.ts';

function fixture() {
  const ex = buildLedgerExample('attested-sink-resource-policy');
  const digest = (value: string) => domainDigest('aether.resource-policy-v5-test/1', value);
  const base = createEvidenceManifest({ module: ex.module, registry: ex.capabilities,
    specification: 'Signed external sink resource.', semanticsVersion: 'reference/1',
    compilerDigest: digest('compiler'), capabilityPolicyDigest: digest('placeholder'),
    target: { abiVersion: 'process/1', profileDigest: digest('profile'), artifactDigest: digest('artifact') } });
  const adapter = { id: 'attested-ledger/1', semantics: { readOnly: false,
    atomicIdempotency: true, transactional: false, reconciliation: true } as const,
    execute: () => ({ tag: 'null' as const }), reconcile: () => ({ state: 'unknown' as const }) };
  const adapterDigest = effectAdapterDigest(adapter);
  const artifactDigest = domainDigest('aether.effect-adapter-artifact/3', 'approved');
  const sinkAnchorDigest = domainDigest('aether.sink-anchor/1', 'approved-anchor');
  const sinkStateWitnessDigest = domainDigest('aether.sink-state-witness/1', 'approved-witness');
  const body: EffectResourcePolicyBodyV5 = { format: 'aether.effect-resource-policy/5',
    repositoryId: 'repository', astRoot: base.astRoot, policyEpoch: '7', rules: [{
      capability: CAP_LEDGER_APPEND, prefix: ['ledger', 'append'], argument: null,
      adapterId: adapter.id, adapterDigest, adapterArtifactDigest: artifactDigest,
      deadline: '1000', clockDomain: 'trusted-clock', deploymentId: 'deployment-7',
      sinkAnchorDigest, sinkStateWitnessDigest,
    }] };
  const manifest = { ...base, capabilityPolicyDigest: effectResourcePolicyDigestV5(body) };
  const keys = generateKeyPairSync('ed25519'), other = generateKeyPairSync('ed25519');
  const policy = signEffectResourcePolicyV5(body, 'policy-signer', keys.privateKey);
  const anchor = createEffectSignerAnchor({ repositoryId: 'repository', signer: 'policy-signer',
    epochAuthorityId: 'epoch-store', publicKey: keys.publicKey, currentEpoch: () => '7' });
  return { body, base, manifest, policy, keys, other, anchor, adapter, adapterDigest,
    artifactDigest, sinkAnchorDigest, sinkStateWitnessDigest };
}

test('V5 policy binds an idempotent external write to signed deployment, sink and witness context', () => {
  const f = fixture();
  assertSignedEffectResourcePolicyV5(f.policy, f.manifest, 'repository', '7', f.keys.publicKey);
  assertAnchoredEffectPolicy(f.anchor, f.policy, f.manifest, 'repository', 'anchored-v5');
  assert.deepEqual(effectResourcePathV5(f.policy, CAP_LEDGER_APPEND,
    [{ tag: 'string', value: '../ignored' }]), ['ledger', 'append']);
  assertEffectResourceAdapterV5(f.policy, CAP_LEDGER_APPEND,
    { id: f.adapter.id, digest: f.adapterDigest, artifactDigest: f.artifactDigest });
  const context = { deploymentId: 'deployment-7', sinkAnchorDigest: f.sinkAnchorDigest,
    sinkStateWitnessDigest: f.sinkStateWitnessDigest, approvedAdapterArtifactDigest: f.artifactDigest };
  assertEffectResourceSinkContextV5(f.policy, CAP_LEDGER_APPEND, context);
  for (const changed of [
    { ...context, deploymentId: 'deployment-8' },
    { ...context, sinkAnchorDigest: domainDigest('aether.sink-anchor/1', 'other') },
    { ...context, sinkStateWitnessDigest: domainDigest('aether.sink-state-witness/1', 'other') },
    { ...context, approvedAdapterArtifactDigest: domainDigest('aether.effect-adapter-artifact/3', 'other') },
  ]) assert.throws(() => assertEffectResourceSinkContextV5(f.policy, CAP_LEDGER_APPEND, changed), /outside signed resource policy v5/);
  assert.throws(() => assertEffectResourceAdapterV5(f.policy, CAP_LEDGER_APPEND,
    { id: f.adapter.id, digest: f.adapterDigest, artifactDigest: null }), /outside signed resource policy v5/);
  assert.throws(() => assertEffectResourceAdapterV5(f.policy, CAP_LEDGER_APPEND,
    { id: f.adapter.id, digest: domainDigest('aether.effect-adapter/1', 'other'), artifactDigest: f.artifactDigest }), /outside signed resource policy v5/);
});

test('V5 rejects variable targets, changed semantics, malformed context and unsorted rules', () => {
  const f = fixture(), rule = f.body.rules[0];
  const invalid = (changed: unknown) => assert.throws(() => validateEffectResourcePolicyBodyV5(changed));
  invalid({ ...f.body, rules: [{ ...rule, argument: 0 }] });
  invalid({ ...f.body, rules: [{ ...rule, prefix: ['..'] }] });
  invalid({ ...f.body, rules: [{ ...rule, adapterDigest: domainDigest('aether.effect-adapter/1',
    { id: rule.adapterId, semantics: { readOnly: true, atomicIdempotency: true,
      transactional: false, reconciliation: true } }) }] });
  invalid({ ...f.body, rules: [{ ...rule, adapterArtifactDigest: domainDigest('aether.other/1', 'artifact') }] });
  invalid({ ...f.body, rules: [{ ...rule, sinkAnchorDigest: domainDigest('aether.other/1', 'anchor') }] });
  invalid({ ...f.body, rules: [{ ...rule, sinkStateWitnessDigest: domainDigest('aether.other/1', 'witness') }] });
  invalid({ ...f.body, rules: [{ ...rule, deploymentId: '' }] });
  invalid({ ...f.body, rules: [{ ...rule, deadline: '-1' }] });
  invalid({ ...f.body, rules: [{ ...rule, clockDomain: '' }] });
  invalid({ ...f.body, rules: [{ ...rule, extra: true }] });
  invalid({ ...f.body, rules: [rule, rule] });
  invalid({ ...f.body, rules: Array.from({ length: 129 }, (_, index) =>
    ({ ...rule, capability: `cap-${String(index).padStart(3, '0')}` })) });
});

test('V5 verification rejects stale or foreign manifests, signer, epoch and signature domains', () => {
  const f = fixture();
  assert.throws(() => assertSignedEffectResourcePolicyV5(f.policy, f.base, 'repository', '7', f.keys.publicKey), /stale or foreign/);
  assert.throws(() => assertSignedEffectResourcePolicyV5(f.policy, f.manifest, 'other', '7', f.keys.publicKey), /stale or foreign/);
  assert.throws(() => assertSignedEffectResourcePolicyV5(f.policy, f.manifest, 'repository', '8', f.keys.publicKey), /stale or foreign/);
  assert.throws(() => assertSignedEffectResourcePolicyV5(f.policy,
    { ...f.manifest, astRoot: domainDigest('aether.resource-policy-v5-test/1', 'other-ast') },
    'repository', '7', f.keys.publicKey), /stale or foreign/);
  assert.throws(() => assertSignedEffectResourcePolicyV5(f.policy, f.manifest, 'repository', '7', f.other.publicKey), /untrusted/);
  const oldDomainSignature = sign(null, encodeCanonical({ domain: 'aether.effect-resource-policy-signature/4',
    body: f.body, signer: f.policy.signer }), f.keys.privateKey).toString('base64');
  assert.throws(() => assertSignedEffectResourcePolicyV5({ ...f.policy, signature: oldDomainSignature },
    f.manifest, 'repository', '7', f.keys.publicKey), /untrusted/);
  assert.throws(() => assertSignedEffectResourcePolicyV5({ ...f.policy, format: 'aether.signed-effect-resource-policy/4' },
    f.manifest, 'repository', '7', f.keys.publicKey), /unsupported/);
  assert.throws(() => assertAnchoredEffectPolicy(f.anchor, f.policy, f.manifest, 'repository'), /requires signed policy v3/);
  assert.throws(() => assertAnchoredEffectPolicy(f.anchor, f.policy, f.manifest, 'repository', 'anchored-v4'), /requires v4/);
});
