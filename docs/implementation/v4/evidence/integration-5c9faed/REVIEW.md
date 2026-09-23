# Integrated v4 checkpoint — `5c9faed15234f3b599513a474edf4ac4eb622616`

The source tree was clean before this evidence directory was created. All checks below ran against that exact commit on `aether/v4-implementation`. This is an implementation checkpoint, not full v4 completion.

| Check | Result |
| --- | --- |
| `npm test` (includes build) | Exit 0; **776 tests, 775 pass, 1 skipped, 0 fail**; 295,233.985 ms. [Full log](full-test.log). |
| `npm run typecheck` | Exit 0. [Log](typecheck.log). |
| `npm run roadmap:check` and `npm run roadmap:v4:check` | Both exit 0; 62 tasks and 71 obligations valid. [Roadmap](roadmap-check.log), [v4](roadmap-v4-check.log). |
| Opt-in FROST differential | Exit 0; 8 pass, including 200 pinned Rust public transcripts. [Log](frost-differential.log). |
| Ristretto research Rust tests | Exit 0; 8 pass. [Log](ristretto-tests.log). |
| Isolated signer, budget, micro-world and Wasm research | Exit 0; **25 tests pass**, including an actual Wasm guest and SIGKILL reconciliation. [Log](research-tests.log). |
| `npm run bench:v4:enforce` | Exit 1; **17 required targets failed or unmeasured**. Its [manifest](benchmark-manifest.json) binds this commit with `workingTreeDirty: false`; [samples](benchmark-samples.json) and [log](bench-enforce.log) are retained. |

The new [boundary matrix](../../CAPABILITY-BOUNDARIES.md) invokes a pure state-changing function through a strict local TopologyHost and an actual ProcessHost worker. Correctly signed wrong-path, wrong-audience, narrowed, expired, revoked, stale, duplicate and forged grants are refused without publishing target heap changes. Existing closure, cross-process, effect and promotion regressions remain mapped there. This finite matrix does not prove every path.

The separate [WebAssembly adapter research](../../../../../roadmap/v4/research/wasm-adapter-isolation/README.md) runs real zero-import Wasm bytes behind the durable broker. Six tests cover exact hash/import refusal, live/replay behavior, grant denial, unknown outcomes and a real process death after host sink commit. The guest shares a process with the trusted JavaScript host and has no enforced CPU or memory limit; it is not a production hostile-adapter isolation boundary.

The tracker remains **20 of 62 tasks verified**. V4-T2-04 remains in progress because hostile-adapter isolation, external epoch rollback/rotation and complete all-path proof are open. The release benchmark retains 17 open required targets. No additional task gate is claimed by this run alone.

SHA-256 digests of every retained raw log and artifact are in [hashes.json](hashes.json).
