# Measured virtual worker and active-pin release checkpoint

Date: 2026-09-24. Specification: v4 `0.1.0`. Exact tested source commit: `d4abb3d6e10f6167602822cacfd4b6ee5b80167a` on `aether/v4-implementation`. Log and raw-result hashes are in [hashes.sha256](hashes.sha256). This is focused integration evidence; T1-05/G1 and G2 remain open.

| Command | Result | Retained output |
| --- | --- | --- |
| `node --test --test-concurrency=1 --experimental-strip-types` over eight files below | **123 passed, 0 failed** | [focused.log](focused.log) |
| `npm run typecheck` | pass | [typecheck.log](typecheck.log) |
| `npm run build` | pass, emits worker bundle | [build.log](build.log) |
| `npm run roadmap:v4:check` | 62 tasks and 71 obligations valid | [roadmap-v4.log](roadmap-v4.log) |
| `npm run roadmap:check` | pass | [roadmap.log](roadmap.log) |
| `npm run worker:bundle:measure -- <raw file>` | five rebuilds, closed JS import graph, authenticated child pre-init refusal | [worker-raw.json](worker-raw.json), [worker-measure.log](worker-measure.log) |
| `npm run worker:bundle:verify` | bundle and measured inputs match the rebuilt manifest | [worker-verify.log](worker-verify.log) |

Focused files: `test/tier4/process-virtual-artifact.test.ts`, `test/tier4/process-worker-bundle.test.ts`, `test/tier2/adapter-artifact.test.ts`, `test/tier4/process-checkpoint-active-release.test.ts`, `test/tier4/process-semantic-retention.test.ts`, `test/tier1/semantic-gc.test.ts`, `test/tier4/process-deployment.test.ts`, and `test/tier4/process-host.test.ts`.

The rebuilt single-file worker bundle is **751,545 bytes** (SHA-256 `d501a784f3744402be82427f405d2ef1c6926050901c59c416c2126ae3418943`) from **68 measured JS/TS inputs**. The five local build samples were 427.264, 368.192, 335.509, 343.627 and 333.947 ms. The authenticated pre-init response took 46.115 ms in one child launch; this is not the v4 guest cold-boot boundary or a release latency result. A test independently verifies the closed bundle manifest, signs Artifact/3 with those inputs, launches that exact bundle through init/2, and gets the expected pure result after a worker restart. Parent and child reject changed artifact or measured bytes. The adapter-admission extraction leaves its public API and focused tests passing.

The Node launcher file in this measurement is **50,320 bytes**, but macOS dynamically loads `libnode` and other shared libraries. Their bytes and the system dyld cache are **not** in this subject. The declared source list is also not a mandatory closure manifest for arbitrary Artifact/3 callers. A separate measurement follow-up is addressing non-system libraries; live ProcessDeployment still rejects Artifact/3.

The append-only active-task release `/2` passes focused witnessed-terminal, replay-preservation, forgery/outage and crash-reconciliation tests. It has no automatic ProcessHost commit/reopen hook yet, and historical profiles remain unchanged. The serial full suite and release benchmarks were **not** rerun at this commit. The last release record still has 17 failed or unmeasured required targets. The tracker remains **20/62**.
