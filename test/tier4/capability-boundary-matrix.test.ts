import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ACCOUNT, CENTS } from '../../src/examples/ledger.ts';
import { SymbolSpace } from '../../src/tier1/symbols.ts';
import { domainDigest } from '../../src/fabric/identity.ts';
import { createEvidenceManifest } from '../../src/fabric/evidence.ts';
import { CapabilityRegistry, CapabilitySealer } from '../../src/tier2/ocap.ts';
import { ScopedGrantAuthority, type ScopedGrantV2 } from '../../src/tier2/scoped-grants.ts';
import { DurableGrantEpochs } from '../../src/tier2/grant-epochs.ts';
import { TopologyHost, TOPOLOGY_INVOKE } from '../../src/tier4/host.ts';
import { ProcessHost, PROCESS_INVOKE } from '../../src/tier4/process-host.ts';
import type { TopologyPlan } from '../../src/tier4/topology.ts';
import type { RuntimeSnapshotV1 } from '../../src/fabric/snapshot.ts';
import * as b from '../../src/tier1/build.ts';

function fixture(directory: string) {
  const symbols = new SymbolSpace('containment-matrix'), setter = symbols.define('setter'), other = symbols.define('other'), account = symbols.define('account');
  const registry = new CapabilityRegistry();
  const module = b.module_({ symbol: symbols.define('module'), members: [
    b.fn({ symbol: setter, params: [b.param(account, ACCOUNT)], returns: b.Unit,
      body: b.block(b.assign(b.place(account, 'balance'), b.typed(CENTS, 99n)), b.ret(b.unit())) }),
    b.fn({ symbol: other, returns: b.Int, body: b.ret(b.int(0)) }),
  ], symbolTable: symbols.table() });
  const plan: TopologyPlan = { shape: 'containers', units: [{ id: 'worker', members: [setter, other], capabilities: [], placement: 'container', memoryMb: 16 }],
    crossEdges: [], transportLatencyMsPerSecond: 0, monthlyCost: 0, recombinations: [], blockedMerges: [] };
  const epochs = new DurableGrantEpochs({ directory: join(directory, 'epochs'), repositoryId: 'matrix-repository' });
  let now = 100;
  const grants = new ScopedGrantAuthority({ key: new Uint8Array(32).fill(71), repositoryId: 'matrix-repository',
    clock: () => now, policyEpoch: () => epochs.policyEpoch, revocationEpoch: () => epochs.epoch,
    isRevoked: (cap, path) => epochs.isRevoked(cap, path), authorizeIssue: () => true, authorizeDelegate: () => true });
  const digest = (value: string) => domainDigest('aether.containment-matrix/1', value);
  const manifest = createEvidenceManifest({ module, registry, specification: 'Pure state update requires current exact invocation authority.',
    semanticsVersion: 'reference/1', compilerDigest: digest('compiler'), capabilityPolicyDigest: digest('policy'),
    target: { abiVersion: 'process/1', profileDigest: digest('profile'), artifactDigest: digest('artifact') } });
  return { symbols, setter, other, module, registry, plan, epochs, grants, manifest, setTime(value: number) { now = value; } };
}

function attacks(token: ScopedGrantV2, other: ScopedGrantV2, grants: ScopedGrantAuthority, invoke: ScopedGrantV2['body']['capability']) {
  const forged = { ...token, signature: '0'.repeat(64) };
  const narrowed = grants.attenuate(token, { capability: invoke, audience: token.body.audience, path: [...token.body.path, 'child'] }, 60_000);
  const wrongPath = grants.issue({ capability: invoke, audience: token.body.audience, path: ['wrong'] }, 60_000);
  return [
    ['empty', []], ['forged-signature', [forged]], ['wrong-audience', [other]],
    ['wrong-path', [wrongPath]], ['edited-path', [{ ...token, body: { ...token.body, path: ['wrong'] } }]],
    ['wrong-policy-epoch', [{ ...token, body: { ...token.body, policyEpoch: '99' } }]],
    ['wrong-identity', [{ ...token, id: domainDigest('aether.capability-grant/2', 'forged') }]],
    ['narrowed-child', [narrowed]], ['forged-extra', [token, forged]], ['duplicate', [token, token]],
  ] as const;
}
function balance(snapshot: RuntimeSnapshotV1, objectId: string): string | null {
  const value = snapshot.records.find(item => item.objectId === objectId)?.fields.find(([key]) => key === 'balance')?.[1];
  return value?.tag === 'int' ? value.value : null;
}

test('strict topology direct pure setter denies every malformed, excess and narrowed grant without heap publication', () => {
  const directory = mkdtempSync(join(tmpdir(), 'aether-topology-containment-'));
  try {
    const f = fixture(directory), host = new TopologyHost(f.module, f.plan, { registry: f.registry, symbols: f.symbols, scopedGrants: f.grants });
    const record = host.allocateRecord(ACCOUNT, { id: 'alice', balance: 0n });
    const valid = host.issueTokens(f.setter)[0] as ScopedGrantV2, other = host.issueTokens(f.other)[0] as ScopedGrantV2;
    for (const [name, capabilities] of attacks(valid, other, f.grants, TOPOLOGY_INVOKE)) {
      const result = host.dispatch({ id: `topology-${name}`, from: null, to: f.setter, args: [record], capabilities });
      assert.equal(result.ok, false, name); if (!result.ok) assert.equal(result.fault.kind, 'authority', name);
      assert.equal(host.readRecord(record).get('balance'), 0n, name);
    }
    const validResult = host.dispatch({ id: 'topology-valid', from: null, to: f.setter, args: [record], capabilities: [valid] });
    assert.equal(validResult.ok, true); assert.equal(host.readRecord(record).get('balance'), 99n);
    const fresh = host.allocateRecord(ACCOUNT, { id: 'bob', balance: 0n });
    f.epochs.revoke(TOPOLOGY_INVOKE, []);
    assert.equal(host.dispatch({ id: 'topology-revoked', from: null, to: f.setter, args: [fresh], capabilities: [valid] }).ok, false);
    f.epochs.restore(TOPOLOGY_INVOKE, []);
    assert.equal(host.dispatch({ id: 'topology-stale', from: null, to: f.setter, args: [fresh], capabilities: [valid] }).ok, false);
    const expiring = host.issueTokens(f.setter, 10); f.setTime(111);
    assert.equal(host.dispatch({ id: 'topology-expired', from: null, to: f.setter, args: [fresh], capabilities: expiring }).ok, false);
    assert.equal(host.readRecord(fresh).get('balance'), 0n);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('strict real worker pure setter denies the same grant matrix before recording or publishing state', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'aether-process-containment-')); let host: ProcessHost | undefined;
  try {
    const f = fixture(directory);
    host = await ProcessHost.open({ directory: join(directory, 'host'), module: f.module, plan: f.plan, registry: f.registry,
      manifest: f.manifest, sealer: new CapabilitySealer(new Uint8Array(32).fill(72), () => 100), scopedGrants: f.grants });
    const record = await host.allocateRecord(ACCOUNT, { id: { tag: 'string', value: 'alice' }, balance: { tag: 'int', value: '0' } }, { operationId: 'alice' });
    const args = [{ tag: 'ref' as const, value: record }], valid = host.issueScopedTokens(f.setter)[0], other = host.issueScopedTokens(f.other)[0];
    for (const [name, tokens] of attacks(valid, other, f.grants, PROCESS_INVOKE)) {
      await assert.rejects(host.call(f.setter, args, { operationId: `process-${name}`, tokens }), /authority_denied|grant identity mismatch/, name);
      assert.equal(host.status().unresolved.length, 0, name);
      assert.equal(balance(await host.snapshot(), record.objectId), '0', name);
    }
    assert.equal((await host.call(f.setter, args, { operationId: 'process-valid', tokens: [valid] })).state, 'completed');
    const fresh = await host.allocateRecord(ACCOUNT, { id: { tag: 'string', value: 'bob' }, balance: { tag: 'int', value: '0' } }, { operationId: 'bob' });
    const freshArgs = [{ tag: 'ref' as const, value: fresh }];
    f.epochs.revoke(PROCESS_INVOKE, []);
    await assert.rejects(host.call(f.setter, freshArgs, { operationId: 'process-revoked', tokens: [valid] }), /authority_denied/);
    f.epochs.restore(PROCESS_INVOKE, []);
    await assert.rejects(host.call(f.setter, freshArgs, { operationId: 'process-stale', tokens: [valid] }), /authority_denied/);
    const expiring = host.issueScopedTokens(f.setter, 10); f.setTime(111);
    await assert.rejects(host.call(f.setter, freshArgs, { operationId: 'process-expired', tokens: expiring }), /authority_denied/);
    assert.equal(balance(await host.snapshot(), fresh.objectId), '0');
  } finally { await host?.close(); rmSync(directory, { recursive: true, force: true }); }
});
