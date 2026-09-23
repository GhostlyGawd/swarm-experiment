# Integrated v4 checkpoint — `34a93a2c09bd12ac95c33a135bbe02f8ef090309`

This records a bounded implementation checkpoint on `aether/v4-implementation`, not full v4 completion. The V8 implementation and campaign plan were committed at `f22f9ca58316c4aa99dd6c6af1a1f7146c0c4582`; the campaign ran from that commit and retains 29 byte-for-byte source snapshots. The final documentation and campaign artifacts were committed at the heading commit. No implementation source changed between those two commits.

| Check | Observed result |
| --- | --- |
| `npm test` (includes build) | Exit 0; **833 tests, 832 pass, one opt-in skip, zero fail**; 316,905 ms. The code under test was commit `f22f9ca`; the subsequent commit changed documentation and retained data only. |
| `npm run typecheck`, `npm run build` | Both exit 0 against V8 source. |
| `npm run roadmap:check`, `npm run roadmap:v4:check` | Both exit 0; v4 graph still has 62 tasks and 71 obligations. |
| Projection campaign 13 independent `verify.mjs` | Exit 0; 36 complete root messages, 12 dependency messages, 29 source snapshots; every native bundle parses and both tokenizers recount. A separate check matched all 29 source hashes to the pinned Git commit and current source. [Raw report](../../../../../roadmap/v4/research/projections/results/campaign-13-nested-imports/report.json), SHA-256 `1bc1d309f51ae0711f44726afeff582bd400397f735587707369b0498f04232d`. |
| Packed EL1 `/2` guest `bridge.test.ts` | Exit 0; real guest differential and malformed-input cases. The source-pinned one-shot verifier reran 15 cases, 12 guest runs and 1,168 operations. |
| Packed EL1 `/2` string campaign verifier | Exit 0; source/binary hashes, semantics and all 1,000 raw fresh-guest samples rechecked. Median 41,667 ns; **maximum 1,363,958 ns, one sample over 1 ms**; 65,536 B mapped/observed backing. [Raw samples](../../../../../roadmap/v4/research/packed-hvf-guest/campaign/results/string-local-01.json), SHA-256 `b766788cf781c1163f068b9640eda58a3ef50d8dc151a9ca90fa50cd56e06082`. |
| `npm run bench:v4:enforce` | Exit 1 as required by the unchanged gates: **17 required targets failed or unmeasured**. The clean-tree [manifest](benchmark-manifest.json), SHA-256 `2103b6b0893b6c8b33910b1657eadec931457655489be558026f0ce84a54dd12`, is bound to the heading commit. [Samples](benchmark-samples.json), SHA-256 `58d0133d7308c1b27230949bb7739cf08e687be1b8b33f70f86f0cfb1573814f`. |
| `npm run bench:v4:verify -- .aether-store/benchmarks/v4/latest --exact-source` | Exit 0; `sourceMatches: true`, `releaseEligible: false`, 17 required failures. |

V8 handles exact-address imports inside nested modules and transitive addressed dependencies in actual TypeScript, Python and Rust. Edited native dependency source changes its address and requires explicit rebinding. The preregistered campaign 13 cold ratio is **0.483× cl100k** and **0.489× o200k** against the unchanged TypeScript review baseline, far below the required 4×. The string guest's median is fast, but its maximum misses 1 ms; neither that bounded guest nor observed host backing establishes complete runtime boot or total guest residency.

The tracker remains **20/62 verified**. T1-02, T3-10, T4-05 and the release benchmark gates remain open.
