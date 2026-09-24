# Signed sink receipt and V3 broker checkpoint

Exact tested source: `2d6662cb4981385b6bba078cdc1890babca3d888`, specification 0.1.0. The worktree was clean for the full suite, focused sink campaign and release benchmark measurement. Later evidence documentation is separate from that tested commit.

| Check | Result | Retained output |
| --- | --- | --- |
| `npm test` (includes pretest build) | 933 tests, 932 pass, 0 fail, 1 existing opt-in skip | [full-test.log](full-test.log) |
| `npm run typecheck` | pass | [typecheck.log](typecheck.log) |
| `npm run roadmap:v4:check` | 62 tasks and 71 obligations valid; 20/62 tasks verified | [roadmap-v4.log](roadmap-v4.log) |
| `npm run roadmap:check` | pass | [roadmap.log](roadmap.log) |
| Receipt, sink, adapter, V3 broker and real controller crash | 22/22 focused tests pass | [sink-focused.log](sink-focused.log) |
| `bench:v4:measure` and `bench:v4:verify --exact-source` | canonical raw samples and source hashes verified; release eligible **false** | [manifest.json](bench/manifest.json), [samples.json](bench/samples.json), [measure](bench-measure.log), [exact-source verify](bench-verify.log) |
| `bench:v4:enforce` | expected nonzero: 17 required targets failed or unmeasured | [bench-enforce.log](bench-enforce.log) |
| Verifier on retained benchmark artifacts | canonical arithmetic valid; release eligible **false** | [bench-retained-verify.log](bench-retained-verify.log) |

The bounded append-once sink process signs an exact committed result or terminal noncommit fence. The V3 broker retains and independently rechecks that receipt in a witnessed journal. A real controller SIGKILL after sink commit but before broker terminal publication reconciles the original effect through signed status without another sink decision. This is a broker-level, same-UID fixture; the adapter artifact digest is a test label, and the sink file store has no independently held monotonic head. No general external API transaction or ProcessHost/Deployment V3 admission is proved.

The unchanged release fixture still measures **1.861×** complete warm-message compression against the 4× target. Seventeen required targets fail or remain unmeasured. V4-T1-02, V4-T2-04, Q03 and NFR-16 remain open; the tracker stays 20/62.

SHA-256 retained artifact digests:

```text
fddb90bbfe89c6698960d4537e3431fc066e3929297c5fc902d71ea6512fe90a  bench-enforce.log
a3140f0f6fa598672ab832d0ad40619564127658c4fe8105ff5e325beba38fd4  bench-measure.log
7ac688f35acaa74ce03a207bd6ddc74564e3e495ee30e60e93222815c3c05cc9  bench-retained-verify.log
6f8348267aa66743ce4a49680c643c32e44ffee35596693fbf6f3cb3baebc31c  bench-verify.log
d8481defa1195fb4faac9f61aaaee9656e88e69f8b3a636b46470e5c85f9f70c  full-test.log
94196e972baa6f56bbf9c33bb5d11cb2bdbba77c9e1cba54413180d0ec122161  roadmap-v4.log
a24aba684dc7e3baac1ed86ac4d15756297bc0d7a093ca0af4a92eb8591339a  roadmap.log
411f4c736e4f97167acd0ca6677e8e48459b9afc79840825ef8ee5a185581f44  sink-focused.log
21d828da60cecb8e4fb3a7820562dfd40397af0d7a093ca0af4a92eb8591339a  typecheck.log
76b5f7c353ee098675ea58d4bd236a7f3957762d8c130413be88de2d9ceb5766  bench/manifest.json
e94e85e7009c4a31cf130f0e850a6012d7f0c5ecc398c1d4fe785c6b645657a1  bench/samples.json
```
