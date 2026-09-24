/** Operator-selected budget authority for one bounded signed-sink host profile.
 *
 * The complete effect requests are allocated before host configuration.
 * Budgeted grant references must therefore use the versioned /3 subject that
 * does not contain the resulting host configuration digest. The host checks
 * each computed live/recovery request against this pinned inventory.
 */
import { decodeCanonical, decimal, encodeCanonical, identifier } from '../fabric/encoding.ts';
import { effectRequestDigest, validateEffectRequest, type EffectRequestV1 } from '../fabric/effects.ts';
import { domainDigest, validateDigest, type Digest } from '../fabric/identity.ts';
import { validateSinkPublicAnchor, type SinkPublicAnchorV1 } from '../fabric/sink-receipt.ts';
import { assertSinkStateWitness, type SinkStateWitnessV1 } from '../fabric/sink-state-witness.ts';
import { attestedSinkBudgetEvidencePolicyDigest } from './attested-sink-budget-evidence.ts';
import { ResourceBudgetBridge } from './resource-budget-bridge.ts';
import type { ResourceAmounts } from './resource-budget.ts';

export interface BudgetedSinkAuthorityOptions {
  readonly repositoryId: string;
  readonly deploymentId: string;
  readonly anchor: SinkPublicAnchorV1;
  readonly sinkStateWitness: SinkStateWitnessV1;
  readonly approvedAdapterArtifactDigest: Digest;
  readonly owner: string;
  readonly charge: ResourceAmounts;
  readonly expectedRequests: readonly EffectRequestV1[];
  readonly bridge: ResourceBudgetBridge;
}
/** All fields exist before host configuration or budget-ledger construction.
 * resourcePath is the signed rule prefix plus concrete selected target, not
 * scopedGrantPath: the latter contains the final host configuration digest. */
export interface BudgetedSinkGrantRefV3Input {
  readonly repositoryId: string;
  readonly deploymentId: string;
  readonly hostJournalWitnessDigest: Digest;
  readonly executionManifest: Digest;
  readonly signedEffectPolicyDigest: Digest;
  readonly sinkAnchorDigest: Digest;
  readonly sinkStateWitnessDigest: Digest;
  readonly approvedAdapterArtifactDigest: Digest;
  readonly generation: string;
  readonly unit: string;
  readonly operationId: string;
  readonly effectId: string;
  readonly capability: string;
  readonly policyEpoch: string;
  readonly reservationId: string;
  readonly resourcePath: readonly string[];
}
export function budgetedSinkGrantRefV3(input: BudgetedSinkGrantRefV3Input): Digest {
  for (const value of [input.repositoryId, input.deploymentId, input.unit,
    input.operationId, input.effectId, input.capability, input.reservationId]) identifier(value);
  decimal(input.generation); decimal(input.policyEpoch);
  validateDigest(input.hostJournalWitnessDigest, 'aether.process-host-journal-witness/1');
  validateDigest(input.executionManifest, 'aether.execution/1');
  validateDigest(input.signedEffectPolicyDigest, 'aether.effect-resource-policy/6');
  validateDigest(input.sinkAnchorDigest, 'aether.sink-anchor/1');
  validateDigest(input.sinkStateWitnessDigest, 'aether.sink-state-witness/1');
  validateDigest(input.approvedAdapterArtifactDigest);
  if (!Array.isArray(input.resourcePath) || input.resourcePath.length < 1
    || input.resourcePath.length > 64) throw new RangeError('bounded budgeted sink resource path required');
  input.resourcePath.forEach(identifier);
  const { resourcePath, ...body } = input;
  return domainDigest('aether.process-effect-grant-ref/3', {
    ...body, resourcePathDigest: domainDigest('aether.process-effect-resource-path/1', resourcePath),
  });
}
const brands = new WeakSet<object>();
const clone = <T>(value: T): T => decodeCanonical(encodeCanonical(value)) as T;
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}
const effectKey = (request: Pick<EffectRequestV1, 'executionId' | 'effectId'>): string =>
  JSON.stringify([request.executionId, request.effectId]);

export class BudgetedSinkAuthority {
  readonly format = 'aether.budgeted-sink-authority/1' as const;
  readonly digest: Digest;
  readonly bridgeProfileDigest: Digest;
  readonly evidencePolicyDigest: Digest;
  readonly repositoryId: string;
  readonly deploymentId: string;
  readonly sinkAnchorDigest: Digest;
  readonly sinkStateWitnessDigest: Digest;
  readonly approvedAdapterArtifactDigest: Digest;
  #bridge: ResourceBudgetBridge;
  #requests: ReadonlyMap<string, EffectRequestV1>;
  constructor(options: BudgetedSinkAuthorityOptions) {
    ResourceBudgetBridge.assertInstance(options.bridge);
    validateSinkPublicAnchor(options.anchor);
    assertSinkStateWitness(options.sinkStateWitness);
    identifier(options.repositoryId); identifier(options.deploymentId); identifier(options.owner);
    const expectedRequests = freeze(clone([...options.expectedRequests]));
    this.evidencePolicyDigest = attestedSinkBudgetEvidencePolicyDigest({
      witness: options.sinkStateWitness, anchor: options.anchor,
      repositoryId: options.repositoryId, deploymentId: options.deploymentId,
      approvedAdapterArtifactDigest: options.approvedAdapterArtifactDigest,
      owner: options.owner, charge: options.charge, expectedRequests,
    });
    const requests = new Map<string, EffectRequestV1>();
    const inventory: { executionId: string; effectId: string; reservationId: string; requestDigest: Digest }[] = [];
    for (const request of expectedRequests) {
      validateEffectRequest(request);
      if (request.budgetReservationId === null) throw new TypeError('budgeted sink request lacks reservation');
      const key = effectKey(request);
      if (requests.has(key)) throw new TypeError('duplicate budgeted sink effect identity');
      requests.set(key, request);
      inventory.push({ executionId: request.executionId, effectId: request.effectId,
        reservationId: request.budgetReservationId, requestDigest: effectRequestDigest(request) });
    }
    inventory.sort((a, b) => effectKey(a).localeCompare(effectKey(b)));
    this.#bridge = options.bridge;
    this.#requests = requests;
    this.bridgeProfileDigest = options.bridge.profileDigest;
    this.repositoryId = options.repositoryId;
    this.deploymentId = options.deploymentId;
    this.sinkAnchorDigest = domainDigest('aether.sink-anchor/1', options.anchor);
    this.sinkStateWitnessDigest = options.sinkStateWitness.digest;
    this.approvedAdapterArtifactDigest = options.approvedAdapterArtifactDigest;
    this.digest = domainDigest(this.format, {
      format: this.format, repositoryId: this.repositoryId, deploymentId: this.deploymentId,
      sinkAnchorDigest: this.sinkAnchorDigest,
      sinkStateWitnessDigest: this.sinkStateWitnessDigest,
      approvedAdapterArtifactDigest: this.approvedAdapterArtifactDigest,
      bridgeProfileDigest: this.bridgeProfileDigest,
      evidencePolicyDigest: this.evidencePolicyDigest, expectedRequests: inventory,
    });
    brands.add(this);
    Object.freeze(this);
  }
  get bridge(): ResourceBudgetBridge {
    ResourceBudgetBridge.assertInstance(this.#bridge);
    if (this.#bridge.profileDigest !== this.bridgeProfileDigest)
      throw new Error('budget bridge identity changed after operator selection');
    return this.#bridge;
  }
  expectedRequest(executionId: string, effectId: string): EffectRequestV1 {
    identifier(executionId); identifier(effectId);
    const expected = this.#requests.get(JSON.stringify([executionId, effectId]));
    if (!expected) throw new Error('unplanned budgeted sink effect');
    return freeze(clone(expected));
  }
  reservationFor(request: EffectRequestV1): string {
    validateEffectRequest(request);
    const expected = this.expectedRequest(request.executionId, request.effectId);
    if (effectRequestDigest(request) !== effectRequestDigest(expected))
      throw new Error('budgeted sink request differs from operator inventory');
    return expected.budgetReservationId!;
  }
  static assert(value: unknown): asserts value is BudgetedSinkAuthority {
    if (!value || typeof value !== 'object' || !brands.has(value))
      throw new TypeError('independently selected budgeted sink authority required');
  }
}
