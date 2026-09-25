# Combined V18 and living-campaign focused checkpoint

Clean integrated source `459ed638eaf6556fba76071d1386b5862244d32f`,
specification 0.1.0. [Projection plus resident-pressure tests](projection-rss.log)
pass **134/134**; [external-sink tests](external-tests.log) pass **2/2**.
[Build](build.log), [typecheck](typecheck.log) and [v4 roadmap](roadmap.log)
pass. The rebuilt worker bundle retains the prior 769,991-byte SHA-256 and
70-input closure. [Hashes](hashes.sha256) bind every retained log and benchmark
artifact; [hash verification](hash-check.log) passed.

The [external fault evidence verifier](external-verify.log) reopens the saved
exact-source `2611c4e` campaign and runs another fresh shrunk replay under
the integrated source. The [V18 audit verifier](v18-evidence.log) recomputes
75 rows and raw tokenizer counts, but reports `sourceMatches: false` because
its exact-source subject is the separately retained clean `bb15b30` code
commit. The integrated **134/134** run exercises V18 on this commit; this
review does not relabel the earlier audit as an exact-source measurement of
`459ed63`.

The current [release inventory](bench-measure.log) independently verifies
against this exact commit with `sourceMatches: true` and
`releaseEligible: false` ([verification](bench-verify.log)). The required
warm ledger row remains **5.6290×**; cold **0.9411×** and changed-session
**1.1408×** are diagnostic misses. **15 required NFR rows are unmeasured.**
Raw [manifest](bench/manifest.json) and [samples](bench/samples.json) are
retained. No whole-repository serial suite was run for this source; the last
such green checkpoint is [888bfeb](../integration-888bfeb/REVIEW.md).

The integrated changes remain bounded: V18 covers one fresh-record task
field-read path while 45 generated native outcomes still miss; T3-03 covers
one resident-pressure case and a bounded same-host external-fault shrink.
Neither proves the full task gates, production custody or release performance.
The tracker remains **20/62**.
