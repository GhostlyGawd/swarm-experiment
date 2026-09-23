import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { JournalLock } from './journal-lock.ts';
import { atomicWrite } from '../tier1/persistence.ts';
import { decimal, decodeCanonical, encodeCanonical, encodingLimits, exactObject, identifier, validateTaggedValue, type EncodingLimits, type TaggedValueV1 } from './encoding.ts';
import { domainDigest, validateDigest, type Digest } from './identity.ts';

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
  /** Release only the unused reservation. The broker never releases an uncertain or committed effect. */
  release(request: EffectRequestV1): void;
}
export interface EffectEventV1 {
  readonly format: 'aether.effect-event/1';
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
}
interface EffectJournalV1 { format: 'aether.effect-journal/1'; clockDomain: string; records: EffectEventV1[] }
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
  get executionMode(): ExecutionMode { return this.mode; }
  constructor(options: EffectBrokerOptions) {
    identifier(options.clockDomain);
    this.options = options; this.limits = encodingLimits(options.limits); this.mode = options.mode ?? 'live';
    if (!['live', 'speculative', 'shadow', 'replay'].includes(this.mode)) throw new TypeError('unknown execution mode');
    this.file = join(options.directory, 'effects.json');
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
  recoverDeadWriter(): void { this.journalLock.recoverDeadWriter(); }
  private validateEvent(value: unknown): asserts value is EffectEventV1 {
    const e = exactObject(value, ['format', 'sequence', 'request', 'requestDigest', 'adapterId', 'adapterSemanticsDigest', 'state', 'transitions', 'dispatchStarted', 'prepared', 'observedAt', 'recordedAt', 'outcome']);
    if (e.format !== 'aether.effect-event/1') throw new TypeError('unsupported effect event version');
    validateEffectRequest(e.request, this.limits); decimal(e.sequence, this.limits); decimal(e.observedAt, this.limits); decimal(e.recordedAt, this.limits);
    if (effectRequestDigest(e.request, this.limits) !== e.requestDigest) throw new TypeError('corrupt effect request binding');
    identifier(e.adapterId); validateDigest(e.adapterSemanticsDigest, 'aether.effect-adapter/1');
    const states = ['requested', 'reserved', 'prepared', 'committed', 'rejected', 'aborted', 'indeterminate'];
    if (typeof e.state !== 'string' || !states.includes(e.state) || typeof e.dispatchStarted !== 'boolean' || !Array.isArray(e.transitions) || e.transitions.length === 0) throw new TypeError('invalid effect event');
    let previousState: string | null = null, previousDispatch = false;
    const allowed: Record<string, readonly string[]> = {
      requested: ['reserved', 'rejected', 'aborted'], reserved: ['prepared', 'aborted'],
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
        if (['committed', 'indeterminate'].includes(t.state) && !t.dispatchStarted) throw new TypeError('terminal effect lacks dispatch marker');
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
        if (state === 'rejected' && (e.dispatchStarted || !['deadline_exceeded', 'branch_not_admitted', 'authorization_denied', 'budget_adapter_missing', 'budget_exhausted'].includes(out.code))) throw new TypeError('rejection cannot follow an uncertain dispatch');
        if (state === 'aborted' && (e.dispatchStarted ? out.code !== 'sink_confirmed_not_committed' : !['cancelled', 'recovered_before_dispatch'].includes(out.code))) throw new TypeError('abort lacks matching noncommit evidence');
      }
      else throw new TypeError('unsupported effect outcome');
    } else if (['committed', 'rejected', 'aborted', 'indeterminate'].includes(e.state)) throw new TypeError('missing effect outcome');
  }
  private validateOrderedEvents(events: readonly EffectEventV1[]): void {
    if (!Array.isArray(events)) throw new TypeError('invalid effect trace');
    const identities = new Set<string>();
    for (let index = 0; index < events.length; index++) {
      const record = events[index]; this.validateEvent(record);
      const key = this.key(record.request);
      if (record.sequence !== String(index) || identities.has(key)) throw new TypeError('corrupt effect ordering');
      identities.add(key);
    }
  }
  private read(): EffectJournalV1 {
    if (!existsSync(this.file)) return { format: 'aether.effect-journal/1', clockDomain: this.options.clockDomain, records: [] };
    if (statSync(this.file).size > this.limits.maxFrameBytes) throw new RangeError('journal frame limit exceeded');
    const j = exactObject(decodeCanonical(readFileSync(this.file), this.limits), ['format', 'clockDomain', 'records']);
    if (j.format !== 'aether.effect-journal/1' || j.clockDomain !== this.options.clockDomain || !Array.isArray(j.records)) throw new TypeError('unsupported journal or clock domain');
    this.validateOrderedEvents(j.records);
    return j as unknown as EffectJournalV1;
  }
  private persist(journal: EffectJournalV1, event: EffectEventV1): void {
    this.validateEvent(event);
    const records = [...journal.records]; records[Number(event.sequence)] = event;
    const next = { ...journal, records };
    const encoded = encodeCanonical(next, this.limits);
    this.options.beforePersist?.(immutable(copy(event, this.limits)));
    atomicWrite(this.file, Buffer.from(encoded).toString('utf8'));
    const fd = openSync(this.options.directory, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); }
    journal.records = records;
  }
  private key(request: EffectRequestV1): string { return JSON.stringify([request.executionId, request.effectId]); }
  private find(journal: EffectJournalV1, request: EffectRequestV1): EffectEventV1 | undefined {
    const event = journal.records.find(e => this.key(e.request) === this.key(request));
    if (event && event.requestDigest !== effectRequestDigest(request, this.limits)) throw new Error('effect_identity_conflict');
    return event;
  }
  private step(journal: EffectJournalV1, event: EffectEventV1, state: EffectEventV1['state'], updates: Partial<EffectEventV1> = {}): EffectEventV1 {
    const next: EffectEventV1 = { ...event, ...updates, state, recordedAt: this.time(), transitions: [...event.transitions, { state, time: this.time(), dispatchStarted: updates.dispatchStarted ?? event.dispatchStarted }] };
    this.persist(journal, next); return next;
  }
  private uncertain(event: EffectEventV1): EffectOutcome { return { state: 'indeterminate', recoveryId: event.requestDigest }; }
  private authorize(request: EffectRequestV1, signal?: AbortSignal): string | null {
    if (signal?.aborted) return 'cancelled';
    if (BigInt(this.time()) > BigInt(request.deadline)) return 'deadline_exceeded';
    if (request.branchId !== null && !this.options.authorizeBranch?.(request)) return 'branch_not_admitted';
    return this.options.authorize(request) ? null : 'authorization_denied';
  }
  /** Replay is isolated from current grants; exactly matches the recorded logical event sequence. */
  private replay(request: EffectRequestV1, adapter: EffectAdapter): EffectOutcome {
    const event = this.trace[this.cursor];
    if (!event || event.requestDigest !== effectRequestDigest(request, this.limits) || event.adapterId !== adapter.id || event.adapterSemanticsDigest !== effectAdapterDigest(adapter) || event.outcome === null || event.outcome.state === 'indeterminate') throw new Error('replay_mismatch');
    this.cursor++; return immutable(copy(event.outcome, this.limits));
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
  get replayRemaining(): number { return this.trace.length - this.cursor; }
  assertReplayComplete(): void { if (this.replayRemaining !== 0) throw new Error('replay_mismatch: unconsumed events'); }
  intents(): readonly EffectRequestV1[] { return immutable(copy(this.buffered, this.limits)); }
  events(): readonly EffectEventV1[] { return immutable(copy(this.read().records, this.limits)); }

  dispatch(input: EffectRequestV1, adapter: EffectAdapter, options: { signal?: AbortSignal } = {}): EffectOutcome {
    validateEffectRequest(input, this.limits);
    const request = immutable(copy(input, this.limits));
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
        return old.outcome ?? this.uncertain(old);
      }
      const now = this.time();
      let event: EffectEventV1 = {
        format: 'aether.effect-event/1', sequence: String(journal.records.length), request,
        requestDigest: effectRequestDigest(request, this.limits), adapterId: adapter.id, adapterSemanticsDigest: semanticsDigest,
        state: 'requested', transitions: [{ state: 'requested', time: now, dispatchStarted: false }], dispatchStarted: false,
        prepared: null, observedAt: now, recordedAt: now, outcome: null,
      };
      // ID, authorization context and ordered input are durable before any adapter or budget call.
      this.persist(journal, event);
      let reserved = false;
      const abort = (code: string): EffectOutcome => {
        if (event.prepared !== null) adapter.abort?.(request, event.prepared);
        if (reserved) this.options.budgets!.release(request);
        const outcome: EffectOutcome = { state: code === 'cancelled' ? 'aborted' : 'rejected', code };
        event = this.step(journal, event, outcome.state, { outcome }); return outcome;
      };
      try {
        let refusal = this.authorize(request, options.signal);
        if (refusal) return abort(refusal);
        if (request.budgetReservationId !== null) {
          if (!this.options.budgets) return abort('budget_adapter_missing');
          if (!this.options.budgets.reserve(request)) return abort('budget_exhausted');
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
        if (refusal) { event = { ...event, dispatchStarted: false }; return abort(refusal); }
        const value = adapter.semantics.transactional ? adapter.commit!(request, event.prepared!) : adapter.execute!(request);
        validateTaggedValue(value, this.limits);
        event = { ...event, observedAt: this.time() };
        if (reserved) this.options.budgets!.consume(request, value);
        const outcome: EffectOutcome = { state: 'committed', receiptDigest: outcomeDigest(event, value, this.limits), value: immutable(copy(value, this.limits)) };
        event = this.step(journal, event, 'committed', { outcome }); return outcome;
      } catch (error) {
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
    if (this.mode !== 'live') throw new Error('isolated_reconciliation_forbidden');
    validateEffectRequest(input, this.limits); const request = immutable(copy(input, this.limits));
    const semanticsDigest = effectAdapterDigest(adapter);
    return this.locked(() => {
      const journal = this.read(); const found = this.find(journal, request);
      if (!found) throw new Error('unknown_effect');
      if (found.adapterId !== adapter.id || found.adapterSemanticsDigest !== semanticsDigest) throw new Error('effect_adapter_conflict');
      if (found.outcome && found.outcome.state !== 'indeterminate') return found.outcome;
      let event = found;
      // Reconciliation authority never implies permission to dispatch. The read-only
      // adapter query must be allowed under current policy (including after revocation).
      if (!(this.options.authorizeReconciliation ?? this.options.authorize)(request)) return this.uncertain(event);
      if (!event.dispatchStarted) {
        if (adapter.semantics.transactional) adapter.abort!(request, event.prepared);
        if (request.budgetReservationId !== null) {
          if (!this.options.budgets) return this.uncertain(event);
          this.options.budgets.release(request);
        }
        const outcome: EffectOutcome = { state: 'aborted', code: 'recovered_before_dispatch' };
        this.step(journal, event, 'aborted', { outcome }); return outcome;
      }
      if (!adapter.reconcile) return this.uncertain(event);
      const resolution = adapter.reconcile(request, event.prepared);
      encodeCanonical(resolution, this.limits);
      const response = exactObject(resolution, resolution.state === 'committed' ? ['state', 'value'] : ['state']);
      if (!['committed', 'not_committed', 'unknown'].includes(String(response.state))) throw new TypeError('invalid reconciliation response');
      if (resolution.state === 'unknown') return this.uncertain(event);
      if (resolution.state === 'not_committed') {
        if (request.budgetReservationId !== null) {
          if (!this.options.budgets) return this.uncertain(event);
          this.options.budgets.release(request);
        }
        const outcome: EffectOutcome = { state: 'aborted', code: 'sink_confirmed_not_committed' };
        this.step(journal, event, 'aborted', { outcome }); return outcome;
      }
      validateTaggedValue(resolution.value, this.limits);
      if (request.budgetReservationId !== null) {
        if (!this.options.budgets) return this.uncertain(event);
        this.options.budgets.consume(request, resolution.value);
      }
      const outcome: EffectOutcome = { state: 'committed', receiptDigest: outcomeDigest(event, resolution.value, this.limits), value: immutable(copy(resolution.value, this.limits)) };
      event = this.step(journal, event, 'committed', { outcome }); return outcome;
    });
  }
}
