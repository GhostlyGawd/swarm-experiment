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
- **V4-F07 verified:** real authenticated workers, typed calls, durable state transitions, scoped ownership and migration recovery. Actual termination at every handoff phase and same-ID retries pass.
- **V4-F08 verified:** exact-root governor admission and actual ProcessDeployment recovery. Typed-input poisoning, stale authorization, directory durability and repeated-manifest activation review findings were repaired and regression-tested.
- **V4-M0 verified:** [baseline release](evidence/baseline-4129dfc/REVIEW.md) collects all 12 baseline prerequisites and leaves full v2/v3/v4 requirements open. Clean integration commit `4129dfc` passed **357 tests**, build, typecheck, roadmaps and installed-package worker launch. [Process evidence](evidence/process-4129dfc/REVIEW.md) retains the local package and benchmark enforcement's 17 unmet targets.
- **V4-R01–R04 verified as bounded research:** [research evidence](evidence/research-749ce8b/REVIEW.md) records clean source `749ce8b`, 15 JavaScript tests, two Python tests, typechecking and fresh native/certificate/ZK/learning experiments. This closes research gates only.
- **R01 result:** exact rational fractional positions and bounded three-phase quorum/epoch models; 5,040 delivery schedules and 128 merge partitions. Production algorithms and 1,000-agent qualification remain open.
- **R02 result:** 1,345 native/reference cases pass. Fresh-process guest bracket maximum 5.401 ms does not qualify the approved running-controller boundary; 65,536-byte bounded guest meets the guest-only memory scope. Full runtime/driver qualification and 50 ns maximum remain open.
- **R03 result:** actual bounded Groth16 proof rejects 14 altered/false claims; fresh verification samples 6.699/5.457/5.946 ms all miss 5 ms. Production setup and full-module attestation remain open.
- **R04 result:** actual adapter train/save/reload and held-out gradient fixtures pass. Fresh boundary throughput 0.448–0.466M/sec misses 2M/sec. No full synthesis/efficiency claim.
- **V4-T1-01 verified:** versioned durable AST storage, root compare-and-swap, leases, pending-promotion pins, bounded archives and coordinated collection. [Evidence](evidence/ast-3dfabca/REVIEW.md) binds clean commit `3dfabca`, 395 passing tests and initialization recovery at eight actual termination points.
- **V4-T2-10 verified:** independent scalar Hoare derivation, exact integer/propositional certificates and closed-artifact compiler admission. [Evidence](evidence/proof-e10d6cd/REVIEW.md) binds clean commit `e10d6cd`, 429 tests, isolated consumers without solver/producer files and the retained 98,200-valuation review. Unsupported theories and proof-latency qualification remain open.
- **V4-T1-03 verified:** default strict production admission now requires signed causal intent, exact evidence and current spec/policy fences. [Evidence](evidence/lineage-2cc2d27/REVIEW.md) records clean `2cc2d27`, 457 passing tests, explicit legacy profile migration and actual crash/recovery/repair without duplicate effects.
- **V4-T3-01 active:** an explicit resumable runtime is being built with serialized nonempty frames, closure/task captures, heap identity and durable event/checkpoint state. A discovered reference-runtime Atomic return rollback bug was fixed and covered by a shared reference/production regression.
- **V4-T1-04 active:** a versioned structural/vector index and actual pinned local embedding-model campaign are being implemented, with labeled recall and full query-cost accounting.
- **V4-T1-06 active:** durable occurrence-tree replication and candidate materialization are being implemented with fractional indexing, deterministic moves and signed epoch/checkpoint stabilization.
- **Native profile follow-up:** campaign 01 retained a 2.535 ms miss; campaign 02 refused to run after its source pin changed. Campaign 03 explicitly initialized an empty VM/vCPU before READY, then ran 1,000 fresh guests: max 167.375 µs, guest resident memory 65,536 bytes. This bounded scalar prototype passes the selected scope; full runtime/driver qualification remains open. A [clean source repeat](evidence/native-5bb4f1c/REVIEW.md) at `5bb4f1c` also passed all 1,000 guests: max 159.542 µs and 65,536 bytes, with every raw sample retained.

Exact-commit evidence is in [foundations-4a9b077](evidence/foundations-4a9b077/REVIEW.md). A detached verification checkout passed 242 tests, typechecking and both roadmap checks. Clean pinned-dependency benchmark measurement exited 0; release enforcement correctly exited 1 with 17 unsatisfied required rows.

The next clean checkpoint, `3dce2d61686129cff45a76d256d3e2681c897fcc`, passed **299 tests**, typechecking and both roadmap checks. [Contract evidence](evidence/contracts-3dce2d6/REVIEW.md) closes F04/F05/F06 and rechecks prior foundation regressions. Its old R01 ordering model is explicitly not accepted as completed research.

## Decisions and findings

- Local movement uses a conservative full heap snapshot. It preserves address identity and commits only after compilation/import validation succeeds.
- Every call boundary must synchronize authoritative state, because repairing movement alone leaves stale-record reads and runtime allocator collisions.
- Local synchronous closures/tasks dispatch through their owning runtime with current authoritative state. Weak references track retained continuations and block unsafe replacement, including externally held callbacks. Migration/export rejects opaque state before publication. Cross-process transfer remains F07.
- Snapshot heap array identity must remain stable: compiled expressions capture that array.
- Retain slicer memory, isolation and single-writer constraints in topology plans, then validate/reprice candidate moves.
- Benchmarks must report the actual tokenizer miss instead of retaining the old estimator-based passing assertion.
- User clarified the native budget boundary: fresh guest on an already-running hypervisor, guest resident memory. Profile `decisions/D07-native-qualification-profile.json` v1.0.0 records it. Historical guest-startup maximum 2.832 ms and clean rerun maximum 5.401 ms do not establish the approved boot gate; host RSS/controller launch are diagnostics.

## Failed attempts and limitations

- Initial snapshot test used an invalid nominal type identifier; corrected. Independent review also found stale closure access, broken moved callbacks and inconsistent memory/latency pricing; all were repaired with regression tests before verification.
- Bounded research is verified; full native targets, portable proof kernel/ZK, Tree-CRDT/BFT and numerical/model features remain to be implemented and qualified.
- No 100M-node or 1,000-agent production result exists. No task is verified merely because related unit tests pass.
- No external blocker has been established; substantial local work remains.

## Next executable actions

1. Checkpoint and verify Tree-CRDT implementation after its capacity-overflow repair; incomplete materialization must expose no normal root.
2. Complete and review resumable execution, including failure-atomic mutations, replay identity and actual checkpoint/task/effect restart coverage.
3. Build and measure native structural/vector retrieval with pinned real embeddings; continue remaining eligible v2 tasks.

Goal-turn classification: progress — the baseline, durable AST persistence, portable scalar certificates and strict signed lineage are verified. Tree-CRDT, resumable execution and semantic retrieval are progressing; full v4 remains open. No global blocker has been established.
