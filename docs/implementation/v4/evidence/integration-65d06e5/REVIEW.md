# V11 projection and V9 witness integration checkpoint

Exact tested source: `65d06e52b79cb4a438e7195325bd52029f5e1a03`, specification 0.1.0. The worktree was clean for the full suite and benchmark measurement. Raw logs and benchmark artifacts are retained here; later documentation commits do not change the tested source.

| Check | Result | Retained evidence |
| --- | --- | --- |
| `npm test` (includes `pretest` build) | 901 tests, 900 pass, 0 fail, 1 existing opt-in skip | [full-test.log](full-test.log) |
| `npm run typecheck` | pass | [typecheck.log](typecheck.log) |
| `npm run roadmap:v4:check` | 62 tasks, 71 obligations valid; 20/62 tasks verified | [roadmap-v4.log](roadmap-v4.log) |
| `npm run roadmap:check` | pass | [roadmap.log](roadmap.log) |
| `bench:v4:measure` and `bench:v4:verify --exact-source` | canonical raw samples and source hashes verified; release eligible **false** | [bench/manifest.json](bench/manifest.json), [bench/samples.json](bench/samples.json), [measure](bench-measure.log), [exact-source verify](bench-verify.log) |
| `bench:v4:enforce` | expected nonzero: 17 required targets failed or unmeasured | [bench-enforce.log](bench-enforce.log) |
| Retained artifact verifier after copy | arithmetic and canonical artifacts still verify; release eligible **false** | [bench-retained-verify.log](bench-retained-verify.log) |

The unchanged release fixture's complete warm-message ratio is **1.861×**, below its 4× gate. The AE5 unchanged-reference research pass has not replaced that release fixture or solved changed sessions. V9's direct/deployed Wasm test rejects omitted host effects and omitted outer invocation history after promotion, but the witness fixtures are in-memory and same-process. No OS-separated custody, authenticated external sink status, general effectful adapter isolation or full path containment is qualified. V4-T1-02, V4-T2-04, Q03 and NFR-16 remain open; task status stays 20/62.

SHA-256 retained artifact digests:

```text
abc065f291dde45288bfa2036acb0cb9255465373b8e88a20e9ebf7952f0769b  bench-enforce.log
9f6fb7e169ac4a4e8479e2d0fa69e4c6c2109ed72c4fb450a098186a790ca886  bench-measure.log
07e3c8eadb50d8114ca56acbf8d7232c25d779b7626bd9e1ed38942d46f33839  bench-retained-verify.log
e83bed672f03b4f50217ee0ce8d5992b631de163b1319757cbb879f1b5b3af26  bench-verify.log
e5000a2570f0201d8c8df90c3e2981952da2f36978b8c60bb6676b201d32cb50  full-test.log
94196e972baa6f56bbf9c33bb5d11cb2bdbba77c9e1cba54413180d0ec122161  roadmap-v4.log
a24aba684dc7e3baac1ed86ac4d15756297bc0d7a093ca0af4a92eb8591339a  roadmap.log
21d828da60cecb8e4fb3a7820562dfd40397af0d7a093ca0af4a92eb8591339a  typecheck.log
ebbc3cb3f2fac28d92099afd11b2db124c576004c70c289d81b2575e51fd6a92  bench/manifest.json
cb224d73c70f082e235752bb3056a32e14df6f30d99084c943fa93472e73f2f5  bench/samples.json
```
