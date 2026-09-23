/** Companion to the bounded LivingCampaign: actual durable effects after a
 * generated Aether network case. Research-only, no production admission. */
import { createHash } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DurableEffectBroker, type EffectAdapter, type EffectOutcome } from '../../../../src/fabric/effects.ts';
import { domainDigest, type Digest, type ExecutionManifestV1 } from '../../../../src/fabric/identity.ts';
import type { TaggedValueV1 } from '../../../../src/fabric/encoding.ts';
import { GraphStore } from '../../../../src/tier1/store.ts';
import { Runtime } from '../../../../src/tier3/runtime.ts';
import { BrokerEffectRouter } from '../../../../src/tier3/effects.ts';
import { buildLedgerExample, ACCOUNT, CAP_LEDGER_APPEND } from '../../../../src/examples/ledger.ts';
import { LivingCampaign, type LivingCase, type LivingCaseResult } from '../../../../src/tier3/living-campaign.ts';
import { livingFixture } from '../microworld/fixture.ts';

export type Action = 'send' | 'partition' | 'duplicate' | 'drop' | 'heal' | 'arm-fault' | 'deliver' | 'restart' | 'replay';
export type Candidate = 'stable-effect-id' | 'attempt-derived-effect-id';
export interface BrokerCase {
  readonly format: 'aether.living-broker-case/1';
  readonly seed: string;
  readonly ordinal: number;
  readonly sourceCase: LivingCase;
  readonly actions: readonly Action[];
}
export interface BrokerCaseResult {
  readonly format: 'aether.living-broker-result/1';
  readonly candidate: Candidate;
  readonly sourceResult: LivingCaseResult;
  readonly sourceResultDigest: Digest;
  readonly sourcePassed: boolean;
  readonly passed: boolean;
  readonly failure: string | null;
  readonly coverage: readonly string[];
  readonly attemptedDeliveries: number;
  readonly liveDispatches: number;
  readonly withheldDeliveries: number;
  readonly sinkWrites: number;
  readonly journalEvents: number;
  readonly replayConsumed: number;
  readonly outcomes: readonly EffectOutcome[];
  readonly journalDigest: Digest;
  readonly sinkDigest: Digest;
}
export interface BrokerCounterexample {
  readonly format: 'aether.living-broker-counterexample/1';
  readonly candidate: Candidate;
  readonly original: BrokerCase;
  readonly originalResult: BrokerCaseResult;
  readonly shrunk: BrokerCase;
  readonly shrunkResult: BrokerCaseResult;
  readonly attempts: number;
  readonly reductions: number;
  readonly limitReached: boolean;
}
const DOMAIN = 'aether.living-broker-result/1';
const ledger = buildLedgerExample('microworld-broker');
const metadata = domainDigest('aether.fixture/1', 'living-broker-runtime');
const ledgerManifest: ExecutionManifestV1 = {
  format: 'aether.execution/1', astRoot: new GraphStore().intern(ledger.module), specRoot: metadata,
  dependencies: [], semanticsVersion: 'aether-reference/1', compilerDigest: metadata,
  target: { abiVersion: 'local/1', profileDigest: metadata, artifactDigest: metadata },
  capabilityPolicyDigest: metadata, evidencePolicyDigest: metadata,
};
const value: TaggedValueV1 = { tag: 'null' };
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
function syncDir(path: string): void { const fd = openSync(path, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } }
function durable(path: string, text: string): void { const fd = openSync(path, 'wx', 0o600); try { writeFileSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); } }
function sourceCampaign(directory: string): LivingCampaign {
  const fixture = livingFixture(); return new LivingCampaign({ ...fixture, directory });
}
export function generateCases(seed: string, count: number, directory: string): readonly BrokerCase[] {
  if (!Number.isSafeInteger(count) || count < 1 || count > 64) throw new RangeError('case bound');
  const source = sourceCampaign(directory).generate().filter(c => c.scenario === 'faulted-json-network');
  if (!source.length) throw new Error('source network campaign absent');
  return Array.from({ length: count }, (_, ordinal) => {
    // Every original run includes a partition, withheld delivery, actual receipt
    // fault, retry, reconciliation and isolated replay. Extra queue mutations vary
    // deterministically from the registered seed.
    const variant = parseInt(sha(`${seed}/${ordinal}`).slice(0, 2), 16) % 3;
    const actions: Action[] = ['send', 'partition', 'duplicate', 'deliver', 'drop', 'duplicate'];
    if (variant === 1) actions.push('duplicate', 'drop');
    if (variant === 2) actions.push('drop', 'duplicate');
    actions.push('heal', 'arm-fault', 'deliver', 'restart', 'deliver', 'replay');
    return { format: 'aether.living-broker-case/1', seed: `${seed}/${ordinal}`, ordinal,
      sourceCase: source[ordinal % source.length], actions };
  });
}

export function runCase(input: BrokerCase, candidate: Candidate, directory: string): BrokerCaseResult {
  if (candidate !== 'stable-effect-id' && candidate !== 'attempt-derived-effect-id') throw new TypeError('candidate');
  if (input.format !== 'aether.living-broker-case/1' || !Number.isSafeInteger(input.ordinal) || input.ordinal < 0
    || typeof input.seed !== 'string' || !Array.isArray(input.actions) || input.actions.length > 64
    || input.actions.some(action => !['send', 'partition', 'duplicate', 'drop', 'heal', 'arm-fault', 'deliver', 'restart', 'replay'].includes(action))) throw new TypeError('invalid broker case');
  mkdirSync(directory, { recursive: true });
  const source = sourceCampaign(join(directory, 'source'));
  const sourceResult = source.execute(input.sourceCase);
  const sourceResultDigest = domainDigest('aether.living-case-result/1', sourceResult);
  const brokerDir = join(directory, 'broker'), sinkDir = join(directory, 'sink'); mkdirSync(sinkDir, { recursive: true });
  const coverage = new Set<string>(); const queue: string[] = [], outcomes: EffectOutcome[] = [];
  let blocked = false, armed = false, faultUsed = false, attemptedDeliveries = 0, liveDispatches = 0, withheldDeliveries = 0;
  let broker = createBroker(true);
  function createBroker(injectFault: boolean): DurableEffectBroker {
    return new DurableEffectBroker({ directory: brokerDir, clockDomain: 'living-broker-clock/1', clock: () => 100n,
      authorize: () => true, authorizeReconciliation: () => true,
      beforePersist: event => { if (injectFault && armed && !faultUsed && event.state === 'committed') {
        faultUsed = true; coverage.add('fault:receipt-write'); throw new Error('injected receipt write failure');
      } },
    });
  }
  const sink: EffectAdapter = {
    id: 'adapter:living-broker/1', semantics: { readOnly: false, atomicIdempotency: true, transactional: false, reconciliation: true },
    execute: effect => {
      const filename = join(sinkDir, `${sha(JSON.stringify([effect.executionId, effect.effectId]))}.json`);
      if (!existsSync(filename)) { durable(filename, JSON.stringify({ executionId: effect.executionId, effectId: effect.effectId, value })); syncDir(sinkDir); }
      coverage.add('sink:durable-write'); return value;
    },
    reconcile: effect => {
      const filename = join(sinkDir, `${sha(JSON.stringify([effect.executionId, effect.effectId]))}.json`);
      if (!existsSync(filename)) return { state: 'not_committed' };
      const record = JSON.parse(readFileSync(filename, 'utf8')) as { executionId: string; effectId: string; value: TaggedValueV1 };
      if (record.executionId !== effect.executionId || record.effectId !== effect.effectId) throw new Error('sink identity mismatch');
      coverage.add('broker:reconciled'); return { state: 'committed', value: record.value };
    },
  };
  const invoke = (effectBroker: DurableEffectBroker, executionId: string, effectAdapter: EffectAdapter): boolean => {
    const router = new BrokerEffectRouter({ broker: effectBroker, manifest: ledgerManifest, executionId,
      policyEpoch: '1', deadline: '1000', adapters: new Map([[CAP_LEDGER_APPEND, effectAdapter]]),
      grant: () => 'grant:living-broker' });
    const runtime = new Runtime({ registry: ledger.capabilities, effectRouter: router }).load(ledger.module);
    const a = runtime.allocateRecord(ACCOUNT, { id: 'a', balance: 100n });
    const b = runtime.allocateRecord(ACCOUNT, { id: 'b', balance: 0n });
    const result = runtime.call(ledger.symbols.transfer, [a, b, 10n]);
    if (result.ok) {
      if (runtime.readRecord(a).get('balance') !== 90n) throw new Error('Aether effect caller state mismatch');
      coverage.add('aether:effect-call');
    } else if (result.fault.kind !== 'effect_indeterminate') throw new Error(`Aether effect caller fault: ${result.fault.kind}`);
    return result.ok;
  };
  const recover = (): void => {
    broker = createBroker(false); coverage.add('broker:reopened');
    for (const event of broker.events()) if (event.outcome?.state === 'indeterminate' || event.outcome === null) {
      broker.reconcile(event.request, sink);
    }
  };
  let replayConsumed = 0, replayError: string | null = null;
  for (const action of input.actions) {
    switch (action) {
      case 'send': queue.push(JSON.stringify({ intent: 'send:1', payload: 'bounded-send' })); coverage.add('network:sent'); break;
      case 'partition': blocked = true; coverage.add('network:partition'); break;
      case 'heal': blocked = false; coverage.add('network:healed'); break;
      case 'duplicate': if (queue.length) { queue.push(queue.at(-1)!); coverage.add('network:duplicated'); } break;
      case 'drop': if (queue.length) { queue.pop(); coverage.add('network:dropped'); } break;
      case 'arm-fault': armed = true; break;
      case 'deliver': {
        attemptedDeliveries++;
        if (blocked) { withheldDeliveries++; coverage.add('network:withheld'); break; }
        const frame = queue.shift(); if (!frame) { coverage.add('network:empty'); break; }
        const decoded = JSON.parse(frame) as { intent: string; payload: string };
        if (decoded.intent !== 'send:1' || decoded.payload !== 'bounded-send') throw new Error('corrupt research frame');
        liveDispatches++;
        const executionId = candidate === 'stable-effect-id' ? `living-broker:${decoded.intent}` : `living-broker:${decoded.intent}:attempt:${liveDispatches}`;
        const succeeded = invoke(broker, executionId, sink);
        const event = broker.events().find(item => item.request.executionId === executionId);
        if (!event) throw new Error('Aether call omitted broker event');
        const outcome = event.outcome ?? { state: 'indeterminate' as const, recoveryId: event.requestDigest };
        if (succeeded !== (outcome.state === 'committed')) throw new Error('Aether/broker outcome mismatch');
        outcomes.push(outcome); coverage.add('broker:live-dispatch');
        break;
      }
      case 'restart': recover(); break;
      case 'replay': {
        try {
          const events = broker.events();
          const isolated = new DurableEffectBroker({ directory: join(directory, 'isolated-replay'), mode: 'replay', replayEvents: events,
            clockDomain: 'living-broker-clock/1', authorize: () => { throw new Error('live policy in replay'); },
            authorizeReconciliation: () => { throw new Error('live cleanup in replay'); } });
          const forbidden: EffectAdapter = { ...sink,
            execute: () => { throw new Error('live sink in replay'); }, reconcile: () => { throw new Error('live reconcile in replay'); } };
          for (const event of events) {
            if (!invoke(isolated, event.request.executionId, forbidden)) throw new Error('Aether replay call did not succeed');
            if (event.outcome?.state !== 'committed') throw new Error('replay event not terminal committed');
            replayConsumed++;
          }
          isolated.assertReplayComplete(); coverage.add('broker:isolated-replay');
        } catch (error) { replayError = String(error); }
        break;
      }
    }
  }
  const events = broker.events(), sinkFiles = readdirSync(sinkDir).filter(name => name.endsWith('.json')).sort();
  const sinkWrites = sinkFiles.length;
  const journalDigest = domainDigest('aether.living-broker-journal/1', events);
  const sinkDigest = domainDigest('aether.living-broker-sink/1', sinkFiles.map(name => ({ name, content: readFileSync(join(sinkDir, name), 'utf8') })));
  const failure = !sourceResult.passed ? 'source-campaign-failed'
    : sinkWrites > 1 ? 'duplicate-effect'
    : replayError ? 'replay-failed'
    : events.some(e => e.outcome?.state !== 'committed') ? 'unresolved-effect'
    : sinkWrites !== 1 ? 'missing-effect'
    : null;
  return { format: DOMAIN, candidate, sourceResult, sourceResultDigest, sourcePassed: sourceResult.passed, passed: failure === null, failure,
    coverage: [...coverage].sort(), attemptedDeliveries, liveDispatches, withheldDeliveries, sinkWrites,
    journalEvents: events.length, replayConsumed, outcomes, journalDigest, sinkDigest };
}

export function shrinkFailure(input: BrokerCase, candidate: Candidate, expected: string, directory: string, limit: number): BrokerCounterexample {
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > 256) throw new RangeError('shrink limit');
  const originalResult = runCase(input, candidate, join(directory, 'original'));
  if (originalResult.failure !== expected) throw new Error('original failure changed');
  let shrunk = input, shrunkResult = originalResult, attempts = 0, reductions = 0, changed = true;
  while (changed && attempts < limit) {
    changed = false;
    for (let index = 0; index < shrunk.actions.length && attempts < limit; index++) {
      const proposal: BrokerCase = { ...shrunk, actions: shrunk.actions.filter((_, i) => i !== index) };
      const result = runCase(proposal, candidate, join(directory, `attempt-${attempts}`)); attempts++;
      if (result.failure === expected) { shrunk = proposal; shrunkResult = result; reductions++; changed = true; break; }
    }
  }
  return { format: 'aether.living-broker-counterexample/1', candidate, original: input, originalResult,
    shrunk, shrunkResult, attempts, reductions, limitReached: attempts === limit };
}

export function resultDigest(result: BrokerCaseResult): Digest { return domainDigest(DOMAIN, result); }
