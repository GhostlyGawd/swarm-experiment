import { generateKeyPairSync } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as b from '../../src/tier1/build.ts';
import { capability, type CapabilityName } from '../../src/tier1/ids.ts';
import { SymbolSpace } from '../../src/tier1/symbols.ts';
import { CapabilityRegistry, CapabilitySealer } from '../../src/tier2/ocap.ts';
import { DurableEffectBroker, type EffectAdapter } from '../../src/fabric/effects.ts';
import { createEvidenceManifest } from '../../src/fabric/evidence.ts';
import { generatePortableCertificate } from '../../src/tier2/portable-proof-producer.ts';
import { domainDigest } from '../../src/fabric/identity.ts';
import { BrokerEffectRouter } from '../../src/tier3/effects.ts';
import { ProcessHost, type ProcessHostOptions, type ProcessHostPhase } from '../../src/tier4/process-host.ts';
import { ProcessFallbackSupervisor, type ProcessFallbackOptions } from '../../src/tier4/process-fallback.ts';
import type { ConservativeFallbackProofInput } from '../../src/tier3/fallback-proof.ts';
import type { TopologyPlan } from '../../src/tier4/topology.ts';

export function processFallbackFixture(directory: string, mode: 'pre-effect-fault' | 'post-effect-fault' | 'both-fault' | 'tier1-success' | 'proved-pre-effect' | 'proved-post-effect' | 'proved-tier1-success' | 'proved-definitive-noncommit', fault?: ProcessFallbackOptions['fault'], hostPhase?: (phase: ProcessHostPhase) => void, afterSink?: () => void, beforeSink?: () => void) {
  const s = new SymbolSpace('process-fallback-fixture'), tier1 = s.define('tier1'), tier2 = s.define('tier2'), arg = s.define('arg');
  const effect = capability('cap:fallback:testsink'), registry = new CapabilityRegistry();
  registry.define({ name: effect, domain: 'fallback', operation: 'testsink', arity: 1, description: 'test sink', effectful: true });
  const proved = mode.startsWith('proved-');
  const contract = proved ? b.contract({ requires: [b.clause(b.ge(b.v(arg), b.int(0)), 'nonnegative')],
    ensures: [b.clause(b.eq(b.result(), b.add(b.old(b.v(arg)), b.int(1))), 'incremented')] }) : b.contract({});
  const callSink = () => b.exprStmt(b.invoke(effect, b.v(arg)));
  const fail = b.assert_(b.bool(false), 'test-fault');
  const first = b.fn({ symbol: tier1, params: [b.param(arg, b.Int)], returns: b.Int, capabilities: [effect], purity: 'effectful', contract,
    body: mode === 'pre-effect-fault' || mode === 'both-fault' || mode === 'proved-pre-effect' ? b.block(fail, b.ret(b.int(1)))
      : mode === 'post-effect-fault' || mode === 'proved-post-effect' || mode === 'proved-definitive-noncommit'
        ? b.block(callSink(), fail, b.ret(b.int(1)))
        : mode === 'proved-tier1-success' ? b.block(callSink(), b.ret(b.add(b.v(arg), b.int(1))))
        : b.block(callSink(), b.ret(b.int(1))) });
  const second = b.fn({ symbol: tier2, params: [b.param(arg, b.Int)], returns: b.Int,
    capabilities: proved ? [] : [effect], purity: proved ? 'pure' : 'effectful', contract,
    body: proved ? b.ret(b.add(b.v(arg), b.int(1))) : mode === 'both-fault' ? b.block(fail, b.ret(b.int(2))) : b.block(callSink(), b.ret(b.int(2))) });
  const moduleSymbol = s.define('module');
  const module = b.module_({ symbol: moduleSymbol, members: [first, second], symbolTable: s.table() });
  const digest = (value: string) => domainDigest('aether.process-fallback-test/1', value);
  const specification = proved ? 'Proved conservative fallback.' : 'Effect aware fallback test.';
  const manifestOptions = { registry, specification, semanticsVersion: proved ? 'aether-reference/1' : 'reference/1',
    compilerDigest: digest('compiler'), capabilityPolicyDigest: digest('policy'),
    target: { abiVersion: 'process/1', profileDigest: digest('profile'), artifactDigest: digest('artifact') } };
  const manifest = createEvidenceManifest({ ...manifestOptions, module });
  let conservativeProof: ConservativeFallbackProofInput | undefined;
  if (proved) {
    const proofModule = b.module_({ symbol: moduleSymbol, members: [second], symbolTable: s.table() });
    const proofManifest = createEvidenceManifest({ ...manifestOptions, module: proofModule });
    const certificate = generatePortableCertificate(proofModule,
      { manifest: proofManifest, expectedManifest: proofManifest, specification });
    if (!certificate) throw new Error('proved fixture lacks a portable Tier 2 certificate');
    conservativeProof = { module: proofModule, manifest: proofManifest, specification, certificate };
  }
  const plan: TopologyPlan = { shape: 'containers', units: [{ id: 'unit', members: [tier1, tier2], capabilities: [effect], placement: 'container', memoryMb: 16 }], crossEdges: [], transportLatencyMsPerSecond: 0, monthlyCost: 0, recombinations: [], blockedMerges: [] };
  const { privateKey } = generateKeyPairSync('ed25519');
  const key = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const sinkCallsFile = join(directory, 'sink-calls');
  const sink: EffectAdapter = { id: 'fallback-sink/1', semantics: { readOnly: false, atomicIdempotency: false, transactional: false, reconciliation: true },
    execute: () => { beforeSink?.(); appendFileSync(sinkCallsFile, 'call\n'); afterSink?.(); return { tag: 'null' }; },
    reconcile: () => mode === 'proved-definitive-noncommit' ? { state: 'not_committed' } : { state: 'unknown' } };
  const hostOptions: ProcessHostOptions = { directory: join(directory, 'host'), module, manifest, plan, registry, sealer: new CapabilitySealer(new Uint8Array(32).fill(17), () => 100), authorizeRecovery: () => true, onPhase: phase => hostPhase?.(phase),
    effectRouterFactory: context => {
      const path = join(directory, 'effects', domainDigest('aether.process-fallback-effect-directory/1', context.operationId).split(':').at(-1)!);
      const live = new DurableEffectBroker({ directory: path, clockDomain: 'test-clock/1', clock: () => 100n, authorize: () => true });
      const broker = context.mode === 'live' ? live : new DurableEffectBroker({ directory: path, mode: 'replay', clockDomain: 'test-clock/1', clock: () => 100n, authorize: () => false, replayEvents: live.events() });
      return new BrokerEffectRouter({ broker, manifest, executionId: context.operationId, policyEpoch: '1', deadline: '1000', adapters: new Map<CapabilityName, EffectAdapter>([[effect, sink]]), grant: () => 'grant:fallback-test' });
    } };
  const open = async (override: { key?: string; fault?: ProcessFallbackOptions['fault']; hostPhase?: (phase: ProcessHostPhase) => void; tokensFor?: ProcessFallbackOptions['tokensFor']; conservativeProof?: ConservativeFallbackProofInput | null } = {}) => {
    const host = await ProcessHost.open({ ...hostOptions, onPhase: phase => (override.hostPhase ?? hostPhase)?.(phase) });
    const supervisor = new ProcessFallbackSupervisor({ directory: join(directory, 'supervisor'), host, module, manifest, tier1, tier2, key: override.key ?? key,
      tokensFor: override.tokensFor ?? ((_tier, symbol) => host.issueTokens(symbol)), fault: override.fault ?? fault,
      conservativeProof: override.conservativeProof === null ? undefined : override.conservativeProof ?? conservativeProof });
    return { host, supervisor };
  };
  return { open, hostOptions, key, module, manifest, tier1, tier2, effect, conservativeProof,
    calls: () => existsSync(sinkCallsFile) ? readFileSync(sinkCallsFile, 'utf8').trimEnd().split('\n').length : 0 };
}
