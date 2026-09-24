# Semantic GC fuel and retention safety checkpoint

Exact tested source: `9e092d96e4182690dd3af01681ad2315404646ab`, specification 0.1.0. The worktree was clean during the complete serial test and exact-source benchmark. Evidence files were added afterward.

| Check | Result | Evidence |
| --- | --- | --- |
| `caffeinate -i npm test` | 1,021 tests: **1,020 pass, 0 fail, 1 existing opt-in skip**; complete uninterrupted serial run | [full suite](aether-gc-full-serial.log) |
| Semantic GC, adapter retention and TreeWorkspace focused suites | **38/38**, **9/9**, **19/19** pass | [GC](aether-gc-fuel-regression.log), [adapter](aether-gc-retention-fence-2.log), [tree](aether-tree-retention-regression.log) |
| Build, typecheck and both roadmap checks | pass; 62 tasks and 71 obligations valid | [build](aether-gc-build.log), [typecheck](aether-gc-typecheck.log), [roadmap](aether-gc-roadmap.log), [v4 roadmap](aether-gc-roadmap-v4.log) |
| Package dry run | pass with built source exports | [file list](aether-gc-package-dry-run.json), [build log](aether-gc-package-dry-run.log) |
| v4 release benchmark | exact-source verification passes; release enforcement exits 1 with 17 required targets failed or unmeasured | [measure](aether-gc-bench-measure.log), [verify](aether-gc-bench-verify.log), [enforce](aether-gc-bench-enforce.log), [manifest](bench/manifest.json), [samples](bench/samples.json) |

The [D14 decision](../../decisions/D14-semantic-gc-fuel-and-retention.md) records a finite-step counterexample to historical branch flattening: a shortened candidate can reach an effect when its source exhausts `maxSteps` first. The new opt-in branch profile retains the original guard and executed arm while replacing a proved unreachable arm, allowing dead references and declarations to be removed without moving the executed reference-runtime step and effect schedule. A 1–24 step differential campaign compares results, effects and traces. New promotions of old step-changing branch/wrapper/shim proposals are refused before a governor decision; historical committed decisions remain recoverable. Old proposal formats remain readable.

The adapter retirement sidecar holds the semantic-retention lock across its final snapshot check and durable table publication. A separate process tries to add an active-task pin during that interval; the pin cannot publish until the decision finishes. `DurableTreeWorkspace` pins imported AST content before durable frame ingress and reconstructs current-epoch pins on reopen. The tests cover absent content, old frame recovery, direct collection and real SIGKILL after frame publication. Those paths fail closed if required AST content cannot be recovered.

The prior default and concurrency-2 full suites in [the budget checkpoint](../integration-cc9347c/REVIEW.md) remain retained as failed diagnostic evidence. This serial run supplies the first clean complete suite for the later source. It keeps the original per-case proof, worker, witness and controller deadlines.

T1-05 remains **in progress**. Fuel-equivalent wrapper/shim collapse, production adapter admission, authoritative active-task/replay retention publication and a complete maintenance-service path are not implemented or verified. The benchmark's warm-message compression is still **1.861×** against 4×, and 17 required release targets remain failed or unmeasured. The tracker stays **20/62 verified**.

SHA-256 digests for retained artifacts are in [hashes.json](hashes.json).
