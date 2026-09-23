/** Bounded semantic cleanup proposals. Rewrites remain candidates until the
 * existing strict-lineage governor coordinator commits their deployment.
 *
 * This profile handles unreachable private FunctionDecls and monomorphic pure
 * Int/Bool tail-forwarders with empty frame contracts. An opt-in branch profile
 * also prunes If/Cond arms whose original conditions have portable proofs of
 * total, uniform truth over definitely bound scalar values. It preserves chosen
 * statement scopes, function contracts and loop annotations; it does not infer
 * facts from entry preconditions, local values, heap state or loop invariants.
 * Opt-in scalar-shim V1 coalesces call-free Int/Bool return expressions. V2
 * additionally expands closed, pure, total helper calls before independent
 * equivalence checking, refusing partial arguments that expansion could erase.
 * Both versions change only callee identities, retaining call-site argument
 * expression order/count. Both compared frames are empty.
 * The trusted export allowlist must match the externally callable surface.
 *
 * Remaining FR-1.5 coverage: broader path-dependent/opaque branch reasoning,
 * non-scalar/general shims and third-party registration/import
 * retirement. Removing an
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
export const SEMANTIC_GC_BRANCH_PROFILE = 'aether.semantic-gc-closed-branches/1';
export const SEMANTIC_GC_SHIM_PROFILE = 'aether.semantic-gc-closed-scalar-shims/1';
export const SEMANTIC_GC_CALL_SHIM_PROFILE = 'aether.semantic-gc-closed-scalar-shims/2';
export type SemanticGcProfile = typeof SEMANTIC_GC_PROFILE | typeof SEMANTIC_GC_BRANCH_PROFILE | typeof SEMANTIC_GC_SHIM_PROFILE | typeof SEMANTIC_GC_CALL_SHIM_PROFILE;
const isShimProfile = (profile: SemanticGcProfile): boolean => profile === SEMANTIC_GC_SHIM_PROFILE || profile === SEMANTIC_GC_CALL_SHIM_PROFILE;
type FunctionDecl = Extract<Term, { kind: 'FunctionDecl' }>;
type Module = Extract<Term, { kind: 'Module' }>;
export type SemanticRetentionKind = 'audit' | 'replay' | 'active-task' | 'unstable-replication';
export interface SemanticRetention { readonly kind: SemanticRetentionKind; readonly reference: string; readonly root: NodeRef }
export interface SemanticGcPolicy { readonly epoch: string; readonly exports: readonly SymbolId[]; readonly protectedSymbols: readonly SymbolId[] }
export interface SemanticGcOptions {
  readonly directory: string; readonly repositoryId: string; readonly store: DurableGraphStore; readonly lineage: CausalLineageLedger;
  readonly registry: CapabilityRegistry; readonly policy: SemanticGcPolicy;
  /** Opt in to total-condition pruning or certified scalar-shim coalescing.
   * Existing forwarder and branch journal profiles remain unchanged. */
  readonly profile?: SemanticGcProfile;
  readonly maxBranchProofs?: number;
  readonly maxShimComparisons?: number;
  readonly maxDeclarations?: number; readonly maxAstNodes?: number; readonly maxRecords?: number;
}
interface Wrapper { readonly symbol: SymbolId; readonly target: SymbolId }
interface BranchStep { readonly field: string; readonly index: number }
interface BranchSelection { readonly symbol: SymbolId; readonly path: readonly BranchStep[]; readonly kind: 'If' | 'Cond'; readonly site: NodeRef; readonly condition: NodeRef; readonly value: boolean }
interface BranchLocation { readonly declaration: FunctionDecl; readonly term: Extract<Term, { kind: 'If' | 'Cond' }>; readonly path: readonly BranchStep[]; readonly environment: ReadonlyMap<SymbolId, Ty> }
interface BranchWitness { readonly selection: BranchSelection; readonly root: NodeRef; readonly specification: string; readonly manifest: ExecutionManifestV1; readonly certificate: PortableCertificateV1 }
interface ShimSelection { readonly symbol: SymbolId; readonly target: SymbolId; readonly sourceDeclaration: NodeRef; readonly targetDeclaration: NodeRef }
interface ShimWitness { readonly selection: ShimSelection; readonly root: NodeRef; readonly specification: string; readonly manifest: ExecutionManifestV1; readonly certificate: PortableCertificateV1 }
interface RewritePlan { readonly removed: readonly SymbolId[]; readonly collapsed: readonly Wrapper[]; readonly target: Module }
interface EquivalenceWitness { readonly wrapper: SymbolId; readonly root: NodeRef; readonly specification: string; readonly manifest: ExecutionManifestV1; readonly certificate: PortableCertificateV1 }
export interface SemanticGcProposal {
  readonly format: 'aether.semantic-gc-proposal/1'; readonly configuration: Digest; readonly profile: SemanticGcProfile;
  readonly direction: 'cleanup' | 'rollback'; readonly rollbackOf: Digest | null; readonly sourceManifest: ExecutionManifestV1;
  readonly specification: string; readonly productionAuthorized: false;
  readonly sourceRoot: NodeRef; readonly targetRoot: NodeRef; readonly exports: readonly SymbolId[];
  readonly removed: readonly SymbolId[]; readonly collapsed: readonly Wrapper[]; readonly witnesses: readonly EquivalenceWitness[];
  readonly branches?: readonly BranchWitness[];
  readonly shims?: readonly ShimWitness[];
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
function witnessManifest(root: NodeRef, specification: string, obligation: Digest, profile: SemanticGcProfile = SEMANTIC_GC_PROFILE): ExecutionManifestV1 {
  const d = (part: string) => domainDigest('aether.semantic-gc-proof-context/1', { profile, obligation, part });
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
  readonly profile: SemanticGcProfile;
  private readonly maxBranchProofs: number;
  private readonly maxShimComparisons: number;
  constructor(options: SemanticGcOptions) {
    this.options = { ...options }; identifier(options.repositoryId);
    this.profile = options.profile ?? SEMANTIC_GC_PROFILE;
    if (![SEMANTIC_GC_PROFILE, SEMANTIC_GC_BRANCH_PROFILE, SEMANTIC_GC_SHIM_PROFILE, SEMANTIC_GC_CALL_SHIM_PROFILE].includes(this.profile)) throw new Error('unsupported semantic GC profile');
    this.maxShimComparisons = options.maxShimComparisons ?? 64;
    if (!Number.isSafeInteger(this.maxShimComparisons) || this.maxShimComparisons < 1 || this.maxShimComparisons > 1024 || !isShimProfile(this.profile) && options.maxShimComparisons !== undefined) throw new Error('invalid shim comparison profile');
    this.maxBranchProofs = options.maxBranchProofs ?? 64;
    if (!Number.isSafeInteger(this.maxBranchProofs) || this.maxBranchProofs < 1 || this.maxBranchProofs > 256 || this.profile === SEMANTIC_GC_PROFILE && options.maxBranchProofs !== undefined) throw new Error('invalid branch proof profile');
    this.policy = freeze(clone(options.policy)); exactObject(this.policy, ['epoch', 'exports', 'protectedSymbols']); identifier(this.policy.epoch);
    for (const values of [this.policy.exports, this.policy.protectedSymbols]) { if (!Array.isArray(values) || new Set(values).size !== values.length) throw new Error('invalid semantic GC symbol policy'); values.forEach(identifier); }
    if (!this.policy.exports.length) throw new Error('semantic GC requires a nonempty trusted export allowlist');
    this.registry = new CapabilityRegistry(); for (const name of options.registry.names) this.registry.define(clone(options.registry.get(name)!));
    this.maxDeclarations = options.maxDeclarations ?? 128; this.maxAstNodes = options.maxAstNodes ?? 4096; this.maxRecords = options.maxRecords ?? 1000;
    for (const [limit, maximum] of [[this.maxDeclarations, 128], [this.maxAstNodes, 10000], [this.maxRecords, 10000]]) if (!Number.isSafeInteger(limit) || limit < 1 || limit > maximum) throw new RangeError('semantic GC resource profile');
    const profile = { format: this.profile, repositoryId: options.repositoryId, policy: this.policy, registry: [...this.registry.names].sort().map(name => this.registry.get(name)!), maxDeclarations: this.maxDeclarations, maxAstNodes: this.maxAstNodes, maxRecords: this.maxRecords, ...(this.profile !== SEMANTIC_GC_PROFILE ? { maxBranchProofs: this.maxBranchProofs } : {}), ...(isShimProfile(this.profile) ? { maxShimComparisons: this.maxShimComparisons } : {}) };
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
  private branchKey(selection: Pick<BranchSelection, 'symbol' | 'path'>): string { return JSON.stringify([selection.symbol, selection.path]); }
  private selection(location: BranchLocation, value: boolean): BranchSelection {
    const memory = new GraphStore();
    return { symbol: location.declaration.symbol, path: location.path, kind: location.term.kind, site: memory.intern(location.term), condition: memory.intern(location.term.cond), value };
  }
  /** Track only definitely bound types. No inferred values, entry preconditions,
   * loop invariants or heap facts can discharge a branch condition. */
  private walkBranches(source: Module, choose: (location: BranchLocation) => boolean | null): Module {
    const changed = (term: Term): Set<SymbolId> => { const result = new Set<SymbolId>(), todo = [term]; while (todo.length) { const node = todo.pop()!; if (node.kind === 'Let' || node.kind === 'ForAll') result.add(node.symbol); if (node.kind === 'Assign' && node.target.kind === 'Place' && !node.target.path.length) result.add(node.target.symbol); todo.push(...children(node)); } return result; };
    const visit = (node: Term, environment: Map<SymbolId, Ty>, path: readonly BranchStep[], declaration: FunctionDecl): Term => {
      const child = (term: Term, field: string, index: number, env = environment) => visit(term, env, [...path, { field, index }], declaration);
      if (node.kind === 'Contract' || node.kind === 'Clause' || node.kind === 'FunctionDecl') return node;
      if (node.kind === 'ForAll') { environment.delete(node.symbol); return node; }
      if (node.kind === 'Block') { const inner = new Map(environment); return { ...node, stmts: node.stmts.map((stmt, index) => child(stmt, 'stmts', index, inner)) }; }
      if (node.kind === 'Let') { const init = child(node.init, 'init', 0); environment.set(node.symbol, node.ty); return { ...node, init }; }
      if (node.kind === 'While') {
        const writes = changed(node.body), stable = new Map(environment); for (const symbol of writes) stable.delete(symbol);
        const cond = child(node.cond, 'cond', 0, new Map(stable)), body = child(node.body, 'body', 0, new Map(stable));
        for (const symbol of writes) environment.delete(symbol);
        return { ...node, cond, body }; // Invariant/variant AST identities stay intact.
      }
      if (node.kind === 'If' || node.kind === 'Cond') {
        const location: BranchLocation = { declaration, term: node, path, environment: new Map(environment) }, selected = choose(location);
        if (selected !== null) {
          const chosen = selected ? node.then : node.otherwise;
          return chosen === null ? b.block() : child(chosen, selected ? 'then' : 'otherwise', 0);
        }
        const cond = child(node.cond, 'cond', 0), yes = new Map(environment), no = new Map(environment);
        const then = child(node.then, 'then', 0, yes), otherwise = node.otherwise ? child(node.otherwise, 'otherwise', 0, no) : null;
        if (node.kind === 'If') { environment.clear(); for (const [symbol, ty] of yes) if (no.has(symbol) && same(ty, no.get(symbol))) environment.set(symbol, ty); return { ...node, cond, then, otherwise }; }
        return { ...node, cond, then, otherwise: otherwise! };
      }
      if (node.kind === 'MatchResult') {
        const yes = new Map(environment), no = new Map(environment); yes.delete(node.okSymbol); no.delete(node.errSymbol);
        const value = child(node.value, 'value', 0), ok = child(node.ok, 'ok', 0, yes), err = child(node.err, 'err', 0, no);
        environment.delete(node.okSymbol); environment.delete(node.errSymbol); return { ...node, value, ok, err };
      }
      return withLinkGroups(node, new Map(linkGroups(node).map(group => [group.field, group.links.map((term, index) => child(term, group.field, index))])));
    };
    return { ...source, members: source.members.map(member => member.kind === 'FunctionDecl' && member.body ? { ...member, body: visit(member.body, new Map(member.params.map(param => [param.symbol, param.ty])), [], member) } : member) };
  }
  private applyBranches(source: Module, selections: readonly BranchSelection[]): { module: Module; locations: Map<string, BranchLocation> } {
    const locations = new Map<string, BranchLocation>();
    if (!selections.length) return { module: source, locations };
    if (this.profile === SEMANTIC_GC_PROFILE || selections.length > this.maxBranchProofs) throw new Error('unsupported branch selection profile/count');
    const wanted = new Map<string, BranchSelection>();
    for (const selection of selections) {
      exactObject(selection, ['symbol', 'path', 'kind', 'site', 'condition', 'value']); identifier(selection.symbol); validateDigest(selection.site, 'ast'); validateDigest(selection.condition, 'ast');
      if (!Array.isArray(selection.path) || selection.path.length > 64 || !['If', 'Cond'].includes(selection.kind) || typeof selection.value !== 'boolean') throw new Error('invalid branch selection');
      for (const step of selection.path) { exactObject(step, ['field', 'index']); identifier(step.field); if (!Number.isSafeInteger(step.index) || step.index < 0 || step.index > this.maxAstNodes) throw new Error('invalid branch path'); }
      const key = this.branchKey(selection); if (wanted.has(key)) throw new Error('duplicate branch selection'); wanted.set(key, selection);
    }
    const observed: BranchSelection[] = [];
    const module = this.walkBranches(source, location => {
      const key = this.branchKey({ symbol: location.declaration.symbol, path: location.path }), selection = wanted.get(key); if (!selection) return null;
      if (!same(this.selection(location, selection.value), selection)) throw new Error('branch selection does not match exact source site');
      locations.set(key, location); observed.push(selection); return selection.value;
    });
    if (!same(observed, selections)) throw new Error('missing, unreachable or reordered branch selection');
    return { module, locations };
  }
  private branchHarness(source: Module, location: BranchLocation, selection: BranchSelection, targetRoot: NodeRef, obligation: Digest): { module: Module; specification: string; manifest: ExecutionManifestV1 } {
    if (!location || !same(this.selection(location, selection.value), selection)) throw new Error('missing branch condition source');
    // Ambiguous rebinding types are excluded even across nested lexical scopes.
    // This also prevents depending on accidental host-frame slot reuse.
    const bindings = new Map<SymbolId, Ty>(), ambiguous = new Set<SymbolId>();
    const bind = (symbol: SymbolId, ty: Ty) => { if (bindings.has(symbol) && !same(bindings.get(symbol), ty)) ambiguous.add(symbol); bindings.set(symbol, ty); };
    location.declaration.params.forEach(param => bind(param.symbol, param.ty));
    const todo = [location.declaration.body!]; while (todo.length) { const node = todo.pop()!; if (node.kind === 'Let') bind(node.symbol, node.ty); if (node.kind === 'ForAll') bind(node.symbol, b.Int); if (node.kind === 'MatchResult') { ambiguous.add(node.okSymbol); ambiguous.add(node.errSymbol); } todo.push(...children(node)); }
    const variables = new Set<SymbolId>(); let remaining = 256;
    const inspect = (term: Term): void => {
      if (--remaining < 0) throw new Error('branch condition expression bound');
      if (term.kind === 'Var' || term.kind === 'Place' && !term.path.length) { const ty = location.environment.get(term.symbol); if (!ty || !scalar(ty) || ambiguous.has(term.symbol)) throw new Error('branch variable is not definitely bound with a scalar type'); variables.add(term.symbol); return; }
      if (term.kind === 'Lit') { if (!scalar(term.ty)) throw new Error('unsupported branch literal'); return; }
      if (term.kind === 'Un' && ['neg', 'not'].includes(term.op)) { inspect(term.operand); return; }
      if (term.kind === 'Bin' && term.op !== 'concat') { inspect(term.left); inspect(term.right); return; }
      if (term.kind === 'Cond') { inspect(term.cond); inspect(term.then); inspect(term.otherwise); return; }
      throw new Error(`unsupported or effectful branch condition: ${term.kind}`);
    };
    inspect(location.term.cond);
    const selectionDigest = domainDigest('aether.semantic-gc-branch/1', selection), symbols = new SymbolSpace(`semantic-gc-branch:${obligation}:${selectionDigest}`);
    const ordered = [...variables].sort(), params = ordered.map((symbol, index) => b.param(symbols.define(`current${index}`), location.environment.get(symbol)!));
    const names = new Map(ordered.map((symbol, index) => [symbol, params[index].symbol]));
    const substitute = (term: Term): Term => term.kind === 'Var' || term.kind === 'Place' ? b.v(names.get(term.symbol)!) : withLinkGroups(term, new Map(linkGroups(term).map(group => [group.field, group.links.map(substitute)])));
    const condition = substitute(location.term.cond), fn = b.fn({ symbol: symbols.define('constantCondition'), params, returns: b.Bool, contract: b.contract({ ensures: [b.clause(b.eq(b.result(), b.bool(selection.value)), 'total-constant-condition')] }), body: b.ret(condition) });
    const module = b.module_({ symbol: symbols.define('branchWitness'), members: [fn], symbolTable: symbols.table() }) as Module;
    const specification = Buffer.from(encodeCanonical({ profile: this.profile, obligation, sourceRoot: new GraphStore().intern(source), targetRoot, selection, variables: ordered.map((symbol, index) => ({ symbol, parameter: params[index] })), claim: 'For every current value of the definitely initialized scalar bindings, this original condition terminates normally and equals the selected Boolean. Structural checking preserves the selected arm and all contracts; no effectful or opaque condition computation is removed.' }, WIRE_LIMITS)).toString('utf8');
    const root = new GraphStore().intern(module); return { module, specification, manifest: witnessManifest(root, specification, obligation, this.profile) };
  }
  private discoverBranches(source: Module, manifest: ExecutionManifestV1): BranchSelection[] {
    if (this.profile === SEMANTIC_GC_PROFILE) return [];
    const selections: BranchSelection[] = []; let attempted = 0;
    this.walkBranches(source, location => {
      if (attempted++ >= this.maxBranchProofs) return null;
      for (const value of [true, false]) {
        const selection = this.selection(location, value);
        try {
          const probe = domainDigest('aether.semantic-gc-branch-discovery/1', { profile: this.profile, source: executionManifestDigest(manifest), selection });
          const harness = this.branchHarness(source, location, selection, manifest.astRoot as NodeRef, probe);
          if (generatePortableCertificate(harness.module, { ...harness, expectedManifest: harness.manifest })) { selections.push(selection); return value; }
        } catch { /* Unsupported/partial/unknown conditions remain executable. */ }
      }
      return null;
    });
    return selections;
  }
  /** V1 remains call-free. V2 permits only statically expanded closed scalar
   * calls whose helpers have no contract frame, capabilities or surfaces. */
  private shimExpression(declaration: FunctionDecl): Term {
    if (declaration.purity !== 'pure' || declaration.capabilities.length || declaration.typeParams.length || declaration.surfaces.length || declaration.contract?.kind !== 'Contract' || !emptyContract(declaration.contract) || !scalar(declaration.returns) || declaration.params.some(param => !scalar(param.ty))) throw new Error('unsupported pure scalar shim declaration');
    const parameters = new Set(declaration.params.map(param => param.symbol)), expression = returnExpression(declaration); let remaining = this.maxAstNodes;
    const inspect = (node: Term): void => {
      if (--remaining < 0) throw new Error('shim expression resource bound');
      if (node.kind === 'Var' || node.kind === 'Place' && !node.path.length) { if (!parameters.has(node.symbol)) throw new Error('free variable in scalar shim'); return; }
      if (node.kind === 'Lit' && (node.ty.t === 'Int' && typeof node.value === 'bigint' || node.ty.t === 'Bool' && typeof node.value === 'boolean')) return;
      if (node.kind === 'Un' && ['neg', 'not'].includes(node.op)) { inspect(node.operand); return; }
      if (node.kind === 'Bin' && ['add', 'sub', 'mul', 'div', 'mod', 'eq', 'ne', 'lt', 'le', 'gt', 'ge', 'and', 'or'].includes(node.op)) { inspect(node.left); inspect(node.right); return; }
      if (node.kind === 'Cond') { inspect(node.cond); inspect(node.then); inspect(node.otherwise); return; }
      if (this.profile === SEMANTIC_GC_CALL_SHIM_PROFILE && node.kind === 'Call') {
        node.args.forEach(inspect); return;
      }
      throw new Error(`unsupported scalar shim expression: ${node.kind}`);
    };
    inspect(expression); return expression;
  }
  private shimSelection(source: FunctionDecl, target: FunctionDecl): ShimSelection {
    const store = new GraphStore(); return { symbol: source.symbol, target: target.symbol, sourceDeclaration: store.intern(source), targetDeclaration: store.intern(target) };
  }
  /** Expansion can duplicate or discard helper arguments. Require every
   * argument and helper body to be pure and total before making that rewrite;
   * the portable equivalence proof then covers the resulting values. */
  private totalShimExpression(term: Term, functions: ReadonlyMap<SymbolId, FunctionDecl>, active: readonly SymbolId[] = [], budget = { left: this.maxAstNodes }): void {
    if (--budget.left < 0 || active.length > 32) throw new Error('call-bearing shim totality bound');
    if (term.kind === 'Var' || term.kind === 'Place' && !term.path.length
      || term.kind === 'Lit' && (term.ty.t === 'Int' && typeof term.value === 'bigint' || term.ty.t === 'Bool' && typeof term.value === 'boolean')) return;
    if (term.kind === 'Un' && ['neg', 'not'].includes(term.op)) return this.totalShimExpression(term.operand, functions, active, budget);
    if (term.kind === 'Bin' && ['add', 'sub', 'mul', 'eq', 'ne', 'lt', 'le', 'gt', 'ge', 'and', 'or'].includes(term.op)) {
      this.totalShimExpression(term.left, functions, active, budget); this.totalShimExpression(term.right, functions, active, budget); return;
    }
    if (term.kind === 'Cond') {
      this.totalShimExpression(term.cond, functions, active, budget);
      this.totalShimExpression(term.then, functions, active, budget);
      this.totalShimExpression(term.otherwise, functions, active, budget); return;
    }
    if (term.kind === 'Call') {
      const target = functions.get(term.callee);
      if (!target || target.purity !== 'pure' || target.capabilities.length || target.typeParams.length || target.surfaces.length
        || !emptyContract(target.contract) || target.params.some(param => !scalar(param.ty)) || !scalar(target.returns)
        || term.args.length !== target.params.length || active.includes(target.symbol))
        throw new Error('call-bearing shim helper is not closed total scalar code');
      term.args.forEach(arg => this.totalShimExpression(arg, functions, active, budget));
      this.totalShimExpression(returnExpression(target), functions, [...active, target.symbol], budget); return;
    }
    throw new Error(`call-bearing shim may discard or duplicate a partial expression: ${term.kind}`);
  }
  private compareShimRank(a: FunctionDecl, z: FunctionDecl, fences: ReadonlySet<SymbolId>): number {
    const required = (symbol: SymbolId) => this.policy.exports.includes(symbol) || this.policy.protectedSymbols.includes(symbol) || fences.has(symbol);
    const size = (declaration: FunctionDecl) => { let count = 0; const pending = [this.shimExpression(declaration)]; while (pending.length) { count++; pending.push(...children(pending.pop()!)); } return count; };
    return Number(required(z.symbol)) - Number(required(a.symbol)) || size(a) - size(z) || (a.symbol < z.symbol ? -1 : a.symbol > z.symbol ? 1 : 0);
  }
  private annotationCalls(source: Module): ReadonlySet<SymbolId> {
    const found = new Set<SymbolId>();
    for (const member of source.members) if (member.kind === 'FunctionDecl') {
      if (member.contract) for (const symbol of this.calls(member.contract)) found.add(symbol);
      const pending = member.body ? [member.body] : [];
      while (pending.length) { const node = pending.pop()!; if (node.kind === 'While') for (const annotation of [...node.invariants, ...(node.variant ? [node.variant] : [])]) for (const symbol of this.calls(annotation)) found.add(symbol); if (node.kind === 'Contract' || node.kind === 'Clause') for (const symbol of this.calls(node)) found.add(symbol); pending.push(...children(node)); }
    }
    return found;
  }
  private validateShims(source: Module, functions: ReadonlyMap<SymbolId, FunctionDecl>, fences: ReadonlySet<SymbolId>, selections: readonly ShimSelection[]): void {
    if (!selections.length) return;
    if (!isShimProfile(this.profile) || selections.length > this.maxShimComparisons) throw new Error('unsupported shim profile/count');
    const sources = new Set<SymbolId>(), annotations = this.annotationCalls(source), live = this.live(new Map(functions), fences); let previous = '';
    for (const selection of selections) {
      exactObject(selection, ['symbol', 'target', 'sourceDeclaration', 'targetDeclaration']); identifier(selection.symbol); identifier(selection.target); validateDigest(selection.sourceDeclaration, 'ast'); validateDigest(selection.targetDeclaration, 'ast');
      if (sources.has(selection.symbol) || selection.symbol <= previous) throw new Error('duplicate or reordered shim selection'); previous = selection.symbol; sources.add(selection.symbol);
      const from = functions.get(selection.symbol), to = functions.get(selection.target);
      if (!from || !to || from.symbol === to.symbol || !live.has(from.symbol) || this.policy.exports.includes(from.symbol) || this.policy.protectedSymbols.includes(from.symbol) || fences.has(from.symbol) || annotations.has(from.symbol)) throw new Error('shim is exported, protected, annotated, absent or not live');
      this.shimExpression(from); this.shimExpression(to);
      if (!same(shape(from), shape(to)) || !same(this.shimSelection(from, to), selection) || this.compareShimRank(to, from, fences) >= 0) throw new Error('shim signature, declaration or canonical target mismatch');
    }
    if (selections.some(selection => sources.has(selection.target))) throw new Error('shim targets must be retained canonical representatives');
  }
  private shimHarness(source: Module, selection: ShimSelection, targetRoot: NodeRef, obligation: Digest): { module: Module; specification: string; manifest: ExecutionManifestV1 } {
    const functions = this.declarations(source), from = functions.get(selection.symbol), to = functions.get(selection.target);
    if (!from || !to || !same(shape(from), shape(to)) || !same(this.shimSelection(from, to), selection)) throw new Error('changed scalar shim source/target');
    const rawLeft = this.shimExpression(from), rawRight = this.shimExpression(to);
    if (this.profile === SEMANTIC_GC_CALL_SHIM_PROFILE) {
      this.totalShimExpression(rawLeft, functions); this.totalShimExpression(rawRight, functions);
    }
    const left = this.profile === SEMANTIC_GC_CALL_SHIM_PROFILE
      ? this.expand(rawLeft, new Map(from.params.map(param => [param.symbol, b.v(param.symbol)])), functions, [], { left: this.maxAstNodes }, true) : rawLeft;
    const right = this.profile === SEMANTIC_GC_CALL_SHIM_PROFILE
      ? this.expand(rawRight, new Map(to.params.map(param => [param.symbol, b.v(param.symbol)])), functions, [], { left: this.maxAstNodes }, true) : rawRight;
    const selectionDigest = domainDigest('aether.semantic-gc-shim/1', selection), symbols = new SymbolSpace(`semantic-gc-shim:${obligation}:${selectionDigest}`);
    const params = from.params.map((param, index) => b.param(symbols.define(`argument${index}`), param.ty));
    const substitute = (expression: Term, declaration: FunctionDecl): Term => {
      const names = new Map(declaration.params.map((param, index) => [param.symbol, params[index].symbol]));
      const visit = (node: Term): Term => node.kind === 'Var' || node.kind === 'Place' ? b.v(names.get(node.symbol)!) : withLinkGroups(node, new Map(linkGroups(node).map(group => [group.field, group.links.map(visit)])));
      return visit(expression);
    };
    const fn = b.fn({ symbol: symbols.define('equivalentScalarShims'), params, returns: b.Bool, contract: b.contract({ ensures: [b.clause(b.result(), 'total-scalar-shim-equivalence')] }), body: b.ret(b.eq(substitute(left, from), substitute(right, to))) });
    const module = b.module_({ symbol: symbols.define('scalarShimWitness'), members: [fn], symbolTable: symbols.table() }) as Module;
    const specification = Buffer.from(encodeCanonical({ profile: this.profile, obligation, sourceRoot: new GraphStore().intern(source), targetRoot, selection, claim: this.profile === SEMANTIC_GC_CALL_SHIM_PROFILE
      ? 'For all typed scalar arguments, statically expanded closed helper calls terminate normally with equal results. The compared helper graph has empty contract frames, no capabilities, surfaces or recursion. Call-site rewriting preserves argument order and single evaluation. No exports, fences or annotations are retired by this proof alone.'
      : 'For all typed scalar arguments, both call-free expressions terminate normally with equal results. Call-site rewriting preserves original arity, order and single evaluation of every argument, including parameters unused by the selected implementation. No contracts, capabilities, exports, fences or annotation references authorize retirement by this proof alone.' }, WIRE_LIMITS)).toString('utf8');
    const root = new GraphStore().intern(module); return { module, specification, manifest: witnessManifest(root, specification, obligation, this.profile) };
  }
  private discoverShims(source: Module, manifest: ExecutionManifestV1, fences: ReadonlySet<SymbolId>): ShimSelection[] {
    if (!isShimProfile(this.profile)) return [];
    const functions = this.declarations(source), live = this.live(functions, fences), annotations = this.annotationCalls(source), candidates = [...functions.values()].filter(decl => { try { this.shimExpression(decl); return true; } catch { return false; } }).sort((a, z) => this.compareShimRank(a, z, fences));
    const representatives: FunctionDecl[] = [], selected: ShimSelection[] = []; let comparisons = 0;
    for (const declaration of candidates) {
      let matched = false;
      if (live.has(declaration.symbol) && !this.policy.exports.includes(declaration.symbol) && !this.policy.protectedSymbols.includes(declaration.symbol) && !fences.has(declaration.symbol) && !annotations.has(declaration.symbol)) for (const representative of representatives) {
        if (!same(shape(declaration), shape(representative))) continue;
        if (comparisons++ >= this.maxShimComparisons) break;
        const selection = this.shimSelection(declaration, representative);
        try {
          const probe = domainDigest('aether.semantic-gc-shim-discovery/1', { profile: this.profile, source: executionManifestDigest(manifest), selection });
          const harness = this.shimHarness(source, selection, manifest.astRoot as NodeRef, probe);
          if (generatePortableCertificate(harness.module, { ...harness, expectedManifest: harness.manifest })) { selected.push(selection); matched = true; break; }
        } catch { /* Unsupported or non-total comparisons cannot retire code. */ }
      }
      if (!matched) representatives.push(declaration);
    }
    return selected.sort((a, z) => a.symbol < z.symbol ? -1 : a.symbol > z.symbol ? 1 : 0);
  }
  private rewrite(source: Module, fences: ReadonlySet<SymbolId>, branches: readonly BranchSelection[] = [], shims: readonly ShimSelection[] = []): RewritePlan {
    source = this.applyBranches(source, branches).module;
    const functions = this.declarations(source), wrappers = new Map<SymbolId, SymbolId>();
    for (const decl of functions.values()) {
      if (this.policy.exports.includes(decl.symbol) || this.policy.protectedSymbols.includes(decl.symbol) || fences.has(decl.symbol) || !emptyContract(decl.contract) || decl.surfaces.length || decl.purity !== 'pure' || decl.capabilities.length || decl.typeParams.length || !scalar(decl.returns) || decl.params.some(param => !scalar(param.ty))) continue;
      let expression: Term; try { expression = returnExpression(decl); } catch { continue; }
      if (expression.kind !== 'Call' || expression.callee === decl.symbol || expression.args.length !== decl.params.length || expression.args.some((arg, index) => arg.kind !== 'Var' || arg.symbol !== decl.params[index].symbol)) continue;
      const target = functions.get(expression.callee)!; if (!same(shape(decl), shape(target))) continue;
      wrappers.set(decl.symbol, target.symbol);
    }
    const transparent = new Set(wrappers.keys());
    this.validateShims(source, functions, fences, shims);
    for (const shim of shims) wrappers.set(shim.symbol, shim.target);
    const resolve = (symbol: SymbolId): SymbolId => { const visited = new Set<SymbolId>(); while (wrappers.has(symbol)) { if (visited.has(symbol)) throw new Error('recursive forwarding wrapper is unsupported'); visited.add(symbol); symbol = wrappers.get(symbol)!; } return symbol; };
    for (const symbol of wrappers.keys()) resolve(symbol);
    const replaceCalls = (term: Term): Term => {
      if (this.profile !== SEMANTIC_GC_PROFILE) {
        if (term.kind === 'Contract' || term.kind === 'Clause') return term;
        if (term.kind === 'While') return { ...term, cond: replaceCalls(term.cond), body: replaceCalls(term.body) };
      }
      const groups = new Map(linkGroups(term).map(group => [group.field, group.links.map(replaceCalls)]));
      const copied = withLinkGroups(term, groups); return copied.kind === 'Call' ? { ...copied, callee: resolve(copied.callee) } : copied;
    };
    const rewritten = new Map([...functions].map(([symbol, decl]) => [symbol, { ...decl, body: decl.body ? replaceCalls(decl.body) : null }]));
    const live = this.live(rewritten, fences), priorLive = this.live(functions, fences);
    if (shims.some(shim => live.has(shim.symbol))) throw new Error('shim remains live through a preserved boundary');
    const target: Module = { ...source, members: source.members.filter(member => member.kind !== 'FunctionDecl' || live.has(member.symbol)).map(member => member.kind === 'FunctionDecl' ? rewritten.get(member.symbol)! : member) };
    this.declarations(target);
    return { target, removed: [...functions.keys()].filter(symbol => !live.has(symbol)).sort(), collapsed: [...wrappers].filter(([symbol]) => transparent.has(symbol) && priorLive.has(symbol)).map(([symbol]) => ({ symbol, target: resolve(symbol) })).sort((a, z) => a.symbol.localeCompare(z.symbol)) };
  }
  private expand(term: Term, environment: ReadonlyMap<SymbolId, Term>, functions: ReadonlyMap<SymbolId, FunctionDecl>, active: readonly SymbolId[] = [], budget = { left: this.maxAstNodes }, strictShim = false): Term {
    if (--budget.left < 0 || active.length > 32) throw new Error('equivalence expansion resource bound');
    switch (term.kind) {
      case 'Lit': if (!scalar(term.ty)) throw new Error('unsupported non-scalar equivalence literal'); return term;
      case 'Var': { const value = environment.get(term.symbol); if (!value) throw new Error('unbound equivalence variable'); return value; }
      case 'Un': return { ...term, operand: this.expand(term.operand, environment, functions, active, budget, strictShim) };
      case 'Bin': return { ...term, left: this.expand(term.left, environment, functions, active, budget, strictShim), right: this.expand(term.right, environment, functions, active, budget, strictShim) };
      case 'Cond': return { ...term, cond: this.expand(term.cond, environment, functions, active, budget, strictShim), then: this.expand(term.then, environment, functions, active, budget, strictShim), otherwise: this.expand(term.otherwise, environment, functions, active, budget, strictShim) };
      case 'Call': {
        const target = functions.get(term.callee); if (!target || target.purity !== 'pure' || target.capabilities.length || target.typeParams.length || target.params.some(param => !scalar(param.ty)) || !scalar(target.returns) || active.includes(target.symbol)) throw new Error('unsupported equivalence call');
        if (strictShim && (!emptyContract(target.contract) || target.surfaces.length)) throw new Error('call-bearing shim helper has contract or surface behavior');
        const args = term.args.map(arg => this.expand(arg, environment, functions, active, budget, strictShim)); if (args.length !== target.params.length) throw new Error('equivalence arity mismatch');
        return this.expand(returnExpression(target), new Map(target.params.map((param, index) => [param.symbol, args[index]])), functions, [...active, target.symbol], budget, strictShim);
      }
      default: throw new Error(`unsupported equivalence expression: ${term.kind}`);
    }
  }
  private obligation(source: ExecutionManifestV1, target: NodeRef, removed: readonly SymbolId[], collapsed: readonly Wrapper[], branches: readonly BranchSelection[] = [], shims: readonly ShimSelection[] = []): Digest { return domainDigest('aether.semantic-gc-obligation/1', { configuration: this.configuration, profile: this.profile, source: source.astRoot, sourceExecution: executionManifestDigest(source), target, exports: this.policy.exports, removed, collapsed, ...(this.profile !== SEMANTIC_GC_PROFILE ? { branches } : {}), ...(isShimProfile(this.profile) ? { shims } : {}) }); }
  private harness(source: Module, targetRoot: NodeRef, wrapper: Wrapper, obligation: Digest): { module: Module; specification: string; manifest: ExecutionManifestV1 } {
    const functions = this.declarations(source), decl = functions.get(wrapper.symbol); if (!decl) throw new Error('missing equivalence wrapper');
    const symbols = new SymbolSpace(`semantic-gc:${obligation}:${wrapper.symbol}`), params = decl.params.map((param, index) => b.param(symbols.define(`argument${index}`), param.ty));
    const args = params.map(param => b.v(param.symbol));
    const before = this.expand(b.call(wrapper.symbol, ...args), new Map(params.map(param => [param.symbol, b.v(param.symbol)])), functions);
    const after = this.expand(b.call(wrapper.target, ...args), new Map(params.map(param => [param.symbol, b.v(param.symbol)])), functions);
    const proof = b.fn({ symbol: symbols.define('equivalent'), params, returns: b.Bool, contract: b.contract({ ensures: [b.clause(b.result(), 'forwarder-return-equivalence')] }), body: b.ret(b.eq(before, after)) });
    const module = b.module_({ symbol: symbols.define('equivalenceWitness'), members: [proof], symbolTable: symbols.table() }) as Module;
    const specification = JSON.stringify({ profile: this.profile, obligation, targetRoot, wrapper, claim: 'For all scalar arguments, the transparent forwarder and its unchanged ultimate target return equal values; structural rewrite validation separately preserves call argument order, declarations, contracts and effect sites.' });
    const root = new GraphStore().intern(module); return { module, specification, manifest: witnessManifest(root, specification, obligation, this.profile) };
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
      if (source.kind !== 'Module') throw new Error('expected module'); const specification = this.sourceSpecification(sourceManifest); const branches = this.discoverBranches(source, sourceManifest), fences = this.fenceSymbols(sourceManifest, specification);
      const shims = this.discoverShims(this.applyBranches(source, branches).module, sourceManifest, fences);
      const plan = this.rewrite(source, fences, branches, shims);
      const targetRoot = this.options.store.intern(plan.target, { leaseId: this.builderLease }); if (targetRoot === sourceManifest.astRoot) return null;
      return this.recordProposal(sourceManifest, targetRoot, plan.removed, plan.collapsed, 'cleanup', null, source, specification, branches, shims);
    }, 5000);
  }
  private recordProposal(sourceManifest: ExecutionManifestV1, targetRoot: NodeRef, removed: readonly SymbolId[], collapsed: readonly Wrapper[], direction: 'cleanup' | 'rollback', rollbackOf: Digest | null, witnessSource: Module, specification: string, branchSelections: readonly BranchSelection[] = [], shimSelections: readonly ShimSelection[] = []): SemanticGcProposal {
    const sourceRoot = sourceManifest.astRoot as NodeRef, obligationDigest = this.obligation(sourceManifest, targetRoot, removed, collapsed, branchSelections, shimSelections), witnesses: EquivalenceWitness[] = [];
    const transformed = this.applyBranches(witnessSource, branchSelections), branches: BranchWitness[] = [], shims: ShimWitness[] = [];
    for (const selection of shimSelections) {
      const harness = this.shimHarness(transformed.module, selection, targetRoot, obligationDigest);
      const certificate = generatePortableCertificate(harness.module, { ...harness, expectedManifest: harness.manifest });
      if (!certificate) throw new Error('unproved total scalar shim equivalence');
      const root = this.options.store.intern(harness.module, { leaseId: this.builderLease });
      shims.push({ selection, root, specification: harness.specification, manifest: harness.manifest, certificate });
    }
    for (const selection of branchSelections) {
      const location = transformed.locations.get(this.branchKey(selection))!;
      const harness = this.branchHarness(witnessSource, location, selection, targetRoot, obligationDigest);
      const certificate = generatePortableCertificate(harness.module, { ...harness, expectedManifest: harness.manifest });
      if (!certificate) throw new Error('unproved total branch condition');
      const root = this.options.store.intern(harness.module, { leaseId: this.builderLease });
      branches.push({ selection, root, specification: harness.specification, manifest: harness.manifest, certificate });
    }
    for (const wrapper of collapsed) {
      const harness = this.harness(transformed.module, targetRoot, wrapper, obligationDigest);
      const certificate = generatePortableCertificate(harness.module, { ...harness, expectedManifest: harness.manifest });
      if (!certificate) throw new Error('unsupported or unproved portable equivalence obligation');
      const root = this.options.store.intern(harness.module, { leaseId: this.builderLease }); witnesses.push({ wrapper: wrapper.symbol, root, specification: harness.specification, manifest: harness.manifest, certificate });
    }
    const body: Omit<SemanticGcProposal, 'id'> = { format: 'aether.semantic-gc-proposal/1' as const, configuration: this.configuration, profile: this.profile, direction, rollbackOf, sourceManifest, specification, productionAuthorized: false, sourceRoot, targetRoot, exports: this.policy.exports, removed, collapsed, witnesses, obligationDigest, ...(this.profile !== SEMANTIC_GC_PROFILE ? { branches } : {}), ...(isShimProfile(this.profile) ? { shims } : {}) };
    const proposal: SemanticGcProposal = { ...body, id: domainDigest('aether.semantic-gc-proposal/1', body, WIRE_LIMITS) };
    this.verify(proposal, false);
    this.options.store.retain(`semantic-gc-proposal:${proposal.id}`, [sourceRoot, targetRoot, ...witnesses.map(witness => witness.root), ...branches.map(witness => witness.root), ...shims.map(witness => witness.root)]);
    this.immutable('proposals', proposal.id, proposal); return freeze(clone(proposal));
  }
  readProposal(id: Digest): SemanticGcProposal { validateDigest(id, 'aether.semantic-gc-proposal/1'); const value = this.read(this.path('proposals', id)) as SemanticGcProposal; if (value.id !== id) throw new Error('proposal address mismatch'); this.verify(value, false); return freeze(clone(value)); }
  private verify(proposal: SemanticGcProposal, current: boolean): void {
    encodeCanonical(proposal, WIRE_LIMITS); exactObject(proposal, ['format', 'configuration', 'profile', 'direction', 'rollbackOf', 'sourceManifest', 'specification', 'productionAuthorized', 'sourceRoot', 'targetRoot', 'exports', 'removed', 'collapsed', 'witnesses', 'obligationDigest', 'id', ...(this.profile !== SEMANTIC_GC_PROFILE ? ['branches'] : []), ...(isShimProfile(this.profile) ? ['shims'] : [])]);
    const { id, ...body } = proposal;
    if (proposal.productionAuthorized !== false || proposal.format !== 'aether.semantic-gc-proposal/1' || proposal.profile !== this.profile || proposal.configuration !== this.configuration || id !== domainDigest('aether.semantic-gc-proposal/1', body, WIRE_LIMITS) || !same(proposal.exports, this.policy.exports)) throw new Error('semantic GC proposal identity/profile mismatch');
    validateExecutionManifest(proposal.sourceManifest); if (proposal.sourceManifest.semanticsVersion !== 'aether-reference/1') throw new Error('unsupported source semantics for GC equivalence'); if (proposal.sourceManifest.astRoot !== proposal.sourceRoot) throw new Error('rewrite source manifest mismatch');
    const fences = this.fenceSymbols(proposal.sourceManifest, proposal.specification);
    if (this.profile !== SEMANTIC_GC_PROFILE && (!Array.isArray(proposal.branches) || proposal.branches.length > this.maxBranchProofs)) throw new Error('invalid branch witness coverage');
    const branches = proposal.branches ?? [];
    for (const witness of branches) exactObject(witness, ['selection', 'root', 'specification', 'manifest', 'certificate']);
    const selections = branches.map(witness => witness.selection);
    if (isShimProfile(this.profile) && (!Array.isArray(proposal.shims) || proposal.shims.length > this.maxShimComparisons)) throw new Error('invalid shim witness coverage');
    const shims = proposal.shims ?? [];
    for (const witness of shims) exactObject(witness, ['selection', 'root', 'specification', 'manifest', 'certificate']);
    const shimSelections = shims.map(witness => witness.selection);
    const source = this.options.store.hydrate(proposal.sourceRoot), target = this.options.store.hydrate(proposal.targetRoot); this.declarations(source); this.declarations(target);
    if (source.kind !== 'Module' || target.kind !== 'Module') throw new Error('rewrite modules required');
    let plan: RewritePlan, witnessSource: Module;
    if (proposal.direction === 'cleanup') { if (proposal.rollbackOf !== null) throw new Error('cleanup has rollback predecessor'); plan = this.rewrite(source, fences, selections, shimSelections); witnessSource = source; if (new GraphStore().intern(plan.target) !== proposal.targetRoot) throw new Error('unsupported or unsafe candidate rewrite'); }
    else if (proposal.direction === 'rollback' && proposal.rollbackOf !== null) {
      const prior = this.read(this.path('proposals', proposal.rollbackOf)) as SemanticGcProposal; if (prior.direction !== 'cleanup') throw new Error('rollback cannot chain another rollback');
      const previous = this.readProposal(proposal.rollbackOf); if (previous.direction !== 'cleanup' || previous.targetRoot !== proposal.sourceRoot || previous.sourceRoot !== proposal.targetRoot) throw new Error('rollback is not the exact inverse cleanup');
      plan = this.rewrite(target, fences, selections, shimSelections); witnessSource = target; if (new GraphStore().intern(plan.target) !== proposal.sourceRoot) throw new Error('rollback proof relation changed');
    } else throw new Error('unsupported rewrite direction');
    if (!same(proposal.removed, plan.removed) || !same(proposal.collapsed, plan.collapsed) || proposal.obligationDigest !== this.obligation(proposal.sourceManifest, proposal.targetRoot, plan.removed, plan.collapsed, selections, shimSelections) || proposal.witnesses.length !== plan.collapsed.length) throw new Error('incomplete rewrite equivalence relation');
    const transformed = this.applyBranches(witnessSource, selections);
    for (const witness of shims) {
      const expected = this.shimHarness(transformed.module, witness.selection, proposal.targetRoot, proposal.obligationDigest);
      if (witness.root !== expected.manifest.astRoot || witness.specification !== expected.specification || !same(witness.manifest, expected.manifest) || new GraphStore().intern(this.options.store.hydrate(witness.root)) !== expected.manifest.astRoot) throw new Error('stale or substituted shim witness');
      checkPortableCertificate(expected.module, witness.certificate, { expectedManifest: expected.manifest, specification: expected.specification });
    }
    for (const witness of branches) {
      const expected = this.branchHarness(witnessSource, transformed.locations.get(this.branchKey(witness.selection))!, witness.selection, proposal.targetRoot, proposal.obligationDigest);
      if (witness.root !== expected.manifest.astRoot || witness.specification !== expected.specification || !same(witness.manifest, expected.manifest) || new GraphStore().intern(this.options.store.hydrate(witness.root)) !== expected.manifest.astRoot) throw new Error('stale or substituted branch witness');
      checkPortableCertificate(expected.module, witness.certificate, { expectedManifest: expected.manifest, specification: expected.specification });
    }
    proposal.witnesses.forEach((witness, index) => {
      exactObject(witness, ['wrapper', 'root', 'specification', 'manifest', 'certificate']); const expected = this.harness(transformed.module, proposal.targetRoot, plan.collapsed[index], proposal.obligationDigest);
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
      return this.recordProposal(currentManifest, previous.sourceRoot, previous.removed, previous.collapsed, 'rollback', cleanupId, original, this.sourceSpecification(currentManifest), (previous.branches ?? []).map(witness => witness.selection), (previous.shims ?? []).map(witness => witness.selection));
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
