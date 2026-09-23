# Native packed-record locality research

This bounded V4-T3-10/G2 experiment executes real C reads over `PackedHeap.pack` `/1` payloads and compares them with native logical rows representing the same records. The [preregistration](PREREGISTRATION.md) fixes the distributions, access patterns, trial counts and reporting before collection. `native.c` validates every packed integer, Boolean, reference, target logical ID and target epoch before any timed run. The independent `verify.ts` parses the retained fixtures, regenerates logical records and the actual packed images, recalculates all 18 expected traversal checksums and all statistics, and checks the pinned source hashes.

Run from the repository root:

```sh
node --experimental-strip-types roadmap/v4/research/packed-native-locality/run.ts roadmap/v4/research/packed-native-locality/results/local-01
node --experimental-strip-types roadmap/v4/research/packed-native-locality/verify.ts roadmap/v4/research/packed-native-locality/results/local-01/report.json
```

The campaign retains binary logical-plus-packed fixtures and raw samples in `results/local-01/`. The report includes the compiler and hardware identity, source and fixture SHA-256 values, allocation and canonical serialization byte counts, per-trial checksums and nanoseconds, medians, maxima, and ratios. A corrupted packed fixture is rejected by the C driver before timing; the verifier rejects altered summary statistics.

## Measured result, Apple M4 Pro

The final report pins source commit `bc68d5592850c9012f2dfd0c33504e11c38a68a3` and rebuilt native executable SHA-256 `d3c339731b1a735d159d21b56ecf9695a1665056a3688c4df81889ffb11b771a`. The independent verifier accepted all six retained fixtures (61,440 logical rows), 18 pattern checksums and 378 raw timed samples. It recalculated every median, maximum and ratio and matched the rebuilt executable. An altered reported median was rejected; changing a payload bit caused the C driver to reject the fixture before timing.

| Records | Links | Native logical allocation | Native packed allocation | Packed reduction | Canonical image reduction | Checked ABI median slowdown | Validated extractor median slowdown |
| ---: | :--- | ---: | ---: | ---: | ---: | ---: | ---: |
| 4,096 | local | 163,840 B | 140,288 B | 14.4% | 30.9% | 3.36–5.97× | 1.66–2.62× |
| 4,096 | cluster | 163,840 B | 140,288 B | 14.4% | 30.9% | 5.49–6.10× | 1.51–2.67× |
| 4,096 | wide | 163,840 B | 143,360 B | 12.5% | 30.6% | 4.28–8.66× | 1.66–2.55× |
| 16,384 | local | 655,360 B | 561,152 B | 14.4% | 30.8% | 3.74–6.76× | 1.65–2.96× |
| 16,384 | cluster | 655,360 B | 561,152 B | 14.4% | 30.7% | 5.26–7.07× | 1.40–3.11× |
| 16,384 | wide | 655,360 B | 577,536 B | 11.9% | 30.4% | 4.63–9.27× | 2.00–2.72× |

Each slowdown range spans scan, scatter and chase. Every range is slower than the pointer baseline. The largest individual 100,000-read trial was 2.520 ms for the checked ABI and 0.851 ms for the validated extractor; the pointer baseline's largest was 0.475 ms. All individual maxima, medians and seven samples for every arm/pattern are in the raw report. The cluster fixtures retain 64 and 256 multiply referenced target rows; the wide fixtures retain 1,067 and 4,310. Every native packed reference resolved to the intended logical ID and epoch.

The three read arms distinguish native pointer traversal, the checked C packed ABI, and a faster packed extractor after whole-fixture prevalidation. The latter is a research candidate; it lacks per-read checks and production admission. The shared chase loop converts the baseline's target pointer back to an ordinal every step; that adds work to the pointer baseline and may make the packed slowdowns conservative. Both representations coexist in the timed process, so its working set is larger than either reported per-representation allocation. Timing is only a wall-clock proxy for locality. This experiment has no hardware cache-miss counter, whole-process resident-set measurement, native guest, durable checkpoint restoration, full runtime value domain, or release-profile workload. It does not close V4-T3-10/G2 or any v4 release memory/latency target.
