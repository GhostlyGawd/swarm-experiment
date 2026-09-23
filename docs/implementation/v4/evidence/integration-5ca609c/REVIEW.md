# Integrated v4 checkpoint — `5ca609c58a0afd2caec119bd77e596c2dbde73dc`

The source tree was clean before this evidence directory was created. All checks below ran against that exact commit on `aether/v4-implementation`. This checkpoint validates integration and bounded research; it does not close the v4 release.

| Check | Result |
| --- | --- |
| `npm test` (includes build) | Exit 0; **763 tests, 762 pass, 1 skipped, 0 fail**; 292,557.227 ms. [Full log](full-test.log). |
| `npm run typecheck` | Exit 0. [Log](typecheck.log). |
| `npm run roadmap:check` and `npm run roadmap:v4:check` | Both exit 0; 62 tasks and 71 obligations valid. [Roadmap](roadmap-check.log), [v4](roadmap-v4-check.log). |
| Opt-in FROST differential | Exit 0; 8 pass, including 200 pinned Rust public transcripts. [Log](frost-differential.log). |
| Ristretto research Rust tests | Exit 0; 8 pass. [Log](ristretto-tests.log). |
| AE4 closed-bundle probe | Exit 0; 3 tests and independent pinned-message audit pass. [Tests](ae4-tests.log), [audit](ae4-audit.json). |
| `npm run bench:v4:enforce` | Exit 1; **17 required targets failed or unmeasured**. Its [manifest](benchmark-manifest.json) binds this commit with `workingTreeDirty: false`; [samples](benchmark-samples.json) and [log](bench-enforce.log) are retained. |

The new source fixes a strict ProcessHost grant attenuation bypass: a descendant-scoped `PROCESS_INVOKE` token can no longer authorize a whole pure worker call. Its regression checks no heap mutation. The broker now persists terminal no-dispatch evidence before a budget refund. The bounded real-broker budget bridge independently checks that journal evidence, retains funds when no terminal decision exists, and recovers the exact refund across three actual SIGKILL windows. An independent review found and repaired an unconditional authority callback on cached committed receipts. Public allocation APIs remain trusted administrative boundaries, and production broker-journal authentication remains open.

The [AE4 research candidate](../../../../../roadmap/v4/research/agent-ir4/README.md) preserves the exact closed dependency bundle and saves 50 cl100k cold tokens versus AE3. Its legacy-to-candidate cold ratio is **0.651×**, still far below the required **4×**. The identity-size analysis is a research finding, not a change to the target or corpus.

The tracker remains **20 of 62 tasks verified**. T1-02, T1-05, T2-04, T2-06, T3-03 and T3-07 remain in progress. T2-05 has an early foundation but remains planned until T2-04 closes. The release benchmark retains 17 open required targets. No task gate is advanced by this integration run alone.

SHA-256 digests of every retained raw log and artifact are in [hashes.json](hashes.json).
