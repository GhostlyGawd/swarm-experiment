# Superseded clean integration attempt

The clean detached source at `64894c6f8a60dca87d365583d341e0f913a3b0df` passed build, typecheck and both roadmap checks. Its full suite finished with **629 passing tests and one failure out of 630**. This is a failed integration attempt, not task acceptance evidence.

The only failure was the actual Rust composite projection test. Its output had the standard-ledger result shape, showing that two tests running concurrently shared `CARGO_TARGET_DIR` and could execute the other's binary. The source fixtures and semantic assertions were not weakened. Commit `35d9897` assigns each test its own Cargo target directory; the two affected test files then passed together (7/7). The full suite must still pass at that corrected exact source.

All raw command output is retained in `tests.log`. The log's final failure shows the received ledger result and the expected composite result. No failed result is counted as a verified tracker gate.
