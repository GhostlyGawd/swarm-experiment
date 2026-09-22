/**
 * The symbol table (FR-1.1).
 *
 * Identifier spellings live here and nowhere else. This is what makes the
 * PRD's rename requirement hold structurally rather than by convention: there
 * is no other place in the graph for a name to hide, so a rename *cannot*
 * invalidate a downstream hash even if an agent tries.
 */

import { freshSymbolId, type SymbolId } from './ids.ts';
import { rng, type Rng } from '../util/rng.ts';
import type { Term } from './ast.ts';

export class SymbolSpace {
  private readonly names = new Map<SymbolId, string>();
  private readonly random: Rng;

  constructor(seed: number | string = 'aether') {
    this.random = rng(seed);
  }

  /** Mint a new binding. The name is metadata; the id is the identity. */
  define(name: string): SymbolId {
    let id = freshSymbolId(() => this.random.next());
    while (this.names.has(id)) id = freshSymbolId(() => this.random.next());
    this.names.set(id, name);
    return id;
  }

  /**
   * Rename a binding. Touches this table only — every AST node that refers to
   * the symbol keeps its content address.
   */
  rename(symbol: SymbolId, name: string): void {
    if (!this.names.has(symbol)) throw new ReferenceError(`unknown symbol ${symbol}`);
    this.names.set(symbol, name);
  }

  nameOf(symbol: SymbolId): string {
    return this.names.get(symbol) ?? symbol;
  }

  lookup(name: string): SymbolId | undefined {
    for (const [id, n] of this.names) if (n === name) return id;
    return undefined;
  }

  /** Materialize the table as an AST node, sorted for a stable address. */
  table(): Term {
    const entries = [...this.names.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
    return { kind: 'SymbolTable', entries };
  }

  get size(): number {
    return this.names.size;
  }
}
