import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, openSync, fsyncSync, closeSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { buildLedgerExample, ACCOUNT, CENTS, CAP_LEDGER_APPEND } from '../../src/examples/ledger.ts';
import { CapabilitySealer, CapabilityRegistry, RevocationList } from '../../src/tier2/ocap.ts';
import { ScopedGrantAuthority } from '../../src/tier2/scoped-grants.ts';
import { DurableGrantEpochs } from '../../src/tier2/grant-epochs.ts';
import { effectResourcePolicyDigest, effectResourcePolicyDigestV2, effectResourcePolicyDigestV3, signEffectResourcePolicy, signEffectResourcePolicyV2, signEffectResourcePolicyV3, type EffectResourcePolicyBodyV1, type EffectResourcePolicyBodyV2, type EffectResourcePolicyBodyV3 } from '../../src/tier2/effect-resource-policy.ts';
import { createEffectSignerAnchor } from '../../src/tier2/effect-signer-anchor.ts';
import { adapterArtifactForSource, legacyAdapterArtifactForSource, admitAdapterSource, admittedAdapterArtifactDigest } from '../../src/tier2/adapter-artifact.ts';
import { createEvidenceManifest } from '../../src/fabric/evidence.ts';
import { domainDigest } from '../../src/fabric/identity.ts';
import { DurableEffectBroker, effectAdapterDigest, type EffectAdapter } from '../../src/fabric/effects.ts';
import type { TaggedValueV1, LogicalRefV1 } from '../../src/fabric/encoding.ts';
import { BrokerEffectRouter } from '../../src/tier3/effects.ts';
import { ProcessHost, PROCESS_INVOKE, type ProcessHostOptions, type ProcessEffectContext } from '../../src/tier4/process-host.ts';
import type { TopologyPlan } from '../../src/tier4/topology.ts';
import type { Term, Ty } from '../../src/tier1/ast.ts';
import type { CapabilityName } from '../../src/tier1/ids.ts';
import { typeName } from '../../src/tier1/ids.ts';
import { SymbolSpace } from '../../src/tier1/symbols.ts';
import * as b from '../../src/tier1/build.ts';

const integer = (value: bigint | number): TaggedValueV1 => ({ tag: 'int', value: String(value) });
const text = (value: string): TaggedValueV1 => ({ tag: 'string', value });
const reference = (value: LogicalRefV1): TaggedValueV1 => ({ tag: 'ref', value });
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
function manifest(module: Term, registry: CapabilityRegistry) {
  const digest = (value: string) => domainDigest('aether.process-host-test/1', value);
  return createEvidenceManifest({ module, registry, specification: 'Durable process-host test behavior.', semanticsVersion: 'reference/1', compilerDigest: digest('compiler'), capabilityPolicyDigest: digest('policy'), target: { abiVersion: 'process/1', profileDigest: digest('profile'), artifactDigest: digest('artifact') } });
}
function factory(directory: string, manifestValue: ReturnType<typeof manifest>, capability: CapabilityName, sink: EffectAdapter) {
  return (context: ProcessEffectContext) => {
    const effectDirectory = join(directory, 'effects', domainDigest('aether.effect-directory/1', context.operationId).split(':').at(-1)!);
    const live = new DurableEffectBroker({ directory: effectDirectory, clockDomain: 'test-clock/1', clock: () => 100n, authorize: () => true });
    const broker = context.mode === 'live' ? live : new DurableEffectBroker({ directory: effectDirectory, mode: 'replay', clockDomain: 'test-clock/1', clock: () => 100n, authorize: () => false, replayEvents: live.events() });
    return new BrokerEffectRouter({ broker, manifest: manifestValue, executionId: context.operationId, policyEpoch: '1', deadline: '1000', adapters: new Map([[capability, sink]]), grant: () => 'grant:process-test' });
  };
}
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'aether-process-host-'));
  const ex = buildLedgerExample('process-host-ledger');
  const plan: TopologyPlan = { shape: 'containers', units: [
    { id: 'a', members: [ex.symbols.transfer], capabilities: [CAP_LEDGER_APPEND], placement: 'container', memoryMb: 16 },
    { id: 'b', members: [ex.symbols.feeFor, ex.symbols.settle, ex.symbols.accrue], capabilities: [CAP_LEDGER_APPEND], placement: 'container', memoryMb: 48 },
  ], crossEdges: [], transportLatencyMsPerSecond: 0, monthlyCost: 0, recombinations: [], blockedMerges: [] };
  const manifestValue = manifest(ex.module, ex.capabilities), revocations = new RevocationList();
  let calls = 0;
  const sink: EffectAdapter = { id: 'ledger-sink/1', semantics: { readOnly: false, atomicIdempotency: false, transactional: false, reconciliation: true }, execute: () => { calls++; return { tag: 'null' }; }, reconcile: () => ({ state: 'unknown' }) };
  const options: ProcessHostOptions = { directory, module: ex.module, manifest: manifestValue, plan, registry: ex.capabilities, sealer: new CapabilitySealer(new Uint8Array(32).fill(7), () => 100), revocations, effectRouterFactory: factory(directory, manifestValue, CAP_LEDGER_APPEND, sink), authorizeRecovery: () => true };
  return { directory, ex, options, revocations, calls: () => calls, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}
function balances(snapshot: Awaited<ReturnType<ProcessHost['snapshot']>>): string[] {
  return snapshot.records.map(record => {
    const value = record.fields.find(([name]) => name === 'balance')?.[1];
    return value?.tag === 'int' ? value.value : '?';
  });
}

function scopedAuthority(directory: string) {
  const epochs = new DurableGrantEpochs({ directory: join(directory, 'grant-epochs'), repositoryId: 'repository' });
  let now = 100;
  const grants = new ScopedGrantAuthority({ key: new Uint8Array(32).fill(29), repositoryId: 'repository', clock: () => now,
    policyEpoch: () => epochs.policyEpoch, revocationEpoch: () => epochs.epoch,
    isRevoked: (cap, path) => epochs.isRevoked(cap, path), authorizeIssue: () => true,
    authorizeDelegate: () => true });
  return { epochs, grants, setTime: (value: number) => { now = value; } };
}

test('strict ProcessHost grants bind real worker calls to audience, generation and durable revocation', async () => {
  const f = fixture(), { epochs, grants, setTime } = scopedAuthority(f.directory); let host: ProcessHost | undefined;
  try {
    host = await ProcessHost.open({ ...f.options, scopedGrants: grants });
    assert.throws(() => host!.issueTokens(f.ex.symbols.transfer), /strict ProcessHost/);
    const alice = await host.allocateRecord(ACCOUNT, { id: text('alice'), balance: integer(100) }, { operationId: 'alice' });
    const bob = await host.allocateRecord(ACCOUNT, { id: text('bob'), balance: integer(0) }, { operationId: 'bob' });
    const args = [reference(alice), reference(bob), integer(10)];
    await assert.rejects(host.call(f.ex.symbols.transfer, args, { operationId: 'wrong-audience', tokens: host.issueScopedTokens(f.ex.symbols.settle) }), /authority_denied/);
    assert.equal(f.calls(), 0);
    const original = host.issueScopedTokens(f.ex.symbols.transfer);
    await assert.rejects(host.call(f.ex.symbols.transfer, args, { operationId: 'forged-signature', tokens: [{ ...original[0], signature: '0'.repeat(64) }, ...original.slice(1)] }), /authority_denied/);
    const wrongScope = grants.issue({ capability: CAP_LEDGER_APPEND, audience: f.ex.symbols.transfer, path: ['wrong'] }, 60000);
    await assert.rejects(host.call(f.ex.symbols.transfer, args, { operationId: 'wrong-resource', tokens: [original[0], wrongScope] }), /authority_denied/);
    assert.equal(f.calls(), 0);
    assert.equal((await host.call(f.ex.symbols.transfer, args, { operationId: 'strict-valid', tokens: original })).state, 'completed');
    assert.equal(f.calls(), 1);
    epochs.revoke(CAP_LEDGER_APPEND, []);
    await assert.rejects(host.call(f.ex.symbols.transfer, args, { operationId: 'strict-revoked', tokens: original }), /authority_denied/);
    assert.equal(f.calls(), 1);
    epochs.restore(CAP_LEDGER_APPEND, []);
    await assert.rejects(host.call(f.ex.symbols.transfer, args, { operationId: 'strict-stale', tokens: original }), /authority_denied/);
    assert.equal((await host.call(f.ex.symbols.transfer, args, { operationId: 'strict-renewed', tokens: host.issueScopedTokens(f.ex.symbols.transfer) })).state, 'completed');
    assert.equal(f.calls(), 2);
    await host.close(); host = undefined;
    await assert.rejects(ProcessHost.open(f.options), /configuration|profile/i);
    host = await ProcessHost.open({ ...f.options, scopedGrants: grants });
    assert.deepEqual(balances(await host.snapshot()), ['80', '20']);
    const expires = host.issueScopedTokens(f.ex.symbols.transfer);
    setTime(60_100);
    await assert.rejects(host.call(f.ex.symbols.transfer, args, { operationId: 'strict-expired', tokens: expires }), /authority_denied/);
    assert.equal(f.calls(), 2);
  } finally { await host?.close(); f.cleanup(); }
});

test('strict ProcessHost rechecks a grant after effect intent and before the external sink', async () => {
  const f = fixture(), { epochs, grants } = scopedAuthority(f.directory); let host: ProcessHost | undefined;
  try {
    host = await ProcessHost.open({ ...f.options, scopedGrants: grants,
      onPhase: phase => { if (phase === 'effect-requested') epochs.revoke(CAP_LEDGER_APPEND, []); } });
    const alice = await host.allocateRecord(ACCOUNT, { id: text('alice'), balance: integer(100) }, { operationId: 'alice' });
    const bob = await host.allocateRecord(ACCOUNT, { id: text('bob'), balance: integer(0) }, { operationId: 'bob' });
    const result = await host.call(f.ex.symbols.transfer, [reference(alice), reference(bob), integer(10)], { operationId: 'revoked-before-sink', tokens: host.issueScopedTokens(f.ex.symbols.transfer) });
    assert.notEqual(result.state, 'completed');
    assert.equal(f.calls(), 0);
    assert.deepEqual(balances(await host.snapshot()), ['100', '0']);
  } finally { await host?.close(); f.cleanup(); }
});

test('strict pure worker call cannot publish state after invocation grant revocation at final commit', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'aether-process-final-grant-')); let host: ProcessHost | undefined;
  try {
    const symbols = new SymbolSpace('final-grant'), setter = symbols.define('setter'), account = symbols.define('account');
    const registry = new CapabilityRegistry();
    const module = b.module_({ symbol: symbols.define('module'), members: [b.fn({ symbol: setter, params: [b.param(account, ACCOUNT)], returns: b.Unit,
      body: b.block(b.assign(b.place(account, 'balance'), b.typed(CENTS, 99n)), b.ret(b.unit())) })], symbolTable: symbols.table() });
    const plan: TopologyPlan = { shape: 'containers', units: [{ id: 'worker', members: [setter], capabilities: [], placement: 'container', memoryMb: 16 }],
      crossEdges: [], transportLatencyMsPerSecond: 0, monthlyCost: 0, recombinations: [], blockedMerges: [] };
    const { epochs, grants } = scopedAuthority(directory); let beforeCommit = false;
    const options: ProcessHostOptions = { directory, module, manifest: manifest(module, registry), plan, registry,
      sealer: new CapabilitySealer(new Uint8Array(32).fill(63), () => 100), scopedGrants: grants,
      onPhase: phase => { if (phase === 'call-before-commit') { beforeCommit = true; epochs.revoke(PROCESS_INVOKE, []); } } };
    host = await ProcessHost.open(options);
    const ref = await host.allocateRecord(ACCOUNT, { id: text('alice'), balance: integer(0) }, { operationId: 'alice' });
    const invoke = host.issueScopedTokens(setter)[0];
    const narrowed = grants.attenuate(invoke, { capability: PROCESS_INVOKE, audience: setter, path: [...invoke.body.path, 'limited'] }, 60_000);
    await assert.rejects(host.call(setter, [reference(ref)], { operationId: 'narrow-invoke', tokens: [narrowed] }), /authority_denied/);
    assert.equal(beforeCommit, false);
    assert.deepEqual(balances(await host.snapshot()), ['0']);
    const result = await host.call(setter, [reference(ref)], { operationId: 'revoked-at-commit', tokens: host.issueScopedTokens(setter) });
    assert.equal(beforeCommit, true); assert.equal(result.state, 'indeterminate');
    if (result.state === 'indeterminate') assert.match(result.reason, /authority_denied/);
    assert.deepEqual(balances(await host.snapshot()), ['0']);
    await host.close(); host = undefined;
    host = await ProcessHost.open(options);
    assert.deepEqual(balances(await host.snapshot()), ['0']);
  } finally { await host?.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('strict ProcessHost rejects pre-migration grants after a durable ownership generation change', async () => {
  const f = fixture(), { grants } = scopedAuthority(f.directory); let host: ProcessHost | undefined;
  try {
    host = await ProcessHost.open({ ...f.options, scopedGrants: grants });
    const old = host.issueScopedTokens(f.ex.symbols.feeFor);
    await host.move(f.ex.symbols.transfer, 'b', { migrationId: 'strict-move', expectedGeneration: '1' });
    assert.equal(host.generation, '2');
    await assert.rejects(host.call(f.ex.symbols.feeFor, [integer(100)], { operationId: 'old-grant', tokens: old }), /authority_denied/);
    assert.equal((await host.call(f.ex.symbols.feeFor, [integer(100)], { operationId: 'fresh-grant', tokens: host.issueScopedTokens(f.ex.symbols.feeFor) })).state, 'completed');
  } finally { await host?.close(); f.cleanup(); }
});

test('trusted effect resource policy denies a valid grant for the wrong ledger target', async () => {
  const f = fixture(), { grants } = scopedAuthority(f.directory); let host: ProcessHost | undefined;
  try {
    await assert.rejects(ProcessHost.open({ ...f.options, scopedGrants: grants, effectResourcePath: () => [] }), /exact policy digest/);
    host = await ProcessHost.open({ ...f.options, scopedGrants: grants,
      effectResourcePolicyDigest: domainDigest('aether.effect-resource-policy/1', 'ledger-sender-id-v1'),
      effectResourcePath: request => {
        const first = request.args[0];
        if (request.capability !== CAP_LEDGER_APPEND || first?.tag !== 'string') throw new TypeError('unsupported effect resource');
        return ['ledger', first.value];
      },
    });
    const alice = await host.allocateRecord(ACCOUNT, { id: text('alice'), balance: integer(100) }, { operationId: 'alice' });
    const bob = await host.allocateRecord(ACCOUNT, { id: text('bob'), balance: integer(0) }, { operationId: 'bob' });
    const args = [reference(alice), reference(bob), integer(10)];
    const aliceScope = new Map([[CAP_LEDGER_APPEND, ['ledger', 'alice']]]);
    assert.equal((await host.call(f.ex.symbols.transfer, args, { operationId: 'alice-scope', tokens: host.issueScopedTokens(f.ex.symbols.transfer, 60000, aliceScope) })).state, 'completed');
    assert.equal(f.calls(), 1);
    const bobScope = new Map([[CAP_LEDGER_APPEND, ['ledger', 'bob']]]);
    const denied = await host.call(f.ex.symbols.transfer, args, { operationId: 'bob-scope', tokens: host.issueScopedTokens(f.ex.symbols.transfer, 60000, bobScope) });
    assert.equal(f.calls(), 1, JSON.stringify(denied));
    if (denied.state === 'completed') assert.equal(denied.execution.ok, false, JSON.stringify(denied));
    assert.match(JSON.stringify(denied), /authority_denied|effect_indeterminate/);
    assert.deepEqual(balances(await host.snapshot()), ['90', '10']);
    await host.close(); host = undefined;
    await assert.rejects(ProcessHost.open({ ...f.options, scopedGrants: grants,
      effectResourcePolicyDigest: domainDigest('aether.effect-resource-policy/1', 'different-policy'), effectResourcePath: () => [] }), /configuration|profile/i);
  } finally { await host?.close(); f.cleanup(); }
});

test('signed resource policy binds a real process effect to its manifest and current grant epoch', async () => {
  const f = fixture(), { epochs, grants } = scopedAuthority(f.directory); let host: ProcessHost | undefined;
  try {
    let calls = 0;
    const sink: EffectAdapter = { id: 'signed-ledger-sink/1', semantics: { readOnly: false, atomicIdempotency: false, transactional: false, reconciliation: true }, execute: () => { calls++; return { tag: 'null' }; }, reconcile: () => ({ state: 'unknown' }) };
    const body: EffectResourcePolicyBodyV1 = { format: 'aether.effect-resource-policy/1', repositoryId: grants.repositoryId,
      astRoot: f.options.manifest.astRoot, policyEpoch: epochs.policyEpoch,
      rules: [{ capability: CAP_LEDGER_APPEND, prefix: ['ledger'], argument: 0, adapterId: sink.id, adapterDigest: effectAdapterDigest(sink) }] };
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const signedEffectResourcePolicy = signEffectResourcePolicy(body, 'ledger-policy', privateKey);
    const signedManifest = { ...f.options.manifest, capabilityPolicyDigest: effectResourcePolicyDigest(body) };
    let rotateAtEffect = false;
    let effectPolicyEpoch = epochs.policyEpoch;
    const signedOptions: ProcessHostOptions = { ...f.options, manifest: signedManifest,
      effectRouterFactory: factory(f.directory, signedManifest, CAP_LEDGER_APPEND, sink),
      scopedGrants: grants, signedEffectResourcePolicy, effectResourceSignerKey: publicKey, currentEffectPolicyEpoch: () => effectPolicyEpoch,
      legacyEffectSignerTrust: 'factory-v1',
      onPhase: phase => { if (phase === 'effect-requested' && rotateAtEffect) { rotateAtEffect = false; effectPolicyEpoch = '1'; } } };
    await assert.rejects(ProcessHost.open({ ...signedOptions, legacyEffectSignerTrust: undefined }), /explicit legacy signer trust profile/);
    await assert.rejects(ProcessHost.open({ ...signedOptions, effectResourceSignerKey: generateKeyPairSync('ed25519').publicKey }), /untrusted/);
    await assert.rejects(ProcessHost.open({ ...signedOptions, manifest: f.options.manifest }), /stale or foreign/);
    host = await ProcessHost.open(signedOptions);
    const alice = await host.allocateRecord(ACCOUNT, { id: text('alice'), balance: integer(100) }, { operationId: 'alice' });
    const bob = await host.allocateRecord(ACCOUNT, { id: text('bob'), balance: integer(0) }, { operationId: 'bob' });
    const args = [reference(alice), reference(bob), integer(10)];
    const aliceScope = new Map([[CAP_LEDGER_APPEND, ['ledger', 'alice']]]);
    const valid = await host.call(f.ex.symbols.transfer, args, { operationId: 'signed-alice', tokens: host.issueScopedTokens(f.ex.symbols.transfer, 60000, aliceScope) });
    assert.equal(valid.state, 'completed'); assert.equal(calls, 1);
    const bobScope = new Map([[CAP_LEDGER_APPEND, ['ledger', 'bob']]]);
    const denied = await host.call(f.ex.symbols.transfer, args, { operationId: 'signed-bob', tokens: host.issueScopedTokens(f.ex.symbols.transfer, 60000, bobScope) });
    assert.equal(calls, 1); assert.match(JSON.stringify(denied), /authority_denied|effect_indeterminate/);
    rotateAtEffect = true;
    const raced = await host.call(f.ex.symbols.transfer, args, { operationId: 'signed-race', tokens: host.issueScopedTokens(f.ex.symbols.transfer, 60000, aliceScope) });
    assert.equal(calls, 1); assert.match(JSON.stringify(raced), /effect_indeterminate|stale or foreign/);
  } finally { await host?.close(); f.cleanup(); }
});

test('signed process policy refuses a changed adapter before dispatch', async () => {
  const f = fixture(), { epochs, grants } = scopedAuthority(f.directory); let host: ProcessHost | undefined;
  try {
    let calls = 0;
    const approved: EffectAdapter = { id: 'approved-ledger/1', semantics: { readOnly: false, atomicIdempotency: false, transactional: false, reconciliation: true },
      execute: () => ({ tag: 'null' }), reconcile: () => ({ state: 'unknown' }) };
    const changed: EffectAdapter = { ...approved, id: 'changed-ledger/1', execute: () => { calls++; return { tag: 'null' }; } };
    const body: EffectResourcePolicyBodyV1 = { format: 'aether.effect-resource-policy/1', repositoryId: grants.repositoryId,
      astRoot: f.options.manifest.astRoot, policyEpoch: epochs.policyEpoch,
      rules: [{ capability: CAP_LEDGER_APPEND, prefix: ['ledger'], argument: 0, adapterId: approved.id, adapterDigest: effectAdapterDigest(approved) }] };
    const manifestValue = { ...f.options.manifest, capabilityPolicyDigest: effectResourcePolicyDigest(body) };
    const keys = generateKeyPairSync('ed25519');
    host = await ProcessHost.open({ ...f.options, manifest: manifestValue, scopedGrants: grants,
      signedEffectResourcePolicy: signEffectResourcePolicy(body, 'adapter-policy', keys.privateKey), effectResourceSignerKey: keys.publicKey,
      legacyEffectSignerTrust: 'factory-v1',
      currentEffectPolicyEpoch: () => epochs.policyEpoch, effectRouterFactory: factory(f.directory, manifestValue, CAP_LEDGER_APPEND, changed) });
    const alice = await host.allocateRecord(ACCOUNT, { id: text('alice'), balance: integer(100) }, { operationId: 'alice' });
    const bob = await host.allocateRecord(ACCOUNT, { id: text('bob'), balance: integer(0) }, { operationId: 'bob' });
    const aliceScope = new Map([[CAP_LEDGER_APPEND, ['ledger', 'alice']]]);
    const result = await host.call(f.ex.symbols.transfer, [reference(alice), reference(bob), integer(10)],
      { operationId: 'changed-adapter', tokens: host.issueScopedTokens(f.ex.symbols.transfer, 60000, aliceScope) });
    assert.match(JSON.stringify(result), /effect_indeterminate|outside signed resource policy/);
    assert.equal(calls, 0);
    assert.deepEqual(balances(await host.snapshot()), ['100', '0']);
  } finally { await host?.close(); f.cleanup(); }
});

test('v2 process policy requires the exact loader-admitted adapter bytes before a real sink', async () => {
  const f = fixture(), { epochs, grants } = scopedAuthority(f.directory); let host: ProcessHost | undefined;
  const globals = globalThis as Record<string, unknown>;
  try {
    globals.__aetherV2SinkCalls = 0;
    const source = new TextEncoder().encode(`export default {id:'loaded-ledger/1',semantics:{readOnly:false,atomicIdempotency:false,transactional:false,reconciliation:true},execute(){globalThis.__aetherV2SinkCalls++;return{tag:'null'};},reconcile(){return{state:'unknown'};}};`);
    const artifact = legacyAdapterArtifactForSource(source, CAP_LEDGER_APPEND, 'loaded-ledger/1', { readOnly: false, atomicIdempotency: false, transactional: false, reconciliation: true });
    const adapter = await admitAdapterSource(source, artifact, { legacyProfile: 'aether.adapter-js-legacy-v1/1' }), artifactDigest = admittedAdapterArtifactDigest(adapter)!;
    const body: EffectResourcePolicyBodyV2 = { format: 'aether.effect-resource-policy/2', repositoryId: grants.repositoryId,
      astRoot: f.options.manifest.astRoot, policyEpoch: epochs.policyEpoch,
      rules: [{ capability: CAP_LEDGER_APPEND, prefix: ['ledger'], argument: 0, adapterId: adapter.id,
        adapterDigest: effectAdapterDigest(adapter), adapterArtifactDigest: artifactDigest }] };
    const manifestValue = { ...f.options.manifest, capabilityPolicyDigest: effectResourcePolicyDigestV2(body) }, keys = generateKeyPairSync('ed25519');
    let active: EffectAdapter = adapter;
    const legacySignedOptions: ProcessHostOptions = { ...f.options, manifest: manifestValue, scopedGrants: grants,
      signedEffectResourcePolicy: signEffectResourcePolicyV2(body, 'artifact-policy', keys.privateKey), effectResourceSignerKey: keys.publicKey,
      legacyEffectSignerTrust: 'factory-v1',
      currentEffectPolicyEpoch: () => epochs.policyEpoch,
      effectRouterFactory: context => factory(f.directory, manifestValue, CAP_LEDGER_APPEND, active)(context) };
    await assert.rejects(ProcessHost.open({ ...legacySignedOptions, legacyEffectSignerTrust: undefined }), /explicit legacy signer trust profile/);
    host = await ProcessHost.open(legacySignedOptions);
    const alice = await host.allocateRecord(ACCOUNT, { id: text('alice'), balance: integer(100) }, { operationId: 'alice' });
    const bob = await host.allocateRecord(ACCOUNT, { id: text('bob'), balance: integer(0) }, { operationId: 'bob' });
    const args = [reference(alice), reference(bob), integer(10)], scope = new Map([[CAP_LEDGER_APPEND, ['ledger', 'alice']]]);
    assert.equal((await host.call(f.ex.symbols.transfer, args, { operationId: 'approved-bytes', tokens: host.issueScopedTokens(f.ex.symbols.transfer, 60000, scope) })).state, 'completed');
    assert.equal(globals.__aetherV2SinkCalls, 1);
    active = { ...adapter };
    const denied = await host.call(f.ex.symbols.transfer, args, { operationId: 'unbranded-copy', tokens: host.issueScopedTokens(f.ex.symbols.transfer, 60000, scope) });
    assert.match(JSON.stringify(denied), /effect_indeterminate|artifact is outside signed resource policy/);
    assert.equal(globals.__aetherV2SinkCalls, 1);
    assert.deepEqual(balances(await host.snapshot()), ['90', '10']);
  } finally { await host?.close(); f.cleanup(); delete globals.__aetherV2SinkCalls; }
});

test('anchored ProcessHost pins signer key in durable configuration across reopen', async () => {
  const f = fixture(), { epochs, grants } = scopedAuthority(f.directory); let host: ProcessHost | undefined;
  try {
    const body: EffectResourcePolicyBodyV2 = { format: 'aether.effect-resource-policy/2', repositoryId: grants.repositoryId,
      astRoot: f.options.manifest.astRoot, policyEpoch: epochs.policyEpoch,
      rules: [{ capability: CAP_LEDGER_APPEND, prefix: ['ledger'], argument: 0, adapterId: 'pinned-sink',
        adapterDigest: domainDigest('aether.effect-adapter/1', 'pinned-sink'),
        adapterArtifactDigest: domainDigest('aether.effect-adapter-artifact/1', 'pinned-sink-bytes') }] };
    const manifestValue = { ...f.options.manifest, capabilityPolicyDigest: effectResourcePolicyDigestV2(body) };
    const trusted = generateKeyPairSync('ed25519'), replacement = generateKeyPairSync('ed25519');
    const anchor = createEffectSignerAnchor({ repositoryId: grants.repositoryId, signer: 'pinned-policy',
      epochAuthorityId: 'process-host-grant-epochs', publicKey: trusted.publicKey,
      currentEpoch: () => epochs.policyEpoch });
    const old = signEffectResourcePolicyV2(body, anchor.signer, trusted.privateKey);
    const forged = signEffectResourcePolicyV2(body, anchor.signer, replacement.privateKey);
    const options: ProcessHostOptions = { ...f.options, manifest: manifestValue, scopedGrants: grants,
      signedEffectResourcePolicy: old, effectSignerAnchor: anchor, legacyAnchoredEffectPolicy: 'anchored-v2' };
    await assert.rejects(ProcessHost.open({ ...options, legacyAnchoredEffectPolicy: undefined }), /signed policy v3/);
    host = await ProcessHost.open(options); const before = await host.snapshot();
    const originalConfiguration = (JSON.parse(readFileSync(join(f.directory, 'host.json'), 'utf8')) as { configuration: string }).configuration;
    assert.match(originalConfiguration, /^aether\.process-host-config\/2:/);
    await host.close(); host = undefined;
    await assert.rejects(ProcessHost.open({ ...options, signedEffectResourcePolicy: forged }), /untrusted effect resource policy v2 signer/);
    await assert.rejects(ProcessHost.open({ ...options, effectResourceSignerKey: replacement.publicKey }), /independent signer authority/);
    const newAnchor = createEffectSignerAnchor({ repositoryId: grants.repositoryId, signer: 'pinned-policy',
      epochAuthorityId: 'process-host-grant-epochs', publicKey: replacement.publicKey,
      currentEpoch: () => epochs.policyEpoch });
    await assert.rejects(ProcessHost.open({ ...options, signedEffectResourcePolicy: forged, effectSignerAnchor: newAnchor }), /configuration mismatch/);
    const replacedEpochSource = createEffectSignerAnchor({ repositoryId: grants.repositoryId, signer: 'pinned-policy',
      epochAuthorityId: 'different-epoch-authority', publicKey: trusted.publicKey, currentEpoch: () => epochs.policyEpoch });
    await assert.rejects(ProcessHost.open({ ...options, effectSignerAnchor: replacedEpochSource }), /configuration mismatch/);
    host = await ProcessHost.open(options);
    assert.deepEqual(await host.snapshot(), before);
    assert.equal((JSON.parse(readFileSync(join(f.directory, 'host.json'), 'utf8')) as { configuration: string }).configuration,
      originalConfiguration, 'compatibility reopen must retain historical host-config/2 bytes');
  } finally { await host?.close(); f.cleanup(); }
});

test('anchored V3 ProcessHost binds import-free adapter, signer key, epoch and host-config/3 before effects', async () => {
  const f = fixture(), { epochs, grants } = scopedAuthority(f.directory); let host: ProcessHost | undefined;
  const globals = globalThis as Record<string, unknown>;
  try {
    globals.__aetherV3SinkCalls = 0;
    const source = new TextEncoder().encode(`export default {id:'v3-ledger/1',semantics:{readOnly:false,atomicIdempotency:false,transactional:false,reconciliation:true},execute(){globalThis.__aetherV3SinkCalls++;return{tag:'null'};},reconcile(){return{state:'unknown'};}};`);
    const semantics = { readOnly: false, atomicIdempotency: false, transactional: false, reconciliation: true } as const;
    const approvedArtifact = adapterArtifactForSource(source, CAP_LEDGER_APPEND, 'v3-ledger/1', semantics);
    const approved = await admitAdapterSource(source, approvedArtifact);
    const legacyArtifact = legacyAdapterArtifactForSource(source, CAP_LEDGER_APPEND, 'v3-ledger/1', semantics);
    const legacy = await admitAdapterSource(source, legacyArtifact, { legacyProfile: 'aether.adapter-js-legacy-v1/1' });
    assert.equal(admittedAdapterArtifactDigest(approved), domainDigest('aether.effect-adapter-artifact/2', approvedArtifact));
    assert.equal(admittedAdapterArtifactDigest(legacy), domainDigest('aether.effect-adapter-artifact/1', legacyArtifact));
    const body: EffectResourcePolicyBodyV3 = { format: 'aether.effect-resource-policy/3', repositoryId: grants.repositoryId,
      astRoot: f.options.manifest.astRoot, policyEpoch: epochs.policyEpoch,
      rules: [{ capability: CAP_LEDGER_APPEND, prefix: ['ledger'], argument: 0, adapterId: approved.id,
        adapterDigest: effectAdapterDigest(approved), adapterArtifactDigest: admittedAdapterArtifactDigest(approved)! }] };
    const manifestValue = { ...f.options.manifest, capabilityPolicyDigest: effectResourcePolicyDigestV3(body) };
    const trusted = generateKeyPairSync('ed25519'), replacement = generateKeyPairSync('ed25519');
    let policyEpoch = epochs.policyEpoch, active: EffectAdapter = approved, overrideInvoke = false, unapprovedCalls = 0;
    class OverrideRouter extends BrokerEffectRouter {
      override invoke(): null { unapprovedCalls++; return null; }
    }
    const anchor = createEffectSignerAnchor({ repositoryId: grants.repositoryId, signer: 'v3-ledger-policy',
      epochAuthorityId: 'process-host-policy-epochs', publicKey: trusted.publicKey, currentEpoch: () => policyEpoch });
    const signedEffectResourcePolicy = signEffectResourcePolicyV3(body, anchor.signer, trusted.privateKey);
    const options: ProcessHostOptions = { ...f.options, manifest: manifestValue, scopedGrants: grants, effectSignerAnchor: anchor,
      signedEffectResourcePolicy, effectRouterFactory: context => {
        const router = factory(f.directory, manifestValue, CAP_LEDGER_APPEND, active)(context);
        if (overrideInvoke) Object.setPrototypeOf(router, OverrideRouter.prototype);
        return router;
      } };
    await assert.rejects(ProcessHost.open({ ...options, signedEffectResourcePolicy: signEffectResourcePolicyV3(body, anchor.signer, replacement.privateKey) }), /untrusted effect resource policy v3 signer/);
    await assert.rejects(ProcessHost.open({ ...options, legacyAnchoredEffectPolicy: 'anchored-v2' }), /legacy anchored effect policy requires/);
    assert.equal(globals.__aetherV3SinkCalls, 0);
    assert.equal(existsSync(join(f.directory, 'host.json')), false);
    host = await ProcessHost.open(options);
    const journal = JSON.parse(readFileSync(join(f.directory, 'host.json'), 'utf8')) as { configuration: string };
    assert.match(journal.configuration, /^aether\.process-host-config\/3:/);
    const alice = await host.allocateRecord(ACCOUNT, { id: text('alice'), balance: integer(100) }, { operationId: 'alice' });
    const bob = await host.allocateRecord(ACCOUNT, { id: text('bob'), balance: integer(0) }, { operationId: 'bob' });
    const args = [reference(alice), reference(bob), integer(10)], scope = new Map([[CAP_LEDGER_APPEND, ['ledger', 'alice']]]);
    const valid = await host.call(f.ex.symbols.transfer, args, { operationId: 'v3-approved', tokens: host.issueScopedTokens(f.ex.symbols.transfer, 60000, scope) });
    assert.equal(valid.state, 'completed');
    assert.equal(globals.__aetherV3SinkCalls, 1);
    assert.deepEqual(balances(await host.snapshot()), ['90', '10']);
    overrideInvoke = true;
    const overridden = await host.call(f.ex.symbols.transfer, args,
      { operationId: 'v3-router-override', tokens: host.issueScopedTokens(f.ex.symbols.transfer, 60000, scope) });
    assert.equal(overridden.state, 'completed');
    assert.equal(unapprovedCalls, 0, 'signed host must bypass virtual router invocation');
    assert.equal(globals.__aetherV3SinkCalls, 2);
    assert.deepEqual(balances(await host.snapshot()), ['80', '20']);
    overrideInvoke = false;
    const beforeDenied = await host.snapshot();
    active = legacy;
    const wrongArtifact = await host.call(f.ex.symbols.transfer, args, { operationId: 'v3-legacy-artifact', tokens: host.issueScopedTokens(f.ex.symbols.transfer, 60000, scope) });
    assert.match(JSON.stringify(wrongArtifact), /effect_indeterminate|artifact is outside signed resource policy v3/);
    assert.equal(globals.__aetherV3SinkCalls, 2);
    assert.deepEqual(await host.snapshot(), beforeDenied);
    await host.close(); host = undefined;
    const newAnchor = createEffectSignerAnchor({ repositoryId: grants.repositoryId, signer: anchor.signer,
      epochAuthorityId: anchor.epochAuthorityId, publicKey: replacement.publicKey, currentEpoch: () => policyEpoch });
    await assert.rejects(ProcessHost.open({ ...options, effectSignerAnchor: newAnchor,
      signedEffectResourcePolicy: signEffectResourcePolicyV3(body, anchor.signer, replacement.privateKey) }), /configuration mismatch/);
    assert.equal(globals.__aetherV3SinkCalls, 2);
  } finally { await host?.close(); f.cleanup(); delete globals.__aetherV3SinkCalls; }
});

test('anchored V3 ProcessHost refuses a policy epoch change at effect intent without publishing heap or sink', async () => {
  const f = fixture(), { epochs, grants } = scopedAuthority(f.directory); let host: ProcessHost | undefined;
  const globals = globalThis as Record<string, unknown>;
  try {
    globals.__aetherV3EpochSinkCalls = 0;
    const source = new TextEncoder().encode(`export default {id:'v3-epoch-ledger/1',semantics:{readOnly:false,atomicIdempotency:false,transactional:false,reconciliation:true},execute(){globalThis.__aetherV3EpochSinkCalls++;return{tag:'null'};},reconcile(){return{state:'unknown'};}};`);
    const artifact = adapterArtifactForSource(source, CAP_LEDGER_APPEND, 'v3-epoch-ledger/1',
      { readOnly: false, atomicIdempotency: false, transactional: false, reconciliation: true });
    const adapter = await admitAdapterSource(source, artifact);
    const body: EffectResourcePolicyBodyV3 = { format: 'aether.effect-resource-policy/3', repositoryId: grants.repositoryId,
      astRoot: f.options.manifest.astRoot, policyEpoch: epochs.policyEpoch,
      rules: [{ capability: CAP_LEDGER_APPEND, prefix: ['ledger'], argument: 0, adapterId: adapter.id,
        adapterDigest: effectAdapterDigest(adapter), adapterArtifactDigest: admittedAdapterArtifactDigest(adapter)! }] };
    const manifestValue = { ...f.options.manifest, capabilityPolicyDigest: effectResourcePolicyDigestV3(body) };
    const keys = generateKeyPairSync('ed25519'); let policyEpoch = '1', rotateAtEffect = false;
    const anchor = createEffectSignerAnchor({ repositoryId: grants.repositoryId, signer: 'v3-epoch-policy',
      epochAuthorityId: 'process-host-policy-epochs', publicKey: keys.publicKey, currentEpoch: () => policyEpoch });
    const options: ProcessHostOptions = { ...f.options, manifest: manifestValue, scopedGrants: grants, effectSignerAnchor: anchor,
      signedEffectResourcePolicy: signEffectResourcePolicyV3(body, anchor.signer, keys.privateKey),
      effectRouterFactory: factory(f.directory, manifestValue, CAP_LEDGER_APPEND, adapter),
      onPhase: phase => { if (phase === 'effect-requested' && rotateAtEffect) policyEpoch = '1'; } };
    await assert.rejects(ProcessHost.open(options), /stale or foreign effect resource policy v3/);
    assert.equal(existsSync(join(f.directory, 'host.json')), false);
    policyEpoch = epochs.policyEpoch;
    host = await ProcessHost.open(options);
    const alice = await host.allocateRecord(ACCOUNT, { id: text('alice'), balance: integer(100) }, { operationId: 'alice' });
    const bob = await host.allocateRecord(ACCOUNT, { id: text('bob'), balance: integer(0) }, { operationId: 'bob' });
    const before = await host.snapshot();
    rotateAtEffect = true;
    const scope = new Map([[CAP_LEDGER_APPEND, ['ledger', 'alice']]]);
    const denied = await host.call(f.ex.symbols.transfer, [reference(alice), reference(bob), integer(10)],
      { operationId: 'v3-epoch-race', tokens: host.issueScopedTokens(f.ex.symbols.transfer, 60000, scope) });
    assert.match(JSON.stringify(denied), /effect_indeterminate|stale or foreign/);
    assert.equal(globals.__aetherV3EpochSinkCalls, 0);
    assert.deepEqual(await host.snapshot(), before);
  } finally { await host?.close(); f.cleanup(); delete globals.__aetherV3EpochSinkCalls; }
});

test('strict scoped grants remain bound through an actual cross-process nested call', async () => {
  const f = fixture(), { grants } = scopedAuthority(f.directory); let host: ProcessHost | undefined;
  try {
    host = await ProcessHost.open({ ...f.options, scopedGrants: grants });
    const alice = await host.allocateRecord(ACCOUNT, { id: text('alice'), balance: integer(100) }, { operationId: 'alice' });
    const bob = await host.allocateRecord(ACCOUNT, { id: text('bob'), balance: integer(0) }, { operationId: 'bob' });
    const args = [reference(alice), reference(bob), integer(10)];
    await assert.rejects(host.call(f.ex.symbols.settle, args, { operationId: 'nested-wrong-audience', tokens: host.issueScopedTokens(f.ex.symbols.transfer) }), /authority_denied/);
    const result = await host.call(f.ex.symbols.settle, args, { operationId: 'nested-authorized', tokens: host.issueScopedTokens(f.ex.symbols.settle) });
    assert.equal(result.state, 'completed');
    assert.equal(f.calls(), 1);
  } finally { await host?.close(); f.cleanup(); }
});

test('legacy and strict process profiles reject live closure transfer before external effects', async () => {
  for (const strict of [false, true]) {
    const directory = mkdtempSync(join(tmpdir(), 'aether-process-closure-grants-')); let host: ProcessHost | undefined;
    try {
    const symbols = new SymbolSpace('closure-grants'), main = symbols.define('main'), value = symbols.define('value'), callback = symbols.define('callback');
    const registry = new CapabilityRegistry(), cap = registry.declare('cap:test:emit', { arity: 1, description: 'Closure effect.' }).name;
    const fnType: Ty = { t: 'Fn', params: [], returns: b.Unit, capabilities: [cap] };
    const entry = b.fn({ symbol: main, params: [b.param(value, b.Int)], returns: b.Int, capabilities: [cap],
      body: b.block(b.let_(callback, fnType, b.lambda({ returns: b.Unit, capabilities: [cap], body: b.invoke(cap, b.v(value)) })),
        b.exprStmt(b.apply(b.v(callback))), b.ret(b.v(value))) });
    const module = b.module_({ symbol: symbols.define('module'), members: [entry], symbolTable: symbols.table() });
    const manifestValue = manifest(module, registry), plan: TopologyPlan = { shape: 'containers', units: [{ id: 'worker', members: [main], capabilities: [cap], placement: 'container', memoryMb: 16 }], crossEdges: [], transportLatencyMsPerSecond: 0, monthlyCost: 0, recombinations: [], blockedMerges: [] };
    const epochs = new DurableGrantEpochs({ directory: join(directory, 'grant-epochs'), repositoryId: 'repository' });
    const grants = new ScopedGrantAuthority({ key: new Uint8Array(32).fill(37), repositoryId: 'repository', clock: () => 100,
      policyEpoch: () => epochs.policyEpoch, revocationEpoch: () => epochs.epoch,
      isRevoked: (name, path) => epochs.isRevoked(name, path), authorizeIssue: () => true, authorizeDelegate: () => true });
    let calls = 0;
    const sink: EffectAdapter = { id: 'closure-sink/1', semantics: { readOnly: false, atomicIdempotency: false, transactional: false, reconciliation: true }, execute: () => { calls++; return { tag: 'null' }; }, reconcile: () => ({ state: 'unknown' }) };
    host = await ProcessHost.open({ directory, module, manifest: manifestValue, plan, registry, sealer: new CapabilitySealer(), ...(strict ? { scopedGrants: grants } : {}),
      effectRouterFactory: factory(directory, manifestValue, cap, sink) });
    const tokens = () => strict ? host!.issueScopedTokens(main) : host!.issueTokens(main);
    const first = await host.call(main, [integer(7)], { operationId: 'closure-valid', tokens: tokens() });
    assert.equal(first.state, 'indeterminate');
    if (first.state === 'indeterminate') assert.match(first.reason, /live closures and tasks cannot be migrated/);
    assert.equal(calls, 0, 'unsupported continuation must be rejected before external dispatch');
    assert.equal((await host.call(main, [integer(7)], { operationId: 'closure-valid', tokens: tokens() })).state, 'indeterminate');
    assert.equal(calls, 0, 'same-operation retry cannot dispatch the effect');
    } finally { await host?.close(); rmSync(directory, { recursive: true, force: true }); }
  }
});

test('F07 coordinator: actual ledger workers preserve state, exact receipts, allocator and migration epochs', async () => {
  const f = fixture(); let host: ProcessHost | undefined;
  try {
    host = await ProcessHost.open(f.options);
    const pids = Object.values(host.workerPids); assert.equal(new Set(pids).size, 2); assert.ok(pids.every(pid => pid !== process.pid));
    const alice = await host.allocateRecord(ACCOUNT, { id: text('alice'), balance: integer(100) }, { operationId: 'alice', unit: 'a' });
    const bob = await host.allocateRecord(ACCOUNT, { id: text('bob'), balance: integer(0) }, { operationId: 'bob', unit: 'b' });
    const args = [reference(alice), reference(bob), integer(10)];
    const result = await host.call(f.ex.symbols.transfer, args, { operationId: 'transfer-1', tokens: host.issueTokens(f.ex.symbols.transfer) });
    assert.equal(result.state, 'completed'); if (result.state === 'completed') assert.equal(result.execution.ok, true);
    assert.deepEqual(balances(await host.snapshot()), ['90', '10']); assert.equal(f.calls(), 1);
    assert.deepEqual(await host.call(f.ex.symbols.transfer, args, { operationId: 'transfer-1', tokens: host.issueTokens(f.ex.symbols.transfer) }), result); assert.equal(f.calls(), 1);
    const oldTokens = host.issueTokens(f.ex.symbols.transfer);
    const moved = await host.move(f.ex.symbols.transfer, 'b', { migrationId: 'move-1', expectedGeneration: '1' });
    assert.equal(moved.units.length, 1); assert.equal(host.generation, '2'); assert.equal(Object.keys(host.workerPids).length, 1);
    const snapshot = await host.snapshot(); assert.deepEqual(balances(snapshot), ['90', '10']);
    assert.ok(snapshot.ownership.every(owner => owner.unit === 'b' && owner.epoch === '2'));
    await assert.rejects(host.call(f.ex.symbols.transfer, args, { operationId: 'stale-token', tokens: oldTokens }), /authority/);
    await assert.rejects(host.call(f.ex.symbols.transfer, args, { operationId: 'stale-reference', tokens: host.issueTokens(f.ex.symbols.transfer) }), /stale/);
    const nextArgs = [reference({ ...alice, ownerEpoch: '2' }), reference({ ...bob, ownerEpoch: '2' }), integer(5)];
    assert.equal((await host.call(f.ex.symbols.transfer, nextArgs, { operationId: 'transfer-2', tokens: host.issueTokens(f.ex.symbols.transfer) })).state, 'completed');
    assert.deepEqual(balances(await host.snapshot()), ['85', '15']);
    const third = await host.allocateRecord(ACCOUNT, { id: text('third'), balance: integer(1) }, { operationId: 'third' }); assert.equal(third.objectId, '3');
    const beforeClose = await host.snapshot(); await host.close();
    host = await ProcessHost.open(f.options); assert.deepEqual(await host.snapshot(), beforeClose);
    assert.ok(Object.values(host.workerPids).every(pid => !pids.includes(pid)));
    assert.equal((await host.call(f.ex.symbols.transfer, nextArgs, { operationId: 'transfer-2', tokens: host.issueTokens(f.ex.symbols.transfer) })).state, 'completed'); assert.equal(f.calls(), 2);
    await assert.rejects(host.call(f.ex.symbols.feeFor, [integer(100)], { operationId: 'pure-unsealed', tokens: [] }), /invoke/);
    f.revocations.revoke(PROCESS_INVOKE, { by: 'test' });
    await assert.rejects(host.call(f.ex.symbols.feeFor, [integer(100)], { operationId: 'pure-revoked', tokens: host.issueTokens(f.ex.symbols.feeFor) }), /revoked/);
  } finally { await host?.close(); f.cleanup(); }
});

test('F07 coordinator: nested A→B→A passes current heap at every call/effect and preserves aliases', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'aether-process-nested-'));
  let host: ProcessHost | undefined;
  try {
    const syms = new SymbolSpace('process-host-nested'), main = syms.define('main'), remote = syms.define('remote'), read = syms.define('read'), account = syms.define('account'), saved = syms.define('saved');
    const registry = new CapabilityRegistry(), tick = registry.declare('cap:test:tick', { arity: 1, description: 'Counter observation.' }).name;
    const box: Ty = { t: 'Record', name: typeName('type:test:box'), fields: [['count', b.Int]] }, value = b.field(b.v(account), 'count');
    const module = b.module_({ symbol: syms.define('module'), symbolTable: syms.table(), members: [
      b.fn({ symbol: main, params: [b.param(account, box)], returns: b.Int, capabilities: [tick], body: b.block(b.assign(b.place(account, 'count'), b.add(value, b.int(1))), b.ret(b.call(remote, b.v(account)))) }),
      b.fn({ symbol: remote, params: [b.param(account, box)], returns: b.Int, capabilities: [tick], body: b.block(b.let_(saved, b.Int, b.call(read, b.v(account))), b.exprStmt(b.invoke(tick, b.v(saved))), b.assign(b.place(account, 'count'), b.add(value, b.int(10))), b.ret(value)) }),
      b.fn({ symbol: read, params: [b.param(account, box)], returns: b.Int, body: b.block(b.ret(value)) }),
    ] });
    const plan: TopologyPlan = { shape: 'containers', units: [{ id: 'a', members: [main, read], capabilities: [tick], placement: 'container', memoryMb: 1 }, { id: 'b', members: [remote], capabilities: [tick], placement: 'container', memoryMb: 1 }], crossEdges: [], transportLatencyMsPerSecond: 0, monthlyCost: 0, recombinations: [], blockedMerges: [] };
    const manifestValue = manifest(module, registry), observed: string[] = [];
    const sink: EffectAdapter = { id: 'tick-sink/1', semantics: { readOnly: false, atomicIdempotency: false, transactional: false, reconciliation: true }, execute: request => { if (request.payload.tag === 'sequence') observed.push((request.payload.items[1] as { value: string }).value); return { tag: 'null' }; }, reconcile: () => ({ state: 'unknown' }) };
    host = await ProcessHost.open({ directory, module, manifest: manifestValue, plan, registry, sealer: new CapabilitySealer(), effectRouterFactory: factory(directory, manifestValue, tick, sink) });
    const ref = await host.allocateRecord(box, { count: integer(0) }, { operationId: 'box', unit: 'a' });
    const aliasType: Ty = { t: 'Record', name: typeName('type:test:aliases'), fields: [['left', box], ['right', box]] };
    await host.allocateRecord(aliasType, { left: reference(ref), right: reference(ref) }, { operationId: 'aliases', unit: 'b' });
    const first = await host.call(main, [reference(ref)], { operationId: 'main-1', tokens: host.issueTokens(main) });
    assert.equal(first.state, 'completed'); if (first.state === 'completed') assert.deepEqual(plain(first.execution), { ok: true, value: integer(11), steps: 0 });
    assert.deepEqual(observed, ['1']);
    const snapshot = await host.snapshot(); assert.deepEqual(plain(snapshot.records[1].fields.map(([, value]) => value)), plain([reference(ref), reference(ref)]));
    const second = await host.call(main, [reference(ref)], { operationId: 'main-2', tokens: host.issueTokens(main) });
    if (second.state === 'completed') assert.deepEqual(plain(second.execution), { ok: true, value: integer(22), steps: 0 }); else assert.fail(second.reason);
    assert.deepEqual(observed, ['1', '12']);
  } finally { await host?.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('F07 coordinator: migration failures obey the durable commit decision and retain both snapshots', async () => {
  for (const phase of ['migration-prepared', 'migration-committed'] as const) {
    const f = fixture(); let host: ProcessHost | undefined;
    try {
      host = await ProcessHost.open({ ...f.options, onPhase: current => { if (current === phase) throw new Error(`injected ${phase}`); } });
      await host.allocateRecord(ACCOUNT, { id: text('balance'), balance: integer(90) }, { operationId: 'account', unit: 'a' });
      await assert.rejects(host.move(f.ex.symbols.transfer, 'b', { migrationId: 'move-fault' }), /injected/);
      assert.equal(host.generation, phase === 'migration-prepared' ? '1' : '2');
      await host.close(); host = await ProcessHost.open(f.options);
      const snapshot = await host.snapshot(); assert.deepEqual(balances(snapshot), ['90']);
      assert.equal(snapshot.ownership[0].epoch, phase === 'migration-prepared' ? '1' : '2');
      const journal = JSON.parse(readFileSync(join(f.directory, 'host.json'), 'utf8'));
      assert.ok(journal.snapshots.length >= 3);
      assert.equal(journal.migrations[0].state, phase === 'migration-prepared' ? 'aborted' : 'finalized');
    } finally { await host?.close(); f.cleanup(); }
  }
});

test('F07 coordinator: uncertain calls block migration and only privileged no-effect abort can clear them', async () => {
  const f = fixture(); let host: ProcessHost | undefined;
  try {
    host = await ProcessHost.open({ ...f.options, onPhase: phase => { if (phase === 'call-intent') throw new Error('interrupted before execution'); } });
    const result = await host.call(f.ex.symbols.feeFor, [integer(100)], { operationId: 'interrupted', tokens: host.issueTokens(f.ex.symbols.feeFor) });
    assert.equal(result.state, 'indeterminate');
    await assert.rejects(host.move(f.ex.symbols.transfer, 'b', { migrationId: 'blocked' }), /indeterminate/);
    const retry = await host.call(f.ex.symbols.feeFor, [integer(100)], { operationId: 'interrupted', tokens: host.issueTokens(f.ex.symbols.feeFor) }); assert.equal(retry.state, 'indeterminate');
    await host.close();
    host = await ProcessHost.open({ ...f.options, authorizeRecovery: () => false });
    await assert.rejects(host.recoverOperation('interrupted', { strategy: 'abort-before-effects' }), /authorization/);
    await host.close(); host = await ProcessHost.open(f.options);
    assert.equal((await host.recoverOperation('interrupted', { strategy: 'abort-before-effects' })).state, 'aborted');
    assert.deepEqual(host.status().unresolved, []);
    assert.equal(f.calls(), 0);
  } finally { await host?.close(); f.cleanup(); }
});

function coordinatorCommand(f: ReturnType<typeof fixture>, mode: 'call' | 'move', phase: string): string[] {
  const script = `
    import { ProcessHost } from ${JSON.stringify(new URL('../../src/tier4/process-host.ts', import.meta.url).href)};
    import { buildLedgerExample, CAP_LEDGER_APPEND } from ${JSON.stringify(new URL('../../src/examples/ledger.ts', import.meta.url).href)};
    import { CapabilitySealer } from ${JSON.stringify(new URL('../../src/tier2/ocap.ts', import.meta.url).href)};
    import { DurableEffectBroker } from ${JSON.stringify(new URL('../../src/fabric/effects.ts', import.meta.url).href)};
    import { BrokerEffectRouter } from ${JSON.stringify(new URL('../../src/tier3/effects.ts', import.meta.url).href)};
    import { domainDigest } from ${JSON.stringify(new URL('../../src/fabric/identity.ts', import.meta.url).href)};
    import { openSync, writeFileSync, fsyncSync, closeSync } from 'node:fs';
    import { join } from 'node:path';
    const [directory, serializedManifest, serializedPlan, mode, phase]=process.argv.slice(1);
    const ex=buildLedgerExample('process-host-ledger'), manifest=JSON.parse(serializedManifest), plan=JSON.parse(serializedPlan);
    const sink={id:'durable-ledger-sink/1',semantics:{readOnly:false,atomicIdempotency:false,transactional:false,reconciliation:true},
      execute(request) {const fd=openSync(join(directory,'sink-commits'),'a');writeFileSync(fd,request.executionId+'\\n');fsyncSync(fd);closeSync(fd);return {tag:'null'};},
      reconcile:()=>({state:'unknown'})};
    const host=await ProcessHost.open({directory,module:ex.module,manifest,plan,registry:ex.capabilities,sealer:new CapabilitySealer(new Uint8Array(32).fill(7),()=>100),
      onPhase:point=>{if(point===phase) process.kill(process.pid,'SIGKILL');},
      effectRouterFactory:context=>{
        const effectDirectory=join(directory,'effects',domainDigest('aether.effect-directory/1',context.operationId).split(':').at(-1));
        const broker=new DurableEffectBroker({directory:effectDirectory,clockDomain:'test-clock/1',clock:()=>100n,authorize:()=>true,
          beforePersist:event=>{if(phase==='sink-before-receipt'&&event.state==='committed')process.kill(process.pid,'SIGKILL');}});
        return new BrokerEffectRouter({broker,manifest,executionId:context.operationId,policyEpoch:'1',deadline:'1000',adapters:new Map([[CAP_LEDGER_APPEND,sink]]),grant:()=> 'grant:process-test'});
      }});
    if(mode==='move') await host.move(ex.symbols.transfer,'b',{migrationId:'killed-move'});
    else {
      const snapshot=await host.snapshot();
      const ref=id=>({tag:'ref',value:{heapId:snapshot.heapId,objectId:id,ownerEpoch:host.generation}});
      await host.call(ex.symbols.transfer,[ref('1'),ref('2'),{tag:'int',value:'10'}],{operationId:'crash-transfer',tokens:host.issueTokens(ex.symbols.transfer)});
    }
    await host.close();
  `;
  return ['--experimental-strip-types', '--input-type=module', '-e', script, f.directory, JSON.stringify(f.options.manifest), JSON.stringify(f.options.plan), mode, phase];
}
function crashingCoordinator(f: ReturnType<typeof fixture>, mode: 'call' | 'move', phase: string) {
  return spawnSync(process.execPath, coordinatorCommand(f, mode, phase), { encoding: 'utf8', timeout: 15000 });
}

test('F07 coordinator: actual parent death at every migration boundary preserves the decision on same-ID retry', async () => {
  for (const phase of ['migration-requested', 'migration-prepared', 'migration-before-commit', 'migration-committed', 'migration-finalized'] as const) {
    const f = fixture(); let host: ProcessHost | undefined;
    try {
      host = await ProcessHost.open(f.options);
      await host.allocateRecord(ACCOUNT, { id: text('retained'), balance: integer(90) }, { operationId: 'seed', unit: 'a' });
      await host.close(); host = undefined;
      const child = crashingCoordinator(f, 'move', phase); assert.equal(child.signal, 'SIGKILL', child.stderr);
      host = await ProcessHost.open(f.options);
      const committed = phase === 'migration-committed' || phase === 'migration-finalized';
      assert.equal(host.generation, committed ? '2' : '1', phase);
      const recovered = await host.snapshot(), pids = host.workerPids;
      assert.deepEqual(balances(recovered), ['90'], phase);
      assert.equal(recovered.ownership[0].epoch, committed ? '2' : '1', phase);
      assert.equal(recovered.ownership[0].unit, committed ? 'b' : 'a', phase);
      assert.equal(host.status().migrations[0].state, committed ? 'finalized' : 'aborted', phase);
      const beforeRetry = JSON.parse(readFileSync(join(f.directory, 'host.json'), 'utf8'));
      if (committed) {
        const retried = await host.move(f.ex.symbols.transfer, 'b', { migrationId: 'killed-move' });
        assert.deepEqual(retried, host.plan, phase);
      } else {
        await assert.rejects(host.move(f.ex.symbols.transfer, 'b', { migrationId: 'killed-move' }), /migration aborted/, phase);
      }
      assert.equal(host.generation, committed ? '2' : '1', `${phase}: retry changed generation`);
      assert.deepEqual(await host.snapshot(), recovered, `${phase}: retry changed logical state`);
      assert.deepEqual(host.workerPids, pids, `${phase}: retry replaced workers`);
      const afterRetry = JSON.parse(readFileSync(join(f.directory, 'host.json'), 'utf8'));
      assert.equal(afterRetry.migrations.length, 1, `${phase}: retry duplicated migration`);
      assert.deepEqual(afterRetry.heads, beforeRetry.heads, `${phase}: retry duplicated state publication`);
      assert.deepEqual(afterRetry.snapshots, beforeRetry.snapshots, `${phase}: retry changed retained snapshots`);
    } finally { await host?.close(); f.cleanup(); }
  }
});

test('F07 coordinator: actual parent death after sink commit requires real receipt reconciliation and isolated replay', async () => {
  for (const phase of ['sink-before-receipt', 'effect-recorded'] as const) {
    const f = fixture(); let host: ProcessHost | undefined;
    try {
      host = await ProcessHost.open(f.options);
      const alice = await host.allocateRecord(ACCOUNT, { id: text('alice'), balance: integer(100) }, { operationId: 'alice', unit: 'a' });
      const bob = await host.allocateRecord(ACCOUNT, { id: text('bob'), balance: integer(0) }, { operationId: 'bob', unit: 'b' });
      await host.close(); host = undefined;
      const child = crashingCoordinator(f, 'call', phase); assert.equal(child.signal, 'SIGKILL', child.stderr);
      assert.equal(readFileSync(join(f.directory, 'sink-commits'), 'utf8').trim().split('\n').length, 1);
      let liveCalls = 0;
      const sink: EffectAdapter = { id: 'durable-ledger-sink/1', semantics: { readOnly: false, atomicIdempotency: false, transactional: false, reconciliation: true }, execute: () => { liveCalls++; throw new Error('recovery must not redispatch'); }, reconcile: request => {
        const recorded = readFileSync(join(f.directory, 'sink-commits'), 'utf8').trim().split('\n');
        return recorded.includes(request.executionId) ? { state: 'committed', value: { tag: 'null' } } : { state: 'unknown' };
      } };
      const recoveryOptions = { ...f.options, effectRouterFactory: factory(f.directory, f.options.manifest, CAP_LEDGER_APPEND, sink) };
      host = await ProcessHost.open(recoveryOptions);
      assert.deepEqual(host.status().unresolved, ['crash-transfer']);
      assert.deepEqual(balances(await host.snapshot()), ['100', '0']);
      await assert.rejects(host.recoverOperation('crash-transfer', { strategy: 'abort-before-effects' }), /cannot abort/);
      const args = [reference(alice), reference(bob), integer(10)];
      assert.equal((await host.call(f.ex.symbols.transfer, args, { operationId: 'crash-transfer', tokens: host.issueTokens(f.ex.symbols.transfer) })).state, 'indeterminate');
      if (phase === 'sink-before-receipt') {
        assert.equal((await host.recoverOperation('crash-transfer')).state, 'indeterminate');
        const effectId = JSON.parse(readFileSync(join(f.directory, 'host.json'), 'utf8')).calls[0].effects[0].id as string;
        const directory = join(f.directory, 'effects', domainDigest('aether.effect-directory/1', effectId).split(':').at(-1)!);
        const broker = new DurableEffectBroker({ directory, clockDomain: 'test-clock/1', clock: () => 100n, authorize: () => true });
        broker.recoverDeadWriter();
        assert.equal(broker.reconcile(broker.events()[0].request, sink).state, 'committed');
      }
      const recovered = await host.recoverOperation('crash-transfer');
      assert.equal(recovered.state, 'completed'); if (recovered.state === 'completed') assert.equal(recovered.execution.ok, true);
      assert.deepEqual(balances(await host.snapshot()), ['90', '10']);
      assert.equal(liveCalls, 0);
      assert.equal(readFileSync(join(f.directory, 'sink-commits'), 'utf8').trim().split('\n').length, 1);
      const journal = JSON.parse(readFileSync(join(f.directory, 'host.json'), 'utf8')); assert.equal(journal.calls[0].recovery.strategy, 'isolated-replay');
    } finally { await host?.close(); f.cleanup(); }
  }
});

test('F07 coordinator: concurrent host instances serialize a shared canonical heap', async () => {
  const f = fixture(); let first: ProcessHost | undefined, second: ProcessHost | undefined;
  try {
    first = await ProcessHost.open(f.options); second = await ProcessHost.open(f.options);
    const alice = await first.allocateRecord(ACCOUNT, { id: text('alice'), balance: integer(100) }, { operationId: 'alice' });
    const bob = await first.allocateRecord(ACCOUNT, { id: text('bob'), balance: integer(0) }, { operationId: 'bob' });
    const args = [reference(alice), reference(bob), integer(10)];
    const results = await Promise.all([first.call(f.ex.symbols.transfer, args, { operationId: 'one', tokens: first.issueTokens(f.ex.symbols.transfer) }), second.call(f.ex.symbols.transfer, args, { operationId: 'two', tokens: second.issueTokens(f.ex.symbols.transfer) })]);
    assert.ok(results.every(result => result.state === 'completed' && result.execution.ok));
    assert.deepEqual(balances(await first.snapshot()), ['80', '20']); assert.equal(f.calls(), 2);
    assert.equal(new Set([...Object.values(first.workerPids), ...Object.values(second.workerPids)]).size, 4);
  } finally { await first?.close(); await second?.close(); f.cleanup(); }
});

test('F07 coordinator: seeded cyclic/shared logical references survive a real-worker migration from generation zero', async () => {
  const f = fixture(); let original: ProcessHost | undefined, host: ProcessHost | undefined;
  const directory = join(f.directory, 'seeded-deployment');
  try {
    original = await ProcessHost.open(f.options);
    const first = await original.allocateRecord(ACCOUNT, { id: text('cycle'), balance: integer(100) }, { operationId: 'cycle', unit: 'a' });
    const second = await original.allocateRecord(ACCOUNT, { id: text('other'), balance: integer(0) }, { operationId: 'other', unit: 'b' });
    const seed = plain(await original.snapshot()); await original.close(); original = undefined;
    const refs = [first, second].map(ref => ({ ...ref, ownerEpoch: '0' }));
    const snapshot = { ...seed, ownership: seed.ownership.map(owner => ({ ...owner, epoch: '0' })), records: seed.records.map((record, index) => ({ ...record, fields: [...record.fields, ['links', { tag: 'sequence' as const, items: [reference(refs[index]), { tag: 'result' as const, variant: 'ok' as const, value: reference(refs[0]) }] }]] as Array<readonly [string, TaggedValueV1]> })) };
    const options = { ...f.options, directory, initialGeneration: '0', initialSnapshot: snapshot };
    host = await ProcessHost.open(options);
    assert.equal(host.generation, '0');
    const result = await host.call(f.ex.symbols.transfer, refs.map(reference).concat(integer(10)), { operationId: 'seeded-transfer', tokens: host.issueTokens(f.ex.symbols.transfer) });
    assert.equal(result.state, 'completed');
    await host.move(f.ex.symbols.transfer, 'b', { migrationId: 'seeded-move' });
    const moved = await host.snapshot(); assert.deepEqual(balances(moved), ['90', '10']);
    const links = moved.records[0].fields.find(([name]) => name === 'links')![1];
    assert.deepEqual(plain(links), { tag: 'sequence', items: [reference({ ...first, ownerEpoch: '1' }), { tag: 'result', variant: 'ok', value: reference({ ...first, ownerEpoch: '1' }) }] });
    assert.ok(moved.ownership.every(owner => owner.unit === 'b' && owner.epoch === '1'));
    const pids = host.workerPids;
    await host.move(f.ex.symbols.transfer, 'b', { migrationId: 'same-unit' });
    assert.deepEqual(host.workerPids, pids); assert.equal(host.generation, '1');
    await assert.rejects(host.move(f.ex.symbols.accrue, 'b', { migrationId: 'same-unit' }), /identity_conflict/);
    await host.close(); host = await ProcessHost.open(options); assert.deepEqual(plain(await host.snapshot()), plain(moved));
    await host.close(); host = undefined;
    await assert.rejects(ProcessHost.open({ ...options, initialSnapshot: { ...snapshot, eventCursor: '1' } }), /configuration mismatch/);
  } finally { await original?.close(); await host?.close(); f.cleanup(); }
});

test('F07 coordinator: effect dispatch rechecks invocation expiry and journal corruption cannot invent outcomes', async () => {
  const f = fixture(); let host: ProcessHost | undefined;
  try {
    let time = 100;
    host = await ProcessHost.open({ ...f.options, sealer: new CapabilitySealer(new Uint8Array(32).fill(7), () => time), onPhase: phase => { if (phase === 'effect-requested') time = 100000; } });
    const first = await host.allocateRecord(ACCOUNT, { id: text('first'), balance: integer(100) }, { operationId: 'first' });
    const second = await host.allocateRecord(ACCOUNT, { id: text('second'), balance: integer(0) }, { operationId: 'second' });
    const result = await host.call(f.ex.symbols.transfer, [reference(first), reference(second), integer(10)], { operationId: 'expiry', tokens: host.issueTokens(f.ex.symbols.transfer) });
    assert.equal(result.state, 'indeterminate'); assert.equal(f.calls(), 0);
    const file = join(f.directory, 'host.json'), original = readFileSync(file, 'utf8');
    const journal = JSON.parse(original); journal.calls[0].effects[0].state = 'committed'; journal.calls[0].effects[0].value = { tag: 'null' };
    writeFileSync(file, JSON.stringify(journal));
    await assert.rejects(host.snapshot(), /effect intent\/outcome/);
    writeFileSync(file, original);
    await host.close(); host = undefined;
  } finally { await host?.close(); f.cleanup(); }
});

test('F07 coordinator: two actual parent processes retry one operation without a duplicate sink commit', async () => {
  const f = fixture(); let host: ProcessHost | undefined;
  try {
    host = await ProcessHost.open(f.options);
    await host.allocateRecord(ACCOUNT, { id: text('alice'), balance: integer(100) }, { operationId: 'alice' });
    await host.allocateRecord(ACCOUNT, { id: text('bob'), balance: integer(0) }, { operationId: 'bob' });
    await host.close(); host = undefined;
    const parents = new Set<number>();
    const run = () => new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, coordinatorCommand(f, 'call', 'never'));
      if (child.pid) parents.add(child.pid);
      let error = ''; child.stderr.on('data', chunk => { error += String(chunk); }); child.stdout.resume();
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('coordinator retry timed out')); }, 15000);
      child.on('error', failure => { clearTimeout(timer); reject(failure); });
      child.on('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(error)); });
    });
    await Promise.all([run(), run()]); assert.equal(parents.size, 2);
    host = await ProcessHost.open(f.options);
    assert.deepEqual(balances(await host.snapshot()), ['90', '10']);
    assert.equal(readFileSync(join(f.directory, 'sink-commits'), 'utf8').trim().split('\n').length, 1);
    const journal = JSON.parse(readFileSync(join(f.directory, 'host.json'), 'utf8'));
    assert.equal(journal.calls.length, 1); assert.equal(journal.calls[0].state, 'completed');
  } finally { await host?.close(); f.cleanup(); }
});

test('F07 coordinator: an actual worker timeout remains indeterminate until privileged safe abort', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'aether-host-timeout-'));
  let host: ProcessHost | undefined;
  try {
    const syms = new SymbolSpace('host-timeout'), spin = syms.define('spin'), registry = new CapabilityRegistry();
    const module = b.module_({ symbol: syms.define('module'), symbolTable: syms.table(), members: [b.fn({ symbol: spin, returns: b.Int, body: b.block(b.while_(b.bool(true), b.block()), b.ret(b.int(0))) })] });
    const plan: TopologyPlan = { shape: 'containers', units: [{ id: 'spin', members: [spin], capabilities: [], placement: 'container', memoryMb: 1 }], crossEdges: [], transportLatencyMsPerSecond: 0, monthlyCost: 0, recombinations: [], blockedMerges: [] };
    host = await ProcessHost.open({ directory, module, manifest: manifest(module, registry), plan, registry, sealer: new CapabilitySealer(), timeoutMs: 1000, authorizeRecovery: () => true });
    const pid = Object.values(host.workerPids)[0];
    const result = await host.call(spin, [], { operationId: 'spin', tokens: host.issueTokens(spin) });
    assert.equal(result.state, 'indeterminate');
    assert.throws(() => process.kill(pid, 0), error => (error as NodeJS.ErrnoException).code === 'ESRCH');
    assert.equal((await host.call(spin, [], { operationId: 'spin', tokens: host.issueTokens(spin) })).state, 'indeterminate');
    assert.deepEqual(host.workerPids, {});
    assert.equal((await host.recoverOperation('spin', { strategy: 'abort-before-effects' })).state, 'aborted');
    assert.deepEqual(host.status().unresolved, []);
  } finally { await host?.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('F07 coordinator: mutable caller objects cannot change queued intent or authorized recovery strategy', async () => {
  const f = fixture(); let host: ProcessHost | undefined;
  try {
    host = await ProcessHost.open(f.options);
    const alice = await host.allocateRecord(ACCOUNT, { id: text('alice'), balance: integer(100) }, { operationId: 'alice' });
    const bob = await host.allocateRecord(ACCOUNT, { id: text('bob'), balance: integer(0) }, { operationId: 'bob' });
    const args = [reference(alice), reference(bob), integer(10)];
    const pending = host.call(f.ex.symbols.transfer, args, { operationId: 'immutable-intent', tokens: host.issueTokens(f.ex.symbols.transfer) });
    args[2] = integer(50);
    assert.equal((await pending).state, 'completed'); assert.deepEqual(balances(await host.snapshot()), ['90', '10']);
    await host.close();
    host = await ProcessHost.open({ ...f.options, onPhase: phase => { if (phase === 'call-intent') throw new Error('hold pure operation'); }, authorizeRecovery: (_id, strategy) => strategy === 'isolated-replay' });
    assert.equal((await host.call(f.ex.symbols.feeFor, [integer(100)], { operationId: 'recover-immutable', tokens: host.issueTokens(f.ex.symbols.feeFor) })).state, 'indeterminate');
    const strategy: { strategy: 'isolated-replay' | 'abort-before-effects' } = { strategy: 'isolated-replay' };
    const recovery = host.recoverOperation('recover-immutable', strategy); strategy.strategy = 'abort-before-effects';
    assert.equal((await recovery).state, 'completed');
    const journal = JSON.parse(readFileSync(join(f.directory, 'host.json'), 'utf8'));
    assert.equal(journal.calls.find((call: { operationId: string }) => call.operationId === 'recover-immutable').recovery.strategy, 'isolated-replay');
  } finally { await host?.close(); f.cleanup(); }
});

test('F07 coordinator: caller operation IDs cannot collide with another call boundary path', async () => {
  const f = fixture(); let host: ProcessHost | undefined;
  try {
    host = await ProcessHost.open(f.options);
    const alice = await host.allocateRecord(ACCOUNT, { id: text('alice'), balance: integer(100) }, { operationId: 'alice' });
    const bob = await host.allocateRecord(ACCOUNT, { id: text('bob'), balance: integer(0) }, { operationId: 'bob' });
    const args = [reference(alice), reference(bob), integer(10)];
    const nested = await host.call(f.ex.symbols.settle, args, { operationId: 'x', tokens: host.issueTokens(f.ex.symbols.settle) });
    const direct = await host.call(f.ex.symbols.transfer, args, { operationId: 'x/call-0', tokens: host.issueTokens(f.ex.symbols.transfer) });
    assert.equal(nested.state, 'completed'); assert.equal(direct.state, 'completed');
    assert.equal(f.calls(), 2); assert.deepEqual(balances(await host.snapshot()), ['80', '20']);
    const journal = JSON.parse(readFileSync(join(f.directory, 'host.json'), 'utf8'));
    assert.notEqual(journal.calls[0].effects[0].id, journal.calls[1].effects[0].id);
  } finally { await host?.close(); f.cleanup(); }
});

test('F07 coordinator: revoked recovery authorization cannot publish a safe abort or replay result', async () => {
  const f = fixture(); let host: ProcessHost | undefined;
  try {
    let allowed = true, revokeAtCommit = false;
    host = await ProcessHost.open({ ...f.options, authorizeRecovery: () => allowed, onPhase: phase => {
      if (phase === 'call-intent') throw new Error('hold execution');
      if (phase === 'call-before-commit' && revokeAtCommit) allowed = false;
    } });
    await host.call(f.ex.symbols.feeFor, [integer(100)], { operationId: 'held', tokens: host.issueTokens(f.ex.symbols.feeFor) });
    const pending = host.recoverOperation('held', { strategy: 'abort-before-effects' }); allowed = false;
    await assert.rejects(pending, /recovery_authorization_denied/);
    assert.deepEqual(host.status().unresolved, ['held']);
    allowed = true; revokeAtCommit = true;
    assert.equal((await host.recoverOperation('held')).state, 'indeterminate');
    assert.deepEqual(host.status().unresolved, ['held']);
    const journal = JSON.parse(readFileSync(join(f.directory, 'host.json'), 'utf8'));
    assert.equal(journal.heads.length, 1);
    allowed = true; revokeAtCommit = false;
    assert.equal((await host.recoverOperation('held')).state, 'completed');
  } finally { await host?.close(); f.cleanup(); }
});

test('asynchronous recovery policy cannot publish an abort or replay', async () => {
  const f = fixture(); let host: ProcessHost | undefined;
  try {
    host = await ProcessHost.open({ ...f.options,
      onPhase: phase => { if (phase === 'call-intent') throw new Error('hold execution'); },
      authorizeRecovery: (() => Promise.resolve(true)) as unknown as NonNullable<ProcessHostOptions['authorizeRecovery']>,
    });
    assert.equal((await host.call(f.ex.symbols.feeFor, [integer(100)], { operationId: 'async-policy', tokens: host.issueTokens(f.ex.symbols.feeFor) })).state, 'indeterminate');
    const before = await host.snapshot();
    await assert.rejects(host.recoverOperation('async-policy', { strategy: 'abort-before-effects' }), /recovery_authorization_denied/);
    await assert.rejects(host.recoverOperation('async-policy'), /recovery_authorization_denied/);
    assert.deepEqual(await host.snapshot(), before);
    assert.deepEqual(host.status().unresolved, ['async-policy']);
  } finally { await host?.close(); f.cleanup(); }
});

test('F07 coordinator: current state is bound to retained transition receipts, including against old snapshot substitution', async () => {
  const f = fixture(); let host: ProcessHost | undefined;
  try {
    host = await ProcessHost.open(f.options);
    await host.allocateRecord(ACCOUNT, { id: text('account'), balance: integer(100) }, { operationId: 'account' });
    const file = join(f.directory, 'host.json'), original = readFileSync(file, 'utf8');
    const corrupt = JSON.parse(original); corrupt.snapshot.records[0].fields.find(([name]: [string, unknown]) => name === 'balance')[1].value = '999';
    writeFileSync(file, JSON.stringify(corrupt)); await assert.rejects(host.snapshot(), /state head/);
    const old = JSON.parse(original); old.snapshot = old.snapshots[0].snapshot;
    writeFileSync(file, JSON.stringify(old)); await assert.rejects(host.snapshot(), /state head/);
    const truncated = JSON.parse(original); truncated.snapshot = truncated.snapshots[0].snapshot; truncated.heads.pop();
    writeFileSync(file, JSON.stringify(truncated)); await assert.rejects(host.snapshot(), /published state transition/);
    writeFileSync(file, original); assert.deepEqual(balances(await host.snapshot()), ['100']);
  } finally { await host?.close(); f.cleanup(); }
});

test('F07 coordinator: real workers enforce declared argument/result types and sound scalar generics', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'aether-process-types-')); let host: ProcessHost | undefined;
  try {
    const syms = new SymbolSpace('host-types'), id = syms.define('id'), generic = syms.define('generic'), wrongResult = syms.define('wrongResult'), x = syms.define('x');
    const registry = new CapabilityRegistry(), effect = registry.declare('cap:test:value', { arity: 0, description: 'Deliberately wrong Unit adapter.' }).name;
    const module = b.module_({ symbol: syms.define('module'), symbolTable: syms.table(), members: [
      b.fn({ symbol: id, params: [b.param(x, b.Int)], returns: b.Int, contract: b.contract({}), body: b.block(b.ret(b.v(x))) }),
      b.fn({ symbol: generic, typeParams: ['T'], params: [b.param(x, { t: 'TypeVar', name: 'T' })], returns: { t: 'TypeVar', name: 'T' }, body: b.block(b.ret(b.v(x))) }),
      b.fn({ symbol: wrongResult, returns: b.Unit, capabilities: [effect], body: b.block(b.ret(b.invoke(effect))) }),
    ] });
    const plan: TopologyPlan = { shape: 'containers', units: [{ id: 'types', members: [id, generic, wrongResult], capabilities: [effect], placement: 'container', memoryMb: 1 }], crossEdges: [], transportLatencyMsPerSecond: 0, monthlyCost: 0, recombinations: [], blockedMerges: [] };
    const manifestValue = manifest(module, registry);
    const sink: EffectAdapter = { id: 'wrong-unit-adapter/1', semantics: { readOnly: false, atomicIdempotency: false, transactional: false, reconciliation: true }, execute: () => integer(42), reconcile: () => ({ state: 'unknown' }) };
    host = await ProcessHost.open({ directory, module, manifest: manifestValue, registry, plan, sealer: new CapabilitySealer(), effectRouterFactory: factory(directory, manifestValue, effect, sink) });
    await assert.rejects(host.call(id, [text('wrong-type')], { operationId: 'bad-type', tokens: host.issueTokens(id) }), /type|integer/i);
    await assert.rejects(host.call(id, [], { operationId: 'bad-arity', tokens: host.issueTokens(id) }), /arity/);
    assert.equal(host.operationResult('bad-type'), null);
    const box: Ty = { t: 'Record', name: typeName('type:test:typed_box'), fields: [['count', b.Int]] };
    await assert.rejects(host.allocateRecord(box, { count: text('wrong-type') }, { operationId: 'bad-record' }), /type|integer/i);
    const value = { tag: 'sequence' as const, items: [integer(1), integer(2)] };
    const inferred = await host.call(generic, [value], { operationId: 'generic-sequence', tokens: host.issueTokens(generic) });
    assert.equal(inferred.state, 'completed'); if (inferred.state === 'completed' && inferred.execution.ok) assert.deepEqual(plain(inferred.execution.value), value); else assert.fail('generic identity failed');
    const invalidReturn = await host.call(wrongResult, [], { operationId: 'bad-return', tokens: host.issueTokens(wrongResult) });
    assert.equal(invalidReturn.state, 'indeterminate');
    assert.deepEqual(host.status().unresolved, ['bad-return']);
  } finally { await host?.close(); rmSync(directory, { recursive: true, force: true }); }
});
