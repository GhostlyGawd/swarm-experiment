import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeCanonical, encodeCanonical } from '../../src/fabric/encoding.ts';
import { enrollment, decodeMutation, type MembershipV1 } from '../../src/fabric/replication.ts';
import { CausalLineageLedger } from '../../src/tier1/causal-lineage.ts';
import { DurableGraphStore } from '../../src/tier1/durable-store.ts';
import type { NodeRef } from '../../src/tier1/ids.ts';
import { SemanticGarbageCollector, type SemanticGcOptions } from '../../src/tier1/semantic-gc.ts';
import { DurableTreeWorkspace, type TreeCheckpointCertificate, type TreeWorkspaceOptions } from '../../src/tier1/tree-workspace.ts';
import { SymbolSpace } from '../../src/tier1/symbols.ts';
import { CapabilityRegistry } from '../../src/tier2/ocap.ts';
import * as b from '../../src/tier1/build.ts';

function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'aether-tree-semantic-retention-'));
  const keys = { a: generateKeyPairSync('ed25519'), b: generateKeyPairSync('ed25519') };
  const membership: MembershipV1 = { format: 'aether.membership/1', repositoryId: 'tree-retention-test', membershipEpoch: '1', replicas: Object.entries(keys).map(([id, key]) => enrollment(id, key.publicKey)) };
  const registry = new CapabilityRegistry();
  const exportSymbol = new SymbolSpace('tree-retention-test').define('main');
  const stores = { a: new DurableGraphStore({ directory: join(directory, 'store-a') }), b: new DurableGraphStore({ directory: join(directory, 'store-b') }) };
  const lineage = Object.fromEntries((['a', 'b'] as const).map(id => [id, new CausalLineageLedger({ directory: join(directory, `lineage-${id}`), repositoryId: membership.repositoryId, store: stores[id], authority: () => ({ policyEpoch: '1', eligibleAuthors: [] }), authorKey: () => undefined })])) as Record<'a' | 'b', CausalLineageLedger>;
  const gcOptions = (id: 'a' | 'b', epoch: string): SemanticGcOptions => ({ directory: join(directory, `gc-${id}-${epoch}`), repositoryId: membership.repositoryId, store: stores[id], lineage: lineage[id], registry, policy: { epoch, exports: [exportSymbol], protectedSymbols: [] } });
  const options = (id: 'a' | 'b', extra: Partial<TreeWorkspaceOptions> = {}): TreeWorkspaceOptions => ({ directory: join(directory, id), membership, replicaId: id, privateKey: keys[id].privateKey, store: stores[id], registry, semanticRetention: epoch => gcOptions(id, epoch), ...extra });
  const a = new DurableTreeWorkspace(options('a')), z = new DurableTreeWorkspace(options('b'));
  return { directory, membership, registry, keys, stores, exportSymbol, gcOptions, options, a, z, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

test('unstable replication pins source and inbound AST roots across a killed ingest, collection and process reopen', () => {
  const f = setup();
  try {
    const seeded = f.a.seed(b.int(17));
    const envelope = decodeMutation(seeded.frames[0], f.membership);
    if (envelope.payload.format !== 'aether.tree-insert/1') throw new Error('expected insert');
    const root = envelope.payload.content as NodeRef;
    assert.ok(new SemanticGarbageCollector(f.gcOptions('a', '1')).retentions().some(record => record.kind === 'unstable-replication' && record.root === root));
    f.stores.b.importArchive(f.a.exportContent(), { leaseId: 'transfer' });
    f.stores.b.release('transfer');
    const retirement = new SemanticGarbageCollector(f.gcOptions('b', '1'));
    const staleRetirementSnapshot = retirement.retentions();
    const input = join(f.directory, 'child-input.json');
    writeFileSync(input, JSON.stringify({ directory: f.directory, membership: f.membership, exportSymbol: f.exportSymbol, frame: Buffer.from(seeded.frames[0]).toString('base64') }));
    const child = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', `
      import { readFileSync } from 'node:fs'; import { join } from 'node:path';
      import { DurableGraphStore } from './src/tier1/durable-store.ts';
      import { DurableTreeWorkspace } from './src/tier1/tree-workspace.ts';
      import { DurableReplica } from './src/fabric/replication.ts';
      import { CausalLineageLedger } from './src/tier1/causal-lineage.ts';
      import { CapabilityRegistry } from './src/tier2/ocap.ts';
      const x=JSON.parse(readFileSync(process.argv[1], 'utf8'));
      const store=new DurableGraphStore({directory:join(x.directory,'store-b')});
      const registry=new CapabilityRegistry();
      const lineage=new CausalLineageLedger({directory:join(x.directory,'lineage-b'),repositoryId:x.membership.repositoryId,store,authority:()=>({policyEpoch:'1',eligibleAuthors:[]}),authorKey:()=>undefined});
      const original=DurableReplica.prototype.ingest;
      DurableReplica.prototype.ingest=function(frame){original.call(this,frame);process.kill(process.pid,'SIGKILL');};
      const workspace=new DurableTreeWorkspace({directory:join(x.directory,'b'),membership:x.membership,replicaId:'b',store,registry,semanticRetention:epoch=>({directory:join(x.directory,'gc-b-'+epoch),repositoryId:x.membership.repositoryId,store,lineage,registry,policy:{epoch,exports:[x.exportSymbol],protectedSymbols:[]}})});
      workspace.ingest(Buffer.from(x.frame,'base64'));
    `, input], { cwd: process.cwd(), encoding: 'utf8', timeout: 20000 });
    assert.equal(child.signal, 'SIGKILL', child.stderr);
    let staleRetirementPublished = false;
    assert.throws(() => retirement.withStableRetentions(staleRetirementSnapshot, () => { staleRetirementPublished = true; }), /retention changed/);
    assert.equal(staleRetirementPublished, false);
    const reopened = new DurableTreeWorkspace(f.options('b'));
    assert.ok(new SemanticGarbageCollector(f.gcOptions('b', '1')).retentions().some(record => record.kind === 'unstable-replication' && record.root === root));
    assert.equal(reopened.collectGarbage().removedObjects, 0);
    assert.equal(reopened.materialize({ leaseId: 'reopened' }).status, 'materialized');
    assert.equal(f.stores.b.get(root).kind, 'Lit');
  } finally { f.cleanup(); }
});

test('unstable replication refuses a missing authority, missing record, retired physical lease and mismatched identity', () => {
  const f = setup();
  try {
    const frame = f.a.seed(b.int(9)).frames[0];
    f.z.importContent(f.a.exportContent()); f.z.ingest(frame);
    assert.throws(() => new DurableTreeWorkspace(f.options('b', { semanticRetention: undefined })), /authority required|corrupt workspace state/);
    assert.throws(() => new DurableTreeWorkspace(f.options('b', { semanticRetention: epoch => ({ ...f.gcOptions('b', epoch), repositoryId: 'wrong' }) })), /repository\/epoch mismatch/);
    assert.throws(() => new DurableTreeWorkspace(f.options('b', { semanticRetention: epoch => ({ ...f.gcOptions('b', epoch), policy: { ...f.gcOptions('b', epoch).policy, epoch: 'wrong' } }) })), /repository\/epoch mismatch/);
    assert.throws(() => new DurableTreeWorkspace(f.options('b', { semanticRetention: epoch => ({ ...f.gcOptions('b', epoch), store: new DurableGraphStore({ directory: join(f.directory, 'store-b') }) }) })), /store\/repository\/epoch mismatch/);
    const markerPath = join(f.directory, 'b', 'semantic-retention', readdirSync(join(f.directory, 'b', 'semantic-retention'))[0]);
    const savedMarker = readFileSync(markerPath);
    unlinkSync(markerPath);
    assert.throws(() => new DurableTreeWorkspace(f.options('b')), /semantic retention marker missing/);
    assert.throws(() => new DurableTreeWorkspace(f.options('b', { semanticRetention: undefined })), /workspace state|corrupt workspace|authority required/);
    writeFileSync(markerPath, savedMarker);
    const marker = decodeCanonical(savedMarker) as Record<string, unknown>;
    writeFileSync(markerPath, encodeCanonical({ ...marker, repositoryId: 'changed' }));
    assert.throws(() => new DurableTreeWorkspace(f.options('b')), /marker corrupt/);
    writeFileSync(markerPath, savedMarker);
    const record = readdirSync(join(f.directory, 'gc-b-1', 'retention'))[0];
    const recordPath = join(f.directory, 'gc-b-1', 'retention', record);
    const saved = readFileSync(recordPath); unlinkSync(recordPath);
    assert.throws(() => new DurableTreeWorkspace(f.options('b')), /semantic retention record missing/);
    assert.throws(() => f.z.collectGarbage(), /semantic retention record missing/);
    writeFileSync(recordPath, saved);
    const gc = new SemanticGarbageCollector(f.gcOptions('b', '1'));
    const pin = gc.retentions().find(item => item.kind === 'unstable-replication')!;
    const lease = Object.entries(f.stores.b.roots().leases).find(([key, roots]) => key.startsWith('semantic-gc-retention:') && roots.length === 1 && roots[0] === pin.root)?.[0];
    assert.ok(lease);
    f.stores.b.release(lease);
    assert.throws(() => new DurableTreeWorkspace(f.options('b')), /physical lease missing/);
  } finally { f.cleanup(); }
});

test('checkpoint transition pins next-epoch base before publication and retains old epoch roots after unanimous ACK', () => {
  const f = setup();
  try {
    const seed = f.a.seed(b.int(3)); f.z.importContent(f.a.exportContent()); f.z.ingest(seed.frames[0]);
    const root = f.a.inspect().nodes[0].content;
    const proposal = f.a.proposeCheckpoint([f.a.fence(), f.z.fence()]);
    const certificate: TreeCheckpointCertificate = { format: 'aether.tree-checkpoint-certificate/1', checkpoint: proposal, acknowledgments: [f.a.acknowledgeCheckpoint(proposal), f.z.acknowledgeCheckpoint(proposal)] };
    const missingNextEpoch = new DurableTreeWorkspace(f.options('a', { semanticRetention: epoch => epoch === '2'
      ? { ...f.gcOptions('a', epoch), policy: { ...f.gcOptions('a', epoch).policy, epoch: 'wrong' } }
      : f.gcOptions('a', epoch) }));
    assert.throws(() => missingNextEpoch.installCheckpoint(certificate), /repository\/epoch mismatch/);
    assert.equal(missingNextEpoch.membershipEpoch, '1');
    f.a.installCheckpoint(certificate); f.z.installCheckpoint(certificate);
    assert.equal(f.a.membershipEpoch, '2');
    for (const id of ['a', 'b'] as const) {
      const old = new SemanticGarbageCollector(f.gcOptions(id, '1')).retentions();
      const current = new SemanticGarbageCollector(f.gcOptions(id, '2')).retentions();
      assert.ok(old.some(record => record.kind === 'unstable-replication' && record.root === root));
      assert.ok(current.some(record => record.kind === 'unstable-replication' && record.root === root));
      const reopened = new DurableTreeWorkspace(f.options(id));
      reopened.collectGarbage();
      assert.equal(f.stores[id].get(root).kind, 'Lit');
    }
  } finally { f.cleanup(); }
});
