/** Versioned, fixed-grant EffectBudget bridge. Each pre-split grant funds one
 * logical effect. The trusted host attaches this bridge to one canonical live
 * broker journal; isolated execution cannot use its live hooks. */
import { createPrivateKey, createPublicKey, sign, verify, randomUUID, type KeyObject } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { decodeCanonical, encodeCanonical, exactObject, identifier, validateTaggedValue, type TaggedValueV1 } from '../fabric/encoding.ts';
import { domainDigest, validateDigest, type Digest } from '../fabric/identity.ts';
import { effectRequestDigest, validateEffectRequest, type EffectBudget, type EffectRequestV1, type ExecutionMode } from '../fabric/effects.ts';
import { JournalLock } from '../fabric/journal-lock.ts';
import { ResourceBudgetLedger, type ResourceAmounts, type ResourceHandle, type ResourceReceipt, type ResourceRequest } from './resource-budget.ts';

export interface ResourceBudgetGrant {
  readonly id: string; readonly handle: ResourceHandle;
  readonly executionManifest: Digest; readonly policyEpoch: string;
}
export interface ResourceBudgetBridgeProfile {
  readonly format: 'aether.resource-budget-bridge/1'; readonly bridgeId: string;
  readonly actor: string; readonly brokerAuthority: string; readonly grants: readonly ResourceBudgetGrant[];
}
/** Absence of a sink record is unknown, not terminal noncommit. Observations
 * must come from read-only reconciliation/meter evidence, never another dispatch. */
export type BudgetObservation =
  | { readonly state: 'committed'; readonly value: TaggedValueV1; readonly charge: ResourceAmounts; readonly evidence: TaggedValueV1 }
  | { readonly state: 'not_committed'; readonly evidence: TaggedValueV1 }
  | { readonly state: 'unknown' };
export interface BudgetSettlementWitness {
  readonly format: 'aether.resource-budget-settlement/1'; readonly request: EffectRequestV1;
  readonly disposition: 'committed' | 'not_committed'; readonly value: TaggedValueV1 | null;
  readonly charge: ResourceAmounts; readonly evidence: TaggedValueV1;
}
export interface ResourceBudgetBridgeOptions {
  readonly directory: string; readonly profile: ResourceBudgetBridgeProfile;
  readonly ledger: ResourceBudgetLedger; readonly key: KeyObject | string;
  /** Resolve the actual attached broker mode, not an untrusted caller flag. */
  readonly mode: () => ExecutionMode;
  readonly authorize: (request: EffectRequestV1, purpose: 'reserve' | 'consume' | 'release') => boolean;
  readonly observe: (request: EffectRequestV1) => BudgetObservation;
  readonly fault?: (phase: 'after-intent' | 'after-ledger' | 'after-receipt', operation: 'reserve' | 'consume' | 'refund') => void;
}
interface Row {
  request: EffectRequestV1; grantId: string; reserve: ResourceRequest; reserveReceipt: ResourceReceipt | null;
  settlement: ResourceRequest | null; settlementReceipt: ResourceReceipt | null;
}
interface Body { format: 'aether.resource-budget-bridge-journal/1'; profileDigest: Digest; records: Row[] }
const limits = { maxFrameBytes: 16 * 1024 * 1024, maxDecompressedBytes: 16 * 1024 * 1024, maxObjects: 500_000 };
const clone = <T>(value: T): T => decodeCanonical(encodeCanonical(value, limits), limits) as T;
function frozen<T>(value: T): T { if (value && typeof value === 'object') { Object.values(value).forEach(frozen); Object.freeze(value); } return value; }
const equal = (a: unknown, b: unknown): boolean => Buffer.from(encodeCanonical(a, limits)).equals(Buffer.from(encodeCanonical(b, limits)));
const zero = (): ResourceAmounts => ({ usdMicros: '0', tokens: '0', nanoseconds: '0', memoryBytes: '0' });
const effectKey = (request: EffectRequestV1) => domainDigest('aether.budget-bridge-effect/1', { executionId: request.executionId, effectId: request.effectId });
function sync(path: string): void { const fd = openSync(path, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } }
function ensure(path: string): void { if (existsSync(path)) return; ensure(dirname(path)); try { mkdirSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; } sync(path); sync(dirname(path)); }
/** Ledger verifySettlement implementations decode this wrapper, bind all fields
 * to their ResourceSettlement context, then independently verify inner evidence. */
export function decodeBudgetSettlementWitness(value: TaggedValueV1): BudgetSettlementWitness {
  validateTaggedValue(value); if (value.tag !== 'string') throw new TypeError('versioned budget settlement string required');
  const parsed = decodeCanonical(Buffer.from(value.value), limits) as unknown as BudgetSettlementWitness;
  exactObject(parsed, ['format', 'request', 'disposition', 'value', 'charge', 'evidence']);
  if (parsed.format !== 'aether.resource-budget-settlement/1' || !['committed', 'not_committed'].includes(parsed.disposition)) throw new TypeError('unsupported budget settlement');
  validateEffectRequest(parsed.request); validateTaggedValue(parsed.evidence);
  if (parsed.disposition === 'committed') { if (parsed.value === null) throw new TypeError('committed witness needs an actual result'); validateTaggedValue(parsed.value); }
  else if (parsed.value !== null || !equal(parsed.charge, zero())) throw new TypeError('terminal noncommit cannot carry a charge/result');
  exactObject(parsed.charge, ['usdMicros', 'tokens', 'nanoseconds', 'memoryBytes']);
  for (const amount of Object.values(parsed.charge)) if (typeof amount !== 'string' || !/^(0|[1-9][0-9]*)$/.test(amount) || amount.length > 39 || BigInt(amount) > (1n << 128n) - 1n) throw new TypeError('invalid witnessed resource charge');
  return frozen(parsed);
}

export class ResourceBudgetBridge implements EffectBudget {
  readonly profileDigest: Digest;
  private readonly options: ResourceBudgetBridgeOptions;
  private readonly profile: ResourceBudgetBridgeProfile;
  private readonly key: KeyObject;
  private readonly directory: string;
  private readonly file: string;
  private readonly lock: JournalLock;
  constructor(options: ResourceBudgetBridgeOptions) {
    this.options = { ...options }; this.profile = frozen(clone(options.profile));
    exactObject(this.profile, ['format', 'bridgeId', 'actor', 'brokerAuthority', 'grants']);
    if (this.profile.format !== 'aether.resource-budget-bridge/1') throw new TypeError('unknown budget bridge profile');
    identifier(this.profile.bridgeId); identifier(this.profile.actor); identifier(this.profile.brokerAuthority);
    if (!Array.isArray(this.profile.grants) || this.profile.grants.length < 1 || this.profile.grants.length > 256) throw new RangeError('bounded split budget grants required');
    const names = new Set<string>(), handles = new Set<string>();
    for (const grant of this.profile.grants) {
      exactObject(grant, ['id', 'handle', 'executionManifest', 'policyEpoch']); identifier(grant.id); validateDigest(grant.executionManifest, 'aether.execution/1');
      if (names.has(grant.id) || handles.has(grant.handle.body.id) || grant.handle.body.ledgerDigest !== options.ledger.ledgerDigest || grant.handle.body.owner !== this.profile.actor || grant.handle.body.state !== 'available' || !/^(0|[1-9][0-9]*)$/.test(grant.policyEpoch)) throw new TypeError('duplicate/foreign/stale budget grant');
      names.add(grant.id); handles.add(grant.handle.body.id);
    }
    this.key = typeof options.key === 'string' ? createPrivateKey(options.key) : options.key;
    if (this.key.type !== 'private' || this.key.asymmetricKeyType !== 'ed25519') throw new TypeError('Ed25519 bridge journal key required');
    ensure(resolve(options.directory)); this.directory = realpathSync(resolve(options.directory)); this.file = join(this.directory, 'bridge.json');
    this.profileDigest = domainDigest('aether.resource-budget-bridge/1', { profile: this.profile, ledger: options.ledger.ledgerDigest, authorityDirectory: this.directory, publicKey: createPublicKey(this.key).export({ type: 'spki', format: 'der' }).toString('base64') }, limits);
    ensure(join(this.directory, 'tickets')); this.lock = new JournalLock({ directory: join(this.directory, 'tickets'), domain: 'aether.budget-bridge-lock' });
    this.lock.run(() => {
      const seal = join(this.directory, 'initialized.json');
      if (!existsSync(this.file)) { if (existsSync(seal)) throw new Error('missing established budget bridge'); this.write({ format: 'aether.resource-budget-bridge-journal/1', profileDigest: this.profileDigest, records: [] }, true); }
      const body = this.read();
      if (!existsSync(seal)) {
        if (body.records.length) throw new Error('missing established budget bridge seal');
        const marker = join(this.directory, `.seal-${randomUUID()}`), fd = openSync(marker, 'wx', 0o600);
        try { writeFileSync(fd, encodeCanonical({ profileDigest: this.profileDigest })); fsyncSync(fd); } finally { closeSync(fd); }
        try { linkSync(marker, seal); sync(this.directory); } finally { unlinkSync(marker); }
      } else if (!equal(decodeCanonical(readFileSync(seal)), { profileDigest: this.profileDigest })) throw new Error('budget bridge initialization mismatch');
    }, 5_000);
  }
  private write(body: Body, once = false): void {
    const encoded = encodeCanonical(body, limits), signed = { body, signature: sign(null, encoded, this.key).toString('base64') }, temp = join(this.directory, `.bridge-${randomUUID()}`), fd = openSync(temp, 'wx', 0o600);
    try { writeFileSync(fd, encodeCanonical(signed, limits)); fsyncSync(fd); } finally { closeSync(fd); }
    try { if (once) linkSync(temp, this.file); else renameSync(temp, this.file); sync(this.directory); } finally { if (existsSync(temp)) unlinkSync(temp); }
  }
  private reserveCommand(request: EffectRequestV1, grant: ResourceBudgetGrant): ResourceRequest {
    return { format: 'aether.resource-operation/1', operationId: this.operationId(request, 'reserve'), actor: this.profile.actor,
      operation: { kind: 'reserve', handle: grant.handle, amounts: grant.handle.body.amounts, start: true,
        binding: { executionId: request.executionId, effectId: request.effectId, executionManifest: request.executionManifest, payloadDigest: request.payloadDigest, policyEpoch: request.policyEpoch } } };
  }
  private operationId(request: EffectRequestV1, phase: string): Digest { return domainDigest('aether.budget-bridge-operation/1', { bridge: this.profileDigest, request: effectRequestDigest(request), phase }); }
  private read(): Body {
    if (statSync(this.file).size > limits.maxFrameBytes) throw new RangeError('oversized budget bridge journal');
    const envelope = exactObject(decodeCanonical(readFileSync(this.file), limits), ['body', 'signature']), body = envelope.body as Body;
    if (typeof envelope.signature !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(envelope.signature)) throw new Error('forged budget bridge journal');
    const signature = Buffer.from(envelope.signature, 'base64');
    if (signature.toString('base64') !== envelope.signature || !verify(null, encodeCanonical(body, limits), createPublicKey(this.key), signature)) throw new Error('forged budget bridge journal');
    exactObject(body, ['format', 'profileDigest', 'records']);
    if (body.format !== 'aether.resource-budget-bridge-journal/1' || body.profileDigest !== this.profileDigest || !Array.isArray(body.records) || body.records.length > this.profile.grants.length) throw new TypeError('budget bridge profile/history mismatch');
    const effects = new Set<string>(), grants = new Set<string>();
    for (const row of body.records) {
      exactObject(row, ['request', 'grantId', 'reserve', 'reserveReceipt', 'settlement', 'settlementReceipt']); validateEffectRequest(row.request);
      const grant = this.profile.grants.find(item => item.id === row.grantId), key = effectKey(row.request);
      if (!grant || effects.has(key) || grants.has(row.grantId) || row.request.budgetReservationId !== row.grantId || !equal(row.reserve, this.reserveCommand(row.request, grant))) throw new Error('invalid budget bridge reservation history');
      effects.add(key); grants.add(row.grantId);
      if (row.settlement !== null) {
        if (!row.reserveReceipt || row.reserveReceipt.status !== 'applied' || !['consume', 'refund'].includes(row.settlement.operation.kind)) throw new Error('settlement lacks applied reservation');
        const handle = row.reserveReceipt.handles.find(item => item.body.state === 'inflight'), op = row.settlement.operation;
        if (op.kind !== 'consume' && op.kind !== 'refund') throw new Error('unexpected settlement');
        if (!equal(op.handle, handle) || row.settlement.actor !== this.profile.actor || row.settlement.operationId !== this.operationId(row.request, op.kind) || op.evidence === null) throw new Error('settlement binding mismatch');
        const witness = decodeBudgetSettlementWitness(op.evidence);
        if (!equal(witness.request, row.request) || witness.disposition !== (op.kind === 'consume' ? 'committed' : 'not_committed') || op.kind === 'consume' && !equal(op.charge, witness.charge)) throw new Error('settlement witness mismatch');
      } else if (row.settlementReceipt !== null) throw new Error('receipt has no settlement intent');
    }
    sync(this.directory); return body;
  }
  private authorize(request: EffectRequestV1, purpose: 'reserve' | 'consume' | 'release'): void {
    if (this.options.mode() !== 'live') throw new Error('isolated budget bridge mutation forbidden');
    if (this.options.authorize(frozen(clone(request)), purpose) !== true) throw new Error('budget bridge authority denied or revoked');
  }
  private find(body: Body, request: EffectRequestV1): Row | undefined {
    const row = body.records.find(item => effectKey(item.request) === effectKey(request));
    if (row && effectRequestDigest(row.request) !== effectRequestDigest(request)) throw new Error('budget bridge exact effect identity conflict'); return row;
  }
  private completeReserve(body: Body, row: Row, purpose: 'reserve' | 'consume' | 'release'): ResourceReceipt {
    this.authorize(row.request, purpose);
    const actual = this.options.ledger.apply(row.reserve);
    if (row.reserveReceipt) { if (!equal(actual, row.reserveReceipt)) throw new Error('ledger reservation receipt mismatch'); return actual; }
    this.options.fault?.('after-ledger', 'reserve'); row.reserveReceipt = actual; this.write(body); this.options.fault?.('after-receipt', 'reserve'); return actual;
  }
  reserve(input: EffectRequestV1): boolean {
    validateEffectRequest(input); const request = frozen(clone(input));
    return this.lock.run(() => {
      this.authorize(request, 'reserve'); const body = this.read(); let row = this.find(body, request);
      if (row?.settlement) return false; // A terminal effect cannot regain dispatch budget.
      if (!row) {
        const grant = this.profile.grants.find(item => item.id === request.budgetReservationId);
        if (!grant || body.records.some(item => item.grantId === grant.id)) return false;
        if (grant.executionManifest !== request.executionManifest || grant.policyEpoch !== request.policyEpoch) throw new Error('stale/wrong-manifest budget grant');
        row = { request, grantId: grant.id, reserve: this.reserveCommand(request, grant), reserveReceipt: null, settlement: null, settlementReceipt: null };
        this.authorize(request, 'reserve'); body.records.push(row); this.write(body); this.options.fault?.('after-intent', 'reserve');
      }
      const receipt = this.completeReserve(body, row, 'reserve'); this.authorize(request, 'reserve'); return receipt.status === 'applied';
    }, 5_000);
  }
  consume(request: EffectRequestV1, value: TaggedValueV1): void { validateTaggedValue(value); this.settle(request, 'consume', frozen(clone(value))); }
  release(request: EffectRequestV1): void { this.settle(request, 'refund', null); }
  private settle(input: EffectRequestV1, kind: 'consume' | 'refund', value: TaggedValueV1 | null): void {
    validateEffectRequest(input); const request = frozen(clone(input)), purpose = kind === 'consume' ? 'consume' : 'release';
    this.lock.run(() => {
      this.authorize(request, purpose); const body = this.read(), row = this.find(body, request);
      if (!row) { if (kind === 'refund') return; throw new Error('effect has no durable budget reservation'); }
      const reserved = this.completeReserve(body, row, purpose);
      if (reserved.status !== 'applied') { if (kind === 'refund') return; throw new Error('cannot charge exhausted reservation'); }
      if (row.settlement) {
        if (row.settlement.operation.kind !== kind) throw new Error('budget settlement is terminal or awaiting a different resolution');
        const op = row.settlement.operation;
        if ((op.kind !== 'consume' && op.kind !== 'refund') || op.evidence === null || !equal(decodeBudgetSettlementWitness(op.evidence).value, value)) throw new Error('budget settlement result changed on retry');
      } else {
        const observation = frozen(clone(this.options.observe(request)));
        if (observation.state === 'unknown') throw new Error('budget settlement indeterminate; funds remain encumbered');
        if (kind === 'consume' ? observation.state !== 'committed' || !equal(observation.value, value) : observation.state !== 'not_committed') throw new Error('broker result disagrees with terminal sink evidence');
        exactObject(observation, observation.state === 'committed' ? ['state', 'value', 'charge', 'evidence'] : ['state', 'evidence']);
        const witness: BudgetSettlementWitness = { format: 'aether.resource-budget-settlement/1', request, disposition: kind === 'consume' ? 'committed' : 'not_committed', value, charge: observation.state === 'committed' ? observation.charge : zero(), evidence: observation.evidence };
        const evidence: TaggedValueV1 = { tag: 'string', value: Buffer.from(encodeCanonical(witness, limits)).toString() }; decodeBudgetSettlementWitness(evidence);
        const handle = reserved.handles.find(item => item.body.state === 'inflight'); if (!handle) throw new Error('budget never entered durable inflight state');
        row.settlement = { format: 'aether.resource-operation/1', operationId: this.operationId(request, kind), actor: this.profile.actor,
          operation: kind === 'consume' ? { kind, handle, charge: witness.charge, evidence } : { kind, handle, evidence } };
        this.authorize(request, purpose); this.write(body); this.options.fault?.('after-intent', kind);
      }
      this.authorize(request, purpose);
      const receipt = this.options.ledger.apply(row.settlement);
      if (row.settlementReceipt) { if (!equal(receipt, row.settlementReceipt)) throw new Error('ledger settlement receipt mismatch'); }
      else { this.options.fault?.('after-ledger', kind); row.settlementReceipt = receipt; this.write(body); this.options.fault?.('after-receipt', kind); }
      this.authorize(request, purpose);
    }, 5_000);
  }
  /** Read-only audit view. Refunded handles belong to the host for explicit new
   * grant issuance; the original grant never silently refills. */
  records(): readonly Readonly<Row>[] { return this.lock.run(() => frozen(clone(this.read().records)), 5_000); }
}
