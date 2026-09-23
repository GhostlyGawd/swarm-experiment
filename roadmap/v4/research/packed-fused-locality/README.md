# Checked fused packed-row research

This V4-T3-10/G2 experiment measures a checked C reader for the bounded `{int 0..1000, bool, relative ref}` `/1` row. `ae_packed_read_bounded_row` assembles one 18- or 26-bit row from at most five bytes, then checks the integer range and relative reference. Its output stays unchanged on an error. The existing ABI functions remain available.

The [preregistration](PREREGISTRATION.md) fixed six actual packed fixtures, four arms, three traversal patterns, warmups and sample counts before final measurement. All six generated fixtures matched the preceding [native locality campaign](../packed-native-locality/README.md) byte for byte. The native driver checked all 61,440 rows against logical records and matched baseline checksums in preflight, warmups and every trial. An adversarial executable compared 192,192 valid aligned/unaligned rows with the old checked ABI, exhausted 1,052,672 reference-code combinations, and checked 13 malformed cases. The [independent verifier](verify.ts) confirmed source and binary hashes, fixture bytes and mappings, 18 expected traversal checksums and 504 raw timed samples. Changing a retained fused median caused it to reject the report.

Run from the repository root:

```sh
node --experimental-strip-types roadmap/v4/research/packed-fused-locality/run.ts roadmap/v4/research/packed-fused-locality/results/local-02
node --experimental-strip-types roadmap/v4/research/packed-fused-locality/verify-historical.ts roadmap/v4/research/packed-fused-locality/results/local-02/report.json
```

The historical wrapper checks out the report's pinned source and runs its original verifier, preserving the measured C binary after later runtime changes.

## Apple M4 Pro result

The [raw report](results/local-02/report.json) pins exact source commit `b6b80c5a757039883fc489e22792727ae8b751f8`, native executable SHA-256 `2aa9d18d8ad0acab9a9b059c298e94513ff38220a74bd7fec6964a8537314654` and adversarial executable SHA-256 `60dfc9605a1c5d5eb6416ce8250ac8b7d371b60340e19042e90082ba352a7b72`. Each range below spans scan, scatter and chase medians of seven 100,000-read trials.

| Rows | Links | Fused time / pointer baseline | Fused speedup / old checked ABI |
| ---: | :--- | ---: | ---: |
| 4,096 | local | 0.90–2.08× | 2.81–3.58× |
| 4,096 | cluster | 1.59–2.14× | 2.79–3.39× |
| 4,096 | wide | 2.26–4.34× | 1.92–3.12× |
| 16,384 | local | 0.89–2.31× | 2.93–3.58× |
| 16,384 | cluster | 1.48–2.31× | 2.92–3.62× |
| 16,384 | wide | 2.20–4.33× | 2.08–2.55× |

The fused reader is faster than the prior checked ABI in all 18 patterns, but remains slower than the native pointer baseline in 16. The largest individual 100,000-read fused trial took 1.186 ms; this is a whole-trial time, not a per-read or guest-startup time. Packed allocation is unchanged from the prior campaign (11.9–14.4% below the pointer representation in these fixtures). Both representations coexist in the benchmark process. These wall times are only a locality proxy; there are no cache-miss counters, whole-process residency measures, native guest measurements, 100M-node workloads or release-profile evidence. The experiment does not close V4-T3-10/G2 or any v4 release gate.
