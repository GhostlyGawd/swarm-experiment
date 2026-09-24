/** A synchronous, operator-selected mirror of complete sink decision journals.
 *
 * The provider must retain its journal outside the sink's writable store and
 * implement a durable atomic compare-and-swap. This wrapper detects rollback
 * and equivocation during one witness lifetime. It cannot authenticate the
 * operator or establish that the provider has separate physical custody.
 */
import { decodeCanonical, decimal, encodeCanonical, exactObject, identifier, validString,
  type TaggedValueV1 } from './encoding.ts';
import { validateEffectRequest, type EffectRequestV1 } from './effects.ts';
import { domainDigest, validateDigest, type Digest } from './identity.ts';
import { SINK_RECEIPT_LIMITS, validateSinkAdapterArtifactDigest, validateSinkPublicAnchor,
  validateSignedSinkReceipt, verifySinkReceipt, type SignedSinkReceiptV1,
  type SinkPublicAnchorV1 } from './sink-receipt.ts';

const FORMAT = 'aether.sink-state-witness/1' as const;
const JOURNAL_FORMAT = 'aether.attested-sink-state/2' as const;
const MAX_DECISIONS = 1024;
const LIMITS = { maxFrameBytes: 8 * 1024 * 1024, maxDecompressedBytes: 8 * 1024 * 1024,
  maxObjects: 200_000, maxDepth: 24, maxIntegerDigits: 40 } as const;

export interface SinkStateWitnessV1 {
  readonly format: typeof FORMAT;
  readonly authorityId: string;
  readonly repositoryId: string;
  readonly sinkAuthorityId: string;
  readonly sinkId: string;
  readonly sinkAnchorDigest: Digest;
  readonly adapterArtifactDigest: Digest;
  readonly digest: Digest;
}

export interface SinkStateHeadV1 {
  readonly revision: string;
  /** Complete canonical /2 sink journal as UTF-8 text; null only at genesis. */
  readonly journal: string | null;
}

export interface SinkStateDecisionRowV1 {
  readonly repositoryId: string;
  readonly deploymentId: string;
  readonly request: EffectRequestV1;
  readonly value: TaggedValueV1 | null;
  readonly receipt: SignedSinkReceiptV1;
}

export interface SinkStateJournalV2 {
  readonly format: typeof JOURNAL_FORMAT;
  readonly witnessDigest: Digest;
  readonly witnessRevision: string;
  readonly anchor: SinkPublicAnchorV1;
  readonly adapterArtifactDigest: Digest;
  readonly decisions: readonly SinkStateDecisionRowV1[];
}

interface Source {
  readonly read: () => SinkStateHeadV1;
  readonly advance: (expectedRevision: string, journal: string) => SinkStateHeadV1;
  readonly anchor: SinkPublicAnchorV1;
  readonly anchorDigest: Digest;
  readonly adapterArtifactDigest: Digest;
  readonly digest: Digest;
  lastRevision: bigint;
  lastJournal: string | null;
}
const sources = new WeakMap<object, Source>();

function validateRecord(value: unknown, source: Source, revision: string): asserts value is SinkStateJournalV2 {
  encodeCanonical(value, LIMITS);
  const state = exactObject(value, ['format', 'witnessDigest', 'witnessRevision', 'anchor',
    'adapterArtifactDigest', 'decisions']);
  if (state.format !== JOURNAL_FORMAT) throw new TypeError('invalid sink witness journal format');
  validateDigest(state.witnessDigest, FORMAT);
  if (state.witnessDigest !== source.digest) throw new Error('sink witness journal identity mismatch');
  decimal(state.witnessRevision, LIMITS);
  if (state.witnessRevision !== revision) throw new Error('sink witness journal revision mismatch');
  validateSinkPublicAnchor(state.anchor);
  if (domainDigest('aether.sink-anchor/1', state.anchor) !== source.anchorDigest)
    throw new Error('sink witness anchor mismatch');
  validateSinkAdapterArtifactDigest(state.adapterArtifactDigest);
  if (state.adapterArtifactDigest !== source.adapterArtifactDigest)
    throw new Error('sink witness adapter mismatch');
  if (!Array.isArray(state.decisions) || state.decisions.length > MAX_DECISIONS
    || String(state.decisions.length) !== revision)
    throw new Error('sink witness decision count/revision mismatch');
  const effects = new Set<string>();
  const decisionIds = new Set<string>();
  const commitIds = new Set<string>();
  for (let index = 0; index < state.decisions.length; index++) {
    const row = exactObject(state.decisions[index], ['repositoryId', 'deploymentId', 'request', 'value', 'receipt']);
    identifier(row.repositoryId); identifier(row.deploymentId);
    validateEffectRequest(row.request, SINK_RECEIPT_LIMITS);
    validateSignedSinkReceipt(row.receipt);
    const request = row.request as EffectRequestV1;
    const receipt = row.receipt as SignedSinkReceiptV1;
    const key = JSON.stringify([row.repositoryId, request.executionId, request.effectId]);
    if (effects.has(key) || decisionIds.has(receipt.body.decisionId)
      || (receipt.body.commitId !== null && commitIds.has(receipt.body.commitId)))
      throw new Error('duplicate sink witness decision identity');
    effects.add(key); decisionIds.add(receipt.body.decisionId);
    if (receipt.body.commitId !== null) commitIds.add(receipt.body.commitId);
    if (row.repositoryId !== source.anchor.repositoryId
      || receipt.body.sinkSequence !== String(index + 1)
      || !verifySinkReceipt(receipt, source.anchor, {
        repositoryId: row.repositoryId as string, deploymentId: row.deploymentId as string,
        request, sinkAuthorityId: source.anchor.sinkAuthorityId, sinkId: source.anchor.sinkId,
        adapterArtifactDigest: source.adapterArtifactDigest,
        disposition: receipt.body.disposition, value: row.value as TaggedValueV1 | null,
      })) throw new Error('invalid stored sink witness decision');
  }
}

/** Validates a parsed /2 journal against a live operator-selected witness. */
export function validateSinkStateJournalV2(value: unknown, witness: SinkStateWitnessV1,
  revision: string): asserts value is SinkStateJournalV2 {
  assertSinkStateWitness(witness);
  decimal(revision, LIMITS);
  validateRecord(value, sources.get(witness)!, revision);
}

function assertJournal(journal: unknown, source: Source, revision: string): asserts journal is string {
  validString(journal);
  if (!journal.length) throw new TypeError('missing sink witness journal');
  const bytes = Buffer.from(journal, 'utf8');
  if (bytes.length > LIMITS.maxFrameBytes) throw new RangeError('sink witness journal size limit');
  const decoded = decodeCanonical(bytes, LIMITS);
  if (!Buffer.from(encodeCanonical(decoded, LIMITS)).equals(bytes))
    throw new TypeError('noncanonical sink witness journal');
  validateRecord(decoded, source, revision);
}

export function createSinkStateWitness(options: Readonly<{
  authorityId: string;
  anchor: SinkPublicAnchorV1;
  adapterArtifactDigest: Digest;
  read: () => SinkStateHeadV1;
  /** Atomic durable CAS; retain and return the exact next canonical journal. */
  advance: (expectedRevision: string, journal: string) => SinkStateHeadV1;
}>): SinkStateWitnessV1 {
  if (!options || typeof options !== 'object') throw new TypeError('sink state witness options required');
  identifier(options.authorityId);
  validateSinkPublicAnchor(options.anchor);
  validateSinkAdapterArtifactDigest(options.adapterArtifactDigest);
  if (typeof options.read !== 'function' || typeof options.advance !== 'function')
    throw new TypeError('external sink state witness callbacks required');
  // Do not let the caller mutate the pinned anchor after selection.
  const anchor = decodeCanonical(encodeCanonical(options.anchor)) as unknown as SinkPublicAnchorV1;
  const sinkAnchorDigest = domainDigest('aether.sink-anchor/1', anchor);
  const body = { format: FORMAT, authorityId: options.authorityId,
    repositoryId: anchor.repositoryId, sinkAuthorityId: anchor.sinkAuthorityId,
    sinkId: anchor.sinkId, sinkAnchorDigest,
    adapterArtifactDigest: options.adapterArtifactDigest };
  const witness = Object.freeze({ ...body, digest: domainDigest(FORMAT, body) });
  sources.set(witness, { read: options.read, advance: options.advance, anchor,
    anchorDigest: sinkAnchorDigest, adapterArtifactDigest: options.adapterArtifactDigest,
    digest: witness.digest, lastRevision: -1n, lastJournal: null });
  readSinkStateHead(witness);
  return witness;
}

export function assertSinkStateWitness(value: unknown): asserts value is SinkStateWitnessV1 {
  if (value === null || typeof value !== 'object' || !sources.has(value))
    throw new TypeError('independently supplied sink state witness required');
}

function checked(source: Source, value: SinkStateHeadV1): SinkStateHeadV1 {
  const head = exactObject(value, ['revision', 'journal']);
  decimal(head.revision, LIMITS);
  const revision = BigInt(head.revision as string);
  if ((revision === 0n) !== (head.journal === null))
    throw new TypeError('sink witness genesis/journal mismatch');
  if (revision !== 0n) assertJournal(head.journal, source, head.revision as string);
  if (revision < source.lastRevision || (revision === source.lastRevision && head.journal !== source.lastJournal))
    throw new Error('sink witness rolled back or equivocated');
  source.lastRevision = revision;
  source.lastJournal = head.journal as string | null;
  return Object.freeze({ revision: head.revision as string, journal: head.journal as string | null });
}

export function readSinkStateHead(witness: SinkStateWitnessV1): SinkStateHeadV1 {
  assertSinkStateWitness(witness);
  const source = sources.get(witness)!;
  return checked(source, source.read());
}

export function advanceSinkStateHead(witness: SinkStateWitnessV1,
  expectedRevision: string, journal: string): SinkStateHeadV1 {
  assertSinkStateWitness(witness);
  decimal(expectedRevision, LIMITS);
  const source = sources.get(witness)!;
  const nextRevision = String(BigInt(expectedRevision) + 1n);
  assertJournal(journal, source, nextRevision);
  if (readSinkStateHead(witness).revision !== expectedRevision)
    throw new Error('stale sink witness revision');
  const head = checked(source, source.advance(expectedRevision, journal));
  if (head.revision !== nextRevision || head.journal !== journal)
    throw new Error('sink witness did not durably accept exact next journal');
  const retained = readSinkStateHead(witness);
  if (retained.revision !== nextRevision || retained.journal !== journal)
    throw new Error('sink witness did not retain exact next journal');
  return head;
}
