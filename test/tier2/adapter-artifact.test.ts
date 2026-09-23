import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { capability } from '../../src/tier1/ids.ts';
import { adapterArtifactDigest, adapterArtifactForSource, admitAdapterSource, admittedAdapterArtifactDigest } from '../../src/tier2/adapter-artifact.ts';
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

test('approved exact adapter bytes mint one immutable code-provenance identity', async () => {
  delete globals.__aetherAdapterLoads; delete globals.__aetherAdapterCalls;
  const source = bytes(sourceText), artifact = adapterArtifactForSource(source, cap, 'source-ledger/1', semantics);
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
