import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build as b, SymbolSpace, GraphStore, CapabilityRegistry, ProductionRuntime, ResumableCheckpointStore } from '../../src/index.ts';
import { domainDigest, type ExecutionManifestV1 } from '../../src/fabric/identity.ts';

test('production resumable factory persists active frames and resumes through public checkpoint API', () => {
  const symbols = new SymbolSpace('production-resume'), entry = symbols.define('entry'), helper = symbols.define('helper'), x = symbols.define('x'), task = symbols.define('task'), value = symbols.define('value');
  const callee = b.fn({ symbol: helper, params: [b.param(x, b.Int)], returns: b.Int, body: b.ret(b.add(b.v(x), b.int(1))) });
  const main = b.fn({ symbol: entry, params: [b.param(x, b.Int)], returns: b.Int, body: b.block(
    b.let_(task, { t: 'Task', result: b.Int }, b.spawn(b.call(helper, b.v(x)))),
    b.let_(value, b.Int, b.call(helper, b.v(x))), b.ret(b.add(b.v(value), b.await_(b.v(task)))),
  ) });
  const module = b.module_({ symbol: symbols.define('module'), members: [callee, main], symbolTable: symbols.table() }), store = new GraphStore();
  const digest = (value: string) => domainDigest('aether.production-resume-test/1', value);
  const manifest: ExecutionManifestV1 = { format: 'aether.execution/1', astRoot: store.intern(module), specRoot: digest('spec'), dependencies: [{ symbol: helper, declaration: store.intern(callee) }], semanticsVersion: 'aether-reference/1', compilerDigest: digest('compiler'), target: { abiVersion: 'resumable/1', profileDigest: digest('profile'), artifactDigest: digest('artifact') }, capabilityPolicyDigest: digest('caps'), evidencePolicyDigest: digest('evidence') };
  const options = { manifest, registry: new CapabilityRegistry(), executionId: 'production-resume' };
  const running = ProductionRuntime.compileResumable(module, options); running.start(entry, [4n]);
  for (let i = 0; i < 100 && !(running.inspect().frames.length === 2 && running.inspect().tasks.some(task => task.state === 'pending')); i++) running.step();
  const paused = running.snapshot(); assert.equal(paused.core.frames.length, 2); assert.ok(paused.core.tasks.some(task => task.state === 'pending'));
  const directory = mkdtempSync(join(tmpdir(), 'aether-production-resume-'));
  try {
    const checkpoints = new ResumableCheckpointStore({ directory, program: running.program, executionId: options.executionId });
    const head = checkpoints.save(paused, null);
    const resumed = ProductionRuntime.compileResumable(module, options);
    resumed.restore(checkpoints.load(head.id), head.snapshot);
    const completed = resumed.run(); assert.equal(completed.state, 'completed'); assert.equal(resumed.decodeValue(completed.value!), 10n);
    running.run(); assert.deepEqual(resumed.snapshot(), running.snapshot());
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
