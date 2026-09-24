# Bounded record proof and native host binding checkpoint

Exact tested source: `549ed6f6ac37ecb5cbc4ab15a53acd2e6de23ad1`, specification 0.1.0. The worktree was clean during the full suite and exact-source release benchmark. These evidence files were added afterward.

| Check | Result | Evidence |
| --- | --- | --- |
| `npm test` | 984 tests: 983 pass, 0 fail, 1 existing opt-in skip | [full suite](full-test.log) |
| Focused record-proof/native/host checks | 10/10 pass | [focused run](focused-test.log) |
| Build, typecheck and both roadmap checks | pass; 62 tasks and 71 obligations valid | [build](build.log), [typecheck](typecheck.log), [v4 roadmap](roadmap-v4.log), [roadmap](roadmap.log) |
| `bench:v4:measure` and exact-source verification | raw samples and source hashes verify; release eligible **false** | [measure](bench-measure.log), [verify](bench-verify.log), [manifest](bench/manifest.json), [samples](bench/samples.json) |
| `bench:v4:enforce` | expected exit 1; 17 required targets failed or unmeasured | [enforcement](bench-enforce.log) |

The [bounded record certificate](../../../../../src/tier2/record-fallback-proof-checker.ts) rederives linear-arithmetic obligations from the exact full AST root, manifest and selected Tier 2 declaration. It checks a one-field Int record profile with one fresh allocation and signed-i64 range under validated snapshot bounds. For aliased references, the current Tier 2 satisfies its postcondition; for distinct references, the postcondition holds exactly when the initial right value equals the initial left value plus one. The other distinct cases reach Tier 3 and preserve the entry state. The independent checker rejects edited declarations, incomplete proofs, unsupported/faulting syntax and possible overflow. The proof is source-level and conditional on this bounded input domain.

The [proof-bearing native lowering](../../../../../roadmap/v4/research/native-fallback-ast/compiler.ts) embeds the checked certificate digest and compiler profile in executable bytes. The versioned [native binding](../../../../../src/tier4/native-fallback-contract.ts) checks the exact ProcessHost source snapshot/head, generation, arguments, reference epochs, proof and artifact hashes; the research runner checks that binding before launching a private copy of the selected binary. An [actual host-state comparison](../../../../../test/tier4/process-native-fallback-snapshot.test.ts) matches native tier, result and complete object table with the host's durable ordinary-worker outcome for alias and distinct inputs. Forged checked-proof objects, stale native source state and mismatched executable identities are refused.

This is **not** native state publication. ProcessHost still runs its ordinary worker for the authoritative call, and the binding is not a witnessed host journal transition. The snapshot envelope also lacks record type metadata, which a host admission must obtain from retained allocation history. The [D13 transaction contract](../../decisions/D13-native-fallback-host-transaction.md) identifies the remaining witness, crash, type and revocation checks. Broader values/effects, third-party sink custody and FR-3.7's hard ≤50 ns in-frame switch are open. The local M4 Pro clock evidence remains too coarse to qualify that maximum.

The unchanged complete warm-message fixture measures **1.861×** compression against the 4× target. Seventeen required release targets fail or are unmeasured. T3-07/G1/G2, FR-3.7 and full v4 remain open; the tracker stays **20/62 verified**. SHA-256 digests for retained artifacts are in [hashes.json](hashes.json).
