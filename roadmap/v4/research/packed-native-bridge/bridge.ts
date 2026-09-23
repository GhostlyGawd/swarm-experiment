import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { domainDigest, type Digest } from '../../../../src/fabric/identity.ts';
import type { ResumableProgram } from '../../../../src/tier3/resumable-program.ts';
import { PackedHeap, unpackResumableCheckpoint, type PackedField, type PackedHeapImage, type PackedResumableCheckpoint } from '../../../../src/tier3/packed-heap.ts';
import { MACHINE_LIMITS } from '../../../../src/tier3/resumable-state.ts';

export type NativeOperation =
  | { readonly kind: 'readInt' | 'readBool' | 'readRef'; readonly id: string; readonly field: string }
  | { readonly kind: 'addInt'; readonly id: string; readonly field: string; readonly increment: string }
  | { readonly kind: 'setRef'; readonly id: string; readonly field: string; readonly targetId: string | null };

export interface NativeBridgeResult {
  readonly format: 'aether.packed-native-bridge-result/1';
  readonly inputSnapshotDigest: Digest;
  readonly layoutDigest: Digest;
  readonly executableSha256: string;
  readonly observations: readonly string[];
  /** Image only: mutations need a host-authorized event before checkpoint commit. */
  readonly candidateHeap: PackedHeapImage;
}

const nativeDecimal = (value: string): void => {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value) || value.length > 127) throw new RangeError('native bridge decimal identity/epoch profile limit');
};
const signed64 = (value: string): void => {
  if (typeof value !== 'string' || !/^(0|-?[1-9][0-9]*)$/.test(value) || BigInt(value) < -(1n << 63n) || BigInt(value) > (1n << 63n) - 1n) throw new RangeError('native bridge requires signed 64-bit integer');
};
const width = (span: bigint): number => span === 0n ? 0 : span.toString(2).length;
const fieldWidth = (field: PackedField): number => {
  if (field.kind === 'bool') return 1;
  if (field.kind === 'ref') return width(BigInt(2 * field.maxRelative + 1));
  if (field.kind === 'int') return width(BigInt(field.max) - BigInt(field.min));
  throw new TypeError('native bridge does not support packed string fields');
};
const sha256 = (bytes: Uint8Array): string => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const policyCode = { trap: 0, wrap: 1, saturate: 2 } as const;

/** Research bridge into an actual native executable. This remains outside the
 * production guest and cannot itself commit a resumable checkpoint. */
export function executePackedCheckpointNative(args: {
  packed: PackedResumableCheckpoint;
  program: ResumableProgram;
  expectedSnapshotDigest: Digest;
  expectedLayoutDigest: Digest;
  executable: string;
  expectedExecutableSha256: string;
  operations: readonly NativeOperation[];
}): NativeBridgeResult {
  unpackResumableCheckpoint(args.packed, args.program, args.expectedSnapshotDigest, args.expectedLayoutDigest);
  const image = args.packed.heap;
  const model = PackedHeap.fromImage(image, args.expectedLayoutDigest);
  if (model.format !== 'aether.packed-heap/1') throw new TypeError('native bridge does not support packed string images');
  if (model.rows.length < 1 || model.rows.length > 1024 || model.byteLength > 65536 ||
      !Array.isArray(args.operations) || args.operations.length > 4096) throw new RangeError('native bridge profile limit');
  const executableSha256 = sha256(readFileSync(args.executable));
  if (executableSha256 !== args.expectedExecutableSha256) throw new TypeError('native executable digest mismatch');
  const rowIndex = new Map(model.rows.map((row, index) => [row.id, index]));
  const layouts = new Map(model.layouts.map(layout => [layout.typeName, layout]));
  const raw = Buffer.from(image.bytes, 'base64');
  const validBits = model.rows.reduce((sum, row) => sum + row.bitLength, 0);
  const lines = [`AEPBR001 ${model.rows.length} ${raw.length} ${validBits} ${args.operations.length}`, raw.length ? raw.toString('hex') : '-'];
  for (const row of model.rows) {
    nativeDecimal(row.id); nativeDecimal(row.epoch);
    lines.push(`${row.id} ${row.epoch} ${row.bitOffset} ${row.bitLength}`);
  }
  const expected: string[] = [];
  for (const op of args.operations) {
    if (!op || typeof op !== 'object' || typeof op.id !== 'string' || typeof op.field !== 'string') throw new TypeError('invalid native operation');
    const ordinal = rowIndex.get(op.id);
    if (ordinal === undefined) throw new ReferenceError('unknown native operation row');
    const row = model.rows[ordinal], layout = layouts.get(row.typeName)!;
    const index = layout.fields.findIndex(field => field.name === op.field);
    if (index < 0) throw new ReferenceError('unknown native operation field');
    const field = layout.fields[index];
    const offset = row.bitOffset + layout.fields.slice(0, index).reduce((sum, part) => sum + fieldWidth(part), 0);
    const bits = fieldWidth(field);
    if ((op.kind === 'readInt' || op.kind === 'addInt') && field.kind === 'int') {
      signed64(field.min); signed64(field.max);
      const integer = model.get(op.id, op.field);
      if (integer.tag !== 'int') throw new TypeError('invalid packed integer model');
      let value = integer.value, status = 0;
      let increment = '0';
      if (op.kind === 'addInt') {
        increment = op.increment; signed64(increment);
        try {
          model.add(op.id, op.field, BigInt(increment));
          const updated = model.get(op.id, op.field);
          if (updated.tag !== 'int') throw new TypeError('invalid packed integer model');
          value = updated.value;
        }
        catch (error) { if (!(error instanceof RangeError) || !String(error).includes('overflow')) throw error; status = 3; }
      }
      const code = policyCode[field.overflow];
      lines.push(`${op.kind === 'addInt' ? 'I' : 'i'} ${ordinal} ${offset} ${bits} ${field.min} ${field.max} ${code} ${increment}`);
      expected.push(`${op.kind === 'addInt' ? 'I' : 'i'} ${status} ${value}`);
    } else if (op.kind === 'readBool' && field.kind === 'bool') {
      const value = model.get(op.id, op.field);
      if (value.tag !== 'bool') throw new TypeError('invalid packed boolean model');
      lines.push(`B ${ordinal} ${offset} ${bits}`); expected.push(`B 0 ${value.value ? 1 : 0}`);
    } else if (op.kind === 'readRef' && field.kind === 'ref') {
      const value = model.get(op.id, op.field);
      lines.push(`R ${ordinal} ${offset} ${bits} ${field.maxRelative}`);
      if (value.tag !== 'null' && value.tag !== 'ref') throw new TypeError('invalid packed reference model');
      expected.push(value.tag === 'null' ? 'R 0 1 0 0' : `R 0 0 ${value.value.objectId} ${value.value.ownerEpoch}`);
    } else if (op.kind === 'setRef' && field.kind === 'ref') {
      const target = op.targetId === null ? null : rowIndex.get(op.targetId);
      if (op.targetId !== null && target === undefined) throw new ReferenceError('unknown native reference target');
      const targetRow = target === undefined || target === null ? null : model.rows[target];
      model.set(op.id, op.field, targetRow === null ? { tag: 'null' } :
        { tag: 'ref', value: { heapId: model.heapId, objectId: targetRow.id, ownerEpoch: targetRow.epoch } });
      lines.push(`S ${ordinal} ${offset} ${bits} ${field.maxRelative} ${target ?? -1} ${targetRow?.id ?? 0} ${targetRow?.epoch ?? 0}`);
      expected.push('S 0');
    } else throw new TypeError('unsupported native operation/field combination');
  }
  const input = lines.join('\n') + '\n';
  if (Buffer.byteLength(input) > 2 * 1024 * 1024) throw new RangeError('native bridge input size limit');
  const output = execFileSync(args.executable, { input, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024,
    timeout: 5000, killSignal: 'SIGKILL' }).trimEnd().split('\n');
  const expectedBytes = Buffer.from(model.image().bytes, 'base64');
  expected.push(`H ${expectedBytes.length ? expectedBytes.toString('hex') : '-'}`);
  if (output.length !== expected.length || output.some((line, index) => line !== expected[index])) throw new TypeError('native/reference packed-image mismatch');
  const nativeBytes = output.at(-1)!.slice(2) === '-' ? Buffer.alloc(0) : Buffer.from(output.at(-1)!.slice(2), 'hex');
  const { imageDigest: _old, ...body } = image;
  const candidateBody = { ...body, bytes: nativeBytes.toString('base64') };
  const candidateHeap = { ...candidateBody, imageDigest: domainDigest('aether.packed-heap-image/1', candidateBody, MACHINE_LIMITS) };
  PackedHeap.fromImage(candidateHeap, args.expectedLayoutDigest);
  return {
    format: 'aether.packed-native-bridge-result/1', inputSnapshotDigest: args.expectedSnapshotDigest,
    layoutDigest: image.layoutDigest, executableSha256, observations: output.slice(0, -1),
    candidateHeap,
  };
}
