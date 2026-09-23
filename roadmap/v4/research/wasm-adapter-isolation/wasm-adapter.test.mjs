import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { DurableEffectBroker, effectPayloadDigest } from '../../../../src/fabric/effects.ts';
import { domainDigest } from '../../../../src/fabric/identity.ts';
import { admitPureWasmGuest, hostFileSink, wasmEffectAdapter, wasmSha256 } from './wasm-adapter.mjs';
import { FORGED_IMPORT, PURE_PLUS_ONE } from './fixtures.mjs';

const directories = [];
function temporary() { const path = mkdtempSync(join(tmpdir(), 'aether-wasm-guest-')); directories.push(path); return path; }
after(() => { for (const directory of directories) rmSync(directory, { recursive: true, force: true }); });
function request(effectId = 'effect:wasm') {
  const payload = { tag: 'int', value: '41' };
  return {
    format: 'aether.effect/1', executionId: 'execution:wasm-crash', effectId, branchId: null,
    executionManifest: domainDigest('aether.execution/1', 'wasm-guest-research'), capabilityGrantRef: 'grant:wasm-research',
    policyEpoch: '1', payloadDigest: effectPayloadDigest(payload), payload, budgetReservationId: null, deadline: '1000',
  };
}
function options(directory) { return { directory, clockDomain: 'research-clock/1', clock: () => 100n, authorize: () => true }; }
function guest() { return admitPureWasmGuest(PURE_PLUS_ONE, wasmSha256(PURE_PLUS_ONE)); }
function plain(value) { return JSON.parse(JSON.stringify(value)); }

test('real Wasm bytes execute a pure, exact-hash i32 guest', () => {
  assert.equal(WebAssembly.validate(PURE_PLUS_ONE), true);
  assert.deepEqual(WebAssembly.Module.imports(new WebAssembly.Module(PURE_PLUS_ONE)), []);
  const admitted = guest();
  assert.equal(admitted.sha256, wasmSha256(PURE_PLUS_ONE));
  assert.equal(admitted.run(41), 42);
  assert.throws(() => admitted.run(0x7fffffff), /outside nonoverflowing/);
  const callerOwned = Buffer.from(PURE_PLUS_ONE);
  const pinned = admitPureWasmGuest(callerOwned, wasmSha256(callerOwned));
  callerOwned[callerOwned.length - 3] = 2;
  assert.equal(pinned.run(41), 42, 'mutation after admission cannot change compiled guest');
  assert.throws(() => admitPureWasmGuest(Buffer.alloc(65_537), '0'.repeat(64)), /Wasm bytes/);
});

test('altered bytes and a forged host import fail before guest instantiation', () => {
  const originalHash = wasmSha256(PURE_PLUS_ONE);
  const modified = Buffer.from(PURE_PLUS_ONE);
  modified[modified.length - 3] = 2; // valid i32.const 2, different executable behavior
  assert.equal(WebAssembly.validate(modified), true);
  assert.throws(() => admitPureWasmGuest(modified, originalHash), /digest mismatch/);
  assert.equal(WebAssembly.validate(FORGED_IMPORT), true);
  assert.deepEqual(WebAssembly.Module.imports(new WebAssembly.Module(FORGED_IMPORT)), [{ module: 'aether', name: 'emit', kind: 'function' }]);
  assert.throws(() => admitPureWasmGuest(FORGED_IMPORT, wasmSha256(FORGED_IMPORT)), /imports are forbidden/);
  assert.throws(() => wasmEffectAdapter({ sha256: originalHash, run: () => 0 }, { artifactSha256: originalHash, write() {}, reconcile() {} }), /admitted Wasm guest/);
  assert.throws(() => wasmEffectAdapter(guest(), { artifactSha256: wasmSha256(FORGED_IMPORT), write() {}, reconcile() {} }), /identity mismatch/);
});

test('live broker dispatch, reopen, and isolated replay invoke the host sink only once', () => {
  const directory = temporary(), sinkPath = join(directory, 'external-sink.json');
  const admitted = guest(), sink = hostFileSink(sinkPath, admitted.sha256);
  const adapter = wasmEffectAdapter(admitted, sink), input = request();
  const broker = new DurableEffectBroker(options(directory));
  const outcome = broker.dispatch(input, adapter);
  assert.equal(outcome.state, 'committed');
  assert.equal(outcome.value.tag, 'int'); assert.equal(outcome.value.value, '42');
  assert.equal(broker.events()[0].adapterId, `adapter:wasm-pure/${admitted.sha256}`);
  assert.deepEqual(broker.events()[0].transitions.map(t => [t.state, t.dispatchStarted]), [
    ['requested', false], ['reserved', false], ['prepared', false], ['prepared', true], ['committed', true],
  ]);
  const firstSinkBytes = readFileSync(sinkPath);
  assert.deepEqual(plain(new DurableEffectBroker(options(directory)).dispatch(input, adapter)), plain(outcome));
  assert.deepEqual(readFileSync(sinkPath), firstSinkBytes);
  const forbidden = wasmEffectAdapter(admitted, { artifactSha256: admitted.sha256, write() { throw new Error('replay wrote to sink'); }, reconcile() { throw new Error('replay queried sink'); } });
  const replay = new DurableEffectBroker({ ...options(temporary()), mode: 'replay', replayEvents: broker.events(), authorize() { throw new Error('replay checked live grant'); } });
  assert.deepEqual(plain(replay.dispatch(input, forbidden)), plain(outcome));
  replay.assertReplayComplete();
});

test('unknown host outcome stays indeterminate without redispatch', () => {
  const directory = temporary(), admitted = guest(), input = request('effect:unknown');
  let writes = 0;
  const adapter = wasmEffectAdapter(admitted, {
    artifactSha256: admitted.sha256,
    write() { writes++; throw new Error('connection lost after possible write'); },
    reconcile() { return { state: 'unknown' }; },
  });
  const broker = new DurableEffectBroker(options(directory));
  assert.equal(broker.dispatch(input, adapter).state, 'indeterminate');
  assert.equal(new DurableEffectBroker(options(directory)).dispatch(input, adapter).state, 'indeterminate');
  assert.equal(broker.reconcile(input, adapter).state, 'indeterminate');
  assert.equal(writes, 1);
});

test('broker grant refusal prevents a host sink write', () => {
  const directory = temporary(), sinkPath = join(directory, 'denied-sink.json');
  const admitted = guest(), adapter = wasmEffectAdapter(admitted, hostFileSink(sinkPath, admitted.sha256));
  const broker = new DurableEffectBroker({ ...options(directory), authorize: () => false });
  assert.deepEqual(plain(broker.dispatch(request('effect:denied'), adapter)), { state: 'rejected', code: 'authorization_denied' });
  assert.equal(existsSync(sinkPath), false);
});

test('real SIGKILL after durable host write reconciles without another guest or sink dispatch', () => {
  const directory = temporary(), sinkPath = join(directory, 'crash-sink.json');
  const child = spawnSync(process.execPath, ['--experimental-strip-types', new URL('./crash-worker.mjs', import.meta.url).pathname, directory, sinkPath], { encoding: 'utf8', timeout: 15_000 });
  assert.equal(child.signal, 'SIGKILL', child.stderr || child.error?.message);
  assert.equal(existsSync(sinkPath), true);
  const admitted = guest(), input = request('effect:wasm-crash');
  const replaySafeSink = hostFileSink(sinkPath, admitted.sha256);
  const adapter = wasmEffectAdapter(admitted, replaySafeSink);
  const broker = new DurableEffectBroker(options(directory));
  assert.throws(() => broker.dispatch(input, adapter), /broker_busy/);
  broker.recoverDeadWriter();
  assert.equal(broker.dispatch(input, adapter).state, 'indeterminate');
  const outcome = broker.reconcile(input, adapter);
  assert.equal(outcome.state, 'committed');
  assert.equal(outcome.value.tag, 'int'); assert.equal(outcome.value.value, '42');
  assert.deepEqual(plain(new DurableEffectBroker(options(directory)).dispatch(input, adapter)), plain(outcome));
  assert.equal(JSON.parse(readFileSync(sinkPath, 'utf8')).artifactSha256, admitted.sha256);
});
