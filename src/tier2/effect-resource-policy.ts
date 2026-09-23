/** Signed, deterministic resource extraction for strict external-effect grants.
 * A rule names one capability and optionally appends one string argument to a
 * fixed path. Unsupported payloads and missing rules fail before sink dispatch.
 */
import { createPrivateKey, createPublicKey, sign, verify, type KeyObject } from 'node:crypto';
import { encodeCanonical, exactObject, identifier, decimal, type TaggedValueV1 } from '../fabric/encoding.ts';
import { domainDigest, validateDigest, type Digest, type ExecutionManifestV1 } from '../fabric/identity.ts';
import { capability, isNodeRef, type CapabilityName } from '../tier1/ids.ts';

export interface EffectResourceRuleV1 { readonly capability: CapabilityName; readonly prefix: readonly string[]; readonly argument: number | null; readonly adapterId: string; readonly adapterDigest: Digest }
export interface EffectResourcePolicyBodyV1 {
  readonly format: 'aether.effect-resource-policy/1'; readonly repositoryId: string;
  readonly astRoot: Digest; readonly policyEpoch: string; readonly rules: readonly EffectResourceRuleV1[];
}
export interface SignedEffectResourcePolicyV1 { readonly format: 'aether.signed-effect-resource-policy/1'; readonly body: EffectResourcePolicyBodyV1; readonly signer: string; readonly signature: string }
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
function path(value: unknown): asserts value is readonly string[] {
  // ProcessHost prepends four authority components; one argument may follow.
  if (!Array.isArray(value) || value.length > 27 || value.some(item => typeof item !== 'string' || !SEGMENT.test(item) || item === '.' || item === '..')) throw new TypeError('invalid effect resource path');
}
export function validateEffectResourcePolicyBody(value: unknown): asserts value is EffectResourcePolicyBodyV1 {
  encodeCanonical(value);
  const body = exactObject(value, ['format', 'repositoryId', 'astRoot', 'policyEpoch', 'rules']);
  if (body.format !== 'aether.effect-resource-policy/1' || !isNodeRef(body.astRoot)) throw new TypeError('invalid effect resource policy subject');
  identifier(body.repositoryId); decimal(body.policyEpoch);
  if (!Array.isArray(body.rules) || body.rules.length < 1 || body.rules.length > 128) throw new TypeError('effect resource policy requires bounded rules');
  let previous = '';
  for (const item of body.rules) {
    const rule = exactObject(item, ['capability', 'prefix', 'argument', 'adapterId', 'adapterDigest']); capability(rule.capability as string); path(rule.prefix);
    identifier(rule.adapterId); validateDigest(rule.adapterDigest, 'aether.effect-adapter/1');
    if ((rule.capability as string) <= previous || rule.argument !== null && (!Number.isSafeInteger(rule.argument) || (rule.argument as number) < 0 || (rule.argument as number) > 31)) throw new TypeError('noncanonical or invalid effect resource rule');
    previous = rule.capability as string;
  }
}
export function effectResourcePolicyDigest(body: EffectResourcePolicyBodyV1): Digest {
  validateEffectResourcePolicyBody(body); return domainDigest('aether.effect-resource-policy/1', body);
}
function signingBytes(body: EffectResourcePolicyBodyV1, signer: string): Uint8Array {
  return encodeCanonical({ domain: 'aether.effect-resource-policy-signature/1', body, signer });
}
export function signEffectResourcePolicy(body: EffectResourcePolicyBodyV1, signer: string, key: KeyObject | string): SignedEffectResourcePolicyV1 {
  validateEffectResourcePolicyBody(body); identifier(signer);
  const privateKey = typeof key === 'string' ? createPrivateKey(key) : key;
  if (privateKey.type !== 'private' || privateKey.asymmetricKeyType !== 'ed25519') throw new TypeError('Ed25519 policy signing key required');
  return { format: 'aether.signed-effect-resource-policy/1', body, signer, signature: sign(null, signingBytes(body, signer), privateKey).toString('base64') };
}
export function assertSignedEffectResourcePolicy(value: unknown, manifest: ExecutionManifestV1, repositoryId: string, currentEpoch: string, key: KeyObject | string): asserts value is SignedEffectResourcePolicyV1 {
  encodeCanonical(value); const policy = exactObject(value, ['format', 'body', 'signer', 'signature']);
  if (policy.format !== 'aether.signed-effect-resource-policy/1') throw new TypeError('unsupported signed effect resource policy');
  validateEffectResourcePolicyBody(policy.body); identifier(policy.signer); identifier(repositoryId); decimal(currentEpoch);
  const body = policy.body as EffectResourcePolicyBodyV1;
  if (body.repositoryId !== repositoryId || body.astRoot !== manifest.astRoot || body.policyEpoch !== currentEpoch || effectResourcePolicyDigest(body) !== manifest.capabilityPolicyDigest) throw new Error('stale or foreign effect resource policy');
  if (typeof policy.signature !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(policy.signature)) throw new TypeError('invalid effect policy signature');
  const signature = Buffer.from(policy.signature, 'base64'), publicKey = typeof key === 'string' ? createPublicKey(key) : key.type === 'private' ? createPublicKey(key) : key;
  if (publicKey.asymmetricKeyType !== 'ed25519' || signature.toString('base64') !== policy.signature || !verify(null, signingBytes(body, policy.signer as string), publicKey, signature)) throw new TypeError('untrusted effect resource policy signer');
}
export function effectResourcePath(policy: SignedEffectResourcePolicyV1, name: CapabilityName, args: readonly TaggedValueV1[]): readonly string[] {
  validateEffectResourcePolicyBody(policy.body); capability(name);
  const rule = policy.body.rules.find(item => item.capability === name);
  if (!rule) throw new Error('effect capability has no signed resource rule');
  if (rule.argument === null) return [...rule.prefix];
  const value = args[rule.argument];
  if (!value || value.tag !== 'string' || !SEGMENT.test(value.value) || value.value === '.' || value.value === '..') throw new TypeError('effect target is outside signed resource grammar');
  return [...rule.prefix, value.value];
}
export function assertEffectResourceAdapter(policy: SignedEffectResourcePolicyV1, name: CapabilityName, actual: Readonly<{ id: string; digest: Digest }>): void {
  validateEffectResourcePolicyBody(policy.body); capability(name);
  const rule = policy.body.rules.find(item => item.capability === name);
  if (!rule || rule.adapterId !== actual.id || rule.adapterDigest !== actual.digest) throw new Error('effect adapter is outside signed resource policy');
}
