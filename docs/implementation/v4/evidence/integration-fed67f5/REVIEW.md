# V11 resource-scoped sink checkpoint

Exact tested source: `fed67f5f77ddae1202762c0f748a0f1103749b0a`, specification 0.1.0. The worktree was clean during the full suite and exact-source benchmark. These evidence files were added afterward.

| Check | Result | Evidence |
| --- | --- | --- |
| `npm test` | 961 tests: 960 pass, 0 fail, 1 existing opt-in skip | [full suite](full-test.log) |
| Build, typecheck and both roadmap checks | pass; 62 tasks and 71 obligations valid | [build](build.log), [typecheck](typecheck.log), [v4 roadmap](roadmap-v4.log), [roadmap](roadmap.log) |
| `bench:v4:measure` and exact-source verification | raw samples and source hashes verify; release eligible **false** | [measure](bench-measure.log), [verify](bench-verify.log), [manifest](bench/manifest.json), [samples](bench/samples.json) |
| `bench:v4:enforce` | expected exit 1; 17 required targets failed or unmeasured | [enforcement](bench-enforce.log) |

The opt-in V6 policy selects one bounded tagged string argument as a signed resource path segment. V11 ProcessHost configuration `/9` and deployment `/11` bind that policy, the operator sink authority and the same sink/effect/host/deployment witnesses. A real worker and separate sink/witness processes write Alice and Bob under disjoint grants. Wrong-target and unsafe-segment calls add no sink decision. A worker that mutates a record before attempting a forbidden target leaves the stored counter unchanged because the concrete path is checked before adopting its proposed snapshot. Grant reference `/2` differs by exact target and is reconstructed from retained effect arguments during recovery.

A focused review found that an Alice-only caller could receive Bob's cached result. Direct and deployed cached paths now check every retained target against the caller's current-generation grant, including after a same-policy promotion. The process campaign verifies allowed Carol reads and denied Alice reads across generations and after reopening an older local registry. The V11 crash campaign kills the controller after sink commit, recovers `account/alice` with one sink decision, and repeats recovery after the original grant is revoked. Historical V10 crash/fence and V9 profiles continue to pass.

This is a same-UID append-once sink fixture. The signed selector proves authorization for one chosen string argument; it does not prove an arbitrary external adapter uses that argument as its actual transaction target. The approved adapter artifact digest is a label rather than measured executable bytes. A strict atomic revocation/result-publication guarantee needs a shared authority fence, and durable budget settlement, distinct-UID custody, full hostile-adapter isolation, other V11 crash/fence phases and a third-party irreversible transaction remain open. V4-T2-04/G1/G2 and NFR-16 are not verified.

The unchanged complete warm-message fixture measures **1.861×** compression against the 4× target. Seventeen required release targets fail or are unmeasured; the tracker remains **20/62 verified**. SHA-256 digests for retained artifacts are in [hashes.json](hashes.json).
