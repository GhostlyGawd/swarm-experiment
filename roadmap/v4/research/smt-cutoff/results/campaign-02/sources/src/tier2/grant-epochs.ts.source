/** Same-host durable revocation epochs for scoped capability grants.
 *
 * Any policy/revocation change advances a global epoch, so old signed grants
 * never regain authority after restore. This conservative profile invalidates
 * more grants than strictly necessary, but never leaves a scoped stale grant
 * usable at an external sink.
 */
import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodeCanonical, encodeCanonical, exactObject, identifier, decimal } from '../fabric/encoding.ts';
import { domainDigest } from '../fabric/identity.ts';
import { capability, type CapabilityName } from '../tier1/ids.ts';
import { JournalLock } from '../fabric/journal-lock.ts';

interface RevokedPath { readonly capability: CapabilityName; readonly path: readonly string[] }
interface EpochState {
  readonly format: 'aether.grant-epochs/1'; readonly repositoryId: string;
  readonly revision: number; readonly epoch: string; readonly policyEpoch: string;
  readonly revoked: readonly RevokedPath[];
}
export interface GrantEpochOptions { readonly directory: string; readonly repositoryId: string; readonly waitMs?: number }
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
function resourcePath(value: unknown): asserts value is readonly string[] {
  if (!Array.isArray(value) || value.length > 32 || value.some(part => typeof part !== 'string' || !SEGMENT.test(part) || part === '.' || part === '..')) throw new TypeError('invalid grant revocation path');
}
function validState(value: unknown, repositoryId: string): asserts value is EpochState {
  const s = exactObject(value, ['format', 'repositoryId', 'revision', 'epoch', 'policyEpoch', 'revoked']);
  if (s.format !== 'aether.grant-epochs/1' || s.repositoryId !== repositoryId || !Number.isSafeInteger(s.revision) || (s.revision as number) < 0) throw new TypeError('invalid grant epoch state');
  decimal(s.epoch); decimal(s.policyEpoch);
  if (BigInt(s.epoch as string) !== BigInt(s.revision as number) || BigInt(s.policyEpoch as string) > BigInt(s.epoch as string)) throw new TypeError('grant epoch sequence mismatch');
  if (!Array.isArray(s.revoked) || s.revoked.length > 10_000) throw new TypeError('invalid grant revocations');
  const seen = new Set<string>(); let previous: string | null = null;
  for (const value of s.revoked) {
    const row = exactObject(value, ['capability', 'path']); capability(row.capability as string); resourcePath(row.path);
    const key = JSON.stringify([row.capability, row.path]); if (seen.has(key) || previous !== null && previous >= key) throw new TypeError('duplicate or unordered grant revocation'); seen.add(key); previous = key;
  }
}
const prefix = (parent: readonly string[], child: readonly string[]): boolean => parent.length <= child.length && parent.every((part, index) => part === child[index]);
const rowKey = (row: RevokedPath): string => JSON.stringify([row.capability, row.path]);

export class DurableGrantEpochs {
  private readonly options: GrantEpochOptions;
  private readonly lock: JournalLock;
  private readonly waitMs: number;
  constructor(options: GrantEpochOptions) {
    identifier(options.repositoryId); this.options = options;
    this.waitMs = options.waitMs ?? 10_000;
    if (!Number.isSafeInteger(this.waitMs) || this.waitMs < 0) throw new TypeError('invalid grant epoch lock wait');
    mkdirSync(options.directory, { recursive: true, mode: 0o700 });
    const lockDirectory = join(options.directory, 'lock'); mkdirSync(lockDirectory, { recursive: true, mode: 0o700 });
    this.lock = new JournalLock({ directory: lockDirectory, domain: 'aether.grant-epochs', maxTickets: 100_000 });
    this.run(() => this.initialize());
  }
  private statePath(): string { return join(this.options.directory, 'state.json'); }
  private sealPath(): string { return join(this.options.directory, 'initialized.json'); }
  private markerPath(): string { return join(this.options.directory, 'initializing.json'); }
  private publish(path: string, value: unknown): void {
    const temporary = join(this.options.directory, `.grant-${process.pid}-${randomUUID()}.tmp`);
    const fd = openSync(temporary, 'wx', 0o600);
    try { writeFileSync(fd, encodeCanonical(value, { maxFrameBytes: 1024 * 1024, maxDecompressedBytes: 1024 * 1024 })); fsyncSync(fd); }
    finally { closeSync(fd); }
    try { renameSync(temporary, path); const dir = openSync(this.options.directory, 'r'); try { fsyncSync(dir); } finally { closeSync(dir); } }
    finally { if (existsSync(temporary)) unlinkSync(temporary); }
  }
  private read(): EpochState {
    if (statSync(this.statePath()).size > 1024 * 1024) throw new RangeError('grant epoch state byte limit');
    const wrapper = exactObject(decodeCanonical(readFileSync(this.statePath()), { maxFrameBytes: 1024 * 1024, maxDecompressedBytes: 1024 * 1024 }), ['format', 'state', 'checksum']);
    if (wrapper.format !== 'aether.grant-epoch-record/1' || wrapper.checksum !== domainDigest('aether.grant-epoch-record/1', wrapper.state)) throw new TypeError('corrupt grant epoch record');
    validState(wrapper.state, this.options.repositoryId); return wrapper.state;
  }
  private save(state: EpochState): void {
    validState(state, this.options.repositoryId);
    this.publish(this.statePath(), { format: 'aether.grant-epoch-record/1', state, checksum: domainDigest('aether.grant-epoch-record/1', state) });
  }
  private initialize(): void {
    const seal = existsSync(this.sealPath()), state = existsSync(this.statePath()), marker = existsSync(this.markerPath());
    const initial: EpochState = { format: 'aether.grant-epochs/1', repositoryId: this.options.repositoryId, revision: 0, epoch: '0', policyEpoch: '0', revoked: [] };
    if (marker) {
      const record = exactObject(decodeCanonical(readFileSync(this.markerPath())), ['format', 'repositoryId']);
      if (record.format !== 'aether.grant-epochs-initializing/1' || record.repositoryId !== this.options.repositoryId) throw new TypeError('grant epoch initialization marker mismatch');
    }
    if (seal) {
      const receipt = exactObject(decodeCanonical(readFileSync(this.sealPath())), ['format', 'repositoryId']);
      if (receipt.format !== 'aether.grant-epochs-initialized/1' || receipt.repositoryId !== this.options.repositoryId || !state) throw new TypeError('grant epoch initialization profile mismatch');
      this.read();
      if (marker) this.clearMarker();
      return;
    }
    if (state && !marker) throw new Error('missing grant epoch completion receipt; explicit recovery required');
    if (!marker) this.publish(this.markerPath(), { format: 'aether.grant-epochs-initializing/1', repositoryId: this.options.repositoryId });
    if (!state) this.save(initial);
    else if (!Buffer.from(encodeCanonical(this.read())).equals(Buffer.from(encodeCanonical(initial)))) throw new Error('grant epoch initialization cannot reset nonempty state');
    this.publish(this.sealPath(), { format: 'aether.grant-epochs-initialized/1', repositoryId: this.options.repositoryId });
    this.clearMarker();
  }
  private clearMarker(): void {
    unlinkSync(this.markerPath()); const dir = openSync(this.options.directory, 'r'); try { fsyncSync(dir); } finally { closeSync(dir); }
  }
  private run<T>(operation: () => T): T { this.lock.recoverDeadWriter(false); return this.lock.run(operation, this.waitMs); }
  get epoch(): string { return this.read().epoch; }
  get policyEpoch(): string { return this.read().policyEpoch; }
  isRevoked(cap: CapabilityName, path: readonly string[]): boolean {
    capability(cap); resourcePath(path);
    return this.read().revoked.some(row => row.capability === cap && prefix(row.path, path));
  }
  revoke(cap: CapabilityName, path: readonly string[]): string {
    capability(cap); resourcePath(path);
    return this.run(() => {
      const state = this.read(), row = { capability: cap, path: [...path] };
      if (state.revoked.some(item => rowKey(item) === rowKey(row))) return state.epoch;
      if (state.revoked.length >= 10_000) throw new RangeError('grant revocation count limit');
      const epoch = String(BigInt(state.epoch) + 1n);
      this.save({ ...state, revision: state.revision + 1, epoch, revoked: [...state.revoked, row].sort((a, b) => rowKey(a) < rowKey(b) ? -1 : rowKey(a) > rowKey(b) ? 1 : 0) });
      return epoch;
    });
  }
  restore(cap: CapabilityName, path: readonly string[]): string {
    capability(cap); resourcePath(path);
    return this.run(() => {
      const state = this.read(), key = rowKey({ capability: cap, path });
      if (!state.revoked.some(item => rowKey(item) === key)) return state.epoch;
      const epoch = String(BigInt(state.epoch) + 1n);
      this.save({ ...state, revision: state.revision + 1, epoch, revoked: state.revoked.filter(item => rowKey(item) !== key) });
      return epoch;
    });
  }
  advancePolicy(expected: string): string {
    decimal(expected);
    return this.run(() => {
      const state = this.read(); if (state.policyEpoch !== expected) throw new Error('grant policy epoch conflict');
      const policyEpoch = String(BigInt(expected) + 1n), epoch = String(BigInt(state.epoch) + 1n);
      this.save({ ...state, revision: state.revision + 1, epoch, policyEpoch }); return policyEpoch;
    });
  }
}
