/** One signed effectful Aether candidate for scheduler, resource and network cases. */
import type { KeyObject } from 'node:crypto';
import * as b from '../../../../src/tier1/build.ts';
import type { Term } from '../../../../src/tier1/ast.ts';
import { capability } from '../../../../src/tier1/ids.ts';
import { GraphStore } from '../../../../src/tier1/store.ts';
import { effectAdapterDigest } from '../../../../src/fabric/effects.ts';
import { domainDigest, type ExecutionManifestV1 } from '../../../../src/fabric/identity.ts';
import { effectResourcePolicyDigest, signEffectResourcePolicy, type EffectResourcePolicyBodyV1 } from '../../../../src/tier2/effect-resource-policy.ts';
import { LIVING_CAMPAIGN_PROFILE, type LivingCampaignManifest } from '../../../../src/tier3/living-campaign.ts';
import { signLivingEffectAuthorizationV2, signLivingEffectAuthorizationV3 } from '../../../../src/tier3/living-effect-authorization.ts';
import { livingFixture } from '../microworld/fixture.ts';

export const CAP_CAMPAIGN_APPEND = capability('cap:campaign:append');
export function integratedFixture(broken = false) {
  const base = livingFixture(broken);
  if (base.module.kind !== 'Module') throw new TypeError('fixture module');
  const members = base.module.members.map(member => {
    if (member.kind !== 'FunctionDecl' || member.symbol !== base.symbols.receive) return member;
    const original = member.body;
    if (!original || original.kind !== 'Block') throw new TypeError('unexpected receive body');
    const condition = original.stmts[0];
    if (!condition || condition.kind !== 'If' || condition.then.kind !== 'Block')
      throw new TypeError('unexpected receive condition');
    const success = condition.then;
    const write = success.stmts[0], returned = success.stmts[1];
    const body: Term = { ...original, stmts: [{ ...condition,
      then: { ...success, stmts: [write, b.exprStmt(b.invoke(CAP_CAMPAIGN_APPEND, b.v(base.symbols.sequence))), returned] } }] };
    return { ...member, purity: 'effectful' as const, capabilities: [CAP_CAMPAIGN_APPEND], body };
  });
  const module: Term = { ...base.module, members };
  base.registry.declare(CAP_CAMPAIGN_APPEND, { arity: 1, description: 'Append accepted event sequence to a sandbox journal.' });
  const root = new GraphStore().intern(module);
  const manifest: LivingCampaignManifest = { ...base.manifest, candidateRoot: root, seed: '20260924-integrated',
    scenarios: base.manifest.scenarios.map(scenario => ['faulted-json-network', 'out-of-order-events'].includes(scenario.id)
      ? { ...scenario, requiredCoverage: [...scenario.requiredCoverage, 'effect:committed'] }
      : scenario) };
  const adapter = { id: 'adapter:living-integrated/1', semantics: { readOnly: false, atomicIdempotency: true,
    transactional: false, reconciliation: true }, execute: () => ({ tag: 'null' as const }),
    reconcile: () => ({ state: 'unknown' as const }) };
  const campaignDigest = domainDigest(LIVING_CAMPAIGN_PROFILE, manifest);
  const policyBody: EffectResourcePolicyBodyV1 = { format: 'aether.effect-resource-policy/1',
    repositoryId: 'living-integrated-research', astRoot: root, policyEpoch: '1',
    rules: [{ capability: CAP_CAMPAIGN_APPEND, prefix: ['campaign'], argument: null,
      adapterId: adapter.id, adapterDigest: effectAdapterDigest(adapter) }] };
  const metadata = domainDigest('aether.living-integrated-research/1', broken ? 'broken' : 'good');
  const executionManifest: ExecutionManifestV1 = { format: 'aether.execution/1', astRoot: root, specRoot: campaignDigest,
    dependencies: [], semanticsVersion: 'aether-reference/1', compilerDigest: metadata,
    target: { abiVersion: 'local/1', profileDigest: metadata, artifactDigest: metadata },
    capabilityPolicyDigest: effectResourcePolicyDigest(policyBody), evidencePolicyDigest: metadata };
  return { module, registry: base.registry, manifest, campaignDigest, policyBody, executionManifest };
}
export function signIntegratedFixture(fixture: ReturnType<typeof integratedFixture>, privateKey: KeyObject,
  faultMode: 'none' | 'unknown-after-dispatch' | 'sigkill-once-after-dispatch' = 'none') {
  const signedPolicy = signEffectResourcePolicy(fixture.policyBody, 'living-integrated-operator', privateKey);
  const common = {
    executionManifest: fixture.executionManifest, signedPolicy, campaignDigest: fixture.campaignDigest,
    responses: [{ capability: CAP_CAMPAIGN_APPEND, value: { tag: 'null' } }],
    signer: 'living-integrated-operator',
  } as const;
  return faultMode === 'sigkill-once-after-dispatch'
    ? signLivingEffectAuthorizationV3({ ...common, format: 'aether.living-effect-authorization/3', faultMode }, privateKey)
    : signLivingEffectAuthorizationV2({ ...common, format: 'aether.living-effect-authorization/2', faultMode }, privateKey);
}
export const integratedTrust = (publicKeyPem: string) => ({ repositoryId: 'living-integrated-research',
  policyEpoch: '1', signer: 'living-integrated-operator', key: publicKeyPem });
