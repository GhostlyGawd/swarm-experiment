/** An authenticated statement made by an independently operated effect sink.
 *
 * The operator supplies the public anchor through a trusted channel. A valid
 * signature authenticates the sink's statement; it does not itself prove that
 * the sink atomically committed or fenced the external operation. The sink
 * service must make its decision durable and idempotent by execution/effect ID.
 */
import { createPrivateKey, createPublicKey, sign, verify, type KeyObject } from 'node:crypto';
import { decimal, encodeCanonical, exactObject, identifier, validateTaggedValue, type TaggedValueV1 } from './encoding.ts';
import { effectRequestDigest, validateEffectRequest, type EffectRequestV1 } from './effects.ts';
import { domainDigest, validateDigest, type Digest } from './identity.ts';

export const SINK_RECEIPT_LIMITS = Object.freeze({ maxFrameBytes: 64 * 1024,
  maxDecompressedBytes: 64 * 1024, maxObjects: 256, maxDepth: 16, maxIntegerDigits: 40 } as const);
const LIMITS = SINK_RECEIPT_LIMITS;
const SIGNATURE_DOMAIN = 'aether.sink-receipt-signature/1';

export interface SinkPublicAnchorV1 {
  readonly format: 'aether.sink-anchor/1';
  readonly repositoryId: string;
  readonly sinkAuthorityId: string;
  readonly sinkId: string;
  readonly keyId: string;
  readonly keyEpoch: string;
  /** Canonical base64 Ed25519 SPKI DER. The private key is never serialized here. */
  readonly publicKey: string;
}

export interface SinkReceiptBodyV1 {
  readonly format: 'aether.sink-receipt-body/1';
  readonly repositoryId: string;
  readonly deploymentId: string;
  readonly executionId: string;
  readonly effectId: string;
  readonly requestDigest: Digest;
  readonly payloadDigest: Digest;
  readonly sinkAuthorityId: string;
  readonly sinkId: string;
  readonly adapterArtifactDigest: Digest;
  readonly policyEpoch: string;
  readonly capabilityGrantRef: string;
  readonly keyId: string;
  readonly keyEpoch: string;
  /** `not_committed` means the sink has durably fenced every future commit. */
  readonly disposition: 'committed' | 'not_committed';
  readonly valueDigest: Digest | null;
  /** Unique durable decision identity, including for a terminal fence. */
  readonly decisionId: string;
  /** Non-null only for a committed external operation. */
  readonly commitId: string | null;
  /** Durable monotonic sink decision sequence; anti-rollback needs external custody. */
  readonly sinkSequence: string;
}

export interface SignedSinkReceiptV1 {
  readonly format: 'aether.sink-receipt/1';
  readonly body: SinkReceiptBodyV1;
  readonly signature: string;
}

/** Trusted, local expectations. Never derive them from the receipt being checked. */
export interface SinkReceiptExpectationV1 {
  readonly repositoryId: string;
  readonly deploymentId: string;
  readonly request: EffectRequestV1;
  readonly sinkAuthorityId: string;
  readonly sinkId: string;
  readonly adapterArtifactDigest: Digest;
  readonly disposition: SinkReceiptBodyV1['disposition'];
  readonly value: TaggedValueV1 | null;
}

function ed25519PublicKey(value: unknown): KeyObject {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length > 256) throw new TypeError('invalid sink public key');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value) throw new TypeError('noncanonical sink public key');
  const key = createPublicKey({ key: bytes, format: 'der', type: 'spki' });
  if (key.asymmetricKeyType !== 'ed25519') throw new TypeError('Ed25519 sink key required');
  if (!key.export({ format: 'der', type: 'spki' }).equals(bytes)) throw new TypeError('noncanonical sink SPKI key');
  return key;
}

function ed25519PrivateKey(value: KeyObject | string): KeyObject {
  const key = typeof value === 'string' ? createPrivateKey(value) : value;
  if (key.type !== 'private' || key.asymmetricKeyType !== 'ed25519') throw new TypeError('Ed25519 sink private key required');
  return key;
}

function canonicalSignature(value: unknown): Buffer {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(value)) throw new TypeError('invalid sink signature');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length !== 64 || bytes.toString('base64') !== value) throw new TypeError('noncanonical sink signature');
  return bytes;
}

function signingBytes(body: SinkReceiptBodyV1): Uint8Array {
  return encodeCanonical({ domain: SIGNATURE_DOMAIN, body }, LIMITS);
}

export function sinkValueDigest(value: TaggedValueV1): Digest {
  validateTaggedValue(value, LIMITS);
  return domainDigest('aether.sink-value/1', value, LIMITS);
}

export function validateSinkAdapterArtifactDigest(value: unknown): asserts value is Digest {
  validateDigest(value);
  if (!/^aether\.effect-adapter-artifact\/[1-9][0-9]*:b3:/.test(value as string))
    throw new TypeError('invalid effect adapter artifact digest');
}

export function validateSinkPublicAnchor(value: unknown): asserts value is SinkPublicAnchorV1 {
  encodeCanonical(value, LIMITS);
  const anchor = exactObject(value, ['format', 'repositoryId', 'sinkAuthorityId', 'sinkId', 'keyId', 'keyEpoch', 'publicKey']);
  if (anchor.format !== 'aether.sink-anchor/1') throw new TypeError('unsupported sink anchor');
  identifier(anchor.repositoryId); identifier(anchor.sinkAuthorityId); identifier(anchor.sinkId); identifier(anchor.keyId);
  decimal(anchor.keyEpoch, LIMITS); ed25519PublicKey(anchor.publicKey);
}

export function validateSinkReceiptBody(value: unknown): asserts value is SinkReceiptBodyV1 {
  encodeCanonical(value, LIMITS);
  const body = exactObject(value, [
    'format', 'repositoryId', 'deploymentId', 'executionId', 'effectId', 'requestDigest', 'payloadDigest',
    'sinkAuthorityId', 'sinkId', 'adapterArtifactDigest', 'policyEpoch', 'capabilityGrantRef',
    'keyId', 'keyEpoch', 'disposition', 'valueDigest', 'decisionId', 'commitId', 'sinkSequence',
  ]);
  if (body.format !== 'aether.sink-receipt-body/1') throw new TypeError('unsupported sink receipt body');
  for (const field of ['repositoryId', 'deploymentId', 'executionId', 'effectId', 'sinkAuthorityId', 'sinkId', 'capabilityGrantRef', 'keyId', 'decisionId'] as const) identifier(body[field]);
  validateDigest(body.requestDigest, 'aether.effect/1'); validateDigest(body.payloadDigest, 'aether.effect-payload/1');
  validateSinkAdapterArtifactDigest(body.adapterArtifactDigest);
  decimal(body.policyEpoch, LIMITS); decimal(body.keyEpoch, LIMITS); decimal(body.sinkSequence, LIMITS);
  if (body.sinkSequence === '0') throw new TypeError('sink sequence must be positive');
  if (body.disposition === 'committed') {
    validateDigest(body.valueDigest, 'aether.sink-value/1'); identifier(body.commitId);
  } else if (body.disposition === 'not_committed') {
    if (body.valueDigest !== null || body.commitId !== null) throw new TypeError('fenced noncommit cannot carry commit data');
  } else throw new TypeError('invalid sink disposition');
}

export function validateSignedSinkReceipt(value: unknown): asserts value is SignedSinkReceiptV1 {
  encodeCanonical(value, LIMITS);
  const receipt = exactObject(value, ['format', 'body', 'signature']);
  if (receipt.format !== 'aether.sink-receipt/1') throw new TypeError('unsupported sink receipt');
  validateSinkReceiptBody(receipt.body); canonicalSignature(receipt.signature);
}

/** The sink signs only after its own durable atomic decision. */
export function signSinkReceipt(body: SinkReceiptBodyV1, privateKey: KeyObject | string, anchor: SinkPublicAnchorV1): SignedSinkReceiptV1 {
  validateSinkReceiptBody(body); validateSinkPublicAnchor(anchor);
  if (body.repositoryId !== anchor.repositoryId || body.sinkAuthorityId !== anchor.sinkAuthorityId || body.sinkId !== anchor.sinkId || body.keyId !== anchor.keyId || body.keyEpoch !== anchor.keyEpoch) throw new TypeError('sink signer anchor context mismatch');
  const key = ed25519PrivateKey(privateKey);
  if (createPublicKey(key).export({ format: 'der', type: 'spki' }).toString('base64') !== anchor.publicKey) throw new TypeError('sink private key does not match anchor');
  return { format: 'aether.sink-receipt/1', body, signature: sign(null, signingBytes(body), key).toString('base64') };
}

/** Verifies a sink statement against an independently supplied anchor and
 * exact request/value expectations. Returns false for malformed or mismatched
 * evidence. The caller must retain the consumed decision/sequence against
 * replay and obtain the anchor from operator custody, not from the receipt. */
export function verifySinkReceipt(value: unknown, anchor: SinkPublicAnchorV1, expected: SinkReceiptExpectationV1): value is SignedSinkReceiptV1 {
  try {
    validateSignedSinkReceipt(value); validateSinkPublicAnchor(anchor);
    exactObject(expected, ['repositoryId', 'deploymentId', 'request', 'sinkAuthorityId', 'sinkId', 'adapterArtifactDigest', 'disposition', 'value']);
    identifier(expected.repositoryId); identifier(expected.deploymentId); identifier(expected.sinkAuthorityId); identifier(expected.sinkId);
    validateEffectRequest(expected.request, LIMITS); validateSinkAdapterArtifactDigest(expected.adapterArtifactDigest);
    if (expected.disposition !== 'committed' && expected.disposition !== 'not_committed') return false;
    if (expected.disposition === 'committed') validateTaggedValue(expected.value, LIMITS);
    else if (expected.value !== null) return false;
    const body = (value as SignedSinkReceiptV1).body;
    if (anchor.repositoryId !== expected.repositoryId || anchor.sinkAuthorityId !== expected.sinkAuthorityId || anchor.sinkId !== expected.sinkId ||
      body.repositoryId !== expected.repositoryId || body.deploymentId !== expected.deploymentId ||
      body.executionId !== expected.request.executionId || body.effectId !== expected.request.effectId ||
      body.requestDigest !== effectRequestDigest(expected.request, LIMITS) || body.payloadDigest !== expected.request.payloadDigest ||
      body.policyEpoch !== expected.request.policyEpoch || body.capabilityGrantRef !== expected.request.capabilityGrantRef ||
      body.sinkAuthorityId !== expected.sinkAuthorityId || body.sinkId !== expected.sinkId ||
      body.adapterArtifactDigest !== expected.adapterArtifactDigest || body.keyId !== anchor.keyId || body.keyEpoch !== anchor.keyEpoch ||
      body.disposition !== expected.disposition || body.valueDigest !== (expected.value === null ? null : sinkValueDigest(expected.value))) return false;
    return verify(null, signingBytes(body), ed25519PublicKey(anchor.publicKey), canonicalSignature((value as SignedSinkReceiptV1).signature));
  } catch { return false; }
}
