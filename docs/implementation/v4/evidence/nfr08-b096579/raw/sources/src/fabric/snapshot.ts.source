import { decimal, decodeCanonical, encodeCanonical, encodingLimits, exactObject, identifier, validateTaggedValue, type EncodingLimits, type TaggedValueV1 } from './encoding.ts';
import { domainDigest, validateDigest, type Digest } from './identity.ts';

export interface RuntimeSnapshotV1 {
  readonly format: 'aether.state/1';
  readonly executionManifest: Digest;
  readonly heapId: string;
  readonly nextObjectId: string;
  readonly records: ReadonlyArray<{ readonly objectId: string; readonly fields: ReadonlyArray<readonly [string, TaggedValueV1]> }>;
  readonly ownership: ReadonlyArray<{ readonly objectId: string; readonly unit: string; readonly epoch: string }>;
  readonly eventCursor: string;
}
/** Validate an isolated heap's complete object table before any live import. */
export function validateRuntimeSnapshot(value: unknown, overrides: Partial<EncodingLimits> = {}): asserts value is RuntimeSnapshotV1 {
  const limits = encodingLimits(overrides); encodeCanonical(value, limits);
  const s = exactObject(value, ['format', 'executionManifest', 'heapId', 'nextObjectId', 'records', 'ownership', 'eventCursor']);
  if (s.format !== 'aether.state/1') throw new TypeError('unsupported state version');
  validateDigest(s.executionManifest, 'aether.execution/1'); identifier(s.heapId); decimal(s.nextObjectId, limits); decimal(s.eventCursor, limits);
  if (!Array.isArray(s.records) || !Array.isArray(s.ownership)) throw new TypeError('invalid object table');
  const records = new Set<string>(); const owners = new Map<string, string>();
  let previous = -1n;
  for (const record of s.records) {
    const r = exactObject(record, ['objectId', 'fields']); decimal(r.objectId, limits);
    const id = BigInt(r.objectId);
    if (id <= previous || id >= BigInt(s.nextObjectId)) throw new TypeError('duplicate, unordered or unallocated object ID');
    previous = id; records.add(r.objectId);
    if (!Array.isArray(r.fields)) throw new TypeError('invalid record fields');
    let field: string | undefined;
    for (const entry of r.fields) {
      if (!Array.isArray(entry) || entry.length !== 2) throw new TypeError('invalid field tuple');
      identifier(entry[0]);
      if (field !== undefined && field >= entry[0]) throw new TypeError('duplicate or unordered record field');
      field = entry[0]; validateTaggedValue(entry[1], limits);
    }
  }
  previous = -1n;
  for (const ownership of s.ownership) {
    const o = exactObject(ownership, ['objectId', 'unit', 'epoch']); decimal(o.objectId, limits); identifier(o.unit); decimal(o.epoch, limits);
    if (!records.has(o.objectId) || BigInt(o.objectId) <= previous) throw new TypeError('duplicate, unordered or dangling ownership');
    previous = BigInt(o.objectId); owners.set(o.objectId, o.epoch);
  }
  if (owners.size !== records.size) throw new TypeError('missing ownership');
  const refs = (v: TaggedValueV1): void => {
    if (v.tag === 'ref' && (v.value.heapId !== s.heapId || !records.has(v.value.objectId) || owners.get(v.value.objectId) !== v.value.ownerEpoch)) throw new TypeError('dangling, external or stale logical reference');
    if (v.tag === 'sequence') v.items.forEach(refs);
    if (v.tag === 'result') refs(v.value);
  };
  for (const record of s.records) for (const [, v] of record.fields) refs(v);
}
export function encodeRuntimeSnapshot(value: RuntimeSnapshotV1, limits: Partial<EncodingLimits> = {}): Uint8Array {
  validateRuntimeSnapshot(value, limits); return encodeCanonical(value, limits);
}
export function decodeRuntimeSnapshot(bytes: Uint8Array, limits: Partial<EncodingLimits> = {}): RuntimeSnapshotV1 {
  const value = decodeCanonical(bytes, limits); validateRuntimeSnapshot(value, limits); return value;
}
export function runtimeSnapshotDigest(value: RuntimeSnapshotV1, limits: Partial<EncodingLimits> = {}): Digest {
  validateRuntimeSnapshot(value, limits); return domainDigest('aether.state/1', value, limits);
}
