/** Exact-subject admission for the existing local verifier. This is not a portable proof kernel. */
import { children, type Term, type Ty } from '../tier1/ast.ts';
import type { SymbolId } from '../tier1/ids.ts';
import { GraphStore } from '../tier1/store.ts';
import type { CapabilityRegistry } from '../tier2/ocap.ts';
import { typecheck } from '../tier2/typecheck.ts';
import { verifyFunction, type VerificationReport } from '../tier2/verify.ts';
import { V4_SMT_HARD_CUTOFF_MS } from '../tier2/hard-solver.ts';
import { encodeCanonical, exactObject, identifier } from './encoding.ts';
import { createExecutionManifest, domainDigest, executionManifestDigest, validateExecutionManifest, validateDigest, type ExecutionManifestV1, type Digest, type DependencyV1 } from './identity.ts';

export interface EvidencePolicyV1 {
  readonly format: 'aether.evidence-policy/1';
  /** False permits property-classified clauses to remain checked at runtime; it does not prove them. */
  readonly requireFormal: boolean;
  readonly budgetMs: number;
  readonly maxPaths: number;
  readonly maxNodes: number;
  readonly maxDepth: number;
  readonly maxBytes: number;
}
export interface EvidencePolicyV2 extends Omit<EvidencePolicyV1, 'format'> {
  readonly format: 'aether.evidence-policy/2';
  readonly solverProfile: 'v4-hard/1';
}
export type EvidencePolicy = EvidencePolicyV1 | EvidencePolicyV2;
export const DEFAULT_EVIDENCE_POLICY: EvidencePolicyV1 = Object.freeze({
  format: 'aether.evidence-policy/1', requireFormal: true, budgetMs: 1_500,
  maxPaths: 64, maxNodes: 50_000, maxDepth: 64, maxBytes: 8 * 1024 * 1024,
});
export const DEFAULT_EVIDENCE_POLICY_V2: EvidencePolicyV2 = Object.freeze({ ...DEFAULT_EVIDENCE_POLICY, format: 'aether.evidence-policy/2', solverProfile: 'v4-hard/1' });
export interface EvidenceContext {
  readonly module: Term;
  readonly specification: string;
  readonly semanticsVersion: string;
  readonly compilerDigest: Digest;
  readonly target: ExecutionManifestV1['target'];
  readonly capabilityPolicyDigest: Digest;
  readonly registry: CapabilityRegistry;
  readonly policy?: EvidencePolicy;
  /** Return actual declaration content; hashes and transitive calls are recomputed here. */
  readonly resolveDeclaration?: (symbol: SymbolId) => Term | undefined;
}
export interface EvidenceEnvelopeV1 {
  readonly format: 'aether.evidence/1';
  readonly executionManifest: Digest;
  readonly obligationSetDigest: Digest;
  readonly assumptionsDigest: Digest;
  readonly evidenceKind: 'local_solver' | 'certificate' | 'property_campaign';
  readonly checker: { readonly id: string; readonly version: string; readonly semanticsVersion: string };
  readonly evidenceDigest: Digest;
  readonly limits: { readonly bytes: number; readonly steps: number; readonly depth: number };
}
interface WireObligation {
  readonly id: string;
  readonly kind: string;
  readonly label: string;
  readonly rigor: string;
  readonly path: readonly string[];
  readonly callee: string | null;
  readonly clause: string | null;
  readonly smtLib: string;
}
interface WireResult extends WireObligation { readonly verdict: string; readonly solverStatus: string | null; readonly abstractedTerms: number | null }
interface WireReport {
  readonly symbol: SymbolId;
  readonly subject: Digest;
  readonly dependencies: VerificationReport['dependencies'];
  readonly verdict: string;
  readonly results: readonly WireResult[];
  readonly assumptions: readonly string[];
  readonly frameViolations: readonly string[];
  readonly budgetExhausted: boolean;
  readonly pathsExplored: number;
  readonly unprovenFormalContracts: readonly string[];
  readonly delegatedToFuzzing: readonly string[];
}
export interface LocalEvidenceV1 {
  readonly envelope: EvidenceEnvelopeV1;
  readonly manifest: ExecutionManifestV1;
  readonly reports: readonly WireReport[];
}
export interface VettedEvidence {
  readonly manifest: ExecutionManifestV1;
  readonly manifestDigest: Digest;
  readonly reports: ReadonlyMap<SymbolId, VerificationReport>;
  readonly provenance: 'trusted_local' | 'reverified_peer';
}
type Declaration = Extract<Term, { kind: 'FunctionDecl' }>;
const minted = new WeakMap<object, VettedEvidence>();
const vettedReports = new WeakMap<object, Digest>();
const vettedObjects = new WeakMap<object, { manifestDigest: Digest; reports: ReadonlyMap<SymbolId, VerificationReport> }>();

/** Only reports minted/reverified here can authorize elision; copying/JSON loses authority. */
export function isVettedReport(report: VerificationReport, manifestDigest?: Digest): boolean {
  const bound = vettedReports.get(report);
  return bound !== undefined && (manifestDigest === undefined || bound === manifestDigest);
}
/** Admission capability validation. Structural copies and mutated report maps cannot authorize execution. */
export function validateVettedEvidence(value: unknown, expectedManifest: ExecutionManifestV1): asserts value is VettedEvidence {
  if (!value || typeof value !== 'object') throw new TypeError('untrusted vetted evidence object');
  const brand = vettedObjects.get(value);
  if (!brand) throw new TypeError('untrusted vetted evidence provenance');
  const evidence = value as VettedEvidence;
  const expected = executionManifestDigest(expectedManifest);
  if (expected !== brand.manifestDigest || evidence.manifestDigest !== expected || executionManifestDigest(evidence.manifest) !== expected) throw new TypeError('vetted evidence manifest mismatch');
  if (!(evidence.reports instanceof Map) || evidence.reports.size !== brand.reports.size) throw new TypeError('vetted evidence report set changed');
  for (const [symbol, report] of evidence.reports) {
    if (brand.reports.get(symbol) !== report || !isVettedReport(report, expected) || report.symbol !== symbol) throw new TypeError('vetted evidence report provenance mismatch');
  }
}
function policyFor(context: EvidenceContext): EvidencePolicy {
  const policy = context.policy ?? DEFAULT_EVIDENCE_POLICY;
  const fields = ['format', 'requireFormal', 'budgetMs', 'maxPaths', 'maxNodes', 'maxDepth', 'maxBytes'];
  if (policy.format === 'aether.evidence-policy/2') {
    exactObject(policy, [...fields, 'solverProfile']);
    if (policy.solverProfile !== 'v4-hard/1' || policy.budgetMs > V4_SMT_HARD_CUTOFF_MS) throw new TypeError('invalid v4 hard evidence policy');
  } else {
    exactObject(policy, fields);
    if (policy.format !== 'aether.evidence-policy/1') throw new TypeError('invalid evidence policy');
  }
  if (typeof policy.requireFormal !== 'boolean') throw new TypeError('invalid evidence policy');
  for (const key of ['budgetMs', 'maxPaths', 'maxNodes', 'maxDepth', 'maxBytes'] as const) {
    if (!Number.isSafeInteger(policy[key]) || policy[key] < 1) throw new TypeError('invalid evidence resource limit');
  }
  if (policy.maxDepth > 128) throw new RangeError('evidence depth exceeds local checker limit');
  return policy;
}
function limits(policy: EvidencePolicy) {
  return { maxFrameBytes: policy.maxBytes, maxDecompressedBytes: policy.maxBytes, maxDepth: Math.min(256, policy.maxDepth + 32), maxObjects: policy.maxNodes * 32 };
}
function same(a: unknown, b: unknown, policy: EvidencePolicy): boolean {
  return Buffer.compare(encodeCanonical(a, limits(policy)), encodeCanonical(b, limits(policy))) === 0;
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function walk(term: Term, visit: (term: Term) => void, policy: EvidencePolicy): void {
  let count = 0;
  const active = new Set<Term>();
  const scan = (node: Term, depth: number) => {
    if (++count > policy.maxNodes || depth > policy.maxDepth || active.has(node)) throw new RangeError('AST exploration limit or cycle');
    active.add(node); visit(node);
    for (const child of children(node)) scan(child, depth + 1);
    active.delete(node);
  };
  scan(term, 0);
}
/** Bound types, annotations and literals too, before GraphStore's recursive AST encoding. */
function checkAstInput(value: unknown, policy: EvidencePolicy): void {
  let nodes = 0;
  const active = new Set<object>();
  const normalize = (item: unknown, depth: number): unknown => {
    if (++nodes > policy.maxNodes * 16 || depth > policy.maxDepth + 16) throw new RangeError('AST value resource limit');
    if (typeof item === 'bigint') {
      const decimal = item.toString();
      if (decimal.length > 4096) throw new RangeError('AST integer limit');
      return { integer: decimal };
    }
    if (!item || typeof item !== 'object') return item;
    if (active.has(item)) throw new TypeError('cyclic AST value');
    active.add(item);
    const keys = Object.keys(item);
    const descriptors = Object.getOwnPropertyDescriptors(item);
    if (Object.values(descriptors).some(descriptor => !('value' in descriptor))) throw new TypeError('AST accessor is unsupported');
    let result: unknown;
    if (Array.isArray(item)) {
      if (keys.length !== item.length) throw new TypeError('sparse AST array');
      result = item.map(child => normalize(child, depth + 1));
    } else {
      exactObject(item, keys);
      result = Object.fromEntries(keys.map(key => [key, normalize(descriptors[key].value, depth + 1)]));
    }
    active.delete(item);
    return result;
  };
  encodeCanonical(normalize(value, 0), limits(policy));
}
function calls(decl: Term, policy: EvidencePolicy): SymbolId[] {
  const out = new Set<SymbolId>();
  walk(decl, node => {
    if (node.kind === 'Call' || node.kind === 'SeqMap' || node.kind === 'SeqFold') out.add(node.callee);
  }, policy);
  return [...out].sort();
}
function prepare(context: EvidenceContext) {
  const policy = policyFor(context);
  checkAstInput(context.module, policy);
  if (context.module.kind !== 'Module') throw new TypeError('evidence requires a complete module');
  walk(context.module, () => {}, policy); // before content hashing / symbolic exploration
  const store = new GraphStore();
  const environment = new Map<SymbolId, Declaration>();
  for (const member of context.module.members) if (member.kind === 'FunctionDecl') {
    if (environment.has(member.symbol)) throw new TypeError('duplicate declaration symbol');
    environment.set(member.symbol, member);
  }
  const initial = [...environment.values()];
  const loading = new Set<SymbolId>();
  const resolve = (symbol: SymbolId): Declaration => {
    const existing = environment.get(symbol);
    if (existing) return existing;
    if (loading.has(symbol)) throw new TypeError('recursive external resolution');
    loading.add(symbol);
    const found = context.resolveDeclaration?.(symbol);
    if (found?.kind !== 'FunctionDecl' || found.symbol !== symbol) throw new TypeError(`unresolved declaration ${symbol}`);
    checkAstInput(found, policy);
    walk(found, () => {}, policy);
    environment.set(symbol, found); loading.delete(symbol);
    return found;
  };
  const rootSymbols = new Set(initial.flatMap(decl => calls(decl, policy)));
  const roots: DependencyV1[] = [...rootSymbols].sort().map(symbol => ({ symbol, declaration: store.intern(resolve(symbol)) }));
  const manifest = createExecutionManifest({
    astRoot: store.intern(context.module), specRoot: domainDigest('aether.specification/1', context.specification, limits(policy)),
    semanticsVersion: context.semanticsVersion, compilerDigest: context.compilerDigest, target: { ...context.target },
    capabilityPolicyDigest: context.capabilityPolicyDigest, evidencePolicyDigest: domainDigest(policy.format, policy),
  }, roots, dependency => {
    const decl = resolve(dependency.symbol as SymbolId);
    return { declaration: store.intern(decl), dependencies: calls(decl, policy).map(symbol => ({ symbol, declaration: store.intern(resolve(symbol)) })) };
  }, limits(policy));
  const declarations = [...environment.values()].sort((a, b) => a.symbol < b.symbol ? -1 : 1);
  if (!declarations.length || declarations.length > policy.maxNodes) throw new RangeError('empty or oversized verification unit');
  const checked = typecheck({ ...context.module, members: [...context.module.members, ...declarations.filter(decl => !initial.includes(decl))] }, { registry: context.registry });
  if (!checked.ok) throw new TypeError(`type/capability/frame checking failed: ${checked.diagnostics.map(item => item.code).join(', ')}`);
  return { policy, manifest, declarations, environment };
}
export function createEvidenceManifest(context: EvidenceContext): ExecutionManifestV1 { return freeze(prepare(context).manifest); }

/** Reject model gaps that can hide mutations or assume facts without obligations. */
function assertModelSupported(decl: Declaration, environment: ReadonlyMap<SymbolId, Declaration>, policy: EvidencePolicy): void {
  if (!decl.body || decl.contract?.kind !== 'Contract') throw new TypeError('verification requires a body and explicit frame contract');
  const labels = new Set<string>();
  const checkType = (ty: Ty, nested = false): void => {
    if (ty.t === 'Nominal') return checkType(ty.repr, nested);
    if (ty.t === 'Owned') throw new TypeError('unsupported proof assumption: Owned exclusivity is not enforced by local runtime');
    if (ty.t === 'Record') {
      if (nested) throw new TypeError('unsupported proof assumption: nested heap aliasing is not modeled');
      for (const [, field] of ty.fields) checkType(field, true);
    }
    if (['Fn', 'Task', 'Seq', 'Result', 'IntN', 'TypeVar'].includes(ty.t)) throw new TypeError(`unsupported verifier state model: ${ty.t}`);
  };
  for (const param of decl.params) checkType(param.ty);
  checkType(decl.returns);
  walk(decl, node => {
    if (node.kind === 'Clause' || node.kind === 'Assert') {
      if (labels.has(node.label)) throw new TypeError('duplicate obligation label');
      labels.add(node.label);
    }
    if (node.kind === 'Let') checkType(node.ty);
    if (['Lambda', 'Apply', 'Spawn', 'Await', 'SeqMap', 'SeqFold', 'MatchResult', 'RecordLit', 'SeqLit', 'SeqIndex', 'SeqLength', 'IntCast', 'FixedBin', 'ForAll', 'StringOp'].includes(node.kind)) {
      throw new TypeError(`unsupported verifier expression model: ${node.kind}`);
    }
    if (node.kind === 'While') {
      if (node.invariants.some(item => item.kind === 'Clause')) throw new TypeError('loop invariants must be boolean expressions with formal obligations');
      walk(node.body, child => {
        if (child.kind === 'Call') {
          const contract = environment.get(child.callee)?.contract;
          if (contract?.kind !== 'Contract' || contract.modifies.length) throw new TypeError('unsupported loop model: callee mutations are not included in havoc');
        }
      }, policy);
    }
  }, policy);
  // The verifier intentionally shortens IDs in SMT variable names. Never let distinct
  // bindings collapse onto that representation (including external callee bindings).
  const prefixes = new Map<string, SymbolId>();
  for (const member of environment.values()) walk(member, node => {
    const symbols = node.kind === 'FunctionDecl' ? node.params.map(param => param.symbol) : node.kind === 'Let' ? [node.symbol] : [];
    for (const symbol of symbols) {
      const prefix = symbol.slice(4, 10), previous = prefixes.get(prefix);
      if (previous !== undefined && previous !== symbol) throw new TypeError('ambiguous verifier symbol prefix');
      prefixes.set(prefix, symbol);
    }
  }, policy);
}
function wire(report: VerificationReport): WireReport {
  if (!report.symbol) throw new TypeError('report missing declaration symbol');
  return {
    symbol: report.symbol, subject: report.subject, dependencies: report.dependencies, verdict: report.verdict,
    results: report.results.map((result, index) => ({
      id: `${report.symbol}/${index}`, kind: result.obligation.kind, label: result.obligation.label,
      rigor: result.obligation.rigor, path: result.obligation.path, callee: result.obligation.callee ?? null,
      clause: result.obligation.clause ?? null, smtLib: result.smtLib, verdict: result.verdict,
      solverStatus: result.solver?.status ?? null, abstractedTerms: result.solver?.abstractedTerms ?? null,
    })),
    assumptions: report.assumptions, frameViolations: report.frameViolations, budgetExhausted: report.budgetExhausted,
    pathsExplored: report.pathsExplored, unprovenFormalContracts: report.unprovenFormalContracts, delegatedToFuzzing: report.delegatedToFuzzing,
  };
}
function obligations(reports: readonly WireReport[]) {
  return reports.map(report => ({ symbol: report.symbol, subject: report.subject, dependencies: report.dependencies,
    results: report.results.map(({ verdict: _verdict, solverStatus: _solver, abstractedTerms: _abstracted, ...obligation }) => obligation),
  }));
}
function checkCoverage(decl: Declaration, report: VerificationReport, environment: ReadonlyMap<SymbolId, Declaration>, policy: EvidencePolicy): void {
  if (report.pathsExplored < 1 || report.pathsExplored > policy.maxPaths || report.unprovenFormalContracts.includes('path exploration truncated')) throw new TypeError('incomplete path exploration');
  if (report.assumptions.length || report.frameViolations.length) throw new TypeError('undeclared modeling assumptions or frame violations');
  const results = report.results;
  if (decl.contract?.kind === 'Contract') for (const clause of decl.contract.ensures) {
    if (clause.kind !== 'Clause' || results.filter(item => item.obligation.kind === 'postcondition' && item.obligation.clause === clause.label).length !== report.pathsExplored) throw new TypeError('missing postcondition coverage');
  }
  walk(decl.body!, node => {
    if (node.kind === 'Assert' && !results.some(item => item.obligation.kind === 'assertion' && item.obligation.label === node.label)) throw new TypeError('missing assertion coverage');
    if (node.kind === 'Call') {
      const contract = environment.get(node.callee)?.contract;
      if (contract?.kind !== 'Contract') throw new TypeError('unchecked callee contract');
      for (const clause of contract.requires) if (clause.kind !== 'Clause' || !results.some(item => item.obligation.kind === 'precondition_at_call' && item.obligation.callee === node.callee && item.obligation.clause === clause.label)) throw new TypeError('unchecked caller precondition');
    }
    if (node.kind === 'While') for (const kind of ['invariant_on_entry', 'invariant_preserved', 'variant_decreases', 'variant_bounded']) {
      if (!results.some(item => item.obligation.kind === kind)) throw new TypeError('missing loop proof obligation');
    }
  }, policy);
}
function expectedReports(prepared: ReturnType<typeof prepare>): VerificationReport[] {
  return prepared.declarations.map(decl => {
    assertModelSupported(decl, prepared.environment, prepared.policy);
    const report = verifyFunction(decl, { environment: prepared.environment, budgetMs: 0, maxPaths: prepared.policy.maxPaths });
    checkCoverage(decl, report, prepared.environment, prepared.policy);
    return report;
  });
}
function validResult(report: VerificationReport, policy: EvidencePolicy): void {
  if (report.budgetExhausted || report.verdict === 'unproven' || report.verdict === 'refuted' || report.unprovenFormalContracts.length) throw new TypeError('verification refuted, incomplete or timed out');
  for (const result of report.results) {
    if (result.obligation.rigor === 'formal') {
      if (result.verdict !== 'proved' || result.solver?.status !== 'unsat' || result.solver.abstractedTerms !== 0) throw new TypeError('formal obligation lacks complete local solver evidence');
    } else if (policy.requireFormal || result.verdict !== 'delegated') throw new TypeError('property evidence cannot satisfy formal-required policy');
  }
}
function run(prepared: ReturnType<typeof prepare>, expected: readonly VerificationReport[]): VerificationReport[] {
  const start = Date.now();
  const reports = prepared.declarations.map(decl => {
    const remaining = prepared.policy.budgetMs - (Date.now() - start);
    if (remaining <= 0) throw new TypeError('verification total budget exhausted');
    const report = verifyFunction(decl, { environment: prepared.environment, budgetMs: remaining, maxPaths: prepared.policy.maxPaths,
      ...(prepared.policy.format === 'aether.evidence-policy/2' ? { solverProfile: prepared.policy.solverProfile } : {}) });
    checkCoverage(decl, report, prepared.environment, prepared.policy); validResult(report, prepared.policy);
    return report;
  });
  if (Date.now() - start > prepared.policy.budgetMs) throw new TypeError('verification total budget exhausted');
  if (!same(obligations(reports.map(wire)), obligations(expected.map(wire)), prepared.policy)) throw new TypeError('verification obligation set changed');
  return reports;
}
function trust(manifest: ExecutionManifestV1, reports: readonly VerificationReport[], provenance: VettedEvidence['provenance']): VettedEvidence {
  const manifestDigest = executionManifestDigest(manifest);
  for (const report of reports) { freeze(report); vettedReports.set(report, manifestDigest); }
  const entries = reports.map(report => [report.symbol!, report] as const);
  const evidence = Object.freeze({ manifest: freeze(manifest), manifestDigest, reports: new Map(entries), provenance });
  vettedObjects.set(evidence, { manifestDigest, reports: new Map(entries) });
  return evidence;
}
export function mintLocalEvidence(context: EvidenceContext): LocalEvidenceV1 {
  const prepared = prepare(context), expected = expectedReports(prepared);
  const reports = run(prepared, expected), encoded = reports.map(wire);
  const evidence: LocalEvidenceV1 = freeze({
    manifest: prepared.manifest, reports: encoded,
    envelope: {
      format: 'aether.evidence/1', executionManifest: executionManifestDigest(prepared.manifest),
      obligationSetDigest: domainDigest('aether.obligations/1', obligations(encoded), limits(prepared.policy)),
      assumptionsDigest: domainDigest('aether.assumptions/1', encoded.map(report => ({ symbol: report.symbol, assumptions: report.assumptions })), limits(prepared.policy)),
      evidenceKind: 'local_solver', checker: { id: 'aether.local-verifier', version: prepared.policy.format === 'aether.evidence-policy/2' ? '2' : '1', semanticsVersion: context.semanticsVersion },
      evidenceDigest: domainDigest('aether.evidence-payload/1', encoded, limits(prepared.policy)),
      limits: { bytes: prepared.policy.maxBytes, steps: prepared.policy.maxNodes, depth: prepared.policy.maxDepth },
    },
  });
  encodeCanonical(evidence, limits(prepared.policy));
  minted.set(evidence, trust(prepared.manifest, reports, 'trusted_local'));
  return evidence;
}
/** A received JSON report is only a claim. Recompute its subject/obligations and rerun the verifier. */
export function validateEvidence(value: unknown, context: EvidenceContext): VettedEvidence {
  const policy = policyFor(context);
  encodeCanonical(value, limits(policy)); // resource/schema gate before symbolic work
  const container = exactObject(value, ['envelope', 'manifest', 'reports']);
  const envelope = exactObject(container.envelope, ['format', 'executionManifest', 'obligationSetDigest', 'assumptionsDigest', 'evidenceKind', 'checker', 'evidenceDigest', 'limits']);
  if (envelope.format !== 'aether.evidence/1') throw new TypeError('unsupported evidence envelope');
  for (const key of ['executionManifest', 'obligationSetDigest', 'assumptionsDigest', 'evidenceDigest']) validateDigest(envelope[key]);
  const checker = exactObject(envelope.checker, ['id', 'version', 'semanticsVersion']);
  identifier(checker.id); identifier(checker.version); identifier(checker.semanticsVersion);
  if (checker.id !== 'aether.local-verifier' || checker.version !== (policy.format === 'aether.evidence-policy/2' ? '2' : '1') || checker.semanticsVersion !== context.semanticsVersion) throw new TypeError('unsupported evidence checker');
  if (envelope.evidenceKind !== 'local_solver') throw new TypeError(envelope.evidenceKind === 'property_campaign' ? 'property evidence cannot authorize formal proof elision' : 'portable certificate checker is not implemented');
  const resources = exactObject(envelope.limits, ['bytes', 'steps', 'depth']);
  if (!same(resources, { bytes: policy.maxBytes, steps: policy.maxNodes, depth: policy.maxDepth }, policy)) throw new TypeError('evidence resource policy mismatch');
  validateExecutionManifest(container.manifest, limits(policy));
  const prepared = prepare(context);
  if (!same(container.manifest, prepared.manifest, policy) || envelope.executionManifest !== executionManifestDigest(prepared.manifest)) throw new TypeError('stale evidence execution manifest');
  if (!Array.isArray(container.reports)) throw new TypeError('invalid evidence reports');
  const seen = new Set<string>();
  for (const item of container.reports) {
    const report = exactObject(item, ['symbol', 'subject', 'dependencies', 'verdict', 'results', 'assumptions', 'frameViolations', 'budgetExhausted', 'pathsExplored', 'unprovenFormalContracts', 'delegatedToFuzzing']);
    identifier(report.symbol); validateDigest(report.subject);
    if (seen.has(report.symbol)) throw new TypeError('duplicate evidence report');
    seen.add(report.symbol);
    if (!Array.isArray(report.results) || !Array.isArray(report.assumptions) || report.assumptions.length || !Array.isArray(report.frameViolations) || report.frameViolations.length || report.budgetExhausted !== false) throw new TypeError('missing frame checks, undeclared assumptions or incomplete verification');
    if (!['proved', 'delegated'].includes(report.verdict as string) || !Number.isSafeInteger(report.pathsExplored) || (report.pathsExplored as number) < 1
      || !Array.isArray(report.unprovenFormalContracts) || report.unprovenFormalContracts.length
      || !Array.isArray(report.delegatedToFuzzing) || report.delegatedToFuzzing.some(item => typeof item !== 'string')
      || !Array.isArray(report.dependencies)) throw new TypeError('malformed or incomplete report summary');
    for (const value of report.dependencies) {
      const dependency = exactObject(value, ['symbol', 'subject']); identifier(dependency.symbol); validateDigest(dependency.subject, 'ast');
    }
    const ids = new Set<string>();
    for (const result of report.results) {
      const row = exactObject(result, ['id', 'kind', 'label', 'rigor', 'path', 'callee', 'clause', 'smtLib', 'verdict', 'solverStatus', 'abstractedTerms']);
      identifier(row.id);
      if (ids.has(row.id)) throw new TypeError('duplicate evidence obligation');
      ids.add(row.id);
      if (!['formal', 'property'].includes(row.rigor as string) || !['proved', 'delegated'].includes(row.verdict as string)
        || !Array.isArray(row.path) || row.path.some(item => typeof item !== 'string') || typeof row.smtLib !== 'string'
        || typeof row.kind !== 'string' || typeof row.label !== 'string' || (row.callee !== null && typeof row.callee !== 'string')
        || (row.clause !== null && typeof row.clause !== 'string')) throw new TypeError('malformed obligation claim');
      if (row.rigor === 'formal' && (row.verdict !== 'proved' || row.solverStatus !== 'unsat' || row.abstractedTerms !== 0)) throw new TypeError('unproven formal evidence claim');
      if (row.rigor === 'property' && (policy.requireFormal || row.verdict !== 'delegated')) throw new TypeError('property evidence cannot satisfy formal-required policy');
    }
  }
  const reports = container.reports as unknown as readonly WireReport[];
  if (envelope.evidenceDigest !== domainDigest('aether.evidence-payload/1', reports, limits(policy))) throw new TypeError('evidence payload digest mismatch');
  if (envelope.assumptionsDigest !== domainDigest('aether.assumptions/1', reports.map(report => ({ symbol: report.symbol, assumptions: report.assumptions })), limits(policy))) throw new TypeError('evidence assumptions mismatch');
  const expected = expectedReports(prepared);
  for (let index = 0; index < reports.length; index++) {
    const report = reports[index], expectedReport = expected[index];
    if (!expectedReport || report.pathsExplored !== expectedReport.pathsExplored) throw new TypeError('truncated path coverage');
    const delegated = report.results.filter(result => result.rigor === 'property').map(result => result.label);
    if (!same(report.delegatedToFuzzing, delegated, policy) || report.verdict !== (delegated.length ? 'delegated' : 'proved')) throw new TypeError('inconsistent evidence verdict');
  }
  const expectedObligations = obligations(expected.map(wire));
  if (!same(obligations(reports), expectedObligations, policy) || envelope.obligationSetDigest !== domainDigest('aether.obligations/1', expectedObligations, limits(policy))) throw new TypeError('missing, truncated or changed obligation set');
  const trusted = minted.get(value as object);
  if (trusted) return trust(trusted.manifest, [...trusted.reports.values()], 'trusted_local');
  return trust(prepared.manifest, run(prepared, expected), 'reverified_peer');
}
