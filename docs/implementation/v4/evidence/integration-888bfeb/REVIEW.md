# Exact-source combined v4 checkpoint at `888bfeb`

Specification 0.1.0; clean tested source
`888bfebf2d43e2879244ae588c5a8c22387808bd` on
`aether/v4-implementation`. The serial [full suite](full-suite.log) passed
**1,204/1,206**, with **zero failures** and **two existing skips**. Separate
[build](build.log), [typecheck](typecheck.log), [v4 roadmap check](roadmap.log)
and [worker-bundle verification](bundle-verify.log) passed on the same source.
[Hashes](hashes.sha256) bind the retained logs and benchmark artifacts.

The [default release measurement](bench-measure.log) and [independent
exact-source verification](bench-verify.log) returned `verified: true`,
`sourceMatches: true`, `releaseEligible: false`. The pinned cl100k warm ledger
fixture measures **5.6290×** and passes its required 4× row. Cold delivery
measures **0.9411×** and the full changed session **1.1408×**; both are
diagnostic misses. The remaining **15 required NFR targets are unmeasured** in
the default inventory. The raw [manifest](bench/manifest.json) and
[samples](bench/samples.json) are retained. This inventory uses actual token
counts, not model billing, and does not qualify hardware latency or scale.

The combined suite includes V17 checked task projections, the signed living
boundary pipeline, source-backed Artifact/4 config/18 with source/governor
SIGKILL recovery and after-prepare direct-call refusal, and the older effect,
retention and deployment paths. The corrected stale-spec fixture passes in
this full run. [D21](../../decisions/D21-living-campaign-throughput-boundary.md)
places the unchanged 2M/s FR-3.3 rate on the preregistered R04
generator/evaluator; this suite does not itself remeasure that rate. The
exact-source R04 evidence remains [separate](../t303-pipeline-faf2172/REVIEW.md).

T1-02 semantic/token coverage, T1-05 general effect/contract-preserving
rewrites and lifecycle release, T3-03 production fault coverage, and all
unmeasured release NFR/KPI/governance gates remain open. The tracker stays
**20/62 verified**.
