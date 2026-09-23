import { DurableEffectBroker, effectPayloadDigest } from '../../../../src/fabric/effects.ts';
import { domainDigest } from '../../../../src/fabric/identity.ts';
import { admitPureWasmGuest, hostFileSink, wasmEffectAdapter, wasmSha256 } from './wasm-adapter.mjs';
import { PURE_PLUS_ONE } from './fixtures.mjs';

const [directory, sinkPath] = process.argv.slice(2);
const payload = { tag: 'int', value: '41' };
const request = {
  format: 'aether.effect/1', executionId: 'execution:wasm-crash', effectId: 'effect:wasm-crash', branchId: null,
  executionManifest: domainDigest('aether.execution/1', 'wasm-guest-research'), capabilityGrantRef: 'grant:wasm-research',
  policyEpoch: '1', payloadDigest: effectPayloadDigest(payload), payload, budgetReservationId: null, deadline: '1000',
};
const broker = new DurableEffectBroker({ directory, clockDomain: 'research-clock/1', clock: () => 100n, authorize: () => true });
const guest = admitPureWasmGuest(PURE_PLUS_ONE, wasmSha256(PURE_PLUS_ONE));
const sink = hostFileSink(sinkPath, guest.sha256, () => process.kill(process.pid, 'SIGKILL'));
broker.dispatch(request, wasmEffectAdapter(guest, sink));
throw new Error('crash injection did not fire');
