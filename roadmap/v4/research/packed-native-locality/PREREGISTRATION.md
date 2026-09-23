# Native packed-record locality campaign (V4-T3-10/G2)

Frozen before measuring `results/local-01`. This is a bounded native-process experiment on the current workstation, not a release gate or a native guest measurement.

## Inputs and comparison

- Use the actual `PackedHeap.pack` `/1` image for identical logical records in every arm. Each record has a stable logical ID, epoch, version, bounded integer (`0..1000`), Boolean, and non-null reference. The C driver checks every packed value and resolved reference against the logical row table before timing. It refuses any mismatch.
- Counts: 4,096 and 16,384. Link distributions: `local` (64-row rings), `cluster` (64-row groups linking to one hub, giving aliases), and `wide` (fixed-seed pseudorandom targets). Epoch is `1 + ordinal % 7`; version is `ordinal % 3`. Layout relative bounds are 63 for local/cluster and `count - 1` for wide. These are hand-selected layouts.
- Native logical baseline: C rows with numeric logical IDs, epochs, versions, integer, Boolean and a resolved pointer to the target row. The packed arms retain logical IDs/epochs/versions in a C row table plus the real packed bit payload. Report `sizeof`-based allocation bytes for both complete native representations and the canonical packed image and logical record-array bytes. These are allocation and serialized sizes, **not resident memory**.
- Three access patterns, each exactly 100,000 record reads: sequential scan, fixed-seed random scatter, and reference chase starting from row zero. Each read uses the integer, Boolean and target logical ID/epoch in an order-sensitive checksum. Checksum equality is required across all arms and trials.
- Three C read arms: native pointer baseline; packed through the checked `ae_packed_read_u64` and `ae_packed_ref_target` ABI; packed with a fast bit extractor and relative-code decode after the full-image prevalidation. The fast arm has no per-read validation and is experimental, not an admitted production reader.

## Measurement and reporting

- Compile the C driver and existing ABI with local `clang -O3 -std=c11 -Wall -Wextra -Werror`. Pin compiler version, OS/CPU, git head and SHA-256 of the executable, preregistration, runner, driver, ABI, header, transitive packed heap sources and each retained fixture. The verifier compares source hashes to both current files and the pinned Git commit, then recompiles the binary and compares its hash.
- For each case/pattern/arm: five warmups, then seven unfiltered monotonic-clock trials. Alternate the order of the three arms by trial number to reduce fixed-order bias. Retain every raw nanosecond sample, checksum, median, maximum, and per-case ratios. No trimming or outlier rejection.
- The independent verifier checks source/fixture hashes, parses retained fixture bytes, recomputes every logical-to-packed value/reference mapping and expected pattern checksums, and recalculates all medians, maxima and ratios from raw trials. It rejects tampered reports and missing or altered inputs. Run it against `results/local-01/report.json`.
- Interpret wall time only as a workload locality **proxy**: no hardware cache counters, energy, process resident set, guest launch, migration, full value domain, 2 MB release, or 100M-node measurement is claimed. Preserve slowdowns and maximum-latency misses. This campaign alone cannot verify V4-T3-10/G2.
