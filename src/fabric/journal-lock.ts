import { closeSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { decodeCanonical, encodeCanonical, encodingLimits, exactObject, identifier, type EncodingLimits } from './encoding.ts';

export type JournalLockFault = 'before-ticket-publish' | 'after-ticket-publish' | 'before-ticket-release' | 'after-ticket-release' | 'before-dead-ticket-release' | 'after-dead-ticket-release';
interface LockTicket { format: string; sequence: number; token: string; pid: number }
/** Same-host journal mutex. Immutable fsynced tickets avoid partial owner records
 * and ABA races. Recovery releases an exact dead ticket, never a reusable path.
 * Tickets are bounded and not compacted without a quiescent migration protocol. */
export class JournalLock {
  private readonly directory: string;
  private readonly maxTickets: number;
  private readonly limits: EncodingLimits;
  private readonly domain: string;
  private readonly busyError: string;
  private readonly fault?: (point: JournalLockFault) => void;
  constructor(options: { directory: string; maxTickets?: number; limits?: Partial<EncodingLimits>; domain?: string; busyError?: string; fault?: (point: JournalLockFault) => void }) {
    this.directory = options.directory; this.maxTickets = options.maxTickets ?? 10_000;
    this.limits = encodingLimits(options.limits); this.domain = options.domain ?? 'aether.journal-lock';
    this.busyError = options.busyError ?? 'journal admission busy; no timeout takeover'; this.fault = options.fault;
    if (!Number.isSafeInteger(this.maxTickets) || this.maxTickets < 1) throw new TypeError('invalid effect lock ticket capacity');
    mkdirSync(this.directory, { recursive: true });
  }
  private publishLockRecord(name: string, value: unknown, beforePublish?: () => void): boolean {
    const temporary = join(this.directory, `.tmp-${process.pid}-${randomUUID()}`);
    const fd = openSync(temporary, 'wx', 0o600);
    try {
      writeFileSync(fd, encodeCanonical(value, this.limits)); fsyncSync(fd);
    } finally { closeSync(fd); }
    try {
      beforePublish?.();
      try { linkSync(temporary, join(this.directory, name)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false; throw error; }
      const directory = openSync(this.directory, 'r'); try { fsyncSync(directory); } finally { closeSync(directory); }
      return true;
    } finally { if (existsSync(temporary)) unlinkSync(temporary); }
  }
  private ticketName(sequence: number, released = false): string { return `${released ? 'released' : 'ticket'}-${String(sequence).padStart(12, '0')}.json`; }
  private tickets(): LockTicket[] {
    const names = readdirSync(this.directory).filter(name => !name.startsWith('.tmp-'));
    if (names.length > this.maxTickets * 2) throw new RangeError('effect lock ticket capacity exceeded');
    if (names.some(name => !/^(?:ticket|released)-[0-9]{12,}\.json$/.test(name))) throw new TypeError('unknown lock ticket record');
    const tickets = names.filter(name => name.startsWith('ticket-')).map(name => {
      const path = join(this.directory, name);
      if (statSync(path).size > 4096) throw new RangeError('oversized lock ticket');
      const value = exactObject(decodeCanonical(readFileSync(path), this.limits), ['format', 'sequence', 'token', 'pid']);
      if (value.format !== `${this.domain}-ticket/1` || typeof value.sequence !== 'number' || !Number.isSafeInteger(value.sequence) || value.sequence < 1 || value.sequence > this.maxTickets || typeof value.pid !== 'number' || !Number.isSafeInteger(value.pid) || value.pid < 1) throw new TypeError('invalid lock ticket');
      identifier(value.token);
      if (name !== this.ticketName(value.sequence)) throw new TypeError('lock ticket filename mismatch');
      return value as unknown as LockTicket;
    }).sort((a, b) => a.sequence - b.sequence);
    // Atomic slot creation retains a contiguous allocation prefix. A missing
    // slot is corruption, not permission to recycle a sequence number.
    if (tickets.some((ticket, index) => ticket.sequence !== index + 1)) throw new TypeError('missing lock ticket sequence');
    return tickets;
  }
  private released(ticket: LockTicket): boolean {
    const file = join(this.directory, this.ticketName(ticket.sequence, true));
    if (!existsSync(file)) return false;
    if (statSync(file).size > 4096) throw new RangeError('oversized lock release');
    const release = exactObject(decodeCanonical(readFileSync(file), this.limits), ['format', 'sequence', 'token']);
    if (release.format !== `${this.domain}-release/1` || release.sequence !== ticket.sequence || release.token !== ticket.token) throw new TypeError('lock release does not match owner');
    return true;
  }
  private release(ticket: LockTicket): void {
    this.publishLockRecord(this.ticketName(ticket.sequence, true), { format: `${this.domain}-release/1`, sequence: ticket.sequence, token: ticket.token });
    if (!this.released(ticket)) throw new Error('lock ticket release failed');
  }
  run<T>(run: () => T, waitMs = 0): T {
    let ticket: LockTicket;
    for (;;) {
      const tickets = this.tickets();
      if (tickets.length >= this.maxTickets) throw new RangeError('effect lock ticket capacity exceeded; quiescent maintenance required');
      ticket = { format: `${this.domain}-ticket/1`, sequence: tickets.length + 1, token: randomUUID(), pid: process.pid };
      if (this.publishLockRecord(this.ticketName(ticket.sequence), ticket, () => this.fault?.('before-ticket-publish'))) break;
    }
    try {
      this.fault?.('after-ticket-publish');
      const deadline = Date.now() + waitMs;
      while (this.tickets().some(previous => previous.sequence < ticket.sequence && !this.released(previous))) {
        if (waitMs === 0 || Date.now() >= deadline) throw new Error(this.busyError);
        this.recoverDeadWriter(false);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      }
      return run();
    } finally {
      this.fault?.('before-ticket-release'); this.release(ticket); this.fault?.('after-ticket-release');
    }
  }
  /** Dead tickets retain their sequence identity forever. Two recovering
   * processes may release the same dead ticket idempotently; neither can touch
   * a newer writer's ticket. PID reuse and unverifiable owners fail closed. */
  recoverDeadWriter(requireAllDead = true): void {
    for (const ticket of this.tickets()) {
      if (this.released(ticket)) continue;
      try { process.kill(ticket.pid, 0); if (requireAllDead) throw new Error('effect writer remains alive'); continue; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
      this.fault?.('before-dead-ticket-release'); this.release(ticket); this.fault?.('after-dead-ticket-release');
    }
  }
}
