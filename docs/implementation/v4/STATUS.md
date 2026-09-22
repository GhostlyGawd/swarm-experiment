# Aether v4 execution status

Goal: implement the complete v4 specification, all 40 functional requirements and all NFR/governance/KPI gates. Full completion remains unproven.

Branch: `aether/v4-implementation`. Planning checkpoint: `9f23a7b`.

## Current work

- **V4-F01 in progress:** implemented local runtime snapshot/import and atomic prepared movement. Replaced stale per-record ownership heuristics with an authoritative synchronous local state domain; separate runtime arrays synchronize at call boundaries and refresh suspended callers. Added allocation, state-loss, nested-call, rollback and placement regressions. Independent adversarial review underway.
- **V4-F02 in progress:** agent delivered truthful token/benchmark manifests and measurement/enforcement CLI. Known ≥4× misses remain failures; integration and exact-commit evidence pending.
- **V4-F03 in progress:** agent delivered canonical bounded values, execution manifests, dependency closure and metadata/snapshot envelopes. Compatibility and adversarial tests passed; root review and evidence integration pending.

## Decisions and findings

- Local movement uses a conservative full heap snapshot. It preserves address identity and commits only after compilation/import validation succeeds.
- Every call boundary must synchronize authoritative state, because repairing movement alone leaves stale-record reads and runtime allocator collisions.
- Local synchronous state synchronization may retain opaque live closures/tasks. Migration/export rejects them before publication. Cross-process state transfer remains F07 and requires the versioned fabric encoding.
- Snapshot heap array identity must remain stable: compiled expressions capture that array.
- Retain slicer memory, isolation and single-writer constraints in topology plans, then validate/reprice candidate moves.
- Benchmarks must report the actual tokenizer miss instead of retaining the old estimator-based passing assertion.

## Failed attempts and limitations

- Initial new snapshot test used an invalid nominal type identifier; correcting the fixture to the required namespace form. The failing run is not accepted evidence.
- Native targets, proof kernel/ZK, full Tree-CRDT/BFT, and numerical/model research gates are still planned.
- No 100M-node or 1,000-agent production result exists. No task is verified merely because related unit tests pass.
- No external blocker has been established; substantial local work remains.

## Next executable actions

1. Finish F01 adversarial review, run integration/regression checks and checkpoint the tested implementation.
2. Integrate F02 scripts and corpus evidence; preserve known release enforcement failures.
3. Review F03 API trust boundaries and integrate public exports.
4. Record exact-commit evidence for completed gates, update tracker, then implement effects, replication and proof admission.

Goal-turn classification: progress — authoritative code, tests and documentation changed; initial regression results expose a fixture issue now being repaired.
