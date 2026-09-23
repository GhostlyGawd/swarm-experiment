# Integrated v4 checkpoint — `fa33e36f1490ed6f8e5f016b474e773031cb8d3a`

The worktree was clean when these checks ran on `aether/v4-implementation`, specification 0.1.0. This is bounded V4-T3-10 implementation progress, not task or v4 completion. [Hashes](hashes.txt) bind the retained logs, benchmark artifacts and raw campaign reports.

| Check | Observed result |
| --- | --- |
| `npm test` (includes build) | Exit 0; **837 tests, 836 pass, one opt-in skip, zero fail**, 359,989 ms. [Full log](full-test.log). |
| `npm run typecheck` | Exit 0. [Log](typecheck.log). |
| Both roadmap checks | Exit 0; 62 tasks and 71 obligations valid. [General](roadmap-check.log), [v4](roadmap-v4-check.log). |
| Current C native bridge tests | Exit 0; 6 tests for `/1` mutation, `/2` strings, hostile frames and runtime candidate handoff. [Log](packed-native-tests.log). |
| Historical C bridge verifiers | Exit 0 from their exact pinned Git checkouts, preserving `/1` and `/2` measurements after the ABI change. [V1](packed-v1-verify.log), [V2](packed-string-verify.log). |
| Historical locality verifier | Exit 0 from its source-pinned checkout: 6 fixtures, 61,440 mapped rows, 18 patterns and 378 raw samples. [Log](packed-locality-history.log), [report](../../../../../roadmap/v4/research/packed-native-locality/results/local-01/report.json). |
| Fused checked-reader verifier | Exit 0; 6 identical fixtures, 504 raw samples, 192,192 value parity rows, 1,052,672 reference-code cases and malformed input checks. [Log](packed-fused-verify.log), [report](../../../../../roadmap/v4/research/packed-fused-locality/results/local-02/report.json). |
| `npm run bench:v4:enforce` | Exit 1, correctly: **17 required targets failed or unmeasured**. [Log](bench-enforce.log), [clean-source manifest](benchmark-manifest.json), [samples](benchmark-samples.json). |
| Exact-source benchmark audit | Exit 0; `sourceMatches: true`, `releaseEligible: false`, 17 required failures. [Log](bench-verify.log). |

The new `aether.process-packed-control/1` binds the exact ProcessHost lease checkpoint, layout, source and candidate image digests, manifest artifact and executable SHA-256. A fsynced layout sidecar keeps large layouts out of the journal. Before publication and on reopen, ProcessHost reconstructs the candidate from corrected logical records, checks the one-event subject, and refuses an altered journal candidate digest or layout sidecar. The integration fixture uses the compiled C bridge and confirms authorization refusal, no-op refusal, final policy recheck, same-ID retry without another native run, real controller SIGKILL before and after the durable decision, reopen and production worker publication. Touched records are checked against their declared types; an in-bounds reference to a different record type is refused.

The checked fused reader is **1.92–3.62× faster** than the previous checked ABI, but remains slower than native pointer rows in **16/18** measured patterns. The current `nativePacked.execute` callback is trusted; an arbitrary callback's claim that it ran an admitted binary is not independently attested. Full AST-to-guest lowering, complete value coverage, guest locality/residency and release performance remain open. V4-T3-10 stays **in progress**, the tracker remains **20/62 verified**, and **17 required release targets** remain unsatisfied.
