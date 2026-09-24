import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { buildLedgerExample, CAP_LEDGER_APPEND } from '../../src/examples/ledger.ts';
import { createEvidenceManifest } from '../../src/fabric/evidence.ts';
import { encodeCanonical } from '../../src/fabric/encoding.ts';
import { domainDigest } from '../../src/fabric/identity.ts';
import { effectAdapterDigest } from '../../src/fabric/effects.ts';
import * as b from '../../src/tier1/build.ts';
import { SymbolSpace } from '../../src/tier1/symbols.ts';
import { GraphStore } from '../../src/tier1/store.ts';
import { assertEffectResourceAdapterV7, assertEffectResourceSinkContextV7,
  assertSignedEffectResourcePolicyV7, effectResourcePathV7, effectResourcePolicyDigestV7,
  signEffectResourcePolicyV7, validateEffectResourcePolicyBodyV7,
  type EffectResourcePolicyBodyV7 } from '../../src/tier2/effect-resource-policy.ts';

function fixture() {
  const ex = buildLedgerExample('attested-sink-resource-policy-v7');
  const digest = (value: string) => domainDigest('aether.resource-policy-v7-test/1', value);
  const base = createEvidenceManifest({ module: ex.module, registry: ex.capabilities,
    specification: 'Signed table and sink rule.', semanticsVersion: 'reference/1',
    compilerDigest: digest('compiler'), capabilityPolicyDigest: digest('placeholder'),
    target: { abiVersion: 'process/1', profileDigest: digest('profile'), artifactDigest: digest('artifact') } });
  const adapter = { id: 'attested-ledger/1', semantics: { readOnly: false,
    atomicIdempotency: true, transactional: false, reconciliation: true } as const,
    execute: () => ({ tag: 'null' as const }), reconcile: () => ({ state: 'unknown' as const }) };
  const rule = { capability: CAP_LEDGER_APPEND, prefix: ['ledger', 'account'], argument: 1,
    adapterId: adapter.id, adapterDigest: effectAdapterDigest(adapter),
    adapterArtifactDigest: domainDigest('aether.effect-adapter-artifact/3', 'approved'),
    deadline: '1000', clockDomain: 'trusted-clock', deploymentId: 'deployment-7',
    sinkAnchorDigest: domainDigest('aether.sink-anchor/1', 'approved-anchor'),
    sinkStateWitnessDigest: domainDigest('aether.sink-state-witness/1', 'approved-witness') };
  const body: EffectResourcePolicyBodyV7 = { format: 'aether.effect-resource-policy/7',
    repositoryId: 'repository', astRoot: base.astRoot, policyEpoch: '7',
    adapterTableDigest: domainDigest('aether.declarative-adapter-table/2', 'table-a'), rules: [rule] };
  const manifest = { ...base, capabilityPolicyDigest: effectResourcePolicyDigestV7(body) };
  const keys = generateKeyPairSync('ed25519'), other = generateKeyPairSync('ed25519');
  const policy = signEffectResourcePolicyV7(body, 'policy-signer', keys.privateKey);
  return { ex, base, body, manifest, keys, other, policy, rule, adapter };
}

test('V7 signs the table digest and preserves V6 dynamic sink rule semantics', () => {
  const f = fixture();
  assertSignedEffectResourcePolicyV7(f.policy, f.manifest, 'repository', '7', f.keys.publicKey);
  assert.deepEqual(effectResourcePathV7(f.policy, CAP_LEDGER_APPEND,
    [{ tag: 'null' }, { tag: 'string', value: 'tenant-42' }]), ['ledger', 'account', 'tenant-42']);
  assertEffectResourceAdapterV7(f.policy, CAP_LEDGER_APPEND, {
    id: f.rule.adapterId, digest: f.rule.adapterDigest, artifactDigest: f.rule.adapterArtifactDigest });
  assertEffectResourceSinkContextV7(f.policy, CAP_LEDGER_APPEND, {
    deploymentId: f.rule.deploymentId, sinkAnchorDigest: f.rule.sinkAnchorDigest,
    sinkStateWitnessDigest: f.rule.sinkStateWitnessDigest,
    approvedAdapterArtifactDigest: f.rule.adapterArtifactDigest });
  assert.throws(() => assertEffectResourceAdapterV7(f.policy, CAP_LEDGER_APPEND, {
    id: f.rule.adapterId, digest: f.rule.adapterDigest, artifactDigest: null }), /outside signed resource policy v7/);
  assert.throws(() => assertEffectResourceSinkContextV7(f.policy, CAP_LEDGER_APPEND, {
    deploymentId: 'other', sinkAnchorDigest: f.rule.sinkAnchorDigest,
    sinkStateWitnessDigest: f.rule.sinkStateWitnessDigest,
    approvedAdapterArtifactDigest: f.rule.adapterArtifactDigest }), /outside signed resource policy v7/);
  assert.throws(() => effectResourcePathV7(f.policy, CAP_LEDGER_APPEND, []), /missing/);
  assert.throws(() => effectResourcePathV7(f.policy, CAP_LEDGER_APPEND,
    [{ tag: 'null' }, { tag: 'string', value: '../escape' }]), /outside signed resource grammar/);
});

test('V7 rejects stale table, AST, epoch, signer and V6 domain substitution', () => {
  const f = fixture();
  const changedTable = { ...f.body,
    adapterTableDigest: domainDigest('aether.declarative-adapter-table/2', 'table-b') };
  const changed = signEffectResourcePolicyV7(changedTable, 'policy-signer', f.keys.privateKey);
  assert.throws(() => assertSignedEffectResourcePolicyV7(changed, f.manifest,
    'repository', '7', f.keys.publicKey), /stale or foreign/);
  const tampered = { ...f.policy, body: changedTable };
  const changedManifest = { ...f.manifest, capabilityPolicyDigest: effectResourcePolicyDigestV7(changedTable) };
  assert.throws(() => assertSignedEffectResourcePolicyV7(tampered, changedManifest,
    'repository', '7', f.keys.publicKey), /untrusted/);
  assert.throws(() => assertSignedEffectResourcePolicyV7(f.policy, f.base,
    'repository', '7', f.keys.publicKey), /stale or foreign/);
  const otherRoot = new GraphStore().intern(buildLedgerExample('other-v7-root').module);
  assert.throws(() => assertSignedEffectResourcePolicyV7(f.policy, { ...f.manifest, astRoot: otherRoot },
    'repository', '7', f.keys.publicKey), /stale or foreign/);
  assert.throws(() => assertSignedEffectResourcePolicyV7(f.policy, f.manifest,
    'repository', '8', f.keys.publicKey), /stale or foreign/);
  assert.throws(() => assertSignedEffectResourcePolicyV7(f.policy, f.manifest,
    'repository', '7', f.other.publicKey), /untrusted/);
  const v6Signature = sign(null, encodeCanonical({ domain: 'aether.effect-resource-policy-signature/6',
    body: f.body, signer: f.policy.signer }), f.keys.privateKey).toString('base64');
  assert.throws(() => assertSignedEffectResourcePolicyV7({ ...f.policy, signature: v6Signature }, f.manifest,
    'repository', '7', f.keys.publicKey), /untrusted/);
});

test('V7 empty rules require a checked exact-root module with no Invoke anywhere', () => {
  const symbols = new SymbolSpace('empty-v7-policy');
  const pure = b.fn({ symbol: symbols.define('pure'), returns: b.Int, body: b.ret(b.int(1)) });
  const module = b.module_({ symbol: symbols.define('module'), members: [pure], symbolTable: symbols.table() });
  const root = new GraphStore().intern(module);
  const body: EffectResourcePolicyBodyV7 = { format: 'aether.effect-resource-policy/7',
    repositoryId: 'repository', astRoot: root, policyEpoch: '7',
    adapterTableDigest: domainDigest('aether.declarative-adapter-table/2', 'empty-table'), rules: [] };
  const keys = generateKeyPairSync('ed25519');
  assert.throws(() => validateEffectResourcePolicyBodyV7(body), /independently checked AST module/);
  assert.throws(() => signEffectResourcePolicyV7(body, 'policy-signer', keys.privateKey), /independently checked AST module/);
  validateEffectResourcePolicyBodyV7(body, module);
  const policy = signEffectResourcePolicyV7(body, 'policy-signer', keys.privateKey, module);
  const manifest = { ...fixture().base, astRoot: root, capabilityPolicyDigest: effectResourcePolicyDigestV7(body, module) };
  assert.throws(() => assertSignedEffectResourcePolicyV7(policy, manifest,
    'repository', '7', keys.publicKey), /independently checked AST module/);
  assertSignedEffectResourcePolicyV7(policy, manifest, 'repository', '7', keys.publicKey, module);
  assert.throws(() => validateEffectResourcePolicyBodyV7(body, fixture().ex.module), /AST root mismatch/);
  const f = fixture();
  const invoked = { ...body, astRoot: f.base.astRoot };
  assert.throws(() => validateEffectResourcePolicyBodyV7(invoked, f.ex.module), /cannot admit Invoke/);
});

test('V7 keeps V6 rule bounds and rejects malformed table identities', () => {
  const f = fixture();
  const invalid = (body: unknown) => assert.throws(() => validateEffectResourcePolicyBodyV7(body));
  invalid({ ...f.body, adapterTableDigest: domainDigest('aether.declarative-adapter-table/1', 'legacy-js-table') });
  invalid({ ...f.body, adapterTableDigest: domainDigest('aether.other/1', 'table') });
  invalid({ ...f.body, rules: [{ ...f.rule, argument: 32 }] });
  invalid({ ...f.body, rules: [f.rule, f.rule] });
  invalid({ ...f.body, rules: [{ ...f.rule, prefix: ['..'] }] });
  invalid({ ...f.body, rules: [{ ...f.rule, adapterDigest: domainDigest('aether.effect-adapter/1', 'wrong') }] });
  invalid({ ...f.body, rules: [{ ...f.rule, adapterArtifactDigest: domainDigest('aether.other/1', 'artifact') }] });
  invalid({ ...f.body, unexpected: true });
});
