# AST-derived native fallback research

`compiler.ts` accepts an exact Aether module/manifest and lowers the two actual fallback bodies and their contract into C. It first checks the AST root and closed type relation. The declared research domain is two pure functions over aliased one-field `Int` records, a four-record frame, and signed 64-bit trap arithmetic. Unsupported syntax, effects, contract frames, stale manifests and out-of-domain literals fail before native compilation. The shared native `driver.c` keeps both tiers in one call frame, restores records and allocator after a Tier 1 fault, checks Tier 2 permission, and enters the generated Tier 2 function. It is a research path, not production compiler admission.

The retained fallback [assembly](results/m4pro-2026-09-23-01/fallback/native-fallback.s) has an actual `bl _tier2` after the rollback/permission path (line 544), and `_tier2` reads the clock at its entry (lines 613–636). This inspection supports the stated timing bracket for this binary; it does not validate the full Aether runtime.

The [preregistered Apple M4 Pro campaign](results/m4pro-2026-09-23-01/preregistration.json) pinned clean source commit `9f7d5cf9959c6cc96ec0896d4063105a22a1a1ce`, source hashes, Clang flags, the 50 ns bound and 10,000 individual samples before compilation. It built primary, fallback and abort binaries from distinct Aether ASTs. All **14 native/reference cases** matched actual `FallbackTreeRuntime` results, including aliasing, rollback, allocator identity, permission denial and revocation. Editing the Tier 2 AST allocation literal changed the AST root, generated source, binary and observed output, and matched the edited Aether runtime. The [independent audit](results/m4pro-2026-09-23-01/audit.json) rebuilt all four binaries, reran the differential corpus and recounted every [raw sample](results/m4pro-2026-09-23-01/raw.jsonl).

| Bracket | p50 | p95 | p99 | Observed maximum | Above 50 ns |
| --- | ---: | ---: | ---: | ---: | ---: |
| Fault read through Tier 2 entry | 0 | 41.667 ns | 41.667 ns | **41.667 ns** | 0 / 10,000 |
| Full native call | 0 | 41.667 ns | 41.667 ns | **83.333 ns** | 1 / 10,000 |
| Adjacent timer pair | 0 | 41.667 ns | 41.667 ns | 41.667 ns | 0 / 10,000 |

The timer advances in **41.667 ns** steps; zero-tick observations are quantization. The switch result is **inconclusive**, not a passing 50 ns maximum. The full-call bracket misses 50 ns, and the measured native code lacks the admitted runtime's effects, proof checks, general heap, durable recovery and scoped-grant machinery. No T3-07 or release gate is closed by this campaign. See the [report](results/m4pro-2026-09-23-01/report.json) and [exact-source integration review](../../../../docs/implementation/v4/evidence/integration-9f7d5cf/REVIEW.md).

To reproduce the audit from a clean historical checkout, use source commit `9f7d5cf` and point `audit.ts` at the retained result directory. The audit refuses source drift. To run a new measurement, use a fresh directory outside the repository:

```sh
node --experimental-strip-types roadmap/v4/research/native-fallback-ast/campaign.ts register /tmp/aether-fallback-new
node --experimental-strip-types roadmap/v4/research/native-fallback-ast/campaign.ts run /tmp/aether-fallback-new
node --experimental-strip-types roadmap/v4/research/native-fallback-ast/audit.ts /tmp/aether-fallback-new
```

The full T3-07 path still needs broader Aether values and effects, authenticated sink status, portable proof admission in native artifacts, exact ProcessHost state/recovery handoff and a timer/qualification method capable of supporting the unchanged in-frame 50 ns maximum.

## Snapshot-fed native input

The opt-in snapshot-case driver entry now consumes a projection of an actual RuntimeSnapshotV1 rather than constructing its own initial frame. The snapshot bridge checks the execution manifest, complete object table, logical-reference heap/epoch ownership, contiguous one-field Int records and a free allocation slot before passing object IDs, aliases and values to the native executable. The research runner hashes the binary and executes a private copy of those checked bytes. Fourteen real-snapshot differential cases match the reference fallback outcome, including aliases, rollback, permission denial and Tier 3 abort. Stale refs, malformed native frames, full frame capacity and changed executable bytes are refused.

This remains a bounded research ABI. It is not a ProcessHost checkpoint lease or production state publication, and it does not add full Aether values/effects or a portable proof of the native Tier 2. The validated snapshot projection and checked executable are necessary handoff pieces, not T3-07 admission.

## Clock qualification

The reproducible [clock probe](clock-probe.c) samples 100,000 adjacent reads per clock on the target Mac. On the local Apple M4 Pro, mach_timebase_info reported 125/3 ns per tick. The uptime and monotonic raw nanosecond clocks mostly advanced in 41/42 ns steps; ordered CNTVCT_EL0 reported a nominal 1 GHz counter but also mostly advanced by 41/42 count units after zero deltas. [Apple's timing documentation](https://developer.apple.com/documentation/apple-silicon/addressing-architectural-differences-in-your-macos-code) requires applying the Mach timebase and points to the nanosecond clock API. [Arm's Generic Timer guide](https://developer.arm.com/-/media/Arm%20Developer%20Community/PDF/Learn%20the%20Architecture/Generic%20Timer.pdf) explains counter update jumps and the ordering barrier for timestamp reads.

The probe does not time a fallback switch. It shows why the prior one-tick observed switch maximum cannot prove a hard 50 ns limit: an interval recorded as one 41.667 ns tick can approach two ticks. PMCCNTR_EL0 trapped in a separate local probe, and this Mac currently lacks Xcode/Instruments. A controlled target with a demonstrably finer timing source and explicit scheduling profile is needed after the admitted native path exists. The old result remains inconclusive; no threshold changes.
