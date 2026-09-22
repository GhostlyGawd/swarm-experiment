import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { encodeCanonical } from '../../src/fabric/encoding.ts';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DurableGraphStore } from '../../src/tier1/durable-store.ts';
import { DurableTreeWorkspace, type TreeCheckpointCertificate, type TreeWorkspaceOptions } from '../../src/tier1/tree-workspace.ts';
import { enrollment, decodeMutation, type MutationEnvelopeV1, type MembershipV1 } from '../../src/fabric/replication.ts';
import { domainDigest } from '../../src/fabric/identity.ts';
import { CapabilityRegistry } from '../../src/tier2/ocap.ts';
import { SymbolSpace } from '../../src/tier1/symbols.ts';
import * as b from '../../src/tier1/build.ts';
import { Runtime } from '../../src/tier3/runtime.ts';
import { TRASH_PARENT } from '../../src/tier1/occurrence-tree.ts';

function setup(extraOptions: Partial<TreeWorkspaceOptions> = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'aether-tree-workspace-'));
  const keys = { a: generateKeyPairSync('ed25519'), b: generateKeyPairSync('ed25519') };
  const membership: MembershipV1 = { format: 'aether.membership/1', repositoryId: 'tree-test', membershipEpoch: '1', replicas: Object.entries(keys).map(([id, key]) => enrollment(id, key.publicKey)) };
  const registry = new CapabilityRegistry();
  const stores = { a: new DurableGraphStore({ directory: join(directory, 'store-a') }), b: new DurableGraphStore({ directory: join(directory, 'store-b') }) };
  const options = (id: 'a' | 'b', extra: Partial<TreeWorkspaceOptions> = {}): TreeWorkspaceOptions => ({ directory: join(directory, id), membership, replicaId: id, privateKey: keys[id].privateKey, store: stores[id], registry, ...extraOptions, ...extra });
  const a = new DurableTreeWorkspace(options('a')), z = new DurableTreeWorkspace(options('b'));
  const transfer = (from: DurableTreeWorkspace, to: DurableTreeWorkspace, reverse = false) => { to.importContent(from.exportContent()); const frames = from.exportOperations(); if (reverse) frames.reverse(); for (const frame of frames) to.ingest(frame); };
  return { directory, membership, keys, registry, stores, options, a, z, transfer, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}
const fingerprint = (value: unknown) => domainDigest('aether.tree-test/1', value);

test('Tree-CRDT materializes actual CAS roots; shared content has independent occurrences and concurrent edits converge', () => {
  const f = setup();
  try {
    const syms = new SymbolSpace('tree-program'), main = syms.define('main');
    const module = b.module_({ symbol: syms.define('module'), symbolTable: syms.table(), members: [b.fn({ symbol: main, returns: b.Int, body: b.block(b.ret(b.add(b.int(1), b.int(1)))) })] });
    const original = f.stores.a.intern(module, { leaseId: 'production' }); f.stores.a.commit('production', original, null);
    const head = f.stores.a.head('production');
    f.a.seed(module); f.transfer(f.a, f.z, true);
    const literals = f.a.inspect().nodes.filter(node => f.stores.a.get(node.content).kind === 'Lit');
    assert.equal(literals.length, 2); assert.equal(literals[0].content, literals[1].content); assert.notEqual(literals[0].occurrenceId, literals[1].occurrenceId);
    f.a.replace(literals[0].occurrenceId, f.a.storeTerm(b.int(2)));
    f.z.replace(literals[0].occurrenceId, f.z.storeTerm(b.int(3)));
    f.transfer(f.a, f.z); f.transfer(f.z, f.a, true);
    assert.equal(fingerprint(f.a.inspect()), fingerprint(f.z.inspect()));
    const a = f.a.materialize({ leaseId: 'candidate-a' }), z = f.z.materialize({ leaseId: 'candidate-b' });
    assert.equal(a.status, 'materialized'); assert.equal(a.typecheck?.ok, true); assert.equal(a.root, z.root); assert.notEqual(a.root, original);
    assert.equal(a.productionAuthorized, false); assert.deepEqual(f.stores.a.head('production'), head);
    const projected = f.stores.a.hydrate(a.root!); const runtime = new Runtime({ registry: f.registry, symbols: syms }); runtime.load(projected);
    const result = runtime.call(main, []); assert.ok(result.ok && (result.value === 3n || result.value === 4n));
    const untouched = f.a.inspect().nodes.find(node => node.occurrenceId === literals[1].occurrenceId)!;
    assert.equal(untouched.content, literals[1].content);
  } finally { f.cleanup(); }
});

test('Tree-CRDT suppresses concurrent cycles deterministically and trash deletion remains restorable until certified collection', () => {
  const f = setup();
  try {
    const seed = f.a.seed(b.block(b.block(), b.block())); f.transfer(f.a, f.z);
    const children = f.a.inspect().nodes.filter(node => node.parent === seed.rootOccurrence);
    const [left, right] = children;
    f.a.move(left.occurrenceId, { parent: right.occurrenceId, field: 'stmts' });
    f.z.move(right.occurrenceId, { parent: left.occurrenceId, field: 'stmts' });
    f.transfer(f.a, f.z, true); f.transfer(f.z, f.a);
    const projection = f.a.inspect(); assert.equal(fingerprint(projection), fingerprint(f.z.inspect()));
    assert.equal(projection.diagnostics.filter(item => item.code === 'cycle-suppressed').length, 1);
    f.a.delete(left.occurrenceId); f.a.replace(left.occurrenceId, f.a.storeTerm(b.block(b.exprStmt(b.int(7)))));
    assert.equal(f.a.inspect().nodes.find(node => node.occurrenceId === left.occurrenceId)!.parent, TRASH_PARENT);
    f.a.move(left.occurrenceId, { parent: seed.rootOccurrence, field: 'stmts' });
    assert.ok(f.a.inspect().visible.includes(left.occurrenceId));
    assert.equal(f.a.inspect().trash.length, 0);
  } finally { f.cleanup(); }
});

test('Tree-CRDT unanimous signed checkpoint reindexes and collects live tombstones without obsolete edit resurrection', () => {
  const f = setup();
  try {
    const seed = f.a.seed(b.block(b.exprStmt(b.int(1)), b.exprStmt(b.int(2)))); f.transfer(f.a, f.z);
    const deleted = f.a.inspect().nodes.find(node => node.parent === seed.rootOccurrence)!;
    const oldRestore = f.z.move(deleted.occurrenceId, { parent: seed.rootOccurrence, field: 'stmts' });
    f.a.ingest(oldRestore); f.a.delete(deleted.occurrenceId); f.transfer(f.a, f.z);
    const fences = [f.a.fence(), f.z.fence()];
    assert.throws(() => f.a.insert(deleted.content, { parent: seed.rootOccurrence, field: 'stmts' }), /fenced/);
    assert.throws(() => f.a.proposeCheckpoint([fences[0]]), /every active replica/);
    const checkpoint = f.a.proposeCheckpoint(fences), same = f.z.proposeCheckpoint([...fences].reverse());
    assert.equal(checkpoint.digest, same.digest);
    const certificate: TreeCheckpointCertificate = { format: 'aether.tree-checkpoint-certificate/1', checkpoint, acknowledgments: [f.a.acknowledgeCheckpoint(checkpoint), f.z.acknowledgeCheckpoint(checkpoint)] };
    const first = f.a.installCheckpoint(certificate), second = f.z.installCheckpoint(certificate);
    assert.ok(first.collected.includes(deleted.occurrenceId)); assert.deepEqual(first, second); assert.equal(first.membershipEpoch, '2');
    assert.equal(f.a.inspect().trash.length, 0); assert.ok(!f.a.inspect().nodes.some(node => node.occurrenceId === deleted.occurrenceId));
    assert.throws(() => f.a.ingest(oldRestore), /membership epoch/);
    assert.throws(() => f.a.move(deleted.occurrenceId, { parent: seed.rootOccurrence, field: 'stmts' }), /missing occurrence/);
    const reopened = new DurableTreeWorkspace(f.options('a'));
    assert.equal(fingerprint(reopened.inspect()), fingerprint(f.z.inspect()));
    const inserted = reopened.insert(reopened.storeTerm(b.int(9)), { parent: seed.rootOccurrence, field: 'stmts' });
    const envelope = decodeMutation(inserted.frame, checkpoint.proposal.nextMembership);
    assert.ok(BigInt(envelope.lamport) > BigInt(checkpoint.proposal.lamportFloor));
    assert.equal(envelope.sequence, '1');
    const historyPath = join(f.directory, 'a', 'checkpoints', `${checkpoint.digest.split(':').at(-1)}.json`);
    assert.ok(readFileSync(historyPath).length > 0);
    assert.deepEqual(reopened.installCheckpoint(certificate), first);
  } finally { f.cleanup(); }
});

test('Tree-CRDT invalid grouped roles, duplicate scalar children and invalid literal types stay candidates', () => {
  const f = setup();
  try {
    const seed = f.a.seed(b.add(b.int(1), b.int(2)));
    const production = f.stores.a.intern(b.int(42), { leaseId: 'production' }); const head = f.stores.a.commit('production', production, null);
    const extra = f.a.insert(f.a.storeTerm(b.block()), { parent: seed.rootOccurrence, field: 'left' });
    const invalid = f.a.materialize({ leaseId: 'invalid-candidate' });
    assert.equal(invalid.status, 'invalid-structure'); assert.equal(invalid.root, null); assert.ok(invalid.diagnostics.some(error => error.detail.includes('child role') || error.detail.includes('exactly one')));
    assert.deepEqual(f.stores.a.head('production'), head);
    f.a.delete(extra.occurrenceId);
    const literal = f.a.inspect().nodes.find(node => f.stores.a.get(node.content).kind === 'Lit')!;
    f.a.replace(literal.occurrenceId, f.a.storeTerm({ kind: 'Lit', ty: { t: 'Int' }, value: 'not-an-integer' }));
    assert.ok(f.a.materialize({ leaseId: 'invalid-literal' }).diagnostics.some(error => error.detail.includes('literal value')));
    assert.deepEqual(f.stores.a.head('production'), head);
  } finally { f.cleanup(); }
});

function checkpoint(f: ReturnType<typeof setup>): TreeCheckpointCertificate {
  const proposal = f.a.proposeCheckpoint([f.a.fence(), f.z.fence()]);
  return { format: 'aether.tree-checkpoint-certificate/1', checkpoint: proposal, acknowledgments: [f.a.acknowledgeCheckpoint(proposal), f.z.acknowledgeCheckpoint(proposal)] };
}

test('checkpoint ACK validates full audit closure, canonical cut, exact projection, floor, roster and signatures before writing authority', () => {
  const f = setup();
  try {
    f.a.seed(b.block(b.exprStmt(b.int(1)))); f.transfer(f.a, f.z);
    const proposed = f.a.proposeCheckpoint([f.a.fence(), f.z.fence()]);
    const mutate = (change: (proposal: typeof proposed.proposal) => void) => {
      const copy = structuredClone(proposed); change(copy.proposal); copy.digest = domainDigest('aether.tree-checkpoint/1', copy.proposal); return copy;
    };
    const original = readFileSync(join(f.directory, 'a', 'workspace.json'));
    const emptyArchive = Buffer.from(f.stores.a.exportArchive([])).toString('base64');
    assert.throws(() => f.a.acknowledgeCheckpoint(mutate(p => { p.archive = emptyArchive; p.archiveDigest = domainDigest('aether.tree-object-archive/1', emptyArchive); })), /required cut\/audit prototypes/);
    assert.throws(() => f.a.acknowledgeCheckpoint(mutate(p => { p.frames.pop(); })), /omitted or added/);
    assert.throws(() => f.a.acknowledgeCheckpoint(mutate(p => { p.after = []; })), /projection\/reindex/);
    assert.throws(() => f.a.acknowledgeCheckpoint(mutate(p => { p.lamportFloor = '999'; })), /Lamport floor/);
    assert.throws(() => f.a.acknowledgeCheckpoint(mutate(p => { p.nextMembership = { ...p.nextMembership, membershipEpoch: '3' }; })), /skipped an epoch/);
    assert.throws(() => f.a.acknowledgeCheckpoint(mutate(p => { p.fences.reverse(); })), /noncanonical/);
    assert.throws(() => f.a.acknowledgeCheckpoint(mutate(p => { p.fences[1].signature = Buffer.alloc(64).toString('base64'); })), /signature/);
    assert.deepEqual(readFileSync(join(f.directory, 'a', 'workspace.json')), original);
    const cert: TreeCheckpointCertificate = { format: 'aether.tree-checkpoint-certificate/1', checkpoint: proposed, acknowledgments: [f.a.acknowledgeCheckpoint(proposed)] };
    assert.throws(() => f.a.installCheckpoint(cert), /every active replica/);
    cert.acknowledgments.push(f.z.acknowledgeCheckpoint(proposed)); f.a.installCheckpoint(cert);
    const tampered = structuredClone(cert); tampered.checkpoint.proposal.collected.push(proposed.proposal.after[0].occurrenceId);
    assert.throws(() => f.a.installCheckpoint(tampered), /retry differs/);
  } finally { f.cleanup(); }
});

for (const phase of ['after-fence', 'checkpoint-prepared', 'checkpoint-committed', 'checkpoint-collected'] as const) {
  test(`actual SIGKILL at ${phase} preserves durable fencing or certified epoch; same certificate retry is idempotent`, () => {
    const f = setup();
    try {
      const seed = f.a.seed(b.block(b.exprStmt(b.int(1))));
      const deleted = f.a.inspect().nodes.find(node => node.parent === seed.rootOccurrence)!; f.a.delete(deleted.occurrenceId); f.transfer(f.a, f.z);
      const cert = phase === 'after-fence' ? null : checkpoint(f);
      const input = join(f.directory, 'crash-input.json');
      writeFileSync(input, JSON.stringify({ directory: f.directory, membership: f.membership, privateKey: f.keys.a.privateKey.export({ format: 'pem', type: 'pkcs8' }), cert, phase }));
      const child = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', `
        import { readFileSync } from 'node:fs'; import { join } from 'node:path';
        import { DurableGraphStore } from './src/tier1/durable-store.ts';
        import { DurableTreeWorkspace } from './src/tier1/tree-workspace.ts';
        import { CapabilityRegistry } from './src/tier2/ocap.ts';
        const x = JSON.parse(readFileSync(process.argv[1], 'utf8'));
        const host = new DurableTreeWorkspace({ directory: join(x.directory,'a'), membership:x.membership, replicaId:'a', privateKey:x.privateKey, registry:new CapabilityRegistry(), store:new DurableGraphStore({ directory:join(x.directory,'store-a') }), fault(point) { if(point===x.phase) process.kill(process.pid,'SIGKILL'); } });
        if(x.phase==='after-fence') host.fence(); else host.installCheckpoint(x.cert);
      `, input], { encoding: 'utf8', timeout: 15000 });
      assert.equal(child.signal, 'SIGKILL', child.stderr);
      const reopened = new DurableTreeWorkspace(f.options('a'));
      if (phase === 'after-fence') {
        assert.equal(reopened.membershipEpoch, '1'); assert.equal(reopened.fenced, true);
        assert.throws(() => reopened.delete(seed.rootOccurrence), /fenced/);
        const proposal = reopened.proposeCheckpoint([reopened.fence(), f.z.fence()]);
        const recovered: TreeCheckpointCertificate = { format: 'aether.tree-checkpoint-certificate/1', checkpoint: proposal, acknowledgments: [reopened.acknowledgeCheckpoint(proposal), f.z.acknowledgeCheckpoint(proposal)] };
        reopened.installCheckpoint(recovered); assert.equal(reopened.membershipEpoch, '2');
      } else {
        assert.equal(reopened.membershipEpoch, phase === 'checkpoint-prepared' ? '1' : '2');
        assert.equal(reopened.fenced, phase === 'checkpoint-prepared');
        const first = reopened.installCheckpoint(cert!); assert.ok(first.collected.includes(deleted.occurrenceId));
        assert.deepEqual(reopened.installCheckpoint(cert!), first);
        f.z.installCheckpoint(cert!); assert.equal(fingerprint(reopened.inspect()), fingerprint(f.z.inspect()));
      }
      assert.equal(reopened.inspect().trash.length, 0);
      f.stores.a.collectGarbage(); assert.equal(reopened.materialize({ leaseId: `after-crash-${phase}` }).status, 'materialized');
    } finally { f.cleanup(); }
  });
}

test('late equivocation and predecessors recompute the candidate deterministically after duplicate and reversed delivery', () => {
  const f = setup();
  try {
    const seeded = f.a.seed(b.block(b.exprStmt(b.int(1))));
    f.z.importContent(f.a.exportContent());
    const last = seeded.frames.at(-1)!;
    assert.equal(f.z.ingest(last).disposition, 'pending');
    assert.equal(f.z.inspect().nodes.length, 0);
    for (const frame of [...seeded.frames].reverse()) { f.z.ingest(frame); f.z.ingest(frame); }
    assert.equal(fingerprint(f.a.inspect()), fingerprint(f.z.inspect()));
    const original = decodeMutation(seeded.frames[0], f.membership);
    const payload = { ...original.payload, field: 'another-root' } as MutationEnvelopeV1['payload'];
    const { signature: _signature, ...body } = { ...original, payload, payloadDigest: domainDigest('aether.mutation-payload/1', payload) };
    const conflict = encodeCanonical({ ...body, signature: sign(null, encodeCanonical({ domain: 'aether.mutation-signature/1', envelope: body }), f.keys.a.privateKey).toString('base64') });
    f.z.ingest(conflict); f.a.ingest(conflict);
    assert.equal(f.a.inspect().nodes.length, 0); assert.equal(fingerprint(f.a.inspect()), fingerprint(f.z.inspect()));
    assert.ok(f.a.inspect().diagnostics.every(item => item.code === 'quarantined'));
    const reopened = new DurableTreeWorkspace(f.options('a')); assert.equal(fingerprint(reopened.inspect()), fingerprint(f.z.inspect()));
  } finally { f.cleanup(); }
});

test('grouped While children remain distinct and converged semantic failures do not publish a production root', () => {
  const f = setup();
  try {
    const term = b.while_(b.bool(false), b.block(), { invariants: [b.bool(true)], variant: b.int(3) });
    const seed = f.a.seed(term); f.transfer(f.a, f.z);
    const nodes = f.a.inspect().nodes, invariant = nodes.find(node => node.parent === seed.rootOccurrence && node.field === 'invariants')!, variant = nodes.find(node => node.parent === seed.rootOccurrence && node.field === 'variant')!;
    assert.throws(() => f.a.move(variant.occurrenceId, { parent: seed.rootOccurrence, field: 'variant', left: invariant.occurrenceId }), /outside parent\/field/);
    const candidate = f.a.materialize({ leaseId: 'while-groups' });
    assert.equal(candidate.status, 'materialized'); assert.equal(candidate.root, f.a.storeTerm(term));
    f.a.move(invariant.occurrenceId, { parent: seed.rootOccurrence, field: 'variant' }); f.transfer(f.a, f.z, true);
    assert.equal(fingerprint(f.a.inspect()), fingerprint(f.z.inspect()));
    assert.equal(f.z.materialize({ leaseId: 'duplicate-variant' }).status, 'invalid-structure');
  } finally { f.cleanup(); }
  const g = setup();
  try {
    const seed = g.a.seed(b.add(b.int(1), b.int(2))); g.transfer(g.a, g.z);
    const left = g.a.inspect().nodes.find(node => node.parent === seed.rootOccurrence && node.field === 'left')!;
    const original = g.stores.a.intern(b.int(7), { leaseId: 'production' }); const head = g.stores.a.commit('production', original, null);
    g.z.replace(left.occurrenceId, g.z.storeTerm(b.bool(true))); g.transfer(g.z, g.a);
    const candidate = g.a.materialize({ leaseId: 'semantic-failure' });
    assert.equal(candidate.status, 'materialized'); assert.equal(candidate.typecheck?.ok, false); assert.equal(candidate.productionAuthorized, false);
    assert.deepEqual(g.stores.a.head('production'), head);
  } finally { g.cleanup(); }
});

test('repeated certified epochs preserve live identity and clocks while stale archived restores cannot resurrect collected occurrences', () => {
  const f = setup();
  try {
    const seed = f.a.seed(b.block(b.block(), b.block())); f.transfer(f.a, f.z);
    const children = f.a.inspect().nodes.filter(node => node.parent === seed.rootOccurrence);
    const stale = f.z.move(children[0].occurrenceId, { parent: seed.rootOccurrence, field: 'stmts' }); f.a.ingest(stale);
    f.a.delete(children[0].occurrenceId); f.transfer(f.a, f.z);
    const first = checkpoint(f); f.a.installCheckpoint(first); f.z.installCheckpoint(first);
    const oldBase = f.a.inspect().nodes.find(node => node.occurrenceId === seed.rootOccurrence)!;
    f.z.delete(children[1].occurrenceId); f.transfer(f.z, f.a);
    const second = checkpoint(f); f.a.installCheckpoint(second); f.z.installCheckpoint(second);
    const reopened = new DurableTreeWorkspace(f.options('a'));
    assert.equal(reopened.membershipEpoch, '3'); assert.equal(reopened.inspect().nodes.length, 1);
    assert.equal(reopened.inspect().nodes[0].createdBy, oldBase.createdBy);
    assert.throws(() => reopened.ingest(stale), /membership epoch/);
    f.stores.a.collectGarbage(); assert.equal(reopened.materialize({ leaseId: 'epoch-three' }).status, 'materialized');
    const fresh = reopened.insert(reopened.storeTerm(b.block()), { parent: seed.rootOccurrence, field: 'stmts' });
    assert.notEqual(fresh.occurrenceId, children[0].occurrenceId); assert.notEqual(fresh.occurrenceId, children[1].occurrenceId);
    const op = decodeMutation(fresh.frame, second.checkpoint.proposal.nextMembership);
    assert.ok(BigInt(op.lamport) > BigInt(second.checkpoint.proposal.lamportFloor));
  } finally { f.cleanup(); }
});

test('missing causal predecessors prevent checkpoint certification and durable fence receipts resist metadata rollback', () => {
  const f = setup();
  try {
    const seed = f.a.seed(b.block()); f.transfer(f.a, f.z);
    const before = readFileSync(join(f.directory, 'a', 'workspace.json'));
    const frame = decodeMutation(seed.frames[0], f.membership);
    const { signature: _signature, ...body } = { ...frame, causalFrontier: [['b', '99']] as const, lamport: '100' };
    const pendingBody = { ...body, replicaId: 'b', sequence: '100', causalFrontier: [['b', '99']] as const };
    const pending = encodeCanonical({ ...pendingBody, signature: sign(null, encodeCanonical({ domain: 'aether.mutation-signature/1', envelope: pendingBody }), f.keys.b.privateKey).toString('base64') });
    assert.equal(f.a.ingest(pending).disposition, 'pending'); assert.equal(f.z.ingest(pending).disposition, 'pending');
    const fences = [f.a.fence(), f.z.fence()]; assert.throws(() => f.a.proposeCheckpoint(fences), /causal predecessors/);
    writeFileSync(join(f.directory, 'a', 'workspace.json'), before);
    const reopened = new DurableTreeWorkspace(f.options('a'));
    assert.equal(reopened.fenced, true); assert.throws(() => reopened.delete(seed.rootOccurrence), /fenced/);
    rmSync(join(f.directory, 'a', 'workspace.json'));
    assert.throws(() => new DurableTreeWorkspace(f.options('a')), /missing initialized workspace metadata/);
  } finally { f.cleanup(); }
});

test('known post-fence signed extras prevent fresh certification while historical certified cuts remain arrival independent', () => {
  const f = setup();
  try {
    const seed = f.a.seed(b.block()); f.transfer(f.a, f.z);
    const fences = [f.a.fence(), f.z.fence()]; const proposal = f.a.proposeCheckpoint(fences);
    const cert: TreeCheckpointCertificate = { format: 'aether.tree-checkpoint-certificate/1', checkpoint: proposal, acknowledgments: [f.a.acknowledgeCheckpoint(proposal), f.z.acknowledgeCheckpoint(proposal)] };
    const frame = decodeMutation(seed.frames[0], f.membership), payload = { ...frame.payload, field: 'conflicting-root' } as MutationEnvelopeV1['payload'];
    const { signature: _signature, ...body } = { ...frame, payload, payloadDigest: domainDigest('aether.mutation-payload/1', payload) };
    const extra = encodeCanonical({ ...body, signature: sign(null, encodeCanonical({ domain: 'aether.mutation-signature/1', envelope: body }), f.keys.a.privateKey).toString('base64') });
    f.a.ingest(extra);
    assert.throws(() => f.a.proposeCheckpoint(fences), /known old-epoch frames outside signed fence union: aether.tree-frame/);
    assert.throws(() => f.a.acknowledgeCheckpoint(proposal), /outside signed fence union/);
    // Every member had already certified this exact cut before the late evidence.
    // Installing/replaying that certificate must not depend on later arrival order.
    f.a.installCheckpoint(cert); f.z.installCheckpoint(cert);
    assert.equal(fingerprint(new DurableTreeWorkspace(f.options('a')).inspect()), fingerprint(f.z.inspect()));
  } finally { f.cleanup(); }
});

test('honest partitioned inserts beyond the occurrence bound converge deterministically and leave deletion/checkpoint repair available', () => {
  const f = setup({ maxOccurrences: 2 });
  try {
    const seed = f.a.seed(b.block()); f.transfer(f.a, f.z);
    const a = f.a.insert(f.a.storeTerm(b.block()), { parent: seed.rootOccurrence, field: 'stmts' });
    const z = f.z.insert(f.z.storeTerm(b.block()), { parent: seed.rootOccurrence, field: 'stmts' });
    assert.equal(f.a.inspect().nodes.length, 2); assert.equal(f.z.inspect().nodes.length, 2);
    f.transfer(f.a, f.z, true); f.transfer(f.z, f.a);
    const projection = f.a.inspect(); assert.equal(fingerprint(projection), fingerprint(f.z.inspect()));
    assert.equal(projection.nodes.length, 2); assert.equal(projection.diagnostics.filter(item => item.code === 'occurrence-capacity-suppressed').length, 1);
    assert.equal(f.a.exportOperations().length, 3); assert.equal(f.z.exportOperations().length, 3);
    const incomplete = f.a.materialize({ leaseId: 'capacity-overflow-candidate' });
    assert.equal(incomplete.status, 'invalid-structure'); assert.equal(incomplete.root, null); assert.equal(incomplete.typecheck, null); assert.equal(incomplete.productionAuthorized, false);
    assert.ok(incomplete.diagnostics.some(issue => issue.detail.includes('occurrence-capacity-suppressed')));
    assert.ok(incomplete.occurrenceRoots.some(([occurrence]) => occurrence === seed.rootOccurrence), 'the partial AST remains available only through diagnostic per-occurrence roots');
    assert.equal(f.a.exportOperations().length, 3, 'incomplete materialization preserves every signed frame');
    const retained = projection.nodes.find(node => node.parent === seed.rootOccurrence)!;
    const suppressed = retained.occurrenceId === a.occurrenceId ? z.occurrenceId : a.occurrenceId;
    f.a.delete(retained.occurrenceId); f.transfer(f.a, f.z);
    const cert = checkpoint(f); f.a.installCheckpoint(cert); f.z.installCheckpoint(cert);
    assert.equal(f.a.inspect().nodes.length, 1); assert.equal(f.a.inspect().trash.length, 0);
    const repaired = f.a.materialize({ leaseId: 'capacity-repaired-candidate' });
    assert.equal(repaired.status, 'materialized'); assert.equal(repaired.typecheck?.ok, true); assert.equal(repaired.productionAuthorized, false);
    assert.throws(() => f.a.move(suppressed, { parent: seed.rootOccurrence, field: 'stmts' }), /missing occurrence/);
    const fresh = f.a.insert(f.a.storeTerm(b.block()), { parent: seed.rootOccurrence, field: 'stmts' });
    assert.notEqual(fresh.occurrenceId, suppressed); f.transfer(f.a, f.z);
    assert.equal(fingerprint(f.a.inspect()), fingerprint(f.z.inspect()));
  } finally { f.cleanup(); }
});
