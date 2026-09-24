# Virtual forwarding and replay retention integration checkpoint

Date: 2026-09-24. Specification: v4 `0.1.0`. Tested source commit: `4e210632a972a8ea371d28397b2b4b34edb140f6` on `aether/v4-implementation`. The retained logs are covered by [hashes.sha256](hashes.sha256). This is focused integration evidence, not V4-T1-05 gate acceptance.

| Command | Result | Log |
| --- | --- | --- |
| `node --test --test-concurrency=1 --experimental-strip-types` with the ten test files listed below | **86 passed, 0 failed** | [focused.log](focused.log) |
| `npm run typecheck` | pass | [typecheck.log](typecheck.log) |
| `npm run build` | pass | [build.log](build.log) |
| `npm run roadmap:v4:check` | 62 tasks and 71 obligations valid; no task status changed | [roadmap-v4.log](roadmap-v4.log) |
| `npm run roadmap:check` | pass | [roadmap.log](roadmap.log) |

Focused files: `test/tier1/semantic-gc-virtual-forward.test.ts`, `test/tier1/semantic-gc-adapters.test.ts`, `test/tier1/semantic-gc-sink-retirement.test.ts`, `test/tier3/semantic-gc-virtual-runtime.test.ts`, `test/tier3/semantic-gc-virtual-compiled.test.ts`, `test/tier3/semantic-gc-virtual-resumable.test.ts`, `test/tier3/checkpoint-semantic-retention.test.ts`, `test/tier3/compile.test.ts`, `test/tier3/resumable-runtime.test.ts`, and `test/tier4/process-semantic-retention.test.ts`.

The checked descriptor limits virtual behavior to exact rewritten call sites. The reference runtime preserves finite AST-step faults, traces, bindings and effect timing in bounded tests; compiled execution preserves the removed wrapper's host guard; the resumable profile restores source bytecode, frame shape and bytecode quota behavior while physically executing the archived wrapper. A direct journal/2 test checkpoints inside that wrapper, drops a draft AST lease, collects, reopens and finishes using retained module and dependency roots. Separate real `SIGKILL` cases check replay-root pins before and after direct head publication. Adapter and sink retirement analyze those exact dependency roots under the retained executable reference, rejecting incomplete groups.

**Open:** The D14 guard still forbids new collapsed-wrapper promotion. The descriptor is not admitted with signed lineage into the effect broker or ProcessHost, and the resumable path has no physical bypass or measured memory/latency win. Agent-IR transport, broader contracts/values, adapter retirement across general external registrations, active-task-before-first-checkpoint and unstable-replication lifecycles, safe release, and full G1/G2 campaigns remain. The serial full suite and release benchmarks were **not** rerun on this commit. The last retained full run belongs to an earlier source checkpoint and cannot qualify this combined source. The tracker remains **20/62**, with 17 required release targets still failed or unmeasured in the prior benchmark record.
