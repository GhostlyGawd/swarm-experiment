# Exact-source multi-shape SMT cutoff preflight

Preregistered on clean `b09657977c304a7eb4c68a5a94b81e092340feb7`,
specification 0.1.0. The [registration](raw/registration.json) pins the
unchanged six-case `/2` profile, Apple M4 Pro / Node v26.7.0 environment,
and the exact source/package files retained under [raw](raw/). One warmup
and five measured calls per case were made before any result was reviewed.
The [independent audit](verify.log) recomputes every saved sample, verdict and
summary; [hashes](hashes.sha256) and [hash verification](hash-check.log) bind
the copied artifacts.

| Declared case | Result | Maximum complete wall time |
| --- | --- | ---: |
| Boolean tautology | `unsat` | 72.553 ms |
| Valid linear arithmetic | `unsat` | 73.011 ms |
| Linear counterexample | `sat`, model checked | 71.896 ms |
| 4,096-term Boolean input | `unsat` | 81.277 ms |
| Actual Aether function contract | `proved` | 70.970 ms |
| Nine-into-eight pigeonhole | `unknown/timeout` | **1,483.031 ms** |

All **30/30** measured calls satisfy their declared outcome and the unchanged
**1,500 ms complete-call maximum**; overall p50 is **71.896 ms** and p95 is
**1,482.919 ms**. `unknown/timeout` is counted as a bounded cutoff result,
never as a proof. The outer timer includes query construction, validation,
child launch, cancellation, result decoding and parent checks. Raw
[results](raw/results.json), per-trial files and source snapshots are retained.

This is a bounded built-in process-isolated solver campaign on one machine.
It does not cover external solver fallback, every formula shape, arbitrary OS
scheduling delay or an admitted full proof pipeline. V4-NFR-08 remains
**unmeasured in the default release inventory** until a representative
target-specific release profile binds this evidence and its supported scope.
No tracker task status changes.
