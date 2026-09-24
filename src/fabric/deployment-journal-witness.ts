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
const JOURNAL_FORMAT = 'aether.process-deployment/9' as const;
const LIMITS = { maxFrameBytes: 16 * 1024 * 1024, maxDecompressedBytes: 16 * 1024 * 1024,
  maxObjects: 500_000, maxDepth: 128 } as const;
const JOURNAL_FIELDS = ['format', 'witnessRevision', 'deploymentJournalWitnessDigest',
  'admissionProfile', 'capabilityProfile', 'effectSignerAnchorDigest', 'trustedClockAnchorDigest',
  'effectJournalWitnessCatalogDigest', 'hostJournalWitnessCatalogDigest', 'genesisManifest',
  'active', 'readiness', 'pendingProposal', 'invocations', 'allocations'] as const;

export interface DeploymentJournalWitness {
  readonly format: typeof FORMAT;
  readonly authorityId: string;
  readonly repositoryId: string;
  readonly deploymentId: string;
  readonly digest: Digest;
}

export interface DeploymentJournalHead {
  readonly revision: string;
  /** Complete canonical /9 deployment journal as UTF-8 text; null at genesis only. */
  readonly journal: string | null;
}

interface Source {
  readonly read: () => DeploymentJournalHead;
  readonly advance: (expectedRevision: string, journal: string) => DeploymentJournalHead;
  readonly digest: Digest;
  lastRevision: bigint;
  lastJournal: string | null;
}
const sources = new WeakMap<object, Source>();

/** Checks the bounded envelope. ProcessDeployment validates its full semantics. */
function assertJournal(journal: unknown, revision: string, witnessDigest: Digest): asserts journal is string {
  validString(journal);
  if (!journal.length) throw new TypeError('missing deployment witness journal');
  const bytes = Buffer.from(journal, 'utf8');
  if (bytes.length > LIMITS.maxFrameBytes) throw new RangeError('deployment witness journal size limit');
  const decoded = decodeCanonical(bytes, LIMITS);
  if (Buffer.from(encodeCanonical(decoded, LIMITS)).toString('utf8') !== journal)
    throw new TypeError('noncanonical deployment witness journal');
  const record = exactObject(decoded, JOURNAL_FIELDS);
  if (record.format !== JOURNAL_FORMAT) throw new TypeError('invalid deployment witness journal format');
  decimal(record.witnessRevision);
  if (record.witnessRevision !== revision) throw new Error('deployment witness journal revision mismatch');
  validateDigest(record.deploymentJournalWitnessDigest, FORMAT);
  if (record.deploymentJournalWitnessDigest !== witnessDigest)
    throw new Error('deployment witness journal identity mismatch');
  if (!['strict-lineage-v1', 'baseline-governor-v1'].includes(record.admissionProfile as string)
    || record.capabilityProfile !== 'scoped-anchored-wasm-v9'
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
    lastRevision: -1n, lastJournal: null });
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
  if (revision !== 0n) assertJournal(head.journal, head.revision as string, source.digest);
  if (revision < source.lastRevision || (revision === source.lastRevision && head.journal !== source.lastJournal))
    throw new Error('deployment witness rolled back or equivocated');
  source.lastRevision = revision;
  source.lastJournal = head.journal as string | null;
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
  assertJournal(journal, nextRevision, source.digest);
  if (readDeploymentJournalHead(witness).revision !== expectedRevision)
    throw new Error('stale deployment witness revision');
  const head = checked(source, source.advance(expectedRevision, journal));
  if (head.revision !== nextRevision || head.journal !== journal)
    throw new Error('deployment witness did not durably accept exact next journal');
  // A false success response must not stand in for a stored CAS result.
  readDeploymentJournalHead(witness);
  return head;
}
