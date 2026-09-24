import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { checkConservativeFallbackProof } from '../../src/tier3/fallback-proof.ts';
import { domainDigest } from '../../src/fabric/identity.ts';
import { verifySinkReceipt } from '../../src/fabric/sink-receipt.ts';
import type { ProcessHost } from '../../src/tier4/process-host.ts';
import { attestedFallbackFixture } from './process-fallback-attested-sink-fixture.ts';

const args = [{ tag: 'int', value: '7' }] as const;
const temporary = () => mkdtempSync(join(tmpdir(), 'aether-fallback-sink-'));
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const sourceRoot = resolve(import.meta.dirname, '../..');
function killProcessGroup(pid: number | undefined): void {
  if (!pid || !Number.isSafeInteger(pid)) return;
  try { process.kill(-pid, 'SIGKILL'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
}
function assertSignedDecision(fixture: Awaited<ReturnType<typeof attestedFallbackFixture>>,
  disposition: 'committed' | 'not_committed'): void {
  const head = fixture.witnessedDecisions();
  assert.equal(head.revision, '1');
  assert.equal(head.decisions.length, 1);
  const row = head.decisions[0];
  assert.equal(row.receipt.body.disposition, disposition);
  assert.equal(verifySinkReceipt(row.receipt, fixture.anchor, { repositoryId: row.repositoryId,
    deploymentId: row.deploymentId, request: row.request,
    sinkAuthorityId: fixture.anchor.sinkAuthorityId, sinkId: fixture.anchor.sinkId,
    adapterArtifactDigest: fixture.adapterArtifactDigest, disposition, value: row.value }), true);
}

test('signed sink commit keeps proved Tier 2 idle across host and fallback reopen', async () => {
  const directory = temporary();
  const fixture = await attestedFallbackFixture(directory, 'commit');
  let host: ProcessHost | null = null;
  try {
    const opened = await fixture.open(); host = opened.host;
    assert.equal(opened.supervisor.conservativeProofDigest,
      checkConservativeFallbackProof(fixture.module, fixture.manifest, fixture.tier2, fixture.conservativeProof));
    const result = await opened.supervisor.call(args, { operationId: 'signed-commit' });
    assert.deepEqual(plain(result), { state: 'completed', tier: 1, operationId: 'signed-commit',
      value: { tag: 'int', value: '8' }, productionAuthorized: false });
    assert.equal(fixture.decisionCount(), 1);
    assertSignedDecision(fixture, 'committed');
    const tier2Id = domainDigest('aether.process-fallback-tier/1', {
      profile: opened.supervisor.profileDigest, operationId: 'signed-commit', tier: 2 });
    assert.equal(host.operationResult(tier2Id), null, 'Tier 2 was never attempted');
    assert.equal(opened.supervisor.pendingRepairs().length, 0);
    assert.deepEqual(plain(await opened.supervisor.call(args, { operationId: 'signed-commit' })), plain(result));
    assert.equal(fixture.decisionCount(), 1);
    await host.close(); host = null;
    const reopened = await fixture.open(); host = reopened.host;
    assert.deepEqual(plain(await reopened.supervisor.call(args, { operationId: 'signed-commit' })), plain(result));
    assert.equal(fixture.decisionCount(), 1, 'reopen and replay cannot duplicate external effect');
    assert.equal(reopened.supervisor.pendingRepairs().length, 0);
    await fixture.stopWitness();
    await assert.rejects(reopened.supervisor.call(args, { operationId: 'signed-commit' }),
      /witness|uncertain/i, 'cached success still needs current witness custody');
    await fixture.startWitness();
    assert.deepEqual(plain(await reopened.supervisor.call(args, { operationId: 'signed-commit' })), plain(result));
  } finally { await host?.close(); await fixture.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('separate controllers recover exact Tier 1 replay after SIGKILL between signed sink commit and fallback publication', async () => {
  const directory = temporary();
  const fixture = await attestedFallbackFixture(directory, 'commit');
  const groups = new Set<number>();
  try {
    const fixtureUrl = new URL('./process-fallback-attested-sink-fixture.ts', import.meta.url).href;
    const marker = join(directory, 'crash-boundary.json');
    const readyFile = join(directory, 'controller-ready.json');
    const recoveredFile = join(directory, 'controller-recovered.json');
    const operationId = 'signed-controller-crash';
    const run = (script: string) => new Promise<{ status: number | null; signal: NodeJS.Signals | null;
      stderr: string; pid: number | undefined }>((resolveRun, rejectRun) => {
      const child = spawn(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', script],
        { cwd: sourceRoot, stdio: ['ignore', 'ignore', 'pipe'], detached: true,
          env: { ...process.env, NODE_NO_WARNINGS: '1' } });
      if (child.pid) groups.add(child.pid);
      let stderr = '';
      child.stderr.on('data', chunk => { stderr += String(chunk).slice(0, 4096); });
      const timer = setTimeout(() => {
        killProcessGroup(child.pid);
        if (child.pid) groups.delete(child.pid);
        rejectRun(new Error(`controller timed out: ${stderr}`));
      }, 30_000);
      child.once('error', error => { clearTimeout(timer); rejectRun(error); });
      child.once('exit', (status, signal) => {
        clearTimeout(timer); resolveRun({ status, signal, stderr, pid: child.pid });
      });
    });
    const crash = `
      const {attestedFallbackFixture}=await import(${JSON.stringify(fixtureUrl)});
      const {writeFileSync}=await import('node:fs');
      const fixture=await attestedFallbackFixture(${JSON.stringify(directory)},'commit',true);
      const {host,supervisor}=await fixture.open(phase=>{
        if(phase!=='before-final')return;
        const head=fixture.witnessedDecisions();
        if(head.revision!=='1'||head.decisions.length!==1||head.decisions[0].receipt.body.disposition!=='committed')
          throw new Error('signed sink commit was not witnessed before crash');
        writeFileSync(${JSON.stringify(marker)},JSON.stringify({phase,witnessRevision:head.revision}));
        process.kill(process.pid,'SIGKILL');
      });
      writeFileSync(${JSON.stringify(readyFile)},JSON.stringify({controllerPid:process.pid,workerPids:host.workerPids}));
      await supervisor.call([{tag:'int',value:'7'}],{operationId:${JSON.stringify(operationId)}});
      throw new Error('expected controller SIGKILL before fallback publication');`;
    const crashed = await run(crash);
    assert.equal(crashed.signal, 'SIGKILL', crashed.stderr);
    const ready = JSON.parse(readFileSync(readyFile, 'utf8'));
    const workerPids = Object.values(ready.workerPids) as number[];
    assert.equal(workerPids.length, 1, 'one separate worker served Tier 1');
    assert.ok(workerPids[0] > 0 && workerPids[0] !== ready.controllerPid);
    assert.ok(!Object.values(fixture.servicePids).includes(workerPids[0]));
    assert.deepEqual(JSON.parse(readFileSync(marker, 'utf8')),
      { phase: 'before-final', witnessRevision: '1' });
    assertSignedDecision(fixture, 'committed');
    assert.equal(fixture.decisionCount(), 1);
    const unfinished = JSON.parse(readFileSync(join(directory, 'supervisor', 'fallback.json'), 'utf8'));
    assert.equal(unfinished.body.calls.length, 1);
    assert.equal(unfinished.body.calls[0].operationId, operationId);
    assert.equal(unfinished.body.calls[0].result, null, 'crash preceded fallback terminal publication');
    killProcessGroup(crashed.pid);
    if (crashed.pid) groups.delete(crashed.pid);
    const recover = `
      const {attestedFallbackFixture}=await import(${JSON.stringify(fixtureUrl)});
      const {domainDigest}=await import(${JSON.stringify(new URL('../../src/fabric/identity.ts', import.meta.url).href)});
      const {writeFileSync}=await import('node:fs');
      const fixture=await attestedFallbackFixture(${JSON.stringify(directory)},'commit',true);
      const {host,supervisor}=await fixture.open();
      try {
        const result=await supervisor.call([{tag:'int',value:'7'}],{operationId:${JSON.stringify(operationId)}});
        const replay=await supervisor.call([{tag:'int',value:'7'}],{operationId:${JSON.stringify(operationId)}});
        const tier2Id=domainDigest('aether.process-fallback-tier/1',{
          profile:supervisor.profileDigest,operationId:${JSON.stringify(operationId)},tier:2});
        writeFileSync(${JSON.stringify(recoveredFile)},JSON.stringify({result,replay,
          tier2Result:host.operationResult(tier2Id),pendingRepairs:supervisor.pendingRepairs().length}));
      } finally {await host.close();await fixture.close();}`;
    const recovered = await run(recover);
    killProcessGroup(recovered.pid);
    if (recovered.pid) groups.delete(recovered.pid);
    assert.equal(recovered.status, 0, recovered.stderr);
    const fresh = JSON.parse(readFileSync(recoveredFile, 'utf8'));
    const expected = { state: 'completed', tier: 1, operationId,
      value: { tag: 'int', value: '8' }, productionAuthorized: false };
    assert.deepEqual(fresh.result, expected);
    assert.deepEqual(fresh.replay, expected);
    assert.equal(fresh.tier2Result, null, 'fresh controller never dispatched Tier 2');
    assert.equal(fresh.pendingRepairs, 0);
    assertSignedDecision(fixture, 'committed');
    assert.equal(fixture.decisionCount(), 1, 'fresh controller and cached replay did not redispatch');
    const finished = JSON.parse(readFileSync(join(directory, 'supervisor', 'fallback.json'), 'utf8'));
    assert.deepEqual(finished.body.calls[0].result, expected);
  } finally {
    for (const group of groups) killProcessGroup(group);
    await fixture.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('signed noncommit fence permits independently proved pure Tier 2 after reconciliation', async () => {
  const directory = temporary();
  const fixture = await attestedFallbackFixture(directory, 'fence');
  let host: ProcessHost | null = null;
  try {
    const opened = await fixture.open(); host = opened.host;
    const result = await opened.supervisor.call(args, { operationId: 'signed-fence' });
    assert.deepEqual(plain(result), { state: 'completed', tier: 2, operationId: 'signed-fence',
      value: { tag: 'int', value: '8' }, productionAuthorized: false });
    assert.equal(fixture.decisionCount(), 1, 'the only sink decision is the signed noncommit fence');
    assertSignedDecision(fixture, 'not_committed');
    const tier2Id = domainDigest('aether.process-fallback-tier/1', {
      profile: opened.supervisor.profileDigest, operationId: 'signed-fence', tier: 2 });
    const conservative = host.operationResult(tier2Id);
    assert.equal(conservative?.state, 'completed');
    if (conservative?.state === 'completed') assert.equal(conservative.execution.ok, true);
    assert.equal(opened.supervisor.pendingRepairs().length, 1);
    assert.equal(fixture.request() !== null, true);
    assert.deepEqual(plain(await opened.supervisor.call(args, { operationId: 'signed-fence' })), plain(result));
    await host.close(); host = null;
    const reopened = await fixture.open(); host = reopened.host;
    assert.deepEqual(plain(await reopened.supervisor.call(args, { operationId: 'signed-fence' })), plain(result));
    assert.equal(fixture.decisionCount(), 1);
    assertSignedDecision(fixture, 'not_committed');
  } finally { await host?.close(); await fixture.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('witness outage around Tier 1 dispatch cannot authorize pure Tier 2', async () => {
  const directory = temporary();
  const fixture = await attestedFallbackFixture(directory, 'outage');
  let host: ProcessHost | null = null;
  try {
    const opened = await fixture.open(); host = opened.host;
    await assert.rejects(opened.supervisor.call(args, { operationId: 'signed-outage' }),
      /witness|sink decision|uncertain/i);
    assert.equal(fixture.decisionCount(), 0);
    assert.equal(opened.supervisor.pendingRepairs().length, 0);
    await fixture.startWitness();
    const reconciled = await opened.supervisor.call(args, { operationId: 'signed-outage' });
    assert.deepEqual(plain(reconciled), { state: 'completed', tier: 2, operationId: 'signed-outage',
      value: { tag: 'int', value: '8' }, productionAuthorized: false },
      'Tier 2 can run only after the restarted witness authenticates a noncommit fence');
    assert.equal(fixture.decisionCount(), 1);
  } finally { await host?.close(); await fixture.close(); rmSync(directory, { recursive: true, force: true }); }
});
