# Integrated v4 work-in-progress checkpoint

Clean source commit `414988e0438d79deb649cc8b0d91d7c9748b016e` passed **581 tests**, build, typecheck and both roadmap checks in a detached checkout with locked dependencies. The worktree was clean during verification. Command logs and hashes are in `manifest.json`.

This source integrates three bounded implementations:

- **V4-T3-01:** A ProcessHost checkpoint lease retains nonempty frames and pending tasks, preserves a private resumable heap, reconciles broker outcomes, and publishes a validated scalar/reference C1 heap to real workers. Six bridge tests passed, including controller SIGKILL at checkpoint, sink receipt and publication boundaries. Standalone rewind/inspection/correction and invalid version rejection remain covered by the resumable tests. The production lease still lacks authorized correction/rewind and multi-unit frame transport, so T3-01 remains in progress.
- **V4-T1-02:** Agent-IR v2 binary/model codecs and a lossless executable scalar projection profile run real TypeScript, Python and Rust fixtures. The pinned 12-message, two-tokenizer campaign audits its actual model-message cost. Cold AE2 used 763 versus 342 cl100k source-review tokens; the 4× release target is not met. Records, collections, closures/tasks, atomics, imports, generics and broader bidirectional coverage remain open.
- **V4-T1-05:** A closed-module semantic GC foundation proposes unreachable private-function removal and transparent scalar forwarding collapse, checks portable equivalence certificates, protects signed fences and retained roots, and uses strict promotion for publication/rollback. Ten focused tests passed. Dead branches, general obsolete shims and external adapter retirement remain open.

Security hardening in the same source rejects Promise-valued correction and recovery authorization. The legacy capability sealer rejects malformed shapes, invalid clocks, exact expiry and opaque-scope changes; 34 combined resumable/F07 regressions passed before this clean full-suite repeat. T2-04 remains in progress pending production v2 grant integration.

The release benchmark enforcement command exited **1** as intended with **17 required targets still failed or unmeasured**. Its exact-source manifest reports `workingTreeDirty: false`. This checkpoint does not claim a milestone or full v4 completion.
