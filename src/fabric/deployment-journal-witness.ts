/** A synchronous, operator-supplied mirror of complete canonical deployment journals.
 *
 * The provider must keep its journal outside the deployment's writable directory
 * and implement a durable atomic compare-and-swap. This wrapper detects rollback
 * and equivocation while this witness object lives. It does not establish OS
 * isolation or authenticate an operator-supplied provider.
 */
import { decodeCanonical, decimal, encodeCanonical, exactObject, identifier, validString } from './encoding.ts';
import { domainDigest, validateDigest, type Digest } from './identity.ts';

const FORMAT = 'aether.process-deployment-journal-witness/1' as const;
const JOURNAL_FORMAT_V9 = 'aether.process-deployment/9' as const;
const JOURNAL_FORMAT_V10 = 'aether.process-deployment/10' as const;
const JOURNAL_FORMAT_V11 = 'aether.process-deployment/11' as const;
const LIMITS = { maxFrameBytes: 16 * 1024 * 1024, maxDecompressedBytes: 16 * 1024 * 1024,
  maxObjects: 500_000, maxDepth: 128 } as const;
const JOURNAL_FIELDS = ['format', 'witnessRevision', 'deploymentJournalWitnessDigest',
  'admissionProfile', 'capabilityProfile', 'effectSignerAnchorDigest', 'trustedClockAnchorDigest',
  'effectJournalWitnessCatalogDigest', 'hostJournalWitnessCatalogDigest', 'genesisManifest',
  'active', 'readiness', 'pendingProposal', 'invocations', 'allocations'] as const;
const SINK_FIELDS = ['sinkAnchorDigest', 'sinkDeploymentId',
  'approvedAdapterArtifactDigest', 'sinkStateWitnessDigest'] as const;
interface JournalIdentity {
  readonly format: typeof JOURNAL_FORMAT_V9 | typeof JOURNAL_FORMAT_V10 | typeof JOURNAL_FORMAT_V11;
  readonly sinkAnchorDigest?: Digest;
  readonly sinkDeploymentId?: string;
  readonly approvedAdapterArtifactDigest?: Digest;
  readonly sinkStateWitnessDigest?: Digest;
}

export interface DeploymentJournalWitness {
  readonly format: typeof FORMAT;
  readonly authorityId: string;
  readonly repositoryId: string;
  readonly deploymentId: string;
  readonly digest: Digest;
}

export interface DeploymentJournalHead {
  readonly revision: string;
  /** Complete canonical /9, /10 or /11 deployment journal as UTF-8 text; null at genesis only. */
  readonly journal: string | null;
}

interface Source {
  readonly read: () => DeploymentJournalHead;
  readonly advance: (expectedRevision: string, journal: string) => DeploymentJournalHead;
  readonly digest: Digest;
  readonly deploymentId: string;
  lastRevision: bigint;
  lastJournal: string | null;
  lastIdentity: JournalIdentity | null;
}
const sources = new WeakMap<object, Source>();

/** Checks the bounded envelope. ProcessDeployment validates its full semantics. */
function assertJournal(journal: unknown, revision: string, source: Source): JournalIdentity {
  validString(journal);
  if (!journal.length) throw new TypeError('missing deployment witness journal');
  const bytes = Buffer.from(journal, 'utf8');
  if (bytes.length > LIMITS.maxFrameBytes) throw new RangeError('deployment witness journal size limit');
  const decoded = decodeCanonical(bytes, LIMITS);
  if (Buffer.from(encodeCanonical(decoded, LIMITS)).toString('utf8') !== journal)
    throw new TypeError('noncanonical deployment witness journal');
  const format = (decoded as { format?: unknown }).format;
  const sinkJournal = format === JOURNAL_FORMAT_V10 || format === JOURNAL_FORMAT_V11;
  const record = exactObject(decoded, sinkJournal ? [...JOURNAL_FIELDS, ...SINK_FIELDS] : JOURNAL_FIELDS);
  if (record.format !== JOURNAL_FORMAT_V9 && record.format !== JOURNAL_FORMAT_V10
    && record.format !== JOURNAL_FORMAT_V11)
    throw new TypeError('invalid deployment witness journal format');
  decimal(record.witnessRevision);
  if (record.witnessRevision !== revision) throw new Error('deployment witness journal revision mismatch');
  validateDigest(record.deploymentJournalWitnessDigest, FORMAT);
  if (record.deploymentJournalWitnessDigest !== source.digest)
    throw new Error('deployment witness journal identity mismatch');
  if (!['strict-lineage-v1', 'baseline-governor-v1'].includes(record.admissionProfile as string)
    || record.capabilityProfile !== (format === JOURNAL_FORMAT_V11 ? 'scoped-anchored-sink-v11'
      : format === JOURNAL_FORMAT_V10 ? 'scoped-anchored-sink-v10' : 'scoped-anchored-wasm-v9')
    || !['ready', 'preparing', 'prepared'].includes(record.readiness as string)
    || (record.readiness === 'ready') !== (record.pendingProposal === null)
    || !Array.isArray(record.invocations) || !Array.isArray(record.allocations))
    throw new TypeError('invalid deployment witness journal envelope');
  for (const field of ['effectSignerAnchorDigest', 'trustedClockAnchorDigest',
    'effectJournalWitnessCatalogDigest', 'hostJournalWitnessCatalogDigest', 'genesisManifest'])
    validateDigest(record[field]);
  if (record.pendingProposal !== null) validateDigest(record.pendingProposal, 'aether.promotion/1');
  const active = exactObject(record.active, ['id', 'manifest', 'artifactDigest', 'generation']);
  identifier(active.id);
  validateDigest(active.manifest, 'aether.execution/1');
  validateDigest(active.artifactDigest, 'aether.process-artifact/1');
  decimal(active.generation);
  if (sinkJournal) {
    validateDigest(record.sinkAnchorDigest, 'aether.sink-anchor/1');
    identifier(record.sinkDeploymentId);
    if (record.sinkDeploymentId !== source.deploymentId)
      throw new TypeError('deployment witness sink namespace mismatch');
    validateDigest(record.approvedAdapterArtifactDigest);
    if (!/^aether\.effect-adapter-artifact\/[1-9][0-9]*:b3:/.test(record.approvedAdapterArtifactDigest as string))
      throw new TypeError('invalid deployment witness adapter artifact digest');
    validateDigest(record.sinkStateWitnessDigest, 'aether.sink-state-witness/1');
  }
  return { format: record.format as JournalIdentity['format'],
    ...(sinkJournal ? { sinkAnchorDigest: record.sinkAnchorDigest as Digest,
      sinkDeploymentId: record.sinkDeploymentId as string,
      approvedAdapterArtifactDigest: record.approvedAdapterArtifactDigest as Digest,
      sinkStateWitnessDigest: record.sinkStateWitnessDigest as Digest } : {}) };
}

function assertStableIdentity(source: Source, identity: JournalIdentity | null): void {
  if (source.lastRevision > 0n && identity && source.lastIdentity
    && (identity.format !== JOURNAL_FORMAT_V9 || source.lastIdentity.format !== JOURNAL_FORMAT_V9)
    && (identity.format !== source.lastIdentity.format
      || SINK_FIELDS.some(field => identity[field] !== source.lastIdentity![field])))
    throw new Error('deployment witness sink identity changed');
}

export function createDeploymentJournalWitness(options: Readonly<{
  authorityId: string;
  repositoryId: string;
  deploymentId: string;
  read: () => DeploymentJournalHead;
  /** Atomic durable CAS; retain and return the exact next canonical journal. */
  advance: (expectedRevision: string, journal: string) => DeploymentJournalHead;
}>): DeploymentJournalWitness {
  if (!options || typeof options !== 'object') throw new TypeError('deployment journal witness options required');
  for (const id of [options.authorityId, options.repositoryId, options.deploymentId]) identifier(id);
  if (typeof options.read !== 'function' || typeof options.advance !== 'function')
    throw new TypeError('external deployment journal witness callbacks required');
  const body = { format: FORMAT, authorityId: options.authorityId, repositoryId: options.repositoryId,
    deploymentId: options.deploymentId };
  const witness = Object.freeze({ ...body, digest: domainDigest(FORMAT, body) });
  sources.set(witness, { read: options.read, advance: options.advance, digest: witness.digest,
    deploymentId: options.deploymentId, lastRevision: -1n, lastJournal: null, lastIdentity: null });
  readDeploymentJournalHead(witness);
  return witness;
}

export function assertDeploymentJournalWitness(value: unknown): asserts value is DeploymentJournalWitness {
  if (value === null || typeof value !== 'object' || !sources.has(value))
    throw new TypeError('independently supplied deployment journal witness required');
}

function checked(source: Source, value: DeploymentJournalHead): DeploymentJournalHead {
  const head = exactObject(value, ['revision', 'journal']);
  decimal(head.revision);
  const revision = BigInt(head.revision as string);
  if ((revision === 0n) !== (head.journal === null))
    throw new TypeError('deployment witness genesis/journal mismatch');
  const identity = revision === 0n ? null : assertJournal(head.journal, head.revision as string, source);
  if (revision < source.lastRevision || (revision === source.lastRevision && head.journal !== source.lastJournal))
    throw new Error('deployment witness rolled back or equivocated');
  assertStableIdentity(source, identity);
  source.lastRevision = revision;
  source.lastJournal = head.journal as string | null;
  source.lastIdentity = identity;
  return Object.freeze({ revision: head.revision as string, journal: head.journal as string | null });
}

export function readDeploymentJournalHead(witness: DeploymentJournalWitness): DeploymentJournalHead {
  assertDeploymentJournalWitness(witness);
  const source = sources.get(witness)!;
  return checked(source, source.read());
}

export function advanceDeploymentJournalHead(witness: DeploymentJournalWitness,
  expectedRevision: string, journal: string): DeploymentJournalHead {
  assertDeploymentJournalWitness(witness);
  decimal(expectedRevision);
  const source = sources.get(witness)!;
  const nextRevision = String(BigInt(expectedRevision) + 1n);
  const identity = assertJournal(journal, nextRevision, source);
  if (readDeploymentJournalHead(witness).revision !== expectedRevision)
    throw new Error('stale deployment witness revision');
  assertStableIdentity(source, identity);
  const head = checked(source, source.advance(expectedRevision, journal));
  if (head.revision !== nextRevision || head.journal !== journal)
    throw new Error('deployment witness did not durably accept exact next journal');
  // A false success response must not stand in for a stored CAS result.
  readDeploymentJournalHead(witness);
  return head;
}
