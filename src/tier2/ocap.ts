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
import { capability } from '../tier1/ids.ts';

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
  private readonly log: Array<{ at: number; cap: CapabilityName; scope: string | null; by: string }> = [];
  private readonly clock: () => number;

  constructor(clock: () => number = () => Date.now()) {
    this.clock = clock;
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
    this.log.push({ at: this.clock(), cap, scope: opts.scope ?? null, by: opts.by });
  }

  restore(cap: CapabilityName, scope?: string): void {
    if (scope) this.scoped.get(scope)?.delete(cap);
    else this.globally.delete(cap);
  }

  isRevoked(cap: CapabilityName, scope?: string): boolean {
    if (this.globally.has(cap)) return true;
    return scope ? (this.scoped.get(scope)?.has(cap) ?? false) : false;
  }

  /** The audit trail an operator is asked for after an incident. */
  get history(): ReadonlyArray<{ at: number; cap: CapabilityName; scope: string | null; by: string }> {
    return this.log;
  }
}
