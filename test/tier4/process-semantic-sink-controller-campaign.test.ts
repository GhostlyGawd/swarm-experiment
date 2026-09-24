import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { encodeCanonical } from '../../src/fabric/encoding.ts';
import { domainDigest } from '../../src/fabric/identity.ts';
import { createProcessWitnessClient } from '../../src/fabric/witness-service.ts';
import { readDeploymentJournalHead } from '../../src/fabric/deployment-journal-witness.ts';
import { readHostJournalHead, selectHostJournalWitness } from '../../src/fabric/host-journal-witness.ts';
import { readWitnessHead, selectEffectJournalWitness } from '../../src/fabric/effect-journal-witness.ts';
import { readSinkStateHead, type SinkStateHeadV1 } from '../../src/fabric/sink-state-witness.ts';
import type { SinkPublicAnchorV1 } from '../../src/fabric/sink-receipt.ts';

const root = resolve(import.meta.dirname, '../..');
async function launch(script: string, configFile: string, ready: string): Promise<ChildProcess> {
  const child = spawn(process.execPath, ['--experimental-strip-types', join(root, script),
    '--config', configFile], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH ?? '', NODE_NO_WARNINGS: '1' } });
  await new Promise<void>((resolveReady, reject) => {
    let stdout = '', stderr = '';
    const timeout = setTimeout(() => { child.kill('SIGKILL');
      reject(new Error(`${ready} startup timed out: ${stderr}`)); }, 10_000);
    child.stdout!.on('data', chunk => { stdout += String(chunk);
      if (stdout.includes(ready)) { clearTimeout(timeout); resolveReady(); } });
    child.stderr!.on('data', chunk => { stderr += String(chunk).slice(0, 2048); });
    child.once('exit', code => { clearTimeout(timeout);
      reject(new Error(`${ready} exited ${code}: ${stderr}`)); });
    child.once('error', error => { clearTimeout(timeout); reject(error); });
  });
  return child;
}
async function kill(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>(resolveExit => child.once('exit', () => resolveExit()));
  child.kill('SIGKILL'); await exited;
}
function parsed(output: string): Record<string, unknown>[] {
  return output.trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>);
}
function killWorkers(rows: readonly Record<string, unknown>[]): void {
  const pids = new Set<number>();
  for (const row of rows) if (row.workerPids && typeof row.workerPids === 'object')
    for (const value of Object.values(row.workerPids)) if (typeof value === 'number') pids.add(value);
  for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch { /* already reaped */ } }
}

for (const boundary of ['before', 'after'] as const) test(
  `V12 witnessed sink retirement survives controller SIGKILL ${boundary} durable promotion commit`,
  async t => {
    const directory = mkdtempSync(join(tmpdir(), `aether-v12-retirement-${boundary}-`));
    let sink: ChildProcess | undefined, sinkWitnessService: ChildProcess | undefined,
      operatorService: ChildProcess | undefined;
    let orphanRows: Record<string, unknown>[] = [];
    try {
      const repositoryId = 'repo:v12-crash-campaign';
      const deploymentId = 'deployment:v12-crash-campaign';
      const clockDomain = 'clock:v12-crash-campaign';
      const sinkKeys = generateKeyPairSync('ed25519');
      const policyKeys = generateKeyPairSync('ed25519');
      const governorKeys = generateKeyPairSync('ed25519');
      const anchor: SinkPublicAnchorV1 = { format: 'aether.sink-anchor/1',
        repositoryId, sinkAuthorityId: 'authority:v12-crash', sinkId: 'sink:v12-crash',
        keyId: 'key:v12-crash', keyEpoch: '1',
        publicKey: sinkKeys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64') };
      const adapterArtifactDigest = domainDigest('aether.effect-adapter-artifact/2', 'v12-crash-campaign');
      const sinkSocket = join(directory, 'sink.sock'), sinkWitnessSocket = join(directory, 'sw.sock'),
        operatorSocket = join(directory, 'op.sock');
      const sinkAuthKeyFile = join(directory, 'sink.key'), sinkWitnessKeyFile = join(directory, 'sw.key'),
        operatorKeyFile = join(directory, 'op.key'), grantKeyFile = join(directory, 'grant.key'),
        sealerKeyFile = join(directory, 'sealer.key');
      const sinkSignerKeyFile = join(directory, 'sink.pem'),
        policySignerKeyFile = join(directory, 'policy.pem'),
        governorKeyFile = join(directory, 'governor.pem'), epochFile = join(directory, 'epoch.txt');
      for (const path of [sinkAuthKeyFile, sinkWitnessKeyFile, operatorKeyFile,
        grantKeyFile, sealerKeyFile]) writeFileSync(path, randomBytes(32), { mode: 0o600 });
      writeFileSync(sinkSignerKeyFile, sinkKeys.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
      writeFileSync(policySignerKeyFile, policyKeys.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
      writeFileSync(governorKeyFile, governorKeys.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
      writeFileSync(epochFile, '1', { mode: 0o600 });
      const sinkWitnessConfig = join(directory, 'sw.json'), operatorConfig = join(directory, 'op.json'),
        sinkConfig = join(directory, 'sink.json');
      writeFileSync(sinkWitnessConfig, encodeCanonical({ socketPath: sinkWitnessSocket,
        storageDir: join(directory, 'sink-witness-store'), keyFile: sinkWitnessKeyFile,
        namespaces: [{ kind: 'sink-scope', authorityId: 'operator:v12-sink',
          anchor, adapterArtifactDigest }] }), { mode: 0o600 });
      writeFileSync(operatorConfig, encodeCanonical({ socketPath: operatorSocket,
        storageDir: join(directory, 'operator-store'), keyFile: operatorKeyFile,
        namespaces: [
          { kind: 'effect-scope', authorityId: 'operator:v12-effects', repositoryId,
            catalogDeploymentId: deploymentId, clockDomain },
          { kind: 'host-scope', authorityId: 'operator:v12-hosts', repositoryId, deploymentId },
          { kind: 'deployment', authorityId: 'operator:v12-deployment', repositoryId, deploymentId },
        ] }), { mode: 0o600 });
      writeFileSync(sinkConfig, encodeCanonical({ format: 'aether.attested-sink-config/2',
        socketPath: sinkSocket, storageDir: join(directory, 'sink-store'),
        authKeyFile: sinkAuthKeyFile, signingKeyFile: sinkSignerKeyFile,
        anchor, adapterArtifactDigest, witnessSocketPath: sinkWitnessSocket,
        witnessKeyFile: sinkWitnessKeyFile, witnessAuthorityId: 'operator:v12-sink' }), { mode: 0o600 });
      sinkWitnessService = await launch('src/fabric/witness-service-cli.ts', sinkWitnessConfig,
        'witness service ready');
      operatorService = await launch('src/fabric/witness-service-cli.ts', operatorConfig,
        'witness service ready');
      sink = await launch('src/fabric/attested-sink-service-cli.ts', sinkConfig,
        'attested sink service ready');
      assert.equal(new Set([sink.pid, sinkWitnessService.pid, operatorService.pid]).size, 3);
      const inputFile = join(directory, 'controller.json');
      writeFileSync(inputFile, encodeCanonical({ directory, repositoryId, deploymentId,
        clockDomain, anchor, adapterArtifactDigest, sinkSocket, sinkAuthKeyFile,
        sinkWitnessSocket, sinkWitnessKeyFile, operatorSocket, operatorKeyFile,
        policySignerKeyFile, governorKeyFile, grantKeyFile, sealerKeyFile, epochFile }),
      { mode: 0o600 });
      const run = (mode: string) => spawnSync(process.execPath,
        ['--experimental-strip-types', join(root,
          'test/tier4/process-semantic-sink-controller-campaign.ts'), inputFile, mode],
        { cwd: root, encoding: 'utf8', timeout: 120_000,
          env: { PATH: process.env.PATH ?? '', NODE_NO_WARNINGS: '1' } });
      const initialized = run('init');
      assert.equal(initialized.status, 0, initialized.stderr || initialized.error?.message);
      const initial = parsed(initialized.stdout).at(-1)!;
      assert.equal(initial.mode, 'init');
      assert.equal((initial.old as { state: string }).state, 'completed');
      const workerPids = Object.values(initial.workerPids as Record<string, number>);
      assert.equal(workerPids.length, 1, 'one real ProcessHost worker served the old effect');
      assert.ok(workerPids[0]! > 0 && workerPids[0] !== initial.pid);
      const sinkWitness = createProcessWitnessClient({ socketPath: sinkWitnessSocket,
        key: readFileSync(sinkWitnessKeyFile), timeoutMs: 10_000 }).sinkStateWitness({
          authorityId: 'operator:v12-sink', anchor, adapterArtifactDigest });
      const oldSinkHead: SinkStateHeadV1 = readSinkStateHead(sinkWitness);
      assert.equal(oldSinkHead.revision, '1');
      assert.equal(JSON.parse(oldSinkHead.journal!).decisions.length, 1);
      const operator = createProcessWitnessClient({ socketPath: operatorSocket,
        key: readFileSync(operatorKeyFile), timeoutMs: 10_000 });
      const hostCatalog = operator.hostCatalog({ authorityId: 'operator:v12-hosts',
        repositoryId, deploymentId });
      const effectCatalog = operator.effectCatalog({ authorityId: 'operator:v12-effects',
        repositoryId, deploymentId, clockDomain });
      const genesisHostHead = readHostJournalHead(selectHostJournalWitness(hostCatalog, 'genesis'));
      assert.ok(BigInt(genesisHostHead.revision) > 0n);
      const hostJournal = JSON.parse(genesisHostHead.journal!);
      const oldEffectId = hostJournal.calls.find((row: { operationId: string }) =>
        row.operationId === 'old-v12').effects[0].id as string;
      const oldEffectHead = readWitnessHead(selectEffectJournalWitness(effectCatalog, oldEffectId));
      assert.ok(BigInt(oldEffectHead.revision) > 0n);
      assert.equal(JSON.parse(oldEffectHead.journal!).records[0].state, 'committed');
      writeFileSync(epochFile, '2', { mode: 0o600 });
      const crashed = run(boundary === 'before' ? 'crash-before' : 'crash-after');
      assert.equal(crashed.signal, 'SIGKILL', crashed.stderr || crashed.error?.message);
      orphanRows = parsed(crashed.stdout);
      assert.ok(orphanRows.some(row => row.event === 'prepared'),
        'a real candidate worker was prepared before the controller died');
      killWorkers(orphanRows);
      const coordinator = JSON.parse(readFileSync(join(directory, 'coordinator', 'production.json'), 'utf8'));
      assert.equal(coordinator.records.at(-1).phase, boundary === 'before' ? 'prepared' : 'active');
      const recovered = run(boundary === 'before' ? 'recover-before' : 'recover-after');
      assert.equal(recovered.status, 0, recovered.stderr || recovered.error?.message);
      const result = parsed(recovered.stdout).at(-1)!;
      assert.notEqual(result.pid, crashed.pid);
      assert.deepEqual(result.old, initial.old,
        'fresh controller must recover the exact predecessor receipt');
      assert.deepEqual(readWitnessHead(selectEffectJournalWitness(effectCatalog, oldEffectId)),
        oldEffectHead, 'historical receipt inspection must not rewrite effect custody');
      assert.equal((result.settled as { generation: string }).generation,
        boundary === 'before' ? '0' : '1');
      if (boundary === 'after') {
        assert.equal((result.fresh as { state: string }).state, 'completed');
        assert.equal(readSinkStateHead(sinkWitness).revision, '2',
          'only the new postretirement invocation may append a second sink decision');
      } else {
        assert.equal(result.fresh, null);
        assert.deepEqual(readSinkStateHead(sinkWitness), oldSinkHead,
          'aborted promotion and historical receipt cannot redispatch');
      }
      const deploymentWitness = operator.deploymentWitness({
        authorityId: 'operator:v12-deployment', repositoryId, deploymentId });
      const head = readDeploymentJournalHead(deploymentWitness);
      assert.ok(BigInt(head.revision) > 0n);
      await kill(operatorService); operatorService = undefined;
      const outage = run('inspect');
      assert.notEqual(outage.status, 0,
        'fresh controller must refuse to read/serve without operator witness custody');
      assert.match(outage.stderr, /connect|witness|socket|ECONNREFUSED/i);
      operatorService = await launch('src/fabric/witness-service-cli.ts', operatorConfig,
        'witness service ready');
      const afterRestart = run('inspect');
      assert.equal(afterRestart.status, 0, afterRestart.stderr || afterRestart.error?.message);
      assert.deepEqual(parsed(afterRestart.stdout).at(-1)!.old, initial.old);
      const localStateFile = join(directory, 'deployment', 'deployment.json');
      const validLocal = readFileSync(localStateFile);
      const forged = JSON.parse(validLocal.toString()) as Record<string, unknown>;
      forged.activeSinkTableDigest = domainDigest('aether.declarative-adapter-table/2',
        'forged-local-rollback');
      writeFileSync(localStateFile, encodeCanonical(forged));
      const rollback = run('inspect');
      assert.notEqual(rollback.status, 0,
        'same-revision local table rollback must be refused against external witness');
      assert.match(rollback.stderr, /diverges from operator witness/);
      writeFileSync(localStateFile, validLocal);
      const restored = run('inspect');
      assert.equal(restored.status, 0, restored.stderr || restored.error?.message);
      assert.deepEqual(parsed(restored.stdout).at(-1)!.old, initial.old);
      t.diagnostic(JSON.stringify({ boundary, controllerCrash: crashed.signal,
        services: [sink.pid, sinkWitnessService.pid, operatorService.pid],
        candidateWorkerPids: orphanRows.flatMap(row => Object.values(
          (row.workerPids ?? {}) as Record<string, number>)),
        deploymentWitnessRevision: head.revision,
        sinkRevision: readSinkStateHead(sinkWitness).revision }));
    } finally {
      killWorkers(orphanRows);
      await kill(sink); await kill(sinkWitnessService); await kill(operatorService);
      rmSync(directory, { recursive: true, force: true });
    }
  });
