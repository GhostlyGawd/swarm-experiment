# Integrated v4 checkpoint — `fe1211d464b359080f4dbce40bd61288a7bb6850`

The source tree was clean for the passing run and release manifest on `aether/v4-implementation`, specification 0.1.0. This is bounded V4-T3-10/T4-05 progress, not task or full v4 completion. [SHA-256 hashes](hashes.txt) cover logs, benchmark artifacts and the retained native reports.

| Check | Observed result |
| --- | --- |
| `npm test` (includes build), isolated from research verifier jobs | Exit 0; **838 tests, 837 pass, one opt-in skip, zero fail**, 351,987 ms. [Full log](full-test.log). |
| `npm run typecheck` and both roadmap checks | Exit 0; 62 tasks and 71 obligations valid. [Typecheck](typecheck.log), [general roadmap](roadmap-check.log), [v4](roadmap-v4-check.log). |
| Current native runner and bridge tests | Exit 0; **7/7** tests, including exact-byte private binary execution, forged proof/script rejection, `/1` mutation and `/2` strings. [Log](native-tests.log). |
| Historical native `/1` and `/2` bridge verifiers | Both exit 0 from pinned source commits; binary and raw observations reproduced. [V1](native-v1-verify.log), [V2](native-v2-verify.log). |
| Historical checked fused reader verifier | Exit 0; six fixtures, 61,440 rows, 504 raw samples, 192,192 value parity rows and 1,052,672 reference-code cases. [Log](fused-history.log), [report](../../../../../roadmap/v4/research/packed-fused-locality/results/local-02/report.json). |
| AST-derived EL1 guest verifier | Exit 0; pinned source and binaries rebuilt and **57** actual guests rerun against an independent reference. Retained fresh-guest median **0.577 ms**, maximum **0.786 ms**, with 65,536 B observed backing. [Log](ast-hvf-history.log), [report](../../../../../roadmap/v4/research/ast-hvf-lowering/results/local-01/report.json). |
| `npm run bench:v4:enforce` | Exit 1, correctly: **17 required targets failed or unmeasured**. [Log](bench-enforce.log), [clean-source manifest](benchmark-manifest.json), [samples](benchmark-samples.json). |
| Exact-source benchmark audit | Exit 0; `sourceMatches: true`, `releaseEligible: false`, 17 required failures. [Log](bench-verify.log). |

The first full suite run shared CPU with historical verifier replays and exited 1: an anchored promotion test received an SMT timeout before reaching the signer refusal it expected (**836 pass, one fail, one skip**). [Failed log](concurrent-test-miss.log). The exact test [passed alone](targeted-signer-recheck.log), and the full suite passed when rerun without those concurrent jobs. Resource contention is the likely explanation, but the logs alone do not prove its scheduler-level cause. The 1,500 ms SMT cutoff and every release target remained unchanged.

New packed control `/2` requires a privately branded native run proof bound to the operation ID, source/candidate/layout, manifest artifact, executable SHA-256 and operation-plan digest. The trusted runner reads and hashes bounded binary bytes through one file descriptor, executes a private copy, and checks every returned observation and candidate byte. ProcessHost refuses new V1 controls and direct V2 publication without the proof; historical V1 transitions remain verifiable. Its V2 event subject also binds the binary and plan claims, so a rehashed journal relabel is refused on reopen. The process runner remains **unsandboxed** and its in-process proof is **not portable hardware attestation**.

The AST compiler demonstrates code generated from a real Tier 1 AST in EL1, with visible binary/result changes after an AST edit. Its signed 64-bit pure single-function/read-only-record subset does not execute the full runtime or establish the 1 ms/2 MB release gates. The fused packed reader remains slower than pointers in 16/18 measured patterns. V4-T3-10 and T4-05 remain open; the tracker remains **20/62 verified** with **17 required release targets** unsatisfied.
