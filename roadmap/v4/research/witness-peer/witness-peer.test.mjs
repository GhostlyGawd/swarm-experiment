import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import test from 'node:test';

const source = fileURLToPath(new URL('../../../../native/witness-peer/witness-peer.c', import.meta.url));
const witnessCli = fileURLToPath(new URL('../../../../src/fabric/witness-service-cli.ts', import.meta.url));
const frame = bytes => Buffer.concat([Buffer.from([0, 0, 0, bytes.length]), Buffer.from(bytes)]);

function connect(pathname, payload, end = true) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(pathname);
    const chunks = [];
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('client wait timed out')); }, 2500);
    socket.on('connect', () => { socket.write(payload); if (end) socket.end(); });
    socket.on('data', chunk => chunks.push(chunk));
    socket.on('error', error => {
      if (error.code !== 'EPIPE' && error.code !== 'ECONNRESET') reject(error);
    });
    socket.on('close', () => { clearTimeout(timer); resolve(Buffer.concat(chunks)); });
  });
}

async function listen(server, pathname) {
  const sockets = new Set();
  server.on('connection', socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  server.testSockets = sockets;
  server.listen(pathname);
  await once(server, 'listening');
}

async function close(server) {
  for (const socket of server.testSockets ?? []) socket.destroy();
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

async function proxy(binary, listenPath, upstreamPath, uid, extra = [], timeoutMs = 300) {
  const child = spawn(binary, ['--listen', listenPath, '--upstream', upstreamPath,
    '--uid', String(uid), '--timeout-ms', String(timeoutMs), ...extra]);
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`proxy startup timed out: ${stderr}; ${listenPath}`)), 2500);
    child.stdout.on('data', chunk => {
      if (chunk.toString().includes('witness-peer ready')) { clearTimeout(timer); resolve(); }
    });
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`proxy exited ${code}/${signal}: ${stderr}`));
    });
  });
  return child;
}

async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('proxy stop timed out')), 2500);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
  });
}

function outputLine(child, expected) {
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`upstream did not emit ${expected}`)), 2500);
    child.stdout.on('data', chunk => {
      output += chunk;
      if (output.includes(`${expected}\n`)) { clearTimeout(timer); resolve(); }
    });
  });
}

test('native peer proxy authenticates before forwarding and fails closed on bad frames and upstream faults', async () => {
  if (!['darwin', 'linux'].includes(process.platform)) return;
  const dir = mkdtempSync(path.join(os.tmpdir(), 'aether-peer-'));
  const binary = path.join(dir, 'witness-peer');
  const compile = spawnSync('cc', ['-std=c11', '-Wall', '-Wextra', '-Werror', '-O2', source, '-o', binary], { encoding: 'utf8' });
  assert.equal(compile.status, 0, compile.stderr);
  const upstreamPath = path.join(dir, 'upstream.sock');
  const listenPath = path.join(dir, 'peer.sock');
  const children = [];
  let upstreamChild;
  let server;
  try {
    let forwarded = 0;
    server = net.createServer({ allowHalfOpen: true }, socket => {
      socket.on('error', () => {});
      let received = false;
      socket.on('data', () => { if (!received) { received = true; forwarded++; } });
      socket.on('end', () => socket.end(frame('reply')));
    });
    await listen(server, upstreamPath);

    const admitted = await proxy(binary, listenPath, upstreamPath, process.getuid());
    children.push(admitted);
    assert.deepEqual(await connect(listenPath, frame('request')), frame('reply'));
    assert.equal(forwarded, 1);
    // A bad prefix is refused before the private upstream is contacted.
    assert.equal((await connect(listenPath, Buffer.from([0x03, 0, 0, 0]))).length, 0);
    // A complete frame followed by extra bytes is not forwarded either.
    assert.equal((await connect(listenPath, Buffer.concat([frame('x'), Buffer.from('y')]))).length, 0);
    assert.equal((await connect(listenPath, Buffer.from([0, 0, 0, 3, 0x61]))).length, 0);
    const heldOpenAt = performance.now();
    assert.equal((await connect(listenPath, frame('x'), false)).length, 0);
    assert.ok(performance.now() - heldOpenAt < 1500, 'missing EOF must hit the deadline');
    assert.equal(forwarded, 1);
    await stop(admitted);

    const denied = await proxy(binary, listenPath, upstreamPath, process.getuid() + 1);
    children.push(denied);
    assert.equal((await connect(listenPath, frame('request'))).length, 0);
    assert.equal(forwarded, 1, 'wrong UID must not touch upstream');
    await stop(denied);

    const wrongGroup = await proxy(binary, listenPath, upstreamPath, process.getuid(), ['--gid', String(process.getgid() + 1)]);
    children.push(wrongGroup);
    assert.equal((await connect(listenPath, frame('request'))).length, 0);
    assert.equal(forwarded, 1, 'wrong GID must not touch upstream');
    await stop(wrongGroup);

    const wrongUpstream = await proxy(binary, listenPath, upstreamPath, process.getuid(),
      ['--upstream-uid', String(process.getuid() + 1)]);
    children.push(wrongUpstream);
    assert.equal((await connect(listenPath, frame('request'))).length, 0);
    assert.equal(forwarded, 1, 'wrong upstream UID must not receive request bytes');
    await stop(wrongUpstream);

    await close(server);
    rmSync(upstreamPath, { force: true });
    server = net.createServer({ allowHalfOpen: true }, socket => {
      forwarded++;
      socket.on('data', () => {});
      // Retain connection past the proxy's overall 300 ms deadline.
    });
    await listen(server, upstreamPath);
    const timed = await proxy(binary, listenPath, upstreamPath, process.getuid());
    children.push(timed);
    const start = performance.now();
    assert.equal((await connect(listenPath, frame('request'))).length, 0);
    assert.ok(performance.now() - start < 1500, 'upstream hang should be bounded');
    await stop(timed);
    // Kill a separate upstream OS process after it receives the request.
    await close(server);
    rmSync(upstreamPath, { force: true });
    server = undefined;
    const upstreamCode = `const net=require('node:net');
      net.createServer({allowHalfOpen:true}, socket=>{
        socket.on('data',()=>{});
        socket.on('end',()=>process.stdout.write('received\\n'));
      }).listen(process.argv[1],()=>process.stdout.write('ready\\n'));`;
    upstreamChild = spawn(process.execPath, ['-e', upstreamCode, upstreamPath]);
    const upstreamReady = outputLine(upstreamChild, 'ready');
    const received = outputLine(upstreamChild, 'received');
    await upstreamReady;
    const crashed = await proxy(binary, listenPath, upstreamPath, process.getuid(), [], 1000);
    children.push(crashed);
    const pending = connect(listenPath, frame('request'));
    await received;
    upstreamChild.kill('SIGKILL');
    await once(upstreamChild, 'exit');
    assert.equal((await pending).length, 0);
    assert.equal(crashed.exitCode, null);
    await stop(crashed);
  } finally {
    for (const child of children) await stop(child);
    if (upstreamChild && upstreamChild.exitCode === null && upstreamChild.signalCode === null) {
      upstreamChild.kill('SIGKILL');
      await once(upstreamChild, 'exit');
    }
    if (server?.listening) await close(server);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('real signed deployment witness read and durable advance traverse the native gateway', async () => {
  if (!['darwin', 'linux'].includes(process.platform)) return;
  const [{ encodeCanonical }, { domainDigest }, { createProcessWitnessClient },
    { advanceDeploymentJournalHead, readDeploymentJournalHead }] = await Promise.all([
    import('../../../../src/fabric/encoding.ts'),
    import('../../../../src/fabric/identity.ts'),
    import('../../../../src/fabric/witness-service.ts'),
    import('../../../../src/fabric/deployment-journal-witness.ts'),
  ]);
  const dir = mkdtempSync(path.join(os.tmpdir(), 'aether-peer-'));
  const binary = path.join(dir, 'witness-peer');
  const compiled = spawnSync('cc', ['-std=c11', '-Wall', '-Wextra', '-Werror', '-O2', source, '-o', binary], { encoding: 'utf8' });
  assert.equal(compiled.status, 0, compiled.stderr);
  const upstreamPath = path.join(dir, 'upstream.sock');
  const listenPath = path.join(dir, 'peer.sock');
  const keyFile = path.join(dir, 'key');
  const configFile = path.join(dir, 'config.json');
  const key = randomBytes(32);
  const ns = { authorityId: 'operator', repositoryId: 'repository', deploymentId: 'deployment' };
  writeFileSync(keyFile, key, { mode: 0o600 });
  writeFileSync(configFile, Buffer.from(encodeCanonical({ socketPath: upstreamPath,
    storageDir: path.join(dir, 'heads'), keyFile, namespaces: [{ kind: 'deployment', ...ns }] })),
  { mode: 0o600 });
  let service;
  let gateway;
  try {
    service = spawn(process.execPath, ['--experimental-strip-types', witnessCli, '--config', configFile]);
    await outputLine(service, 'witness service ready');
    gateway = await proxy(binary, listenPath, upstreamPath, process.getuid(), [], 5000);
    const witness = createProcessWitnessClient({ socketPath: listenPath, key }).deploymentWitness(ns);
    assert.deepEqual(readDeploymentJournalHead(witness), { revision: '0', journal: null });
    const journal = Buffer.from(encodeCanonical({
      format: 'aether.process-deployment/9', witnessRevision: '1',
      deploymentJournalWitnessDigest: witness.digest, admissionProfile: 'strict-lineage-v1',
      capabilityProfile: 'scoped-anchored-wasm-v9',
      effectSignerAnchorDigest: domainDigest('aether.test/1', { n: 1 }),
      trustedClockAnchorDigest: domainDigest('aether.test/1', { n: 2 }),
      effectJournalWitnessCatalogDigest: domainDigest('aether.test/1', { n: 3 }),
      hostJournalWitnessCatalogDigest: domainDigest('aether.test/1', { n: 4 }),
      genesisManifest: domainDigest('aether.test/1', { n: 5 }),
      active: { id: 'a', manifest: domainDigest('aether.execution/1', {}),
        artifactDigest: domainDigest('aether.process-artifact/1', {}), generation: '0' },
      readiness: 'ready', pendingProposal: null, invocations: [], allocations: [],
    })).toString('utf8');
    assert.deepEqual(advanceDeploymentJournalHead(witness, '0', journal), { revision: '1', journal });
    assert.deepEqual(readDeploymentJournalHead(witness), { revision: '1', journal });
  } finally {
    if (gateway) await stop(gateway);
    if (service && service.exitCode === null && service.signalCode === null) {
      service.kill('SIGKILL');
      await once(service, 'exit');
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
