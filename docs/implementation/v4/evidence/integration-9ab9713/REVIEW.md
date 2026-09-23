# V8 operator witness catalog checkpoint

Exact tested source: `9ab97134218ab91765006624d5d9a6bb7c2a9cfe`, specification 0.1.0, clean `aether/v4-implementation` worktree. This is integration evidence for an **in-progress** T2-04 slice, not a G1/G2 pass manifest.

| Check | Result | Retained output |
| --- | --- | --- |
| `npm test` (includes build) | 850 tests, 849 pass, 0 fail, 1 existing opt-in skip | [full-test.log](full-test.log) |
| `npm run typecheck` | pass | [typecheck.log](typecheck.log) |
| `npm run roadmap:v4:check` | 62 tasks and 71 obligations valid; 20 tasks verified | [roadmap-v4.log](roadmap-v4.log) |
| `npm run roadmap:check` | pass | [roadmap.log](roadmap.log) |

The real-worker V8 test exercises an operator catalog bound into deployment `/8`, prepared `/6`, host configuration `/6` and promotion effect plan `/6`. It covers fresh guest calls, signed promotion, reopen, exact per-operation witness selection, factory-supplied catalog refusal, wrong witness and catalog, replaceable broker method refusal and V7 adoption refusal. The initial V8 attempt exposed a settled deployment receipt shortcut; the exact tested source checks the inner host and witnessed broker on initial response, retries, cached recovery and reopen.

The catalog and its witnesses in this test are in-memory and share the Node process with the factory. No OS-separated monotonic witness service, authenticated external sink status, hostile general adapter confinement or independently witnessed replay has been qualified. V1 histories and release targets remain open as documented. **T2-04, NFR-16 and the full v4 release remain unverified.**

SHA-256 log digests:

```text
7fac0dd75d15e6c7d251062e5b35ef13ff9ff2507e26c5dc4bc40f7e0b0f7141  full-test.log
94196e972baa6f56bbf9c33bb5d11cb2bdbba77c9e1cba54413180d0ec122161  roadmap-v4.log
a24aba684dc7e3baac1ed86ac4d15756297bc8b23864844a02f0548f3a892b61  roadmap.log
21d828da60cecb8e4fb3a7820562dfd40397af0d7a093ca0af4a92eb8591339a  typecheck.log
```
