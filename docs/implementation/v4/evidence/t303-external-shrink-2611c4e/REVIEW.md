# T3-03 witnessed external-sink fault shrink and fresh-process replay

The preregistration was written on a clean worktree at
`2611c4e6db3655072009b59c0dfb59e9d14e5ff5` before the first observation.
It pins the unchanged R04 profile, an eight-proposal shrink limit, seed
`20260924-external-fault`, the original optional actions, Apple M4 Pro /
Node v26.7.0 diagnostics and **106 transitive source/dependency hashes**.
Every observation has its own independently signed sink authority and raw
broker, sink and witness files. The candidate AST root, exact execution
manifest digest and signed effect-policy **body** digest are identical across
all observations; test-only external sink keys and signatures differ. Private
research keys are not retained in Git.

| Observation | Optional actions before the mandatory sink fault | Generated / executed / filtered | Candidate attempts | Complete signed rate |
| --- | --- | ---: | ---: | ---: |
| Original | malformed command, truncated command, healthy case | 15 / 15 / 0 | 18 | **1.1292 cases/s** |
| Shrink proposal 1 | truncated command, healthy case | 15 / 15 / 0 | 18 | **1.0528 cases/s** |
| Shrink proposal 2 | healthy case | 15 / 15 / 0 | 18 | **1.1035 cases/s** |
| Shrunk witness | none | 15 / 15 / 0 | 17 | **1.1008 cases/s** |
| Fresh shrunk replay | none | 15 / 15 / 0 | 17 | **1.0822 cases/s** |

Totals: **75 generated and executed cases, zero filtered, 88 actual candidate
attempts, five explicitly retained failed partition attempts, ten recovery
calls and 45 signed sink append decisions**. The three proposals all preserved
the exact failure property, so the bounded shrinker accepted three reductions
and did not exhaust its limit. The saved [counterexample](fault/counterexample.json)
links original and shrunk action schedules to their full raw observations.
This is a reduction of optional host actions around the externally witnessed
fault. The mandatory causal chain—sink commit, lost reply, unknown status
during gateway outage, signed rejoin and exact retry—remains and is not claimed
globally minimal.

For **every** observation, the first candidate process retains an
indeterminate broker record while the sink witness already holds one signed
commit. It then receives real `SIGKILL`; a fresh candidate process reopens the
same signed authorization, broker directory and external sink/witness heads.
While the gateway is absent, status remains unknown. After rejoin the original
Ed25519 receipt reconciles the exact request, the candidate passes all 15
generated cases, and duplicate delivery adds no sink decision. The two durable
pipeline phases retain the failed attempt and subsequent recovery separately.

The verifier checks all five saved registrations and signatures, pins the
common execution manifest and policy body, reopens each of the 75 case
observations, all broker/sink/witness and pre-heal files, and recomputes counts,
coverage and rates. It then runs the shrunk schedule again with fresh services
and keys. A focused test changes the pre-heal broker record and confirms the
audit rejects it. This fresh replay proves the same property and candidate
bytes; it does not claim byte-identical external key or receipt signatures.

The unchanged R04 four-field generator/evaluator separately passed five
20,000-input trials at **3.208–3.501 million/s**. Under accepted [D21](../../decisions/D21-living-campaign-throughput-boundary.md),
that passes the fixed rate component; none of the signed rates above is labeled
as generator throughput. The PRD provides no numerical signed-campaign rate
target. Full T3-03 still lacks cross-machine partition, distinct operator
custody, native races/actual memory pressure, and production ProcessHost proof
admission. This shrink scope covers the one preregistered same-host external
fault and does not complete G1 or the whole task. Tracker remains **20/62**.

```sh
node --experimental-strip-types roadmap/v4/research/microworld-external/fault-campaign.ts --verify docs/implementation/v4/evidence/t303-external-shrink-2611c4e
node --experimental-strip-types --test roadmap/v4/research/microworld-external/fault-shrink.test.ts
```
