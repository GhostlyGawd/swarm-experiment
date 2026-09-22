/** Strict-profile causal lineage. Immutable signed intent/specification records
 * are separate from v1 executable hashes, so shared nodes retain every causal
 * link. Currentness is derived from version pins; no API can clear invalidation
 * without newly signed intent and freshly admitted evidence.
 *
 * Lock order: coordinator -> lineage -> deployment -> ProcessHost -> AST store.
 * This module never calls a coordinator or deployment. Production callers must
 * use admissionAdapter() and call its checkpoint immediately before commit.
 */
import { createPrivateKey, createPublicKey, randomUUID, sign, verify, type KeyObject } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { children, type Term } from './ast.ts';
import { GraphStore } from './store.ts';
import { DurableGraphStore } from './durable-store.ts';
import { isNodeRef, type NodeRef, type SymbolId } from './ids.ts';
import { decodeCanonical, encodeCanonical, exactObject, identifier } from '../fabric/encoding.ts';
import { domainDigest, executionManifestDigest, validateDigest, type Digest, type ExecutionManifestV1 } from '../fabric/identity.ts';
import { validateEvidence, validateVettedEvidence, type EvidenceContext, type LocalEvidenceV1, type VettedEvidence } from '../fabric/evidence.ts';
import { JournalLock } from '../fabric/journal-lock.ts';
import type { PromotionBindingV1 } from '../fabric/promotion.ts';

export interface LineageAuthority { readonly policyEpoch: string; readonly eligibleAuthors: readonly string[] }
export interface SpecReference { readonly id: string; readonly revision: Digest }
/** Immutable formal contract pins. Keeping the original input domain prevents
 * vacuous fence discharge by strengthening a replacement's preconditions. */
export interface FenceRequirement {
  readonly symbol: SymbolId;
  readonly signature: Digest;
  readonly requires: readonly NodeRef[];
  readonly modifies: readonly NodeRef[];
  readonly ensures: readonly NodeRef[];
}
export interface SpecRevisionBody {
  readonly repositoryId: string; readonly id: string; readonly revision: number;
  readonly previous: Digest | null; readonly parents: readonly SpecReference[];
  readonly text: string; readonly requirements: readonly FenceRequirement[];
  readonly author: string; readonly policyEpoch: string; readonly nonce: string;
}
export interface SignedSpecRevision { readonly format: 'aether.signed-spec/1'; readonly body: SpecRevisionBody; readonly signature: string }
export interface IntentBody {
  readonly repositoryId: string; readonly subject: NodeRef; readonly executionManifest: Digest; readonly evidenceBundleDigest: Digest;
  readonly parents: readonly Digest[]; readonly specifications: readonly SpecReference[];
  readonly purpose: 'genesis' | 'rewrite' | 'derive' | 'import'; readonly text: string;
  readonly author: string; readonly policyEpoch: string; readonly nonce: string;
}
export interface SignedIntent { readonly format: 'aether.signed-intent/1'; readonly body: IntentBody; readonly signature: string }
export interface ArtifactLineageRecord {
  readonly id: Digest; readonly intent: Digest; readonly manifest: ExecutionManifestV1;
  readonly evidence: LocalEvidenceV1; readonly specifications: readonly SpecReference[];
  readonly nodes: readonly NodeRef[];
}
export interface LineageInvalidation { readonly reason: 'InvalidatedSpec' | 'InvalidatedPolicy'; readonly artifact: Digest; readonly root: NodeRef; readonly specifications: readonly string[] }
/** Expected admission/currentness failures are distinct from corrupt records,
 * invalid signatures, malformed authority responses and filesystem failures. */
export class LineageAdmissionError extends Error {
  readonly code:'InvalidatedSpec'|'InvalidatedPolicy'|'UnadmittedArtifact';
  constructor(code:LineageAdmissionError['code'],message:string){super(message);this.name='LineageAdmissionError';this.code=code;}
}
export interface StrictLineageAdmission {
  readonly profile: 'aether.strict-lineage-admission/1';
  withAdmission<T>(binding: PromotionBindingV1, evidence: VettedEvidence, operation: (checkpoint: () => void) => Promise<T>): Promise<T>;
  assertCurrent(manifest: Digest): void;
}
const admissionAdapters = new WeakMap<object, string>();
export function validateStrictLineageAdmission(value: unknown, repositoryId?: string): asserts value is StrictLineageAdmission {
  if (!value || typeof value !== 'object' || !admissionAdapters.has(value) || (repositoryId !== undefined && admissionAdapters.get(value) !== repositoryId)) throw new TypeError('untrusted strict lineage admission adapter');
}
export type LineageFault = 'before-state-publish' | 'after-state-publish';
export interface CausalLineageOptions {
  readonly directory: string; readonly repositoryId: string; readonly store: DurableGraphStore;
  readonly authority: () => LineageAuthority;
  /** Historical enrolled public keys, independently trusted by the application. */
  readonly authorKey: (author: string, policyEpoch: string) => KeyObject | string | undefined;
  readonly maxRecords?: number; readonly maxBytes?: number; readonly maxTickets?: number;
  readonly fault?: (point: LineageFault) => void;
}
interface State {
  readonly format: 'aether.causal-lineage/1'; readonly repositoryId: string;
  readonly profile: { maxRecords: number; maxBytes: number; maxTickets: number };
  revision: number; specs: SignedSpecRevision[]; intents: SignedIntent[]; artifacts: ArtifactLineageRecord[];
}
const same = (a: unknown, b: unknown): boolean => Buffer.from(encodeCanonical(a)).equals(Buffer.from(encodeCanonical(b)));
const clone = <T>(value: T): T => decodeCanonical(encodeCanonical(value)) as T;
const number = (value: unknown): number => { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new TypeError('invalid lineage revision'); return value; };
const node = (value: unknown): NodeRef => { if (!isNodeRef(value)) throw new TypeError('invalid lineage AST reference'); return value; };
function references(value: unknown): asserts value is readonly SpecReference[] {
  if (!Array.isArray(value)) throw new TypeError('invalid specification references');
  const seen = new Set<string>();
  for (const item of value) { const ref = exactObject(item, ['id', 'revision']); identifier(ref.id); validateDigest(ref.revision, 'aether.spec-revision/1'); if (seen.has(ref.id)) throw new TypeError('duplicate specification identity'); seen.add(ref.id); }
}
function requirement(value: unknown): asserts value is FenceRequirement {
  const item = exactObject(value, ['symbol', 'signature', 'requires', 'modifies', 'ensures']); identifier(item.symbol); validateDigest(item.signature, 'aether.fence-signature/1');
  for (const list of [item.requires, item.modifies, item.ensures]) { if (!Array.isArray(list)) throw new TypeError('invalid fence clauses'); list.forEach(node); if (new Set(list).size !== list.length) throw new TypeError('duplicate fence clause'); }
  if (!(item.ensures as unknown[]).length) throw new TypeError('formal fence requires a postcondition');
}
function validateSpec(value: unknown): asserts value is SignedSpecRevision {
  const record = exactObject(value, ['format', 'body', 'signature']);
  const body = exactObject(record.body, ['repositoryId', 'id', 'revision', 'previous', 'parents', 'text', 'requirements', 'author', 'policyEpoch', 'nonce']);
  if (record.format !== 'aether.signed-spec/1') throw new TypeError('unsupported signed specification');
  for (const key of ['repositoryId', 'id', 'author', 'policyEpoch', 'nonce']) identifier(body[key]); number(body.revision);
  if (body.previous !== null) validateDigest(body.previous, 'aether.spec-revision/1'); references(body.parents);
  if (typeof body.text !== 'string' || !body.text.length || !Array.isArray(body.requirements)) throw new TypeError('invalid specification body');
  body.requirements.forEach(requirement);
  if (new Set(body.requirements.map(item => item.symbol)).size !== body.requirements.length) throw new TypeError('duplicate fence function');
  signature(record.signature);
}
function validateIntent(value: unknown): asserts value is SignedIntent {
  const record = exactObject(value, ['format', 'body', 'signature']);
  const body = exactObject(record.body, ['repositoryId', 'subject', 'executionManifest', 'evidenceBundleDigest', 'parents', 'specifications', 'purpose', 'text', 'author', 'policyEpoch', 'nonce']);
  if (record.format !== 'aether.signed-intent/1') throw new TypeError('unsupported signed intent');
  for (const key of ['repositoryId', 'author', 'policyEpoch', 'nonce']) identifier(body[key]); node(body.subject); validateDigest(body.executionManifest, 'aether.execution/1'); validateDigest(body.evidenceBundleDigest, 'aether.evidence-bundle/1');
  if (!Array.isArray(body.parents)) throw new TypeError('invalid intent parents'); body.parents.forEach(parent => validateDigest(parent, 'aether.intent/1'));
  if (new Set(body.parents).size !== body.parents.length) throw new TypeError('duplicate intent parent'); references(body.specifications);
  if (!['genesis', 'rewrite', 'derive', 'import'].includes(String(body.purpose)) || typeof body.text !== 'string' || !body.text.length) throw new TypeError('invalid intent body');
  signature(record.signature);
}
function signature(value: unknown): asserts value is string { if (typeof value !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(value) || Buffer.from(value, 'base64').toString('base64') !== value) throw new TypeError('invalid lineage signature'); }
function signatureBytes(format: string, body: unknown): Uint8Array { return encodeCanonical({ domain: `${format}-signature`, body }); }
function signingKey(key: KeyObject | string): KeyObject { const object = typeof key === 'string' ? createPrivateKey(key) : key; if (object.type !== 'private' || object.asymmetricKeyType !== 'ed25519') throw new TypeError('Ed25519 lineage signing key required'); return object; }
export function signSpecRevision(body: SpecRevisionBody, key: KeyObject | string): SignedSpecRevision {
  const value: SignedSpecRevision = { format: 'aether.signed-spec/1', body: clone(body), signature: sign(null, signatureBytes('aether.signed-spec/1', body), signingKey(key)).toString('base64') }; validateSpec(value); return value;
}
export function signIntent(body: IntentBody, key: KeyObject | string): SignedIntent {
  const value: SignedIntent = { format: 'aether.signed-intent/1', body: clone(body), signature: sign(null, signatureBytes('aether.signed-intent/1', body), signingKey(key)).toString('base64') }; validateIntent(value); return value;
}
export function specRevisionDigest(value: SignedSpecRevision): Digest { validateSpec(value); return domainDigest('aether.spec-revision/1', value); }
export function intentDigest(value: SignedIntent): Digest { validateIntent(value); return domainDigest('aether.intent/1', value); }
export function fenceRequirement(decl: Term): FenceRequirement {
  if (decl.kind !== 'FunctionDecl' || decl.contract?.kind !== 'Contract') throw new TypeError('formal fenced function required');
  const contract = decl.contract;
  for (const clause of [...contract.requires, ...contract.ensures]) if (clause.kind !== 'Clause' || clause.rigor !== 'formal') throw new TypeError('fence cannot rely on property clauses');
  const store = new GraphStore();
  const value = { symbol: decl.symbol,
    signature: domainDigest('aether.fence-signature/1', { params: decl.params, returns: decl.returns, typeParams: decl.typeParams, capabilities: decl.capabilities, purity: decl.purity }),
    requires: contract.requires.map(term => store.intern(term)), modifies: contract.modifies.map(term => store.intern(term)), ensures: contract.ensures.map(term => store.intern(term)),
  };
  requirement(value); return value;
}
function sync(path: string): void { const fd = openSync(path, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } }
function directory(path: string): void { if (existsSync(path)) { if (!statSync(path).isDirectory()) throw new TypeError('lineage path is not a directory'); return; } directory(dirname(path)); try { mkdirSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; } sync(path); sync(dirname(path)); }

export class CausalLineageLedger {
  private readonly options: CausalLineageOptions;
  private readonly profile: State['profile'];
  private readonly lock: JournalLock;
  private readonly file: string;
  constructor(options: CausalLineageOptions) {
    identifier(options.repositoryId); this.options = options;
    this.profile = { maxRecords: options.maxRecords ?? 10_000, maxBytes: options.maxBytes ?? 32 * 1024 * 1024, maxTickets: options.maxTickets ?? 100_000 };
    Object.values(this.profile).forEach(number);
    directory(options.directory); directory(join(options.directory, 'lock'));
    this.file = join(options.directory, 'lineage.json');
    this.lock = new JournalLock({ directory: join(options.directory, 'lock'), domain: 'aether.causal-lineage', maxTickets: this.profile.maxTickets });
    this.run(() => {
      const complete = join(options.directory, 'initialized.json');
      if (!existsSync(this.file)) {
        if (existsSync(complete)) throw new Error('missing initialized lineage state');
        this.write({ format: 'aether.causal-lineage/1', repositoryId: options.repositoryId, profile: this.profile, revision: 0, specs: [], intents: [], artifacts: [] });
      }
      const state = this.read();
      const marker = { format: 'aether.lineage-initialized/1', repositoryId: options.repositoryId, profile: this.profile };
      if (existsSync(complete)) { if (!same(this.decode(this.readBytes(complete)), marker)) throw new TypeError('lineage initialization marker mismatch'); }
      else {
        if (state.revision !== 0 || state.specs.length || state.intents.length || state.artifacts.length) throw new Error('missing lineage completion marker');
        this.publish(complete, this.encode(marker));
      }
    });
  }
  private encode(value: unknown): Uint8Array { return encodeCanonical(value, { maxFrameBytes: this.profile.maxBytes, maxDecompressedBytes: this.profile.maxBytes, maxObjects: this.profile.maxRecords * 1024, maxDepth: 128 }); }
  private decode(bytes: Uint8Array): unknown { return decodeCanonical(bytes, { maxFrameBytes: this.profile.maxBytes, maxDecompressedBytes: this.profile.maxBytes, maxObjects: this.profile.maxRecords * 1024, maxDepth: 128 }); }
  private readBytes(path: string): Uint8Array { if (statSync(path).size > this.profile.maxBytes) throw new RangeError('lineage journal size limit'); return readFileSync(path); }
  private run<T>(operation: () => T): T { this.lock.recoverDeadWriter(false); return this.lock.run(operation, 10_000); }
  private publish(path: string, bytes: Uint8Array): void {
    const temporary = join(this.options.directory, `.lineage-${process.pid}-${randomUUID()}`), fd = openSync(temporary, 'wx', 0o600);
    try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
    try { renameSync(temporary, path); sync(this.options.directory); } finally { if (existsSync(temporary)) unlinkSync(temporary); }
  }
  private write(state: State): void {
    if (state.specs.length + state.intents.length + state.artifacts.length > this.profile.maxRecords) throw new RangeError('lineage record limit');
    const bytes = this.encode({ checksum: domainDigest('aether.lineage-state/1', state, { maxFrameBytes: this.profile.maxBytes, maxDecompressedBytes: this.profile.maxBytes, maxDepth: 128, maxObjects: this.profile.maxRecords * 1024 }), state });
    this.options.fault?.('before-state-publish'); this.publish(this.file, bytes); this.options.fault?.('after-state-publish');
  }
  private advance(state: State): void { if (state.revision >= Number.MAX_SAFE_INTEGER) throw new RangeError('lineage revision exhausted'); state.revision++; this.write(state); }
  private authority(): LineageAuthority {
    const authority = clone(this.options.authority());
    exactObject(authority, ['policyEpoch', 'eligibleAuthors']); identifier(authority.policyEpoch);
    if (!Array.isArray(authority.eligibleAuthors) || new Set(authority.eligibleAuthors).size !== authority.eligibleAuthors.length) throw new TypeError('invalid lineage authority author list');
    authority.eligibleAuthors.forEach(identifier);
    return authority;
  }
  private verify(record: SignedIntent | SignedSpecRevision, current = false): void {
    if (record.format === 'aether.signed-intent/1') validateIntent(record); else validateSpec(record);
    if (record.body.repositoryId !== this.options.repositoryId) throw new TypeError('lineage repository mismatch');
    const enrolled = this.options.authorKey(record.body.author, record.body.policyEpoch); if (!enrolled) throw new TypeError('unknown lineage author');
    const key = typeof enrolled === 'string' ? createPublicKey(enrolled) : enrolled.type === 'private' ? createPublicKey(enrolled) : enrolled;
    if (key.asymmetricKeyType !== 'ed25519' || !verify(null, signatureBytes(record.format, record.body), key, Buffer.from(record.signature, 'base64'))) throw new TypeError('invalid lineage author signature');
    if (current) {
      const authority = this.authority();
      if (authority.policyEpoch !== record.body.policyEpoch || !authority.eligibleAuthors.includes(record.body.author)) throw new LineageAdmissionError('InvalidatedPolicy','stale lineage policy or revoked author');
    }
  }
  private read(): State {
    const wrapper = exactObject(this.decode(this.readBytes(this.file)), ['checksum', 'state']);
    const value = exactObject(wrapper.state, ['format', 'repositoryId', 'profile', 'revision', 'specs', 'intents', 'artifacts']);
    if (value.format !== 'aether.causal-lineage/1' || value.repositoryId !== this.options.repositoryId || !same(value.profile, this.profile) || !Number.isSafeInteger(value.revision) || (value.revision as number) < 0 || !Array.isArray(value.specs) || !Array.isArray(value.intents) || !Array.isArray(value.artifacts)) throw new TypeError('invalid lineage state profile');
    if (value.specs.length + value.intents.length + value.artifacts.length > this.profile.maxRecords) throw new RangeError('lineage record limit');
    if (wrapper.checksum !== domainDigest('aether.lineage-state/1', wrapper.state, { maxFrameBytes: this.profile.maxBytes, maxDecompressedBytes: this.profile.maxBytes, maxDepth: 128, maxObjects: this.profile.maxRecords * 1024 })) throw new TypeError('lineage state checksum mismatch');
    const state = value as unknown as State;
    const specs = new Map<Digest, SignedSpecRevision>(), heads = new Map<string, SignedSpecRevision>();
    for (const record of state.specs) {
      this.verify(record); const id = specRevisionDigest(record), old = heads.get(record.body.id);
      if (specs.has(id) || record.body.previous !== (old ? specRevisionDigest(old) : null) || record.body.revision !== (old?.body.revision ?? 0) + 1) throw new TypeError('invalid specification history');
      for (const parent of record.body.parents) if (specs.get(parent.revision)?.body.id !== parent.id) throw new TypeError('missing specification parent');
      specs.set(id, record); heads.set(record.body.id, record);
    }
    const intents = new Set<Digest>();
    for (const record of state.intents) {
      this.verify(record); const id = intentDigest(record);
      if (intents.has(id) || record.body.parents.some(parent => !intents.has(parent))) throw new TypeError('missing or duplicate intent parent');
      for (const parent of record.body.specifications) if (specs.get(parent.revision)?.body.id !== parent.id) throw new TypeError('missing intent specification');
      intents.add(id);
    }
    const artifacts = new Set<Digest>();
    for (const record of state.artifacts) {
      exactObject(record, ['id', 'intent', 'manifest', 'evidence', 'specifications', 'nodes']); validateDigest(record.id, 'aether.lineage-artifact/1');
      if (!intents.has(record.intent) || artifacts.has(record.id)) throw new TypeError('invalid artifact lineage link');
      references(record.specifications); if (!Array.isArray(record.nodes)) throw new TypeError('invalid artifact node closure'); record.nodes.forEach(node);
      const { id, ...body } = record; if (id !== domainDigest('aether.lineage-artifact/1', body)) throw new TypeError('corrupt artifact lineage');
      const intent = state.intents.find(item => intentDigest(item) === record.intent)!;
      if (intent.body.executionManifest !== executionManifestDigest(record.manifest) || intent.body.subject !== record.manifest.astRoot || !record.nodes.includes(node(record.manifest.astRoot))) throw new TypeError('artifact lineage subject mismatch');
      if (intent.body.evidenceBundleDigest !== domainDigest('aether.evidence-bundle/1', record.evidence) || !same(record.evidence.manifest, record.manifest)) throw new TypeError('signed artifact evidence mismatch');
      const effective = this.effectiveSpecs(state, intent.body.parents, intent.body.specifications);
      if (!same(effective, record.specifications) || record.manifest.specRoot !== domainDigest('aether.specification/1', this.specificationText(state, effective))) throw new TypeError('artifact specification linkage mismatch');
      if (!same(record.nodes, this.artifactClosure(record.manifest))) throw new TypeError('artifact AST causal closure mismatch');
      artifacts.add(record.id);
    }
    return state;
  }
  private specMap(state: State): Map<Digest, SignedSpecRevision> { return new Map(state.specs.map(record => [specRevisionDigest(record), record])); }
  private intentMap(state: State): Map<Digest, SignedIntent> { return new Map(state.intents.map(record => [intentDigest(record), record])); }
  private currentSpecs(state: State): Map<string, Digest> { return new Map(state.specs.map(record => [record.body.id, specRevisionDigest(record)])); }
  private ancestors(state: State, roots: readonly Digest[]): SignedIntent[] {
    const map = this.intentMap(state), result: SignedIntent[] = [], seen = new Set<Digest>(), pending = [...roots];
    while (pending.length) { const id = pending.pop()!; if (seen.has(id)) continue; const record = map.get(id); if (!record) throw new TypeError('unknown causal intent'); seen.add(id); result.push(record); pending.push(...record.body.parents); }
    return result;
  }
  private effectiveSpecs(state: State, parents: readonly Digest[], direct: readonly SpecReference[]): SpecReference[] {
    references(direct);
    const selected = new Map<string, Digest>(), overrides = new Map(direct.map(item => [item.id, item.revision]));
    // Nearest signed intent overrides inherited versions explicitly. Direct
    // reconciliation preserves old records while selecting a current revision.
    const needed = new Set(this.ancestors(state, parents).map(intentDigest));
    const memo = new Map<Digest, Map<string, Digest>>();
    // Journal order is causal. Iteration avoids deep recursive lineage chains
    // and memoization prevents exponential expansion of shared ancestry.
    for (const record of state.intents) {
      const recordId = intentDigest(record); if (!needed.has(recordId)) continue;
      const result = new Map<string, Digest>(), own = new Map(record.body.specifications.map(item => [item.id, item.revision]));
      for (const parent of record.body.parents) {
        const inherited = memo.get(parent); if (!inherited) throw new TypeError('noncausal intent history');
        for (const [name, revision] of inherited) {
          if (result.has(name) && result.get(name) !== revision && !own.has(name) && !overrides.has(name)) throw new TypeError('ambiguous inherited specification versions');
          result.set(name, revision);
        }
      }
      for (const [name, revision] of own) result.set(name, revision);
      memo.set(recordId, result);
    }
    for (const parent of parents) for (const [id, revision] of memo.get(parent) ?? []) {
      if (selected.has(id) && selected.get(id) !== revision && !overrides.has(id)) throw new TypeError('ambiguous inherited specification'); selected.set(id, revision);
    }
    for (const [id, revision] of overrides) selected.set(id, revision);
    const specs = this.specMap(state), pending = [...selected].map(([id, revision]) => ({ id, revision })), closure = new Map<string, Digest>();
    while (pending.length) {
      const reference = pending.pop()!, record = specs.get(reference.revision);
      if (!record || record.body.id !== reference.id) throw new TypeError('unknown specification revision');
      if (closure.has(reference.id)) { if (closure.get(reference.id) !== reference.revision) throw new TypeError('conflicting transitive specification revision'); continue; }
      closure.set(reference.id, reference.revision); pending.push(...record.body.parents);
    }
    return [...closure].sort(([a], [b]) => a < b ? -1 : 1).map(([id, revision]) => ({ id, revision }));
  }
  private specificationText(state: State, specs: readonly SpecReference[]): string {
    const map = this.specMap(state);
    return Buffer.from(this.encode({ format: 'aether.lineage-specification/1', repositoryId: this.options.repositoryId, specifications: specs.map(item => ({ id: item.id, revision: item.revision, text: map.get(item.revision)!.body.text, requirements: map.get(item.revision)!.body.requirements })) })).toString('utf8');
  }
  private requireCurrentSpecs(state: State, specs: readonly SpecReference[]): void { const current = this.currentSpecs(state); if (specs.some(item => current.get(item.id) !== item.revision)) throw new LineageAdmissionError('InvalidatedSpec','InvalidatedSpec: stale specification dependency'); }
  private closure(root: NodeRef): NodeRef[] {
    const result = new Set<NodeRef>(), pending = [root];
    while (pending.length) { const next = pending.pop()!; if (result.has(next)) continue; if (result.size >= this.options.store.limits.maxNodes) throw new RangeError('lineage AST closure limit'); result.add(next); pending.push(...children(this.options.store.get(next))); }
    return [...result].sort();
  }
  private artifactRoots(manifest: ExecutionManifestV1): NodeRef[] { return [...new Set([node(manifest.astRoot), ...manifest.dependencies.map(item => node(item.declaration))])]; }
  private artifactClosure(manifest: ExecutionManifestV1): NodeRef[] { return [...new Set(this.artifactRoots(manifest).flatMap(root => this.closure(root)))].sort(); }
  publishSpec(input: SignedSpecRevision): Digest {
    const record = clone(input); this.verify(record, true); const id = specRevisionDigest(record);
    return this.run(() => {
      const state = this.read(); this.verify(record, true);
      if (state.specs.some(item => specRevisionDigest(item) === id)) return id;
      const old = [...state.specs].reverse().find(item => item.body.id === record.body.id);
      if (record.body.previous !== (old ? specRevisionDigest(old) : null) || record.body.revision !== (old?.body.revision ?? 0) + 1) throw new Error('specification compare-and-swap conflict');
      const parentSpecs = this.effectiveSpecs(state, [], record.body.parents); this.requireCurrentSpecs(state, parentSpecs);
      if (parentSpecs.some(item => item.id === record.body.id)) throw new TypeError('cyclic specification dependency');
      const roots = record.body.requirements.flatMap(item => [...item.requires, ...item.modifies, ...item.ensures]);
      if (roots.length) this.options.store.retain(`lineage-spec:${id}`, roots);
      state.specs.push(record); this.verify(record, true); this.advance(state); return id;
    });
  }
  specification(parents: readonly Digest[], specs: readonly SpecReference[]): string {
    const state = this.read(), effective = this.effectiveSpecs(state, parents, specs); this.requireCurrentSpecs(state, effective); return this.specificationText(state, effective);
  }
  recordIntent(input: SignedIntent): Digest {
    const record = clone(input); this.verify(record, true); const id = intentDigest(record);
    return this.run(() => {
      const state = this.read(); this.verify(record, true); if (state.intents.some(item => intentDigest(item) === id)) return id;
      const specs = this.effectiveSpecs(state, record.body.parents, record.body.specifications);
      if (!specs.length) throw new TypeError('intent requires an authorized specification'); this.requireCurrentSpecs(state, specs);
      this.options.store.retain(`lineage-intent:${id}`, [record.body.subject]);
      state.intents.push(record); this.verify(record, true); this.advance(state); return id;
    });
  }
  private fences(state: State, specs: readonly SpecReference[], evidence: VettedEvidence, module: Term): void {
    validateVettedEvidence(evidence, evidence.manifest);
    if (module.kind !== 'Module') throw new TypeError('lineage requires a full candidate module');
    const map = this.specMap(state), functions = new Map(module.members.filter((item): item is Extract<Term, { kind: 'FunctionDecl' }> => item.kind === 'FunctionDecl').map(item => [item.symbol, item]));
    for (const dependency of evidence.manifest.dependencies) {
      const declaration = this.options.store.hydrate(node(dependency.declaration));
      if (declaration.kind !== 'FunctionDecl' || declaration.symbol !== dependency.symbol) throw new TypeError('fenced dependency declaration mismatch');
      if (!functions.has(declaration.symbol)) functions.set(declaration.symbol, declaration);
    }
    for (const spec of specs) for (const expected of map.get(spec.revision)!.body.requirements) {
      const decl = functions.get(expected.symbol); if (!decl) throw new Error('fenced function cannot be pruned');
      const actual = fenceRequirement(decl);
      if (actual.signature !== expected.signature || !same(actual.requires, expected.requires) || !same(actual.modifies, expected.modifies) || expected.ensures.some(clause => !actual.ensures.includes(clause))) throw new Error('replacement does not preserve the signed parent specification fence');
      const report = evidence.reports.get(expected.symbol);
      if (!report || report.verdict !== 'proved' || report.results.some(result => result.obligation.rigor === 'formal' && result.verdict !== 'proved')) throw new Error('fence requires exact-root proved evidence');
    }
  }
  admitArtifact(intent: Digest, evidenceInput: LocalEvidenceV1, context: EvidenceContext): Digest {
    validateDigest(intent, 'aether.intent/1');
    // Admission re-verifies deserialized F06 evidence. A stored JSON verdict is
    // never accepted as a proof capability or fence discharge by itself.
    const evidence = clone(evidenceInput), vetted = validateEvidence(evidence, context);
    return this.run(() => {
      const state = this.read(), record = this.intentMap(state).get(intent); if (!record) throw new TypeError('unknown artifact intent'); this.verify(record, true);
      if (record.body.executionManifest !== vetted.manifestDigest || record.body.subject !== vetted.manifest.astRoot) throw new Error('signed intent does not authorize this artifact');
      const specifications = this.effectiveSpecs(state, record.body.parents, record.body.specifications); this.requireCurrentSpecs(state, specifications);
      if (vetted.manifest.specRoot !== domainDigest('aether.specification/1', this.specificationText(state, specifications))) throw new Error('evidence specification does not match signed lineage');
      if (record.body.evidenceBundleDigest !== domainDigest('aether.evidence-bundle/1', evidence)) throw new Error('signed intent does not authorize this evidence bundle');
      const module = this.options.store.hydrate(node(vetted.manifest.astRoot));
      if (module.kind !== 'Module') throw new TypeError('artifact lineage requires a module');
      const locals = new Map(module.members.filter((item): item is Extract<Term, { kind: 'FunctionDecl' }> => item.kind === 'FunctionDecl').map(item => [item.symbol, item]));
      for (const dependency of vetted.manifest.dependencies) {
        const declaration = locals.get(dependency.symbol as SymbolId) ?? context.resolveDeclaration?.(dependency.symbol as SymbolId);
        if (!declaration || declaration.kind !== 'FunctionDecl' || declaration.symbol !== dependency.symbol || new GraphStore().intern(declaration) !== dependency.declaration) throw new TypeError('artifact dependency content changed after verification');
        const root = this.options.store.intern(declaration, { leaseId: `lineage-dependency:${dependency.declaration}` });
        if (root !== dependency.declaration) throw new TypeError('artifact dependency identity mismatch');
      }
      this.fences(state, specifications, vetted, module);
      const nodes = this.artifactClosure(vetted.manifest);
      const body = { intent, manifest: clone(vetted.manifest), evidence, specifications, nodes };
      const id = domainDigest('aether.lineage-artifact/1', body);
      if (state.artifacts.some(item => item.id === id)) return id;
      this.options.store.retain(`lineage-artifact:${id}`, this.artifactRoots(vetted.manifest));
      state.artifacts.push({ id, ...body }); this.verify(record, true); this.advance(state); return id;
    });
  }
  lineage(root: NodeRef): readonly { readonly artifact: Digest; readonly intent: Digest; readonly ancestry: readonly SignedIntent[] }[] {
    node(root); const state = this.read();
    return state.artifacts.filter(record => record.nodes.includes(root)).map(record => ({ artifact: record.id, intent: record.intent, ancestry: this.ancestors(state, [record.intent]) }));
  }
  invalidation(root?: NodeRef): readonly LineageInvalidation[] {
    if (root !== undefined) node(root);
    const state = this.read(), current = this.currentSpecs(state), intents = this.intentMap(state), result: LineageInvalidation[] = [];
    for (const record of state.artifacts) {
      if (root && !record.nodes.includes(root)) continue;
      const stale = record.specifications.filter(spec => current.get(spec.id) !== spec.revision).map(spec => spec.id);
      if (stale.length) result.push({ reason: 'InvalidatedSpec', artifact: record.id, root: node(record.manifest.astRoot), specifications: stale });
      else { try { this.verify(intents.get(record.intent)!, true); } catch { result.push({ reason: 'InvalidatedPolicy', artifact: record.id, root: node(record.manifest.astRoot), specifications: [] }); } }
    }
    return result;
  }
  private currentArtifact(state: State, manifest: Digest): ArtifactLineageRecord[] {
    validateDigest(manifest, 'aether.execution/1');
    const found = state.artifacts.filter(record => executionManifestDigest(record.manifest) === manifest);
    if (!found.length) throw new LineageAdmissionError('UnadmittedArtifact','production artifact lacks signed intent and admitted evidence');
    const intents = this.intentMap(state);
    const current: ArtifactLineageRecord[] = [];
    let rejected: unknown;
    for (const record of found) {
      try { this.verify(intents.get(record.intent)!, true); this.requireCurrentSpecs(state, record.specifications); current.push(record); }
      catch (error) { rejected = error; }
    }
    if (!current.length) throw rejected;
    return current;
  }
  assertCurrent(manifest: Digest): void { this.currentArtifact(this.read(), manifest); }
  admissionAdapter(): StrictLineageAdmission {
    const adapter: StrictLineageAdmission = Object.freeze({ profile: 'aether.strict-lineage-admission/1' as const,
      assertCurrent: (manifest: Digest) => this.assertCurrent(manifest),
      withAdmission: async <T>(binding: PromotionBindingV1, evidence: VettedEvidence, operation: (checkpoint: () => void) => Promise<T>): Promise<T> => {
        this.lock.recoverDeadWriter(false);
        return this.lock.runAsync(async () => {
          let checked = false;
          const checkpoint = (): void => {
            const state = this.read(); validateVettedEvidence(evidence, binding.manifest);
            if (binding.proposal.repositoryId !== this.options.repositoryId || binding.proposal.policyEpoch !== this.authority().policyEpoch) throw new Error('lineage promotion repository/policy epoch mismatch');
            if (evidence.manifestDigest !== binding.proposal.candidateManifest) throw new Error('lineage promotion evidence mismatch');
            const parents = state.artifacts.filter(record => executionManifestDigest(record.manifest) === binding.proposal.expectedParent);
            if (!parents.length) throw new Error('production parent lacks signed lineage');
            const signedIntents = this.intentMap(state);
            const candidate = this.currentArtifact(state, binding.proposal.candidateManifest).filter(record => signedIntents.get(record.intent)!.body.evidenceBundleDigest === binding.proposal.evidenceBundleDigest);
            if (!candidate.length) throw new Error('promotion evidence bundle lacks exact signed intent authorization');
            const ancestors = new Set(candidate.flatMap(record => this.ancestors(state, [record.intent]).map(intentDigest)));
            if (parents.some(record => !ancestors.has(record.intent))) throw new Error('replacement dropped parent causal links');
            const module = this.options.store.hydrate(node(binding.manifest.astRoot));
            for (const record of candidate) this.fences(state, record.specifications, evidence, module);
            checked = true;
          };
          checkpoint(); checked = false;
          const result = await operation(checkpoint);
          if (!checked) throw new Error('strict lineage precommit checkpoint was not called');
          checkpoint(); return result;
        }, 10_000);
      },
    });
    admissionAdapters.set(adapter, this.options.repositoryId); return adapter;
  }
}
