# Native fallback switch research

This experiment tests a bounded native analogue of the existing
`aether.pure-fallback-tree/1` fixture. It is **not** native Aether compiler
output or a release qualification for V4-T3-07 / V4-NFR-04.

## What executes

`switch.c` uses a small fixed native frame with logical record IDs and an
allocator cursor. Two arguments may alias the same record. Tier 1 allocates a
temporary record, writes a speculative value, and faults. The switch restores
the entire pre-call frame, including the allocator cursor, checks current Tier
2 permission, and calls the actual Tier 2 function. Tier 2 allocates at the
same logical ID, increments the input record and checks the shared contract.
If both tiers fail, the pre-call frame is preserved. The fixed frame models
the supported record-reference subset; it does not model the full Aether heap,
cycles, external effects, durable journal, or cryptographic scoped grants.

The [differential corpus](results/m4pro-2026-09-23-01/differential.json) runs
12 cases against the real `FallbackTreeRuntime` with the existing Aether AST
fixture: primary success, Tier 1 failure, both-tier failure, aliased and
distinct arguments, changed initial values, missing Tier 2 permission, and
revocation after a fault. Result tier/code/value, record IDs and values, and
the next allocator ID matched in all 12 cases. The native implementation was
written by hand; the match shows this fixture's behavior, not general
semantic equivalence.

## Preregistered campaign

[Registration](results/m4pro-2026-09-23-01/preregistration.json) pinned the C
source, campaign and differential code, the Aether fixture, the fallback
runtime and compiler source before compilation or measurement. The campaign
used Apple M4 Pro / arm64, Clang `-O3 -std=c11 -Wall -Wextra -Werror -fno-lto`,
10,000 warmups, then five trials of 2,000 individual samples. It retained all
10,000 measurements in [raw.jsonl](results/m4pro-2026-09-23-01/raw.jsonl), the
compiled [assembly](results/m4pro-2026-09-23-01/native-switch.s), and hashes
of the exact binary and artifacts in the [report](results/m4pro-2026-09-23-01/report.json).

The switch bracket begins immediately before reading the volatile Tier 1 fault
flag, after Tier 1 has performed its speculative write and allocation. It
includes fault detection, full fixed-frame restoration, Tier 2 permission
check, function call and Tier 2 prologue. It stops at Tier 2's first clock
read, before Tier 2 allocates or mutates state. A separate full-call bracket
includes both tiers' work. No timer overhead was subtracted from individual
samples. The assembly shows the volatile flag read, frame copy, permission
branches and actual `bl _tier2` call before `_tier2` calls
`_mach_absolute_time` (assembly lines 555–584 and 601–628).

| Individual bracket | p50 | p95 | p99 | Maximum | Over 50 ns |
|---|---:|---:|---:|---:|---:|
| Detection through Tier 2 entry | 0 | 41.667 ns | 41.667 ns | **83.333 ns** | **1 / 10,000** |
| Full native call | 0 | 41.667 ns | 41.667 ns | **83.333 ns** | **2 / 10,000** |
| Adjacent timer pair | 0 | 41.667 ns | 41.667 ns | 41.667 ns | 0 / 10,000 |

The measured switch **missed the 50 ns maximum**. The clock converts one tick
to 41.667 ns; many brackets read zero ticks. A zero is quantization, not a
claim that the path takes zero time. The uncorrected observed maximum and
clock resolution prevent a passing hard-bound claim. Even a no-miss run on
this bounded manual fixture would not qualify the full native runtime.

## Reproduce

From this directory, use a fresh output path for a new campaign:

```sh
node --experimental-strip-types campaign.ts register results/new-campaign
node --experimental-strip-types campaign.ts run results/new-campaign
```

The run refuses changed source pins and an already executed result path. It
compiles the C executable and assembly, compares the 12 native/reference
cases, records every raw timing sample, and reports the maximum and
nearest-rank percentiles. `npm run typecheck -- --pretty false` and the
existing `node --experimental-strip-types --test
test/tier3/fallback-tree.test.ts` both passed during this research run.

Remaining work is native lowering from admitted Aether code, proof and scoped
grant checks at the machine boundary, broader supported state, external-effect
reconciliation, durable recovery, a timing source with enough resolution and
a full-system campaign under the approved 50 ns maximum.
