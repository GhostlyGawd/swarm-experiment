/** Durable, effect-aware fallback over one ProcessHost state domain.
 * This process supervisor is deliberately not the native <=50 ns F06 path.
 * It never starts Tier 2 after a possible Tier 1 external commit. */
import { createPrivateKey, createPublicKey, randomUUID, sign, verify, type KeyObject } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { Term } from '../tier1/ast.ts';
import type { SymbolId } from '../tier1/ids.ts';
import { decode as decodeIR, encode as encodeIR } from '../tier1/agent-ir.ts';
import { GraphStore } from '../tier1/store.ts';
import { tyEqual } from '../tier2/typecheck.ts';
import { decimal, decodeCanonical, encodeCanonical, exactObject, identifier, validateTaggedValue, type TaggedValueV1 } from '../fabric/encoding.ts';
import { decodeExecutionManifest, encodeExecutionManifest, domainDigest, executionManifestDigest, validateDigest, type Digest, type ExecutionManifestV1 } from '../fabric/identity.ts';
import { JournalLock } from '../fabric/journal-lock.ts';
import { runtimeSnapshotDigest } from '../fabric/snapshot.ts';
import { checkConservativeFallbackProof, type ConservativeFallbackProofInput } from '../tier3/fallback-proof.ts';
import { ProcessHost, type ProcessHostCallResult, type ProcessInvocationGrant, type ProcessOperationEffectDisposition } from './process-host.ts';

export interface ProcessFallbackOptions {
  readonly directory: string;
  readonly host: ProcessHost;
  readonly module: Term;
  readonly manifest: ExecutionManifestV1;
  readonly tier1: SymbolId;
  readonly tier2: SymbolId;
  /** Trusted durable journal signing key; retain it across coordinator restarts. */
  readonly key: KeyObject | string;
  /** Supply fresh grants on every tier attempt and cached successful response. */
  readonly tokensFor: (tier: 1 | 2, symbol: SymbolId) => readonly ProcessInvocationGrant[];
  /** Opt-in V2: exact portable proof of a pure conservative Tier 2. */
  readonly conservativeProof?: ConservativeFallbackProofInput;
  readonly fault?: (phase: 'intent' | 'tier1-failed' | 'tier2-failed' | 'before-final' | 'final' | 'repair-delivered') => void;
}
export interface ProcessFallbackRepairEvent {
  readonly format: 'aether.process-fallback-repair/1';
  readonly id: Digest;
  readonly profile: Digest;
  readonly operationId: string;
  readonly tier: 1 | 2;
  readonly hostOperationId: string;
  readonly fault: string;
  readonly disposition: Digest;
  readonly beforeSnapshot: Digest;
}
export type ProcessFallbackResult =
  | { readonly state: 'completed'; readonly tier: 1 | 2; readonly operationId: string; readonly value: TaggedValueV1; readonly productionAuthorized: false }
  | { readonly state: 'aborted'; readonly tier: 3; readonly operationId: string; readonly code: 'fallback_exhausted' | 'authority_denied'; readonly productionAuthorized: false }
  | { readonly state: 'blocked'; readonly tier: 1 | 2; readonly operationId: string; readonly code: 'effect_reconciliation_required' | 'state_changed' | 'recovery_required' | 'host_unavailable' | 'authority_denied_after_commit'; readonly productionAuthorized: false };
interface Call {
  operationId: string; requestDigest: Digest; args: TaggedValueV1[];
  beforeSnapshot: Digest; generation: string; result: ProcessFallbackResult | null;
}
interface Journal {
  format: 'aether.process-fallback-journal/1' | 'aether.process-fallback-journal/2'; profile: Digest;
  calls: Call[]; repairs: { event: ProcessFallbackRepairEvent; acknowledged: boolean }[];
}
const LIMITS = { maxFrameBytes: 8 * 1024 * 1024, maxDecompressedBytes: 8 * 1024 * 1024, maxObjects: 100_000 };
const copy = <T>(value: T): T => decodeCanonical(encodeCanonical(value, LIMITS), LIMITS) as T;
function freeze<T>(value: T): T { if (value && typeof value === 'object') { for (const item of Object.values(value)) freeze(item); Object.freeze(value); } return value; }
function sync(path: string): void { const fd = openSync(path, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } }
function ensure(path: string): void { if (existsSync(path)) return; ensure(dirname(path)); try { mkdirSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; } sync(path); sync(dirname(path)); }
function same(left: unknown, right: unknown): boolean { return Buffer.from(encodeCanonical(left, LIMITS)).equals(Buffer.from(encodeCanonical(right, LIMITS))); }
function declaration(module: Term, symbol: SymbolId): Extract<Term, { kind: 'FunctionDecl' }> {
  if (module.kind !== 'Module') throw new TypeError('fallback requires a module');
  const result = module.members.find((member): member is Extract<Term, { kind: 'FunctionDecl' }> => member.kind === 'FunctionDecl' && member.symbol === symbol);
  if (!result) throw new TypeError('fallback tier declaration missing'); return result;
}

export class ProcessFallbackSupervisor {
  readonly profileDigest: Digest;
  readonly conservativeProofDigest: Digest | null;
  private readonly directory: string;
  private readonly file: string;
  private readonly key: KeyObject;
  private readonly lock: JournalLock;
  private readonly delivery: JournalLock;
  private readonly options: ProcessFallbackOptions;
  private readonly symbols: readonly [SymbolId, SymbolId];

  constructor(options: ProcessFallbackOptions) {
    const key = typeof options.key === 'string' ? createPrivateKey(options.key) : options.key;
    if (key.type !== 'private' || key.asymmetricKeyType !== 'ed25519') throw new TypeError('Ed25519 fallback journal key required');
    const module = decodeIR(encodeIR(options.module).text), manifest = decodeExecutionManifest(encodeExecutionManifest(options.manifest));
    if (new GraphStore().intern(module) !== manifest.astRoot) throw new TypeError('fallback manifest/code mismatch');
    const identity = options.host.fallbackIdentity();
    if (identity.manifest !== executionManifestDigest(manifest)) throw new TypeError('fallback host/manifest mismatch');
    const one = declaration(module, options.tier1), two = declaration(module, options.tier2), store = new GraphStore();
    const proved = options.conservativeProof !== undefined;
    if (one.symbol === two.symbol || !one.body || !two.body || !one.contract || !two.contract
      || store.intern(one.contract) !== store.intern(two.contract)
      || one.params.length !== two.params.length || one.params.some((param, index) => param.symbol !== two.params[index].symbol || !tyEqual(param.ty, two.params[index].ty))
      || !tyEqual(one.returns, two.returns)
      || (proved ? two.purity !== 'pure' || two.capabilities.length !== 0
        : one.purity !== two.purity || !same(one.capabilities, two.capabilities))
      || !same(one.typeParams, two.typeParams) || !same(one.surfaces, two.surfaces))
      throw new TypeError('fallback tiers require identical signature, capabilities and explicit contract/frame');
    this.conservativeProofDigest = proved
      ? checkConservativeFallbackProof(module, manifest, two.symbol, options.conservativeProof!) : null;
    if (typeof options.tokensFor !== 'function') throw new TypeError('fallback requires a current grant source');
    ensure(resolve(options.directory)); this.directory = realpathSync(resolve(options.directory)); this.file = join(this.directory, 'fallback.json');
    this.key = key; this.options = Object.freeze({ ...options }); this.symbols = Object.freeze([one.symbol, two.symbol]);
    this.profileDigest = domainDigest(proved ? 'aether.process-fallback-profile/2' : 'aether.process-fallback-profile/1', { host: identity.configuration, hostStorage: identity.storage, manifest: identity.manifest,
      tier1: one.symbol, tier2: two.symbol, directory: this.directory, signer: createPublicKey(key).export({ type: 'spki', format: 'der' }).toString('base64'),
      ...(proved ? { conservativeProof: this.conservativeProofDigest } : {}) });
    this.lock = new JournalLock({ directory: join(this.directory, 'tickets'), domain: 'aether.process-fallback-lock' });
    this.delivery = new JournalLock({ directory: join(this.directory, 'delivery-tickets'), domain: 'aether.process-fallback-delivery-lock' });
    this.lock.run(() => {
      const seal = join(this.directory, 'initialized.json');
      if (!existsSync(this.file)) { if (existsSync(seal)) throw new Error('missing established fallback journal'); this.write({ format: proved ? 'aether.process-fallback-journal/2' : 'aether.process-fallback-journal/1', profile: this.profileDigest, calls: [], repairs: [] }, true); }
      this.read();
      if (!existsSync(seal)) this.publish(seal, encodeCanonical({ profile: this.profileDigest }, LIMITS), true);
      else if (!same(decodeCanonical(readFileSync(seal), LIMITS), { profile: this.profileDigest })) throw new Error('fallback seal mismatch');
    }, 5000);
  }
  private publish(path: string, bytes: Uint8Array, once = false): void {
    const temporary = join(this.directory, `.fallback-${randomUUID()}`), fd = openSync(temporary, 'wx', 0o600);
    try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
    try { if (once) linkSync(temporary, path); else renameSync(temporary, path); sync(this.directory); }
    finally { if (existsSync(temporary)) unlinkSync(temporary); }
  }
  private write(journal: Journal, once = false): void {
    const bytes = encodeCanonical(journal, LIMITS);
    this.publish(this.file, encodeCanonical({ body: journal, signature: sign(null, bytes, this.key).toString('base64') }, LIMITS), once);
  }
  private read(): Journal {
    if (statSync(this.file).size > LIMITS.maxFrameBytes) throw new RangeError('fallback journal bound');
    const envelope = exactObject(decodeCanonical(readFileSync(this.file), LIMITS), ['body', 'signature']);
    if (typeof envelope.signature !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(envelope.signature)) throw new Error('forged fallback journal');
    const signature = Buffer.from(envelope.signature, 'base64'), body = envelope.body as Journal;
    if (signature.toString('base64') !== envelope.signature || !verify(null, encodeCanonical(body, LIMITS), createPublicKey(this.key), signature)) throw new Error('forged fallback journal');
    exactObject(body, ['format', 'profile', 'calls', 'repairs']);
    if (body.format !== (this.conservativeProofDigest ? 'aether.process-fallback-journal/2' : 'aether.process-fallback-journal/1') || body.profile !== this.profileDigest || !Array.isArray(body.calls) || !Array.isArray(body.repairs) || body.calls.length > 1000 || body.repairs.length > 2000) throw new Error('fallback journal/profile bound');
    const ids = new Set<string>(), repairs = new Set<string>();
    for (const call of body.calls) {
      exactObject(call, ['operationId', 'requestDigest', 'args', 'beforeSnapshot', 'generation', 'result']);
      identifier(call.operationId); if (ids.has(call.operationId)) throw new Error('duplicate fallback operation'); ids.add(call.operationId);
      if (!Array.isArray(call.args) || call.requestDigest !== this.requestDigest(call.args)) throw new Error('corrupt fallback call intent');
      validateDigest(call.beforeSnapshot); decimal(call.generation);
      call.args.forEach(value => validateTaggedValue(value));
      if (call.result) {
        const result = call.result;
        if (result.state === 'completed') {
          exactObject(result, ['state', 'tier', 'operationId', 'value', 'productionAuthorized']);
          if (![1, 2].includes(result.tier)) throw new Error('corrupt fallback result');
          validateTaggedValue(result.value);
        } else if (result.state === 'aborted') {
          exactObject(result, ['state', 'tier', 'operationId', 'code', 'productionAuthorized']);
          if (result.tier !== 3 || !['fallback_exhausted', 'authority_denied'].includes(result.code)) throw new Error('corrupt fallback result');
        } else throw new Error('corrupt fallback result');
        if (result.operationId !== call.operationId || result.productionAuthorized !== false) throw new Error('corrupt fallback result');
      }
    }
    for (const row of body.repairs) {
      exactObject(row, ['event', 'acknowledged']);
      const { id, ...event } = row.event;
      exactObject(row.event, ['format', 'id', 'profile', 'operationId', 'tier', 'hostOperationId', 'fault', 'disposition', 'beforeSnapshot']);
      if (row.acknowledged !== true && row.acknowledged !== false || repairs.has(id) || id !== domainDigest('aether.process-fallback-repair/1', event)
        || event.format !== 'aether.process-fallback-repair/1' || event.profile !== this.profileDigest || !ids.has(event.operationId)
        || ![1, 2].includes(event.tier) || event.hostOperationId !== this.hostOperationId(event.operationId, event.tier)) throw new Error('corrupt fallback repair');
      repairs.add(id);
    }
    return body;
  }
  private requestDigest(args: readonly TaggedValueV1[]): Digest { return domainDigest('aether.process-fallback-call/1', { profile: this.profileDigest, args }); }
  private hostOperationId(operationId: string, tier: 1 | 2): string {
    return domainDigest('aether.process-fallback-tier/1', { profile: this.profileDigest, operationId, tier });
  }
  private tokens(tier: 1 | 2): readonly ProcessInvocationGrant[] {
    const tokens = freeze(copy([...this.options.tokensFor(tier, this.symbols[tier - 1]) ]));
    this.options.host.authorizeInvocation(this.symbols[tier - 1], tokens); return tokens;
  }
  private cached(call: Call): ProcessFallbackResult {
    const result = call.result!;
    for (const tier of [1, 2] as const) {
      const id = this.hostOperationId(call.operationId, tier), disposition = this.options.host.operationEffectDisposition(id);
      if (disposition?.possibleExternalCommit && (result.state !== 'completed' || result.tier !== tier))
        return this.blocked(call, tier, 'effect_reconciliation_required');
    }
    // The root invocation authority is required even for an old Tier 2
    // receipt or a terminal abort; a cached result is not a grant.
    this.tokens(1);
    if (result.state === 'completed') {
      if (result.tier === 2) this.tokens(2);
      const host = this.options.host.operationResult(this.hostOperationId(call.operationId, result.tier));
      if (!host || host.state !== 'completed' || !host.execution.ok || !same(host.execution.value, result.value))
        throw new Error('cached fallback result lacks exact host outcome');
    }
    return freeze(copy(result));
  }
  private repair(journal: Journal, call: Call, tier: 1 | 2, fault: string, disposition: ProcessOperationEffectDisposition): void {
    const body = { format: 'aether.process-fallback-repair/1' as const, profile: this.profileDigest, operationId: call.operationId,
      tier, hostOperationId: this.hostOperationId(call.operationId, tier), fault, disposition: disposition.evidenceDigest, beforeSnapshot: call.beforeSnapshot };
    const event = { ...body, id: domainDigest('aether.process-fallback-repair/1', body) };
    if (!journal.repairs.some(row => row.event.id === event.id)) { journal.repairs.push({ event, acknowledged: false }); this.write(journal); }
  }
  private blocked(call: Call, tier: 1 | 2, code: Extract<ProcessFallbackResult, { state: 'blocked' }>['code']): ProcessFallbackResult {
    return { state: 'blocked', tier, operationId: call.operationId, code, productionAuthorized: false };
  }
  private finish(journal: Journal, call: Call, result: Exclude<ProcessFallbackResult, { state: 'blocked' }>): ProcessFallbackResult {
    this.options.fault?.('before-final'); call.result = result; this.write(journal); this.options.fault?.('final'); return freeze(copy(result));
  }
  private async stage(call: Call, tier: 1 | 2): Promise<{ result: ProcessHostCallResult; disposition: ProcessOperationEffectDisposition } | ProcessFallbackResult> {
    const host = this.options.host, id = this.hostOperationId(call.operationId, tier), symbol = this.symbols[tier - 1];
    let result = host.operationResult(id), disposition = host.operationEffectDisposition(id);
    const reconcilePossible = async (): Promise<boolean> => {
      if (!this.conservativeProofDigest || result?.state !== 'indeterminate' || !disposition?.possibleExternalCommit) return true;
      try {
        result = await host.recoverOperation(id, { strategy: 'isolated-replay', reconcileBroker: true });
        disposition = host.operationEffectDisposition(id);
        return disposition !== null;
      } catch { return false; }
    };
    if (!await reconcilePossible()) return this.blocked(call, tier, 'effect_reconciliation_required');
    // A revoked grant cannot turn a possibly committed external action into a
    // harmless Tier 3 abort. Inspect the durable effect decision first.
    if (result && disposition?.possibleExternalCommit && (result.state !== 'completed' || !result.execution.ok))
      return this.blocked(call, tier, 'effect_reconciliation_required');
    let tokens: readonly ProcessInvocationGrant[];
    try { tokens = this.tokens(tier); }
    catch {
      if (result?.state === 'completed' && result.execution.ok) return this.blocked(call, tier, 'authority_denied_after_commit');
      if (result?.state === 'indeterminate') {
        if (!disposition?.safeToAbortBeforeEffects) return this.blocked(call, tier, 'effect_reconciliation_required');
        try { result = await host.recoverOperation(id, { strategy: 'abort-before-effects' }); }
        catch { return this.blocked(call, tier, 'recovery_required'); }
        if (result.state !== 'aborted') return this.blocked(call, tier, 'recovery_required');
      }
      return { state: 'aborted', tier: 3, operationId: call.operationId, code: 'authority_denied', productionAuthorized: false };
    }
    if (!result) {
      try { result = await host.call(symbol, call.args, { operationId: id, tokens, expectedSnapshot: call.beforeSnapshot, expectedGeneration: call.generation }); }
      catch (error) {
        result = host.operationResult(id);
        if (!result) {
          if (String(error).includes('stale_process_fallback_base')) return this.blocked(call, tier, 'state_changed');
          throw error;
        }
      }
    }
    disposition = host.operationEffectDisposition(id);
    if (!disposition) return this.blocked(call, tier, 'host_unavailable');
    if (!await reconcilePossible()) return this.blocked(call, tier, 'effect_reconciliation_required');
    if (!disposition) return this.blocked(call, tier, 'host_unavailable');
    if (result.state === 'indeterminate') {
      if (!disposition.safeToAbortBeforeEffects) return this.blocked(call, tier, 'effect_reconciliation_required');
      try { result = await host.recoverOperation(id, { strategy: 'abort-before-effects' }); }
      catch { return this.blocked(call, tier, 'recovery_required'); }
      disposition = host.operationEffectDisposition(id);
      if (!disposition || result.state !== 'aborted' || !disposition.safeToAbortBeforeEffects) return this.blocked(call, tier, 'recovery_required');
    }
    return { result, disposition };
  }
  async call(args: readonly TaggedValueV1[], options: { operationId: string }): Promise<ProcessFallbackResult> {
    identifier(options.operationId); args.forEach(value => validateTaggedValue(value)); const input = freeze(copy([...args]));
    return this.lock.runAsync(async () => {
      const journal = this.read(), requestDigest = this.requestDigest(input);
      let call = journal.calls.find(row => row.operationId === options.operationId);
      if (call && call.requestDigest !== requestDigest) throw new Error('fallback operation identity conflict');
      if (call?.result) {
        return this.cached(call);
      }
      if (!call) {
        if (journal.calls.length >= 1000) throw new RangeError('fallback call capacity');
        // Deny before creating an operation identity. An unauthenticated
        // request must not receive a non-durable terminal receipt.
        this.tokens(1);
        const before = await this.options.host.snapshot();
        call = { operationId: options.operationId, requestDigest, args: input, beforeSnapshot: runtimeSnapshotDigest(before), generation: this.options.host.generation, result: null };
        journal.calls.push(call); this.write(journal); this.options.fault?.('intent');
      }
      for (const tier of [1, 2] as const) {
        const outcome = await this.stage(call, tier);
        if ('state' in outcome) {
          if (outcome.state === 'aborted') return this.finish(journal, call, outcome);
          return freeze(copy(outcome));
        }
        const { result, disposition } = outcome;
        if (result.state === 'completed' && result.execution.ok) {
          return this.finish(journal, call, { state: 'completed', tier, operationId: call.operationId, value: result.execution.value, productionAuthorized: false });
        }
        if (!disposition.safeToAbortBeforeEffects) return freeze(this.blocked(call, tier, 'effect_reconciliation_required'));
        if (runtimeSnapshotDigest(await this.options.host.snapshot()) !== call.beforeSnapshot || this.options.host.generation !== call.generation)
          return freeze(this.blocked(call, tier, 'state_changed'));
        const fault = result.state === 'completed' && !result.execution.ok ? result.execution.fault.kind : 'interrupted_before_effects';
        this.repair(journal, call, tier, fault, disposition); this.options.fault?.(tier === 1 ? 'tier1-failed' : 'tier2-failed');
      }
      return this.finish(journal, call, { state: 'aborted', tier: 3, operationId: call.operationId, code: 'fallback_exhausted', productionAuthorized: false });
    }, 5000);
  }
  pendingRepairs(): readonly ProcessFallbackRepairEvent[] {
    return this.lock.run(() => freeze(copy(this.read().repairs.filter(row => !row.acknowledged).map(row => row.event))), 5000);
  }
  /** At-least-once durable outbox; consumers deduplicate by event.id. */
  async drainRepairs(consume: (event: ProcessFallbackRepairEvent) => Promise<void>): Promise<number> {
    return this.delivery.runAsync(async () => {
      let delivered = 0;
      for (const event of this.pendingRepairs()) {
        await consume(event); this.options.fault?.('repair-delivered');
        this.lock.run(() => { const journal = this.read(), row = journal.repairs.find(item => item.event.id === event.id);
          if (!row) throw new Error('missing fallback repair'); row.acknowledged = true; this.write(journal); }, 5000); delivered++;
      }
      return delivered;
    }, 5000);
  }
}
