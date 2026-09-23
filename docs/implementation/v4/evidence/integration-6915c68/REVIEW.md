# Integrated v4 checkpoint — `6915c6882084c0aff7837bf56937dcd9b89c933a`

The source tree was clean for this run on `aether/v4-implementation`, specification 0.1.0. This is bounded V4-T2-04 implementation progress, not task or full v4 completion. [SHA-256 hashes](hashes.txt) cover the retained logs, benchmark artifacts and raw capability campaign.

| Check | Observed result |
| --- | --- |
| `npm test` (includes build) | Exit 0; **846 tests, 845 pass, one opt-in skip, zero fail**, 353,354 ms. [Full log](full-test.log). |
| `npm run build`, `npm run typecheck`, both roadmap checks | All exit 0; 62 tasks and 71 obligations remain valid. [Build](build.log), [typecheck](typecheck.log), [roadmap](roadmap-check.log), [v4](roadmap-v4-check.log). |
| Independent capability campaign audit | Exit 0; 59 cases, exact source `c07e4aa`, 134 pinned source paths. [Audit](capability-verify.log), [raw report](../../../../../roadmap/v4/research/capability-matrix-v2/results/campaign-01.json), [coverage review](../../../../../roadmap/v4/research/capability-matrix-v2/results/REVIEW.md). |
| `npm run bench:v4:enforce` | Exit 1, correctly: **17 required targets failed or unmeasured**. [Log](bench-enforce.log), [clean-source manifest](benchmark-manifest.json), [samples](benchmark-samples.json). |
| Exact-source benchmark audit | Exit 0; `sourceMatches: true`, `releaseEligible: false`, 17 required failures. [Log](bench-verify.log). |

The new opt-in `scoped-anchored-wasm-v7` profile binds an independently provisioned clock anchor to deployment `/7`, prepared `/5`, host configuration `/5` and effect plan `/5`. A real Wasm ProcessHost/ProcessDeployment test holds factory grant and broker clocks at 100 while trusted time advances. Expired grants and signed deadlines refuse fresh calls before another broker router or guest launch. Promotion, reopen, changed-anchor refusal and in-process rollback refusal pass. The broker checks grant windows and deadline again after factory authorization and before sink entry. A post-marker refusal persists a terminal no-dispatch transition; if a crash occurs before that transition, the durable marker remains uncertain for reconciliation.

The source-pinned campaign exercised 15 TopologyHost, 28 real ProcessHost and 16 ProcessDeployment cases: **57 denials** had zero additional sink calls and unchanged authoritative heap, while two positive controls reached guarded paths. Its deployment slice used historical pure `scoped-v2`; signed V5/V6/V7 external-effect deployment, live cross-process closure/task transfer and distributed partitions were outside that campaign.

The test clock provider is an in-memory stand-in. The external operator provider must prevent time/revision rollback across process restarts and whole-store restores; that infrastructure is **not** supplied or qualified here. V7 is a bounded read-only i32 Wasm effect profile. Broker receipt authentication, general JavaScript adapter isolation, all-path containment and NFR-16 remain open. The tracker remains **20/62 verified** with **17 required release targets** unsatisfied.
