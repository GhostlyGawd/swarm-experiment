# AST-derived native fallback checkpoint

Exact tested source: `9f7d5cf9959c6cc96ec0896d4063105a22a1a1ce`, specification 0.1.0, clean `aether/v4-implementation` worktree for preregistration, measurement, independent audit and the full test run. This is **in-progress T3-07 research**, not task or release qualification.

| Check | Result | Retained output |
| --- | --- | --- |
| `npm test` (includes build) | 860 tests, 859 pass, 0 fail, 1 existing opt-in skip | [full-test.log](full-test.log) |
| `npm run typecheck` | pass | [typecheck.log](typecheck.log) |
| `npm run roadmap:v4:check` | 62 tasks, 71 obligations valid; 20 tasks verified | [roadmap-v4.log](roadmap-v4.log) |
| `npm run roadmap:check` | pass | [roadmap.log](roadmap.log) |
| Preregistered native campaign and independent audit | 14/14 differential cases; 10,000 raw samples; audit pass | [campaign report](../../../../../roadmap/v4/research/native-fallback-ast/results/m4pro-2026-09-23-01/report.json), [audit](../../../../../roadmap/v4/research/native-fallback-ast/results/m4pro-2026-09-23-01/audit.json) |

The compiler derives both native tier bodies and contract checks from exact Aether AST/manifest bytes, then executes them inside one bounded C frame. The independent audit rebuilt four binaries, reran all native/reference cases, checked the changed-AST binary/result witness and recounted every raw timing sample. Alias identity, record values, rollback, allocator cursor, tier and abort codes matched. Source edits and unsupported effects are rejected or change the artifact, rather than being silently mapped to the fixed old C fixture.

Apple M4 Pro `mach_absolute_time` conversion was **41.666666666667 ns/tick**. The fault-read-through-Tier-2-entry bracket observed p50 0, p95/p99 41.667 ns and maximum **41.667 ns**, with zero samples over 50 ns. This is **inconclusive** because one clock tick nearly spans the entire limit and zero ticks are quantization. The full native-call maximum was **83.333 ns** with one sample over 50 ns. No timer overhead was subtracted. This bounded research ABI lacks general Aether values/effects, portable proof admission, authenticated grants/sink status and durable ProcessHost recovery. T3-07 and NFR-04 stay open.

SHA-256 retained artifact digests:

```text
8fb735329ecd41d307b27ec5b273f21d4277acca4fc921a6d7cc9ec0d93c5c84  full-test.log
94196e972baa6f56bbf9c33bb5d11cb2bdbba77c9e1cba54413180d0ec122161  roadmap-v4.log
a24aba684dc7e3baac1ed86ac4d15756297bc8b23864844a02f0548f3a892b61  roadmap.log
21d828da60cecb8e4fb3a7820562dfd40397af0d7a093ca0af4a92eb8591339a  typecheck.log
a005fa56bbb5e909bbbd07763f4a2717b7e7c318353255714487d1247db69ee7  preregistration.json
c1a4e2f44467d315f4dfb32e7b5cbcf05c325f9f25c8c9b96a73f3d258846d31  report.json
688beff93499c2064bacf78ba0e6a1b2973a3546788e33a3a16644e5ea0ed48b  raw.jsonl
4cf0ca4b79d0d6a3a13b41c8fa2e71bdc1b77a8f12a74736fe56413abf495f87  differential.json
ff9629763784093ecbc13aa87dd2b98aac4a12dfedac9b1720778d98b6ed92c3  audit.json
```
