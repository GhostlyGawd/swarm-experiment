# Signed virtual-forward evidence and retention checkpoint

Date: 2026-09-24. Specification: v4 `0.1.0`. Exact tested source commit: `f0423d0` on `aether/v4-implementation`. Retained output hashes are in [hashes.sha256](hashes.sha256). This is focused integration evidence; no V4-T1-05 gate was marked verified.

| Command | Result | Output |
| --- | --- | --- |
| `node --test --test-concurrency=1 --experimental-strip-types` over the thirteen files below | **106 passed, 0 failed** | [focused.log](focused.log) |
| `npm run typecheck` | pass | [typecheck.log](typecheck.log) |
| `npm run build` | pass | [build.log](build.log) |
| `npm run roadmap:v4:check` | 62 tasks and 71 obligations valid | [roadmap-v4.log](roadmap-v4.log) |
| `npm run roadmap:check` | pass | [roadmap.log](roadmap.log) |

Focused files: `test/fabric/virtual-forward-evidence.test.ts`, `test/fabric/evidence.test.ts`, `test/fabric/evidence-hard.test.ts`, `test/tier1/causal-lineage.test.ts`, `test/tier1/semantic-gc-virtual-forward.test.ts`, `test/tier1/tree-semantic-retention.test.ts`, `test/tier1/tree-workspace.test.ts`, `test/tier1/semantic-gc-adapters.test.ts`, `test/tier1/semantic-gc-sink-retirement.test.ts`, `test/tier3/active-task-semantic-retention.test.ts`, `test/tier3/checkpoint-semantic-retention.test.ts`, `test/tier3/semantic-gc-virtual-resumable.test.ts`, and `test/tier4/process-semantic-retention.test.ts`.

Evidence policy `/3` derives archived-wrapper and target dependency edges from the exact D16 descriptor while signing the D17 candidate profile. The strict-lineage test signs a source and candidate, refuses descriptor substitution, pins the archived wrapper, drops draft leases, collects, reopens and checks that the wrapper remains in the candidate's admitted closure. Direct active-task retention pins the same program roots before its first frame; direct journal `/2` pins replay roots before a head. A combined test starts inside the virtual wrapper, checkpoints, collects and resumes after reopen. Tree workspace configuration `/2` binds unstable-replication retention to the workspace; marker, record and physical lease loss fail closed after frame publication. The focused suite includes separate-process kill/recovery and retirement-liveness cases.

**Open:** Legacy semantic-GC `/1` still rejects fresh wrapper collapse. No versioned one-wrapper GC proposal has been governor-promoted. The effect broker and ProcessHost still reject this virtual path; Agent-IR/process artifact transport, physical resumable bypass, general contracts/values, safe semantic-pin release and full G1/G2 lifecycle campaigns remain. The serial full suite and release benchmarks were **not** rerun on this commit. The last recorded release enforcement had 17 failed or unmeasured required targets. The tracker stays **20/62**.
