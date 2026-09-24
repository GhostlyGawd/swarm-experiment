import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import * as b from '../../src/tier1/build.ts';
import { SymbolSpace } from '../../src/tier1/symbols.ts';
import { GraphStore } from '../../src/tier1/store.ts';
import { DurableGraphStore } from '../../src/tier1/durable-store.ts';
import { CausalLineageLedger } from '../../src/tier1/causal-lineage.ts';
import { CapabilityRegistry } from '../../src/tier2/ocap.ts';
import { domainDigest, type ExecutionManifestV1 } from '../../src/fabric/identity.ts';
import { encodeCanonical } from '../../src/fabric/encoding.ts';
import { encodeStored } from '../../src/tier1/persistence.ts';
import { ResumableRuntime } from '../../src/tier3/resumable-runtime.ts';
import { ResumableCheckpointStore } from '../../src/tier3/resumable-checkpoint.ts';
import { CheckpointSemanticRetention } from '../../src/tier3/checkpoint-semantic-retention.ts';

const directories: string[] = [];
after(() => directories.forEach(directory => rmSync(directory, { recursive: true, force: true })));
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'aether-direct-retention-')); directories.push(directory);
  const symbols = new SymbolSpace('direct-retention'), entry = symbols.define('entry'), helper = symbols.define('helper'), x = symbols.define('x');
  const dependency = b.fn({ symbol: helper, params: [b.param(x, b.Int)], returns: b.Int, body: b.ret(b.add(b.v(x), b.int(1))) });
  const module = b.module_({ symbol: symbols.define('module'), symbolTable: symbols.table(), members: [b.fn({ symbol: entry, params: [b.param(x, b.Int)], returns: b.Int, body: b.ret(b.call(helper, b.v(x))) })] });
  const storeDirectory = join(directory, 'ast'), checkpointDirectory = join(directory, 'checkpoints');
  const store = new DurableGraphStore({ directory: storeDirectory });
  const root = store.intern(module, { leaseId: 'draft' }), declaration = store.intern(dependency, { leaseId: 'draft' });
  const d = (value: string) => domainDigest('aether.direct-retention-test/1', value);
  const manifest: ExecutionManifestV1 = { format: 'aether.execution/1', astRoot: root, specRoot: d('spec'), dependencies: [{ symbol: helper, declaration }], semanticsVersion: 'aether-reference/1', compilerDigest: d('compiler'), target: { abiVersion: 'resumable/1', profileDigest: d('profile'), artifactDigest: d('artifact') }, capabilityPolicyDigest: d('caps'), evidencePolicyDigest: d('evidence') };
  const registry = new CapabilityRegistry(), executionId = 'direct-execution';
  const runtime = () => new ResumableRuntime(module, { manifest, registry, executionId, dependencies: [dependency] });
  const gcOptions = (graph = store) => ({ directory: join(directory, 'gc'), repositoryId: 'direct-retention', store: graph,
    lineage: new CausalLineageLedger({ directory: join(directory, 'lineage'), repositoryId: 'direct-retention', store: graph,
      authority: () => ({ policyEpoch: '0', eligibleAuthors: ['author'] }), authorKey: () => undefined }), registry,
    policy: { epoch: '1', exports: [entry], protectedSymbols: [] } });
  const authority = () => new CheckpointSemanticRetention(gcOptions());
  return { directory, storeDirectory, checkpointDirectory, store, root, declaration, manifest, module, dependency, registry, executionId, entry, runtime, gcOptions, authority };
}

test('direct checkpoint pins exact module and external dependency before head publication and survives draft release, collection, and reopen', () => {
  const f = fixture(), runtime = f.runtime(); runtime.start(f.entry, [2n]);
  // The entry is a local declaration; the external helper remains a separate AST root.
  const retention = f.authority(), checkpoints = new ResumableCheckpointStore({ directory: f.checkpointDirectory, program: runtime.program, executionId: f.executionId, semanticRetention: retention });
  const head = checkpoints.save(runtime.snapshot(), null);
  f.store.release('draft'); retention.collector.collect();
  assert.equal(f.store.hydrate(f.root).kind, 'Module');
  assert.equal(f.store.hydrate(f.declaration).kind, 'FunctionDecl');
  const reopenedStore = new DurableGraphStore({ directory: f.storeDirectory });
  const reopened = new CheckpointSemanticRetention(f.gcOptions(reopenedStore));
  const checkpointsAgain = new ResumableCheckpointStore({ directory: f.checkpointDirectory, program: runtime.program, executionId: f.executionId, semanticRetention: reopened });
  assert.deepEqual(encodeCanonical(checkpointsAgain.load(head.id)), encodeCanonical(runtime.snapshot()));
  assert.equal(reopened.collector.retentions().filter(record => record.kind === 'replay').length, 2);
  assert.throws(() => new ResumableCheckpointStore({ directory: f.checkpointDirectory, program: runtime.program, executionId: f.executionId }), /profile mismatch|authority required/);
});

test('direct checkpoint rejects missing marker, replay records, graph leases, and collector profile on load and reopen', () => {
  for (const failure of ['marker', 'record', 'record-tamper', 'lease', 'profile'] as const) {
    const f = fixture(), runtime = f.runtime(), authority = f.authority();
    const checkpoints = new ResumableCheckpointStore({ directory: f.checkpointDirectory, program: runtime.program, executionId: f.executionId, semanticRetention: authority });
    const head = checkpoints.save(runtime.snapshot(), null);
    if (failure === 'marker') unlinkSync(join(f.checkpointDirectory, 'semantic-retention-v1.json'));
    if (failure === 'record') unlinkSync(join(f.directory, 'gc', 'retention', readdirSync(join(f.directory, 'gc', 'retention'))[0]));
    if (failure === 'record-tamper') {
      const path = join(f.directory, 'gc', 'retention', readdirSync(join(f.directory, 'gc', 'retention'))[0]);
      const record = JSON.parse(readFileSync(path, 'utf8'));
      writeFileSync(path, JSON.stringify({ ...record, record: { ...record.record, reference: 'changed' } }));
    }
    if (failure === 'lease') {
      const lease = Object.keys(f.store.roots().leases).find(item => item.startsWith('semantic-gc-retention:'))!;
      f.store.release(lease);
    }
    if (failure === 'profile') unlinkSync(join(f.directory, 'gc', 'profile.json'));
    assert.throws(() => checkpoints.load(head.id), /semantic retention|profile/);
    assert.throws(() => new ResumableCheckpointStore({ directory: f.checkpointDirectory, program: runtime.program, executionId: f.executionId, semanticRetention: authority }), /semantic retention|profile/);
  }
});

test('direct checkpoint rejects altered marker and cannot attach retention to a legacy journal', () => {
  const f = fixture(), runtime = f.runtime(), authority = f.authority();
  const checkpoints = new ResumableCheckpointStore({ directory: f.checkpointDirectory, program: runtime.program, executionId: f.executionId, semanticRetention: authority });
  checkpoints.save(runtime.snapshot(), null);
  const path = join(f.checkpointDirectory, 'semantic-retention-v1.json'), marker = JSON.parse(readFileSync(path, 'utf8'));
  writeFileSync(path, JSON.stringify({ ...marker, reference: 'altered' }));
  assert.throws(() => checkpoints.load(), /marker corrupt|marker identity changed/);
  const legacy = fixture(), machine = legacy.runtime();
  new ResumableCheckpointStore({ directory: legacy.checkpointDirectory, program: machine.program, executionId: legacy.executionId });
  assert.throws(() => new ResumableCheckpointStore({ directory: legacy.checkpointDirectory, program: machine.program, executionId: legacy.executionId, semanticRetention: legacy.authority() }), /profile mismatch/);
});

test('direct replay authority rejects a forged program digest before journal publication', () => {
  const f = fixture(), program = f.runtime().program;
  const forged = { ...program, digest: domainDigest('aether.direct-retention-test/1', 'forged-program') };
  assert.throws(() => new ResumableCheckpointStore({ directory: f.checkpointDirectory,
    program: forged, executionId: f.executionId, semanticRetention: f.authority() }), /program digest mismatch/);
});

for (const point of ['before-head-publish', 'after-head-publish'] as const) test(`direct checkpoint ${point} fault leaves valid prior or next head with all replay pins`, () => {
  const f = fixture(), runtime = f.runtime(), authority = f.authority();
  const stable = new ResumableCheckpointStore({ directory: f.checkpointDirectory, program: runtime.program, executionId: f.executionId, semanticRetention: authority });
  const first = stable.save(runtime.snapshot(), null); runtime.start(f.entry, [1n]);
  const faulted = new ResumableCheckpointStore({ directory: f.checkpointDirectory, program: runtime.program, executionId: f.executionId, semanticRetention: authority,
    fault: stage => { if (stage === point) throw new Error('simulated process interruption'); } });
  assert.throws(() => faulted.save(runtime.snapshot(), first.id), /simulated process interruption/);
  f.store.release('draft'); authority.collector.collect();
  const reopened = new ResumableCheckpointStore({ directory: f.checkpointDirectory, program: runtime.program, executionId: f.executionId, semanticRetention: new CheckpointSemanticRetention(f.gcOptions(new DurableGraphStore({ directory: f.storeDirectory }))) });
  const latest = reopened.head()!;
  assert.equal(latest.generation, point === 'before-head-publish' ? 1 : 2);
  assert.ok(reopened.load(latest.id));
  assert.equal(f.store.hydrate(f.declaration).kind, 'FunctionDecl');
});

for (const point of ['before-head-publish', 'after-head-publish'] as const) test(`actual process death ${point} keeps direct checkpoint replay roots`, () => {
  const f = fixture(), runtime = f.runtime(), authority = f.authority();
  const initial = new ResumableCheckpointStore({ directory: f.checkpointDirectory, program: runtime.program, executionId: f.executionId, semanticRetention: authority });
  const first = initial.save(runtime.snapshot(), null); runtime.start(f.entry, [7n]);
  const metadata = join(f.directory, 'child-input.json');
  writeFileSync(metadata, encodeStored({ program: runtime.program, snapshot: runtime.snapshot(), expectedHead: first.id }));
  const url = (path: string) => JSON.stringify(new URL(path, import.meta.url).href);
  const source = `import {readFileSync} from 'node:fs';
    import {join} from 'node:path';
    import {decodeStored} from ${url('../../src/tier1/persistence.ts')};
    import {DurableGraphStore} from ${url('../../src/tier1/durable-store.ts')};
    import {CausalLineageLedger} from ${url('../../src/tier1/causal-lineage.ts')};
    import {CapabilityRegistry} from ${url('../../src/tier2/ocap.ts')};
    import {CheckpointSemanticRetention} from ${url('../../src/tier3/checkpoint-semantic-retention.ts')};
    import {ResumableCheckpointStore} from ${url('../../src/tier3/resumable-checkpoint.ts')};
    const input=decodeStored(readFileSync(${JSON.stringify(metadata)},'utf8'));
    const directory=${JSON.stringify(f.directory)},store=new DurableGraphStore({directory:join(directory,'ast')});
    const lineage=new CausalLineageLedger({directory:join(directory,'lineage'),repositoryId:'direct-retention',store,authority:()=>({policyEpoch:'0',eligibleAuthors:['author']}),authorKey:()=>undefined});
    const authority=new CheckpointSemanticRetention({directory:join(directory,'gc'),repositoryId:'direct-retention',store,lineage,registry:new CapabilityRegistry(),policy:{epoch:'1',exports:[${JSON.stringify(f.entry)}],protectedSymbols:[]}});
    const checkpoints=new ResumableCheckpointStore({directory:join(directory,'checkpoints'),program:input.program,executionId:'direct-execution',semanticRetention:authority,
      fault:stage=>{if(stage===${JSON.stringify(point)})process.kill(process.pid,'SIGKILL')}});
    checkpoints.save(input.snapshot,input.expectedHead);`;
  const child = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', source], { encoding: 'utf8' });
  assert.equal(child.signal, 'SIGKILL', child.stderr);
  f.store.release('draft'); authority.collector.collect();
  const reopenedStore = new DurableGraphStore({ directory: f.storeDirectory });
  const reopened = new ResumableCheckpointStore({ directory: f.checkpointDirectory, program: runtime.program, executionId: f.executionId,
    semanticRetention: new CheckpointSemanticRetention(f.gcOptions(reopenedStore)) });
  assert.equal(reopened.head()!.generation, point === 'before-head-publish' ? 1 : 2);
  assert.ok(reopened.load());
  assert.equal(reopenedStore.hydrate(f.declaration).kind, 'FunctionDecl');
});
