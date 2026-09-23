/** Content-bound admission for trusted, self-contained JavaScript effect adapters.
 * Importing the approved bytes runs them with Node process privileges. This is
 * code provenance, not a sandbox or a proof of the adapter's effect semantics.
 */
import { createHash } from 'node:crypto';
import { TextDecoder } from 'node:util';
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
const admitted = new WeakMap<EffectAdapter, Digest>();
const SHA256 = /^[0-9a-f]{64}$/;
const MAX_SOURCE_BYTES = 1024 * 1024;
function validateArtifact(value: unknown): asserts value is AdapterArtifactV1 {
  encodeCanonical(value);
  const artifact = exactObject(value, ['format', 'capability', 'id', 'semantics', 'sourceSha256']);
  if (artifact.format !== 'aether.effect-adapter-artifact/1') throw new TypeError('unsupported adapter artifact version');
  capability(artifact.capability as string); identifier(artifact.id);
  const semantics = exactObject(artifact.semantics, ['readOnly', 'atomicIdempotency', 'transactional', 'reconciliation']);
  if (Object.values(semantics).some(flag => typeof flag !== 'boolean')) throw new TypeError('invalid declared adapter semantics');
  if (typeof artifact.sourceSha256 !== 'string' || !SHA256.test(artifact.sourceSha256)) throw new TypeError('invalid adapter source hash');
}
export function adapterArtifactDigest(artifact: AdapterArtifactV1): Digest {
  validateArtifact(artifact);
  return domainDigest('aether.effect-adapter-artifact/1', artifact);
}
export function adapterArtifactForSource(source: Uint8Array, capabilityName: CapabilityName, id: string, semantics: EffectAdapter['semantics']): AdapterArtifactV1 {
  if (!(source instanceof Uint8Array) || source.byteLength < 1 || source.byteLength > MAX_SOURCE_BYTES) throw new RangeError('adapter source byte bound');
  const artifact: AdapterArtifactV1 = { format: 'aether.effect-adapter-artifact/1', capability: capabilityName, id,
    semantics: { ...semantics }, sourceSha256: createHash('sha256').update(source).digest('hex') };
  validateArtifact(artifact); return artifact;
}
/** The caller must obtain `artifact` from an independently approved manifest.
 * A caller choosing both bytes and expected hash has no external authority. */
export async function admitAdapterSource(source: Uint8Array, artifact: AdapterArtifactV1): Promise<EffectAdapter> {
  validateArtifact(artifact);
  // Capture caller-owned metadata before the first await. No later decision
  // may observe a mutable descriptor supplied by the caller.
  const approved = decodeCanonical(encodeCanonical(artifact)) as unknown as AdapterArtifactV1;
  validateArtifact(approved); Object.freeze(approved.semantics); Object.freeze(approved);
  if (!(source instanceof Uint8Array) || source.byteLength < 1 || source.byteLength > MAX_SOURCE_BYTES) throw new RangeError('adapter source byte bound');
  const bytes = Buffer.from(source);
  if (createHash('sha256').update(bytes).digest('hex') !== approved.sourceSha256) throw new TypeError('adapter source does not match approved artifact');
  new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  // The exact checked bytes become the module URL, avoiding a file-read/import
  // substitution. Node data: imports still have process privileges.
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
