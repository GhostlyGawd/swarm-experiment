/** Immutable checkpoint/event persistence and atomic, generation-bound head CAS.
 * Snapshots are retained after rewind; external broker receipts are never erased.
 */
import { closeSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { decodeCanonical, encodeCanonical, exactObject, identifier } from '../fabric/encoding.ts';
import { domainDigest, validateDigest, type Digest } from '../fabric/identity.ts';
import { JournalLock } from '../fabric/journal-lock.ts';
import type { ResumableProgram } from './resumable-program.ts';
import { MACHINE_LIMITS, checkpointDigest, eventDigest, machineClone, validateResumableSnapshot, type ResumableSnapshot } from './resumable-state.ts';
import { CheckpointSemanticRetention } from './checkpoint-semantic-retention.ts';

export interface CheckpointHead {
  readonly id: Digest; readonly generation: number; readonly parent: Digest | null;
  readonly snapshot: Digest; readonly eventCursor: string; readonly eventHead: Digest; readonly label: string;
}
export type CheckpointPersistenceFault = 'before-checkpoint-publish' | 'after-checkpoint-publish' | 'before-event-publish' | 'after-event-publish' | 'before-head-publish' | 'after-head-publish';
export interface ResumableCheckpointOptions {
  readonly directory: string; readonly program: ResumableProgram; readonly executionId: string;
  readonly maxCheckpoints?: number; readonly maxTickets?: number;
  /** Opt-in same-store replay retention. A version-1 journal cannot be upgraded
   * implicitly, and a version-2 journal cannot reopen without this authority. */
  readonly semanticRetention?: CheckpointSemanticRetention;
  readonly fault?: (point: CheckpointPersistenceFault) => void;
}
interface Journal {
  format: 'aether.checkpoint-journal/1' | 'aether.checkpoint-journal/2'; executionId: string; programDigest: Digest;
  retentionAuthority?: Digest;
  maxCheckpoints: number; maxTickets: number; heads: CheckpointHead[];
}
function sync(path: string): void { const fd = openSync(path, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } }
function directory(path: string): void { if (existsSync(path)) { if (!statSync(path).isDirectory()) throw new TypeError('checkpoint directory is not a directory'); return; } directory(dirname(path)); try { mkdirSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; } sync(path); sync(dirname(path)); }
const suffix = (digest: Digest): string => { validateDigest(digest); return digest.split(':').at(-1)!; };
const bytes = (value: unknown): Uint8Array => encodeCanonical(value, MACHINE_LIMITS);
const same = (a: unknown, b: unknown): boolean => Buffer.from(bytes(a)).equals(Buffer.from(bytes(b)));
export class ResumableCheckpointStore {
  private readonly options: ResumableCheckpointOptions;
  private readonly lock: JournalLock;
  private readonly file: string;
  private readonly maxCheckpoints: number;
  private readonly maxTickets: number;
  private readonly authority?: CheckpointSemanticRetention;
  constructor(options: ResumableCheckpointOptions) {
    identifier(options.executionId); this.options = options; this.maxCheckpoints = options.maxCheckpoints ?? 1024; this.maxTickets = options.maxTickets ?? 100_000;
    if (options.semanticRetention) CheckpointSemanticRetention.assertInstance(options.semanticRetention);
    this.authority = options.semanticRetention;
    if (!Number.isSafeInteger(this.maxCheckpoints) || this.maxCheckpoints < 1 || !Number.isSafeInteger(this.maxTickets) || this.maxTickets < 1) throw new TypeError('invalid checkpoint capacity');
    for (const path of [options.directory, join(options.directory, 'objects'), join(options.directory, 'events'), join(options.directory, 'lock')]) directory(path);
    this.lock = new JournalLock({ directory: join(options.directory, 'lock'), domain: 'aether.resumable-checkpoints', maxTickets: this.maxTickets });
    this.file = join(options.directory, 'heads.json');
    this.run(() => {
      const markerFile = join(options.directory, 'initialized.json');
      const marker = { format: this.authority ? 'aether.checkpoint-initialized/2' : 'aether.checkpoint-initialized/1', executionId: options.executionId, programDigest: options.program.digest, maxCheckpoints: this.maxCheckpoints, maxTickets: this.maxTickets,
        ...(this.authority ? { retentionAuthority: this.authority.digest } : {}) };
      if (!existsSync(this.file)) {
        if (existsSync(markerFile)) throw new Error('missing initialized checkpoint journal');
        if (this.authority && ['objects', 'events'].some(name => readdirSync(join(options.directory, name)).some(file => !file.startsWith('.'))))
          throw new Error('missing checkpoint journal with published checkpoint objects');
        if (this.authority) this.authority.prepare(options.directory, options.program, options.executionId);
        else if (CheckpointSemanticRetention.hasMarker(options.directory)) throw new Error('checkpoint semantic retention authority required');
        this.publish(this.file, bytes({ format: this.authority ? 'aether.checkpoint-journal/2' : 'aether.checkpoint-journal/1', executionId: options.executionId, programDigest: options.program.digest, maxCheckpoints: this.maxCheckpoints, maxTickets: this.maxTickets,
          ...(this.authority ? { retentionAuthority: this.authority.digest } : {}), heads: [] }));
      }
      const journal = this.read();
      this.assertAuthority();
      if (existsSync(markerFile)) { if (!same(this.readValue(markerFile), marker)) throw new Error('checkpoint initialization profile mismatch'); }
      else { if (journal.heads.length) throw new Error('missing checkpoint initialization receipt'); this.publish(markerFile, bytes(marker)); }
    });
  }
  private run<T>(operation: () => T): T { this.lock.recoverDeadWriter(false); return this.lock.run(operation, 10_000); }
  private readValue(path: string): unknown { if (statSync(path).size > MACHINE_LIMITS.maxFrameBytes) throw new RangeError('checkpoint file size limit'); return decodeCanonical(readFileSync(path), MACHINE_LIMITS); }
  private publish(path: string, contents: Uint8Array, immutable = false): void {
    const temporary = join(dirname(path), `.checkpoint-${process.pid}-${randomUUID()}`), fd = openSync(temporary, 'wx', 0o600);
    try { writeFileSync(fd, contents); fsyncSync(fd); } finally { closeSync(fd); }
    try {
      if (immutable) { try { linkSync(temporary, path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; if (!Buffer.from(readFileSync(path)).equals(Buffer.from(contents))) throw new Error('corrupt immutable checkpoint object'); } }
      else renameSync(temporary, path);
      sync(dirname(path));
    } finally { if (existsSync(temporary)) unlinkSync(temporary); }
  }
  private read(): Journal {
    const raw = this.readValue(this.file);
    if (!raw || typeof raw !== 'object' || (raw as Record<string, unknown>).format !== (this.authority ? 'aether.checkpoint-journal/2' : 'aether.checkpoint-journal/1')) throw new TypeError('checkpoint journal profile mismatch');
    const value = exactObject(raw, ['format', 'executionId', 'programDigest', 'maxCheckpoints', 'maxTickets', 'heads', ...(this.authority ? ['retentionAuthority'] : [])]);
    if (value.format !== (this.authority ? 'aether.checkpoint-journal/2' : 'aether.checkpoint-journal/1') || value.retentionAuthority !== this.authority?.digest || value.executionId !== this.options.executionId || value.programDigest !== this.options.program.digest || value.maxCheckpoints !== this.maxCheckpoints || value.maxTickets !== this.maxTickets || !Array.isArray(value.heads) || value.heads.length > this.maxCheckpoints) throw new TypeError('checkpoint journal profile mismatch');
    let previous: Digest | null = null;
    for (let index = 0; index < value.heads.length; index++) {
      const head = exactObject(value.heads[index], ['id', 'generation', 'parent', 'snapshot', 'eventCursor', 'eventHead', 'label']);
      const { id, ...body } = head;
      if (id !== domainDigest('aether.checkpoint-head/1', body) || head.parent !== previous || head.generation !== index + 1) throw new TypeError('corrupt checkpoint head history');
      validateDigest(head.snapshot, 'aether.resumable-state/1'); validateDigest(head.eventHead); identifier(head.label); previous = id as Digest;
    }
    return value as unknown as Journal;
  }
  private assertAuthority(): void { this.authority?.assert(this.options.directory, this.options.program, this.options.executionId); }
  head(): CheckpointHead | null { this.assertAuthority(); return this.read().heads.at(-1) ?? null; }
  history(): readonly CheckpointHead[] { this.assertAuthority(); return this.read().heads; }
  save(input: ResumableSnapshot, expectedHead: Digest | null, label = 'checkpoint'): CheckpointHead {
    identifier(label); const snapshot = machineClone(input); validateResumableSnapshot(snapshot, this.options.program);
    if (snapshot.core.executionId !== this.options.executionId) throw new TypeError('checkpoint execution mismatch');
    const digest = checkpointDigest(snapshot);
    return this.run(() => {
      this.assertAuthority();
      const journal = this.read(), previous = journal.heads.at(-1) ?? null;
      if ((previous?.id ?? null) !== expectedHead) throw new Error('checkpoint head compare-and-swap conflict');
      if (journal.heads.length >= this.maxCheckpoints) throw new RangeError('checkpoint retention capacity exceeded');
      for (const event of snapshot.events) {
        const path = join(this.options.directory, 'events', `${suffix(eventDigest(event))}.json`);
        if (existsSync(path)) { if (!same(this.readValue(path), event)) throw new Error('corrupt immutable checkpoint event'); continue; }
        this.options.fault?.('before-event-publish'); this.publish(path, bytes(event), true); this.options.fault?.('after-event-publish');
      }
      const path = join(this.options.directory, 'objects', `${suffix(digest)}.json`);
      this.options.fault?.('before-checkpoint-publish'); this.publish(path, bytes(snapshot), true); this.options.fault?.('after-checkpoint-publish');
      const body = { generation: journal.heads.length + 1, parent: previous?.id ?? null, snapshot: digest, eventCursor: snapshot.eventCursor, eventHead: snapshot.eventHead, label };
      const head: CheckpointHead = { id: domainDigest('aether.checkpoint-head/1', body), ...body };
      this.assertAuthority();
      journal.heads.push(head); this.options.fault?.('before-head-publish'); this.publish(this.file, bytes(journal)); this.options.fault?.('after-head-publish'); return head;
    });
  }
  load(headId?: Digest): ResumableSnapshot {
    this.assertAuthority();
    const journal = this.read(), head = headId === undefined ? journal.heads.at(-1) : journal.heads.find(item => item.id === headId);
    if (!head) throw new ReferenceError('unknown durable checkpoint head');
    const snapshot = this.readValue(join(this.options.directory, 'objects', `${suffix(head.snapshot)}.json`));
    validateResumableSnapshot(snapshot, this.options.program);
    if (checkpointDigest(snapshot) !== head.snapshot || snapshot.core.executionId !== this.options.executionId || snapshot.eventCursor !== head.eventCursor || snapshot.eventHead !== head.eventHead) throw new TypeError('durable checkpoint subject/event mismatch');
    for (const event of snapshot.events) {
      const persisted = this.readValue(join(this.options.directory, 'events', `${suffix(eventDigest(event))}.json`));
      if (!same(persisted, event)) throw new TypeError('durable checkpoint event prefix mismatch');
    }
    return snapshot;
  }
}
