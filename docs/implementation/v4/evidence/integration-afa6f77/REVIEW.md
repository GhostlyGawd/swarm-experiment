# Integrated v4 checkpoint — `afa6f77b045206ecd3bb9b49b50794ac3d595743`

The source tree was clean before this evidence directory was created. All checks ran against that exact commit on `aether/v4-implementation`. This checkpoint does not complete v4.

| Check | Result |
| --- | --- |
| `npm test` (includes build) | Exit 0; **801 tests, 800 pass, 1 opt-in skip, 0 fail**; 317,309.971 ms. [Full log](full-test.log). |
| `npm run typecheck` | Exit 0. [Log](typecheck.log). |
| `npm run roadmap:check` and `npm run roadmap:v4:check` | Both exit 0; 62 tasks and 71 obligations valid. [Roadmap](roadmap-check.log), [v4](roadmap-v4-check.log). |
| Opt-in FROST differential | Exit 0; 8 pass, including 200 pinned Rust public transcripts. [Log](frost-differential.log). |
| Ristretto research Rust tests | Exit 0; 8 pass. [Log](ristretto-tests.log). |
| Native fallback differential and packed C checks | Both exit 0; 12/12 actual fallback cases and 26/26 packed ABI checks. [Fallback](native-switch-verify.log), [packed](packed-native-check.log). |
| `npm run bench:v4:enforce` | Exit 1, correctly: **17 required targets failed or unmeasured**. [Manifest](benchmark-manifest.json), [samples](benchmark-samples.json), [log](bench-enforce.log). |
| `npm run bench:v4:verify -- --exact-source` | Exit 0; canonical artifacts recomputed, `sourceMatches: true`, `releaseEligible: false`. [Log](bench-verify.log). |

The new [ProcessFallbackSupervisor](../../../../../roadmap/v4/research/process-fallback/README.md) is opt-in and returns `productionAuthorized: false`. Fourteen focused tests in the full suite use actual ProcessHost workers and a durable effect sink. Two added SIGKILL cases bracket the external-dispatch decision: death before dispatch can be safely aborted, while death inside the sink blocks Tier 2 and retains one sink call. The full independent Tier 2 proof and 50 ns maximum remain open; the bounded native switch itself measured an 83.333 ns maximum miss.

The [packed heap repeat](../../../../../roadmap/v4/research/packed-heap/README.md) is a separate clean-source research campaign at `8d285d7`. Complete images are about 31–32% smaller for its bounded record layouts; the JavaScript traversal is 61–94× slower. The native guest, full value domain, locality and 2 MB residency gates remain open.

The tracker remains **20/62 verified**. The benchmark has **17 open required targets**. SHA-256 digests of all retained integration artifacts are in [hashes.json](hashes.json).
