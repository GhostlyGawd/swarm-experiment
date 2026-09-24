import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { processFallbackFixture } from './process-fallback-fixture.ts';
import { ProcessFallbackSupervisor } from '../../src/tier4/process-fallback.ts';
import { checkConservativeFallbackProof } from '../../src/tier3/fallback-proof.ts';
import { domainDigest } from '../../src/fabric/identity.ts';
import type { ProcessHost } from '../../src/tier4/process-host.ts';

const temporary = () => mkdtempSync(join(tmpdir(), 'aether-fallback-proof-process-'));
const args = [{ tag: 'int', value: '7' }] as const;
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

test('effectful Tier 1 falls through to independently proved pure Tier 2 after durable noncommit', async () => {
  const directory = temporary(), f = processFallbackFixture(directory, 'proved-pre-effect');
  let host: ProcessHost | undefined;
  try {
    const opened = await f.open(); host = opened.host;
    assert.equal(opened.supervisor.conservativeProofDigest,
      checkConservativeFallbackProof(f.module, f.manifest, f.tier2, f.conservativeProof!));
    const before = await host.snapshot();
    const result = await opened.supervisor.call(args, { operationId: 'proved-fallback' });
    assert.deepEqual(plain(result), { state: 'completed', tier: 2, operationId: 'proved-fallback',
      value: { tag: 'int', value: '8' }, productionAuthorized: false });
    assert.deepEqual(await host.snapshot(), before);
    assert.equal(f.calls(), 0);
    assert.equal(opened.supervisor.pendingRepairs().length, 1);
    assert.equal(JSON.parse(readFileSync(join(directory, 'supervisor', 'fallback.json'), 'utf8')).body.format,
      'aether.process-fallback-journal/2');
    assert.deepEqual(plain(await opened.supervisor.call(args, { operationId: 'proved-fallback' })), plain(result));
    await host.close(); host = undefined;
    const reopened = await f.open(); host = reopened.host;
    assert.deepEqual(plain(await reopened.supervisor.call(args, { operationId: 'proved-fallback' })), plain(result));
    assert.equal(f.calls(), 0);
    assert.throws(() => new ProcessFallbackSupervisor({ directory: join(directory, 'supervisor'), host: host!,
      module: f.module, manifest: f.manifest, tier1: f.tier1, tier2: f.tier2, key: f.key,
      tokensFor: (_, symbol) => host!.issueTokens(symbol) }), /identical signature/);
  } finally { await host?.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('possible Tier 1 external commit blocks the proved conservative tier and preserves its sink count', async () => {
  const directory = temporary(), f = processFallbackFixture(directory, 'proved-post-effect'); let host: ProcessHost | undefined;
  try {
    const opened = await f.open(); host = opened.host;
    const result = await opened.supervisor.call(args, { operationId: 'proved-after-effect' });
    assert.deepEqual(plain(result), { state: 'blocked', tier: 1, operationId: 'proved-after-effect',
      code: 'effect_reconciliation_required', productionAuthorized: false });
    assert.equal(f.calls(), 1);
    assert.equal(opened.supervisor.pendingRepairs().length, 0);
    assert.deepEqual(plain(await opened.supervisor.call(args, { operationId: 'proved-after-effect' })), plain(result));
    assert.equal(f.calls(), 1);
  } finally { await host?.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('authority loss after host completion suppresses the supervisor receipt at both tiers', async () => {
  for (const scenario of [
    { mode: 'proved-tier1-success' as const, revokedTier: 1 as const, expectedSinkCalls: 1 },
    { mode: 'proved-pre-effect' as const, revokedTier: 2 as const, expectedSinkCalls: 0 },
  ]) {
    const directory = temporary();
    let host: ProcessHost | undefined, revoked = false;
    const f = processFallbackFixture(directory, scenario.mode, phase => {
      if (phase === 'before-final') revoked = true;
    });
    try {
      const opened = await f.open({ tokensFor: (tier, symbol) =>
        revoked && tier === scenario.revokedTier ? [] : host!.issueTokens(symbol) });
      host = opened.host;
      const operationId = `late-revocation:${scenario.revokedTier}`;
      const result = await opened.supervisor.call(args, { operationId });
      assert.deepEqual(plain(result), { state: 'blocked', tier: scenario.revokedTier,
        operationId, code: 'authority_denied_after_commit', productionAuthorized: false });
      assert.equal(f.calls(), scenario.expectedSinkCalls);
      const hostId = host.status().unresolved[0];
      assert.equal(hostId, undefined, 'host has a completed outcome, not an unresolved replay');
      assert.deepEqual(plain(await opened.supervisor.call(args, { operationId })), plain(result));
      assert.equal(f.calls(), scenario.expectedSinkCalls, 'retry cannot redispatch the sink');
    } finally { await host?.close(); rmSync(directory, { recursive: true, force: true }); }
  }
});

test('a cached static abort refuses a later completed host operation under its Tier 2 identity', async () => {
  const directory = temporary(), f = processFallbackFixture(directory, 'proved-pre-effect');
  let host: ProcessHost | undefined;
  try {
    const opened = await f.open({ tokensFor: (tier, symbol) =>
      tier === 2 ? [] : host!.issueTokens(symbol) });
    host = opened.host;
    const operationId = 'cached-abort-host-alias';
    const aborted = await opened.supervisor.call(args, { operationId });
    assert.equal(aborted.state, 'aborted');
    const hostOperationId = domainDigest('aether.process-fallback-tier/1', {
      profile: opened.supervisor.profileDigest, operationId, tier: 2 });
    const direct = await host.call(f.tier2, args,
      { operationId: hostOperationId, tokens: host.issueTokens(f.tier2) });
    assert.equal(direct.state, 'completed');
    if (direct.state === 'completed') assert.equal(direct.execution.ok, true);
    assert.deepEqual(plain(await opened.supervisor.call(args, { operationId })),
      { state: 'blocked', tier: 2, operationId, code: 'state_changed',
        productionAuthorized: false });
  } finally { await host?.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('root revocation after Tier 2 host success cannot turn that success into a terminal abort', async () => {
  const directory = temporary();
  let host: ProcessHost | undefined, revoked = false;
  const f = processFallbackFixture(directory, 'proved-pre-effect', phase => {
    if (phase === 'before-final') revoked = true;
  });
  try {
    const opened = await f.open({ tokensFor: (_tier, symbol) =>
      revoked ? [] : host!.issueTokens(symbol) });
    host = opened.host;
    const operationId = 'root-revoked-after-tier2';
    const first = await opened.supervisor.call(args, { operationId });
    assert.deepEqual(plain(first), { state: 'blocked', tier: 2, operationId,
      code: 'authority_denied_after_commit', productionAuthorized: false });
    const second = await opened.supervisor.call(args, { operationId });
    assert.deepEqual(plain(second), { state: 'blocked', tier: 2, operationId,
      code: 'state_changed', productionAuthorized: false });
    assert.equal(f.calls(), 0);
    const terminal = JSON.parse(readFileSync(join(directory, 'supervisor', 'fallback.json'), 'utf8'))
      .body.calls[0].result;
    assert.equal(terminal, null, 'no false Tier 3 receipt is published');
  } finally { await host?.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('a proved Tier 2 cannot regain revoked invocation authority and an edited certificate is refused', async () => {
  const directory = temporary(), f = processFallbackFixture(directory, 'proved-pre-effect'); let host: ProcessHost | undefined;
  try {
    const opened = await f.open({ tokensFor: (tier, symbol) => tier === 1 ? host!.issueTokens(symbol) : [] });
    host = opened.host;
    const before = await host.snapshot();
    const result = await opened.supervisor.call(args, { operationId: 'proved-denied' });
    assert.deepEqual(plain(result), { state: 'aborted', tier: 3, operationId: 'proved-denied',
      code: 'authority_denied', productionAuthorized: false });
    assert.deepEqual(await host.snapshot(), before);
    assert.equal(f.calls(), 0);
    const bad = { ...f.conservativeProof!, certificate: { ...f.conservativeProof!.certificate, certificates: [] } };
    const wrong = join(directory, 'wrong-proof');
    assert.throws(() => new ProcessFallbackSupervisor({ directory: wrong, host: host!, module: f.module,
      manifest: f.manifest, tier1: f.tier1, tier2: f.tier2, key: f.key,
      tokensFor: (_, symbol) => host!.issueTokens(symbol), conservativeProof: bad }), /coverage/);
    assert.equal(existsSync(wrong), false);
  } finally { await host?.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('proved Tier 2 resumes after actual coordinator SIGKILL at the Tier 1 repair boundary', async () => {
  const directory = temporary(), f = processFallbackFixture(directory, 'proved-pre-effect'); let host: ProcessHost | undefined;
  try {
    const fixtureUrl = pathToFileURL(resolve('test/tier4/process-fallback-fixture.ts')).href;
    const script = `const {processFallbackFixture}=await import(${JSON.stringify(fixtureUrl)});const f=processFallbackFixture(${JSON.stringify(directory)},'proved-pre-effect',p=>{if(p==='tier1-failed')process.kill(process.pid,'SIGKILL')});const {supervisor}=await f.open({key:${JSON.stringify(f.key)}});await supervisor.call([{tag:'int',value:'7'}],{operationId:'proved-crash'});`;
    const child = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', script],
      { encoding: 'utf8', timeout: 15_000 });
    assert.equal(child.signal, 'SIGKILL', child.stderr);
    const opened = await f.open(); host = opened.host;
    const result = await opened.supervisor.call(args, { operationId: 'proved-crash' });
    assert.equal(result.state, 'completed');
    if (result.state === 'completed') assert.equal(result.tier, 2);
    assert.equal(f.calls(), 0);
    assert.equal(opened.supervisor.pendingRepairs().length, 1);
  } finally { await host?.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('V2 reconciles an already committed Tier 1 effect after SIGKILL and never repeats the sink', async () => {
  const directory = temporary(), f = processFallbackFixture(directory, 'proved-tier1-success'); let host: ProcessHost | undefined;
  try {
    const fixtureUrl = pathToFileURL(resolve('test/tier4/process-fallback-fixture.ts')).href;
    const script = `const {processFallbackFixture}=await import(${JSON.stringify(fixtureUrl)});const f=processFallbackFixture(${JSON.stringify(directory)},'proved-tier1-success');const {supervisor}=await f.open({key:${JSON.stringify(f.key)},hostPhase:p=>{if(p==='effect-recorded')process.kill(process.pid,'SIGKILL')}});await supervisor.call([{tag:'int',value:'7'}],{operationId:'proved-commit-crash'});`;
    const child = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', script],
      { encoding: 'utf8', timeout: 15_000 });
    assert.equal(child.signal, 'SIGKILL', child.stderr);
    const opened = await f.open(); host = opened.host;
    const result = await opened.supervisor.call(args, { operationId: 'proved-commit-crash' });
    assert.deepEqual(plain(result), { state: 'completed', tier: 1, operationId: 'proved-commit-crash',
      value: { tag: 'int', value: '8' }, productionAuthorized: false });
    assert.equal(f.calls(), 1);
    assert.equal(opened.supervisor.pendingRepairs().length, 0);
    assert.deepEqual(plain(await opened.supervisor.call(args, { operationId: 'proved-commit-crash' })), plain(result));
    assert.equal(f.calls(), 1);
  } finally { await host?.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('V2 starts proved Tier 2 only after the trusted adapter reports definitive noncommit', async () => {
  const directory = temporary(), f = processFallbackFixture(directory, 'proved-definitive-noncommit'); let host: ProcessHost | undefined;
  try {
    const fixtureUrl = pathToFileURL(resolve('test/tier4/process-fallback-fixture.ts')).href;
    const script = `const {processFallbackFixture}=await import(${JSON.stringify(fixtureUrl)});const f=processFallbackFixture(${JSON.stringify(directory)},'proved-definitive-noncommit',undefined,undefined,undefined,()=>process.kill(process.pid,'SIGKILL'));const {supervisor}=await f.open({key:${JSON.stringify(f.key)}});await supervisor.call([{tag:'int',value:'7'}],{operationId:'proved-noncommit-crash'});`;
    const child = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', script],
      { encoding: 'utf8', timeout: 15_000 });
    assert.equal(child.signal, 'SIGKILL', child.stderr);
    const opened = await f.open(); host = opened.host;
    const result = await opened.supervisor.call(args, { operationId: 'proved-noncommit-crash' });
    assert.deepEqual(plain(result), { state: 'completed', tier: 2, operationId: 'proved-noncommit-crash',
      value: { tag: 'int', value: '8' }, productionAuthorized: false },
      JSON.stringify(host.status().unresolved.map(id => host!.operationResult(id))));
    assert.equal(f.calls(), 0);
    assert.equal(opened.supervisor.pendingRepairs().length, 1);
    assert.equal(host.operationEffectDisposition(opened.supervisor.pendingRepairs()[0].hostOperationId)?.safeToAbortBeforeEffects, true);
  } finally { await host?.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('V2 keeps an unknown post-sink crash blocked and never repeats its external call', async () => {
  const directory = temporary(), f = processFallbackFixture(directory, 'proved-tier1-success'); let host: ProcessHost | undefined;
  try {
    const fixtureUrl = pathToFileURL(resolve('test/tier4/process-fallback-fixture.ts')).href;
    const script = `const {processFallbackFixture}=await import(${JSON.stringify(fixtureUrl)});const f=processFallbackFixture(${JSON.stringify(directory)},'proved-tier1-success',undefined,undefined,()=>process.kill(process.pid,'SIGKILL'));const {supervisor}=await f.open({key:${JSON.stringify(f.key)}});await supervisor.call([{tag:'int',value:'7'}],{operationId:'proved-unknown-crash'});`;
    const child = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', script],
      { encoding: 'utf8', timeout: 15_000 });
    assert.equal(child.signal, 'SIGKILL', child.stderr);
    const opened = await f.open(); host = opened.host;
    const blocked = await opened.supervisor.call(args, { operationId: 'proved-unknown-crash' });
    assert.deepEqual(plain(blocked), { state: 'blocked', tier: 1, operationId: 'proved-unknown-crash',
      code: 'effect_reconciliation_required', productionAuthorized: false });
    assert.equal(f.calls(), 1);
    assert.deepEqual(plain(await opened.supervisor.call(args, { operationId: 'proved-unknown-crash' })), plain(blocked));
    assert.equal(f.calls(), 1);
  } finally { await host?.close(); rmSync(directory, { recursive: true, force: true }); }
});
