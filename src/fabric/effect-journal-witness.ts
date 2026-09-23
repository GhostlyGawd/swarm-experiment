/** A synchronous external journal witness for the opt-in effect journal V2.
 *
 * The provider must keep the complete canonical journal and a monotonic
 * revision outside the broker/factory's writable storage. This module checks
 * the interface and catches rollback during one anchor lifetime; it does not
 * create an OS security boundary or make a factory-supplied provider trusted.
 */
import { decimal, identifier } from './encoding.ts';
import { domainDigest, type Digest } from './identity.ts';

export interface EffectJournalWitness {
  readonly format: 'aether.effect-journal-witness/1';
  readonly authorityId: string;
  readonly repositoryId: string;
  readonly deploymentId: string;
  readonly clockDomain: string;
  readonly digest: Digest;
}
export interface WitnessHead {
  readonly revision: string;
  /** The canonical complete V2 journal, or null only at revision zero. */
  readonly journal: string | null;
}
interface Source {
  readonly read: () => WitnessHead;
  readonly advance: (expectedRevision: string, journal: string) => WitnessHead;
  lastRevision: bigint;
  lastJournal: string | null;
}
const sources = new WeakMap<object, Source>();
interface CatalogSource {
  readonly witnessFor: (operationId: string) => EffectJournalWitness;
  readonly selected: Map<string, EffectJournalWitness>;
}
const catalogs = new WeakMap<object, CatalogSource>();

/** An operator-selected namespace of per-operation witnesses. Its callback
 * must recover the same external durable head after controller restart. */
export interface EffectJournalWitnessCatalog {
  readonly format: 'aether.effect-journal-witness-catalog/1';
  readonly authorityId: string;
  readonly repositoryId: string;
  readonly deploymentId: string;
  readonly clockDomain: string;
  readonly digest: Digest;
}
export function createEffectJournalWitnessCatalog(options: Readonly<{
  authorityId: string;
  repositoryId: string;
  deploymentId: string;
  clockDomain: string;
  witnessFor: (operationId: string) => EffectJournalWitness;
}>): EffectJournalWitnessCatalog {
  for (const id of [options.authorityId, options.repositoryId, options.deploymentId, options.clockDomain]) identifier(id);
  if (typeof options.witnessFor !== 'function') throw new TypeError('journal witness catalog requires an operator source');
  const body = { format: 'aether.effect-journal-witness-catalog/1' as const,
    authorityId: options.authorityId, repositoryId: options.repositoryId,
    deploymentId: options.deploymentId, clockDomain: options.clockDomain };
  const catalog = Object.freeze({ ...body, digest: domainDigest(body.format, body) });
  catalogs.set(catalog, { witnessFor: options.witnessFor, selected: new Map() });
  return catalog;
}
export function assertEffectJournalWitnessCatalog(value: unknown): asserts value is EffectJournalWitnessCatalog {
  if (value === null || typeof value !== 'object' || !catalogs.has(value))
    throw new TypeError('independently supplied effect journal witness catalog required');
}
export function selectEffectJournalWitness(catalog: EffectJournalWitnessCatalog, operationId: string): EffectJournalWitness {
  assertEffectJournalWitnessCatalog(catalog); identifier(operationId);
  const source = catalogs.get(catalog)!;
  const witness = source.witnessFor(operationId);
  assertEffectJournalWitness(witness);
  if (witness.authorityId !== catalog.authorityId || witness.repositoryId !== catalog.repositoryId
    || witness.clockDomain !== catalog.clockDomain || witness.deploymentId !== operationId)
    throw new TypeError('effect journal witness is outside operator catalog');
  const selected = source.selected.get(operationId);
  if (selected && selected !== witness) throw new Error('effect journal witness swapped during catalog lifetime');
  source.selected.set(operationId, witness);
  readWitnessHead(witness);
  return witness;
}

export function createEffectJournalWitness(options: Readonly<{
  authorityId: string;
  repositoryId: string;
  deploymentId: string;
  clockDomain: string;
  read: () => WitnessHead;
  /** Atomic durable CAS; must retain and return the exact next journal. */
  advance: (expectedRevision: string, journal: string) => WitnessHead;
}>): EffectJournalWitness {
  for (const id of [options.authorityId, options.repositoryId, options.deploymentId, options.clockDomain]) identifier(id);
  if (typeof options.read !== 'function' || typeof options.advance !== 'function') throw new TypeError('external journal witness callbacks required');
  const body = { format: 'aether.effect-journal-witness/1' as const, authorityId: options.authorityId,
    repositoryId: options.repositoryId, deploymentId: options.deploymentId, clockDomain: options.clockDomain };
  const witness = Object.freeze({ ...body, digest: domainDigest(body.format, body) });
  sources.set(witness, { read: options.read, advance: options.advance, lastRevision: -1n, lastJournal: null });
  readWitnessHead(witness);
  return witness;
}
export function assertEffectJournalWitness(value: unknown): asserts value is EffectJournalWitness {
  if (value === null || typeof value !== 'object' || !sources.has(value)) throw new TypeError('independently supplied effect journal witness required');
}
function checked(source: Source, value: WitnessHead): WitnessHead {
  if (!value || typeof value !== 'object' || Object.keys(value).sort().join(',') !== 'journal,revision') throw new TypeError('invalid witness head');
  decimal(value.revision);
  if (value.journal !== null && typeof value.journal !== 'string') throw new TypeError('invalid witness journal');
  const revision = BigInt(value.revision);
  if ((revision === 0n) !== (value.journal === null)) throw new TypeError('witness genesis/journal mismatch');
  if (revision < source.lastRevision || revision === source.lastRevision && value.journal !== source.lastJournal)
    throw new Error('effect witness rolled back or equivocated');
  source.lastRevision = revision; source.lastJournal = value.journal;
  return Object.freeze({ revision: value.revision, journal: value.journal });
}
export function readWitnessHead(witness: EffectJournalWitness): WitnessHead {
  assertEffectJournalWitness(witness);
  const source = sources.get(witness)!;
  return checked(source, source.read());
}
export function advanceWitnessHead(witness: EffectJournalWitness, expectedRevision: string, journal: string): WitnessHead {
  assertEffectJournalWitness(witness); decimal(expectedRevision);
  if (typeof journal !== 'string' || !journal.length) throw new TypeError('missing next witness journal');
  const source = sources.get(witness)!;
  const head = checked(source, source.advance(expectedRevision, journal));
  if (BigInt(head.revision) !== BigInt(expectedRevision) + 1n || head.journal !== journal)
    throw new Error('effect witness did not durably accept exact next journal');
  return head;
}
