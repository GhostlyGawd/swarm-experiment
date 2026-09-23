# Clean v4 integration and runtime acceptance review

At exact clean source `35d989782aa39132ad77db63af90a1b84590d203`, specification `0.1.0`, **630/630 tests passed** with no skip or cancellation. Build, typecheck and both roadmap checks passed. Locked dependencies were installed in a detached checkout. Commands, full logs and hashes are in `manifest.json`.

## V4-F07 revalidation

The existing F07 real-worker migration, nested call/effect, aliasing, owner-generation, process-death and concurrent-host cases pass against the changed ProcessHost/worker source. The new closure regression caught an ordering gap: a retained JS closure could cause snapshot export to fail after an external effect had already been sent. Both legacy and strict grant profiles now reject that unsupported continuation at `exportBoundarySnapshot`, before any sink call. A same-operation retry also leaves the sink count at zero. This rechecks F07's state and effect boundaries without claiming that JS frames themselves can migrate between workers.

Failed effect attempts with no possible external commit now publish the pre-call heap. Resource-scoped grant tests show a wrong ledger target is denied with no sink call and no persisted debit/credit. A committed or indeterminate external effect remains subject to the existing durable reconciliation rules; this rollback path never treats it as absent.

## V4-F08 revalidation

The full suite rechecks exact-root promotion, independently validated composed edits, stale parent/policy denial, signed-lineage default admission, explicit baseline/legacy profiles, actual process deployment, crash recovery, rollback and single effect receipts. Optional strict scoped grants run through ProcessDeployment and real worker/sink calls while the existing F08 baseline path remains compatible. This is the original local governor admission contract; heterogeneous Byzantine production authorization remains V4-T2-06.

## V4-T3-01/G1 — reversible, effect-safe state

The versioned machine records heap, environments, registers, nonempty call frames, pending tasks, inverse step events and effect cursors. Standalone rewind and resume reproduce the same logical state and event history as uninterrupted execution. The ProcessHost lease keeps the full continuation private while publishing only a validated scalar/reference C1 heap to actual workers.

Leased correction and rewind are explicit host-authorized controls. The newer rewind event retains append-only audit history rather than truncating persisted events. Rewinding across committed effects creates durable replay debt bound to the original outcomes. Corrections and new live dispatch remain blocked until deterministic replay consumes that debt; missing broker history fails before machine progress. The tests verify two retained sink writes (`[7,9]`) with no redispatch after restart, and reject Promise-valued or revoked policy callbacks.

## V4-T3-01/G2 — durable reopening and version rejection

The checkpoint store binds code/manifest/profile, heap identity, owner epoch, frame/program counters, event prefixes, inverse deltas and exact digest. Invalid versions, stale code or malformed state/event data fail explicitly. ProcessHost leases and receipts survive real controller death. The SIGKILL campaign covers checkpoint save, sink receipt, heap publication and both sides of control publication; fresh controllers recover the durable decision and resume nonempty frames/pending tasks. Stale handles and generation changes cannot alias newly owned objects.

This verifies the declared single-execution-unit production bridge and the broader private machine. Public C1 heap projection admits scalar fields and record references only; sequences, Results, closures and tasks retain their machine identities privately. Multi-unit worker-frame transport, full native driver qualification and latency/memory release limits remain open in later tasks. Arbitrary state corrections require explicit host policy and do not themselves renew formal proof evidence.

## Other open work and release status

The source also contains working foundations for semantic GC, Agent-IR native scalar/composite projection, versioned grants and a same-host HotStuff node. Their preserved PRD scope remains in progress. The projection corpus records 2,106 AE2 versus 1,382 cl100k source-review tokens, below the 4× target. Release benchmark enforcement exited **1** with **17 required targets still failed or unmeasured**; its exact-source manifest reports a clean worktree.

The prior clean integration attempt at `64894c6` is retained separately: 629/630 tests passed, with one Rust test running another test's binary because both shared a Cargo target directory. Commit `35d9897` isolates those target directories; both Rust tests and the entire suite now pass. A separate standalone build command was mistakenly run concurrently with `npm ci` and briefly lacked TypeScript libraries; its failed log is retained, and the sequential clean build passed. Neither failed attempt is counted as a gate pass.
