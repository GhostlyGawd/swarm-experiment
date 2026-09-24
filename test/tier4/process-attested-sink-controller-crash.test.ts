import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { encodeCanonical } from '../../src/fabric/encoding.ts';
import { domainDigest } from '../../src/fabric/identity.ts';
import { createProcessWitnessClient } from '../../src/fabric/witness-service.ts';
import { createAttestedSinkClient } from '../../src/fabric/attested-sink-service.ts';
import { readSinkStateHead } from '../../src/fabric/sink-state-witness.ts';
import { readWitnessHead, selectEffectJournalWitness } from '../../src/fabric/effect-journal-witness.ts';
import { verifySinkReceipt, type SinkPublicAnchorV1 } from '../../src/fabric/sink-receipt.ts';
import type { EffectRequestV1 } from '../../src/fabric/effects.ts';

const root = resolve(import.meta.dirname, '../..');
async function launch(script: string, configFile: string, ready: string): Promise<ChildProcess> {
  const child = spawn(process.execPath, ['--experimental-strip-types', join(root, script),
    '--config', configFile], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH ?? '', NODE_NO_WARNINGS: '1' } });
  await new Promise<void>((resolveReady, reject) => {
    let stdout = '', stderr = '';
    const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`${ready} timed out: ${stderr}`)); }, 10_000);
    child.stdout!.on('data', chunk => {
      stdout += String(chunk);
      if (stdout.includes(ready)) { clearTimeout(timeout); resolveReady(); }
    });
    child.stderr!.on('data', chunk => { stderr += String(chunk).slice(0, 2048); });
    child.once('exit', code => { clearTimeout(timeout); reject(new Error(`${ready} exited ${code}: ${stderr}`)); });
    child.once('error', error => { clearTimeout(timeout); reject(error); });
  });
  return child;
}
async function kill(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>(resolveExit => child.once('exit', () => resolveExit()));
  child.kill('SIGKILL'); await exited;
}

// Three long-lived service processes survive both short-lived controller processes.
// This exercises the service boundary under one UID; separate-user custody is a
// distinct acceptance gate.
for (const scenario of ['postcommit', 'pre-sink', 'signed-fence', 'v11-resource-postcommit',
  'v11-revoked-postcommit', 'v11-resource-pre-sink', 'v11-resource-signed-fence',
  'v11-target-revoked-fence'] as const) test(
  `${scenario.startsWith('v11-') ? 'V11' : 'V10'} Deployment ${scenario} recovery across real controller SIGKILL`, async t => {
  const resourceScoped = scenario.startsWith('v11-');
  const revokedRecovery = scenario === 'v11-revoked-postcommit';
  const targetRevokedRecovery = scenario === 'v11-target-revoked-fence';
  const postcommit = scenario === 'postcommit' || scenario === 'v11-resource-postcommit'
    || revokedRecovery;
  const preSink = scenario === 'pre-sink' || scenario === 'v11-resource-pre-sink';
  const signedFence = scenario === 'signed-fence' || scenario === 'v11-resource-signed-fence'
    || targetRevokedRecovery;
  const operationId = resourceScoped ? 'v11-resource-crash' : 'v10-crash';
  const target = resourceScoped ? 'alice' : 'append-once';
  const directory = mkdtempSync(join(tmpdir(), 'aether-v10-crash-'));
  let sink: ChildProcess | undefined, sinkWitnessProcess: ChildProcess | undefined,
    operatorWitnessProcess: ChildProcess | undefined;
  try {
    const repositoryId = resourceScoped ? 'repo:v11-resource-crash' : 'repo:v10-crash';
    const deploymentId = resourceScoped ? 'deployment:v11-resource-crash' : 'deployment:v10-crash';
    const clockDomain = resourceScoped ? 'clock:v11-resource-crash' : 'clock:v10-crash';
    const sinkKeys = generateKeyPairSync('ed25519');
    const policyKeys = generateKeyPairSync('ed25519');
    const governorKeys = generateKeyPairSync('ed25519');
    const anchor: SinkPublicAnchorV1 = { format: 'aether.sink-anchor/1', repositoryId,
      sinkAuthorityId: 'authority:v10-crash', sinkId: 'sink:v10-crash',
      keyId: 'key:v10-crash', keyEpoch: '0',
      publicKey: sinkKeys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64') };
    const adapterArtifactDigest = domainDigest('aether.effect-adapter-artifact/2', 'v10-crash-fixture');
    const sinkSocket = join(directory, 'sink.sock'), sinkWitnessSocket = join(directory, 'sw.sock'),
      operatorSocket = join(directory, 'op.sock');
    const sinkAuthKeyFile = join(directory, 'sink.key'), sinkWitnessKeyFile = join(directory, 'sw.key'),
      operatorKeyFile = join(directory, 'op.key');
    const sinkSignerKeyFile = join(directory, 'sink.pem'), policySignerKeyFile = join(directory, 'policy.pem'),
      governorKeyFile = join(directory, 'governor.pem'), grantKeyFile = join(directory, 'grant.key'),
      sealerKeyFile = join(directory, 'sealer.key');
    for (const path of [sinkAuthKeyFile, sinkWitnessKeyFile, operatorKeyFile,
      grantKeyFile, sealerKeyFile]) writeFileSync(path, randomBytes(32), { mode: 0o600 });
    writeFileSync(sinkSignerKeyFile, sinkKeys.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    writeFileSync(policySignerKeyFile, policyKeys.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    writeFileSync(governorKeyFile, governorKeys.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    const sinkWitnessConfig = join(directory, 'sw.json'), operatorConfig = join(directory, 'op.json'),
      sinkConfig = join(directory, 'sink.json');
    writeFileSync(sinkWitnessConfig, encodeCanonical({ socketPath: sinkWitnessSocket,
      storageDir: join(directory, 'sink-witness-store'), keyFile: sinkWitnessKeyFile,
      namespaces: [{ kind: 'sink-scope', authorityId: 'operator:sink', anchor, adapterArtifactDigest }] }), { mode: 0o600 });
    writeFileSync(operatorConfig, encodeCanonical({ socketPath: operatorSocket,
      storageDir: join(directory, 'operator-store'), keyFile: operatorKeyFile,
      namespaces: [
        { kind: 'effect-scope', authorityId: 'operator:effects', repositoryId,
          catalogDeploymentId: deploymentId, clockDomain },
        { kind: 'host-scope', authorityId: 'operator:host', repositoryId, deploymentId },
        { kind: 'deployment', authorityId: resourceScoped
          ? 'operator:deployment-v11' : 'operator:deployment', repositoryId, deploymentId },
      ] }), { mode: 0o600 });
    writeFileSync(sinkConfig, encodeCanonical({ format: 'aether.attested-sink-config/2',
      socketPath: sinkSocket, storageDir: join(directory, 'sink-store'), authKeyFile: sinkAuthKeyFile,
      signingKeyFile: sinkSignerKeyFile, anchor, adapterArtifactDigest,
      witnessSocketPath: sinkWitnessSocket, witnessKeyFile: sinkWitnessKeyFile,
      witnessAuthorityId: 'operator:sink' }), { mode: 0o600 });
    sinkWitnessProcess = await launch('src/fabric/witness-service-cli.ts', sinkWitnessConfig, 'witness service ready');
    operatorWitnessProcess = await launch('src/fabric/witness-service-cli.ts', operatorConfig, 'witness service ready');
    sink = await launch('src/fabric/attested-sink-service-cli.ts', sinkConfig, 'attested sink service ready');
    assert.equal(new Set([sink.pid, sinkWitnessProcess.pid, operatorWitnessProcess.pid]).size, 3);
    const fixtureFile = join(directory, 'controller.json');
    writeFileSync(fixtureFile, encodeCanonical({ directory, repositoryId, deploymentId, clockDomain,
      anchor, adapterArtifactDigest, sinkSocket, sinkAuthKeyFile, sinkWitnessSocket,
      sinkWitnessKeyFile, operatorSocket, operatorKeyFile, policySignerKeyFile,
      grantKeyFile, sealerKeyFile, governorKeyFile, resourceScoped,
      broadTargetGrant: targetRevokedRecovery }), { mode: 0o600 });
    const controllerFile = join(root, 'test/tier4/process-attested-sink-controller.ts');
    const run = (mode: 'crash' | 'recover' | 'crash-pre-sink' | 'recover-abort'
      | 'crash-before-sink-entry' | 'recover-fenced' | 'recover-revoked'
      | 'recover-target-revoked-fence' | 'probe-abort-before-fence') => spawnSync(process.execPath,
      ['--experimental-strip-types', controllerFile, fixtureFile, mode],
      { cwd: root, encoding: 'utf8', timeout: 90_000,
        env: { PATH: process.env.PATH ?? '', NODE_NO_WARNINGS: '1' } });
    const crashed = run(postcommit ? 'crash'
      : preSink ? 'crash-pre-sink' : 'crash-before-sink-entry');
    assert.equal(crashed.signal, 'SIGKILL', crashed.stderr || crashed.error?.message);
    const ready = JSON.parse(crashed.stdout.trim().split('\n').find(line => line.includes('worker-ready'))!);
    const workerPids = Object.values(ready.workerPids) as number[];
    assert.equal(workerPids.length, 1, 'one real process worker served the deployment');
    assert.ok(workerPids[0] > 0 && workerPids[0] !== ready.controllerPid);
    assert.ok(![sink.pid, sinkWitnessProcess.pid, operatorWitnessProcess.pid].includes(workerPids[0]));
    const sinkWitness = createProcessWitnessClient({ socketPath: sinkWitnessSocket,
      key: readFileSync(sinkWitnessKeyFile), timeoutMs: 10_000 }).sinkStateWitness({
        authorityId: 'operator:sink', anchor, adapterArtifactDigest });
    let sinkHeadBefore = readSinkStateHead(sinkWitness);
    assert.equal(sinkHeadBefore.revision, postcommit ? '1' : '0');
    if (postcommit) {
      const sinkJournalBefore = JSON.parse(sinkHeadBefore.journal!);
      assert.equal(sinkJournalBefore.decisions.length, 1);
      assert.equal(sinkJournalBefore.decisions[0].receipt.body.disposition, 'committed');
    } else assert.equal(sinkHeadBefore.journal, null, 'the sink was never entered');
    const operator = createProcessWitnessClient({ socketPath: operatorSocket,
      key: readFileSync(operatorKeyFile), timeoutMs: 10_000 });
    const effectCatalog = operator.effectCatalog({ authorityId: 'operator:effects',
      repositoryId, deploymentId, clockDomain });
    const hostJournal = JSON.parse(readFileSync(join(directory, 'deployment', 'deployments',
      'genesis', 'host', 'host.json'), 'utf8'));
    const hostCall = hostJournal.calls.find((row: { operationId: string }) => row.operationId === operationId);
    const hostEffect = hostCall.effects[0];
    if (resourceScoped) {
      assert.equal(hostJournal.configuration.split(':')[0], 'aether.process-host-config/9');
      assert.equal(hostCall.args[0].value, target, 'the host retained the exact target argument');
      assert.equal(hostEffect.args[0].value, target,
        'the effect row retained the selected resource argument even before broker dispatch');
    }
    const effectId = hostEffect.id as string;
    const effectWitness = selectEffectJournalWitness(effectCatalog, effectId);
    const effectHeadBefore = readWitnessHead(effectWitness);
    if (preSink) {
      assert.equal(hostEffect.state, 'requested');
      assert.equal(effectHeadBefore.revision, '0', 'broker dispatch never began');
      assert.equal(effectHeadBefore.journal, null);
    } else {
      const event = JSON.parse(effectHeadBefore.journal!).records[0];
      assert.equal(event.state, 'prepared');
      assert.equal(event.dispatchStarted, true);
      if (resourceScoped) {
        assert.equal(event.request.capabilityGrantRef,
          domainDigest('aether.process-effect-grant-ref/2', {
            configuration: hostJournal.configuration, operationId: effectId,
            capability: hostEffect.capability, policyEpoch: '0',
            resourcePathDigest: domainDigest('aether.process-effect-resource-path/1', [
              'process', hostJournal.configuration.split(':').at(-1), hostCall.generation,
              domainDigest('aether.process-grant-unit/1', hostCall.unit).split(':').at(-1),
              'account', target,
            ]),
          }), 'the signed request binds the selected Alice resource path');
        assert.match(event.request.capabilityGrantRef, /^aether\.process-effect-grant-ref\/2:b3:/);
      }
      if (signedFence) {
        const probe = run('probe-abort-before-fence');
        assert.equal(probe.status, 0, probe.stderr || probe.error?.message);
        assert.equal(JSON.parse(probe.stdout.trim().split('\n').at(-1)!).abortDenied, true);
        assert.deepEqual(readSinkStateHead(sinkWitness), sinkHeadBefore,
          'the failed abort must not create a sink decision before status establishes a fence');
        assert.deepEqual(readWitnessHead(effectWitness), effectHeadBefore,
          'the failed abort must not change the witnessed broker preparation');
        const request = event.request as EffectRequestV1;
        const sinkClient = createAttestedSinkClient({ socketPath: sinkSocket,
          authKey: readFileSync(sinkAuthKeyFile), anchor, adapterArtifactDigest,
          repositoryId, deploymentId, timeoutMs: 10_000 });
        const fence = sinkClient.status(request);
        assert.equal(fence.state, 'not_committed');
        if (fence.state !== 'not_committed') throw new Error('sink status did not establish a terminal fence');
        assert.equal(verifySinkReceipt(fence.receipt, anchor, { repositoryId, deploymentId,
          request, sinkAuthorityId: anchor.sinkAuthorityId, sinkId: anchor.sinkId,
          adapterArtifactDigest, disposition: 'not_committed', value: null }), true);
        assert.throws(() => sinkClient.execute(request), /sink FENCED/,
          'the signed fence permanently prevents a late dispatch');
        sinkHeadBefore = readSinkStateHead(sinkWitness);
        assert.equal(sinkHeadBefore.revision, '1');
        const sinkJournal = JSON.parse(sinkHeadBefore.journal!);
        assert.equal(sinkJournal.decisions.length, 1);
        assert.equal(sinkJournal.decisions[0].receipt.body.disposition, 'not_committed');
      }
    }
    if (revokedRecovery || targetRevokedRecovery) writeFileSync(fixtureFile, encodeCanonical({
      ...JSON.parse(readFileSync(fixtureFile, 'utf8')),
      ...(targetRevokedRecovery ? { targetRevoked: true } : { revoked: true }),
    }), { mode: 0o600 });
    const recovered = run(revokedRecovery ? 'recover-revoked'
      : targetRevokedRecovery ? 'recover-target-revoked-fence'
        : postcommit ? 'recover' : preSink ? 'recover-abort' : 'recover-fenced');
    assert.equal(recovered.status, 0, recovered.stderr || recovered.error?.message);
    const result = JSON.parse(recovered.stdout.trim().split('\n').at(-1)!);
    assert.notEqual(result.pid, crashed.pid);
    assert.equal(result.recovered.state, preSink ? 'aborted' : 'completed');
    if (signedFence) assert.equal(result.recovered.execution.ok, false);
    if (resourceScoped) {
      if (preSink) assert.equal(result.recovered.reason,
        'authorized abort before any possible external effect commit');
      else if (postcommit) {
        assert.equal(result.recovered.execution.ok, true);
        assert.equal(result.recovered.execution.value.value, target);
      }
      assert.equal(JSON.parse(readFileSync(join(directory, 'deployment', 'deployment.json'), 'utf8')).format,
        'aether.process-deployment/11');
    }
    if (revokedRecovery) assert.equal(result.revoked, true);
    else if (targetRevokedRecovery) {
      assert.equal(result.targetRevoked, true);
      assert.equal(result.cachedDenied, true);
    }
    else assert.deepEqual(result.cached, result.recovered);
    assert.deepEqual(readSinkStateHead(sinkWitness), sinkHeadBefore,
      'recovery must not append or redispatch a sink decision');
    const effectHeadAfter = readWitnessHead(effectWitness);
    if (preSink) assert.deepEqual(effectHeadAfter, effectHeadBefore);
    else assert.equal(JSON.parse(effectHeadAfter.journal!).records[0].state,
      postcommit ? 'committed' : 'aborted');
    if (!preSink) assert.equal(JSON.parse(readFileSync(join(directory,
      'sink-store', 'sink-state-v2.json'), 'utf8')).decisions.length, 1);
    t.diagnostic(JSON.stringify({ crashSignal: crashed.signal, controllerPid: result.pid,
      servicePids: [sink.pid, sinkWitnessProcess.pid, operatorWitnessProcess.pid], workerPids,
      sinkRevision: sinkHeadBefore.revision, effectRevisionBefore: effectHeadBefore.revision,
      effectRevisionAfter: effectHeadAfter.revision }));
  } finally {
    await kill(sink); await kill(sinkWitnessProcess); await kill(operatorWitnessProcess);
    rmSync(directory, { recursive: true, force: true });
  }
});
