import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { adapterGcFixture } from './semantic-gc-adapters-fixture.ts';
import { SemanticAdapterGarbageCollector, declarativeAdapterTableDigest, type AdapterRetirementProposal } from '../../src/tier1/semantic-gc-adapters.ts';
import { admitAdapterSource } from '../../src/tier2/adapter-artifact.ts';
import { BrokerEffectRouter } from '../../src/tier3/effects.ts';
import { DurableEffectBroker } from '../../src/fabric/effects.ts';
import { domainDigest } from '../../src/fabric/identity.ts';
import { encodeCanonical } from '../../src/fabric/encoding.ts';
import type { NodeRef } from '../../src/tier1/ids.ts';
import * as b from '../../src/tier1/build.ts';
import { SymbolSpace } from '../../src/tier1/symbols.ts';
const same = (a: unknown, b: unknown) => assert.deepEqual(encodeCanonical(a), encodeCanonical(b));
const reseal = (value: AdapterRetirementProposal): AdapterRetirementProposal => { const { id, ...body } = value; void id; return { ...body, id: domainDigest('aether.semantic-adapter-retirement/1', body) }; };
test('unused declarative registration retires with independent dispatch proof, unchanged AST and retained source bytes', async () => {
  const f = adapterGcFixture(); try {
    const beforeHead = f.store.head('production'), proposal = f.manager.propose(); assert.ok(proposal); same(proposal.removed, ['b-unused']); f.manager.verify(proposal);
    const registration = f.manager.resolve(f.liveCap), source = f.store.hydrate(registration.sourceRoot); if (source.kind !== 'Lit' || typeof source.value !== 'string') throw new Error('source');
    const adapter = await admitAdapterSource(Buffer.from(source.value), registration.artifact, { legacyProfile: 'aether.adapter-js-legacy-v1/1' });
    const invoke = (manifest: typeof f.genesis.evidence.manifest, directory: string) => {
      const broker = new DurableEffectBroker({ directory, clockDomain: 'test/1', clock: () => 1n, authorize: () => true });
      const router = new BrokerEffectRouter({ broker, manifest, executionId: directory, policyEpoch: '1', deadline: '100', adapters: new Map([[f.liveCap, adapter]]), grant: () => 'trusted-test-grant' }); router.bind(manifest.astRoot as NodeRef); return router.invoke(f.liveCap, []);
    };
    assert.equal(invoke(f.genesis.evidence.manifest, join(f.directory, 'before-sink')), null);
    const candidate = f.artifact(declarativeAdapterTableDigest(proposal.after), [f.genesis.intent!]); f.manager.advance(proposal, candidate.evidence.manifest);
    assert.throws(() => f.manager.resolve(f.unusedCap), /retired/); same(f.manager.resolve(f.liveCap), registration); assert.equal(invoke(candidate.evidence.manifest, join(f.directory, 'after-sink')), null);
    same(f.store.head('production'), beforeHead); assert.equal(f.manager.snapshot().productionAuthorized, false);
    f.store.collectGarbage(); f.table.registrations.forEach(item => assert.ok(f.store.hydrate(item.sourceRoot))); same(f.manager.historicalTable(declarativeAdapterTableDigest(f.table)), f.table);
    const reopened = new SemanticAdapterGarbageCollector(f.configuration); assert.equal(reopened.snapshot().generation, 1); reopened.advance(proposal, candidate.evidence.manifest); assert.equal(reopened.snapshot().generation, 1);
  } finally { f.cleanup(); }
});
test('exported, protected and signed-fenced adapter consumers cannot be retired', () => {
  for (const option of [{ exportUnused: true }, { protectUnused: true }, { fenceUnused: true }]) { const f = adapterGcFixture(option); try { assert.equal(f.manager.propose(), null); } finally { f.cleanup(); } }
});
test('active tasks, replay and unstable replication keep every referenced adapter; audit retains history without activating dead code', () => {
  for (const kind of ['active-task', 'replay', 'unstable-replication', 'audit'] as const) {
    const f = adapterGcFixture(); try {
      f.retentionLedger.retain({ kind, reference: `${kind}-retained`, root: f.root });
      const proposal = f.manager.propose(); if (kind === 'audit') { assert.ok(proposal); same(proposal.removed, ['b-unused']); } else assert.equal(proposal, null);
      f.store.collectGarbage(); assert.ok(f.store.hydrate(f.root));
    } finally { f.cleanup(); }
  }
});
test('one retained executable reference combines its module and exact dependency declarations', () => {
  for (const [capability, expectedRemoved] of [['unused', null], ['live', 'b-unused']] as const) {
    const f = adapterGcFixture(); try {
      const symbols = new SymbolSpace(`retained-${capability}`), dep = symbols.define('dependency');
      const history = b.module_({ symbol: symbols.define('module'), members: [b.fn({ symbol: symbols.define('entry'), returns: b.Unit, body: b.ret(b.unit()) })], symbolTable: symbols.table() });
      const effect = capability === 'unused' ? f.unusedCap : f.liveCap;
      const declaration = b.fn({ symbol: dep, returns: b.Unit, capabilities: [effect], body: b.block(b.exprStmt(b.invoke(effect)), b.ret(b.unit())) });
      const root = f.store.intern(history, { leaseId: 'retained-module' }), dependency = f.store.intern(declaration, { leaseId: 'retained-dependency' });
      f.retentionLedger.retain({ kind: 'active-task', reference: 'checkpoint-one', root });
      f.retentionLedger.retain({ kind: 'replay', reference: 'checkpoint-one', root: dependency });
      const proposal = f.manager.propose();
      if (expectedRemoved === null) assert.equal(proposal, null);
      else { assert.ok(proposal); assert.deepEqual(proposal.removed, [expectedRemoved]); assert.ok(proposal.usedCapabilities.includes(f.liveCap)); f.manager.verify(proposal); }
    } finally { f.cleanup(); }
  }
});
test('retained executable dependencies without a module or with conflicting definitions fail closed', () => {
  for (const conflict of [false, true]) {
    const f = adapterGcFixture(); try {
      const symbols = new SymbolSpace(`retained-conflict-${conflict}`), dep = symbols.define('dependency');
      const original = b.fn({ symbol: dep, returns: b.Unit, body: b.ret(b.unit()) });
      const changed = b.fn({ symbol: dep, returns: b.Unit, capabilities: [f.unusedCap], body: b.block(b.exprStmt(b.invoke(f.unusedCap)), b.ret(b.unit())) });
      const dependency = f.store.intern(changed, { leaseId: 'retained-dependency' });
      if (conflict) {
        const module = b.module_({ symbol: symbols.define('module'), members: [original], symbolTable: symbols.table() });
        f.retentionLedger.retain({ kind: 'replay', reference: 'checkpoint-conflict', root: f.store.intern(module, { leaseId: 'retained-module' }) });
      }
      f.retentionLedger.retain({ kind: 'replay', reference: 'checkpoint-conflict', root: dependency });
      assert.throws(() => f.manager.propose(), conflict ? /conflicting retained dependency/ : /one complete module/);
    } finally { f.cleanup(); }
  }
});
test('retained module with a missing dependency callee refuses retirement', () => {
  const f = adapterGcFixture(); try {
    const symbols = new SymbolSpace('retained-missing-callee'), missing = symbols.define('missing');
    const module = b.module_({ symbol: symbols.define('module'), members: [
      b.fn({ symbol: symbols.define('entry'), returns: b.Unit, body: b.block(b.exprStmt(b.call(missing)), b.ret(b.unit())) }),
    ], symbolTable: symbols.table() });
    f.retentionLedger.retain({ kind: 'active-task', reference: 'missing-callee', root: f.store.intern(module, { leaseId: 'missing-callee' }) });
    assert.throws(() => f.manager.propose(), /ill-typed retained executable closure|missing retained dependency callee/);
  } finally { f.cleanup(); }
});
test('new retention before publication and unsigned candidate policy refuse advancement', () => {
  let retain = () => {}; const f = adapterGcFixture({ beforePublish: () => retain() }); try {
    const proposal = f.manager.propose(); assert.ok(proposal);
    const unsigned = f.artifact(declarativeAdapterTableDigest(proposal.after), [f.genesis.intent!], false);
    assert.throws(() => f.manager.advance(proposal, unsigned.evidence.manifest), /current|admi|lineage/i);
    const candidate = f.artifact(declarativeAdapterTableDigest(proposal.after), [f.genesis.intent!]);
    retain = () => f.retentionLedger.retain({ kind: 'active-task', reference: 'arrived-during-preparation', root: f.root });
    assert.throws(() => f.manager.advance(proposal, candidate.evidence.manifest), /retention changed/); assert.equal(f.manager.snapshot().generation, 0);
  } finally { f.cleanup(); }
});
test('retention publication fence serializes a task pin from another process', async () => {
  const f = adapterGcFixture();
  const ready = join(f.directory, 'retention-child-ready');
  const trigger = join(f.directory, 'retention-child-trigger');
  const childFile = join(f.directory, 'retention-child.ts');
  const definitions = f.configuration.registry.names.map(name => [name, f.configuration.registry.get(name)]);
  writeFileSync(childFile, `
import { existsSync, writeFileSync } from 'node:fs';
import { setTimeout } from 'node:timers/promises';
import { DurableGraphStore } from ${JSON.stringify(pathToFileURL(resolve('src/tier1/durable-store.ts')).href)};
import { SemanticGarbageCollector } from ${JSON.stringify(pathToFileURL(resolve('src/tier1/semantic-gc.ts')).href)};
import { CapabilityRegistry } from ${JSON.stringify(pathToFileURL(resolve('src/tier2/ocap.ts')).href)};
const registry = new CapabilityRegistry();
for (const [name, definition] of ${JSON.stringify(definitions)}) registry.define(definition);
const store = new DurableGraphStore({ directory: ${JSON.stringify(join(f.directory, 'ast'))} });
const collector = new SemanticGarbageCollector({ directory: ${JSON.stringify(join(f.directory, 'gc-retention'))},
  repositoryId: 'adapter-gc', store, lineage: null, registry, policy: ${JSON.stringify(f.configuration.policy)} });
writeFileSync(${JSON.stringify(ready)}, 'ready');
while (!existsSync(${JSON.stringify(trigger)})) await setTimeout(5);
collector.retain({ kind: 'active-task', reference: 'concurrent-task', root: ${JSON.stringify(f.root)} });
`);
  const child = spawn(process.execPath, ['--experimental-strip-types', childFile], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = ''; child.stderr?.on('data', chunk => { stderr += String(chunk); });
  try {
    const deadline = Date.now() + 10_000;
    while (!existsSync(ready)) {
      if (Date.now() > deadline || child.exitCode !== null) throw new Error(`retention child did not initialize: ${stderr}`);
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    const lockDir = join(f.directory, 'gc-retention', 'lock');
    const ticketCount = () => readdirSync(lockDir).filter(name => name.startsWith('ticket-')).length;
    const initial = ticketCount();
    f.retentionLedger.withStableRetentions([], () => {
      writeFileSync(trigger, 'go');
      const waited = Date.now() + 5_000;
      while (ticketCount() < initial + 2) {
        if (Date.now() > waited) throw new Error(`concurrent retain did not request the fence: ${stderr}`);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      }
      assert.equal(f.retentionLedger.retentions().length, 0,
        'new task pin cannot publish after the final snapshot check but before table publication');
    });
    const exitCode = await new Promise<number | null>(resolve => child.once('exit', resolve));
    assert.equal(exitCode, 0, stderr);
    assert.deepEqual(f.retentionLedger.retentions().map(record => record.reference), ['concurrent-task']);
  } finally { child.kill('SIGKILL'); f.cleanup(); }
});
test('altered mapping, incomplete certificate and rehashed dishonest liveness fail independent validation', () => {
  const f = adapterGcFixture(); try {
    const proposal = f.manager.propose(); assert.ok(proposal);
    const changed = { ...proposal, after: { ...proposal.after, registrations: [] } }; assert.throws(() => f.manager.verify(reseal(changed)), /live mapping/);
    const proof = { ...proposal, witness: { ...proposal.witness, certificate: { ...proposal.witness.certificate, certificates: [] } } }; assert.throws(() => f.manager.verify(reseal(proof)), /certificate|coverage|obligation/i);
    const lie = { ...proposal, usedCapabilities: [] }; assert.throws(() => f.manager.verify(reseal(lie)), /liveness/);
  } finally { f.cleanup(); }
});
test('unresolved/dynamic retained execution and eager lifecycle registration fail closed', () => {
  const f = adapterGcFixture(); try {
    if (f.module.kind !== 'Module') throw new Error('module');
    const opaque = { ...f.module, members: [...f.module.members, b.import_(f.root)] }, root = f.store.intern(opaque, { leaseId: 'unresolved-retention' });
    f.retentionLedger.retain({ kind: 'replay', reference: 'unresolved-import', root }); assert.throws(() => f.manager.propose(), /unresolved import|dynamic/);
    const table = structuredClone(f.table); (table.registrations[0] as unknown as { lifecycle: string }).lifecycle = 'eager-with-unload'; assert.throws(() => declarativeAdapterTableDigest(table), /lifecycle/);
  } finally { f.cleanup(); }
});
test('consumer validates with proof search physically replaced by a throwing stub', async () => {
  const f = adapterGcFixture(), consumer = mkdtempSync(join(tmpdir(), 'aether-adapter-gc-consumer-')); try {
    const proposal = f.manager.propose(); assert.ok(proposal);
    cpSync(resolve('src'), join(consumer, 'src'), { recursive: true }); writeFileSync(join(consumer, 'package.json'), '{"type":"module"}');
    mkdirSync(join(consumer, 'node_modules'));
    for (const dependency of ['acorn', 'acorn-walk']) cpSync(resolve('node_modules', dependency), join(consumer, 'node_modules', dependency), { recursive: true });
    writeFileSync(join(consumer, 'src/tier2/portable-proof-producer.ts'), "export function generatePortableCertificate(){throw new Error('proof search forbidden in consumer');}\n");
    const loaded = await import(pathToFileURL(join(consumer, 'src/tier1/semantic-gc-adapters.ts')).href); const independent = new loaded.SemanticAdapterGarbageCollector(f.configuration); independent.verify(proposal);
  } finally { f.cleanup(); rmSync(consumer, { recursive: true, force: true }); }
});
test('signed registry corruption and established state deletion cannot reset retired mappings', () => {
  const f = adapterGcFixture(); try {
    const proposal = f.manager.propose(); assert.ok(proposal); const candidate = f.artifact(declarativeAdapterTableDigest(proposal.after), [f.genesis.intent!]); f.manager.advance(proposal, candidate.evidence.manifest);
    const path = join(f.configuration.directory, 'registry.json'), original = readFileSync(path), value = JSON.parse(original.toString());
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const finalSextet = alphabet.indexOf(value.signature[85]);
    value.signature = value.signature.slice(0, 85) + alphabet[finalSextet ^ 1] + '==';
    assert.deepEqual(Buffer.from(value.signature, 'base64'), Buffer.from(JSON.parse(original.toString()).signature, 'base64'));
    writeFileSync(path, JSON.stringify(value)); assert.throws(() => f.manager.snapshot(), /forged/);
    value.signature = JSON.parse(original.toString()).signature;
    value.body.head.generation = 0; writeFileSync(path, JSON.stringify(value)); assert.throws(() => f.manager.snapshot(), /forged/);
    writeFileSync(path, original); unlinkSync(path); assert.throws(() => new SemanticAdapterGarbageCollector(f.configuration), /missing established/);
  } finally { f.cleanup(); }
});
