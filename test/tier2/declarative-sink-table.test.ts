import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { test } from 'node:test';
import { buildLedgerExample, CAP_LEDGER_APPEND } from '../../src/examples/ledger.ts';
import { createAttestedSinkAdapter } from '../../src/fabric/attested-sink-adapter.ts';
import { effectAdapterDigest } from '../../src/fabric/effects.ts';
import { domainDigest, type ExecutionManifestV1 } from '../../src/fabric/identity.ts';
import { createSinkStateWitness } from '../../src/fabric/sink-state-witness.ts';
import * as b from '../../src/tier1/build.ts';
import { capability } from '../../src/tier1/ids.ts';
import { GraphStore } from '../../src/tier1/store.ts';
import { SymbolSpace } from '../../src/tier1/symbols.ts';
import { declarativeSinkTableDigestV2, assertDeclarativeSinkTablePolicyV2,
  assertDeclarativeSinkRuntimeMapV2, type DeclarativeSinkTableV2,
  type SignedSinkTableSelectionV2 } from '../../src/tier2/declarative-sink-table.ts';
import { effectResourcePolicyDigestV7, signEffectResourcePolicyV7,
  type EffectResourcePolicyBodyV7 } from '../../src/tier2/effect-resource-policy.ts';

function fixture() {
  const repositoryId = 'repo:sink-table', deploymentId = 'deployment:sink-table';
  const keys = generateKeyPairSync('ed25519');
  const anchor = { format: 'aether.sink-anchor/1' as const, repositoryId,
    sinkAuthorityId: 'operator:sink-table', sinkId: 'sink:sink-table',
    keyId: 'key:sink-table', keyEpoch: '1',
    publicKey: keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64') };
  const artifact = domainDigest('aether.effect-adapter-artifact/3', 'sink-table');
  const witness = createSinkStateWitness({ authorityId: 'operator:sink-table-witness',
    anchor, adapterArtifactDigest: artifact,
    read: () => ({ revision: '0', journal: null }),
    advance: () => { throw new Error('read-only test witness'); } });
  const identity = { repositoryId, deploymentId,
    approvedAdapterArtifactDigest: artifact, anchor };
  const adapter = createAttestedSinkAdapter({ ...identity, id: 'adapter:sink-table',
    client: { execute: () => { throw new Error('dispatch is not part of table admission'); },
      status: () => ({ state: 'unknown' as const }) } });
  const entry = { id: 'registration:sink-table', capability: CAP_LEDGER_APPEND,
    adapterId: adapter.id, adapterDigest: effectAdapterDigest(adapter),
    adapterArtifactDigest: artifact, deploymentId,
    sinkAnchorDigest: domainDigest('aether.sink-anchor/1', anchor),
    sinkStateWitnessDigest: witness.digest,
    lifecycle: 'attested-external-no-unload/1' as const };
  const table: DeclarativeSinkTableV2 = { format: 'aether.declarative-adapter-table/2',
    repositoryId, registrations: [entry] };
  const ex = buildLedgerExample('declarative-sink-table');
  const root = new GraphStore().intern(ex.module);
  const rule = { capability: entry.capability, prefix: ['account'], argument: 0,
    adapterId: entry.adapterId, adapterDigest: entry.adapterDigest,
    adapterArtifactDigest: entry.adapterArtifactDigest, deadline: '1000',
    clockDomain: 'sink-table-clock', deploymentId,
    sinkAnchorDigest: entry.sinkAnchorDigest,
    sinkStateWitnessDigest: entry.sinkStateWitnessDigest };
  const body: EffectResourcePolicyBodyV7 = { format: 'aether.effect-resource-policy/7',
    repositoryId, astRoot: root, policyEpoch: '1',
    adapterTableDigest: declarativeSinkTableDigestV2(table), rules: [rule] };
  const manifest: ExecutionManifestV1 = { format: 'aether.execution/1', astRoot: root,
    specRoot: domainDigest('aether.specification/1', 'sink table'), dependencies: [],
    semanticsVersion: 'aether-reference/1',
    compilerDigest: domainDigest('aether.compiler/1', 'sink table'),
    target: { abiVersion: 'sink-table/1',
      profileDigest: domainDigest('aether.target-profile/1', 'sink table'),
      artifactDigest: domainDigest('aether.target-artifact/1', 'sink table') },
    capabilityPolicyDigest: effectResourcePolicyDigestV7(body),
    evidencePolicyDigest: domainDigest('aether.evidence-policy/1', 'sink table') };
  const policy = signEffectResourcePolicyV7(body, 'operator:sink-table-policy', keys.privateKey);
  const selection: SignedSinkTableSelectionV2 = { table, policy, manifest,
    currentEpoch: '1', signerKey: keys.publicKey };
  return { keys, anchor, artifact, witness, identity, adapter, entry, table,
    rule, body, manifest, policy, selection };
}

test('V2 sink table and signed V7 policy bind the same complete branded live map', () => {
  const f = fixture();
  assertDeclarativeSinkTablePolicyV2(f.selection);
  assertDeclarativeSinkRuntimeMapV2(f.selection,
    new Map([[CAP_LEDGER_APPEND, f.adapter]]), f.identity, f.witness);
  assert.throws(() => assertDeclarativeSinkRuntimeMapV2(f.selection,
    new Map(), f.identity, f.witness), /exact native adapter map/);
  const extra = new Map([[CAP_LEDGER_APPEND, f.adapter], [capability('cap:test:extra'), f.adapter]]);
  assert.throws(() => assertDeclarativeSinkRuntimeMapV2(f.selection,
    extra, f.identity, f.witness), /exact native adapter map/);
  const structural = { id: f.adapter.id, semantics: f.adapter.semantics,
    execute: () => ({ tag: 'null' as const }) };
  assert.throws(() => assertDeclarativeSinkRuntimeMapV2(f.selection,
    new Map([[CAP_LEDGER_APPEND, structural]]), f.identity, f.witness),
  /untrusted attested sink adapter/);
});

test('V2 sink table refuses forged, unmatched and re-signed registration identities', () => {
  const f = fixture();
  const substitutedDigest = domainDigest('aether.effect-adapter/1', {
    id: 'adapter:substituted', semantics: f.adapter.semantics });
  const changedTable: DeclarativeSinkTableV2 = { ...f.table,
    registrations: [{ ...f.entry, adapterId: 'adapter:substituted',
      adapterDigest: substitutedDigest }] };
  assert.throws(() => assertDeclarativeSinkTablePolicyV2({ ...f.selection,
    table: changedTable }), /differs from complete sink adapter table/);
  const changedRule = { ...f.rule, adapterId: 'adapter:substituted',
    adapterDigest: substitutedDigest };
  const changedBody: EffectResourcePolicyBodyV7 = { ...f.body,
    adapterTableDigest: declarativeSinkTableDigestV2(changedTable),
    rules: [changedRule] };
  const changedPolicy = signEffectResourcePolicyV7(changedBody,
    f.policy.signer, f.keys.privateKey);
  assert.throws(() => assertDeclarativeSinkTablePolicyV2({ ...f.selection,
    policy: changedPolicy }), /stale or foreign/);
  const wrongArtifact: DeclarativeSinkTableV2 = { ...f.table,
    registrations: [{ ...f.entry,
      adapterArtifactDigest: domainDigest('aether.effect-adapter-artifact/3', 'other') }] };
  assert.throws(() => assertDeclarativeSinkTablePolicyV2({ ...f.selection,
    table: wrongArtifact }), /differs from complete sink adapter table/);
  const wrongAuthority = { ...f.identity, deploymentId: 'deployment:other' };
  assert.throws(() => assertDeclarativeSinkRuntimeMapV2(f.selection,
    new Map([[CAP_LEDGER_APPEND, f.adapter]]), wrongAuthority, f.witness),
  /operator sink authority differs/);
});

test('empty V2 table admits only an exact-root module without any Invoke', () => {
  const f = fixture();
  const symbols = new SymbolSpace('pure-sink-table');
  const module = b.module_({ symbol: symbols.define('module'), symbolTable: symbols.table(),
    members: [b.fn({ symbol: symbols.define('pure'), returns: b.Int,
      body: b.ret(b.int(1)) })] });
  const root = new GraphStore().intern(module);
  const table: DeclarativeSinkTableV2 = { format: 'aether.declarative-adapter-table/2',
    repositoryId: f.table.repositoryId, registrations: [] };
  const body: EffectResourcePolicyBodyV7 = { ...f.body, astRoot: root,
    adapterTableDigest: declarativeSinkTableDigestV2(table), rules: [] };
  const manifest = { ...f.manifest, astRoot: root,
    capabilityPolicyDigest: effectResourcePolicyDigestV7(body, module) };
  const policy = signEffectResourcePolicyV7(body, f.policy.signer,
    f.keys.privateKey, module);
  const selected: SignedSinkTableSelectionV2 = { ...f.selection,
    table, policy, manifest, module };
  assertDeclarativeSinkTablePolicyV2(selected);
  assertDeclarativeSinkRuntimeMapV2(selected, new Map(), f.identity, f.witness);
  assert.throws(() => assertDeclarativeSinkTablePolicyV2({ ...selected,
    module: undefined }), /independently checked AST module/);
});
