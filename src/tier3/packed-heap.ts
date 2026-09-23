/** Versioned, pointerless record image. Logical record IDs and epochs remain the
 * authority; byte and bit offsets are local addresses within one image only. */
import type { Ty } from '../tier1/ast.ts';
import { domainDigest, type Digest } from '../fabric/identity.ts';
import { exactObject, identifier } from '../fabric/encoding.ts';
import type { ResumableProgram } from './resumable-program.ts';
import { MACHINE_LIMITS, checkpointDigest, machineClone, validateMachineValue, validateResumableSnapshot, type MachineRecord, type MachineValue, type ResumableSnapshot } from './resumable-state.ts';

export type PackedField =
  | { readonly name: string; readonly kind: 'int'; readonly min: string; readonly max: string; readonly overflow: 'trap' | 'wrap' | 'saturate' }
  | { readonly name: string; readonly kind: 'bool' }
  | { readonly name: string; readonly kind: 'ref'; readonly maxRelative: number };
export interface PackedLayout { readonly typeName: string; readonly fields: readonly PackedField[] }
export interface PackedRowHeader { readonly id: string; readonly epoch: string; readonly version: string; readonly ty: Ty; readonly typeName: string; readonly bitOffset: number; readonly bitLength: number }
export interface PackedHeapImage {
  readonly format: 'aether.packed-heap/1'; readonly heapId: string; readonly layouts: readonly PackedLayout[];
  readonly layoutDigest: Digest; readonly rows: readonly PackedRowHeader[]; readonly bytes: string; readonly imageDigest: Digest;
}
export interface PackedResumableCheckpoint {
  readonly format: 'aether.packed-resumable-checkpoint/1'; readonly snapshotDigest: Digest;
  readonly spine: Omit<ResumableSnapshot, 'core'> & { readonly core: Omit<ResumableSnapshot['core'], 'records'> };
  readonly heap: PackedHeapImage;
}

const decimal = (value: string): bigint => {
  if (typeof value !== 'string' || !/^(0|-?[1-9][0-9]*)$/.test(value)) throw new TypeError('invalid canonical decimal');
  return BigInt(value);
};
const unsigned = (value: string): bigint => {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) throw new TypeError('invalid unsigned packed decimal');
  return BigInt(value);
};
const positiveId = (value: string): bigint => { const result = unsigned(value); if (result < 1n) throw new RangeError('invalid packed record ID'); return result; };
const width = (range: bigint): number => { if (range < 0n || range > (1n << 64n) - 1n) throw new RangeError('packed field span exceeds 64 bits'); return range === 0n ? 0 : range.toString(2).length; };
const fieldWidth = (field: PackedField): number => {
  if (field.kind === 'bool') return 1;
  if (field.kind === 'int') return width(decimal(field.max) - decimal(field.min));
  if (!Number.isSafeInteger(field.maxRelative) || field.maxRelative < 0 || field.maxRelative > 20_000) throw new RangeError('invalid relative reference bound');
  return width(BigInt(2 * field.maxRelative + 1));
};
const representation = (ty: Ty): Ty => ty.t === 'Nominal' ? representation(ty.repr) : ty.t === 'Owned' ? representation(ty.inner) : ty;
const compatibleField = (field: PackedField, ty: Ty): boolean => {
  const repr = representation(ty);
  if (field.kind === 'bool') return repr.t === 'Bool';
  if (field.kind === 'ref') return repr.t === 'Record' || repr.t === 'Unit';
  if (repr.t === 'Int') return true;
  if (repr.t !== 'IntN' || repr.overflow !== field.overflow) return false;
  const min = repr.signed ? -(1n << BigInt(repr.bits - 1)) : 0n;
  const max = repr.signed ? (1n << BigInt(repr.bits - 1)) - 1n : (1n << BigInt(repr.bits)) - 1n;
  return decimal(field.min) >= min && decimal(field.max) <= max;
};
const layoutBits = (layout: PackedLayout): number => layout.fields.reduce((sum, field) => sum + fieldWidth(field), 0);
const checkedLayouts = (input: readonly PackedLayout[]): PackedLayout[] => {
  if (!Array.isArray(input) || input.length > 1024) throw new RangeError('invalid packed layout table');
  const names = new Set<string>();
  return machineClone(input).map(layout => {
    exactObject(layout, ['typeName', 'fields']); identifier(layout.typeName);
    if (names.has(layout.typeName) || !Array.isArray(layout.fields) || layout.fields.length > 1024) throw new TypeError('duplicate or invalid packed layout');
    names.add(layout.typeName); const fields = new Set<string>();
    for (const field of layout.fields) {
      exactObject(field, field.kind === 'int' ? ['name', 'kind', 'min', 'max', 'overflow']
        : field.kind === 'bool' ? ['name', 'kind'] : ['name', 'kind', 'maxRelative']);
      identifier(field.name);
      if (fields.has(field.name)) throw new TypeError('duplicate or invalid packed field');
      fields.add(field.name);
      if (field.kind === 'int') { if (decimal(field.min) > decimal(field.max) || !['trap', 'wrap', 'saturate'].includes(field.overflow)) throw new RangeError('invalid bounded integer field'); }
      else if (field.kind !== 'bool' && field.kind !== 'ref') throw new TypeError('unsupported packed field kind');
      fieldWidth(field);
    }
    if (layoutBits(layout) > 8192) throw new RangeError('packed row width limit');
    return layout;
  });
};
const bit = (bytes: Uint8Array, position: number): number => (bytes[position >>> 3] >>> (position & 7)) & 1;
const read = (bytes: Uint8Array, offset: number, count: number): bigint => { let result = 0n; for (let i = 0; i < count; i++) result |= BigInt(bit(bytes, offset + i)) << BigInt(i); return result; };
const write = (bytes: Uint8Array, offset: number, count: number, value: bigint): void => {
  if (value < 0n || value >= 1n << BigInt(count)) throw new RangeError('packed value exceeds field width');
  for (let i = 0; i < count; i++) { const index = (offset + i) >>> 3, mask = 1 << ((offset + i) & 7); if ((value >> BigInt(i)) & 1n) bytes[index] |= mask; else bytes[index] &= ~mask; }
};
const digestBody = (image: Omit<PackedHeapImage, 'imageDigest'>): Digest => domainDigest('aether.packed-heap-image/1', image, MACHINE_LIMITS);
const deepFreeze = <T>(value: T): T => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
};

export class PackedHeap {
  readonly heapId: string;
  readonly layouts: readonly PackedLayout[];
  readonly rows: readonly PackedRowHeader[];
  readonly #bytes: Uint8Array;
  readonly #byId: Map<string, number>;
  readonly #byType: Map<string, PackedLayout>;

  private constructor(heapId: string, layouts: readonly PackedLayout[], rows: readonly PackedRowHeader[], bytes: Uint8Array) {
    this.heapId = heapId; this.layouts = deepFreeze(checkedLayouts(layouts)); this.rows = deepFreeze(machineClone(rows)); this.#bytes = Uint8Array.from(bytes);
    this.#byId = new Map(this.rows.map((row, index) => [row.id, index]));
    this.#byType = new Map(this.layouts.map(layout => [layout.typeName, layout]));
    identifier(heapId);
    if (this.#byId.size !== this.rows.length || this.rows.length > 20_000) throw new TypeError('invalid packed heap identity/table');
    let end = 0;
    for (const row of this.rows) {
      exactObject(row, ['id', 'epoch', 'version', 'ty', 'typeName', 'bitOffset', 'bitLength']);
      positiveId(row.id); unsigned(row.epoch); unsigned(row.version);
      const layout = this.#byType.get(row.typeName);
      if (!layout || row.ty.t !== 'Record' || row.ty.name !== row.typeName || row.ty.fields.length !== layout.fields.length || row.ty.fields.some(([name, ty], i) => name !== layout.fields[i].name || !compatibleField(layout.fields[i], ty))) throw new TypeError('packed row/type layout mismatch');
      if (!Number.isSafeInteger(row.bitOffset) || row.bitOffset !== end || row.bitLength !== layoutBits(layout)) throw new RangeError('invalid packed row offset/length');
      end += row.bitLength;
    }
    if (this.#bytes.length !== Math.ceil(end / 8) || this.#bytes.length && Array.from({ length: this.#bytes.length * 8 - end }, (_, i) => bit(this.#bytes, end + i)).some(Boolean)) throw new RangeError('noncanonical packed heap byte length/padding');
    for (const row of this.rows) this.readRecord(row.id); // Validate every relative reference and bit pattern.
  }

  static pack(records: readonly MachineRecord[], heapId: string, layouts: readonly PackedLayout[]): PackedHeap {
    const checked = checkedLayouts(layouts), byType = new Map(checked.map(layout => [layout.typeName, layout]));
    // Snapshot caller-owned rows before any field access. Canonical encoding
    // refuses proxies, accessors, sparse arrays and unsupported values.
    const source = machineClone(records);
    if (!Array.isArray(source) || source.length > 20_000) throw new RangeError('invalid packed record table');
    let next = 0;
    const rows = source.map(record => {
      if (record.ty?.t !== 'Record') throw new TypeError('only typed records can be packed');
      const layout = byType.get(record.ty.name); if (!layout) throw new TypeError('missing packed layout');
      const row: PackedRowHeader = { id: record.id, epoch: record.epoch, version: record.version, ty: record.ty, typeName: record.ty.name, bitOffset: next, bitLength: layoutBits(layout) };
      next += row.bitLength; return row;
    });
    const heap = new PackedHeap(heapId, checked, rows, new Uint8Array(Math.ceil(next / 8)));
    source.forEach(record => {
      const fields = new Map<string, MachineValue>(record.fields);
      if (fields.size !== record.fields.length || fields.size !== heap.#byType.get((record.ty as Extract<Ty, { t: 'Record' }>).name)!.fields.length) throw new TypeError('duplicate or missing packed record field');
      for (const field of heap.#byType.get((record.ty as Extract<Ty, { t: 'Record' }>).name)!.fields) {
        const value = fields.get(field.name); if (value === undefined) throw new TypeError('missing packed record field');
        heap.set(record.id, field.name, value);
      }
    });
    return heap;
  }

  static fromImage(image: PackedHeapImage, expectedLayoutDigest?: Digest): PackedHeap {
    exactObject(image, ['format', 'heapId', 'layouts', 'layoutDigest', 'rows', 'bytes', 'imageDigest']);
    if (image?.format !== 'aether.packed-heap/1' || typeof image.bytes !== 'string' || image.bytes.length > 32 * 1024 * 1024 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(image.bytes)) throw new TypeError('invalid packed heap image');
    const { imageDigest, ...body } = image;
    if (image.layoutDigest !== domainDigest('aether.packed-layout/1', image.layouts) || expectedLayoutDigest && expectedLayoutDigest !== image.layoutDigest || imageDigest !== digestBody(body)) throw new TypeError('packed image/layout digest mismatch');
    const bytes = Buffer.from(image.bytes, 'base64'); if (bytes.toString('base64') !== image.bytes) throw new TypeError('noncanonical packed base64');
    return new PackedHeap(image.heapId, image.layouts, image.rows, bytes);
  }

  private slot(id: string, fieldName: string): { field: PackedField; offset: number; rowIndex: number } {
    const rowIndex = this.#byId.get(id); if (rowIndex === undefined) throw new ReferenceError('unknown packed record ID');
    const row = this.rows[rowIndex], layout = this.#byType.get(row.typeName)!;
    let offset = row.bitOffset;
    for (const field of layout.fields) { if (field.name === fieldName) return { field, offset, rowIndex }; offset += fieldWidth(field); }
    throw new ReferenceError('unknown packed record field');
  }
  get(id: string, fieldName: string): MachineValue {
    const { field, offset, rowIndex } = this.slot(id, fieldName), code = read(this.#bytes, offset, fieldWidth(field));
    if (field.kind === 'bool') return { tag: 'bool', value: code === 1n };
    if (field.kind === 'int') { const value = decimal(field.min) + code; if (value > decimal(field.max)) throw new RangeError('invalid packed integer bit pattern'); return { tag: 'int', value: String(value) }; }
    if (code === 0n) return { tag: 'null' };
    const magnitude = Number(code % 2n ? (code - 1n) / 2n : code / 2n), delta = code % 2n ? magnitude : -magnitude;
    if (Math.abs(delta) > field.maxRelative) throw new RangeError('relative reference exceeds bound');
    const target = this.rows[rowIndex + delta]; if (!target) throw new RangeError('relative reference outside packed heap');
    return { tag: 'ref', value: { heapId: this.heapId, objectId: target.id, ownerEpoch: target.epoch } };
  }
  readRecord(id: string): MachineRecord {
    const rowIndex = this.#byId.get(id); if (rowIndex === undefined) throw new ReferenceError('unknown packed record ID');
    const row = this.rows[rowIndex], layout = this.#byType.get(row.typeName)!;
    return { id: row.id, epoch: row.epoch, version: row.version, ty: machineClone(row.ty), fields: layout.fields.map(field => [field.name, this.get(id, field.name)]) };
  }
  unpack(): MachineRecord[] { return this.rows.map(row => this.readRecord(row.id)); }
  set(id: string, fieldName: string, value: MachineValue): void {
    validateMachineValue(value);
    const { field, offset, rowIndex } = this.slot(id, fieldName); let code: bigint;
    if (field.kind === 'bool' && value.tag === 'bool') code = value.value ? 1n : 0n;
    else if (field.kind === 'int' && value.tag === 'int') {
      const integer = decimal(value.value), min = decimal(field.min), max = decimal(field.max);
      if (integer < min || integer > max) throw new RangeError('integer outside packed field bound'); code = integer - min;
    } else if (field.kind === 'ref' && value.tag === 'null') code = 0n;
    else if (field.kind === 'ref' && value.tag === 'ref') {
      const targetIndex = this.#byId.get(value.value.objectId);
      if (value.value.heapId !== this.heapId || targetIndex === undefined || this.rows[targetIndex].epoch !== value.value.ownerEpoch) throw new TypeError('dangling or stale packed reference');
      const delta = targetIndex - rowIndex;
      if (Math.abs(delta) > field.maxRelative) throw new RangeError('relative reference exceeds bound');
      code = BigInt(delta >= 0 ? 2 * delta + 1 : -2 * delta);
    } else throw new TypeError('packed field value kind mismatch');
    write(this.#bytes, offset, fieldWidth(field), code);
  }
  add(id: string, fieldName: string, increment: bigint): void {
    const { field } = this.slot(id, fieldName); if (field.kind !== 'int' || typeof increment !== 'bigint') throw new TypeError('bounded integer field required');
    const prior = this.get(id, fieldName) as Extract<MachineValue, { tag: 'int' }>;
    const min = decimal(field.min), max = decimal(field.max), requested = BigInt(prior.value) + increment;
    if (field.overflow === 'trap' && (requested < min || requested > max)) throw new RangeError('packed integer overflow');
    const span = max - min + 1n;
    const result = field.overflow === 'wrap' ? min + (((requested - min) % span) + span) % span
      : field.overflow === 'saturate' ? (requested < min ? min : requested > max ? max : requested) : requested;
    this.set(id, fieldName, { tag: 'int', value: String(result) });
  }
  image(): PackedHeapImage {
    const body = { format: 'aether.packed-heap/1' as const, heapId: this.heapId, layouts: this.layouts, layoutDigest: domainDigest('aether.packed-layout/1', this.layouts), rows: this.rows, bytes: Buffer.from(this.#bytes).toString('base64') };
    return { ...body, imageDigest: digestBody(body) };
  }
  get byteLength(): number { return this.#bytes.byteLength; }
}

/** Repack through logical values. Any width change must still round-trip the
 * identical checkpoint digest; no native offset is allowed to become identity. */
export function migratePackedHeap(image: PackedHeapImage, layouts: readonly PackedLayout[]): PackedHeapImage {
  const source = PackedHeap.fromImage(image);
  const target = PackedHeap.pack(source.unpack(), source.heapId, layouts);
  return target.image();
}

export function packResumableCheckpoint(snapshot: ResumableSnapshot, program: ResumableProgram, layouts: readonly PackedLayout[]): PackedResumableCheckpoint {
  validateResumableSnapshot(snapshot, program);
  const logical = machineClone(snapshot), heap = PackedHeap.pack(logical.core.records, logical.core.heapId, layouts);
  const { records: _records, ...core } = logical.core;
  return { format: 'aether.packed-resumable-checkpoint/1', snapshotDigest: checkpointDigest(snapshot), spine: { format: logical.format, core, eventCursor: logical.eventCursor, eventHead: logical.eventHead, events: logical.events }, heap: heap.image() };
}
export function unpackResumableCheckpoint(packed: PackedResumableCheckpoint, program: ResumableProgram, expectedSnapshotDigest: Digest, expectedLayoutDigest?: Digest): ResumableSnapshot {
  if (packed?.format !== 'aether.packed-resumable-checkpoint/1') throw new TypeError('packed checkpoint version mismatch');
  if (packed.snapshotDigest !== expectedSnapshotDigest || Object.hasOwn(packed.spine.core, 'records')) throw new TypeError('packed checkpoint trusted digest/spine mismatch');
  const heap = PackedHeap.fromImage(packed.heap, expectedLayoutDigest);
  if (heap.heapId !== packed.spine.core.heapId) throw new TypeError('packed checkpoint heap identity mismatch');
  const snapshot = machineClone({ ...packed.spine, core: { ...packed.spine.core, records: heap.unpack() } }) as ResumableSnapshot;
  validateResumableSnapshot(snapshot, program);
  if (checkpointDigest(snapshot) !== packed.snapshotDigest) throw new TypeError('packed checkpoint logical digest mismatch');
  return snapshot;
}

export function migratePackedResumableCheckpoint(packed: PackedResumableCheckpoint, program: ResumableProgram, expectedSnapshotDigest: Digest, layouts: readonly PackedLayout[]): PackedResumableCheckpoint {
  const logical = unpackResumableCheckpoint(packed, program, expectedSnapshotDigest);
  const migrated = packResumableCheckpoint(logical, program, layouts);
  if (migrated.snapshotDigest !== expectedSnapshotDigest) throw new TypeError('packed checkpoint migration changed logical state');
  return migrated;
}
