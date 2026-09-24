import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { generateKeyPairSync, randomBytes, createHmac } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { createAttestedSinkClient } from '../../src/fabric/attested-sink-service.ts';
import { effectPayloadDigest, type EffectRequestV1 } from '../../src/fabric/effects.ts';
import { domainDigest } from '../../src/fabric/identity.ts';
import { encodeCanonical, type TaggedValueV1 } from '../../src/fabric/encoding.ts';
import { verifySinkReceipt, type SinkPublicAnchorV1 } from '../../src/fabric/sink-receipt.ts';

const roots: string[] = [];
const children = new Set<ChildProcess>();
after(() => {
  for (const child of children) child.kill('SIGKILL');
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

function fixture(artifactVersion: 1 | 2 = 1) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aether-attested-sink-'));
  roots.push(root);
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const anchor: SinkPublicAnchorV1 = {
    format: 'aether.sink-anchor/1', repositoryId: 'repo:fixture', sinkAuthorityId: 'sink-authority:operator',
    sinkId: 'sink:ledger', keyId: 'key:1', keyEpoch: '1',
    publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
  };
  const artifact = domainDigest(`aether.effect-adapter-artifact/${artifactVersion}`, 'attested-sink-echo-ledger-fixture');
  const authKey = randomBytes(32);
  const socketPath = path.join(root, 'sink.sock');
  const storageDir = path.join(root, 'store');
  const keyFile = path.join(root, 'auth.key');
  const signingKeyFile = path.join(root, 'sign.pem');
  const configFile = path.join(root, 'config.json');
  fs.writeFileSync(keyFile, authKey, { mode: 0o600 });
  fs.writeFileSync(signingKeyFile, privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
  fs.writeFileSync(configFile, encodeCanonical({ socketPath, storageDir, authKeyFile: keyFile,
    signingKeyFile, anchor, adapterArtifactDigest: artifact }), { mode: 0o600 });
  const clientOptions = { socketPath, authKey, anchor, adapterArtifactDigest: artifact,
    repositoryId: anchor.repositoryId, deploymentId: 'deployment:1', timeoutMs: 2000 };
  const client = createAttestedSinkClient(clientOptions);
  return { root, anchor, artifact, authKey, configFile, clientOptions, client, socketPath, storageDir };
}
function request(effectId: string, payload: TaggedValueV1 = { tag: 'string', value: 'external-ledger-entry' }): EffectRequestV1 {
  return { format: 'aether.effect/1', executionId: 'execution:1', effectId, branchId: null,
    executionManifest: domainDigest('aether.execution/1', 'fixture'), capabilityGrantRef: 'grant:1',
    policyEpoch: '1', payloadDigest: effectPayloadDigest(payload), payload, budgetReservationId: null,
    deadline: '9000000000000' };
}
async function launch(configFile: string): Promise<ChildProcess> {
  const child = spawn(process.execPath, ['--experimental-strip-types',
    path.resolve('src/fabric/attested-sink-service-cli.ts'), '--config', configFile],
  { stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child);
  let stderr = '';
  child.stderr!.setEncoding('utf8'); child.stderr!.on('data', chunk => { stderr += chunk; });
  await new Promise<void>((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error(`sink service startup timeout: ${stderr}`)), 8000);
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', chunk => {
      if (String(chunk).includes('attested sink service ready')) { clearTimeout(deadline); resolve(); }
    });
    child.once('exit', code => { clearTimeout(deadline); reject(new Error(`sink exited ${code}: ${stderr}`)); });
  });
  return child;
}
async function kill(child: ChildProcess): Promise<void> {
  const exit = new Promise<void>(resolve => child.once('exit', () => resolve()));
  child.kill('SIGKILL'); await exit; children.delete(child);
}
function decisions(storageDir: string): unknown[] {
  const record = JSON.parse(fs.readFileSync(path.join(storageDir, 'sink-state.json'), 'utf8')) as { decisions: unknown[] };
  return record.decisions;
}

test('operator process commits exactly once and retains identical signed receipt after SIGKILL/restart', async () => {
  const f = fixture(); let child = await launch(f.configFile);
  try {
    const r = request('effect:commit');
    const first = f.client.execute(r);
    assert.equal(first.state, 'committed');
    assert.deepEqual(encodeCanonical(first.value), encodeCanonical(r.payload));
    assert.equal(first.receipt.body.sinkSequence, '1');
    assert.equal(first.receipt.body.disposition, 'committed');
    assert.ok(verifySinkReceipt(first.receipt, f.anchor, { repositoryId: f.anchor.repositoryId,
      deploymentId: 'deployment:1', request: r, sinkAuthorityId: f.anchor.sinkAuthorityId,
      sinkId: f.anchor.sinkId, adapterArtifactDigest: f.artifact, disposition: 'committed', value: r.payload }));
    assert.deepEqual(f.client.execute(r), first);
    assert.deepEqual(f.client.status(r), first);
    assert.equal(decisions(f.storageDir).length, 1);
    const otherKey = generateKeyPairSync('ed25519').publicKey;
    const wrongAnchor = createAttestedSinkClient({ ...f.clientOptions,
      anchor: { ...f.anchor, publicKey: otherKey.export({ format: 'der', type: 'spki' }).toString('base64') } });
    assert.deepEqual(wrongAnchor.status(r), { state: 'unknown' });
    assert.throws(() => wrongAnchor.execute(r), /uncertain sink response/);
    assert.equal(decisions(f.storageDir).length, 1);
    await kill(child);
    assert.deepEqual(f.client.status(r), { state: 'unknown' });
    child = await launch(f.configFile);
    assert.deepEqual(f.client.status(r), first);
    assert.deepEqual(f.client.execute(r), first);
    assert.equal(decisions(f.storageDir).length, 1);
    const laterDeployment = createAttestedSinkClient({ ...f.clientOptions, deploymentId: 'deployment:2' });
    assert.throws(() => laterDeployment.execute(r), /sink CONFLICT/);
    assert.deepEqual(laterDeployment.status(r), { state: 'unknown' });
    assert.equal(decisions(f.storageDir).length, 1,
      'a new deployment cannot execute the same logical effect again');
    const altered = request('effect:commit', { tag: 'string', value: 'different' });
    assert.throws(() => f.client.execute(altered), /sink CONFLICT/);
    assert.deepEqual(f.client.status(altered), { state: 'unknown' });
    assert.equal(decisions(f.storageDir).length, 1);
  } finally { await kill(child); }
});

test('near-limit accepted payload retains a recoverable signed response after restart', async () => {
  const f = fixture(2); let child = await launch(f.configFile);
  try {
    const r = request('effect:large-response', { tag: 'string', value: 'x'.repeat(64_400) });
    const first = f.client.execute(r);
    assert.equal(first.state, 'committed');
    assert.equal(first.value.tag, 'string');
    assert.deepEqual(f.client.status(r), first);
    assert.equal(decisions(f.storageDir).length, 1);
    const beyondReceiptLimit = request('effect:too-many-values', { tag: 'sequence',
      items: Array.from({ length: 300 }, (_, index) => ({ tag: 'int' as const, value: String(index) })) });
    assert.throws(() => f.client.execute(beyondReceiptLimit), /sink UNCERTAIN|uncertain sink response/);
    assert.equal(decisions(f.storageDir).length, 1, 'unsupported receipt shapes refuse before sink publication');
    await kill(child); child = await launch(f.configFile);
    assert.deepEqual(f.client.status(r), first);
    assert.equal(decisions(f.storageDir).length, 1);
  } finally { await kill(child); }
});

test('status makes a durable signed noncommit fence that permanently refuses execute', async () => {
  const f = fixture(); let child = await launch(f.configFile);
  try {
    const r = request('effect:fenced');
    const first = f.client.status(r);
    assert.equal(first.state, 'not_committed');
    if (first.state !== 'not_committed') throw new Error('unexpected status');
    assert.equal(first.receipt.body.commitId, null);
    assert.equal(first.receipt.body.valueDigest, null);
    assert.ok(verifySinkReceipt(first.receipt, f.anchor, { repositoryId: f.anchor.repositoryId,
      deploymentId: 'deployment:1', request: r, sinkAuthorityId: f.anchor.sinkAuthorityId,
      sinkId: f.anchor.sinkId, adapterArtifactDigest: f.artifact, disposition: 'not_committed', value: null }));
    assert.throws(() => f.client.execute(r), /sink FENCED/);
    assert.deepEqual(f.client.status(r), first);
    await kill(child); child = await launch(f.configFile);
    assert.deepEqual(f.client.status(r), first);
    assert.throws(() => f.client.execute(r), /sink FENCED/);
    assert.equal(decisions(f.storageDir).length, 1);
  } finally { await kill(child); }
});

test('lost wire response remains a committed decision; wrong auth and forged stored receipt fail closed', async () => {
  const f = fixture(); let child = await launch(f.configFile);
  try {
    const r = request('effect:lost-response');
    const nonce = randomBytes(32).toString('hex');
    const body = { format: 'aether.attested-sink-service/1', nonce, op: 'execute',
      repositoryId: f.anchor.repositoryId, deploymentId: 'deployment:1', request: r };
    const frame = Buffer.from(encodeCanonical({ ...body,
      mac: createHmac('sha256', f.authKey).update(encodeCanonical(body)).digest('hex') }));
    const prefix = Buffer.alloc(4); prefix.writeUInt32BE(frame.length);
    // The requester sends the complete frame and closes its read half. It
    // never consumes the response; the sink still commits before replying.
    await new Promise<void>((resolve, reject) => {
      const socket = net.createConnection(f.socketPath);
      socket.once('connect', () => socket.end(Buffer.concat([prefix, frame]), () => { socket.destroy(); resolve(); }));
      socket.once('error', reject);
    });
    for (let i = 0; i < 50 && !fs.existsSync(path.join(f.storageDir, 'sink-state.json')); i++)
      await new Promise(resolve => setTimeout(resolve, 10));
    const result = f.client.status(r);
    assert.equal(result.state, 'committed');
    assert.equal(decisions(f.storageDir).length, 1);
    const wrong = createAttestedSinkClient({ ...f.clientOptions, authKey: randomBytes(32) });
    assert.deepEqual(wrong.status(request('effect:wrong-auth')), { state: 'unknown' });
    assert.throws(() => wrong.execute(request('effect:wrong-auth')));
    assert.equal(decisions(f.storageDir).length, 1);
    await kill(child);
    const filename = path.join(f.storageDir, 'sink-state.json');
    const state = JSON.parse(fs.readFileSync(filename, 'utf8')) as { decisions: { receipt: { signature: string } }[] };
    state.decisions[0].receipt.signature = Buffer.alloc(64).toString('base64');
    fs.writeFileSync(filename, encodeCanonical(state));
    const failed = spawn(process.execPath, ['--experimental-strip-types',
      path.resolve('src/fabric/attested-sink-service-cli.ts'), '--config', f.configFile],
    { stdio: ['ignore', 'pipe', 'pipe'] });
    const status = await new Promise<number | null>(resolve => failed.once('exit', code => resolve(code)));
    assert.equal(status, 1);
  } finally { if (child.exitCode === null && child.signalCode === null) await kill(child); }
});

test('CLI refuses a group-readable signing key before opening the sink', async () => {
  const f = fixture();
  const config = JSON.parse(fs.readFileSync(f.configFile, 'utf8')) as { signingKeyFile: string };
  fs.chmodSync(config.signingKeyFile, 0o644);
  const child = spawn(process.execPath, ['--experimental-strip-types',
    path.resolve('src/fabric/attested-sink-service-cli.ts'), '--config', f.configFile],
  { stdio: ['ignore', 'pipe', 'pipe'] });
  const status = await new Promise<number | null>(resolve => child.once('exit', code => resolve(code)));
  assert.equal(status, 1);
  assert.equal(fs.existsSync(f.socketPath), false);
});
