# V4 broker sink-witness checkpoint

Exact tested source: `f9ffa96` (full SHA in the [benchmark manifest](bench/manifest.json)), specification 0.1.0. The worktree was clean during the full suite and exact-source benchmark; these evidence files were added afterward.

| Check | Result | Evidence |
| --- | --- | --- |
| `npm test` | 942 tests: 941 pass, 0 fail, 1 existing opt-in skip | [full suite](full-test.log) |
| Sink/receipt/adapter/broker/witness focus | 27/27 pass | [focused tests](focused.log) |
| Build, typecheck and both roadmap checks | pass; 62 tasks and 71 obligations valid | [build](build.log), [typecheck](typecheck.log), [v4 roadmap](roadmap-v4.log), [roadmap](roadmap.log) |
| `bench:v4:measure` and exact-source verification | raw samples and source hashes verify; release eligible **false** | [measure](bench-measure.log), [verify](bench-verify.log), [manifest](bench/manifest.json), [samples](bench/samples.json) |
| `bench:v4:enforce` | expected exit 1; 17 required targets failed or unmeasured | [enforcement](bench-enforce.log) |

The opt-in broker V4 stores `aether.effect-journal/4` with the operator-selected sink witness digest. It checks that each signed terminal receipt is present in the sink witness head with the exact request and value before publication and again on read. A valid sink signature without a retained sink decision stays indeterminate until the exact head advances. The real process campaign kills the controller after the sink commits, deletes the sink-local mirror, restarts the sink, and reconciles in a new controller without a second decision. It also refuses V3 journal downgrade and cached success after the sink witness process is killed. The historical V3 campaign remains passing.

This remains broker-level fixture evidence under one UID. Distinct-UID custody, actual third-party irreversible transaction binding, ProcessHost/Deployment admission, all-path hostile adapter containment, budget settlement and time/epoch rollback qualification remain open. The V4 broker head is an independently selected source only when deployed with true external custody.

The unchanged complete warm-message fixture measures **1.861×** compression against the 4× target. Seventeen required release targets fail or are unmeasured. V4-T2-04 and the v4 release gate remain open; the tracker stays **20/62 verified**. SHA-256 digests for retained artifacts are in [hashes.json](hashes.json).
