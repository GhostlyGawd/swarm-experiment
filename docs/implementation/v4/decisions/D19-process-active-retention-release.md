# D19 — Witnessed active-task pin release candidate

Status: bounded G2 implementation slice. V4-T1-05/G2 remains open.

The first releasable lifecycle is a ProcessHost checkpoint that has a durable
`committed` lease, exact checkpoint receipt, resolved effect audit, and state
head in an operator-held host journal witness. `ProcessCheckpointActiveReleaseAuthority`
rechecks all of these, the retained completed checkpoint, and the original
process semantic-retention marker. It produces a versioned proof bound to one
host configuration, manifest, program, operation, receipt, and complete AST
root set. A caller-provided completion flag or receipt alone is insufficient.

`SemanticGarbageCollector` preserves every V1 retention record as immutable
history. An append-only `/2` release record names the complete active-task
record set and an equal replay record set. Its current liveness view excludes
only the released active-task records; replay records and physical replay
leases remain mandatory. A release is journaled before active-task leases are
retired. If the process dies at that boundary, reopening under the same
release authority finishes lease retirement. A missing witness, altered
receipt, missing replay lease, or missing authority blocks reopen/collection.
The AST store permanently retires those lease identities.

The verifier currently exposes an explicit release API; ProcessHost does not
yet invoke it under its host journal lock. Existing ProcessHost reopen checks
also still require both V1 pin kinds and will reject a released active-task
pin. The next integration must call release after the witnessed terminal host
decision and reconcile it on reopen, then make retention assertions require
active-task pins for active leases and replay pins for all historical leases.
The host must use the same independently supplied witness object as the
release authority. The release proof can be rechecked at a later witness
revision because a committed checkpoint remains in the append-only host
history. Old V1 markers and all other retention kinds remain monotone.

This slice does not establish full audit expiration, replay deletion,
unstable-replication release, or actual AST object reclamation. A signed
lineage artifact or replay pin may still protect the same object after the
active-task lease is retired. The focused test mirrors a real committed
ProcessHost journal into a branded operator witness to exercise the verifier;
an end-to-end test with ProcessHost's own V4/V13 witness and crash boundaries
is required before this is a production release profile.
