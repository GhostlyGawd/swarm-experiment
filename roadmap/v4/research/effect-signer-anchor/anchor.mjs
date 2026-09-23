/** Research-only trust boundary. The public key and epoch reader must come from
 * deployment authority outside the reloadable ProcessHostServices factory. */
import { createPublicKey, KeyObject } from 'node:crypto';
import { identifier, decimal } from '../../../../src/fabric/encoding.ts';
import { domainDigest } from '../../../../src/fabric/identity.ts';
import { assertSignedEffectResourcePolicyV2 } from '../../../../src/tier2/effect-resource-policy.ts';

function pinnedPublicKey(key) {
  const value = typeof key === 'string' ? createPublicKey(key) : key;
  if (!(value instanceof KeyObject) || value.type !== 'public' || value.asymmetricKeyType !== 'ed25519') throw new TypeError('external Ed25519 public key required');
  // Copy the bytes now. The factory never supplies or resolves this key.
  return createPublicKey({ key: value.export({ format: 'der', type: 'spki' }), format: 'der', type: 'spki' });
}

export function createEffectSignerAnchor({ repositoryId, signer, publicKey, currentEpoch }) {
  identifier(repositoryId); identifier(signer);
  if (typeof currentEpoch !== 'function') throw new TypeError('independent policy epoch reader required');
  const key = pinnedPublicKey(publicKey);
  const keySpki = key.export({ format: 'der', type: 'spki' }).toString('base64');
  const identity = Object.freeze({ format: 'aether.effect-signer-anchor/1', repositoryId, signer, keySpki });
  const digest = domainDigest('aether.effect-signer-anchor/1', identity);
  const epoch = () => { const value = currentEpoch(); decimal(value); return value; };
  epoch();
  return Object.freeze({ identity, digest, key, epoch });
}

export function assertPinnedEffectService(anchor, manifest, services, expectedAnchorDigest) {
  if (!anchor || expectedAnchorDigest !== anchor.digest) throw new Error('missing or changed independent effect signer anchor');
  if (services.effectResourceSignerKey !== undefined || services.currentEffectPolicyEpoch !== undefined)
    throw new Error('factory must not supply effect signer trust or policy epoch');
  if (services.scopedGrants?.repositoryId !== anchor.identity.repositoryId)
    throw new Error('effect grant repository differs from pinned signer repository');
  const policy = services.signedEffectResourcePolicy;
  if (policy?.format !== 'aether.signed-effect-resource-policy/2' || policy.signer !== anchor.identity.signer)
    throw new Error('policy signer differs from independent trust anchor');
  // Existing verifier checks exact AST root, manifest policy digest, repository,
  // current policy epoch, Ed25519 signature, and canonical base64 encoding.
  assertSignedEffectResourcePolicyV2(policy, manifest, anchor.identity.repositoryId, anchor.epoch(), anchor.key);
  const admitted = { ...services, effectResourceSignerKey: anchor.key, currentEffectPolicyEpoch: anchor.epoch };
  return Object.freeze(admitted);
}

export function assertPinnedAnchorRecord(record, anchor) {
  if (!record || record.effectSignerAnchorDigest !== anchor.digest) throw new Error('durable effect signer anchor mismatch');
  // The digest is an identity comparison, not a substitute for the external pin.
  return true;
}
