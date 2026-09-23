# Signed Wasm host-cache broker comparison checkpoint

Exact tested source: `de034070afeff7f279679c4a6dd90e2b5dbbf66f` on `aether/v4-implementation`, specification 0.1.0. The worktree was clean for the retained full run. This is integration evidence for an **in-progress** T2-04 slice, not a T2-04/G1 or G2 pass manifest.

| Check | Result | Retained output |
| --- | --- | --- |
| `npm test` (includes build) | 849 tests, 848 pass, 0 fail, 1 existing opt-in skip | [full-test.log](full-test.log) |
| `npm run typecheck` | pass | [typecheck.log](typecheck.log) |
| `npm run roadmap:v4:check` | 62 tasks, 71 obligations valid; 20 tasks verified | [roadmap-v4.log](roadmap-v4.log) |
| `npm run roadmap:check` | pass | [roadmap.log](roadmap.log) |

The broker's `inspectRecorded` reads an exact request/adapter outcome without dispatch, budget, authorization or reconciliation callbacks. Signed V4 Wasm ProcessHost compares terminal effects before serving cached results, dispositions, retries, replay and recovery, and during reopen preflight. The real-worker test uses V2 witness state: a recomputed local committed value is refused at those host boundaries; a deleted local journal is restored from the witness. An indeterminate host call cannot replay past a tampered committed effect. The focused V7 clock test still passes.

The witness in this test lives in the same Node process and is supplied by the test factory. It is **not** production custody. ProcessHost/deployment identities do not yet pin an operator witness, and a hostile factory could substitute a broker. V1 histories still use unkeyed local digests; isolated replay events and external sink status lack independent authentication. General adapters and all-path capability containment remain open. The task count and 17 open release benchmark targets are unchanged.

SHA-256 log digests:

```text
802d6bb9afaaed533a0d78f2cbf51b0cdc6f41402b9d784565fa2e8b1e2de226  full-test.log
94196e972baa6f56bbf9c33bb5d11cb2bdbba77c9e1cba54413180d0ec122161  roadmap-v4.log
a24aba684dc7e3baac1ed86ac4d15756297bc8b23864844a02f0548f3a892b61  roadmap.log
21d828da60cecb8e4fb3a7820562dfd40397af0d7a093ca0af4a92eb8591339a  typecheck.log
```
