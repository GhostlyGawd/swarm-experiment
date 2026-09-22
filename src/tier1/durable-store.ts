/** Versioned, same-host durable AST transactions. Node identities remain the v1
 * BLAKE3 grouped-child hashes. This is an explicit successor to the legacy
 * GraphStore filesystem profile, not an in-place change to its lock protocol.
 *
 * All mutations and GC share a process-death-recoverable journal lock. Writes
 * first flush immutable objects, then atomically publish their protection in
 * one root record. A crash before publication can leave collectable orphans;
 * a published root never precedes its objects. Leases do not expire by time.
 */
import { closeSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { decodeCanonical, encodeCanonical, exactObject, validString, type WireValue } from '../fabric/encoding.ts';
import { JournalLock } from '../fabric/journal-lock.ts';
import { children, LINK_SCHEMA, withChildren, type FlatNode, type Term } from './ast.ts';
import { blake3 } from './blake3.ts';
import { bytesToHexRef, isNodeRef, type NodeRef } from './ids.ts';
import { GraphStore, hashNode, type Step } from './store.ts';

export interface DurableStoreLimits {
  readonly maxNodes: number;
  readonly maxObjectBytes: number;
  readonly maxArchiveBytes: number;
  readonly maxRoots: number;
  readonly maxTickets: number;
}
const defaults: DurableStoreLimits = { maxNodes: 100_000, maxObjectBytes: 1024 * 1024, maxArchiveBytes: 64 * 1024 * 1024, maxRoots: 10_000, maxTickets: 100_000 };
export interface DurableRootHead { readonly root: NodeRef; readonly generation: number }
export interface PendingAstPromotion { readonly from: NodeRef; readonly to: NodeRef }
interface FinalizedAstPromotion extends PendingAstPromotion { outcome: 'abort' | 'commit'; name: string | null; generation: number | null }
export interface DurableRootState {
  revision: number;
  heads: Record<string, DurableRootHead>;
  committed: NodeRef[];
  leases: Record<string, NodeRef[]>;
  promotions: Record<string, PendingAstPromotion>;
  retiredLeases: string[];
  finalizedPromotions: Record<string, FinalizedAstPromotion>;
}
export type DurableStoreFault = 'before-object-publish' | 'after-object-publish' | 'before-root-publish' | 'after-root-publish' | 'before-gc-delete' | 'after-gc-delete'
  | 'before-init-marker' | 'after-init-marker' | 'after-profile-publish' | 'after-init-seal' | 'before-init-clear' | 'after-init-clear';
export interface DurableGraphStoreOptions {
  readonly directory: string;
  readonly limits?: Partial<DurableStoreLimits>;
  readonly waitMs?: number;
  /** Fault injection at durable publication boundaries; intended for tests. */
  readonly fault?: (point: DurableStoreFault) => void;
}
export interface DurableCollectionResult { readonly keptObjects: number; readonly removedObjects: number; readonly protectedRoots: number }

const blank = (): DurableRootState => ({ revision: 0, heads: Object.create(null), committed: [], leases: Object.create(null), promotions: Object.create(null), retiredLeases: [], finalizedPromotions: Object.create(null) });
const key = (value: unknown): string => {
  validString(value);
  if (!value.length || value.length > 256 || /[\u0000-\u001f\u007f]/.test(value)) throw new TypeError('invalid root identity');
  return value;
};
const ref = (value: unknown): NodeRef => { if (!isNodeRef(value)) throw new TypeError('invalid AST reference'); return value; };
const digest = (bytes: Uint8Array): string => bytesToHexRef(blake3(bytes), 'store:b3:');
const syncDirectory = (path: string): void => { const fd = openSync(path, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } };

function durableMkdir(path: string): void {
  if (existsSync(path)) { if (!statSync(path).isDirectory()) throw new TypeError('durable AST directory is not a directory'); return; }
  const parent = dirname(path);
  if (parent !== path) durableMkdir(parent);
  try { mkdirSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  syncDirectory(path); syncDirectory(parent);
}

/** Every value carries an explicit tag: AST payload objects cannot collide with
 * a bigint sentinel. Optional undefined object properties are omitted exactly
 * as in v1 hashing. Accessors, sparse arrays, cycles and opaque objects reject. */
function packValue(value: unknown, depth = 0, active = new Set<object>(), budget = { remaining: 100_000 }): WireValue {
  if (--budget.remaining < 0) throw new RangeError('AST payload object count exceeded');
  if (depth > 64) throw new RangeError('AST payload depth exceeded');
  if (value === null) return ['null'];
  if (typeof value === 'bigint') { const text = String(value); if (text.length > 4097) throw new RangeError('integer digit limit exceeded'); return ['bigint', text]; }
  if (typeof value === 'string') validString(value);
  if (typeof value === 'number' && (!Number.isSafeInteger(value) || Object.is(value, -0))) throw new TypeError('invalid AST scalar number');
  if (['boolean', 'number', 'string'].includes(typeof value)) return [typeof value, value as boolean | number | string];
  if (!value || typeof value !== 'object' || active.has(value)) throw new TypeError('unsupported or cyclic AST payload');
  active.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.keys(value).length !== value.length || Reflect.ownKeys(value).length !== value.length + 1) throw new TypeError('sparse or extended AST array');
      const items: WireValue[] = [];
      for (let i = 0; i < value.length; i++) {
        const d = Object.getOwnPropertyDescriptor(value, String(i));
        if (!d || !('value' in d)) throw new TypeError('AST accessor');
        items.push(packValue(d.value, depth + 1, active, budget));
      }
      return ['array', items];
    }
    const names = Object.keys(value).sort(); exactObject(value, names); names.forEach(validString);
    return ['object', names.filter(name => (value as Record<string, unknown>)[name] !== undefined).map(name => [name, packValue((value as Record<string, unknown>)[name], depth + 1, active, budget)])];
  } finally { active.delete(value); }
}
function unpackValue(value: unknown): unknown {
  if (!Array.isArray(value) || typeof value[0] !== 'string') throw new TypeError('invalid AST value envelope');
  const [tag, payload] = value;
  if (tag === 'null' && value.length === 1) return null;
  if (value.length !== 2) throw new TypeError('invalid AST value arity');
  if (tag === 'bigint' && typeof payload === 'string' && /^(0|-?[1-9][0-9]*)$/.test(payload) && payload.replace('-', '').length <= 4096) return BigInt(payload);
  if (['string', 'boolean', 'number'].includes(tag) && typeof payload === tag) return payload;
  if (tag === 'array' && Array.isArray(payload)) return payload.map(unpackValue);
  if (tag === 'object' && Array.isArray(payload)) {
    const result: Record<string, unknown> = {};
    for (const pair of payload) {
      if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== 'string' || Object.hasOwn(result, pair[0])) throw new TypeError('invalid or duplicate AST object field');
      Object.defineProperty(result, pair[0], { value: unpackValue(pair[1]), enumerable: true, writable: true, configurable: true });
    }
    return result;
  }
  throw new TypeError('invalid AST value tag');
}
function validateNode(value: unknown): FlatNode {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('invalid AST node');
  const bag = value as Record<string, unknown>;
  // v1 scalarPayload used a normal object accumulator. This never was an AST
  // field; rejecting it prevents prototype assignment from hiding hash input.
  if (Object.hasOwn(bag, '__proto__')) throw new TypeError('reserved AST node field');
  if (typeof bag.kind !== 'string' || !Object.hasOwn(LINK_SCHEMA, bag.kind)) throw new TypeError('unknown AST node kind');
  for (const { field, arity } of LINK_SCHEMA[bag.kind as keyof typeof LINK_SCHEMA]) {
    const item = bag[field];
    if (arity === 'one') ref(item);
    if (arity === 'opt' && item !== undefined && item !== null) ref(item);
    if (arity === 'many') { if (!Array.isArray(item)) throw new TypeError('invalid AST child group'); item.forEach(ref); }
    if (arity === 'pairs') {
      if (!Array.isArray(item)) throw new TypeError('invalid AST pair group');
      const names = new Set<string>();
      for (const pair of item) {
        if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== 'string' || names.has(pair[0])) throw new TypeError('invalid AST named child');
        validString(pair[0]); names.add(pair[0]); ref(pair[1]);
      }
    }
  }
  return value as FlatNode;
}

export class DurableGraphStore {
  readonly directory: string;
  readonly limits: DurableStoreLimits;
  private readonly objects: string;
  private readonly lock: JournalLock;
  private readonly waitMs: number;
  private readonly fault?: DurableGraphStoreOptions['fault'];
  constructor(options: DurableGraphStoreOptions) {
    this.directory = options.directory; this.objects = join(this.directory, 'ast-objects-v1');
    this.limits = Object.freeze({ ...defaults, ...options.limits });
    for (const [name, value] of Object.entries(this.limits)) if (!(name in defaults) || !Number.isSafeInteger(value) || value < 1) throw new TypeError('invalid durable store limits');
    this.waitMs = options.waitMs ?? 10_000;
    if (!Number.isSafeInteger(this.waitMs) || this.waitMs < 0) throw new TypeError('invalid durable store lock wait');
    this.fault = options.fault;
    durableMkdir(this.objects);
    durableMkdir(join(this.directory, 'ast-lock-v1'));
    this.lock = new JournalLock({ directory: join(this.directory, 'ast-lock-v1'), maxTickets: this.limits.maxTickets, domain: 'aether.ast-store' });
    this.run(() => this.initialize());
  }
  /** The marker is durable before either metadata file. A permanent completion
   * receipt distinguishes interrupted creation from deletion in an established
   * store, including an established store whose object table is still empty.
   * No graph operation can run until the marker is durably removed. */
  private initialize(): void {
    const profilePath = join(this.directory, 'ast-profile.json');
    const markerPath = join(this.directory, 'ast-initializing-v1.json');
    const sealPath = join(this.directory, 'ast-initialized-v1.json');
    const profile = this.encode({ format: 'aether.ast-store/1', hash: 'aether.ast-grouped-v1.blake3', limits: this.limits });
    const profileDigest = digest(profile), emptyRootsDigest = digest(this.encode(blank()));
    const readRecord = (path: string, fields: readonly string[]): Record<string, unknown> => {
      const record = exactObject(this.decode(this.read(path, this.limits.maxObjectBytes)), [...fields, 'checksum']);
      const { checksum, ...body } = record;
      if (checksum !== digest(this.encode(body))) throw new Error('corrupt AST initialization record');
      if (typeof record.initId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(record.initId)) throw new Error('AST initialization identity mismatch');
      if (record.profileDigest !== profileDigest) throw new Error('durable AST profile mismatch');
      return record;
    };
    const writeRecord = (path: string, body: Record<string, unknown>): void => {
      this.publish(path, this.encode({ ...body, checksum: digest(this.encode(body)) }));
    };
    const requireProfile = (): void => {
      if (!existsSync(profilePath)) throw new Error('missing durable AST profile; explicit recovery required');
      if (!Buffer.from(this.read(profilePath, this.limits.maxObjectBytes)).equals(Buffer.from(profile))) throw new Error('durable AST profile mismatch');
    };
    const requireRoots = (): void => {
      if (!existsSync(this.statePath())) throw new Error('missing durable AST root record; explicit recovery required');
      this.state();
    };
    const marker = existsSync(markerPath) ? readRecord(markerPath, ['format', 'initId', 'profileDigest', 'emptyRootsDigest']) : null;
    if (marker && (marker.format !== 'aether.ast-initializing/1' || marker.emptyRootsDigest !== emptyRootsDigest)) throw new Error('invalid AST initialization marker');
    const seal = existsSync(sealPath) ? readRecord(sealPath, ['format', 'initId', 'profileDigest']) : null;
    if (seal && seal.format !== 'aether.ast-initialized/1') throw new Error('invalid AST initialization completion receipt');

    if (seal) {
      // These files were durable before the completion receipt. Their absence
      // is corruption, even if an old valid initialization marker is replayed.
      requireProfile(); requireRoots();
      if (marker) {
        if (marker.initId !== seal.initId || digest(this.encode(this.state())) !== emptyRootsDigest || readdirSync(this.objects).length !== 0) throw new Error('initialization marker conflicts with established AST state');
        this.clearInitialization(markerPath);
      }
      return;
    }

    if (!marker && existsSync(profilePath) && existsSync(this.statePath())) {
      // Existing initialized v1 stores acquire only an auxiliary completion
      // receipt. Their profile, root record and immutable object bytes stay as-is.
      requireProfile(); requireRoots();
      writeRecord(sealPath, { format: 'aether.ast-initialized/1', initId: randomUUID(), profileDigest });
      return;
    }
    if (!marker && (existsSync(profilePath) || existsSync(this.statePath()))) throw new Error('missing durable AST profile or root record; explicit recovery required');
    if (readdirSync(this.objects).length !== 0) throw new Error('initialization cannot reset an existing AST object table');

    // Validate every surviving initialization record before filling in an
    // absent one. Recovery never overwrites nonempty or corrupt roots.
    if (existsSync(profilePath)) requireProfile();
    if (existsSync(this.statePath()) && digest(this.encode(this.state())) !== emptyRootsDigest) throw new Error('initialization cannot reset nonempty AST roots');
    const initId = marker ? marker.initId as string : randomUUID();
    if (!marker) {
      this.fault?.('before-init-marker');
      writeRecord(markerPath, { format: 'aether.ast-initializing/1', initId, profileDigest, emptyRootsDigest });
      this.fault?.('after-init-marker');
    }
    if (!existsSync(profilePath)) {
      this.publish(profilePath, profile);
      this.fault?.('after-profile-publish');
    }
    if (!existsSync(this.statePath())) this.save(blank());
    requireProfile(); requireRoots();
    writeRecord(sealPath, { format: 'aether.ast-initialized/1', initId, profileDigest });
    this.fault?.('after-init-seal');
    this.clearInitialization(markerPath);
  }
  private clearInitialization(markerPath: string): void {
    this.fault?.('before-init-clear');
    unlinkSync(markerPath); syncDirectory(this.directory);
    this.fault?.('after-init-clear');
  }
  private encode(value: unknown, archive = false): Uint8Array {
    const size = archive ? this.limits.maxArchiveBytes : this.limits.maxObjectBytes;
    return encodeCanonical(value, { maxFrameBytes: size, maxDecompressedBytes: size, maxObjects: Math.max(100_000, size), maxDepth: 256 });
  }
  private decode(bytes: Uint8Array, archive = false): WireValue {
    const size = archive ? this.limits.maxArchiveBytes : this.limits.maxObjectBytes;
    return decodeCanonical(bytes, { maxFrameBytes: size, maxDecompressedBytes: size, maxObjects: Math.max(100_000, size), maxDepth: 256 });
  }
  private read(path: string, maximum: number): Uint8Array { if (statSync(path).size > maximum) throw new RangeError('durable AST file limit exceeded'); return readFileSync(path); }
  private run<T>(operation: () => T): T { this.lock.recoverDeadWriter(false); return this.lock.run(operation, this.waitMs); }
  private publish(path: string, bytes: Uint8Array, immutable = false): void {
    const temporary = join(this.directory, `.ast-${process.pid}-${randomUUID()}.tmp`);
    const fd = openSync(temporary, 'wx', 0o600);
    try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
    try {
      if (immutable) {
        try { linkSync(temporary, path); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
        syncDirectory(this.objects);
      } else { renameSync(temporary, path); syncDirectory(this.directory); }
    } finally { if (existsSync(temporary)) unlinkSync(temporary); }
  }
  private statePath(): string { return join(this.directory, 'ast-roots-v1.json'); }
  private state(): DurableRootState {
    const wrapper = exactObject(this.decode(this.read(this.statePath(), this.limits.maxObjectBytes)), ['format', 'checksum', 'state']);
    if (wrapper.format !== 'aether.ast-roots/1' || wrapper.checksum !== digest(this.encode(wrapper.state))) throw new Error('corrupt AST root record');
    const state = exactObject(wrapper.state, ['revision', 'heads', 'committed', 'leases', 'promotions', 'retiredLeases', 'finalizedPromotions']) as unknown as DurableRootState;
    if (!Number.isSafeInteger(state.revision) || state.revision < 0) throw new TypeError('invalid AST root revision');
    for (const map of [state.heads, state.leases, state.promotions, state.finalizedPromotions]) exactObject(map, Object.keys(map));
    if (!Array.isArray(state.committed)) throw new TypeError('invalid committed roots');
    state.committed.forEach(ref);
    for (const [name, value] of Object.entries(state.heads)) {
      key(name); exactObject(value, ['root', 'generation']); ref(value.root);
      if (!Number.isSafeInteger(value.generation) || value.generation < 1 || !state.committed.includes(value.root)) throw new TypeError('invalid committed head');
    }
    for (const [id, roots] of Object.entries(state.leases)) { key(id); if (!Array.isArray(roots)) throw new TypeError('invalid AST lease'); roots.forEach(ref); }
    for (const [id, promotion] of Object.entries(state.promotions)) { key(id); exactObject(promotion, ['from', 'to']); ref(promotion.from); ref(promotion.to); }
    if (!Array.isArray(state.retiredLeases)) throw new TypeError('invalid retired AST leases');
    state.retiredLeases.forEach(key);
    if (state.retiredLeases.some(id => Object.hasOwn(state.leases, id))) throw new TypeError('active retired AST lease');
    for (const [id, value] of Object.entries(state.finalizedPromotions)) {
      key(id); exactObject(value, ['from', 'to', 'outcome', 'name', 'generation']); ref(value.from); ref(value.to);
      if (Object.hasOwn(state.promotions, id)) throw new TypeError('active finalized AST promotion');
      if (value.outcome === 'abort') { if (value.name !== null || value.generation !== null) throw new TypeError('invalid aborted AST promotion'); }
      else if (value.outcome === 'commit') {
        key(value.name); if (!Number.isSafeInteger(value.generation) || value.generation === null || value.generation < 1 || !state.committed.includes(value.to)) throw new TypeError('invalid finalized AST promotion');
      } else throw new TypeError('invalid AST promotion outcome');
    }
    this.boundState(state);
    return state;
  }
  private boundState(state: DurableRootState): void {
    const count = Object.keys(state.heads).length + state.committed.length + Object.keys(state.promotions).length * 2 + Object.values(state.leases).reduce((sum, roots) => sum + roots.length, 0);
    if (count > this.limits.maxRoots || Object.keys(state.leases).length + state.retiredLeases.length + Object.keys(state.finalizedPromotions).length > this.limits.maxRoots) throw new RangeError('durable root limit exceeded');
  }
  private save(state: DurableRootState): void {
    this.boundState(state);
    const bytes = this.encode({ format: 'aether.ast-roots/1', checksum: digest(this.encode(state)), state });
    this.fault?.('before-root-publish'); this.publish(this.statePath(), bytes); this.fault?.('after-root-publish');
  }
  private advance(state: DurableRootState): void { if (state.revision >= Number.MAX_SAFE_INTEGER) throw new RangeError('AST root revision exhausted'); state.revision++; this.save(state); }
  private path(root: NodeRef): string { return join(this.objects, `${ref(root).slice(7)}.json`); }
  listRefs(): NodeRef[] { return readdirSync(this.objects).filter(name => /^[a-f0-9]{64}\.json$/.test(name)).sort().map(name => `ast:b3:${name.slice(0, -5)}` as NodeRef); }
  /** Re-read and rehash on every call; corruption never hides behind a cache. */
  get(root: NodeRef): FlatNode {
    const wrapper = exactObject(this.decode(this.read(this.path(root), this.limits.maxObjectBytes)), ['format', 'node']);
    if (wrapper.format !== 'aether.ast-object/1') throw new TypeError('unsupported AST object version');
    const node = validateNode(unpackValue(wrapper.node));
    if (hashNode(node) !== root) throw new Error(`corrupt AST object ${root}`);
    return node;
  }
  private put(node: FlatNode): NodeRef {
    const packed = packValue(node);
    const copy = validateNode(unpackValue(packed));
    const root = hashNode(copy), path = this.path(root);
    if (existsSync(path)) { this.get(root); return root; }
    this.fault?.('before-object-publish');
    this.publish(path, this.encode({ format: 'aether.ast-object/1', node: packed }), true);
    this.fault?.('after-object-publish'); this.get(root); return root;
  }
  private install(nodes: readonly FlatNode[]): void {
    // Validate every frame and the resulting capacity before publishing any of
    // this transaction's objects. Reads of existing addresses also rehash.
    const additions = new Map<NodeRef, FlatNode>();
    for (const candidate of nodes) {
      const packed = packValue(candidate), node = validateNode(unpackValue(packed)), address = hashNode(node);
      this.encode({ format: 'aether.ast-object/1', node: packed });
      if (existsSync(this.path(address))) this.get(address); else additions.set(address, node);
    }
    if (this.listRefs().length + additions.size > this.limits.maxNodes) throw new RangeError('durable AST node limit exceeded');
    for (const node of additions.values()) this.put(node);
  }
  private closure(roots: readonly NodeRef[], read: (root: NodeRef) => FlatNode = root => this.get(root)): Set<NodeRef> {
    const seen = new Set<NodeRef>(), active = new Set<NodeRef>();
    const stack = roots.map(root => ({ root: ref(root), exit: false }));
    while (stack.length) {
      const item = stack.pop()!;
      if (item.exit) { active.delete(item.root); seen.add(item.root); continue; }
      if (active.has(item.root)) throw new TypeError('cyclic AST graph');
      if (seen.has(item.root)) continue;
      if (seen.size + active.size >= this.limits.maxNodes) throw new RangeError('AST traversal limit exceeded');
      active.add(item.root); stack.push({ root: item.root, exit: true });
      for (const child of children(read(item.root))) stack.push({ root: child, exit: false });
    }
    return seen;
  }
  private allRoots(state: DurableRootState): NodeRef[] { return [...new Set([...state.committed, ...Object.values(state.leases).flat(), ...Object.values(state.promotions).flatMap(p => [p.from, p.to])])]; }
  private addLease(state: DurableRootState, id: string, roots: readonly NodeRef[]): void { key(id); if (state.retiredLeases.includes(id)) throw new Error('AST lease identity retired'); state.leases[id] = [...new Set([...(state.leases[id] ?? []), ...roots])]; }
  /** Publish a complete tree and a non-expiring GC lease in one transaction. */
  intern(term: Term, options: { leaseId: string }): NodeRef {
    key(options.leaseId);
    // Memory staging validates before touching the durable object database.
    const staged = new GraphStore(); const root = staged.intern(unpackValue(packValue(term)) as Term);
    return this.run(() => {
      const state = this.state(); this.addLease(state, options.leaseId, [root]); this.boundState(state);
      this.install(staged.listRefs().map(object => staged.get(object)));
      this.closure([root]); this.advance(state); return root;
    });
  }
  /** Atomic path copying, retaining the output before GC can observe it. */
  replaceAt(root: NodeRef, path: readonly Step[], replacement: NodeRef, options: { leaseId: string }): NodeRef {
    key(options.leaseId);
    return this.run(() => {
      const staged = new GraphStore();
      for (const object of this.closure([root, replacement])) staged.put(this.get(object));
      const next = staged.replaceAt(root, path, replacement);
      const state = this.state(); this.addLease(state, options.leaseId, [next]); this.boundState(state);
      this.install(staged.listRefs().map(object => staged.get(object)));
      this.advance(state); return next;
    });
  }
  head(name: string): DurableRootHead | null { key(name); const value = this.state().heads[name]; return value ? { ...value } : null; }
  roots(): Readonly<DurableRootState> { return this.state(); }
  /** Full generation CAS rejects ABA. Historical committed roots remain retained. */
  commit(name: string, root: NodeRef, expected: DurableRootHead | null): DurableRootHead {
    key(name); ref(root);
    return this.run(() => { const state = this.state(); const next = this.update(state, name, root, expected); this.advance(state); return next; });
  }
  private update(state: DurableRootState, name: string, root: NodeRef, expected: DurableRootHead | null): DurableRootHead {
    if (expected !== null) { exactObject(expected, ['root', 'generation']); ref(expected.root); if (!Number.isSafeInteger(expected.generation) || expected.generation < 1) throw new TypeError('invalid expected AST generation'); }
    const current = state.heads[name] ?? null;
    if (current?.root !== expected?.root || current?.generation !== expected?.generation) throw new Error('AST root compare-and-swap conflict');
    this.closure([root]);
    const generation = (current?.generation ?? 0) + 1;
    if (!Number.isSafeInteger(generation)) throw new RangeError('AST head generation exhausted');
    const next = { root, generation }; state.heads[name] = next;
    if (!state.committed.includes(root)) state.committed.push(root);
    return next;
  }
  /** Fork an already committed root without writing any AST object. */
  fork(name: string, source: string): DurableRootHead {
    key(name); key(source);
    return this.run(() => {
      const state = this.state(); const origin = state.heads[source];
      if (!origin) throw new ReferenceError('unknown AST fork source');
      if (state.heads[name]) throw new Error('AST fork destination exists');
      const next = { root: origin.root, generation: 1 }; state.heads[name] = next; this.advance(state); return next;
    });
  }
  retain(leaseId: string, roots: readonly NodeRef[]): void {
    key(leaseId);
    this.run(() => { const state = this.state(); this.closure(roots); this.addLease(state, leaseId, roots); this.advance(state); });
  }
  release(leaseId: string): void { key(leaseId); this.run(() => { const state = this.state(); if (state.retiredLeases.includes(leaseId)) return; delete state.leases[leaseId]; state.retiredLeases.push(leaseId); this.advance(state); }); }
  stagePromotion(id: string, value: PendingAstPromotion): void {
    key(id); exactObject(value, ['from', 'to']); ref(value.from); ref(value.to);
    this.run(() => {
      const state = this.state(), old = state.promotions[id];
      if (state.finalizedPromotions[id]) throw new Error('AST promotion identity finalized');
      if (old && (old.from !== value.from || old.to !== value.to)) throw new Error('AST promotion identity reused');
      this.closure([value.from, value.to]); state.promotions[id] = { ...value }; this.advance(state);
    });
  }
  finishPromotion(id: string, action: { kind: 'abort' } | { kind: 'commit'; name: string; expected: DurableRootHead }): void {
    key(id);
    this.run(() => {
      const state = this.state(), pending = state.promotions[id];
      if (!pending) {
        const final = state.finalizedPromotions[id];
        if (!final) throw new ReferenceError('unknown AST pending promotion');
        if (action.kind !== final.outcome || (action.kind === 'commit' && (action.name !== final.name || action.expected.root !== final.from || action.expected.generation + 1 !== final.generation))) throw new Error('AST promotion terminal retry conflict');
        return;
      }
      let committed: DurableRootHead | null = null;
      if (action.kind === 'commit') {
        key(action.name);
        if (action.expected.root !== pending.from) throw new Error('AST promotion source mismatch');
        committed = this.update(state, action.name, pending.to, action.expected);
      } else if (action.kind !== 'abort') throw new TypeError('invalid AST promotion action');
      state.finalizedPromotions[id] = { ...pending, outcome: action.kind, name: action.kind === 'commit' ? action.name : null, generation: committed?.generation ?? null };
      delete state.promotions[id]; this.advance(state);
    });
  }
  hydrate(root: NodeRef): Term {
    return this.run(() => {
      this.closure([root]);
      let remaining = 100_000;
      const inflate = (address: NodeRef, depth: number): Term => {
        if (depth > 64 || --remaining < 0) throw new RangeError('hydrated AST expansion limit exceeded');
        const node = this.get(address);
        return withChildren(node as never, children(node).map(child => inflate(child, depth + 1)) as never) as Term;
      };
      return inflate(root, 0);
    });
  }
  collectGarbage(): DurableCollectionResult {
    return this.run(() => {
      const state = this.state(), roots = this.allRoots(state), live = this.closure(roots);
      let removedObjects = 0;
      for (const object of this.listRefs()) if (!live.has(object)) {
        this.fault?.('before-gc-delete'); unlinkSync(this.path(object)); syncDirectory(this.objects); removedObjects++; this.fault?.('after-gc-delete');
      }
      return { keptObjects: live.size, removedObjects, protectedRoots: roots.length };
    });
  }
  /** Deterministic closure archive; root labels/history stay in the repository.
   * Import pins all exported roots under a caller-selected lease, never silently
   * changes an existing production branch or promotion authority. */
  exportArchive(roots?: readonly NodeRef[]): Uint8Array {
    return this.run(() => {
      const selected = [...new Set(roots ?? this.allRoots(this.state()))].sort();
      const objects = [...this.closure(selected)].sort().map(root => ({ ref: root, node: packValue(this.get(root)) }));
      const body = { format: 'aether.ast-archive/1', hash: 'aether.ast-grouped-v1.blake3', roots: selected, objects };
      return this.encode({ ...body, checksum: digest(this.encode(body, true)) }, true);
    });
  }
  importArchive(bytes: Uint8Array, options: { leaseId: string }): readonly NodeRef[] {
    key(options.leaseId);
    const archive = exactObject(this.decode(bytes, true), ['format', 'hash', 'roots', 'objects', 'checksum']);
    const { checksum, ...body } = archive;
    if (archive.format !== 'aether.ast-archive/1' || archive.hash !== 'aether.ast-grouped-v1.blake3') throw new TypeError('unsupported AST archive profile');
    if (checksum !== digest(this.encode(body, true))) throw new Error('corrupt AST archive checksum');
    if (!Array.isArray(archive.roots) || !Array.isArray(archive.objects) || archive.objects.length > this.limits.maxNodes) throw new TypeError('invalid AST archive');
    const roots = archive.roots.map(ref), staged = new Map<NodeRef, FlatNode>();
    if (new Set(roots).size !== roots.length) throw new TypeError('duplicate AST archive root');
    for (const entry of archive.objects) {
      const object = exactObject(entry, ['ref', 'node']); const root = ref(object.ref), node = validateNode(unpackValue(object.node));
      if (staged.has(root) || hashNode(node) !== root) throw new Error('duplicate or corrupt AST archive object');
      staged.set(root, node);
    }
    const reachable = this.closure(roots, root => { const node = staged.get(root); if (!node) throw new ReferenceError('missing AST archive child'); return node; });
    if (reachable.size !== staged.size) throw new TypeError('unreachable AST archive object');
    return this.run(() => {
      const state = this.state(); this.addLease(state, options.leaseId, roots); this.boundState(state);
      this.install([...staged.values()]);
      this.advance(state); return roots;
    });
  }
  /** Explicit migration from a quiescent legacy v1 store; hashes stay identical.
   * The legacy source must not run its uncoordinated GC during this copy. */
  importLegacy(source: GraphStore, roots: readonly NodeRef[], options: { leaseId: string }): readonly NodeRef[] {
    key(options.leaseId);
    const objects = new Map<NodeRef, FlatNode>();
    for (const root of roots) for (const address of source.reachable(ref(root))) {
      const node = validateNode(unpackValue(packValue(source.get(address))));
      if (hashNode(node) !== address) throw new Error('corrupt legacy AST object');
      objects.set(address, node);
    }
    const selected = [...new Set(roots)].sort();
    const body = { format: 'aether.ast-archive/1', hash: 'aether.ast-grouped-v1.blake3', roots: selected, objects: [...objects].sort(([a], [b]) => a.localeCompare(b)).map(([address, node]) => ({ ref: address, node: packValue(node) })) };
    return this.importArchive(this.encode({ ...body, checksum: digest(this.encode(body, true)) }, true), options);
  }
}
