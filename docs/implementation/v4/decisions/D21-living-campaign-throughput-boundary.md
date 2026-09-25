# D21: Living-campaign throughput qualification boundary

**Status: decided 2026-09-24.** The product owner delegated this interpretation
to implementation judgment. This decision confirms the existing V4-T3-03/G2
wording in specification 0.1.0: the 2,000,000/s threshold applies to the
preregistered R04 boundary generator/evaluator, not to complete signed Aether
candidate, sink and fault-campaign executions. The threshold, five-trial rule,
source requirements and task inventory do not change.

## Reason

The [v4 PRD](../../../PRD-v4.0.md) says the engine **synthesizes** millions of
boundary permutations per second. It separately requires a synthesized
implementation to survive 100% of the declared adversarial campaign before
quorum graduation. The [task contract](../TRACKER.md#v4-t3-03) already requires
generated and executed case counts, coverage, seeds and throughput to be
reported separately, and places the speed target under the profile fixed by
R04. That preregistered profile includes materialization, JSON encode/decode,
four guard evaluations and coverage accumulation. It explicitly excludes
Aether candidate execution, broker/sink calls and durable observations.

Applying 2M/s to a serial, separately fsynced signed fault campaign would
combine two different obligations and silently change the frozen measurement
boundary. The [pipeline audit](../evidence/t303-pipeline-faf2172/REVIEW.md)
shows why those boundaries must be named: R04 passes five trials at
**2.682–3.076M/s**, rich signed-case generation is **95,389.5/s**, actual
candidate attempts are **1.3735/s**, and the full witnessed external campaign
is **1.0741/s**. A 100-sample fsync probe is a diagnostic for the present
serial architecture, not a claim that parallel/batched designs cannot be faster.

## Acceptance consequence

- The fixed **R04 rate component of V4-T3-03/G2 passes** on the recorded
  exact-source, named-machine evidence. Its four-field kernel is a narrow
  quantitative benchmark. It does not establish the full feature's adversarial
  coverage, candidate correctness or production deployment.
- The signed campaign must still execute every declared case, retain failures,
  retries, shrink/replay and durable observations, report its own throughput,
  and demonstrate **100% survival with zero hidden exclusions** before any
  graduation. The current 15/15 bounded result cannot stand in for native
  races, actual memory pressure, cross-machine partitions, distinct custody,
  ProcessHost proof admission or external-sink shrink coverage. V4-T3-03/G1
  and the whole task remain open at **20/62**.
- The PRD supplies no numerical full-campaign execution-rate target. We will
  publish that rate separately and never label the R04 number as candidate
  executions/s. A future product requirement for a signed-campaign rate must
  name its workload, durability and hardware boundary, then be versioned and
  measured before it can be an acceptance gate.

Historical campaign records that compared complete-campaign rate with 2M/s
remain immutable evidence of their original interpretation. This decision
corrects current acceptance language without rewriting their raw samples.
