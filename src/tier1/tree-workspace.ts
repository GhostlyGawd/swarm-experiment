import { createPrivateKey, createPublicKey, sign, verify, type KeyObject } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { CapabilityRegistry } from '../tier2/ocap.ts';
import { decodeCanonical, encodeCanonical, exactObject, identifier, decimal, type EncodingLimits } from '../fabric/encoding.ts';
import { domainDigest, validateDigest, type Digest } from '../fabric/identity.ts';
import { JournalLock } from '../fabric/journal-lock.ts';
import { DurableReplica, decodeMutation, enrollment, type MembershipV1, type MutationEnvelopeV1, type MutationPayloadV1 } from '../fabric/replication.ts';
import { atomicWrite } from './persistence.ts';
import { linkGroups, type Term } from './ast.ts';
import type { NodeRef } from './ids.ts';
import { DurableGraphStore } from './durable-store.ts';
import { SemanticGarbageCollector, type SemanticGcOptions, type SemanticRetention } from './semantic-gc.ts';
import { allocateFractionalPosition } from './fractional-position.ts';
import { compactOccurrenceProjection, lexical, occurrenceIdForInsert, orderChildren, projectOccurrences, TREE_SEMANTICS, validateOccurrenceNodes, type OccurrenceNode, type OccurrenceProjection, type ReindexEntry } from './occurrence-tree.ts';
import { materializeOccurrences, type TreeMaterialization } from './tree-materialization.ts';

interface TreeFenceBody {
  format: 'aether.tree-fence/1'; repositoryId: string; membershipEpoch: string; replicaId: string;
  configuration: Digest; previousCheckpoint: Digest | null; observedFrames: Digest[];
}
export interface TreeFence extends TreeFenceBody { signature: string }
interface CheckpointProposal {
  format: 'aether.tree-checkpoint-proposal/1'; semantics: typeof TREE_SEMANTICS; configuration: Digest;
  membership: MembershipV1; nextMembership: MembershipV1; previousCheckpoint: Digest | null;
  fences: TreeFence[]; frames: string[]; before: OccurrenceNode[]; after: OccurrenceNode[];
  collected: Digest[]; reindex: ReindexEntry[]; lamportFloor: string; archive: string; archiveDigest: Digest;
}
export interface TreeCheckpoint { proposal: CheckpointProposal; digest: Digest }
export interface TreeCheckpointAck { format: 'aether.tree-checkpoint-ack/1'; checkpointDigest: Digest; replicaId: string; signature: string }
export interface TreeCheckpointCertificate { format: 'aether.tree-checkpoint-certificate/1'; checkpoint: TreeCheckpoint; acknowledgments: TreeCheckpointAck[] }
interface WorkspaceState {
  format: 'aether.tree-workspace/1'; configuration: Digest; membership: MembershipV1; lamportFloor: string;
  base: OccurrenceNode[]; history: Digest[]; fence: TreeFence | null; acknowledged: Digest | null;
  retiredLeases: string[];
}
export interface TreePlacement { parent: string | null; field: string; left?: string | null; right?: string | null }
export interface TreeMutation { occurrenceId: Digest; frame: Uint8Array }
export interface TreeWorkspaceOptions {
  directory: string; membership: MembershipV1; replicaId: string; privateKey?: KeyObject | string;
  store: DurableGraphStore; registry: CapabilityRegistry;
  /** Optional exact-epoch retention authority. Each epoch needs a separate
   * collector policy; old epoch pins remain monotone after checkpointing. */
  semanticRetention?: (membershipEpoch: string) => SemanticGcOptions;
  maxOccurrences?: number; maxOperations?: number; maxCheckpointBytes?: number;
  fault?: (point: 'after-fence' | 'checkpoint-prepared' | 'checkpoint-committed' | 'checkpoint-collected') => void;
}
interface ReplicationRetentionMarker {
  format: 'aether.tree-semantic-retention/1'; repositoryId: string; membershipEpoch: string;
  configuration: Digest; workspaceDirectory: string; storeDirectory: string;
  collectorDirectory: string; collectorConfiguration: Digest; reference: string; id: Digest;
}
function clone<T>(value: T, limits: Partial<EncodingLimits> = {}): T { return decodeCanonical(encodeCanonical(value, limits), limits) as T; }
function durableDirectory(path: string): void {
  if (existsSync(path)) { if (!statSync(path).isDirectory()) throw new Error('workspace path is not a directory'); return; }
  const parent = dirname(path); if (parent !== path) durableDirectory(parent);
  try { mkdirSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  for (const directory of [path, parent]) { const fd = openSync(directory, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } }
}
const frameDigest = (bytes: Uint8Array) => domainDigest('aether.tree-frame/1', Buffer.from(bytes).toString('base64'), { maxFrameBytes: 16 * 1024 * 1024, maxDecompressedBytes: 16 * 1024 * 1024 });
const withoutSignature = <T extends { signature: string }>(value: T): Omit<T, 'signature'> => { const { signature: _signature, ...body } = value; return body; };

/** Authenticated candidate workspace. Normal edits use F05 union semantics;
 * certified epoch checkpoints fence every enrolled writer before collecting
 * live tombstones. Production roots are never committed by this class. */
export class DurableTreeWorkspace {
  readonly replicaId: string;
  private readonly options: TreeWorkspaceOptions;
  private readonly initialMembership: MembershipV1;
  private readonly configuration: Digest;
  private readonly registry: CapabilityRegistry;
  private readonly key?: KeyObject;
  private readonly lock: JournalLock;
  private readonly file: string;
  private readonly maxOccurrences: number;
  private readonly limits: Partial<EncodingLimits>;
  private cached: { epoch: string; replica: DurableReplica } | null = null;
  private readonly collectors = new Map<string, { collector: SemanticGarbageCollector; marker: ReplicationRetentionMarker }>();

  constructor(options: TreeWorkspaceOptions) {
    this.options = { ...options }; identifier(options.replicaId); this.replicaId = options.replicaId;
    this.initialMembership = clone(options.membership);
    this.registry = new CapabilityRegistry(); for (const name of options.registry.names) this.registry.define(clone(options.registry.get(name)!));
    this.maxOccurrences = options.maxOccurrences ?? 2048;
    if (!Number.isSafeInteger(this.maxOccurrences) || this.maxOccurrences < 1 || this.maxOccurrences > 4096) throw new RangeError('occurrence workspace capacity');
    const bytes = options.maxCheckpointBytes ?? 64 * 1024 * 1024;
    if (!Number.isSafeInteger(bytes) || bytes < 1024 || bytes > 128 * 1024 * 1024) throw new RangeError('checkpoint byte capacity');
    this.limits = { maxFrameBytes: bytes, maxDecompressedBytes: bytes, maxObjects: 1000000 };
    this.configuration = domainDigest('aether.tree-workspace-config/1', { semantics: TREE_SEMANTICS, membership: this.initialMembership, registry: [...this.registry.names].sort(lexical).map(name => this.registry.get(name)!), maxOccurrences: this.maxOccurrences });
    if (options.privateKey) {
      this.key = typeof options.privateKey === 'string' ? createPrivateKey(options.privateKey) : options.privateKey;
      if (enrollment(this.replicaId, this.key).publicKey !== this.initialMembership.replicas.find(member => member.replicaId === this.replicaId)?.publicKey) throw new Error('workspace signer does not match membership');
    }
    durableDirectory(options.directory); durableDirectory(join(options.directory, 'epochs')); durableDirectory(join(options.directory, 'checkpoints')); durableDirectory(join(options.directory, 'fences')); durableDirectory(join(options.directory, 'semantic-retention'));
    this.file = join(options.directory, 'workspace.json');
    this.lock = new JournalLock({ directory: join(options.directory, 'workspace-lock'), domain: 'aether.tree-workspace-lock', maxTickets: 100000 });
    this.lock.run(() => {
      if (!existsSync(this.file)) {
        if (readdirSync(join(options.directory, 'epochs')).length || readdirSync(join(options.directory, 'checkpoints')).length || readdirSync(join(options.directory, 'fences')).length || readdirSync(join(options.directory, 'semantic-retention')).length) throw new Error('missing initialized workspace metadata');
        const state: WorkspaceState = { format: 'aether.tree-workspace/1', configuration: this.configuration, membership: this.initialMembership, lamportFloor: '0', base: [], history: [], fence: null, acknowledged: null, retiredLeases: [] };
        this.save(state);
      }
      const state = this.read(); this.replica(state);
      // A prior process may have died after publishing an authenticated frame
      // but before its content lease was recorded. Rebuild the current epoch's
      // complete protection set before releasing any predecessor epoch lease.
      // Missing content is a recovery error, never a reason to drop a frame.
      this.options.store.retain(this.lease(state), this.contentRoots(state.base, this.replica(state).framesFor(), state.membership));
      this.assertSemanticHistory(state, true);
      for (const lease of state.retiredLeases) this.options.store.release(lease);
    }, 5000);
  }
  get membershipEpoch(): string { return this.read().membership.membershipEpoch; }
  get fenced(): boolean { return this.read().fence !== null; }
  inspect(): OccurrenceProjection {
    return this.lock.run(() => { const state = this.read(); return clone(this.projection(state), this.limits); }, 5000);
  }
  exportOperations(): Uint8Array[] { return this.lock.run(() => { const state = this.read(); return this.replica(state).framesFor(); }, 5000); }
  importContent(bytes: Uint8Array): readonly NodeRef[] { return this.lock.run(() => { const state = this.read(); return this.options.store.importArchive(bytes, { leaseId: this.lease(state) }); }, 5000); }
  exportContent(): Uint8Array { return this.lock.run(() => { const state = this.read(); return this.options.store.exportArchive(this.contentRoots(state.base, this.replica(state).framesFor(), state.membership)); }, 5000); }
  storeTerm(term: Term): NodeRef { return this.lock.run(() => { const state = this.read(); this.mutable(state); return this.options.store.intern(term, { leaseId: this.lease(state) }); }, 5000); }
  ingest(frame: Uint8Array): ReturnType<DurableReplica['ingest']> {
    return this.lock.run(() => {
      const state = this.read(), envelope = decodeMutation(frame, state.membership);
      const content = this.contentOf(envelope);
      // The replica journal may publish the frame before returning. Protect its
      // AST closure first so a crash at that boundary cannot leave a durable
      // operation whose content the store may collect.
      if (content) this.options.store.retain(this.lease(state), [content]);
      if (content) this.pinReplication(state, content);
      return this.replica(state).ingest(frame);
    }, 5000);
  }
  seed(term: Term): { rootOccurrence: Digest; frames: Uint8Array[] } {
    return this.lock.run(() => {
      const state = this.read(); this.mutable(state);
      if (this.projection(state).nodes.length) throw new Error('seed requires an empty occurrence workspace');
      const root = this.options.store.intern(term, { leaseId: this.lease(state) }), frames: Uint8Array[] = [];
      const add = (content: NodeRef, parent: string | null, field: string, depth: number): Digest => {
        if (depth > 64) throw new RangeError('seed AST depth limit');
        const inserted = this.insertIn(state, content, { parent, field }); frames.push(inserted.frame);
        for (const group of linkGroups(this.options.store.get(content))) for (const child of group.links) add(child, inserted.occurrenceId, group.field, depth + 1);
        return inserted.occurrenceId;
      };
      return { rootOccurrence: add(root, null, 'root', 0), frames };
    }, 5000);
  }
  insert(content: NodeRef, placement: TreePlacement): TreeMutation { return this.lock.run(() => { const state = this.read(); this.mutable(state); return this.insertIn(state, content, placement); }, 5000); }
  move(occurrenceId: Digest, placement: TreePlacement): Uint8Array {
    return this.lock.run(() => {
      const state = this.read(); this.mutable(state); const projection = this.projection(state);
      if (!projection.nodes.some(node => node.occurrenceId === occurrenceId)) throw new Error('missing occurrence');
      const bounds = this.bounds(projection, placement, occurrenceId);
      return this.replica(state).authorMutation(identity => ({ occurrenceId, operation: 'move', payload: { format: 'aether.tree-move/1', parentOccurrence: placement.parent, field: placement.field, positionId: allocateFractionalPosition(bounds.left, bounds.right, identity.operationId) } }));
    }, 5000);
  }
  replace(occurrenceId: Digest, content: NodeRef): Uint8Array {
    return this.lock.run(() => {
      const state = this.read(); this.mutable(state);
      if (!this.projection(state).nodes.some(node => node.occurrenceId === occurrenceId)) throw new Error('missing occurrence');
      this.options.store.retain(this.lease(state), [content]);
      this.pinReplication(state, content);
      return this.replica(state).author(occurrenceId, 'replace', { format: 'aether.tree-replace/1', content });
    }, 5000);
  }
  delete(occurrenceId: Digest): Uint8Array {
    return this.lock.run(() => {
      const state = this.read(); this.mutable(state);
      if (!this.projection(state).nodes.some(node => node.occurrenceId === occurrenceId)) throw new Error('missing occurrence');
      return this.replica(state).authorMutation(identity => ({ occurrenceId, operation: 'delete', payload: { format: 'aether.tree-delete/1', tombstoneId: domainDigest('aether.tree-tombstone/1', identity.operationId) } }));
    }, 5000);
  }
  materialize(options: { leaseId: string }): TreeMaterialization { return this.lock.run(() => { const state = this.read(); return materializeOccurrences(this.projection(state), this.options.store, this.registry, options.leaseId); }, 5000); }
  /** Verify the complete signed epoch history and physical GC leases before
   * sweeping. This never interprets a local ACK as global causal stability. */
  collectGarbage(): ReturnType<DurableGraphStore['collectGarbage']> {
    return this.lock.run(() => {
      const state = this.read();
      this.assertSemanticHistory(state, false);
      return this.options.semanticRetention ? this.retention(state.membership.membershipEpoch).collector.collect() : this.options.store.collectGarbage();
    }, 5000);
  }

  /** Writer fencing is durable before the signature is released. Fences bind
   * inventories, not competing proposed roots. Ordinary old-epoch deliveries
   * may still arrive; the unanimous fence union fixes the exact checkpoint cut. */
  fence(): TreeFence {
    return this.lock.run(() => {
      const state = this.read(); if (state.fence) return clone(state.fence);
      if (!this.key) throw new Error('read-only workspace cannot fence');
      const body: TreeFenceBody = { format: 'aether.tree-fence/1', repositoryId: state.membership.repositoryId, membershipEpoch: state.membership.membershipEpoch, replicaId: this.replicaId, configuration: this.configuration, previousCheckpoint: state.history.at(-1) ?? null, observedFrames: this.replica(state).framesFor().map(frameDigest).sort(lexical) };
      state.fence = { ...body, signature: this.sign('aether.tree-fence-signature/1', body) };
      this.writeImmutable(this.fencePath(state), state.fence);
      this.save(state); this.options.fault?.('after-fence'); return clone(state.fence);
    }, 5000);
  }
  proposeCheckpoint(fences: readonly TreeFence[]): TreeCheckpoint {
    fences = clone(fences, this.limits);
    return this.lock.run(() => {
      const state = this.read(); if (!state.fence) throw new Error('fence local writer before checkpoint proposal');
      const ordered = this.validateFences(state, fences);
      const wanted = new Set(ordered.flatMap(fence => fence.observedFrames));
      const available = new Map(this.replica(state).framesFor().map(bytes => [frameDigest(bytes), bytes]));
      this.assertNoExtraFrames(state, wanted);
      const frames = [...wanted].sort(lexical).map(digest => { const frame = available.get(digest); if (!frame) throw new Error(`checkpoint requires missing operation ${digest}`); return frame; });
      const rows = this.replica(state).classifyFrames(frames);
      if (rows.some(row => row.disposition === 'pending')) throw new Error('causal predecessors remain unknown');
      const projection = projectOccurrences(rows, state.base, this.maxOccurrences);
      if (projection.nodes.length > this.maxOccurrences) throw new RangeError('checkpoint occurrence capacity');
      const compacted = compactOccurrenceProjection(projection);
      const archiveBytes = this.options.store.exportArchive(this.contentRoots(state.base, frames, state.membership));
      const archive = Buffer.from(archiveBytes).toString('base64');
      let floor = BigInt(state.lamportFloor);
      for (const row of rows) if (BigInt(row.envelope.lamport) > floor) floor = BigInt(row.envelope.lamport);
      const proposal: CheckpointProposal = { format: 'aether.tree-checkpoint-proposal/1', semantics: TREE_SEMANTICS, configuration: this.configuration, membership: state.membership, nextMembership: { ...state.membership, membershipEpoch: String(BigInt(state.membership.membershipEpoch) + 1n) }, previousCheckpoint: state.history.at(-1) ?? null, fences: ordered, frames: frames.map(frame => Buffer.from(frame).toString('base64')), before: clone(state.base), after: compacted.nodes, collected: compacted.collected, reindex: compacted.reindex, lamportFloor: String(floor), archive, archiveDigest: domainDigest('aether.tree-object-archive/1', archive, this.limits) };
      const checkpoint = { proposal, digest: domainDigest('aether.tree-checkpoint/1', proposal, this.limits) };
      this.validateCheckpoint(state, checkpoint); return clone(checkpoint, this.limits);
    }, 5000);
  }
  acknowledgeCheckpoint(checkpoint: TreeCheckpoint): TreeCheckpointAck {
    return this.lock.run(() => {
      const state = this.read(); if (!state.fence || !this.key) throw new Error('checkpoint acknowledgment requires a fenced signer');
      this.validateCheckpoint(state, checkpoint);
      this.assertNoExtraFrames(state, new Set(checkpoint.proposal.fences.flatMap(fence => fence.observedFrames)));
      if (state.acknowledged && state.acknowledged !== checkpoint.digest) throw new Error('checkpoint acknowledgment identity conflict');
      state.acknowledged = checkpoint.digest; this.save(state);
      const body = { format: 'aether.tree-checkpoint-ack/1' as const, checkpointDigest: checkpoint.digest, replicaId: this.replicaId };
      return { ...body, signature: this.sign('aether.tree-checkpoint-ack-signature/1', body) };
    }, 5000);
  }
  installCheckpoint(certificate: TreeCheckpointCertificate): { collected: readonly Digest[]; membershipEpoch: string } {
    return this.lock.run(() => {
      certificate = clone(certificate, this.limits);
      certificate.acknowledgments.sort((a, b) => lexical(a.replicaId, b.replicaId));
      const state = this.read();
      if (state.history.at(-1) === certificate.checkpoint.digest) {
        if (!Buffer.from(this.readFile(this.checkpointPath(certificate.checkpoint.digest))).equals(Buffer.from(encodeCanonical(certificate, this.limits)))) throw new Error('installed checkpoint retry differs from its certificate');
        for (const lease of state.retiredLeases) this.options.store.release(lease);
        return { collected: certificate.checkpoint.proposal.collected, membershipEpoch: state.membership.membershipEpoch };
      }
      if (!state.fence || state.acknowledged !== certificate.checkpoint.digest) throw new Error('local checkpoint acknowledgment missing');
      this.validateCertificate(state, certificate);
      const checkpoint = certificate.checkpoint;
      this.writeImmutable(this.checkpointPath(checkpoint.digest), certificate);
      const stageLease = this.stagingLease(checkpoint.digest);
      const next: WorkspaceState = { ...state, membership: checkpoint.proposal.nextMembership, base: checkpoint.proposal.after, lamportFloor: checkpoint.proposal.lamportFloor, history: [...state.history, checkpoint.digest], fence: null, acknowledged: null, retiredLeases: [...state.retiredLeases, this.lease(state), stageLease] };
      const imported = this.options.store.importArchive(Buffer.from(checkpoint.proposal.archive, 'base64'), { leaseId: stageLease });
      void imported;
      this.options.store.retain(this.lease(next), [...new Set(next.base.map(node => node.content))]);
      this.assertSemanticEpoch(next.membership.membershipEpoch, [...new Set(next.base.map(node => node.content))], true);
      // The new epoch/profile exists before the single authoritative pointer moves.
      this.replica(next); this.options.fault?.('checkpoint-prepared');
      this.save(next); this.options.fault?.('checkpoint-committed');
      this.options.store.release(this.lease(state)); this.options.store.release(stageLease); this.options.fault?.('checkpoint-collected');
      return { collected: checkpoint.proposal.collected, membershipEpoch: next.membership.membershipEpoch };
    }, 5000);
  }

  private insertIn(state: WorkspaceState, content: NodeRef, placement: TreePlacement): TreeMutation {
    const projection = this.projection(state);
    if (projection.nodes.length >= this.maxOccurrences) throw new RangeError('occurrence workspace capacity reached');
    const bounds = this.bounds(projection, placement);
    this.options.store.retain(this.lease(state), [content]);
    this.pinReplication(state, content);
    let occurrenceId = '';
    const frame = this.replica(state).authorMutation(identity => {
      occurrenceId = occurrenceIdForInsert(identity.operationId);
      return { occurrenceId, operation: 'insert', payload: { format: 'aether.tree-insert/1', parentOccurrence: placement.parent, field: placement.field, positionId: allocateFractionalPosition(bounds.left, bounds.right, identity.operationId), content } };
    });
    return { occurrenceId, frame };
  }
  private bounds(projection: OccurrenceProjection, placement: TreePlacement, excluded?: string): { left: string | null; right: string | null } {
    identifier(placement.field);
    if (placement.parent !== null && !projection.nodes.some(node => node.occurrenceId === placement.parent)) throw new Error('missing parent occurrence');
    const siblings = orderChildren(projection.nodes, placement.parent, placement.field).filter(node => node.occurrenceId !== excluded);
    let left = placement.left, right = placement.right;
    if (left === undefined && right === undefined) { left = siblings.at(-1)?.occurrenceId ?? null; right = null; }
    else if (left === undefined) { const index = siblings.findIndex(node => node.occurrenceId === right); if (right !== null && index < 0) throw new Error('right neighbor is outside parent/field'); left = right === null ? siblings.at(-1)?.occurrenceId ?? null : siblings[index - 1]?.occurrenceId ?? null; }
    else if (right === undefined) { const index = siblings.findIndex(node => node.occurrenceId === left); if (left !== null && index < 0) throw new Error('left neighbor is outside parent/field'); right = left === null ? siblings[0]?.occurrenceId ?? null : siblings[index + 1]?.occurrenceId ?? null; }
    const locate = (id: string | null | undefined) => { if (id === null) return null; const node = siblings.find(node => node.occurrenceId === id); if (!node) throw new Error('fractional neighbor is outside parent/field'); return node.positionId; };
    return { left: locate(left), right: locate(right) };
  }
  private projection(state: WorkspaceState): OccurrenceProjection {
    const projection = projectOccurrences(this.replica(state).operations(), state.base, this.maxOccurrences);
    if (projection.nodes.length > this.maxOccurrences) throw new RangeError('occurrence workspace capacity exceeded by received operations');
    return projection;
  }
  private mutable(state: WorkspaceState): void { if (state.fence) throw new Error('writer fenced pending unanimous checkpoint; timeout cannot release it'); }
  private retentionPath(epoch: string): string {
    identifier(epoch);
    const digest = domainDigest('aether.tree-retention-epoch/1', { configuration: this.configuration, epoch });
    return join(this.options.directory, 'semantic-retention', `${digest.split(':').at(-1)}.json`);
  }
  private retention(epoch: string): { collector: SemanticGarbageCollector; marker: ReplicationRetentionMarker } {
    const cached = this.collectors.get(epoch); if (cached) return cached;
    const factory = this.options.semanticRetention;
    if (!factory) throw new Error('unstable-replication semantic retention authority required');
    const options = factory(epoch);
    if (!options || options.store !== this.options.store || options.repositoryId !== this.initialMembership.repositoryId || options.policy?.epoch !== epoch)
      throw new Error('unstable-replication authority store/repository/epoch mismatch');
    const collector = new SemanticGarbageCollector(options);
    const collectorDirectory = realpathSync(options.directory), storeDirectory = realpathSync(this.options.store.directory);
    const profile = decodeCanonical(readFileSync(join(collectorDirectory, 'profile.json')));
    const collectorConfiguration = domainDigest('aether.semantic-gc-config/1', profile);
    const reference = `tree-replication:${domainDigest('aether.tree-replication-reference/1', {
      configuration: this.configuration, repositoryId: this.initialMembership.repositoryId,
      membershipEpoch: epoch, replicaId: this.replicaId, workspaceDirectory: realpathSync(this.options.directory),
    }).split(':').at(-1)}`;
    const body = { format: 'aether.tree-semantic-retention/1' as const, repositoryId: this.initialMembership.repositoryId,
      membershipEpoch: epoch, configuration: this.configuration, workspaceDirectory: realpathSync(this.options.directory),
      storeDirectory, collectorDirectory, collectorConfiguration, reference };
    const marker = { ...body, id: domainDigest('aether.tree-semantic-retention/1', body) };
    const result = { collector, marker }; this.collectors.set(epoch, result); return result;
  }
  private assertRetentionPins(collector: SemanticGarbageCollector, marker: ReplicationRetentionMarker, roots: readonly NodeRef[]): void {
    const records = SemanticGarbageCollector.prototype.retentions.call(collector);
    const leases = DurableGraphStore.prototype.roots.call(this.options.store).leases;
    const present = new Set(records.filter(item => item.kind === 'unstable-replication' && item.reference === marker.reference).map(item => item.root));
    for (const root of roots) {
      const record: SemanticRetention = { kind: 'unstable-replication', reference: marker.reference, root };
      const expectedLease = `semantic-gc-retention:${domainDigest('aether.semantic-retention/1', { configuration: marker.collectorConfiguration, ...record })}`;
      const lease = leases[expectedLease];
      if (!present.has(root) || !Array.isArray(lease) || lease.length !== 1 || lease[0] !== root)
        throw new Error('unstable-replication semantic retention record or physical lease missing');
      DurableGraphStore.prototype.hydrate.call(this.options.store, root);
    }
  }
  /** The collector constructor normally reconstructs lost leases from its
   * journal. A workspace with an established marker must detect that loss
   * before constructing the collector, otherwise reopen would self-heal a
   * broken publication invariant without surfacing it. */
  private preflightRetentionPins(epoch: string, roots: readonly NodeRef[]): void {
    const marker = exactObject(decodeCanonical(this.readFile(this.retentionPath(epoch)), this.limits),
      ['format', 'repositoryId', 'membershipEpoch', 'configuration', 'workspaceDirectory', 'storeDirectory', 'collectorDirectory', 'collectorConfiguration', 'reference', 'id']) as unknown as ReplicationRetentionMarker;
    const { id, ...body } = marker;
    if (marker.format !== 'aether.tree-semantic-retention/1' || marker.membershipEpoch !== epoch ||
      id !== domainDigest('aether.tree-semantic-retention/1', body))
      throw new Error('unstable-replication semantic retention marker corrupt');
    const leases = DurableGraphStore.prototype.roots.call(this.options.store).leases;
    for (const root of roots) {
      const record: SemanticRetention = { kind: 'unstable-replication', reference: marker.reference, root };
      const retentionId = domainDigest('aether.semantic-retention/1', { configuration: marker.collectorConfiguration, ...record });
      const path = join(marker.collectorDirectory, 'retention', `${retentionId.split(':').at(-1)}.json`);
      if (!existsSync(path)) throw new Error('unstable-replication semantic retention record missing');
      const value = exactObject(decodeCanonical(this.readFile(path), this.limits), ['format', 'configuration', 'record', 'id']);
      if (value.format !== 'aether.semantic-retention/1' || value.configuration !== marker.collectorConfiguration || value.id !== retentionId ||
        domainDigest('aether.tree-retention-record/1', value.record) !== domainDigest('aether.tree-retention-record/1', record))
        throw new Error('unstable-replication semantic retention record changed');
      const lease = `semantic-gc-retention:${retentionId}`;
      if (!Array.isArray(leases[lease]) || leases[lease].length !== 1 || leases[lease][0] !== root)
        throw new Error('unstable-replication physical lease missing or changed');
    }
  }
  private assertSemanticEpoch(epoch: string, roots: readonly NodeRef[], allowCreate: boolean): void {
    const path = this.retentionPath(epoch);
    if (!this.options.semanticRetention) {
      if (existsSync(path)) throw new Error('unstable-replication semantic retention authority required');
      return;
    }
    if (existsSync(path)) this.preflightRetentionPins(epoch, roots);
    const { collector, marker } = this.retention(epoch);
    if (existsSync(path)) {
      const value = exactObject(decodeCanonical(this.readFile(path), this.limits), ['format', 'repositoryId', 'membershipEpoch', 'configuration', 'workspaceDirectory', 'storeDirectory', 'collectorDirectory', 'collectorConfiguration', 'reference', 'id']);
      if (domainDigest('aether.tree-semantic-retention-marker/1', value, this.limits) !== domainDigest('aether.tree-semantic-retention-marker/1', marker, this.limits))
        throw new Error('unstable-replication semantic retention marker changed');
    } else {
      if (!allowCreate) throw new Error('unstable-replication semantic retention marker missing');
      for (const root of roots) SemanticGarbageCollector.prototype.retain.call(collector, { kind: 'unstable-replication', reference: marker.reference, root });
      this.assertRetentionPins(collector, marker, roots);
      this.writeImmutable(path, marker);
    }
    this.assertRetentionPins(collector, marker, roots);
  }
  private assertSemanticHistory(state: WorkspaceState, allowCurrentCreate: boolean): void {
    const markers = readdirSync(join(this.options.directory, 'semantic-retention')).filter(name => !name.startsWith('.'));
    if (!this.options.semanticRetention) {
      if (markers.length) throw new Error('unstable-replication semantic retention authority required');
      return;
    }
    for (const digest of state.history) {
      const certificate = decodeCanonical(this.readFile(this.checkpointPath(digest)), this.limits) as unknown as TreeCheckpointCertificate;
      const proposal = certificate.checkpoint.proposal;
      const roots = this.contentRoots(proposal.before, proposal.frames.map(frame => Buffer.from(frame, 'base64')), proposal.membership);
      this.assertSemanticEpoch(proposal.membership.membershipEpoch, roots, false);
    }
    const roots = this.contentRoots(state.base, this.replica(state).framesFor(), state.membership);
    this.assertSemanticEpoch(state.membership.membershipEpoch, roots, allowCurrentCreate);
  }
  private pinReplication(state: WorkspaceState, root: NodeRef): void {
    if (!this.options.semanticRetention) {
      if (existsSync(this.retentionPath(state.membership.membershipEpoch))) throw new Error('unstable-replication semantic retention authority required');
      return;
    }
    this.assertSemanticEpoch(state.membership.membershipEpoch, this.contentRoots(state.base, this.replica(state).framesFor(), state.membership), false);
    const { collector, marker } = this.retention(state.membership.membershipEpoch);
    SemanticGarbageCollector.prototype.retain.call(collector, { kind: 'unstable-replication', reference: marker.reference, root });
    this.assertRetentionPins(collector, marker, [root]);
  }
  private lease(state: WorkspaceState): string { return domainDigest('aether.tree-live-lease/1', { configuration: this.configuration, replicaId: this.replicaId, epoch: state.membership.membershipEpoch }); }
  private stagingLease(checkpoint: Digest): string { return domainDigest('aether.tree-checkpoint-stage/1', { configuration: this.configuration, replicaId: this.replicaId, checkpoint }); }
  private replica(state: WorkspaceState): DurableReplica {
    if (this.cached?.epoch === state.membership.membershipEpoch) return this.cached.replica;
    const epoch = domainDigest('aether.tree-epoch-directory/1', { repositoryId: state.membership.repositoryId, epoch: state.membership.membershipEpoch }).split(':').at(-1)!;
    const directory = join(this.options.directory, 'epochs', epoch); durableDirectory(directory);
    const replica = new DurableReplica({ directory, membership: state.membership, replicaId: this.replicaId, privateKey: this.key, lamportFloor: state.lamportFloor, maxStoredOperations: this.options.maxOperations ?? 10000, maxAdmissionTickets: 100000 });
    this.cached = { epoch: state.membership.membershipEpoch, replica }; return replica;
  }
  private contentOf(envelope: MutationEnvelopeV1): NodeRef | null { return envelope.payload.format === 'aether.tree-insert/1' || envelope.payload.format === 'aether.tree-replace/1' ? envelope.payload.content as NodeRef : null; }
  private contentRoots(base: readonly OccurrenceNode[], frames: readonly Uint8Array[], membership: MembershipV1): NodeRef[] {
    const roots = new Set<NodeRef>(base.map(node => node.content));
    for (const frame of frames) { const content = this.contentOf(decodeMutation(frame, membership)); if (content) roots.add(content); }
    return [...roots].sort(lexical);
  }
  private sign(domain: string, body: unknown): string { if (!this.key) throw new Error('read-only workspace'); return sign(null, encodeCanonical({ domain, body }, this.limits), this.key).toString('base64'); }
  private checkSignature(domain: string, body: unknown, signature: string, memberId: string, membership: MembershipV1): void {
    const member = membership.replicas.find(member => member.replicaId === memberId);
    if (!member || typeof signature !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(signature) || Buffer.from(signature, 'base64').toString('base64') !== signature) throw new Error('invalid checkpoint signer/signature');
    const publicKey = createPublicKey({ key: Buffer.from(member.publicKey, 'base64'), format: 'der', type: 'spki' });
    if (!verify(null, encodeCanonical({ domain, body }, this.limits), publicKey, Buffer.from(signature, 'base64'))) throw new Error('invalid checkpoint signature');
  }
  private assertNoExtraFrames(state: WorkspaceState, cut: ReadonlySet<Digest>): void {
    const extra = this.replica(state).framesFor().map(frameDigest).filter(digest => !cut.has(digest)).sort(lexical);
    if (extra.length) throw new Error(`known old-epoch frames outside signed fence union: ${extra.join(', ')}`);
  }
  private validateFences(state: WorkspaceState, fences: readonly TreeFence[]): TreeFence[] {
    if (fences.length !== state.membership.replicas.length || new Set(fences.map(fence => fence.replicaId)).size !== fences.length) throw new Error('every active replica must fence; unavailable replicas cannot be retired by timeout');
    const ordered = [...fences].sort((a, b) => lexical(a.replicaId, b.replicaId));
    for (const fence of ordered) {
      exactObject(fence, ['format', 'repositoryId', 'membershipEpoch', 'replicaId', 'configuration', 'previousCheckpoint', 'observedFrames', 'signature']);
      if (fence.format !== 'aether.tree-fence/1' || fence.repositoryId !== state.membership.repositoryId || fence.membershipEpoch !== state.membership.membershipEpoch || fence.configuration !== this.configuration || fence.previousCheckpoint !== (state.history.at(-1) ?? null) || !Array.isArray(fence.observedFrames)) throw new Error('stale or mismatched checkpoint fence');
      let previous = ''; for (const digest of fence.observedFrames) { validateDigest(digest, 'aether.tree-frame/1'); if (lexical(previous, digest) >= 0) throw new Error('duplicate or unordered fence inventory'); previous = digest; }
      this.checkSignature('aether.tree-fence-signature/1', withoutSignature(fence), fence.signature, fence.replicaId, state.membership);
    }
    if (state.fence && encodeCanonical(ordered.find(fence => fence.replicaId === this.replicaId), this.limits).toString() !== encodeCanonical(state.fence, this.limits).toString()) throw new Error('local fence was substituted');
    return ordered;
  }
  private validateCheckpoint(state: WorkspaceState, checkpoint: TreeCheckpoint): void {
    encodeCanonical(checkpoint, this.limits); exactObject(checkpoint, ['proposal', 'digest']);
    const proposal = checkpoint.proposal;
    exactObject(proposal, ['format', 'semantics', 'configuration', 'membership', 'nextMembership', 'previousCheckpoint', 'fences', 'frames', 'before', 'after', 'collected', 'reindex', 'lamportFloor', 'archive', 'archiveDigest']);
    if (proposal.format !== 'aether.tree-checkpoint-proposal/1' || proposal.semantics !== TREE_SEMANTICS || proposal.configuration !== this.configuration || checkpoint.digest !== domainDigest('aether.tree-checkpoint/1', proposal, this.limits) || proposal.previousCheckpoint !== (state.history.at(-1) ?? null)) throw new Error('checkpoint identity/context mismatch');
    if (domainDigest('aether.tree-membership/1', proposal.membership) !== domainDigest('aether.tree-membership/1', state.membership) || domainDigest('aether.tree-membership/1', proposal.nextMembership) !== domainDigest('aether.tree-membership/1', { ...state.membership, membershipEpoch: String(BigInt(state.membership.membershipEpoch) + 1n) })) throw new Error('checkpoint changed roster or skipped an epoch');
    if (domainDigest('aether.tree-base/1', proposal.before) !== domainDigest('aether.tree-base/1', state.base)) throw new Error('checkpoint prior state mismatch');
    const fences = this.validateFences(state, proposal.fences), expectedFrames = [...new Set(fences.flatMap(fence => fence.observedFrames))].sort(lexical);
    if (domainDigest('aether.tree-fences/1', fences, this.limits) !== domainDigest('aether.tree-fences/1', proposal.fences, this.limits)) throw new Error('noncanonical checkpoint fence order');
    if (!Array.isArray(proposal.frames)) throw new Error('invalid checkpoint operation cut');
    const bytes = proposal.frames.map(frame => { if (typeof frame !== 'string' || Buffer.from(frame, 'base64').toString('base64') !== frame) throw new Error('invalid checkpoint frame encoding'); return Buffer.from(frame, 'base64'); });
    if (JSON.stringify(bytes.map(frameDigest)) !== JSON.stringify(expectedFrames)) throw new Error('checkpoint omitted or added fenced operations');
    const rows = this.replica(state).classifyFrames(bytes);
    if (rows.some(row => row.disposition === 'pending')) throw new Error('checkpoint has missing causal predecessors');
    const projection = projectOccurrences(rows, state.base, this.maxOccurrences);
    if (projection.nodes.length > this.maxOccurrences) throw new RangeError('checkpoint occurrence capacity');
    const compacted = compactOccurrenceProjection(projection);
    if (domainDigest('aether.tree-compaction/1', compacted) !== domainDigest('aether.tree-compaction/1', { nodes: proposal.after, collected: proposal.collected, reindex: proposal.reindex })) throw new Error('checkpoint projection/reindex proof mismatch');
    let floor = BigInt(state.lamportFloor); for (const row of rows) if (BigInt(row.envelope.lamport) > floor) floor = BigInt(row.envelope.lamport);
    if (proposal.lamportFloor !== String(floor)) throw new Error('checkpoint Lamport floor mismatch');
    if (typeof proposal.archive !== 'string' || Buffer.from(proposal.archive, 'base64').toString('base64') !== proposal.archive || domainDigest('aether.tree-object-archive/1', proposal.archive, this.limits) !== proposal.archiveDigest) throw new Error('checkpoint archive digest mismatch');
    const roots = this.options.store.validateArchive(Buffer.from(proposal.archive, 'base64'), { canonical: true });
    if (JSON.stringify([...roots].sort(lexical)) !== JSON.stringify(this.contentRoots(state.base, bytes, state.membership))) throw new Error('checkpoint archive omits or adds required cut/audit prototypes');
  }
  private validateCertificate(state: WorkspaceState, certificate: TreeCheckpointCertificate): void {
    exactObject(certificate, ['format', 'checkpoint', 'acknowledgments']); if (certificate.format !== 'aether.tree-checkpoint-certificate/1') throw new Error('unsupported checkpoint certificate');
    this.validateCheckpoint(state, certificate.checkpoint);
    if (!Array.isArray(certificate.acknowledgments) || certificate.acknowledgments.length !== state.membership.replicas.length || new Set(certificate.acknowledgments.map(ack => ack.replicaId)).size !== state.membership.replicas.length) throw new Error('checkpoint is not acknowledged by every active replica');
    for (const ack of certificate.acknowledgments) {
      exactObject(ack, ['format', 'checkpointDigest', 'replicaId', 'signature']);
      if (ack.format !== 'aether.tree-checkpoint-ack/1' || ack.checkpointDigest !== certificate.checkpoint.digest) throw new Error('stale checkpoint acknowledgment');
      this.checkSignature('aether.tree-checkpoint-ack-signature/1', withoutSignature(ack), ack.signature, ack.replicaId, state.membership);
    }
  }
  private fencePath(state: WorkspaceState): string { return join(this.options.directory, 'fences', `${state.membership.membershipEpoch}.json`); }
  private checkpointPath(digest: Digest): string { validateDigest(digest, 'aether.tree-checkpoint/1'); return join(this.options.directory, 'checkpoints', `${digest.split(':').at(-1)}.json`); }
  private writeImmutable(path: string, value: unknown): void {
    const bytes = encodeCanonical(value, this.limits);
    if (existsSync(path)) { if (!Buffer.from(this.readFile(path)).equals(Buffer.from(bytes))) throw new Error('checkpoint artifact identity reused'); return; }
    this.write(path, bytes);
  }
  private readFile(path: string): Uint8Array { if (statSync(path).size > this.limits.maxFrameBytes!) throw new RangeError('workspace record size limit'); return readFileSync(path); }
  private write(path: string, bytes: Uint8Array): void { atomicWrite(path, Buffer.from(bytes).toString('utf8')); const fd = openSync(dirname(path), 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } }
  private save(state: WorkspaceState): void { const checksum = domainDigest('aether.tree-workspace-state/1', state, this.limits); this.write(this.file, encodeCanonical({ format: 'aether.tree-workspace-record/1', checksum, state }, this.limits)); }
  private read(): WorkspaceState {
    const wrapper = exactObject(decodeCanonical(this.readFile(this.file), this.limits), ['format', 'checksum', 'state']);
    const state = exactObject(wrapper.state, ['format', 'configuration', 'membership', 'lamportFloor', 'base', 'history', 'fence', 'acknowledged', 'retiredLeases']) as unknown as WorkspaceState;
    if (wrapper.format !== 'aether.tree-workspace-record/1' || wrapper.checksum !== domainDigest('aether.tree-workspace-state/1', state, this.limits) || state.format !== 'aether.tree-workspace/1' || state.configuration !== this.configuration) throw new Error('corrupt workspace state');
    decimal(state.lamportFloor); validateOccurrenceNodes(state.base);
    if (!Array.isArray(state.history) || !Array.isArray(state.retiredLeases)) throw new Error('invalid workspace epoch history');
    // Replay the certificate chain from trusted genesis; a checksum alone cannot
    // install invented compacted state or an unacknowledged epoch.
    let expected: WorkspaceState = { ...state, membership: this.initialMembership, lamportFloor: '0', base: [], history: [], fence: null, acknowledged: null, retiredLeases: [] };
    for (const digest of state.history) {
      const certificate = decodeCanonical(this.readFile(this.checkpointPath(digest)), this.limits) as unknown as TreeCheckpointCertificate;
      this.validateCertificate(expected, certificate);
      if (certificate.checkpoint.digest !== digest) throw new Error('checkpoint history address mismatch');
      expected = { ...expected, membership: certificate.checkpoint.proposal.nextMembership, base: certificate.checkpoint.proposal.after, lamportFloor: certificate.checkpoint.proposal.lamportFloor, history: [...expected.history, digest], retiredLeases: [...expected.retiredLeases, this.lease(expected), this.stagingLease(digest)] };
    }
    if (domainDigest('aether.tree-installed-epoch/1', [state.membership, state.base, state.lamportFloor, state.retiredLeases], this.limits) !== domainDigest('aether.tree-installed-epoch/1', [expected.membership, expected.base, expected.lamportFloor, expected.retiredLeases], this.limits)) throw new Error('workspace epoch does not match certified history');
    const fencePath = this.fencePath(state);
    if (existsSync(fencePath)) {
      const retained = decodeCanonical(this.readFile(fencePath), this.limits) as unknown as TreeFence;
      if (state.fence && domainDigest('aether.tree-fence-record/1', state.fence, this.limits) !== domainDigest('aether.tree-fence-record/1', retained, this.limits)) throw new Error('persisted fence receipt conflict');
      state.fence = retained;
    } else if (state.fence) throw new Error('persisted fence receipt missing');
    if (state.fence) {
      const fence = state.fence;
      exactObject(fence, ['format', 'repositoryId', 'membershipEpoch', 'replicaId', 'configuration', 'previousCheckpoint', 'observedFrames', 'signature']);
      if (fence.format !== 'aether.tree-fence/1' || fence.repositoryId !== state.membership.repositoryId || !Array.isArray(fence.observedFrames)) throw new Error('invalid persisted fence');
      let previous = ''; for (const digest of fence.observedFrames) { validateDigest(digest, 'aether.tree-frame/1'); if (lexical(previous, digest) >= 0) throw new Error('invalid persisted fence inventory'); previous = digest; }
      if (fence.replicaId !== this.replicaId || fence.membershipEpoch !== state.membership.membershipEpoch || fence.previousCheckpoint !== (state.history.at(-1) ?? null) || fence.configuration !== this.configuration) throw new Error('invalid persisted fence');
      this.checkSignature('aether.tree-fence-signature/1', withoutSignature(fence), fence.signature, this.replicaId, state.membership);
    }
    if (state.acknowledged !== null) { validateDigest(state.acknowledged, 'aether.tree-checkpoint/1'); if (!state.fence) throw new Error('unfenced checkpoint acknowledgment'); }
    return state;
  }
}
