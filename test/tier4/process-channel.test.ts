import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { encode as encodeIR } from '../../src/tier1/agent-ir.ts';
import * as b from '../../src/tier1/build.ts';
import { typeName, type NodeRef } from '../../src/tier1/ids.ts';
import { SymbolSpace } from '../../src/tier1/symbols.ts';
import type { Term, Ty } from '../../src/tier1/ast.ts';
import { CapabilityRegistry } from '../../src/tier2/ocap.ts';
import { ProductionRuntime } from '../../src/tier3/compile.ts';
import { EffectInvocationError } from '../../src/tier3/effects.ts';
import { createEvidenceManifest } from '../../src/fabric/evidence.ts';
import { domainDigest, executionManifestDigest } from '../../src/fabric/identity.ts';
import { ProcessChannel, ProcessChannelError } from '../../src/tier4/process-channel.ts';
import { ProcessAuthenticator, processBoundaryId, toWireSnapshot, fromWireSnapshot, encodeProcessValue, decodeProcessValue, type ProcessScope } from '../../src/tier4/process-values.ts';

const BOX: Ty = { t: 'Record', name: typeName('type:process:box'), fields: [['count', b.Int]] };
function fixture() {
  const symbols = new SymbolSpace('process-channel');
  const main = symbols.define('main'), remote = symbols.define('remote'), read = symbols.define('read'), account = symbols.define('account'), saved = symbols.define('saved');
  const registry = new CapabilityRegistry();
  const effect = registry.declare('cap:test:tick', { arity: 1, description: 'Test controlled effect.' }).name;
  const field = b.field(b.v(account), 'count');
  const members = [
    b.fn({ symbol: main, params: [b.param(account, BOX)], returns: b.Int, capabilities: [effect],
      contract: b.contract({ requires: [b.clause(b.ge(field, b.int(0)), 'nonnegative')], ensures: [b.clause(b.eq(b.result(), b.add(b.old(field), b.int(11))), 'incremented')], modifies: [b.place(account, 'count')] }),
      body: b.block(b.assign(b.place(account, 'count'), b.add(field, b.int(1))), b.ret(b.call(remote, b.v(account)))) }),
    b.fn({ symbol: remote, params: [b.param(account, BOX)], returns: b.Int, capabilities: [effect], body: b.block(
      b.let_(saved, b.Int, b.call(read, b.v(account))), b.exprStmt(b.invoke(effect, b.v(saved))),
      b.assign(b.place(account, 'count'), b.add(field, b.int(10))), b.ret(field),
    ) }),
    b.fn({ symbol: read, params: [b.param(account, BOX)], returns: b.Int, body: b.block(b.ret(field)) }),
  ];
  const module = b.module_({ symbol: symbols.define('module'), members, symbolTable: symbols.table() });
  const digest = (name: string) => domainDigest('aether.process-test/1', name);
  const manifest = createEvidenceManifest({ module, specification: 'Coherent process state.', semanticsVersion: 'reference/1', registry, compilerDigest: digest('compiler'), capabilityPolicyDigest: digest('caps'), target: { abiVersion: 'local/1', profileDigest: digest('profile'), artifactDigest: digest('artifact') } });
  const init = { module, manifest, capabilities: registry.names.map(name => registry.get(name)!), heapId: 'heap-process-test', ownershipEpoch: '1' };
  const scope: ProcessScope = { executionManifest: executionManifestDigest(manifest), astRoot: manifest.astRoot as NodeRef, heapId: init.heapId, ownershipEpoch: init.ownershipEpoch, unit: 'a' };
  const runtime = ProductionRuntime.compile(module, { registry, policy: 'enforce' });
  const ref = runtime.allocateRecord(BOX, { count: 0n });
  const snapshot = toWireSnapshot(runtime.exportSnapshot(), scope);
  return { init, scope, runtime, ref, snapshot, main, remote, read, effect };
}
function assertExited(pid: number): void { assert.throws(() => process.kill(pid, 0), error => (error as NodeJS.ErrnoException).code === 'ESRCH'); }

test('F07 transport: real child processes support nested cross-calls, effects and coherent heap return', async () => {
  const f = fixture();
  let a: ProcessChannel | undefined, z: ProcessChannel | undefined;
  const effects: { operationId: string; index: number; value: unknown }[] = [];
  try {
    a = await ProcessChannel.start({ ...f.init, unit: 'a', includeSymbols: [f.main, f.read] }, {
      onCall: request => z!.call(request.symbol, request.args, request.snapshot, { operationId: request.operationId }),
    });
    z = await ProcessChannel.start({ ...f.init, unit: 'z', includeSymbols: [f.remote] }, {
      onCall: request => a!.call(request.symbol, request.args, request.snapshot, { operationId: request.operationId }),
      onEffect: request => { effects.push({ operationId: request.operationId, index: request.effectIndex, value: request.args[0] }); return { value: null, snapshot: request.snapshot }; },
    });
    assert.notEqual(a.pid, z.pid); assert.notEqual(a.pid, process.pid);
    assert.equal(a.alive, true); assert.equal(a.isClosed, false);
    const result = await a.call(f.main, [f.ref], f.snapshot, { operationId: 'stable-execution-7' });
    assert.deepEqual(result.execution, { ok: true, value: 11n, steps: 0 });
    assert.deepEqual(effects, [{ operationId: processBoundaryId('stable-execution-7', 'call', 0), index: 1, value: 1n }]);
    assert.equal(result.snapshot.records[0].fields[0][1].tag, 'int');
    f.runtime.importSnapshot(fromWireSnapshot(result.snapshot, f.scope));
    assert.equal(f.runtime.readRecord(f.ref).get('count'), 11n);
    const next = await a.call(f.main, [f.ref], result.snapshot, { operationId: 'stable-execution-8' });
    assert.deepEqual(next.execution, { ok: true, value: 22n, steps: 0 });
    await z.importSnapshot(next.snapshot);
    assert.deepEqual(await z.snapshot(), next.snapshot);
  } finally {
    if (a) { await a.close(); assertExited(a.pid); assert.equal(a.alive, false); assert.equal(a.isClosed, true); }
    if (z) { await z.close(); assertExited(z.pid); assert.equal(z.alive, false); }
  }
});

test('F07 transport: contracts remain enforced and indeterminate effects preserve recovery IDs', async () => {
  const f = fixture();
  const channel = await ProcessChannel.start({ ...f.init, unit: 'single', includeSymbols: [f.main, f.remote, f.read] }, {
    onEffect: request => {
      assert.equal(request.from, f.remote, 'origin is the actual local callee, not the worker entry function');
      throw new EffectInvocationError({ state: 'indeterminate', recoveryId: 'effect-recovery-9' });
    },
  });
  try {
    const result = await channel.call(f.main, [f.ref], f.snapshot);
    assert.equal(result.execution.ok, false);
    if (!result.execution.ok) {
      assert.equal(result.execution.fault.kind, 'effect_indeterminate');
      assert.equal(result.execution.fault.recoveryId, 'effect-recovery-9');
    }
    const negative = { ...f.snapshot, records: [{ ...f.snapshot.records[0], fields: [['count', { tag: 'int', value: '-1' }]] }] } as typeof f.snapshot;
    const denied = await channel.call(f.main, [f.ref], negative);
    assert.equal(denied.execution.ok, false);
    if (!denied.execution.ok) assert.equal(denied.execution.fault.kind, 'precondition');
  } finally { await channel.close(); assertExited(channel.pid); }
});

test('F07 transport: C1 references reject opaque, foreign and stale state before import', async () => {
  const f = fixture();
  assert.throws(() => encodeProcessValue({ task: true, run: () => null }, f.scope), /opaque/);
  assert.throws(() => decodeProcessValue({ tag: 'ref', value: { heapId: 'other', objectId: '1', ownerEpoch: '1' } }, f.scope, f.snapshot), /wrong heap/);
  assert.throws(() => fromWireSnapshot({ ...f.snapshot, executionManifest: domainDigest('aether.execution/1', 'wrong') }, f.scope), /manifest/);
  const channel = await ProcessChannel.start({ ...f.init, unit: 'a', includeSymbols: [f.read], snapshot: f.snapshot });
  try {
    const stale = { ...f.snapshot, ownership: f.snapshot.ownership.map(owner => ({ ...owner, epoch: '0' })) };
    await assert.rejects(channel.importSnapshot(stale), /stale/);
    // Send the same signed stale payload directly to exercise worker-side validation too.
    const raw = channel as unknown as { request(method: string, payload: unknown): Promise<unknown> };
    await assert.rejects(raw.request('import', stale), /stale/);
    await assert.rejects(raw.request('call', { symbol: f.read, args: [{ tag: 'ref', value: { heapId: f.scope.heapId, objectId: '1', ownerEpoch: '0' } }], snapshot: f.snapshot, operationId: 'stale-ref' }), /stale/);
    assert.deepEqual(JSON.parse(JSON.stringify(await channel.snapshot())), f.snapshot);
  } finally { await channel.close(); assertExited(channel.pid); }
});

test('F07 transport: HMAC binds roles, sequences, roots and epochs with bounded framing', () => {
  const f = fixture(), key = new Uint8Array(32).fill(9);
  const session = { sessionId: 'test-session', executionManifest: f.scope.executionManifest, ownershipEpoch: '1', maxFrameBytes: 1024 };
  const parent = new ProcessAuthenticator(key, session, 'parent'), worker = new ProcessAuthenticator(key, session, 'worker');
  const frame = parent.encode({ hello: true });
  assert.equal((worker.decode(frame.subarray(4)) as { hello: boolean }).hello, true);
  assert.throws(() => worker.decode(frame.subarray(4)), /sequence/);
  assert.throws(() => new ProcessAuthenticator(key, { ...session, ownershipEpoch: '2' }, 'worker').decode(frame.subarray(4)), /epoch/);
  assert.throws(() => new ProcessAuthenticator(key, { ...session, executionManifest: domainDigest('aether.execution/1', 'other') }, 'worker').decode(frame.subarray(4)), /root/);
  assert.throws(() => new ProcessAuthenticator(new Uint8Array(32).fill(8), session, 'worker').decode(frame.subarray(4)), /authentication/);
  assert.throws(() => new ProcessAuthenticator(key, session, 'parent').decode(frame.subarray(4)), /role/);
  assert.throws(() => parent.encode({ huge: 'x'.repeat(1024) }), /limit/);
});

test('F07 transport: authenticated-worker tampering and oversized incoming frames terminate without orphans', async () => {
  for (const oversized of [false, true]) {
    const f = fixture();
    const channel = await ProcessChannel.start({ ...f.init, unit: 'a', includeSymbols: [f.read] }, { maxFrameBytes: 64 * 1024 });
    const internal = channel as unknown as { child: ChildProcess; authenticator: ProcessAuthenticator };
    try {
      let attack: Buffer;
      if (oversized) { attack = Buffer.alloc(4); attack.writeUInt32BE(64 * 1024 + 1); }
      else {
        attack = internal.authenticator.encode({ kind: 'request', id: 'tamper', method: 'snapshot', payload: null });
        const index = attack.indexOf(Buffer.from('"mac":"')) + 7;
        assert.ok(index > 7); attack[index] = attack[index] === 48 ? 49 : 48;
      }
      internal.child.stdin!.write(attack);
      await assert.rejects(channel.snapshot(), error => error instanceof ProcessChannelError && ['eof', 'closed', 'protocol'].includes(error.code));
    } finally { await channel.kill(); assertExited(channel.pid); }
  }
});

test('F07 transport: timeout interrupts an actual synchronous worker and EOF rejects pending work', async () => {
  const f = fixture();
  const symbols = new SymbolSpace('process-timeout'), spin = symbols.define('spin');
  const module = b.module_({ symbol: symbols.define('module'), symbolTable: symbols.table(), members: [b.fn({ symbol: spin, returns: b.Int, body: b.block(b.while_(b.bool(true), b.block()), b.ret(b.int(0))) })] });
  const manifest = createEvidenceManifest({ module, specification: 'Timeout fixture.', semanticsVersion: 'reference/1', registry: new CapabilityRegistry(), compilerDigest: f.init.manifest.compilerDigest, capabilityPolicyDigest: f.init.manifest.capabilityPolicyDigest, target: f.init.manifest.target });
  const channel = await ProcessChannel.start({ ...f.init, module, manifest, unit: 'spin', includeSymbols: [spin] });
  try {
    const empty = await channel.snapshot();
    await assert.rejects(channel.call(spin, [], empty, { timeoutMs: 50 }), error => error instanceof ProcessChannelError && error.code === 'timeout' && error.outcomeUnknown);
  } finally { await channel.kill(); assertExited(channel.pid); }
  const eof = await ProcessChannel.start({ ...f.init, unit: 'a', includeSymbols: [f.read] });
  try {
    const internal = eof as unknown as { child: ChildProcess };
    internal.child.stdin!.end();
    await assert.rejects(eof.snapshot(), error => error instanceof ProcessChannelError);
  } finally { await eof.kill(); assertExited(eof.pid); }
});

test('F07 transport: killing the actual parent cannot orphan a worker executing an infinite loop', async () => {
  const f = fixture();
  const syms = new SymbolSpace('parent-death'), spin = syms.define('spin');
  const module = b.module_({ symbol: syms.define('module'), symbolTable: syms.table(), members: [b.fn({ symbol: spin, returns: b.Int, body: b.block(b.while_(b.bool(true), b.block()), b.ret(b.int(0))) })] });
  const manifest = createEvidenceManifest({ module, specification: 'Parent-death fixture.', semanticsVersion: 'reference/1', registry: new CapabilityRegistry(), compilerDigest: f.init.manifest.compilerDigest, capabilityPolicyDigest: f.init.manifest.capabilityPolicyDigest, target: f.init.manifest.target });
  const init = { ...f.init, manifest, module: undefined, unit: 'spin', includeSymbols: [spin] };
  const code = `
    import { ProcessChannel } from ${JSON.stringify(new URL('../../src/tier4/process-channel.ts', import.meta.url).href)};
    import { decode } from ${JSON.stringify(new URL('../../src/tier1/agent-ir.ts', import.meta.url).href)};
    const channel = await ProcessChannel.start({...${JSON.stringify(init)}, module:decode(${JSON.stringify(encodeIR(module).text)})});
    const snapshot = await channel.snapshot();
    const pending = channel.call(${JSON.stringify(spin)}, [], snapshot, {timeoutMs:300000});
    setTimeout(()=>process.stdout.write(JSON.stringify({workerPid:channel.pid})+'\\n'),50);
    await pending;
  `;
  const parent = spawn(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', code], { stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH ?? '', NODE_NO_WARNINGS: '1' } });
  const exited = new Promise<void>(resolve => parent.once('exit', () => resolve()));
  let workerPid: number | undefined;
  try {
    workerPid = await new Promise<number>((resolve, reject) => {
      let stdout = '', stderr = '';
      const timer = setTimeout(() => reject(new Error(`parent helper did not start: ${stderr}`)), 5000);
      parent.stderr!.on('data', chunk => { if (stderr.length < 4096) stderr += String(chunk); });
      parent.stdout!.on('data', chunk => {
        stdout += String(chunk);
        if (stdout.includes('\n')) { clearTimeout(timer); resolve(JSON.parse(stdout.trim()).workerPid); }
      });
    });
    process.kill(workerPid, 0);
    parent.kill('SIGKILL'); await exited;
    let alive = true;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { process.kill(workerPid, 0); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; alive = false; break; }
      await delay(10);
    }
    assert.equal(alive, false, 'worker must detect liveness-pipe EOF during its pure loop');
  } finally {
    parent.kill('SIGKILL'); await exited;
    if (workerPid !== undefined) { try { process.kill(workerPid, 'SIGKILL'); } catch { /* already reaped */ } }
  }
});
