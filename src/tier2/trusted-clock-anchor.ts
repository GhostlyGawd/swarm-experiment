/** Operator-provisioned time authority for expiring grants and effect deadlines.
 *
 * The deployment factory must not supply either callback. The provider must
 * protect its time and revision across process restarts and machine restores:
 * the last-seen values here detect rollback only during this anchor's lifetime.
 * A frozen provider cannot be distinguished from time that has not advanced.
 */
import { decimal, identifier } from '../fabric/encoding.ts';
import { domainDigest, type Digest } from '../fabric/identity.ts';

const state = new WeakMap<object, {
  readonly nowMs: () => number;
  readonly revision: () => string;
  lastMs: number | null;
  lastRevision: bigint | null;
}>();

export interface TrustedClockAnchor {
  readonly format: 'aether.trusted-clock-anchor/1';
  readonly authorityId: string;
  readonly clockDomain: string;
  readonly clockDomainDigest: Digest;
  readonly digest: Digest;
}

export interface TrustedClockReading {
  readonly nowMs: number;
  readonly revision: string;
}

export function createTrustedClockAnchor(options: Readonly<{
  authorityId: string;
  clockDomain: string;
  nowMs: () => number;
  revision: () => string;
}>): TrustedClockAnchor {
  identifier(options.authorityId);
  identifier(options.clockDomain);
  if (typeof options.nowMs !== 'function' || typeof options.revision !== 'function') {
    throw new TypeError('independent clock and revision sources required');
  }
  // Capture callbacks once. Later mutation of the options object cannot swap
  // an already-provisioned anchor's authority.
  const callbacks = { nowMs: options.nowMs, revision: options.revision, lastMs: null, lastRevision: null };
  const format = 'aether.trusted-clock-anchor/1' as const;
  const clockDomainDigest = domainDigest('aether.clock-domain/1', {
    authorityId: options.authorityId, clockDomain: options.clockDomain,
  });
  const anchor = Object.freeze({ format, authorityId: options.authorityId,
    clockDomain: options.clockDomain, clockDomainDigest,
    digest: domainDigest(format, { format, authorityId: options.authorityId,
      clockDomain: options.clockDomain, clockDomainDigest }) });
  state.set(anchor, callbacks);
  readTrustedClock(anchor);
  return anchor;
}

export function assertTrustedClockAnchor(value: unknown): asserts value is TrustedClockAnchor {
  if (value === null || typeof value !== 'object' || !state.has(value)) {
    throw new TypeError('independently provisioned trusted clock anchor required');
  }
}

/** Reads both independent callbacks synchronously and rejects local rollback. */
export function readTrustedClock(anchor: TrustedClockAnchor): TrustedClockReading {
  assertTrustedClockAnchor(anchor);
  const source = state.get(anchor)!;
  const nowMs = source.nowMs();
  const revision = source.revision();
  if (!Number.isSafeInteger(nowMs) || nowMs < 0 || Object.is(nowMs, -0)) {
    throw new TypeError('invalid trusted clock time');
  }
  decimal(revision);
  const sequence = BigInt(revision);
  if (source.lastMs !== null && nowMs < source.lastMs) throw new Error('trusted clock time rolled back');
  if (source.lastRevision !== null && sequence < source.lastRevision) throw new Error('trusted clock revision rolled back');
  source.lastMs = nowMs;
  source.lastRevision = sequence;
  return Object.freeze({ nowMs, revision });
}

/** Capability grants are live on [issuedAt, expiresAt), in this clock's ms domain. */
export function assertGrantLifetime(anchor: TrustedClockAnchor, issuedAt: number, expiresAt: number): void {
  if (!Number.isSafeInteger(issuedAt) || issuedAt < 0 || !Number.isSafeInteger(expiresAt)
      || expiresAt <= issuedAt) throw new TypeError('invalid trusted grant lifetime');
  const { nowMs } = readTrustedClock(anchor);
  if (nowMs < issuedAt || nowMs >= expiresAt) throw new Error('capability grant outside trusted lifetime');
}

/** Broker rejects only after its signed decimal deadline, in the same ms domain. */
export function assertBeforeDeadline(anchor: TrustedClockAnchor, deadline: string, clockDomain: string): void {
  assertTrustedClockAnchor(anchor);
  identifier(clockDomain);
  if (clockDomain !== anchor.clockDomain) throw new Error('trusted clock domain mismatch');
  decimal(deadline);
  if (BigInt(deadline) > BigInt(Number.MAX_SAFE_INTEGER)) throw new TypeError('trusted deadline exceeds safe ms range');
  const { nowMs } = readTrustedClock(anchor);
  if (BigInt(nowMs) > BigInt(deadline)) throw new Error('trusted broker deadline exceeded');
}
