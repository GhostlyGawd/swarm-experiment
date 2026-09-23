/** Bounded semantic cleanup proposals. Rewrites remain candidates until the
 * existing strict-lineage governor coordinator commits their deployment.
 *
 * This profile handles unreachable private FunctionDecls and monomorphic pure
 * Int/Bool tail-forwarders with empty frame contracts. The trusted export
 * allowlist must match the application's actual externally callable surface.
 *
 * Remaining FR-1.5 coverage: dead-branch simplification, general obsolete-shim
 * recognition and external third-party adapter/import retirement. Removing an
 * unreachable effectful FunctionDecl is not evidence of adapter-registration
 * cleanup. No general inlining or active-frame rewrite is claimed. Retention is
 * conservative and nonexpiring, so this does not reclaim protected history.
 * This bounded foundation does not by itself complete V4-T1-05.
 */
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { encodeCanonical, decodeCanonical, exactObject, identifier } from '../fabric/encoding.ts';
import { domainDigest, executionManifestDigest, validateDigest, validateExecutionManifest, type Digest, type ExecutionManifestV1 } from '../fabric/identity.ts';
import { JournalLock } from '../fabric/journal-lock.ts';
import { PromotionCoordinator, type PromotionDriver, type PromotionBindingV1, type PromotionInput } from '../fabric/promotion.ts';
import { CapabilityRegistry } from '../tier2/ocap.ts';
import { typecheck } from '../tier2/typecheck.ts';
import { generatePortableCertificate } from '../tier2/portable-proof-producer.ts';
import { checkPortableCertificate, type PortableCertificateV1 } from '../tier2/portable-proof-checker.ts';
import { CausalLineageLedger } from './causal-lineage.ts';
import { DurableGraphStore, type DurableCollectionResult } from './durable-store.ts';
import { GraphStore } from './store.ts';
import { children, linkGroups, withLinkGroups, type Term, type Ty } from './ast.ts';
import { SymbolSpace } from './symbols.ts';
import type { NodeRef, SymbolId } from './ids.ts';
import { atomicWrite } from './persistence.ts';
import * as b from './build.ts';

export const SEMANTIC_GC_PROFILE = 'aether.semantic-gc-closed-forwarders/1';
type FunctionDecl = Extract<Term, { kind: 'FunctionDecl' }>;
type Module = Extract<Term, { kind: 'Module' }>;
export type SemanticRetentionKind = 'audit' | 'replay' | 'active-task' | 'unstable-replication';
export interface SemanticRetention { readonly kind: SemanticRetentionKind; readonly reference: string; readonly root: NodeRef }
export interface SemanticGcPolicy { readonly epoch: string; readonly exports: readonly SymbolId[]; readonly protectedSymbols: readonly SymbolId[] }
export interface SemanticGcOptions {
  readonly directory: string; readonly repositoryId: string; readonly store: DurableGraphStore; readonly lineage: CausalLineageLedger;
  readonly registry: CapabilityRegistry; readonly policy: SemanticGcPolicy;
  readonly maxDeclarations?: number; readonly maxAstNodes?: number; readonly maxRecords?: number;
}
interface Wrapper { readonly symbol: SymbolId; readonly target: SymbolId }
interface RewritePlan { readonly removed: readonly SymbolId[]; readonly collapsed: readonly Wrapper[]; readonly target: Module }
interface EquivalenceWitness { readonly wrapper: SymbolId; readonly root: NodeRef; readonly specification: string; readonly manifest: ExecutionManifestV1; readonly certificate: PortableCertificateV1 }
export interface SemanticGcProposal {
  readonly format: 'aether.semantic-gc-proposal/1'; readonly configuration: Digest; readonly profile: typeof SEMANTIC_GC_PROFILE;
  readonly direction: 'cleanup' | 'rollback'; readonly rollbackOf: Digest | null; readonly sourceManifest: ExecutionManifestV1;
  readonly specification: string; readonly productionAuthorized: false;
  readonly sourceRoot: NodeRef; readonly targetRoot: NodeRef; readonly exports: readonly SymbolId[];
  readonly removed: readonly SymbolId[]; readonly collapsed: readonly Wrapper[]; readonly witnesses: readonly EquivalenceWitness[];
  readonly obligationDigest: Digest; readonly id: Digest;
}
const WIRE_LIMITS = { maxFrameBytes: 16 * 1024 * 1024, maxDecompressedBytes: 16 * 1024 * 1024, maxObjects: 500000, maxDepth: 64 };
function clone<T>(value: T): T { return decodeCanonical(encodeCanonical(value, WIRE_LIMITS), WIRE_LIMITS) as T; }
function freeze<T>(value: T): T { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
function same(a: unknown, z: unknown): boolean { return Buffer.from(encodeCanonical(a, WIRE_LIMITS)).equals(Buffer.from(encodeCanonical(z, WIRE_LIMITS))); }
function durableDirectory(path: string): void {
  if (existsSync(path)) { if (!statSync(path).isDirectory()) throw new Error('semantic GC path is not a directory'); return; }
  const parent = dirname(path); if (parent !== path) durableDirectory(parent);
  try { mkdirSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  for (const directory of [parent, path]) { const fd = openSync(directory, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } }
}
function write(path: string, value: unknown): void { atomicWrite(path, Buffer.from(encodeCanonical(value, WIRE_LIMITS)).toString()); const fd = openSync(dirname(path), 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } }
function returnExpression(decl: FunctionDecl): Term {
  let body = decl.body; if (body?.kind === 'Block' && body.stmts.length === 1) body = body.stmts[0];
  if (body?.kind !== 'Return') throw new Error(`unsupported scalar return body: ${decl.symbol}`); return body.value;
}
function emptyContract(term: Term | null): boolean { return term === null || term.kind === 'Contract' && term.requires.length === 0 && term.modifies.length === 0 && term.ensures.length === 0; }
function scalar(ty: Ty): boolean { return ty.t === 'Int' || ty.t === 'Bool'; }
function shape(decl: FunctionDecl) { return { typeParams: decl.typeParams, params: decl.params.map(param => param.ty), returns: decl.returns, capabilities: decl.capabilities, purity: decl.purity }; }
function witnessManifest(root: NodeRef, specification: string, obligation: Digest): ExecutionManifestV1 {
  const d = (part: string) => domainDigest('aether.semantic-gc-proof-context/1', { profile: SEMANTIC_GC_PROFILE, obligation, part });
  return { format: 'aether.execution/1', astRoot: root, specRoot: domainDigest('aether.specification/1', specification), dependencies: [], semanticsVersion: 'aether-reference/1', compilerDigest: d('witness-derivation'), target: { abiVersion: 'semantic-gc-equivalence/1', profileDigest: d('portable-scalar-profile'), artifactDigest: d('witness') }, capabilityPolicyDigest: d('no-effects'), evidencePolicyDigest: d('portable-ast-kernel') };
}

/** Fixed export/protection policy is part of the persisted configuration. Changing
 * that trusted policy requires a new workspace; it cannot race a prepared rewrite. */
export class SemanticGarbageCollector {
  private readonly options: SemanticGcOptions;
  private readonly registry: CapabilityRegistry;
  private readonly policy: SemanticGcPolicy;
  private readonly configuration: Digest;
  private readonly lock: JournalLock;
  private readonly maxDeclarations: number;
  private readonly maxAstNodes: number;
  private readonly maxRecords: number;
  private readonly builderLease: string;
  constructor(options: SemanticGcOptions) {
    this.options = { ...options }; identifier(options.repositoryId);
    this.policy = freeze(clone(options.policy)); exactObject(this.policy, ['epoch', 'exports', 'protectedSymbols']); identifier(this.policy.epoch);
    for (const values of [this.policy.exports, this.policy.protectedSymbols]) { if (!Array.isArray(values) || new Set(values).size !== values.length) throw new Error('invalid semantic GC symbol policy'); values.forEach(identifier); }
    if (!this.policy.exports.length) throw new Error('semantic GC requires a nonempty trusted export allowlist');
    this.registry = new CapabilityRegistry(); for (const name of options.registry.names) this.registry.define(clone(options.registry.get(name)!));
    this.maxDeclarations = options.maxDeclarations ?? 128; this.maxAstNodes = options.maxAstNodes ?? 4096; this.maxRecords = options.maxRecords ?? 1000;
    for (const [limit, maximum] of [[this.maxDeclarations, 128], [this.maxAstNodes, 10000], [this.maxRecords, 10000]]) if (!Number.isSafeInteger(limit) || limit < 1 || limit > maximum) throw new RangeError('semantic GC resource profile');
    const profile = { format: SEMANTIC_GC_PROFILE, repositoryId: options.repositoryId, policy: this.policy, registry: [...this.registry.names].sort().map(name => this.registry.get(name)!), maxDeclarations: this.maxDeclarations, maxAstNodes: this.maxAstNodes, maxRecords: this.maxRecords };
    this.configuration = domainDigest('aether.semantic-gc-config/1', profile); this.builderLease = `semantic-gc-builder:${this.configuration}`;
    durableDirectory(options.directory); durableDirectory(join(options.directory, 'proposals')); durableDirectory(join(options.directory, 'retention'));
    this.lock = new JournalLock({ directory: join(options.directory, 'lock'), domain: 'aether.semantic-gc', maxTickets: 100000 });
    this.lock.run(() => {
      const path = join(options.directory, 'profile.json');
      if (!existsSync(path)) { if (this.files('proposals').length || this.files('retention').length) throw new Error('missing initialized semantic GC profile'); write(path, profile); }
      else if (!same(this.read(path), profile)) throw new Error('semantic GC configuration changed; use a distinct workspace');
      for (const record of this.retentions()) this.options.store.retain(this.retentionLease(record), [record.root]);
    }, 5000);
  }
  private files(directory: 'proposals' | 'retention'): string[] { const files = readdirSync(join(this.options.directory, directory)).filter(name => !name.startsWith('.')); if (files.length > this.maxRecords || files.some(name => !/^[0-9a-f]{64}\.json$/.test(name))) throw new Error('semantic GC journal capacity/schema'); return files.sort(); }
  private read(path: string): unknown { if (statSync(path).size > WIRE_LIMITS.maxFrameBytes) throw new Error('semantic GC record size limit'); return decodeCanonical(readFileSync(path), WIRE_LIMITS); }
  private path(directory: 'proposals' | 'retention', id: Digest): string { validateDigest(id); return join(this.options.directory, directory, `${id.split(':').at(-1)}.json`); }
  private immutable(directory: 'proposals' | 'retention', id: Digest, value: unknown): void {
    const path = this.path(directory, id);
    if (existsSync(path)) { if (!same(this.read(path), value)) throw new Error('semantic GC immutable record conflict'); return; }
    if (this.files(directory).length >= this.maxRecords) throw new Error('semantic GC journal capacity reached'); write(path, value);
  }
  private retentionLease(record: SemanticRetention): string { return `semantic-gc-retention:${domainDigest('aether.semantic-retention/1', { configuration: this.configuration, ...record })}`; }
  /** Monotone pins. This profile never infers replay completion, task quiescence,
   * audit expiration or replica causal stability from elapsed time. */
  retain(record: SemanticRetention): void {
    record = clone(record); this.validateRetention(record);
    this.lock.run(() => {
      this.options.store.retain(this.retentionLease(record), [record.root]);
      const id = domainDigest('aether.semantic-retention/1', { configuration: this.configuration, ...record });
      this.immutable('retention', id, { format: 'aether.semantic-retention/1', configuration: this.configuration, record, id });
    }, 5000);
  }
  private validateRetention(record: SemanticRetention): void { exactObject(record, ['kind', 'reference', 'root']); if (!['audit', 'replay', 'active-task', 'unstable-replication'].includes(record.kind)) throw new Error('unknown retention role'); identifier(record.reference); validateDigest(record.root, 'ast'); }
  retentions(): readonly SemanticRetention[] {
    return this.files('retention').map(file => {
      const value = exactObject(this.read(join(this.options.directory, 'retention', file)), ['format', 'configuration', 'record', 'id']); const record = value.record as SemanticRetention; this.validateRetention(record);
      const id = domainDigest('aether.semantic-retention/1', { configuration: this.configuration, ...record });
      if (value.format !== 'aether.semantic-retention/1' || value.configuration !== this.configuration || value.id !== id || file !== `${id.split(':').at(-1)}.json`) throw new Error('corrupt semantic retention'); return clone(record);
    });
  }
  collect(): DurableCollectionResult {
    return this.lock.run(() => { for (const record of this.retentions()) this.options.store.retain(this.retentionLease(record), [record.root]); return this.options.store.collectGarbage(); }, 5000);
  }
  private declarations(term: Term): Map<SymbolId, FunctionDecl> {
    if (term.kind !== 'Module' || term.symbolTable.kind !== 'SymbolTable') throw new Error('semantic GC requires a complete closed module');
    const functions = new Map<SymbolId, FunctionDecl>(); let nodes = 0;
    const visit = (node: Term, depth: number) => {
      if (++nodes > this.maxAstNodes || depth > 64) throw new Error('semantic GC AST bound');
      if (['Import', 'Lambda', 'Apply', 'Spawn', 'Await', 'SeqMap', 'SeqFold'].includes(node.kind)) throw new Error(`unsupported hidden/dynamic liveness: ${node.kind}`);
      for (const child of children(node)) visit(child, depth + 1);
    };
    visit(term, 0);
    for (const member of term.members) {
      if (member.kind !== 'FunctionDecl' && member.kind !== 'TypeDecl') throw new Error(`unsupported module member: ${member.kind}`);
      if (member.kind === 'FunctionDecl') { if (functions.has(member.symbol) || new Set(member.params.map(param => param.symbol)).size !== member.params.length) throw new Error('duplicate function or parameter identity'); functions.set(member.symbol, member); }
    }
    if (functions.size > this.maxDeclarations) throw new Error('semantic GC declaration bound');
    for (const symbol of [...this.policy.exports, ...this.policy.protectedSymbols]) if (!functions.has(symbol)) throw new Error('missing exported/protected function');
    const checked = typecheck(term, { registry: this.registry }); if (!checked.ok) throw new Error('semantic GC rejects ill-typed source or candidate');
    for (const decl of functions.values()) for (const target of this.calls(decl)) if (!functions.has(target)) throw new Error('unresolved external call in closed module');
    return functions;
  }
  private calls(term: Term): Set<SymbolId> { const found = new Set<SymbolId>(), pending = [term]; while (pending.length) { const node = pending.pop()!; if (node.kind === 'Call') found.add(node.callee); pending.push(...children(node)); } return found; }
  private live(functions: Map<SymbolId, FunctionDecl>, fences: ReadonlySet<SymbolId>): Set<SymbolId> {
    // Nonempty contracts/surfaces and signed fences are protection roots even when the
    // function is absent from the trusted application entry-point allowlist.
    const pending = [...this.policy.exports, ...this.policy.protectedSymbols, ...fences, ...[...functions.values()].filter(decl => !emptyContract(decl.contract) || decl.surfaces.length).map(decl => decl.symbol)], result = new Set<SymbolId>();
    while (pending.length) { const symbol = pending.pop()!; if (result.has(symbol)) continue; const decl = functions.get(symbol); if (!decl) throw new Error('missing static dependency'); result.add(symbol); pending.push(...this.calls(decl)); } return result;
  }
  private rewrite(source: Module, fences: ReadonlySet<SymbolId>): RewritePlan {
    const functions = this.declarations(source), wrappers = new Map<SymbolId, SymbolId>();
    for (const decl of functions.values()) {
      if (this.policy.exports.includes(decl.symbol) || this.policy.protectedSymbols.includes(decl.symbol) || fences.has(decl.symbol) || !emptyContract(decl.contract) || decl.surfaces.length || decl.purity !== 'pure' || decl.capabilities.length || decl.typeParams.length || !scalar(decl.returns) || decl.params.some(param => !scalar(param.ty))) continue;
      let expression: Term; try { expression = returnExpression(decl); } catch { continue; }
      if (expression.kind !== 'Call' || expression.callee === decl.symbol || expression.args.length !== decl.params.length || expression.args.some((arg, index) => arg.kind !== 'Var' || arg.symbol !== decl.params[index].symbol)) continue;
      const target = functions.get(expression.callee)!; if (!same(shape(decl), shape(target))) continue;
      wrappers.set(decl.symbol, target.symbol);
    }
    const resolve = (symbol: SymbolId): SymbolId => { const visited = new Set<SymbolId>(); while (wrappers.has(symbol)) { if (visited.has(symbol)) throw new Error('recursive forwarding wrapper is unsupported'); visited.add(symbol); symbol = wrappers.get(symbol)!; } return symbol; };
    for (const symbol of wrappers.keys()) resolve(symbol);
    const replaceCalls = (term: Term): Term => {
      const groups = new Map(linkGroups(term).map(group => [group.field, group.links.map(replaceCalls)]));
      const copied = withLinkGroups(term, groups); return copied.kind === 'Call' ? { ...copied, callee: resolve(copied.callee) } : copied;
    };
    const rewritten = new Map([...functions].map(([symbol, decl]) => [symbol, { ...decl, body: decl.body ? replaceCalls(decl.body) : null }]));
    const live = this.live(rewritten, fences), priorLive = this.live(functions, fences);
    const target: Module = { ...source, members: source.members.filter(member => member.kind !== 'FunctionDecl' || live.has(member.symbol)).map(member => member.kind === 'FunctionDecl' ? rewritten.get(member.symbol)! : member) };
    this.declarations(target);
    return { target, removed: [...functions.keys()].filter(symbol => !live.has(symbol)).sort(), collapsed: [...wrappers].filter(([symbol]) => priorLive.has(symbol)).map(([symbol]) => ({ symbol, target: resolve(symbol) })).sort((a, z) => a.symbol.localeCompare(z.symbol)) };
  }
  private expand(term: Term, environment: ReadonlyMap<SymbolId, Term>, functions: ReadonlyMap<SymbolId, FunctionDecl>, active: readonly SymbolId[] = [], budget = { left: this.maxAstNodes }): Term {
    if (--budget.left < 0 || active.length > 32) throw new Error('equivalence expansion resource bound');
    switch (term.kind) {
      case 'Lit': if (!scalar(term.ty)) throw new Error('unsupported non-scalar equivalence literal'); return term;
      case 'Var': { const value = environment.get(term.symbol); if (!value) throw new Error('unbound equivalence variable'); return value; }
      case 'Un': return { ...term, operand: this.expand(term.operand, environment, functions, active, budget) };
      case 'Bin': return { ...term, left: this.expand(term.left, environment, functions, active, budget), right: this.expand(term.right, environment, functions, active, budget) };
      case 'Cond': return { ...term, cond: this.expand(term.cond, environment, functions, active, budget), then: this.expand(term.then, environment, functions, active, budget), otherwise: this.expand(term.otherwise, environment, functions, active, budget) };
      case 'Call': {
        const target = functions.get(term.callee); if (!target || target.purity !== 'pure' || target.capabilities.length || target.typeParams.length || target.params.some(param => !scalar(param.ty)) || !scalar(target.returns) || active.includes(target.symbol)) throw new Error('unsupported equivalence call');
        const args = term.args.map(arg => this.expand(arg, environment, functions, active, budget)); if (args.length !== target.params.length) throw new Error('equivalence arity mismatch');
        return this.expand(returnExpression(target), new Map(target.params.map((param, index) => [param.symbol, args[index]])), functions, [...active, target.symbol], budget);
      }
      default: throw new Error(`unsupported equivalence expression: ${term.kind}`);
    }
  }
  private obligation(source: ExecutionManifestV1, target: NodeRef, removed: readonly SymbolId[], collapsed: readonly Wrapper[]): Digest { return domainDigest('aether.semantic-gc-obligation/1', { configuration: this.configuration, profile: SEMANTIC_GC_PROFILE, source: source.astRoot, sourceExecution: executionManifestDigest(source), target, exports: this.policy.exports, removed, collapsed }); }
  private harness(source: Module, targetRoot: NodeRef, wrapper: Wrapper, obligation: Digest): { module: Module; specification: string; manifest: ExecutionManifestV1 } {
    const functions = this.declarations(source), decl = functions.get(wrapper.symbol); if (!decl) throw new Error('missing equivalence wrapper');
    const symbols = new SymbolSpace(`semantic-gc:${obligation}:${wrapper.symbol}`), params = decl.params.map((param, index) => b.param(symbols.define(`argument${index}`), param.ty));
    const args = params.map(param => b.v(param.symbol));
    const before = this.expand(b.call(wrapper.symbol, ...args), new Map(params.map(param => [param.symbol, b.v(param.symbol)])), functions);
    const after = this.expand(b.call(wrapper.target, ...args), new Map(params.map(param => [param.symbol, b.v(param.symbol)])), functions);
    const proof = b.fn({ symbol: symbols.define('equivalent'), params, returns: b.Bool, contract: b.contract({ ensures: [b.clause(b.result(), 'forwarder-return-equivalence')] }), body: b.ret(b.eq(before, after)) });
    const module = b.module_({ symbol: symbols.define('equivalenceWitness'), members: [proof], symbolTable: symbols.table() }) as Module;
    const specification = JSON.stringify({ profile: SEMANTIC_GC_PROFILE, obligation, targetRoot, wrapper, claim: 'For all scalar arguments, the transparent forwarder and its unchanged ultimate target return equal values; structural rewrite validation separately preserves call argument order, declarations, contracts and effect sites.' });
    const root = new GraphStore().intern(module); return { module, specification, manifest: witnessManifest(root, specification, obligation) };
  }
  private sourceSpecification(manifest: ExecutionManifestV1): string {
    const digest = executionManifestDigest(manifest);
    for (const lineage of this.options.lineage.lineage(manifest.astRoot as NodeRef)) for (const intent of lineage.ancestry) {
      if (intent.body.executionManifest !== digest || intent.body.subject !== manifest.astRoot) continue;
      try { const text = this.options.lineage.specification(intent.body.parents, intent.body.specifications); if (domainDigest('aether.specification/1', text) === manifest.specRoot) return text; } catch { /* Another current authorization may cover the same artifact. */ }
    }
    throw new Error('no current signed specification for semantic GC source');
  }
  private fenceSymbols(manifest: ExecutionManifestV1, specification: string): ReadonlySet<SymbolId> {
    if (typeof specification !== 'string' || domainDigest('aether.specification/1', specification) !== manifest.specRoot) throw new Error('stale or substituted GC specification');
    const document = exactObject(decodeCanonical(Buffer.from(specification), WIRE_LIMITS), ['format', 'repositoryId', 'specifications']);
    if (document.format !== 'aether.lineage-specification/1' || document.repositoryId !== this.options.repositoryId || !Array.isArray(document.specifications)) throw new Error('unsupported signed GC specification context');
    const result = new Set<SymbolId>();
    for (const item of document.specifications) {
      const spec = exactObject(item, ['id', 'revision', 'text', 'requirements']); if (!Array.isArray(spec.requirements)) throw new Error('invalid signed fence requirements');
      for (const value of spec.requirements) { const requirement = exactObject(value, ['symbol', 'signature', 'requires', 'modifies', 'ensures']); identifier(requirement.symbol); result.add(requirement.symbol as SymbolId); }
    }
    return result;
  }
  propose(sourceManifest: ExecutionManifestV1): SemanticGcProposal | null {
    sourceManifest = clone(sourceManifest); validateExecutionManifest(sourceManifest);
    if (sourceManifest.semanticsVersion !== 'aether-reference/1') throw new Error('unsupported source semantics for GC equivalence');
    return this.lock.run(() => {
      this.options.lineage.assertCurrent(executionManifestDigest(sourceManifest)); this.options.lineage.assertNodeCurrent(executionManifestDigest(sourceManifest), sourceManifest.astRoot as NodeRef);
      const source = this.options.store.hydrate(sourceManifest.astRoot as NodeRef); const functions = this.declarations(source); void functions;
      if (source.kind !== 'Module') throw new Error('expected module'); const specification = this.sourceSpecification(sourceManifest); const plan = this.rewrite(source, this.fenceSymbols(sourceManifest, specification));
      const targetRoot = this.options.store.intern(plan.target, { leaseId: this.builderLease }); if (targetRoot === sourceManifest.astRoot) return null;
      return this.recordProposal(sourceManifest, targetRoot, plan.removed, plan.collapsed, 'cleanup', null, source, specification);
    }, 5000);
  }
  private recordProposal(sourceManifest: ExecutionManifestV1, targetRoot: NodeRef, removed: readonly SymbolId[], collapsed: readonly Wrapper[], direction: 'cleanup' | 'rollback', rollbackOf: Digest | null, witnessSource: Module, specification: string): SemanticGcProposal {
    const sourceRoot = sourceManifest.astRoot as NodeRef, obligationDigest = this.obligation(sourceManifest, targetRoot, removed, collapsed), witnesses: EquivalenceWitness[] = [];
    for (const wrapper of collapsed) {
      const harness = this.harness(witnessSource, targetRoot, wrapper, obligationDigest);
      const certificate = generatePortableCertificate(harness.module, { ...harness, expectedManifest: harness.manifest });
      if (!certificate) throw new Error('unsupported or unproved portable equivalence obligation');
      const root = this.options.store.intern(harness.module, { leaseId: this.builderLease }); witnesses.push({ wrapper: wrapper.symbol, root, specification: harness.specification, manifest: harness.manifest, certificate });
    }
    const body: Omit<SemanticGcProposal, 'id'> = { format: 'aether.semantic-gc-proposal/1' as const, configuration: this.configuration, profile: SEMANTIC_GC_PROFILE, direction, rollbackOf, sourceManifest, specification, productionAuthorized: false, sourceRoot, targetRoot, exports: this.policy.exports, removed, collapsed, witnesses, obligationDigest };
    const proposal: SemanticGcProposal = { ...body, id: domainDigest('aether.semantic-gc-proposal/1', body, WIRE_LIMITS) };
    this.verify(proposal, false);
    this.options.store.retain(`semantic-gc-proposal:${proposal.id}`, [sourceRoot, targetRoot, ...witnesses.map(witness => witness.root)]);
    this.immutable('proposals', proposal.id, proposal); return freeze(clone(proposal));
  }
  readProposal(id: Digest): SemanticGcProposal { validateDigest(id, 'aether.semantic-gc-proposal/1'); const value = this.read(this.path('proposals', id)) as SemanticGcProposal; if (value.id !== id) throw new Error('proposal address mismatch'); this.verify(value, false); return freeze(clone(value)); }
  private verify(proposal: SemanticGcProposal, current: boolean): void {
    encodeCanonical(proposal, WIRE_LIMITS); exactObject(proposal, ['format', 'configuration', 'profile', 'direction', 'rollbackOf', 'sourceManifest', 'specification', 'productionAuthorized', 'sourceRoot', 'targetRoot', 'exports', 'removed', 'collapsed', 'witnesses', 'obligationDigest', 'id']);
    const { id, ...body } = proposal;
    if (proposal.productionAuthorized !== false || proposal.format !== 'aether.semantic-gc-proposal/1' || proposal.profile !== SEMANTIC_GC_PROFILE || proposal.configuration !== this.configuration || id !== domainDigest('aether.semantic-gc-proposal/1', body, WIRE_LIMITS) || !same(proposal.exports, this.policy.exports)) throw new Error('semantic GC proposal identity/profile mismatch');
    validateExecutionManifest(proposal.sourceManifest); if (proposal.sourceManifest.semanticsVersion !== 'aether-reference/1') throw new Error('unsupported source semantics for GC equivalence'); if (proposal.sourceManifest.astRoot !== proposal.sourceRoot) throw new Error('rewrite source manifest mismatch');
    const fences = this.fenceSymbols(proposal.sourceManifest, proposal.specification);
    const source = this.options.store.hydrate(proposal.sourceRoot), target = this.options.store.hydrate(proposal.targetRoot); this.declarations(source); this.declarations(target);
    if (source.kind !== 'Module' || target.kind !== 'Module') throw new Error('rewrite modules required');
    let plan: RewritePlan, witnessSource: Module;
    if (proposal.direction === 'cleanup') { if (proposal.rollbackOf !== null) throw new Error('cleanup has rollback predecessor'); plan = this.rewrite(source, fences); witnessSource = source; if (new GraphStore().intern(plan.target) !== proposal.targetRoot) throw new Error('unsupported or unsafe candidate rewrite'); }
    else if (proposal.direction === 'rollback' && proposal.rollbackOf !== null) {
      const prior = this.read(this.path('proposals', proposal.rollbackOf)) as SemanticGcProposal; if (prior.direction !== 'cleanup') throw new Error('rollback cannot chain another rollback');
      const previous = this.readProposal(proposal.rollbackOf); if (previous.direction !== 'cleanup' || previous.targetRoot !== proposal.sourceRoot || previous.sourceRoot !== proposal.targetRoot) throw new Error('rollback is not the exact inverse cleanup');
      plan = this.rewrite(target, fences); witnessSource = target; if (new GraphStore().intern(plan.target) !== proposal.sourceRoot) throw new Error('rollback proof relation changed');
    } else throw new Error('unsupported rewrite direction');
    if (!same(proposal.removed, plan.removed) || !same(proposal.collapsed, plan.collapsed) || proposal.obligationDigest !== this.obligation(proposal.sourceManifest, proposal.targetRoot, plan.removed, plan.collapsed) || proposal.witnesses.length !== plan.collapsed.length) throw new Error('incomplete rewrite equivalence relation');
    proposal.witnesses.forEach((witness, index) => {
      exactObject(witness, ['wrapper', 'root', 'specification', 'manifest', 'certificate']); const expected = this.harness(witnessSource, proposal.targetRoot, plan.collapsed[index], proposal.obligationDigest);
      if (witness.wrapper !== plan.collapsed[index].symbol || witness.root !== expected.manifest.astRoot || witness.specification !== expected.specification || !same(witness.manifest, expected.manifest) || new GraphStore().intern(this.options.store.hydrate(witness.root)) !== expected.manifest.astRoot) throw new Error('stale or substituted equivalence witness');
      checkPortableCertificate(expected.module, witness.certificate, { expectedManifest: expected.manifest, specification: expected.specification });
    });
    if (current) { this.options.lineage.assertCurrent(executionManifestDigest(proposal.sourceManifest)); this.options.lineage.assertNodeCurrent(executionManifestDigest(proposal.sourceManifest), proposal.sourceRoot); }
  }
  proposeRollback(cleanupId: Digest, currentManifest: ExecutionManifestV1): SemanticGcProposal {
    currentManifest = clone(currentManifest); validateExecutionManifest(currentManifest);
    return this.lock.run(() => {
      const previous = this.readProposal(cleanupId); if (previous.direction !== 'cleanup' || currentManifest.astRoot !== previous.targetRoot) throw new Error('rollback parent is not the cleaned artifact');
      this.options.lineage.assertCurrent(executionManifestDigest(currentManifest)); const original = this.options.store.hydrate(previous.sourceRoot); if (original.kind !== 'Module') throw new Error('rollback source module missing');
      return this.recordProposal(currentManifest, previous.sourceRoot, previous.removed, previous.collapsed, 'rollback', cleanupId, original, this.sourceSpecification(currentManifest));
    }, 5000);
  }
  /** Strict F08 is the only production path. Signed current candidate evidence
   * and governor approval remain independently mandatory. No root is committed here. */
  async promote(id: Digest, input: PromotionInput, coordinator: PromotionCoordinator, driver: PromotionDriver) {
    if (coordinator.admissionProfile !== 'strict-lineage-v1') throw new Error('semantic GC requires strict signed-lineage promotion');
    const proposal = this.readProposal(id); this.verify(proposal, true); this.bind(proposal, input.proposal.expectedParent, input.evidence.manifest);
    this.options.lineage.assertCurrent(executionManifestDigest(input.evidence.manifest));
    return coordinator.promote(input, this.guardedDriver(id, driver));
  }
  guardedDriver(id: Digest, driver: PromotionDriver): PromotionDriver {
    const checked = (binding: PromotionBindingV1, current: boolean) => { const proposal = this.readProposal(id); this.verify(proposal, current); this.bind(proposal, binding.proposal.expectedParent, binding.manifest); return proposal; };
    return {
      prepare: async (binding, evidence) => { checked(binding, true); this.options.lineage.assertCurrent(binding.proposal.candidateManifest); const handle = await driver.prepare(binding, evidence); checked(binding, true); this.options.lineage.assertCurrent(binding.proposal.candidateManifest); return handle; },
      activate: async (binding, handle) => { checked(binding, false); await driver.activate(binding, handle); },
      abort: async (binding, handle) => { checked(binding, false); await driver.abort(binding, handle); },
      recover: async (binding, handle, decision) => { checked(binding, false); await driver.recover(binding, handle, decision); },
    };
  }
  private bind(proposal: SemanticGcProposal, parent: Digest, candidate: ExecutionManifestV1): void {
    validateExecutionManifest(candidate);
    if (parent !== executionManifestDigest(proposal.sourceManifest) || candidate.astRoot !== proposal.targetRoot) throw new Error('production binding does not match proved GC proposal');
    const before = proposal.sourceManifest;
    for (const key of ['semanticsVersion', 'compilerDigest', 'capabilityPolicyDigest', 'evidencePolicyDigest'] as const) if (before[key] !== candidate[key]) throw new Error('semantic GC cannot change execution policy/compiler semantics');
    if (before.target.abiVersion !== candidate.target.abiVersion || before.target.profileDigest !== candidate.target.profileDigest) throw new Error('semantic GC cannot change target profile');
  }
  /** Explicit opt-in scheduling; each immutable candidate is reported once per
   * runner lifetime. Deployment still requires a separate signed promotion. */
  start(options: { intervalMs: number; source: () => ExecutionManifestV1; candidate: (proposal: SemanticGcProposal) => Promise<void> | void; error: (error: unknown) => void }): () => void {
    if (!Number.isSafeInteger(options.intervalMs) || options.intervalMs < 10 || options.intervalMs > 86400000) throw new Error('invalid GC scan interval');
    let stopped = false, timer: ReturnType<typeof setTimeout> | undefined; const reported = new Set<Digest>();
    const tick = async () => { if (stopped) return; try { const proposal = this.propose(options.source()); if (proposal && !reported.has(proposal.id)) { await options.candidate(proposal); reported.add(proposal.id); } if (!stopped) this.collect(); } catch (error) { options.error(error); } finally { if (!stopped) timer = setTimeout(tick, options.intervalMs); } };
    timer = setTimeout(tick, 0); return () => { stopped = true; if (timer) clearTimeout(timer); };
  }
}
