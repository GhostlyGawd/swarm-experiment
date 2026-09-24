import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { once } from 'node:events';
import { test } from 'node:test';
import { encodeCanonical } from '../../../../src/fabric/encoding.ts';
import { domainDigest } from '../../../../src/fabric/identity.ts';
import { createProcessWitnessClient, startWitnessService } from '../../../../src/fabric/witness-service.ts';
import { selectEffectJournalWitness, readWitnessHead, advanceWitnessHead } from '../../../../src/fabric/effect-journal-witness.ts';
import { selectHostJournalWitness, readHostJournalHead, advanceHostJournalHead } from '../../../../src/fabric/host-journal-witness.ts';
import { readDeploymentJournalHead, advanceDeploymentJournalHead } from '../../../../src/fabric/deployment-journal-witness.ts';

const root = path.resolve(import.meta.dirname, '../../../..');
test('controlled service close releases the Unix socket and durable service ticket', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aether-witness-close-'));
  try {
    const options = { socketPath: path.join(directory, 'w.sock'), storageDir: path.join(directory, 'store'),
      key: randomBytes(32), namespaces: [{ kind: 'deployment' as const, authorityId: 'operator',
        repositoryId: 'repository', deploymentId: 'deployment' }] };
    const first = await startWitnessService(options);
    assert.equal(fs.existsSync(options.socketPath), true);
    await first.close();
    assert.equal(fs.existsSync(options.socketPath), false);
    const reopened = await startWitnessService(options);
    await reopened.close();
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
function canonical(value: unknown): string { return Buffer.from(encodeCanonical(value, {
  maxFrameBytes: 20 * 1024 * 1024, maxDecompressedBytes: 20 * 1024 * 1024,
  maxObjects: 500_000, maxDepth: 128 })).toString('utf8'); }
function start(config: string): Promise<ChildProcess> {
  const child = spawn(process.execPath, ['--experimental-strip-types',
    path.join(root, 'src/fabric/witness-service-cli.ts'), '--config', config],
  { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  return new Promise((resolve, reject) => {
    let stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`service startup timeout: ${stderr}`)); }, 5000);
    child.stderr!.on('data', data => { stderr += data.toString(); });
    child.stdout!.on('data', data => {
      if (data.toString().includes('witness service ready')) { clearTimeout(timer); resolve(child); }
    });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`service exited ${code}: ${stderr}`)); });
  });
}
function startForgedResponder(socketPath: string): Promise<ChildProcess> {
  const script = `import net from 'node:net';
const server=net.createServer({allowHalfOpen:true},s=>{
 let chunks=[];s.on('data',c=>chunks.push(c));s.on('end',()=>{
  const request=JSON.parse(Buffer.concat(chunks).subarray(4).toString());
  const response=Buffer.from(JSON.stringify({format:'aether.witness-service/1',head:{journal:null,revision:'0'},mac:'0'.repeat(64),nonce:request.nonce,ok:true}));
  const length=Buffer.alloc(4);length.writeUInt32BE(response.length);s.end(Buffer.concat([length,response]));
 });
});server.listen(process.argv[1],()=>process.stdout.write('ready\\n'));`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, socketPath],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  return new Promise((resolve, reject) => {
    child.stdout!.once('data', () => resolve(child));
    child.once('exit', code => reject(new Error(`forged responder exited ${code}`)));
  });
}
async function raw(socketPath: string, bytes: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    const chunks: Buffer[] = [];
    socket.on('connect', () => socket.end(bytes));
    socket.on('data', chunk => chunks.push(chunk));
    socket.on('error', reject);
    socket.on('close', () => resolve(Buffer.concat(chunks)));
  });
}

test('separate witness process authenticates bounded CAS and survives SIGKILL', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aws-'));
  const socketPath = path.join(dir, 'w.sock');
  const storageDir = path.join(dir, 'heads');
  const keyFile = path.join(dir, 'key');
  const config = path.join(dir, 'config.json');
  const secondConfig = path.join(dir, 'second-config.json');
  const key = randomBytes(32);
  fs.writeFileSync(keyFile, key, { mode: 0o600 });
  const ns = { authorityId: 'operator', repositoryId: 'repository', deploymentId: 'deployment' };
  fs.writeFileSync(config, canonical({ socketPath, storageDir, keyFile, namespaces: [
    { kind: 'effect-scope', authorityId: ns.authorityId, repositoryId: ns.repositoryId,
      catalogDeploymentId: ns.deploymentId, clockDomain: 'clock' },
    { kind: 'host-scope', ...ns }, { kind: 'deployment', ...ns },
  ] }), { mode: 0o600 });
  fs.writeFileSync(secondConfig, canonical({ socketPath: path.join(dir, 'second.sock'), storageDir,
    keyFile, namespaces: [{ kind: 'deployment', ...ns }] }), { mode: 0o600 });
  let child: ChildProcess | null = null;
  let forged: ChildProcess | null = null;
  try {
    child = await start(config);
    forged = await startForgedResponder(path.join(dir, 'forged.sock'));
    assert.throws(() => createProcessWitnessClient({ socketPath: path.join(dir, 'forged.sock'), key })
      .deploymentWitness(ns), (error: unknown) => error instanceof Error
      && error.message === 'uncertain witness response'
      && (error.cause as Error)?.message === 'altered witness response');
    forged.kill('SIGKILL'); await once(forged, 'exit'); forged = null;
    await assert.rejects(start(secondConfig), /witness storage already served/);
    const client = createProcessWitnessClient({ socketPath, key });
    const effects = client.effectCatalog({ ...ns, clockDomain: 'clock' });
    const hosts = client.hostCatalog(ns);
    const effect = selectEffectJournalWitness(effects, 'op-1');
    const host = selectHostJournalWitness(hosts, 'host-1');
    assert.strictEqual(selectEffectJournalWitness(effects, 'op-1'), effect);
    assert.strictEqual(selectHostJournalWitness(hosts, 'host-1'), host);
    assert.deepEqual(readWitnessHead(selectEffectJournalWitness(effects, 'op-2')),
      { revision: '0', journal: null });
    assert.deepEqual(readHostJournalHead(selectHostJournalWitness(hosts, 'host-2')),
      { revision: '0', journal: null });
    const deployment = client.deploymentWitness(ns);
    const effectJournal = canonical({ format: 'aether.effect-journal/2', clockDomain: 'clock',
      witnessDigest: effect.digest, revision: '1', records: [] });
    const hostJournal = canonical({ format: 'aether.process-host/4', witnessRevision: '1',
      configuration: domainDigest('aether.test/1', {}), generation: '0', plan: 'plan', snapshot: {},
      calls: [], migrations: [], allocations: [], snapshots: [], heads: [] });
    const deploymentJournal = canonical({ format: 'aether.process-deployment/9', witnessRevision: '1',
      deploymentJournalWitnessDigest: deployment.digest, admissionProfile: 'strict-lineage-v1',
      capabilityProfile: 'scoped-anchored-wasm-v9', effectSignerAnchorDigest: domainDigest('aether.test/1', { n: 1 }),
      trustedClockAnchorDigest: domainDigest('aether.test/1', { n: 2 }),
      effectJournalWitnessCatalogDigest: effects.digest, hostJournalWitnessCatalogDigest: hosts.digest,
      genesisManifest: domainDigest('aether.test/1', { n: 3 }),
      active: { id: 'a', manifest: domainDigest('aether.execution/1', {}),
        artifactDigest: domainDigest('aether.process-artifact/1', {}), generation: '0' },
      readiness: 'ready', pendingProposal: null, invocations: [], allocations: [] });
    assert.deepEqual(advanceWitnessHead(effect, '0', effectJournal), { revision: '1', journal: effectJournal });
    assert.deepEqual(advanceHostJournalHead(host, '0', hostJournal), { revision: '1', journal: hostJournal });
    assert.deepEqual(advanceDeploymentJournalHead(deployment, '0', deploymentJournal),
      { revision: '1', journal: deploymentJournal });
    assert.throws(() => advanceWitnessHead(effect, '0', effectJournal), /stale/);
    const staleBody = { format: 'aether.witness-service/1', nonce: randomBytes(32).toString('hex'),
      op: 'advance', identity: { kind: 'effect', authorityId: ns.authorityId,
        repositoryId: ns.repositoryId, catalogDeploymentId: ns.deploymentId,
        operationId: 'op-1', clockDomain: 'clock' }, expectedRevision: '0', journal: effectJournal };
    const staleRequest = Buffer.from(canonical({ ...staleBody,
      mac: createHmac('sha256', key).update(canonical(staleBody)).digest('hex') }));
    const staleLength = Buffer.alloc(4); staleLength.writeUInt32BE(staleRequest.length);
    const staleResponse = await raw(socketPath, Buffer.concat([staleLength, staleRequest]));
    assert.equal(JSON.parse(staleResponse.subarray(4).toString()).code, 'STALE');
    assert.throws(() => selectEffectJournalWitness(client.effectCatalog({ ...ns, deploymentId: 'wrong', clockDomain: 'clock' }), 'op-1'), /DENIED/);
    assert.throws(() => createProcessWitnessClient({ socketPath, key: randomBytes(32) })
      .deploymentWitness(ns), /uncertain witness response/);
    const id = { kind: 'deployment', ...ns };
    const badRequest = canonical({ format: 'aether.witness-service/1', nonce: '0'.repeat(64), op: 'read',
      identity: id, expectedRevision: null, journal: null, mac: '0'.repeat(64) });
    const prefix = Buffer.alloc(4); prefix.writeUInt32BE(Buffer.byteLength(badRequest));
    assert.equal((await raw(socketPath, Buffer.concat([prefix, Buffer.from(badRequest)]))).length, 0);
    const oversize = Buffer.alloc(4); oversize.writeUInt32BE(36 * 1024 * 1024 + 1);
    assert.equal((await raw(socketPath, oversize)).length, 0);
    const malformed = Buffer.from([0, 0, 0, 5, 123, 125]);
    assert.equal((await raw(socketPath, malformed)).length, 0);
    child.kill('SIGKILL'); await once(child, 'exit'); child = null;
    assert.throws(() => readWitnessHead(effect), /uncertain witness response/);
    child = await start(config);
    const recovered = createProcessWitnessClient({ socketPath, key });
    assert.deepEqual(readWitnessHead(selectEffectJournalWitness(recovered.effectCatalog({ ...ns, clockDomain: 'clock' }), 'op-1')),
      { revision: '1', journal: effectJournal });
    assert.deepEqual(readHostJournalHead(selectHostJournalWitness(recovered.hostCatalog(ns), 'host-1')),
      { revision: '1', journal: hostJournal });
    assert.deepEqual(readDeploymentJournalHead(recovered.deploymentWitness(ns)),
      { revision: '1', journal: deploymentJournal });
    const escapedState = { ...JSON.parse(deploymentJournal), witnessRevision: '2',
      invocations: [{ diagnostic: '\\'.repeat(7_300_000) }] };
    const escapedJournal = canonical(escapedState);
    assert.ok(Buffer.byteLength(escapedJournal) < 16 * 1024 * 1024);
    assert.ok(Buffer.byteLength(JSON.stringify({ journal: escapedJournal })) > 20 * 1024 * 1024,
      'the former outer-frame bound could not carry an otherwise bounded journal');
    assert.deepEqual(advanceDeploymentJournalHead(recovered.deploymentWitness(ns), '1', escapedJournal),
      { revision: '2', journal: escapedJournal });
  } finally {
    if (forged && forged.exitCode === null) { forged.kill('SIGKILL'); await once(forged, 'exit'); }
    if (child && child.exitCode === null) { child.kill('SIGKILL'); await once(child, 'exit'); }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
