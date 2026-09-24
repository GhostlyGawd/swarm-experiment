/** Independent settlement evidence for ResourceBudgetBridge and ResourceBudgetLedger.
 *
 * This provider reads the current, branded /2 sink witness head. It does not
 * trust a broker result, a caller-supplied receipt, or a missing sink row as
 * terminal noncommit. A predispatch refund without a signed sink fence needs
 * a separately qualified broker authority and is outside this helper. The
 * full-request inventory is operator pinned; dynamic issuance needs a durable
 * assignment authority. This verifies evidence, not which pre-split handle
 * funded an effect: that selection still needs ledger/bridge operator custody.
 */
import { decodeCanonical, decimal, encodeCanonical, exactObject, identifier,
  type TaggedValueV1 } from '../fabric/encoding.ts';
import { effectRequestDigest, validateEffectRequest, type EffectRequestV1 } from '../fabric/effects.ts';
import { domainDigest, validateDigest, type Digest } from '../fabric/identity.ts';
import { SINK_RECEIPT_LIMITS, validateSinkAdapterArtifactDigest, validateSinkPublicAnchor,
  validateSignedSinkReceipt, verifySinkReceipt, type SignedSinkReceiptV1,
  type SinkPublicAnchorV1 } from '../fabric/sink-receipt.ts';
import { assertSinkStateWitness, readSinkStateHead, validateSinkStateJournalV2,
  type SinkStateDecisionRowV1, type SinkStateJournalV2, type SinkStateWitnessV1 } from '../fabric/sink-state-witness.ts';
import { decodeBudgetSettlementWitness, type BudgetObservation } from './resource-budget-bridge.ts';
import { type ResourceAmounts, type ResourceBinding, type ResourceSettlement } from './resource-budget.ts';

const JOURNAL_LIMITS = { maxFrameBytes: 8 * 1024 * 1024, maxDecompressedBytes: 8 * 1024 * 1024,
  maxObjects: 200_000, maxDepth: 24, maxIntegerDigits: 40 } as const;
const MAX_AMOUNT = (1n << 128n) - 1n;
const AMOUNT_KEYS = ['usdMicros', 'tokens', 'nanoseconds', 'memoryBytes'] as const;
const zero = (): ResourceAmounts => ({ usdMicros: '0', tokens: '0', nanoseconds: '0', memoryBytes: '0' });
const same = (left: unknown, right: unknown): boolean =>
  Buffer.from(encodeCanonical(left, JOURNAL_LIMITS)).equals(Buffer.from(encodeCanonical(right, JOURNAL_LIMITS)));
function amount(value: unknown): asserts value is ResourceAmounts {
  const record = exactObject(value, AMOUNT_KEYS);
  for (const key of AMOUNT_KEYS) {
    decimal(record[key], JOURNAL_LIMITS);
    if (BigInt(record[key] as string) > MAX_AMOUNT) throw new RangeError('resource charge exceeds unsigned 128-bit limit');
  }
}
function binding(request: EffectRequestV1): ResourceBinding {
  return { executionId: request.executionId, effectId: request.effectId,
    executionManifest: request.executionManifest, payloadDigest: request.payloadDigest,
    policyEpoch: request.policyEpoch };
}
function bindingKey(value: ResourceBinding): string {
  return JSON.stringify([value.executionId, value.effectId, value.executionManifest,
    value.payloadDigest, value.policyEpoch]);
}
function effectKey(request: EffectRequestV1): string {
  return JSON.stringify([request.executionId, request.effectId]);
}
function selected(rows: readonly SinkStateDecisionRowV1[], repositoryId: string,
  request: EffectRequestV1): SinkStateDecisionRowV1 | undefined {
  return rows.find(row => row.repositoryId === repositoryId
    && row.request.executionId === request.executionId && row.request.effectId === request.effectId);
}
function receiptEvidence(receipt: SignedSinkReceiptV1): TaggedValueV1 {
  return { tag: 'string', value: Buffer.from(encodeCanonical(receipt, SINK_RECEIPT_LIMITS)).toString('utf8') };
}
function decodeReceiptEvidence(value: TaggedValueV1): SignedSinkReceiptV1 {
  if (value.tag !== 'string') throw new TypeError('signed sink receipt string required');
  const bytes = Buffer.from(value.value, 'utf8');
  const receipt = decodeCanonical(bytes, SINK_RECEIPT_LIMITS);
  if (!Buffer.from(encodeCanonical(receipt, SINK_RECEIPT_LIMITS)).equals(bytes))
    throw new TypeError('noncanonical signed sink receipt evidence');
  validateSignedSinkReceipt(receipt);
  return receipt;
}

export interface AttestedSinkBudgetEvidenceOptions {
  /** Brand prevents a copied digest/object from posing as an operator witness. */
  readonly witness: SinkStateWitnessV1;
  /** Pinned independently of the witness journal and settlement evidence. */
  readonly anchor: SinkPublicAnchorV1;
  readonly repositoryId: string;
  readonly deploymentId: string;
  readonly approvedAdapterArtifactDigest: Digest;
  /** Pin this before reopening a settled ResourceBudgetLedger. Historical
   * evidence is checked on reads only if revalidateSettlementOnRead is enabled;
   * without it, an earlier settlement is not reverified on reopen. */
  readonly ledgerDigest: Digest;
  readonly owner: string;
  /** Fixed conservative per-commit charge; no caller-supplied metering. */
  readonly charge: ResourceAmounts;
  /** Operator-assigned full requests, before dispatch. One per five-field
   * budget binding, effect identity, and non-null reservation ID. This bounded
   * inventory cannot be inferred from a settlement or sink response. */
  readonly expectedRequests: readonly EffectRequestV1[];
}
export interface AttestedSinkBudgetEvidence {
  readonly policyDigest: Digest;
  observe(request: EffectRequestV1): BudgetObservation;
  verifySettlement(settlement: ResourceSettlement): boolean;
}

export type AttestedSinkBudgetEvidencePolicyOptions = Omit<AttestedSinkBudgetEvidenceOptions, 'ledgerDigest'>;
function preparePolicy(options: AttestedSinkBudgetEvidencePolicyOptions): Readonly<{
  policyDigest: Digest; expected: Map<string, Digest>; effects: Set<string>;
  anchor: SinkPublicAnchorV1; charge: ResourceAmounts;
}> {
  assertSinkStateWitness(options.witness);
  validateSinkPublicAnchor(options.anchor);
  identifier(options.repositoryId); identifier(options.deploymentId); identifier(options.owner);
  validateSinkAdapterArtifactDigest(options.approvedAdapterArtifactDigest);
  amount(options.charge);
  if (!Array.isArray(options.expectedRequests) || options.expectedRequests.length < 1
    || options.expectedRequests.length > 256)
    throw new TypeError('bounded expected sink requests required');
  const expected = new Map<string, Digest>();
  const effects = new Set<string>();
  const reservations = new Set<string>();
  const inventory: { binding: ResourceBinding; budgetReservationId: string; requestDigest: Digest }[] = [];
  for (const request of options.expectedRequests) {
    validateEffectRequest(request, SINK_RECEIPT_LIMITS);
    if (request.budgetReservationId === null) throw new TypeError('expected sink request needs budget reservation ID');
    const bound = bindingKey(binding(request));
    const effect = effectKey(request);
    if (expected.has(bound) || effects.has(effect) || reservations.has(request.budgetReservationId))
      throw new TypeError('ambiguous expected sink request binding or reservation');
    const requestDigest = effectRequestDigest(request, SINK_RECEIPT_LIMITS);
    expected.set(bound, requestDigest);
    effects.add(effect); reservations.add(request.budgetReservationId);
    inventory.push({ binding: binding(request), budgetReservationId: request.budgetReservationId,
      requestDigest });
  }
  const anchor = decodeCanonical(encodeCanonical(options.anchor)) as unknown as SinkPublicAnchorV1;
  const charge = Object.freeze(decodeCanonical(encodeCanonical(options.charge)) as unknown as ResourceAmounts);
  if (anchor.repositoryId !== options.repositoryId || options.witness.repositoryId !== options.repositoryId
    || options.witness.sinkAuthorityId !== anchor.sinkAuthorityId || options.witness.sinkId !== anchor.sinkId
    || options.witness.sinkAnchorDigest !== domainDigest('aether.sink-anchor/1', anchor)
    || options.witness.adapterArtifactDigest !== options.approvedAdapterArtifactDigest)
    throw new TypeError('sink budget evidence identity differs from independently pinned witness');
  inventory.sort((left, right) => {
    const a = bindingKey(left.binding), b = bindingKey(right.binding);
    return a < b ? -1 : a > b ? 1 : 0;
  });
  const policyDigest = domainDigest('aether.attested-sink-budget-evidence-policy/1', {
    format: 'aether.attested-sink-budget-evidence-policy/1', repositoryId: options.repositoryId,
    deploymentId: options.deploymentId, sinkAnchorDigest: options.witness.sinkAnchorDigest,
    sinkStateWitnessDigest: options.witness.digest,
    approvedAdapterArtifactDigest: options.approvedAdapterArtifactDigest,
    owner: options.owner, charge, expectedRequests: inventory,
  });
  return { policyDigest, expected, effects, anchor, charge };
}

/** Pure pre-ledger identity: excludes ledgerDigest to avoid a construction
 * cycle, but includes the canonical inventory of full request digests. It
 * does not contact the witness service or read its head. */
export function attestedSinkBudgetEvidencePolicyDigest(options: AttestedSinkBudgetEvidencePolicyOptions): Digest {
  return preparePolicy(options).policyDigest;
}

export function createAttestedSinkBudgetEvidence(options: AttestedSinkBudgetEvidenceOptions): AttestedSinkBudgetEvidence {
  validateDigest(options.ledgerDigest, 'aether.resource-budget/1');
  const { policyDigest, expected, effects, anchor, charge } = preparePolicy(options);

  const currentRows = (): readonly SinkStateDecisionRowV1[] | null => {
    try {
      const head = readSinkStateHead(options.witness);
      if (head.journal === null) return [];
      const journal = decodeCanonical(Buffer.from(head.journal, 'utf8'), JOURNAL_LIMITS);
      validateSinkStateJournalV2(journal, options.witness, head.revision);
      const state = journal as SinkStateJournalV2;
      if (!same(state.anchor, anchor) || state.adapterArtifactDigest !== options.approvedAdapterArtifactDigest)
        return null;
      return state.decisions;
    } catch { return null; }
  };
  const validRow = (row: SinkStateDecisionRowV1, request: EffectRequestV1): boolean => {
    const disposition = row.receipt.body.disposition;
    return row.repositoryId === options.repositoryId && row.deploymentId === options.deploymentId
      && effectRequestDigest(row.request, SINK_RECEIPT_LIMITS) === effectRequestDigest(request, SINK_RECEIPT_LIMITS)
      && verifySinkReceipt(row.receipt, anchor, {
        repositoryId: options.repositoryId, deploymentId: options.deploymentId, request,
        sinkAuthorityId: anchor.sinkAuthorityId, sinkId: anchor.sinkId,
        adapterArtifactDigest: options.approvedAdapterArtifactDigest,
        disposition, value: row.value,
      });
  };
  const expectedDigest = (request: EffectRequestV1): Digest | undefined =>
    expected.get(bindingKey(binding(request)));
  const exactExpected = (request: EffectRequestV1): boolean =>
    expectedDigest(request) === effectRequestDigest(request, SINK_RECEIPT_LIMITS);
  const observe = (request: EffectRequestV1): BudgetObservation => {
    validateEffectRequest(request, SINK_RECEIPT_LIMITS);
    const pinned = expectedDigest(request);
    if (pinned === undefined) throw new Error(effects.has(effectKey(request))
      ? 'attested sink budget request identity conflict'
      : 'attested sink budget request is unpinned');
    if (pinned !== effectRequestDigest(request, SINK_RECEIPT_LIMITS))
      throw new Error('attested sink budget request identity conflict');
    const rows = currentRows();
    if (rows === null) return { state: 'unknown' };
    const row = selected(rows, options.repositoryId, request);
    if (!row) return { state: 'unknown' };
    if (!validRow(row, request)) throw new Error('attested sink budget request identity conflict');
    const evidence = receiptEvidence(row.receipt);
    return row.receipt.body.disposition === 'committed'
      ? { state: 'committed', value: row.value!, charge, evidence }
      : { state: 'not_committed', evidence };
  };
  const verifySettlement = (settlement: ResourceSettlement): boolean => {
    try {
      exactObject(settlement, ['ledgerDigest', 'binding', 'owner', 'disposition', 'charge', 'evidence']);
      if (settlement.ledgerDigest !== options.ledgerDigest || settlement.owner !== options.owner) return false;
      amount(settlement.charge);
      const outer = decodeBudgetSettlementWitness(settlement.evidence);
      const request = outer.request;
      if (!exactExpected(request)) return false;
      const rows = currentRows();
      if (rows === null) return false;
      const row = selected(rows, options.repositoryId, request);
      if (!row || !validRow(row, request)) return false;
      if (!same(outer.request, row.request) || !same(settlement.binding, binding(request))
        || outer.disposition !== settlement.disposition || outer.disposition !== row.receipt.body.disposition
        || !same(outer.charge, settlement.charge) || !same(outer.value, row.value)) return false;
      if (outer.disposition === 'committed' ? !same(settlement.charge, charge)
        : !same(settlement.charge, zero())) return false;
      const inner = decodeReceiptEvidence(outer.evidence);
      if (!same(inner, row.receipt)) return false;
      return verifySinkReceipt(inner, anchor, { repositoryId: options.repositoryId,
        deploymentId: options.deploymentId, request,
        sinkAuthorityId: anchor.sinkAuthorityId, sinkId: anchor.sinkId,
        adapterArtifactDigest: options.approvedAdapterArtifactDigest,
        disposition: outer.disposition, value: outer.value });
    } catch { return false; }
  };
  return Object.freeze({ policyDigest, observe, verifySettlement });
}
