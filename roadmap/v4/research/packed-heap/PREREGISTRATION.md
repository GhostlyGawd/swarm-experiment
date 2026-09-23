# V4-T3-10 local packed heap measurement preregistration

This plan was written before collecting the samples in `results/local-01.json`.

- Hardware: the current developer workstation. Record OS, architecture, CPU model, Node version, source SHA-256 and timestamp in the raw result. This is **not** the native guest or the 2 MB residency qualification.
- Workload: 1,024 and 4,096 live typed records, each with an integer `0..1000`, a Boolean, and a nullable relative reference. Measure both a sequential chain (local references) and a fixed-seed uniformly distributed reference target (wide relative range). Use the same logical rows in each representation.
- Baseline: Aether `MachineRecord[]` encoded with the existing canonical codec, plus a `Map<string, MachineRecord>` field lookup for traversal. This is an honest logical-state baseline; it includes logical IDs, versions, epochs and types.
- Packed sizes: report both raw bitstream bytes and full encoded `PackedHeapImage` bytes, including row headers, layouts, identities, checksums and base64 overhead. A raw payload reduction alone is not a full-state reduction.
- Locality proxy: 5 warmups, then 7 raw wall-time samples for a fixed sequence of 100,000 field reads in each representation, with a checksum that is checked for equality. Report medians and every raw sample. JavaScript wall time is a proxy; it does not establish CPU cache-miss reduction or native locality.
- No benchmark result can close T3-10 until this ABI is integrated into the native guest and checkpoint boundary, accepted by an actual compiler target, and measured in the release profile. Failures and slower packed reads remain visible.

Run: `node --experimental-strip-types roadmap/v4/research/packed-heap/run.ts > roadmap/v4/research/packed-heap/results/local-01.json`.
