import type { NodeRef } from '../tier1/ids.ts';
import { isClosureValue, isRef, isResultValue, isSeqValue, isTaskValue, type Value } from './values.ts';

export type HeapRecord = Record<string, Value>;

/** Local, module-bound snapshot. Durable wire snapshots use the fabric schema. */
export interface ProductionSnapshot {
  readonly format: 'aether.production-state/local-1';
  readonly module: NodeRef;
  readonly nextAddress: number;
  readonly records: readonly { readonly address: number; readonly fields: readonly (readonly [string, Value])[] }[];
}

function copyValue(value: Value, addresses: ReadonlySet<number>, opaque: boolean, depth = 0): Value {
  if (depth > 256) throw new RangeError('heap value exceeds snapshot depth limit');
  if (value === null || typeof value === 'bigint' || typeof value === 'boolean' || typeof value === 'string') return value;
  if (isClosureValue(value) || isTaskValue(value)) {
    if (opaque) return value; // local synchronous calls only; never migration/export
    throw new TypeError('live closures and tasks cannot be migrated');
  }
  if (isRef(value)) {
    if (!Number.isSafeInteger(value.addr) || value.addr < 1 || !addresses.has(value.addr)) throw new RangeError(`dangling heap reference @${value.addr}`);
    return { addr: value.addr };
  }
  if (isSeqValue(value)) return value.map(item => copyValue(item, addresses, opaque, depth + 1));
  if (isResultValue(value) && (value.variant === 'ok' || value.variant === 'err')) {
    return { variant: value.variant, value: copyValue(value.value, addresses, opaque, depth + 1) };
  }
  throw new TypeError('unsupported heap snapshot value');
}

/** Clone all containers while references retain logical address identity. */
export function copyHeap(heap: readonly HeapRecord[], opaque = false): HeapRecord[] {
  const addresses = new Set(Array.from({ length: heap.length - 1 }, (_, i) => i + 1));
  return [Object.create(null), ...heap.slice(1).map(record => {
    if (!record) throw new TypeError('sparse heap cannot be snapshotted');
    return Object.fromEntries(Object.entries(record).map(([field, value]) => [field, copyValue(value, addresses, opaque)]));
  })];
}

export function snapshotHeap(heap: readonly HeapRecord[], module: NodeRef): ProductionSnapshot {
  const clone = copyHeap(heap);
  return {
    format: 'aether.production-state/local-1', module, nextAddress: clone.length,
    records: clone.slice(1).map((record, i) => ({ address: i + 1, fields: Object.entries(record) })),
  };
}

export function restoreHeap(snapshot: ProductionSnapshot, module: NodeRef): HeapRecord[] {
  if (snapshot.format !== 'aether.production-state/local-1' || snapshot.module !== module) throw new TypeError('snapshot format/module mismatch');
  if (!Number.isSafeInteger(snapshot.nextAddress) || snapshot.nextAddress < 1 || !Array.isArray(snapshot.records)
    || snapshot.records.length !== snapshot.nextAddress - 1) throw new TypeError('invalid snapshot allocator');
  const heap: HeapRecord[] = [Object.create(null)];
  for (const record of snapshot.records) {
    if (record.address !== heap.length || !Array.isArray(record.fields)) throw new TypeError('snapshot addresses must be contiguous and unique');
    const fields: HeapRecord = Object.create(null);
    for (const entry of record.fields) {
      if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string' || Object.hasOwn(fields, entry[0])) throw new TypeError('invalid or duplicate snapshot field');
      fields[entry[0]] = entry[1];
    }
    heap.push(fields);
  }
  return copyHeap(heap);
}
