# Witnessed native fallback host checkpoint

Exact tested source: `238de206fceae896f955f41c47a3fa0d0fe4ca18`, specification 0.1.0. The worktree was clean during the full suite and exact-source release benchmark. These evidence files were added afterward.

| Check | Result | Evidence |
| --- | --- | --- |
| `npm test` | 997 tests: 996 pass, 0 fail, 1 existing opt-in skip | [full suite](full-test.log) |
| Focused v5 witness, native runner and host campaign | 13/13 pass | [focused run](focused-test.log) |
| Build, typecheck and both roadmap checks | pass; 62 tasks and 71 obligations valid | [build](build.log), [typecheck](typecheck.log), [v4 roadmap](roadmap-v4.log), [roadmap](roadmap.log) |
| Package dry run | bundled dist contains the pinned v1 native C driver | [package file list](package-dry-run.json), [build log](package-dry-run.log) |
| `bench:v4:measure` and exact-source verification | raw samples and source hashes verify; release eligible **false** | [measure](bench-measure.log), [verify](bench-verify.log), [manifest](bench/manifest.json), [samples](bench/samples.json) |
| `bench:v4:enforce` | expected exit 1; 17 required targets failed or unmeasured | [enforcement](bench-enforce.log) |

The opt-in [ProcessHost native transaction](../../../../../src/tier4/process-host.ts) uses configuration /10 and witnessed journal /5. It validates the bounded one-field Int profile, exact AST/manifest, checked Tier 2 record certificate, current Tier 1 and Tier 2 grants, selected host witness, source snapshot/head, generation and operator-pinned executable digest. It persists an intent before native launch. The [runner](../../../../../src/tier4/native-fallback-runner.ts) regenerates exact proof-bearing C from the bound AST, checks the packaged driver SHA-256, rebuilds with fixed Clang flags, compares rebuilt and selected executable bytes, and executes only a private rebuilt copy. It checks the complete tier/result/heap against an independent contract-enforcing Aether run. The host then witnesses one atomic candidate-snapshot, receipt and state-head publication. For this bounded profile, the native candidate is the authoritative host result.

The [integration campaign](../../../../../test/tier4/process-native-fallback-host.test.ts) covers Tier 2 alias commit, distinct-reference Tier 3 rollback, no intent on missing Tier 2 authority, revocation at publication, explicit recovery denial, substituted binary bytes, controller close at intent/launch/publication, malformed v5 journal fields, witness outage, and actual controller SIGKILL before and after commit. A fresh controller recovers a pending pure intent from its retained source or returns the one cached committed result. Restoring an older local mirror does not erase the witnessed decision. The service and controller processes share one UID.

This profile still admits only a pure one-field Int record fragment. It has no native effect boundary, full value ABI, distinct-UID native confinement or demonstrated third-party irreversible sink. The compiler/linker and OS remain trusted; deterministic rebuilding excludes a substituted executable under the checked source label, while a compromised trusted toolchain remains outside this evidence. The native runner recompiles on each invocation, and no qualified ≤50 ns in-frame maximum has been measured on the admitted host path. [D13](../../decisions/D13-native-fallback-host-transaction.md) records the remaining contract and crash campaigns. T3-07/G1/G2, FR-3.7 and the full v4 release remain open.

The unchanged complete warm-message fixture measures **1.861×** compression against the 4× target. Seventeen required release targets fail or are unmeasured; the tracker stays **20/62 verified**. SHA-256 digests for retained artifacts are in [hashes.json](hashes.json).
