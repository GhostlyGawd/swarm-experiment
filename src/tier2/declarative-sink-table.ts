/** Versioned declarative registrations for independently attested external
 * sinks. Retirement removes a current dispatch registration; it never erases
 * historical signed decisions or unloads a live native/third-party process. */
import { encodeCanonical, exactObject, identifier } from '../fabric/encoding.ts';
import type { KeyObject } from 'node:crypto';
import { effectAdapterDigest, type EffectAdapter } from '../fabric/effects.ts';
import { assertAttestedSinkAdapter, type AttestedSinkIdentityV1 } from '../fabric/attested-sink-adapter.ts';
import { domainDigest, validateDigest, type Digest, type ExecutionManifestV1 } from '../fabric/identity.ts';
import { validateSinkAdapterArtifactDigest, validateSinkPublicAnchor } from '../fabric/sink-receipt.ts';
import { assertSinkStateWitness, type SinkStateWitnessV1 } from '../fabric/sink-state-witness.ts';
import type { Term } from '../tier1/ast.ts';
import { capability, type CapabilityName } from '../tier1/ids.ts';
import { assertSignedEffectResourcePolicyV7, type SignedEffectResourcePolicyV7 } from './effect-resource-policy.ts';

export interface DeclarativeSinkRegistrationV2 {
  readonly id: string;
  readonly capability: CapabilityName;
  readonly adapterId: string;
  readonly adapterDigest: Digest;
  readonly adapterArtifactDigest: Digest;
  readonly deploymentId: string;
  readonly sinkAnchorDigest: Digest;
  readonly sinkStateWitnessDigest: Digest;
  readonly lifecycle: 'attested-external-no-unload/1';
}
export interface DeclarativeSinkTableV2 {
  readonly format: 'aether.declarative-adapter-table/2';
  readonly repositoryId: string;
  readonly registrations: readonly DeclarativeSinkRegistrationV2[];
}
export interface SignedSinkTableSelectionV2 {
  readonly table: DeclarativeSinkTableV2;
  readonly policy: SignedEffectResourcePolicyV7;
  readonly manifest: ExecutionManifestV1;
  readonly currentEpoch: string;
  readonly signerKey: KeyObject | string;
  /** Required for an empty signed rule set. */
  readonly module?: Term;
}

const sinkSemantics = Object.freeze({ readOnly: false, atomicIdempotency: true,
  transactional: false, reconciliation: true });
export function declarativeSinkTableDigestV2(table: DeclarativeSinkTableV2): Digest {
  encodeCanonical(table);
  exactObject(table, ['format', 'repositoryId', 'registrations']);
  if (table.format !== 'aether.declarative-adapter-table/2'
    || !Array.isArray(table.registrations) || table.registrations.length > 128)
    throw new TypeError('invalid declarative sink table v2');
  identifier(table.repositoryId);
  let previous = '';
  const capabilities = new Set<string>();
  for (const entry of table.registrations) {
    exactObject(entry, ['id', 'capability', 'adapterId', 'adapterDigest',
      'adapterArtifactDigest', 'deploymentId', 'sinkAnchorDigest',
      'sinkStateWitnessDigest', 'lifecycle']);
    identifier(entry.id); capability(entry.capability); identifier(entry.adapterId);
    identifier(entry.deploymentId);
    validateDigest(entry.adapterDigest, 'aether.effect-adapter/1');
    validateSinkAdapterArtifactDigest(entry.adapterArtifactDigest);
    validateDigest(entry.sinkAnchorDigest, 'aether.sink-anchor/1');
    validateDigest(entry.sinkStateWitnessDigest, 'aether.sink-state-witness/1');
    if (entry.id <= previous || capabilities.has(entry.capability)
      || entry.lifecycle !== 'attested-external-no-unload/1'
      || entry.adapterDigest !== domainDigest('aether.effect-adapter/1', {
        id: entry.adapterId, semantics: sinkSemantics }))
      throw new TypeError('noncanonical or unsupported declarative sink registration');
    previous = entry.id; capabilities.add(entry.capability);
  }
  return domainDigest('aether.declarative-adapter-table/2', table);
}

/** The signed effect policy and current table must describe exactly the same
 * capabilities and sink identities. Empty tables need an independently checked
 * exact-root module with no Invoke, as required by policy V7. */
export function assertDeclarativeSinkTablePolicyV2(selection: SignedSinkTableSelectionV2): void {
  const { table, policy, manifest, currentEpoch, signerKey, module } = selection;
  const digest = declarativeSinkTableDigestV2(table);
  assertSignedEffectResourcePolicyV7(policy, manifest, table.repositoryId,
    currentEpoch, signerKey, module);
  if (policy.body.repositoryId !== table.repositoryId
    || policy.body.adapterTableDigest !== digest
    || policy.body.rules.length !== table.registrations.length)
    throw new Error('signed effect policy differs from complete sink adapter table');
  const entries = new Map(table.registrations.map(entry => [entry.capability, entry]));
  for (const rule of policy.body.rules) {
    const entry = entries.get(rule.capability);
    if (!entry || entry.adapterId !== rule.adapterId
      || entry.adapterDigest !== rule.adapterDigest
      || entry.adapterArtifactDigest !== rule.adapterArtifactDigest
      || entry.deploymentId !== rule.deploymentId
      || entry.sinkAnchorDigest !== rule.sinkAnchorDigest
      || entry.sinkStateWitnessDigest !== rule.sinkStateWitnessDigest)
      throw new Error('signed effect rule differs from sink adapter registration');
  }
}

/** Nonvirtual adapter-map audit for a trusted operator selected sink authority.
 * The broker must additionally pin its private map at dispatch admission. */
export function assertDeclarativeSinkRuntimeMapV2(selection: SignedSinkTableSelectionV2,
  adapters: ReadonlyMap<CapabilityName, EffectAdapter>,
  authority: AttestedSinkIdentityV1, witness: SinkStateWitnessV1): void {
  assertDeclarativeSinkTablePolicyV2(selection);
  const { table } = selection;
  assertSinkStateWitness(witness);
  validateSinkPublicAnchor(authority.anchor);
  const nativeSize = Object.getOwnPropertyDescriptor(Map.prototype, 'size')!.get!.call(adapters) as number;
  if (Object.getPrototypeOf(adapters) !== Map.prototype
    || nativeSize !== table.registrations.length)
    throw new TypeError('exact native adapter map required');
  const anchorDigest = domainDigest('aether.sink-anchor/1', authority.anchor);
  for (const entry of table.registrations) {
    const adapter = Map.prototype.get.call(adapters, entry.capability) as EffectAdapter | undefined;
    if (!adapter || authority.repositoryId !== table.repositoryId
      || authority.deploymentId !== entry.deploymentId
      || authority.approvedAdapterArtifactDigest !== entry.adapterArtifactDigest
      || witness.repositoryId !== authority.repositoryId
      || witness.sinkAnchorDigest !== anchorDigest
      || witness.digest !== entry.sinkStateWitnessDigest
      || entry.sinkAnchorDigest !== anchorDigest)
      throw new Error('operator sink authority differs from registration');
    assertAttestedSinkAdapter(adapter, authority);
    if (adapter.id !== entry.adapterId || effectAdapterDigest(adapter) !== entry.adapterDigest)
      throw new Error('live sink adapter differs from signed registration');
  }
}
