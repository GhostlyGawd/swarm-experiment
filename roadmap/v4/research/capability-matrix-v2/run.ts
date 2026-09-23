import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as b from '../../../../src/tier1/build.ts';
import { SymbolSpace } from '../../../../src/tier1/symbols.ts';
import { ACCOUNT, CENTS, CAP_LEDGER_APPEND, buildLedgerExample } from '../../../../src/examples/ledger.ts';
import { CapabilityRegistry, CapabilitySealer } from '../../../../src/tier2/ocap.ts';
import { DurableGrantEpochs } from '../../../../src/tier2/grant-epochs.ts';
import { ScopedGrantAuthority, type ScopedGrantV2 } from '../../../../src/tier2/scoped-grants.ts';
import { createEvidenceManifest, DEFAULT_EVIDENCE_POLICY, mintLocalEvidence, type EvidenceContext } from '../../../../src/fabric/evidence.ts';
import { domainDigest, executionManifestDigest } from '../../../../src/fabric/identity.ts';
import { runtimeSnapshotDigest } from '../../../../src/fabric/snapshot.ts';
import { DurableEffectBroker, type EffectAdapter } from '../../../../src/fabric/effects.ts';
import { PromotionCoordinator } from '../../../../src/fabric/promotion.ts';
import { BrokerEffectRouter } from '../../../../src/tier3/effects.ts';
import { TopologyHost, TOPOLOGY_INVOKE } from '../../../../src/tier4/host.ts';
import { ProcessHost, PROCESS_INVOKE, type ProcessHostOptions, type ProcessEffectContext } from '../../../../src/tier4/process-host.ts';
import { ProcessDeployment, type ProcessArtifactV1 } from '../../../../src/tier4/process-deployment.ts';
import type { TaggedValueV1 } from '../../../../src/fabric/encoding.ts';
import type { CapabilityName, SymbolId } from '../../../../src/tier1/ids.ts';
import type { Term } from '../../../../src/tier1/ast.ts';
import type { TopologyPlan } from '../../../../src/tier4/topology.ts';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const out = join(root, 'roadmap/v4/research/capability-matrix-v2/results/campaign-01.json');
const sourcePaths = () => [
  ...execFileSync('git', ['ls-files', 'src'], { cwd: root, encoding: 'utf8' }).trim().split('\n').filter(Boolean),
  'roadmap/v4/research/capability-matrix-v2/run.ts',
  'roadmap/v4/research/capability-matrix-v2/verify.mjs',
].sort();
type Case = { id: string; boundary: string; attack: string; expected: string; observed: string;
  denied: boolean; sinkBefore: number; sinkAfter: number; heapBefore: string; heapAfter: string;
  sinkDelta: number; heapChanged: boolean; detail?: string };
const cases: Case[] = [];
const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const digest = (value: string) => domainDigest('aether.capability-matrix-v2/1', value);
const tagged = (n: number): TaggedValueV1 => ({ tag: 'int', value: String(n) });
const ref = (value: { heapId: string; objectId: string; ownerEpoch: string }): TaggedValueV1 => ({ tag: 'ref', value });
const manifest = (module: Term, registry: CapabilityRegistry) => createEvidenceManifest({
  module, registry, specification: 'Adversarial capability matrix.', semanticsVersion: 'reference/1',
  compilerDigest: digest('compiler'), capabilityPolicyDigest: digest('policy'),
  target: { abiVersion: 'process/1', profileDigest: digest('profile'), artifactDigest: digest('artifact') },
});
function record(input: Omit<Case, 'sinkDelta' | 'heapChanged'>) {
  cases.push({ ...input, sinkDelta: input.sinkAfter - input.sinkBefore, heapChanged: input.heapBefore !== input.heapAfter });
}
function failure(row: Case): boolean {
  if (row.expected === 'allow-one-sink-changed-heap')
    return row.observed !== 'completed' || row.denied || row.sinkDelta !== 1 || !row.heapChanged;
  if (row.expected === 'allow-zero-sink-changed-heap')
    return row.observed !== 'completed' || row.denied || row.sinkDelta !== 0 || !row.heapChanged;
  return !row.denied || row.sinkDelta !== 0 || row.heapChanged;
}
function authority(directory: string) {
  const epochs = new DurableGrantEpochs({ directory: join(directory, 'epochs'), repositoryId: 'matrix-v2' });
  let now = 100;
  const grants = new ScopedGrantAuthority({ key: new Uint8Array(32).fill(81), repositoryId: 'matrix-v2',
    clock: () => now, policyEpoch: () => epochs.policyEpoch, revocationEpoch: () => epochs.epoch,
    isRevoked: (cap, path) => epochs.isRevoked(cap, path), authorizeIssue: () => true, authorizeDelegate: () => true });
  return { epochs, grants, setTime: (value: number) => { now = value; } };
}
function attacks(valid: ScopedGrantV2, other: ScopedGrantV2, grants: ScopedGrantAuthority, capability: CapabilityName) {
  const child = grants.attenuate(valid, { capability, audience: valid.body.audience, path: [...valid.body.path, 'child'] }, 60_000);
  const wrongPath = grants.issue({ capability, audience: valid.body.audience, path: ['wrong'] }, 60_000);
  return [
    ['missing', []], ['forged', [{ ...valid, signature: '0'.repeat(64) }]], ['wrong-audience', [other]],
    ['wrong-path', [wrongPath]], ['narrowed', [child]], ['extra', [valid, wrongPath]], ['duplicate', [valid, valid]],
    ['edited-policy', [{ ...valid, body: { ...valid.body, policyEpoch: '99' } }]],
  ] as const;
}
async function topologyMatrix() {
  const directory = mkdtempSync(join(tmpdir(), 'aether-cap-matrix-topology-'));
  try {
    const { epochs, grants, setTime } = authority(directory);
    const syms = new SymbolSpace('cap-matrix-topology'), setter = syms.define('setter'), other = syms.define('other'), account = syms.define('account');
    const registry = new CapabilityRegistry();
    const module = b.module_({ symbol: syms.define('module'), members: [
      b.fn({ symbol: setter, params: [b.param(account, ACCOUNT)], returns: b.Unit,
        body: b.block(b.assign(b.place(account, 'balance'), b.typed(CENTS, 99n)), b.ret(b.unit())) }),
      b.fn({ symbol: other, returns: b.Int, body: b.ret(b.int(0)) }),
    ], symbolTable: syms.table() });
    const plan: TopologyPlan = { shape: 'containers', units: [{ id: 'a', members: [setter], capabilities: [], placement: 'container', memoryMb: 16 },
      { id: 'b', members: [other], capabilities: [], placement: 'container', memoryMb: 16 }],
      crossEdges: [], transportLatencyMsPerSecond: 0, monthlyCost: 0, recombinations: [], blockedMerges: [] };
    const host = new TopologyHost(module, plan, { registry, symbols: syms, scopedGrants: grants });
    const accountRef = host.allocateRecord(ACCOUNT, { id: 'alice', balance: 0n });
    const heap = () => hash(JSON.stringify([...host.readRecord(accountRef)], (_key, value) => typeof value === 'bigint' ? value.toString() : value));
    const valid = host.issueTokens(setter)[0] as ScopedGrantV2, wrong = host.issueTokens(other)[0] as ScopedGrantV2;
    for (const [attack, tokens] of attacks(valid, wrong, grants, TOPOLOGY_INVOKE)) {
      const before = heap(), response = host.dispatch({ id: 'topology-' + attack, from: null, to: setter, args: [accountRef], capabilities: tokens });
      record({ id: 'topology/direct/' + attack, boundary: 'TopologyHost.dispatch', attack, expected: 'deny-zero-sink-unchanged-heap',
        observed: response.ok ? 'completed' : response.fault.kind, denied: !response.ok && response.fault.kind === 'authority',
        sinkBefore: 0, sinkAfter: 0, heapBefore: before, heapAfter: heap() });
    }
    const before = heap(); epochs.revoke(TOPOLOGY_INVOKE, []);
    const revoked = host.dispatch({ id: 'topology-revoked', from: null, to: setter, args: [accountRef], capabilities: [valid] });
    record({ id: 'topology/direct/revoked', boundary: 'TopologyHost.dispatch', attack: 'revoked', expected: 'deny-zero-sink-unchanged-heap',
      observed: revoked.ok ? 'completed' : revoked.fault.kind, denied: !revoked.ok && revoked.fault.kind === 'authority',
      sinkBefore: 0, sinkAfter: 0, heapBefore: before, heapAfter: heap() });
    epochs.restore(TOPOLOGY_INVOKE, []);
    const stale = host.dispatch({ id: 'topology-stale', from: null, to: setter, args: [accountRef], capabilities: [valid] });
    record({ id: 'topology/direct/stale-epoch', boundary: 'TopologyHost.dispatch', attack: 'stale-epoch', expected: 'deny-zero-sink-unchanged-heap',
      observed: stale.ok ? 'completed' : stale.fault.kind, denied: !stale.ok && stale.fault.kind === 'authority',
      sinkBefore: 0, sinkAfter: 0, heapBefore: before, heapAfter: heap() });
    const policyOld = host.issueTokens(setter);
    epochs.advancePolicy(epochs.policyEpoch);
    const stalePolicy = host.dispatch({ id: 'topology-stale-policy', from: null, to: setter, args: [accountRef], capabilities: policyOld });
    record({ id: 'topology/direct/stale-policy', boundary: 'TopologyHost.dispatch', attack: 'policy-epoch-advanced',
      expected: 'deny-zero-sink-unchanged-heap', observed: stalePolicy.ok ? 'completed' : stalePolicy.fault.kind,
      denied: !stalePolicy.ok && stalePolicy.fault.kind === 'authority',
      sinkBefore: 0, sinkAfter: 0, heapBefore: before, heapAfter: heap() });
    const short = host.issueTokens(setter, 10); setTime(111);
    const expired = host.dispatch({ id: 'topology-expired', from: null, to: setter, args: [accountRef], capabilities: short });
    record({ id: 'topology/direct/expired', boundary: 'TopologyHost.dispatch', attack: 'expired', expected: 'deny-zero-sink-unchanged-heap',
      observed: expired.ok ? 'completed' : expired.fault.kind, denied: !expired.ok && expired.fault.kind === 'authority',
      sinkBefore: 0, sinkAfter: 0, heapBefore: before, heapAfter: heap() });
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

async function topologyContinuationMatrix() {
  for (const mode of ['closure', 'task', 'cross-unit'] as const) {
    const directory = mkdtempSync(join(tmpdir(), 'aether-cap-matrix-continuation-'));
    try {
      const { epochs, grants } = authority(directory);
      const syms = new SymbolSpace('cap-matrix-' + mode), main = syms.define('main'), remote = syms.define('remote');
      const callback = syms.define('callback'), task = syms.define('task');
      const registry = new CapabilityRegistry();
      const revoke = registry.declare('cap:test:revoke', { arity: 0, description: 'Advance grant epoch.' }).name;
      const protectedCap = registry.declare('cap:test:protected', { arity: 0, description: 'Protected sink.' }).name;
      const continuation = mode === 'closure'
        ? b.block(b.let_(callback, { t: 'Fn', params: [], returns: b.Unit, capabilities: [protectedCap] },
          b.lambda({ returns: b.Unit, capabilities: [protectedCap], body: b.invoke(protectedCap) })),
          b.exprStmt(b.invoke(revoke)), b.exprStmt(b.apply(b.v(callback))), b.ret(b.unit()))
        : mode === 'task'
          ? b.block(b.let_(task, { t: 'Task', result: b.Unit }, b.spawn(b.invoke(protectedCap))),
            b.exprStmt(b.invoke(revoke)), b.exprStmt(b.await_(b.v(task))), b.ret(b.unit()))
          : b.block(b.exprStmt(b.invoke(revoke)), b.exprStmt(b.call(remote)), b.ret(b.unit()));
      const declarations = [b.fn({ symbol: main, returns: b.Unit, capabilities: [revoke, protectedCap], body: continuation }),
        ...(mode === 'cross-unit' ? [b.fn({ symbol: remote, returns: b.Unit, capabilities: [protectedCap],
          body: b.block(b.exprStmt(b.invoke(protectedCap)), b.ret(b.unit())) })] : [])];
      const module = b.module_({ symbol: syms.define('module'), members: declarations, symbolTable: syms.table() });
      const plan: TopologyPlan = { shape: 'containers', units: [
        { id: 'a', members: [main], capabilities: [revoke, protectedCap], placement: 'container', memoryMb: 16 },
        ...(mode === 'cross-unit' ? [{ id: 'b', members: [remote], capabilities: [protectedCap], placement: 'container' as const, memoryMb: 16 }] : []),
      ], crossEdges: [], transportLatencyMsPerSecond: 0, monthlyCost: 0, recombinations: [], blockedMerges: [] };
      let revokeCalls = 0, protectedCalls = 0;
      const host = new TopologyHost(module, plan, { registry, symbols: syms, scopedGrants: grants,
        effects: new Map([[revoke, () => { revokeCalls++; epochs.revoke(TOPOLOGY_INVOKE, []); return null; }],
          [protectedCap, () => { protectedCalls++; return null; }]]) });
      const stable = host.allocateRecord(ACCOUNT, { id: 'stable', balance: 0n });
      const heap = () => hash(JSON.stringify([...host.readRecord(stable)], (_key, value) => typeof value === 'bigint' ? value.toString() : value));
      const before = heap(), result = host.dispatch({ id: 'topology-' + mode, from: null, to: main, args: [], capabilities: host.issueTokens(main) });
      record({ id: 'topology/' + mode + '/revoked-before-protected-sink', boundary: 'TopologyHost continuation',
        attack: 'in-flight-revocation', expected: 'deny-zero-sink-unchanged-heap', observed: result.ok ? 'completed' : result.fault.message,
        denied: !result.ok && /authority_denied/.test(result.fault.message) && revokeCalls === 1,
        sinkBefore: 0, sinkAfter: protectedCalls, heapBefore: before, heapAfter: heap(), detail: 'Revocation effect count=' + revokeCalls });
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }
}

function brokerFactory(directory: string, manifestValue: ReturnType<typeof manifest>, sink: EffectAdapter) {
  return (context: ProcessEffectContext) => {
    const effectDirectory = join(directory, 'effects', digest(context.operationId).split(':').at(-1)!);
    const live = new DurableEffectBroker({ directory: effectDirectory, clockDomain: 'matrix/1', clock: () => 100n, authorize: () => true });
    const broker = context.mode === 'live' ? live : new DurableEffectBroker({ directory: effectDirectory, mode: 'replay',
      clockDomain: 'matrix/1', clock: () => 100n, authorize: () => false, replayEvents: live.events() });
    return new BrokerEffectRouter({ broker, manifest: manifestValue, executionId: context.operationId, policyEpoch: '1',
      deadline: '1000', adapters: new Map([[CAP_LEDGER_APPEND, sink]]), grant: () => 'matrix-grant' });
  };
}
function ledgerPlan(ex: ReturnType<typeof buildLedgerExample>): TopologyPlan {
  return { shape: 'containers', units: [
    { id: 'a', members: [ex.symbols.transfer], capabilities: [CAP_LEDGER_APPEND], placement: 'container', memoryMb: 16 },
    { id: 'b', members: [ex.symbols.feeFor, ex.symbols.settle, ex.symbols.accrue], capabilities: [CAP_LEDGER_APPEND], placement: 'container', memoryMb: 48 },
  ], crossEdges: [], transportLatencyMsPerSecond: 0, monthlyCost: 0, recombinations: [], blockedMerges: [] };
}
async function processMatrix() {
  const directory = mkdtempSync(join(tmpdir(), 'aether-cap-matrix-process-'));
  const ex = buildLedgerExample('cap-matrix-process'), { epochs, grants, setTime } = authority(directory);
  let calls = 0, host: ProcessHost | undefined;
  const sink: EffectAdapter = { id: 'matrix-sink/1', semantics: { readOnly: false, atomicIdempotency: false, transactional: false, reconciliation: true },
    execute: () => { calls++; return { tag: 'null' }; }, reconcile: () => ({ state: 'unknown' }) };
  const manifestValue = manifest(ex.module, ex.capabilities);
  const options: ProcessHostOptions = { directory: join(directory, 'host'), module: ex.module, manifest: manifestValue,
    plan: ledgerPlan(ex), registry: ex.capabilities, sealer: new CapabilitySealer(new Uint8Array(32).fill(82), () => 100),
    scopedGrants: grants, effectRouterFactory: brokerFactory(directory, manifestValue, sink), authorizeRecovery: () => true };
  try {
    host = await ProcessHost.open(options);
    const alice = await host.allocateRecord(ACCOUNT, { id: { tag: 'string', value: 'alice' }, balance: tagged(100) }, { operationId: 'alice' });
    const bob = await host.allocateRecord(ACCOUNT, { id: { tag: 'string', value: 'bob' }, balance: tagged(0) }, { operationId: 'bob' });
    const args = [ref(alice), ref(bob), tagged(10)];
    const heap = async () => runtimeSnapshotDigest(await host!.snapshot());
    const valid = host.issueScopedTokens(ex.symbols.transfer);
    const wrong = host.issueScopedTokens(ex.symbols.feeFor)[0];
    const matrix = attacks(valid[0], wrong, grants, PROCESS_INVOKE);
    for (const [attack, replacement] of matrix) {
      const tokens = attack === 'missing' ? [] : attack === 'extra' || attack === 'duplicate'
        ? [valid[0], valid[1], replacement[1]] : [replacement[0], valid[1]];
      const before = await heap(), sinkBefore = calls;
      let observed = '', denied = false;
      try { const response = await host.call(ex.symbols.transfer, args, { operationId: 'process-' + attack, tokens }); observed = response.state; }
      catch (error) { observed = String(error); denied = /authority_denied|identity mismatch/.test(observed); }
      record({ id: 'process/direct/' + attack, boundary: 'ProcessHost.call', attack, expected: 'deny-zero-sink-unchanged-heap',
        observed, denied, sinkBefore, sinkAfter: calls, heapBefore: before, heapAfter: await heap() });
    }
    const effectGrant = valid[1];
    const effectAttacks = [
      ['forged', [{ ...effectGrant, signature: '0'.repeat(64) }]],
      ['wrong-audience', [grants.issue({ capability: CAP_LEDGER_APPEND, audience: ex.symbols.feeFor, path: effectGrant.body.path }, 60_000)]],
      ['wrong-path', [grants.issue({ capability: CAP_LEDGER_APPEND, audience: ex.symbols.transfer, path: ['wrong'] }, 60_000)]],
      ['narrowed', [grants.attenuate(effectGrant, { capability: CAP_LEDGER_APPEND, audience: ex.symbols.transfer,
        path: [...effectGrant.body.path, 'child'] }, 60_000)]],
      ['duplicate', [effectGrant, effectGrant]],
    ] as const;
    for (const [attack, replacement] of effectAttacks) {
      const tokens = [valid[0], ...replacement], before = await heap(), sinkBefore = calls;
      let observed = '', denied = false;
      try {
        const response = await host.call(ex.symbols.transfer, args, { operationId: 'process-effect-' + attack, tokens });
        observed = JSON.stringify(response);
        denied = response.state !== 'completed' || !response.execution.ok;
      }
      catch (error) { observed = String(error); denied = /authority_denied|identity mismatch/.test(observed); }
      record({ id: 'process/effect-grant/' + attack, boundary: 'ProcessHost.call effect authority', attack,
        expected: 'deny-zero-sink-unchanged-heap', observed, denied,
        sinkBefore, sinkAfter: calls, heapBefore: before, heapAfter: await heap() });
    }
    const before = await heap(); epochs.revoke(PROCESS_INVOKE, []);
    let observed = '', denied = false;
    try { await host.call(ex.symbols.transfer, args, { operationId: 'process-revoked', tokens: valid }); observed = 'completed'; }
    catch (error) { observed = String(error); denied = /authority_denied/.test(observed); }
    record({ id: 'process/direct/revoked', boundary: 'ProcessHost.call', attack: 'revoked', expected: 'deny-zero-sink-unchanged-heap',
      observed, denied, sinkBefore: calls, sinkAfter: calls, heapBefore: before, heapAfter: await heap() });
    epochs.restore(PROCESS_INVOKE, []);
    try { await host.call(ex.symbols.transfer, args, { operationId: 'process-stale', tokens: valid }); observed = 'completed'; denied = false; }
    catch (error) { observed = String(error); denied = /authority_denied/.test(observed); }
    record({ id: 'process/direct/stale-epoch', boundary: 'ProcessHost.call', attack: 'stale-epoch', expected: 'deny-zero-sink-unchanged-heap',
      observed, denied, sinkBefore: calls, sinkAfter: calls, heapBefore: before, heapAfter: await heap() });
    const policyOld = host.issueScopedTokens(ex.symbols.transfer);
    epochs.advancePolicy(epochs.policyEpoch);
    try { await host.call(ex.symbols.transfer, args, { operationId: 'process-stale-policy', tokens: policyOld }); observed = 'completed'; denied = false; }
    catch (error) { observed = String(error); denied = /authority_denied/.test(observed); }
    record({ id: 'process/direct/stale-policy', boundary: 'ProcessHost.call', attack: 'policy-epoch-advanced',
      expected: 'deny-zero-sink-unchanged-heap', observed, denied,
      sinkBefore: calls, sinkAfter: calls, heapBefore: before, heapAfter: await heap() });
    const short = host.issueScopedTokens(ex.symbols.transfer, 10); setTime(111);
    try { await host.call(ex.symbols.transfer, args, { operationId: 'process-expired', tokens: short }); observed = 'completed'; denied = false; }
    catch (error) { observed = String(error); denied = /authority_denied/.test(observed); }
    record({ id: 'process/direct/expired', boundary: 'ProcessHost.call', attack: 'expired', expected: 'deny-zero-sink-unchanged-heap',
      observed, denied, sinkBefore: calls, sinkAfter: calls, heapBefore: before, heapAfter: await heap() });
    setTime(100);
    const nestedBefore = await heap(), nestedSink = calls;
    try { await host.call(ex.symbols.settle, args, { operationId: 'process-nested-wrong', tokens: host.issueScopedTokens(ex.symbols.transfer) }); observed = 'completed'; denied = false; }
    catch (error) { observed = String(error); denied = /authority_denied/.test(observed); }
    record({ id: 'process/cross-process/wrong-audience', boundary: 'ProcessHost.call nested A-B', attack: 'wrong-audience',
      expected: 'deny-zero-sink-unchanged-heap', observed, denied, sinkBefore: nestedSink, sinkAfter: calls,
      heapBefore: nestedBefore, heapAfter: await heap() });
    const nestedTokens = host.issueScopedTokens(ex.symbols.settle);
    const nestedResult = await host.call(ex.symbols.settle, args, { operationId: 'process-nested-valid', tokens: nestedTokens });
    record({ id: 'process/cross-process/positive', boundary: 'ProcessHost.call nested A-B', attack: 'valid',
      expected: 'allow-one-sink-changed-heap', observed: nestedResult.state === 'completed' && nestedResult.execution.ok ? 'completed' : JSON.stringify(nestedResult),
      denied: false, sinkBefore: nestedSink, sinkAfter: calls, heapBefore: nestedBefore, heapAfter: await heap() });
    const afterPositive = await heap();
    epochs.revoke(PROCESS_INVOKE, []);
    const beforeReplaySink = calls;
    try { const response = await host.call(ex.symbols.settle, args, { operationId: 'process-nested-valid', tokens: nestedTokens }); observed = response.state; denied = false; }
    catch (error) { observed = String(error); denied = /authority_denied/.test(observed); }
    record({ id: 'process/cross-process/replay-revoked', boundary: 'ProcessHost historical receipt', attack: 'replay-after-revocation',
      expected: 'deny-zero-sink-unchanged-heap', observed, denied, sinkBefore: beforeReplaySink, sinkAfter: calls,
      heapBefore: afterPositive, heapAfter: await heap() });
    await host.close(); host = undefined;
    host = await ProcessHost.open(options);
    const reopened = await heap();
    record({ id: 'process/reopen/denial-persistence', boundary: 'ProcessHost.open', attack: 'reopen',
      expected: 'deny-zero-sink-unchanged-heap', observed: reopened === afterPositive ? 'unchanged' : 'changed',
      denied: reopened === afterPositive, sinkBefore: calls, sinkAfter: calls, heapBefore: afterPositive, heapAfter: reopened });
  } finally { await host?.close(); rmSync(directory, { recursive: true, force: true }); }
}

async function processRevocationWindows() {
  {
    const directory = mkdtempSync(join(tmpdir(), 'aether-cap-matrix-pre-effect-'));
    const ex = buildLedgerExample('cap-matrix-pre-effect'), { epochs, grants } = authority(directory);
    const manifestValue = manifest(ex.module, ex.capabilities);
    let calls = 0, phaseSeen = false, host: ProcessHost | undefined;
    const sink: EffectAdapter = { id: 'matrix-window-sink/1',
      semantics: { readOnly: false, atomicIdempotency: false, transactional: false, reconciliation: true },
      execute: () => { calls++; return { tag: 'null' }; }, reconcile: () => ({ state: 'unknown' }) };
    const options: ProcessHostOptions = { directory: join(directory, 'host'), module: ex.module, manifest: manifestValue, plan: ledgerPlan(ex),
      registry: ex.capabilities, sealer: new CapabilitySealer(new Uint8Array(32).fill(83), () => 100),
      scopedGrants: grants, effectRouterFactory: brokerFactory(directory, manifestValue, sink), authorizeRecovery: () => true,
      onPhase: phase => { if (phase === 'effect-requested') { phaseSeen = true; epochs.revoke(CAP_LEDGER_APPEND, []); } } };
    try {
      host = await ProcessHost.open(options);
      const alice = await host.allocateRecord(ACCOUNT, { id: { tag: 'string', value: 'alice' }, balance: tagged(100) }, { operationId: 'alice' });
      const bob = await host.allocateRecord(ACCOUNT, { id: { tag: 'string', value: 'bob' }, balance: tagged(0) }, { operationId: 'bob' });
      const args = [ref(alice), ref(bob), tagged(10)], tokens = host.issueScopedTokens(ex.symbols.transfer);
      const before = runtimeSnapshotDigest(await host.snapshot());
      const result = await host.call(ex.symbols.transfer, args, { operationId: 'pre-effect', tokens });
      const denied = result.state !== 'completed' || !result.execution.ok;
      record({ id: 'process/effect/revoked-before-sink', boundary: 'ProcessHost BrokerEffectRouter', attack: 'revoke-at-effect-requested',
        expected: 'deny-zero-sink-unchanged-heap', observed: JSON.stringify(result), denied: denied && phaseSeen,
        sinkBefore: 0, sinkAfter: calls, heapBefore: before, heapAfter: runtimeSnapshotDigest(await host.snapshot()) });
      await host.close(); host = undefined;
      host = await ProcessHost.open(options);
      const afterReopen = runtimeSnapshotDigest(await host.snapshot());
      record({ id: 'process/effect/reopen-after-revocation', boundary: 'ProcessHost.open', attack: 'reopen',
        expected: 'deny-zero-sink-unchanged-heap', observed: afterReopen === before ? 'unchanged' : 'changed',
        denied: afterReopen === before, sinkBefore: calls, sinkAfter: calls, heapBefore: before, heapAfter: afterReopen });
      let retry = '';
      try { const response = await host.call(ex.symbols.transfer, args, { operationId: 'pre-effect', tokens }); retry = response.state; }
      catch (error) { retry = String(error); }
      const afterRetry = runtimeSnapshotDigest(await host.snapshot());
      record({ id: 'process/effect/retry-revoked', boundary: 'ProcessHost.call retry', attack: 'retry-old-token',
        expected: 'deny-zero-sink-unchanged-heap', observed: retry, denied: retry !== 'completed',
        sinkBefore: calls, sinkAfter: calls, heapBefore: before, heapAfter: afterRetry });
    } finally { await host?.close(); rmSync(directory, { recursive: true, force: true }); }
  }
  {
    const directory = mkdtempSync(join(tmpdir(), 'aether-cap-matrix-nested-window-'));
    const ex = buildLedgerExample('cap-matrix-nested-window'), { epochs, grants } = authority(directory);
    const manifestValue = manifest(ex.module, ex.capabilities);
    let calls = 0, phaseSeen = false, host: ProcessHost | undefined;
    const sink: EffectAdapter = { id: 'matrix-nested-window-sink/1',
      semantics: { readOnly: false, atomicIdempotency: false, transactional: false, reconciliation: true },
      execute: () => { calls++; return { tag: 'null' }; }, reconcile: () => ({ state: 'unknown' }) };
    const options: ProcessHostOptions = { directory: join(directory, 'host'), module: ex.module, manifest: manifestValue, plan: ledgerPlan(ex),
      registry: ex.capabilities, sealer: new CapabilitySealer(new Uint8Array(32).fill(86), () => 100),
      scopedGrants: grants, effectRouterFactory: brokerFactory(directory, manifestValue, sink), authorizeRecovery: () => true,
      onPhase: phase => { if (phase === 'boundary') { phaseSeen = true; epochs.revoke(PROCESS_INVOKE, []); } } };
    try {
      host = await ProcessHost.open(options);
      const alice = await host.allocateRecord(ACCOUNT, { id: { tag: 'string', value: 'alice' }, balance: tagged(100) }, { operationId: 'alice' });
      const bob = await host.allocateRecord(ACCOUNT, { id: { tag: 'string', value: 'bob' }, balance: tagged(0) }, { operationId: 'bob' });
      const args = [ref(alice), ref(bob), tagged(10)], tokens = host.issueScopedTokens(ex.symbols.settle);
      const before = runtimeSnapshotDigest(await host.snapshot());
      const result = await host.call(ex.symbols.settle, args, { operationId: 'nested-boundary-revoked', tokens });
      const denied = result.state !== 'completed' || !result.execution.ok;
      record({ id: 'process/cross-process/revoked-at-boundary', boundary: 'ProcessHost onCall',
        attack: 'revoke-before-nested-worker', expected: 'deny-zero-sink-unchanged-heap',
        observed: JSON.stringify(result), denied: denied && phaseSeen, sinkBefore: 0, sinkAfter: calls,
        heapBefore: before, heapAfter: runtimeSnapshotDigest(await host.snapshot()) });
      await host.close(); host = undefined;
      host = await ProcessHost.open(options);
      const reopened = runtimeSnapshotDigest(await host.snapshot());
      record({ id: 'process/cross-process/reopen-after-boundary-revocation', boundary: 'ProcessHost.open',
        attack: 'reopen', expected: 'deny-zero-sink-unchanged-heap',
        observed: reopened === before ? 'unchanged' : 'changed', denied: reopened === before,
        sinkBefore: calls, sinkAfter: calls, heapBefore: before, heapAfter: reopened });
    } finally { await host?.close(); rmSync(directory, { recursive: true, force: true }); }
  }
  {
    const directory = mkdtempSync(join(tmpdir(), 'aether-cap-matrix-final-'));
    const { epochs, grants } = authority(directory);
    const syms = new SymbolSpace('cap-matrix-final'), setter = syms.define('setter'), account = syms.define('account');
    const registry = new CapabilityRegistry();
    const module = b.module_({ symbol: syms.define('module'), members: [
      b.fn({ symbol: setter, params: [b.param(account, ACCOUNT)], returns: b.Unit,
        body: b.block(b.assign(b.place(account, 'balance'), b.typed(CENTS, 99n)), b.ret(b.unit())) }),
    ], symbolTable: syms.table() });
    const plan: TopologyPlan = { shape: 'containers', units: [{ id: 'a', members: [setter], capabilities: [], placement: 'container', memoryMb: 16 }],
      crossEdges: [], transportLatencyMsPerSecond: 0, monthlyCost: 0, recombinations: [], blockedMerges: [] };
    let phaseSeen = false, host: ProcessHost | undefined;
    const options: ProcessHostOptions = { directory: join(directory, 'host'), module, manifest: manifest(module, registry), plan, registry,
      sealer: new CapabilitySealer(new Uint8Array(32).fill(84), () => 100), scopedGrants: grants,
      onPhase: phase => { if (phase === 'call-before-commit') { phaseSeen = true; epochs.revoke(PROCESS_INVOKE, []); } } };
    try {
      host = await ProcessHost.open(options);
      const accountRef = await host.allocateRecord(ACCOUNT, { id: { tag: 'string', value: 'alice' }, balance: tagged(0) }, { operationId: 'alice' });
      const before = runtimeSnapshotDigest(await host.snapshot());
      const result = await host.call(setter, [ref(accountRef)], { operationId: 'final-revoke', tokens: host.issueScopedTokens(setter) });
      record({ id: 'process/final-publication/revoked', boundary: 'ProcessHost final commit', attack: 'revoke-at-call-before-commit',
        expected: 'deny-zero-sink-unchanged-heap', observed: JSON.stringify(result),
        denied: phaseSeen && result.state === 'indeterminate', sinkBefore: 0, sinkAfter: 0,
        heapBefore: before, heapAfter: runtimeSnapshotDigest(await host.snapshot()) });
      await host.close(); host = undefined;
      host = await ProcessHost.open(options);
      const afterReopen = runtimeSnapshotDigest(await host.snapshot());
      record({ id: 'process/final-publication/reopen', boundary: 'ProcessHost.open', attack: 'reopen',
        expected: 'deny-zero-sink-unchanged-heap', observed: afterReopen === before ? 'unchanged' : 'changed',
        denied: afterReopen === before, sinkBefore: 0, sinkAfter: 0, heapBefore: before, heapAfter: afterReopen });
    } finally { await host?.close(); rmSync(directory, { recursive: true, force: true }); }
  }
}

async function deploymentMatrix() {
  const directory = mkdtempSync(join(tmpdir(), 'aether-cap-matrix-deployment-'));
  const { epochs, grants, setTime } = authority(directory);
  const syms = new SymbolSpace('cap-matrix-deployment'), setter = syms.define('setter'), other = syms.define('other'), account = syms.define('account');
  const registry = new CapabilityRegistry();
  const module = b.module_({ symbol: syms.define('module'), members: [
    b.fn({ symbol: setter, params: [b.param(account, ACCOUNT)], returns: b.Unit,
      contract: b.contract({ modifies: [b.place(account, 'balance')] }),
      body: b.block(b.assign(b.place(account, 'balance'), b.typed(CENTS, 99n)), b.ret(b.unit())) }),
    b.fn({ symbol: other, returns: b.Int, contract: b.contract({}), body: b.ret(b.int(0)) }),
  ], symbolTable: syms.table() });
  const plan: TopologyPlan = { shape: 'containers', units: [
    { id: 'a', members: [setter], capabilities: [], placement: 'container', memoryMb: 16 },
    { id: 'b', members: [other], capabilities: [], placement: 'container', memoryMb: 16 },
  ], crossEdges: [], transportLatencyMsPerSecond: 0, monthlyCost: 0, recombinations: [], blockedMerges: [] };
  const context: EvidenceContext = { module, registry, specification: 'Pure setter is capability guarded.',
    semanticsVersion: 'reference/1', compilerDigest: digest('deployment-compiler'), capabilityPolicyDigest: digest('deployment-policy'),
    target: { abiVersion: 'process/1', profileDigest: digest('deployment-profile'), artifactDigest: digest('deployment-artifact') },
    policy: { ...DEFAULT_EVIDENCE_POLICY, requireFormal: false } };
  const evidence = mintLocalEvidence(context), keys = generateKeyPairSync('ed25519');
  const admission = { repositoryId: 'matrix-v2', membershipEpoch: '1', policyEpoch: '1', eligibleGovernors: ['governor'] };
  const coordinator = new PromotionCoordinator({ profile: 'baseline-governor-v1', directory: join(directory, 'coordinator'),
    repositoryId: 'matrix-v2', genesisManifest: executionManifestDigest(evidence.manifest), authority: () => admission,
    governorKey: () => keys.publicKey, clock: () => 100n });
  const factory = (_artifact: ProcessArtifactV1) => ({ sealer: new CapabilitySealer(new Uint8Array(32).fill(85), () => 100),
    scopedGrants: grants, authorizeRecovery: () => true });
  const options = { directory: join(directory, 'deployment'), coordinator, capabilityProfile: 'scoped-v2' as const,
    factories: new Map([['matrix-services/1', factory]]), genesis: { context, evidence, plan, factoryId: 'matrix-services/1' } };
  let deployment: ProcessDeployment | undefined;
  try {
    deployment = await ProcessDeployment.open(options);
    const accountRef = await deployment.allocateRecord(ACCOUNT, { id: { tag: 'string', value: 'alice' }, balance: tagged(0) }, { operationId: 'alice', unit: 'a' });
    const args = [ref(accountRef)], heap = async () => runtimeSnapshotDigest(await deployment!.snapshot());
    const valid = deployment.issueScopedTokens(setter)[0], wrong = deployment.issueScopedTokens(other)[0];
    for (const [attack, tokens] of attacks(valid, wrong, grants, PROCESS_INVOKE)) {
      const before = await heap(); let observed = '', denied = false;
      try { const response = await deployment.call(setter, args, { operationId: 'deploy-' + attack, tokens }); observed = response.state; }
      catch (error) { observed = String(error); denied = /authority_denied|identity mismatch/.test(observed); }
      record({ id: 'deployment/direct/' + attack, boundary: 'ProcessDeployment.call', attack,
        expected: 'deny-zero-sink-unchanged-heap', observed, denied, sinkBefore: 0, sinkAfter: 0,
        heapBefore: before, heapAfter: await heap() });
    }
    const before = await heap(); epochs.revoke(PROCESS_INVOKE, []);
    let observed = '', denied = false;
    try { await deployment.call(setter, args, { operationId: 'deploy-revoked', tokens: [valid] }); observed = 'completed'; }
    catch (error) { observed = String(error); denied = /authority_denied/.test(observed); }
    record({ id: 'deployment/direct/revoked', boundary: 'ProcessDeployment.call', attack: 'revoked',
      expected: 'deny-zero-sink-unchanged-heap', observed, denied, sinkBefore: 0, sinkAfter: 0,
      heapBefore: before, heapAfter: await heap() });
    epochs.restore(PROCESS_INVOKE, []);
    try { await deployment.call(setter, args, { operationId: 'deploy-stale', tokens: [valid] }); observed = 'completed'; denied = false; }
    catch (error) { observed = String(error); denied = /authority_denied/.test(observed); }
    record({ id: 'deployment/direct/stale-epoch', boundary: 'ProcessDeployment.call', attack: 'stale-epoch',
      expected: 'deny-zero-sink-unchanged-heap', observed, denied, sinkBefore: 0, sinkAfter: 0,
      heapBefore: before, heapAfter: await heap() });
    const policyOld = deployment.issueScopedTokens(setter);
    epochs.advancePolicy(epochs.policyEpoch);
    try { await deployment.call(setter, args, { operationId: 'deploy-stale-policy', tokens: policyOld }); observed = 'completed'; denied = false; }
    catch (error) { observed = String(error); denied = /authority_denied/.test(observed); }
    record({ id: 'deployment/direct/stale-policy', boundary: 'ProcessDeployment.call', attack: 'policy-epoch-advanced',
      expected: 'deny-zero-sink-unchanged-heap', observed, denied, sinkBefore: 0, sinkAfter: 0,
      heapBefore: before, heapAfter: await heap() });
    const short = deployment.issueScopedTokens(setter, 10); setTime(111);
    try { await deployment.call(setter, args, { operationId: 'deploy-expired', tokens: short }); observed = 'completed'; denied = false; }
    catch (error) { observed = String(error); denied = /authority_denied/.test(observed); }
    record({ id: 'deployment/direct/expired', boundary: 'ProcessDeployment.call', attack: 'expired',
      expected: 'deny-zero-sink-unchanged-heap', observed, denied, sinkBefore: 0, sinkAfter: 0,
      heapBefore: before, heapAfter: await heap() });
    await deployment.close(); deployment = undefined;
    deployment = await ProcessDeployment.open(options);
    const reopened = await heap();
    record({ id: 'deployment/reopen/denial-persistence', boundary: 'ProcessDeployment.open', attack: 'reopen',
      expected: 'deny-zero-sink-unchanged-heap', observed: reopened === before ? 'unchanged' : 'changed',
      denied: reopened === before, sinkBefore: 0, sinkAfter: 0, heapBefore: before, heapAfter: reopened });
    setTime(100);
    const freshTokens = deployment.issueScopedTokens(setter);
    const response = await deployment.call(setter, args, { operationId: 'deploy-valid', tokens: freshTokens });
    record({ id: 'deployment/direct/positive', boundary: 'ProcessDeployment.call', attack: 'valid',
      expected: 'allow-zero-sink-changed-heap',
      observed: response.state === 'completed' && response.execution.ok ? 'completed' : JSON.stringify(response), denied: false,
      sinkBefore: 0, sinkAfter: 0, heapBefore: before, heapAfter: await heap() });
    const afterPositive = await heap(); epochs.revoke(PROCESS_INVOKE, []);
    try { const replay = await deployment.call(setter, args, { operationId: 'deploy-valid', tokens: freshTokens }); observed = replay.state; denied = false; }
    catch (error) { observed = String(error); denied = /authority_denied/.test(observed); }
    record({ id: 'deployment/direct/replay-revoked', boundary: 'ProcessDeployment historical receipt', attack: 'replay-after-revocation',
      expected: 'deny-zero-sink-unchanged-heap', observed, denied, sinkBefore: 0, sinkAfter: 0,
      heapBefore: afterPositive, heapAfter: await heap() });
    await deployment.close(); deployment = undefined;
    deployment = await ProcessDeployment.open(options);
    try { const replay = await deployment.call(setter, args, { operationId: 'deploy-valid', tokens: freshTokens }); observed = replay.state; denied = false; }
    catch (error) { observed = String(error); denied = /authority_denied/.test(observed); }
    record({ id: 'deployment/direct/replay-revoked-after-reopen', boundary: 'ProcessDeployment historical receipt', attack: 'replay-after-reopen',
      expected: 'deny-zero-sink-unchanged-heap', observed, denied, sinkBefore: 0, sinkAfter: 0,
      heapBefore: afterPositive, heapAfter: await heap() });
  } finally { await deployment?.close(); rmSync(directory, { recursive: true, force: true }); }
}

async function main() {
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim().length > 0;
  const sourceHashes = Object.fromEntries(sourcePaths().map(path => [path, hash(readFileSync(join(root, path)))]));
  const sourceCommitted = Object.entries(sourceHashes).every(([path, fileHash]) => {
    try { return hash(execFileSync('git', ['show', `${commit}:${path}`], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] })) === fileHash; }
    catch { return false; }
  });
  await topologyMatrix();
  await topologyContinuationMatrix();
  await processMatrix();
  await processRevocationWindows();
  await deploymentMatrix();
  const sourceStable = Object.entries(sourceHashes).every(([path, fileHash]) => hash(readFileSync(join(root, path))) === fileHash);
  const output = { format: 'aether.capability-matrix-v2/1', commit, dirty, sourceCommitted,
    sourceStable, nodeVersion: process.version, platform: process.platform, sourceHashes, cases };
  mkdirSync(join(root, 'roadmap/v4/research/capability-matrix-v2/results'), { recursive: true });
  writeFileSync(out, JSON.stringify(output, null, 2) + '\n');
  console.log(JSON.stringify({ output: out, commit, dirty, sourceCommitted, sourceStable, cases: cases.length,
    failures: cases.filter(failure).map(item => item.id) }, null, 2));
  assert.equal(sourceStable, true, 'source changed during campaign');
  assert.equal(cases.filter(failure).length, 0, 'adversarial matrix found a boundary failure');
}
await main();
