import type { CapabilityName, NodeRef } from '../tier1/ids.ts';
import { decodeExecutionManifest, encodeExecutionManifest, executionManifestDigest, validateDigest, type Digest, type ExecutionManifestV1 } from '../fabric/identity.ts';
import { encodeCanonical, exactObject, identifier, validateTaggedValue, type LogicalRefV1, type TaggedValueV1 } from '../fabric/encoding.ts';
import { DurableEffectBroker, effectPayloadDigest, effectAdapterDigest, type EffectAdapter, type EffectOutcome, type EffectRequestV1, type ExecutionMode } from '../fabric/effects.ts';
import { assertEffectJournalWitness, type AnyEffectJournalWitness } from '../fabric/effect-journal-witness.ts';
import { assertAttestedSinkAdapter, isAttestedSinkAdapter, type AttestedSinkIdentityV1 } from '../fabric/attested-sink-adapter.ts';
import type { SinkStateWitnessV1 } from '../fabric/sink-state-witness.ts';
import { ResourceBudgetBridge } from '../tier2/resource-budget-bridge.ts';
import { assertDeclarativeSinkRuntimeMapV2, type SignedSinkTableSelectionV2 } from '../tier2/declarative-sink-table.ts';
import { admittedAdapterArtifactDigest, admittedWasmAdapterCapability } from '../tier2/adapter-artifact.ts';
import { assertBeforeDeadline, assertGrantLifetime, assertTrustedClockAnchor, type TrustedClockAnchor } from '../tier2/trusted-clock-anchor.ts';
import { isClosureValue, isRef, isResultValue, isSeqValue, isTaskValue, type Ref, type Value } from './values.ts';
const brokerRouters = new WeakSet<object>();

export interface RuntimeEffectRouter {
  readonly mode: ExecutionMode;
  bind(root: NodeRef): void;
  /** Optional adapter descriptor; signed-policy hosts require this before dispatch. */
  adapterIdentity?(capability: CapabilityName): Readonly<{ id: string; digest: string; artifactDigest?: string | null }>;
  invoke(capability: CapabilityName, args: readonly Value[]): Value;
  /** Must return an isolated router. A fork must never inherit live dispatch. */
  fork(): RuntimeEffectRouter;
}

export class EffectInvocationError extends Error {
  readonly outcome: Exclude<EffectOutcome, { state: 'committed' }>;
  constructor(outcome: Exclude<EffectOutcome, { state: 'committed' }>) {
    super(outcome.state === 'indeterminate' ? `effect_indeterminate: ${outcome.recoveryId}` : `${outcome.state}: ${outcome.code}`);
    this.name = 'EffectInvocationError'; this.outcome = outcome;
  }
}

export interface RuntimeEffectRouterOptions {
  readonly broker: DurableEffectBroker;
  readonly manifest: ExecutionManifestV1;
  /** Persist/reuse this ID for retries of one logical execution. */
  readonly executionId: string;
  readonly branchId?: string | null;
  readonly policyEpoch: string;
  readonly deadline: string;
  readonly adapters: ReadonlyMap<CapabilityName, EffectAdapter>;
  readonly grant: (capability: CapabilityName) => string;
  /** V4 signed-host path: immutable host-derived reference, no callback at replay. */
  readonly grantRef?: string;
  readonly reservation?: (capability: CapabilityName, effectId: string) => string | null;
  /** V5 host selected fixed grant. A callback cannot assign a live reservation. */
  readonly budgetReservationId?: string;
  /** V13 host selected complete signed adapter table. */
  readonly admissionTableDigest?: Digest;
  readonly references?: { encode(ref: Ref): LogicalRefV1; decode(ref: LogicalRefV1): Ref };
  /** Explicit host factory, because sandbox state/recorded inputs are host resources. */
  readonly isolatedFork?: () => RuntimeEffectRouter;
}
export interface BrokerAttestedContext {
  readonly executionId: string;
  readonly manifestDigest: string;
  readonly mode: ExecutionMode;
  readonly policyEpoch: string;
  readonly deadline: string;
  readonly clockDomain: string;
  readonly capability: CapabilityName;
  readonly grantRef: string;
  /** Omitted from V10/V11 historical signed context bytes. */
  readonly budget?: BrokerBudgetAttestedContextV1;
  /** Omitted from all historical router contexts. */
  readonly admissionTableDigest?: Digest;
}
export interface BrokerBudgetAttestedContextV1 {
  readonly format: 'aether.attested-sink-budget-router/1';
  readonly reservationId: string;
  readonly bridgeProfileDigest: Digest;
}

/** One logical execution; replay/retry reconstructs the router with the same context. */
export class BrokerEffectRouter implements RuntimeEffectRouter {
  readonly #options: RuntimeEffectRouterOptions;
  readonly #root: string;
  readonly #manifestDigest: string;
  #sequence = 0n;
  #bound = false;
  #attested: Readonly<{ capability: CapabilityName; grantRef: string }> | null = null;
  #trustedClock: { anchor: TrustedClockAnchor; windows: readonly { issuedAt: number; expiresAt: number }[] } | null = null;
  #trustedWitness: AnyEffectJournalWitness | null = null;
  #trustedSinkAuthority = false;
  #budgetContext: Readonly<BrokerBudgetAttestedContextV1> | null = null;
  #budgetAuthorityPinned = false;
  #admissionTableDigest: Digest | null = null;
  #admissionTablePinned = false;
  get mode(): ExecutionMode { return this.#options.broker.executionMode; }

  constructor(options: RuntimeEffectRouterOptions) {
    const manifest = decodeExecutionManifest(encodeExecutionManifest(options.manifest));
    this.#options = { ...options, manifest, adapters: new Map(options.adapters) };
    this.#root = manifest.astRoot;
    this.#manifestDigest = executionManifestDigest(manifest);
    brokerRouters.add(this);
  }
  bind(root: NodeRef): void {
    if (root !== this.#root) throw new TypeError('effect router execution manifest does not match loaded code');
    this.#bound = true;
  }
  adapterIdentity(capability: CapabilityName): Readonly<{ id: string; digest: string; artifactDigest: string | null }> {
    const adapter = this.#options.adapters.get(capability);
    if (!adapter) throw new Error(`no broker adapter for ${capability}`);
    return { id: adapter.id, digest: effectAdapterDigest(adapter), artifactDigest: admittedAdapterArtifactDigest(adapter) };
  }
  wasmAdapterCapability(capability: CapabilityName): CapabilityName | null {
    const adapter = this.#options.adapters.get(capability);
    return adapter ? admittedWasmAdapterCapability(adapter) : null;
  }
  /** V4 signed hosts pin the exact factory context before broker dispatch.
   * The resulting grant reference is reused, preventing a callback swap. */
  attestContext(expected: BrokerAttestedContext): void {
    if (!this.#bound || this.#attested || this.#sequence !== 0n || this.#options.executionId !== expected.executionId
      || this.#manifestDigest !== expected.manifestDigest || this.#options.broker.executionMode !== expected.mode
      || this.#options.policyEpoch !== expected.policyEpoch || this.#options.deadline !== expected.deadline
      || this.#options.broker.clockDomain !== expected.clockDomain
      || (this.#options.branchId ?? null) !== null || this.#options.reservation !== undefined
      || this.#options.references !== undefined) throw new TypeError('broker router context differs from signed host effect');
    if (this.#options.grantRef !== expected.grantRef) throw new TypeError('broker router grant reference differs from signed host effect');
    if (expected.budget) {
      exactObject(expected.budget, ['format', 'reservationId', 'bridgeProfileDigest']);
      if (expected.budget.format !== 'aether.attested-sink-budget-router/1'
        || this.#options.budgetReservationId !== expected.budget.reservationId)
        throw new TypeError('broker router reservation differs from signed host effect');
      identifier(expected.budget.reservationId);
      validateDigest(expected.budget.bridgeProfileDigest, 'aether.resource-budget-bridge/1');
      this.#budgetContext = Object.freeze({ ...expected.budget });
    } else if (this.#options.budgetReservationId !== undefined)
      throw new TypeError('unattested budget reservation in broker router');
    if (expected.admissionTableDigest !== undefined) {
      validateDigest(expected.admissionTableDigest, 'aether.declarative-adapter-table/2');
      if (this.#options.admissionTableDigest !== expected.admissionTableDigest)
        throw new TypeError('broker router adapter table differs from signed host effect');
      this.#admissionTableDigest = expected.admissionTableDigest;
    } else if (this.#options.admissionTableDigest !== undefined)
      throw new TypeError('unattested adapter table in broker router');
    this.#attested = Object.freeze({ capability: expected.capability, grantRef: expected.grantRef });
  }
  pinTrustedClock(anchor: TrustedClockAnchor, windows: readonly { issuedAt: number; expiresAt: number }[]): void {
    assertTrustedClockAnchor(anchor);
    if (!this.#attested || this.#sequence !== 0n || this.#trustedClock || !Array.isArray(windows) || !windows.length)
      throw new TypeError('trusted clock must bind one fresh attested router');
    const checked = windows.map(window => {
      assertGrantLifetime(anchor, window.issuedAt, window.expiresAt);
      return Object.freeze({ issuedAt: window.issuedAt, expiresAt: window.expiresAt });
    });
    assertBeforeDeadline(anchor, this.#options.deadline, this.#options.broker.clockDomain);
    DurableEffectBroker.prototype.pinTrustedClock.call(this.#options.broker, anchor, checked);
    this.#trustedClock = { anchor, windows: Object.freeze(checked) };
  }
  pinWitness(witness: AnyEffectJournalWitness): void {
    assertEffectJournalWitness(witness);
    if (!this.#attested || this.#sequence !== 0n || this.#trustedWitness)
      throw new TypeError('effect witness must bind one fresh attested router');
    DurableEffectBroker.prototype.assertWitness.call(this.#options.broker, witness);
    this.#trustedWitness = witness;
  }
  assertAttestedSinkAuthority(capability: CapabilityName, expected: AttestedSinkIdentityV1,
    sinkStateWitness: SinkStateWitnessV1): void {
    if (!this.#bound || !this.#attested || this.#attested.capability !== capability
      || !this.#trustedWitness || this.#sequence !== 0n)
      throw new TypeError('attested sink authority requires a fresh pinned broker router');
    const adapter = this.#options.adapters.get(capability);
    if (!adapter) throw new TypeError('attested sink adapter absent');
    assertAttestedSinkAdapter(adapter, expected);
    DurableEffectBroker.prototype.assertAttestedSinkAuthority.call(this.#options.broker, {
      anchor: expected.anchor, deploymentId: expected.deploymentId,
      approvedAdapterArtifactDigest: expected.approvedAdapterArtifactDigest,
    }, sinkStateWitness);
    this.#trustedSinkAuthority = true;
  }
  attestBudgetAuthority(expectedBridge: ResourceBudgetBridge, expected: BrokerBudgetAttestedContextV1): void {
    ResourceBudgetBridge.assertInstance(expectedBridge);
    if (!this.#bound || !this.#attested || !this.#trustedSinkAuthority || !this.#trustedWitness
      || this.#sequence !== 0n || this.#budgetAuthorityPinned || !this.#budgetContext
      || this.#budgetContext.format !== expected.format
      || this.#budgetContext.reservationId !== expected.reservationId
      || this.#budgetContext.bridgeProfileDigest !== expected.bridgeProfileDigest)
      throw new TypeError('broker router budget authority differs from signed host selection');
    DurableEffectBroker.prototype.assertBudgetAuthority.call(this.#options.broker,
      expectedBridge, expected.bridgeProfileDigest);
    this.#budgetAuthorityPinned = true;
  }
  /** Inspect the private complete adapter map under the operator's V7 policy.
   * A factory's self-reported map or override cannot satisfy this check. */
  assertAdmissionTableV2(selection: SignedSinkTableSelectionV2,
    authority: AttestedSinkIdentityV1, witness: SinkStateWitnessV1): void {
    if (!this.#bound || !this.#attested || !this.#trustedSinkAuthority || !this.#trustedWitness
      || this.#sequence !== 0n || this.#admissionTablePinned || !this.#admissionTableDigest
      || this.#admissionTableDigest !== selection.policy.body.adapterTableDigest
      || executionManifestDigest(selection.manifest) !== this.#manifestDigest)
      throw new TypeError('broker adapter table differs from operator signed host selection');
    assertDeclarativeSinkRuntimeMapV2(selection, this.#options.adapters, authority, witness);
    this.#admissionTablePinned = true;
  }
  fork(): RuntimeEffectRouter {
    if (!this.#options.isolatedFork) throw new Error('broker-backed fork requires an isolated effect router');
    const child = this.#options.isolatedFork();
    if (child === this || child.mode === 'live') throw new Error('fork cannot reuse live effect authority');
    child.bind(this.#root as NodeRef);
    return child;
  }
  invoke(capability: CapabilityName, args: readonly Value[]): Value {
    if (!this.#bound) throw new Error('effect router is not bound to loaded code');
    if (this.#budgetContext && !this.#budgetAuthorityPinned)
      throw new TypeError('budgeted broker router lacks operator authority');
    if (this.#admissionTableDigest && !this.#admissionTablePinned)
      throw new TypeError('signed adapter table lacks complete broker map attestation');
    if (this.#attested && this.#attested.capability !== capability) throw new TypeError('attested effect capability mismatch');
    if (this.#trustedClock && this.#options.broker.executionMode === 'live') {
      for (const window of this.#trustedClock.windows) assertGrantLifetime(this.#trustedClock.anchor, window.issuedAt, window.expiresAt);
      assertBeforeDeadline(this.#trustedClock.anchor, this.#options.deadline, this.#options.broker.clockDomain);
    }
    const adapter = this.#options.adapters.get(capability);
    if (!adapter) throw new Error(`no broker adapter for ${capability}`);
    const request = this.#request(capability, args, `operation-${this.#sequence++}`);
    const outcome = this.#trustedWitness
      ? DurableEffectBroker.prototype.dispatch.call(this.#options.broker, request, adapter)
      : this.#options.broker.dispatch(request, adapter);
    if (outcome.state !== 'committed') throw new EffectInvocationError(outcome);
    return this.#decode(outcome.value);
  }
  reconcileLast(capability: CapabilityName, args: readonly Value[]): Value {
    if (!this.#bound || !this.#attested || this.#attested.capability !== capability || this.#sequence < 1n
      || this.#options.broker.executionMode !== 'live') throw new TypeError('no attested live Wasm effect to reconcile');
    const adapter = this.#options.adapters.get(capability);
    if (!adapter || !adapter.semantics.readOnly || !adapter.semantics.reconciliation) throw new TypeError('Wasm reconciliation requires a read-only adapter');
    const request = this.#request(capability, args, `operation-${this.#sequence - 1n}`);
    const outcome = this.#trustedWitness
      ? DurableEffectBroker.prototype.reconcile.call(this.#options.broker, request, adapter)
      : this.#options.broker.reconcile(request, adapter);
    if (outcome.state !== 'committed') throw new EffectInvocationError(outcome);
    return this.#decode(outcome.value);
  }
  reconcileRecorded(capability: CapabilityName, request: EffectRequestV1): EffectOutcome {
    this.#assertRecorded(capability, request);
    const adapter = this.#options.adapters.get(capability)!;
    if (!adapter.semantics.reconciliation || !adapter.semantics.readOnly
      && !(this.#trustedSinkAuthority && isAttestedSinkAdapter(adapter)))
      throw new TypeError('recorded effect lacks trusted reconciliation');
    // The prior controller may have died while holding the broker's durable
    // dispatch ticket. Recovery checks that exact owner is dead before asking
    // the original sink for status; a live or unverifiable writer stays fenced.
    DurableEffectBroker.prototype.recoverDeadWriter.call(this.#options.broker);
    return this.#trustedWitness
      ? DurableEffectBroker.prototype.reconcile.call(this.#options.broker, request, adapter)
      : this.#options.broker.reconcile(request, adapter);
  }
  inspectRecorded(capability: CapabilityName, request: EffectRequestV1): EffectOutcome | null {
    this.#assertRecorded(capability, request);
    const adapter = this.#options.adapters.get(capability)!;
    return this.#trustedWitness
      ? DurableEffectBroker.prototype.inspectRecorded.call(this.#options.broker, request, adapter)
      : this.#options.broker.inspectRecorded(request, adapter);
  }
  /** Historical general-broker reconciliation. The host supplies the exact
   * tagged arguments retained at the effect boundary; no live grant callback
   * is evaluated to reconstruct the old request. */
  reconcileBoundary(capability: CapabilityName, args: readonly TaggedValueV1[], effectId: string): EffectOutcome {
    if (!this.#bound || this.#options.broker.executionMode !== 'live')
      throw new TypeError('recorded boundary requires a bound live broker');
    const adapter = this.#options.adapters.get(capability);
    if (!adapter) throw new TypeError('recorded boundary lacks its adapter');
    // This method is reached only from an explicitly authorized host recovery.
    // A dead writer's immutable ticket must be released before reading its
    // durable dispatch marker; a live or unverifiable owner still fails closed.
    DurableEffectBroker.prototype.recoverDeadWriter.call(this.#options.broker);
    const request = this.#trustedWitness
      ? DurableEffectBroker.prototype.recordedRequest.call(this.#options.broker, this.#options.executionId, effectId)
      : this.#options.broker.recordedRequest(this.#options.executionId, effectId);
    if (!request) throw new Error('recorded effect is absent from the broker');
    const payload: TaggedValueV1 = { tag: 'sequence', items: [{ tag: 'string', value: capability }, ...args] };
    if (request.executionId !== this.#options.executionId || request.effectId !== effectId
      || request.executionManifest !== this.#manifestDigest || request.policyEpoch !== this.#options.policyEpoch
      || request.deadline !== this.#options.deadline || request.branchId !== (this.#options.branchId ?? null)
      || request.budgetReservationId !== null || request.payloadDigest !== effectPayloadDigest(payload)
      || !Buffer.from(encodeCanonical(request.payload)).equals(Buffer.from(encodeCanonical(payload))))
      throw new TypeError('recorded effect differs from exact host boundary');
    return this.#trustedWitness
      ? DurableEffectBroker.prototype.reconcile.call(this.#options.broker, request, adapter)
      : this.#options.broker.reconcile(request, adapter);
  }
  #assertRecorded(capability: CapabilityName, request: EffectRequestV1): void {
    if (!this.#bound || !this.#attested || this.#attested.capability !== capability || this.#options.broker.executionMode !== 'live'
      || request.executionId !== this.#options.executionId || request.executionManifest !== this.#manifestDigest
      || request.policyEpoch !== this.#options.policyEpoch || request.deadline !== this.#options.deadline
      || request.capabilityGrantRef !== this.#attested.grantRef || request.branchId !== null
      || request.budgetReservationId !== (this.#budgetContext?.reservationId ?? null)
      || this.#budgetContext && !this.#budgetAuthorityPinned
      || this.#admissionTableDigest && !this.#admissionTablePinned)
      throw new TypeError('recorded Wasm effect differs from attested broker context');
    if (!this.#options.adapters.has(capability)) throw new TypeError('recorded Wasm effect lacks an adapter');
  }
  #request(capability: CapabilityName, args: readonly Value[], effectId: string) {
    const payload: TaggedValueV1 = { tag: 'sequence', items: [
      { tag: 'string', value: capability }, ...args.map(value => this.#encode(value)),
    ] };
    validateTaggedValue(payload);
    return {
      format: 'aether.effect/1', executionId: this.#options.executionId, effectId,
      branchId: this.#options.branchId ?? null, executionManifest: this.#manifestDigest,
      capabilityGrantRef: this.#attested?.grantRef ?? this.#options.grant(capability), policyEpoch: this.#options.policyEpoch,
      payloadDigest: effectPayloadDigest(payload), payload,
      budgetReservationId: this.#budgetContext?.reservationId ?? this.#options.reservation?.(capability, effectId) ?? null,
      deadline: this.#options.deadline,
    } as const;
  }
  #encode(value: Value, depth = 0): TaggedValueV1 {
    if (depth > 64) throw new RangeError('effect argument nesting limit');
    if (value === null) return { tag: 'null' };
    if (typeof value === 'boolean') return { tag: 'bool', value };
    if (typeof value === 'bigint') return { tag: 'int', value: value.toString() };
    if (typeof value === 'string') return { tag: 'string', value };
    if (isClosureValue(value) || isTaskValue(value)) throw new TypeError('opaque execution state cannot be sent to an effect adapter');
    if (isRef(value)) {
      if (!this.#options.references) throw new TypeError('effect reference requires explicit ownership translation');
      return { tag: 'ref', value: this.#options.references.encode(value) };
    }
    if (isSeqValue(value)) return { tag: 'sequence', items: value.map(item => this.#encode(item, depth + 1)) };
    if (isResultValue(value)) return { tag: 'result', variant: value.variant, value: this.#encode(value.value, depth + 1) };
    throw new TypeError('unsupported runtime effect value');
  }
  #decode(value: TaggedValueV1): Value {
    validateTaggedValue(value);
    switch (value.tag) {
      case 'null': return null;
      case 'bool': case 'string': return value.value;
      case 'int': return BigInt(value.value);
      case 'sequence': return value.items.map(item => this.#decode(item));
      case 'result': return { variant: value.variant, value: this.#decode(value.value) };
      case 'ref':
        if (!this.#options.references) throw new TypeError('effect reference requires explicit ownership translation');
        return this.#options.references.decode(value.value);
      case 'authority': throw new TypeError('effect result cannot install authority implicitly');
    }
  }
}
/** The v2 signed host reads the actual broker adapter map, bypassing a
 * factory-supplied router's self-reported adapter identity. */
export function brokerAdapterIdentity(router: RuntimeEffectRouter, capability: CapabilityName): Readonly<{ id: string; digest: string; artifactDigest: string | null }> {
  if (!brokerRouters.has(router)) throw new TypeError('artifact policy requires a broker-backed router');
  return BrokerEffectRouter.prototype.adapterIdentity.call(router, capability);
}
export function brokerWasmAdapterCapability(router: RuntimeEffectRouter, capability: CapabilityName): CapabilityName | null {
  if (!brokerRouters.has(router)) throw new TypeError('artifact policy requires a broker-backed router');
  return BrokerEffectRouter.prototype.wasmAdapterCapability.call(router, capability);
}

/** Signed-policy hosts call the base router boundary directly. Subclasses or
 * own properties cannot replace bind, mode or dispatch after identity checking;
 * the base uses JavaScript-private adapter and broker state. */
export function brokerMode(router: RuntimeEffectRouter): ExecutionMode {
  if (!brokerRouters.has(router)) throw new TypeError('artifact policy requires a broker-backed router');
  return Object.getOwnPropertyDescriptor(BrokerEffectRouter.prototype, 'mode')!.get!.call(router) as ExecutionMode;
}
export function brokerBind(router: RuntimeEffectRouter, root: NodeRef): void {
  if (!brokerRouters.has(router)) throw new TypeError('artifact policy requires a broker-backed router');
  BrokerEffectRouter.prototype.bind.call(router, root);
}
export function brokerInvoke(router: RuntimeEffectRouter, capability: CapabilityName, args: readonly Value[]): Value {
  if (!brokerRouters.has(router)) throw new TypeError('artifact policy requires a broker-backed router');
  return BrokerEffectRouter.prototype.invoke.call(router, capability, args);
}
export function brokerAttestContext(router: RuntimeEffectRouter, expected: BrokerAttestedContext): void {
  if (!brokerRouters.has(router)) throw new TypeError('artifact policy requires a broker-backed router');
  BrokerEffectRouter.prototype.attestContext.call(router, expected);
}
export function brokerPinTrustedClock(router: RuntimeEffectRouter, anchor: TrustedClockAnchor,
  windows: readonly { issuedAt: number; expiresAt: number }[]): void {
  if (!brokerRouters.has(router)) throw new TypeError('trusted clock requires a broker-backed router');
  BrokerEffectRouter.prototype.pinTrustedClock.call(router, anchor, windows);
}
export function brokerPinWitness(router: RuntimeEffectRouter, witness: AnyEffectJournalWitness): void {
  if (!brokerRouters.has(router)) throw new TypeError('effect witness requires a broker-backed router');
  BrokerEffectRouter.prototype.pinWitness.call(router, witness);
}
/** Nonvirtual check of the exact trusted wrapper, broker context and sink
 * decision witness. A reloadable factory cannot attest itself via overrides. */
export function brokerAssertAttestedSinkAuthority(router: RuntimeEffectRouter,
  capability: CapabilityName, expected: AttestedSinkIdentityV1,
  sinkStateWitness: SinkStateWitnessV1): void {
  if (!brokerRouters.has(router)) throw new TypeError('sink authority requires a broker-backed router');
  BrokerEffectRouter.prototype.assertAttestedSinkAuthority.call(router, capability, expected, sinkStateWitness);
}
/** Nonvirtual operator bridge attestation; the factory cannot swap a budget hook. */
export function brokerAttestBudgetAuthority(router: RuntimeEffectRouter,
  expectedBridge: ResourceBudgetBridge, expected: BrokerBudgetAttestedContextV1): void {
  if (!brokerRouters.has(router)) throw new TypeError('budget authority requires a broker-backed router');
  BrokerEffectRouter.prototype.attestBudgetAuthority.call(router, expectedBridge, expected);
}
/** Nonvirtual complete-map check for signed V7 sink deployments. */
export function brokerAssertAdmissionTableV2(router: RuntimeEffectRouter,
  selection: SignedSinkTableSelectionV2, authority: AttestedSinkIdentityV1,
  witness: SinkStateWitnessV1): void {
  if (!brokerRouters.has(router)) throw new TypeError('adapter table requires a broker-backed router');
  BrokerEffectRouter.prototype.assertAdmissionTableV2.call(router, selection, authority, witness);
}
export function brokerReconcileLast(router: RuntimeEffectRouter, capability: CapabilityName, args: readonly Value[]): Value {
  if (!brokerRouters.has(router)) throw new TypeError('artifact policy requires a broker-backed router');
  return BrokerEffectRouter.prototype.reconcileLast.call(router, capability, args);
}
export function brokerReconcileRecorded(router: RuntimeEffectRouter, capability: CapabilityName, request: EffectRequestV1): EffectOutcome {
  if (!brokerRouters.has(router)) throw new TypeError('artifact policy requires a broker-backed router');
  return BrokerEffectRouter.prototype.reconcileRecorded.call(router, capability, request);
}
export function brokerInspectRecorded(router: RuntimeEffectRouter, capability: CapabilityName, request: EffectRequestV1): EffectOutcome | null {
  if (!brokerRouters.has(router)) throw new TypeError('artifact policy requires a broker-backed router');
  return BrokerEffectRouter.prototype.inspectRecorded.call(router, capability, request);
}
export function brokerReconcileBoundary(router: RuntimeEffectRouter, capability: CapabilityName,
  args: readonly TaggedValueV1[], effectId: string): EffectOutcome {
  if (!brokerRouters.has(router)) throw new TypeError('recovery requires a broker-backed router');
  return BrokerEffectRouter.prototype.reconcileBoundary.call(router, capability, args, effectId);
}
