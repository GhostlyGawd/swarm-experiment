# Proof-bound process fallback V2 checkpoint

Exact tested source: `c7a9b0185027ee563ea3e14e7816f3b017cd5242`, specification 0.1.0, clean `aether/v4-implementation` worktree. This is integration evidence for **in-progress** T3-07, not a G1/G2 pass manifest.

| Check | Result | Retained output |
| --- | --- | --- |
| `npm test` (includes build) | 858 tests, 857 pass, 0 fail, 1 existing opt-in skip | [full-test.log](full-test.log) |
| `npm run typecheck` | pass | [typecheck.log](typecheck.log) |
| `npm run roadmap:v4:check` | 62 tasks, 71 obligations valid; 20 tasks verified | [roadmap-v4.log](roadmap-v4.log) |
| `npm run roadmap:check` | pass | [roadmap.log](roadmap.log) |

The opt-in process fallback V2 binds an independently checked pure scalar Tier 2 certificate into its durable profile and uses real ProcessHost workers. Under an explicit recovery option, the host checks the exact historical broker request and tagged arguments, releases only a confirmed dead writer ticket, reconciles an indeterminate effect, then replays without redispatch. The real SIGKILL cases distinguish a committed sink (Tier 1 result, one call), a trusted adapter's definitive noncommit (proved Tier 2, zero calls), and unknown post-sink status (blocked, one call). Revoked Tier 2 authority, edited proof and changed arguments fail closed. Historical V1 manual recovery remains unchanged.

The local adapter's `not_committed` answer is trusted fixture behavior, not an authenticated remote sink statement. Tier 2 proof covers the portable pure scalar fragment, not general records/effects/native execution. The process supervisor is not an active-frame native cascade and returns `productionAuthorized: false`. The preregistered native switch maximum remains an 83.333 ns miss against the unchanged 50 ns requirement. **T3-07 and full v4 remain open.**

SHA-256 log digests:

```text
3a1a4668436b18a9f5e7a9099a483681aa68702a9d3e1b7954ff3f66fd076e6e  full-test.log
94196e972baa6f56bbf9c33bb5d11cb2bdbba77c9e1cba54413180d0ec122161  roadmap-v4.log
a24aba684dc7e3baac1ed86ac4d15756297bc8b23864844a02f0548f3a892b61  roadmap.log
21d828da60cecb8e4fb3a7820562dfd40397af0d7a093ca0af4a92eb8591339a  typecheck.log
```
