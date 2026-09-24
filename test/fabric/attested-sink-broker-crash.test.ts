import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { encodeCanonical } from '../../src/fabric/encoding.ts';
import { domainDigest } from '../../src/fabric/identity.ts';
import { effectPayloadDigest, type EffectRequestV1 } from '../../src/fabric/effects.ts';
import { createAttestedSinkClient } from '../../src/fabric/attested-sink-service.ts';
import { verifySinkReceipt, type SinkPublicAnchorV1 } from '../../src/fabric/sink-receipt.ts';
import { createProcessWitnessClient } from '../../src/fabric/witness-service.ts';
import { readWitnessHead, selectEffectJournalWitness } from '../../src/fabric/effect-journal-witness.ts';

const root = resolve(import.meta.dirname, '../..');
const sourceUrl = (path: string) => JSON.stringify(new URL(path, import.meta.url).href);
const canonical = (value: unknown) => Buffer.from(encodeCanonical(value)).toString('utf8');
async function launch(script: string, config: string, ready: string): Promise<ChildProcess> {
  const child = spawn(process.execPath, ['--experimental-strip-types', join(root, script), '--config', config],
    { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH ?? '', NODE_NO_WARNINGS: '1' } });
  await new Promise<void>((resolveReady, reject) => {
    let output = '', error = '';
    const timer = setTimeout(() => reject(new Error(`${ready} startup timed out: ${error}`)), 10_000);
    child.stdout!.on('data', chunk => {
      output += String(chunk);
      if (output.includes(ready)) { clearTimeout(timer); resolveReady(); }
    });
    child.stderr!.on('data', chunk => { error += String(chunk).slice(0, 2048); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`${ready} exited ${code}: ${error}`)); });
    child.once('error', reason => { clearTimeout(timer); reject(reason); });
  });
  return child;
}
async function kill(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>(resolveExit => child.once('exit', () => resolveExit()));
  child.kill('SIGKILL'); await exited;
}

function controllerSource(fixtureFile: string): string {
  return `
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { encodeCanonical } from ${sourceUrl('../../src/fabric/encoding.ts')};
import { DurableEffectBroker } from ${sourceUrl('../../src/fabric/effects.ts')};
import { createProcessWitnessClient } from ${sourceUrl('../../src/fabric/witness-service.ts')};
import { selectEffectJournalWitness } from ${sourceUrl('../../src/fabric/effect-journal-witness.ts')};
import { createAttestedSinkClient } from ${sourceUrl('../../src/fabric/attested-sink-service.ts')};
import { createAttestedSinkAdapter } from ${sourceUrl('../../src/fabric/attested-sink-adapter.ts')};

const mode = process.argv[2], f = JSON.parse(readFileSync(${JSON.stringify(fixtureFile)}, 'utf8'));
const witness = createProcessWitnessClient({ socketPath: f.witnessSocket,
  key: readFileSync(f.witnessKeyFile), timeoutMs: 10000 });
const catalog = witness.effectCatalog({ authorityId: 'witness-operator', repositoryId: f.repositoryId,
  deploymentId: f.deploymentId, clockDomain: f.clockDomain });
const head = selectEffectJournalWitness(catalog, 'attested-broker-head');
const client = createAttestedSinkClient({ socketPath: f.sinkSocket, authKey: readFileSync(f.sinkAuthKeyFile),
  anchor: f.anchor, adapterArtifactDigest: f.adapterArtifactDigest,
  repositoryId: f.repositoryId, deploymentId: f.deploymentId, timeoutMs: 10000 });
const adapter = createAttestedSinkAdapter({ id: 'adapter:attested_sink', client,
  repositoryId: f.repositoryId, deploymentId: f.deploymentId,
  approvedAdapterArtifactDigest: f.adapterArtifactDigest, anchor: f.anchor });
const broker = new DurableEffectBroker({ directory: f.brokerDirectory, clockDomain: f.clockDomain,
  clock: () => 100n, authorize: () => true, authorizeReconciliation: () => true, witness: head,
  attestedSink: { anchor: f.anchor, deploymentId: f.deploymentId,
    approvedAdapterArtifactDigest: f.adapterArtifactDigest },
  beforePersist: event => { if (mode === 'crash' && event.state === 'committed') process.kill(process.pid, 'SIGKILL'); } });
if (mode === 'crash') {
  broker.dispatch(f.request, adapter);
  throw new Error('expected controller SIGKILL after sink commit before broker terminal publication');
}
if (mode === 'fenced') {
  const pending = broker.dispatch(f.request, adapter);
  assert.equal(pending.state, 'indeterminate');
  const settled = broker.reconcile(f.request, adapter);
  assert.equal(settled.state, 'aborted');
  assert.equal(broker.inspectRecorded(f.request, adapter)?.state, 'aborted');
  process.stdout.write(JSON.stringify({ pending, settled }) + '\\n');
  process.exit(0);
}
assert.equal(mode, 'recover');
broker.recoverDeadWriter();
const reconciled = broker.reconcile(f.request, adapter);
assert.equal(reconciled.state, 'committed');
const cached = broker.dispatch(f.request, adapter);
assert.equal(Buffer.from(encodeCanonical(cached)).toString('utf8'),
  Buffer.from(encodeCanonical(reconciled)).toString('utf8'));
assert.equal(broker.inspectRecorded(f.request, adapter)?.state, 'committed');
process.stdout.write(JSON.stringify({ reconciled, cached }) + '\\n');
`;
}

test('signed sink receipt reconciles a real postcommit controller SIGKILL without another external decision', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'aether-attested-broker-'));
  let witnessService: ChildProcess | undefined, sinkService: ChildProcess | undefined;
  try {
    const repositoryId = 'attested-repository', deploymentId = 'attested-deployment',
      clockDomain = 'attested-clock/1';
    const witnessSocket = join(directory, 'w.sock'), sinkSocket = join(directory, 's.sock');
    const witnessKeyFile = join(directory, 'w.key'), sinkAuthKeyFile = join(directory, 's.key');
    const sinkSignerFile = join(directory, 's.pem'), witnessConfig = join(directory, 'w.json'),
      sinkConfig = join(directory, 's.json');
    writeFileSync(witnessKeyFile, randomBytes(32), { mode: 0o600 });
    writeFileSync(sinkAuthKeyFile, randomBytes(32), { mode: 0o600 });
    const keys = generateKeyPairSync('ed25519');
    writeFileSync(sinkSignerFile, keys.privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
    const anchor: SinkPublicAnchorV1 = { format: 'aether.sink-anchor/1', repositoryId,
      sinkAuthorityId: 'sink-operator', sinkId: 'append-fixture', keyId: 'sink-key-1', keyEpoch: '0',
      publicKey: keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64') };
    const adapterArtifactDigest = domainDigest('aether.effect-adapter-artifact/1', { fixture: 'append-once' });
    writeFileSync(witnessConfig, encodeCanonical({ socketPath: witnessSocket,
      storageDir: join(directory, 'witness-store'), keyFile: witnessKeyFile,
      namespaces: [{ kind: 'effect-scope', authorityId: 'witness-operator', repositoryId,
        catalogDeploymentId: deploymentId, clockDomain }] }), { mode: 0o600 });
    writeFileSync(sinkConfig, encodeCanonical({ socketPath: sinkSocket,
      storageDir: join(directory, 'sink-store'), authKeyFile: sinkAuthKeyFile,
      signingKeyFile: sinkSignerFile, anchor, adapterArtifactDigest }), { mode: 0o600 });
    witnessService = await launch('src/fabric/witness-service-cli.ts', witnessConfig, 'witness service ready');
    sinkService = await launch('src/fabric/attested-sink-service-cli.ts', sinkConfig, 'attested sink service ready');
    const payload = { tag: 'sequence' as const,
      items: [{ tag: 'string' as const, value: 'append-once' }, { tag: 'int' as const, value: '7' }] };
    const request: EffectRequestV1 = { format: 'aether.effect/1', executionId: 'attested-execution',
      effectId: 'append-1', branchId: null, executionManifest: domainDigest('aether.execution/1', 'attested'),
      capabilityGrantRef: 'grant:attested', policyEpoch: '0', payload,
      payloadDigest: effectPayloadDigest(payload), budgetReservationId: null, deadline: '1000' };
    const fixtureFile = join(directory, 'controller.json'), controllerFile = join(directory, 'controller.ts');
    writeFileSync(fixtureFile, encodeCanonical({ repositoryId, deploymentId, clockDomain, witnessSocket,
      sinkSocket, witnessKeyFile, sinkAuthKeyFile, anchor, adapterArtifactDigest,
      brokerDirectory: join(directory, 'broker'), request }), { mode: 0o600 });
    writeFileSync(controllerFile, controllerSource(fixtureFile));
    const run = (mode: string) => spawnSync(process.execPath,
      ['--experimental-strip-types', controllerFile, mode],
      { cwd: root, encoding: 'utf8', timeout: 90_000, env: { PATH: process.env.PATH ?? '', NODE_NO_WARNINGS: '1' } });
    const crashed = run('crash');
    assert.equal(crashed.signal, 'SIGKILL', crashed.stderr || crashed.error?.message);
    const sinkClient = createAttestedSinkClient({ socketPath: sinkSocket,
      authKey: readFileSync(sinkAuthKeyFile), anchor, adapterArtifactDigest,
      repositoryId, deploymentId, timeoutMs: 10_000 });
    const committed = sinkClient.status(request);
    assert.equal(committed.state, 'committed');
    if (committed.state !== 'committed') throw new Error('sink did not retain the committed decision');
    assert.equal(verifySinkReceipt(committed.receipt, anchor, { repositoryId, deploymentId, request,
      sinkAuthorityId: anchor.sinkAuthorityId, sinkId: anchor.sinkId,
      adapterArtifactDigest, disposition: 'committed', value: committed.value }), true);
    const operator = createProcessWitnessClient({ socketPath: witnessSocket,
      key: readFileSync(witnessKeyFile), timeoutMs: 10_000 });
    const witness = selectEffectJournalWitness(operator.effectCatalog({ authorityId: 'witness-operator',
      repositoryId, deploymentId, clockDomain }), 'attested-broker-head');
    const before = readWitnessHead(witness);
    assert.ok(before.journal);
    const priorEvent = JSON.parse(before.journal).records[0];
    assert.equal(priorEvent.dispatchStarted, true);
    assert.equal(priorEvent.state, 'prepared');
    assert.equal(priorEvent.signedSinkReceipt, null);
    const recovered = run('recover');
    assert.equal(recovered.status, 0, recovered.stderr || recovered.error?.message);
    const result = JSON.parse(recovered.stdout.trim().split('\n').at(-1)!);
    assert.equal(result.reconciled.state, 'committed');
    assert.deepEqual(result.cached, result.reconciled);
    const after = readWitnessHead(witness), terminal = JSON.parse(after.journal!).records[0];
    assert.equal(terminal.state, 'committed');
    assert.equal(canonical(terminal.signedSinkReceipt), canonical(committed.receipt));
    const sinkState = JSON.parse(readFileSync(join(directory, 'sink-store', 'sink-state.json'), 'utf8'));
    assert.equal(sinkState.decisions.length, 1);
    assert.equal(canonical(sinkState.decisions[0].receipt), canonical(committed.receipt));

    const fencedRequest: EffectRequestV1 = { ...request, effectId: 'append-2' };
    const fence = sinkClient.status(fencedRequest);
    assert.equal(fence.state, 'not_committed');
    if (fence.state !== 'not_committed') throw new Error('sink did not retain a terminal fence');
    assert.equal(verifySinkReceipt(fence.receipt, anchor, { repositoryId, deploymentId,
      request: fencedRequest, sinkAuthorityId: anchor.sinkAuthorityId, sinkId: anchor.sinkId,
      adapterArtifactDigest, disposition: 'not_committed', value: null }), true);
    const currentFixture = JSON.parse(readFileSync(fixtureFile, 'utf8'));
    writeFileSync(fixtureFile, encodeCanonical({ ...currentFixture, request: fencedRequest }));
    const fenced = run('fenced');
    assert.equal(fenced.status, 0, fenced.stderr || fenced.error?.message);
    const fenceOutcome = JSON.parse(fenced.stdout.trim().split('\n').at(-1)!);
    assert.equal(fenceOutcome.pending.state, 'indeterminate');
    assert.equal(fenceOutcome.settled.state, 'aborted');
    const afterFence = JSON.parse(readWitnessHead(witness).journal!);
    assert.equal(afterFence.records.length, 2);
    assert.equal(afterFence.records[1].state, 'aborted');
    assert.equal(canonical(afterFence.records[1].signedSinkReceipt), canonical(fence.receipt));
    const finalSinkState = JSON.parse(readFileSync(join(directory, 'sink-store', 'sink-state.json'), 'utf8'));
    assert.equal(finalSinkState.decisions.length, 2);
    assert.equal(finalSinkState.decisions[1].receipt.body.disposition, 'not_committed');
  } finally {
    if (sinkService) await kill(sinkService); if (witnessService) await kill(witnessService);
    rmSync(directory, { recursive: true, force: true });
  }
});
