import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import * as net from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { encodeCanonical } from '../../src/fabric/encoding.ts';
import { advanceHostJournalHead, readHostJournalHead, selectHostJournalWitness } from '../../src/fabric/host-journal-witness.ts';
import { domainDigest } from '../../src/fabric/identity.ts';
import { runtimeSnapshotDigest } from '../../src/fabric/snapshot.ts';
import { createProcessWitnessClient } from '../../src/fabric/witness-service.ts';

const namespace = { authorityId: 'operator:v5', repositoryId: 'repo:v5', deploymentId: 'deployment:v5' };
const hostId = 'host:v5';
const configuration = domainDigest('aether.process-host-configuration/1', 'v5-test');
const manifestDigest = domainDigest('aether.execution/1', 'v5-test');
const before = { format: 'aether.state/1' as const, executionManifest: manifestDigest,
  heapId: 'heap:v5', nextObjectId: '1', records: [], ownership: [], eventCursor: '0' };
const body = { format: 'aether.process-native-fallback-binding/1', operationId: 'native:one',
  configuration, generation: '0', unit: 'worker',
  processHead: domainDigest('aether.process-state-head/1', 'v5-test'), manifestDigest,
  astRoot: domainDigest('aether.ast/1', 'v5-test'), tier1: 'tier:one', tier2: 'tier:two',
  frame: { sourceSnapshot: runtimeSnapshotDigest(before) },
  proofDigest: domainDigest('aether.native-proof/1', 'v5-test'),
  compilerProfileDigest: domainDigest('aether.native-compiler/1', 'v5-test'),
  sourceSha256: '1'.repeat(64), executableSha256: '2'.repeat(64) };
const binding = { ...body, id: domainDigest('aether.process-native-fallback-binding/1', body) };
const pending = { binding, before, state: 'requested', result: null, resultDigest: null };
const result = { state: 'completed', value: { tag: 'int', value: '7' } };
const resultDigest = domainDigest('aether.process-native-fallback-outcome/1', result);
function journal(revision: string, nativeFallbacks: readonly unknown[]): string {
  return Buffer.from(encodeCanonical({ format: 'aether.process-host/5', configuration,
    generation: '0', plan: '{}', snapshot: {}, calls: [], migrations: [], allocations: [],
    snapshots: [], heads: [], checkpointLeases: [], witnessRevision: revision, nativeFallbacks })).toString('utf8');
}
function next(head: Readonly<{ revision: string; journal: string | null }>, nativeFallbacks: readonly unknown[]): string {
  return journal(String(BigInt(head.revision) + 1n), nativeFallbacks);
}
async function launch(configFile: string): Promise<ChildProcess> {
  const root = resolve(import.meta.dirname, '../..');
  const child = spawn(process.execPath, ['--experimental-strip-types',
    join(root, 'src/fabric/witness-service-cli.ts'), '--config', configFile],
  { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH ?? '', NODE_NO_WARNINGS: '1' } });
  await new Promise<void>((resolveReady, reject) => {
    let output = '', errors = '';
    const timeout = setTimeout(() => reject(new Error(`witness startup timeout: ${errors}`)), 10_000);
    child.stdout!.on('data', chunk => {
      output += String(chunk);
      if (output.includes('witness service ready')) { clearTimeout(timeout); resolveReady(); }
    });
    child.stderr!.on('data', chunk => { errors += String(chunk).slice(0, 2048); });
    child.once('exit', code => { clearTimeout(timeout); reject(new Error(`witness exited ${code}: ${errors}`)); });
    child.once('error', error => { clearTimeout(timeout); reject(error); });
  });
  return child;
}
async function kill(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>(resolveExit => child.once('exit', () => resolveExit()));
  child.kill('SIGKILL'); await exited;
}
/** Authenticated transport exercise: bypass the client envelope check so the
 * service itself must reject an omitted /5 inventory. */
async function rawAdvance(socketPath: string, key: Uint8Array, revision: string, bytes: string): Promise<string> {
  const body = { format: 'aether.witness-service/1', nonce: randomBytes(32).toString('hex'),
    op: 'advance', identity: { kind: 'host', ...namespace, hostId }, expectedRevision: revision, journal: bytes };
  const mac = createHmac('sha256', key).update(encodeCanonical(body)).digest('hex');
  const payload = Buffer.from(encodeCanonical({ ...body, mac }));
  const prefix = Buffer.alloc(4); prefix.writeUInt32BE(payload.length);
  return new Promise<string>((resolveCode, reject) => {
    const socket = net.createConnection(socketPath);
    const chunks: Buffer[] = [];
    socket.once('connect', () => socket.end(Buffer.concat([prefix, payload])));
    socket.on('data', chunk => chunks.push(chunk));
    socket.once('error', reject);
    socket.once('end', () => {
      try {
        const response = Buffer.concat(chunks);
        assert.equal(response.readUInt32BE(0), response.length - 4);
        resolveCode(JSON.parse(response.subarray(4).toString('utf8')).code);
      } catch (error) { reject(error); }
    });
  });
}

test('v5 host witness retains native fallback binding, before snapshot, state and terminal result across service restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'aether-host-v5-witness-'));
  const socketPath = join(directory, 'w.sock'), configFile = join(directory, 'w.json');
  const key = randomBytes(32);
  writeFileSync(join(directory, 'key'), key, { mode: 0o600 });
  writeFileSync(configFile, encodeCanonical({ socketPath, storageDir: join(directory, 'operator-store'),
    keyFile: join(directory, 'key'), namespaces: [{ kind: 'host-scope', ...namespace }] }), { mode: 0o600 });
  let child: ChildProcess | undefined;
  try {
    child = await launch(configFile);
    const selected = createProcessWitnessClient({ socketPath, key }).hostCatalog(namespace);
    const witness = selectHostJournalWitness(selected, hostId);
    let head = readHostJournalHead(witness);
    head = advanceHostJournalHead(witness, head.revision, next(head, [pending]));

    const omitted = { format: 'aether.process-host/5', configuration, generation: '0', plan: '{}',
      snapshot: {}, calls: [], migrations: [], allocations: [], snapshots: [], heads: [],
      checkpointLeases: [], witnessRevision: '2' };
    assert.equal(await rawAdvance(socketPath, key, head.revision,
      Buffer.from(encodeCanonical(omitted)).toString('utf8')), 'INVALID');
    assert.deepEqual(readHostJournalHead(witness), head);
    const invalidRows: readonly [string, readonly unknown[]][] = [
      ['deleted', []],
      ['substituted binding', [{ ...pending, binding: { ...binding, operationId: 'native:other',
        id: domainDigest('aether.process-native-fallback-binding/1', { ...body, operationId: 'native:other' }) } }]],
      ['cross-configuration binding', [{ ...pending, binding: { ...binding,
        configuration: domainDigest('aether.process-host-configuration/1', 'other'),
        id: domainDigest('aether.process-native-fallback-binding/1', { ...body,
          configuration: domainDigest('aether.process-host-configuration/1', 'other') }) } }]],
      ['altered before snapshot', [{ ...pending, before: { ...before, eventCursor: '1' } }]],
      ['premature result', [{ ...pending, result, resultDigest }]],
    ];
    for (const [name, rows] of invalidRows) {
      assert.throws(() => advanceHostJournalHead(witness, head.revision, next(head, rows)),
        /witness INVALID/, name);
      assert.deepEqual(readHostJournalHead(witness), head, name);
    }
    head = advanceHostJournalHead(witness, head.revision, next(head, [{ ...pending, state: 'running' }]));
    assert.throws(() => advanceHostJournalHead(witness, head.revision, next(head, [pending])), /witness INVALID/);
    assert.throws(() => advanceHostJournalHead(witness, head.revision, next(head,
      [{ ...pending, state: 'committed', result,
        resultDigest: domainDigest('aether.process-native-fallback-outcome/1', 'wrong') }])), /witness INVALID/);
    const terminal = { ...pending, state: 'committed', result, resultDigest };
    head = advanceHostJournalHead(witness, head.revision, next(head, [terminal]));
    const frozenHead = head;
    for (const rows of [[{ ...terminal, result: { state: 'completed', value: { tag: 'int', value: '8' } } }],
      [{ ...terminal, state: 'aborted' }], []]) {
      assert.throws(() => advanceHostJournalHead(witness, head.revision, next(head, rows)), /witness INVALID/);
      assert.deepEqual(readHostJournalHead(witness), frozenHead);
    }
    await kill(child); child = undefined;
    assert.throws(() => readHostJournalHead(witness), /uncertain witness response/);
    child = await launch(configFile);
    const reopened = selectHostJournalWitness(createProcessWitnessClient({ socketPath, key }).hostCatalog(namespace), hostId);
    assert.deepEqual(readHostJournalHead(reopened), frozenHead);
    const store = join(directory, 'operator-store');
    const storedHeadFile = join(store, readdirSync(store).find(name => name.endsWith('.json'))!);
    const frozenStoredBytes = readFileSync(storedHeadFile);
    assert.throws(() => advanceHostJournalHead(reopened, frozenHead.revision,
      next(frozenHead, [{ ...terminal,
        resultDigest: domainDigest('aether.process-native-fallback-outcome/1', 'altered') }])), /witness INVALID/);
    assert.deepEqual(readHostJournalHead(reopened), frozenHead);
    const second = { ...pending, binding: { ...binding, operationId: 'native:two',
      id: domainDigest('aether.process-native-fallback-binding/1', { ...body, operationId: 'native:two' }) } };
    const later = advanceHostJournalHead(reopened, frozenHead.revision, next(frozenHead, [terminal, second]));
    assert.equal(later.revision, String(BigInt(frozenHead.revision) + 1n));
    assert.throws(() => advanceHostJournalHead(reopened, later.revision, next(later, [second, terminal])), /witness INVALID/,
      'the service rejects reordered native fallback inventory');
    assert.deepEqual(readHostJournalHead(witness), later, 'prior witness object follows monotonic advances');
    await kill(child); child = undefined;
    writeFileSync(storedHeadFile, frozenStoredBytes);
    child = await launch(configFile);
    assert.throws(() => readHostJournalHead(witness), /rolled back/);
    assert.throws(() => readHostJournalHead(reopened), /rolled back/);
  } finally {
    if (child) await kill(child);
    rmSync(directory, { recursive: true, force: true });
  }
});
