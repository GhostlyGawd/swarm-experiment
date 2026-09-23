# Bounded strings in packed heap `/2`

`aether.packed-heap/2` extends the candidate heap image with a UTF-8 dictionary. A string field declares `maxUtf8Bytes` (0–4,096) and stores a 12-bit dictionary ordinal. The dictionary has at most 4,096 distinct strings and a 16 MiB byte arena. Image entries contain checked byte offsets and lengths into that arena; no host pointer is serialized. Strings are kept in first-use order across rows and layout fields, so packing is deterministic. The image and layout use distinct `/2` digest domains.

`aether.packed-heap/1` remains the format for layouts without string fields. Its shape, bit widths, digest domains, and decoder are retained. `PackedHeap.fromImage` reads both versions. A string `set` validates the new value, repacks the logical records, and installs the new bytes and dictionary only after success, so stale entries disappear and a failed update leaves the image unchanged. Layout migration also repacks through logical values. The resumable checkpoint bridge labels a string heap `/2`, binds the trusted logical checkpoint digest, validates the reconstructed runtime snapshot, and preserves record IDs, epochs, versions and aliases.

The [native C process bridge](../packed-native-bridge/README.md) and [HVF EL1 research guest](../packed-hvf-guest/README.md) now read and compare bounded UTF-8 dictionary strings from authenticated `/2` checkpoints. Neither performs native string mutation or executes the complete runtime. The C bridge's 30 process round trips measured a 58.4 ms median, which includes process launch and checkpoint validation; the EL1 guest's 1,000-fresh-guest campaign misses the unchanged 1 ms maximum with a 1.364 ms outlier. V4-T3-10 remains open.

## Verification

- `node --test --experimental-strip-types test/tier3/packed-heap.test.ts test/tier3/packed-heap-strings.test.ts`: 13/13 pass. Cases include `/1` compatibility, NFC/NFD distinction, emoji, leading BOM, empty strings, aliases, string mutation, 4,097-entry rejection, malformed Unicode/UTF-8, wrong offsets/codes/digests, 256-row seeded differential, narrowing/widening migration, and a real `ResumableRuntime` checkpoint restore. A rehashed dictionary that changes logical state is rejected by trusted checkpoint validation.
- `npm run typecheck`: pass at the local run.

## Complete-image size experiment

The [preregistration](PREREGISTRATION.md), [runner](run.ts), and [raw result](results-local-01.json) give the exact deterministic workload and source hashes. An independent check matched both source hashes, recalculated the three ratios, and checked dictionary counts. On Apple M4 Pro with Node v26.7.0:

| Distinct strings | Logical records | Complete `/2` image | Ratio | Packed payload | Dictionary arena |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 4 | 382,814 B | 260,236 B | 0.680 | 4,480 B | 40 B |
| 64 | 382,814 B | 262,650 B | 0.686 | 4,480 B | 640 B |
| 1,024 | 382,814 B | 302,318 B | 0.790 | 4,480 B | 10,240 B |

The full image is smaller than the canonical logical record array in these workloads, but the ratio worsens as strings become unique. This is serialized size only. The prior packed heap JavaScript reader was much slower than the Map baseline, and this string `set` currently repacks the whole heap. End-to-end native guest resident memory, cache locality, throughput, and recovery remain unmeasured for `/2`; V4-T3-10 and the 2 MB release target remain open.
