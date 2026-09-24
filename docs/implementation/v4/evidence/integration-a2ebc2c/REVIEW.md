# V10 postcommit controller crash checkpoint

Exact tested source: `a2ebc2c4c35dac6ffdba9f3aa4ea156571c0e006`, specification 0.1.0. The worktree was clean during the full suite and exact-source benchmark. These evidence files were added afterward.

| Check | Result | Evidence |
| --- | --- | --- |
| `npm test` | 950 tests: 949 pass, 0 fail, 1 existing opt-in skip | [full suite](full-test.log) |
| V10 crash, V10 host/deployment and historical V9 crash focus | 3/3 pass | [focused tests](focused.log) |
| Build, typecheck and both roadmap checks | pass; 62 tasks and 71 obligations valid | [build](build.log), [typecheck](typecheck.log), [v4 roadmap](roadmap-v4.log), [roadmap](roadmap.log) |
| `bench:v4:measure` and exact-source verification | raw samples and source hashes verify; release eligible **false** | [measure](bench-measure.log), [verify](bench-verify.log), [manifest](bench/manifest.json), [samples](bench/samples.json) |
| `bench:v4:enforce` | expected exit 1; 17 required targets failed or unmeasured | [enforcement](bench-enforce.log) |

The new V10 campaign runs a controller, real worker, sink, sink witness and operator witness as separate processes under one UID. A `SIGKILL` occurs after the sink has durably committed and before the broker publishes its terminal journal. The sink witness retains one signed decision while the effect witness retains only a prepared dispatch marker. A fresh ProcessDeployment controller refuses `abort-before-effects`, proves the old broker ticket owner is gone, reconciles through signed sink status and the sink head, completes isolated host replay, publishes the deployment receipt and returns the identical cached result without a second sink decision. The historical V9 controller crash test still passes.

An expanded V10 grant test exposed a valid but narrower child grant being denied only at the later effect boundary. Fixed V4/V5 signed resource paths are now checked at call admission, before the deployment publishes an outer intent or starts a worker. The real V10 host/deployment test confirms forged widening and valid narrowing both fail with no new sink decision. A focused read-only review found no confirmed live-owner ticket release, duplicate dispatch or false-commit bypass in these changes; the dead-owner check fails closed for a live or unverifiable ticket owner.

The bounded sink still writes only its own append-once file. The profile remains under one UID, has a fixed sink-wide grant, and labels rather than measures the approved adapter executable. Other crash/fence phases, durable budget settlement, distinct-UID custody, a third-party irreversible transaction, and rollback-protected time/epoch authority remain unverified. V4-T2-04/G1/G2 and NFR-16 stay open.

The unchanged complete warm-message fixture measures **1.861×** compression against the 4× target. Seventeen required release targets fail or are unmeasured; the tracker remains **20/62 verified**. SHA-256 digests for retained artifacts are in [hashes.json](hashes.json).
