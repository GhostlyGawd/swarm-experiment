/** Content-bound admission for trusted JavaScript effect adapters. New V2
 * artifacts close module-syntax dependencies; explicit legacy V1 artifacts can
 * still import modules. Both run with Node process privileges. Import-free
 * syntax does not isolate ambient globals, eval, or Function constructors.
 * This is code provenance, not a malicious-code sandbox or a semantics proof.
 */
import { createHash } from 'node:crypto';
import { TextDecoder } from 'node:util';
import { parse } from 'acorn';
import { full } from 'acorn-walk';
import { decodeCanonical, encodeCanonical, exactObject, identifier } from '../fabric/encoding.ts';
import { domainDigest, validateDigest, type Digest } from '../fabric/identity.ts';
import { effectAdapterDigest, type EffectAdapter } from '../fabric/effects.ts';
import { capability, type CapabilityName } from '../tier1/ids.ts';

export interface AdapterArtifactV1 {
  readonly format: 'aether.effect-adapter-artifact/1';
  readonly capability: CapabilityName;
  readonly id: string;
  readonly semantics: EffectAdapter['semantics'];
  readonly sourceSha256: string;
}
/** V2 records the module dependency rule in the signed artifact itself. */
export interface AdapterArtifactV2 {
  readonly format: 'aether.effect-adapter-artifact/2';
  readonly capability: CapabilityName;
  readonly id: string;
  readonly semantics: EffectAdapter['semantics'];
  readonly sourceSha256: string;
  readonly sourceProfile: 'aether.adapter-js-import-free/1';
}
/** Source identity and limits for a separately executed, import-free Wasm
 * scalar guest. Admission still requires checking the actual module bytes. */
export interface AdapterArtifactV3 {
  readonly format: 'aether.effect-adapter-artifact/3';
  readonly capability: CapabilityName;
  readonly id: string;
  readonly semantics: EffectAdapter['semantics'];
  readonly sourceSha256: string;
  readonly sourceProfile: 'aether.adapter-wasm-i32-readonly/1';
  readonly maxMemoryPages: number;
  readonly timeoutMs: number;
}
export type AdapterArtifact = AdapterArtifactV1 | AdapterArtifactV2 | AdapterArtifactV3;
const admitted = new WeakMap<EffectAdapter, Digest>();
const SHA256 = /^[0-9a-f]{64}$/;
const MAX_SOURCE_BYTES = 1024 * 1024;
const MAX_WASM_BYTES = 64 * 1024;
const WASM_SEMANTICS = Object.freeze({ readOnly: true, atomicIdempotency: true, transactional: false, reconciliation: true });
function validateArtifact(value: unknown): asserts value is AdapterArtifact {
  encodeCanonical(value);
  const format = (value as { format?: unknown }).format;
  if (format !== 'aether.effect-adapter-artifact/1' && format !== 'aether.effect-adapter-artifact/2'
    && format !== 'aether.effect-adapter-artifact/3') throw new TypeError('unsupported adapter artifact version');
  const artifact = exactObject(value, format === 'aether.effect-adapter-artifact/1'
    ? ['format', 'capability', 'id', 'semantics', 'sourceSha256']
    : format === 'aether.effect-adapter-artifact/2'
      ? ['format', 'capability', 'id', 'semantics', 'sourceSha256', 'sourceProfile']
      : ['format', 'capability', 'id', 'semantics', 'sourceSha256', 'sourceProfile', 'maxMemoryPages', 'timeoutMs']);
  if (format === 'aether.effect-adapter-artifact/2' && artifact.sourceProfile !== 'aether.adapter-js-import-free/1') throw new TypeError('unsupported adapter source profile');
  if (format === 'aether.effect-adapter-artifact/3' && artifact.sourceProfile !== 'aether.adapter-wasm-i32-readonly/1') throw new TypeError('unsupported Wasm adapter source profile');
  capability(artifact.capability as string); identifier(artifact.id);
  const semantics = exactObject(artifact.semantics, ['readOnly', 'atomicIdempotency', 'transactional', 'reconciliation']);
  if (Object.values(semantics).some(flag => typeof flag !== 'boolean')) throw new TypeError('invalid declared adapter semantics');
  if (format === 'aether.effect-adapter-artifact/3'
    && (semantics.readOnly !== true || semantics.atomicIdempotency !== true || semantics.transactional !== false || semantics.reconciliation !== true
      || !Number.isSafeInteger(artifact.maxMemoryPages) || (artifact.maxMemoryPages as number) < 1 || (artifact.maxMemoryPages as number) > 256
      || !Number.isSafeInteger(artifact.timeoutMs) || (artifact.timeoutMs as number) < 1 || (artifact.timeoutMs as number) > 5000))
    throw new TypeError('invalid bounded Wasm adapter descriptor');
  if (typeof artifact.sourceSha256 !== 'string' || !SHA256.test(artifact.sourceSha256)) throw new TypeError('invalid adapter source hash');
}
export function adapterArtifactDigest(artifact: AdapterArtifact): Digest {
  validateArtifact(artifact);
  return domainDigest(artifact.format, artifact);
}
/** Rebuild a previously approved V1 descriptor without changing its identity.
 * Import-capable V1 source can only be loaded with the explicit legacy option. */
export function legacyAdapterArtifactForSource(source: Uint8Array, capabilityName: CapabilityName, id: string, semantics: EffectAdapter['semantics']): AdapterArtifactV1 {
  if (!(source instanceof Uint8Array) || source.byteLength < 1 || source.byteLength > MAX_SOURCE_BYTES) throw new RangeError('adapter source byte bound');
  const artifact: AdapterArtifactV1 = { format: 'aether.effect-adapter-artifact/1', capability: capabilityName, id,
    semantics: { ...semantics }, sourceSha256: createHash('sha256').update(source).digest('hex') };
  validateArtifact(artifact); return artifact;
}
/** New artifacts sign this dependency-closed profile by default. */
export function adapterArtifactForSource(source: Uint8Array, capabilityName: CapabilityName, id: string, semantics: EffectAdapter['semantics']): AdapterArtifactV2 {
  if (!(source instanceof Uint8Array) || source.byteLength < 1 || source.byteLength > MAX_SOURCE_BYTES) throw new RangeError('adapter source byte bound');
  const bytes = Buffer.from(source);
  assertImportFreeModule(bytes);
  const artifact: AdapterArtifactV2 = { format: 'aether.effect-adapter-artifact/2', capability: capabilityName, id,
    semantics: { ...semantics }, sourceSha256: createHash('sha256').update(bytes).digest('hex'), sourceProfile: 'aether.adapter-js-import-free/1' };
  validateArtifact(artifact); return artifact;
}
export const importFreeAdapterArtifactForSource = adapterArtifactForSource;
/** Describe exact Wasm bytes; this does not itself authorize or instantiate
 * the module. An independent signed policy must approve this digest. */
export function wasmAdapterArtifactForBytes(bytes: Uint8Array, capabilityName: CapabilityName, id: string,
  limits: Readonly<{ maxMemoryPages: number; timeoutMs: number }>): AdapterArtifactV3 {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > MAX_WASM_BYTES) throw new RangeError('Wasm adapter source byte bound');
  const artifact: AdapterArtifactV3 = { format: 'aether.effect-adapter-artifact/3', capability: capabilityName, id,
    semantics: { ...WASM_SEMANTICS }, sourceSha256: createHash('sha256').update(bytes).digest('hex'),
    sourceProfile: 'aether.adapter-wasm-i32-readonly/1', maxMemoryPages: limits.maxMemoryPages, timeoutMs: limits.timeoutMs };
  validateArtifact(artifact); return artifact;
}
/** Parse complete module syntax. Strings, comments, and regex text do not count
 * as imports. Unsupported syntax fails closed before any source is evaluated.
 * This is dependency closure for trusted JS, not hostile-code isolation. */
function assertImportFreeModule(bytes: Uint8Array): void {
  const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const program = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
  full(program, node => {
    if (node.type === 'ImportDeclaration' || node.type === 'ImportExpression' || node.type === 'ExportAllDeclaration'
      || node.type === 'ExportNamedDeclaration' && node.source != null
      || node.type === 'MetaProperty' && node.meta.name === 'import') {
      throw new TypeError('adapter import-free source profile forbids module dependencies');
    }
  });
}
export interface AdapterAdmissionOptions { readonly legacyProfile?: 'aether.adapter-js-legacy-v1/1' }
/** The caller must obtain `artifact` from an independently approved manifest.
 * A caller choosing both bytes and expected hash has no external authority. */
export async function admitAdapterSource(source: Uint8Array, artifact: AdapterArtifact, options: AdapterAdmissionOptions = {}): Promise<EffectAdapter> {
  validateArtifact(artifact);
  if (artifact.format === 'aether.effect-adapter-artifact/3') throw new TypeError('Wasm artifact requires isolated Wasm admission');
  // Capture caller-owned metadata before the first await. No later decision
  // may observe a mutable descriptor supplied by the caller.
  const approved = decodeCanonical(encodeCanonical(artifact)) as unknown as AdapterArtifact;
  validateArtifact(approved); Object.freeze(approved.semantics); Object.freeze(approved);
  if (!(source instanceof Uint8Array) || source.byteLength < 1 || source.byteLength > MAX_SOURCE_BYTES) throw new RangeError('adapter source byte bound');
  const bytes = Buffer.from(source);
  if (createHash('sha256').update(bytes).digest('hex') !== approved.sourceSha256) throw new TypeError('adapter source does not match approved artifact');
  if (approved.format === 'aether.effect-adapter-artifact/1') {
    if (options.legacyProfile !== 'aether.adapter-js-legacy-v1/1') throw new TypeError('V1 adapter source requires explicit legacy admission profile');
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } else {
    if (options.legacyProfile !== undefined) throw new TypeError('legacy admission profile cannot authorize V2 adapter source');
    assertImportFreeModule(bytes);
  }
  // The exact checked bytes become the module URL, avoiding a file-read/import
  // substitution. V1 legacy imports and ambient JS access use process privileges.
  const namespace = await import(`data:text/javascript;base64,${bytes.toString('base64')}`) as { default?: unknown };
  if (!namespace.default || typeof namespace.default !== 'object') throw new TypeError('adapter module must export a default object');
  const implementation = namespace.default as EffectAdapter;
  const declared = { id: implementation.id, semantics: implementation.semantics };
  if (implementation.id !== approved.id || effectAdapterDigest(implementation) !== domainDigest('aether.effect-adapter/1', { id: approved.id, semantics: approved.semantics })) throw new TypeError('adapter implementation differs from approved descriptor');
  if (!declared.semantics || typeof declared.semantics !== 'object') throw new TypeError('adapter semantics missing');
  Object.freeze(implementation.semantics); Object.freeze(implementation);
  const adapter: EffectAdapter = Object.freeze({ id: approved.id, semantics: Object.freeze({ ...approved.semantics }),
    ...(implementation.execute ? { execute: implementation.execute.bind(implementation) } : {}),
    ...(implementation.prepare ? { prepare: implementation.prepare.bind(implementation) } : {}),
    ...(implementation.commit ? { commit: implementation.commit.bind(implementation) } : {}),
    ...(implementation.abort ? { abort: implementation.abort.bind(implementation) } : {}),
    ...(implementation.reconcile ? { reconcile: implementation.reconcile.bind(implementation) } : {}),
  });
  if (effectAdapterDigest(adapter) !== effectAdapterDigest(implementation)) throw new TypeError('adapter descriptor changed during admission');
  admitted.set(adapter, adapterArtifactDigest(approved));
  return adapter;
}
export function admittedAdapterArtifactDigest(adapter: EffectAdapter): Digest | null {
  const value = admitted.get(adapter);
  if (!value) return null;
  effectAdapterDigest(adapter); return value;
}
