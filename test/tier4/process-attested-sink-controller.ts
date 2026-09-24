import assert from 'node:assert/strict';
import { createPrivateKey, createPublicKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as b from '../../src/tier1/build.ts';
import { capability } from '../../src/tier1/ids.ts';
import { SymbolSpace } from '../../src/tier1/symbols.ts';
import { GraphStore } from '../../src/tier1/store.ts';
import { CapabilityRegistry, CapabilitySealer } from '../../src/tier2/ocap.ts';
import { ScopedGrantAuthority } from '../../src/tier2/scoped-grants.ts';
import { createEffectSignerAnchor } from '../../src/tier2/effect-signer-anchor.ts';
import { createTrustedClockAnchor } from '../../src/tier2/trusted-clock-anchor.ts';
import { effectResourcePolicyDigestV5, effectResourcePolicyDigestV6,
  signEffectResourcePolicyV5, signEffectResourcePolicyV6,
  type EffectResourcePolicyBodyV5, type EffectResourcePolicyBodyV6 } from '../../src/tier2/effect-resource-policy.ts';
import { DEFAULT_EVIDENCE_POLICY_V2, mintLocalEvidence,
  type EvidenceContext } from '../../src/fabric/evidence.ts';
import { encodeCanonical } from '../../src/fabric/encoding.ts';
import { domainDigest, executionManifestDigest } from '../../src/fabric/identity.ts';
import { DurableEffectBroker, effectAdapterDigest } from '../../src/fabric/effects.ts';
import { createAttestedSinkClient } from '../../src/fabric/attested-sink-service.ts';
import { createAttestedSinkAdapter } from '../../src/fabric/attested-sink-adapter.ts';
import { createProcessWitnessClient } from '../../src/fabric/witness-service.ts';
import { selectEffectJournalWitness } from '../../src/fabric/effect-journal-witness.ts';
import { BrokerEffectRouter } from '../../src/tier3/effects.ts';
import { PromotionCoordinator } from '../../src/fabric/promotion.ts';
import { ProcessDeployment, type ProcessDeploymentOptions } from '../../src/tier4/process-deployment.ts';
import type { TopologyPlan } from '../../src/tier4/topology.ts';
import type { SinkPublicAnchorV1 } from '../../src/fabric/sink-receipt.ts';

interface Fixture {
  readonly directory: string;
  readonly repositoryId: string;
  readonly deploymentId: string;
  readonly clockDomain: string;
  readonly anchor: SinkPublicAnchorV1;
  readonly adapterArtifactDigest: string;
  readonly sinkSocket: string;
  readonly sinkAuthKeyFile: string;
  readonly sinkWitnessSocket: string;
  readonly sinkWitnessKeyFile: string;
  readonly operatorSocket: string;
  readonly operatorKeyFile: string;
  readonly policySignerKeyFile: string;
  readonly grantKeyFile: string;
  readonly sealerKeyFile: string;
  readonly governorKeyFile: string;
  readonly resourceScoped?: boolean;
}

const fixture = JSON.parse(readFileSync(process.argv[2]!, 'utf8')) as Fixture;
const mode = process.argv[3];
assert.ok(['crash', 'recover', 'crash-pre-sink', 'recover-abort',
  'crash-before-sink-entry', 'recover-fenced'].includes(mode ?? ''));
const f = fixture;
const resourceScoped = f.resourceScoped === true;
const operationId = resourceScoped ? 'v11-resource-crash' : 'v10-crash';
const target = resourceScoped ? 'alice' : 'append-once';
const symbols = new SymbolSpace('attested-sink-controller-crash');
const entry = symbols.define('entry'), valueSymbol = symbols.define('value');
const CAP = capability('cap:test:attested_sink_controller_crash');
const registry = new CapabilityRegistry();
registry.define({ name: CAP, domain: 'test', operation: 'attested_sink_controller_crash', arity: 1,
  description: 'append to witnessed sink', effectful: true });
const module = b.module_({ symbol: symbols.define('module'), symbolTable: symbols.table(), members: [
  b.fn({ symbol: entry, params: [b.param(valueSymbol, b.Str)], returns: b.Str,
    capabilities: [CAP], purity: 'effectful', contract: b.contract({}),
    body: b.block(b.exprStmt(b.invoke(CAP, b.v(valueSymbol))), b.ret(b.v(valueSymbol))) }),
] });
const plan: TopologyPlan = { shape: 'containers', units: [{ id: 'worker', members: [entry],
  capabilities: [CAP], placement: 'container', memoryMb: 16 }], crossEdges: [],
  transportLatencyMsPerSecond: 0, monthlyCost: 0, recombinations: [], blockedMerges: [] };
const operator = createProcessWitnessClient({ socketPath: f.operatorSocket,
  key: readFileSync(f.operatorKeyFile), timeoutMs: 10_000 });
const sinkStateWitness = createProcessWitnessClient({ socketPath: f.sinkWitnessSocket,
  key: readFileSync(f.sinkWitnessKeyFile), timeoutMs: 10_000 }).sinkStateWitness({
    authorityId: 'operator:sink', anchor: f.anchor, adapterArtifactDigest: f.adapterArtifactDigest });
const effectCatalog = operator.effectCatalog({ authorityId: 'operator:effects',
  repositoryId: f.repositoryId, deploymentId: f.deploymentId, clockDomain: f.clockDomain });
const hostCatalog = operator.hostCatalog({ authorityId: 'operator:host',
  repositoryId: f.repositoryId, deploymentId: f.deploymentId });
const deploymentWitness = operator.deploymentWitness({ authorityId: resourceScoped
  ? 'operator:deployment-v11' : 'operator:deployment',
  repositoryId: f.repositoryId, deploymentId: f.deploymentId });
const sinkClient = createAttestedSinkClient({ socketPath: f.sinkSocket,
  authKey: readFileSync(f.sinkAuthKeyFile), anchor: f.anchor,
  adapterArtifactDigest: f.adapterArtifactDigest, repositoryId: f.repositoryId,
  deploymentId: f.deploymentId, timeoutMs: 10_000 });
const sinkAdapter = createAttestedSinkAdapter({ id: 'adapter:controller-crash-sink',
  client: mode === 'crash-before-sink-entry' ? {
    execute: () => { process.kill(process.pid, 'SIGKILL'); throw new Error('expected SIGKILL before sink entry'); },
    status: request => sinkClient.status(request),
  } : sinkClient, repositoryId: f.repositoryId, deploymentId: f.deploymentId,
  approvedAdapterArtifactDigest: f.adapterArtifactDigest, anchor: f.anchor });
const basePolicy: EffectResourcePolicyBodyV5 = { format: 'aether.effect-resource-policy/5',
  repositoryId: f.repositoryId, astRoot: new GraphStore().intern(module), policyEpoch: '0', rules: [{
    capability: CAP, prefix: ['sink'], argument: null, adapterId: sinkAdapter.id,
    adapterDigest: effectAdapterDigest(sinkAdapter), adapterArtifactDigest: f.adapterArtifactDigest,
    deadline: '1000', clockDomain: f.clockDomain, deploymentId: f.deploymentId,
    sinkAnchorDigest: domainDigest('aether.sink-anchor/1', f.anchor),
    sinkStateWitnessDigest: sinkStateWitness.digest,
  }] };
const policy: EffectResourcePolicyBodyV5 | EffectResourcePolicyBodyV6 = resourceScoped
  ? { ...basePolicy, format: 'aether.effect-resource-policy/6', rules: [{ ...basePolicy.rules[0]!,
    prefix: ['account'], argument: 0 }] } : basePolicy;
const digest = (value: string) => domainDigest('aether.attested-sink-controller-crash/1', value);
const context: EvidenceContext = { module, registry, specification: resourceScoped
  ? 'V11 resource-scoped controller crash at signed sink commit'
  : 'V10 controller crash at signed sink commit',
  semanticsVersion: 'reference/1', compilerDigest: digest('compiler'),
  capabilityPolicyDigest: policy.format === 'aether.effect-resource-policy/6'
    ? effectResourcePolicyDigestV6(policy) : effectResourcePolicyDigestV5(policy),
  target: { abiVersion: 'process/1', profileDigest: digest('profile'), artifactDigest: digest('artifact') },
  policy: { ...DEFAULT_EVIDENCE_POLICY_V2, requireFormal: false } };
const evidence = mintLocalEvidence(context), manifest = evidence.manifest;
const policyPrivateKey = createPrivateKey(readFileSync(f.policySignerKeyFile));
const signed = policy.format === 'aether.effect-resource-policy/6'
  ? signEffectResourcePolicyV6(policy, 'policy:controller-crash', policyPrivateKey)
  : signEffectResourcePolicyV5(policy, 'policy:controller-crash', policyPrivateKey);
const signer = createEffectSignerAnchor({ repositoryId: f.repositoryId, signer: signed.signer,
  epochAuthorityId: 'epoch:controller-crash', publicKey: createPublicKey(policyPrivateKey),
  currentEpoch: () => '0' });
const clock = createTrustedClockAnchor({ authorityId: 'clock:operator',
  clockDomain: f.clockDomain, nowMs: () => 100, revision: () => '0' });
const grants = new ScopedGrantAuthority({ key: readFileSync(f.grantKeyFile),
  repositoryId: f.repositoryId, clock: () => 100, policyEpoch: () => '0',
  revocationEpoch: () => '0', isRevoked: () => false,
  authorizeIssue: () => true, authorizeDelegate: () => true });
const sealer = new CapabilitySealer(readFileSync(f.sealerKeyFile), () => 100);
const coordinator = new PromotionCoordinator({ profile: 'baseline-governor-v1',
  directory: join(f.directory, 'coordinator'), repositoryId: f.repositoryId,
  genesisManifest: executionManifestDigest(manifest),
  authority: () => ({ repositoryId: f.repositoryId, membershipEpoch: '1', policyEpoch: '1',
    eligibleGovernors: ['governor'] }), governorKey: () => createPublicKey(readFileSync(f.governorKeyFile)),
  clock: () => 100n });
const factoryId = 'attested-sink-crash-services/1';
const options: ProcessDeploymentOptions = {
  directory: join(f.directory, 'deployment'), coordinator,
  capabilityProfile: resourceScoped ? 'scoped-anchored-sink-v11' : 'scoped-anchored-sink-v10',
  effectSignerAnchor: signer,
  trustedClockAnchor: clock, effectJournalWitnessCatalog: effectCatalog,
  hostJournalWitnessCatalog: hostCatalog, deploymentJournalWitness: deploymentWitness,
  attestedSinkAuthority: { repositoryId: f.repositoryId, deploymentId: f.deploymentId,
    approvedAdapterArtifactDigest: f.adapterArtifactDigest, anchor: f.anchor }, sinkStateWitness,
  factories: new Map([[factoryId, () => ({ sealer, scopedGrants: grants,
    signedEffectResourcePolicy: signed, authorizeRecovery: () => true,
    onPhase: phase => {
      if (mode === 'crash-pre-sink' && phase === 'effect-requested')
        process.kill(process.pid, 'SIGKILL');
    },
    effectRouterFactory: effect => {
      const witness = selectEffectJournalWitness(effectCatalog, effect.operationId);
      const broker = new DurableEffectBroker({ directory: join(f.directory, 'effects',
        digest(effect.operationId).split(':').at(-1)!), clockDomain: f.clockDomain,
        clock: () => 100n, authorize: () => true, authorizeReconciliation: () => true,
        witness, attestedSinkV4: { anchor: f.anchor, deploymentId: f.deploymentId,
          approvedAdapterArtifactDigest: f.adapterArtifactDigest, sinkStateWitness },
        beforePersist: event => {
          if (mode === 'crash' && event.state === 'committed') process.kill(process.pid, 'SIGKILL');
        } });
      return new BrokerEffectRouter({ broker, manifest: effect.manifest,
        executionId: effect.operationId, policyEpoch: effect.policyEpoch!, deadline: effect.deadline!,
        adapters: new Map([[CAP, sinkAdapter]]), grantRef: effect.grantRef!,
        grant: () => { throw new Error('factory grant callback forbidden'); } });
    } })]]),
  ...(['crash', 'crash-pre-sink', 'crash-before-sink-entry'].includes(mode ?? '')
    ? { genesis: { context, evidence, plan, factoryId } } : {}),
};
let deployment: ProcessDeployment | null = null;
try {
  deployment = await ProcessDeployment.open(options);
  const tokens = () => deployment!.issueScopedTokens(entry, 60_000,
    new Map([[CAP, resourceScoped ? ['account', 'alice'] : ['sink']]]));
  if (['crash', 'crash-pre-sink', 'crash-before-sink-entry'].includes(mode ?? '')) {
    process.stdout.write(JSON.stringify({ event: 'worker-ready', controllerPid: process.pid,
      workerPids: deployment.status().workerPids }) + '\n');
    await deployment.call(entry, [{ tag: 'string', value: target }],
      { operationId, tokens: tokens() });
    throw new Error('expected controller SIGKILL at the selected effect boundary');
  }
  if (mode === 'recover-abort') {
    const recovered = await deployment.recoverOperation(operationId,
      { strategy: 'abort-before-effects' });
    assert.equal(recovered.state, 'aborted', JSON.stringify(recovered));
    const cached = await deployment.call(entry, [{ tag: 'string', value: target }],
      { operationId, tokens: tokens() });
    assert.deepEqual(encodeCanonical(cached), encodeCanonical(recovered));
    process.stdout.write(JSON.stringify({ pid: process.pid, recovered, cached }) + '\n');
  } else if (mode === 'recover-fenced') {
    await assert.rejects(deployment.recoverOperation(operationId,
      { strategy: 'abort-before-effects' }), /cannot abort committed or indeterminate external effects/);
    const recovered = await deployment.recoverOperation(operationId, { strategy: 'isolated-replay' });
    assert.equal(recovered.state, 'completed', JSON.stringify(recovered));
    assert.equal(recovered.execution.ok, false);
    const cached = await deployment.call(entry, [{ tag: 'string', value: target }],
      { operationId, tokens: tokens() });
    assert.deepEqual(cached, recovered);
    process.stdout.write(JSON.stringify({ pid: process.pid, recovered, cached }) + '\n');
  } else {
    await assert.rejects(deployment.recoverOperation(operationId,
      { strategy: 'abort-before-effects' }), /cannot abort committed or indeterminate external effects/);
    const recovered = await deployment.recoverOperation(operationId, { strategy: 'isolated-replay' });
    assert.equal(recovered.state, 'completed', JSON.stringify(recovered));
    assert.equal(recovered.execution.ok, true);
    if (recovered.execution.value.tag !== 'string') throw new Error('recovered the wrong value type');
    assert.equal(recovered.execution.value.value, target);
    const cached = await deployment.call(entry, [{ tag: 'string', value: target }],
      { operationId, tokens: tokens() });
    assert.deepEqual(cached, recovered);
    process.stdout.write(JSON.stringify({ pid: process.pid, recovered, cached }) + '\n');
  }
} finally {
  await deployment?.close();
}
