import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { buildLedgerExample, CAP_LEDGER_APPEND } from '../../src/examples/ledger.ts';
import { createEvidenceManifest } from '../../src/fabric/evidence.ts';
import { encodeCanonical } from '../../src/fabric/encoding.ts';
import { domainDigest } from '../../src/fabric/identity.ts';
import { effectAdapterDigest } from '../../src/fabric/effects.ts';
import { capability } from '../../src/tier1/ids.ts';
import { createEffectSignerAnchor, assertAnchoredEffectPolicy } from '../../src/tier2/effect-signer-anchor.ts';
import { assertEffectResourceAdapterV6, assertEffectResourceSinkContextV6,
  assertSignedEffectResourcePolicyV6, effectResourcePathV6, effectResourcePolicyDigestV6,
  signEffectResourcePolicyV6, validateEffectResourcePolicyBodyV6,
  type EffectResourcePolicyBodyV6 } from '../../src/tier2/effect-resource-policy.ts';

const CAP_FIXED = capability('cap:db:receipt');
function fixture() {
  const ex = buildLedgerExample('attested-sink-resource-policy-v6');
  const digest = (value: string) => domainDigest('aether.resource-policy-v6-test/1', value);
  const base = createEvidenceManifest({ module: ex.module, registry: ex.capabilities,
    specification: 'Signed external sink dynamic resource.', semanticsVersion: 'reference/1',
    compilerDigest: digest('compiler'), capabilityPolicyDigest: digest('placeholder'),
    target: { abiVersion: 'process/1', profileDigest: digest('profile'), artifactDigest: digest('artifact') } });
  const adapter = { id: 'attested-ledger/1', semantics: { readOnly: false,
    atomicIdempotency: true, transactional: false, reconciliation: true } as const,
    execute: () => ({ tag: 'null' as const }), reconcile: () => ({ state: 'unknown' as const }) };
  const adapterDigest = effectAdapterDigest(adapter);
  const artifactDigest = domainDigest('aether.effect-adapter-artifact/3', 'approved');
  const sinkAnchorDigest = domainDigest('aether.sink-anchor/1', 'approved-anchor');
  const sinkStateWitnessDigest = domainDigest('aether.sink-state-witness/1', 'approved-witness');
  const dynamic = { capability: CAP_LEDGER_APPEND, prefix: ['ledger', 'account'], argument: 1,
    adapterId: adapter.id, adapterDigest, adapterArtifactDigest: artifactDigest,
    deadline: '1000', clockDomain: 'trusted-clock', deploymentId: 'deployment-7',
    sinkAnchorDigest, sinkStateWitnessDigest };
  const fixed = { ...dynamic, capability: CAP_FIXED, prefix: ['ledger', 'fixed'], argument: null };
  const body: EffectResourcePolicyBodyV6 = { format: 'aether.effect-resource-policy/6',
    repositoryId: 'repository', astRoot: base.astRoot, policyEpoch: '7', rules: [dynamic, fixed] };
  const manifest = { ...base, capabilityPolicyDigest: effectResourcePolicyDigestV6(body) };
  const keys = generateKeyPairSync('ed25519'), other = generateKeyPairSync('ed25519');
  const policy = signEffectResourcePolicyV6(body, 'policy-signer', keys.privateKey);
  const anchor = createEffectSignerAnchor({ repositoryId: 'repository', signer: 'policy-signer',
    epochAuthorityId: 'epoch-store', publicKey: keys.publicKey, currentEpoch: () => '7' });
  return { body, base, manifest, policy, keys, other, anchor, adapter, adapterDigest,
    artifactDigest, sinkAnchorDigest, sinkStateWitnessDigest };
}

test('V6 signed dynamic segment selects exactly one tagged argument and preserves fixed rules', () => {
  const f = fixture();
  assertSignedEffectResourcePolicyV6(f.policy, f.manifest, 'repository', '7', f.keys.publicKey);
  assertAnchoredEffectPolicy(f.anchor, f.policy, f.manifest, 'repository', 'anchored-v6');
  assert.deepEqual(effectResourcePathV6(f.policy, CAP_LEDGER_APPEND,
    [{ tag: 'string', value: '../ignored' }, { tag: 'string', value: 'tenant-42' }]),
  ['ledger', 'account', 'tenant-42']);
  assert.deepEqual(effectResourcePathV6(f.policy, CAP_FIXED,
    [{ tag: 'string', value: '../ignored' }]), ['ledger', 'fixed']);
  assertEffectResourceAdapterV6(f.policy, CAP_LEDGER_APPEND,
    { id: f.adapter.id, digest: f.adapterDigest, artifactDigest: f.artifactDigest });
  const context = { deploymentId: 'deployment-7', sinkAnchorDigest: f.sinkAnchorDigest,
    sinkStateWitnessDigest: f.sinkStateWitnessDigest, approvedAdapterArtifactDigest: f.artifactDigest };
  assertEffectResourceSinkContextV6(f.policy, CAP_LEDGER_APPEND, context);
  for (const changed of [
    { ...context, deploymentId: 'deployment-8' },
    { ...context, sinkAnchorDigest: domainDigest('aether.sink-anchor/1', 'other') },
    { ...context, sinkStateWitnessDigest: domainDigest('aether.sink-state-witness/1', 'other') },
    { ...context, approvedAdapterArtifactDigest: domainDigest('aether.effect-adapter-artifact/3', 'other') },
  ]) assert.throws(() => assertEffectResourceSinkContextV6(f.policy, CAP_LEDGER_APPEND, changed), /outside signed resource policy v6/);
  assert.throws(() => assertEffectResourceAdapterV6(f.policy, CAP_LEDGER_APPEND,
    { id: f.adapter.id, digest: f.adapterDigest, artifactDigest: null }), /outside signed resource policy v6/);
});

test('V6 rejects missing, non-string, unsafe and malformed tagged path arguments', () => {
  const f = fixture();
  const path = (args: Parameters<typeof effectResourcePathV6>[2]) => effectResourcePathV6(f.policy, CAP_LEDGER_APPEND, args);
  assert.throws(() => path([]), /missing/);
  assert.throws(() => path([{ tag: 'string', value: 'only-zero' }]), /missing/);
  for (const value of [
    { tag: 'int', value: '1' }, { tag: 'null' },
    { tag: 'string', value: '' }, { tag: 'string', value: '.' }, { tag: 'string', value: '..' },
    { tag: 'string', value: '../escape' }, { tag: 'string', value: 'a/b' },
    { tag: 'string', value: 'a\\b' }, { tag: 'string', value: ' space' },
    { tag: 'string', value: 'é' }, { tag: 'string', value: 'a'.repeat(129) },
    { tag: 'string', value: 'valid', extra: true },
  ]) assert.throws(() => path([{ tag: 'null' }, value] as never), /effect target|unknown|missing|tagged|canonical|object/);
  assert.deepEqual(path([null, { tag: 'string', value: 'valid' }] as never),
    ['ledger', 'account', 'valid']);
  const accessor = [{ tag: 'null' }] as unknown[];
  Object.defineProperty(accessor, '1', { enumerable: true, get: () => ({ tag: 'string', value: 'valid' }) });
  assert.throws(() => path(accessor as never), /accessor forbidden/);
  assert.throws(() => path(new Proxy([{ tag: 'null' }, { tag: 'string', value: 'valid' }], {}) as never), /ordinary tagged array/);
});

test('V6 policy validates sorted bounded rules, write semantics and independent sink context', () => {
  const f = fixture(), rule = f.body.rules[0];
  const invalid = (body: unknown) => assert.throws(() => validateEffectResourcePolicyBodyV6(body));
  for (const argument of [-1, 32, 1.5, '1', undefined])
    invalid({ ...f.body, rules: [{ ...rule, argument }] });
  invalid({ ...f.body, rules: [f.body.rules[1], rule] });
  invalid({ ...f.body, rules: [rule, rule] });
  invalid({ ...f.body, rules: [{ ...rule, prefix: ['..'] }] });
  invalid({ ...f.body, rules: [{ ...rule, prefix: Array(28).fill('ok') }] });
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
  invalid({ ...f.body, rules: Array.from({ length: 129 }, (_, index) =>
    ({ ...rule, capability: `cap:db:op${String(index).padStart(3, '0')}` })) });
});

test('V6 signatures and manifest binding cannot be substituted by V5 or another signer', () => {
  const f = fixture();
  assert.throws(() => assertSignedEffectResourcePolicyV6(f.policy, f.base, 'repository', '7', f.keys.publicKey), /stale or foreign/);
  assert.throws(() => assertSignedEffectResourcePolicyV6(f.policy, f.manifest, 'other', '7', f.keys.publicKey), /stale or foreign/);
  assert.throws(() => assertSignedEffectResourcePolicyV6(f.policy, f.manifest, 'repository', '8', f.keys.publicKey), /stale or foreign/);
  assert.throws(() => assertSignedEffectResourcePolicyV6(f.policy, f.manifest, 'repository', '7', f.other.publicKey), /untrusted/);
  const oldDomainSignature = sign(null, encodeCanonical({ domain: 'aether.effect-resource-policy-signature/5',
    body: f.body, signer: f.policy.signer }), f.keys.privateKey).toString('base64');
  assert.throws(() => assertSignedEffectResourcePolicyV6({ ...f.policy, signature: oldDomainSignature },
    f.manifest, 'repository', '7', f.keys.publicKey), /untrusted/);
  assert.throws(() => assertAnchoredEffectPolicy(f.anchor, f.policy, f.manifest, 'repository', 'anchored-v5'), /requires v5/);
  assert.throws(() => assertAnchoredEffectPolicy(f.anchor, f.policy, f.manifest, 'repository'), /requires signed policy v3/);
});
