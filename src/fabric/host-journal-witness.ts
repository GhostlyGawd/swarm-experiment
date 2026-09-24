/** A synchronous, operator-supplied mirror of complete canonical host journals.
 *
 * The provider must store the journal and monotonic revision outside the host's
 * writable directory and implement an atomic durable compare-and-swap. This
 * interface detects rollback or equivocation during one anchor lifetime; it
 * does not itself establish separate custody or authenticate a provider.
 */
import { DEFAULT_ENCODING_LIMITS, decodeCanonical, decimal, encodeCanonical, exactObject, identifier } from './encoding.ts';
import { domainDigest, validateDigest, type Digest } from './identity.ts';

export interface HostJournalWitness {
  readonly format: 'aether.process-host-journal-witness/1';
  readonly authorityId: string;
  readonly repositoryId: string;
  /** Distinct operator-selected deployment namespace; prevents cross-deployment adoption. */
  readonly deploymentId: string;
  /** Stable operator-chosen identity for this host journal. */
  readonly hostId: string;
  readonly digest: Digest;
}

export interface HostJournalHead {
  readonly revision: string;
  /** Complete canonical host journal bytes as UTF-8 text; null only at genesis. */
  readonly journal: string | null;
}

interface Source {
  readonly read: () => HostJournalHead;
  readonly advance: (expectedRevision: string, journal: string) => HostJournalHead;
  lastRevision: bigint;
  lastJournal: string | null;
}
const sources = new WeakMap<object, Source>();
interface CatalogSource {
  readonly witnessFor: (hostId: string) => HostJournalWitness;
  readonly selected: Map<string, HostJournalWitness>;
}
const catalogs = new WeakMap<object, CatalogSource>();

/** One operator-selected namespace of stable host witnesses for a deployment. */
export interface HostJournalWitnessCatalog {
  readonly format: 'aether.process-host-journal-witness-catalog/1';
  readonly authorityId: string;
  readonly repositoryId: string;
  readonly deploymentId: string;
  readonly digest: Digest;
}

export function createHostJournalWitnessCatalog(options: Readonly<{
  authorityId: string;
  repositoryId: string;
  deploymentId: string;
  witnessFor: (hostId: string) => HostJournalWitness;
}>): HostJournalWitnessCatalog {
  if (!options || typeof options !== 'object') throw new TypeError('host journal witness catalog options required');
  for (const id of [options.authorityId, options.repositoryId, options.deploymentId]) identifier(id);
  if (typeof options.witnessFor !== 'function') throw new TypeError('host journal witness catalog requires an operator source');
  const body = { format: 'aether.process-host-journal-witness-catalog/1' as const,
    authorityId: options.authorityId, repositoryId: options.repositoryId, deploymentId: options.deploymentId };
  const catalog = Object.freeze({ ...body, digest: domainDigest(body.format, body) });
  catalogs.set(catalog, { witnessFor: options.witnessFor, selected: new Map() });
  return catalog;
}

export function assertHostJournalWitnessCatalog(value: unknown): asserts value is HostJournalWitnessCatalog {
  if (value === null || typeof value !== 'object' || !catalogs.has(value))
    throw new TypeError('independently supplied host journal witness catalog required');
}

export function selectHostJournalWitness(catalog: HostJournalWitnessCatalog, hostId: string): HostJournalWitness {
  assertHostJournalWitnessCatalog(catalog); identifier(hostId);
  const source = catalogs.get(catalog)!;
  const witness = source.witnessFor(hostId);
  assertHostJournalWitness(witness);
  if (witness.authorityId !== catalog.authorityId || witness.repositoryId !== catalog.repositoryId
    || witness.deploymentId !== catalog.deploymentId || witness.hostId !== hostId)
    throw new TypeError('host journal witness is outside operator catalog');
  const selected = source.selected.get(hostId);
  if (selected && selected !== witness) throw new Error('host journal witness swapped during catalog lifetime');
  source.selected.set(hostId, witness);
  readHostJournalHead(witness);
  return witness;
}

/** Checks the bounded canonical envelope. ProcessHost validates its semantics. */
function assertJournal(journal: unknown, revision: string): asserts journal is string {
  if (typeof journal !== 'string' || !journal.length) throw new TypeError('missing host witness journal');
  if (Buffer.byteLength(journal, 'utf8') > DEFAULT_ENCODING_LIMITS.maxFrameBytes)
    throw new RangeError('host witness journal size limit');
  const decoded = decodeCanonical(Buffer.from(journal, 'utf8'));
  if (Buffer.from(encodeCanonical(decoded)).toString('utf8') !== journal)
    throw new TypeError('noncanonical host witness journal');
  const record = exactObject(decoded, Object.keys(decoded ?? {}));
  if (!['aether.process-host/1', 'aether.process-host/2', 'aether.process-host/3', 'aether.process-host/4'].includes(record.format as string))
    throw new TypeError('invalid host witness journal format');
  for (const field of ['configuration', 'generation', 'plan', 'snapshot', 'calls', 'migrations', 'allocations', 'snapshots', 'heads'])
    if (!Object.hasOwn(record, field)) throw new TypeError('incomplete host witness journal');
  validateDigest(record.configuration);
  decimal(record.generation);
  if (typeof record.plan !== 'string' || !record.snapshot || typeof record.snapshot !== 'object'
    || ![record.calls, record.migrations, record.allocations, record.snapshots, record.heads].every(Array.isArray))
    throw new TypeError('invalid host witness journal envelope');
  if (record.format === 'aether.process-host/4') {
    decimal(record.witnessRevision);
    if (record.witnessRevision !== revision) throw new Error('host witness journal revision mismatch');
  }
}

export function createHostJournalWitness(options: Readonly<{
  authorityId: string;
  repositoryId: string;
  deploymentId: string;
  hostId: string;
  read: () => HostJournalHead;
  /** Atomic durable CAS; retain and return the exact next canonical journal. */
  advance: (expectedRevision: string, journal: string) => HostJournalHead;
}>): HostJournalWitness {
  if (!options || typeof options !== 'object') throw new TypeError('host journal witness options required');
  for (const id of [options.authorityId, options.repositoryId, options.deploymentId, options.hostId]) identifier(id);
  if (typeof options.read !== 'function' || typeof options.advance !== 'function')
    throw new TypeError('external host journal witness callbacks required');
  const body = { format: 'aether.process-host-journal-witness/1' as const,
    authorityId: options.authorityId, repositoryId: options.repositoryId,
    deploymentId: options.deploymentId, hostId: options.hostId };
  const witness = Object.freeze({ ...body, digest: domainDigest(body.format, body) });
  sources.set(witness, { read: options.read, advance: options.advance, lastRevision: -1n, lastJournal: null });
  readHostJournalHead(witness);
  return witness;
}

export function assertHostJournalWitness(value: unknown): asserts value is HostJournalWitness {
  if (value === null || typeof value !== 'object' || !sources.has(value))
    throw new TypeError('independently supplied host journal witness required');
}

function checked(source: Source, value: HostJournalHead): HostJournalHead {
  const head = exactObject(value, ['revision', 'journal']);
  decimal(head.revision);
  const revision = BigInt(head.revision as string);
  if ((revision === 0n) !== (head.journal === null)) throw new TypeError('host witness genesis/journal mismatch');
  if (revision !== 0n) assertJournal(head.journal, head.revision as string);
  if (revision < source.lastRevision || (revision === source.lastRevision && head.journal !== source.lastJournal))
    throw new Error('host witness rolled back or equivocated');
  source.lastRevision = revision;
  source.lastJournal = head.journal as string | null;
  return Object.freeze({ revision: head.revision as string, journal: head.journal as string | null });
}

export function readHostJournalHead(witness: HostJournalWitness): HostJournalHead {
  assertHostJournalWitness(witness);
  const source = sources.get(witness)!;
  return checked(source, source.read());
}

export function advanceHostJournalHead(witness: HostJournalWitness, expectedRevision: string, journal: string): HostJournalHead {
  assertHostJournalWitness(witness);
  decimal(expectedRevision);
  const nextRevision = String(BigInt(expectedRevision) + 1n);
  assertJournal(journal, nextRevision);
  const source = sources.get(witness)!;
  if (readHostJournalHead(witness).revision !== expectedRevision) throw new Error('stale host witness revision');
  const head = checked(source, source.advance(expectedRevision, journal));
  if (head.revision !== nextRevision || head.journal !== journal)
    throw new Error('host witness did not durably accept exact next journal');
  const retained = readHostJournalHead(witness);
  if (retained.revision !== nextRevision || retained.journal !== journal)
    throw new Error('host witness did not retain exact next journal');
  return head;
}
