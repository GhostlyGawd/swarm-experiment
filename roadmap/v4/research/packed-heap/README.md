# Packed heap and candidate native value ABI (V4-T3-10)

This is an isolated implementation and research slice. `src/tier3/packed-heap.ts` defines `aether.packed-heap/1`: bit-packed bounded integers, booleans, and nullable relative record references. Each row retains its logical ID, allocation epoch, version, record type, type layout, and checked bit offset. The payload contains no host pointers. A relative reference resolves through a checked row ordinal to the **target's logical ID and epoch**; the ordinal itself never becomes a durable identity.

The API rejects out-of-range values and references, stale allocation epochs, wrong heap IDs, duplicate IDs/fields, invalid bit offsets, nonzero padding, altered image digests, version mismatches, and narrowing migrations that cannot preserve values. `add` provides trap, wrap, and saturate policies on declared bounded integer fields. A constant-valued integer field consumes zero bits. Images bind layouts and bytes with domain-separated digests; consumers still need a trusted expected digest because those hashes do not authenticate an untrusted publisher.

`packResumableCheckpoint` validates an actual resumable snapshot before packing live records. `unpackResumableCheckpoint` requires a trusted expected logical checkpoint digest and validates the reconstructed checkpoint against its compiled `ResumableProgram`. `migratePackedResumableCheckpoint` repacks through that logical state and preserves its digest. Historical heap versions and event deltas stay in the logical checkpoint spine; this slice does not claim whole-checkpoint compression.

The candidate `abi.h`/`abi.c` implements checked C bit reads/writes, relative ordinal resolution, and 64-bit overflow policies. The host must validate the image, row metadata, and trusted checkpoint before passing byte ranges to these primitives. This C code is **not yet wired into a production native guest**.

## Verification

- `node --test --experimental-strip-types test/tier3/packed-heap.test.ts`: 7/7 pass, including a real `ResumableRuntime` correction, checkpoint round trip, restore, aliases, and 256-row seeded differential mutation. The integration review also rejects extra image/layout/row fields, negative epochs and accessor-backed caller rows before reading them.
- `npm run typecheck`: pass at the time of this research run.
- `node --experimental-strip-types roadmap/v4/research/packed-heap/native-check.ts`: 26/26 C checks compiled with Apple Clang 21 and matched a TypeScript-produced payload. Raw result: `results/native-01.json`.

## Preregistered local measurement

`PREREGISTRATION.md` fixes the comparison and trial count. Raw samples, hashes, hardware, and source pins are in `results/local-01.json`. On Apple M4 Pro, Node 26.7.0:

Campaign 01 was measured before the additional canonical-input hardening described above; its exact `packedHeapSha256` is retained. It is historical bounded evidence until a clean-source repeat measures the hardened implementation.

The clean detached-worktree repeat at commit `8d285d7` is retained in `results/local-02/`. Its registration pins the clean commit, five source hashes and unchanged workload. An independent audit checked those hashes, all four raw-sample medians, equality of the baseline and packed checksums, and the 26 native checks. The repeat measured complete-image ratios of 0.6796/0.6849 for 1,024 local/random records and 0.6795/0.6850 for 4,096 local/random records. The corresponding packed JavaScript read slowdowns were 83.3×, 68.1×, 93.7× and 61.1×. The slow reads and limited value domain remain release blockers.

| Records | Links | Logical record bytes | Packed payload bytes | Complete image bytes | Image / logical | Baseline read median | JS packed read median |
| ---: | :--- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1,024 | local | 362,730 | 1,664 | 246,527 | 0.680 | 0.860 ms | 89.285 ms |
| 1,024 | random | 362,720 | 2,816 | 248,415 | 0.685 | 1.556 ms | 104.779 ms |
| 4,096 | local | 1,457,564 | 6,656 | 990,463 | 0.680 | 0.995 ms | 92.076 ms |
| 4,096 | random | 1,457,532 | 12,288 | 998,365 | 0.685 | 1.773 ms | 107.796 ms |

The complete image includes row metadata, layout, checksums, and base64. Its measured size is about 31–32% below the existing canonical record array. The JavaScript bit-at-a-time reader is roughly 61–104 times slower than the Map baseline for these 100,000-read traversals. These wall times are a local proxy, not CPU cache-miss evidence or native-guest throughput. Neither artifact size nor this benchmark measures guest resident memory.

## Open before T3-10 can be verified

1. Wire the checked C ABI into the actual native lowering and guest checkpoint path, with manifest-bound ABI/layout versions and an exact execution subject.
2. Synthesize layouts from observed value distributions under a declared training/holdout process. These layouts were hand selected.
3. Handle the rest of the runtime value domain (strings, sequences, results, closures, tasks, captures, and historical heap versions) or specify and enforce a complete supported-profile boundary.
4. Measure end-to-end native guest memory, locality, speed, recovery, and state migration with raw target-hardware samples. The current JS reader regresses speed substantially.

These results are candidate evidence for G1 and a bounded G2 experiment; they do not close V4-T3-10 or the 2 MB release gate.
