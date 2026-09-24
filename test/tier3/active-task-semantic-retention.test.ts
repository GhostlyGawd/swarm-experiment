import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import * as b from '../../src/tier1/build.ts';
import { SymbolSpace } from '../../src/tier1/symbols.ts';
import { DurableGraphStore } from '../../src/tier1/durable-store.ts';
import { CausalLineageLedger } from '../../src/tier1/causal-lineage.ts';
import { CapabilityRegistry } from '../../src/tier2/ocap.ts';
import { domainDigest, type ExecutionManifestV1 } from '../../src/fabric/identity.ts';
import { encodeStored, decodeStored } from '../../src/tier1/persistence.ts';
import { ActiveTaskSemanticRetention } from '../../src/tier3/active-task-semantic-retention.ts';
import { ResumableRuntime } from '../../src/tier3/resumable-runtime.ts';
import { checkpointDigest, type ResumableSnapshot } from '../../src/tier3/resumable-state.ts';

const directories: string[] = [];
after(() => directories.forEach(directory => rmSync(directory, { recursive: true, force: true })));
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'aether-active-task-')); directories.push(directory);
  const symbols = new SymbolSpace('active-task-retention'), entry = symbols.define('entry'), helper = symbols.define('helper'), x = symbols.define('x');
  const dependency = b.fn({ symbol: helper, params: [b.param(x, b.Int)], returns: b.Int, body: b.ret(b.add(b.v(x), b.int(1))) });
  const module = b.module_({ symbol: symbols.define('module'), symbolTable: symbols.table(), members: [b.fn({ symbol: entry, params: [b.param(x, b.Int)], returns: b.Int, body: b.ret(b.call(helper, b.v(x))) })] });
  const storeDirectory = join(directory, 'ast'), store = new DurableGraphStore({ directory: storeDirectory });
  const root = store.intern(module, { leaseId: 'draft' }), declaration = store.intern(dependency, { leaseId: 'draft' });
  const d = (value: string) => domainDigest('aether.active-task-retention-test/1', value);
  const manifest: ExecutionManifestV1 = { format: 'aether.execution/1', astRoot: root, specRoot: d('spec'), dependencies: [{ symbol: helper, declaration }], semanticsVersion: 'aether-reference/1', compilerDigest: d('compiler'), target: { abiVersion: 'resumable/1', profileDigest: d('profile'), artifactDigest: d('artifact') }, capabilityPolicyDigest: d('caps'), evidencePolicyDigest: d('evidence') };
  const registry = new CapabilityRegistry(), executionId = 'active-execution';
  const gcOptions = (graph = store) => ({ directory: join(directory, 'gc'), repositoryId: 'active-retention', store: graph,
    lineage: new CausalLineageLedger({ directory: join(directory, 'lineage'), repositoryId: 'active-retention', store: graph,
      authority: () => ({ policyEpoch: '0', eligibleAuthors: ['author'] }), authorKey: () => undefined }), registry,
    policy: { epoch: '1', exports: [entry], protectedSymbols: [] } });
  const authority = () => new ActiveTaskSemanticRetention(gcOptions());
  const runtime = (retention: ActiveTaskSemanticRetention) => new ResumableRuntime(module, { manifest, registry, executionId, dependencies: [dependency], activeTaskRetention: retention });
  const markerPath = () => join(directory, 'gc', 'active-tasks', readdirSync(join(directory, 'gc', 'active-tasks'))[0]);
  return { directory, storeDirectory, store, root, declaration, module, dependency, manifest, registry, executionId, entry, gcOptions, authority, runtime, markerPath };
}

test('active task pins module and dependency before the first frame and survives collection before any checkpoint', () => {
  const f = fixture(), authority = f.authority(), runtime = f.runtime(authority);
  assert.equal(runtime.inspect().state, 'idle');
  runtime.start(f.entry, [2n]);
  assert.equal(runtime.inspect().state, 'running');
  assert.equal(authority.collector.retentions().filter(record => record.kind === 'active-task').length, 2);
  const snapshot = runtime.snapshot();
  f.store.release('draft'); authority.collector.collect();
  assert.equal(f.store.hydrate(f.root).kind, 'Module');
  assert.equal(f.store.hydrate(f.declaration).kind, 'FunctionDecl');
  const reopenedStore = new DurableGraphStore({ directory: f.storeDirectory });
  const reopened = new ActiveTaskSemanticRetention(f.gcOptions(reopenedStore));
  const recovered = new ResumableRuntime(f.module, { manifest: f.manifest, registry: f.registry, executionId: f.executionId,
    dependencies: [f.dependency], activeTaskRetention: reopened });
  recovered.restore(snapshot, checkpointDigest(snapshot));
  const result = recovered.run();
  assert.equal(result.value?.tag, 'int');
  assert.equal(result.value?.tag === 'int' && result.value.value, '3');
});

test('active task rejects missing marker and cannot recreate it from existing pins', () => {
  const f = fixture(), authority = f.authority(), runtime = f.runtime(authority);
  runtime.start(f.entry, [1n]);
  const snapshot = runtime.snapshot();
  unlinkSync(f.markerPath());
  assert.throws(() => runtime.step(), /marker missing/);
  assert.throws(() => runtime.snapshot(), /marker missing/);
  assert.throws(() => f.runtime(authority).restore(snapshot, checkpointDigest(snapshot)), /marker missing/);
  assert.throws(() => f.runtime(authority).start(f.entry, [1n]), /marker missing after pin publication/);
});

test('active task rejects missing retention record, lease, and altered marker before continuing', () => {
  for (const failure of ['record', 'lease', 'marker'] as const) {
    const f = fixture(), authority = f.authority(), runtime = f.runtime(authority);
    runtime.start(f.entry, [1n]);
    if (failure === 'record') unlinkSync(join(f.directory, 'gc', 'retention', readdirSync(join(f.directory, 'gc', 'retention'))[0]));
    if (failure === 'lease') f.store.release(Object.keys(f.store.roots().leases).find(key => key.startsWith('semantic-gc-retention:'))!);
    if (failure === 'marker') {
      const marker = JSON.parse(readFileSync(f.markerPath(), 'utf8'));
      writeFileSync(f.markerPath(), JSON.stringify({ ...marker, reference: 'altered' }));
    }
    assert.throws(() => runtime.step(), /active task semantic retention/);
    assert.equal(runtime.inspect().steps, 0);
  }
});

test('active task refuses a forged authority and program digest before publishing a frame', () => {
  const f = fixture(), authority = f.authority(), runtime = f.runtime(authority);
  assert.throws(() => new ResumableRuntime(f.module, { manifest: f.manifest, registry: f.registry, executionId: f.executionId,
    dependencies: [f.dependency], activeTaskRetention: Object.create(ActiveTaskSemanticRetention.prototype) }), /untrusted direct active task/);
  const forged = { ...runtime.program, digest: domainDigest('aether.active-task-retention-test/1', 'forged') };
  assert.throws(() => authority.prepare(forged, f.executionId), /program digest mismatch/);
  assert.equal(runtime.inspect().state, 'idle');
  assert.equal(authority.collector.retentions().length, 0);
});

test('one execution identity cannot silently switch its manifest after an active pin', () => {
  const f = fixture(), authority = f.authority(), runtime = f.runtime(authority);
  runtime.start(f.entry, [1n]);
  const changedManifest = { ...f.manifest, target: { ...f.manifest.target,
    artifactDigest: domainDigest('aether.active-task-retention-test/1', 'changed-artifact') } };
  const changed = new ResumableRuntime(f.module, { manifest: changedManifest, registry: f.registry, executionId: f.executionId,
    dependencies: [f.dependency], activeTaskRetention: authority });
  assert.throws(() => changed.start(f.entry, [1n]), /marker identity changed/);
  assert.equal(changed.inspect().state, 'idle');
});

test('actual process death after start and before first checkpoint keeps active roots recoverable', () => {
  const f = fixture(), inputs = join(f.directory, 'inputs.json'), output = join(f.directory, 'snapshot.json');
  writeFileSync(inputs, encodeStored({ module: f.module, dependency: f.dependency, manifest: f.manifest }));
  const url = (path: string) => JSON.stringify(new URL(path, import.meta.url).href);
  const source = `import {readFileSync,writeFileSync} from 'node:fs';
    import {join} from 'node:path';
    import {decodeStored,encodeStored} from ${url('../../src/tier1/persistence.ts')};
    import {DurableGraphStore} from ${url('../../src/tier1/durable-store.ts')};
    import {CausalLineageLedger} from ${url('../../src/tier1/causal-lineage.ts')};
    import {CapabilityRegistry} from ${url('../../src/tier2/ocap.ts')};
    import {ActiveTaskSemanticRetention} from ${url('../../src/tier3/active-task-semantic-retention.ts')};
    import {ResumableRuntime} from ${url('../../src/tier3/resumable-runtime.ts')};
    const input=decodeStored(readFileSync(${JSON.stringify(inputs)},'utf8'));
    const directory=${JSON.stringify(f.directory)},store=new DurableGraphStore({directory:join(directory,'ast')});
    const registry=new CapabilityRegistry();
    const lineage=new CausalLineageLedger({directory:join(directory,'lineage'),repositoryId:'active-retention',store,
      authority:()=>({policyEpoch:'0',eligibleAuthors:['author']}),authorKey:()=>undefined});
    const authority=new ActiveTaskSemanticRetention({directory:join(directory,'gc'),repositoryId:'active-retention',store,lineage,registry,
      policy:{epoch:'1',exports:[${JSON.stringify(f.entry)}],protectedSymbols:[]}});
    const runtime=new ResumableRuntime(input.module,{manifest:input.manifest,registry,executionId:'active-execution',
      dependencies:[input.dependency],activeTaskRetention:authority});
    runtime.start(${JSON.stringify(f.entry)},[8n]);
    writeFileSync(${JSON.stringify(output)},encodeStored(runtime.snapshot()));
    process.kill(process.pid,'SIGKILL');`;
  const child = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', source], { encoding: 'utf8' });
  assert.equal(child.signal, 'SIGKILL', child.stderr);
  const snapshot = decodeStored(readFileSync(output, 'utf8')) as ResumableSnapshot;
  f.store.release('draft');
  const reopenedStore = new DurableGraphStore({ directory: f.storeDirectory });
  const authority = new ActiveTaskSemanticRetention(f.gcOptions(reopenedStore));
  authority.collector.collect();
  assert.equal(reopenedStore.hydrate(f.root).kind, 'Module');
  assert.equal(reopenedStore.hydrate(f.declaration).kind, 'FunctionDecl');
  const recovered = f.runtime(authority);
  recovered.restore(snapshot, checkpointDigest(snapshot));
  const result = recovered.run();
  assert.equal(result.value?.tag, 'int');
  assert.equal(result.value?.tag === 'int' && result.value.value, '9');
});
