# Integrated v4 checkpoint — `04eafea6d5cf0e0ef8bc6650f92c1e53e9c49948`

The source tree was clean for this checkpoint on `aether/v4-implementation`, specification 0.1.0. This is implementation progress on V4-T3-10, not full v4 or task completion. [SHA-256 manifest](hashes.txt) covers the retained logs, benchmark artifacts and linked raw reports.

| Check | Observed result |
| --- | --- |
| `npm test` (includes build) | Exit 0; **835 tests, 834 pass, one opt-in skip, zero fail**, 322,721 ms. [Full log](full-test.log). |
| `npm run typecheck` | Exit 0. [Log](typecheck.log). |
| `npm run roadmap:check` and `npm run roadmap:v4:check` | Exit 0; 62 tasks and 71 obligations valid. [Roadmap](roadmap-check.log), [v4](roadmap-v4-check.log). |
| Actual C packed bridge | Exit 0; 6 tests cover `/1` mutation, `/2` strings, adversarial frames, and an actual C candidate committed as one authorized runtime event with restore/rewind. [Log](packed-native-tests.log). |
| Source-pinned C bridge verifiers | Both exit 0. Historical `/1`: 768 operations and rebuilt binary. New `/2`: 16 records, 256 string operations, 30 retained process round trips and rebuilt binary. [V1 log](packed-native-v1-verify.log), [V2 log](packed-native-string-verify.log), [V2 raw report](../../../../../roadmap/v4/research/packed-native-bridge/results/local-02-strings.json). |
| Source-pinned native locality verifier | Exit 0; 6 fixtures, 61,440 records, 18 patterns and 378 raw timed samples, exact Git blobs and rebuilt binary. [Log](packed-locality-verify.log), [raw report](../../../../../roadmap/v4/research/packed-native-locality/results/local-01/report.json). |
| `npm run bench:v4:enforce` | Exit 1, correctly: **17 required targets failed or unmeasured**. [Log](bench-enforce.log), [clean-source manifest](benchmark-manifest.json), [samples](benchmark-samples.json). |
| `npm run bench:v4:verify -- .aether-store/benchmarks/v4/latest --exact-source` | Exit 0; `sourceMatches: true`, `releaseEligible: false`, 17 required failures. [Log](bench-verify.log). |

The C bridge now validates and compares bounded UTF-8 strings in `/2` checkpoint images while preserving `/1`. Its 58.4 ms median is a full process round trip, including launch and checkpoint checks, not a guest boot result. A native `/1` mutation passes through `ResumableRuntime.commitPackedCandidate`: the exact current snapshot, layout, row identities and candidate digest are checked, a separate host authorization accepts the subject, and all changed fields enter one reversible event. The candidate image itself never replaces the event-bound checkpoint.

On an Apple M4 Pro, the bounded native locality campaign found **11.9–14.4% less allocation** for packed rows and payload, but **1.40–3.11× slower** medians for a prevalidated extractor and **3.36–9.27× slower** medians for the checked ABI across all patterns. Canonical serialized images were 30.4–30.9% smaller. These are workload wall times, not cache-counter or whole-guest residency results. The fast extractor lacks per-read validation and is not production admitted. V4-T3-10 remains **in progress**, and its G2 and release performance gates remain open.

The tracker remains **20/62 verified**. The full v4 goal and the **17 required release targets** remain open.
