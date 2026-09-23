/** Independently provisioned trust root for signed external-effect policies.
 *
 * A deployment factory may supply policy bytes and adapters, but never this
 * signer key or epoch reader. The caller must provision them from an authority
 * outside the reloadable artifact/factory and protect the epoch against rollback.
 */
import { createPublicKey, KeyObject } from 'node:crypto';
import { decimal, identifier } from '../fabric/encoding.ts';
import { domainDigest, type Digest, type ExecutionManifestV1 } from '../fabric/identity.ts';
import { assertSignedEffectResourcePolicyV2, type SignedEffectResourcePolicyV2 } from './effect-resource-policy.ts';

const created = new WeakSet<object>();

export interface EffectSignerAnchor {
  readonly format: 'aether.effect-signer-anchor/1';
  readonly repositoryId: string;
  readonly signer: string;
  /** Stable identity of the operator-controlled monotonic epoch authority. */
  readonly epochAuthorityId: string;
  readonly publicKeySpki: string;
  readonly digest: Digest;
  /** Copied Ed25519 public key; factories cannot nominate a replacement. */
  readonly publicKey: KeyObject;
  /** Current policy epoch from an independently trusted, rollback-protected source. */
  readonly currentEpoch: () => string;
}

export function createEffectSignerAnchor(options: Readonly<{
  repositoryId: string; signer: string; epochAuthorityId: string; publicKey: KeyObject | string; currentEpoch: () => string;
}>): EffectSignerAnchor {
  identifier(options.repositoryId); identifier(options.signer); identifier(options.epochAuthorityId);
  if (typeof options.currentEpoch !== 'function') throw new TypeError('independent effect policy epoch source required');
  const supplied = typeof options.publicKey === 'string' ? createPublicKey(options.publicKey) : options.publicKey;
  if (!(supplied instanceof KeyObject) || supplied.type !== 'public' || supplied.asymmetricKeyType !== 'ed25519') throw new TypeError('independent Ed25519 public key required');
  const publicKey = createPublicKey({ key: supplied.export({ format: 'der', type: 'spki' }), format: 'der', type: 'spki' });
  const publicKeySpki = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  const digest = domainDigest('aether.effect-signer-anchor/1', {
    format: 'aether.effect-signer-anchor/1', repositoryId: options.repositoryId, signer: options.signer,
    epochAuthorityId: options.epochAuthorityId, publicKeySpki,
  });
  const currentEpoch = (): string => { const value = options.currentEpoch(); decimal(value); return value; };
  currentEpoch();
  const anchor = Object.freeze({ format: 'aether.effect-signer-anchor/1' as const,
    repositoryId: options.repositoryId, signer: options.signer, epochAuthorityId: options.epochAuthorityId,
    publicKeySpki, digest, publicKey, currentEpoch });
  created.add(anchor);
  return anchor;
}

export function assertEffectSignerAnchor(value: unknown): asserts value is EffectSignerAnchor {
  if (!value || typeof value !== 'object' || !created.has(value)) throw new TypeError('independently provisioned effect signer anchor required');
  const anchor = value as EffectSignerAnchor;
  if (anchor.format !== 'aether.effect-signer-anchor/1' || anchor.currentEpoch() === undefined) throw new TypeError('invalid effect signer anchor');
}

export function assertAnchoredEffectPolicy(anchor: EffectSignerAnchor, policy: SignedEffectResourcePolicyV2,
  manifest: ExecutionManifestV1, repositoryId: string): void {
  assertEffectSignerAnchor(anchor);
  if (repositoryId !== anchor.repositoryId || policy?.signer !== anchor.signer) throw new TypeError('effect policy signer/repository differs from independent anchor');
  assertSignedEffectResourcePolicyV2(policy, manifest, anchor.repositoryId, anchor.currentEpoch(), anchor.publicKey);
}
