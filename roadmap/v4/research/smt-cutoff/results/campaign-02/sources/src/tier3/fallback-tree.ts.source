/** Bounded three-tier pure fallback profile. Durable whole-heap restoration is
 * deliberately distinct from the unqualified <=50 ns native in-frame target.
 * No external effect, closure/task continuation, import or production admission
 * authority is supported by this profile. */
import { createPrivateKey, createPublicKey, sign, verify, randomUUID, type KeyObject } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { children, type Term, type Ty } from '../tier1/ast.ts';
import { capability, type NodeRef, type SymbolId } from '../tier1/ids.ts';
import { decode as decodeIR, encode as encodeIR } from '../tier1/agent-ir.ts';
import { GraphStore } from '../tier1/store.ts';
import { CapabilityRegistry } from '../tier2/ocap.ts';
import { ScopedGrantAuthority, type ScopedGrantV2 } from '../tier2/scoped-grants.ts';
import { typecheck, tyEqual } from '../tier2/typecheck.ts';
import { domainDigest, executionManifestDigest, decodeExecutionManifest, encodeExecutionManifest, type ExecutionManifestV1, type Digest } from '../fabric/identity.ts';
import { decodeCanonical, encodeCanonical, exactObject, identifier, validateTaggedValue, type LogicalRefV1, type TaggedValueV1 } from '../fabric/encoding.ts';
import { validateRuntimeSnapshot, type RuntimeSnapshotV1 } from '../fabric/snapshot.ts';
import { JournalLock } from '../fabric/journal-lock.ts';
import { ProductionRuntime } from './compile.ts';
import { decodeProcessValue, encodeProcessValue, fromWireSnapshot, toWireSnapshot, type ProcessScope } from '../tier4/process-values.ts';
import { validateProcessAllocation, validateProcessArguments, validateProcessResult } from '../tier4/process-type-validation.ts';

export const FALLBACK_INVOKE = capability('cap:fallback:invoke');
export interface FallbackTreeOptions {
  readonly directory: string; readonly module: Term; readonly manifest: ExecutionManifestV1;
  readonly tier1: SymbolId; readonly tier2: SymbolId; readonly grants: ScopedGrantAuthority;
  readonly key: KeyObject | string;
  /** Compiler entry/loop-backedge guard checks, not machine instructions. */
  readonly maxGuardChecks?: number;
  readonly fault?: (phase: 'call-intent' | 'tier1-failed' | 'tier2-failed' | 'before-commit' | 'committed' | 'repair-delivered') => void;
}
export interface FallbackRepairEvent {
  readonly format: 'aether.fallback-repair/1'; readonly id: Digest; readonly operationId: string;
  readonly tier: 1 | 2 | 3; readonly fault: string; readonly manifest: Digest; readonly beforeSnapshot: Digest;
}
export type FallbackResult =
  | { readonly state: 'completed'; readonly tier: 1 | 2; readonly operationId: string; readonly value: TaggedValueV1; readonly productionAuthorized: false }
  | { readonly state: 'aborted'; readonly tier: 3; readonly operationId: string; readonly code: 'fallback_exhausted' | 'authority_denied' | 'interrupted_pure_call'; readonly productionAuthorized: false };
interface Call { operationId: string; requestDigest: Digest; args: readonly TaggedValueV1[]; before: RuntimeSnapshotV1; result: FallbackResult | null; failures: { tier: 1 | 2 | 3; kind: string }[] }
interface Journal { format: 'aether.fallback-tree-journal/1'; profile: Digest; snapshot: RuntimeSnapshotV1; calls: Call[]; repairs: { event: FallbackRepairEvent; acknowledged: boolean }[]; allocations: { id: string; digest: Digest; reference: LogicalRefV1 }[] }
const limits = { maxFrameBytes: 32 * 1024 * 1024, maxDecompressedBytes: 32 * 1024 * 1024, maxObjects: 1_000_000 };
const clone = <T>(value: T): T => decodeCanonical(encodeCanonical(value, limits), limits) as T;
const equal = (a: unknown, b: unknown): boolean => Buffer.from(encodeCanonical(a, limits)).equals(Buffer.from(encodeCanonical(b, limits)));
const hash = (domain: string, value: unknown): Digest => domainDigest(domain, value, limits);
function freeze<T>(value: T): T { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
function sync(path: string): void { const fd = openSync(path, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } }
function ensure(path: string): void { if (existsSync(path)) return; ensure(dirname(path)); try { mkdirSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; } sync(path); sync(dirname(path)); }
function* walk(term: Term): Generator<Term> { yield term; for (const child of children(term)) yield* walk(child); }

const validateFallbackType = (ty: Ty): void => {
      if (['Int', 'IntN', 'Bool', 'Str', 'Unit'].includes(ty.t)) return;
      if (ty.t === 'Nominal') { validateFallbackType(ty.repr); return; }
      if (ty.t === 'Record') { ty.fields.forEach(([, field]) => validateFallbackType(field)); return; }
      throw new TypeError('fallback profile supports only scalars and record-reference state');
    };
export class FallbackTreeRuntime {
  readonly profileDigest: Digest;
  private readonly module: Term;
  private readonly options: FallbackTreeOptions;
  private readonly declarations: readonly Extract<Term, { kind: 'FunctionDecl' }>[];
  private readonly key: KeyObject;
  private readonly directory: string;
  private readonly file: string;
  private readonly lock: JournalLock;
  private readonly delivery: JournalLock;
  private readonly scope: ProcessScope;
  private readonly guardLimit: number;
  constructor(options: FallbackTreeOptions) {
    this.options = { ...options }; this.key = typeof options.key === 'string' ? createPrivateKey(options.key) : options.key;
    if (this.key.type !== 'private' || this.key.asymmetricKeyType !== 'ed25519') throw new TypeError('Ed25519 fallback journal key required');
    const store = new GraphStore(), root = store.intern(options.module); this.module = decodeIR(encodeIR(options.module).text);
    const manifest = decodeExecutionManifest(encodeExecutionManifest(options.manifest)); if (manifest.astRoot !== root) throw new TypeError('fallback manifest/code mismatch');
    const nodes = [...walk(this.module)]; if (nodes.length > 20_000 || nodes.some(node => ['Invoke', 'Spawn', 'Await', 'Lambda', 'Apply', 'Import', 'SeqLit', 'SeqMap', 'SeqFold', 'SeqIndex', 'SeqLength', 'ResultValue', 'MatchResult'].includes(node.kind))) throw new TypeError('fallback pure profile rejects effects, imports and opaque continuations');
    if (this.module.kind !== 'Module' || !typecheck(this.module, { registry: new CapabilityRegistry() }).ok) throw new TypeError('fallback requires a closed well-typed module');
    const declarations = this.module.members.filter((node): node is Extract<Term, { kind: 'FunctionDecl' }> => node.kind === 'FunctionDecl');
    declarations.forEach(node => { node.params.forEach(param => validateFallbackType(param.ty)); validateFallbackType(node.returns); });
    if (declarations.some(node => node.purity !== 'pure' || node.capabilities.length || node.typeParams.length || node.surfaces.length || !node.body)) throw new TypeError('fallback declaration is not closed pure code');
    const one = declarations.find(node => node.symbol === options.tier1), two = declarations.find(node => node.symbol === options.tier2);
    if (!one || !two || one.symbol === two.symbol || !one.contract || !two.contract || store.intern(one.contract) !== store.intern(two.contract) || one.params.length !== two.params.length || one.params.some((p, i) => p.symbol !== two.params[i].symbol || !tyEqual(p.ty, two.params[i].ty)) || !tyEqual(one.returns, two.returns)) throw new TypeError('fallback tiers require identical signature and explicit contract/frame');
    this.declarations = [one, two]; this.guardLimit = options.maxGuardChecks ?? 1000;
    if (!Number.isSafeInteger(this.guardLimit) || this.guardLimit < 1 || this.guardLimit > 100_000) throw new TypeError('invalid fallback guard bound');
    ensure(resolve(options.directory)); this.directory = realpathSync(resolve(options.directory));
    this.profileDigest = hash('aether.pure-fallback-tree/1', { manifest: executionManifestDigest(manifest), tier1: one.symbol, tier2: two.symbol, repositoryId: options.grants.repositoryId, guardLimit: this.guardLimit, directory: this.directory, publicKey: createPublicKey(this.key).export({ type: 'spki', format: 'der' }).toString('base64') });
    this.scope = { executionManifest: executionManifestDigest(manifest), astRoot: root as NodeRef, heapId: `fallback:${this.profileDigest.split(':').at(-1)}`, ownershipEpoch: '0', unit: 'fallback' };
    this.file = join(this.directory, 'fallback.json'); ensure(join(this.directory, 'tickets')); ensure(join(this.directory, 'delivery-tickets'));
    this.lock = new JournalLock({ directory: join(this.directory, 'tickets'), domain: 'aether.fallback-lock' }); this.delivery = new JournalLock({ directory: join(this.directory, 'delivery-tickets'), domain: 'aether.fallback-delivery-lock' });
    this.lock.run(() => {
      const seal = join(this.directory, 'initialized.json');
      if (!existsSync(this.file)) { if (existsSync(seal)) throw new Error('missing established fallback journal'); this.write({ format: 'aether.fallback-tree-journal/1', profile: this.profileDigest, snapshot: toWireSnapshot(this.runtime(() => true).exportSnapshot(), this.scope), calls: [], repairs: [], allocations: [] }, true); }
      const journal = this.read();
      if (!existsSync(seal)) { if (journal.calls.length || journal.allocations.length) throw new Error('missing established fallback seal'); this.publish(seal, encodeCanonical({ profile: this.profileDigest }), true); }
      else if (!equal(decodeCanonical(readFileSync(seal)), { profile: this.profileDigest })) throw new Error('fallback seal mismatch');
      this.recover(journal);
    }, 5000);
  }
  private runtime(guard: () => boolean): ProductionRuntime { return ProductionRuntime.compile(this.module, { registry: new CapabilityRegistry(), policy: 'enforce', executionGuard: guard }); }
  private publish(path: string, bytes: Uint8Array, once = false): void {
    const temporary = join(this.directory, `.fallback-${randomUUID()}`), fd = openSync(temporary, 'wx', 0o600);
    try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
    try { if (once) linkSync(temporary, path); else renameSync(temporary, path); sync(this.directory); } finally { if (existsSync(temporary)) unlinkSync(temporary); }
  }
  private write(journal: Journal, once = false): void { const bytes = encodeCanonical(journal, limits); this.publish(this.file, encodeCanonical({ body: journal, signature: sign(null, bytes, this.key).toString('base64') }, limits), once); }
  private read(): Journal {
    if (statSync(this.file).size > limits.maxFrameBytes) throw new RangeError('fallback journal bound');
    const envelope = exactObject(decodeCanonical(readFileSync(this.file), limits), ['body', 'signature']), body = envelope.body as Journal;
    if (typeof envelope.signature !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(envelope.signature)) throw new Error('forged fallback journal');
    const signature = Buffer.from(envelope.signature, 'base64');
    if (signature.toString('base64') !== envelope.signature || !verify(null, encodeCanonical(body, limits), createPublicKey(this.key), signature)) throw new Error('forged fallback journal');
    exactObject(body, ['format', 'profile', 'snapshot', 'calls', 'repairs', 'allocations']);
    if (body.format !== 'aether.fallback-tree-journal/1' || body.profile !== this.profileDigest || !Array.isArray(body.calls) || !Array.isArray(body.repairs) || !Array.isArray(body.allocations) || body.calls.length + body.allocations.length > 1000) throw new TypeError('fallback journal/profile bound');
    validateRuntimeSnapshot(body.snapshot); fromWireSnapshot(body.snapshot, this.scope);
    if (body.calls.filter(call => call.result === null).length > 1 || body.calls.some((call, index) => call.result === null && index !== body.calls.length - 1)) throw new Error('invalid incomplete fallback history');
    sync(this.directory); return body;
  }
  private authorized(tier: 1 | 2, tokens: readonly ScopedGrantV2[]): boolean {
    return tokens.some(token => this.options.grants.verify(token, { capability: FALLBACK_INVOKE, audience: this.declarations[tier - 1].symbol, path: ['fallback', this.profileDigest.split(':').at(-1)!, String(tier)] }));
  }
  issueTokens(ttlMs = 60_000): readonly ScopedGrantV2[] { return this.declarations.map((decl, index) => this.options.grants.issue({ capability: FALLBACK_INVOKE, audience: decl.symbol, path: ['fallback', this.profileDigest.split(':').at(-1)!, String(index + 1)] }, ttlMs)); }
  private repair(journal: Journal, call: Call, tier: 1 | 2 | 3, kind: string): void {
    call.failures.push({ tier, kind }); const body = { format: 'aether.fallback-repair/1' as const, operationId: call.operationId, tier, fault: kind, manifest: this.scope.executionManifest, beforeSnapshot: hash('aether.fallback-before/1', call.before) };
    const event: FallbackRepairEvent = { ...body, id: hash('aether.fallback-repair/1', body) }; if (!journal.repairs.some(row => row.event.id === event.id)) journal.repairs.push({ event, acknowledged: false });
  }
  private abort(call: Call, code: Extract<FallbackResult, { state: 'aborted' }>['code']): FallbackResult { return { state: 'aborted', tier: 3, operationId: call.operationId, code, productionAuthorized: false }; }
  private recover(journal: Journal): void {
    const incomplete = journal.calls.find(call => call.result === null); if (!incomplete) return;
    journal.snapshot = clone(incomplete.before); this.repair(journal, incomplete, 3, 'interrupted_pure_call'); incomplete.result = this.abort(incomplete, 'interrupted_pure_call'); this.write(journal);
  }
  snapshot(): RuntimeSnapshotV1 { return this.lock.run(() => freeze(clone(this.read().snapshot)), 5000); }
  allocateRecord(ty: Ty, fields: Readonly<Record<string, TaggedValueV1>>, operationId: string): LogicalRefV1 {
    identifier(operationId); const data = clone({ ty, fields }); validateFallbackType(data.ty);
    return this.lock.run(() => {
      const journal = this.read(); this.recover(journal); const request = hash('aether.fallback-allocation/1', data), old = journal.allocations.find(row => row.id === operationId);
      if (old) { if (old.digest !== request) throw new Error('fallback allocation identity conflict'); return freeze(clone(old.reference)); }
      if (journal.calls.some(call => call.operationId === operationId) || journal.calls.length + journal.allocations.length >= 1000) throw new Error('fallback operation identity/capacity conflict');
      validateProcessAllocation(data.ty, data.fields, journal.snapshot); const runtime = this.runtime(() => true); runtime.importSnapshot(fromWireSnapshot(journal.snapshot, this.scope));
      const ref = runtime.allocateRecord(data.ty, Object.fromEntries(Object.entries(data.fields).map(([name, value]) => [name, decodeProcessValue(value, this.scope, journal.snapshot)])));
      journal.snapshot = toWireSnapshot(runtime.exportSnapshot(), this.scope); const encoded = encodeProcessValue(ref, this.scope, journal.snapshot); if (encoded.tag !== 'ref') throw new Error('missing allocated reference');
      journal.allocations.push({ id: operationId, digest: request, reference: encoded.value }); this.write(journal); return freeze(clone(encoded.value));
    }, 5000);
  }
  call(args: readonly TaggedValueV1[], options: { operationId: string; tokens: readonly ScopedGrantV2[] }): FallbackResult {
    identifier(options.operationId); const input = freeze(clone([...args])), tokens = freeze(clone([...options.tokens])), operationId = options.operationId;
    return this.lock.run(() => {
      const journal = this.read(); this.recover(journal);
      if (!this.authorized(1, tokens)) throw new Error('fallback invocation authority denied');
      const requestDigest = hash('aether.fallback-invocation/1', { profile: this.profileDigest, args: input }), old = journal.calls.find(row => row.operationId === operationId);
      if (old) { if (old.requestDigest !== requestDigest) throw new Error('fallback operation identity conflict'); if (old.result?.state === 'completed' && !this.authorized(old.result.tier, tokens)) throw new Error('cached fallback result authority denied'); return freeze(clone(old.result!)); }
      if (journal.allocations.some(row => row.id === operationId) || journal.calls.length + journal.allocations.length >= 1000) throw new Error('fallback operation identity/capacity conflict');
      validateProcessArguments(this.declarations[0], input, journal.snapshot);
      const call: Call = { operationId, requestDigest, args: input, before: clone(journal.snapshot), result: null, failures: [] }; journal.calls.push(call); this.write(journal); this.options.fault?.('call-intent');
      let final: FallbackResult = this.abort(call, 'fallback_exhausted'), next = call.before;
      for (const tier of [1, 2] as const) {
        if (!this.authorized(tier, tokens)) { this.repair(journal, call, tier, 'authority_denied'); final = this.abort(call, 'authority_denied'); break; }
        let remaining = this.guardLimit; const runtime = this.runtime(() => --remaining >= 0 && this.authorized(tier, tokens)); runtime.importSnapshot(fromWireSnapshot(call.before, this.scope));
        const bindings = validateProcessArguments(this.declarations[tier - 1], input, call.before);
        let result: ReturnType<ProductionRuntime['call']> | null = null;
        try { result = runtime.call(this.declarations[tier - 1].symbol, input.map(value => decodeProcessValue(value, this.scope, call.before))); } catch { /* Recoverable pure engine failure; no live state/effect was published. */ }
        if (!this.authorized(tier, tokens)) { this.repair(journal, call, tier, 'authority_denied'); final = this.abort(call, 'authority_denied'); break; }
        if (result?.ok) {
          next = toWireSnapshot(runtime.exportSnapshot(), this.scope); const value = encodeProcessValue(result.value, this.scope, next); validateProcessResult(this.declarations[tier - 1], value, next, bindings);
          final = { state: 'completed', tier, operationId, value, productionAuthorized: false }; break;
        }
        this.repair(journal, call, tier, result?.fault.kind ?? 'runtime_exception'); this.write(journal); this.options.fault?.(tier === 1 ? 'tier1-failed' : 'tier2-failed');
      }
      this.options.fault?.('before-commit');
      if (final.state === 'completed' && !this.authorized(final.tier, tokens)) { this.repair(journal, call, final.tier, 'authority_denied'); final = this.abort(call, 'authority_denied'); }
      journal.snapshot = clone(final.state === 'completed' ? next : call.before); call.result = final; this.write(journal); this.options.fault?.('committed'); return freeze(clone(final));
    }, 5000);
  }
  pendingRepairs(): readonly FallbackRepairEvent[] { return this.lock.run(() => freeze(clone(this.read().repairs.filter(row => !row.acknowledged).map(row => row.event))), 5000); }
  /** Durable at-least-once outbox. Consumers deduplicate event.id; a crash after
   * delivery but before acknowledgment deliberately redelivers the same ID. */
  async drainRepairs(consume: (event: FallbackRepairEvent) => Promise<void>): Promise<number> {
    return this.delivery.runAsync(async () => {
      let delivered = 0;
      for (const event of this.pendingRepairs()) {
        await consume(event); this.options.fault?.('repair-delivered');
        this.lock.run(() => { const journal = this.read(), row = journal.repairs.find(item => item.event.id === event.id); if (!row) throw new Error('missing repair event'); row.acknowledged = true; this.write(journal); }, 5000); delivered++;
      }
      return delivered;
    }, 5000);
  }
}
