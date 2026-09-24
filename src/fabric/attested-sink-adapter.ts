/**
 * Trusted, opt-in bridge from a synchronous external sink to EffectAdapter.
 * The operator supplies the anchor and approved artifact identity independently
 * of the sink response. This module never holds a signing key. The sink must
 * durably enforce idempotency and terminal noncommit fences itself.
 *
 * The broker's ordinary journal records its own outcome digest, not the signed
 * sink receipt. A production deployment must retain that proof and its
 * anti-rollback head outside the broker; this in-process observation map is
 * only a contradiction check, not portable custody.
 */
import { decodeCanonical, encodeCanonical, exactObject, identifier, type TaggedValueV1 } from './encoding.ts';
import { effectRequestDigest, validateEffectRequest, type EffectAdapter, type EffectRequestV1 } from './effects.ts';
import { domainDigest, validateDigest, type Digest } from './identity.ts';
import { validateSinkPublicAnchor, verifySinkReceipt, type SignedSinkReceiptV1, type SinkPublicAnchorV1,
  type SinkReceiptBodyV1, type SinkReceiptExpectationV1 } from './sink-receipt.ts';

export interface AttestedSinkCommitV1 {
  readonly state: 'committed';
  readonly receipt: SignedSinkReceiptV1;
  readonly value: TaggedValueV1;
}
export type AttestedSinkStatusV1 = AttestedSinkCommitV1
  | { readonly state: 'not_committed'; readonly receipt: SignedSinkReceiptV1 }
  | { readonly state: 'unknown' };

/** A trusted synchronous transport. `status` is a read/reconciliation call: it
 * must never submit an external operation. A missing operation may be reported
 * as not_committed only after the sink durably fences all future commits. */
export interface AttestedSinkClientV1 {
  execute(request: EffectRequestV1): AttestedSinkCommitV1;
  status(request: EffectRequestV1): AttestedSinkStatusV1;
}

export interface AttestedSinkIdentityV1 {
  readonly repositoryId: string;
  readonly deploymentId: string;
  /** Independently approved artifact digest, never learned from a receipt. */
  readonly approvedAdapterArtifactDigest: Digest;
  /** Operator-custodied public key, never learned from a receipt or client. */
  readonly anchor: SinkPublicAnchorV1;
}
export interface AttestedSinkAdapterOptionsV1 extends AttestedSinkIdentityV1 {
  readonly id: string;
  readonly client: AttestedSinkClientV1;
}

interface ObservedDecision {
  readonly requestDigest: Digest;
  readonly receiptDigest: Digest;
  readonly disposition: SinkReceiptBodyV1['disposition'];
  readonly receipt: SignedSinkReceiptV1;
}
interface RequestSnapshot { readonly request: EffectRequestV1; readonly digest: Digest; readonly key: string }
interface AttestedBrand { readonly identity: AttestedSinkIdentityV1; readonly observed: Map<string, ObservedDecision> }
const trustedInstances = new WeakMap<EffectAdapter, AttestedBrand>();

const RECEIPT_LIMITS = { maxFrameBytes: 64 * 1024, maxDecompressedBytes: 64 * 1024, maxObjects: 256, maxDepth: 16, maxIntegerDigits: 40 } as const;
function detached<T>(value: T): T { return decodeCanonical(encodeCanonical(value, RECEIPT_LIMITS), RECEIPT_LIMITS) as T; }
function requestKey(request: EffectRequestV1): string { return JSON.stringify([request.executionId, request.effectId]); }

/** Versioned trusted wrapper. Its public EffectAdapter interface cannot carry
 * the sink proof into a broker V2 journal; see the custody warning above. */
export class AttestedSinkAdapterV1 implements EffectAdapter {
  readonly id: string;
  readonly semantics = Object.freeze({ readOnly: false, atomicIdempotency: true, transactional: false, reconciliation: true });
  readonly #anchor: SinkPublicAnchorV1;
  readonly #repositoryId: string;
  readonly #deploymentId: string;
  readonly #artifactDigest: Digest;
  readonly #executeSink: (request: EffectRequestV1) => AttestedSinkCommitV1;
  readonly #statusSink: (request: EffectRequestV1) => AttestedSinkStatusV1;
  readonly #observed = new Map<string, ObservedDecision>();

  constructor(options: AttestedSinkAdapterOptionsV1) {
    identifier(options.id); identifier(options.repositoryId); identifier(options.deploymentId);
    validateDigest(options.approvedAdapterArtifactDigest);
    if (!/^aether\.effect-adapter-artifact\/[1-9][0-9]*:b3:/.test(options.approvedAdapterArtifactDigest))
      throw new TypeError('approved adapter artifact digest required');
    const anchor = detached(options.anchor);
    validateSinkPublicAnchor(anchor);
    if (anchor.repositoryId !== options.repositoryId) throw new TypeError('sink anchor repository mismatch');
    if (!options.client || typeof options.client.execute !== 'function' || typeof options.client.status !== 'function')
      throw new TypeError('synchronous attested sink client required');
    this.id = options.id;
    this.#repositoryId = options.repositoryId;
    this.#deploymentId = options.deploymentId;
    this.#artifactDigest = options.approvedAdapterArtifactDigest;
    this.#anchor = Object.freeze(anchor);
    this.#executeSink = options.client.execute.bind(options.client);
    this.#statusSink = options.client.status.bind(options.client);
    trustedInstances.set(this, { identity: Object.freeze({ repositoryId: this.#repositoryId,
      deploymentId: this.#deploymentId, approvedAdapterArtifactDigest: this.#artifactDigest, anchor: this.#anchor }),
      observed: this.#observed });
    Object.freeze(this);
  }

  #snapshot(request: EffectRequestV1): RequestSnapshot {
    validateEffectRequest(request, RECEIPT_LIMITS);
    const snapshot = detached(request);
    const digest = effectRequestDigest(snapshot, RECEIPT_LIMITS);
    const key = requestKey(snapshot);
    const previous = this.#observed.get(key);
    if (previous && previous.requestDigest !== digest) throw new Error('attested_sink_request_identity_conflict');
    return { request: snapshot, digest, key };
  }

  #expected(request: EffectRequestV1, disposition: SinkReceiptBodyV1['disposition'], value: TaggedValueV1 | null): SinkReceiptExpectationV1 {
    return { repositoryId: this.#repositoryId, deploymentId: this.#deploymentId, request,
      sinkAuthorityId: this.#anchor.sinkAuthorityId, sinkId: this.#anchor.sinkId,
      adapterArtifactDigest: this.#artifactDigest, disposition, value };
  }

  #verifyAndObserve(snapshot: RequestSnapshot, receipt: unknown,
    disposition: SinkReceiptBodyV1['disposition'], value: TaggedValueV1 | null): void {
    if (!verifySinkReceipt(receipt, this.#anchor, this.#expected(snapshot.request, disposition, value)))
      throw new Error('attested_sink_receipt_invalid');
    const proof = detached(receipt as SignedSinkReceiptV1);
    const proofDigest = domainDigest('aether.sink-receipt/1', proof, RECEIPT_LIMITS);
    const previous = this.#observed.get(snapshot.key);
    if (previous && (previous.requestDigest !== snapshot.digest || previous.receiptDigest !== proofDigest || previous.disposition !== disposition))
      throw new Error('attested_sink_decision_conflict');
    this.#observed.set(snapshot.key, { requestDigest: snapshot.digest, receiptDigest: proofDigest, disposition, receipt: proof });
  }

  preflight(request: EffectRequestV1): void { this.#snapshot(request); }

  execute(request: EffectRequestV1): TaggedValueV1 {
    const snapshot = this.#snapshot(request);
    if (this.#observed.get(snapshot.key)?.disposition === 'not_committed') throw new Error('attested_sink_fenced');
    // The client gets its own copy so it cannot alter the trusted expectation.
    const response: unknown = this.#executeSink(detached(snapshot.request));
    const result = exactObject(response, ['state', 'receipt', 'value']);
    if (result.state !== 'committed') throw new Error('attested_sink_execute_unknown');
    const value = detached(result.value as TaggedValueV1);
    this.#verifyAndObserve(snapshot, result.receipt, 'committed', value);
    return value;
  }

  reconcile(request: EffectRequestV1, _prepared: TaggedValueV1 | null):
    { readonly state: 'committed'; readonly value: TaggedValueV1 } | { readonly state: 'not_committed' } | { readonly state: 'unknown' } {
    try {
      const snapshot = this.#snapshot(request);
      const response: unknown = this.#statusSink(detached(snapshot.request));
      if (response === null || typeof response !== 'object') return { state: 'unknown' };
      const state = (response as { state?: unknown }).state;
      if (state === 'unknown') {
        exactObject(response, ['state']);
        return { state: 'unknown' };
      }
      if (state === 'not_committed') {
        const result = exactObject(response, ['state', 'receipt']);
        this.#verifyAndObserve(snapshot, result.receipt, 'not_committed', null);
        return { state: 'not_committed' };
      }
      if (state === 'committed') {
        const result = exactObject(response, ['state', 'receipt', 'value']);
        const value = detached(result.value as TaggedValueV1);
        this.#verifyAndObserve(snapshot, result.receipt, 'committed', value);
        return { state: 'committed', value };
      }
    } catch { /* A transport fault, malformed reply, or contradiction is uncertain. */ }
    return { state: 'unknown' };
  }
}

export function createAttestedSinkAdapter(options: AttestedSinkAdapterOptionsV1): AttestedSinkAdapterV1 {
  return new AttestedSinkAdapterV1(options);
}

// Prevent replacement of the trusted methods while allowing only instances
// constructed by this module to pass the module-level brand check below.
Object.freeze(AttestedSinkAdapterV1.prototype);

/** The assertion does not dispatch through an adapter-controlled method. */
export function assertAttestedSinkAdapter(adapter: EffectAdapter, expected: AttestedSinkIdentityV1): asserts adapter is AttestedSinkAdapterV1 {
  const brand = trustedInstances.get(adapter);
  if (!brand || Object.getPrototypeOf(adapter) !== AttestedSinkAdapterV1.prototype) throw new TypeError('untrusted attested sink adapter');
  identifier(expected.repositoryId); identifier(expected.deploymentId);
  validateDigest(expected.approvedAdapterArtifactDigest); validateSinkPublicAnchor(expected.anchor);
  const identity = brand.identity;
  if (identity.repositoryId !== expected.repositoryId || identity.deploymentId !== expected.deploymentId ||
    identity.approvedAdapterArtifactDigest !== expected.approvedAdapterArtifactDigest ||
    Buffer.compare(encodeCanonical(identity.anchor, RECEIPT_LIMITS), encodeCanonical(expected.anchor, RECEIPT_LIMITS)) !== 0)
    throw new TypeError('attested sink adapter identity mismatch');
}

/** Returns a detached, previously verified proof for the exact request. A null
 * result means no terminal proof has been observed in this process. The broker
 * must independently verify the returned receipt before durable admission. */
export function verifiedSinkReceipt(adapter: EffectAdapter, request: EffectRequestV1): SignedSinkReceiptV1 | null {
  const brand = trustedInstances.get(adapter);
  if (!brand || Object.getPrototypeOf(adapter) !== AttestedSinkAdapterV1.prototype) throw new TypeError('untrusted attested sink adapter');
  validateEffectRequest(request, RECEIPT_LIMITS);
  const digest = effectRequestDigest(request, RECEIPT_LIMITS);
  const observed = brand.observed.get(requestKey(request));
  if (!observed) return null;
  if (observed.requestDigest !== digest) throw new Error('attested_sink_request_identity_conflict');
  return detached(observed.receipt);
}
