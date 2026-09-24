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
labels and **1.1126 complete cases/s**. This fails the fixed R04 2M/s target.
The four-field JSON kernel pass measures a different boundary. The test uses
one UID and a same-host socket partition; cross-host custody, production
deployment, actual memory pressure and native races remain open.

```sh
node --experimental-strip-types roadmap/v4/research/microworld-external/campaign.ts --verify docs/implementation/v4/evidence/t303-external-f8ccbdf
node --experimental-strip-types --test roadmap/v4/research/microworld-external/harness.test.ts
```
