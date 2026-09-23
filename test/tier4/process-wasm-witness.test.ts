import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as b from '../../src/tier1/build.ts';
import { capability } from '../../src/tier1/ids.ts';
import { SymbolSpace } from '../../src/tier1/symbols.ts';
import { GraphStore } from '../../src/tier1/store.ts';
import { CapabilityRegistry, CapabilitySealer } from '../../src/tier2/ocap.ts';
import { ScopedGrantAuthority } from '../../src/tier2/scoped-grants.ts';
import { createEffectSignerAnchor } from '../../src/tier2/effect-signer-anchor.ts';
import { createTrustedClockAnchor } from '../../src/tier2/trusted-clock-anchor.ts';
import { wasmAdapterArtifactForBytes, admitWasmAdapterBytes, admittedAdapterArtifactDigest } from '../../src/tier2/adapter-artifact.ts';
import { effectResourcePolicyDigestV4, signEffectResourcePolicyV4, type EffectResourcePolicyBodyV4 } from '../../src/tier2/effect-resource-policy.ts';
import { createEffectJournalWitness, createEffectJournalWitnessCatalog, type EffectJournalWitness, type WitnessHead } from '../../src/fabric/effect-journal-witness.ts';
import { DEFAULT_EVIDENCE_POLICY_V2, mintLocalEvidence, type EvidenceContext } from '../../src/fabric/evidence.ts';
import { DurableEffectBroker, effectAdapterDigest } from '../../src/fabric/effects.ts';
import { domainDigest, executionManifestDigest } from '../../src/fabric/identity.ts';
import { PromotionCoordinator, approvePromotion, evidenceBundleDigest, migrationPlanDigest, effectPlanDigest, type PromotionInput } from '../../src/fabric/promotion.ts';
import { BrokerEffectRouter } from '../../src/tier3/effects.ts';
import { ProcessHost, type ProcessHostOptions } from '../../src/tier4/process-host.ts';
import { ProcessDeployment, processMigrationPlan, processWitnessedWasmEffectPlan, type ProcessDeploymentOptions } from '../../src/tier4/process-deployment.ts';
import type { TopologyPlan } from '../../src/tier4/topology.ts';

const wasm = Uint8Array.from([0,97,115,109,1,0,0,0,
  1,6,1,0x60,1,0x7f,1,0x7f,3,2,1,0,5,4,1,1,1,1,
  7,16,2,3,114,117,110,0,0,6,109,101,109,111,114,121,2,0,
  10,16,1,14,0,0x20,0,0x45,0x04,0x40,0x00,0x0b,0x20,0,0x41,1,0x6a,0x0b]);

test('V8 pins operator witness through real Wasm host, deployment, promotion and reopen', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'aether-wasm-witness-'));
  let host: ProcessHost | undefined, deployment: ProcessDeployment | undefined;
  try {
    const symbols = new SymbolSpace('wasm-witness-v8'), entry = symbols.define('entry'), x = symbols.define('x');
    const CAP = capability('cap:test:wasm_witness'), registry = new CapabilityRegistry();
    registry.define({ name: CAP, domain: 'test', operation: 'wasm_witness', arity: 1, description: 'bounded read-only guest', effectful: true });
    const module = b.module_({ symbol: symbols.define('module'), symbolTable: symbols.table(), members: [
      b.fn({ symbol: entry, params: [b.param(x, b.Int)], returns: b.Int, capabilities: [CAP], purity: 'effectful',
        contract: b.contract({}), body: b.block(b.exprStmt(b.invoke(CAP, b.v(x))), b.ret(b.v(x))) }) ] });
    const repositoryId = 'witness-repository', clockDomain = 'witness-clock/1';
    const adapter = admitWasmAdapterBytes(wasm, wasmAdapterArtifactForBytes(wasm, CAP, 'wasm-witness/1', { maxMemoryPages: 1, timeoutMs: 1000 }));
    const grants = new ScopedGrantAuthority({ key: new Uint8Array(32).fill(51), repositoryId, clock: () => 100,
      policyEpoch: () => '0', revocationEpoch: () => '0', isRevoked: () => false,
      authorizeIssue: () => true, authorizeDelegate: () => true });
    const policy: EffectResourcePolicyBodyV4 = { format: 'aether.effect-resource-policy/4', repositoryId,
      astRoot: new GraphStore().intern(module), policyEpoch: '0', rules: [{ capability: CAP, prefix: ['wasm'],
        argument: null, deadline: '1000', clockDomain, adapterId: adapter.id,
        adapterDigest: effectAdapterDigest(adapter), adapterArtifactDigest: admittedAdapterArtifactDigest(adapter)! }] };
    const digest = (name: string) => domainDigest('aether.wasm-witness-test/1', name);
    const context: EvidenceContext = { module, registry, specification: 'Wasm witness authority test', semanticsVersion: 'reference/1',
      compilerDigest: digest('compiler'), capabilityPolicyDigest: effectResourcePolicyDigestV4(policy),
      target: { abiVersion: 'process/1', profileDigest: digest('profile'), artifactDigest: digest('artifact') },
      policy: { ...DEFAULT_EVIDENCE_POLICY_V2, requireFormal: false } };
    const evidence = mintLocalEvidence(context), manifest = evidence.manifest;
    const keys = generateKeyPairSync('ed25519');
    const signer = createEffectSignerAnchor({ repositoryId, signer: 'witness-policy', epochAuthorityId: 'witness-epoch',
      publicKey: keys.publicKey, currentEpoch: () => '0' });
    const clock = createTrustedClockAnchor({ authorityId: 'witness-clock-operator', clockDomain, nowMs: () => 100, revision: () => '0' });
    const witnesses = new Map<string, { witness: EffectJournalWitness; head: WitnessHead }>();
    const witnessFor = (operationId: string): EffectJournalWitness => {
      let row = witnesses.get(operationId);
      if (!row) {
        row = { witness: null as unknown as EffectJournalWitness, head: { revision: '0', journal: null } };
        const state = row;
        row.witness = createEffectJournalWitness({ authorityId: 'witness-operator', repositoryId,
          deploymentId: operationId, clockDomain, read: () => state.head,
          advance(expected, journal) { assert.equal(state.head.revision, expected);
            state.head = { revision: String(BigInt(expected) + 1n), journal }; return state.head; } });
        witnesses.set(operationId, row);
      }
      return row.witness;
    };
    const catalog = createEffectJournalWitnessCatalog({ authorityId: 'witness-operator', repositoryId,
      deploymentId: 'witness-deployment', clockDomain, witnessFor });
    const plan: TopologyPlan = { shape: 'containers', units: [{ id: 'worker', members: [entry], capabilities: [CAP],
      placement: 'container', memoryMb: 16 }], crossEdges: [], transportLatencyMsPerSecond: 0,
      monthlyCost: 0, recombinations: [], blockedMerges: [] };
    let wrongWitness = false, replaceBrokerMethod = false;
    let currentPolicy = signEffectResourcePolicyV4(policy, signer.signer, keys.privateKey);
    const factory: NonNullable<ProcessHostOptions['effectRouterFactory']> = effect => {
      const base = witnessFor(effect.operationId);
      const selected = wrongWitness ? createEffectJournalWitness({ authorityId: base.authorityId,
        repositoryId: base.repositoryId, deploymentId: base.deploymentId, clockDomain: base.clockDomain,
        read: () => witnesses.get(effect.operationId)!.head, advance: () => { throw new Error('wrong witness used'); } }) : base;
      const path = join(directory, 'effects', domainDigest('aether.wasm-witness-directory/1', effect.operationId).split(':').at(-1)!);
      const live = new DurableEffectBroker({ directory: path, clockDomain: effect.clockDomain!, clock: () => 100n,
        authorize: () => true, authorizeReconciliation: () => true, witness: selected });
      if (replaceBrokerMethod) Object.defineProperty(live, 'inspectRecorded', { value: () => ({ state: 'committed' }) });
      const broker = effect.mode === 'live' ? live : new DurableEffectBroker({ directory: path, mode: 'replay',
        clockDomain: effect.clockDomain!, clock: () => 100n, authorize: () => false, replayEvents: live.events(), witness: selected });
      return new BrokerEffectRouter({ broker, manifest: effect.manifest, executionId: effect.operationId,
        policyEpoch: effect.policyEpoch!, deadline: effect.deadline!, adapters: new Map([[CAP, adapter]]),
        grantRef: effect.grantRef!, grant: () => { throw new Error('unexpected grant callback'); } });
    };
    const hostOptions: ProcessHostOptions = { directory: join(directory, 'direct-host'), module, manifest, plan, registry,
      sealer: new CapabilitySealer(new Uint8Array(32).fill(52), () => 100), scopedGrants: grants,
      effectSignerAnchor: signer, trustedClockAnchor: clock, effectJournalWitnessCatalog: catalog,
      anchoredEffectPolicyProfile: 'isolated-wasm-v6-witnessed', signedEffectResourcePolicy: currentPolicy,
      authorizeRecovery: () => true, effectRouterFactory: factory };
    await assert.rejects(ProcessHost.open({ ...hostOptions, effectJournalWitnessCatalog: undefined }), /witness catalog required/);
    host = await ProcessHost.open(hostOptions);
    const tokens = () => host!.issueScopedTokens(entry, 60_000, new Map([[CAP, ['wasm']]]));
    const direct = await host.call(entry, [{ tag: 'int', value: '7' }], { operationId: 'direct-v8', tokens: tokens() });
    assert.equal(direct.state, 'completed');
    assert.equal(JSON.parse(readFileSync(join(hostOptions.directory, 'host.json'), 'utf8')).configuration.split(':')[0], 'aether.process-host-config/6');
    wrongWitness = true;
    assert.throws(() => host!.operationResult('direct-v8'), /witness differs from operator authority/);
    await assert.rejects(host.call(entry, [{ tag: 'int', value: '7' }], { operationId: 'direct-v8', tokens: tokens() }), /witness differs from operator authority/);
    wrongWitness = false;
    assert.equal(host.operationResult('direct-v8')?.state, 'completed');
    replaceBrokerMethod = true;
    assert.throws(() => host!.operationResult('direct-v8'), /replaceable method boundary/);
    replaceBrokerMethod = false;
    await host.close(); host = undefined;
    const changedCatalog = createEffectJournalWitnessCatalog({ authorityId: 'other-operator', repositoryId,
      deploymentId: 'witness-deployment', clockDomain, witnessFor });
    await assert.rejects(ProcessHost.open({ ...hostOptions, effectJournalWitnessCatalog: changedCatalog }), /configuration mismatch/);
    host = await ProcessHost.open(hostOptions);

    const governor = generateKeyPairSync('ed25519');
    const coordinator = new PromotionCoordinator({ profile: 'baseline-governor-v1', directory: join(directory, 'coordinator'),
      repositoryId, genesisManifest: executionManifestDigest(manifest),
      authority: () => ({ repositoryId, membershipEpoch: '1', policyEpoch: '1', eligibleGovernors: ['governor'] }),
      governorKey: () => governor.publicKey, clock: () => 100n });
    const deploymentOptions: ProcessDeploymentOptions = { directory: join(directory, 'deployment'), coordinator,
      capabilityProfile: 'scoped-anchored-wasm-v8', effectSignerAnchor: signer,
      trustedClockAnchor: clock, effectJournalWitnessCatalog: catalog,
      factories: new Map([['witness-services/1', () => ({ sealer: hostOptions.sealer, scopedGrants: grants,
        signedEffectResourcePolicy: currentPolicy, effectRouterFactory: factory, authorizeRecovery: () => true })]]),
      genesis: { context, evidence, plan, factoryId: 'witness-services/1' } };
    await assert.rejects(ProcessDeployment.open({ ...deploymentOptions, directory: join(directory, 'factory-supplied'),
      factories: new Map([['witness-services/1', () => ({ sealer: hostOptions.sealer, scopedGrants: grants,
        signedEffectResourcePolicy: currentPolicy, effectRouterFactory: factory,
        effectJournalWitnessCatalog: catalog } as never)]]) }), /independently provisioned/);
    deployment = await ProcessDeployment.open(deploymentOptions);
    assert.equal(deployment.status().capabilityProfile, 'scoped-anchored-wasm-v8');
    assert.equal(JSON.parse(readFileSync(join(deploymentOptions.directory, 'deployment.json'), 'utf8')).format, 'aether.process-deployment/8');
    assert.equal(JSON.parse(readFileSync(join(deploymentOptions.directory, 'deployments', 'genesis', 'prepared.json'), 'utf8')).format,
      'aether.process-deployment-prepared/6');
    const deployedTokens = () => deployment!.issueScopedTokens(entry, 60_000, new Map([[CAP, ['wasm']]]));
    assert.equal((await deployment.call(entry, [{ tag: 'int', value: '3' }], { operationId: 'deployed-v8', tokens: deployedTokens() })).state, 'completed');
    wrongWitness = true;
    await assert.rejects(deployment.call(entry, [{ tag: 'int', value: '3' }], { operationId: 'deployed-v8', tokens: deployedTokens() }), /witness differs from operator authority/);
    await assert.rejects(deployment.recoverOperation('deployed-v8'), /witness differs from operator authority/);
    wrongWitness = false;
    assert.equal((await deployment.call(entry, [{ tag: 'int', value: '3' }], { operationId: 'deployed-v8', tokens: deployedTokens() })).state, 'completed');
    assert.equal((await deployment.recoverOperation('deployed-v8')).state, 'completed');

    if (module.kind !== 'Module') throw new Error('fixture module');
    const candidateModule = { ...module, members: module.members.map(member => member.kind === 'FunctionDecl' && member.symbol === entry
      ? { ...member, body: b.block(b.exprStmt(b.invoke(CAP, b.v(x))), b.ret(b.add(b.v(x), b.int(0)))) } : member) };
    const candidatePolicy = { ...policy, astRoot: new GraphStore().intern(candidateModule) };
    currentPolicy = signEffectResourcePolicyV4(candidatePolicy, signer.signer, keys.privateKey);
    const candidateContext: EvidenceContext = { ...context, module: candidateModule,
      capabilityPolicyDigest: effectResourcePolicyDigestV4(candidatePolicy) };
    const candidateEvidence = mintLocalEvidence(candidateContext);
    const artifactDigest = deployment.registerArtifact({ context: candidateContext, evidence: candidateEvidence,
      plan, factoryId: 'witness-services/1' });
    const migrationPlan = processMigrationPlan(await deployment.snapshot(), artifactDigest);
    const effectPlan = processWitnessedWasmEffectPlan('witness-services/1', candidateEvidence.manifest.capabilityPolicyDigest,
      signer.digest, clock.digest, catalog.digest);
    const proposal = { format: 'aether.promotion/1' as const, repositoryId,
      expectedParent: coordinator.state().committedManifest, candidateManifest: executionManifestDigest(candidateEvidence.manifest),
      evidenceBundleDigest: evidenceBundleDigest(candidateEvidence), migrationPlanDigest: migrationPlanDigest(migrationPlan),
      effectPlanDigest: effectPlanDigest(effectPlan), membershipEpoch: '1', policyEpoch: '1', expiresAt: '1000' };
    const promotion: PromotionInput = { proposal, approval: approvePromotion(proposal, 'governor', governor.privateKey),
      evidence: candidateEvidence, context: candidateContext, migrationPlan, effectPlan };
    await deployment.promote(promotion);
    assert.equal(deployment.status().generation, '1');
    assert.equal((await deployment.call(entry, [{ tag: 'int', value: '5' }], { operationId: 'promoted-v8',
      tokens: deployedTokens() })).state, 'completed');
    await deployment.close(); deployment = undefined;
    const stableDeployment = readFileSync(join(deploymentOptions.directory, 'deployment.json'));
    await assert.rejects(ProcessDeployment.open({ ...deploymentOptions, genesis: undefined,
      capabilityProfile: 'scoped-anchored-wasm-v7', effectJournalWitnessCatalog: undefined }));
    assert.deepEqual(readFileSync(join(deploymentOptions.directory, 'deployment.json')), stableDeployment);
    const otherCatalog = createEffectJournalWitnessCatalog({ authorityId: 'different-operator', repositoryId,
      deploymentId: 'witness-deployment', clockDomain, witnessFor });
    await assert.rejects(ProcessDeployment.open({ ...deploymentOptions, genesis: undefined,
      effectJournalWitnessCatalog: otherCatalog }), /durable effect witness catalog mismatch/);
    deployment = await ProcessDeployment.open({ ...deploymentOptions, genesis: undefined });
    assert.equal(deployment.status().generation, '1');
    assert.equal((await deployment.call(entry, [{ tag: 'int', value: '5' }], { operationId: 'promoted-v8',
      tokens: deployedTokens() })).state, 'completed');
  } finally { await deployment?.close(); await host?.close(); rmSync(directory, { recursive: true, force: true }); }
});
