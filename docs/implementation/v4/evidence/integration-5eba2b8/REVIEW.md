# Combined AE8 Agent-IR focused checkpoint

Clean integrated source `5eba2b87563cfc9725de01c04f4ea82591592d12`,
specification 0.1.0. The [serial Agent-IR focused suite](focused.log) passes
**27/27** across AE1–AE8, including exact receiver-side graph-slice
reconstruction, stale/missing retrieval refusal and runtime edit parity.
[Build](build.log), [typecheck](typecheck.log) and [v4 roadmap](roadmap.log)
pass. [Hashes](hashes.sha256) and [hash verification](hash-check.log) bind the
retained logs and benchmark artifacts.

The separately retained [AE8 exact-source campaign](../../../../../roadmap/v4/research/agent-ir8/README.md)
at clean `6256c9e` counts the complete nine-message, eight-module session:
**5,333 TypeScript / 5,272 AE8 cl100k tokens (1.012×)** and **5,378 / 5,272
o200k tokens (1.020×)**. Selection and retrieval consume the edit savings.
That authored-corpus measurement is not relabeled as an exact-source result
for `5eba2b8`; this integrated suite checks the behavior on current code.

The [default release inventory](bench-measure.log) independently verifies
against this exact source with `sourceMatches: true` and
`releaseEligible: false` ([verification](bench-verify.log)). It still uses
the pinned AE6 ledger profile: one required warm row passes at **5.6290×**,
cold and complete-session diagnostics miss, and **15 required NFR rows remain
unmeasured**. Raw [manifest](bench/manifest.json) and
[samples](bench/samples.json) are retained. A whole-repository serial suite
has not run for this source; the latest full pass remains
[888bfeb](../integration-888bfeb/REVIEW.md). V4-T1-02, FR-1.2, Q03 and
the **20/62** tracker count remain open.
