import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import * as b from '../../src/tier1/build.ts';
import type { Term } from '../../src/tier1/ast.ts';
import { typeName } from '../../src/tier1/ids.ts';
import { encode as encodeIR } from '../../src/tier1/agent-ir.ts';
import { GraphStore } from '../../src/tier1/store.ts';
import { atomicWrite } from '../../src/tier1/persistence.ts';
import { ACCOUNT, CAP_LEDGER_APPEND, buildLedgerExample } from '../../src/examples/ledger.ts';
import { CapabilitySealer, RevocationList } from '../../src/tier2/ocap.ts';
import { ScopedGrantAuthority } from '../../src/tier2/scoped-grants.ts';
import { DurableGrantEpochs } from '../../src/tier2/grant-epochs.ts';
import { effectResourcePolicyDigest, signEffectResourcePolicy, type EffectResourcePolicyBodyV1 } from '../../src/tier2/effect-resource-policy.ts';
import { BrokerEffectRouter } from '../../src/tier3/effects.ts';
import { DurableEffectBroker, type EffectAdapter } from '../../src/fabric/effects.ts';
import { JournalLock } from '../../src/fabric/journal-lock.ts';
import { DEFAULT_EVIDENCE_POLICY, mintLocalEvidence, type EvidenceContext } from '../../src/fabric/evidence.ts';
import { domainDigest, executionManifestDigest } from '../../src/fabric/identity.ts';
import type { TaggedValueV1, LogicalRefV1 } from '../../src/fabric/encoding.ts';
import { PromotionCoordinator, approvePromotion, evidenceBundleDigest, migrationPlanDigest, effectPlanDigest, type PromotionInput, type PromotionCoordinatorOptions } from '../../src/fabric/promotion.ts';
import { ProcessDeployment, processMigrationPlan, processEffectPlan, type ProcessArtifactV1, type ProcessDeploymentOptions } from '../../src/tier4/process-deployment.ts';
import { ProcessHost, PROCESS_INVOKE } from '../../src/tier4/process-host.ts';
import type { TopologyPlan } from '../../src/tier4/topology.ts';

const integer = (value: number): TaggedValueV1 => ({ tag: 'int', value: String(value) });
const text = (value: string): TaggedValueV1 => ({ tag: 'string', value });
const reference = (ref: LogicalRefV1, epoch = ref.ownerEpoch): TaggedValueV1 => ({ tag: 'ref', value: { ...ref, ownerEpoch: epoch } });
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const DEPLOYMENT_LEDGER_ADAPTER_DIGEST = domainDigest('aether.effect-adapter/1', { id: 'deployment-ledger/1', semantics: { readOnly: false, atomicIdempotency: true, transactional: false, reconciliation: true } });

// Recreated in a separate coordinator process for the actual process-death tests.
function hostFactory(directory: string, artifact: ProcessArtifactV1) {
  const sealer = new CapabilitySealer(new Uint8Array(32).fill(7), () => 100);
  const sinkLock = new JournalLock({ directory: join(directory, 'sink-lock'), domain: 'aether.deployment-test-sink' });
  const sink: EffectAdapter = { id: 'deployment-ledger/1', semantics: { readOnly: false, atomicIdempotency: true, transactional: false, reconciliation: true },
    execute: request => sinkLock.run(() => {
      const file = join(directory, 'ledger.json'), rows = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : [];
      const id = `${request.executionId}/${request.effectId}`;
      if (!rows.some((row: { id: string }) => row.id === id)) { rows.push({ id, manifest: request.executionManifest, payload: request.payload }); atomicWrite(file, JSON.stringify(rows)); }
      return { tag: 'null' };
    }),
    reconcile: request => {
      const file = join(directory, 'ledger.json'), rows = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : [];
      return rows.some((row: { id: string }) => row.id === `${request.executionId}/${request.effectId}`) ? { state: 'committed', value: { tag: 'null' } } : { state: 'not_committed' };
    },
  };
  return { sealer, authorizeRecovery: () => true, effectRouterFactory: (context: any) => {
    const effectDirectory = join(directory, 'effects', domainDigest('aether.deploy-effect/1', context.operationId).split(':').at(-1)!);
    const live = new DurableEffectBroker({ directory: effectDirectory, clockDomain: 'test/1', clock: () => 100n, authorize: () => true });
    const broker = context.mode === 'live' ? live : new DurableEffectBroker({ directory: effectDirectory, mode: 'replay', clockDomain: 'test/1', clock: () => 100n, authorize: () => false, replayEvents: live.events() });
    return new BrokerEffectRouter({ broker, manifest: artifact.manifest, executionId: context.operationId, policyEpoch: '1', deadline: '1000', adapters: new Map([[CAP_LEDGER_APPEND, sink]]), grant: () => 'governor-ledger-grant' });
  } };
}
function fixture(signedPolicy = false) {
  const directory = mkdtempSync(join(tmpdir(), 'aether-process-deployment-'));
  const ex = buildLedgerExample('deployment-ledger'), keys = generateKeyPairSync('ed25519');
  const sum = ex.syms.define('composed-sum');
  const context = (version = 'v1', left = 10, right = 10): EvidenceContext => {
    const base = ex.module as Extract<Term, { kind: 'Module' }>;
    const members = base.members.map(member => {
      if (member.kind !== 'FunctionDecl' || member.symbol !== ex.symbols.transfer || version === 'v1') return member;
      assert.equal(member.body?.kind, 'Block');
      const body = member.body as Extract<Term, { kind: 'Block' }>;
      return { ...member, body: { ...body, stmts: body.stmts.map(statement => statement.kind === 'ExprStmt' && statement.expr.kind === 'Invoke'
        ? b.exprStmt(b.invoke(CAP_LEDGER_APPEND, b.concat(b.str(`${version}:`), statement.expr.args[0]), ...statement.expr.args.slice(1))) : statement) } };
    });
    const total = b.fn({ symbol: sum, returns: b.Int, contract: b.contract({ ensures: [b.clause(b.ge(b.result(), b.int(18)), 'minimum_sum')] }), body: b.block(b.ret(b.add(b.int(left), b.int(right)))) });
    const module: Term = { ...base, members: [...members, total, b.typeDecl(typeName('type:deployment:marker'), b.Int)], symbolTable: ex.syms.table() };
    const digest = (value: string) => domainDigest('aether.deployment-test/1', value);
    const resourcePolicy: EffectResourcePolicyBodyV1 = { format: 'aether.effect-resource-policy/1', repositoryId: 'deployment-test', astRoot: new GraphStore().intern(module), policyEpoch: '0',
      rules: [{ capability: CAP_LEDGER_APPEND, prefix: ['ledger'], argument: 0, adapterId: 'deployment-ledger/1', adapterDigest: DEPLOYMENT_LEDGER_ADAPTER_DIGEST }] };
    return { module, registry: ex.capabilities, specification: 'Ledger conservation and composed total at least eighteen.', semanticsVersion: 'reference/1', compilerDigest: digest('compiler'), capabilityPolicyDigest: signedPolicy ? effectResourcePolicyDigest(resourcePolicy) : digest('effects-policy'),
      target: { abiVersion: 'process/1', profileDigest: digest('two-workers'), artifactDigest: digest(encodeIR(module).text) }, policy: { ...DEFAULT_EVIDENCE_POLICY, requireFormal: false } };
  };
  const plan = (swap = false): TopologyPlan => ({ shape: 'containers', units: [
    { id: 'a', members: swap ? [ex.symbols.feeFor, sum] : [ex.symbols.transfer, sum], capabilities: swap ? [] : [CAP_LEDGER_APPEND], placement: 'container', memoryMb: 32 },
    { id: 'b', members: swap ? [ex.symbols.transfer, ex.symbols.settle, ex.symbols.accrue] : [ex.symbols.feeFor, ex.symbols.settle, ex.symbols.accrue], capabilities: [CAP_LEDGER_APPEND], placement: 'container', memoryMb: 48 },
  ], crossEdges: [], transportLatencyMsPerSecond: 0, monthlyCost: 0, recombinations: [], blockedMerges: [] });
  const original = context(), originalEvidence = mintLocalEvidence(original), genesisManifest = executionManifestDigest(originalEvidence.manifest);
  const authority = { repositoryId: 'deployment-test', membershipEpoch: '1', policyEpoch: '1', eligibleGovernors: ['governor'] };
  const coordinatorOptions: PromotionCoordinatorOptions = { profile: 'baseline-governor-v1', directory: join(directory, 'coordinator'), repositoryId: authority.repositoryId, genesisManifest, authority: () => authority, governorKey: () => keys.publicKey, clock: () => 100n };
  const coordinator = new PromotionCoordinator(coordinatorOptions);
  const options: ProcessDeploymentOptions = { directory: join(directory, 'driver'), coordinator, capabilityProfile: 'legacy-sealed-v1', factories: new Map([['ledger-services/1', (artifact: ProcessArtifactV1) => hostFactory(directory, artifact)]]), genesis: { context: original, evidence: originalEvidence, plan: plan(), factoryId: 'ledger-services/1' } };
  const rows = (): any[] => existsSync(join(directory, 'ledger.json')) ? JSON.parse(readFileSync(join(directory, 'ledger.json'), 'utf8')) : [];
  const proposal = async (deployment: ProcessDeployment, ctx = context('v2'), topology = plan(true)): Promise<PromotionInput> => {
    const evidence = mintLocalEvidence(ctx), artifact = deployment.registerArtifact({ context: ctx, evidence, plan: topology, factoryId: 'ledger-services/1' });
    const migrationPlan = processMigrationPlan(await deployment.snapshot(), artifact), effectPlan = processEffectPlan('ledger-services/1', evidence.manifest.capabilityPolicyDigest);
    const value = { format: 'aether.promotion/1' as const, repositoryId: authority.repositoryId, expectedParent: coordinator.state().committedManifest, candidateManifest: executionManifestDigest(evidence.manifest), evidenceBundleDigest: evidenceBundleDigest(evidence), migrationPlanDigest: migrationPlanDigest(migrationPlan), effectPlanDigest: effectPlanDigest(effectPlan), membershipEpoch: '1', policyEpoch: '1', expiresAt: '1000' };
    return { proposal: value, approval: approvePromotion(value, 'governor', keys.privateKey), evidence, context: ctx, migrationPlan, effectPlan };
  };
  return { directory, ex, keys, authority, coordinatorOptions, coordinator, options, context, plan, original, originalEvidence, genesisManifest, rows, proposal };
}
async function accounts(deployment: ProcessDeployment) {
  const alice = await deployment.allocateRecord(ACCOUNT, { id: text('alice'), balance: integer(100) }, { operationId: 'alice', unit: 'a' });
  const bob = await deployment.allocateRecord(ACCOUNT, { id: text('bob'), balance: integer(0) }, { operationId: 'bob', unit: 'b' });
  return { alice, bob };
}
async function balances(deployment: ProcessDeployment) { return (await deployment.snapshot()).records.filter(record => record.fields.some(([key]) => key === 'balance')).map(record => (record.fields.find(([key]) => key === 'balance')![1] as { value: string }).value); }

test('strict process deployment carries scoped grants through the production host and sink', async () => {
  const f = fixture(); let deployment: ProcessDeployment | undefined;
  const epochs = new DurableGrantEpochs({ directory: join(f.directory, 'grant-epochs'), repositoryId: 'deployment-test' });
  const scopedGrants = new ScopedGrantAuthority({ key: new Uint8Array(32).fill(31), repositoryId: 'deployment-test', clock: () => 100,
    policyEpoch: () => epochs.policyEpoch, revocationEpoch: () => epochs.epoch,
    isRevoked: (cap, path) => epochs.isRevoked(cap, path), authorizeIssue: () => true, authorizeDelegate: () => true });
  const strictFactory = new Map([['ledger-services/1', (artifact: ProcessArtifactV1) => ({ ...hostFactory(f.directory, artifact), scopedGrants,
    effectResourcePolicyDigest: domainDigest('aether.effect-resource-policy/1', 'ledger-sender-id-v1'),
    effectResourcePath: (request: { capability: string; args: readonly TaggedValueV1[] }) => {
      const first = request.args[0]; if (first?.tag !== 'string') throw new TypeError('unsupported ledger resource');
      return ['ledger', first.value];
    },
  })]]);
  try {
    deployment = await ProcessDeployment.open({ ...f.options, capabilityProfile: 'scoped-v2', factories: strictFactory });
    assert.throws(() => deployment!.issueTokens(f.ex.symbols.transfer), /strict ProcessHost/);
    const { alice, bob } = await accounts(deployment), args = [reference(alice), reference(bob), integer(10)];
    await assert.rejects(deployment.call(f.ex.symbols.transfer, args, { operationId: 'wrong-audience', tokens: deployment.issueScopedTokens(f.ex.symbols.settle) }), /authority_denied/);
    assert.equal(f.rows().length, 0);
    const original = deployment.issueScopedTokens(f.ex.symbols.transfer);
    assert.equal((await deployment.call(f.ex.symbols.transfer, args, { operationId: 'strict-transfer', tokens: original })).state, 'completed');
    assert.equal(f.rows().length, 1);
    const wrongScope = new Map([[CAP_LEDGER_APPEND, ['ledger', 'bob']]]);
    const denied = await deployment.call(f.ex.symbols.transfer, args, { operationId: 'wrong-ledger-target', tokens: deployment.issueScopedTokens(f.ex.symbols.transfer, 60000, wrongScope) });
    if (denied.state === 'completed') assert.equal(denied.execution.ok, false);
    assert.equal(f.rows().length, 1);
    epochs.revoke(CAP_LEDGER_APPEND, []);
    await assert.rejects(deployment.call(f.ex.symbols.transfer, args, { operationId: 'revoked', tokens: original }), /authority_denied/);
    assert.equal(f.rows().length, 1);
    await deployment.close(); deployment = undefined;
    await assert.rejects(ProcessDeployment.open(f.options), /configuration|profile/i);
    deployment = await ProcessDeployment.open({ ...f.options, capabilityProfile: 'scoped-v2', factories: strictFactory });
    assert.deepEqual(await balances(deployment), ['90', '10']);
    await deployment.close(); deployment = undefined;
    const stateFile = join(f.options.directory, 'deployment.json'), current = JSON.parse(readFileSync(stateFile, 'utf8'));
    const prior = { ...current, format: 'aether.process-deployment/2' }; delete prior.capabilityProfile;
    writeFileSync(stateFile, JSON.stringify(prior)); const exactPrior = readFileSync(stateFile, 'utf8');
    await assert.rejects(ProcessDeployment.open({ ...f.options, capabilityProfile: 'scoped-v2', factories: strictFactory, genesis: undefined }), /explicit legacy capability migration/);
    assert.equal(readFileSync(stateFile, 'utf8'), exactPrior);
    deployment = await ProcessDeployment.open({ ...f.options, capabilityProfile: 'scoped-v2', factories: strictFactory, genesis: undefined, legacyCapabilityMigration: 'adopt-scoped-v2' });
    assert.deepEqual(JSON.parse(readFileSync(stateFile, 'utf8')), current);
    assert.deepEqual(await balances(deployment), ['90', '10']);
  } finally { await deployment?.close(); rmSync(f.directory, { recursive: true, force: true }); }
});

test('process deployment factory serves a signed effect resource policy bound to the admitted artifact', async () => {
  const f = fixture(true); let deployment: ProcessDeployment | undefined;
  const epochs = new DurableGrantEpochs({ directory: join(f.directory, 'signed-grant-epochs'), repositoryId: 'deployment-test' });
  const scopedGrants = new ScopedGrantAuthority({ key: new Uint8Array(32).fill(33), repositoryId: 'deployment-test', clock: () => 100,
    policyEpoch: () => epochs.policyEpoch, revocationEpoch: () => epochs.epoch,
    isRevoked: (cap, path) => epochs.isRevoked(cap, path), authorizeIssue: () => true, authorizeDelegate: () => true });
  const keys = generateKeyPairSync('ed25519');
  const factories = new Map([['ledger-services/1', (artifact: ProcessArtifactV1) => {
    const body: EffectResourcePolicyBodyV1 = { format: 'aether.effect-resource-policy/1', repositoryId: scopedGrants.repositoryId,
      astRoot: artifact.manifest.astRoot, policyEpoch: epochs.policyEpoch,
      rules: [{ capability: CAP_LEDGER_APPEND, prefix: ['ledger'], argument: 0, adapterId: 'deployment-ledger/1', adapterDigest: DEPLOYMENT_LEDGER_ADAPTER_DIGEST }] };
    assert.equal(effectResourcePolicyDigest(body), artifact.manifest.capabilityPolicyDigest);
    return { ...hostFactory(f.directory, artifact), scopedGrants,
      signedEffectResourcePolicy: signEffectResourcePolicy(body, 'deployment-policy', keys.privateKey),
      effectResourceSignerKey: keys.publicKey, currentEffectPolicyEpoch: () => epochs.policyEpoch };
  }]]);
  try {
    deployment = await ProcessDeployment.open({ ...f.options, capabilityProfile: 'scoped-v2', factories });
    const { alice, bob } = await accounts(deployment), args = [reference(alice), reference(bob), integer(10)];
    const aliceScope = new Map([[CAP_LEDGER_APPEND, ['ledger', 'alice']]]);
    const valid = await deployment.call(f.ex.symbols.transfer, args, { operationId: 'signed-deployment-valid', tokens: deployment.issueScopedTokens(f.ex.symbols.transfer, 60000, aliceScope) });
    assert.equal(valid.state, 'completed'); assert.equal(f.rows().length, 1);
    const bobScope = new Map([[CAP_LEDGER_APPEND, ['ledger', 'bob']]]);
    const denied = await deployment.call(f.ex.symbols.transfer, args, { operationId: 'signed-deployment-denied', tokens: deployment.issueScopedTokens(f.ex.symbols.transfer, 60000, bobScope) });
    assert.match(JSON.stringify(denied), /authority_denied|effect_indeterminate/); assert.equal(f.rows().length, 1);
  } finally { await deployment?.close(); rmSync(f.directory, { recursive: true, force: true }); }
});

test('F08 process deployment: rejected composition, approved migration/body change and rollback preserve real ledger state', async () => {
  const f = fixture(); let deployment: ProcessDeployment | undefined;
  try {
    deployment = await ProcessDeployment.open(f.options);
    const initialPids = Object.values(deployment.status().workerPids); assert.equal(new Set(initialPids).size, 2);
    const { alice, bob } = await accounts(deployment);
    const aliases = { t: 'Record' as const, name: typeName('type:deployment:aliases'), fields: [['left', ACCOUNT], ['right', ACCOUNT]] as const };
    await deployment.allocateRecord(aliases, { left: reference(alice), right: reference(alice) }, { operationId: 'aliases' });
    const first = await deployment.call(f.ex.symbols.transfer, [reference(alice), reference(bob), integer(10)], { operationId: 'transfer-v1', tokens: deployment.issueTokens(f.ex.symbols.transfer) });
    assert.equal(first.state, 'completed'); assert.deepEqual(await balances(deployment), ['90', '10']); assert.equal(f.rows().length, 1);
    const goodA = f.context('v2', 8, 10), goodB = f.context('v2', 10, 8), composed = f.context('v2', 8, 8);
    mintLocalEvidence(goodA); mintLocalEvidence(goodB); assert.throws(() => mintLocalEvidence(composed), /refuted|incomplete/);
    const approvedA = await f.proposal(deployment, goodA);
    await assert.rejects(deployment.promote({ ...approvedA, context: composed }), /stale|manifest/);
    assert.equal(deployment.servingManifest(), f.genesisManifest); assert.deepEqual(await balances(deployment), ['90', '10']); assert.equal(f.rows().length, 1);
    const input = await f.proposal(deployment);
    const oldTokens = deployment.issueTokens(f.ex.symbols.transfer);
    await deployment.promote(input);
    assert.equal(deployment.servingManifest(), input.proposal.candidateManifest); assert.equal(deployment.status().generation, '1');
    assert.deepEqual(await balances(deployment), ['90', '10']); assert.equal(f.rows().length, 1, 'isolated preparation invokes no live sink');
    const replayedOriginal = await deployment.call(f.ex.symbols.transfer, [reference(alice, '1'), reference(bob, '1'), integer(10)], { operationId: 'transfer-v1', tokens: deployment.issueTokens(f.ex.symbols.transfer) });
    assert.deepEqual(replayedOriginal, first); assert.equal(replayedOriginal.generation, '0', 'old receipt is not presented as execution of the new target');
    assert.equal(f.rows().length, 1); assert.deepEqual(await balances(deployment), ['90', '10']);
    await assert.rejects(deployment.call(f.ex.symbols.transfer, [reference(alice, '1'), reference(bob, '1'), integer(11)], { operationId: 'transfer-v1', tokens: deployment.issueTokens(f.ex.symbols.transfer) }), /identity conflict/);
    assert.ok(Object.values(deployment.status().workerPids).every(pid => !initialPids.includes(pid)));
    const moved = await deployment.snapshot();
    assert.deepEqual(plain(moved.records[2].fields.map(([, value]) => value)), [reference(alice, '1'), reference(alice, '1')]);
    assert.deepEqual(await deployment.allocateRecord(ACCOUNT, { id: text('alice'), balance: integer(100) }, { operationId: 'alice', unit: 'a' }), alice);
    assert.equal((await deployment.snapshot()).records.length, 3, 'allocation retry after promotion does not create another object');
    await assert.rejects(deployment.call(f.ex.symbols.transfer, [reference(alice, '1'), reference(bob, '1'), integer(5)], { operationId: 'old-grants', tokens: oldTokens }), /authority/);
    const args = [reference(alice, '1'), reference(bob, '1'), integer(5)];
    const transfer = await deployment.call(f.ex.symbols.transfer, args, { operationId: 'transfer-v2', tokens: deployment.issueTokens(f.ex.symbols.transfer) });
    assert.equal(transfer.state, 'completed'); assert.deepEqual(await balances(deployment), ['85', '15']); assert.equal(f.rows().length, 2);
    assert.equal(f.rows()[1].payload.items[1].value, 'v2:alice');
    assert.deepEqual(await deployment.call(f.ex.symbols.transfer, args, { operationId: 'transfer-v2', tokens: deployment.issueTokens(f.ex.symbols.transfer) }), transfer); assert.equal(f.rows().length, 2);
    const rollback = await f.proposal(deployment, f.original, f.plan());
    await deployment.promote(rollback);
    assert.equal(deployment.servingManifest(), f.genesisManifest); assert.equal(deployment.status().generation, '2'); assert.deepEqual(await balances(deployment), ['85', '15']);
    assert.deepEqual(await deployment.allocateRecord(ACCOUNT, { id: text('alice'), balance: integer(100) }, { operationId: 'alice', unit: 'a' }), alice);
    assert.equal((await deployment.snapshot()).records.length, 3);
    assert.deepEqual(await deployment.call(f.ex.symbols.transfer, [reference(alice, '2'), reference(bob, '2'), integer(5)], { operationId: 'transfer-v2', tokens: deployment.issueTokens(f.ex.symbols.transfer) }), transfer);
    assert.equal(f.rows().length, 2); assert.deepEqual(await balances(deployment), ['85', '15']);
    await deployment.call(f.ex.symbols.transfer, [reference(alice, '2'), reference(bob, '2'), integer(1)], { operationId: 'transfer-rollback', tokens: deployment.issueTokens(f.ex.symbols.transfer) });
    assert.deepEqual(await balances(deployment), ['84', '16']); assert.equal(f.rows().length, 3); assert.equal(f.rows()[2].payload.items[1].value, 'alice');
    const snapshot = await deployment.snapshot(); await deployment.close();
    deployment = await ProcessDeployment.open({ ...f.options, genesis: undefined });
    assert.deepEqual(await deployment.snapshot(), snapshot); assert.equal(f.rows().length, 3);
  } finally { await deployment?.close(); rmSync(f.directory, { recursive: true, force: true }); }
});

test('F08 process deployment: forged/stale approvals and changed schemas preserve serving state', async () => {
  const f = fixture(); let deployment: ProcessDeployment | undefined;
  try {
    deployment = await ProcessDeployment.open(f.options); await accounts(deployment);
    const input = await f.proposal(deployment);
    const forged = approvePromotion(input.proposal, 'governor', generateKeyPairSync('ed25519').privateKey);
    await assert.rejects(deployment.promote({ ...input, approval: forged }), /signature/);
    f.authority.policyEpoch = '2';
    const stale = await f.proposal(deployment, f.context('v3'));
    await assert.rejects(deployment.promote(stale), /stale/); f.authority.policyEpoch = '1';
    const ctx = f.context('v4'), module = ctx.module as Extract<Term, { kind: 'Module' }>;
    const changed = { ...ctx, module: { ...module, members: module.members.map(member => member.kind === 'TypeDecl' && member.name === 'type:deployment:marker' ? { ...member, ty: b.Bool } : member) } };
    const schema = await f.proposal(deployment, changed);
    await assert.rejects(deployment.promote(schema), /changed types/);
    assert.equal(deployment.servingManifest(), f.genesisManifest); assert.deepEqual(await balances(deployment), ['100', '0']); assert.equal(f.rows().length, 0);
  } finally { await deployment?.close(); rmSync(f.directory, { recursive: true, force: true }); }
});

test('F08 process deployment: preparation freezes source calls and postcommit activation failure blocks old-root serving until recovery', async () => {
  const f = fixture(); let deployment: ProcessDeployment | undefined;
  let failActivation = true, prepared = false;
  try {
    deployment = await ProcessDeployment.open({ ...f.options, phase: (phase, detail) => {
      if (phase === 'prepared') { prepared = true; assert.equal(Object.keys(detail.workerPids).length, 2); assert.equal(f.rows().length, 0); assert.throws(() => deployment!.issueTokens(f.ex.symbols.transfer), /frozen/); }
      if (phase === 'before-activation' && failActivation) throw new Error('activation interrupted');
    } });
    await accounts(deployment); const input = await f.proposal(deployment);
    await assert.rejects(deployment.promote(input), /activation interrupted/); assert.equal(prepared, true);
    assert.equal(f.coordinator.state().committedManifest, input.proposal.candidateManifest); assert.equal(f.coordinator.state().activationPending, true);
    assert.throws(() => deployment!.servingManifest(), /blocked/);
    await assert.rejects(deployment.call(f.ex.symbols.feeFor, [integer(100)], { operationId: 'must-not-serve-old', tokens: [] }), /blocked/);
    failActivation = false; await deployment.recover();
    assert.equal(deployment.servingManifest(), input.proposal.candidateManifest); assert.deepEqual(await balances(deployment), ['100', '0']); assert.equal(f.rows().length, 0);
  } finally { await deployment?.close(); rmSync(f.directory, { recursive: true, force: true }); }
});

test('F08 process deployment: in-flight source writes drain before preparation and invalidate stale snapshot approval', async () => {
  const f = fixture(); let deployment: ProcessDeployment | undefined;
  try {
    deployment = await ProcessDeployment.open(f.options); const { alice, bob } = await accounts(deployment);
    const approval = await f.proposal(deployment);
    const call = deployment.call(f.ex.symbols.transfer, [reference(alice), reference(bob), integer(10)], { operationId: 'racing-transfer', tokens: deployment.issueTokens(f.ex.symbols.transfer) });
    const promotion = deployment.promote(approval);
    assert.equal((await call).state, 'completed');
    await assert.rejects(promotion, /snapshot.*stale/);
    assert.equal(deployment.servingManifest(), f.genesisManifest); assert.deepEqual(await balances(deployment), ['90', '10']); assert.equal(f.rows().length, 1);
  } finally { await deployment?.close(); rmSync(f.directory, { recursive: true, force: true }); }
});

function crashPromotion(f: ReturnType<typeof fixture>, input: PromotionInput, phase: string, invocation?: { symbol: string; args: readonly TaggedValueV1[]; operationId: string }) {
  const publicKey = join(f.directory, 'governor-public.pem');
  writeFileSync(publicKey, f.keys.publicKey.export({ type: 'spki', format: 'pem' }));
  const inputFile = join(f.directory, 'promotion-input.json');
  const { context: _context, ...serializable } = input; writeFileSync(inputFile, JSON.stringify({ ...serializable, invocation: invocation ?? null }));
  const script = `
    import {existsSync,readFileSync,writeFileSync} from 'node:fs';
    import {createPublicKey} from 'node:crypto';
    import {join} from 'node:path';
    import {CapabilitySealer} from ${JSON.stringify(new URL('../../src/tier2/ocap.ts', import.meta.url).href)};
    import {CAP_LEDGER_APPEND} from ${JSON.stringify(new URL('../../src/examples/ledger.ts', import.meta.url).href)};
    import {atomicWrite} from ${JSON.stringify(new URL('../../src/tier1/persistence.ts', import.meta.url).href)};
    import {BrokerEffectRouter} from ${JSON.stringify(new URL('../../src/tier3/effects.ts', import.meta.url).href)};
    import {DurableEffectBroker} from ${JSON.stringify(new URL('../../src/fabric/effects.ts', import.meta.url).href)};
    import {JournalLock} from ${JSON.stringify(new URL('../../src/fabric/journal-lock.ts', import.meta.url).href)};
    import {domainDigest} from ${JSON.stringify(new URL('../../src/fabric/identity.ts', import.meta.url).href)};
    import {PromotionCoordinator} from ${JSON.stringify(new URL('../../src/fabric/promotion.ts', import.meta.url).href)};
    import {ProcessDeployment,processArtifactContext} from ${JSON.stringify(new URL('../../src/tier4/process-deployment.ts', import.meta.url).href)};
    const hostFactory=${hostFactory.toString()};
    const [directory,inputFile,publicKeyFile,genesis,phase]=process.argv.slice(1);
    const coordinator=new PromotionCoordinator({profile:'baseline-governor-v1',directory:join(directory,'coordinator'),repositoryId:'deployment-test',genesisManifest:genesis,
      authority:()=>({repositoryId:'deployment-test',membershipEpoch:'1',policyEpoch:'1',eligibleGovernors:['governor']}),governorKey:()=>createPublicKey(readFileSync(publicKeyFile)),clock:()=>100n,
      fault:point=>{if(point===phase)process.kill(process.pid,'SIGKILL');}});
    let deployment;
    deployment=await ProcessDeployment.open({directory:join(directory,'driver'),coordinator,capabilityProfile:'legacy-sealed-v1',factories:new Map([['ledger-services/1',artifact=>({...hostFactory(directory,artifact),onPhase:point=>{if(point===phase)process.kill(process.pid,'SIGKILL');}})]]),
      phase:(point,detail)=>{writeFileSync(join(directory,'promotion-worker-pids.json'),JSON.stringify([...new Set([...Object.values(detail.workerPids),...Object.values(deployment.status().workerPids)])]));}});
    writeFileSync(join(directory,'promotion-worker-pids.json'),JSON.stringify(Object.values(deployment.status().workerPids)));
    const input=JSON.parse(readFileSync(inputFile,'utf8'));
    if(input.invocation){
      writeFileSync(join(directory,'promotion-worker-pids.json'),JSON.stringify(Object.values(deployment.status().workerPids)));
      await deployment.call(input.invocation.symbol,input.invocation.args,{operationId:input.invocation.operationId,tokens:deployment.issueTokens(input.invocation.symbol)});
    }else await deployment.promote({...input,context:processArtifactContext(deployment.artifact(input.proposal.candidateManifest))});
    await deployment.close();
  `;
  return spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', script, f.directory, inputFile, publicKey, f.genesisManifest, phase], { encoding: 'utf8', timeout: 15000 });
}

test('F08 process deployment: actual coordinator death before/after commit reloads artifacts and follows only durable decision', async () => {
  for (const phase of ['after-candidate', 'after-validated', 'after-authorized', 'after-prepared', 'after-commit', 'after-activation']) {
    const f = fixture(); let deployment: ProcessDeployment | undefined;
    try {
      deployment = await ProcessDeployment.open(f.options); const { alice, bob } = await accounts(deployment);
      await deployment.call(f.ex.symbols.transfer, [reference(alice), reference(bob), integer(10)], { operationId: 'before-crash', tokens: deployment.issueTokens(f.ex.symbols.transfer) });
      const input = await f.proposal(deployment); await deployment.close(); deployment = undefined;
      const child = crashPromotion(f, input, phase);
      assert.equal(child.signal, 'SIGKILL', child.stderr);
      const pids: number[] = JSON.parse(readFileSync(join(f.directory, 'promotion-worker-pids.json'), 'utf8')); assert.ok(pids.length >= 2);
      for (const pid of pids) {
        let alive = true;
        for (let attempt = 0; attempt < 100; attempt++) { try { process.kill(pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; alive = false; break; } await delay(10); }
        assert.equal(alive, false, 'dead coordinator must leave no runnable child');
      }
      const coordinator = new PromotionCoordinator(f.coordinatorOptions); coordinator.recoverDeadWriter();
      deployment = await ProcessDeployment.open({ ...f.options, coordinator, genesis: undefined });
      if (phase === 'after-commit') { assert.throws(() => deployment!.servingManifest(), /blocked/); assert.deepEqual(deployment.status().workerPids, {}); }
      await deployment.recover();
      const committed = phase === 'after-commit' || phase === 'after-activation';
      assert.equal(deployment.servingManifest(), committed ? input.proposal.candidateManifest : f.genesisManifest);
      assert.deepEqual(await balances(deployment), ['90', '10']); assert.equal(f.rows().length, 1);
      const epoch = deployment.status().generation;
      const original = await deployment.call(f.ex.symbols.transfer, [reference(alice, epoch), reference(bob, epoch), integer(10)], { operationId: 'before-crash', tokens: deployment.issueTokens(f.ex.symbols.transfer) });
      assert.equal(original.generation, '0'); assert.equal(f.rows().length, 1);
      await deployment.call(f.ex.symbols.transfer, [reference(alice, epoch), reference(bob, epoch), integer(5)], { operationId: 'after-recovery', tokens: deployment.issueTokens(f.ex.symbols.transfer) });
      assert.deepEqual(await balances(deployment), ['85', '15']); assert.equal(f.rows().length, 2);
    } finally { await deployment?.close(); rmSync(f.directory, { recursive: true, force: true }); }
  }
});

test('F08 process deployment: receipt loss after inner durable commit recovers original invocation without another append', async () => {
  const f = fixture(); let deployment: ProcessDeployment | undefined;
  try {
    deployment = await ProcessDeployment.open(f.options); const { alice, bob } = await accounts(deployment);
    const input = await f.proposal(deployment); await deployment.close(); deployment = undefined;
    const request = { symbol: f.ex.symbols.transfer, args: [reference(alice), reference(bob), integer(10)], operationId: 'lost-wrapper-receipt' };
    const child = crashPromotion(f, input, 'call-committed', request); assert.equal(child.signal, 'SIGKILL', child.stderr);
    deployment = await ProcessDeployment.open({ ...f.options, genesis: undefined });
    assert.equal(f.rows().length, 1); assert.deepEqual(await balances(deployment), ['90', '10']);
    const retry = await deployment.call(request.symbol, request.args, { operationId: request.operationId, tokens: deployment.issueTokens(request.symbol) });
    assert.equal(retry.state, 'indeterminate'); assert.equal(f.rows().length, 1);
    await assert.rejects(deployment.promote(input), /unresolved/);
    const recovered = await deployment.recoverOperation(request.operationId);
    assert.equal(recovered.state, 'completed'); assert.equal(recovered.generation, '0'); assert.equal(f.rows().length, 1);
    const next = await f.proposal(deployment, f.context('v3')); await deployment.promote(next);
    assert.deepEqual(await deployment.call(request.symbol, [reference(alice, '1'), reference(bob, '1'), integer(10)], { operationId: request.operationId, tokens: deployment.issueTokens(request.symbol) }), recovered);
    assert.deepEqual(await balances(deployment), ['90', '10']); assert.equal(f.rows().length, 1);
  } finally { await deployment?.close(); rmSync(f.directory, { recursive: true, force: true }); }
});

test('F08 process deployment: outer intent without inner execution needs authorized abort, while committed receipt survives observer failure', async () => {
  const f = fixture(); let deployment: ProcessDeployment | undefined;
  let fault: 'after-intent' | 'after-receipt' | null = 'after-intent';
  try {
    deployment = await ProcessDeployment.open({ ...f.options, invocationPhase: point => { if (point === fault) throw new Error(`injected ${point}`); } });
    const { alice, bob } = await accounts(deployment);
    const args = [reference(alice), reference(bob), integer(10)];
    await assert.rejects(deployment.call(f.ex.symbols.transfer, args, { operationId: 'before-inner', tokens: deployment.issueTokens(f.ex.symbols.transfer) }), /after-intent/);
    assert.equal(f.rows().length, 0); assert.deepEqual(await balances(deployment), ['100', '0']);
    await assert.rejects(deployment.recoverOperation('before-inner'), /abort-before-effects/);
    assert.equal((await deployment.recoverOperation('before-inner', { strategy: 'abort-before-effects' })).state, 'aborted');
    fault = 'after-receipt';
    const result = await deployment.call(f.ex.symbols.transfer, args, { operationId: 'after-receipt', tokens: deployment.issueTokens(f.ex.symbols.transfer) });
    assert.equal(result.state, 'completed'); assert.equal(f.rows().length, 1); assert.deepEqual(await balances(deployment), ['90', '10']);
    fault = null;
    const input = await f.proposal(deployment); await deployment.promote(input);
    assert.deepEqual(await deployment.call(f.ex.symbols.transfer, [reference(alice, '1'), reference(bob, '1'), integer(10)], { operationId: 'after-receipt', tokens: deployment.issueTokens(f.ex.symbols.transfer) }), result);
    assert.equal(f.rows().length, 1);
  } finally { await deployment?.close(); rmSync(f.directory, { recursive: true, force: true }); }
});

test('F08 review: invalid typed allocations and calls are rejected before outer intents and do not wedge the deployment', async () => {
  const f = fixture(); let deployment: ProcessDeployment | undefined;
  try {
    deployment = await ProcessDeployment.open(f.options);
    const path = join(f.options.directory, 'deployment.json');
    const before = readFileSync(path, 'utf8');
    await assert.rejects(deployment.allocateRecord(ACCOUNT, { id: text('bad'), balance: text('not an integer') }, { operationId: 'invalid-allocation' }), /type mismatch/);
    await assert.rejects(deployment.allocateRecord(ACCOUNT, { id: text('bad') }, { operationId: 'missing-field' }), /fields/);
    assert.equal(readFileSync(path, 'utf8'), before);
    await assert.rejects(deployment.call(f.ex.symbols.feeFor, [text('not an integer')], { operationId: 'invalid-call', tokens: deployment.issueTokens(f.ex.symbols.feeFor) }), /type mismatch/);
    await assert.rejects(deployment.call(f.ex.symbols.feeFor, [], { operationId: 'invalid-arity', tokens: deployment.issueTokens(f.ex.symbols.feeFor) }), /arity/);
    assert.equal(readFileSync(path, 'utf8'), before);
    const { alice, bob } = await accounts(deployment);
    assert.equal((await deployment.call(f.ex.symbols.transfer, [reference(alice), reference(bob), integer(10)], { operationId: 'valid-after-invalid', tokens: deployment.issueTokens(f.ex.symbols.transfer) })).state, 'completed');
    assert.deepEqual(await balances(deployment), ['90', '10']); assert.equal(f.rows().length, 1);
    const input = await f.proposal(deployment); await deployment.promote(input);
    assert.equal(deployment.servingManifest(), input.proposal.candidateManifest);
  } finally { await deployment?.close(); rmSync(f.directory, { recursive: true, force: true }); }
});

test('F08 review: cached receipts and fresh intents recheck revocation after the awaited source snapshot', async () => {
  const f = fixture(); let deployment: ProcessDeployment | undefined;
  const revocations = new RevocationList();
  const original = ProcessHost.prototype.snapshot;
  let revokeAfterSnapshot = false;
  try {
    deployment = await ProcessDeployment.open({ ...f.options, factories: new Map([['ledger-services/1', artifact => ({ ...hostFactory(f.directory, artifact), revocations })]]) });
    const symbol = f.ex.symbols.feeFor;
    const receipt = await deployment.call(symbol, [integer(100)], { operationId: 'cached', tokens: deployment.issueTokens(symbol) });
    assert.equal(receipt.state, 'completed');
    const path = join(f.options.directory, 'deployment.json'), before = readFileSync(path, 'utf8');
    ProcessHost.prototype.snapshot = async function () {
      const snapshot = await original.call(this);
      if (revokeAfterSnapshot) revocations.revoke(PROCESS_INVOKE, { by: 'review-test' });
      return snapshot;
    };
    revokeAfterSnapshot = true;
    await assert.rejects(deployment.call(symbol, [integer(100)], { operationId: 'cached', tokens: deployment.issueTokens(symbol) }), /revoked/);
    assert.equal(readFileSync(path, 'utf8'), before);
    revocations.restore(PROCESS_INVOKE);
    await assert.rejects(deployment.call(symbol, [integer(200)], { operationId: 'fresh-revoked', tokens: deployment.issueTokens(symbol) }), /revoked/);
    assert.equal(readFileSync(path, 'utf8'), before);
    revokeAfterSnapshot = false; revocations.restore(PROCESS_INVOKE);
    assert.deepEqual(await deployment.call(symbol, [integer(100)], { operationId: 'cached', tokens: deployment.issueTokens(symbol) }), receipt);
  } finally { ProcessHost.prototype.snapshot = original; await deployment?.close(); rmSync(f.directory, { recursive: true, force: true }); }
});

test('F08 review: recovery freezes strategy and rechecks permission after awaits and before receipt publication', async () => {
  const f = fixture(); let deployment: ProcessDeployment | undefined;
  let allowed = true, fault: 'after-intent' | 'after-host-result' | null = 'after-intent';
  const checked: string[] = [];
  const original = ProcessHost.prototype.recoverOperation;
  try {
    deployment = await ProcessDeployment.open({ ...f.options,
      factories: new Map([['ledger-services/1', artifact => ({ ...hostFactory(f.directory, artifact), authorizeRecovery: (_id, strategy) => { checked.push(strategy); return allowed; } })]]),
      invocationPhase: phase => { if (phase === fault) throw new Error('held for recovery'); },
    });
    const symbol = f.ex.symbols.feeFor;
    await assert.rejects(deployment.call(symbol, [integer(100)], { operationId: 'held', tokens: deployment.issueTokens(symbol) }), /held/);
    const path = join(f.options.directory, 'deployment.json'), before = readFileSync(path, 'utf8');
    const options: { strategy: 'abort-before-effects' | 'isolated-replay' } = { strategy: 'abort-before-effects' };
    const recovery = deployment.recoverOperation('held', options);
    allowed = false; options.strategy = 'isolated-replay';
    await assert.rejects(recovery, /authorization denied/);
    assert.equal(readFileSync(path, 'utf8'), before);
    assert.ok(checked.length >= 2); assert.ok(checked.every(strategy => strategy === 'abort-before-effects'));
    allowed = true;
    const frozenOptions: { strategy: 'abort-before-effects' | 'isolated-replay' } = { strategy: 'abort-before-effects' };
    const permitted = deployment.recoverOperation('held', frozenOptions); frozenOptions.strategy = 'isolated-replay';
    assert.equal((await permitted).state, 'aborted');
    fault = 'after-host-result';
    await assert.rejects(deployment.call(symbol, [integer(200)], { operationId: 'inner-completed', tokens: deployment.issueTokens(symbol) }), /held/);
    const beforeInnerRecovery = readFileSync(path, 'utf8');
    ProcessHost.prototype.recoverOperation = async function (operationId, request) {
      const result = await original.call(this, operationId, request); allowed = false; return result;
    };
    await assert.rejects(deployment.recoverOperation('inner-completed'), /authorization denied/);
    assert.equal(readFileSync(path, 'utf8'), beforeInnerRecovery);
    ProcessHost.prototype.recoverOperation = original; allowed = true; fault = null;
    assert.equal((await deployment.recoverOperation('inner-completed')).state, 'completed');
    assert.equal(f.rows().length, 0);
  } finally { ProcessHost.prototype.recoverOperation = original; await deployment?.close(); rmSync(f.directory, { recursive: true, force: true }); }
});

test('asynchronous deployment recovery policy is denied before host recovery or receipt publication', async () => {
  const f = fixture(); let deployment: ProcessDeployment | undefined;
  try {
    deployment = await ProcessDeployment.open({ ...f.options,
      factories: new Map([['ledger-services/1', artifact => ({ ...hostFactory(f.directory, artifact),
        authorizeRecovery: (() => Promise.resolve(true)) as unknown as () => boolean })]]),
      invocationPhase: phase => { if (phase === 'after-intent') throw new Error('held for recovery'); },
    });
    const symbol = f.ex.symbols.feeFor;
    await assert.rejects(deployment.call(symbol, [integer(100)], { operationId: 'async-held', tokens: deployment.issueTokens(symbol) }), /held/);
    const path = join(f.options.directory, 'deployment.json'), before = readFileSync(path, 'utf8');
    await assert.rejects(deployment.recoverOperation('async-held'), /recovery authorization denied/);
    assert.equal(readFileSync(path, 'utf8'), before);
  } finally { await deployment?.close(); rmSync(f.directory, { recursive: true, force: true }); }
});

test('F08 review: repeated manifest activation rejects historical ABA handles without changing workers or serving generation', async () => {
  const f = fixture(); let deployment: ProcessDeployment | undefined;
  try {
    deployment = await ProcessDeployment.open(f.options); await accounts(deployment);
    const first = await f.proposal(deployment); await deployment.promote(first);
    const historical = f.coordinator.history().find(record => record.binding.generation === '1')!;
    await deployment.promote(await f.proposal(deployment, f.original, f.plan()));
    await deployment.promote(await f.proposal(deployment));
    assert.equal(f.coordinator.state().generation, '3'); assert.equal(deployment.servingManifest(), first.proposal.candidateManifest);
    const before = deployment.status(), snapshot = await deployment.snapshot();
    await assert.rejects(deployment.activate(historical.binding, historical.handle!), /exact current durable commit/);
    assert.deepEqual(deployment.status(), before); assert.deepEqual(await deployment.snapshot(), snapshot);
    assert.equal(deployment.status().generation, '3');
    const current = f.coordinator.history().filter(record => record.phase === 'active').at(-1)!;
    await deployment.activate(current.binding, current.handle!);
    assert.deepEqual(deployment.status(), before); assert.equal(f.rows().length, 0);
  } finally { await deployment?.close(); rmSync(f.directory, { recursive: true, force: true }); }
});

test('deployment cached receipts retain historical capability authority when a later declaration weakens', async () => {
  const f=fixture();let deployment:ProcessDeployment|undefined;
  try {
    const base=f.original.module as Extract<Term,{kind:'Module'}>;
    const module:Term={...base,members:base.members.filter(member=>member.kind!=='FunctionDecl'||member.symbol===f.ex.symbols.feeFor)};
    const current={...f.original,module}, historical={...current,module:{...module,members:module.members.map(member=>member.kind==='FunctionDecl'?{...member,purity:'effectful' as const,capabilities:[CAP_LEDGER_APPEND]}:member)}};
    const evidence=mintLocalEvidence(historical);
    const coordinator=new PromotionCoordinator({...f.coordinatorOptions,directory:join(f.directory,'historical-coordinator'),genesisManifest:executionManifestDigest(evidence.manifest)});
    const plan:TopologyPlan={...f.plan(),units:[{id:'a',members:[f.ex.symbols.feeFor],capabilities:[CAP_LEDGER_APPEND],placement:'container',memoryMb:32}]};
    deployment=await ProcessDeployment.open({...f.options,coordinator,genesis:{context:historical,evidence,plan,factoryId:'ledger-services/1'}});
    const first=await deployment.call(f.ex.symbols.feeFor,[integer(100)],{operationId:'protected-result',tokens:deployment.issueTokens(f.ex.symbols.feeFor)});
    assert.equal(first.state,'completed');
    const next=mintLocalEvidence(current),artifact=deployment.registerArtifact({context:current,evidence:next,plan:{...plan,units:plan.units.map(unit=>({...unit,capabilities:[]}))},factoryId:'ledger-services/1'});
    const migrationPlan=processMigrationPlan(await deployment.snapshot(),artifact),effectPlan=processEffectPlan('ledger-services/1',next.manifest.capabilityPolicyDigest);
    const proposal={format:'aether.promotion/1' as const,repositoryId:f.authority.repositoryId,expectedParent:coordinator.state().committedManifest,candidateManifest:executionManifestDigest(next.manifest),evidenceBundleDigest:evidenceBundleDigest(next),migrationPlanDigest:migrationPlanDigest(migrationPlan),effectPlanDigest:effectPlanDigest(effectPlan),membershipEpoch:'1',policyEpoch:'1',expiresAt:'1000'};
    await deployment.promote({proposal,approval:approvePromotion(proposal,'governor',f.keys.privateKey),evidence:next,context:current,migrationPlan,effectPlan});
    const before=readFileSync(join(f.options.directory,'deployment.json'),'utf8');
    await assert.rejects(deployment.call(f.ex.symbols.feeFor,[integer(100)],{operationId:'protected-result',tokens:deployment.issueTokens(f.ex.symbols.feeFor)}),/historical invocation requires authority/);
    assert.equal(readFileSync(join(f.options.directory,'deployment.json'),'utf8'),before,'historical receipt retained without redispatch');
    const fresh=await deployment.call(f.ex.symbols.feeFor,[integer(100)],{operationId:'current-result',tokens:deployment.issueTokens(f.ex.symbols.feeFor)});
    assert.equal(fresh.state,'completed');assert.equal(fresh.generation,'1');
  } finally {await deployment?.close();rmSync(f.directory,{recursive:true,force:true});}
});

test('deployment legacy profile adoption is explicit and preserves durable receipts', async () => {
  const f=fixture();let deployment:ProcessDeployment|undefined;
  try {
    deployment=await ProcessDeployment.open(f.options);await accounts(deployment);
    await deployment.call(f.ex.symbols.feeFor,[integer(100)],{operationId:'legacy-result',tokens:deployment.issueTokens(f.ex.symbols.feeFor)});
    await deployment.close();deployment=undefined;
    const file=join(f.options.directory,'deployment.json'), state=JSON.parse(readFileSync(file,'utf8'));
    const legacy={...state,format:'aether.process-deployment/1'};delete legacy.admissionProfile;delete legacy.capabilityProfile;
    writeFileSync(file,JSON.stringify(legacy));const original=readFileSync(file,'utf8');
    await assert.rejects(ProcessDeployment.open({...f.options,genesis:undefined}),/explicit baseline migration/);assert.equal(readFileSync(file,'utf8'),original);
    deployment=await ProcessDeployment.open({...f.options,genesis:undefined,legacyProfileMigration:'adopt-baseline-v1'});
    assert.deepEqual(JSON.parse(readFileSync(file,'utf8')),state);assert.equal(deployment.status().servingReady,true);
  } finally {await deployment?.close();rmSync(f.directory,{recursive:true,force:true});}
});

test('fresh production deployment defaults to scoped authority and refuses a legacy factory', async () => {
  const f = fixture(); let deployment: ProcessDeployment | undefined;
  try {
    await assert.rejects(ProcessDeployment.open({ ...f.options, capabilityProfile: undefined }), /trusted deployment factory does not match durable capability profile/);
    assert.equal(existsSync(join(f.options.directory, 'deployment.json')), false, 'authority mismatch cannot publish a durable genesis');
    deployment = await ProcessDeployment.open(f.options);
    const state = JSON.parse(readFileSync(join(f.options.directory, 'deployment.json'), 'utf8'));
    assert.equal(state.format, 'aether.process-deployment/3');
    assert.equal(state.capabilityProfile, 'legacy-sealed-v1');
    await deployment.close(); deployment = undefined;
    await assert.rejects(ProcessDeployment.open({ ...f.options, capabilityProfile: undefined }), /readiness\/profile/);
  } finally { await deployment?.close(); rmSync(f.directory, { recursive: true, force: true }); }
});

test('v2 capability history needs explicit legacy adoption and retains settled calls', async () => {
  const f = fixture(); let deployment: ProcessDeployment | undefined;
  try {
    deployment = await ProcessDeployment.open(f.options);
    const result = await deployment.call(f.ex.symbols.feeFor, [integer(100)], { operationId: 'v2-receipt', tokens: deployment.issueTokens(f.ex.symbols.feeFor) });
    await deployment.close(); deployment = undefined;
    const file = join(f.options.directory, 'deployment.json'), current = JSON.parse(readFileSync(file, 'utf8'));
    const legacy = { ...current, format: 'aether.process-deployment/2' }; delete legacy.capabilityProfile;
    writeFileSync(file, JSON.stringify(legacy)); const original = readFileSync(file, 'utf8');
    await assert.rejects(ProcessDeployment.open({ ...f.options, genesis: undefined }), /explicit legacy capability migration/);
    assert.equal(readFileSync(file, 'utf8'), original);
    await assert.rejects(ProcessDeployment.open({ ...f.options, genesis: undefined, capabilityProfile: 'scoped-v2', legacyCapabilityMigration: 'adopt-legacy-sealed-v1' }), /explicit legacy capability migration/);
    assert.equal(readFileSync(file, 'utf8'), original);
    const scopedGrants = new ScopedGrantAuthority({ key: new Uint8Array(32).fill(49), repositoryId: 'deployment-test', clock: () => 100,
      policyEpoch: () => '0', revocationEpoch: () => '0', isRevoked: () => false, authorizeIssue: () => true, authorizeDelegate: () => true });
    await assert.rejects(ProcessDeployment.open({ ...f.options, genesis: undefined, legacyCapabilityMigration: 'adopt-legacy-sealed-v1',
      factories: new Map([['ledger-services/1', (artifact: ProcessArtifactV1) => ({ ...hostFactory(f.directory, artifact), scopedGrants })]]) }), /trusted deployment factory does not match durable capability profile/);
    assert.equal(readFileSync(file, 'utf8'), original, 'failed adoption cannot rewrite v2 bytes');
    deployment = await ProcessDeployment.open({ ...f.options, genesis: undefined, legacyCapabilityMigration: 'adopt-legacy-sealed-v1' });
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), current);
    assert.deepEqual(await deployment.call(f.ex.symbols.feeFor, [integer(100)], { operationId: 'v2-receipt', tokens: deployment.issueTokens(f.ex.symbols.feeFor) }), result);
  } finally { await deployment?.close(); rmSync(f.directory, { recursive: true, force: true }); }
});
