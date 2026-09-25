/** Bounded executor for the proof-bearing, one-field Int native fallback.
 *
 * The checked record certificate proves properties of Aether source, not C
 * compiler correctness. We therefore compare every native result against an
 * independently executed, contract-enforcing ProductionRuntime from the exact
 * bound module. This is an opt-in trusted-native profile: the binary still
 * runs with the controller UID, and compiler/toolchain custody and OS sandboxing
 * are separate admission requirements. The host must validate retained record
 * types, current grants, source head and witness before publishing this result.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, fstatSync, mkdtempSync, openSync, readFileSync, readSync,
  rmSync, closeSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeCanonical, type TaggedValueV1 } from '../fabric/encoding.ts';
import { domainDigest, type Digest } from '../fabric/identity.ts';
import { validateRuntimeSnapshot, type RuntimeSnapshotV1 } from '../fabric/snapshot.ts';
import type { NodeRef } from '../tier1/ids.ts';
import { GraphStore } from '../tier1/store.ts';
import { CapabilityRegistry } from '../tier2/ocap.ts';
import { RECORD_FALLBACK_PROFILE_DIGEST } from '../tier2/record-fallback-proof-checker.ts';
import { ProductionRuntime } from '../tier3/compile.ts';
import type { ProductionSnapshot } from '../tier3/heap-state.ts';
import { assertProcessNativeFallbackBinding, type ProcessNativeFallbackBindingInput,
  type ProcessNativeFallbackBindingV1 } from './native-fallback-contract.ts';
import { lowerCheckedFallbackAst, type ProvedNativeFallbackOutput } from './native-fallback-compiler-v1.ts';

const MAX_BINARY_BYTES = 16 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 8192;
const TIMEOUT_MS = 5000;
const COMPILE_TIMEOUT_MS = 30_000;
const MAX_COMPILER_OUTPUT_BYTES = 65_536;
const DRIVER_V1_SHA256 = '0d4a4433ea0d13912a3b70d7a0aa3307ee0496db0eb38bf7ec02b2115b98c2fc';
const DRIVER_V1_URL = new URL('./native-fallback-driver-v1.c', import.meta.url);
const CLANG = '/usr/bin/clang';
const I64_MIN = -(1n << 63n), I64_MAX = (1n << 63n) - 1n;
const canonical = (left: unknown, right: unknown): boolean =>
  Buffer.from(encodeCanonical(left)).equals(Buffer.from(encodeCanonical(right)));

/** Metadata retained by the compiler build attestation. The runner separately
 * regenerates source and executable bytes from the checked proof and AST. */
export interface ProvedNativeFallbackArtifactV1 {
  readonly format: 'aether.proved-native-fallback-lowering/1';
  readonly root: Digest;
  readonly manifestDigest: Digest;
  readonly sourceSha256: string;
  readonly conservativeProofDigest: Digest;
  readonly proofProfileDigest: Digest;
  readonly compilerProfileDigest: Digest;
}
export type ProcessNativeFallbackLowered = ProvedNativeFallbackArtifactV1;
export interface ProcessNativeFallbackRunInput {
  readonly binding: ProcessNativeFallbackBindingV1;
  readonly bindingInput: ProcessNativeFallbackBindingInput;
  readonly executablePath: string;
  readonly lowered: ProvedNativeFallbackArtifactV1;
  /** Host-validated Tier 2 authority at launch; the host rechecks at commit. */
  readonly grant2: boolean;
  /** Deterministic driver test flag, not a live host revocation oracle. */
  readonly revokeAtFault?: boolean;
}
export interface ProcessNativeFallbackOutcomeV1 {
  readonly format: 'aether.process-native-fallback-outcome/1';
  readonly tier: 1 | 2 | 3;
  readonly state: 'completed' | 'aborted';
  readonly value: TaggedValueV1 | null;
  readonly code: 'fallback_exhausted' | 'authority_denied' | null;
  readonly after: RuntimeSnapshotV1;
  readonly nativeOutputDigest: Digest;
}
interface NativeOutput {
  readonly tier: 1 | 2 | 3;
  readonly code: 0 | 1 | 2;
  readonly value: string;
  readonly left: string;
  readonly right: string;
  readonly nextObjectId: string;
  readonly records: readonly (readonly [string, string])[];
}

function parseI64(text: string): string {
  if (!/^(?:0|-?[1-9][0-9]*)$/.test(text)) throw new TypeError('noncanonical native integer');
  const value = BigInt(text);
  if (value < I64_MIN || value > I64_MAX) throw new RangeError('native integer outside signed i64');
  return text;
}
/** The driver emits one fixed-key JSON line. Parse its decimal lexemes before
 * JavaScript Number can round signed-i64 values. No fields or bytes may trail. */
function parseOutput(stdout: string): NativeOutput {
  if (Buffer.byteLength(stdout) > MAX_OUTPUT_BYTES) throw new RangeError('native output bound');
  const match = /^\{"tier":([123]),"code":([012]),"value":(-?(?:0|[1-9][0-9]*)),"left":([1-3]),"right":([1-3]),"nextObjectId":([1-4]),"records":\[(.*)\]\}\n$/.exec(stdout);
  if (!match) throw new TypeError('malformed native fallback output');
  const recordsText = match[7];
  const pieces = [...recordsText.matchAll(/\[([1-3]),(-?(?:0|[1-9][0-9]*))\]/g)];
  if (pieces.length < 1 || pieces.length > 3 || pieces.map(item => item[0]).join(',') !== recordsText)
    throw new TypeError('malformed native record frame');
  const records = pieces.map((piece, index) => {
    if (piece[1] !== String(index + 1)) throw new TypeError('unordered native record frame');
    return [piece[1], parseI64(piece[2])] as const;
  });
  const nextObjectId = match[6];
  if (Number(nextObjectId) !== records.length + 1)
    throw new TypeError('incomplete native record frame');
  const tier = Number(match[1]) as 1 | 2 | 3;
  const code = Number(match[2]) as 0 | 1 | 2;
  if ((tier === 3) === (code === 0) || (tier !== 3 && code !== 0))
    throw new TypeError('native tier/result mismatch');
  return { tier, code, value: parseI64(match[3]), left: match[4], right: match[5],
    nextObjectId, records };
}

function readBoundedBinary(path: string): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size < 1 || stat.size > MAX_BINARY_BYTES)
      throw new RangeError('native fallback executable must be a bounded regular file');
    const bytes = Buffer.alloc(stat.size + 1);
    let count = 0;
    while (count < bytes.length) {
      const length = readSync(fd, bytes, count, bytes.length - count, count);
      if (length === 0) break;
      count += length;
    }
    if (count !== stat.size || fstatSync(fd).size !== stat.size)
      throw new TypeError('native fallback executable changed during bounded read');
    return bytes.subarray(0, count);
  } finally { closeSync(fd); }
}
function readExactBinary(path: string, expectedSha256: string): Buffer {
  const bytes = readBoundedBinary(path);
  if (createHash('sha256').update(bytes).digest('hex') !== expectedSha256)
    throw new TypeError('native fallback executable digest mismatch');
  return bytes;
}

function execute(bytes: Buffer, args: readonly string[]): NativeOutput {
  const directory = mkdtempSync(join(tmpdir(), 'aether-native-exact-'));
  try {
    const binary = join(directory, 'image');
    writeFileSync(binary, bytes, { flag: 'wx', mode: 0o700 });
    const child = spawnSync(binary, [...args], { encoding: 'utf8', cwd: directory,
      env: {}, timeout: TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES, input: '' });
    if (child.error || child.signal || child.status !== 0 || child.stderr !== '')
      throw new Error('native fallback executable failed, timed out or wrote stderr');
    return parseOutput(child.stdout);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

/** Rebuild the exact proof-bearing v1 image from checked source before native
 * launch. Fixed basename matters on macOS because ad hoc Mach-O signing
 * includes that basename. The OS/compiler/linker remain trusted components;
 * this check rejects an arbitrary supplied binary even if it mimics output. */
function rebuildBinary(source: string): Buffer {
  const driver = readFileSync(fileURLToPath(DRIVER_V1_URL));
  if (createHash('sha256').update(driver).digest('hex') !== DRIVER_V1_SHA256)
    throw new TypeError('packaged native fallback driver changed');
  const directory = mkdtempSync(join(tmpdir(), 'aether-native-build-'));
  try {
    const sourcePath = join(directory, 'driver.c');
    const generated = join(directory, 'generated.h');
    const binary = join(directory, 'native-fallback');
    writeFileSync(sourcePath, driver, { flag: 'wx', mode: 0o600 });
    writeFileSync(generated, source, { flag: 'wx', mode: 0o600 });
    const child = spawnSync(CLANG, ['-O3', '-std=c11', '-Wall', '-Wextra', '-Werror',
      '-fno-lto', '-I', directory, '-o', binary, sourcePath],
    { cwd: directory, env: { PATH: '/usr/bin:/bin' }, encoding: 'utf8',
      timeout: COMPILE_TIMEOUT_MS, maxBuffer: MAX_COMPILER_OUTPUT_BYTES, input: '' });
    if (child.error || child.signal || child.status !== 0)
      throw new Error('trusted native fallback compiler unavailable or failed');
    return readBoundedBinary(binary);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

function referenceSnapshot(before: RuntimeSnapshotV1, root: NodeRef): ProductionSnapshot {
  return { format: 'aether.production-state/local-1', module: root,
    nextAddress: Number(before.nextObjectId), records: before.records.map(row => ({
      address: Number(row.objectId), fields: row.fields.map(([name, field]) => {
        if (name !== 'value' || field.tag !== 'int') throw new TypeError('native record type mismatch');
        return [name, BigInt(field.value)] as const;
      }),
    })) };
}
function candidate(before: RuntimeSnapshotV1, binding: ProcessNativeFallbackBindingV1,
  records: readonly (readonly [string, string])[]): RuntimeSnapshotV1 {
  const old = before.records.length;
  if (records.length < old || records.length > old + 1)
    throw new TypeError('native allocation count outside bounded frame');
  const after: RuntimeSnapshotV1 = {
    ...before, nextObjectId: String(records.length + 1),
    records: records.map(([id, value]) => ({ objectId: id,
      fields: [['value', { tag: 'int', value }]] as const })),
    ownership: records.length === old ? before.ownership : [...before.ownership,
      { objectId: before.nextObjectId, unit: binding.unit, epoch: binding.generation }],
  };
  validateRuntimeSnapshot(after);
  for (let index = 0; index < old; index++) {
    const id = String(index + 1);
    if (id !== binding.frame.left.objectId
      && !canonical(after.records[index], before.records[index]))
      throw new TypeError('native fallback changed a record outside declared frame');
  }
  return after;
}
type ReplayInput = Pick<ProcessNativeFallbackRunInput, 'binding' | 'bindingInput' | 'grant2' | 'revokeAtFault'>;
function replay(input: ReplayInput): Omit<ProcessNativeFallbackOutcomeV1, 'format' | 'nativeOutputDigest'> {
  const { binding, bindingInput, grant2, revokeAtFault = false } = input;
  const before = bindingInput.snapshot;
  const runtime = ProductionRuntime.compile(bindingInput.context.module,
    { registry: new CapabilityRegistry(), policy: 'enforce',
      executionGuard: (() => { let fuel = 1000; return () => --fuel >= 0; })() });
  const start = referenceSnapshot(before, new GraphStore().intern(bindingInput.context.module));
  const args = [{ addr: Number(binding.frame.left.objectId) },
    { addr: Number(binding.frame.right.objectId) }] as const;
  runtime.importSnapshot(start);
  const first = runtime.call(binding.tier1, args);
  if (first.ok) {
    if (typeof first.value !== 'bigint') throw new TypeError('native Tier 1 result type mismatch');
    const next = runtime.exportSnapshot();
    const after = candidate(before, binding, next.records.map(row => {
      const field = row.fields[0];
      if (row.fields.length !== 1 || field[0] !== 'value' || typeof field[1] !== 'bigint')
        throw new TypeError('native reference frame type mismatch');
      return [String(row.address), String(field[1])] as const;
    }));
    return { tier: 1, state: 'completed', value: { tag: 'int', value: String(first.value) },
      code: null, after };
  }
  if (first.fault.kind === 'precondition' || !grant2 || revokeAtFault)
    return { tier: 3, state: 'aborted', value: null,
      code: 'authority_denied', after: before };
  runtime.importSnapshot(start); // Entire Tier 1 frame rolls back before Tier 2.
  const second = runtime.call(binding.tier2, args);
  if (!second.ok) return { tier: 3, state: 'aborted', value: null,
    code: 'fallback_exhausted', after: before };
  if (typeof second.value !== 'bigint') throw new TypeError('native Tier 2 result type mismatch');
  const next = runtime.exportSnapshot();
  if (next.records.length !== before.records.length + 1)
    throw new TypeError('proved native Tier 2 must allocate exactly one record');
  const after = candidate(before, binding, next.records.map(row => {
    const field = row.fields[0];
    if (row.fields.length !== 1 || field[0] !== 'value' || typeof field[1] !== 'bigint')
      throw new TypeError('native reference frame type mismatch');
    return [String(row.address), String(field[1])] as const;
  }));
  return { tier: 2, state: 'completed', value: { tag: 'int', value: String(second.value) },
    code: null, after };
}

function assertSubject(binding: ProcessNativeFallbackBindingV1,
  bindingInput: ProcessNativeFallbackBindingInput,
  lowered: ProcessNativeFallbackLowered): ProvedNativeFallbackOutput {
  assertProcessNativeFallbackBinding(binding, bindingInput);
  const rebuilt = lowerCheckedFallbackAst({ module: bindingInput.context.module,
    manifest: bindingInput.context.manifest, tier1: binding.tier1,
    tier2: binding.tier2, checkedProof: bindingInput.checkedProof });
  if (lowered.format !== 'aether.proved-native-fallback-lowering/1'
    || lowered.root !== binding.astRoot || lowered.manifestDigest !== binding.manifestDigest
    || lowered.sourceSha256 !== binding.sourceSha256
    || lowered.conservativeProofDigest !== binding.proofDigest
    || lowered.proofProfileDigest !== RECORD_FALLBACK_PROFILE_DIGEST
    || lowered.compilerProfileDigest !== binding.compilerProfileDigest
    || rebuilt.sourceSha256 !== binding.sourceSha256
    || rebuilt.root !== binding.astRoot
    || rebuilt.manifestDigest !== binding.manifestDigest
    || rebuilt.conservativeProofDigest !== binding.proofDigest
    || rebuilt.compilerProfileDigest !== binding.compilerProfileDigest)
    throw new TypeError('native fallback compiler/proof subject mismatch');
  return rebuilt;
}
function assertAuthorityFlags(input: { grant2: boolean; revokeAtFault?: boolean }): void {
  if (typeof input.grant2 !== 'boolean' || (input.revokeAtFault !== undefined
    && typeof input.revokeAtFault !== 'boolean')) throw new TypeError('invalid native authority flags');
}

export function runProcessNativeFallback(input: ProcessNativeFallbackRunInput): ProcessNativeFallbackOutcomeV1 {
  const rebuilt = assertSubject(input.binding, input.bindingInput, input.lowered);
  assertAuthorityFlags(input);
  const { binding } = input;
  const rebuiltBytes = rebuildBinary(rebuilt.source);
  if (createHash('sha256').update(rebuiltBytes).digest('hex') !== binding.executableSha256)
    throw new TypeError('native fallback rebuilt executable differs from binding');
  const bytes = readExactBinary(input.executablePath, binding.executableSha256);
  if (!bytes.equals(rebuiltBytes))
    throw new TypeError('native fallback artifact bytes differ from trusted rebuild');
  const frame = binding.frame;
  const output = execute(rebuiltBytes, ['--snapshot-case', frame.nextObjectId,
    frame.left.objectId, frame.right.objectId, '1', input.grant2 ? '1' : '0',
    input.revokeAtFault ? '1' : '0', ...frame.values]);
  if (output.left !== frame.left.objectId || output.right !== frame.right.objectId)
    throw new TypeError('native fallback reference alias mismatch');
  const after = output.tier === 3 ? input.bindingInput.snapshot
    : candidate(input.bindingInput.snapshot, binding, output.records);
  if (output.tier === 3 && (output.nextObjectId !== frame.nextObjectId
    || output.value !== '0' || !canonical(output.records,
      frame.values.map((value, index) => [String(index + 1), value]))))
    throw new TypeError('native Tier 3 failed to restore exact source frame');
  const actual = { tier: output.tier,
    state: output.tier === 3 ? 'aborted' as const : 'completed' as const,
    value: output.tier === 3 ? null : { tag: 'int' as const, value: output.value },
    code: output.tier === 3 ? (output.code === 1 ? 'fallback_exhausted' as const : 'authority_denied' as const) : null,
    after };
  const expected = replay(input);
  if (!canonical(actual, expected)) throw new TypeError('native fallback differs from independent exact-source execution');
  const outcome: ProcessNativeFallbackOutcomeV1 = {
    format: 'aether.process-native-fallback-outcome/1', ...actual,
    nativeOutputDigest: domainDigest('aether.native-fallback-output/1', output),
  };
  return Object.freeze(outcome);
}

/** Revalidates a retained terminal result on every host-journal read without
 * launching native code again. The host must retain its launch authority
 * decision; its current profile always passes grant2=true and disallows the
 * test-only revokeAtFault flag. This check cannot replace witness monotonicity
 * or current-grant checks at publication. */
export function validateProcessNativeFallbackOutcome(
  binding: ProcessNativeFallbackBindingV1,
  bindingInput: ProcessNativeFallbackBindingInput,
  outcome: ProcessNativeFallbackOutcomeV1,
  lowered: ProcessNativeFallbackLowered,
  authority: { readonly grant2: boolean; readonly revokeAtFault?: boolean } = { grant2: true },
): void {
  assertSubject(binding, bindingInput, lowered);
  assertAuthorityFlags(authority);
  if (outcome?.format !== 'aether.process-native-fallback-outcome/1')
    throw new TypeError('invalid native fallback outcome version');
  validateRuntimeSnapshot(outcome.after);
  const expected = replay({ binding, bindingInput, ...authority });
  const { nativeOutputDigest, format: _format, ...actual } = outcome;
  if (!canonical(actual, expected))
    throw new TypeError('native terminal result differs from exact-source execution');
  const output: NativeOutput = {
    tier: expected.tier, code: expected.tier === 3
      ? expected.code === 'authority_denied' ? 2 : 1 : 0,
    value: expected.state === 'completed' && expected.value?.tag === 'int'
      ? expected.value.value : '0',
    left: binding.frame.left.objectId, right: binding.frame.right.objectId,
    nextObjectId: expected.after.nextObjectId,
    records: expected.after.records.map(row => {
      const field = row.fields[0][1];
      if (field.tag !== 'int') throw new TypeError('invalid native terminal record');
      return [row.objectId, field.value] as const;
    }),
  };
  if (nativeOutputDigest !== domainDigest('aether.native-fallback-output/1', output))
    throw new TypeError('native terminal output digest mismatch');
}
