import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { DurableGraphStore, type DurableStoreFault } from '../../src/tier1/durable-store.ts';
import { GraphStore, hashNode } from '../../src/tier1/store.ts';
import { bytesToHexRef, type NodeRef } from '../../src/tier1/ids.ts';
import * as b from '../../src/tier1/build.ts';
import { encodeCanonical } from '../../src/fabric/encoding.ts';
import { blake3 } from '../../src/tier1/blake3.ts';

const directories: string[] = [];
function temporary(): string { const path = mkdtempSync(join(tmpdir(), 'aether-durable-ast-')); directories.push(path); return path; }
after(() => { directories.forEach(path => rmSync(path, { recursive: true, force: true })); });
const moduleUrl = new URL('../../src/tier1/durable-store.ts', import.meta.url).href;
const buildUrl = new URL('../../src/tier1/build.ts', import.meta.url).href;
const objectPath = (directory: string, root: NodeRef): string => join(directory, 'ast-objects-v1', `${root.slice(7)}.json`);
const boot = `import {DurableGraphStore} from ${JSON.stringify(moduleUrl)}; import * as b from ${JSON.stringify(buildUrl)};`;

test('durable AST retains v1 addresses, grouped children, immutable values and dedup across reopen', () => {
  const directory = temporary(), store = new DurableGraphStore({ directory });
  const term = b.block(b.ret(b.add(b.int(20), b.int(22))), b.ret(b.add(b.int(20), b.int(22))));
  const legacy = new GraphStore(), expected = legacy.intern(term);
  const root = store.intern(term, { leaseId: 'draft' });
  assert.equal(root, expected);
  assert.equal(store.listRefs().length, legacy.size);
  assert.deepEqual(store.hydrate(root), term);
  const returned = store.get(root) as unknown as { stmts: NodeRef[] }; returned.stmts.length = 0;
  assert.deepEqual(store.hydrate(root), term, 'callers cannot mutate cached durable content');
  const reopened = new DurableGraphStore({ directory });
  assert.equal(reopened.intern(term, { leaseId: 'second' }), root);
  assert.equal(reopened.listRefs().length, legacy.size);
  const condition = b.bool(true), invariant = b.bool(false), body = b.block();
  const first = reopened.intern(b.while_(condition, body, { invariants: [invariant], variant: null }), { leaseId: 'groups' });
  const second = reopened.intern(b.while_(condition, body, { invariants: [], variant: invariant }), { leaseId: 'groups' });
  assert.notEqual(first, second);
  assert.equal(hashNode(reopened.get(first)), first);
});

test('durable path copying preserves sibling hashes and fork writes no AST objects', () => {
  const store = new DurableGraphStore({ directory: temporary() });
  const root = store.intern(b.add(b.int(1), b.int(2)), { leaseId: 'draft' });
  const changed = store.intern(b.int(3), { leaseId: 'replacement' });
  const next = store.replaceAt(root, [{ field: 'left', index: 0 }], changed, { leaseId: 'edit' });
  assert.notEqual(next, root);
  const node = store.get(root), modified = store.get(next);
  assert.equal(node.kind, 'Bin'); assert.equal(modified.kind, 'Bin');
  if (node.kind === 'Bin' && modified.kind === 'Bin') assert.equal(node.right, modified.right);
  store.commit('main', root, null); const before = store.listRefs();
  assert.deepEqual(store.fork('feature/a', 'main'), { root, generation: 1 });
  assert.deepEqual(store.listRefs(), before);
  assert.throws(() => store.fork('feature/a', 'main'), /exists/);
});

test('GC preserves committed history, explicit leases and both pending promotion roots', () => {
  const directory = temporary(), store = new DurableGraphStore({ directory });
  const roots = [1, 2, 3, 4, 5].map(value => store.intern(b.int(value), { leaseId: `write-${value}` }));
  const head = store.commit('main', roots[0], null);
  store.commit('main', roots[1], head);
  store.stagePromotion('p', { from: roots[2], to: roots[3] });
  for (const value of [1, 2, 3, 4]) store.release(`write-${value}`);
  assert.equal(store.collectGarbage().removedObjects, 0);
  const reopened = new DurableGraphStore({ directory });
  reopened.finishPromotion('p', { kind: 'abort' }); reopened.release('write-5');
  assert.equal(reopened.collectGarbage().removedObjects, 3);
  assert.deepEqual(reopened.listRefs().sort(), roots.slice(0, 2).sort());
  assert.equal(reopened.get(roots[0]).kind, 'Lit', 'historical committed root retained');
});

test('promotion commit publishes target and releases pin atomically with generation CAS', () => {
  const store = new DurableGraphStore({ directory: temporary() });
  const first = store.intern(b.int(1), { leaseId: 'stage' }), second = store.intern(b.int(2), { leaseId: 'stage' });
  const head = store.commit('main', first, null);
  store.stagePromotion('p', { from: first, to: second }); store.release('stage');
  assert.throws(() => store.stagePromotion('p', { from: second, to: first }), /reused/);
  assert.throws(() => store.finishPromotion('p', { kind: 'commit', name: 'main', expected: { root: first, generation: 2 } }), /conflict/);
  assert.ok(store.roots().promotions.p);
  store.finishPromotion('p', { kind: 'commit', name: 'main', expected: head });
  assert.deepEqual(store.head('main'), { root: second, generation: 2 });
  assert.equal(store.roots().promotions.p, undefined);
  store.commit('main', first, store.head('main'));
  assert.throws(() => store.commit('main', second, head), /conflict/, 'same root at a later generation is not the expected head');
  assert.equal(store.collectGarbage().removedObjects, 0);
});

test('archives deterministically round-trip bigints and migration preserves old hashes', () => {
  const legacy = new GraphStore({ directory: temporary() });
  const term = b.add(b.int(2n ** 200n), b.int(-7)); const root = legacy.intern(term);
  const first = new DurableGraphStore({ directory: temporary() });
  assert.deepEqual(first.importLegacy(legacy, [root], { leaseId: 'migration' }), [root]);
  const bytes = first.exportArchive(); assert.deepEqual(first.exportArchive(), bytes);
  const second = new DurableGraphStore({ directory: temporary() });
  assert.deepEqual(second.importArchive(bytes, { leaseId: 'received' }), [root]);
  assert.deepEqual(second.exportArchive(), bytes); assert.deepEqual(second.hydrate(root), term);
  assert.equal(second.head('main'), null, 'import cannot implicitly replace production root');
  assert.equal(second.collectGarbage().removedObjects, 0);
  second.release('received'); assert.equal(second.collectGarbage().removedObjects, 3);
});

test('archive hash, duplicate keys, unsupported versions and missing children reject without publication', () => {
  const first = new DurableGraphStore({ directory: temporary() });
  first.intern(b.add(b.int(1), b.int(2)), { leaseId: 'draft' });
  const bytes = first.exportArchive();
  const target = new DurableGraphStore({ directory: temporary() });
  const damaged = JSON.parse(Buffer.from(bytes).toString()); damaged.objects[0].ref = `ast:b3:${'0'.repeat(64)}`;
  assert.throws(() => target.importArchive(Buffer.from(JSON.stringify(damaged)), { leaseId: 'bad' }), /checksum/);
  assert.throws(() => target.importArchive(Buffer.from('{"format":1,"format":2}'), { leaseId: 'bad' }), /duplicate/);
  damaged.format = 'aether.ast-archive/2';
  assert.throws(() => target.importArchive(Buffer.from(JSON.stringify(damaged)), { leaseId: 'bad' }), /unsupported/);
  assert.deepEqual(target.listRefs(), []); assert.deepEqual(Object.keys(target.roots().leases), []);
});

test('corruption is detected on cached reads/reopen, and live corruption prevents GC deletion', () => {
  const directory = temporary(), store = new DurableGraphStore({ directory });
  const live = store.intern(b.add(b.int(1), b.int(2)), { leaseId: 'live' });
  const garbage = store.intern(b.int(99), { leaseId: 'garbage' }); store.release('garbage');
  store.get(live);
  const file = objectPath(directory, live), original = readFileSync(file, 'utf8');
  writeFileSync(file, original.replace('aether.ast-object/1', 'aether.ast-object/2'));
  assert.throws(() => store.get(live), /unsupported/);
  assert.throws(() => new DurableGraphStore({ directory }).get(live), /unsupported/);
  assert.throws(() => store.collectGarbage(), /unsupported/);
  assert.equal(store.get(garbage).kind, 'Lit', 'GC completes its mark before any destructive sweep');
  writeFileSync(file, original);
  assert.equal(store.collectGarbage().removedObjects, 1);
  assert.throws(() => store.get('../../secret' as NodeRef), /invalid AST reference/);
});

test('persisted resource profile prevents reopen limit changes and rejects excess roots', () => {
  const directory = temporary(); const store = new DurableGraphStore({ directory, limits: { maxRoots: 1 } });
  store.intern(b.int(1), { leaseId: 'one' });
  assert.throws(() => store.intern(b.int(2), { leaseId: 'two' }), /root limit/);
  assert.equal(store.listRefs().length, 1);
  assert.throws(() => new DurableGraphStore({ directory }), /profile mismatch/);
});

function child(code: string): Promise<{ code: number | null; signal: string | null; output: string }> {
  return new Promise((resolve, reject) => {
    const worker = spawn(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', boot + code], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; worker.stdout.on('data', chunk => { output += chunk; }); worker.stderr.on('data', chunk => { output += chunk; });
    worker.once('error', reject); worker.once('exit', (code, signal) => resolve({ code, signal, output }));
  });
}

test('separate processes serialize root CAS; exactly one stale expected update succeeds', async () => {
  const directory = temporary(), store = new DurableGraphStore({ directory });
  const values = [1, 2, 3].map(value => store.intern(b.int(value), { leaseId: 'values' }));
  const expected = store.commit('main', values[0], null);
  const results = await Promise.all(values.slice(1).map(root => child(`const store = new DurableGraphStore({directory:${JSON.stringify(directory)}}); try {store.commit('main', ${JSON.stringify(root)}, ${JSON.stringify(expected)}); console.log('committed');} catch (e) {if (!e.message.includes('compare-and-swap conflict')) throw e; console.log('conflict');}`)));
  assert.ok(results.every(result => result.code === 0), JSON.stringify(results));
  assert.equal(results.filter(result => result.output.includes('committed')).length, 1);
  assert.equal(results.filter(result => result.output.includes('conflict')).length, 1);
  assert.equal(store.head('main')?.generation, 2);
});

test('concurrent process writers and GC retain every published lease and committed root', async () => {
  const directory = temporary(), store = new DurableGraphStore({ directory });
  const results = await Promise.all([
    ...[1, 2, 3].map(worker => child(`const store = new DurableGraphStore({directory:${JSON.stringify(directory)}}); for(let i=0;i<6;i++){const root=store.intern(b.add(b.int(${worker}*100+i),b.int(i)),{leaseId:'worker-${worker}'}); store.commit('worker-${worker}-'+i,root,null);}`)),
    child(`const store = new DurableGraphStore({directory:${JSON.stringify(directory)}}); for(let i=0;i<12;i++) store.collectGarbage();`),
  ]);
  assert.ok(results.every(result => result.code === 0), JSON.stringify(results));
  const reopened = new DurableGraphStore({ directory });
  assert.equal(Object.keys(reopened.roots().heads).length, 18);
  for (const head of Object.values(reopened.roots().heads)) assert.equal(reopened.hydrate(head.root).kind, 'Bin');
  assert.equal(reopened.collectGarbage().removedObjects, 0);
});

for (const point of ['before-object-publish', 'after-object-publish', 'before-root-publish', 'after-root-publish'] satisfies DurableStoreFault[]) {
  test(`actual SIGKILL at ${point} recovers lock and exposes either complete lease or no lease`, async () => {
    const directory = temporary(), store = new DurableGraphStore({ directory });
    const committed = store.intern(b.int(42), { leaseId: 'genesis' }); store.commit('main', committed, null);
    const result = await child(`let armed=false; const store=new DurableGraphStore({directory:${JSON.stringify(directory)},fault:point=>{if(armed && point===${JSON.stringify(point)})process.kill(process.pid,'SIGKILL');}}); armed=true; store.intern(b.add(b.int(55),b.int(66)),{leaseId:'crash'});`);
    assert.equal(result.signal, 'SIGKILL', result.output);
    const reopened = new DurableGraphStore({ directory });
    assert.equal(reopened.hydrate(committed).kind, 'Lit');
    const published = reopened.roots().leases.crash;
    if (point === 'after-root-publish') { assert.equal(published.length, 1); assert.deepEqual(reopened.hydrate(published[0]), b.add(b.int(55), b.int(66))); }
    else assert.equal(published, undefined);
    reopened.collectGarbage();
    for (const roots of Object.values(reopened.roots().leases)) for (const root of roots) assert.ok(reopened.hydrate(root));
  });
}

for (const point of ['before-gc-delete', 'after-gc-delete'] satisfies DurableStoreFault[]) {
  test(`actual SIGKILL ${point} resumes sweep without losing protected roots`, async () => {
    const directory = temporary(), store = new DurableGraphStore({ directory });
    const live = store.intern(b.int(1), { leaseId: 'live' });
    store.intern(b.int(2), { leaseId: 'garbage' }); store.intern(b.int(3), { leaseId: 'garbage' }); store.release('garbage');
    const result = await child(`const store=new DurableGraphStore({directory:${JSON.stringify(directory)},fault:point=>{if(point===${JSON.stringify(point)})process.kill(process.pid,'SIGKILL');}}); store.collectGarbage();`);
    assert.equal(result.signal, 'SIGKILL', result.output);
    const reopened = new DurableGraphStore({ directory }); reopened.collectGarbage();
    assert.deepEqual(reopened.listRefs(), [live]); assert.equal(reopened.get(live).kind, 'Lit');
  });
}


test('checksummed malicious archives reject incomplete, forged, duplicate and unreachable graphs', () => {
  const source = new DurableGraphStore({ directory: temporary() });
  const root = source.intern(b.add(b.int(1), b.int(2)), { leaseId: 'source' });
  const original = JSON.parse(Buffer.from(source.exportArchive()).toString());
  const target = new DurableGraphStore({ directory: temporary() });
  const resign = (archive: Record<string, unknown>): Uint8Array => {
    const { checksum: _checksum, ...body } = archive;
    return encodeCanonical({ ...body, checksum: bytesToHexRef(blake3(encodeCanonical(body)), 'store:b3:') });
  };
  const missing = structuredClone(original); missing.objects = missing.objects.filter((item: { ref: string }) => item.ref === root);
  assert.throws(() => target.importArchive(resign(missing), { leaseId: 'bad' }), /missing AST archive child/);
  const corrupt = structuredClone(original); corrupt.objects[0].ref = `ast:b3:${'0'.repeat(64)}`;
  assert.throws(() => target.importArchive(resign(corrupt), { leaseId: 'bad' }), /corrupt AST archive object/);
  const duplicate = structuredClone(original); duplicate.objects.push(duplicate.objects[0]);
  assert.throws(() => target.importArchive(resign(duplicate), { leaseId: 'bad' }), /duplicate/);
  const unreachable = structuredClone(original); unreachable.roots = [];
  assert.throws(() => target.importArchive(resign(unreachable), { leaseId: 'bad' }), /unreachable/);
  const repeated = structuredClone(original); repeated.roots.push(root);
  assert.throws(() => target.importArchive(resign(repeated), { leaseId: 'bad' }), /duplicate AST archive root/);
  assert.deepEqual(target.listRefs(), []); assert.deepEqual(Object.keys(target.roots().leases), []);
});

test('untrusted input accessors, cycles and node capacity overflow reject before object publication', () => {
  const store = new DurableGraphStore({ directory: temporary(), limits: { maxNodes: 2 } });
  let invoked = 0;
  const term = b.block(b.ret(b.int(1)));
  assert.equal(term.kind, 'Block');
  if (term.kind !== 'Block') throw new Error('fixture kind');
  Object.defineProperty(term.stmts, '0', { get: () => { invoked++; return b.ret(b.int(1)); }, enumerable: true });
  assert.throws(() => store.intern(term, { leaseId: 'bad' }), /accessor/); assert.equal(invoked, 0);
  const cycle: unknown[] = []; cycle.push(cycle);
  assert.throws(() => store.intern({ kind: 'Block', stmts: cycle } as never, { leaseId: 'bad' }), /cyclic/);
  assert.throws(() => store.intern(b.add(b.int(1), b.int(2)), { leaseId: 'big' }), /node limit/);
  assert.deepEqual(store.listRefs(), []); assert.deepEqual(Object.keys(store.roots().leases), []);
});

test('missing root metadata fails closed on reopen instead of resetting GC protection', () => {
  const directory = temporary(), store = new DurableGraphStore({ directory });
  const root = store.intern(b.int(42), { leaseId: 'protected' });
  unlinkSync(join(directory, 'ast-roots-v1.json'));
  assert.throws(() => new DurableGraphStore({ directory }), /missing durable AST root record/);
  assert.equal(store.get(root).kind, 'Lit');
});

for (const operation of ['commit', 'promotion'] as const) for (const point of ['before-root-publish', 'after-root-publish'] satisfies DurableStoreFault[]) {
  test(`actual SIGKILL ${operation} ${point} retains complete old or new root state`, async () => {
    const directory = temporary(), store = new DurableGraphStore({ directory });
    const old = store.intern(b.int(1), { leaseId: 'staging' }), next = store.intern(b.int(2), { leaseId: 'staging' });
    const expected = store.commit('main', old, null);
    if (operation === 'promotion') { store.stagePromotion('p', { from: old, to: next }); store.release('staging'); }
    const command = operation === 'commit'
      ? `store.commit('main',${JSON.stringify(next)},${JSON.stringify(expected)});`
      : `store.finishPromotion('p',{kind:'commit',name:'main',expected:${JSON.stringify(expected)}});`;
    const result = await child(`let armed=false; const store=new DurableGraphStore({directory:${JSON.stringify(directory)},fault:point=>{if(armed && point===${JSON.stringify(point)})process.kill(process.pid,'SIGKILL');}}); armed=true; ${command}`);
    assert.equal(result.signal, 'SIGKILL', result.output);
    const reopened = new DurableGraphStore({ directory });
    assert.equal(reopened.head('main')?.root, point === 'before-root-publish' ? old : next);
    if (operation === 'promotion') assert.equal(!!reopened.roots().promotions.p, point === 'before-root-publish');
    assert.equal(reopened.collectGarbage().removedObjects, 0);
    assert.equal(reopened.get(old).kind, 'Lit'); assert.equal(reopened.get(next).kind, 'Lit');
  });
}

test('retired lease and finalized promotion IDs cannot suffer delayed-release ABA after reopen', () => {
  const directory = temporary(), store = new DurableGraphStore({ directory });
  const [a, bRoot, c] = [1, 2, 3].map(value => store.intern(b.int(value), { leaseId: `lease-${value}` }));
  store.stagePromotion('reuse', { from: a, to: bRoot });
  store.finishPromotion('reuse', { kind: 'abort' });
  const reopened = new DurableGraphStore({ directory });
  assert.throws(() => reopened.stagePromotion('reuse', { from: a, to: c }), /finalized/);
  reopened.stagePromotion('fresh-id', { from: a, to: c });
  reopened.release('lease-3');
  reopened.finishPromotion('reuse', { kind: 'abort' }); // delayed old retry
  reopened.collectGarbage(); assert.equal(reopened.get(c).kind, 'Lit');
  assert.throws(() => reopened.intern(b.int(4), { leaseId: 'lease-3' }), /retired/);
  assert.throws(() => reopened.retain('lease-3', [c]), /retired/);
  reopened.release('lease-3'); assert.ok(reopened.roots().promotions['fresh-id']);
  assert.throws(() => reopened.finishPromotion('reuse', { kind: 'commit', name: 'main', expected: { root: a, generation: 1 } }), /terminal retry conflict/);
});

for (const point of ['before-init-marker', 'after-init-marker', 'after-profile-publish', 'before-root-publish', 'after-root-publish', 'after-init-seal', 'before-init-clear', 'after-init-clear'] satisfies DurableStoreFault[]) {
  test(`actual initialization SIGKILL ${point} resumes only the empty genesis transaction`, async () => {
    const directory = temporary();
    const result = await child(`new DurableGraphStore({directory:${JSON.stringify(directory)},fault:point=>{if(point===${JSON.stringify(point)})process.kill(process.pid,'SIGKILL');}});`);
    assert.equal(result.signal, 'SIGKILL', result.output);
    const marker = join(directory, 'ast-initializing-v1.json');
    assert.equal(existsSync(marker), !['before-init-marker', 'after-init-clear'].includes(point));
    const reopened = new DurableGraphStore({ directory, fault: stage => {
      if (stage === 'before-object-publish') assert.equal(existsSync(marker), false, 'initialization marker must be cleared before graph writes');
    } });
    assert.equal(existsSync(marker), false); assert.ok(existsSync(join(directory, 'ast-initialized-v1.json')));
    assert.equal(reopened.roots().revision, 0); assert.deepEqual(reopened.listRefs(), []);
    const root = reopened.intern(b.int(42), { leaseId: 'first-operation' });
    reopened.commit('main', root, null);
    assert.deepEqual(new DurableGraphStore({ directory }).hydrate(root), b.int(42));
  });
}

test('initialized stores refuse metadata deletion even with an empty object table', () => {
  for (const removed of [['ast-profile.json'], ['ast-roots-v1.json'], ['ast-profile.json', 'ast-roots-v1.json']]) {
    const directory = temporary(); new DurableGraphStore({ directory });
    const sealPath = join(directory, 'ast-initialized-v1.json'), seal = readFileSync(sealPath, 'utf8');
    for (const file of removed) unlinkSync(join(directory, file));
    assert.throws(() => new DurableGraphStore({ directory }), /missing durable AST/);
    for (const file of removed) assert.equal(existsSync(join(directory, file)), false, 'corrupt metadata must not be recreated');
    assert.equal(readFileSync(sealPath, 'utf8'), seal);
  }
});

test('initialization marker/profile corruption and object publication cannot be mistaken for empty genesis recovery', async () => {
  const sourceDirectory = temporary(), source = new DurableGraphStore({ directory: sourceDirectory });
  const root = source.intern(b.int(8), { leaseId: 'published' });
  const objectBytes = readFileSync(objectPath(sourceDirectory, root));
  for (const corruption of ['marker', 'profile', 'object']) {
    const directory = temporary();
    const result = await child(`new DurableGraphStore({directory:${JSON.stringify(directory)},fault:point=>{if(point==='after-profile-publish')process.kill(process.pid,'SIGKILL');}});`);
    assert.equal(result.signal, 'SIGKILL', result.output);
    const markerPath = join(directory, 'ast-initializing-v1.json');
    if (corruption === 'marker') {
      const marker = JSON.parse(readFileSync(markerPath, 'utf8')); marker.initId = '00000000-0000-4000-8000-000000000000';
      writeFileSync(markerPath, JSON.stringify(marker));
    } else if (corruption === 'profile') writeFileSync(join(directory, 'ast-profile.json'), '{}');
    else writeFileSync(objectPath(directory, root), objectBytes);
    const before = readFileSync(markerPath, 'utf8');
    assert.throws(() => new DurableGraphStore({ directory }), /initialization|profile mismatch/);
    assert.equal(existsSync(join(directory, 'ast-roots-v1.json')), false);
    assert.equal(existsSync(join(directory, 'ast-initialized-v1.json')), false);
    assert.equal(readFileSync(markerPath, 'utf8'), before);
  }
});

test('replayed initialization marker cannot reset established state or recreate deleted roots', async () => {
  const directory = temporary();
  const result = await child(`new DurableGraphStore({directory:${JSON.stringify(directory)},fault:point=>{if(point==='after-init-seal')process.kill(process.pid,'SIGKILL');}});`);
  assert.equal(result.signal, 'SIGKILL', result.output);
  const markerPath = join(directory, 'ast-initializing-v1.json'), marker = readFileSync(markerPath, 'utf8');
  const store = new DurableGraphStore({ directory });
  const root = store.intern(b.int(17), { leaseId: 'established' }); store.commit('main', root, null);
  const rootsPath = join(directory, 'ast-roots-v1.json'), protectedState = readFileSync(rootsPath, 'utf8');
  writeFileSync(markerPath, marker);
  assert.throws(() => new DurableGraphStore({ directory }), /conflicts with established/);
  assert.equal(readFileSync(rootsPath, 'utf8'), protectedState); assert.equal(store.get(root).kind, 'Lit');
  unlinkSync(rootsPath);
  assert.throws(() => new DurableGraphStore({ directory }), /missing durable AST root/);
  assert.equal(existsSync(rootsPath), false); assert.equal(store.get(root).kind, 'Lit');
});

test('existing initialized v1 metadata adopts a completion receipt without changing objects or roots', () => {
  const directory = temporary(), store = new DurableGraphStore({ directory });
  const root = store.intern(b.int(99), { leaseId: 'legacy-v1' }); store.commit('main', root, null);
  const profile = readFileSync(join(directory, 'ast-profile.json')), roots = readFileSync(join(directory, 'ast-roots-v1.json')), object = readFileSync(objectPath(directory, root));
  unlinkSync(join(directory, 'ast-initialized-v1.json')); // Simulate the pre-marker initialized profile.
  const reopened = new DurableGraphStore({ directory });
  assert.ok(existsSync(join(directory, 'ast-initialized-v1.json'))); assert.deepEqual(reopened.hydrate(root), b.int(99));
  assert.deepEqual(readFileSync(join(directory, 'ast-profile.json')), profile);
  assert.deepEqual(readFileSync(join(directory, 'ast-roots-v1.json')), roots);
  assert.deepEqual(readFileSync(objectPath(directory, root)), object);
});

test('corrupt completion receipt cannot be silently replaced by legacy adoption', () => {
  const directory = temporary(); new DurableGraphStore({ directory });
  const path = join(directory, 'ast-initialized-v1.json');
  const seal = JSON.parse(readFileSync(path, 'utf8')); seal.initId = '00000000-0000-4000-8000-000000000000';
  const corrupted = JSON.stringify(seal); writeFileSync(path, corrupted);
  const profile = readFileSync(join(directory, 'ast-profile.json')), roots = readFileSync(join(directory, 'ast-roots-v1.json'));
  assert.throws(() => new DurableGraphStore({ directory }), /corrupt AST initialization record/);
  assert.equal(readFileSync(path, 'utf8'), corrupted);
  assert.deepEqual(readFileSync(join(directory, 'ast-profile.json')), profile);
  assert.deepEqual(readFileSync(join(directory, 'ast-roots-v1.json')), roots);
});

test('interrupted initialization refuses checksummed nonempty root metadata instead of resetting it', async () => {
  const directory = temporary();
  const result = await child(`new DurableGraphStore({directory:${JSON.stringify(directory)},fault:point=>{if(point==='after-root-publish')process.kill(process.pid,'SIGKILL');}});`);
  assert.equal(result.signal, 'SIGKILL', result.output);
  const path = join(directory, 'ast-roots-v1.json'), roots = JSON.parse(readFileSync(path, 'utf8'));
  roots.state.revision = 1; roots.state.retiredLeases.push('previously-used');
  roots.checksum = bytesToHexRef(blake3(encodeCanonical(roots.state)), 'store:b3:');
  const changed = encodeCanonical(roots); writeFileSync(path, changed);
  assert.throws(() => new DurableGraphStore({ directory }), /cannot reset nonempty AST roots/);
  assert.deepEqual(readFileSync(path), Buffer.from(changed));
  assert.equal(existsSync(join(directory, 'ast-initialized-v1.json')), false);
  assert.equal(existsSync(join(directory, 'ast-initializing-v1.json')), true);
});

test('read-only archive validation shares complete import checks without changing objects, roots or leases', () => {
  const source = new DurableGraphStore({ directory: temporary() }), root = source.intern(b.add(b.int(1), b.int(2)), { leaseId: 'archive-source' });
  const archive = source.exportArchive([root]);
  const directory = temporary(), target = new DurableGraphStore({ directory });
  const beforeRoots = readFileSync(join(directory, 'ast-roots-v1.json')), beforeRefs = target.listRefs();
  const inventory = (path: string): unknown[] => readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).map(entry => [entry.name, entry.isDirectory() ? inventory(join(path, entry.name)) : readFileSync(join(path, entry.name))]);
  const beforeInventory = inventory(directory);
  assert.deepEqual(target.validateArchive(archive, { canonical: true }), [root]);
  const parsed = JSON.parse(Buffer.from(archive).toString('utf8'));
  const { checksum: _checksum, ...body } = parsed; body.objects = [];
  const malformed = encodeCanonical({ ...body, checksum: bytesToHexRef(blake3(encodeCanonical(body)), 'store:b3:') });
  assert.throws(() => target.validateArchive(malformed), /missing AST archive child/);
  assert.throws(() => target.validateArchive(Buffer.from(' ' + Buffer.from(archive).toString()), { canonical: true }), /noncanonical/);
  // Legacy import acceptance remains unchanged; only callers explicitly asking
  // for canonical validation reject transport whitespace.
  assert.deepEqual(target.validateArchive(Buffer.from(' ' + Buffer.from(archive).toString())), [root]);
  assert.deepEqual(inventory(directory), beforeInventory, 'validation must not consume mutation tickets or publish any file');
  assert.deepEqual(readFileSync(join(directory, 'ast-roots-v1.json')), beforeRoots);
  assert.deepEqual(target.listRefs(), beforeRefs);
  assert.equal(Object.keys(target.roots().leases).length, 0);
});
