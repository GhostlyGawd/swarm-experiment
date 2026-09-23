/** Durable, typed working memory attached to an admitted AST occurrence.
 *
 * The executable AST is immutable. A board is a versioned sidecar bound to one
 * execution manifest and one node in its signed causal lineage. The host owns
 * principal authentication and evidence verification; neither a principal name
 * nor an evidence digest supplied by an agent is authority by itself.
 */
import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { decodeCanonical, encodeCanonical, exactObject, identifier, validString } from '../fabric/encoding.ts';
import { domainDigest, executionManifestDigest, metadataSidecar, validateDigest, type Digest, type ExecutionManifestV1, type MetadataSidecarV1 } from '../fabric/identity.ts';
import { JournalLock } from '../fabric/journal-lock.ts';
import { isNodeRef, type NodeRef } from './ids.ts';
import { CausalLineageLedger, LineageAdmissionError } from './causal-lineage.ts';
import { DurableGraphStore } from './durable-store.ts';

export type BlackboardItem =
  | { readonly kind: 'claim'; readonly text: string; readonly confidence: number }
  | { readonly kind: 'hypothesis'; readonly text: string; readonly confidence: number }
  | { readonly kind: 'decision'; readonly text: string; readonly rationale: string }
  | { readonly kind: 'delegation'; readonly task: string; readonly assignee: string }
  | { readonly kind: 'evidence'; readonly claim: Digest; readonly evidence: Digest; readonly verifier: string };
export interface BlackboardAcl { readonly owner: string; readonly readers: readonly string[]; readonly writers: readonly string[] }
export interface BlackboardPolicy { readonly maxEntries: number; readonly expiresAt: number }
export interface BlackboardEntry { readonly id: Digest; readonly revision: number; readonly actor: string; readonly parents: readonly Digest[]; readonly item: BlackboardItem }
export interface BlackboardView {
  readonly id: Digest; readonly manifest: Digest; readonly subject: NodeRef;
  readonly sidecar: MetadataSidecarV1; readonly sidecarDigest: Digest;
  readonly acl: BlackboardAcl; readonly policy: BlackboardPolicy;
  readonly revision: number; readonly entries: readonly BlackboardEntry[];
  /** Rechecked with the host verifier; unverified claims never appear here. */
  readonly verifiedEvidenceIds: readonly Digest[];
  /** Historical state stays inspectable after a specification is superseded. */
  readonly current: boolean;
}
export interface CognitiveBlackboardOptions {
  readonly directory: string; readonly repositoryId: string;
  readonly store: DurableGraphStore; readonly lineage: CausalLineageLedger;
  /** Trusted host callback; never accept an actor id from the requested item. */
  readonly actor: () => string;
  /** Creation authority is separate from knowing an admitted node address. */
  readonly authorizeCreate: (actor: string, manifest: Digest, subject: NodeRef) => boolean;
  /** Trusted verifier checks the actual artifact, subject and proof at admission. */
  readonly verifyEvidence: (evidence: Digest, manifest: Digest, subject: NodeRef, verifier: string) => boolean;
  readonly now?: () => number;
  readonly maxBytes?: number; readonly waitMs?: number; readonly maxRetentionMs?: number; readonly maxBoards?: number;
}
interface BoardState {
  readonly format: 'aether.blackboard/1'; readonly repositoryId: string;
  readonly id: Digest; readonly nonce: string; readonly manifest: ExecutionManifestV1; readonly subject: NodeRef;
  readonly acl: BlackboardAcl; readonly policy: BlackboardPolicy;
  readonly revision: number; readonly entries: readonly BlackboardEntry[];
}
function boundedText(value: unknown): void { validString(value); if (!value.length || Buffer.byteLength(value) > 16_384) throw new TypeError('invalid blackboard text'); }
function names(value: unknown): asserts value is readonly string[] {
  if (!Array.isArray(value) || value.length > 128) throw new TypeError('invalid blackboard ACL');
  value.forEach(identifier); if (new Set(value).size !== value.length) throw new TypeError('duplicate blackboard principal');
}
function acl(value: unknown): asserts value is BlackboardAcl {
  const a = exactObject(value, ['owner', 'readers', 'writers']); identifier(a.owner); names(a.readers); names(a.writers);
}
function policy(value: unknown): asserts value is BlackboardPolicy {
  const p = exactObject(value, ['maxEntries', 'expiresAt']);
  if (!Number.isSafeInteger(p.maxEntries) || (p.maxEntries as number) < 1 || (p.maxEntries as number) > 10_000 || !Number.isSafeInteger(p.expiresAt) || (p.expiresAt as number) < 1) throw new TypeError('invalid blackboard retention policy');
}
function validateItem(value: unknown): asserts value is BlackboardItem {
  const kind = (value as { kind?: unknown } | null)?.kind;
  if (kind === 'claim' || kind === 'hypothesis') {
    const v = exactObject(value, ['kind', 'text', 'confidence']); boundedText(v.text);
    if (!Number.isSafeInteger(v.confidence) || (v.confidence as number) < 0 || (v.confidence as number) > 10_000) throw new TypeError('invalid uncertainty score');
  } else if (kind === 'decision') { const v = exactObject(value, ['kind', 'text', 'rationale']); boundedText(v.text); boundedText(v.rationale); }
  else if (kind === 'delegation') { const v = exactObject(value, ['kind', 'task', 'assignee']); boundedText(v.task); identifier(v.assignee); }
  else if (kind === 'evidence') { const v = exactObject(value, ['kind', 'claim', 'evidence', 'verifier']); validateDigest(v.claim, 'aether.blackboard-entry/1'); validateDigest(v.evidence); identifier(v.verifier); }
  else throw new TypeError('unknown blackboard item kind');
}
function boardId(repositoryId: string, manifest: Digest, subject: NodeRef, nonce: string): Digest { return domainDigest('aether.blackboard/1', { repositoryId, manifest, subject, nonce }); }
function entryId(board: Digest, actor: string, parents: readonly Digest[], item: BlackboardItem, revision: number): Digest {
  return domainDigest('aether.blackboard-entry/1', { board, actor, parents, item, revision });
}
function validateState(value: unknown, repositoryId: string): asserts value is BoardState {
  const s = exactObject(value, ['format', 'repositoryId', 'id', 'nonce', 'manifest', 'subject', 'acl', 'policy', 'revision', 'entries']);
  if (s.format !== 'aether.blackboard/1' || s.repositoryId !== repositoryId || !isNodeRef(s.subject)) throw new TypeError('invalid blackboard subject/profile');
  identifier(s.nonce);
  const manifest = s.manifest as ExecutionManifestV1, digest = executionManifestDigest(manifest);
  if (s.id !== boardId(repositoryId, digest, s.subject, s.nonce as string)) throw new TypeError('blackboard identity mismatch');
  acl(s.acl); policy(s.policy);
  if (!Number.isSafeInteger(s.revision) || (s.revision as number) < 1 || !Array.isArray(s.entries) || s.entries.length > (s.policy as BlackboardPolicy).maxEntries) throw new TypeError('invalid blackboard revision/retention');
  const ids = new Set<Digest>(); let previous = 0;
  for (const row of s.entries) {
    const e = exactObject(row, ['id', 'revision', 'actor', 'parents', 'item']); identifier(e.actor); if (!Array.isArray(e.parents)) throw new TypeError('invalid blackboard parents');
    e.parents.forEach(parent => validateDigest(parent, 'aether.blackboard-entry/1'));
    if (new Set(e.parents).size !== e.parents.length) throw new TypeError('duplicate blackboard parent');
    validateItem(e.item);
    // The revision is carried in the id to prevent replay at a different slot.
    // Retention may remove a prefix, so the exact revision is stored per row.
    const revision = e.revision as number;
    if (!Number.isSafeInteger(revision) || revision <= previous || revision > (s.revision as number)) throw new TypeError('invalid blackboard entry revision');
    previous = revision;
    if (e.id !== entryId(s.id as Digest, e.actor as string, e.parents as Digest[], e.item as BlackboardItem, revision) || ids.has(e.id as Digest)) throw new TypeError('blackboard entry identity mismatch');
    ids.add(e.id as Digest);
  }
}

/** All mutating operations run under a process-death-recoverable journal lock. */
export class CognitiveBlackboard {
  private readonly options: CognitiveBlackboardOptions;
  private readonly lock: JournalLock;
  private readonly maximum: number;
  private readonly waitMs: number;
  private readonly maxRetentionMs: number;
  private readonly maxBoards: number;
  constructor(options: CognitiveBlackboardOptions) {
    identifier(options.repositoryId);
    this.options = options; this.maximum = options.maxBytes ?? 1024 * 1024; this.waitMs = options.waitMs ?? 10_000;
    this.maxRetentionMs = options.maxRetentionMs ?? 30 * 24 * 60 * 60 * 1000;
    this.maxBoards = options.maxBoards ?? 10_000;
    if (!Number.isSafeInteger(this.maximum) || this.maximum < 4096 || this.maximum > 8 * 1024 * 1024 || !Number.isSafeInteger(this.waitMs) || this.waitMs < 0 || !Number.isSafeInteger(this.maxRetentionMs) || this.maxRetentionMs < 1 || !Number.isSafeInteger(this.maxBoards) || this.maxBoards < 1 || this.maxBoards > 100_000) throw new TypeError('invalid blackboard limits');
    mkdirSync(options.directory, { recursive: true, mode: 0o700 });
    const lockDirectory = join(options.directory, 'lock'); mkdirSync(lockDirectory, { recursive: true, mode: 0o700 });
    this.lock = new JournalLock({ directory: lockDirectory, domain: 'aether.blackboard', maxTickets: 100_000 });
  }
  private actor(): string { const value = this.options.actor(); identifier(value); return value; }
  private now(): number { const value = (this.options.now ?? Date.now)(); if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('invalid trusted clock'); return value; }
  private path(id: Digest): string { validateDigest(id, 'aether.blackboard/1'); return join(this.options.directory, `${id.split(':').at(-1)}.json`); }
  private boardFiles(): string[] {
    const files = readdirSync(this.options.directory).filter(name => /^[0-9a-f]{64}\.json$/.test(name));
    if (files.length > this.maxBoards) throw new RangeError('blackboard count limit');
    return files;
  }
  private read(id: Digest): BoardState {
    const path = this.path(id); if (statSync(path).size > this.maximum) throw new RangeError('blackboard byte limit');
    const envelope = exactObject(decodeCanonical(readFileSync(path), { maxFrameBytes: this.maximum, maxDecompressedBytes: this.maximum }), ['format', 'state', 'checksum']);
    if (envelope.format !== 'aether.blackboard-record/1' || envelope.checksum !== domainDigest('aether.blackboard-record/1', envelope.state)) throw new TypeError('corrupt blackboard record');
    validateState(envelope.state, this.options.repositoryId); if (envelope.state.id !== id) throw new TypeError('blackboard path mismatch');
    return envelope.state;
  }
  private save(state: BoardState): void {
    validateState(state, this.options.repositoryId);
    const bytes = encodeCanonical({ format: 'aether.blackboard-record/1', state, checksum: domainDigest('aether.blackboard-record/1', state) }, { maxFrameBytes: this.maximum, maxDecompressedBytes: this.maximum });
    const path = this.path(state.id), temporary = join(this.options.directory, `.blackboard-${process.pid}-${randomUUID()}.tmp`);
    const fd = openSync(temporary, 'wx', 0o600); try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
    try { renameSync(temporary, path); const dir = openSync(dirname(path), 'r'); try { fsyncSync(dir); } finally { closeSync(dir); } }
    finally { if (existsSync(temporary)) unlinkSync(temporary); }
  }
  private permitted(state: BoardState, actor: string, write: boolean): void {
    if (this.now() >= state.policy.expiresAt) throw new Error('blackboard retention expired');
    if (actor !== state.acl.owner && !(write ? state.acl.writers : [...state.acl.readers, ...state.acl.writers]).includes(actor)) throw new Error('blackboard access denied');
  }
  private bound(manifest: ExecutionManifestV1, subject: NodeRef): Digest {
    const digest = executionManifestDigest(manifest); this.options.lineage.assertNodeCurrent(digest, subject);
    this.options.store.get(subject);
    return digest;
  }
  create(manifest: ExecutionManifestV1, subject: NodeRef, readers: readonly string[], writers: readonly string[], retention: BlackboardPolicy): Digest {
    const actor = this.actor(), digest = executionManifestDigest(manifest); names(readers); names(writers); policy(retention);
    if (this.options.authorizeCreate(actor, digest, subject) !== true) throw new Error('blackboard creation denied');
    this.bound(manifest, subject);
    if (this.now() >= retention.expiresAt || retention.expiresAt - this.now() > this.maxRetentionMs) throw new Error('blackboard retention outside host policy');
    const nonce = randomUUID(), id = boardId(this.options.repositoryId, digest, subject, nonce);
    this.lock.recoverDeadWriter(false);
    return this.lock.run(() => {
      if (this.boardFiles().length >= this.maxBoards) throw new RangeError('blackboard count limit');
      if (existsSync(this.path(id))) { const existing = this.read(id); this.permitted(existing, actor, true); throw new Error('blackboard already exists'); }
      this.save({ format: 'aether.blackboard/1', repositoryId: this.options.repositoryId, id, nonce, manifest, subject, acl: { owner: actor, readers, writers }, policy: retention, revision: 1, entries: [] });
      return id;
    }, this.waitMs);
  }
  append(id: Digest, item: BlackboardItem, parents: readonly Digest[] = [], expectedRevision?: number): BlackboardEntry {
    const actor = this.actor(); encodeCanonical(item); validateItem(item);
    if (!Array.isArray(parents) || new Set(parents).size !== parents.length) throw new TypeError('invalid blackboard parents');
    parents.forEach(parent => validateDigest(parent, 'aether.blackboard-entry/1'));
    this.lock.recoverDeadWriter(false);
    return this.lock.run(() => {
      const state = this.read(id); this.permitted(state, actor, true); this.bound(state.manifest, state.subject);
      if (expectedRevision !== undefined && state.revision !== expectedRevision) throw new Error('blackboard revision conflict');
      const known = new Set(state.entries.map(entry => entry.id));
      if (parents.some(parent => !known.has(parent))) throw new ReferenceError('unknown or retained-away blackboard parent');
      if (item.kind === 'evidence') {
        if (!known.has(item.claim) || !state.entries.some(entry => entry.id === item.claim && (entry.item.kind === 'claim' || entry.item.kind === 'hypothesis'))) throw new TypeError('evidence must cite a retained claim or hypothesis');
        if (!parents.includes(item.claim)) throw new TypeError('evidence must causally depend on its claim');
        if (this.options.verifyEvidence(item.evidence, executionManifestDigest(state.manifest), state.subject, item.verifier) !== true) throw new Error('blackboard evidence not verified');
      }
      const revision = state.revision + 1;
      const entry = { id: entryId(id, actor, parents, item, revision), actor, parents, item, revision };
      const entries = [...state.entries, entry].slice(-state.policy.maxEntries);
      this.save({ ...state, revision, entries }); return entry;
    }, this.waitMs);
  }
  view(id: Digest): BlackboardView {
    const actor = this.actor(), state = this.read(id); this.permitted(state, actor, false);
    let current = true;
    try { this.bound(state.manifest, state.subject); }
    catch (error) { if (error instanceof LineageAdmissionError) current = false; else throw error; }
    const manifest = executionManifestDigest(state.manifest);
    const payload = { board: id, revision: state.revision, entries: state.entries };
    const { sidecar, digest } = metadataSidecar(state.subject, 'scratchpad', '1', { manifest, ...payload });
    const retained = new Set(state.entries.map(entry => entry.id));
    const verifiedEvidenceIds = current ? state.entries.filter(entry => entry.item.kind === 'evidence' && retained.has(entry.item.claim) && this.options.verifyEvidence(entry.item.evidence, manifest, state.subject, entry.item.verifier) === true).map(entry => entry.id) : [];
    return { id, manifest, subject: state.subject, sidecar, sidecarDigest: digest, acl: state.acl, policy: state.policy, revision: state.revision, entries: state.entries, verifiedEvidenceIds, current };
  }
  /** Discover retained sidecars for a node without exposing other agents' boards. */
  listForNode(manifest: ExecutionManifestV1, subject: NodeRef): readonly Digest[] {
    const actor = this.actor(), manifestDigest = executionManifestDigest(manifest);
    const visible: Digest[] = [];
    for (const name of this.boardFiles()) {
      const id = `aether.blackboard/1:b3:${name.slice(0, -5)}`;
      const state = this.read(id);
      if (state.subject !== subject || executionManifestDigest(state.manifest) !== manifestDigest) continue;
      try { this.permitted(state, actor, false); visible.push(id); }
      catch (error) { if (!(error instanceof Error) || !/^(blackboard access denied|blackboard retention expired)$/.test(error.message)) throw error; }
    }
    return visible.sort();
  }
  configure(id: Digest, nextAcl: BlackboardAcl, nextPolicy: BlackboardPolicy, expectedRevision: number): void {
    const actor = this.actor(); acl(nextAcl); policy(nextPolicy);
    this.lock.recoverDeadWriter(false);
    this.lock.run(() => {
      const state = this.read(id); this.permitted(state, actor, true); this.bound(state.manifest, state.subject);
      if (actor !== state.acl.owner || nextAcl.owner !== actor) throw new Error('only owner may configure blackboard');
      if (state.revision !== expectedRevision) throw new Error('blackboard revision conflict');
      if (this.now() >= nextPolicy.expiresAt || nextPolicy.expiresAt > state.policy.expiresAt || nextPolicy.maxEntries > state.policy.maxEntries) throw new Error('blackboard retention cannot be extended');
      this.save({ ...state, acl: nextAcl, policy: nextPolicy, revision: state.revision + 1, entries: state.entries.slice(-nextPolicy.maxEntries) });
    }, this.waitMs);
  }
  /** Delete expired records; calls after expiry cannot recover their contents. */
  sweep(id: Digest): boolean {
    const actor = this.actor(); this.lock.recoverDeadWriter(false);
    return this.lock.run(() => {
      const state = this.read(id);
      if (actor !== state.acl.owner) throw new Error('only owner may sweep blackboard');
      if (this.now() < state.policy.expiresAt) return false;
      unlinkSync(this.path(id)); const dir = openSync(this.options.directory, 'r'); try { fsyncSync(dir); } finally { closeSync(dir); }
      return true;
    }, this.waitMs);
  }
}
