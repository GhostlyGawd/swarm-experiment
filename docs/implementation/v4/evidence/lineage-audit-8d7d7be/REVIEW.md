# Signed lineage audit lease integration at `8d7d7be`

Specification v4 `0.1.0`; exact tested source commit `8d7d7be6524644876b89fab3bec9a5ea6634c494`. The source worktree was clean before the test campaign. The [focused log](focused.log) records **33/33** lineage and adjacent semantic-GC tests passing, including a new regression that removes each signed spec, intent or artifact AST lease while other leases keep the bytes available. Both current admission and a fresh lineage reopen refuse the missing role pin before any collection. The adjacent tests cover real lineage `SIGKILL` boundaries, signed promotion, sink retirement and local virtual rewrite admission.

[Typecheck](typecheck.log), [build](build.log), and [v4 roadmap check](roadmap.log) pass. The build measured a 753,759-byte JS worker bundle from 68 inputs with 25 transitive non-system native libraries; these are build facts, not a release boot or memory measurement. [Hashes](hashes.sha256) bind the raw logs.

This campaign checks a bounded lineage audit invariant. It does not prove safe audit release, all active/replay/replication lifecycle producers, an admitted effectful virtual rewrite, or either complete T1-05 gate. No tracker status changes; **20/62** remains verified.
