/** Opt-in, same-store semantic retention for durable ProcessResumableSession
 * checkpoints. The marker is published only after all monotone GC pins, and
 * before ProcessHost may publish a checkpoint lease. */
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Term } from '../tier1/ast.ts';
import { DurableGraphStore } from '../tier1/durable-store.ts';
import type { NodeRef } from '../tier1/ids.ts';
import { SemanticGarbageCollector, type SemanticGcOptions, type SemanticRetention } from '../tier1/semantic-gc.ts';
import { GraphStore } from '../tier1/store.ts';
import { decodeCanonical, encodeCanonical, exactObject, identifier } from '../fabric/encoding.ts';
import { domainDigest, executionManifestDigest, validateExecutionManifest, type Digest, type ExecutionManifestV1 } from '../fabric/identity.ts';
import { atomicWriteOnce } from '../tier1/persistence.ts';
import type { ProcessCheckpointBinding } from './process-checkpoint-contract.ts';

const live = new WeakSet<ProcessSemanticRetention>();
type Source = Readonly<{ operationId: string; generation: string; beforeSnapshot: Digest }>;
type HostIdentity = Readonly<{ configuration: Digest; manifest: Digest; storage: string }>;
interface RetentionMarker {
  readonly format: 'aether.process-semantic-retention/1';
  readonly hostConfiguration: Digest;
  readonly hostManifest: Digest;
  readonly operationId: string;
  readonly generation: string;
  readonly beforeSnapshot: Digest;
  readonly repositoryId: string;
  readonly storeDirectory: string;
  readonly collectorDirectory: string;
  readonly roots: readonly NodeRef[];
  readonly reference: string;
  readonly id: Digest;
}
function same(a: unknown, b: unknown): boolean { return Buffer.from(encodeCanonical(a)).equals(Buffer.from(encodeCanonical(b))); }
function syncDirectory(path: string): void { const fd = openSync(path, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } }
function ensureMarkerDirectory(path: string): void {
  if (existsSync(path)) { if (!statSync(path).isDirectory()) throw new Error('process semantic retention marker path is not a directory'); return; }
  mkdirSync(path); syncDirectory(path); syncDirectory(dirname(path));
}
function markerPath(host: HostIdentity, operationId: string): string {
  identifier(operationId);
  const key = domainDigest('aether.process-semantic-retention-key/1', { configuration: host.configuration, operationId });
  return join(host.storage, 'checkpoint-semantic-retention', `${key.split(':').at(-1)}.json`);
}
function readMarker(host: HostIdentity, operationId: string): RetentionMarker | null {
  const path = markerPath(host, operationId);
  if (!existsSync(path)) return null;
  if (statSync(path).size > 1024 * 1024) throw new Error('process semantic retention marker size limit');
  const value = exactObject(decodeCanonical(readFileSync(path)), ['format', 'hostConfiguration', 'hostManifest', 'operationId', 'generation', 'beforeSnapshot', 'repositoryId', 'storeDirectory', 'collectorDirectory', 'roots', 'reference', 'id']) as unknown as RetentionMarker;
  const { id, ...body } = value;
  if (body.format !== 'aether.process-semantic-retention/1' || id !== domainDigest('aether.process-semantic-retention/1', body) || body.hostConfiguration !== host.configuration || body.hostManifest !== host.manifest || body.operationId !== operationId || !Array.isArray(body.roots) || !body.roots.length)
    throw new Error('process semantic retention marker identity mismatch');
  return value;
}
function source(binding: ProcessCheckpointBinding): Source { return { operationId: binding.operationId, generation: binding.generation, beforeSnapshot: binding.beforeSnapshot }; }

/** A single constructor supplies the same DurableGraphStore to both exact-root
 * validation and the SemanticGarbageCollector. The collector never accepts a
 * separate caller-supplied store after construction. */
export class ProcessSemanticRetention {
  readonly store: DurableGraphStore;
  readonly collector: SemanticGarbageCollector;
  readonly digest: Digest;
  private readonly repositoryId: string;
  private readonly collectorDirectory: string;
  private readonly storeDirectory: string;
  constructor(options: SemanticGcOptions) {
    this.store = options.store;
    this.collector = new SemanticGarbageCollector(options);
    this.repositoryId = options.repositoryId;
    this.collectorDirectory = realpathSync(options.directory);
    this.storeDirectory = realpathSync(options.store.directory);
    this.digest = domainDigest('aether.process-semantic-retention-authority/1', {
      repositoryId: options.repositoryId, storeDirectory: this.storeDirectory,
      collectorDirectory: this.collectorDirectory, policy: options.policy,
      profile: options.profile ?? 'aether.semantic-gc-closed-forwarders/1',
      registry: [...options.registry.names].sort().map(name => options.registry.get(name)!),
    });
    live.add(this);
    Object.freeze(this);
  }
  static authorityDigest(value: ProcessSemanticRetention): Digest {
    ProcessSemanticRetention.assertInstance(value);
    return value.digest;
  }
  private static assertInstance(value: ProcessSemanticRetention): void {
    if (!live.has(value)) throw new TypeError('untrusted process semantic retention boundary');
  }
  private roots(module: Term, manifest: ExecutionManifestV1): readonly NodeRef[] {
    validateExecutionManifest(manifest);
    const root = new GraphStore().intern(module);
    if (root !== manifest.astRoot) throw new Error('process semantic retention module/manifest mismatch');
    const roots = [manifest.astRoot, ...manifest.dependencies.map(item => item.declaration)];
    if (roots.some(item => !item.startsWith('ast:b3:'))) throw new Error('process semantic retention requires durable AST dependency roots');
    for (const item of roots) DurableGraphStore.prototype.hydrate.call(this.store, item as NodeRef);
    return [...new Set(roots)] as NodeRef[];
  }
  private marker(host: HostIdentity, module: Term, manifest: ExecutionManifestV1, item: Source): RetentionMarker {
    if (host.manifest !== executionManifestDigest(manifest)) throw new Error('process semantic retention host/manifest mismatch');
    identifier(item.operationId); identifier(item.generation);
    const roots = this.roots(module, manifest);
    const reference = `process-checkpoint:${domainDigest('aether.process-semantic-retention-reference/1', { configuration: host.configuration, manifest: host.manifest, ...item }).split(':').at(-1)}`;
    const body = { format: 'aether.process-semantic-retention/1' as const, hostConfiguration: host.configuration, hostManifest: host.manifest,
      operationId: item.operationId, generation: item.generation, beforeSnapshot: item.beforeSnapshot,
      repositoryId: this.repositoryId, storeDirectory: this.storeDirectory, collectorDirectory: this.collectorDirectory, roots, reference };
    return { ...body, id: domainDigest('aether.process-semantic-retention/1', body) };
  }
  /** Pins both live task and durable replay/history roots before host.beginCheckpoint. */
  prepare(identity: HostIdentity, module: Term, manifest: ExecutionManifestV1, item: Source): void {
    ProcessSemanticRetention.assertInstance(this);
    const expected = this.marker(identity, module, manifest, item);
    const previous = readMarker(identity, item.operationId);
    if (previous && !same(previous, expected)) throw new Error('process semantic retention operation identity conflict');
    for (const kind of ['active-task', 'replay'] as const) for (const root of expected.roots)
      SemanticGarbageCollector.prototype.retain.call(this.collector, { kind, reference: expected.reference, root });
    this.assertRecords(expected);
    if (!previous) {
      const path = markerPath(identity, item.operationId);
      ensureMarkerDirectory(dirname(path));
      atomicWriteOnce(path, Buffer.from(encodeCanonical(expected)).toString());
      syncDirectory(dirname(path));
    }
    if (!same(readMarker(identity, item.operationId), expected)) throw new Error('process semantic retention marker conflict');
  }
  private assertRecords(marker: RetentionMarker): void {
    const records = SemanticGarbageCollector.prototype.retentions.call(this.collector);
    for (const kind of ['active-task', 'replay'] as const) for (const root of marker.roots) {
      const wanted: SemanticRetention = { kind, reference: marker.reference, root };
      if (!records.some(record => same(record, wanted))) throw new Error('process semantic retention record missing');
      DurableGraphStore.prototype.hydrate.call(this.store, root);
    }
  }
  assert(identity: HostIdentity, module: Term, manifest: ExecutionManifestV1, binding: ProcessCheckpointBinding): void {
    ProcessSemanticRetention.assertInstance(this);
    const expected = this.marker(identity, module, manifest, source(binding));
    const actual = readMarker(identity, binding.operationId);
    if (!actual || !same(actual, expected)) throw new Error('process semantic retention marker missing or identity changed');
    this.assertRecords(expected);
  }
}
