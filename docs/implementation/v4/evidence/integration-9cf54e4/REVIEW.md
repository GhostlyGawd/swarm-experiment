# Signed sink budget checkpoint

Exact tested source: `9cf54e4c36794f55ee8cea3cdf1049e18a6bd3a0`, specification 0.1.0. The worktree was clean during the full suite and exact-source benchmark. These evidence files were added afterward.

| Check | Result | Evidence |
| --- | --- | --- |
| `npm test` | 968 tests: 967 pass, 0 fail, 1 existing opt-in skip | [full suite](full-test.log) |
| Build, typecheck and both roadmap checks | pass; 62 tasks and 71 obligations valid | [build](build.log), [typecheck](typecheck.log), [v4 roadmap](roadmap-v4.log), [roadmap](roadmap.log) |
| `bench:v4:measure` and exact-source verification | raw samples and source hashes verify; release eligible **false** | [measure](bench-measure.log), [verify](bench-verify.log), [manifest](bench/manifest.json), [samples](bench/samples.json) |
| `bench:v4:enforce` | expected exit 1; 17 required targets failed or unmeasured | [enforcement](bench-enforce.log) |

The [D12 helper](../../decisions/D12-signed-sink-budget-evidence.md) checks a full pinned request against the signed sink decision in the `/2` witness head. It gives the existing resource bridge a committed fixed charge or a signed noncommit fence. The ledger's opt-in historical revalidation checks settlement evidence on read and binds the evidence policy digest into its identity. A real-process campaign retains one charge through broker/bridge/ledger reopen and cached retry, refunds a separate reservation after a signed fence, and leaves a third inflight during witness outage until reconciliation obtains signed status. The focused helper, broker and historical bridge tests pass 18/18.

This is broker-level fixed-charge evidence under one UID. It does not measure actual service usage, admit non-null budget reservations through the V11 host/deployment profile, prove independent monotonic custody for budget journals, or establish that a real third-party transaction occurred. The ledger verifier callback is selected by the process holding its signing key; a policy digest alone does not authenticate that callback. V4-T2-04/G1/G2, T2-05/G1/G2 and NFR-16 remain open.

The unchanged complete warm-message fixture measures **1.861×** compression against the 4× target. Seventeen required release targets fail or are unmeasured; the tracker remains **20/62 verified**. SHA-256 digests for retained artifacts are in [hashes.json](hashes.json).
