/** Exact admission subject for the bounded record-native fallback profile.
 *
 * This contract binds a checked source proof and a real process snapshot to
 * native artifact identities. It does not execute or publish native state;
 * ProcessHost still needs a witnessed transactional journal transition.
 */
import { decimal, encodeCanonical, exactObject, identifier,
  validateLogicalRef, type LogicalRefV1 } from '../fabric/encoding.ts';
import { domainDigest, executionManifestDigest, validateDigest,
  type Digest } from '../fabric/identity.ts';
import { runtimeSnapshotDigest, validateRuntimeSnapshot,
  type RuntimeSnapshotV1 } from '../fabric/snapshot.ts';
import { GraphStore } from '../tier1/store.ts';
import type { SymbolId } from '../tier1/ids.ts';
import { RECORD_FALLBACK_PROFILE, RECORD_FALLBACK_PROFILE_DIGEST,
  validateCheckedRecordFallbackProof, type CheckedRecordFallbackProof,
  type RecordFallbackContext } from '../tier2/record-fallback-proof-checker.ts';

export const NATIVE_FALLBACK_COMPILER_PROFILE = Object.freeze({
  format: 'aether.native-fallback-compiler-profile/1',
  frame: 'aether.native-fallback-frame/1',
  proofProfile: RECORD_FALLBACK_PROFILE_DIGEST,
  result: 'bounded-record-int-tier-and-complete-frame/1',
  effects: 'none',
});
export const NATIVE_FALLBACK_COMPILER_PROFILE_DIGEST = domainDigest(
  'aether.native-fallback-compiler-profile/1', NATIVE_FALLBACK_COMPILER_PROFILE);

export interface NativeFallbackFrameV1 {
  readonly format: 'aether.native-fallback-frame/1';
  readonly id: Digest;
  readonly executionManifest: Digest;
  readonly sourceSnapshot: Digest;
  readonly heapId: string;
  readonly nextObjectId: string;
  readonly left: LogicalRefV1;
  readonly right: LogicalRefV1;
  readonly values: readonly string[];
}
export interface ProcessNativeFallbackBindingV1 {
  readonly format: 'aether.process-native-fallback-binding/1';
  readonly id: Digest;
  readonly operationId: string;
  readonly configuration: Digest;
  readonly generation: string;
  readonly unit: string;
  readonly processHead: Digest;
  readonly manifestDigest: Digest;
  readonly astRoot: Digest;
  readonly tier1: SymbolId;
  readonly tier2: SymbolId;
  readonly frame: NativeFallbackFrameV1;
  readonly proofDigest: Digest;
  readonly compilerProfileDigest: Digest;
  readonly sourceSha256: string;
  readonly executableSha256: string;
}
export interface ProcessNativeFallbackBindingInput {
  readonly operationId: string;
  readonly configuration: Digest;
  readonly generation: string;
  readonly unit: string;
  readonly processHead: Digest;
  readonly context: RecordFallbackContext;
  readonly tier1: SymbolId;
  readonly checkedProof: CheckedRecordFallbackProof;
  readonly snapshot: RuntimeSnapshotV1;
  readonly left: LogicalRefV1;
  readonly right: LogicalRefV1;
  readonly sourceSha256: string;
  readonly executableSha256: string;
}
const same = (left: unknown, right: unknown): boolean =>
  Buffer.from(encodeCanonical(left)).equals(Buffer.from(encodeCanonical(right)));
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}
const sha256 = (value: string): void => {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value))
    throw new TypeError('native fallback requires exact SHA-256 bytes');
};

/** The identical frame bounds must be checked before proof admission and
 * before producing CLI/native bytes. A missing allocation slot could make
 * native Tier 2 abort where the reference runtime succeeds. RuntimeSnapshotV1
 * carries field values but not declared record types: the admitting host must
 * also validate argument types against its retained allocation/type history. */
export function projectNativeFallbackFrame(snapshot: RuntimeSnapshotV1,
  manifestDigest: Digest, left: LogicalRefV1, right: LogicalRefV1): NativeFallbackFrameV1 {
  validateRuntimeSnapshot(snapshot);
  validateDigest(manifestDigest, 'aether.execution/1');
  validateLogicalRef(left); validateLogicalRef(right);
  if (snapshot.executionManifest !== manifestDigest)
    throw new TypeError('native fallback snapshot/manifest mismatch');
  const nextId = Number(snapshot.nextObjectId);
  if (!RECORD_FALLBACK_PROFILE.admittedNextIds.includes(nextId)
    || snapshot.records.length !== nextId - 1 || snapshot.ownership.length !== nextId - 1)
    throw new RangeError('native fallback snapshot exceeds bounded frame');
  const owners = new Map(snapshot.ownership.map(item => [item.objectId, item.epoch]));
  for (const ref of [left, right]) if (ref.heapId !== snapshot.heapId
    || owners.get(ref.objectId) !== ref.ownerEpoch
    || !snapshot.records.some(item => item.objectId === ref.objectId))
    throw new TypeError('native fallback reference ownership mismatch');
  const min = BigInt(RECORD_FALLBACK_PROFILE.inputMin);
  const max = BigInt(RECORD_FALLBACK_PROFILE.inputMax);
  const values = snapshot.records.map((record, index) => {
    if (record.objectId !== String(index + 1) || record.fields.length !== 1
      || record.fields[0][0] !== 'value' || record.fields[0][1].tag !== 'int')
      throw new TypeError('native fallback requires contiguous one-field Int records');
    const value = BigInt(record.fields[0][1].value);
    if (value < min || value > max)
      throw new RangeError('native fallback snapshot integer outside qualified range');
    return String(value);
  });
  const body = { format: 'aether.native-fallback-frame/1' as const,
    executionManifest: manifestDigest, sourceSnapshot: runtimeSnapshotDigest(snapshot),
    heapId: snapshot.heapId, nextObjectId: snapshot.nextObjectId,
    left: { heapId: left.heapId, objectId: left.objectId, ownerEpoch: left.ownerEpoch },
    right: { heapId: right.heapId, objectId: right.objectId, ownerEpoch: right.ownerEpoch }, values };
  return freeze({ ...body, id: domainDigest('aether.native-fallback-frame/1', body) });
}

export function processNativeFallbackBindingDigest(
  value: Omit<ProcessNativeFallbackBindingV1, 'id'>): Digest {
  return domainDigest('aether.process-native-fallback-binding/1', value);
}
export function createProcessNativeFallbackBinding(
  input: ProcessNativeFallbackBindingInput): ProcessNativeFallbackBindingV1 {
  identifier(input.operationId); identifier(input.unit); decimal(input.generation);
  validateDigest(input.configuration); validateDigest(input.processHead, 'aether.process-state-head/1');
  sha256(input.sourceSha256); sha256(input.executableSha256);
  validateCheckedRecordFallbackProof(input.checkedProof, input.context);
  const module = input.context.module;
  if (module.kind !== 'Module' || module.members.length !== 2
    || input.tier1 === input.context.tier2)
    throw new TypeError('native fallback tier pair mismatch');
  const one = module.members.find(member => member.kind === 'FunctionDecl'
    && member.symbol === input.tier1);
  const two = module.members.find(member => member.kind === 'FunctionDecl'
    && member.symbol === input.context.tier2);
  if (!one || one.kind !== 'FunctionDecl' || !two || two.kind !== 'FunctionDecl'
    || !one.body || !two.body || !one.contract || !two.contract
    || one.purity !== 'pure' || two.purity !== 'pure'
    || one.capabilities.length || two.capabilities.length
    || one.typeParams.length || two.typeParams.length
    || one.surfaces.length || two.surfaces.length
    || !same(one.params, two.params) || !same(one.returns, two.returns)
    || new GraphStore().intern(one.contract) !== new GraphStore().intern(two.contract))
    throw new TypeError('native fallback tiers require one exact pure signature and contract');
  const manifestDigest = executionManifestDigest(input.context.manifest);
  const frame = projectNativeFallbackFrame(input.snapshot, manifestDigest, input.left, input.right);
  const body = { format: 'aether.process-native-fallback-binding/1' as const,
    operationId: input.operationId, configuration: input.configuration,
    generation: input.generation, unit: input.unit, processHead: input.processHead,
    manifestDigest, astRoot: new GraphStore().intern(input.context.module),
    tier1: input.tier1, tier2: input.context.tier2, frame,
    proofDigest: input.checkedProof.certificateDigest,
    compilerProfileDigest: NATIVE_FALLBACK_COMPILER_PROFILE_DIGEST,
    sourceSha256: input.sourceSha256, executableSha256: input.executableSha256 };
  return freeze({ ...body, id: processNativeFallbackBindingDigest(body) });
}
/** Reopen check: all declarative identity fields are recomputed from the
 * operator-pinned trust inputs and the retained source snapshot. */
export function assertProcessNativeFallbackBinding(value: ProcessNativeFallbackBindingV1,
  input: ProcessNativeFallbackBindingInput): void {
  exactObject(value, ['format', 'id', 'operationId', 'configuration', 'generation',
    'unit', 'processHead', 'manifestDigest', 'astRoot', 'tier1', 'tier2', 'frame',
    'proofDigest', 'compilerProfileDigest', 'sourceSha256', 'executableSha256']);
  exactObject(value.frame, ['format', 'id', 'executionManifest', 'sourceSnapshot',
    'heapId', 'nextObjectId', 'left', 'right', 'values']);
  const expected = createProcessNativeFallbackBinding(input);
  if (!same(value, expected)) throw new TypeError('native fallback binding differs from exact retained subject');
}
