# Aether v4 execution status

Goal: implement the complete v4 specification, all 40 functional requirements and all NFR/governance/KPI gates. Full completion remains unproven.

Branch: `aether/v4-implementation`. Planning checkpoint: `9f23a7b`. First implementation checkpoint: `4a9b0776276251cf92ca647baa114c638a2559bf`.

## Current work

- **V4-F01 verified:** state-preserving local migration, authoritative call-boundary synchronization, allocator continuity, closure/task owner dispatch and map/fold callback movement. Eleven migration regressions and independent adversarial review support its three gates.
- **V4-F02 verified:** real token/corpus accounting, pinned tokenizer, benchmark manifests and separate measure/enforce commands. Actual ≥4× and unmeasured release targets remain failed/open. Measurement implementation is complete; performance success is not.
- **V4-F03 verified:** bounded canonical encoding, exact execution identities, dependency closure and sidecars with v1 compatibility checks. Public fabric exports are built and usable.
- **V4-F04 in progress:** delegated durable effect broker with actual sink-crash/reconciliation and replay/budget tests. Runtime bridge integration remains root work.
- **V4-F05 in progress:** delegated signed mutation envelopes, durable causal ingestion and fault-delivery harness. This is distinct from the full Tree-CRDT algorithm.
- **V4-F06 in progress:** delegated exact-subject evidence validation over the existing verifier. Unsupported/unsound model cases must be concretely identified; a blanket reduced language is not accepted as full delivery.

Exact-commit evidence is in [foundations-4a9b077](evidence/foundations-4a9b077/REVIEW.md). A detached verification checkout passed 242 tests, typechecking and both roadmap checks. Clean pinned-dependency benchmark measurement exited 0; release enforcement correctly exited 1 with 17 unsatisfied required rows.

## Decisions and findings

- Local movement uses a conservative full heap snapshot. It preserves address identity and commits only after compilation/import validation succeeds.
- Every call boundary must synchronize authoritative state, because repairing movement alone leaves stale-record reads and runtime allocator collisions.
- Local synchronous closures/tasks dispatch through their owning runtime with current authoritative state. Weak references track retained continuations and block unsafe replacement, including externally held callbacks. Migration/export rejects opaque state before publication. Cross-process transfer remains F07.
- Snapshot heap array identity must remain stable: compiled expressions capture that array.
- Retain slicer memory, isolation and single-writer constraints in topology plans, then validate/reprice candidate moves.
- Benchmarks must report the actual tokenizer miss instead of retaining the old estimator-based passing assertion.

## Failed attempts and limitations

- Initial snapshot test used an invalid nominal type identifier; corrected. Independent review also found stale closure access, broken moved callbacks and inconsistent memory/latency pricing; all were repaired with regression tests before verification.
- Native targets, proof kernel/ZK, full Tree-CRDT/BFT, and numerical/model research gates are still planned.
- No 100M-node or 1,000-agent production result exists. No task is verified merely because related unit tests pass.
- No external blocker has been established; substantial local work remains.

## Next executable actions

1. Integrate F04 effect routing into both runtimes and preserve structured indeterminate outcomes.
2. Review F05 causal/equivocation recovery and bind F06 admission to actual verifier/dependency evidence.
3. Verify these contracts at an exact implementation checkpoint, then begin durable process migration and exact-root promotion.
4. Start the four research decision tasks as independent work becomes available; retain all full v4 scope.

Goal-turn classification: progress — three foundation tasks implemented, independently tested and evidenced; the next three are active. No global blocker has been established.
