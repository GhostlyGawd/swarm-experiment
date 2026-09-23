/** Real process deployment for baseline exact-root admission. Same-schema rebinding only. */
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { decode as decodeIR, encode as encodeIR } from '../tier1/agent-ir.ts';
import { walk, type Term, type Ty } from '../tier1/ast.ts';
import { atomicWrite } from '../tier1/persistence.ts';
import type { CapabilityName, SymbolId } from '../tier1/ids.ts';
import { CapabilityRegistry, type CapabilityDescriptor, type CapabilityToken } from '../tier2/ocap.ts';
import { underlying } from '../tier2/typecheck.ts';
import { decodeCanonical, encodeCanonical, exactObject, identifier, decimal, validateTaggedValue, type TaggedValueV1, type LogicalRefV1 } from '../fabric/encoding.ts';
import { domainDigest, executionManifestDigest, validateDigest, type Digest, type ExecutionManifestV1 } from '../fabric/identity.ts';
import { DEFAULT_EVIDENCE_POLICY, validateEvidence, validateVettedEvidence, type EvidenceContext, type EvidencePolicy, type LocalEvidenceV1, type VettedEvidence } from '../fabric/evidence.ts';
import { JournalLock } from '../fabric/journal-lock.ts';
import { runtimeSnapshotDigest, validateRuntimeSnapshot, type RuntimeSnapshotV1 } from '../fabric/snapshot.ts';
import { createPromotionHandle, evidenceBundleDigest, type PromotionAdmissionProfile, type PromotionBindingV1, type PromotionCoordinator, type PromotionDriver, type PromotionInput, type PreparedPromotionHandleV1, type ProductionAdmissionState } from '../fabric/promotion.ts';
import { ProcessHost, type ProcessHostCallResult, type ProcessHostOptions, type ProcessInvocationGrant } from './process-host.ts';
import type { ScopedGrantV2 } from '../tier2/scoped-grants.ts';
import { assertEffectSignerAnchor, assertAnchoredEffectPolicy, type EffectSignerAnchor } from '../tier2/effect-signer-anchor.ts';
import { validateProcessAllocation, validateProcessArguments } from './process-type-validation.ts';
import type { TopologyPlan } from './topology.ts';

export interface ProcessArtifactInput {
  readonly context: EvidenceContext;
  readonly evidence: LocalEvidenceV1;
  readonly plan: TopologyPlan;
  /** Reloadable host-service configuration identity. Functions and secrets are never serialized. */
  readonly factoryId: string;
}
export interface ProcessArtifactV1 {
  readonly format: 'aether.process-artifact/1';
  readonly ir: string;
  readonly manifest: ExecutionManifestV1;
  readonly specification: string;
  readonly policy: EvidencePolicy;
  readonly capabilities: readonly CapabilityDescriptor[];
  readonly externals: readonly { symbol: SymbolId; ir: string }[];
  readonly plan: string;
  readonly factoryId: string;
  readonly evidence: LocalEvidenceV1;
  readonly schemaDigest: Digest;
}
export type ProcessHostServices = Pick<ProcessHostOptions, 'sealer' | 'scopedGrants' | 'effectResourcePath' | 'effectResourcePolicyDigest' | 'signedEffectResourcePolicy' | 'effectResourceSignerKey' | 'currentEffectPolicyEpoch' | 'revocations' | 'effectRouterFactory' | 'authorizeRecovery' | 'timeoutMs' | 'lockWaitMs' | 'maxWorkers' | 'onPhase'>;
export type CapabilityDeploymentProfile = 'scoped-anchored-v5' | 'scoped-anchored-v4' | 'scoped-artifact-v4' | 'scoped-signed-v3' | 'scoped-v2' | 'legacy-sealed-v1';
const anchoredProfile = (profile: CapabilityDeploymentProfile): boolean => profile === 'scoped-anchored-v5' || profile === 'scoped-anchored-v4';
export interface ProcessDeploymentOptions {
  readonly directory: string;
  readonly coordinator: PromotionCoordinator;
  readonly factories: ReadonlyMap<string, (artifact: ProcessArtifactV1) => ProcessHostServices>;
  /** Required only when creating a fresh deployment; this is the trusted genesis factory path. */
  readonly genesis?: ProcessArtifactInput;
  readonly lockWaitMs?: number;
  readonly phase?: (phase: 'prepared' | 'before-activation' | 'activated' | 'aborted', detail: Readonly<{ proposalDigest: Digest; workerPids: Readonly<Record<string, number>> }>) => void;
  readonly invocationPhase?: (phase: 'after-intent' | 'after-host-result' | 'after-receipt', detail: Readonly<{ operationId: string; workerPids: Readonly<Record<string, number>> }>) => void;
  readonly legacyProfileMigration?: 'adopt-baseline-v1';
  /** Fresh production deployments default to an independently pinned signer. */
  readonly capabilityProfile?: CapabilityDeploymentProfile;
  /** Trusted operator/admission input, never returned by an artifact factory. Required by the anchored profile. */
  readonly effectSignerAnchor?: EffectSignerAnchor;
  /** Existing v2 histories have no capability-profile field and require explicit adoption. */
  readonly legacyCapabilityMigration?: 'adopt-legacy-sealed-v1' | 'adopt-scoped-v2';
}
interface DeploymentReference {
  readonly id: string;
  readonly manifest: Digest;
  readonly artifactDigest: Digest;
  readonly generation: string;
}
interface DeploymentState {
  readonly format: 'aether.process-deployment/3' | 'aether.process-deployment/4' | 'aether.process-deployment/5';
  readonly admissionProfile: PromotionAdmissionProfile;
  readonly capabilityProfile: CapabilityDeploymentProfile;
  readonly effectSignerAnchorDigest?: Digest;
  readonly genesisManifest: Digest;
  readonly active: DeploymentReference;
  readonly readiness: 'ready' | 'preparing' | 'prepared';
  readonly pendingProposal: Digest | null;
  readonly invocations: readonly DeploymentInvocation[];
  readonly allocations: readonly DeploymentAllocation[];
}
interface DeploymentAllocation {
  readonly operationId: string; readonly requestDigest: Digest; readonly heapId: string;
  readonly deployment: DeploymentReference; readonly ty: Ty;
  readonly fields: Readonly<Record<string, TaggedValueV1>>; readonly requestedUnit: string | null;
  readonly result: LogicalRefV1 | null; readonly receiptDigest: Digest | null;
}
interface DeploymentInvocation {
  readonly operationId: string;
  readonly requestDigest: Digest;
  readonly heapId: string;
  readonly deployment: DeploymentReference;
  readonly symbol: SymbolId;
  readonly unit: string;
  readonly args: readonly TaggedValueV1[];
  readonly phase: 'pending' | 'settled';
  readonly result: ProcessHostCallResult | null;
  readonly receiptDigest: Digest | null;
}
interface PreparedRecord {
  readonly format: 'aether.process-deployment-prepared/1' | 'aether.process-deployment-prepared/2' | 'aether.process-deployment-prepared/3';
  readonly effectSignerAnchorDigest?: Digest;
  readonly binding: PromotionBindingV1 | null;
  readonly reference: DeploymentReference;
  readonly source: DeploymentReference | null;
  readonly sourceSnapshotDigest: Digest | null;
  readonly seed: RuntimeSnapshotV1 | null;
}
interface Lease { readonly proposal: Digest; release(): void; readonly done: Promise<void> }
const LIMITS = { maxFrameBytes: 16 * 1024 * 1024, maxDecompressedBytes: 16 * 1024 * 1024, maxObjects: 500_000, maxDepth: 128 };
function copy<T>(value: T): T { return decodeCanonical(encodeCanonical(value, LIMITS), LIMITS) as T; }
function freeze<T>(value: T): T { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
function equal(a: unknown, b: unknown): boolean { return Buffer.compare(encodeCanonical(a, LIMITS), encodeCanonical(b, LIMITS)) === 0; }
function syncDirectory(path: string): void { const fd = openSync(path, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } }
function ensureDirectory(path: string): void {
  if (existsSync(path)) return;
  ensureDirectory(dirname(path));
  try { mkdirSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  syncDirectory(path); syncDirectory(dirname(path));
}
function save(path: string, value: unknown): void {
  atomicWrite(path, Buffer.from(encodeCanonical(value, LIMITS)).toString('utf8'));
  syncDirectory(dirname(path));
}
function load(path: string): unknown { if (statSync(path).size > LIMITS.maxFrameBytes) throw new RangeError('deployment record too large'); return decodeCanonical(readFileSync(path), LIMITS); }
function suffix(digest: Digest): string { validateDigest(digest); return digest.split(':').at(-1)!; }
function logicalValue(value: TaggedValueV1): unknown {
  return value.tag === 'ref' ? { tag: 'ref', heapId: value.value.heapId, objectId: value.value.objectId }
    : value.tag === 'sequence' ? { tag: 'sequence', items: value.items.map(logicalValue) }
      : value.tag === 'result' ? { tag: 'result', variant: value.variant, value: logicalValue(value.value) } : value;
}
function invocationDigest(heapId: string, symbol: SymbolId, args: readonly TaggedValueV1[]): Digest {
  return domainDigest('aether.deployment-invocation/1', { heapId, symbol, args: args.map(logicalValue) });
}
function receiptDigest(invocation: DeploymentInvocation): Digest | null {
  return invocation.result === null ? null : domainDigest('aether.deployment-invocation-receipt/1', { operationId: invocation.operationId, requestDigest: invocation.requestDigest, deployment: invocation.deployment, result: invocation.result });
}
function allocationDigest(allocation: Pick<DeploymentAllocation, 'heapId' | 'ty' | 'fields' | 'requestedUnit'>): Digest {
  return domainDigest('aether.deployment-allocation/1', { heapId: allocation.heapId, ty: allocation.ty, fields: Object.entries(allocation.fields).sort(([a], [b]) => a < b ? -1 : 1).map(([key, value]) => [key, logicalValue(value)]), requestedUnit: allocation.requestedUnit });
}
function allocationReceipt(allocation: DeploymentAllocation): Digest | null {
  return allocation.result === null ? null : domainDigest('aether.deployment-allocation-receipt/1', { operationId: allocation.operationId, requestDigest: allocation.requestDigest, deployment: allocation.deployment, result: allocation.result });
}

export function processArtifactDigest(artifact: ProcessArtifactV1): Digest { return domainDigest('aether.process-artifact/1', artifact, LIMITS); }
export function processMigrationPlan(snapshot: RuntimeSnapshotV1, artifactDigest: Digest): TaggedValueV1 {
  validateDigest(artifactDigest, 'aether.process-artifact/1');
  return { tag: 'sequence', items: [{ tag: 'string', value: 'aether.same-schema-process-migration/1' }, { tag: 'string', value: runtimeSnapshotDigest(snapshot) }, { tag: 'string', value: artifactDigest }] };
}
export function processEffectPlan(factoryId: string, capabilityPolicyDigest: Digest): TaggedValueV1 {
  identifier(factoryId); validateDigest(capabilityPolicyDigest);
  return { tag: 'sequence', items: [{ tag: 'string', value: 'aether.process-effect-factory/1' }, { tag: 'string', value: factoryId }, { tag: 'string', value: capabilityPolicyDigest }] };
}
export function processAnchoredEffectPlan(factoryId: string, capabilityPolicyDigest: Digest, anchorDigest: Digest): TaggedValueV1 {
  identifier(factoryId); validateDigest(capabilityPolicyDigest); validateDigest(anchorDigest, 'aether.effect-signer-anchor/1');
  return { tag: 'sequence', items: [{ tag: 'string', value: 'aether.process-effect-factory/2' },
    { tag: 'string', value: factoryId }, { tag: 'string', value: capabilityPolicyDigest }, { tag: 'string', value: anchorDigest }] };
}
export function processImportFreeEffectPlan(factoryId: string, capabilityPolicyDigest: Digest, anchorDigest: Digest): TaggedValueV1 {
  identifier(factoryId); validateDigest(capabilityPolicyDigest, 'aether.effect-resource-policy/3'); validateDigest(anchorDigest, 'aether.effect-signer-anchor/1');
  return { tag: 'sequence', items: [{ tag: 'string', value: 'aether.process-effect-factory/3' },
    { tag: 'string', value: factoryId }, { tag: 'string', value: capabilityPolicyDigest }, { tag: 'string', value: anchorDigest }] };
}
function schemaDigest(module: Term): Digest {
  const signatures: unknown[] = [], types = new Map<string, Ty>();
  const add = (ty: Ty): void => {
    const key = Buffer.from(encodeCanonical(ty)).toString('utf8'); types.set(key, ty);
  };
  for (const node of walk(module)) {
    if (node.kind === 'TypeDecl') { signatures.push({ type: node.name, representation: node.ty }); add(node.ty); }
    if (node.kind === 'FunctionDecl') {
      signatures.push({ function: node.symbol, parameters: node.params.map(param => param.ty), returns: node.returns, typeParams: node.typeParams });
      node.params.forEach(param => add(param.ty)); add(node.returns);
    }
    if (node.kind === 'Let' || node.kind === 'RecordLit') add(node.ty);
  }
  signatures.sort((a, b) => Buffer.compare(encodeCanonical(a), encodeCanonical(b)));
  return domainDigest('aether.process-schema/1', { signatures, types: [...types].sort(([a], [b]) => a < b ? -1 : 1).map(([, value]) => value) });
}
export function processArtifactContext(artifact: ProcessArtifactV1): EvidenceContext {
  const registry = new CapabilityRegistry(); artifact.capabilities.forEach(descriptor => registry.define(descriptor));
  const externals = new Map(artifact.externals.map(item => [item.symbol, decodeIR(item.ir)]));
  return { module: decodeIR(artifact.ir), registry, specification: artifact.specification, semanticsVersion: artifact.manifest.semanticsVersion,
    compilerDigest: artifact.manifest.compilerDigest, target: artifact.manifest.target, capabilityPolicyDigest: artifact.manifest.capabilityPolicyDigest, policy: artifact.policy,
    resolveDeclaration: symbol => externals.get(symbol) };
}
function makeArtifact(input: ProcessArtifactInput): ProcessArtifactV1 {
  identifier(input.factoryId);
  const vetted = validateEvidence(input.evidence, input.context);
  const own = new Set([...walk(input.context.module)].filter(node => node.kind === 'FunctionDecl').map(node => (node as Extract<Term, { kind: 'FunctionDecl' }>).symbol));
  const externals = vetted.manifest.dependencies.filter(dependency => !own.has(dependency.symbol as SymbolId)).map(dependency => {
    const declaration = input.context.resolveDeclaration?.(dependency.symbol as SymbolId);
    if (declaration?.kind !== 'FunctionDecl') throw new TypeError('external declaration cannot be persisted');
    return { symbol: declaration.symbol, ir: encodeIR(declaration).text };
  });
  const artifact: ProcessArtifactV1 = { format: 'aether.process-artifact/1', ir: encodeIR(input.context.module).text, manifest: vetted.manifest,
    specification: input.context.specification, policy: input.context.policy ?? DEFAULT_EVIDENCE_POLICY,
    capabilities: [...input.context.registry.names].sort().map(name => input.context.registry.get(name)!), externals,
    plan: JSON.stringify(input.plan), factoryId: input.factoryId, evidence: input.evidence, schemaDigest: schemaDigest(input.context.module) };
  encodeCanonical(artifact, LIMITS); return freeze(copy(artifact));
}
function validateReference(value: unknown): asserts value is DeploymentReference {
  const ref = exactObject(value, ['id', 'manifest', 'artifactDigest', 'generation']);
  if (ref.id !== 'genesis' && (typeof ref.id !== 'string' || !/^[0-9a-f]{64}$/.test(ref.id))) throw new TypeError('invalid deployment directory identity');
  validateDigest(ref.manifest, 'aether.execution/1'); validateDigest(ref.artifactDigest, 'aether.process-artifact/1'); decimal(ref.generation);
}
function rebind(snapshot: RuntimeSnapshotV1, manifest: Digest, epoch: string, plan: TopologyPlan): RuntimeSnapshotV1 {
  validateRuntimeSnapshot(snapshot); validateDigest(manifest, 'aether.execution/1'); decimal(epoch);
  const units = new Set(plan.units.map(unit => unit.id));
  if (!plan.units.length) throw new TypeError('empty candidate process plan');
  const value = (item: TaggedValueV1): TaggedValueV1 => {
    if (item.tag === 'authority') throw new TypeError('same-schema migration cannot reissue stored authority');
    if (item.tag === 'ref') return { tag: 'ref', value: { ...item.value, ownerEpoch: epoch } };
    if (item.tag === 'sequence') return { tag: 'sequence', items: item.items.map(value) };
    if (item.tag === 'result') return { ...item, value: value(item.value) };
    return item;
  };
  const result: RuntimeSnapshotV1 = { ...snapshot, executionManifest: manifest,
    records: snapshot.records.map(record => ({ ...record, fields: record.fields.map(([key, item]) => [key, value(item)] as const) })),
    ownership: snapshot.ownership.map(owner => ({ ...owner, epoch, unit: units.has(owner.unit) ? owner.unit : plan.units[0].id })) };
  validateRuntimeSnapshot(result); return result;
}

/**
 * The public execution gate and the PromotionDriver are one object. All execution
 * uses a shared disk-backed lease; prepare holds it until activate/abort, even
 * when a caller invokes PromotionCoordinator.promote directly. A durable readiness
 * record prevents another instance or restarted process serving a frozen snapshot.
 */
export class ProcessDeployment implements PromotionDriver {
  private readonly options: ProcessDeploymentOptions;
  private readonly capabilityProfile: CapabilityDeploymentProfile;
  private readonly gate: JournalLock;
  private readonly registryGate: JournalLock;
  private readonly stateFile: string;
  private readonly hosts = new Map<string, ProcessHost>();
  private lease: Lease | null = null;
  private historicalRecovery: string | null = null;
  private closed = false;
  private constructor(options: ProcessDeploymentOptions) {
    this.options = options; this.capabilityProfile = options.capabilityProfile ?? 'scoped-anchored-v5';
    if (!['scoped-anchored-v5', 'scoped-anchored-v4', 'scoped-artifact-v4', 'scoped-signed-v3', 'scoped-v2', 'legacy-sealed-v1'].includes(this.capabilityProfile)
      || options.legacyCapabilityMigration !== undefined && !['adopt-legacy-sealed-v1', 'adopt-scoped-v2'].includes(options.legacyCapabilityMigration)) throw new TypeError('invalid capability deployment profile/migration');
    if (anchoredProfile(this.capabilityProfile)) assertEffectSignerAnchor(options.effectSignerAnchor);
    else if (options.effectSignerAnchor !== undefined) throw new TypeError('independent effect signer anchor requires anchored deployment profile');
    ensureDirectory(options.directory);
    ensureDirectory(join(options.directory, 'artifacts')); ensureDirectory(join(options.directory, 'deployments'));
    this.stateFile = join(options.directory, 'deployment.json');
    this.gate = new JournalLock({ directory: join(options.directory, 'execution-gate'), domain: 'aether.process-deployment-lock', busyError: 'deployment execution is frozen by another transition' });
    this.registryGate = new JournalLock({ directory: join(options.directory, 'artifact-gate'), domain: 'aether.process-artifact-lock' });
    syncDirectory(options.directory);
  }
  static async open(options: ProcessDeploymentOptions): Promise<ProcessDeployment> {
    const deployment = new ProcessDeployment(options);
    try {
      await deployment.gate.runAsync(async () => {
        if(options.legacyProfileMigration!==undefined&&(options.legacyProfileMigration!=='adopt-baseline-v1'||options.coordinator.admissionProfile!=='baseline-governor-v1'))throw new TypeError('legacy deployment can only be explicitly adopted as baseline');
        if(existsSync(deployment.stateFile)&&(load(deployment.stateFile) as {format?:unknown}).format==='aether.process-deployment/1'){
          if(options.legacyProfileMigration!=='adopt-baseline-v1'||deployment.capabilityProfile!=='legacy-sealed-v1')throw new Error('unprofiled deployment history requires explicit baseline migration and legacy capability profile');
          const migrated = deployment.readState('v1'); deployment.assertHistoricalServices(migrated);
          await deployment.hostFor(migrated.active); save(deployment.stateFile,migrated);
        }
        if(existsSync(deployment.stateFile)&&(load(deployment.stateFile) as {format?:unknown}).format==='aether.process-deployment/2'){
          if(deployment.capabilityProfile==='scoped-signed-v3'||deployment.capabilityProfile==='scoped-artifact-v4'||anchoredProfile(deployment.capabilityProfile))throw new Error('v2 authority cannot be silently upgraded to signed policy; use a new admitted deployment');
          const required = deployment.capabilityProfile === 'scoped-v2' ? 'adopt-scoped-v2' : 'adopt-legacy-sealed-v1';
          if(options.legacyCapabilityMigration!==required)throw new Error('unprofiled capability history requires explicit legacy capability migration');
          const migrated = deployment.readState('v2'); deployment.assertHistoricalServices(migrated);
          await deployment.hostFor(migrated.active); save(deployment.stateFile,migrated);
        }
        if (!existsSync(deployment.stateFile)) {
          if (!options.genesis) throw new Error('trusted genesis artifact is required');
          const candidate = makeArtifact(options.genesis), factory = options.factories.get(candidate.factoryId);
          if (!factory) throw new Error('trusted artifact factory is unavailable');
          deployment.assertServices(factory(candidate), decodeIR(candidate.ir), candidate.policy, candidate.manifest);
          const artifact = deployment.persistArtifact(candidate);
          const manifest = executionManifestDigest(artifact.manifest), admission = options.coordinator.state();
          if (admission.committedManifest !== manifest || admission.generation !== '0' || admission.pendingProposal !== null) throw new Error('genesis does not match production admission');
          const reference: DeploymentReference = { id: 'genesis', manifest, artifactDigest: processArtifactDigest(artifact), generation: '0' };
          deployment.writePrepared({ format: deployment.capabilityProfile === 'scoped-anchored-v5' ? 'aether.process-deployment-prepared/3'
            : deployment.capabilityProfile === 'scoped-anchored-v4' ? 'aether.process-deployment-prepared/2' : 'aether.process-deployment-prepared/1',
            ...(anchoredProfile(deployment.capabilityProfile) ? { effectSignerAnchorDigest: options.effectSignerAnchor!.digest } : {}),
            binding: null, reference, source: null, sourceSnapshotDigest: null, seed: null });
          save(deployment.stateFile, { format: deployment.capabilityProfile === 'scoped-anchored-v5' ? 'aether.process-deployment/5'
            : deployment.capabilityProfile === 'scoped-anchored-v4' ? 'aether.process-deployment/4' : 'aether.process-deployment/3',
            admissionProfile: options.coordinator.admissionProfile, capabilityProfile: deployment.capabilityProfile,
            ...(anchoredProfile(deployment.capabilityProfile) ? { effectSignerAnchorDigest: options.effectSignerAnchor!.digest } : {}),
            genesisManifest: manifest, active: reference, readiness: 'ready', pendingProposal: null, invocations: [], allocations: [] });
        }
        const state = deployment.readState();
        // Pending decisions are recovered explicitly, never by booting the old target.
        if (state.readiness === 'ready' && options.coordinator.servingReady()) {
          deployment.assertServing(state); await deployment.hostFor(state.active);
        }
      }, options.lockWaitMs ?? 5000);
      return deployment;
    } catch (error) { await deployment.close(); throw error; }
  }
  registerArtifact(input: ProcessArtifactInput): Digest {
    if (this.closed) throw new Error('deployment is closed');
    const artifact = makeArtifact(input), factory = this.options.factories.get(artifact.factoryId);
    if (!factory) throw new Error('trusted artifact factory is unavailable');
    this.assertServices(factory(artifact), decodeIR(artifact.ir), artifact.policy, artifact.manifest);
    return processArtifactDigest(this.persistArtifact(artifact));
  }
  artifact(manifest: Digest): ProcessArtifactV1 { return this.readArtifact(manifest); }
  private artifactPath(manifest: Digest): string { validateDigest(manifest, 'aether.execution/1'); return join(this.options.directory, 'artifacts', `${suffix(manifest)}.json`); }
  private persistArtifact(artifact: ProcessArtifactV1): ProcessArtifactV1 {
    return this.registryGate.run(() => {
      if (!this.options.factories.has(artifact.factoryId)) throw new Error('trusted artifact factory is unavailable');
      const path = this.artifactPath(executionManifestDigest(artifact.manifest));
      if (existsSync(path)) { const existing = this.readArtifact(executionManifestDigest(artifact.manifest)); if (!equal(existing, artifact)) throw new Error('artifact manifest already has different runtime configuration'); return existing; }
      save(path, artifact); return artifact;
    }, this.options.lockWaitMs ?? 5000);
  }
  private readArtifact(manifest: Digest): ProcessArtifactV1 {
    const value = exactObject(load(this.artifactPath(manifest)), ['format', 'ir', 'manifest', 'specification', 'policy', 'capabilities', 'externals', 'plan', 'factoryId', 'evidence', 'schemaDigest']);
    if (value.format !== 'aether.process-artifact/1' || typeof value.ir !== 'string' || typeof value.specification !== 'string' || typeof value.plan !== 'string' || !Array.isArray(value.capabilities) || !Array.isArray(value.externals)) throw new TypeError('invalid durable artifact');
    identifier(value.factoryId); validateDigest(value.schemaDigest, 'aether.process-schema/1');
    const artifact = value as unknown as ProcessArtifactV1;
    if (executionManifestDigest(artifact.manifest) !== manifest || !this.options.factories.has(artifact.factoryId)) throw new TypeError('artifact identity/factory mismatch');
    const context = processArtifactContext(artifact);
    if (schemaDigest(context.module) !== artifact.schemaDigest) throw new TypeError('artifact schema mismatch');
    validateEvidence(artifact.evidence, context);
    return freeze(copy(artifact));
  }
  private directory(id: string): string { if (id !== 'genesis' && !/^[0-9a-f]{64}$/.test(id)) throw new TypeError('invalid deployment ID'); return join(this.options.directory, 'deployments', id); }
  private writePrepared(record: PreparedRecord): void { ensureDirectory(this.directory(record.reference.id)); save(join(this.directory(record.reference.id), 'prepared.json'), record); }
  private readPrepared(reference: DeploymentReference): PreparedRecord {
    validateReference(reference);
    const raw = load(join(this.directory(reference.id), 'prepared.json')) as { format?: unknown };
    const anchored = anchoredProfile(this.capabilityProfile);
    const value = exactObject(raw, ['format', ...(anchored ? ['effectSignerAnchorDigest'] : []), 'binding', 'reference', 'source', 'sourceSnapshotDigest', 'seed']);
    const expected = this.capabilityProfile === 'scoped-anchored-v5' ? 'aether.process-deployment-prepared/3'
      : anchored ? 'aether.process-deployment-prepared/2' : 'aether.process-deployment-prepared/1';
    if (value.format !== expected || !equal(value.reference, reference)) throw new TypeError('prepared deployment identity mismatch');
    if (anchored && value.effectSignerAnchorDigest !== this.options.effectSignerAnchor!.digest) throw new TypeError('prepared effect signer anchor mismatch');
    if (value.source !== null) validateReference(value.source);
    if (value.sourceSnapshotDigest !== null) validateDigest(value.sourceSnapshotDigest, 'aether.state/1');
    if (value.seed !== null) {
      validateRuntimeSnapshot(value.seed);
      if (value.seed.executionManifest !== reference.manifest || value.seed.ownership.some(owner => owner.epoch !== reference.generation)) throw new TypeError('prepared seed manifest/epoch mismatch');
    }
    return value as unknown as PreparedRecord;
  }
  private readState(legacy: 'v1' | 'v2' | null = null): DeploymentState {
    const anchored = !legacy && anchoredProfile(this.capabilityProfile);
    const value = exactObject(load(this.stateFile), ['format', ...(legacy === 'v1' ? [] : ['admissionProfile']), ...(legacy ? [] : ['capabilityProfile']), ...(anchored ? ['effectSignerAnchorDigest'] : []), 'genesisManifest', 'active', 'readiness', 'pendingProposal', 'invocations', 'allocations']);
    validateReference(value.active); validateDigest(value.genesisManifest, 'aether.execution/1');
    if (value.format !== (legacy === 'v1' ? 'aether.process-deployment/1' : legacy === 'v2' ? 'aether.process-deployment/2'
      : this.capabilityProfile === 'scoped-anchored-v5' ? 'aether.process-deployment/5' : anchored ? 'aether.process-deployment/4' : 'aether.process-deployment/3')
      || (legacy !== 'v1' && value.admissionProfile !== this.options.coordinator.admissionProfile)
      || (!legacy && value.capabilityProfile !== this.capabilityProfile)
      || !['ready', 'preparing', 'prepared'].includes(value.readiness as string) || (value.readiness === 'ready') !== (value.pendingProposal === null)) throw new TypeError('invalid deployment readiness/profile');
    if (anchored && value.effectSignerAnchorDigest !== this.options.effectSignerAnchor!.digest) throw new TypeError('durable effect signer anchor mismatch');
    if (value.pendingProposal !== null) validateDigest(value.pendingProposal, 'aether.promotion/1');
    if (!Array.isArray(value.invocations)) throw new TypeError('missing durable invocation registry');
    const history = this.options.coordinator.history();
    const genesis = history[0]?.binding.proposal.expectedParent ?? this.options.coordinator.state().committedManifest;
    if (value.genesisManifest !== genesis) throw new TypeError('deployment genesis differs from admitted history');
    const admitted = new Map(history.filter(record => record.phase === 'active').map(record => [record.binding.generation, record]));
    const operations = new Set<string>();
    for (const item of value.invocations) {
      const invocation = exactObject(item, ['operationId', 'requestDigest', 'heapId', 'deployment', 'symbol', 'unit', 'args', 'phase', 'result', 'receiptDigest']);
      identifier(invocation.operationId); identifier(invocation.symbol); identifier(invocation.unit); validateDigest(invocation.requestDigest, 'aether.deployment-invocation/1'); validateReference(invocation.deployment);
      identifier(invocation.heapId);
      const target = invocation.deployment as DeploymentReference;
      const admission = admitted.get(target.generation);
      if (target.generation === '0' ? target.id !== 'genesis' || target.manifest !== genesis
        : !admission || target.id !== suffix(admission.binding.proposalDigest) || target.manifest !== admission.binding.proposal.candidateManifest) throw new TypeError('invocation receipt refers to an unadmitted deployment');
      if (operations.has(invocation.operationId) || !Array.isArray(invocation.args) || !['pending', 'settled'].includes(invocation.phase as string)) throw new TypeError('invalid invocation registry');
      operations.add(invocation.operationId); invocation.args.forEach(argument => validateTaggedValue(argument));
      if (invocation.requestDigest !== invocationDigest(invocation.heapId, invocation.symbol as SymbolId, invocation.args as TaggedValueV1[]) || invocation.receiptDigest !== receiptDigest(invocation as unknown as DeploymentInvocation)) throw new TypeError('invocation request/receipt digest mismatch');
      if (invocation.result !== null) {
        const result = invocation.result as ProcessHostCallResult;
        if (result.operationId !== invocation.operationId || result.generation !== (invocation.deployment as DeploymentReference).generation || result.unit !== invocation.unit || !['completed', 'aborted', 'indeterminate'].includes(result.state)) throw new TypeError('invocation receipt identity mismatch');
        if (invocation.phase === 'settled' && result.state === 'indeterminate') throw new TypeError('indeterminate invocation cannot be settled');
      } else if (invocation.phase === 'settled') throw new TypeError('settled invocation lacks receipt');
    }
    if (!Array.isArray(value.allocations)) throw new TypeError('missing durable allocation registry');
    for (const item of value.allocations) {
      const row = exactObject(item, ['operationId', 'requestDigest', 'heapId', 'deployment', 'ty', 'fields', 'requestedUnit', 'result', 'receiptDigest']);
      identifier(row.operationId); identifier(row.heapId); validateReference(row.deployment);
      if (operations.has(row.operationId) || !row.fields || typeof row.fields !== 'object' || Array.isArray(row.fields)) throw new TypeError('invalid allocation registry');
      operations.add(row.operationId); Object.values(row.fields).forEach(field => validateTaggedValue(field));
      if (row.requestedUnit !== null) identifier(row.requestedUnit);
      const allocation = row as unknown as DeploymentAllocation;
      if (allocationDigest(allocation) !== row.requestDigest || allocationReceipt(allocation) !== row.receiptDigest) throw new TypeError('allocation request/receipt digest mismatch');
      const target = allocation.deployment, admission = admitted.get(target.generation);
      if (target.generation === '0' ? target.id !== 'genesis' || target.manifest !== genesis
        : !admission || target.id !== suffix(admission.binding.proposalDigest) || target.manifest !== admission.binding.proposal.candidateManifest) throw new TypeError('allocation receipt refers to an unadmitted deployment');
      if (allocation.result !== null) {
        validateTaggedValue({ tag: 'ref', value: allocation.result });
        if (allocation.result.heapId !== row.heapId || allocation.result.ownerEpoch !== target.generation) throw new TypeError('allocation receipt scope mismatch');
      }
    }
    return (legacy ? { ...value, format: 'aether.process-deployment/3', admissionProfile: legacy === 'v1' ? 'baseline-governor-v1' : value.admissionProfile, capabilityProfile: legacy === 'v1' ? 'legacy-sealed-v1' : this.capabilityProfile } : value) as unknown as DeploymentState;
  }
  private assertCommittedSource(state=this.readState()):void {
    if(this.closed)throw new Error('deployment is closed');
    const admission=this.options.coordinator.state();
    if(admission.activationPending||state.readiness!=='ready'||state.active.manifest!==admission.committedManifest||state.active.generation!==admission.generation)throw new Error('deployment source is frozen or does not match committed target');
  }
  private assertServing(state = this.readState()): void {
    if(this.closed)throw new Error('deployment is closed');
    const manifest = this.options.coordinator.servingManifest(), admission = this.options.coordinator.state();
    this.assertCommittedSource(state);
    if (state.readiness !== 'ready' || state.active.manifest !== manifest || state.active.generation !== admission.generation) throw new Error('deployment serving is frozen or does not match committed target');
  }
  servingManifest(): Digest { const state = this.readState(); this.assertServing(state); return state.active.manifest; }
  status(): { readiness: DeploymentState['readiness']; servingReady:boolean; capabilityProfile: CapabilityDeploymentProfile; activeManifest: Digest; generation: string; workerPids: Readonly<Record<string, number>> } {
    const state = this.readState(),admission=this.options.coordinator.state();
    const servingReady=!this.closed&&this.options.coordinator.servingReady()&&state.readiness==='ready'&&state.active.manifest===admission.committedManifest&&state.active.generation===admission.generation;
    return { readiness: state.readiness, servingReady, capabilityProfile: state.capabilityProfile, activeManifest: state.active.manifest, generation: state.active.generation, workerPids: this.hosts.get(state.active.id)?.workerPids ?? {} };
  }
  private async hostFor(reference: DeploymentReference): Promise<ProcessHost> {
    if (this.closed) throw new Error('deployment is closed');
    const existing = this.hosts.get(reference.id); if (existing) return existing;
    const record = this.readPrepared(reference), artifact = this.readArtifact(reference.manifest);
    if (processArtifactDigest(artifact) !== reference.artifactDigest) throw new TypeError('prepared artifact registry changed');
    const context = processArtifactContext(artifact), factory = this.options.factories.get(artifact.factoryId)!;
    const services = factory(artifact);
    this.assertServices(services, context.module, artifact.policy, artifact.manifest);
    ensureDirectory(join(this.directory(reference.id), 'host'));
    const host = await ProcessHost.open({ ...services,
      ...(anchoredProfile(this.capabilityProfile) ? { effectSignerAnchor: this.options.effectSignerAnchor } : {}),
      ...(this.capabilityProfile === 'scoped-anchored-v4' ? { legacyAnchoredEffectPolicy: 'anchored-v2' as const } : {}),
      ...(services.signedEffectResourcePolicy && !anchoredProfile(this.capabilityProfile)
        ? { legacyEffectSignerTrust: 'factory-v1' as const } : {}),
      onPhase:(phase,detail)=>{
      if(this.historicalRecovery!==reference.id)this.options.coordinator.assertLineageCurrent(reference.manifest);
      services.onPhase?.(phase,detail);
      if(this.historicalRecovery!==reference.id)this.options.coordinator.assertLineageCurrent(reference.manifest);
    }, directory: join(this.directory(reference.id), 'host'), module: context.module, manifest: artifact.manifest,
      registry: context.registry, plan: JSON.parse(artifact.plan), initialGeneration: reference.generation, initialSnapshot: record.seed ?? undefined });
    if (this.closed) { await host.close(); throw new Error('deployment closed during worker preparation'); }
    this.hosts.set(reference.id, host); return host;
  }
  private assertTrustedServices(reference: DeploymentReference): void {
    if (!anchoredProfile(this.capabilityProfile)) return;
    const artifact = this.readArtifact(reference.manifest), context = processArtifactContext(artifact);
    const factory = this.options.factories.get(artifact.factoryId)!;
    this.assertServices(factory(artifact), context.module, artifact.policy, artifact.manifest);
  }
  private assertServices(services: ProcessHostServices, module: Term, evidencePolicy: EvidencePolicy, manifest: ExecutionManifestV1): void {
    const invoked = new Set([...walk(module)].filter(node => node.kind === 'Invoke').map(node => (node as Extract<Term, { kind: 'Invoke' }>).capability));
    if (this.capabilityProfile === 'legacy-sealed-v1' ? !!services.scopedGrants || !!services.signedEffectResourcePolicy || !!services.effectResourcePath : !services.scopedGrants) {
      throw new Error('trusted deployment factory does not match durable capability profile');
    }
    if ((this.capabilityProfile === 'scoped-signed-v3' || this.capabilityProfile === 'scoped-artifact-v4' || anchoredProfile(this.capabilityProfile))
      && (services.effectResourcePath || services.effectResourcePolicyDigest
        || invoked.size > 0 && (!services.signedEffectResourcePolicy
          || !anchoredProfile(this.capabilityProfile) && (!services.effectResourceSignerKey || !services.currentEffectPolicyEpoch)
          || [...invoked].some(cap => !services.signedEffectResourcePolicy!.body.rules.some(rule => rule.capability === cap))))) {
      throw new Error('signed deployment profile requires complete manifest-bound effect policy');
    }
    if (this.capabilityProfile === 'scoped-anchored-v5' && invoked.size > 0
      && services.signedEffectResourcePolicy?.format !== 'aether.signed-effect-resource-policy/3') {
      throw new Error('import-free deployment profile requires signed adapter policy v3');
    }
    if ((this.capabilityProfile === 'scoped-artifact-v4' || this.capabilityProfile === 'scoped-anchored-v4') && invoked.size > 0
      && services.signedEffectResourcePolicy?.format !== 'aether.signed-effect-resource-policy/2') {
      throw new Error('artifact deployment profile requires signed code-provenance policy v2');
    }
    if ((this.capabilityProfile === 'scoped-artifact-v4' || anchoredProfile(this.capabilityProfile)) && evidencePolicy.format !== 'aether.evidence-policy/2') {
      throw new Error('artifact deployment profile requires process-isolated evidence policy v2');
    }
    if (anchoredProfile(this.capabilityProfile)) {
      const anchor = this.options.effectSignerAnchor!;
      assertEffectSignerAnchor(anchor);
      if (services.effectResourceSignerKey !== undefined || services.currentEffectPolicyEpoch !== undefined
        || (services as ProcessHostOptions).effectSignerAnchor !== undefined
        || (services as ProcessHostOptions).legacyEffectSignerTrust !== undefined
        || (services as ProcessHostOptions).legacyAnchoredEffectPolicy !== undefined)
        throw new TypeError('effect signer authority must be independently provisioned');
      if (services.scopedGrants?.repositoryId !== anchor.repositoryId) throw new TypeError('effect grant repository differs from independent signer anchor');
      if (services.signedEffectResourcePolicy) {
        if (this.capabilityProfile === 'scoped-anchored-v5') {
          if (services.signedEffectResourcePolicy.format !== 'aether.signed-effect-resource-policy/3') throw new TypeError('import-free deployment requires policy v3');
          assertAnchoredEffectPolicy(anchor, services.signedEffectResourcePolicy, manifest, services.scopedGrants!.repositoryId);
        } else {
          if (services.signedEffectResourcePolicy.format !== 'aether.signed-effect-resource-policy/2') throw new TypeError('anchored legacy deployment requires policy v2');
          assertAnchoredEffectPolicy(anchor, services.signedEffectResourcePolicy, manifest, services.scopedGrants!.repositoryId, 'anchored-v2');
        }
      }
    }
  }
  private assertHistoricalServices(state: DeploymentState): void {
    const artifact = this.readArtifact(state.active.manifest), factory = this.options.factories.get(artifact.factoryId)!;
    this.assertServices(factory(artifact), decodeIR(artifact.ir), artifact.policy, artifact.manifest);
  }
  issueTokens(symbol: SymbolId, ttlMs?: number): CapabilityToken[] {
    const state = this.readState(); this.assertServing(state);
    const host = this.hosts.get(state.active.id); if (!host) throw new Error('deployment workers require recovery/open');
    return host.issueTokens(symbol, ttlMs);
  }
  issueScopedTokens(symbol: SymbolId, ttlMs?: number, resourceScopes?: ReadonlyMap<CapabilityName, readonly string[]>): ScopedGrantV2[] {
    const state = this.readState(); this.assertServing(state);
    const host = this.hosts.get(state.active.id); if (!host) throw new Error('deployment workers require recovery/open');
    return host.issueScopedTokens(symbol, ttlMs, resourceScopes);
  }
  async snapshot(): Promise<RuntimeSnapshotV1> { return this.gate.runAsync(async () => { const state = this.readState(); this.assertServing(state); return (await this.hostFor(state.active)).snapshot(); }, this.options.lockWaitMs ?? 5000); }
  /** Administrative evidence capture, never code execution. Allows a newly
   * signed repair to replace a quiescent artifact invalidated by a specification. */
  async snapshotForPromotion():Promise<RuntimeSnapshotV1>{return this.gate.runAsync(async()=>{const state=this.readState();this.assertCommittedSource(state);if(state.invocations.some(item=>item.phase==='pending')||state.allocations.some(item=>item.result===null))throw new Error('unresolved source execution prevents promotion snapshot');return(await this.hostFor(state.active)).snapshot();},this.options.lockWaitMs??5000);}
  async allocateRecord(ty: Ty, fields: Readonly<Record<string, TaggedValueV1>>, options: { operationId: string; unit?: string }): Promise<LogicalRefV1> {
    identifier(options.operationId); ty = freeze(copy(ty)); fields = freeze(copy(fields)); options = Object.freeze({ ...options });
    if (underlying(ty).t !== 'Record') throw new TypeError('allocation requires a record type');
    Object.values(fields).forEach(value => validateTaggedValue(value));
    return this.gate.runAsync(async () => {
      const state = this.readState(); this.assertServing(state);
      if (state.invocations.some(invocation => invocation.phase === 'pending')) throw new Error('unresolved deployment invocation blocks allocation');
      if (state.invocations.some(invocation => invocation.operationId === options.operationId)) throw new Error('operation ID already names an invocation');
      const current = await this.hostFor(state.active), snapshot = await current.snapshot();
      const candidate: DeploymentAllocation = { operationId: options.operationId, requestDigest: '', heapId: snapshot.heapId, deployment: state.active, ty, fields, requestedUnit: options.unit ?? null, result: null, receiptDigest: null };
      const digest = allocationDigest(candidate);
      const old = state.allocations.find(allocation => allocation.operationId === options.operationId);
      if (old && old.requestDigest !== digest) throw new Error('deployment allocation identity conflict');
      if (old?.result) return copy(old.result);
      if (state.allocations.some(allocation => allocation.result === null && allocation.operationId !== options.operationId)) throw new Error('unresolved deployment allocation blocks allocation');
      const record = old ?? { ...candidate, requestDigest: digest };
      if (record.deployment.manifest !== state.active.manifest || record.deployment.generation !== state.active.generation) throw new Error('cannot resume predecessor allocation after another target committed');
      if (!old) {
        if (options.unit !== undefined && !current.plan.units.some(unit => unit.id === options.unit)) throw new Error('allocation unit does not exist');
        const check = (value: TaggedValueV1): void => {
          if (value.tag === 'ref' && (value.value.heapId !== snapshot.heapId || value.value.ownerEpoch !== state.active.generation || !snapshot.records.some(record => record.objectId === value.value.objectId))) throw new Error('stale or unresolved allocation reference');
          if (value.tag === 'sequence') value.items.forEach(check); if (value.tag === 'result') check(value.value);
        };
        Object.values(fields).forEach(check);
        validateProcessAllocation(ty, fields, snapshot);
        save(this.stateFile, { ...state, allocations: [...state.allocations, record] });
      }
      const result = await current.allocateRecord(record.ty, record.fields, { operationId: record.operationId, ...(record.requestedUnit === null ? {} : { unit: record.requestedUnit }) });
      const complete = { ...record, result, receiptDigest: null };
      const latest = this.readState();
      save(this.stateFile, { ...latest, allocations: latest.allocations.map(previous => previous.operationId === record.operationId ? { ...complete, receiptDigest: allocationReceipt(complete) } : previous) });
      return result;
    }, this.options.lockWaitMs ?? 5000);
  }
  async call(symbol: SymbolId, args: readonly TaggedValueV1[], options: { operationId: string; tokens: readonly ProcessInvocationGrant[] }): Promise<ProcessHostCallResult> {
    this.assertServing();
    identifier(options.operationId); args.forEach(value => validateTaggedValue(value));
    args = freeze(copy(args)); options = Object.freeze({ operationId: options.operationId, tokens: freeze(copy(options.tokens)) });
    return this.gate.runAsync(async () => {
      const state = this.readState(); this.assertServing(state);
      const host = await this.hostFor(state.active);
      host.authorizeInvocation(symbol, options.tokens);
      const snapshot = await host.snapshot();
      this.assertServing(); host.authorizeInvocation(symbol, options.tokens);
      const requestDigest = invocationDigest(snapshot.heapId, symbol, args);
      const old = state.invocations.find(invocation => invocation.operationId === options.operationId);
      if (old) {
        if (old.requestDigest !== requestDigest) throw new Error('deployment invocation identity conflict');
        const historical=this.readArtifact(old.deployment.manifest),current=this.readArtifact(state.active.manifest);
        const declaration=(artifact:ProcessArtifactV1)=>[...walk(processArtifactContext(artifact).module)].find((node):node is Extract<Term,{kind:'FunctionDecl'}>=>node.kind==='FunctionDecl'&&node.symbol===symbol);
        const before=declaration(historical),after=declaration(current);
        if(!before||!after||historical.manifest.capabilityPolicyDigest!==current.manifest.capabilityPolicyDigest||before.capabilities.some(cap=>!after.capabilities.includes(cap)))throw new Error('historical invocation requires authority unavailable in the current declaration/policy; durable receipt retained without redispatch');
        this.assertServing();
        host.authorizeInvocation(symbol, options.tokens);
        return copy(old.result ?? { state: 'indeterminate', operationId: old.operationId, generation: old.deployment.generation, unit: old.unit, reason: 'durable invocation has no completed receipt; recover original deployment' });
      }
      if (state.invocations.some(invocation => invocation.phase === 'pending')) throw new Error('unresolved deployment invocation blocks new execution');
      if (state.allocations.some(allocation => allocation.operationId === options.operationId)) throw new Error('operation ID already names an allocation');
      if (state.allocations.some(allocation => allocation.result === null)) throw new Error('unresolved deployment allocation blocks new execution');
      const checkReference = (value: TaggedValueV1): void => {
        if (value.tag === 'ref' && (value.value.heapId !== snapshot.heapId || value.value.ownerEpoch !== state.active.generation || !snapshot.records.some(record => record.objectId === value.value.objectId))) throw new Error('stale or unresolved deployment reference');
        if (value.tag === 'sequence') value.items.forEach(checkReference); if (value.tag === 'result') checkReference(value.value);
      };
      args.forEach(checkReference);
      const module = processArtifactContext(this.readArtifact(state.active.manifest)).module;
      const declaration = [...walk(module)].find((node): node is Extract<Term, { kind: 'FunctionDecl' }> => node.kind === 'FunctionDecl' && node.symbol === symbol);
      if (!declaration) throw new TypeError('invocation has no declared type signature');
      validateProcessArguments(declaration, args, snapshot);
      const invocation: DeploymentInvocation = { operationId: options.operationId, requestDigest, heapId: snapshot.heapId, deployment: state.active, symbol, unit: host.unitFor(symbol)!, args: copy(args), phase: 'pending', result: null, receiptDigest: null };
      host.authorizeInvocation(symbol, options.tokens);
      save(this.stateFile, { ...state, invocations: [...state.invocations, invocation] });
      try {
        this.options.invocationPhase?.('after-intent', { operationId: options.operationId, workerPids: host.workerPids });
        const result = await host.call(symbol, args, options);
        this.options.invocationPhase?.('after-host-result', { operationId: options.operationId, workerPids: host.workerPids });
        this.recordInvocation({ ...invocation, result, phase: result.state === 'indeterminate' ? 'pending' : 'settled' });
        this.options.invocationPhase?.('after-receipt', { operationId: options.operationId, workerPids: host.workerPids });
        if(result.state==='completed')this.assertServing();
        host.authorizeInvocation(symbol, options.tokens);
        return result;
      } catch (error) {
        const durable = this.readState().invocations.find(record => record.operationId === invocation.operationId)!;
        if (durable.phase === 'settled' && durable.result) { if(durable.result.state==='completed')this.assertServing();host.authorizeInvocation(symbol, options.tokens); return copy(durable.result); }
        this.recordInvocation({ ...invocation, result: { state: 'indeterminate', operationId: invocation.operationId, generation: invocation.deployment.generation, unit: invocation.unit, reason: 'inner execution outcome requires original-deployment recovery' } });
        throw error;
      }
    }, this.options.lockWaitMs ?? 5000);
  }
  async recoverOperation(operationId: string, options?: { strategy: 'isolated-replay' | 'abort-before-effects' }): Promise<ProcessHostCallResult> {
    identifier(operationId);
    const strategy = options?.strategy ?? 'isolated-replay';
    if (!['isolated-replay', 'abort-before-effects'].includes(strategy)) throw new TypeError('unknown deployment recovery strategy');
    const request = Object.freeze({ strategy });
    return this.gate.runAsync(async () => {
      const state = this.readState(); this.assertCommittedSource(state);
      const invocation = state.invocations.find(invocation => invocation.operationId === operationId);
      if (!invocation) throw new Error('unknown deployment invocation');
      const artifact = this.readArtifact(invocation.deployment.manifest);
      const authorize = (): void => {
        this.assertCommittedSource();
        const services = this.options.factories.get(artifact.factoryId)?.(artifact);
        if (services?.authorizeRecovery?.(operationId, strategy) !== true) throw new Error('deployment recovery authorization denied');
      };
      authorize();
      if (invocation.phase === 'settled' && invocation.result) { authorize(); return copy(invocation.result); }
      if (invocation.deployment.manifest !== state.active.manifest || invocation.deployment.generation !== state.active.generation) throw new Error('cannot recover unresolved predecessor execution after another target committed');
      const host = await this.hostFor(invocation.deployment);
      authorize();
      let result: ProcessHostCallResult;
      if (host.operationResult(operationId) === null) {
        if (strategy !== 'abort-before-effects') throw new Error('no inner host intent; explicit authorized abort-before-effects is required');
        result = { state: 'aborted', operationId, generation: invocation.deployment.generation, unit: invocation.unit, reason: 'authorized abort: durable host journal confirms no execution intent was created' };
      } else {
        this.historicalRecovery=invocation.deployment.id;
        try{result=await host.recoverOperation(operationId,request);}finally{this.historicalRecovery=null;}
      }
      authorize();
      this.recordInvocation({ ...invocation, result, phase: result.state === 'indeterminate' ? 'pending' : 'settled' });
      return result;
    }, this.options.lockWaitMs ?? 5000);
  }
  private recordInvocation(invocation: DeploymentInvocation): void {
    const state = this.readState();
    if (!state.invocations.some(previous => previous.operationId === invocation.operationId && previous.requestDigest === invocation.requestDigest)) throw new Error('invocation intent disappeared');
    const record = { ...invocation, receiptDigest: receiptDigest(invocation) };
    save(this.stateFile, { ...state, invocations: state.invocations.map(previous => previous.operationId === invocation.operationId ? record : previous) });
  }
  async promote(input: PromotionInput): Promise<ProductionAdmissionState> { return this.options.coordinator.promote(input, this); }
  private assertBinding(binding: PromotionBindingV1, decision: 'prepare' | 'commit' | 'abort'): void {
    const history = this.options.coordinator.history();
    const record = history.find(record => record.binding.proposalDigest === binding.proposalDigest);
    if (!record || !equal(record.binding, binding)) throw new Error('driver binding is not recorded by coordinator');
    if (decision === 'prepare' && (record.phase !== 'authorized' || !record.prepareStarted)) throw new Error('driver preparation is not authorized');
    const current = this.options.coordinator.state(), latest = history.filter(record => record.phase === 'active').at(-1);
    if (decision === 'commit' && (record.phase !== 'active' || current.committedManifest !== binding.proposal.candidateManifest || current.generation !== binding.generation || latest?.binding.proposalDigest !== binding.proposalDigest)) throw new Error('driver activation is not the exact current durable commit');
    if (decision === 'abort' && record.phase === 'active') throw new Error('cannot abort a durably committed deployment');
  }
  private async hold(proposal: Digest): Promise<void> {
    if (this.closed) throw new Error('deployment is closed');
    if (this.lease) { if (this.lease.proposal !== proposal) throw new Error('another deployment is already frozen'); return; }
    let release!: () => void, acquired!: () => void, failed!: (error: unknown) => void;
    const stop = new Promise<void>(resolve => { release = resolve; });
    const ready = new Promise<void>((resolve, reject) => { acquired = resolve; failed = reject; });
    const done = this.gate.runAsync(async () => { acquired(); await stop; }, this.options.lockWaitMs ?? 5000);
    void done.catch(failed);
    await ready; this.lease = { proposal, release, done };
  }
  private async release(): Promise<void> { const lease = this.lease; if (!lease) return; this.lease = null; lease.release(); await lease.done; }
  async prepare(binding: PromotionBindingV1, evidence: VettedEvidence): Promise<PreparedPromotionHandleV1> {
    this.assertBinding(binding, 'prepare'); validateVettedEvidence(evidence, binding.manifest);
    await this.hold(binding.proposalDigest);
    const state = this.readState(); this.assertCommittedSource(state);
    if (state.active.manifest !== binding.proposal.expectedParent || String(BigInt(state.active.generation) + 1n) !== binding.generation) throw new Error('stale source deployment generation');
    const candidate = this.readArtifact(binding.proposal.candidateManifest), source = this.readArtifact(state.active.manifest);
    if (!equal(candidate.manifest, binding.manifest) || evidenceBundleDigest(candidate.evidence) !== binding.proposal.evidenceBundleDigest) throw new Error('candidate registry evidence does not match approval');
    if (candidate.schemaDigest !== source.schemaDigest) throw new Error('same-schema driver rejects changed types/layouts; a verified lens is required');
    const sourceHost = await this.hostFor(state.active);
    if (sourceHost.status().unresolved.length || state.invocations.some(invocation => invocation.phase === 'pending') || state.allocations.some(allocation => allocation.result === null)) throw new Error('unresolved source execution prevents deployment');
    const snapshot = await sourceHost.snapshot(), artifactDigest = processArtifactDigest(candidate);
    if (!equal(binding.migrationPlan, processMigrationPlan(snapshot, artifactDigest))) throw new Error('approved migration source snapshot/artifact is stale');
    const expectedEffectPlan = this.capabilityProfile === 'scoped-anchored-v5'
      ? processImportFreeEffectPlan(candidate.factoryId, candidate.manifest.capabilityPolicyDigest, this.options.effectSignerAnchor!.digest)
      : this.capabilityProfile === 'scoped-anchored-v4'
        ? processAnchoredEffectPlan(candidate.factoryId, candidate.manifest.capabilityPolicyDigest, this.options.effectSignerAnchor!.digest)
        : processEffectPlan(candidate.factoryId, candidate.manifest.capabilityPolicyDigest);
    if (!equal(binding.effectPlan, expectedEffectPlan)) throw new Error('approved effect factory/policy/signer mismatch');
    const reference: DeploymentReference = { id: suffix(binding.proposalDigest), manifest: binding.proposal.candidateManifest, artifactDigest, generation: binding.generation };
    const record: PreparedRecord = { format: this.capabilityProfile === 'scoped-anchored-v5' ? 'aether.process-deployment-prepared/3'
      : this.capabilityProfile === 'scoped-anchored-v4' ? 'aether.process-deployment-prepared/2' : 'aether.process-deployment-prepared/1',
      ...(anchoredProfile(this.capabilityProfile) ? { effectSignerAnchorDigest: this.options.effectSignerAnchor!.digest } : {}),
      binding, reference, source: state.active, sourceSnapshotDigest: runtimeSnapshotDigest(snapshot), seed: rebind(snapshot, reference.manifest, reference.generation, JSON.parse(candidate.plan)) };
    save(this.stateFile, { ...state, readiness: 'preparing', pendingProposal: binding.proposalDigest });
    this.writePrepared(record);
    // Child initialization compiles/checks/imports only. Candidate code/effects are not invoked.
    const host = await this.hostFor(reference);
    save(this.stateFile, { ...state, readiness: 'prepared', pendingProposal: binding.proposalDigest });
    this.options.phase?.('prepared', { proposalDigest: binding.proposalDigest, workerPids: host.workerPids });
    return createPromotionHandle(binding, { tag: 'string', value: domainDigest('aether.process-prepared-record/1', record, LIMITS) });
  }
  private prepared(binding: PromotionBindingV1, handle: PreparedPromotionHandleV1): PreparedRecord {
    const candidate = this.readArtifact(binding.proposal.candidateManifest);
    const reference = { id: suffix(binding.proposalDigest), manifest: binding.proposal.candidateManifest, artifactDigest: processArtifactDigest(candidate), generation: binding.generation };
    const record = this.readPrepared(reference);
    if (!equal(record.binding, binding) || !equal(handle, createPromotionHandle(binding, { tag: 'string', value: domainDigest('aether.process-prepared-record/1', record, LIMITS) }))) throw new Error('prepared process handle/binding mismatch');
    return record;
  }
  async activate(binding: PromotionBindingV1, handle: PreparedPromotionHandleV1): Promise<void> {
    this.assertBinding(binding, 'commit'); await this.hold(binding.proposalDigest);
    try { this.assertBinding(binding, 'commit'); } catch (error) { await this.release(); throw error; }
    const record = this.prepared(binding, handle), state = this.readState();
    const host = await this.hostFor(record.reference);
    this.assertTrustedServices(record.reference);
    this.options.phase?.('before-activation', { proposalDigest: binding.proposalDigest, workerPids: host.workerPids });
    this.assertTrustedServices(record.reference);
    this.assertBinding(binding, 'commit');
    if (this.closed) throw new Error('deployment closed before activation');
    // Close every predecessor before publishing ready. Any failure keeps serving blocked.
    for (const [id, previous] of this.hosts) if (id !== record.reference.id) { await previous.close(); this.hosts.delete(id); }
    if (this.closed) throw new Error('deployment closed during activation');
    this.assertTrustedServices(record.reference);
    this.assertBinding(binding, 'commit');
    save(this.stateFile, { ...state, active: record.reference, readiness: 'ready', pendingProposal: null });
    this.options.phase?.('activated', { proposalDigest: binding.proposalDigest, workerPids: host.workerPids });
    await this.release();
  }
  async abort(binding: PromotionBindingV1, handle: PreparedPromotionHandleV1 | null): Promise<void> {
    this.assertBinding(binding, 'abort'); await this.hold(binding.proposalDigest);
    const state = this.readState();
    if (state.pendingProposal !== null && state.pendingProposal !== binding.proposalDigest) throw new Error('cannot abort a different prepared deployment');
    if (handle) this.prepared(binding, handle);
    const candidateId = suffix(binding.proposalDigest), host = this.hosts.get(candidateId);
    if (host) { await host.close(); this.hosts.delete(candidateId); }
    save(this.stateFile, { ...state, readiness: 'ready', pendingProposal: null });
    await this.hostFor(state.active);
    this.options.phase?.('aborted', { proposalDigest: binding.proposalDigest, workerPids: this.hosts.get(state.active.id)!.workerPids });
    await this.release();
  }
  async recover(binding: PromotionBindingV1, handle: PreparedPromotionHandleV1 | null, decision: 'commit' | 'abort'): Promise<void>;
  async recover(): Promise<ProductionAdmissionState>;
  async recover(binding?: PromotionBindingV1, handle?: PreparedPromotionHandleV1 | null, decision?: 'commit' | 'abort'): Promise<void | ProductionAdmissionState> {
    if (!binding) return this.options.coordinator.recover(this);
    if (decision === 'commit') { if (!handle) throw new Error('committed process deployment lacks prepared handle'); await this.activate(binding, handle); }
    else await this.abort(binding, handle ?? null);
  }
  async close(): Promise<void> { this.closed = true; await Promise.all([...this.hosts.values()].map(host => host.close())); this.hosts.clear(); await this.release(); }
}
