# Integrated v4 checkpoint — `57711ecf0c60e3c5a39cc4b60a45fd0e29157fd4`

The source tree was clean before this evidence directory was created. All checks below ran against that exact commit on `aether/v4-implementation`. This checkpoint validates integration and bounded research; it does not close the v4 release.

| Check | Result |
| --- | --- |
| `npm test` (includes build) | Exit 0; **760 tests, 759 pass, 1 skipped, 0 fail**; 292,216.783 ms. [Full log](full-test.log). |
| `npm run typecheck` | Exit 0. [Log](typecheck.log). |
| `npm run roadmap:check` and `npm run roadmap:v4:check` | Both exit 0; 62 tasks and 71 obligations valid. [Roadmap](roadmap-check.log), [v4](roadmap-v4-check.log). |
| Opt-in FROST differential | Exit 0; 8 pass, including 200 pinned Rust public transcripts. [Log](frost-differential.log). |
| Ristretto research Rust tests | Exit 0; 8 pass. [Log](ristretto-tests.log). |
| AE3 retained-message audit | Exit 0; 30 root and 9 dependency messages checked. [Audit](agent-ir3-audit.json). |
| Independent HotStuff threshold replay | Exit 0; 9 proofs, 32 checks and 7 restarts; `productionAdmission: false`. [Manifest](hotstuff-independent-manifest.json), [result](hotstuff-independent-result.json). |
| `npm run bench:v4:enforce` | Exit 1; **17 required targets failed or unmeasured**. Its [manifest](benchmark-manifest.json) binds this commit with `workingTreeDirty: false`; [samples](benchmark-samples.json) and [log](bench-enforce.log) are retained. |

The source adds default hard-SMT evidence policy, exact adapter-artifact provenance and strict final call authority checks; candidate-only declarative adapter retirement; bounded native projection, living-campaign and fallback extensions; optional AE3 bundle/edit encoding; and isolated FROST custody plus HotStuff epoch-handoff research. The [AE3 campaign](../../../../../roadmap/v4/research/agent-ir3/README.md) reduces complete-session token count versus AE2 but reaches only 1.401× against the unchanged cl100k legacy review baseline, below the required 4×. The [HotStuff campaign](../../../../../roadmap/v4/research/hotstuff-threshold/README.md) is same-host research without production admission or independent operator custody.

The tracker remains **20 of 62 tasks verified**. T1-02, T1-05, T2-04, T2-06, T3-03 and T3-07 remain in progress. T2-05 has an early foundation but remains planned until its T2-04 prerequisite closes. The release benchmark retains 17 open required targets, including NFR-08's unmeasured inventory row. No new task gate is advanced by this integration run alone.

SHA-256 digests of every retained raw log and artifact are in [hashes.json](hashes.json).
