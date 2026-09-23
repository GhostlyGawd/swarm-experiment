# Integrated v4 checkpoint — `e08040bc5c6a65a001c945a167260adfc275f456`

The source tree was clean before this evidence directory was created. The checks ran against that exact commit on `aether/v4-implementation`, specification 0.1.0. This is an implementation checkpoint, not full v4 completion.

| Check | Result |
| --- | --- |
| `npm test` (includes build) | Exit 0; **814 tests, 813 pass, 1 opt-in skip, 0 fail**; 303,668.545 ms. [Full log](full-test.log). |
| `npm run typecheck` | Exit 0. [Log](typecheck.log). |
| `npm run roadmap:check` and `npm run roadmap:v4:check` | Both exit 0; 62 tasks and 71 obligations valid. [Roadmap](roadmap-check.log), [v4](roadmap-v4-check.log). |
| Opt-in FROST differential | Exit 0; 8 pass, including 200 pinned Rust public transcripts. [Log](frost-differential.log). |
| Ristretto research Rust tests | Exit 0; 8 pass. [Log](ristretto-tests.log). |
| Isolated Wasm source-pinned research verifier | Exit 0; 14 focused tests and six pinned source files verified. [Log](isolated-wasm-verify.log). |
| Real packed HVF guest test and independent evidence replay | Both exit 0; 8 guest runs and 779 field operations verified against exact binaries/source. [Test](packed-hvf-tests.log), [verifier](packed-hvf-verify.log). |
| `npm run bench:v4:enforce` | Exit 1, correctly: **17 required targets failed or unmeasured**. [Manifest](benchmark-manifest.json), [samples](benchmark-samples.json), [log](bench-enforce.log). |
| `npm run bench:v4:verify -- --exact-source` | Exit 0; retained artifacts recomputed, `sourceMatches: true`, `releaseEligible: false`. [Log](bench-verify.log). |

The opt-in [V6 isolated Wasm profile](../../ISOLATED-WASM-PROFILE.md) connects a versioned V3 guest artifact and signed V4 effect policy to real ProcessHost workers and ProcessDeployment. The default remains V5. The full suite exercises exact adapter/capability admission, host-derived router identity, i32/ref rejection before dispatch, current scoped grants, signed promotion and generation-1 reopen, trap reconciliation, authorized safe abort and continued serving. Parent factory behavior, broker storage and clock callback remain trusted; this profile does not prove general effectful adapter isolation or NFR-16.

The [actual EL1 packed guest](../../../../../roadmap/v4/research/packed-hvf-guest/README.md) executed authenticated checkpoint fields in the Hypervisor.framework guest. Its eight retained fresh-guest intervals ranged from **0.417 to 1.993 ms**. The 1 ms maximum was missed, and full runtime/native lowering remains absent. The observed 65,536 resident backing bytes describe this bounded guest allocation, not the complete runtime's 2 MB gate.

The tracker remains **20/62 verified** and the release benchmark has **17 open required targets**. SHA-256 digests of the retained integration artifacts are in [hashes.json](hashes.json).
