import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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
import { encodeCanonical } from '../../src/fabric/encoding.ts';
import { selectEffectJournalWitness, readWitnessHead, type NamespacedEffectJournalWitnessCatalog } from '../../src/fabric/effect-journal-witness.ts';
import { selectHostJournalWitness } from '../../src/fabric/host-journal-witness.ts';
import { createProcessWitnessClient } from '../../src/fabric/witness-service.ts';
import { DEFAULT_EVIDENCE_POLICY_V2, mintLocalEvidence, type EvidenceContext } from '../../src/fabric/evidence.ts';
import { DurableEffectBroker, effectAdapterDigest } from '../../src/fabric/effects.ts';
import { domainDigest, executionManifestDigest } from '../../src/fabric/identity.ts';
import { PromotionCoordinator } from '../../src/fabric/promotion.ts';
import { BrokerEffectRouter } from '../../src/tier3/effects.ts';
import { ProcessHost, type ProcessHostOptions } from '../../src/tier4/process-host.ts';
import { ProcessDeployment, type ProcessDeploymentOptions } from '../../src/tier4/process-deployment.ts';
import type { TopologyPlan } from '../../src/tier4/topology.ts';

const wasm = Uint8Array.from([0,97,115,109,1,0,0,0,
  1,6,1,0x60,1,0x7f,1,0x7f,3,2,1,0,5,4,1,1,1,1,
  7,16,2,3,114,117,110,0,0,6,109,101,109,111,114,121,2,0,
  10,16,1,14,0,0x20,0,0x45,0x04,0x40,0x00,0x0b,0x20,0,0x41,1,0x6a,0x0b]);

async function launch(configFile: string): Promise<ChildProcess> {
  const root = resolve(import.meta.dirname, '../..');
  const child = spawn(process.execPath, ['--experimental-strip-types',
    join(root, 'src/fabric/witness-service-cli.ts'), '--config', configFile],
  { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH ?? '', NODE_NO_WARNINGS: '1' } });
  await new Promise<void>((resolveReady, reject) => {
    let output = '', errors = '';
    const timeout = setTimeout(() => reject(new Error(`witness service startup timeout: ${errors}`)), 10_000);
    child.stdout!.on('data', chunk => {
      output += String(chunk);
      if (output.includes('witness service ready')) { clearTimeout(timeout); resolveReady(); }
    });
    child.stderr!.on('data', chunk => { errors += String(chunk).slice(0, 2048); });
    child.once('exit', code => { clearTimeout(timeout); reject(new Error(`witness service exited ${code}: ${errors}`)); });
    child.once('error', error => { clearTimeout(timeout); reject(error); });
  });
  return child;
}
async function kill(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>(resolveExit => child.once('exit', () => resolveExit()));
  child.kill('SIGKILL'); await exited;
}

test('V9 real host and deployment survive external witness service SIGKILL and restart without redispatch', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'aether-external-witness-'));
  let server: ChildProcess | undefined, host: ProcessHost | undefined, deployment: ProcessDeployment | undefined;
  try {
    const socketPath = join(directory, 'w.sock'), storageDir = join(directory, 'operator-store');
    const key = randomBytes(32), keyFile = join(directory, 'w.key'), configFile = join(directory, 'w.json');
    writeFileSync(keyFile, key, { mode: 0o600 });
    const repositoryId = 'external-witness-repository', deploymentId = 'external-witness-deployment',
      clockDomain = 'external-witness-clock/1';
    const namespaces = [
      { kind: 'effect-scope', authorityId: 'effect-operator', repositoryId, catalogDeploymentId: deploymentId, clockDomain },
      { kind: 'host-scope', authorityId: 'host-operator', repositoryId, deploymentId },
      { kind: 'deployment', authorityId: 'deployment-operator', repositoryId, deploymentId },
    ];
    writeFileSync(configFile, encodeCanonical({ socketPath, storageDir, keyFile, namespaces }), { mode: 0o600 });
    server = await launch(configFile);
    const symbols = new SymbolSpace('external-witness-v9'), entry = symbols.define('entry'), x = symbols.define('x');
    const CAP = capability('cap:test:external_witness'), registry = new CapabilityRegistry();
    registry.define({ name: CAP, domain: 'test', operation: 'external_witness', arity: 1,
      description: 'read-only isolated guest', effectful: true });
    const module = b.module_({ symbol: symbols.define('module'), symbolTable: symbols.table(), members: [
      b.fn({ symbol: entry, params: [b.param(x, b.Int)], returns: b.Int, capabilities: [CAP], purity: 'effectful',
        contract: b.contract({}), body: b.block(b.exprStmt(b.invoke(CAP, b.v(x))), b.ret(b.v(x))) }) ] });
    const adapter = admitWasmAdapterBytes(wasm, wasmAdapterArtifactForBytes(wasm, CAP,
      'external-witness/1', { maxMemoryPages: 1, timeoutMs: 1000 }));
    const grants = new ScopedGrantAuthority({ key: new Uint8Array(32).fill(83), repositoryId, clock: () => 100,
      policyEpoch: () => '0', revocationEpoch: () => '0', isRevoked: () => false,
      authorizeIssue: () => true, authorizeDelegate: () => true });
    const policy: EffectResourcePolicyBodyV4 = { format: 'aether.effect-resource-policy/4', repositoryId,
      astRoot: new GraphStore().intern(module), policyEpoch: '0', rules: [{ capability: CAP, prefix: ['wasm'],
        argument: null, deadline: '1000', clockDomain, adapterId: adapter.id,
        adapterDigest: effectAdapterDigest(adapter), adapterArtifactDigest: admittedAdapterArtifactDigest(adapter)! }] };
    const digest = (name: string) => domainDigest('aether.external-witness-test/1', name);
    const context: EvidenceContext = { module, registry, specification: 'External witness restart test',
      semanticsVersion: 'reference/1', compilerDigest: digest('compiler'),
      capabilityPolicyDigest: effectResourcePolicyDigestV4(policy),
      target: { abiVersion: 'process/1', profileDigest: digest('profile'), artifactDigest: digest('artifact') },
      policy: { ...DEFAULT_EVIDENCE_POLICY_V2, requireFormal: false } };
    const evidence = mintLocalEvidence(context), manifest = evidence.manifest;
    const keys = generateKeyPairSync('ed25519');
    const signer = createEffectSignerAnchor({ repositoryId, signer: 'external-witness-policy',
      epochAuthorityId: 'external-witness-epoch', publicKey: keys.publicKey, currentEpoch: () => '0' });
    const clock = createTrustedClockAnchor({ authorityId: 'external-clock-operator', clockDomain,
      nowMs: () => 100, revision: () => '0' });
    const signedPolicy = signEffectResourcePolicyV4(policy, signer.signer, keys.privateKey);
    const plan: TopologyPlan = { shape: 'containers', units: [{ id: 'worker', members: [entry],
      capabilities: [CAP], placement: 'container', memoryMb: 16 }], crossEdges: [],
      transportLatencyMsPerSecond: 0, monthlyCost: 0, recombinations: [], blockedMerges: [] };
    const effectNamespace = { authorityId: 'effect-operator', repositoryId, deploymentId, clockDomain };
    const hostNamespace = { authorityId: 'host-operator', repositoryId, deploymentId };
    const client = createProcessWitnessClient({ socketPath, key, timeoutMs: 10_000 });
    const routerFactory = (catalog: NamespacedEffectJournalWitnessCatalog): NonNullable<ProcessHostOptions['effectRouterFactory']> => effect => {
      const path = join(directory, 'effects', digest(effect.operationId).split(':').at(-1)!);
      const witness = selectEffectJournalWitness(catalog, effect.operationId);
      const live = new DurableEffectBroker({ directory: path, clockDomain: effect.clockDomain!,
        clock: () => 100n, authorize: () => true, authorizeReconciliation: () => true, witness });
      const broker = effect.mode === 'live' ? live : new DurableEffectBroker({ directory: path,
        mode: 'replay', clockDomain: effect.clockDomain!, clock: () => 100n, authorize: () => false,
        replayEvents: live.events(), witness });
      return new BrokerEffectRouter({ broker, manifest: effect.manifest, executionId: effect.operationId,
        policyEpoch: effect.policyEpoch!, deadline: effect.deadline!, adapters: new Map([[CAP, adapter]]),
        grantRef: effect.grantRef!, grant: () => { throw new Error('unexpected grant callback'); } });
    };
    const makeOptions = (catalog: NamespacedEffectJournalWitnessCatalog,
      hostWitness: ReturnType<typeof selectHostJournalWitness>): ProcessHostOptions => ({
      directory: join(directory, 'host'), module, manifest, plan, registry,
      sealer: new CapabilitySealer(new Uint8Array(32).fill(84), () => 100), scopedGrants: grants,
      effectSignerAnchor: signer, trustedClockAnchor: clock, effectJournalWitnessCatalog: catalog,
      hostJournalWitness: hostWitness, anchoredEffectPolicyProfile: 'isolated-wasm-v7-host-witness',
      signedEffectResourcePolicy: signedPolicy, authorizeRecovery: () => true,
      effectRouterFactory: routerFactory(catalog),
    });
    const catalog = client.effectCatalog(effectNamespace), hostCatalog = client.hostCatalog(hostNamespace);
    host = await ProcessHost.open(makeOptions(catalog, selectHostJournalWitness(hostCatalog, 'direct-host')));
    const tokens = () => host!.issueScopedTokens(entry, 60_000, new Map([[CAP, ['wasm']]]));
    const first = await host.call(entry, [{ tag: 'int', value: '7' }], { operationId: 'external-v9', tokens: tokens() });
    assert.equal(first.state, 'completed');
    const recorded = JSON.parse(readFileSync(join(directory, 'host', 'host.json'), 'utf8'));
    const effectId = recorded.calls.find((call: { operationId: string }) => call.operationId === 'external-v9').effects[0].id as string;
    const brokerBefore = readWitnessHead(selectEffectJournalWitness(catalog, effectId));
    await kill(server); server = undefined;
    assert.throws(() => host!.operationResult('external-v9'), /uncertain witness response|witness/);
    await host.close(); host = undefined;
    server = await launch(configFile);
    const resumed = createProcessWitnessClient({ socketPath, key, timeoutMs: 10_000 });
    const resumedCatalog = resumed.effectCatalog(effectNamespace), resumedHostCatalog = resumed.hostCatalog(hostNamespace);
    host = await ProcessHost.open(makeOptions(resumedCatalog,
      selectHostJournalWitness(resumedHostCatalog, 'direct-host')));
    assert.deepEqual(host.operationResult('external-v9'), first);
    const replay = await host.call(entry, [{ tag: 'int', value: '7' }],
      { operationId: 'external-v9', tokens: tokens() });
    assert.deepEqual(replay, first);
    assert.deepEqual(readWitnessHead(selectEffectJournalWitness(resumedCatalog, effectId)), brokerBefore,
      'cached call did not redispatch the guest effect after service restart');
    await host.close(); host = undefined;

    const governor = generateKeyPairSync('ed25519');
    const coordinator = new PromotionCoordinator({ profile: 'baseline-governor-v1',
      directory: join(directory, 'coordinator'), repositoryId,
      genesisManifest: executionManifestDigest(manifest),
      authority: () => ({ repositoryId, membershipEpoch: '1', policyEpoch: '1', eligibleGovernors: ['governor'] }),
      governorKey: () => governor.publicKey, clock: () => 100n });
    const deploymentOptions = (witnessClient: ReturnType<typeof createProcessWitnessClient>,
      effectCatalog: NamespacedEffectJournalWitnessCatalog): ProcessDeploymentOptions => ({
      directory: join(directory, 'deployment'), coordinator, capabilityProfile: 'scoped-anchored-wasm-v9',
      effectSignerAnchor: signer, trustedClockAnchor: clock, effectJournalWitnessCatalog: effectCatalog,
      hostJournalWitnessCatalog: witnessClient.hostCatalog(hostNamespace),
      deploymentJournalWitness: witnessClient.deploymentWitness({ authorityId: 'deployment-operator',
        repositoryId, deploymentId }),
      factories: new Map([['external-services/1', () => ({
        sealer: new CapabilitySealer(new Uint8Array(32).fill(84), () => 100), scopedGrants: grants,
        signedEffectResourcePolicy: signedPolicy, effectRouterFactory: routerFactory(effectCatalog),
        authorizeRecovery: () => true,
      })]]),
      genesis: { context, evidence, plan, factoryId: 'external-services/1' },
    });
    deployment = await ProcessDeployment.open(deploymentOptions(resumed, resumedCatalog));
    const deployedTokens = () => deployment!.issueScopedTokens(entry, 60_000, new Map([[CAP, ['wasm']]]));
    const deployed = await deployment.call(entry, [{ tag: 'int', value: '8' }],
      { operationId: 'external-deployed-v9', tokens: deployedTokens() });
    assert.equal(deployed.state, 'completed');
    const deployedJournal = JSON.parse(readFileSync(join(directory, 'deployment', 'deployments', 'genesis', 'host', 'host.json'), 'utf8'));
    const deployedEffectId = deployedJournal.calls.find((call: { operationId: string }) =>
      call.operationId === 'external-deployed-v9').effects[0].id as string;
    const deployedBrokerBefore = readWitnessHead(selectEffectJournalWitness(resumedCatalog, deployedEffectId));
    await kill(server); server = undefined;
    assert.throws(() => deployment!.status(), /uncertain witness response|witness/);
    await deployment.close(); deployment = undefined;
    server = await launch(configFile);
    const restoredClient = createProcessWitnessClient({ socketPath, key, timeoutMs: 10_000 });
    const restoredCatalog = restoredClient.effectCatalog(effectNamespace);
    deployment = await ProcessDeployment.open({ ...deploymentOptions(restoredClient, restoredCatalog), genesis: undefined });
    assert.equal(deployment.status().generation, '0');
    const cached = await deployment.call(entry, [{ tag: 'int', value: '8' }],
      { operationId: 'external-deployed-v9', tokens: deployedTokens() });
    assert.deepEqual(cached, deployed);
    assert.deepEqual(readWitnessHead(selectEffectJournalWitness(restoredCatalog, deployedEffectId)), deployedBrokerBefore,
      'deployment cached receipt did not redispatch after service restart');
  } finally {
    await deployment?.close(); await host?.close(); if (server) await kill(server);
    rmSync(directory, { recursive: true, force: true });
  }
});
