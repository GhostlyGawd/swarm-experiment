# Combined AE7 and NFR-09 focused checkpoint

Clean integrated source `dd0e8d8d43caaae6cd690d6b652fb1d9dbd5ce71`,
specification 0.1.0. The [focused tests](focused.log) pass **8/8**, covering
AE7 identity/edit refusal, the legacy Agent-IR path and tamper rejection in
the three-target projection-rate verifier. [Build](build.log),
[typecheck](typecheck.log) and [v4 roadmap](roadmap.log) pass. The worker
bundle remains byte-identical to the prior 769,991-byte measured closure.
[Hashes](hashes.sha256) and [hash verification](hash-check.log) bind all raw
logs and benchmark artifacts.

The [NFR-09 verifier](nfr09-verify.log) independently reprojects and recounts
the saved exact-source `fc3b4c3` preflight. All 48 target bundles retain exact
entry/dependency roots; every timed TypeScript, Python and Rust trial misses
75,000 lines/s. Its authored corpus is not a release-wide production profile.
The separately retained [AE7 exact-source evidence](../../../../../roadmap/v4/research/agent-ir7/README.md)
at `2a53bc2` reports lower eight-module token totals than AE6 but still
misses **4×** on cold and complete changed sessions. Those historical
measurements are not relabeled as exact-source results for `dd0e8d8`.

The [default release inventory](bench-measure.log) verifies against this exact
source with `sourceMatches: true`, `releaseEligible: false`
([independent verification](bench-verify.log)). It still uses the pinned AE6
ledger fixture: one required warm ratio passes at **5.6290×**, cold and
changed-session diagnostics miss, and **15 required NFR rows remain
unmeasured**. Raw [manifest](bench/manifest.json) and
[samples](bench/samples.json) are retained. A whole-repository serial suite
has not run for this source; the last such green checkpoint is
[888bfeb](../integration-888bfeb/REVIEW.md). V4-T1-02, NFR-09, Q02/Q03 and
the **20/62** tracker count remain open.
