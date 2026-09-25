/** Opt-in same-store authority for direct resumable tasks. Active roots are
 * pinned before the first frame is published. Pins are monotone: task completion
 * and elapsed time do not authorize their release in this profile. */
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DurableGraphStore } from '../tier1/durable-store.ts';
import type { NodeRef } from '../tier1/ids.ts';
import { SemanticGarbageCollector, type SemanticGcOptions, type SemanticRetention } from '../tier1/semantic-gc.ts';
import { atomicWriteOnce } from '../tier1/persistence.ts';
import { decodeCanonical, encodeCanonical, exactObject, identifier } from '../fabric/encoding.ts';
import { domainDigest, executionManifestDigest, validateExecutionManifest, type Digest } from '../fabric/identity.ts';
import type { ResumableProgram } from './resumable-program.ts';

const live = new WeakSet<ActiveTaskSemanticRetention>();
const format = 'aether.direct-active-task-semantic-retention/1' as const;
interface Marker {
  readonly format: typeof format;
  readonly executionId: string;
  readonly programDigest: Digest;
  readonly manifestDigest: Digest;
  readonly repositoryId: string;
  readonly storeDirectory: string;
  readonly collectorDirectory: string;
  readonly collectorConfiguration: Digest;
  readonly roots: readonly NodeRef[];
  readonly reference: string;
  readonly id: Digest;
}
const same = (left: unknown, right: unknown): boolean => Buffer.from(encodeCanonical(left)).equals(Buffer.from(encodeCanonical(right)));
function sync(path: string): void { const fd = openSync(path, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } }
function ensureDirectory(path: string): void {
  if (existsSync(path)) { if (!statSync(path).isDirectory()) throw new Error('active task retention marker path is not a directory'); return; }
  mkdirSync(path); sync(path); sync(dirname(path));
}
function markerPath(directory: string, executionId: string): string {
  identifier(executionId);
  return join(directory, 'active-tasks', `${executionKey(executionId)}.json`);
}
function executionKey(executionId: string): string {
  return domainDigest('aether.direct-active-task-marker-key/1', executionId).split(':').at(-1)!;
}
function readMarker(path: string): Marker | null {
  if (!existsSync(path)) return null;
  if (statSync(path).size > 1024 * 1024) throw new Error('active task semantic retention marker size limit');
  const value = exactObject(decodeCanonical(readFileSync(path)), ['format', 'executionId', 'programDigest', 'manifestDigest', 'repositoryId', 'storeDirectory', 'collectorDirectory', 'collectorConfiguration', 'roots', 'reference', 'id']) as unknown as Marker;
  const { id, ...body } = value;
  if (body.format !== format || id !== domainDigest(format, body)) throw new Error('active task semantic retention marker corrupt');
  return value;
}

/** The exact same graph store is used to validate roots and to hold the GC
 * leases. A caller cannot swap either resource between pinning and starting. */
export class ActiveTaskSemanticRetention {
  readonly store: DurableGraphStore;
  readonly collector: SemanticGarbageCollector;
  readonly digest: Digest;
  private readonly repositoryId: string;
  private readonly storeDirectory: string;
  private readonly collectorDirectory: string;
  private readonly collectorConfiguration: Digest;
  private readonly profileText: string;
  constructor(options: SemanticGcOptions) {
    this.store = options.store;
    this.collector = new SemanticGarbageCollector(options);
    this.repositoryId = options.repositoryId;
    this.storeDirectory = realpathSync(options.store.directory);
    this.collectorDirectory = realpathSync(options.directory);
    this.profileText = readFileSync(join(this.collectorDirectory, 'profile.json'), 'utf8');
    this.collectorConfiguration = domainDigest('aether.semantic-gc-config/1', decodeCanonical(Buffer.from(this.profileText)));
    this.digest = domainDigest('aether.direct-active-task-semantic-authority/1', {
      repositoryId: this.repositoryId, storeDirectory: this.storeDirectory,
      collectorDirectory: this.collectorDirectory, collectorConfiguration: this.collectorConfiguration,
    });
    live.add(this);
    Object.freeze(this);
  }
  static assertInstance(value: ActiveTaskSemanticRetention): void {
    if (!live.has(value)) throw new TypeError('untrusted direct active task semantic retention authority');
  }
  private expected(program: ResumableProgram, executionId: string): Marker {
    ActiveTaskSemanticRetention.assertInstance(this);
    identifier(executionId); validateExecutionManifest(program.manifest);
    const { digest: programDigest, ...body } = program;
    if (programDigest !== domainDigest('aether.resumable-program/1', body,
      { maxDepth: 128, maxObjects: 1_000_000, maxFrameBytes: 16 * 1024 * 1024, maxDecompressedBytes: 16 * 1024 * 1024 }))
      throw new Error('active task semantic retention program digest mismatch');
    const manifestDigest = executionManifestDigest(program.manifest);
    if (manifestDigest !== program.manifestDigest) throw new Error('active task semantic retention program/manifest mismatch');
    const roots = [program.manifest.astRoot, ...program.manifest.dependencies.map(item => item.declaration)];
    if (roots.some(root => !root.startsWith('ast:b3:'))) throw new Error('active task semantic retention requires AST dependency roots');
    const unique = [...new Set(roots)] as NodeRef[];
    const module = DurableGraphStore.prototype.hydrate.call(this.store, program.manifest.astRoot as NodeRef);
    if (module.kind !== 'Module') throw new Error('active task semantic retention root is not a module');
    for (const item of program.manifest.dependencies) {
      const declaration = DurableGraphStore.prototype.hydrate.call(this.store, item.declaration as NodeRef);
      if (declaration.kind !== 'FunctionDecl' || declaration.symbol !== item.symbol)
        throw new Error('active task semantic retention dependency declaration mismatch');
    }
    const reference = `direct-active-task:${executionKey(executionId)}:${domainDigest('aether.direct-active-task-semantic-reference/1', {
      executionId, programDigest, manifestDigest, repositoryId: this.repositoryId,
      storeDirectory: this.storeDirectory, collectorDirectory: this.collectorDirectory,
    }).split(':').at(-1)}`;
    const markerBody = { format, executionId, programDigest, manifestDigest, repositoryId: this.repositoryId,
      storeDirectory: this.storeDirectory, collectorDirectory: this.collectorDirectory,
      collectorConfiguration: this.collectorConfiguration, roots: unique, reference };
    return { ...markerBody, id: domainDigest(format, markerBody) };
  }
  private assertPins(marker: Marker): void {
    const path = join(this.collectorDirectory, 'profile.json');
    if (!existsSync(path) || readFileSync(path, 'utf8') !== this.profileText)
      throw new Error('active task semantic retention collector profile missing or changed');
    const records = SemanticGarbageCollector.prototype.retentions.call(this.collector);
    const leases = DurableGraphStore.prototype.roots.call(this.store).leases;
    for (const root of marker.roots) {
      const wanted: SemanticRetention = { kind: 'active-task', reference: marker.reference, root };
      const lease = `semantic-gc-retention:${domainDigest('aether.semantic-retention/1', { configuration: this.collectorConfiguration, ...wanted })}`;
      if (!records.some(record => same(record, wanted)) || !Array.isArray(leases[lease]) || !same(leases[lease], [root]))
        throw new Error('active task semantic retention pin missing or changed');
      DurableGraphStore.prototype.hydrate.call(this.store, root);
    }
  }
  /** A prior marker is validated, never repaired. An interrupted first pin
   * attempt remains conservatively retained and requires operator recovery. */
  prepare(program: ResumableProgram, executionId: string): void {
    const expected = this.expected(program, executionId), path = markerPath(this.collectorDirectory, executionId), prior = readMarker(path);
    if (prior) { if (!same(prior, expected)) throw new Error('active task semantic retention marker identity changed'); this.assertPins(expected); return; }
    if (SemanticGarbageCollector.prototype.retentions.call(this.collector).some(record => record.kind === 'active-task' && record.reference.startsWith(`direct-active-task:${executionKey(executionId)}:`)))
      throw new Error('active task semantic retention marker missing after pin publication');
    for (const root of expected.roots)
      SemanticGarbageCollector.prototype.retain.call(this.collector, { kind: 'active-task', reference: expected.reference, root });
    this.assertPins(expected);
    ensureDirectory(dirname(path));
    atomicWriteOnce(path, Buffer.from(encodeCanonical(expected)).toString());
    sync(dirname(path));
    if (!same(readMarker(path), expected)) throw new Error('active task semantic retention marker conflict');
  }
  assert(program: ResumableProgram, executionId: string): void {
    const expected = this.expected(program, executionId), actual = readMarker(markerPath(this.collectorDirectory, executionId));
    if (!actual || !same(actual, expected)) throw new Error('active task semantic retention marker missing or identity changed');
    this.assertPins(expected);
  }
}
