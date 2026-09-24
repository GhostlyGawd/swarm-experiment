import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { encodeCanonical } from '../../src/fabric/encoding.ts';
import { createProcessWitnessClient } from '../../src/fabric/witness-service.ts';
import { readWitnessHead, selectEffectJournalWitness } from '../../src/fabric/effect-journal-witness.ts';
import { selectHostJournalWitness, readHostJournalHead, advanceHostJournalHead } from '../../src/fabric/host-journal-witness.ts';

const root = resolve(import.meta.dirname, '../..');
const moduleUrl = (file: string): string => JSON.stringify(new URL(file, import.meta.url).href);

async function launchWitness(configFile: string): Promise<ChildProcess> {
  const child = spawn(process.execPath, ['--experimental-strip-types',
    join(root, 'src/fabric/witness-service-cli.ts'), '--config', configFile],
  { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH ?? '', NODE_NO_WARNINGS: '1' } });
  await new Promise<void>((resolveReady, reject) => {
    let stdout = '', stderr = '';
    const timeout = setTimeout(() => reject(new Error(`witness startup timeout: ${stderr}`)), 10_000);
    child.stdout!.on('data', chunk => {
      stdout += String(chunk);
      if (stdout.includes('witness service ready')) { clearTimeout(timeout); resolveReady(); }
    });
    child.stderr!.on('data', chunk => { stderr += String(chunk).slice(0, 2048); });
    child.once('exit', code => { clearTimeout(timeout); reject(new Error(`witness exited ${code}: ${stderr}`)); });
    child.once('error', error => { clearTimeout(timeout); reject(error); });
  });
  return child;
}

async function kill(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>(resolveExit => child.once('exit', () => resolveExit()));
  child.kill('SIGKILL'); await exited;
}

/** This is a separate controller executable, created under the test directory.
 * It receives only paths to private fixture files. Both launches independently
 * rebuild the approved module, policy, grants and catalog from the same inputs. */
function controllerSource(fixtureFile: string): string {
  return `
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { createPrivateKey, createPublicKey } from 'node:crypto';
import { appendFileSync, closeSync, fsyncSync, openSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as b from ${moduleUrl('../../src/tier1/build.ts')};
import { capability } from ${moduleUrl('../../src/tier1/ids.ts')};
import { SymbolSpace } from ${moduleUrl('../../src/tier1/symbols.ts')};
import { GraphStore } from ${moduleUrl('../../src/tier1/store.ts')};
import { CapabilityRegistry, CapabilitySealer } from ${moduleUrl('../../src/tier2/ocap.ts')};
import { ScopedGrantAuthority } from ${moduleUrl('../../src/tier2/scoped-grants.ts')};
import { createEffectSignerAnchor } from ${moduleUrl('../../src/tier2/effect-signer-anchor.ts')};
import { createTrustedClockAnchor } from ${moduleUrl('../../src/tier2/trusted-clock-anchor.ts')};
import { wasmAdapterArtifactForBytes, admitWasmAdapterBytes, admittedAdapterArtifactDigest } from ${moduleUrl('../../src/tier2/adapter-artifact.ts')};
import { effectResourcePolicyDigestV4, signEffectResourcePolicyV4 } from ${moduleUrl('../../src/tier2/effect-resource-policy.ts')};
import { decodeCanonical } from ${moduleUrl('../../src/fabric/encoding.ts')};
import { createProcessWitnessClient } from ${moduleUrl('../../src/fabric/witness-service.ts')};
import { selectEffectJournalWitness } from ${moduleUrl('../../src/fabric/effect-journal-witness.ts')};
import { selectHostJournalWitness } from ${moduleUrl('../../src/fabric/host-journal-witness.ts')};
import { DEFAULT_EVIDENCE_POLICY_V2, mintLocalEvidence } from ${moduleUrl('../../src/fabric/evidence.ts')};
import { DurableEffectBroker, effectAdapterDigest } from ${moduleUrl('../../src/fabric/effects.ts')};
import { domainDigest } from ${moduleUrl('../../src/fabric/identity.ts')};
import { BrokerEffectRouter } from ${moduleUrl('../../src/tier3/effects.ts')};
import { ProcessHost } from ${moduleUrl('../../src/tier4/process-host.ts')};

const mode = process.argv[2];
const f = JSON.parse(readFileSync(${JSON.stringify(fixtureFile)}, 'utf8'));
const durableLine = (file, record) => {
  const fd = openSync(file, 'a', 0o600);
  try { appendFileSync(fd, JSON.stringify(record) + '\\n'); fsyncSync(fd); } finally { closeSync(fd); }
};
// Observe actual Wasm worker launches without changing their arguments or result.
// Probe launches are excluded; one mode=run launch is the guest dispatch.
const originalSpawnSync = childProcess.spawnSync;
childProcess.spawnSync = function(command, args, options) {
  if (Array.isArray(args) && args.some(arg => String(arg).includes('isolated-wasm-worker.'))) {
    const input = decodeCanonical(options.input);
    if (input.mode === 'run') durableLine(f.dispatchFile, { controllerPid: process.pid, mode, requestDigest: input.requestDigest });
  }
  return originalSpawnSync.apply(this, arguments);
};
syncBuiltinESMExports();

const wasm = Uint8Array.from([0,97,115,109,1,0,0,0,
  1,6,1,0x60,1,0x7f,1,0x7f,3,2,1,0,5,4,1,1,1,1,
  7,16,2,3,114,117,110,0,0,6,109,101,109,111,114,121,2,0,
  10,16,1,14,0,0x20,0,0x45,0x04,0x40,0x00,0x0b,0x20,0,0x41,1,0x6a,0x0b]);
const repositoryId = 'controller-crash-repository', deploymentId = 'controller-crash-deployment',
  clockDomain = 'controller-crash-clock/1';
const symbols = new SymbolSpace('controller-crash-v9'), entry = symbols.define('entry'), x = symbols.define('x');
const CAP = capability('cap:test:controller_crash'), registry = new CapabilityRegistry();
registry.define({ name: CAP, domain: 'test', operation: 'controller_crash', arity: 1,
  description: 'read-only isolated guest', effectful: true });
const module = b.module_({ symbol: symbols.define('module'), symbolTable: symbols.table(), members: [
  b.fn({ symbol: entry, params: [b.param(x, b.Int)], returns: b.Int, capabilities: [CAP], purity: 'effectful',
    contract: b.contract({}), body: b.block(b.exprStmt(b.invoke(CAP, b.v(x))), b.ret(b.v(x))) }) ] });
const adapter = admitWasmAdapterBytes(wasm, wasmAdapterArtifactForBytes(wasm, CAP,
  'controller-crash/1', { maxMemoryPages: 1, timeoutMs: 1000 }));
const grants = new ScopedGrantAuthority({ key: readFileSync(f.grantKeyFile), repositoryId, clock: () => 100,
  policyEpoch: () => '0', revocationEpoch: () => '0', isRevoked: () => false,
  authorizeIssue: () => true, authorizeDelegate: () => true });
const policy = { format: 'aether.effect-resource-policy/4', repositoryId,
  astRoot: new GraphStore().intern(module), policyEpoch: '0', rules: [{ capability: CAP, prefix: ['wasm'],
    argument: null, deadline: '1000', clockDomain, adapterId: adapter.id,
    adapterDigest: effectAdapterDigest(adapter), adapterArtifactDigest: admittedAdapterArtifactDigest(adapter) }] };
const digest = name => domainDigest('aether.controller-crash-test/1', name);
const context = { module, registry, specification: 'Controller SIGKILL with external V9 witness',
  semanticsVersion: 'reference/1', compilerDigest: digest('compiler'),
  capabilityPolicyDigest: effectResourcePolicyDigestV4(policy),
  target: { abiVersion: 'process/1', profileDigest: digest('profile'), artifactDigest: digest('artifact') },
  policy: { ...DEFAULT_EVIDENCE_POLICY_V2, requireFormal: false } };
const manifest = mintLocalEvidence(context).manifest;
const privateKey = createPrivateKey(readFileSync(f.signerKeyFile));
const signer = createEffectSignerAnchor({ repositoryId, signer: 'controller-crash-policy',
  epochAuthorityId: 'controller-crash-epoch', publicKey: createPublicKey(privateKey), currentEpoch: () => '0' });
const clock = createTrustedClockAnchor({ authorityId: 'controller-crash-clock-operator', clockDomain,
  nowMs: () => 100, revision: () => '0' });
const signedPolicy = signEffectResourcePolicyV4(policy, signer.signer, privateKey);
const plan = { shape: 'containers', units: [{ id: 'worker', members: [entry],
  capabilities: [CAP], placement: 'container', memoryMb: 16 }], crossEdges: [],
  transportLatencyMsPerSecond: 0, monthlyCost: 0, recombinations: [], blockedMerges: [] };
const client = createProcessWitnessClient({ socketPath: f.socketPath,
  key: readFileSync(f.witnessKeyFile), timeoutMs: 10000 });
const catalog = client.effectCatalog({ authorityId: 'effect-operator', repositoryId, deploymentId, clockDomain });
const hostCatalog = client.hostCatalog({ authorityId: 'host-operator', repositoryId, deploymentId });
const routerFactory = effect => {
  const path = join(f.directory, 'effects', digest(effect.operationId).split(':').at(-1));
  const witness = selectEffectJournalWitness(catalog, effect.operationId);
  const live = new DurableEffectBroker({ directory: path, clockDomain: effect.clockDomain,
    clock: () => 100n, authorize: () => true, authorizeReconciliation: () => true, witness });
  const broker = effect.mode === 'live' ? live : new DurableEffectBroker({ directory: path,
    mode: 'replay', clockDomain: effect.clockDomain, clock: () => 100n, authorize: () => false,
    replayEvents: live.events(), witness });
  return new BrokerEffectRouter({ broker, manifest: effect.manifest, executionId: effect.operationId,
    policyEpoch: effect.policyEpoch, deadline: effect.deadline, adapters: new Map([[CAP, adapter]]),
    grantRef: effect.grantRef, grant: () => { throw new Error('unexpected grant callback'); } });
};
let host;
try {
  host = await ProcessHost.open({ directory: join(f.directory, 'host'), module, manifest, plan, registry,
    sealer: new CapabilitySealer(readFileSync(f.sealerKeyFile), () => 100), scopedGrants: grants,
    effectSignerAnchor: signer, trustedClockAnchor: clock, effectJournalWitnessCatalog: catalog,
    hostJournalWitness: selectHostJournalWitness(hostCatalog, 'direct-host'),
    anchoredEffectPolicyProfile: 'isolated-wasm-v7-host-witness', signedEffectResourcePolicy: signedPolicy,
    authorizeRecovery: () => true, effectRouterFactory: routerFactory,
    onPhase: (phase, detail) => {
      if (detail.operationId !== 'crash-v9') return;
      durableLine(f.phaseFile, { controllerPid: process.pid, phase, operationId: detail.operationId, generation: detail.generation });
      if (mode === 'crash' && phase === 'effect-recorded') process.kill(process.pid, 'SIGKILL');
    } });
  const tokens = () => host.issueScopedTokens(entry, 60000, new Map([[CAP, ['wasm']]]));
  if (mode === 'crash') {
    await host.call(entry, [{ tag: 'int', value: '7' }], { operationId: 'crash-v9', tokens: tokens() });
    throw new Error('expected controller SIGKILL at effect-recorded');
  }
  assert.equal(mode, 'recover');
  const before = host.operationEffectDisposition('crash-v9');
  assert.equal(before.state, 'indeterminate');
  assert.equal(before.effects.length, 1);
  assert.equal(before.effects[0].state, 'committed');
  assert.equal(before.safeToAbortBeforeEffects, false);
  assert.equal(before.possibleExternalCommit, true);
  await assert.rejects(host.recoverOperation('crash-v9', { strategy: 'abort-before-effects' }),
    /cannot abort committed or indeterminate external effects/);
  const recovered = await host.recoverOperation('crash-v9', { strategy: 'isolated-replay' });
  assert.equal(recovered.state, 'completed');
  assert.equal(recovered.execution.ok, true);
  assert.equal(recovered.execution.value.value, '7');
  assert.deepEqual(host.operationResult('crash-v9'), recovered);
  assert.deepEqual(await host.call(entry, [{ tag: 'int', value: '7' }],
    { operationId: 'crash-v9', tokens: tokens() }), recovered);
  assert.equal(host.operationEffectDisposition('crash-v9').effects[0].state, 'committed');
  process.stdout.write(JSON.stringify({ recovered, before }) + '\\n');
} finally { await host?.close(); }
`;
}

// The service and controllers are separate processes but run under one UID in
// this test. This exercises durable custody and crash recovery, not protection
// against a controller that can read the operator's private key on disk. The
// V4 Wasm guest is read-only, so its run dispatch is the concrete effect here.
test('V9 independent witness preserves a committed guest effect across controller SIGKILL and fresh reconciliation', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'aether-controller-crash-witness-'));
  let server: ChildProcess | undefined;
  try {
    const keyFiles = {
      witnessKeyFile: join(directory, 'witness.key'), grantKeyFile: join(directory, 'grant.key'),
      sealerKeyFile: join(directory, 'sealer.key'), signerKeyFile: join(directory, 'signer.pem'),
    };
    for (const path of [keyFiles.witnessKeyFile, keyFiles.grantKeyFile, keyFiles.sealerKeyFile])
      writeFileSync(path, randomBytes(32), { mode: 0o600 });
    const signer = generateKeyPairSync('ed25519');
    writeFileSync(keyFiles.signerKeyFile, signer.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    const socketPath = join(directory, 'w.sock'), configFile = join(directory, 'w.json');
    const repositoryId = 'controller-crash-repository', deploymentId = 'controller-crash-deployment',
      clockDomain = 'controller-crash-clock/1';
    const namespaces = [
      { kind: 'effect-scope', authorityId: 'effect-operator', repositoryId, catalogDeploymentId: deploymentId, clockDomain },
      { kind: 'host-scope', authorityId: 'host-operator', repositoryId, deploymentId },
    ];
    writeFileSync(configFile, encodeCanonical({ socketPath, storageDir: join(directory, 'operator-store'),
      keyFile: keyFiles.witnessKeyFile, namespaces }), { mode: 0o600 });
    server = await launchWitness(configFile);
    const phaseFile = join(directory, 'phases.jsonl'), dispatchFile = join(directory, 'guest-dispatch.jsonl');
    const fixtureFile = join(directory, 'controller-input.json'), controllerFile = join(directory, 'controller.ts');
    writeFileSync(fixtureFile, encodeCanonical({ directory, socketPath, phaseFile, dispatchFile, ...keyFiles }), { mode: 0o600 });
    writeFileSync(controllerFile, controllerSource(fixtureFile));
    const run = (mode: string) => spawnSync(process.execPath,
      ['--experimental-strip-types', controllerFile, mode],
      { cwd: root, encoding: 'utf8', timeout: 90_000, env: { PATH: process.env.PATH ?? '', NODE_NO_WARNINGS: '1' } });
    const crashed = run('crash');
    assert.equal(crashed.signal, 'SIGKILL', crashed.stderr || crashed.error?.message);
    const phases = readFileSync(phaseFile, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.ok(phases.some(row => row.phase === 'effect-recorded' && row.operationId === 'crash-v9'));
    assert.equal(phases.some(row => row.phase === 'call-committed'), false);
    const firstDispatches = readFileSync(dispatchFile, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.equal(firstDispatches.length, 1, 'exactly one guest run before controller kill');
    const hostJournal = JSON.parse(readFileSync(join(directory, 'host', 'host.json'), 'utf8'));
    const effectId = hostJournal.calls.find((row: { operationId: string }) => row.operationId === 'crash-v9').effects[0].id as string;
    const client = createProcessWitnessClient({ socketPath, key: readFileSync(keyFiles.witnessKeyFile), timeoutMs: 10_000 });
    const catalog = client.effectCatalog({ authorityId: 'effect-operator', repositoryId, deploymentId, clockDomain });
    const hostWitness = selectHostJournalWitness(client.hostCatalog({ authorityId: 'host-operator',
      repositoryId, deploymentId }), 'direct-host');
    const hostHeadBefore = readHostJournalHead(hostWitness), forgedHost = JSON.parse(hostHeadBefore.journal!);
    forgedHost.witnessRevision = String(BigInt(hostHeadBefore.revision) + 1n);
    forgedHost.calls.find((row: { operationId: string }) => row.operationId === 'crash-v9').effects[0].state = 'requested';
    assert.throws(() => advanceHostJournalHead(hostWitness, hostHeadBefore.revision,
      Buffer.from(encodeCanonical(forgedHost)).toString('utf8')), /witness INVALID/);
    assert.deepEqual(readHostJournalHead(hostWitness), hostHeadBefore,
      'an authenticated client cannot relabel a witnessed committed effect as safe to abort');
    const witnessBefore = readWitnessHead(selectEffectJournalWitness(catalog, effectId));
    assert.ok(BigInt(witnessBefore.revision) > 0n);
    assert.equal(JSON.parse(witnessBefore.journal!).records.at(-1).state, 'committed');
    const recovered = run('recover');
    assert.equal(recovered.status, 0, recovered.stderr || recovered.error?.message);
    const secondDispatches = readFileSync(dispatchFile, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(secondDispatches, firstDispatches, 'fresh controller did not launch the guest again');
    const witnessAfter = readWitnessHead(selectEffectJournalWitness(catalog, effectId));
    assert.deepEqual(witnessAfter, witnessBefore, 'broker witness saw no second effect dispatch');
    const recoveredRecord = JSON.parse(recovered.stdout.trim().split('\n').at(-1)!);
    assert.equal(recoveredRecord.recovered.state, 'completed');
    t.diagnostic(JSON.stringify({ crashSignal: crashed.signal, phases, guestDispatches: secondDispatches,
      brokerWitnessRevision: witnessAfter.revision, brokerWitnessJournal: witnessAfter.journal,
      recovered: recoveredRecord.recovered }));
  } finally {
    if (server) await kill(server);
    rmSync(directory, { recursive: true, force: true });
  }
});
