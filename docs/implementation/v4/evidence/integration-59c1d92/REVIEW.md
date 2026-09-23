# Integrated v4 checkpoint — `59c1d92d3646f49053b0ae8b5b5914bbc18904ad`

The source tree was clean before this evidence directory was created. Checks ran against that exact commit on `aether/v4-implementation`, specification 0.1.0. This is a bounded implementation checkpoint, not full v4 completion.

| Check | Result |
| --- | --- |
| `npm test` (includes build) | Exit 0; **826 tests, 825 pass, 1 opt-in skip, 0 fail**; 310,506.400 ms. [Full log](full-test.log). |
| `npm run typecheck` | Exit 0. [Log](typecheck.log). |
| `npm run roadmap:check` and `npm run roadmap:v4:check` | Both exit 0; 62 tasks and 71 obligations valid. [Roadmap](roadmap-check.log), [v4](roadmap-v4-check.log). |
| Opt-in FROST differential | Exit 0; 8 pass, including 200 pinned Rust public transcripts. [Log](frost-differential.log). |
| Ristretto research Rust tests | Exit 0; 8 pass. [Log](ristretto-tests.log). |
| V7 projection campaign 12 independent audit | Exit 0; 33 messages, 9 dependency messages, 27 source snapshots and both real tokenizer totals verified. [Log](projection-verify.log). |
| Packed heap `/2` string-size repeat | Exit 0; source hashes and all three deterministic full-image ratios match the retained experiment. [Repeat](packed-strings-repeat.json), [audit](packed-strings-verify.log). |
| Authenticated packed HVF guest campaign verifier | Exit 0; source/binary hashes and 1,000 raw fresh-guest samples verified, plus semantic replay. [Log](packed-hvf-campaign-verify.log). |
| Current packed guest and native bridge focused tests | Both exit 0; 1 real EL1 guest test and 2 native bridge tests. [Guest](packed-hvf-tests.log), [bridge](packed-native-tests.log). |
| Isolated Wasm source-pinned verifier | Exit 0; 14 targeted tests and six pinned source files verified. [Log](isolated-wasm-verify.log). |
| `npm run bench:v4:enforce` | Exit 1, correctly: **17 required targets failed or unmeasured**. [Manifest](benchmark-manifest.json), [samples](benchmark-samples.json), [log](bench-enforce.log). |
| `npm run bench:v4:verify -- --exact-source` | Exit 0; artifacts recomputed, `sourceMatches: true`, `releaseEligible: false`. [Log](bench-verify.log). |

V7 [generic continuation projections](../../../../../roadmap/v4/research/projections/README.md) execute bounded generic Lambda/Spawn programs in TypeScript, Python and Rust; Rust retains the type witness after factory return. Campaign 12 measured cold legacy:AE2 token ratios of **0.492× cl100k** and **0.498× o200k**, both below the unchanged 4× goal. V4-T1-02 remains in progress.

The packed heap [string V2 image](../../../../../roadmap/v4/research/packed-heap-strings/README.md) preserves V1 bytes and supports bounded UTF-8 dictionary fields and logical checkpoint migration. The complete-image ratios in its three local deterministic cases are 0.680, 0.686 and 0.790. Current native guests explicitly reject string V2 images. The [persistent-controller EL1 campaign](../../../../../roadmap/v4/research/packed-hvf-guest/campaign/README.md) created 1,000 fresh bounded guests, with a **181.125 µs maximum** from allocation to validated response and 65,536 B observed backing per sample. This meets the unchanged 1 ms maximum for that preregistered research workload. It does not include full runtime/native lowering or peak hypervisor guest residency, so V4-NFR-06/T4-05 remain open.

The new [semantic GC V2 profile](../../../../../roadmap/v4/research/semantic-gc-call-shims/README.md) proves closed, total helper-bearing scalar shims before signed promotion and rollback. It rejects partial argument evaluation that expansion could erase. General semantic GC remains open.

The tracker remains **20/62 verified**. The benchmark retains **17 open required targets**. SHA-256 digests of every retained integration artifact are in [hashes.json](hashes.json).
