import type { CapabilityName, NodeRef } from '../tier1/ids.ts';
import { decodeExecutionManifest, encodeExecutionManifest, executionManifestDigest, type ExecutionManifestV1 } from '../fabric/identity.ts';
import { validateTaggedValue, type LogicalRefV1, type TaggedValueV1 } from '../fabric/encoding.ts';
import { DurableEffectBroker, effectPayloadDigest, effectAdapterDigest, type EffectAdapter, type EffectOutcome, type EffectRequestV1, type ExecutionMode } from '../fabric/effects.ts';
import { assertEffectJournalWitness, type EffectJournalWitness } from '../fabric/effect-journal-witness.ts';
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
  #trustedWitness: EffectJournalWitness | null = null;
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
  pinWitness(witness: EffectJournalWitness): void {
    assertEffectJournalWitness(witness);
    if (!this.#attested || this.#sequence !== 0n || this.#trustedWitness)
      throw new TypeError('effect witness must bind one fresh attested router');
    DurableEffectBroker.prototype.assertWitness.call(this.#options.broker, witness);
    this.#trustedWitness = witness;
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
    if (!adapter.semantics.readOnly || !adapter.semantics.reconciliation) throw new TypeError('recorded Wasm effect lacks read-only reconciliation');
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
  #assertRecorded(capability: CapabilityName, request: EffectRequestV1): void {
    if (!this.#bound || !this.#attested || this.#attested.capability !== capability || this.#options.broker.executionMode !== 'live'
      || request.executionId !== this.#options.executionId || request.executionManifest !== this.#manifestDigest
      || request.policyEpoch !== this.#options.policyEpoch || request.deadline !== this.#options.deadline
      || request.capabilityGrantRef !== this.#attested.grantRef || request.branchId !== null
      || request.budgetReservationId !== null) throw new TypeError('recorded Wasm effect differs from attested broker context');
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
      budgetReservationId: this.#options.reservation?.(capability, effectId) ?? null,
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
export function brokerPinWitness(router: RuntimeEffectRouter, witness: EffectJournalWitness): void {
  if (!brokerRouters.has(router)) throw new TypeError('effect witness requires a broker-backed router');
  BrokerEffectRouter.prototype.pinWitness.call(router, witness);
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
