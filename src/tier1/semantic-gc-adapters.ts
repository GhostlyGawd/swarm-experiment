/** Candidate-only retirement of explicitly declared lazy adapter registrations.
 * This sidecar does not unload native code, mutate arbitrary host adapter maps,
 * or replace F08 production admission. Existing AST GC journal profiles are
 * intentionally untouched. */
import { createPrivateKey, createPublicKey, sign, verify, type KeyObject } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { encodeCanonical, decodeCanonical, exactObject, identifier } from '../fabric/encoding.ts';
import { domainDigest, executionManifestDigest, validateExecutionManifest, validateDigest, type Digest, type ExecutionManifestV1 } from '../fabric/identity.ts';
import { JournalLock } from '../fabric/journal-lock.ts';
import { CapabilityRegistry } from '../tier2/ocap.ts';
import { typecheck } from '../tier2/typecheck.ts';
import { adapterArtifactDigest, legacyAdapterArtifactForSource, type AdapterArtifactV1 } from '../tier2/adapter-artifact.ts';
import { generatePortableCertificate } from '../tier2/portable-proof-producer.ts';
import { checkPortableCertificate, type PortableCertificateV1 } from '../tier2/portable-proof-checker.ts';
import { CausalLineageLedger } from './causal-lineage.ts';
import { DurableGraphStore } from './durable-store.ts';
import { GraphStore } from './store.ts';
import { children, type Term } from './ast.ts';
import { SymbolSpace } from './symbols.ts';
import { capability, type CapabilityName, type NodeRef, type SymbolId } from './ids.ts';
import { atomicWrite } from './persistence.ts';
import { SemanticGarbageCollector, type SemanticGcPolicy, type SemanticRetention } from './semantic-gc.ts';
import { retainedExecutableCapabilities } from './semantic-gc-retained-closure.ts';
import * as b from './build.ts';

export interface DeclarativeAdapterRegistration {
  readonly id: string; readonly capability: CapabilityName; readonly artifact: AdapterArtifactV1;
  /** AST Str literal containing exact UTF-8 JavaScript source bytes. */
  readonly sourceRoot: NodeRef; readonly lifecycle: 'lazy-declarative-no-unload/1';
}
export interface DeclarativeAdapterTable {
  readonly format: 'aether.declarative-adapter-table/1'; readonly repositoryId: string;
  readonly registrations: readonly DeclarativeAdapterRegistration[];
}
export interface AdapterRetirementProposal {
  readonly format: 'aether.semantic-adapter-retirement/1'; readonly configuration: Digest;
  readonly sourceManifest: ExecutionManifestV1; readonly specification: string;
  readonly before: DeclarativeAdapterTable; readonly after: DeclarativeAdapterTable;
  readonly retained: readonly SemanticRetention[]; readonly reachable: readonly SymbolId[];
  readonly usedCapabilities: readonly CapabilityName[]; readonly removed: readonly string[];
  readonly witness: { readonly root: NodeRef; readonly specification: string; readonly manifest: ExecutionManifestV1; readonly certificate: PortableCertificateV1 };
  readonly productionAuthorized: false; readonly id: Digest;
}
export interface SemanticAdapterGcOptions {
  readonly directory: string; readonly repositoryId: string; readonly store: DurableGraphStore;
  readonly lineage: CausalLineageLedger; readonly registry: CapabilityRegistry;
  readonly policy: SemanticGcPolicy; readonly retentionLedger: SemanticGarbageCollector;
  readonly genesisManifest: ExecutionManifestV1; readonly genesisTable: DeclarativeAdapterTable;
  readonly key: KeyObject | string;
  readonly beforePublish?: () => void;
}
interface Journal {
  format: 'aether.semantic-adapter-registry/1'; configuration: Digest;
  tables: DeclarativeAdapterTable[]; proposals: AdapterRetirementProposal[];
  head: { generation: number; table: Digest; manifest: ExecutionManifestV1 };
}
type Decl = Extract<Term, { kind: 'FunctionDecl' }>;
const limits = { maxFrameBytes: 16 * 1024 * 1024, maxDecompressedBytes: 16 * 1024 * 1024, maxObjects: 500_000 };
const clone = <T>(value: T): T => decodeCanonical(encodeCanonical(value, limits), limits) as T;
const equal = (a: unknown, b: unknown): boolean => Buffer.from(encodeCanonical(a, limits)).equals(Buffer.from(encodeCanonical(b, limits)));
const digest = (domain: string, value: unknown): Digest => domainDigest(domain, value, limits);
function freeze<T>(value: T): T { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
function durableDirectory(path: string): void { if (existsSync(path)) return; durableDirectory(dirname(path)); try { mkdirSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; } for (const directory of [path, dirname(path)]) { const fd = openSync(directory, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } } }
function write(path: string, value: unknown): void { atomicWrite(path, Buffer.from(encodeCanonical(value, limits)).toString()); const fd = openSync(dirname(path), 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } }
function* walk(term: Term): Generator<Term> { yield term; for (const child of children(term)) yield* walk(child); }
export function declarativeAdapterTableDigest(table: DeclarativeAdapterTable): Digest {
  exactObject(table, ['format', 'repositoryId', 'registrations']); identifier(table.repositoryId);
  if (table.format !== 'aether.declarative-adapter-table/1' || !Array.isArray(table.registrations) || table.registrations.length > 64) throw new TypeError('invalid declarative adapter table');
  let previous = ''; const capabilities = new Set<string>();
  for (const item of table.registrations) {
    exactObject(item, ['id', 'capability', 'artifact', 'sourceRoot', 'lifecycle']); identifier(item.id); capability(item.capability); validateDigest(item.sourceRoot, 'ast');
    if (item.id <= previous || capabilities.has(item.capability) || item.lifecycle !== 'lazy-declarative-no-unload/1' || item.artifact.capability !== item.capability) throw new TypeError('duplicate/noncanonical or unsupported adapter lifecycle');
    adapterArtifactDigest(item.artifact); previous = item.id; capabilities.add(item.capability);
  }
  return digest('aether.declarative-adapter-table/1', table);
}

export class SemanticAdapterGarbageCollector {
  private readonly options: SemanticAdapterGcOptions;
  private readonly policy: SemanticGcPolicy;
  private readonly registry: CapabilityRegistry;
  private readonly key: KeyObject;
  private readonly file: string;
  private readonly lock: JournalLock;
  readonly configuration: Digest;
  constructor(options: SemanticAdapterGcOptions) {
    this.options = { ...options }; this.policy = freeze(clone(options.policy)); exactObject(this.policy, ['epoch', 'exports', 'protectedSymbols']); identifier(this.policy.epoch); identifier(options.repositoryId);
    if (!this.policy.exports.length || new Set([...this.policy.exports]).size !== this.policy.exports.length) throw new TypeError('complete nonempty export policy required');
    [...this.policy.exports, ...this.policy.protectedSymbols].forEach(identifier);
    this.registry = new CapabilityRegistry(); options.registry.names.forEach(name => this.registry.define(clone(options.registry.get(name)!)));
    const initial = clone(options.genesisTable); this.checkTable(initial); validateExecutionManifest(options.genesisManifest);
    if (options.genesisManifest.capabilityPolicyDigest !== declarativeAdapterTableDigest(initial)) throw new Error('genesis manifest must bind exact declarative registration policy');
    this.key = typeof options.key === 'string' ? createPrivateKey(options.key) : options.key;
    if (this.key.type !== 'private' || this.key.asymmetricKeyType !== 'ed25519') throw new TypeError('Ed25519 candidate registry signer required');
    this.configuration = digest('aether.semantic-adapter-gc-config/1', { repositoryId: options.repositoryId, policy: this.policy, genesis: executionManifestDigest(options.genesisManifest), table: declarativeAdapterTableDigest(initial), registry: this.registry.names.map(name => this.registry.get(name)), directory: resolve(options.directory), publicKey: createPublicKey(this.key).export({ format: 'der', type: 'spki' }).toString('base64') });
    durableDirectory(options.directory); this.file = join(options.directory, 'registry.json'); this.lock = new JournalLock({ directory: join(options.directory, 'tickets'), domain: 'aether.semantic-adapter-gc' });
    this.lock.run(() => {
      const seal = join(options.directory, 'profile.json');
      if (!existsSync(this.file)) { if (existsSync(seal)) throw new Error('missing established adapter registry'); this.current(options.genesisManifest); this.write({ format: 'aether.semantic-adapter-registry/1', configuration: this.configuration, tables: [initial], proposals: [], head: { generation: 0, table: declarativeAdapterTableDigest(initial), manifest: clone(options.genesisManifest) } }); }
      const journal = this.read();
      if (!existsSync(seal)) { if (journal.head.generation || journal.proposals.length) throw new Error('missing established adapter registry profile'); write(seal, { configuration: this.configuration }); }
      else if (!equal(decodeCanonical(readFileSync(seal), limits), { configuration: this.configuration })) throw new Error('adapter registry profile mismatch');
      this.pin(journal);
    }, 5000);
  }
  private write(body: Journal): void { if (body.proposals.length > 100 || body.tables.length > 101) throw new RangeError('adapter registry capacity'); write(this.file, { body, signature: sign(null, encodeCanonical(body, limits), this.key).toString('base64') }); }
  private read(): Journal {
    if (statSync(this.file).size > limits.maxFrameBytes) throw new RangeError('adapter registry journal bound');
    const data = exactObject(decodeCanonical(readFileSync(this.file), limits), ['body', 'signature']), body = data.body as Journal;
    if (typeof data.signature !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(data.signature)
      || Buffer.from(data.signature, 'base64').toString('base64') !== data.signature
      || !verify(null, encodeCanonical(body, limits), createPublicKey(this.key), Buffer.from(data.signature, 'base64')))
      throw new Error('forged adapter registry journal');
    exactObject(body, ['format', 'configuration', 'tables', 'proposals', 'head']);
    if (body.format !== 'aether.semantic-adapter-registry/1' || body.configuration !== this.configuration || body.proposals.length > 100 || body.tables.length > 101) throw new TypeError('adapter registry profile/capacity mismatch');
    body.tables.forEach(table => this.checkTable(table)); validateExecutionManifest(body.head.manifest);
    if (!body.tables.some(table => declarativeAdapterTableDigest(table) === body.head.table) || body.head.manifest.capabilityPolicyDigest !== body.head.table) throw new Error('adapter registry head mismatch'); return body;
  }
  private checkTable(table: DeclarativeAdapterTable): void {
    declarativeAdapterTableDigest(table); if (table.repositoryId !== this.options.repositoryId) throw new Error('foreign adapter registry');
    for (const item of table.registrations) {
      const node = this.options.store.hydrate(item.sourceRoot);
      if (node.kind !== 'Lit' || node.ty.t !== 'Str' || typeof node.value !== 'string') throw new Error('adapter source must be a retained string artifact');
      const actual = legacyAdapterArtifactForSource(Buffer.from(node.value), item.capability, item.artifact.id, item.artifact.semantics);
      if (!equal(actual, item.artifact)) throw new Error('adapter source bytes differ from declared artifact');
    }
  }
  private pin(journal: Journal): void {
    const roots = [...new Set([journal.head.manifest.astRoot as NodeRef, ...journal.tables.flatMap(table => table.registrations.map(registration => registration.sourceRoot)), ...journal.proposals.flatMap(proposal => [proposal.sourceManifest.astRoot as NodeRef, proposal.witness.root])])];
    this.options.store.retain(`semantic-adapter-registry:${this.configuration}`, roots);
  }
  private current(manifest: ExecutionManifestV1): void {
    validateExecutionManifest(manifest); if (manifest.semanticsVersion !== 'aether-reference/1' || manifest.dependencies.length) throw new Error('adapter retirement requires exact closed reference semantics');
    this.options.lineage.assertCurrent(executionManifestDigest(manifest)); this.options.lineage.assertNodeCurrent(executionManifestDigest(manifest), manifest.astRoot as NodeRef);
  }
  private specification(manifest: ExecutionManifestV1): string {
    for (const item of this.options.lineage.lineage(manifest.astRoot as NodeRef)) for (const intent of item.ancestry) {
      if (intent.body.executionManifest !== executionManifestDigest(manifest) || intent.body.subject !== manifest.astRoot) continue;
      const specification = this.options.lineage.specification(intent.body.parents, intent.body.specifications);
      if (domainDigest('aether.specification/1', specification) === manifest.specRoot) return specification;
    }
    throw new Error('missing exact signed adapter-retirement specification');
  }
  private fences(specification: string): SymbolId[] {
    const document = exactObject(decodeCanonical(Buffer.from(specification), limits), ['format', 'repositoryId', 'specifications']);
    if (document.format !== 'aether.lineage-specification/1' || document.repositoryId !== this.options.repositoryId || !Array.isArray(document.specifications)) throw new Error('invalid signed specification');
    return document.specifications.flatMap(item => {
      const spec = exactObject(item, ['id', 'revision', 'text', 'requirements']); if (!Array.isArray(spec.requirements)) throw new Error('invalid signed fences');
      return spec.requirements.map(requirement => { const row = exactObject(requirement, ['symbol', 'signature', 'requires', 'modifies', 'ensures']); identifier(row.symbol); return row.symbol as SymbolId; });
    });
  }
  private closed(root: NodeRef): Map<SymbolId, Decl> {
    const module = this.options.store.hydrate(root); if (module.kind !== 'Module' || module.symbolTable.kind !== 'SymbolTable') throw new Error('retention/source must name a complete closed module');
    const nodes = [...walk(module)]; if (nodes.length > 10_000 || nodes.some(node => ['Import', 'Lambda', 'Apply', 'Spawn', 'Await', 'SeqMap', 'SeqFold'].includes(node.kind))) throw new Error('unresolved import or dynamic adapter liveness');
    if (!typecheck(module, { registry: this.registry }).ok) throw new Error('ill-typed adapter-retirement module');
    const map = new Map<SymbolId, Decl>();
    for (const member of module.members) { if (member.kind === 'FunctionDecl') { if (map.has(member.symbol)) throw new Error('duplicate declaration'); map.set(member.symbol, member); } else if (member.kind !== 'TypeDecl') throw new Error('unsupported declaration lifecycle'); }
    if (map.size > 128) throw new RangeError('adapter liveness declaration bound');
    for (const declaration of map.values()) for (const node of walk(declaration)) if (node.kind === 'Call' && !map.has(node.callee)) throw new Error('unresolved external adapter use');
    return map;
  }
  private analyze(manifest: ExecutionManifestV1, specification: string, retained: readonly SemanticRetention[]) {
    const declarations = this.closed(manifest.astRoot as NodeRef), reachable = new Set<SymbolId>(), used = new Set<CapabilityName>();
    const protectedContracts = [...declarations.values()].filter(decl => decl.surfaces.length || decl.contract?.kind === 'Contract' && (decl.contract.requires.length || decl.contract.modifies.length || decl.contract.ensures.length)).map(decl => decl.symbol);
    const pending = [...this.policy.exports, ...this.policy.protectedSymbols, ...this.fences(specification), ...protectedContracts];
    while (pending.length) {
      const symbol = pending.pop()!; if (reachable.has(symbol)) continue;
      const declaration = declarations.get(symbol); if (!declaration) throw new Error('missing exported/protected/fenced declaration'); reachable.add(symbol);
      declaration.capabilities.forEach(cap => used.add(cap)); for (const node of walk(declaration)) { if (node.kind === 'Call') pending.push(node.callee); if (node.kind === 'Invoke') used.add(node.capability); }
    }
    const retainedUse = retainedExecutableCapabilities(this.options.store, this.registry, retained);
    return { reachable: [...reachable].sort(), usedCapabilities: [...new Set([...used, ...retainedUse])].sort() };
  }
  private retentionSnapshot(): readonly SemanticRetention[] { return clone([...this.options.retentionLedger.retentions()].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))); }
  private harness(proposal: Omit<AdapterRetirementProposal, 'id' | 'witness'>) {
    const symbols = new SymbolSpace('semantic-adapter-retirement-proof'), query = symbols.define('capability-index');
    const registrations = proposal.before.registrations;
    const lookup = (table: DeclarativeAdapterTable): Term => registrations.reduceRight<Term>((otherwise, registration, index) => b.cond(b.eq(b.v(query), b.int(index)), b.int(table.registrations.some(item => item.id === registration.id) ? index + 1 : 0), otherwise), b.int(0));
    const live = registrations.reduce<Term>((condition, registration, index) => proposal.usedCapabilities.includes(registration.capability) ? b.or(condition, b.eq(b.v(query), b.int(index))) : condition, b.bool(false));
    const expression = b.or(b.not(live), b.eq(lookup(proposal.before), lookup(proposal.after)));
    const function_ = b.fn({ symbol: symbols.define('dispatch-preserved'), params: [b.param(query, b.Int)], returns: b.Bool, contract: b.contract({ ensures: [b.clause(b.result(), 'all-reachable-dispatch-identities-preserved')] }), body: b.ret(expression) });
    const module = b.module_({ symbol: symbols.define('witness'), members: [function_], symbolTable: symbols.table() });
    const specification = Buffer.from(encodeCanonical({ claim: 'For every integer capability index, every reachable/retained dispatch maps to the same exact descriptor. Registration deletion changes no AST or lifecycle execution; all entries are declarative lazy metadata with no unload callback.', proposal }, limits)).toString();
    const root = new GraphStore().intern(module), d = (part: string) => digest('aether.adapter-gc-proof-context/1', { configuration: this.configuration, part, specification });
    const manifest: ExecutionManifestV1 = { format: 'aether.execution/1', astRoot: root, specRoot: domainDigest('aether.specification/1', specification), dependencies: [], semanticsVersion: 'aether-reference/1', compilerDigest: d('compiler'), target: { abiVersion: 'adapter-registry-equivalence/1', profileDigest: d('profile'), artifactDigest: d('artifact') }, capabilityPolicyDigest: d('no-effects'), evidencePolicyDigest: d('portable-checker') };
    return { module, specification, manifest };
  }
  propose(): AdapterRetirementProposal | null {
    return this.lock.run(() => {
      const journal = this.read(), sourceManifest = journal.head.manifest; this.current(sourceManifest);
      const before = journal.tables.find(table => declarativeAdapterTableDigest(table) === journal.head.table)!, specification = this.specification(sourceManifest), retained = this.retentionSnapshot(), analysis = this.analyze(sourceManifest, specification, retained);
      const removed = before.registrations.filter(item => !analysis.usedCapabilities.includes(item.capability)).map(item => item.id); if (!removed.length) return null;
      const after: DeclarativeAdapterTable = { ...before, registrations: before.registrations.filter(item => !removed.includes(item.id)) };
      const body = { format: 'aether.semantic-adapter-retirement/1' as const, configuration: this.configuration, sourceManifest, specification, before, after, retained, ...analysis, removed, productionAuthorized: false as const };
      const harness = this.harness(body), certificate = generatePortableCertificate(harness.module, { ...harness, expectedManifest: harness.manifest }); if (!certificate) throw new Error('adapter dispatch/no-effect obligation not proved');
      const root = this.options.store.intern(harness.module, { leaseId: `adapter-gc-proof:${this.configuration}` });
      const complete = { ...body, witness: { root, specification: harness.specification, manifest: harness.manifest, certificate } }, proposal = { ...complete, id: digest('aether.semantic-adapter-retirement/1', complete) };
      this.verify(proposal); if (!journal.proposals.some(item => item.id === proposal.id)) journal.proposals.push(proposal); this.pin(journal); this.write(journal); return freeze(clone(proposal));
    }, 5000);
  }
  /** Independent consumer: this path performs no proof search. */
  verify(input: AdapterRetirementProposal): void {
    const proposal = clone(input); exactObject(proposal, ['format', 'configuration', 'sourceManifest', 'specification', 'before', 'after', 'retained', 'reachable', 'usedCapabilities', 'removed', 'witness', 'productionAuthorized', 'id']);
    const { id, witness, ...body } = proposal;
    if (proposal.format !== 'aether.semantic-adapter-retirement/1' || proposal.configuration !== this.configuration || proposal.productionAuthorized !== false || id !== digest('aether.semantic-adapter-retirement/1', { ...body, witness })) throw new Error('adapter retirement identity mismatch');
    validateExecutionManifest(proposal.sourceManifest); this.checkTable(proposal.before); this.checkTable(proposal.after);
    if (proposal.sourceManifest.capabilityPolicyDigest !== declarativeAdapterTableDigest(proposal.before) || domainDigest('aether.specification/1', proposal.specification) !== proposal.sourceManifest.specRoot) throw new Error('adapter retirement source binding mismatch');
    const analysis = this.analyze(proposal.sourceManifest, proposal.specification, proposal.retained);
    const removed = proposal.before.registrations.filter(item => !analysis.usedCapabilities.includes(item.capability)).map(item => item.id);
    if (!removed.length || !equal(removed, proposal.removed) || !equal(analysis.reachable, proposal.reachable) || !equal(analysis.usedCapabilities, proposal.usedCapabilities) || !equal(proposal.after, { ...proposal.before, registrations: proposal.before.registrations.filter(item => !removed.includes(item.id)) })) throw new Error('adapter retirement changed live mapping or omitted liveness');
    const expected = this.harness(body); exactObject(witness, ['root', 'specification', 'manifest', 'certificate']);
    if (witness.root !== expected.manifest.astRoot || witness.specification !== expected.specification || !equal(witness.manifest, expected.manifest) || new GraphStore().intern(this.options.store.hydrate(witness.root)) !== witness.root) throw new Error('adapter retirement witness substitution');
    checkPortableCertificate(expected.module, witness.certificate, { expectedManifest: expected.manifest, specification: expected.specification });
  }
  /** Advances a candidate descriptor workspace, not a production adapter map.
   * Exact newly signed lineage approval of the table policy is mandatory. */
  advance(input: AdapterRetirementProposal, candidateManifest: ExecutionManifestV1): void {
    const proposal = freeze(clone(input)), candidate = freeze(clone(candidateManifest));
    this.lock.run(() => {
      const journal = this.read(); this.verify(proposal);
      const target = declarativeAdapterTableDigest(proposal.after);
      if (journal.head.table === target && executionManifestDigest(journal.head.manifest) === executionManifestDigest(candidate)) { this.current(candidate); return; }
      const check = () => {
        this.current(proposal.sourceManifest); this.current(candidate);
        if (!equal(this.retentionSnapshot(), proposal.retained)) throw new Error('retention changed; candidate must be reproved');
        if (journal.head.table !== declarativeAdapterTableDigest(proposal.before) || !equal(journal.head.manifest, proposal.sourceManifest) || !equal(candidate, { ...proposal.sourceManifest, capabilityPolicyDigest: target })) throw new Error('adapter candidate/head policy mismatch');
        const parent = executionManifestDigest(proposal.sourceManifest), child = executionManifestDigest(candidate);
        const sourceIntents = new Set(this.options.lineage.lineage(proposal.sourceManifest.astRoot as NodeRef)
          .filter(row => row.ancestry[0]?.body.executionManifest === parent).map(row => row.intent));
        if (!this.options.lineage.lineage(candidate.astRoot as NodeRef).some(row =>
          row.ancestry[0]?.body.executionManifest === child && row.ancestry[0].body.parents.some(intent => sourceIntents.has(intent))))
          throw new Error('adapter retirement requires new signed descendant intent');
      };
      check(); this.options.beforePublish?.();
      this.options.retentionLedger.withStableRetentions(proposal.retained, () => {
        check();
        if (!journal.proposals.some(item => item.id === proposal.id)) journal.proposals.push(clone(proposal));
        if (!journal.tables.some(table => declarativeAdapterTableDigest(table) === target)) journal.tables.push(clone(proposal.after));
        journal.head = { generation: journal.head.generation + 1, table: target, manifest: candidate };
        this.pin(journal); this.write(journal);
      });
    }, 5000);
  }
  snapshot(): { generation: number; manifest: ExecutionManifestV1; table: DeclarativeAdapterTable; productionAuthorized: false } {
    return this.lock.run(() => { const journal = this.read(); return freeze(clone({ generation: journal.head.generation, manifest: journal.head.manifest, table: journal.tables.find(table => declarativeAdapterTableDigest(table) === journal.head.table)!, productionAuthorized: false as const })); }, 5000);
  }
  historicalTable(id: Digest): DeclarativeAdapterTable { validateDigest(id, 'aether.declarative-adapter-table/1'); const table = this.read().tables.find(item => declarativeAdapterTableDigest(item) === id); if (!table) throw new Error('unknown historical registration table'); return freeze(clone(table)); }
  resolve(name: CapabilityName): DeclarativeAdapterRegistration {
    capability(name); const state = this.snapshot(); this.current(state.manifest); const found = state.table.registrations.find(item => item.capability === name); if (!found) throw new Error('adapter registration is retired or absent'); return found;
  }
}
