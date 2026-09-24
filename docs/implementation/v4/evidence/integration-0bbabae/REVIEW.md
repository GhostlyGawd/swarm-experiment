# Snapshot-fed native fallback and signed crash checkpoint

Exact tested source: `0bbabaefb5d59f07258b99f07160a5d156a3f21b`, specification 0.1.0. The worktree was clean during the full suite, exact-source release benchmark and local clock probe. These evidence files were added afterward.

| Check | Result | Evidence |
| --- | --- | --- |
| `npm test` | 977 tests: 976 pass, 0 fail, 1 existing opt-in skip | [full suite](full-test.log) |
| Focused signed-sink fallback | 4/4 pass, including controller SIGKILL and fresh-controller replay | [full suite](full-test.log) |
| Focused native fallback | 3/3 pass, including 14 snapshot-fed differential cases | [full suite](full-test.log) |
| Build, typecheck and both roadmap checks | pass; 62 tasks and 71 obligations valid | [build](build.log), [typecheck](typecheck.log), [v4 roadmap](roadmap-v4.log), [roadmap](roadmap.log) |
| `bench:v4:measure` and exact-source verification | raw samples and source hashes verify; release eligible **false** | [measure](bench-measure.log), [verify](bench-verify.log), [manifest](bench/manifest.json), [samples](bench/samples.json) |
| `bench:v4:enforce` | expected exit 1; 17 required targets failed or unmeasured | [enforcement](bench-enforce.log) |
| Local clock-resolution probe | 100,000 adjacent-read pairs per clock; resolution evidence only | [metadata](clock-probe-meta.json), [histograms](clock-probe.jsonl), [source](../../../../../roadmap/v4/research/native-fallback-ast/clock-probe.c) |

The [controller crash test](../../../../../test/tier4/process-fallback-attested-sink.test.ts) kills a separate controller after a signed sink commit is independently witnessed but before the supervisor publishes its terminal result. A fresh controller reopens the same signed V8 host, portable Tier 2 proof and fallback journal, returns the exact Tier 1 value, and observes one sink decision with no Tier 2 host operation. The sink and witness are separate processes under one UID; this is still a fixture, not proof of a third-party irreversible transaction or distinct-UID custody.

The native driver now accepts a validated projection of an actual RuntimeSnapshotV1. The projection binds the execution manifest, object IDs, reference heap/epochs, aliases, field values and available allocation slot. The research runner hashes the executable and runs a private byte copy. Fourteen snapshot-fed outcomes match the reference fallback; stale refs, malformed frames, insufficient capacity and substituted executable bytes are refused. This path is not yet admitted through ProcessHost, does not cover full values or effects, and does not bind a portable Tier 2 proof to the native artifact.

The [clock probe](clock-probe-meta.json) reported Mach timebase 125/3 ns per tick. The nanosecond clocks and ordered virtual counter also showed predominant 41/42-unit updates after zero deltas, despite the virtual counter's nominal 1 GHz frequency. The probe samples clock reads, **not** fallback switches. The earlier one-tick observed switch maximum can conceal an elapsed interval approaching two ticks, so it cannot establish FR-3.7's hard **≤50 ns** maximum. The earlier full-call diagnostic observed 83.333 ns. A finer controlled timing source and scheduling qualification are still needed.

The unchanged complete warm-message fixture measures **1.861×** compression against the 4× target. Seventeen required release targets fail or are unmeasured. T3-07/G1/G2, FR-3.7 and the full v4 release remain open; the tracker stays **20/62 verified**. SHA-256 digests for retained artifacts are in [hashes.json](hashes.json).
