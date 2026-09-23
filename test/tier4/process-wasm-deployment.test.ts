import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as b from '../../src/tier1/build.ts';
import { capability } from '../../src/tier1/ids.ts';
import { SymbolSpace } from '../../src/tier1/symbols.ts';
import { GraphStore } from '../../src/tier1/store.ts';
import { CapabilityRegistry, CapabilitySealer } from '../../src/tier2/ocap.ts';
import { ScopedGrantAuthority } from '../../src/tier2/scoped-grants.ts';
import { wasmAdapterArtifactForBytes, admitWasmAdapterBytes, admittedAdapterArtifactDigest } from '../../src/tier2/adapter-artifact.ts';
import { createEffectSignerAnchor } from '../../src/tier2/effect-signer-anchor.ts';
import { effectResourcePolicyDigestV4, signEffectResourcePolicyV4, type EffectResourcePolicyBodyV4, type SignedEffectResourcePolicyV4 } from '../../src/tier2/effect-resource-policy.ts';
import { DEFAULT_EVIDENCE_POLICY_V2, mintLocalEvidence, type EvidenceContext } from '../../src/fabric/evidence.ts';
import { DurableEffectBroker, effectAdapterDigest, type EffectAdapter } from '../../src/fabric/effects.ts';
import { domainDigest, executionManifestDigest } from '../../src/fabric/identity.ts';
import { PromotionCoordinator, approvePromotion, evidenceBundleDigest, migrationPlanDigest, effectPlanDigest, type PromotionInput } from '../../src/fabric/promotion.ts';
import { BrokerEffectRouter } from '../../src/tier3/effects.ts';
import { ProcessDeployment, processMigrationPlan, processIsolatedWasmEffectPlan, type ProcessArtifactV1, type ProcessDeploymentOptions } from '../../src/tier4/process-deployment.ts';
import type { TopologyPlan } from '../../src/tier4/topology.ts';

const wasm = Uint8Array.from([0, 97, 115, 109, 1, 0, 0, 0,
  1, 6, 1, 0x60, 1, 0x7f, 1, 0x7f, 3, 2, 1, 0, 5, 4, 1, 1, 1, 1,
  7, 16, 2, 3, 114, 117, 110, 0, 0, 6, 109, 101, 109, 111, 114, 121, 2, 0,
  10, 16, 1, 14, 0, 0x20, 0, 0x45, 0x04, 0x40, 0x00, 0x0b, 0x20, 0, 0x41, 1, 0x6a, 0x0b]);

test('opt-in v6 deployment persists an anchored Wasm-only policy through actual process calls and reopen', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'aether-deployment-wasm-')); let deployment: ProcessDeployment | undefined;
  try {
    const symbols = new SymbolSpace('deployment-wasm'), entry = symbols.define('entry'), x = symbols.define('x');
    const CAP = capability('cap:test:deployment_wasm');
    const registry = new CapabilityRegistry(); registry.define({ name: CAP, domain: 'test', operation: 'deployment_wasm', arity: 1,
      description: 'read-only isolated Wasm', effectful: true });
    const module = b.module_({ symbol: symbols.define('module'), symbolTable: symbols.table(), members: [
      b.fn({ symbol: entry, params: [b.param(x, b.Int)], returns: b.Int, capabilities: [CAP], purity: 'effectful', contract: b.contract({}),
        body: b.block(b.exprStmt(b.invoke(CAP, b.v(x))), b.ret(b.v(x))) }),
    ] });
    const artifact = wasmAdapterArtifactForBytes(wasm, CAP, 'deployment-wasm/1', { maxMemoryPages: 1, timeoutMs: 1000 });
    const admitted = admitWasmAdapterBytes(wasm, artifact);
    const body: EffectResourcePolicyBodyV4 = { format: 'aether.effect-resource-policy/4', repositoryId: 'wasm-deployment-repo',
      astRoot: new GraphStore().intern(module), policyEpoch: '0', rules: [{ capability: CAP, prefix: ['wasm'], argument: null, deadline: '1000', clockDomain: 'wasm-deployment-clock/1',
        adapterId: admitted.id, adapterDigest: effectAdapterDigest(admitted), adapterArtifactDigest: admittedAdapterArtifactDigest(admitted)! }] };
    const digest = (value: string) => domainDigest('aether.deployment-wasm-test/1', value);
    const context: EvidenceContext = { module, registry, specification: 'The isolated guest reads one signed integer.',
      semanticsVersion: 'reference/1', compilerDigest: digest('compiler'), capabilityPolicyDigest: effectResourcePolicyDigestV4(body),
      target: { abiVersion: 'process/1', profileDigest: digest('profile'), artifactDigest: digest('artifact') },
      policy: { ...DEFAULT_EVIDENCE_POLICY_V2, requireFormal: false } };
    const evidence = mintLocalEvidence(context), manifest = evidence.manifest;
    const keys = generateKeyPairSync('ed25519');
    const anchor = createEffectSignerAnchor({ repositoryId: body.repositoryId, signer: 'deployment-wasm-policy',
      epochAuthorityId: 'deployment-wasm-epoch', publicKey: keys.publicKey, currentEpoch: () => '0' });
    const signedEffectResourcePolicy = signEffectResourcePolicyV4(body, anchor.signer, keys.privateKey);
    let candidatePolicy: SignedEffectResourcePolicyV4 | null = null;
    let revocationEpoch = '0', revoked = false;
    const grants = new ScopedGrantAuthority({ key: new Uint8Array(32).fill(21), repositoryId: body.repositoryId, clock: () => 100,
      policyEpoch: () => '0', revocationEpoch: () => revocationEpoch, isRevoked: () => revoked,
      authorizeIssue: () => true, authorizeDelegate: () => true });
    const plan: TopologyPlan = { shape: 'containers', units: [{ id: 'worker', members: [entry], capabilities: [CAP], placement: 'container', memoryMb: 16 }],
      crossEdges: [], transportLatencyMsPerSecond: 0, monthlyCost: 0, recombinations: [], blockedMerges: [] };
    let lastBroker: DurableEffectBroker | undefined, active: EffectAdapter = admitted, allowReconciliation = true;
    let refuseGenerationOne = false;
    const factory = (record: ProcessArtifactV1) => ({ sealer: new CapabilitySealer(new Uint8Array(32).fill(22), () => 100), scopedGrants: grants,
      signedEffectResourcePolicy: record.manifest.capabilityPolicyDigest === context.capabilityPolicyDigest ? signedEffectResourcePolicy : candidatePolicy!,
      authorizeRecovery: () => true, effectRouterFactory: (effect: { operationId: string; mode: 'live' | 'replay'; policyEpoch?: string; deadline?: string; clockDomain?: string; grantRef?: string; generation?: string }) => {
        const path = join(directory, 'effects', domainDigest('aether.deployment-wasm-effect/1', effect.operationId).split(':').at(-1)!);
        const live = new DurableEffectBroker({ directory: path, clockDomain: effect.clockDomain!, clock: () => 100n,
          authorize: () => true, authorizeReconciliation: () => allowReconciliation });
        const broker = effect.mode === 'live' ? live : new DurableEffectBroker({ directory: path, mode: 'replay', clockDomain: effect.clockDomain!, clock: () => 100n, authorize: () => false, replayEvents: live.events() });
        if (effect.mode === 'live') lastBroker = live;
        return new BrokerEffectRouter({ broker, manifest: record.manifest, executionId: effect.operationId, policyEpoch: effect.policyEpoch!,
          deadline: effect.deadline!, adapters: new Map([[CAP, refuseGenerationOne && effect.generation === '1' ? { ...admitted } : active]]),
          grantRef: effect.grantRef!,
          grant: () => { throw new Error('v6 must not invoke a grant callback'); } });
      } });
    const governors = generateKeyPairSync('ed25519');
    const authority = { repositoryId: body.repositoryId, membershipEpoch: '1', policyEpoch: '1', eligibleGovernors: ['governor'] };
    const coordinator = new PromotionCoordinator({ profile: 'baseline-governor-v1', directory: join(directory, 'coordinator'),
      repositoryId: body.repositoryId, genesisManifest: executionManifestDigest(manifest), authority: () => authority,
      governorKey: () => governors.publicKey, clock: () => 100n });
    const options: ProcessDeploymentOptions = { directory: join(directory, 'deployment'), coordinator,
      capabilityProfile: 'scoped-anchored-wasm-v6', effectSignerAnchor: anchor,
      factories: new Map([['wasm-services/1', factory]]), genesis: { context, evidence, plan, factoryId: 'wasm-services/1' } };
    active = { ...admitted };
    await assert.rejects(ProcessDeployment.open(options), /isolated Wasm adapter artifact is outside signed resource policy v4/);
    assert.equal(existsSync(join(options.directory, 'deployment.json')), false, 'unbranded genesis cannot become ready');
    active = admitted;
    deployment = await ProcessDeployment.open(options);
    assert.equal(deployment.status().capabilityProfile, 'scoped-anchored-wasm-v6');
    const tokens = () => deployment!.issueScopedTokens(entry, 60_000, new Map([[CAP, ['wasm']]]));
    const first = await deployment.call(entry, [{ tag: 'int', value: '41' }], { operationId: 'first', tokens: tokens() });
    assert.equal(first.state, 'completed');
    const event = lastBroker?.events()[0]; assert.equal(event?.outcome?.state, 'committed');
    if (event?.outcome?.state === 'committed') assert.deepEqual(JSON.parse(JSON.stringify(event.outcome.value)), { tag: 'int', value: '42' });
    await deployment.close(); deployment = undefined;
    const before = readFileSync(join(options.directory, 'deployment.json'), 'utf8');
    active = { ...admitted };
    await assert.rejects(ProcessDeployment.open({ ...options, genesis: undefined }), /isolated Wasm adapter artifact is outside signed resource policy v4/);
    assert.equal(readFileSync(join(options.directory, 'deployment.json'), 'utf8'), before);
    active = admitted;
    await assert.rejects(ProcessDeployment.open({ ...options, genesis: undefined, capabilityProfile: 'scoped-anchored-v5' }), /profile|policy|identity/i);
    assert.equal(readFileSync(join(options.directory, 'deployment.json'), 'utf8'), before);
    const replacement = generateKeyPairSync('ed25519');
    const swappedAnchor = createEffectSignerAnchor({ repositoryId: body.repositoryId, signer: anchor.signer,
      epochAuthorityId: anchor.epochAuthorityId, publicKey: replacement.publicKey, currentEpoch: () => '0' });
    await assert.rejects(ProcessDeployment.open({ ...options, genesis: undefined, effectSignerAnchor: swappedAnchor }), /anchor|signer|configuration/i);
    assert.equal(readFileSync(join(options.directory, 'deployment.json'), 'utf8'), before);
    deployment = await ProcessDeployment.open({ ...options, genesis: undefined });
    const second = await deployment.call(entry, [{ tag: 'int', value: '9' }], { operationId: 'second', tokens: tokens() });
    assert.equal(second.state, 'completed');
    assert.equal(lastBroker?.events()[0]?.outcome?.state, 'committed');
    allowReconciliation = false;
    const pending = await deployment.call(entry, [{ tag: 'int', value: '0' }], { operationId: 'pending-guest', tokens: tokens() });
    assert.equal(pending.state, 'indeterminate');
    await deployment.close(); deployment = undefined;
    allowReconciliation = true;
    deployment = await ProcessDeployment.open({ ...options, genesis: undefined });
    const replayed = await deployment.recoverOperation('pending-guest', { strategy: 'isolated-replay' });
    assert.equal(replayed.state, 'completed'); if (replayed.state === 'completed') assert.equal(replayed.execution.ok, false);
    assert.equal(deployment.status().servingReady, true);
    allowReconciliation = false;
    const pendingAbort = await deployment.call(entry, [{ tag: 'int', value: '0' }], { operationId: 'pending-abort', tokens: tokens() });
    assert.equal(pendingAbort.state, 'indeterminate');
    const aborted = await deployment.recoverOperation('pending-abort', { strategy: 'abort-readonly-wasm' });
    assert.equal(aborted.state, 'aborted');
    allowReconciliation = true;
    const afterRecovery = await deployment.call(entry, [{ tag: 'int', value: '12' }], { operationId: 'after-recovery', tokens: tokens() });
    assert.equal(afterRecovery.state, 'completed');
    if (module.kind !== 'Module') throw new Error('fixture module');
    const candidateModule = { ...module, members: module.members.map(member => member.kind === 'FunctionDecl' && member.symbol === entry
      ? { ...member, body: b.block(b.exprStmt(b.invoke(CAP, b.v(x))), b.ret(b.add(b.v(x), b.int(0)))) } : member) };
    const candidateBody: EffectResourcePolicyBodyV4 = { ...body, astRoot: new GraphStore().intern(candidateModule) };
    candidatePolicy = signEffectResourcePolicyV4(candidateBody, anchor.signer, keys.privateKey);
    const candidateContext: EvidenceContext = { ...context, module: candidateModule,
      capabilityPolicyDigest: effectResourcePolicyDigestV4(candidateBody) };
    const candidateEvidence = mintLocalEvidence(candidateContext);
    const artifactDigest = deployment.registerArtifact({ context: candidateContext, evidence: candidateEvidence, plan, factoryId: 'wasm-services/1' });
    const migrationPlan = processMigrationPlan(await deployment.snapshot(), artifactDigest);
    const effectPlan = processIsolatedWasmEffectPlan('wasm-services/1', candidateEvidence.manifest.capabilityPolicyDigest, anchor.digest);
    const proposal = { format: 'aether.promotion/1' as const, repositoryId: body.repositoryId,
      expectedParent: coordinator.state().committedManifest, candidateManifest: executionManifestDigest(candidateEvidence.manifest),
      evidenceBundleDigest: evidenceBundleDigest(candidateEvidence), migrationPlanDigest: migrationPlanDigest(migrationPlan),
      effectPlanDigest: effectPlanDigest(effectPlan), membershipEpoch: '1', policyEpoch: '1', expiresAt: '1000' };
    const promotion: PromotionInput = { proposal, approval: approvePromotion(proposal, 'governor', governors.privateKey),
      evidence: candidateEvidence, context: candidateContext, migrationPlan, effectPlan };
    await deployment.promote(promotion);
    assert.equal(deployment.status().activeManifest, executionManifestDigest(candidateEvidence.manifest));
    assert.equal(deployment.status().generation, '1');
    const promoted = await deployment.call(entry, [{ tag: 'int', value: '21' }], { operationId: 'after-promotion', tokens: tokens() });
    assert.equal(promoted.state, 'completed');
    assert.equal(lastBroker?.events()[0]?.outcome?.state, 'committed');
    await deployment.close(); deployment = undefined;
    refuseGenerationOne = true;
    await assert.rejects(ProcessDeployment.open({ ...options, genesis: undefined }), /isolated Wasm adapter artifact is outside signed resource policy v4/);
    refuseGenerationOne = false;
    deployment = await ProcessDeployment.open({ ...options, genesis: undefined });
    const oldTokens = tokens(), beforeRevocationBroker = lastBroker;
    revocationEpoch = '1'; revoked = true;
    await assert.rejects(deployment.call(entry, [{ tag: 'int', value: '9' }], { operationId: 'revoked', tokens: oldTokens }), /authority_denied/);
    assert.equal(lastBroker, beforeRevocationBroker, 'revoked grant cannot start another child computation');
  } finally { await deployment?.close(); rmSync(directory, { recursive: true, force: true }); }
});
