import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { processFallbackFixture } from './process-fallback-fixture.ts';
import { ProcessFallbackSupervisor } from '../../src/tier4/process-fallback.ts';
import { ProcessHost } from '../../src/tier4/process-host.ts';
import * as b from '../../src/tier1/build.ts';
import { typeName } from '../../src/tier1/ids.ts';
import { createEvidenceManifest } from '../../src/fabric/evidence.ts';

const temp = () => mkdtempSync(join(tmpdir(), 'aether-process-fallback-'));
const arg = [{ tag: 'int', value: '7' }] as const;
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

test('pre-effect Tier 1 fault uses real ProcessHost Tier 2 and one durable sink call', async () => {
  const directory = temp(), f = processFallbackFixture(directory, 'pre-effect-fault'); let host: ProcessHost | undefined;
  try {
    const opened = await f.open(); host = opened.host;
    const result = await opened.supervisor.call(arg, { operationId: 'fallback' });
    assert.deepEqual(plain(result), { state: 'completed', tier: 2, operationId: 'fallback', value: { tag: 'int', value: '2' }, productionAuthorized: false });
    assert.equal(f.calls(), 1);
    assert.equal(opened.supervisor.pendingRepairs().length, 1);
    assert.equal(opened.supervisor.pendingRepairs()[0].tier, 1);
    const disposition = host.operationEffectDisposition(opened.supervisor.pendingRepairs()[0].hostOperationId);
    assert.equal(disposition?.safeToAbortBeforeEffects, true); assert.equal(disposition?.possibleExternalCommit, false);
    assert.equal(Object.isFrozen(disposition), true); assert.equal(Object.isFrozen(disposition?.effects), true);
    assert.equal((await opened.supervisor.call(arg, { operationId: 'fallback' })).state, 'completed'); assert.equal(f.calls(), 1);
    const denied = new ProcessFallbackSupervisor({ directory: join(directory, 'supervisor'), host, module: f.module, manifest: f.manifest,
      tier1: f.tier1, tier2: f.tier2, key: f.key, tokensFor: (tier, symbol) => tier === 1 ? [] : host!.issueTokens(symbol) });
    await assert.rejects(denied.call(arg, { operationId: 'fallback' }), /authority_denied/);
    assert.equal(f.calls(), 1, 'cached denial cannot repeat the sink');
    await host.close(); host = undefined;
    const reopened = await f.open(); host = reopened.host;
    assert.deepEqual(plain(await reopened.supervisor.call(arg, { operationId: 'fallback' })), plain(result)); assert.equal(f.calls(), 1);
    await assert.rejects(reopened.supervisor.call([{ tag: 'int', value: '8' }], { operationId: 'fallback' }), /identity conflict/);
  } finally { await host?.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('committed Tier 1 effect followed by fault blocks fallback and never duplicates sink', async () => {
  const directory = temp(), f = processFallbackFixture(directory, 'post-effect-fault'); let host: ProcessHost | undefined;
  try {
    const opened = await f.open(); host = opened.host;
    const result = await opened.supervisor.call(arg, { operationId: 'committed-fault' });
    assert.deepEqual(result, { state: 'blocked', tier: 1, operationId: 'committed-fault', code: 'effect_reconciliation_required', productionAuthorized: false });
    assert.equal(f.calls(), 1);
    assert.deepEqual(plain(await opened.supervisor.call(arg, { operationId: 'committed-fault' })), plain(result));
    assert.equal(f.calls(), 1); assert.equal(opened.supervisor.pendingRepairs().length, 0);
    await host.close(); host = undefined;
    const reopened = await f.open(); host = reopened.host;
    assert.deepEqual(plain(await reopened.supervisor.call(arg, { operationId: 'committed-fault' })), plain(result)); assert.equal(f.calls(), 1);
  } finally { await host?.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('both tiers fault before effects and yield deterministic Tier 3 abort', async () => {
  const directory = temp(), f = processFallbackFixture(directory, 'both-fault'); let host: ProcessHost | undefined;
  try {
    const opened = await f.open(); host = opened.host;
    const before = await host.snapshot(), result = await opened.supervisor.call(arg, { operationId: 'exhausted' });
    assert.deepEqual(plain(result), { state: 'aborted', tier: 3, operationId: 'exhausted', code: 'fallback_exhausted', productionAuthorized: false });
    assert.deepEqual(await host.snapshot(), before); assert.equal(f.calls(), 0);
    assert.deepEqual(opened.supervisor.pendingRepairs().map(row => row.tier), [1, 2]);
    assert.deepEqual(await opened.supervisor.call(arg, { operationId: 'exhausted' }), result);
  } finally { await host?.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('host expected heap CAS refuses a stale fallback base', async () => {
  const directory = temp(); let host: ProcessHost | undefined;
  const f = processFallbackFixture(directory, 'pre-effect-fault');
  try {
    const opened = await f.open(); host = opened.host;
    // A direct host call with a deliberately stale base is refused under its
    // own lock. The supervisor's second tier uses the same precondition.
    const before = await host.snapshot();
    await host.allocateRecord({ t: 'Record', name: typeName('type:test:fallback_box'), fields: [['value', b.Int]] }, { value: { tag: 'int', value: '9' } }, { operationId: 'change' });
    await assert.rejects(host.call(f.tier2, arg, { operationId: 'stale', tokens: host.issueTokens(f.tier2), expectedSnapshot: 'aether.process-fallback-test/1:b3:' + '0'.repeat(64), expectedGeneration: host.generation }), /stale_process_fallback_base/);
    assert.notDeepEqual(await host.snapshot(), before);
  } finally { await host?.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('a real interleaved host writer prevents Tier 2 from starting from a changed heap', async () => {
  const directory = temp(); let host: ProcessHost | undefined, interloper: Promise<unknown> | undefined;
  const record = { t: 'Record' as const, name: typeName('type:test:interleaved_box'), fields: [['value', b.Int] as const] };
  const f = processFallbackFixture(directory, 'pre-effect-fault', phase => {
    if (phase === 'tier1-failed') interloper = host!.allocateRecord(record, { value: { tag: 'int', value: '9' } }, { operationId: 'interloper' });
  });
  try {
    const opened = await f.open(); host = opened.host;
    const result = await opened.supervisor.call(arg, { operationId: 'interleaved' });
    await interloper;
    assert.deepEqual(plain(result), { state: 'blocked', tier: 2, operationId: 'interleaved', code: 'state_changed', productionAuthorized: false });
    assert.equal(f.calls(), 0); assert.equal((await host.snapshot()).records.length, 1);
  } finally { await host?.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('repair outbox redelivers stable ID after failed async delivery and detects tamper', async () => {
  const directory = temp(), f = processFallbackFixture(directory, 'pre-effect-fault'); let host: ProcessHost | undefined;
  try {
    const opened = await f.open(); host = opened.host;
    await opened.supervisor.call(arg, { operationId: 'repair' });
    const event = opened.supervisor.pendingRepairs()[0];
    await assert.rejects(opened.supervisor.drainRepairs(async () => { throw new Error('offline'); }), /offline/);
    assert.equal(opened.supervisor.pendingRepairs()[0].id, event.id);
    const delivered: string[] = [];
    assert.equal(await opened.supervisor.drainRepairs(async row => { delivered.push(row.id); }), 1);
    assert.deepEqual(delivered, [event.id]); assert.deepEqual(opened.supervisor.pendingRepairs(), []);
    const path = join(directory, 'supervisor', 'fallback.json'), envelope = JSON.parse(readFileSync(path, 'utf8')) as { body: { calls: { requestDigest: string }[] }; signature: string };
    envelope.body.calls[0].requestDigest = 'forged'; writeFileSync(path, JSON.stringify(envelope));
    assert.throws(() => opened.supervisor.pendingRepairs(), /forged fallback journal/);
  } finally { await host?.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('exact signature and contract mismatch is rejected before journal creation', async () => {
  const directory = temp(), f = processFallbackFixture(directory, 'both-fault'); let host: ProcessHost | undefined;
  try {
    const opened = await f.open(); host = opened.host;
    assert.throws(() => new ProcessFallbackSupervisor({ directory: join(directory, 'wrong-key'), host: opened.host, module: f.module, manifest: f.manifest, tier1: f.tier1, tier2: f.tier1, key: f.key, tokensFor: (_, symbol) => opened.host.issueTokens(symbol) }), /identical signature/);
    if (f.module.kind !== 'Module') throw new Error('module');
    const changed = { ...f.module, members: f.module.members.map(member => member.kind === 'FunctionDecl' && member.symbol === f.tier2
      ? { ...member, contract: b.contract({ ensures: [b.clause(b.bool(true), 'different-contract')] }) } : member) };
    const changedManifest = createEvidenceManifest({ module: changed, registry: f.hostOptions.registry, specification: 'Changed fallback contract.', semanticsVersion: 'reference/1', compilerDigest: f.manifest.compilerDigest,
      capabilityPolicyDigest: f.manifest.capabilityPolicyDigest, target: f.manifest.target });
    const changedHost = await ProcessHost.open({ ...f.hostOptions, directory: join(directory, 'changed-host'), module: changed, manifest: changedManifest });
    try {
      assert.throws(() => new ProcessFallbackSupervisor({ directory: join(directory, 'changed-supervisor'), host: changedHost, module: changed, manifest: changedManifest,
        tier1: f.tier1, tier2: f.tier2, key: f.key, tokensFor: (_, symbol) => changedHost.issueTokens(symbol) }), /identical signature/);
    } finally { await changedHost.close(); }
  } finally { await host?.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('SIGKILL after Tier 1 repair intent resumes Tier 2 with stable IDs', async () => {
  const directory = temp(), f = processFallbackFixture(directory, 'pre-effect-fault'); let host: ProcessHost | undefined;
  try {
    const fixtureUrl = pathToFileURL(resolve('test/tier4/process-fallback-fixture.ts')).href;
    const script = `const {processFallbackFixture}=await import(${JSON.stringify(fixtureUrl)});const f=processFallbackFixture(${JSON.stringify(directory)},'pre-effect-fault',p=>{if(p==='tier1-failed')process.kill(process.pid,'SIGKILL')});const {supervisor}=await f.open({key:${JSON.stringify(f.key)}});await supervisor.call([{tag:'int',value:'7'}],{operationId:'crash-before-tier2'});`;
    const child = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', script], { encoding: 'utf8', timeout: 15_000 });
    assert.equal(child.signal, 'SIGKILL', child.stderr);
    const opened = await f.open(); host = opened.host;
    const result = await opened.supervisor.call(arg, { operationId: 'crash-before-tier2' });
    assert.equal(result.state, 'completed'); if (result.state === 'completed') assert.equal(result.tier, 2);
    assert.equal(f.calls(), 1); assert.equal(opened.supervisor.pendingRepairs().length, 1);
    assert.equal((await opened.supervisor.call(arg, { operationId: 'crash-before-tier2' })).state, 'completed'); assert.equal(f.calls(), 1);
  } finally { await host?.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('SIGKILL after external commit blocks Tier 2 until exact host replay resolves Tier 1', async () => {
  const directory = temp(), f = processFallbackFixture(directory, 'tier1-success'); let host: ProcessHost | undefined;
  try {
    const fixtureUrl = pathToFileURL(resolve('test/tier4/process-fallback-fixture.ts')).href;
    const script = `const {processFallbackFixture}=await import(${JSON.stringify(fixtureUrl)});const f=processFallbackFixture(${JSON.stringify(directory)},'tier1-success');const {supervisor}=await f.open({key:${JSON.stringify(f.key)},hostPhase:p=>{if(p==='effect-recorded')process.kill(process.pid,'SIGKILL')}});await supervisor.call([{tag:'int',value:'7'}],{operationId:'crash-after-effect'});`;
    const child = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', script], { encoding: 'utf8', timeout: 15_000 });
    assert.equal(child.signal, 'SIGKILL', child.stderr);
    const opened = await f.open(); host = opened.host;
    const blocked = await opened.supervisor.call(arg, { operationId: 'crash-after-effect' });
    assert.deepEqual(plain(blocked), { state: 'blocked', tier: 1, operationId: 'crash-after-effect', code: 'effect_reconciliation_required', productionAuthorized: false });
    assert.equal(f.calls(), 1);
    const disposition = host.operationEffectDisposition(host.status().unresolved[0]);
    assert.equal(disposition?.possibleExternalCommit, true); assert.equal(disposition?.effects[0].state, 'committed');
    const recovered = await host.recoverOperation(host.status().unresolved[0], { strategy: 'isolated-replay' });
    assert.equal(recovered.state, 'completed'); assert.equal(f.calls(), 1);
    const result = await opened.supervisor.call(arg, { operationId: 'crash-after-effect' });
    assert.equal(result.state, 'completed'); if (result.state === 'completed') assert.equal(result.tier, 1);
    assert.equal(f.calls(), 1);
  } finally { await host?.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('SIGKILL after host call intent is recovered only with durable noncommit evidence', async () => {
  const directory = temp(), f = processFallbackFixture(directory, 'pre-effect-fault'); let host: ProcessHost | undefined;
  try {
    const fixtureUrl = pathToFileURL(resolve('test/tier4/process-fallback-fixture.ts')).href;
    const script = `const {processFallbackFixture}=await import(${JSON.stringify(fixtureUrl)});const f=processFallbackFixture(${JSON.stringify(directory)},'pre-effect-fault');const {supervisor}=await f.open({key:${JSON.stringify(f.key)},hostPhase:p=>{if(p==='call-intent')process.kill(process.pid,'SIGKILL')}});await supervisor.call([{tag:'int',value:'7'}],{operationId:'crash-at-intent'});`;
    const child = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', script], { encoding: 'utf8', timeout: 15_000 });
    assert.equal(child.signal, 'SIGKILL', child.stderr);
    const opened = await f.open(); host = opened.host;
    const result = await opened.supervisor.call(arg, { operationId: 'crash-at-intent' });
    assert.equal(result.state, 'completed'); if (result.state === 'completed') assert.equal(result.tier, 2);
    assert.equal(f.calls(), 1);
    const repairs = opened.supervisor.pendingRepairs(); assert.equal(repairs.length, 1); assert.equal(repairs[0].fault, 'interrupted_before_effects');
  } finally { await host?.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('SIGKILL at effect request can abort only after the durable pre-dispatch state is inspected', async () => {
  const directory = temp(), f = processFallbackFixture(directory, 'post-effect-fault'); let host: ProcessHost | undefined;
  try {
    const fixtureUrl = pathToFileURL(resolve('test/tier4/process-fallback-fixture.ts')).href;
    const script = `const {processFallbackFixture}=await import(${JSON.stringify(fixtureUrl)});const f=processFallbackFixture(${JSON.stringify(directory)},'post-effect-fault');const {supervisor}=await f.open({key:${JSON.stringify(f.key)},hostPhase:p=>{if(p==='effect-requested')process.kill(process.pid,'SIGKILL')}});await supervisor.call([{tag:'int',value:'7'}],{operationId:'crash-before-dispatch'});`;
    const child = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', script], { encoding: 'utf8', timeout: 15_000 });
    assert.equal(child.signal, 'SIGKILL', child.stderr);
    const opened = await f.open(); host = opened.host;
    const id = host.status().unresolved[0];
    const disposition = host.operationEffectDisposition(id);
    assert.equal(disposition?.effects[0].state, 'requested');
    assert.equal(disposition?.safeToAbortBeforeEffects, true);
    const result = await opened.supervisor.call(arg, { operationId: 'crash-before-dispatch' });
    assert.equal(result.state, 'completed'); if (result.state === 'completed') assert.equal(result.tier, 2);
    assert.equal(f.calls(), 1);
  } finally { await host?.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('SIGKILL inside the sink leaves dispatch indeterminate and never starts Tier 2', async () => {
  const directory = temp(), f = processFallbackFixture(directory, 'post-effect-fault'); let host: ProcessHost | undefined;
  try {
    const fixtureUrl = pathToFileURL(resolve('test/tier4/process-fallback-fixture.ts')).href;
    const script = `const {processFallbackFixture}=await import(${JSON.stringify(fixtureUrl)});const f=processFallbackFixture(${JSON.stringify(directory)},'post-effect-fault',undefined,undefined,()=>process.kill(process.pid,'SIGKILL'));const {supervisor}=await f.open({key:${JSON.stringify(f.key)}});await supervisor.call([{tag:'int',value:'7'}],{operationId:'crash-inside-sink'});`;
    const child = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', script], { encoding: 'utf8', timeout: 15_000 });
    assert.equal(child.signal, 'SIGKILL', child.stderr);
    const opened = await f.open(); host = opened.host;
    const id = host.status().unresolved[0];
    const disposition = host.operationEffectDisposition(id);
    assert.equal(disposition?.possibleExternalCommit, true);
    assert.equal(disposition?.effects[0].state, 'dispatching');
    const blocked = await opened.supervisor.call(arg, { operationId: 'crash-inside-sink' });
    assert.deepEqual(plain(blocked), { state: 'blocked', tier: 1, operationId: 'crash-inside-sink', code: 'effect_reconciliation_required', productionAuthorized: false });
    assert.equal(f.calls(), 1);
    assert.deepEqual(plain(await opened.supervisor.call(arg, { operationId: 'crash-inside-sink' })), plain(blocked));
    assert.equal(f.calls(), 1);
  } finally { await host?.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('fresh Tier 2 grants are required after Tier 1 fails', async () => {
  const directory = temp(), f = processFallbackFixture(directory, 'pre-effect-fault'); let host: ProcessHost | undefined;
  try {
    const opened = await f.open({ tokensFor: (tier, symbol) => tier === 1 ? host!.issueTokens(symbol) : [] }); host = opened.host;
    const result = await opened.supervisor.call(arg, { operationId: 'denied-tier2' });
    assert.deepEqual(plain(result), { state: 'aborted', tier: 3, operationId: 'denied-tier2', code: 'authority_denied', productionAuthorized: false });
    assert.equal(f.calls(), 0); assert.equal(opened.supervisor.pendingRepairs().length, 1);
  } finally { await host?.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('missing Tier 1 grant is rejected before an operation ID is claimed', async () => {
  const directory = temp(), f = processFallbackFixture(directory, 'pre-effect-fault'); let host: ProcessHost | undefined;
  try {
    const opened = await f.open({ tokensFor: () => [] }); host = opened.host;
    await assert.rejects(opened.supervisor.call(arg, { operationId: 'initially-unauthorized' }), /authority_denied/);
    assert.equal(f.calls(), 0);
    const valid = new ProcessFallbackSupervisor({ directory: join(directory, 'supervisor'), host: opened.host, module: f.module, manifest: f.manifest,
      tier1: f.tier1, tier2: f.tier2, key: f.key, tokensFor: (_, symbol) => opened.host.issueTokens(symbol) });
    const result = await valid.call(arg, { operationId: 'initially-unauthorized' });
    assert.equal(result.state, 'completed'); if (result.state === 'completed') assert.equal(result.tier, 2);
    assert.equal(f.calls(), 1);
  } finally { await host?.close(); rmSync(directory, { recursive: true, force: true }); }
});
