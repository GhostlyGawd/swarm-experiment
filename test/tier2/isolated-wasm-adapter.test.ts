import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { DurableEffectBroker, effectAdapterDigest, effectPayloadDigest, type EffectAdapter, type EffectRequestV1 } from '../../src/fabric/effects.ts';
import { domainDigest } from '../../src/fabric/identity.ts';
import { encodeCanonical } from '../../src/fabric/encoding.ts';
import { createIsolatedWasmAdapter } from '../../src/tier2/isolated-wasm-adapter.ts';
import { capability } from '../../src/tier1/ids.ts';

function uint(value: number): number[] {
  const out: number[] = [];
  do { const byte = value & 0x7f; value >>>= 7; out.push(value ? byte | 0x80 : byte); } while (value);
  return out;
}
function section(id: number, bytes: number[]): number[] { return [id, ...uint(bytes.length), ...bytes]; }
function name(value: string): number[] { const bytes = [...Buffer.from(value)]; return [...uint(bytes.length), ...bytes]; }
function moduleBytes(code: number[], opts: { memoryMax?: number; noMax?: boolean; imports?: boolean; params?: number[] } = {}): Uint8Array {
  const types = section(1, [1, 0x60, ...(opts.params ? [opts.params.length, ...opts.params] : [1, 0x7f]), 1, 0x7f]);
  const imports = opts.imports ? section(2, [1, ...name('env'), ...name('steal'), 0, 0]) : [];
  const functions = section(3, [1, 0]);
  const memory = section(5, [1, ...(opts.noMax ? [0, 1] : [1, 1, ...uint(opts.memoryMax ?? 1)])]);
  const exports = section(7, [2, ...name('run'), 0, opts.imports ? 1 : 0, ...name('memory'), 2, 0]);
  const body = [0, ...code, 0x0b];
  const program = section(10, [1, ...uint(body.length), ...body]);
  return Uint8Array.from([0, 97, 115, 109, 1, 0, 0, 0, ...types, ...imports, ...functions, ...memory, ...exports, ...program]);
}
const increment = moduleBytes([0x20, 0, 0x41, 1, 0x6a]);
const infinite = moduleBytes([0x03, 0x40, 0x0c, 0, 0x0b, 0x41, 0]);
const trapZero = moduleBytes([0x20, 0, 0x45, 0x04, 0x40, 0, 0x0b, 0x20, 0]);
const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const CAP = capability('cap:test:isolated');
const adapter = (bytes = increment, timeoutMs = 1000) => createIsolatedWasmAdapter({ bytes, expectedSha256: digest(bytes), id: 'isolated-i32/1', capability: CAP, timeoutMs, maxMemoryPages: 1 });
function request(value: string, effectId = 'effect:one'): EffectRequestV1 {
  const payload = { tag: 'sequence' as const, items: [{ tag: 'string' as const, value: CAP }, { tag: 'int' as const, value }] };
  return { format: 'aether.effect/1', executionId: 'isolated-execution', effectId, branchId: null,
    executionManifest: domainDigest('aether.execution/1', 'isolated-test'), capabilityGrantRef: 'grant:isolated', policyEpoch: '1',
    payloadDigest: effectPayloadDigest(payload), payload, budgetReservationId: null, deadline: '1000' };
}

test('bounded import-free i32 guest executes through an EffectAdapter with exact source identity', () => {
  const bytes = Uint8Array.from(increment), admitted = adapter(bytes);
  bytes[bytes.length - 2] ^= 1;
  assert.deepEqual(admitted.execute!(request('41')), { tag: 'int', value: '42' }, 'caller byte mutation cannot change admitted code');
  assert.equal(admitted.semantics.readOnly, true);
  assert.equal(effectAdapterDigest(admitted), domainDigest('aether.effect-adapter/1', { id: admitted.id, semantics: admitted.semantics }));
  assert.throws(() => createIsolatedWasmAdapter({ bytes: increment, expectedSha256: '0'.repeat(64), id: 'isolated-i32/1', capability: CAP, timeoutMs: 1000, maxMemoryPages: 1 }), /source_mismatch/);
  assert.throws(() => admitted.execute!({ ...request('41'), payload: { tag: 'int', value: '0' } }), /payload digest mismatch/);
  const wrong = { tag: 'sequence' as const, items: [{ tag: 'string' as const, value: 'cap:test:wrong' }, { tag: 'int' as const, value: '41' }] };
  assert.throws(() => admitted.execute!({ ...request('41'), payload: wrong, payloadDigest: effectPayloadDigest(wrong) }), /i32_payload_required/);
  assert.throws(() => admitted.execute!(request('2147483648')), /i32_payload_required/);
  assert.throws(() => admitted.execute!(request('-2147483649')), /i32_payload_required/);
});

test('imports, unbounded/oversized memory and wrong function signature fail at admission', () => {
  for (const [bytes, reason] of [
    [moduleBytes([0x20, 0], { imports: true }), /worker_failed/],
    [moduleBytes([0x20, 0], { noMax: true }), /worker_failed/],
    [moduleBytes([0x20, 0], { memoryMax: 2 }), /worker_failed/],
    [moduleBytes([0x41, 0], { params: [] }), /worker_failed/],
  ] as const) assert.throws(() => adapter(bytes), reason);
});

test('memory.grow respects the declared maximum and malicious infinite loop is killed', () => {
  const grow = moduleBytes([0x41, 1, 0x40, 0]);
  assert.deepEqual(adapter(grow).execute!(request('2')), { tag: 'int', value: '-1' });
  const looping = adapter(infinite, 500);
  const start = Date.now();
  assert.throws(() => looping.execute!(request('2')), /isolated_wasm_timeout/);
  assert.ok(Date.now() - start < 4000, 'child must be killed within a bounded interval');
});

test('worker rejects forged or tampered IPC identity before running guest code', () => {
  const worker = fileURLToPath(new URL('../../src/tier2/isolated-wasm-worker.ts', import.meta.url));
  const base = { format: 'aether.isolated-wasm-request/1', mode: 'run', wasmBase64: Buffer.from(increment).toString('base64'),
    sha256: digest(increment), maxMemoryPages: 1, requestDigest: 'aether.effect/1:b3:' + '0'.repeat(64), input: 1 };
  for (const tampered of [{ ...base, sha256: '1'.repeat(64) }, { ...base, requestDigest: 'fake' }, { ...base, input: 2147483648 }, { ...base, extra: 'forged' }]) {
    const child = spawnSync(process.execPath, ['--experimental-strip-types', worker], { input: encodeCanonical(tampered), timeout: 2000 });
    assert.equal(child.status, 1);
    assert.equal(child.stdout.length, 0);
  }
});

test('durable broker records child crash as indeterminate, then reconciles pure computation and allows new effect ID', () => {
  const directory = mkdtempSync(join(tmpdir(), 'aether-isolated-wasm-'));
  try {
    const opts = { directory, clockDomain: 'isolated-clock/1', clock: () => 100n, authorize: () => true };
    const guest = adapter(trapZero), first = request('0');
    const broker = new DurableEffectBroker(opts);
    assert.equal(broker.dispatch(first, guest).state, 'indeterminate');
    assert.equal(new DurableEffectBroker(opts).dispatch(first, guest).state, 'indeterminate', 'same effect ID cannot blindly rerun');
    assert.deepEqual(new DurableEffectBroker(opts).reconcile(first, guest), { state: 'aborted', code: 'sink_confirmed_not_committed' });
    const result = new DurableEffectBroker(opts).dispatch(request('7', 'effect:retry'), guest);
    assert.equal(result.state, 'committed');
    if (result.state === 'committed') assert.deepEqual(encodeCanonical(result.value), encodeCanonical({ tag: 'int', value: '7' }));
    assert.equal(new DurableEffectBroker(opts).events().length, 2);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('Wasm preflight rejects invalid i32 before dispatch while valid requests still execute', () => {
  const directory = mkdtempSync(join(tmpdir(), 'aether-isolated-wasm-preflight-'));
  try {
    let reservations = 0;
    const opts = { directory, clockDomain: 'isolated-preflight/1', clock: () => 100n, authorize: () => true,
      budgets: { reserve: () => { reservations++; return true; }, consume: () => {}, release: () => {} } };
    const broker = new DurableEffectBroker(opts), guest = adapter();
    const invalid = { ...request('2147483648', 'too-large'), budgetReservationId: 'reservation:invalid' };
    assert.deepEqual(broker.dispatch(invalid, guest), { state: 'rejected', code: 'adapter_preflight_rejected' });
    assert.equal(reservations, 0, 'invalid input must not reserve economic budget');
    const event = broker.events()[0];
    assert.equal(event.dispatchStarted, false);
    assert.deepEqual(event.transitions.map(t => t.state), ['requested', 'rejected']);
    assert.deepEqual(encodeCanonical(new DurableEffectBroker(opts).dispatch(invalid, guest)),
      encodeCanonical({ state: 'rejected', code: 'adapter_preflight_rejected' }));
    const wrong = { tag: 'sequence' as const, items: [{ tag: 'string' as const, value: 'cap:test:wrong' }, { tag: 'int' as const, value: '1' }] };
    assert.deepEqual(broker.dispatch({ ...request('1', 'wrong-cap'), payload: wrong, payloadDigest: effectPayloadDigest(wrong) }, guest),
      { state: 'rejected', code: 'adapter_preflight_rejected' });
    const valid = broker.dispatch(request('41', 'valid-after-reject'), guest);
    assert.equal(valid.state, 'committed');
    if (valid.state === 'committed') assert.deepEqual(encodeCanonical(valid.value), encodeCanonical({ tag: 'int', value: '42' }));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('authorization denies before pure preflight; adapters without preflight keep their existing dispatch behavior', () => {
  const directory = mkdtempSync(join(tmpdir(), 'aether-isolated-wasm-denial-'));
  const legacyDirectory = mkdtempSync(join(tmpdir(), 'aether-isolated-wasm-legacy-'));
  try {
    let preflights = 0, executions = 0;
    const guarded: EffectAdapter = { id: 'guarded/1', semantics: { readOnly: true, atomicIdempotency: true, transactional: false, reconciliation: false },
      preflight() { preflights++; }, execute() { executions++; return { tag: 'int', value: '1' }; } };
    const denied = new DurableEffectBroker({ directory, clockDomain: 'denial/1', clock: () => 100n, authorize: () => false });
    assert.deepEqual(denied.dispatch(request('1'), guarded), { state: 'rejected', code: 'authorization_denied' });
    assert.equal(preflights, 0); assert.equal(executions, 0);
    assert.equal(denied.events()[0].dispatchStarted, false);
    const legacy: EffectAdapter = { id: 'legacy-no-preflight/1', semantics: guarded.semantics,
      execute() { executions++; return { tag: 'int', value: '2' }; } };
    const allowed = new DurableEffectBroker({ directory: legacyDirectory,
      clockDomain: 'legacy/1', clock: () => 100n, authorize: () => true });
    const result = allowed.dispatch(request('2147483648', 'legacy'), legacy);
    assert.equal(result.state, 'committed'); assert.equal(executions, 1);
    const asyncPreflight: EffectAdapter = { ...guarded, id: 'async-preflight/1',
      preflight: (() => Promise.resolve()) as () => void };
    assert.deepEqual(allowed.dispatch(request('1', 'async-preflight'), asyncPreflight),
      { state: 'rejected', code: 'adapter_preflight_rejected' });
    assert.equal(executions, 1, 'async preflight cannot pass a synchronous validation boundary');
  } finally { rmSync(directory, { recursive: true, force: true }); rmSync(legacyDirectory, { recursive: true, force: true }); }
});
