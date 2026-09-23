# Integrated v4 checkpoint — `fed7657096c836933fc68bb3fc2c32b32c6444b2`

The source tree was clean before this evidence directory was created. All checks ran against that exact commit on `aether/v4-implementation`. This is an implementation checkpoint, not v4 completion.

| Check | Result |
| --- | --- |
| `npm test` (includes build) | Exit 0; **803 tests, 802 pass, 1 opt-in skip, 0 fail**; 317,624.528 ms. [Full log](full-test.log). |
| `npm run typecheck` | Exit 0. [Log](typecheck.log). |
| `npm run roadmap:check` and `npm run roadmap:v4:check` | Both exit 0; 62 tasks and 71 obligations valid. [Roadmap](roadmap-check.log), [v4](roadmap-v4-check.log). |
| Opt-in FROST differential | Exit 0; 8 pass, including 200 pinned Rust public transcripts. [Log](frost-differential.log). |
| Ristretto research Rust tests | Exit 0; 8 pass. [Log](ristretto-tests.log). |
| Packed native bridge focused tests | Exit 0; 2 pass, including 768 seeded differential operations. [Log](packed-native-tests.log). |
| Independent packed native evidence replay | Exit 0; 7 source pins, exact binary hash, 6 campaigns/768 operations and raw rerun match. [Log](packed-native-verify.log). |
| `npm run bench:v4:enforce` | Exit 1, correctly: **17 required targets failed or unmeasured**. [Manifest](benchmark-manifest.json), [samples](benchmark-samples.json), [log](bench-enforce.log). |
| `npm run bench:v4:verify -- --exact-source` | Exit 0; retained artifacts recomputed, `sourceMatches: true`, `releaseEligible: false`. [Log](bench-verify.log). |

The new optional [conservative fallback proof](../../../../../roadmap/v4/research/fallback/README.md) checks a portable certificate for the exact executed scalar Tier 2 declaration under the full manifest context. Its tests reject edited code, changed context, missing obligations, an empty postcondition, and reopening a proved journal without its proof. It does not prove the record, effectful or native fallback paths or qualify the 50 ns switch.

The [native packed bridge](../../../../../roadmap/v4/research/packed-native-bridge/README.md) sends an authenticated resumable checkpoint into a bounded C process and differentially checks the returned bytes. Candidate mutations require authorized durable runtime corrections before checkpoint publication. This is not the hypervisor guest or full T3-10 native lowering.

The tracker remains **20/62 verified** and the release benchmark has **17 open required targets**. SHA-256 digests of all retained artifacts are in [hashes.json](hashes.json).
