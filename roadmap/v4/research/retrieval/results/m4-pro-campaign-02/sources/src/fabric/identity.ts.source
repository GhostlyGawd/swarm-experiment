import { blake3 } from '../tier1/blake3.ts';
import { decodeCanonical, encodeCanonical, encodingLimits, exactObject, identifier, type EncodingLimits } from './encoding.ts';

export type Digest = string;
const DIGEST = /^(?:ast|struct|commit|prov|inv):b3:[0-9a-f]{64}$|^aether\.[a-z][a-z0-9.-]*\/[1-9][0-9]*:b3:[0-9a-f]{64}$/;
export function validateDigest(value: unknown, domain?: string): asserts value is Digest {
  if (typeof value !== 'string' || !DIGEST.test(value) || (domain !== undefined && !value.startsWith(`${domain}:b3:`))) throw new TypeError('invalid digest or domain');
}
/** Domain is part of the bytes being hashed, not merely a changeable display prefix. */
export function domainDigest(domain: string, value: unknown, limits: Partial<EncodingLimits> = {}): Digest {
  if (!/^aether\.[a-z][a-z0-9.-]*\/[1-9][0-9]*$/.test(domain)) throw new TypeError('invalid digest domain/version');
  const bytes = encodeCanonical({ domain, value }, limits);
  return `${domain}:b3:${Buffer.from(blake3(bytes)).toString('hex')}`;
}

export interface DependencyV1 { readonly symbol: string; readonly declaration: Digest }
export interface ExecutionManifestV1 {
  readonly format: 'aether.execution/1';
  readonly astRoot: Digest;
  readonly specRoot: Digest;
  readonly dependencies: readonly DependencyV1[];
  readonly semanticsVersion: string;
  readonly compilerDigest: Digest;
  readonly target: { readonly abiVersion: string; readonly profileDigest: Digest; readonly artifactDigest: Digest };
  readonly capabilityPolicyDigest: Digest;
  readonly evidencePolicyDigest: Digest;
}
function dependency(value: unknown): asserts value is DependencyV1 {
  const item = exactObject(value, ['symbol', 'declaration']); identifier(item.symbol); validateDigest(item.declaration);
}
/** Schema validation is separate from closure validation; admission must resolve the closure. */
export function validateExecutionManifest(value: unknown, limits: Partial<EncodingLimits> = {}): asserts value is ExecutionManifestV1 {
  encodeCanonical(value, limits);
  const m = exactObject(value, ['format', 'astRoot', 'specRoot', 'dependencies', 'semanticsVersion', 'compilerDigest', 'target', 'capabilityPolicyDigest', 'evidencePolicyDigest']);
  if (m.format !== 'aether.execution/1') throw new TypeError('unsupported execution manifest version');
  validateDigest(m.astRoot, 'ast'); validateDigest(m.specRoot);
  validateDigest(m.compilerDigest); validateDigest(m.capabilityPolicyDigest); validateDigest(m.evidencePolicyDigest); identifier(m.semanticsVersion);
  const target = exactObject(m.target, ['abiVersion', 'profileDigest', 'artifactDigest']);
  identifier(target.abiVersion); validateDigest(target.profileDigest); validateDigest(target.artifactDigest);
  if (!Array.isArray(m.dependencies)) throw new TypeError('invalid dependencies');
  let previous: string | undefined;
  for (const item of m.dependencies) {
    dependency(item);
    if (previous !== undefined && previous >= item.symbol) throw new TypeError('duplicate or unordered dependency symbol');
    previous = item.symbol;
  }
}
export function executionManifestDigest(manifest: ExecutionManifestV1, limits: Partial<EncodingLimits> = {}): Digest {
  validateExecutionManifest(manifest, limits); return domainDigest('aether.execution/1', manifest, limits);
}
export function encodeExecutionManifest(manifest: ExecutionManifestV1, limits: Partial<EncodingLimits> = {}): Uint8Array {
  validateExecutionManifest(manifest, limits); return encodeCanonical(manifest, limits);
}
export function decodeExecutionManifest(bytes: Uint8Array, limits: Partial<EncodingLimits> = {}): ExecutionManifestV1 {
  const value = decodeCanonical(bytes, limits); validateExecutionManifest(value, limits); return value;
}

export interface ResolvedDeclarationV1 {
  /** Content whose digest must equal the requested declaration, for versioned external summaries. */
  readonly declaration: Digest;
  readonly dependencies: readonly DependencyV1[];
}
export type DependencyResolver = (dependency: DependencyV1) => ResolvedDeclarationV1;
/** Resolver must content-verify stored declarations (e.g. GraphStore.get) before returning edges. */
export function dependencyClosure(roots: readonly DependencyV1[], resolve: DependencyResolver, overrides: Partial<EncodingLimits> = {}): readonly DependencyV1[] {
  const limits = encodingLimits(overrides);
  encodeCanonical(roots, limits);
  const visited = new Map<string, Digest>();
  const pending = [...roots];
  while (pending.length) {
    const current = pending.pop()!; dependency(current);
    const previous = visited.get(current.symbol);
    if (previous !== undefined) {
      if (previous !== current.declaration) throw new TypeError('conflicting dependency declarations');
      continue;
    }
    if (visited.size >= limits.maxObjects) throw new RangeError('dependency closure limit exceeded');
    visited.set(current.symbol, current.declaration);
    const resolved = resolve(Object.freeze({ ...current }));
    encodeCanonical(resolved, limits); exactObject(resolved, ['declaration', 'dependencies']);
    if (resolved.declaration !== current.declaration || !Array.isArray(resolved.dependencies)) throw new TypeError('missing or changed dependency');
    if (pending.length + resolved.dependencies.length > limits.maxObjects) throw new RangeError('dependency frontier limit exceeded');
    for (const child of resolved.dependencies) { dependency(child); pending.push(child); }
  }
  return [...visited].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([symbol, declaration]) => ({ symbol, declaration }));
}
export function createExecutionManifest(context: Omit<ExecutionManifestV1, 'format' | 'dependencies'>, roots: readonly DependencyV1[], resolve: DependencyResolver, limits: Partial<EncodingLimits> = {}): ExecutionManifestV1 {
  const manifest: ExecutionManifestV1 = { ...context, format: 'aether.execution/1', dependencies: dependencyClosure(roots, resolve, limits) };
  validateExecutionManifest(manifest, limits); return manifest;
}
export function verifyDependencyClosure(manifest: ExecutionManifestV1, roots: readonly DependencyV1[], resolve: DependencyResolver, limits: Partial<EncodingLimits> = {}): void {
  validateExecutionManifest(manifest, limits);
  const actual = dependencyClosure(roots, resolve, limits);
  if (Buffer.compare(encodeCanonical(actual, limits), encodeCanonical(manifest.dependencies, limits)) !== 0) throw new TypeError('incomplete or stale dependency closure');
}

export interface MetadataSidecarV1 {
  readonly format: 'aether.metadata/1';
  readonly subject: Digest;
  readonly kind: 'embedding' | 'adapter' | 'telemetry' | 'scratchpad' | 'proof_attempt' | 'synthesis';
  readonly schemaVersion: string;
  readonly payloadDigest: Digest;
}
export function validateMetadataSidecar(value: unknown, limits: Partial<EncodingLimits> = {}): asserts value is MetadataSidecarV1 {
  encodeCanonical(value, limits);
  const m = exactObject(value, ['format', 'subject', 'kind', 'schemaVersion', 'payloadDigest']);
  if (m.format !== 'aether.metadata/1') throw new TypeError('unsupported metadata version');
  validateDigest(m.subject); validateDigest(m.payloadDigest, 'aether.metadata-payload/1'); identifier(m.schemaVersion);
  if (typeof m.kind !== 'string' || !['embedding', 'adapter', 'telemetry', 'scratchpad', 'proof_attempt', 'synthesis'].includes(m.kind)) throw new TypeError('invalid metadata kind');
}
export function encodeMetadataSidecar(value: MetadataSidecarV1, limits: Partial<EncodingLimits> = {}): Uint8Array {
  validateMetadataSidecar(value, limits); return encodeCanonical(value, limits);
}
export function decodeMetadataSidecar(bytes: Uint8Array, limits: Partial<EncodingLimits> = {}): MetadataSidecarV1 {
  const value = decodeCanonical(bytes, limits); validateMetadataSidecar(value, limits); return value;
}
export function metadataSidecar(subject: Digest, kind: MetadataSidecarV1['kind'], schemaVersion: string, payload: unknown, limits: Partial<EncodingLimits> = {}): { sidecar: MetadataSidecarV1; digest: Digest } {
  validateDigest(subject); identifier(schemaVersion);
  if (!['embedding', 'adapter', 'telemetry', 'scratchpad', 'proof_attempt', 'synthesis'].includes(kind)) throw new TypeError('invalid metadata kind');
  const sidecar: MetadataSidecarV1 = { format: 'aether.metadata/1', subject, kind, schemaVersion, payloadDigest: domainDigest('aether.metadata-payload/1', payload, limits) };
  validateMetadataSidecar(sidecar, limits);
  return { sidecar, digest: domainDigest('aether.metadata/1', sidecar, limits) };
}
