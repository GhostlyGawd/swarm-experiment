# Durable AST persistence verification

`V4-T1-01` passes its two correctness gates for specification `0.1.0` at `3dfabcae63d42ff9382570d576fa6cedb7131b17`.

The clean detached checkout passed **395 tests**, including 38 durable-store cases, plus build, typechecking and both roadmap checks. Logs and source identity are recorded in `manifest.json`.

## G1: representation, reopen and import

The new explicit storage profile preserves v1 BLAKE3 grouped-child identities and legacy APIs. Tests cover deduplication, grouped child semantics, immutable object hash validation, reopen, archive version/closure checks, bigint/tag separation, malformed/corrupt objects, bounded hydration expansion and copying legacy graphs without changing their hashes. Invalid imports cannot publish a protected root.

Initialization now has a durable, profile-bound intent followed by a completion receipt. Eight actual fresh-constructor termination points recover without resetting established state. Missing established metadata, corrupt markers/receipts, replayed initialization markers and nonempty interrupted root records are rejected. Valid earlier v1 store metadata can adopt the auxiliary completion receipt without changing its root/object bytes.

## G2: root publication and protected collection

Three independent writer processes racing collection retain all 18 published roots. Compare-and-swap checks the expected named head and generation. Object publication precedes root publication, with immutable files, atomic replacement and directory synchronization. Six actual termination points around object/root publication and collection recover with protected objects intact.

Collection includes committed history, active leases and both source/candidate roots of pending promotions. Leases never expire by elapsed time. Independent review reproduced an ID reuse bug where a delayed old abort removed a newer candidate's protection. Durable terminal promotion receipts and retired lease IDs now reject that reuse; regressions cover repeated terminal actions and delayed retries.

## Limits

This is the bounded same-host reference store. Default limits are 100,000 nodes/tickets, 10,000 root/retired identities, 1 MiB object/root records and 64 MiB archives, with bounded hydration. The tests do not establish the later 100M-node or distributed performance targets. Process termination is exercised; physical power removal is not. Retained history requires coordinated maintenance before its declared capacity is exhausted.

The complete suite also rechecks the baseline process, promotion, effect, replication, identity and local state-preservation implementations. No benchmark threshold changes or full-v4 completion claim accompany this task closure.
