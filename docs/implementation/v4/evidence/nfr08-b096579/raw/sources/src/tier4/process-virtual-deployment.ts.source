/** One-way, governor-driven pure Artifact/4 deployment. The source runs in a
 * local pure ProcessHost; the promoted target runs in witnessed config/17.
 * Legacy Artifact/1–2 ProcessDeployment and its journals are untouched. */
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { decode as decodeIR } from '../tier1/agent-ir.ts';
import { atomicWrite } from '../tier1/persistence.ts';
import type { SymbolId } from '../tier1/ids.ts';
import { CapabilityRegistry, CapabilitySealer, type CapabilityToken } from '../tier2/ocap.ts';
import { decodeCanonical, encodeCanonical, identifier, validateTaggedValue,
  type TaggedValueV1 } from '../fabric/encoding.ts';
import { domainDigest, executionManifestDigest, type Digest } from '../fabric/identity.ts';
import { JournalLock } from '../fabric/journal-lock.ts';
import { selectHostJournalWitness, readHostJournalHead, assertHostJournalWitnessCatalog,
  type HostJournalWitnessCatalog } from '../fabric/host-journal-witness.ts';
import { createPromotionHandle, PromotionCoordinator, type PreparedPromotionHandleV1,
  type PromotionBindingV1, type PromotionDriver,
  type PromotionInput, type ProductionAdmissionState } from '../fabric/promotion.ts';
import { validateVettedEvidence, type VettedEvidence } from '../fabric/evidence.ts';
import { runtimeSnapshotDigest, type RuntimeSnapshotV1 } from '../fabric/snapshot.ts';
import { ProcessHost, type ProcessHostCallResult, type ProcessHostOptions,
  type ProcessVirtualSourceHeadV1 } from './process-host.ts';
import { validateProcessArguments } from './process-type-validation.ts';
import { validateProcessVirtualArtifactV4, processVirtualArtifactDigestV4,
  type ProcessVirtualArtifactV4 } from './process-virtual-artifact-v4.ts';
import { openProcessVirtualWorkerLineageV1,
  type ProcessVirtualWorkerTrustV1 } from './process-virtual-worker-contract.ts';
import { assertPureVirtualPlanV1, preparePureVirtualPromotionV2,
  requireWitnessedPureVirtualPreparedV2,
  pureVirtualPreparedDigestV2, PureVirtualPreparedStoreV1,
  type PureVirtualPreparedV2 } from './process-virtual-deployment-contract.ts';
import { assertPureVirtualDeploymentWitnessV1, PureVirtualDeploymentJournalStoreV1,
  pureVirtualInvocationDigestV2, type PureVirtualDeploymentJournalV3,
  type PureVirtualDeploymentWitnessV1, type PureVirtualInvocationV2 } from './process-virtual-deployment-journal.ts';
import type { TopologyPlan } from './topology.ts';

const LIMITS = { maxFrameBytes: 16 * 1024 * 1024, maxDecompressedBytes: 16 * 1024 * 1024,
  maxObjects: 500_000, maxDepth: 128 };
const same = (a: unknown, b: unknown): boolean =>
  Buffer.from(encodeCanonical(a, LIMITS)).equals(Buffer.from(encodeCanonical(b, LIMITS)));
const clone = <T>(value: T): T => decodeCanonical(encodeCanonical(value, LIMITS), LIMITS) as T;
const suffix = (digest: Digest): string => digest.split(':').at(-1)!;
function ensureDurableDirectory(path: string): void {
  if (existsSync(path)) return;
  ensureDurableDirectory(dirname(path));
  try { mkdirSync(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  for (const directory of [path, dirname(path)]) {
    const fd = openSync(directory, 'r');
    try { fsyncSync(fd); } finally { closeSync(fd); }
  }
}

export interface PureVirtualProcessDeploymentOptions {
  readonly directory: string;
  readonly coordinator: PromotionCoordinator;
  readonly artifact: ProcessVirtualArtifactV4;
  readonly trust: ProcessVirtualWorkerTrustV1;
  readonly sourcePlan: TopologyPlan;
  readonly candidatePlan: TopologyPlan;
  readonly sealer: CapabilitySealer;
  readonly hostWitnessCatalog: HostJournalWitnessCatalog;
  readonly deploymentWitness: PureVirtualDeploymentWitnessV1;
  readonly authorizeRecovery: NonNullable<ProcessHostOptions['authorizeRecovery']>;
  /** Stable operator-selected identity for the live recovery policy. Its
   * callback may consult changing epoch/revocation state across restarts. */
  readonly recoveryAuthorityId: string;
  readonly sourceInitialSnapshot?: RuntimeSnapshotV1;
  readonly timeoutMs?: number;
  readonly lockWaitMs?: number;
  readonly onPhase?: (phase: 'prepared' | 'before-activation' | 'activated' | 'aborted',
    detail: { proposalDigest: Digest; workerPids: Readonly<Record<string, number>> })
    => void | Promise<void>;
  readonly onHostPhase?: ProcessHostOptions['onPhase'];
}
interface Lease { proposal: Digest; release(): void; done: Promise<void> }

export class PureVirtualProcessDeployment implements PromotionDriver {
  readonly #options: PureVirtualProcessDeploymentOptions;
  readonly #store: PureVirtualDeploymentJournalStoreV1;
  readonly #prepared: PureVirtualPreparedStoreV1;
  readonly #gate: JournalLock;
  readonly #artifactFile: string;
  readonly #artifactDigest: Digest;
  readonly #sourceManifest: Digest;
  readonly #candidateManifest: Digest;
  readonly #trustDigest: Digest;
  readonly #sourcePlanDigest: Digest;
  readonly #candidatePlanDigest: Digest;
  readonly #sourceInitialSnapshotDigest: Digest | null;
  readonly #sealerIdentityDigest: Digest;
  readonly #recoveryAuthorityDigest: Digest;
  readonly #hosts = new Map<'source' | 'candidate', ProcessHost>();
  readonly #vetted = new Map<Digest, VettedEvidence>();
  #lease: Lease | null = null;
  #closed = false;

  private constructor(options: PureVirtualProcessDeploymentOptions) {
    if (!(options.coordinator instanceof PromotionCoordinator)
      || options.coordinator.admissionProfile !== 'strict-lineage-v1')
      throw new TypeError('pure Artifact/4 deployment requires strict-lineage governor');
    if (!(options.sealer instanceof CapabilitySealer)
      || typeof options.authorizeRecovery !== 'function'
      || !isAbsolute(options.directory))
      throw new TypeError('pure Artifact/4 deployment requires operator authority and absolute storage');
    identifier(options.recoveryAuthorityId);
    assertHostJournalWitnessCatalog(options.hostWitnessCatalog);
    assertPureVirtualDeploymentWitnessV1(options.deploymentWitness);
    if (options.hostWitnessCatalog.repositoryId !== options.trust.repositoryId
      || options.deploymentWitness.repositoryId !== options.trust.repositoryId
      || options.hostWitnessCatalog.deploymentId !== options.deploymentWitness.deploymentId)
      throw new TypeError('pure Artifact/4 deployment witness/trust namespace mismatch');
    // Capture each operator selection once. Do not freeze the coordinator,
    // witnesses, sealer or recovery callback: their live authority state is
    // intentionally dynamic, while caller replacement of the top-level slot
    // must never redirect an already-open deployment.
    this.#options = Object.freeze({ ...options,
      artifact: clone(options.artifact), trust: clone(options.trust),
      sourcePlan: clone(options.sourcePlan), candidatePlan: clone(options.candidatePlan),
      sourceInitialSnapshot: options.sourceInitialSnapshot
        ? clone(options.sourceInitialSnapshot) : undefined });
    options = this.#options;
    ensureDurableDirectory(options.directory);
    this.#store = new PureVirtualDeploymentJournalStoreV1(options.directory, options.deploymentWitness);
    this.#prepared = new PureVirtualPreparedStoreV1(join(options.directory, 'prepared'));
    this.#gate = new JournalLock({ directory: join(options.directory, 'deployment-lock'),
      domain: 'aether.pure-virtual-deployment-lock' });
    this.#artifactFile = join(options.directory, 'artifact4.json');
    const artifact = validateProcessVirtualArtifactV4(options.artifact,
      openProcessVirtualWorkerLineageV1(options.trust));
    this.#candidatePlanDigest = assertPureVirtualPlanV1(options.candidatePlan, artifact);
    const source = decodeIR(artifact.sourceIr);
    if (source.kind !== 'Module' || options.sourcePlan.units.length !== 1
      || options.sourcePlan.crossEdges.length !== 0
      || options.sourcePlan.units[0].capabilities.length !== 0
      || !same([...options.sourcePlan.units[0].members].sort(),
        source.members.filter(member => member.kind === 'FunctionDecl').map(member => member.symbol).sort()))
      throw new TypeError('pure Artifact/4 source requires one complete no-effects unit');
    this.#sourcePlanDigest = domainDigest('aether.process-virtual-source-plan/1',
      options.sourcePlan, LIMITS);
    this.#sourceInitialSnapshotDigest = options.sourceInitialSnapshot
      ? runtimeSnapshotDigest(options.sourceInitialSnapshot) : null;
    this.#sealerIdentityDigest = domainDigest('aether.process-virtual-sealer-identity/1',
      CapabilitySealer.prototype.keyCommitment.call(options.sealer));
    this.#recoveryAuthorityDigest = domainDigest('aether.process-virtual-recovery-authority/1',
      { repositoryId: options.trust.repositoryId,
        deploymentId: options.deploymentWitness.deploymentId,
        authorityId: options.recoveryAuthorityId });
    this.#artifactDigest = processVirtualArtifactDigestV4(artifact);
    this.#sourceManifest = executionManifestDigest(artifact.sourceEvidence.manifest);
    this.#candidateManifest = executionManifestDigest(artifact.candidateEvidence.manifest);
    this.#trustDigest = domainDigest('aether.process-virtual-worker-trust/1', options.trust, LIMITS);
    if (existsSync(this.#artifactFile)) {
      if (statSync(this.#artifactFile).size > LIMITS.maxFrameBytes)
        throw new RangeError('pure virtual artifact registry exceeds bound');
      const bytes = readFileSync(this.#artifactFile);
      const persisted = decodeCanonical(bytes, LIMITS);
      if (!Buffer.from(encodeCanonical(persisted, LIMITS)).equals(bytes))
        throw new TypeError('noncanonical pure Artifact/4 registry');
      if (!same(persisted, artifact)) throw new TypeError('pure Artifact/4 registry changed');
    } else {
      atomicWrite(this.#artifactFile, Buffer.from(encodeCanonical(artifact, LIMITS)).toString('utf8'));
      const fd = openSync(options.directory, 'r');
      try { fsyncSync(fd); } finally { closeSync(fd); }
    }
  }

  static async open(options: PureVirtualProcessDeploymentOptions): Promise<PureVirtualProcessDeployment> {
    const deployment = new PureVirtualProcessDeployment(options);
    options = deployment.#options;
    try {
      deployment.#gate.recoverDeadWriter(false);
      let state = deployment.#store.read();
      if (state === null) {
        const governor = options.coordinator.state();
        if (governor.generation !== '0' || governor.committedManifest !== deployment.#sourceManifest
          || governor.pendingProposal !== null)
          throw new Error('virtual deployment genesis differs from strict governor');
        state = deployment.#store.write('0', {
          format: 'aether.process-virtual-deployment/3', witnessRevision: '1',
          witnessDigest: options.deploymentWitness.digest,
          repositoryId: options.trust.repositoryId,
          deploymentId: options.deploymentWitness.deploymentId,
          admissionProfile: 'strict-lineage-v1', genesisManifest: deployment.#sourceManifest,
          active: { manifest: deployment.#sourceManifest, generation: '0', artifactDigest: null },
          readiness: 'ready', pendingProposal: null, preparedDigest: null,
          trustDigest: deployment.#trustDigest,
          hostWitnessCatalogDigest: options.hostWitnessCatalog.digest,
          sourcePlanDigest: deployment.#sourcePlanDigest,
          candidatePlanDigest: deployment.#candidatePlanDigest,
          sourceInitialSnapshotDigest: deployment.#sourceInitialSnapshotDigest,
          sealerIdentityDigest: deployment.#sealerIdentityDigest,
          recoveryAuthorityDigest: deployment.#recoveryAuthorityDigest,
          invocations: [],
        });
      }
      deployment.#state();
      await options.coordinator.recover(deployment);
      const ready = deployment.#state();
      deployment.#assertServing(ready);
      await deployment.#activeHost(ready);
      return deployment;
    } catch (error) { await deployment.close(); throw error; }
  }

  #state(): PureVirtualDeploymentJournalV3 {
    const state = this.#store.read();
    if (state?.format === 'aether.process-virtual-deployment/2')
      throw new TypeError('pure virtual deployment /2 requires explicit /3 configuration migration');
    if (!state || state.format !== 'aether.process-virtual-deployment/3'
      || state.genesisManifest !== this.#sourceManifest
      || state.trustDigest !== this.#trustDigest
      || state.hostWitnessCatalogDigest !== this.#options.hostWitnessCatalog.digest
      || state.sourcePlanDigest !== this.#sourcePlanDigest
      || state.candidatePlanDigest !== this.#candidatePlanDigest
      || state.sourceInitialSnapshotDigest !== this.#sourceInitialSnapshotDigest
      || state.sealerIdentityDigest !== this.#sealerIdentityDigest
      || state.recoveryAuthorityDigest !== this.#recoveryAuthorityDigest
      || state.witnessDigest !== this.#options.deploymentWitness.digest)
      throw new TypeError('pure virtual deployment state/authority changed');
    return state;
  }
  #write(state: PureVirtualDeploymentJournalV3, fields: Omit<PureVirtualDeploymentJournalV3,
    'format' | 'witnessRevision' | 'witnessDigest' | 'repositoryId' | 'deploymentId'
    | 'admissionProfile' | 'genesisManifest' | 'trustDigest' | 'hostWitnessCatalogDigest'
    | 'sourcePlanDigest' | 'candidatePlanDigest' | 'sourceInitialSnapshotDigest'
    | 'sealerIdentityDigest' | 'recoveryAuthorityDigest'>):
    PureVirtualDeploymentJournalV3 {
    const next = { ...state, ...fields, witnessRevision: String(BigInt(state.witnessRevision) + 1n) };
    return this.#store.write(state.witnessRevision, next) as PureVirtualDeploymentJournalV3;
  }
  #assertServing(state: PureVirtualDeploymentJournalV3): void {
    if (this.#closed || state.readiness !== 'ready')
      throw new Error('pure virtual deployment is closed or frozen');
    if (domainDigest('aether.process-virtual-worker-trust/1', this.#options.trust, LIMITS)
      !== this.#trustDigest)
      throw new Error('pure virtual operator trust changed');
    if (processVirtualArtifactDigestV4(this.#options.artifact) !== this.#artifactDigest)
      throw new Error('pure virtual signed artifact changed');
    if (domainDigest('aether.process-virtual-source-plan/1', this.#options.sourcePlan, LIMITS)
      !== this.#sourcePlanDigest
      || domainDigest('aether.process-virtual-plan/1', this.#options.candidatePlan, LIMITS)
        !== this.#candidatePlanDigest
      || domainDigest('aether.process-virtual-sealer-identity/1',
        CapabilitySealer.prototype.keyCommitment.call(this.#options.sealer))
        !== this.#sealerIdentityDigest)
      throw new Error('pure virtual deployment live configuration changed');
    const governor = this.#options.coordinator.state();
    if (governor.activationPending || governor.committedManifest !== state.active.manifest
      || governor.generation !== state.active.generation
      || this.#options.coordinator.servingManifest() !== state.active.manifest)
      throw new Error('pure virtual deployment differs from committed governor');
    if (state.active.generation === '0' ? state.active.artifactDigest !== null
      : state.active.generation !== '1' || state.active.artifactDigest !== this.#artifactDigest)
      throw new Error('pure virtual deployment active artifact changed');
  }
  #sourceHostId(): string { return `source-${suffix(this.#sourceManifest)}`; }
  async #hostFor(which: 'source' | 'candidate', prepared?: PureVirtualPreparedV2): Promise<ProcessHost> {
    const existing = this.#hosts.get(which); if (existing) return existing;
    const artifact = validateProcessVirtualArtifactV4(this.#options.artifact,
      openProcessVirtualWorkerLineageV1(this.#options.trust));
    const common = { registry: new CapabilityRegistry(), sealer: this.#options.sealer,
      authorizeRecovery: this.#options.authorizeRecovery, timeoutMs: this.#options.timeoutMs,
      lockWaitMs: this.#options.lockWaitMs,
      onPhase: this.#options.onHostPhase };
    const host = await (which === 'source'
      ? ProcessHost.open({ ...common,
        directory: join(this.#options.directory, 'source-host'),
        module: decodeIR(artifact.sourceIr), manifest: artifact.sourceEvidence.manifest,
        plan: this.#options.sourcePlan, initialGeneration: '0',
        initialSnapshot: this.#options.sourceInitialSnapshot,
        virtualArtifactV4: { format: 'aether.process-host-virtual/3',
          artifact, trust: this.#options.trust },
        hostJournalWitness: selectHostJournalWitness(this.#options.hostWitnessCatalog,
          this.#sourceHostId()) })
      : (() => {
        if (!prepared) throw new Error('candidate host requires exact prepared seed');
        if (prepared.artifactDigest !== this.#artifactDigest
          || prepared.candidateManifest !== this.#candidateManifest)
          throw new Error('candidate host prepared artifact changed');
        return ProcessHost.open({ ...common,
          directory: join(this.#options.directory, 'candidate-host'),
          module: decodeIR(artifact.candidateIr), manifest: artifact.candidateEvidence.manifest,
          plan: this.#options.candidatePlan, initialGeneration: prepared.binding.generation,
          initialSnapshot: prepared.seed,
          virtualArtifactV4: { format: 'aether.process-host-virtual/2',
            artifact, trust: this.#options.trust },
          hostJournalWitness: selectHostJournalWitness(this.#options.hostWitnessCatalog,
            `candidate-${suffix(prepared.binding.proposalDigest)}`),
        });
      })());
    if (this.#closed) { await host.close(); throw new Error('deployment closed during host preparation'); }
    this.#hosts.set(which, host); return host;
  }
  async #activeHost(state: PureVirtualDeploymentJournalV3): Promise<ProcessHost> {
    let host: ProcessHost;
    if (state.active.generation === '0') host = await this.#hostFor('source');
    else {
      const proposal = this.#options.coordinator.history().find(record =>
        record.phase === 'active' && record.binding.generation === state.active.generation);
      if (!proposal?.handle) throw new Error('active virtual candidate lacks governor prepared handle');
      host = await this.#hostFor('candidate', this.#preparedRecord(proposal.binding, proposal.handle));
    }
    if (state.active.generation === '0') {
      const known = new Set(state.invocations.filter(row => row.generation === '0')
        .map(row => row.operationId));
      if (host.sourceOperationIds().some(id => !known.has(id)))
        throw new Error('witnessed source contains an unregistered operation ID');
    }
    for (const row of state.invocations) if (row.generation === state.active.generation
      && row.phase === 'settled' && !same(host.operationResult(row.operationId), row.result))
      throw new Error('virtual deployment receipt differs from active host');
    return host;
  }
  #assertSourceInventory(head: ProcessVirtualSourceHeadV1,
    state: PureVirtualDeploymentJournalV3): void {
    const expected = state.invocations.filter(row => row.generation === '0')
      .map(row => row.operationId).sort();
    if (!same([...head.operationIds].sort(), expected))
      throw new Error('witnessed source operation history differs from deployment registry');
  }
  #preparedRecord(binding: PromotionBindingV1, handle: PreparedPromotionHandleV1,
    requireStableSource = true): PureVirtualPreparedV2 {
    if (handle.format !== 'aether.prepared-promotion/1' || handle.proposalDigest !== binding.proposalDigest
      || handle.targetManifest !== this.#candidateManifest || handle.generation !== binding.generation
      || handle.payload.tag !== 'string') throw new TypeError('virtual prepared handle mismatch');
    const digest = handle.payload.value as Digest;
    const record = requireWitnessedPureVirtualPreparedV2(
      this.#prepared.read(binding.proposalDigest, digest));
    if (!same(record.binding, binding) || record.artifactDigest !== this.#artifactDigest
      || record.trustDigest !== this.#trustDigest
      || record.hostWitnessCatalogDigest !== this.#options.hostWitnessCatalog.digest
      || record.deploymentJournalWitnessDigest !== this.#options.deploymentWitness.digest
      || record.planDigest !== assertPureVirtualPlanV1(this.#options.candidatePlan, this.#options.artifact)
      || record.sourceHead.sourceManifest !== this.#sourceManifest
      || record.sourceHead.sourceIntent !== this.#options.artifact.lineageBinding.sourceIntent
      || record.sourceHead.planDigest !== this.#sourcePlanDigest)
      throw new TypeError('virtual prepared artifact, plan or authority changed');
    if (requireStableSource) {
      const witness = selectHostJournalWitness(this.#options.hostWitnessCatalog,
        this.#sourceHostId());
      const head = readHostJournalHead(witness);
      if (witness.digest !== record.sourceHead.hostWitnessDigest
        || head.revision !== record.sourceHead.witnessRevision || head.journal === null
        || domainDigest('aether.process-virtual-source-witness-journal/1',
          decodeCanonical(Buffer.from(head.journal, 'utf8'), LIMITS), LIMITS)
          !== record.sourceHead.witnessJournalDigest)
        throw new Error('historical witnessed source head changed after governor decision');
    }
    return record;
  }
  #assertGovernorBinding(binding: PromotionBindingV1,
    decision: 'prepare' | 'commit' | 'abort'): void {
    const record = this.#options.coordinator.history().find(item =>
      item.binding.proposalDigest === binding.proposalDigest);
    if (!record || !same(record.binding, binding) || !record.prepareStarted
      || decision === 'prepare' && record.phase !== 'authorized'
      || decision === 'commit' && !['prepared', 'active'].includes(record.phase)
      || decision === 'abort' && record.phase === 'active')
      throw new Error('pure virtual driver lacks exact governor prepare/decision');
  }

  async #hold(proposal: Digest): Promise<void> {
    if (this.#lease?.proposal === proposal) return;
    if (this.#lease) throw new Error('another virtual promotion already holds the gate');
    let acquired!: () => void, release!: () => void, failed!: (error: unknown) => void;
    const ready = new Promise<void>((resolve, reject) => { acquired = resolve; failed = reject; });
    const stop = new Promise<void>(resolve => { release = resolve; });
    const done = this.#gate.runAsync(async () => { acquired(); await stop; }, this.#options.lockWaitMs ?? 5000);
    void done.catch(failed); await ready;
    this.#lease = { proposal, release, done };
  }
  async #release(): Promise<void> { const lease = this.#lease; if (!lease) return;
    this.#lease = null; lease.release(); await lease.done; }

  async snapshot(): Promise<RuntimeSnapshotV1> {
    return this.#gate.runAsync(async () => { const state = this.#state(); this.#assertServing(state);
      return (await this.#activeHost(state)).snapshot(); }, this.#options.lockWaitMs ?? 5000);
  }
  async sourceHeadForPromotion(): Promise<ProcessVirtualSourceHeadV1> {
    return this.#gate.runAsync(async () => {
      const state = this.#state(); this.#assertServing(state);
      if (state.active.generation !== '0')
        throw new Error('pure virtual source already promoted');
      return (await this.#activeHost(state)).sourceHeadForPromotion();
    }, this.#options.lockWaitMs ?? 5000);
  }
  status(): Readonly<{ readiness: string; activeManifest: Digest; generation: string;
    servingReady: boolean; workerPids: Readonly<Record<string, number>> }> {
    const state = this.#state(); let ready = true;
    try {
      this.#assertServing(state);
      if (state.active.generation === '0') {
        const host = this.#hosts.get('source');
        const known = new Set(state.invocations.map(row => row.operationId));
        if (host?.sourceOperationIds().some(id => !known.has(id)))
          throw new Error('unregistered witnessed source operation');
      } else {
        const proposal = this.#options.coordinator.history().find(record =>
          record.phase === 'active' && record.binding.generation === state.active.generation);
        if (!proposal?.handle) throw new Error('candidate lacks governor handle');
        this.#preparedRecord(proposal.binding, proposal.handle);
      }
    } catch { ready = false; }
    return { readiness: state.readiness, activeManifest: state.active.manifest,
      generation: state.active.generation, servingReady: ready,
      workerPids: this.#hosts.get(state.active.generation === '0' ? 'source' : 'candidate')?.workerPids ?? {} };
  }
  async issueTokens(symbol: SymbolId): Promise<CapabilityToken[]> {
    return this.#gate.runAsync(async () => { const state = this.#state(); this.#assertServing(state);
      return (await this.#activeHost(state)).issueTokens(symbol); }, this.#options.lockWaitMs ?? 5000);
  }
  async call(symbol: SymbolId, args: readonly TaggedValueV1[], options: {
    operationId: string; tokens: readonly CapabilityToken[] }): Promise<ProcessHostCallResult> {
    identifier(symbol); identifier(options.operationId); args.forEach(arg => validateTaggedValue(arg));
    args = clone(args); options = { operationId: options.operationId,
      tokens: clone(options.tokens) };
    return this.#gate.runAsync(async () => {
      let state = this.#state(); this.#assertServing(state);
      const host = await this.#activeHost(state);
      host.authorizeInvocation(symbol, options.tokens);
      const module = decodeIR(state.active.generation === '0'
        ? this.#options.artifact.sourceIr : this.#options.artifact.candidateIr);
      const declaration = module.kind === 'Module'
        ? module.members.find(member => member.kind === 'FunctionDecl' && member.symbol === symbol)
        : undefined;
      if (!declaration || declaration.kind !== 'FunctionDecl')
        throw new Error('unbound pure virtual invocation');
      validateProcessArguments(declaration, args, await host.snapshot());
      const old = state.invocations.find(item => item.operationId === options.operationId);
      if (old) {
        if (old.symbol !== symbol || !same(old.args, args))
          throw new Error('same virtual operation ID has different request');
        if (old.phase === 'settled') {
          if (old.generation === state.active.generation
            && !same(host.operationResult(options.operationId), old.result))
            throw new Error('virtual deployment receipt differs from active host');
          return clone(old.result!);
        }
        if (old.manifest !== state.active.manifest || old.generation !== state.active.generation)
          throw new Error('pending historical virtual operation blocks serving');
      }
      const row: PureVirtualInvocationV2 = old ?? { operationId: options.operationId,
        manifest: state.active.manifest, generation: state.active.generation,
        symbol, args: clone(args), requestDigest: pureVirtualInvocationDigestV2({
          manifest: state.active.manifest, generation: state.active.generation, symbol, args }),
        phase: 'pending', result: null };
      if (!old) state = this.#write(state, { active: state.active, readiness: state.readiness,
        pendingProposal: state.pendingProposal, preparedDigest: state.preparedDigest,
        invocations: [...state.invocations, row] });
      const prior = host.operationResult(options.operationId);
      const result = prior ?? await host.call(symbol, args, { operationId: options.operationId,
        tokens: options.tokens });
      if (result.state === 'indeterminate') return result;
      this.#write(state, { active: state.active, readiness: state.readiness,
        pendingProposal: state.pendingProposal, preparedDigest: state.preparedDigest,
        invocations: state.invocations.map(item => item.operationId === options.operationId
          ? { ...item, phase: 'settled', result } : item) });
      return result;
    }, this.#options.lockWaitMs ?? 5000);
  }
  async recoverOperation(operationId: string): Promise<ProcessHostCallResult> {
    identifier(operationId);
    return this.#gate.runAsync(async () => {
      const state = this.#state(); this.#assertServing(state);
      const row = state.invocations.find(item => item.operationId === operationId);
      if (!row) throw new Error('unknown virtual operation');
      if (row.phase === 'settled') return clone(row.result!);
      if (row.manifest !== state.active.manifest || row.generation !== state.active.generation)
        throw new Error('pending historical virtual operation blocks recovery');
      const host = await this.#activeHost(state);
      let result = host.operationResult(operationId);
      if (!result) throw new Error('virtual operation has no host intent; retry the original call');
      if (result.state === 'indeterminate') result = await host.recoverOperation(operationId,
        { strategy: 'isolated-replay' });
      if (result.state !== 'indeterminate') this.#write(state, { active: state.active,
        readiness: state.readiness, pendingProposal: state.pendingProposal,
        preparedDigest: state.preparedDigest,
        invocations: state.invocations.map(item => item.operationId === operationId
          ? { ...item, phase: 'settled', result } : item) });
      return result;
    }, this.#options.lockWaitMs ?? 5000);
  }

  async promote(input: PromotionInput): Promise<ProductionAdmissionState> {
    return this.#options.coordinator.promote(input, this);
  }
  async prepare(binding: PromotionBindingV1, evidence: VettedEvidence): Promise<PreparedPromotionHandleV1> {
    if (this.#closed) throw new Error('pure virtual deployment closed');
    this.#assertGovernorBinding(binding, 'prepare');
    validateVettedEvidence(evidence, binding.manifest);
    await this.#hold(binding.proposalDigest);
    let state = this.#state(); this.#assertServing(state);
    if (state.active.generation !== '0' || binding.generation !== '1'
      || state.invocations.some(item => item.phase === 'pending'))
      throw new Error('pure virtual promotion requires resolved one-way source');
    const candidate = decodeIR(this.#options.artifact.candidateIr);
    const callable = candidate.kind === 'Module'
      ? new Set(candidate.members.filter(member => member.kind === 'FunctionDecl')
        .map(member => member.symbol)) : new Set<SymbolId>();
    if (state.invocations.some(item => !callable.has(item.symbol as SymbolId)))
      throw new Error('pure virtual promotion would strand a historical operation ID');
    const source = await this.#hostFor('source');
    if (source.status().unresolved.length) throw new Error('unresolved source host execution');
    const sourceHead = source.sourceHeadForPromotion();
    this.#assertSourceInventory(sourceHead, state);
    const prepared = preparePureVirtualPromotionV2({ binding, evidence,
      artifact: this.#options.artifact, trust: this.#options.trust,
      plan: this.#options.candidatePlan, sourceHead,
      sourcePlanDigest: this.#sourcePlanDigest, sourceHostId: this.#sourceHostId(),
      sourceGeneration: '0',
      hostWitnessCatalog: this.#options.hostWitnessCatalog,
      deploymentJournalWitness: this.#options.deploymentWitness });
    this.#vetted.set(binding.proposalDigest, evidence);
    state = this.#write(state, { active: state.active, readiness: 'preparing',
      pendingProposal: binding.proposalDigest, preparedDigest: null,
      invocations: state.invocations });
    const digest = this.#prepared.write(prepared);
    const candidateHost = await this.#hostFor('candidate', prepared);
    this.#write(state, { active: state.active, readiness: 'prepared',
      pendingProposal: binding.proposalDigest, preparedDigest: digest,
      invocations: state.invocations });
    await this.#options.onPhase?.('prepared', { proposalDigest: binding.proposalDigest,
      workerPids: candidateHost.workerPids });
    return createPromotionHandle(binding, { tag: 'string', value: digest });
  }
  commitFence(binding: PromotionBindingV1, commit: () => void): void {
    this.#assertGovernorBinding(binding, 'commit');
    if (this.#lease?.proposal !== binding.proposalDigest)
      throw new Error('pure virtual commit lacks held deployment gate');
    const state = this.#state();
    if (state.readiness !== 'prepared' || state.pendingProposal !== binding.proposalDigest
      || state.active.manifest !== binding.proposal.expectedParent
      || state.active.generation !== '0')
      throw new Error('pure virtual prepared source changed before commit');
    const vetted = this.#vetted.get(binding.proposalDigest);
    if (!vetted) throw new Error('pure virtual commit lacks vetted evidence');
    const source = this.#hosts.get('source');
    if (!source) throw new Error('pure virtual source host unavailable at commit');
    source.withSourceCommitFence(sourceHead => {
      this.#assertSourceInventory(sourceHead, state);
      const prepared = preparePureVirtualPromotionV2({ binding, evidence: vetted,
        artifact: this.#options.artifact, trust: this.#options.trust,
        plan: this.#options.candidatePlan, sourceHead,
        sourcePlanDigest: this.#sourcePlanDigest, sourceHostId: this.#sourceHostId(),
        sourceGeneration: '0', hostWitnessCatalog: this.#options.hostWitnessCatalog,
        deploymentJournalWitness: this.#options.deploymentWitness });
      if (pureVirtualPreparedDigestV2(prepared) !== state.preparedDigest)
        throw new Error('pure virtual witnessed source head/history changed before commit');
      commit();
    });
  }
  async activate(binding: PromotionBindingV1, handle: PreparedPromotionHandleV1): Promise<void> {
    this.#assertGovernorBinding(binding, 'commit');
    const decision = this.#options.coordinator.history().find(record =>
      record.binding.proposalDigest === binding.proposalDigest)!;
    if (!same(decision.handle, handle))
      throw new Error('pure virtual activation handle differs from governor');
    await this.#hold(binding.proposalDigest);
    const governor = this.#options.coordinator.state();
    if (governor.committedManifest !== this.#candidateManifest || governor.generation !== '1')
      throw new Error('pure virtual activation lacks committed governor decision');
    validateProcessVirtualArtifactV4(this.#options.artifact,
      openProcessVirtualWorkerLineageV1(this.#options.trust));
    const prepared = this.#preparedRecord(binding, handle);
    let state = this.#state();
    if (state.readiness === 'ready' && state.active.generation === '1') {
      if (state.active.manifest !== this.#candidateManifest
        || state.active.artifactDigest !== this.#artifactDigest)
        throw new Error('ready virtual candidate differs from governor');
      await this.#release(); return;
    }
    if (state.readiness !== 'prepared' || state.pendingProposal !== binding.proposalDigest
      || state.preparedDigest !== pureVirtualPreparedDigestV2(prepared))
      throw new Error('pure virtual activation lacks exact prepared journal');
    const candidate = await this.#hostFor('candidate', prepared);
    await this.#options.onPhase?.('before-activation', { proposalDigest: binding.proposalDigest,
      workerPids: candidate.workerPids });
    const source = this.#hosts.get('source');
    if (source) { await source.close(); this.#hosts.delete('source'); }
    state = this.#state();
    this.#write(state, { active: { manifest: this.#candidateManifest,
      generation: '1', artifactDigest: this.#artifactDigest },
      readiness: 'ready', pendingProposal: null, preparedDigest: null,
      invocations: state.invocations });
    await this.#options.onPhase?.('activated', { proposalDigest: binding.proposalDigest,
      workerPids: candidate.workerPids });
    await this.#release();
  }
  async abort(binding: PromotionBindingV1, handle: PreparedPromotionHandleV1 | null): Promise<void> {
    this.#assertGovernorBinding(binding, 'abort');
    await this.#hold(binding.proposalDigest);
    const state = this.#state();
    if (this.#options.coordinator.state().committedManifest === this.#candidateManifest)
      throw new Error('committed virtual target cannot be aborted');
    if (state.pendingProposal !== null && state.pendingProposal !== binding.proposalDigest)
      throw new Error('cannot abort another virtual proposal');
    if (handle) this.#preparedRecord(binding, handle, false);
    const candidate = this.#hosts.get('candidate');
    if (candidate) { await candidate.close(); this.#hosts.delete('candidate'); }
    if (state.readiness !== 'ready') this.#write(state, { active: state.active,
      readiness: 'ready', pendingProposal: null, preparedDigest: null,
      invocations: state.invocations });
    await this.#hostFor('source');
    await this.#options.onPhase?.('aborted', { proposalDigest: binding.proposalDigest,
      workerPids: this.#hosts.get('source')!.workerPids });
    await this.#release();
  }
  async recover(binding: PromotionBindingV1, handle: PreparedPromotionHandleV1 | null,
    decision: 'commit' | 'abort'): Promise<void>;
  async recover(): Promise<ProductionAdmissionState>;
  async recover(binding?: PromotionBindingV1, handle?: PreparedPromotionHandleV1 | null,
    decision?: 'commit' | 'abort'): Promise<void | ProductionAdmissionState> {
    if (!binding) return this.#options.coordinator.recover(this);
    if (decision === 'commit') {
      if (!handle) throw new Error('committed virtual promotion lacks prepared handle');
      await this.activate(binding, handle);
    } else await this.abort(binding, handle ?? null);
  }
  async close(): Promise<void> {
    this.#closed = true;
    await Promise.all([...this.#hosts.values()].map(host => host.close()));
    this.#hosts.clear(); await this.#release();
  }
}
