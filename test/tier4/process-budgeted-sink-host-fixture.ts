import { spawn, type ChildProcess } from 'node:child_process';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
import { effectResourcePolicyDigestV6, signEffectResourcePolicyV6,
  type EffectResourcePolicyBodyV6 } from '../../src/tier2/effect-resource-policy.ts';
import { ResourceBudgetLedger, RESOURCE_BUDGET_PROFILE,
  type ResourceAmounts } from '../../src/tier2/resource-budget.ts';
import { ResourceBudgetBridge, type ResourceBudgetBridgeProfile } from '../../src/tier2/resource-budget-bridge.ts';
import { attestedSinkBudgetEvidencePolicyDigest, createAttestedSinkBudgetEvidence,
  type AttestedSinkBudgetEvidence } from '../../src/tier2/attested-sink-budget-evidence.ts';
import { BudgetedSinkAuthority, budgetedSinkGrantRefV3 } from '../../src/tier2/budgeted-sink-authority.ts';
import { DEFAULT_EVIDENCE_POLICY_V2, mintLocalEvidence, type EvidenceContext } from '../../src/fabric/evidence.ts';
import { encodeCanonical, type TaggedValueV1 } from '../../src/fabric/encoding.ts';
import { domainDigest, executionManifestDigest } from '../../src/fabric/identity.ts';
import { DurableEffectBroker, effectAdapterDigest, effectPayloadDigest, type EffectRequestV1 } from '../../src/fabric/effects.ts';
import { createAttestedSinkClient } from '../../src/fabric/attested-sink-service.ts';
import { createAttestedSinkAdapter } from '../../src/fabric/attested-sink-adapter.ts';
import { createProcessWitnessClient } from '../../src/fabric/witness-service.ts';
import { selectEffectJournalWitness } from '../../src/fabric/effect-journal-witness.ts';
import { selectHostJournalWitness } from '../../src/fabric/host-journal-witness.ts';
import type { SinkPublicAnchorV1 } from '../../src/fabric/sink-receipt.ts';
import type { RuntimeSnapshotV1 } from '../../src/fabric/snapshot.ts';
import { BrokerEffectRouter } from '../../src/tier3/effects.ts';
import { processExecutionId, type ProcessHostOptions } from '../../src/tier4/process-host.ts';
import { processBoundaryId } from '../../src/tier4/process-values.ts';
import type { TopologyPlan } from '../../src/tier4/topology.ts';

const root = resolve(import.meta.dirname, '../..');
const amount = (value: number): ResourceAmounts => ({ usdMicros: String(value),
  tokens: String(value), nanoseconds: String(value), memoryBytes: String(value) });
async function launch(script: string, config: string, ready: string): Promise<ChildProcess> {
  const child = spawn(process.execPath, ['--experimental-strip-types', join(root, 'src/fabric', script),
    '--config', config], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  return new Promise((resolveReady, reject) => {
    let stderr = '';
    const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`service startup timeout: ${stderr}`)); }, 8000);
    child.stderr!.on('data', chunk => { stderr += String(chunk); });
    child.stdout!.on('data', chunk => { if (String(chunk).includes(ready)) {
      clearTimeout(timeout); resolveReady(child);
    } });
    child.once('exit', code => { clearTimeout(timeout); reject(new Error(`service exit ${code}: ${stderr}`)); });
  });
}
async function kill(child: ChildProcess | null): Promise<void> {
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL'); await once(child, 'exit');
  }
}

export async function budgetedSinkHostFixture(): Promise<{
  readonly entry: ReturnType<SymbolSpace['define']>;
  readonly capability: ReturnType<typeof capability>;
  readonly request: EffectRequestV1;
  readonly fencedRequest: EffectRequestV1;
  readonly options: ProcessHostOptions;
  readonly ledger: ResourceBudgetLedger;
  readonly bridge: ResourceBudgetBridge;
  readonly authority: BudgetedSinkAuthority;
  readonly sinkWitness: ReturnType<ReturnType<typeof createProcessWitnessClient>['sinkStateWitness']>;
  readonly effectWitness: ReturnType<typeof selectEffectJournalWitness>;
  readonly sinkClient: ReturnType<typeof createAttestedSinkClient>;
  readonly directory: string;
  readonly stopSinkWitness: () => Promise<void>;
  readonly cleanup: () => Promise<void>;
}> {
  const directory = mkdtempSync(join(tmpdir(), 'aether-v12-budget-host-'));
  let sinkProcess: ChildProcess | null = null, sinkWitnessProcess: ChildProcess | null = null,
    operatorProcess: ChildProcess | null = null;
  try {
    const repositoryId = 'repo:v12-budget-host', deploymentId = 'deployment:v12-budget-host',
      clockDomain = 'clock:v12-budget-host', operationId = 'call:alice',
      heapId = 'heap:v12-budget-host', owner = 'owner:v12-budget-host';
    const symbols = new SymbolSpace('v12-budget-host'), entry = symbols.define('entry'),
      target = symbols.define('target'), CAP = capability('cap:test:v12_sink');
    const module = b.module_({ symbol: symbols.define('module'), symbolTable: symbols.table(), members: [
      b.fn({ symbol: entry, params: [b.param(target, b.Str)], returns: b.Str,
        capabilities: [CAP], purity: 'effectful', contract: b.contract({}),
        body: b.block(b.exprStmt(b.invoke(CAP, b.v(target))), b.ret(b.v(target))) }),
    ] });
    const registry = new CapabilityRegistry();
    registry.define({ name: CAP, domain: 'test', operation: 'v12_sink', arity: 1,
      description: 'budgeted signed sink', effectful: true });
    const plan: TopologyPlan = { shape: 'containers', units: [{ id: 'worker', members: [entry],
      capabilities: [CAP], placement: 'container', memoryMb: 16 }], crossEdges: [],
      transportLatencyMsPerSecond: 0, monthlyCost: 0, recombinations: [], blockedMerges: [] };
    const sinkKeys = generateKeyPairSync('ed25519'), policyKeys = generateKeyPairSync('ed25519'),
      budgetKeys = generateKeyPairSync('ed25519');
    const anchor: SinkPublicAnchorV1 = { format: 'aether.sink-anchor/1', repositoryId,
      sinkAuthorityId: 'authority:v12-budget-host', sinkId: 'sink:v12-budget-host',
      keyId: 'key:v12-budget-host', keyEpoch: '1',
      publicKey: sinkKeys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64') };
    const adapterArtifactDigest = domainDigest('aether.effect-adapter-artifact/2', 'v12-budget-host-fixture');
    const sinkSocket = join(directory, 'sink.sock'), sinkWitnessSocket = join(directory, 'sink-witness.sock'),
      operatorSocket = join(directory, 'operator.sock');
    const sinkKey = randomBytes(32), sinkWitnessKey = randomBytes(32), operatorKey = randomBytes(32);
    const sinkKeyFile = join(directory, 'sink.key'), sinkWitnessKeyFile = join(directory, 'sink-witness.key'),
      operatorKeyFile = join(directory, 'operator.key'), sinkSignerFile = join(directory, 'sink.pem');
    const sinkConfig = join(directory, 'sink.json'), sinkWitnessConfig = join(directory, 'sink-witness.json'),
      operatorConfig = join(directory, 'operator.json');
    writeFileSync(sinkKeyFile, sinkKey, { mode: 0o600 });
    writeFileSync(sinkWitnessKeyFile, sinkWitnessKey, { mode: 0o600 });
    writeFileSync(operatorKeyFile, operatorKey, { mode: 0o600 });
    writeFileSync(sinkSignerFile, sinkKeys.privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
    writeFileSync(sinkWitnessConfig, encodeCanonical({ socketPath: sinkWitnessSocket,
      storageDir: join(directory, 'sink-witness-store'), keyFile: sinkWitnessKeyFile,
      namespaces: [{ kind: 'sink-scope', authorityId: 'operator:sink-state',
        anchor, adapterArtifactDigest }] }), { mode: 0o600 });
    writeFileSync(operatorConfig, encodeCanonical({ socketPath: operatorSocket,
      storageDir: join(directory, 'operator-store'), keyFile: operatorKeyFile,
      namespaces: [
        { kind: 'effect-scope', authorityId: 'operator:effect', repositoryId,
          catalogDeploymentId: deploymentId, clockDomain },
        { kind: 'host-scope', authorityId: 'operator:host', repositoryId, deploymentId },
        { kind: 'budget', authorityId: 'operator:budget-ledger', repositoryId, deploymentId,
          journalKind: 'ledger', journalId: 'ledger:v12-budget-host' },
        { kind: 'budget', authorityId: 'operator:budget-bridge', repositoryId, deploymentId,
          journalKind: 'bridge', journalId: 'bridge:v12-budget-host' },
      ] }), { mode: 0o600 });
    writeFileSync(sinkConfig, encodeCanonical({ format: 'aether.attested-sink-config/2',
      socketPath: sinkSocket, storageDir: join(directory, 'sink-store'), authKeyFile: sinkKeyFile,
      signingKeyFile: sinkSignerFile, anchor, adapterArtifactDigest,
      witnessSocketPath: sinkWitnessSocket, witnessKeyFile: sinkWitnessKeyFile,
      witnessAuthorityId: 'operator:sink-state' }), { mode: 0o600 });
    sinkWitnessProcess = await launch('witness-service-cli.ts', sinkWitnessConfig, 'witness service ready');
    operatorProcess = await launch('witness-service-cli.ts', operatorConfig, 'witness service ready');
    sinkProcess = await launch('attested-sink-service-cli.ts', sinkConfig, 'attested sink service ready');
    const sinkWitness = createProcessWitnessClient({ socketPath: sinkWitnessSocket, key: sinkWitnessKey })
      .sinkStateWitness({ authorityId: 'operator:sink-state', anchor, adapterArtifactDigest });
    const operator = createProcessWitnessClient({ socketPath: operatorSocket, key: operatorKey, timeoutMs: 10_000 });
    const catalog = operator.effectCatalog({ authorityId: 'operator:effect', repositoryId,
      deploymentId, clockDomain });
    const hostWitness = selectHostJournalWitness(operator.hostCatalog({ authorityId: 'operator:host',
      repositoryId, deploymentId }), 'host:direct');
    const ledgerWitness = operator.budgetJournalWitness({ authorityId: 'operator:budget-ledger',
      repositoryId, deploymentId, journalKind: 'ledger', journalId: 'ledger:v12-budget-host' });
    const bridgeWitness = operator.budgetJournalWitness({ authorityId: 'operator:budget-bridge',
      repositoryId, deploymentId, journalKind: 'bridge', journalId: 'bridge:v12-budget-host' });
    const sinkClient = createAttestedSinkClient({ socketPath: sinkSocket, authKey: sinkKey,
      anchor, adapterArtifactDigest, repositoryId, deploymentId, timeoutMs: 5000 });
    const adapter = createAttestedSinkAdapter({ id: 'adapter:v12-budget-host', client: sinkClient,
      repositoryId, deploymentId, approvedAdapterArtifactDigest: adapterArtifactDigest, anchor });
    const policy: EffectResourcePolicyBodyV6 = { format: 'aether.effect-resource-policy/6',
      repositoryId, astRoot: new GraphStore().intern(module), policyEpoch: '1', rules: [{
        capability: CAP, prefix: ['account'], argument: 0, adapterId: adapter.id,
        adapterDigest: effectAdapterDigest(adapter), adapterArtifactDigest, deadline: '1000',
        clockDomain, deploymentId, sinkAnchorDigest: domainDigest('aether.sink-anchor/1', anchor),
        sinkStateWitnessDigest: sinkWitness.digest,
      }] };
    const digest = (label: string) => domainDigest('aether.v12-budget-host-fixture/1', label);
    const context: EvidenceContext = { module, registry, specification: 'V12 budgeted signed sink host',
      semanticsVersion: 'reference/1', compilerDigest: digest('compiler'),
      capabilityPolicyDigest: effectResourcePolicyDigestV6(policy),
      target: { abiVersion: 'process/1', profileDigest: digest('profile'),
        artifactDigest: digest('artifact') },
      policy: { ...DEFAULT_EVIDENCE_POLICY_V2, requireFormal: false } };
    const manifest = mintLocalEvidence(context).manifest;
    const signed = signEffectResourcePolicyV6(policy, 'signer:v12-budget-host', policyKeys.privateKey);
    const signer = createEffectSignerAnchor({ repositoryId, signer: signed.signer,
      epochAuthorityId: 'epoch:v12-budget-host', publicKey: policyKeys.publicKey,
      currentEpoch: () => '1' });
    const clock = createTrustedClockAnchor({ authorityId: 'clock:v12-budget-host',
      clockDomain, nowMs: () => 100, revision: () => '0' });
    const grants = new ScopedGrantAuthority({ key: new Uint8Array(32).fill(103), repositoryId,
      clock: () => 100, policyEpoch: () => '1', revocationEpoch: () => '0',
      isRevoked: () => false, authorizeIssue: () => true, authorizeDelegate: () => true });
    const initialSnapshot: RuntimeSnapshotV1 = { format: 'aether.state/1',
      executionManifest: executionManifestDigest(manifest), heapId, nextObjectId: '1',
      eventCursor: '0', records: [], ownership: [] };
    const selectedRequest = (callId: string, targetName: string): EffectRequestV1 => {
      const effectId = processBoundaryId(processExecutionId(heapId, callId), 'effect', 0);
      const reservationId = `grant:${targetName}`;
      const grantRef = budgetedSinkGrantRefV3({ repositoryId, deploymentId,
        hostJournalWitnessDigest: hostWitness.digest, executionManifest: executionManifestDigest(manifest),
        signedEffectPolicyDigest: effectResourcePolicyDigestV6(policy),
        sinkAnchorDigest: domainDigest('aether.sink-anchor/1', anchor),
        sinkStateWitnessDigest: sinkWitness.digest, approvedAdapterArtifactDigest: adapterArtifactDigest,
        generation: '1', unit: 'worker', operationId: effectId, effectId: 'operation-0',
        capability: CAP, policyEpoch: '1', reservationId, resourcePath: ['account', targetName] });
      const payload: TaggedValueV1 = { tag: 'sequence', items: [
        { tag: 'string', value: CAP }, { tag: 'string', value: targetName },
      ] };
      return { format: 'aether.effect/1', executionId: effectId,
        effectId: 'operation-0', branchId: null, executionManifest: executionManifestDigest(manifest),
        capabilityGrantRef: grantRef, policyEpoch: '1', payloadDigest: effectPayloadDigest(payload),
        payload, budgetReservationId: reservationId, deadline: '1000' };
    };
    const request = selectedRequest(operationId, 'alice');
    const fencedRequest = selectedRequest('call:bob', 'bob');
    const expectedRequests = [request, fencedRequest];
    const policyDigest = attestedSinkBudgetEvidencePolicyDigest({ witness: sinkWitness,
      anchor, repositoryId, deploymentId, approvedAdapterArtifactDigest: adapterArtifactDigest,
      owner, charge: amount(7), expectedRequests });
    let evidence!: AttestedSinkBudgetEvidence;
    const ledger = new ResourceBudgetLedger({ directory: join(directory, 'ledger'),
      profile: { format: RESOURCE_BUDGET_PROFILE, ledgerId: 'ledger:v12-budget-host',
        policyEpoch: '1', initialOwner: owner, initial: amount(20), maxOperations: 100 },
      key: budgetKeys.privateKey, journalWitness: ledgerWitness, authorize: () => true,
      revalidateSettlementOnRead: true, settlementEvidencePolicyDigest: policyDigest,
      verifySettlement: settlement => evidence.verifySettlement(settlement) });
    evidence = createAttestedSinkBudgetEvidence({ witness: sinkWitness, anchor,
      repositoryId, deploymentId, approvedAdapterArtifactDigest: adapterArtifactDigest,
      ledgerDigest: ledger.ledgerDigest, owner, charge: amount(7), expectedRequests });
    const split = ledger.apply({ format: 'aether.resource-operation/1',
      operationId: 'split:v12-budget-host', actor: owner,
      operation: { kind: 'split', handle: ledger.genesisHandle(owner),
        parts: [amount(10), amount(10)] } });
    if (split.status !== 'applied' || split.handles.length !== 2)
      throw new Error('operator budget split failed');
    const budgetProfile: ResourceBudgetBridgeProfile = { format: 'aether.resource-budget-bridge/1',
      bridgeId: 'bridge:v12-budget-host', actor: owner, brokerAuthority: 'operator:effect',
      grants: split.handles.map((handle, index) => ({ id: index === 0 ? 'grant:alice' : 'grant:bob',
        handle, executionManifest: executionManifestDigest(manifest), policyEpoch: '1' })) };
    let broker!: DurableEffectBroker;
    const bridge = new ResourceBudgetBridge({ directory: join(directory, 'bridge'),
      profile: budgetProfile, ledger, key: budgetKeys.privateKey, journalWitness: bridgeWitness,
      mode: () => broker.executionMode, authorize: () => true, observe: evidence.observe });
    const authority = new BudgetedSinkAuthority({ repositoryId, deploymentId, anchor,
      sinkStateWitness: sinkWitness, approvedAdapterArtifactDigest: adapterArtifactDigest,
      owner, charge: amount(7), expectedRequests, bridge });
    const factory: NonNullable<ProcessHostOptions['effectRouterFactory']> = effect => {
      const effectWitness = selectEffectJournalWitness(catalog, effect.operationId);
      broker = new DurableEffectBroker({ directory: join(directory, 'effect-brokers',
        domainDigest('aether.v12-budget-broker-path/1', effect.operationId).split(':').at(-1)!),
        clockDomain, clock: () => 100n, authorize: () => true,
        authorizeReconciliation: () => true, witness: effectWitness,
        attestedSinkV4: { anchor, deploymentId,
          approvedAdapterArtifactDigest: adapterArtifactDigest, sinkStateWitness: sinkWitness },
        ...(effect.budgetReservationId ? { attestedSinkBudgetV1: {
          format: 'aether.attested-sink-budget-broker/1' as const,
          bridge, bridgeProfileDigest: bridge.profileDigest } } : {}) });
      return new BrokerEffectRouter({ broker, manifest: effect.manifest,
        executionId: effect.operationId, policyEpoch: effect.policyEpoch!,
        deadline: effect.deadline!, adapters: new Map([[CAP, adapter]]),
        grantRef: effect.grantRef!, budgetReservationId: effect.budgetReservationId,
        grant: () => { throw new Error('factory grant callback forbidden'); } });
    };
    const options: ProcessHostOptions = { directory: join(directory, 'host'), module, manifest, plan,
      registry, sealer: new CapabilitySealer(new Uint8Array(32).fill(104), () => 100),
      scopedGrants: grants, effectSignerAnchor: signer, trustedClockAnchor: clock,
      effectJournalWitnessCatalog: catalog, hostJournalWitness: hostWitness,
      attestedSinkAuthority: { repositoryId, deploymentId,
        approvedAdapterArtifactDigest: adapterArtifactDigest, anchor }, sinkStateWitness: sinkWitness,
      budgetedSinkAuthority: authority,
      anchoredEffectPolicyProfile: 'attested-sink-v10-budget-witness',
      signedEffectResourcePolicy: signed, initialSnapshot,
      authorizeRecovery: () => true, effectRouterFactory: factory };
    return { entry, capability: CAP, request, fencedRequest, options, ledger, bridge, authority,
      sinkWitness, effectWitness: selectEffectJournalWitness(catalog, request.executionId),
      sinkClient, directory,
      async stopSinkWitness() { await kill(sinkWitnessProcess); sinkWitnessProcess = null; },
      async cleanup() { await kill(sinkProcess); await kill(sinkWitnessProcess);
        await kill(operatorProcess); rmSync(directory, { recursive: true, force: true }); } };
  } catch (error) {
    await kill(sinkProcess); await kill(sinkWitnessProcess);
    await kill(operatorProcess); rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}
