import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { JournalLock } from './journal-lock.ts';
import { atomicWrite } from '../tier1/persistence.ts';
import { decimal, decodeCanonical, encodeCanonical, encodingLimits, exactObject, identifier, validateTaggedValue, type EncodingLimits, type TaggedValueV1 } from './encoding.ts';
import { domainDigest, validateDigest, type Digest } from './identity.ts';
import { assertBeforeDeadline, assertGrantLifetime, assertTrustedClockAnchor, type TrustedClockAnchor } from '../tier2/trusted-clock-anchor.ts';
import { advanceWitnessHead, assertEffectJournalWitness, readWitnessHead, type AnyEffectJournalWitness } from './effect-journal-witness.ts';
import { assertAttestedSinkAdapter, isAttestedSinkAdapter, verifiedSinkReceipt } from './attested-sink-adapter.ts';
import { validateSinkPublicAnchor, verifySinkReceipt, type SignedSinkReceiptV1, type SinkPublicAnchorV1 } from './sink-receipt.ts';
import { assertSinkStateWitness, readSinkStateHead, validateSinkStateJournalV2,
  type SinkStateJournalV2, type SinkStateWitnessV1 } from './sink-state-witness.ts';
import { ResourceBudgetBridge } from '../tier2/resource-budget-bridge.ts';

export type ExecutionMode = 'live' | 'speculative' | 'shadow' | 'replay';
export interface EffectRequestV1 {
  readonly format: 'aether.effect/1';
  readonly executionId: string;
  readonly effectId: string;
  readonly branchId: string | null;
  readonly executionManifest: Digest;
  readonly capabilityGrantRef: string;
  readonly policyEpoch: string;
  readonly payloadDigest: Digest;
  readonly payload: TaggedValueV1;
  readonly budgetReservationId: string | null;
  /** Canonical integer milliseconds in the broker's declared clock domain. */
  readonly deadline: string;
}
export type EffectOutcome =
  | { readonly state: 'committed'; readonly receiptDigest: Digest; readonly value: TaggedValueV1 }
  | { readonly state: 'rejected' | 'aborted'; readonly code: string }
  | { readonly state: 'indeterminate'; readonly recoveryId: string };
export interface EffectIsolatedState { readonly prefix: readonly EffectReplayPrefixEntry[]; readonly bufferedIntents: readonly EffectRequestV1[] }
export interface EffectReplayPrefixEntry { readonly requestDigest: Digest; readonly outcomeDigest: Digest }
export function effectReplayOutcomeDigest(outcome: EffectOutcome): Digest {
  if (outcome.state === 'committed') { exactObject(outcome, ['state', 'receiptDigest', 'value']); validateDigest(outcome.receiptDigest); validateTaggedValue(outcome.value); }
  else if (outcome.state === 'rejected' || outcome.state === 'aborted') { exactObject(outcome, ['state', 'code']); identifier(outcome.code); }
  else if (outcome.state === 'indeterminate') { exactObject(outcome, ['state', 'recoveryId']); identifier(outcome.recoveryId); }
  else throw new TypeError('invalid replay outcome');
  return domainDigest('aether.effect-replay-outcome/1', outcome);
}
export interface EffectAdapter {
  readonly id: string;
  readonly semantics: {
    readonly readOnly: boolean;
    readonly atomicIdempotency: boolean;
    readonly transactional: boolean;
    readonly reconciliation: boolean;
  };
  /** Pure, synchronous input validation before any dispatch marker or budget
   * reservation. It must not contact an external sink or execute guest code.
   * Throwing produces a durable terminal rejection. */
  preflight?(request: EffectRequestV1): void;
  /** Read-only or nontransactional sink operation. Must atomically enforce effectId if advertised. */
  execute?(request: EffectRequestV1): TaggedValueV1;
  /** Must not perform irreversible external work; returned token must be durable and serializable. */
  prepare?(request: EffectRequestV1): TaggedValueV1;
  commit?(request: EffectRequestV1, prepared: TaggedValueV1): TaggedValueV1;
  /** Null token covers a crash after prepare acted but before its token was persisted. Resolve by effect ID. */
  abort?(request: EffectRequestV1, prepared: TaggedValueV1 | null): void;
  /** Query the original operation; this callback must not submit a second operation. */
  reconcile?(request: EffectRequestV1, prepared: TaggedValueV1 | null):
    | { readonly state: 'committed'; readonly value: TaggedValueV1 }
    /** Definitive terminal noncommit: no still-pending dispatch may later commit. */
    | { readonly state: 'not_committed' }
    | { readonly state: 'unknown' };
}
export interface EffectBudget {
  /** All three hooks must be durable/idempotent by executionId + effectId, not by invocation count. */
  reserve(request: EffectRequestV1): boolean;
  consume(request: EffectRequestV1, value: TaggedValueV1): void;
  /** Release only the unused reservation after durable terminal noncommit.
   * Repeated release must be safe, including if no reservation was acquired. */
  release(request: EffectRequestV1): void;
}
export interface EffectEventV1 {
  readonly format: 'aether.effect-event/1' | 'aether.effect-event/3' | 'aether.effect-event/4';
  readonly sequence: string;
  readonly request: EffectRequestV1;
  readonly requestDigest: Digest;
  readonly adapterId: string;
  readonly adapterSemanticsDigest: Digest;
  readonly state: 'requested' | 'reserved' | 'prepared' | 'committed' | 'rejected' | 'aborted' | 'indeterminate';
  readonly transitions: readonly { readonly state: EffectEventV1['state']; readonly time: string; readonly dispatchStarted: boolean }[];
  readonly dispatchStarted: boolean;
  readonly prepared: TaggedValueV1 | null;
  readonly observedAt: string;
  readonly recordedAt: string;
  readonly outcome: EffectOutcome | null;
  /** Present only in V3. A terminal external decision retains the exact sink statement. */
  readonly signedSinkReceipt?: SignedSinkReceiptV1 | null;
}
export type EffectEventV3 = EffectEventV1 & {
  readonly format: 'aether.effect-event/3';
  readonly signedSinkReceipt: SignedSinkReceiptV1 | null;
};
export type EffectEventV4 = EffectEventV1 & {
  readonly format: 'aether.effect-event/4';
  readonly signedSinkReceipt: SignedSinkReceiptV1 | null;
};
interface EffectJournalV1 { format: 'aether.effect-journal/1'; clockDomain: string; records: EffectEventV1[] }
interface EffectJournalV2 { format: 'aether.effect-journal/2'; clockDomain: string; witnessDigest: Digest; revision: string; records: EffectEventV1[] }
interface EffectJournalV3 { format: 'aether.effect-journal/3'; clockDomain: string; witnessDigest: Digest; revision: string;
  deploymentId: string; approvedAdapterArtifactDigest: Digest; sinkAnchor: SinkPublicAnchorV1; records: EffectEventV3[] }
interface EffectJournalV4 { format: 'aether.effect-journal/4'; clockDomain: string; witnessDigest: Digest; revision: string;
  deploymentId: string; approvedAdapterArtifactDigest: Digest; sinkAnchor: SinkPublicAnchorV1;
  sinkStateWitnessDigest: Digest; records: EffectEventV3[] }
type EffectJournal = EffectJournalV1 | EffectJournalV2 | EffectJournalV3 | EffectJournalV4 | EffectJournalV5;
export interface AttestedEffectBrokerOptionsV3 {
  readonly anchor: SinkPublicAnchorV1;
  readonly deploymentId: string;
  readonly approvedAdapterArtifactDigest: Digest;
}
export interface AttestedEffectBrokerOptionsV4 extends AttestedEffectBrokerOptionsV3 {
  /** Separately held monotonic sink decision inventory, selected by the operator. */
  readonly sinkStateWitness: SinkStateWitnessV1;
}
export interface AttestedSinkBudgetBrokerOptionsV1 {
  readonly format: 'aether.attested-sink-budget-broker/1';
  /** Exact bridge chosen by the operator outside a reloadable router factory. */
  readonly bridge: ResourceBudgetBridge;
  readonly bridgeProfileDigest: Digest;
}
interface EffectJournalV5 { format: 'aether.effect-journal/5'; clockDomain: string; witnessDigest: Digest; revision: string;
  deploymentId: string; approvedAdapterArtifactDigest: Digest; sinkAnchor: SinkPublicAnchorV1;
  sinkStateWitnessDigest: Digest; budgetBridgeProfileDigest: Digest; records: EffectEventV4[] }
export interface EffectBrokerOptions {
  readonly directory: string;
  readonly mode?: ExecutionMode;
  readonly clockDomain: string;
  readonly clock?: () => bigint;
  /** Called for every new live dispatch and again immediately before the irreversible operation. */
  readonly authorize: (request: EffectRequestV1) => boolean;
  /** Selected branches require a coordinator-issued live effect ID and explicit admission. Defaults to deny. */
  readonly authorizeBranch?: (request: EffectRequestV1) => boolean;
  /** Separate read/cleanup authority permits recovery after the original execution grant is revoked. */
  readonly authorizeReconciliation?: (request: EffectRequestV1) => boolean;
  readonly budgets?: EffectBudget;
  readonly limits?: Partial<EncodingLimits>;
  readonly replayEvents?: readonly EffectEventV1[];
  /** Opt-in complete-journal CAS outside this directory. Provider custody is
   * a separate deployment obligation; a reloadable factory must not supply it. */
  readonly witness?: AnyEffectJournalWitness;
  /** Opt-in V3. Requires the independently operated journal witness above. */
  readonly attestedSink?: AttestedEffectBrokerOptionsV3;
  /** Explicit V4 profile; V3 journals cannot be silently adopted. */
  readonly attestedSinkV4?: AttestedEffectBrokerOptionsV4;
  /** Explicit V5 profile. An exact operator bridge and signed sink fence are required. */
  readonly attestedSinkBudgetV1?: AttestedSinkBudgetBrokerOptionsV1;
  /** Fault-injection/observability hook; runs before a proposed journal replacement. */
  readonly beforePersist?: (event: EffectEventV1) => void;
  /** Immutable ticket slots prevent ABA lock reuse. Exhaustion fails closed;
   * compaction requires a separately coordinated quiescent maintenance epoch. */
  readonly maxLockTickets?: number;
  readonly lockFault?: (point: 'before-ticket-publish' | 'after-ticket-publish' | 'before-ticket-release' | 'after-ticket-release' | 'before-dead-ticket-release' | 'after-dead-ticket-release') => void;
}

export function effectPayloadDigest(payload: TaggedValueV1): Digest {
  validateTaggedValue(payload); return domainDigest('aether.effect-payload/1', payload);
}
export function validateEffectRequest(value: unknown, limits: Partial<EncodingLimits> = {}): asserts value is EffectRequestV1 {
  encodeCanonical(value, limits);
  const r = exactObject(value, ['format', 'executionId', 'effectId', 'branchId', 'executionManifest', 'capabilityGrantRef', 'policyEpoch', 'payloadDigest', 'payload', 'budgetReservationId', 'deadline']);
  if (r.format !== 'aether.effect/1') throw new TypeError('unsupported effect version');
  identifier(r.executionId); identifier(r.effectId); identifier(r.capabilityGrantRef);
  if (r.branchId !== null) identifier(r.branchId);
  if (r.budgetReservationId !== null) identifier(r.budgetReservationId);
  validateDigest(r.executionManifest, 'aether.execution/1'); validateDigest(r.payloadDigest, 'aether.effect-payload/1');
  const bound = encodingLimits(limits); decimal(r.policyEpoch, bound); decimal(r.deadline, bound); validateTaggedValue(r.payload, limits);
  if (domainDigest('aether.effect-payload/1', r.payload, limits) !== r.payloadDigest) throw new TypeError('effect payload digest mismatch');
}
export function effectRequestDigest(request: EffectRequestV1, limits: Partial<EncodingLimits> = {}): Digest {
  validateEffectRequest(request, limits); return domainDigest('aether.effect/1', request, limits);
}
export function effectAdapterDigest(adapter: EffectAdapter): Digest {
  identifier(adapter.id);
  const d = exactObject(adapter.semantics, ['readOnly', 'atomicIdempotency', 'transactional', 'reconciliation']);
  if (Object.values(d).some(v => typeof v !== 'boolean')) throw new TypeError('invalid adapter semantics');
  if (adapter.semantics.transactional ? !adapter.prepare || !adapter.commit || !adapter.abort : !adapter.execute) throw new TypeError('incomplete effect adapter');
  if (adapter.semantics.reconciliation !== (typeof adapter.reconcile === 'function')) throw new TypeError('inconsistent reconciliation declaration');
  return domainDigest('aether.effect-adapter/1', { id: adapter.id, semantics: adapter.semantics });
}
function outcomeDigest(event: Pick<EffectEventV1, 'requestDigest' | 'adapterId' | 'adapterSemanticsDigest' | 'observedAt'>, value: TaggedValueV1, limits: Partial<EncodingLimits>): Digest {
  return domainDigest('aether.effect-receipt/1', { requestDigest: event.requestDigest, adapterId: event.adapterId, adapterSemanticsDigest: event.adapterSemanticsDigest, observedAt: event.observedAt, value }, limits);
}
function immutable<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) immutable(child);
    Object.freeze(value);
  }
  return value;
}
function copy<T>(value: T, limits: Partial<EncodingLimits>): T { return decodeCanonical(encodeCanonical(value, limits), limits) as T; }

/**
 * Bounded, synchronous reference broker. One journal writer holds the oldest
 * unreleased immutable ticket through each adapter call. Ticket bytes are fully
 * durable before atomic publication; sequence slots are never reused. Recovery
 * releases only an exact dead owner's ticket, without a recovery mutex that can
 * itself be orphaned. Elapsed time never authorizes sinks or a retry.
 */
export class DurableEffectBroker {
  private readonly options: EffectBrokerOptions;
  private readonly file: string;
  private readonly journalLock: JournalLock;
  private readonly limits: EncodingLimits;
  private readonly mode: ExecutionMode;
  private cursor = 0;
  private readonly trace: readonly EffectEventV1[];
  private readonly buffered: EffectRequestV1[] = [];
  private readonly bufferedHistory = new Map<string, Digest>();
  readonly #witness: AnyEffectJournalWitness | null;
  readonly #attestedSink: Readonly<AttestedEffectBrokerOptionsV3> | null;
  readonly #sinkStateWitness: SinkStateWitnessV1 | null;
  readonly #budgetBridge: ResourceBudgetBridge | null;
  readonly #budgetBridgeProfileDigest: Digest | null;
  #budgetAuthorityPinned = false;
  #trustedClock: { anchor: TrustedClockAnchor; windows: readonly { issuedAt: number; expiresAt: number }[] } | null = null;
  get executionMode(): ExecutionMode { return this.mode; }
  /** Host-owned independent deadline source for a versioned isolated profile.
   * The reloadable adapter factory cannot replace it after pinning. */
  pinTrustedClock(anchor: TrustedClockAnchor, windows: readonly { issuedAt: number; expiresAt: number }[]): void {
    assertTrustedClockAnchor(anchor);
    if (anchor.clockDomain !== this.options.clockDomain || this.#trustedClock && this.#trustedClock.anchor.digest !== anchor.digest ||
        !Array.isArray(windows) || !windows.length)
      throw new TypeError('broker trusted clock authority mismatch');
    const checked = windows.map(window => {
      assertGrantLifetime(anchor, window.issuedAt, window.expiresAt);
      return Object.freeze({ issuedAt: window.issuedAt, expiresAt: window.expiresAt });
    });
    this.#trustedClock = { anchor, windows: Object.freeze(checked) };
  }
  constructor(options: EffectBrokerOptions) {
    identifier(options.clockDomain);
    this.options = options; this.limits = encodingLimits(options.limits); this.mode = options.mode ?? 'live';
    if (options.attestedSinkBudgetV1) {
      exactObject(options.attestedSinkBudgetV1, ['format', 'bridge', 'bridgeProfileDigest']);
      if (!options.attestedSinkV4 || options.attestedSink || options.budgets || this.mode !== 'live'
        || options.attestedSinkBudgetV1.format !== 'aether.attested-sink-budget-broker/1')
        throw new TypeError('budgeted sink requires its exclusive live V4 authority');
      ResourceBudgetBridge.assertInstance(options.attestedSinkBudgetV1.bridge);
      ResourceBudgetBridge.prototype.assertWitnessed.call(options.attestedSinkBudgetV1.bridge);
      validateDigest(options.attestedSinkBudgetV1.bridgeProfileDigest, 'aether.resource-budget-bridge/1');
      if (options.attestedSinkBudgetV1.bridge.profileDigest !== options.attestedSinkBudgetV1.bridgeProfileDigest)
        throw new TypeError('operator budget bridge profile mismatch');
      this.#budgetBridge = options.attestedSinkBudgetV1.bridge;
      this.#budgetBridgeProfileDigest = options.attestedSinkBudgetV1.bridgeProfileDigest;
    } else { this.#budgetBridge = null; this.#budgetBridgeProfileDigest = null; }
    this.#witness = options.witness ?? null;
    if (options.attestedSink && options.attestedSinkV4)
      throw new TypeError('select one attested sink broker profile');
    const selectedSink = options.attestedSinkV4 ?? options.attestedSink;
    if (selectedSink) {
      if (!this.#witness) throw new TypeError('V3 attested broker requires independent effect witness');
      validateSinkPublicAnchor(selectedSink.anchor);
      identifier(selectedSink.deploymentId);
      validateDigest(selectedSink.approvedAdapterArtifactDigest);
      if (!/^aether\.effect-adapter-artifact\/[1-9][0-9]*:b3:/.test(selectedSink.approvedAdapterArtifactDigest))
        throw new TypeError('V3 approved adapter artifact digest required');
      this.#attestedSink = immutable(copy({ anchor: selectedSink.anchor, deploymentId: selectedSink.deploymentId,
        approvedAdapterArtifactDigest: selectedSink.approvedAdapterArtifactDigest }, this.limits));
    } else this.#attestedSink = null;
    if (options.attestedSinkV4) {
      const sinkWitness = options.attestedSinkV4.sinkStateWitness;
      assertSinkStateWitness(sinkWitness);
      if (sinkWitness.repositoryId !== selectedSink!.anchor.repositoryId
        || sinkWitness.sinkAuthorityId !== selectedSink!.anchor.sinkAuthorityId
        || sinkWitness.sinkId !== selectedSink!.anchor.sinkId
        || sinkWitness.sinkAnchorDigest !== domainDigest('aether.sink-anchor/1', selectedSink!.anchor)
        || sinkWitness.adapterArtifactDigest !== selectedSink!.approvedAdapterArtifactDigest)
        throw new TypeError('sink state witness differs from broker authority');
      readSinkStateHead(sinkWitness);
      this.#sinkStateWitness = sinkWitness;
    } else this.#sinkStateWitness = null;
    if (!['live', 'speculative', 'shadow', 'replay'].includes(this.mode)) throw new TypeError('unknown execution mode');
    if (this.#witness) {
      assertEffectJournalWitness(this.#witness);
      if (this.#witness.clockDomain !== options.clockDomain) throw new TypeError('effect witness clock domain mismatch');
      if (this.#attestedSink && (this.#witness.format !== 'aether.effect-journal-witness/2'
        || this.#witness.repositoryId !== this.#attestedSink.anchor.repositoryId
        || this.#witness.catalogDeploymentId !== this.#attestedSink.deploymentId))
        throw new TypeError('V3 requires a namespaced witness bound to the sink deployment');
      if (existsSync(join(options.directory, 'effects.json'))) throw new Error('legacy effect journal requires explicit offline migration');
      if (this.#attestedSink && existsSync(join(options.directory, 'effects-v2.json')))
        throw new Error('V2 effect journal requires explicit offline migration');
      if (this.#sinkStateWitness && existsSync(join(options.directory, 'effects-v3.json')))
        throw new Error('V3 effect journal requires explicit offline migration');
      if (this.#budgetBridge && existsSync(join(options.directory, 'effects-v4.json')))
        throw new Error('V4 effect journal requires explicit offline migration');
      if (!this.#budgetBridge && existsSync(join(options.directory, 'effects-v5.json')))
        throw new Error('V5 budgeted effect journal requires its original authority');
      if (!this.#attestedSink && existsSync(join(options.directory, 'effects-v3.json')))
        throw new Error('V3 attested effect journal requires its original authority');
      if (!this.#sinkStateWitness && existsSync(join(options.directory, 'effects-v4.json')))
        throw new Error('V4 attested effect journal requires its original authority');
    } else if (existsSync(join(options.directory, 'effects-v2.json'))) throw new Error('witnessed effect journal requires its original authority');
    if (!this.#witness && existsSync(join(options.directory, 'effects-v3.json')))
      throw new Error('V3 attested effect journal requires its original authority');
    if (!this.#witness && existsSync(join(options.directory, 'effects-v4.json')))
      throw new Error('V4 attested effect journal requires its original authority');
    this.file = join(options.directory, this.#budgetBridge ? 'effects-v5.json' : this.#sinkStateWitness ? 'effects-v4.json'
      : this.#attestedSink ? 'effects-v3.json' : this.#witness ? 'effects-v2.json' : 'effects.json');
    mkdirSync(options.directory, { recursive: true });
    if (existsSync(join(options.directory, 'effects.lock')) || existsSync(join(options.directory, 'effects.lock.recovery'))) throw new Error('legacy effect lock layout requires explicit offline migration');
    this.journalLock = new JournalLock({ directory: join(options.directory, 'effect-lock-tickets'), domain: 'aether.effect-lock', limits: this.limits, maxTickets: options.maxLockTickets, fault: options.lockFault, busyError: 'effect_broker_busy: explicit dead-owner recovery required after a crash' });
    this.trace = immutable(copy(options.replayEvents ?? [], this.limits));
    this.validateOrderedEvents(this.trace);
  }
  private time(): string {
    const time = this.options.clock?.() ?? BigInt(Date.now());
    if (typeof time !== 'bigint' || time < 0n) throw new TypeError('invalid effect clock');
    return time.toString();
  }
  private locked<T>(run: () => T): T { return this.journalLock.run(run); }
  /** Called nonvirtually by a signed host before invoking or inspecting a
   * broker. The exact operator object is required, not a matching label. */
  assertWitness(expected: AnyEffectJournalWitness): void {
    assertEffectJournalWitness(expected);
    if (this.#witness !== expected) throw new TypeError('effect broker witness differs from operator authority');
    if (Object.getPrototypeOf(this) !== DurableEffectBroker.prototype
      || ['read', 'persist', 'locked', 'find', 'step', 'authorize', 'dispatch', 'reconcile', 'inspectRecorded',
        'validateEvent', 'validateOrderedEvents', 'replay', 'events', 'recordedRequest']
        .some(name => Object.hasOwn(this, name)))
      throw new TypeError('witnessed effect broker has a replaceable method boundary');
    Object.preventExtensions(this);
    readWitnessHead(expected);
  }
  /** A signed host/deployment pins both the exact sink subject and the live
   * operator-selected decision witness before allowing an external adapter. */
  assertAttestedSinkAuthority(expected: AttestedEffectBrokerOptionsV3,
    sinkStateWitness: SinkStateWitnessV1): void {
    assertSinkStateWitness(sinkStateWitness);
    if (Object.getPrototypeOf(this) !== DurableEffectBroker.prototype
      || this.#sinkStateWitness !== sinkStateWitness || !this.#attestedSink
      || Buffer.compare(encodeCanonical(this.#attestedSink, this.limits),
        encodeCanonical(expected, this.limits)) !== 0)
      throw new TypeError('broker sink authority differs from operator selection');
    readSinkStateHead(sinkStateWitness);
  }
  /** The caller supplies the operator-selected instance, never a factory hook. */
  assertBudgetAuthority(expectedBridge: ResourceBudgetBridge, expectedProfileDigest: Digest): void {
    ResourceBudgetBridge.assertInstance(expectedBridge);
    ResourceBudgetBridge.prototype.assertWitnessed.call(expectedBridge);
    if (!this.#budgetBridge || this.#budgetBridge !== expectedBridge
      || this.#budgetBridgeProfileDigest !== expectedProfileDigest
      || expectedBridge.profileDigest !== expectedProfileDigest || !this.#sinkStateWitness || !this.#witness)
      throw new TypeError('broker budget authority differs from operator selection');
    readWitnessHead(this.#witness);
    readSinkStateHead(this.#sinkStateWitness);
    this.#budgetAuthorityPinned = true;
  }
  recoverDeadWriter(): void { this.journalLock.recoverDeadWriter(); }
  private validateEvent(value: unknown, sinkState?: SinkStateJournalV2): asserts value is EffectEventV1 {
    const v3 = this.#attestedSink !== null;
    const budgeted = this.#budgetBridge !== null;
    const e = exactObject(value, ['format', 'sequence', 'request', 'requestDigest', 'adapterId', 'adapterSemanticsDigest', 'state', 'transitions', 'dispatchStarted', 'prepared', 'observedAt', 'recordedAt', 'outcome', ...(v3 ? ['signedSinkReceipt'] : [])]);
    if (e.format !== (budgeted ? 'aether.effect-event/4' : v3 ? 'aether.effect-event/3' : 'aether.effect-event/1')) throw new TypeError('unsupported effect event version');
    validateEffectRequest(e.request, this.limits); decimal(e.sequence, this.limits); decimal(e.observedAt, this.limits); decimal(e.recordedAt, this.limits);
    if (budgeted && (e.request as EffectRequestV1).budgetReservationId === null)
      throw new TypeError('budgeted sink event requires exact reservation ID');
    if (effectRequestDigest(e.request, this.limits) !== e.requestDigest) throw new TypeError('corrupt effect request binding');
    identifier(e.adapterId); validateDigest(e.adapterSemanticsDigest, 'aether.effect-adapter/1');
    const states = ['requested', 'reserved', 'prepared', 'committed', 'rejected', 'aborted', 'indeterminate'];
    if (typeof e.state !== 'string' || !states.includes(e.state) || typeof e.dispatchStarted !== 'boolean' || !Array.isArray(e.transitions) || e.transitions.length === 0) throw new TypeError('invalid effect event');
    let previousState: string | null = null, previousDispatch = false;
    const allowed: Record<string, readonly string[]> = {
      requested: budgeted ? ['reserved', 'rejected', 'aborted', 'indeterminate'] : ['reserved', 'rejected', 'aborted'],
      reserved: budgeted ? ['prepared', 'aborted', 'committed', 'indeterminate'] : ['prepared', 'aborted'],
      prepared: ['prepared', 'committed', 'indeterminate', 'rejected', 'aborted'],
      indeterminate: ['committed', 'aborted', 'indeterminate'], committed: [], rejected: [], aborted: [],
    };
    for (const transition of e.transitions) {
      const t = exactObject(transition, ['state', 'time', 'dispatchStarted']);
      if (typeof t.state !== 'string' || !states.includes(t.state) || typeof t.dispatchStarted !== 'boolean') throw new TypeError('invalid effect transition');
      decimal(t.time, this.limits);
      if (previousState === null) {
        if (t.state !== 'requested' || t.dispatchStarted) throw new TypeError('effect history must begin before dispatch');
      } else {
        if (!allowed[previousState].includes(t.state)) throw new TypeError('illegal effect state transition');
        if (t.state === 'prepared' && (previousState === 'reserved' ? t.dispatchStarted : previousDispatch || !t.dispatchStarted)) throw new TypeError('invalid durable dispatch transition');
        if (!previousDispatch && t.dispatchStarted && !(previousState === 'prepared' && t.state === 'prepared')) throw new TypeError('dispatch marker missing prepared predecessor');
        if (previousDispatch && !t.dispatchStarted && !(previousState === 'prepared' && (t.state === 'aborted' || t.state === 'rejected'))) throw new TypeError('dispatch marker cannot be forgotten');
        if (['committed', 'indeterminate'].includes(t.state) && !t.dispatchStarted
          && !(budgeted && (previousState === 'requested' || previousState === 'reserved'
            || previousState === 'prepared' || previousState === 'indeterminate')))
          throw new TypeError('terminal effect lacks dispatch marker');
      }
      previousState = t.state; previousDispatch = t.dispatchStarted;
    }
    if (previousState !== e.state || previousDispatch !== e.dispatchStarted) throw new TypeError('effect transition/dispatch mismatch');
    if (e.prepared !== null) validateTaggedValue(e.prepared, this.limits);
    if (e.outcome !== null) {
      if (!e.outcome || typeof e.outcome !== 'object') throw new TypeError('invalid effect outcome');
      const state = (e.outcome as EffectOutcome).state;
      if (state !== e.state) throw new TypeError('effect outcome/state mismatch');
      const out = exactObject(e.outcome, state === 'committed' ? ['state', 'receiptDigest', 'value'] : state === 'indeterminate' ? ['state', 'recoveryId'] : ['state', 'code']);
      if (state === 'committed') {
        validateTaggedValue(out.value, this.limits);
        if (outcomeDigest(value as EffectEventV1, out.value, this.limits) !== out.receiptDigest) throw new TypeError('corrupt effect receipt');
      } else if (state === 'indeterminate') { identifier(out.recoveryId); if (out.recoveryId !== e.requestDigest) throw new TypeError('corrupt effect recovery binding'); }
      else if (state === 'rejected' || state === 'aborted') {
        identifier(out.code);
        if (state === 'rejected' && (e.dispatchStarted
          || budgeted && (e.transitions as EffectEventV1['transitions']).some(t => t.state === 'reserved')
          || !['deadline_exceeded', 'trusted_clock_denied', 'branch_not_admitted', 'authorization_denied', 'budget_adapter_missing', 'budget_exhausted', 'adapter_preflight_rejected'].includes(out.code)))
          throw new TypeError('rejection cannot follow an uncertain dispatch');
        if (state === 'aborted' && (e.dispatchStarted || budgeted && (e.transitions as EffectEventV1['transitions']).some(t => t.state === 'reserved' || t.state === 'indeterminate')
          ? out.code !== 'sink_confirmed_not_committed' : !['cancelled', 'recovered_before_dispatch'].includes(out.code)))
          throw new TypeError('abort lacks matching noncommit evidence');
      }
      else throw new TypeError('unsupported effect outcome');
    } else if (['committed', 'rejected', 'aborted', 'indeterminate'].includes(e.state)) throw new TypeError('missing effect outcome');
    if (v3) {
      const context = this.#attestedSink!;
      const disposition = e.state === 'committed' ? 'committed' : e.state === 'aborted'
        && (e.dispatchStarted || budgeted && (e.transitions as EffectEventV1['transitions']).some(t => t.state === 'reserved' || t.state === 'indeterminate'))
        ? 'not_committed' : null;
      if (disposition === null) {
        if (e.signedSinkReceipt !== null) throw new TypeError('V3 nonterminal or pre-dispatch event carries a sink decision');
      } else {
        if (!verifySinkReceipt(e.signedSinkReceipt, context.anchor, {
          repositoryId: context.anchor.repositoryId, deploymentId: context.deploymentId,
          request: e.request as EffectRequestV1, sinkAuthorityId: context.anchor.sinkAuthorityId,
          sinkId: context.anchor.sinkId, adapterArtifactDigest: context.approvedAdapterArtifactDigest,
          disposition, value: disposition === 'committed' ? (e.outcome as EffectOutcome & { value: TaggedValueV1 }).value : null,
        })) throw new TypeError('V3 signed sink receipt invalid or missing');
        if (this.#sinkStateWitness) this.#assertSinkWitnessDecision(e.request as EffectRequestV1,
          e.signedSinkReceipt as SignedSinkReceiptV1,
          disposition === 'committed' ? (e.outcome as EffectOutcome & { value: TaggedValueV1 }).value : null,
          sinkState);
      }
    }
  }
  private validateOrderedEvents(events: readonly EffectEventV1[]): void {
    if (!Array.isArray(events)) throw new TypeError('invalid effect trace');
    const sinkState = this.#sinkStateWitness && events.some(event => event.signedSinkReceipt != null)
      ? this.#readSinkState() : undefined;
    const identities = new Set<string>();
    for (let index = 0; index < events.length; index++) {
      const record = events[index]; this.validateEvent(record, sinkState);
      const key = this.key(record.request);
      if (record.sequence !== String(index) || identities.has(key)) throw new TypeError('corrupt effect ordering');
      identities.add(key);
    }
  }
  private read(): EffectJournal {
    if (this.#witness) {
      const witness = this.#witness, head = readWitnessHead(witness);
      const context = this.#attestedSink;
      const format = this.#budgetBridge ? 'aether.effect-journal/5' : this.#sinkStateWitness ? 'aether.effect-journal/4'
        : context ? 'aether.effect-journal/3' : 'aether.effect-journal/2';
      if (head.journal === null) {
        if (existsSync(this.file)) throw new Error('local effect journal is ahead of witness genesis');
        if (context && this.#sinkStateWitness && this.#budgetBridgeProfileDigest)
          return { format: 'aether.effect-journal/5', clockDomain: this.options.clockDomain,
            witnessDigest: witness.digest, revision: '0', deploymentId: context.deploymentId,
            approvedAdapterArtifactDigest: context.approvedAdapterArtifactDigest, sinkAnchor: context.anchor,
            sinkStateWitnessDigest: this.#sinkStateWitness.digest,
            budgetBridgeProfileDigest: this.#budgetBridgeProfileDigest, records: [] };
        if (context && this.#sinkStateWitness) return { format: 'aether.effect-journal/4',
          clockDomain: this.options.clockDomain, witnessDigest: witness.digest, revision: '0',
          deploymentId: context.deploymentId,
          approvedAdapterArtifactDigest: context.approvedAdapterArtifactDigest, sinkAnchor: context.anchor,
          sinkStateWitnessDigest: this.#sinkStateWitness.digest, records: [] };
        if (context) return { format: 'aether.effect-journal/3', clockDomain: this.options.clockDomain,
          witnessDigest: witness.digest, revision: '0', deploymentId: context.deploymentId,
          approvedAdapterArtifactDigest: context.approvedAdapterArtifactDigest, sinkAnchor: context.anchor, records: [] };
        return { format: 'aether.effect-journal/2', clockDomain: this.options.clockDomain,
          witnessDigest: witness.digest, revision: '0', records: [] };
      }
      if (Buffer.byteLength(head.journal) > this.limits.maxFrameBytes) throw new RangeError('witness journal frame limit exceeded');
      const keys = ['format', 'clockDomain', 'witnessDigest', 'revision', 'records',
        ...(context ? ['deploymentId', 'approvedAdapterArtifactDigest', 'sinkAnchor'] : []),
        ...(this.#sinkStateWitness ? ['sinkStateWitnessDigest'] : []),
        ...(this.#budgetBridge ? ['budgetBridgeProfileDigest'] : [])];
      const j = exactObject(decodeCanonical(Buffer.from(head.journal), this.limits), keys);
      if (j.format !== format || j.clockDomain !== this.options.clockDomain || j.witnessDigest !== witness.digest
        || j.revision !== head.revision || !Array.isArray(j.records)
        || context && (j.deploymentId !== context.deploymentId
          || j.approvedAdapterArtifactDigest !== context.approvedAdapterArtifactDigest
          || Buffer.from(encodeCanonical(j.sinkAnchor, this.limits)).toString('utf8') !== Buffer.from(encodeCanonical(context.anchor, this.limits)).toString('utf8'))
        || this.#sinkStateWitness && j.sinkStateWitnessDigest !== this.#sinkStateWitness.digest
        || this.#budgetBridge && j.budgetBridgeProfileDigest !== this.#budgetBridgeProfileDigest
        || Buffer.from(encodeCanonical(j, this.limits)).toString('utf8') !== head.journal)
        throw new TypeError('witnessed effect journal identity/canonical mismatch');
      this.validateOrderedEvents(j.records);
      if (existsSync(this.file)) {
        if (statSync(this.file).size > this.limits.maxFrameBytes) throw new RangeError('local journal frame limit exceeded');
        const local = readFileSync(this.file, 'utf8');
        if (local !== head.journal) {
          let older = false;
          try {
            const prior = exactObject(decodeCanonical(Buffer.from(local), this.limits), keys);
            decimal(prior.revision, this.limits);
            older = prior.format === format && prior.clockDomain === this.options.clockDomain
              && prior.witnessDigest === witness.digest && (!context || prior.deploymentId === context.deploymentId
                && prior.approvedAdapterArtifactDigest === context.approvedAdapterArtifactDigest
                && Buffer.from(encodeCanonical(prior.sinkAnchor, this.limits)).toString('utf8') === Buffer.from(encodeCanonical(context.anchor, this.limits)).toString('utf8'))
              && (!this.#sinkStateWitness || prior.sinkStateWitnessDigest === this.#sinkStateWitness.digest)
              && (!this.#budgetBridge || prior.budgetBridgeProfileDigest === this.#budgetBridgeProfileDigest)
              && BigInt(prior.revision) < BigInt(head.revision);
          } catch { /* A corrupt or same-revision file is quarantined. */ }
          if (!older) throw new Error('local effect journal diverges from witness');
          atomicWrite(this.file, head.journal);
        }
      } else atomicWrite(this.file, head.journal);
      const fd = openSync(this.options.directory, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); }
      return j as unknown as EffectJournalV2 | EffectJournalV3 | EffectJournalV4 | EffectJournalV5;
    }
    if (!existsSync(this.file)) return { format: 'aether.effect-journal/1', clockDomain: this.options.clockDomain, records: [] };
    if (statSync(this.file).size > this.limits.maxFrameBytes) throw new RangeError('journal frame limit exceeded');
    const j = exactObject(decodeCanonical(readFileSync(this.file), this.limits), ['format', 'clockDomain', 'records']);
    if (j.format !== 'aether.effect-journal/1' || j.clockDomain !== this.options.clockDomain || !Array.isArray(j.records)) throw new TypeError('unsupported journal or clock domain');
    this.validateOrderedEvents(j.records);
    return j as unknown as EffectJournalV1;
  }
  private persist(journal: EffectJournal, event: EffectEventV1): void {
    this.validateEvent(event);
    const records = [...journal.records]; records[Number(event.sequence)] = event;
    const next = journal.format !== 'aether.effect-journal/1'
      ? { ...journal, revision: String(BigInt(journal.revision) + 1n), records }
      : { ...journal, records };
    const encoded = encodeCanonical(next, this.limits);
    this.options.beforePersist?.(immutable(copy(event, this.limits)));
    if (journal.format !== 'aether.effect-journal/1') {
      if (!this.#witness) throw new Error('effect witness missing at publication');
      advanceWitnessHead(this.#witness, journal.revision, Buffer.from(encoded).toString('utf8'));
    }
    atomicWrite(this.file, Buffer.from(encoded).toString('utf8'));
    const fd = openSync(this.options.directory, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); }
    journal.records = records;
    if (journal.format !== 'aether.effect-journal/1') journal.revision = (next as EffectJournalV2 | EffectJournalV3 | EffectJournalV4 | EffectJournalV5).revision;
  }
  private key(request: EffectRequestV1): string { return JSON.stringify([request.executionId, request.effectId]); }
  private find(journal: EffectJournal, request: EffectRequestV1): EffectEventV1 | undefined {
    const event = journal.records.find(e => this.key(e.request) === this.key(request));
    if (event && event.requestDigest !== effectRequestDigest(request, this.limits)) throw new Error('effect_identity_conflict');
    return event;
  }
  private step(journal: EffectJournal, event: EffectEventV1, state: EffectEventV1['state'], updates: Partial<EffectEventV1> = {}): EffectEventV1 {
    const next: EffectEventV1 = { ...event, ...updates, state, recordedAt: this.time(), transitions: [...event.transitions, { state, time: this.time(), dispatchStarted: updates.dispatchStarted ?? event.dispatchStarted }] };
    this.persist(journal, next); return next;
  }
  private uncertain(event: EffectEventV1): EffectOutcome { return { state: 'indeterminate', recoveryId: event.requestDigest }; }
  private terminalBudgetReleaseNeeded(request: EffectRequestV1, event: EffectEventV1): boolean {
    return request.budgetReservationId !== null && (this.options.budgets !== undefined || this.#budgetBridge !== null)
      && (event.outcome?.state === 'rejected' || event.outcome?.state === 'aborted')
      && (this.#budgetBridge && event.outcome.state === 'aborted' && event.signedSinkReceipt != null
        || event.transitions.some(transition => transition.state === 'reserved')
        || event.outcome.state === 'aborted' && event.outcome.code === 'recovered_before_dispatch');
  }
  private budgetReserve(request: EffectRequestV1): boolean {
    if (this.#budgetBridge) return ResourceBudgetBridge.prototype.reserve.call(this.#budgetBridge, request);
    if (!this.options.budgets) throw new TypeError('budget_adapter_missing');
    return this.options.budgets.reserve(request);
  }
  private budgetConsume(request: EffectRequestV1, value: TaggedValueV1): void {
    if (this.#budgetBridge) ResourceBudgetBridge.prototype.consume.call(this.#budgetBridge, request, value);
    else this.options.budgets!.consume(request, value);
  }
  private budgetRelease(request: EffectRequestV1): void {
    if (this.#budgetBridge) ResourceBudgetBridge.prototype.release.call(this.#budgetBridge, request);
    else this.options.budgets!.release(request);
  }
  private assertCachedBudgetSettlement(event: EffectEventV1): void {
    if (!this.#budgetBridge || !event.outcome) return;
    ResourceBudgetBridge.prototype.assertWitnessed.call(this.#budgetBridge);
    const disposition = event.outcome.state === 'committed' ? 'committed'
      : event.outcome.state === 'aborted' && event.signedSinkReceipt != null ? 'not_committed' : null;
    if (!disposition) return;
    const requireReservation = disposition === 'committed'
      || event.transitions.some(transition => transition.state === 'reserved');
    ResourceBudgetBridge.prototype.assertSettled.call(this.#budgetBridge,
      event.request, disposition, requireReservation);
  }
  /** A budgeted terminal decision must come from the branded adapter's
   * read-only status path and the independently witnessed signed sink row. */
  private budgetedSinkStatus(request: EffectRequestV1, adapter: EffectAdapter, prepared: TaggedValueV1 | null):
    | { state: 'committed'; value: TaggedValueV1; receipt: SignedSinkReceiptV1 }
    | { state: 'not_committed'; receipt: SignedSinkReceiptV1 }
    | { state: 'unknown' } {
    if (!this.#budgetBridge) throw new TypeError('budgeted sink profile absent');
    this.#assertAttestedAdapter(adapter);
    let resolution: ReturnType<NonNullable<EffectAdapter['reconcile']>>;
    try { resolution = adapter.reconcile!(request, prepared); }
    catch { return { state: 'unknown' }; }
    if (resolution.state === 'unknown') return { state: 'unknown' };
    try {
      const receipt = this.#attestedReceipt(request, adapter, resolution.state,
        resolution.state === 'committed' ? resolution.value : null);
      return resolution.state === 'committed'
        ? { state: 'committed', value: resolution.value, receipt }
        : { state: 'not_committed', receipt };
    } catch { return { state: 'unknown' }; }
  }
  private budgetedResolve(journal: EffectJournal, event: EffectEventV1, adapter: EffectAdapter): EffectOutcome {
    const request = event.request;
    const status = this.budgetedSinkStatus(request, adapter, event.prepared);
    if (status.state === 'unknown') {
      const outcome = this.uncertain(event);
      if (event.state !== 'indeterminate') {
        try { this.step(journal, event, 'indeterminate', { outcome }); }
        catch { /* The prior durable event still requires reconciliation. */ }
      }
      return outcome;
    }
    // A reserve call can have reached the bridge before its broker event was
    // published. Keep that uncertainty durable before settling either result.
    if (event.state === 'requested') {
      try { event = this.step(journal, event, 'indeterminate', { outcome: this.uncertain(event) }); }
      catch { return this.uncertain(event); }
    }
    try {
      if (status.state === 'committed') {
        this.budgetConsume(request, status.value);
        const outcome: EffectOutcome = { state: 'committed',
          receiptDigest: outcomeDigest(event, status.value, this.limits), value: immutable(copy(status.value, this.limits)) };
        this.step(journal, event, 'committed', { outcome, signedSinkReceipt: status.receipt });
        return outcome;
      }
      this.budgetRelease(request);
      const outcome: EffectOutcome = { state: 'aborted', code: 'sink_confirmed_not_committed' };
      this.step(journal, event, 'aborted', { outcome, signedSinkReceipt: status.receipt });
      return outcome;
    } catch {
      // A bridge or witness failure must not convert a pending settlement into
      // a terminal broker claim. The signed status can be queried again.
      const outcome = this.uncertain(event);
      if (event.state !== 'indeterminate') {
        try { this.step(journal, event, 'indeterminate', { outcome }); } catch { /* Original event remains recoverable. */ }
      }
      return outcome;
    }
  }
  private authorize(request: EffectRequestV1, signal?: AbortSignal): string | null {
    if (signal?.aborted) return 'cancelled';
    const trustedRefusal = (): string | null => {
      if (!this.#trustedClock) return null;
      try {
        for (const window of this.#trustedClock.windows) assertGrantLifetime(this.#trustedClock.anchor, window.issuedAt, window.expiresAt);
        assertBeforeDeadline(this.#trustedClock.anchor, request.deadline, this.options.clockDomain);
        return null;
      } catch { return 'trusted_clock_denied'; }
    };
    const before = trustedRefusal(); if (before) return before;
    if (BigInt(this.time()) > BigInt(request.deadline)) return 'deadline_exceeded';
    if (request.branchId !== null && !this.options.authorizeBranch?.(request)) return 'branch_not_admitted';
    if (this.options.authorize(request) !== true) return 'authorization_denied';
    return trustedRefusal();
  }
  #assertAttestedAdapter(adapter: EffectAdapter): void {
    if (!this.#attestedSink) return;
    assertAttestedSinkAdapter(adapter, {
      repositoryId: this.#attestedSink.anchor.repositoryId,
      deploymentId: this.#attestedSink.deploymentId,
      approvedAdapterArtifactDigest: this.#attestedSink.approvedAdapterArtifactDigest,
      anchor: this.#attestedSink.anchor,
    });
  }
  #readSinkState(): SinkStateJournalV2 {
    const witness = this.#sinkStateWitness;
    if (!witness) throw new TypeError('sink state witness required');
    const head = readSinkStateHead(witness);
    if (head.journal === null) throw new Error('signed sink decision absent from operator witness');
    const state = decodeCanonical(Buffer.from(head.journal, 'utf8'), {
      maxObjects: 200_000, maxDepth: 24, maxIntegerDigits: 40 });
    validateSinkStateJournalV2(state, witness, head.revision);
    return state;
  }
  #assertSinkWitnessDecision(request: EffectRequestV1, receipt: SignedSinkReceiptV1,
    value: TaggedValueV1 | null, state?: SinkStateJournalV2): void {
    const witness = this.#sinkStateWitness;
    if (!witness) return;
    state ??= this.#readSinkState();
    const row = state.decisions.find(item => item.repositoryId === witness.repositoryId
      && item.request.executionId === request.executionId && item.request.effectId === request.effectId);
    if (!row || effectRequestDigest(row.request, this.limits) !== effectRequestDigest(request, this.limits)
      || Buffer.compare(encodeCanonical(row.receipt, this.limits), encodeCanonical(receipt, this.limits)) !== 0
      || Buffer.compare(encodeCanonical(row.value, this.limits), encodeCanonical(value, this.limits)) !== 0)
      throw new Error('signed sink decision differs from operator witness');
  }
  /** The wrapper's observation is only a source of exact proof bytes. The
   * broker verifies the sink signature and every operator-pinned field again. */
  #attestedReceipt(request: EffectRequestV1, adapter: EffectAdapter,
    disposition: 'committed' | 'not_committed', value: TaggedValueV1 | null): SignedSinkReceiptV1 {
    const context = this.#attestedSink;
    if (!context) throw new TypeError('V3 sink authority required');
    this.#assertAttestedAdapter(adapter);
    const receipt = verifiedSinkReceipt(adapter, request);
    if (!verifySinkReceipt(receipt, context.anchor, {
      repositoryId: context.anchor.repositoryId, deploymentId: context.deploymentId, request,
      sinkAuthorityId: context.anchor.sinkAuthorityId, sinkId: context.anchor.sinkId,
      adapterArtifactDigest: context.approvedAdapterArtifactDigest, disposition, value,
    })) throw new TypeError('V3 signed sink receipt invalid or missing');
    if (this.#sinkStateWitness) this.#assertSinkWitnessDecision(request, receipt!, value);
    return immutable(copy(receipt, this.limits));
  }
  /** Replay is isolated from current grants; exactly matches the recorded logical event sequence. */
  private replay(request: EffectRequestV1, adapter: EffectAdapter): EffectOutcome {
    this.#assertAttestedAdapter(adapter);
    const event = this.trace[this.cursor];
    if (event) this.validateEvent(event);
    if (!event || event.requestDigest !== effectRequestDigest(request, this.limits) || event.adapterId !== adapter.id || event.adapterSemanticsDigest !== effectAdapterDigest(adapter) || event.outcome === null || event.outcome.state === 'indeterminate') throw new Error('replay_mismatch');
    this.cursor++; return immutable(copy(event.outcome, this.limits));
  }
  /** Read one exact recorded outcome without dispatch, reconciliation, budget
   * mutation or current authorization. In V2 the complete journal is checked
   * against its witness before this can return a cached receipt. */
  inspectRecorded(input: EffectRequestV1, adapter: EffectAdapter): EffectOutcome | null {
    if (!this.#attestedSink && isAttestedSinkAdapter(adapter))
      throw new Error('attested sink adapter requires witnessed V3 broker');
    if (this.mode !== 'live') throw new Error('isolated_record_inspection_forbidden');
    validateEffectRequest(input, this.limits); const request = immutable(copy(input, this.limits));
    if (this.#budgetBridge && (!this.#budgetAuthorityPinned || request.budgetReservationId === null))
      throw new TypeError('budgeted sink inspection requires pinned non-null reservation authority');
    this.#assertAttestedAdapter(adapter);
    const semanticsDigest = effectAdapterDigest(adapter);
    return this.locked(() => {
      const journal = this.read(), event = this.find(journal, request);
      if (!event) return null;
      if (event.adapterId !== adapter.id || event.adapterSemanticsDigest !== semanticsDigest) throw new Error('effect_adapter_conflict');
      this.assertCachedBudgetSettlement(event);
      return event.outcome === null ? null : immutable(copy(event.outcome, this.limits));
    });
  }
  /** Recover the original immutable request by the broker's stable logical
   * operation identity. A caller must compare all expected payload/context
   * fields before using it for reconciliation. */
  recordedRequest(executionId: string, effectId: string): EffectRequestV1 | null {
    if (this.mode !== 'live') throw new Error('isolated_record_inspection_forbidden');
    identifier(executionId); identifier(effectId);
    return this.locked(() => {
      const event = this.read().records.find(record => record.request.executionId === executionId && record.request.effectId === effectId);
      return event ? immutable(copy(event.request, this.limits)) : null;
    });
  }
  /** Restore only an isolated immutable trace cursor. No live adapter, grant,
   * reservation or reconciliation callback is evaluated. Validate the complete
   * ordered prefix before publishing the new cursor, including backwards moves. */
  private validateReplayPrefix(prefix: readonly EffectReplayPrefixEntry[]): void {
    if (this.mode === 'live') throw new TypeError('live broker cannot restore a replay cursor');
    if (!Array.isArray(prefix) || prefix.length > this.trace.length || prefix.length > this.limits.maxObjects) throw new RangeError('replay prefix size mismatch');
    encodeCanonical(prefix, this.limits);
    const seen = new Set<string>();
    for (let index = 0; index < prefix.length; index++) {
      const entry = exactObject(prefix[index], ['requestDigest', 'outcomeDigest']);
      validateDigest(entry.requestDigest, 'aether.effect/1'); validateDigest(entry.outcomeDigest, 'aether.effect-replay-outcome/1');
      if (seen.has(entry.requestDigest)) throw new TypeError('duplicate replay prefix event'); seen.add(entry.requestDigest);
      const event = this.trace[index];
      if (event.requestDigest !== entry.requestDigest || event.outcome === null || event.outcome.state === 'indeterminate' || effectReplayOutcomeDigest(event.outcome) !== entry.outcomeDigest) throw new TypeError('replay prefix request/outcome mismatch');
    }
  }
  restoreReplayPrefix(prefix: readonly EffectReplayPrefixEntry[]): void { this.validateReplayPrefix(prefix); this.cursor = prefix.length; }
  /** Restores isolated branch drafts, never live-dispatch authority. Historical
   * ID/payload bindings remain reserved even when an earlier active buffer is
   * restored. Validation is complete before either cursor or buffer changes. */
  restoreIsolatedState(value: EffectIsolatedState): void {
    if (this.mode === 'live') throw new TypeError('live broker cannot restore isolated state');
    exactObject(value, ['prefix', 'bufferedIntents']); this.validateReplayPrefix(value.prefix);
    if (!Array.isArray(value.bufferedIntents) || value.bufferedIntents.length > this.limits.maxObjects || value.bufferedIntents.length && (this.mode === 'replay' || value.prefix.length !== this.trace.length)) throw new TypeError('invalid isolated buffer position or size');
    encodeCanonical(value, this.limits);
    const seen = new Set<string>(), additions = new Map<string, Digest>();
    let context: string | null = null;
    for (const request of value.bufferedIntents) {
      validateEffectRequest(request, this.limits); if (request.branchId === null) throw new TypeError('isolated buffer requires branch context');
      const scope = JSON.stringify([request.executionId, request.executionManifest, request.branchId]); if (context !== null && context !== scope) throw new TypeError('mixed isolated buffer context'); context = scope;
      const key = this.key(request), digest = effectRequestDigest(request, this.limits);
      if (seen.has(key)) throw new TypeError('duplicate isolated buffer identity'); seen.add(key);
      if (this.bufferedHistory.has(key) && this.bufferedHistory.get(key) !== digest) throw new TypeError('isolated buffer historical identity conflict'); additions.set(key, digest);
      if (this.trace.some(event => this.key(event.request) === key)) throw new TypeError('buffered intent duplicates a recorded event');
    }
    const requestedKnown = value.bufferedIntents.map(request => this.key(request)).filter(key => this.bufferedHistory.has(key));
    const historicalKnown = [...this.bufferedHistory.keys()].filter(key => seen.has(key));
    if (JSON.stringify(requestedKnown) !== JSON.stringify(historicalKnown)) throw new TypeError('reordered isolated intent history');
    if (context !== null && this.trace.length && this.trace.some(event => JSON.stringify([event.request.executionId, event.request.executionManifest, event.request.branchId]) !== context)) throw new TypeError('isolated buffer/trace context mismatch');
    if (this.bufferedHistory.size + [...additions.keys()].filter(key => !this.bufferedHistory.has(key)).length > this.limits.maxObjects) throw new RangeError('isolated intent history limit');
    const restored = immutable(copy(value.bufferedIntents, this.limits));
    this.cursor = value.prefix.length; this.buffered.splice(0, this.buffered.length, ...restored); for (const [key, digest] of additions) this.bufferedHistory.set(key, digest);
  }
  get recordedEventCount(): number { return this.trace.length; }
  get clockDomain(): string { return this.options.clockDomain; }
  get replayRemaining(): number { return this.trace.length - this.cursor; }
  assertReplayComplete(): void { if (this.replayRemaining !== 0) throw new Error('replay_mismatch: unconsumed events'); }
  intents(): readonly EffectRequestV1[] { return immutable(copy(this.buffered, this.limits)); }
  events(): readonly EffectEventV1[] { return immutable(copy(this.read().records, this.limits)); }

  dispatch(input: EffectRequestV1, adapter: EffectAdapter, options: { signal?: AbortSignal } = {}): EffectOutcome {
    if (!this.#attestedSink && isAttestedSinkAdapter(adapter))
      throw new Error('attested sink adapter requires witnessed V3 broker');
    validateEffectRequest(input, this.limits);
    const request = immutable(copy(input, this.limits));
    if (this.#budgetBridge && (!this.#budgetAuthorityPinned || request.budgetReservationId === null))
      throw new TypeError('budgeted sink dispatch requires pinned non-null reservation authority');
    this.#assertAttestedAdapter(adapter);
    if (this.mode === 'replay') return this.replay(request, adapter);
    if (this.mode !== 'live') {
      // Inputs are consumed from an isolated recorded snapshot; no adapter is invoked.
      if (this.trace[this.cursor]) return this.replay(request, adapter);
      if (request.branchId === null) return { state: 'rejected', code: 'isolated_branch_required' };
      const key = this.key(request), digest = effectRequestDigest(request, this.limits);
      if (this.bufferedHistory.has(key) && this.bufferedHistory.get(key) !== digest) throw new Error('effect_identity_conflict');
      if (!this.bufferedHistory.has(key) && this.bufferedHistory.size >= this.limits.maxObjects) throw new RangeError('isolated intent history limit');
      if (!this.buffered.some(r => this.key(r) === key)) encodeCanonical([...this.buffered, request], this.limits);
      this.bufferedHistory.set(key, digest);
      if (!this.buffered.some(r => this.key(r) === key)) this.buffered.push(request);
      return { state: 'rejected', code: 'isolated_intent_buffered' };
    }
    const semanticsDigest = effectAdapterDigest(adapter);
    return this.locked(() => {
      const journal = this.read();
      const old = this.find(journal, request);
      if (old) {
        if (old.adapterId !== adapter.id || old.adapterSemanticsDigest !== semanticsDigest) throw new Error('effect_adapter_conflict');
        if (this.terminalBudgetReleaseNeeded(request, old)
          && (this.options.authorizeReconciliation ?? this.options.authorize)(request) === true) this.budgetRelease(request);
        this.assertCachedBudgetSettlement(old);
        return old.outcome ?? this.uncertain(old);
      }
      const now = this.time();
      let event: EffectEventV1 = {
        format: this.#budgetBridge ? 'aether.effect-event/4' : this.#attestedSink ? 'aether.effect-event/3' : 'aether.effect-event/1',
        sequence: String(journal.records.length), request,
        requestDigest: effectRequestDigest(request, this.limits), adapterId: adapter.id, adapterSemanticsDigest: semanticsDigest,
        state: 'requested', transitions: [{ state: 'requested', time: now, dispatchStarted: false }], dispatchStarted: false,
        prepared: null, observedAt: now, recordedAt: now, outcome: null,
        ...(this.#attestedSink ? { signedSinkReceipt: null } : {}),
      };
      // ID, authorization context and ordered input are durable before any adapter or budget call.
      this.persist(journal, event);
      let reserved = false;
      const abort = (code: string, confirmedBeforeSink = false): EffectOutcome => {
        if (reserved && this.#budgetBridge) return this.budgetedResolve(journal, event, adapter);
        if (event.prepared !== null) adapter.abort?.(request, event.prepared);
        const outcome: EffectOutcome = { state: code === 'cancelled' ? 'aborted' : 'rejected', code };
        event = this.step(journal, event, outcome.state, { outcome,
          ...(confirmedBeforeSink ? { dispatchStarted: false } : {}) });
        if (reserved) this.budgetRelease(request);
        return outcome;
      };
      try {
        let refusal = this.authorize(request, options.signal);
        if (refusal) return abort(refusal);
        if (adapter.preflight) {
          let accepted = false;
          try { const verdict: unknown = adapter.preflight(request); accepted = verdict === undefined; }
          catch { /* Pure validation refusal. */ }
          if (!accepted) return abort('adapter_preflight_rejected');
        }
        refusal = this.authorize(request, options.signal);
        if (refusal) return abort(refusal);
        if (request.budgetReservationId !== null) {
          if (!this.options.budgets && !this.#budgetBridge) return abort('budget_adapter_missing');
          if (!this.budgetReserve(request)) return abort('budget_exhausted');
          reserved = true;
        }
        event = this.step(journal, event, 'reserved');
        if (adapter.semantics.transactional) {
          const prepared = adapter.prepare!(request); validateTaggedValue(prepared, this.limits);
          event = this.step(journal, event, 'prepared', { prepared: immutable(copy(prepared, this.limits)) });
        } else event = this.step(journal, event, 'prepared');
        refusal = this.authorize(request, options.signal);
        if (refusal) return abort(refusal);
        // A durable marker always precedes the only irreversible dispatch. Any interruption
        // from here until a durable receipt remains uncertain, including cancellation.
        event = this.step(journal, event, 'prepared', { dispatchStarted: true, observedAt: this.time() });
        refusal = this.authorize(request, options.signal);
        if (refusal) {
          // We are still before adapter entry. Publish a terminal noncommit
          // transition that clears the marker; a crash before this write
          // leaves the original uncertain marker for reconciliation.
          return abort(refusal, true);
        }
        const value = adapter.semantics.transactional ? adapter.commit!(request, event.prepared!) : adapter.execute!(request);
        validateTaggedValue(value, this.limits);
        event = { ...event, observedAt: this.time() };
        const signedSinkReceipt = this.#attestedSink ? this.#attestedReceipt(request, adapter, 'committed', value) : null;
        if (reserved) this.budgetConsume(request, value);
        const outcome: EffectOutcome = { state: 'committed', receiptDigest: outcomeDigest(event, value, this.limits), value: immutable(copy(value, this.limits)) };
        event = this.step(journal, event, 'committed', { outcome,
          ...(this.#attestedSink ? { signedSinkReceipt } : {}) }); return outcome;
      } catch (error) {
        if (this.#budgetBridge && reserved) return this.budgetedResolve(journal, event, adapter);
        if (event.dispatchStarted) {
          const outcome = this.uncertain(event);
          try { this.step(journal, event, 'indeterminate', { outcome }); } catch { /* Durable prepared dispatch marker remains the recovery authority. */ }
          return outcome;
        }
        // Reservation/prepare failures may have left an external reversible reservation.
        // Preserve the durable event for explicit reconciliation; no guessed refund.
        throw error;
      }
    });
  }

  reconcile(input: EffectRequestV1, adapter: EffectAdapter): EffectOutcome {
    if (!this.#attestedSink && isAttestedSinkAdapter(adapter))
      throw new Error('attested sink adapter requires witnessed V3 broker');
    if (this.mode !== 'live') throw new Error('isolated_reconciliation_forbidden');
    validateEffectRequest(input, this.limits); const request = immutable(copy(input, this.limits));
    if (this.#budgetBridge && (!this.#budgetAuthorityPinned || request.budgetReservationId === null))
      throw new TypeError('budgeted sink reconciliation requires pinned non-null reservation authority');
    this.#assertAttestedAdapter(adapter);
    const semanticsDigest = effectAdapterDigest(adapter);
    return this.locked(() => {
      const journal = this.read(); const found = this.find(journal, request);
      if (!found) throw new Error('unknown_effect');
      if (found.adapterId !== adapter.id || found.adapterSemanticsDigest !== semanticsDigest) throw new Error('effect_adapter_conflict');
      if (found.outcome && found.outcome.state !== 'indeterminate') {
        if (this.terminalBudgetReleaseNeeded(request, found)
          && (this.options.authorizeReconciliation ?? this.options.authorize)(request) === true) this.budgetRelease(request);
        this.assertCachedBudgetSettlement(found);
        return found.outcome;
      }
      let event = found;
      // Reconciliation authority never implies permission to dispatch. The read-only
      // adapter query must be allowed under current policy (including after revocation).
      if (!(this.options.authorizeReconciliation ?? this.options.authorize)(request)) return this.uncertain(event);
      if (this.#budgetBridge) return this.budgetedResolve(journal, event, adapter);
      if (!event.dispatchStarted) {
        if (request.budgetReservationId !== null && !this.options.budgets) return this.uncertain(event);
        if (adapter.semantics.transactional) adapter.abort!(request, event.prepared);
        const outcome: EffectOutcome = { state: 'aborted', code: 'recovered_before_dispatch' };
        event = this.step(journal, event, 'aborted', { outcome });
        if (request.budgetReservationId !== null) this.options.budgets!.release(request);
        return outcome;
      }
      if (!adapter.reconcile) return this.uncertain(event);
      const resolution = adapter.reconcile(request, event.prepared);
      encodeCanonical(resolution, this.limits);
      const response = exactObject(resolution, resolution.state === 'committed' ? ['state', 'value'] : ['state']);
      if (!['committed', 'not_committed', 'unknown'].includes(String(response.state))) throw new TypeError('invalid reconciliation response');
      if (resolution.state === 'unknown') return this.uncertain(event);
      if (resolution.state === 'not_committed') {
        if (request.budgetReservationId !== null && !this.options.budgets) return this.uncertain(event);
        let signedSinkReceipt: SignedSinkReceiptV1 | null = null;
        if (this.#attestedSink) {
          try { signedSinkReceipt = this.#attestedReceipt(request, adapter, 'not_committed', null); }
          catch { return this.uncertain(event); }
        }
        const outcome: EffectOutcome = { state: 'aborted', code: 'sink_confirmed_not_committed' };
        event = this.step(journal, event, 'aborted', { outcome,
          ...(this.#attestedSink ? { signedSinkReceipt } : {}) });
        if (request.budgetReservationId !== null) this.options.budgets!.release(request);
        return outcome;
      }
      validateTaggedValue(resolution.value, this.limits);
      let signedSinkReceipt: SignedSinkReceiptV1 | null = null;
      if (this.#attestedSink) {
        try { signedSinkReceipt = this.#attestedReceipt(request, adapter, 'committed', resolution.value); }
        catch { return this.uncertain(event); }
      }
      if (request.budgetReservationId !== null) {
        if (!this.options.budgets) return this.uncertain(event);
        this.options.budgets.consume(request, resolution.value);
      }
      const outcome: EffectOutcome = { state: 'committed', receiptDigest: outcomeDigest(event, resolution.value, this.limits), value: immutable(copy(resolution.value, this.limits)) };
      event = this.step(journal, event, 'committed', { outcome,
        ...(this.#attestedSink ? { signedSinkReceipt } : {}) }); return outcome;
    });
  }
}
