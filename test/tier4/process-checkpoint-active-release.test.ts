import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as b from '../../src/tier1/build.ts';
import { DurableGraphStore } from '../../src/tier1/durable-store.ts';
import { CausalLineageLedger } from '../../src/tier1/causal-lineage.ts';
import { GraphStore } from '../../src/tier1/store.ts';
import { SymbolSpace } from '../../src/tier1/symbols.ts';
import { SemanticGarbageCollector } from '../../src/tier1/semantic-gc.ts';
import { decodeCanonical, encodeCanonical } from '../../src/fabric/encoding.ts';
import { createHostJournalWitness, type HostJournalHead } from '../../src/fabric/host-journal-witness.ts';
import { domainDigest, type ExecutionManifestV1 } from '../../src/fabric/identity.ts';
import { runtimeSnapshotDigest } from '../../src/fabric/snapshot.ts';
import { CapabilityRegistry, CapabilitySealer } from '../../src/tier2/ocap.ts';
import { checkpointDigest } from '../../src/tier3/resumable-state.ts';
import { ResumableRuntime } from '../../src/tier3/resumable-runtime.ts';
import { compileResumableProgram } from '../../src/tier3/resumable-program.ts';
import { ProcessHost } from '../../src/tier4/process-host.ts';
import { ProcessResumableSession } from '../../src/tier4/process-resumable.ts';
import { ProcessSemanticRetention } from '../../src/tier4/process-semantic-retention.ts';
import { seedProcessCheckpoint } from '../../src/tier4/process-checkpoint-contract.ts';
import { ProcessCheckpointActiveReleaseAuthority } from '../../src/tier4/process-checkpoint-active-release.ts';
import type { TopologyPlan } from '../../src/tier4/topology.ts';

const directories: string[] = [];
after(() => directories.forEach(path => rmSync(path, { recursive: true, force: true })));

async function fixture(commit = true) {
  const directory = mkdtempSync(join(tmpdir(), 'aether-active-release-')); directories.push(directory);
  const symbols = new SymbolSpace('active-release'), entry = symbols.define('entry'), helper = symbols.define('helper');
  const x = symbols.define('x');
  const dependency = b.fn({ symbol: helper, params: [b.param(x, b.Int)], returns: b.Int,
    body: b.ret(b.add(b.v(x), b.int(1))) });
  const module = b.module_({ symbol: symbols.define('module'), symbolTable: symbols.table(), members: [
    b.fn({ symbol: entry, params: [b.param(x, b.Int)], returns: b.Int,
      body: b.ret(b.call(helper, b.v(x))) }), dependency] });
  const registry = new CapabilityRegistry(), graph = new GraphStore();
  const root = graph.intern(module), helperRoot = graph.intern(dependency);
  const d = (name: string) => domainDigest('aether.active-release-test/1', name);
  const manifest: ExecutionManifestV1 = { format: 'aether.execution/1', astRoot: root, specRoot: d('spec'),
    dependencies: [{ symbol: helper, declaration: helperRoot }], semanticsVersion: 'aether-reference/1',
    compilerDigest: d('compiler'), target: { abiVersion: 'process/1', profileDigest: d('profile'), artifactDigest: d('artifact') },
    capabilityPolicyDigest: d('capability'), evidencePolicyDigest: d('evidence') };
  const plan: TopologyPlan = { shape: 'containers', units: [{ id: 'a', members: [entry, helper], capabilities: [],
    placement: 'container', memoryMb: 32 }], crossEdges: [], transportLatencyMsPerSecond: 0,
    monthlyCost: 0, recombinations: [], blockedMerges: [] };
  const store = new DurableGraphStore({ directory: join(directory, 'ast') });
  store.intern(module, { leaseId: 'draft' }); store.intern(dependency, { leaseId: 'draft' });
  const gcOptions = (graphStore: DurableGraphStore) => ({ directory: join(directory, 'gc'),
    repositoryId: 'active-release-repo', store: graphStore,
    lineage: new CausalLineageLedger({ directory: join(directory, 'lineage'), repositoryId: 'active-release-repo',
      store: graphStore, authority: () => ({ policyEpoch: '0', eligibleAuthors: ['author'] }),
      authorKey: () => generateKeyPairSync('ed25519').publicKey }),
    registry, policy: { epoch: '1', exports: [entry], protectedSymbols: [] } });
  const retention = new ProcessSemanticRetention(gcOptions(store));
  const hostDirectory = join(directory, 'host');
  let host = await ProcessHost.open({ directory: hostDirectory, module, manifest, registry, plan,
    sealer: new CapabilitySealer(new Uint8Array(32).fill(17)), authorizeCheckpoint: () => true,
    semanticCheckpointRetention: retention });
  const before = await host.snapshot();
  const runtime = new ResumableRuntime(module, { manifest, registry, executionId: 'release-execution',
    heapId: before.heapId });
  const program = compileResumableProgram(module, { manifest, registry });
  const seed = seedProcessCheckpoint(runtime.snapshot(), before, host.generation, program, {});
  runtime.restore(seed.checkpoint, checkpointDigest(seed.checkpoint)); runtime.start(entry, [4n]);
  const session = await ProcessResumableSession.begin({ host, module, runtime: { manifest, registry },
    tokens: () => host.issueTokens(entry) }, seed.checkpoint, runtime.snapshot(), {
    operationId: 'release-job', symbol: entry, expectedGeneration: host.generation,
    expectedSnapshot: runtimeSnapshotDigest(before) });
  if (commit) {
    assert.equal((await session.run()).state, 'completed');
    await session.commit();
    assert.equal(host.checkpointStatus(session.binding.id).state, 'committed');
  } else assert.equal(host.checkpointStatus(session.binding.id).state, 'active');
  const raw = decodeCanonical(readFileSync(join(hostDirectory, 'host.json'))) as Record<string, unknown>;
  // The release verifier takes a separately held canonical witness head. This
  // fixture mirrors an actual ProcessHost terminal journal into that interface;
  // production wiring must source it from ProcessHost's V4/V13 witness.
  let head: HostJournalHead = { revision: '1', journal: Buffer.from(encodeCanonical({ ...raw,
    format: 'aether.process-host/4', witnessRevision: '1', checkpointControls: raw.checkpointControls ?? [] })).toString() };
  let outage = false;
  const witness = createHostJournalWitness({ authorityId: 'release-test-operator', repositoryId: 'active-release-repo',
    deploymentId: 'release-test-deployment', hostId: 'release-test-host',
    read: () => { if (outage) throw new Error('witness unavailable'); return head; },
    advance: () => { throw new Error('read-only release witness'); } });
  const authority = new ProcessCheckpointActiveReleaseAuthority({ witness, hostDirectory,
    hostConfiguration: raw.configuration as string, repositoryId: 'active-release-repo', program });
  const collector = new SemanticGarbageCollector({ ...gcOptions(store), activeReleaseAuthority: authority });
  const close = async () => { await host.close(); };
  const updateWitness = (edit: (journal: Record<string, unknown>) => void) => {
    const journal = JSON.parse(head.journal!) as Record<string, unknown>; edit(journal);
    const revision = String(BigInt(head.revision) + 1n); journal.witnessRevision = revision;
    head = { revision, journal: Buffer.from(encodeCanonical(journal)).toString() };
  };
  return { directory, root, helperRoot, entry, store, gcOptions, collector, authority, session, program,
    hostDirectory, close, updateWitness, setOutage: (value: boolean) => { outage = value; },
    rollbackWitness: () => { head = { revision: '0', journal: null }; } };
}

test('V2 releases active-task records after a committed checkpoint while replay remains pinned', async () => {
  const f = await fixture();
  try {
    const proof = f.authority.prove(f.session.binding.id);
    const before = f.collector.retentionHistory();
    assert.equal(before.filter(item => item.kind === 'active-task').length, 2);
    assert.equal(before.filter(item => item.kind === 'replay').length, 2);
    f.collector.releaseCommittedActiveTask(proof);
    f.collector.releaseCommittedActiveTask(proof);
    f.updateWitness(() => {});
    f.collector.releaseCommittedActiveTask(f.authority.prove(f.session.binding.id));
    assert.equal(f.collector.retentionHistory().length, before.length);
    assert.equal(f.collector.retentions().filter(item => item.kind === 'active-task').length, 0);
    assert.equal(f.collector.retentions().filter(item => item.kind === 'replay').length, 2);
    f.store.release('draft'); f.collector.collect();
    const leases = f.store.roots();
    assert.equal(Object.keys(leases.leases).filter(key => key.startsWith('semantic-gc-retention:')).length, 2);
    assert.equal(f.store.hydrate(f.root).kind, 'Module');
    assert.equal(f.store.hydrate(f.helperRoot).kind, 'FunctionDecl');
    assert.throws(() => new SemanticGarbageCollector(f.gcOptions(new DurableGraphStore({ directory: join(f.directory, 'ast') }))), /release authority missing/);
    const reopened = new SemanticGarbageCollector({ ...f.gcOptions(new DurableGraphStore({ directory: join(f.directory, 'ast') })), activeReleaseAuthority: f.authority });
    assert.equal(reopened.retentions().filter(item => item.kind === 'active-task').length, 0);
    assert.equal(reopened.retentions().filter(item => item.kind === 'replay').length, 2);
  } finally { await f.close(); }
});

test('forged receipt, stale proof and witness outage or rollback refuse release', async () => {
  for (const mode of ['forged-proof', 'forged-receipt', 'outage', 'rollback'] as const) {
    const f = await fixture();
    try {
      const proof = f.authority.prove(f.session.binding.id);
      if (mode === 'forged-proof') {
        const changed = { ...proof, receipt: domainDigest('aether.process-checkpoint-receipt/1', 'forged') };
        assert.throws(() => f.collector.releaseCommittedActiveTask(changed), /identity changed/);
      } else if (mode === 'forged-receipt') {
        f.updateWitness(journal => {
          const rows = journal.checkpointReceipts as Array<Record<string, unknown>>;
          rows[0].effectAudit = domainDigest('aether.process-checkpoint-effects/1', 'forged');
        });
        assert.throws(() => f.collector.releaseCommittedActiveTask(proof), /receipt|witness/);
      } else if (mode === 'outage') {
        f.setOutage(true);
        assert.throws(() => f.collector.releaseCommittedActiveTask(proof), /witness unavailable/);
      } else {
        f.rollbackWitness();
        assert.throws(() => f.collector.releaseCommittedActiveTask(proof), /rolled back/);
      }
      assert.equal(f.collector.retentionHistory().filter(item => item.kind === 'active-task').length, 2);
      assert.equal(Object.keys(f.store.roots().leases).filter(key => key.startsWith('semantic-gc-retention:')).length, 4);
    } finally { await f.close(); }
  }
});

test('an active checkpoint has no release proof and keeps both pin kinds', async () => {
  const f = await fixture(false);
  try {
    assert.throws(() => f.authority.prove(f.session.binding.id), /not committed/);
    assert.equal(f.collector.retentions().filter(item => item.kind === 'active-task').length, 2);
    assert.equal(f.collector.retentions().filter(item => item.kind === 'replay').length, 2);
  } finally { await f.close(); }
});

test('a durable release record survives a crash before physical lease retirement', async () => {
  const f = await fixture();
  try {
    const proof = f.authority.prove(f.session.binding.id), history = f.collector.retentionHistory();
    const configuration = domainDigest('aether.semantic-gc-config/1', decodeCanonical(readFileSync(join(f.directory, 'gc', 'profile.json'))));
    const idFor = (kind: 'active-task' | 'replay') => history.filter(item => item.kind === kind).map(item =>
      domainDigest('aether.semantic-retention/1', { configuration, ...item })).sort();
    const body = { format: 'aether.semantic-retention-release/2', configuration, proof,
      activeRecords: idFor('active-task'), replayRecords: idFor('replay') };
    const id = domainDigest('aether.semantic-retention-release/2', body);
    writeFileSync(join(f.directory, 'gc', 'retention-releases', `${id.split(':').at(-1)}.json`),
      encodeCanonical({ ...body, id }));
    assert.equal(Object.keys(f.store.roots().leases).filter(key => key.startsWith('semantic-gc-retention:')).length, 4);
    const reopened = new SemanticGarbageCollector({ ...f.gcOptions(new DurableGraphStore({ directory: join(f.directory, 'ast') })), activeReleaseAuthority: f.authority });
    assert.equal(reopened.retentions().filter(item => item.kind === 'active-task').length, 0);
    assert.equal(Object.keys(f.store.roots().leases).filter(key => key.startsWith('semantic-gc-retention:')).length, 2);
    assert.equal(readdirSync(join(f.directory, 'gc', 'retention')).length, 4);
  } finally { await f.close(); }
});

test('another process racing a new active pin is serialized or fails closed', async () => {
  const f = await fixture();
  try {
    const input = join(f.directory, 'race.json'), script = join(f.directory, 'race.ts');
    writeFileSync(input, JSON.stringify({ directory: f.directory, root: f.root }));
    const url = (path: string) => JSON.stringify(new URL(path, import.meta.url).href);
    writeFileSync(script, `
import {readFileSync} from 'node:fs'; import {join} from 'node:path';
import {DurableGraphStore} from ${url('../../src/tier1/durable-store.ts')};
import {CausalLineageLedger} from ${url('../../src/tier1/causal-lineage.ts')};
import {CapabilityRegistry} from ${url('../../src/tier2/ocap.ts')};
import {SemanticGarbageCollector} from ${url('../../src/tier1/semantic-gc.ts')};
const x=JSON.parse(readFileSync(${JSON.stringify(input)},'utf8'));
const store=new DurableGraphStore({directory:join(x.directory,'ast')});
const registry=new CapabilityRegistry();
const lineage=new CausalLineageLedger({directory:join(x.directory,'lineage'),repositoryId:'active-release-repo',store,
  authority:()=>({policyEpoch:'0',eligibleAuthors:['author']}),authorKey:()=>undefined});
const gc=new SemanticGarbageCollector({directory:join(x.directory,'gc'),repositoryId:'active-release-repo',store,lineage,
  registry,policy:{epoch:'1',exports:[${JSON.stringify(f.entry)}],protectedSymbols:[]}});
process.stdout.write('ready\\n');
process.stdin.once('data',()=>{try{gc.retain({kind:'active-task',reference:'raced-task',root:x.root});process.stdout.write('retained\\n');}
catch(e){process.stdout.write('rejected:'+String(e)+'\\n');}process.exit(0);});
`);
    const child = spawn(process.execPath, ['--experimental-strip-types', script], { stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', errors = '';
    child.stdout.on('data', chunk => { output += String(chunk); });
    child.stderr.on('data', chunk => { errors += String(chunk); });
    await new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error(`race child not ready: ${errors}`)), 10_000);
      const poll = setInterval(() => { if (output.includes('ready\n')) { clearInterval(poll); clearTimeout(deadline); resolve(); } }, 10);
      child.once('exit', code => { if (!output.includes('ready\n')) { clearInterval(poll); clearTimeout(deadline); reject(new Error(`race child exited ${code}: ${errors}`)); } });
    });
    const exited = new Promise<number | null>(resolve => child.once('exit', resolve));
    child.stdin.write('go\n');
    f.collector.releaseCommittedActiveTask(f.authority.prove(f.session.binding.id));
    const code = await exited;
    assert.equal(code, 0, errors);
    assert.match(output, /retained|rejected/);
    const raced = f.collector.retentions().filter(item => item.reference === 'raced-task');
    assert.equal(raced.length, output.includes('retained') ? 1 : 0);
    assert.equal(f.collector.retentions().filter(item => item.kind === 'replay').length, 2);
  } finally { await f.close(); }
});
