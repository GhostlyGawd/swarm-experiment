# Aether v4 execution status

Goal: implement the complete v4 specification, all 40 functional requirements and all NFR/governance/KPI gates. Full completion remains unproven.

Branch: `aether/v4-implementation`. Planning checkpoint: `9f23a7b`. First implementation checkpoint: `4a9b0776276251cf92ca647baa114c638a2559bf`.

## Current work

- **V4-F01 verified:** state-preserving local migration, authoritative call-boundary synchronization, allocator continuity, closure/task owner dispatch and map/fold callback movement. Eleven migration regressions and independent adversarial review support its three gates.
- **V4-F02 verified:** real token/corpus accounting, pinned tokenizer, benchmark manifests and separate measure/enforce commands. Actual ≥4× and unmeasured release targets remain failed/open. Measurement implementation is complete; performance success is not.
- **V4-F03 verified:** bounded canonical encoding, exact execution identities, dependency closure and sidecars with v1 compatibility checks. Public fabric exports are built and usable.
- **V4-F04 verified:** durable broker, replay/branch isolation, budget hooks, idempotency/reconciliation and runtime bridges. Real process crashes, concurrent writers and all independent-review fixes are evidenced at `3dce2d6`.
- **V4-F05 verified:** signed causal journals, equivocation quarantine and delivery harness; concurrent quota admission is protected by the shared ticket mutex. This is not full Tree-CRDT projection or 1,000-agent qualification.
- **V4-F06 verified:** exact-subject proof admission and compiler integration, peer reverification, preserved entry/property checks and explicit rejection of demonstrated model gaps. Portable certificates remain separate.
- **V4-F07 active:** real authenticated process-channel transport and nested call/effect tests implemented. Root added guarded heap-transfer boundaries and asynchronous journal ownership. Durable ProcessHost coordinator is being implemented and reviewed; no completion claim yet.
- **V4-F08 core work underway:** promotion journal/signature/driver protocol implementation can proceed while F07 is built. Tracker remains planned until its dependency is verified; full closure requires the actual process driver.
- **V4-R01 awaiting corrected evidence:** D04 v0.2.0 restores the PRD's required fractional indexing after detecting an incompatible RGA substitution. Exact rational position model and ten tests pass; checkpoint evidence pending.
- **V4-R02 research artifacts ready:** actual 60-byte freestanding guest boots under Hypervisor.framework; 1,345 checked native/reference cases pass. Cold-process launch and VMM RSS miss the chosen strict timing/footprint profiles; 50 ns bound is inconclusive at available timer resolution. No hardware-access blocker.
- **V4-R03 research artifacts ready:** independent certificate kernel plus actual Groth16 bounded private-artifact proof and independent public verifier. Three verification samples exceed 5 ms; production setup/full-module attestation remains open.
- **V4-R04 research artifacts ready:** actual public SmolLM2-135M LoRA adapter trained/saved/reloaded; held-out gradient fixtures pass. Boundary throughput around 0.49M/sec misses the preregistered 2M target. No full synthesis/efficiency claim.

Exact-commit evidence is in [foundations-4a9b077](evidence/foundations-4a9b077/REVIEW.md). A detached verification checkout passed 242 tests, typechecking and both roadmap checks. Clean pinned-dependency benchmark measurement exited 0; release enforcement correctly exited 1 with 17 unsatisfied required rows.

The next clean checkpoint, `3dce2d61686129cff45a76d256d3e2681c897fcc`, passed **299 tests**, typechecking and both roadmap checks. [Contract evidence](evidence/contracts-3dce2d6/REVIEW.md) closes F04/F05/F06 and rechecks prior foundation regressions. Its old R01 ordering model is explicitly not accepted as completed research.

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

Goal-turn classification: progress — six foundation tasks implemented and evidenced; real process coordination, promotion and four research gates are progressing. No global blocker has been established.
