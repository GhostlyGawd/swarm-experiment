# Exact-source v4 release inventory at `fa2fc64`

Specification: v4 `0.1.0`. Source commit: `fa2fc64343a2a620742259faf5a3b5af92e8fe45`. The worktree was clean when `npm run bench:v4:measure -- --output docs/implementation/v4/evidence/bench-fa2fc64` created [manifest.json](manifest.json) and [samples.json](samples.json). Their SHA-256 hashes are in [hashes.sha256](hashes.sha256).

`node --experimental-strip-types bench/v4/verify.ts docs/implementation/v4/evidence/bench-fa2fc64 --exact-source` independently recounted the pinned `cl100k_base` corpus and returned `verified: true`, `sourceMatches: true`, `releaseEligible: false`. The default `v4-release/2` profile now uses the versioned `ledger-warm-v6/1` fixture. Complete warm messages measure **698/124 = 5.629×**, passing the required 4× fixture target. Cold is **878/933 = 0.941×** and the complete changed session **1361/1193 = 1.141×**; both are diagnostic misses. The other **15 required NFR targets are not measured** by this inventory, so release eligibility remains false. FR-1.2 and Q03 also require representative production evidence beyond this one deterministic workload.

Environment and tokenizer are recorded in the manifest. This is offline token accounting with one deterministic trial, not a latency, hardware-scale or model-billing measurement. Historical `v4-release/1` evidence remains available separately.
