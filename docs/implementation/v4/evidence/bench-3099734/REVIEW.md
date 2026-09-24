# Exact-source v4 release inventory at `3099734`

Specification: v4 `0.1.0`. Source commit: `3099734843ef5d122e89c71b5880347e0bc074a3`. The worktree was clean when `npm run bench:v4:measure -- --output docs/implementation/v4/evidence/bench-3099734` created [manifest.json](manifest.json) and [samples.json](samples.json); their SHA-256 hashes are in [hashes.sha256](hashes.sha256).

`node --experimental-strip-types bench/v4/verify.ts docs/implementation/v4/evidence/bench-3099734 --exact-source` independently recomputed the token counts and verdicts and returned `verified: true`, `sourceMatches: true`, `releaseEligible: false`. The complete warm-message ratio is **1.8613×**, below the required **4×** for both the aggregate and ledger workload. The other **15 required NFR targets are not measured** by this release inventory. Total required failures or missing measurements: **17**.

Environment: Apple M4 Pro, macOS Darwin `25.6.0`, Node `v26.7.0`, pinned `js-tiktoken` `1.0.21` using `cl100k_base`. This is offline token accounting with one deterministic trial, not a latency or hardware-scale measurement. The release remains unqualified, and the tracker remains **20/62**.
