# T3-03 generated versus executed boundary pipeline

Registration preceded measurement on a clean worktree at
`faf217280f8fc17580b59004a76a465758dc260c`. The manifest pins 105
transitive source/dependency files, the unchanged R04 profile, Apple M4 Pro /
Node v26.7.0 diagnostics and all 15 signed candidate seeds. The verifier checks
source pins, every raw generation/attempt/recovery artifact and its rate/count/
coverage arithmetic, all external sink receipts and independent witness heads,
and a fresh complete partition/rejoin run with new research keys. It does not
reproduce the historical wall time or byte-identical signatures.

| Boundary, measured separately | Count | Raw duration | Rate |
| --- | ---: | ---: | ---: |
| Signed rich-case generation | 15 | 157,250 ns | **95,389.5 cases/s** |
| Actual Aether candidate attempts, including fault/retry/duplicate | 17 | 12,377,423,541 ns | **1.3735 attempts/s** |
| Worker pipeline wall, including recovery and immutable observations | 15 final cases | 13,421,011,833 ns | **1.1177 cases/s** |
| Complete external campaign, including process launch, transport rejoin, raw copy/audit | 15 final cases | 13,965.544 ms | **1.0741 cases/s** |
| Fixed four-field R04 JSON-event kernel, five 20,000-input trials | 100,000 | See `r04-kernel.json` | **2.682–3.076 million/s**, five passes |
| Serial 256-byte file write + file fsync + directory fsync diagnostic | 100 records after 10 warmups | 2,792,292 ns minimum; 3,959,229 ns median | **242.4 records/s** total |

All 15 declared cases were generated, actually executed and passed. There were
**zero filtered cases**, 17 case attempts, one separately counted failed
partition attempt, two recovery calls, 48 coverage labels, and nine signed
external append decisions. The pipeline retains raw timing and results for
every attempt and recovery. Its one failed attempt remains in the report even
though the same case later succeeds after signed reconciliation. Changing an
attempt file or sink record is rejected by the offline audit.

The unchanged R04 kernel materializes, serializes, parses and evaluates four
integer fields, but excludes Aether execution, broker/sink writes and durable
case evidence by its preregistered profile. Its pass therefore cannot be used
as the signed external campaign's execution rate. Rich signed-case generation
alone is about **21× below** 2M/s; the observed full rate is about **1.86
million× below** 2M/s. These are arithmetic comparisons for this exact bounded
workload, not extrapolations to a larger population.

At 2M serial completions/s, a case would have 500 ns. The fastest observed
file-plus-directory fsync diagnostic took 2.792 ms, about **5,585×** that
window, before Aether, network, witness or sink work. Thus the current
single-worker, separately fsynced per-case pipeline cannot meet the full target
on this machine. This does **not** prove that a parallel or batched design on
different hardware cannot reach it. The sink and witness also serialize
complete decision journals, so a scaled design needs a new measured profile.

The [D21 decision record](../../decisions/D21-living-campaign-throughput-boundary.md)
sets out the unresolved qualification boundary. No threshold was changed and
T3-03/G2 remains **failed**. Full G1 also remains open for cross-machine
partitions, distinct operator custody, native races/actual RSS pressure,
production ProcessHost admission and external-sink failure shrinking. Tracker
status remains **20/62**.

```sh
node --experimental-strip-types roadmap/v4/research/microworld-external/campaign.ts --verify docs/implementation/v4/evidence/t303-pipeline-faf2172
node --experimental-strip-types --test roadmap/v4/research/microworld-external/harness.test.ts
```
