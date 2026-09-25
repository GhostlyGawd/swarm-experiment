# Exact-source combined v4 stopping checkpoint

Clean tested source `f3c9fda6269d4f022dae7ec9ad589efb658984f8`,
specification 0.1.0, branch `aether/v4-implementation`. The serial
[full suite](full-suite.log) passed **1,215/1,217** tests, with **zero
failures** and **two existing skips**. Separate [build](build.log),
[typecheck](typecheck.log), [v4 roadmap](roadmap.log) and independent
[worker-bundle verification](bundle-verify.log) passed. The rebuilt worker
bundle remains 769,991 bytes with the pinned 70-input closure. [Hashes](hashes.sha256)
and [hash verification](hash-check.log) bind every retained log and benchmark
artifact.

The [default release measurement](bench-measure.log) and [independent
exact-source verification](bench-verify.log) returned `verified: true`,
`sourceMatches: true`, `releaseEligible: false`. The pinned AE6 warm ledger
row passes at **5.6290×**; cold **0.9411×** and complete changed-session
**1.1408×** are diagnostic misses. The other **15 required NFR targets remain
unmeasured** in this default inventory. Raw [manifest](bench/manifest.json)
and [samples](bench/samples.json) are retained. AE7/AE8 authored-corpus
measurements and NFR-08/NFR-09 preflights remain separate target-specific
research; none is silently substituted into the default release profile.

This suite exercises the integrated AE8 graph-slice codec, V18 task
projection, source-witness Artifact/4, living-campaign fault shrink and
Linux-custody runner source alongside legacy runtime/effect/recovery paths.
The actual three-UID Colima campaign has its own [exact-source raw
evidence](../t303-uid-custody-6150604/REVIEW.md); the ordinary serial suite
does not start Colima. The 4× representative Agent-IR requirement, 75k-line/s
projection target, general T1-05 rewrites, independent operator custody,
cross-machine faults and broader release NFR/KPI/governance gates remain
unverified. The tracker stays **20/62**.
