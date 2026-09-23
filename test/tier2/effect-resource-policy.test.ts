import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { buildLedgerExample, CAP_LEDGER_APPEND } from '../../src/examples/ledger.ts';
import { createEvidenceManifest } from '../../src/fabric/evidence.ts';
import { encodeCanonical } from '../../src/fabric/encoding.ts';
import { domainDigest } from '../../src/fabric/identity.ts';
import { effectAdapterDigest } from '../../src/fabric/effects.ts';
import { assertEffectResourceAdapter, assertEffectResourceAdapterV2, assertEffectResourceAdapterV3, assertSignedEffectResourcePolicy, assertSignedEffectResourcePolicyV2, assertSignedEffectResourcePolicyV3, effectResourcePath, effectResourcePathV2, effectResourcePathV3, effectResourcePolicyDigest, effectResourcePolicyDigestV2, effectResourcePolicyDigestV3, signEffectResourcePolicy, signEffectResourcePolicyV2, signEffectResourcePolicyV3, validateEffectResourcePolicyBody, validateEffectResourcePolicyBodyV3, type EffectResourcePolicyBodyV1, type EffectResourcePolicyBodyV2, type EffectResourcePolicyBodyV3 } from '../../src/tier2/effect-resource-policy.ts';
import { adapterArtifactDigest, adapterArtifactForSource, legacyAdapterArtifactForSource, admitAdapterSource, admittedAdapterArtifactDigest } from '../../src/tier2/adapter-artifact.ts';
import { brokerAdapterIdentity, type RuntimeEffectRouter } from '../../src/tier3/effects.ts';

test('signed resource policy binds extraction to exact manifest, repository, epoch, and Ed25519 signer', () => {
  const ex = buildLedgerExample('signed-resource-policy');
  const digest = (value: string) => domainDigest('aether.resource-policy-test/1', value);
  const base = createEvidenceManifest({ module: ex.module, registry: ex.capabilities, specification: 'Bound resources.', semanticsVersion: 'reference/1', compilerDigest: digest('compiler'), capabilityPolicyDigest: digest('placeholder'), target: { abiVersion: 'process/1', profileDigest: digest('profile'), artifactDigest: digest('artifact') } });
  const adapter = { id: 'test-ledger/1', semantics: { readOnly: false, atomicIdempotency: false, transactional: false, reconciliation: false }, execute: () => ({ tag: 'null' as const }) };
  const body: EffectResourcePolicyBodyV1 = { format: 'aether.effect-resource-policy/1', repositoryId: 'repository', astRoot: base.astRoot, policyEpoch: '0', rules: [{ capability: CAP_LEDGER_APPEND, prefix: ['ledger'], argument: 0, adapterId: adapter.id, adapterDigest: effectAdapterDigest(adapter) }] };
  const manifest = { ...base, capabilityPolicyDigest: effectResourcePolicyDigest(body) };
  const { privateKey, publicKey } = generateKeyPairSync('ed25519'), other = generateKeyPairSync('ed25519');
  const policy = signEffectResourcePolicy(body, 'policy-signer', privateKey);
  assertSignedEffectResourcePolicy(policy, manifest, 'repository', '0', publicKey);
  assert.doesNotThrow(() => assertEffectResourceAdapter(policy, CAP_LEDGER_APPEND, { id: adapter.id, digest: effectAdapterDigest(adapter) }));
  assert.throws(() => assertEffectResourceAdapter(policy, CAP_LEDGER_APPEND, { id: adapter.id, digest: digest('other-adapter') }), /outside signed resource policy/);
  assert.deepEqual(effectResourcePath(policy, CAP_LEDGER_APPEND, [{ tag: 'string', value: 'alice' }]), ['ledger', 'alice']);
  assert.throws(() => effectResourcePath(policy, CAP_LEDGER_APPEND, [{ tag: 'int', value: '1' }]), /outside signed resource grammar/);
  assert.throws(() => effectResourcePath(policy, CAP_LEDGER_APPEND, [{ tag: 'string', value: '..' }]), /outside signed resource grammar/);
  assert.throws(() => assertSignedEffectResourcePolicy(policy, base, 'repository', '0', publicKey), /stale or foreign/);
  assert.throws(() => assertSignedEffectResourcePolicy(policy, manifest, 'other-repository', '0', publicKey), /stale or foreign/);
  assert.throws(() => assertSignedEffectResourcePolicy(policy, manifest, 'repository', '1', publicKey), /stale or foreign/);
  assert.throws(() => assertSignedEffectResourcePolicy(policy, { ...manifest, astRoot: digest('other-ast') }, 'repository', '0', publicKey), /stale or foreign/);
  assert.throws(() => assertSignedEffectResourcePolicy(policy, manifest, 'repository', '0', other.publicKey), /untrusted/);
  assert.throws(() => assertSignedEffectResourcePolicy({ ...policy, signature: 'A'.repeat(86) + '==' }, manifest, 'repository', '0', publicKey), /untrusted/);
  assert.throws(() => validateEffectResourcePolicyBody({ ...body, rules: [{ ...body.rules[0], prefix: ['..'] }] }), /invalid effect resource path/);
  assert.throws(() => validateEffectResourcePolicyBody({ ...body, rules: [body.rules[0], body.rules[0]] }), /noncanonical/);
});

test('v2 signed resource policy binds loader-admitted code bytes and refuses descriptor-only copies', async () => {
  const ex = buildLedgerExample('artifact-resource-policy');
  const digest = (value: string) => domainDigest('aether.resource-policy-test/1', value);
  const base = createEvidenceManifest({ module: ex.module, registry: ex.capabilities, specification: 'Bound adapter bytes.', semanticsVersion: 'reference/1', compilerDigest: digest('compiler'), capabilityPolicyDigest: digest('placeholder'), target: { abiVersion: 'process/1', profileDigest: digest('profile'), artifactDigest: digest('artifact') } });
  const semantics = { readOnly: false, atomicIdempotency: true, transactional: false, reconciliation: true } as const;
  const source = new TextEncoder().encode(`export default {id:'loaded-ledger/1',semantics:{readOnly:false,atomicIdempotency:true,transactional:false,reconciliation:true},execute(){return{tag:'null'};},reconcile(){return{state:'not_committed'};}};`);
  const artifact = legacyAdapterArtifactForSource(source, CAP_LEDGER_APPEND, 'loaded-ledger/1', semantics);
  const adapter = await admitAdapterSource(source, artifact, { legacyProfile: 'aether.adapter-js-legacy-v1/1' }), artifactDigest = admittedAdapterArtifactDigest(adapter);
  assert.equal(artifactDigest, adapterArtifactDigest(artifact));
  const body: EffectResourcePolicyBodyV2 = { format: 'aether.effect-resource-policy/2', repositoryId: 'repository', astRoot: base.astRoot, policyEpoch: '0',
    rules: [{ capability: CAP_LEDGER_APPEND, prefix: ['ledger'], argument: 0, adapterId: adapter.id, adapterDigest: effectAdapterDigest(adapter), adapterArtifactDigest: artifactDigest! }] };
  const manifest = { ...base, capabilityPolicyDigest: effectResourcePolicyDigestV2(body) }, keys = generateKeyPairSync('ed25519');
  const policy = signEffectResourcePolicyV2(body, 'artifact-signer', keys.privateKey);
  assertSignedEffectResourcePolicyV2(policy, manifest, 'repository', '0', keys.publicKey);
  assert.deepEqual(effectResourcePathV2(policy, CAP_LEDGER_APPEND, [{ tag: 'string', value: 'alice' }]), ['ledger', 'alice']);
  assert.doesNotThrow(() => assertEffectResourceAdapterV2(policy, CAP_LEDGER_APPEND, { id: adapter.id, digest: effectAdapterDigest(adapter), artifactDigest }));
  assert.throws(() => assertEffectResourceAdapterV2(policy, CAP_LEDGER_APPEND, { id: adapter.id, digest: effectAdapterDigest(adapter), artifactDigest: admittedAdapterArtifactDigest({ ...adapter }) }), /artifact is outside/);
  assert.throws(() => assertSignedEffectResourcePolicyV2(policy, base, 'repository', '0', keys.publicKey), /stale or foreign/);
  assert.throws(() => assertSignedEffectResourcePolicyV2(policy, manifest, 'repository', '1', keys.publicKey), /stale or foreign/);
  assert.throws(() => assertSignedEffectResourcePolicyV2({ ...policy, body: { ...body, rules: [{ ...body.rules[0], adapterArtifactDigest: domainDigest('aether.effect-adapter-artifact/1', 'changed') }] } }, manifest, 'repository', '0', keys.publicKey), /stale or foreign/);
  const fake: RuntimeEffectRouter = { mode: 'live', bind() {}, invoke() { return null; }, fork() { return fake; },
    adapterIdentity() { return { id: adapter.id, digest: effectAdapterDigest(adapter), artifactDigest }; } };
  assert.throws(() => brokerAdapterIdentity(fake, CAP_LEDGER_APPEND), /broker-backed router/);
});

test('v3 policy signs import-free adapter artifact identity with independent signature domain', async () => {
  const ex = buildLedgerExample('import-free-resource-policy');
  const digest = (value: string) => domainDigest('aether.resource-policy-test/1', value);
  const base = createEvidenceManifest({ module: ex.module, registry: ex.capabilities, specification: 'Import-free adapter identity.', semanticsVersion: 'reference/1', compilerDigest: digest('compiler'), capabilityPolicyDigest: digest('placeholder'), target: { abiVersion: 'process/1', profileDigest: digest('profile'), artifactDigest: digest('artifact') } });
  const semantics = { readOnly: false, atomicIdempotency: true, transactional: false, reconciliation: true } as const;
  const source = new TextEncoder().encode(`export default {id:'import-free-ledger/1',semantics:{readOnly:false,atomicIdempotency:true,transactional:false,reconciliation:true},execute(){return{tag:'null'};},reconcile(){return{state:'not_committed'};}};`);
  const artifact = adapterArtifactForSource(source, CAP_LEDGER_APPEND, 'import-free-ledger/1', semantics);
  const adapter = await admitAdapterSource(source, artifact);
  const artifactDigest = admittedAdapterArtifactDigest(adapter);
  assert.equal(artifact.format, 'aether.effect-adapter-artifact/2');
  assert.equal(artifactDigest, adapterArtifactDigest(artifact));
  const body: EffectResourcePolicyBodyV3 = { format: 'aether.effect-resource-policy/3', repositoryId: 'repository', astRoot: base.astRoot, policyEpoch: '2',
    rules: [{ capability: CAP_LEDGER_APPEND, prefix: ['ledger'], argument: 0, adapterId: adapter.id, adapterDigest: effectAdapterDigest(adapter), adapterArtifactDigest: artifactDigest! }] };
  const manifest = { ...base, capabilityPolicyDigest: effectResourcePolicyDigestV3(body) };
  const keys = generateKeyPairSync('ed25519'), other = generateKeyPairSync('ed25519');
  const policy = signEffectResourcePolicyV3(body, 'artifact-signer', keys.privateKey);
  assertSignedEffectResourcePolicyV3(policy, manifest, 'repository', '2', keys.publicKey);
  assert.deepEqual(effectResourcePathV3(policy, CAP_LEDGER_APPEND, [{ tag: 'string', value: 'alice' }]), ['ledger', 'alice']);
  assert.doesNotThrow(() => assertEffectResourceAdapterV3(policy, CAP_LEDGER_APPEND, { id: adapter.id, digest: effectAdapterDigest(adapter), artifactDigest }));

  assert.throws(() => validateEffectResourcePolicyBodyV3({ ...body, rules: [{ ...body.rules[0], adapterArtifactDigest: domainDigest('aether.effect-adapter-artifact/1', 'legacy') }] }), /invalid digest or domain/);
  assert.throws(() => validateEffectResourcePolicyBodyV3({ ...body, rules: [body.rules[0], body.rules[0]] }), /noncanonical/);
  assert.throws(() => validateEffectResourcePolicyBodyV3({ ...body, rules: [{ ...body.rules[0], prefix: ['..'] }] }), /invalid effect resource path/);
  assert.throws(() => validateEffectResourcePolicyBodyV3({ ...body, rules: [{ ...body.rules[0], extra: true }] }), /unknown, missing or accessor object fields/);
  assert.throws(() => effectResourcePathV3(policy, CAP_LEDGER_APPEND, [{ tag: 'string', value: '..' }]), /outside signed resource grammar/);
  assert.throws(() => effectResourcePathV3(policy, CAP_LEDGER_APPEND, [{ tag: 'int', value: '1' }]), /outside signed resource grammar/);
  assert.throws(() => assertEffectResourceAdapterV3(policy, CAP_LEDGER_APPEND, { id: adapter.id, digest: effectAdapterDigest(adapter), artifactDigest: null }), /outside signed resource policy v3/);
  assert.throws(() => assertEffectResourceAdapterV3(policy, CAP_LEDGER_APPEND, { id: adapter.id, digest: effectAdapterDigest(adapter), artifactDigest: domainDigest('aether.effect-adapter-artifact/2', 'other') }), /outside signed resource policy v3/);
  assert.throws(() => assertSignedEffectResourcePolicyV3(policy, base, 'repository', '2', keys.publicKey), /stale or foreign/);
  assert.throws(() => assertSignedEffectResourcePolicyV3(policy, manifest, 'other-repository', '2', keys.publicKey), /stale or foreign/);
  assert.throws(() => assertSignedEffectResourcePolicyV3(policy, manifest, 'repository', '3', keys.publicKey), /stale or foreign/);
  assert.throws(() => assertSignedEffectResourcePolicyV3(policy, manifest, 'repository', '2', other.publicKey), /untrusted/);
  assert.throws(() => assertSignedEffectResourcePolicyV2(policy, manifest, 'repository', '2', keys.publicKey), /unsupported/);
  assert.throws(() => assertSignedEffectResourcePolicyV3({ ...policy, format: 'aether.signed-effect-resource-policy/2' }, manifest, 'repository', '2', keys.publicKey), /unsupported/);
  const wrongDomainSignature = sign(null, encodeCanonical({ domain: 'aether.effect-resource-policy-signature/2', body, signer: policy.signer }), keys.privateKey).toString('base64');
  assert.throws(() => assertSignedEffectResourcePolicyV3({ ...policy, signature: wrongDomainSignature }, manifest, 'repository', '2', keys.publicKey), /untrusted/);
  assert.throws(() => assertSignedEffectResourcePolicyV3({ ...policy, signature: 'A'.repeat(86) + '==' }, manifest, 'repository', '2', keys.publicKey), /untrusted/);
  assert.throws(() => assertSignedEffectResourcePolicyV3({ ...policy, signature: policy.signature.slice(0, -2) + 'AA' }, manifest, 'repository', '2', keys.publicKey), /untrusted|invalid/);
});
