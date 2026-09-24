/** Signed, deterministic resource extraction for strict external-effect grants.
 * A rule names one capability and optionally appends one string argument to a
 * fixed path. Unsupported payloads and missing rules fail before sink dispatch.
 */
import { createPrivateKey, createPublicKey, sign, verify, type KeyObject } from 'node:crypto';
import { encodeCanonical, exactObject, identifier, decimal, type TaggedValueV1 } from '../fabric/encoding.ts';
import { domainDigest, validateDigest, type Digest, type ExecutionManifestV1 } from '../fabric/identity.ts';
import { validateSinkAdapterArtifactDigest } from '../fabric/sink-receipt.ts';
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

/** Version 2 additionally binds the exact admitted adapter source artifact. */
export interface EffectResourceRuleV2 extends EffectResourceRuleV1 { readonly adapterArtifactDigest: Digest }
export interface EffectResourcePolicyBodyV2 {
  readonly format: 'aether.effect-resource-policy/2'; readonly repositoryId: string;
  readonly astRoot: Digest; readonly policyEpoch: string; readonly rules: readonly EffectResourceRuleV2[];
}
export interface SignedEffectResourcePolicyV2 { readonly format: 'aether.signed-effect-resource-policy/2'; readonly body: EffectResourcePolicyBodyV2; readonly signer: string; readonly signature: string }
export function validateEffectResourcePolicyBodyV2(value: unknown): asserts value is EffectResourcePolicyBodyV2 {
  encodeCanonical(value);
  const body = exactObject(value, ['format', 'repositoryId', 'astRoot', 'policyEpoch', 'rules']);
  if (body.format !== 'aether.effect-resource-policy/2' || !isNodeRef(body.astRoot)) throw new TypeError('invalid effect resource policy v2 subject');
  identifier(body.repositoryId); decimal(body.policyEpoch);
  if (!Array.isArray(body.rules) || body.rules.length < 1 || body.rules.length > 128) throw new TypeError('effect resource policy v2 requires bounded rules');
  let previous = '';
  for (const item of body.rules) {
    const rule = exactObject(item, ['capability', 'prefix', 'argument', 'adapterId', 'adapterDigest', 'adapterArtifactDigest']);
    capability(rule.capability as string); path(rule.prefix); identifier(rule.adapterId);
    validateDigest(rule.adapterDigest, 'aether.effect-adapter/1'); validateDigest(rule.adapterArtifactDigest, 'aether.effect-adapter-artifact/1');
    if ((rule.capability as string) <= previous || rule.argument !== null && (!Number.isSafeInteger(rule.argument) || (rule.argument as number) < 0 || (rule.argument as number) > 31)) throw new TypeError('noncanonical or invalid effect resource rule v2');
    previous = rule.capability as string;
  }
}
export function effectResourcePolicyDigestV2(body: EffectResourcePolicyBodyV2): Digest {
  validateEffectResourcePolicyBodyV2(body); return domainDigest('aether.effect-resource-policy/2', body);
}
function signingBytesV2(body: EffectResourcePolicyBodyV2, signer: string): Uint8Array {
  return encodeCanonical({ domain: 'aether.effect-resource-policy-signature/2', body, signer });
}
export function signEffectResourcePolicyV2(body: EffectResourcePolicyBodyV2, signer: string, key: KeyObject | string): SignedEffectResourcePolicyV2 {
  validateEffectResourcePolicyBodyV2(body); identifier(signer);
  const privateKey = typeof key === 'string' ? createPrivateKey(key) : key;
  if (privateKey.type !== 'private' || privateKey.asymmetricKeyType !== 'ed25519') throw new TypeError('Ed25519 policy signing key required');
  return { format: 'aether.signed-effect-resource-policy/2', body, signer, signature: sign(null, signingBytesV2(body, signer), privateKey).toString('base64') };
}
export function assertSignedEffectResourcePolicyV2(value: unknown, manifest: ExecutionManifestV1, repositoryId: string, currentEpoch: string, key: KeyObject | string): asserts value is SignedEffectResourcePolicyV2 {
  encodeCanonical(value); const policy = exactObject(value, ['format', 'body', 'signer', 'signature']);
  if (policy.format !== 'aether.signed-effect-resource-policy/2') throw new TypeError('unsupported signed effect resource policy v2');
  validateEffectResourcePolicyBodyV2(policy.body); identifier(policy.signer); identifier(repositoryId); decimal(currentEpoch);
  const body = policy.body as EffectResourcePolicyBodyV2;
  if (body.repositoryId !== repositoryId || body.astRoot !== manifest.astRoot || body.policyEpoch !== currentEpoch || effectResourcePolicyDigestV2(body) !== manifest.capabilityPolicyDigest) throw new Error('stale or foreign effect resource policy v2');
  if (typeof policy.signature !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(policy.signature)) throw new TypeError('invalid effect policy v2 signature');
  const signature = Buffer.from(policy.signature, 'base64'), publicKey = typeof key === 'string' ? createPublicKey(key) : key.type === 'private' ? createPublicKey(key) : key;
  if (publicKey.asymmetricKeyType !== 'ed25519' || signature.toString('base64') !== policy.signature || !verify(null, signingBytesV2(body, policy.signer as string), publicKey, signature)) throw new TypeError('untrusted effect resource policy v2 signer');
}
export function effectResourcePathV2(policy: SignedEffectResourcePolicyV2, name: CapabilityName, args: readonly TaggedValueV1[]): readonly string[] {
  validateEffectResourcePolicyBodyV2(policy.body); capability(name);
  const rule = policy.body.rules.find(item => item.capability === name);
  if (!rule) throw new Error('effect capability has no signed v2 resource rule');
  if (rule.argument === null) return [...rule.prefix];
  const value = args[rule.argument];
  if (!value || value.tag !== 'string' || !SEGMENT.test(value.value) || value.value === '.' || value.value === '..') throw new TypeError('effect target is outside signed resource grammar');
  return [...rule.prefix, value.value];
}
export function assertEffectResourceAdapterV2(policy: SignedEffectResourcePolicyV2, name: CapabilityName, actual: Readonly<{ id: string; digest: Digest; artifactDigest: Digest | null }>): void {
  validateEffectResourcePolicyBodyV2(policy.body); capability(name);
  const rule = policy.body.rules.find(item => item.capability === name);
  if (!rule || rule.adapterId !== actual.id || rule.adapterDigest !== actual.digest || rule.adapterArtifactDigest !== actual.artifactDigest) throw new Error('effect adapter artifact is outside signed resource policy v2');
}

/** Version 3 admits only import-free V2 adapter artifacts. Its body and
 * signature domains are independent of earlier policy versions. */
export interface EffectResourceRuleV3 extends EffectResourceRuleV2 {}
export interface EffectResourcePolicyBodyV3 {
  readonly format: 'aether.effect-resource-policy/3'; readonly repositoryId: string;
  readonly astRoot: Digest; readonly policyEpoch: string; readonly rules: readonly EffectResourceRuleV3[];
}
export interface SignedEffectResourcePolicyV3 { readonly format: 'aether.signed-effect-resource-policy/3'; readonly body: EffectResourcePolicyBodyV3; readonly signer: string; readonly signature: string }
export function validateEffectResourcePolicyBodyV3(value: unknown): asserts value is EffectResourcePolicyBodyV3 {
  encodeCanonical(value);
  const body = exactObject(value, ['format', 'repositoryId', 'astRoot', 'policyEpoch', 'rules']);
  if (body.format !== 'aether.effect-resource-policy/3' || !isNodeRef(body.astRoot)) throw new TypeError('invalid effect resource policy v3 subject');
  identifier(body.repositoryId); decimal(body.policyEpoch);
  if (!Array.isArray(body.rules) || body.rules.length < 1 || body.rules.length > 128) throw new TypeError('effect resource policy v3 requires bounded rules');
  let previous = '';
  for (const item of body.rules) {
    const rule = exactObject(item, ['capability', 'prefix', 'argument', 'adapterId', 'adapterDigest', 'adapterArtifactDigest']);
    capability(rule.capability as string); path(rule.prefix); identifier(rule.adapterId);
    validateDigest(rule.adapterDigest, 'aether.effect-adapter/1'); validateDigest(rule.adapterArtifactDigest, 'aether.effect-adapter-artifact/2');
    if ((rule.capability as string) <= previous || rule.argument !== null && (!Number.isSafeInteger(rule.argument) || (rule.argument as number) < 0 || (rule.argument as number) > 31)) throw new TypeError('noncanonical or invalid effect resource rule v3');
    previous = rule.capability as string;
  }
}
export function effectResourcePolicyDigestV3(body: EffectResourcePolicyBodyV3): Digest {
  validateEffectResourcePolicyBodyV3(body); return domainDigest('aether.effect-resource-policy/3', body);
}
function signingBytesV3(body: EffectResourcePolicyBodyV3, signer: string): Uint8Array {
  return encodeCanonical({ domain: 'aether.effect-resource-policy-signature/3', body, signer });
}
export function signEffectResourcePolicyV3(body: EffectResourcePolicyBodyV3, signer: string, key: KeyObject | string): SignedEffectResourcePolicyV3 {
  validateEffectResourcePolicyBodyV3(body); identifier(signer);
  const privateKey = typeof key === 'string' ? createPrivateKey(key) : key;
  if (privateKey.type !== 'private' || privateKey.asymmetricKeyType !== 'ed25519') throw new TypeError('Ed25519 policy signing key required');
  return { format: 'aether.signed-effect-resource-policy/3', body, signer, signature: sign(null, signingBytesV3(body, signer), privateKey).toString('base64') };
}
export function assertSignedEffectResourcePolicyV3(value: unknown, manifest: ExecutionManifestV1, repositoryId: string, currentEpoch: string, key: KeyObject | string): asserts value is SignedEffectResourcePolicyV3 {
  encodeCanonical(value); const policy = exactObject(value, ['format', 'body', 'signer', 'signature']);
  if (policy.format !== 'aether.signed-effect-resource-policy/3') throw new TypeError('unsupported signed effect resource policy v3');
  validateEffectResourcePolicyBodyV3(policy.body); identifier(policy.signer); identifier(repositoryId); decimal(currentEpoch);
  const body = policy.body as EffectResourcePolicyBodyV3;
  if (body.repositoryId !== repositoryId || body.astRoot !== manifest.astRoot || body.policyEpoch !== currentEpoch || effectResourcePolicyDigestV3(body) !== manifest.capabilityPolicyDigest) throw new Error('stale or foreign effect resource policy v3');
  if (typeof policy.signature !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(policy.signature)) throw new TypeError('invalid effect policy v3 signature');
  const signature = Buffer.from(policy.signature, 'base64'), publicKey = typeof key === 'string' ? createPublicKey(key) : key.type === 'private' ? createPublicKey(key) : key;
  if (publicKey.asymmetricKeyType !== 'ed25519' || signature.toString('base64') !== policy.signature || !verify(null, signingBytesV3(body, policy.signer as string), publicKey, signature)) throw new TypeError('untrusted effect resource policy v3 signer');
}
export function effectResourcePathV3(policy: SignedEffectResourcePolicyV3, name: CapabilityName, args: readonly TaggedValueV1[]): readonly string[] {
  validateEffectResourcePolicyBodyV3(policy.body); capability(name);
  const rule = policy.body.rules.find(item => item.capability === name);
  if (!rule) throw new Error('effect capability has no signed v3 resource rule');
  if (rule.argument === null) return [...rule.prefix];
  const value = args[rule.argument];
  if (!value || value.tag !== 'string' || !SEGMENT.test(value.value) || value.value === '.' || value.value === '..') throw new TypeError('effect target is outside signed resource grammar');
  return [...rule.prefix, value.value];
}
export function assertEffectResourceAdapterV3(policy: SignedEffectResourcePolicyV3, name: CapabilityName, actual: Readonly<{ id: string; digest: Digest; artifactDigest: Digest | null }>): void {
  validateEffectResourcePolicyBodyV3(policy.body); capability(name);
  const rule = policy.body.rules.find(item => item.capability === name);
  if (!rule || rule.adapterId !== actual.id || rule.adapterDigest !== actual.digest || rule.adapterArtifactDigest !== actual.artifactDigest) throw new Error('effect adapter artifact is outside signed resource policy v3');
}

/** V4 requires a separately executed, read-only Wasm i32 artifact for every
 * listed effect. The signed artifact digest includes its byte hash and limits. */
export interface EffectResourceRuleV4 extends EffectResourceRuleV2 { readonly deadline: string; readonly clockDomain: string }
export interface EffectResourcePolicyBodyV4 {
  readonly format: 'aether.effect-resource-policy/4'; readonly repositoryId: string;
  readonly astRoot: Digest; readonly policyEpoch: string; readonly rules: readonly EffectResourceRuleV4[];
}
export interface SignedEffectResourcePolicyV4 { readonly format: 'aether.signed-effect-resource-policy/4'; readonly body: EffectResourcePolicyBodyV4; readonly signer: string; readonly signature: string }
const WASM_READONLY_SEMANTICS = Object.freeze({ readOnly: true, atomicIdempotency: true, transactional: false, reconciliation: true });
export function validateEffectResourcePolicyBodyV4(value: unknown): asserts value is EffectResourcePolicyBodyV4 {
  encodeCanonical(value);
  const body = exactObject(value, ['format', 'repositoryId', 'astRoot', 'policyEpoch', 'rules']);
  if (body.format !== 'aether.effect-resource-policy/4' || !isNodeRef(body.astRoot)) throw new TypeError('invalid effect resource policy v4 subject');
  identifier(body.repositoryId); decimal(body.policyEpoch);
  if (!Array.isArray(body.rules) || body.rules.length < 1 || body.rules.length > 128) throw new TypeError('effect resource policy v4 requires bounded rules');
  let previous = '';
  for (const item of body.rules) {
    const rule = exactObject(item, ['capability', 'prefix', 'argument', 'adapterId', 'adapterDigest', 'adapterArtifactDigest', 'deadline', 'clockDomain']);
    capability(rule.capability as string); path(rule.prefix); identifier(rule.adapterId);
    validateDigest(rule.adapterDigest, 'aether.effect-adapter/1'); validateDigest(rule.adapterArtifactDigest, 'aether.effect-adapter-artifact/3');
    decimal(rule.deadline); identifier(rule.clockDomain);
    const expected = domainDigest('aether.effect-adapter/1', { id: rule.adapterId, semantics: WASM_READONLY_SEMANTICS });
    if (rule.adapterDigest !== expected) throw new TypeError('v4 policy requires isolated read-only Wasm adapter semantics');
    if ((rule.capability as string) <= previous || rule.argument !== null) throw new TypeError('v4 i32 adapter requires a fixed resource path');
    previous = rule.capability as string;
  }
}
export function effectResourcePolicyDigestV4(body: EffectResourcePolicyBodyV4): Digest {
  validateEffectResourcePolicyBodyV4(body); return domainDigest('aether.effect-resource-policy/4', body);
}
function signingBytesV4(body: EffectResourcePolicyBodyV4, signer: string): Uint8Array {
  return encodeCanonical({ domain: 'aether.effect-resource-policy-signature/4', body, signer });
}
export function signEffectResourcePolicyV4(body: EffectResourcePolicyBodyV4, signer: string, key: KeyObject | string): SignedEffectResourcePolicyV4 {
  validateEffectResourcePolicyBodyV4(body); identifier(signer);
  const privateKey = typeof key === 'string' ? createPrivateKey(key) : key;
  if (privateKey.type !== 'private' || privateKey.asymmetricKeyType !== 'ed25519') throw new TypeError('Ed25519 policy signing key required');
  return { format: 'aether.signed-effect-resource-policy/4', body, signer, signature: sign(null, signingBytesV4(body, signer), privateKey).toString('base64') };
}
export function assertSignedEffectResourcePolicyV4(value: unknown, manifest: ExecutionManifestV1, repositoryId: string, currentEpoch: string, key: KeyObject | string): asserts value is SignedEffectResourcePolicyV4 {
  encodeCanonical(value); const policy = exactObject(value, ['format', 'body', 'signer', 'signature']);
  if (policy.format !== 'aether.signed-effect-resource-policy/4') throw new TypeError('unsupported signed effect resource policy v4');
  validateEffectResourcePolicyBodyV4(policy.body); identifier(policy.signer); identifier(repositoryId); decimal(currentEpoch);
  const body = policy.body as EffectResourcePolicyBodyV4;
  if (body.repositoryId !== repositoryId || body.astRoot !== manifest.astRoot || body.policyEpoch !== currentEpoch || effectResourcePolicyDigestV4(body) !== manifest.capabilityPolicyDigest) throw new Error('stale or foreign effect resource policy v4');
  if (typeof policy.signature !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(policy.signature)) throw new TypeError('invalid effect policy v4 signature');
  const signature = Buffer.from(policy.signature, 'base64'), publicKey = typeof key === 'string' ? createPublicKey(key) : key.type === 'private' ? createPublicKey(key) : key;
  if (publicKey.asymmetricKeyType !== 'ed25519' || signature.toString('base64') !== policy.signature || !verify(null, signingBytesV4(body, policy.signer as string), publicKey, signature)) throw new TypeError('untrusted effect resource policy v4 signer');
}
export function effectResourcePathV4(policy: SignedEffectResourcePolicyV4, name: CapabilityName, args: readonly TaggedValueV1[]): readonly string[] {
  validateEffectResourcePolicyBodyV4(policy.body); capability(name);
  const rule = policy.body.rules.find(item => item.capability === name);
  if (!rule) throw new Error('effect capability has no signed v4 resource rule');
  if (rule.argument !== null) throw new TypeError('v4 i32 adapter requires a fixed resource path');
  void args;
  return [...rule.prefix];
}
export function assertEffectResourceAdapterV4(policy: SignedEffectResourcePolicyV4, name: CapabilityName, actual: Readonly<{ id: string; digest: Digest; artifactDigest: Digest | null; artifactCapability: CapabilityName | null }>): void {
  validateEffectResourcePolicyBodyV4(policy.body); capability(name);
  const rule = policy.body.rules.find(item => item.capability === name);
  if (!rule || rule.adapterId !== actual.id || rule.adapterDigest !== actual.digest || rule.adapterArtifactDigest !== actual.artifactDigest
    || actual.artifactCapability !== name) throw new Error('isolated Wasm adapter artifact is outside signed resource policy v4');
}

/** V5 admits a fixed-resource external write through an independently anchored
 * sink. Every rule binds the exact sink and witness identities used by the
 * broker, in addition to the adapter semantics and approved artifact. */
export interface EffectResourceRuleV5 extends EffectResourceRuleV4 {
  readonly deploymentId: string;
  readonly sinkAnchorDigest: Digest;
  readonly sinkStateWitnessDigest: Digest;
}
export interface EffectResourcePolicyBodyV5 {
  readonly format: 'aether.effect-resource-policy/5'; readonly repositoryId: string;
  readonly astRoot: Digest; readonly policyEpoch: string; readonly rules: readonly EffectResourceRuleV5[];
}
export interface SignedEffectResourcePolicyV5 {
  readonly format: 'aether.signed-effect-resource-policy/5'; readonly body: EffectResourcePolicyBodyV5;
  readonly signer: string; readonly signature: string;
}
const SINK_WRITE_SEMANTICS = Object.freeze({ readOnly: false, atomicIdempotency: true,
  transactional: false, reconciliation: true });

export function validateEffectResourcePolicyBodyV5(value: unknown): asserts value is EffectResourcePolicyBodyV5 {
  encodeCanonical(value);
  const body = exactObject(value, ['format', 'repositoryId', 'astRoot', 'policyEpoch', 'rules']);
  if (body.format !== 'aether.effect-resource-policy/5' || !isNodeRef(body.astRoot))
    throw new TypeError('invalid effect resource policy v5 subject');
  identifier(body.repositoryId); decimal(body.policyEpoch);
  if (!Array.isArray(body.rules) || body.rules.length < 1 || body.rules.length > 128)
    throw new TypeError('effect resource policy v5 requires bounded rules');
  let previous = '';
  for (const item of body.rules) {
    const rule = exactObject(item, ['capability', 'prefix', 'argument', 'adapterId', 'adapterDigest',
      'adapterArtifactDigest', 'deadline', 'clockDomain', 'deploymentId', 'sinkAnchorDigest',
      'sinkStateWitnessDigest']);
    capability(rule.capability as string); path(rule.prefix); identifier(rule.adapterId);
    validateDigest(rule.adapterDigest, 'aether.effect-adapter/1');
    validateSinkAdapterArtifactDigest(rule.adapterArtifactDigest);
    decimal(rule.deadline); identifier(rule.clockDomain); identifier(rule.deploymentId);
    validateDigest(rule.sinkAnchorDigest, 'aether.sink-anchor/1');
    validateDigest(rule.sinkStateWitnessDigest, 'aether.sink-state-witness/1');
    const expected = domainDigest('aether.effect-adapter/1', { id: rule.adapterId,
      semantics: SINK_WRITE_SEMANTICS });
    if (rule.adapterDigest !== expected) throw new TypeError('v5 policy requires exact idempotent sink write semantics');
    if ((rule.capability as string) <= previous || rule.argument !== null)
      throw new TypeError('v5 sink adapter requires a sorted fixed resource path');
    previous = rule.capability as string;
  }
}
export function effectResourcePolicyDigestV5(body: EffectResourcePolicyBodyV5): Digest {
  validateEffectResourcePolicyBodyV5(body);
  return domainDigest('aether.effect-resource-policy/5', body);
}
function signingBytesV5(body: EffectResourcePolicyBodyV5, signer: string): Uint8Array {
  return encodeCanonical({ domain: 'aether.effect-resource-policy-signature/5', body, signer });
}
export function signEffectResourcePolicyV5(body: EffectResourcePolicyBodyV5, signer: string,
  key: KeyObject | string): SignedEffectResourcePolicyV5 {
  validateEffectResourcePolicyBodyV5(body); identifier(signer);
  const privateKey = typeof key === 'string' ? createPrivateKey(key) : key;
  if (privateKey.type !== 'private' || privateKey.asymmetricKeyType !== 'ed25519')
    throw new TypeError('Ed25519 policy signing key required');
  return { format: 'aether.signed-effect-resource-policy/5', body, signer,
    signature: sign(null, signingBytesV5(body, signer), privateKey).toString('base64') };
}
export function assertSignedEffectResourcePolicyV5(value: unknown, manifest: ExecutionManifestV1,
  repositoryId: string, currentEpoch: string, key: KeyObject | string): asserts value is SignedEffectResourcePolicyV5 {
  encodeCanonical(value);
  const policy = exactObject(value, ['format', 'body', 'signer', 'signature']);
  if (policy.format !== 'aether.signed-effect-resource-policy/5')
    throw new TypeError('unsupported signed effect resource policy v5');
  validateEffectResourcePolicyBodyV5(policy.body); identifier(policy.signer);
  identifier(repositoryId); decimal(currentEpoch);
  const body = policy.body as EffectResourcePolicyBodyV5;
  if (body.repositoryId !== repositoryId || body.astRoot !== manifest.astRoot
    || body.policyEpoch !== currentEpoch || effectResourcePolicyDigestV5(body) !== manifest.capabilityPolicyDigest)
    throw new Error('stale or foreign effect resource policy v5');
  if (typeof policy.signature !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(policy.signature))
    throw new TypeError('invalid effect policy v5 signature');
  const signature = Buffer.from(policy.signature, 'base64');
  const publicKey = typeof key === 'string' ? createPublicKey(key)
    : key.type === 'private' ? createPublicKey(key) : key;
  if (publicKey.asymmetricKeyType !== 'ed25519' || signature.toString('base64') !== policy.signature
    || !verify(null, signingBytesV5(body, policy.signer as string), publicKey, signature))
    throw new TypeError('untrusted effect resource policy v5 signer');
}
export function effectResourcePathV5(policy: SignedEffectResourcePolicyV5, name: CapabilityName,
  args: readonly TaggedValueV1[]): readonly string[] {
  validateEffectResourcePolicyBodyV5(policy.body); capability(name);
  const rule = policy.body.rules.find(item => item.capability === name);
  if (!rule) throw new Error('effect capability has no signed v5 resource rule');
  void args;
  return [...rule.prefix];
}
export function assertEffectResourceAdapterV5(policy: SignedEffectResourcePolicyV5, name: CapabilityName,
  actual: Readonly<{ id: string; digest: Digest; artifactDigest: Digest | null }>): void {
  validateEffectResourcePolicyBodyV5(policy.body); capability(name);
  const rule = policy.body.rules.find(item => item.capability === name);
  if (!rule || rule.adapterId !== actual.id || rule.adapterDigest !== actual.digest
    || rule.adapterArtifactDigest !== actual.artifactDigest)
    throw new Error('attested sink adapter is outside signed resource policy v5');
}
export function assertEffectResourceSinkContextV5(policy: SignedEffectResourcePolicyV5,
  name: CapabilityName, actual: Readonly<{ deploymentId: string; sinkAnchorDigest: Digest;
    sinkStateWitnessDigest: Digest; approvedAdapterArtifactDigest: Digest }>): void {
  validateEffectResourcePolicyBodyV5(policy.body); capability(name);
  const rule = policy.body.rules.find(item => item.capability === name);
  if (!rule || rule.deploymentId !== actual.deploymentId
    || rule.sinkAnchorDigest !== actual.sinkAnchorDigest
    || rule.sinkStateWitnessDigest !== actual.sinkStateWitnessDigest
    || rule.adapterArtifactDigest !== actual.approvedAdapterArtifactDigest)
    throw new Error('attested sink context is outside signed resource policy v5');
}
