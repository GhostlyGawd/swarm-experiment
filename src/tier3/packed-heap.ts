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
  | { readonly name: string; readonly kind: 'ref'; readonly maxRelative: number }
  | { readonly name: string; readonly kind: 'string'; readonly maxUtf8Bytes: number };
export interface PackedLayout { readonly typeName: string; readonly fields: readonly PackedField[] }
export interface PackedRowHeader { readonly id: string; readonly epoch: string; readonly version: string; readonly ty: Ty; readonly typeName: string; readonly bitOffset: number; readonly bitLength: number }
export interface PackedStringEntry { readonly offset: number; readonly length: number }
export interface PackedHeapImage {
  readonly format: 'aether.packed-heap/1' | 'aether.packed-heap/2'; readonly heapId: string; readonly layouts: readonly PackedLayout[];
  readonly layoutDigest: Digest; readonly rows: readonly PackedRowHeader[]; readonly bytes: string; readonly imageDigest: Digest;
  readonly stringEntries?: readonly PackedStringEntry[]; readonly stringBytes?: string;
}
export interface PackedResumableCheckpoint {
  readonly format: 'aether.packed-resumable-checkpoint/1' | 'aether.packed-resumable-checkpoint/2'; readonly snapshotDigest: Digest;
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
const MAX_STRING_ENTRIES = 4096;
const MAX_STRING_BYTES = 4096;
const MAX_STRING_ARENA_BYTES = MAX_STRING_ENTRIES * MAX_STRING_BYTES;
const base64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const utf8Bytes = (value: string, maxBytes: number): Uint8Array => {
  if (typeof value !== 'string') throw new TypeError('invalid packed string');
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length > maxBytes || new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) !== value) throw new RangeError('invalid or overlong packed UTF-8 string');
  return bytes;
};
const canonicalBase64 = (value: unknown, maxLength: number): Uint8Array => {
  if (typeof value !== 'string' || value.length > maxLength || !base64.test(value)) throw new TypeError('invalid packed base64');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value) throw new TypeError('noncanonical packed base64');
  return bytes;
};
const readStrings = (entries: unknown, encoded: unknown): string[] => {
  if (!Array.isArray(entries) || entries.length > MAX_STRING_ENTRIES) throw new RangeError('invalid packed string dictionary size');
  const arena = canonicalBase64(encoded, Math.ceil(MAX_STRING_ARENA_BYTES / 3) * 4);
  if (arena.length > MAX_STRING_ARENA_BYTES) throw new RangeError('packed string arena limit');
  const strings: string[] = [], seen = new Set<string>(); let end = 0;
  for (const entry of entries) {
    exactObject(entry, ['offset', 'length']);
    if (!Number.isSafeInteger(entry.offset) || entry.offset !== end || !Number.isSafeInteger(entry.length) || entry.length < 0 || entry.length > MAX_STRING_BYTES || end + entry.length > arena.length) throw new RangeError('invalid packed string offset/length');
    const bytes = arena.subarray(end, end + entry.length), value = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    if (Buffer.compare(Buffer.from(value, 'utf8'), bytes) || seen.has(value)) throw new TypeError('noncanonical or duplicate packed string dictionary');
    strings.push(value); seen.add(value); end += entry.length;
  }
  if (end !== arena.length) throw new RangeError('trailing packed string arena bytes');
  return strings;
};
const width = (range: bigint): number => { if (range < 0n || range > (1n << 64n) - 1n) throw new RangeError('packed field span exceeds 64 bits'); return range === 0n ? 0 : range.toString(2).length; };
const fieldWidth = (field: PackedField): number => {
  if (field.kind === 'bool') return 1;
  if (field.kind === 'int') return width(decimal(field.max) - decimal(field.min));
  if (field.kind === 'string') {
    if (!Number.isSafeInteger(field.maxUtf8Bytes) || field.maxUtf8Bytes < 0 || field.maxUtf8Bytes > MAX_STRING_BYTES) throw new RangeError('invalid packed UTF-8 bound');
    return 12; // Dictionary ordinals 0..4095; no host address is persisted.
  }
  if (!Number.isSafeInteger(field.maxRelative) || field.maxRelative < 0 || field.maxRelative > 20_000) throw new RangeError('invalid relative reference bound');
  return width(BigInt(2 * field.maxRelative + 1));
};
const representation = (ty: Ty): Ty => ty.t === 'Nominal' ? representation(ty.repr) : ty.t === 'Owned' ? representation(ty.inner) : ty;
const compatibleField = (field: PackedField, ty: Ty): boolean => {
  const repr = representation(ty);
  if (field.kind === 'bool') return repr.t === 'Bool';
  if (field.kind === 'ref') return repr.t === 'Record' || repr.t === 'Unit';
  if (field.kind === 'string') return repr.t === 'Str';
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
        : field.kind === 'bool' ? ['name', 'kind'] : field.kind === 'ref' ? ['name', 'kind', 'maxRelative'] : ['name', 'kind', 'maxUtf8Bytes']);
      identifier(field.name);
      if (fields.has(field.name)) throw new TypeError('duplicate or invalid packed field');
      fields.add(field.name);
      if (field.kind === 'int') { if (decimal(field.min) > decimal(field.max) || !['trap', 'wrap', 'saturate'].includes(field.overflow)) throw new RangeError('invalid bounded integer field'); }
      else if (field.kind !== 'bool' && field.kind !== 'ref' && field.kind !== 'string') throw new TypeError('unsupported packed field kind');
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
const digestBody = (image: Omit<PackedHeapImage, 'imageDigest'>): Digest => domainDigest(`aether.packed-heap-image/${image.format.endsWith('/2') ? '2' : '1'}`, image, MACHINE_LIMITS);
const layoutDigest = (format: PackedHeapImage['format'], layouts: readonly PackedLayout[]): Digest => domainDigest(`aether.packed-layout/${format.endsWith('/2') ? '2' : '1'}`, layouts);
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
  readonly format: PackedHeapImage['format'];
  #bytes: Uint8Array;
  #strings: string[];
  readonly #byId: Map<string, number>;
  readonly #byType: Map<string, PackedLayout>;

  private constructor(heapId: string, layouts: readonly PackedLayout[], rows: readonly PackedRowHeader[], bytes: Uint8Array, strings: readonly string[], validatePayload = true) {
    this.heapId = heapId; this.layouts = deepFreeze(checkedLayouts(layouts)); this.rows = deepFreeze(machineClone(rows)); this.#bytes = Uint8Array.from(bytes);
    this.format = this.layouts.some(layout => layout.fields.some(field => field.kind === 'string')) ? 'aether.packed-heap/2' : 'aether.packed-heap/1';
    if (strings.length > MAX_STRING_ENTRIES || this.format === 'aether.packed-heap/1' && strings.length) throw new RangeError('invalid packed string dictionary size');
    this.#strings = strings.map(value => { utf8Bytes(value, MAX_STRING_BYTES); return value; });
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
    if (validatePayload) this.validatePayload();
  }

  private validatePayload(): void {
    const firstUse = new Map<string, number>();
    for (const row of this.rows) {
      const layout = this.#byType.get(row.typeName)!;
      for (const field of layout.fields) {
        const value = this.get(row.id, field.name); // Validate references, bit patterns and UTF-8 bounds.
        if (field.kind === 'string' && value.tag === 'string' && !firstUse.has(value.value)) firstUse.set(value.value, firstUse.size);
      }
    }
    if (firstUse.size !== this.#strings.length || this.#strings.some((value, index) => firstUse.get(value) !== index)) throw new TypeError('noncanonical packed string dictionary order or unused entry');
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
    const strings: string[] = [], seenStrings = new Set<string>(); let arenaBytes = 0;
    for (const record of source) {
      const layout = byType.get((record.ty as Extract<Ty, { t: 'Record' }>).name)!;
      const fields = new Map<string, MachineValue>(record.fields);
      for (const field of layout.fields) if (field.kind === 'string') {
        const value = fields.get(field.name);
        if (value?.tag !== 'string') throw new TypeError('packed field value kind mismatch');
        const bytes = utf8Bytes(value.value, field.maxUtf8Bytes);
        if (!seenStrings.has(value.value)) {
          if (strings.length >= MAX_STRING_ENTRIES || arenaBytes + bytes.length > MAX_STRING_ARENA_BYTES) throw new RangeError('packed string dictionary limit');
          strings.push(value.value); seenStrings.add(value.value); arenaBytes += bytes.length;
        }
      }
    }
    const heap = new PackedHeap(heapId, checked, rows, new Uint8Array(Math.ceil(next / 8)), strings, false);
    source.forEach(record => {
      const fields = new Map<string, MachineValue>(record.fields);
      if (fields.size !== record.fields.length || fields.size !== heap.#byType.get((record.ty as Extract<Ty, { t: 'Record' }>).name)!.fields.length) throw new TypeError('duplicate or missing packed record field');
      for (const field of heap.#byType.get((record.ty as Extract<Ty, { t: 'Record' }>).name)!.fields) {
        const value = fields.get(field.name); if (value === undefined) throw new TypeError('missing packed record field');
        heap.setRaw(record.id, field.name, value);
      }
    });
    heap.validatePayload();
    return heap;
  }

  static fromImage(image: PackedHeapImage, expectedLayoutDigest?: Digest): PackedHeap {
    let format: PackedHeapImage['format'];
    try { exactObject(image, ['format', 'heapId', 'layouts', 'layoutDigest', 'rows', 'bytes', 'imageDigest']); format = 'aether.packed-heap/1'; }
    catch { exactObject(image, ['format', 'heapId', 'layouts', 'layoutDigest', 'rows', 'bytes', 'imageDigest', 'stringEntries', 'stringBytes']); format = 'aether.packed-heap/2'; }
    if (image.format !== format) throw new TypeError('invalid packed heap image version');
    const { imageDigest, ...body } = image;
    if (image.layoutDigest !== layoutDigest(format, image.layouts) || expectedLayoutDigest && expectedLayoutDigest !== image.layoutDigest || imageDigest !== digestBody(body)) throw new TypeError('packed image/layout digest mismatch');
    const bytes = canonicalBase64(image.bytes, 32 * 1024 * 1024);
    const strings = format === 'aether.packed-heap/2' ? readStrings(image.stringEntries, image.stringBytes) : [];
    const heap = new PackedHeap(image.heapId, image.layouts, image.rows, bytes, strings);
    if (heap.format !== format) throw new TypeError('packed image/layout version mismatch');
    return heap;
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
    if (field.kind === 'string') {
      const value = this.#strings[Number(code)];
      if (value === undefined) throw new RangeError('invalid packed string dictionary index');
      utf8Bytes(value, field.maxUtf8Bytes);
      return { tag: 'string', value };
    }
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
  private setRaw(id: string, fieldName: string, value: MachineValue): void {
    validateMachineValue(value);
    const { field, offset, rowIndex } = this.slot(id, fieldName); let code: bigint;
    if (field.kind === 'bool' && value.tag === 'bool') code = value.value ? 1n : 0n;
    else if (field.kind === 'int' && value.tag === 'int') {
      const integer = decimal(value.value), min = decimal(field.min), max = decimal(field.max);
      if (integer < min || integer > max) throw new RangeError('integer outside packed field bound'); code = integer - min;
    } else if (field.kind === 'ref' && value.tag === 'null') code = 0n;
    else if (field.kind === 'string' && value.tag === 'string') {
      utf8Bytes(value.value, field.maxUtf8Bytes);
      const index = this.#strings.indexOf(value.value);
      if (index < 0) throw new RangeError('packed string missing from dictionary');
      code = BigInt(index);
    }
    else if (field.kind === 'ref' && value.tag === 'ref') {
      const targetIndex = this.#byId.get(value.value.objectId);
      if (value.value.heapId !== this.heapId || targetIndex === undefined || this.rows[targetIndex].epoch !== value.value.ownerEpoch) throw new TypeError('dangling or stale packed reference');
      const delta = targetIndex - rowIndex;
      if (Math.abs(delta) > field.maxRelative) throw new RangeError('relative reference exceeds bound');
      code = BigInt(delta >= 0 ? 2 * delta + 1 : -2 * delta);
    } else throw new TypeError('packed field value kind mismatch');
    write(this.#bytes, offset, fieldWidth(field), code);
  }
  set(id: string, fieldName: string, value: MachineValue): void {
    const { field } = this.slot(id, fieldName);
    if (field.kind !== 'string') { this.setRaw(id, fieldName, value); return; }
    validateMachineValue(value);
    if (value.tag !== 'string') throw new TypeError('packed field value kind mismatch');
    utf8Bytes(value.value, field.maxUtf8Bytes);
    const records = this.unpack(), record = records.find(row => row.id === id)!;
    record.fields.find(([name]) => name === fieldName)![1] = value;
    const replacement = PackedHeap.pack(records, this.heapId, this.layouts);
    this.#bytes = Uint8Array.from(replacement.#bytes);
    this.#strings = [...replacement.#strings];
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
    const base = { format: this.format, heapId: this.heapId, layouts: this.layouts, layoutDigest: layoutDigest(this.format, this.layouts), rows: this.rows, bytes: Buffer.from(this.#bytes).toString('base64') };
    if (this.format === 'aether.packed-heap/1') return { ...base, imageDigest: digestBody(base) };
    const entries: PackedStringEntry[] = [], chunks: Uint8Array[] = []; let offset = 0;
    for (const value of this.#strings) {
      const bytes = utf8Bytes(value, MAX_STRING_BYTES);
      entries.push({ offset, length: bytes.length }); chunks.push(bytes); offset += bytes.length;
    }
    const body = { ...base, stringEntries: entries, stringBytes: Buffer.concat(chunks).toString('base64') };
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
  return { format: heap.format === 'aether.packed-heap/2' ? 'aether.packed-resumable-checkpoint/2' : 'aether.packed-resumable-checkpoint/1', snapshotDigest: checkpointDigest(snapshot), spine: { format: logical.format, core, eventCursor: logical.eventCursor, eventHead: logical.eventHead, events: logical.events }, heap: heap.image() };
}
export function unpackResumableCheckpoint(packed: PackedResumableCheckpoint, program: ResumableProgram, expectedSnapshotDigest: Digest, expectedLayoutDigest?: Digest): ResumableSnapshot {
  if (packed?.format !== 'aether.packed-resumable-checkpoint/1' && packed?.format !== 'aether.packed-resumable-checkpoint/2' || packed.format.endsWith('/1') !== packed.heap?.format?.endsWith('/1')) throw new TypeError('packed checkpoint version mismatch');
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
