import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as b from '../../src/tier1/build.ts';
import { capability } from '../../src/tier1/ids.ts';
import { SymbolSpace } from '../../src/tier1/symbols.ts';
import { GraphStore } from '../../src/tier1/store.ts';
import { CapabilityRegistry, CapabilitySealer } from '../../src/tier2/ocap.ts';
import { ScopedGrantAuthority, type ScopedGrantV2 } from '../../src/tier2/scoped-grants.ts';
import { createEffectSignerAnchor } from '../../src/tier2/effect-signer-anchor.ts';
import { createTrustedClockAnchor } from '../../src/tier2/trusted-clock-anchor.ts';
import { wasmAdapterArtifactForBytes, admitWasmAdapterBytes, admittedAdapterArtifactDigest } from '../../src/tier2/adapter-artifact.ts';
import { effectResourcePolicyDigestV4, signEffectResourcePolicyV4, type EffectResourcePolicyBodyV4 } from '../../src/tier2/effect-resource-policy.ts';
import { createNamespacedEffectJournalWitness, createNamespacedEffectJournalWitnessCatalog,
  type NamespacedEffectJournalWitness, type WitnessHead } from '../../src/fabric/effect-journal-witness.ts';
import { createHostJournalWitness, createHostJournalWitnessCatalog, type HostJournalWitness, type HostJournalHead } from '../../src/fabric/host-journal-witness.ts';
import { createDeploymentJournalWitness, type DeploymentJournalHead } from '../../src/fabric/deployment-journal-witness.ts';
import { encodeCanonical } from '../../src/fabric/encoding.ts';
import { DEFAULT_EVIDENCE_POLICY_V2, mintLocalEvidence, type EvidenceContext } from '../../src/fabric/evidence.ts';
import { DurableEffectBroker, effectAdapterDigest } from '../../src/fabric/effects.ts';
import { domainDigest, executionManifestDigest } from '../../src/fabric/identity.ts';
import { PromotionCoordinator, approvePromotion, evidenceBundleDigest, migrationPlanDigest, effectPlanDigest, type PromotionInput } from '../../src/fabric/promotion.ts';
import { BrokerEffectRouter } from '../../src/tier3/effects.ts';
import { ProcessHost, PROCESS_INVOKE, type ProcessHostOptions } from '../../src/tier4/process-host.ts';
import { ProcessDeployment, processMigrationPlan, processHostWitnessedWasmEffectPlan, type ProcessDeploymentOptions } from '../../src/tier4/process-deployment.ts';
import type { TopologyPlan } from '../../src/tier4/topology.ts';

const wasm = Uint8Array.from([0,97,115,109,1,0,0,0,
  1,6,1,0x60,1,0x7f,1,0x7f,3,2,1,0,5,4,1,1,1,1,
  7,16,2,3,114,117,110,0,0,6,109,101,109,111,114,121,2,0,
  10,16,1,14,0,0x20,0,0x45,0x04,0x40,0x00,0x0b,0x20,0,0x41,1,0x6a,0x0b]);

test('V9 protects complete host and broker history across real Wasm calls, promotion and reopen', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'aether-wasm-host-witness-'));
  let host: ProcessHost | undefined, deployment: ProcessDeployment | undefined;
  try {
    const symbols = new SymbolSpace('wasm-host-witness-v9'), entry = symbols.define('entry'), x = symbols.define('x');
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
    const witnesses = new Map<string, { witness: NamespacedEffectJournalWitness; head: WitnessHead }>();
    const witnessFor = (operationId: string): NamespacedEffectJournalWitness => {
      let row = witnesses.get(operationId);
      if (!row) {
        row = { witness: null as unknown as NamespacedEffectJournalWitness, head: { revision: '0', journal: null } };
        const state = row;
        row.witness = createNamespacedEffectJournalWitness({ authorityId: 'witness-operator', repositoryId,
          catalogDeploymentId: 'witness-deployment', operationId, clockDomain, read: () => state.head,
          advance(expected, journal) { assert.equal(state.head.revision, expected);
            state.head = { revision: String(BigInt(expected) + 1n), journal }; return state.head; } });
        witnesses.set(operationId, row);
      }
      return row.witness;
    };
    const catalog = createNamespacedEffectJournalWitnessCatalog({ authorityId: 'witness-operator', repositoryId,
      deploymentId: 'witness-deployment', clockDomain, witnessFor });
    const hostWitnesses = new Map<string, { witness: HostJournalWitness; head: HostJournalHead }>();
    let loseHostAcknowledgmentFor: string | null = null;
    const hostWitnessFor = (hostId: string): HostJournalWitness => {
      let row = hostWitnesses.get(hostId);
      if (!row) {
        row = { witness: null as unknown as HostJournalWitness, head: { revision: '0', journal: null } };
        const state = row;
        row.witness = createHostJournalWitness({ authorityId: 'host-witness-operator', repositoryId,
          deploymentId: 'witness-deployment', hostId,
          read: () => state.head, advance(expected, journal) {
            assert.equal(state.head.revision, expected);
            state.head = { revision: String(BigInt(expected) + 1n), journal };
            if (loseHostAcknowledgmentFor && JSON.parse(journal).calls.some((call: { operationId: string }) =>
              call.operationId === loseHostAcknowledgmentFor)) {
              loseHostAcknowledgmentFor = null;
              throw new Error('host witness accepted intent but response was lost');
            }
            return state.head;
          } });
        hostWitnesses.set(hostId, row);
      }
      return row.witness;
    };
    const hostCatalog = createHostJournalWitnessCatalog({ authorityId: 'host-witness-operator', repositoryId,
      deploymentId: 'witness-deployment', witnessFor: hostWitnessFor });
    let deploymentHead: DeploymentJournalHead = { revision: '0', journal: null };
    let loseDeploymentAcknowledgmentFor: string | null = null;
    const deploymentWitness = createDeploymentJournalWitness({ authorityId: 'deployment-witness-operator', repositoryId,
      deploymentId: 'witness-deployment', read: () => deploymentHead,
      advance(expected, journal) {
        assert.equal(deploymentHead.revision, expected);
        deploymentHead = { revision: String(BigInt(expected) + 1n), journal };
        if (loseDeploymentAcknowledgmentFor && JSON.parse(journal).invocations.some((row: { operationId: string }) =>
          row.operationId === loseDeploymentAcknowledgmentFor)) {
          loseDeploymentAcknowledgmentFor = null;
          throw new Error('deployment witness accepted intent but response was lost');
        }
        return deploymentHead;
      } });
    const plan: TopologyPlan = { shape: 'containers', units: [{ id: 'worker', members: [entry], capabilities: [CAP],
      placement: 'container', memoryMb: 16 }], crossEdges: [], transportLatencyMsPerSecond: 0,
      monthlyCost: 0, recombinations: [], blockedMerges: [] };
    let wrongWitness = false, replaceBrokerMethod = false;
    let currentPolicy = signEffectResourcePolicyV4(policy, signer.signer, keys.privateKey);
    const factory: NonNullable<ProcessHostOptions['effectRouterFactory']> = effect => {
      const base = witnessFor(effect.operationId);
      const selected = wrongWitness ? createNamespacedEffectJournalWitness({ authorityId: base.authorityId,
        repositoryId: base.repositoryId, catalogDeploymentId: base.catalogDeploymentId,
        operationId: base.operationId, clockDomain: base.clockDomain,
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
      hostJournalWitness: hostWitnessFor('direct-v9-host'),
      anchoredEffectPolicyProfile: 'isolated-wasm-v7-host-witness', signedEffectResourcePolicy: currentPolicy,
      authorizeRecovery: () => true, effectRouterFactory: factory };
    await assert.rejects(ProcessHost.open({ ...hostOptions, effectJournalWitnessCatalog: undefined }), /witness catalog required/);
    await assert.rejects(ProcessHost.open({ ...hostOptions, hostJournalWitness: undefined }), /host journal witness required/);
    host = await ProcessHost.open(hostOptions);
    const tokens = () => host!.issueScopedTokens(entry, 60_000, new Map([[CAP, ['wasm']]]));
    const hostFile = join(hostOptions.directory, 'host.json'), beforeDirect = readFileSync(hostFile, 'utf8');
    const issued = tokens(), invokeGrant = issued.find(token => token.body.capability === PROCESS_INVOKE)!,
      effectGrant = issued.find(token => token.body.capability === CAP)!;
    const directAttacks: readonly [string, readonly ScopedGrantV2[]][] = [
      ['missing-all', []], ['missing-effect', [invokeGrant]],
      ['forged-effect', [invokeGrant, { ...effectGrant, signature: '0'.repeat(64) }]],
      ['wrong-audience', [invokeGrant, grants.issue({ capability: CAP, audience: 'other-entry', path: effectGrant.body.path }, 60_000)]],
      ['wrong-path', [invokeGrant, grants.issue({ capability: CAP, audience: entry, path: ['wrong'] }, 60_000)]],
      ['duplicate-effect', [invokeGrant, effectGrant, effectGrant]],
      ['narrowed-invoke', [grants.attenuate(invokeGrant, { capability: PROCESS_INVOKE, audience: entry,
        path: [...invokeGrant.body.path, 'child'] }, 60_000), effectGrant]],
    ];
    const witnessCountBeforeDenials = witnesses.size;
    for (const [name, denied] of directAttacks) {
      await assert.rejects(host.call(entry, [{ tag: 'int', value: '7' }],
        { operationId: `direct-denied-${name}`, tokens: denied }), /authority_denied|grant/);
      assert.equal(readFileSync(hostFile, 'utf8'), beforeDirect, name);
      assert.equal(witnesses.size, witnessCountBeforeDenials, name);
    }
    const direct = await host.call(entry, [{ tag: 'int', value: '7' }], { operationId: 'direct-v9', tokens: tokens() });
    assert.equal(direct.state, 'completed');
    assert.equal(JSON.parse(readFileSync(hostFile, 'utf8')).configuration.split(':')[0], 'aether.process-host-config/7');
    const complete = readFileSync(hostFile, 'utf8'), witnessedHead = hostWitnesses.get('direct-v9-host')!.head;
    const omission = JSON.parse(complete);
    const recordedCall = omission.calls.find((call: { operationId: string }) => call.operationId === 'direct-v9');
    assert.equal(recordedCall.effects.length, 1);
    const directEffectId = recordedCall.effects[0].id as string;
    recordedCall.effects = [];
    writeFileSync(hostFile, encodeCanonical(omission));
    assert.throws(() => host!.operationResult('direct-v9'), /diverges from operator witness/);
    assert.throws(() => host!.operationEffectDisposition('direct-v9'), /diverges from operator witness/);
    assert.deepEqual(hostWitnesses.get('direct-v9-host')!.head, witnessedHead);
    writeFileSync(hostFile, beforeDirect);
    assert.equal(host.operationEffectDisposition('direct-v9')?.possibleExternalCommit, true);
    assert.equal(readFileSync(hostFile, 'utf8'), beforeDirect, 'read-only inspection does not race a writer by repairing local bytes');
    await host.close(); host = await ProcessHost.open(hostOptions);
    assert.equal(host.operationEffectDisposition('direct-v9')?.possibleExternalCommit, true);
    assert.ok(BigInt(JSON.parse(readFileSync(hostFile, 'utf8')).witnessRevision) > BigInt(JSON.parse(beforeDirect).witnessRevision));
    unlinkSync(hostFile);
    assert.equal(host.operationResult('direct-v9')?.state, 'completed');
    assert.equal(existsSync(hostFile), false);
    await host.close(); host = await ProcessHost.open(hostOptions);
    assert.equal(host.operationEffectDisposition('direct-v9')?.possibleExternalCommit, true);
    assert.equal(existsSync(hostFile), true, 'reopen republishes the complete operator head');
    const beforeUncertain = readFileSync(hostFile, 'utf8');
    loseHostAcknowledgmentFor = 'uncertain-v9';
    await assert.rejects(host.call(entry, [{ tag: 'int', value: '9' }],
      { operationId: 'uncertain-v9', tokens: tokens() }), /response was lost/);
    assert.equal(readFileSync(hostFile, 'utf8'), beforeUncertain, 'local file did not publish a guessed result');
    assert.equal(host.operationEffectDisposition('uncertain-v9')?.safeToAbortBeforeEffects, true);
    assert.equal((await host.recoverOperation('uncertain-v9', { strategy: 'abort-before-effects' })).state, 'aborted');
    const directEffectWitness = witnesses.get(directEffectId)!, retainedEffectHead = directEffectWitness.head;
    directEffectWitness.head = { revision: '0', journal: null };
    assert.throws(() => host!.status(), /effect witness rolled back/);
    await assert.rejects(host.snapshot(), /effect witness rolled back/);
    directEffectWitness.head = retainedEffectHead;
    const directRetryTokens = tokens();
    wrongWitness = true;
    assert.throws(() => host!.operationResult('direct-v9'), /witness differs from operator authority/);
    await assert.rejects(host.call(entry, [{ tag: 'int', value: '7' }], { operationId: 'direct-v9', tokens: directRetryTokens }), /witness differs from operator authority/);
    wrongWitness = false;
    assert.equal(host.operationResult('direct-v9')?.state, 'completed');
    replaceBrokerMethod = true;
    assert.throws(() => host!.operationResult('direct-v9'), /replaceable method boundary/);
    replaceBrokerMethod = false;
    await host.close(); host = undefined;
    const directHostWitness = hostWitnesses.get('direct-v9-host')!, latestHostHead = directHostWitness.head;
    directHostWitness.head = { revision: '0', journal: null };
    await assert.rejects(ProcessHost.open(hostOptions), /host witness rolled back/);
    directHostWitness.head = latestHostHead;
    const stableDirectHost = readFileSync(hostFile);
    await assert.rejects(ProcessHost.open({ ...hostOptions,
      anchoredEffectPolicyProfile: 'isolated-wasm-v6-witnessed', hostJournalWitness: undefined }), /effect witness catalog differs|configuration mismatch/);
    assert.deepEqual(readFileSync(hostFile), stableDirectHost);
    const changedCatalog = createNamespacedEffectJournalWitnessCatalog({ authorityId: 'other-operator', repositoryId,
      deploymentId: 'witness-deployment', clockDomain, witnessFor });
    await assert.rejects(ProcessHost.open({ ...hostOptions, effectJournalWitnessCatalog: changedCatalog }), /identity\/revision mismatch|configuration mismatch/);
    const crossNamespaceCatalog = createNamespacedEffectJournalWitnessCatalog({ authorityId: 'witness-operator', repositoryId,
      deploymentId: 'other-deployment', clockDomain, witnessFor });
    await assert.rejects(ProcessHost.open({ ...hostOptions, effectJournalWitnessCatalog: crossNamespaceCatalog }),
      /host journal witness differs from signed repository\/effect namespace/);
    host = await ProcessHost.open(hostOptions);

    const governor = generateKeyPairSync('ed25519');
    const coordinator = new PromotionCoordinator({ profile: 'baseline-governor-v1', directory: join(directory, 'coordinator'),
      repositoryId, genesisManifest: executionManifestDigest(manifest),
      authority: () => ({ repositoryId, membershipEpoch: '1', policyEpoch: '1', eligibleGovernors: ['governor'] }),
      governorKey: () => governor.publicKey, clock: () => 100n });
    const deploymentOptions: ProcessDeploymentOptions = { directory: join(directory, 'deployment'), coordinator,
      capabilityProfile: 'scoped-anchored-wasm-v9', effectSignerAnchor: signer,
      trustedClockAnchor: clock, effectJournalWitnessCatalog: catalog, hostJournalWitnessCatalog: hostCatalog,
      deploymentJournalWitness: deploymentWitness,
      factories: new Map([['witness-services/1', () => ({ sealer: hostOptions.sealer, scopedGrants: grants,
        signedEffectResourcePolicy: currentPolicy, effectRouterFactory: factory, authorizeRecovery: () => true })]]),
      genesis: { context, evidence, plan, factoryId: 'witness-services/1' } };
    await assert.rejects(ProcessDeployment.open({ ...deploymentOptions, directory: join(directory, 'factory-supplied'),
      factories: new Map([['witness-services/1', () => ({ sealer: hostOptions.sealer, scopedGrants: grants,
        signedEffectResourcePolicy: currentPolicy, effectRouterFactory: factory,
        effectJournalWitnessCatalog: catalog } as never)]]) }), /independently provisioned/);
    await assert.rejects(ProcessDeployment.open({ ...deploymentOptions, directory: join(directory, 'factory-supplied-host'),
      factories: new Map([['witness-services/1', () => ({ sealer: hostOptions.sealer, scopedGrants: grants,
        signedEffectResourcePolicy: currentPolicy, effectRouterFactory: factory,
        hostJournalWitness: hostWitnessFor('genesis') } as never)]]) }), /independently provisioned/);
    await assert.rejects(ProcessDeployment.open({ ...deploymentOptions, directory: join(directory, 'factory-supplied-deployment'),
      factories: new Map([['witness-services/1', () => ({ sealer: hostOptions.sealer, scopedGrants: grants,
        signedEffectResourcePolicy: currentPolicy, effectRouterFactory: factory,
        deploymentJournalWitness: deploymentWitness } as never)]]) }), /independently provisioned/);
    deployment = await ProcessDeployment.open(deploymentOptions);
    assert.equal(deployment.status().capabilityProfile, 'scoped-anchored-wasm-v9');
    assert.equal(JSON.parse(readFileSync(join(deploymentOptions.directory, 'deployment.json'), 'utf8')).format, 'aether.process-deployment/9');
    assert.equal(JSON.parse(readFileSync(join(deploymentOptions.directory, 'deployments', 'genesis', 'prepared.json'), 'utf8')).format,
      'aether.process-deployment-prepared/7');
    const deployedTokens = () => deployment!.issueScopedTokens(entry, 60_000, new Map([[CAP, ['wasm']]]));
    const deployedIssued = deployedTokens(), deployedInvoke = deployedIssued.find(token => token.body.capability === PROCESS_INVOKE)!,
      deployedEffect = deployedIssued.find(token => token.body.capability === CAP)!;
    const deployedAttacks: readonly [string, readonly ScopedGrantV2[]][] = [
      ['missing-all', []], ['missing-effect', [deployedInvoke]],
      ['forged-effect', [deployedInvoke, { ...deployedEffect, signature: '0'.repeat(64) }]],
      ['wrong-audience', [deployedInvoke, grants.issue({ capability: CAP, audience: 'other-entry',
        path: deployedEffect.body.path }, 60_000)]],
      ['wrong-path', [deployedInvoke, grants.issue({ capability: CAP, audience: entry, path: ['wrong'] }, 60_000)]],
      ['duplicate-effect', [deployedInvoke, deployedEffect, deployedEffect]],
      ['narrowed-invoke', [grants.attenuate(deployedInvoke, { capability: PROCESS_INVOKE, audience: entry,
        path: [...deployedInvoke.body.path, 'child'] }, 60_000), deployedEffect]],
    ];
    const deploymentBeforeDenials = readFileSync(join(deploymentOptions.directory, 'deployment.json'), 'utf8');
    const effectHeadsBeforeDenials = witnesses.size;
    for (const [name, denied] of deployedAttacks) {
      await assert.rejects(deployment.call(entry, [{ tag: 'int', value: '3' }],
        { operationId: `deployed-denied-${name}`, tokens: denied }), /authority_denied|grant/);
      assert.equal(readFileSync(join(deploymentOptions.directory, 'deployment.json'), 'utf8'), deploymentBeforeDenials, name);
      assert.equal(witnesses.size, effectHeadsBeforeDenials, name);
    }
    const brokerBeforeOuterLoss = witnesses.size;
    loseDeploymentAcknowledgmentFor = 'outer-uncertain-v9';
    await assert.rejects(deployment.call(entry, [{ tag: 'int', value: '11' }],
      { operationId: 'outer-uncertain-v9', tokens: deployedTokens() }), /response was lost/);
    assert.equal(witnesses.size, brokerBeforeOuterLoss, 'outer intent was witnessed before any broker entry');
    assert.equal((await deployment.recoverOperation('outer-uncertain-v9', { strategy: 'abort-before-effects' })).state, 'aborted');
    assert.equal((await deployment.call(entry, [{ tag: 'int', value: '3' }], { operationId: 'deployed-v9', tokens: deployedTokens() })).state, 'completed');
    const retryTokens = deployedTokens();
    const deployedHostFile = join(deploymentOptions.directory, 'deployments', 'genesis', 'host', 'host.json');
    const deployedComplete = readFileSync(deployedHostFile, 'utf8'), deployedOmission = JSON.parse(deployedComplete);
    const deployedCall = deployedOmission.calls.find((call: { operationId: string }) => call.operationId === 'deployed-v9');
    assert.equal(deployedCall.effects.length, 1);
    deployedCall.effects = [];
    writeFileSync(deployedHostFile, encodeCanonical(deployedOmission));
    await assert.rejects(deployment.call(entry, [{ tag: 'int', value: '3' }],
      { operationId: 'deployed-v9', tokens: retryTokens }), /diverges from operator witness/);
    await assert.rejects(deployment.recoverOperation('deployed-v9'), /diverges from operator witness/);
    writeFileSync(deployedHostFile, deployedComplete);
    wrongWitness = true;
    await assert.rejects(deployment.call(entry, [{ tag: 'int', value: '3' }], { operationId: 'deployed-v9', tokens: retryTokens }), /witness differs from operator authority/);
    await assert.rejects(deployment.recoverOperation('deployed-v9'), /witness differs from operator authority/);
    wrongWitness = false;
    assert.equal((await deployment.call(entry, [{ tag: 'int', value: '3' }], { operationId: 'deployed-v9', tokens: deployedTokens() })).state, 'completed');
    assert.equal((await deployment.recoverOperation('deployed-v9')).state, 'completed');
    const deploymentFile = join(deploymentOptions.directory, 'deployment.json');
    const beforePromotion = readFileSync(deploymentFile, 'utf8');

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
    const effectPlan = processHostWitnessedWasmEffectPlan('witness-services/1', candidateEvidence.manifest.capabilityPolicyDigest,
      signer.digest, clock.digest, catalog.digest, hostCatalog.digest, deploymentWitness.digest);
    const proposal = { format: 'aether.promotion/1' as const, repositoryId,
      expectedParent: coordinator.state().committedManifest, candidateManifest: executionManifestDigest(candidateEvidence.manifest),
      evidenceBundleDigest: evidenceBundleDigest(candidateEvidence), migrationPlanDigest: migrationPlanDigest(migrationPlan),
      effectPlanDigest: effectPlanDigest(effectPlan), membershipEpoch: '1', policyEpoch: '1', expiresAt: '1000' };
    const promotion: PromotionInput = { proposal, approval: approvePromotion(proposal, 'governor', governor.privateKey),
      evidence: candidateEvidence, context: candidateContext, migrationPlan, effectPlan };
    await deployment.promote(promotion);
    assert.equal(deployment.status().generation, '1');
    assert.equal((await deployment.call(entry, [{ tag: 'int', value: '5' }], { operationId: 'promoted-v9',
      tokens: deployedTokens() })).state, 'completed');
    const oldRetryTokens = deployedTokens();
    const completeRegistry = readFileSync(deploymentFile, 'utf8'), omittedRegistry = JSON.parse(completeRegistry);
    const priorCount = omittedRegistry.invocations.length, brokerWitnessCount = witnesses.size;
    omittedRegistry.invocations = omittedRegistry.invocations.filter((row: { operationId: string }) => row.operationId !== 'deployed-v9');
    assert.equal(omittedRegistry.invocations.length, priorCount - 1);
    writeFileSync(deploymentFile, encodeCanonical(omittedRegistry));
    await assert.rejects(deployment.call(entry, [{ tag: 'int', value: '3' }],
      { operationId: 'deployed-v9', tokens: oldRetryTokens }), /local deployment registry diverges from operator witness/);
    assert.equal(witnesses.size, brokerWitnessCount, 'omitted outer receipt cannot redispatch into the promoted host');
    assert.equal(deploymentHead.journal, completeRegistry);
    writeFileSync(deploymentFile, completeRegistry);
    await deployment.close(); deployment = undefined;
    const stableDeployment = readFileSync(deploymentFile);
    await assert.rejects(ProcessDeployment.open({ ...deploymentOptions, genesis: undefined,
      capabilityProfile: 'scoped-anchored-wasm-v8', hostJournalWitnessCatalog: undefined,
      deploymentJournalWitness: undefined }), /effect witness catalog differs|unknown, missing|invalid deployment readiness\/profile/);
    assert.deepEqual(readFileSync(deploymentFile), stableDeployment);
    await assert.rejects(ProcessDeployment.open({ ...deploymentOptions, genesis: undefined,
      capabilityProfile: 'scoped-anchored-wasm-v7', effectJournalWitnessCatalog: undefined }));
    assert.deepEqual(readFileSync(join(deploymentOptions.directory, 'deployment.json')), stableDeployment);
    const otherCatalog = createNamespacedEffectJournalWitnessCatalog({ authorityId: 'different-operator', repositoryId,
      deploymentId: 'witness-deployment', clockDomain, witnessFor });
    await assert.rejects(ProcessDeployment.open({ ...deploymentOptions, genesis: undefined,
      effectJournalWitnessCatalog: otherCatalog }), /durable effect witness catalog mismatch/);
    await assert.rejects(ProcessDeployment.open({ ...deploymentOptions, genesis: undefined,
      effectJournalWitnessCatalog: crossNamespaceCatalog }), /deployment journal witness differs from operator identity/);
    const otherHostCatalog = createHostJournalWitnessCatalog({ authorityId: 'different-host-operator', repositoryId,
      deploymentId: 'witness-deployment', witnessFor: hostWitnessFor });
    await assert.rejects(ProcessDeployment.open({ ...deploymentOptions, genesis: undefined,
      hostJournalWitnessCatalog: otherHostCatalog }), /durable host witness catalog mismatch/);
    const otherDeploymentWitness = createDeploymentJournalWitness({ authorityId: 'different-deployment-operator',
      repositoryId, deploymentId: 'witness-deployment', read: () => ({ revision: '0', journal: null }),
      advance: () => { throw new Error('wrong deployment witness cannot advance'); } });
    await assert.rejects(ProcessDeployment.open({ ...deploymentOptions, genesis: undefined,
      deploymentJournalWitness: otherDeploymentWitness }), /deployment witness has no state/);
    writeFileSync(deploymentFile, beforePromotion);
    deployment = await ProcessDeployment.open({ ...deploymentOptions, genesis: undefined });
    assert.equal(deployment.status().generation, '1');
    assert.ok(JSON.parse(readFileSync(deploymentFile, 'utf8')).invocations.some((row: { operationId: string }) =>
      row.operationId === 'deployed-v9'), 'reopen restores the complete outer registry from the operator witness');
    await assert.rejects(deployment.call(entry, [{ tag: 'int', value: '3' }],
      { operationId: 'deployed-v9', tokens: deployedTokens() }), /historical invocation requires authority unavailable/);
    assert.equal(witnesses.size, brokerWitnessCount);
    assert.equal((await deployment.call(entry, [{ tag: 'int', value: '5' }], { operationId: 'promoted-v9',
      tokens: deployedTokens() })).state, 'completed');
  } finally { await deployment?.close(); await host?.close(); rmSync(directory, { recursive: true, force: true }); }
});
