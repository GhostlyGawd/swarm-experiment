import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as b from '../../src/tier1/build.ts';
import { DurableGraphStore } from '../../src/tier1/durable-store.ts';
import { CausalLineageLedger } from '../../src/tier1/causal-lineage.ts';
import { GraphStore } from '../../src/tier1/store.ts';
import { SymbolSpace } from '../../src/tier1/symbols.ts';
import { encodeStored } from '../../src/tier1/persistence.ts';
import { CapabilityRegistry, CapabilitySealer } from '../../src/tier2/ocap.ts';
import { domainDigest, type ExecutionManifestV1 } from '../../src/fabric/identity.ts';
import { runtimeSnapshotDigest } from '../../src/fabric/snapshot.ts';
import { checkpointDigest } from '../../src/tier3/resumable-state.ts';
import { ResumableRuntime } from '../../src/tier3/resumable-runtime.ts';
import { ProcessHost, type ProcessHostOptions } from '../../src/tier4/process-host.ts';
import { ProcessResumableSession } from '../../src/tier4/process-resumable.ts';
import { ProcessSemanticRetention } from '../../src/tier4/process-semantic-retention.ts';
import { seedProcessCheckpoint } from '../../src/tier4/process-checkpoint-contract.ts';
import type { TopologyPlan } from '../../src/tier4/topology.ts';

const directories: string[] = [];
function temporary() { const directory = mkdtempSync(join(tmpdir(), 'aether-process-semantic-retention-')); directories.push(directory); return directory; }
after(() => directories.forEach(directory => rmSync(directory, { recursive: true, force: true })));
const d = (value: string) => domainDigest('aether.process-retention-test/1', value);
function fixture() {
  const directory = temporary(), symbols = new SymbolSpace('process-retention'), main = symbols.define('main'), child = symbols.define('child'), arg = symbols.define('arg'), task = symbols.define('task');
  const worker = b.fn({ symbol: child, params: [b.param(arg, b.Int)], returns: b.Int, body: b.ret(b.add(b.v(arg), b.int(1))) });
  const entry = b.fn({ symbol: main, params: [b.param(arg, b.Int)], returns: b.Int, body: b.block(b.let_(task, { t: 'Task', result: b.Int }, b.spawn(b.call(child, b.v(arg)))), b.ret(b.await_(b.v(task)))) });
  const module = b.module_({ symbol: symbols.define('module'), members: [entry, worker], symbolTable: symbols.table() });
  const graph = new GraphStore(), root = graph.intern(module), dependency = graph.intern(worker);
  const manifest: ExecutionManifestV1 = { format: 'aether.execution/1', astRoot: root, specRoot: d('spec'), dependencies: [{ symbol: child, declaration: dependency }], semanticsVersion: 'aether-reference/1', compilerDigest: d('compiler'), target: { abiVersion: 'process/1', profileDigest: d('profile'), artifactDigest: d('artifact') }, capabilityPolicyDigest: d('capability'), evidencePolicyDigest: d('evidence') };
  const plan: TopologyPlan = { shape: 'containers', units: [{ id: 'a', members: [main, child], capabilities: [], placement: 'container', memoryMb: 32 }], crossEdges: [], transportLatencyMsPerSecond: 0, monthlyCost: 0, recombinations: [], blockedMerges: [] };
  const registry = new CapabilityRegistry(), storeDirectory = join(directory, 'ast'), collectorDirectory = join(directory, 'gc'), lineageDirectory = join(directory, 'lineage'), hostDirectory = join(directory, 'host');
  let allowed = true;
  const retention = (store = new DurableGraphStore({ directory: storeDirectory })) => {
    const author = generateKeyPairSync('ed25519');
    const lineage = new CausalLineageLedger({ directory: lineageDirectory, repositoryId: 'process-retention', store, authority: () => ({ policyEpoch: '1', eligibleAuthors: ['author'] }), authorKey: () => author.publicKey });
    return new ProcessSemanticRetention({ directory: collectorDirectory, repositoryId: 'process-retention', store, lineage, registry, policy: { epoch: '1', exports: [main], protectedSymbols: [] } });
  };
  const store = new DurableGraphStore({ directory: storeDirectory });
  assert.equal(store.intern(module, { leaseId: 'draft' }), root);
  const semanticCheckpointRetention = retention(store);
  const options: ProcessHostOptions = { directory: hostDirectory, module, manifest, registry, plan, sealer: new CapabilitySealer(new Uint8Array(32).fill(19)), authorizeCheckpoint: () => allowed, semanticCheckpointRetention };
  const session = (host: ProcessHost) => ({ host, module, runtime: { manifest, registry }, tokens: () => host.issueTokens(main) });
  const source = async (host: ProcessHost) => {
    const before = await host.snapshot();
    const runtime = new ResumableRuntime(module, { manifest, registry, executionId: 'retained-task', heapId: before.heapId, ownerEpoch: '0' });
    const seed = seedProcessCheckpoint(runtime.snapshot(), before, host.generation, runtime.program, {});
    runtime.restore(seed.checkpoint, checkpointDigest(seed.checkpoint));
    runtime.start(main, [5n]);
    while (!runtime.inspect().tasks.some(item => item.state === 'pending')) runtime.step();
    return { before, base: seed.checkpoint, initial: runtime.snapshot() };
  };
  return { directory, module, manifest, plan, registry, main, root, dependency, store, storeDirectory, collectorDirectory, lineageDirectory, hostDirectory, options, retention, session, source, allow: (value: boolean) => { allowed = value; } };
}

test('host-bound semantic retention pins exact task/replay roots before checkpoint publication and survives direct collection and reopen', async () => {
  const f = fixture(); let host: ProcessHost | undefined;
  try {
    assert.throws(() => ProcessSemanticRetention.authorityDigest(Object.create(ProcessSemanticRetention.prototype)), /untrusted/);
    host = await ProcessHost.open(f.options);
    const input = await f.source(host);
    f.allow(false);
    await assert.rejects(ProcessResumableSession.begin(f.session(host), input.base, input.initial, { operationId: 'denied', symbol: f.main, expectedGeneration: '1', expectedSnapshot: runtimeSnapshotDigest(input.before) }), /authorization_denied/);
    assert.equal(f.options.semanticCheckpointRetention!.collector.retentions().length, 0);
    f.allow(true);
    const session = await ProcessResumableSession.begin(f.session(host), input.base, input.initial, { operationId: 'retained-job', symbol: f.main, expectedGeneration: '1', expectedSnapshot: runtimeSnapshotDigest(input.before) });
    assert.ok(session.binding.id);
    const records = f.options.semanticCheckpointRetention!.collector.retentions();
    for (const kind of ['active-task', 'replay']) for (const root of [f.root, f.dependency]) assert.ok(records.some(item => item.kind === kind && item.root === root));
    f.store.release('draft');
    f.options.semanticCheckpointRetention!.collector.collect();
    assert.equal(new GraphStore().intern(f.store.hydrate(f.root)), f.root);
    assert.equal(new GraphStore().intern(f.store.hydrate(f.dependency)), f.dependency);
    assert.equal((await session.run(1)).state, 'running');
    await host.close(); host = undefined;
    await assert.rejects(ProcessHost.open({ ...f.options, semanticCheckpointRetention: undefined }), /configuration/);
    host = await ProcessHost.open({ ...f.options, semanticCheckpointRetention: f.retention(new DurableGraphStore({ directory: f.storeDirectory })) });
    const resumed = ProcessResumableSession.reopen(f.session(host), session.binding.id);
    assert.equal((await resumed.run()).state, 'completed');
    await resumed.commit();
    assert.equal(host.checkpointStatus(session.binding.id).state, 'committed');
  } finally { await host?.close(); }
});

test('host-bound retention rejects removed marker, missing AST root and wrong authority on reopen', async () => {
  for (const damage of ['marker', 'root', 'dependency', 'authority'] as const) {
    const f = fixture(); let host: ProcessHost | undefined;
    try {
      host = await ProcessHost.open(f.options); const input = await f.source(host);
      const session = await ProcessResumableSession.begin(f.session(host), input.base, input.initial, { operationId: 'guarded', symbol: f.main, expectedGeneration: '1', expectedSnapshot: runtimeSnapshotDigest(input.before) });
      if (damage === 'marker') {
        const markerDirectory = join(f.hostDirectory, 'checkpoint-semantic-retention');
        rmSync(join(markerDirectory, readdirSync(markerDirectory)[0]));
        await assert.rejects(host.withCheckpoint(session.binding.id, 'run', host.issueTokens(f.main), async () => { throw new Error('callback reached'); }), /retention marker missing/);
      } else if (damage === 'root' || damage === 'dependency') rmSync(join(f.storeDirectory, 'ast-objects-v1', `${(damage === 'root' ? f.root : f.dependency).slice(7)}.json`));
      await host.close(); host = undefined;
      const options = damage === 'authority' ? { ...f.options, semanticCheckpointRetention: undefined } : f.options;
      await assert.rejects(ProcessHost.open(options), /retention|AST|configuration|ENOENT/);
    } finally { await host?.close(); }
  }
});

test('retention loss at the host publication phase blocks the durable heap decision', async () => {
  const f = fixture(); let host: ProcessHost | undefined;
  try {
    const options = { ...f.options, onPhase: (phase: string) => {
      if (phase === 'checkpoint-before-commit') {
        const markerDirectory = join(f.hostDirectory, 'checkpoint-semantic-retention');
        rmSync(join(markerDirectory, readdirSync(markerDirectory)[0]));
      }
    } };
    host = await ProcessHost.open(options);
    const input = await f.source(host);
    const session = await ProcessResumableSession.begin(f.session(host), input.base, input.initial, { operationId: 'last-check', symbol: f.main, expectedGeneration: '1', expectedSnapshot: runtimeSnapshotDigest(input.before) });
    assert.equal((await session.run()).state, 'completed');
    await assert.rejects(session.commit(), /retention marker missing/);
    assert.equal(host.checkpointStatus(session.binding.id).state, 'active');
    assert.deepEqual(await host.snapshot(), input.before);
  } finally { await host?.close(); }
});

test('controller death before pin and after checkpoint decision preserves the correct AST/lease ordering', async () => {
  for (const boundary of ['before-pin', 'after-lease'] as const) {
    const f = fixture(); let host: ProcessHost | undefined;
    try {
      host = await ProcessHost.open(f.options); const input = await f.source(host);
      const data = { directory: f.directory, module: f.module, manifest: f.manifest, plan: f.plan, main: f.main, base: input.base, initial: input.initial, expectedSnapshot: runtimeSnapshotDigest(input.before), boundary };
      writeFileSync(join(f.directory, 'child-data.json'), encodeStored(data));
      writeFileSync(join(f.directory, 'child.ts'), `
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {generateKeyPairSync} from 'node:crypto';
import {decodeStored} from ${JSON.stringify(new URL('../../src/tier1/persistence.ts', import.meta.url).href)};
import {DurableGraphStore} from ${JSON.stringify(new URL('../../src/tier1/durable-store.ts', import.meta.url).href)};
import {CausalLineageLedger} from ${JSON.stringify(new URL('../../src/tier1/causal-lineage.ts', import.meta.url).href)};
import {CapabilityRegistry,CapabilitySealer} from ${JSON.stringify(new URL('../../src/tier2/ocap.ts', import.meta.url).href)};
import {ProcessSemanticRetention} from ${JSON.stringify(new URL('../../src/tier4/process-semantic-retention.ts', import.meta.url).href)};
import {ProcessHost} from ${JSON.stringify(new URL('../../src/tier4/process-host.ts', import.meta.url).href)};
import {ProcessResumableSession} from ${JSON.stringify(new URL('../../src/tier4/process-resumable.ts', import.meta.url).href)};
const x=decodeStored(readFileSync(${JSON.stringify(join(f.directory, 'child-data.json'))},'utf8'));
let armed=false;
const store=new DurableGraphStore({directory:join(x.directory,'ast'),fault:p=>{if(armed&&x.boundary==='before-pin'&&p==='before-root-publish')process.kill(process.pid,'SIGKILL')}});
const author=generateKeyPairSync('ed25519'),registry=new CapabilityRegistry();
const lineage=new CausalLineageLedger({directory:join(x.directory,'lineage'),repositoryId:'process-retention',store,authority:()=>({policyEpoch:'1',eligibleAuthors:['author']}),authorKey:()=>author.publicKey});
const semanticCheckpointRetention=new ProcessSemanticRetention({directory:join(x.directory,'gc'),repositoryId:'process-retention',store,lineage,registry,policy:{epoch:'1',exports:[x.main],protectedSymbols:[]}});
const host=await ProcessHost.open({directory:join(x.directory,'host'),module:x.module,manifest:x.manifest,plan:x.plan,registry,sealer:new CapabilitySealer(new Uint8Array(32).fill(19)),authorizeCheckpoint:()=>true,semanticCheckpointRetention,onPhase:p=>{if(x.boundary==='after-lease'&&p==='checkpoint-started')process.kill(process.pid,'SIGKILL')}});
armed=true;
await ProcessResumableSession.begin({host,module:x.module,runtime:{manifest:x.manifest,registry},tokens:()=>host.issueTokens(x.main)},x.base,x.initial,{operationId:'crash-lease',symbol:x.main,expectedGeneration:'1',expectedSnapshot:x.expectedSnapshot});
throw Error('expected SIGKILL');
`);
      await host.close(); host = undefined;
      const killed = spawnSync(process.execPath, ['--experimental-strip-types', join(f.directory, 'child.ts')], { encoding: 'utf8', timeout: 90_000 });
      assert.equal(killed.signal, 'SIGKILL', `${boundary}: ${killed.stderr}`);
      host = await ProcessHost.open(f.options);
      if (boundary === 'before-pin') {
        await assert.rejects(Promise.resolve().then(() => host!.checkpointStatus(d('no-lease'))), /unknown checkpoint lease/);
        const retry = await ProcessResumableSession.begin(f.session(host), input.base, input.initial, { operationId: 'crash-lease', symbol: f.main, expectedGeneration: '1', expectedSnapshot: runtimeSnapshotDigest(input.before) });
        assert.equal((await retry.run()).state, 'completed'); await retry.commit();
      } else {
        const lease = JSON.parse(readFileSync(join(f.hostDirectory, 'host.json'), 'utf8')).checkpointLeases[0];
        const resumed = ProcessResumableSession.reopen(f.session(host), lease.binding.id);
        f.store.release('draft'); f.options.semanticCheckpointRetention!.collector.collect();
        assert.equal((await resumed.run()).state, 'completed'); await resumed.commit();
      }
    } finally { await host?.close(); }
  }
});
