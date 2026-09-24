# D21: Living-campaign throughput qualification boundary

**Status: decision required.** Recorded 2026-09-24 for V4-T3-03/G2 and
FR-3.3. This record does not amend the PRD, lower the 2,000,000/s threshold,
or close a task.

The PRD requires millions of adversarial boundary permutations per second and
100% survival before graduation. R04 froze **2,000,000 materialized and
evaluated four-field JSON inputs/s in each trial**; its profile explicitly
excludes Aether execution and durable observations. The T3-03 G2 tracker also
requires generated and executed counts, seeds, coverage and throughput to be
reported separately while meeting the source target. It has not resolved
whether the target applies to the four-field generator/evaluator alone or to
the complete signed candidate and fault campaign. Neither interpretation can
be silently substituted for the other.

The [clean pipeline audit](../evidence/t303-pipeline-faf2172/REVIEW.md) measures
the boundaries without changing them: five R04 kernel trials pass at
2.682–3.076M/s; rich signed-case generation is 95,389.5/s; actual candidate
attempts are 1.3735/s; the complete witnessed external campaign is 1.0741/s.
Its 15 cases all execute and pass with zero filters. The 100-sample serial
file-plus-directory fsync probe has a 2.792 ms minimum, while a 2M/s serial
case budget is 0.0005 ms. This makes the current single-worker/per-case fsync
profile unsuitable for the full rate on the measured machine. It is not a
universal physical ceiling for batching, sharding, parallel workers or other
hardware.

**Concrete specification decision needed:** the product/spec owner must state
which exact workload and accounting boundary the 2M/s gate qualifies:

1. If it covers **complete candidate execution**, keep that unchanged target
   and authorize an implementation profile with streamed/batched evidence,
   parallel Aether execution and independently sharded sink/witness custody.
   Require every generated case to execute and retain a verifiable 100% survival
   proof, and measure the full profile on named target hardware. Define which
   durability steps may be amortized without losing exact case/fault evidence.
2. If it covers **the frozen R04 generator/evaluator only**, version the
   acceptance contract to state a separate nonzero full-campaign throughput
   target and its exact signed execution, fault, durability and transport scope.
   This would be a substantive acceptance change requiring an explicit owner
   decision; the present implementation cannot make it unilaterally.

Until that decision and qualifying measurements exist, the passing R04 kernel
is a bounded research result, G2 remains failed, and T3-03 remains in progress.
