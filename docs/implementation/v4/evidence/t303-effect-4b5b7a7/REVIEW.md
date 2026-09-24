# T3-03 signed effectful campaign on exact source `4b5b7a7`

`registration.json` was written before measurement on a clean worktree. It
retains the Ed25519 public trust key, independently signed exact execution and
effect-policy bytes, five generated cases, the fixed profile and transitive
source/package hashes. The private research key was not retained. Runtime was
Node v26.7.0 on an Apple M4 Pro; load and memory diagnostics are recorded.

| Measure | Actual |
| --- | ---: |
| Declared / generated / executed / filtered | 5 / 5 / 5 / 0 |
| Passed / failed | 5 / 0 |
| Durable broker effects / unknown outcomes | 5 / 0 |
| Coverage | 13 named labels, including Aether invoke, broker commit, allocation and release |
| Complete elapsed | 430.286667 ms |
| Complete rate | 11.6202 cases/s |
| Fixed R04 threshold | 2,000,000 boundary permutations/s |
| T3-03 G2 | **Failed** |

The timer includes constructor/subject checks, generated-case comparison, all
Aether calls and broker dispatches, durable case/report publication and local
admission. Registration and final measurement publication are excluded. The
saved [result](results.json) lists all seeds, coverage labels and raw case
locations. The exact-source verifier checks source/profile hashes, rederives
generated cases, audits every saved report/case/broker/sink artifact and reruns
the full campaign in a fresh directory. It verifies behavior and arithmetic,
not historical wall time.

This demonstrates bounded local admission of a signed effectful candidate, not
production deployment authority. The profile permits scalar/record boundaries,
zero external module dependencies and an executor-owned deterministic sink.
The signed module executes in the reference interpreter; its target artifact
digest is declared, not an independently measured runtime binary. Separate
tests show that changed signatures/subjects, unknown post-dispatch effects,
precondition filtering and tampered files fail admission. The effectful path
has not been integrated with live ProcessHost, an attested external sink,
general opaque values or the separate process/socket fault campaign. T3-03/G1
and G2 remain open for the full FR-3.3 scope.

```sh
node --experimental-strip-types roadmap/v4/research/microworld-effect/campaign.ts --verify docs/implementation/v4/evidence/t303-effect-4b5b7a7
node --experimental-strip-types --test test/tier3/living-effect-campaign.test.ts
```
