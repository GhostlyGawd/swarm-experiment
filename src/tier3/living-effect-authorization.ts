/** Versioned signed authority for isolated effectful living campaigns. */
import { createPrivateKey, createPublicKey, sign, verify, type KeyObject } from 'node:crypto';
import { encodeCanonical, exactObject, identifier, validateTaggedValue, type TaggedValueV1 } from '../fabric/encoding.ts';
import { executionManifestDigest, validateDigest, validateExecutionManifest, type Digest, type ExecutionManifestV1 } from '../fabric/identity.ts';
import { assertSignedEffectResourcePolicy, type SignedEffectResourcePolicyV1 } from '../tier2/effect-resource-policy.ts';
import type { CapabilityName } from '../tier1/ids.ts';

export interface LivingEffectResponseV2 { readonly capability: CapabilityName; readonly value: TaggedValueV1 }
export interface LivingEffectAuthorizationV2 {
  readonly format: 'aether.living-effect-authorization/2';
  readonly executionManifest: ExecutionManifestV1;
  readonly signedPolicy: SignedEffectResourcePolicyV1;
  readonly campaignDigest: Digest;
  readonly responses: readonly LivingEffectResponseV2[];
  readonly faultMode: 'none' | 'unknown-after-dispatch';
  readonly signer: string;
  readonly signature: string;
}
type Body = Omit<LivingEffectAuthorizationV2, 'signature'>;
function signedBytes(body: Body): Uint8Array {
  return encodeCanonical({ domain: 'aether.living-effect-authorization-signature/2', body });
}
function unsupportedResponse(value: TaggedValueV1): boolean {
  if (value.tag === 'ref' || value.tag === 'authority') return true;
  if (value.tag === 'sequence') return value.items.some(unsupportedResponse);
  if (value.tag === 'result') return unsupportedResponse(value.value);
  return false;
}
export function signLivingEffectAuthorizationV2(body: Body, key: KeyObject | string): LivingEffectAuthorizationV2 {
  const privateKey = typeof key === 'string' ? createPrivateKey(key) : key;
  if (privateKey.type !== 'private' || privateKey.asymmetricKeyType !== 'ed25519') throw new TypeError('Ed25519 campaign key required');
  return { ...body, signature: sign(null, signedBytes(body), privateKey).toString('base64') };
}
export function assertLivingEffectAuthorizationV2(value: unknown, expected: {
  readonly candidateRoot: Digest; readonly campaignDigest: Digest; readonly repositoryId: string;
  readonly policyEpoch: string; readonly signer: string; readonly key: KeyObject | string;
}): asserts value is LivingEffectAuthorizationV2 {
  encodeCanonical(value);
  const authorization = exactObject(value, ['format', 'executionManifest', 'signedPolicy', 'campaignDigest', 'responses', 'faultMode', 'signer', 'signature']);
  if (authorization.format !== 'aether.living-effect-authorization/2') throw new TypeError('unsupported effectful campaign authority');
  validateExecutionManifest(authorization.executionManifest);
  const manifest = authorization.executionManifest as ExecutionManifestV1;
  validateDigest(authorization.campaignDigest, 'aether.living-cooperative-campaign/1');
  if (manifest.astRoot !== expected.candidateRoot || authorization.campaignDigest !== expected.campaignDigest
    || manifest.specRoot !== expected.campaignDigest || manifest.semanticsVersion !== 'aether-reference/1'
    || manifest.target.abiVersion !== 'local/1' || manifest.dependencies.length !== 0)
    throw new TypeError('effectful campaign exact execution subject mismatch');
  assertSignedEffectResourcePolicy(authorization.signedPolicy, manifest, expected.repositoryId, expected.policyEpoch, expected.key);
  if (!Array.isArray(authorization.responses) || !authorization.responses.length || authorization.responses.length > 128)
    throw new TypeError('effectful campaign requires bounded responses');
  const rules = (authorization.signedPolicy as SignedEffectResourcePolicyV1).body.rules;
  if (rules.length !== authorization.responses.length) throw new TypeError('effect response/policy capability set mismatch');
  for (let index = 0; index < rules.length; index++) {
    const response = exactObject(authorization.responses[index], ['capability', 'value']);
    if (response.capability !== rules[index].capability) throw new TypeError('effect response/policy capability mismatch');
    validateTaggedValue(response.value);
    if (unsupportedResponse(response.value as TaggedValueV1))
      throw new TypeError('opaque/authority effect response unsupported by this campaign profile');
  }
  if (!['none', 'unknown-after-dispatch'].includes(String(authorization.faultMode))) throw new TypeError('unknown campaign effect fault mode');
  identifier(authorization.signer);
  if (authorization.signer !== expected.signer || typeof authorization.signature !== 'string'
    || !/^[A-Za-z0-9+/]{86}==$/.test(authorization.signature)) throw new TypeError('untrusted campaign signer');
  const signature = Buffer.from(authorization.signature as string, 'base64');
  const key = typeof expected.key === 'string' ? createPublicKey(expected.key) : expected.key.type === 'private' ? createPublicKey(expected.key) : expected.key;
  const { signature: _signature, ...body } = authorization as unknown as LivingEffectAuthorizationV2;
  if (key.asymmetricKeyType !== 'ed25519' || signature.toString('base64') !== authorization.signature
    || !verify(null, signedBytes(body), key, signature)) throw new TypeError('forged effectful campaign authorization');
  executionManifestDigest(manifest);
}
