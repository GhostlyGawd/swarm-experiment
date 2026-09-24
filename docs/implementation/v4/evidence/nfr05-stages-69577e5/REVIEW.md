# Exact-source portable proof checker stage profile

Specification v4 `0.1.0`; clean source `69577e5cd239df752a56c6361ccfe9c69c2f2a02`. The versioned [stage profile](../../../../../roadmap/v4/research/proof-check-latency/stage-profile.json) times the seven-obligation portable AST fixture on Apple M4 Pro, macOS `25.6.0`, Node `v26.7.0`. Each stage has 10 warmups and 100 saved nanosecond [samples](stage-samples.json). [Independent verification](verify.log) checks current source/import hashes, hardware identity, the actual certificate, and every saved statistic. A changed derivation median was rejected. [Hashes](hashes.sha256) bind the raw artifacts.

| Stage | Median | 95th percentile |
| --- | ---: | ---: |
| Full `checkPortableCertificate` | 1,988.667 µs | 2,473.083 µs |
| Independent AST obligation derivation | 961.458 µs | 1,100.875 µs |
| Formula proof checks | 453.375 µs | 599.666 µs |
| Obligation-set digest | 202.958 µs | 280.750 µs |
| Certificate digest | 124.833 µs | 174.917 µs |
| Canonical encoding | 54.416 µs | 76.000 µs |
| Execution manifest digest | 31.791 µs | 39.375 µs |

The stages overlap, run in separate loops, and must **not** be summed as a full-call model. The raw profile identifies independent derivation and formula checking as the largest measured components. Even the formula-check stage alone is far above the unchanged 50 µs *whole-certificate* target on this fixture. This is diagnostic research, not a release NFR-05 verdict or evidence across certificate kinds and hardware. The default v4 release inventory still records NFR-05 as unmeasured and the tracker remains **20/62**.
