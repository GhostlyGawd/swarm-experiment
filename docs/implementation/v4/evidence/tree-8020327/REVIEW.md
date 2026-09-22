# Durable Tree-CRDT verification

`V4-T1-06` passes its two gates at source `8020327` (full commit in `manifest.json`), specification `0.1.0`.

The clean detached checkout passed **477 tests**, build, typechecking and both roadmap checks. This includes 15 tree-workspace, two fractional-position, 12 replication and 39 durable-store tests. Command logs are retained.

## G1: convergent candidate editing

Real durable replica journals authenticate operation identities and recompute the complete eligible set. Projection uses the D04 numeric Lamport/bytewise-ID order, exact fractional positions, independent occurrences, cycle suppression and separate content replacement. Tests cover overlapping partitioned edits, reordered/duplicated delivery, missing predecessors, late equivocation, shared immutable content and grouped AST fields.

Materialization reconstructs actual CAS nodes using grouped child roles, without falling back to stale prototype children. A valid composed root executes in the runtime. Structural and semantic failures remain candidates; the workspace never commits production heads. Structural or unresolved replication diagnostics yield a null top-level root and only explicitly diagnostic partial occurrence addresses.

## G2: stable epochs and nonresurrection

Every enrolled member durably fences authoring and signs its observed inventory. Proposals bind the exact signed union, independently classified cut, deterministic projection/reindex map, complete AST archive, next epoch and clock floor. All members must acknowledge the same digest. New proposals refuse locally known extra old-epoch frames; existing certified cuts remain immutable despite later arrivals.

Actual child-process termination covers durable fencing, checkpoint preparation, epoch commit and collection. Restart follows the authoritative certified epoch and idempotently completes cleanup. Tests repeat checkpoint epochs, collect live trash, preserve audit archives, reject obsolete operations and verify new insertion identity. The readonly archive validator checks canonical content, hashes and complete closure without writing objects, roots or leases.

Independent review reproduced an honest-partition capacity wedge: individually legal edits could merge beyond the local projection limit and block every repair operation. The fix retains all signed frames/content, deterministically diagnoses capacity exclusions and keeps inspection/deletion/checkpoint maintenance available. Incomplete overflow cannot expose a normal candidate root, even if its partial AST is well typed. The regression proceeds through merge, deletion, unanimously certified repair and a fresh insertion; suppressed old-epoch identities cannot resurrect afterward. No configured bound was increased.

## Limits

This is bounded same-host candidate replication with a unanimous enrolled-member stabilization protocol. It does not implement the separate heterogeneous Byzantine promotion quorum, automatic member retirement, 1,000-agent convergence SLA or 100M-node storage qualification. Missing members prevent collection; retained immutable journals/prototypes remain audit data. Production still requires its independent proof, signed lineage and governor admission.

Reproduce the commands in `manifest.json` at its exact subject. The full suite rechecks earlier baseline, signed-lineage and portable-certificate gates.
