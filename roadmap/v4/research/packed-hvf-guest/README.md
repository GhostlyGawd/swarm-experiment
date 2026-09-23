# Packed checkpoint through a real HVF guest (V4-T3-10 / V4-T4-05 research)

This path takes an actual `aether.packed-resumable-checkpoint/1` through an Apple Hypervisor.framework EL1 guest on an M4 Pro. `bridge.ts` validates the original checkpoint against the trusted program, logical snapshot digest, and layout digest, then pins the signed controller and guest image SHA-256. It derives a binary frame of row bit spans and operations. The freestanding guest independently checks the frame and executes bounded integer reads and trap-policy adds, boolean reads, and relative-reference code reads directly on the packed bytes. The host compares the entire returned frame against the `PackedHeap` model and validates the candidate heap image again. The controller refuses abnormal exits or malformed guest frames.

This is an **actual guest execution path**, distinct from the ordinary host C process in `packed-native-bridge`. It is a bounded research path, not a production runtime or a checkpoint commit. The candidate heap cannot replace the original event-bound checkpoint until the runtime authorizes and journals equivalent corrections. The test makes that distinction concrete by comparing a host-corrected committed checkpoint with guest candidate bytes.

## Frame and bounds

- Version 1 `AEPG` little-endian frame: 48-byte header, 8-byte row spans, 40-byte operations, 16-byte results, and packed image bytes. `DONE` is written only by the guest. The controller maps one RX code page, two RW frame pages, and one RW stack page. Guest virtual/physical base is `0x40000000` with the MMU off.
- At most 1,024 rows, 256 operations, 16,384 packed bytes, and 32,768 frame bytes. Only signed 64-bit bounded integer fields are accepted for integer operations. Guest writes support the `trap` overflow policy; all overflow cases leave the bytes unchanged. The existing `PackedHeap` validator authenticates logical ID/epoch and relative references before execution; the EL1 code bounds its row spans and field accesses, while the host checks the exact returned bytes and decoded aliases.
- A synchronous guest exception enters a fixed EL1 vector table and reports original ESR/FAR/ELR through HVC. The controller accepts only the expected HVC, zero guest status, and `DONE` marker. `spawnSync` limits the controller to 5 seconds and kills it on timeout. A test forces a nonterminating guest and checks the timeout path.
- The measured guest interval begins inside an already-running controller just before fresh guest memory allocation, image copy, VM/vCPU creation, and mapping. It ends after HVC and response validation. The diagnostic also retains main-to-response and `hv_vcpu_run`-to-response intervals, plus a separate process-launch-to-exit wall interval. `mincore` observes resident host backing pages for the guest allocation; mapped bytes are a bound on that allocation, not a full hypervisor memory accounting.

## Reproduce

```sh
node --test --experimental-strip-types roadmap/v4/research/packed-hvf-guest/bridge.test.ts
node --experimental-strip-types roadmap/v4/research/packed-hvf-guest/verify-evidence.ts
npm run typecheck
```

The test compiles and signs a dedicated controller, links a freestanding AArch64 guest, and checks a real resumable checkpoint with aliases, trapped and successful mutations, and a separately committed host correction. It also runs six seeded 128-operation differential campaigns over local and wide aliases, signed 64-bit edge arithmetic, executable and image tampering, an invalid frame that reaches EL1, and a deliberately hung guest. `results/local-01.json` retains each operation, observation, exact source SHA-256, binary SHA-256, raw timing ticks, guest memory diagnostics, and environment. `verify-evidence.ts` checks source bytes against the pinned Git commit, validates timing arithmetic, rebuilds the exact binaries, and reruns all semantic cases. The evidence has finite scope and must be regenerated after any source change.

The first retained M4 Pro campaign pins source commit `1181a08be6b36a403c406b5df5aaa4399a647c8b`. It contains eight successful guest runs and 779 field operations. Fresh guest creation through validated response ranged from **416,958 to 1,992,500 ns**; the first sample exceeded 1 ms. Each run mapped and observed 65,536 resident guest backing bytes. Process launch through exit ranged from 5.9 to 235.9 ms and is separate from the guest interval. These are raw research observations from eight varied workloads and newly launched controllers, not a 1 ms or 2 MB qualification campaign.

## Open work

1. Integrate this guest with production native lowering, manifest admission, checkpoint handoff, and authorized correction events. The current driver accepts only a host-derived research frame, and its direct raw CLI does not authenticate checkpoint history.
2. Expand or explicitly constrain the production value domain, including historical heap records, closures, composite values and tasks. This guest operates only on bounded record fields.
3. Integrate capability checks, effects, replication, proof validation, recovery and full runtime execution inside or across the guest boundary. None are supplied by this research kernel.
4. Requalify boot, resident memory, fallback, locality and throughput using the full admitted runtime and driver. This bounded guest's raw samples do not close the v4 1 ms, 2 MB, or other release gates.
