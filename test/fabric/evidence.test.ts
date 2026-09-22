import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as b from '../../src/tier1/build.ts';
import type { Term, Ty } from '../../src/tier1/ast.ts';
import { typeName } from '../../src/tier1/ids.ts';
import { SymbolSpace } from '../../src/tier1/symbols.ts';
import { CapabilityRegistry } from '../../src/tier2/ocap.ts';
import { verifyFunction } from '../../src/tier2/verify.ts';
import { ProductionRuntime } from '../../src/tier3/compile.ts';
import { buildLedgerExample } from '../../src/examples/ledger.ts';
import { domainDigest } from '../../src/fabric/identity.ts';
import { DEFAULT_EVIDENCE_POLICY, createEvidenceManifest, isVettedReport, mintLocalEvidence, validateEvidence, validateVettedEvidence, type EvidenceContext } from '../../src/fabric/evidence.ts';

const clause = (label: string, expr: Term, rigor: 'formal' | 'property' = 'formal') => b.clause(expr, label, rigor);
const digest = (name: string) => domainDigest('aether.test/1', name);
function setup(property = false) {
  const symbols = new SymbolSpace('evidence-tests');
  const increment = symbols.define('increment'), x = symbols.define('x'), caller = symbols.define('caller'), y = symbols.define('y');
  const callee = b.fn({ symbol: increment, params: [b.param(x, b.Int)], returns: b.Int,
    contract: b.contract({ requires: [clause('nonnegative', b.ge(b.v(x), b.int(0)))], ensures: [clause('incremented', b.eq(b.result(), b.add(b.v(x), b.int(1))), property ? 'property' : 'formal')] }),
    body: b.block(b.ret(b.add(b.v(x), b.int(1)))),
  });
  const entry = b.fn({ symbol: caller, params: [b.param(y, b.Int)], returns: b.Int,
    contract: b.contract({ requires: [clause('entry_nonnegative', b.ge(b.v(y), b.int(0)))], ensures: property ? [] : [clause('positive', b.gt(b.result(), b.int(0)))] }),
    body: b.block(b.ret(b.call(increment, b.v(y)))),
  });
  const module = b.module_({ symbol: symbols.define('module'), members: [callee, entry], symbolTable: symbols.table() });
  const context: EvidenceContext = {
    module, specification: 'Increment nonnegative integers.', semanticsVersion: 'aether-reference/1',
    compilerDigest: digest('compiler'), target: { abiVersion: 'local/1', profileDigest: digest('profile'), artifactDigest: digest('artifact') },
    capabilityPolicyDigest: digest('capabilities'), registry: new CapabilityRegistry(),
  };
  return { context, callee, entry, increment, caller, x, y };
}
function replace(context: EvidenceContext, old: Term, next: Term): EvidenceContext {
  assert.equal(context.module.kind, 'Module');
  return { ...context, module: { ...context.module as Extract<Term, { kind: 'Module' }>, members: (context.module as Extract<Term, { kind: 'Module' }>).members.map(member => member === old ? next : member) } };
}
function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)); }

test('F06 compiler admission consumes branded evidence and preserves every external precondition', () => {
  const { context, increment } = setup();
  const local = mintLocalEvidence(context), vetted = validateEvidence(local, context);
  const evidence = { vetted, expectedManifest: createEvidenceManifest(context) };
  const runtime = ProductionRuntime.compile(context.module, { registry: context.registry, evidence, entryPoints: [] });
  assert.deepEqual(runtime.call(increment, [1n]), { ok: true, value: 2n, steps: 0 });
  const rejected = runtime.call(increment, [-1n]);
  assert.equal(rejected.ok, false);
  if (!rejected.ok) assert.equal(rejected.fault.kind, 'precondition');
  assert.ok(runtime.report.decisions.some(decision => decision.kind === 'postcondition' && decision.decision === 'elided'));
  assert.throws(() => ProductionRuntime.compile(context.module, { registry: context.registry, evidence, policy: 'elide' }), /unconditional/);
  assert.throws(() => ProductionRuntime.compile(context.module, { registry: context.registry, evidence, verification: vetted.reports }), /legacy/);
  assert.throws(() => ProductionRuntime.compile(context.module, { registry: context.registry, evidence: { ...evidence, vetted: { ...vetted } } }), /provenance/);
  assert.throws(() => ProductionRuntime.compile(context.module, { registry: context.registry, evidence: { ...evidence, expectedManifest: { ...evidence.expectedManifest, compilerDigest: digest('changed compiler') } } }), /manifest/);
  const other = setup(true);
  assert.throws(() => ProductionRuntime.compile(other.context.module, { registry: context.registry, evidence }), /compiled module/);
});

test('F06 compiler admission retains property-classified postconditions', () => {
  const { context, increment } = setup(true);
  const permitted = { ...context, policy: { ...DEFAULT_EVIDENCE_POLICY, requireFormal: false } };
  const local = mintLocalEvidence(permitted);
  const vetted = validateEvidence(local, permitted);
  const runtime = ProductionRuntime.compile(context.module, { registry: context.registry,
    evidence: { vetted, expectedManifest: createEvidenceManifest(permitted) } });
  assert.equal(runtime.call(increment, [5n]).ok, true);
  assert.ok(runtime.report.decisions.some(decision => decision.label === 'incremented' && decision.decision === 'kept'));
});

test('F06: actual local solver evidence is bound, immutable and distinguishable from peer claims', () => {
  const { context, increment } = setup();
  const evidence = mintLocalEvidence(context);
  const local = validateEvidence(evidence, context);
  validateVettedEvidence(local, evidence.manifest);
  assert.throws(() => validateVettedEvidence({ ...local }, evidence.manifest), /provenance/);
  assert.equal(local.provenance, 'trusted_local');
  const report = local.reports.get(increment)!;
  assert.equal(report.verdict, 'proved');
  assert.equal(isVettedReport(report, local.manifestDigest), true);
  assert.equal(isVettedReport({ ...report }), false);
  assert.throws(() => { (report.results as unknown[]).pop(); });
  const peer = validateEvidence(clone(evidence), context);
  assert.equal(peer.provenance, 'reverified_peer');
  assert.notEqual(peer.reports.get(increment), report);
  assert.equal(isVettedReport(peer.reports.get(increment)!, peer.manifestDigest), true);
  validateVettedEvidence(peer, evidence.manifest);
  assert.throws(() => validateVettedEvidence(peer, { ...evidence.manifest, compilerDigest: digest('other compiler') }), /manifest/);
  (peer.reports as Map<unknown, unknown>).set(increment, { ...report });
  assert.throws(() => validateVettedEvidence(peer, evidence.manifest), /provenance/);
  validateVettedEvidence(validateEvidence(evidence, context), evidence.manifest);
});

test('F06/G1: every execution-subject field invalidates old evidence', () => {
  const { context, callee } = setup();
  const evidence = mintLocalEvidence(context);
  assert.equal(callee.kind, 'FunctionDecl');
  const changedBody = { ...callee as Extract<Term, { kind: 'FunctionDecl' }>, body: b.block(b.ret(b.int(3))) };
  const changedContract = { ...callee as Extract<Term, { kind: 'FunctionDecl' }>, contract: b.contract({ ensures: [clause('other', b.bool(true))] }) };
  const alternatives: EvidenceContext[] = [
    replace(context, callee, changedBody), replace(context, callee, changedContract),
    { ...context, specification: 'Changed specification.' }, { ...context, semanticsVersion: 'changed/2' },
    { ...context, compilerDigest: digest('changed compiler') }, { ...context, capabilityPolicyDigest: digest('changed authority') },
    { ...context, target: { ...context.target, artifactDigest: digest('changed artifact') } },
    { ...context, target: { ...context.target, profileDigest: digest('changed profile') } },
    { ...context, target: { ...context.target, abiVersion: 'new ABI' } },
    { ...context, policy: { ...DEFAULT_EVIDENCE_POLICY, maxPaths: 63 } },
  ];
  for (const candidate of alternatives) assert.throws(() => validateEvidence(evidence, candidate));
});

test('F06/G1: actual transitive external dependency content is resolved and pinned', () => {
  const { context, callee, entry } = setup();
  assert.equal(context.module.kind, 'Module');
  const external: EvidenceContext = { ...context, module: { ...context.module as Extract<Term, { kind: 'Module' }>, members: [entry] }, resolveDeclaration: () => callee };
  const evidence = mintLocalEvidence(external);
  assert.equal(evidence.manifest.dependencies.length, 1);
  assert.throws(() => validateEvidence(evidence, { ...external, resolveDeclaration: () => undefined }), /unresolved/);
  assert.throws(() => validateEvidence(evidence, { ...external, resolveDeclaration: () => ({ ...callee as Extract<Term, { kind: 'FunctionDecl' }>, body: b.block(b.ret(b.int(99))) }) }), /stale/);
});

test('F06/G2: malformed, truncated, duplicate, hidden-assumption and forged evidence fails closed', () => {
  const { context } = setup();
  const original = mintLocalEvidence(context);
  const changes: Array<(value: any) => void> = [
    value => value.reports.pop(),
    value => value.reports[0].results.pop(),
    value => value.reports[0].results.push(value.reports[0].results[0]),
    value => value.reports.push(value.reports[0]),
    value => delete value.reports[0].frameViolations,
    value => value.reports[0].assumptions.push('assume all accounts differ'),
    value => value.reports[0].budgetExhausted = true,
    value => value.reports[0].results[0].solverStatus = 'unknown',
    value => value.reports[0].results[0].abstractedTerms = 1,
    value => value.reports[0].unprovenFormalContracts = ['not proved'],
    value => value.reports[0].pathsExplored = false,
    value => value.reports[0].verdict = 'made up',
    value => value.envelope.checker.id = 'untrusted prover',
  ];
  for (const change of changes) {
    const tampered = clone(original); change(tampered);
    assert.throws(() => validateEvidence(tampered, context));
  }
  // Hashing a fabricated report does not create local authority.
  const forged = clone(original) as any;
  forged.reports[0].results.pop();
  forged.envelope.evidenceDigest = domainDigest('aether.evidence-payload/1', forged.reports);
  assert.throws(() => validateEvidence(forged, context), /obligation/);
});

test('F06/G2: unchecked caller preconditions and absent frame contracts do not mint evidence', () => {
  const { context, entry } = setup();
  const decl = entry as Extract<Term, { kind: 'FunctionDecl' }>;
  const unchecked = replace(context, entry, { ...decl, contract: b.contract({ ensures: (decl.contract as Extract<Term, { kind: 'Contract' }>).ensures }) });
  assert.throws(() => mintLocalEvidence(unchecked), /refuted|incomplete/);
  assert.throws(() => mintLocalEvidence(replace(context, entry, { ...decl, contract: null })), /frame contract/);
  assert.throws(() => validateEvidence(mintLocalEvidence(context), { ...context, policy: { ...DEFAULT_EVIDENCE_POLICY, maxBytes: 100 } }), /limit/);
});

test('F06/G3: property classification remains delegated and never becomes formal proof', () => {
  const { context, increment } = setup(true);
  assert.throws(() => mintLocalEvidence(context), /property/);
  const permissive = { ...context, policy: { ...DEFAULT_EVIDENCE_POLICY, requireFormal: false } };
  const evidence = mintLocalEvidence(permissive);
  const result = validateEvidence(evidence, permissive).reports.get(increment)!;
  assert.equal(result.results[0].verdict, 'delegated');
  for (const kind of ['property_campaign', 'certificate']) {
    const changed = clone(evidence) as any; changed.envelope.evidenceKind = kind;
    assert.throws(() => validateEvidence(changed, permissive), /property|certificate/);
  }
});

test('F06: modeled ledger record transitions and formal loops are accepted with property clauses retained', () => {
  const base = setup().context;
  const ledger = buildLedgerExample('evidence-ledger');
  const context = { ...base, module: ledger.module, registry: ledger.capabilities, policy: { ...DEFAULT_EVIDENCE_POLICY, requireFormal: false } };
  const evidence = mintLocalEvidence(context);
  const validated = validateEvidence(evidence, context);
  assert.equal(validated.reports.get(ledger.symbols.transfer)?.verdict, 'proved');
  const loop = validated.reports.get(ledger.symbols.accrue)!;
  assert.ok(loop.results.some(row => row.obligation.kind === 'invariant_preserved' && row.verdict === 'proved'));
});

test('F06: actual verifier alias assumptions remain explicit and cannot authorize evidence', () => {
  const base = setup().context;
  const ledger = buildLedgerExample('evidence-alias');
  const module = ledger.module as Extract<Term, { kind: 'Module' }>;
  const transfer = module.members.find(member => member.kind === 'FunctionDecl' && member.symbol === ledger.symbols.transfer) as Extract<Term, { kind: 'FunctionDecl' }>;
  const contract = transfer.contract as Extract<Term, { kind: 'Contract' }>;
  const weakened = { ...transfer, contract: { ...contract, requires: contract.requires.filter(item => item.kind !== 'Clause' || item.label !== 'distinct_accounts') } };
  const report = verifyFunction(weakened);
  assert.equal(report.verdict, 'proved');
  assert.ok(report.assumptions.length > 0);
  const context = { ...base, module: { ...module, members: [weakened] }, registry: ledger.capabilities };
  assert.throws(() => mintLocalEvidence(context), /assumptions/);
});

test('F06: type and capability validation precede proof admission', () => {
  const { context, callee } = setup();
  const wrong = { ...callee as Extract<Term, { kind: 'FunctionDecl' }>, body: b.block(b.ret(b.str('bad'))) };
  assert.throws(() => createEvidenceManifest(replace(context, callee, wrong)), /type\/capability/);
});

test('F06/G2: actual exhausted solver budgets and truncated branch exploration cannot mint evidence', () => {
  const { context, callee, x } = setup();
  const declaration = callee as Extract<Term, { kind: 'FunctionDecl' }>;
  const expensive = { ...declaration, contract: b.contract({ ensures: Array.from({ length: 250 }, (_, index) => clause(`equation-${index}`, b.eq(b.result(), b.add(b.v(x), b.int(1))))) }) };
  assert.throws(() => mintLocalEvidence({ ...replace(context, callee, expensive), policy: { ...DEFAULT_EVIDENCE_POLICY, budgetMs: 1 } }), /budget|timed out|incomplete/);
  const branching = { ...declaration, body: b.block(b.if_(b.ge(b.v(x), b.int(0)), b.block(), b.block()), b.ret(b.add(b.v(x), b.int(1)))) };
  assert.throws(() => mintLocalEvidence({ ...replace(context, callee, branching), policy: { ...DEFAULT_EVIDENCE_POLICY, maxPaths: 1 } }), /path exploration/);
});

test('F06: concrete nested-alias verifier gap is rejected before a false proof can authorize elision', () => {
  const syms = new SymbolSpace('nested-alias-gap');
  const fn = syms.define('mutate'), a = syms.define('a'), z = syms.define('z');
  const inner: Ty = { t: 'Record', name: typeName('type:test:inner'), fields: [['count', b.Int]] };
  const outer: Ty = { t: 'Record', name: typeName('type:test:outer'), fields: [['child', inner]] };
  const left = b.field(b.field(b.v(a), 'child'), 'count');
  const right = b.field(b.field(b.v(z), 'child'), 'count');
  const declaration = b.fn({ symbol: fn, params: [b.param(a, outer), b.param(z, outer)], returns: b.Unit,
    contract: b.contract({ requires: [clause('distinct_roots', b.ne(b.v(a), b.v(z)))], modifies: [b.place(a, 'child', 'count')], ensures: [clause('other_unchanged', b.eq(right, b.old(right)))] }),
    body: b.block(b.assign(b.place(a, 'child', 'count'), b.add(left, b.int(1))), b.ret(b.unit())),
  });
  const module = b.module_({ symbol: syms.define('module'), members: [declaration], symbolTable: syms.table() });
  const report = verifyFunction(declaration);
  assert.equal(report.verdict, 'proved');
  assert.deepEqual(report.assumptions, [], 'existing verifier incorrectly treats root separation as nested separation');
  const registry = new CapabilityRegistry();
  const runtime = ProductionRuntime.compile(module, { registry, policy: 'enforce' });
  const shared = runtime.allocateRecord(inner, { count: 1n });
  const first = runtime.allocateRecord(outer, { child: shared }), second = runtime.allocateRecord(outer, { child: shared });
  const execution = runtime.call(fn, [first, second]);
  assert.equal(execution.ok, false, 'actual execution violates the postcondition despite the old proof');
  assert.equal(runtime.readRecord(shared).get('count'), 2n);
  assert.throws(() => mintLocalEvidence({ ...setup().context, module, registry }), /nested heap aliasing/);
});
