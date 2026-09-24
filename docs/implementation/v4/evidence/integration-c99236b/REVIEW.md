# Signed local virtual-GC promotion checkpoint

Date: 2026-09-24. Specification: v4 `0.1.0`. Exact tested source commit: `c99236b940d00f8bdf00782683db570a0cf0bdbc` on `aether/v4-implementation`. The retained logs are covered by [hashes.sha256](hashes.sha256). This is a bounded local admission checkpoint, not V4-T1-05 completion.

| Command | Result | Retained output |
| --- | --- | --- |
| `node --test --test-concurrency=1 --experimental-strip-types` over nine files listed below | **92 passed, 0 failed** | [focused.log](focused.log) |
| `npm run typecheck` | pass | [typecheck.log](typecheck.log) |
| `npm run build` | pass | [build.log](build.log) |
| `npm run roadmap:v4:check` | 62 tasks and 71 obligations valid | [roadmap-v4.log](roadmap-v4.log) |
| `npm run roadmap:check` | pass | [roadmap.log](roadmap.log) |

Focused files: `test/tier1/semantic-gc-virtual-promotion.test.ts`, `test/tier1/semantic-gc.test.ts`, `test/fabric/virtual-forward-evidence.test.ts`, `test/tier1/causal-lineage.test.ts`, `test/tier3/semantic-gc-virtual-resumable.test.ts`, `test/tier3/active-task-semantic-retention.test.ts`, `test/tier3/checkpoint-semantic-retention.test.ts`, `test/tier1/tree-semantic-retention.test.ts`, and `test/tier4/process-semantic-retention.test.ts`.

The separate V2 proposal admits one pure, closed forwarder only after signed V3 candidate evidence includes the exact archived wrapper dependency. Governor plans bind the proposal ID, descriptor, roots and both manifest digests. The built-in local driver compiles the exact resumable candidate, stages the AST head, holds the matching collector's retention fence at commit, and recovers only the persisted proposal ID. Tests cover signed promotion, a postcommit interruption, exact-ID recovery, stale lineage, descriptor/plan substitution, predecessor retention, and legacy D14 refusal. Adversarial review found caller-owned options could redirect the store or erase an export fence, and finalized retry could confirm a head moved by another writer; dedicated regressions now verify options snapshotting and wrong-head refusal.

**Open:** This profile rejects effectful/dynamic modules and does not transport the descriptor into ProcessHost or the broker. The signed artifact digest is not measured against emitted executable bytes. The public local AST head can still be changed by an independent writer after activation; coordinator serving state alone is not a serving-time head attestation. Direct active-task and replication pins may use separate collector directories, so the V2 fence does not prove complete G2 race coverage. Physical wrapper bypass, general contracts/values, safe pin release and all full G1/G2 campaigns remain open. The serial full suite and release benchmark were **not** rerun on this commit. The prior release record still has 17 failed or unmeasured required targets, and the tracker stays **20/62**.
