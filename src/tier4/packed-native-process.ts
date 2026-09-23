import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, fstatSync, mkdtempSync, openSync, readSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { domainDigest, validateDigest, type Digest } from '../fabric/identity.ts';
import type { ResumableProgram } from '../tier3/resumable-program.ts';
import { PackedHeap, unpackResumableCheckpoint, type PackedField, type PackedHeapImage, type PackedResumableCheckpoint } from '../tier3/packed-heap.ts';
import { MACHINE_LIMITS, machineClone } from '../tier3/resumable-state.ts';
import { validateCheckpointControlRequest, type ProcessCheckpointControlRequest } from './process-checkpoint-contract.ts';

export type NativeOperation =
  | { readonly kind: 'readInt' | 'readBool' | 'readRef'; readonly id: string; readonly field: string }
  | { readonly kind: 'readString'; readonly id: string; readonly field: string }
  | { readonly kind: 'equalString'; readonly id: string; readonly field: string; readonly otherId: string; readonly otherField: string }
  | { readonly kind: 'addInt'; readonly id: string; readonly field: string; readonly increment: string }
  | { readonly kind: 'setRef'; readonly id: string; readonly field: string; readonly targetId: string | null };

export interface NativeBridgeResult {
  readonly format: 'aether.packed-native-bridge-result/1' | 'aether.packed-native-bridge-result/2';
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
  if (field.kind === 'string') return 12;
  throw new TypeError('unsupported packed field');
};
const sha256 = (bytes: Uint8Array): string => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const policyCode = { trap: 0, wrap: 1, saturate: 2 } as const;
const MAX_EXECUTABLE_BYTES = 16 * 1024 * 1024;

function readBoundedExecutable(path: string): Buffer {
  const fd = openSync(path, 'r');
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size < 1 || stat.size > MAX_EXECUTABLE_BYTES)
      throw new RangeError('native executable size/type limit');
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, null);
      if (count === 0) throw new TypeError('native executable changed while reading');
      offset += count;
    }
    if (readSync(fd, Buffer.alloc(1), 0, 1, null) !== 0)
      throw new TypeError('native executable changed while reading');
    const magic = bytes.subarray(0, 4).toString('hex');
    if (!['7f454c46', 'feedface', 'feedfacf', 'cefaedfe', 'cffaedfe', 'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca'].includes(magic) &&
        bytes.subarray(0, 2).toString('hex') !== '4d5a')
      throw new TypeError('native executable must be a binary image');
    return bytes;
  } finally { closeSync(fd); }
}

/** Never execute the original path after checking its digest. The child runs a
 * private copy written from the very bytes that passed the SHA-256 check. */
function runVerifiedExecutable(bytes: Buffer, input: string, onLaunch?: () => void): string[] {
  const directory = mkdtempSync(join(tmpdir(), 'aether-packed-run-'));
  try {
    const path = join(directory, 'verified-native');
    writeFileSync(path, bytes, { flag: 'wx', mode: 0o700 });
    onLaunch?.();
    return execFileSync(path, { input, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024,
      timeout: 5000, killSignal: 'SIGKILL' }).trimEnd().split('\n');
  } finally { rmSync(directory, { recursive: true, force: true }); }
}


/** Execute an exact digest-pinned native image and compare every observation
 * and resulting packed byte against the trusted packed-heap model. */
export function executePackedCheckpointNative(args: {
  packed: PackedResumableCheckpoint;
  program: ResumableProgram;
  expectedSnapshotDigest: Digest;
  expectedLayoutDigest: Digest;
  executable: string;
  expectedExecutableSha256: string;
  operations: readonly NativeOperation[];
}): NativeBridgeResult { return executePackedCheckpointNativeInternal(args); }

function executePackedCheckpointNativeInternal(args: {
  packed: PackedResumableCheckpoint;
  program: ResumableProgram;
  expectedSnapshotDigest: Digest;
  expectedLayoutDigest: Digest;
  executable: string;
  expectedExecutableSha256: string;
  operations: readonly NativeOperation[];
}, onLaunch?: () => void): NativeBridgeResult {
  unpackResumableCheckpoint(args.packed, args.program, args.expectedSnapshotDigest, args.expectedLayoutDigest);
  const image = args.packed.heap;
  const model = PackedHeap.fromImage(image, args.expectedLayoutDigest);
  const strings = model.format === 'aether.packed-heap/2';
  if (model.rows.length < 1 || model.rows.length > 1024 || model.byteLength > 65536 ||
      !Array.isArray(args.operations) || args.operations.length > 4096) throw new RangeError('native bridge profile limit');
  const executableBytes = readBoundedExecutable(args.executable);
  const executableSha256 = sha256(executableBytes);
  if (executableSha256 !== args.expectedExecutableSha256) throw new TypeError('native executable digest mismatch');
  const rowIndex = new Map(model.rows.map((row, index) => [row.id, index]));
  const layouts = new Map(model.layouts.map(layout => [layout.typeName, layout]));
  const raw = Buffer.from(image.bytes, 'base64');
  const validBits = model.rows.reduce((sum, row) => sum + row.bitLength, 0);
  const arena = strings ? Buffer.from(image.stringBytes!, 'base64') : Buffer.alloc(0);
  const entries = strings ? image.stringEntries! : [];
  if (entries.length > 4096 || arena.length > 65536) throw new RangeError('native bridge string profile limit');
  const lines = [strings
    ? `AEPBR002 ${model.rows.length} ${raw.length} ${validBits} ${args.operations.length} ${entries.length} ${arena.length}`
    : `AEPBR001 ${model.rows.length} ${raw.length} ${validBits} ${args.operations.length}`,
    raw.length ? raw.toString('hex') : '-'];
  for (const row of model.rows) {
    nativeDecimal(row.id); nativeDecimal(row.epoch);
    lines.push(`${row.id} ${row.epoch} ${row.bitOffset} ${row.bitLength}`);
  }
  if (strings) {
    for (const entry of entries) lines.push(`${entry.offset} ${entry.length}`);
    lines.push(arena.length ? arena.toString('hex') : '-');
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
    } else if (op.kind === 'readString' && field.kind === 'string') {
      const value = model.get(op.id, op.field);
      if (value.tag !== 'string') throw new TypeError('invalid packed string model');
      const utf8 = Buffer.from(value.value, 'utf8');
      lines.push(`T ${ordinal} ${offset} ${bits} ${field.maxUtf8Bytes}`);
      expected.push(`T 0 ${utf8.length ? utf8.toString('hex') : '-'}`);
    } else if (op.kind === 'equalString' && field.kind === 'string') {
      const otherOrdinal = rowIndex.get(op.otherId);
      if (otherOrdinal === undefined) throw new ReferenceError('unknown native comparison row');
      const otherRow = model.rows[otherOrdinal], otherLayout = layouts.get(otherRow.typeName)!;
      const otherIndex = otherLayout.fields.findIndex(part => part.name === op.otherField);
      if (otherIndex < 0) throw new ReferenceError('unknown native comparison field');
      const otherField = otherLayout.fields[otherIndex];
      if (otherField.kind !== 'string') throw new TypeError('native comparison requires string fields');
      const otherOffset = otherRow.bitOffset + otherLayout.fields.slice(0, otherIndex).reduce((sum, part) => sum + fieldWidth(part), 0);
      const left = model.get(op.id, op.field), right = model.get(op.otherId, op.otherField);
      if (left.tag !== 'string' || right.tag !== 'string') throw new TypeError('invalid packed string model');
      lines.push(`E ${ordinal} ${offset} ${bits} ${field.maxUtf8Bytes} ${otherOrdinal} ${otherOffset} 12 ${otherField.maxUtf8Bytes}`);
      expected.push(`E 0 ${left.value === right.value ? 1 : 0}`);
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
  const output = runVerifiedExecutable(executableBytes, input, onLaunch);
  const expectedBytes = Buffer.from(model.image().bytes, 'base64');
  expected.push(`H ${expectedBytes.length ? expectedBytes.toString('hex') : '-'}`);
  if (output.length !== expected.length || output.some((line, index) => line !== expected[index])) throw new TypeError('native/reference packed-image mismatch');
  const nativeBytes = output.at(-1)!.slice(2) === '-' ? Buffer.alloc(0) : Buffer.from(output.at(-1)!.slice(2), 'hex');
  const { imageDigest: _old, ...body } = image;
  const candidateBody = { ...body, bytes: nativeBytes.toString('base64') };
  const candidateHeap = { ...candidateBody, imageDigest: domainDigest(strings ? 'aether.packed-heap-image/2' : 'aether.packed-heap-image/1', candidateBody, MACHINE_LIMITS) };
  PackedHeap.fromImage(candidateHeap, args.expectedLayoutDigest);
  return {
    format: strings ? 'aether.packed-native-bridge-result/2' : 'aether.packed-native-bridge-result/1', inputSnapshotDigest: args.expectedSnapshotDigest,
    layoutDigest: image.layoutDigest, executableSha256, observations: output.slice(0, -1),
    candidateHeap,
  };
}

type PackedV2Request = Extract<ProcessCheckpointControlRequest, { kind: 'packed-v2' }>;
type NativeRunBinding = Pick<PackedV2Request, 'operationId' | 'expectedCheckpoint' | 'sourceImageDigest' | 'candidateImageDigest' |
  'layoutDigest' | 'artifactDigest' | 'executableSha256' | 'operationsDigest'>;
const nativeRunToken = Symbol('aether.packed-native-run');

/** An unforgeable in-process witness that the checked native image actually
 * produced the exact candidate for one control request. Its private payload
 * is never returned by reference. */
export class PackedNativeRun {
  #candidate: PackedHeapImage;
  #binding: NativeRunBinding;
  private constructor(token: symbol, candidate: PackedHeapImage, binding: NativeRunBinding) {
    if (token !== nativeRunToken) throw new TypeError('native run can only be created by the verified runner');
    this.#candidate = machineClone(candidate);
    this.#binding = Object.freeze({ ...binding });
    Object.freeze(this);
  }
  get candidateHeap(): PackedHeapImage { return machineClone(this.#candidate); }
  static createForVerifiedRunner(token: symbol, candidate: PackedHeapImage, binding: NativeRunBinding): PackedNativeRun {
    return new PackedNativeRun(token, candidate, binding);
  }
  static assert(run: unknown, expected: NativeRunBinding): PackedHeapImage {
    if (!run || typeof run !== 'object' || !(#candidate in run)) throw new TypeError('verified native run proof required');
    const actual = run.#binding;
    for (const key of ['operationId', 'expectedCheckpoint', 'sourceImageDigest', 'candidateImageDigest', 'layoutDigest',
      'artifactDigest', 'executableSha256', 'operationsDigest'] as const) {
      if (actual[key] !== expected[key]) throw new TypeError('native run binding mismatch');
    }
    if (run.#candidate.imageDigest !== expected.candidateImageDigest) throw new TypeError('native run candidate changed');
    return machineClone(run.#candidate);
  }
}

export interface PackedNativeProcessRunnerOptions {
  readonly program: ResumableProgram;
  readonly artifactDigest: Digest;
  readonly executable: string;
  readonly expectedExecutableSha256: string;
  readonly operations: readonly NativeOperation[];
}

/** An application-owned native runner. Its identity and execution are read
 * through nonvirtual static methods by ProcessResumableSession. A caller may
 * subclass or shadow public methods, but cannot replace the private program,
 * operations, executable path or candidate witness. */
export class PackedNativeProcessRunner {
  #program: ResumableProgram;
  #artifactDigest: Digest;
  #executable: string;
  #executableSha256: string;
  #operations: readonly NativeOperation[];
  #operationsDigest: Digest;
  #executionCount = 0;

  constructor(options: PackedNativeProcessRunnerOptions) {
    validateDigest(options.artifactDigest);
    if (options.program.manifest.target.artifactDigest !== options.artifactDigest)
      throw new TypeError('native runner program/artifact identity mismatch');
    if (typeof options.executable !== 'string' || !options.executable.length ||
        !/^sha256:[0-9a-f]{64}$/.test(options.expectedExecutableSha256)) throw new TypeError('invalid native executable identity');
    if (!Array.isArray(options.operations) || options.operations.length > 4096) throw new RangeError('native operation profile limit');
    this.#program = machineClone(options.program);
    this.#artifactDigest = options.artifactDigest;
    this.#executable = options.executable;
    this.#executableSha256 = options.expectedExecutableSha256;
    this.#operations = machineClone(options.operations);
    this.#operationsDigest = domainDigest('aether.packed-native-operations/1', this.#operations);
  }

  get artifactDigest(): Digest { return this.#artifactDigest; }
  get executableSha256(): string { return this.#executableSha256; }
  get operationsDigest(): Digest { return this.#operationsDigest; }
  static identity(runner: PackedNativeProcessRunner): Pick<NativeRunBinding, 'artifactDigest' | 'executableSha256' | 'operationsDigest'> {
    if (!runner || typeof runner !== 'object' || !(#program in runner)) throw new TypeError('verified native runner required');
    return { artifactDigest: runner.#artifactDigest, executableSha256: runner.#executableSha256,
      operationsDigest: runner.#operationsDigest };
  }
  static executionCount(runner: PackedNativeProcessRunner): number {
    PackedNativeProcessRunner.identity(runner);
    return runner.#executionCount;
  }

  static executeVerified(runner: PackedNativeProcessRunner, source: PackedResumableCheckpoint,
    request: PackedV2Request): PackedNativeRun {
    const identity = PackedNativeProcessRunner.identity(runner);
    validateCheckpointControlRequest(request);
    if (request.kind !== 'packed-v2' || request.artifactDigest !== identity.artifactDigest ||
        request.executableSha256 !== identity.executableSha256 || request.operationsDigest !== identity.operationsDigest ||
        source.snapshotDigest !== request.expectedCheckpoint || source.heap.imageDigest !== request.sourceImageDigest ||
        source.heap.layoutDigest !== request.layoutDigest) throw new TypeError('native run request identity mismatch');
    const result = executePackedCheckpointNativeInternal({ packed: source, program: runner.#program,
      expectedSnapshotDigest: request.expectedCheckpoint, expectedLayoutDigest: request.layoutDigest,
      executable: runner.#executable, expectedExecutableSha256: identity.executableSha256,
      operations: runner.#operations }, () => { runner.#executionCount++; });
    if (result.candidateHeap.imageDigest !== request.candidateImageDigest)
      throw new TypeError('native packed candidate identity mismatch');
    return PackedNativeRun.createForVerifiedRunner(nativeRunToken, result.candidateHeap, {
      operationId: request.operationId, expectedCheckpoint: request.expectedCheckpoint, sourceImageDigest: request.sourceImageDigest,
      candidateImageDigest: request.candidateImageDigest, layoutDigest: request.layoutDigest,
      artifactDigest: identity.artifactDigest, executableSha256: identity.executableSha256,
      operationsDigest: identity.operationsDigest,
    });
  }

  static assertRun(run: unknown, expected: NativeRunBinding): PackedHeapImage {
    return PackedNativeRun.assert(run, expected);
  }

  /** Convenience for direct callers. Host publication must retain the run
   * witness returned by executeVerified instead of this image alone. */
  execute(source: PackedResumableCheckpoint, request: PackedV2Request): PackedHeapImage {
    return PackedNativeProcessRunner.executeVerified(this, source, request).candidateHeap;
  }
}

Object.freeze(PackedNativeRun.prototype);
Object.freeze(PackedNativeRun);
Object.freeze(PackedNativeProcessRunner.prototype);
Object.freeze(PackedNativeProcessRunner);
