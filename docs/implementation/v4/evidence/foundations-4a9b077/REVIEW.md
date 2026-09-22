# Foundation verification record

Subject commit: `4a9b0776276251cf92ca647baa114c638a2559bf`.
Specification: `0.1.0`.

Verification used a detached worktree of that exact commit. The full suite passed **242/242**, typechecking passed, and both v1/v4 roadmap checks passed. A subsequent clean `npm ci --ignore-scripts` established the pinned dependency installation. The benchmark manifests were regenerated with a clean working tree and `js-tiktoken@1.0.21`. Root and `@ghostlygawd/aether/fabric` package imports resolved consistently after building.

## V4-F01

All eleven migration tests passed. An independent agent reviewed the implementation and reran the eleven tests. Its earlier findings—stale closure heaps, disconnected map/fold callbacks, omitted default memory and changed latency pricing—were fixed and covered before this checkpoint.

- G1: ledger balances 90/10 survive movement; the next transfer updates them correctly; capability metadata and revocation survive.
- G2: shared/cyclic references, nested calls, independent runtime allocations, source-unit removal, callbacks and unrelated records retain coherent state. Snapshot containers are copied independently.
- G3: same-unit movement is a no-op. Stale generation, invalid targets, active state, unsupported continuations, invalid snapshots, policy violations and injected export/compile/import failures preserve the old usable plan and state. Subsequent successful movement is tested.

Scope: one synchronous local state domain with separate runtime arrays synchronized at boundaries. Full copying is deliberate initial behavior. Live closures/tasks execute through their original runtime and prevent replacement while retained. This does not establish durable/multiprocess migration, resumable continuation serialization, external-effect compensation or v4 performance targets.

## V4-F02

The benchmark test suite exercises arithmetic, corpus accounting, missing/duplicate/forged result enforcement, CLI exit codes and manifest bindings. Raw measured data and command logs accompany this record.

- G1: actual cl100k_base counts are 698 baseline / 343 body / 375 complete warm-message tokens. Cold counts are 878/933. The complete executed failure-and-repair session records 1361/1226 tokens.
- G2: `bench:v4:measure` exited 0 after recording results. `bench:v4:enforce` exited **1** because 17 required profile rows remain unsatisfied (two token ratio rows plus fifteen unmeasured NFRs). This expected nonzero exit is a successful enforcement-behavior test; the release targets themselves remain failed/unmeasured.
- G3: manifests bind exact commit, clean source tree, corpus/profile digests, raw samples, dependency lock, tokenizer, environment and session framing. README/CLI no longer present estimated 4× compression as measured acceptance. CI stores observations; it does not claim release qualification.

`benchmark-manifest.json` originally names `samples.json`; the preserved corresponding artifact here is `benchmark-samples.json`, copied byte-for-byte. Its semantic JSON digest remains bound by the manifest's `samplesDigest`. The original relative output paths remain in raw logs for reproducibility.

## V4-F03

Seven new fabric tests plus the existing repository/storage tests passed within the full suite.

- G1: hardcoded existing v1 addresses, reopened repositories and archives retain identity/bytes; the new domain-separated encoding does not alter tier1 hashing.
- G2: every execution context component affects its digest; transitive dependency changes, conflicts and missing declarations are rejected. Metadata-only observations have independent addresses.
- G3: malformed/duplicate keys, invalid tags/versions, unsafe integers, depth/object/byte limits, references and snapshot ownership are tested before mutation. Logical reference cycles and aliases survive encoding.

The dependency resolver must content-verify AST declarations and report their complete dependency edges; schema validation alone does not discover dependencies. Snapshot v1 represents a full isolated heap. Destination authorization/revocation must validate opaque authority references. These explicit boundaries remain prerequisites for later admission and process integration.

These records verify three foundation tasks. Full v4 completion remains open.
