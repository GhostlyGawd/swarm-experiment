import { createHash, generateKeyPairSync } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { domainDigest } from '../../src/fabric/identity.ts';
import { encodeCanonical, type TaggedValueV1 } from '../../src/fabric/encoding.ts';
import { DurableEffectBroker, effectPayloadDigest, effectRequestDigest, type EffectAdapter, type EffectBrokerOptions, type EffectEventV1, type EffectRequestV1, type ExecutionMode } from '../../src/fabric/effects.ts';
import { ResourceBudgetLedger, RESOURCE_BUDGET_PROFILE, type ResourceAmounts, type ResourceBudgetOptions } from '../../src/tier2/resource-budget.ts';
import { ResourceBudgetBridge, decodeBudgetSettlementWitness, type ResourceBudgetBridgeOptions, type ResourceBudgetBridgeProfile, type BudgetObservation } from '../../src/tier2/resource-budget-bridge.ts';
import type { BudgetJournalWitness } from '../../src/fabric/budget-journal-witness.ts';

export const amount = (value: number): ResourceAmounts => ({ usdMicros: String(value), tokens: String(value), nanoseconds: String(value), memoryBytes: String(value) });
const same = (a: unknown, b: unknown): boolean => Buffer.from(encodeCanonical(a)).equals(Buffer.from(encodeCanonical(b)));
const result: TaggedValueV1 = { tag: 'int', value: '42' };
export function effectRequest(id = 'one', grant = 'grant-0'): EffectRequestV1 {
  const payload: TaggedValueV1 = { tag: 'string', value: `input:${id}` };
  return { format: 'aether.effect/1', executionId: 'bridge-test', effectId: id, executionManifest: domainDigest('aether.execution/1', 'bridge-fixture'), policyEpoch: '1', payload, payloadDigest: effectPayloadDigest(payload), capabilityGrantRef: 'effect-grant', budgetReservationId: grant, branchId: null, deadline: '1000' };
}
function durable(path: string, data: unknown): void {
  const temp = `${path}.tmp`, fd = openSync(temp, 'w', 0o600); try { writeFileSync(fd, encodeCanonical(data)); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temp, path); const parent = openSync(join(path, '..'), 'r'); try { fsyncSync(parent); } finally { closeSync(parent); }
}
interface SinkRow { request: EffectRequestV1; state: 'prepared' | 'committed' | 'not_committed'; value: TaggedValueV1 | null; charge: ResourceAmounts; commits: number }
export interface FixtureOptions {
  grants?: number; mode?: ExecutionMode; transactional?: boolean;
  bridgeFault?: ResourceBudgetBridgeOptions['fault']; ledgerFault?: ResourceBudgetOptions['fault']; brokerFault?: EffectBrokerOptions['beforePersist'];
  authorize?: EffectBrokerOptions['authorize']; bridgeAuthorize?: ResourceBudgetBridgeOptions['authorize'];
  afterSink?: () => void; afterPrepare?: () => void; unknown?: boolean;
  ledgerWitness?: BudgetJournalWitness; bridgeWitness?: BudgetJournalWitness;
  bridgeWitnessFault?: () => void;
}
export function openBridgeFixture(directory: string, options: FixtureOptions = {}) {
  mkdirSync(directory, { recursive: true }); const keyPath = join(directory, 'issuer.pem'), configPath = join(directory, 'profile.json');
  if (!existsSync(keyPath)) writeFileSync(keyPath, generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
  const key = readFileSync(keyPath, 'utf8'), sinkDirectory = join(directory, 'sink'); mkdirSync(sinkDirectory, { recursive: true });
  const sinkPath = (request: EffectRequestV1) => join(sinkDirectory, `${createHash('sha256').update(effectRequestDigest(request)).digest('hex')}.json`);
  const sink = (request: EffectRequestV1): SinkRow | null => existsSync(sinkPath(request)) ? JSON.parse(readFileSync(sinkPath(request), 'utf8')) : null;
  const innerEvidence = (row: SinkRow): TaggedValueV1 => ({ tag: 'string', value: domainDigest('aether.budget-test-sink/1', row) });
  let broker!: DurableEffectBroker;
  const terminalBrokerNoncommit = (request: EffectRequestV1): EffectEventV1 | null => {
    if (options.transactional !== false) return null;
    return broker.events().find(event => event.requestDigest === effectRequestDigest(request) && event.prepared === null
      && !event.dispatchStarted && (event.outcome?.state === 'rejected' || event.outcome?.state === 'aborted')) ?? null;
  };
  const brokerNoncommitEvidence = (event: EffectEventV1): TaggedValueV1 =>
    ({ tag: 'string', value: domainDigest('aether.budget-broker-noncommit/1', event) });
  const initialCount = existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf8')).grants.length : options.grants ?? 1;
  const ledgerOptions: ResourceBudgetOptions = { directory: join(directory, 'ledger'), key, profile: { format: RESOURCE_BUDGET_PROFILE, ledgerId: 'bridge-budget', policyEpoch: '1', initialOwner: 'budget-service', initial: amount(initialCount * 10), maxOperations: 100 }, authorize: () => true, fault: options.ledgerFault,
    journalWitness: options.ledgerWitness,
    verifySettlement: context => {
      try {
        const witness = decodeBudgetSettlementWitness(context.evidence), row = sink(witness.request), terminal = terminalBrokerNoncommit(witness.request);
        const sinkEvidence = row !== null && row.state === context.disposition && same(row.charge, context.charge)
          && same(witness.value, row.value) && same(witness.evidence, innerEvidence(row));
        const brokerEvidence = row === null && terminal !== null && context.disposition === 'not_committed'
          && same(context.charge, amount(0)) && witness.value === null && same(witness.evidence, brokerNoncommitEvidence(terminal));
        return (sinkEvidence || brokerEvidence) && witness.disposition === context.disposition && same(witness.charge, context.charge)
          && same(context.binding, { executionId: witness.request.executionId, effectId: witness.request.effectId, executionManifest: witness.request.executionManifest, payloadDigest: witness.request.payloadDigest, policyEpoch: witness.request.policyEpoch });
      } catch { return false; }
    } };
  const ledger = new ResourceBudgetLedger(ledgerOptions);
  if (!existsSync(configPath)) {
    const original = ledger.genesisHandle('budget-service'), handles = initialCount === 1 ? [original] : ledger.apply({ format: 'aether.resource-operation/1', operationId: 'fund-grants', actor: 'budget-service', operation: { kind: 'split', handle: original, parts: Array.from({ length: initialCount }, () => amount(10)) } }).handles;
    const profile: ResourceBudgetBridgeProfile = { format: 'aether.resource-budget-bridge/1', bridgeId: 'broker-budget', brokerAuthority: 'one-canonical-broker-journal', actor: 'budget-service', grants: handles.map((handle, index) => ({ id: `grant-${index}`, handle, executionManifest: effectRequest().executionManifest, policyEpoch: '1' })) };
    durable(configPath, profile);
  }
  const profile = JSON.parse(readFileSync(configPath, 'utf8')) as ResourceBudgetBridgeProfile;
  const observe = (request: EffectRequestV1): BudgetObservation => {
    const row = sink(request); if (options.unknown || row?.state === 'prepared') return { state: 'unknown' };
    if (!row) { const terminal = terminalBrokerNoncommit(request); return terminal ? { state: 'not_committed', evidence: brokerNoncommitEvidence(terminal) } : { state: 'unknown' }; }
    return row.state === 'committed' ? { state: 'committed', value: row.value!, charge: row.charge, evidence: innerEvidence(row) } : { state: 'not_committed', evidence: innerEvidence(row) };
  };
  const bridge = new ResourceBudgetBridge({ directory: join(directory, 'bridge'), profile, ledger, key, mode: () => broker.executionMode,
    authorize: options.bridgeAuthorize ?? (() => true), observe, fault: options.bridgeFault,
    journalWitness: options.bridgeWitness, witnessFault: options.bridgeWitnessFault });
  const brokerOptions: EffectBrokerOptions = { directory: join(directory, 'broker'), mode: options.mode ?? 'live', clockDomain: 'test-clock/1', clock: () => 100n, budgets: bridge, authorize: options.authorize ?? (() => true), authorizeReconciliation: () => true, beforePersist: options.brokerFault };
  broker = new DurableEffectBroker(brokerOptions);
  const prepare: NonNullable<EffectAdapter['prepare']> = request => {
    if (!sink(request)) durable(sinkPath(request), { request, state: 'prepared', value: null, charge: amount(0), commits: 0 }); options.afterPrepare?.(); return { tag: 'string', value: 'prepared' };
  };
  const commit: NonNullable<EffectAdapter['execute']> = request => {
    const old = sink(request); if (old?.state === 'not_committed') throw new Error('terminal sink cancellation'); if (old?.state === 'committed') return old.value!;
    // A real callback sees durable encumbrance before touching the sink.
    const live = ledger.snapshot('budget-service'); if (BigInt(live.inflight.usdMicros) < 10n) throw new Error('sink dispatch before durable budget reservation');
    durable(sinkPath(request), { request, state: 'committed', value: result, charge: amount(7), commits: 1 }); options.afterSink?.(); return result;
  };
  const adapter: EffectAdapter = { id: 'durable-budget-sink/1', semantics: { readOnly: false, atomicIdempotency: true, transactional: options.transactional ?? true, reconciliation: true },
    reconcile: request => { const row = sink(request); return options.unknown || !row || row.state === 'prepared' ? { state: 'unknown' } : row.state === 'committed' ? { state: 'committed', value: row.value! } : { state: 'not_committed' }; },
    ...(options.transactional === false ? { execute: commit } : { prepare, commit: (request: EffectRequestV1) => commit(request), abort: (request: EffectRequestV1) => { const old = sink(request); if (old?.state === 'committed') throw new Error('cannot abort committed sink'); durable(sinkPath(request), { request, state: 'not_committed', value: null, charge: amount(0), commits: 0 }); } }) };
  return { broker, brokerOptions, bridge, ledger, ledgerOptions, profile, adapter, sink, keyPath, observe };
}
