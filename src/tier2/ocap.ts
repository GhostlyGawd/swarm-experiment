/**
 * Object-capability model (FR-2.3).
 *
 * A function in Aether has zero ambient authority. There is no global `fs`, no
 * process environment, no clock reachable from an expression. The only way to
 * touch anything outside the heap is an `Invoke` node naming a capability, and
 * an `Invoke` only type-checks if the enclosing function declares that
 * capability — which in turn only holds if every caller passes it down.
 *
 * The consequence worth stating plainly: a hallucinated `rm -rf` is not
 * *caught* at runtime, it fails to compile, because the agent has no name it
 * could write that would reach a filesystem it was not handed.
 */

import type { CapabilityName } from '../tier1/ids.ts';
import { capability, capability as capabilityName } from '../tier1/ids.ts';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWrite, encodeStored, readStored } from '../tier1/persistence.ts';
import { exactObject, identifier } from '../fabric/encoding.ts';

/** What a capability lets its holder do, and to what. */
export interface CapabilityDescriptor {
  readonly name: CapabilityName;
  readonly domain: string;
  readonly operation: string;
  /** Arity and a human description, used by the micro-world simulators. */
  readonly arity: number;
  readonly description: string;
  /** Does invoking this change the world? Pure capabilities may be replayed. */
  readonly effectful: boolean;
}

/** The capability every sandboxed third-party subtree gets, and nothing else. */
export const PURE_COMPUTE = capability('cap:pure:compute');

export class CapabilityRegistry {
  private readonly descriptors = new Map<CapabilityName, CapabilityDescriptor>();

  constructor() {
    this.define({
      name: PURE_COMPUTE,
      domain: 'pure',
      operation: 'compute',
      arity: 0,
      description: 'Arithmetic and allocation only. Grants no authority at all.',
      effectful: false,
    });
  }

  define(descriptor: CapabilityDescriptor): CapabilityDescriptor {
    this.descriptors.set(descriptor.name, descriptor);
    return descriptor;
  }

  /** Convenience: register `cap:<domain>:<operation>`. */
  declare(
    name: string,
    spec: { arity: number; description: string; effectful?: boolean },
  ): CapabilityDescriptor {
    const cap = capability(name);
    const [, domain, operation] = cap.split(':');
    return this.define({
      name: cap,
      domain,
      operation,
      arity: spec.arity,
      description: spec.description,
      effectful: spec.effectful ?? true,
    });
  }

  get(name: CapabilityName): CapabilityDescriptor | undefined {
    return this.descriptors.get(name);
  }

  get names(): readonly CapabilityName[] {
    return [...this.descriptors.keys()];
  }
}

/**
 * The set of capabilities in scope at a point in the call graph.
 *
 * Envelopes only ever narrow. There is no operation that adds authority to an
 * envelope, which is what makes "can this subtree reach the network?" a
 * question answerable by reading the envelope rather than the whole program.
 */
export class CapabilityEnvelope {
  private readonly granted: ReadonlySet<CapabilityName>;

  private constructor(granted: Iterable<CapabilityName>) {
    this.granted = new Set(granted);
  }

  static of(...caps: CapabilityName[]): CapabilityEnvelope {
    return new CapabilityEnvelope(caps);
  }

  /** The envelope given to adopted third-party code (FR-2.3, sandboxing). */
  static sandboxed(): CapabilityEnvelope {
    return new CapabilityEnvelope([PURE_COMPUTE]);
  }

  static empty(): CapabilityEnvelope {
    return new CapabilityEnvelope([]);
  }

  has(cap: CapabilityName): boolean {
    return this.granted.has(cap);
  }

  /** Narrow to a subset. Capabilities not already held are silently dropped. */
  attenuate(caps: Iterable<CapabilityName>): CapabilityEnvelope {
    return new CapabilityEnvelope([...caps].filter((c) => this.granted.has(c)));
  }

  /** Remove a capability. Used by emergency revocation (§5). */
  without(...caps: CapabilityName[]): CapabilityEnvelope {
    const drop = new Set(caps);
    return new CapabilityEnvelope([...this.granted].filter((c) => !drop.has(c)));
  }

  get list(): readonly CapabilityName[] {
    return [...this.granted].sort();
  }

  toString(): string {
    return this.list.length ? this.list.join(', ') : '(none)';
  }
}

/**
 * Global revocation (§5, Emergency Capability Revocation).
 *
 * Held by the human operator, checked on every invoke at runtime and consulted
 * by the compiler. Revocation takes effect without rebuilding or redeploying,
 * because it is a predicate the runtime evaluates rather than a property baked
 * into an artifact.
 */
export class RevocationList {
  private readonly globally = new Set<CapabilityName>();
  private readonly scoped = new Map<string, Set<CapabilityName>>();
  private readonly log: Array<{ at: number; cap: CapabilityName; scope: string | null; by: string; action: 'revoke' | 'restore' }> = [];
  private readonly clock: () => number;
  private readonly path: string | null;

  constructor(clockOrOptions: (() => number) | { clock?: () => number; directory?: string } = () => Date.now()) {
    const opts = typeof clockOrOptions === 'function' ? { clock: clockOrOptions } : clockOrOptions;
    this.clock = opts.clock ?? (() => Date.now());
    this.path = opts.directory ? join(opts.directory, 'revocations.json') : null;
    if (this.path) {
      mkdirSync(opts.directory!, { recursive: true });
      if (existsSync(this.path)) {
        const saved = readStored<{
          globally: CapabilityName[];
          scoped: Array<[string, CapabilityName[]]>;
          log: Array<{ at: number; cap: CapabilityName; scope: string | null; by: string; action: 'revoke' | 'restore' }>;
        }>(this.path);
        for (const cap of saved.globally) this.globally.add(cap);
        for (const [scope, caps] of saved.scoped) this.scoped.set(scope, new Set(caps));
        this.log.push(...saved.log);
      }
    }
  }

  private persist(): void {
    if (!this.path) return;
    atomicWrite(this.path, encodeStored({
      globally: [...this.globally],
      scoped: [...this.scoped].map(([scope, caps]) => [scope, [...caps]]),
      log: this.log,
    }));
  }

  /** Revoke `cap` everywhere, or only within the named module. */
  revoke(cap: CapabilityName, opts: { scope?: string; by: string }): void {
    if (opts.scope) {
      let set = this.scoped.get(opts.scope);
      if (!set) this.scoped.set(opts.scope, (set = new Set()));
      set.add(cap);
    } else {
      this.globally.add(cap);
    }
    this.log.push({ at: this.clock(), cap, scope: opts.scope ?? null, by: opts.by, action: 'revoke' });
    this.persist();
  }

  restore(cap: CapabilityName, scope?: string): void {
    if (scope) this.scoped.get(scope)?.delete(cap);
    else this.globally.delete(cap);
    this.log.push({ at: this.clock(), cap, scope: scope ?? null, by: 'operator', action: 'restore' });
    this.persist();
  }

  isRevoked(cap: CapabilityName, scope?: string): boolean {
    if (this.globally.has(cap)) return true;
    return scope ? (this.scoped.get(scope)?.has(cap) ?? false) : false;
  }

  /** The audit trail an operator is asked for after an incident. */
  get history(): ReadonlyArray<{ at: number; cap: CapabilityName; scope: string | null; by: string; action: 'revoke' | 'restore' }> {
    return this.log;
  }
}

export class RevocationConsole {
  private readonly list: RevocationList;
  constructor(list: RevocationList) { this.list = list; }
  revoke(capability: CapabilityName, by: string, scope?: string): void {
    this.list.revoke(capability, { by, scope });
  }
  restore(capability: CapabilityName, scope?: string): void { this.list.restore(capability, scope); }
  status(capability: CapabilityName, scope?: string): boolean { return this.list.isRevoked(capability, scope); }
  history(): RevocationList['history'] { return this.list.history; }
}

export interface CapabilityToken {
  readonly capability: CapabilityName;
  readonly scope: string;
  readonly expiresAt: number;
  readonly nonce: string;
  readonly signature: string;
}

/** HMAC-sealed wire tokens: attenuable data whose authority cannot be forged. */
export class CapabilitySealer {
  private readonly key: Uint8Array;
  private readonly clock: () => number;

  constructor(key: Uint8Array = randomBytes(32), clock: () => number = () => Date.now()) {
    if (key.byteLength < 32) throw new RangeError('capability sealing keys must be at least 32 bytes');
    this.key = Buffer.from(key);
    this.clock = clock;
  }

  private now(): number {
    const value = this.clock();
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('invalid capability clock');
    return value;
  }

  private mac(token: Omit<CapabilityToken, 'signature'>): string {
    return createHmac('sha256', this.key)
      .update(`${token.capability}\0${token.scope}\0${token.expiresAt}\0${token.nonce}`)
      .digest('hex');
  }

  /** Stable public commitment to the sealing key, without exposing key bytes
   * or freezing the operator's live clock/revocation policy. */
  keyCommitment(): string {
    return createHmac('sha256', this.key)
      .update('aether.capability-sealer-key-commitment/1')
      .digest('hex');
  }

  issue(capability: CapabilityName, scope: string, ttlMs = 60_000): CapabilityToken {
    capability = capabilityName(capability); identifier(scope);
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1) throw new TypeError('invalid capability lifetime');
    const expiresAt = this.now() + ttlMs;
    if (!Number.isSafeInteger(expiresAt)) throw new RangeError('capability expiry overflow');
    const unsigned = {
      capability, scope, expiresAt,
      nonce: randomBytes(16).toString('hex'),
    };
    return { ...unsigned, signature: this.mac(unsigned) };
  }

  verify(token: CapabilityToken, scope?: string): boolean {
    try {
      const row = exactObject(token, ['capability', 'scope', 'expiresAt', 'nonce', 'signature']);
      const targetScope = scope ?? row.scope;
      capabilityName(row.capability as string); identifier(row.scope); identifier(targetScope);
      if (!Number.isSafeInteger(row.expiresAt) || (row.expiresAt as number) < 1 || typeof row.nonce !== 'string' || !/^[0-9a-f]{32}$/.test(row.nonce) || typeof row.signature !== 'string' || !/^[0-9a-f]{64}$/.test(row.signature)) return false;
      if (token.scope !== targetScope || token.expiresAt <= this.now()) return false;
      const expected = Buffer.from(this.mac(token), 'hex');
      const actual = Buffer.from(token.signature, 'hex');
      return expected.length === actual.length && timingSafeEqual(expected, actual);
    } catch { return false; }
  }

  /** Legacy opaque scopes cannot be ordered; subset only within the same scope.
   * Hierarchical resource attenuation uses ScopedGrantAuthority v2. */
  attenuate(tokens: readonly CapabilityToken[], capabilities: readonly CapabilityName[], scope: string): CapabilityToken[] {
    const allowed = new Set(capabilities);
    const valid = tokens.filter(token => this.verify(token));
    if (valid.some(token => token.scope !== scope)) throw new Error('legacy capability scope cannot be changed by attenuation');
    return valid.filter(token => allowed.has(token.capability))
      .map(token => this.issue(token.capability, scope, token.expiresAt - this.now()));
  }
}
