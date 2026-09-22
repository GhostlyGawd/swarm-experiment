import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import * as b from '../../src/tier1/build.ts';
import type { Term } from '../../src/tier1/ast.ts';
import { GraphStore } from '../../src/tier1/store.ts';
import { DurableGraphStore } from '../../src/tier1/durable-store.ts';
import { SymbolSpace } from '../../src/tier1/symbols.ts';
import { CausalLineageLedger, fenceRequirement, signIntent, signSpecRevision, validateStrictLineageAdmission, type LineageAuthority, type SignedSpecRevision, type SpecReference } from '../../src/tier1/causal-lineage.ts';
import { CapabilityRegistry } from '../../src/tier2/ocap.ts';
import { mintLocalEvidence, validateEvidence, type EvidenceContext } from '../../src/fabric/evidence.ts';
import { encodeCanonical } from '../../src/fabric/encoding.ts';
import { domainDigest, executionManifestDigest, type Digest } from '../../src/fabric/identity.ts';
import type { PromotionBindingV1 } from '../../src/fabric/promotion.ts';

const dirs: string[] = [];
function temporary(): string { const path = mkdtempSync(join(tmpdir(), 'aether-lineage-')); dirs.push(path); return path; }
after(() => dirs.forEach(path => rmSync(path, { recursive: true, force: true })));
const digest = (name: string) => domainDigest('aether.lineage-test/1', name);
const fn = (spec: Parameters<typeof b.fn>[0]) => b.fn(spec) as Extract<Term, { kind: 'FunctionDecl' }>;
function setup() {
  const directory = temporary(), storeDirectory = join(directory, 'store'), lineageDirectory = join(directory, 'lineage');
  const store = new DurableGraphStore({ directory: storeDirectory }), keys = generateKeyPairSync('ed25519');
  let authority: LineageAuthority = { policyEpoch: '0', eligibleAuthors: ['author'] };
  const options = { directory: lineageDirectory, repositoryId: 'repository', store, authority: () => authority, authorKey: () => keys.publicKey };
  const ledger = new CausalLineageLedger(options), symbols = new SymbolSpace('lineage-test');
  const functionSymbol = symbols.define('increment'), x = symbols.define('x'), moduleSymbol = symbols.define('module');
  const decl = fn({ symbol: functionSymbol, params: [b.param(x, b.Int)], returns: b.Int, contract: b.contract({ ensures: [b.clause(b.eq(b.result(), b.add(b.old(b.v(x)), b.int(1))), 'increment')] }), body: b.ret(b.add(b.v(x), b.int(1))) });
  const module = b.module_({ symbol: moduleSymbol, members: [decl], symbolTable: symbols.table() });
  store.intern(module, { leaseId: 'source' });
  const spec = (id: string, revision: number, previous: Digest | null, parents: readonly SpecReference[] = [], text = 'Increment input by one.', protected_ = true): SignedSpecRevision => signSpecRevision({ repositoryId: 'repository', id, revision, previous, parents, text, requirements: protected_ ? [fenceRequirement(decl)] : [], author: 'author', policyEpoch: authority.policyEpoch, nonce: `${id}-${revision}` }, keys.privateKey);
  const initialSpec = ledger.publishSpec(spec('increment', 1, null));
  let count = 0;
  const artifact = (parents: readonly Digest[] = [], specs: readonly SpecReference[] = [{ id: 'increment', revision: initialSpec }], candidate: Term = module, compiler = 'compiler') => {
    const root = store.intern(candidate, { leaseId: `candidate-${++count}` });
    const context: EvidenceContext = { module: candidate, specification: ledger.specification(parents, specs), semanticsVersion: 'aether-reference/1', compilerDigest: digest(compiler), target: { abiVersion: 'local/1', profileDigest: digest('target-profile'), artifactDigest: digest(`artifact-${compiler}`) }, capabilityPolicyDigest: digest('capabilities'), registry: new CapabilityRegistry() };
    const evidence = mintLocalEvidence(context), manifest = evidence.manifest, manifestDigest = executionManifestDigest(manifest);
    const intent = ledger.recordIntent(signIntent({ repositoryId: 'repository', subject: root, executionManifest: manifestDigest, evidenceBundleDigest: domainDigest('aether.evidence-bundle/1', evidence), parents, specifications: specs, purpose: parents.length ? 'rewrite' : 'genesis', text: 'Implement the signed specification.', author: 'author', policyEpoch: authority.policyEpoch, nonce: `intent-${count}` }, keys.privateKey));
    const admission = ledger.admitArtifact(intent, evidence, context);
    return { root, intent, admission, context, evidence, manifest, manifestDigest };
  };
  return { directory, storeDirectory, lineageDirectory, store, ledger, keys, symbols, functionSymbol, x, decl, module, spec, initialSpec, artifact, options, setAuthority: (value: LineageAuthority) => { authority = value; } };
}
function binding(parent: Digest, manifest: ReturnType<ReturnType<typeof setup>['artifact']>['manifest'], expectedEvidence: Digest): PromotionBindingV1 {
  const candidate = executionManifestDigest(manifest);
  return { format: 'aether.promotion-binding/1', proposalDigest: domainDigest('aether.promotion/1', 'fixture'), manifest, generation: '1', migrationPlan: { tag: 'null' }, effectPlan: { tag: 'null' }, proposal: { format: 'aether.promotion/1', repositoryId: 'repository', expectedParent: parent, candidateManifest: candidate, evidenceBundleDigest: expectedEvidence, migrationPlanDigest: domainDigest('aether.migration-plan/1', 'fixture'), effectPlanDigest: domainDigest('aether.effect-plan/1', 'fixture'), membershipEpoch: '0', policyEpoch: '0', expiresAt: '99999999999999' } };
}

test('every admitted artifact and shared child resolves to all signed causal links after reopen and GC', () => {
  const f = setup(), first = f.artifact(), second = f.artifact([first.intent], [], f.module, 'compiler-next');
  f.ledger.assertCurrent(first.manifestDigest); f.ledger.assertCurrent(second.manifestDigest);
  const literal = new GraphStore().intern(b.int(1));
  const links = f.ledger.lineage(literal);
  assert.equal(links.length, 2); assert.ok(links.some(link => link.ancestry.length === 2));
  const reopened = new CausalLineageLedger(f.options);
  assert.deepEqual(reopened.lineage(literal), links);
  for (const lease of Object.keys(f.store.roots().leases)) if (!lease.startsWith('lineage-')) f.store.release(lease);
  f.store.collectGarbage(); assert.equal(f.store.get(first.root).kind, 'Module');
  assert.throws(() => reopened.assertCurrent(domainDigest('aether.execution/1', 'unknown')), /lacks signed intent/);
});

test('malformed lineage authority cannot authorize through string substring membership', () => {
  const f = setup(), artifact = f.artifact();
  f.setAuthority({ policyEpoch: '0', eligibleAuthors: 'not-authorized-author' } as unknown as LineageAuthority);
  assert.throws(() => f.ledger.assertCurrent(artifact.manifestDigest), /author|authority/);
  assert.throws(() => f.ledger.publishSpec(f.spec('new-spec', 1, null)), /author|authority/);
});

test('forged signatures, missing intent ancestry and mismatched evidence cannot authorize artifacts', () => {
  const f = setup(), first = f.artifact();
  const badKeys = generateKeyPairSync('ed25519');
  const body = { repositoryId: 'repository', subject: first.root, executionManifest: first.manifestDigest, evidenceBundleDigest: domainDigest('aether.evidence-bundle/1', first.evidence), parents: [], specifications: [{ id: 'increment', revision: f.initialSpec }], purpose: 'genesis' as const, text: 'forged', author: 'author', policyEpoch: '0', nonce: 'forged' };
  assert.throws(() => f.ledger.recordIntent(signIntent(body, badKeys.privateKey)), /signature/);
  assert.throws(() => f.ledger.recordIntent(signIntent({ ...body, parents: [domainDigest('aether.intent/1', 'missing')] }, f.keys.privateKey)), /unknown (?:parent|causal) intent/);
  const altered = JSON.parse(JSON.stringify(first.evidence)); altered.reports[0].verdict = 'refuted';
  assert.throws(() => f.ledger.admitArtifact(first.intent, altered, first.context), /evidence|digest|report/i);
  assert.throws(() => f.ledger.admitArtifact(first.intent, first.evidence, { ...first.context, compilerDigest: digest('different') }), /manifest|evidence/i);
});

test('spec revisions invalidate every derived artifact, shared node and ancestor without a clear-flag bypass', () => {
  const f = setup(), first = f.artifact(), derived = f.artifact([first.intent], [], f.module, 'derived');
  f.ledger.publishSpec(f.spec('increment', 2, f.initialSpec, [], 'Clarified increment specification.'));
  assert.throws(() => f.ledger.assertCurrent(first.manifestDigest), /InvalidatedSpec/);
  assert.throws(() => f.ledger.assertCurrent(derived.manifestDigest), /InvalidatedSpec/);
  const literal = new GraphStore().intern(b.int(1));
  assert.equal(f.ledger.invalidation(literal).length, 2);
  assert.equal(f.ledger.invalidation(first.root).length, 2);
  assert.throws(() => f.ledger.admitArtifact(first.intent, first.evidence, first.context), /InvalidatedSpec/);
});

test('explicit signed reconciliation preserves historical causes while requiring new specification-bound evidence', () => {
  const f = setup(), first = f.artifact();
  const updated = f.ledger.publishSpec(f.spec('increment', 2, f.initialSpec, [], 'Updated text, same formal obligation.'));
  const next = f.artifact([first.intent], [{ id: 'increment', revision: updated }]);
  f.ledger.assertCurrent(next.manifestDigest);
  assert.notEqual(first.manifestDigest, next.manifestDigest);
  assert.ok(f.ledger.lineage(next.root).some(link => link.ancestry.length === 2));
  assert.throws(() => f.ledger.assertCurrent(first.manifestDigest), /InvalidatedSpec/);
});

test('transitive specification parents propagate invalidation through derived clauses', () => {
  const f = setup();
  const parent = f.ledger.publishSpec(f.spec('architecture', 1, null, [], 'Architecture constraint.', false));
  const child = f.ledger.publishSpec(f.spec('child', 1, null, [{ id: 'architecture', revision: parent }]));
  const artifact = f.artifact([], [{ id: 'child', revision: child }]);
  f.ledger.publishSpec(f.spec('architecture', 2, parent, [], 'Changed architecture.', false));
  assert.throws(() => f.ledger.assertCurrent(artifact.manifestDigest), /InvalidatedSpec/);
  assert.deepEqual(f.ledger.invalidation()[0].specifications, ['architecture']);
  assert.throws(() => f.ledger.specification([], [{ id: 'child', revision: child }]), /InvalidatedSpec/);
});

test('fences reject pruning, removed contracts and vacuous proofs from strengthened preconditions', () => {
  const f = setup(), first = f.artifact();
  const strengthened = { ...f.decl, contract: b.contract({ requires: [b.clause(b.bool(false), 'reject-all')], ensures: (f.decl.contract as Extract<Term, { kind: 'Contract' }>).ensures }) };
  const removed = { ...f.decl, contract: b.contract({ ensures: [] }) };
  assert.equal(f.module.kind, 'Module'); if (f.module.kind !== 'Module') throw new Error('fixture');
  const original = f.module;
  for (const declaration of [strengthened, removed]) {
    const module = { ...original, members: [declaration] };
    assert.throws(() => f.artifact([first.intent], [], module), /fence|specification/);
  }
  const other = fn({ symbol: f.symbols.define('other'), returns: b.Int, contract: b.contract({ ensures: [b.clause(b.eq(b.result(), b.int(1)), 'one')] }), body: b.ret(b.int(1)) });
  assert.throws(() => f.artifact([first.intent], [], { ...original, members: [other] }), /pruned/);
});

test('strict promotion adapter requires full parent lineage and an explicit fresh precommit checkpoint', async () => {
  const f = setup(), first = f.artifact(), next = f.artifact([first.intent], [], f.module, 'candidate');
  const adapter = f.ledger.admissionAdapter(), request = binding(first.manifestDigest, next.manifest, domainDigest('aether.evidence-bundle/1', next.evidence)), evidence = validateEvidence(next.evidence, next.context);
  assert.equal(adapter.profile, 'aether.strict-lineage-admission/1');
  assert.equal(await adapter.withAdmission(request, evidence, async checkpoint => { await Promise.resolve(); checkpoint(); return 'committed'; }), 'committed');
  await assert.rejects(adapter.withAdmission(request, evidence, async () => 'unsafe'), /checkpoint was not called/);
  await assert.rejects(adapter.withAdmission({ ...request, proposal: { ...request.proposal, evidenceBundleDigest: domainDigest('aether.evidence-bundle/1', 'unsigned-proof') } }, evidence, async checkpoint => { checkpoint(); }), /exact signed intent/);
  const disconnected = f.artifact([], [{ id: 'increment', revision: f.initialSpec }], f.module, 'disconnected');
  await assert.rejects(adapter.withAdmission(binding(first.manifestDigest, disconnected.manifest, domainDigest('aether.evidence-bundle/1', disconnected.evidence)), validateEvidence(disconnected.evidence, disconnected.context), async checkpoint => { checkpoint(); }), /dropped parent causal links/);
});

test('authority revocation during asynchronous preparation is rechecked before commit', async () => {
  const f = setup(), first = f.artifact(), next = f.artifact([first.intent], [], f.module, 'candidate');
  let committed = false;
  await assert.rejects(f.ledger.admissionAdapter().withAdmission(binding(first.manifestDigest, next.manifest, domainDigest('aether.evidence-bundle/1', next.evidence)), validateEvidence(next.evidence, next.context), async checkpoint => {
    await Promise.resolve(); f.setAuthority({ policyEpoch: '1', eligibleAuthors: ['author'] }); checkpoint(); committed = true;
  }), /policy epoch mismatch|stale lineage policy/);
  assert.equal(committed, false);
  assert.throws(() => f.ledger.assertCurrent(next.manifestDigest), /stale lineage policy/);
});

test('specification compare-and-swap rejects stale edits and missing initialized metadata fails closed', () => {
  const f = setup();
  f.ledger.publishSpec(f.spec('increment', 2, f.initialSpec, [], 'Winner.'));
  assert.throws(() => f.ledger.publishSpec(f.spec('increment', 2, f.initialSpec, [], 'Stale loser.')), /compare-and-swap/);
  unlinkSync(join(f.lineageDirectory, 'lineage.json'));
  assert.throws(() => new CausalLineageLedger(f.options), /missing initialized lineage state/);
});

for (const point of ['before-state-publish', 'after-state-publish'] as const) test(`actual SIGKILL ${point} preserves a complete old or new specification epoch`, async () => {
  const f = setup(), artifact = f.artifact(), next = f.spec('increment', 2, f.initialSpec, [], 'Crash edit.');
  const publicKey = f.keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const source = `import{CausalLineageLedger}from ${JSON.stringify(new URL('../../src/tier1/causal-lineage.ts', import.meta.url).href)};import{DurableGraphStore}from ${JSON.stringify(new URL('../../src/tier1/durable-store.ts', import.meta.url).href)};let armed=false;const ledger=new CausalLineageLedger({directory:${JSON.stringify(f.lineageDirectory)},repositoryId:'repository',store:new DurableGraphStore({directory:${JSON.stringify(f.storeDirectory)}}),authority:()=>({policyEpoch:'0',eligibleAuthors:['author']}),authorKey:()=>${JSON.stringify(publicKey)},fault:p=>{if(armed&&p===${JSON.stringify(point)})process.kill(process.pid,'SIGKILL');}});armed=true;ledger.publishSpec(${JSON.stringify(next)});`;
  const result = await new Promise<{ signal: string | null; output: string }>((resolve, reject) => { const child = spawn(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', source], { stdio: ['ignore', 'pipe', 'pipe'] }); let output = ''; child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; }); child.once('error', reject); child.once('exit', (_code, signal) => resolve({ signal, output })); });
  assert.equal(result.signal, 'SIGKILL', result.output);
  const reopened = new CausalLineageLedger(f.options);
  if (point === 'before-state-publish') reopened.assertCurrent(artifact.manifestDigest);
  else assert.throws(() => reopened.assertCurrent(artifact.manifestDigest), /InvalidatedSpec/);
  f.store.collectGarbage(); assert.equal(f.store.get(artifact.root).kind, 'Module');
});


test('a recomputed journal checksum cannot swap signed evidence or hide shared child lineage', () => {
  for (const corruption of ['evidence', 'closure'] as const) {
    const f = setup(); f.artifact();
    const file = join(f.lineageDirectory, 'lineage.json'), journal = JSON.parse(readFileSync(file, 'utf8'));
    const artifact = journal.state.artifacts[0];
    if (corruption === 'evidence') artifact.evidence.reports[0].verdict = 'refuted';
    else artifact.nodes = [artifact.manifest.astRoot];
    const { id: _id, ...body } = artifact; artifact.id = domainDigest('aether.lineage-artifact/1', body);
    journal.checksum = domainDigest('aether.lineage-state/1', journal.state);
    writeFileSync(file, encodeCanonical(journal));
    assert.throws(() => new CausalLineageLedger(f.options), corruption === 'evidence' ? /signed artifact evidence/ : /causal closure/);
  }
});

test('an actual concurrent spec editor waits for the strict promotion admission lock', async () => {
  const f = setup(), first = f.artifact(), next = f.artifact([first.intent], [], f.module, 'candidate');
  const update = f.spec('increment', 2, f.initialSpec, [], 'Concurrent specification update.');
  const publicKey = f.keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const source = `import{CausalLineageLedger}from ${JSON.stringify(new URL('../../src/tier1/causal-lineage.ts', import.meta.url).href)};import{DurableGraphStore}from ${JSON.stringify(new URL('../../src/tier1/durable-store.ts', import.meta.url).href)};console.log('attempting');const ledger=new CausalLineageLedger({directory:${JSON.stringify(f.lineageDirectory)},repositoryId:'repository',store:new DurableGraphStore({directory:${JSON.stringify(f.storeDirectory)}}),authority:()=>({policyEpoch:'0',eligibleAuthors:['author']}),authorKey:()=>${JSON.stringify(publicKey)}});ledger.publishSpec(${JSON.stringify(update)});`;
  let completion: Promise<{ code: number | null; output: string }> | undefined, exited = false;
  await f.ledger.admissionAdapter().withAdmission(binding(first.manifestDigest, next.manifest, domainDigest('aether.evidence-bundle/1', next.evidence)), validateEvidence(next.evidence, next.context), async checkpoint => {
    const child = spawn(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', source], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const attempting = new Promise<void>((resolve, reject) => { child.stdout.on('data', chunk => { output += chunk; if (output.includes('attempting')) resolve(); }); child.once('error', reject); });
    child.stderr.on('data', chunk => { output += chunk; });
    completion = new Promise(resolve => child.once('exit', code => { exited = true; resolve({ code, output }); }));
    await attempting; await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(exited, false, 'editor must wait while promotion owns the lineage lock');
    checkpoint();
  });
  const result = await completion!; assert.equal(result.code, 0, result.output);
  assert.throws(() => f.ledger.assertCurrent(next.manifestDigest), /InvalidatedSpec/);
});

test('external dependency AST content is persisted, pinned and linked to its signed artifact', () => {
  const f = setup();
  const entrySymbol = f.symbols.define('entry');
  const entry = fn({ symbol: entrySymbol, params: [b.param(f.x, b.Int)], returns: b.Int, contract: b.contract({ ensures: [b.clause(b.eq(b.result(), b.add(b.old(b.v(f.x)), b.int(1))), 'entry-increment')] }), body: b.ret(b.call(f.functionSymbol, b.v(f.x))) });
  const module = b.module_({ symbol: f.symbols.define('external-module'), members: [entry], symbolTable: f.symbols.table() });
  const root = f.store.intern(module, { leaseId: 'external-root' });
  const specs = [{ id: 'increment', revision: f.initialSpec }];
  const context: EvidenceContext = { module, specification: f.ledger.specification([], specs), semanticsVersion: 'aether-reference/1', compilerDigest: digest('external-compiler'), target: { abiVersion: 'local/1', profileDigest: digest('profile'), artifactDigest: digest('external-artifact') }, capabilityPolicyDigest: digest('capabilities'), registry: new CapabilityRegistry(), resolveDeclaration: symbol => symbol === f.functionSymbol ? f.decl : undefined };
  const evidence = mintLocalEvidence(context), manifestDigest = executionManifestDigest(evidence.manifest);
  const intent = f.ledger.recordIntent(signIntent({ repositoryId: 'repository', subject: root, executionManifest: manifestDigest, evidenceBundleDigest: domainDigest('aether.evidence-bundle/1', evidence), parents: [], specifications: specs, purpose: 'genesis', text: 'Use the verified dependency.', author: 'author', policyEpoch: '0', nonce: 'external-intent' }, f.keys.privateKey));
  f.ledger.admitArtifact(intent, evidence, context);
  const dependencyRoot = new GraphStore().intern(f.decl);
  assert.ok(f.ledger.lineage(dependencyRoot).some(link => link.intent === intent));
  for (const lease of Object.keys(f.store.roots().leases)) if (!lease.startsWith('lineage-')) f.store.release(lease);
  f.store.collectGarbage(); assert.equal(f.store.get(dependencyRoot).kind, 'FunctionDecl');
  new CausalLineageLedger(f.options).assertCurrent(manifestDigest);
});


test('strict adapters are branded and renewed artifact authorization does not erase historical causes', () => {
  const f = setup(), first = f.artifact(), adapter = f.ledger.admissionAdapter();
  validateStrictLineageAdmission(adapter, 'repository');
  assert.throws(() => validateStrictLineageAdmission({ ...adapter }, 'repository'), /untrusted/);
  assert.throws(() => validateStrictLineageAdmission(adapter, 'different-repository'), /untrusted/);
  f.setAuthority({ policyEpoch: '1', eligibleAuthors: ['author'] });
  assert.throws(() => f.ledger.assertCurrent(first.manifestDigest), /stale lineage policy/);
  const renewed = f.artifact([first.intent], []);
  assert.equal(renewed.manifestDigest, first.manifestDigest);
  f.ledger.assertCurrent(first.manifestDigest);
  assert.equal(f.ledger.lineage(first.root).length, 2);
  assert.ok(f.ledger.invalidation(first.root).some(item => item.reason === 'InvalidatedPolicy'));
});
