# Signed sink host and deployment checkpoint

Exact tested source: `8fa21cd6094590ac9228c4ab045e07ad92aa185c`, specification 0.1.0. The worktree was clean during the full suite and exact-source benchmark. These evidence files were added afterward.

| Check | Result | Evidence |
| --- | --- | --- |
| `npm test` | 949 tests: 948 pass, 0 fail, 1 existing opt-in skip | [full suite](full-test.log) |
| V10, V9, policy and deployment witness focus | 13/13 pass | [focused tests](focused.log) |
| Build, typecheck, both roadmap checks | pass; 62 tasks and 71 obligations valid | [build](build.log), [typecheck](typecheck.log), [v4 roadmap](roadmap-v4.log), [roadmap](roadmap.log) |
| `bench:v4:measure` and exact-source verification | raw samples and source hashes verify; release eligible **false** | [measure](bench-measure.log), [verify](bench-verify.log), [manifest](bench/manifest.json), [samples](bench/samples.json) |
| `bench:v4:enforce` | expected exit 1; 17 required targets failed or unmeasured | [enforcement](bench-enforce.log) |

The opt-in V5 signed policy and V10 deployment carry an operator-pinned sink anchor, adapter subject and sink state witness into direct ProcessHost calls and deployed calls. The integration campaign uses a real worker, a separate sink process, a sink witness process and an independent operator witness process for effect, host and deployment journals. It verifies successful direct and deployed writes, five deployed grant denials before any sink decision, exact branded-witness substitution refusal, sink-local mirror restoration, signed promotion, a restarted deployment after an older local registry is restored, and cached-result refusal while the sink witness is down. The deployment reports `servingReady: false` during that outage. Historical V9 Wasm behavior remains passing.

This is a same-UID fixture, with an append-once sink file as its external operation. The policy currently grants a fixed sink-wide path and the approved adapter artifact digest is a label rather than measured executable bytes. A V10 controller SIGKILL between sink commit and host/deployment terminal publication, complete budget settlement, payload-specific containment, distinct-UID custody and an arbitrary irreversible external service remain unverified. V4-T2-04/G1/G2 and NFR-16 stay open.

The unchanged complete warm-message fixture measures **1.861×** compression against the 4× target. Seventeen required release targets fail or are unmeasured; the tracker remains **20/62 verified**. SHA-256 digests for retained artifacts are in [hashes.json](hashes.json).
