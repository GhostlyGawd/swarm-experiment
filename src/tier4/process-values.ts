import { createHmac, timingSafeEqual } from 'node:crypto';
import type { NodeRef } from '../tier1/ids.ts';
import type { ProductionSnapshot } from '../tier3/heap-state.ts';
import { isClosureValue, isRef, isResultValue, isSeqValue, isTaskValue, type Value } from '../tier3/values.ts';
import { decodeCanonical, encodeCanonical, exactObject, identifier, decimal, validateTaggedValue, type TaggedValueV1 } from '../fabric/encoding.ts';
import { domainDigest, validateDigest, type Digest } from '../fabric/identity.ts';
import { validateRuntimeSnapshot, type RuntimeSnapshotV1 } from '../fabric/snapshot.ts';

export interface ProcessScope {
  readonly executionManifest: Digest;
  readonly astRoot: NodeRef;
  readonly heapId: string;
  readonly ownershipEpoch: string;
  readonly unit: string;
}
/** Boundary identity is structured and bounded; user strings cannot impersonate nested operations. */
export function processBoundaryId(parentOperationId: string, kind: 'call' | 'effect', index: number): Digest {
  identifier(parentOperationId);
  if (!['call', 'effect'].includes(kind) || !Number.isSafeInteger(index) || index < 0) throw new TypeError('invalid process boundary identity');
  return domainDigest('aether.process-boundary/1', { parentOperationId, kind, index });
}
export function validateProcessScope(scope: ProcessScope): void {
  validateDigest(scope.executionManifest, 'aether.execution/1'); validateDigest(scope.astRoot, 'ast');
  identifier(scope.heapId); identifier(scope.unit); decimal(scope.ownershipEpoch);
}
function reference(address: number, scope: ProcessScope, snapshot?: RuntimeSnapshotV1): TaggedValueV1 {
  if (!Number.isSafeInteger(address) || address < 1 || (snapshot && snapshot.records[address - 1]?.objectId !== String(address))) throw new TypeError('unresolved process reference');
  return { tag: 'ref', value: { heapId: scope.heapId, objectId: String(address), ownerEpoch: scope.ownershipEpoch } };
}
export function encodeProcessValue(value: Value, scope: ProcessScope, snapshot?: RuntimeSnapshotV1, depth = 0): TaggedValueV1 {
  if (depth > 64) throw new RangeError('process value depth limit');
  if (value === null) return { tag: 'null' };
  if (typeof value === 'bigint') return { tag: 'int', value: value.toString() };
  if (typeof value === 'boolean') return { tag: 'bool', value };
  if (typeof value === 'string') return { tag: 'string', value };
  if (isClosureValue(value) || isTaskValue(value)) throw new TypeError('opaque closures/tasks cannot cross a process boundary');
  if (isRef(value)) return reference(value.addr, scope, snapshot);
  if (isSeqValue(value)) return { tag: 'sequence', items: value.map(item => encodeProcessValue(item, scope, snapshot, depth + 1)) };
  if (isResultValue(value)) return { tag: 'result', variant: value.variant, value: encodeProcessValue(value.value, scope, snapshot, depth + 1) };
  throw new TypeError('unsupported process value');
}
export function decodeProcessValue(value: TaggedValueV1, scope: ProcessScope, snapshot?: RuntimeSnapshotV1): Value {
  validateTaggedValue(value);
  switch (value.tag) {
    case 'null': return null;
    case 'bool': case 'string': return value.value;
    case 'int': return BigInt(value.value);
    case 'sequence': return value.items.map(item => decodeProcessValue(item, scope, snapshot));
    case 'result': return { variant: value.variant, value: decodeProcessValue(value.value, scope, snapshot) };
    case 'ref': {
      if (value.value.heapId !== scope.heapId || value.value.ownerEpoch !== scope.ownershipEpoch) throw new TypeError('wrong heap or stale ownership epoch');
      const addr = Number(value.value.objectId); reference(addr, scope, snapshot); return { addr };
    }
    case 'authority': throw new TypeError('process values cannot install authority');
  }
}
export function toWireSnapshot(snapshot: ProductionSnapshot, scope: ProcessScope, previous?: RuntimeSnapshotV1): RuntimeSnapshotV1 {
  validateProcessScope(scope);
  if (snapshot.module !== scope.astRoot) throw new TypeError('snapshot code root mismatch');
  const oldOwners = new Map(previous?.ownership.map(owner => [owner.objectId, owner.unit]));
  const wire: RuntimeSnapshotV1 = {
    format: 'aether.state/1', executionManifest: scope.executionManifest, heapId: scope.heapId,
    nextObjectId: String(snapshot.nextAddress), eventCursor: previous?.eventCursor ?? '0',
    records: snapshot.records.map(record => ({ objectId: String(record.address), fields: [...record.fields].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, value]) => [key, encodeProcessValue(value, scope)] as const) })),
    ownership: snapshot.records.map(record => ({ objectId: String(record.address), unit: oldOwners.get(String(record.address)) ?? scope.unit, epoch: scope.ownershipEpoch })),
  };
  validateRuntimeSnapshot(wire); return wire;
}
export function fromWireSnapshot(snapshot: RuntimeSnapshotV1, scope: ProcessScope): ProductionSnapshot {
  validateProcessScope(scope); validateRuntimeSnapshot(snapshot);
  if (snapshot.executionManifest !== scope.executionManifest || snapshot.heapId !== scope.heapId) throw new TypeError('snapshot execution manifest/heap mismatch');
  if (snapshot.ownership.some(owner => owner.epoch !== scope.ownershipEpoch)) throw new TypeError('stale snapshot ownership epoch');
  const next = Number(snapshot.nextObjectId);
  if (!Number.isSafeInteger(next) || next < 1 || snapshot.records.length !== next - 1 || snapshot.records.some((record, index) => record.objectId !== String(index + 1))) throw new TypeError('process runtime requires dense positive local object IDs');
  return { format: 'aether.production-state/local-1', module: scope.astRoot, nextAddress: next,
    records: snapshot.records.map(record => ({ address: Number(record.objectId), fields: record.fields.map(([key, value]) => [key, decodeProcessValue(value, scope, snapshot)] as const) })) };
}

export interface ProcessSession {
  readonly sessionId: string;
  readonly executionManifest: Digest;
  readonly ownershipEpoch: string;
  readonly maxFrameBytes: number;
}
export type ProcessRole = 'parent' | 'worker';
/** Length-prefix is outside the signed canonical envelope, and is independently bounded. */
export class ProcessAuthenticator {
  private sent = 0n;
  private received = 0n;
  private readonly key: Buffer;
  readonly session: ProcessSession;
  readonly role: ProcessRole;
  constructor(key: Uint8Array, session: ProcessSession, role: ProcessRole) {
    if (key.length !== 32) throw new TypeError('invalid process session key');
    identifier(session.sessionId); validateDigest(session.executionManifest, 'aether.execution/1'); decimal(session.ownershipEpoch);
    if (!Number.isSafeInteger(session.maxFrameBytes) || session.maxFrameBytes < 512 || session.maxFrameBytes > 8 * 1024 * 1024) throw new RangeError('invalid process frame limit');
    this.key = Buffer.from(key);
    this.session = Object.freeze({ ...session }); this.role = role;
  }
  encode(body: unknown): Buffer {
    const message = { format: 'aether.process-frame/1', sessionId: this.session.sessionId, role: this.role, sequence: String(this.sent + 1n), executionManifest: this.session.executionManifest, ownershipEpoch: this.session.ownershipEpoch, body };
    const options = { maxFrameBytes: this.session.maxFrameBytes, maxDecompressedBytes: this.session.maxFrameBytes };
    const mac = createHmac('sha256', this.key).update(encodeCanonical(message, options)).digest('hex');
    const bytes = encodeCanonical({ ...message, mac }, options);
    const header = Buffer.alloc(4); header.writeUInt32BE(bytes.length);
    this.sent++;
    return Buffer.concat([header, bytes]);
  }
  decode(bytes: Uint8Array): unknown {
    const options = { maxFrameBytes: this.session.maxFrameBytes, maxDecompressedBytes: this.session.maxFrameBytes };
    const message = exactObject(decodeCanonical(bytes, options), ['format', 'sessionId', 'role', 'sequence', 'executionManifest', 'ownershipEpoch', 'body', 'mac']);
    if (message.format !== 'aether.process-frame/1' || message.sessionId !== this.session.sessionId || message.role !== (this.role === 'parent' ? 'worker' : 'parent') || message.executionManifest !== this.session.executionManifest || message.ownershipEpoch !== this.session.ownershipEpoch || message.sequence !== String(this.received + 1n)) throw new TypeError('wrong process session/role/root/epoch/sequence');
    if (typeof message.mac !== 'string' || !/^[0-9a-f]{64}$/.test(message.mac)) throw new TypeError('invalid process authentication');
    const { mac, ...unsigned } = message;
    const expected = createHmac('sha256', this.key).update(encodeCanonical(unsigned, options)).digest();
    if (!timingSafeEqual(Buffer.from(mac, 'hex'), expected)) throw new TypeError('invalid process authentication');
    this.received++;
    return message.body;
  }
}
