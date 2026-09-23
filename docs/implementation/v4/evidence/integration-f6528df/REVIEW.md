# Integrated v4 checkpoint — `f6528df7f8ee4bd18076752246543b88fbc3e5a3`

Source commit: `f6528df7f8ee4bd18076752246543b88fbc3e5a3` on `aether/v4-implementation`. The working tree was clean before this evidence directory was created. This is an implementation checkpoint, not a v4 completion claim.

| Check | Result |
| --- | --- |
| `npm test` (includes `npm run build`) | Exit 0; 672 tests, 671 pass, 1 skipped, 0 fail; 275,098.670 ms. The opt-in Rust FROST differential is the one skipped test. The terminal summary was observed; no raw full-suite log was retained. |
| `AETHER_FROST_DIFFERENTIAL=1 CARGO_NET_OFFLINE=true node --test --experimental-strip-types test/fabric/quorum-threshold.test.ts` | 8 pass, 0 fail; 200 transcripts agreed with the pinned Rust share verifier, run separately before the final source commit. |
| `npm run typecheck` | Exit 0; [log](typecheck.log). |
| `npm run roadmap:check` | Exit 0; [log](roadmap-check.log). |
| `npm run roadmap:v4:check` | Exit 0; 62 tasks and 71 obligations valid; [log](roadmap-v4-check.log). |
| `npm run bench:v4:enforce` | Exit 1 as required for an incomplete release; 17 required targets failed or unmeasured; [log](bench-enforce.log). |

The checkpoint includes signed effect target and adapter-descriptor binding, strict topology direct-call containment, an isolated authenticated FROST share research verifier, native continuation projections, certified scalar semantic GC shims, and a bounded living micro-world campaign. The [living campaign audit](../../../../../roadmap/v4/research/microworld/README.md) separately records five passing fixed-kernel R04 trials at 3.65–4.01 million JSON events/s and complete durable campaign throughput of 112.8 cases/s. The [projection token audit](../../../../../roadmap/v4/research/projections/results/campaign-06-continuations/audit.json) records a cl100k ratio of 0.624 versus the required 4×. Neither result qualifies the full v4 release target.

`STATUS.md` retains **20 of 62 tasks verified**. T1-02, T1-05, T2-04, T2-06 and T3-03 remain in progress. The source-specific acceptance gates for those tasks have not been closed.

SHA-256 of retained check logs:

| Log | SHA-256 |
| --- | --- |
| `bench-enforce.log` | `5e2716c418e5dd2d0370e9bfa82c60a625b03d9613528bc777722318c43079d7` |
| `roadmap-check.log` | `a24aba684dc7e3baac1ed86ac4d15756297bc8b23864844a02f0548f3a892b61` |
| `roadmap-v4-check.log` | `94196e972baa6f56bbf9c33bb5d11cb2bdbba77c9e1cba54413180d0ec122161` |
| `typecheck.log` | `9785646704dde7cbdb136ac56788267f87d13a934e3a159a64f78aa2b719dfea` |
