/** A witnessed, terminal ProcessHost checkpoint is the only authority in this
 * bounded profile for retiring its active-task semantic pins. Replay pins stay. */
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { decodeCanonical, encodeCanonical, exactObject, decimal, identifier } from '../fabric/encoding.ts';
import { readHostJournalHead, assertHostJournalWitness, type HostJournalWitness } from '../fabric/host-journal-witness.ts';
import { domainDigest, executionManifestDigest, validateDigest, type Digest } from '../fabric/identity.ts';
import type { NodeRef } from '../tier1/ids.ts';
import type { ResumableProgram } from '../tier3/resumable-program.ts';
import { readCheckpointEffectAudit, readProcessCheckpoint, processCheckpointReceiptDigest,
  validateProcessCheckpointBinding, type ProcessCheckpointLease,
  type ProcessCheckpointReceipt } from './process-checkpoint-contract.ts';

export const PROCESS_CHECKPOINT_ACTIVE_RELEASE_FORMAT = 'aether.process-checkpoint-active-release/2';
export interface ProcessCheckpointActiveReleaseProof {
  readonly format: typeof PROCESS_CHECKPOINT_ACTIVE_RELEASE_FORMAT;
  readonly authority: Digest;
  readonly hostConfiguration: Digest;
  readonly hostRevision: string;
  readonly manifest: Digest;
  readonly program: Digest;
  readonly binding: Digest;
  readonly operationId: string;
  readonly receipt: Digest;
  readonly effectAudit: Digest;
  readonly commitHead: Digest;
  readonly marker: Digest;
  readonly reference: string;
  readonly storeDirectory: string;
  readonly collectorDirectory: string;
  readonly roots: readonly NodeRef[];
  readonly id: Digest;
}
const live = new WeakSet<ProcessCheckpointActiveReleaseAuthority>();
const equal = (a: unknown, b: unknown): boolean => Buffer.from(encodeCanonical(a)).equals(Buffer.from(encodeCanonical(b)));

export class ProcessCheckpointActiveReleaseAuthority {
  readonly digest: Digest;
  readonly repositoryId: string;
  private readonly witness: HostJournalWitness;
  private readonly hostDirectory: string;
  private readonly hostConfiguration: Digest;
  private readonly program: ResumableProgram;
  constructor(options: { readonly witness: HostJournalWitness; readonly hostDirectory: string;
    readonly hostConfiguration: Digest; readonly repositoryId: string; readonly program: ResumableProgram }) {
    assertHostJournalWitness(options.witness);
    identifier(options.repositoryId);
    if (options.witness.repositoryId !== options.repositoryId) throw new TypeError('release witness repository mismatch');
    validateDigest(options.hostConfiguration);
    const { digest, ...body } = options.program;
    if (digest !== domainDigest('aether.resumable-program/1', body, { maxDepth: 128,
      maxObjects: 1_000_000, maxFrameBytes: 16 * 1024 * 1024, maxDecompressedBytes: 16 * 1024 * 1024 })
      || options.program.manifestDigest !== executionManifestDigest(options.program.manifest))
      throw new TypeError('release program identity mismatch');
    this.witness = options.witness;
    this.hostDirectory = realpathSync(options.hostDirectory);
    this.hostConfiguration = options.hostConfiguration;
    this.repositoryId = options.repositoryId;
    this.program = structuredClone(options.program);
    this.digest = domainDigest('aether.process-checkpoint-active-release-authority/2', {
      witness: options.witness.digest, hostDirectory: this.hostDirectory, hostConfiguration: this.hostConfiguration,
      repositoryId: this.repositoryId, program: options.program.digest, manifest: options.program.manifestDigest });
    live.add(this);
    Object.freeze(this);
  }
  static assertInstance(value: ProcessCheckpointActiveReleaseAuthority): void {
    if (!value || !live.has(value)) throw new TypeError('untrusted checkpoint active release authority');
  }
  private current(bindingId: Digest): Omit<ProcessCheckpointActiveReleaseProof, 'id'> {
    ProcessCheckpointActiveReleaseAuthority.assertInstance(this);
    validateDigest(bindingId, 'aether.process-checkpoint-binding/1');
    const witnessed = readHostJournalHead(this.witness);
    if (!witnessed.journal) throw new Error('release witness has no terminal host journal');
    const value = decodeCanonical(Buffer.from(witnessed.journal));
    const journal = exactObject(value, ['format', 'witnessRevision', 'configuration', 'generation', 'plan',
      'snapshot', 'calls', 'migrations', 'allocations', 'snapshots', 'heads', 'checkpointLeases',
      'checkpointReceipts', 'checkpointControls', ...((value as { format?: string }).format === 'aether.process-host/5' ? ['nativeFallbacks'] : [])]);
    if (!['aether.process-host/4', 'aether.process-host/5'].includes(String(journal.format))
      || journal.witnessRevision !== witnessed.revision || journal.configuration !== this.hostConfiguration
      || !Array.isArray(journal.checkpointLeases) || !Array.isArray(journal.checkpointReceipts)
      || !Array.isArray(journal.heads)) throw new Error('release requires the exact witnessed host profile');
    const matches = journal.checkpointLeases.filter(item => (item as ProcessCheckpointLease).binding?.id === bindingId) as ProcessCheckpointLease[];
    if (matches.length !== 1) throw new Error('release requires one exact checkpoint binding');
    const lease = matches[0];
    if (!lease) throw new Error('release checkpoint binding absent from witnessed host journal');
    exactObject(lease, ['binding', 'state', 'latestCheckpoint', 'checkpoints', 'receipt']);
    validateProcessCheckpointBinding(lease.binding);
    if (lease.binding.configuration !== this.hostConfiguration || lease.binding.program !== this.program.digest
      || lease.state !== 'committed' || lease.receipt === null || lease.latestCheckpoint === null
      || !Array.isArray(lease.checkpoints) || lease.checkpoints.at(-1) !== lease.latestCheckpoint)
      throw new Error('release checkpoint is not committed under this program');
    const receipts = journal.checkpointReceipts.filter(item => (item as ProcessCheckpointReceipt).id === lease.receipt) as ProcessCheckpointReceipt[];
    if (receipts.length !== 1) throw new Error('release requires one exact checkpoint receipt');
    const receipt = receipts[0];
    if (!receipt) throw new Error('release checkpoint receipt missing');
    exactObject(receipt, ['format', 'id', 'binding', 'checkpoint', 'beforeSnapshot', 'afterSnapshot', 'effectAudit', 'eventHead', 'eventCursor']);
    const { id: receiptId, ...receiptBody } = receipt;
    if (receipt.format !== 'aether.process-checkpoint-receipt/1'
      || processCheckpointReceiptDigest(receiptBody) !== receiptId || receipt.binding !== bindingId
      || receipt.checkpoint !== lease.latestCheckpoint || receipt.beforeSnapshot !== lease.binding.beforeSnapshot)
      throw new Error('release checkpoint receipt does not bind the committed lease');
    const heads = journal.heads as Array<Record<string, unknown>>;
    let previous: Digest | null = null;
    for (let index = 0; index < heads.length; index++) {
      const head = exactObject(heads[index], ['sequence', 'parent', 'generation', 'planDigest', 'snapshotDigest', 'cause', 'digest']);
      const { digest: headDigest, ...body } = head;
      if (head.sequence !== String(index) || head.parent !== previous
        || headDigest !== domainDigest('aether.process-state-head/1', body))
        throw new Error('release host state-head chain changed');
      previous = headDigest as Digest;
    }
    const index = heads.findIndex(item => (item.cause as { kind?: string; subjectDigest?: Digest })?.kind === 'checkpoint'
      && (item.cause as { subjectDigest?: Digest }).subjectDigest === receipt.id);
    if (index < 1 || heads.filter(item => (item.cause as { kind?: string; subjectDigest?: Digest })?.kind === 'checkpoint'
      && (item.cause as { subjectDigest?: Digest }).subjectDigest === receipt.id).length !== 1)
      throw new Error('release checkpoint lacks one committed state head');
    const head = heads[index], parent = heads[index - 1];
    const cause = exactObject(head.cause, ['kind', 'operationId', 'subjectDigest']);
    if (cause.operationId !== lease.binding.operationId || head.parent !== lease.binding.processHead
      || parent.digest !== lease.binding.processHead || parent.snapshotDigest !== receipt.beforeSnapshot
      || head.snapshotDigest !== receipt.afterSnapshot || head.generation !== lease.binding.generation)
      throw new Error('release checkpoint state head differs from receipt');
    const snapshot = readProcessCheckpoint(this.hostDirectory, receipt.checkpoint, this.program);
    if (snapshot.core.state !== 'completed' || snapshot.core.frames.length || snapshot.core.fault !== null
      || snapshot.core.executionManifest !== this.program.manifestDigest
      || snapshot.eventHead !== receipt.eventHead || snapshot.eventCursor !== receipt.eventCursor)
      throw new Error('release checkpoint is not a resolved completed execution');
    readCheckpointEffectAudit(this.hostDirectory, receipt.effectAudit, snapshot);
    const markerKey = domainDigest('aether.process-semantic-retention-key/1', {
      configuration: this.hostConfiguration, operationId: lease.binding.operationId }).split(':').at(-1)!;
    const markerPath = join(this.hostDirectory, 'checkpoint-semantic-retention', `${markerKey}.json`);
    if (statSync(markerPath).size > 1024 * 1024) throw new RangeError('release marker size limit');
    const marker = exactObject(decodeCanonical(readFileSync(markerPath)), ['format', 'hostConfiguration', 'hostManifest',
      'operationId', 'generation', 'beforeSnapshot', 'repositoryId', 'storeDirectory', 'collectorDirectory',
      'roots', 'reference', 'id']);
    const { id: markerId, ...markerBody } = marker;
    const roots = [...new Set([this.program.manifest.astRoot, ...this.program.manifest.dependencies.map(item => item.declaration)])].sort() as NodeRef[];
    if (marker.format !== 'aether.process-semantic-retention/1'
      || markerId !== domainDigest('aether.process-semantic-retention/1', markerBody)
      || marker.hostConfiguration !== this.hostConfiguration || marker.hostManifest !== this.program.manifestDigest
      || marker.operationId !== lease.binding.operationId || marker.generation !== lease.binding.generation
      || marker.beforeSnapshot !== lease.binding.beforeSnapshot || marker.repositoryId !== this.repositoryId
      || !equal([...marker.roots as NodeRef[]].sort(), roots) || typeof marker.reference !== 'string'
      || typeof marker.storeDirectory !== 'string' || typeof marker.collectorDirectory !== 'string')
      throw new Error('release marker differs from witnessed checkpoint');
    identifier(marker.reference);
    return { format: PROCESS_CHECKPOINT_ACTIVE_RELEASE_FORMAT, authority: this.digest,
      hostConfiguration: this.hostConfiguration, hostRevision: witnessed.revision,
      manifest: this.program.manifestDigest, program: this.program.digest, binding: bindingId,
      operationId: lease.binding.operationId, receipt: receipt.id, effectAudit: receipt.effectAudit,
      commitHead: head.digest as Digest, marker: markerId as Digest, reference: marker.reference as string,
      storeDirectory: marker.storeDirectory as string, collectorDirectory: marker.collectorDirectory as string, roots };
  }
  prove(bindingId: Digest): ProcessCheckpointActiveReleaseProof {
    const body = this.current(bindingId);
    return { ...body, id: domainDigest(PROCESS_CHECKPOINT_ACTIVE_RELEASE_FORMAT, body) };
  }
  verify(proof: ProcessCheckpointActiveReleaseProof): void {
    ProcessCheckpointActiveReleaseAuthority.assertInstance(this);
    exactObject(proof, ['format', 'authority', 'hostConfiguration', 'hostRevision', 'manifest', 'program',
      'binding', 'operationId', 'receipt', 'effectAudit', 'commitHead', 'marker', 'reference',
      'storeDirectory', 'collectorDirectory', 'roots', 'id']);
    const { id, ...body } = proof;
    if (proof.format !== PROCESS_CHECKPOINT_ACTIVE_RELEASE_FORMAT
      || id !== domainDigest(PROCESS_CHECKPOINT_ACTIVE_RELEASE_FORMAT, body))
      throw new Error('release proof identity changed');
    decimal(proof.hostRevision);
    const current = this.current(proof.binding);
    if (BigInt(current.hostRevision) < BigInt(proof.hostRevision)
      || !equal({ ...current, hostRevision: proof.hostRevision }, body))
      throw new Error('release proof is stale, foreign, or absent from the current witness');
  }
}
