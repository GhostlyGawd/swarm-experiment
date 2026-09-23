/**
 * Mapping between Aether's namespaced type handles and the short identifiers a
 * human projection needs. `type:ledger:account` reads as `Account` on screen;
 * the full handle is preserved in an `@nominal` annotation so the parser can
 * recover it exactly.
 */

import type { TypeName } from '../tier1/ids.ts';

const pascal = (segment: string): string =>
  segment
    .split('_')
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join('');

export class TypeNames {
  private readonly toShort = new Map<TypeName, string>();
  private readonly toLong = new Map<string, TypeName>();

  /** Register a handle, returning the short identifier to display. */
  register(name: TypeName): string {
    const existing = this.toShort.get(name);
    if (existing) return existing;
    const [, ns, local] = name.split(':');
    let candidate = pascal(local);
    if (this.toLong.has(candidate)) candidate = pascal(ns) + candidate;
    let n = 2;
    while (this.toLong.has(candidate)) candidate = `${pascal(local)}${n++}`;
    this.toShort.set(name, candidate);
    this.toLong.set(candidate, name);
    return candidate;
  }

  short(name: TypeName): string {
    return this.toShort.get(name) ?? this.register(name);
  }

  long(short: string): TypeName | undefined {
    return this.toLong.get(short);
  }

  /** Teach the mapping a pairing recovered from an `@nominal` annotation. */
  bind(short: string, name: TypeName): void {
    this.toShort.set(name, short);
    this.toLong.set(short, name);
  }

  get entries(): ReadonlyArray<readonly [TypeName, string]> {
    return [...this.toShort.entries()];
  }
}
