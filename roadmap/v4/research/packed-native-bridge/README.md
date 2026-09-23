# Packed checkpoint to native process bridge (V4-T3-10 candidate)

This research path takes a real `aether.packed-resumable-checkpoint/1` through an actual compiled C executable. The TypeScript host validates the checkpoint against a trusted snapshot digest, program, and layout digest. It also pins the exact native executable SHA-256 before sending the bit-packed payload and logical row IDs/epochs. The executable performs bounded integer reads/adds, boolean reads, nullable relative-reference reads, and reference rewrites directly in the packed bytes through `abi.c`. The host compares every native observation and the final bytes against the TypeScript `PackedHeap` model, then reconstructs and validates the returned heap image from the native bytes.

This is **native process execution, not an Apple Hypervisor.framework guest**. The returned `candidateHeap` is not a committed resumable checkpoint: changing record values outside the runtime's host correction/event path would break the checkpoint's event chain. The test applies equivalent `ResumableRuntime.correctRecord` calls and compares their committed packed bytes. The bridge does not claim native compiler lowering, a production guest checkpoint path, all machine value types, or any release performance gate.

## Bounded profile and trust boundary

- Validated input checkpoint, trusted expected snapshot/layout digests, and exact executable hash are required. The wire frame is `AEPBR001` text followed by hex bytes, logical IDs/epochs, checked row spans, and host-derived field offsets. It does not change the durable packed checkpoint format.
- At most 1,024 rows, 65,536 packed bytes, 4,096 operations, 2 MiB input, 4 MiB output, and 5 seconds of native execution. Logical ID/epoch decimal tokens are at most 127 characters; bounded integer values and increments fit signed 64-bit.
- The C process checks row continuity, IDs, padding, command ranges, field bounds, relative-reference distance, and target identity/epoch before mutation. The trusted host does the full layout, program, and historical event validation. The host model acts as a differential oracle; this is not independent proof of the model's semantics.
- This executable has ordinary host process authority. A matching SHA-256 establishes exact binary identity, not isolation from a malicious binary. It is currently test/research code only.

## Reproduce

```sh
node --test --experimental-strip-types roadmap/v4/research/packed-native-bridge/bridge.test.ts
npm run typecheck
```

The first test compiles the C executable with `cc -std=c11 -O2 -Wall -Wextra -Werror`, moves an authenticated 3-record checkpoint into the native process, checks alias reads, a trapped overflow, an integer mutation, a reference rewrite, and rejection of changed binary or malformed frames. It proves the resulting heap image cannot simply replace the event-bound checkpoint. The second test runs a preregistered xorshift32 seed `0x62d8a441` over six combinations: 16 records and 128 operations each, local (`maxRelative=1`) and wide (`maxRelative=15`) links crossed with trap, wrap, and saturate arithmetic. Total: 768 native operations and exact differential checks. `results/local-01.json` retains every operation and observed line, image digests, binary hash, source file hashes, compiler, and host profile. The file was generated with:

```sh
AETHER_PACKED_NATIVE_EVIDENCE=roadmap/v4/research/packed-native-bridge/results/local-01.json \
  node --test --experimental-strip-types roadmap/v4/research/packed-native-bridge/bridge.test.ts
```

## Open before V4-T3-10

1. Put the authenticated packed image and checked C ABI in the actual lowered native guest/checkpoint path, with manifest-bound ABI/layout version and executable identity.
2. Reconcile native mutations through the durable runtime event and authorization protocol; do not publish a candidate heap as a checkpoint.
3. Support the declared production value domain, including historical heaps, composites, closures and tasks, or establish a complete narrower profile and reject everything else.
4. Measure full native guest locality, resident memory, throughput, migration, and recovery on the qualified target hardware. The current JS packed reader is much slower than the baseline; this bridge makes no speed claim.
