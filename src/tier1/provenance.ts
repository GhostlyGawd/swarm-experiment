/**
 * Causal lineage and intent provenance (FR-1.3).
 *
 * Every node carries a pointer back to the reason it exists. This is the
 * mechanism behind three otherwise-unrelated requirements:
 *
 *   • the Auditor persona's causal inspection ("why is this line here?"),
 *   • spec invalidation (editing a requirement must find its descendants),
 *   • Chesterton's Fence (an agent must not remove a guard it cannot explain).
 *
 * Provenance records are themselves content-addressed and immutable, so the
 * audit trail cannot be rewritten after the fact — only appended to.
 */

import { blake3 } from './blake3.ts';
import { canonicalBytes, type Canonical } from './canonical.ts';
import { bytesToHexRef, PROVENANCE_PREFIX, type InvariantId, type NodeRef, type ProvenanceId } from './ids.ts';
import type { GraphStore } from './store.ts';

export type OriginKind =
  | 'human_prompt'
  | 'agent_session'
  | 'issue'
  | 'spec_clause'
  | 'synthesis_repair'
  | 'tuning_agent'
  | 'topology_slicer'
  | 'import';

export interface Origin {
  readonly kind: OriginKind;
  /** Session id, issue key, spec clause id — whatever identifies the source. */
  readonly ref: string;
  readonly actor?: string;
}

/** How strongly a subtree is protected from unexplained modification. */
export type GuardPriority = 'advisory' | 'required' | 'architectural';

export interface Guard {
  readonly invariant: InvariantId;
  readonly priority: GuardPriority;
  /** Why the fence is here. The thing an agent must actually engage with. */
  readonly rationale: string;
}

export interface ProvenanceInput {
  readonly intent: string;
  readonly origin: Origin;
  readonly parents?: readonly ProvenanceId[];
  /** Specification clauses this node was derived from. */
  readonly specClauses?: readonly InvariantId[];
  /** Summary of the agent's reasoning, surfaced on hover in the IDE. */
  readonly reasoning?: readonly string[];
  readonly guard?: Guard;
  readonly timestamp?: number;
}

export interface ProvenanceRecord {
  readonly id: ProvenanceId;
  readonly intent: string;
  readonly origin: Origin;
  readonly parents: readonly ProvenanceId[];
  readonly specClauses: readonly InvariantId[];
  readonly reasoning: readonly string[];
  readonly guard: Guard | null;
  readonly timestamp: number;
}

/**
 * Evidence that an invariant actually holds, minted by the Tier-2 verifier.
 * The fence cannot be opened with prose — only with one of these.
 */
export interface DischargeProof {
  readonly invariant: InvariantId;
  readonly verdict: 'proved' | 'property_checked';
  readonly evidence: string;
  /** The node the proof was computed against. */
  readonly subject: NodeRef;
}

export type FenceVerdict =
  | { readonly allowed: true; readonly discharged: readonly InvariantId[] }
  | {
      readonly allowed: false;
      readonly blockedBy: Guard;
      readonly explanation: string;
      readonly lineage: readonly ProvenanceRecord[];
    };

export interface InvalidationFlag {
  readonly reason: 'InvalidatedSpec';
  readonly clause: InvariantId;
  readonly detectedAt: number;
  /** Nodes between the changed clause and this one. */
  readonly via: readonly ProvenanceId[];
}

export interface InvalidationReport {
  readonly clause: InvariantId;
  readonly directNodes: readonly NodeRef[];
  /** Direct nodes plus every ancestor in the graph that contains one. */
  readonly affectedNodes: readonly NodeRef[];
  readonly reconciliationQueue: readonly NodeRef[];
}

export class ProvenanceLedger {
  private readonly records = new Map<ProvenanceId, ProvenanceRecord>();
  private readonly nodeToProv = new Map<NodeRef, ProvenanceId>();
  private readonly provToNodes = new Map<ProvenanceId, Set<NodeRef>>();
  private readonly clauseToProv = new Map<InvariantId, Set<ProvenanceId>>();
  private readonly flags = new Map<NodeRef, InvalidationFlag>();
  private clock: () => number;

  /** Injectable clock so provenance ids are reproducible in tests and replays. */
  constructor(clock: () => number = () => Date.now()) {
    this.clock = clock;
  }

  record(input: ProvenanceInput): ProvenanceId {
    const rec: Omit<ProvenanceRecord, 'id'> = {
      intent: input.intent,
      origin: input.origin,
      parents: [...(input.parents ?? [])].sort(),
      specClauses: [...(input.specClauses ?? [])].sort(),
      reasoning: input.reasoning ?? [],
      guard: input.guard ?? null,
      timestamp: input.timestamp ?? this.clock(),
    };
    const id = bytesToHexRef(
      blake3(canonicalBytes(rec as unknown as Canonical)),
      PROVENANCE_PREFIX,
    ) as string as ProvenanceId;
    if (!this.records.has(id)) {
      this.records.set(id, { ...rec, id });
      for (const clause of rec.specClauses) {
        let set = this.clauseToProv.get(clause);
        if (!set) this.clauseToProv.set(clause, (set = new Set()));
        set.add(id);
      }
    }
    return id;
  }

  get(id: ProvenanceId): ProvenanceRecord {
    const rec = this.records.get(id);
    if (!rec) throw new ReferenceError(`unknown provenance ${id}`);
    return rec;
  }

  has(id: ProvenanceId): boolean {
    return this.records.has(id);
  }

  /** Attach a provenance record to a node address. */
  bind(ref: NodeRef, provenance: ProvenanceId): void {
    this.get(provenance);
    this.nodeToProv.set(ref, provenance);
    let set = this.provToNodes.get(provenance);
    if (!set) this.provToNodes.set(provenance, (set = new Set()));
    set.add(ref);
  }

  provenanceOf(ref: NodeRef): ProvenanceId | undefined {
    return this.nodeToProv.get(ref);
  }

  /** Full causal ancestry, nearest first, each record visited once. */
  lineage(id: ProvenanceId): readonly ProvenanceRecord[] {
    const out: ProvenanceRecord[] = [];
    const seen = new Set<ProvenanceId>();
    const queue: ProvenanceId[] = [id];
    while (queue.length) {
      const next = queue.shift()!;
      if (seen.has(next)) continue;
      seen.add(next);
      const rec = this.records.get(next);
      if (!rec) continue;
      out.push(rec);
      queue.push(...rec.parents);
    }
    return out;
  }

  /** The causal lineage of a node, rendered for a human auditor. */
  explain(ref: NodeRef): string {
    const prov = this.nodeToProv.get(ref);
    if (!prov) return `${ref}\n  (no recorded provenance)`;
    const lines = [`${ref}`];
    const chain = this.lineage(prov);
    chain.forEach((rec, depth) => {
      const indent = '  '.repeat(depth + 1);
      lines.push(`${indent}← ${rec.intent}`);
      lines.push(`${indent}  origin: ${rec.origin.kind} ${rec.origin.ref}` +
        (rec.origin.actor ? ` (${rec.origin.actor})` : ''));
      if (rec.specClauses.length) {
        lines.push(`${indent}  satisfies: ${rec.specClauses.join(', ')}`);
      }
      if (rec.guard) {
        lines.push(`${indent}  ⚠ guarded [${rec.guard.priority}]: ${rec.guard.rationale}`);
      }
      for (const step of rec.reasoning) lines.push(`${indent}  · ${step}`);
    });
    const flag = this.flags.get(ref);
    if (flag) lines.push(`  ⛔ InvalidatedSpec: ${flag.clause}`);
    return lines.join('\n');
  }

  /**
   * Mark every subtree derived from a changed specification clause.
   *
   * Propagation runs *upwards* through the graph as well: if a leaf expression
   * is invalidated, the function containing it has to be reconciled too, since
   * its contract may no longer be satisfiable by the body it has.
   */
  invalidateSpecClause(clause: InvariantId, store: GraphStore): InvalidationReport {
    const provs = this.clauseToProv.get(clause) ?? new Set<ProvenanceId>();
    // Also pick up records that inherit the clause through their parents.
    const derived = new Set<ProvenanceId>(provs);
    let grew = true;
    while (grew) {
      grew = false;
      for (const rec of this.records.values()) {
        if (derived.has(rec.id)) continue;
        if (rec.parents.some((p) => derived.has(p))) {
          derived.add(rec.id);
          grew = true;
        }
      }
    }

    const direct = new Set<NodeRef>();
    for (const p of derived) {
      for (const ref of this.provToNodes.get(p) ?? []) direct.add(ref);
    }

    const affected = new Set<NodeRef>();
    const queue = [...direct];
    const via = [...derived];
    while (queue.length) {
      const ref = queue.pop()!;
      if (affected.has(ref)) continue;
      affected.add(ref);
      this.flags.set(ref, { reason: 'InvalidatedSpec', clause, detectedAt: this.clock(), via });
      for (const parent of store.parentsOf(ref)) queue.push(parent);
    }

    // Agents reconcile whole functions, not arbitrary expressions.
    const queueRefs = [...affected].filter((ref) => {
      const kind = store.has(ref) ? store.get(ref).kind : null;
      return kind === 'FunctionDecl' || kind === 'Module';
    });

    return {
      clause,
      directNodes: [...direct],
      affectedNodes: [...affected],
      reconciliationQueue: queueRefs.length ? queueRefs : [...direct],
    };
  }

  flagFor(ref: NodeRef): InvalidationFlag | undefined {
    return this.flags.get(ref);
  }

  isInvalidated(ref: NodeRef): boolean {
    return this.flags.has(ref);
  }

  /** Clear the flag once an agent has reconciled the node. */
  reconcile(ref: NodeRef): void {
    this.flags.delete(ref);
  }

  /**
   * Chesterton's Fence (FR-1.3).
   *
   * An agent may not delete or rewrite a guarded subtree merely because it
   * cannot see why the guard is there. It must present a `DischargeProof` for
   * the guarding invariant — evidence from the verifier that the requirement
   * still holds after the change. Prose justifications are not accepted,
   * because an agent can always produce prose.
   */
  guardMutation(ref: NodeRef, proofs: readonly DischargeProof[] = []): FenceVerdict {
    const prov = this.nodeToProv.get(ref);
    if (!prov) return { allowed: true, discharged: [] };

    const lineage = this.lineage(prov);
    const guards = lineage
      .map((r) => r.guard)
      .filter((g): g is Guard => g !== null && g.priority !== 'advisory');

    const discharged: InvariantId[] = [];
    for (const guard of guards) {
      const proof = proofs.find(
        (p) =>
          p.invariant === guard.invariant &&
          (guard.priority === 'architectural' ? p.verdict === 'proved' : true),
      );
      if (!proof) {
        return {
          allowed: false,
          blockedBy: guard,
          explanation:
            `Node ${ref} is protected by ${guard.priority} invariant ${guard.invariant}: ` +
            `${guard.rationale}\n` +
            `To modify it, supply a DischargeProof showing the invariant still holds` +
            (guard.priority === 'architectural' ? ' (verdict must be "proved", not fuzzed).' : '.'),
          lineage,
        };
      }
      discharged.push(guard.invariant);
    }
    return { allowed: true, discharged };
  }

  get size(): number {
    return this.records.size;
  }
}
