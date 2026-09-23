import { types as nodeTypes } from 'node:util';
import type { Term, Ty } from '../tier1/ast.ts';
import type { CapabilityName, SymbolId } from '../tier1/ids.ts';
import { domainDigest, validateDigest, type Digest, type ExecutionManifestV1 } from '../fabric/identity.ts';
import { encodeCanonical, exactObject, identifier, validateTaggedValue, type TaggedValueV1 } from '../fabric/encoding.ts';
import { DurableEffectBroker, effectPayloadDigest, effectRequestDigest, effectReplayOutcomeDigest, type EffectAdapter, type EffectRequestV1 } from '../fabric/effects.ts';
import type { CapabilityRegistry } from '../tier2/ocap.ts';
import { underlying } from '../tier2/typecheck.ts';
import { isRef, isSeqValue, isResultValue, isTaskValue, isClosureValue, type Value, type Ref } from './values.ts';
import { validateMachineArguments, validateMachineResult, instantiateMachineType } from './resumable-types.ts';
import { compileResumableProgram, type ResumableCode, type ResumableProgram } from './resumable-program.ts';
import { PackedHeap, unpackResumableCheckpoint, type PackedHeapImage, type PackedResumableCheckpoint } from './packed-heap.ts';
import { MAX_MACHINE_EVENTS, MACHINE_LIMITS, checkpointDigest, emptyEventHead, eventDigest, machineClone, machineDigest, validateMachineCore, validateMachineValue, validateResumableSnapshot, type MachineCore, type MachineValue, type MachineFrame, type MachineEnvironment, type MachineCapture, type MachineEvent, type MachineSection, type ResumableSnapshot } from './resumable-state.ts';

const executionSnapshots = new WeakMap<object, { digest: Digest; origin: Digest; program: Digest }>();
/** Checkpoint-controller capability: JSON copies carry data, not evidence that
 * this engine advanced from the controller's current durable checkpoint. */
export function validateExecutedCheckpoint(snapshot: ResumableSnapshot, origin: Digest, program: Digest): void {
  const stamp = executionSnapshots.get(snapshot);
  if (!stamp || stamp.origin !== origin || stamp.program !== program || stamp.digest !== checkpointDigest(snapshot)) throw new TypeError('checkpoint was not produced by the authorized resumed execution');
}
export interface ResumableRef extends Ref { readonly heapId: string; readonly ownerEpoch: string }
export interface ResumableEffects {
  readonly broker: DurableEffectBroker;
  readonly adapters: ReadonlyMap<CapabilityName, EffectAdapter>;
  readonly policyEpoch: string;
  readonly deadline: string;
  readonly grant: (capability: CapabilityName) => string;
  readonly reservation?: (capability: CapabilityName, effectId: string) => string | null;
}
export interface ResumableRuntimeOptions {
  readonly manifest: ExecutionManifestV1; readonly registry: CapabilityRegistry; readonly executionId: string;
  readonly heapId?: string; readonly ownerEpoch?: string; readonly dependencies?: readonly Term[];
  readonly mode?: MachineCore['mode']; readonly branchId?: string | null;
  /** Trusted host resolves current authority; checkpoint bytes only request names. */
  readonly capabilities?: () => readonly CapabilityName[];
  readonly effects?: ResumableEffects;
  readonly maxSteps?: number;
  /** Optional host quota, bounded by the versioned 64 MiB checkpoint profile. */
  readonly maxCheckpointBytes?: number;
  readonly onSafePoint?: (event: MachineEvent, runtime: ResumableRuntime) => void;
  readonly authorizeCorrection?: (snapshot: ResumableSnapshot) => boolean;
  /** Separate authority for one exact native candidate, bound to the current
   * checkpoint, program, layout and candidate image digests. */
  readonly authorizePackedCandidate?: (snapshot: ResumableSnapshot, subject: PackedCandidateSubject) => boolean;
  readonly fault?: (point: 'before-effect' | 'after-effect' | 'before-instruction-commit' | 'after-instruction-commit') => void;
}
interface PackedCandidateSubjectBase {
  readonly sourceSnapshotDigest: Digest;
  readonly sourceImageDigest: Digest;
  readonly candidateImageDigest: Digest;
  readonly layoutDigest: Digest;
  readonly programDigest: Digest;
  readonly manifestDigest: Digest;
  readonly changesDigest: Digest;
}
export interface PackedCandidateNativeBinding {
  readonly operationId: string; readonly artifactDigest: Digest;
  readonly executableSha256: string; readonly operationsDigest: Digest;
}
export type PackedCandidateSubject = PackedCandidateSubjectBase & (
  {readonly format: 'aether.packed-candidate-correction/1'} |
  {readonly format: 'aether.packed-candidate-correction/2'} & PackedCandidateNativeBinding);
export type ResumableRunResult = { readonly state: MachineCore['state']; readonly value: MachineValue | null; readonly fault: MachineCore['fault']; readonly steps: number };
class MachineFault extends Error { readonly kind: string; readonly recoveryId: string | null; constructor(kind: string, message: string, recoveryId: string | null = null) { super(message); this.kind = kind; this.recoveryId = recoveryId; } }
const nil = (): MachineValue => ({ tag: 'null' });
const integer = (value: bigint | number): MachineValue => ({ tag: 'int', value: String(value) });
const boolean = (value: boolean): MachineValue => ({ tag: 'bool', value });
const int = (value: MachineValue): bigint => { if (value.tag !== 'int') throw new MachineFault('type_error', 'expected integer register'); return BigInt(value.value); };
const bool = (value: MachineValue): boolean => { if (value.tag !== 'bool') throw new MachineFault('type_error', 'expected Boolean register'); return value.value; };
const text = (value: MachineValue): string => { if (value.tag !== 'string') throw new MachineFault('type_error', 'expected string register'); return value.value; };
const equalBytes = (a: unknown, b: unknown): boolean => Buffer.from(encodeCanonical(a, MACHINE_LIMITS)).equals(Buffer.from(encodeCanonical(b, MACHINE_LIMITS)));

export class ResumableRuntime {
  readonly program: ResumableProgram;
  private readonly options: ResumableRuntimeOptions;
  private readonly codes: Map<string, ResumableCode>;
  private core: MachineCore;
  private events: MachineEvent[] = [];
  private executing = false;
  private mutating = false;
  private eventEffect: MachineEvent['effect'] = null;
  private readonly checkpointBytes: number;
  private restoredOrigin: Digest;
  private snapshotFormat: ResumableSnapshot['format'] = 'aether.resumable-state/1';
  constructor(module: Term, options: ResumableRuntimeOptions) {
    this.program = compileResumableProgram(module, options); this.options = options;
    this.checkpointBytes = options.maxCheckpointBytes ?? MACHINE_LIMITS.maxFrameBytes;
    if (options.maxSteps !== undefined && (!Number.isSafeInteger(options.maxSteps) || options.maxSteps < 1 || options.maxSteps > 100_000)) throw new TypeError('invalid resumable step quota');
    if (!Number.isSafeInteger(this.checkpointBytes) || this.checkpointBytes < 4096 || this.checkpointBytes > MACHINE_LIMITS.maxFrameBytes) throw new TypeError('invalid checkpoint byte quota');
    this.codes = new Map(this.program.codes.map(code => [code.id, code]));
    const mode = options.mode ?? 'live';
    if (options.effects && options.effects.broker.executionMode !== mode) throw new TypeError('resumable effect broker mode mismatch');
    this.core = { format: 'aether.resumable-core/1', executionManifest: this.program.manifestDigest, programDigest: this.program.digest, profileDigest: this.program.profileDigest,
      executionId: options.executionId, heapId: options.heapId ?? `heap:${options.executionId}`, ownerEpoch: options.ownerEpoch ?? '0', mode, branchId: options.branchId ?? null,
      steps: 0, effectCursor: '0', effectPrefix: [], isolatedEffects: [], state: 'idle', result: null, fault: null,
      nextRecord: '1', nextEnvironment: '1', nextHeapVersion: '1', nextSequence: '1', nextResult: '1', nextClosure: '1', nextTask: '1', nextFrame: '1',
      records: [], environments: [], heaps: [], sequences: [], results: [], closures: [], tasks: [], frames: [], atomics: [],
    };
    validateMachineCore(this.core, this.program);
    this.restoredOrigin = checkpointDigest({ format: 'aether.resumable-state/1', core: this.core, eventCursor: '0', eventHead: emptyEventHead(), events: [] });
  }
  private next(field: 'nextRecord' | 'nextEnvironment' | 'nextHeapVersion' | 'nextSequence' | 'nextResult' | 'nextClosure' | 'nextTask' | 'nextFrame'): string { const id = this.core[field]; this.core[field] = String(BigInt(id) + 1n); return id; }
  private code(frame: MachineFrame): ResumableCode { const code = this.codes.get(frame.code); if (!code) throw new TypeError('missing bound bytecode'); return code; }
  private environment(id: string): MachineEnvironment { const env = this.core.environments.find(item => item.id === id); if (!env) throw new TypeError('missing lexical environment'); return env; }
  private newEnvironment(bindings: [string, MachineValue][] = []): string { const id = this.next('nextEnvironment'); this.core.environments.push({ id, bindings: machineClone(bindings) }); return id; }
  private heapVersion(): string { const id = this.next('nextHeapVersion'); this.core.heaps.push({ id, records: machineClone(this.core.records) }); return id; }
  private copyScopes(scopes: readonly string[]): string[] { return scopes.map(id => this.newEnvironment(this.environment(id).bindings)); }
  private lookup(frame: MachineFrame, symbol: string, old: boolean): MachineValue {
    if (old) { const entry = this.environment(frame.oldScope).bindings.find(([name]) => name === symbol); if (entry) return entry[1]; }
    for (const id of [...frame.scopes].reverse()) { const item = this.environment(id).bindings.find(([name]) => name === symbol); if (item) return item[1]; }
    throw new MachineFault('unbound', `unbound scalar ${symbol}`);
  }
  private set(frame: MachineFrame, symbol: string, value: MachineValue, declaration = false): void {
    const scopes = declaration ? [frame.scopes.at(-1)!] : [...frame.scopes].reverse();
    for (const id of scopes) { const env = this.environment(id), entry = env.bindings.find(([name]) => name === symbol); if (entry) { entry[1] = value; return; } }
    if (!declaration) throw new MachineFault('unbound', `assignment to unbound ${symbol}`);
    this.environment(frame.scopes.at(-1)!).bindings.push([symbol, value]);
  }
  private record(value: MachineValue, frame?: MachineFrame, old = false) {
    if (value.tag !== 'ref' || value.value.heapId !== this.core.heapId) throw new MachineFault('type_error', 'wrong or stale record reference');
    const records = old ? this.core.heaps.find(heap => heap.id === frame!.oldHeap)?.records : this.core.records;
    const row = records?.find(record => record.id === value.value.objectId); if (!row || row.epoch !== value.value.ownerEpoch) throw new MachineFault('type_error', 'dangling or stale record reference'); return row;
  }
  private allocationEpoch(id: string, fields: readonly [string, MachineValue][]): string {
    const { mode: _mode, steps: _steps, fault: _fault, state: _state, effectPrefix: _receipts, isolatedEffects: _drafts, ...logicalState } = this.core;
    const digest = domainDigest('aether.resumable-allocation/1', { program: this.program.digest, fields, execution: this.core.executionId, heap: this.core.heapId, heapEpoch: this.core.ownerEpoch, branch: this.core.branchId, logicalState, id }, MACHINE_LIMITS);
    return BigInt(`0x${digest.split(':').at(-1)!}`).toString();
  }
  private hostReference(reference: Ref): MachineValue {
    const ref = reference as Partial<ResumableRef>;
    if (ref.heapId !== this.core.heapId || typeof ref.ownerEpoch !== 'string' || !Number.isSafeInteger(ref.addr) || ref.addr! < 1) throw new TypeError('resumable host reference requires heap and allocation epoch');
    const value: MachineValue = { tag: 'ref', value: { heapId: ref.heapId, objectId: String(ref.addr), ownerEpoch: ref.ownerEpoch } }; this.record(value); return value;
  }
  private sequence(value: MachineValue): MachineValue[] { if (value.tag !== 'sequence') throw new MachineFault('type_error', 'expected sequence'); const row = this.core.sequences.find(item => item.id === value.id); if (!row) throw new TypeError('missing sequence'); return row.items; }
  private newSequence(items: MachineValue[]): MachineValue { const id = this.next('nextSequence'); this.core.sequences.push({ id, items }); return { tag: 'sequence', id }; }
  private newResult(variant: 'ok' | 'err', value: MachineValue): MachineValue { const id = this.next('nextResult'); this.core.results.push({ id, variant, value }); return { tag: 'result', id }; }
  private resultValue(value: MachineValue) { if (value.tag !== 'result') throw new MachineFault('type_error', 'expected Result'); const row = this.core.results.find(item => item.id === value.id); if (!row) throw new TypeError('missing Result'); return row; }
  private currentCapabilities(required: readonly CapabilityName[]): CapabilityName[] {
    const current = this.options.capabilities?.() ?? [];
    if (!Array.isArray(current) || current.length > 4096) throw new TypeError('host capabilities must be a canonical array');
    encodeCanonical(current);
    if (new Set(current).size !== current.length || current.some(cap => typeof cap !== 'string' || !/^cap:[a-z0-9_]+:[a-z0-9_]+$/.test(cap))) throw new TypeError('host capabilities must be unique canonical identifiers');
    if (required.some(cap => !current.includes(cap))) throw new MachineFault('capability_revoked', 'host did not grant current resumable authority');
    return [...required];
  }
  private checkAuthority(): void { for (const frame of this.core.frames) this.currentCapabilities(frame.capabilities); }
  private enter(code: ResumableCode, args: MachineValue[], caller?: MachineFrame, capture?: MachineCapture, task: string | null = null): void {
    if (args.length !== code.params.length) throw new MachineFault('type_error', 'resumable call arity mismatch');
    if (caller && code.capabilities.some(cap => !caller.capabilities.includes(cap))) throw new MachineFault('capability_denied', 'call would amplify capabilities');
    const capabilities = this.currentCapabilities(capture?.capabilities ?? code.capabilities);
    const typeBindings = validateMachineArguments(code, args, this.core, this.program, capture?.typeBindings ?? []);
    const bindings: [string, MachineValue][] = code.params.map((param, index) => [param.symbol, args[index]]);
    for (const surface of code.surfaces) bindings.push([surface.symbol, machineClone(surface.value) as MachineValue]);
    const parameters = this.newEnvironment(bindings), scopes = capture ? [...this.copyScopes(capture.scopes), parameters] : [parameters];
    const oldScope = capture && code.kind === 'task' ? capture.oldScope : this.newEnvironment(bindings);
    const oldHeap = capture?.oldHeap ?? this.heapVersion();
    const frame: MachineFrame = { id: this.next('nextFrame'), code: code.id, pc: 0, scopes, baseScopes: scopes.length, oldScope, oldHeap, capabilities, typeBindings,
      stack: [], registers: [], result: null, task };
    this.core.frames.push(frame);
  }
  private event(before: MachineCore, code: string, pc: number, op: string): MachineEvent {
    if (this.events.length >= MAX_MACHINE_EVENTS) throw new RangeError('resumable event history limit');
    const delta = (Object.keys(before) as MachineSection[]).filter(section => !equalBytes(before[section], this.core[section])).map(section => ({ section, before: machineClone(before[section]), after: machineClone(this.core[section]) }));
    const event: MachineEvent = { format: 'aether.resumable-event/1', sequence: String(this.events.length + 1), previous: this.events.length ? eventDigest(this.events.at(-1)!) : emptyEventHead(), before: machineDigest(before), after: machineDigest(this.core), code, pc, op, effect: this.eventEffect === null ? null : machineClone(this.eventEffect), delta };
    const proposed: ResumableSnapshot = { format: this.snapshotFormat, core: this.core, eventCursor: event.sequence, eventHead: eventDigest(event), events: [...this.events, event] };
    encodeCanonical(proposed, { ...MACHINE_LIMITS, maxFrameBytes: this.checkpointBytes, maxDecompressedBytes: this.checkpointBytes });
    this.events.push(event); this.eventEffect = null; return event;
  }
  /** Host values enter once, preserving array/result alias identity across args. */
  private importValue(value: Value, memo = new Map<object, MachineValue>(), depth = 0): MachineValue {
    if (depth > 64) throw new RangeError('host value depth limit');
    if (value === null) return nil(); if (typeof value === 'bigint') return integer(value); if (typeof value === 'boolean') return boolean(value); if (typeof value === 'string') return { tag: 'string', value };
    if (!value || typeof value !== 'object' || nodeTypes.isProxy(value)) throw new TypeError('opaque host value');
    if (Array.isArray(value)) {
      if (Object.keys(value).length !== value.length || Reflect.ownKeys(value).length !== value.length + 1 || Array.from({ length: value.length }, (_, index) => Object.getOwnPropertyDescriptor(value, String(index))).some(descriptor => !descriptor || !('value' in descriptor))) throw new TypeError('invalid host value array');
    } else { const keys = Object.keys(value); exactObject(value, keys); }
    const prior = memo.get(value); if (prior) return prior;
    if (isRef(value)) return this.hostReference(value);
    if (isClosureValue(value) || isTaskValue(value)) throw new TypeError('opaque host closures/tasks cannot install resumed execution');
    if (isSeqValue(value)) { const result = this.newSequence([]); memo.set(value, result); this.sequence(result).push(...value.map(item => this.importValue(item, memo, depth + 1))); return result; }
    if (isResultValue(value)) { const result = this.newResult(value.variant, nil()); memo.set(value, result); this.resultValue(result).value = this.importValue(value.value, memo, depth + 1); return result; }
    throw new TypeError('unsupported host value');
  }
  decodeValue(value: MachineValue, memo = new Map<string, Value>()): Value {
    validateMachineValue(value);
    switch (value.tag) {
      case 'null': return null; case 'int': return BigInt(value.value); case 'bool': case 'string': return value.value;
      case 'ref': this.record(value); return { addr: Number(value.value.objectId), heapId: value.value.heapId, ownerEpoch: value.value.ownerEpoch } as ResumableRef;
      case 'sequence': { const key = `sequence:${value.id}`, prior = memo.get(key); if (prior) return prior; const result: Value[] = []; memo.set(key, result); result.push(...this.sequence(value).map(item => this.decodeValue(item, memo))); return result; }
      case 'result': { const key = `result:${value.id}`, prior = memo.get(key); if (prior) return prior; const item = this.resultValue(value), result = { variant: item.variant, value: null as Value }; memo.set(key, result); result.value = this.decodeValue(item.value, memo); return result; }
      default: throw new TypeError('inspect resumable closures/tasks through their explicit tables');
    }
  }
  allocateRecord(ty: Ty, fields: Readonly<Record<string, Value>>): ResumableRef {
    if (this.executing || this.core.state === 'running' || this.core.state === 'blocked') throw new Error('host allocation requires an idle safe point');
    return this.hostMutation('allocate', () => {
      const type = underlying(ty); if (type.t !== 'Record') throw new TypeError('record type required');
      const names = type.fields.map(([name]) => name);
      if (nodeTypes.isProxy(fields)) throw new TypeError('opaque allocation fields');
      exactObject(fields, names);
      const id = this.next('nextRecord'), memo = new Map<object, MachineValue>();
      const row = { id, version: '0', epoch: '0', ty: type as Ty | null, fields: [] as [string, MachineValue][] }; this.core.records.push(row);
      row.fields = type.fields.map(([name]) => [name, this.importValue(Object.hasOwn(fields, name) ? fields[name] : null, memo)]);
      row.epoch = this.allocationEpoch(id, row.fields);
      validateMachineResult(type, { tag: 'ref', value: { heapId: this.core.heapId, objectId: id, ownerEpoch: row.epoch } }, this.core, this.program);
      return { addr: Number(id), heapId: this.core.heapId, ownerEpoch: row.epoch };
    });
  }
  private hostMutation<T>(op: string, action: () => T): T {
    if (this.mutating || this.executing) throw new Error('reentrant host state mutation');
    const before = machineClone(this.core), count = this.events.length; this.mutating = true;
    try { const result = action(); validateMachineCore(this.core, this.program); this.event(before, 'host', 0, op); return result; }
    catch (error) { this.core = before; this.events.length = count; this.eventEffect = null; throw error; } finally { this.mutating = false; }
  }
  /** Reclaim unreachable capture/register objects after unwinding a fault. Heap
   * records remain allocated; only an enclosing Atomic may roll those back. */
  private pruneCaptures(): void {
    const environments = new Set<string>(), heaps = new Set<string>(), sequences = new Set<string>(), results = new Set<string>(), closures = new Set<string>(), tasks = new Set<string>();
    const pending: MachineValue[] = this.core.records.flatMap(record => record.fields.map(([, value]) => value));
    if (this.core.result !== null) pending.push(this.core.result);
    const scope = (id: string): void => { if (environments.has(id)) return; environments.add(id); const env = this.core.environments.find(row => row.id === id); if (!env) throw new TypeError('missing retained environment'); pending.push(...env.bindings.map(([, value]) => value)); };
    const heap = (id: string): void => { if (heaps.has(id)) return; heaps.add(id); const version = this.core.heaps.find(row => row.id === id); if (!version) throw new TypeError('missing retained heap version'); pending.push(...version.records.flatMap(row => row.fields.map(([, value]) => value))); };
    const capture = (value: MachineCapture): void => { value.scopes.forEach(scope); scope(value.oldScope); heap(value.oldHeap); };
    for (const frame of this.core.frames) { capture(frame); pending.push(...frame.stack, ...frame.registers.map(([, value]) => value)); if (frame.result !== null) pending.push(frame.result); }
    while (pending.length) {
      const value = pending.pop()!;
      if (value.tag === 'sequence' && !sequences.has(value.id)) { sequences.add(value.id); pending.push(...this.sequence(value)); }
      else if (value.tag === 'result' && !results.has(value.id)) { results.add(value.id); pending.push(this.resultValue(value).value); }
      else if (value.tag === 'closure' && !closures.has(value.id)) { closures.add(value.id); capture(this.core.closures.find(row => row.id === value.id)!); }
      else if (value.tag === 'task' && !tasks.has(value.id)) { tasks.add(value.id); const task = this.core.tasks.find(row => row.id === value.id)!; capture(task); if (task.result !== null) pending.push(task.result); }
    }
    this.core.environments = this.core.environments.filter(row => environments.has(row.id)); this.core.heaps = this.core.heaps.filter(row => heaps.has(row.id));
    this.core.sequences = this.core.sequences.filter(row => sequences.has(row.id)); this.core.results = this.core.results.filter(row => results.has(row.id));
    this.core.closures = this.core.closures.filter(row => closures.has(row.id)); this.core.tasks = this.core.tasks.filter(row => tasks.has(row.id));
  }
  readRecord(reference: Ref): ReadonlyMap<string, Value> { const record = this.record(this.hostReference(reference)); const memo = new Map<string, Value>(); return new Map(record.fields.map(([name, value]) => [name, this.decodeValue(value, memo)])); }
  start(symbol: SymbolId, args: readonly Value[]): void {
    if (this.executing || this.core.frames.length || this.core.state === 'running' || this.core.state === 'blocked') throw new Error('resumable execution already active');
    const code = this.codes.get(`function:${symbol}`); if (!code) throw new TypeError('unknown resumable entry');
    const before = machineClone(this.core), memo = new Map<object, MachineValue>();
    this.core.state = 'running'; this.core.result = null; this.core.fault = null;
    try { this.enter(code, args.map(value => this.importValue(value, memo))); validateMachineCore(this.core, this.program); this.event(before, code.id, 0, 'start'); }
    catch (error) { this.core = before; throw error; }
  }
  private encodeEffect(value: MachineValue, active = new Set<string>(), depth = 0): TaggedValueV1 {
    if (depth > 64) throw new RangeError('effect value depth limit');
    if (value.tag === 'null' || value.tag === 'int' || value.tag === 'bool' || value.tag === 'string' || value.tag === 'ref') return value;
    if (value.tag === 'closure' || value.tag === 'task') throw new TypeError('resumable execution objects cannot be effect payloads');
    const key = `${value.tag}:${value.id}`; if (active.has(key)) throw new TypeError('cyclic effect container'); active.add(key);
    try { if (value.tag === 'sequence') return { tag: 'sequence', items: this.sequence(value).map(item => this.encodeEffect(item, active, depth + 1)) }; const result = this.resultValue(value); return { tag: 'result', variant: result.variant, value: this.encodeEffect(result.value, active, depth + 1) }; }
    finally { active.delete(key); }
  }
  private decodeEffect(value: TaggedValueV1): MachineValue {
    validateTaggedValue(value);
    if (value.tag === 'sequence') return this.newSequence(value.items.map(item => this.decodeEffect(item)));
    if (value.tag === 'result') return this.newResult(value.variant, this.decodeEffect(value.value));
    if (value.tag === 'authority') throw new TypeError('effect cannot install machine authority');
    if (value.tag === 'ref') this.record(value); return machineClone(value);
  }
  private effect(frame: MachineFrame, capability: CapabilityName, args: MachineValue[]): MachineValue {
    const effects = this.options.effects;
    if (!frame.capabilities.includes(capability)) throw new MachineFault('capability_denied', 'effect outside frame envelope');
    this.currentCapabilities([capability]); if (!effects) throw new MachineFault('capability_denied', 'no trusted effect broker');
    const adapter = effects.adapters.get(capability); if (!adapter) throw new MachineFault('capability_denied', 'no effect adapter');
    const effectId = `effect-${this.core.effectCursor}`;
    const payload: TaggedValueV1 = { tag: 'sequence', items: [{ tag: 'string', value: capability }, ...args.map(value => this.encodeEffect(value))] };
    const request: EffectRequestV1 = { format: 'aether.effect/1', executionId: this.core.executionId, effectId, branchId: this.core.branchId, executionManifest: this.core.executionManifest,
      capabilityGrantRef: effects.grant(capability), policyEpoch: effects.policyEpoch, payloadDigest: effectPayloadDigest(payload), payload,
      budgetReservationId: effects.reservation?.(capability, effectId) ?? null, deadline: effects.deadline };
    const checkedAdapter: EffectAdapter = {
      ...adapter,
      ...(adapter.execute ? { execute: (input: EffectRequestV1) => { this.currentCapabilities([capability]); return adapter.execute!(input); } } : {}),
      ...(adapter.prepare ? { prepare: (input: EffectRequestV1) => { this.currentCapabilities([capability]); return adapter.prepare!(input); } } : {}),
      ...(adapter.commit ? { commit: (input: EffectRequestV1, prepared: TaggedValueV1) => { this.currentCapabilities([capability]); return adapter.commit!(input, prepared); } } : {}),
    };
    this.options.fault?.('before-effect'); this.currentCapabilities([capability]);
    const source = effects.broker.executionMode === 'live' ? 'live' : effects.broker.replayRemaining > 0 ? 'recorded' : 'isolated';
    const outcome = effects.broker.dispatch(request, checkedAdapter); this.eventEffect = { source, request, outcome }; this.options.fault?.('after-effect');
    if (outcome.state === 'indeterminate') throw new MachineFault('effect_indeterminate', 'effect disposition requires broker reconciliation', outcome.recoveryId);
    if (source === 'isolated') this.core.isolatedEffects.push({ request: machineClone(request), outcome: machineClone(outcome) });
    else this.core.effectPrefix.push({ requestDigest: effectRequestDigest(request), outcomeDigest: effectReplayOutcomeDigest(outcome) });
    this.core.effectCursor = String(BigInt(this.core.effectCursor) + 1n);
    if (outcome.state !== 'committed') throw new MachineFault(`effect_${outcome.state}`, outcome.code);
    this.currentCapabilities([capability]);
    if (outcome.value.tag !== 'null') throw new MachineFault('type_error', 'Invoke result violates its Unit return contract');
    return this.decodeEffect(outcome.value);
  }
  private fixed(value: bigint, ty: Extract<Ty, { t: 'IntN' }>): bigint {
    const width = 1n << BigInt(ty.bits), min = ty.signed ? -(1n << BigInt(ty.bits - 1)) : 0n, max = ty.signed ? (1n << BigInt(ty.bits - 1)) - 1n : width - 1n;
    if (value >= min && value <= max) return value;
    if (ty.overflow === 'trap') throw new MachineFault('type_error', 'fixed-width arithmetic overflow'); if (ty.overflow === 'saturate') return value < min ? min : max;
    return ((value - min) % width + width) % width + min;
  }
  private binary(op: string, a: MachineValue, b: MachineValue): MachineValue {
    if (op === 'eq' || op === 'ne') { const same = a.tag === b.tag && (a.tag === 'ref' && b.tag === 'ref' ? a.value.heapId === b.value.heapId && a.value.objectId === b.value.objectId : equalBytes(a, b)); return boolean(op === 'eq' ? same : !same); }
    if (op === 'concat') return { tag: 'string', value: text(a) + text(b) };
    const left = int(a), right = int(b);
    switch (op) {
      case 'add': return integer(left + right); case 'sub': return integer(left - right); case 'mul': return integer(left * right);
      case 'div': case 'mod': if (right === 0n) throw new MachineFault('division_by_zero', 'integer division by zero'); return integer(op === 'div' ? left / right : left % right);
      case 'lt': return boolean(left < right); case 'le': return boolean(left <= right); case 'gt': return boolean(left > right); case 'ge': return boolean(left >= right);
      default: throw new TypeError('unknown bound binary operator');
    }
  }
  private instruction(frame: MachineFrame): void {
    const instruction = this.code(frame).instructions[frame.pc], [a, b] = instruction.args;
    const pop = (): MachineValue => { const value = frame.stack.pop(); if (!value) throw new TypeError('resumable register underflow'); return value; };
    const take = (count: number): MachineValue[] => { if (count < 0 || frame.stack.length < count) throw new TypeError('resumable argument register underflow'); return frame.stack.splice(frame.stack.length - count, count); };
    frame.pc++;
    switch (instruction.op) {
      case 'literal': frame.stack.push(machineClone(a) as MachineValue); return;
      case 'load': frame.stack.push(this.lookup(frame, a as string, b as boolean)); return;
      case 'result': frame.stack.push(frame.result ?? nil()); return;
      case 'field': { const row = this.record(pop(), frame, b as boolean), field = row.fields.find(([name]) => name === a); if (!field) throw new MachineFault('type_error', 'missing record field'); frame.stack.push(field[1]); return; }
      case 'unary': { const value = pop(); frame.stack.push(a === 'not' ? boolean(!bool(value)) : integer(-int(value))); return; }
      case 'binary': { const right = pop(), left = pop(); frame.stack.push(this.binary(a as string, left, right)); return; }
      case 'duplicate': { const value = pop(); frame.stack.push(value, value); return; }
      case 'discard': pop(); return;
      case 'jump': frame.pc = a as number; return;
      case 'jump-false': if (!bool(pop())) frame.pc = a as number; return;
      case 'jump-true': if (bool(pop())) frame.pc = a as number; return;
      case 'scope-enter': frame.scopes.push(this.newEnvironment()); return;
      case 'scope-exit': if (frame.scopes.length <= frame.baseScopes) throw new TypeError('resumable scope underflow'); frame.scopes.pop(); return;
      case 'let': this.set(frame, a as string, pop(), true); return;
      case 'assign-local': this.set(frame, a as string, pop()); return;
      case 'assign-field': { const value = pop(), row = this.record(pop()), field = row.fields.find(([name]) => name === a); if (!field) throw new MachineFault('type_error', 'missing assigned record field'); field[1] = value; row.version = String(BigInt(row.version) + 1n); return; }
      case 'temp-store': { const value = pop(), register = frame.registers.find(([name]) => name === a); if (register) register[1] = value; else frame.registers.push([a as string, value]); return; }
      case 'temp-load': { const register = frame.registers.find(([name]) => name === a); if (!register) throw new TypeError('missing resumable register'); frame.stack.push(register[1]); return; }
      case 'record': { const fields = a as string[], values = take(fields.length), id = this.next('nextRecord'); const entries: [string, MachineValue][] = fields.map((name, index) => [name, values[index]]); const epoch = this.allocationEpoch(id, entries), ty = instantiateMachineType(b as unknown as Ty, frame.typeBindings); this.core.records.push({ id, version: '0', epoch, ty, fields: entries }); frame.stack.push({ tag: 'ref', value: { heapId: this.core.heapId, objectId: id, ownerEpoch: epoch } }); return; }
      case 'sequence': frame.stack.push(this.newSequence(take(a as number))); return;
      case 'sequence-length': frame.stack.push(integer(this.sequence(pop()).length)); return;
      case 'sequence-index': { const index = int(pop()), values = this.sequence(pop()); if (index < 0n || index >= BigInt(values.length)) throw new MachineFault('type_error', 'sequence index out of bounds'); frame.stack.push(values[Number(index)]); return; }
      case 'sequence-append-reverse': { const values = this.sequence(pop()), value = pop(); frame.stack.push(this.newSequence([...values, value])); return; }
      case 'result-wrap': frame.stack.push(this.newResult(a as 'ok' | 'err', pop())); return;
      case 'result-is-ok': frame.stack.push(boolean(this.resultValue(pop()).variant === 'ok')); return;
      case 'result-value': frame.stack.push(this.resultValue(pop()).value); return;
      case 'closure': {
        const code = this.codes.get(a as string)!; const id = this.next('nextClosure');
        this.core.closures.push({ id, code: code.id, scopes: this.copyScopes(frame.scopes), oldHeap: this.heapVersion(), oldScope: this.newEnvironment(), capabilities: code.capabilities.filter(cap => frame.capabilities.includes(cap)), typeBindings: machineClone(frame.typeBindings) });
        frame.stack.push({ tag: 'closure', id }); return;
      }
      case 'spawn': {
        const id = this.next('nextTask'); this.core.tasks.push({ id, code: a as string, scopes: this.copyScopes(frame.scopes), oldHeap: frame.oldHeap, oldScope: frame.oldScope, capabilities: [...frame.capabilities], typeBindings: machineClone(frame.typeBindings), state: 'pending', result: null });
        frame.stack.push({ tag: 'task', id }); return;
      }
      case 'call': { const code = this.codes.get(`function:${a}`); if (!code) throw new MachineFault('unbound', 'missing resumable function'); this.enter(code, take(b as number), frame); return; }
      case 'apply': {
        const args = take(a as number), value = pop(); if (value.tag !== 'closure') throw new MachineFault('type_error', 'apply needs closure');
        const closure = this.core.closures.find(item => item.id === value.id)!; this.enter(this.codes.get(closure.code)!, args, frame, closure); return;
      }
      case 'await': {
        const value = pop(); if (value.tag !== 'task') throw new MachineFault('type_error', 'await needs task'); const task = this.core.tasks.find(item => item.id === value.id)!;
        if (task.state === 'completed') { frame.stack.push(task.result!); return; }
        if (task.state === 'running') throw new MachineFault('task_cycle', 'task cannot await its own unfinished execution');
        task.state = 'running'; this.enter(this.codes.get(task.code)!, [], frame, task, task.id); return;
      }
      case 'effect': { const args = take(b as number); frame.stack.push(this.effect(frame, a as CapabilityName, args)); return; }
      case 'assert': if (!bool(pop())) throw new MachineFault(a as string, `${String(a)} ${String(b)} failed`); return;
      case 'begin-return': frame.result = pop(); frame.scopes.length = frame.baseScopes; frame.stack.length = 0; this.core.atomics = this.core.atomics.filter(atomic => atomic.frame !== frame.id); frame.pc = a as number; return;
      case 'return': {
        const result = frame.result ?? nil(); try { validateMachineResult(this.code(frame).returns, result, this.core, this.program, frame.typeBindings); } catch (error) { throw new MachineFault('type_error', String(error)); } if (this.core.frames.pop() !== frame) throw new TypeError('return stack mismatch');
        if (frame.task !== null) { const task = this.core.tasks.find(item => item.id === frame.task)!; task.state = 'completed'; task.result = result; }
        const parent = this.core.frames.at(-1); if (parent) parent.stack.push(result); else { this.core.state = 'completed'; this.core.result = result; }
        return;
      }
      case 'atomic-enter': this.core.atomics.push({ frame: frame.id, records: machineClone(this.core.records), environments: machineClone(this.core.environments), nextRecord: this.core.nextRecord }); return;
      case 'atomic-exit': { const atomic = this.core.atomics.pop(); if (!atomic || atomic.frame !== frame.id) throw new TypeError('atomic stack mismatch'); return; }
      case 'yield': return;
      case 'fixed': { const ty = b as unknown as Extract<Ty, { t: 'IntN' }>; if (a === 'cast') frame.stack.push(integer(this.fixed(int(pop()), ty))); else { const right = pop(), left = pop(); frame.stack.push(integer(this.fixed(int(this.binary(a as string, left, right)), ty))); } return; }
      case 'string': {
        const args = take(b as number), value = text(args[0]);
        if (a === 'strlen') frame.stack.push(integer([...value].length));
        else if (a === 'contains') frame.stack.push(boolean(value.includes(text(args[1]))));
        else if (a === 'slice') frame.stack.push({ tag: 'string', value: [...value].slice(Number(int(args[1])), Number(int(args[2]))).join('') });
        else frame.stack.push({ tag: 'string', value: a === 'lower' ? value.toLowerCase() : a === 'upper' ? value.toUpperCase() : value.trim() });
        return;
      }
      default: throw new TypeError(`unknown bytecode operation ${instruction.op}`);
    }
  }
  step(): ResumableRunResult {
    if (this.executing) throw new Error('reentrant resumable execution');
    if (this.core.state !== 'running') return this.result();
    if (this.core.steps >= (this.options.maxSteps ?? 100_000)) throw new RangeError('resumable instruction budget exceeded');
    if (this.events.length >= MAX_MACHINE_EVENTS) throw new RangeError('resumable event history limit');
    this.checkAuthority();
    const before = machineClone(this.core), frame = this.core.frames.at(-1)!, code = frame.code, pc = frame.pc, op = this.code(frame).instructions[pc].op;
    this.executing = true; this.eventEffect = null; let committed = false;
    try {
      try { this.instruction(frame); }
      catch (error) {
        if (!(error instanceof MachineFault)) { this.core = before; throw error; }
        if (error.kind === 'effect_indeterminate') { this.core = machineClone(before); this.core.state = 'blocked'; }
        else {
          for (const atomic of [...this.core.atomics].reverse()) { this.core.records = machineClone(atomic.records); this.core.environments = machineClone(atomic.environments); this.core.nextRecord = atomic.nextRecord; }
          this.core.atomics = []; this.core.frames = []; this.core.state = 'faulted';
          for (const task of this.core.tasks) if (task.state === 'running') { task.state = 'pending'; task.result = null; }
          this.pruneCaptures();
        }
        this.core.fault = { kind: error.kind, message: error.message, recoveryId: error.recoveryId };
      }
      this.core.steps++; validateMachineCore(this.core, this.program); this.options.fault?.('before-instruction-commit');
      const event = this.event(before, code, pc, op); committed = true; this.options.fault?.('after-instruction-commit');
      this.executing = false; this.options.onSafePoint?.(machineClone(event), this); return this.result();
    } catch (error) { if (!committed) { this.core = before; this.eventEffect = null; } throw error; } finally { this.executing = false; }
  }
  run(maxInstructions = 100_000): ResumableRunResult { if (!Number.isSafeInteger(maxInstructions) || maxInstructions < 0) throw new TypeError('invalid instruction slice'); for (let index = 0; index < maxInstructions && this.core.state === 'running'; index++) this.step(); return this.result(); }
  inspect(): Readonly<MachineCore> { return machineClone(this.core); }
  result(): ResumableRunResult { return machineClone({ state: this.core.state, value: this.core.result, fault: this.core.fault, steps: this.core.steps }); }
  snapshot(): ResumableSnapshot {
    if (this.executing) throw new Error('checkpoint requires an instruction safe point');
    const snapshot: ResumableSnapshot = { format: this.snapshotFormat, core: machineClone(this.core), eventCursor: String(this.events.length), eventHead: this.events.length ? eventDigest(this.events.at(-1)!) : emptyEventHead(), events: machineClone(this.events) };
    encodeCanonical(snapshot, { ...MACHINE_LIMITS, maxFrameBytes: this.checkpointBytes, maxDecompressedBytes: this.checkpointBytes });
    validateResumableSnapshot(snapshot, this.program);
    executionSnapshots.set(snapshot, { digest: checkpointDigest(snapshot), origin: this.restoredOrigin, program: this.program.digest }); return snapshot;
  }
  restore(snapshot: ResumableSnapshot, expectedDigest: Digest): void {
    if (this.executing) throw new Error('restore requires a safe point');
    encodeCanonical(snapshot, { ...MACHINE_LIMITS, maxFrameBytes: this.checkpointBytes, maxDecompressedBytes: this.checkpointBytes });
    validateResumableSnapshot(snapshot, this.program);
    if (snapshot.core.steps > (this.options.maxSteps ?? 100_000)) throw new RangeError('checkpoint exceeds current step quota');
    if (checkpointDigest(snapshot) !== expectedDigest) throw new TypeError('trusted checkpoint digest mismatch');
    if (snapshot.core.executionId !== this.options.executionId || snapshot.core.heapId !== (this.options.heapId ?? `heap:${this.options.executionId}`) || snapshot.core.ownerEpoch !== (this.options.ownerEpoch ?? '0') || snapshot.core.mode !== (this.options.mode ?? 'live') || snapshot.core.branchId !== (this.options.branchId ?? null)) throw new TypeError('checkpoint run/heap/ownership/mode binding mismatch');
    for (const frame of snapshot.core.frames) this.currentCapabilities(frame.capabilities);
    if (this.options.effects && this.options.effects.broker.executionMode !== 'live') {
      if (snapshot.core.isolatedEffects.length && this.options.effects.broker.recordedEventCount !== snapshot.core.effectPrefix.length) throw new TypeError('isolated checkpoint recorded trace changed');
      this.options.effects.broker.restoreIsolatedState({ prefix: snapshot.core.effectPrefix, bufferedIntents: snapshot.core.isolatedEffects.filter(item => item.outcome.state === 'rejected' && item.outcome.code === 'isolated_intent_buffered').map(item => item.request) });
    }
    this.core = machineClone(snapshot.core); this.events = machineClone(snapshot.events); this.restoredOrigin = expectedDigest; this.snapshotFormat = snapshot.format;
  }
  rewind(steps: number): void {
    if (this.executing || !Number.isSafeInteger(steps) || steps < 0 || steps > this.events.length) throw new RangeError('invalid rewind distance');
    const snapshot = this.snapshot();
    for (let index = 0; index < steps; index++) { const event = snapshot.events.pop()!; for (const delta of event.delta) (snapshot.core as unknown as Record<string, unknown>)[delta.section] = machineClone(delta.before); }
    snapshot.eventCursor = String(snapshot.events.length); snapshot.eventHead = snapshot.events.length ? eventDigest(snapshot.events.at(-1)!) : emptyEventHead();
    this.restore(snapshot, checkpointDigest(snapshot));
  }
  /** Version 2 preserves the discarded future and records the exact inverse
   * transition. Live sinks remain owned by the durable broker, never rewound. */
  rewindRetainingHistory(steps: number): void {
    if (this.executing || !Number.isSafeInteger(steps) || steps < 1 || steps > this.events.length) throw new RangeError('invalid retained rewind distance');
    const snapshot = this.snapshot();
    if (this.options.authorizeCorrection?.(snapshot) !== true) throw new Error('host did not authorize state correction');
    const target = machineClone(this.core) as unknown as Record<string, unknown>;
    for (let index = this.events.length - 1; index >= this.events.length - steps; index--) for (const delta of this.events[index].delta) target[delta.section] = machineClone(delta.before);
    validateMachineCore(target, this.program);
    for (const frame of (target as unknown as MachineCore).frames) this.currentCapabilities(frame.capabilities);
    if (this.options.effects && this.options.effects.broker.executionMode !== 'live') throw new Error('retained rewind requires a live broker or an effect-free runtime');
    const priorFormat = this.snapshotFormat; this.snapshotFormat = 'aether.resumable-state/2';
    try { this.hostMutation(`rewind-v1:${steps}`, () => { this.core = target as unknown as MachineCore; }); }
    catch (error) { this.snapshotFormat = priorFormat; throw error; }
  }
  retryBlocked(): void {
    if (this.core.state !== 'blocked' || this.executing) throw new Error('no blocked effect at a safe point');
    this.checkAuthority(); this.hostMutation('retry-reconciled-effect', () => { this.core.state = 'running'; this.core.fault = null; });
  }
  correctLocal(frameId: string, symbol: SymbolId, value: Value): void {
    const snapshot = this.snapshot(); if (this.options.authorizeCorrection?.(snapshot) !== true) throw new Error('host did not authorize state correction');
    this.hostMutation('correction', () => {
      const frame = this.core.frames.find(item => item.id === frameId); if (!frame) throw new TypeError('unknown corrected frame');
      this.lookup(frame, symbol, false); this.set(frame, symbol, this.importValue(value));
    });
  }
  correctRecord(reference: Ref, field: string, value: Value): void {
    const snapshot = this.snapshot(); if (this.options.authorizeCorrection?.(snapshot) !== true) throw new Error('host did not authorize state correction');
    this.hostMutation('correction', () => {
      const row = this.record(this.hostReference(reference)), entry = row.fields.find(([name]) => name === field);
      if (!entry) throw new TypeError('unknown corrected field'); entry[1] = this.importValue(value); row.version = String(BigInt(row.version) + 1n);
    });
  }
  /** Commit a native candidate as one host correction event after validating
   * its exact source and obtaining candidate-specific trusted authorization.
   * Candidate bytes alone never become an event-bound checkpoint. */
  commitPackedCandidate(sourceInput: PackedResumableCheckpoint, candidateInput: PackedHeapImage,
    expectedSourceDigest: Digest, expectedLayoutDigest: Digest, nativeInput?: PackedCandidateNativeBinding): {
      readonly subjectDigest: Digest; readonly snapshotDigest: Digest; readonly eventCursor: string; readonly changedFields: number
    } {
    const source = machineClone(sourceInput), candidate = machineClone(candidateInput), native = nativeInput === undefined ? undefined : machineClone(nativeInput);
    if (native) {
      exactObject(native, ['operationId', 'artifactDigest', 'executableSha256', 'operationsDigest']); identifier(native.operationId);
      validateDigest(native.artifactDigest); validateDigest(native.operationsDigest, 'aether.packed-native-operations/1');
      if (!/^sha256:[0-9a-f]{64}$/.test(native.executableSha256) || native.artifactDigest !== this.program.manifest.target.artifactDigest)
        throw new TypeError('invalid native packed correction binding');
    }
    const original = unpackResumableCheckpoint(source, this.program, expectedSourceDigest, expectedLayoutDigest);
    const current = this.snapshot();
    if (checkpointDigest(current) !== expectedSourceDigest || !equalBytes(current, original)) throw new TypeError('stale packed candidate source checkpoint');
    if (current.core.state === 'blocked') throw new TypeError('packed candidate cannot bypass blocked effect reconciliation');
    const heap = PackedHeap.fromImage(candidate, expectedLayoutDigest);
    const sameHeader = (image: PackedHeapImage) => ({ format: image.format, heapId: image.heapId,
      layouts: image.layouts, layoutDigest: image.layoutDigest, rows: image.rows });
    if (!equalBytes(sameHeader(source.heap), sameHeader(candidate))) throw new TypeError('native candidate changed packed layout or logical row identity');
    const records = heap.unpack(), changes: { row: number; field: number; value: MachineValue }[] = [];
    for (let row = 0; row < records.length; row++) {
      const before = original.core.records[row], after = records[row];
      if (!before || !after || before.fields.length !== after.fields.length) throw new TypeError('native candidate row shape changed');
      for (let field = 0; field < before.fields.length; field++) {
        if (before.fields[field][0] !== after.fields[field][0]) throw new TypeError('native candidate field shape changed');
        if (!equalBytes(before.fields[field][1], after.fields[field][1])) changes.push({ row, field, value: after.fields[field][1] });
      }
    }
    const version = native ? '2' : '1';
    const subject = Object.freeze({format: `aether.packed-candidate-correction/${version}`,
      sourceSnapshotDigest: expectedSourceDigest, sourceImageDigest: source.heap.imageDigest,
      candidateImageDigest: candidate.imageDigest, layoutDigest: expectedLayoutDigest,
      programDigest: this.program.digest, manifestDigest: this.program.manifestDigest,
      changesDigest: domainDigest('aether.packed-candidate-changes/1', changes, MACHINE_LIMITS), ...native }) as PackedCandidateSubject;
    const subjectDigest = domainDigest(`aether.packed-candidate-correction/${version}`, subject, MACHINE_LIMITS);
    if (this.options.authorizeCorrection?.(current) !== true || this.options.authorizePackedCandidate?.(current, subject) !== true)
      throw new Error('host did not authorize packed candidate correction');
    if (checkpointDigest(this.snapshot()) !== expectedSourceDigest) throw new TypeError('packed candidate source changed during authorization');
    if (changes.length) this.hostMutation(`${native ? 'packed-correction-v2' : 'packed-correction'}:${subjectDigest}`, () => {
      const touched = new Set<number>();
      for (const change of changes) {
        const row = this.core.records[change.row], expected = original.core.records[change.row];
        if (!row || row.id !== expected.id || row.epoch !== expected.epoch) throw new TypeError('packed candidate row changed during commit');
        row.fields[change.field][1] = machineClone(change.value);
        touched.add(change.row);
      }
      for (const index of touched) this.core.records[index].version = String(BigInt(this.core.records[index].version) + 1n);
      for (const index of touched) {
        const row = this.core.records[index];
        if (row.ty === null) throw new TypeError('packed candidate requires typed record');
        validateMachineResult(row.ty, { tag: 'ref', value: { heapId: this.core.heapId, objectId: row.id, ownerEpoch: row.epoch } }, this.core, this.program);
      }
      const repacked = PackedHeap.pack(this.core.records, this.core.heapId, candidate.layouts).image();
      if (repacked.bytes !== candidate.bytes || repacked.stringBytes !== candidate.stringBytes ||
          !equalBytes(repacked.stringEntries ?? [], candidate.stringEntries ?? [])) throw new TypeError('native candidate did not map to corrected logical state');
    });
    const committed = this.snapshot();
    return { subjectDigest, snapshotDigest: checkpointDigest(committed), eventCursor: committed.eventCursor, changedFields: changes.length };
  }
}
