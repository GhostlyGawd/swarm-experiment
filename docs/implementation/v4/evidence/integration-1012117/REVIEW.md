# Integrated v4 checkpoint — `1012117631e0c7fd4b4cecfae67293fc026165bc`

Source commit: `1012117631e0c7fd4b4cecfae67293fc026165bc` on `aether/v4-implementation`. The source tree was clean before this evidence directory was created. This checkpoint validates integration, not full v4 completion.

| Check | Result |
| --- | --- |
| `npm test` (includes `npm run build`) | Exit 0; **702 tests, 701 pass, 1 skipped, 0 fail**; 278,885.599 ms. [Full log](full-test.log). |
| `AETHER_FROST_DIFFERENTIAL=1 CARGO_NET_OFFLINE=true node --test --experimental-strip-types test/fabric/quorum-threshold.test.ts` | Exit 0; 8 pass, including 200 pinned Rust share-verifier transcripts. [Log](frost-differential.log). |
| `CARGO_NET_OFFLINE=true cargo test --release --locked --manifest-path roadmap/v4/research/frost-ristretto/Cargo.toml` | Exit 0; 8 Ristretto protocol tests pass. [Log](ristretto-tests.log). |
| `npm run typecheck` | Exit 0. [Log](typecheck.log). |
| `npm run roadmap:check` and `npm run roadmap:v4:check` | Exit 0; 62 tasks and 71 obligations valid. [Roadmap log](roadmap-check.log), [v4 log](roadmap-v4-check.log). |
| `npm run bench:v4:enforce` | Exit 1; **17 required targets still failed or unmeasured**. [Log](bench-enforce.log). |

The source includes durable capability profiles that default new ProcessDeployment histories to scoped grants, explicit v1/v2 authority adoption with old-host preflight, strict continuation/effect checks, an isolated signed resource-budget foundation, Ristretto255 threshold research, and native Atomic projections. The [projection campaign 07 audit](../../../../../roadmap/v4/research/projections/results/campaign-07-atomics/report.json) still misses the 4× token target (0.667× cl100k). The [living micro-world campaign](../../../../../roadmap/v4/research/microworld/README.md) passes its fixed local JSON kernel but does not qualify complete distributed throughput. Ristretto research has no production admission, custody, or membership handoff.

The tracker remains **20 of 62 tasks verified**. T1-02, T1-05, T2-04, T2-06 and T3-03 are in progress. T2-05 has an early foundation but remains planned until its T2-04 prerequisite closes. No gate status is advanced by this integration run alone.

SHA-256 of retained logs:

| Log | SHA-256 |
| --- | --- |
| `bench-enforce.log` | `5e2716c418e5dd2d0370e9bfa82c60a625b03d9613528bc777722318c43079d7` |
| `frost-differential.log` | `d7f8eaacf599512ad5101b68f69fb0e6e14d6ce924f4464e9aeb1dea7fafd118` |
| `full-test.log` | `60cedef53672a4d7943bfc3e3496654c581ccf2a94376672300655e345575971` |
| `ristretto-tests.log` | `a93a78eff7c6b71698002ad4b604b15a743230c3e872e0261e8dd2a172c3fdb7` |
| `roadmap-check.log` | `a24aba684dc7e3baac1ed86ac4d15756297bc8b23864844a02f0548f3a892b61` |
| `roadmap-v4-check.log` | `94196e972baa6f56bbf9c33bb5d11cb2bdbba77c9e1cba54413180d0ec122161` |
| `typecheck.log` | `9785646704dde7cbdb136ac56788267f87d13a934e3a159a64f78aa2b719dfea` |
