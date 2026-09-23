# Checked fused packed-row locality campaign (V4-T3-10/G2)

Frozen before collecting `results/local-01`. This is an isolated native C experiment on the current workstation. It does not establish release latency, guest memory, or cache locality.

## Input and arms

- Regenerate the six actual `PackedHeap.pack` `/1` fixtures from the same logical data and layout as the previous native locality campaign. Require byte-for-byte equality with its retained fixtures. Counts are 4,096 and 16,384; link distributions are 64-row local rings, 64-row cluster hubs, and seeded wide links. Every row has a 0..1000 integer, Boolean, non-null relative reference, logical ID, epoch and version. Validate all fields and resolved logical target IDs/epochs against the native baseline before timing.
- Compare four arms in one process: native pointer baseline; existing per-field checked ABI (`ae_packed_read_u64` three times plus `ae_packed_ref_target`); previous fast prevalidated extractor; new checked fused `ae_packed_read_bounded_row`. The fused arm must validate the complete row bounds, scalar range and relative reference on each read, and leave its output unchanged on error.
- Scan, seeded scatter and reference chase each perform 100,000 reads per trial. Every read uses integer, Boolean and target logical ID/epoch in the same order-sensitive checksum. The native driver rejects any preflight, warmup or timed checksum mismatch.
- Independently exercise all integer values 0..1000, both Boolean values, six valid reference codes, both fixture reference widths, and all eight row bit alignments against the legacy checked ABI. Reject malformed value, reference, width and bounds inputs, and verify error paths do not write output.

## Measurement and verification

- Compile both native driver and adversarial executable with `clang -O3 -std=c11 -Wall -Wextra -Werror`. Record compiler and host identities; SHA-256 of exact source paths, binaries and fixtures; and the Git commit containing measured source. The verifier checks current and commit-pinned source hashes, recompiles both binaries, and checks their digests.
- Five warmups per pattern. Seven unfiltered `CLOCK_MONOTONIC` samples per arm and pattern; rotate all four arm positions each trial. Retain all 504 raw nanosecond samples and checksums. Recompute medians, maxima and baseline ratios without trimming.
- The independent verifier parses fixture bytes and reconstructs every logical/packed mapping, all 18 pattern checksums, byte counts, and raw-sample statistics. It also checks byte-for-byte fixture identity against the previous campaign and reruns the adversarial executable.
- Report every slowdown or improvement. The packed allocation is unchanged by this reader. Wall time is only a locality proxy; this campaign does not supply hardware cache counters, guest residency, energy, 100M-node scale, or a release-profile workload. It cannot alone close V4-T3-10/G2.
