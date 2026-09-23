# Packed string image size experiment

Fixed before the first run of `run.ts`:

- Use 1,024 typed records with two bounded string fields and one nullable relative reference field. Each reference points at the next record, with the final record pointing at itself.
- Compare three deterministic string distributions: 4 repeated values, 64 repeated values, and 1,024 unique values. Values are ASCII `value-0000` through `value-1023`; each field is limited to 32 UTF-8 bytes.
- For each distribution, compare the canonical encoded complete logical `MachineRecord[]` byte count with the canonical encoded complete `aether.packed-heap/2` image byte count. Report payload bytes, UTF-8 dictionary arena bytes, entry count and complete-image ratio.
- Verify `pack → image → fromImage → unpack` equality before recording a row. Pin SHA-256 of the exact packed-heap implementation and this runner. Record local Node, OS and CPU model.
- These are deterministic serialized byte counts, not resident memory, cache locality, native guest speed or a 2 MB release measurement. No pass threshold is implied.
