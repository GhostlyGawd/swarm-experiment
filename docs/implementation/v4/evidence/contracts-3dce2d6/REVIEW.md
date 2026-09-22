# Effects, replication and proof-admission verification

Subject commit: `3dce2d61686129cff45a76d256d3e2681c897fcc`. Specification: `0.1.0`.

A clean detached checkout passed **299 tests**, typechecking and both roadmap checks. The retained logs are from that exact checkout; no in-progress native/ZK/learning prototypes were included. Earlier foundation regressions also passed in this run.

## V4-F04

- G1: recorded replay never invokes live adapters or current live authorization; ordering, duplicate IDs, missing results and unused events are checked. Shadow/speculative modes buffer isolated intents or consume recorded results without live writes. Runtime forks require explicitly isolated authority.
- G2: exact repeated requests reopen durable receipts without executing sinks again. Changed payload, manifest, grant, epoch, deadline, reservation or adapter is rejected. Real concurrent broker processes do not overlap sink execution.
- G3: a real child process is killed after fsync of its sink write. Recovery retains indeterminate disposition, releases only its dead-owner ticket and queries the sink using the same operation identity; it does not redispatch. Receipt persistence failures, cancellation, revocation, budget handling, abandoned prepare and recovery crashes are tested. Both runtimes and host dispatch preserve recovery IDs; unknown commit is not labeled false/true or retryable.

Independent review found malformed replay acceptance, contradictory recovery markers and orphanable lock/recovery files. These were repaired before the checkpoint. The shared journal mutex uses immutable fully published tickets, exact-owner release records and process-death checks; recovery itself can be retried after a crash.

Limits: synchronous bounded filesystem backend, explicit sink adapter semantics and trusted authorization/budget callbacks. PID reuse fails closed. Retained tickets require coordinated maintenance at capacity. Buffered isolated intents do not fabricate program return values. Full economic typing, arbitrary isolated result providers, distributed effect transactions and shadow promotion remain separate tasks.

## V4-F05

- G1: signed canonical mutation envelopes validate repository/membership, key identity, sequence, payload and causal context. Exact duplicates are idempotent; signed ID equivocation quarantines both variants and their causal descendants independently of delivery order.
- G2: missing predecessors remain pending and can be fetched. Forged/malformed frames cannot enter the journal. Actual process exits after author publication/receiver persistence recover complete operations and preserve sequence allocation. Concurrent authors produce distinct sequence numbers.
- G3: the API writes candidate journals only and exposes no production-root mutation operation. The fault harness reports expected/missing replicas and simulates explicit delivery assumptions. A second review found quota oversubscription races; concurrent ingest/byte-quota/author-ingest tests now establish one admission and a readable reopened journal at the configured limit.

Local resource admission is serialized through the shared ticket mutex. This does not claim lock-free storage or distributed Tree-CRDT completion. The full occurrence projection, membership consensus and 1,000-agent measurements remain open. The R01 model in this checkpoint selected an ordering mechanism that still needs correction to preserve the PRD's explicit fractional-indexing requirement; **R01 is not verified by this checkpoint**.

## V4-F06

- G1: current code/specification/dependency/semantics/compiler/ABI/target/capability-policy/evidence-policy identities are recomputed and compared. Transitive external declaration content is resolved and pinned. Every changed identity tested invalidates the prior evidence.
- G2: type/capability checks and closed obligation enumeration precede admission. Missing/duplicate/truncated obligations, undeclared assumptions, absent frame contracts, false caller preconditions and actual solver budget exhaustion are rejected. A concrete nested-alias counterexample shows the old verifier producing a false proof; the new admission layer rejects the unsupported model before it can authorize elision.
- G3: property classification cannot satisfy a formal-required gate. Trusted local reports have unforgeable in-process provenance; structural/JSON copies are untrusted and reverified. Compilation validates the vetted object/report set and expected manifest, rejects unconditional elision and mixed legacy evidence, and retains all external entry preconditions and property clauses. Actual flat-record ledger transitions and formal loop obligations are exercised.

The existing local solver remains in the trusted computing base. Unsupported models are explicit rejection outcomes, not proofs. Portable certificates and a small independent kernel remain T2-10. The host must derive expected compiler/target/policy identity from its own current configuration; repeating an untrusted sender's asserted context is not authentication.

This verifies the three foundation contracts within their specified scope. It does not close full v4 release or assurance gates.
