# Checked virtual-forward integration checkpoint

Date: 2026-09-24. Specification: v4 `0.1.0`. Tested source commit for the **combined focused checks**: `6a9824c` (`aether/v4-implementation`). Log hashes are in [hashes.sha256](hashes.sha256). This checkpoint does not verify V4-T1-05/G1 or G2.

## Results and exact scope

| Command | Result | Retained output |
| --- | --- | --- |
| `node --test --test-concurrency=1 --experimental-strip-types test/tier1/semantic-gc-virtual-forward.test.ts test/tier3/semantic-gc-virtual-runtime.test.ts test/tier3/semantic-gc-virtual-compiled.test.ts test/tier3/compile.test.ts` | 28 passed, 0 failed | [focused.log](focused.log) |
| `npm run typecheck` | pass | [typecheck.log](typecheck.log) |
| `npm run build` | pass | [build.log](build.log) |
| `npm run roadmap:v4:check` | 62 tasks, 71 obligations valid; count unchanged | [roadmap-v4.log](roadmap-v4.log) |
| `npm run roadmap:check` | pass | [roadmap.log](roadmap.log) |

The serial `npm test` run in [full-reference-checkpoint.log](full-reference-checkpoint.log) passed **1,056/1,057** tests, with one existing skip and no failures. It ran while the reference-runtime code was unchanged and was subsequently committed as `2809d43`. The run began before that commit was created; it is therefore a pre-commit regression checkpoint, **not exact-commit evidence for `2809d43`**. It also predates the compiled consumer and effect-router refusals in `bbb5f15` and `6a9824c`, so it is **not a full-suite result for the combined source**. The 28-test combined run above is pinned to `6a9824c`.

## What was established

The descriptor checker independently reconstructs the exact one-wrapper source-to-candidate rewrite and rejects altered roots, scripts, sites, contracts and ambiguous shared call objects. The public reference runtime preserves result/fault, finite-step count, complete trace, `onStep` inspection, wrapper bindings and effects for three inputs at budgets 1–64, plus a target-fault campaign at budgets 1–32. It snapshots checked AST input before execution. The compiled runtime preserves the removed wrapper's extra host `executionGuard` check for local target calls; focused tests compare guard denial and effect timing against the source. Existing direct target calls stay direct. Both runtime paths refuse unbound effect-router use; compiled execution also refuses vetted admission not bound to this sidecar.

## Open gates

The descriptor is not in the signed execution manifest, semantic-GC proposal, Agent-IR or resumable program. The D14 guard still rejects promotion of collapsed-wrapper proposals. No ProcessHost checkpoint, controller crash, broker effect-ID or cross-generation replay campaign used this virtual path. The compiled runtime does not report reference AST steps. General contracts, wrapper chains, non-scalar values, adapter retirement breadth and complete G2 retention lifecycles remain open. Release benchmark enforcement was not rerun at this checkpoint; the previous 17 failed/unmeasured required targets remain on record. The tracker stays **20/62**.
