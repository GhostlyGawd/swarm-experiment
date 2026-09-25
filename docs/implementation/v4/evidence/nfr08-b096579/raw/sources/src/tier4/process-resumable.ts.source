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
import { underlying } from '../tier2/typecheck.ts';
import { validateMachineResult, instantiateMachineType } from '../tier3/resumable-types.ts';
import type { Value } from '../tier3/values.ts';
import { ResumableRuntime, type ResumableRuntimeOptions, type ResumableEffects, type ResumableRunResult } from '../tier3/resumable-runtime.ts';
import { packResumableCheckpoint, type PackedLayout } from '../tier3/packed-heap.ts';
import { PackedNativeProcessRunner, type PackedNativeRun } from './packed-native-process.ts';
import { checkpointDigest, machineClone, type ResumableSnapshot, type MachineValue, type MachineCore } from '../tier3/resumable-state.ts';
import { ProcessHost, type ProcessCheckpointAccess, type ProcessInvocationGrant } from './process-host.ts';
import { projectProcessCheckpoint, processReferenceFromCheckpoint, validateCheckpointControlRequest, type ProcessCheckpointBinding, type ProcessCheckpointReceipt, type ProcessCheckpointControlRequest, type ProcessCheckpointControl } from './process-checkpoint-contract.ts';

export interface ProcessResumableEffectsContext {
  readonly binding: ProcessCheckpointBinding;
  /** Authoritative private heap view under the exclusive lease, not the old
   * committed snapshot returned by ProcessHost.snapshot(). */
  readonly snapshot: () => RuntimeSnapshotV1;
}
export interface ProcessResumableOptions {
  readonly host: ProcessHost; readonly module: Term;
  readonly runtime: Omit<ResumableRuntimeOptions, 'executionId' | 'heapId' | 'ownerEpoch' | 'mode' | 'branchId' | 'capabilities' | 'effects' | 'onSafePoint' | 'fault' | 'authorizeCorrection' | 'authorizePackedCandidate'>;
  readonly tokens: () => readonly ProcessInvocationGrant[];
  /** Trusted native executor. The control request binds its exact admitted
   * artifact, executable bytes, source image and expected candidate digest. */
  readonly nativePacked?: PackedNativeProcessRunner;
  /** Trusted host adapter factory; use a broker namespace specific to binding.id. */
  readonly effects?: (context: ProcessResumableEffectsContext) => ResumableEffects;
  readonly onCheckpoint?: (checkpoint: ResumableSnapshot) => void;
}
function same(a: unknown, b: unknown): boolean { return Buffer.from(encodeCanonical(a)).equals(Buffer.from(encodeCanonical(b))); }
function replayState(core: MachineCore): unknown { const { steps: _steps, ...logical } = core; return logical; }
function checkReplayBarrier(current: ResumableSnapshot, barrier: ResumableSnapshot | null, events: readonly EffectEventV1[]): void {
  if (!barrier || BigInt(current.core.effectCursor) >= BigInt(barrier.core.effectCursor)) return;
  const index = Number(current.core.effectCursor), expected = barrier.core.effectPrefix[index], actual = events[index];
  if (!actual || !actual.outcome || actual.outcome.state === 'indeterminate' || actual.requestDigest !== expected.requestDigest || effectReplayOutcomeDigest(actual.outcome) !== expected.outcomeDigest) throw new Error('checkpoint replay debt lost its durable recorded outcome');
  const target = machineClone(barrier.core) as unknown as Record<string, unknown>;
  for (let position = barrier.events.length - 1; position >= 0; position--) {
    const event = barrier.events[position]; for (const delta of event.delta) target[delta.section] = machineClone(delta.before);
    if (event.effect?.request.effectId === `effect-${index}` && event.effect.outcome.state !== 'indeterminate') {
      if (!same(replayState(current.core), replayState(target as unknown as MachineCore))) throw new Error('checkpoint replay diverged before consuming recorded effects');
      return;
    }
  }
  throw new Error('checkpoint replay barrier lacks its historical instruction');
}
function correctionValue(value: TaggedValueV1): Value {
  if (value.tag === 'null') return null; if (value.tag === 'int') return BigInt(value.value); if (value.tag === 'string' || value.tag === 'bool') return value.value;
  if (value.tag === 'ref') return { addr: Number(value.value.objectId), heapId: value.value.heapId, ownerEpoch: value.value.ownerEpoch } as Value;
  throw new TypeError('unsupported process correction value');
}
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
    if (options.runtime.virtualForward) throw new TypeError('ProcessHost does not admit virtual forward descriptor profiles');
    preflight(options.module);
    const binding = await options.host.beginCheckpoint(base, initial, { ...request, tokens: options.tokens() });
    ProcessHost.prototype.assertCheckpointSemanticRetention.call(options.host, binding);
    return new ProcessResumableSession(binding, options);
  }
  static reopen(options: ProcessResumableOptions, bindingId: Digest): ProcessResumableSession {
    if (options.runtime.virtualForward) throw new TypeError('ProcessHost does not admit virtual forward descriptor profiles');
    preflight(options.module);
    const binding = options.host.checkpointStatus(bindingId).binding;
    ProcessHost.prototype.assertCheckpointSemanticRetention.call(options.host, binding);
    return new ProcessResumableSession(binding, options);
  }
  private assertRetention(): void {
    ProcessHost.prototype.assertCheckpointSemanticRetention.call(this.options.host, this.binding);
  }
  private resources(access: ProcessCheckpointAccess, snapshot: () => ResumableSnapshot): { effects: ResumableEffects | undefined; adapters: ReadonlyMap<CapabilityName, EffectAdapter> } {
    const original = this.options.effects?.({ binding: access.binding, snapshot: () => projectProcessCheckpoint(snapshot(), access.before, access.binding.generation, access.binding.unit) });
    if (!original) return { effects: undefined, adapters: new Map() };
    if (original.broker.executionMode !== 'live') throw new TypeError('production checkpoint lease needs a live authoritative broker');
    const adapters = new Map<CapabilityName, EffectAdapter>();
    for (const [capability, adapter] of original.adapters) {
      const id = domainDigest('aether.process-checkpoint-adapter/1', { binding: access.binding.id, capability, adapter: adapter.id, semantics: adapter.semantics });
      const request = (value: EffectRequestV1) => translateRequest(value, access.binding, snapshot());
      const dispatchAuthority = (): void => { access.assertAuthority(); if (access.replayBarrier && BigInt(snapshot().core.effectCursor) < BigInt(access.replayBarrier.core.effectCursor)) throw new Error('checkpoint replay debt cannot dispatch a live adapter'); };
      adapters.set(capability, {
        id, semantics: adapter.semantics,
        ...(adapter.execute ? { execute: (value: EffectRequestV1) => { dispatchAuthority(); return adapter.execute!(request(value)); } } : {}),
        ...(adapter.prepare ? { prepare: (value: EffectRequestV1) => { dispatchAuthority(); return adapter.prepare!(request(value)); } } : {}),
        ...(adapter.commit ? { commit: (value: EffectRequestV1, prepared: TaggedValueV1) => { dispatchAuthority(); return adapter.commit!(request(value), prepared); } } : {}),
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
    this.assertRetention();
    return this.options.host.withCheckpoint(this.binding.id, 'run', this.options.tokens(), async access => {
      let latest = access.checkpoint;
      const resources = this.resources(access, () => latest);
      if (access.replayBarrier) {
        const events = this.events(resources);
        for (const [index, expected] of access.replayBarrier.core.effectPrefix.entries()) {
          const actual = events[index];
          if (!actual?.outcome || actual.outcome.state === 'indeterminate' || actual.requestDigest !== expected.requestDigest || effectReplayOutcomeDigest(actual.outcome) !== expected.outcomeDigest) throw new Error('checkpoint replay debt lost its durable recorded outcome');
        }
      }
      const entry = access.program.codes.find(code => code.id === `function:${this.binding.symbol}`)!;
      const runtime = new ResumableRuntime(this.options.module, { ...this.options.runtime, executionId: latest.core.executionId, heapId: latest.core.heapId, ownerEpoch: latest.core.ownerEpoch, mode: 'live', branchId: null,
        effects: resources.effects, capabilities: () => { access.assertAuthority(); return entry.capabilities; },
        onSafePoint: (_event, machine) => { const checkpoint = machine.snapshot(); access.save(checkpoint); latest = checkpoint; this.options.onCheckpoint?.(machineClone(checkpoint)); access.assertAuthority(); },
        fault: point => { if (point === 'before-effect') { access.assertAuthority(); checkReplayBarrier(latest, access.replayBarrier, this.events(resources)); } },
      });
      if (runtime.program.digest !== access.program.digest) throw new TypeError('resumable bridge compiler/registry mismatch');
      runtime.restore(latest, checkpointDigest(latest));
      const result = runtime.run(maxInstructions); access.assertAuthority(); return result;
    });
  }
  async reconcile(): Promise<void> {
    this.assertRetention();
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
  /** Corrections are typed, explicitly authorized control operations. The
   * expected checkpoint and operation ID make retries safe across restart. */
  async correct(request: Exclude<ProcessCheckpointControlRequest, { kind: 'rewind' } | { kind: 'packed-v1' } | { kind: 'packed-v2' }>): Promise<ProcessCheckpointControl> { return this.control(request); }
  async correctPacked(request: Extract<ProcessCheckpointControlRequest, { kind: 'packed-v2' }>, layouts: readonly PackedLayout[]): Promise<ProcessCheckpointControl> {
    validateCheckpointControlRequest(request); request = machineClone(request); layouts = machineClone(layouts);
    if (!this.options.nativePacked) throw new TypeError('native packed executor is required');
    const identity = PackedNativeProcessRunner.identity(this.options.nativePacked);
    if (identity.artifactDigest !== request.artifactDigest || identity.executableSha256 !== request.executableSha256 ||
        identity.operationsDigest !== request.operationsDigest) throw new TypeError('native packed executor identity mismatch');
    if (await this.options.host.retainPackedLayout(this.binding.id, layouts, this.options.tokens()) !== request.layoutDigest) throw new TypeError('packed control layout identity mismatch');
    return this.control(request, layouts);
  }
  async rewind(request: Extract<ProcessCheckpointControlRequest, { kind: 'rewind' }>): Promise<ProcessCheckpointControl> { return this.control(request); }
  private async control(request: ProcessCheckpointControlRequest, packedLayouts?: readonly PackedLayout[]): Promise<ProcessCheckpointControl> {
    this.assertRetention();
    validateCheckpointControlRequest(request); request = machineClone(request);
    return this.options.host.withCheckpoint(this.binding.id, request.kind === 'rewind' ? 'rewind' : request.kind === 'packed-v1' || request.kind === 'packed-v2' ? 'packed' : 'correct', this.options.tokens(), async access => {
      if (access.controlReceipt) return access.controlReceipt;
      const snapshot = access.checkpoint, resources = this.resources(access, () => snapshot), events = this.events(resources);
      if (events.some(event => event.outcome === null || event.outcome.state === 'indeterminate')) throw new Error('checkpoint control requires reconciled effects');
      if (request.kind !== 'rewind') {
        if (snapshot.core.state !== 'running' || !snapshot.core.frames.length || snapshot.core.frames.some(frame => frame.pc >= access.program.codes.find(code => code.id === frame.code)!.returnPc)) throw new Error('checkpoint correction requires a running body before postcondition evaluation; rewind first');
      }
      if (request.kind !== 'rewind' && request.kind !== 'packed-v1' && request.kind !== 'packed-v2') {
        let type: Ty | undefined;
        if (request.kind === 'record') {
          const record = snapshot.core.records.find(row => row.id === request.reference.objectId && row.epoch === request.reference.ownerEpoch);
          const recordType = record?.ty ? underlying(record.ty) : undefined; type = recordType?.t === 'Record' ? recordType.fields.find(([field]) => field === request.field)?.[1] : undefined;
        } else {
          const frame = snapshot.core.frames.find(frame => frame.id === request.frameId); if (!frame) throw new TypeError('unknown correction frame');
          const symbol = request.symbol, code = access.program.codes.find(code => code.id === frame.code)!;
          type = code.params.find(param => param.symbol === symbol)?.ty;
          if (!type) {
            const witnesses: Ty[] = [];
            const visit = (term: Term): void => { if (term.kind === 'FunctionDecl' || term.kind === 'Lambda') { const param = term.params.find(param => param.symbol === symbol); if (param) witnesses.push(param.ty); } if (term.kind === 'Let' && term.symbol === symbol) witnesses.push(term.ty); children(term).forEach(visit); };
            const owner = this.options.module.kind === 'Module' ? this.options.module.members.find(term => term.kind === 'FunctionDecl' && term.symbol === code.symbol) : this.options.module;
            if (owner) visit(owner);
            if (witnesses.length && witnesses.every(witness => same(witness, witnesses[0]))) type = witnesses[0];
          }
          if (type) type = instantiateMachineType(type, frame.typeBindings);
        }
        if (!type) throw new TypeError('checkpoint correction requires an explicit declared type witness');
        validateMachineResult(type, request.value as MachineValue, snapshot.core, access.program);
      }
      const entry = access.program.codes.find(code => code.id === `function:${this.binding.symbol}`)!;
      const runtime = new ResumableRuntime(this.options.module, { ...this.options.runtime, executionId: snapshot.core.executionId, heapId: snapshot.core.heapId, ownerEpoch: snapshot.core.ownerEpoch, mode: 'live', branchId: null,
        capabilities: () => { access.assertAuthority(); return entry.capabilities; }, authorizeCorrection: () => { access.assertAuthority(); return true; },
        authorizePackedCandidate: (_snapshot, subject) => {
          access.assertAuthority();
          return request.kind === 'packed-v2' && subject.format === 'aether.packed-candidate-correction/2' &&
            subject.operationId === request.operationId && subject.artifactDigest === request.artifactDigest &&
            subject.executableSha256 === request.executableSha256 && subject.operationsDigest === request.operationsDigest &&
            subject.sourceSnapshotDigest === request.expectedCheckpoint &&
            subject.sourceImageDigest === request.sourceImageDigest && subject.candidateImageDigest === request.candidateImageDigest &&
            subject.layoutDigest === request.layoutDigest && request.artifactDigest === access.program.manifest.target.artifactDigest;
        } });
      if (runtime.program.digest !== access.program.digest) throw new TypeError('checkpoint control compiler mismatch');
      runtime.restore(snapshot, checkpointDigest(snapshot));
      let nativeRun: PackedNativeRun | undefined;
      if (request.kind === 'rewind') runtime.rewindRetainingHistory(request.steps);
      else if (request.kind === 'local') runtime.correctLocal(request.frameId, request.symbol, correctionValue(request.value));
      else if (request.kind === 'record') runtime.correctRecord({ addr: Number(request.reference.objectId), heapId: request.reference.heapId, ownerEpoch: request.reference.ownerEpoch } as Value & { addr: number }, request.field, correctionValue(request.value));
      else {
        const native = this.options.nativePacked;
        if (request.kind !== 'packed-v2' || !native || !packedLayouts)
          throw new TypeError('native packed executor identity mismatch');
        const source = packResumableCheckpoint(snapshot, access.program, packedLayouts);
        if (source.heap.layoutDigest !== request.layoutDigest || source.heap.imageDigest !== request.sourceImageDigest)
          throw new TypeError('native packed source identity mismatch');
        nativeRun = PackedNativeProcessRunner.executeVerified(native, source, request);
        const candidate = PackedNativeProcessRunner.assertRun(nativeRun, {
          operationId: request.operationId,
          expectedCheckpoint: request.expectedCheckpoint, sourceImageDigest: request.sourceImageDigest,
          candidateImageDigest: request.candidateImageDigest, layoutDigest: request.layoutDigest,
          artifactDigest: request.artifactDigest, executableSha256: request.executableSha256,
          operationsDigest: request.operationsDigest,
        });
        access.assertAuthority();
        runtime.commitPackedCandidate(source, candidate, request.expectedCheckpoint, request.layoutDigest, {
          operationId: request.operationId, artifactDigest: request.artifactDigest,
          executableSha256: request.executableSha256, operationsDigest: request.operationsDigest,
        });
      }
      access.assertAuthority(); return access.finishControl(runtime.snapshot(), events, nativeRun);
    }, request);
  }
  async commit(): Promise<ProcessCheckpointReceipt> {
    this.assertRetention();
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
    this.assertRetention();
    await this.options.host.withCheckpoint(this.binding.id, 'abort', [], async access => {
      const resources = this.resources(access, () => access.checkpoint);
      if (this.events(resources).some(event => event.dispatchStarted || event.outcome?.state === 'committed' || event.outcome?.state === 'indeterminate' || event.prepared !== null)) throw new Error('cannot abort checkpoint with possible external work');
      access.abort();
    });
  }
  /** A reference is reissued only against the committed lease's unchanged
   * ownership generation. Movement requires explicit fresh host handles. */
  async publishedReference(reference: LogicalRefV1): Promise<LogicalRefV1> {
    this.assertRetention();
    return this.options.host.checkpointReference(this.binding.id, reference, this.options.tokens());
  }
}
