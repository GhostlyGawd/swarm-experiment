# Packed checkpoint to native process bridge (V4-T3-10 candidate)

This research path takes real `aether.packed-resumable-checkpoint/1` and `/2` images through an actual compiled C executable. The TypeScript host validates the checkpoint against a trusted snapshot digest, program, and layout digest. It also pins the exact native executable SHA-256 before sending the bit-packed payload and logical row IDs/epochs. The executable performs bounded integer reads/adds, boolean reads, nullable relative-reference reads, and reference rewrites directly in the packed bytes through `abi.c`. For `/2`, it also reads and compares UTF-8 string values from a bounded dictionary. The host compares every native observation and the final bytes against the TypeScript `PackedHeap` model, then reconstructs and validates the returned heap image from the native bytes.

The current bridge re-exports the frame/parser implementation in `src/tier4/packed-native-process.ts`. Its `PackedNativeProcessRunner` reads and hashes binary bytes through one file descriptor, runs a private copy of those bytes, and returns a private run proof used by ProcessHost packed control V2. The retained `/1` and `/2` research campaigns still rerun from their original pinned commits. Native code remains unsandboxed and the proof is in-process, not hardware attestation.

This is **native process execution, not an Apple Hypervisor.framework guest**. The returned `candidateHeap` is not a committed resumable checkpoint: changing record values outside the runtime's host correction/event path would break the checkpoint's event chain. One test applies equivalent `ResumableRuntime.correctRecord` calls and compares their committed packed bytes. A second test passes actual C-mutated `/1` bytes through `ResumableRuntime.commitPackedCandidate` after candidate-specific authorization, then restores and rewinds the single correction event. The bridge does not claim native compiler lowering, a production guest checkpoint path, all machine value types, or any release performance gate.

## Bounded profile and trust boundary

- Validated input checkpoint, trusted expected snapshot/layout digests, and exact executable hash are required. The original wire frame `AEPBR001` and result `/1` remain unchanged for non-string heaps. String heaps use `AEPBR002` and result `/2`: the header adds dictionary-entry and UTF-8 arena byte counts; after the row table, the frame carries contiguous offset/length entries and hex arena bytes. `T` reads the exact UTF-8 bytes, returning lowercase hex or `-` for empty; `E` compares two string fields by bytes. It does not change the durable packed checkpoint format.
- At most 1,024 rows, 65,536 packed bytes, 4,096 operations, 2 MiB input, 4 MiB output, and 5 seconds of native execution. Logical ID/epoch decimal tokens are at most 127 characters; bounded integer values and increments fit signed 64-bit.
- For `/2`, at most 4,096 dictionary entries and 65,536 UTF-8 arena bytes enter this native profile. Each entry is at most 4,096 bytes. The C process checks contiguous dictionary offsets, total arena length, duplicate byte strings, canonical scalar UTF-8 (including overlong encodings, surrogates, truncation, and out-of-range code points), 12-bit dictionary indexes, and the per-field byte bound before reading or comparing. It also checks row continuity, IDs, padding, command ranges, field bounds, relative-reference distance, and target identity/epoch before mutation. The trusted host does the full layout, program, and historical event validation. The host model acts as a differential oracle; this is not independent proof of the model's semantics.
- This executable has ordinary host process authority. A matching SHA-256 establishes exact binary identity, not isolation from a malicious binary. It is currently test/research code only.

## Reproduce

```sh
node --test --experimental-strip-types roadmap/v4/research/packed-native-bridge/bridge.test.ts
node --test --experimental-strip-types roadmap/v4/research/packed-native-bridge/bridge-strings.test.ts
npm run typecheck
node --experimental-strip-types roadmap/v4/research/packed-native-bridge/verify-evidence.ts
node --experimental-strip-types roadmap/v4/research/packed-native-bridge/verify-string-evidence.ts
```

The `/1` tests compile the C executable with `cc -std=c11 -O2 -Wall -Wextra -Werror`, move an authenticated 3-record checkpoint into the native process, check alias reads, a trapped overflow, an integer mutation, a reference rewrite, and rejection of changed binary or malformed frames. They prove that candidate bytes require host authorization and event reconciliation before checkpoint use. The fixed-seed xorshift32 campaign `0x62d8a441` crosses six combinations: 16 records and 128 operations each, local (`maxRelative=1`) and wide (`maxRelative=15`) links crossed with trap, wrap, and saturate arithmetic. Total: 768 native operations and exact differential checks. `results/local-01.json` retains every operation and observed line, image digests, binary hash, source file hashes, compiler, and host profile. It pins source commit `3ddd99bf6fab73ae7c28655699a225114c0c28dd`. `verify-evidence.ts` checks those exact Git blobs, checks out that historical commit in a temporary worktree, reruns its 768 cases, and compares raw results and executable hash. The file was generated with:

```sh
AETHER_PACKED_NATIVE_EVIDENCE=roadmap/v4/research/packed-native-bridge/results/local-01.json \
  node --test --experimental-strip-types roadmap/v4/research/packed-native-bridge/bridge.test.ts
```

The `/2` tests use an authenticated resumable checkpoint with empty, ASCII, accented, composed/decomposed, emoji, CJK, and BOM-prefixed strings. They compare native reads and equality to the `PackedHeap` oracle, check mixed integer/reference fields, and confirm native integer mutation leaves the string arena unchanged while still requiring a host event before checkpoint commit. Direct parser tests reject bad offsets, duplicate entries, invalid UTF-8, missing indexes, out-of-row fields, and `/2` commands in a `/1` frame. A fixed-seed campaign uses 16 records and 256 string reads/equality checks; `results/local-02-strings.json` retains every operation and observation plus 30 raw process round-trip latency samples. It pins source commit `9fbc4a50b2015dfbcaaf33f3a582648d12dab8b6`. The observed process round-trip median was 58,387,104 ns and maximum 80,810,125 ns on the recorded host. These samples include checkpoint validation, framing, process launch, native work, and host comparison, so they are **not guest boot latency** or a release benchmark. `verify-string-evidence.ts` checks exact Git source blobs, recompiles, reruns the deterministic campaign, and checks every observation. The report is generated with:

```sh
AETHER_PACKED_NATIVE_STRING_EVIDENCE=roadmap/v4/research/packed-native-bridge/results/local-02-strings.json \
  node --test --experimental-strip-types roadmap/v4/research/packed-native-bridge/bridge-strings.test.ts
```

## Open before V4-T3-10

1. Put the authenticated packed image and checked C ABI in the actual lowered native guest/checkpoint path, with manifest-bound ABI/layout version and executable identity.
2. Integrate candidate-specific correction into durable ProcessHost/guest publication with crash recovery. The bounded `/1` local `commitPackedCandidate` test proves one authorized, replayable runtime event, but does not yet provide distributed or production publication.
3. Support the declared production value domain, including historical heaps, composites, closures and tasks, or establish a complete narrower profile and reject everything else. This `/2` bridge only adds bounded string reads/equality; it does not implement native string mutation or garbage collection.
4. Measure full native guest locality, resident memory, throughput, migration, and recovery on the qualified target hardware. The current JS packed reader is much slower than the baseline; this bridge makes no speed claim.
