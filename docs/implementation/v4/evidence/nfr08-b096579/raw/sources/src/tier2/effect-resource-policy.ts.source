/** Signed, deterministic resource extraction for strict external-effect grants.
 * A rule names one capability and optionally appends one string argument to a
 * fixed path. Unsupported payloads and missing rules fail before sink dispatch.
 */
import { createPrivateKey, createPublicKey, sign, verify, type KeyObject } from 'node:crypto';
import { types as nodeTypes } from 'node:util';
import { encodeCanonical, exactObject, identifier, decimal, validateTaggedValue, type TaggedValueV1 } from '../fabric/encoding.ts';
import { domainDigest, validateDigest, type Digest, type ExecutionManifestV1 } from '../fabric/identity.ts';
import { validateSinkAdapterArtifactDigest } from '../fabric/sink-receipt.ts';
import { capability, isNodeRef, type CapabilityName } from '../tier1/ids.ts';
import { walk, type Term } from '../tier1/ast.ts';
import { GraphStore } from '../tier1/store.ts';

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

/** V6 retains V5's external write and sink binding, while permitting exactly
 * one path segment selected from a bounded tagged string argument. */
export interface EffectResourceRuleV6 extends EffectResourceRuleV5 {}
export interface EffectResourcePolicyBodyV6 {
  readonly format: 'aether.effect-resource-policy/6'; readonly repositoryId: string;
  readonly astRoot: Digest; readonly policyEpoch: string; readonly rules: readonly EffectResourceRuleV6[];
}
export interface SignedEffectResourcePolicyV6 {
  readonly format: 'aether.signed-effect-resource-policy/6'; readonly body: EffectResourcePolicyBodyV6;
  readonly signer: string; readonly signature: string;
}
export function validateEffectResourcePolicyBodyV6(value: unknown): asserts value is EffectResourcePolicyBodyV6 {
  encodeCanonical(value);
  const body = exactObject(value, ['format', 'repositoryId', 'astRoot', 'policyEpoch', 'rules']);
  if (body.format !== 'aether.effect-resource-policy/6' || !isNodeRef(body.astRoot))
    throw new TypeError('invalid effect resource policy v6 subject');
  identifier(body.repositoryId); decimal(body.policyEpoch);
  if (!Array.isArray(body.rules) || body.rules.length < 1 || body.rules.length > 128)
    throw new TypeError('effect resource policy v6 requires bounded rules');
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
    if (rule.adapterDigest !== expected) throw new TypeError('v6 policy requires exact idempotent sink write semantics');
    if ((rule.capability as string) <= previous || rule.argument !== null
      && (!Number.isSafeInteger(rule.argument) || (rule.argument as number) < 0 || (rule.argument as number) > 31))
      throw new TypeError('v6 sink adapter requires sorted rules and bounded argument index');
    previous = rule.capability as string;
  }
}
export function effectResourcePolicyDigestV6(body: EffectResourcePolicyBodyV6): Digest {
  validateEffectResourcePolicyBodyV6(body);
  return domainDigest('aether.effect-resource-policy/6', body);
}
function signingBytesV6(body: EffectResourcePolicyBodyV6, signer: string): Uint8Array {
  return encodeCanonical({ domain: 'aether.effect-resource-policy-signature/6', body, signer });
}
export function signEffectResourcePolicyV6(body: EffectResourcePolicyBodyV6, signer: string,
  key: KeyObject | string): SignedEffectResourcePolicyV6 {
  validateEffectResourcePolicyBodyV6(body); identifier(signer);
  const privateKey = typeof key === 'string' ? createPrivateKey(key) : key;
  if (privateKey.type !== 'private' || privateKey.asymmetricKeyType !== 'ed25519')
    throw new TypeError('Ed25519 policy signing key required');
  return { format: 'aether.signed-effect-resource-policy/6', body, signer,
    signature: sign(null, signingBytesV6(body, signer), privateKey).toString('base64') };
}
export function assertSignedEffectResourcePolicyV6(value: unknown, manifest: ExecutionManifestV1,
  repositoryId: string, currentEpoch: string, key: KeyObject | string): asserts value is SignedEffectResourcePolicyV6 {
  encodeCanonical(value);
  const policy = exactObject(value, ['format', 'body', 'signer', 'signature']);
  if (policy.format !== 'aether.signed-effect-resource-policy/6')
    throw new TypeError('unsupported signed effect resource policy v6');
  validateEffectResourcePolicyBodyV6(policy.body); identifier(policy.signer);
  identifier(repositoryId); decimal(currentEpoch);
  const body = policy.body as EffectResourcePolicyBodyV6;
  if (body.repositoryId !== repositoryId || body.astRoot !== manifest.astRoot
    || body.policyEpoch !== currentEpoch || effectResourcePolicyDigestV6(body) !== manifest.capabilityPolicyDigest)
    throw new Error('stale or foreign effect resource policy v6');
  if (typeof policy.signature !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(policy.signature))
    throw new TypeError('invalid effect policy v6 signature');
  const signature = Buffer.from(policy.signature, 'base64');
  const publicKey = typeof key === 'string' ? createPublicKey(key)
    : key.type === 'private' ? createPublicKey(key) : key;
  if (publicKey.asymmetricKeyType !== 'ed25519' || signature.toString('base64') !== policy.signature
    || !verify(null, signingBytesV6(body, policy.signer as string), publicKey, signature))
    throw new TypeError('untrusted effect resource policy v6 signer');
}
export function effectResourcePathV6(policy: SignedEffectResourcePolicyV6, name: CapabilityName,
  args: readonly TaggedValueV1[]): readonly string[] {
  validateEffectResourcePolicyBodyV6(policy.body); capability(name);
  const rule = policy.body.rules.find(item => item.capability === name);
  if (!rule) throw new Error('effect capability has no signed v6 resource rule');
  if (rule.argument === null) return [...rule.prefix];
  if (nodeTypes.isProxy(args) || !Array.isArray(args))
    throw new TypeError('effect target arguments must be an ordinary tagged array');
  const selected = Object.getOwnPropertyDescriptor(args, String(rule.argument));
  if (!selected) throw new TypeError('missing signed effect target argument');
  if (!('value' in selected)) throw new TypeError('effect target argument accessor forbidden');
  const value = selected.value as TaggedValueV1;
  validateTaggedValue(value);
  if (value.tag !== 'string' || !SEGMENT.test(value.value) || value.value === '.' || value.value === '..')
    throw new TypeError('effect target is outside signed resource grammar');
  return [...rule.prefix, value.value];
}
export function assertEffectResourceAdapterV6(policy: SignedEffectResourcePolicyV6, name: CapabilityName,
  actual: Readonly<{ id: string; digest: Digest; artifactDigest: Digest | null }>): void {
  validateEffectResourcePolicyBodyV6(policy.body); capability(name);
  const rule = policy.body.rules.find(item => item.capability === name);
  if (!rule || rule.adapterId !== actual.id || rule.adapterDigest !== actual.digest
    || rule.adapterArtifactDigest !== actual.artifactDigest)
    throw new Error('attested sink adapter is outside signed resource policy v6');
}
export function assertEffectResourceSinkContextV6(policy: SignedEffectResourcePolicyV6,
  name: CapabilityName, actual: Readonly<{ deploymentId: string; sinkAnchorDigest: Digest;
    sinkStateWitnessDigest: Digest; approvedAdapterArtifactDigest: Digest }>): void {
  validateEffectResourcePolicyBodyV6(policy.body); capability(name);
  const rule = policy.body.rules.find(item => item.capability === name);
  if (!rule || rule.deploymentId !== actual.deploymentId
    || rule.sinkAnchorDigest !== actual.sinkAnchorDigest
    || rule.sinkStateWitnessDigest !== actual.sinkStateWitnessDigest
    || rule.adapterArtifactDigest !== actual.approvedAdapterArtifactDigest)
    throw new Error('attested sink context is outside signed resource policy v6');
}

/** V7 signs the complete production adapter table alongside the V6 sink
 * rules. An empty table/policy is admissible only for an independently checked
 * module containing no Invoke node, including unreachable declarations. */
export interface EffectResourceRuleV7 extends EffectResourceRuleV6 {}
export interface EffectResourcePolicyBodyV7 {
  readonly format: 'aether.effect-resource-policy/7'; readonly repositoryId: string;
  readonly astRoot: Digest; readonly policyEpoch: string;
  readonly adapterTableDigest: Digest; readonly rules: readonly EffectResourceRuleV7[];
}
export interface SignedEffectResourcePolicyV7 {
  readonly format: 'aether.signed-effect-resource-policy/7'; readonly body: EffectResourcePolicyBodyV7;
  readonly signer: string; readonly signature: string;
}
function assertEmptyEffectModuleV7(module: Term | undefined, root: Digest): void {
  if (!module || module.kind !== 'Module')
    throw new TypeError('empty v7 effect policy requires an independently checked AST module');
  // Clone before inspecting both the root and the whole tree so a caller cannot
  // mutate one traversal independently of the other.
  const checked = structuredClone(module);
  if (new GraphStore().intern(checked) !== root)
    throw new TypeError('empty v7 effect policy AST root mismatch');
  let count = 0;
  for (const node of walk(checked)) {
    if (++count > 100_000) throw new RangeError('empty v7 effect policy AST bound');
    if (node.kind === 'Invoke') throw new TypeError('empty v7 effect policy cannot admit Invoke');
  }
}
export function validateEffectResourcePolicyBodyV7(value: unknown, module?: Term): asserts value is EffectResourcePolicyBodyV7 {
  encodeCanonical(value);
  const body = exactObject(value, ['format', 'repositoryId', 'astRoot', 'policyEpoch', 'adapterTableDigest', 'rules']);
  if (body.format !== 'aether.effect-resource-policy/7' || !isNodeRef(body.astRoot))
    throw new TypeError('invalid effect resource policy v7 subject');
  identifier(body.repositoryId); decimal(body.policyEpoch);
  validateDigest(body.adapterTableDigest, 'aether.declarative-adapter-table/2');
  if (!Array.isArray(body.rules) || body.rules.length > 128)
    throw new TypeError('effect resource policy v7 requires bounded rules');
  if (body.rules.length === 0) assertEmptyEffectModuleV7(module, body.astRoot as Digest);
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
    if (rule.adapterDigest !== expected) throw new TypeError('v7 policy requires exact idempotent sink write semantics');
    if ((rule.capability as string) <= previous || rule.argument !== null
      && (!Number.isSafeInteger(rule.argument) || (rule.argument as number) < 0 || (rule.argument as number) > 31))
      throw new TypeError('v7 sink adapter requires sorted rules and bounded argument index');
    previous = rule.capability as string;
  }
}
export function effectResourcePolicyDigestV7(body: EffectResourcePolicyBodyV7, module?: Term): Digest {
  validateEffectResourcePolicyBodyV7(body, module);
  return domainDigest('aether.effect-resource-policy/7', body);
}
function signingBytesV7(body: EffectResourcePolicyBodyV7, signer: string): Uint8Array {
  return encodeCanonical({ domain: 'aether.effect-resource-policy-signature/7', body, signer });
}
export function signEffectResourcePolicyV7(body: EffectResourcePolicyBodyV7, signer: string,
  key: KeyObject | string, module?: Term): SignedEffectResourcePolicyV7 {
  validateEffectResourcePolicyBodyV7(body, module); identifier(signer);
  const privateKey = typeof key === 'string' ? createPrivateKey(key) : key;
  if (privateKey.type !== 'private' || privateKey.asymmetricKeyType !== 'ed25519')
    throw new TypeError('Ed25519 policy signing key required');
  return { format: 'aether.signed-effect-resource-policy/7', body, signer,
    signature: sign(null, signingBytesV7(body, signer), privateKey).toString('base64') };
}
export function assertSignedEffectResourcePolicyV7(value: unknown, manifest: ExecutionManifestV1,
  repositoryId: string, currentEpoch: string, key: KeyObject | string, module?: Term): asserts value is SignedEffectResourcePolicyV7 {
  encodeCanonical(value);
  const policy = exactObject(value, ['format', 'body', 'signer', 'signature']);
  if (policy.format !== 'aether.signed-effect-resource-policy/7')
    throw new TypeError('unsupported signed effect resource policy v7');
  validateEffectResourcePolicyBodyV7(policy.body, module); identifier(policy.signer);
  identifier(repositoryId); decimal(currentEpoch);
  const body = policy.body as EffectResourcePolicyBodyV7;
  if (body.repositoryId !== repositoryId || body.astRoot !== manifest.astRoot
    || body.policyEpoch !== currentEpoch || effectResourcePolicyDigestV7(body, module) !== manifest.capabilityPolicyDigest)
    throw new Error('stale or foreign effect resource policy v7');
  if (typeof policy.signature !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(policy.signature))
    throw new TypeError('invalid effect policy v7 signature');
  const signature = Buffer.from(policy.signature, 'base64');
  const publicKey = typeof key === 'string' ? createPublicKey(key)
    : key.type === 'private' ? createPublicKey(key) : key;
  if (publicKey.asymmetricKeyType !== 'ed25519' || signature.toString('base64') !== policy.signature
    || !verify(null, signingBytesV7(body, policy.signer as string), publicKey, signature))
    throw new TypeError('untrusted effect resource policy v7 signer');
}
export function effectResourcePathV7(policy: SignedEffectResourcePolicyV7, name: CapabilityName,
  args: readonly TaggedValueV1[]): readonly string[] {
  validateEffectResourcePolicyBodyV7(policy.body); capability(name);
  const rule = policy.body.rules.find(item => item.capability === name);
  if (!rule) throw new Error('effect capability has no signed v7 resource rule');
  if (rule.argument === null) return [...rule.prefix];
  if (nodeTypes.isProxy(args) || !Array.isArray(args))
    throw new TypeError('effect target arguments must be an ordinary tagged array');
  const selected = Object.getOwnPropertyDescriptor(args, String(rule.argument));
  if (!selected) throw new TypeError('missing signed effect target argument');
  if (!('value' in selected)) throw new TypeError('effect target argument accessor forbidden');
  const value = selected.value as TaggedValueV1;
  validateTaggedValue(value);
  if (value.tag !== 'string' || !SEGMENT.test(value.value) || value.value === '.' || value.value === '..')
    throw new TypeError('effect target is outside signed resource grammar');
  return [...rule.prefix, value.value];
}
export function assertEffectResourceAdapterV7(policy: SignedEffectResourcePolicyV7, name: CapabilityName,
  actual: Readonly<{ id: string; digest: Digest; artifactDigest: Digest | null }>): void {
  validateEffectResourcePolicyBodyV7(policy.body); capability(name);
  const rule = policy.body.rules.find(item => item.capability === name);
  if (!rule || rule.adapterId !== actual.id || rule.adapterDigest !== actual.digest
    || rule.adapterArtifactDigest !== actual.artifactDigest)
    throw new Error('attested sink adapter is outside signed resource policy v7');
}
export function assertEffectResourceSinkContextV7(policy: SignedEffectResourcePolicyV7,
  name: CapabilityName, actual: Readonly<{ deploymentId: string; sinkAnchorDigest: Digest;
    sinkStateWitnessDigest: Digest; approvedAdapterArtifactDigest: Digest }>): void {
  validateEffectResourcePolicyBodyV7(policy.body); capability(name);
  const rule = policy.body.rules.find(item => item.capability === name);
  if (!rule || rule.deploymentId !== actual.deploymentId
    || rule.sinkAnchorDigest !== actual.sinkAnchorDigest
    || rule.sinkStateWitnessDigest !== actual.sinkStateWitnessDigest
    || rule.adapterArtifactDigest !== actual.approvedAdapterArtifactDigest)
    throw new Error('attested sink context is outside signed resource policy v7');
}
