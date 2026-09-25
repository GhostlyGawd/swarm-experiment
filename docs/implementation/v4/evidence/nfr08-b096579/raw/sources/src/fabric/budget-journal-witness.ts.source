/** Operator-selected, externally held monotonic heads for complete budget journals.
 * The callbacks must durably retain the exact canonical journal and implement
 * atomic compare-and-swap outside the budget writer's writable directory.
 * This wrapper detects equivocation during its lifetime; separate OS custody
 * is a deployment property, not implied by a callback or by this brand. */
import { decodeCanonical, decimal, encodeCanonical, exactObject, identifier } from './encoding.ts';
import { domainDigest, validateDigest, type Digest } from './identity.ts';

export type BudgetJournalKind = 'ledger' | 'bridge';
export interface BudgetJournalHead { readonly revision: string; readonly journal: string | null }
export interface BudgetJournalWitness {
  readonly format: 'aether.resource-budget-journal-witness/1';
  readonly authorityId: string; readonly repositoryId: string; readonly deploymentId: string;
  readonly journalKind: BudgetJournalKind; readonly journalId: string; readonly digest: Digest;
}
interface Source {
  readonly read: () => BudgetJournalHead;
  readonly advance: (expectedRevision: string, journal: string) => BudgetJournalHead;
  readonly kind: BudgetJournalKind;
  lastRevision: bigint;
  lastJournal: string | null;
}
const sources = new WeakMap<object, Source>();
const limits = { maxFrameBytes: 32 * 1024 * 1024, maxDecompressedBytes: 32 * 1024 * 1024, maxObjects: 1_000_000 };

function assertJournal(kind: BudgetJournalKind, journal: unknown): asserts journal is string {
  if (typeof journal !== 'string' || !journal.length || Buffer.byteLength(journal) > limits.maxFrameBytes)
    throw new TypeError('invalid budget witness journal size');
  const bytes = Buffer.from(journal, 'utf8');
  const decoded = decodeCanonical(bytes, limits);
  if (!Buffer.from(encodeCanonical(decoded, limits)).equals(bytes))
    throw new TypeError('noncanonical budget witness journal');
  const body = kind === 'ledger' ? exactObject(decoded, ['format', 'ledgerDigest', 'records'])
    : exactObject(exactObject(decoded, ['body', 'signature']).body,
      ['format', 'profileDigest', 'records']);
  if (body.format !== (kind === 'ledger' ? 'aether.resource-journal/1' : 'aether.resource-budget-bridge-journal/1')
    || !Array.isArray(body.records)) throw new TypeError('wrong budget witness journal profile');
  validateDigest(kind === 'ledger' ? body.ledgerDigest : body.profileDigest);
}

export function createBudgetJournalWitness(options: Readonly<{
  authorityId: string; repositoryId: string; deploymentId: string;
  journalKind: BudgetJournalKind; journalId: string;
  read: () => BudgetJournalHead;
  advance: (expectedRevision: string, journal: string) => BudgetJournalHead;
}>): BudgetJournalWitness {
  if (!options || typeof options !== 'object' || !['ledger', 'bridge'].includes(options.journalKind))
    throw new TypeError('budget journal witness kind required');
  for (const id of [options.authorityId, options.repositoryId, options.deploymentId, options.journalId]) identifier(id);
  if (typeof options.read !== 'function' || typeof options.advance !== 'function')
    throw new TypeError('external budget journal witness callbacks required');
  const body = { format: 'aether.resource-budget-journal-witness/1' as const,
    authorityId: options.authorityId, repositoryId: options.repositoryId,
    deploymentId: options.deploymentId, journalKind: options.journalKind, journalId: options.journalId };
  const witness = Object.freeze({ ...body, digest: domainDigest(body.format, body) });
  sources.set(witness, { read: options.read, advance: options.advance,
    kind: options.journalKind, lastRevision: -1n, lastJournal: null });
  readBudgetJournalHead(witness);
  return witness;
}

export function assertBudgetJournalWitness(value: unknown): asserts value is BudgetJournalWitness {
  if (value === null || typeof value !== 'object' || !sources.has(value))
    throw new TypeError('independently supplied budget journal witness required');
}

function checked(source: Source, value: BudgetJournalHead): BudgetJournalHead {
  const head = exactObject(value, ['revision', 'journal']);
  decimal(head.revision);
  const revision = BigInt(head.revision as string);
  if ((revision === 0n) !== (head.journal === null))
    throw new TypeError('budget witness genesis/journal mismatch');
  if (revision !== 0n) assertJournal(source.kind, head.journal);
  if (revision < source.lastRevision || (revision === source.lastRevision && head.journal !== source.lastJournal))
    throw new Error('budget witness rolled back or equivocated');
  source.lastRevision = revision; source.lastJournal = head.journal as string | null;
  return Object.freeze({ revision: head.revision as string, journal: head.journal as string | null });
}

export function readBudgetJournalHead(witness: BudgetJournalWitness): BudgetJournalHead {
  assertBudgetJournalWitness(witness);
  const source = sources.get(witness)!;
  return checked(source, source.read());
}

export function advanceBudgetJournalHead(witness: BudgetJournalWitness,
  expectedRevision: string, journal: string): BudgetJournalHead {
  assertBudgetJournalWitness(witness); decimal(expectedRevision);
  const source = sources.get(witness)!;
  assertJournal(source.kind, journal);
  if (readBudgetJournalHead(witness).revision !== expectedRevision)
    throw new Error('stale budget witness revision');
  const next = String(BigInt(expectedRevision) + 1n);
  const head = checked(source, source.advance(expectedRevision, journal));
  if (head.revision !== next || head.journal !== journal)
    throw new Error('budget witness did not durably accept exact next journal');
  readBudgetJournalHead(witness);
  return head;
}
