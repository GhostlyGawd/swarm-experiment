import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import * as b from '../../src/tier1/build.ts';
import { CognitiveBlackboard } from '../../src/tier1/cognitive-blackboard.ts';
import { DurableGraphStore } from '../../src/tier1/durable-store.ts';
import { CausalLineageLedger, signIntent, signSpecRevision } from '../../src/tier1/causal-lineage.ts';
import { SymbolSpace } from '../../src/tier1/symbols.ts';
import { domainDigest, executionManifestDigest, type ExecutionManifestV1 } from '../../src/fabric/identity.ts';
import { mintLocalEvidence, type EvidenceContext } from '../../src/fabric/evidence.ts';
import { CapabilityRegistry } from '../../src/tier2/ocap.ts';

const directories: string[] = [];
after(() => directories.forEach(path => rmSync(path, { recursive: true, force: true })));
function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'aether-blackboard-')); directories.push(directory);
  const store = new DurableGraphStore({ directory: join(directory, 'ast') });
  const subject = store.intern(b.int(7), { leaseId: 'source' });
  const d = (name: string) => domainDigest('aether.blackboard-fixture/1', name);
  const manifest: ExecutionManifestV1 = {
    format: 'aether.execution/1', astRoot: subject, specRoot: d('spec'), dependencies: [],
    semanticsVersion: 'aether-reference/1', compilerDigest: d('compiler'),
    target: { abiVersion: 'local/1', profileDigest: d('profile'), artifactDigest: d('artifact') },
    capabilityPolicyDigest: d('policy'), evidencePolicyDigest: d('evidence-policy'),
  };
  const manifestDigest = executionManifestDigest(manifest);
  let principal = 'owner', current = true, verifierValid = true;
  const fakeLineage = {
    assertNodeCurrent: (digest: string, node: string) => { if (digest !== manifestDigest || node !== subject || !current) throw new Error('stale manifest'); },
  } as unknown as CausalLineageLedger;
  const options = {
    directory: join(directory, 'blackboards'), repositoryId: 'repository', store, lineage: fakeLineage,
    actor: () => principal, authorizeCreate: (actor: string) => actor === 'owner', now: () => 1_000,
    verifyEvidence: (evidence: string, digest: string, node: string, verifier: string) => verifierValid && evidence === d('verified-proof') && digest === manifestDigest && node === subject && verifier === 'kernel',
  };
  return { directory, store, subject, manifest, manifestDigest, d, options,
    setPrincipal: (value: string) => { principal = value; },
    setCurrent: (value: boolean) => { current = value; },
    setVerifier: (value: boolean) => { verifierValid = value; } };
}

test('typed task state survives restart, preserves AST identity and separates claims from verified evidence', () => {
  const f = setup(), board = new CognitiveBlackboard(f.options);
  const before = f.store.get(f.subject);
  const id = board.create(f.manifest, f.subject, ['reader'], ['writer'], { maxEntries: 10, expiresAt: 2_000 });
  f.setPrincipal('writer');
  const claim = board.append(id, { kind: 'claim', text: 'The retry is safe', confidence: 6_000 });
  const hypothesis = board.append(id, { kind: 'hypothesis', text: 'Broker key is stable', confidence: 4_500 }, [claim.id]);
  const delegation = board.append(id, { kind: 'delegation', task: 'Check duplicate effects', assignee: 'reviewer' }, [hypothesis.id]);
  assert.throws(() => board.append(id, { kind: 'evidence', claim: claim.id, evidence: f.d('bad-proof'), verifier: 'kernel' }, [claim.id]), /not verified/);
  const evidence = board.append(id, { kind: 'evidence', claim: claim.id, evidence: f.d('verified-proof'), verifier: 'kernel' }, [claim.id]);
  const decision = board.append(id, { kind: 'decision', text: 'Use the stable broker key', rationale: 'Proof checks effect replay' }, [delegation.id, evidence.id]);
  assert.equal(decision.item.kind, 'decision');
  assert.deepEqual(f.store.get(f.subject), before);
  const reopened = new CognitiveBlackboard(f.options); f.setPrincipal('reader');
  assert.deepEqual(reopened.listForNode(f.manifest, f.subject), [id]);
  assert.deepEqual(reopened.listForNode(f.manifest, f.d('unknown-node') as typeof f.subject), []);
  const view = reopened.view(id);
  assert.deepEqual(view.entries.map(entry => entry.item.kind), ['claim', 'hypothesis', 'delegation', 'evidence', 'decision']);
  assert.deepEqual(view.verifiedEvidenceIds, [evidence.id]);
  assert.equal(view.sidecar.subject, f.subject);
  assert.equal(view.sidecar.kind, 'scratchpad');
  assert.equal(view.current, true);
  f.setVerifier(false);
  assert.deepEqual(reopened.view(id).verifiedEvidenceIds, []);
  assert.equal(f.store.roots().leases.source?.[0], f.subject);
});

test('ACL, compare-and-swap and retention deny unauthorized or stale changes', () => {
  const f = setup(), board = new CognitiveBlackboard(f.options);
  f.setPrincipal('intruder');
  assert.throws(() => board.create(f.manifest, f.subject, [], [], { maxEntries: 2, expiresAt: 2_000 }), /creation denied/);
  assert.throws(() => board.create(f.manifest, f.d('unknown-node') as typeof f.subject, [], [], { maxEntries: 2, expiresAt: 2_000 }), /creation denied/);
  f.setPrincipal('owner');
  const id = board.create(f.manifest, f.subject, ['reader'], ['writer'], { maxEntries: 2, expiresAt: 2_000 });
  assert.throws(() => new CognitiveBlackboard({ ...f.options, maxBoards: 1 }).create(f.manifest, f.subject, [], [], { maxEntries: 1, expiresAt: 2_000 }), /count limit/);
  f.setPrincipal('intruder'); assert.throws(() => board.view(id), /access denied/);
  assert.deepEqual(board.listForNode(f.manifest, f.subject), []);
  assert.throws(() => board.append(id, { kind: 'claim', text: 'forged', confidence: 1 }), /access denied/);
  f.setPrincipal('reader'); assert.equal(board.view(id).entries.length, 0);
  assert.throws(() => board.append(id, { kind: 'claim', text: 'write', confidence: 1 }), /access denied/);
  f.setPrincipal('writer');
  const first = board.append(id, { kind: 'claim', text: 'first', confidence: 1 }, [], 1);
  assert.throws(() => board.append(id, { kind: 'claim', text: 'stale', confidence: 1 }, [], 1), /revision conflict/);
  const second = board.append(id, { kind: 'hypothesis', text: 'second', confidence: 2 });
  board.append(id, { kind: 'decision', text: 'third', rationale: 'bounded' });
  assert.deepEqual(board.view(id).entries.map(entry => entry.id), [second.id, board.view(id).entries[1].id]);
  assert.throws(() => board.append(id, { kind: 'decision', text: 'orphan', rationale: 'bad' }, [first.id]), /retained-away/);
  assert.throws(() => board.configure(id, { owner: 'writer', readers: [], writers: [] }, { maxEntries: 2, expiresAt: 2_000 }, 4), /only owner/);
  f.setPrincipal('owner');
  assert.throws(() => board.configure(id, { owner: 'owner', readers: [], writers: [] }, { maxEntries: 3, expiresAt: 2_000 }, 4), /cannot be extended/);
  board.configure(id, { owner: 'owner', readers: [], writers: ['writer'] }, { maxEntries: 1, expiresAt: 2_000 }, 4);
  f.setPrincipal('reader'); assert.throws(() => board.view(id), /access denied/);
  assert.deepEqual(board.listForNode(f.manifest, f.subject), []);
  f.setPrincipal('owner'); assert.equal(board.view(id).entries.length, 1);
});

test('expiry, subject binding and invalidated lineage fail closed', () => {
  const f = setup(); let now = 1_000;
  const options = { ...f.options, now: () => now };
  const board = new CognitiveBlackboard(options);
  assert.throws(() => board.create(f.manifest, f.d('other') as typeof f.subject, [], [], { maxEntries: 1, expiresAt: 2_000 }));
  const id = board.create(f.manifest, f.subject, [], [], { maxEntries: 1, expiresAt: 2_000 });
  assert.deepEqual(board.listForNode(f.manifest, f.subject), [id]);
  f.setCurrent(false);
  assert.throws(() => board.append(id, { kind: 'claim', text: 'stale', confidence: 5 }), /stale manifest/);
  f.setCurrent(true);
  now = 2_000; assert.throws(() => board.view(id), /retention expired/);
  assert.deepEqual(board.listForNode(f.manifest, f.subject), []);
  assert.equal(board.sweep(id), true);
  assert.throws(() => board.view(id));
});

test('asynchronous policy callbacks cannot become accidental authority', () => {
  const f = setup();
  const asyncCreate = new CognitiveBlackboard({ ...f.options, authorizeCreate: (() => Promise.resolve(true)) as unknown as typeof f.options.authorizeCreate });
  assert.throws(() => asyncCreate.create(f.manifest, f.subject, [], [], { maxEntries: 3, expiresAt: 2_000 }), /creation denied/);
  const board = new CognitiveBlackboard(f.options), id = board.create(f.manifest, f.subject, [], [], { maxEntries: 3, expiresAt: 2_000 });
  const claim = board.append(id, { kind: 'claim', text: 'Needs proof', confidence: 3_000 });
  const asyncEvidence = new CognitiveBlackboard({ ...f.options, verifyEvidence: (() => Promise.resolve(true)) as unknown as typeof f.options.verifyEvidence });
  assert.throws(() => asyncEvidence.append(id, { kind: 'evidence', claim: claim.id, evidence: f.d('verified-proof'), verifier: 'kernel' }, [claim.id]), /not verified/);
  const proof = board.append(id, { kind: 'evidence', claim: claim.id, evidence: f.d('verified-proof'), verifier: 'kernel' }, [claim.id]);
  assert.deepEqual(asyncEvidence.view(id).verifiedEvidenceIds, []);
  assert.deepEqual(board.view(id).verifiedEvidenceIds, [proof.id]);
});

test('real signed artifact lineage binds a child-node board and later marks its evidence stale', () => {
  const directory = mkdtempSync(join(tmpdir(), 'aether-blackboard-lineage-')); directories.push(directory);
  const store = new DurableGraphStore({ directory: join(directory, 'ast') });
  const keys = generateKeyPairSync('ed25519'), symbols = new SymbolSpace('blackboard-integration');
  const functionSymbol = symbols.define('increment'), parameter = symbols.define('input'), moduleSymbol = symbols.define('module');
  const declaration = b.fn({ symbol: functionSymbol, params: [b.param(parameter, b.Int)], returns: b.Int,
    contract: b.contract({ ensures: [b.clause(b.eq(b.result(), b.add(b.old(b.v(parameter)), b.int(1))), 'increment')] }),
    body: b.ret(b.add(b.v(parameter), b.int(1))) });
  const module = b.module_({ symbol: moduleSymbol, members: [declaration], symbolTable: symbols.table() });
  const root = store.intern(module, { leaseId: 'source' });
  const child = store.intern(b.int(1), { leaseId: 'child' });
  const digest = (name: string) => domainDigest('aether.blackboard-integration/1', name);
  const lineage = new CausalLineageLedger({ directory: join(directory, 'lineage'), repositoryId: 'repository', store,
    authority: () => ({ policyEpoch: '0', eligibleAuthors: ['author'] }), authorKey: () => keys.publicKey });
  const spec = lineage.publishSpec(signSpecRevision({ repositoryId: 'repository', id: 'increment', revision: 1, previous: null,
    parents: [], text: 'Increment the input.', requirements: [], author: 'author', policyEpoch: '0', nonce: 'spec-1' }, keys.privateKey));
  const context: EvidenceContext = { module, specification: lineage.specification([], [{ id: 'increment', revision: spec }]),
    semanticsVersion: 'aether-reference/1', compilerDigest: digest('compiler'),
    target: { abiVersion: 'local/1', profileDigest: digest('profile'), artifactDigest: digest('artifact') },
    capabilityPolicyDigest: digest('capabilities'), registry: new CapabilityRegistry() };
  const evidence = mintLocalEvidence(context), manifest = evidence.manifest, manifestDigest = executionManifestDigest(manifest);
  const intent = lineage.recordIntent(signIntent({ repositoryId: 'repository', subject: root, executionManifest: manifestDigest,
    evidenceBundleDigest: domainDigest('aether.evidence-bundle/1', evidence), parents: [], specifications: [{ id: 'increment', revision: spec }],
    purpose: 'genesis', text: 'Implement increment.', author: 'author', policyEpoch: '0', nonce: 'intent-1' }, keys.privateKey));
  lineage.admitArtifact(intent, evidence, context);
  const board = new CognitiveBlackboard({ directory: join(directory, 'blackboard'), repositoryId: 'repository', store, lineage,
    actor: () => 'author', authorizeCreate: () => true, now: () => 1_000,
    verifyEvidence: (proof, claimedManifest, subject, verifier) => proof === digest('proof') && claimedManifest === manifestDigest && subject === child && verifier === 'kernel' });
  const id = board.create(manifest, child, [], [], { maxEntries: 5, expiresAt: 2_000 });
  const claim = board.append(id, { kind: 'claim', text: 'The branch preserves the result', confidence: 9_000 });
  const proof = board.append(id, { kind: 'evidence', claim: claim.id, evidence: digest('proof'), verifier: 'kernel' }, [claim.id]);
  assert.deepEqual(board.view(id).verifiedEvidenceIds, [proof.id]);
  lineage.publishSpec(signSpecRevision({ repositoryId: 'repository', id: 'increment', revision: 2, previous: spec,
    parents: [], text: 'Revised increment intent.', requirements: [], author: 'author', policyEpoch: '0', nonce: 'spec-2' }, keys.privateKey));
  const historical = new CognitiveBlackboard({ directory: join(directory, 'blackboard'), repositoryId: 'repository', store, lineage,
    actor: () => 'author', authorizeCreate: () => true, now: () => 1_000, verifyEvidence: () => true }).view(id);
  assert.equal(historical.current, false);
  assert.deepEqual(historical.verifiedEvidenceIds, []);
  assert.throws(() => board.append(id, { kind: 'decision', text: 'approve', rationale: 'stale' }), /InvalidatedSpec/);
  assert.equal(store.get(root).kind, 'Module');
});
