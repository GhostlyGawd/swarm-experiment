# Signed sink fallback checkpoint

Exact tested source: `8b92d14573c063865a52392b322aebf690501e0c`, specification 0.1.0. The worktree was clean during the full suite and exact-source benchmark. These evidence files were added afterward.

| Check | Result | Evidence |
| --- | --- | --- |
| `npm test` | 975 tests: 974 pass, 0 fail, 1 existing opt-in skip | [full suite](full-test.log) |
| Focused fallback campaign | 28/28 pass: signed sink, proof and process fallback | [full suite](full-test.log) |
| Build, typecheck and both roadmap checks | pass; 62 tasks and 71 obligations valid | [build](build.log), [typecheck](typecheck.log), [v4 roadmap](roadmap-v4.log), [roadmap](roadmap.log) |
| `bench:v4:measure` and exact-source verification | raw samples and source hashes verify; release eligible **false** | [measure](bench-measure.log), [verify](bench-verify.log), [manifest](bench/manifest.json), [samples](bench/samples.json) |
| `bench:v4:enforce` | expected exit 1; 17 required targets failed or unmeasured | [enforcement](bench-enforce.log) |

The [signed sink fallback campaign](../../../../../test/tier4/process-fallback-attested-sink.test.ts) uses separate sink and witness processes, a witnessed V8 ProcessHost, a witnessed broker and a checked portable certificate for the pure scalar Tier 2. A signed commit returns Tier 1 across cached retry and reopen with one sink decision and no Tier 2 host call. A signed noncommit fence permits Tier 2; witness outage prevents unverified fallback until the restarted witness supplies status. Cached success also fails closed while the witness is unavailable.

The ProcessFallbackSupervisor now checks current root and tier authority after host completion and before its own final receipt. It compares every tier's deterministic host operation with cached or proposed supervisor results, blocking a false static abort when a later host operation succeeded or remains unresolved. A terminal abort checks the original snapshot and generation at publication. Tests cover revocation after host completion, a direct Tier 2 call under a cached-abort identity, root revocation after Tier 2 success and a concurrent writer at the terminal decision boundary.

This remains a process-level candidate with `productionAuthorized: false`. The signed sink fixture is operated under one UID, its adapter artifact digest is not executable-byte measurement, and the new campaign does not kill the controller between an authenticated sink commit and supervisor reconciliation. The native AST research path still lacks admitted runtime values/effects and portable Tier 2 proof. Its previous 41.667 ns timer step makes the observed switch maximum inconclusive against FR-3.7's **50 ns hard maximum**; the full-call maximum missed at 83.333 ns. T3-07/G1/G2 and FR-3.7 remain unverified.

The unchanged complete warm-message fixture measures **1.861×** compression against the 4× target. Seventeen required release targets fail or are unmeasured; the tracker remains **20/62 verified**. SHA-256 digests for retained artifacts are in [hashes.json](hashes.json).
