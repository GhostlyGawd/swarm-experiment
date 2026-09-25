# Witnessed external living campaign

The [V4 contract](../../../../docs/implementation/v4/LIVING-EFFECT-CAMPAIGN.md)
binds the existing signed Aether candidate to an attested append-only sink,
operator-selected public anchor, signed adapter artifact, sink-state witness
and per-case effect-journal witnesses. The sink, witness, transport gateway and
candidate are separate processes. The gateway drops one post-commit response,
stays absent for an unknown status check, then rejoins for signed recovery.

[Exact-source evidence](../../../../docs/implementation/v4/evidence/t303-external-f8ccbdf/REVIEW.md)
at clean `f8ccbdf` records 15/15 generated/executed/passed cases, zero filters,
17 attempts, nine independently witnessed append decisions, 48 coverage
labels and **1.1126 complete cases/s**. This is the signed campaign's reported
execution rate, not the fixed R04 2M/s generator/evaluator qualification rate.
The four-field JSON kernel pass measures that separate boundary. The test uses
one UID and a same-host socket partition; cross-host custody, production
deployment, actual memory pressure and native races remain open.

## Versioned boundary pipeline

The [V1 pipeline contract](../../../../docs/implementation/v4/LIVING-PIPELINE-V1.md)
now publishes the exact generated case set, every candidate attempt, both
recovery calls and immutable timing samples. [Clean-source pipeline evidence](../../../../docs/implementation/v4/evidence/t303-pipeline-faf2172/REVIEW.md)
at `faf2172` measures **95,389.5 rich cases/s generated**, **1.3735 actual
candidate attempts/s**, **1.1177 worker pipeline cases/s** and **1.0741
complete external cases/s**. All 15 generated cases execute and pass; the
failed partition attempt stays visible among 17 attempts. The unchanged R04
four-field JSON kernel separately passes at 2.682–3.076M/s. One hundred raw
serial file-plus-directory fsync samples show a 2.792 ms minimum. [D21](../../../../docs/implementation/v4/decisions/D21-living-campaign-throughput-boundary.md)
confirms that the five passing R04 trials qualify the fixed numerical rate
component. Candidate execution and full campaign throughput remain separately
reported; the whole task stays open for the missing fault and admission scope.

```sh
node --experimental-strip-types roadmap/v4/research/microworld-external/campaign.ts --verify docs/implementation/v4/evidence/t303-pipeline-faf2172
node --experimental-strip-types --test roadmap/v4/research/microworld-external/harness.test.ts
```
