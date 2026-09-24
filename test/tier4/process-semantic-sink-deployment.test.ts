import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { adapterGcFixture } from '../tier1/semantic-gc-adapters-fixture.ts';
import { signIntent, type SpecReference } from '../../src/tier1/causal-lineage.ts';
import type { NodeRef } from '../../src/tier1/ids.ts';
import { proposeSemanticSinkRetirementV2, type SinkRetirementSelectionV2 } from '../../src/tier1/semantic-gc-sink-retirement.ts';
import { CapabilitySealer } from '../../src/tier2/ocap.ts';
import { ScopedGrantAuthority } from '../../src/tier2/scoped-grants.ts';
import { createEffectSignerAnchor } from '../../src/tier2/effect-signer-anchor.ts';
import { createTrustedClockAnchor } from '../../src/tier2/trusted-clock-anchor.ts';
import { declarativeSinkTableDigestV2, type DeclarativeSinkTableV2 } from '../../src/tier2/declarative-sink-table.ts';
import { effectResourcePolicyDigestV7, signEffectResourcePolicyV7,
  type EffectResourcePolicyBodyV7 } from '../../src/tier2/effect-resource-policy.ts';
import { encodeCanonical, type TaggedValueV1 } from '../../src/fabric/encoding.ts';
import { DEFAULT_EVIDENCE_POLICY_V2, mintLocalEvidence, type EvidenceContext } from '../../src/fabric/evidence.ts';
import { DurableEffectBroker, effectAdapterDigest, effectRequestDigest, type EffectRequestV1 } from '../../src/fabric/effects.ts';
import { createAttestedSinkAdapter, type AttestedSinkClientV1 } from '../../src/fabric/attested-sink-adapter.ts';
import { createNamespacedEffectJournalWitness, createNamespacedEffectJournalWitnessCatalog,
  selectEffectJournalWitness, type WitnessHead } from '../../src/fabric/effect-journal-witness.ts';
import { createHostJournalWitness, createHostJournalWitnessCatalog,
  type HostJournalHead } from '../../src/fabric/host-journal-witness.ts';
import { createDeploymentJournalWitness, type DeploymentJournalHead } from '../../src/fabric/deployment-journal-witness.ts';
import { advanceSinkStateHead, createSinkStateWitness, type SinkStateHeadV1 } from '../../src/fabric/sink-state-witness.ts';
import { signSinkReceipt, sinkValueDigest, type SinkPublicAnchorV1,
  type SignedSinkReceiptV1 } from '../../src/fabric/sink-receipt.ts';
import { domainDigest, executionManifestDigest } from '../../src/fabric/identity.ts';
import { PromotionCoordinator, approvePromotion, evidenceBundleDigest,
  migrationPlanDigest, effectPlanDigest, type PromotionInput } from '../../src/fabric/promotion.ts';
import { BrokerEffectRouter } from '../../src/tier3/effects.ts';
import { ProcessDeployment, processArtifactDigest, processMigrationPlan,
  processSemanticSinkEffectPlan, type ProcessArtifactV2,
  type ProcessDeploymentOptions, type ProcessHostServices } from '../../src/tier4/process-deployment.ts';
import type { TopologyPlan } from '../../src/tier4/topology.ts';

function fixture() {
  const gc = adapterGcFixture();
  const directory = mkdtempSync(join(tmpdir(), 'aether-semantic-deployment-'));
  const repositoryId = 'adapter-gc', deploymentId = 'sink-deployment', clockDomain = 'trusted-clock';
  const sinkKeys = generateKeyPairSync('ed25519');
  const policyKeys = generateKeyPairSync('ed25519');
  const governorKeys = generateKeyPairSync('ed25519');
  let epoch = '1';
  const anchor: SinkPublicAnchorV1 = { format: 'aether.sink-anchor/1', repositoryId,
    sinkAuthorityId: 'authority:semantic', sinkId: 'sink:semantic', keyId: 'key:semantic',
    keyEpoch: '1', publicKey: sinkKeys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64') };
  const artifactDigest = domainDigest('aether.effect-adapter-artifact/2', 'semantic-sink');
  let sinkHead: SinkStateHeadV1 = { revision: '0', journal: null };
  const sinkWitness = createSinkStateWitness({ authorityId: 'operator:semantic-sink', anchor,
    adapterArtifactDigest: artifactDigest, read: () => sinkHead,
    advance(expected, journal) { assert.equal(sinkHead.revision, expected);
      sinkHead = { revision: String(BigInt(expected) + 1n), journal }; return sinkHead; } });
  const decisions: Array<{ repositoryId: string; deploymentId: string; request: EffectRequestV1;
    value: TaggedValueV1; receipt: SignedSinkReceiptV1 }> = [];
  const value: TaggedValueV1 = { tag: 'null' };
  let executes = 0;
  const receipt = (request: EffectRequestV1, sequence: string) => signSinkReceipt({
    format: 'aether.sink-receipt-body/1', repositoryId, deploymentId,
    executionId: request.executionId, effectId: request.effectId,
    requestDigest: effectRequestDigest(request), payloadDigest: request.payloadDigest,
    sinkAuthorityId: anchor.sinkAuthorityId, sinkId: anchor.sinkId,
    adapterArtifactDigest: artifactDigest, policyEpoch: request.policyEpoch,
    capabilityGrantRef: request.capabilityGrantRef, keyId: anchor.keyId,
    keyEpoch: anchor.keyEpoch, disposition: 'committed' as const,
    valueDigest: sinkValueDigest(value), decisionId: `decision:${sequence}`,
    commitId: `commit:${sequence}`, sinkSequence: sequence }, sinkKeys.privateKey, anchor);
  const client: AttestedSinkClientV1 = {
    execute(request) {
      executes++;
      const old = decisions.find(item => effectRequestDigest(item.request) === effectRequestDigest(request));
      if (old) return { state: 'committed', receipt: old.receipt, value };
      const revision = String(BigInt(sinkHead.revision) + 1n);
      decisions.push({ repositoryId, deploymentId, request, value,
        receipt: receipt(request, revision) });
      advanceSinkStateHead(sinkWitness, sinkHead.revision, Buffer.from(encodeCanonical({
        format: 'aether.attested-sink-state/2', witnessDigest: sinkWitness.digest,
        witnessRevision: revision, anchor, adapterArtifactDigest: artifactDigest,
        decisions })).toString('utf8'));
      return { state: 'committed', receipt: decisions.at(-1)!.receipt, value };
    },
    status(request) {
      const old = decisions.find(item => effectRequestDigest(item.request) === effectRequestDigest(request));
      return old ? { state: 'committed', receipt: old.receipt, value } : { state: 'unknown' };
    },
  };
  const liveAdapter = createAttestedSinkAdapter({ id: 'attested-live/1', client,
    repositoryId, deploymentId, approvedAdapterArtifactDigest: artifactDigest, anchor });
  const deadAdapter = createAttestedSinkAdapter({ id: 'attested-unused/1',
    client: { execute() { throw new Error('retired sink was dispatched'); }, status() { return { state: 'unknown' }; } },
    repositoryId, deploymentId, approvedAdapterArtifactDigest: artifactDigest, anchor });
  const registrations = [
    { id: 'a-live', capability: gc.liveCap, adapter: liveAdapter },
    { id: 'b-unused', capability: gc.unusedCap, adapter: deadAdapter },
  ].map(row => ({ id: row.id, capability: row.capability, adapterId: row.adapter.id,
    adapterDigest: effectAdapterDigest(row.adapter), adapterArtifactDigest: artifactDigest,
    deploymentId, sinkAnchorDigest: domainDigest('aether.sink-anchor/1', anchor),
    sinkStateWitnessDigest: sinkWitness.digest,
    lifecycle: 'attested-external-no-unload/1' as const }));
  const table: DeclarativeSinkTableV2 = { format: 'aether.declarative-adapter-table/2',
    repositoryId, registrations };
  const selected = (chosen: DeclarativeSinkTableV2, policyEpoch: string) => {
    const rules = chosen.registrations.map(entry => ({ capability: entry.capability,
      prefix: ['sink', entry.id], argument: null,
      adapterId: entry.adapterId, adapterDigest: entry.adapterDigest,
      adapterArtifactDigest: entry.adapterArtifactDigest, deadline: '1000',
      clockDomain, deploymentId, sinkAnchorDigest: entry.sinkAnchorDigest,
      sinkStateWitnessDigest: entry.sinkStateWitnessDigest }))
      .sort((a, b) => a.capability < b.capability ? -1 : 1);
    const body: EffectResourcePolicyBodyV7 = { format: 'aether.effect-resource-policy/7',
      repositoryId, astRoot: gc.root, policyEpoch,
      adapterTableDigest: declarativeSinkTableDigestV2(chosen), rules };
    const context: EvidenceContext = { ...gc.genesis.context,
      capabilityPolicyDigest: effectResourcePolicyDigestV7(body),
      policy: { ...DEFAULT_EVIDENCE_POLICY_V2, requireFormal: false } };
    const evidence = mintLocalEvidence(context);
    const selection: SinkRetirementSelectionV2 = { table: chosen,
      policy: signEffectResourcePolicyV7(body, 'policy:semantic', policyKeys.privateKey),
      manifest: evidence.manifest };
    return { context, evidence, selection };
  };
  const source = selected(table, '1');
  const candidate = selected({ ...table, registrations: table.registrations.slice(0, 1) }, '2');
  const lineage = gc.configuration.lineage;
  const oldIntent = gc.genesis.intent;
  assert.ok(oldIntent);
  const specification = JSON.parse(source.context.specification) as {
    specifications: Array<{ id: string; revision: string }> };
  const specifications: SpecReference[] = specification.specifications.map(row => ({
    id: row.id, revision: row.revision }));
  const endorse = (selectedArtifact: typeof source, parent: string) => {
    const intent = lineage.recordIntent(signIntent({ repositoryId,
      subject: selectedArtifact.evidence.manifest.astRoot as NodeRef,
      executionManifest: executionManifestDigest(selectedArtifact.evidence.manifest),
      evidenceBundleDigest: evidenceBundleDigest(selectedArtifact.evidence),
      parents: [parent], specifications, purpose: 'rewrite',
      text: 'Authorize the exact V7 sink policy, table and candidate artifact.',
      author: 'author', policyEpoch: '1', nonce: randomUUID() }, gc.configuration.key));
    lineage.admitArtifact(intent, selectedArtifact.evidence, selectedArtifact.context);
    return intent;
  };
  const sourceIntent = endorse(source, oldIntent);
  const candidateIntent = endorse(candidate, sourceIntent);
  const retirement = { repositoryId, store: gc.store, registry: gc.configuration.registry,
    exportPolicy: gc.configuration.policy, retentionLedger: gc.retentionLedger,
    sourceSignerKey: policyKeys.publicKey, candidateSignerKey: policyKeys.publicKey,
    sourcePolicyEpoch: '1', candidatePolicyEpoch: '2' };
  const proof = proposeSemanticSinkRetirementV2(retirement,
    source.selection, candidate.selection, source.context.specification);
  assert.ok(proof);
  const plan: TopologyPlan = { shape: 'containers', units: [{ id: 'worker',
    members: gc.module.kind === 'Module'
      ? gc.module.members.filter(member => member.kind === 'FunctionDecl').map(member => member.symbol)
      : [], capabilities: [gc.liveCap, gc.unusedCap],
    placement: 'container', memoryMb: 16 }], crossEdges: [],
    transportLatencyMsPerSecond: 0, monthlyCost: 0,
    recombinations: [], blockedMerges: [] };
  const signer = createEffectSignerAnchor({ repositoryId, signer: 'policy:semantic',
    epochAuthorityId: 'epoch:semantic', publicKey: policyKeys.publicKey,
    currentEpoch: () => epoch });
  const clock = createTrustedClockAnchor({ authorityId: 'clock:semantic', clockDomain,
    nowMs: () => 100, revision: () => '0' });
  const grants = new ScopedGrantAuthority({ key: new Uint8Array(32).fill(54),
    repositoryId, clock: () => 100, policyEpoch: () => epoch,
    revocationEpoch: () => '0', isRevoked: () => false,
    authorizeIssue: () => true, authorizeDelegate: () => true });
  const effectWitnesses = new Map<string, ReturnType<typeof createNamespacedEffectJournalWitness>>();
  const effectHeads = new Map<string, WitnessHead>();
  const effectCatalog = createNamespacedEffectJournalWitnessCatalog({
    authorityId: 'operator:semantic-effects', repositoryId, deploymentId, clockDomain,
    witnessFor(operationId) {
      let witness = effectWitnesses.get(operationId);
      if (!witness) {
        effectHeads.set(operationId, { revision: '0', journal: null });
        witness = createNamespacedEffectJournalWitness({ authorityId: 'operator:semantic-effects',
          repositoryId, catalogDeploymentId: deploymentId, operationId, clockDomain,
          read: () => effectHeads.get(operationId)!, advance(expected, journal) {
            const head = effectHeads.get(operationId)!; assert.equal(head.revision, expected);
            const next = { revision: String(BigInt(expected) + 1n), journal };
            effectHeads.set(operationId, next); return next;
          } });
        effectWitnesses.set(operationId, witness);
      }
      return witness;
    },
  });
  const hostWitnesses = new Map<string, ReturnType<typeof createHostJournalWitness>>();
  const hostHeads = new Map<string, HostJournalHead>();
  const hostCatalog = createHostJournalWitnessCatalog({ authorityId: 'operator:semantic-hosts',
    repositoryId, deploymentId, witnessFor(hostId) {
      let witness = hostWitnesses.get(hostId);
      if (!witness) {
        hostHeads.set(hostId, { revision: '0', journal: null });
        witness = createHostJournalWitness({ authorityId: 'operator:semantic-hosts',
          repositoryId, deploymentId, hostId, read: () => hostHeads.get(hostId)!,
          advance(expected, journal) {
            const head = hostHeads.get(hostId)!; assert.equal(head.revision, expected);
            const next = { revision: String(BigInt(expected) + 1n), journal };
            hostHeads.set(hostId, next); return next;
          } });
        hostWitnesses.set(hostId, witness);
      }
      return witness;
    },
  });
  let deploymentHead: DeploymentJournalHead = { revision: '0', journal: null };
  const deploymentWitness = createDeploymentJournalWitness({
    authorityId: 'operator:semantic-deployment', repositoryId, deploymentId,
    read: () => deploymentHead, advance(expected, journal) {
      assert.equal(deploymentHead.revision, expected);
      deploymentHead = { revision: String(BigInt(expected) + 1n), journal };
      return deploymentHead;
    },
  });
  const factoryId = 'semantic-sink-services/1';
  const sealer = new CapabilitySealer(new Uint8Array(32).fill(55), () => 100);
  const factory = (record: ProcessArtifactV2): ProcessHostServices => ({ sealer, scopedGrants: grants,
    signedEffectResourcePolicy: record.signedEffectResourcePolicyV7,
    authorizeRecovery: () => true,
    effectRouterFactory: effect => {
      const id = domainDigest('aether.semantic-deployment-effect-dir/1', effect.operationId)
        .split(':').at(-1)!;
      const broker = new DurableEffectBroker({ directory: join(directory, 'effects', id),
        ...(effect.mode === 'replay' ? { mode: 'replay' as const, replayEvents: [] } : {}),
        clockDomain, clock: () => 100n, authorize: () => true,
        authorizeReconciliation: () => true,
        witness: selectEffectJournalWitness(effectCatalog, effect.operationId),
        attestedSinkV4: { anchor, deploymentId,
          approvedAdapterArtifactDigest: artifactDigest, sinkStateWitness: sinkWitness } });
      const adapters = new Map(([[gc.liveCap, liveAdapter], [gc.unusedCap, deadAdapter]] as const)
        .filter(([cap]) => record.sinkTableV2.registrations.some(row => row.capability === cap)));
      return new BrokerEffectRouter({ broker, manifest: record.manifest,
        executionId: effect.operationId, policyEpoch: effect.policyEpoch!,
        deadline: effect.deadline!, adapters, grantRef: effect.grantRef!,
        admissionTableDigest: effect.admissionTableDigest,
        grant: () => { throw new Error('V13 broker must not use factory grant callback'); } });
    } });
  const coordinator = new PromotionCoordinator({
    directory: join(directory, 'coordinator'), repositoryId,
    genesisManifest: executionManifestDigest(source.evidence.manifest),
    lineage: lineage.admissionAdapter(),
    authority: () => ({ repositoryId, membershipEpoch: '1', policyEpoch: '1',
      eligibleGovernors: ['governor'] }), governorKey: () => governorKeys.publicKey,
    clock: () => 100n });
  const options: ProcessDeploymentOptions = { directory: join(directory, 'deployment'),
    coordinator, capabilityProfile: 'scoped-anchored-sink-v12',
    factories: new Map(), semanticSinkFactories: new Map([[factoryId, factory]]),
    effectSignerAnchor: signer, trustedClockAnchor: clock,
    effectJournalWitnessCatalog: effectCatalog,
    hostJournalWitnessCatalog: hostCatalog,
    deploymentJournalWitness: deploymentWitness,
    attestedSinkAuthority: { repositoryId, deploymentId,
      approvedAdapterArtifactDigest: artifactDigest, anchor }, sinkStateWitness: sinkWitness,
    semanticSinkRetirement: retirement,
    genesis: { context: source.context, evidence: source.evidence, plan,
      factoryId, signedEffectResourcePolicyV7: source.selection.policy,
      sinkTableV2: source.selection.table, retirementProofV2: null } };
  return { gc, directory, repositoryId, deploymentId, anchor, artifactDigest,
    sinkWitness, decisions, executes: () => executes, liveAdapter, deadAdapter,
    source, candidate, sourceIntent, candidateIntent, retirement, proof, plan, signer, clock, grants,
    effectCatalog, hostCatalog, deploymentWitness, coordinator, governorKeys,
    options,
    factoryId, setEpoch: (value: string) => { epoch = value; },
    cleanup: () => { gc.cleanup(); rmSync(directory, { recursive: true, force: true }); } };
}

async function retirementPromotion(f: ReturnType<typeof fixture>, deployment: ProcessDeployment,
  candidateArtifactDigest: string): Promise<PromotionInput> {
  const predecessorArtifactDigest = processArtifactDigest(
    deployment.artifact(executionManifestDigest(f.source.evidence.manifest)));
  const migrationPlan = processMigrationPlan(
    await deployment.snapshotForPromotion(), candidateArtifactDigest);
  const semanticExportPolicyDigest = domainDigest('aether.semantic-sink-export-policy/2', {
    repositoryId: f.repositoryId, policy: f.retirement.exportPolicy,
    registry: [...f.retirement.registry.names].sort().map(name => f.retirement.registry.get(name)),
  });
  const effectPlan = processSemanticSinkEffectPlan({ factoryId: f.factoryId,
    capabilityPolicyDigest: f.candidate.evidence.manifest.capabilityPolicyDigest,
    signerAnchorDigest: f.signer.digest, clockAnchorDigest: f.clock.digest,
    effectWitnessCatalogDigest: f.effectCatalog.digest,
    hostWitnessCatalogDigest: f.hostCatalog.digest,
    deploymentWitnessDigest: f.deploymentWitness.digest,
    sinkAnchorDigest: domainDigest('aether.sink-anchor/1', f.anchor),
    sinkDeploymentId: f.deploymentId,
    approvedAdapterArtifactDigest: f.artifactDigest,
    sinkStateWitnessDigest: f.sinkWitness.digest,
    sinkTableDigest: declarativeSinkTableDigestV2(f.candidate.selection.table),
    candidateArtifactDigest, predecessorArtifactDigest,
    retirementProofDigest: f.proof.id, semanticExportPolicyDigest });
  const proposal = { format: 'aether.promotion/1' as const,
    repositoryId: f.repositoryId, expectedParent: f.coordinator.state().committedManifest,
    candidateManifest: executionManifestDigest(f.candidate.evidence.manifest),
    evidenceBundleDigest: evidenceBundleDigest(f.candidate.evidence),
    migrationPlanDigest: migrationPlanDigest(migrationPlan),
    effectPlanDigest: effectPlanDigest(effectPlan),
    membershipEpoch: '1', policyEpoch: '1', expiresAt: '1000' };
  return { proposal,
    approval: approvePromotion(proposal, 'governor', f.governorKeys.privateKey),
    evidence: f.candidate.evidence, context: f.candidate.context,
    migrationPlan, effectPlan };
}

function registerRetirementCandidate(f: ReturnType<typeof fixture>, deployment: ProcessDeployment) {
  return deployment.registerArtifact({ context: f.candidate.context,
    evidence: f.candidate.evidence, plan: f.plan, factoryId: f.factoryId,
    signedEffectResourcePolicyV7: f.candidate.selection.policy,
    sinkTableV2: f.candidate.selection.table, retirementProofV2: f.proof });
}

test('V12 semantic deployment artifact and effect plan preserve exact V1/V2 domains', () => {
  const f = fixture();
  try {
    const old = { format: 'aether.process-artifact/1' as const,
      ir: 'x', manifest: f.source.evidence.manifest, specification: 's',
      policy: f.source.context.policy!, capabilities: [], externals: [], plan: '{}',
      factoryId: f.factoryId, evidence: f.source.evidence,
      schemaDigest: domainDigest('aether.process-schema/1', 's') };
    assert.equal(processArtifactDigest(old), domainDigest('aether.process-artifact/1', old));
    const next = { ...old, format: 'aether.process-artifact/2' as const,
      signedEffectResourcePolicyV7: f.source.selection.policy,
      sinkTableV2: f.source.selection.table, retirementProofV2: null };
    assert.equal(processArtifactDigest(next), domainDigest('aether.process-artifact/2', next));
  } finally { f.cleanup(); }
});

test('V12 witnessed deployment retires one dead signed sink, preserves live dispatch and old receipt', async () => {
  const f = fixture();
  let deployment: ProcessDeployment | null = null;
  try {
    deployment = await ProcessDeployment.open(f.options);
    assert.equal(f.coordinator.admissionProfile, 'strict-lineage-v1');
    assert.equal(deployment.status().servingReady, true);
    assert.equal(JSON.parse(readFileSync(join(f.options.directory, 'deployment.json'), 'utf8')).format,
      'aether.process-deployment/12');
    assert.equal(deployment.artifact(executionManifestDigest(f.source.evidence.manifest)).format,
      'aether.process-artifact/2');
    assert.throws(() => deployment!.issueScopedTokens(f.gc.unused), /export authority/);
    const tokens = () => deployment!.issueScopedTokens(f.gc.live, 1000,
      new Map([[f.gc.liveCap, ['sink', 'a-live']]]));
    const old = await deployment.call(f.gc.live, [], { operationId: 'semantic:old', tokens: tokens() });
    assert.equal(old.state, 'completed');
    assert.equal(f.decisions.length, 1);
    const cutoverTokens = tokens();
    f.setEpoch('2');
    assert.equal(deployment.status().servingReady, false,
      'source V7 policy is stale during the signed epoch cutover');
    await deployment.close(); deployment = null;
    deployment = await ProcessDeployment.open({ ...f.options, genesis: undefined });
    assert.equal(deployment.status().servingReady, false,
      'restart during epoch cutover opens only for administrative recovery');
    assert.throws(() => deployment!.issueScopedTokens(f.gc.live), /policy epoch|serving/i);
    await assert.rejects(deployment.call(f.gc.live, [], {
      operationId: 'semantic:cutover-denied', tokens: cutoverTokens }), /policy epoch|serving/i);
    assert.deepEqual(await deployment.recoverOperation('semantic:old'), old);
    assert.equal(f.decisions.length, 1,
      'historical receipt inspection never redispatches a stale source effect');
    const candidateArtifactDigest = registerRetirementCandidate(f, deployment);
    const predecessorArtifactDigest = processArtifactDigest(
      deployment.artifact(executionManifestDigest(f.source.evidence.manifest)));
    const promotion = await retirementPromotion(f, deployment, candidateArtifactDigest);
    if (promotion.effectPlan.tag !== 'sequence') throw new Error('invalid test effect plan');
    const wrongPlan = { ...promotion.effectPlan, items: [
      ...promotion.effectPlan.items.slice(0, -1),
      { tag: 'string' as const,
        value: domainDigest('aether.semantic-sink-export-policy/2', 'forged') },
    ] };
    const wrongProposal = { ...promotion.proposal,
      effectPlanDigest: effectPlanDigest(wrongPlan) };
    await assert.rejects(deployment.promote({ ...promotion, effectPlan: wrongPlan,
      proposal: wrongProposal,
      approval: approvePromotion(wrongProposal, 'governor', f.governorKeys.privateKey) }),
    /approved effect factory|mismatch/);
    assert.equal(f.decisions.length, 1);
    await deployment.promote(promotion);
    assert.equal(deployment.status().generation, '1');
    const published = JSON.parse(readFileSync(join(f.options.directory, 'deployment.json'), 'utf8'));
    assert.equal(published.activeSinkTableDigest,
      declarativeSinkTableDigestV2(f.candidate.selection.table));
    assert.equal(published.activeRetirementProofDigest, f.proof.id);
    assert.equal(published.activePredecessorArtifactDigest, predecessorArtifactDigest);
    assert.throws(() => deployment!.issueScopedTokens(f.gc.unused), /export authority/);
    const again = await deployment.call(f.gc.live, [], {
      operationId: 'semantic:new', tokens: tokens() });
    assert.equal(again.state, 'completed');
    assert.equal(f.decisions.length, 2);
    const beforeReplay = f.executes();
    assert.deepEqual(await deployment.recoverOperation('semantic:old'), old);
    assert.equal(f.executes(), beforeReplay, 'historical predecessor receipt cannot redispatch');
    f.gc.retentionLedger.retain({ kind: 'active-task',
      reference: 'arrived-after-retirement', root: f.gc.root });
    await deployment.close(); deployment = null;
    deployment = await ProcessDeployment.open({ ...f.options, genesis: undefined });
    assert.equal(deployment.status().servingReady, true);
    assert.deepEqual(await deployment.recoverOperation('semantic:old'), old);
    assert.equal(f.executes(), beforeReplay);
  } finally { await deployment?.close(); f.cleanup(); }
});

test('V12 commit fence rejects a new active-task pin after candidate preparation', async () => {
  const f = fixture(); let deployment: ProcessDeployment | null = null;
  let armed = false;
  try {
    deployment = await ProcessDeployment.open({ ...f.options,
      phase: phase => {
        if (armed && phase === 'prepared') f.gc.retentionLedger.retain({
          kind: 'active-task', reference: 'late-v12-task', root: f.gc.root });
      },
    });
    f.setEpoch('2');
    const candidate = registerRetirementCandidate(f, deployment);
    const promotion = await retirementPromotion(f, deployment, candidate);
    armed = true;
    await assert.rejects(deployment.promote(promotion), /retention changed|must be reproved/);
    assert.equal(f.coordinator.state().committedManifest,
      executionManifestDigest(f.source.evidence.manifest));
    const witnessed = JSON.parse(readFileSync(join(f.options.directory, 'deployment.json'), 'utf8'));
    assert.equal(witnessed.active.manifest,
      executionManifestDigest(f.source.evidence.manifest));
    assert.equal(witnessed.activeRetirementProofDigest, null);
    assert.equal(f.decisions.length, 0);
    assert.equal(deployment.status().servingReady, false);
    assert.equal(deployment.status().servingReady, false,
      'aborted retirement cannot revive the stale epoch-1 source for new calls');
    assert.throws(() => deployment!.issueScopedTokens(f.gc.live), /epoch|policy/i);
  } finally { await deployment?.close(); f.cleanup(); }
});

test('V12 rejects semantic checkpoint custody smuggled through a reloadable factory', async () => {
  const f = fixture();
  try {
    const original = f.options.semanticSinkFactories!.get(f.factoryId)!;
    await assert.rejects(ProcessDeployment.open({ ...f.options,
      directory: join(f.directory, 'factory-checkpoint-smuggle'),
      semanticSinkFactories: new Map([[f.factoryId, (artifact: ProcessArtifactV2) => ({
        ...original(artifact), semanticCheckpointRetention: {} }) as ProcessHostServices]]),
    }), /semantic checkpoint retention authority must be independently provisioned/);
  } finally { f.cleanup(); }
});
