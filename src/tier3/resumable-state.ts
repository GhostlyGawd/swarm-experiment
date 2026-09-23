import type { Ty } from '../tier1/ast.ts';
import { validateMachineType, validateMachineTypeBindings, type MachineTypeBindings } from './resumable-types.ts';
import { decodeCanonical, encodeCanonical, exactObject, identifier, decimal, validateLogicalRef, type LogicalRefV1 } from '../fabric/encoding.ts';
import { domainDigest, validateDigest, type Digest } from '../fabric/identity.ts';
import type { CapabilityName, SymbolId } from '../tier1/ids.ts';
import { effectRequestDigest, effectReplayOutcomeDigest, validateEffectRequest, type EffectRequestV1, type EffectOutcome, type EffectReplayPrefixEntry } from '../fabric/effects.ts';
import type { ResumableProgram } from './resumable-program.ts';

/** Composite values have explicit table identities. Sequence/result identity,
 * closure captures and task aliasing therefore survive checkpoints as well as
 * record references. These are v2 machine tags, not a mutation of TaggedValueV1. */
export type MachineValue =
  | { tag: 'null' } | { tag: 'bool'; value: boolean } | { tag: 'int'; value: string } | { tag: 'string'; value: string }
  | { tag: 'ref'; value: LogicalRefV1 }
  | { tag: 'sequence' | 'result' | 'closure' | 'task'; id: string };
export interface MachineRecord { id: string; version: string; epoch: string; ty: Ty | null; fields: [string, MachineValue][] }
export interface MachineEnvironment { id: string; bindings: [string, MachineValue][] }
export interface MachineHeapVersion { id: string; records: MachineRecord[] }
export interface MachineCapture { code: string; scopes: string[]; oldScope: string; oldHeap: string; capabilities: CapabilityName[]; typeBindings: MachineTypeBindings }
export interface MachineClosure extends MachineCapture { id: string }
export interface MachineTask extends MachineCapture { id: string; state: 'pending' | 'running' | 'completed'; result: MachineValue | null }
export interface MachineFrame {
  id: string; code: string; pc: number; scopes: string[]; baseScopes: number;
  oldScope: string; oldHeap: string; capabilities: CapabilityName[]; typeBindings: MachineTypeBindings;
  stack: MachineValue[]; registers: [string, MachineValue][]; result: MachineValue | null;
  task: string | null;
}
export interface MachineAtomic { frame: string; records: MachineRecord[]; environments: MachineEnvironment[]; nextRecord: string }
export interface MachineCore {
  format: 'aether.resumable-core/1'; executionManifest: Digest; programDigest: Digest; profileDigest: Digest;
  executionId: string; heapId: string; ownerEpoch: string;
  mode: 'live' | 'shadow' | 'speculative' | 'replay'; branchId: string | null;
  steps: number; effectCursor: string; effectPrefix: EffectReplayPrefixEntry[]; isolatedEffects: { request: EffectRequestV1; outcome: EffectOutcome }[]; state: 'idle' | 'running' | 'completed' | 'faulted' | 'blocked';
  result: MachineValue | null; fault: { kind: string; message: string; recoveryId: string | null } | null;
  nextRecord: string; nextEnvironment: string; nextHeapVersion: string; nextSequence: string; nextResult: string; nextClosure: string; nextTask: string; nextFrame: string;
  records: MachineRecord[]; environments: MachineEnvironment[]; heaps: MachineHeapVersion[];
  sequences: { id: string; items: MachineValue[] }[];
  results: { id: string; variant: 'ok' | 'err'; value: MachineValue }[];
  closures: MachineClosure[]; tasks: MachineTask[]; frames: MachineFrame[]; atomics: MachineAtomic[];
}
export type MachineSection = keyof MachineCore;
export interface MachineDelta { section: MachineSection; before: unknown; after: unknown }
export interface MachineEvent {
  format: 'aether.resumable-event/1'; sequence: string; previous: Digest; before: Digest; after: Digest;
  code: string; pc: number; op: string; effect: { source: 'live' | 'recorded' | 'isolated'; request: EffectRequestV1; outcome: EffectOutcome } | null; delta: MachineDelta[];
}
export interface ResumableSnapshot {
  format: 'aether.resumable-state/1'; core: MachineCore; eventCursor: string; eventHead: Digest; events: MachineEvent[];
}
export const MACHINE_LIMITS = Object.freeze({ maxFrameBytes: 64 * 1024 * 1024, maxDecompressedBytes: 64 * 1024 * 1024, maxObjects: 2_000_000, maxDepth: 128, maxIntegerDigits: 4096 });
export const MAX_MACHINE_ROWS = 20_000;
export const MAX_MACHINE_EVENTS = 4096;
export const emptyEventHead = (): Digest => domainDigest('aether.resumable-events/1', { prefix: [] });
export const machineDigest = (core: MachineCore): Digest => domainDigest('aether.resumable-core/1', core, MACHINE_LIMITS);
export const eventDigest = (event: MachineEvent): Digest => domainDigest('aether.resumable-event/1', event, MACHINE_LIMITS);
export const checkpointDigest = (snapshot: ResumableSnapshot): Digest => domainDigest('aether.resumable-state/1', snapshot, MACHINE_LIMITS);
export const machineClone = <T>(value: T): T => decodeCanonical(encodeCanonical(value, MACHINE_LIMITS), MACHINE_LIMITS) as T;
export function validateMachineValue(value: unknown): asserts value is MachineValue {
  if (!value || typeof value !== 'object') throw new TypeError('invalid machine value');
  const tag = (value as MachineValue).tag;
  if (tag === 'null') { exactObject(value, ['tag']); return; }
  if (tag === 'sequence' || tag === 'result' || tag === 'closure' || tag === 'task') { const item = exactObject(value, ['tag', 'id']); decimal(item.id); if (item.id === '0') throw new TypeError('invalid machine object ID'); return; }
  const item = exactObject(value, ['tag', 'value']);
  if (tag === 'int') { decimal(item.value, MACHINE_LIMITS, true); return; }
  if (tag === 'string') { if (typeof item.value !== 'string') throw new TypeError('invalid machine string'); return; }
  if (tag === 'bool') { if (typeof item.value !== 'boolean') throw new TypeError('invalid machine boolean'); return; }
  if (tag === 'ref') { validateLogicalRef(item.value); return; }
  throw new TypeError('unknown machine value tag');
}
const fields = Object.freeze(['format', 'executionManifest', 'programDigest', 'profileDigest', 'executionId', 'heapId', 'ownerEpoch', 'mode', 'branchId', 'steps', 'effectCursor', 'effectPrefix', 'isolatedEffects', 'state', 'result', 'fault', 'nextRecord', 'nextEnvironment', 'nextHeapVersion', 'nextSequence', 'nextResult', 'nextClosure', 'nextTask', 'nextFrame', 'records', 'environments', 'heaps', 'sequences', 'results', 'closures', 'tasks', 'frames', 'atomics']);
export function validateMachineCore(value: unknown, program: ResumableProgram): asserts value is MachineCore {
  encodeCanonical(value, MACHINE_LIMITS); const core = exactObject(value, fields) as unknown as MachineCore;
  if (core.format !== 'aether.resumable-core/1' || core.executionManifest !== program.manifestDigest || core.programDigest !== program.digest || core.profileDigest !== program.profileDigest) throw new TypeError('checkpoint code/manifest/profile mismatch');
  identifier(core.executionId); identifier(core.heapId); decimal(core.ownerEpoch); decimal(core.effectCursor);
  if (!Array.isArray(core.effectPrefix) || !Array.isArray(core.isolatedEffects) || core.effectCursor !== String(core.effectPrefix.length + core.isolatedEffects.length)) throw new TypeError('checkpoint effect cursor/prefix mismatch');
  const requests = new Set<string>();
  for (const entry of core.effectPrefix) { exactObject(entry, ['requestDigest', 'outcomeDigest']); validateDigest(entry.requestDigest, 'aether.effect/1'); validateDigest(entry.outcomeDigest, 'aether.effect-replay-outcome/1'); if (requests.has(entry.requestDigest)) throw new TypeError('duplicate checkpoint effect prefix'); requests.add(entry.requestDigest); }
  if (core.isolatedEffects.length && (core.mode === 'live' || core.mode === 'replay')) throw new TypeError('isolated outcomes in nonbuffering execution mode');
  for (let index = 0; index < core.isolatedEffects.length; index++) {
    const item = core.isolatedEffects[index]; exactObject(item, ['request', 'outcome']); validateEffectRequest(item.request); effectReplayOutcomeDigest(item.outcome);
    if (item.outcome.state !== 'rejected' || !['isolated_intent_buffered', 'isolated_branch_required'].includes(item.outcome.code) || item.request.executionId !== core.executionId || item.request.executionManifest !== core.executionManifest || item.request.branchId !== core.branchId || item.request.effectId !== `effect-${core.effectPrefix.length + index}` || (item.outcome.code === 'isolated_intent_buffered') !== (item.request.branchId !== null)) throw new TypeError('invalid isolated checkpoint outcome/context');
  }
  if (!['live', 'shadow', 'speculative', 'replay'].includes(core.mode) || !['idle', 'running', 'completed', 'faulted', 'blocked'].includes(core.state) || !Number.isSafeInteger(core.steps) || core.steps < 0) throw new TypeError('invalid resumable execution status');
  if (core.branchId !== null) identifier(core.branchId);
  const tables = ['records', 'environments', 'heaps', 'sequences', 'results', 'closures', 'tasks', 'frames', 'atomics'] as const;
  if (tables.some(table => !Array.isArray(core[table])) || tables.reduce((sum, table) => sum + core[table].length, 0) > MAX_MACHINE_ROWS) throw new RangeError('resumable state table limit');
  const ids = new Map<string, Set<string>>();
  for (const [table, allocator] of [['records', 'nextRecord'], ['environments', 'nextEnvironment'], ['heaps', 'nextHeapVersion'], ['sequences', 'nextSequence'], ['results', 'nextResult'], ['closures', 'nextClosure'], ['tasks', 'nextTask'], ['frames', 'nextFrame']] as const) {
    decimal(core[allocator]); if (allocator === 'nextRecord' && BigInt(core[allocator]) > BigInt(Number.MAX_SAFE_INTEGER) + 1n) throw new TypeError('host reference address limit exceeded'); if (BigInt(core[allocator]) < 1n) throw new TypeError('invalid machine allocator');
    const seen = new Set<string>();
    for (const row of core[table]) { decimal(row.id); if (row.id === '0' || seen.has(row.id) || BigInt(row.id) >= BigInt(core[allocator])) throw new TypeError('duplicate/out-of-range machine identity'); seen.add(row.id); }
    ids.set(table, seen);
  }
  const checkValue = (item: unknown): void => {
    validateMachineValue(item);
    if (item.tag === 'ref') { if (item.value.heapId !== core.heapId || core.records.find(row => row.id === item.value.objectId)?.epoch !== item.value.ownerEpoch || !ids.get('records')!.has(item.value.objectId)) throw new TypeError('dangling or stale checkpoint heap reference'); }
    else if (item.tag === 'sequence' || item.tag === 'result' || item.tag === 'closure' || item.tag === 'task') if (!ids.get(`${item.tag}s`)!.has(item.id)) throw new TypeError('dangling checkpoint composite reference');
  };
  const pairs = (values: unknown, check = checkValue): void => { if (!Array.isArray(values)) throw new TypeError('invalid machine bindings'); const seen = new Set<string>(); for (const pair of values) { if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== 'string' || seen.has(pair[0])) throw new TypeError('duplicate/invalid machine binding'); seen.add(pair[0]); check(pair[1]); } };
  const records = (rows: MachineRecord[], old = false): void => {
    if (!Array.isArray(rows) || rows.length > MAX_MACHINE_ROWS) throw new TypeError('invalid historical heap'); const seen = new Set<string>();
    for (const row of rows) { exactObject(row, ['id', 'version', 'epoch', 'ty', 'fields']); if (row.ty !== null) validateMachineType(row.ty); decimal(row.id); decimal(row.version); decimal(row.epoch); if (row.id === '0' || seen.has(row.id) || (!old && !ids.get('records')!.has(row.id))) throw new TypeError('invalid heap record identity'); seen.add(row.id); pairs(row.fields); }
  };
  records(core.records);
  for (const row of core.environments) { exactObject(row, ['id', 'bindings']); pairs(row.bindings); }
  for (const row of core.heaps) { exactObject(row, ['id', 'records']); records(row.records, true); }
  for (const row of core.sequences) { exactObject(row, ['id', 'items']); if (!Array.isArray(row.items)) throw new TypeError('invalid machine sequence'); row.items.forEach(checkValue); }
  for (const row of core.results) { exactObject(row, ['id', 'variant', 'value']); if (row.variant !== 'ok' && row.variant !== 'err') throw new TypeError('invalid machine result'); checkValue(row.value); }
  const codes = new Map(program.codes.map(code => [code.id, code]));
  const capture = (row: MachineCapture): void => {
    validateMachineTypeBindings(row.typeBindings);
    const code = codes.get(row.code); if (!code || !Array.isArray(row.scopes) || !row.scopes.length || !Array.isArray(row.capabilities)) throw new TypeError('invalid resumable capture');
    for (const scope of row.scopes) if (!ids.get('environments')!.has(scope)) throw new TypeError('dangling lexical environment');
    if (!ids.get('environments')!.has(row.oldScope) || !ids.get('heaps')!.has(row.oldHeap)) throw new TypeError('dangling entry-state capture');
    if (new Set(row.capabilities).size !== row.capabilities.length || row.capabilities.some(cap => !code.capabilities.includes(cap))) throw new TypeError('checkpoint capability amplification');
  };
  for (const row of core.closures) { exactObject(row, ['id', 'code', 'scopes', 'oldScope', 'oldHeap', 'capabilities', 'typeBindings']); capture(row); if (codes.get(row.code)!.kind !== 'lambda') throw new TypeError('closure code mismatch'); }
  for (const row of core.tasks) { exactObject(row, ['id', 'code', 'scopes', 'oldScope', 'oldHeap', 'capabilities', 'typeBindings', 'state', 'result']); capture(row); if (codes.get(row.code)!.kind !== 'task' || !['pending', 'running', 'completed'].includes(row.state)) throw new TypeError('task scheduler state mismatch'); if (row.result !== null) checkValue(row.result); if ((row.state === 'completed') !== (row.result !== null)) throw new TypeError('task completion/value mismatch'); }
  for (const frame of core.frames) {
    exactObject(frame, ['id', 'code', 'pc', 'scopes', 'baseScopes', 'oldScope', 'oldHeap', 'capabilities', 'typeBindings', 'stack', 'registers', 'result', 'task']); capture(frame);
    if (!Number.isSafeInteger(frame.pc) || frame.pc < 0 || frame.pc >= codes.get(frame.code)!.instructions.length || !Number.isSafeInteger(frame.baseScopes) || frame.baseScopes < 1 || frame.baseScopes > frame.scopes.length || !Array.isArray(frame.stack)) throw new TypeError('invalid resumed program counter/frame');
    frame.stack.forEach(checkValue); pairs(frame.registers); if (frame.result !== null) checkValue(frame.result);
    if (frame.task !== null && (!ids.get('tasks')!.has(frame.task) || core.tasks.find(task => task.id === frame.task)!.state !== 'running')) throw new TypeError('frame/task scheduler mismatch');
  }
  for (const task of core.tasks) if (task.state === 'running' && core.frames.filter(frame => frame.task === task.id).length !== 1) throw new TypeError('running task missing unique frame');
  for (const atomic of core.atomics) { exactObject(atomic, ['frame', 'records', 'environments', 'nextRecord']); if (!ids.get('frames')!.has(atomic.frame)) throw new TypeError('dangling atomic frame'); records(atomic.records, true); decimal(atomic.nextRecord); if (!Array.isArray(atomic.environments)) throw new TypeError('invalid atomic environments'); for (const env of atomic.environments) { exactObject(env, ['id', 'bindings']); pairs(env.bindings); } }
  if (core.result !== null) checkValue(core.result);
  if (core.fault !== null) { exactObject(core.fault, ['kind', 'message', 'recoveryId']); identifier(core.fault.kind); if (typeof core.fault.message !== 'string') throw new TypeError('invalid machine fault'); if (core.fault.recoveryId !== null) identifier(core.fault.recoveryId); }
  if (core.state === 'running' && !core.frames.length || core.state === 'completed' && (core.frames.length || core.result === null)) throw new TypeError('inconsistent checkpoint execution state');
}
export function validateResumableSnapshot(value: unknown, program: ResumableProgram): asserts value is ResumableSnapshot {
  encodeCanonical(value, MACHINE_LIMITS);
  const snapshot = exactObject(value, ['format', 'core', 'eventCursor', 'eventHead', 'events']) as unknown as ResumableSnapshot;
  if (snapshot.format !== 'aether.resumable-state/1' || !Array.isArray(snapshot.events) || snapshot.events.length > MAX_MACHINE_EVENTS) throw new TypeError('unsupported checkpoint/event version or size');
  validateMachineCore(snapshot.core, program); decimal(snapshot.eventCursor);
  if (snapshot.eventCursor !== String(snapshot.events.length)) throw new TypeError('checkpoint event cursor mismatch');
  let previous = emptyEventHead(), after: Digest | undefined;
  for (let index = 0; index < snapshot.events.length; index++) {
    const event = snapshot.events[index]; exactObject(event, ['format', 'sequence', 'previous', 'before', 'after', 'code', 'pc', 'op', 'effect', 'delta']);
    if (event.format !== 'aether.resumable-event/1' || event.sequence !== String(index + 1) || event.previous !== previous || after !== undefined && event.before !== after || !Array.isArray(event.delta)) throw new TypeError('corrupt resumable event prefix');
    validateDigest(event.before, 'aether.resumable-core/1'); validateDigest(event.after, 'aether.resumable-core/1'); identifier(event.code); identifier(event.op);
    const sections = new Set<string>();
    for (const delta of event.delta) { exactObject(delta, ['section', 'before', 'after']); if (!fields.includes(delta.section) || sections.has(delta.section)) throw new TypeError('invalid checkpoint inverse delta'); sections.add(delta.section); }
    const instruction = program.codes.find(code => code.id === event.code)?.instructions[event.pc];
    if (!Number.isSafeInteger(event.pc) || event.pc < 0 || (event.code === 'host' ? !['allocate', 'correction', 'retry-reconciled-effect'].includes(event.op) : event.op !== 'start' && instruction?.op !== event.op)) throw new TypeError('checkpoint event does not name a bound instruction');
    if (event.effect !== null) {
      exactObject(event.effect, ['source', 'request', 'outcome']);
      if (!['live', 'recorded', 'isolated'].includes(event.effect.source) || (snapshot.core.mode === 'live') !== (event.effect.source === 'live')) throw new TypeError('checkpoint effect source/mode mismatch'); validateEffectRequest(event.effect.request); effectReplayOutcomeDigest(event.effect.outcome);
      if (event.op !== 'effect' || instruction?.op !== 'effect' || event.effect.request.executionId !== snapshot.core.executionId || event.effect.request.executionManifest !== snapshot.core.executionManifest || event.effect.request.branchId !== snapshot.core.branchId) throw new TypeError('checkpoint effect event context mismatch');
    }
    previous = eventDigest(event); after = event.after;
  }
  if (snapshot.eventHead !== previous || after !== undefined && after !== machineDigest(snapshot.core)) throw new TypeError('checkpoint state does not match event head');
  // Reverse every delta against the current state and verify its bound state
  // digests. A forged before-value cannot masquerade as a valid rewind record.
  const core = machineClone(snapshot.core) as unknown as Record<string, unknown>;
  for (let index = snapshot.events.length - 1; index >= 0; index--) {
    const event = snapshot.events[index], afterCore = machineClone(core) as unknown as MachineCore; if (machineDigest(core as unknown as MachineCore) !== event.after) throw new TypeError('invalid checkpoint after-state chain');
    for (const delta of event.delta) { if (Buffer.compare(encodeCanonical(core[delta.section], MACHINE_LIMITS), encodeCanonical(delta.after, MACHINE_LIMITS))) throw new TypeError('checkpoint delta does not match state'); core[delta.section] = machineClone(delta.before); }
    if (machineDigest(core as unknown as MachineCore) !== event.before) throw new TypeError('invalid checkpoint inverse state');
    validateMachineCore(core, program);
    const before = core as unknown as MachineCore;
    if (before.executionId !== snapshot.core.executionId || before.heapId !== snapshot.core.heapId || before.ownerEpoch !== snapshot.core.ownerEpoch || before.mode !== snapshot.core.mode || before.branchId !== snapshot.core.branchId) throw new TypeError('checkpoint history changes execution identity');
    const code = program.codes.find(code => code.id === event.code);
    if (event.op === 'start') {
      if (!code || code.kind !== 'function' || event.pc !== 0 || before.frames.length || before.state === 'running' || before.state === 'blocked' || afterCore.frames.length !== 1 || afterCore.frames[0].code !== code.id || afterCore.frames[0].pc !== 0 || afterCore.state !== 'running') throw new TypeError('invalid checkpoint start provenance');
    } else if (event.code === 'host') {
      if (event.pc !== 0) throw new TypeError('invalid checkpoint host program counter');
      if (event.op === 'allocate' && (before.frames.length || before.state === 'running' || before.state === 'blocked')) throw new TypeError('host allocation outside idle safe point');
      if (event.op === 'retry-reconciled-effect' && (before.state !== 'blocked' || afterCore.state !== 'running' || afterCore.fault !== null || Buffer.compare(encodeCanonical(before.frames, MACHINE_LIMITS), encodeCanonical(afterCore.frames, MACHINE_LIMITS)))) throw new TypeError('invalid checkpoint retry provenance');
      if (event.op === 'correction' && event.delta.some(delta => !['records', 'environments', 'sequences', 'results', 'nextSequence', 'nextResult'].includes(delta.section))) throw new TypeError('correction changed protected execution control');
    } else {
      const top = before.frames.at(-1);
      if (!code || before.state !== 'running' || !top || top.code !== event.code || top.pc !== event.pc || code.instructions[event.pc]?.op !== event.op) throw new TypeError('checkpoint instruction/frame provenance mismatch');
    }
    if (afterCore.steps !== before.steps + (event.code === 'host' || event.op === 'start' ? 0 : 1)) throw new TypeError('checkpoint instruction count mismatch');
    const prefixDelta = event.delta.find(delta => delta.section === 'effectPrefix');
    if (prefixDelta) {
      if (!event.effect || event.effect.source === 'isolated' || event.effect.outcome.state === 'indeterminate') throw new TypeError('effect prefix advanced without a terminal recorded outcome');
      const expected = [...before.effectPrefix, { requestDigest: effectRequestDigest(event.effect.request), outcomeDigest: effectReplayOutcomeDigest(event.effect.outcome) }];
      if (Buffer.compare(encodeCanonical(expected, MACHINE_LIMITS), encodeCanonical(prefixDelta.after, MACHINE_LIMITS))) throw new TypeError('machine state does not belong to its effect prefix');
    }
    const isolatedDelta = event.delta.find(delta => delta.section === 'isolatedEffects');
    if (isolatedDelta) {
      if (!event.effect || event.effect.source !== 'isolated') throw new TypeError('isolated outcome appended without isolated event');
      const expected = [...before.isolatedEffects, { request: event.effect.request, outcome: event.effect.outcome }];
      if (Buffer.compare(encodeCanonical(expected, MACHINE_LIMITS), encodeCanonical(isolatedDelta.after, MACHINE_LIMITS))) throw new TypeError('machine isolated outcome prefix mismatch');
    }
    if (event.effect) {
      if ((event.effect.source === 'isolated') !== !!isolatedDelta) throw new TypeError('isolated source/prefix mismatch');
      if (event.effect.request.effectId !== `effect-${before.effectCursor}`) throw new TypeError('checkpoint effect order mismatch');
      const frame = before.frames.at(-1), instruction = program.codes.find(code => code.id === event.code)!.instructions[event.pc];
      if (!frame || frame.code !== event.code || frame.pc !== event.pc || !frame.capabilities.includes(instruction.args[0] as CapabilityName)) throw new TypeError('checkpoint effect frame mismatch');
      const payload = event.effect.request.payload;
      if (payload.tag !== 'sequence' || payload.items[0]?.tag !== 'string' || payload.items[0].value !== instruction.args[0] || payload.items.length !== Number(instruction.args[1]) + 1) throw new TypeError('checkpoint effect payload/instruction mismatch');
      const encode = (value: MachineValue, active = new Set<string>()): unknown => {
        if (value.tag !== 'sequence' && value.tag !== 'result') { if (value.tag === 'closure' || value.tag === 'task') throw new TypeError('opaque checkpoint effect argument'); return value; }
        const key = `${value.tag}:${value.id}`; if (active.has(key)) throw new TypeError('cyclic checkpoint effect argument'); active.add(key);
        let result: unknown;
        if (value.tag === 'sequence') { const row = before.sequences.find(item => item.id === value.id); if (!row) throw new TypeError('missing checkpoint effect sequence'); result = { tag: 'sequence', items: row.items.map(item => encode(item, active)) }; }
        else { const row = before.results.find(item => item.id === value.id); if (!row) throw new TypeError('missing checkpoint effect result'); result = { tag: 'result', variant: row.variant, value: encode(row.value, active) }; }
        active.delete(key); return result;
      };
      const args = frame.stack.slice(frame.stack.length - Number(instruction.args[1]));
      if (args.length !== Number(instruction.args[1]) || Buffer.compare(encodeCanonical(args.map(value => encode(value)), MACHINE_LIMITS), encodeCanonical(payload.items.slice(1), MACHINE_LIMITS))) throw new TypeError('checkpoint effect arguments differ from suspended registers');
      if ((event.effect.outcome.state !== 'indeterminate' && event.effect.source !== 'isolated') !== !!prefixDelta) throw new TypeError('checkpoint terminal outcome/prefix mismatch');
    }

  }
}
