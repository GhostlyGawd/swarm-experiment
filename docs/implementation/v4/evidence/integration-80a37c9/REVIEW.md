# V9 executable declaration checkpoint

Exact tested source: `80a37c950cc446e9dad5a376db8e03cbb2915768`, specification 0.1.0, clean `aether/v4-implementation` worktree for the full test run and actual-token report. This is **in-progress T1-02 evidence**, not a G1/G2 pass manifest or a 4× release claim.

| Check | Result | Retained output |
| --- | --- | --- |
| `npm test` (includes build) | 865 tests, 864 pass, 0 fail, 1 existing opt-in skip | [full-test.log](full-test.log) |
| Projection suite | 68/68 pass, including V9 TS/Python/Rust execution | Included in full log |
| `npm run typecheck` | pass | [typecheck.log](typecheck.log) |
| `npm run roadmap:v4:check` | 62 tasks, 71 obligations valid; 20 tasks verified | [roadmap-v4.log](roadmap-v4.log) |
| `npm run roadmap:check` | pass | [roadmap.log](roadmap.log) |
| Real BPE declaration corpus | Six local/imported cold bundles; independent source/message recount passed | [report](../../../../../roadmap/v4/research/projections/results/declarations-80a37c9/report.json), [messages](../../../../../roadmap/v4/research/projections/results/declarations-80a37c9/messages.json) |

V9 round-trips `body: null` with exact contract and address through executable TS, Python and Rust projections. A call raises `unsynthesized_body`; target-language code execution, parsing, visible-source tampering and runtime-byte tampering are tested. An imported unsynthesized declaration remains bound to its exact module address. A detached checkout of pre-V9 `a69ae6e` and source `80a37c9` emitted byte-identical V8 generic/nested-import source, runtime and dependency hashes for all three targets: [before](v8-before.json), [after](v8-after.json).

Actual cold JSON role/content framing, including the full target runtime, costs **38,461–44,980 cl100k** and **37,693–44,147 o200k** tokens across the six tiny declaration bundles. The retained report names every message and its source identity. This local corpus is not the representative Q03 comparison and does not qualify the unchanged ≥4× target. Free type variables without binders are explicitly rejected. Valid `old(…)` expressions around nested binders and full declared semantic coverage remain open. **T1-02 and Q03 stay unverified.**

SHA-256 retained artifact digests:

```text
dde7e97fcf28b8a4fad0bdc7a224f8d5b33c5d7f8c1de9267373bdf429672760  full-test.log
94196e972baa6f56bbf9c33bb5d11cb2bdbba77c9e1cba54413180d0ec122161  roadmap-v4.log
a24aba684dc7e3baac1ed86ac4d15756297bc8b23864844a02f0548f3a892b61  roadmap.log
21d828da60cecb8e4fb3a7820562dfd40397af0d7a093ca0af4a92eb8591339a  typecheck.log
ce2857376016ca7b343ae45a153315ec33de1c1cf9df13654dfd55abd0bb8b2c  v8-before.json
ce2857376016ca7b343ae45a153315ec33de1c1cf9df13654dfd55abd0bb8b2c  v8-after.json
6110c6d1d011767ca0194d65431f2e1c5d019f74369190b39d9145ce93867c93  report.json
4eeaaf649026716c80e81dc008b9e27fbbdd4a45981b5e78fa61c49c567d23a4  messages.json
```
