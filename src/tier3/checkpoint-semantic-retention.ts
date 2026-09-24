/** Opt-in replay-root authority for direct resumable checkpoint journals.
 * Pins are monotone: this boundary does not infer replay completion or expiry.
 * External dependency declarations must remain replay pins. Current adapter
 * retirement fails closed on such non-module roots until manifest-associated
 * liveness analysis can evaluate their registrations.
 */
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DurableGraphStore } from '../tier1/durable-store.ts';
import type { NodeRef } from '../tier1/ids.ts';
import { SemanticGarbageCollector, type SemanticGcOptions, type SemanticRetention } from '../tier1/semantic-gc.ts';
import { atomicWriteOnce } from '../tier1/persistence.ts';
import { decodeCanonical, encodeCanonical, exactObject, identifier } from '../fabric/encoding.ts';
import { domainDigest, executionManifestDigest, validateExecutionManifest, type Digest } from '../fabric/identity.ts';
import type { ResumableProgram } from './resumable-program.ts';

const live = new WeakSet<CheckpointSemanticRetention>();
const format = 'aether.direct-checkpoint-semantic-retention/1' as const;
interface Marker {
  readonly format: typeof format;
  readonly executionId: string;
  readonly programDigest: Digest;
  readonly manifestDigest: Digest;
  readonly repositoryId: string;
  readonly storeDirectory: string;
  readonly collectorDirectory: string;
  readonly checkpointDirectory: string;
  readonly collectorConfiguration: Digest;
  readonly roots: readonly NodeRef[];
  readonly reference: string;
  readonly id: Digest;
}
const same = (left: unknown, right: unknown): boolean => Buffer.from(encodeCanonical(left)).equals(Buffer.from(encodeCanonical(right)));
function sync(path: string): void { const fd = openSync(path, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } }
function markerPath(directory: string): string { return join(directory, 'semantic-retention-v1.json'); }
function readMarker(directory: string): Marker | null {
  const path = markerPath(directory);
  if (!existsSync(path)) return null;
  if (statSync(path).size > 1024 * 1024) throw new Error('checkpoint semantic retention marker size limit');
  const value = exactObject(decodeCanonical(readFileSync(path)), ['format', 'executionId', 'programDigest', 'manifestDigest', 'repositoryId', 'storeDirectory', 'collectorDirectory', 'checkpointDirectory', 'collectorConfiguration', 'roots', 'reference', 'id']) as unknown as Marker;
  const { id, ...body } = value;
  if (body.format !== format || id !== domainDigest(format, body)) throw new Error('checkpoint semantic retention marker corrupt');
  return value;
}

/** Constructs the collector using the exact graph store it validates. Callers
 * cannot replace that store between pinning and checkpoint publication. */
export class CheckpointSemanticRetention {
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
    this.digest = domainDigest('aether.direct-checkpoint-semantic-authority/1', {
      repositoryId: this.repositoryId, storeDirectory: this.storeDirectory,
      collectorDirectory: this.collectorDirectory, collectorConfiguration: this.collectorConfiguration,
    });
    live.add(this);
    Object.freeze(this);
  }
  static assertInstance(value: CheckpointSemanticRetention): void {
    if (!live.has(value)) throw new TypeError('untrusted direct checkpoint semantic retention authority');
  }
  static hasMarker(directory: string): boolean { return existsSync(markerPath(directory)); }
  private expected(directory: string, program: ResumableProgram, executionId: string): Marker {
    CheckpointSemanticRetention.assertInstance(this);
    identifier(executionId); validateExecutionManifest(program.manifest);
    const roots = [program.manifest.astRoot, ...program.manifest.dependencies.map(item => item.declaration)];
    if (roots.some(root => !root.startsWith('ast:b3:'))) throw new Error('checkpoint semantic retention requires AST dependency roots');
    const unique = [...new Set(roots)] as NodeRef[];
    const module = DurableGraphStore.prototype.hydrate.call(this.store, program.manifest.astRoot as NodeRef);
    if (module.kind !== 'Module') throw new Error('checkpoint semantic retention root is not a module');
    for (const item of program.manifest.dependencies) {
      const declaration = DurableGraphStore.prototype.hydrate.call(this.store, item.declaration as NodeRef);
      if (declaration.kind !== 'FunctionDecl' || declaration.symbol !== item.symbol) throw new Error('checkpoint semantic retention dependency declaration mismatch');
    }
    const checkpointDirectory = realpathSync(directory), manifestDigest = executionManifestDigest(program.manifest);
    if (manifestDigest !== program.manifestDigest) throw new Error('checkpoint semantic retention program/manifest mismatch');
    const reference = `direct-checkpoint:${domainDigest('aether.direct-checkpoint-semantic-reference/1', { checkpointDirectory, executionId, programDigest: program.digest, manifestDigest }).split(':').at(-1)}`;
    const body = { format, executionId, programDigest: program.digest, manifestDigest, repositoryId: this.repositoryId,
      storeDirectory: this.storeDirectory, collectorDirectory: this.collectorDirectory, checkpointDirectory,
      collectorConfiguration: this.collectorConfiguration, roots: unique, reference };
    return { ...body, id: domainDigest(format, body) };
  }
  private assertProfile(): void {
    const path = join(this.collectorDirectory, 'profile.json');
    if (!existsSync(path) || readFileSync(path, 'utf8') !== this.profileText)
      throw new Error('checkpoint semantic retention collector profile missing or changed');
  }
  private assertPins(marker: Marker): void {
    this.assertProfile();
    const records = SemanticGarbageCollector.prototype.retentions.call(this.collector);
    const leases = DurableGraphStore.prototype.roots.call(this.store).leases;
    for (const root of marker.roots) {
      const wanted: SemanticRetention = { kind: 'replay', reference: marker.reference, root };
      const lease = `semantic-gc-retention:${domainDigest('aether.semantic-retention/1', { configuration: this.collectorConfiguration, ...wanted })}`;
      if (!records.some(record => same(record, wanted)) || !Array.isArray(leases[lease]) || !same(leases[lease], [root]))
        throw new Error('checkpoint semantic retention replay pin missing or changed');
      DurableGraphStore.prototype.hydrate.call(this.store, root);
    }
  }
  /** Idempotent only before the first journal publication. A prior marker is
   * validated, never silently repaired, on reopen. */
  prepare(directory: string, program: ResumableProgram, executionId: string): void {
    const expected = this.expected(directory, program, executionId), prior = readMarker(directory);
    if (prior) { if (!same(prior, expected)) throw new Error('checkpoint semantic retention marker identity changed'); this.assertPins(expected); return; }
    this.assertProfile();
    for (const root of expected.roots)
      SemanticGarbageCollector.prototype.retain.call(this.collector, { kind: 'replay', reference: expected.reference, root });
    this.assertPins(expected);
    atomicWriteOnce(markerPath(directory), Buffer.from(encodeCanonical(expected)).toString());
    sync(dirname(markerPath(directory)));
    if (!same(readMarker(directory), expected)) throw new Error('checkpoint semantic retention marker conflict');
  }
  assert(directory: string, program: ResumableProgram, executionId: string): void {
    const expected = this.expected(directory, program, executionId), actual = readMarker(directory);
    if (!actual || !same(actual, expected)) throw new Error('checkpoint semantic retention marker missing or identity changed');
    this.assertPins(expected);
  }
}
