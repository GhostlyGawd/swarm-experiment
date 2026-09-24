# Witnessed budgeted sink host checkpoint

Exact benchmark subject: `cc9347c01719e714dde7544f4b4bfef031344d15`, specification 0.1.0. The worktree was clean for the exact-source measurement. Evidence files were added afterward. Source and tests for the budget profile are in commits `cf66de6` through `fcab7c2`; `cc9347c` changes the closure priority in documentation.

| Check | Result | Evidence |
| --- | --- | --- |
| Direct V12 host and authority tests | 1/1 real-process host and 2/2 authority tests pass | [host](aether-v12-host-test.log), [authority](aether-v12-authority-test.log) |
| Historical signed-sink host and budget-witness regressions | 7/7 and 5/5 pass | [host regressions](aether-budget-v12-historical-host.log), [witness regressions](aether-budget-v5-witness-tests.log) |
| Build, typecheck and both roadmap checks | pass; 62 tasks and 71 obligations valid | [build](aether-v12-build.log), [typecheck](aether-v12-typecheck.log), [roadmap](aether-v12-roadmap.log), [v4 roadmap](aether-v12-roadmap-v4.log) |
| Full suite, default concurrency | 1,012 tests: 1,005 pass, 6 fail, 1 skip; worker, proof and controller timeouts | [full run](aether-v12-full-test.log) |
| Full suite, concurrency 2 | 1,012 tests: 1,006 pass, 5 fail, 1 skip; three proof timeouts and two process/witness failures after a very long apparent host pause | [limited run](aether-v12-full-test-c2.log) |
| Isolated reruns of the two failing historical files | Deployment 23/23 and signed-sink fallback 4/4 pass, including all five cases that failed in the limited run | [deployment](aether-v12-deployment-isolated.log), [fallback](aether-v12-fallback-isolated.log) |
| v4 release benchmark | exact-source verification passes; release enforcement exits 1 with 17 required targets failed or unmeasured | [measure](aether-v12-bench-measure.log), [verify](aether-v12-bench-verify.log), [enforce](aether-v12-bench-enforce.log), [manifest](bench/manifest.json), [samples](bench/samples.json) |

The new opt-in profile joins a signed V6 resource target, a predeclared non-null budget reservation, a witnessed V5 effect broker, separate complete bridge/ledger witness heads, and a signed `/2` sink decision in a direct ProcessHost call. Host config `/11` pins the operator budget authority and evidence policy. The host recomputes the exact request before accepting the worker's proposed snapshot. The broker charges a fixed seven-unit amount once for a witnessed commit and refunds a separate reservation only after a signed noncommit fence. Cached retry and reopen do not charge again; sink-witness outage prevents cached delivery. The effect witness rejects a changed bridge profile. The [D12 decision](../../decisions/D12-signed-sink-budget-evidence.md) records the versioned contract and trust limits.

The full suite is **not green** in either run. The default run failed six tests on timeouts. The limited run passed the new V12 host case, but five historical cases failed; all five passed in isolated file reruns. This establishes the bounded feature and several regressions, while leaving a full-suite stability gate unresolved. The limited run lasted over three hours, with two test durations above three hours, so its timing results are not suitable as performance evidence. No task gate is advanced from these runs.

The profile uses predeclared requests and fixed charges under one UID. It does not qualify deployed promotion, dynamic metering, hostile adapters, independent operator custody, a third-party irreversible transaction, or the complete T2-04 direct/closure/cross-process/external-effect matrix. The benchmark's unchanged warm-message compression is **1.861×** against 4×; 17 required release targets remain failed or unmeasured. The tracker stays **20/62 verified**.

SHA-256 digests for retained artifacts are in [hashes.json](hashes.json).
