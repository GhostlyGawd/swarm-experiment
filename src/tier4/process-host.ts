import { randomUUID, type KeyObject } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { walk, type Term, type Ty } from '../tier1/ast.ts';
import { decode as decodeIR, encode as encodeIR } from '../tier1/agent-ir.ts';
import { GraphStore } from '../tier1/store.ts';
import { atomicWrite } from '../tier1/persistence.ts';
import { capability, type CapabilityName, type NodeRef, type SymbolId } from '../tier1/ids.ts';
import { CapabilityRegistry, CapabilitySealer, RevocationList, type CapabilityToken } from '../tier2/ocap.ts';
import { ScopedGrantAuthority, validateScopedGrant, type ScopedGrantV2 } from '../tier2/scoped-grants.ts';
import { assertSignedEffectResourcePolicy, assertSignedEffectResourcePolicyV2, assertSignedEffectResourcePolicyV3, assertSignedEffectResourcePolicyV4, assertEffectResourceAdapter, assertEffectResourceAdapterV2, assertEffectResourceAdapterV3, assertEffectResourceAdapterV4, effectResourcePath as signedEffectResourcePath, effectResourcePathV2, effectResourcePathV3, effectResourcePathV4, effectResourcePolicyDigest, effectResourcePolicyDigestV2, effectResourcePolicyDigestV3, effectResourcePolicyDigestV4, type SignedEffectResourcePolicyV1, type SignedEffectResourcePolicyV2, type SignedEffectResourcePolicyV3, type SignedEffectResourcePolicyV4 } from '../tier2/effect-resource-policy.ts';
import { assertEffectSignerAnchor, assertAnchoredEffectPolicy, type EffectSignerAnchor } from '../tier2/effect-signer-anchor.ts';
import { assertBeforeDeadline, assertGrantLifetime, assertTrustedClockAnchor, type TrustedClockAnchor } from '../tier2/trusted-clock-anchor.ts';
import { assertEffectJournalWitnessCatalog, selectEffectJournalWitness, type EffectJournalWitnessCatalog } from '../fabric/effect-journal-witness.ts';
import { underlying } from '../tier2/typecheck.ts';
import { ProductionRuntime } from '../tier3/compile.ts';
import { effectPayloadDigest, type EffectEventV1, type EffectRequestV1 } from '../fabric/effects.ts';
import { EffectInvocationError, brokerAdapterIdentity, brokerWasmAdapterCapability, brokerAttestContext, brokerBind, brokerInvoke, brokerPinTrustedClock, brokerPinWitness, brokerReconcileLast, brokerReconcileRecorded, brokerInspectRecorded, brokerMode, type RuntimeEffectRouter } from '../tier3/effects.ts';
import type { ExecutionResult } from '../tier3/runtime.ts';
import type { Value } from '../tier3/values.ts';
import { JournalLock } from '../fabric/journal-lock.ts';
import { decodeCanonical, encodeCanonical, exactObject, identifier, decimal, validateTaggedValue, type LogicalRefV1, type TaggedValueV1 } from '../fabric/encoding.ts';
import { decodeExecutionManifest, encodeExecutionManifest, executionManifestDigest, domainDigest, validateDigest, type Digest, type ExecutionManifestV1 } from '../fabric/identity.ts';
import { validateRuntimeSnapshot, runtimeSnapshotDigest, type RuntimeSnapshotV1 } from '../fabric/snapshot.ts';
import { ProcessChannel, encodeProcessExecution, decodeProcessExecution, type ProcessCallRequest, type ProcessEffectRequest, type ProcessCallResult } from './process-channel.ts';
import { encodeProcessValue, decodeProcessValue, fromWireSnapshot, toWireSnapshot, processBoundaryId, type ProcessScope } from './process-values.ts';
import { TopologyHost } from './host.ts';
import { callGraph, DEFAULT_COST_MODEL, type TopologyPlan } from './topology.ts';
import { compileResumableProgram, type ResumableProgram } from '../tier3/resumable-program.ts';
import { validateExecutedCheckpoint } from '../tier3/resumable-runtime.ts';
import { checkpointDigest, eventDigest, type ResumableSnapshot } from '../tier3/resumable-state.ts';
import { validateProcessCheckpointBinding, processCheckpointBindingDigest, processCheckpointReceiptDigest, validateCheckpointExtension, assertBaseProjection, projectProcessCheckpoint, processReferenceFromCheckpoint, writeProcessCheckpoint, readProcessCheckpoint, retainedProcessCheckpointExists, writeCheckpointEffectAudit, readCheckpointEffectAudit, writeProcessPackedLayout, readProcessPackedLayout, type ProcessCheckpointBinding, type ProcessCheckpointLease, type ProcessCheckpointReceipt, type ProcessCheckpointAuthorization, type ProcessCheckpointAction, type ProcessCheckpointControlRequest, type ProcessCheckpointControl, checkpointControlDigest, validateCheckpointControlRequest, validateCheckpointControlTransition } from './process-checkpoint-contract.ts';
import type { PackedLayout } from '../tier3/packed-heap.ts';
import { PackedNativeProcessRunner, type PackedNativeRun } from './packed-native-process.ts';
import { validateProcessArguments, validateProcessResult, validateProcessAllocation } from './process-type-validation.ts';

export const PROCESS_INVOKE = capability('cap:process:invoke');
export type ProcessInvocationGrant = CapabilityToken | ScopedGrantV2;
function ensureDurableDirectory(path: string): void {
  if (existsSync(path)) return;
  ensureDurableDirectory(dirname(path));
  try { mkdirSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  for (const directory of [path, dirname(path)]) {
    const fd = openSync(directory, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); }
  }
}
/** External IDs occupy a separate namespace from internal boundary paths. */
export function processExecutionId(heapId: string, operationId: string): Digest {
  identifier(heapId); identifier(operationId);
  return domainDigest('aether.process-execution/1', { heapId, operationId });
}
type WireExecution = ReturnType<typeof encodeProcessExecution>;
interface EffectRecord {
  id: string; capability: CapabilityName; requestDigest: Digest; snapshotDigest: Digest;
  unit: string; from: SymbolId; args: TaggedValueV1[]; outcomeDigest: Digest | null;
  parentOperationId: string; index: number;
  state: 'requested' | 'dispatching' | 'committed' | 'rejected' | 'aborted' | 'indeterminate';
  value: TaggedValueV1 | null; code: string | null;
}
interface CallBoundary {
  id: string; parentOperationId: string; index: number; from: SymbolId; to: SymbolId; fromUnit: string; toUnit: string;
  args: TaggedValueV1[]; snapshotDigest: Digest; requestDigest: Digest;
}
interface CallRecord {
  operationId: string; requestDigest: Digest; symbol: SymbolId; args: TaggedValueV1[];
  generation: string; unit: string; state: 'running' | 'completed' | 'indeterminate' | 'aborted';
  before: RuntimeSnapshotV1; latest: RuntimeSnapshotV1; execution: WireExecution | null;
  executionDigest: Digest | null;
  effects: EffectRecord[]; failure: string | null;
  boundaries: CallBoundary[];
  recovery: { strategy: 'isolated-replay' | 'abort-before-effects' | 'abort-readonly-wasm'; evidenceDigest: Digest } | null;
}
interface MigrationRecord {
  migrationId: string; requestDigest: Digest; symbol: SymbolId; target: string;
  fromGeneration: string; toGeneration: string; state: 'requested' | 'prepared' | 'committed' | 'finalized' | 'aborted';
  beforePlan: string; afterPlan: string | null; before: RuntimeSnapshotV1; after: RuntimeSnapshotV1 | null; failure: string | null;
  decisionDigest: Digest;
}
interface AllocationRecord {
  operationId: string; requestDigest: Digest; reference: LogicalRefV1; ty: Ty; fields: Readonly<Record<string, TaggedValueV1>>;
  requestedUnit: string | null; unit: string; beforeSnapshotDigest: Digest; afterSnapshotDigest: Digest; receiptDigest: Digest;
}
interface StateHead {
  sequence: string; parent: Digest | null; generation: string; planDigest: Digest; snapshotDigest: Digest;
  cause: { kind: 'initial' | 'allocation' | 'call' | 'migration' | 'abort' | 'checkpoint'; operationId: string; subjectDigest: Digest }; digest: Digest;
}
interface HostJournal {
  format: 'aether.process-host/1' | 'aether.process-host/2' | 'aether.process-host/3'; configuration: Digest; generation: string; plan: string;
  snapshot: RuntimeSnapshotV1; calls: CallRecord[]; migrations: MigrationRecord[];
  allocations: AllocationRecord[];
  snapshots: Array<{ digest: Digest; snapshot: RuntimeSnapshotV1 }>;
  heads: StateHead[];
  checkpointLeases?: ProcessCheckpointLease[]; checkpointReceipts?: ProcessCheckpointReceipt[]; checkpointControls?: ProcessCheckpointControl[];
}
export type ProcessHostCallResult =
  | { state: 'completed'; operationId: string; generation: string; unit: string; execution: WireExecution }
  | { state: 'indeterminate' | 'aborted'; operationId: string; generation: string; unit: string; reason: string };
/** This summary is reconstructed from the validated durable host journal. A
 * dispatching/indeterminate effect is treated as a possible external commit. */
export interface ProcessOperationEffectDisposition {
  readonly operationId: string;
  readonly state: CallRecord['state'];
  readonly effects: readonly Readonly<{ id: string; state: EffectRecord['state']; requestDigest: Digest; outcomeDigest: Digest | null }>[];
  readonly safeToAbortBeforeEffects: boolean;
  readonly possibleExternalCommit: boolean;
  readonly evidenceDigest: Digest;
}
export interface ProcessEffectContext {
  /** Stable boundary ID. Pass this as BrokerEffectRouter.executionId. */
  readonly operationId: string;
  readonly rootOperationId: string;
  readonly unit: string;
  readonly generation: string;
  readonly manifest: ExecutionManifestV1;
  readonly capability: CapabilityName;
  readonly mode: 'live' | 'replay';
  readonly snapshot: RuntimeSnapshotV1;
  /** Signed V4 profile only; factory must use these exact host values. */
  readonly policyEpoch?: string;
  readonly deadline?: string;
  readonly clockDomain?: string;
  readonly grantRef?: string;
}
export type ProcessHostPhase = 'call-intent' | 'boundary' | 'effect-requested' | 'effect-recorded' | 'call-before-commit' | 'call-committed' | 'migration-requested' | 'migration-prepared' | 'migration-before-commit' | 'migration-committed' | 'migration-finalized' | 'checkpoint-started' | 'checkpoint-saved' | 'checkpoint-before-commit' | 'checkpoint-committed' | 'checkpoint-aborted' | 'checkpoint-control-before-commit' | 'checkpoint-control-committed';
export interface ProcessHostOptions {
  readonly directory: string;
  readonly module: Term;
  readonly manifest: ExecutionManifestV1;
  readonly plan: TopologyPlan;
  readonly registry: CapabilityRegistry;
  readonly sealer: CapabilitySealer;
  /** Explicit strict profile; its presence is committed into host identity. */
  readonly scopedGrants?: ScopedGrantAuthority;
  /** Trusted adapter policy maps the concrete effect target to grant path suffixes. */
  readonly effectResourcePath?: (request: Readonly<{ capability: CapabilityName; from: SymbolId; unit: string; generation: string; args: readonly TaggedValueV1[] }>) => readonly string[];
  /** Versioned identity of the independently trusted adapter policy above. */
  readonly effectResourcePolicyDigest?: Digest;
  /** Content-bound policy for deterministic target extraction in strict mode. */
  readonly signedEffectResourcePolicy?: SignedEffectResourcePolicyV1 | SignedEffectResourcePolicyV2 | SignedEffectResourcePolicyV3 | SignedEffectResourcePolicyV4;
  /** Independent production trust source; not supplied by a reloadable services factory. */
  readonly effectSignerAnchor?: EffectSignerAnchor;
  /** Independently provisioned time/revision source; required by clocked Wasm V7. */
  readonly trustedClockAnchor?: TrustedClockAnchor;
  /** Operator-held per-operation witness selection for isolated Wasm V8. */
  readonly effectJournalWitnessCatalog?: EffectJournalWitnessCatalog;
  /** Explicitly reopen anchored V2 journals under their original host-config/2 identity. */
  readonly legacyAnchoredEffectPolicy?: 'anchored-v2';
  /** New isolated Wasm signed-policy profile with host-config/4 identity. */
  readonly anchoredEffectPolicyProfile?: 'isolated-wasm-v4' | 'isolated-wasm-v5-clock' | 'isolated-wasm-v6-witnessed';
  /** Compatibility-only signer authority for explicitly selected old profiles. */
  readonly effectResourceSignerKey?: KeyObject | string;
  readonly currentEffectPolicyEpoch?: () => string;
  /** Explicitly reopen historical signed policies whose signer key came from the caller. */
  readonly legacyEffectSignerTrust?: 'factory-v1';
  readonly revocations?: RevocationList;
  readonly effectRouterFactory?: (context: ProcessEffectContext) => RuntimeEffectRouter;
  /** Privileged adoption/resumption of exact checkpoint state. No implicit authority from checkpoint bytes. */
  readonly authorizeCheckpoint?: (request: ProcessCheckpointAuthorization) => boolean;
  readonly authorizeRecovery?: (operationId: string, strategy: 'isolated-replay' | 'abort-before-effects' | 'abort-readonly-wasm') => boolean;
  /** Caller must authorize any same-schema manifest/epoch rebinding before opening a new deployment directory. */
  readonly initialSnapshot?: RuntimeSnapshotV1;
  readonly initialGeneration?: string;
  readonly timeoutMs?: number;
  readonly lockWaitMs?: number;
  readonly maxWorkers?: number;
  readonly onPhase?: (phase: ProcessHostPhase, detail: Readonly<{ operationId: string; generation: string }>) => void;
}
export interface ProcessCheckpointAccess {
  readonly binding: ProcessCheckpointBinding; readonly program: ResumableProgram; readonly before: RuntimeSnapshotV1; readonly checkpoint: ResumableSnapshot;
  readonly assertAuthority: () => void; readonly save: (snapshot: ResumableSnapshot) => void;
  readonly replayBarrier: ResumableSnapshot | null; readonly controlReceipt: ProcessCheckpointControl | null;
  readonly finishControl: (snapshot: ResumableSnapshot, effectAudit: readonly EffectEventV1[], nativeRun?: PackedNativeRun) => ProcessCheckpointControl;
  readonly commit: (snapshot: ResumableSnapshot, effectAudit: readonly EffectEventV1[]) => ProcessCheckpointReceipt;
  readonly abort: () => void;
}
interface Frame { operationId: string; symbol: SymbolId; unit: string; nextBoundary: number }
interface Active {
  journal: HostJournal; call: CallRecord; snapshot: RuntimeSnapshotV1; frames: Frame[];
  authority: ReadonlySet<CapabilityName>; mode: 'live' | 'replay'; cancelled: boolean;
  tokens: readonly ProcessInvocationGrant[];
}
function copy<T>(value: T): T { return decodeCanonical(encodeCanonical(value)) as T; }
function equal(left: unknown, right: unknown): boolean { return Buffer.from(encodeCanonical(left)).equals(Buffer.from(encodeCanonical(right))); }
function freeze<T>(value: T): T { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
function planBytes(plan: TopologyPlan): string {
  const active = new Set<object>();
  const normalized = (value: unknown): unknown => {
    if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
    if (typeof value === 'number') { if (!Number.isFinite(value)) throw new TypeError('nonfinite topology cost'); return value; }
    if (!value || typeof value !== 'object' || active.has(value)) throw new TypeError('unsupported or cyclic topology value');
    active.add(value);
    let result: unknown;
    if (Array.isArray(value)) result = value.map(normalized);
    else {
      const keys = Object.keys(value).sort(); exactObject(value, keys);
      result = Object.fromEntries(keys.filter(key => (value as Record<string, unknown>)[key] !== undefined).map(key => [key, normalized((value as Record<string, unknown>)[key])]));
    }
    active.delete(value); return result;
  };
  return JSON.stringify(normalized(plan));
}
function effectOutcomeDigest(effect: EffectRecord): Digest | null { return ['requested', 'dispatching'].includes(effect.state) ? null : domainDigest('aether.process-effect-outcome/1', { requestDigest: effect.requestDigest, state: effect.state, value: effect.value, code: effect.code }); }
function callOutcomeDigest(call: CallRecord): Digest | null { return call.state === 'completed' ? domainDigest('aether.process-call-outcome/1', { requestDigest: call.requestDigest, generation: call.generation, unit: call.unit, snapshot: runtimeSnapshotDigest(call.latest), execution: call.execution }) : null; }
function migrationDecisionDigest(migration: Omit<MigrationRecord, 'decisionDigest'> | MigrationRecord): Digest { return domainDigest('aether.process-migration-decision/1', { requestDigest: migration.requestDigest, fromGeneration: migration.fromGeneration, toGeneration: migration.toGeneration, beforePlan: migration.beforePlan, afterPlan: migration.afterPlan, before: runtimeSnapshotDigest(migration.before), after: migration.after ? runtimeSnapshotDigest(migration.after) : null }); }
function allocationReceiptDigest(allocation: AllocationRecord): Digest { const { receiptDigest: _digest, ...body } = allocation; return domainDigest('aether.process-allocation-receipt/1', body); }
function stateHeadDigest(head: StateHead): Digest { const { digest: _digest, ...body } = head; return domainDigest('aether.process-state-head/1', body); }
function reepoch(snapshot: RuntimeSnapshotV1, epoch: string, units: ReadonlySet<string>, fallback: string): RuntimeSnapshotV1 {
  const value = (v: TaggedValueV1): TaggedValueV1 => v.tag === 'ref' ? { tag: 'ref', value: { ...v.value, ownerEpoch: epoch } }
    : v.tag === 'sequence' ? { tag: 'sequence', items: v.items.map(value) } : v.tag === 'result' ? { ...v, value: value(v.value) } : v;
  const result: RuntimeSnapshotV1 = { ...snapshot, records: snapshot.records.map(record => ({ ...record, fields: record.fields.map(([key, item]) => [key, value(item)] as const) })), ownership: snapshot.ownership.map(owner => ({ ...owner, epoch, unit: units.has(owner.unit) ? owner.unit : fallback })) };
  validateRuntimeSnapshot(result); return result;
}

/** Same-host multi-process coordinator with a single canonical state domain.
 * Unit ownership labels are placement metadata, not independent concurrent
 * record writers. Full heaps cross each suspended call/effect boundary. No JS
 * frames/closures are serialized; incomplete calls require privileged recovery. */
export class ProcessHost {
  private readonly options: ProcessHostOptions;
  private readonly module: Term;
  private readonly manifest: ExecutionManifestV1;
  private readonly registry: CapabilityRegistry;
  private readonly configuration: Digest;
  private readonly signedEffectResourcePolicy: SignedEffectResourcePolicyV1 | SignedEffectResourcePolicyV2 | SignedEffectResourcePolicyV3 | SignedEffectResourcePolicyV4 | null;
  private readonly file: string;
  private readonly lock: JournalLock;
  private readonly declarations = new Map<SymbolId, Extract<Term, { kind: 'FunctionDecl' }>>();
  private readonly edges: Map<SymbolId, Set<SymbolId>>;
  private channels = new Map<string, ProcessChannel>();
  private workersGeneration: string | null = null;
  private active: Active | null = null;
  private closed = false;
  private checkpointProgramCache: ResumableProgram | null = null;

  private constructor(options: ProcessHostOptions) {
    if (options.effectResourcePath && !options.scopedGrants || !!options.effectResourcePath !== !!options.effectResourcePolicyDigest) throw new TypeError('strict effect resource policy requires an exact policy digest');
    if (options.effectResourcePolicyDigest) validateDigest(options.effectResourcePolicyDigest, 'aether.effect-resource-policy/1');
    const signed = options.signedEffectResourcePolicy !== undefined;
    const anchored = options.effectSignerAnchor !== undefined;
    const witnessedWasm = options.anchoredEffectPolicyProfile === 'isolated-wasm-v6-witnessed';
    const clockedWasm = witnessedWasm || options.anchoredEffectPolicyProfile === 'isolated-wasm-v5-clock';
    if (options.anchoredEffectPolicyProfile !== undefined &&
        !['isolated-wasm-v4', 'isolated-wasm-v5-clock', 'isolated-wasm-v6-witnessed'].includes(options.anchoredEffectPolicyProfile))
      throw new TypeError('invalid isolated Wasm anchored effect policy profile');
    if (clockedWasm) assertTrustedClockAnchor(options.trustedClockAnchor);
    else if (options.trustedClockAnchor !== undefined) throw new TypeError('trusted clock requires clocked Wasm profile');
    if (witnessedWasm) {
      assertEffectJournalWitnessCatalog(options.effectJournalWitnessCatalog);
      if (options.effectJournalWitnessCatalog.repositoryId !== options.effectSignerAnchor?.repositoryId
        || options.effectJournalWitnessCatalog.clockDomain !== options.trustedClockAnchor?.clockDomain)
        throw new TypeError('effect witness catalog differs from signed repository/clock');
    } else if (options.effectJournalWitnessCatalog !== undefined)
      throw new TypeError('effect witness catalog requires witnessed Wasm profile');
    if (options.anchoredEffectPolicyProfile && (!anchored || options.legacyAnchoredEffectPolicy
      || options.signedEffectResourcePolicy?.format !== 'aether.signed-effect-resource-policy/4'))
      throw new TypeError('isolated Wasm policy requires an independent anchor and signed policy v4');
    if (clockedWasm && options.signedEffectResourcePolicy?.format === 'aether.signed-effect-resource-policy/4' &&
        options.signedEffectResourcePolicy.body.rules.some(rule => rule.clockDomain !== options.trustedClockAnchor!.clockDomain))
      throw new TypeError('signed Wasm clock domain differs from independent authority');
    if (options.legacyAnchoredEffectPolicy !== undefined && options.legacyAnchoredEffectPolicy !== 'anchored-v2')
      throw new TypeError('invalid legacy anchored effect policy profile');
    if (options.legacyAnchoredEffectPolicy !== undefined && (!anchored || options.signedEffectResourcePolicy?.format !== 'aether.signed-effect-resource-policy/2'))
      throw new TypeError('legacy anchored effect policy requires anchor and signed policy v2');
    if (options.legacyEffectSignerTrust !== undefined && options.legacyEffectSignerTrust !== 'factory-v1')
      throw new TypeError('invalid legacy effect signer trust profile');
    if (anchored && options.legacyEffectSignerTrust !== undefined)
      throw new TypeError('anchored ProcessHost cannot use legacy signer trust');
    if (signed && !anchored && options.legacyEffectSignerTrust !== 'factory-v1')
      throw new TypeError('unanchored signed effect policy requires explicit legacy signer trust profile');
    if (signed && !anchored && options.signedEffectResourcePolicy?.format === 'aether.signed-effect-resource-policy/4')
      throw new TypeError('isolated Wasm policy requires independent signer anchor');
    if (!signed && options.legacyEffectSignerTrust !== undefined)
      throw new TypeError('legacy signer trust profile requires a signed effect policy');
    if (anchored) {
      assertEffectSignerAnchor(options.effectSignerAnchor);
      if (!options.scopedGrants || options.scopedGrants.repositoryId !== options.effectSignerAnchor!.repositoryId
        || options.effectResourceSignerKey !== undefined || options.currentEffectPolicyEpoch !== undefined
        || options.effectResourcePath !== undefined || options.effectResourcePolicyDigest !== undefined
        || signed && options.signedEffectResourcePolicy?.format !== (options.legacyAnchoredEffectPolicy === 'anchored-v2'
          ? 'aether.signed-effect-resource-policy/2' : options.anchoredEffectPolicyProfile
            ? 'aether.signed-effect-resource-policy/4' : 'aether.signed-effect-resource-policy/3'))
        throw new TypeError('anchored ProcessHost requires independent signer authority and signed policy v3 or an explicit anchored-v2/isolated-wasm-v4 profile');
    }
    if (signed && (!options.scopedGrants || options.effectResourcePath || options.effectResourcePolicyDigest)
      || !anchored && (signed !== (options.effectResourceSignerKey !== undefined)
        || signed !== (options.currentEffectPolicyEpoch !== undefined))) throw new TypeError('signed effect resource policy requires strict grants, signer key, and epoch source');
    this.options = { ...options, plan: JSON.parse(planBytes(options.plan)) as TopologyPlan, initialSnapshot: options.initialSnapshot ? copy(options.initialSnapshot) : undefined };
    this.module = decodeIR(encodeIR(options.module).text);
    this.manifest = decodeExecutionManifest(encodeExecutionManifest(options.manifest));
    if (new GraphStore().intern(this.module) !== this.manifest.astRoot) throw new TypeError('ProcessHost module/manifest mismatch');
    if (anchored && [...walk(this.module)].some(node => node.kind === 'Invoke') && !signed)
      throw new TypeError('anchored effectful ProcessHost requires a signed effect policy');
    if (signed) {
      if (anchored)
        assertAnchoredEffectPolicy(options.effectSignerAnchor!, options.signedEffectResourcePolicy as SignedEffectResourcePolicyV2 | SignedEffectResourcePolicyV3 | SignedEffectResourcePolicyV4,
          this.manifest, options.scopedGrants!.repositoryId, options.anchoredEffectPolicyProfile ? 'anchored-v4' : options.legacyAnchoredEffectPolicy);
      else if (options.signedEffectResourcePolicy?.format === 'aether.signed-effect-resource-policy/4')
        throw new TypeError('isolated Wasm policy requires independent signer anchor');
      else if (options.signedEffectResourcePolicy?.format === 'aether.signed-effect-resource-policy/3')
        assertSignedEffectResourcePolicyV3(options.signedEffectResourcePolicy, this.manifest, options.scopedGrants!.repositoryId,
          options.currentEffectPolicyEpoch!(), options.effectResourceSignerKey!);
      else if (options.signedEffectResourcePolicy?.format === 'aether.signed-effect-resource-policy/2')
        assertSignedEffectResourcePolicyV2(options.signedEffectResourcePolicy, this.manifest, options.scopedGrants!.repositoryId,
          options.currentEffectPolicyEpoch!(), options.effectResourceSignerKey!);
      else assertSignedEffectResourcePolicy(options.signedEffectResourcePolicy, this.manifest, options.scopedGrants!.repositoryId,
        options.currentEffectPolicyEpoch!(), options.effectResourceSignerKey!);
      this.signedEffectResourcePolicy = freeze(copy(options.signedEffectResourcePolicy!));
    } else this.signedEffectResourcePolicy = null;
    const members = this.module.kind === 'Module' ? this.module.members : [this.module];
    for (const member of members) if (member.kind === 'FunctionDecl') this.declarations.set(member.symbol, member);
    if (!this.declarations.size) throw new Error('ProcessHost needs function declarations');
    this.edges = callGraph(this.module);
    for (const [symbol, declaration] of this.declarations) for (const term of walk(declaration)) if (term.kind === 'SeqMap' || term.kind === 'SeqFold') this.edges.get(symbol)!.add(term.callee);
    this.registry = new CapabilityRegistry();
    for (const name of options.registry.names) this.registry.define(freeze(copy(options.registry.get(name)!)));
    this.validatePlan(options.plan);
    this.configuration = domainDigest(anchored ? witnessedWasm ? 'aether.process-host-config/6' : clockedWasm ? 'aether.process-host-config/5' : options.anchoredEffectPolicyProfile === 'isolated-wasm-v4' ? 'aether.process-host-config/4' : options.legacyAnchoredEffectPolicy === 'anchored-v2' ? 'aether.process-host-config/2' : 'aether.process-host-config/3' : 'aether.process-host-config/1', { manifest: executionManifestDigest(this.manifest), registry: [...this.registry.names].sort().map(name => this.registry.get(name)!), initialPlan: planBytes(options.plan), initialGeneration: options.initialGeneration ?? '1', initialSnapshot: options.initialSnapshot ? runtimeSnapshotDigest(options.initialSnapshot) : null,
      ...(options.scopedGrants ? { grantProfile: 'aether.scoped-grants/2', grantRepositoryId: options.scopedGrants.repositoryId, effectResourcePolicy: this.signedEffectResourcePolicy?.format === 'aether.signed-effect-resource-policy/4' ? effectResourcePolicyDigestV4(this.signedEffectResourcePolicy.body)
        : this.signedEffectResourcePolicy?.format === 'aether.signed-effect-resource-policy/3' ? effectResourcePolicyDigestV3(this.signedEffectResourcePolicy.body)
        : this.signedEffectResourcePolicy?.format === 'aether.signed-effect-resource-policy/2' ? effectResourcePolicyDigestV2(this.signedEffectResourcePolicy.body)
        : this.signedEffectResourcePolicy ? effectResourcePolicyDigest(this.signedEffectResourcePolicy.body) : options.effectResourcePolicyDigest ?? null,
        effectResourcePolicySigner: this.signedEffectResourcePolicy?.signer ?? null } : {}),
      ...(anchored ? { effectSignerAnchor: options.effectSignerAnchor!.digest } : {}),
      ...(clockedWasm ? { trustedClockAnchor: options.trustedClockAnchor!.digest } : {}),
      ...(witnessedWasm ? { effectJournalWitnessCatalog: options.effectJournalWitnessCatalog!.digest } : {}) });
    ensureDurableDirectory(options.directory);
    this.file = join(options.directory, 'host.json');
    this.lock = new JournalLock({ directory: join(options.directory, 'host-lock'), domain: 'aether.process-host-lock', busyError: 'process_host_busy: another state transition is active' });
  }
  static async open(options: ProcessHostOptions): Promise<ProcessHost> {
    const host = new ProcessHost(options);
    options = host.options;
    try {
      await host.lock.runAsync(async () => {
        let journal: HostJournal;
        if (existsSync(host.file)) journal = host.read();
        else {
          const generation = options.initialGeneration ?? '1'; decimal(generation);
          const snapshot: RuntimeSnapshotV1 = options.initialSnapshot ? copy(options.initialSnapshot) : { format: 'aether.state/1', executionManifest: executionManifestDigest(host.manifest), heapId: `heap-${randomUUID()}`, nextObjectId: '1', eventCursor: '0', records: [], ownership: [] };
          host.validateSnapshot(snapshot, generation, options.plan);
          journal = { format: 'aether.process-host/1', configuration: host.configuration, generation, plan: planBytes(options.plan), snapshot, calls: [], migrations: [], allocations: [], snapshots: [], heads: [] };
          host.retain(journal, snapshot); host.appendHead(journal, { kind: 'initial', operationId: 'initial', subjectDigest: host.configuration }); host.persist(journal);
        }
        for (const call of journal.calls) if (call.state === 'running') { call.state = 'indeterminate'; call.failure = 'coordinator restarted without a durable completed outcome'; }
        for (const migration of journal.migrations) {
          if (migration.state === 'requested' || migration.state === 'prepared') { migration.state = 'aborted'; migration.failure = 'no durable migration commit; original generation remains authoritative'; }
          else if (migration.state === 'committed') {
            if (journal.generation !== migration.toGeneration || journal.plan !== migration.afterPlan || runtimeSnapshotDigest(journal.snapshot) !== runtimeSnapshotDigest(migration.after!)) throw new Error('migration decision/state mismatch');
          }
        }
        host.persist(journal); host.preflightV4Host(journal); await host.ensureWorkers(journal);
        for (const migration of journal.migrations) if (migration.state === 'committed') migration.state = 'finalized';
        host.persist(journal);
      }, options.lockWaitMs ?? 5000);
      return host;
    } catch (error) { await host.close(); throw error; }
  }
  get generation(): string { return this.read().generation; }
  /** Check the actual generation and heap presented by a ready host, without
   * issuing an effect or granting the factory any external sink authority. */
  private preflightV4Host(journal: HostJournal): void {
    const policy = this.signedEffectResourcePolicy;
    if (policy?.format !== 'aether.signed-effect-resource-policy/4') return;
    if (!this.options.effectRouterFactory) throw new TypeError('isolated Wasm host requires a broker adapter factory');
    const plan = JSON.parse(journal.plan) as TopologyPlan, manifestDigest = executionManifestDigest(this.manifest);
    for (const rule of policy.body.rules) {
      const unit = plan.units.find(candidate => candidate.capabilities.includes(rule.capability)
        && candidate.members.some(symbol => this.declarations.get(symbol)?.capabilities.includes(rule.capability)));
      if (!unit) throw new TypeError('isolated Wasm host rule has no executable placement');
      const operationId = domainDigest('aether.process-wasm-host-preflight/1', {
        configuration: this.configuration, generation: journal.generation, capability: rule.capability,
      });
      const grantRef = domainDigest('aether.process-effect-grant-ref/1', {
        configuration: this.configuration, operationId, capability: rule.capability, policyEpoch: policy.body.policyEpoch,
      });
      const router = this.options.effectRouterFactory(freeze({ operationId, rootOperationId: operationId,
        unit: unit.id, generation: journal.generation, manifest: copy(this.manifest), capability: rule.capability,
        mode: 'live' as const, snapshot: copy(journal.snapshot), policyEpoch: policy.body.policyEpoch,
        deadline: rule.deadline, clockDomain: rule.clockDomain, grantRef }));
      if (brokerMode(router) !== 'live') throw new TypeError('isolated Wasm host preflight router mode mismatch');
      brokerBind(router, this.manifest.astRoot as NodeRef);
      assertEffectResourceAdapterV4(policy, rule.capability, { ...brokerAdapterIdentity(router, rule.capability),
        artifactCapability: brokerWasmAdapterCapability(router, rule.capability) });
      brokerAttestContext(router, { executionId: operationId, manifestDigest, mode: 'live',
        policyEpoch: policy.body.policyEpoch, deadline: rule.deadline, clockDomain: rule.clockDomain,
        capability: rule.capability, grantRef });
      if (this.options.effectJournalWitnessCatalog)
        brokerPinWitness(router, selectEffectJournalWitness(this.options.effectJournalWitnessCatalog, operationId));
    }
    for (const call of journal.calls) this.assertV4TerminalEffects(journal, call);
  }
  /** Stable identity for a durable supervisor sharing this host's state. */
  fallbackIdentity(): Readonly<{ configuration: Digest; manifest: Digest; storage: string }> {
    this.assertOpen(); return Object.freeze({ configuration: this.configuration, manifest: executionManifestDigest(this.manifest), storage: realpathSync(this.options.directory) });
  }
  get plan(): TopologyPlan { return JSON.parse(this.read().plan) as TopologyPlan; }
  get workerPids(): Readonly<Record<string, number>> { return Object.freeze(Object.fromEntries([...this.channels].map(([unit, channel]) => [unit, channel.pid]))); }
  unitFor(symbol: SymbolId): string | null { return this.unitIn(this.plan, symbol); }
  issueTokens(symbol: SymbolId, ttlMs = 60000): CapabilityToken[] {
    this.assertOpen();
    if (this.options.scopedGrants) throw new Error('strict ProcessHost requires versioned scoped grants');
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1) throw new Error('invalid invocation token lifetime');
    const journal = this.read(), plan = JSON.parse(journal.plan) as TopologyPlan, unit = this.unitIn(plan, symbol);
    if (!unit) throw new Error('unplaced function');
    return [PROCESS_INVOKE, ...this.declarations.get(symbol)!.capabilities].map(cap => this.options.sealer.issue(cap, this.tokenScope(unit, journal.generation, symbol), ttlMs));
  }
  issueScopedTokens(symbol: SymbolId, ttlMs = 60000, resourceScopes: ReadonlyMap<CapabilityName, readonly string[]> = new Map()): ScopedGrantV2[] {
    this.assertOpen(); const authority = this.options.scopedGrants;
    if (!authority) throw new Error('versioned scoped grants are not configured');
    const journal = this.read(), unit = this.unitIn(JSON.parse(journal.plan) as TopologyPlan, symbol);
    if (!unit) throw new Error('unplaced function');
    const issued = [...new Set([PROCESS_INVOKE, ...this.declarations.get(symbol)!.capabilities])]
      .map(cap => authority.issue({ capability: cap, audience: symbol, path: [...this.scopedGrantPath(unit, journal.generation), ...(cap === PROCESS_INVOKE ? [] : resourceScopes.get(cap) ?? [])] }, ttlMs));
    if (this.options.trustedClockAnchor) for (const token of issued)
      assertGrantLifetime(this.options.trustedClockAnchor, token.body.issuedAt, token.body.expiresAt);
    return issued;
  }
  /** Validate current deployment authority before serving a cross-version cached receipt. */
  authorizeInvocation(symbol: SymbolId, tokens: readonly ProcessInvocationGrant[]): void {
    this.assertOpen(); const journal = this.read(), unit = this.unitIn(JSON.parse(journal.plan) as TopologyPlan, symbol);
    if (!unit) throw new Error('unplaced function');
    this.authorize(symbol, unit, journal.generation, tokens);
  }
  async snapshot(): Promise<RuntimeSnapshotV1> { return this.lock.runAsync(async () => copy(this.read().snapshot), this.options.lockWaitMs ?? 5000); }
  status(): { unresolved: string[]; migrations: Array<{ migrationId: string; state: MigrationRecord['state'] }> } {
    const journal = this.read(); return { unresolved: journal.calls.filter(call => call.state === 'running' || call.state === 'indeterminate').map(call => call.operationId), migrations: journal.migrations.map(migration => ({ migrationId: migration.migrationId, state: migration.state })) };
  }
  operationResult(operationId: string): ProcessHostCallResult | null {
    this.assertOpen(); identifier(operationId); const journal = this.read(), call = journal.calls.find(call => call.operationId === operationId);
    return call ? this.result(call, journal) : null;
  }
  operationEffectDisposition(operationId: string): ProcessOperationEffectDisposition | null {
    this.assertOpen(); identifier(operationId);
    const journal = this.read(), call = journal.calls.find(item => item.operationId === operationId);
    if (!call) return null;
    this.assertV4TerminalEffects(journal, call);
    const effects = Object.freeze(call.effects.map(effect => Object.freeze({ id: effect.id, state: effect.state, requestDigest: effect.requestDigest, outcomeDigest: effect.outcomeDigest })));
    const safeToAbortBeforeEffects = effects.every(effect => ['requested', 'rejected', 'aborted'].includes(effect.state));
    const body = { operationId, state: call.state, effects };
    return Object.freeze({ ...body, safeToAbortBeforeEffects, possibleExternalCommit: !safeToAbortBeforeEffects,
      evidenceDigest: domainDigest('aether.process-effect-disposition/1', body) });
  }
  async allocateRecord(ty: Ty, fields: Readonly<Record<string, TaggedValueV1>>, options: { operationId: string; unit?: string }): Promise<LogicalRefV1> {
    identifier(options.operationId);
    ty = freeze(copy(ty)); fields = freeze(copy(fields)); options = Object.freeze({ operationId: options.operationId, ...(options.unit === undefined ? {} : { unit: options.unit }) });
    return this.lock.runAsync(async () => {
      this.assertOpen(); const journal = this.read(); this.assertReady(journal);
      const digest = domainDigest('aether.process-allocation/1', { ty, fields, unit: options.unit ?? null });
      const old = journal.allocations.find(allocation => allocation.operationId === options.operationId);
      if (old) { if (old.requestDigest !== digest) throw new Error('allocation_identity_conflict'); return copy(old.reference); }
      if (journal.calls.some(call => call.operationId === options.operationId)) throw new Error('operation ID already names a call');
      const plan = JSON.parse(journal.plan) as TopologyPlan, unit = options.unit ?? plan.units[0].id;
      if (!plan.units.some(candidate => candidate.id === unit)) throw new Error('allocation unit does not exist');
      validateProcessAllocation(ty, fields, journal.snapshot);
      const scope = this.scope(journal, unit), runtime = ProductionRuntime.compile(this.module, { registry: this.registry, policy: 'enforce' });
      runtime.importSnapshot(fromWireSnapshot(journal.snapshot, scope));
      const values = Object.fromEntries(Object.entries(fields).map(([name, value]) => { identifier(name); validateTaggedValue(value); return [name, decodeProcessValue(value, scope, journal.snapshot)]; }));
      const ref = runtime.allocateRecord(ty, values);
      const beforeSnapshotDigest = runtimeSnapshotDigest(journal.snapshot);
      journal.snapshot = toWireSnapshot(runtime.exportSnapshot(), scope, journal.snapshot);
      const reference = { heapId: journal.snapshot.heapId, objectId: String(ref.addr), ownerEpoch: journal.generation };
      const allocation: AllocationRecord = { operationId: options.operationId, requestDigest: digest, reference, ty, fields, requestedUnit: options.unit ?? null, unit, beforeSnapshotDigest, afterSnapshotDigest: runtimeSnapshotDigest(journal.snapshot), receiptDigest: '' };
      allocation.receiptDigest = allocationReceiptDigest(allocation); journal.allocations.push(allocation); this.retain(journal, journal.snapshot);
      this.appendHead(journal, { kind: 'allocation', operationId: allocation.operationId, subjectDigest: allocation.receiptDigest }); this.persist(journal);
      return copy(reference);
    }, this.options.lockWaitMs ?? 5000);
  }
  async call(symbol: SymbolId, args: readonly TaggedValueV1[], options: { operationId: string; tokens: readonly ProcessInvocationGrant[]; expectedSnapshot?: Digest; expectedGeneration?: string }): Promise<ProcessHostCallResult> {
    identifier(options.operationId); args.forEach(value => validateTaggedValue(value));
    if (options.expectedSnapshot !== undefined) validateDigest(options.expectedSnapshot);
    if (options.expectedGeneration !== undefined) decimal(options.expectedGeneration);
    args = freeze(copy([...args])); options = Object.freeze({ operationId: options.operationId, tokens: freeze(copy([...options.tokens])),
      ...(options.expectedSnapshot === undefined ? {} : { expectedSnapshot: options.expectedSnapshot }),
      ...(options.expectedGeneration === undefined ? {} : { expectedGeneration: options.expectedGeneration }) });
    return this.lock.runAsync(async () => {
      this.assertOpen(); const journal = this.read(), plan = JSON.parse(journal.plan) as TopologyPlan, unit = this.unitIn(plan, symbol);
      if (!unit) throw new Error('unplaced function');
      this.authorize(symbol, unit, journal.generation, options.tokens);
      const tokens = freeze(copy([...options.tokens]));
      const requestDigest = domainDigest('aether.process-call/1', { manifest: executionManifestDigest(this.manifest), symbol, args });
      const old = journal.calls.find(call => call.operationId === options.operationId);
      if (old) { if (old.requestDigest !== requestDigest) throw new Error('call_identity_conflict'); return this.result(old, journal); }
      this.assertReady(journal);
      if ((options.expectedGeneration !== undefined && journal.generation !== options.expectedGeneration)
        || (options.expectedSnapshot !== undefined && runtimeSnapshotDigest(journal.snapshot) !== options.expectedSnapshot))
        throw new Error('stale_process_fallback_base');
      if (journal.allocations.some(allocation => allocation.operationId === options.operationId)) throw new Error('operation ID already names an allocation');
      const scope = this.scope(journal, unit); args.forEach(value => decodeProcessValue(value, scope, journal.snapshot));
      validateProcessArguments(this.declarations.get(symbol)!, args, journal.snapshot);
      await this.ensureWorkers(journal);
      const call: CallRecord = { operationId: options.operationId, requestDigest, symbol, args: copy([...args]), generation: journal.generation, unit, state: 'running', before: copy(journal.snapshot), latest: copy(journal.snapshot), execution: null, executionDigest: null, effects: [], boundaries: [], failure: null, recovery: null };
      journal.calls.push(call); this.persist(journal);
      return this.execute(journal, call, 'live', tokens);
    }, this.options.lockWaitMs ?? 5000);
  }
  async recoverOperation(operationId: string, options: { strategy: 'isolated-replay' | 'abort-before-effects' | 'abort-readonly-wasm' } = { strategy: 'isolated-replay' }): Promise<ProcessHostCallResult> {
    identifier(operationId);
    options = Object.freeze({ strategy: options.strategy });
    if (!['isolated-replay', 'abort-before-effects', 'abort-readonly-wasm'].includes(options.strategy)) throw new Error('unknown recovery strategy');
    if (this.options.authorizeRecovery?.(operationId, options.strategy) !== true) throw new Error('recovery_authorization_denied');
    return this.lock.runAsync(async () => {
      this.assertOpen(); const journal = this.read(), call = journal.calls.find(call => call.operationId === operationId);
      this.requireRecoveryAuthorization(operationId, options.strategy);
      if (!call) throw new Error('unknown operation');
      if (call.state === 'completed' || call.state === 'aborted') return this.result(call, journal);
      if (call.generation !== journal.generation) throw new Error('cannot replay across a changed ownership generation');
      await this.stopWorkers();
      this.requireRecoveryAuthorization(operationId, options.strategy);
      if (options.strategy === 'abort-before-effects') {
        if (call.effects.some(effect => !['requested', 'rejected', 'aborted'].includes(effect.state))) throw new Error('cannot abort committed or indeterminate external effects');
        call.state = 'aborted'; call.failure = 'authorized abort before any possible external effect commit';
        call.recovery = { strategy: options.strategy, evidenceDigest: domainDigest('aether.process-recovery/1', { operationId, before: runtimeSnapshotDigest(call.before), effects: call.effects }) };
        this.requireRecoveryAuthorization(operationId, options.strategy);
        journal.snapshot = copy(call.before); this.appendHead(journal, { kind: 'abort', operationId, subjectDigest: call.recovery.evidenceDigest }); this.persist(journal); return this.result(call, journal);
      }
      if (options.strategy === 'abort-readonly-wasm') {
        const policy = this.signedEffectResourcePolicy;
        if (policy?.format !== 'aether.signed-effect-resource-policy/4'
          || call.effects.some(effect => !policy.body.rules.some(rule => rule.capability === effect.capability))
          || runtimeSnapshotDigest(journal.snapshot) !== runtimeSnapshotDigest(call.before))
          throw new Error('read-only Wasm abort lacks exact safe-state evidence');
        this.preflightV4Host(journal);
        const evidenceDigest = domainDigest('aether.process-readonly-wasm-abort/1', {
          operationId, before: runtimeSnapshotDigest(call.before), effects: call.effects,
          policy: effectResourcePolicyDigestV4(policy.body), configuration: this.configuration,
        });
        this.requireRecoveryAuthorization(operationId, options.strategy);
        call.state = 'aborted'; call.failure = 'authorized read-only Wasm abort; external guest effects are excluded by signed policy';
        call.recovery = { strategy: options.strategy, evidenceDigest };
        journal.snapshot = copy(call.before); this.appendHead(journal, { kind: 'abort', operationId, subjectDigest: evidenceDigest }); this.persist(journal);
        return this.result(call, journal);
      }
      if (options.strategy !== 'isolated-replay') throw new Error('unknown recovery strategy');
      if (this.signedEffectResourcePolicy?.format === 'aether.signed-effect-resource-policy/4'
        && !this.reconcileV4Call(journal, call)) return this.result(call, journal);
      await this.ensureWorkers(journal);
      const result = await this.execute(journal, call, 'replay');
      if (result.state === 'completed') {
        call.recovery = { strategy: 'isolated-replay', evidenceDigest: domainDigest('aether.process-recovery/1', { operationId, before: runtimeSnapshotDigest(call.before), after: runtimeSnapshotDigest(call.latest), execution: call.execution, effects: call.effects }) }; this.persist(journal);
      }
      return result;
    }, this.options.lockWaitMs ?? 5000);
  }
  async move(symbol: SymbolId, target: string, options: { migrationId: string; expectedGeneration?: string }): Promise<TopologyPlan> {
    identifier(options.migrationId); identifier(target);
    options = Object.freeze({ migrationId: options.migrationId, ...(options.expectedGeneration === undefined ? {} : { expectedGeneration: options.expectedGeneration }) });
    return this.lock.runAsync(async () => {
      this.assertOpen(); const journal = this.read();
      if (journal.calls.some(call => call.state === 'running' || call.state === 'indeterminate')) throw new Error('state domain blocked by an indeterminate operation');
      const requestDigest = domainDigest('aether.process-move/1', { symbol, target });
      const old = journal.migrations.find(migration => migration.migrationId === options.migrationId);
      if (old) {
        if (old.requestDigest !== requestDigest) throw new Error('migration_identity_conflict');
        if (old.state === 'committed' || old.state === 'finalized') { await this.ensureWorkers(journal); old.state = 'finalized'; this.persist(journal); return JSON.parse(journal.plan) as TopologyPlan; }
        throw new Error(`migration ${old.state}; a new migration ID is required`);
      }
      this.assertReady(journal);
      if (options.expectedGeneration !== undefined && options.expectedGeneration !== journal.generation) throw new Error('stale topology generation');
      const beforePlan = JSON.parse(journal.plan) as TopologyPlan;
      const source = this.unitIn(beforePlan, symbol);
      if (!source || !beforePlan.units.some(unit => unit.id === target)) throw new Error('invalid movement placement');
      if (source === target) {
        const noOp: MigrationRecord = { migrationId: options.migrationId, requestDigest, symbol, target, fromGeneration: journal.generation, toGeneration: journal.generation, state: 'finalized', beforePlan: journal.plan, afterPlan: journal.plan, before: copy(journal.snapshot), after: copy(journal.snapshot), failure: null, decisionDigest: '' };
        noOp.decisionDigest = migrationDecisionDigest(noOp); journal.migrations.push(noOp); this.persist(journal); return beforePlan;
      }
      // Reuse the established local constraint/cost validation without installing
      // its empty runtime state in any process worker.
      const validator = new TopologyHost(this.module, beforePlan, { registry: this.registry, policy: 'enforce' });
      const afterPlan = validator.move(symbol, target); this.validatePlan(afterPlan);
      const nextGeneration = String(BigInt(journal.generation) + 1n);
      const after = reepoch(journal.snapshot, nextGeneration, new Set(afterPlan.units.map(unit => unit.id)), target);
      this.validateSnapshot(after, nextGeneration, afterPlan);
      const migration: MigrationRecord = { migrationId: options.migrationId, requestDigest, symbol, target, fromGeneration: journal.generation, toGeneration: nextGeneration, state: 'requested', beforePlan: journal.plan, afterPlan: planBytes(afterPlan), before: copy(journal.snapshot), after, failure: null, decisionDigest: '' };
      migration.decisionDigest = migrationDecisionDigest(migration);
      journal.migrations.push(migration); this.retain(journal, after); this.persist(journal);
      let replacements = new Map<string, ProcessChannel>();
      try {
        this.phase('migration-requested', options.migrationId, journal.generation);
        replacements = await this.startWorkers({ ...journal, generation: nextGeneration, plan: migration.afterPlan!, snapshot: after });
        migration.state = 'prepared'; this.persist(journal); this.phase('migration-prepared', options.migrationId, journal.generation);
        this.phase('migration-before-commit', options.migrationId, journal.generation);
        journal.generation = nextGeneration; journal.plan = migration.afterPlan!; journal.snapshot = after; migration.state = 'committed'; this.appendHead(journal, { kind: 'migration', operationId: migration.migrationId, subjectDigest: migration.decisionDigest }); this.persist(journal);
        this.phase('migration-committed', options.migrationId, nextGeneration);
        const previous = this.channels; this.channels = replacements; replacements = new Map(); this.workersGeneration = nextGeneration;
        await Promise.all([...previous.values()].map(channel => channel.close()));
        migration.state = 'finalized'; this.persist(journal); this.phase('migration-finalized', options.migrationId, nextGeneration);
        return afterPlan;
      } catch (error) {
        await Promise.all([...replacements.values()].map(channel => channel.kill()));
        const durable = this.read(), saved = durable.migrations.find(item => item.migrationId === options.migrationId)!;
        if (saved.state === 'requested' || saved.state === 'prepared') { saved.state = 'aborted'; saved.failure = String(error); this.persist(durable); }
        else await this.stopWorkers(); // The durable commit remains authoritative.
        throw error;
      }
    }, this.options.lockWaitMs ?? 5000);
  }
  /** Acquire a durable exclusive state lease. Ordinary process writes remain
   * blocked across coordinator death until this exact lease commits or aborts. */
  async beginCheckpoint(base: ResumableSnapshot, initial: ResumableSnapshot, options: { operationId: string; symbol: SymbolId; tokens: readonly ProcessInvocationGrant[]; expectedSnapshot: Digest; expectedGeneration: string }): Promise<ProcessCheckpointBinding> {
    identifier(options.operationId); const tokens = freeze(copy([...options.tokens]));
    const program = this.checkpointProgram(); validateCheckpointExtension(base, initial, program);
    if (initial.core.effectCursor !== '0' || initial.core.state === 'blocked' || base.core.effectCursor !== '0') throw new Error('new checkpoint ownership requires a pre-effect source');
    return this.lock.runAsync(async () => {
      this.assertOpen(); const journal = this.read(), plan = JSON.parse(journal.plan) as TopologyPlan;
      // This backend is one execution unit. It must not bypass placement or
      // isolation by interpreting a multi-unit plan in the controller process.
      if (plan.units.length !== 1) throw new Error('resumable process bridge requires a single execution unit');
      const unit = this.unitIn(plan, options.symbol); if (!unit) throw new Error('unknown checkpoint entry');
      const prior = journal.checkpointLeases?.find(item => item.binding.operationId === options.operationId);
      if (prior) { if (prior.binding.baseCheckpoint !== checkpointDigest(base) || prior.binding.initialCheckpoint !== checkpointDigest(initial) || prior.binding.symbol !== options.symbol) throw new Error('checkpoint operation identity conflict'); this.checkpointAuthority('begin', prior.binding, tokens); return copy(prior.binding); }
      this.assertReady(journal);
      if (journal.calls.some(item => item.operationId === options.operationId) || journal.allocations.some(item => item.operationId === options.operationId)) throw new Error('checkpoint operation ID already used');
      if (journal.generation !== options.expectedGeneration || runtimeSnapshotDigest(journal.snapshot) !== options.expectedSnapshot) throw new Error('stale checkpoint ownership base');
      assertBaseProjection(base, journal.snapshot, journal.generation, unit); projectProcessCheckpoint(initial, journal.snapshot, journal.generation, unit);
      if (!['running', 'completed'].includes(initial.core.state)) throw new Error('checkpoint adoption requires a running or completed invocation');
      const lastStart = [...initial.events].reverse().find(event => event.op === 'start');
      if (!lastStart || lastStart.code !== `function:${options.symbol}` || base.core.frames[0] && base.core.frames[0].code !== `function:${options.symbol}`) throw new Error('checkpoint source invocation is not authorized');
      const first = initial.core.frames[0];
      if (first && first.code !== `function:${options.symbol}`) throw new Error('checkpoint entry does not match invocation authority');
      const starts = initial.events.slice(base.events.length).filter(event => event.op === 'start');
      if (starts.length > 1 || starts.some(event => event.code !== `function:${options.symbol}`)) throw new Error('checkpoint contains a different top-level invocation');
      const body: Omit<ProcessCheckpointBinding, 'id'> = { format: 'aether.process-checkpoint-binding/1', operationId: options.operationId, symbol: options.symbol, configuration: this.configuration, generation: journal.generation, unit, processHead: journal.heads.at(-1)!.digest, beforeSnapshot: runtimeSnapshotDigest(journal.snapshot), baseCheckpoint: checkpointDigest(base), initialCheckpoint: checkpointDigest(initial), program: program.digest, executionId: initial.core.executionId };
      const binding = { ...body, id: processCheckpointBindingDigest(body) };
      this.checkpointAuthority('begin', binding, tokens);
      writeProcessCheckpoint(this.options.directory, base, program); writeProcessCheckpoint(this.options.directory, initial, program);
      if (journal.format === 'aether.process-host/1') journal.format = 'aether.process-host/2'; journal.checkpointLeases ??= []; journal.checkpointReceipts ??= [];
      journal.checkpointLeases.push({ binding, state: 'active', latestCheckpoint: binding.initialCheckpoint, checkpoints: [binding.initialCheckpoint], receipt: null });
      this.checkpointAuthority('begin', binding, tokens); this.persist(journal); this.phase('checkpoint-started', binding.operationId, binding.generation); return copy(binding);
    }, this.options.lockWaitMs ?? 5000);
  }
  async readCheckpoint(bindingId: Digest): Promise<ResumableSnapshot> {
    return this.lock.runAsync(async () => { const lease = this.read().checkpointLeases?.find(item => item.binding.id === bindingId); if (!lease) throw new Error('unknown checkpoint lease'); return readProcessCheckpoint(this.options.directory, lease.latestCheckpoint, this.checkpointProgram()); }, this.options.lockWaitMs ?? 5000);
  }
  async checkpointReference(bindingId: Digest, reference: LogicalRefV1, tokens: readonly ProcessInvocationGrant[]): Promise<LogicalRefV1> {
    return this.lock.runAsync(async () => {
      this.assertOpen(); const journal = this.read(), lease = journal.checkpointLeases?.find(item => item.binding.id === bindingId);
      if (!lease || lease.state !== 'committed') throw new Error('checkpoint state has not been published');
      if (journal.generation !== lease.binding.generation) throw new Error('checkpoint reference mapping is stale after ownership movement');
      this.checkpointAuthority('commit', lease.binding, tokens);
      const source = readProcessCheckpoint(this.options.directory, lease.latestCheckpoint, this.checkpointProgram());
      const result = processReferenceFromCheckpoint(reference, source, journal.generation);
      if (!journal.snapshot.records.some(record => record.objectId === result.objectId)) throw new Error('published checkpoint object is missing'); return result;
    }, this.options.lockWaitMs ?? 5000);
  }
  checkpointReceipt(bindingId: Digest, tokens: readonly ProcessInvocationGrant[]): ProcessCheckpointReceipt | null {
    this.assertOpen(); const journal = this.read(), lease = journal.checkpointLeases?.find(item => item.binding.id === bindingId);
    if (!lease) throw new Error('unknown checkpoint lease'); this.checkpointAuthority('commit', lease.binding, tokens);
    return lease.state === 'committed' ? freeze(copy(journal.checkpointReceipts!.find(receipt => receipt.id === lease.receipt)!)) : null;
  }
  checkpointStatus(bindingId: Digest): Readonly<ProcessCheckpointLease> {
    const lease = this.read().checkpointLeases?.find(item => item.binding.id === bindingId); if (!lease) throw new Error('unknown checkpoint lease'); return freeze(copy(lease));
  }
  async retainPackedLayout(bindingId: Digest, layouts: readonly PackedLayout[], tokens: readonly ProcessInvocationGrant[]): Promise<Digest> {
    layouts = freeze(copy(layouts)); tokens = freeze(copy([...tokens]));
    return this.lock.runAsync(async () => {
      this.assertOpen(); const journal = this.read(), lease = journal.checkpointLeases?.find(item => item.binding.id === bindingId);
      if (!lease || lease.state !== 'active') throw new Error('packed layout requires an active checkpoint lease');
      this.checkpointAuthority('packed', lease.binding, tokens);
      if (journal.generation !== lease.binding.generation || journal.heads.at(-1)!.digest !== lease.binding.processHead) throw new Error('packed layout lease lost production ownership');
      return writeProcessPackedLayout(this.options.directory, layouts);
    }, this.options.lockWaitMs ?? 5000);
  }
  /** Trusted backend transaction. The policy hook remains mandatory; fresh
   * invocation grants are additionally required for run/commit. The callback
   * cannot observe another writer between checkpoint and heap publication. */
  async withCheckpoint<T>(bindingId: Digest, action: Exclude<ProcessCheckpointAction, 'begin'>, tokens: readonly ProcessInvocationGrant[], operation: (access: ProcessCheckpointAccess) => Promise<T>, control?: ProcessCheckpointControlRequest): Promise<T> {
    if ((action === 'correct' || action === 'rewind' || action === 'packed') !== (control !== undefined)) throw new TypeError('checkpoint control action requires an exact request');
    if (control) { validateCheckpointControlRequest(control); control = freeze(copy(control)); if ((action === 'rewind') !== (control.kind === 'rewind') || (action === 'packed') !== (control.kind === 'packed-v1' || control.kind === 'packed-v2')) throw new TypeError('checkpoint control action mismatch'); }
    tokens = freeze(copy([...tokens]));
    return this.lock.runAsync(async () => {
      this.assertOpen(); const journal = this.read(), lease = journal.checkpointLeases?.find(item => item.binding.id === bindingId);
      if (!lease) throw new Error('unknown checkpoint lease');
      const assertAuthority = (): void => { this.assertOpen(); this.checkpointAuthority(action, lease.binding, tokens, control); if (lease.state !== 'active') throw new Error(`checkpoint lease is ${lease.state}`); if (journal.generation !== lease.binding.generation || journal.heads.at(-1)!.digest !== lease.binding.processHead || runtimeSnapshotDigest(journal.snapshot) !== lease.binding.beforeSnapshot) throw new Error('checkpoint lease lost its production ownership'); };
      assertAuthority(); const program = this.checkpointProgram();
      const before = copy(journal.snapshot), base = readProcessCheckpoint(this.options.directory, lease.binding.baseCheckpoint, program);
      const executionOrigin = lease.latestCheckpoint;
      const controls = journal.checkpointControls?.filter(item => item.binding === bindingId) ?? [], latestControl = controls.at(-1);
      const replayBarrier = latestControl ? readProcessCheckpoint(this.options.directory, latestControl.beforeCheckpoint, program) : null;
      const priorControl = control ? controls.find(item => item.request.operationId === control.operationId) : undefined;
      if (control?.kind === 'packed-v1' && !priorControl) throw new TypeError('new packed-v1 controls require the version 2 native run proof');
      if (priorControl && !equal(priorControl.request, control)) throw new Error('checkpoint control operation identity conflict');
      if (control && !priorControl && control.expectedCheckpoint !== executionOrigin) throw new Error('stale checkpoint control');
      if (control && !priorControl && journal.checkpointControls?.some(item => item.request.operationId === control.operationId)) throw new Error('checkpoint control operation already used');
      if (control && !priorControl && replayBarrier && BigInt(readProcessCheckpoint(this.options.directory, executionOrigin, program).core.effectCursor) < BigInt(replayBarrier.core.effectCursor)) throw new Error('checkpoint replay debt must be consumed before another control');
      const save = (snapshot: ResumableSnapshot): void => {
        assertAuthority(); if (control) throw new Error('checkpoint control requires an audited finish');
        if (checkpointDigest(snapshot) !== lease.latestCheckpoint) validateExecutedCheckpoint(snapshot, executionOrigin, program.digest); const latest = readProcessCheckpoint(this.options.directory, lease.latestCheckpoint, program); validateCheckpointExtension(latest, snapshot, program); validateCheckpointExtension(base, snapshot, program);
        const additions = snapshot.events.slice(latest.events.length);
        if (additions.some(event => event.op === 'start' || event.code === 'host' && !(action === 'reconcile' && event.op === 'retry-reconciled-effect'))) throw new Error('leased continuation cannot inject a new invocation or debugger mutation');
        projectProcessCheckpoint(snapshot, before, lease.binding.generation, lease.binding.unit);
        const digest = writeProcessCheckpoint(this.options.directory, snapshot, program); assertAuthority();
        if (digest !== lease.latestCheckpoint) { lease.latestCheckpoint = digest; lease.checkpoints.push(digest); this.persist(journal); this.phase('checkpoint-saved', lease.binding.operationId, lease.binding.generation); }
      };
      const access: ProcessCheckpointAccess = {
        replayBarrier, controlReceipt: priorControl ? freeze(copy(priorControl)) : null,
        finishControl: (snapshot, effectAudit, nativeRun) => {
          assertAuthority(); if (!control || priorControl) throw new Error('checkpoint control already applied or missing');
          const previous = readProcessCheckpoint(this.options.directory, executionOrigin, program);
          if (control.kind === 'packed-v2') PackedNativeProcessRunner.assertRun(nativeRun, {
            operationId: control.operationId,
            expectedCheckpoint: control.expectedCheckpoint, sourceImageDigest: control.sourceImageDigest,
            candidateImageDigest: control.candidateImageDigest, layoutDigest: control.layoutDigest,
            artifactDigest: control.artifactDigest, executableSha256: control.executableSha256,
            operationsDigest: control.operationsDigest,
          });
          else if (nativeRun !== undefined) throw new TypeError('native run proof outside packed-v2 control');
          validateExecutedCheckpoint(snapshot, executionOrigin, program.digest); validateCheckpointControlTransition(control, previous, snapshot, program,
            control.kind === 'packed-v1' || control.kind === 'packed-v2' ? readProcessPackedLayout(this.options.directory, control.layoutDigest) : undefined);
          const initial = readProcessCheckpoint(this.options.directory, lease.binding.initialCheckpoint, program); validateCheckpointExtension(initial, snapshot, program);
          if (control.kind === 'rewind' && previous.events.length - control.steps < initial.events.length) throw new Error('rewind crosses the checkpoint ownership boundary');
          if (previous.core.state === 'blocked') throw new Error('checkpoint control requires resolved effects');
          projectProcessCheckpoint(snapshot, before, lease.binding.generation, lease.binding.unit);
          const audit = writeCheckpointEffectAudit(this.options.directory, previous, effectAudit), afterCheckpoint = writeProcessCheckpoint(this.options.directory, snapshot, program);
          const body: Omit<ProcessCheckpointControl, 'id'> = { format: 'aether.process-checkpoint-control/1', binding: bindingId, request: control, beforeCheckpoint: executionOrigin, afterCheckpoint, previous: latestControl?.id ?? null, effectAudit: audit, effectCount: effectAudit.length };
          const result = { ...body, id: checkpointControlDigest(body) };
          this.phase('checkpoint-control-before-commit', control.operationId, lease.binding.generation); assertAuthority();
          journal.format = 'aether.process-host/3'; (journal.checkpointControls ??= []).push(result); lease.latestCheckpoint = afterCheckpoint; lease.checkpoints.push(afterCheckpoint); this.persist(journal);
          this.phase('checkpoint-control-committed', control.operationId, lease.binding.generation); return freeze(copy(result));
        },
        binding: freeze(copy(lease.binding)), program, before, checkpoint: readProcessCheckpoint(this.options.directory, lease.latestCheckpoint, program), assertAuthority, save,
        commit: (snapshot, effectAudit) => {
          if (action !== 'commit') throw new Error('checkpoint commit requires explicit publication action');
          save(snapshot); assertAuthority();
          if (snapshot.core.state !== 'completed' || snapshot.core.frames.length || snapshot.core.fault !== null) throw new Error('only completed resolved execution can publish production state');
          const audit = writeCheckpointEffectAudit(this.options.directory, snapshot, effectAudit); const after = projectProcessCheckpoint(snapshot, before, lease.binding.generation, lease.binding.unit); this.validateSnapshot(after, journal.generation, JSON.parse(journal.plan) as TopologyPlan);
          const body: Omit<ProcessCheckpointReceipt, 'id'> = { format: 'aether.process-checkpoint-receipt/1', binding: lease.binding.id, checkpoint: lease.latestCheckpoint, beforeSnapshot: lease.binding.beforeSnapshot, afterSnapshot: runtimeSnapshotDigest(after), effectAudit: audit, eventHead: snapshot.eventHead, eventCursor: snapshot.eventCursor };
          const receipt = { ...body, id: processCheckpointReceiptDigest(body) };
          this.phase('checkpoint-before-commit', lease.binding.operationId, lease.binding.generation); assertAuthority(); journal.snapshot = after; this.retain(journal, after); lease.state = 'committed'; lease.receipt = receipt.id; journal.checkpointReceipts!.push(receipt);
          this.appendHead(journal, { kind: 'checkpoint', operationId: lease.binding.operationId, subjectDigest: receipt.id }); this.persist(journal); this.phase('checkpoint-committed', lease.binding.operationId, lease.binding.generation); return freeze(copy(receipt));
        },
        abort: () => { if (action !== 'abort') throw new Error('checkpoint abort requires explicit recovery action'); assertAuthority(); const latest = readProcessCheckpoint(this.options.directory, lease.latestCheckpoint, program); if (latest.core.effectCursor !== '0') throw new Error('cannot abort a checkpoint with terminal external effects'); lease.state = 'aborted'; this.persist(journal); this.phase('checkpoint-aborted', lease.binding.operationId, lease.binding.generation); },
      };
      return operation(access);
    }, this.options.lockWaitMs ?? 5000);
  }
  private checkpointProgram(): ResumableProgram { return this.checkpointProgramCache ??= compileResumableProgram(this.module, { manifest: this.manifest, registry: this.registry }); }
  private checkpointAuthority(action: ProcessCheckpointAction, binding: ProcessCheckpointBinding, tokens: readonly ProcessInvocationGrant[], control?: ProcessCheckpointControlRequest): void {
    if (this.options.authorizeCheckpoint?.({ action, binding: freeze(copy(binding)), ...(control ? { control: freeze(copy(control)) } : {}) }) !== true) throw new Error('checkpoint_authorization_denied');
    if (action === 'begin' || action === 'run' || action === 'commit' || action === 'correct' || action === 'rewind' || action === 'packed') this.authorize(binding.symbol, binding.unit, binding.generation, tokens);
  }
  async close(): Promise<void> { this.closed = true; if (this.active) this.active.cancelled = true; await this.stopWorkers(); }

  private async execute(journal: HostJournal, call: CallRecord, mode: 'live' | 'replay', tokens: readonly ProcessInvocationGrant[] = []): Promise<ProcessHostCallResult> {
    const active: Active = { journal, call, snapshot: copy(call.before), frames: [], authority: new Set(this.declarations.get(call.symbol)!.capabilities), mode, cancelled: false, tokens: freeze(copy([...tokens])) };
    this.active = active;
    try {
      if (mode === 'live') this.phase('call-intent', call.operationId, journal.generation);
      const result = await this.invoke(active, call.symbol, call.args.map(value => decodeProcessValue(value, this.scope(journal, call.unit), active.snapshot)), processExecutionId(call.before.heapId, call.operationId));
      this.assertActive(active);
      if (!result.execution.ok && result.execution.fault.kind === 'effect_indeterminate') throw new Error(result.execution.fault.message);
      if (call.effects.some(effect => effect.state === 'dispatching' || effect.state === 'indeterminate')) throw new Error('external effect disposition is unresolved');
      const execution = encodeProcessExecution(result.execution, this.scope(journal, call.unit), result.snapshot);
      this.phase('call-before-commit', call.operationId, journal.generation);
      this.assertActive(active);
      if (mode === 'live') this.authorize(call.symbol, call.unit, journal.generation, active.tokens);
      // A failed invocation with no possible external commit cannot publish
      // speculative heap writes. In particular, a resource-scoped grant may
      // be denied after the worker has calculated its effect arguments.
      const noExternalCommit = call.effects.every(effect => ['requested', 'rejected', 'aborted'].includes(effect.state));
      const published = !result.execution.ok && noExternalCommit ? call.before : result.snapshot;
      call.latest = copy(published); call.execution = execution; call.state = 'completed'; call.failure = null;
      call.executionDigest = callOutcomeDigest(call);
      journal.snapshot = copy(published); this.retain(journal, journal.snapshot); this.appendHead(journal, { kind: 'call', operationId: call.operationId, subjectDigest: call.executionDigest! }); this.persist(journal);
      this.phase('call-committed', call.operationId, journal.generation);
      return this.result(call, journal);
    } catch (error) {
      active.cancelled = true; await this.stopWorkers();
      // Re-read the atomic decision rather than undoing a completed call after
      // an acknowledgment/observer failure.
      const durable = this.read(), saved = durable.calls.find(item => item.operationId === call.operationId)!;
      if (saved.state !== 'completed') { saved.state = 'indeterminate'; saved.failure = String(error); this.persist(durable); }
      return this.result(saved, durable);
    } finally { if (this.active === active) this.active = null; }
  }
  private async invoke(active: Active, symbol: SymbolId, args: readonly Value[], operationId: string): Promise<ProcessCallResult> {
    this.assertActive(active);
    const plan = JSON.parse(active.journal.plan) as TopologyPlan, unit = this.unitIn(plan, symbol);
    if (!unit) throw new Error('unplaced nested function');
    if (active.mode === 'live') this.authorize(active.call.symbol, active.call.unit, active.journal.generation, active.tokens);
    this.checkRevocations(symbol, unit, active.journal.generation, active.mode);
    const channel = this.channels.get(unit); if (!channel) throw new Error('worker unavailable');
    const declaration = this.declarations.get(symbol)!;
    const typedArgs = args.map(value => encodeProcessValue(value, this.scope(active.journal, unit), active.snapshot));
    const bindings = validateProcessArguments(declaration, typedArgs, active.snapshot);
    const frame: Frame = { symbol, unit, operationId, nextBoundary: 0 }; active.frames.push(frame);
    try {
      const result = await channel.call(symbol, args, active.snapshot, { operationId });
      if (result.execution.ok) validateProcessResult(declaration, encodeProcessValue(result.execution.value, this.scope(active.journal, unit), result.snapshot), result.snapshot, bindings);
      this.adopt(active, result.snapshot); return result;
    } finally { if (active.frames.pop() !== frame) throw new Error('process frame ordering violated'); }
  }
  private async onCall(unit: string, request: ProcessCallRequest): Promise<ProcessCallResult> {
    const active = this.requireActive(), frame = active.frames.at(-1)!;
    const index = frame.nextBoundary++;
    if (frame.unit !== unit || request.operationId !== processBoundaryId(frame.operationId, 'call', index) || !this.locallyReachable(frame.symbol, request.from, unit, JSON.parse(active.journal.plan) as TopologyPlan) || !this.edges.get(request.from)?.has(request.symbol)) throw new Error('unauthorized process call edge');
    const caller = this.declarations.get(request.from)!, target = this.declarations.get(request.symbol);
    if (!target || target.capabilities.some(cap => !caller.capabilities.includes(cap) || !active.authority.has(cap))) throw new Error('cross-process capability widening');
    this.adopt(active, request.snapshot);
    const body = { id: request.operationId, parentOperationId: frame.operationId, index, from: request.from, to: request.symbol, fromUnit: unit, toUnit: this.unitIn(JSON.parse(active.journal.plan) as TopologyPlan, request.symbol)!, args: request.args.map(value => encodeProcessValue(value, this.scope(active.journal, unit), request.snapshot)), snapshotDigest: runtimeSnapshotDigest(request.snapshot) };
    const requestDigest = domainDigest('aether.process-call-boundary/1', body), previous = active.call.boundaries.find(boundary => boundary.id === body.id);
    if (previous && previous.requestDigest !== requestDigest) throw new Error('process_call_replay_mismatch');
    if (!previous) { active.call.boundaries.push({ ...body, requestDigest }); this.persist(active.journal); }
    this.phase('boundary', active.call.operationId, active.journal.generation);
    return this.invoke(active, request.symbol, request.args, request.operationId);
  }
  private v4Router(active: Active, unit: string, request: ProcessEffectRequest, id: Digest): RuntimeEffectRouter {
    const policy = this.signedEffectResourcePolicy;
    if (policy?.format !== 'aether.signed-effect-resource-policy/4' || !this.options.effectRouterFactory)
      throw new TypeError('isolated Wasm router requires signed v4 policy and factory');
    const rule = policy.body.rules.find(item => item.capability === request.capability);
    if (!rule) throw new TypeError('isolated Wasm effect lacks a signed rule');
    if (this.options.trustedClockAnchor && active.mode === 'live')
      assertBeforeDeadline(this.options.trustedClockAnchor, rule.deadline, rule.clockDomain);
    const grantRef = domainDigest('aether.process-effect-grant-ref/1', {
      configuration: this.configuration, operationId: id, capability: request.capability, policyEpoch: policy.body.policyEpoch,
    });
    const context: ProcessEffectContext = freeze({ operationId: id, rootOperationId: active.call.operationId, unit,
      generation: active.journal.generation, manifest: copy(this.manifest), capability: request.capability,
      mode: active.mode, snapshot: copy(active.snapshot), policyEpoch: policy.body.policyEpoch,
      deadline: rule.deadline, clockDomain: rule.clockDomain, grantRef });
    const router = this.options.effectRouterFactory(context);
    if (brokerMode(router) !== active.mode) throw new TypeError('isolated Wasm router mode mismatch');
    brokerBind(router, this.manifest.astRoot as NodeRef);
    assertEffectResourceAdapterV4(policy, request.capability, { ...brokerAdapterIdentity(router, request.capability),
      artifactCapability: brokerWasmAdapterCapability(router, request.capability) });
    brokerAttestContext(router, { executionId: id, manifestDigest: executionManifestDigest(this.manifest),
      mode: active.mode, policyEpoch: policy.body.policyEpoch, deadline: rule.deadline, clockDomain: rule.clockDomain,
      capability: request.capability, grantRef });
    if (this.options.effectJournalWitnessCatalog)
      brokerPinWitness(router, selectEffectJournalWitness(this.options.effectJournalWitnessCatalog, id));
    if (this.options.trustedClockAnchor && active.mode === 'live')
      brokerPinTrustedClock(router, this.options.trustedClockAnchor, active.tokens.map(token => {
        const body = (token as ScopedGrantV2).body;
        return { issuedAt: body.issuedAt, expiresAt: body.expiresAt };
      }));
    return router;
  }
  /** Reconstruct the exact historical broker subject without asking for a
   * current dispatch grant. Router construction is followed only by a
   * nonvirtual, read-only broker inspection or authorized reconciliation. */
  private v4RecordedEffect(journal: HostJournal, call: CallRecord, effect: EffectRecord):
    { router: RuntimeEffectRouter; request: EffectRequestV1 } {
    const policy = this.signedEffectResourcePolicy;
    if (policy?.format !== 'aether.signed-effect-resource-policy/4' || !this.options.effectRouterFactory)
      throw new TypeError('isolated Wasm recorded effect requires signed v4 policy and factory');
    const rule = policy.body.rules.find(item => item.capability === effect.capability);
    const retained = journal.snapshots.find(item => item.digest === effect.snapshotDigest)?.snapshot;
    if (!rule || !retained || effect.args.length !== 1 || effect.args[0].tag !== 'int')
      throw new TypeError('unavailable exact Wasm effect history');
    const grantRef = domainDigest('aether.process-effect-grant-ref/1', {
      configuration: this.configuration, operationId: effect.id, capability: effect.capability, policyEpoch: policy.body.policyEpoch,
    });
    const router = this.options.effectRouterFactory(freeze({ operationId: effect.id, rootOperationId: call.operationId,
      unit: effect.unit, generation: call.generation, manifest: copy(this.manifest), capability: effect.capability,
      mode: 'live' as const, snapshot: copy(retained), policyEpoch: policy.body.policyEpoch,
      deadline: rule.deadline, clockDomain: rule.clockDomain, grantRef }));
    if (brokerMode(router) !== 'live') throw new TypeError('recorded Wasm broker mode mismatch');
    brokerBind(router, this.manifest.astRoot as NodeRef);
    assertEffectResourceAdapterV4(policy, effect.capability, { ...brokerAdapterIdentity(router, effect.capability),
      artifactCapability: brokerWasmAdapterCapability(router, effect.capability) });
    brokerAttestContext(router, { executionId: effect.id, manifestDigest: executionManifestDigest(this.manifest),
      mode: 'live', policyEpoch: policy.body.policyEpoch, deadline: rule.deadline, clockDomain: rule.clockDomain,
      capability: effect.capability, grantRef });
    if (this.options.effectJournalWitnessCatalog)
      brokerPinWitness(router, selectEffectJournalWitness(this.options.effectJournalWitnessCatalog, effect.id));
    const payload: TaggedValueV1 = { tag: 'sequence', items: [{ tag: 'string', value: effect.capability }, ...copy(effect.args)] };
    const request: EffectRequestV1 = { format: 'aether.effect/1', executionId: effect.id, effectId: 'operation-0',
      branchId: null, executionManifest: executionManifestDigest(this.manifest), capabilityGrantRef: grantRef,
      policyEpoch: policy.body.policyEpoch, payloadDigest: effectPayloadDigest(payload), payload,
      budgetReservationId: null, deadline: rule.deadline };
    return { router, request };
  }
  private assertV4TerminalEffects(journal: HostJournal, call: CallRecord): void {
    if (this.signedEffectResourcePolicy?.format !== 'aether.signed-effect-resource-policy/4') return;
    for (const effect of call.effects) {
      if (!['committed', 'rejected', 'aborted'].includes(effect.state)) continue;
      const { router, request } = this.v4RecordedEffect(journal, call, effect);
      const outcome = brokerInspectRecorded(router, effect.capability, request);
      if (!outcome || outcome.state !== effect.state
        || outcome.state === 'committed' && !equal(outcome.value, effect.value)
        || (outcome.state === 'rejected' || outcome.state === 'aborted') && outcome.code !== effect.code)
        throw new Error('host_effect_broker_mismatch: cached effect lacks an exact broker outcome');
    }
  }
  private reconcileV4Call(journal: HostJournal, call: CallRecord): boolean {
    const policy = this.signedEffectResourcePolicy;
    if (policy?.format !== 'aether.signed-effect-resource-policy/4' || !this.options.effectRouterFactory)
      throw new TypeError('isolated Wasm reconciliation requires signed v4 policy and factory');
    this.assertV4TerminalEffects(journal, call);
    for (const effect of call.effects) {
      if (effect.state !== 'dispatching' && effect.state !== 'indeterminate') continue;
      try {
        this.requireRecoveryAuthorization(call.operationId, 'isolated-replay');
        const { router, request } = this.v4RecordedEffect(journal, call, effect);
        const outcome = brokerReconcileRecorded(router, effect.capability, request);
        if (outcome.state === 'indeterminate') return false;
        this.requireRecoveryAuthorization(call.operationId, 'isolated-replay');
        effect.state = outcome.state; effect.value = outcome.state === 'committed' ? copy(outcome.value) : null;
        effect.code = outcome.state === 'committed' ? null : outcome.code;
        effect.outcomeDigest = effectOutcomeDigest(effect); this.persist(journal);
      } catch (error) {
        call.failure = `isolated Wasm reconciliation pending: ${String(error)}`; this.persist(journal); return false;
      }
    }
    return true;
  }
  private async onEffect(unit: string, request: ProcessEffectRequest): Promise<{ value: Value; snapshot: RuntimeSnapshotV1 }> {
    const active = this.requireActive(), frame = active.frames.at(-1)!;
    if (frame.unit !== unit || request.operationId !== frame.operationId || request.effectIndex !== frame.nextBoundary++ || !active.authority.has(request.capability) || !this.locallyReachable(frame.symbol, request.from, unit, JSON.parse(active.journal.plan) as TopologyPlan) || !this.declarations.get(request.from)?.capabilities.includes(request.capability)) throw new Error('unauthorized process effect boundary');
    const declared = (JSON.parse(active.journal.plan) as TopologyPlan).units.find(candidate => candidate.id === unit)!;
    if (!declared.capabilities.includes(request.capability)) throw new Error('effect is outside the authenticated unit authority');
    this.checkRevocation(request.capability, unit, active.journal.generation, active.mode);
    if (active.mode === 'live') this.authorize(active.call.symbol, active.call.unit, active.journal.generation, active.tokens);
    if (this.signedEffectResourcePolicy?.format === 'aether.signed-effect-resource-policy/4') {
      const value = request.args[0];
      if (request.args.length !== 1 || typeof value !== 'bigint' || value < -2147483648n || value > 2147483647n)
        throw new EffectInvocationError({ state: 'rejected', code: 'isolated_wasm_i32_argument_required' });
      if (this.options.trustedClockAnchor && active.mode === 'live') {
        const rule = this.signedEffectResourcePolicy.body.rules.find(item => item.capability === request.capability);
        if (!rule) throw new TypeError('isolated Wasm effect lacks a signed rule');
        assertBeforeDeadline(this.options.trustedClockAnchor, rule.deadline, rule.clockDomain);
      }
    }
    this.adopt(active, request.snapshot);
    const id = processBoundaryId(request.operationId, 'effect', request.effectIndex);
    const taggedArgs = request.args.map(value => encodeProcessValue(value, this.scope(active.journal, unit), request.snapshot));
    const resourcePath = active.mode === 'live' && this.options.scopedGrants
      ? this.scopedEffectPath(active, request, unit, taggedArgs) : null;
    if (resourcePath) this.authorizeScopedEffect(active, request.capability, resourcePath);
    const snapshotDigest = runtimeSnapshotDigest(request.snapshot), requestDigest = domainDigest('aether.process-effect/1', { id, capability: request.capability, args: taggedArgs, snapshotDigest, unit, from: request.from });
    let effect = active.call.effects.find(effect => effect.id === id);
    if (effect && effect.requestDigest !== requestDigest) throw new EffectInvocationError({ state: 'indeterminate', recoveryId: 'process_replay_mismatch' });
    if (active.mode === 'replay' && !effect) throw new EffectInvocationError({ state: 'indeterminate', recoveryId: 'process_missing_effect_history' });
    if (effect?.state === 'committed') {
      this.assertV4TerminalEffects(active.journal, active.call);
      return { value: decodeProcessValue(effect.value!, this.scope(active.journal, unit), active.snapshot), snapshot: active.snapshot };
    }
    if (effect?.state === 'rejected' || effect?.state === 'aborted') {
      this.assertV4TerminalEffects(active.journal, active.call);
      throw new EffectInvocationError({ state: effect.state, code: effect.code! });
    }
    const v4 = this.signedEffectResourcePolicy?.format === 'aether.signed-effect-resource-policy/4';
    let preparedRouter: RuntimeEffectRouter | null = null;
    if (v4 && active.mode === 'live' && !effect) {
      try { preparedRouter = this.v4Router(active, unit, request, id); }
      catch { throw new EffectInvocationError({ state: 'rejected', code: 'isolated_wasm_router_preflight' }); }
    }
    if (!effect) { effect = { id, capability: request.capability, requestDigest, snapshotDigest, unit, from: request.from, parentOperationId: request.operationId, index: request.effectIndex, args: copy(taggedArgs), outcomeDigest: null, state: 'requested', value: null, code: null }; active.call.effects.push(effect); this.persist(active.journal); }
    try {
      if (active.mode === 'live') { this.phase('effect-requested', active.call.operationId, active.journal.generation); effect.state = 'dispatching'; this.persist(active.journal); }
      if (!v4 && !this.options.effectRouterFactory) throw new Error('effect router factory missing');
      const router = v4 ? preparedRouter ?? this.v4Router(active, unit, request, id)
        : this.options.effectRouterFactory!(freeze({ operationId: id, rootOperationId: active.call.operationId, unit, generation: active.journal.generation, manifest: copy(this.manifest), capability: request.capability, mode: active.mode, snapshot: copy(active.snapshot) }));
      const brokerBound = this.signedEffectResourcePolicy?.format === 'aether.signed-effect-resource-policy/2'
        || this.signedEffectResourcePolicy?.format === 'aether.signed-effect-resource-policy/3'
        || this.signedEffectResourcePolicy?.format === 'aether.signed-effect-resource-policy/4';
      if (!v4) {
        if ((brokerBound ? brokerMode(router) : router.mode) !== active.mode) throw new Error('effect router mode does not match execution/recovery mode');
        if (brokerBound) brokerBind(router, this.manifest.astRoot as NodeRef);
        else router.bind(this.manifest.astRoot as NodeRef);
      }
      if (this.signedEffectResourcePolicy && !v4) {
        if (this.signedEffectResourcePolicy.format === 'aether.signed-effect-resource-policy/3')
          assertEffectResourceAdapterV3(this.signedEffectResourcePolicy, request.capability, brokerAdapterIdentity(router, request.capability));
        else if (this.signedEffectResourcePolicy.format === 'aether.signed-effect-resource-policy/2')
          assertEffectResourceAdapterV2(this.signedEffectResourcePolicy, request.capability, brokerAdapterIdentity(router, request.capability));
        else {
          const actual = router.adapterIdentity?.(request.capability);
          if (!actual) throw new Error('signed effect policy requires an inspectable adapter');
          assertEffectResourceAdapter(this.signedEffectResourcePolicy, request.capability, actual);
        }
      }
      this.assertActive(active); this.checkRevocation(request.capability, unit, active.journal.generation, active.mode);
      if (active.mode === 'live') this.authorize(active.call.symbol, active.call.unit, active.journal.generation, active.tokens);
      if (resourcePath) {
        const currentPath = this.scopedEffectPath(active, request, unit, taggedArgs);
        if (!equal(currentPath, resourcePath)) throw new Error('effect resource changed before sink dispatch');
        this.authorizeScopedEffect(active, request.capability, currentPath);
      }
      let value: Value;
      try { value = brokerBound ? brokerInvoke(router, request.capability, request.args) : router.invoke(request.capability, request.args); }
      catch (error) {
        if (!v4 || active.mode !== 'live' || !(error instanceof EffectInvocationError) || error.outcome.state !== 'indeterminate') throw error;
        // The V4 guest is import-free and read-only. Its broker can resolve a
        // trapped/timed-out pure computation to terminal noncommit immediately.
        value = brokerReconcileLast(router, request.capability, request.args);
      }
      const tagged = encodeProcessValue(value, this.scope(active.journal, unit), active.snapshot);
      effect.state = 'committed'; effect.value = tagged; effect.code = null; effect.outcomeDigest = effectOutcomeDigest(effect); this.persist(active.journal);
      this.phase('effect-recorded', active.call.operationId, active.journal.generation);
      return { value, snapshot: active.snapshot };
    } catch (error) {
      this.assertActive(active);
      if (effect.state === 'committed') throw error;
      if (error instanceof EffectInvocationError) { effect.state = error.outcome.state; effect.code = error.outcome.state === 'indeterminate' ? error.outcome.recoveryId : error.outcome.code; }
      else { effect.state = effect.state === 'requested' ? 'requested' : 'indeterminate'; effect.code = String(error); }
      effect.outcomeDigest = effectOutcomeDigest(effect);
      this.persist(active.journal);
      if (error instanceof EffectInvocationError) throw error;
      throw new EffectInvocationError({ state: 'indeterminate', recoveryId: id });
    }
  }
  private adopt(active: Active, snapshot: RuntimeSnapshotV1): void {
    this.assertActive(active); this.validateSnapshot(snapshot, active.journal.generation, JSON.parse(active.journal.plan) as TopologyPlan);
    active.snapshot = copy(snapshot); active.call.latest = copy(snapshot); this.retain(active.journal, snapshot); this.persist(active.journal);
  }
  private async startWorkers(journal: HostJournal): Promise<Map<string, ProcessChannel>> {
    const plan = JSON.parse(journal.plan) as TopologyPlan, channels = new Map<string, ProcessChannel>();
    try {
      for (const unit of plan.units) {
        const channel = await ProcessChannel.start({ module: this.module, manifest: this.manifest, unit: unit.id, includeSymbols: unit.members, capabilities: this.registry.names.map(name => this.registry.get(name)!), heapId: journal.snapshot.heapId, ownershipEpoch: journal.generation, snapshot: journal.snapshot }, { timeoutMs: this.options.timeoutMs ?? 5000, onCall: request => this.onCall(unit.id, request), onEffect: request => this.onEffect(unit.id, request) });
        channels.set(unit.id, channel);
      }
      return channels;
    } catch (error) { await Promise.all([...channels.values()].map(channel => channel.kill())); throw error; }
  }
  private async ensureWorkers(journal: HostJournal): Promise<void> {
    if (this.workersGeneration === journal.generation && this.channels.size && [...this.channels.values()].every(channel => channel.alive)) return;
    const replacements = await this.startWorkers(journal); const old = this.channels;
    this.channels = replacements; this.workersGeneration = journal.generation;
    await Promise.all([...old.values()].map(channel => channel.close()));
  }
  private async stopWorkers(): Promise<void> { const channels = this.channels; this.channels = new Map(); this.workersGeneration = null; await Promise.all([...channels.values()].map(channel => channel.kill())); }
  private assertOpen(): void { if (this.closed) throw new Error('ProcessHost is closed'); }
  private requireActive(): Active { if (!this.active) throw new Error('unsolicited process callback'); this.assertActive(this.active); return this.active; }
  private assertActive(active: Active): void {
    if (this.active !== active || active.cancelled || this.closed) throw new Error('process operation is no longer authoritative');
    if (active.mode === 'replay') this.requireRecoveryAuthorization(active.call.operationId, 'isolated-replay');
  }
  private requireRecoveryAuthorization(operationId: string, strategy: 'isolated-replay' | 'abort-before-effects' | 'abort-readonly-wasm'): void { if (this.options.authorizeRecovery?.(operationId, strategy) !== true) throw new Error('recovery_authorization_denied'); }
  private phase(phase: ProcessHostPhase, operationId: string, generation: string): void { this.options.onPhase?.(phase, Object.freeze({ operationId, generation })); }
  private tokenScope(unit: string, generation: string, symbol: SymbolId): string { return domainDigest('aether.process-grant-scope/1', { configuration: this.configuration, generation, unit, symbol }); }
  private scopedGrantPath(unit: string, generation: string): readonly string[] {
    return ['process', this.configuration.split(':').at(-1)!, generation, domainDigest('aether.process-grant-unit/1', unit).split(':').at(-1)!];
  }
  private scopedEffectPath(active: Active, request: ProcessEffectRequest, unit: string, args: readonly TaggedValueV1[]): readonly string[] {
    const context = freeze({ capability: request.capability, from: request.from, unit, generation: active.journal.generation, args: copy(args) });
    let suffix: readonly string[];
    if (this.signedEffectResourcePolicy) {
      if (this.signedEffectResourcePolicy.format === 'aether.signed-effect-resource-policy/4') {
        assertAnchoredEffectPolicy(this.options.effectSignerAnchor!, this.signedEffectResourcePolicy,
          this.manifest, this.options.scopedGrants!.repositoryId, 'anchored-v4');
        suffix = effectResourcePathV4(this.signedEffectResourcePolicy, request.capability, args);
      } else if (this.signedEffectResourcePolicy.format === 'aether.signed-effect-resource-policy/3') {
        if (this.options.effectSignerAnchor)
          assertAnchoredEffectPolicy(this.options.effectSignerAnchor, this.signedEffectResourcePolicy,
            this.manifest, this.options.scopedGrants!.repositoryId);
        else assertSignedEffectResourcePolicyV3(this.signedEffectResourcePolicy, this.manifest, this.options.scopedGrants!.repositoryId,
          this.options.currentEffectPolicyEpoch!(), this.options.effectResourceSignerKey!);
        suffix = effectResourcePathV3(this.signedEffectResourcePolicy, request.capability, args);
      } else if (this.signedEffectResourcePolicy.format === 'aether.signed-effect-resource-policy/2') {
        if (this.options.effectSignerAnchor)
          assertAnchoredEffectPolicy(this.options.effectSignerAnchor, this.signedEffectResourcePolicy,
            this.manifest, this.options.scopedGrants!.repositoryId, this.options.legacyAnchoredEffectPolicy);
        else assertSignedEffectResourcePolicyV2(this.signedEffectResourcePolicy, this.manifest, this.options.scopedGrants!.repositoryId,
          this.options.currentEffectPolicyEpoch!(), this.options.effectResourceSignerKey!);
        suffix = effectResourcePathV2(this.signedEffectResourcePolicy, request.capability, args);
      } else {
        assertSignedEffectResourcePolicy(this.signedEffectResourcePolicy, this.manifest, this.options.scopedGrants!.repositoryId,
          this.options.currentEffectPolicyEpoch!(), this.options.effectResourceSignerKey!);
        suffix = signedEffectResourcePath(this.signedEffectResourcePolicy, request.capability, args);
      }
    } else suffix = this.options.effectResourcePath?.(context) ?? [];
    if (!Array.isArray(suffix)) throw new Error('invalid trusted effect resource policy');
    return [...this.scopedGrantPath(active.call.unit, active.journal.generation), ...suffix];
  }
  private authorizeScopedEffect(active: Active, capability: CapabilityName, path: readonly string[]): void {
    const authority = this.options.scopedGrants;
    if (!authority) return;
    const token = active.tokens.find(candidate => (candidate as ScopedGrantV2).body?.capability === capability);
    if (!token || !authority.verify(token, { capability, audience: active.call.symbol, path })) throw new Error(`authority_denied: scoped effect target ${capability}`);
    if (this.options.trustedClockAnchor) assertGrantLifetime(this.options.trustedClockAnchor, token.body.issuedAt, token.body.expiresAt);
  }
  private authorize(symbol: SymbolId, unit: string, generation: string, tokens: readonly ProcessInvocationGrant[]): void {
    if (!Array.isArray(tokens)) throw new Error('invocation tokens required');
    const required = [...new Set([PROCESS_INVOKE, ...this.declarations.get(symbol)!.capabilities])];
    if (this.options.scopedGrants) {
      if (tokens.length !== required.length) throw new Error('authority_denied: exact scoped grant set required');
      for (const token of tokens) validateScopedGrant(token);
      const basePath = this.scopedGrantPath(unit, generation);
      for (const cap of required) {
        const matches = tokens.filter(token => (token as ScopedGrantV2).body.capability === cap);
        const scoped = matches[0] as ScopedGrantV2 | undefined;
        if (!scoped || matches.length !== 1 || basePath.some((part, index) => scoped.body.path[index] !== part)
          || cap === PROCESS_INVOKE && scoped.body.path.length !== basePath.length
          || !this.options.scopedGrants.verify(scoped, { capability: cap, audience: symbol,
            path: cap === PROCESS_INVOKE ? basePath : scoped.body.path })) throw new Error(`authority_denied: missing valid ${cap}`);
        if (this.options.trustedClockAnchor) assertGrantLifetime(this.options.trustedClockAnchor, scoped.body.issuedAt, scoped.body.expiresAt);
      }
      this.checkRevocations(symbol, unit, generation, 'live'); return;
    }
    for (const token of tokens) {
      exactObject(token, ['capability', 'scope', 'expiresAt', 'nonce', 'signature']);
      if (typeof token.capability !== 'string' || typeof token.scope !== 'string' || !Number.isSafeInteger(token.expiresAt) || token.expiresAt < 0 || typeof token.nonce !== 'string' || !/^[0-9a-f]{32}$/.test(token.nonce) || typeof token.signature !== 'string' || !/^[0-9a-f]{64}$/.test(token.signature)) throw new Error('malformed invocation grant');
    }
    for (const cap of required) {
      const token = tokens.find(token => (token as CapabilityToken).capability === cap) as CapabilityToken | undefined;
      if (!token || !this.options.sealer.verify(token, this.tokenScope(unit, generation, symbol))) throw new Error(`authority_denied: missing valid ${cap}`);
    }
    this.checkRevocations(symbol, unit, generation, 'live');
  }
  private checkRevocations(symbol: SymbolId, unit: string, generation: string, mode: 'live' | 'replay'): void { for (const cap of [PROCESS_INVOKE, ...this.declarations.get(symbol)!.capabilities]) this.checkRevocation(cap, unit, generation, mode); }
  private checkRevocation(cap: CapabilityName, unit: string, generation: string, mode: 'live' | 'replay'): void {
    if (mode === 'replay') return;
    if (this.options.revocations?.isRevoked(cap) || this.options.revocations?.isRevoked(cap, unit) || this.options.revocations?.isRevoked(cap, `${unit}/${generation}`)) throw new Error(`authority_revoked: ${cap}`);
  }
  private locallyReachable(start: SymbolId, target: SymbolId, unit: string, plan: TopologyPlan): boolean {
    const pending = [start], seen = new Set<SymbolId>();
    while (pending.length) { const symbol = pending.pop()!; if (seen.has(symbol)) continue; seen.add(symbol); if (this.unitIn(plan, symbol) !== unit) continue; if (symbol === target) return true; pending.push(...this.edges.get(symbol) ?? []); }
    return false;
  }
  private scope(journal: HostJournal, unit: string): ProcessScope { return { executionManifest: executionManifestDigest(this.manifest), astRoot: this.manifest.astRoot as NodeRef, heapId: journal.snapshot.heapId, ownershipEpoch: journal.generation, unit }; }
  private unitIn(plan: TopologyPlan, symbol: SymbolId): string | null { return plan.units.find(unit => unit.members.includes(symbol))?.id ?? null; }
  private validatePlan(plan: TopologyPlan): void {
    const maximum = this.options.maxWorkers ?? 32;
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 1024 || !Array.isArray(plan.units) || !plan.units.length || plan.units.length > maximum) throw new Error('invalid process topology size');
    planBytes(plan); const ids = new Set<string>(), symbols = new Set<SymbolId>();
    for (const unit of plan.units) {
      identifier(unit.id);
      if (ids.has(unit.id) || !unit.members.length || !['linked', 'container', 'edge'].includes(unit.placement) || !Number.isFinite(unit.memoryMb) || unit.memoryMb < 0) throw new Error('invalid topology unit'); ids.add(unit.id);
      const caps = new Set<CapabilityName>();
      for (const symbol of unit.members) { if (symbols.has(symbol) || !this.declarations.has(symbol)) throw new Error('duplicate or unbound placement'); symbols.add(symbol); this.declarations.get(symbol)!.capabilities.forEach(cap => caps.add(cap)); }
      if (JSON.stringify([...caps].sort()) !== JSON.stringify([...unit.capabilities].sort())) throw new Error('unit capability manifest mismatch');
      if (unit.placement === 'edge' && [...caps].some(cap => ['db', 'fs', 'secrets'].includes(cap.split(':')[1]))) throw new Error('capability cannot be placed at edge');
      if (unit.memoryMb > (plan.constraints?.cost ?? DEFAULT_COST_MODEL).maxUnitMemoryMb) throw new Error('unit exceeds topology memory constraint');
      if (unit.members.length > 1 && unit.capabilities.some((cap: CapabilityName) => plan.constraints?.isolate.includes(cap))) throw new Error('capability requires isolated placement');
    }
    if (symbols.size !== this.declarations.size) throw new Error('topology must place every function');
    for (const group of plan.constraints?.concurrencyGroups ?? []) if (group.some(symbol => !symbols.has(symbol)) || new Set(group.map(symbol => this.unitIn(plan, symbol))).size > 1) throw new Error('topology splits a single-writer group');
  }
  private validateSnapshot(snapshot: RuntimeSnapshotV1, generation: string, plan: TopologyPlan): void {
    validateRuntimeSnapshot(snapshot);
    fromWireSnapshot(snapshot, { executionManifest: executionManifestDigest(this.manifest), astRoot: this.manifest.astRoot as NodeRef, heapId: snapshot.heapId, ownershipEpoch: generation, unit: plan.units[0].id });
    if (snapshot.ownership.some(owner => !plan.units.some(unit => unit.id === owner.unit))) throw new Error('snapshot ownership references a removed unit');
  }
  private assertReady(journal: HostJournal): void {
    if (journal.checkpointLeases?.some(lease => lease.state === 'active')) throw new Error('state domain held by an active resumable checkpoint lease');
    if (journal.calls.some(call => call.state === 'running' || call.state === 'indeterminate')) throw new Error('state domain blocked by an indeterminate operation');
    if (journal.migrations.some(migration => ['requested', 'prepared', 'committed'].includes(migration.state))) throw new Error('migration recovery must finish before another state transition');
  }
  private result(call: CallRecord, journal: HostJournal): ProcessHostCallResult {
    this.assertV4TerminalEffects(journal, call);
    if (call.state === 'completed') return freeze(copy({ state: 'completed', operationId: call.operationId, generation: call.generation, unit: call.unit, execution: call.execution! }));
    return { state: call.state === 'aborted' ? 'aborted' : 'indeterminate', operationId: call.operationId, generation: call.generation, unit: call.unit, reason: call.failure ?? 'operation outcome not known' };
  }
  private retain(journal: HostJournal, snapshot: RuntimeSnapshotV1): void { const digest = runtimeSnapshotDigest(snapshot); if (!journal.snapshots.some(saved => saved.digest === digest)) journal.snapshots.push({ digest, snapshot: copy(snapshot) }); }
  private appendHead(journal: HostJournal, cause: StateHead['cause']): void {
    const head: StateHead = { sequence: String(journal.heads.length), parent: journal.heads.at(-1)?.digest ?? null, generation: journal.generation, planDigest: domainDigest('aether.process-plan/1', journal.plan), snapshotDigest: runtimeSnapshotDigest(journal.snapshot), cause, digest: '' };
    head.digest = stateHeadDigest(head); journal.heads.push(head);
  }
  private persist(journal: HostJournal): void {
    const bytes = encodeCanonical(journal); atomicWrite(this.file, Buffer.from(bytes).toString('utf8'));
    const fd = openSync(this.options.directory, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); }
  }
  private read(): HostJournal {
    if (statSync(this.file).size > 8 * 1024 * 1024) throw new Error('process journal size limit');
    const decoded = decodeCanonical(readFileSync(this.file));
    const keys = ['format', 'configuration', 'generation', 'plan', 'snapshot', 'calls', 'migrations', 'allocations', 'snapshots', 'heads'];
    if (['aether.process-host/2', 'aether.process-host/3'].includes((decoded as { format: string }).format)) keys.push('checkpointLeases', 'checkpointReceipts');
    if ((decoded as { format?: string }).format === 'aether.process-host/3') keys.push('checkpointControls');
    const journal = exactObject(decoded, keys) as unknown as HostJournal;
    if (!['aether.process-host/1', 'aether.process-host/2', 'aether.process-host/3'].includes(journal.format) || journal.configuration !== this.configuration) throw new Error('process journal configuration mismatch');
    decimal(journal.generation); if (typeof journal.plan !== 'string') throw new Error('invalid stored topology');
    const plan = JSON.parse(journal.plan) as TopologyPlan; this.validatePlan(plan); this.validateSnapshot(journal.snapshot, journal.generation, plan);
    if (![journal.calls, journal.migrations, journal.allocations, journal.snapshots, journal.heads].every(Array.isArray)) throw new Error('invalid process journal arrays');
    const generationPlans = new Map<string, TopologyPlan>([[this.options.initialGeneration ?? '1', this.options.plan]]);
    const migrations = new Set<string>();
    let projectedGeneration = this.options.initialGeneration ?? '1', projectedPlan = planBytes(this.options.plan);
    for (const migration of journal.migrations) {
      exactObject(migration, ['migrationId', 'requestDigest', 'symbol', 'target', 'fromGeneration', 'toGeneration', 'state', 'beforePlan', 'afterPlan', 'before', 'after', 'failure', 'decisionDigest']);
      identifier(migration.migrationId); identifier(migration.target); decimal(migration.fromGeneration); decimal(migration.toGeneration);
      if (migrations.has(migration.migrationId) || !['requested', 'prepared', 'committed', 'finalized', 'aborted'].includes(migration.state) || !this.declarations.has(migration.symbol)) throw new Error('invalid migration record');
      migrations.add(migration.migrationId);
      if (domainDigest('aether.process-move/1', { symbol: migration.symbol, target: migration.target }) !== migration.requestDigest || migrationDecisionDigest(migration) !== migration.decisionDigest) throw new Error('corrupt migration decision');
      if (!migration.after || typeof migration.afterPlan !== 'string' || typeof migration.beforePlan !== 'string' || migration.fromGeneration !== projectedGeneration || migration.beforePlan !== projectedPlan) throw new Error('migration history does not follow the committed plan');
      const beforePlan = JSON.parse(migration.beforePlan) as TopologyPlan, afterPlan = JSON.parse(migration.afterPlan) as TopologyPlan;
      this.validatePlan(beforePlan); this.validatePlan(afterPlan);
      if (planBytes(beforePlan) !== migration.beforePlan || planBytes(afterPlan) !== migration.afterPlan) throw new Error('noncanonical migration plan');
      this.validateSnapshot(migration.before, migration.fromGeneration, beforePlan); this.validateSnapshot(migration.after, migration.toGeneration, afterPlan);
      if (migration.before.heapId !== journal.snapshot.heapId || migration.after.heapId !== journal.snapshot.heapId) throw new Error('migration changed logical heap identity');
      const noOp = this.unitIn(beforePlan, migration.symbol) === migration.target;
      if (BigInt(migration.toGeneration) !== BigInt(migration.fromGeneration) + (noOp ? 0n : 1n)) throw new Error('invalid migration generation advance');
      for (const symbol of this.declarations.keys()) if (this.unitIn(afterPlan, symbol) !== (symbol === migration.symbol ? migration.target : this.unitIn(beforePlan, symbol))) throw new Error('migration changed an unrelated placement');
      const expected = reepoch(migration.before, migration.toGeneration, new Set(afterPlan.units.map(unit => unit.id)), migration.target);
      if (runtimeSnapshotDigest(expected) !== runtimeSnapshotDigest(migration.after)) throw new Error('migration altered logical data');
      if (migration.state === 'committed' || migration.state === 'finalized') { projectedGeneration = migration.toGeneration; projectedPlan = migration.afterPlan; generationPlans.set(projectedGeneration, afterPlan); }
    }
    if (journal.generation !== projectedGeneration || journal.plan !== projectedPlan || planBytes(plan) !== journal.plan) throw new Error('active generation lacks its durable migration decision');
    const retained = new Map<string, RuntimeSnapshotV1>();
    for (const saved of journal.snapshots) {
      exactObject(saved, ['digest', 'snapshot']);
      if (runtimeSnapshotDigest(saved.snapshot) !== saved.digest || retained.has(saved.digest) || saved.snapshot.heapId !== journal.snapshot.heapId || saved.snapshot.executionManifest !== executionManifestDigest(this.manifest)) throw new Error('corrupt retained process snapshot');
      retained.set(saved.digest, saved.snapshot);
    }
    const operations = new Set<string>();
    for (const call of journal.calls) {
      exactObject(call, ['operationId', 'requestDigest', 'symbol', 'args', 'generation', 'unit', 'state', 'before', 'latest', 'execution', 'executionDigest', 'effects', 'boundaries', 'failure', 'recovery']);
      identifier(call.operationId); identifier(call.unit); decimal(call.generation);
      if (operations.has(call.operationId)) throw new Error('duplicate process operation'); operations.add(call.operationId);
      if (!['running', 'completed', 'indeterminate', 'aborted'].includes(call.state) || !this.declarations.has(call.symbol) || !Array.isArray(call.args) || !Array.isArray(call.effects) || !Array.isArray(call.boundaries) || (call.failure !== null && typeof call.failure !== 'string')) throw new Error('invalid process call record');
      const historicalPlan = generationPlans.get(call.generation);
      if (!historicalPlan || this.unitIn(historicalPlan, call.symbol) !== call.unit) throw new Error('call is bound to an invalid generation/placement');
      const digest = domainDigest('aether.process-call/1', { manifest: executionManifestDigest(this.manifest), symbol: call.symbol, args: call.args });
      if (digest !== call.requestDigest) throw new Error('corrupt call intent');
      this.validateSnapshot(call.before, call.generation, historicalPlan); this.validateSnapshot(call.latest, call.generation, historicalPlan);
      if (call.before.heapId !== journal.snapshot.heapId || call.latest.heapId !== journal.snapshot.heapId) throw new Error('call changed logical heap identity');
      const scope = { ...this.scope(journal, call.unit), ownershipEpoch: call.generation };
      call.args.forEach(value => decodeProcessValue(value, scope, call.before));
      const bindings = validateProcessArguments(this.declarations.get(call.symbol)!, call.args, call.before);
      if (call.state === 'completed') {
        if (!call.execution || call.executionDigest !== callOutcomeDigest(call)) throw new Error('corrupt completed call outcome');
        decodeProcessExecution(call.execution, scope, call.latest);
        if (call.execution.ok) validateProcessResult(this.declarations.get(call.symbol)!, call.execution.value, call.latest, bindings);
      } else if (call.execution !== null || call.executionDigest !== null) throw new Error('uncompleted call carries an outcome');
      const frames = new Map<string, { symbol: SymbolId; unit: string }>([[processExecutionId(call.before.heapId, call.operationId), { symbol: call.symbol, unit: call.unit }]]);
      const usedIndexes = new Set<string>();
      for (const boundary of call.boundaries) {
        exactObject(boundary, ['id', 'parentOperationId', 'index', 'from', 'to', 'fromUnit', 'toUnit', 'args', 'snapshotDigest', 'requestDigest']);
        const parent = frames.get(boundary.parentOperationId), indexKey = JSON.stringify([boundary.parentOperationId, boundary.index]);
        if (!parent || usedIndexes.has(indexKey) || frames.has(boundary.id) || boundary.id !== processBoundaryId(boundary.parentOperationId, 'call', boundary.index) || !this.locallyReachable(parent.symbol, boundary.from, parent.unit, historicalPlan) || !this.edges.get(boundary.from)?.has(boundary.to) || parent.unit !== boundary.fromUnit || this.unitIn(historicalPlan, boundary.to) !== boundary.toUnit) throw new Error('invalid retained call ancestry');
        const { requestDigest: recordedDigest, ...body } = boundary;
        if (domainDigest('aether.process-call-boundary/1', body) !== recordedDigest) throw new Error('corrupt call boundary intent');
        const snapshot = retained.get(boundary.snapshotDigest); if (!snapshot) throw new Error('missing call boundary snapshot');
        this.validateSnapshot(snapshot, call.generation, historicalPlan);
        boundary.args.forEach(value => decodeProcessValue(value, { ...scope, unit: boundary.fromUnit }, snapshot));
        validateProcessArguments(this.declarations.get(boundary.to)!, boundary.args, snapshot);
        frames.set(boundary.id, { symbol: boundary.to, unit: boundary.toUnit }); usedIndexes.add(indexKey);
      }
      const effects = new Set<string>();
      for (const effect of call.effects) {
        exactObject(effect, ['id', 'capability', 'requestDigest', 'snapshotDigest', 'unit', 'from', 'args', 'parentOperationId', 'index', 'outcomeDigest', 'state', 'value', 'code']);
        identifier(effect.id); identifier(effect.unit); validateDigest(effect.snapshotDigest);
        const parent = frames.get(effect.parentOperationId), indexKey = JSON.stringify([effect.parentOperationId, effect.index]);
        if (effects.has(effect.id) || !parent || parent.unit !== effect.unit || !this.locallyReachable(parent.symbol, effect.from, parent.unit, historicalPlan) || usedIndexes.has(indexKey) || effect.id !== processBoundaryId(effect.parentOperationId, 'effect', effect.index) || !['requested', 'dispatching', 'committed', 'rejected', 'aborted', 'indeterminate'].includes(effect.state) || !Array.isArray(effect.args)) throw new Error('invalid effect record'); effects.add(effect.id); usedIndexes.add(indexKey);
        if (this.unitIn(historicalPlan, effect.from) !== effect.unit || !this.declarations.get(effect.from)?.capabilities.includes(effect.capability) || !this.declarations.get(call.symbol)!.capabilities.includes(effect.capability)) throw new Error('effect exceeds its caller authority');
        const before = retained.get(effect.snapshotDigest); if (!before) throw new Error('missing effect boundary snapshot');
        this.validateSnapshot(before, call.generation, historicalPlan);
        effect.args.forEach(value => decodeProcessValue(value, { ...scope, unit: effect.unit }, before));
        const intent = domainDigest('aether.process-effect/1', { id: effect.id, capability: effect.capability, args: effect.args, snapshotDigest: effect.snapshotDigest, unit: effect.unit, from: effect.from });
        if (intent !== effect.requestDigest || effect.outcomeDigest !== effectOutcomeDigest(effect)) throw new Error('corrupt effect intent/outcome');
        if (effect.state === 'committed') { if (effect.value === null || effect.code !== null) throw new Error('committed effect lacks a clean value'); decodeProcessValue(effect.value, { ...scope, unit: effect.unit }, before); }
        else if (effect.value !== null) throw new Error('uncommitted effect carries a value');
        if (call.state === 'completed' && ['dispatching', 'indeterminate'].includes(effect.state)) throw new Error('completed call contains an unresolved effect');
      }
      if (call.recovery !== null) {
        exactObject(call.recovery, ['strategy', 'evidenceDigest']);
        if (!['isolated-replay', 'abort-before-effects', 'abort-readonly-wasm'].includes(call.recovery.strategy)) throw new Error('invalid recovery strategy');
        const evidence = call.recovery.strategy === 'isolated-replay' ? { operationId: call.operationId, before: runtimeSnapshotDigest(call.before), after: runtimeSnapshotDigest(call.latest), execution: call.execution, effects: call.effects } : { operationId: call.operationId, before: runtimeSnapshotDigest(call.before), effects: call.effects };
        const expectedRecovery = call.recovery.strategy === 'abort-readonly-wasm'
          ? this.signedEffectResourcePolicy?.format === 'aether.signed-effect-resource-policy/4'
            ? domainDigest('aether.process-readonly-wasm-abort/1', { operationId: call.operationId,
              before: runtimeSnapshotDigest(call.before), effects: call.effects,
              policy: effectResourcePolicyDigestV4(this.signedEffectResourcePolicy.body), configuration: this.configuration })
            : null
          : domainDigest('aether.process-recovery/1', evidence);
        if (expectedRecovery !== call.recovery.evidenceDigest) throw new Error('corrupt recovery evidence');
        if (call.recovery.strategy === 'abort-before-effects' && (call.state !== 'aborted' || call.effects.some(effect => !['requested', 'rejected', 'aborted'].includes(effect.state)))) throw new Error('abort is not supported by noncommit evidence');
        if (call.recovery.strategy === 'abort-readonly-wasm' && (call.state !== 'aborted'
          || this.signedEffectResourcePolicy?.format !== 'aether.signed-effect-resource-policy/4'
          || call.effects.some(effect => !this.signedEffectResourcePolicy!.body.rules.some(rule => rule.capability === effect.capability))))
          throw new Error('read-only Wasm abort is outside signed policy');
      }
      if (call.state === 'aborted' && !['abort-before-effects', 'abort-readonly-wasm'].includes(call.recovery?.strategy ?? ''))
        throw new Error('aborted call lacks authorized noncommit evidence');
    }
    for (const allocation of journal.allocations) {
      exactObject(allocation, ['operationId', 'requestDigest', 'reference', 'ty', 'fields', 'requestedUnit', 'unit', 'beforeSnapshotDigest', 'afterSnapshotDigest', 'receiptDigest']);
      identifier(allocation.operationId); identifier(allocation.unit);
      if (operations.has(allocation.operationId)) throw new Error('duplicate allocation ID'); operations.add(allocation.operationId);
      if (allocation.requestedUnit !== null) identifier(allocation.requestedUnit);
      if (domainDigest('aether.process-allocation/1', { ty: allocation.ty, fields: allocation.fields, unit: allocation.requestedUnit }) !== allocation.requestDigest || allocationReceiptDigest(allocation) !== allocation.receiptDigest) throw new Error('corrupt allocation intent/receipt');
      const ref = allocation.reference; exactObject(ref, ['heapId', 'objectId', 'ownerEpoch']); identifier(ref.heapId); decimal(ref.objectId); decimal(ref.ownerEpoch);
      const before = retained.get(allocation.beforeSnapshotDigest), after = retained.get(allocation.afterSnapshotDigest), historicalPlan = generationPlans.get(ref.ownerEpoch);
      if (!before || !after || !historicalPlan || ref.heapId !== journal.snapshot.heapId || ref.objectId !== before.nextObjectId || !historicalPlan.units.some(unit => unit.id === allocation.unit)) throw new Error('dangling allocation receipt');
      this.validateSnapshot(before, ref.ownerEpoch, historicalPlan); this.validateSnapshot(after, ref.ownerEpoch, historicalPlan);
      validateProcessAllocation(allocation.ty, allocation.fields, before);
      const ty = underlying(allocation.ty); if (ty.t !== 'Record') throw new Error('allocation did not name a record type');
      const expected: RuntimeSnapshotV1 = { ...before, nextObjectId: String(BigInt(before.nextObjectId) + 1n), records: [...before.records, { objectId: ref.objectId, fields: ty.fields.map(([name]) => [name, allocation.fields[name] ?? { tag: 'null' } as TaggedValueV1] as const).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0) }], ownership: [...before.ownership, { objectId: ref.objectId, unit: allocation.unit, epoch: ref.ownerEpoch }] };
      if (runtimeSnapshotDigest(expected) !== allocation.afterSnapshotDigest) throw new Error('allocation changed existing logical data');
    }
    if (journal.format === 'aether.process-host/2' || journal.format === 'aether.process-host/3') {
      if (!Array.isArray(journal.checkpointLeases) || !Array.isArray(journal.checkpointReceipts)) throw new Error('invalid checkpoint journal extension');
      const bindings = new Set<string>(), receipts = new Set<string>(); let active = 0;
      const program = this.checkpointProgram();
      for (const lease of journal.checkpointLeases) {
        exactObject(lease, ['binding', 'state', 'latestCheckpoint', 'checkpoints', 'receipt']); validateProcessCheckpointBinding(lease.binding);
        if (bindings.has(lease.binding.id) || operations.has(lease.binding.operationId) || lease.binding.configuration !== this.configuration || lease.binding.program !== program.digest || !['active', 'committed', 'aborted'].includes(lease.state) || !Array.isArray(lease.checkpoints) || !lease.checkpoints.length || lease.checkpoints[0] !== lease.binding.initialCheckpoint || lease.checkpoints.at(-1) !== lease.latestCheckpoint) throw new Error('corrupt checkpoint lease');
        bindings.add(lease.binding.id); operations.add(lease.binding.operationId);
        const base = readProcessCheckpoint(this.options.directory, lease.binding.baseCheckpoint, program), initial = readProcessCheckpoint(this.options.directory, lease.binding.initialCheckpoint, program), before = retained.get(lease.binding.beforeSnapshot), historicalPlan = generationPlans.get(lease.binding.generation);
        if (!before || !historicalPlan || historicalPlan.units.length !== 1 || this.unitIn(historicalPlan, lease.binding.symbol) !== lease.binding.unit || initial.core.executionId !== lease.binding.executionId || initial.core.effectCursor !== '0') throw new Error('checkpoint lease lacks a valid ownership base');
        assertBaseProjection(base, before, lease.binding.generation, lease.binding.unit); validateCheckpointExtension(base, initial, program);
        if (new Set(lease.checkpoints).size !== lease.checkpoints.length || lease.checkpoints.some(digest => !retainedProcessCheckpointExists(this.options.directory, digest))) throw new Error('missing or duplicate retained checkpoint');
        const previousCheckpoint = lease.latestCheckpoint === lease.binding.initialCheckpoint ? initial : readProcessCheckpoint(this.options.directory, lease.latestCheckpoint, program);
        validateCheckpointExtension(base, previousCheckpoint, program); validateCheckpointExtension(initial, previousCheckpoint, program);
        projectProcessCheckpoint(previousCheckpoint, before, lease.binding.generation, lease.binding.unit);
        if (lease.state === 'active') { active++; if (lease.receipt !== null || lease.binding.generation !== journal.generation || lease.binding.beforeSnapshot !== runtimeSnapshotDigest(journal.snapshot) || lease.binding.processHead !== journal.heads.at(-1)?.digest) throw new Error('active checkpoint lease is stale'); }
        if (lease.state === 'aborted' && (lease.receipt !== null || previousCheckpoint.core.effectCursor !== '0')) throw new Error('invalid checkpoint abort');
        if (lease.state === 'committed' && (lease.receipt === null || previousCheckpoint.core.state !== 'completed' || previousCheckpoint.core.frames.length || previousCheckpoint.core.fault !== null)) throw new Error('invalid checkpoint completion');
      }
      if (active > 1) throw new Error('multiple checkpoint owners');
      for (const receipt of journal.checkpointReceipts) {
        exactObject(receipt, ['format', 'id', 'binding', 'checkpoint', 'beforeSnapshot', 'afterSnapshot', 'effectAudit', 'eventHead', 'eventCursor']);
        const { id, ...body } = receipt, lease = journal.checkpointLeases.find(lease => lease.binding.id === receipt.binding);
        if (receipt.format !== 'aether.process-checkpoint-receipt/1' || processCheckpointReceiptDigest(body) !== id || receipts.has(id) || !lease || lease.state !== 'committed' || lease.receipt !== id || lease.latestCheckpoint !== receipt.checkpoint || lease.binding.beforeSnapshot !== receipt.beforeSnapshot) throw new Error('corrupt checkpoint publication receipt');
        validateDigest(receipt.effectAudit); const snapshot = readProcessCheckpoint(this.options.directory, receipt.checkpoint, program), before = retained.get(receipt.beforeSnapshot);
        readCheckpointEffectAudit(this.options.directory, receipt.effectAudit, snapshot);
        if (!before || receipt.afterSnapshot !== runtimeSnapshotDigest(projectProcessCheckpoint(snapshot, before, lease.binding.generation, lease.binding.unit)) || receipt.eventHead !== snapshot.eventHead || receipt.eventCursor !== snapshot.eventCursor) throw new Error('checkpoint receipt lost its exact state/event binding'); receipts.add(id);
      }
      if (journal.checkpointLeases.some(lease => lease.state === 'committed' && !receipts.has(lease.receipt!))) throw new Error('checkpoint lease lacks publication receipt');
      if (journal.format === 'aether.process-host/3' && !Array.isArray(journal.checkpointControls)) throw new Error('missing checkpoint control audit');
      const controlIds = new Set<string>(), controlOperations = new Set<string>(), priorControl = new Map<string, Digest>(), auditedEvents = new Map<string, Map<number, Digest>>();
      for (const control of journal.checkpointControls ?? []) {
        exactObject(control, ['format', 'id', 'binding', 'request', 'beforeCheckpoint', 'afterCheckpoint', 'previous', 'effectAudit', 'effectCount']); validateCheckpointControlRequest(control.request);
        const { id, ...body } = control, lease = journal.checkpointLeases.find(lease => lease.binding.id === control.binding);
        if (control.format !== 'aether.process-checkpoint-control/1' || checkpointControlDigest(body) !== id || controlIds.has(id) || controlOperations.has(control.request.operationId) || !lease || control.previous !== (priorControl.get(control.binding) ?? null) || !Number.isSafeInteger(control.effectCount) || control.effectCount < 0) throw new Error('invalid checkpoint control audit chain');
        const beforeIndex = lease.checkpoints.indexOf(control.beforeCheckpoint);
        if (beforeIndex < 0 || lease.checkpoints[beforeIndex + 1] !== control.afterCheckpoint) throw new Error('checkpoint control lost its durable state ordering');
        const before = readProcessCheckpoint(this.options.directory, control.beforeCheckpoint, program), after = readProcessCheckpoint(this.options.directory, control.afterCheckpoint, program);
        validateCheckpointControlTransition(control.request, before, after, program,
          control.request.kind === 'packed-v1' || control.request.kind === 'packed-v2' ? readProcessPackedLayout(this.options.directory, control.request.layoutDigest) : undefined);
        if (readCheckpointEffectAudit(this.options.directory, control.effectAudit, before).length !== control.effectCount) throw new Error('checkpoint replay barrier differs from retained effects');
        const previous = (journal.checkpointControls ?? []).find(item => item.id === control.previous);
        if (previous && BigInt(before.core.effectCursor) < BigInt(previous.effectCount)) throw new Error('control bypassed checkpoint replay debt');
        const initial = readProcessCheckpoint(this.options.directory, lease.binding.initialCheckpoint, program);
        if (control.request.kind === 'rewind' && before.events.length - control.request.steps < initial.events.length) throw new Error('control rewound outside its ownership lease');
        const events = auditedEvents.get(control.binding) ?? new Map<number, Digest>(); events.set(after.events.length, eventDigest(after.events.at(-1)!)); auditedEvents.set(control.binding, events);
        priorControl.set(control.binding, id); controlIds.add(id); controlOperations.add(control.request.operationId);
      }
      for (const lease of journal.checkpointLeases) {
        const latest = readProcessCheckpoint(this.options.directory, lease.latestCheckpoint, program), initial = readProcessCheckpoint(this.options.directory, lease.binding.initialCheckpoint, program);
        for (const event of latest.events.slice(initial.events.length)) if (event.code === 'host' && (event.op === 'correction' || event.op.startsWith('rewind-v1:') || event.op.startsWith('packed-correction:') || event.op.startsWith('packed-correction-v2:'))) {
          if (auditedEvents.get(lease.binding.id)?.get(Number(event.sequence)) !== eventDigest(event)) throw new Error('checkpoint history contains an unaudited control');
        }
        const barrier = (journal.checkpointControls ?? []).filter(control => control.binding === lease.binding.id).at(-1);
        if (barrier && lease.state !== 'active' && BigInt(latest.core.effectCursor) < BigInt(barrier.effectCount)) throw new Error('terminal lease discarded checkpoint replay debt');
      }
    }
    if (!journal.heads.length) throw new Error('process state has no durable head');
    let previous: StateHead | null = null;
    const causes = new Set<string>();
    for (const [index, head] of journal.heads.entries()) {
      exactObject(head, ['sequence', 'parent', 'generation', 'planDigest', 'snapshotDigest', 'cause', 'digest']); exactObject(head.cause, ['kind', 'operationId', 'subjectDigest']);
      decimal(head.generation); identifier(head.cause.operationId);
      if (head.sequence !== String(index) || head.parent !== (previous?.digest ?? null) || stateHeadDigest(head) !== head.digest || !retained.has(head.snapshotDigest)) throw new Error('corrupt state-head chain');
      const causeId = JSON.stringify([head.cause.kind, head.cause.operationId]); if (causes.has(causeId)) throw new Error('state transition applied twice'); causes.add(causeId);
      if (head.cause.kind === 'initial') {
        if (index !== 0 || head.cause.operationId !== 'initial' || head.cause.subjectDigest !== this.configuration || head.generation !== (this.options.initialGeneration ?? '1') || head.planDigest !== domainDigest('aether.process-plan/1', planBytes(this.options.plan))) throw new Error('invalid initial state head');
        const initial = retained.get(head.snapshotDigest)!;
        if (this.options.initialSnapshot ? runtimeSnapshotDigest(this.options.initialSnapshot) !== head.snapshotDigest : initial.records.length !== 0 || initial.nextObjectId !== '1' || initial.eventCursor !== '0') throw new Error('initial state differs from its authorized seed');
      } else {
        if (!previous) throw new Error('state transition lacks predecessor');
        if (head.cause.kind !== 'migration' && (head.generation !== previous.generation || head.planDigest !== previous.planDigest)) throw new Error('state changed generation without migration');
        if (head.cause.kind === 'allocation') {
          const allocation = journal.allocations.find(record => record.operationId === head.cause.operationId);
          if (!allocation || head.cause.subjectDigest !== allocation.receiptDigest || head.snapshotDigest !== allocation.afterSnapshotDigest || previous.snapshotDigest !== allocation.beforeSnapshotDigest || head.generation !== allocation.reference.ownerEpoch) throw new Error('state head does not match allocation receipt');
        } else if (head.cause.kind === 'call') {
          const call = journal.calls.find(record => record.operationId === head.cause.operationId);
          if (!call || call.state !== 'completed' || head.cause.subjectDigest !== call.executionDigest || head.snapshotDigest !== runtimeSnapshotDigest(call.latest) || previous.snapshotDigest !== runtimeSnapshotDigest(call.before) || head.generation !== call.generation) throw new Error('state head does not match completed call');
        } else if (head.cause.kind === 'abort') {
          const call = journal.calls.find(record => record.operationId === head.cause.operationId);
          if (!call || call.state !== 'aborted' || head.cause.subjectDigest !== call.recovery?.evidenceDigest || head.snapshotDigest !== runtimeSnapshotDigest(call.before) || previous.snapshotDigest !== runtimeSnapshotDigest(call.before) || head.generation !== call.generation) throw new Error('state head does not match authorized abort');
        } else if (head.cause.kind === 'checkpoint') {
          const receipt = journal.checkpointReceipts?.find(receipt => receipt.id === head.cause.subjectDigest), lease = journal.checkpointLeases?.find(lease => lease.binding.operationId === head.cause.operationId);
          if (!receipt || !lease || receipt.binding !== lease.binding.id || lease.state !== 'committed' || previous.digest !== lease.binding.processHead || previous.snapshotDigest !== receipt.beforeSnapshot || head.snapshotDigest !== receipt.afterSnapshot || head.generation !== lease.binding.generation) throw new Error('state head does not match checkpoint receipt');
        } else if (head.cause.kind === 'migration') {
          const migration = journal.migrations.find(record => record.migrationId === head.cause.operationId);
          if (!migration || !['committed', 'finalized'].includes(migration.state) || migration.fromGeneration === migration.toGeneration || head.cause.subjectDigest !== migration.decisionDigest || head.snapshotDigest !== runtimeSnapshotDigest(migration.after!) || previous.snapshotDigest !== runtimeSnapshotDigest(migration.before) || head.generation !== migration.toGeneration || previous.generation !== migration.fromGeneration || head.planDigest !== domainDigest('aether.process-plan/1', migration.afterPlan) || previous.planDigest !== domainDigest('aether.process-plan/1', migration.beforePlan)) throw new Error('state head does not match migration decision');
        } else throw new Error('unknown state transition cause');
      }
      previous = head;
    }
    if (previous!.snapshotDigest !== runtimeSnapshotDigest(journal.snapshot) || previous!.generation !== journal.generation || previous!.planDigest !== domainDigest('aether.process-plan/1', journal.plan)) throw new Error('current state does not match durable state head');
    for (const allocation of journal.allocations) if (!causes.has(JSON.stringify(['allocation', allocation.operationId]))) throw new Error('allocation lacks a published state transition');
    for (const call of journal.calls) if ((call.state === 'completed' || call.state === 'aborted') && !causes.has(JSON.stringify([call.state === 'completed' ? 'call' : 'abort', call.operationId]))) throw new Error('terminal call lacks a published state transition');
    for (const migration of journal.migrations) if (['committed', 'finalized'].includes(migration.state) && migration.toGeneration !== migration.fromGeneration && !causes.has(JSON.stringify(['migration', migration.migrationId]))) throw new Error('migration lacks a published state transition');
    for (const lease of journal.checkpointLeases ?? []) if (lease.state === 'committed' && !causes.has(JSON.stringify(['checkpoint', lease.binding.operationId]))) throw new Error('checkpoint lacks published state transition');
    return journal;
  }
}
