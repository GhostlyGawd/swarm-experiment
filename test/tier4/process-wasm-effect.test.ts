import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as b from '../../src/tier1/build.ts';
import { capability, typeName } from '../../src/tier1/ids.ts';
import { SymbolSpace } from '../../src/tier1/symbols.ts';
import { GraphStore } from '../../src/tier1/store.ts';
import { CapabilityRegistry, CapabilitySealer } from '../../src/tier2/ocap.ts';
import { ScopedGrantAuthority } from '../../src/tier2/scoped-grants.ts';
import { wasmAdapterArtifactForBytes, admitWasmAdapterBytes, admittedAdapterArtifactDigest, admittedWasmAdapterCapability } from '../../src/tier2/adapter-artifact.ts';
import { createEffectSignerAnchor } from '../../src/tier2/effect-signer-anchor.ts';
import { effectResourcePolicyDigestV4, signEffectResourcePolicyV4, assertEffectResourceAdapterV4, type EffectResourcePolicyBodyV4 } from '../../src/tier2/effect-resource-policy.ts';
import { createEvidenceManifest } from '../../src/fabric/evidence.ts';
import { DurableEffectBroker, effectAdapterDigest, type EffectAdapter } from '../../src/fabric/effects.ts';
import { domainDigest } from '../../src/fabric/identity.ts';
import { BrokerEffectRouter } from '../../src/tier3/effects.ts';
import { ProcessHost, type ProcessHostOptions } from '../../src/tier4/process-host.ts';
import type { TopologyPlan } from '../../src/tier4/topology.ts';

function incrementWasm(): Uint8Array {
  const sec = (id: number, body: number[]) => [id, body.length, ...body];
  const name = (value: string) => [value.length, ...Buffer.from(value)];
  const body = [0, 0x20, 0, 0x45, 0x04, 0x40, 0x00, 0x0b, 0x20, 0, 0x41, 1, 0x6a, 0x0b];
  return Uint8Array.from([0, 97, 115, 109, 1, 0, 0, 0,
    ...sec(1, [1, 0x60, 1, 0x7f, 1, 0x7f]), ...sec(3, [1, 0]), ...sec(5, [1, 1, 1, 1]),
    ...sec(7, [2, ...name('run'), 0, 0, ...name('memory'), 2, 0]), ...sec(10, [1, body.length, ...body])]);
}

test('anchored V4 ProcessHost runs exact isolated Wasm through a real worker and durable broker', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'aether-process-wasm-')); let host: ProcessHost | undefined;
  try {
    const symbols = new SymbolSpace('process-wasm-effect'), entry = symbols.define('entry'), x = symbols.define('x');
    const entryRef = symbols.define('entryRef'), recordParam = symbols.define('recordParam');
    const record = { t: 'Record' as const, name: typeName('type:test:wasm_argument_record'), fields: [['value', b.Int] as const] };
    const CAP = capability('cap:test:wasm_i32');
    const registry = new CapabilityRegistry();
    registry.define({ name: CAP, domain: 'test', operation: 'wasm_i32', arity: 1, description: 'read-only Wasm i32', effectful: true });
    const module = b.module_({ symbol: symbols.define('module'), symbolTable: symbols.table(), members: [
      b.fn({ symbol: entry, params: [b.param(x, b.Int)], returns: b.Int, capabilities: [CAP], purity: 'effectful', contract: b.contract({}),
        body: b.block(b.exprStmt(b.invoke(CAP, b.v(x))), b.ret(b.v(x))) }),
      b.fn({ symbol: entryRef, params: [b.param(recordParam, record)], returns: b.Int, capabilities: [CAP], purity: 'effectful', contract: b.contract({}),
        body: b.block(b.exprStmt(b.invoke(CAP, b.v(recordParam))), b.ret(b.int(0))) }),
    ] });
    const bytes = incrementWasm(), artifact = wasmAdapterArtifactForBytes(bytes, CAP, 'wasm-i32/1', { maxMemoryPages: 1, timeoutMs: 1000 });
    const approved = admitWasmAdapterBytes(bytes, artifact);
    const grants = new ScopedGrantAuthority({ key: new Uint8Array(32).fill(23), repositoryId: 'wasm-repository', clock: () => 100,
      policyEpoch: () => '0', revocationEpoch: () => '0', isRevoked: () => false,
      authorizeIssue: () => true, authorizeDelegate: () => true });
    const body: EffectResourcePolicyBodyV4 = { format: 'aether.effect-resource-policy/4', repositoryId: grants.repositoryId,
      astRoot: new GraphStore().intern(module), policyEpoch: '0', rules: [{ capability: CAP, prefix: ['wasm'], argument: null, deadline: '1000', clockDomain: 'wasm-clock/1',
        adapterId: approved.id, adapterDigest: effectAdapterDigest(approved), adapterArtifactDigest: admittedAdapterArtifactDigest(approved)! }] };
    const digest = (value: string) => domainDigest('aether.process-wasm-test/1', value);
    const manifest = createEvidenceManifest({ module, registry, specification: 'Read-only integer guest operation.', semanticsVersion: 'reference/1',
      compilerDigest: digest('compiler'), capabilityPolicyDigest: effectResourcePolicyDigestV4(body),
      target: { abiVersion: 'process/1', profileDigest: digest('profile'), artifactDigest: digest('artifact') } });
    const keys = generateKeyPairSync('ed25519'); let epoch = '0';
    const anchor = createEffectSignerAnchor({ repositoryId: grants.repositoryId, signer: 'wasm-policy', epochAuthorityId: 'wasm-epoch-authority',
      publicKey: keys.publicKey, currentEpoch: () => epoch });
    const signedEffectResourcePolicy = signEffectResourcePolicyV4(body, anchor.signer, keys.privateKey);
    const foreignCapability = capability('cap:test:foreign_wasm');
    const foreignArtifact = wasmAdapterArtifactForBytes(bytes, foreignCapability, approved.id, { maxMemoryPages: 1, timeoutMs: 1000 });
    const foreignAdapter = admitWasmAdapterBytes(bytes, foreignArtifact);
    const foreignRule = { ...body.rules[0], adapterArtifactDigest: admittedAdapterArtifactDigest(foreignAdapter)! };
    const foreignPolicy = signEffectResourcePolicyV4({ ...body, rules: [foreignRule] }, anchor.signer, keys.privateKey);
    assert.throws(() => assertEffectResourceAdapterV4(foreignPolicy, CAP, { id: foreignAdapter.id,
      digest: effectAdapterDigest(foreignAdapter), artifactDigest: admittedAdapterArtifactDigest(foreignAdapter),
      artifactCapability: admittedWasmAdapterCapability(foreignAdapter) }), /outside signed resource policy v4/);
    const plan: TopologyPlan = { shape: 'containers', units: [{ id: 'worker', members: [entry, entryRef], capabilities: [CAP], placement: 'container', memoryMb: 16 }],
      crossEdges: [], transportLatencyMsPerSecond: 0, monthlyCost: 0, recombinations: [], blockedMerges: [] };
    let active: EffectAdapter = approved, lastBroker: DurableEffectBroker | undefined, allowReconciliation = true, allowAbort = true;
    let failBeforeCommit = false;
    let routeFault: 'execution' | 'manifest' | 'epoch' | 'deadline' | 'clock' | 'grant' | null = null;
    let refuseGenerationOne = false;
    const options: ProcessHostOptions = { directory: join(directory, 'host'), module, manifest, plan, registry,
      sealer: new CapabilitySealer(new Uint8Array(32).fill(31), () => 100), scopedGrants: grants,
      effectSignerAnchor: anchor, anchoredEffectPolicyProfile: 'isolated-wasm-v4', signedEffectResourcePolicy,
      authorizeRecovery: (_operationId, strategy) => strategy !== 'abort-readonly-wasm' || allowAbort,
      onPhase: phase => { if (phase === 'call-before-commit' && failBeforeCommit) { failBeforeCommit = false; throw new Error('simulated commit observer failure'); } },
      effectRouterFactory: context => {
        const path = join(directory, 'effects', domainDigest('aether.process-wasm-directory/1', context.operationId).split(':').at(-1)!);
        const clockDomain = routeFault === 'clock' ? 'wrong-clock/1' : context.clockDomain!;
        const live = new DurableEffectBroker({ directory: path, clockDomain, clock: () => 100n,
          authorize: () => true, authorizeReconciliation: () => allowReconciliation });
        const broker = context.mode === 'live' ? live : new DurableEffectBroker({ directory: path, mode: 'replay', clockDomain,
          clock: () => 100n, authorize: () => false, replayEvents: live.events() });
        if (context.mode === 'live') lastBroker = live;
        return new BrokerEffectRouter({ broker,
          manifest: routeFault === 'manifest' ? { ...manifest, target: { ...manifest.target, artifactDigest: digest('wrong-artifact') } } : manifest,
          executionId: routeFault === 'execution' ? 'wrong-execution' : context.operationId,
          policyEpoch: routeFault === 'epoch' ? '1' : context.policyEpoch!,
          deadline: routeFault === 'deadline' ? '2000' : context.deadline!,
          adapters: new Map([[CAP, refuseGenerationOne && context.generation === '1' ? { ...approved } : active]]),
          grantRef: routeFault === 'grant' ? 'wrong-grant' : context.grantRef!,
          grant: () => { throw new Error('v4 must not invoke a grant callback'); } });
      } };
    assert.throws(() => effectResourcePolicyDigestV4({ ...body, rules: [{ ...body.rules[0], argument: 0 }] }), /fixed resource path/);
    const wrongSemantics = domainDigest('aether.effect-adapter/1', { id: approved.id, semantics: { ...approved.semantics, readOnly: false } });
    assert.throws(() => effectResourcePolicyDigestV4({ ...body, rules: [{ ...body.rules[0], adapterDigest: wrongSemantics }] }), /read-only Wasm adapter semantics/);
    await assert.rejects(ProcessHost.open({ ...options, anchoredEffectPolicyProfile: undefined }), /explicit anchored-v2\/isolated-wasm-v4 profile/);
    const wrongKey = generateKeyPairSync('ed25519');
    await assert.rejects(ProcessHost.open({ ...options, signedEffectResourcePolicy: signEffectResourcePolicyV4(body, anchor.signer, wrongKey.privateKey) }), /untrusted effect resource policy v4 signer/);
    host = await ProcessHost.open(options);
    const tokens = () => host!.issueScopedTokens(entry, 60_000, new Map([[CAP, ['wasm']]]));
    const success = await host.call(entry, [{ tag: 'int', value: '41' }], { operationId: 'approved-wasm', tokens: tokens() });
    assert.equal(success.state, 'completed');
    const event = lastBroker?.events()[0];
    assert.equal(event?.outcome?.state, 'committed');
    if (event?.outcome?.state === 'committed') assert.deepEqual(JSON.parse(JSON.stringify(event.outcome.value)), { tag: 'int', value: '42' });
    const count = lastBroker?.events().length;
    const allocated = await host.allocateRecord(record, { value: { tag: 'int', value: '1' } }, { operationId: 'record-input' });
    const wrongShape = await host.call(entryRef, [{ tag: 'ref', value: allocated }], { operationId: 'ref-input',
      tokens: host.issueScopedTokens(entryRef, 60_000, new Map([[CAP, ['wasm']]])) });
    assert.equal(wrongShape.state, 'completed'); if (wrongShape.state === 'completed') assert.equal(wrongShape.execution.ok, false);
    assert.equal(lastBroker?.events().length, count, 'reference argument cannot reach the broker');
    assert.equal(host.status().unresolved.length, 0);
    const invalid = await host.call(entry, [{ tag: 'int', value: '2147483648' }], { operationId: 'invalid-i32', tokens: tokens() });
    assert.equal(invalid.state, 'completed'); if (invalid.state === 'completed') assert.equal(invalid.execution.ok, false);
    assert.equal(lastBroker?.events().length, count, 'invalid i32 cannot reach the broker');
    assert.equal(host.status().unresolved.length, 0, 'invalid i32 must not wedge the process state domain');
    const trapped = await host.call(entry, [{ tag: 'int', value: '0' }], { operationId: 'trapped-wasm', tokens: tokens() });
    assert.equal(trapped.state, 'completed'); if (trapped.state === 'completed') assert.equal(trapped.execution.ok, false);
    assert.equal(lastBroker?.events()[0]?.outcome?.state, 'aborted');
    assert.equal(host.status().unresolved.length, 0, 'read-only guest trap must reconcile without blocking serving');
    const afterInvalid = await host.call(entry, [{ tag: 'int', value: '7' }], { operationId: 'valid-after-invalid', tokens: tokens() });
    assert.equal(afterInvalid.state, 'completed'); if (afterInvalid.state === 'completed') assert.equal(afterInvalid.execution.ok, true);
    allowReconciliation = false;
    const pending = await host.call(entry, [{ tag: 'int', value: '0' }], { operationId: 'pending-readonly', tokens: tokens() });
    assert.equal(pending.state, 'indeterminate');
    assert.deepEqual(host.status().unresolved, ['pending-readonly']);
    allowReconciliation = true;
    const replayed = await host.recoverOperation('pending-readonly', { strategy: 'isolated-replay' });
    assert.equal(replayed.state, 'completed'); if (replayed.state === 'completed') assert.equal(replayed.execution.ok, false);
    assert.equal(host.status().unresolved.length, 0, 'authorized reconciliation must release serving');
    allowReconciliation = false;
    const interrupted = await host.call(entry, [{ tag: 'int', value: '0' }], { operationId: 'interrupted-readonly', tokens: tokens() });
    assert.equal(interrupted.state, 'indeterminate');
    assert.deepEqual(host.status().unresolved, ['interrupted-readonly']);
    allowAbort = false;
    await assert.rejects(host.recoverOperation('interrupted-readonly', { strategy: 'abort-readonly-wasm' }), /recovery_authorization_denied/);
    assert.deepEqual(host.status().unresolved, ['interrupted-readonly']);
    allowAbort = true;
    const recovered = await host.recoverOperation('interrupted-readonly', { strategy: 'abort-readonly-wasm' });
    assert.equal(recovered.state, 'aborted');
    assert.equal(host.status().unresolved.length, 0);
    allowReconciliation = true;
    const afterAbort = await host.call(entry, [{ tag: 'int', value: '8' }], { operationId: 'valid-after-abort', tokens: tokens() });
    assert.equal(afterAbort.state, 'completed'); if (afterAbort.state === 'completed') assert.equal(afterAbort.execution.ok, true);
    failBeforeCommit = true;
    const committedGuest = await host.call(entry, [{ tag: 'int', value: '6' }], { operationId: 'guest-before-call-commit', tokens: tokens() });
    assert.equal(committedGuest.state, 'indeterminate');
    const disposition = host.operationEffectDisposition(host.status().unresolved[0]);
    assert.equal(disposition?.effects[0]?.state, 'committed');
    const terminal = await host.recoverOperation('guest-before-call-commit', { strategy: 'abort-readonly-wasm' });
    assert.equal(terminal.state, 'aborted');
    assert.equal(host.status().unresolved.length, 0);
    for (const fault of ['execution', 'manifest', 'epoch', 'deadline', 'clock', 'grant'] as const) {
      routeFault = fault;
      const denied = await host.call(entry, [{ tag: 'int', value: '41' }], { operationId: `wrong-${fault}`, tokens: tokens() });
      assert.equal(denied.state, 'completed'); if (denied.state === 'completed') assert.equal(denied.execution.ok, false);
      assert.equal(lastBroker?.events().length, 0, `${fault} router cannot dispatch`);
      assert.equal(host.status().unresolved.length, 0, `${fault} router cannot block serving`);
    }
    routeFault = null;
    active = { ...approved }; // Structural copy lacks the admitted artifact brand.
    const denied = await host.call(entry, [{ tag: 'int', value: '41' }], { operationId: 'unbranded-wasm', tokens: tokens() });
    assert.equal(denied.state, 'completed'); if (denied.state === 'completed') assert.equal(denied.execution.ok, false);
    assert.equal(lastBroker?.events().length, 0, 'unbranded adapter cannot reach its broker');
    assert.equal(host.status().unresolved.length, 0, 'unbranded adapter must not wedge serving');
    assert.equal(count, 1);
    active = approved;
    await host.close(); host = undefined;
    refuseGenerationOne = true;
    await assert.rejects(ProcessHost.open(options), /isolated Wasm adapter artifact is outside signed resource policy v4/);
    refuseGenerationOne = false;
    epoch = '1';
    await assert.rejects(ProcessHost.open(options), /stale or foreign effect resource policy v4/);
    epoch = '0';
    host = await ProcessHost.open(options);
    assert.equal(host.status().unresolved.length, 0, 'preflight denials remain terminal after reopen');
  } finally { await host?.close(); rmSync(directory, { recursive: true, force: true }); }
});
