import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { decodeCanonical, encodeCanonical } from '../../src/fabric/encoding.ts';
import { runtimeSnapshotDigest, type RuntimeSnapshotV1 } from '../../src/fabric/snapshot.ts';
import type { ProcessHost } from '../../src/tier4/process-host.ts';
import { nativeFallbackHostFixture, nativeDeploymentId, nativeRepositoryId,
  nativeWitnessAuthority, prepareNativeFallbackArtifact } from './process-native-fallback-host-fixture.ts';

const sourceRoot = resolve(import.meta.dirname, '../..');
async function launchWitness(config: string): Promise<ChildProcess> {
  const child = spawn(process.execPath,
    ['--experimental-strip-types', join(sourceRoot, 'src/fabric/witness-service-cli.ts'),
      '--config', config], { cwd: sourceRoot, stdio: ['ignore', 'pipe', 'pipe'] });
  return new Promise((resolveReady, reject) => {
    let stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(stderr || 'witness startup timeout')); }, 8000);
    child.stderr!.on('data', value => { stderr += String(value); });
    child.stdout!.on('data', value => {
      if (String(value).includes('witness service ready')) {
        clearTimeout(timer); resolveReady(child);
      }
    });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`witness exited ${code}: ${stderr}`)); });
  });
}
async function kill(child: ChildProcess | null): Promise<void> {
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL'); await once(child, 'exit');
  }
}
function killGroup(pid: number | undefined): void {
  if (!pid) return;
  try { process.kill(-pid, 'SIGKILL'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
}
async function runController(script: string): Promise<{
  pid: number | undefined; status: number | null; signal: NodeJS.Signals | null; stderr: string }> {
  const child = spawn(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', script],
    { cwd: sourceRoot, stdio: ['ignore', 'ignore', 'pipe'], detached: true,
      env: { ...process.env, NODE_NO_WARNINGS: '1' } });
  return new Promise((resolveRun, rejectRun) => {
    let stderr = '';
    child.stderr!.on('data', chunk => { stderr += String(chunk).slice(0, 4096); });
    const timer = setTimeout(() => { killGroup(child.pid); rejectRun(new Error(`native controller timeout: ${stderr}`)); }, 30000);
    child.once('error', error => { clearTimeout(timer); rejectRun(error); });
    child.once('exit', (status, signal) => {
      clearTimeout(timer); resolveRun({ pid: child.pid, status, signal, stderr });
    });
  });
}
function start(directory: string): Promise<ChildProcess> {
  const keyFile = join(directory, 'witness.key'), config = join(directory, 'witness.json');
  writeFileSync(keyFile, randomBytes(32), { mode: 0o600 });
  writeFileSync(config, encodeCanonical({
    socketPath: join(directory, 'witness.sock'), storageDir: join(directory, 'witness-store'),
    keyFile, namespaces: [{ kind: 'host-scope', authorityId: nativeWitnessAuthority,
      repositoryId: nativeRepositoryId, deploymentId: nativeDeploymentId }],
  }), { mode: 0o600 });
  return launchWitness(config);
}
function field(snapshot: RuntimeSnapshotV1, objectId: string): string {
  const value = snapshot.records.find(row => row.objectId === objectId)?.fields
    .find(([name]) => name === 'value')?.[1];
  assert.equal(value?.tag, 'int');
  return value.value;
}

test('witnessed native fallback publishes the proved alias result and survives reopen', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'aether-native-fallback-host-'));
  let witness: ChildProcess | null = null, host: ProcessHost | null = null;
  try {
    witness = await start(directory);
    prepareNativeFallbackArtifact(directory);
    const fixture = nativeFallbackHostFixture(directory);
    host = await fixture.open();
    const left = await host.allocateRecord(fixture.f.record,
      { value: { tag: 'int', value: '10' } }, { operationId: 'source-left' });
    const before = await host.snapshot();
    const beforeJournal = readFileSync(join(directory, 'host', 'host.json'), 'utf8');
    const operationId = 'native-alias';
    const result = await host.callNativeFallback(left, left, {
      operationId, tokens: fixture.tokens(host),
      expectedSnapshot: runtimeSnapshotDigest(before), expectedGeneration: host.generation });
    assert.equal(result.outcome.tier, 2);
    assert.equal(result.outcome.state, 'completed');
    assert.equal(result.outcome.value?.tag, 'int');
    if (result.outcome.value?.tag === 'int') assert.equal(result.outcome.value.value, '11');
    const after = await host.snapshot();
    assert.equal(runtimeSnapshotDigest(after), runtimeSnapshotDigest(result.outcome.after));
    assert.equal(field(after, left.objectId), '11');
    assert.equal(after.nextObjectId, '3');
    assert.equal(field(after, '2'), '888');
    const journal = JSON.parse(readFileSync(join(directory, 'host', 'host.json'), 'utf8'));
    assert.equal(journal.format, 'aether.process-host/5');
    assert.equal(journal.nativeFallbacks.length, 1);
    assert.equal(journal.nativeFallbacks[0].state, 'committed');
    assert.equal(journal.nativeFallbacks[0].resultDigest !== null, true);
    assert.deepEqual(await host.callNativeFallback(left, left,
      { operationId, tokens: fixture.tokens(host) }), result);
    await host.close(); host = null;
    // An older local mirror must be restored from the operator witness.
    writeFileSync(join(directory, 'host', 'host.json'), beforeJournal);
    host = await fixture.open();
    assert.deepEqual(host.nativeFallbackResult(operationId, fixture.tokens(host)), result);
    assert.equal(field(await host.snapshot(), left.objectId), '11');
  } finally { await host?.close(); await kill(witness); rmSync(directory, { recursive: true, force: true }); }
});

test('distinct-reference native Tier 3 abort preserves the exact host source state', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'aether-native-fallback-abort-'));
  let witness: ChildProcess | null = null, host: ProcessHost | null = null;
  try {
    witness = await start(directory);
    prepareNativeFallbackArtifact(directory);
    const fixture = nativeFallbackHostFixture(directory);
    host = await fixture.open();
    const left = await host.allocateRecord(fixture.f.record,
      { value: { tag: 'int', value: '10' } }, { operationId: 'source-left' });
    const right = await host.allocateRecord(fixture.f.record,
      { value: { tag: 'int', value: '110' } }, { operationId: 'source-right' });
    const before = await host.snapshot(), operationId = 'native-distinct-abort';
    const result = await host.callNativeFallback(left, right, {
      operationId, tokens: fixture.tokens(host),
      expectedSnapshot: runtimeSnapshotDigest(before), expectedGeneration: host.generation });
    assert.equal(result.outcome.tier, 3);
    assert.equal(result.outcome.state, 'aborted');
    assert.equal(runtimeSnapshotDigest(await host.snapshot()), runtimeSnapshotDigest(before));
    assert.equal(runtimeSnapshotDigest(result.outcome.after), runtimeSnapshotDigest(before));
    assert.deepEqual(await host.callNativeFallback(left, right,
      { operationId, tokens: fixture.tokens(host) }), result);
    const journal = JSON.parse(readFileSync(join(directory, 'host', 'host.json'), 'utf8'));
    assert.equal(journal.nativeFallbacks.length, 1);
    assert.equal(journal.nativeFallbacks[0].state, 'aborted');
  } finally { await host?.close(); await kill(witness); rmSync(directory, { recursive: true, force: true }); }
});

test('native grants fail before intent and revocation at publication retains recoverable source', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'aether-native-fallback-revocation-'));
  let witness: ChildProcess | null = null, host: ProcessHost | null = null;
  try {
    witness = await start(directory);
    prepareNativeFallbackArtifact(directory);
    const fixture = nativeFallbackHostFixture(directory);
    host = await fixture.open(phase => {
      if (phase === 'native-fallback-before-commit') fixture.revoke();
    });
    const left = await host.allocateRecord(fixture.f.record,
      { value: { tag: 'int', value: '10' } }, { operationId: 'source-left' });
    const before = await host.snapshot();
    const journalBefore = readFileSync(join(directory, 'host', 'host.json'), 'utf8');
    const missing = fixture.tokens(host);
    await assert.rejects(host.callNativeFallback(left, left,
      { operationId: 'missing-tier2', tokens: { ...missing, tier2: [] } }),
    /authority|grant|denied/i);
    assert.equal(readFileSync(join(directory, 'host', 'host.json'), 'utf8'), journalBefore,
      'denied Tier 2 authority creates no native intent');
    const operationId = 'revoked-before-native-publication';
    await assert.rejects(host.callNativeFallback(left, left,
      { operationId, tokens: fixture.tokens(host) }), /authority|grant|revoked|denied/i);
    assert.equal(runtimeSnapshotDigest(await host.snapshot()), runtimeSnapshotDigest(before));
    assert(host.status().unresolved.includes(operationId));
    const pending = JSON.parse(readFileSync(join(directory, 'host', 'host.json'), 'utf8'));
    assert.equal(pending.nativeFallbacks.length, 1);
    assert.equal(pending.nativeFallbacks[0].state, 'running');
    assert.equal(pending.nativeFallbacks[0].result, null);
    await host.close(); host = null;

    const deniedRecovery = nativeFallbackHostFixture(directory);
    deniedRecovery.denyRecovery();
    host = await deniedRecovery.open();
    await assert.rejects(host.recoverNativeFallback(operationId,
      { tokens: deniedRecovery.tokens(host) }), /recovery_authorization_denied/);
    assert.equal(runtimeSnapshotDigest(await host.snapshot()), runtimeSnapshotDigest(before));
    await host.close(); host = null;

    const allowedRecovery = nativeFallbackHostFixture(directory);
    host = await allowedRecovery.open();
    const recovered = await host.recoverNativeFallback(operationId,
      { tokens: allowedRecovery.tokens(host) });
    assert.equal(recovered.outcome.state, 'completed');
    assert.equal(recovered.outcome.tier, 2);
    assert.equal(field(await host.snapshot(), left.objectId), '11');
  } finally { await host?.close(); await kill(witness); rmSync(directory, { recursive: true, force: true }); }
});

test('substituted executable leaves a witnessed native intent unresolved until exact bytes return', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'aether-native-fallback-binary-'));
  let witness: ChildProcess | null = null, host: ProcessHost | null = null;
  try {
    witness = await start(directory);
    prepareNativeFallbackArtifact(directory);
    const fixture = nativeFallbackHostFixture(directory);
    const original = readFileSync(fixture.artifact.executablePath);
    host = await fixture.open();
    const left = await host.allocateRecord(fixture.f.record,
      { value: { tag: 'int', value: '10' } }, { operationId: 'source-left' });
    const before = await host.snapshot(), operationId = 'substituted-native-artifact';
    writeFileSync(fixture.artifact.executablePath, 'changed executable bytes');
    await assert.rejects(host.callNativeFallback(left, left,
      { operationId, tokens: fixture.tokens(host) }), /executable digest mismatch/);
    assert.equal(runtimeSnapshotDigest(await host.snapshot()), runtimeSnapshotDigest(before));
    const pending = JSON.parse(readFileSync(join(directory, 'host', 'host.json'), 'utf8'));
    assert.equal(pending.nativeFallbacks.length, 1);
    assert.equal(pending.nativeFallbacks[0].state, 'running');
    assert.equal(pending.nativeFallbacks[0].result, null);
    writeFileSync(fixture.artifact.executablePath, original);
    const recovered = await host.recoverNativeFallback(operationId,
      { tokens: fixture.tokens(host) });
    assert.equal(recovered.outcome.state, 'completed');
    assert.equal(recovered.outcome.tier, 2);
    assert.equal(field(await host.snapshot(), left.objectId), '11');
  } finally { await host?.close(); await kill(witness); rmSync(directory, { recursive: true, force: true }); }
});

test('controller close at native intent, launch or publication cannot commit a result', async () => {
  for (const phaseToClose of ['native-fallback-intent', 'native-fallback-running',
    'native-fallback-before-commit'] as const) {
    const directory = mkdtempSync(join(tmpdir(), 'aether-native-fallback-close-'));
    let witness: ChildProcess | null = null, host: ProcessHost | null = null;
    let closed: Promise<void> | undefined;
    try {
      witness = await start(directory);
      prepareNativeFallbackArtifact(directory);
      const fixture = nativeFallbackHostFixture(directory);
      host = await fixture.open(phase => {
        if (phase === phaseToClose) closed = host!.close();
      });
      const left = await host.allocateRecord(fixture.f.record,
        { value: { tag: 'int', value: '10' } }, { operationId: 'source-left' });
      const before = await host.snapshot(), operationId = `closed-at:${phaseToClose}`;
      await assert.rejects(host.callNativeFallback(left, left,
        { operationId, tokens: fixture.tokens(host) }), /closed/i);
      await closed; host = null;
      const fresh = nativeFallbackHostFixture(directory);
      host = await fresh.open();
      assert.equal(runtimeSnapshotDigest(await host.snapshot()), runtimeSnapshotDigest(before));
      assert(host.status().unresolved.includes(operationId));
      const pending = JSON.parse(readFileSync(join(directory, 'host', 'host.json'), 'utf8'));
      assert.equal(pending.nativeFallbacks.length, 1);
      assert.equal(pending.nativeFallbacks[0].state,
        phaseToClose === 'native-fallback-intent' ? 'requested' : 'running');
      assert.equal(pending.nativeFallbacks[0].result, null);
      const recovered = await host.recoverNativeFallback(operationId,
        { tokens: fresh.tokens(host) });
      assert.equal(recovered.outcome.tier, 2);
      assert.equal(field(await host.snapshot(), left.objectId), '11');
    } finally { await host?.close(); await kill(witness); rmSync(directory, { recursive: true, force: true }); }
  }
});

test('witnessed v5 reopen rejects malformed empty checkpoint extension fields', async () => {
  for (const field of ['checkpointLeases', 'checkpointReceipts', 'checkpointControls'] as const) {
    const directory = mkdtempSync(join(tmpdir(), 'aether-native-fallback-v5-shape-'));
    let witness: ChildProcess | null = null, host: ProcessHost | null = null;
    try {
      witness = await start(directory);
      prepareNativeFallbackArtifact(directory);
      const fixture = nativeFallbackHostFixture(directory);
      host = await fixture.open();
      await host.close(); host = null;
      await kill(witness); witness = null;
      const files = readdirSync(join(directory, 'witness-store')).filter(name => name.endsWith('.json'));
      assert.equal(files.length, 1);
      const path = join(directory, 'witness-store', files[0]);
      const stored = decodeCanonical(readFileSync(path)) as { head: { journal: string } };
      const journal = decodeCanonical(Buffer.from(stored.head.journal)) as Record<string, unknown>;
      journal[field] = '';
      stored.head.journal = Buffer.from(encodeCanonical(journal)).toString('utf8');
      writeFileSync(path, encodeCanonical(stored));
      unlinkSync(join(directory, 'host', 'host.json'));
      witness = await launchWitness(join(directory, 'witness.json'));
      const fresh = nativeFallbackHostFixture(directory);
      await assert.rejects(fresh.open(), /invalid witnessed checkpoint journal extension/,
        'malformed ' + field + ' must fail the host parser');
    } finally { await host?.close(); await kill(witness); rmSync(directory, { recursive: true, force: true }); }
  }
});

test('native publication waits for the host witness and recovers after service restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ae-nf-wout-'));
  let witness: ChildProcess | null = null, host: ProcessHost | null = null;
  try {
    witness = await start(directory);
    prepareNativeFallbackArtifact(directory);
    const fixture = nativeFallbackHostFixture(directory);
    host = await fixture.open(phase => {
      if (phase === 'native-fallback-before-commit') {
        witness!.kill('SIGKILL');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
      }
    });
    const left = await host.allocateRecord(fixture.f.record,
      { value: { tag: 'int', value: '10' } }, { operationId: 'source-left' });
    const before = await host.snapshot(), operationId = 'native-witness-outage';
    await assert.rejects(host.callNativeFallback(left, left,
      { operationId, tokens: fixture.tokens(host) }), /witness|ECONN|socket|connect/i);
    const stopped = witness!;
    if (stopped.exitCode === null && stopped.signalCode === null) await once(stopped, 'exit');
    assert.equal(stopped.signalCode, 'SIGKILL');
    witness = null;
    await assert.rejects(host.snapshot(), /witness|ECONN|socket|connect/i);
    await host.close(); host = null;
    witness = await launchWitness(join(directory, 'witness.json'));
    const fresh = nativeFallbackHostFixture(directory);
    host = await fresh.open();
    assert.equal(runtimeSnapshotDigest(await host.snapshot()), runtimeSnapshotDigest(before));
    assert(host.status().unresolved.includes(operationId));
    const recovered = await host.recoverNativeFallback(operationId,
      { tokens: fresh.tokens(host) });
    assert.equal(recovered.outcome.tier, 2);
    assert.equal(field(await host.snapshot(), left.objectId), '11');
  } finally { await host?.close(); await kill(witness); rmSync(directory, { recursive: true, force: true }); }
});

test('fresh controller recovers a witnessed native intent after SIGKILL before publication', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'aether-native-fallback-crash-'));
  let witness: ChildProcess | null = null, host: ProcessHost | null = null;
  const groups = new Set<number>();
  try {
    witness = await start(directory);
    prepareNativeFallbackArtifact(directory);
    const fixture = nativeFallbackHostFixture(directory);
    host = await fixture.open();
    const left = await host.allocateRecord(fixture.f.record,
      { value: { tag: 'int', value: '10' } }, { operationId: 'source-left' });
    const before = await host.snapshot();
    writeFileSync(join(directory, 'left.json'), JSON.stringify(left), { mode: 0o600 });
    await host.close(); host = null;
    const marker = join(directory, 'native-crash-marker.json');
    const operationId = 'native-before-commit-crash';
    const fixtureUrl = new URL('./process-native-fallback-host-fixture.ts', import.meta.url).href;
    const crashScript = `
      const {nativeFallbackHostFixture}=await import(${JSON.stringify(fixtureUrl)});
      const {readFileSync,writeFileSync}=await import('node:fs');
      const f=nativeFallbackHostFixture(${JSON.stringify(directory)});
      const host=await f.open(phase=>{
        if(phase==='native-fallback-before-commit'){
          const journal=JSON.parse(readFileSync(${JSON.stringify(join(directory, 'host', 'host.json'))},'utf8'));
          writeFileSync(${JSON.stringify(marker)},JSON.stringify({
            phase,state:journal.nativeFallbacks[0].state,
            result:journal.nativeFallbacks[0].result}));
          process.kill(process.pid,'SIGKILL');
        }
      });
      const left=JSON.parse(readFileSync(${JSON.stringify(join(directory, 'left.json'))},'utf8'));
      await host.callNativeFallback(left,left,{
        operationId:${JSON.stringify(operationId)},tokens:f.tokens(host)});
      throw new Error('native controller passed its expected SIGKILL');`;
    const crashed = await runController(crashScript);
    if (crashed.pid) groups.add(crashed.pid);
    assert.equal(crashed.signal, 'SIGKILL', crashed.stderr);
    assert.deepEqual(JSON.parse(readFileSync(marker, 'utf8')),
      { phase: 'native-fallback-before-commit', state: 'running', result: null });
    killGroup(crashed.pid); if (crashed.pid) groups.delete(crashed.pid);

    const fresh = nativeFallbackHostFixture(directory);
    host = await fresh.open();
    assert(host.status().unresolved.includes(operationId));
    assert.equal(runtimeSnapshotDigest(await host.snapshot()), runtimeSnapshotDigest(before));
    const recovered = await host.recoverNativeFallback(operationId,
      { tokens: fresh.tokens(host) });
    assert.equal(recovered.outcome.state, 'completed');
    assert.equal(recovered.outcome.tier, 2);
    assert.equal(field(await host.snapshot(), left.objectId), '11');
    assert.deepEqual(await host.callNativeFallback(left, left,
      { operationId, tokens: fresh.tokens(host) }), recovered);
    const journal = JSON.parse(readFileSync(join(directory, 'host', 'host.json'), 'utf8'));
    assert.equal(journal.nativeFallbacks.length, 1);
    assert.equal(journal.nativeFallbacks[0].state, 'committed');
  } finally {
    for (const pid of groups) killGroup(pid);
    await host?.close(); await kill(witness);
    rmSync(directory, { recursive: true, force: true });
  }
});

test('fresh controller reads the one committed native decision after postcommit SIGKILL', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'aether-native-fallback-postcommit-'));
  let witness: ChildProcess | null = null, host: ProcessHost | null = null;
  const groups = new Set<number>();
  try {
    witness = await start(directory);
    prepareNativeFallbackArtifact(directory);
    const fixture = nativeFallbackHostFixture(directory);
    host = await fixture.open();
    const left = await host.allocateRecord(fixture.f.record,
      { value: { tag: 'int', value: '10' } }, { operationId: 'source-left' });
    writeFileSync(join(directory, 'left.json'), JSON.stringify(left), { mode: 0o600 });
    await host.close(); host = null;
    const marker = join(directory, 'native-postcommit-marker.json');
    const operationId = 'native-postcommit-crash';
    const fixtureUrl = new URL('./process-native-fallback-host-fixture.ts', import.meta.url).href;
    const script = `
      const {nativeFallbackHostFixture}=await import(${JSON.stringify(fixtureUrl)});
      const {readFileSync,writeFileSync}=await import('node:fs');
      const f=nativeFallbackHostFixture(${JSON.stringify(directory)});
      const host=await f.open(phase=>{
        if(phase==='native-fallback-committed'){
          writeFileSync(${JSON.stringify(marker)},JSON.stringify({phase}));
          process.kill(process.pid,'SIGKILL');
        }
      });
      const left=JSON.parse(readFileSync(${JSON.stringify(join(directory, 'left.json'))},'utf8'));
      await host.callNativeFallback(left,left,{
        operationId:${JSON.stringify(operationId)},tokens:f.tokens(host)});
      throw new Error('native controller passed its expected postcommit SIGKILL');`;
    const crashed = await runController(script);
    if (crashed.pid) groups.add(crashed.pid);
    assert.equal(crashed.signal, 'SIGKILL', crashed.stderr);
    assert.deepEqual(JSON.parse(readFileSync(marker, 'utf8')),
      { phase: 'native-fallback-committed' });
    killGroup(crashed.pid); if (crashed.pid) groups.delete(crashed.pid);

    const fresh = nativeFallbackHostFixture(directory);
    host = await fresh.open();
    const tokens = fresh.tokens(host);
    const cached = host.nativeFallbackResult(operationId, tokens);
    assert(cached);
    assert.equal(cached.outcome.tier, 2);
    assert.equal(cached.outcome.state, 'completed');
    assert.equal(field(await host.snapshot(), left.objectId), '11');
    const beforeRetry = JSON.parse(readFileSync(join(directory, 'host', 'host.json'), 'utf8'));
    assert.equal(beforeRetry.nativeFallbacks.length, 1);
    assert.deepEqual(await host.callNativeFallback(left, left,
      { operationId, tokens: fresh.tokens(host) }), cached);
    const afterRetry = JSON.parse(readFileSync(join(directory, 'host', 'host.json'), 'utf8'));
    assert.equal(afterRetry.nativeFallbacks.length, 1);
    assert.equal(afterRetry.heads.length, beforeRetry.heads.length,
      'cached retry cannot append another native state transition');
  } finally {
    for (const pid of groups) killGroup(pid);
    await host?.close(); await kill(witness);
    rmSync(directory, { recursive: true, force: true });
  }
});
