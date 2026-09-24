# V12 projection and process-external V9 witness checkpoint

Exact tested source: `dc5de9de22af14c61b3d3fdcbae6f8472a26b08f`, specification 0.1.0. The worktree was clean during the full suite, focused campaigns and release benchmark measurement. Later evidence documentation is not part of that source commit.

| Check | Result | Retained output |
| --- | --- | --- |
| `npm test` (includes pretest build) | 911 tests, 910 pass, 0 fail, 1 existing opt-in skip | [full-test.log](full-test.log) |
| `npm run typecheck` | pass | [typecheck.log](typecheck.log) |
| `npm run roadmap:v4:check` | 62 tasks and 71 obligations valid; 20/62 tasks verified | [roadmap-v4.log](roadmap-v4.log) |
| `npm run roadmap:check` | pass | [roadmap.log](roadmap.log) |
| Executable projection suite | 92/92 pass, including V12 actual TS/Python/Rust | [projection.log](projection.log) |
| Separate witness service campaign | 2/2 pass: bounded authenticated CAS, service SIGKILL/restart, controlled close and large escaped frame | [witness-service.log](witness-service.log) |
| Native peer gateway campaign | 2/2 pass on Darwin arm64: actual signed CAS, UID/GID rejection and fault handling | [witness-peer.log](witness-peer.log) |
| Real V9 host/deployment/controller integration | 3/3 pass: in-memory V9, external service through native gateway, controller SIGKILL and exact recovery | [witness-integration.log](witness-integration.log) |
| `bench:v4:measure` and `bench:v4:verify --exact-source` | canonical raw samples and exact source verified; release eligible **false** | [manifest.json](bench/manifest.json), [samples.json](bench/samples.json), [measure](bench-measure.log), [exact-source verify](bench-verify.log) |
| `bench:v4:enforce` | expected nonzero: 17 required targets failed or unmeasured | [bench-enforce.log](bench-enforce.log) |
| Verifier on retained benchmark artifacts | canonical arithmetic valid; release eligible **false** | [bench-retained-verify.log](bench-retained-verify.log) |

The unchanged release fixture's complete warm-message ratio is **1.861×**, below its 4× gate. The controller crash test uses a read-only isolated Wasm guest, and all service/gateway/controller processes in these campaigns run under **one UID**. The native proxy checks kernel peer UID/GID and private upstream UID, but distinct-UID custody has not been tested. The service protects exact journal identities, CAS revisions and retained operation inventory; it does not prove every semantic transition or authenticate an irreversible external sink commit. V4-T1-02, V4-T2-04, Q03 and NFR-16 remain open, and the tracker stays 20/62.

SHA-256 retained artifact digests:

```text
1d0c3a14a01bbc3c7f933bc539d1535ededae9dc116348dd0927fbe5edfb94c6  bench-enforce.log
ad295dd6724e51c0b517b0522c45641b9ae349192e8a9b60b72f645b1ccf5dd7  bench-measure.log
ebc3c5329ae5a8540b6a631d2e4a22d4adbd3555e7ac76373641b7ca05bf92c2  bench-retained-verify.log
2715ecfa008d6007e8e4609f7c75dbd39150ba6bc0606a96e6b6f709d7ad0c54  bench-verify.log
bd2dceed8e2350d78b6041fe18397c8276c871ebcc7bfefe8855eae1719657c0  full-test.log
e521641595231c9cd0524b4e7c9d30f586dd4f765e5d718e2eade852a1e7dd12  projection.log
94196e972baa6f56bbf9c33bb5d11cb2bdbba77c9e1cba54413180d0ec122161  roadmap-v4.log
a24aba684dc7e3baac1ed86ac4d15756297bc0d7a093ca0af4a92eb8591339a  roadmap.log
21d828da60cecb8e4fb3a7820562dfd40397af0d7a093ca0af4a92eb8591339a  typecheck.log
6e40e5acd03a105eb22ebcef4d6be939d335ec1651290a22d116ae40097effc9  witness-integration.log
77f7a0545154101483577f1bc7439eff9b2912b48bce66ee35a7ad0bed652679  witness-peer.log
118e40187802cf0990c4e2a4cfd7ddc734989239a94ba27d0b601b8fd0f0790d  witness-service.log
2fd7039793f60f85a6b4730015ef380f837b5982af8bee29deefd1088f79346f  bench/manifest.json
61f89a2e110e3113f50a5c7a48f3b8c7223c43690d8e9f64e780b2cab0c8a2f7  bench/samples.json
```
