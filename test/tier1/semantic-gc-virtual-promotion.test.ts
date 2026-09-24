import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as b from '../../src/tier1/build.ts';
import type { Term } from '../../src/tier1/ast.ts';
import { SymbolSpace } from '../../src/tier1/symbols.ts';
import { DurableGraphStore } from '../../src/tier1/durable-store.ts';
import { CausalLineageLedger, signIntent, signSpecRevision } from '../../src/tier1/causal-lineage.ts';
import { SemanticGarbageCollector } from '../../src/tier1/semantic-gc.ts';
import { SemanticVirtualGcPromotionV2 } from '../../src/tier1/semantic-gc-virtual-promotion.ts';
import { buildVirtualForwardCandidate } from '../../src/tier1/semantic-gc-virtual-forward.ts';
import { CapabilityRegistry } from '../../src/tier2/ocap.ts';
import { DEFAULT_EVIDENCE_POLICY_V2, DEFAULT_EVIDENCE_POLICY_V3,
  mintLocalEvidence, type EvidenceContext } from '../../src/fabric/evidence.ts';
import { domainDigest, executionManifestDigest } from '../../src/fabric/identity.ts';
import { approvePromotion, evidenceBundleDigest,
  effectPlanDigest, migrationPlanDigest, PromotionCoordinator,
  type PromotionInput } from '../../src/fabric/promotion.ts';
import { RESUMABLE_PROFILE_DIGEST, virtualForwardResumableProfileDigest } from '../../src/tier3/resumable-program.ts';
import { ResumableRuntime } from '../../src/tier3/resumable-runtime.ts';
import { encodeCanonical } from '../../src/fabric/encoding.ts';

type Module = Extract<Term, { kind: 'Module' }>;
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'aether-virtual-gc-v2-'));
  const repositoryId = 'virtual-gc-v2';
  const store = new DurableGraphStore({ directory: join(directory, 'ast') });
  const registry = new CapabilityRegistry();
  const symbols = new SymbolSpace('virtual-gc-v2');
  const target = symbols.define('target'), wrapper = symbols.define('wrapper');
  const entry = symbols.define('entry'), x = symbols.define('x');
  const w = symbols.define('w'), n = symbols.define('n');
  const source = b.module_({ symbol: symbols.define('module'), symbolTable: symbols.table(),
    members: [
      b.fn({ symbol: target, params: [b.param(x, b.Int)], returns: b.Int,
        contract: b.contract({}), body: b.ret(b.add(b.v(x), b.int(1))) }),
      b.fn({ symbol: wrapper, params: [b.param(w, b.Int)], returns: b.Int,
        contract: b.contract({}), body: b.block(b.ret(b.call(target, b.v(w)))) }),
      b.fn({ symbol: entry, params: [b.param(n, b.Int)], returns: b.Int,
        contract: b.contract({}), body: b.ret(b.call(wrapper, b.v(n))) }),
    ] }) as Module;
  const { candidate, descriptor } = buildVirtualForwardCandidate(source, wrapper, target);
  store.intern(source, { leaseId: 'draft' });
  store.intern(candidate, { leaseId: 'draft' });
  const author = generateKeyPairSync('ed25519'), governor = generateKeyPairSync('ed25519');
  const authority = { policyEpoch: '1', eligibleAuthors: ['author'] };
  const lineage = new CausalLineageLedger({ directory: join(directory, 'lineage'), repositoryId,
    store, authority: () => authority, authorKey: () => author.publicKey });
  const spec = { id: 'behavior', revision: lineage.publishSpec(signSpecRevision({ repositoryId,
    id: 'behavior', revision: 1, previous: null, parents: [],
    text: 'Preserve the entry result and virtual wrapper frame.', requirements: [],
    author: 'author', policyEpoch: '1', nonce: 'spec-1' }, author.privateKey)) };
  const specification = lineage.specification([], [spec]);
  const d = (name: string) => domainDigest('aether.virtual-gc-v2-test/1', name);
  const base = { specification, semanticsVersion: 'aether-reference/1',
    compilerDigest: d('compiler'), capabilityPolicyDigest: d('no-effects'), registry };
  const sourceContext: EvidenceContext = { ...base, module: source,
    target: { abiVersion: 'resumable/1', profileDigest: RESUMABLE_PROFILE_DIGEST,
      artifactDigest: d('source-artifact') }, policy: DEFAULT_EVIDENCE_POLICY_V2 };
  const candidateContext: EvidenceContext = { ...base, module: candidate,
    target: { abiVersion: 'resumable/1', profileDigest: virtualForwardResumableProfileDigest(descriptor),
      artifactDigest: d('candidate-artifact') }, policy: DEFAULT_EVIDENCE_POLICY_V3,
    virtualForward: { source, descriptor } };
  const admit = (context: EvidenceContext, parents: readonly string[], nonce: string) => {
    const evidence = mintLocalEvidence(context), manifestDigest = executionManifestDigest(evidence.manifest);
    const intent = lineage.recordIntent(signIntent({ repositoryId,
      subject: evidence.manifest.astRoot as ReturnType<DurableGraphStore['intern']>,
      executionManifest: manifestDigest, evidenceBundleDigest: evidenceBundleDigest(evidence),
      parents, specifications: [spec], purpose: parents.length ? 'rewrite' : 'genesis',
      text: 'Preserve signed behavior.', author: 'author', policyEpoch: '1', nonce }, author.privateKey));
    lineage.admitArtifact(intent, evidence, context);
    return { evidence, manifestDigest, intent };
  };
  const sourceArtifact = admit(sourceContext, [], 'source-1');
  const candidateArtifact = admit(candidateContext, [sourceArtifact.intent], 'candidate-1');
  store.commit('production', descriptor.sourceRoot, null);
  const policy = { epoch: 'exports-v2', exports: [entry], protectedSymbols: [target] };
  const retentionLedger = new SemanticGarbageCollector({ directory: join(directory, 'gc'),
    repositoryId, store, lineage, registry, policy });
  const virtualOptions = { directory: join(directory, 'virtual'),
    repositoryId, store, lineage, registry, policy, retentionLedger };
  const gc = new SemanticVirtualGcPromotionV2(virtualOptions);
  const proposal = gc.propose(sourceArtifact.evidence.manifest,
    candidateArtifact.evidence.manifest, specification, wrapper, target);
  const governorAuthority = { repositoryId, membershipEpoch: '1', policyEpoch: '1',
    eligibleGovernors: ['governor'] };
  const coordinatorOptions = { directory: join(directory, 'coordinator'), repositoryId,
    genesisManifest: sourceArtifact.manifestDigest, lineage: lineage.admissionAdapter(),
    authority: () => governorAuthority, governorKey: () => governor.publicKey,
    clock: () => 100n };
  const coordinator = new PromotionCoordinator(coordinatorOptions);
  const input = (): PromotionInput => {
    const { migrationPlan, effectPlan } = gc.promotionPlans(proposal.id);
    const promotion = { format: 'aether.promotion/1' as const, repositoryId,
      expectedParent: sourceArtifact.manifestDigest, candidateManifest: candidateArtifact.manifestDigest,
      evidenceBundleDigest: evidenceBundleDigest(candidateArtifact.evidence),
      migrationPlanDigest: migrationPlanDigest(migrationPlan), effectPlanDigest: effectPlanDigest(effectPlan),
      membershipEpoch: '1', policyEpoch: '1', expiresAt: '1000' };
    return { proposal: promotion, approval: approvePromotion(promotion, 'governor', governor.privateKey),
      context: candidateContext, evidence: candidateArtifact.evidence, migrationPlan, effectPlan };
  };
  return { directory, store, lineage, authority, author, source, candidate, descriptor, sourceArtifact,
    candidateArtifact, policy, retentionLedger, virtualOptions, gc, proposal, input, coordinator,
    coordinatorOptions, entry, wrapper, target,
    cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

test('V2 one-wrapper proposal promotes signed V3 exact dependencies and retains predecessor', async () => {
  const f = fixture();
  try {
    assert.deepEqual(f.proposal.candidateManifest.dependencies.map(row => row.symbol).sort(),
      [f.wrapper, f.target].sort());
    assert.equal(f.gc.readProposal(f.proposal.id).descriptor.id, f.descriptor.id);
    await f.gc.promote(f.proposal.id, f.input(), f.coordinator);
    assert.equal(f.coordinator.servingManifest(), f.candidateArtifact.manifestDigest);
    assert.equal(f.store.head('production')?.root, f.descriptor.candidateRoot);
    const runtime = new ResumableRuntime(f.candidate, { manifest: f.proposal.candidateManifest,
      registry: new CapabilityRegistry(), executionId: 'promoted-in-process',
      dependencies: [f.source.members[1]],
      virtualForward: { source: f.source, descriptor: f.descriptor } });
    runtime.start(f.entry, [3n]);
    const result = runtime.run().value;
    assert.equal(result?.tag, 'int');
    if (result?.tag === 'int') assert.equal(result.value, '4');
    f.store.release('draft');
    f.store.collectGarbage();
    assert.equal(f.store.hydrate(f.descriptor.sourceRoot).kind, 'Module');
    assert.equal(f.store.hydrate(f.descriptor.wrapperDeclaration).kind, 'FunctionDecl');
  } finally { f.cleanup(); }
});

test('V2 refuses altered descriptor, substituted plans, stale lineage and retention', async () => {
  const f = fixture();
  try {
    const changedProfile = { ...f.proposal.candidateManifest,
      target: { ...f.proposal.candidateManifest.target,
        profileDigest: domainDigest('aether.virtual-gc-v2-test/1', 'unbound') } };
    assert.throws(() => f.gc.propose(f.proposal.sourceManifest, changedProfile,
      f.proposal.specification, f.wrapper, f.target), /profile/);
    const changedDependencies = { ...f.proposal.candidateManifest,
      dependencies: f.proposal.candidateManifest.dependencies.filter(row => row.symbol !== f.wrapper) };
    assert.throws(() => f.gc.propose(f.proposal.sourceManifest, changedDependencies,
      f.proposal.specification, f.wrapper, f.target), /manifest digest|dependency|wrapper/);
    const file = join(f.directory, 'virtual', `${f.proposal.id.split(':').at(-1)}.json`);
    const original = readFileSync(file);
    const tampered = { ...f.proposal, descriptor: { ...f.descriptor, sites: [] } };
    writeFileSync(file, encodeCanonical(tampered));
    assert.throws(() => f.gc.readProposal(f.proposal.id), /identity|descriptor/);
    writeFileSync(file, original);
    const badPlan = { ...f.input(), migrationPlan: { tag: 'null' as const } };
    await assert.rejects(f.gc.promote(f.proposal.id, badPlan, f.coordinator), /binding|plan/);
    const badEffectPlan = { ...f.input(), effectPlan: { tag: 'null' as const } };
    await assert.rejects(f.gc.promote(f.proposal.id, badEffectPlan, f.coordinator), /binding|plan/);
    assert.equal(f.coordinator.state().committedManifest, f.sourceArtifact.manifestDigest);
    f.retentionLedger.retain({ kind: 'audit', reference: 'later-audit', root: f.descriptor.sourceRoot });
    assert.throws(() => f.gc.readProposal(f.proposal.id, true), /retention changed/);
  } finally { f.cleanup(); }
  const revoked = fixture();
  try {
    revoked.authority.eligibleAuthors = [];
    assert.throws(() => revoked.gc.readProposal(revoked.proposal.id, true), /revoked|policy|author/);
  } finally { revoked.cleanup(); }
});

test('V2 committed decision recovers only with its exact persisted proposal', async () => {
  const f = fixture();
  try {
    const interrupted = new PromotionCoordinator({ ...f.coordinatorOptions,
      fault: point => { if (point === 'after-commit') throw new Error('crash after commit'); } });
    await assert.rejects(f.gc.promote(f.proposal.id, f.input(), interrupted),
      /crash after commit/);
    assert.equal(f.coordinator.state().activationPending, true);
    const wrong = domainDigest('aether.semantic-gc-virtual-promotion/2', 'wrong');
    await assert.rejects(f.gc.recover(wrong, f.coordinator));
    assert.equal(f.coordinator.state().activationPending, true);
    const reopenedStore = new DurableGraphStore({ directory: join(f.directory, 'ast') });
    const reopenedLineage = new CausalLineageLedger({ directory: join(f.directory, 'lineage'),
      repositoryId: 'virtual-gc-v2', store: reopenedStore,
      authority: () => f.authority, authorKey: () => f.author.publicKey });
    const reopenedRegistry = new CapabilityRegistry();
    const reopenedRetention = new SemanticGarbageCollector({ directory: join(f.directory, 'gc'),
      repositoryId: 'virtual-gc-v2', store: reopenedStore, lineage: reopenedLineage,
      registry: reopenedRegistry, policy: f.policy });
    const reopenedGc = new SemanticVirtualGcPromotionV2({ directory: join(f.directory, 'virtual'),
      repositoryId: 'virtual-gc-v2', store: reopenedStore, lineage: reopenedLineage,
      registry: reopenedRegistry, policy: f.policy, retentionLedger: reopenedRetention });
    const reopenedCoordinator = new PromotionCoordinator({ ...f.coordinatorOptions,
      lineage: reopenedLineage.admissionAdapter() });
    await reopenedGc.recover(f.proposal.id, reopenedCoordinator);
    assert.equal(f.coordinator.servingManifest(), f.candidateArtifact.manifestDigest);
  } finally { f.cleanup(); }
});

test('V2 ignores a caller-owned store pointer swapped after construction', async () => {
  const f = fixture();
  try {
    const other = new DurableGraphStore({ directory: join(f.directory, 'other-ast') });
    other.importArchive(f.store.exportArchive([f.descriptor.sourceRoot, f.descriptor.candidateRoot]),
      { leaseId: 'other-draft' });
    other.commit('production', f.descriptor.sourceRoot, null);
    f.virtualOptions.store = other;
    await f.gc.promote(f.proposal.id, f.input(), f.coordinator);
    assert.equal(f.store.head('production')?.root, f.descriptor.candidateRoot);
    assert.equal(other.head('production')?.root, f.descriptor.sourceRoot);
  } finally { f.cleanup(); }
});

test('V2 keeps its original export fence when caller-owned policy arrays change', () => {
  const f = fixture();
  try {
    const policy = { epoch: 'protected-wrapper', exports: [f.entry, f.wrapper],
      protectedSymbols: [f.target] };
    const registry = new CapabilityRegistry();
    const retentionLedger = new SemanticGarbageCollector({ directory: join(f.directory, 'protected-gc'),
      repositoryId: 'virtual-gc-v2', store: f.store, lineage: f.lineage, registry, policy });
    const options = { directory: join(f.directory, 'protected-virtual'),
      repositoryId: 'virtual-gc-v2', store: f.store, lineage: f.lineage, registry,
      policy, retentionLedger };
    const protectedGc = new SemanticVirtualGcPromotionV2(options);
    policy.exports.splice(1, 1);
    assert.throws(() => protectedGc.propose(f.proposal.sourceManifest,
      f.proposal.candidateManifest, f.proposal.specification, f.wrapper, f.target),
    /exported|protection policy/);
  } finally { f.cleanup(); }
});

test('V2 recovery refuses a finalized retry after another writer moved the local head', async () => {
  const f = fixture();
  try {
    const original = f.store.finishPromotion.bind(f.store);
    let interrupted = false;
    (f.store as any).finishPromotion = (...args: Parameters<typeof f.store.finishPromotion>) => {
      const result = original(...args);
      if (!interrupted && args[1].kind === 'commit') {
        interrupted = true;
        throw new Error('interrupted after AST head commit');
      }
      return result;
    };
    await assert.rejects(f.gc.promote(f.proposal.id, f.input(), f.coordinator),
      /interrupted after AST head commit/);
    (f.store as any).finishPromotion = original;
    const candidateHead = f.store.head('production')!;
    assert.equal(candidateHead.root, f.descriptor.candidateRoot);
    f.store.commit('production', f.descriptor.sourceRoot, candidateHead);
    const reopened = new PromotionCoordinator(f.coordinatorOptions);
    await assert.rejects(f.gc.recover(f.proposal.id, reopened), /local head changed/);
    assert.equal(reopened.state().activationPending, true);
    assert.equal(f.store.head('production')!.root, f.descriptor.sourceRoot);
  } finally { f.cleanup(); }
});

test('V2 retention fence rejects a ledger for another store or policy', () => {
  const f = fixture();
  const separate = new DurableGraphStore({ directory: join(f.directory, 'other-ast') });
  try {
    assert.throws(() => new SemanticVirtualGcPromotionV2({ directory: join(f.directory, 'wrong-store'),
      repositoryId: 'virtual-gc-v2', store: separate, lineage: f.lineage,
      registry: new CapabilityRegistry(), policy: f.policy,
      retentionLedger: f.retentionLedger }), /retention authority/);
    assert.throws(() => new SemanticVirtualGcPromotionV2({ directory: join(f.directory, 'wrong-policy'),
      repositoryId: 'virtual-gc-v2', store: f.store, lineage: f.lineage,
      registry: new CapabilityRegistry(), policy: { ...f.policy, protectedSymbols: [] },
      retentionLedger: f.retentionLedger }), /retention authority/);
  } finally { f.cleanup(); }
});
