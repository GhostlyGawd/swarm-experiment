import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { domainDigest, type Digest } from '../../../../src/fabric/identity.ts';
import { MACHINE_LIMITS } from '../../../../src/tier3/resumable-state.ts';
import type { ResumableProgram } from '../../../../src/tier3/resumable-program.ts';
import { PackedHeap, unpackResumableCheckpoint, type PackedField, type PackedHeapImage, type PackedResumableCheckpoint } from '../../../../src/tier3/packed-heap.ts';
import { sha256 } from './build.ts';

const HEADER = 48, HEADER_V2 = 64, ROW = 8, OP = 40, RESULT = 16, STRING_ENTRY = 8;
const MAGIC = 0x47504541, DONE = 0x454e4f44;
const kinds = { readInt: 1, addInt: 2, readBool: 3, readRef: 4, readString: 5, equalsString: 6 } as const;
export type GuestOperation =
  | { readonly kind: 'readInt' | 'readBool' | 'readRef'; readonly id: string; readonly field: string }
  | { readonly kind: 'readString'; readonly id: string; readonly field: string }
  | { readonly kind: 'addInt'; readonly id: string; readonly field: string; readonly increment: string }
  | { readonly kind: 'equalsString'; readonly id: string; readonly field: string; readonly otherId: string; readonly otherField: string };
export interface GuestResult {
  readonly format: 'aether.packed-hvf-guest-result/1';
  readonly inputSnapshotDigest: Digest;
  readonly layoutDigest: Digest;
  readonly driverSha256: string;
  readonly guestSha256: string;
  readonly observations: readonly { readonly kind: GuestOperation['kind']; readonly status: number; readonly value: string }[];
  readonly diagnostics: {
    readonly mainStartTick: string; readonly guestStartTick: string; readonly runStartTick: string;
    readonly validatedResponseTick: string; readonly tickNs: number;
    readonly mainToResponseNs: number; readonly freshGuestToValidatedResponseNs: number;
    readonly hvVcpuRunToValidatedResponseNs: number; readonly guestImageBytes: number;
    readonly guestMappedBytes: number; readonly guestResidentObservedBytes: number;
    readonly guestResidentPeakUpperBoundBytes: number; readonly controllerCurrentRssBytes: number;
    readonly controllerPeakRssBytes: number; readonly processLaunchToExitNs: number;
    readonly campaignWarmups?: number;
    readonly campaignSamples?: readonly { readonly ordinal: number; readonly residentBytes: number;
      readonly ticks: readonly number[] }[];
  };
  /** A candidate image only. The runtime must authorize and journal corrections. */
  readonly candidateHeap: PackedHeapImage;
}
const signed64 = (value: string): bigint => {
  if (typeof value !== 'string' || !/^(0|-?[1-9][0-9]*)$/.test(value)) throw new TypeError('invalid signed guest decimal');
  const integer = BigInt(value);
  if (integer < -(1n << 63n) || integer > (1n << 63n) - 1n) throw new RangeError('signed guest decimal exceeds i64');
  return integer;
};
const width = (span: bigint): number => span === 0n ? 0 : span.toString(2).length;
const stringHash = (value: string): bigint => {
  let hash = 14695981039346656037n;
  for (const byte of Buffer.from(value, 'utf8')) hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 1099511628211n);
  return hash;
};
const fieldWidth = (field: PackedField): number => {
  if (field.kind === 'bool') return 1;
  if (field.kind === 'ref') return width(BigInt(2 * field.maxRelative + 1));
  if (field.kind === 'int') return width(BigInt(field.max) - BigInt(field.min));
  if (field.kind === 'string') return 12;
  throw new TypeError('unsupported packed field');
};
/** Runs an authenticated resumable checkpoint through an actual EL1 guest.
 * The bounded field plan is host derived; the guest independently checks its
 * frame, spans, widths and integer range before touching any packed byte. */
export function executePackedCheckpointGuest(args: {
  packed: PackedResumableCheckpoint;
  program: ResumableProgram;
  expectedSnapshotDigest: Digest;
  expectedLayoutDigest: Digest;
  driver: string;
  guestImage: string;
  expectedDriverSha256: string;
  expectedGuestSha256: string;
  operations: readonly GuestOperation[];
  /** Bounded repeated fresh guests in one running controller, for research. */
  campaign?: true;
}): GuestResult {
  unpackResumableCheckpoint(args.packed, args.program, args.expectedSnapshotDigest, args.expectedLayoutDigest);
  const image = args.packed.heap, model = PackedHeap.fromImage(image, args.expectedLayoutDigest);
  const v2 = image.format === 'aether.packed-heap/2';
  if (sha256(readFileSync(args.driver)) !== args.expectedDriverSha256 ||
      sha256(readFileSync(args.guestImage)) !== args.expectedGuestSha256)
    throw new TypeError('packed guest executable digest mismatch');
  if (!Array.isArray(args.operations) || model.rows.length < 1 || model.rows.length > 1024 ||
      args.operations.length > 256 || model.byteLength > 16384) throw new RangeError('packed guest profile limit');
  const raw = Buffer.from(image.bytes, 'base64');
  const stringEntries = v2 ? image.stringEntries! : [];
  const stringBytes = v2 ? Buffer.from(image.stringBytes!, 'base64') : Buffer.alloc(0);
  const bits = model.rows.reduce((sum, row) => sum + row.bitLength, 0);
  const rowsAt = v2 ? HEADER_V2 : HEADER, opsAt = rowsAt + model.rows.length * ROW;
  const resultsAt = opsAt + args.operations.length * OP, bytesAt = resultsAt + args.operations.length * RESULT;
  const entriesAt = bytesAt + raw.length, stringsAt = entriesAt + stringEntries.length * STRING_ENTRY;
  const frameLength = stringsAt + stringBytes.length;
  if (frameLength > 32768) throw new RangeError('packed guest frame exceeds two pages');
  const frame = Buffer.alloc(frameLength);
  frame.writeUInt32LE(MAGIC, 0); frame.writeUInt32LE(v2 ? 2 : 1, 4); frame.writeUInt32LE(frameLength, 8);
  frame.writeUInt32LE(model.rows.length, 12); frame.writeUInt32LE(args.operations.length, 16);
  frame.writeUInt32LE(bits, 20); frame.writeUInt32LE(raw.length, 24);
  frame.writeUInt32LE(rowsAt, 28); frame.writeUInt32LE(opsAt, 32);
  frame.writeUInt32LE(bytesAt, 36); frame.writeUInt32LE(resultsAt, 40);
  if (v2) {
    frame.writeUInt32LE(stringEntries.length, 48); frame.writeUInt32LE(entriesAt, 52);
    frame.writeUInt32LE(stringsAt, 56); frame.writeUInt32LE(stringBytes.length, 60);
  }
  model.rows.forEach((row, index) => {
    frame.writeUInt32LE(row.bitOffset, rowsAt + index * ROW);
    frame.writeUInt32LE(row.bitLength, rowsAt + index * ROW + 4);
  });
  raw.copy(frame, bytesAt);
  stringEntries.forEach((entry, index) => {
    frame.writeUInt32LE(entry.offset, entriesAt + index * STRING_ENTRY);
    frame.writeUInt32LE(entry.length, entriesAt + index * STRING_ENTRY + 4);
  });
  stringBytes.copy(frame, stringsAt);
  const byId = new Map(model.rows.map((row, index) => [row.id, index]));
  const byType = new Map(model.layouts.map(layout => [layout.typeName, layout]));
  const expected: GuestResult['observations'][number][] = [];
  const operations: readonly GuestOperation[] = args.operations;
  operations.forEach((operation, index) => {
    if (!operation || typeof operation !== 'object' ||
        !Object.hasOwn(kinds, operation.kind) || typeof operation.id !== 'string' ||
        typeof operation.field !== 'string') throw new TypeError('invalid packed guest operation');
    const ordinal = byId.get(operation.id);
    if (ordinal === undefined) throw new ReferenceError('unknown packed guest record');
    const row = model.rows[ordinal], layout = byType.get(row.typeName)!;
    const fieldIndex = layout.fields.findIndex(field => field.name === operation.field);
    if (fieldIndex < 0) throw new ReferenceError('unknown packed guest field');
    const field = layout.fields[fieldIndex];
    const offset = row.bitOffset + layout.fields.slice(0, fieldIndex).reduce((sum, item) => sum + fieldWidth(item), 0);
    const bits = fieldWidth(field), at = opsAt + index * OP;
    frame.writeUInt32LE(kinds[operation.kind], at); frame.writeUInt32LE(ordinal, at + 4);
    frame.writeUInt32LE(offset, at + 8); frame.writeUInt32LE(bits, at + 12);
    let status = 0, value = '0', native = 0n;
    if ((operation.kind === 'readInt' || operation.kind === 'addInt') && field.kind === 'int') {
      const min = signed64(field.min), max = signed64(field.max);
      frame.writeBigInt64LE(min, at + 16); frame.writeBigInt64LE(max, at + 24);
      const prior = model.get(operation.id, operation.field);
      if (prior.tag !== 'int') throw new TypeError('invalid packed integer model');
      value = prior.value;
      if (operation.kind === 'addInt') {
        if (field.overflow !== 'trap') throw new TypeError('packed guest add supports trap policy only');
        const increment = signed64(operation.increment);
        frame.writeBigInt64LE(increment, at + 32);
        try { model.add(operation.id, operation.field, increment); value = (model.get(operation.id, operation.field) as typeof prior).value; }
        catch (error) { if (!(error instanceof RangeError) || !String(error).includes('overflow')) throw error; status = 3; }
      }
      native = BigInt(value);
    } else if (operation.kind === 'readBool' && field.kind === 'bool') {
      const current = model.get(operation.id, operation.field);
      if (current.tag !== 'bool') throw new TypeError('invalid packed boolean model');
      value = current.value ? '1' : '0'; native = BigInt(value);
    } else if ((operation.kind === 'readString' || operation.kind === 'equalsString') && field.kind === 'string') {
      if (!v2) throw new TypeError('string operation requires packed /2 image');
      frame.writeUInt32LE(field.maxUtf8Bytes, at + 16);
      const current = model.get(operation.id, operation.field);
      if (current.tag !== 'string') throw new TypeError('invalid packed string model');
      if (operation.kind === 'readString') {
        value = current.value; native = stringHash(value);
      } else {
        if (typeof operation.otherId !== 'string' || typeof operation.otherField !== 'string') throw new TypeError('invalid packed guest string equality operand');
        const otherOrdinal = byId.get(operation.otherId);
        if (otherOrdinal === undefined) throw new ReferenceError('unknown packed guest string equality record');
        const otherRow = model.rows[otherOrdinal], otherLayout = byType.get(otherRow.typeName)!;
        const otherIndex = otherLayout.fields.findIndex(item => item.name === operation.otherField);
        if (otherIndex < 0 || otherLayout.fields[otherIndex].kind !== 'string') throw new TypeError('invalid packed guest string equality field');
        const otherField = otherLayout.fields[otherIndex] as Extract<PackedField, { kind: 'string' }>;
        const otherOffset = otherRow.bitOffset + otherLayout.fields.slice(0, otherIndex).reduce((sum, item) => sum + fieldWidth(item), 0);
        frame.writeUInt32LE(otherOrdinal, at + 20); frame.writeUInt32LE(otherOffset, at + 24);
        frame.writeUInt32LE(12, at + 28); frame.writeUInt32LE(otherField.maxUtf8Bytes, at + 32);
        const other = model.get(operation.otherId, operation.otherField);
        if (other.tag !== 'string') throw new TypeError('invalid packed guest string equality model');
        value = current.value === other.value ? '1' : '0'; native = BigInt(value);
      }
    } else if (operation.kind === 'readRef' && field.kind === 'ref') {
      const current = model.get(operation.id, operation.field);
      if (current.tag === 'null') value = 'null';
      else if (current.tag === 'ref') {
        const target = byId.get(current.value.objectId);
        if (target === undefined || model.rows[target].epoch !== current.value.ownerEpoch) throw new TypeError('stale packed reference');
        const distance = target - ordinal;
        native = BigInt(distance >= 0 ? 2 * distance + 1 : -2 * distance);
        value = `${current.value.objectId}@${current.value.ownerEpoch}`;
      } else throw new TypeError('invalid packed reference model');
    } else throw new TypeError('unsupported packed guest operation/field');
    const result = resultsAt + index * RESULT;
    frame.writeUInt32LE(status, result); frame.writeUInt32LE(kinds[operation.kind], result + 4);
    frame.writeBigUInt64LE(BigInt.asUintN(64, native), result + 8);
    expected.push({ kind: operation.kind, status, value });
  });
  const final = Buffer.from(model.image().bytes, 'base64');
  final.copy(frame, bytesAt);
  frame.writeUInt32LE(DONE, 44);
  const initial = Buffer.from(frame);
  raw.copy(initial, bytesAt); initial.fill(0, resultsAt, bytesAt); initial.writeUInt32LE(0, 44);
  const processStart = process.hrtime.bigint();
  const run = spawnSync(args.driver, [args.guestImage], {
    input: initial, timeout: args.campaign ? 30000 : 5000, killSignal: 'SIGKILL',
    maxBuffer: args.campaign ? 1024 * 1024 : 65536,
  });
  const processLaunchToExitNs = Number(process.hrtime.bigint() - processStart);
  if (run.error || run.status !== 0 || run.signal) throw new Error(`packed EL1 guest failed: ${String(run.error ?? run.signal ?? run.status)}; ${run.stderr.toString('utf8')}`);
  const output = run.stdout;
  if (!output.equals(frame)) throw new TypeError('EL1 packed guest/reference frame mismatch');
  let diagnostic: Record<string, unknown>;
  try { diagnostic = JSON.parse(run.stderr.toString('utf8').trim()) as Record<string, unknown>; }
  catch { throw new TypeError('missing packed EL1 guest diagnostic'); }
  const tickKeys = ['mainStartTick', 'guestStartTick', 'runStartTick', 'validatedResponseTick'] as const;
  const numberKeys = ['tickNs', 'mainToResponseNs', 'freshGuestToValidatedResponseNs',
    'hvVcpuRunToValidatedResponseNs', 'guestImageBytes', 'guestMappedBytes',
    'guestResidentObservedBytes', 'guestResidentPeakUpperBoundBytes',
    'controllerCurrentRssBytes', 'controllerPeakRssBytes'] as const;
  if (diagnostic.kind !== 'packed_hvf_guest_sample' || tickKeys.some(key => !Number.isSafeInteger(diagnostic[key]) || Number(diagnostic[key]) < 0) ||
      numberKeys.some(key => typeof diagnostic[key] !== 'number' || !Number.isFinite(diagnostic[key]) || diagnostic[key] < 0) ||
      !(Number(diagnostic.mainStartTick) <= Number(diagnostic.guestStartTick) &&
        Number(diagnostic.guestStartTick) <= Number(diagnostic.runStartTick) &&
        Number(diagnostic.runStartTick) <= Number(diagnostic.validatedResponseTick)) ||
      diagnostic.guestMappedBytes !== 65536 || Number(diagnostic.guestResidentObservedBytes) > 65536 ||
      diagnostic.guestImageBytes !== readFileSync(args.guestImage).length)
    throw new TypeError('invalid packed EL1 guest diagnostic');
  if (args.campaign) {
    const samples = diagnostic.campaignSamples;
    if (diagnostic.campaignWarmups !== 20 || !Array.isArray(samples) || samples.length !== 1000)
      throw new TypeError('invalid packed EL1 campaign count');
    for (let index = 0; index < samples.length; index++) {
      const sample = samples[index] as Record<string, unknown>;
      const ticks = sample?.ticks;
      if (!sample || sample.ordinal !== index || sample.residentBytes !== 65536 ||
          !Array.isArray(ticks) || ticks.length !== 7 ||
          ticks.some(tick => !Number.isSafeInteger(tick) || tick < 0) ||
          ticks.some((tick, step) => step > 0 && tick < ticks[step - 1]))
        throw new TypeError('invalid packed EL1 campaign sample');
      if (index > 0 && ticks[0] < (samples[index - 1] as { ticks: number[] }).ticks[6])
        throw new TypeError('overlapping packed EL1 campaign sample');
    }
    const last = samples[999] as { ticks: number[] };
    if (last.ticks[0] !== diagnostic.guestStartTick || last.ticks[5] !== diagnostic.runStartTick ||
        last.ticks[6] !== diagnostic.validatedResponseTick)
      throw new TypeError('packed EL1 campaign final tick mismatch');
  }
  const diagnostics = { ...diagnostic, mainStartTick: String(diagnostic.mainStartTick),
    guestStartTick: String(diagnostic.guestStartTick), runStartTick: String(diagnostic.runStartTick),
    validatedResponseTick: String(diagnostic.validatedResponseTick), processLaunchToExitNs } as GuestResult['diagnostics'];
  const { imageDigest: _old, ...body } = image;
  const candidateBody = { ...body, bytes: output.subarray(bytesAt, bytesAt + raw.length).toString('base64') };
  const candidateHeap = { ...candidateBody, imageDigest: domainDigest(`aether.packed-heap-image/${v2 ? '2' : '1'}`, candidateBody, MACHINE_LIMITS) };
  PackedHeap.fromImage(candidateHeap, args.expectedLayoutDigest);
  return { format: 'aether.packed-hvf-guest-result/1', inputSnapshotDigest: args.expectedSnapshotDigest,
    layoutDigest: image.layoutDigest, driverSha256: args.expectedDriverSha256,
    guestSha256: args.expectedGuestSha256, observations: expected, diagnostics, candidateHeap };
}
