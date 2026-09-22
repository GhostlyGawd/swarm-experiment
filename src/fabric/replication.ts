import { createPrivateKey, createPublicKey, randomUUID, sign, verify, type KeyObject } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { JournalLock } from './journal-lock.ts';
import { decodeCanonical, decimal, encodeCanonical, encodingLimits, exactObject, identifier, type EncodingLimits } from './encoding.ts';
import { domainDigest, validateDigest, type Digest } from './identity.ts';

export type MutationOperation = 'insert' | 'delete' | 'move' | 'replace';
/** Sibling order is an opaque stable position ID; concurrent tree projection is
 * intentionally deferred to the separately specified Tree-CRDT algorithm. */
export type MutationPayloadV1 =
  | { readonly format: 'aether.tree-insert/1'; readonly parentOccurrence: string | null; readonly field: string; readonly positionId: string; readonly content: Digest }
  | { readonly format: 'aether.tree-move/1'; readonly parentOccurrence: string | null; readonly field: string; readonly positionId: string }
  | { readonly format: 'aether.tree-delete/1'; readonly tombstoneId: string }
  | { readonly format: 'aether.tree-replace/1'; readonly content: Digest };
export interface MutationEnvelopeV1 {
  readonly format: 'aether.mutation/1';
  readonly repositoryId: string;
  readonly membershipEpoch: string;
  readonly replicaId: string;
  readonly sequence: string;
  readonly lamport: string;
  readonly causalFrontier: readonly (readonly [string, string])[];
  readonly occurrenceId: string;
  readonly operation: MutationOperation;
  readonly payloadDigest: Digest;
  readonly payload: MutationPayloadV1;
  readonly signature: string;
}
export interface ReplicaEnrollmentV1 { readonly replicaId: string; readonly publicKey: string }
/** Trusted out-of-band enrollment, not a membership proposal received from a peer. */
export interface MembershipV1 {
  readonly format: 'aether.membership/1';
  readonly repositoryId: string;
  readonly membershipEpoch: string;
  readonly replicas: readonly ReplicaEnrollmentV1[];
}
export interface MissingPredecessor { readonly replicaId: string; readonly sequence: string }
export interface CandidateOperation {
  readonly operationId: Digest;
  readonly envelope: MutationEnvelopeV1;
  readonly disposition: 'accepted' | 'pending' | 'quarantined';
  readonly reason: string;
}
export type ReplicationFaultPoint = 'before-persist' | 'after-persist' | 'before-author-publish' | 'after-author-publish';
export interface ReplicaOptions {
  directory: string;
  membership: MembershipV1;
  replicaId: string;
  privateKey?: KeyObject | string;
  limits?: Partial<EncodingLimits>;
  maxStoredOperations?: number;
  maxJournalBytes?: number;
  /** Bounded retained local admission tickets; reclamation needs quiescent migration. */
  maxAdmissionTickets?: number;
  fault?: (point: ReplicationFaultPoint) => void;
}

function publicKeyBytes(value: string): Buffer {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length > 256) throw new TypeError('invalid Ed25519 public key');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value) throw new TypeError('noncanonical public key');
  const key = createPublicKey({ key: bytes, format: 'der', type: 'spki' });
  if (key.asymmetricKeyType !== 'ed25519') throw new TypeError('only Ed25519 enrollment is supported');
  return bytes;
}
export function enrollment(replicaId: string, key: KeyObject): ReplicaEnrollmentV1 {
  identifier(replicaId);
  const publicKey = key.type === 'public' ? key : createPublicKey(key);
  if (publicKey.asymmetricKeyType !== 'ed25519') throw new TypeError('only Ed25519 enrollment is supported');
  return { replicaId, publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64') };
}
function validateMembership(value: unknown, limits: EncodingLimits): asserts value is MembershipV1 {
  encodeCanonical(value, limits);
  const m = exactObject(value, ['format', 'repositoryId', 'membershipEpoch', 'replicas']);
  if (m.format !== 'aether.membership/1') throw new TypeError('unsupported membership format');
  identifier(m.repositoryId); decimal(m.membershipEpoch, limits);
  if (!Array.isArray(m.replicas) || m.replicas.length === 0) throw new TypeError('empty replica membership');
  let previous = '';
  for (const member of m.replicas) {
    const record = exactObject(member, ['replicaId', 'publicKey']); identifier(record.replicaId);
    if (record.replicaId <= previous) throw new TypeError('duplicate or noncanonical replica enrollment');
    if (typeof record.publicKey !== 'string') throw new TypeError('missing replica verification key');
    publicKeyBytes(record.publicKey); previous = record.replicaId;
  }
}
export function validateMutationPayload(operation: MutationOperation, payload: unknown): asserts payload is MutationPayloadV1 {
  const keys = operation === 'insert' ? ['format', 'parentOccurrence', 'field', 'positionId', 'content']
    : operation === 'move' ? ['format', 'parentOccurrence', 'field', 'positionId']
    : operation === 'delete' ? ['format', 'tombstoneId'] : ['format', 'content'];
  const p = exactObject(payload, keys);
  if (p.format !== `aether.tree-${operation}/1`) throw new TypeError('operation payload schema/version mismatch');
  if (operation === 'insert' || operation === 'move') {
    if (p.parentOccurrence !== null) identifier(p.parentOccurrence);
    identifier(p.field); identifier(p.positionId);
  }
  if (operation === 'insert' || operation === 'replace') validateDigest(p.content, 'ast');
  if (operation === 'delete') identifier(p.tombstoneId);
}
function unsigned(envelope: MutationEnvelopeV1): Omit<MutationEnvelopeV1, 'signature'> {
  const { signature: _signature, ...body } = envelope;
  return body;
}
function signingBytes(envelope: MutationEnvelopeV1, limits: EncodingLimits): Uint8Array {
  return encodeCanonical({ domain: 'aether.mutation-signature/1', envelope: unsigned(envelope) }, limits);
}
export function operationId(envelope: Pick<MutationEnvelopeV1, 'repositoryId' | 'membershipEpoch' | 'replicaId' | 'sequence'>): Digest {
  return domainDigest('aether.operation-id/1', {
    repositoryId: envelope.repositoryId, membershipEpoch: envelope.membershipEpoch,
    replicaId: envelope.replicaId, sequence: envelope.sequence,
  });
}
function hashName(value: unknown): string { return domainDigest('aether.replication-file/1', value).split(':').at(-1)!; }
function envelopeDigest(envelope: MutationEnvelopeV1, limits: EncodingLimits): Digest { return domainDigest('aether.mutation/1', envelope, limits); }

export function decodeMutation(bytes: Uint8Array, membership: MembershipV1, overrides: Partial<EncodingLimits> = {}): MutationEnvelopeV1 {
  const limits = encodingLimits(overrides);
  validateMembership(membership, limits);
  const decoded = decodeCanonical(bytes, limits);
  // A single canonical transport encoding makes byte identity unambiguous.
  if (!Buffer.from(encodeCanonical(decoded, limits)).equals(Buffer.from(bytes))) throw new TypeError('noncanonical mutation encoding');
  const m = exactObject(decoded, ['format', 'repositoryId', 'membershipEpoch', 'replicaId', 'sequence', 'lamport', 'causalFrontier', 'occurrenceId', 'operation', 'payloadDigest', 'payload', 'signature']);
  if (m.format !== 'aether.mutation/1') throw new TypeError('unsupported mutation format');
  identifier(m.repositoryId); identifier(m.replicaId); identifier(m.occurrenceId);
  decimal(m.membershipEpoch, limits); decimal(m.sequence, limits); decimal(m.lamport, limits);
  if (BigInt(m.sequence) < 1n || BigInt(m.lamport) < 1n) throw new TypeError('sequence and Lamport clocks start at one');
  if (m.repositoryId !== membership.repositoryId || m.membershipEpoch !== membership.membershipEpoch) throw new TypeError('wrong repository or membership epoch');
  const member = membership.replicas.find(member => member.replicaId === m.replicaId);
  if (!member) throw new TypeError('replica is not enrolled');
  if (!['insert', 'delete', 'move', 'replace'].includes(String(m.operation))) throw new TypeError('unknown mutation operation');
  validateMutationPayload(m.operation as MutationOperation, m.payload);
  validateDigest(m.payloadDigest, 'aether.mutation-payload/1');
  if (m.payloadDigest !== domainDigest('aether.mutation-payload/1', m.payload, limits)) throw new TypeError('mutation payload digest mismatch');
  if (!Array.isArray(m.causalFrontier) || m.causalFrontier.length > membership.replicas.length) throw new TypeError('invalid causal frontier');
  let previous = '', own = '0';
  for (const pair of m.causalFrontier) {
    if (!Array.isArray(pair) || pair.length !== 2) throw new TypeError('invalid frontier entry');
    identifier(pair[0]); decimal(pair[1], limits);
    if (pair[0] <= previous || pair[1] === '0' || !membership.replicas.some(replica => replica.replicaId === pair[0])) throw new TypeError('invalid, duplicate or unordered frontier replica');
    previous = pair[0];
    if (pair[0] === m.replicaId) own = pair[1];
  }
  if (BigInt(own) !== BigInt(m.sequence) - 1n) throw new TypeError('frontier must bind the preceding own sequence');
  if (typeof m.signature !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(m.signature)) throw new TypeError('invalid Ed25519 signature encoding');
  const signature = Buffer.from(m.signature, 'base64');
  if (signature.toString('base64') !== m.signature) throw new TypeError('noncanonical signature');
  const envelope = decoded as unknown as MutationEnvelopeV1;
  const key = createPublicKey({ key: publicKeyBytes(member.publicKey), format: 'der', type: 'spki' });
  if (!verify(null, signingBytes(envelope, limits), key, signature)) throw new TypeError('invalid mutation signature');
  return envelope;
}

function syncDirectory(directory: string): void {
  const fd = openSync(directory, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
/** Publishes an already-fsynced immutable inode without ever exposing partial
 * bytes. Hard-link create is atomic and cannot replace a competing operation. */
function publish(directory: string, name: string, bytes: Uint8Array): boolean {
  const temporary = join(directory, `.tmp-${process.pid}-${randomUUID()}`);
  let fd: number | undefined;
  try {
    fd = openSync(temporary, 'wx', 0o600); writeFileSync(fd, bytes); fsyncSync(fd); closeSync(fd); fd = undefined;
    try { linkSync(temporary, join(directory, name)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false; throw error; }
    syncDirectory(directory); return true;
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

/** Candidate-only authenticated operation-set journal. There is no production
 * root handle or mutation callback. Tree projection/admission are separate APIs.
 * The local filesystem must support atomic hard links and fsync durability. */
export class DurableReplica {
  readonly replicaId: string;
  readonly membership: MembershipV1;
  private readonly limits: EncodingLimits;
  private readonly maxStoredOperations: number;
  private readonly maxJournalBytes: number;
  private journalBytes = 0;
  private readonly ingressDirectory: string;
  private readonly authorDirectory: string;
  private readonly admissionLock: JournalLock;
  private readonly privateKey?: KeyObject;
  private readonly fault?: ReplicaOptions['fault'];
  private frames = new Map<Digest, MutationEnvelopeV1>();

  constructor(options: ReplicaOptions) {
    this.limits = encodingLimits(options.limits); validateMembership(options.membership, this.limits); identifier(options.replicaId);
    const membership = decodeCanonical(encodeCanonical(options.membership, this.limits), this.limits) as unknown as MembershipV1;
    membership.replicas.forEach(Object.freeze); Object.freeze(membership.replicas);
    this.membership = Object.freeze(membership);
    this.replicaId = options.replicaId;
    if (!this.membership.replicas.some(replica => replica.replicaId === this.replicaId)) throw new TypeError('local replica is not enrolled');
    this.maxStoredOperations = options.maxStoredOperations ?? 10_000;
    if (!Number.isSafeInteger(this.maxStoredOperations) || this.maxStoredOperations < 1) throw new RangeError('invalid journal capacity');
    this.maxJournalBytes = options.maxJournalBytes ?? 64 * 1024 * 1024;
    if (!Number.isSafeInteger(this.maxJournalBytes) || this.maxJournalBytes < 1) throw new RangeError('invalid journal byte capacity');
    this.fault = options.fault;
    if (options.privateKey) {
      this.privateKey = typeof options.privateKey === 'string' ? createPrivateKey(options.privateKey) : options.privateKey;
      if (this.privateKey.type !== 'private' || enrollment(this.replicaId, this.privateKey).publicKey !== this.membership.replicas.find(replica => replica.replicaId === this.replicaId)!.publicKey) throw new TypeError('signing key does not match enrollment');
    }
    mkdirSync(options.directory, { recursive: true });
    const identity = encodeCanonical({ format: 'aether.replica-journal/1', replicaId: this.replicaId, membership: this.membership }, this.limits);
    if (!publish(options.directory, 'identity.json', identity)) {
      if (!Buffer.from(this.readBounded(join(options.directory, 'identity.json'))).equals(Buffer.from(identity))) throw new Error('journal identity or membership changed; explicit epoch migration required');
    }
    // All processes sharing a journal must enforce the same durable quota.
    const capacity = encodeCanonical({ format: 'aether.replica-capacity/1', maxStoredOperations: this.maxStoredOperations, maxJournalBytes: this.maxJournalBytes }, this.limits);
    if (!publish(options.directory, 'capacity.json', capacity) && !Buffer.from(this.readBounded(join(options.directory, 'capacity.json'))).equals(Buffer.from(capacity))) throw new Error('journal capacity profile changed; explicit migration required');
    this.admissionLock = new JournalLock({ directory: join(options.directory, 'admission-tickets'), limits: this.limits, maxTickets: options.maxAdmissionTickets });
    this.ingressDirectory = join(options.directory, 'operations'); this.authorDirectory = join(options.directory, 'authored');
    mkdirSync(this.ingressDirectory, { recursive: true }); mkdirSync(this.authorDirectory, { recursive: true }); syncDirectory(options.directory);
    this.refresh();
  }
  /** Serializes only local resource admission; independent replica journals remain independent. */
  private admit<T>(operation: () => T): T { return this.admissionLock.run(operation, 5_000); }
  private readBounded(path: string): Uint8Array {
    if (statSync(path).size > Math.min(this.limits.maxFrameBytes, this.limits.maxDecompressedBytes)) throw new RangeError('oversized journal frame');
    return readFileSync(path);
  }
  private refresh(): void {
    const next = new Map<Digest, MutationEnvelopeV1>();
    let totalBytes = 0;
    for (const directory of [this.ingressDirectory, this.authorDirectory]) {
      const files = readdirSync(directory).filter(name => !name.startsWith('.tmp-'));
      if (files.length > this.maxStoredOperations) throw new RangeError('journal capacity exceeded');
      for (const file of files) {
        if (!/^[0-9a-f]{64}\.json$/.test(file)) throw new TypeError('unknown journal file');
        totalBytes += statSync(join(directory, file)).size;
        if (totalBytes > this.maxJournalBytes) throw new RangeError('journal byte capacity exceeded');
        const envelope = decodeMutation(this.readBounded(join(directory, file)), this.membership, this.limits);
        const digest = envelopeDigest(envelope, this.limits);
        const expected = directory === this.ingressDirectory ? hashName(digest) : hashName(envelope.sequence);
        if (file !== `${expected}.json` || (directory === this.authorDirectory && envelope.replicaId !== this.replicaId)) throw new TypeError('journal filename/author binding mismatch');
        next.set(digest, envelope);
      }
    }
    if (next.size > this.maxStoredOperations) throw new RangeError('journal capacity exceeded');
    this.frames = next;
    this.journalBytes = totalBytes;
  }
  ingest(bytes: Uint8Array): { operationId: Digest; disposition: CandidateOperation['disposition'] | 'duplicate' } {
    const envelope = decodeMutation(bytes, this.membership, this.limits);
    // Immutable exact duplicates need no allocation and remain readable when
    // the bounded admission-ticket supply has been exhausted.
    this.refresh();
    const knownDigest = envelopeDigest(envelope, this.limits);
    if (this.frames.has(knownDigest)) return { operationId: operationId(envelope), disposition: 'duplicate' };
    return this.admit(() => {
      this.refresh();
      const digest = envelopeDigest(envelope, this.limits);
      if (this.frames.has(digest)) return { operationId: operationId(envelope), disposition: 'duplicate' };
      if (this.frames.size >= this.maxStoredOperations) throw new RangeError('journal capacity exceeded');
      if (this.journalBytes + bytes.byteLength > this.maxJournalBytes) throw new RangeError('journal byte capacity exceeded');
      this.fault?.('before-persist');
      publish(this.ingressDirectory, `${hashName(digest)}.json`, encodeCanonical(envelope, this.limits));
      this.fault?.('after-persist');
      this.refresh();
      return { operationId: operationId(envelope), disposition: this.classify().find(row => envelopeDigest(row.envelope, this.limits) === digest)!.disposition };
    });
  }
  author(occurrenceId: string, operation: MutationOperation, payload: MutationPayloadV1): Uint8Array {
    if (!this.privateKey) throw new Error('replica is read-only');
    identifier(occurrenceId); validateMutationPayload(operation, payload);
    return this.admit(() => {
      for (;;) {
        this.refresh();
        if (this.frames.size >= this.maxStoredOperations) throw new RangeError('journal capacity exceeded');
        const rows = this.classify();
        if (rows.some(row => row.envelope.replicaId === this.replicaId && row.disposition !== 'accepted')) throw new Error('own predecessor is pending or quarantined');
        const frontier = new Map<string, bigint>(); let lamport = 0n;
        for (const row of rows) {
          if (row.disposition !== 'accepted') continue;
          const e = row.envelope;
          frontier.set(e.replicaId, BigInt(e.sequence) > (frontier.get(e.replicaId) ?? 0n) ? BigInt(e.sequence) : frontier.get(e.replicaId)!);
          if (BigInt(e.lamport) > lamport) lamport = BigInt(e.lamport);
        }
        const sequence = String((frontier.get(this.replicaId) ?? 0n) + 1n);
        const envelope: MutationEnvelopeV1 = {
          format: 'aether.mutation/1', repositoryId: this.membership.repositoryId, membershipEpoch: this.membership.membershipEpoch,
          replicaId: this.replicaId, sequence, lamport: String(lamport + 1n),
          causalFrontier: [...frontier].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([id, n]) => [id, String(n)]),
          occurrenceId, operation, payloadDigest: domainDigest('aether.mutation-payload/1', payload, this.limits), payload,
          signature: '',
        };
        const signed = { ...envelope, signature: sign(null, signingBytes(envelope, this.limits), this.privateKey!).toString('base64') };
        const bytes = encodeCanonical(signed, this.limits); decodeMutation(bytes, this.membership, this.limits);
        if (this.journalBytes + bytes.byteLength > this.maxJournalBytes) throw new RangeError('journal byte capacity exceeded');
        this.fault?.('before-author-publish');
        if (!publish(this.authorDirectory, `${hashName(sequence)}.json`, bytes)) continue;
        this.fault?.('after-author-publish');
        // The authored journal already contains the complete operation and is
        // recovered on restart even if the caller crashes before broadcasting.
        this.refresh(); return bytes;
      }
    });
  }
  private classify(): CandidateOperation[] {
    const grouped = new Map<Digest, MutationEnvelopeV1[]>();
    for (const envelope of this.frames.values()) {
      const id = operationId(envelope); const group = grouped.get(id) ?? []; group.push(envelope); grouped.set(id, group);
    }
    const states = new Map<Digest, { disposition: CandidateOperation['disposition']; reason: string }>();
    for (const [id, group] of grouped) states.set(id, { disposition: group.length > 1 ? 'quarantined' : 'pending', reason: group.length > 1 ? 'signed operation-ID equivocation' : 'missing or pending causal predecessor' });
    const predecessorId = (envelope: MutationEnvelopeV1, replicaId: string, sequence: string) => operationId({ ...envelope, replicaId, sequence });
    // Known impossible Lamport edges are quarantined independently of delivery
    // readiness, preventing dependency cycles from becoming accepted.
    for (const [id, group] of grouped) {
      if (group.length !== 1) continue;
      const envelope = group[0];
      for (const [replicaId, sequence] of envelope.causalFrontier) {
        const predecessors = grouped.get(predecessorId(envelope, replicaId, sequence));
        if (predecessors?.some(predecessor => BigInt(predecessor.lamport) >= BigInt(envelope.lamport))) states.set(id, { disposition: 'quarantined', reason: 'Lamport clock does not follow causal predecessor' });
      }
    }
    let changed = true;
    while (changed) {
      changed = false;
      for (const [id, group] of grouped) {
        const state = states.get(id)!;
        if (state.disposition !== 'pending') continue;
        const envelope = group[0];
        const dependencies = envelope.causalFrontier.map(([replicaId, sequence]) => states.get(predecessorId(envelope, replicaId, sequence)));
        if (dependencies.some(dependency => dependency?.disposition === 'quarantined')) {
          states.set(id, { disposition: 'quarantined', reason: 'causal ancestor is quarantined' }); changed = true;
        } else if (dependencies.every(dependency => dependency?.disposition === 'accepted')) {
          states.set(id, { disposition: 'accepted', reason: 'authenticated causally ready candidate operation' }); changed = true;
        }
      }
    }
    return [...grouped].flatMap(([id, group]) => group.map(envelope => ({ operationId: id, envelope, ...states.get(id)! })))
      .sort((a, b) => {
        const first = envelopeDigest(a.envelope, this.limits), second = envelopeDigest(b.envelope, this.limits);
        return first < second ? -1 : first > second ? 1 : 0;
      });
  }
  operations(): CandidateOperation[] {
    this.refresh();
    // Return detached wire values so callers cannot modify journal authority.
    return this.classify().map(row => ({ ...row, envelope: decodeCanonical(encodeCanonical(row.envelope, this.limits), this.limits) as unknown as MutationEnvelopeV1 }));
  }
  missingPredecessors(): MissingPredecessor[] {
    this.refresh(); const missing = new Map<Digest, MissingPredecessor>();
    const known = new Set([...this.frames.values()].map(operationId));
    for (const row of this.classify()) {
      if (row.disposition !== 'pending') continue;
      for (const [replicaId, sequence] of row.envelope.causalFrontier) {
        const id = operationId({ ...row.envelope, replicaId, sequence });
        if (!known.has(id)) missing.set(id, { replicaId, sequence });
      }
    }
    return [...missing].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, predecessor]) => predecessor);
  }
  framesFor(predecessor?: MissingPredecessor): Uint8Array[] {
    this.refresh();
    return [...this.frames].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .filter(([, envelope]) => !predecessor || envelope.replicaId === predecessor.replicaId && envelope.sequence === predecessor.sequence)
      .map(([, envelope]) => encodeCanonical(envelope, this.limits));
  }
  candidateDigest(): Digest {
    return domainDigest('aether.candidate-operations/1', { membership: this.membership, operations: this.operations().filter(row => row.disposition === 'accepted').map(row => envelopeDigest(row.envelope, this.limits)) }, this.limits);
  }
  journalDigest(): Digest {
    return domainDigest('aether.candidate-journal/1', { membership: this.membership, operations: this.operations().map(row => ({ digest: envelopeDigest(row.envelope, this.limits), disposition: row.disposition, reason: row.reason })) }, this.limits);
  }
}

interface Delivery { from: string; to: string; bytes: Uint8Array }
/** Deterministic test transport; no real network/convergence SLA is implied. */
export class ReplicationHarness {
  readonly expectedReplicas: readonly string[];
  private readonly replicas = new Map<string, DurableReplica>();
  private readonly partitions = new Set<string>();
  private readonly queue: Delivery[] = [];
  private readonly failures: Array<{ from: string; to: string; reason: string }> = [];
  private delivered = 0;
  private dropped = 0;
  private requested = 0;
  constructor(expectedReplicas: readonly string[]) {
    if (expectedReplicas.length === 0 || new Set(expectedReplicas).size !== expectedReplicas.length) throw new Error('expected replicas must be unique and nonempty');
    expectedReplicas.forEach(identifier);
    this.expectedReplicas = Object.freeze([...expectedReplicas]);
  }
  attach(replica: DurableReplica): void {
    if (!this.expectedReplicas.includes(replica.replicaId)) throw new Error('unexpected harness replica');
    this.replicas.set(replica.replicaId, replica);
  }
  disconnect(replicaId: string): void { this.replicas.delete(replicaId); }
  restart(replicaId: string, reopen: () => DurableReplica): void {
    this.disconnect(replicaId); const replica = reopen();
    if (replica.replicaId !== replicaId) throw new Error('restart changed replica identity');
    this.attach(replica);
  }
  partition(a: string, b: string, blocked = true): void {
    const key = JSON.stringify([a, b].sort());
    if (blocked) this.partitions.add(key); else this.partitions.delete(key);
  }
  send(from: string, to: string, bytes: Uint8Array): void {
    if (!this.expectedReplicas.includes(from) || !this.expectedReplicas.includes(to)) throw new Error('unknown transport endpoint');
    this.queue.push({ from, to, bytes: Uint8Array.from(bytes) });
  }
  duplicate(index: number): void { const message = this.at(index); this.queue.push({ ...message, bytes: Uint8Array.from(message.bytes) }); }
  drop(index: number): void { this.at(index); this.queue.splice(index, 1); this.dropped++; }
  private at(index: number): Delivery {
    if (!Number.isInteger(index) || index < 0 || index >= this.queue.length) throw new RangeError('invalid delivery index');
    return this.queue[index];
  }
  /** Selecting an arbitrary index supplies deterministic reordering. Blocked or
   * disconnected messages remain queued until explicitly dropped or healed. */
  deliver(index = 0): boolean {
    const message = this.at(index);
    if (!this.replicas.has(message.from) || !this.replicas.has(message.to) || this.partitions.has(JSON.stringify([message.from, message.to].sort()))) return false;
    this.queue.splice(index, 1);
    try { this.replicas.get(message.to)!.ingest(message.bytes); this.delivered++; }
    catch (error) { this.failures.push({ from: message.from, to: message.to, reason: String(error) }); }
    return true;
  }
  requestMissing(replicaId: string): number {
    const receiver = this.replicas.get(replicaId); if (!receiver) throw new Error('requester offline');
    let count = 0;
    for (const predecessor of receiver.missingPredecessors()) {
      for (const [peerId, peer] of this.replicas) {
        if (peerId === replicaId || this.partitions.has(JSON.stringify([peerId, replicaId].sort()))) continue;
        for (const bytes of peer.framesFor(predecessor)) { this.send(peerId, replicaId, bytes); count++; }
      }
    }
    this.requested += count; return count;
  }
  synchronize(from: string, to: string): void {
    const sender = this.replicas.get(from); if (!sender) throw new Error('sender offline');
    sender.framesFor().forEach(bytes => this.send(from, to, bytes));
  }
  report() {
    const digests = [...this.replicas].map(([replicaId, replica]) => ({ replicaId, digest: replica.candidateDigest(), journalDigest: replica.journalDigest(), pending: replica.missingPredecessors(), quarantined: replica.operations().filter(row => row.disposition === 'quarantined').length }));
    const missingReplicas = this.expectedReplicas.filter(id => !this.replicas.has(id));
    return {
      assumptions: 'Deterministic in-process delivery harness; queued frames are delivered only on explicit deliver calls. No finite convergence bound during partition. Candidate operation-set equality does not prove Tree-CRDT correctness.',
      missingReplicas, partitions: [...this.partitions].sort(), queued: this.queue.length, delivered: this.delivered,
      dropped: this.dropped, requested: this.requested, failures: this.failures.map(failure => ({ ...failure })), digests,
      candidateSetsEqual: missingReplicas.length === 0 && digests.every(row => row.pending.length === 0) && new Set(digests.map(row => row.digest)).size === 1,
      authenticatedJournalsEqual: missingReplicas.length === 0 && new Set(digests.map(row => row.journalDigest)).size === 1,
    };
  }
}
