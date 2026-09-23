import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { HybridGraphIndex, canonicalVector, decodeVector, embeddingModelDigest, type EmbeddingModelProfile, type EmbeddingProvider, type HybridIndexOptions } from '../../src/tier1/semantic-index.ts';
import { scopeDigest } from '../../src/tier1/embedding-input.ts';
import { DurableGraphStore } from '../../src/tier1/durable-store.ts';
import { domainDigest } from '../../src/fabric/identity.ts';
import { encodeCanonical } from '../../src/fabric/encoding.ts';
import { capability, typeName } from '../../src/tier1/ids.ts';
import { SymbolSpace } from '../../src/tier1/symbols.ts';
import * as b from '../../src/tier1/build.ts';

// Deliberately synthetic test provider. Actual model inference/recall evidence is
// kept in the independently preregistered retrieval campaign.
const model: EmbeddingModelProfile = { format: 'aether.embedding-model/1', name: 'synthetic-test-fixture', revision: '0'.repeat(40), artifactDigest: domainDigest('aether.test-model/1', 1), tokenizerDigest: domainDigest('aether.test-tokenizer/1', 1), dimensions: 8, pooling: 'mean', normalization: 'l2', dtype: 'fp32', maxTokens: 256, runtime: { name: 'synthetic-fixture', version: '1' } };
function setup(extra: Partial<HybridIndexOptions> = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'aether-hybrid-index-')), store = new DurableGraphStore({ directory: join(directory, 'store') });
  let calls = 0;
  const provider: EmbeddingProvider = { modelDigest: embeddingModelDigest(model), async embed(texts) { calls += texts.length; return texts.map(text => [...createHash('sha256').update(text).digest().subarray(0, 8)].map(byte => byte - 127)); } };
  const options = { directory: join(directory, 'index'), store, model, ...extra }, index = new HybridGraphIndex(options);
  return { directory, store, provider, options, index, calls: () => calls, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}
const context = { specRoot: null, text: '' };

test('indexed creation computes newly exposed nodes before generation publication and preserves exact AST hashes', async () => {
  const f = setup();
  try {
    const term = b.add(b.int(1), b.int(1)); const root = f.store.intern(term, { leaseId: 'unindexed' }); const before = f.store.listRefs();
    const result = await f.index.intern(term, context, f.provider);
    assert.equal(result.root, root); assert.equal(result.embedded, 2); assert.equal(f.calls(), 2); assert.deepEqual(f.store.listRefs(), before);
    const entries = f.index.entries(), shared = entries.find(entry => entry.structure.kind === 'Lit')!;
    assert.deepEqual(shared.structure.parents.map(edge => edge.field).sort(), ['left', 'right']);
    const query = f.index.vectorFor(shared.entryId, shared.inputDigest);
    const resultExact = f.index.query({ snapshot: f.index.snapshot, embedding: query, k: 3, mode: 'exact', filter: { kinds: ['Lit'], parent: { kind: 'Bin', field: 'left' } } });
    assert.equal(resultExact.hits.length, 1); assert.equal(resultExact.hits[0].cosine, 1);
    const defaultResult = f.index.query({ snapshot: f.index.snapshot, embedding: query, k: 3, filter: { kinds: ['Lit'], parent: { kind: 'Bin', field: 'left' } } });
    assert.equal(defaultResult.mode, 'exact'); assert.deepEqual(defaultResult.hits, resultExact.hits);
    const approximate = f.index.query({ snapshot: f.index.snapshot, embedding: query, k: 3, mode: 'lsh', filter: { kinds: ['Lit'] } });
    assert.deepEqual(approximate.hits, resultExact.hits);
    assert.equal(f.index.query({ snapshot: f.index.snapshot, embedding: query, k: 3, mode: 'exact', minimumCosine: 0.85 }).hits[0].subject, shared.subject);
    await f.index.queryText('fractional threshold regression', f.provider, { snapshot: f.index.snapshot, k: 3, minimumCosine: 0.85 });
    for (const threshold of [NaN, Infinity, 1.1]) assert.throws(() => f.index.query({ snapshot: f.index.snapshot, embedding: query, k: 1, minimumCosine: threshold }), /cosine threshold/);
    assert.throws(() => f.index.query({ snapshot: f.index.snapshot, embedding: query, k: 1, filter: { declaredPurity: '' as never } }), /purity/);
    assert.throws(() => f.index.query({ snapshot: f.index.snapshot, embedding: query, k: 1, filter: { kinds: ['UnknownKind' as never] } }), /kind/);
    const second = await f.index.backfill(f.index.scopes(), f.provider); assert.equal(second.embedded, 0); assert.equal(second.reused, 2);
    assert.equal(new HybridGraphIndex(f.options).entries().length, 2);
  } finally { f.cleanup(); }
});

test('typed filters enforce declared purity, return type, capability, parent/child and nominal type dependency constraints', async () => {
  const f = setup();
  try {
    const syms = new SymbolSpace('hybrid-filter'), pure = syms.define('balance'), effectful = syms.define('recordBalance');
    const money = { t: 'Nominal' as const, name: typeName('type:currency:money'), repr: b.Int };
    const term = b.module_({ symbol: syms.define('module'), symbolTable: syms.table(), members: [{ kind: 'TypeDecl', name: typeName('type:currency:money'), ty: money, provenance: null }, b.fn({ symbol: pure, returns: money, body: b.block(b.ret(b.int(1))) }), b.fn({ symbol: effectful, returns: b.Unit, capabilities: [capability('cap:test:log')], purity: 'effectful', body: b.block() })] });
    await f.index.intern(term, context, f.provider); const entries = f.index.entries(), fn = entries.find(entry => entry.structure.kind === 'FunctionDecl' && entry.structure.declaredPurity === 'pure')!;
    const type = entries.find(entry => entry.structure.kind === 'TypeDecl')!; const query = f.index.vectorFor(fn.entryId, fn.inputDigest);
    const result = f.index.query({ snapshot: f.index.snapshot, embedding: query, k: 10, mode: 'exact', filter: { kinds: ['FunctionDecl'], declaredPurity: 'pure', returnType: money, typeName: 'type:currency:money', typeDependency: type.subject, parent: { kind: 'Module', field: 'members' }, child: { kind: 'Block', field: 'body' } } });
    assert.equal(result.hits.length, 1); assert.equal(result.hits[0].subject, fn.subject);
    assert.equal(f.index.query({ snapshot: f.index.snapshot, embedding: query, k: 10, mode: 'exact', filter: { kinds: ['FunctionDecl'], capabilitiesAll: ['cap:test:log'], declaredPurity: 'pure' } }).hits.length, 0);
  } finally { f.cleanup(); }
});

test('context/spec/model changes cannot reuse stale vectors; explicit backfill switches complete snapshots', async () => {
  const f = setup();
  try {
    const root = f.store.intern(b.int(3), { leaseId: 'source' });
    await f.index.backfill([{ root, context }], f.provider); const old = f.index.entries()[0], snapshot = f.index.snapshot, query = f.index.vectorFor(old.entryId, old.inputDigest);
    const changed = { root, context: { text: 'new specification', specRoot: domainDigest('aether.specification/1', 2) } };
    const result = await f.index.backfill([changed], f.provider); assert.equal(result.embedded, 1); assert.equal(result.reused, 0);
    assert.equal(f.index.entries()[0].subject, old.subject); assert.notEqual(f.index.entries()[0].inputDigest, old.inputDigest);
    assert.equal(f.index.entries()[0].scopeDigest, scopeDigest(changed));
    assert.throws(() => f.index.query({ snapshot, embedding: query, k: 1 }), /stale index generation/);
    assert.throws(() => f.index.vectorFor(old.entryId, old.inputDigest), /stale or missing/);
    assert.throws(() => f.index.query({ snapshot: f.index.snapshot, embedding: { ...query, modelDigest: domainDigest('aether.embedding-model/1', 'other') }, k: 1 }), /stale embedding model/);
    assert.throws(() => new HybridGraphIndex({ ...f.options, model: { ...model, revision: '1'.repeat(40) } }), /stale model\/index profile/);
    await assert.rejects(f.index.backfill([changed], { ...f.provider, modelDigest: domainDigest('aether.embedding-model/1', 'other') }), /stale embedding provider/);
  } finally { f.cleanup(); }
});

test('failed inference retains old complete generation; finite canonical float32 encoding rejects malformed provider/wire values', async () => {
  const f = setup();
  try {
    await f.index.intern(b.int(1), context, f.provider); const snapshot = f.index.snapshot;
    await assert.rejects(f.index.intern(b.int(2), context, { ...f.provider, async embed() { throw new Error('inference interrupted'); } }), /interrupted/);
    assert.equal(f.index.snapshot, snapshot); assert.equal(new HybridGraphIndex(f.options).snapshot, snapshot);
    await assert.rejects(f.index.intern(b.int(2), context, { ...f.provider, async embed() { return [[NaN, ...Array(7).fill(0)]]; } }), /invalid embedding vector/);
    assert.equal(f.index.snapshot, snapshot);
    for (const values of [[0, 0], [Infinity, 0], [NaN, 1]]) assert.throws(() => canonicalVector(values));
    const value = canonicalVector([1, -0]); assert.equal(value.bytes, Buffer.from([0, 0, 128, 63, 0, 0, 0, 0]).toString('base64')); assert.equal(decodeVector(value, 2)[0], 1);
    assert.throws(() => decodeVector({ ...value, bytes: value.bytes + '\n' }, 2), /noncanonical/);
  } finally { f.cleanup(); }
});

for (const phase of ['after-embeddings', 'before-generation-commit', 'after-generation-commit'] as const) test(`actual inference/update process SIGKILL at ${phase} exposes old or complete new index generation`, async () => {
  const f = setup();
  try {
    await f.index.intern(b.int(1), context, f.provider); const old = f.index.snapshot;
    const inputPath = join(f.directory, 'child.json'); writeFileSync(inputPath, JSON.stringify({ directory: f.directory, model, phase }));
    const child = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', `
      import {readFileSync} from 'node:fs'; import {join} from 'node:path'; import {HybridGraphIndex,embeddingModelDigest} from './src/tier1/semantic-index.ts'; import {DurableGraphStore} from './src/tier1/durable-store.ts'; import * as b from './src/tier1/build.ts';
      const x=JSON.parse(readFileSync(process.argv[1],'utf8')); const index=new HybridGraphIndex({directory:join(x.directory,'index'),store:new DurableGraphStore({directory:join(x.directory,'store')}),model:x.model,fault(point){if(point===x.phase)process.kill(process.pid,'SIGKILL');}});
      await index.intern(b.int(2),{specRoot:null,text:''},{modelDigest:embeddingModelDigest(x.model),async embed(texts){return texts.map(()=>Array(8).fill(1));}});
    `, inputPath], { encoding: 'utf8', timeout: 15000 });
    assert.equal(child.signal, 'SIGKILL', child.stderr); const reopened = new HybridGraphIndex(f.options);
    assert.equal(reopened.generation, phase === 'after-generation-commit' ? 2 : 1);
    assert.equal(reopened.entries().length, phase === 'after-generation-commit' ? 2 : 1);
    if (phase !== 'after-generation-commit') assert.equal(reopened.snapshot, old);
    await reopened.intern(b.int(2), context, f.provider); assert.equal(reopened.entries().length, 2);
  } finally { f.cleanup(); }
});

test('self-consistent sidecar forgery cannot substitute stale structural/input metadata on reopen', async () => {
  const f = setup();
  try {
    await f.index.intern(b.int(1), context, f.provider);
    const headPath = join(f.directory, 'index', 'head.json'), head = JSON.parse(readFileSync(headPath, 'utf8'));
    const originalPath = join(f.directory, 'index', 'generations', head.digest.split(':').at(-1) + '.json'), state = JSON.parse(readFileSync(originalPath, 'utf8'));
    state.records[0].input.structure.kind = 'FunctionDecl';
    head.digest = domainDigest('aether.hybrid-generation/1', state);
    writeFileSync(join(f.directory, 'index', 'generations', head.digest.split(':').at(-1) + '.json'), encodeCanonical(state)); writeFileSync(headPath, encodeCanonical(head));
    assert.throws(() => new HybridGraphIndex(f.options), /stale embedding input or structural/);
  } finally { f.cleanup(); }
});

test('concurrent backfills serialize publication and reject a stale writer before its inference can overwrite the winner', async () => {
  const f = setup();
  try {
    const peer = new HybridGraphIndex(f.options), initial = f.index.snapshot;
    const firstRoot = f.store.intern(b.int(11), { leaseId: 'race-source' }), secondRoot = f.store.intern(b.int(12), { leaseId: 'race-source' });
    let ready!: () => void, release!: () => void;
    const entered = new Promise<void>(resolve => { ready = resolve; }), blocked = new Promise<void>(resolve => { release = resolve; });
    const first = f.index.backfill([{ root: firstRoot, context }], { ...f.provider, async embed(texts) { ready(); await blocked; return f.provider.embed(texts); } }, initial);
    await entered; let loserInferred = false;
    const second = peer.backfill([{ root: secondRoot, context }], { ...f.provider, async embed(texts) { loserInferred = true; return f.provider.embed(texts); } }, initial);
    const refusal = assert.rejects(second, /stale index generation/); release(); await first; await refusal;
    assert.equal(loserInferred, false); assert.equal(peer.entries().length, 1); assert.equal(peer.entries()[0].subject, firstRoot);
  } finally { f.cleanup(); }
});

test('vector capture rejects accessor/proxy/sparse arrays without publishing and safely normalizes finite subnormals and maxima', async () => {
  const f = setup({ model: { ...model, dimensions: 2 } });
  const provider = { modelDigest: embeddingModelDigest({ ...model, dimensions: 2 }), async embed() { return [[1, 1]]; } };
  try {
    await f.index.intern(b.int(1), context, provider); const snapshot = f.index.snapshot;
    let reads = 0; const accessor = [1, 1]; Object.defineProperty(accessor, '0', { enumerable: true, get() { return ++reads <= 2 ? 1 : NaN; } });
    await assert.rejects(f.index.intern(b.int(2), context, { ...provider, async embed() { return [accessor]; } }), /embedding vector/);
    assert.equal(reads, 0); assert.equal(f.index.snapshot, snapshot); assert.equal(new HybridGraphIndex(f.options).snapshot, snapshot);
    const sparse = new Array<number>(2); sparse[1] = 1;
    const extra = [1, 1] as number[] & { extra?: number }; extra.extra = 1;
    let proxyReads = 0; const proxy = new Proxy([1, 1], { get(target, key, receiver) { proxyReads++; return Reflect.get(target, key, receiver); } });
    for (const vector of [sparse, extra, proxy]) assert.throws(() => canonicalVector(vector), /embedding vector/); assert.equal(proxyReads, 0);
    for (const magnitude of [Number.MIN_VALUE, Number.MAX_VALUE, 1e-300, 1e300]) {
      const vector = canonicalVector([magnitude, magnitude]), decoded = decodeVector(vector, 2);
      assert.ok(Math.abs(decoded[0] - Math.SQRT1_2) < 1e-7); assert.equal(decoded[0], decoded[1]);
    }
    const result = await f.index.intern(b.int(3), context, { ...provider, async embed(texts: readonly string[]) { return texts.map(() => [Number.MIN_VALUE, Number.MIN_VALUE]); } });
    assert.equal(new HybridGraphIndex(f.options).snapshot, result.snapshot);
  } finally { f.cleanup(); }
});

test('expectedInput binds the current indexed source, input digest and exact vector bytes', async () => {
  const f = setup();
  try {
    const root = f.store.intern(b.int(1), { leaseId: 'source' });
    await f.index.backfill([{ root, context }], f.provider); const old = f.index.entries()[0], stale = f.index.vectorFor(old.entryId, old.inputDigest);
    await f.index.backfill([{ root, context: { ...context, text: 'different signed-spec context' } }], f.provider);
    const current = f.index.entries()[0], expectedInput = { entryId: current.entryId, inputDigest: current.inputDigest }, fresh = f.index.vectorFor(current.entryId, current.inputDigest);
    assert.throws(() => f.index.query({ snapshot: f.index.snapshot, embedding: stale, expectedInput, k: 1 }), /stale or substituted indexed query/);
    assert.throws(() => f.index.query({ snapshot: f.index.snapshot, embedding: stale, k: 1 }), /stale or substituted indexed query/);
    assert.throws(() => f.index.query({ snapshot: f.index.snapshot, embedding: { ...fresh, vector: stale.vector }, expectedInput, k: 1 }), /stale or substituted indexed query/);
    assert.equal(f.index.query({ snapshot: f.index.snapshot, embedding: fresh, expectedInput, k: 1 }).hits[0].subject, root);
    await f.index.queryText('independent text queries omit the indexed-source guard', f.provider, { snapshot: f.index.snapshot, k: 1 });
  } finally { f.cleanup(); }
});

for (const phase of ['after-init-marker', 'after-init-profile', 'before-init-head', 'rename-before-head', 'after-init-head', 'after-init-seal', 'before-init-clear', 'after-init-clear'] as const) test(`actual initialization SIGKILL at ${phase} resumes only the prepared empty index`, () => {
  const directory = mkdtempSync(join(tmpdir(), 'aether-index-genesis-'));
  try {
    const input = join(directory, 'child.json'); writeFileSync(input, JSON.stringify({ directory, model, phase }));
    const child = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', `
      import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module'; import {join} from 'node:path'; import {HybridGraphIndex} from './src/tier1/semantic-index.ts'; import {DurableGraphStore} from './src/tier1/durable-store.ts';
      const x=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));
      if(x.phase==='rename-before-head'){const rename=fs.renameSync;fs.renameSync=(from,to)=>{if(String(to)===join(x.directory,'index','head.json'))process.kill(process.pid,'SIGKILL');return rename(from,to);};syncBuiltinESMExports();}
      new HybridGraphIndex({directory:join(x.directory,'index'),store:new DurableGraphStore({directory:join(x.directory,'store')}),model:x.model,fault(point){if(point===x.phase)process.kill(process.pid,'SIGKILL');}});
    `, input], { encoding: 'utf8', timeout: 15000 });
    assert.equal(child.signal, 'SIGKILL', child.stderr);
    const options = { directory: join(directory, 'index'), store: new DurableGraphStore({ directory: join(directory, 'store') }), model };
    const recovered = new HybridGraphIndex(options); assert.equal(recovered.generation, 0); assert.deepEqual(recovered.entries(), []);
    assert.equal(new HybridGraphIndex(options).snapshot, recovered.snapshot);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('completion receipt refuses established-head deletion and replayed initialization markers; legacy adoption never rewrites a head', async () => {
  let savedMarker: Buffer | undefined;
  const directory = mkdtempSync(join(tmpdir(), 'aether-index-init-evidence-'));
  try {
    const indexDirectory = join(directory, 'index'), options = { directory: indexDirectory, store: new DurableGraphStore({ directory: join(directory, 'store') }), model };
    const index = new HybridGraphIndex({ ...options, fault(point) { if (point === 'before-init-clear') savedMarker = readFileSync(join(indexDirectory, 'initializing.json')); } });
    await index.intern(b.int(1), context, { modelDigest: embeddingModelDigest(model), async embed(texts) { return texts.map(() => Array(8).fill(1)); } });
    const head = readFileSync(join(indexDirectory, 'head.json'));
    writeFileSync(join(indexDirectory, 'initializing.json'), savedMarker!);
    assert.throws(() => new HybridGraphIndex(options), /conflicts with established/); assert.deepEqual(readFileSync(join(indexDirectory, 'head.json')), head);
    rmSync(join(indexDirectory, 'initializing.json')); rmSync(join(indexDirectory, 'initialized.json'));
    new HybridGraphIndex(options); assert.deepEqual(readFileSync(join(indexDirectory, 'head.json')), head);
    rmSync(join(indexDirectory, 'head.json'));
    assert.throws(() => new HybridGraphIndex(options), /missing initialized index head/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
