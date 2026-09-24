import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { after, test } from 'node:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { effectAdapterDigest } from '../../src/fabric/effects.ts';
import { domainDigest, type ExecutionManifestV1 } from '../../src/fabric/identity.ts';
import { buildLedgerExample, ACCOUNT, CAP_LEDGER_APPEND } from '../../src/examples/ledger.ts';
import { GraphStore } from '../../src/tier1/store.ts';
import { effectResourcePolicyDigest, signEffectResourcePolicy, type EffectResourcePolicyBodyV1 } from '../../src/tier2/effect-resource-policy.ts';
import { LivingCampaign, LIVING_CAMPAIGN_PROFILE, type LivingCampaignManifest } from '../../src/tier3/living-campaign.ts';
import { signLivingEffectAuthorizationV2 } from '../../src/tier3/living-effect-authorization.ts';

const directories: string[] = [];
const temp = () => { const directory = mkdtempSync(join(tmpdir(), 'aether-living-effect-test-')); directories.push(directory); return directory; };
after(() => directories.forEach(directory => rmSync(directory, { recursive: true, force: true })));
function fixture(seed: string, amount = '10', faultMode: 'none' | 'unknown-after-dispatch' = 'none') {
  const example = buildLedgerExample(seed), root = new GraphStore().intern(example.module);
  const manifest: LivingCampaignManifest = { format: LIVING_CAMPAIGN_PROFILE, candidateRoot: root, seed: `effect-${seed}`,
    maxStepsPerCall: 20_000, shrinkAttempts: 4, scenarios: [{ id: 'transfer', kind: 'resource',
      scheduling: { mode: 'seeded', cases: 2 }, variables: [], allocationLimitBytes: 32,
      records: [
        { name: 'sender', ty: ACCOUNT, fields: { id: { tag: 'string', value: 'a' }, balance: { tag: 'int', value: '100' } } },
        { name: 'receiver', ty: ACCOUNT, fields: { id: { tag: 'string', value: 'b' }, balance: { tag: 'int', value: '0' } } },
      ],
      actors: [{ id: 'actor', steps: [
        { kind: 'reserve', id: 'allocate', bytes: 8, expect: 'allocated' },
        { kind: 'call', id: 'transfer', symbol: example.symbols.transfer, args: [
          { tag: 'record', name: 'sender' }, { tag: 'record', name: 'receiver' }, { tag: 'int', value: amount },
        ], expect: { tag: 'null' } },
        { kind: 'release', id: 'release', reservation: 'allocate' },
      ] }],
      checks: [{ kind: 'call', id: 'fee-check', symbol: example.symbols.feeFor,
        args: [{ tag: 'int', value: '0' }], expect: { tag: 'int', value: '0' } }],
      requiredCoverage: ['candidate-call', 'effect:committed', 'resource:allocated', 'resource:released'],
    }] };
  const campaignDigest = domainDigest(LIVING_CAMPAIGN_PROFILE, manifest);
  const adapter = { id: 'adapter:living-effect-test/1', semantics: { readOnly: false, atomicIdempotency: true,
    transactional: false, reconciliation: true }, execute: () => ({ tag: 'null' as const }),
    reconcile: () => ({ state: 'unknown' as const }) };
  const policyBody: EffectResourcePolicyBodyV1 = { format: 'aether.effect-resource-policy/1', repositoryId: 'living-effect-test',
    astRoot: root, policyEpoch: '1', rules: [{ capability: CAP_LEDGER_APPEND, prefix: ['ledger'], argument: 0,
      adapterId: adapter.id, adapterDigest: effectAdapterDigest(adapter) }] };
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const signedPolicy = signEffectResourcePolicy(policyBody, 'living-effect-operator', privateKey);
  const metadata = domainDigest('aether.living-effect-fixture/1', seed);
  const executionManifest: ExecutionManifestV1 = { format: 'aether.execution/1', astRoot: root, specRoot: campaignDigest,
    dependencies: [], semanticsVersion: 'aether-reference/1', compilerDigest: metadata,
    target: { abiVersion: 'local/1', profileDigest: metadata, artifactDigest: metadata },
    capabilityPolicyDigest: effectResourcePolicyDigest(policyBody), evidencePolicyDigest: metadata };
  const authorization = signLivingEffectAuthorizationV2({ format: 'aether.living-effect-authorization/2',
    executionManifest, signedPolicy, campaignDigest, responses: [{ capability: CAP_LEDGER_APPEND, value: { tag: 'null' } }],
    faultMode, signer: 'living-effect-operator' }, privateKey);
  const trust = { repositoryId: 'living-effect-test', policyEpoch: '1', signer: 'living-effect-operator', key: publicKey };
  return { example, manifest, authorization, trust };
}

test('signed exact effectful candidate executes every case with durable broker evidence and local admission', () => {
  const f = fixture('candidate-one'), directory = temp();
  const campaign = new LivingCampaign({ manifest: f.manifest, module: f.example.module, registry: f.example.capabilities,
    directory, effectAuthorization: f.authorization, effectTrust: f.trust });
  const report = campaign.runEffectful();
  assert.equal(report.format, 'aether.living-effect-campaign-report/2');
  assert.equal(report.generated, 2); assert.equal(report.executed, 2); assert.equal(report.filtered, 0);
  assert.equal(report.accepted, true); assert.equal(report.effectEvents, 2); assert.equal(report.indeterminateEffects, 0);
  for (const item of report.cases) { assert.equal(item.result.effects.sinkWrites, 1); assert.equal(item.result.effects.eventCount, 1); }
  assert.equal(campaign.admitEffectful(report).productionAuthorized, false);
  assert.throws(() => campaign.runEffectful(), /already exists/);
  assert.throws(() => campaign.run(), /version 2/);
  assert.throws(() => campaign.admit({ ...report, format: 'aether.living-campaign-report/1' }), /pure admission/);
  assert.throws(() => campaign.admitEffectful({ ...report, accepted: false }), /complete exact signed subject/);
  assert.throws(() => campaign.admitEffectful(JSON.parse(JSON.stringify(report))), /complete exact signed subject/);
});

test('a second signed module root is admitted without a fixture-specific execution path', () => {
  const f = fixture('candidate-two'), campaign = new LivingCampaign({ manifest: f.manifest, module: f.example.module,
    registry: f.example.capabilities, directory: temp(), effectAuthorization: f.authorization, effectTrust: f.trust });
  assert.equal(campaign.runEffectful().accepted, true);
});

test('changed candidate, campaign, signed response, policy, or signer fails before dispatch', () => {
  const f = fixture('subject'), another = fixture('other-subject');
  const options = { manifest: f.manifest, module: f.example.module, registry: f.example.capabilities,
    directory: temp(), effectAuthorization: f.authorization, effectTrust: f.trust };
  assert.throws(() => new LivingCampaign({ ...options, module: another.example.module }), /candidate root mismatch/);
  assert.throws(() => new LivingCampaign({ ...options, manifest: { ...f.manifest, seed: 'changed' } }), /campaign exact execution subject mismatch/);
  assert.throws(() => new LivingCampaign({ ...options, effectAuthorization: { ...f.authorization, responses: [
    { capability: CAP_LEDGER_APPEND, value: { tag: 'string', value: 'forged' } },
  ] } }), /forged effectful campaign authorization/);
  assert.throws(() => new LivingCampaign({ ...options, effectAuthorization: { ...f.authorization,
    signedPolicy: { ...f.authorization.signedPolicy, signature: 'A'.repeat(86) + '==' } } }), /untrusted effect resource policy signer/);
  assert.throws(() => new LivingCampaign({ ...options, effectTrust: { ...f.trust, key: generateKeyPairSync('ed25519').publicKey } }), /untrusted effect resource policy signer/);
});

test('unknown post-dispatch outcome and precondition filtering cannot be admitted', () => {
  const unknown = fixture('unknown', '10', 'unknown-after-dispatch');
  const unknownCampaign = new LivingCampaign({ manifest: unknown.manifest, module: unknown.example.module,
    registry: unknown.example.capabilities, directory: temp(), effectAuthorization: unknown.authorization, effectTrust: unknown.trust });
  const unknownReport = unknownCampaign.runEffectful();
  assert.equal(unknownReport.accepted, false); assert.equal(unknownReport.filtered, 0);
  assert.equal(unknownReport.indeterminateEffects, 2);
  assert.throws(() => unknownCampaign.admitEffectful(unknownReport), /terminal effects/);
  for (const witness of unknownReport.counterexamples) assert.equal(unknownCampaign.replayCounterexample(witness).originalResult.passed, false);
  const filtered = fixture('filtered', '0');
  const filteredCampaign = new LivingCampaign({ manifest: filtered.manifest, module: filtered.example.module,
    registry: filtered.example.capabilities, directory: temp(), effectAuthorization: filtered.authorization, effectTrust: filtered.trust });
  const filteredReport = filteredCampaign.runEffectful();
  assert.equal(filteredReport.accepted, false); assert.equal(filteredReport.filtered, 2);
  assert.throws(() => filteredCampaign.admitEffectful(filteredReport), /terminal effects/);
});

test('local admission rereads durable sink evidence instead of trusting the report object', () => {
  const f = fixture('tamper'), directory = temp();
  const campaign = new LivingCampaign({ manifest: f.manifest, module: f.example.module,
    registry: f.example.capabilities, directory, effectAuthorization: f.authorization, effectTrust: f.trust });
  const report = campaign.runEffectful();
  assert.equal(report.accepted, true);
  const sink = join(directory, 'effect-sinks', report.cases[0].result.caseDigest.split(':').at(-1)!);
  const file = join(sink, readdirSync(sink).find(name => name.endsWith('.json'))!);
  writeFileSync(file, readFileSync(file, 'utf8').replace('executionManifest', 'alteredManifest'));
  assert.throws(() => campaign.admitEffectful(report), /durable broker\/sink evidence changed/);
});

test('effectful counterexamples replay after reopening and durable reports are admission inputs', () => {
  const unknown = fixture('reopen-unknown', '10', 'unknown-after-dispatch'), unknownDirectory = temp();
  const first = new LivingCampaign({ manifest: unknown.manifest, module: unknown.example.module,
    registry: unknown.example.capabilities, directory: unknownDirectory,
    effectAuthorization: unknown.authorization, effectTrust: unknown.trust });
  const report = first.runEffectful();
  const reopened = new LivingCampaign({ manifest: unknown.manifest, module: unknown.example.module,
    registry: unknown.example.capabilities, directory: unknownDirectory,
    effectAuthorization: unknown.authorization, effectTrust: unknown.trust });
  assert.equal(reopened.replayCounterexample(report.counterexamples[0]).originalResult.passed, false);
  const good = fixture('report-tamper'), directory = temp();
  const campaign = new LivingCampaign({ manifest: good.manifest, module: good.example.module,
    registry: good.example.capabilities, directory,
    effectAuthorization: good.authorization, effectTrust: good.trust });
  const goodReport = campaign.runEffectful();
  const file = join(directory, 'reports', readdirSync(join(directory, 'reports')).find(name => name.endsWith('.json'))!);
  writeFileSync(file, readFileSync(file, 'utf8').replace('accepted', 'altered'));
  assert.throws(() => campaign.admitEffectful(goodReport), /durable report changed/);
});

test('a preread effect execution cannot be counted as a fresh campaign run', () => {
  const f = fixture('prior-effect');
  const campaign = new LivingCampaign({ manifest: f.manifest, module: f.example.module,
    registry: f.example.capabilities, directory: temp(), effectAuthorization: f.authorization, effectTrust: f.trust });
  assert.equal(campaign.execute(campaign.generate()[0]).passed, true);
  assert.throws(() => campaign.runEffectful(), /prior effect executions/);
});
