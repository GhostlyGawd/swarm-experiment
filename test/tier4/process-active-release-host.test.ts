import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createPrivateKey, createPublicKey, generateKeyPairSync } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, fsyncSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as b from '../../src/tier1/build.ts';
import { DurableGraphStore } from '../../src/tier1/durable-store.ts';
import { CausalLineageLedger } from '../../src/tier1/causal-lineage.ts';
import { GraphStore } from '../../src/tier1/store.ts';
import { atomicWrite } from '../../src/tier1/persistence.ts';
import { SymbolSpace } from '../../src/tier1/symbols.ts';
import { capability } from '../../src/tier1/ids.ts';
import { encodeCanonical } from '../../src/fabric/encoding.ts';
import { createHostJournalWitness, type HostJournalHead } from '../../src/fabric/host-journal-witness.ts';
import { createNamespacedEffectJournalWitness, createNamespacedEffectJournalWitnessCatalog,
  type NamespacedEffectJournalWitness, type WitnessHead } from '../../src/fabric/effect-journal-witness.ts';
import { DurableEffectBroker, effectAdapterDigest } from '../../src/fabric/effects.ts';
import { domainDigest, type ExecutionManifestV1 } from '../../src/fabric/identity.ts';
import { runtimeSnapshotDigest } from '../../src/fabric/snapshot.ts';
import { CapabilityRegistry, CapabilitySealer } from '../../src/tier2/ocap.ts';
import { ScopedGrantAuthority } from '../../src/tier2/scoped-grants.ts';
import { createEffectSignerAnchor } from '../../src/tier2/effect-signer-anchor.ts';
import { createTrustedClockAnchor } from '../../src/tier2/trusted-clock-anchor.ts';
import { admitWasmAdapterBytes, admittedAdapterArtifactDigest, wasmAdapterArtifactForBytes } from '../../src/tier2/adapter-artifact.ts';
import { effectResourcePolicyDigestV4, signEffectResourcePolicyV4, type EffectResourcePolicyBodyV4 } from '../../src/tier2/effect-resource-policy.ts';
import { checkpointDigest } from '../../src/tier3/resumable-state.ts';
import { compileResumableProgram } from '../../src/tier3/resumable-program.ts';
import { ResumableRuntime } from '../../src/tier3/resumable-runtime.ts';
import { BrokerEffectRouter } from '../../src/tier3/effects.ts';
import { ProcessCheckpointActiveReleaseAuthority } from '../../src/tier4/process-checkpoint-active-release.ts';
import { seedProcessCheckpoint } from '../../src/tier4/process-checkpoint-contract.ts';
import { ProcessHost, type ProcessHostOptions } from '../../src/tier4/process-host.ts';
import { ProcessResumableSession } from '../../src/tier4/process-resumable.ts';
import { ProcessSemanticRetention } from '../../src/tier4/process-semantic-retention.ts';
import type { TopologyPlan } from '../../src/tier4/topology.ts';

const directories: string[] = [];
const childMode = process.env.AETHER_ACTIVE_RELEASE_CHILD === '1';
after(() => directories.forEach(path => rmSync(path, { recursive: true, force: true })));
const wasm = Uint8Array.from([0,97,115,109,1,0,0,0,1,6,1,0x60,1,0x7f,1,0x7f,3,2,1,0,5,4,1,1,1,1,
  7,16,2,3,114,117,110,0,0,6,109,101,109,111,114,121,2,0,10,16,1,14,0,0x20,0,0x45,0x04,0x40,0x00,0x0b,0x20,0,0x41,1,0x6a,0x0b]);

async function fixture(onPhase?: ProcessHostOptions['onPhase'], reuseDirectory?: string) {
  const directory = reuseDirectory ?? mkdtempSync(join(tmpdir(), 'aether-witnessed-active-release-'));
  if (!reuseDirectory) directories.push(directory);
  const hostDirectory = join(directory, 'host'); mkdirSync(hostDirectory, { recursive: true });
  const symbols = new SymbolSpace('witnessed-active-release'), entry = symbols.define('entry');
  const helper = symbols.define('helper'), unused = symbols.define('unused'), x = symbols.define('x');
  const cap = capability('cap:test:dummy'), registry = new CapabilityRegistry();
  registry.define({ name: cap, domain: 'test', operation: 'dummy', arity: 1, description: 'unused witnessed adapter', effectful: true });
  const helperDecl = b.fn({ symbol: helper, params: [b.param(x, b.Int)], returns: b.Int,
    contract: b.contract({}), body: b.ret(b.add(b.v(x), b.int(1))) });
  const module = b.module_({ symbol: symbols.define('module'), symbolTable: symbols.table(), members: [
    b.fn({ symbol: entry, params: [b.param(x, b.Int)], returns: b.Int,
      contract: b.contract({}), body: b.ret(b.call(helper, b.v(x))) }), helperDecl,
    b.fn({ symbol: unused, params: [b.param(x, b.Int)], returns: b.Int, capabilities: [cap],
      purity: 'effectful', contract: b.contract({}), body: b.block(b.exprStmt(b.invoke(cap, b.v(x))), b.ret(b.v(x))) }) ] });
  const graph = new GraphStore(), root = graph.intern(module), helperRoot = graph.intern(helperDecl);
  const adapter = admitWasmAdapterBytes(wasm, wasmAdapterArtifactForBytes(wasm, cap,
    'active-release-dummy/1', { maxMemoryPages: 1, timeoutMs: 1000 }));
  const repositoryId = 'witnessed-active-release', clockDomain = 'active-release-clock/1';
  const policyBody: EffectResourcePolicyBodyV4 = { format: 'aether.effect-resource-policy/4', repositoryId,
    astRoot: root, policyEpoch: '0', rules: [{ capability: cap, prefix: ['dummy'], argument: null,
      deadline: '1000', clockDomain, adapterId: adapter.id, adapterDigest: effectAdapterDigest(adapter),
      adapterArtifactDigest: admittedAdapterArtifactDigest(adapter)! }] };
  const d = (name: string) => domainDigest('aether.witnessed-active-release-test/1', name);
  const manifest: ExecutionManifestV1 = { format: 'aether.execution/1', astRoot: root, specRoot: d('spec'),
    dependencies: [{ symbol: helper, declaration: helperRoot }], semanticsVersion: 'aether-reference/1',
    compilerDigest: d('compiler'), target: { abiVersion: 'process/1', profileDigest: d('profile'), artifactDigest: d('artifact') },
    capabilityPolicyDigest: effectResourcePolicyDigestV4(policyBody), evidencePolicyDigest: d('evidence') };
  const privatePath = join(directory, 'release-signer-private.pem');
  const publicPath = join(directory, 'release-signer-public.pem');
  if (!existsSync(privatePath)) {
    const generated = generateKeyPairSync('ed25519');
    writeFileSync(privatePath, generated.privateKey.export({ format: 'pem', type: 'pkcs8' }));
    writeFileSync(publicPath, generated.publicKey.export({ format: 'pem', type: 'spki' }));
  }
  const keys = { privateKey: createPrivateKey(readFileSync(privatePath)), publicKey: createPublicKey(readFileSync(publicPath)) };
  const signer = createEffectSignerAnchor({ repositoryId, signer: 'active-release-policy', epochAuthorityId: 'active-release-epoch',
    publicKey: keys.publicKey, currentEpoch: () => '0' });
  const clock = createTrustedClockAnchor({ authorityId: 'active-release-clock-operator', clockDomain,
    nowMs: () => 100, revision: () => '0' });
  const grants = new ScopedGrantAuthority({ key: new Uint8Array(32).fill(71), repositoryId,
    clock: () => 100, policyEpoch: () => '0', revocationEpoch: () => '0', isRevoked: () => false,
    authorizeIssue: () => true, authorizeDelegate: () => true });
  const policy = signEffectResourcePolicyV4(policyBody, signer.signer, keys.privateKey);
  const effects = new Map<string, NamespacedEffectJournalWitness>();
  const effectWitnessFor = (operationId: string): NamespacedEffectJournalWitness => {
    let witness = effects.get(operationId); if (witness) return witness;
    let head: WitnessHead = { revision: '0', journal: null };
    witness = createNamespacedEffectJournalWitness({ authorityId: 'active-release-effect-operator',
      repositoryId, catalogDeploymentId: 'active-release-deployment', operationId, clockDomain,
      read: () => head, advance: (expected, journal) => {
        if (head.revision !== expected) throw new Error('stale effect witness');
        head = { revision: String(BigInt(expected) + 1n), journal }; return head;
      } }); effects.set(operationId, witness); return witness;
  };
  const catalog = createNamespacedEffectJournalWitnessCatalog({ authorityId: 'active-release-effect-operator',
    repositoryId, deploymentId: 'active-release-deployment', clockDomain, witnessFor: effectWitnessFor });
  const witnessPath = join(directory, 'host-witness-head.json');
  if (!existsSync(witnessPath)) writeFileSync(witnessPath, encodeCanonical({ revision: '0', journal: null }));
  const readHead = (): HostJournalHead => JSON.parse(readFileSync(witnessPath, 'utf8')) as HostJournalHead;
  const saveHead = (next: HostJournalHead): void => {
    atomicWrite(witnessPath, Buffer.from(encodeCanonical(next)).toString());
    const fd = openSync(directory, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); }
  };
  let outage = false;
  const hostWitness = createHostJournalWitness({ authorityId: 'active-release-host-operator', repositoryId,
    deploymentId: 'active-release-deployment', hostId: 'active-release-host',
    read: () => { if (outage) throw new Error('host witness unavailable'); return readHead(); },
    advance: (expected, journal) => {
      if (readHead().revision !== expected) throw new Error('stale host witness');
      const next = { revision: String(BigInt(expected) + 1n), journal };
      saveHead(next); return next;
    } });
  const plan: TopologyPlan = { shape: 'containers', units: [{ id: 'unit', members: [entry, helper, unused],
    capabilities: [cap], placement: 'container', memoryMb: 32 }], crossEdges: [], transportLatencyMsPerSecond: 0,
    monthlyCost: 0, recombinations: [], blockedMerges: [] };
  const storeDirectory = join(directory, 'ast'), collectorDirectory = join(directory, 'gc');
  const store = new DurableGraphStore({ directory: storeDirectory });
  if (!store.roots().retiredLeases.includes('draft')) {
    store.intern(module, { leaseId: 'draft' }); store.intern(helperDecl, { leaseId: 'draft' });
  }
  const program = compileResumableProgram(module, { manifest, registry });
  const release = new ProcessCheckpointActiveReleaseAuthority({ witness: hostWitness, hostDirectory, repositoryId, program });
  const retention = (graphStore: DurableGraphStore, active = true) => new ProcessSemanticRetention({
    directory: collectorDirectory, repositoryId, store: graphStore,
    lineage: new CausalLineageLedger({ directory: join(directory, 'lineage'), repositoryId, store: graphStore,
      authority: () => ({ policyEpoch: '0', eligibleAuthors: ['author'] }), authorKey: () => undefined }),
    registry, policy: { epoch: '1', exports: [entry], protectedSymbols: [] },
    ...(active ? { activeReleaseAuthority: release } : {}) });
  const factory: NonNullable<ProcessHostOptions['effectRouterFactory']> = effect => {
    const witness = effectWitnessFor(effect.operationId);
    const broker = new DurableEffectBroker({ directory: join(directory, 'effects', d(effect.operationId).split(':').at(-1)!),
      clockDomain, clock: () => 100n, authorize: () => true, authorizeReconciliation: () => true,
      witness });
    return new BrokerEffectRouter({ broker, manifest: effect.manifest, executionId: effect.operationId,
      policyEpoch: effect.policyEpoch!, deadline: effect.deadline!, adapters: new Map([[cap, adapter]]),
      grantRef: effect.grantRef!, grant: () => { throw new Error('unexpected grant callback'); } });
  };
  const options: ProcessHostOptions = { directory: hostDirectory, module, manifest, registry, plan,
    sealer: new CapabilitySealer(new Uint8Array(32).fill(72), () => 100), scopedGrants: grants,
    signedEffectResourcePolicy: policy, effectSignerAnchor: signer, trustedClockAnchor: clock,
    effectJournalWitnessCatalog: catalog, hostJournalWitness: hostWitness,
    anchoredEffectPolicyProfile: 'isolated-wasm-v7-host-witness',
    semanticCheckpointRetention: retention(store), semanticActiveReleaseProfile: 'witnessed-active-task-release-v1',
    authorizeCheckpoint: () => true, effectRouterFactory: factory, onPhase };
  let host = await ProcessHost.open(options);
  const start = async () => {
    const before = await host.snapshot();
    const runtime = new ResumableRuntime(module, { manifest, registry, executionId: 'active-release-task', heapId: before.heapId });
    const seed = seedProcessCheckpoint(runtime.snapshot(), before, host.generation, program, {});
    runtime.restore(seed.checkpoint, checkpointDigest(seed.checkpoint)); runtime.start(entry, [4n]);
    return ProcessResumableSession.begin({ host, module, runtime: { manifest, registry },
      tokens: () => host.issueScopedTokens(entry) }, seed.checkpoint, runtime.snapshot(), {
      operationId: 'active-release-checkpoint', symbol: entry, expectedGeneration: host.generation,
      expectedSnapshot: runtimeSnapshotDigest(before) });
  };
  return { directory, hostDirectory, hostWitness, hostHead: readHead,
    setOutage: (value: boolean) => { outage = value; },
    setHead: saveHead,
    host: () => host, close: async () => { await host.close(); }, start, options, release, store,
    storeDirectory, collectorDirectory, root, helperRoot, entry, retention,
    reopen: async () => { await host.close(); host = await ProcessHost.open({ ...options,
      semanticCheckpointRetention: retention(new DurableGraphStore({ directory: storeDirectory })) }); return host; } };
}

test('opt-in config/15 releases active pins from the host witness and reopens with replay intact', { skip: childMode }, async () => {
  const f = await fixture();
  try {
    const session = await f.start();
    assert.equal((await session.run()).state, 'completed');
    await session.commit();
    const active = f.options.semanticCheckpointRetention!.collector.retentions();
    assert.equal(active.filter(item => item.kind === 'active-task').length, 0);
    assert.equal(active.filter(item => item.kind === 'replay').length, 2);
    assert.match(JSON.parse(f.hostHead().journal!).configuration, /^aether\.process-host-config\/15:/);
    f.store.release('draft'); f.options.semanticCheckpointRetention!.collector.collect();
    assert.equal(f.store.hydrate(f.root).kind, 'Module');
    const reopened = await f.reopen();
    assert.equal(reopened.checkpointStatus(session.binding.id).state, 'committed');
    assert.ok(reopened.checkpointReceipt(session.binding.id, reopened.issueScopedTokens(f.entry)));
    await assert.rejects(ProcessHost.open({ ...f.options, semanticActiveReleaseProfile: undefined }),
      /requires its versioned host profile/);
  } finally { await f.close(); }
});

test('reopen reconciles a committed host decision interrupted before active pin release', { skip: childMode }, async () => {
  const f = await fixture((phase) => { if (phase === 'checkpoint-committed') throw new Error('simulated controller interruption'); });
  try {
    const session = await f.start(); assert.equal((await session.run()).state, 'completed');
    await assert.rejects(session.commit(), /controller interruption/);
    assert.equal(f.host().checkpointStatus(session.binding.id).state, 'committed');
    assert.equal(f.options.semanticCheckpointRetention!.collector.retentions().filter(item => item.kind === 'active-task').length, 2);
    const reopened = await f.reopen();
    assert.equal(reopened.checkpointStatus(session.binding.id).state, 'committed');
    assert.equal(f.options.semanticCheckpointRetention!.collector.retentions().filter(item => item.kind === 'active-task').length, 0);
    assert.equal(f.options.semanticCheckpointRetention!.collector.retentions().filter(item => item.kind === 'replay').length, 2);
  } finally { await f.close(); }
});

test('witness outage, rollback, forged terminal receipt and altered marker block released-host reopen', { skip: childMode }, async () => {
  for (const damage of ['outage', 'rollback', 'receipt', 'marker'] as const) {
    const f = await fixture();
    try {
      const session = await f.start(); assert.equal((await session.run()).state, 'completed'); await session.commit();
      if (damage === 'outage') f.setOutage(true);
      else if (damage === 'rollback') f.setHead({ revision: '0', journal: null });
      else if (damage === 'receipt') {
        const old = f.hostHead(), journal = JSON.parse(old.journal!);
        journal.checkpointReceipts[0].effectAudit = domainDigest('aether.process-checkpoint-effects/1', 'forged');
        const revision = String(BigInt(old.revision) + 1n); journal.witnessRevision = revision;
        f.setHead({ revision, journal: Buffer.from(encodeCanonical(journal)).toString() });
      } else {
        const markerDirectory = join(f.hostDirectory, 'checkpoint-semantic-retention');
        const file = (await import('node:fs')).readdirSync(markerDirectory)[0];
        unlinkSync(join(markerDirectory, file));
      }
      await assert.rejects(f.reopen(), /witness|receipt|marker|ENOENT|diverges/i, damage);
    } finally { await f.close(); }
  }
});

test('child crash driver', { skip: !childMode }, async () => {
  const directory = process.env.AETHER_ACTIVE_RELEASE_DIRECTORY;
  const phase = process.env.AETHER_ACTIVE_RELEASE_PHASE;
  if (!directory || !['checkpoint-committed', 'checkpoint-active-released'].includes(phase ?? ''))
    throw new Error('child crash driver lacks its exact boundary');
  const f = await fixture((current) => {
    if (current === phase) process.kill(process.pid, 'SIGKILL');
  }, directory);
  const session = await f.start(); assert.equal((await session.run()).state, 'completed');
  await session.commit();
  throw new Error('controller SIGKILL boundary was not reached');
});

test('real controller death on both sides of active release reopens from the witnessed decision', { skip: childMode }, async () => {
  for (const phase of ['checkpoint-committed', 'checkpoint-active-released'] as const) {
    const directory = mkdtempSync(join(tmpdir(), 'aether-active-release-kill-')); directories.push(directory);
    const child = spawnSync(process.execPath, ['--experimental-strip-types', new URL(import.meta.url).pathname], {
      env: { ...process.env, AETHER_ACTIVE_RELEASE_CHILD: '1',
        AETHER_ACTIVE_RELEASE_DIRECTORY: directory, AETHER_ACTIVE_RELEASE_PHASE: phase },
      encoding: 'utf8', timeout: 120_000 });
    assert.equal(child.signal, 'SIGKILL', `${phase}: ${child.stderr}\n${child.stdout}`);
    const f = await fixture(undefined, directory);
    try {
      const journal = JSON.parse(f.hostHead().journal!);
      const lease = journal.checkpointLeases[0];
      assert.equal(lease.state, 'committed');
      assert.equal(f.host().checkpointStatus(lease.binding.id).state, 'committed');
      assert.equal(f.options.semanticCheckpointRetention!.collector.retentions().filter(item => item.kind === 'active-task').length, 0);
      assert.equal(f.options.semanticCheckpointRetention!.collector.retentions().filter(item => item.kind === 'replay').length, 2);
      assert.equal(f.store.hydrate(f.root).kind, 'Module');
      assert.equal(f.store.hydrate(f.helperRoot).kind, 'FunctionDecl');
    } finally { await f.close(); }
  }
});
