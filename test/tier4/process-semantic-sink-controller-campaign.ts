/** Short-lived V12 controller for the real-service retirement crash campaign. */
import assert from 'node:assert/strict';
import { createPrivateKey, createPublicKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as b from '../../src/tier1/build.ts';
import { SymbolSpace } from '../../src/tier1/symbols.ts';
import { capability } from '../../src/tier1/ids.ts';
import { DurableGraphStore } from '../../src/tier1/durable-store.ts';
import { CausalLineageLedger, signIntent, signSpecRevision } from '../../src/tier1/causal-lineage.ts';
import type { NodeRef } from '../../src/tier1/ids.ts';
import { SemanticGarbageCollector } from '../../src/tier1/semantic-gc.ts';
import { proposeSemanticSinkRetirementV2 } from '../../src/tier1/semantic-gc-sink-retirement.ts';
import { CapabilityRegistry, CapabilitySealer } from '../../src/tier2/ocap.ts';
import { ScopedGrantAuthority } from '../../src/tier2/scoped-grants.ts';
import { createEffectSignerAnchor } from '../../src/tier2/effect-signer-anchor.ts';
import { createTrustedClockAnchor } from '../../src/tier2/trusted-clock-anchor.ts';
import { declarativeSinkTableDigestV2, type DeclarativeSinkTableV2 } from '../../src/tier2/declarative-sink-table.ts';
import { effectResourcePolicyDigestV7, signEffectResourcePolicyV7, type EffectResourcePolicyBodyV7 } from '../../src/tier2/effect-resource-policy.ts';
import { DEFAULT_EVIDENCE_POLICY_V2, mintLocalEvidence, type EvidenceContext } from '../../src/fabric/evidence.ts';
import { domainDigest, executionManifestDigest } from '../../src/fabric/identity.ts';
import { DurableEffectBroker, effectAdapterDigest } from '../../src/fabric/effects.ts';
import { createAttestedSinkClient } from '../../src/fabric/attested-sink-service.ts';
import { createAttestedSinkAdapter } from '../../src/fabric/attested-sink-adapter.ts';
import { createProcessWitnessClient } from '../../src/fabric/witness-service.ts';
import { selectEffectJournalWitness } from '../../src/fabric/effect-journal-witness.ts';
import { BrokerEffectRouter } from '../../src/tier3/effects.ts';
import { PromotionCoordinator, approvePromotion, evidenceBundleDigest,
  migrationPlanDigest, effectPlanDigest } from '../../src/fabric/promotion.ts';
import { ProcessDeployment, processArtifactDigest, processMigrationPlan,
  processSemanticSinkEffectPlan, type ProcessArtifactV2,
  type ProcessDeploymentOptions, type ProcessHostServices } from '../../src/tier4/process-deployment.ts';
import type { TopologyPlan } from '../../src/tier4/topology.ts';
import type { SinkPublicAnchorV1 } from '../../src/fabric/sink-receipt.ts';

interface Fixture {
  directory: string; repositoryId: string; deploymentId: string; clockDomain: string;
  anchor: SinkPublicAnchorV1; adapterArtifactDigest: string;
  sinkSocket: string; sinkAuthKeyFile: string;
  sinkWitnessSocket: string; sinkWitnessKeyFile: string;
  operatorSocket: string; operatorKeyFile: string;
  policySignerKeyFile: string; governorKeyFile: string;
  grantKeyFile: string; sealerKeyFile: string; epochFile: string;
}
const f = JSON.parse(readFileSync(process.argv[2]!, 'utf8')) as Fixture;
const mode = process.argv[3];
assert.ok(['init', 'crash-before', 'crash-after', 'recover-before', 'recover-after',
  'outage', 'inspect'].includes(mode ?? ''), `unknown controller mode ${mode}`);
const epoch = readFileSync(f.epochFile, 'utf8').trim();
const symbols = new SymbolSpace('semantic-sink-process-campaign');
const live = symbols.define('live'), dead = symbols.define('dead');
const liveCap = capability('cap:campaign:live'), deadCap = capability('cap:campaign:dead');
const registry = new CapabilityRegistry();
for (const cap of [liveCap, deadCap]) registry.declare(cap, {
  arity: 0, description: 'campaign attested sink', effectful: true });
const module = b.module_({ symbol: symbols.define('module'), symbolTable: symbols.table(), members: [
  b.fn({ symbol: live, returns: b.Unit, capabilities: [liveCap], purity: 'effectful',
    contract: b.contract({}), body: b.block(b.exprStmt(b.invoke(liveCap)), b.ret(b.unit())) }),
  b.fn({ symbol: dead, returns: b.Unit, capabilities: [deadCap], purity: 'effectful',
    contract: b.contract({}), body: b.block(b.exprStmt(b.invoke(deadCap)), b.ret(b.unit())) }),
] });
const store = new DurableGraphStore({ directory: join(f.directory, 'ast') });
const root = store.intern(module, { leaseId: 'campaign-code' });
const plan: TopologyPlan = { shape: 'containers', units: [{ id: 'worker',
  members: [live, dead], capabilities: [liveCap, deadCap], placement: 'container', memoryMb: 16 }],
  crossEdges: [], transportLatencyMsPerSecond: 0, monthlyCost: 0,
  recombinations: [], blockedMerges: [] };
const operator = createProcessWitnessClient({ socketPath: f.operatorSocket,
  key: readFileSync(f.operatorKeyFile), timeoutMs: 10_000 });
const sinkWitness = createProcessWitnessClient({ socketPath: f.sinkWitnessSocket,
  key: readFileSync(f.sinkWitnessKeyFile), timeoutMs: 10_000 }).sinkStateWitness({
    authorityId: 'operator:v12-sink', anchor: f.anchor,
    adapterArtifactDigest: f.adapterArtifactDigest });
const effectCatalog = operator.effectCatalog({ authorityId: 'operator:v12-effects',
  repositoryId: f.repositoryId, deploymentId: f.deploymentId, clockDomain: f.clockDomain });
const hostCatalog = operator.hostCatalog({ authorityId: 'operator:v12-hosts',
  repositoryId: f.repositoryId, deploymentId: f.deploymentId });
const deploymentWitness = operator.deploymentWitness({ authorityId: 'operator:v12-deployment',
  repositoryId: f.repositoryId, deploymentId: f.deploymentId });
const sinkClient = createAttestedSinkClient({ socketPath: f.sinkSocket,
  authKey: readFileSync(f.sinkAuthKeyFile), anchor: f.anchor,
  adapterArtifactDigest: f.adapterArtifactDigest, repositoryId: f.repositoryId,
  deploymentId: f.deploymentId, timeoutMs: 10_000 });
const liveAdapter = createAttestedSinkAdapter({ id: 'v12-campaign-live/1',
  client: sinkClient, repositoryId: f.repositoryId, deploymentId: f.deploymentId,
  approvedAdapterArtifactDigest: f.adapterArtifactDigest, anchor: f.anchor });
const deadAdapter = createAttestedSinkAdapter({ id: 'v12-campaign-dead/1',
  client: { execute() { throw new Error('retired adapter dispatched'); },
    status() { return { state: 'unknown' }; } }, repositoryId: f.repositoryId,
  deploymentId: f.deploymentId, approvedAdapterArtifactDigest: f.adapterArtifactDigest,
  anchor: f.anchor });
const registrations = [
  { id: 'a-live', capability: liveCap, adapter: liveAdapter },
  { id: 'b-dead', capability: deadCap, adapter: deadAdapter },
].map(row => ({ id: row.id, capability: row.capability, adapterId: row.adapter.id,
  adapterDigest: effectAdapterDigest(row.adapter), adapterArtifactDigest: f.adapterArtifactDigest,
  deploymentId: f.deploymentId, sinkAnchorDigest: domainDigest('aether.sink-anchor/1', f.anchor),
  sinkStateWitnessDigest: sinkWitness.digest,
  lifecycle: 'attested-external-no-unload/1' as const }));
const sourceTable: DeclarativeSinkTableV2 = { format: 'aether.declarative-adapter-table/2',
  repositoryId: f.repositoryId, registrations };
const candidateTable: DeclarativeSinkTableV2 = { ...sourceTable,
  registrations: sourceTable.registrations.slice(0, 1) };
const policyKey = createPrivateKey(readFileSync(f.policySignerKeyFile));
const lineage = new CausalLineageLedger({ directory: join(f.directory, 'lineage'),
  repositoryId: f.repositoryId, store,
  authority: () => ({ policyEpoch: '1', eligibleAuthors: ['campaign-author'] }),
  authorKey: () => createPublicKey(policyKey) });
const spec = { id: 'campaign-spec', revision: lineage.publishSpec(signSpecRevision({
  repositoryId: f.repositoryId, id: 'campaign-spec', revision: 1, previous: null,
  parents: [], text: 'Preserve the exported live sink and signed retirement proof.',
  requirements: [], author: 'campaign-author', policyEpoch: '1',
  nonce: '00000000-0000-4000-8000-000000000001',
}, policyKey)) };
const specification = lineage.specification([], [spec]);
const d = (value: string) => domainDigest('aether.semantic-sink-process-campaign/1', value);
const selection = (table: DeclarativeSinkTableV2, policyEpoch: string) => {
  const rules = table.registrations.map(entry => ({ capability: entry.capability,
    prefix: ['campaign', entry.id], argument: null,
    adapterId: entry.adapterId, adapterDigest: entry.adapterDigest,
    adapterArtifactDigest: entry.adapterArtifactDigest, deadline: '1000',
    clockDomain: f.clockDomain, deploymentId: f.deploymentId,
    sinkAnchorDigest: entry.sinkAnchorDigest, sinkStateWitnessDigest: entry.sinkStateWitnessDigest }))
    .sort((a, b) => a.capability < b.capability ? -1 : 1);
  const body: EffectResourcePolicyBodyV7 = { format: 'aether.effect-resource-policy/7',
    repositoryId: f.repositoryId, astRoot: root, policyEpoch,
    adapterTableDigest: declarativeSinkTableDigestV2(table), rules };
  const context: EvidenceContext = { module, registry, specification,
    semanticsVersion: 'aether-reference/1', compilerDigest: d('compiler'),
    capabilityPolicyDigest: effectResourcePolicyDigestV7(body),
    target: { abiVersion: 'process/1', profileDigest: d('profile'), artifactDigest: d('artifact') },
    policy: { ...DEFAULT_EVIDENCE_POLICY_V2, requireFormal: false } };
  const evidence = mintLocalEvidence(context);
  return { context, evidence, selection: { table,
    policy: signEffectResourcePolicyV7(body, 'policy:v12-campaign', policyKey),
    manifest: evidence.manifest } };
};
const source = selection(sourceTable, '1'), candidate = selection(candidateTable, '2');
const gcPolicy = { epoch: 'campaign-exports/1', exports: [live], protectedSymbols: [] };
const endorse = (selected: typeof source, parents: readonly string[], nonce: string) => {
  const intent = lineage.recordIntent(signIntent({ repositoryId: f.repositoryId,
    subject: selected.evidence.manifest.astRoot as NodeRef,
    executionManifest: executionManifestDigest(selected.evidence.manifest),
    evidenceBundleDigest: evidenceBundleDigest(selected.evidence),
    parents, specifications: [spec], purpose: parents.length ? 'rewrite' : 'genesis',
    text: 'Authorize the exact signed V12 sink table and policy.',
    author: 'campaign-author', policyEpoch: '1', nonce }, policyKey));
  lineage.admitArtifact(intent, selected.evidence, selected.context);
  return intent;
};
const sourceIntent = endorse(source, [], '00000000-0000-4000-8000-000000000002');
endorse(candidate, [sourceIntent], '00000000-0000-4000-8000-000000000003');
const retentionLedger = new SemanticGarbageCollector({ directory: join(f.directory, 'retention'),
  repositoryId: f.repositoryId, store, lineage, registry, policy: gcPolicy });
const retirement = { repositoryId: f.repositoryId, store, registry,
  exportPolicy: gcPolicy, retentionLedger, sourceSignerKey: createPublicKey(policyKey),
  candidateSignerKey: createPublicKey(policyKey), sourcePolicyEpoch: '1', candidatePolicyEpoch: '2' };
const proof = proposeSemanticSinkRetirementV2(retirement,
  source.selection, candidate.selection, specification);
assert.ok(proof);
const signer = createEffectSignerAnchor({ repositoryId: f.repositoryId,
  signer: 'policy:v12-campaign', epochAuthorityId: 'operator:v12-epoch',
  publicKey: createPublicKey(policyKey), currentEpoch: () => epoch });
const clock = createTrustedClockAnchor({ authorityId: 'operator:v12-clock',
  clockDomain: f.clockDomain, nowMs: () => 100, revision: () => '0' });
const grants = new ScopedGrantAuthority({ key: readFileSync(f.grantKeyFile),
  repositoryId: f.repositoryId, clock: () => 100, policyEpoch: () => epoch,
  revocationEpoch: () => '0', isRevoked: () => false,
  authorizeIssue: () => true, authorizeDelegate: () => true });
const sealer = new CapabilitySealer(readFileSync(f.sealerKeyFile), () => 100);
const governorKey = createPrivateKey(readFileSync(f.governorKeyFile));
const coordinator = new PromotionCoordinator({
  directory: join(f.directory, 'coordinator'), repositoryId: f.repositoryId,
  genesisManifest: executionManifestDigest(source.evidence.manifest),
  lineage: lineage.admissionAdapter(),
  authority: () => ({ repositoryId: f.repositoryId, membershipEpoch: '1',
    policyEpoch: '1', eligibleGovernors: ['governor'] }),
  governorKey: () => createPublicKey(governorKey), clock: () => 100n,
  fault: point => {
    if (mode === 'crash-before' && point === 'after-prepared'
      || mode === 'crash-after' && point === 'after-commit')
      process.kill(process.pid, 'SIGKILL');
  } });
const factoryId = 'v12-campaign-services/1';
const factory = (artifact: ProcessArtifactV2): ProcessHostServices => ({
  sealer, scopedGrants: grants,
  signedEffectResourcePolicy: artifact.signedEffectResourcePolicyV7,
  authorizeRecovery: () => true,
  effectRouterFactory: effect => {
    const suffix = d(effect.operationId).split(':').at(-1)!;
    const witness = selectEffectJournalWitness(effectCatalog, effect.operationId);
    const broker = new DurableEffectBroker({ directory: join(f.directory, 'effects', suffix),
      ...(effect.mode === 'replay' ? { mode: 'replay' as const, replayEvents: [] } : {}),
      clockDomain: f.clockDomain, clock: () => 100n, authorize: () => true,
      authorizeReconciliation: () => true, witness,
      attestedSinkV4: { anchor: f.anchor, deploymentId: f.deploymentId,
        approvedAdapterArtifactDigest: f.adapterArtifactDigest, sinkStateWitness: sinkWitness } });
    const adapters = new Map(([[liveCap, liveAdapter], [deadCap, deadAdapter]] as const)
      .filter(([cap]) => artifact.sinkTableV2.registrations.some(row => row.capability === cap)));
    return new BrokerEffectRouter({ broker, manifest: artifact.manifest,
      executionId: effect.operationId, policyEpoch: effect.policyEpoch!,
      deadline: effect.deadline!, adapters, grantRef: effect.grantRef!,
      admissionTableDigest: effect.admissionTableDigest,
      grant: () => { throw new Error('V13 factory grant callback used'); } });
  },
});
const options: ProcessDeploymentOptions = { directory: join(f.directory, 'deployment'),
  coordinator, capabilityProfile: 'scoped-anchored-sink-v12',
  phase: (phase, detail) => {
    if (mode === 'crash-before' || mode === 'crash-after')
      process.stdout.write(JSON.stringify({ event: phase, workerPids: detail.workerPids,
        controllerPid: process.pid }) + '\n');
  },
  factories: new Map(), semanticSinkFactories: new Map([[factoryId, factory]]),
  effectSignerAnchor: signer, trustedClockAnchor: clock,
  effectJournalWitnessCatalog: effectCatalog, hostJournalWitnessCatalog: hostCatalog,
  deploymentJournalWitness: deploymentWitness,
  attestedSinkAuthority: { repositoryId: f.repositoryId, deploymentId: f.deploymentId,
    approvedAdapterArtifactDigest: f.adapterArtifactDigest, anchor: f.anchor },
  sinkStateWitness: sinkWitness, semanticSinkRetirement: retirement,
  ...(mode === 'init' ? { genesis: { context: source.context, evidence: source.evidence,
    plan, factoryId, signedEffectResourcePolicyV7: source.selection.policy,
    sinkTableV2: source.selection.table, retirementProofV2: null } } : {}),
};
let deployment: ProcessDeployment | null = null;
try {
  deployment = await ProcessDeployment.open(options);
  if (mode === 'init') {
    const tokens = deployment.issueScopedTokens(live, 1000,
      new Map([[liveCap, ['campaign', 'a-live']]]));
    const old = await deployment.call(live, [], { operationId: 'old-v12', tokens });
    assert.equal(old.state, 'completed');
    process.stdout.write(JSON.stringify({ mode, old, pid: process.pid,
      workerPids: deployment.status().workerPids }) + '\n');
  } else if (mode === 'crash-before' || mode === 'crash-after') {
    process.stdout.write(JSON.stringify({ event: 'source-workers',
      workerPids: deployment.status().workerPids, controllerPid: process.pid }) + '\n');
    const candidateArtifactDigest = deployment.registerArtifact({ context: candidate.context,
      evidence: candidate.evidence, plan, factoryId,
      signedEffectResourcePolicyV7: candidate.selection.policy,
      sinkTableV2: candidate.selection.table, retirementProofV2: proof });
    const predecessorArtifactDigest = processArtifactDigest(
      deployment.artifact(executionManifestDigest(source.evidence.manifest)));
    const migrationPlan = processMigrationPlan(await deployment.snapshotForPromotion(),
      candidateArtifactDigest);
    const semanticExportPolicyDigest = domainDigest('aether.semantic-sink-export-policy/2', {
      repositoryId: f.repositoryId, policy: gcPolicy,
      registry: [...registry.names].sort().map(name => registry.get(name)),
    });
    const effectPlan = processSemanticSinkEffectPlan({ factoryId,
      capabilityPolicyDigest: candidate.evidence.manifest.capabilityPolicyDigest,
      signerAnchorDigest: signer.digest, clockAnchorDigest: clock.digest,
      effectWitnessCatalogDigest: effectCatalog.digest,
      hostWitnessCatalogDigest: hostCatalog.digest,
      deploymentWitnessDigest: deploymentWitness.digest,
      sinkAnchorDigest: domainDigest('aether.sink-anchor/1', f.anchor),
      sinkDeploymentId: f.deploymentId, approvedAdapterArtifactDigest: f.adapterArtifactDigest,
      sinkStateWitnessDigest: sinkWitness.digest,
      sinkTableDigest: declarativeSinkTableDigestV2(candidateTable),
      candidateArtifactDigest, predecessorArtifactDigest,
      retirementProofDigest: proof.id, semanticExportPolicyDigest });
    const proposal = { format: 'aether.promotion/1' as const,
      repositoryId: f.repositoryId, expectedParent: coordinator.state().committedManifest,
      candidateManifest: executionManifestDigest(candidate.evidence.manifest),
      evidenceBundleDigest: evidenceBundleDigest(candidate.evidence),
      migrationPlanDigest: migrationPlanDigest(migrationPlan),
      effectPlanDigest: effectPlanDigest(effectPlan), membershipEpoch: '1',
      policyEpoch: '1', expiresAt: '1000' };
    await deployment.promote({ proposal,
      approval: approvePromotion(proposal, 'governor', governorKey),
      evidence: candidate.evidence, context: candidate.context,
      migrationPlan, effectPlan });
    throw new Error('controller passed expected promotion SIGKILL');
  } else if (mode === 'recover-before' || mode === 'recover-after') {
    const settled = await deployment.recover();
    const old = await deployment.recoverOperation('old-v12');
    assert.equal(old.state, 'completed');
    assert.equal(settled.committedManifest, mode === 'recover-before'
      ? executionManifestDigest(source.evidence.manifest)
      : executionManifestDigest(candidate.evidence.manifest));
    const fresh = mode === 'recover-after'
      ? await deployment.call(live, [], { operationId: 'new-v12',
        tokens: deployment.issueScopedTokens(live, 1000,
          new Map([[liveCap, ['campaign', 'a-live']]])) }) : null;
    if (fresh) assert.equal(fresh.state, 'completed');
    process.stdout.write(JSON.stringify({ mode, old, fresh, settled, pid: process.pid,
      workerPids: deployment.status().workerPids }) + '\n');
  } else if (mode === 'inspect') {
    const old = await deployment.recoverOperation('old-v12');
    process.stdout.write(JSON.stringify({ mode, old, pid: process.pid }) + '\n');
  } else throw new Error('witness outage unexpectedly allowed deployment open');
} finally { await deployment?.close(); }
