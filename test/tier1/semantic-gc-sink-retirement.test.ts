import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as b from '../../src/tier1/build.ts';
import { SymbolSpace } from '../../src/tier1/symbols.ts';
import { adapterGcFixture } from './semantic-gc-adapters-fixture.ts';
import { domainDigest } from '../../src/fabric/identity.ts';
import { effectResourcePolicyDigestV7, signEffectResourcePolicyV7,
  type EffectResourcePolicyBodyV7 } from '../../src/tier2/effect-resource-policy.ts';
import { declarativeSinkTableDigestV2,
  type DeclarativeSinkTableV2 } from '../../src/tier2/declarative-sink-table.ts';
import { proposeSemanticSinkRetirementV2, verifySemanticSinkRetirementV2,
  type SemanticSinkRetirementContextV2, type SemanticSinkRetirementProposalV2,
  type SinkRetirementSelectionV2 } from '../../src/tier1/semantic-gc-sink-retirement.ts';

function fixture(options: { exportUnused?: boolean; protectUnused?: boolean; fenceUnused?: boolean } = {}) {
  const f = adapterGcFixture(options), keys = generateKeyPairSync('ed25519');
  const artifact = domainDigest('aether.effect-adapter-artifact/3', 'approved-sink');
  const anchor = domainDigest('aether.sink-anchor/1', 'sink-anchor');
  const witness = domainDigest('aether.sink-state-witness/1', 'sink-witness');
  const semantics = { readOnly: false, atomicIdempotency: true,
    transactional: false, reconciliation: true };
  const table: DeclarativeSinkTableV2 = {
    format: 'aether.declarative-adapter-table/2', repositoryId: 'adapter-gc',
    registrations: [
      { id: 'a-live', capability: f.liveCap, adapterId: 'attested-live/1' },
      { id: 'b-unused', capability: f.unusedCap, adapterId: 'attested-unused/1' },
    ].map(row => ({ ...row,
      adapterDigest: domainDigest('aether.effect-adapter/1', { id: row.adapterId, semantics }),
      adapterArtifactDigest: artifact, deploymentId: 'sink-deployment',
      sinkAnchorDigest: anchor, sinkStateWitnessDigest: witness,
      lifecycle: 'attested-external-no-unload/1' as const,
    })),
  };
  const makeSelection = (selectedTable: DeclarativeSinkTableV2, epoch: string): SinkRetirementSelectionV2 => {
    const rules = selectedTable.registrations.map(entry => ({
      capability: entry.capability, prefix: ['sink', entry.id], argument: 0,
      adapterId: entry.adapterId, adapterDigest: entry.adapterDigest,
      adapterArtifactDigest: entry.adapterArtifactDigest,
      deadline: '1000', clockDomain: 'trusted-clock', deploymentId: entry.deploymentId,
      sinkAnchorDigest: entry.sinkAnchorDigest,
      sinkStateWitnessDigest: entry.sinkStateWitnessDigest,
    })).sort((a, b) => a.capability < b.capability ? -1 : 1);
    const body: EffectResourcePolicyBodyV7 = {
      format: 'aether.effect-resource-policy/7', repositoryId: 'adapter-gc',
      astRoot: f.root, policyEpoch: epoch,
      adapterTableDigest: declarativeSinkTableDigestV2(selectedTable), rules,
    };
    return { table: selectedTable, policy: signEffectResourcePolicyV7(body, 'signer', keys.privateKey),
      manifest: { ...f.genesis.evidence.manifest, capabilityPolicyDigest: effectResourcePolicyDigestV7(body) } };
  };
  const source = makeSelection(table, '1');
  const after = { ...table, registrations: table.registrations.slice(0, 1) };
  // The candidate policy must be the exact source rule subset. The selected
  // table maps the same registration and the signed rule has identical fields.
  const candidate = makeSelection(after, '2');
  const context: SemanticSinkRetirementContextV2 = {
    repositoryId: 'adapter-gc', store: f.store, registry: f.configuration.registry,
    exportPolicy: f.configuration.policy, retentionLedger: f.retentionLedger,
    sourceSignerKey: keys.publicKey, candidateSignerKey: keys.publicKey,
    sourcePolicyEpoch: '1', candidatePolicyEpoch: '2',
  };
  const propose = () => proposeSemanticSinkRetirementV2(context, source, candidate,
    f.genesis.context.specification);
  return { f, keys, table, source, candidate, context, propose, cleanup: f.cleanup };
}
function reseal(proposal: SemanticSinkRetirementProposalV2): SemanticSinkRetirementProposalV2 {
  const { id, ...body } = proposal;
  void id;
  return { ...body, id: domainDigest('aether.semantic-sink-retirement/2', body) };
}

test('V2 sink retirement proves exact unused registration and rule removal without live mutation', () => {
  const f = fixture();
  try {
    const oldHead = f.f.store.head('production');
    const proposal = f.propose();
    assert.ok(proposal);
    assert.deepEqual(proposal.removed, ['b-unused']);
    assert.deepEqual(proposal.usedCapabilities, [f.f.liveCap]);
    verifySemanticSinkRetirementV2(f.context, proposal);
    assert.deepEqual(f.f.store.head('production'), oldHead);
    assert.equal(f.f.manager.snapshot().generation, 0);
    assert.equal(proposal.candidate.table.registrations.length, 1);
  } finally { f.cleanup(); }
});

test('exported, protected, fenced and retained sink consumers cannot retire', () => {
  for (const option of [{ exportUnused: true }, { protectUnused: true }, { fenceUnused: true }]) {
    const f = fixture(option);
    try { assert.equal(f.propose(), null); } finally { f.cleanup(); }
  }
  for (const kind of ['active-task', 'replay', 'unstable-replication'] as const) {
    const f = fixture();
    try {
      f.f.retentionLedger.retain({ kind, reference: `${kind}-pending`, root: f.f.root });
      assert.equal(f.propose(), null);
    } finally { f.cleanup(); }
  }
});
test('V2 sink retirement includes retained dependency capabilities and still removes unrelated sinks', () => {
  for (const [capability, expectedRemoved] of [['unused', null], ['live', 'b-unused']] as const) {
    const f = fixture(); try {
      const symbols = new SymbolSpace(`sink-retained-${capability}`), dep = symbols.define('dependency');
      const module = b.module_({ symbol: symbols.define('module'), members: [b.fn({ symbol: symbols.define('entry'), returns: b.Unit, body: b.ret(b.unit()) })], symbolTable: symbols.table() });
      const effect = capability === 'unused' ? f.f.unusedCap : f.f.liveCap;
      const declaration = b.fn({ symbol: dep, returns: b.Unit, capabilities: [effect], body: b.block(b.exprStmt(b.invoke(effect)), b.ret(b.unit())) });
      f.f.retentionLedger.retain({ kind: 'active-task', reference: 'sink-checkpoint', root: f.f.store.intern(module, { leaseId: 'sink-retained-module' }) });
      f.f.retentionLedger.retain({ kind: 'replay', reference: 'sink-checkpoint', root: f.f.store.intern(declaration, { leaseId: 'sink-retained-dependency' }) });
      const proposal = f.propose();
      if (expectedRemoved === null) assert.equal(proposal, null);
      else { assert.ok(proposal); assert.deepEqual(proposal.removed, [expectedRemoved]); verifySemanticSinkRetirementV2(f.context, proposal); }
    } finally { f.cleanup(); }
  }
});
test('V2 sink retirement rejects a retained dependency without its module', () => {
  const f = fixture(); try {
    const symbols = new SymbolSpace('sink-retained-lone'), dep = symbols.define('dependency');
    const declaration = b.fn({ symbol: dep, returns: b.Unit, capabilities: [f.f.unusedCap], body: b.block(b.exprStmt(b.invoke(f.f.unusedCap)), b.ret(b.unit())) });
    f.f.retentionLedger.retain({ kind: 'replay', reference: 'sink-lone', root: f.f.store.intern(declaration, { leaseId: 'sink-lone' }) });
    assert.throws(() => f.propose(), /one complete module/);
  } finally { f.cleanup(); }
});

test('changed retention and dishonest liveness or table/rule edits fail independent verification', () => {
  const f = fixture();
  try {
    const proposal = f.propose(); assert.ok(proposal);
    const liar = reseal({ ...proposal, usedCapabilities: [] });
    assert.throws(() => verifySemanticSinkRetirementV2(f.context, liar), /liveness/);
    const extra = { ...proposal.candidate.table,
      registrations: proposal.source.table.registrations };
    const tableLie = reseal({ ...proposal, candidate: { ...proposal.candidate, table: extra } });
    assert.throws(() => verifySemanticSinkRetirementV2(f.context, tableLie), /table|policy|registration/);
    const changedRule = { ...proposal.candidate.policy.body,
      rules: [{ ...proposal.candidate.policy.body.rules[0], prefix: ['other'] }] };
    const ruleLie = reseal({ ...proposal, candidate: {
      ...proposal.candidate,
      policy: { ...proposal.candidate.policy, body: changedRule },
    } });
    assert.throws(() => verifySemanticSinkRetirementV2(f.context, ruleLie), /policy|signature|untrusted/);
    f.f.retentionLedger.retain({ kind: 'active-task', reference: 'new-task', root: f.f.root });
    assert.throws(() => verifySemanticSinkRetirementV2(f.context, proposal), /retention changed/);
  } finally { f.cleanup(); }
});

test('committed retirement proof remains auditable after later task pins but cannot be reused for a new commit', () => {
  const f = fixture();
  try {
    f.f.retentionLedger.retain({ kind: 'audit', reference: 'retained-before-commit',
      root: f.f.root });
    const proposal = f.propose(); assert.ok(proposal);
    f.f.retentionLedger.retain({ kind: 'active-task', reference: 'arrived-after-commit',
      root: f.f.root });
    assert.throws(() => verifySemanticSinkRetirementV2(f.context, proposal),
      /retention changed/);
    verifySemanticSinkRetirementV2(f.context, proposal, { historicalCommitted: true });
  } finally { f.cleanup(); }
});

test('changed source/candidate roots, epochs and portable proof fail closed', () => {
  const f = fixture();
  try {
    const proposal = f.propose(); assert.ok(proposal);
    const badManifest = { ...proposal.candidate.manifest,
      compilerDigest: domainDigest('aether.test-compiler/1', 'replacement') };
    assert.throws(() => verifySemanticSinkRetirementV2(f.context,
      reseal({ ...proposal, candidate: { ...proposal.candidate, manifest: badManifest } })), /non-policy manifest/);
    const wrongRoot = f.f.table.registrations[0].sourceRoot;
    assert.throws(() => verifySemanticSinkRetirementV2(f.context,
      reseal({ ...proposal, source: { ...proposal.source,
        manifest: { ...proposal.source.manifest, astRoot: wrongRoot } } })), /AST|root|manifest/);
    const epoch = { ...f.context, candidatePolicyEpoch: '3' };
    assert.throws(() => verifySemanticSinkRetirementV2(epoch, proposal), /epoch/);
    const equalEpochBody = { ...f.candidate.policy.body, policyEpoch: '1' };
    const equalEpochCandidate: SinkRetirementSelectionV2 = { ...f.candidate,
      policy: signEffectResourcePolicyV7(equalEpochBody, 'signer', f.keys.privateKey),
      manifest: { ...f.candidate.manifest,
        capabilityPolicyDigest: effectResourcePolicyDigestV7(equalEpochBody) } };
    assert.throws(() => proposeSemanticSinkRetirementV2({ ...f.context,
      candidatePolicyEpoch: '1' }, f.source, equalEpochCandidate,
    f.f.genesis.context.specification), /epoch mismatch/);
    const witness = reseal({ ...proposal, witness: { ...proposal.witness,
      certificate: { ...proposal.witness.certificate, certificates: [] } } });
    assert.throws(() => verifySemanticSinkRetirementV2(f.context, witness), /certificate|coverage|obligation/i);
    const forgedRoot = reseal({ ...proposal, witness: { ...proposal.witness, root: f.f.root } });
    assert.throws(() => verifySemanticSinkRetirementV2(f.context, forgedRoot), /witness substitution/);
  } finally { f.cleanup(); }
});

test('independent verifier checks a portable proof when proof production is unavailable', async () => {
  const f = fixture(), consumer = mkdtempSync(join(tmpdir(), 'aether-sink-retirement-consumer-'));
  try {
    const proposal = f.propose(); assert.ok(proposal);
    cpSync(resolve('src'), join(consumer, 'src'), { recursive: true });
    writeFileSync(join(consumer, 'package.json'), '{"type":"module"}');
    mkdirSync(join(consumer, 'node_modules'));
    for (const dependency of ['acorn', 'acorn-walk'])
      cpSync(resolve('node_modules', dependency), join(consumer, 'node_modules', dependency), { recursive: true });
    writeFileSync(join(consumer, 'src/tier2/portable-proof-producer.ts'),
      "export function generatePortableCertificate(){throw new Error('proof search forbidden in consumer');}\n");
    const loaded = await import(pathToFileURL(join(consumer, 'src/tier1/semantic-gc-sink-retirement.ts')).href);
    loaded.verifySemanticSinkRetirementV2(f.context, proposal);
  } finally { f.cleanup(); rmSync(consumer, { recursive: true, force: true }); }
});
