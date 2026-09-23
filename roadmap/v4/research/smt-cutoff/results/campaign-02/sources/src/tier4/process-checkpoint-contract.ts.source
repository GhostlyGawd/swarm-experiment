/** Explicit bridge between allocation identities in resumable state and the
 * uniform generation of ProcessHost's C1 heap. Container identity is not part
 * of C1: this projection deliberately admits only scalar and record-ref fields. */
import { closeSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { decodeCanonical, encodeCanonical, exactObject, identifier, decimal, validateLogicalRef, validateTaggedValue, type LogicalRefV1, type TaggedValueV1 } from '../fabric/encoding.ts';
import { domainDigest, validateDigest, type Digest } from '../fabric/identity.ts';
import { validateEffectRequest, effectRequestDigest, effectReplayOutcomeDigest, type EffectEventV1 } from '../fabric/effects.ts';
import { runtimeSnapshotDigest, validateRuntimeSnapshot, type RuntimeSnapshotV1 } from '../fabric/snapshot.ts';
import { checkpointDigest, eventDigest, machineDigest, MACHINE_LIMITS, machineClone, validateResumableSnapshot, type ResumableSnapshot, type MachineValue } from '../tier3/resumable-state.ts';
import type { ResumableProgram } from '../tier3/resumable-program.ts';
import type { Ty } from '../tier1/ast.ts';
import { validateMachineResult } from '../tier3/resumable-types.ts';
import type { SymbolId } from '../tier1/ids.ts';

export interface ProcessCheckpointBinding {
  readonly format: 'aether.process-checkpoint-binding/1'; readonly id: Digest; readonly operationId: string; readonly symbol: SymbolId;
  readonly configuration: Digest; readonly generation: string; readonly unit: string; readonly processHead: Digest;
  readonly beforeSnapshot: Digest; readonly baseCheckpoint: Digest; readonly initialCheckpoint: Digest; readonly program: Digest; readonly executionId: string;
}
export interface ProcessCheckpointLease {
  binding: ProcessCheckpointBinding; state: 'active' | 'committed' | 'aborted'; latestCheckpoint: Digest;
  checkpoints: Digest[]; receipt: Digest | null;
}
export interface ProcessCheckpointReceipt {
  readonly format: 'aether.process-checkpoint-receipt/1'; readonly id: Digest; readonly binding: Digest;
  readonly checkpoint: Digest; readonly beforeSnapshot: Digest; readonly afterSnapshot: Digest;
  readonly effectAudit: Digest; readonly eventHead: Digest; readonly eventCursor: string;
}
export type ProcessCheckpointAction = 'begin' | 'run' | 'commit' | 'reconcile' | 'abort' | 'correct' | 'rewind';
export type ProcessCheckpointControlRequest = { readonly operationId: string; readonly expectedCheckpoint: Digest } & (
  { readonly kind: 'rewind'; readonly steps: number } |
  { readonly kind: 'local'; readonly frameId: string; readonly symbol: SymbolId; readonly value: TaggedValueV1 } |
  { readonly kind: 'record'; readonly reference: LogicalRefV1; readonly field: string; readonly value: TaggedValueV1 });
export interface ProcessCheckpointControl {
  readonly format: 'aether.process-checkpoint-control/1'; readonly id: Digest; readonly binding: Digest;
  readonly request: ProcessCheckpointControlRequest; readonly beforeCheckpoint: Digest; readonly afterCheckpoint: Digest;
  readonly previous: Digest | null; readonly effectAudit: Digest; readonly effectCount: number;
}
export interface ProcessCheckpointAuthorization { readonly action: ProcessCheckpointAction; readonly binding: ProcessCheckpointBinding; readonly control?: ProcessCheckpointControlRequest }
export const checkpointControlDigest = (value: Omit<ProcessCheckpointControl, 'id'>): Digest => domainDigest('aether.process-checkpoint-control/1', value);
export function validateCheckpointControlRequest(value: ProcessCheckpointControlRequest): void {
  const keys = ['operationId', 'expectedCheckpoint', 'kind'];
  if (value.kind === 'rewind') keys.push('steps'); else if (value.kind === 'local') keys.push('frameId', 'symbol', 'value'); else if (value.kind === 'record') keys.push('reference', 'field', 'value'); else throw new TypeError('unsupported checkpoint control');
  exactObject(value, keys); identifier(value.operationId); validateDigest(value.expectedCheckpoint, 'aether.resumable-state/1');
  if (value.kind === 'rewind') { if (!Number.isSafeInteger(value.steps) || value.steps < 1 || value.steps > 4096) throw new RangeError('invalid control rewind distance'); }
  else {
    validateTaggedValue(value.value); if (!['null', 'bool', 'int', 'string', 'ref'].includes(value.value.tag)) throw new TypeError('checkpoint corrections require scalar/reference values');
    if (value.kind === 'local') { decimal(value.frameId); identifier(value.symbol); } else { validateLogicalRef(value.reference); identifier(value.field); }
  }
}
export function validateCheckpointControlTransition(request: ProcessCheckpointControlRequest, before: ResumableSnapshot, after: ResumableSnapshot, program: ResumableProgram): void {
  validateCheckpointControlRequest(request); validateCheckpointExtension(before, after, program, request.kind !== 'rewind');
  const event = after.events.at(-1);
  if (request.expectedCheckpoint !== checkpointDigest(before) || after.events.length !== before.events.length + 1 || event?.code !== 'host' || event.op !== (request.kind === 'rewind' ? `rewind-v1:${request.steps}` : 'correction')) throw new TypeError('checkpoint control does not match the authorized transition');
  if (request.kind === 'rewind') return; // Version 2 validator checks every inverse section against the exact target.
  if (before.core.state !== 'running' || !before.core.frames.length || before.core.frames.some(frame => frame.pc >= program.codes.find(code => code.id === frame.code)!.returnPc)) throw new Error('checkpoint correction requires a running body before postcondition evaluation; rewind first');
  const expected = machineClone(before.core), value = machineClone(request.value) as MachineValue;
  if (request.kind === 'record') {
    const record = expected.records.find(record => record.id === request.reference.objectId && record.epoch === request.reference.ownerEpoch);
    const field = record?.fields.find(([name]) => name === request.field);
    if (!record || !field || request.reference.heapId !== expected.heapId) throw new TypeError('stale correction target');
    field[1] = value; record.version = String(BigInt(record.version) + 1n);
  } else {
    const frame = expected.frames.find(frame => frame.id === request.frameId); if (!frame) throw new TypeError('unknown correction frame');
    const field = [...frame.scopes].reverse().map(id => expected.environments.find(environment => environment.id === id)?.bindings.find(([symbol]) => symbol === request.symbol)).find(Boolean);
    if (!field) throw new TypeError('unknown correction local'); field[1] = value;
  }
  if (machineDigest(expected) !== machineDigest(after.core)) throw new TypeError('checkpoint correction differs from its authorized value/target');
}
export function processCheckpointBindingDigest(value: Omit<ProcessCheckpointBinding, 'id'>): Digest { return domainDigest('aether.process-checkpoint-binding/1', value); }
export function validateProcessCheckpointBinding(value: ProcessCheckpointBinding): void {
  exactObject(value, ['format', 'id', 'operationId', 'symbol', 'configuration', 'generation', 'unit', 'processHead', 'beforeSnapshot', 'baseCheckpoint', 'initialCheckpoint', 'program', 'executionId']);
  const { id, ...body } = value;
  if (value.format !== 'aether.process-checkpoint-binding/1' || processCheckpointBindingDigest(body) !== id) throw new TypeError('invalid process checkpoint binding');
  identifier(value.operationId); identifier(value.symbol); identifier(value.unit); identifier(value.executionId); decimal(value.generation);
  for (const digest of [value.configuration, value.processHead, value.beforeSnapshot, value.baseCheckpoint, value.initialCheckpoint, value.program]) validateDigest(digest);
}
export function processCheckpointReceiptDigest(value: Omit<ProcessCheckpointReceipt, 'id'>): Digest { return domainDigest('aether.process-checkpoint-receipt/1', value); }
export function projectProcessCheckpoint(snapshot: ResumableSnapshot, baseline: RuntimeSnapshotV1, generation: string, unit: string): RuntimeSnapshotV1 {
  validateRuntimeSnapshot(baseline); decimal(generation); identifier(unit);
  if (snapshot.core.executionManifest !== baseline.executionManifest || snapshot.core.heapId !== baseline.heapId || snapshot.core.mode !== 'live' || snapshot.core.branchId !== null || snapshot.core.isolatedEffects.length) throw new TypeError('checkpoint is not a matching live process state');
  const next = Number(snapshot.core.nextRecord);
  if (!Number.isSafeInteger(next) || next < 1 || snapshot.core.records.length !== next - 1 || snapshot.core.records.some((record, index) => record.id !== String(index + 1))) throw new TypeError('C1 process bridge requires dense positive record IDs');
  const epochs = new Map(snapshot.core.records.map(record => [record.id, record.epoch]));
  const value = (item: MachineValue): TaggedValueV1 => {
    if (item.tag === 'ref') {
      if (item.value.heapId !== snapshot.core.heapId || epochs.get(item.value.objectId) !== item.value.ownerEpoch) throw new TypeError('stale resumable allocation reference');
      return { tag: 'ref', value: { heapId: baseline.heapId, objectId: item.value.objectId, ownerEpoch: generation } };
    }
    if (item.tag !== 'null' && item.tag !== 'bool' && item.tag !== 'int' && item.tag !== 'string') throw new TypeError('C1 process bridge cannot erase sequence/result/closure/task identity in heap fields');
    return machineClone(item);
  };
  const owners = new Map(baseline.ownership.map(owner => [owner.objectId, owner.unit]));
  const projected: RuntimeSnapshotV1 = { format: 'aether.state/1', executionManifest: baseline.executionManifest, heapId: baseline.heapId, nextObjectId: snapshot.core.nextRecord,
    records: snapshot.core.records.map(record => ({ objectId: record.id, fields: record.fields.map(([name, item]) => [name, value(item)] as const).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0) })),
    ownership: snapshot.core.records.map(record => ({ objectId: record.id, unit: owners.get(record.id) ?? unit, epoch: generation })),
    // The resumable cursor/head is retained in the bridge receipt. It is not
    // substituted for ProcessHost's separately scoped event cursor.
    eventCursor: baseline.eventCursor,
  };
  validateRuntimeSnapshot(projected); return projected;
}
export function validateCheckpointExtension(base: ResumableSnapshot, next: ResumableSnapshot, program: ResumableProgram, preserveAllocations = true): void {
  validateResumableSnapshot(base, program); validateResumableSnapshot(next, program);
  if (base.core.executionId !== next.core.executionId || base.core.heapId !== next.core.heapId || base.core.ownerEpoch !== next.core.ownerEpoch || base.core.mode !== next.core.mode || base.core.branchId !== next.core.branchId || next.events.length < base.events.length || base.events.some((event, index) => eventDigest(event) !== eventDigest(next.events[index]))) throw new TypeError('checkpoint is not an append-only continuation of its ownership base');
  const current = new Map(next.core.records.map(record => [record.id, record]));
  if (preserveAllocations) {
    for (const record of base.core.records) if (current.get(record.id)?.epoch !== record.epoch) throw new TypeError('checkpoint replaced a pre-existing allocation identity');
    if (BigInt(next.core.nextRecord) < BigInt(base.core.nextRecord)) throw new TypeError('checkpoint allocator moved before ownership base');
  }
}
export function processReferenceFromCheckpoint(value: LogicalRefV1, snapshot: ResumableSnapshot, generation: string): LogicalRefV1 {
  if (value.heapId !== snapshot.core.heapId || snapshot.core.records.find(record => record.id === value.objectId)?.epoch !== value.ownerEpoch) throw new TypeError('stale resumable handle cannot be rebound');
  decimal(generation); return { heapId: value.heapId, objectId: value.objectId, ownerEpoch: generation };
}
export interface ProcessCheckpointSeed { readonly checkpoint: ResumableSnapshot; readonly generation: string; readonly processSnapshot: Digest; readonly references: readonly { process: LogicalRefV1; resumable: LogicalRefV1 }[] }
/** C1 heap import is a new, explicitly witnessed initial state. Existing event
 * history is never rewritten to pretend uniform epochs were allocation epochs. */
export function seedProcessCheckpoint(empty: ResumableSnapshot, process: RuntimeSnapshotV1, generation: string, program: ResumableProgram, types: Readonly<Record<string, Ty>> = {}): ProcessCheckpointSeed {
  validateResumableSnapshot(empty, program); validateRuntimeSnapshot(process); decimal(generation);
  if (empty.events.length || empty.core.state !== 'idle' || empty.core.records.length || empty.core.frames.length || empty.core.executionManifest !== process.executionManifest || empty.core.heapId !== process.heapId || process.ownership.some(owner => owner.epoch !== generation)) throw new TypeError('process checkpoint seed requires an empty matching runtime and ownership generation');
  const next = Number(process.nextObjectId); if (!Number.isSafeInteger(next) || next < 1 || process.records.length !== next - 1 || process.records.some((record, index) => record.objectId !== String(index + 1))) throw new TypeError('process checkpoint seed requires dense C1 records');
  const checkpoint = machineClone(empty), epochs = new Map<string, string>();
  for (const record of process.records) { const digest = domainDigest('aether.process-checkpoint-object/1', { heapId: process.heapId, objectId: record.objectId, generation }); epochs.set(record.objectId, BigInt(`0x${digest.split(':').at(-1)!}`).toString()); }
  const value = (item: TaggedValueV1): MachineValue => {
    if (item.tag === 'ref') return { tag: 'ref', value: { ...item.value, ownerEpoch: epochs.get(item.value.objectId)! } };
    if (item.tag !== 'null' && item.tag !== 'bool' && item.tag !== 'int' && item.tag !== 'string') throw new TypeError('C1 bridge cannot infer container or execution-object identity'); return machineClone(item);
  };
  if (Object.keys(types).some(id => !epochs.has(id))) throw new TypeError('type witness names an absent process object');
  checkpoint.core.records = process.records.map(record => ({ id: record.objectId, epoch: epochs.get(record.objectId)!, version: '0', ty: Object.hasOwn(types, record.objectId) ? machineClone(types[record.objectId]) : null, fields: record.fields.map(([name, item]) => [name, value(item)]) }));
  checkpoint.core.nextRecord = process.nextObjectId;
  validateResumableSnapshot(checkpoint, program);
  for (const record of checkpoint.core.records) if (record.ty !== null) validateMachineResult(record.ty, { tag: 'ref', value: { heapId: process.heapId, objectId: record.id, ownerEpoch: record.epoch } }, checkpoint.core, program);
  return { checkpoint, generation, processSnapshot: runtimeSnapshotDigest(process), references: process.ownership.map(owner => ({ process: { heapId: process.heapId, objectId: owner.objectId, ownerEpoch: owner.epoch }, resumable: { heapId: process.heapId, objectId: owner.objectId, ownerEpoch: epochs.get(owner.objectId)! } })) };
}
export function seededProcessReference(reference: LogicalRefV1, seed: ProcessCheckpointSeed): LogicalRefV1 {
  const match = seed.references.find(item => item.process.heapId === reference.heapId && item.process.objectId === reference.objectId && item.process.ownerEpoch === reference.ownerEpoch);
  if (!match) throw new TypeError('stale or foreign process reference'); return machineClone(match.resumable);
}
function sync(directory: string): void { const fd = openSync(directory, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } }
function ensure(directory: string): void { if (existsSync(directory)) return; ensure(dirname(directory)); try { mkdirSync(directory); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; } sync(directory); sync(dirname(directory)); }
function blobPath(directory: string, digest: Digest): string { validateDigest(digest, 'aether.resumable-state/1'); return join(directory, 'checkpoint-objects', `${digest.split(':').at(-1)!}.json`); }
export function writeProcessCheckpoint(directory: string, snapshot: ResumableSnapshot, program: ResumableProgram): Digest {
  validateResumableSnapshot(snapshot, program); const digest = checkpointDigest(snapshot), file = blobPath(directory, digest); ensure(dirname(file));
  const bytes = encodeCanonical(snapshot, MACHINE_LIMITS);
  if (existsSync(file)) { if (!Buffer.from(readFileSync(file)).equals(Buffer.from(bytes))) throw new TypeError('corrupt retained process checkpoint'); return digest; }
  const temporary = join(dirname(file), `.checkpoint-${process.pid}-${randomUUID()}`), fd = openSync(temporary, 'wx', 0o600);
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
  try { try { linkSync(temporary, file); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; if (!Buffer.from(readFileSync(file)).equals(Buffer.from(bytes))) throw new TypeError('checkpoint address collision/corruption'); } sync(dirname(file)); } finally { unlinkSync(temporary); }
  return digest;
}
export function retainedProcessCheckpointExists(directory: string, digest: Digest): boolean { const file = blobPath(directory, digest); return existsSync(file) && statSync(file).size <= MACHINE_LIMITS.maxFrameBytes; }
export function readProcessCheckpoint(directory: string, digest: Digest, program: ResumableProgram): ResumableSnapshot {
  const file = blobPath(directory, digest); if (statSync(file).size > MACHINE_LIMITS.maxFrameBytes) throw new RangeError('process checkpoint byte limit');
  const snapshot = decodeCanonical(readFileSync(file), MACHINE_LIMITS); validateResumableSnapshot(snapshot, program);
  if (checkpointDigest(snapshot) !== digest) throw new TypeError('process checkpoint digest mismatch'); return snapshot;
}
export function validateCheckpointEffectAudit(snapshot: ResumableSnapshot, events: readonly EffectEventV1[]): void {
  encodeCanonical(events); if (!Array.isArray(events) || events.length !== snapshot.core.effectPrefix.length) throw new TypeError('checkpoint effect audit coverage mismatch');
  let previousSequence = -1n;
  for (let index = 0; index < events.length; index++) {
    const event = events[index]; exactObject(event, ['format', 'sequence', 'request', 'requestDigest', 'adapterId', 'adapterSemanticsDigest', 'state', 'transitions', 'dispatchStarted', 'prepared', 'observedAt', 'recordedAt', 'outcome']);
    validateEffectRequest(event.request); decimal(event.sequence); identifier(event.adapterId); validateDigest(event.adapterSemanticsDigest, 'aether.effect-adapter/1'); decimal(event.observedAt); decimal(event.recordedAt);
    if (event.format !== 'aether.effect-event/1' || BigInt(event.sequence) <= previousSequence || event.request.executionId !== snapshot.core.executionId || event.request.executionManifest !== snapshot.core.executionManifest || event.request.effectId !== `effect-${index}` || event.requestDigest !== effectRequestDigest(event.request) || !event.outcome || event.outcome.state === 'indeterminate' || event.outcome.state !== event.state) throw new TypeError('unresolved or foreign checkpoint effect audit');
    previousSequence = BigInt(event.sequence);
    if (event.outcome.state === 'committed' && (!event.dispatchStarted || event.outcome.receiptDigest !== domainDigest('aether.effect-receipt/1', { requestDigest: event.requestDigest, adapterId: event.adapterId, adapterSemanticsDigest: event.adapterSemanticsDigest, observedAt: event.observedAt, value: event.outcome.value }))) throw new TypeError('invalid checkpoint effect receipt');
    const expected = snapshot.core.effectPrefix[index]; if (expected.requestDigest !== event.requestDigest || expected.outcomeDigest !== effectReplayOutcomeDigest(event.outcome)) throw new TypeError('checkpoint does not cover its actual durable effect outcome');
    if (event.outcome.state === 'committed') {
      const refs = (value: TaggedValueV1): void => { if (value.tag === 'ref') processReferenceFromCheckpoint(value.value, snapshot, '0'); else if (value.tag === 'sequence') value.items.forEach(refs); else if (value.tag === 'result') refs(value.value); }; refs(event.request.payload);
    }
  }
}
export function writeCheckpointEffectAudit(directory: string, snapshot: ResumableSnapshot, events: readonly EffectEventV1[]): Digest {
  validateCheckpointEffectAudit(snapshot, events); const digest = domainDigest('aether.process-checkpoint-effects/1', events), folder = join(directory, 'checkpoint-effect-audits'); ensure(folder);
  const file = join(folder, `${digest.split(':').at(-1)!}.json`), bytes = encodeCanonical(events);
  if (existsSync(file)) { if (!Buffer.from(readFileSync(file)).equals(Buffer.from(bytes))) throw new TypeError('corrupt checkpoint effect audit'); return digest; }
  const temporary = join(folder, `.audit-${process.pid}-${randomUUID()}`), fd = openSync(temporary, 'wx', 0o600);
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
  try { try { linkSync(temporary, file); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; } sync(folder); } finally { unlinkSync(temporary); }
  return digest;
}
export function readCheckpointEffectAudit(directory: string, digest: Digest, snapshot: ResumableSnapshot): readonly EffectEventV1[] {
  validateDigest(digest, 'aether.process-checkpoint-effects/1'); const file = join(directory, 'checkpoint-effect-audits', `${digest.split(':').at(-1)!}.json`);
  if (statSync(file).size > 8 * 1024 * 1024) throw new RangeError('checkpoint effect audit size limit');
  const events = decodeCanonical(readFileSync(file)) as unknown as EffectEventV1[]; validateCheckpointEffectAudit(snapshot, events);
  if (domainDigest('aether.process-checkpoint-effects/1', events) !== digest) throw new TypeError('checkpoint effect audit digest mismatch'); return events;
}
export function assertBaseProjection(base: ResumableSnapshot, process: RuntimeSnapshotV1, generation: string, unit: string): void {
  if (runtimeSnapshotDigest(projectProcessCheckpoint(base, process, generation, unit)) !== runtimeSnapshotDigest(process)) throw new TypeError('checkpoint ownership base differs from current production state');
}
