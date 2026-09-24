import assert from 'node:assert/strict';
import { createHmac, generateKeyPairSync, randomBytes } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as net from 'node:net';
import { test } from 'node:test';
import { createAttestedSinkClient } from '../../src/fabric/attested-sink-service.ts';
import { effectPayloadDigest, type EffectRequestV1 } from '../../src/fabric/effects.ts';
import { encodeCanonical } from '../../src/fabric/encoding.ts';
import { domainDigest } from '../../src/fabric/identity.ts';
import { type SinkPublicAnchorV1 } from '../../src/fabric/sink-receipt.ts';
import { createProcessWitnessClient } from '../../src/fabric/witness-service.ts';
import { readSinkStateHead } from '../../src/fabric/sink-state-witness.ts';

const sourceRoot = path.resolve(import.meta.dirname, '../..');
function privateFile(file: string, value: unknown): void {
  fs.writeFileSync(file, value instanceof Uint8Array || typeof value === 'string'
    ? value : encodeCanonical(value), { mode: 0o600 });
}
function request(effectId: string): EffectRequestV1 {
  const payload = { tag: 'string' as const, value: `entry:${effectId}` };
  return { format: 'aether.effect/1', executionId: 'execution:witnessed', effectId,
    branchId: null, executionManifest: domainDigest('aether.execution/1', 'witnessed-fixture'),
    capabilityGrantRef: 'grant:1', policyEpoch: '1', payloadDigest: effectPayloadDigest(payload),
    payload, budgetReservationId: null, deadline: '9000000000000' };
}
async function launch(script: string, config: string, ready: string): Promise<ChildProcess> {
  const child = spawn(process.execPath, ['--experimental-strip-types',
    path.join(sourceRoot, 'src/fabric', script), '--config', config],
  { cwd: sourceRoot, stdio: ['ignore', 'pipe', 'pipe'] });
  return new Promise((resolve, reject) => {
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL'); reject(new Error(`${script} startup timeout: ${stderr}`));
    }, 8000);
    child.stderr!.on('data', chunk => { stderr += chunk.toString(); });
    child.stdout!.on('data', chunk => {
      if (chunk.toString().includes(ready)) { clearTimeout(timer); resolve(child); }
    });
    child.once('exit', code => {
      clearTimeout(timer); reject(new Error(`${script} exited ${code}: ${stderr}`));
    });
  });
}
async function kill(child: ChildProcess | null): Promise<void> {
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL'); await once(child, 'exit');
  }
}
async function rejectedStart(script: string, config: string): Promise<string> {
  const child = spawn(process.execPath, ['--experimental-strip-types',
    path.join(sourceRoot, 'src/fabric', script), '--config', config],
  { cwd: sourceRoot, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr!.on('data', chunk => { stderr += chunk.toString(); });
  const [code] = await once(child, 'exit') as [number | null];
  assert.equal(code, 1);
  return stderr;
}
async function rawWitnessAdvance(socketPath: string, key: Buffer, identity: unknown,
  revision: string, journal: string): Promise<Record<string, unknown>> {
  const body = { format: 'aether.witness-service/1', nonce: randomBytes(32).toString('hex'),
    op: 'advance', identity, expectedRevision: revision, journal };
  const bytes = Buffer.from(encodeCanonical({ ...body,
    mac: createHmac('sha256', key).update(encodeCanonical(body)).digest('hex') }));
  const prefix = Buffer.alloc(4); prefix.writeUInt32BE(bytes.length);
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    const chunks: Buffer[] = [];
    socket.once('connect', () => socket.end(Buffer.concat([prefix, bytes])));
    socket.on('data', chunk => chunks.push(chunk));
    socket.once('error', reject);
    socket.once('close', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).subarray(4).toString()) as Record<string, unknown>); }
      catch (error) { reject(error); }
    });
  });
}

test('separate sink witness restores deleted/older local state and fails closed on outage or equivocation', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aether-sink-witnessed-'));
  const sinkDir = path.join(root, 'sink');
  const witnessDir = path.join(root, 'witness');
  fs.mkdirSync(sinkDir, { mode: 0o700 });
  fs.mkdirSync(witnessDir, { mode: 0o700 });
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const anchor: SinkPublicAnchorV1 = { format: 'aether.sink-anchor/1',
    repositoryId: 'repo:witnessed', sinkAuthorityId: 'sink-authority:operator', sinkId: 'sink:ledger',
    keyId: 'key:1', keyEpoch: '1',
    publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64') };
  const artifact = domainDigest('aether.effect-adapter-artifact/2', 'witnessed-fixture');
  const witnessKey = randomBytes(32), sinkKey = randomBytes(32);
  const witnessSocket = path.join(witnessDir, 'w.sock'), sinkSocket = path.join(sinkDir, 's.sock');
  const witnessConfig = path.join(witnessDir, 'config.json');
  const sinkConfig = path.join(sinkDir, 'config.json');
  const witnessKeyFile = path.join(witnessDir, 'key');
  const sinkKeyFile = path.join(sinkDir, 'key');
  const signingKeyFile = path.join(sinkDir, 'sign.pem');
  privateFile(witnessKeyFile, witnessKey); privateFile(sinkKeyFile, sinkKey);
  privateFile(signingKeyFile, privateKey.export({ format: 'pem', type: 'pkcs8' }));
  privateFile(witnessConfig, { socketPath: witnessSocket, storageDir: path.join(witnessDir, 'heads'),
    keyFile: witnessKeyFile, namespaces: [{ kind: 'sink-scope', authorityId: 'operator:witness',
      anchor, adapterArtifactDigest: artifact }] });
  privateFile(sinkConfig, { format: 'aether.attested-sink-config/2', socketPath: sinkSocket,
    storageDir: path.join(sinkDir, 'store'), authKeyFile: sinkKeyFile, signingKeyFile,
    anchor, adapterArtifactDigest: artifact, witnessSocketPath: witnessSocket,
    witnessKeyFile, witnessAuthorityId: 'operator:witness' });
  const client = createAttestedSinkClient({ socketPath: sinkSocket, authKey: sinkKey, anchor,
    adapterArtifactDigest: artifact, repositoryId: anchor.repositoryId,
    deploymentId: 'deployment:1', timeoutMs: 3000 });
  const stateFile = path.join(sinkDir, 'store', 'sink-state-v2.json');
  let witness: ChildProcess | null = null, sink: ChildProcess | null = null;
  try {
    witness = await launch('witness-service-cli.ts', witnessConfig, 'witness service ready');
    sink = await launch('attested-sink-service-cli.ts', sinkConfig, 'attested sink service ready');
    const genesis = fs.readFileSync(stateFile);
    const firstRequest = request('effect:first');
    const first = client.execute(firstRequest);
    assert.equal(first.state, 'committed');
    assert.equal(JSON.parse(fs.readFileSync(stateFile, 'utf8')).witnessRevision, '1');
    await kill(sink); sink = null;
    const legacyConfig = path.join(sinkDir, 'legacy-config.json');
    privateFile(legacyConfig, { socketPath: sinkSocket, storageDir: path.join(sinkDir, 'store'),
      authKeyFile: sinkKeyFile, signingKeyFile, anchor, adapterArtifactDigest: artifact });
    assert.match(await rejectedStart('attested-sink-service-cli.ts', legacyConfig),
      /witnessed sink state cannot run under legacy profile/);
    fs.unlinkSync(stateFile);
    sink = await launch('attested-sink-service-cli.ts', sinkConfig, 'attested sink service ready');
    assert.deepEqual(client.execute(firstRequest), first);
    assert.deepEqual(client.status(firstRequest), first);
    assert.equal(JSON.parse(fs.readFileSync(stateFile, 'utf8')).decisions.length, 1);
    await kill(sink); sink = null;
    fs.writeFileSync(stateFile, genesis);
    sink = await launch('attested-sink-service-cli.ts', sinkConfig, 'attested sink service ready');
    assert.deepEqual(client.status(firstRequest), first);
    const laterDeployment = createAttestedSinkClient({ socketPath: sinkSocket, authKey: sinkKey,
      anchor, adapterArtifactDigest: artifact, repositoryId: anchor.repositoryId,
      deploymentId: 'deployment:2', timeoutMs: 3000 });
    assert.throws(() => laterDeployment.execute(firstRequest), /sink CONFLICT/);
    await kill(witness); witness = null;
    assert.throws(() => client.execute(request('effect:outage')), /sink UNCERTAIN/);
    assert.equal(JSON.parse(fs.readFileSync(stateFile, 'utf8')).decisions.length, 1);
    witness = await launch('witness-service-cli.ts', witnessConfig, 'witness service ready');
    const second = client.execute(request('effect:second'));
    assert.equal(second.receipt.body.sinkSequence, '2');
    const fenceRequest = request('effect:fenced');
    const fence = client.status(fenceRequest);
    assert.equal(fence.state, 'not_committed');
    assert.throws(() => client.execute(fenceRequest), /sink FENCED/);
    const selected = createProcessWitnessClient({ socketPath: witnessSocket, key: witnessKey })
      .sinkStateWitness({ authorityId: 'operator:witness', anchor,
        adapterArtifactDigest: artifact });
    const held = readSinkStateHead(selected);
    assert.equal(held.revision, '3');
    const malformed = JSON.parse(held.journal!) as { witnessRevision: string;
      decisions: { receipt: { signature: string } }[] };
    malformed.witnessRevision = '4';
    malformed.decisions[0].receipt.signature = Buffer.alloc(64).toString('base64');
    malformed.decisions.push(malformed.decisions[2]);
    const forged = await rawWitnessAdvance(witnessSocket, witnessKey, {
      kind: 'sink', authorityId: 'operator:witness', repositoryId: anchor.repositoryId,
      sinkAuthorityId: anchor.sinkAuthorityId, sinkId: anchor.sinkId,
      sinkAnchorDigest: domainDigest('aether.sink-anchor/1', anchor),
      adapterArtifactDigest: artifact,
    }, '3', Buffer.from(encodeCanonical(malformed)).toString('utf8'));
    assert.equal(forged.code, 'INVALID', 'operator witness must validate receipts itself');
    assert.deepEqual(readSinkStateHead(selected), held);
    await kill(sink); sink = null;
    const divergent = JSON.parse(fs.readFileSync(stateFile, 'utf8')) as { decisions: unknown[] };
    divergent.decisions = [divergent.decisions[1], divergent.decisions[0]];
    fs.writeFileSync(stateFile, encodeCanonical(divergent));
    assert.match(await rejectedStart('attested-sink-service-cli.ts', sinkConfig), /startup failed/);
    fs.unlinkSync(stateFile);
    sink = await launch('attested-sink-service-cli.ts', sinkConfig, 'attested sink service ready');
    assert.deepEqual(client.execute(firstRequest), first);
    assert.deepEqual(client.execute(request('effect:second')), second);
    assert.deepEqual(client.status(fenceRequest), fence);
    assert.throws(() => client.execute(fenceRequest), /sink FENCED/);
  } finally {
    await kill(sink); await kill(witness);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
