# Witnessed sink state checkpoint

Exact tested source: `d6ff30639d82608cdbe04223f3cd4e394bc5f3a5`, specification 0.1.0. The source tree was clean during the full suite and exact-source benchmark. These evidence files were added afterward.

| Check | Result | Evidence |
| --- | --- | --- |
| `npm test` | 940 tests: 939 pass, 0 fail, 1 existing opt-in skip | [full suite](full-test.log) |
| Sink/witness/broker/process focus | 15/15 pass | [focused tests](focused.log) |
| Build, typecheck, both roadmap checks | pass; tracker validates 62 tasks and 71 obligations | [build](build.log), [typecheck](typecheck.log), [v4 roadmap](roadmap-v4.log), [roadmap](roadmap.log) |
| `bench:v4:measure` and exact-source verification | raw samples and source hashes verify; release eligible **false** | [measure](bench-measure.log), [verify](bench-verify.log), [manifest](bench/manifest.json), [samples](bench/samples.json) |
| `bench:v4:enforce` | expected exit 1; 17 required targets failed or unmeasured | [enforcement](bench-enforce.log) |

The opt-in sink `/2` profile sends each signed complete decision journal to a separately launched, operator-configured witness before writing its local mirror or returning success. The witness validates receipts, values, request identities, sequence and append-only history itself. A real two-process campaign restores deleted and older sink-local state, refuses legacy downgrade and altered state, preserves a signed noncommit fence, rejects cross-deployment reuse and refuses a new decision while the witness is unavailable. A direct authenticated forged advance is rejected by the witness service, independent of the sink client's validator.

This is bounded fixture evidence under one UID. It does not prove distinct-UID custody, rollback resistance if both operator and sink stores are compromised, or atomic commitment in an arbitrary external service. The approved adapter artifact digest remains a test label. ProcessHost/Deployment admission, hostile adapter isolation, complete effect/grant paths and T2-04's full containment gate remain open.

The unchanged complete warm-message fixture measures **1.861×** compression against the 4× required target. Seventeen required release targets fail or are unmeasured. The tracker therefore remains **20/62 verified**; no v4 release gate is claimed. SHA-256 digests for retained artifacts are in [hashes.json](hashes.json).
