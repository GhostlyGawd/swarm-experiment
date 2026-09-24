# Bounded NFR-05 portable-certificate check preflight

Specification v4 `0.1.0`. The timing source was clean commit `5ce344737c2bc350dc5ed6d49cbbd66852d54dce` on Apple M4 Pro, macOS `25.6.0`, Node `v26.7.0`. The versioned [profile](../../../../../roadmap/v4/research/proof-check-latency/profile.json) selects one 6,778-byte portable AST certificate with seven obligations. Each measured operation is a complete `checkPortableCertificate` call, including independent obligation derivation and all formula proofs. There were 20 warmups and 200 raw nanosecond [samples](samples.json).

| Statistic | Observed |
| --- | ---: |
| Minimum | 1,738.459 µs |
| Median | 1,903.583 µs |
| 95th percentile | 2,088.542 µs |
| Maximum | 2,203.166 µs |
| Samples above 50 µs | 200 / 200 |

The preregistered hard-maximum verdict is **fail** against NFR-05's unchanged ≤50 µs per certificate. [Manifest](manifest.json) binds the source import closure, profile, certificate digest, environment and sample arithmetic. [Independent verification](verify.log) checks the saved certificate against a rebuilt exact fixture and recomputes the statistics/verdict; a changed verdict is rejected. [Hashes](hashes.sha256) bind the raw artifacts.

This is one bounded scalar-call fixture on one machine. It does not qualify all certificate kinds or hardware, and it is not a release-profile NFR-05 result. The current default release inventory therefore still records NFR-05 as unmeasured. No threshold or task status changes; the tracker remains **20/62**.
