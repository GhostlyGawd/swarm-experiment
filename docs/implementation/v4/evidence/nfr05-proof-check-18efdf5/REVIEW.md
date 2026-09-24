# Exact-source bounded NFR-05 checker preflight at `18efdf5`

Specification v4 `0.1.0`; clean source commit `18efdf5c25416903e7941dd30d63229df4e853ba`. The [versioned profile](../../../../../roadmap/v4/research/proof-check-latency/profile.json) measures one complete 6,778-byte portable AST certificate bundle with seven obligations. Each trial calls `checkPortableCertificate` with independent obligation derivation and all formula proofs. Twenty warmups preceded 200 saved nanosecond [samples](samples.json) on Apple M4 Pro, macOS `25.6.0`, Node `v26.7.0`.

| Statistic | Observed |
| --- | ---: |
| Minimum | 1,716.167 µs |
| Median | 1,790.375 µs |
| 95th percentile | 1,948.708 µs |
| Maximum | 2,095.958 µs |
| Samples above 50 µs | 200 / 200 |

The preregistered hard-maximum verdict is **fail** against the unchanged NFR-05 ≤50 µs bound. The [manifest](manifest.json) binds source imports, profile, certificate, runtime environment and sample arithmetic. [Independent verification](verify.log) rechecks the saved certificate and source, recomputes all statistics and verdict, and compares current hardware identity. Deliberately changing the recorded CPU identity was rejected. [Hashes](hashes.sha256) bind the raw files.

This single scalar-call fixture is a preflight, not a representative release qualification over certificate kinds, sizes, workloads or hardware. The default v4 release inventory still lists NFR-05 as unmeasured. No acceptance threshold or tracker status changes; **20/62** remains verified.
