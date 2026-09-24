import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as b from '../../src/tier1/build.ts';
import { linkGroups, type Term } from '../../src/tier1/ast.ts';
import { SymbolSpace } from '../../src/tier1/symbols.ts';
import { capability, type NodeRef, type SymbolId, type CapabilityName } from '../../src/tier1/ids.ts';
import { GraphStore } from '../../src/tier1/store.ts';
import { DurableGraphStore } from '../../src/tier1/durable-store.ts';
import { SemanticGarbageCollector, SEMANTIC_GC_PROFILE, SEMANTIC_GC_BRANCH_PROFILE, SEMANTIC_GC_SHIM_PROFILE, SEMANTIC_GC_CALL_SHIM_PROFILE, SEMANTIC_GC_FUEL_PROFILE, type SemanticGcOptions, type SemanticGcProposal, type SemanticRetentionKind } from '../../src/tier1/semantic-gc.ts';
import { CausalLineageLedger, signIntent, signSpecRevision, fenceRequirement } from '../../src/tier1/causal-lineage.ts';
import { CapabilityRegistry } from '../../src/tier2/ocap.ts';
import { mintLocalEvidence, type EvidenceContext } from '../../src/fabric/evidence.ts';
import { domainDigest, executionManifestDigest } from '../../src/fabric/identity.ts';
import { approvePromotion, createPromotionHandle, evidenceBundleDigest, effectPlanDigest, migrationPlanDigest, PromotionCoordinator, type PromotionDriver, type PromotionInput, type PromotionCoordinatorOptions } from '../../src/fabric/promotion.ts';
import { ProductionRuntime } from '../../src/tier3/compile.ts';
import { Runtime } from '../../src/tier3/runtime.ts';
import { encodeCanonical } from '../../src/fabric/encoding.ts';

type Module = Extract<Term, { kind: 'Module' }>;
type FixtureNames = { target: SymbolId; wrapper: SymbolId; entry: SymbolId; sink: SymbolId; dead: SymbolId; fenced: SymbolId; x: SymbolId; w: SymbolId; n: SymbolId; message: SymbolId; log: CapabilityName };
function fixture(options: { shimProfile?: boolean; callShimProfile?: boolean; fuelBranchProfile?: boolean; protectTarget?: boolean; protectWrapper?: boolean; exportWrapper?: boolean; branchProfile?: boolean; transform?: (module: Module, names: FixtureNames, symbols: SymbolSpace) => Module; nonlinear?: boolean; opaque?: boolean; fenceWrapper?: boolean; booleanWrapper?: boolean } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'aether-semantic-gc-')), store = new DurableGraphStore({ directory: join(directory, 'ast') });
  const symbols = new SymbolSpace('semantic-gc-fixture'), target = symbols.define('increment'), wrapper = symbols.define('forward'), entry = symbols.define('compute'), sink = symbols.define('append'), dead = symbols.define('unused'), fenced = symbols.define('protected');
  const x = symbols.define('x'), w = symbols.define('w'), n = symbols.define('n'), message = symbols.define('message'), log = capability('cap:test:append');
  const registry = new CapabilityRegistry(); registry.declare(log, { arity: 1, description: 'append test value', effectful: true });
  const scalarType = options.booleanWrapper ? b.Bool : b.Int;
  const targetDecl = b.fn({ symbol: target, contract: b.contract({}), params: [b.param(x, scalarType)], returns: scalarType, body: b.ret(options.booleanWrapper ? b.not(b.v(x)) : options.nonlinear ? b.mul(b.v(x), b.v(x)) : b.add(b.v(x), b.int(1))) });
  const protectedDecl = b.fn({ symbol: fenced, returns: b.Int, contract: b.contract({ ensures: [b.clause(b.eq(b.result(), b.int(7)), 'fixed-protected-value')] }), body: b.ret(b.int(7)) });
  let module = b.module_({ symbol: symbols.define('module'), symbolTable: symbols.table(), members: [targetDecl,
    b.fn({ symbol: wrapper, contract: options.fenceWrapper ? b.contract({ ensures: [b.clause(b.bool(true), 'required-wrapper-presence')] }) : b.contract({}), params: [b.param(w, scalarType)], returns: scalarType, body: b.block(b.ret(b.call(target, b.v(w)))) }),
    b.fn({ symbol: entry, contract: b.contract({}), params: [b.param(n, scalarType)], returns: scalarType, body: b.ret(options.booleanWrapper ? b.call(wrapper, b.v(n)) : b.add(b.call(wrapper, b.v(n)), b.int(10))) }),
    b.fn({ symbol: sink, contract: b.contract({}), params: [b.param(message, b.Str)], returns: b.Unit, capabilities: [log], purity: 'effectful', body: b.block(b.exprStmt(b.invoke(log, b.v(message))), b.ret(b.unit())) }),
    b.fn({ symbol: dead, contract: b.contract({}), returns: options.opaque ? { t: 'Task', result: b.Int } : b.Unit, capabilities: options.opaque ? [] : [log], purity: options.opaque ? 'pure' : 'effectful', body: options.opaque ? b.ret(b.spawn(b.int(1))) : b.block(b.exprStmt(b.invoke(log, b.str('unreachable effect'))), b.ret(b.unit())) }), protectedDecl,
  ] }) as Extract<Term, { kind: 'Module' }>;
  if (options.transform) module = options.transform(module, { target, wrapper, entry, sink, dead, fenced, x, w, n, message, log }, symbols);
  module = { ...module, symbolTable: symbols.table() };
  store.intern(module, { leaseId: 'source-draft' });
  const author = generateKeyPairSync('ed25519'), governor = generateKeyPairSync('ed25519'), authority = { policyEpoch: '1', eligibleAuthors: ['author'] };
  const lineage = new CausalLineageLedger({ directory: join(directory, 'lineage'), repositoryId: 'semantic-gc', store, authority: () => authority, authorKey: () => author.publicKey });
  const spec = { id: 'application', revision: lineage.publishSpec(signSpecRevision({ repositoryId: 'semantic-gc', id: 'application', revision: 1, previous: null, parents: [], text: 'Preserve compute and append exports, exact append effects, and the protected function.', requirements: [fenceRequirement(module.members.find(node => node.kind === 'FunctionDecl' && node.symbol === fenced)!), ...(options.fenceWrapper ? [fenceRequirement(module.members.find(node => node.kind === 'FunctionDecl' && node.symbol === wrapper)!)] : [])], author: 'author', policyEpoch: '1', nonce: randomUUID() }, author.privateKey)) };
  let sequence = 0;
  const artifact = (term: Term, parents: string[], sign = true) => {
    const root = store.intern(term, { leaseId: `draft-${sequence++}` }), d = (value: string) => domainDigest('aether.semantic-gc-test/1', value);
    const context: EvidenceContext = { module: term, specification: lineage.specification(parents, [spec]), registry, semanticsVersion: 'aether-reference/1', compilerDigest: d('compiler'), target: { abiVersion: 'ast-source/1', profileDigest: d('unchanged-runtime-profile'), artifactDigest: d(root) }, capabilityPolicyDigest: d('unchanged-effect-policy') };
    const evidence = mintLocalEvidence(context), manifest = executionManifestDigest(evidence.manifest);
    let intent: string | null = null;
    if (sign) { intent = lineage.recordIntent(signIntent({ repositoryId: 'semantic-gc', subject: root, executionManifest: manifest, evidenceBundleDigest: evidenceBundleDigest(evidence), parents, specifications: [spec], purpose: parents.length ? 'rewrite' : 'genesis', text: 'Authorize exact artifact with preserved contracts and effects.', author: 'author', policyEpoch: '1', nonce: randomUUID() }, author.privateKey)); lineage.admitArtifact(intent, evidence, context); }
    return { root, context, evidence, manifest, intent };
  };
  const genesis = artifact(module, []); store.commit('production', genesis.root, null);
  const gcOptions: SemanticGcOptions = { profile: options.fuelBranchProfile ? SEMANTIC_GC_FUEL_PROFILE : options.callShimProfile ? SEMANTIC_GC_CALL_SHIM_PROFILE : options.shimProfile ? SEMANTIC_GC_SHIM_PROFILE : options.branchProfile ? SEMANTIC_GC_BRANCH_PROFILE : SEMANTIC_GC_PROFILE, directory: join(directory, 'gc'), repositoryId: 'semantic-gc', store, lineage, registry, policy: { epoch: 'closed-exports/1', exports: [entry, sink, ...(options.exportWrapper ? [wrapper] : [])], protectedSymbols: [...(options.protectTarget ? [target] : []), ...(options.protectWrapper ? [wrapper] : [])] } };
  const gc = new SemanticGarbageCollector(gcOptions);
  const coordinatorOptions: PromotionCoordinatorOptions = { directory: join(directory, 'governor'), repositoryId: 'semantic-gc', genesisManifest: genesis.manifest, lineage: lineage.admissionAdapter(), authority: () => ({ repositoryId: 'semantic-gc', membershipEpoch: '1', policyEpoch: '1', eligibleGovernors: ['governor'] }), governorKey: () => governor.publicKey, clock: () => 100n };
  const coordinator = new PromotionCoordinator(coordinatorOptions);
  const input = (value: ReturnType<typeof artifact>): PromotionInput => {
    const migrationPlan = { tag: 'string' as const, value: 'scalar exports and unchanged heap schema' }, effectPlan = { tag: 'string' as const, value: 'unchanged effect policy and effectful bodies' };
    const proposal = { format: 'aether.promotion/1' as const, repositoryId: 'semantic-gc', expectedParent: coordinator.state().committedManifest, candidateManifest: value.manifest, evidenceBundleDigest: evidenceBundleDigest(value.evidence), migrationPlanDigest: migrationPlanDigest(migrationPlan), effectPlanDigest: effectPlanDigest(effectPlan), membershipEpoch: '1', policyEpoch: '1', expiresAt: String(10000 + sequence++) };
    return { proposal, approval: approvePromotion(proposal, 'governor', governor.privateKey), context: value.context, evidence: value.evidence, migrationPlan, effectPlan };
  };
  const driver = (proposal: SemanticGcProposal, duringPrepare?: () => void): PromotionDriver => ({
    async prepare(binding) { const head = store.head('production')!; assert.equal(head.root, proposal.sourceRoot); store.stagePromotion(binding.proposalDigest, { from: proposal.sourceRoot, to: proposal.targetRoot }); duringPrepare?.(); return createPromotionHandle(binding, { tag: 'int', value: String(head.generation) }); },
    async activate(binding, handle) { assert.equal(handle.payload.tag, 'int'); if (handle.payload.tag !== 'int') throw new Error('driver generation absent'); store.finishPromotion(binding.proposalDigest, { kind: 'commit', name: 'production', expected: { root: proposal.sourceRoot, generation: Number(handle.payload.value) } }); },
    async abort(binding) { if (store.roots().promotions[binding.proposalDigest]) store.finishPromotion(binding.proposalDigest, { kind: 'abort' }); },
    async recover(binding, handle, decision) { if (decision === 'commit') { if (!handle) throw new Error('committed preparation handle missing'); await this.activate(binding, handle); } else await this.abort(binding, handle); },
  });
  const execute = (root: NodeRef) => { const effects: unknown[][] = []; const runtime = ProductionRuntime.compile(store.hydrate(root), { registry, effects: new Map([[log, args => { effects.push([...args]); return null; }]]) }); const values = (options.booleanWrapper ? [false, true] : [-100n, -1n, 0n, 1n, 50000000000000000000000000000000000n]).map(value => runtime.call(entry, [value])); const appended = runtime.call(sink, ['preserved effect']); return { values, appended, effects }; };
  return { directory, store, symbols, module, target, wrapper, entry, sink, dead, fenced, log, registry, author, authority, lineage, genesis, artifact, gc, gcOptions, coordinator, coordinatorOptions, input, driver, execute, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

test('semantic GC proposes real dead declaration removal and pure wrapper collapse with portable equivalence and unchanged exports/effects/contracts', () => {
  const f = fixture();
  try {
    const head = f.store.head('production'), proposal = f.gc.propose(f.genesis.evidence.manifest); assert.ok(proposal);
    assert.ok(proposal.removed.includes(f.dead)); assert.ok(proposal.removed.includes(f.wrapper)); assert.equal(proposal.collapsed.length, 1); assert.equal(proposal.witnesses.length, 1);
    assert.equal(proposal.witnesses[0].certificate.format, 'aether.portable-ast-proof/1');
    const before = f.module.members.filter(node => node.kind === 'FunctionDecl'), candidate = f.store.hydrate(proposal.targetRoot); assert.equal(candidate.kind, 'Module');
    if (candidate.kind !== 'Module') throw new Error('candidate module missing');
    assert.ok(candidate.members.length < before.length);
    const protectedBefore = before.find(node => node.kind === 'FunctionDecl' && node.symbol === f.fenced)!, protectedAfter = candidate.members.find(node => node.kind === 'FunctionDecl' && node.symbol === f.fenced)!;
    assert.equal(new GraphStore().intern(protectedBefore), new GraphStore().intern(protectedAfter));
    assert.deepEqual(f.execute(proposal.targetRoot), f.execute(proposal.sourceRoot)); assert.deepEqual(f.store.head('production'), head);
    assert.equal(f.gc.propose(f.genesis.evidence.manifest)!.id, proposal.id);
    assert.equal(new SemanticGarbageCollector(f.gcOptions).readProposal(proposal.id).targetRoot, proposal.targetRoot);
  } finally { f.cleanup(); }
});

test('semantic GC requires signed exact lineage and governor promotion; rollback is a newly authorized reverse operation', async () => {
  const f = fixture({ protectWrapper: true });
  try {
    const proposal = f.gc.propose(f.genesis.evidence.manifest)!;
    const unsigned = f.artifact(f.store.hydrate(proposal.targetRoot), [f.genesis.intent!], false);
    await assert.rejects(f.gc.promote(proposal.id, f.input(unsigned), f.coordinator, f.driver(proposal)), /signed intent|admitted evidence|lineage/);
    assert.equal(f.store.head('production')!.root, proposal.sourceRoot);
    const candidate = f.artifact(f.store.hydrate(proposal.targetRoot), [f.genesis.intent!]);
    await f.gc.promote(proposal.id, f.input(candidate), f.coordinator, f.driver(proposal));
    assert.equal(f.coordinator.servingManifest(), candidate.manifest); assert.equal(f.store.head('production')!.root, proposal.targetRoot);
    assert.deepEqual(f.execute(proposal.targetRoot), f.execute(proposal.sourceRoot)); assert.equal(f.gc.propose(candidate.evidence.manifest), null);
    const rollback = f.gc.proposeRollback(proposal.id, candidate.evidence.manifest);
    await assert.rejects(f.gc.promote(rollback.id, f.input(f.genesis), f.coordinator, f.driver(rollback)), /causal links/);
    const restored = f.artifact(f.module, [candidate.intent!]);
    await f.gc.promote(rollback.id, f.input(restored), f.coordinator, f.driver(rollback));
    assert.equal(f.store.head('production')!.root, proposal.sourceRoot); assert.equal(f.store.head('production')!.generation, 3);
    assert.deepEqual(f.execute(f.store.head('production')!.root), f.execute(f.genesis.root));
  } finally { f.cleanup(); }
});

test('semantic GC retains audit/replay/active-task/unstable-replication roots while sweeping actual unprotected garbage', () => {
  const f = fixture();
  try {
    const proposal = f.gc.propose(f.genesis.evidence.manifest)!;
    const retained = (['audit', 'replay', 'active-task', 'unstable-replication'] as SemanticRetentionKind[]).map((kind, index) => { const root = f.store.intern(b.str(`protected-${kind}`), { leaseId: `initial-${index}` }); f.gc.retain({ kind, root, reference: `${kind}-owner` }); f.store.release(`initial-${index}`); return root; });
    const orphan = f.store.intern(b.str('unprotected garbage'), { leaseId: 'orphan' }); f.store.release('orphan');
    const collector = new SemanticGarbageCollector(f.gcOptions), result = collector.collect(); assert.ok(result.removedObjects >= 1);
    assert.throws(() => f.store.get(orphan), /ENOENT/);
    for (const root of [...retained, proposal.sourceRoot, proposal.targetRoot, ...proposal.witnesses.map(witness => witness.root)]) assert.ok(f.store.get(root));
    assert.equal(collector.retentions().length, 4); assert.equal(collector.readProposal(proposal.id).id, proposal.id);
  } finally { f.cleanup(); }
});

test('semantic GC refuses relabeled unsafe rewrites and incomplete portable certificates', () => {
  const f = fixture();
  try {
    const proposal = f.gc.propose(f.genesis.evidence.manifest)!;
    const badRoot = f.store.intern({ ...f.module, members: f.module.members.map(node => node.kind === 'FunctionDecl' && node.symbol === f.entry ? { ...node, body: b.ret(b.int(0)) } : node) }, { leaseId: 'unsafe-candidate' });
    const forge = (changes: Partial<SemanticGcProposal>) => { const { id: _id, ...body } = { ...proposal, ...changes }; const changed = { ...body, id: domainDigest('aether.semantic-gc-proposal/1', body) }; writeFileSync(join(f.directory, 'gc/proposals', `${changed.id.split(':').at(-1)}.json`), encodeCanonical(changed)); return changed; };
    assert.throws(() => f.gc.readProposal(forge({ targetRoot: badRoot }).id), /unsafe candidate rewrite/);
    assert.throws(() => f.gc.readProposal(forge({ witnesses: [] }).id), /incomplete/);
    const witnesses = proposal.witnesses.map(witness => ({ ...witness, certificate: { ...witness.certificate, certificates: [] } }));
    assert.throws(() => f.gc.readProposal(forge({ witnesses }).id), /coverage/);
    assert.equal(f.store.head('production')!.root, f.genesis.root);
  } finally { f.cleanup(); }
});

test('semantic GC retains signed formal fence symbols/nonempty contracts and accepts only valid fence schemas', () => {
  const f = fixture({ fenceWrapper: true });
  try {
    const proposal = f.gc.propose(f.genesis.evidence.manifest)!;
    const emptyFrame = b.fn({ symbol: f.dead, returns: b.Int, body: b.ret(b.int(0)), contract: b.contract({}) });
    assert.throws(() => fenceRequirement(emptyFrame), /formal fence requires a postcondition/);
    assert.ok(proposal.removed.includes(f.dead)); assert.ok(!proposal.removed.includes(f.wrapper)); assert.ok(!proposal.removed.includes(f.fenced));
    assert.equal(proposal.collapsed.length, 0); assert.equal(proposal.productionAuthorized, false);
    const candidate = f.store.hydrate(proposal.targetRoot); if (candidate.kind !== 'Module') throw new Error('missing candidate');
    for (const symbol of [f.wrapper, f.fenced]) assert.equal(new GraphStore().intern(candidate.members.find(node => node.kind === 'FunctionDecl' && node.symbol === symbol)!), new GraphStore().intern(f.module.members.find(node => node.kind === 'FunctionDecl' && node.symbol === symbol)!));
    const forbidden = { ...candidate, members: candidate.members.filter(node => node.kind !== 'FunctionDecl' || node.symbol !== f.wrapper).map(node => node.kind === 'FunctionDecl' && node.symbol === f.entry ? { ...node, body: b.ret(b.add(b.call(f.target, b.v(node.params[0].symbol)), b.int(10))) } : node) };
    // Removing the required symbol is independently rejected by signed lineage,
    // even if a caller bypasses the GC proposal constructor entirely.
    assert.throws(() => f.artifact(forbidden, [f.genesis.intent!]), /fenced function cannot be pruned/);
    assert.deepEqual(f.execute(proposal.targetRoot), f.execute(f.genesis.root));
  } finally { f.cleanup(); }
});

test('semantic GC derives portable Boolean equivalence instead of relying only on integer test examples', () => {
  const f = fixture({ booleanWrapper: true });
  try {
    const proposal = f.gc.propose(f.genesis.evidence.manifest)!; assert.equal(proposal.witnesses.length, 1);
    assert.deepEqual(f.execute(proposal.targetRoot), f.execute(f.genesis.root));
  } finally { f.cleanup(); }
});

test('semantic GC refuses unsupported nonlinear equivalence without changing the production head', () => {
  const f = fixture({ nonlinear: true });
  try {
    const head = f.store.head('production');
    assert.throws(() => f.gc.propose(f.genesis.evidence.manifest), /unsupported|unproved/);
    assert.deepEqual(f.store.head('production'), head);
  } finally { f.cleanup(); }
});

test('semantic GC revocation during prepared promotion aborts the staged target; no commit is guessed', async () => {
  const f = fixture({ protectWrapper: true });
  try {
    const proposal = f.gc.propose(f.genesis.evidence.manifest)!, candidate = f.artifact(f.store.hydrate(proposal.targetRoot), [f.genesis.intent!]);
    await assert.rejects(f.gc.promote(proposal.id, f.input(candidate), f.coordinator, f.driver(proposal, () => { f.authority.eligibleAuthors = []; })), /revoked|lineage|authorization|author/i);
    assert.equal(f.store.head('production')!.root, f.genesis.root); assert.equal(Object.keys(f.store.roots().promotions).length, 0);
    assert.equal(f.coordinator.state().committedManifest, f.genesis.manifest);
    assert.ok(f.store.get(proposal.targetRoot));
  } finally { f.cleanup(); }
});

test('semantic GC activation recovery follows the committed governor decision and remains idempotent', async () => {
  const f = fixture();
  try {
    const proposal = f.gc.propose(f.genesis.evidence.manifest)!, candidate = f.artifact(f.store.hydrate(proposal.targetRoot), [f.genesis.intent!]);
    const interrupted = new PromotionCoordinator({ ...f.coordinatorOptions, fault(point) { if (point === 'after-commit') throw new Error('simulated activation interruption'); } });
    // Model a decision committed by the historical profile before the new
    // quota gate existed. Recovery must still be able to finish that decision.
    await assert.rejects(interrupted.promote(f.input(candidate), f.driver(proposal)), /activation interruption/);
    assert.equal(interrupted.state().committedManifest, candidate.manifest); assert.equal(interrupted.state().activationPending, true); assert.equal(f.store.head('production')!.root, proposal.sourceRoot);
    const reopened = new PromotionCoordinator(f.coordinatorOptions), collector = new SemanticGarbageCollector(f.gcOptions);
    f.authority.eligibleAuthors = [];
    await assert.rejects(reopened.recover(collector.guardedDriver(proposal.id, f.driver(proposal))), /lineage|serving|author|revoked/i);
    assert.equal(reopened.state().activationPending, false);
    f.authority.eligibleAuthors = ['author'];
    await reopened.recover(collector.guardedDriver(proposal.id, f.driver(proposal))); const head = f.store.head('production');
    assert.equal(head!.root, proposal.targetRoot); assert.equal(reopened.servingManifest(), candidate.manifest);
    await reopened.recover(collector.guardedDriver(proposal.id, f.driver(proposal))); assert.deepEqual(f.store.head('production'), head);
  } finally { f.cleanup(); }
});

test('semantic GC explicit background scheduling emits a durable candidate and stops without production publication', async () => {
  const f = fixture();
  try {
    const proposal = await new Promise<SemanticGcProposal>((resolve, reject) => {
      const timeout = setTimeout(() => { stop(); reject(new Error('background scan timeout')); }, 15000);
      const stop = f.gc.start({ intervalMs: 10, source: () => f.genesis.evidence.manifest, candidate(value) { stop(); clearTimeout(timeout); resolve(value); }, error(error) { stop(); clearTimeout(timeout); reject(error); } });
    });
    assert.equal(f.gc.readProposal(proposal.id).id, proposal.id); assert.equal(f.store.head('production')!.root, f.genesis.root);
  } finally { f.cleanup(); }
});

function changeFunction(module: Module, symbol: SymbolId, update: (decl: Extract<Term, { kind: 'FunctionDecl' }>) => Term): Module {
  return { ...module, members: module.members.map(member => member.kind === 'FunctionDecl' && member.symbol === symbol ? update(member) : member) };
}
function terms(root: Term): Term[] {
  const output: Term[] = [], pending = [root];
  while (pending.length) { const term = pending.pop()!; output.push(term); for (const group of linkGroups(term)) pending.push(...group.links); }
  return output;
}
const branchFixture = (enabled = true, fuel = false) => fixture({ branchProfile: enabled, fuelBranchProfile: fuel, transform(module, names) {
  let result = changeFunction(module, names.entry, decl => ({ ...decl, body: b.if_(b.eq(b.sub(b.v(names.n), b.v(names.n)), b.int(0)), b.block(b.ret(b.add(b.call(names.wrapper, b.v(names.n)), b.int(10)))), b.block(b.ret(b.int(-999)))) }));
  result = changeFunction(result, names.sink, decl => ({ ...decl, body: b.block(b.if_(b.bool(false), b.block(b.exprStmt(b.call(names.dead))), b.block(b.exprStmt(b.invoke(names.log, b.v(names.message))))), b.ret(b.unit())) }));
  return result;
} });

test('branch profile prunes symbolic/literal unreachable arms, preserves selected scopes/effects and removes newly unreachable declarations from the candidate', () => {
  const f = branchFixture();
  try {
    const before = f.store.head('production'), proposal = f.gc.propose(f.genesis.evidence.manifest)!;
    assert.equal(proposal.profile, SEMANTIC_GC_BRANCH_PROFILE); assert.equal(proposal.branches!.length, 2);
    assert.deepEqual(proposal.branches!.map(witness => witness.selection.value), [true, false]);
    assert.ok(proposal.removed.includes(f.dead)); assert.ok(proposal.removed.includes(f.wrapper));
    const candidate = f.store.hydrate(proposal.targetRoot); assert.ok(!terms(candidate).some(term => term.kind === 'If'));
    assert.deepEqual(f.execute(candidate.kind === 'Module' ? proposal.targetRoot : proposal.sourceRoot), f.execute(proposal.sourceRoot));
    assert.deepEqual(f.store.head('production'), before); assert.equal(proposal.productionAuthorized, false);
    for (const witness of proposal.branches!) assert.equal(witness.certificate.format, 'aether.portable-ast-proof/1');
    assert.equal(new SemanticGarbageCollector(f.gcOptions).readProposal(proposal.id).id, proposal.id);
    assert.equal(f.gc.propose(f.genesis.evidence.manifest)!.id, proposal.id);
  } finally { f.cleanup(); }
});

test('legacy forwarder profile keeps branch syntax and cannot reopen a new branch-profile journal', () => {
  const f = branchFixture(false);
  try {
    const proposal = f.gc.propose(f.genesis.evidence.manifest)!;
    assert.equal(proposal.profile, SEMANTIC_GC_PROFILE); assert.equal(proposal.branches, undefined);
    assert.ok(terms(f.store.hydrate(proposal.targetRoot)).some(term => term.kind === 'If'));
    assert.ok(!proposal.removed.includes(f.dead), 'syntactic call in the unpruned branch keeps the declaration live');
    assert.throws(() => new SemanticGarbageCollector({ ...f.gcOptions, profile: SEMANTIC_GC_BRANCH_PROFILE }), /configuration changed/);
  } finally { f.cleanup(); }
});

test('legacy forwarder and flattened-branch proposals remain readable but cannot start new promotions', async () => {
  const factories = [
    () => fixture(),
    () => fixture({ branchProfile: true, protectWrapper: true, transform(module, names) {
      return changeFunction(module, names.entry, decl => ({ ...decl,
        body: b.if_(b.eq(b.sub(b.v(names.n), b.v(names.n)), b.int(0)),
          b.ret(b.add(b.v(names.n), b.int(11))), b.ret(b.int(-1))) }));
    } }),
  ];
  for (const make of factories) {
    const f = make();
    try {
      const proposal = f.gc.propose(f.genesis.evidence.manifest)!;
      assert.ok(proposal.collapsed.length || proposal.branches?.length);
      const candidate = f.artifact(f.store.hydrate(proposal.targetRoot), [f.genesis.intent!]);
      const state = f.coordinator.state(), head = f.store.head('production');
      await assert.rejects(f.gc.promote(proposal.id, f.input(candidate), f.coordinator, f.driver(proposal)), /step-quota behavior/);
      assert.deepEqual(f.coordinator.state(), state);
      assert.deepEqual(f.store.head('production'), head);
      assert.equal(new SemanticGarbageCollector(f.gcOptions).readProposal(proposal.id).id, proposal.id);
    } finally { f.cleanup(); }
  }
});

test('historical branch flattening changes a finite-step sink outcome and is barred from new promotion', async () => {
  const f = branchFixture(true, false);
  try {
    const proposal = f.gc.propose(f.genesis.evidence.manifest)!;
    const run = (root: NodeRef, maxSteps: number) => {
      const effects: unknown[][] = [];
      const runtime = new Runtime({ registry: f.registry, maxSteps,
        effects: new Map([[f.log, args => { effects.push([...args]); return null; }]]) });
      runtime.load(f.store.hydrate(root));
      return { result: runtime.call(f.sink, ['chosen-effect']), effects };
    };
    const changed = Array.from({ length: 24 }, (_, index) => index + 1)
      .find(limit => run(proposal.sourceRoot, limit).effects.length
        !== run(proposal.targetRoot, limit).effects.length);
    assert.ok(changed, 'historical flattening must exhibit the finite-step semantic gap');
    const candidate = f.artifact(f.store.hydrate(proposal.targetRoot), [f.genesis.intent!]);
    await assert.rejects(f.gc.promote(proposal.id, f.input(candidate), f.coordinator,
      f.driver(proposal)), /step-quota behavior/);
  } finally { f.cleanup(); }
});

test('fuel-preserving branch profile removes cold If calls but keeps exact reference-runtime effects and quota faults', () => {
  const f = branchFixture(true, true);
  try {
    const proposal = f.gc.propose(f.genesis.evidence.manifest)!;
    assert.equal(proposal.profile, SEMANTIC_GC_FUEL_PROFILE);
    assert.equal(proposal.branches!.length, 2);
    assert.deepEqual(proposal.collapsed, []);
    assert.ok(proposal.removed.includes(f.dead));
    assert.ok(!proposal.removed.includes(f.wrapper));
    const candidate = f.store.hydrate(proposal.targetRoot);
    assert.equal(terms(candidate).filter(term => term.kind === 'If').length, 2);
    const run = (root: NodeRef, maxSteps: number) => {
      const effects: unknown[][] = [];
      const runtime = new Runtime({ registry: f.registry, maxSteps, trace: true,
        effects: new Map([[f.log, args => { effects.push([...args]); return null; }]]) });
      runtime.load(f.store.hydrate(root));
      const result = runtime.call(f.sink, ['chosen-effect']);
      return { result, effects, trace: runtime.trace, effectLog: runtime.effects };
    };
    for (let maxSteps = 1; maxSteps <= 24; maxSteps++)
      assert.deepEqual(run(proposal.targetRoot, maxSteps), run(proposal.sourceRoot, maxSteps), `maxSteps=${maxSteps}`);
    assert.equal(new SemanticGarbageCollector(f.gcOptions).readProposal(proposal.id).id, proposal.id);
    assert.throws(() => new SemanticGarbageCollector({ ...f.gcOptions, profile: SEMANTIC_GC_BRANCH_PROFILE }), /configuration changed/);
  } finally { f.cleanup(); }
});

test('fuel-preserving Cond profile removes the cold effect expression without moving its guard or chosen arm', () => {
  const f = fixture({ fuelBranchProfile: true, transform(module, names) {
    return changeFunction(module, names.sink, decl => ({ ...decl, body: b.block(
      b.exprStmt(b.cond(b.bool(true), b.invoke(names.log, b.str('chosen')), b.invoke(names.log, b.str('cold')))),
      b.ret(b.unit()),
    ) }));
  } });
  try {
    const proposal = f.gc.propose(f.genesis.evidence.manifest)!;
    assert.equal(proposal.branches!.length, 1);
    assert.equal(proposal.branches![0].selection.kind, 'Cond');
    const candidate = f.store.hydrate(proposal.targetRoot);
    assert.equal(terms(candidate).filter(term => term.kind === 'Cond').length, 1);
    assert.ok(!terms(candidate).some(term => term.kind === 'Lit' && term.value === 'cold'));
    const run = (root: NodeRef, maxSteps: number) => {
      const effects: unknown[][] = [];
      const runtime = new Runtime({ registry: f.registry, maxSteps, trace: true,
        effects: new Map([[f.log, args => { effects.push([...args]); return null; }]]) });
      runtime.load(f.store.hydrate(root));
      return { result: runtime.call(f.sink, ['ignored']), effects, trace: runtime.trace, effectLog: runtime.effects };
    };
    for (let maxSteps = 1; maxSteps <= 18; maxSteps++)
      assert.deepEqual(run(proposal.targetRoot, maxSteps), run(proposal.sourceRoot, maxSteps), `maxSteps=${maxSteps}`);
  } finally { f.cleanup(); }
});

test('branch profile handles Cond expressions and definitely initialized local bindings without flattening blocks', () => {
  const f = fixture({ branchProfile: true, transform(module, names, symbols) {
    const local = symbols.define('definite');
    return changeFunction(module, names.entry, decl => ({ ...decl, body: b.block(
      b.if_(b.ge(b.v(names.n), b.int(0)), b.let_(local, b.Int, b.int(1)), b.let_(local, b.Int, b.int(2))),
      b.ret(b.cond(b.eq(b.sub(b.v(local), b.v(local)), b.int(0)), b.add(b.v(names.n), b.int(11)), b.int(-999))),
    ) }));
  } });
  try {
    const proposal = f.gc.propose(f.genesis.evidence.manifest)!;
    assert.equal(proposal.branches!.length, 1); assert.equal(proposal.branches![0].selection.kind, 'Cond');
    const candidate = f.store.hydrate(proposal.targetRoot);
    assert.ok(terms(candidate).some(term => term.kind === 'If')); assert.ok(!terms(candidate).some(term => term.kind === 'Cond'));
    assert.deepEqual(f.execute(proposal.targetRoot), f.execute(proposal.sourceRoot));
  } finally { f.cleanup(); }
});

test('branch pruning does not erase a condition call or its effects even when the callee always returns true', () => {
  const f = fixture({ branchProfile: true, transform(module, names, symbols) {
    const condition = symbols.define('effectfulCondition');
    const source = { ...module, members: [...module.members, b.fn({ symbol: condition, returns: b.Bool, purity: 'effectful', capabilities: [names.log], contract: b.contract({}), body: b.block(b.exprStmt(b.invoke(names.log, b.str('condition'))), b.ret(b.bool(true))) })] };
    return changeFunction(source, names.entry, decl => ({ ...decl, purity: 'effectful', capabilities: [names.log], body: b.if_(b.call(condition), b.ret(b.add(b.call(names.wrapper, b.v(names.n)), b.int(10))), b.ret(b.int(-1))) }));
  } });
  try {
    const proposal = f.gc.propose(f.genesis.evidence.manifest)!;
    assert.equal(proposal.branches!.length, 0); assert.ok(terms(f.store.hydrate(proposal.targetRoot)).some(term => term.kind === 'If'));
    const before = f.execute(proposal.sourceRoot), after = f.execute(proposal.targetRoot); assert.deepEqual(after, before);
    assert.equal(after.effects.filter(args => args[0] === 'condition').length, 5);
  } finally { f.cleanup(); }
});

test('branch pruning does not treat an entry precondition or an earlier assigned value as a permanent branch fact', () => {
  const f = fixture({ branchProfile: true, transform(module, names, symbols) {
    const local = symbols.define('mutableLocal');
    return changeFunction(module, names.entry, decl => ({ ...decl, contract: b.contract({ requires: [b.clause(b.ge(b.v(names.n), b.int(0)), 'nonnegative-entry')] }), body: b.block(b.let_(local, b.Int, b.v(names.n)), b.assign(b.place(local), b.int(-1)), b.if_(b.ge(b.v(local), b.int(0)), b.ret(b.int(111)), b.ret(b.int(222)))) }));
  } });
  try {
    const proposal = f.gc.propose(f.genesis.evidence.manifest)!;
    assert.equal(proposal.branches!.length, 0); assert.deepEqual(f.execute(proposal.targetRoot), f.execute(proposal.sourceRoot));
    assert.ok(terms(f.store.hydrate(proposal.targetRoot)).some(term => term.kind === 'If'));
  } finally { f.cleanup(); }
});

test('dead-branch cleanup and inverse rollback require fresh signed F08 authority and retain condition certificates through GC', async () => {
  const f = branchFixture(true, true);
  try {
    const proposal = f.gc.propose(f.genesis.evidence.manifest)!, candidate = f.artifact(f.store.hydrate(proposal.targetRoot), [f.genesis.intent!]);
    await f.gc.promote(proposal.id, f.input(candidate), f.coordinator, f.driver(proposal));
    const rollback = f.gc.proposeRollback(proposal.id, candidate.evidence.manifest);
    assert.equal(rollback.branches!.length, proposal.branches!.length);
    assert.notEqual(rollback.branches![0].manifest.specRoot, proposal.branches![0].manifest.specRoot);
    const restored = f.artifact(f.module, [candidate.intent!]);
    await f.gc.promote(rollback.id, f.input(restored), f.coordinator, f.driver(rollback));
    assert.equal(f.store.head('production')!.root, proposal.sourceRoot); assert.deepEqual(f.execute(proposal.sourceRoot), f.execute(proposal.targetRoot));
    f.gc.collect(); for (const witness of [...proposal.branches!, ...rollback.branches!]) assert.ok(f.store.get(witness.root));
    assert.equal(new SemanticGarbageCollector(f.gcOptions).readProposal(rollback.id).id, rollback.id);
  } finally { f.cleanup(); }
});

test('branch proofs preserve contract and loop annotation identities while pruning a stable condition inside a loop', () => {
  const f = fixture({ branchProfile: true, transform(module, names, symbols) {
    const counter = symbols.define('loopCounter');
    let source = changeFunction(module, names.entry, decl => ({ ...decl, purity: 'effectful', capabilities: [names.log], body: b.block(
      b.let_(counter, b.Int, b.int(0)),
      b.while_(b.lt(b.v(counter), b.int(2)), b.block(
        b.if_(b.eq(b.v(names.n), b.v(names.n)), b.exprStmt(b.invoke(names.log, b.str('loop-live'))), b.exprStmt(b.invoke(names.log, b.str('loop-dead')))),
        b.if_(b.lt(b.v(counter), b.int(0)), b.exprStmt(b.invoke(names.log, b.str('negative-counter')))),
        b.assign(b.place(counter), b.add(b.v(counter), b.int(1))),
      ), { invariants: [b.cond(b.bool(true), b.and(b.ge(b.v(counter), b.int(0)), b.le(b.v(counter), b.int(2))), b.bool(false))], variant: b.sub(b.int(2), b.v(counter)) }),
      b.ret(b.add(b.v(names.n), b.int(11))),
    ) }));
    source = changeFunction(source, names.fenced, decl => ({ ...decl, contract: b.contract({ ensures: [b.clause(b.cond(b.bool(true), b.eq(b.result(), b.int(7)), b.bool(false)), 'conditional-contract')] }) }));
    return source;
  } });
  try {
    const proposal = f.gc.propose(f.genesis.evidence.manifest)!; assert.equal(proposal.branches!.length, 1);
    const before = terms(f.module).find(term => term.kind === 'While')!, after = terms(f.store.hydrate(proposal.targetRoot)).find(term => term.kind === 'While')!;
    if (before.kind !== 'While' || after.kind !== 'While') throw new Error('loop missing');
    assert.deepEqual(after.invariants, before.invariants); assert.deepEqual(after.variant, before.variant);
    assert.equal(terms(after.body).filter(term => term.kind === 'If').length, 1, 'loop-written bindings are not assumed stable');
    const oldContract = f.module.members.find(node => node.kind === 'FunctionDecl' && node.symbol === f.fenced)!;
    const candidate = f.store.hydrate(proposal.targetRoot); if (candidate.kind !== 'Module') throw new Error('module missing');
    assert.equal(new GraphStore().intern(candidate.members.find(node => node.kind === 'FunctionDecl' && node.symbol === f.fenced)!), new GraphStore().intern(oldContract));
    const result = f.execute(proposal.targetRoot); assert.deepEqual(result, f.execute(proposal.sourceRoot));
    assert.equal(result.effects.filter(args => args[0] === 'loop-live').length, 10);
    assert.ok(result.effects.every(args => args[0] !== 'loop-dead' && args[0] !== 'negative-counter'));
  } finally { f.cleanup(); }
});

test('portable branch proof does not claim a partial division condition is universally total from an entry precondition', () => {
  const f = fixture({ branchProfile: true, transform(module, names) {
    return changeFunction(module, names.entry, decl => ({ ...decl, contract: b.contract({ requires: [b.clause(b.ne(b.v(names.n), b.int(0)), 'nonzero-entry')] }), body: b.if_(b.eq(b.div(b.v(names.n), b.v(names.n)), b.int(1)), b.ret(b.add(b.v(names.n), b.int(11))), b.ret(b.int(0))) }));
  } });
  try {
    const proposal = f.gc.propose(f.genesis.evidence.manifest)!;
    assert.equal(proposal.branches!.length, 0); assert.ok(terms(f.store.hydrate(proposal.targetRoot)).some(term => term.kind === 'If'));
    assert.deepEqual(f.execute(proposal.targetRoot), f.execute(proposal.sourceRoot));
  } finally { f.cleanup(); }
});

test('branch admission rejects missing/swapped certificates, invalid source sites, wrong-arm code and relabeled condition claims', () => {
  const f = branchFixture();
  try {
    const proposal = f.gc.propose(f.genesis.evidence.manifest)!;
    const forge = (changes: Partial<SemanticGcProposal>) => { const { id: _id, ...body } = { ...proposal, ...changes }; const changed = { ...body, id: domainDigest('aether.semantic-gc-proposal/1', body) }; writeFileSync(join(f.directory, 'gc/proposals', `${changed.id.split(':').at(-1)}.json`), encodeCanonical(changed)); return changed.id; };
    assert.throws(() => f.gc.readProposal(forge({ branches: [] })), /unsafe candidate|incomplete/);
    assert.throws(() => f.gc.readProposal(forge({ branches: [...proposal.branches!].reverse() })), /reordered/);
    const incomplete = proposal.branches!.map(witness => ({ ...witness, certificate: { ...witness.certificate, certificates: [] } }));
    assert.throws(() => f.gc.readProposal(forge({ branches: incomplete })), /coverage/);
    const swapped = proposal.branches!.map((witness, index) => ({ ...witness, certificate: proposal.branches![1 - index].certificate }));
    assert.throws(() => f.gc.readProposal(forge({ branches: swapped })), /execution context/);
    const wrongSite = proposal.branches!.map((witness, index) => index ? witness : { ...witness, selection: { ...witness.selection, path: [{ field: 'stmts', index: 999 }] } });
    assert.throws(() => f.gc.readProposal(forge({ branches: wrongSite })), /missing|unreachable/);
    const wrongChoice = proposal.branches!.map((witness, index) => index ? witness : { ...witness, selection: { ...witness.selection, value: false } });
    assert.throws(() => f.gc.readProposal(forge({ branches: wrongChoice })), /unsafe candidate|incomplete/);
    const candidate = f.store.hydrate(proposal.targetRoot); if (candidate.kind !== 'Module') throw new Error('module missing');
    const wrongRoot = f.store.intern(changeFunction(candidate, f.entry, decl => ({ ...decl, body: b.ret(b.int(-999)) })), { leaseId: 'wrong-arm-draft' });
    assert.throws(() => f.gc.readProposal(forge({ targetRoot: wrongRoot })), /unsafe candidate/);
    assert.equal(f.store.head('production')!.root, proposal.sourceRoot);
  } finally { f.cleanup(); }
});

test('branch analysis does not assume a local declared in only one syntactic arm is definitely bound', () => {
  const f = fixture({ branchProfile: true, transform(module, names, symbols) {
    const local = symbols.define('oneArmLocal');
    return changeFunction(module, names.entry, decl => ({ ...decl, body: b.block(
      b.if_(b.ge(b.v(names.n), b.int(0)), b.let_(local, b.Int, b.int(1)), b.ret(b.int(-1))),
      b.if_(b.eq(b.v(local), b.v(local)), b.ret(b.add(b.v(names.n), b.int(11))), b.ret(b.int(-999))),
    ) }));
  } });
  try {
    const proposal = f.gc.propose(f.genesis.evidence.manifest)!;
    assert.equal(proposal.branches!.length, 0, 'the bounded join deliberately does not use return-path reasoning');
    assert.deepEqual(f.execute(proposal.targetRoot), f.execute(proposal.sourceRoot));
  } finally { f.cleanup(); }
});

test('persisted branch witnesses are checked with the portable proof producer replaced by a throwing stub', async () => {
  const f = branchFixture(), consumer = mkdtempSync(join(tmpdir(), 'aether-gc-branch-consumer-'));
  try {
    const proposal = f.gc.propose(f.genesis.evidence.manifest)!;
    cpSync(resolve('src'), join(consumer, 'src'), { recursive: true });
    writeFileSync(join(consumer, 'package.json'), '{"type":"module"}\n');
    writeFileSync(join(consumer, 'src/tier2/portable-proof-producer.ts'), "export function generatePortableCertificate() { throw new Error('proof search forbidden in consumer'); }\n");
    const { SemanticGarbageCollector: IndependentConsumer } = await import(pathToFileURL(join(consumer, 'src/tier1/semantic-gc.ts')).href);
    const reader = new IndependentConsumer(f.gcOptions);
    assert.equal(reader.readProposal(proposal.id).id, proposal.id);
  } finally { f.cleanup(); rmSync(consumer, { recursive: true, force: true }); }
});

const scalarShimFixture = (extra: Parameters<typeof fixture>[0] = {}) => fixture({ ...extra, shimProfile: true, protectTarget: true, transform(module, names, symbols) {
  const changed = changeFunction(module, names.wrapper, decl => ({ ...decl, body: b.ret(b.add(b.add(b.v(names.w), b.int(0)), b.int(1))) }));
  return extra?.transform ? extra.transform(changed, names, symbols) : changed;
} });

test('scalar shim profile retires a non-forwarding arithmetic adapter with a portable total-equivalence certificate', () => {
  const f = scalarShimFixture();
  try {
    const proposal = f.gc.propose(f.genesis.evidence.manifest)!;
    assert.equal(proposal.profile, SEMANTIC_GC_SHIM_PROFILE); assert.equal(proposal.shims!.length, 1); assert.equal(proposal.collapsed.length, 0);
    assert.equal(proposal.shims![0].selection.symbol, f.wrapper); assert.equal(proposal.shims![0].selection.target, f.target);
    assert.ok(proposal.removed.includes(f.wrapper)); assert.ok(!proposal.removed.includes(f.target));
    assert.equal(proposal.shims![0].certificate.format, 'aether.portable-ast-proof/1');
    assert.deepEqual(f.execute(proposal.targetRoot), f.execute(proposal.sourceRoot));
    assert.equal(new SemanticGarbageCollector(f.gcOptions).readProposal(proposal.id).id, proposal.id);
    assert.equal(f.gc.propose(f.genesis.evidence.manifest)!.id, proposal.id);
    assert.equal(f.store.head('production')!.root, proposal.sourceRoot);
  } finally { f.cleanup(); }
});

test('scalar shim comparison handles Boolean conditional adapters that the uniform-branch profile cannot simplify', () => {
  const f = fixture({ shimProfile: true, protectTarget: true, booleanWrapper: true, transform(module, names) {
    return changeFunction(module, names.wrapper, decl => ({ ...decl, body: b.ret(b.cond(b.v(names.w), b.bool(false), b.bool(true))) }));
  } });
  try {
    const proposal = f.gc.propose(f.genesis.evidence.manifest)!;
    assert.equal(proposal.branches!.length, 0); assert.equal(proposal.shims!.length, 1); assert.equal(proposal.collapsed.length, 0);
    assert.deepEqual(f.execute(proposal.targetRoot), f.execute(proposal.sourceRoot));
  } finally { f.cleanup(); }
});

test('scalar shim redirection evaluates every original argument once and in order even when parameters are reused or unused', () => {
  const f = fixture({ shimProfile: true, protectTarget: true, transform(module, names, symbols) {
    const secondModern = symbols.define('secondModern'), secondLegacy = symbols.define('secondLegacy'), firstEffect = symbols.define('firstEffect'), secondEffect = symbols.define('secondEffect');
    let source = changeFunction(module, names.target, decl => ({ ...decl, params: [...decl.params, b.param(secondModern, b.Int)], body: b.ret(b.mul(b.int(2), b.v(names.x))) }));
    source = changeFunction(source, names.wrapper, decl => ({ ...decl, params: [...decl.params, b.param(secondLegacy, b.Int)], body: b.ret(b.add(b.add(b.v(names.w), b.v(names.w)), b.sub(b.v(secondLegacy), b.v(secondLegacy)))) }));
    source = { ...source, members: [...source.members,
      b.fn({ symbol: firstEffect, params: [], returns: b.Int, purity: 'effectful', capabilities: [names.log], contract: b.contract({}), body: b.block(b.exprStmt(b.invoke(names.log, b.str('first-argument'))), b.ret(b.int(3))) }),
      b.fn({ symbol: secondEffect, params: [], returns: b.Int, purity: 'effectful', capabilities: [names.log], contract: b.contract({}), body: b.block(b.exprStmt(b.invoke(names.log, b.str('second-argument'))), b.ret(b.int(7))) }),
    ] };
    return changeFunction(source, names.entry, decl => ({ ...decl, purity: 'effectful', capabilities: [names.log], body: b.ret(b.call(names.wrapper, b.call(firstEffect), b.call(secondEffect))) }));
  } });
  try {
    const proposal = f.gc.propose(f.genesis.evidence.manifest)!; assert.equal(proposal.shims!.length, 1);
    const before = f.execute(proposal.sourceRoot), after = f.execute(proposal.targetRoot); assert.deepEqual(after, before);
    assert.deepEqual(after.effects, [...Array.from({ length: 5 }, () => [['first-argument'], ['second-argument']]).flat(), ['preserved effect']]);
    assert.ok(after.values.every(result => result.ok && result.value === 6n));
  } finally { f.cleanup(); }
});

test('scalar shim retirement is opt-in; the branch-only profile retains non-forwarding adapters', () => {
  const f = fixture({ branchProfile: true, protectTarget: true, transform(module, names) {
    return changeFunction(module, names.wrapper, decl => ({ ...decl, body: b.ret(b.add(b.add(b.v(names.w), b.int(0)), b.int(1))) }));
  } });
  try {
    const proposal = f.gc.propose(f.genesis.evidence.manifest)!; assert.equal(proposal.shims, undefined); assert.ok(!proposal.removed.includes(f.wrapper));
    assert.throws(() => new SemanticGarbageCollector({ ...f.gcOptions, profile: SEMANTIC_GC_SHIM_PROFILE }), /configuration changed/);
  } finally { f.cleanup(); }
});

test('legacy scalar shim proof remains readable but a new quota-changing promotion is refused before preparation', async () => {
  const f = scalarShimFixture();
  try {
    const proposal = f.gc.propose(f.genesis.evidence.manifest)!, candidate = f.artifact(f.store.hydrate(proposal.targetRoot), [f.genesis.intent!]);
    await assert.rejects(f.gc.promote(proposal.id, f.input(candidate), f.coordinator, f.driver(proposal)), /step-quota behavior/);
    assert.equal(f.coordinator.state().committedManifest, f.genesis.manifest);
    assert.equal(f.store.head('production')!.root, proposal.sourceRoot); f.gc.collect();
    for (const witness of proposal.shims!) assert.ok(f.store.get(witness.root));
    assert.deepEqual(f.execute(proposal.targetRoot), f.execute(proposal.sourceRoot));
    assert.equal(new SemanticGarbageCollector(f.gcOptions).readProposal(proposal.id).id, proposal.id);
  } finally { f.cleanup(); }
});

test('scalar shim comparison refuses unequal, nonempty-frame and call-bearing implementations', () => {
  for (const scenario of ['unequal', 'target-contract', 'callee-contract', 'call-bearing'] as const) {
    const f = scalarShimFixture({ transform(module, names, symbols) {
      if (scenario === 'unequal') return changeFunction(module, names.wrapper, decl => ({ ...decl, body: b.ret(b.add(b.v(names.w), b.int(2))) }));
      if (scenario === 'target-contract') return changeFunction(module, names.target, decl => ({ ...decl, contract: b.contract({ ensures: [b.clause(b.bool(true), 'target-check-retained')] }) }));
      if (scenario === 'callee-contract') return changeFunction(module, names.wrapper, decl => ({ ...decl, contract: b.contract({ ensures: [b.clause(b.bool(true), 'adapter-check-retained')] }) }));
      const identity = symbols.define('identityHelper'), value = symbols.define('identityValue');
      return changeFunction({ ...module, members: [...module.members, b.fn({ symbol: identity, params: [b.param(value, b.Int)], returns: b.Int, contract: b.contract({}), body: b.ret(b.v(value)) })] }, names.wrapper, decl => ({ ...decl, body: b.ret(b.add(b.call(identity, b.v(names.w)), b.int(1))) }));
    } });
    try {
      const proposal = f.gc.propose(f.genesis.evidence.manifest)!;
      assert.equal(proposal.shims!.length, 0, scenario); assert.ok(!proposal.removed.includes(f.wrapper), scenario);
      assert.deepEqual(f.execute(proposal.targetRoot), f.execute(proposal.sourceRoot));
    } finally { f.cleanup(); }
  }
});

test('V2 call-bearing scalar shim proves a closed helper expansion before redirecting live callers', async () => {
  const f = scalarShimFixture({ callShimProfile: true, transform(module, names, symbols) {
    const identity = symbols.define('callShimIdentity'), value = symbols.define('callShimValue');
    const withHelper = { ...module, members: [...module.members,
      b.fn({ symbol: identity, params: [b.param(value, b.Int)], returns: b.Int, contract: b.contract({}), body: b.ret(b.v(value)) })] };
    return changeFunction(withHelper, names.wrapper, decl => ({ ...decl,
      body: b.ret(b.add(b.call(identity, b.v(names.w)), b.int(1))) }));
  } });
  try {
    const proposal = f.gc.propose(f.genesis.evidence.manifest)!;
    assert.equal(proposal.profile, SEMANTIC_GC_CALL_SHIM_PROFILE);
    assert.ok(proposal.shims!.some(witness => witness.selection.symbol === f.wrapper && witness.selection.target === f.target));
    assert.ok(proposal.removed.includes(f.wrapper));
    assert.deepEqual(f.execute(proposal.targetRoot), f.execute(proposal.sourceRoot));
    assert.equal(new SemanticGarbageCollector(f.gcOptions).readProposal(proposal.id).id, proposal.id);
    assert.throws(() => new SemanticGarbageCollector({ ...f.gcOptions, profile: SEMANTIC_GC_SHIM_PROFILE }), /configuration changed/);
    const candidate = f.artifact(f.store.hydrate(proposal.targetRoot), [f.genesis.intent!]);
    await assert.rejects(f.gc.promote(proposal.id, f.input(candidate), f.coordinator, f.driver(proposal)), /step-quota behavior/);
    assert.equal(f.store.head('production')!.root, proposal.sourceRoot);
  } finally { f.cleanup(); }
});

test('V2 call-bearing shim keeps a helper with runtime contract checks or partial arithmetic', () => {
  for (const unsafe of ['contract', 'partial'] as const) {
    const f = scalarShimFixture({ callShimProfile: true, transform(module, names, symbols) {
      const helper = symbols.define(`unsafeHelper${unsafe}`), value = symbols.define(`unsafeValue${unsafe}`);
      const withHelper = { ...module, members: [...module.members,
        b.fn({ symbol: helper, params: [b.param(value, b.Int)], returns: b.Int,
          contract: unsafe === 'contract' ? b.contract({ ensures: [b.clause(b.bool(true), 'retained-helper-contract')] }) : b.contract({}),
          body: b.ret(unsafe === 'partial' ? b.div(b.v(value), b.v(value)) : b.v(value)) })] };
      return changeFunction(withHelper, names.wrapper, decl => ({ ...decl,
        body: b.ret(b.add(b.call(helper, b.v(names.w)), b.int(1))) }));
    } });
    try {
      const proposal = f.gc.propose(f.genesis.evidence.manifest)!;
      assert.equal(proposal.shims!.length, 0, unsafe);
      assert.ok(!proposal.removed.includes(f.wrapper), unsafe);
      assert.equal(f.store.head('production')!.root, proposal.sourceRoot);
    } finally { f.cleanup(); }
  }
});

test('V2 call-bearing shim refuses to erase an evaluated partial helper argument', () => {
  const f = scalarShimFixture({ callShimProfile: true, transform(module, names, symbols) {
    const ignore = symbols.define('ignorePartialArgument'), unused = symbols.define('unusedPartialArgument');
    let changed = changeFunction(module, names.target, decl => ({ ...decl, body: b.ret(b.int(1)) }));
    changed = { ...changed, members: [...changed.members,
      b.fn({ symbol: ignore, params: [b.param(unused, b.Int)], returns: b.Int, contract: b.contract({}), body: b.ret(b.int(0)) })] };
    return changeFunction(changed, names.wrapper, decl => ({ ...decl,
      body: b.ret(b.add(b.call(ignore, b.div(b.int(1), b.sub(b.v(names.w), b.v(names.w)))), b.int(1))) }));
  } });
  try {
    const proposal = f.gc.propose(f.genesis.evidence.manifest)!;
    assert.equal(proposal.shims!.length, 0);
    assert.ok(!proposal.removed.includes(f.wrapper));
    assert.ok(f.execute(proposal.sourceRoot).values.some(result => !result.ok), 'the discarded argument has an observable fault');
    assert.equal(f.store.head('production')!.root, proposal.sourceRoot);
  } finally { f.cleanup(); }
});

test('scalar shim retirement preserves exports, explicit protection and signed fences even for equivalent bodies', () => {
  for (const options of [{ exportWrapper: true }, { protectWrapper: true }, { fenceWrapper: true }]) {
    const f = scalarShimFixture(options);
    try {
      const proposal = f.gc.propose(f.genesis.evidence.manifest)!;
      assert.equal(proposal.shims!.length, 0); assert.ok(!proposal.removed.includes(f.wrapper));
      assert.deepEqual(f.execute(proposal.targetRoot), f.execute(proposal.sourceRoot));
    } finally { f.cleanup(); }
  }
});

test('transparent forwarding and general scalar shim proofs compose without target cycles', () => {
  const f = scalarShimFixture({ transform(module, names, symbols) {
    const forwarder = symbols.define('forwardToAdapter'), argument = symbols.define('forwardArgument');
    const source = { ...module, members: [...module.members, b.fn({ symbol: forwarder, params: [b.param(argument, b.Int)], returns: b.Int, contract: b.contract({}), body: b.ret(b.call(names.wrapper, b.v(argument))) })] };
    return changeFunction(source, names.entry, decl => ({ ...decl, body: b.ret(b.add(b.call(forwarder, b.v(names.n)), b.int(10))) }));
  } });
  try {
    const proposal = f.gc.propose(f.genesis.evidence.manifest)!;
    assert.equal(proposal.shims!.length, 1); assert.equal(proposal.collapsed.length, 1); assert.equal(proposal.collapsed[0].target, f.target);
    assert.deepEqual(f.execute(proposal.targetRoot), f.execute(proposal.sourceRoot));
    assert.equal(new SemanticGarbageCollector(f.gcOptions).readProposal(proposal.id).id, proposal.id);
  } finally { f.cleanup(); }
});

test('scalar shim admission rejects missing proofs, changed declaration identity and alternate result code', () => {
  const f = scalarShimFixture();
  try {
    const proposal = f.gc.propose(f.genesis.evidence.manifest)!;
    const forge = (changes: Partial<SemanticGcProposal>) => { const { id: _id, ...body } = { ...proposal, ...changes }; const changed = { ...body, id: domainDigest('aether.semantic-gc-proposal/1', body) }; writeFileSync(join(f.directory, 'gc/proposals', `${changed.id.split(':').at(-1)}.json`), encodeCanonical(changed)); return changed.id; };
    assert.throws(() => f.gc.readProposal(forge({ shims: [] })), /unsafe candidate|incomplete/);
    const incomplete = proposal.shims!.map(witness => ({ ...witness, certificate: { ...witness.certificate, certificates: [] } }));
    assert.throws(() => f.gc.readProposal(forge({ shims: incomplete })), /coverage/);
    const changed = proposal.shims!.map(witness => ({ ...witness, selection: { ...witness.selection, sourceDeclaration: witness.selection.targetDeclaration } }));
    assert.throws(() => f.gc.readProposal(forge({ shims: changed })), /declaration|target mismatch/);
    const candidate = f.store.hydrate(proposal.targetRoot); if (candidate.kind !== 'Module') throw new Error('module missing');
    const wrongRoot = f.store.intern(changeFunction(candidate, f.entry, decl => ({ ...decl, body: b.ret(b.int(-1234)) })), { leaseId: 'wrong-shim-code' });
    assert.throws(() => f.gc.readProposal(forge({ targetRoot: wrongRoot })), /unsafe candidate/);
    assert.equal(f.store.head('production')!.root, proposal.sourceRoot);
  } finally { f.cleanup(); }
});

test('scalar shim certificates remain independently checkable with proof search disabled', async () => {
  const f = scalarShimFixture(), consumer = mkdtempSync(join(tmpdir(), 'aether-gc-shim-consumer-'));
  try {
    const proposal = f.gc.propose(f.genesis.evidence.manifest)!;
    cpSync(resolve('src'), join(consumer, 'src'), { recursive: true }); writeFileSync(join(consumer, 'package.json'), '{"type":"module"}\n');
    writeFileSync(join(consumer, 'src/tier2/portable-proof-producer.ts'), "export function generatePortableCertificate() { throw new Error('proof search disabled'); }\n");
    const { SemanticGarbageCollector: Consumer } = await import(pathToFileURL(join(consumer, 'src/tier1/semantic-gc.ts')).href);
    assert.equal(new Consumer(f.gcOptions).readProposal(proposal.id).id, proposal.id);
  } finally { f.cleanup(); rmSync(consumer, { recursive: true, force: true }); }
});
