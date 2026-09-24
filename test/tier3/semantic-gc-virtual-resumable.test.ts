import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import * as b from '../../src/tier1/build.ts';
import type { Term } from '../../src/tier1/ast.ts';
import { GraphStore } from '../../src/tier1/store.ts';
import { SymbolSpace } from '../../src/tier1/symbols.ts';
import type { SymbolId, CapabilityName } from '../../src/tier1/ids.ts';
import { CapabilityRegistry } from '../../src/tier2/ocap.ts';
import { deriveVirtualForwardDescriptor } from '../../src/tier1/semantic-gc-virtual-forward.ts';
import { domainDigest, type ExecutionManifestV1 } from '../../src/fabric/identity.ts';
import { compileResumableProgram, virtualForwardResumableProfileDigest } from '../../src/tier3/resumable-program.ts';
import { ResumableRuntime, type ResumableRuntimeOptions } from '../../src/tier3/resumable-runtime.ts';
import { ResumableCheckpointStore } from '../../src/tier3/resumable-checkpoint.ts';
import { encodeStored } from '../../src/tier1/persistence.ts';
import { ProcessResumableSession } from '../../src/tier4/process-resumable.ts';

type Module = Extract<Term, { kind: 'Module' }>;
const directories: string[] = [];
function temporary(): string { const path = mkdtempSync(join(tmpdir(), 'aether-virtual-resumable-')); directories.push(path); return path; }
after(() => directories.forEach(path => rmSync(path, { recursive: true, force: true })));
const digest = (value: string) => domainDigest('aether.virtual-resumable-test/1', value);

function fixture() {
  const symbols = new SymbolSpace('virtual-resumable'), target = symbols.define('target'), wrapper = symbols.define('wrapper');
  const entry = symbols.define('entry'), pure = symbols.define('pure'), direct = symbols.define('direct');
  const x = symbols.define('x'), w = symbols.define('w'), n = symbols.define('n'), y = symbols.define('y');
  const registry = new CapabilityRegistry();
  const append = registry.declare('cap:test:append', { arity: 1, description: 'observed append' }).name;
  const targetDecl = b.fn({ symbol: target, params: [b.param(x, b.Int)], returns: b.Int,
    contract: b.contract({}), body: b.ret(b.add(b.v(x), b.int(1))) });
  const wrapperDecl = b.fn({ symbol: wrapper, params: [b.param(w, b.Int)], returns: b.Int,
    contract: b.contract({}), body: b.block(b.ret(b.call(target, b.v(w)))) });
  const entryDecl = (callee: typeof target) => b.fn({ symbol: entry, params: [b.param(n, b.Int)], returns: b.Int,
    purity: 'effectful', capabilities: [append], contract: b.contract({}),
    body: b.block(b.let_(y, b.Int, b.call(callee, b.v(n))), b.exprStmt(b.invoke(append, b.v(y))), b.ret(b.v(y))) });
  const directDecl = b.fn({ symbol: direct, params: [b.param(n, b.Int)], returns: b.Int,
    contract: b.contract({}), body: b.ret(b.call(target, b.v(n))) });
  const pureDecl = (callee: typeof target) => b.fn({ symbol: pure, params: [b.param(n, b.Int)], returns: b.Int,
    contract: b.contract({}), body: b.ret(b.call(callee, b.v(n))) });
  const source = b.module_({ symbol: symbols.define('module'), symbolTable: symbols.table(),
    members: [targetDecl, wrapperDecl, entryDecl(wrapper), pureDecl(wrapper), directDecl] }) as Module;
  const candidate: Module = { ...source, members: [targetDecl, entryDecl(target), pureDecl(target), directDecl] };
  const descriptor = deriveVirtualForwardDescriptor(source, candidate, wrapper, target);
  const store = new GraphStore();
  const dependencies = [{ symbol: target, declaration: store.intern(targetDecl) },
    { symbol: wrapper, declaration: store.intern(wrapperDecl) }].sort((a, b) => a.symbol.localeCompare(b.symbol));
  const manifest = (module: Module, profileDigest: string): ExecutionManifestV1 => ({
    format: 'aether.execution/1', astRoot: store.intern(module), specRoot: digest('spec'), dependencies,
    semanticsVersion: 'aether-reference/1', compilerDigest: digest('compiler'),
    target: { abiVersion: 'resumable/1', profileDigest, artifactDigest: digest('artifact') },
    capabilityPolicyDigest: digest('caps'), evidencePolicyDigest: digest('evidence'),
  });
  const sourceManifest = manifest(source, digest('source-profile'));
  const candidateManifest = manifest(candidate, virtualForwardResumableProfileDigest(descriptor));
  const sourceOptions = { manifest: sourceManifest, registry, executionId: 'virtual-resumable' };
  const candidateOptions = { manifest: candidateManifest, registry, executionId: 'virtual-resumable',
    dependencies: [wrapperDecl], virtualForward: { source, descriptor } };
  return { source, candidate, descriptor, wrapperDecl, registry, append, entry, pure, direct,
    target, sourceOptions, candidateOptions, candidateManifest };
}

function runWorld(module: Module, options: ResumableRuntimeOptions, cap: CapabilityName, symbol: SymbolId, maxSteps: number) {
  const runtime = new ResumableRuntime(module, { ...options, maxSteps, capabilities: () => [cap] });
  runtime.start(symbol, [2n]);
  let quota = false;
  try { runtime.run(); } catch (error) { assert.match(String(error), /instruction budget/); quota = true; }
  const snapshot = runtime.snapshot();
  return { runtime, quota, result: runtime.result(), frames: snapshot.core.frames,
    events: snapshot.events.map(event => ({ code: event.code, pc: event.pc, op: event.op })) };
}

test('checked opt-in compiles exactly the source bytecode with archived wrapper frames', () => {
  const f = fixture();
  const source = compileResumableProgram(f.source, f.sourceOptions);
  const candidate = compileResumableProgram(f.candidate, f.candidateOptions);
  assert.deepEqual(candidate.codes, source.codes);
  assert.ok(candidate.codes.some(code => code.id === `function:${f.descriptor.wrapper}`));
  assert.notEqual(candidate.profileDigest, source.profileDigest);
  assert.deepEqual(candidate.manifest.dependencies, source.manifest.dependencies);
});

test('tight bytecode quotas, effect instruction timing, direct calls and frames match source', () => {
  const f = fixture();
  for (const symbol of [f.entry, f.pure, f.direct, f.target]) for (let maxSteps = 1; maxSteps <= 35; maxSteps++) {
    const original = runWorld(f.source, f.sourceOptions, f.append, symbol, maxSteps);
    const rewritten = runWorld(f.candidate, f.candidateOptions, f.append, symbol, maxSteps);
    assert.deepEqual({ quota: rewritten.quota, result: rewritten.result, frames: rewritten.frames,
      events: rewritten.events },
    { quota: original.quota, result: original.result, frames: original.frames,
      events: original.events }, `symbol ${symbol}, budget ${maxSteps}`);
  }
  const source = runWorld(f.source, f.sourceOptions, f.append, f.entry, 100);
  const candidate = runWorld(f.candidate, f.candidateOptions, f.append, f.entry, 100);
  assert.equal(source.result.state, 'faulted'); // No broker is admitted in this slice.
  assert.deepEqual(candidate.events, source.events);
  const wrapperReturn = candidate.events.findIndex(event => event.code === `function:${f.descriptor.wrapper}` && event.op === 'return');
  const effect = candidate.events.findIndex(event => event.code === `function:${f.entry}` && event.op === 'effect');
  assert.ok(wrapperReturn >= 0 && effect > wrapperReturn, 'effect instruction must follow the archived wrapper return');
});

test('checkpoint after entering the archived wrapper restores and resumes identically', () => {
  const f = fixture(), options = { ...f.candidateOptions, maxSteps: 100, capabilities: () => [f.append] };
  const paused = new ResumableRuntime(f.candidate, options);
  paused.start(f.pure, [2n]);
  while (!paused.inspect().frames.some(frame => frame.code === `function:${f.descriptor.wrapper}`)) paused.step();
  const directory = temporary();
  const checkpoints = new ResumableCheckpointStore({ directory, program: paused.program, executionId: options.executionId });
  const head = checkpoints.save(paused.snapshot(), null);
  const resumed = new ResumableRuntime(f.candidate, options);
  resumed.restore(checkpoints.load(head.id), head.snapshot);
  assert.deepEqual(resumed.snapshot(), paused.snapshot());
  assert.deepEqual(resumed.run(), paused.run());
  assert.deepEqual(resumed.snapshot(), paused.snapshot());
  assert.equal(resumed.result().state, 'completed');
  assert.equal(resumed.decodeValue(resumed.result().value!), 3n);
});

test('fresh process restores the archived wrapper frame and reaches the same result', () => {
  const f = fixture(), options = { ...f.candidateOptions, maxSteps: 100 };
  const original = new ResumableRuntime(f.candidate, options); original.start(f.pure, [4n]);
  while (!original.inspect().frames.some(frame => frame.code === `function:${f.descriptor.wrapper}`)) original.step();
  const directory = temporary(), checkpoints = new ResumableCheckpointStore({ directory: join(directory, 'checkpoints'),
    program: original.program, executionId: options.executionId });
  checkpoints.save(original.snapshot(), null);
  const input = join(directory, 'input.json');
  writeFileSync(input, encodeStored({ module: f.candidate, source: f.source, descriptor: f.descriptor,
    wrapper: f.wrapperDecl, manifest: f.candidateManifest }));
  const script = `import{readFileSync}from'node:fs';import{decodeStored}from ${JSON.stringify(new URL('../../src/tier1/persistence.ts', import.meta.url).href)};import{CapabilityRegistry}from ${JSON.stringify(new URL('../../src/tier2/ocap.ts', import.meta.url).href)};import{ResumableRuntime}from ${JSON.stringify(new URL('../../src/tier3/resumable-runtime.ts', import.meta.url).href)};import{ResumableCheckpointStore}from ${JSON.stringify(new URL('../../src/tier3/resumable-checkpoint.ts', import.meta.url).href)};const d=decodeStored(readFileSync(${JSON.stringify(input)},'utf8'));const registry=new CapabilityRegistry();registry.declare('cap:test:append',{arity:1,description:'observed append'});const runtime=new ResumableRuntime(d.module,{manifest:d.manifest,registry,executionId:'virtual-resumable',dependencies:[d.wrapper],virtualForward:{source:d.source,descriptor:d.descriptor},maxSteps:100});const store=new ResumableCheckpointStore({directory:${JSON.stringify(join(directory, 'checkpoints'))},program:runtime.program,executionId:'virtual-resumable'});const head=store.head();runtime.restore(store.load(),head.snapshot);console.log(JSON.stringify({frames:runtime.inspect().frames.map(f=>f.code),result:runtime.run()}));`;
  const child = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', script], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  const output = JSON.parse(child.stdout);
  assert.ok(output.frames.includes(`function:${f.descriptor.wrapper}`));
  assert.equal(output.result.state, 'completed');
  assert.equal(output.result.value.value, '5');
  assert.equal(original.run().state, 'completed');
});

test('unadmitted effect broker and ProcessHost routes reject the profile before side effects', async () => {
  const f = fixture();
  assert.throws(() => new ResumableRuntime(f.candidate, { ...f.candidateOptions,
    effects: {} as never }), /not admitted to the effect broker/);
  await assert.rejects(() => ProcessResumableSession.begin({ host: null as never, module: f.candidate,
    runtime: f.candidateOptions, tokens: () => [] }, null as never, null as never, null as never), /does not admit virtual forward/);
  assert.throws(() => ProcessResumableSession.reopen({ host: null as never, module: f.candidate,
    runtime: f.candidateOptions, tokens: () => [] }, digest('binding')), /does not admit virtual forward/);
});

test('descriptor, archived declaration and manifest identity mismatches fail before execution', () => {
  const f = fixture();
  let invoked = 0;
  const accessor = { ...f.descriptor };
  Object.defineProperty(accessor, 'sites', { enumerable: true, get() { invoked++; return []; } });
  assert.throws(() => compileResumableProgram(f.candidate, { ...f.candidateOptions,
    virtualForward: { source: f.source, descriptor: accessor } }), /accessor|canonical/);
  assert.equal(invoked, 0, 'descriptor accessor must be refused before structuredClone');
  assert.throws(() => compileResumableProgram(f.candidate, { ...f.candidateOptions,
    virtualForward: new Proxy({ source: f.source, descriptor: f.descriptor }, {}) }), /proxy/);
  assert.throws(() => compileResumableProgram(f.candidate, { ...f.candidateOptions,
    virtualForward: { source: f.source, descriptor: { ...f.descriptor, sites: [] } } }), /descriptor/);
  assert.throws(() => compileResumableProgram(f.candidate, { ...f.candidateOptions,
    dependencies: [f.source.members[0]] }), /archived wrapper|dependency/);
  assert.throws(() => compileResumableProgram(f.candidate, { ...f.candidateOptions,
    manifest: { ...f.candidateManifest, target: { ...f.candidateManifest.target, profileDigest: digest('unbound') } } }), /profile/);
  assert.throws(() => compileResumableProgram(f.candidate, { ...f.candidateOptions,
    manifest: { ...f.candidateManifest, dependencies: f.candidateManifest.dependencies.filter(dep => dep.symbol !== f.descriptor.wrapper) } }), /dependency/);
  assert.throws(() => compileResumableProgram(f.candidate, { ...f.candidateOptions,
    manifest: { ...f.candidateManifest, dependencies: f.candidateManifest.dependencies.filter(dep => dep.symbol !== f.descriptor.target) } }), /dependency/);
  assert.throws(() => compileResumableProgram(f.candidate, { ...f.candidateOptions, virtualForward: undefined }), /virtual forward/);
});
