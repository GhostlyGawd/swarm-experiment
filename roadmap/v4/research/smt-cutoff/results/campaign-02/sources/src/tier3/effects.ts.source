import type { CapabilityName, NodeRef } from '../tier1/ids.ts';
import { decodeExecutionManifest, encodeExecutionManifest, executionManifestDigest, type ExecutionManifestV1 } from '../fabric/identity.ts';
import { validateTaggedValue, type LogicalRefV1, type TaggedValueV1 } from '../fabric/encoding.ts';
import { DurableEffectBroker, effectPayloadDigest, effectAdapterDigest, type EffectAdapter, type EffectOutcome, type ExecutionMode } from '../fabric/effects.ts';
import { admittedAdapterArtifactDigest } from '../tier2/adapter-artifact.ts';
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
  readonly reservation?: (capability: CapabilityName, effectId: string) => string | null;
  readonly references?: { encode(ref: Ref): LogicalRefV1; decode(ref: LogicalRefV1): Ref };
  /** Explicit host factory, because sandbox state/recorded inputs are host resources. */
  readonly isolatedFork?: () => RuntimeEffectRouter;
}

/** One logical execution; replay/retry reconstructs the router with the same context. */
export class BrokerEffectRouter implements RuntimeEffectRouter {
  private readonly options: RuntimeEffectRouterOptions;
  private readonly root: string;
  private readonly manifestDigest: string;
  private sequence = 0n;
  private bound = false;
  get mode(): ExecutionMode { return this.options.broker.executionMode; }

  constructor(options: RuntimeEffectRouterOptions) {
    const manifest = decodeExecutionManifest(encodeExecutionManifest(options.manifest));
    this.options = { ...options, manifest, adapters: new Map(options.adapters) };
    this.root = manifest.astRoot;
    this.manifestDigest = executionManifestDigest(manifest);
    brokerRouters.add(this);
  }
  bind(root: NodeRef): void {
    if (root !== this.root) throw new TypeError('effect router execution manifest does not match loaded code');
    this.bound = true;
  }
  adapterIdentity(capability: CapabilityName): Readonly<{ id: string; digest: string; artifactDigest: string | null }> {
    const adapter = this.options.adapters.get(capability);
    if (!adapter) throw new Error(`no broker adapter for ${capability}`);
    return { id: adapter.id, digest: effectAdapterDigest(adapter), artifactDigest: admittedAdapterArtifactDigest(adapter) };
  }
  fork(): RuntimeEffectRouter {
    if (!this.options.isolatedFork) throw new Error('broker-backed fork requires an isolated effect router');
    const child = this.options.isolatedFork();
    if (child === this || child.mode === 'live') throw new Error('fork cannot reuse live effect authority');
    child.bind(this.root as NodeRef);
    return child;
  }
  invoke(capability: CapabilityName, args: readonly Value[]): Value {
    if (!this.bound) throw new Error('effect router is not bound to loaded code');
    const adapter = this.options.adapters.get(capability);
    if (!adapter) throw new Error(`no broker adapter for ${capability}`);
    const payload: TaggedValueV1 = { tag: 'sequence', items: [
      { tag: 'string', value: capability }, ...args.map(value => this.encode(value)),
    ] };
    validateTaggedValue(payload);
    const effectId = `operation-${this.sequence++}`;
    const outcome = this.options.broker.dispatch({
      format: 'aether.effect/1', executionId: this.options.executionId, effectId,
      branchId: this.options.branchId ?? null, executionManifest: this.manifestDigest,
      capabilityGrantRef: this.options.grant(capability), policyEpoch: this.options.policyEpoch,
      payloadDigest: effectPayloadDigest(payload), payload,
      budgetReservationId: this.options.reservation?.(capability, effectId) ?? null,
      deadline: this.options.deadline,
    }, adapter);
    if (outcome.state !== 'committed') throw new EffectInvocationError(outcome);
    return this.decode(outcome.value);
  }
  private encode(value: Value, depth = 0): TaggedValueV1 {
    if (depth > 64) throw new RangeError('effect argument nesting limit');
    if (value === null) return { tag: 'null' };
    if (typeof value === 'boolean') return { tag: 'bool', value };
    if (typeof value === 'bigint') return { tag: 'int', value: value.toString() };
    if (typeof value === 'string') return { tag: 'string', value };
    if (isClosureValue(value) || isTaskValue(value)) throw new TypeError('opaque execution state cannot be sent to an effect adapter');
    if (isRef(value)) {
      if (!this.options.references) throw new TypeError('effect reference requires explicit ownership translation');
      return { tag: 'ref', value: this.options.references.encode(value) };
    }
    if (isSeqValue(value)) return { tag: 'sequence', items: value.map(item => this.encode(item, depth + 1)) };
    if (isResultValue(value)) return { tag: 'result', variant: value.variant, value: this.encode(value.value, depth + 1) };
    throw new TypeError('unsupported runtime effect value');
  }
  private decode(value: TaggedValueV1): Value {
    validateTaggedValue(value);
    switch (value.tag) {
      case 'null': return null;
      case 'bool': case 'string': return value.value;
      case 'int': return BigInt(value.value);
      case 'sequence': return value.items.map(item => this.decode(item));
      case 'result': return { variant: value.variant, value: this.decode(value.value) };
      case 'ref':
        if (!this.options.references) throw new TypeError('effect reference requires explicit ownership translation');
        return this.options.references.decode(value.value);
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
