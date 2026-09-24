/** Reconstructs an effectful Aether candidate from its registered seed. */
import { type KeyObject } from 'node:crypto';
import { effectAdapterDigest } from '../../../../src/fabric/effects.ts';
import { domainDigest, type ExecutionManifestV1 } from '../../../../src/fabric/identity.ts';
import { buildLedgerExample, ACCOUNT, CAP_LEDGER_APPEND } from '../../../../src/examples/ledger.ts';
import { GraphStore } from '../../../../src/tier1/store.ts';
import { effectResourcePolicyDigest, signEffectResourcePolicy, type EffectResourcePolicyBodyV1 } from '../../../../src/tier2/effect-resource-policy.ts';
import { LIVING_CAMPAIGN_PROFILE, type LivingCampaignManifest } from '../../../../src/tier3/living-campaign.ts';
import { signLivingEffectAuthorizationV2 } from '../../../../src/tier3/living-effect-authorization.ts';

export function effectFixture(seed: string, cases: number) {
  const example = buildLedgerExample(seed), root = new GraphStore().intern(example.module);
  const manifest: LivingCampaignManifest = { format: LIVING_CAMPAIGN_PROFILE, candidateRoot: root, seed: `effect-${seed}`,
    maxStepsPerCall: 20_000, shrinkAttempts: 8, scenarios: [{ id: 'transfer', kind: 'resource',
      scheduling: { mode: 'seeded', cases }, variables: [], allocationLimitBytes: 32,
      records: [
        { name: 'sender', ty: ACCOUNT, fields: { id: { tag: 'string', value: 'a' }, balance: { tag: 'int', value: '100' } } },
        { name: 'receiver', ty: ACCOUNT, fields: { id: { tag: 'string', value: 'b' }, balance: { tag: 'int', value: '0' } } },
      ],
      actors: [{ id: 'actor', steps: [
        { kind: 'reserve', id: 'allocate', bytes: 8, expect: 'allocated' },
        { kind: 'call', id: 'transfer', symbol: example.symbols.transfer, args: [
          { tag: 'record', name: 'sender' }, { tag: 'record', name: 'receiver' }, { tag: 'int', value: '10' },
        ], expect: { tag: 'null' } },
        { kind: 'release', id: 'release', reservation: 'allocate' },
      ] }],
      checks: [{ kind: 'call', id: 'fee-check', symbol: example.symbols.feeFor,
        args: [{ tag: 'int', value: '0' }], expect: { tag: 'int', value: '0' } }],
      requiredCoverage: ['candidate-call', 'effect:committed', 'resource:allocated', 'resource:released'],
    }] };
  const adapter = { id: 'adapter:living-effect-research/1', semantics: { readOnly: false, atomicIdempotency: true,
    transactional: false, reconciliation: true }, execute: () => ({ tag: 'null' as const }),
    reconcile: () => ({ state: 'unknown' as const }) };
  const campaignDigest = domainDigest(LIVING_CAMPAIGN_PROFILE, manifest);
  const policyBody: EffectResourcePolicyBodyV1 = { format: 'aether.effect-resource-policy/1', repositoryId: 'living-effect-research',
    astRoot: root, policyEpoch: '1', rules: [{ capability: CAP_LEDGER_APPEND, prefix: ['ledger'], argument: 0,
      adapterId: adapter.id, adapterDigest: effectAdapterDigest(adapter) }] };
  const metadata = domainDigest('aether.living-effect-research/1', seed);
  const executionManifest: ExecutionManifestV1 = { format: 'aether.execution/1', astRoot: root, specRoot: campaignDigest,
    dependencies: [], semanticsVersion: 'aether-reference/1', compilerDigest: metadata,
    target: { abiVersion: 'local/1', profileDigest: metadata, artifactDigest: metadata },
    capabilityPolicyDigest: effectResourcePolicyDigest(policyBody), evidencePolicyDigest: metadata };
  return { example, manifest, campaignDigest, policyBody, executionManifest };
}
export function signEffectFixture(fixture: ReturnType<typeof effectFixture>, privateKey: KeyObject) {
  const signedPolicy = signEffectResourcePolicy(fixture.policyBody, 'living-effect-research-operator', privateKey);
  return signLivingEffectAuthorizationV2({ format: 'aether.living-effect-authorization/2',
    executionManifest: fixture.executionManifest, signedPolicy, campaignDigest: fixture.campaignDigest,
    responses: [{ capability: CAP_LEDGER_APPEND, value: { tag: 'null' } }], faultMode: 'none',
    signer: 'living-effect-research-operator' }, privateKey);
}
