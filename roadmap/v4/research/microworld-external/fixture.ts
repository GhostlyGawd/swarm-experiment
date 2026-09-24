/** Exact signed external-sink authority for the integrated Aether candidate. */
import type { KeyObject } from 'node:crypto';
import { domainDigest } from '../../../../src/fabric/identity.ts';
import { effectResourcePolicyDigestV2, signEffectResourcePolicyV2,
  type EffectResourcePolicyBodyV2 } from '../../../../src/tier2/effect-resource-policy.ts';
import { signLivingEffectAuthorizationV4 } from '../../../../src/tier3/living-effect-authorization.ts';
import type { SinkPublicAnchorV1 } from '../../../../src/fabric/sink-receipt.ts';
import { integratedFixture } from '../microworld-integrated/fixture.ts';

export const EXTERNAL_REPOSITORY = 'living-integrated-research';
export const EXTERNAL_DEPLOYMENT = 'deployment:living-external';
export const EXTERNAL_WITNESS_AUTHORITY = 'operator:living-external';
export const EXTERNAL_CLOCK = 'living-effect-clock/4';
export const EXTERNAL_ARTIFACT = domainDigest('aether.effect-adapter-artifact/1', 'living-external-research-adapter');
export function externalFixture() {
  const base = integratedFixture();
  const prior = base.policyBody.rules[0];
  const policyBody: EffectResourcePolicyBodyV2 = { format: 'aether.effect-resource-policy/2',
    repositoryId: EXTERNAL_REPOSITORY, astRoot: base.manifest.candidateRoot, policyEpoch: '1',
    rules: [{ ...prior, adapterArtifactDigest: EXTERNAL_ARTIFACT }] };
  const executionManifest = { ...base.executionManifest,
    capabilityPolicyDigest: effectResourcePolicyDigestV2(policyBody) };
  return { ...base, policyBody, executionManifest };
}
export function signExternalFixture(fixture: ReturnType<typeof externalFixture>, key: KeyObject,
  anchor: SinkPublicAnchorV1, sinkStateWitnessDigest: string, effectCatalogDigest: string) {
  const signedPolicy = signEffectResourcePolicyV2(fixture.policyBody, 'living-integrated-operator', key);
  return signLivingEffectAuthorizationV4({ format: 'aether.living-effect-authorization/4',
    executionManifest: fixture.executionManifest, signedPolicy, campaignDigest: fixture.campaignDigest,
    externalSink: { anchor, deploymentId: EXTERNAL_DEPLOYMENT,
      approvedAdapterArtifactDigest: EXTERNAL_ARTIFACT, sinkStateWitnessDigest, effectCatalogDigest },
    signer: 'living-integrated-operator' }, key);
}
