/** Durable, explicitly authorized checkpoint transactions over ProcessHost.
 * This is a single execution-unit backend: the full resumable continuation is
 * retained, while only a lossless scalar/reference C1 heap is published to the
 * existing process workers. It does not install JS frames into those workers. */
import type { Term, Ty } from '../tier1/ast.ts';
import { children } from '../tier1/ast.ts';
import type { CapabilityName, SymbolId } from '../tier1/ids.ts';
import { encodeCanonical, type LogicalRefV1, type TaggedValueV1 } from '../fabric/encoding.ts';
import { domainDigest, type Digest } from '../fabric/identity.ts';
import { runtimeSnapshotDigest, type RuntimeSnapshotV1 } from '../fabric/snapshot.ts';
import { effectPayloadDigest, effectReplayOutcomeDigest, type EffectAdapter, type EffectEventV1, type EffectRequestV1 } from '../fabric/effects.ts';
import type { CapabilityToken } from '../tier2/ocap.ts';
import { ResumableRuntime, type ResumableRuntimeOptions, type ResumableEffects, type ResumableRunResult } from '../tier3/resumable-runtime.ts';
import { checkpointDigest, machineClone, type ResumableSnapshot } from '../tier3/resumable-state.ts';
import type { ProcessHost, ProcessCheckpointAccess } from './process-host.ts';
import { projectProcessCheckpoint, processReferenceFromCheckpoint, type ProcessCheckpointBinding, type ProcessCheckpointReceipt } from './process-checkpoint-contract.ts';

export interface ProcessResumableEffectsContext {
  readonly binding: ProcessCheckpointBinding;
  /** Authoritative private heap view under the exclusive lease, not the old
   * committed snapshot returned by ProcessHost.snapshot(). */
  readonly snapshot: () => RuntimeSnapshotV1;
}
export interface ProcessResumableOptions {
  readonly host: ProcessHost; readonly module: Term;
  readonly runtime: Omit<ResumableRuntimeOptions, 'executionId' | 'heapId' | 'ownerEpoch' | 'mode' | 'branchId' | 'capabilities' | 'effects' | 'onSafePoint' | 'fault' | 'authorizeCorrection'>;
  readonly tokens: () => readonly CapabilityToken[];
  /** Trusted host adapter factory; use a broker namespace specific to binding.id. */
  readonly effects?: (context: ProcessResumableEffectsContext) => ResumableEffects;
  readonly onCheckpoint?: (checkpoint: ResumableSnapshot) => void;
}
function same(a: unknown, b: unknown): boolean { return Buffer.from(encodeCanonical(a)).equals(Buffer.from(encodeCanonical(b))); }
function heapType(type: Ty): void {
  if (type.t === 'Nominal') return heapType(type.repr);
  if (type.t === 'Owned') return heapType(type.inner);
  if (type.t === 'Record') { type.fields.forEach(([, type]) => heapType(type)); return; }
  if (!['Int', 'IntN', 'Bool', 'Str', 'Unit'].includes(type.t)) throw new TypeError('process checkpoint heap types must preserve scalar/reference identity');
}
function preflight(module: Term): void {
  const types = (type: Ty): void => {
    if (type.t === 'Record') { heapType(type); return; }
    if (type.t === 'Nominal') types(type.repr); else if (type.t === 'Owned') types(type.inner); else if (type.t === 'Seq') types(type.element); else if (type.t === 'Result') { types(type.ok); types(type.err); } else if (type.t === 'Task') types(type.result); else if (type.t === 'Fn') { type.params.forEach(types); types(type.returns); }
  };
  const walk = (term: Term): void => { if ('ty' in term) types(term.ty); if (term.kind === 'FunctionDecl' || term.kind === 'Lambda') { term.params.forEach(param => types(param.ty)); types(term.returns); } children(term).forEach(walk); };
  walk(module);
}
function translateRequest(request: EffectRequestV1, binding: ProcessCheckpointBinding, snapshot: ResumableSnapshot): EffectRequestV1 {
  const translate = (value: TaggedValueV1): TaggedValueV1 => {
    if (value.tag === 'ref') return { tag: 'ref', value: processReferenceFromCheckpoint(value.value, snapshot, binding.generation) };
    if (value.tag === 'sequence') return { tag: 'sequence', items: value.items.map(translate) };
    if (value.tag === 'result') return { ...value, value: translate(value.value) };
    if (value.tag === 'authority') throw new TypeError('checkpoint effects cannot install authority'); return value;
  };
  if (request.executionId !== binding.executionId || request.executionManifest !== snapshot.core.executionManifest || request.branchId !== null) throw new TypeError('foreign checkpoint effect request');
  const payload = translate(request.payload);
  return { ...request, executionId: domainDigest('aether.process-checkpoint-execution/1', { binding: binding.id, executionId: binding.executionId }), payload, payloadDigest: effectPayloadDigest(payload) };
}
export class ProcessResumableSession {
  readonly binding: ProcessCheckpointBinding;
  private readonly options: ProcessResumableOptions;
  private constructor(binding: ProcessCheckpointBinding, options: ProcessResumableOptions) { this.binding = machineClone(binding); this.options = options; }
  static async begin(options: ProcessResumableOptions, base: ResumableSnapshot, initial: ResumableSnapshot, request: { operationId: string; symbol: SymbolId; expectedSnapshot: Digest; expectedGeneration: string }): Promise<ProcessResumableSession> {
    preflight(options.module);
    const binding = await options.host.beginCheckpoint(base, initial, { ...request, tokens: options.tokens() }); return new ProcessResumableSession(binding, options);
  }
  static reopen(options: ProcessResumableOptions, bindingId: Digest): ProcessResumableSession { preflight(options.module); return new ProcessResumableSession(options.host.checkpointStatus(bindingId).binding, options); }
  private resources(access: ProcessCheckpointAccess, snapshot: () => ResumableSnapshot): { effects: ResumableEffects | undefined; adapters: ReadonlyMap<CapabilityName, EffectAdapter> } {
    const original = this.options.effects?.({ binding: access.binding, snapshot: () => projectProcessCheckpoint(snapshot(), access.before, access.binding.generation, access.binding.unit) });
    if (!original) return { effects: undefined, adapters: new Map() };
    if (original.broker.executionMode !== 'live') throw new TypeError('production checkpoint lease needs a live authoritative broker');
    const adapters = new Map<CapabilityName, EffectAdapter>();
    for (const [capability, adapter] of original.adapters) {
      const id = domainDigest('aether.process-checkpoint-adapter/1', { binding: access.binding.id, capability, adapter: adapter.id, semantics: adapter.semantics });
      const request = (value: EffectRequestV1) => translateRequest(value, access.binding, snapshot());
      adapters.set(capability, {
        id, semantics: adapter.semantics,
        ...(adapter.execute ? { execute: (value: EffectRequestV1) => { access.assertAuthority(); return adapter.execute!(request(value)); } } : {}),
        ...(adapter.prepare ? { prepare: (value: EffectRequestV1) => { access.assertAuthority(); return adapter.prepare!(request(value)); } } : {}),
        ...(adapter.commit ? { commit: (value: EffectRequestV1, prepared: TaggedValueV1) => { access.assertAuthority(); return adapter.commit!(request(value), prepared); } } : {}),
        ...(adapter.abort ? { abort: (value: EffectRequestV1, prepared: TaggedValueV1 | null) => { access.assertAuthority(); return adapter.abort!(request(value), prepared); } } : {}),
        ...(adapter.reconcile ? { reconcile: (value: EffectRequestV1, prepared: TaggedValueV1 | null) => { access.assertAuthority(); return adapter.reconcile!(request(value), prepared); } } : {}),
      });
    }
    return { effects: { ...original, adapters }, adapters };
  }
  private events(resources: ReturnType<ProcessResumableSession['resources']>): readonly EffectEventV1[] {
    const events = resources.effects?.broker.events().filter(event => event.request.executionId === this.binding.executionId) ?? [];
    const ids = new Set([...resources.adapters.values()].map(adapter => adapter.id));
    if (events.some(event => !ids.has(event.adapterId))) throw new TypeError('checkpoint broker contains a foreign adapter/execution history');
    return events;
  }
  async run(maxInstructions = 100_000): Promise<ResumableRunResult> {
    return this.options.host.withCheckpoint(this.binding.id, 'run', this.options.tokens(), async access => {
      let latest = access.checkpoint;
      const resources = this.resources(access, () => latest);
      const entry = access.program.codes.find(code => code.id === `function:${this.binding.symbol}`)!;
      const runtime = new ResumableRuntime(this.options.module, { ...this.options.runtime, executionId: latest.core.executionId, heapId: latest.core.heapId, ownerEpoch: latest.core.ownerEpoch, mode: 'live', branchId: null,
        effects: resources.effects, capabilities: () => { access.assertAuthority(); return entry.capabilities; },
        onSafePoint: (_event, machine) => { const checkpoint = machine.snapshot(); access.save(checkpoint); latest = checkpoint; this.options.onCheckpoint?.(machineClone(checkpoint)); access.assertAuthority(); },
        fault: point => { if (point === 'before-effect') { access.assertAuthority(); this.events(resources); } },
      });
      if (runtime.program.digest !== access.program.digest) throw new TypeError('resumable bridge compiler/registry mismatch');
      runtime.restore(latest, checkpointDigest(latest));
      const result = runtime.run(maxInstructions); access.assertAuthority(); return result;
    });
  }
  async reconcile(): Promise<void> {
    await this.options.host.withCheckpoint(this.binding.id, 'reconcile', [], async access => {
      let latest = access.checkpoint; const resources = this.resources(access, () => latest); if (!resources.effects) throw new Error('no checkpoint effect broker');
      resources.effects.broker.recoverDeadWriter();
      for (const event of this.events(resources)) if (event.outcome === null || event.outcome.state === 'indeterminate') {
        const adapter = [...resources.adapters.values()].find(adapter => adapter.id === event.adapterId)!;
        const outcome = resources.effects.broker.reconcile(event.request, adapter); if (outcome.state === 'indeterminate') throw new Error('checkpoint external effect remains indeterminate');
      }
      access.assertAuthority();
      if (latest.core.state === 'blocked') {
        const entry = access.program.codes.find(code => code.id === `function:${this.binding.symbol}`)!;
        const runtime = new ResumableRuntime(this.options.module, { ...this.options.runtime, executionId: latest.core.executionId, heapId: latest.core.heapId, ownerEpoch: latest.core.ownerEpoch, mode: 'live', branchId: null,
          effects: resources.effects, capabilities: () => { access.assertAuthority(); return entry.capabilities; } });
        runtime.restore(latest, checkpointDigest(latest)); runtime.retryBlocked(); latest = runtime.snapshot(); access.save(latest);
      }
    });
  }
  async commit(): Promise<ProcessCheckpointReceipt> {
    const existing = this.options.host.checkpointReceipt(this.binding.id, this.options.tokens()); if (existing) return existing;
    return this.options.host.withCheckpoint(this.binding.id, 'commit', this.options.tokens(), async access => {
      const checkpoint = access.checkpoint, resources = this.resources(access, () => checkpoint), events = this.events(resources);
      if (events.some(event => event.outcome === null || event.outcome.state === 'indeterminate')) throw new Error('checkpoint cannot publish unresolved effects');
      const prefix = events.map(event => ({ requestDigest: event.requestDigest, outcomeDigest: effectReplayOutcomeDigest(event.outcome!) }));
      if (!same(prefix, checkpoint.core.effectPrefix)) throw new Error('checkpoint does not account for every durable external outcome');
      // A C1 reference exported to a sink must not later alias a recycled
      // allocation. Refuse publication if rollback removed/replaced one.
      for (const event of events) if (event.outcome?.state === 'committed') translateRequest(event.request, access.binding, checkpoint);
      access.assertAuthority(); return access.commit(checkpoint, events);
    });
  }
  async abort(): Promise<void> {
    await this.options.host.withCheckpoint(this.binding.id, 'abort', [], async access => {
      const resources = this.resources(access, () => access.checkpoint);
      if (this.events(resources).some(event => event.dispatchStarted || event.outcome?.state === 'committed' || event.outcome?.state === 'indeterminate' || event.prepared !== null)) throw new Error('cannot abort checkpoint with possible external work');
      access.abort();
    });
  }
  /** A reference is reissued only against the committed lease's unchanged
   * ownership generation. Movement requires explicit fresh host handles. */
  async publishedReference(reference: LogicalRefV1): Promise<LogicalRefV1> {
    return this.options.host.checkpointReference(this.binding.id, reference, this.options.tokens());
  }
}
