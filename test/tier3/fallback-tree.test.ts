import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { fallbackFixture } from './fallback-tree-fixture.ts';
import { FallbackTreeRuntime } from '../../src/tier3/fallback-tree.ts';
import { encodeCanonical, type TaggedValueV1 } from '../../src/fabric/encoding.ts';
import * as b from '../../src/tier1/build.ts';
import { createEvidenceManifest } from '../../src/fabric/evidence.ts';
import { CapabilityRegistry } from '../../src/tier2/ocap.ts';
const temp = () => mkdtempSync(join(tmpdir(), 'aether-fallback-'));
const same = (a: unknown, b: unknown) => assert.deepEqual(encodeCanonical(a), encodeCanonical(b));
function initialize(f: ReturnType<typeof fallbackFixture>) {
  const reference = f.runtime.allocateRecord(f.record, { value: { tag: 'int', value: '10' } }, 'initial');
  return [{ tag: 'ref', value: reference }, { tag: 'ref', value: reference }] as const;
}
test('Tier 1 faults restore shared aliases and allocator before real Tier 2 execution', () => {
  const directory = temp(); try {
    const f = fallbackFixture(directory), args = initialize(f), result = f.runtime.call(args, { operationId: 'invoke', tokens: f.runtime.issueTokens() });
    assert.equal(result.state, 'completed'); if (result.state === 'completed') { assert.equal(result.tier, 2); same(result.value, { tag: 'int', value: '11' }); }
    const state = f.runtime.snapshot(); assert.equal(state.records.length, 2); same(state.records.map(row => row.fields), [[['value', { tag: 'int', value: '11' }]], [['value', { tag: 'int', value: '888' }]]]);
    assert.equal(f.runtime.pendingRepairs().length, 1); assert.equal(f.runtime.pendingRepairs()[0].tier, 1);
    const reopened = fallbackFixture(directory); same(reopened.runtime.call(args, { operationId: 'invoke', tokens: reopened.runtime.issueTokens() }), result); assert.equal(reopened.runtime.snapshot().records.length, 2);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
test('Tier 1 success bypasses Tier 2; both-tier faults commit only deterministic safe abort', () => {
  for (const mode of ['primary', 'abort'] as const) {
    const directory = temp(); try {
      const f = fallbackFixture(directory, mode), args = initialize(f), before = f.runtime.snapshot(), result = f.runtime.call(args, { operationId: 'invoke', tokens: f.runtime.issueTokens() });
      if (mode === 'primary') { assert.equal(result.state, 'completed'); assert.equal(result.tier, 1); assert.equal(f.runtime.pendingRepairs().length, 0); }
      else { same(result, { state: 'aborted', tier: 3, operationId: 'invoke', code: 'fallback_exhausted', productionAuthorized: false }); same(f.runtime.snapshot(), before); assert.equal(f.runtime.pendingRepairs().length, 2); }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }
});
test('missing fallback grants and current revocation never regain authority or publish speculative state', () => {
  for (const when of ['missing', 'tier1-failed', 'before-commit'] as const) {
    const directory = temp(); try {
      let revoke = () => {};
      const f = fallbackFixture(directory, 'fallback', phase => { if (phase === when) revoke(); }); revoke = f.revoke;
      const args = initialize(f), before = f.runtime.snapshot(), all = f.runtime.issueTokens();
      const result = f.runtime.call(args, { operationId: 'denied', tokens: when === 'missing' ? [all[0]] : all });
      same(result, { state: 'aborted', tier: 3, operationId: 'denied', code: 'authority_denied', productionAuthorized: false }); same(f.runtime.snapshot(), before);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }
});
test('argument and exact retry identity validation precede fallback execution', () => {
  const directory = temp(); try {
    const f = fallbackFixture(directory), args = initialize(f), tokens = f.runtime.issueTokens(), before = f.runtime.snapshot();
    assert.throws(() => f.runtime.call([{ tag: 'string', value: 'wrong' }, args[1]], { operationId: 'bad', tokens }), /record|type|reference/i); same(f.runtime.snapshot(), before); assert.equal(f.runtime.pendingRepairs().length, 0);
    f.runtime.call(args, { operationId: 'exact', tokens }); assert.throws(() => f.runtime.call([], { operationId: 'exact', tokens }), /identity conflict/);
    assert.throws(() => f.runtime.call(args, { operationId: 'exact', tokens: [tokens[0]] }), /cached fallback result authority denied/);
    assert.throws(() => f.runtime.call(args, { operationId: 'missing-authority', tokens: [] }), /authority/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
test('durable asynchronous repair outbox survives failed delivery and deduplicates by stable event ID', async () => {
  const directory = temp(); try {
    const f = fallbackFixture(directory), args = initialize(f); f.runtime.call(args, { operationId: 'repair', tokens: f.runtime.issueTokens() });
    const original = f.runtime.pendingRepairs()[0]; let release!: () => void;
    const delivered = new Set<string>(); const work = f.runtime.drainRepairs(async event => { delivered.add(event.id); await new Promise<void>(resolve => { release = resolve; }); });
    while (!release) await new Promise(resolve => setTimeout(resolve, 1));
    const another = f.runtime.call(args, { operationId: 'serving-during-repair', tokens: f.runtime.issueTokens() }); assert.equal(another.state, 'completed'); release(); await work;
    const reopened = fallbackFixture(directory); assert.ok(reopened.runtime.pendingRepairs().every(event => event.id !== original.id));
    await assert.rejects(reopened.runtime.drainRepairs(async () => { throw new Error('repair offline'); }), /offline/); assert.equal(reopened.runtime.pendingRepairs().length, 1);
    await reopened.runtime.drainRepairs(async event => { delivered.add(event.id); }); assert.equal(delivered.size, 2); assert.equal(reopened.runtime.pendingRepairs().length, 0);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
test('real process death before publication restores safe state; committed result is not replayed', () => {
  for (const phase of ['call-intent', 'tier1-failed', 'before-commit', 'committed'] as const) {
    const directory = temp(); try {
      const f = fallbackFixture(directory), args = initialize(f), before = f.runtime.snapshot();
      const script = `const {fallbackFixture}=await import(${JSON.stringify(pathToFileURL(resolve('test/tier3/fallback-tree-fixture.ts')).href)}); const f=fallbackFixture(${JSON.stringify(directory)},'fallback',p=>{if(p===${JSON.stringify(phase)})process.kill(process.pid,'SIGKILL');}); f.runtime.call(${JSON.stringify(args)},{operationId:'crash',tokens:f.runtime.issueTokens()});`;
      const child = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', script], { encoding: 'utf8' }); assert.equal(child.signal, 'SIGKILL', child.stderr);
      const reopened = fallbackFixture(directory), result = reopened.runtime.call(args, { operationId: 'crash', tokens: reopened.runtime.issueTokens() });
      if (phase === 'committed') { assert.equal(result.state, 'completed'); assert.equal(reopened.runtime.snapshot().records.length, 2); }
      else { assert.equal(result.state, 'aborted'); if (result.state === 'aborted') assert.equal(result.code, 'interrupted_pure_call'); same(reopened.runtime.snapshot(), before); }
      assert.ok(reopened.runtime.pendingRepairs().length > 0);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }
});
test('signature/contract mismatch, effects/tasks and altered durable state fail closed', () => {
  const directory = temp(); try {
    const f = fallbackFixture(directory), module = f.options.module; if (module.kind !== 'Module') throw new Error('module');
    const replace = (body: ReturnType<typeof b.block>, contractMismatch = false) => {
      const members = module.members.map((node, index) => node.kind === 'FunctionDecl' && index === 1 ? { ...node, body, ...(contractMismatch ? { contract: b.contract({}) } : {}) } : node);
      const changed = { ...module, members }, manifest = createEvidenceManifest({ module: changed, registry: new CapabilityRegistry(), specification: 'test', semanticsVersion: 'reference/1', compilerDigest: f.options.manifest.compilerDigest, capabilityPolicyDigest: f.options.manifest.capabilityPolicyDigest, target: f.options.manifest.target }); return { ...f.options, module: changed, manifest };
    };
    assert.throws(() => new FallbackTreeRuntime(replace(b.block(b.ret(b.int(1))), true)), /identical signature/);
    assert.throws(() => new FallbackTreeRuntime(replace(b.block(b.exprStmt(b.spawn(b.int(1))), b.ret(b.int(1))))), /opaque/);
    initialize(f); const path = join(directory, 'runtime', 'fallback.json'), envelope = JSON.parse(readFileSync(path, 'utf8')); envelope.body.snapshot.records[0].fields[0][1].value = '1000'; writeFileSync(path, JSON.stringify(envelope));
    assert.throws(() => f.runtime.snapshot(), /forged/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
test('noncanonical spelling of a valid fallback journal signature is refused', () => {
  const directory = temp(); try {
    const f = fallbackFixture(directory), path = join(directory, 'runtime', 'fallback.json');
    const envelope = JSON.parse(readFileSync(path, 'utf8')) as { body: unknown; signature: string };
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const index = alphabet.indexOf(envelope.signature[85]); assert.ok(index >= 0);
    envelope.signature = envelope.signature.slice(0, 85) + alphabet[(index & ~3) | ((index + 1) & 3)] + '==';
    writeFileSync(path, JSON.stringify(envelope));
    assert.throws(() => f.runtime.snapshot(), /forged fallback journal/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
test('entry/loop guard exhaustion takes the permitted fallback after restoring writes', () => {
  const directory = temp(); try {
    const f = fallbackFixture(directory), module = f.options.module; if (module.kind !== 'Module') throw new Error('module');
    const changed = { ...module, members: module.members.map((node, index) => node.kind === 'FunctionDecl' && index === 0 ? { ...node, body: b.block(b.while_(b.bool(true), b.block(b.assign(b.place(node.params[0].symbol, 'value'), b.int(99)))), b.ret(b.int(1))) } : node) };
    const manifest = createEvidenceManifest({ module: changed, registry: new CapabilityRegistry(), specification: 'loop fault fallback', semanticsVersion: 'reference/1', compilerDigest: f.options.manifest.compilerDigest, capabilityPolicyDigest: f.options.manifest.capabilityPolicyDigest, target: f.options.manifest.target });
    const runtime = new FallbackTreeRuntime({ ...f.options, directory: join(directory, 'loop'), module: changed, manifest, maxGuardChecks: 3 });
    const reference = runtime.allocateRecord(f.record, { value: { tag: 'int', value: '10' } }, 'initial'), args: TaggedValueV1[] = [{ tag: 'ref', value: reference }, { tag: 'ref', value: reference }];
    const result = runtime.call(args, { operationId: 'bounded', tokens: runtime.issueTokens() }); assert.equal(result.state, 'completed'); assert.equal(result.tier, 2); assert.equal(runtime.pendingRepairs()[0].fault, 'step_budget');
    same(runtime.snapshot().records[0].fields, [['value', { tag: 'int', value: '11' }]]);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
test('SIGKILL after repair delivery before acknowledgment redelivers the same durable event ID', async () => {
  const directory = temp(); try {
    const f = fallbackFixture(directory), args = initialize(f); f.runtime.call(args, { operationId: 'repair-crash', tokens: f.runtime.issueTokens() });
    const id = f.runtime.pendingRepairs()[0].id, path = join(directory, 'delivered');
    const script = `import {writeFileSync,openSync,fsyncSync,closeSync} from 'node:fs'; const {fallbackFixture}=await import(${JSON.stringify(pathToFileURL(resolve('test/tier3/fallback-tree-fixture.ts')).href)}); const f=fallbackFixture(${JSON.stringify(directory)},'fallback',p=>{if(p==='repair-delivered')process.kill(process.pid,'SIGKILL');}); await f.runtime.drainRepairs(async event=>{writeFileSync(${JSON.stringify(path)},event.id); const fd=openSync(${JSON.stringify(path)},'r');fsyncSync(fd);closeSync(fd);});`;
    const child = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', script], { encoding: 'utf8' }); assert.equal(child.signal, 'SIGKILL', child.stderr); assert.equal(readFileSync(path, 'utf8'), id);
    const reopened = fallbackFixture(directory), repeated: string[] = []; assert.equal(reopened.runtime.pendingRepairs()[0].id, id); await reopened.runtime.drainRepairs(async event => { repeated.push(event.id); }); same(repeated, [id]); assert.equal(reopened.runtime.pendingRepairs().length, 0);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
