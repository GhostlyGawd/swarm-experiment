/** Durable linear budget substrate for FR-2.5. This module neither meters a
 * host effect nor proves a static exhaustion branch. Trusted integration must
 * provide authenticated principals and independently validated charge/noncommit
 * evidence. A started reservation has no timeout/rollback refund path. */
import { createPrivateKey, createPublicKey, sign, verify, randomUUID, type KeyObject } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { JournalLock } from '../fabric/journal-lock.ts';
import { decodeCanonical, decimal, encodeCanonical, exactObject, identifier, validateTaggedValue, type TaggedValueV1 } from '../fabric/encoding.ts';
import { domainDigest, validateDigest, type Digest } from '../fabric/identity.ts';
import { assertBudgetJournalWitness, readBudgetJournalHead, type BudgetJournalWitness } from '../fabric/budget-journal-witness.ts';
import { BudgetJournalMirror } from './budget-journal-mirror.ts';

export const RESOURCE_BUDGET_PROFILE = 'aether.resource-budget/1' as const;
/** Fixed indivisible units, with no implicit exchange rate or floating point.
 * memoryBytes meters cumulative allocations; reusable resident-memory leases
 * require a distinct future profile and cannot refund committed consumption. */
export interface ResourceAmounts { readonly usdMicros: string; readonly tokens: string; readonly nanoseconds: string; readonly memoryBytes: string }
export interface ResourceBudgetProfile {
  readonly format: typeof RESOURCE_BUDGET_PROFILE; readonly ledgerId: string;
  readonly policyEpoch: string; readonly initialOwner: string; readonly initial: ResourceAmounts;
  readonly maxOperations: number;
}
export interface ResourceBinding {
  readonly executionId: string; readonly effectId: string; readonly executionManifest: Digest;
  readonly payloadDigest: Digest; readonly policyEpoch: string;
}
export interface ResourceHandleBody {
  readonly format: 'aether.resource-handle/1'; readonly ledgerDigest: Digest; readonly id: Digest;
  readonly owner: string; readonly state: 'available' | 'reserved' | 'inflight';
  readonly amounts: ResourceAmounts; readonly binding: ResourceBinding | null;
}
export interface ResourceHandle { readonly body: ResourceHandleBody; readonly signature: string }
export type ResourceOperation =
  | { readonly kind: 'split'; readonly handle: ResourceHandle; readonly parts: readonly ResourceAmounts[] }
  | { readonly kind: 'merge'; readonly handles: readonly ResourceHandle[] }
  | { readonly kind: 'transfer'; readonly handle: ResourceHandle; readonly owner: string }
  | { readonly kind: 'reserve'; readonly handle: ResourceHandle; readonly amounts: ResourceAmounts; readonly binding: ResourceBinding; readonly start: boolean }
  | { readonly kind: 'start'; readonly handle: ResourceHandle }
  | { readonly kind: 'consume'; readonly handle: ResourceHandle; readonly charge: ResourceAmounts; readonly evidence: TaggedValueV1 }
  | { readonly kind: 'refund'; readonly handle: ResourceHandle; readonly evidence: TaggedValueV1 | null };
export interface ResourceRequest { readonly format: 'aether.resource-operation/1'; readonly operationId: string; readonly actor: string; readonly operation: ResourceOperation }
export interface ResourceReceipt {
  readonly format: 'aether.resource-receipt/1'; readonly ledgerDigest: Digest;
  readonly sequence: number; readonly requestDigest: Digest; readonly operationId: string;
  readonly status: 'applied' | 'exhausted'; readonly handles: readonly ResourceHandle[];
  readonly charged: ResourceAmounts; readonly refunded: ResourceAmounts;
}
export type ResourceBudgetFault = 'after-genesis' | 'after-initial-journal' | 'after-initialization-seal' | 'before-write' | 'after-file-sync' | 'before-commit' | 'after-witness-commit' | 'after-commit' | 'after-directory-sync';
export interface ResourceAuthorization {
  readonly ledgerDigest: Digest; readonly policyEpoch: string; readonly actor: string;
  readonly owner: string; readonly purpose: ResourceOperation['kind'] | 'inspect' | 'genesis';
  readonly operationId: string | null; readonly retry: boolean;
}
export interface ResourceSettlement {
  readonly ledgerDigest: Digest; readonly binding: ResourceBinding; readonly owner: string;
  readonly disposition: 'committed' | 'not_committed'; readonly charge: ResourceAmounts;
  readonly evidence: TaggedValueV1;
}
export interface ResourceBudgetOptions {
  readonly directory: string; readonly profile: ResourceBudgetProfile; readonly key: KeyObject | string;
  /** Trusted synchronous current-authority decision; actor must originate from
   * the authenticated host boundary, never a request-supplied unauthenticated ID. */
  readonly authorize: (request: ResourceAuthorization) => boolean;
  /** Trusted verification of actual sink/broker/meter evidence. Merely accepting
   * a caller's claimed receipt digest does not satisfy this contract. */
  readonly verifySettlement: (settlement: ResourceSettlement) => boolean;
  /** Opt-in external-evidence check on every historical read/reopen. A missing
   * witness makes the ledger unavailable rather than accepting a cached charge. */
  readonly revalidateSettlementOnRead?: boolean;
  /** Operator-pinned identity of the exact evidence verifier configuration.
   * Required by historical revalidation and bound into the ledger digest. */
  readonly settlementEvidencePolicyDigest?: Digest;
  /** Operator-held complete journal CAS. Optional to preserve the historical
   * V1 profile; when selected it is bound into the ledger identity. */
  readonly journalWitness?: BudgetJournalWitness;
  readonly fault?: (phase: ResourceBudgetFault) => void;
}
interface JournalRecord { readonly format: 'aether.resource-transition/1'; readonly sequence: number; readonly previous: Digest; readonly request: ResourceRequest; readonly receipt: ResourceReceipt; readonly signature: string }
interface Journal { readonly format: 'aether.resource-journal/1'; readonly ledgerDigest: Digest; readonly records: readonly JournalRecord[] }
interface Fold { live: Map<Digest, ResourceHandle>; spent: ResourceAmounts; refunded: ResourceAmounts; bindings: Set<Digest>; receipts: Map<string, { request: Digest; receipt: ResourceReceipt }> }
const keys = ['usdMicros', 'tokens', 'nanoseconds', 'memoryBytes'] as const;
const maximum = (1n << 128n) - 1n;
const limits = { maxFrameBytes: 32 * 1024 * 1024, maxDecompressedBytes: 32 * 1024 * 1024, maxObjects: 1_000_000, maxIntegerDigits: 128 };
const ledgerInstances = new WeakSet<object>();
const zero = (): ResourceAmounts => ({ usdMicros: '0', tokens: '0', nanoseconds: '0', memoryBytes: '0' });
const clone = <T>(value: T): T => decodeCanonical(encodeCanonical(value, limits), limits) as T;
function freeze<T>(value: T): T { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
const digest = (domain: string, value: unknown): Digest => domainDigest(domain, value, limits);
const equal = (a: unknown, b: unknown): boolean => Buffer.from(encodeCanonical(a, limits)).equals(Buffer.from(encodeCanonical(b, limits)));
function amounts(value: unknown, nonzero = false): asserts value is ResourceAmounts {
  const row = exactObject(value, keys); for (const key of keys) { decimal(row[key]); if (BigInt(row[key] as string) > maximum) throw new RangeError('resource amount exceeds unsigned 128-bit profile'); }
  if (nonzero && keys.every(key => row[key] === '0')) throw new TypeError('empty linear resource handle');
}
const mapAmounts = (fn: (key: typeof keys[number]) => bigint): ResourceAmounts => Object.fromEntries(keys.map(key => [key, String(fn(key))])) as unknown as ResourceAmounts;
const add = (a: ResourceAmounts, b: ResourceAmounts): ResourceAmounts => mapAmounts(key => BigInt(a[key]) + BigInt(b[key]));
const subtract = (a: ResourceAmounts, b: ResourceAmounts): ResourceAmounts => mapAmounts(key => BigInt(a[key]) - BigInt(b[key]));
const fits = (a: ResourceAmounts, limit: ResourceAmounts): boolean => keys.every(key => BigInt(a[key]) <= BigInt(limit[key]));
const empty = (value: ResourceAmounts): boolean => keys.every(key => value[key] === '0');
const sum = (values: readonly ResourceAmounts[]): ResourceAmounts => values.reduce(add, zero());
function binding(value: unknown): asserts value is ResourceBinding {
  const row = exactObject(value, ['executionId', 'effectId', 'executionManifest', 'payloadDigest', 'policyEpoch']);
  identifier(row.executionId); identifier(row.effectId); validateDigest(row.executionManifest, 'aether.execution/1'); validateDigest(row.payloadDigest); decimal(row.policyEpoch);
}
function sync(path: string): void { const fd = openSync(path, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } }
function directory(path: string): void {
  if (existsSync(path)) return; directory(dirname(path));
  try { mkdirSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; } sync(path); sync(dirname(path));
}
function read<T>(path: string): T { if (statSync(path).size > limits.maxFrameBytes) throw new RangeError('oversized resource journal'); return decodeCanonical(readFileSync(path), limits) as T; }

export class ResourceBudgetLedger {
  static assertInstance(value: unknown): asserts value is ResourceBudgetLedger {
    if (value === null || typeof value !== 'object' || !ledgerInstances.has(value))
      throw new TypeError('branded resource budget ledger required');
  }
  readonly ledgerDigest: Digest;
  readonly publicKey: string;
  private readonly options: ResourceBudgetOptions;
  private readonly profile: ResourceBudgetProfile;
  private readonly key: KeyObject;
  private readonly verificationKey: KeyObject;
  private readonly directory: string;
  private readonly file: string;
  private readonly lock: JournalLock;
  private readonly mirror: BudgetJournalMirror | null;
  constructor(options: ResourceBudgetOptions) {
    if (options.revalidateSettlementOnRead !== undefined
      && typeof options.revalidateSettlementOnRead !== 'boolean')
      throw new TypeError('invalid settlement revalidation profile');
    if (options.revalidateSettlementOnRead) validateDigest(options.settlementEvidencePolicyDigest);
    else if (options.settlementEvidencePolicyDigest !== undefined)
      throw new TypeError('settlement evidence policy requires historical revalidation');
    this.profile = freeze(clone(options.profile)); this.options = { ...options };
    exactObject(this.profile, ['format', 'ledgerId', 'policyEpoch', 'initialOwner', 'initial', 'maxOperations']);
    if (this.profile.format !== RESOURCE_BUDGET_PROFILE) throw new TypeError('unsupported resource budget profile');
    identifier(this.profile.ledgerId); decimal(this.profile.policyEpoch); identifier(this.profile.initialOwner); amounts(this.profile.initial, true);
    if (!Number.isSafeInteger(this.profile.maxOperations) || this.profile.maxOperations < 1 || this.profile.maxOperations > 10_000) throw new RangeError('resource operation capacity');
    if (options.journalWitness) {
      assertBudgetJournalWitness(options.journalWitness);
      if (options.journalWitness.journalKind !== 'ledger'
        || options.journalWitness.journalId !== this.profile.ledgerId)
        throw new TypeError('wrong resource ledger journal witness');
    }
    this.key = typeof options.key === 'string' ? createPrivateKey(options.key) : options.key;
    if (this.key.type !== 'private' || this.key.asymmetricKeyType !== 'ed25519') throw new TypeError('Ed25519 ledger issuer key required');
    this.verificationKey = createPublicKey(this.key); this.publicKey = this.verificationKey.export({ type: 'spki', format: 'der' }).toString('base64');
    directory(resolve(options.directory)); this.directory = realpathSync(resolve(options.directory));
    this.ledgerDigest = digest(RESOURCE_BUDGET_PROFILE, { profile: this.profile,
      publicKey: this.publicKey, authorityDirectory: this.directory,
      ...(options.revalidateSettlementOnRead
        ? { settlementEvidencePolicy: 'aether.resource-settlement-revalidation/1',
          settlementEvidencePolicyDigest: options.settlementEvidencePolicyDigest } : {}),
      ...(options.journalWitness ? { journalWitnessDigest: options.journalWitness.digest } : {}) });
    directory(join(this.directory, 'tickets'));
    this.file = join(this.directory, 'journal.json');
    this.mirror = options.journalWitness ? new BudgetJournalMirror(this.file, options.journalWitness,
      () => this.options.fault?.('after-witness-commit')) : null;
    this.lock = new JournalLock({ directory: join(this.directory, 'tickets'), maxTickets: 100_000, domain: 'aether.resource-budget-lock' });
    this.lock.run(() => this.initialize(), 5_000);
    ledgerInstances.add(this);
  }
  private sign(domain: string, value: unknown): string { return sign(null, encodeCanonical({ domain, value }, limits), this.key).toString('base64'); }
  private verify(domain: string, value: unknown, signature: unknown): void {
    if (typeof signature !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(signature)) throw new TypeError('invalid resource signature');
    const bytes = Buffer.from(signature, 'base64'); if (bytes.toString('base64') !== signature || !verify(null, encodeCanonical({ domain, value }, limits), this.verificationKey, bytes)) throw new Error('forged resource authority');
  }
  private initialize(): void {
    const genesisFile = join(this.directory, 'genesis.json'), sealFile = join(this.directory, 'initialized.json');
    const witnessed = this.options.journalWitness
      ? readBudgetJournalHead(this.options.journalWitness) : null;
    const body = { format: 'aether.resource-genesis/1', ledgerDigest: this.ledgerDigest, profile: this.profile, publicKey: this.publicKey };
    const genesis = { body, signature: this.sign('aether.resource-genesis-signature/1', body) };
    if (!existsSync(genesisFile)) {
      if (!witnessed || witnessed.revision === '0') {
        if (existsSync(this.file) || existsSync(sealFile)) throw new Error('missing established resource genesis');
      }
      this.publishOnce(genesisFile, genesis); this.options.fault?.('after-genesis');
    }
    if (!equal(read(genesisFile), genesis)) throw new Error('resource profile/key mismatch or corrupted genesis');
    if (!existsSync(this.file)) {
      if (!witnessed || witnessed.revision === '0') {
        if (existsSync(sealFile)) throw new Error('missing established resource journal');
        this.publishOnce(this.file, { format: 'aether.resource-journal/1', ledgerDigest: this.ledgerDigest, records: [] }); this.options.fault?.('after-initial-journal');
      }
    }
    this.mirror?.initialize(Buffer.from(encodeCanonical({ format: 'aether.resource-journal/1',
      ledgerDigest: this.ledgerDigest, records: [] }, limits)).toString('utf8'));
    const existing = this.read();
    if (!existsSync(sealFile) && existing.journal.records.length && !this.mirror) throw new Error('missing established resource initialization seal');
    const seal = { format: 'aether.resource-initialization/1', ledgerDigest: this.ledgerDigest, genesisDigest: digest('aether.resource-genesis/1', genesis) };
    if (!existsSync(sealFile)) { this.publishOnce(sealFile, seal); this.options.fault?.('after-initialization-seal'); }
    else if (!equal(read(sealFile), seal)) throw new Error('resource initialization seal mismatch');
  }
  private publishOnce(path: string, value: unknown): void {
    const temp = join(this.directory, `.init-${randomUUID()}`), fd = openSync(temp, 'wx', 0o600);
    try { writeFileSync(fd, encodeCanonical(value, limits)); fsyncSync(fd); } finally { closeSync(fd); }
    try { try { linkSync(temp, path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; } if (!equal(read(path), value)) throw new Error('resource initialization conflict'); sync(this.directory); }
    finally { if (existsSync(temp)) unlinkSync(temp); }
  }
  private initialHandle(): ResourceHandle { return this.handle('genesis', 0, this.profile.initialOwner, 'available', this.profile.initial, null); }
  private handle(operationId: string, index: number, owner: string, state: ResourceHandleBody['state'], value: ResourceAmounts, resourceBinding: ResourceBinding | null): ResourceHandle {
    const body: ResourceHandleBody = { format: 'aether.resource-handle/1', ledgerDigest: this.ledgerDigest,
      id: digest('aether.resource-handle-id/1', { ledgerDigest: this.ledgerDigest, origin: operationId === 'genesis' && index === 0 ? { kind: 'genesis' } : { kind: 'operation', operationId, index } }), owner, state, amounts: value, binding: resourceBinding };
    return { body, signature: this.sign('aether.resource-handle-signature/1', body) };
  }
  private validateHandle(value: unknown): asserts value is ResourceHandle {
    const envelope = exactObject(value, ['body', 'signature']), body = exactObject(envelope.body, ['format', 'ledgerDigest', 'id', 'owner', 'state', 'amounts', 'binding']);
    if (body.format !== 'aether.resource-handle/1' || body.ledgerDigest !== this.ledgerDigest || !['available', 'reserved', 'inflight'].includes(String(body.state))) throw new TypeError('wrong resource handle domain/state');
    validateDigest(body.id, 'aether.resource-handle-id/1'); identifier(body.owner); amounts(body.amounts, true);
    if (body.state === 'available') { if (body.binding !== null) throw new TypeError('available budget cannot carry a reservation'); }
    else binding(body.binding);
    this.verify('aether.resource-handle-signature/1', envelope.body, envelope.signature);
  }
  private validateRequest(value: unknown): asserts value is ResourceRequest {
    const request = exactObject(value, ['format', 'operationId', 'actor', 'operation']);
    if (request.format !== 'aether.resource-operation/1') throw new TypeError('unknown resource operation format'); identifier(request.operationId); identifier(request.actor);
    const operation = request.operation as ResourceOperation;
    const shapes: Record<ResourceOperation['kind'], readonly string[]> = { split: ['kind', 'handle', 'parts'], merge: ['kind', 'handles'], transfer: ['kind', 'handle', 'owner'], reserve: ['kind', 'handle', 'amounts', 'binding', 'start'], start: ['kind', 'handle'], consume: ['kind', 'handle', 'charge', 'evidence'], refund: ['kind', 'handle', 'evidence'] };
    if (!operation || typeof operation.kind !== 'string' || !Object.hasOwn(shapes, operation.kind)) throw new TypeError('unknown resource operation'); exactObject(operation, shapes[operation.kind]);
    if (operation.kind === 'merge') { if (!Array.isArray(operation.handles) || operation.handles.length < 2 || operation.handles.length > 16) throw new RangeError('merge handle count'); operation.handles.forEach(handle => this.validateHandle(handle)); }
    else this.validateHandle(operation.handle);
    if (operation.kind === 'split') { if (!Array.isArray(operation.parts) || operation.parts.length < 2 || operation.parts.length > 16) throw new RangeError('split part count'); operation.parts.forEach(part => amounts(part, true)); }
    if (operation.kind === 'transfer') identifier(operation.owner);
    if (operation.kind === 'reserve') { amounts(operation.amounts, true); binding(operation.binding); if (typeof operation.start !== 'boolean' || operation.binding.policyEpoch !== this.profile.policyEpoch) throw new TypeError('reservation profile epoch/start mismatch'); }
    if (operation.kind === 'consume') { amounts(operation.charge); validateTaggedValue(operation.evidence); }
    if (operation.kind === 'refund' && operation.evidence !== null) validateTaggedValue(operation.evidence);
  }
  private authorize(actor: string, purpose: ResourceAuthorization['purpose'], operationId: string | null, retry: boolean, owner = actor): void {
    identifier(actor);
    if (actor !== owner || this.options.authorize(freeze({ ledgerDigest: this.ledgerDigest, policyEpoch: this.profile.policyEpoch, actor, owner, purpose, operationId, retry })) !== true) throw new Error('resource authority denied or revoked');
  }
  private settlement(request: ResourceRequest): ResourceSettlement | null {
    const op = request.operation;
    if (op.kind !== 'consume' && !(op.kind === 'refund' && op.handle.body.state === 'inflight')) return null;
    if (op.evidence === null) throw new Error('inflight budget requires terminal noncommit evidence; timeout is not a refund');
    return freeze(clone({ ledgerDigest: this.ledgerDigest, binding: op.handle.body.binding!, owner: op.handle.body.owner, disposition: op.kind === 'consume' ? 'committed' as const : 'not_committed' as const,
      charge: op.kind === 'consume' ? op.charge : zero(), evidence: op.evidence }));
  }
  private authorizeOperation(request: ResourceRequest, retry: boolean, verifyEvidence: boolean): void {
    const handles = request.operation.kind === 'merge' ? request.operation.handles : [request.operation.handle];
    for (const handle of handles) this.authorize(request.actor, request.operation.kind, request.operationId, retry, handle.body.owner);
    if (verifyEvidence) { const evidence = this.settlement(request); if (evidence && this.options.verifySettlement(evidence) !== true) throw new Error('resource settlement evidence rejected'); }
  }
  private derive(request: ResourceRequest, fold: Fold, sequence: number): ResourceReceipt {
    const operation = request.operation, input = operation.kind === 'merge' ? operation.handles : [operation.handle];
    if (new Set(input.map(handle => handle.body.id)).size !== input.length) throw new Error('linear handle duplicated in operation');
    for (const handle of input) {
      if (handle.body.owner !== request.actor || !fold.live.has(handle.body.id) || !equal(fold.live.get(handle.body.id), handle)) throw new Error('linear handle is stale, consumed, foreign or forged');
    }
    const outputs: ResourceHandle[] = []; let charged = zero(), refunded = zero();
    const issue = (owner: string, state: ResourceHandleBody['state'], value: ResourceAmounts, resourceBinding: ResourceBinding | null = null): void => {
      if (!empty(value)) outputs.push(this.handle(request.operationId, outputs.length + 1, owner, state, value, resourceBinding));
    };
    const first = input[0].body;
    const available = (): void => { if (input.some(handle => handle.body.state !== 'available')) throw new Error('operation requires unreserved linear budget'); };
    const receipt = (status: ResourceReceipt['status']): ResourceReceipt => ({ format: 'aether.resource-receipt/1', ledgerDigest: this.ledgerDigest, sequence,
      requestDigest: digest('aether.resource-operation/1', request), operationId: request.operationId, status, handles: outputs, charged, refunded });
    switch (operation.kind) {
      case 'split': available(); if (!equal(sum(operation.parts), first.amounts)) throw new Error('split must conserve every resource exactly'); operation.parts.forEach(part => issue(first.owner, 'available', part)); break;
      case 'merge': available(); issue(first.owner, 'available', sum(input.map(handle => handle.body.amounts))); break;
      case 'transfer': available(); issue(operation.owner, 'available', first.amounts); break;
      case 'reserve': {
        available(); if (!fits(operation.amounts, first.amounts)) return receipt('exhausted');
        const key = digest('aether.resource-effect-key/1', { ledgerDigest: this.ledgerDigest, executionId: operation.binding.executionId, effectId: operation.binding.effectId });
        if (fold.bindings.has(key)) throw new Error('effect already has a terminal or live budget reservation'); fold.bindings.add(key);
        issue(first.owner, 'available', subtract(first.amounts, operation.amounts)); issue(first.owner, operation.start ? 'inflight' : 'reserved', operation.amounts, operation.binding); break;
      }
      case 'start': if (first.state !== 'reserved') throw new Error('only a reserved handle can start dispatch'); issue(first.owner, 'inflight', first.amounts, first.binding); break;
      case 'consume': {
        if (first.state !== 'inflight') throw new Error('consume requires a started durable reservation');
        if (!fits(operation.charge, first.amounts)) throw new Error('charge exceeds reserved hard limit; reservation remains encumbered');
        charged = operation.charge; refunded = subtract(first.amounts, charged); issue(first.owner, 'available', refunded); break;
      }
      case 'refund': {
        if (first.state === 'available') throw new Error('available budget is not refundable reservation');
        if (first.state === 'reserved' && operation.evidence !== null) throw new Error('unused reservation refund has no dispatch evidence');
        if (first.state === 'inflight' && operation.evidence === null) throw new Error('inflight budget requires terminal noncommit evidence');
        refunded = first.amounts; issue(first.owner, 'available', refunded); break;
      }
    }
    input.forEach(handle => fold.live.delete(handle.body.id));
    for (const handle of outputs) { if (fold.live.has(handle.body.id)) throw new Error('resource handle identity collision'); fold.live.set(handle.body.id, handle); }
    fold.spent = add(fold.spent, charged); fold.refunded = add(fold.refunded, refunded); this.conservation(fold); return receipt('applied');
  }
  private conservation(fold: Fold): void {
    if (!equal(add(sum([...fold.live.values()].map(handle => handle.body.amounts)), fold.spent), this.profile.initial)) throw new Error('resource conservation violated');
  }
  private read(): { journal: Journal; fold: Fold } {
    this.mirror?.read();
    const journal = read<Journal>(this.file); exactObject(journal, ['format', 'ledgerDigest', 'records']);
    if (journal.format !== 'aether.resource-journal/1' || journal.ledgerDigest !== this.ledgerDigest || !Array.isArray(journal.records) || journal.records.length > this.profile.maxOperations) throw new TypeError('invalid resource journal');
    const initial = this.initialHandle(), fold: Fold = { live: new Map([[initial.body.id, initial]]), spent: zero(), refunded: zero(), bindings: new Set(), receipts: new Map() };
    let previous = digest('aether.resource-genesis-head/1', { ledgerDigest: this.ledgerDigest });
    for (const [index, record] of journal.records.entries()) {
      exactObject(record, ['format', 'sequence', 'previous', 'request', 'receipt', 'signature']);
      if (record.format !== 'aether.resource-transition/1' || record.sequence !== index + 1 || record.previous !== previous) throw new Error('resource journal transition order mismatch');
      const { signature, ...body } = record; this.verify('aether.resource-transition-signature/1', body, signature); this.validateRequest(record.request);
      if (this.options.revalidateSettlementOnRead) {
        const settlement = this.settlement(record.request);
        if (settlement && this.options.verifySettlement(settlement) !== true)
          throw new Error('historical resource settlement evidence rejected');
      }
      if (fold.receipts.has(record.request.operationId)) throw new Error('duplicate durable operation ID');
      const expected = this.derive(record.request, fold, record.sequence); if (!equal(expected, record.receipt)) throw new Error('resource receipt disagrees with exact transition');
      fold.receipts.set(record.request.operationId, { request: expected.requestDigest, receipt: record.receipt }); previous = digest('aether.resource-transition/1', record);
    }
    this.conservation(fold); sync(this.directory); return { journal, fold };
  }
  private publish(journal: Journal, beforeCommit: () => void): void {
    const bytes = encodeCanonical(journal, limits); this.options.fault?.('before-write');
    const temp = join(this.directory, `.journal-${randomUUID()}`), fd = openSync(temp, 'wx', 0o600);
    try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
    try {
      this.options.fault?.('after-file-sync'); this.options.fault?.('before-commit'); beforeCommit();
      const local = (): void => { renameSync(temp, this.file); this.options.fault?.('after-commit'); sync(this.directory); this.options.fault?.('after-directory-sync'); };
      if (this.mirror) this.mirror.advance(Buffer.from(bytes).toString('utf8'), local);
      else local();
    } finally { if (existsSync(temp)) unlinkSync(temp); }
  }
  genesisHandle(actor: string): ResourceHandle {
    return this.lock.run(() => { this.read(); this.authorize(actor, 'genesis', null, false, this.profile.initialOwner); return freeze(this.initialHandle()); }, 5_000);
  }
  apply(request: ResourceRequest): ResourceReceipt {
    const detached = freeze(clone(request)); this.validateRequest(detached);
    return this.lock.run(() => {
      const { journal, fold } = this.read(), old = fold.receipts.get(detached.operationId), requestDigest = digest('aether.resource-operation/1', detached);
      if (old) { if (old.request !== requestDigest) throw new Error('resource operation retry payload conflict'); this.authorizeOperation(detached, true, false); return freeze(clone(old.receipt)); }
      if (journal.records.length >= this.profile.maxOperations) throw new RangeError('resource journal capacity; explicit maintenance required');
      this.authorizeOperation(detached, false, true);
      const receipt = this.derive(detached, fold, journal.records.length + 1);
      const body = { format: 'aether.resource-transition/1' as const, sequence: receipt.sequence, previous: journal.records.length ? digest('aether.resource-transition/1', journal.records.at(-1)!) : digest('aether.resource-genesis-head/1', { ledgerDigest: this.ledgerDigest }), request: detached, receipt };
      const record = { ...body, signature: this.sign('aether.resource-transition-signature/1', body) };
      this.publish({ ...journal, records: [...journal.records, record] }, () => this.authorizeOperation(detached, false, true)); return freeze(clone(receipt));
    }, 5_000);
  }
  /** Read-only exact receipt check. Replays the whole signed journal, including
   * any configured external head and historical settlement evidence. */
  assertReceipt(input: ResourceRequest, expected: ResourceReceipt): void {
    const request = freeze(clone(input)); this.validateRequest(request);
    this.lock.run(() => {
      const { fold } = this.read();
      this.authorize(request.actor, 'inspect', null, false, request.actor);
      const recorded = fold.receipts.get(request.operationId);
      if (!recorded || recorded.request !== digest('aether.resource-operation/1', request)
        || !equal(recorded.receipt, expected))
        throw new Error('resource receipt absent or differs from witnessed ledger');
    }, 5_000);
  }
  /** Admission check for profiles that require independent monotonic custody. */
  assertWitnessed(): void {
    if (!this.mirror) throw new Error('resource ledger lacks external monotonic journal witness');
    this.lock.run(() => { this.read(); }, 5_000);
  }
  snapshot(actor: string): { ledgerDigest: Digest; sequence: number; funded: ResourceAmounts; available: ResourceAmounts; reserved: ResourceAmounts; inflight: ResourceAmounts; spent: ResourceAmounts; refunded: ResourceAmounts; handles: readonly ResourceHandle[] } {
    return this.lock.run(() => {
      const { journal, fold } = this.read(); this.authorize(actor, 'inspect', null, false, this.profile.initialOwner);
      const handles = [...fold.live.values()].sort((a, b) => a.body.id.localeCompare(b.body.id));
      const total = (state: ResourceHandleBody['state']) => sum(handles.filter(handle => handle.body.state === state).map(handle => handle.body.amounts));
      return freeze(clone({ ledgerDigest: this.ledgerDigest, sequence: journal.records.length, funded: this.profile.initial, available: total('available'), reserved: total('reserved'), inflight: total('inflight'), spent: fold.spent, refunded: fold.refunded, handles }));
    }, 5_000);
  }
}

Object.freeze(ResourceBudgetLedger.prototype);
