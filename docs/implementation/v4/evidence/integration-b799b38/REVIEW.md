# AE5 warm-reference integration checkpoint

Exact tested source: `b799b3884c3543bd12810084a59344aa72e3731c`, specification 0.1.0. The worktree was clean during measurement and the full source test run.

| Check | Result | Output |
| --- | --- | --- |
| `npm test` (includes build) | 878 tests, 877 pass, 0 fail, 1 existing opt-in skip | [full-test.log](full-test.log) |
| `npm run typecheck` | pass | [typecheck.log](typecheck.log) |
| `npm run roadmap:v4:check` | graph and tracker valid, 62 tasks and 71 obligations; task count remains 20/62 verified | [roadmap-v4.log](roadmap-v4.log) |
| `npm run roadmap:check` | pass | [roadmap.log](roadmap.log) |
| AE5 independent report verifier at exact clean source | pass, including source hashes and retained message recount | [report.json](../../../../../roadmap/v4/research/agent-ir5/results/warm-b799b38/report.json) |

AE5R is an opt-in exact-base reference for four unchanged declarations already paid in a cold module. Warm ledger ratios are 4.716× cl100k and 4.903× o200k. Cold ratios are 0.941× and 0.952×; complete changed-session ratios are 1.110× and 1.125×. This is partial research evidence only. V4-T1-02, FR-1.2 and Q03 are open; the 20/62 count does not change.

SHA-256 retained artifact digests:

```text
7e50edb36c538c5435b50925794c65f7e277167ef23aafbcf8f3fdef47e1434a  full-test.log
94196e972baa6f56bbf9c33bb5d11cb2bdbba77c9e1cba54413180d0ec122161  roadmap-v4.log
a24aba684dc7e3baac1ed86ac4d15756297bc0d7a093ca0af4a92eb8591339a  roadmap.log
21d828da60cecb8e4fb3a7820562dfd40397af0d7a093ca0af4a92eb8591339a  typecheck.log
27cf4b47410edb868ed1bec51abc6fae7a17fbfddceffbe61e89a53cb188f395  research messages.json
b235ed36c9e5b98e85393ca3c1213cabe010af5436439456aff3a4eed0edae50  research report.json
```
