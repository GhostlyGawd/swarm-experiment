import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { capability } from '../../src/tier1/ids.ts';
import { adapterArtifactDigest, adapterArtifactForSource, admitAdapterSource, admitWasmAdapterBytes, admittedAdapterArtifactDigest, importFreeAdapterArtifactForSource, legacyAdapterArtifactForSource, wasmAdapterArtifactForBytes } from '../../src/tier2/adapter-artifact.ts';
import { DurableEffectBroker, effectAdapterDigest, effectPayloadDigest } from '../../src/fabric/effects.ts';
import { domainDigest } from '../../src/fabric/identity.ts';

const cap = capability('cap:test:emit');
const semantics = { readOnly: false, atomicIdempotency: true, transactional: false, reconciliation: true } as const;
const sourceText = `globalThis.__aetherAdapterLoads=(globalThis.__aetherAdapterLoads??0)+1;
export default {id:'source-ledger/1',semantics:{readOnly:false,atomicIdempotency:true,transactional:false,reconciliation:true},
execute(request){globalThis.__aetherAdapterCalls=(globalThis.__aetherAdapterCalls??0)+1;return{tag:'null'};},
reconcile(){return{state:'not_committed'};}};`;
const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);
const globals = globalThis as Record<string, unknown>;
function wasmIncrementBytes(): Uint8Array {
  const length = (n: number) => [n], section = (id: number, body: number[]) => [id, ...length(body.length), ...body];
  const name = (value: string) => [...length(value.length), ...Buffer.from(value)];
  const type = section(1, [1, 0x60, 1, 0x7f, 1, 0x7f]);
  const functions = section(3, [1, 0]);
  const memory = section(5, [1, 1, 1, 1]);
  const exports = section(7, [2, ...name('run'), 0, 0, ...name('memory'), 2, 0]);
  const body = [0, 0x20, 0, 0x41, 1, 0x6a, 0x0b];
  return Uint8Array.from([0, 97, 115, 109, 1, 0, 0, 0, ...type, ...functions, ...memory, ...exports,
    ...section(10, [1, body.length, ...body])]);
}

test('V3 Wasm descriptor binds bytes, fixed read-only semantics and finite resource limits', async () => {
  const wasm = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
  const artifact = wasmAdapterArtifactForBytes(wasm, cap, 'wasm-increment/1', { maxMemoryPages: 1, timeoutMs: 250 });
  assert.equal(artifact.format, 'aether.effect-adapter-artifact/3');
  assert.equal(artifact.sourceSha256, createHash('sha256').update(wasm).digest('hex'));
  assert.deepEqual(artifact.semantics, { readOnly: true, atomicIdempotency: true, transactional: false, reconciliation: true });
  assert.notEqual(adapterArtifactDigest(artifact), adapterArtifactDigest({ ...artifact, timeoutMs: 251 }));
  assert.throws(() => adapterArtifactDigest({ ...artifact, semantics: { ...artifact.semantics, readOnly: false } }), /bounded Wasm adapter descriptor/);
  assert.throws(() => adapterArtifactDigest({ ...artifact, sourceProfile: 'aether.adapter-js-import-free/1' as typeof artifact.sourceProfile }), /Wasm adapter source profile/);
  assert.throws(() => wasmAdapterArtifactForBytes(wasm, cap, 'wasm-increment/1', { maxMemoryPages: 257, timeoutMs: 250 }), /bounded Wasm adapter descriptor/);
  assert.throws(() => wasmAdapterArtifactForBytes(wasm, cap, 'wasm-increment/1', { maxMemoryPages: 1, timeoutMs: 5001 }), /bounded Wasm adapter descriptor/);
  await assert.rejects(admitAdapterSource(wasm, artifact), /requires isolated Wasm admission/);
});

test('V3 approved Wasm bytes run through a branded isolated adapter and actual durable broker', () => {
  const wasm = wasmIncrementBytes(), artifact = wasmAdapterArtifactForBytes(wasm, cap, 'wasm-increment/1', { maxMemoryPages: 1, timeoutMs: 1000 });
  const admitted = admitWasmAdapterBytes(wasm, artifact);
  assert.equal(admittedAdapterArtifactDigest(admitted), adapterArtifactDigest(artifact));
  assert.equal(admittedAdapterArtifactDigest({ ...admitted }), null);
  wasm[wasm.length - 2] ^= 1;
  const directory = mkdtempSync(join(tmpdir(), 'aether-admitted-wasm-'));
  try {
    const broker = new DurableEffectBroker({ directory, clockDomain: 'adapter-wasm/1', clock: () => 100n, authorize: () => true });
    const payload = { tag: 'sequence' as const, items: [{ tag: 'string' as const, value: cap }, { tag: 'int' as const, value: '41' }] };
    const request = { format: 'aether.effect/1' as const, executionId: 'wasm-adapter-test', effectId: 'one', branchId: null,
      executionManifest: domainDigest('aether.execution/1', 'wasm-adapter-test'), capabilityGrantRef: 'grant:wasm-test', policyEpoch: '1',
      payloadDigest: effectPayloadDigest(payload), payload, budgetReservationId: null, deadline: '1000' };
    const first = broker.dispatch(request, admitted);
    assert.equal(first.state, 'committed'); if (first.state === 'committed') assert.deepEqual(JSON.parse(JSON.stringify(first.value)), { tag: 'int', value: '42' });
    assert.deepEqual(JSON.parse(JSON.stringify(broker.dispatch(request, admitted))), JSON.parse(JSON.stringify(first)));
    assert.equal(broker.events().length, 1);
  } finally { rmSync(directory, { recursive: true, force: true }); }
  assert.throws(() => admitWasmAdapterBytes(wasm, artifact), /does not match approved artifact/);
});

test('approved exact adapter bytes mint one immutable code-provenance identity', async () => {
  delete globals.__aetherAdapterLoads; delete globals.__aetherAdapterCalls;
  const source = bytes(sourceText), artifact = adapterArtifactForSource(source, cap, 'source-ledger/1', semantics);
  assert.equal(artifact.format, 'aether.effect-adapter-artifact/2');
  assert.equal(artifact.sourceSha256, createHash('sha256').update(source).digest('hex'));
  const admitted = await admitAdapterSource(source, artifact);
  assert.equal(globals.__aetherAdapterLoads, 1);
  assert.equal(admittedAdapterArtifactDigest(admitted), adapterArtifactDigest(artifact));
  assert.equal(effectAdapterDigest(admitted), effectAdapterDigest({ ...admitted }));
  assert.equal(admittedAdapterArtifactDigest({ ...admitted }), null, 'structural copies cannot carry loader provenance');
  const directory = mkdtempSync(join(tmpdir(), 'aether-admitted-adapter-'));
  try {
    const broker = new DurableEffectBroker({ directory, clockDomain: 'adapter-test/1', clock: () => 100n, authorize: () => true });
    const payload = { tag: 'sequence' as const, items: [{ tag: 'string' as const, value: cap }] };
    const request = { format: 'aether.effect/1' as const, executionId: 'adapter-test', effectId: 'one', branchId: null,
      executionManifest: domainDigest('aether.execution/1', 'adapter-test'), capabilityGrantRef: 'grant:test', policyEpoch: '1',
      payloadDigest: effectPayloadDigest(payload), payload, budgetReservationId: null, deadline: '1000' };
    assert.equal(broker.dispatch(request, admitted).state, 'committed');
    assert.equal(broker.dispatch(request, admitted).state, 'committed');
    assert.equal(globals.__aetherAdapterCalls, 1, 'same-ID retry uses the durable receipt');
  } finally { rmSync(directory, { recursive: true, force: true }); }
  assert.equal(Object.isFrozen(admitted), true); assert.equal(Object.isFrozen(admitted.semantics), true);
  assert.notEqual(adapterArtifactDigest(adapterArtifactForSource(bytes(sourceText + '\n// changed'), cap, 'source-ledger/1', semantics)), adapterArtifactDigest(artifact));
  delete globals.__aetherAdapterLoads; delete globals.__aetherAdapterCalls;
});

test('changed or malformed source fails before execution; descriptor mismatch cannot mint provenance', async () => {
  delete globals.__aetherAdapterLoads;
  const source = bytes(sourceText), artifact = adapterArtifactForSource(source, cap, 'source-ledger/1', semantics);
  await assert.rejects(admitAdapterSource(bytes(sourceText + '\n// changed'), artifact), /does not match approved artifact/);
  assert.equal(globals.__aetherAdapterLoads, undefined);
  await assert.rejects(admitAdapterSource(source, { ...artifact, id: 'different-ledger/1' }), /differs from approved descriptor/);
  const malformed = new Uint8Array([0xff]);
  await assert.rejects(admitAdapterSource(malformed, { ...artifact, sourceSha256: createHash('sha256').update(malformed).digest('hex') }), /encoded data|UTF-8/i);
  assert.throws(() => adapterArtifactForSource(new Uint8Array(), cap, 'source-ledger/1', semantics), /byte bound/);
  assert.throws(() => adapterArtifactDigest({ ...artifact, sourceSha256: '0'.repeat(63) }), /source hash/);
  delete globals.__aetherAdapterLoads;
});

test('caller mutation during asynchronous module import cannot relabel admitted source bytes', async () => {
  const source = bytes(sourceText), original = adapterArtifactForSource(source, cap, 'source-ledger/1', semantics);
  const mutable = { ...original, semantics: { ...original.semantics } };
  const pending = admitAdapterSource(source, mutable);
  (mutable as { sourceSha256: string }).sourceSha256 = '0'.repeat(64);
  (mutable.semantics as { readOnly: boolean }).readOnly = true;
  const adapter = await pending;
  assert.equal(admittedAdapterArtifactDigest(adapter), adapterArtifactDigest(original));
  assert.equal(adapter.id, original.id); assert.deepEqual(adapter.semantics, original.semantics);
});

test('V2 signs an import-free profile and admits local exports with import text in comments and strings', async () => {
  const source = bytes(`// import 'node:fs'\nconst text = "import('node:fs')";
const match = /import\\(/; const local = text + String(match);
export { local };
export default { id:'source-ledger/1', semantics:{readOnly:false,atomicIdempotency:true,transactional:false,reconciliation:true},
  execute(){ return {tag:'null'}; }, reconcile(){return {state:'not_committed'};} };`);
  const v1 = legacyAdapterArtifactForSource(source, cap, 'source-ledger/1', semantics);
  const v2 = importFreeAdapterArtifactForSource(source, cap, 'source-ledger/1', semantics);
  assert.equal(v2.sourceProfile, 'aether.adapter-js-import-free/1');
  assert.notEqual(adapterArtifactDigest(v2), adapterArtifactDigest(v1), 'the parser rule changes artifact identity');
  const adapter = await admitAdapterSource(source, v2);
  assert.equal(admittedAdapterArtifactDigest(adapter), adapterArtifactDigest(v2));
  await assert.rejects(admitAdapterSource(source, { ...v2, sourceProfile: 'unknown' as typeof v2.sourceProfile }), /source profile/);
  await assert.rejects(admitAdapterSource(source, v2, { legacyProfile: 'aether.adapter-js-legacy-v1/1' }), /cannot authorize V2/);
});

test('dependency syntax is refused before either the adapter or imported module can run', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'aether-adapter-import-'));
  const dependency = join(directory, 'dependency.mjs');
  writeFileSync(dependency, `globalThis.__aetherDependencyRuns = (globalThis.__aetherDependencyRuns ?? 0) + 1; export default 1;`);
  const url = pathToFileURL(dependency).href;
  const cases = [
    `import '${url}';`,
    `import value from '${url}';`,
    `export { default as imported } from '${url}';`,
    `export * from '${url}';`,
    `await import('${url}');`,
    `const later = () => import(/* hidden */ '${url}');`,
    `const location = import.meta.resolve('${url}');`,
  ];
  try {
    for (const dependencySyntax of cases) {
      delete globals.__aetherDependencyRuns; delete globals.__aetherAdapterLoads;
      const source = bytes(`${dependencySyntax}\n${sourceText}`);
      const legacy = legacyAdapterArtifactForSource(source, cap, 'source-ledger/1', semantics);
      const profiled = { ...legacy, format: 'aether.effect-adapter-artifact/2' as const,
        sourceProfile: 'aether.adapter-js-import-free/1' as const };
      assert.throws(() => importFreeAdapterArtifactForSource(source, cap, 'source-ledger/1', semantics), /import-free source profile/);
      await assert.rejects(admitAdapterSource(source, legacy), /explicit legacy admission profile/);
      await assert.rejects(admitAdapterSource(source, profiled), /import-free source profile/);
      assert.equal(globals.__aetherAdapterLoads, undefined, `adapter ran for ${dependencySyntax}`);
      assert.equal(globals.__aetherDependencyRuns, undefined, `dependency ran for ${dependencySyntax}`);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
    delete globals.__aetherDependencyRuns; delete globals.__aetherAdapterLoads;
  }
});

test('old V1 identity keeps import-capable behavior only through the explicit legacy admission profile', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'aether-adapter-legacy-'));
  const dependency = join(directory, 'legacy.mjs');
  writeFileSync(dependency, `globalThis.__aetherDependencyRuns = (globalThis.__aetherDependencyRuns ?? 0) + 1;`);
  delete globals.__aetherDependencyRuns; delete globals.__aetherAdapterLoads;
  try {
    const source = bytes(`import '${pathToFileURL(dependency).href}';\n${sourceText}`);
    const legacy = legacyAdapterArtifactForSource(source, cap, 'source-ledger/1', semantics);
    await assert.rejects(admitAdapterSource(source, legacy), /explicit legacy admission profile/);
    assert.equal(globals.__aetherDependencyRuns, undefined);
    assert.equal(globals.__aetherAdapterLoads, undefined);
    const adapter = await admitAdapterSource(source, legacy, { legacyProfile: 'aether.adapter-js-legacy-v1/1' });
    assert.equal(admittedAdapterArtifactDigest(adapter), adapterArtifactDigest(legacy));
    assert.equal(globals.__aetherDependencyRuns, 1);
    assert.equal(globals.__aetherAdapterLoads, 1);
    const invalid = new Uint8Array([0xff]);
    const invalidLegacy = legacyAdapterArtifactForSource(invalid, cap, 'source-ledger/1', semantics);
    await assert.rejects(admitAdapterSource(invalid, invalidLegacy, { legacyProfile: 'aether.adapter-js-legacy-v1/1' }), /encoded data|UTF-8/i);
  } finally {
    rmSync(directory, { recursive: true, force: true });
    delete globals.__aetherDependencyRuns; delete globals.__aetherAdapterLoads;
  }
});

test('unsupported adapter module syntax fails before top-level execution', async () => {
  delete globals.__aetherAdapterLoads;
  const source = bytes(`globalThis.__aetherAdapterLoads = 1; ${sourceText} satisfies Object;`);
  const legacy = legacyAdapterArtifactForSource(source, cap, 'source-ledger/1', semantics);
  const profiled = { ...legacy, format: 'aether.effect-adapter-artifact/2' as const,
    sourceProfile: 'aether.adapter-js-import-free/1' as const };
  await assert.rejects(admitAdapterSource(source, profiled), SyntaxError);
  assert.equal(globals.__aetherAdapterLoads, undefined);
  delete globals.__aetherAdapterLoads;
});
